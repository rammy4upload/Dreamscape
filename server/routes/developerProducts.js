import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { requireApiKey } from '../middleware/auth.js';
import { dataPath, loadServiceConfig } from '../config.js';

const router = Router();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MIN_REAL_PRODUCT_ID = 1000;
let syncInProgress = false;

// Intentional whitelist: only entries explicitly represented by productids.json and
// productDefinitions can be synced. The three Random-* sentinel keys are supported;
// roulette, lottery, and paid-spin entries remain excluded from this route.
const SAFE_TOP_LEVEL_KEYS = new Set([
  'Starter','TenBP','FiftyBP','TwoHundredBP','TwoHundredAndFiftyBP','FiveHundredBP',
  'OneThousandBP','TwoThousandBP','UMV1','UMV3','UMV6','_10kP','_50kP','_100kP','_200kP',
  'AshGreninja','DracoElectivire','LugiaShadow','HoohDarkice','LucarioThief','Hoverboard',
  'MasterBall','MewtwoniteShadowX','MewtwoniteShadowY','TixPurchase','ShadowMewtwo',
  'Random-Shiny','Random-6x31','Random-Shiny-6x31','Cinderace-Pirate','Xerneas-Galaxy','Shadow-Lugia','Mewtwo-Shadow','Lunala-H','Shinifier',
  'SilverBottleCap','GoldBottleCap','Necrozma-Dialga','Necrozma-Yveltal','Necrozma-Zekrom',
  'Necrozma-Palkia','Necrozma-Groudon','Necrozma-Kyogre','Necrozma-Zygarde','Necrozma-Rayquaza',
  'Necrozma-HoOh','Necrozma-Giratina','Necrozma-Xerneas','Necrozma-Reshiram','Necrozma-Lugia','Ho-Oh-Dark',
]);

function isSafePath(key) {
  if (SAFE_TOP_LEVEL_KEYS.has(key)) return true;
  const ro = /^RoPowers\.(\d+)\.(\d+)$/.exec(key);
  if (ro) {
    const group = Number(ro[1]);
    const tier = Number(ro[2]);
    const maxTier = ({ 1: 2, 2: 2, 3: 2, 4: 2, 5: 1, 7: 1 })[group];
    return Boolean(maxTier && tier >= 1 && tier <= maxTier);
  }
  return /^QuestRerolls\.(x1|x3|x10)$/.test(key);
}

function flattenLeaves(value, parts = [], result = []) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    result.push({ path: parts.join('.'), placeholderId: value });
  } else if (Array.isArray(value)) {
    value.forEach((child, index) => flattenLeaves(child, [...parts, String(index + 1)], result));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      flattenLeaves(child, [...parts, key], result);
    }
  }
  return result;
}

function replaceTree(value, parts, idsByPath) {
  if (typeof value === 'number') {
    const key = parts.join('.');
    const productId = idsByPath.get(key);
    if (!productId) return undefined;
    return productId;
  }
  if (Array.isArray(value)) {
    return value.map((child, index) => {
      const mapped = replaceTree(child, [...parts, String(index + 1)], idsByPath);
      if (mapped === undefined) throw new Error(`No real ID resolved for required array entry ${[...parts, String(index + 1)].join('.')}`);
      return mapped;
    });
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      const mapped = replaceTree(child, [...parts, key], idsByPath);
      if (mapped !== undefined) out[key] = mapped;
    }
    return out;
  }
  return value;
}

function getGitSettings() {
  const config = loadServiceConfig() || {};
  const git = config.placeIds?.git || {};
  const owner = String(git.githubOwner || '').trim();
  const repo = String(git.githubRepo || '').trim();
  const branch = String(git.githubBranch || 'main').trim();
  const placePath = String(git.githubFilePath || 'placeids.json').trim();
  const defaultProductPath = path.posix.join(path.posix.dirname(placePath) === '.' ? '' : path.posix.dirname(placePath), 'productids.json');
  const productPath = String(process.env.PRODUCTIDS_GITHUB_FILE_PATH || defaultProductPath).replace(/^\.\//, '');
  const token = process.env.PLACEIDS_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '';
  if (!owner || !repo) throw new Error('Configure placeIds.git.githubOwner and githubRepo in AutoReuploader config.');
  if (!token) throw new Error('Set PLACEIDS_GITHUB_TOKEN (or GITHUB_TOKEN) in Railway.');
  return { owner, repo, branch, productPath, token };
}

async function fetchGitHubTemplate(git) {
  const escaped = git.productPath.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const url = `https://api.github.com/repos/${git.owner}/${git.repo}/contents/${escaped}?ref=${encodeURIComponent(git.branch)}`;
  const response = await fetch(url, { headers: {
    Authorization: `Bearer ${git.token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'PBB-AutoReuploader-DeveloperProductSync',
  }});
  if (!response.ok) throw new Error(`GitHub read failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
  const file = await response.json();
  if (!file.content || !file.sha) throw new Error('GitHub productids.json is missing content or SHA.');
  return { data: JSON.parse(Buffer.from(file.content.replace(/\n/g, ''), 'base64').toString('utf8')), sha: file.sha };
}

async function publishGitHubJson(git, sha, data) {
  const escaped = git.productPath.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const url = `https://api.github.com/repos/${git.owner}/${git.repo}/contents/${escaped}`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${git.token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'PBB-AutoReuploader-DeveloperProductSync',
    },
    body: JSON.stringify({
      message: 'Sync Roblox Developer Product IDs',
      content: Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8').toString('base64'),
      branch: git.branch,
      sha,
    }),
  });
  if (!response.ok) throw new Error(`GitHub publish failed (${response.status}): ${(await response.text()).slice(0, 700)}`);
  return response.json();
}

async function robloxRequest(url, options, { write = false } = {}) {
  const apiKey = process.env.ROBLOX_OPEN_CLOUD_API_KEY || process.env.ROBLOX_API_KEY;
  if (!apiKey) throw new Error('Set ROBLOX_OPEN_CLOUD_API_KEY in Railway with developer-product:read and developer-product:write scopes.');
  let lastError;
  for (let attempt = 1; attempt <= 6; attempt++) {
    if (write) await delay(425); // Stay below the documented 3 write requests/second limit.
    const response = await fetch(url, { ...options, headers: { 'x-api-key': apiKey, ...(options.headers || {}) } });
    if (response.ok) return response;
    const body = await response.text();
    if ((response.status === 429 || response.status >= 500) && attempt < 6) {
      const retryAfter = Number(response.headers.get('retry-after'));
      await delay(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : attempt * 1200);
      lastError = new Error(`Roblox API ${response.status}: ${body.slice(0, 500)}`);
      continue;
    }
    throw new Error(`Roblox API ${response.status}: ${body.slice(0, 700)}`);
  }
  throw lastError || new Error('Roblox API request failed after retries.');
}

async function listRobloxProducts(universeId) {
  const products = [];
  let pageToken = '';
  for (let page = 0; page < 100; page++) {
    const query = new URLSearchParams({ pageSize: '100' });
    if (pageToken) query.set('pageToken', pageToken);
    const url = `https://apis.roblox.com/developer-products/v2/universes/${universeId}/developer-products/creator?${query}`;
    const response = await robloxRequest(url, { method: 'GET' });
    const data = await response.json();
    products.push(...(Array.isArray(data.developerProducts) ? data.developerProducts : []));
    pageToken = data.nextPageToken || '';
    if (!pageToken) return products;
  }
  throw new Error('Roblox product listing exceeded 100 pages; refusing partial sync.');
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

async function writeProduct(universeId, definition, existingProduct) {
  const form = new FormData();
  if (definition.name) form.set('name', String(definition.name).slice(0, 50));
  if (definition.description) form.set('description', String(definition.description).slice(0, 1000));
  const price = Number(definition.priceRobux);
  const hasPrice = Number.isInteger(price) && price > 0;
  form.set('isForSale', hasPrice ? 'true' : 'false');
  if (hasPrice) form.set('price', String(price));

  let url;
  let method;
  if (existingProduct) {
    url = `https://apis.roblox.com/developer-products/v2/universes/${universeId}/developer-products/${existingProduct.productId}`;
    method = 'PATCH';
    // Don't change the name of a legacy product; update only configured price/sale state.
    const update = new FormData();
    if (hasPrice) {
      update.set('price', String(price));
      update.set('isForSale', 'true');
    }
    if (!hasPrice) return existingProduct.productId;
    const response = await robloxRequest(url, { method, body: update }, { write: true });
    const updated = await response.json();
    return Number(updated.productId || existingProduct.productId);
  }

  // Create unpriced products as not-for-sale so their real IDs can still be mapped.
  // A later sync turns them on sale after priceRobux is filled in productDefinitions.
  url = `https://apis.roblox.com/developer-products/v2/universes/${universeId}/developer-products`;
  method = 'POST';
  const response = await robloxRequest(url, { method, body: form }, { write: true });
  const created = await response.json();
  const id = Number(created.productId);
  if (!Number.isSafeInteger(id) || id < MIN_REAL_PRODUCT_ID) {
    throw new Error(`Roblox created a product but did not return a valid productId: ${JSON.stringify(created).slice(0, 400)}`);
  }
  return id;
}

async function syncProductIds() {
  const git = getGitSettings();
  const { data: template, sha } = await fetchGitHubTemplate(git);
  const config = loadServiceConfig() || {};
  // A template's universeId is only a placeholder. Prefer explicit Railway config;
  // never silently create dozens of products in a hardcoded old universe.
  const configuredUniverse =
    process.env.ROBLOX_UNIVERSE_ID ||
    config.accountPool?.primary?.experienceId ||
    config.experienceId ||
    config.creatorAccount?.experienceId ||
    (!template._template ? template.universeId : 0);
  const envUniverseId = Number(configuredUniverse);
  if (!Number.isSafeInteger(envUniverseId) || envUniverseId <= 0 || envUniverseId === 1234567890) {
    throw new Error('No valid target universe ID. Set ROBLOX_UNIVERSE_ID to the real universe ID or replace example experienceId 1234567890 in config.json. Do not use a place ID here.');
  }
  if (!template.productids || typeof template.productids !== 'object' || !template.productDefinitions || typeof template.productDefinitions !== 'object') {
    throw new Error('productids.json must contain productids and productDefinitions. Upload the supplied template first.');
  }

  const leaves = flattenLeaves(template.productids);
  if (!leaves.length) throw new Error('productids.json contains no product placeholder IDs.');
  for (const leaf of leaves) {
    if (!isSafePath(leaf.path)) throw new Error(`Product key is not enabled by this sync route: ${leaf.path}`);
    if (!template.productDefinitions[leaf.path]) throw new Error(`Missing productDefinitions entry for ${leaf.path}`);
  }
  for (const key of Object.keys(template.productDefinitions)) {
    if (!isSafePath(key)) throw new Error(`Unsupported productDefinitions key: ${key}`);
  }

  const existing = await listRobloxProducts(envUniverseId);
  const byId = new Map(existing.map((p) => [Number(p.productId), p]));
  const byName = new Map(existing.map((p) => [normalizeName(p.name), p]));
  const idsByPath = new Map();
  const created = [];
  const reused = [];
  const skipped = [];
  const warnings = [];

  for (const leaf of leaves) {
    const definition = template.productDefinitions[leaf.path];
    const legacyId = Number(definition.legacyId);
    let current = Number.isSafeInteger(legacyId) && legacyId > 0 ? byId.get(legacyId) : null;
    const managedName = `PBB Auto - ${String(definition.name || leaf.path).slice(0, 38)}`.slice(0, 50);

    if (!current) current = byName.get(normalizeName(definition.name)) || null;
    if (!current) current = byName.get(normalizeName(managedName)) || null;

    if (current) {
      const isLegacy = Number.isSafeInteger(legacyId) && Number(current.productId) === legacyId;
      let resolvedId;
      if (isLegacy) {
        resolvedId = await writeProduct(envUniverseId, definition, current);
        reused.push({ key: leaf.path, productId: resolvedId, source: 'legacy' });
      } else {
        resolvedId = await writeProduct(envUniverseId, { ...definition, name: managedName }, current);
        reused.push({ key: leaf.path, productId: resolvedId, source: 'synced-name' });
      }
      if (resolvedId) idsByPath.set(leaf.path, resolvedId);
      continue;
    }

    const createDefinition = { ...definition, name: managedName };
    const resolvedId = await writeProduct(envUniverseId, createDefinition, null);
    if (resolvedId) {
      idsByPath.set(leaf.path, resolvedId);
      created.push({ key: leaf.path, productId: resolvedId, priceRobux: definition.priceRobux });
    } else {
      // This should not happen for an API-accepted create request, but fail loudly if it does.
      skipped.push({ key: leaf.path, reason: 'Roblox did not return a usable product ID.' });
      warnings.push(`${leaf.path}: Roblox did not return a usable product ID; sync needs attention.`);
    }
  }

  const mappedProductIds = replaceTree(template.productids, [], idsByPath);
  const output = { ...template, universeId: envUniverseId, productids: mappedProductIds };
  delete output._template;
  delete output._notice;
  output.lastSyncedAt = new Date().toISOString();
  output.syncSummary = { created: created.length, reused: reused.length, skipped: skipped.length };

  const resolvedLeaves = flattenLeaves(mappedProductIds);
  if (!resolvedLeaves.length || resolvedLeaves.some((leaf) => !Number.isSafeInteger(Number(leaf.placeholderId)) || Number(leaf.placeholderId) < MIN_REAL_PRODUCT_ID)) {
    throw new Error('Sync produced missing/placeholder IDs; refusing to publish productids.json.');
  }

  const json = `${JSON.stringify(output, null, 2)}\n`;
  fs.mkdirSync(path.dirname(dataPath('productids.json')), { recursive: true });
  fs.writeFileSync(dataPath('productids.json'), json, 'utf8');
  await publishGitHubJson(git, sha, output);

  return { ok: true, universeId: envUniverseId, productCount: idsByPath.size, created, reused, skipped, warnings, github: `${git.owner}/${git.repo}@${git.branch}:${git.productPath}` };
}

router.get('/ids', async (req, res) => {
  try {
    const config = loadServiceConfig() || {};
    const configuredUniverse = process.env.ROBLOX_UNIVERSE_ID ||
      config.accountPool?.primary?.experienceId || config.experienceId || config.creatorAccount?.experienceId || 0;
    const requestedUniverse = Number(req.query.universeId || configuredUniverse);
    if (!Number.isSafeInteger(requestedUniverse) || requestedUniverse <= 0) {
      return res.status(400).json({ error: 'Set a valid ROBLOX_UNIVERSE_ID (universe ID, not place ID) before requesting product IDs.' });
    }
    let data = null;
    const localFile = dataPath('productids.json');
    if (fs.existsSync(localFile)) {
      try { data = JSON.parse(fs.readFileSync(localFile, 'utf8')); } catch { data = null; }
    }
    if (!data || data._template || Number(data.universeId) !== requestedUniverse || !data.productids) {
      const git = getGitSettings();
      const rawPath = git.productPath.split('/').map(encodeURIComponent).join('/');
      const rawUrl = `https://raw.githubusercontent.com/${encodeURIComponent(git.owner)}/${encodeURIComponent(git.repo)}/${encodeURIComponent(git.branch)}/${rawPath}`;
      const response = await fetch(rawUrl, { headers: { Accept: 'application/json' } });
      if (!response.ok) return res.status(404).json({ error: 'No synced productids.json is published yet.' });
      data = await response.json();
    }
    if (!data || data._template || Number(data.universeId) !== requestedUniverse || !data.productids) {
      return res.status(503).json({ error: 'Product IDs have not been synced for this universe.' });
    }
    return res.json({ universeId: requestedUniverse, productId: data.productids });
  } catch (error) {
    return res.status(500).json({ error: error.message || String(error) });
  }
});

router.post('/sync', requireApiKey, async (req, res) => {
  if (syncInProgress) return res.status(409).json({ error: 'A product sync is already in progress.' });
  syncInProgress = true;
  try {
    const result = await syncProductIds();
    return res.json(result);
  } catch (error) {
    console.error('[DeveloperProductSync] Failed:', error);
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  } finally {
    syncInProgress = false;
  }
});

export default router;

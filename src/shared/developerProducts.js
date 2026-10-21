import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { RobloxOpenCloudClient } from './robloxClient.js';
import { exportJsonFile } from './placeIdsExport.js';
import { safeErrorMessage } from './structuredLogger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CATALOG_PATH = path.resolve(__dirname, '../../assets/developerProducts.catalog.json');
const API_BASE = 'https://apis.roblox.com/developer-products/v2/universes';

const PATH_RE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

// Keep auto-creation limited to deterministic, fixed-reward purchases. These keys
// are deliberately not created by the sync system.
const BLOCKED_AUTOCREATE_PATHS = new Set([
  'PBSpins1', 'PBSpins5', 'PBSpins10', 'PBSpins99', 'LottoTicket',
  'RouletteSpinBasic', 'RouletteSpinBronze', 'RouletteSpinSilver', 'RouletteSpinGold', 'RouletteSpinDiamond',
  'BasicRoulette', 'BronzeRoulette', 'SilverRoulette', 'GoldRoulette',
  'DiamondRoulette', 'PlatinumRoulette', 'ShinyRoulette', 'SuperShinyRoulette',
  'Random-Shiny-6x31', 'Random-6x31', 'Random-Shiny',
]);
const MAX_NAME_LENGTH = 50;
const MAX_DESCRIPTION_LENGTH = 1000;
// Create endpoint is limited to 3 requests/second per key owner; stay safely under it.
const CREATE_SPACING_MS = 450;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ catalog */

export function loadCatalog(settings = {}, configPath = '') {
  if (Array.isArray(settings.catalog)) return settings.catalog;

  let file = DEFAULT_CATALOG_PATH;
  if (settings.catalogPath) {
    const raw = String(settings.catalogPath).trim();
    file = path.isAbsolute(raw)
      ? raw
      : path.resolve(configPath ? path.dirname(path.resolve(configPath)) : process.cwd(), raw);
  }
  if (!fs.existsSync(file)) throw new Error(`Developer product catalog not found: ${file}`);

  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const products = Array.isArray(parsed) ? parsed : parsed.products;
  if (!Array.isArray(products)) throw new Error(`Catalog ${file} must be an array or { "products": [...] }`);
  return products;
}

/** Validates entries and fills in prices. Returns { entries, defaultedPaths }. */
export function normalizeCatalog(rawEntries, { defaultPrice = 100 } = {}) {
  const fallback = Math.floor(Number(defaultPrice));
  if (!Number.isFinite(fallback) || fallback < 1) throw new Error('developerProducts.defaultPrice must be an integer >= 1');

  const seenPaths = new Set();
  const seenNames = new Set();
  const defaultedPaths = [];
  const entries = rawEntries.map((raw, index) => {
    const where = `catalog entry #${index + 1}`;
    const entryPath = String(raw?.path ?? '').trim();
    if (!PATH_RE.test(entryPath)) throw new Error(`${where}: invalid path "${entryPath}"`);
    if (BLOCKED_AUTOCREATE_PATHS.has(entryPath)) {
      throw new Error(`${where} (${entryPath}): excluded from automatic creation; only fixed-reward products are synced`);
    }
    if (seenPaths.has(entryPath)) throw new Error(`${where}: duplicate path "${entryPath}"`);
    seenPaths.add(entryPath);

    const name = String(raw?.name ?? entryPath).trim().slice(0, MAX_NAME_LENGTH);
    if (!name) throw new Error(`${where}: empty name`);
    // Existing products are matched by name, so names must be unique.
    if (seenNames.has(name.toLowerCase())) throw new Error(`${where}: duplicate product name "${name}"`);
    seenNames.add(name.toLowerCase());

    let price = raw?.price;
    if (price === undefined || price === null || price === '') {
      price = fallback;
      defaultedPaths.push(entryPath);
    } else {
      price = Math.floor(Number(price));
      if (!Number.isFinite(price) || price < 1) throw new Error(`${where} (${entryPath}): price must be an integer >= 1`);
    }

    const description = String(raw?.description ?? `${name} - ${price} R$`).slice(0, MAX_DESCRIPTION_LENGTH);
    return { path: entryPath, name, price, description };
  });
  return { entries, defaultedPaths };
}

/* ------------------------------------------------------------- id tree build */

function setByPath(root, dotted, value) {
  const parts = dotted.split('.');
  let node = root;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const last = i === parts.length - 1;
    const isIndex = /^\d+$/.test(part);
    // Numeric segments are 1-based so the catalog matches the Lua tables 1:1.
    const key = isIndex ? Number(part) - 1 : part;
    if (isIndex && (!Array.isArray(node) || key < 0)) throw new Error(`Bad numeric path segment in "${dotted}"`);
    if (last) {
      node[key] = value;
      return;
    }
    if (node[key] === undefined) node[key] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    node = node[key];
  }
}

function densify(node) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      if (node[i] === undefined || node[i] === null) node[i] = []; // e.g. RoPowers slot 6 = {}
      else densify(node[i]);
    }
  } else if (node && typeof node === 'object') {
    for (const value of Object.values(node)) densify(value);
  }
  return node;
}

/** { "Starter": 1, "RoPowers.1.2": 5 } -> { Starter: 1, RoPowers: [[?, 5]] } (Lua-shaped). */
export function buildIdTree(idsByPath) {
  const tree = {};
  for (const [dotted, id] of Object.entries(idsByPath)) setByPath(tree, dotted, id);
  return densify(tree);
}

export function buildProductIdsPayload(universeId, idsByPath) {
  return { universeId: Number(universeId), productids: buildIdTree(idsByPath) };
}

/* ---------------------------------------------------------------- Roblox API */

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Unexpected non-JSON response from Roblox: ${text.slice(0, 200)}`);
  }
}

export async function listDeveloperProducts(client, universeId) {
  const byName = new Map();
  let pageToken = '';
  for (let page = 0; page < 200; page += 1) {
    const query = new URLSearchParams({ pageSize: '50' });
    if (pageToken) query.set('pageToken', pageToken);
    const response = await client.request(`${API_BASE}/${universeId}/developer-products/creator?${query}`, {
      method: 'GET',
      operation: `list developer products ${universeId}`,
    });
    const data = await readJson(response);
    for (const product of data.developerProducts || []) {
      byName.set(String(product.name).trim().toLowerCase(), product);
    }
    pageToken = data.nextPageToken || '';
    if (!pageToken) break;
  }
  return byName;
}

async function createDeveloperProduct(client, universeId, entry) {
  const form = new FormData();
  form.append('name', entry.name);
  form.append('description', entry.description);
  form.append('isForSale', 'true');
  form.append('price', String(entry.price));
  const response = await client.request(`${API_BASE}/${universeId}/developer-products`, {
    method: 'POST',
    body: form,
    retries: 0, // a retried 5xx could create a duplicate; recovery below re-checks by name instead
    operation: `create developer product ${entry.path}`,
  });
  const data = await readJson(response);
  const productId = Number(data.productId);
  if (!Number.isSafeInteger(productId) || productId <= 0) {
    throw new Error(`Roblox returned no productId for "${entry.name}": ${JSON.stringify(data).slice(0, 200)}`);
  }
  return productId;
}

async function createWithRecovery(client, universeId, entry, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await createDeveloperProduct(client, universeId, entry);
    } catch (error) {
      lastError = error;
      const status = error?.status;
      // 400/401/403/404 will not get better by retrying.
      if (status && ![408, 429, 500, 502, 503, 504, 520, 522, 524].includes(status)) throw error;
      await sleep(Math.min(15_000, 1500 * attempt));
      // The request may have gone through before the failure; don't create a duplicate.
      const existing = (await listDeveloperProducts(client, universeId)).get(entry.name.toLowerCase());
      if (existing) return Number(existing.productId);
    }
  }
  throw lastError;
}

/* --------------------------------------------------------------------- sync */

/**
 * Creates every eligible fixed-reward catalog product that doesn't exist yet in `universeId`,
 * then publishes productids.json (same GitHub repo/route as placeids.json). Safe to re-run.
 */
export async function syncDeveloperProducts(config, universeId, { apiKey, configPath = '' } = {}) {
  const settings = config.developerProducts || {};
  if (settings.enabled === false) {
    console.log('[INFO] developerProducts.enabled is false; skipping developer product sync.');
    return null;
  }
  if (!universeId) throw new Error('Developer product sync needs a universe id.');
  if (!apiKey) {
    throw new Error(
      'No Open Cloud API key for developer products. Set developerProducts.apiKey (or accountPool.primary.apiKey) ' +
        'with the developer-product:read and developer-product:write scopes on this experience.'
    );
  }

  const { entries, defaultedPaths } = normalizeCatalog(loadCatalog(settings, configPath), {
    defaultPrice: settings.defaultPrice ?? 100,
  });
  if (defaultedPaths.length) {
    console.log(
      `[WARN] ${defaultedPaths.length} product(s) have no price in the catalog and will cost ${settings.defaultPrice ?? 100} R$: ` +
        `${defaultedPaths.join(', ')}. Edit the catalog (or the product in Creator Hub) to fix.`
    );
  }

  const client = new RobloxOpenCloudClient(apiKey, `Developer products ${universeId}`);
  console.log(`[INFO] Syncing ${entries.length} developer products to universe ${universeId}...`);

  let existing;
  try {
    existing = await listDeveloperProducts(client, universeId);
  } catch (error) {
    if (error?.status === 403 || error?.status === 401) {
      throw new Error(
        `Open Cloud key was rejected for developer products (HTTP ${error.status}). ` +
          'Add the developer-product:read + developer-product:write scopes to the key and make sure ' +
          `universe ${universeId} is in its experience list (and the IP allowlist allows this server).`,
        { cause: error }
      );
    }
    throw error;
  }

  const idsByPath = {};
  let created = 0;
  let reused = 0;
  for (const entry of entries) {
    const found = existing.get(entry.name.toLowerCase());
    if (found) {
      idsByPath[entry.path] = Number(found.productId);
      reused += 1;
      continue;
    }
    const productId = await createWithRecovery(client, universeId, entry);
    idsByPath[entry.path] = productId;
    existing.set(entry.name.toLowerCase(), { productId, name: entry.name });
    created += 1;
    console.log(`[SUCCESS] Created "${entry.name}" (${entry.price} R$) -> ${productId}  [${entry.path}]`);
    await sleep(CREATE_SPACING_MS);
  }

  // Roblox may answer 200 without applying the change when the key lacks the write scope,
  // so confirm every ID really exists before we publish anything.
  if (created > 0) {
    const verified = await listDeveloperProducts(client, universeId);
    const knownIds = new Set([...verified.values()].map((p) => Number(p.productId)));
    const missing = Object.entries(idsByPath).filter(([, id]) => !knownIds.has(id)).map(([p]) => p);
    if (missing.length) {
      throw new Error(
        `${missing.length} created product(s) are not visible in universe ${universeId} (${missing.slice(0, 5).join(', ')}...). ` +
          'The API key probably lacks the developer-product:write scope. Nothing was published.'
      );
    }
  }

  const payload = buildProductIdsPayload(universeId, idsByPath);
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  const exportResult = await exportJsonFile(
    json,
    {
      fileName: 'productids.json',
      outputPath: settings.outputPath,
      githubFilePath: settings.githubFilePath || 'productids.json',
      commitMessage: settings.commitMessage || 'Update developer product IDs',
      required: settings.required,
      label: 'productids.json',
    },
    config,
    { configPath }
  );

  console.log(`[SUCCESS] Developer products ready for universe ${universeId}: ${created} created, ${reused} reused.`);
  return { universeId, created, reused, defaultedPaths, productIds: payload.productids, export: exportResult };
}

/** Never throws unless developerProducts.required is true, so a product problem can't abort a reupload. */
export async function syncDeveloperProductsSafe(config, universeId, options) {
  try {
    return await syncDeveloperProducts(config, universeId, options);
  } catch (error) {
    if (config.developerProducts?.required === true) throw error;
    console.log(`[WARN] Developer product sync failed (reupload continues): ${safeErrorMessage(error)}`);
    return null;
  }
}

const PERMISSIONS_URL = 'https://apis.roblox.com/asset-permissions-api/v1/assets/permissions';
const ASSETS_LIST_URL = 'https://itemconfiguration.roblox.com/v1/creations/get-assets';
const BATCH_SIZE = 50;

function cleanIds(ids) { return [...new Set((ids || []).map(Number).filter(Number.isSafeInteger))]; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function permissionApiKey(account) {
  return String((account.isGroup ? account.groupApiKey : '') || account.apiKey || account.groupApiKey || '').trim();
}

async function listOwnedAssets(account, assetType) {
  if (!account?.cookie) throw new Error(`Missing cookie for ${account?.name || 'asset account'}; cannot auto-discover ${assetType} assets.`);
  const headers = { Cookie: `.ROBLOSECURITY=${account.cookie}`, Accept: 'application/json' };
  const ids = [];
  let cursor = null;
  do {
    const url = new URL(ASSETS_LIST_URL);
    url.searchParams.set('assetType', assetType);
    url.searchParams.set('limit', '100');
    if (account.isGroup && account.groupId) url.searchParams.set('groupId', String(account.groupId));
    if (cursor) url.searchParams.set('cursor', cursor);
    let response;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      response = await fetch(url, { headers });
      if (response.ok) break;
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(30000, 1000 * 2 ** attempt));
        continue;
      }
      const body = await response.text();
      throw new Error(`Asset listing failed (${response.status}): ${body.slice(0, 500)}`);
    }
    if (!response?.ok) throw new Error(`Asset listing failed after retries (${response?.status || 'no response'}).`);
    const data = await response.json();
    for (const item of data.data || []) {
      const id = Number(item.assetId ?? item.id);
      if (Number.isSafeInteger(id)) ids.push(id);
    }
    cursor = data.nextPageCursor || null;
  } while (cursor);
  return cleanIds(ids);
}

async function grantPermissions(experienceId, assetIds, apiKey, assetType, accountName) {
  const ids = cleanIds(assetIds);
  if (!ids.length) return { success: [], errors: [] };
  if (!apiKey) throw new Error(`Missing API key for ${accountName || 'asset account'}. The key needs asset-permissions:write.`);
  const allSuccess = [], allErrors = [];
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    let response = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const res = await fetch(PERMISSIONS_URL, {
        method: 'PATCH',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          subjectType: 'Universe', subjectId: String(experienceId), action: 'Use',
          requests: batch.map(assetId => ({ assetId, grantToDependencies: true }))
        })
      });
      const text = await res.text();
      let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
      if (res.ok) { response = body; break; }
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(60000, 1000 * 2 ** attempt));
        continue;
      }
      throw new Error(`Permission grant rejected for ${assetType} (${res.status}): ${text.slice(0, 1000)}`);
    }
    if (!response) throw new Error(`Permission grant failed after retries for ${assetType} batch starting at ${i + 1}.`);
    const success = cleanIds(response.successAssetIds || []);
    const errors = response.errors || [];
    allSuccess.push(...success); allErrors.push(...errors);
    console.log(`[PERMISSIONS] ${assetType}: ${Math.min(i + batch.length, ids.length)}/${ids.length} submitted; ${success.length} granted in this batch.`);
    for (const error of errors) console.error(`[PERMISSIONS] ${assetType} asset ${error.assetId}: ${error.code || 'UnknownError'}${error.message ? ` — ${error.message}` : ''}`);
  }
  return { success: cleanIds(allSuccess), errors: allErrors };
}

async function processAssetType(config, account, assetType, assetsArrayName) {
  const configured = cleanIds(account[assetsArrayName] || []);
  let discovered = [];
  if (account.autoDiscoverAssets !== false) {
    try {
      discovered = await listOwnedAssets(account, assetType);
      console.log(`[PERMISSIONS] Auto-discovered ${discovered.length} ${assetType} assets for ${account.name}.`);
    } catch (err) {
      if (configured.length) console.warn(`[PERMISSIONS] Auto-discovery failed for ${account.name} (${assetType}); using configured IDs: ${err.message}`);
      else throw err;
    }
  }
  const ids = cleanIds([...configured, ...discovered]);
  if (!ids.length) { console.log(`[PERMISSIONS] No ${assetType} assets found for ${account.name}.`); return { success: [], errors: [] }; }
  return grantPermissions(config.experienceId, ids, permissionApiKey(account), assetType, account.name);
}

export async function grantPermissionsForAccounts(config, accounts) {
  const experienceId = config.experienceId || config.creatorAccount?.experienceId;
  if (!experienceId) throw new Error('Missing experienceId for asset permission grants.');
  const grantConfig = { ...config, experienceId };
  const summary = { success: [], errors: [] };
  for (const account of accounts || []) {
    console.log(`\n=== Asset permissions: ${account.name} ===`);
    for (const [assetType, key] of [['Audio', 'audioAssets'], ['Animation', 'animationAssets']]) {
      const result = await processAssetType(grantConfig, account, assetType, key);
      summary.success.push(...result.success); summary.errors.push(...result.errors);
    }
  }
  if (summary.errors.length) throw new Error(`Asset permission grants completed with ${summary.errors.length} failed asset grant(s). Check the [PERMISSIONS] errors above.`);
  console.log(`[SUCCESS] Asset permissions complete: ${summary.success.length} asset grant(s) succeeded.`);
  return summary;
}

export async function grantAllPermissions(config) { return grantPermissionsForAccounts(config, config.assetAccounts || []); }

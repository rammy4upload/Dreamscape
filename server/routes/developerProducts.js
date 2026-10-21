import { Router } from 'express';
import { requireApiKey } from '../middleware/auth.js';
import { loadServiceConfig, serverConfig } from '../config.js';
import { syncDeveloperProducts } from '../../src/shared/developerProducts.js';

const router = Router();
router.use(requireApiKey);

let syncInFlight = null;

function usableSecret(value) {
  const candidate = String(value ?? '').trim();
  if (!candidate) return '';
  if (/^(?:OPTIONAL_|PASTE_|YOUR_|REPLACE_WITH|CHANGE_ME|EXAMPLE_|<)/i.test(candidate)) return '';
  return candidate;
}

function getUniverseId(config) {
  const primary = config?.accountPool?.primary;
  const candidate = primary?.experienceId ?? config?.experienceId ?? config?.creatorAccount?.experienceId;
  const id = Number(candidate);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function getDeveloperProductApiKey(config) {
  const primary = config?.accountPool?.primary || {};
  const creator = config?.creatorAccount || {};
  const candidates = [
    process.env.ROBLOX_DEVELOPER_PRODUCTS_API_KEY,
    config?.developerProducts?.apiKey,
    primary?.isGroup ? primary?.groupApiKey : '',
    primary?.apiKey,
    creator?.isGroup ? creator?.groupApiKey : '',
    creator?.apiKey,
  ];
  return candidates.map(usableSecret).find(Boolean) || '';
}

router.post('/sync', async (_req, res) => {
  if (syncInFlight) {
    return res.status(409).json({
      ok: false,
      error: 'A developer-product sync is already running. Do not start another sync concurrently.',
    });
  }

  syncInFlight = (async () => {
    const config = loadServiceConfig();
    if (!config) throw new Error(`Runtime config was not found at ${serverConfig.configPath}`);
    if (config.developerProducts?.enabled === false) {
      throw new Error('Developer product sync is disabled by developerProducts.enabled=false.');
    }

    const universeId = getUniverseId(config);
    if (!universeId) {
      throw new Error('No valid universe ID found. Set accountPool.primary.experienceId (or experienceId) in CONFIG_PATH.');
    }

    const apiKey = getDeveloperProductApiKey(config);
    if (!apiKey) {
      throw new Error(
        'Missing Roblox Open Cloud key. Set ROBLOX_DEVELOPER_PRODUCTS_API_KEY or developerProducts.apiKey ' +
        'with developer-product:read and developer-product:write access to the target universe.'
      );
    }

    const result = await syncDeveloperProducts(config, universeId, {
      apiKey,
      configPath: serverConfig.configPath,
    });
    return {
      ok: true,
      universeId,
      created: result?.created ?? 0,
      reused: result?.reused ?? 0,
      published: result?.export?.pushed === true,
      exportMethod: result?.export?.method || 'unknown',
      productIds: result?.productIds || {},
    };
  })();

  try {
    const result = await syncInFlight;
    return res.json(result);
  } catch (error) {
    const message = error?.message || String(error);
    const status = /missing|no valid universe|not found|disabled by developerProducts/i.test(message) ? 400 : 502;
    return res.status(status).json({ ok: false, error: message });
  } finally {
    syncInFlight = null;
  }
});

export default router;

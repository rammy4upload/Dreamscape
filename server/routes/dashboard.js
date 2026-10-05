import { Router } from 'express';
import { requireDashboardAuth } from '../middleware/auth.js';
import { getConfigFields, updateConfigFields, addBackupAccount, removeBackupAccount } from '../services/configStore.js';
import { getDeploymentStatus } from '../services/railwaySetup.js';
import {
  assetFilePath,
  getAssetMeta,
  getPersistedAssetsStatus,
  listAssets,
  saveAsset,
} from '../services/assetStore.js';
import { loadCodesData, saveCodesData, loadCodesLuaSource, saveCodesLuaSource, getCodesMeta, getCodesForDashboard, updateCodesFromDashboard, addCodeEntry, removeCodeEntry } from '../services/codesStore.js';
import { loadServiceConfig, serverConfig } from '../config.js';
import { getCatalog } from '../services/productResolver.js';
import { readPlaceIdsFile, pushExistingPlaceIds, writePlaceIdsFile } from '../../src/shared/placeIdsExport.js';
import {
  getIntegrationManifest,
  renderLuauTemplate,
  assertLuauFilename,
} from '../services/gameIntegration.js';
import { appendDashboardConsole, getDashboardConsoleText, getDeployId } from '../services/consoleLogStore.js';
import { getAuthEpoch, revokeAllDashboardSessions } from '../services/dashboardAuth.js';
import { disconnectAllClients, broadcast } from '../services/wsHub.js';
import { startTask, tasks, normalizeCommand } from './autoreuploader.js';

const router = Router();

router.get('/session', (req, res) => {
  const authEpoch = getAuthEpoch();
  if (!serverConfig.dashboardPassword) {
    return res.json({ required: false, authenticated: true, authEpoch });
  }

  const header = req.get('authorization') || '';
  const rawToken = header.startsWith('Bearer ') ? header.slice(7) : req.get('x-dashboard-token');
  const token = String(rawToken || '').trim();
  const passwordOk = token === serverConfig.dashboardPassword;
  const epochHeader = req.get('x-dashboard-auth-epoch');
  const epochOk =
    epochHeader === undefined ||
    epochHeader === '' ||
    Number(epochHeader) === authEpoch;

  return res.json({
    required: true,
    authenticated: passwordOk && epochOk,
    authEpoch,
  });
});

router.post('/revoke-sessions', requireDashboardAuth, (_req, res) => {
  const authEpoch = revokeAllDashboardSessions();
  broadcast({ type: 'auth-revoked', authEpoch });
  disconnectAllClients(4401, 'Session revoked');
  return res.json({ ok: true, authEpoch });
});

router.use(requireDashboardAuth);

export const DASHBOARD_COMMANDS = [
  { id: 'reupload', label: 'Reupload', description: 'Health check; rotate backup + normal upload on failure' },
  { id: 'fullupload', label: 'Full Upload', description: 'Friends, permissions, RBXL, media, place IDs' },
  { id: 'normalupload', label: 'Normal Upload', description: 'Publish without friend/permission automation' },
  { id: 'configureexperience', label: 'Configure Experience', description: 'Universe settings + icon/thumbnail only' },
  { id: 'pushplaceids', label: 'Push Place IDs', description: 'Git push placeids.json' },
  { id: 'rbxlupload', label: 'RBXL Upload', description: 'Open Cloud place publish only' },
  { id: 'addfriends', label: 'Add Friends', description: 'Friend automation + Studio shortcut' },
  { id: 'grantpermissions', label: 'Grant Permissions', description: 'Permissions slice without RBXL/media' },
  { id: 'service', label: 'Health Service', description: 'Long-running monitor loop' },
  { id: 'channelstatusservice', label: 'Channel Status', description: 'Discord player count / status only' },
  { id: 'add-backup-account', label: 'Add Backup Account', description: 'Interactive backup account setup' },
];

router.get('/commands', (_req, res) => {
  res.json({ commands: DASHBOARD_COMMANDS });
});

router.get('/console', (_req, res) => {
  res.json({
    text: getDashboardConsoleText(),
    deployId: getDeployId(),
  });
});

router.post('/run', (req, res) => {
  const { command = 'reupload', args = [] } = req.body || {};
  const normalized = normalizeCommand(command);
  appendDashboardConsole(
    `\n> ${command}${args.length ? ` ${args.join(' ')}` : ''}\n[dashboard] task ${normalized} queued\n`
  );
  const task = startTask(normalized, args);
  return res.status(201).json({
    id: task.id,
    command: normalized,
    friendly: command,
    status: task.status,
  });
});

router.get('/config', (_req, res) => {
  res.json(getConfigFields());
});

router.put('/config', (req, res) => {
  try {
    const updates = req.body?.fields || req.body || {};
    const result = updateConfigFields(updates);
    return res.json(result);
  } catch (error) {
    return res.status(400).json({ error: error.message || String(error) });
  }
});

router.post('/config/backups', (req, res) => {
  try {
    const template = req.body?.template === 'primary' ? 'primary' : 'blank';
    const result = addBackupAccount({ template });
    return res.status(201).json(result.config);
  } catch (error) {
    return res.status(400).json({ error: error.message || String(error) });
  }
});

router.delete('/config/backups/:index', (req, res) => {
  try {
    const result = removeBackupAccount(req.params.index);
    return res.json(result.config);
  } catch (error) {
    return res.status(400).json({ error: error.message || String(error) });
  }
});

router.get('/assets', (_req, res) => {
  res.json(getPersistedAssetsStatus());
});

router.get('/assets/:kind/meta', (req, res) => {
  try {
    return res.json(getAssetMeta(req.params.kind));
  } catch (error) {
    return res.status(400).json({ error: error.message || String(error) });
  }
});

router.get('/assets/:kind/download', (req, res) => {
  try {
    const meta = getAssetMeta(req.params.kind);
    if (!meta.exists) {
      return res.status(404).json({ error: 'Asset not found' });
    }
    res.type(meta.mime);
    return res.sendFile(meta.path);
  } catch (error) {
    return res.status(400).json({ error: error.message || String(error) });
  }
});

router.post('/assets/:kind', (req, res) => {
  try {
    let buffer = null;
    if (Buffer.isBuffer(req.body)) {
      buffer = req.body;
    } else if (req.body?.data) {
      buffer = Buffer.from(req.body.data, 'base64');
    }
    if (!buffer || !buffer.length) {
      return res.status(400).json({ error: 'Send raw file bytes or JSON { data: base64 }' });
    }
    const saved = saveAsset(req.params.kind, buffer);
    return res.json(saved);
  } catch (error) {
    return res.status(400).json({ error: error.message || String(error) });
  }
});

router.post('/codes/reformat', (_req, res) => {
  try {
    const data = loadCodesData();
    const saved = saveCodesData({ codes: data.codes });
    return res.json({
      meta: getCodesMeta(),
      codes: saved.codes,
      reformatted: true,
    });
  } catch (error) {
    return res.status(400).json({ error: error.message || String(error) });
  }
});

router.get('/codes', (_req, res) => {
  res.json(getCodesForDashboard());
});

router.put('/codes', (req, res) => {
  try {
    const codes = req.body?.codes;
    if (!Array.isArray(codes)) {
      return res.status(400).json({ error: 'Missing codes array' });
    }
    return res.json(updateCodesFromDashboard(codes));
  } catch (error) {
    return res.status(400).json({ error: error.message || String(error) });
  }
});

router.post('/codes', (_req, res) => {
  try {
    return res.status(201).json(addCodeEntry());
  } catch (error) {
    return res.status(400).json({ error: error.message || String(error) });
  }
});

router.delete('/codes/:index', (req, res) => {
  try {
    return res.json(removeCodeEntry(req.params.index));
  } catch (error) {
    return res.status(400).json({ error: error.message || String(error) });
  }
});

router.get('/products', (_req, res) => {
  try {
    return res.json({ products: getCatalog() });
  } catch (error) {
    return res.status(500).json({ error: error.message || String(error) });
  }
});

router.get('/placeids', (_req, res) => {
  const config = loadServiceConfig() || {};
  const file = readPlaceIdsFile(config, serverConfig.configPath);
  return res.json({
    path: file.path,
    exists: file.exists,
    data: file.data,
    error: file.error || null,
  });
});

router.put('/placeids', (req, res) => {
  try {
    const { Main, Battle, Trade } = req.body || {};
    const ids = {
      Main: String(Main || '').trim(),
      Battle: String(Battle || '').trim(),
      Trade: String(Trade || '').trim(),
    };
    for (const [name, value] of Object.entries(ids)) {
      if (!/^\d+$/.test(value)) {
        return res.status(400).json({ error: `${name} place ID must be numeric.` });
      }
    }

    const config = loadServiceConfig() || {};
    return res.json({ ok: true, ...writePlaceIdsFile(ids, config, { configPath: serverConfig.configPath }) });
  } catch (error) {
    return res.status(400).json({ error: error.message || String(error) });
  }
});

router.post('/placeids/push', async (_req, res) => {
  try {
    const config = loadServiceConfig() || {};
    const result = await pushExistingPlaceIds(config, { configPath: serverConfig.configPath });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(400).json({ error: error.message || String(error) });
  }
});

router.get('/integration/manifest', (_req, res) => {
  res.json(getIntegrationManifest(_req));
});

router.get('/integration/luau/:filename', (req, res) => {
  try {
    assertLuauFilename(req.params.filename);
    const includeSecrets = req.query.includeSecrets === '1';
    const source = renderLuauTemplate(req.params.filename, { includeApiKey: includeSecrets });
    res.type('text/plain; charset=utf-8').send(source);
  } catch (error) {
    return res.status(error.message.startsWith('Unknown') ? 404 : 400).json({
      error: error.message || String(error),
    });
  }
});

router.get('/status', (_req, res) => {
  res.json({
    tasks: tasks.size,
    configPath: getConfigFields().path,
    assets: listAssets(),
    deployment: getDeploymentStatus(),
  });
});

export default router;

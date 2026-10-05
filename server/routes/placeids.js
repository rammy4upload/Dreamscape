import { Router } from 'express';
import { requireApiKey } from '../middleware/auth.js';
import { loadServiceConfig, serverConfig } from '../config.js';
import {
  buildPlaceIdsPayload,
  readPlaceIdsFile,
  pushExistingPlaceIds,
} from '../../src/shared/placeIdsExport.js';

const router = Router();

router.use(requireApiKey);

router.get('/', (_req, res) => {
  const config = loadServiceConfig() || {};
  const file = readPlaceIdsFile(config, serverConfig.configPath);
  if (!file.exists || !file.data) {
    return res.status(404).json({ error: 'placeids.json not found', path: file.path });
  }
  return res.json(file.data);
});

router.get('/meta', (_req, res) => {
  const config = loadServiceConfig() || {};
  const file = readPlaceIdsFile(config, serverConfig.configPath);
  const git = config.placeIds?.git || {};
  return res.json({
    path: file.path,
    exists: file.exists,
    data: file.data,
    git: {
      enabled: Boolean(git.enabled),
      remoteRawUrl: git.remoteRawUrl || null,
      githubOwner: git.githubOwner || null,
      githubRepo: git.githubRepo || null,
      githubBranch: git.githubBranch || 'main',
      githubFilePath: git.githubFilePath || 'placeids.json',
    },
  });
});

router.post('/push', async (_req, res) => {
  try {
    const config = loadServiceConfig() || {};
    const result = await pushExistingPlaceIds(config, { configPath: serverConfig.configPath });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(400).json({ error: error.message || String(error) });
  }
});

router.post('/from-ids', (req, res) => {
  const { Main, Battle, Trade } = req.body || {};
  if (!Main || !Battle || !Trade) {
    return res.status(400).json({ error: 'Body must include Main, Battle, and Trade place ids.' });
  }
  return res.json(buildPlaceIdsPayload({ Main, Battle, Trade }));
});

export default router;

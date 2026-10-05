import { Router } from 'express';
import { requireCodesAuth } from '../middleware/auth.js';
import { getCodesMeta, loadCodesLuaSource, saveCodesLuaSource } from '../services/codesStore.js';

const router = Router();

/** Roblox game + PBB AutoReuploader fetch this to hot-reload promo codes. */
router.get('/list', requireCodesAuth, (_req, res) => {
  res.type('text/plain; charset=utf-8').send(loadCodesLuaSource());
});

/** Alias used by legacy VPS clients. */
router.get('/codeslist', requireCodesAuth, (_req, res) => {
  res.type('text/plain; charset=utf-8').send(loadCodesLuaSource());
});

router.get('/meta', requireCodesAuth, (_req, res) => {
  res.json(getCodesMeta());
});

router.put('/list', requireCodesAuth, (req, res) => {
  try {
    const source = typeof req.body === 'string' ? req.body : req.body?.source;
    if (!source) {
      return res.status(400).json({ error: 'Missing Lua source (raw body or { source })' });
    }
    const saved = saveCodesLuaSource(source);
    res.json({ ok: true, path: saved, meta: getCodesMeta() });
  } catch (error) {
    return res.status(400).json({ error: error.message || String(error) });
  }
});

export default router;

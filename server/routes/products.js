import { Router } from 'express';
import { requireApiKey } from '../middleware/auth.js';
import {
  getAssetMapping,
  getCatalog,
  resolveProductForUser,
} from '../services/productResolver.js';

const router = Router();

router.use(requireApiKey);

router.get('/catalog', (_req, res) => {
  res.json({ products: getCatalog() });
});

router.get('/mapping/:assetId', (req, res) => {
  const mapping = getAssetMapping(req.params.assetId);
  if (!mapping) {
    return res.status(404).json({ error: 'Unknown asset id' });
  }
  return res.json(mapping);
});

router.post('/resolve', async (req, res) => {
  try {
    const { userId, productKey, displayName, priceRobux, name, price } = req.body || {};
    const normalizedUserId = Number(userId);
    const normalizedProductKey = String(productKey || name || '').trim();
    const normalizedDisplayName = displayName == null ? undefined : String(displayName).trim();
    const rawPrice = priceRobux ?? price;
    const normalizedPrice = rawPrice === undefined || rawPrice === null || rawPrice === '' ? undefined : Number(rawPrice);

    if (!Number.isSafeInteger(normalizedUserId) || normalizedUserId <= 0) {
      return res.status(400).json({ error: 'userId must be a positive integer' });
    }
    if (!/^[A-Za-z0-9._:-]{1,80}$/.test(normalizedProductKey)) {
      return res.status(400).json({ error: 'productKey contains unsupported characters or is too long' });
    }
    if (normalizedDisplayName !== undefined && normalizedDisplayName.length > 80) {
      return res.status(400).json({ error: 'displayName is too long' });
    }
    if (normalizedPrice !== undefined && (!Number.isFinite(normalizedPrice) || normalizedPrice < 0 || normalizedPrice > 1_000_000)) {
      return res.status(400).json({ error: 'priceRobux must be between 0 and 1000000' });
    }

    const result = await resolveProductForUser({
      userId: normalizedUserId,
      productKey: normalizedProductKey,
      displayName: normalizedDisplayName,
      priceRobux: normalizedPrice,
    });
    return res.json(result);
  } catch (error) {
    const status = /missing Roblox cookie|required|invalid|unsafe/i.test(String(error?.message || '')) ? 400 : 502;
    return res.status(status).json({ error: error.message || String(error) });
  }
});

export default router;

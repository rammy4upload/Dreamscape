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
    const result = await resolveProductForUser({
      userId: Number(userId),
      productKey: productKey || name,
      displayName,
      priceRobux: priceRobux ?? price,
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message || String(error) });
  }
});

export default router;

import { Router } from 'express';
import {
  assertLuauFilename,
  getIntegrationManifest,
  renderLuauTemplate,
} from '../services/gameIntegration.js';

const router = Router();

router.get('/manifest', (req, res) => {
  res.json(getIntegrationManifest(req));
});

router.get('/luau/:filename', (req, res) => {
  try {
    assertLuauFilename(req.params.filename);
    const source = renderLuauTemplate(req.params.filename, { includeApiKey: false });
    res.type('text/plain; charset=utf-8').send(source);
  } catch (error) {
    return res.status(error.message.startsWith('Unknown') ? 404 : 400).json({
      error: error.message || String(error),
    });
  }
});

export default router;

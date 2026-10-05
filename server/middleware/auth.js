import { serverConfig } from '../config.js';
import { getAuthEpoch, isBrowserDashboardRequest, isDashboardSessionValid } from '../services/dashboardAuth.js';

function rejectMissingApiKey(res) {
  return res.status(503).json({ error: 'API_KEY is not configured on the server.' });
}

export function requireApiKey(req, res, next) {
  if (!serverConfig.apiKey) {
    if (process.env.NODE_ENV === 'production') {
      return rejectMissingApiKey(res);
    }
    return next();
  }

  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.get('x-api-key');
  if (token !== serverConfig.apiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

/** Accepts Bearer/x-api-key or ?key= for Roblox HttpService:GetAsync. */
export function requireCodesAuth(req, res, next) {
  const key = serverConfig.codesApiKey;
  if (!key) {
    if (process.env.NODE_ENV === 'production') {
      return rejectMissingApiKey(res);
    }
    return next();
  }

  const header = req.get('authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : req.get('x-api-key');
  const queryKey = req.query.key;
  if (bearer === key || queryKey === key) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

export function requireDashboardAuth(req, res, next) {
  if (!serverConfig.dashboardPassword) {
    return next();
  }

  const header = req.get('authorization') || '';
  const rawToken = header.startsWith('Bearer ') ? header.slice(7) : req.get('x-dashboard-token');
  const token = String(rawToken || '').trim();
  if (token !== serverConfig.dashboardPassword) {
    return res.status(401).json({ error: 'Dashboard authentication required' });
  }
  if (isBrowserDashboardRequest(req) && !isDashboardSessionValid(req)) {
    return res.status(401).json({ error: 'Dashboard session expired — sign in again' });
  }
  return next();
}

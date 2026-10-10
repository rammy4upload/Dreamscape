import fs from 'fs';
import { dataPath, ensureDataDir } from '../config.js';
import { atomicWriteJson } from '../../src/shared/atomicStore.js';

let authEpoch = 0;
let initialized = false;

function authMetaPath() {
  return dataPath('dashboard-auth.json');
}

function persistAuthEpoch() {
  ensureDataDir();
  atomicWriteJson(authMetaPath(), { authEpoch, updatedAt: new Date().toISOString() }, { backup: true });
}

export function initDashboardAuth() {
  if (initialized) {
    return authEpoch;
  }

  ensureDataDir();
  try {
    const meta = JSON.parse(fs.readFileSync(authMetaPath(), 'utf8'));
    authEpoch = Number(meta.authEpoch) || 0;
  } catch {
    authEpoch = 0;
    persistAuthEpoch();
  }

  initialized = true;
  return authEpoch;
}

export function getAuthEpoch() {
  if (!initialized) {
    initDashboardAuth();
  }
  return authEpoch;
}

export function revokeAllDashboardSessions() {
  if (!initialized) {
    initDashboardAuth();
  }
  authEpoch += 1;
  persistAuthEpoch();
  return authEpoch;
}

export function isBrowserDashboardRequest(req) {
  return req.get('x-dashboard-client') === '1';
}

export function isDashboardSessionValid(req) {
  const epochHeader = req.get('x-dashboard-auth-epoch');
  if (epochHeader === undefined || epochHeader === '') {
    return true;
  }
  const epoch = Number(epochHeader);
  if (!Number.isFinite(epoch)) {
    return false;
  }
  return epoch === getAuthEpoch();
}

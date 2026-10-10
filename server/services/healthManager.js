import { loadServiceConfig, serverConfig } from '../config.js';
import { requestWithRetry, requestJson } from '../../src/shared/httpClient.js';
import { log, safeErrorMessage } from '../../src/shared/structuredLogger.js';
import { listOperations, OPERATION_STATES } from '../../src/shared/operationStore.js';
import { gameNameLooksDeleted } from '../../src/shared/robloxVerification.js';

let snapshot = {
  health: 'DEGRADED',
  primary: 'UNKNOWN',
  discord: 'UNKNOWN',
  recoveryRequired: 0,
  lastCheckedAt: null,
  reason: 'startup',
};

function placeIdFromUrl(url) {
  const match = String(url || '').match(/\/games\/(\d{5,})/i);
  return match ? match[1] : null;
}


export async function checkRobloxBaseHealth() {
  try {
    const response = await requestWithRetry('https://www.roblox.com', { headers: { 'user-agent': 'Monster-AutoReuploader/1.0' } }, { operation: 'Roblox base health', retries: 2, timeoutMs: 15_000, baseMs: 1000, maxMs: 10_000 });
    const body = await response.text();
    return { available: response.ok && body.trim().length > 0 };
  } catch (error) {
    return { available: false, reason: safeErrorMessage(error) };
  }
}

export async function checkPrimaryHealth(config = loadServiceConfig() || {}) {
  const healthUrl = config?.monitor?.healthUrl;
  if (!healthUrl) return { state: 'DEGRADED', reason: 'monitor.healthUrl is not configured' };

  try {
    const response = await requestWithRetry(healthUrl, { headers: { 'user-agent': 'Monster-AutoReuploader/1.0' } }, { operation: 'Roblox game health page', retries: 2, timeoutMs: 15_000, baseMs: 1000, maxMs: 10_000 });
    const body = await response.text();
    if (!body.trim()) return { state: 'DOWN', reason: 'Roblox game page returned empty content' };
    const placeId = placeIdFromUrl(healthUrl);
    if (!placeId) return { state: response.ok ? 'HEALTHY' : 'DOWN', reason: response.ok ? 'health page available' : `HTTP ${response.status}` };

    const universe = await requestJson(`https://apis.roblox.com/universes/v1/places/${encodeURIComponent(placeId)}/universe`, {}, { operation: 'Roblox place universe lookup', retries: 2, timeoutMs: 15_000, baseMs: 1000, maxMs: 10_000 });
    const universeId = universe?.universeId;
    if (!universeId) return { state: 'DOWN', reason: 'Place has no universe mapping' };

    const configuredUniverse = config?.accountPool?.primary?.experienceId || config?.experienceId;
    if (configuredUniverse && Number(configuredUniverse) !== Number(universeId)) {
      return { state: 'DOWN', reason: `Monitored universe ${universeId} does not match configured ${configuredUniverse}` };
    }

    const listing = await requestJson(`https://games.roblox.com/v1/games?universeIds=${encodeURIComponent(universeId)}`, {}, { operation: 'Roblox game metadata health check', retries: 2, timeoutMs: 15_000, baseMs: 1000, maxMs: 10_000 });
    const game = listing?.data?.[0];
    if (!game) return { state: 'DOWN', reason: 'Universe is not listed' };
    if (gameNameLooksDeleted(game.name)) return { state: 'DOWN', reason: 'Roblox reports the experience as deleted/unavailable', universeId: String(universeId), placeId, name: String(game.name || '') };
    return { state: 'HEALTHY', reason: 'Roblox game and universe are available', universeId: String(universeId), placeId, name: String(game.name || '') };
  } catch (error) {
    const message = safeErrorMessage(error);
    log('WARN', 'Primary Roblox health check failed', { error: message });
    return { state: 'DOWN', reason: message };
  }
}

export async function refreshHealthSnapshot(overrides = {}) {
  const config = loadServiceConfig() || {};
  const primary = overrides.primary || await checkPrimaryHealth(config);
  const recovery = listOperations(serverConfig.dataDir, 100).filter((op) => op.currentState === OPERATION_STATES.RECOVERY_REQUIRED);
  let health = primary.state;
  if (primary.state === 'HEALTHY' && recovery.length) health = 'DEGRADED';
  if (primary.state === 'HEALTHY' && overrides.discord === 'DOWN') health = 'DEGRADED';
  snapshot = {
    health,
    primary: primary.state,
    discord: overrides.discord || snapshot.discord || 'UNKNOWN',
    recoveryRequired: recovery.length,
    lastCheckedAt: new Date().toISOString(),
    reason: primary.reason,
    ...primary,
  };
  return snapshot;
}

export function getHealthSnapshot() { return { ...snapshot }; }

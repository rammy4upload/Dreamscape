import { loadServiceConfig } from '../config.js';
import { requestJson } from '../../src/shared/httpClient.js';
import { updateStatisticChannel } from './discordStatusManager.js';
import { log, safeErrorMessage } from '../../src/shared/structuredLogger.js';

let timer = null;
let lastKnown = { favorites: null, visits: null, players: null, updatedAt: null };

export async function fetchGameStatistics(universeId) {
  const id = String(universeId || '').trim();
  if (!/^\d+$/.test(id)) throw new Error('Invalid universe ID');
  const detail = await requestJson(
    `https://games.roblox.com/v1/games?universeIds=${encodeURIComponent(id)}`,
    { headers: { 'user-agent': 'Monster-AutoReuploader/1.0' } },
    { operation: 'Roblox game statistics', retries: 4, timeoutMs: 15_000, baseMs: 1000, maxMs: 30_000 }
  );
  const row = detail?.data?.[0];
  if (!row) throw new Error('Roblox returned no game metadata');
  const favoritesPayload = await requestJson(
    `https://games.roblox.com/v1/games/${encodeURIComponent(id)}/favorites/count`,
    { headers: { 'user-agent': 'Monster-AutoReuploader/1.0' } },
    { operation: 'Roblox favorites count', retries: 4, timeoutMs: 15_000, baseMs: 1000, maxMs: 30_000 }
  );
  const favorites = Number(favoritesPayload?.favoritesCount ?? favoritesPayload?.count ?? row?.favorited ?? row?.favoriteCount);
  const visits = Number(row?.visits);
  const players = Number(row?.playing);
  if (![favorites, visits, players].every(Number.isFinite)) throw new Error('Roblox statistics response is missing expected numeric fields');
  return { favorites: Math.max(0, Math.floor(favorites)), visits: Math.max(0, Math.floor(visits)), players: Math.max(0, Math.floor(players)) };
}

export function getLastKnownStatistics() { return { ...lastKnown }; }

export async function pollStatistics() {
  const config = loadServiceConfig() || {};
  const universeId = config?.accountPool?.primary?.experienceId || config?.experienceId;
  if (!universeId) return lastKnown;
  try {
    const stats = await fetchGameStatistics(universeId);
    lastKnown = { ...stats, updatedAt: new Date().toISOString() };
    await Promise.allSettled([
      updateStatisticChannel(config, 'favorites', stats.favorites),
      updateStatisticChannel(config, 'visits', stats.visits),
      updateStatisticChannel(config, 'players', stats.players),
    ]);
    return lastKnown;
  } catch (error) {
    log('WARN', 'Statistics polling failed; preserving last known values', { error: safeErrorMessage(error) });
    return lastKnown;
  }
}

export function startStatisticsManager() {
  if (timer) return;
  const config = loadServiceConfig() || {};
  const intervalMs = Math.max(30_000, Number(config.monitor?.statisticsIntervalMs || process.env.STATISTICS_INTERVAL_MS || 60_000));
  pollStatistics().catch(() => {});
  timer = setInterval(() => pollStatistics().catch(() => {}), intervalMs);
  timer.unref?.();
}

export function stopStatisticsManager() {
  if (timer) clearInterval(timer);
  timer = null;
}

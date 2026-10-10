const DELETED_PATTERNS = [
  'content deleted',
  '[ content deleted ]',
  '[content deleted]',
  'content deleted',
];

export function gameNameLooksDeleted(name) {
  if (name == null) return true;
  const normalized = String(name).trim().toLowerCase();
  return DELETED_PATTERNS.some((pattern) => normalized.includes(pattern));
}

import { requestJson } from './httpClient.js';
import { safeErrorMessage } from './structuredLogger.js';

export async function verifyExperienceState({ universeId, mainPlaceId, expectedName = '' }) {
  if (!universeId && !mainPlaceId) return { verified: false, reason: 'No universe or place ID available for verification' };
  try {
    let resolvedUniverseId = universeId;
    if (!resolvedUniverseId && mainPlaceId) {
      const mapping = await requestJson(
        `https://apis.roblox.com/universes/v1/places/${encodeURIComponent(mainPlaceId)}/universe`,
        {},
        { operation: 'verify place universe', retries: 4, timeoutMs: 15_000 }
      );
      resolvedUniverseId = mapping?.universeId;
    }
    if (!resolvedUniverseId) return { verified: false, reason: 'Roblox did not return a universe ID' };

    const payload = await requestJson(
      `https://games.roblox.com/v1/games?universeIds=${encodeURIComponent(resolvedUniverseId)}`,
      {},
      { operation: 'verify universe listing', retries: 4, timeoutMs: 15_000 }
    );
    const game = payload?.data?.[0];
    if (!game) return { verified: false, reason: 'Universe is not listed by Roblox games API', universeId: resolvedUniverseId };
    if (gameNameLooksDeleted(game.name)) {
      return { verified: false, reason: 'Roblox reports the experience as deleted/unavailable', universeId: resolvedUniverseId, name: String(game.name || '') };
    }
    let nameMismatch = null;
    if (expectedName) {
      const expected = String(expectedName).trim().toLowerCase();
      const actual = String(game.name || '').trim().toLowerCase();
      if (!actual) return { verified: false, reason: 'Verified universe has no game name', universeId: resolvedUniverseId };
      if (expected !== actual) {
        nameMismatch = { expected: String(expectedName), actual: String(game.name || '') };
      }
    }
    return {
      verified: true,
      universeId: String(resolvedUniverseId),
      placeId: mainPlaceId ? String(mainPlaceId) : null,
      name: String(game.name || ''),
      ...(nameMismatch ? { nameMismatch } : {}),
      playing: Number(game.playing || 0),
      visits: Number(game.visits || 0),
      favorited: Number(game.favorited || game.favoriteCount || 0),
    };
  } catch (error) {
    return { verified: false, reason: safeErrorMessage(error) };
  }
}

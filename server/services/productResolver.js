import { resolveRobloxCredentials } from '../config.js';
import {
  getProductEntry,
  loadProductStore,
  registerShirt,
  saveProductStore,
  lookupProductKey,
  listCatalog,
} from './productStore.js';
import { renderTshirtImage } from './tshirtImage.js';
import {
  configureTshirtSale,
  createUploadClient,
  uploadTshirt,
  userOwnsAsset,
} from './tshirtUpload.js';

function uniqueShirtName(displayName, existingCount) {
  const suffix = existingCount > 0 ? ` #${existingCount + 1}` : '';
  return `${displayName}${suffix}`.slice(0, 50);
}

async function findAvailableShirt(client, entry, userId) {
  for (const shirt of entry.shirts) {
    const owned = await userOwnsAsset(client, userId, shirt.assetId);
    if (!owned) {
      return { shirt, created: false };
    }
  }
  return null;
}

async function createFreshShirt(client, credentials, productKey, entry) {
  const pngBuffer = await renderTshirtImage({
    displayName: entry.displayName,
    priceRobux: entry.priceRobux,
    productKey: normalizedProductKey,
  });

  const shirtName = uniqueShirtName(entry.displayName, entry.shirts.length);
  const description = `Monster Brick Bronze premium item: ${entry.displayName} (${productKey})`;
  const assetId = await uploadTshirt(client, {
    name: shirtName,
    description,
    pngBuffer,
    groupId: credentials.groupId || undefined,
  });

  await configureTshirtSale(client, assetId, entry.priceRobux);

  const shirt = {
    assetId,
    displayName: shirtName,
    priceRobux: entry.priceRobux,
    createdAt: new Date().toISOString(),
  };

  const store = loadProductStore();
  registerShirt(store, productKey, shirt);
  return { shirt, created: true };
}

export async function resolveProductForUser({ productKey, userId, displayName, priceRobux }) {
  const normalizedProductKey = String(productKey || '').trim();
  const normalizedUserId = Number(userId);
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(normalizedProductKey)) {
    throw new Error('Invalid productKey');
  }
  if (!Number.isSafeInteger(normalizedUserId) || normalizedUserId <= 0) {
    throw new Error('Invalid userId');
  }
  if (displayName != null && String(displayName).trim().length > 80) {
    throw new Error('displayName is too long');
  }
  if (priceRobux !== undefined && priceRobux !== null && priceRobux !== '') {
    const n = Number(priceRobux);
    if (!Number.isFinite(n) || n < 0 || n > 1_000_000) {
      throw new Error('Invalid priceRobux');
    }
  }

  const credentials = resolveRobloxCredentials();
  if (!credentials.cookie) {
    throw new Error(
      'Missing Roblox cookie. Set ROBLOX_COOKIE or config.json accountPool.primary.cookie'
    );
  }

  const store = loadProductStore();
  const entry = getProductEntry(store, normalizedProductKey);
  if (displayName) {
    entry.displayName = displayName;
  }
  if (priceRobux !== undefined && priceRobux !== null) {
    entry.priceRobux = Number(priceRobux);
  }
  store.products[normalizedProductKey] = entry;
  saveProductStore(store);

  const client = createUploadClient(credentials.cookie);
  const available = await findAvailableShirt(client, entry, normalizedUserId);
  if (available) {
    return {
      productKey: normalizedProductKey,
      assetId: available.shirt.assetId,
      assetType: 'TShirt',
      priceRobux: available.shirt.priceRobux,
      displayName: available.shirt.displayName,
      created: false,
      reused: true,
    };
  }

  const fresh = await createFreshShirt(client, credentials, productKey, entry);
  return {
    productKey: normalizedProductKey,
    assetId: fresh.shirt.assetId,
    assetType: 'TShirt',
    priceRobux: fresh.shirt.priceRobux,
    displayName: fresh.shirt.displayName,
    created: true,
    reused: false,
  };
}

export function getAssetMapping(assetId) {
  const store = loadProductStore();
  return lookupProductKey(store, assetId);
}

export function getCatalog() {
  const store = loadProductStore();
  return listCatalog(store);
}

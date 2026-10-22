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
    productKey,
  });

  const shirtName = uniqueShirtName(entry.displayName, entry.shirts.length);
  const description = `Pokemon Brick Bronze premium item: ${entry.displayName} (${productKey})`;
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
  if (!productKey || !userId) {
    throw new Error('productKey and userId are required');
  }

  const credentials = resolveRobloxCredentials();
  if (!credentials.cookie) {
    throw new Error(
      'Missing Roblox cookie. Set ROBLOX_COOKIE or config.json accountPool.primary.cookie'
    );
  }

  const store = loadProductStore();
  const entry = getProductEntry(store, productKey);
  if (displayName) {
    entry.displayName = displayName;
  }
  if (priceRobux !== undefined && priceRobux !== null) {
    entry.priceRobux = Number(priceRobux);
  }
  store.products[productKey] = entry;
  saveProductStore(store);

  const client = createUploadClient(credentials.cookie);
  const available = await findAvailableShirt(client, entry, userId);
  if (available) {
    return {
      productKey,
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
    productKey,
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

import fs from 'fs';
import { serverConfig, ensureDataDir } from '../config.js';
import { atomicWriteJson, readJsonWithBackup } from '../../src/shared/atomicStore.js';

function emptyStore() {
  return { products: {}, assetIndex: {} };
}

export function loadProductStore() {
  ensureDataDir();
  const file = serverConfig.productStorePath();
  if (!fs.existsSync(file)) {
    return emptyStore();
  }
  try {
    return readJsonWithBackup(file);
  } catch {
    return emptyStore();
  }
}

export function saveProductStore(store) {
  ensureDataDir();
  atomicWriteJson(serverConfig.productStorePath(), store, { backup: true });
}

export function getProductEntry(store, productKey) {
  if (!store.products[productKey]) {
    store.products[productKey] = {
      displayName: productKey,
      priceRobux: 0,
      shirts: [],
    };
  }
  return store.products[productKey];
}

export function registerShirt(store, productKey, shirt) {
  const entry = getProductEntry(store, productKey);
  const exists = entry.shirts.some((s) => s.assetId === shirt.assetId);
  if (!exists) {
    entry.shirts.push(shirt);
  }
  store.assetIndex[String(shirt.assetId)] = {
    productKey,
    displayName: shirt.displayName,
    priceRobux: shirt.priceRobux,
    createdAt: shirt.createdAt,
  };
  saveProductStore(store);
  return entry;
}

export function lookupProductKey(store, assetId) {
  return store.assetIndex[String(assetId)] || null;
}

export function listCatalog(store) {
  return Object.entries(store.products)
    .map(([key, entry]) => ({
      productKey: key,
      displayName: entry.displayName,
      priceRobux: entry.priceRobux,
      shirtCount: entry.shirts.length,
      assetIds: entry.shirts.map((s) => s.assetId),
      assetIdList: entry.shirts.map((s) => String(s.assetId)).join(', '),
      shirts: entry.shirts,
    }))
    .sort((a, b) => a.productKey.localeCompare(b.productKey));
}

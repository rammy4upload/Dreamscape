import { RobloxClient } from '../../src/shared/robloxClient.js';

const ASSET_TYPE_TSHIRT = 2;

export async function userOwnsAsset(client, userId, assetId) {
  const url = `https://inventory.roblox.com/v1/users/${userId}/items/Asset/${assetId}`;
  const data = await client.get(url);
  return Array.isArray(data?.data) && data.data.length > 0;
}

export async function uploadTshirt(client, { name, description, pngBuffer, groupId }) {
  const params = new URLSearchParams({
    assetTypeId: String(ASSET_TYPE_TSHIRT),
    genreTypeId: '1',
    name,
    description,
    ispublic: 'False',
    allowComments: 'False',
    isForSale: 'False',
  });

  if (groupId) {
    params.set('groupId', String(groupId));
  }

  const form = new FormData();
  form.append(
    'file',
    new Blob([pngBuffer], { type: 'image/png' }),
    `${name.replace(/[^a-z0-9_-]+/gi, '_')}.png`
  );

  const uploadResponse = await client.request(
    `https://www.roblox.com/ide/publish/uploadnewasset?${params.toString()}`,
    {
      method: 'POST',
      body: form,
    }
  );

  const assetId = extractAssetId(uploadResponse);
  if (!assetId) {
    throw new Error(`T-shirt upload did not return an asset id: ${JSON.stringify(uploadResponse)}`);
  }

  return assetId;
}

export async function configureTshirtSale(client, assetId, priceRobux) {
  const body = {
    saleLocationConfiguration: {
      saleLocationType: 1,
      places: [],
    },
    isFree: false,
    priceInRobux: Number(priceRobux),
  };

  await client.request(
    `https://itemconfiguration.roblox.com/v1/creator-dashboard/creations/${assetId}/update-sale-status`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}

function extractAssetId(payload) {
  if (typeof payload === 'number') {
    return payload;
  }
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (/^\d+$/.test(trimmed)) {
      return Number(trimmed);
    }
    try {
      return extractAssetId(JSON.parse(trimmed));
    } catch {
      const match = trimmed.match(/(\d{6,})/);
      return match ? Number(match[1]) : null;
    }
  }
  if (payload && typeof payload === 'object') {
    return payload.AssetId || payload.assetId || payload.id || payload.Id || null;
  }
  return null;
}

export function createUploadClient(cookie) {
  return new RobloxClient(cookie, 'T-shirt uploader');
}

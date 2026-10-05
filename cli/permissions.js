import { fetchApi } from 'rozod';
import { patchAssetPermissionsApiV1AssetsPermissions } from 'rozod/lib/opencloud/v1/asset-permissions.js';

async function grantPermissions(experienceId, assetIds, apiKey, assetType) {
  if (!assetIds.length) return;

  try {
    const response = await fetchApi(
      patchAssetPermissionsApiV1AssetsPermissions,
      {
        body: {
          subjectType: 'Universe',
          subjectId: String(experienceId),
          action: 'Use',
          requests: assetIds.map(id => ({
            assetId: id,
            grantToDependencies: true,
            parentVersionNumber: 1
          })),
          enableDeepAccessCheck: true
        }
      },
      {
        headers: { 'x-api-key': apiKey }
      }
    );

    if (response.successAssetIds?.length) {
      console.log(`[SUCCESS] Granted ${assetType} permission for assets: ${response.successAssetIds.join(', ')}`);
    }

    if (response.errors?.length) {
      console.error(`[ERROR] Failed to grant ${assetType} permission for some assets:`);
      response.errors.forEach(err => {
        console.error(`   Asset ${err.assetId} → ${err.code}`);
      });
    }

    if (!response.successAssetIds?.length && !response.errors?.length) {
      console.log(`[INFO] No changes for ${assetType} assets: ${assetIds.join(', ')}`);
    }
  } catch (err) {
    console.error(`[FAIL] Error granting ${assetType} permissions:`, err);
  }
}

async function processAssetType(config, account, assetType, assetsArrayName) {
  const batchSize = 50;
  const assets = account[assetsArrayName] || [];
  const apiKey = account.apiKey;

  for (let i = 0; i < assets.length; i += batchSize) {
    const batch = assets.slice(i, i + batchSize);
    console.log(`\nProcessing ${assetType} batch ${i + 1} to ${i + batch.length} for account: ${account.name}`);
    await grantPermissions(config.experienceId, batch, apiKey, assetType);
  }
}

export async function grantPermissionsForAccounts(config, accounts) {
  for (const account of accounts || []) {
    console.log(`\n=== Processing account: ${account.name} ===`);
    await processAssetType(config, account, 'Audio', 'audioAssets');
    await processAssetType(config, account, 'Animation', 'animationAssets');
    console.log(`\n=== Finished account: ${account.name} ===`);
  }
  console.log('[INFO] grantPermissionsForAccounts() finished (returning to caller).');
}

export async function grantAllPermissions(config) {
  await grantPermissionsForAccounts(config, config.assetAccounts || []);
}

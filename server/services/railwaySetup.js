import fs from 'fs';
import path from 'path';
import { ensureDataDir, loadServiceConfig, resolveRobloxCredentials, serverConfig } from '../config.js';
import { ensureConfigFile } from './configStore.js';
import { loadCodesData } from './codesStore.js';
import { getPublicBaseUrl, getRobloxHttpAllowlistHost } from './gameIntegration.js';

export function isRailway() {
  return Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
}

export { getPublicBaseUrl };

export function getDeploymentStatus() {
  ensureDataDir();
  const configPath = ensureConfigFile();
  const configExists = fs.existsSync(configPath);
  const creds = resolveRobloxCredentials();

  let codesCount = 0;
  try {
    codesCount = (loadCodesData().codes || []).length;
  } catch {
    codesCount = 0;
  }

  const dataDir = path.resolve(serverConfig.dataDir);
  const volumeBacked = !isRailway() || Boolean(process.env.RAILWAY_VOLUME_MOUNT_PATH);

  const checks = {
    apiKey: Boolean(serverConfig.apiKey),
    dashboardAuth: Boolean(serverConfig.dashboardPassword),
    config: configExists,
    robloxCookie: Boolean(creds.cookie),
    dataDirWritable: true,
    volumeBacked,
    codesReady: codesCount > 0,
    headless: serverConfig.headless,
    webPrompts: process.env.WEB_PROMPTS === '1',
  };

  try {
    fs.accessSync(dataDir, fs.constants.W_OK);
  } catch {
    checks.dataDirWritable = false;
  }

  const warnings = [];
  if (!checks.apiKey) {
    warnings.push('API_KEY is not set — game HTTP calls to /api/products and /api/codes will fail.');
  }
  if (!checks.dashboardAuth) {
    warnings.push('DASHBOARD_PASSWORD is not set — dashboard and task APIs are public.');
  }
  if (isRailway() && !checks.volumeBacked) {
    warnings.push('No Railway volume detected — config, assets, codes, and products may not survive redeploys.');
  }
  if (!checks.robloxCookie) {
    warnings.push('ROBLOX_COOKIE missing — t-shirt uploads need a cookie in env or config.json.');
  }
  if (!checks.codesReady) {
    warnings.push('No promo codes loaded — seeding from defaults on first request.');
  }

  const publicUrl = getPublicBaseUrl();

  return {
    ok: checks.dataDirWritable && checks.config && checks.apiKey,
    railway: isRailway(),
    publicUrl,
    dataDir,
    configPath,
    codesCount,
    checks,
    warnings,
    gameIntegration: {
      productBridgeBaseUrl: publicUrl,
      productBridgeAuthToken: 'Set ProductBridge.authToken = Railway API_KEY',
      codesUrl: publicUrl ? `${publicUrl}/api/codes/codeslist?key=<API_KEY>` : null,
      productsUrl: publicUrl ? `${publicUrl}/api/products/resolve` : null,
      placeIdsUrl: publicUrl ? `${publicUrl}/api/placeids` : null,
      integrationManifest: publicUrl ? `${publicUrl}/api/integration/manifest` : null,
      luauProductBridgePbb: publicUrl ? `${publicUrl}/api/integration/luau/ProductBridge.PBB.luau` : null,
      luauProductBridge: publicUrl ? `${publicUrl}/api/integration/luau/ProductBridge.luau` : null,
      pbbImplementationGuide: 'docs/product-bridge.md',
      robloxHttpAllowlist: getRobloxHttpAllowlistHost(),
    },
  };
}

export function logDeploymentStatus() {
  const status = getDeploymentStatus();
  console.log(`[server] Environment: ${status.railway ? 'Railway' : 'local'}`);
  if (status.publicUrl) {
    console.log(`[server] Public URL: ${status.publicUrl}`);
  }
  console.log(`[server] Data directory: ${status.dataDir}`);
  console.log(`[server] Config path: ${status.configPath}`);
  console.log(`[server] Promo codes loaded: ${status.codesCount}`);
  for (const warning of status.warnings) {
    console.warn(`[server] ${warning}`);
  }
  return status;
}

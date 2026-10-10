import fs from 'fs';
import path from 'path';
import { ensureDataDir, loadServiceConfig, resolveRobloxCredentials, serverConfig } from '../config.js';
import { ensureConfigFile } from './configStore.js';
import { loadCodesData } from './codesStore.js';
import { getPublicBaseUrl, getRobloxHttpAllowlistHost } from './gameIntegration.js';
import { validateServerConfiguration } from '../config.js';
import { getHealthSnapshot } from './healthManager.js';

export function isRailway() {
  return Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
}

export { getPublicBaseUrl };

export function getDeploymentStatus() {
  ensureDataDir();
  const configPath = ensureConfigFile();
  const configExists = fs.existsSync(configPath);
  const creds = resolveRobloxCredentials();
  const config = loadServiceConfig() || {};

  let codesCount = 0;
  try {
    codesCount = (loadCodesData().codes || []).length;
  } catch {
    codesCount = 0;
  }

  const dataDir = path.resolve(serverConfig.dataDir);
  const volumeBacked = !isRailway() || Boolean(process.env.RAILWAY_VOLUME_MOUNT_PATH);

  const validation = validateServerConfiguration();

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
    statusReportChannel: Boolean(process.env.DISCORD_STATUS_REPORT_CHANNEL_ID || config?.monitor?.discordChannelId || '1557731440676966420'),
    statusVoiceChannel: Boolean(process.env.DISCORD_STATUS_VOICE_CHANNEL_ID || config?.monitor?.discordStatusChannelId || '1226004017394614325'),
    statsChannels: Boolean(
      (process.env.DISCORD_FAVORITES_CHANNEL_ID || config?.monitor?.discordFavoritesChannelId || '1275393071089192960') &&
      (process.env.DISCORD_VISITS_CHANNEL_ID || config?.monitor?.discordVisitsChannelId || '1275393127993311253') &&
      (process.env.DISCORD_PLAYERS_CHANNEL_ID || config?.monitor?.discordPlayerCountChannelId || '1275393110213656667')
    ),
    startupConfigValid: validation.ok,
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
    warnings.push('DASHBOARD_PASSWORD is not set — dashboard and task APIs fail closed in production.');
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
  for (const warning of validation.warnings || []) {
    if (!warnings.includes(warning)) warnings.push(warning);
  }

  const publicUrl = getPublicBaseUrl();

  return {
    ok: checks.dataDirWritable && checks.config && checks.apiKey && checks.dashboardAuth,
    railway: isRailway(),
    publicUrl,
    dataDir,
    configPath,
    codesCount,
    checks,
    warnings,
    errors: validation.errors,
    health: getHealthSnapshot(),
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

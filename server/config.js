import fs from 'fs';
import path from 'path';
import { readJsonWithBackup } from '../src/shared/atomicStore.js';

const DATA_DIR = process.env.DATA_DIR || ((process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) ? '/data' : path.join(process.cwd(), 'data'));
const DEFAULT_CONFIG_PATH = process.env.CONFIG_PATH || path.join(DATA_DIR, 'config.json');

const PLACEHOLDER_SECRET_RE = /^(?:<[^>]*YOUR[^>]*>|PASTE_YOUR.*|REPLACE_WITH.*|YOUR_[A-Z0-9_]+|CHANGE_ME.*|EXAMPLE_.*|DISCORD_BOT_TOKEN_HERE)$/i;

export function isConfiguredSecret(value) {
  const text = String(value ?? '').trim();
  return Boolean(text) && !PLACEHOLDER_SECRET_RE.test(text);
}

function env(name, fallback = '') {
  const value = String(process.env[name] ?? fallback).trim();
  return isConfiguredSecret(value) ? value : '';
}

export function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return DATA_DIR;
}

export function dataPath(name) {
  const safe = String(name || '').replace(/\\/g, '/');
  if (safe.includes('..') || path.isAbsolute(safe)) throw new Error('Unsafe data path');
  return path.join(ensureDataDir(), safe);
}

export const serverConfig = {
  port: Number(process.env.PORT || 3000),
  apiKey: env('API_KEY'),
  codesApiKey: env('CODES_API_KEY') || env('API_KEY'),
  githubToken: env('GITHUB_TOKEN'),
  dataDir: DATA_DIR,
  configPath: DEFAULT_CONFIG_PATH,
  headless: env('HEADLESS', '1') !== '0',
  webPrompts: env('WEB_PROMPTS', '1') === '1',
  dashboardPassword: env('DASHBOARD_PASSWORD'),
  publicBaseUrl: env('PUBLIC_BASE_URL') || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : ''),
  productStorePath: () => dataPath('products.json'),
  tshirtTemplatePath: env('TSHIRT_TEMPLATE_PATH', path.join(DATA_DIR, 'tshirt-template.png')),
  robloxCookie: env('ROBLOX_COOKIE'),
  robloxUserId: env('ROBLOX_USER_ID'),
  robloxGroupId: env('ROBLOX_GROUP_ID'),
};

export function loadServiceConfig() {
  ensureDataDir();
  const file = path.resolve(serverConfig.configPath);
  if (!fs.existsSync(file)) return null;
  return readJsonWithBackup(file);
}

export function resolveRobloxCredentials() {
  const fromEnv = {
    cookie: serverConfig.robloxCookie,
    userId: serverConfig.robloxUserId,
    groupId: serverConfig.robloxGroupId,
  };
  if (isConfiguredSecret(fromEnv.cookie)) return fromEnv;
  const config = loadServiceConfig();
  const primary = config?.accountPool?.primary || config?.creatorAccount;
  if (!isConfiguredSecret(primary?.cookie)) return fromEnv;
  return {
    cookie: primary.cookie,
    userId: String(primary.userId || ''),
    groupId: primary.isGroup ? String(primary.groupId || '') : '',
  };
}

export function validateServerConfiguration() {
  ensureDataDir();
  const checks = {
    dataDir: false,
    configPath: false,
    apiKey: isConfiguredSecret(serverConfig.apiKey),
    dashboardPassword: isConfiguredSecret(serverConfig.dashboardPassword),
    robloxCredential: false,
  };
  const warnings = [];
  const errors = [];
  try {
    fs.accessSync(serverConfig.dataDir, fs.constants.W_OK);
    checks.dataDir = true;
  } catch {
    errors.push(`DATA_DIR is not writable: ${serverConfig.dataDir}`);
  }
  let loadedConfig = null;
  try {
    if (fs.existsSync(serverConfig.configPath)) loadedConfig = JSON.parse(fs.readFileSync(serverConfig.configPath, 'utf8'));
    checks.configPath = true;
  } catch (error) {
    errors.push(`CONFIG_PATH is invalid or malformed: ${error.message}`);
  }
  if (serverConfig.publicBaseUrl) {
    try {
      const url = new URL(serverConfig.publicBaseUrl);
      if (url.protocol !== 'https:') errors.push('PUBLIC_BASE_URL must use HTTPS.');
    } catch (error) {
      errors.push(`PUBLIC_BASE_URL is invalid: ${error.message}`);
    }
  }
  const healthUrl = loadedConfig?.monitor?.healthUrl;
  if (healthUrl) {
    try {
      const url = new URL(healthUrl);
      if (url.protocol !== 'https:' || !/^(www\.)?roblox\.com$/i.test(url.hostname) || !/^\/games\/\d+/i.test(url.pathname)) {
        errors.push('monitor.healthUrl must be a Roblox HTTPS game URL.');
      }
    } catch (error) {
      errors.push(`monitor.healthUrl is invalid: ${error.message}`);
    }
  }
  const configuredBaseUrl = loadedConfig?.gameIntegration?.publicBaseUrl;
  if (configuredBaseUrl) {
    try {
      const url = new URL(configuredBaseUrl);
      if (url.protocol !== 'https:') errors.push('gameIntegration.publicBaseUrl must use HTTPS.');
    } catch (error) {
      errors.push(`gameIntegration.publicBaseUrl is invalid: ${error.message}`);
    }
  }
  checks.robloxCredential = isConfiguredSecret(resolveRobloxCredentials().cookie);
  if (!checks.apiKey) warnings.push('API_KEY is missing; protected APIs fail closed.');
  if (!checks.dashboardPassword) warnings.push('DASHBOARD_PASSWORD is missing; dashboard fails closed in production.');
  if (!checks.robloxCredential) warnings.push('No Roblox cookie is configured; Roblox operations cannot authenticate until one is supplied.');
  if (env('NODE_ENV') === 'production' && !checks.apiKey) errors.push('API_KEY is required in production.');
  if (env('NODE_ENV') === 'production' && !checks.dashboardPassword) errors.push('DASHBOARD_PASSWORD is required in production.');
  return { ok: errors.length === 0, checks, warnings, errors };
}

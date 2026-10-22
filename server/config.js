import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');

export function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return DATA_DIR;
}

export function dataPath(name) {
  return path.join(ensureDataDir(), name);
}

export const serverConfig = {
  port: Number(process.env.PORT || 3000),
  apiKey: process.env.API_KEY || process.env.AUTH_TOKEN || '',
  codesApiKey: process.env.CODES_API_KEY || process.env.API_KEY || process.env.AUTH_TOKEN || '',
  dataDir: DATA_DIR,
  configPath: process.env.CONFIG_PATH || path.join(process.cwd(), 'config.json'),
  headless: process.env.HEADLESS !== '0',
  dashboardPassword: (process.env.DASHBOARD_PASSWORD || '').trim(),
  productStorePath: () => dataPath('products.json'),
  tshirtTemplatePath:
    process.env.TSHIRT_TEMPLATE_PATH || path.join(process.cwd(), 'assets', 'tshirt-template.png'),
  robloxCookie: process.env.ROBLOX_COOKIE || '',
  robloxUserId: process.env.ROBLOX_USER_ID || '',
  robloxGroupId: process.env.ROBLOX_GROUP_ID || '',
};

export function loadServiceConfig() {
  ensureDataDir();
  const file = serverConfig.configPath;
  if (!fs.existsSync(file)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function resolveRobloxCredentials() {
  const fromEnv = {
    cookie: serverConfig.robloxCookie,
    userId: serverConfig.robloxUserId,
    groupId: serverConfig.robloxGroupId,
  };

  if (fromEnv.cookie) {
    return fromEnv;
  }

  const config = loadServiceConfig();
  const primary = config?.accountPool?.primary || config?.creatorAccount;
  if (!primary?.cookie) {
    return fromEnv;
  }

  return {
    cookie: primary.cookie,
    userId: String(primary.userId || ''),
    groupId: primary.isGroup ? String(primary.groupId || '') : '',
  };
}

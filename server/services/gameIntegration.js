import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadServiceConfig, serverConfig } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LUau_DIR = path.join(__dirname, '../../assets/luau');

export const LUau_PLACEHOLDERS = {
  BASE_URL: '__AUTOREUPLOADER_BASE_URL__',
  API_KEY: '__AUTOREUPLOADER_API_KEY__',
};

const PUBLIC_API_KEY_PLACEHOLDER = 'PASTE_YOUR_RAILWAY_API_KEY';

/** @type {Set<string> | null} */
let luauFileCache = null;

function listLuauFilenames() {
  if (luauFileCache) {
    return [...luauFileCache];
  }

  if (!fs.existsSync(LUau_DIR)) {
    luauFileCache = new Set();
    return [];
  }

  const names = fs
    .readdirSync(LUau_DIR)
    .filter((name) => name.endsWith('.luau') && fs.statSync(path.join(LUau_DIR, name)).isFile());
  luauFileCache = new Set(names);
  return [...luauFileCache];
}

export function assertLuauFilename(filename) {
  const aliases = {
    'ProductBridge.PA.luau': 'ProductBridge.PBB.luau',
  };
  const resolved = aliases[filename] || filename;
  const safe = path.basename(String(resolved || ''));
  if (!safe.endsWith('.luau') || safe !== resolved) {
    throw new Error('Invalid Luau filename');
  }
  if (!listLuauFilenames().includes(safe)) {
    throw new Error(`Unknown Luau file: ${safe}`);
  }
  return safe;
}

/**
 * Public base URL for game integration (ProductBridge, codes, manifest links).
 * Priority: Railway domain → PUBLIC_BASE_URL env → config gameIntegration.publicBaseUrl
 */
export function getPublicBaseUrl() {
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`.replace(/\/+$/, '');
  }
  if (process.env.PUBLIC_BASE_URL) {
    return String(process.env.PUBLIC_BASE_URL).replace(/\/+$/, '');
  }

  const config = loadServiceConfig();
  const fromConfig = config?.gameIntegration?.publicBaseUrl;
  if (fromConfig && String(fromConfig).trim()) {
    let url = String(fromConfig).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(url)) {
      url = `https://${url}`;
    }
    return url;
  }

  return null;
}

export function getRobloxHttpAllowlistHost() {
  const base = getPublicBaseUrl();
  if (!base) {
    return null;
  }
  return base.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

export function renderLuauTemplate(filename, { includeApiKey = false } = {}) {
  const safeName = assertLuauFilename(filename);
  const filePath = path.join(LUau_DIR, safeName);
  let content = fs.readFileSync(filePath, 'utf8');

  const baseUrl = getPublicBaseUrl() || LUau_PLACEHOLDERS.BASE_URL;
  content = content.replaceAll(LUau_PLACEHOLDERS.BASE_URL, baseUrl);

  const apiKeyValue = includeApiKey && serverConfig.apiKey
    ? serverConfig.apiKey
    : PUBLIC_API_KEY_PLACEHOLDER;
  content = content.replaceAll(LUau_PLACEHOLDERS.API_KEY, apiKeyValue);

  return content;
}

export function getIntegrationManifest(req) {
  const publicBaseUrl = getPublicBaseUrl();
  const host = req?.get?.('host');
  const proto = (req?.get?.('x-forwarded-proto') || 'https').split(',')[0].trim();
  const requestOrigin = host ? `${proto}://${host}` : null;
  const origin = publicBaseUrl || requestOrigin;

  const files = listLuauFilenames().map((name) => ({
    name,
    repoPath: `assets/luau/${name}`,
    publicUrl: origin ? `${origin}/api/integration/luau/${name}` : null,
  }));

  return {
    publicBaseUrl,
    configuredVia: publicBaseUrl
      ? process.env.RAILWAY_PUBLIC_DOMAIN
        ? 'RAILWAY_PUBLIC_DOMAIN'
        : process.env.PUBLIC_BASE_URL
          ? 'PUBLIC_BASE_URL'
          : 'config.gameIntegration.publicBaseUrl'
      : null,
    files,
    docs: {
      documentation: 'docs/README.md',
      productBridgeGuide: 'docs/product-bridge.md',
    },
    endpoints: {
      productsResolve: publicBaseUrl ? `${publicBaseUrl}/api/products/resolve` : null,
      codesList: publicBaseUrl ? `${publicBaseUrl}/api/codes/codeslist?key=<API_KEY>` : null,
      placeIds: publicBaseUrl ? `${publicBaseUrl}/api/placeids` : null,
      health: publicBaseUrl ? `${publicBaseUrl}/health` : null,
    },
    robloxHttpAllowlist: getRobloxHttpAllowlistHost(),
    productBridge: {
      baseUrl: publicBaseUrl || LUau_PLACEHOLDERS.BASE_URL,
      authToken: PUBLIC_API_KEY_PLACEHOLDER,
    },
  };
}

export function listLuauAssets() {
  return listLuauFilenames().map((name) => ({
    name,
    repoPath: `assets/luau/${name}`,
  }));
}

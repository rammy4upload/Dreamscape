import fs from 'fs';
import path from 'path';
import { ensureDataDir, serverConfig, loadServiceConfig } from '../config.js';
import { saveConfig, loadConfig } from './configStore.js';

const ASSET_KINDS = {
  rbxl: { filename: 'game.rbxl', configKey: 'experience.rbxlPath', mime: 'application/octet-stream' },
  icon: { filename: 'icon.png', configKey: 'experience.iconPath', mime: 'image/png' },
  thumbnail: { filename: 'thumbnail.png', configKey: 'experience.thumbnailPath', mime: 'image/png' },
  tshirt: { filename: 'tshirt-template.png', configKey: null, mime: 'image/png' },
};

function resolveProjectRoot() {
  return path.resolve(process.cwd());
}

function dataDirFile(kind) {
  const spec = getAssetKind(kind);
  return path.join(serverConfig.dataDir, spec.filename);
}

/** Stable config path for files stored on the persistent data volume. */
export function formatConfigAssetPath(absolutePath) {
  const abs = path.resolve(absolutePath);
  const dataDir = path.resolve(serverConfig.dataDir);
  if (abs === dataDir || abs.startsWith(`${dataDir}${path.sep}`)) {
    return abs.split(path.sep).join('/');
  }
  const rel = path.relative(resolveProjectRoot(), abs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    return `./${rel.split(path.sep).join('/')}`;
  }
  return abs.split(path.sep).join('/');
}

function readNestedValue(obj, dotPath) {
  return dotPath.split('.').reduce((cur, part) => cur?.[part], obj);
}

function writeNestedValue(obj, dotPath, value) {
  const parts = dotPath.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    cur[parts[i]] = cur[parts[i]] || {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function resolveConfiguredPath(configuredPath) {
  if (!configuredPath || typeof configuredPath !== 'string') {
    return null;
  }
  const trimmed = configuredPath.trim();
  if (!trimmed) {
    return null;
  }
  if (path.isAbsolute(trimmed)) {
    return trimmed;
  }
  return path.resolve(resolveProjectRoot(), trimmed);
}

export function getAssetKind(kind) {
  const spec = ASSET_KINDS[kind];
  if (!spec) {
    throw new Error(`Unknown asset kind: ${kind}`);
  }
  return spec;
}

export function assetFilePath(kind) {
  ensureDataDir();
  const spec = getAssetKind(kind);

  if (kind === 'tshirt') {
    const configured = serverConfig.tshirtTemplatePath;
    if (configured && fs.existsSync(configured)) {
      return path.resolve(configured);
    }
    const dataFile = dataDirFile(kind);
    if (fs.existsSync(dataFile)) {
      return dataFile;
    }
  }

  const dataFile = dataDirFile(kind);
  if (fs.existsSync(dataFile)) {
    return dataFile;
  }

  const config = loadServiceConfig();
  if (config && spec.configKey) {
    const configured = readNestedValue(config, spec.configKey);
    const resolved = resolveConfiguredPath(configured);
    if (resolved && fs.existsSync(resolved)) {
      return resolved;
    }
  }

  return dataFile;
}

function updateConfigPath(kind, absolutePath) {
  const spec = getAssetKind(kind);
  if (!spec.configKey) {
    return;
  }
  const config = loadConfig() || {};
  writeNestedValue(config, spec.configKey, formatConfigAssetPath(absolutePath));
  saveConfig(config);
}

export function saveAsset(kind, buffer) {
  ensureDataDir();
  const target = dataDirFile(kind);
  fs.writeFileSync(target, buffer);
  const spec = getAssetKind(kind);
  updateConfigPath(kind, target);
  return {
    kind,
    path: target,
    configPath: spec.configKey ? formatConfigAssetPath(target) : null,
    size: buffer.length,
    updatedAt: fs.statSync(target).mtime.toISOString(),
  };
}

/** Point config asset paths at files that already exist on the data volume. */
export function normalizePersistedAssetPaths({ save = false } = {}) {
  const config = loadConfig();
  if (!config) {
    return false;
  }

  let changed = false;
  for (const kind of Object.keys(ASSET_KINDS)) {
    const spec = getAssetKind(kind);
    if (!spec.configKey) {
      continue;
    }

    const dataFile = dataDirFile(kind);
    if (!fs.existsSync(dataFile)) {
      continue;
    }

    const desired = formatConfigAssetPath(dataFile);
    const current = readNestedValue(config, spec.configKey);
    const resolvedCurrent = resolveConfiguredPath(current);
    const currentMatches =
      resolvedCurrent && path.resolve(resolvedCurrent) === path.resolve(dataFile);

    if (current !== desired && !currentMatches) {
      writeNestedValue(config, spec.configKey, desired);
      changed = true;
    }
  }

  if (changed && save) {
    saveConfig(config);
    console.log('[assets] Updated config paths to persistent data volume');
  }

  return changed;
}

export function getAssetMeta(kind) {
  const file = assetFilePath(kind);
  const exists = fs.existsSync(file);
  return {
    kind,
    path: file,
    exists,
    size: exists ? fs.statSync(file).size : 0,
    updatedAt: exists ? fs.statSync(file).mtime.toISOString() : null,
    mime: getAssetKind(kind).mime,
  };
}

export function listAssets() {
  return Object.keys(ASSET_KINDS).map((kind) => getAssetMeta(kind));
}

export function getPersistedAssetsStatus() {
  ensureDataDir();
  const dataDir = path.resolve(serverConfig.dataDir);
  const onRailway = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
  const volumeBacked = !onRailway || Boolean(process.env.RAILWAY_VOLUME_MOUNT_PATH);
  return {
    dataDir,
    onRailway,
    volumeBacked,
    assets: listAssets(),
  };
}

import fs from 'fs';
import path from 'path';
import { loadServiceConfig, serverConfig } from '../config.js';
import { atomicWriteJson, readJsonWithBackup } from '../../src/shared/atomicStore.js';

const SENSITIVE_PATTERN = /cookie|apikey|api_key|token|password|secret|roblox/i;
const ASSET_ARRAY_KEYS = new Set(['audioAssets', 'animationAssets']);
const JSON_CONFIG_FIELDS = new Map([
  ['experience.playableDevices', { type: 'array', defaultValue: ['Computer', 'Phone', 'Tablet', 'Console'] }],
  ['experience.rbxlPaths', { type: 'object', defaultValue: {} }],
  ['questionnaire.questionIds', { type: 'array', defaultValue: [] }],
  ['questionnaire.answers', { type: 'array', defaultValue: [] }],
  ['questionnaire.answersByQuestionId', { type: 'object', defaultValue: {} }],
]);

function isJsonConfigField(fieldPath) {
  return JSON_CONFIG_FIELDS.has(fieldPath);
}

function defaultJsonConfigValue(fieldPath) {
  const field = JSON_CONFIG_FIELDS.get(fieldPath);
  return field ? structuredClone(field.defaultValue) : null;
}

function parseJsonConfigValue(raw, fieldPath) {
  const field = JSON_CONFIG_FIELDS.get(fieldPath);
  if (!field) return raw;
  if (raw === null || raw === undefined || (typeof raw === 'string' && !raw.trim())) {
    return defaultJsonConfigValue(fieldPath);
  }

  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`${fieldPath} must be valid JSON: ${error.message}`);
    }
  }

  if (field.type === 'array' && !Array.isArray(parsed)) {
    throw new Error(`${fieldPath} must be a JSON array (for example: [\"Computer\", \"Phone\"]).`);
  }
  if (field.type === 'object' && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
    throw new Error(`${fieldPath} must be a JSON object (for example: {}).`);
  }
  return parsed;
}

export function isAssetIdArrayPath(fieldPath) {
  const leaf = fieldPath.split('.').pop();
  return ASSET_ARRAY_KEYS.has(leaf);
}

function formatAssetIdArray(value) {
  if (!Array.isArray(value) || !value.length) {
    return '';
  }
  return value.map((n) => String(n)).join(', ');
}

function parseAssetIdArray(raw, fieldPath) {
  if (Array.isArray(raw)) {
    return raw.map((n) => Number(n)).filter((n) => Number.isFinite(n));
  }
  const text = String(raw).trim();
  if (!text) {
    return [];
  }
  return text.split(/,\s*/).filter(Boolean).map((part) => {
    const n = Number(part.trim());
    if (!Number.isFinite(n)) {
      throw new Error(`Invalid asset id "${part}" in ${fieldPath}`);
    }
    return n;
  });
}

export function isSensitivePath(fieldPath) {
  return SENSITIVE_PATTERN.test(fieldPath);
}

export function getConfigPath() {
  return path.resolve(serverConfig.configPath);
}

function exampleConfigPath() {
  return path.join(process.cwd(), 'config.example.json');
}

function bundledConfigPath() {
  return path.join(process.cwd(), 'config.json');
}

/** Create config.json from config.example.json (or a minimal skeleton) when missing. */
export function ensureConfigFile() {
  const file = getConfigPath();
  if (fs.existsSync(file)) {
    return file;
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });

  const bundled = bundledConfigPath();
  if (fs.existsSync(bundled) && path.resolve(bundled) !== path.resolve(file)) {
    atomicWriteJson(file, JSON.parse(fs.readFileSync(bundled, 'utf8')), { backup: false });
    console.log(`[config] Created ${file} from bundled config.json`);
    return file;
  }

  const example = exampleConfigPath();
  if (fs.existsSync(example)) {
    atomicWriteJson(file, JSON.parse(fs.readFileSync(example, 'utf8')), { backup: false });
    console.log(`[config] Created ${file} from config.example.json`);
    return file;
  }

  const skeleton = {
    accountPool: { primary: {}, backups: [] },
    experience: {},
    monitor: {},
  };
  atomicWriteJson(file, skeleton, { backup: false });
  console.log(`[config] Created empty ${file}`);
  return file;
}

export function loadConfig() {
  const file = getConfigPath();
  if (!fs.existsSync(file)) {
    return null;
  }
  return readJsonWithBackup(file);
}

export function saveConfig(config) {
  const file = getConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteJson(file, config, { backup: true });
  return file;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function flattenConfig(obj, prefix = '', out = {}) {
  if (Array.isArray(obj)) {
    obj.forEach((item, index) => {
      const key = prefix ? `${prefix}.${index}` : String(index);
      if (isPlainObject(item) || Array.isArray(item)) {
        flattenConfig(item, key, out);
      } else {
        out[key] = item ?? '';
      }
    });
    return out;
  }

  if (isPlainObject(obj)) {
    for (const [key, value] of Object.entries(obj)) {
      const pathKey = prefix ? `${prefix}.${key}` : key;
      if (ASSET_ARRAY_KEYS.has(key) && Array.isArray(value)) {
        out[pathKey] = formatAssetIdArray(value);
        continue;
      }
      if (isPlainObject(value) || Array.isArray(value)) {
        flattenConfig(value, pathKey, out);
      } else {
        out[pathKey] = value ?? '';
      }
    }
  }

  return out;
}

function coerceValue(raw, fieldPath) {
  if (isJsonConfigField(fieldPath)) {
    return parseJsonConfigValue(raw, fieldPath);
  }
  if (isAssetIdArrayPath(fieldPath)) {
    return parseAssetIdArray(raw, fieldPath);
  }
  if (raw === '' || raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw === 'boolean' || typeof raw === 'number') {
    return raw;
  }
  const text = String(raw).trim();
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  if (/^-?\d+$/.test(text) && !fieldPath.includes('Id') && !fieldPath.includes('id') && text.length < 12) {
    const n = Number(text);
    if (Number.isSafeInteger(n)) return n;
  }
  return text;
}

function assertSafeFieldPath(fieldPath) {
  if (!fieldPath || fieldPath.split('.').some((part) => ['__proto__', 'prototype', 'constructor'].includes(part))) {
    throw new Error('Unsafe configuration field path');
  }
}

function pathIsInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function validateConfiguredPath(raw, fieldPath) {
  const value = String(raw || '').trim();
  if (!value) return;
  if (value.includes('\0') || /(^|[\\/])\.\.([\\/]|$)/.test(value)) {
    throw new Error(`Unsafe path in ${fieldPath}`);
  }
  if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) {
    const resolved = path.resolve(value);
    const allowedRoots = [process.cwd(), serverConfig.dataDir];
    if (!allowedRoots.some((root) => pathIsInside(resolved, root))) {
      throw new Error(`Path outside Railway application storage is not allowed in ${fieldPath}`);
    }
  }
}

function validateConfigSecurity(config) {
  const pathFields = [
    ['experience', 'rbxlPath'],
    ['experience', 'iconPath'],
    ['experience', 'thumbnailPath'],
    ['placeIds', 'outputPath'],
    ['placeIds', 'git', 'repositoryPath'],
  ];
  for (const parts of pathFields) {
    let value = config;
    for (const part of parts) value = value?.[part];
    if (typeof value !== 'string' || !value.trim()) continue;
    validateConfiguredPath(value, parts.join('.'));
  }

  const rbxlPaths = config?.experience?.rbxlPaths;
  if (rbxlPaths && typeof rbxlPaths === 'object' && !Array.isArray(rbxlPaths)) {
    for (const key of ['Main', 'Battle', 'Trade']) {
      if (typeof rbxlPaths[key] === 'string' && rbxlPaths[key].trim()) {
        validateConfiguredPath(rbxlPaths[key], `experience.rbxlPaths.${key}`);
      }
    }
  }

  const healthUrl = config?.monitor?.healthUrl;
  if (healthUrl) {
    try {
      const url = new URL(healthUrl);
      if (url.protocol !== 'https:' || !/^(www\.)?roblox\.com$/i.test(url.hostname) || !/^\/games\/\d+/i.test(url.pathname)) {
        throw new Error('monitor.healthUrl must be a Roblox game HTTPS URL');
      }
    } catch (error) {
      throw new Error(`Unsafe monitor.healthUrl: ${error.message}`);
    }
  }

  const publicBaseUrl = config?.gameIntegration?.publicBaseUrl;
  if (publicBaseUrl) {
    const url = new URL(publicBaseUrl);
    if (url.protocol !== 'https:') throw new Error('gameIntegration.publicBaseUrl must use HTTPS');
  }
}

function setDeep(target, fieldPath, value) {
  assertSafeFieldPath(fieldPath);
  const parts = fieldPath.split('.');
  let cur = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    const next = parts[i + 1];
    const nextIsIndex = /^\d+$/.test(next);
    if (cur[part] === undefined || cur[part] === null) {
      cur[part] = nextIsIndex ? [] : {};
    }
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
}

export function applyFlatConfigUpdates(baseConfig, flatUpdates) {
  const next = structuredClone(baseConfig);
  for (const [fieldPath, value] of Object.entries(flatUpdates || {})) {
    setDeep(next, fieldPath, coerceValue(value, fieldPath));
  }
  validateConfigSecurity(next);
  return next;
}

export function getConfigFields() {
  ensureConfigFile();
  const config = loadServiceConfig();
  if (!config) {
    return { path: getConfigPath(), exists: false, sections: [], groups: [] };
  }
  const sections = buildConfigSections(config);
  const groups = buildConfigGroups(config);
  return { path: getConfigPath(), exists: true, sections, groups };
}

export function updateConfigFields(flatUpdates) {
  ensureConfigFile();
  const current = loadConfig();
  if (!current) {
    throw new Error(`Config file not found: ${getConfigPath()}`);
  }
  const merged = applyFlatConfigUpdates(current, flatUpdates);
  saveConfig(merged);
  return getConfigFields();
}

const POOL_ACCOUNT_FIELDS = [
  'name',
  'experienceId',
  'isGroup',
  'groupId',
  'groupOwnerUserId',
  'groupOwnerName',
  'groupOwnerCookie',
  'userId',
  'cookie',
  'apiKey',
  'groupApiKey',
];

const ASSET_ACCOUNT_FIELDS = ['name', 'userId', 'cookie', 'apiKey', 'audioAssets', 'animationAssets'];

const SIMPLE_SECTIONS = [
  { key: 'friendAutomation', title: 'Friend automation' },
  { key: 'permissions', title: 'Permissions' },
  { key: 'unfriendAfterGrant', title: 'Unfriend after grant' },
  { key: 'studioLaunch', title: 'Studio launch' },
];

const EXPERIENCE_FIELDS = [
  'name',
  'description',
  'rbxlPath',
  'rbxlPaths',
  'iconPath',
  'thumbnailPath',
  'templatePlaceId',
  'enableMicrophone',
  'maxPlayers',
  'allowCopying',
  'socialSlotType',
  'placeAccessControl',
  'allowPrivateServers',
  'privateServerPrice',
  'playableDevices',
  'discordServerUrl',
];

const MONITOR_FIELDS = [
  'enabled',
  'autoMonitor',
  'healthUrl',
  'intervalMs',
  'retryCount',
  'retryDelayMs',
  'confirmDelayMs',
  'discordChannelId',
  'discordPlayerCountChannelId',
  'discordStatusChannelId',
  'discordFavoritesChannelId',
  'discordVisitsChannelId',
  'discordGameLinkEmbedChannelId',
  'discordBugChannelId',
  'discordUpdatesChannelId',
  'discordCodesChannelId',
  'discordBoosterCodesChannelId',
  'statisticsIntervalMs',
  'discordScanPages',
  'discordDeleteAllMessagesInChannel',
  'discordBotToken',
  'discordLastGameLinkMessageId',
  'discordGroupUrl',
  'discordAnnounceHere',
  'discordBotIconUrl',
];

const PLACE_IDS_FIELDS = ['outputPath'];
const PLACE_IDS_GIT_FIELDS = [
  'enabled',
  'required',
  'repositoryPath',
  'remoteRawUrl',
  'commitMessage',
  'githubOwner',
  'githubRepo',
  'githubBranch',
  'githubFilePath',
];
const QUESTIONNAIRE_FIELDS = [
  'enabled',
  'required',
  'fallbackQuestionnaireId',
  'questionIds',
  'answers',
  'answersByQuestionId',
];

const GAME_INTEGRATION_FIELDS = ['publicBaseUrl'];

function humanizeLabel(key, fieldPath = '') {
  const pathLabels = {
    'experience.playableDevices': 'Playable devices (JSON array)',
    'experience.rbxlPaths': 'Per-place RBXL paths (JSON object; optional)',
    'experience.allowPrivateServers': 'Enable private servers',
    'experience.privateServerPrice': 'Private server price (Robux)',
    'experience.discordServerUrl': 'Discord server invite URL',
    'questionnaire.enabled': 'Enable experience questionnaire',
    'questionnaire.required': 'Fail upload if questionnaire submission fails',
    'questionnaire.fallbackQuestionnaireId': 'Fallback questionnaire ID',
    'questionnaire.questionIds': 'Question IDs (JSON array)',
    'questionnaire.answers': 'Answers (JSON array)',
    'questionnaire.answersByQuestionId': 'Answers by question ID (JSON object)',
    'placeIds.git.enabled': 'GitHub place-ID export enabled',
    'placeIds.git.required': 'Fail upload if GitHub place-ID export fails',
  };
  if (pathLabels[fieldPath]) return pathLabels[fieldPath];
  const labels = {
    experienceId: 'Experience ID',
    userId: 'User ID',
    groupId: 'Group ID',
    groupOwnerUserId: 'Group owner user ID',
    groupOwnerName: 'Group owner name',
    groupOwnerCookie: 'Group owner cookie',
    groupApiKey: 'Group API key',
    apiKey: 'API key',
    rbxlPath: 'RBXL path',
    iconPath: 'Icon path',
    thumbnailPath: 'Thumbnail path',
    templatePlaceId: 'Template place ID',
    enableMicrophone: 'Enable microphone',
    maxPlayers: 'Max players',
    allowCopying: 'Allow copying',
    socialSlotType: 'Social slot type',
    placeAccessControl: 'Place access control',
    healthUrl: 'Health URL',
    intervalMs: 'Interval (ms)',
    retryCount: 'Retry count',
    retryDelayMs: 'Retry delay (ms)',
    confirmDelayMs: 'Confirm delay (ms)',
    discordChannelId: 'Discord channel ID',
    discordPlayerCountChannelId: 'Player count channel ID',
    discordStatusChannelId: 'Status channel ID',
    discordScanPages: 'Discord scan pages',
    discordDeleteAllMessagesInChannel: 'Delete all messages in channel',
    discordBotToken: 'Discord bot token',
    discordLastGameLinkMessageId: 'Last game link message ID',
    outputPath: 'Output path',
    repositoryPath: 'Repository path (local PC only)',
    remoteRawUrl: 'Remote raw URL',
    commitMessage: 'Commit message',
    githubOwner: 'GitHub owner (Railway)',
    githubRepo: 'GitHub repo (Railway)',
    githubBranch: 'GitHub branch',
    githubFilePath: 'GitHub file path',
    enabled: 'Git export enabled',
    studioPath: 'Studio path',
    manualFallback: 'Manual fallback',
    publicBaseUrl: 'Public base URL (ProductBridge / Luau downloads)',
    audioAssets: 'Audio assets',
    animationAssets: 'Animation assets',
    isGroup: 'Is group',
  };
  if (labels[key]) {
    return labels[key];
  }
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

function formatFieldValue(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'boolean') {
    return String(value);
  }
  return String(value);
}

function makeField(fullPath, label, value) {
  const sensitive = isSensitivePath(fullPath) || isSensitivePath(label);
  const visibleValue = isJsonConfigField(fullPath)
    ? (value === '' || value === null || value === undefined ? defaultJsonConfigValue(fullPath) : value)
    : value;
  const text = sensitive && visibleValue
    ? ''
    : isJsonConfigField(fullPath)
      ? JSON.stringify(visibleValue, null, 2)
      : formatFieldValue(visibleValue);
  return {
    key: fullPath,
    label,
    value: text,
    sensitive,
    hasValue: sensitive ? Boolean(visibleValue) : true,
    assetIdList: isAssetIdArrayPath(fullPath),
    multiline:
      isAssetIdArrayPath(fullPath) ||
      isJsonConfigField(fullPath) ||
      text.includes('\n') ||
      (text.length > 120 && !sensitive),
  };
}

function fieldsFromObject(obj, prefix, fieldOrder = null) {
  if (!obj || typeof obj !== 'object') {
    return [];
  }
  const keys = fieldOrder || Object.keys(obj);
  const fields = [];
  for (const key of keys) {
    const hasKey = Object.prototype.hasOwnProperty.call(obj, key);
    if (!hasKey && !fieldOrder) {
      continue;
    }
    const value = hasKey ? obj[key] : '';
    const fullPath = `${prefix}.${key}`;
    if (isJsonConfigField(fullPath)) {
      fields.push(makeField(fullPath, humanizeLabel(key, fullPath), value));
      continue;
    }
    if (ASSET_ARRAY_KEYS.has(key) && Array.isArray(value)) {
      fields.push(makeField(fullPath, humanizeLabel(key, fullPath), formatAssetIdArray(value)));
      continue;
    }
    if (isPlainObject(value) || Array.isArray(value)) {
      continue;
    }
    fields.push(makeField(fullPath, humanizeLabel(key, fullPath), value));
  }
  for (const [key, value] of Object.entries(obj)) {
    if (keys.includes(key)) {
      continue;
    }
    const fullPath = `${prefix}.${key}`;
    if (isJsonConfigField(fullPath)) {
      fields.push(makeField(fullPath, humanizeLabel(key, fullPath), value));
      continue;
    }
    if (ASSET_ARRAY_KEYS.has(key) && Array.isArray(value)) {
      fields.push(makeField(fullPath, humanizeLabel(key, fullPath), formatAssetIdArray(value)));
      continue;
    }
    if (isPlainObject(value) || Array.isArray(value)) {
      continue;
    }
    fields.push(makeField(fullPath, humanizeLabel(key, fullPath), value));
  }
  return fields;
}

function poolAccountEntry(account, prefix, { backupIndex, removable } = {}) {
  const title = account.name?.trim() || (backupIndex !== undefined ? 'Unnamed backup' : 'Primary account');
  const subtitleParts = [];
  if (account.userId) subtitleParts.push(`User ${account.userId}`);
  if (account.experienceId) subtitleParts.push(`Experience ${account.experienceId}`);
  if (account.isGroup && account.groupId) subtitleParts.push(`Group ${account.groupId}`);
  return {
    id: prefix,
    title,
    subtitle: subtitleParts.join(' · '),
    backupIndex,
    removable: Boolean(removable),
    fields: fieldsFromObject(account, prefix, POOL_ACCOUNT_FIELDS),
  };
}

function buildConfigGroups(config) {
  const groups = [];

  if (config.accountPool?.primary) {
    groups.push({
      id: 'accountPool.primary',
      title: 'Primary account',
      kind: 'primary',
      accounts: [poolAccountEntry(config.accountPool.primary, 'accountPool.primary')],
    });
  }

  const backups = config.accountPool?.backups || [];
  groups.push({
    id: 'accountPool.backups',
    title: 'Backup accounts',
    kind: 'backups',
    addable: true,
    emptyHint: 'No backup accounts yet. Add one below.',
    accounts: backups.map((account, index) =>
      poolAccountEntry(account, `accountPool.backups.${index}`, {
        backupIndex: index,
        removable: true,
      })
    ),
  });

  const assetAccounts = config.assetAccounts || [];
  if (assetAccounts.length) {
    groups.push({
      id: 'assetAccounts',
      title: 'Asset accounts',
      kind: 'assets',
      accounts: assetAccounts.map((account, index) => ({
        id: `assetAccounts.${index}`,
        title: account.name?.trim() || 'Unnamed asset account',
        subtitle: account.userId ? `User ${account.userId}` : '',
        fields: fieldsFromObject(account, `assetAccounts.${index}`, ASSET_ACCOUNT_FIELDS),
      })),
    });
  }

  if (config.creatorAccount && typeof config.creatorAccount === 'object') {
    groups.push({
      id: 'creatorAccount',
      title: 'Creator account (legacy)',
      kind: 'legacy',
      accounts: [
        {
          id: 'creatorAccount',
          title: config.creatorAccount.name?.trim() || 'Creator account',
          subtitle: config.creatorAccount.userId ? `User ${config.creatorAccount.userId}` : '',
          fields: fieldsFromObject(config.creatorAccount, 'creatorAccount', POOL_ACCOUNT_FIELDS),
        },
      ],
    });
  }

  return groups;
}

function buildConfigSections(config) {
  const sections = [];

  for (const { key, title } of SIMPLE_SECTIONS) {
    if (!config[key] || typeof config[key] !== 'object') {
      continue;
    }
    sections.push({
      id: key,
      title,
      fields: fieldsFromObject(config[key], key),
    });
  }

  if (config.experience) {
    const exp = config.experience;
    const experienceView = {
      ...exp,
      allowPrivateServers: exp.allowPrivateServers ?? true,
      privateServerPrice: exp.privateServerPrice ?? 0,
      playableDevices: Array.isArray(exp.playableDevices) && exp.playableDevices.length
        ? exp.playableDevices
        : ['Computer', 'Phone', 'Tablet', 'Console'],
      discordServerUrl: exp.discordServerUrl ?? 'https://discord.gg/N2mfmmNkta',
    };
    const fields = fieldsFromObject(experienceView, 'experience', EXPERIENCE_FIELDS);
    if (exp.places && typeof exp.places === 'object') {
      for (const [placeKey, placeValue] of Object.entries(exp.places)) {
        if (placeValue && typeof placeValue === 'object') {
          for (const [prop, propValue] of Object.entries(placeValue)) {
            fields.push(
              makeField(
                `experience.places.${placeKey}.${prop}`,
                `Place "${placeKey}" — ${humanizeLabel(prop)}`,
                propValue
              )
            );
          }
        }
      }
    }
    sections.push({
      id: 'experience',
      title: 'Experience',
      subtitle: exp.name || '',
      fields,
    });
  }

  if (config.monitor) {
    sections.push({
      id: 'monitor',
      title: 'Health monitor & Discord',
      fields: fieldsFromObject(config.monitor, 'monitor', MONITOR_FIELDS),
    });
  }

  const questionnaire = config.questionnaire || {};
  const questionnaireView = {
    enabled: questionnaire.enabled ?? false,
    required: questionnaire.required ?? false,
    fallbackQuestionnaireId: questionnaire.fallbackQuestionnaireId || '0ac4af75-ace3-f4ca-676d-8310b6473cef',
    questionIds: Array.isArray(questionnaire.questionIds) ? questionnaire.questionIds : [],
    answers: Array.isArray(questionnaire.answers) ? questionnaire.answers : [],
    answersByQuestionId: isPlainObject(questionnaire.answersByQuestionId) ? questionnaire.answersByQuestionId : {},
  };
  sections.push({
    id: 'questionnaire',
    title: 'Experience questionnaire',
    subtitle: 'Use actual question IDs and truthful answers from Roblox; do not guess answers.',
    fields: fieldsFromObject(questionnaireView, 'questionnaire', QUESTIONNAIRE_FIELDS),
  });

  // Always expose GitHub export fields, even when an older persistent
  // /data/config.json predates the placeIds.git object. Previously the UI
  // hid the fields entirely unless config.placeIds.git already existed.
  const placeIds = isPlainObject(config.placeIds) ? config.placeIds : {};
  const fields = fieldsFromObject(placeIds, 'placeIds', PLACE_IDS_FIELDS);
  const gitConfig = isPlainObject(placeIds.git) ? placeIds.git : {};
  const gitView = {
    enabled: gitConfig.enabled ?? true,
    required: gitConfig.required ?? false,
    repositoryPath: gitConfig.repositoryPath ?? '',
    remoteRawUrl: gitConfig.remoteRawUrl ?? 'https://raw.githubusercontent.com/z1onkurt999-star/PlaceIdsRepo/main/placeids.json',
    commitMessage: gitConfig.commitMessage ?? 'Update place IDs',
    githubOwner: gitConfig.githubOwner ?? 'z1onkurt999-star',
    githubRepo: gitConfig.githubRepo ?? 'PlaceIdsRepo',
    githubBranch: gitConfig.githubBranch ?? 'main',
    githubFilePath: gitConfig.githubFilePath ?? 'placeids.json',
  };
  fields.push(...fieldsFromObject(gitView, 'placeIds.git', PLACE_IDS_GIT_FIELDS));
  sections.push({
    id: 'placeIds',
    title: 'Place IDs export',
    fields,
  });

  if (config.gameIntegration) {
    sections.push({
      id: 'gameIntegration',
      title: 'Game integration (Luau / HttpService)',
      subtitle: 'Public URL embedded in downloadable ProductBridge.luau',
      fields: fieldsFromObject(config.gameIntegration, 'gameIntegration', GAME_INTEGRATION_FIELDS),
    });
  }

  return sections;
}

export function createBackupAccountTemplate(config) {
  const primary = config?.accountPool?.primary || {};
  return {
    name: '',
    experienceId: primary.experienceId ?? null,
    isGroup: Boolean(primary.isGroup),
    groupId: primary.groupId ?? null,
    groupOwnerUserId: primary.groupOwnerUserId ?? null,
    groupOwnerName: primary.groupOwnerName ?? '',
    groupOwnerCookie: '',
    userId: null,
    cookie: '',
    apiKey: '',
    groupApiKey: '',
  };
}

export function addBackupAccount({ template = 'blank' } = {}) {
  ensureConfigFile();
  const config = loadConfig();
  if (!config) {
    throw new Error(`Config file not found: ${getConfigPath()}`);
  }
  if (!config.accountPool) {
    config.accountPool = {};
  }
  if (!Array.isArray(config.accountPool.backups)) {
    config.accountPool.backups = [];
  }

  let backup;
  if (template === 'primary' && config.accountPool.primary) {
    backup = structuredClone(config.accountPool.primary);
    backup.name = backup.name ? `${backup.name} (backup)` : '';
    backup.cookie = '';
    backup.apiKey = '';
    backup.groupOwnerCookie = '';
    backup.groupApiKey = backup.groupApiKey ? '' : backup.groupApiKey;
  } else {
    backup = createBackupAccountTemplate(config);
  }

  config.accountPool.backups.push(backup);
  saveConfig(config);
  return {
    index: config.accountPool.backups.length - 1,
    config: getConfigFields(),
  };
}

export function removeBackupAccount(index) {
  ensureConfigFile();
  const config = loadConfig();
  if (!config?.accountPool?.backups) {
    throw new Error('No backup accounts configured');
  }
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= config.accountPool.backups.length) {
    throw new Error(`Invalid backup account index: ${index}`);
  }
  const removed = config.accountPool.backups.splice(idx, 1)[0];
  saveConfig(config);
  return {
    removed: removed?.name || `backup ${idx}`,
    config: getConfigFields(),
  };
}

import fs from 'fs';
import { createHash } from 'node:crypto';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import readline from 'readline/promises';
import { RobloxClient, RobloxOpenCloudClient, readBinaryFile } from '../src/shared/robloxClient.js';
import { requestJson, requestWithRetry } from '../src/shared/httpClient.js';
import { atomicWriteFile } from '../src/shared/atomicStore.js';
import { runTrackedOperation, getOperationLockHolder } from '../src/shared/operationRunner.js';
import { verifyExperienceState } from '../src/shared/robloxVerification.js';
import { setSystemStatus, SYSTEM_STATUS } from '../server/services/discordStatusManager.js';
import { DiscordClient } from '../server/services/discordClient.js';
import { grantAllPermissions, grantPermissionsForAccounts } from './permissions.js';
import {
  waitForEnterPrompt,
  registerBrowserSession,
  unregisterBrowserSession,
  createPromptInterface,
} from '../src/shared/promptBridge.js';
import { ensureExperienceIconFile, freshenImageFile } from '../src/shared/imageFreshness.js';
import { exportPlaceIds } from '../src/shared/placeIdsExport.js';
import { patchRbxlUploadStamp, shouldPatchRbxlUploadStamp } from './rbxlUploadPatch.js';

const PLACE_KEYS = ['Main', 'Battle', 'Trade'];
const execFileAsync = promisify(execFile);
let playwrightPromise = null;
let openCloudApiKeyHintLogged = false;

function coerceConfigBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  if (value === true || value === 'true' || value === 1 || value === '1') {
    return true;
  }

  if (value === false || value === 'false' || value === 0 || value === '0') {
    return false;
  }

  return defaultValue;
}

export function withPrimaryAccountApplied(config) {
  const pool = config.accountPool;
  if (!pool?.primary) {
    return config;
  }

  const primary = pool.primary;
  const next = structuredClone(config);
  const existingCreator = next.creatorAccount || {};
  const hasGroupCredentialFields =
    (primary.groupId !== undefined && primary.groupId !== null && String(primary.groupId).trim() !== '') ||
    Boolean(trimConfigSecret(primary.groupApiKey)) ||
    Boolean(trimConfigSecret(primary.groupOwnerCookie)) ||
    Boolean(trimConfigSecret(existingCreator.groupId)) ||
    Boolean(trimConfigSecret(existingCreator.groupApiKey)) ||
    Boolean(trimConfigSecret(existingCreator.groupOwnerCookie));
  const isGroup = coerceConfigBoolean(primary.isGroup, false) || hasGroupCredentialFields;
  const groupOwnerCookie =
    trimConfigSecret(primary.groupOwnerCookie) ||
    trimConfigSecret(existingCreator.groupOwnerCookie);
  const effectiveCookie = isGroup && groupOwnerCookie
    ? groupOwnerCookie
    : (primary.cookie || next.creatorAccount?.cookie);

  next.creatorAccount = {
    ...(next.creatorAccount || {}),
    name: primary.name || next.creatorAccount?.name || 'Primary Account',
    userId: primary.userId || next.creatorAccount?.userId,
    cookie: effectiveCookie,
    apiKey: primary.apiKey || next.creatorAccount?.apiKey,
    isGroup
  };

  if (isGroup) {
    if (primary.groupId !== undefined && primary.groupId !== null && String(primary.groupId).trim() !== '') {
      next.creatorAccount.groupId = primary.groupId;
    }
    if (primary.groupApiKey) {
      next.creatorAccount.groupApiKey = primary.groupApiKey;
    } else if (primary.apiKey) {
      // Existing group deployments sometimes stored the group Open Cloud key
      // in the generic apiKey field. Promote it to the explicit group field.
      next.creatorAccount.groupApiKey = primary.apiKey;
    }
    if (
      primary.groupOwnerUserId !== undefined &&
      primary.groupOwnerUserId !== null &&
      String(primary.groupOwnerUserId).trim() !== ''
    ) {
      next.creatorAccount.groupOwnerUserId = primary.groupOwnerUserId;
    }
    if (
      primary.groupOwnerCookie !== undefined &&
      primary.groupOwnerCookie != null &&
      String(primary.groupOwnerCookie).trim() !== ''
    ) {
      next.creatorAccount.groupOwnerCookie = primary.groupOwnerCookie;
    }
    if (
      primary.groupOwnerName !== undefined &&
      primary.groupOwnerName != null &&
      String(primary.groupOwnerName).trim() !== ''
    ) {
      next.creatorAccount.groupOwnerName = primary.groupOwnerName;
    }
  } else {
    delete next.creatorAccount.groupApiKey;
    delete next.creatorAccount.groupId;
    delete next.creatorAccount.groupOwnerUserId;
    delete next.creatorAccount.groupOwnerCookie;
    delete next.creatorAccount.groupOwnerName;
  }

  if (primary.experienceId) {
    next.experienceId = primary.experienceId;
  }
  return next;
}

function loadRawConfig(configPath) {
  return JSON.parse(fs.readFileSync(path.resolve(configPath), 'utf8'));
}

function stringifyConfigWithInlineAssetArrays(value, indent = 0) {
  const pad = '  '.repeat(indent);
  const nextPad = '  '.repeat(indent + 1);

  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const allFiniteNumbers = value.every((v) => typeof v === 'number' && Number.isFinite(v));
    if (allFiniteNumbers) {
      return `[${value.map((n) => String(n)).join(', ')}]`;
    }
    return `[\n${value.map((v) => `${nextPad}${stringifyConfigWithInlineAssetArrays(v, indent + 1)}`).join(',\n')}\n${pad}]`;
  }

  const entries = Object.entries(value || {});
  if (!entries.length) return '{}';

  const body = entries.map(([key, entryValue]) => {
    if ((key === 'audioAssets' || key === 'animationAssets') && Array.isArray(entryValue)) {
      const inline = entryValue.map((n) => JSON.stringify(n)).join(', ');
      return `${nextPad}${JSON.stringify(key)}: [${inline}]`;
    }
    return `${nextPad}${JSON.stringify(key)}: ${stringifyConfigWithInlineAssetArrays(entryValue, indent + 1)}`;
  }).join(',\n');

  return `{\n${body}\n${pad}}`;
}

const POOL_ACCOUNT_KEY_ORDER = [
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
  'groupApiKey'
];
const MONITOR_KEY_ORDER = [
  'healthUrl',
  'intervalMs',
  'retryCount',
  'retryDelayMs',
  'confirmDelayMs',
  'discordChannelId',
  'discordPlayerCountChannelId',
  'discordStatusChannelId',
  'discordScanPages',
  'discordDeleteAllMessagesInChannel',
  'discordBotToken',
  'discordLastGameLinkMessageId'
];

function orderPoolAccountObject(account) {
  if (!account || typeof account !== 'object' || Array.isArray(account)) {
    return account;
  }
  const next = {};
  for (const key of POOL_ACCOUNT_KEY_ORDER) {
    if (Object.prototype.hasOwnProperty.call(account, key)) {
      next[key] = account[key];
    }
  }
  for (const [key, value] of Object.entries(account)) {
    if (!POOL_ACCOUNT_KEY_ORDER.includes(key)) {
      next[key] = value;
    }
  }
  return next;
}

function normalizeAccountPoolKeyOrder(config) {
  const pool = config?.accountPool;
  if (!pool) {
    return;
  }
  if (pool.primary) {
    pool.primary = orderPoolAccountObject(pool.primary);
  }
  if (Array.isArray(pool.backups)) {
    pool.backups = pool.backups.map(orderPoolAccountObject);
  }
}

function normalizeMonitorKeyOrder(config) {
  const monitor = config?.monitor;
  if (!monitor || typeof monitor !== 'object' || Array.isArray(monitor)) {
    return;
  }

  const next = {};
  for (const key of MONITOR_KEY_ORDER) {
    if (Object.prototype.hasOwnProperty.call(monitor, key)) {
      next[key] = monitor[key];
    }
  }
  for (const [key, value] of Object.entries(monitor)) {
    if (!MONITOR_KEY_ORDER.includes(key)) {
      next[key] = value;
    }
  }
  config.monitor = next;
}

function saveRawConfig(configPath, config) {
  normalizeAccountPoolKeyOrder(config);
  normalizeMonitorKeyOrder(config);
  atomicWriteFile(path.resolve(configPath), `${stringifyConfigWithInlineAssetArrays(config)}\n`, { backup: true });
}

/** Re-read and write config.json using canonical formatting (inline numeric/asset arrays, pool key order). */
export function rewriteConfigJsonFile(configPath) {
  const resolved = path.resolve(configPath);
  const config = loadRawConfig(resolved);
  saveRawConfig(resolved, config);
}

function accountToGrantRow(config, account) {
  const defaults = config.accountPool?.sharedAssets || {};
  const fallback = (config.assetAccounts && config.assetAccounts[0]) || {};
  return {
    name: account.name,
    userId: account.userId,
    cookie: account.cookie,
    apiKey: account.apiKey,
    audioAssets: defaults.audioAssets || fallback.audioAssets || [],
    animationAssets: defaults.animationAssets || fallback.animationAssets || []
  };
}

function getRobloxCookieValue(cookie) {
  const value = String(cookie || '').trim();
  if (!value) {
    return '';
  }

  return value.startsWith('.ROBLOSECURITY=') ? value.slice('.ROBLOSECURITY='.length) : value;
}

function buildRobloxSecurityCookieEntry(robloxCookie) {
  return {
    name: '.ROBLOSECURITY',
    value: getRobloxCookieValue(robloxCookie),
    domain: '.roblox.com',
    path: '/',
    httpOnly: true,
    secure: true
  };
}

async function openRobloxPageFromHome(context, url) {
  const page = await context.newPage();
  await page.goto('https://www.roblox.com/home', { waitUntil: 'domcontentloaded' });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return page;
}

async function tryDismissRobloxCookieBanner(page) {
  try {
    const accept = page.getByRole('button', { name: /^(accept|agree|ok|continue)$/i }).first();
    await accept.waitFor({ state: 'visible', timeout: 2500 });
    await accept.click({ timeout: 2500 });
    await page.waitForTimeout(400);
  } catch {
    // no banner
  }
}

async function tryRobloxProfileConfirmModal(page) {
  const patterns = [/confirm/i, /^yes$/i, /^unfriend$/i, /remove friend/i, /^ok$/i];
  for (const pattern of patterns) {
    try {
      const btn = page.getByRole('button', { name: pattern }).first();
      await btn.waitFor({ state: 'visible', timeout: 2200 });
      await btn.click({ timeout: 2500 });
      await page.waitForTimeout(450);
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

async function tryRobloxProfileClickUnfriend(page) {
  await tryDismissRobloxCookieBanner(page);
  await page.waitForTimeout(700);

  const direct = [
    (p) => p.getByRole('button', { name: /^unfriend$/i }),
    (p) => p.getByRole('button', { name: /remove friend/i }),
    (p) => p.getByRole('link', { name: /unfriend|remove friend/i })
  ];

  for (const make of direct) {
    try {
      const el = make(page);
      await el.waitFor({ state: 'visible', timeout: 3500 });
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await el.click({ timeout: 4500 });
      await tryRobloxProfileConfirmModal(page);
      console.log('[INFO] Playwright auto-clicked Unfriend (direct control).');
      return true;
    } catch {
      // continue
    }
  }

  const menuTriggers = [
    (p) => p.locator('button[aria-label*="More" i]').first(),
    (p) => p.getByRole('button', { name: /more options|more actions/i }),
    (p) => p.locator('button[aria-haspopup="menu"]').first()
  ];

  for (const make of menuTriggers) {
    try {
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(200);
      const btn = make(page);
      await btn.waitFor({ state: 'visible', timeout: 4000 });
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click({ timeout: 4500 });
      await page.waitForTimeout(550);

      const menuItems = [
        (p) => p.getByRole('menuitem', { name: /^unfriend$/i }),
        (p) => p.getByRole('menuitem', { name: /unfriend|remove friend/i }),
        (p) => p.getByRole('button', { name: /^unfriend$/i }),
        (p) => p.locator('[role="menu"] button, [role="menuitem"]').filter({ hasText: /^Unfriend$/i }).first()
      ];

      for (const makeItem of menuItems) {
        try {
          const item = makeItem(page);
          await item.waitFor({ state: 'visible', timeout: 5000 });
          await item.click({ timeout: 4500 });
          await tryRobloxProfileConfirmModal(page);
          console.log('[INFO] Playwright auto-clicked Unfriend via overflow (⋯) menu.');
          return true;
        } catch {
          // next menu item selector
        }
      }
    } catch {
      // next trigger
    }
  }

  console.log('[INFO] Playwright could not auto-click Unfriend; use ⋯ then Unfriend manually if needed.');
  return false;
}

async function getPlaywright() {
  if (!playwrightPromise) {
    playwrightPromise = import('playwright');
  }

  return playwrightPromise;
}

function canAutoOpenBrowser() {
  return process.platform === 'win32';
}

function resolvePlaywrightHeadless() {
  return process.env.HEADLESS === '1' || process.env.HEADLESS === 'true';
}

function isRemoteServerRuntime() {
  return Boolean(process.env.RAILWAY_ENVIRONMENT) || (process.platform !== 'win32' && resolvePlaywrightHeadless());
}

function buildCreatorDashboardPermissionsUrl(universeId) {
  return `https://create.roblox.com/dashboard/creations/experiences/${encodeURIComponent(String(universeId))}/permissions`;
}

async function launchAutomationBrowser(meta = {}) {
  const { chromium } = await getPlaywright();
  const browser = await chromium.launch({
    headless: resolvePlaywrightHeadless(),
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  if (meta.registerSession !== false) {
    const sessionId = `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    registerBrowserSession(sessionId, browser, meta);
    browser.on('disconnected', () => unregisterBrowserSession(sessionId));
  }

  return browser;
}

/**
 * Windows: run `cmd /c start …` without waiting for cmd to exit. `execFile` on
 * `start chrome …` can leave cmd (or the shell chain) wedged so Node never reaches
 * the configure/upload step; detached spawn + unref avoids that.
 */
function windowsFireAndForgetStart(startArgv) {
  return new Promise((resolve) => {
    const child = spawn('cmd', ['/c', 'start', ...startArgv], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });

    const finish = (ok) => {
      child.removeAllListeners();
      try {
        child.unref();
      } catch {
        // ignore
      }
      resolve(ok);
    };

    child.once('spawn', () => finish(true));
    child.once('error', (err) => {
      console.log(`[WARN] Browser launch failed: ${err.message}`);
      finish(false);
    });
  });
}

async function openUrlInBrowser(url) {
  if (!canAutoOpenBrowser()) {
    return false;
  }

  return windowsFireAndForgetStart(['', url]);
}

async function openUrlInChrome(url) {
  if (process.platform !== 'win32') {
    return openUrlInBrowser(url);
  }

  const chromeLaunched = await windowsFireAndForgetStart(['chrome', url]);
  if (chromeLaunched) {
    return true;
  }

  return windowsFireAndForgetStart(['', url]);
}

/**
 * Launches a visible Chromium window with `.ROBLOSECURITY` applied, then opens `urlToOpen`.
 * @returns {{ browser: import('playwright').Browser, page: import('playwright').Page } | null}
 */
async function createRobloxPlaywrightSession(robloxCookie, urlToOpen) {
  if (!urlToOpen || !robloxCookie) {
    return null;
  }

  try {
    const browser = await launchAutomationBrowser({ urlToOpen, label: 'roblox-session', registerSession: false });
    const sessionId = `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    registerBrowserSession(sessionId, browser, { urlToOpen });
    browser.on('disconnected', () => unregisterBrowserSession(sessionId));
    const context = await browser.newContext();
    await context.addCookies([buildRobloxSecurityCookieEntry(robloxCookie)]);
    const page = await openRobloxPageFromHome(context, urlToOpen);
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    return { browser, page };
  } catch (err) {
    console.log(`[WARN] Could not start Playwright Roblox session: ${err.message}`);
    return null;
  }
}

async function openChallengeBrowserWithAccount(accountLabel, robloxCookie, urlToOpen) {
  const session = await createRobloxPlaywrightSession(robloxCookie, urlToOpen);
  if (!session) {
    return null;
  }

  const { browser } = session;
  // Do not auto-click "Add Friend" here: programmatic clicks often trigger Roblox 2FA / risk
  // flows that still fail ("unable to send"), while a normal manual click in this tab usually does not.
  console.log(
    '[INFO] Use Add Friend manually in this tab if the API step failed (automation will not click it).'
  );
  console.log(`[ACTION REQUIRED] Opened Roblox challenge window for ${accountLabel}.`);
  return browser;
}

async function waitForManualChallengeResolution(message, challengeContext) {
  const { urlToOpen, accountLabel, robloxCookie } = challengeContext || {};
  console.log(`[ACTION REQUIRED] ${message}`);
  let challengeBrowser = await openChallengeBrowserWithAccount(accountLabel || 'Roblox account', robloxCookie, urlToOpen);

  if (!challengeBrowser && urlToOpen) {
    try {
      const opened = await openUrlInBrowser(urlToOpen);
      if (opened) {
        console.log(`[ACTION REQUIRED] Opened browser to: ${urlToOpen}`);
      } else {
        console.log(`[ACTION REQUIRED] Open this URL manually: ${urlToOpen}`);
      }
    } catch {
      console.log(`[ACTION REQUIRED] Failed to auto-open browser. Open this URL manually: ${urlToOpen}`);
    }
  }

  if (urlToOpen) {
    console.log(`[ACTION REQUIRED] Complete the challenge/action at: ${urlToOpen}`);
  } else {
    console.log('[ACTION REQUIRED] No specific challenge URL was provided.');
  }
  console.log('[ACTION REQUIRED] Complete the required friend-request action/challenge, then press Enter to retry...');

  try {
    await waitForEnterPrompt('[ACTION REQUIRED] Continue after completing the challenge.', {
      url: urlToOpen,
      accountLabel,
    });
  } finally {
    if (challengeBrowser) {
      await challengeBrowser.close();
      challengeBrowser = null;
    }
  }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until the user closes the Playwright session **or** we detect they are no longer
 * friends with `friendTargetUserId` (same friends API as the add-friend flow). Also runs a
 * debounced friendship check on `framenavigated` so a post-click profile refresh resolves quickly.
 */
function waitUntilUnfriendSessionEnds(browser, context, page, friendshipPoll = null) {
  return new Promise((resolve) => {
    if (!browser || !context || !page) {
      resolve();
      return;
    }

    let settled = false;
    const pollMs = 400;
    let friendshipPollTimer = null;
    let friendshipDebounceTimer = null;
    let sawFriendsState = false;
    let consecutiveNotFriends = 0;

    const clearFriendshipTimers = () => {
      if (friendshipPollTimer) {
        clearInterval(friendshipPollTimer);
        friendshipPollTimer = null;
      }
      if (friendshipDebounceTimer) {
        clearTimeout(friendshipDebounceTimer);
        friendshipDebounceTimer = null;
      }
    };

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(pollTimer);
      clearFriendshipTimers();
      try {
        browser.removeListener('disconnected', onBrowserDisconnected);
      } catch {
        // ignore
      }
      try {
        context.removeListener('close', onContextClose);
      } catch {
        // ignore
      }
      try {
        page.removeListener('close', onPageClose);
      } catch {
        // ignore
      }
      try {
        page.removeListener('framenavigated', onFrameNavigated);
      } catch {
        // ignore
      }
      resolve();
    };

    async function checkFriendshipEnded(reason) {
      if (settled || !friendshipPoll) {
        return;
      }
      const { assetCookie, assetUserId, friendTargetUserId, assetLabel } = friendshipPoll;
      if (!assetCookie || !assetUserId || !friendTargetUserId) {
        return;
      }
      try {
        const assetClient = new RobloxClient(assetCookie, assetLabel || 'asset');
        const status = await getFriendshipStatus(assetClient, assetUserId, friendTargetUserId);
        if (status === 'Friends') {
          sawFriendsState = true;
          consecutiveNotFriends = 0;
          return;
        }
        if (typeof status === 'string') {
          consecutiveNotFriends += 1;
        }
        if (sawFriendsState) {
          console.log(
            `[SUCCESS] Unfriend detected (${reason}): ${assetLabel || 'asset'} ↔ user ${friendTargetUserId} is no longer Friends (status: ${status || 'none'}).`
          );
          finish();
          return;
        }
        if (consecutiveNotFriends >= 5) {
          console.log(
            `[INFO] Friendship poll: never saw Friends with user ${friendTargetUserId} (last status: ${status || 'none'}); continuing — close the window if you still need to unfriend manually.`
          );
          finish();
        }
      } catch {
        // Roblox may rate-limit or hiccup; keep waiting for close or next poll
      }
    }

    function onFrameNavigated() {
      if (!friendshipPoll || settled) {
        return;
      }
      if (friendshipDebounceTimer) {
        clearTimeout(friendshipDebounceTimer);
      }
      friendshipDebounceTimer = setTimeout(() => {
        friendshipDebounceTimer = null;
        void checkFriendshipEnded('profile navigation / refresh');
      }, 650);
    }

    function onBrowserDisconnected() {
      finish();
    }

    function onContextClose() {
      finish();
    }

    function onPageClose() {
      finish();
    }

    browser.on('disconnected', onBrowserDisconnected);
    context.on('close', onContextClose);
    page.on('close', onPageClose);

    const pollTimer = setInterval(() => {
      try {
        if (typeof browser.isConnected === 'function' && !browser.isConnected()) {
          finish();
          return;
        }
      } catch {
        finish();
        return;
      }

      try {
        if (page.isClosed()) {
          finish();
          return;
        }
      } catch {
        finish();
        return;
      }

      try {
        if (context.pages().length === 0) {
          finish();
        }
      } catch {
        finish();
      }
    }, pollMs);

    if (friendshipPoll?.assetCookie && friendshipPoll?.assetUserId && friendshipPoll?.friendTargetUserId) {
      page.on('framenavigated', onFrameNavigated);
      friendshipPollTimer = setInterval(() => {
        void checkFriendshipEnded('periodic poll');
      }, 2200);
      void checkFriendshipEnded('initial');
    }
  });
}

async function waitForFriendshipStatus(viewClient, sourceUserId, targetUserId, expectedStatuses, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await getFriendshipStatus(viewClient, sourceUserId, targetUserId);
    if (expectedStatuses.includes(status)) {
      return status;
    }
    await sleep(2000);
  }

  const lastStatus = await getFriendshipStatus(viewClient, sourceUserId, targetUserId);
  return lastStatus;
}

async function runWithChallengeRetries(action, promptMessage, challengeContext, maxRetries = 3) {
  let attempt = 0;

  while (true) {
    try {
      return await action();
    } catch (err) {
      if (!isRobloxChallengeRequired(err) || attempt >= maxRetries) {
        throw err;
      }

      attempt += 1;
      await waitForManualChallengeResolution(`${promptMessage} (attempt ${attempt} of ${maxRetries})`, challengeContext);
    }
  }
}

function requireValue(value, name) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`Missing required config value: ${name}`);
  }

  return value;
}

function isRobloxChallengeRequired(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  const m = error.message;
  if (m.includes('Challenge is required to authorize the request')) {
    return true;
  }
  // Friends API sometimes returns a 403 challenge body without that exact phrase.
  if (m.includes('friends.roblox.com') && /\b403\b/.test(m) && /challenge/i.test(m)) {
    return true;
  }
  return false;
}

function isRobloxInvalidPlaceCreate(error) {
  return error instanceof Error && error.message.includes('"isValid":false');
}

function isRobloxNotFound(error) {
  return error instanceof Error && error.message.includes('404 Not Found');
}

function isRobloxUnauthorized(error) {
  return error instanceof Error && error.message.includes('403 Forbidden');
}

function isMissingOpenCloudApiKey(error) {
  return error instanceof Error && error.message.includes('Open Cloud API key for place publishing');
}

function isOpenCloudInsufficientScopes(status, bodyText) {
  if (status !== 401 && status !== 403) {
    return false;
  }

  const body = String(bodyText || '').toLowerCase();
  return (
    body.includes('insufficient scopes') ||
    body.includes('insufficient scope') ||
    body.includes('resources not authorized') ||
    body.includes('mission_denied') ||
    (body.includes('unauthorized') && body.includes('scope'))
  );
}

function openCloudPlacePublishScopeSetupHint(config) {
  const universeId = config.experienceId || config.accountPool?.primary?.experienceId || '(your universe id)';
  if (isGroupOpenCloudModeEnabled(config)) {
    return (
      'Create or update a **group** Open Cloud API key (Creator Dashboard → your group → Credentials → API Keys): ' +
      'add **Universe Places** access with **Write**, scoped to this experience. ' +
      'Set it as `accountPool.primary.groupApiKey` (or `apiKey` as fallback). ' +
      `Universe id: ${universeId}.`
    );
  }

  return (
    'Create or update a **user** Open Cloud API key (Creator Dashboard → Credentials → API Keys, not a group key): ' +
    'add **Universe Places** access with **Write**, and allow this experience (or disable “Restrict by experience”). ' +
    'Set it as `accountPool.primary.apiKey`. ' +
    'Keys used only for asset `Use` grants do **not** include place publish. ' +
    `Universe id: ${universeId}.`
  );
}

function describeOpenCloudKeySource(config, placeKey) {
  const placeConfig = config.experience?.places?.[placeKey];
  if (placeConfig?.apiKey && trimConfigSecret(placeConfig.apiKey)) {
    return `experience.places.${placeKey}.apiKey`;
  }
  if (placeConfig?.groupApiKey && trimConfigSecret(placeConfig.groupApiKey)) {
    return `experience.places.${placeKey}.groupApiKey`;
  }

  if (isGroupOpenCloudModeEnabled(config)) {
    if (resolveGroupOpenCloudApiKey(config, placeKey)) {
      return 'accountPool.primary.groupApiKey (group mode)';
    }
    if (resolveUserOpenCloudApiKey(config, placeKey)) {
      return 'accountPool.primary.apiKey (group mode fallback)';
    }
    return 'none';
  }

  if (resolveUserOpenCloudApiKey(config, placeKey)) {
    return 'accountPool.primary.apiKey (user-owned experience)';
  }
  if (resolveGroupOpenCloudApiKey(config, placeKey)) {
    return 'accountPool.primary.groupApiKey (ignored for RBXL when isGroup is false — set apiKey instead)';
  }

  return 'none';
}

function isOpenCloudPlacePublishRetryable(status, bodyText) {
  if (status === 429 || status === 408) {
    return true;
  }

  if (status >= 500 && status < 600) {
    return true;
  }

  if (status === 400) {
    const body = String(bodyText || '').toLowerCase();
    // Roblox/Open Cloud occasionally returns HTML 400 "invalid request" pages for transient
    // edge/proxy hiccups even when the same publish payload succeeds on retry.
    if (
      body.includes('<html') &&
      (body.includes('bad request') || body.includes('invalid request'))
    ) {
      return true;
    }
  }

  if (status !== 409) {
    return false;
  }

  const body = String(bodyText || '').toLowerCase();
  return (
    body.includes('busy') ||
    body.includes('try again') ||
    body.includes('unable to process') ||
    body.includes('server is busy')
  );
}

function openCloudPlacePublishBackoffMs(attemptIndex) {
  const base = Math.min(120_000, 20_000 * 2 ** attemptIndex);
  return base + Math.floor(Math.random() * 5000);
}

function resolveCookie(account, name) {
  return account.cookie;
}

function trimConfigSecret(value) {
  if (value == null) {
    return '';
  }
  if (typeof value !== 'string') {
    return String(value).trim();
  }
  return value.trim();
}

function isGroupOpenCloudModeEnabled(config) {
  const primary = config.accountPool?.primary;
  const inferredFromGroupFields =
    Boolean(trimConfigSecret(primary?.groupId)) ||
    Boolean(trimConfigSecret(primary?.groupApiKey)) ||
    Boolean(trimConfigSecret(primary?.groupOwnerCookie)) ||
    Boolean(trimConfigSecret(config.creatorAccount?.groupId)) ||
    Boolean(trimConfigSecret(config.creatorAccount?.groupApiKey)) ||
    Boolean(trimConfigSecret(config.creatorAccount?.groupOwnerCookie)) ||
    Boolean(trimConfigSecret(config.experience?.groupId)) ||
    Boolean(trimConfigSecret(config.experience?.groupApiKey)) ||
    Boolean(trimConfigSecret(config.groupId)) ||
    Boolean(trimConfigSecret(config.groupApiKey));

  return (
    coerceConfigBoolean(primary?.isGroup, false) ||
    coerceConfigBoolean(config.creatorAccount?.isGroup, false) ||
    coerceConfigBoolean(config.experience?.isGroup, false) ||
    coerceConfigBoolean(config.isGroup, false) ||
    inferredFromGroupFields
  );
}

/** `.ROBLOSECURITY` for the Roblox account that can change group ranks (usually the group owner). */
function resolveGroupOwnerCookie(config) {
  const c = trimConfigSecret(config.creatorAccount?.groupOwnerCookie);
  return c ? String(config.creatorAccount.groupOwnerCookie).trim() : '';
}

function resolveGroupOwnerRankLabel(config) {
  const n = trimConfigSecret(config.creatorAccount?.groupOwnerName);
  return n || 'group owner';
}

/** Numeric Roblox group id for dashboard URLs and logging (optional when using group Open Cloud). */
function resolveExperienceGroupId(config) {
  const candidates = [
    config.accountPool?.primary?.groupId,
    config.creatorAccount?.groupId,
    config.experience?.groupId,
    config.groupId
  ];
  for (const c of candidates) {
    const t = trimConfigSecret(c);
    if (t && /^\d+$/.test(t)) {
      return t;
    }
  }
  return '';
}

function resolveUserOpenCloudApiKey(config, placeKey) {
  const placeConfig = config.experience?.places?.[placeKey];
  const keys = [placeConfig?.apiKey, config.accountPool?.primary?.apiKey, config.creatorAccount?.apiKey];
  for (const k of keys) {
    const t = trimConfigSecret(k);
    if (t) {
      return t;
    }
  }
  return '';
}

function resolveGroupOpenCloudApiKey(config, placeKey) {
  const placeConfig = config.experience?.places?.[placeKey];
  const keys = [
    placeConfig?.groupApiKey,
    config.accountPool?.primary?.groupApiKey,
    config.creatorAccount?.groupApiKey,
    config.experience?.groupApiKey,
    config.groupApiKey,
    // Some existing deployments store the group Open Cloud key in the generic
    // `apiKey` field. In group mode, accept that as the group key as well.
    config.accountPool?.primary?.apiKey,
    config.creatorAccount?.apiKey
  ];
  for (const k of keys) {
    const t = trimConfigSecret(k);
    if (t) {
      return t;
    }
  }
  return '';
}

/**
 * Open Cloud key for place publish and universe PATCH (devices / voice).
 * When isGroup is enabled, prefers groupApiKey (Creator Dashboard → group → Open Cloud) then falls back to apiKey.
 */
function resolveApiKey(config, placeKey) {
  if (isGroupOpenCloudModeEnabled(config)) {
    const groupKey = resolveGroupOpenCloudApiKey(config, placeKey);
    if (groupKey) {
      return groupKey;
    }
    return resolveUserOpenCloudApiKey(config, placeKey) || undefined;
  }

  // User-owned experiences: only the personal apiKey can publish places (groupApiKey is group-scoped).
  return resolveUserOpenCloudApiKey(config, placeKey) || undefined;
}

function logOpenCloudApiKeyHintIfMissing(config) {
  if (openCloudApiKeyHintLogged || resolveApiKey(config, 'Main')) {
    return;
  }

  openCloudApiKeyHintLogged = true;
  const groupHint = isGroupOpenCloudModeEnabled(config)
    ? 'For group-owned experiences set accountPool.primary.groupApiKey (Universe Places → Write). '
    : 'For user-owned experiences set accountPool.primary.apiKey (Universe Places → Write on your account API key). ';
  console.log(
    '[INFO] No Open Cloud API key found. ' +
      groupHint +
      '(Optional: experience.places.<PlaceName>.apiKey). ' +
      'Without it: RBXL publish, Open Cloud universe device/mic PATCH, and some publish.roblox.com media routes are skipped.'
  );
}

function normalizePositiveId(value, name) {
  const normalized = normalizeUserId(value, name);
  if (normalized === '0') {
    throw new Error(`Invalid ${name}; expected a positive Roblox ID but received "0"`);
  }

  return normalized;
}

function buildStudioEditPlaceUrl(placeId) {
  const normalizedPlaceId = normalizePositiveId(placeId, 'Main place id');
  return `roblox-studio://launchmode/:edit+task:EditPlace+placeId:${normalizedPlaceId}`;
}

function resolveStudioExecutablePath(config) {
  const sl = config.studioLaunch;
  if (!sl || sl.enabled === false) {
    return '';
  }

  if (sl.studioPath && String(sl.studioPath).trim()) {
    return String(sl.studioPath).trim();
  }

  return '';
}

function windowsLaunchStudioEditPlace(studioPath, universeIdStr, placeIdStr) {
  if (process.platform !== 'win32') {
    return Promise.resolve(false);
  }

  return windowsFireAndForgetStart([
    '',
    studioPath,
    '-startEvent',
    'www.roblox.com/robloxQTStudioStartedEvent',
    '-task',
    'EditPlace',
    '-universeId',
    universeIdStr,
    '-placeId',
    placeIdStr
  ]);
}

async function tryOpenRobloxStudioForEdit(config, experienceId, mainPlaceId) {
  const studioUrl = buildStudioEditPlaceUrl(mainPlaceId);
  const universeIdStr = normalizeUserId(experienceId, 'experienceId');
  const placeIdStr = normalizeUserId(mainPlaceId, 'Main place id');

  const studioPath = resolveStudioExecutablePath(config);
  if (studioPath && canAutoOpenBrowser()) {
    const ok = await windowsLaunchStudioEditPlace(studioPath, universeIdStr, placeIdStr);
    if (ok) {
      return { method: 'cli', studioPath, universeIdStr, placeIdStr, studioUrl };
    }

    console.log('[WARN] studioLaunch did not start Studio (spawn failed); trying roblox-studio:// fallback.');
  }

  try {
    const opened = await openUrlInBrowser(studioUrl);
    return { method: 'protocol', opened, studioUrl };
  } catch {
    return { method: 'protocol', opened: false, studioUrl };
  }
}

async function getAuthenticatedUser(client) {
  return client.get('https://users.roblox.com/v1/users/authenticated');
}

async function resolveCreatorUserId(creatorAccount, creatorClient) {
  if (creatorAccount?.userId !== undefined && creatorAccount?.userId !== null && String(creatorAccount.userId).trim() !== '') {
    return normalizeUserId(creatorAccount.userId, `${creatorAccount.name || 'creator account'}.userId`);
  }
  const creatorUser = await getAuthenticatedUser(creatorClient);
  return normalizeUserId(creatorUser.id, `${creatorAccount.name || 'creator account'}.id`);
}

function normalizeUserId(value, name) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`Invalid ${name}; expected a numeric Roblox user ID but received "${value}"`);
  }

  return normalized;
}

async function getFriendshipStatus(client, sourceUserId, targetUserId) {
  const sourceId = normalizeUserId(sourceUserId, 'source user ID');
  const targetId = normalizeUserId(targetUserId, 'target user ID');
  const query = new URLSearchParams();
  query.append('userIds', targetId);

  const response = await readRobloxJsonResponse(
    client,
    `https://friends.roblox.com/v1/users/${sourceId}/friends/statuses?${query.toString()}`
  );
  return response?.data?.find((status) => String(status.id) === targetId)?.status;
}

async function sendFriendRequest(client, targetUserId) {
  const targetId = normalizeUserId(targetUserId, 'target user ID');
  return client.post(`https://friends.roblox.com/v1/users/${targetId}/request-friendship`, {});
}

async function acceptFriendRequest(client, requesterUserId) {
  const requesterId = normalizeUserId(requesterUserId, 'requester user ID');
  return client.post(`https://friends.roblox.com/v1/users/${requesterId}/accept-friend-request`, {});
}

async function readRobloxJsonResponse(client, url, options = {}) {
  const response = await client.get(url, options);

  // RobloxClient.get() returns a native Response. Some older tests/mocks return
  // the decoded object directly, so keep both forms compatible.
  if (response && typeof response.json === 'function') {
    return response.json();
  }
  return response;
}

export async function getUniversePlaces(client, universeId) {
  return readRobloxJsonResponse(
    client,
    `https://develop.roblox.com/v1/universes/${universeId}/places?sortOrder=Asc&limit=100`
  );
}

export async function getUniversePermissions(client, universeId) {
  const query = new URLSearchParams();
  query.append('ids', String(universeId));
  const response = await readRobloxJsonResponse(
    client,
    `https://develop.roblox.com/v1/universes/multiget/permissions?${query.toString()}`
  );
  return response?.data?.[0] ?? null;
}

export async function getUniverseDetails(client, universeId) {
  const query = new URLSearchParams();
  query.append('universeIds', String(universeId));
  const response = await readRobloxJsonResponse(
    client,
    `https://games.roblox.com/v1/games?${query.toString()}`
  );
  return response?.data?.[0] || null;
}

export async function getUniverseMainPlaceId(client, universeId) {
  const details = await getUniverseDetails(client, universeId);
  return details?.rootPlaceId ?? null;
}

function applyDetectedGroupOwnership(config, universeDetails) {
  const creatorType = String(universeDetails?.creator?.type || '').trim().toLowerCase();
  const creatorId = universeDetails?.creator?.id;
  if (creatorType !== 'group') {
    return false;
  }

  config.creatorAccount = config.creatorAccount || {};
  config.creatorAccount.isGroup = true;

  if (
    (config.creatorAccount.groupId === undefined ||
      config.creatorAccount.groupId === null ||
      String(config.creatorAccount.groupId).trim() === '') &&
    creatorId !== undefined &&
    creatorId !== null &&
    String(creatorId).trim() !== ''
  ) {
    config.creatorAccount.groupId = creatorId;
  }

  if (
    (config.experience?.groupId === undefined ||
      config.experience?.groupId === null ||
      String(config.experience.groupId).trim() === '') &&
    creatorId !== undefined &&
    creatorId !== null &&
    String(creatorId).trim() !== ''
  ) {
    config.experience = config.experience || {};
    config.experience.groupId = creatorId;
  }

  return true;
}

async function resolveMainPlaceIdForStudioShortcut(client, config, universeId) {
  try {
    const rootId = await getUniverseMainPlaceId(client, universeId);
    if (rootId == null || rootId === '') {
      return null;
    }

    return normalizePositiveId(rootId, 'universe root place id');
  } catch {
    return null;
  }
}

async function createPlace(client, universeId, templatePlaceId) {
  const params = new URLSearchParams({
    templatePlaceIdToUse: String(templatePlaceId),
    universeId: String(universeId)
  });

  return client.post(`https://www.roblox.com/ide/places/createV2?${params}`, {});
}

async function configureUniverseCloudSettings(universeId, experience, apiKey) {
  if (!apiKey) {
    return false;
  }

  const voiceOn = experience.enableMicrophone !== false;
  const configuredDevices = Array.isArray(experience.playableDevices) && experience.playableDevices.length
    ? experience.playableDevices
    : ['Computer', 'Phone', 'Tablet', 'Console'];
  const normalizedDevices = new Set(configuredDevices.map((device) => String(device).trim().toLowerCase()));
  const hasDevice = (...names) => names.some((name) => normalizedDevices.has(name));
  const body = {
    desktopEnabled: hasDevice('computer', 'desktop', 'pc', '1'),
    mobileEnabled: hasDevice('phone', 'mobile', '2'),
    tabletEnabled: hasDevice('tablet', '3'),
    consoleEnabled: hasDevice('console', 'xbox', 'playstation', '4'),
    vrEnabled: hasDevice('vr', 'virtual reality', 'virtualreality', '5'),
  };

  const masks = ['desktopEnabled', 'mobileEnabled', 'tabletEnabled', 'consoleEnabled', 'vrEnabled'];
  if (voiceOn) {
    body.voiceChatEnabled = true;
    masks.push('voiceChatEnabled');
  }

  const query = new URLSearchParams();
  query.append('updateMask', [...new Set(masks)].join(','));

  const openCloud = new RobloxOpenCloudClient(apiKey, 'Roblox universe configuration');
  await openCloud.request(`https://apis.roblox.com/cloud/v2/universes/${universeId}?${query.toString()}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 120_000,
    operation: `configure universe ${universeId}`
  });
  return true;
}

const VALID_SOCIAL_SLOT_TYPES = new Set(['Automatic', 'Empty', 'Custom']);

function resolveSocialSlotType(experience, placeKey) {
  const placeSlot = experience?.places?.[placeKey]?.socialSlotType;
  const expSlot = experience?.socialSlotType;
  for (const value of [placeSlot, expSlot]) {
    if (VALID_SOCIAL_SLOT_TYPES.has(value)) {
      return value;
    }
  }

  return 'Empty';
}

function buildExperienceAccessDashboardUrl(universeId) {
  return `https://create.roblox.com/dashboard/creations/experiences/${encodeURIComponent(String(universeId))}/access`;
}

function shouldConfigureFullyOpenPlaceAccess(experience) {
  const mode = experience?.placeAccessControl;
  if (mode === false || mode === 'skip' || mode === 'Skip' || mode === 'manual' || mode === 'Manual') {
    return false;
  }

  return true;
}

/**
 * Creator Dashboard Save click (icon upload, access settings, etc.).
 * @returns {{ skipped: boolean }} `skipped: true` when Save stays disabled (no pending changes).
 */
async function tryClickCreatorDashboardSaveButton(page, { testId = '' } = {}) {
  const saveButton = testId
    ? page.getByTestId(testId).first()
    : page.getByRole('button', { name: /save|publish|apply|confirm/i }).first();
  if (!(await saveButton.count())) {
    throw new Error('Could not find Save/Publish button on Creator Dashboard page.');
  }

  try {
    await saveButton.waitFor({ state: 'visible', timeout: 10000 });
  } catch {
    // continue; click may still work
  }
  await page.waitForTimeout(800);

  if (await saveButton.isDisabled()) {
    return { skipped: true };
  }

  await saveButton.click({ timeout: 8000 });
  await page.waitForTimeout(5000);
  return { skipped: false };
}

async function tryConfigureFullyOpenPlaceAccessViaDashboard(robloxCookie, universeId) {
  if (!robloxCookie) {
    return false;
  }

  const accessUrl = buildExperienceAccessDashboardUrl(universeId);
  let browser;
  try {
    browser = await launchAutomationBrowser({ label: 'place-access' });
    const context = await browser.newContext();
    await context.addCookies([buildRobloxSecurityCookieEntry(robloxCookie)]);
    const page = await context.newPage();

    await page.goto(accessUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await tryDismissRobloxCookieBanner(page);
    await page.getByText('Access Control for Places').waitFor({ state: 'visible', timeout: 90000 });

    const fullyOpenRadio = page.getByRole('radio', { name: /^fully open$/i });
    await fullyOpenRadio.waitFor({ state: 'visible', timeout: 30000 });
    await fullyOpenRadio.scrollIntoViewIfNeeded();

    const alreadyFullyOpen = await fullyOpenRadio.isChecked().catch(() => false);
    if (!alreadyFullyOpen) {
      await fullyOpenRadio.click({ timeout: 15000 });
      await page.waitForTimeout(1200);
    }

    const saveResult = await tryClickCreatorDashboardSaveButton(page, {
      testId: 'save-experience-access-button'
    });

    if (saveResult.skipped) {
      if (await fullyOpenRadio.isChecked().catch(() => false)) {
        console.log('[INFO] Access Control for Places is already **Fully Open** (Save disabled — no changes needed).');
        await page.waitForTimeout(1500);
      } else {
        const secureRadio = page.getByRole('radio', { name: /secure within universe only/i });
        if (await secureRadio.count()) {
          await secureRadio.click({ timeout: 10000 });
          await page.waitForTimeout(600);
          await fullyOpenRadio.click({ timeout: 15000 });
          await page.waitForTimeout(1200);
          const retrySave = await tryClickCreatorDashboardSaveButton(page, {
            testId: 'save-experience-access-button'
          });
          if (retrySave.skipped) {
            throw new Error('Save stayed disabled after selecting Fully Open.');
          }
        } else {
          throw new Error('Could not enable Save after selecting Fully Open.');
        }
      }
    }

    await page.close().catch(() => {});
    await browser.close();
    browser = null;
    console.log(`[SUCCESS] Access Control for Places set to **Fully Open** via Creator Dashboard (${accessUrl}).`);
    return true;
  } catch (err) {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // ignore
      }
    }
    console.log(`[WARN] Creator Dashboard Fully Open access setup failed: ${err.message}`);
    return false;
  }
}

async function configureExperiencePlaceAccessControl(config, universeId) {
  const experience = config.experience || {};
  if (!shouldConfigureFullyOpenPlaceAccess(experience)) {
    return;
  }

  const accessUrl = buildExperienceAccessDashboardUrl(universeId);
  const creatorAccount = requireValue(config.creatorAccount, 'creatorAccount');
  const creatorCookie = resolveCookie(creatorAccount, 'creatorAccount');

  if (!creatorCookie) {
    console.log(
      `[WARN] No creator cookie; set **Access Control for Places** to **Fully Open** manually:\n    ${accessUrl}`
    );
    return;
  }

  const ok = await tryConfigureFullyOpenPlaceAccessViaDashboard(creatorCookie, universeId);
  if (!ok) {
    console.log(`[WARN] Set **Fully Open** manually if needed:\n    ${accessUrl}`);
  }
}

async function configurePlace(client, placeId, config) {
  return client.patch(`https://develop.roblox.com/v2/places/${placeId}`, {
    name: config.name,
    maxPlayerCount: config.maxPlayers,
    allowCopying: config.allowCopying === true,
    socialSlotType: config.socialSlotType || 'Empty'
  });
}

function resolveQuestionnaireSettings(config) {
  const q = config?.questionnaire || {};
  const explicitQuestionIds = q.questionIds ?? config?.questionnaireQuestionIds;
  const explicitAnswers = q.answers ?? config?.questionnaireAnswers;
  const byQuestionId = q.answersByQuestionId || {};

  const questionIds = Array.isArray(explicitQuestionIds)
    ? explicitQuestionIds.map((v) => String(v).trim()).filter((v) => v && !/^<[^>]+>$/.test(v) && !/^QUESTION_ID_/i.test(v))
    : [];

  let answers = Array.isArray(explicitAnswers) ? [...explicitAnswers] : [];
  if (!answers.length && questionIds.length && byQuestionId && typeof byQuestionId === 'object') {
    answers = questionIds.map((id) => byQuestionId[id]);
  }

  const enabled = q.enabled !== undefined
    ? coerceConfigBoolean(q.enabled, false)
    : (config?.runQuestionnaire !== undefined
      ? coerceConfigBoolean(config.runQuestionnaire, false)
      : Boolean(questionIds.length || answers.length || Object.keys(byQuestionId).length));

  return {
    enabled,
    required: coerceConfigBoolean(q.required, false),
    fallbackQuestionnaireId: String(
      q.fallbackQuestionnaireId ||
      config?.fallbackQuestionnaireId ||
      '0ac4af75-ace3-f4ca-676d-8310b6473cef'
    ).trim(),
    questionIds,
    answers,
    byQuestionId
  };
}

function normalizeQuestionnaireAnswer(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || /^<[^>]+>$/.test(trimmed) || /^(?:ANSWER_VALUE_|QUESTION_ID_)/i.test(trimmed) || /^PASTE_/i.test(trimmed)) return null;
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      return JSON.stringify(value);
    }
  }
  return JSON.stringify(value);
}

async function runExperienceQuestionnaire(client, universeId, config) {
  const settings = resolveQuestionnaireSettings(config);
  if (!settings.enabled) {
    console.log('[INFO] Experience questionnaire skipped: configure questionnaire.enabled=true and provide truthful questionIds/answers in config.json.');
    return { skipped: true, reason: 'not-configured' };
  }

  console.log(`[INFO] Filling experience questionnaire for universe ${universeId}...`);

  try {
    const latest = await client.json(
      `https://apis.roblox.com/experience-questionnaire/v1/questionnaires/${universeId}/latest`,
      { timeoutMs: 60_000, operation: `get latest questionnaire ${universeId}` }
    );

    const questionnaireId = latest?.questionnaireId || latest?.id || settings.fallbackQuestionnaireId;
    if (!questionnaireId) {
      throw new Error(`Roblox did not return a questionnaireId for universe ${universeId}`);
    }

    const answerPairs = [];
    for (let i = 0; i < settings.questionIds.length; i += 1) {
      const questionId = settings.questionIds[i];
      const value = normalizeQuestionnaireAnswer(settings.answers[i]);
      if (questionId && value !== null) answerPairs.push({ questionId, value });
    }

    if (!answerPairs.length && settings.byQuestionId && typeof settings.byQuestionId === 'object') {
      for (const [questionId, rawValue] of Object.entries(settings.byQuestionId)) {
        const value = normalizeQuestionnaireAnswer(rawValue);
        if (value !== null) answerPairs.push({ questionId: String(questionId), value });
      }
    }

    if (!answerPairs.length) {
      const discoveredQuestions = latest?.questions || latest?.questionnaire?.questions || latest?.data?.questions || [];
      if (Array.isArray(discoveredQuestions) && discoveredQuestions.length) {
        const summary = discoveredQuestions.map((question) => ({
          questionId: question.questionId || question.id || question.key || null,
          prompt: question.prompt || question.question || question.title || null,
          type: question.type || question.questionType || null,
          options: question.options || question.answers || undefined
        }));
        console.log(`[INFO] Roblox questionnaire fields returned: ${JSON.stringify(summary).slice(0, 5000)}`);
      }
      throw new Error(
        'Questionnaire is enabled but no answers are configured. Open the latest questionnaire details above, then set questionnaire.questionIds + questionnaire.answers ' +
        'or questionnaire.answersByQuestionId in config.json. Answers must accurately describe the experience; the uploader will not guess them.'
      );
    }

    const payload = {
      questionnaireId: String(questionnaireId),
      response: { answers: answerPairs }
    };

    await client.put(
      `https://apis.roblox.com/experience-questionnaire/v1/responses/${universeId}/submissions`,
      payload,
      { 'content-type': 'application/json' },
      { timeoutMs: 60_000, operation: `questionnaire PUT ${universeId}` }
    );

    const bestEffort = async (label, fn) => {
      try {
        const response = await fn();
        console.log(`[INFO] Questionnaire ${label}: ${response?.status ?? 'ok'}`);
        return response;
      } catch (err) {
        console.log(`[WARN] Questionnaire ${label} failed: ${err.message}`);
        return null;
      }
    };

    await bestEffort('validate', () => client.post(
      'https://apis.roblox.com/experience-questionnaire/v1/responses/validate',
      payload,
      { 'content-type': 'application/json' },
      { timeoutMs: 60_000, retries: 2, operation: `questionnaire validate ${universeId}` }
    ));

    const submitted = await bestEffort('submit', () => client.post(
      `https://apis.roblox.com/experience-questionnaire/v1/responses/${universeId}/submissions`,
      payload,
      { 'content-type': 'application/json' },
      { timeoutMs: 60_000, retries: 2, operation: `questionnaire submit ${universeId}` }
    ));
    if (!submitted) {
      throw new Error('Roblox did not accept the final questionnaire submission; the operation will not be reported as submitted. Check the configured question IDs and answer values.');
    }

    await bestEffort('preview', () => client.post(
      'https://apis.roblox.com/experience-questionnaire/v1/responses/preview?localeCode=en_us',
      { universeId, ...payload },
      { 'content-type': 'application/json' },
      { timeoutMs: 60_000, retries: 2, operation: `questionnaire preview ${universeId}` }
    ));

    await bestEffort('guidelines', () => client.post(
      'https://apis.roblox.com/experience-guidelines-service/v1beta1/detailed-guidelines',
      { universeId },
      { 'content-type': 'application/json' },
      { timeoutMs: 60_000, retries: 2, operation: `questionnaire guidelines ${universeId}` }
    ));

    const eligibility = await bestEffort('eligibility', () => client.get(
      `https://apis.roblox.com/experience-questionnaire/v1/eligibility/${universeId}`,
      { timeoutMs: 60_000, retries: 2, operation: `questionnaire eligibility ${universeId}` }
    ));

    let eligibilityData = null;
    if (eligibility && typeof eligibility.json === 'function') {
      eligibilityData = await eligibility.json().catch(() => null);
    }
    const rated = eligibilityData?.maturityRated ?? eligibilityData?.isEligible;

    console.log(
      `[SUCCESS] Questionnaire submitted for universe ${universeId}` +
      (rated !== undefined && rated !== null ? ` (maturityRated=${rated})` : '')
    );
    return { submitted: Boolean(submitted), questionnaireId: String(questionnaireId), answers: answerPairs.length, rated };
  } catch (err) {
    const message = `Questionnaire failed for universe ${universeId}: ${err.message}`;
    if (settings.required) throw new Error(message);
    console.log(`[WARN] ${message} Continuing because questionnaire.required=false.`);
    return { submitted: false, error: message };
  }
}

async function ensureUniversePublicAndDevices(client, universeId, experience, config, mainPlaceId) {
  const openCloudCredential = await selectUniverseWriteCredential(config, universeId, mainPlaceId || '0', 'Main');
  const openCloudKey = openCloudCredential?.apiKey || '';
  let publicDone = false;

  if (openCloudKey) {
    try {
      const openCloud = new RobloxOpenCloudClient(openCloudKey, `Roblox public visibility ${universeId}`);
      await openCloud.request(
        `https://apis.roblox.com/cloud/v2/universes/${universeId}?updateMask=visibility`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ visibility: 'PUBLIC' }),
          timeoutMs: 120_000,
          retries: 2,
          operation: `make universe public ${universeId}`
        }
      );
      console.log(`[SUCCESS] Universe ${universeId} visibility set to PUBLIC via Open Cloud.`);
      publicDone = true;
    } catch (err) {
      console.log(`[WARN] Open Cloud public visibility failed; trying cookie-based activation: ${err.message}`);
    }
  }

  if (!publicDone) {
    try {
      await client.post(
        `https://develop.roblox.com/v1/universes/${universeId}/activate`,
        undefined,
        {},
        { timeoutMs: 60_000, retries: 2, baseDelayMs: 1000, maxDelayMs: 10_000, operation: `activate public universe ${universeId}` }
      );
      console.log(`[SUCCESS] Universe ${universeId} activated/public via Roblox cookie endpoint.`);
      publicDone = true;
    } catch (err) {
      console.log(`[WARN] Cookie activation failed; trying legacy audience configuration: ${err.message}`);
      try {
        await client.patch(
          `https://develop.roblox.com/v2/universes/${universeId}/configuration`,
          {
            name: experience.name,
            description: experience.description,
            studioAccessToApisAllowed: false,
            audiences: [4]
          },
          {},
          { timeoutMs: 60_000, retries: 2, baseDelayMs: 1000, maxDelayMs: 10_000, operation: `publish universe ${universeId}` }
        );
        console.log(`[SUCCESS] Universe ${universeId} marked public via legacy audience configuration.`);
        publicDone = true;
      } catch (legacyErr) {
        console.log(`[WARN] Legacy public configuration also failed: ${legacyErr.message}`);
      }
    }
  }

  if (!publicDone) {
    console.log(`[WARN] Public visibility could not be confirmed for universe ${universeId}. Check Creator Dashboard > Audience/Access and the API key scopes.`);
  }

  let devicesDone = false;
  if (openCloudKey) {
    try {
      devicesDone = await configureUniverseCloudSettings(universeId, experience, openCloudKey);
    } catch (err) {
      console.log(`[WARN] Open Cloud all-devices update failed; using cookie fallback: ${err.message}`);
    }
  }

  if (!devicesDone) {
    try {
      const requestedDevices = Array.isArray(experience.playableDevices) && experience.playableDevices.length
        ? experience.playableDevices
        : ['Computer', 'Phone', 'Tablet', 'Console'];
      const deviceIdsByName = new Map([
        ['computer', 1], ['desktop', 1], ['pc', 1],
        ['phone', 2], ['mobile', 2],
        ['tablet', 3],
        ['console', 4], ['xbox', 4], ['playstation', 4],
        ['vr', 5], ['virtual reality', 5], ['virtualreality', 5],
      ]);
      const playableDeviceIds = [...new Set(requestedDevices.map((device) => {
        const raw = String(device).trim().toLowerCase();
        if (/^[1-5]$/.test(raw)) return Number(raw);
        return deviceIdsByName.get(raw);
      }).filter((id) => Number.isInteger(id)))];
      if (!playableDeviceIds.length) {
        throw new Error('experience.playableDevices did not contain a supported device; use Computer, Phone, Tablet, Console, or VR.');
      }
      await client.patch(
        `https://develop.roblox.com/v2/universes/${universeId}/configuration`,
        { playableDevices: playableDeviceIds },
        {},
        { timeoutMs: 60_000, retries: 2, baseDelayMs: 1000, maxDelayMs: 10_000, operation: `configure playable devices ${universeId}` }
      );
      console.log(`[SUCCESS] Universe ${universeId}: playable devices configured (${requestedDevices.join(', ')}; IDs ${playableDeviceIds.join(', ')}).`);
      devicesDone = true;
    } catch (err) {
      console.log(`[WARN] Cookie all-devices settings update failed: ${err.message}`);
    }
  }

  try {
    await client.patch(
      `https://develop.roblox.com/v2/universes/${universeId}/configuration`,
      {
        allowPrivateServers: experience.allowPrivateServers !== false,
        privateServerPrice: Math.max(0, Number(experience.privateServerPrice ?? 0))
      },
      {},
      { timeoutMs: 60_000, retries: 2, operation: `configure free private servers ${universeId}` }
    );
    console.log(`[SUCCESS] Universe ${universeId}: private servers ${experience.allowPrivateServers === false ? 'disabled' : 'enabled'}${experience.allowPrivateServers === false ? '' : ` (price ${Math.max(0, Number(experience.privateServerPrice ?? 0))})`}.`);
  } catch (err) {
    console.log(`[WARN] Could not configure private servers for universe ${universeId}: ${err.message}`);
  }

  try {
    await configureDiscordSocialLink(client, universeId, experience.discordServerUrl || config.discordServerUrl || 'https://discord.gg/N2mfmmNkta');
  } catch (err) {
    console.log(`[WARN] Discord social link setup failed for universe ${universeId}: ${err.message}`);
  }

  return { publicDone, devicesDone };
}

async function configureDiscordSocialLink(client, universeId, rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) {
    console.log('[INFO] Discord social link skipped: experience.discordServerUrl is not configured.');
    return false;
  }
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['discord.gg', 'www.discord.gg', 'discord.com', 'www.discord.com'].includes(parsed.hostname.toLowerCase())) {
    throw new Error('experience.discordServerUrl must be an HTTPS Discord invite URL.');
  }

  const endpoint = `https://develop.roblox.com/v1/universes/${universeId}/social-links`;
  const payload = { type: 'Discord', url, title: 'Community Discord Server' };
  let links = [];
  try {
    const response = await client.json(endpoint, { timeoutMs: 30_000, retries: 1, operation: `read Discord social links ${universeId}` });
    links = Array.isArray(response) ? response : (response?.data || response?.socialLinks || response?.socialLinksData || []);
  } catch (err) {
    if (Number(err?.status) !== 404) console.log(`[INFO] Could not list existing social links; attempting to add Discord link: ${err.message}`);
  }

  const discordLink = Array.isArray(links) ? links.find((link) => String(link?.type || '').toLowerCase() === 'discord') : null;
  if (discordLink && String(discordLink.url || '') === url) {
    console.log(`[SUCCESS] Discord social link already set for universe ${universeId}.`);
    return true;
  }
  if (discordLink && (discordLink.id || discordLink.socialLinkId)) {
    const id = discordLink.id || discordLink.socialLinkId;
    await client.patch(`${endpoint}/${encodeURIComponent(String(id))}`, payload, {}, { timeoutMs: 30_000, retries: 1, operation: `update Discord social link ${universeId}` });
    console.log(`[SUCCESS] Discord social link updated for universe ${universeId}.`);
    return true;
  }
  await client.post(endpoint, payload, { 'content-type': 'application/json' }, { timeoutMs: 30_000, retries: 1, operation: `add Discord social link ${universeId}` });
  console.log(`[SUCCESS] Discord social link added for universe ${universeId}.`);
  return true;
}

async function configureGroupUniverseViaOpenCloud(universeId, experience, config) {
  const apiKey = resolveApiKey(config, 'Main');
  if (!apiKey) {
    console.log(`[WARN] Group-owned universe ${universeId}: no Open Cloud key available for universe metadata update; continuing with place publishing.`);
    return false;
  }

  const query = new URLSearchParams({
    updateMask: 'displayName,description,visibility'
  });
  const openCloud = new RobloxOpenCloudClient(apiKey, `Roblox group universe ${universeId}`);

  try {
    await openCloud.request(`https://apis.roblox.com/cloud/v2/universes/${universeId}?${query.toString()}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: experience.name,
        description: experience.description,
        visibility: 'PUBLIC'
      }),
      timeoutMs: 120_000,
      retries: 2,
      baseDelayMs: 1000,
      maxDelayMs: 8000,
      operation: `update group universe ${universeId}`
    });
    console.log(`[SUCCESS] Group universe ${universeId} metadata/visibility updated through Open Cloud.`);
    return true;
  } catch (err) {
    console.log(`[WARN] Open Cloud group universe metadata update failed; continuing with the publish pipeline: ${err.message}`);
    return false;
  }
}

export async function configureUniverse(client, universeId, experience, config) {
  // Treat Roblox's live creator metadata as authoritative. Static config can lag behind
  // after switching from a user-owned experience to a group-owned experience.
  let groupMode = isGroupOpenCloudModeEnabled(config);
  if (!groupMode) {
    try {
      const universeDetails = await getUniverseDetails(client, universeId);
      if (applyDetectedGroupOwnership(config, universeDetails)) {
        groupMode = true;
        console.log(
          `[INFO] Live Roblox metadata confirms universe ${universeId} is group-owned ` +
            `(groupId ${universeDetails?.creator?.id ?? 'unknown'}); forcing group Open Cloud mode.`
        );
      }
    } catch (err) {
      console.log(`[WARN] Could not confirm live group ownership for universe ${universeId}: ${err.message}`);
    }
  }

  // Group-owned experiences are handled through the stable Open Cloud Universe API.
  // The legacy develop PATCH can return HTTP 500 for otherwise valid group-owner
  // credentials, so never let that legacy endpoint block RBXL publishing.
  if (groupMode) {
    try {
      await configureGroupUniverseViaOpenCloud(universeId, experience, config);
    } catch (err) {
      console.log(`[WARN] Group Open Cloud universe metadata update failed; continuing with publishing: ${err.message}`);
    }
    return;
  }

  // User-owned compatibility path: keep the existing cookie-based configuration
  // behavior intact because the manual uploader relies on it.
  const universeConfiguration = {
    name: experience.name,
    description: experience.description,
    universeAvatarType: 'PlayerChoice',
    universeAnimationType: 'PlayerChoice',
    allowPrivateServers: experience.allowPrivateServers !== false,
    privateServerPrice: Math.max(0, Number(experience.privateServerPrice ?? 0)),
    isArchived: false,
    permissions: {
      IsThirdPartyTeleportAllowed: true,
      IsThirdPartyAssetAllowed: true,
      IsThirdPartyPurchaseAllowed: true,
      IsClientTeleportAllowed: true
    }
  };

  try {
    await client.patch(`https://develop.roblox.com/v2/universes/${universeId}/configuration`, universeConfiguration);
  } catch (err) {
    if (isRobloxUnauthorized(err)) {
      console.log(`[WARN] Creator account is not authorized to configure universe ${universeId}; skipping universe configuration.`);
      return;
    }

    if (Number(err?.status) >= 500 && Number(err?.status) < 600) {
      console.log(
        `[WARN] Roblox returned HTTP ${err.status} for the full universe configuration; ` +
        `retrying with the minimal name/description payload.`
      );
      await client.patch(`https://develop.roblox.com/v2/universes/${universeId}/configuration`, {
        name: experience.name,
        description: experience.description
      }, {}, { retries: 2, baseDelayMs: 1500, maxDelayMs: 8000 });
    } else {
      throw err;
    }
  }

  try {
    await client.patch(`https://develop.roblox.com/v2/universes/${universeId}/configuration`, {
      isFriendsOnly: false,
      privacyType: 'Public'
    });
  } catch (err) {
    if (isRobloxUnauthorized(err)) {
      console.log(`[INFO] Creator account is not authorized to set universe ${universeId} public; skipping privacy update.`);
    } else {
      console.log(`[WARN] Universe public access update failed: ${err.message}`);
    }
  }

  try {
    await client.patch(`https://develop.roblox.com/v2/universes/${universeId}/settings`, {
      isHttpEnabled: true,
      isStudioAccessToApisAllowed: true,
      allowThirdPartySales: true,
      playableDevices: Array.isArray(experience.playableDevices) && experience.playableDevices.length
        ? experience.playableDevices
        : ['Computer', 'Phone', 'Tablet', 'Console']
    });
    console.log(`[SUCCESS] Enabled configured playable devices for universe ${universeId}: ${(experience.playableDevices || ['Computer', 'Phone', 'Tablet', 'Console']).join(', ')}`);
  } catch (err) {
    if (!isRobloxNotFound(err)) {
      throw err;
    }

    console.log(
      `[INFO] Universe settings PATCH not available for ${universeId} (404 is common here); console devices may already be set elsewhere.`
    );
  }

  try {
    const openCloudKey = resolveApiKey(config, 'Main');
    const cloudOk = await configureUniverseCloudSettings(universeId, experience, openCloudKey);
    if (cloudOk) {
      const parts = [
        'Open Cloud: Desktop / Mobile / Tablet / Console / VR join enabled (includes console players)'
      ];
      if (experience.enableMicrophone !== false) {
        parts.push('voice chat (microphone) enabled');
      }
      console.log(`[SUCCESS] Universe ${universeId}: ${parts.join('; ')}.`);
    }
  } catch (err) {
    console.log(`[WARN] Open Cloud universe access / microphone update failed: ${err.message}`);
  }
}

function imageMimeTypeFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') {
    return 'image/png';
  }
  if (ext === '.jpg' || ext === '.jpeg') {
    return 'image/jpeg';
  }
  if (ext === '.webp') {
    return 'image/webp';
  }
  if (ext === '.gif') {
    return 'image/gif';
  }

  return 'image/png';
}

async function postPublishRobloxMultipartImage(client, endpoint, resolvedPath) {
  const formData = new FormData();
  const mime = imageMimeTypeFromPath(resolvedPath);
  formData.append('Files', new File([readBinaryFile(resolvedPath)], path.basename(resolvedPath), {
    type: mime
  }));

  await client.request(endpoint, {
    method: 'POST',
    body: formData
  });
}

async function uploadExperienceImage(client, targetId, imagePath, imageType, targetType) {
  if (!imagePath) {
    return false;
  }

  const resolvedPath = path.resolve(imagePath);
  if (!fs.existsSync(resolvedPath)) {
    console.log(`[WARN] Skipping ${imageType} upload; file does not exist: ${resolvedPath}`);
    return false;
  }

  const targetPath = targetType === 'place' ? 'places' : 'games';
  const endpoint = imageType === 'icon'
    ? `https://publish.roblox.com/v1/${targetPath}/${targetId}/icon/image`
    : `https://publish.roblox.com/v1/${targetPath}/${targetId}/thumbnail/image`;
  await postPublishRobloxMultipartImage(client, endpoint, resolvedPath);

  return true;
}

async function tryPublishMainPlaceIcon(client, universeId, mainPlaceId, iconPath) {
  if (!iconPath) {
    return false;
  }

  const resolvedPath = path.resolve(iconPath);
  if (!fs.existsSync(resolvedPath)) {
    return false;
  }

  const u = normalizeUserId(universeId, 'experienceId');
  const p = normalizeUserId(mainPlaceId, 'Main place id');
  const endpoints = [
    `https://publish.roblox.com/v1/places/${p}/icon/image`,
    `https://publish.roblox.com/v1/universes/${u}/places/${p}/icon/image`,
    // Additional legacy/variant routes observed across older publish APIs.
    `https://publish.roblox.com/v1/places/${p}/icons/image`,
    `https://publish.roblox.com/v1/universes/${u}/places/${p}/icons/image`,
    `https://publish.roblox.com/v1/places/${p}/icon`,
    `https://publish.roblox.com/v1/universes/${u}/places/${p}/icon`
  ];

  let sawNotFound = false;
  for (const endpoint of endpoints) {
    try {
      await postPublishRobloxMultipartImage(client, endpoint, resolvedPath);
      console.log(`[SUCCESS] Main place icon uploaded (${endpoint})`);
      return true;
    } catch (err) {
      if (isRobloxNotFound(err)) {
        sawNotFound = true;
        continue;
      }
      console.log(`[WARN] Main place icon upload (${endpoint}): ${err.message}`);
    }
  }

  if (sawNotFound) {
    console.log('[INFO] Main place icon routes returned 404 across all known endpoint variants.');
  }
  return false;
}

function buildDashboardPlaceIconUrls(config, universeId, mainPlaceId) {
  const u = normalizeUserId(universeId, 'experienceId');
  const p = normalizeUserId(mainPlaceId, 'Main place id');
  const urls = [`https://create.roblox.com/dashboard/creations/experiences/${u}/places/${p}/icon`];
  const gid = config ? resolveExperienceGroupId(config) : '';
  if (gid) {
    urls.push(`https://create.roblox.com/dashboard/group/${gid}/experiences/${u}/places/${p}/icon`);
  }
  return urls;
}

async function tryUploadMainPlaceIconViaDashboard(robloxCookie, universeId, mainPlaceId, iconPath, config = null) {
  if (!robloxCookie || !iconPath) {
    return false;
  }

  const resolvedPath = path.resolve(iconPath);
  if (!fs.existsSync(resolvedPath)) {
    return false;
  }

  const dashboardUrls = buildDashboardPlaceIconUrls(config, universeId, mainPlaceId);
  let browser;
  try {
    browser = await launchAutomationBrowser({ label: 'icon-upload' });
    const context = await browser.newContext();
    await context.addCookies([buildRobloxSecurityCookieEntry(robloxCookie)]);

    let lastError = null;
    for (const dashboardUrl of dashboardUrls) {
      const page = await context.newPage();
      try {
        await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);

        const fileInput = page.locator('input[type="file"]').first();
        await fileInput.waitFor({ state: 'attached', timeout: 15000 });
        await fileInput.setInputFiles(resolvedPath);
        await page.waitForTimeout(1200);

        const saveButton = page
          .getByRole('button', { name: /save|publish|apply|confirm/i })
          .first();
        if (!(await saveButton.count())) {
          throw new Error('Could not find Save/Publish button on Creator Dashboard icon page.');
        }

        try {
          await saveButton.waitFor({ state: 'visible', timeout: 10000 });
        } catch {
          // continue; click may still work
        }
        await page.waitForTimeout(800);

        await saveButton.click({ timeout: 8000 });
        await page.waitForTimeout(5000);
        await page.close().catch(() => {});
        await browser.close();
        browser = null;
        console.log(`[SUCCESS] Uploaded main place icon via Creator Dashboard (${dashboardUrl}).`);
        return true;
      } catch (err) {
        lastError = err;
        await page.close().catch(() => {});
        console.log(`[WARN] Creator Dashboard icon attempt failed (${dashboardUrl}): ${err.message}`);
      }
    }

    throw lastError || new Error('Creator Dashboard icon upload failed for all URL candidates.');
  } catch (err) {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // ignore
      }
    }
    console.log(`[WARN] Creator Dashboard icon upload fallback failed: ${err.message}`);
    return false;
  }
}

async function tryPublishGameExperienceIcon(client, universeId, mainPlaceId, iconPath) {
  if (!iconPath) {
    return false;
  }

  const u = normalizeUserId(universeId, 'experienceId');
  const main = mainPlaceId != null ? normalizeUserId(mainPlaceId, 'Main place id') : null;
  const candidates = main && main !== u ? [u, main] : [u];

  for (const gameId of candidates) {
    try {
      if (await uploadExperienceImage(client, gameId, iconPath, 'icon', 'game')) {
        console.log(`[INFO] Experience icon sent via publish.roblox.com games/${gameId}/icon/image`);
        return true;
      }
    } catch (err) {
      if (!isRobloxNotFound(err)) {
        console.log(`[WARN] publish.roblox.com game icon (games/${gameId}) failed: ${err.message}`);
      }
    }
  }

  return false;
}

function normalizeIconLanguageCode(code) {
  return String(code || '').trim().toLowerCase();
}

function toRobloxIconLanguageCode(code) {
  const normalized = normalizeIconLanguageCode(code);
  if (!normalized || normalized === 'en' || normalized === 'en-us') {
    return null;
  }
  return normalized.replace(/-/g, '_');
}

function detectSourceIconLanguage(existingRecords) {
  for (const entry of existingRecords || []) {
    if (entry?.isSourceLanguage === true) {
      return normalizeIconLanguageCode(entry?.languageCode || entry?.language || entry?.locale) || 'en';
    }
  }

  for (const entry of existingRecords || []) {
    const lang = normalizeIconLanguageCode(entry?.languageCode || entry?.language || entry?.locale);
    if (lang === 'en') {
      return 'en';
    }
  }

  return 'en';
}

function shouldSkipLocalizedIconUpload(sourceLanguage, targetCode) {
  const source = normalizeIconLanguageCode(sourceLanguage);
  const target = toRobloxIconLanguageCode(targetCode);
  if (!target) {
    return true;
  }
  if (source === target) {
    return true;
  }
  // Source English is set via Creator Dashboard; en_us/en_gb are not separate translations here.
  if (source === 'en' && (target === 'en_us' || target === 'en_gb')) {
    return true;
  }
  return false;
}

function collectLocalizedIconLanguageCodes(existingRecords, preferredCode = 'en_us') {
  const sourceLanguage = detectSourceIconLanguage(existingRecords);
  const codes = new Set();

  for (const entry of existingRecords || []) {
    const raw = entry?.languageCode || entry?.language || entry?.locale;
    const apiCode = toRobloxIconLanguageCode(raw);
    if (!apiCode || shouldSkipLocalizedIconUpload(sourceLanguage, apiCode)) {
      continue;
    }
    codes.add(apiCode);
  }

  const preferred = toRobloxIconLanguageCode(preferredCode);
  if (preferred && !shouldSkipLocalizedIconUpload(sourceLanguage, preferred)) {
    codes.add(preferred);
  }

  return [...codes];
}

function formatIconRecordEntry(entry) {
  const lang = entry?.languageCode || entry?.language || entry?.locale || 'unknown';
  const imageId =
    entry?.imageId ??
    entry?.iconImageId ??
    entry?.targetId ??
    entry?.assetId ??
    entry?.id ??
    entry?.state?.imageId ??
    'unknown';
  const state = entry?.state || entry?.moderationState || entry?.status || '';
  return state ? `${lang}:${imageId} (${state})` : `${lang}:${imageId}`;
}

function buildLocalizedIconFormData(resolvedPath) {
  const mime = imageMimeTypeFromPath(resolvedPath);
  const formData = new FormData();
  formData.append('Files', new File([readBinaryFile(resolvedPath)], path.basename(resolvedPath), {
    type: mime,
  }));
  return formData;
}

async function postLocalizedGameIcon(client, universeId, imagePath, languageCode) {
  const resolvedPath = path.resolve(imagePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Icon file does not exist: ${resolvedPath}`);
  }

  const code = toRobloxIconLanguageCode(languageCode);
  if (!code) {
    throw new Error(`Invalid localized icon language code: ${languageCode}`);
  }

  await client.request(
    `https://gameinternationalization.roblox.com/v1/game-icon/games/${universeId}/language-codes/${code}`,
    {
      method: 'POST',
      body: buildLocalizedIconFormData(resolvedPath),
    }
  );
}

async function uploadLocalizedGameIcons(client, gameId, imagePath, languageCodes) {
  if (!imagePath) {
    return 0;
  }

  const resolvedPath = path.resolve(imagePath);
  if (!fs.existsSync(resolvedPath)) {
    console.log(`[WARN] Skipping icon upload; file does not exist: ${resolvedPath}`);
    return 0;
  }

  const uniqueCodes = [...new Set(languageCodes.map(toRobloxIconLanguageCode).filter(Boolean))];
  if (!uniqueCodes.length) {
    console.log('[INFO] No translation icon locales to update via localization API.');
    return 0;
  }

  let uploaded = 0;
  let lastError = null;

  for (const code of uniqueCodes) {
    try {
      await postLocalizedGameIcon(client, gameId, imagePath, code);
      console.log(`[SUCCESS] Uploaded experience icon for locale ${code}`);
      uploaded += 1;
    } catch (err) {
      lastError = err;
      console.log(`[WARN] Localized icon upload failed for ${code}: ${err.message}`);
    }
  }

  if (uploaded === 0) {
    throw lastError || new Error('Localized game icon upload failed');
  }

  return uploaded;
}

async function getLocalizedGameIconRecords(client, gameId) {
  const id = normalizeUserId(gameId, 'game id');
  return client.get(`https://gameinternationalization.roblox.com/v1/game-icon/games/${id}`);
}

async function getExperienceGameMediaV1(client, universeId) {
  const id = normalizeUserId(universeId, 'experienceId');
  return client.get(`https://games.roblox.com/v1/games/${id}/media`);
}

function listExperienceImageMediaItems(gameMediaV1) {
  return (gameMediaV1?.data || []).filter((item) => item?.assetType === 'Image' || item?.assetTypeId === 1);
}

async function deleteExperienceThumbnailByMediaId(client, universeId, mediaId) {
  const universe = normalizeUserId(universeId, 'experienceId');
  const thumbnailMediaId = normalizeUserId(mediaId, 'thumbnail media id');
  await client.request(`https://develop.roblox.com/v1/universes/${universe}/thumbnails/${thumbnailMediaId}`, {
    method: 'DELETE'
  });
}

async function deleteAllExperienceThumbnails(client, universeId) {
  const gameId = normalizeUserId(universeId, 'experienceId');
  let deleted = 0;

  for (let pass = 0; pass < 4; pass += 1) {
    let items = [];
    try {
      const gameMedia = await getExperienceGameMediaV1(client, gameId);
      items = listExperienceImageMediaItems(gameMedia);
    } catch (err) {
      console.log(`[WARN] Could not list experience thumbnails: ${err.message}`);
      break;
    }

    if (items.length === 0) {
      break;
    }

    for (const item of items) {
      const mediaId = item?.id;
      if (mediaId === undefined || mediaId === null || String(mediaId).trim() === '') {
        console.log(`[WARN] Skipping thumbnail without media id (imageId=${item?.imageId ?? 'unknown'}).`);
        continue;
      }

      try {
        await deleteExperienceThumbnailByMediaId(client, gameId, mediaId);
        deleted += 1;
        console.log(`[INFO] Deleted thumbnail media ${mediaId} (image ${item?.imageId ?? 'unknown'}).`);
      } catch (err) {
        console.log(`[WARN] Could not delete thumbnail media ${mediaId}: ${err.message}`);
      }
    }

    try {
      const remaining = listExperienceImageMediaItems(await getExperienceGameMediaV1(client, gameId));
      if (remaining.length === 0) {
        break;
      }
    } catch {
      break;
    }
  }

  try {
    const remaining = listExperienceImageMediaItems(await getExperienceGameMediaV1(client, gameId));
    if (remaining.length > 0) {
      console.log(
        `[WARN] ${remaining.length} thumbnail(s) still remain after delete attempts (image ids: ${remaining.map((item) => item.imageId).join(', ')}).`
      );
    } else if (deleted > 0) {
      console.log(`[SUCCESS] Removed ${deleted} existing thumbnail(s) before upload.`);
    } else {
      console.log('[INFO] No existing thumbnails to remove.');
    }
  } catch (err) {
    if (deleted > 0) {
      console.log(`[SUCCESS] Removed ${deleted} existing thumbnail(s) before upload.`);
    } else {
      console.log('[INFO] No existing thumbnails to remove.');
    }
    console.log(`[WARN] Could not verify thumbnail cleanup: ${err.message}`);
  }

  return deleted;
}

async function uploadExperienceThumbnail(client, universeId, mainPlaceId, experience) {
  if (!experience?.thumbnailPath) {
    return false;
  }

  await deleteAllExperienceThumbnails(client, universeId);

  try {
    if (await uploadExperienceImage(client, universeId, experience.thumbnailPath, 'thumbnail', 'game')) {
      console.log('[SUCCESS] Uploaded experience thumbnail');
      return true;
    }
  } catch (err) {
    console.log(`[WARN] Thumbnail upload failed: ${err.message}`);
    try {
      if (await uploadExperienceImage(client, mainPlaceId, experience.thumbnailPath, 'thumbnail', 'place')) {
        console.log('[SUCCESS] Uploaded Main place thumbnail');
        return true;
      }
    } catch (placeErr) {
      console.log(`[WARN] Main place thumbnail upload failed: ${placeErr.message}`);
    }
  }

  return false;
}

const openCloudKeyIntrospectionCache = new Map();

function fingerprintOpenCloudKey(apiKey) {
  return createHash('sha256').update(String(apiKey || '').trim()).digest('hex').slice(0, 12);
}

function normalizeIntrospectionScopeName(scope) {
  return String(scope?.name || '').trim().toLowerCase().replace(/:write$/, '');
}

function introspectionScopeHasWrite(scope) {
  const operations = Array.isArray(scope?.operations)
    ? scope.operations.map((operation) => String(operation).toLowerCase())
    : [];
  return operations.includes('write') || /:write$/i.test(String(scope?.name || ''));
}

function introspectionScopeUniverseIds(scope) {
  if (Array.isArray(scope?.universeIds)) return scope.universeIds.map(String);
  if (Array.isArray(scope?.universes)) {
    return scope.universes.map((item) => String(item?.universeId ?? item?.id ?? item));
  }
  if (Array.isArray(scope?.resources)) return scope.resources.map(String);
  return null;
}

async function diagnoseOpenCloudPublishKey(apiKey, universeId, placeId, config, placeKey, source) {
  const normalizedKey = String(apiKey || '').trim();
  if (!normalizedKey) return null;

  const fingerprint = fingerprintOpenCloudKey(normalizedKey);
  const cacheKey = `${fingerprint}:${String(universeId)}`;
  if (openCloudKeyIntrospectionCache.has(cacheKey)) {
    return openCloudKeyIntrospectionCache.get(cacheKey);
  }

  const diagnosticPromise = (async () => {
    try {
      // Roblox's introspection endpoint reports permissions for the exact key being sent.
      // Never log the API key, request body, or any part of the secret.
      const info = await requestJson(
        'https://apis.roblox.com/api-keys/v1/introspect',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ apiKey: normalizedKey }),
        },
        { retries: 0, timeoutMs: 15000, operation: 'Roblox Open Cloud API key introspection' }
      );

      const scopes = Array.isArray(info?.scopes) ? info.scopes : [];
      const placeWriteScopes = scopes.filter((scope) =>
        normalizeIntrospectionScopeName(scope) === 'universe-places' && introspectionScopeHasWrite(scope)
      );
      const universeWriteScopes = scopes.filter((scope) =>
        normalizeIntrospectionScopeName(scope) === 'universe' && introspectionScopeHasWrite(scope)
      );
      const targetId = String(universeId);
      const targetStatus = (matchingScopes) => {
        if (!matchingScopes.length) return false;
        let anyTargetReported = false;
        for (const scope of matchingScopes) {
          const ids = introspectionScopeUniverseIds(scope);
          if (!ids || ids.length === 0) continue;
          anyTargetReported = true;
          if (ids.includes('*') || ids.includes(targetId)) return true;
        }
        return anyTargetReported ? false : null;
      };
      const summaryScopes = scopes.map((scope) => ({
        name: String(scope?.name || ''),
        operations: Array.isArray(scope?.operations) ? scope.operations.map(String) : [],
        universeIds: introspectionScopeUniverseIds(scope),
        groupIds: Array.isArray(scope?.groupIds) ? scope.groupIds.map(String) : undefined,
      }));
      const enabled = info?.enabled ?? info?.isEnabled ?? null;
      const expired = info?.expired ?? info?.isExpired ?? null;
      const result = {
        available: true,
        fingerprint,
        hasUniversePlacesWrite: placeWriteScopes.length > 0,
        universePlacesTargetAllowed: targetStatus(placeWriteScopes),
        hasUniverseWrite: universeWriteScopes.length > 0,
        universeTargetAllowed: targetStatus(universeWriteScopes),
        enabled,
        expired,
        keyName: String(info?.name || ''),
      };

      console.log('[INFO] Open Cloud API key introspection (secret omitted): ' + JSON.stringify({
        source,
        fingerprint,
        keyName: result.keyName || undefined,
        enabled,
        expired,
        expirationTimeUtc: info?.expirationTimeUtc || info?.expirationUtcTime || undefined,
        authorizedUserId: info?.authorizedUserId || undefined,
        targetUniverseId: targetId,
        targetPlaceId: String(placeId),
        hasUniversePlacesWrite: result.hasUniversePlacesWrite,
        universePlacesTargetAllowed: result.universePlacesTargetAllowed,
        hasUniverseWrite: result.hasUniverseWrite,
        universeTargetAllowed: result.universeTargetAllowed,
        scopes: summaryScopes,
      }));
      return result;
    } catch (error) {
      const result = { available: false, fingerprint };
      console.log('[WARN] Could not introspect the actual Open Cloud key (secret omitted): ' + JSON.stringify({
        source,
        fingerprint,
        targetUniverseId: String(universeId),
        status: error?.status || null,
        error: String(error?.message || error).slice(0, 240),
      }));
      return result;
    }
  })();

  openCloudKeyIntrospectionCache.set(cacheKey, diagnosticPromise);
  return diagnosticPromise;
}

function describeUserOpenCloudKeySource(config, placeKey) {
  const placeConfig = config.experience?.places?.[placeKey];
  if (placeConfig?.apiKey && trimConfigSecret(placeConfig.apiKey)) {
    return `experience.places.${placeKey}.apiKey`;
  }
  if (config.accountPool?.primary?.apiKey && trimConfigSecret(config.accountPool.primary.apiKey)) {
    return 'accountPool.primary.apiKey';
  }
  if (config.creatorAccount?.apiKey && trimConfigSecret(config.creatorAccount.apiKey)) {
    return 'creatorAccount.apiKey';
  }
  return 'no alternate user apiKey configured';
}

function canPublishToTargetFromIntrospection(info) {
  if (!info?.available) return null;
  if (info.enabled === false || info.expired === true) return false;
  if (!info.hasUniversePlacesWrite) return false;
  if (info.universePlacesTargetAllowed === false) return false;
  return true;
}

async function selectOpenCloudPublishCredential(config, universeId, placeId, placeKey) {
  const preferredKey = resolveApiKey(config, placeKey);
  const preferredSource = describeOpenCloudKeySource(config, placeKey);
  const alternateKey = resolveUserOpenCloudApiKey(config, placeKey);
  const alternateSource = describeUserOpenCloudKeySource(config, placeKey);

  if (!preferredKey) return { apiKey: '', source: 'none' };
  if (!alternateKey || trimConfigSecret(alternateKey) === trimConfigSecret(preferredKey)) {
    return { apiKey: preferredKey, source: preferredSource };
  }

  const [preferredInfo, alternateInfo] = await Promise.all([
    diagnoseOpenCloudPublishKey(preferredKey, universeId, placeId, config, placeKey, preferredSource),
    diagnoseOpenCloudPublishKey(alternateKey, universeId, placeId, config, placeKey, alternateSource),
  ]);
  const preferredStatus = canPublishToTargetFromIntrospection(preferredInfo);
  const alternateStatus = canPublishToTargetFromIntrospection(alternateInfo);

  if (preferredStatus === false && alternateStatus === true) {
    console.log(`[INFO] Selecting ${alternateSource} for ${placeKey} because the configured group key is not authorized for universe ${universeId}.`);
    return { apiKey: alternateKey, source: alternateSource };
  }
  return { apiKey: preferredKey, source: preferredSource };
}

async function selectUniverseWriteCredential(config, universeId, placeId, placeKey = 'Main') {
  const candidates = [
    { apiKey: resolveApiKey(config, placeKey), source: describeOpenCloudKeySource(config, placeKey) },
    { apiKey: resolveUserOpenCloudApiKey(config, placeKey), source: describeUserOpenCloudKeySource(config, placeKey) },
  ].filter((candidate, index, all) => candidate.apiKey && all.findIndex((other) => trimConfigSecret(other.apiKey) === trimConfigSecret(candidate.apiKey)) === index);

  let anyDiagnosticAvailable = false;
  for (const candidate of candidates) {
    const info = await diagnoseOpenCloudPublishKey(candidate.apiKey, universeId, placeId, config, placeKey, candidate.source);
    if (info?.available) anyDiagnosticAvailable = true;
    if (
      info?.available && info.hasUniverseWrite && info.universeTargetAllowed !== false &&
      info.enabled !== false && info.expired !== true
    ) {
      return candidate;
    }
  }

  if (anyDiagnosticAvailable) {
    console.log(`[INFO] None of the configured Open Cloud keys has Universe → Write for universe ${universeId}; using the Creator Dashboard cookie endpoint for visibility and device settings.`);
    return null;
  }

  // If introspection itself is unavailable, keep the existing behavior and let Roblox decide.
  return candidates[0] || null;
}

async function uploadPlaceFile(universeId, placeId, rbxlSource, apiKey, config = null, placeKey = 'Main', keySource = null) {
  requireValue(apiKey, 'Open Cloud API key for place publishing');
  await diagnoseOpenCloudPublishKey(
    apiKey,
    universeId,
    placeId,
    config,
    placeKey,
    keySource || (config ? describeOpenCloudKeySource(config, placeKey) : 'unknown source')
  );

  // Accept a pre-read Buffer so every target can publish the exact same source bytes.
  // The orchestrator reads each configured RBXL once before starting uploads.
  let data = Buffer.isBuffer(rbxlSource) || rbxlSource instanceof Uint8Array
    ? Buffer.from(rbxlSource)
    : readBinaryFile(rbxlSource);
  if (shouldPatchRbxlUploadStamp(config)) {
    const stampConfig = config?.experience?.uploadStamp;
    data = patchRbxlUploadStamp(data, {
      marker: typeof stampConfig === 'object' && stampConfig?.marker ? stampConfig.marker : undefined,
    });
  }
  const url = `https://apis.roblox.com/universes/v1/${universeId}/places/${placeId}/versions?versionType=Published`;
  const maxAttempts = 6;
  let lastStatus = 0;
  let lastBody = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const openCloud = new RobloxOpenCloudClient(apiKey, `Roblox place publisher ${placeId}`, { retries: 0 });
    try {
      const response = await openCloud.request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: data,
        timeoutMs: 30 * 60_000,
        retries: 0,
        operation: `publish place ${placeId}`
      });
      const text = await response.text();
      if (!text.trim()) return { ok: true };
      try { return JSON.parse(text); } catch { return { ok: true, response: text.slice(0, 200) }; }
    } catch (error) {
      lastStatus = Number(error?.status || 0);
      lastBody = String(error?.message || '');
      if (attempt < maxAttempts && isOpenCloudPlacePublishRetryable(lastStatus, lastBody)) {
        const delayMs = openCloudPlacePublishBackoffMs(attempt - 1);
        console.log(`[INFO] Open Cloud place publish busy or transient (${lastStatus}) for place ${placeId}; retry ${attempt + 1}/${maxAttempts} after ${Math.round(delayMs / 1000)}s…`);
        await sleep(delayMs);
        continue;
      }
      if (isOpenCloudInsufficientScopes(lastStatus, lastBody)) {
        throw new Error(`Open Cloud place publish failed for place ${placeId}: API key is missing the **Universe Places → Write** scope (401 insufficient scopes). ${config ? openCloudPlacePublishScopeSetupHint(config) : 'Add Universe Places → Write on your Creator Dashboard API key.'}`);
      }
      throw error;
    }
  }

  throw new Error(`Open Cloud place publish failed for place ${placeId}: ${lastStatus} ${lastBody}`);
}

async function grantUniverseEditPermission(client, universeId, targetUserId) {
  const normalizedUniverseId = normalizeUserId(universeId, 'experienceId');
  const normalizedTargetUserId = normalizeUserId(targetUserId, 'target user ID');
  const userId = Number(normalizedTargetUserId);

  try {
    await client.patch(`https://develop.roblox.com/v1/universes/${normalizedUniverseId}/teamcreate`, {
      isEnabled: true
    });
  } catch (err) {
    if (!isRobloxUnauthorized(err)) {
      console.log(`[WARN] Failed to auto-enable Team Create for universe ${normalizedUniverseId}: ${err.message}`);
    }
  }

  const membershipPayloads = [
    { userId, permission: 'Edit' },
    { userId, permissions: ['Edit'] },
    { userId, role: 'Edit' },
    { userId, action: 'Add', permission: 'Edit' },
    { userId, action: 'Grant', permission: 'Edit' }
  ];

  const membershipEndpoints = [
    `https://develop.roblox.com/v1/universes/${normalizedUniverseId}/teamcreate/memberships`,
    `https://apis.roblox.com/legacy-develop/v1/universes/${normalizedUniverseId}/teamcreate/memberships`,
    `https://develop.roblox.com/legacy-develop/v1/universes/${normalizedUniverseId}/teamcreate/memberships`
  ];

  let lastError = null;
  for (const endpoint of membershipEndpoints) {
    for (const payload of membershipPayloads) {
      try {
        await client.request(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json'
          },
          body: JSON.stringify(payload)
        });
        return;
      } catch (err) {
        lastError = err;
      }
    }
  }

  throw lastError || new Error(`Unable to grant Team Create edit permissions for user ${normalizedTargetUserId}`);
}

async function getAssetUniverseEditStatus(assetAccount, universeId) {
  const assetCookie = resolveCookie(assetAccount, assetAccount.name);
  if (!assetCookie) {
    throw new Error(`Missing cookie for ${assetAccount.name}; cannot verify edit permission.`);
  }

  const assetClient = new RobloxClient(assetCookie, assetAccount.name);
  const permissions = await getUniversePermissions(assetClient, universeId);
  return Boolean(permissions?.canCloudEdit || permissions?.canManage);
}

async function waitForManualUniverseEditGrant(assetAccount, assetUserId, experienceId, mainPlaceId, config) {
  if (!resolveCookie(assetAccount, assetAccount.name)) {
    throw new Error(
      `Missing cookie for ${assetAccount.name}; cannot verify edit permission after a manual grant. ` +
        'Set cookie for that asset account in config.json.'
    );
  }

  console.log(`[ACTION REQUIRED] Grant Edit access on universe ${experienceId} to ${assetAccount.name} (userId ${assetUserId}).`);

  const permissionsUrl = buildCreatorDashboardPermissionsUrl(experienceId);
  const creatorAccount = config.creatorAccount || config.accountPool?.primary;
  const creatorCookie = creatorAccount ? resolveCookie(creatorAccount, 'creatorAccount') : '';
  let launch = { method: 'manual', opened: false, studioUrl: permissionsUrl };

  if (isRemoteServerRuntime()) {
    console.log(
      '[ACTION REQUIRED] Roblox Studio is unavailable on Railway. Use Creator Dashboard → Permissions to grant Edit, then click Continue.'
    );
    if (creatorCookie) {
      const session = await createRobloxPlaywrightSession(creatorCookie, permissionsUrl);
      launch = {
        method: 'remote-dashboard',
        opened: Boolean(session),
        studioUrl: permissionsUrl,
      };
      if (session) {
        console.log('[ACTION REQUIRED] Opened Creator Dashboard permissions in the automation browser (see dashboard screenshots).');
      } else {
        console.log(`[ACTION REQUIRED] Open permissions manually: ${permissionsUrl}`);
      }
    } else {
      console.log(`[ACTION REQUIRED] Open permissions manually: ${permissionsUrl}`);
    }
  } else {
    console.log(
      '[ACTION REQUIRED] Opening Roblox Studio for the Main place so you can set collaborators / permissions and save to Roblox.'
    );
    launch = await tryOpenRobloxStudioForEdit(config, experienceId, mainPlaceId);
    if (launch.method === 'cli') {
      console.log(
        `[ACTION REQUIRED] Launched Studio (${launch.studioPath}) with EditPlace — universeId=${launch.universeIdStr} placeId=${launch.placeIdStr}.`
      );
    } else if (launch.opened) {
      console.log(`[ACTION REQUIRED] Launched Studio protocol link: ${launch.studioUrl}`);
    } else {
      console.log(`[ACTION REQUIRED] Could not auto-open Studio. Use protocol URL or configure studioLaunch: ${launch.studioUrl}`);
    }
  }

  while (true) {
    const line = String(
      await waitForEnterPrompt(
        isRemoteServerRuntime()
          ? '[ACTION REQUIRED] After Edit access is saved in Creator Dashboard, click Continue to re-check (type quit to abort)...'
          : '[ACTION REQUIRED] After permissions are saved to Roblox from Studio, press Enter to re-check (type quit to abort)...',
        { studioUrl: launch.studioUrl || permissionsUrl, permissionsUrl }
      )
    )
      .trim()
      .toLowerCase();
    if (line === 'quit' || line === 'q') {
      throw new Error(`Aborted waiting for edit permission for ${assetAccount.name} (${assetUserId}).`);
    }

      let hasEdit = false;
      try {
        hasEdit = await getAssetUniverseEditStatus(assetAccount, experienceId);
      } catch (verifyErr) {
        console.log(`[WARN] Could not verify edit permission: ${verifyErr.message}`);
      }

      if (hasEdit) {
        console.log(`[SUCCESS] Verified edit permission on universe ${experienceId} for ${assetAccount.name} (${assetUserId})`);
        return;
      }

      console.log(
        isRemoteServerRuntime()
          ? `[WARN] Edit permission not detected yet. In Creator Dashboard add ${assetAccount.name} (${assetUserId}) with Edit access:\n    ${permissionsUrl}`
          : '[WARN] Edit permission not detected yet. In Studio use Game Settings → Permissions (or Collaborators), add the user with Edit, then File → Publish to Roblox if needed.'
      );
  }
}

async function writePlaceIds(config, placeIds, { configPath = '' } = {}) {
  return exportPlaceIds(placeIds, config, { configPath });
}

async function freshenExperienceMedia(experience) {
  if (experience?.iconPath) {
    const resolved = path.resolve(experience.iconPath);
    if (!fs.existsSync(resolved)) {
      console.log(`[WARN] Skipping icon prep; file missing: ${resolved}`);
    } else {
      try {
        const prepared = await ensureExperienceIconFile(resolved);
        if (prepared.resized) {
          console.log(`[INFO] Resized icon to 512x512 for Roblox (${path.basename(resolved)}).`);
        }
        const result = await freshenImageFile(resolved);
        console.log(
          `[INFO] Freshened icon ${path.basename(resolved)} at pixel (${result.x},${result.y}) ` +
            `[${result.before.join(',')} -> ${result.after.join(',')}]`
        );
      } catch (err) {
        console.log(`[WARN] Icon prep failed for ${resolved}: ${err.message}`);
      }
    }
  }

  if (experience?.thumbnailPath) {
    const resolved = path.resolve(experience.thumbnailPath);
    if (!fs.existsSync(resolved)) {
      console.log(`[WARN] Skipping thumbnail freshen; file missing: ${resolved}`);
    } else {
      try {
        const result = await freshenImageFile(resolved);
        console.log(
          `[INFO] Freshened thumbnail ${path.basename(resolved)} at pixel (${result.x},${result.y}) ` +
            `[${result.before.join(',')} -> ${result.after.join(',')}]`
        );
      } catch (err) {
        console.log(`[WARN] Thumbnail freshen failed for ${resolved}: ${err.message}`);
      }
    }
  }
}

async function configureMedia(client, universeId, mainPlaceId, experience, creatorCookie = '', config = null) {
  await freshenExperienceMedia(experience);
  try {
    let anyIconChannel = false;
    let existingIconRecords = [];

    try {
      const iconState = await getLocalizedGameIconRecords(client, universeId);
      existingIconRecords = iconState?.data || [];
    } catch (listErr) {
      console.log(`[WARN] Could not list existing icon locales before upload: ${listErr.message}`);
    }

    const sourceLanguage = detectSourceIconLanguage(existingIconRecords);
    console.log(`[INFO] Experience source icon language: ${sourceLanguage}`);

    const dashboardOk = await tryUploadMainPlaceIconViaDashboard(
      creatorCookie || null,
      universeId,
      mainPlaceId,
      experience.iconPath,
      config
    );
    anyIconChannel = dashboardOk || anyIconChannel;

    anyIconChannel =
      (await tryPublishGameExperienceIcon(client, universeId, mainPlaceId, experience.iconPath)) || anyIconChannel;

    const iconLanguageCodes = collectLocalizedIconLanguageCodes(
      existingIconRecords,
      experience.iconLanguageCode || 'en_us'
    );
    if (iconLanguageCodes.length) {
      console.log(`[INFO] Uploading translated icon to locale(s): ${iconLanguageCodes.join(', ')}`);
      try {
        const localizedUploaded = await uploadLocalizedGameIcons(
          client,
          universeId,
          experience.iconPath,
          iconLanguageCodes
        );
        anyIconChannel = localizedUploaded > 0 || anyIconChannel;
      } catch (localizedErr) {
        console.log(`[WARN] Localized icon upload failed: ${localizedErr.message}`);
      }
    } else {
      console.log(
        '[INFO] Skipping localization icon API for source English; Creator Dashboard sets the live game icon.'
      );
    }

    const placeIconOk = await tryPublishMainPlaceIcon(client, universeId, mainPlaceId, experience.iconPath);
    if (placeIconOk) {
      anyIconChannel = true;
    } else if (anyIconChannel) {
      console.log(
        '[INFO] Main place publish icon routes returned 404; Creator Dashboard / localized icon upload above is enough for the game tile.'
      );
    } else {
      console.log('[WARN] Main place icon could not be uploaded via publish.roblox.com (tried places/... and universes/.../places/...).');
    }

    if (anyIconChannel) {
      console.log(
        '[INFO] Icons can stay hidden until Roblox moderation finishes, or until caches refresh (often several minutes).'
      );
    }

    try {
      const iconState = await getLocalizedGameIconRecords(client, universeId);
      const count = Array.isArray(iconState?.data) ? iconState.data.length : 0;
      console.log(`[INFO] Roblox currently reports ${count} localized icon record(s) for universe ${universeId}.`);
      if (count > 0) {
        const preview = iconState.data.slice(0, 5).map(formatIconRecordEntry).join(', ');
        console.log(`[INFO] Icon records preview -> ${preview}`);
        const pending = iconState.data.filter((entry) =>
          String(entry?.state || entry?.moderationState || entry?.status || '').includes('PendingReview')
        );
        if (pending.length) {
          console.log(
            `[INFO] ${pending.length} icon(s) are PendingReview — Roblox must approve them before they appear publicly.`
          );
        }
        const broken = iconState.data.filter((entry) => formatIconRecordEntry(entry).includes(':unknown'));
        if (broken.length) {
          console.log(
            `[WARN] ${broken.length} icon locale(s) still have no image id after upload. ` +
              'Roblox may show a placeholder until moderation completes or the locale is updated again.'
          );
        }
      }
    } catch (verifyErr) {
      console.log(`[WARN] Could not verify localized icon records: ${verifyErr.message}`);
    }
  } catch (err) {
    console.log(`[WARN] Icon upload failed: ${err.message}`);
  }

  try {
    await uploadExperienceThumbnail(client, universeId, mainPlaceId, experience);
  } catch (err) {
    console.log(`[WARN] Thumbnail cleanup/upload failed: ${err.message}`);
  }
}

function resolveKnownPlaceId(place) {
  return place?.id || place?.placeId || place?.PlaceId;
}

function findPlaceByNameContains(places, searchText, excludedIds = new Set()) {
  const target = String(searchText || '').trim().toLowerCase();
  if (!target) {
    return null;
  }
  return places.find((place) => {
    const placeId = resolveKnownPlaceId(place);
    if (excludedIds.has(String(placeId))) {
      return false;
    }
    const placeName = String(place?.name || place?.Name || '').toLowerCase();
    return placeName.includes(target);
  }) || null;
}

function resolveCreatedPlaceId(place) {
  return place?.placeId || place?.PlaceId || place?.id || place?.Id;
}

/**
 * Roblox game page URL for health checks. Uses the **Main place id** (root place), not the universe
 * id — matches https://www.roblox.com/games/{mainPlaceId}
 */
export function buildRobloxGameHealthUrl(mainPlaceId) {
  const id = normalizeUserId(mainPlaceId, 'Main place id');
  return `https://www.roblox.com/games/${id}`;
}

function slugifyRobloxGameName(name) {
  const slug = String(name || '')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  return slug;
}

function buildRobloxGameShareUrl(mainPlaceId, experienceName = '') {
  const id = normalizeUserId(mainPlaceId, 'Main place id');
  const slug = slugifyRobloxGameName(experienceName);
  return slug ? `https://www.roblox.com/games/${id}/${slug}` : `https://www.roblox.com/games/${id}`;
}

async function discordBotApiRequest(botToken, endpointPath, options = {}) {
  const client = new DiscordClient(botToken);
  return client.request(endpointPath, options);
}

class DiscordRateLimitError extends Error {
  constructor(message, retryAfterMs) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

async function discordBotApiRequestWithRateLimitRetry(botToken, endpointPath, options = {}) {
  const response = await discordBotApiRequest(botToken, endpointPath, options);
  if (response.status !== 429) {
    return response;
  }

  const resetAfterHeader = Number(response.headers.get('x-ratelimit-reset-after'));
  const retryAfterHeader = Number(response.headers.get('retry-after'));
  const bodyText = await response.text();
  let retryAfterMs = 2000;
  try {
    const payload = JSON.parse(bodyText);
    const retryAfterSec = Number(payload?.retry_after);
    if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
      retryAfterMs = Math.ceil(retryAfterSec * 1000);
    }
  } catch {
    // keep fallback
  }

  // Discord's headers are often more accurate than JSON body in burst situations.
  if (Number.isFinite(resetAfterHeader) && resetAfterHeader > 0) {
    retryAfterMs = Math.max(retryAfterMs, Math.ceil(resetAfterHeader * 1000));
  }
  if (Number.isFinite(retryAfterHeader) && retryAfterHeader > 0) {
    retryAfterMs = Math.max(retryAfterMs, Math.ceil(retryAfterHeader * 1000));
  }

  throw new DiscordRateLimitError(`Discord API rate limited: ${bodyText}`, retryAfterMs);
}

/**
 * Discord updates are cosmetic. They must never keep an upload (and its operation lock) waiting,
 * so pipelines call them through this wrapper: bounded wait, errors swallowed.
 */
async function boundedDiscord(label, task, timeoutMs = 20_000) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(task),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          console.log(`[WARN] Discord ${label} still pending after ${Math.round(timeoutMs / 1000)}s; continuing without waiting.`);
          resolve();
        }, timeoutMs);
      }),
    ]);
  } catch (err) {
    console.log(`[WARN] Discord ${label} failed: ${err?.message || err}`);
  } finally {
    clearTimeout(timer);
  }
}
const setSystemStatusBounded = (...args) => boundedDiscord('status message', () => setSystemStatus(...args));

function spawnDiscordTask(label, task) {
  // Fire-and-forget: each Discord action runs independently.
  Promise.resolve()
    .then(() => task())
    .catch((err) => {
      console.log(`[WARN] Discord background task failed (${label}): ${err.message}`);
    });
}

const discordLastRequestedChannelNames = new Map();
const discordLatestUpdateSeqByChannel = new Map();
let discordGlobalUpdateSeq = 0;
const discordChannelRateLimitUntilMs = new Map();
const discordChannelRetryTimers = new Map();

function beginDiscordChannelUpdate(channelId) {
  discordGlobalUpdateSeq += 1;
  const seq = discordGlobalUpdateSeq;
  discordLatestUpdateSeqByChannel.set(channelId, seq);
  return seq;
}

function isDiscordChannelUpdateStale(channelId, seq) {
  return (discordLatestUpdateSeqByChannel.get(channelId) || 0) !== seq;
}

function isDiscordChannelRateLimited(channelId) {
  const until = discordChannelRateLimitUntilMs.get(channelId) || 0;
  return Date.now() < until;
}

function getDiscordChannelRateLimitRemainingMs(channelId) {
  const until = discordChannelRateLimitUntilMs.get(channelId) || 0;
  return Math.max(0, until - Date.now());
}

function setDiscordChannelRateLimit(channelId, retryAfterMs) {
  const until = Date.now() + Math.max(0, Number(retryAfterMs) || 0);
  const prev = discordChannelRateLimitUntilMs.get(channelId) || 0;
  discordChannelRateLimitUntilMs.set(channelId, Math.max(prev, until));
}

function scheduleDiscordChannelRetry(channelId, label, delayMs, task) {
  const existing = discordChannelRetryTimers.get(channelId);
  if (existing) {
    clearTimeout(existing);
  }

  const waitMs = Math.max(100, Math.floor(Number(delayMs) || 0));
  const timer = setTimeout(() => {
    discordChannelRetryTimers.delete(channelId);
    spawnDiscordTask(label, task);
  }, waitMs);
  discordChannelRetryTimers.set(channelId, timer);
}

function isDiscordTransientServiceError(error) {
  const msg = String(error?.message || '');
  return msg.includes(' 502 ') || msg.includes(' 503 ') || msg.includes(' 504 ');
}

async function fetchUniversePlayerCount(universeId) {
  const id = normalizeUserId(universeId, 'experienceId');
  const payload = await requestJson(
    `https://games.roblox.com/v1/games?universeIds=${encodeURIComponent(id)}`,
    { headers: ROBLOX_PUBLIC_FETCH_HEADERS },
    { operation: 'Roblox live player count', retries: 4, timeoutMs: 15_000, baseMs: 1000, maxMs: 30_000 }
  );
  const playing = payload?.data?.[0]?.playing;
  return Number.isFinite(Number(playing)) ? Number(playing) : 0;
}

function buildVoiceChannelCountName(currentName, count) {
  const safeCount = Math.max(0, Math.floor(Number(count) || 0));
  const name = String(currentName || '').trim();
  const match = name.match(/^(.*?)(\d+)\s*$/);
  if (match) {
    return `${match[1]}${safeCount}`.trim();
  }
  if (name) {
    return `${name} ${safeCount}`;
  }
  return `Players ${safeCount}`;
}

async function updateDiscordVoiceChannelPlayerCount(config, count) {
  const botToken = String(config.monitor?.discordBotToken || '').trim();
  const voiceChannelId = String(config.monitor?.discordPlayerCountChannelId || '').trim();
  if (!botToken || !voiceChannelId) {
    return;
  }

  const seq = beginDiscordChannelUpdate(voiceChannelId);
  try {
    if (isDiscordChannelRateLimited(voiceChannelId)) {
      const remainingMs = getDiscordChannelRateLimitRemainingMs(voiceChannelId);
      const waitMs = Math.max(remainingMs, 100);
      console.log(`[INFO] Discord player-count channel update deferred by cooldown (${(waitMs / 1000).toFixed(1)}s remaining).`);
      scheduleDiscordChannelRetry(voiceChannelId, 'retry player-count after cooldown', waitMs, async () => {
        await updateDiscordVoiceChannelPlayerCount(config, count);
      });
      return;
    }

    const lastRequested = discordLastRequestedChannelNames.get(voiceChannelId);
    const desiredFromLast = buildVoiceChannelCountName(String(lastRequested || ''), count);
    if (lastRequested && desiredFromLast === lastRequested) {
      return;
    }

    const getChannelResponse = await discordBotApiRequestWithRateLimitRetry(
      botToken,
      `/channels/${encodeURIComponent(voiceChannelId)}`
    );
    if (isDiscordChannelUpdateStale(voiceChannelId, seq)) {
      return;
    }
    if (!getChannelResponse.ok) {
      const body = await getChannelResponse.text();
      throw new Error(`Discord get channel failed: ${getChannelResponse.status} ${getChannelResponse.statusText} ${body}`);
    }
    const channel = await getChannelResponse.json();
    if (isDiscordChannelUpdateStale(voiceChannelId, seq)) {
      return;
    }
    const currentName = String(channel?.name || '');
    const targetName = buildVoiceChannelCountName(currentName, count);
    if (lastRequested && targetName === lastRequested) {
      return;
    }
    if (targetName === currentName) {
      discordLastRequestedChannelNames.set(voiceChannelId, currentName);
      console.log(`[INFO] Discord player-count channel already set to "${currentName}".`);
      return;
    }

    const patchResponse = await discordBotApiRequestWithRateLimitRetry(
      botToken,
      `/channels/${encodeURIComponent(voiceChannelId)}`,
      {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({ name: targetName })
      }
    );
    if (isDiscordChannelUpdateStale(voiceChannelId, seq)) {
      return;
    }
    if (!patchResponse.ok) {
      const body = await patchResponse.text();
      throw new Error(`Discord rename channel failed: ${patchResponse.status} ${patchResponse.statusText} ${body}`);
    }

    discordLastRequestedChannelNames.set(voiceChannelId, targetName);
    console.log(`[SUCCESS] Updated Discord voice channel player count to ${Math.max(0, Math.floor(Number(count) || 0))}.`);
  } catch (err) {
    if (err instanceof DiscordRateLimitError) {
      const delayMs = Math.max(100, Math.floor(Number(err.retryAfterMs) || 0));
      setDiscordChannelRateLimit(voiceChannelId, delayMs);
      console.log(
        `[INFO] Discord player-count channel rate-limited. Retrying in ${(delayMs / 1000).toFixed(1)}s.`
      );
      scheduleDiscordChannelRetry(voiceChannelId, 'retry player-count after 429', delayMs, async () => {
        await updateDiscordVoiceChannelPlayerCount(config, count);
      });
      return;
    }
    if (isDiscordTransientServiceError(err)) {
      const delayMs = 30_000;
      setDiscordChannelRateLimit(voiceChannelId, delayMs);
      console.log(
        `[INFO] Discord player-count channel temporarily unavailable. Cooling down ${(delayMs / 1000).toFixed(1)}s; will try again on next normal update trigger.`
      );
      return;
    }
    console.log(`[WARN] Failed to update Discord voice channel player count: ${err.message}`);
  }
}

async function updateDiscordStatusChannel(config, status) {
  const botToken = String(config.monitor?.discordBotToken || '').trim();
  const statusChannelId = String(config.monitor?.discordStatusChannelId || '').trim();
  if (!botToken || !statusChannelId) {
    return;
  }

  const targetName = status === 'down'
    ? '🔴・DOWN'
    : status === 'reuploading'
      ? '🟡・REUPLOADING'
      : '🟢・UP';

  const seq = beginDiscordChannelUpdate(statusChannelId);
  try {
    if (isDiscordChannelRateLimited(statusChannelId)) {
      const remainingMs = getDiscordChannelRateLimitRemainingMs(statusChannelId);
      const waitMs = Math.max(remainingMs, 100);
      console.log(`[INFO] Discord status channel update deferred by cooldown (${(waitMs / 1000).toFixed(1)}s remaining).`);
      scheduleDiscordChannelRetry(statusChannelId, 'retry status after cooldown', waitMs, async () => {
        await updateDiscordStatusChannel(config, status);
      });
      return;
    }

    const lastRequested = discordLastRequestedChannelNames.get(statusChannelId);
    if (lastRequested === targetName) {
      return;
    }

    const getChannelResponse = await discordBotApiRequestWithRateLimitRetry(
      botToken,
      `/channels/${encodeURIComponent(statusChannelId)}`
    );
    if (isDiscordChannelUpdateStale(statusChannelId, seq)) {
      return;
    }
    if (!getChannelResponse.ok) {
      const body = await getChannelResponse.text();
      throw new Error(`Discord get status channel failed: ${getChannelResponse.status} ${getChannelResponse.statusText} ${body}`);
    }
    const channel = await getChannelResponse.json();
    if (isDiscordChannelUpdateStale(statusChannelId, seq)) {
      return;
    }
    const currentName = String(channel?.name || '');
    if (currentName === targetName) {
      discordLastRequestedChannelNames.set(statusChannelId, currentName);
      console.log(`[INFO] Discord status channel already set to "${currentName}".`);
      return;
    }

    const patchResponse = await discordBotApiRequestWithRateLimitRetry(
      botToken,
      `/channels/${encodeURIComponent(statusChannelId)}`,
      {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({ name: targetName })
      }
    );
    if (isDiscordChannelUpdateStale(statusChannelId, seq)) {
      return;
    }
    if (!patchResponse.ok) {
      const body = await patchResponse.text();
      throw new Error(`Discord rename status channel failed: ${patchResponse.status} ${patchResponse.statusText} ${body}`);
    }

    discordLastRequestedChannelNames.set(statusChannelId, targetName);
    console.log(`[SUCCESS] Updated Discord status channel to "${targetName}".`);
  } catch (err) {
    if (err instanceof DiscordRateLimitError) {
      const delayMs = Math.max(100, Math.floor(Number(err.retryAfterMs) || 0));
      setDiscordChannelRateLimit(statusChannelId, delayMs);
      console.log(
        `[INFO] Discord status channel rate-limited. Retrying in ${(delayMs / 1000).toFixed(1)}s.`
      );
      scheduleDiscordChannelRetry(statusChannelId, 'retry status after 429', delayMs, async () => {
        await updateDiscordStatusChannel(config, status);
      });
      return;
    }
    if (isDiscordTransientServiceError(err)) {
      const delayMs = 30_000;
      setDiscordChannelRateLimit(statusChannelId, delayMs);
      console.log(
        `[INFO] Discord status channel temporarily unavailable. Cooling down ${(delayMs / 1000).toFixed(1)}s; will try again on next normal update trigger.`
      );
      return;
    }
    console.log(`[WARN] Failed to update Discord status channel: ${err.message}`);
  }
}

function isGameLinkMessageContent(content) {
  const text = String(content || '').trim();
  if (!text) {
    return false;
  }

  const normalized = text.replace(/\s+/g, ' ').trim();
  const firstLine = normalized.split('\n')[0] || '';
  return (
    /^#\s*game\s*link\b/i.test(firstLine) ||
    /^\*{1,2}\s*game\s*link\s*\*{1,2}\b/i.test(firstLine) ||
    /^game\s*link\b/i.test(firstLine) ||
    /game\W*link/i.test(normalized) ||
    /https?:\/\/(?:www\.)?roblox\.com\/games\//i.test(normalized)
  );
}

function isGameLinkDiscordMessage(message) {
  if (isGameLinkMessageContent(message?.content || '')) {
    return true;
  }

  const embeds = Array.isArray(message?.embeds) ? message.embeds : [];
  for (const embed of embeds) {
    const blob = [
      embed?.title || '',
      embed?.description || '',
      embed?.url || ''
    ].join('\n');
    if (isGameLinkMessageContent(blob)) {
      return true;
    }
  }

  return false;
}

function messageHasRobloxGameUrl(message) {
  const content = String(message?.content || '');
  if (/https?:\/\/(?:www\.)?roblox\.com\/games\//i.test(content)) {
    return true;
  }

  const embeds = Array.isArray(message?.embeds) ? message.embeds : [];
  for (const embed of embeds) {
    const blob = [
      embed?.url || '',
      embed?.title || '',
      embed?.description || ''
    ].join('\n');
    if (/https?:\/\/(?:www\.)?roblox\.com\/games\//i.test(blob)) {
      return true;
    }
  }

  return false;
}

function updateDiscordLastGameLinkMessageIdInConfigFile(configPath, messageId) {
  const resolvedPath = path.resolve(configPath);
  const raw = fs.readFileSync(resolvedPath, 'utf8');
  const data = JSON.parse(raw);
  if (!data.monitor) {
    data.monitor = {};
  }
  data.monitor.discordLastGameLinkMessageId = messageId ? String(messageId) : '';
  normalizeAccountPoolKeyOrder(data);
  atomicWriteFile(resolvedPath, `${stringifyConfigWithInlineAssetArrays(data)}\n`, { backup: true });
}

async function updateDiscordVoiceChannelsAtUploadStart(config) {
  // Status channel is owned by discordStatusManager.setSystemStatus(), which uses
  // the fixed production channel ID. Only update the player-count channel here.
  await updateDiscordVoiceChannelPlayerCount(config, 0);
}

async function updateDiscordVoiceChannelsOnUploadFailure(config) {
  // Status channel is owned by discordStatusManager.setSystemStatus().
  await updateDiscordVoiceChannelPlayerCount(config, 0);
}

async function updateDiscordVoiceChannelsAfterSuccessfulUpload(config) {
  const monitorUniverseId =
    config.accountPool?.primary?.experienceId ||
    config.experienceId;
  let livePlayers = 0;
  if (monitorUniverseId) {
    try {
      livePlayers = await fetchUniversePlayerCount(monitorUniverseId);
    } catch (err) {
      console.log(`[WARN] Could not fetch live player count after upload: ${err.message}`);
    }
  } else {
    console.log('[WARN] Missing experienceId; cannot fetch live player count for Discord.');
  }
  await updateDiscordVoiceChannelPlayerCount(config, livePlayers);
}

async function postGameLinkToDiscordBot(config, mainPlaceId, { configPath } = {}) {
  const botToken = String(config.monitor?.discordBotToken || '').trim();
  const channelId = String(config.monitor?.discordChannelId || '').trim();
  if (!botToken || !channelId) {
    return;
  }

  const gameLink = buildRobloxGameShareUrl(mainPlaceId, config.experience?.name);
  const scanPagesRaw = Number(config.monitor?.discordScanPages);
  const maxPages = Number.isFinite(scanPagesRaw) && scanPagesRaw >= 1 ? Math.floor(scanPagesRaw) : 50;
  const lastMessageId = String(config.monitor?.discordLastGameLinkMessageId || '').trim();
  const deleteAllInChannel = Boolean(config.monitor?.discordDeleteAllMessagesInChannel);
  try {
    let before = '';
    let deletedCount = 0;
    let scannedCount = 0;

    if (lastMessageId) {
      console.log(`[INFO] Trying to delete previously posted game link message ${lastMessageId}...`);
      const deleteKnownResponse = await discordBotApiRequest(
        botToken,
        `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(lastMessageId)}`,
        { method: 'DELETE' }
      );
      if (deleteKnownResponse.ok) {
        deletedCount += 1;
      } else if (deleteKnownResponse.status !== 404) {
        const deleteBody = await deleteKnownResponse.text();
        console.log(
          `[WARN] Could not delete stored game link message ${lastMessageId}: ` +
            `${deleteKnownResponse.status} ${deleteKnownResponse.statusText} ${deleteBody}`
        );
      }
    }

    for (let page = 0; page < maxPages; page += 1) {
      const query = before ? `?limit=100&before=${encodeURIComponent(before)}` : '?limit=100';
      const listResponse = await discordBotApiRequest(botToken, `/channels/${encodeURIComponent(channelId)}/messages${query}`);
      if (!listResponse.ok) {
        const body = await listResponse.text();
        throw new Error(`Discord list messages failed: ${listResponse.status} ${listResponse.statusText} ${body}`);
      }

      const messages = await listResponse.json();
      if (!Array.isArray(messages) || messages.length === 0) {
        break;
      }
      scannedCount += messages.length;

      for (const message of messages) {
        const pinned = Boolean(message?.pinned);
        const matchedByMarker = isGameLinkDiscordMessage(message);
        const matchedByUrl = messageHasRobloxGameUrl(message);
        const looksLikeGameLink = matchedByMarker || matchedByUrl;
        const shouldDelete = !pinned && (deleteAllInChannel || looksLikeGameLink);
        if (shouldDelete) {
          const messageId = String(message?.id || '').trim();
          if (!messageId) {
            continue;
          }
          const deleteResponse = await discordBotApiRequest(
            botToken,
            `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
            { method: 'DELETE' }
          );
          if (!deleteResponse.ok && deleteResponse.status !== 404) {
            const deleteBody = await deleteResponse.text();
            console.log(
              `[WARN] Could not delete old #GAME LINK message ${messageId}: ` +
                `${deleteResponse.status} ${deleteResponse.statusText} ${deleteBody}`
            );
            if (deleteResponse.status === 403) {
              console.log(
                '[WARN] Discord bot likely lacks Manage Messages permission in the links channel. ' +
                  'Grant View Channel, Read Message History, Manage Messages, and Send Messages.'
              );
            }
          } else if (deleteResponse.ok) {
            deletedCount += 1;
          }
        }
      }

      before = String(messages[messages.length - 1]?.id || '').trim();
      if (!before) {
        break;
      }
    }
    console.log(`[INFO] Discord scan complete: scanned ${scannedCount} messages, deleted ${deletedCount} old #GAME LINK message(s).`);
    if (deletedCount > 0) {
      console.log(`[INFO] Deleted ${deletedCount} previous #GAME LINK message(s) from channel ${channelId}.`);
    }

    const response = await discordBotApiRequest(botToken, `/channels/${encodeURIComponent(channelId)}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        content: `# GAME LINK\n${gameLink}`
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Discord post message failed: ${response.status} ${response.statusText} ${body}`);
    }
    let newMessageId = '';
    try {
      const body = await response.json();
      newMessageId = String(body?.id || '').trim();
    } catch {
      // ignore parse issues; message still posted successfully
    }
    if (newMessageId) {
      config.monitor = config.monitor || {};
      config.monitor.discordLastGameLinkMessageId = newMessageId;
      if (configPath) {
        updateDiscordLastGameLinkMessageIdInConfigFile(configPath, newMessageId);
      }
    }
    console.log(`[SUCCESS] Posted game link to Discord channel ${channelId}: ${gameLink}`);
  } catch (err) {
    console.log(`[WARN] Failed to post game link via Discord bot: ${err.message}`);
  }
}

export function updateMonitorHealthUrlInConfigFile(configPath, mainPlaceId) {
  const resolvedPath = path.resolve(configPath);
  const raw = fs.readFileSync(resolvedPath, 'utf8');
  const data = JSON.parse(raw);
  if (!data.monitor) {
    data.monitor = {};
  }

  data.monitor.healthUrl = buildRobloxGameHealthUrl(mainPlaceId);
  normalizeAccountPoolKeyOrder(data);
  normalizeMonitorKeyOrder(data);
  atomicWriteFile(resolvedPath, `${stringifyConfigWithInlineAssetArrays(data)}\n`, { backup: true });
  console.log(`[SUCCESS] Updated monitor.healthUrl in ${resolvedPath}`);
  console.log(`[INFO] ${data.monitor.healthUrl}`);
}

/**
 * Group members with "edit" rights get canCloudEdit=true but canManage=false from Roblox, so
 * requiring canManage alone rejects valid group accounts. Accept either flag, and if the
 * permissions endpoint is silent, fall back to probing an endpoint that needs edit access.
 */
export async function assertCanEditUniverse(client, universeId, config = {}) {
  let permissions = null;
  let permissionsError = '';
  try {
    permissions = await getUniversePermissions(client, universeId);
  } catch (err) {
    permissionsError = err?.message || String(err);
  }
  console.log(`[INFO] Universe ${universeId} permissions for creator account: ${JSON.stringify(permissions ?? null)}${permissionsError ? ` (lookup error: ${permissionsError})` : ''}`);
  if (permissions?.canManage || permissions?.canCloudEdit) {
    return permissions;
  }

  try {
    const places = await getUniversePlaces(client, universeId);
    if (Array.isArray(places?.data) && places.data.length > 0) {
      console.log('[WARN] Permissions endpoint did not report edit access, but the account can list this universe\'s places; continuing.');
      return permissions;
    }
  } catch (err) {
    permissionsError = permissionsError || err?.message || String(err);
  }

  const groupMode = isGroupOpenCloudModeEnabled(config);
  const groupId = resolveExperienceGroupId(config);
  const groupApiKey = resolveGroupOpenCloudApiKey(config, 'Main');
  const groupOwnerCookie = resolveGroupOwnerCookie(config);
  if (groupMode && groupId && (groupApiKey || groupOwnerCookie)) {
    console.log(
      `[INFO] Roblox permissions endpoint returned ${JSON.stringify(permissions ?? null)} for group-owned universe ${universeId}; ` +
        `continuing with group credentials (groupId=${groupId}, groupApiKey=${groupApiKey ? 'configured' : 'not configured'}, ` +
        `groupOwnerCookie=${groupOwnerCookie ? 'configured' : 'not configured'}). ` +
        'The actual group-owner/group-role permissions will be enforced by the subsequent Roblox write operations.'
    );
    return permissions;
  }

  throw new Error(
    `Configured creator account cannot edit universe ${universeId} (permissions: ${JSON.stringify(permissions ?? null)}${permissionsError ? `; ${permissionsError}` : ''}). ` +
    'Check that the cookie belongs to the account that has edit/manage rights on this universe, that experienceId is the universe ID (not a place ID), and that the cookie has not expired. ' +
    'For group games the member needs a role with edit access to the group experiences.'
  );
}

async function resolveExperiencePlaceIds(client, config) {
  const experience = config.experience;
  const universeId = requireValue(config.experienceId, 'experienceId');
  requireValue(experience?.name, 'experience.name');
  requireValue(experience?.description, 'experience.description');
  requireValue(experience?.rbxlPath, 'experience.rbxlPath');

  const universeDetails = await getUniverseDetails(client, universeId);
  if (universeDetails) {
    const detectedGroup = applyDetectedGroupOwnership(config, universeDetails);
    if (detectedGroup) {
      const detectedGroupId = universeDetails?.creator?.id;
      console.log(
        `[INFO] Roblox reports universe ${universeId} is group-owned ` +
          `(groupId ${detectedGroupId ?? 'unknown'}); using group credential mode.`
      );
    }
  }

  await assertCanEditUniverse(client, universeId, config);

  if (isGroupOpenCloudModeEnabled(config)) {
    const gid = resolveExperienceGroupId(config);
    if (gid) {
      console.log(
        `[INFO] Group experience mode (isGroup): universe ${universeId}, groupId ${gid}. ` +
          'Open Cloud publish/PATCH uses groupApiKey when set; creator cookie still drives develop.roblox.com and dashboard fallbacks.'
      );
    } else {
      console.log(
        `[INFO] Group experience mode (isGroup): universe ${universeId}. ` +
          'Set groupId for clearer dashboard URLs; Open Cloud still works if groupApiKey is group-scoped.'
      );
    }
  }

  const placesResponse = await getUniversePlaces(client, universeId);
  const existingPlaces = placesResponse.data || [];
  const rootPlaceId = await resolveMainPlaceIdForStudioShortcut(client, config, universeId);
  const mainPlace = existingPlaces.find((place) => String(resolveKnownPlaceId(place)) === String(rootPlaceId)) || existingPlaces[0];
  const mainPlaceId = resolveKnownPlaceId(mainPlace);

  const mainId = String(resolveKnownPlaceId(mainPlace) ?? '');
  const nonMainPlaces = existingPlaces.filter((place) => String(resolveKnownPlaceId(place) ?? '') !== mainId);

  const battlePlaceByName = findPlaceByNameContains(nonMainPlaces, 'battle');
  const battlePlace = battlePlaceByName || nonMainPlaces[0] || existingPlaces[0] || mainPlace || null;

  const battleId = String(resolveKnownPlaceId(battlePlace) ?? '');
  const tradeCandidates = nonMainPlaces.filter((place) => String(resolveKnownPlaceId(place) ?? '') !== battleId);
  const tradePlaceByName = findPlaceByNameContains(tradeCandidates, 'trade');
  const tradePlace = tradePlaceByName || tradeCandidates[0] || nonMainPlaces[0] || existingPlaces[1] || existingPlaces[0] || mainPlace || null;

  const placeIds = {
    Main: resolveKnownPlaceId(mainPlace),
    Battle: resolveKnownPlaceId(battlePlace),
    Trade: resolveKnownPlaceId(tradePlace)
  };

  requireValue(placeIds.Main, 'Main place id');
  requireValue(placeIds.Battle, 'Battle place id');
  requireValue(placeIds.Trade, 'Trade place id');

  logOpenCloudApiKeyHintIfMissing(config);

  return { universeId, placeIds, experience };
}

function resolveConfiguredRbxlPath(rawPath, configPath = '', placeKey = 'Main') {
  const configured = String(rawPath || '').trim();
  if (!configured) {
    throw new Error(`No RBXL source path configured for ${placeKey}. Set experience.rbxlPath or experience.rbxlPaths.`);
  }

  const candidates = [];
  if (path.isAbsolute(configured)) {
    candidates.push(path.resolve(configured));
  } else {
    // On Railway the live config commonly lives in /data/config.json. Prefer a file
    // next to that config (persistent storage) before falling back to the app bundle.
    if (configPath) candidates.push(path.resolve(path.dirname(path.resolve(configPath)), configured));
    if (process.env.DATA_DIR) candidates.push(path.resolve(process.env.DATA_DIR, configured));
    candidates.push(path.resolve(configured));
  }

  const uniqueCandidates = [...new Set(candidates)];
  const existing = uniqueCandidates.find((candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  });

  if (!existing) {
    throw new Error(
      `RBXL source for ${placeKey} was not found. Configured path: "${configured}". Checked: ${uniqueCandidates.join(' | ')}. ` +
      'Upload the NEW .rbxl file to Railway storage and set experience.rbxlPath (or experience.rbxlPaths) to that exact path.'
    );
  }

  const stat = fs.statSync(existing);
  if (stat.size <= 0) throw new Error(`RBXL source for ${placeKey} is empty: ${existing}`);
  return existing;
}

async function uploadExperienceRbxlPlaces(universeId, placeIds, config, experience, { configPath = '' } = {}) {
  let rbxlSkipKeyLogged = false;
  const uploadedPlaceIds = new Set();

  // Freeze the chosen source bytes before any place is uploaded. This prevents a
  // file replacement during the pipeline from making Main/Battle/Trade diverge.
  const sourceByPlace = new Map();
  const sharedBufferByPath = new Map();
  for (const key of PLACE_KEYS) {
    const placeOverride = experience?.rbxlPaths && typeof experience.rbxlPaths === 'object'
      ? experience.rbxlPaths[key]
      : null;
    const configuredSource = placeOverride || experience?.rbxlPath;
    const sourcePath = resolveConfiguredRbxlPath(configuredSource, configPath, key);
    let sourceBuffer = sharedBufferByPath.get(sourcePath);
    if (!sourceBuffer) {
      sourceBuffer = fs.readFileSync(sourcePath);
      sharedBufferByPath.set(sourcePath, sourceBuffer);
    }
    const sha256 = createHash('sha256').update(sourceBuffer).digest('hex');
    sourceByPlace.set(key, { path: sourcePath, buffer: sourceBuffer, bytes: sourceBuffer.length, sha256 });
    console.log(`[INFO] RBXL source selected for ${key}: path="${sourcePath}" bytes=${sourceBuffer.length} sha256=${sha256}`);
  }
  const groupMode = isGroupOpenCloudModeEnabled(config);
  const keySource = describeOpenCloudKeySource(config, 'Main');
  if (keySource !== 'none') {
    console.log(
      `[INFO] Open Cloud RBXL publish (groupMode=${groupMode}) will use ${keySource}.`
    );
  } else if (groupMode) {
    console.log('[WARN] groupMode is true but no groupApiKey or apiKey was found on accountPool.primary.');
  }

  for (const key of PLACE_KEYS) {
    const targetPlaceId = String(placeIds[key]);
    if (uploadedPlaceIds.has(targetPlaceId)) {
      console.log(`[INFO] Skipping RBXL upload to ${key} place ${placeIds[key]} (duplicate target place id).`);
      continue;
    }

    const selectedCredential = await selectOpenCloudPublishCredential(config, universeId, placeIds[key], key);
    const apiKey = selectedCredential.apiKey;
    if (!apiKey) {
      if (!rbxlSkipKeyLogged) {
        rbxlSkipKeyLogged = true;
        const keyHint = isGroupOpenCloudModeEnabled(config)
          ? 'set accountPool.primary.groupApiKey (group Open Cloud key) or apiKey'
          : 'set accountPool.primary.apiKey with Universe Places → Write (user-owned experience)';
        console.log(`[WARN] Skipping RBXL uploads for all places: no Open Cloud API key (${keyHint} in config.json).`);
      } else {
        console.log(`[WARN] Skipping RBXL upload to ${key} place ${placeIds[key]}.`);
      }
      continue;
    }

    try {
      const source = sourceByPlace.get(key);
      await uploadPlaceFile(
        universeId,
        placeIds[key],
        source.buffer,
        apiKey,
        config,
        key,
        selectedCredential.source
      );
      uploadedPlaceIds.add(targetPlaceId);
      console.log(`[SUCCESS] Uploaded RBXL to ${key} place ${placeIds[key]} (${selectedCredential.source}); sourceSha256=${sourceByPlace.get(key).sha256}`);
    } catch (err) {
      // If the preferred group key is wrong/stale, try a distinct user API key that is
      // already configured. A working personal key can publish to group experiences
      // when its own scope and the account's group permissions allow it.
      const alternateApiKey = resolveUserOpenCloudApiKey(config, key);
      const canTryAlternate = isOpenCloudInsufficientScopesError(err)
        && alternateApiKey
        && trimConfigSecret(alternateApiKey) !== trimConfigSecret(apiKey);
      if (canTryAlternate) {
        const alternateSource = describeUserOpenCloudKeySource(config, key);
        console.log('[WARN] Preferred Open Cloud key was rejected for place publishing; trying the distinct configured alternate key (' + alternateSource + ').');
        try {
          const source = sourceByPlace.get(key);
          await uploadPlaceFile(
            universeId,
            placeIds[key],
            source.buffer,
            alternateApiKey,
            config,
            key,
            alternateSource
          );
          uploadedPlaceIds.add(targetPlaceId);
          console.log(`[SUCCESS] Uploaded RBXL to ${key} place ${placeIds[key]} using alternate Open Cloud key (${alternateSource}); sourceSha256=${sourceByPlace.get(key).sha256}`);
          continue;
        } catch (alternateErr) {
          if (isOpenCloudInsufficientScopesError(alternateErr)) {
            throw new Error(
              `Both configured Open Cloud keys were rejected for place ${placeIds[key]}. ` +
              `Preferred source ${describeOpenCloudKeySource(config, key)} failed: ${err.message} ` +
              `Alternate source ${alternateSource} failed: ${alternateErr.message}`
            );
          }
          throw alternateErr;
        }
      }

      if (isMissingOpenCloudApiKey(err)) {
        if (!rbxlSkipKeyLogged) {
          rbxlSkipKeyLogged = true;
          const keyHint = isGroupOpenCloudModeEnabled(config)
            ? 'set accountPool.primary.groupApiKey (group Open Cloud key) or apiKey'
            : 'set accountPool.primary.apiKey with Universe Places → Write (user-owned experience)';
          console.log(`[WARN] Skipping RBXL uploads for all places: no Open Cloud API key (${keyHint} in config.json).`);
        } else {
          console.log(`[WARN] Skipping RBXL upload to ${key} place ${placeIds[key]}.`);
        }
        continue;
      }

      if (isOpenCloudInsufficientScopesError(err)) {
        console.log(`[FAIL] ${err.message}`);
        throw err;
      }

      throw err;
    }
  }
}

function isOpenCloudInsufficientScopesError(error) {
  return error instanceof Error && error.message.includes('insufficient scopes');
}

async function configureUniverseAndPlacesOnly(client, config) {
  const { universeId, placeIds, experience } = await resolveExperiencePlaceIds(client, config);

  await configureUniverse(client, universeId, experience, config);

  for (const key of PLACE_KEYS) {
    try {
      const socialSlotType = resolveSocialSlotType(experience, key);
      await configurePlace(client, placeIds[key], {
        name: experience.places?.[key]?.name || key,
        maxPlayers: experience.maxPlayers || 30,
        allowCopying: experience.allowCopying === true,
        socialSlotType
      });
      console.log(
        `[SUCCESS] Configured ${key} place ${placeIds[key]} (social slots: ${socialSlotType === 'Empty' ? 'disabled' : socialSlotType})`
      );
    } catch (err) {
      if (!isRobloxUnauthorized(err)) {
        throw err;
      }

      console.log(`[WARN] Creator account is not authorized to configure ${key} place ${placeIds[key]}; skipping place configuration.`);
    }
  }

  await configureExperiencePlaceAccessControl(config, universeId);

  await runExperienceQuestionnaire(client, universeId, config);
  await ensureUniversePublicAndDevices(client, universeId, experience, config, placeIds.Main);

  return { universeId, placeIds, experience };
}

async function configureExistingExperience(client, config, { configPath = '' } = {}) {
  const { universeId, placeIds, experience } = await configureUniverseAndPlacesOnly(client, config);

  await uploadExperienceRbxlPlaces(universeId, placeIds, config, experience, { configPath });

  await configureMedia(
    client,
    universeId,
    placeIds.Main,
    experience,
    resolveCookie(requireValue(config.creatorAccount, 'creatorAccount'), 'creatorAccount'),
    config
  );
  await writePlaceIds(config, placeIds, { configPath });

  return { universeId, placeIds };
}

export async function runRbxlUploadOnly(config, { configPath } = {}) {
  config = withPrimaryAccountApplied(config);
  const creatorAccount = requireValue(config.creatorAccount, 'creatorAccount');
  const creatorClient = new RobloxClient(resolveCookie(creatorAccount, 'creatorAccount'), creatorAccount.name || 'creator account');
  await getAuthenticatedUser(creatorClient);
  const { universeId, placeIds, experience } = await resolveExperiencePlaceIds(creatorClient, config);
  await uploadExperienceRbxlPlaces(universeId, placeIds, config, experience);
  if (configPath) {
    const mainPlaceId = requireValue(placeIds?.Main, 'Main place id after RBXL upload');
    updateMonitorHealthUrlInConfigFile(configPath, mainPlaceId);
  }
  console.log('[INFO] RBXL-only upload finished.');
}

/**
 * Configure universe/game + Main/Battle/Trade + experience media on Roblox only.
 * No RBXL upload, friends/grants, placeids.json/git, or monitor.healthUrl updates.
 */
export async function runConfigureExperienceOnly(config) {
  config = withPrimaryAccountApplied(config);
  const creatorAccount = requireValue(config.creatorAccount, 'creatorAccount');
  const creatorClient = new RobloxClient(resolveCookie(creatorAccount, 'creatorAccount'), creatorAccount.name || 'creator account');
  await getAuthenticatedUser(creatorClient);

  const { universeId, placeIds, experience } = await configureUniverseAndPlacesOnly(creatorClient, config);
  await configureMedia(
    creatorClient,
    universeId,
    placeIds.Main,
    experience,
    resolveCookie(creatorAccount, 'creatorAccount'),
    config
  );

  console.log('[INFO] Configure-places pipeline finished.');
}

/**
 * Push place IDs only by discovering places from the Roblox experience and
 * using placeIds.git settings. Does not create missing places.
 */
export async function runPushPlaceIdsOnly(config, { configPath = '' } = {}) {
  config = withPrimaryAccountApplied(config);
  const creatorAccount = requireValue(config.creatorAccount, 'creatorAccount');
  const creatorClient = new RobloxClient(resolveCookie(creatorAccount, 'creatorAccount'), creatorAccount.name || 'creator account');
  await getAuthenticatedUser(creatorClient);
  const { placeIds } = await resolveExperiencePlaceIds(creatorClient, config);
  await writePlaceIds(config, placeIds, { configPath });
  console.log('[INFO] Push-placeids pipeline finished.');
}

/**
 * Normal upload: configure + RBXL + media + placeIds + health URL update.
 * Skips friend automation, universe edit grants, Open Cloud asset grants, and unfriend helper.
 */
export async function runNormalUploadPipeline(config, { configPath } = {}) {
  config = withPrimaryAccountApplied(config);
  const creatorAccount = requireValue(config.creatorAccount, 'creatorAccount');
  const creatorClient = new RobloxClient(resolveCookie(creatorAccount, 'creatorAccount'), creatorAccount.name || 'creator account');
  await getAuthenticatedUser(creatorClient);

  console.log('[INFO] Normal upload: configuring and publishing without friends/grants...');
  await setSystemStatusBounded(SYSTEM_STATUS.REUPLOADING, {
    gameLink: config.monitor?.healthUrl || '',
    operation: 'normalupload',
    target: config.experience?.name || config.experienceId || 'current experience'
  }, config);
  await boundedDiscord('updateDiscordVoiceChannelsAtUploadStart', () => updateDiscordVoiceChannelsAtUploadStart(config));
  let placeIds;
  try {
    ({ placeIds } = await configureExistingExperience(creatorClient, config, { configPath }));
  } catch (err) {
    await boundedDiscord('updateDiscordVoiceChannelsOnUploadFailure', () => updateDiscordVoiceChannelsOnUploadFailure(config));
    await setSystemStatusBounded(SYSTEM_STATUS.DOWN, { gameLink: config.monitor?.healthUrl || '', operation: 'normalupload', reason: err.message, forceAnnouncement: true }, config);
    throw err;
  }

  if (configPath) {
    const mainPlaceId = requireValue(placeIds?.Main, 'Main place id after normal upload');
    updateMonitorHealthUrlInConfigFile(configPath, mainPlaceId);
    await boundedDiscord('updateDiscordVoiceChannelsAfterSuccessfulUpload', () => updateDiscordVoiceChannelsAfterSuccessfulUpload(config));
    await setSystemStatusBounded(SYSTEM_STATUS.UP, {
      gameLink: buildRobloxGameShareUrl(mainPlaceId, config.experience?.name),
      target: config.experience?.name || mainPlaceId,
      forceAnnouncement: true
    }, config);
  }

  console.log('[INFO] Normal upload pipeline finished.');
  return { placeIds };
}

/**
 * Same asset slice as a full upload: Roblox friends + universe edit access, Open Cloud asset Use
 * grants, then unfriend helper (no RBXL / universe description / media).
 */
export async function runGrantPermissionsPipeline(config) {
  config = withPrimaryAccountApplied(config);
  const { creatorClient, friendTargetUserId } = await connectFriendAccounts(config);
  if (!creatorClient) {
    throw new Error('connectFriendAccounts returned no creatorClient; check friendAutomation / creatorAccount cookie.');
  }

  console.log('[INFO] Running Open Cloud asset Use grants...');
  await grantAllPermissions(config);
  console.log('[INFO] Open Cloud asset grants done; post-grant cleanup next...');
  try {
    await openUnfriendTabs(config, friendTargetUserId);
    console.log('[INFO] Post-grant cleanup finished.');
  } catch (err) {
    console.log(`[WARN] Post-grant cleanup failed: ${err.message}`);
  }

  console.log('[INFO] Grant-assets pipeline finished (friends → grants → cleanup).');
}

/**
 * Friend linking only, then open Roblox Studio on the Main place so you can grant collaborators /
 * permissions manually (no automatic Team Create API grants, no Open Cloud asset grants here).
 */
export async function runGrantFriendsPipeline(config) {
  config = withPrimaryAccountApplied(config);
  const { creatorClient } = await connectFriendAccounts(config, { skipUniverseEditGrants: true });
  if (!creatorClient) {
    throw new Error('connectFriendAccounts returned no creatorClient; check friendAutomation / creatorAccount cookie.');
  }

  const experienceId = config.experienceId;
  if (!experienceId) {
    console.log('[WARN] Missing experienceId; cannot open Studio. Friend step done.');
    console.log('[INFO] Grant-friends (Studio) pipeline finished.');
    return;
  }

  const mainPlaceId = await resolveMainPlaceIdForStudioShortcut(creatorClient, config, experienceId);
  if (!mainPlaceId) {
    throw new Error(
      'Could not resolve Main place id for Studio. Ensure the universe resolves via the games API.'
    );
  }

  const permissionsUrl = buildCreatorDashboardPermissionsUrl(experienceId);
  console.log(
    isRemoteServerRuntime()
      ? '[ACTION REQUIRED] Roblox Studio is unavailable on Railway. Grant Edit in Creator Dashboard → Permissions, then click Continue.'
      : '[ACTION REQUIRED] In Roblox Studio: Game Settings → Permissions (or Collaborators), grant each asset account Edit access, then File → Publish to Roblox if needed.'
  );

  let promptUrl = permissionsUrl;
  if (isRemoteServerRuntime()) {
    const creatorCookie = resolveCookie(config.creatorAccount, 'creatorAccount');
    if (creatorCookie) {
      const session = await createRobloxPlaywrightSession(creatorCookie, permissionsUrl);
      if (session) {
        console.log('[ACTION REQUIRED] Opened Creator Dashboard permissions in automation browser (see dashboard screenshots).');
      }
    }
  } else {
    const launch = await tryOpenRobloxStudioForEdit(config, experienceId, mainPlaceId);
    promptUrl = launch.studioUrl;
    if (launch.method === 'cli') {
      console.log(
        `[ACTION REQUIRED] Launched Studio (${launch.studioPath}) with EditPlace — universeId=${launch.universeIdStr} placeId=${launch.placeIdStr}.`
      );
    } else if (launch.opened) {
      console.log(`[ACTION REQUIRED] Launched Studio protocol link: ${launch.studioUrl}`);
    } else {
      console.log(`[ACTION REQUIRED] Could not auto-open Studio. Open manually: ${launch.studioUrl}`);
    }
  }

  await waitForEnterPrompt(
    isRemoteServerRuntime()
      ? '\nClick Continue after Edit access is saved in Creator Dashboard...'
      : '\nPress Enter when you are done saving permissions from Studio...',
    { studioUrl: promptUrl, permissionsUrl }
  );

  console.log('[INFO] Grant-friends (friend requests + Studio) pipeline finished.');
}

export async function runFullUploadPipeline(config, { configPath } = {}) {
  config = withPrimaryAccountApplied(config);
  const { creatorClient, friendTargetUserId } = await connectFriendAccounts(config);
  if (!creatorClient) {
    throw new Error('connectFriendAccounts returned no creatorClient; check friendAutomation / creatorAccount cookie.');
  }

  console.log('[INFO] Running permissions granter after edit-permission verification...');
  await grantAllPermissions(config);
  console.log('[INFO] Open Cloud asset grants done; continuing (unfriend tabs → configure/upload)...');
  try {
    await openUnfriendTabs(config, friendTargetUserId);
    console.log('[INFO] Unfriend tab step finished.');
  } catch (err) {
    console.log(`[WARN] Unfriend tab step failed (continuing to reupload): ${err.message}`);
  }

  console.log('[INFO] Starting experience configure / publish step...');
  await setSystemStatusBounded(SYSTEM_STATUS.REUPLOADING, {
    gameLink: config.monitor?.healthUrl || '',
    operation: 'fullupload',
    target: config.experience?.name || config.experienceId || 'current experience'
  }, config);
  await boundedDiscord('updateDiscordVoiceChannelsAtUploadStart', () => updateDiscordVoiceChannelsAtUploadStart(config));
  let placeIds;
  try {
    ({ placeIds } = await configureExistingExperience(creatorClient, config, { configPath }));
  } catch (err) {
    await boundedDiscord('updateDiscordVoiceChannelsOnUploadFailure', () => updateDiscordVoiceChannelsOnUploadFailure(config));
    await setSystemStatusBounded(SYSTEM_STATUS.DOWN, { gameLink: config.monitor?.healthUrl || '', operation: 'fullupload', reason: err.message, forceAnnouncement: true }, config);
    throw err;
  }

  if (configPath) {
    const mainPlaceId = requireValue(placeIds?.Main, 'Main place id after upload');
    updateMonitorHealthUrlInConfigFile(configPath, mainPlaceId);
    await boundedDiscord('updateDiscordVoiceChannelsAfterSuccessfulUpload', () => updateDiscordVoiceChannelsAfterSuccessfulUpload(config));
    await setSystemStatusBounded(SYSTEM_STATUS.UP, {
      gameLink: buildRobloxGameShareUrl(mainPlaceId, config.experience?.name),
      target: config.experience?.name || mainPlaceId,
      forceAnnouncement: true
    }, config);
  }

  console.log('[INFO] Full upload pipeline finished.');
  return { placeIds };
}

function parseOptionalYes(input) {
  const t = String(input || '').trim().toLowerCase();
  return t === 'y' || t === 'yes' || t === '1' || t === 'true';
}

function parseOptionalDigits(input, label) {
  const t = String(input || '').trim();
  if (!t) {
    return '';
  }
  if (!/^\d+$/.test(t)) {
    throw new Error(`${label} must be numeric digits only (got "${t.slice(0, 40)}${t.length > 40 ? '…' : ''}").`);
  }
  return t;
}

export async function runModeAddBackupAccount(configPath) {
  const resolvedConfigPath = path.resolve(configPath);
  const config = loadRawConfig(resolvedConfigPath);
  if (!config.accountPool) {
    config.accountPool = {};
  }
  if (!config.accountPool.backups) {
    config.accountPool.backups = [];
  }

  const rl = createPromptInterface();

  try {
    console.log('[MODE] add-backup-account');
    console.log('Enter required pool fields first. Group / Open Cloud fields are optional.');
    console.log('[INFO] Answer each question in the dashboard **Manual prompt** box.\n');

    const name = (await rl.question('Backup account name: ')).trim();
    const userIdRaw = (await rl.question('Backup account userId: ')).trim();
    const cookie = (await rl.question('Backup account .ROBLOSECURITY cookie: ')).trim();
    const apiKey = (await rl.question('Backup account Open Cloud API key (user key, used when no group key): ')).trim();
    const defaultExperienceId = String(
      config.accountPool?.primary?.experienceId ||
      config.experienceId ||
      ''
    ).trim();
    const experienceIdInput = (await rl.question(
      `Backup account experienceId${defaultExperienceId ? ` (default ${defaultExperienceId})` : ''}: `
    )).trim();
    const experienceId = experienceIdInput || defaultExperienceId;
    if (!name || !userIdRaw || !cookie || !apiKey || !experienceId) {
      throw new Error('Required: name, userId, cookie, apiKey, experienceId.');
    }

    const userIdDigits = parseOptionalDigits(userIdRaw, 'userId');
    const experienceIdDigits = parseOptionalDigits(String(experienceId), 'experienceId');
    const userId = Number(userIdDigits);
    const experienceIdNum = Number(experienceIdDigits);
    if (!Number.isFinite(userId) || !Number.isFinite(experienceIdNum)) {
      throw new Error('userId and experienceId must be valid numbers.');
    }

    console.log('\n--- Optional: group-owned experience (isGroup) ---');
    console.log('Skip this section unless this backup uses a Roblox group Open Cloud key / group join flow.');
    const wantGroup = parseOptionalYes(await rl.question('Configure group fields for this backup? [y/N]: '));

    let groupId = '';
    let groupApiKey = '';
    let groupOwnerUserId = '';
    let groupOwnerName = '';
    let groupOwnerCookie = '';
    let isGroup = false;

    if (wantGroup) {
      isGroup = true;
      const groupIdInput = (await rl.question('Roblox groupId (digits; required if you enabled group fields): ')).trim();
      groupId = parseOptionalDigits(groupIdInput, 'groupId');
      if (!groupId) {
        throw new Error('groupId is required when group fields are enabled (or answer N to skip the group section).');
      }

      groupApiKey = (await rl.question('Group Open Cloud API key (optional; Enter to skip): ')).trim();
      const gouRaw = (await rl.question('groupOwnerUserId — owner Roblox user id (optional; Enter to skip): ')).trim();
      if (gouRaw) {
        groupOwnerUserId = parseOptionalDigits(gouRaw, 'groupOwnerUserId');
      }
      groupOwnerName = (await rl.question('groupOwnerName — label for logs (optional; Enter to skip): ')).trim();
      groupOwnerCookie = (await rl.question('groupOwnerCookie — owner .ROBLOSECURITY for rank browser (optional; Enter to skip): ')).trim();
    }

    const backup = {
      name,
      experienceId: experienceIdNum,
      userId,
      cookie,
      apiKey
    };
    if (isGroup) {
      backup.isGroup = true;
      backup.groupId = Number(groupId);
      if (groupApiKey) {
        backup.groupApiKey = groupApiKey;
      }
      if (groupOwnerUserId) {
        backup.groupOwnerUserId = Number(groupOwnerUserId);
      }
      if (groupOwnerName) {
        backup.groupOwnerName = groupOwnerName;
      }
      if (groupOwnerCookie) {
        backup.groupOwnerCookie = groupOwnerCookie;
      }
    }

    config.accountPool.backups.push(backup);
    saveRawConfig(resolvedConfigPath, config);
    console.log(`[SUCCESS] Added backup account: ${name}`);

    const grantRow = accountToGrantRow(config, backup);
    const modeConfig = structuredClone(config);
    modeConfig.accountPool = modeConfig.accountPool || {};
    modeConfig.accountPool.primary = backup;
    modeConfig.assetAccounts = [...(config.assetAccounts || [])];
    console.log('[INFO] Running Grant Full Permissions flow targeting the new backup account...');
    await runGrantPermissionsPipeline(modeConfig);
    console.log('[SUCCESS] Preloaded full permissions for this backup account.');
  } finally {
    rl.close();
  }
}

export async function runMonitorService(configPath) {
  const resolvedConfigPath = path.resolve(configPath);
  console.log(`[INFO] Monitor service started (config: ${resolvedConfigPath}). Ctrl+C to stop.`);

  let uploadSuspendedModerationNoBackups = false;

  while (true) {
    let config;
    try {
      config = loadRawConfig(resolvedConfigPath);
    } catch (err) {
      console.error(`[FAIL] Could not read config: ${err.message}`);
      await sleep(30_000);
      continue;
    }

    const intervalMs = Number(config.monitor?.intervalMs);
    const waitMs = Number.isFinite(intervalMs) && intervalMs >= 10_000 ? intervalMs : 300_000;

    const healthUrl = config.monitor?.healthUrl;
    console.log(`[INFO] Health check: ${healthUrl || '(none; treating as unhealthy)'}`);

    const decision = await evaluateReuploadDecision(config);
    if (!decision.shouldReupload) {
      if (uploadSuspendedModerationNoBackups) {
        console.log('[INFO] Health OK again; cleared upload suspension (moderation / no-backup guard).');
      }
      uploadSuspendedModerationNoBackups = false;
    }
    const monitorUniverseId =
      config.accountPool?.primary?.experienceId ||
      config.experienceId;
    let livePlayers = 0;
    if (monitorUniverseId) {
      try {
        livePlayers = await fetchUniversePlayerCount(monitorUniverseId);
      } catch (err) {
        console.log(`[WARN] Could not fetch live player count: ${err.message}`);
      }
    } else {
      console.log('[WARN] Missing experienceId; cannot fetch live player count.');
    }
    const voiceCount = (decision.shouldReupload || decision.reason === 'roblox-down') ? 0 : livePlayers;
    spawnDiscordTask('monitor voice pre-check', async () => {
      await updateDiscordVoiceChannelPlayerCount(config, voiceCount);
    });

    if (decision.shouldReupload) {
      if (uploadSuspendedModerationNoBackups) {
        console.log(
          '[WARN] Skipping repair upload: last attempt hit Roblox moderation (403) with no remaining backup accounts. ' +
            'Update accountPool.primary cookie, add accountPool.backups, or wait until health checks pass again.'
        );
        spawnDiscordTask('monitor status down (upload suspended)', async () => {
          await updateDiscordVoiceChannelPlayerCount(config, 0);
          await setSystemStatusBounded(SYSTEM_STATUS.DOWN, {
            gameLink: config.monitor?.healthUrl || '',
            operation: 'monitor',
            reason: 'repair upload suspended'
          }, config);
        });
      } else if (getOperationLockHolder(process.env.DATA_DIR || path.join(process.cwd(), 'data'))) {
        // Do this before rotating accounts: a skipped upload must not burn a backup account.
        console.log('[INFO] Repair upload skipped: another upload operation is already running.');
      } else {
        let uploadConfig = config;
        let rotatedTo = null;
        if (config.accountPool?.backups?.length) {
          const previousExperienceId =
            config.accountPool?.primary?.experienceId ||
            config.experienceId;
          rotatedTo = config.accountPool.backups.shift();
          if (!rotatedTo.experienceId && previousExperienceId) {
            rotatedTo.experienceId = previousExperienceId;
          }
          config.accountPool.primary = rotatedTo;
          saveRawConfig(resolvedConfigPath, config);
          uploadConfig = config;
          console.log(`[INFO] Rotated primary uploader account to backup: ${rotatedTo.name || rotatedTo.userId}`);
        }

        console.log('[INFO] Health checks failed after retries; running normal upload pipeline...');
        try {
          const target = uploadConfig.monitor?.healthUrl || uploadConfig.experienceId || uploadConfig.experience?.name || 'current experience';
          await runTrackedOperation({
            dataDir: process.env.DATA_DIR || path.join(process.cwd(), 'data'),
            type: 'monitor-reupload',
            target,
            metadata: { configPath: resolvedConfigPath },
            verify: async (result) => {
              const mainPlaceId = result?.placeIds?.Main || '';
              if (!mainPlaceId) return { verified: false, reason: 'Main place ID was not returned' };
              return verifyExperienceState({ mainPlaceId, expectedName: uploadConfig.experience?.name || '' });
            },
            fn: async () => runNormalUploadPipeline(uploadConfig, { configPath: resolvedConfigPath }),
          });
        } catch (err) {
          if (err?.code === 'LOCKED') {
            console.log(`[INFO] Repair upload skipped: ${err.message}`);
          } else {
            console.error('[FAIL] Normal upload pipeline error:', err);
          }
          if (isRobloxAccountModerationError(err) && !(uploadConfig.accountPool?.backups?.length)) {
            uploadSuspendedModerationNoBackups = true;
            console.log(
              '[WARN] Further repair uploads are suspended for this process: moderated uploader and no backups left in accountPool.backups.'
            );
          }
        }
      }
    } else if (decision.reason === 'roblox-down') {
      spawnDiscordTask('monitor status down (roblox-down)', async () => {
        await setSystemStatusBounded(SYSTEM_STATUS.DOWN, {
          gameLink: config.monitor?.healthUrl || '',
          operation: 'monitor',
          reason: 'Roblox appears unavailable'
        }, config);
      });
      console.log('[INFO] Health checks deferred because Roblox appears unavailable; no upload run.');
    } else {
      spawnDiscordTask('monitor status up', async () => {
        await setSystemStatusBounded(SYSTEM_STATUS.UP, {
          gameLink: config.monitor?.healthUrl || '',
          operation: 'monitor',
          target: config.experience?.name || config.experienceId || 'current experience'
        }, config);
      });
      console.log('[INFO] Health OK; no upload run.');
    }

    console.log(`[INFO] Next check in ${Math.round(waitMs / 1000)}s.`);
    await sleep(waitMs);
  }
}

export async function runChannelStatusService(configPath) {
  const resolvedConfigPath = path.resolve(configPath);
  console.log(`[INFO] Channel status service started (config: ${resolvedConfigPath}). Ctrl+C to stop.`);

  while (true) {
    let config;
    try {
      config = loadRawConfig(resolvedConfigPath);
    } catch (err) {
      console.error(`[FAIL] Could not read config: ${err.message}`);
      await sleep(30_000);
      continue;
    }

    const intervalMs = Number(config.monitor?.intervalMs);
    const waitMs = Number.isFinite(intervalMs) && intervalMs >= 10_000 ? intervalMs : 300_000;

    const healthUrl = config.monitor?.healthUrl;
    console.log(`[INFO] Health check: ${healthUrl || '(none; treating as unhealthy)'}`);

    const decision = await evaluateReuploadDecision(config);
    const monitorUniverseId =
      config.accountPool?.primary?.experienceId ||
      config.experienceId;
    let livePlayers = 0;
    if (monitorUniverseId) {
      try {
        livePlayers = await fetchUniversePlayerCount(monitorUniverseId);
      } catch (err) {
        console.log(`[WARN] Could not fetch live player count: ${err.message}`);
      }
    } else {
      console.log('[WARN] Missing experienceId; cannot fetch live player count.');
    }

    const gameDown = decision.shouldReupload || decision.reason === 'roblox-down';
    const voiceCount = gameDown ? 0 : livePlayers;
    const status = gameDown ? 'down' : 'up';

    spawnDiscordTask('channel-status voice', async () => {
      await updateDiscordVoiceChannelPlayerCount(config, voiceCount);
    });
    spawnDiscordTask('channel-status status', async () => {
      await setSystemStatusBounded(status === 'up' ? SYSTEM_STATUS.UP : SYSTEM_STATUS.DOWN, {
        gameLink: config.monitor?.healthUrl || '',
        operation: 'channelstatusservice',
        reason: gameDown ? 'Game health check failed' : undefined
      }, config);
    });

    if (decision.reason === 'roblox-down') {
      console.log('[INFO] Roblox appears unavailable; Discord channels set to down / 0 players.');
    } else if (decision.shouldReupload) {
      console.log('[INFO] Game health check failed; Discord channels set to down / 0 players.');
    } else {
      console.log(`[INFO] Game health OK; Discord channels set to up / ${livePlayers} players.`);
    }

    console.log(`[INFO] Next check in ${Math.round(waitMs / 1000)}s.`);
    await sleep(waitMs);
  }
}

async function userIsInRobloxGroup(robloxClient, userId, groupId) {
  const uid = normalizeUserId(userId, 'userId');
  const gid = Number(normalizeUserId(groupId, 'groupId'));
  try {
    const response = await robloxClient.get(`https://groups.roblox.com/v1/users/${uid}/groups/roles`);
    const json = response && typeof response.json === 'function' ? await response.json() : response;
    const list = json?.data;
    if (!Array.isArray(list)) {
      return false;
    }
    return list.some((row) => Number(row?.group?.id) === gid);
  } catch (err) {
    console.log(`[WARN] Could not read group membership for user ${uid}: ${err.message}`);
    return false;
  }
}

async function tryJoinRobloxGroupViaHttpApi(robloxClient, groupId) {
  const gid = normalizeUserId(groupId, 'groupId');
  try {
    await robloxClient.post(`https://groups.roblox.com/v1/groups/${gid}/users`, {});
    return true;
  } catch {
    return false;
  }
}

async function playwrightTryClickRobloxGroupJoin(page, accountLabel) {
  await tryDismissRobloxCookieBanner(page);
  await sleep(700);

  const joinCandidates = [
    (p) => p.getByRole('button', { name: /^join group$/i }),
    (p) => p.getByRole('button', { name: /join group/i }),
    (p) => p.getByRole('link', { name: /join group/i }),
    (p) => p.getByRole('button', { name: /request to join/i }),
    (p) => p.getByRole('link', { name: /request to join/i }),
    (p) => p.locator('a, button').filter({ hasText: /^join group$/i }).first(),
    (p) => p.locator('a, button').filter({ hasText: /^request to join$/i }).first()
  ];

  for (const make of joinCandidates) {
    try {
      const el = make(page);
      await el.waitFor({ state: 'visible', timeout: 5000 });
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await el.click({ timeout: 5000 });
      console.log(`[INFO] Playwright clicked join action on group page for ${accountLabel}.`);
      await sleep(1200);
      return true;
    } catch {
      // try next
    }
  }

  try {
    const leave = page.getByRole('button', { name: /leave group/i });
    await leave.waitFor({ state: 'visible', timeout: 2500 });
    console.log(`[INFO] ${accountLabel}: group page shows Leave Group (already a member).`);
    return true;
  } catch {
    // ignore
  }

  console.log(`[WARN] Could not find Join / Request to join on the group page for ${accountLabel}.`);
  return false;
}

async function ensureAssetJoinedRobloxGroup(assetAccount, assetUserId, groupId) {
  const gid = normalizeUserId(groupId, 'groupId');
  const joinUrl = `https://www.roblox.com/groups/${gid}`;
  const cookie = resolveCookie(assetAccount, assetAccount.name);
  if (!cookie) {
    console.log(`[WARN] Skipping group join for ${assetAccount.name}; missing cookie.`);
    return;
  }

  const assetClient = new RobloxClient(cookie, assetAccount.name);

  if (await userIsInRobloxGroup(assetClient, assetUserId, gid)) {
    console.log(`[INFO] ${assetAccount.name} is already in group ${gid}.`);
    return;
  }

  if (await tryJoinRobloxGroupViaHttpApi(assetClient, gid)) {
    await sleep(800);
    if (await userIsInRobloxGroup(assetClient, assetUserId, gid)) {
      console.log(`[SUCCESS] ${assetAccount.name} joined group ${gid} via HTTP API.`);
      return;
    }
  }

  console.log(`[INFO] Opening Playwright for ${assetAccount.name} to join group ${gid}…`);
  const session = await createRobloxPlaywrightSession(cookie, joinUrl);
  if (!session) {
    throw new Error(`Could not open Playwright for ${assetAccount.name} to join the group.`);
  }

  const { browser, page } = session;
  try {
    await playwrightTryClickRobloxGroupJoin(page, assetAccount.name);
    for (let i = 0; i < 45 && !(await userIsInRobloxGroup(assetClient, assetUserId, gid)); i += 1) {
      await sleep(2000);
    }
    if (await userIsInRobloxGroup(assetClient, assetUserId, gid)) {
      console.log(`[SUCCESS] ${assetAccount.name} is now in group ${gid}.`);
      return;
    }

    console.log(
      `[ACTION REQUIRED] ${assetAccount.name}: finish joining in the Playwright window (captcha, approval, etc.), then press Enter here…`
    );
    await waitForEnterPrompt(
      `[ACTION REQUIRED] ${assetAccount.name}: finish joining in the Playwright window (captcha, approval, etc.), then press Enter here…`
    );

    for (let i = 0; i < 25 && !(await userIsInRobloxGroup(assetClient, assetUserId, gid)); i += 1) {
      await sleep(2000);
    }
    if (!(await userIsInRobloxGroup(assetClient, assetUserId, gid))) {
      throw new Error(`${assetAccount.name} is still not a member of group ${gid} after the manual step.`);
    }
    console.log(`[SUCCESS] ${assetAccount.name} is now in group ${gid}.`);
  } finally {
    await browser.close().catch(() => {});
  }
}

const GROUP_MEMBERS_WARN_OWNER_COOKIE_FALLBACK =
  '[WARN] `groupOwnerCookie` is not set; using **creatorAccount** cookie for the Members browser. ' +
  'If your uploader is not the group owner, set `groupOwnerCookie` (and optional `groupOwnerName`) on `accountPool.primary` or `creatorAccount`.';

const GROUP_MEMBERS_WARN_NO_COOKIE =
  '[WARN] Missing **groupOwnerCookie** and creator cookie; open the URL above while logged in as someone who can change ranks.';

function buildGroupMembersConfigureUrl(groupId) {
  const gid = normalizeUserId(groupId, 'groupId');
  const membersUrl = `https://www.roblox.com/communities/configure?id=${encodeURIComponent(gid)}#!/members`;
  return { gid, membersUrl };
}

/**
 * Opens `communities/configure?id=…#!/members` like the rank step: groupOwnerCookie else creator → Playwright;
 * on Playwright failure, OS default browser; no cookie → URL in console + Enter only.
 */
async function openGroupMembersConfigurePlaywrightFlow(config, groupId, options) {
  const {
    actionLineBeforeIndentedUrl,
    warnNotOwnerCookie = GROUP_MEMBERS_WARN_OWNER_COOKIE_FALLBACK,
    noCookieBrowserWarn = GROUP_MEMBERS_WARN_NO_COOKIE,
    doneQuestionNoCookie,
    doneQuestionWithBrowser,
    successInfoSuffix
  } = options;

  const { membersUrl } = buildGroupMembersConfigureUrl(groupId);
  console.log(`${actionLineBeforeIndentedUrl}\n    ${membersUrl}`);

  const creatorAccount = requireValue(config.creatorAccount, 'creatorAccount');
  const creatorCookie = resolveCookie(creatorAccount, 'creatorAccount');
  const ownerCookie = resolveGroupOwnerCookie(config);
  const rankCookie = ownerCookie || creatorCookie;
  const rankLabel = ownerCookie ? resolveGroupOwnerRankLabel(config) : creatorAccount.name || 'creator account';

  if (!ownerCookie && creatorCookie && warnNotOwnerCookie) {
    console.log(warnNotOwnerCookie);
  }

  if (!rankCookie) {
    console.log(noCookieBrowserWarn);
    await waitForEnterPrompt(doneQuestionNoCookie, { membersUrl });
    return;
  }

  const rankSession = await createRobloxPlaywrightSession(rankCookie, membersUrl);
  if (rankSession) {
    console.log(
      `[INFO] Playwright opened **Members** (${membersUrl}) logged in as **${rankLabel}**.${successInfoSuffix ? ` ${successInfoSuffix}` : ''}`
    );
    await waitForEnterPrompt(doneQuestionWithBrowser, { membersUrl });
    await rankSession.browser.close().catch(() => {});
  } else {
    try {
      await openUrlInBrowser(membersUrl);
    } catch {
      // ignore
    }
    await waitForEnterPrompt(doneQuestionWithBrowser, { membersUrl });
  }
}

/**
 * Group-owned experiences: edit access comes from **group rank**, not friends.
 * Uses Playwright (and the join-group HTTP API when it works) so each asset joins, then opens group **Members**
 * (www.roblox.com communities configure) using **groupOwnerCookie** when set, otherwise creator cookie.
 */
async function runGroupJoinAndRankWithPlaywright(config, groupId) {
  const gid = normalizeUserId(groupId, 'groupId');

  console.log('\n========== GROUP ACCESS (Playwright + membership API) ==========');
  console.log(`[INFO] Target group id ${gid} — https://www.roblox.com/groups/${gid}`);

  for (const acc of config.assetAccounts || []) {
    const assetUserId = normalizeUserId(requireValue(acc.userId, `${acc.name}.userId`), `${acc.name}.userId`);
    console.log(`[INFO] Ensuring group membership: ${acc.name || 'Asset'} (${assetUserId})`);
    await ensureAssetJoinedRobloxGroup(acc, assetUserId, gid);
  }

  await openGroupMembersConfigurePlaywrightFlow(config, groupId, {
    actionLineBeforeIndentedUrl:
      '[ACTION REQUIRED] In the group, **rank / promote** each asset to a role that has **Edit** on this experience.',
    doneQuestionNoCookie: '\n[ACTION REQUIRED] Press Enter after every asset is ranked with edit access…\n',
    doneQuestionWithBrowser: '\n[ACTION REQUIRED] Press Enter after every asset is ranked with edit access…\n',
    successInfoSuffix: 'Assign ranks, then continue here.'
  });

  console.log('[INFO] Group join + rank steps acknowledged; verifying universe edit access for each asset...\n');
}

async function verifyOrWaitUniverseEditAfterGroupRank(creatorClient, config, assetRows, experienceId) {
  for (const { assetAccount, assetUserId } of assetRows) {
    try {
      let hasEdit = await getAssetUniverseEditStatus(assetAccount, experienceId);
      if (!hasEdit) {
        console.log(`[INFO] Waiting for Roblox to apply group rank edit access for ${assetAccount.name} (${assetUserId})…`);
        for (let i = 0; i < 45 && !hasEdit; i += 1) {
          await sleep(2000);
          hasEdit = await getAssetUniverseEditStatus(assetAccount, experienceId);
        }
      }
      if (hasEdit) {
        console.log(`[SUCCESS] ${assetAccount.name} has edit access on universe ${experienceId}.`);
        continue;
      }

      console.log(
        `[WARN] ${assetAccount.name} still shows no edit on universe ${experienceId}. ` +
          'Confirm the group role includes **Edit** for this experience, then continue manually if needed.'
      );
      const mainPlaceId = await resolveMainPlaceIdForStudioShortcut(creatorClient, config, experienceId);
      if (!mainPlaceId) {
        throw new Error(`Could not resolve Main place id for universe ${experienceId}.`);
      }
      await waitForManualUniverseEditGrant(assetAccount, assetUserId, experienceId, mainPlaceId, config);
    } catch (err) {
      console.log(`[WARN] Edit verification for ${assetAccount.name}: ${err.message}`);
    }
  }
}

async function connectFriendAccounts(config, { skipUniverseEditGrants = false } = {}) {
  const creatorAccount = requireValue(config.creatorAccount, 'creatorAccount');
  const creatorClient = new RobloxClient(resolveCookie(creatorAccount, 'creatorAccount'), creatorAccount.name || 'creator account');

  if (config.experienceId) {
    try {
      const universeDetails = await getUniverseDetails(creatorClient, config.experienceId);
      if (universeDetails && applyDetectedGroupOwnership(config, universeDetails)) {
        console.log(
          `[INFO] Detected group-owned universe ${config.experienceId} before permission automation; ` +
            `using group rank/access flow for group ${config.creatorAccount?.groupId || universeDetails?.creator?.id || 'unknown'}.`
        );
      }
    } catch (err) {
      console.log(`[WARN] Could not detect group ownership before permission automation: ${err.message}`);
    }
  }

  const creatorUserId = await resolveCreatorUserId(config.creatorAccount, creatorClient);
  const friendTargetUserId = creatorUserId;

  if (config.friendAutomation?.enabled === false) {
    console.log('[INFO] Friend automation disabled by config (friendAutomation.enabled=false). Skipping creator/asset friendship checks.');
    return { creatorClient, friendTargetUserId };
  }

  const assetAccountsForPermission = [];
  for (const assetAccount of config.assetAccounts || []) {
    const assetUserId = normalizeUserId(requireValue(assetAccount.userId, `${assetAccount.name}.userId`), `${assetAccount.name}.userId`);
    assetAccountsForPermission.push({ assetAccount, assetUserId });
  }

  const groupIdStr = resolveExperienceGroupId(config);
  const useGroupRankAccessFlow = isGroupOpenCloudModeEnabled(config) && Boolean(groupIdStr);

  if (useGroupRankAccessFlow) {
    console.log(
      '[INFO] Group experience (`isGroup` + `groupId`): skipping friend-request automation. ' +
        'Edit access is expected from **group membership + role rank**, not from friending.'
    );
    await runGroupJoinAndRankWithPlaywright(config, groupIdStr);

    const experienceId = config.experienceId;
    if (!experienceId) {
      console.log('[WARN] Skipping universe edit verification; missing experienceId.');
      return { creatorClient, friendTargetUserId };
    }

    if (skipUniverseEditGrants) {
      console.log(
        '[INFO] Skipping universe edit verification (skipUniverseEditGrants); use Studio manually if needed.'
      );
      return { creatorClient, friendTargetUserId };
    }

    await verifyOrWaitUniverseEditAfterGroupRank(creatorClient, config, assetAccountsForPermission, experienceId);
    return { creatorClient, friendTargetUserId };
  }

  if (isGroupOpenCloudModeEnabled(config) && !groupIdStr) {
    console.log(
      '[WARN] `isGroup` is set but `groupId` is missing; cannot run the group Playwright join/rank flow. ' +
        'Falling back to classic friend automation (each alt → uploader). Add `groupId` to use the group flow.'
    );
  }

  const pendingCreatorAcceptUserIds = [];

  for (const assetAccount of config.assetAccounts || []) {
    const assetUserId = normalizeUserId(requireValue(assetAccount.userId, `${assetAccount.name}.userId`), `${assetAccount.name}.userId`);

    const friendshipStatus = await getFriendshipStatus(creatorClient, creatorUserId, assetUserId);
    if (friendshipStatus === 'Friends') {
      console.log(`[INFO] ${assetAccount.name} is already friends with uploader (${creatorUserId})`);
      continue;
    }

    if (friendshipStatus === 'RequestReceived') {
      pendingCreatorAcceptUserIds.push(assetUserId);
      console.log(`[INFO] ${assetAccount.name} already sent a friend request to uploader; will accept in final pass.`);
      continue;
    }

    if (friendshipStatus === 'RequestSent') {
      console.log(`[INFO] Uploader already sent a friend request to ${assetAccount.name}; waiting for alt to accept is not automated here — check Roblox.`);
      continue;
    }

    const assetCookie = resolveCookie(assetAccount, assetAccount.name);
    if (!assetCookie) {
      console.log(`[WARN] Skipping friend send from ${assetAccount.name}; missing cookie`);
      continue;
    }

    const assetClient = new RobloxClient(assetCookie, assetAccount.name);
    try {
      await sendFriendRequest(assetClient, creatorUserId);
      console.log(`[SUCCESS] ${assetAccount.name} sent friend request to uploader (${creatorUserId})`);
    } catch (err) {
      if (!isRobloxChallengeRequired(err)) {
        throw err;
      }

      const challengeBrowser = await openChallengeBrowserWithAccount(
        assetAccount.name,
        assetCookie,
        `https://www.roblox.com/users/${creatorUserId}/profile`
      );
      console.log(
        `[ACTION REQUIRED] ${assetAccount.name}: Roblox blocked the automated friend request. ` +
          `In the opened window (logged in as **${assetAccount.name}**), click **Add Friend** on the uploader's profile once. This script will detect it.`
      );

      const statusAfterManualSend = await waitForFriendshipStatus(
        creatorClient,
        creatorUserId,
        assetUserId,
        ['RequestReceived', 'Friends'],
        180000
      );
      if (challengeBrowser) {
        await challengeBrowser.close();
      }
      if (statusAfterManualSend === 'Friends') {
        console.log(`[SUCCESS] ${assetAccount.name} is now friends with uploader`);
        continue;
      }
      if (statusAfterManualSend === 'RequestReceived') {
        pendingCreatorAcceptUserIds.push(assetUserId);
        console.log(`[SUCCESS] ${assetAccount.name} friend request detected (uploader will accept in final pass).`);
        continue;
      }
      console.log(`[WARN] Did not detect friend request from ${assetAccount.name} after manual step; continuing.`);
      continue;
    }

    const postSendStatus = await getFriendshipStatus(creatorClient, creatorUserId, assetUserId);
    if (postSendStatus === 'Friends') {
      console.log(`[INFO] ${assetAccount.name} is already friends with uploader after send.`);
      continue;
    }
    if (postSendStatus === 'RequestReceived') {
      pendingCreatorAcceptUserIds.push(assetUserId);
      console.log(`[SUCCESS] ${assetAccount.name} sent friend request (queued for uploader acceptance pass).`);
    } else {
      console.log(
        `[INFO] After send, expected uploader to see RequestReceived from ${assetAccount.name}; status is "${postSendStatus || 'Unknown'}".`
      );
    }
  }

  for (const assetUserId of pendingCreatorAcceptUserIds) {
    let friendshipStatus = await getFriendshipStatus(creatorClient, creatorUserId, assetUserId);
    if (friendshipStatus === 'Friends') {
      console.log(`[INFO] User ${assetUserId} already friends with uploader before accept pass.`);
      continue;
    }
    if (friendshipStatus !== 'RequestReceived') {
      console.log(`[INFO] User ${assetUserId} has status "${friendshipStatus || 'Unknown'}"; nothing for uploader to accept right now.`);
      continue;
    }

    try {
      await acceptFriendRequest(creatorClient, assetUserId);
      console.log(`[SUCCESS] Uploader accepted friend request from user ${assetUserId}`);
    } catch (err) {
      if (!isRobloxChallengeRequired(err)) {
        throw err;
      }

      const challengeBrowser = await openChallengeBrowserWithAccount(
        creatorAccount.name || 'creator account',
        resolveCookie(creatorAccount, 'creatorAccount'),
        `https://www.roblox.com/users/${assetUserId}/profile`
      );
      console.log(
        `[ACTION REQUIRED] Uploader: accept friend request from user ${assetUserId} in the opened window. Waiting for status update...`
      );
      friendshipStatus = await waitForFriendshipStatus(creatorClient, creatorUserId, assetUserId, ['Friends'], 180000);
      if (challengeBrowser) {
        await challengeBrowser.close();
      }
      if (friendshipStatus === 'Friends') {
        console.log(`[SUCCESS] Uploader is now friends with user ${assetUserId}`);
      } else {
        console.log(`[WARN] Did not detect accepted friend request for user ${assetUserId} within timeout.`);
      }
    }
  }

  const experienceId = config.experienceId;
  if (!experienceId) {
    console.log('[WARN] Skipping universe edit permission grants; missing experienceId.');
    return { creatorClient, friendTargetUserId };
  }

  if (skipUniverseEditGrants) {
    console.log(
      '[INFO] Skipping automatic universe edit / Team Create grants (use Studio from the add-friends step to add collaborators manually).'
    );
    return { creatorClient, friendTargetUserId };
  }

  for (const { assetAccount, assetUserId } of assetAccountsForPermission) {
    try {
      let hasEditPermission = false;
      try {
        hasEditPermission = await getAssetUniverseEditStatus(assetAccount, experienceId);
      } catch (statusErr) {
        console.log(`[WARN] Could not verify existing edit permission for ${assetAccount.name}: ${statusErr.message}`);
      }

      if (hasEditPermission) {
        console.log(`[INFO] ${assetAccount.name} already has edit permission on universe ${experienceId}.`);
        continue;
      }

      await grantUniverseEditPermission(creatorClient, experienceId, assetUserId);
      hasEditPermission = await getAssetUniverseEditStatus(assetAccount, experienceId);
      if (!hasEditPermission) {
        throw new Error(`${assetAccount.name} still lacks edit permission after grant attempt.`);
      }
      console.log(`[SUCCESS] Verified edit permission on universe ${experienceId} for ${assetAccount.name} (${assetUserId})`);
    } catch (err) {
      if (isRobloxUnauthorized(err)) {
        console.log(`[WARN] Creator account is not authorized to grant edit permission on universe ${experienceId} to user ${assetUserId}.`);
      } else {
        console.log(`[WARN] Failed to grant edit permission on universe ${experienceId} to user ${assetUserId}: ${err.message}`);
      }

      const mainPlaceId = await resolveMainPlaceIdForStudioShortcut(creatorClient, config, experienceId);
      if (!mainPlaceId) {
        throw new Error(
          `Unable to ensure edit permission for ${assetAccount.name} (${assetUserId}) on universe ${experienceId}. ` +
            'Ensure the universe resolves via the games API, grant Edit manually, then rerun.'
        );
      }

      await waitForManualUniverseEditGrant(assetAccount, assetUserId, experienceId, mainPlaceId, config);
    }
  }

  return { creatorClient, friendTargetUserId };
}

/**
 * Group experiences: after grants, the owner should **demote** asset accounts in the group — no per-asset unfriend flow.
 * Opens the same **Members** URL and Playwright path as the rank step (`openGroupMembersConfigurePlaywrightFlow`).
 */
async function promptGroupOwnerDemoteAssetAccounts(config, groupId) {
  console.log('\n========== GROUP POST-GRANT: demote asset accounts ==========');
  console.log(
    '[ACTION REQUIRED] As **group owner** (or a rank manager), **demote** each asset below so they do not keep unnecessary edit access.'
  );
  for (const acc of config.assetAccounts || []) {
    const uid = acc.userId != null && String(acc.userId).trim() !== '' ? String(acc.userId).trim() : '?';
    console.log(`    • ${acc.name || 'Asset'} (userId ${uid})`);
  }

  await openGroupMembersConfigurePlaywrightFlow(config, groupId, {
    actionLineBeforeIndentedUrl:
      '[ACTION REQUIRED] Use the same **Members** link as when ranking — lower roles / remove edit access for the accounts above:',
    doneQuestionNoCookie: '\n[ACTION REQUIRED] Press Enter after you have demoted the asset accounts…\n',
    doneQuestionWithBrowser: '\n[ACTION REQUIRED] Press Enter after you have **demoted** every asset account as needed…\n',
    successInfoSuffix: 'Demote the listed accounts, then continue here.'
  });
}

async function openUnfriendTabsFallbackChrome(config) {
  for (const assetAccount of config.assetAccounts || []) {
    try {
      const assetUserId = normalizeUserId(
        requireValue(assetAccount.userId, `${assetAccount.name}.userId`),
        `${assetAccount.name}.userId`
      );
      const opened = await openUrlInChrome(`https://www.roblox.com/users/${assetUserId}/profile`);
      if (opened) {
        console.log(`[INFO] Opened Chrome tab for ${assetAccount.name} profile (default browser session).`);
      }
    } catch (err) {
      console.log(`[WARN] Unfriend Chrome fallback: ${err.message}`);
    }
    await sleep(300);
  }
}

async function openUnfriendTabs(config, friendTargetUserId) {
  if (config.unfriendAfterGrant?.enabled === false) {
    console.log('[INFO] unfriendAfterGrant.enabled is false — skipping profile tab opens.');
    return;
  }

  const groupIdStr = resolveExperienceGroupId(config);
  if (isGroupOpenCloudModeEnabled(config) && groupIdStr) {
    console.log(
      '[INFO] Group experience: skipping unfriend-per-asset flow. Prompting **group owner** to demote asset accounts instead.'
    );
    await promptGroupOwnerDemoteAssetAccounts(config, groupIdStr);
    return;
  }

  const friendTargetProfileUrl = `https://www.roblox.com/users/${friendTargetUserId}/profile`;
  const assetAccounts = config.assetAccounts || [];

  const assetRows = [];
  for (const assetAccount of assetAccounts) {
    try {
      const assetUserId = normalizeUserId(
        requireValue(assetAccount.userId, `${assetAccount.name}.userId`),
        `${assetAccount.name}.userId`
      );
      assetRows.push({ assetAccount, assetUserId });
    } catch (err) {
      console.log(`[WARN] Unfriend helper: ${err.message}`);
    }
  }

  const anyAssetCookie = assetRows.some(({ assetAccount }) => resolveCookie(assetAccount, assetAccount.name));

  console.log(
    '[INFO] Unfriend helper: one Playwright window at a time per asset (friend / permission-grant target profile). Close the browser window when done on that account; the script then opens the next (no Enter key).'
  );

  if (!anyAssetCookie) {
    console.log('[WARN] No asset cookies for Playwright; using default browser URLs for asset profiles only.');
    await openUnfriendTabsFallbackChrome(config);
    return;
  }

  try {
    const withCookie = [];
    for (const row of assetRows) {
      if (!resolveCookie(row.assetAccount, row.assetAccount.name)) {
        console.log(`[WARN] Skipping unfriend helper for ${row.assetAccount.name}; no cookie.`);
      } else {
        withCookie.push(row);
      }
    }

    for (let i = 0; i < withCookie.length; i += 1) {
      const { assetAccount, assetUserId } = withCookie[i];
      const assetCookie = resolveCookie(assetAccount, assetAccount.name);
      let browser;
      try {
        browser = await launchAutomationBrowser({
          label: `unfriend-${assetAccount.name}`,
          urlToOpen: friendTargetProfileUrl,
        });
        const context = await browser.newContext();
        await context.addCookies([buildRobloxSecurityCookieEntry(assetCookie)]);
        const page = await openRobloxPageFromHome(context, friendTargetProfileUrl);
        console.log(
          `[INFO] (${i + 1}/${withCookie.length}) Opened unfriend helper for ${assetAccount.name} — logged in on friend-target profile user ${friendTargetUserId}.`
        );
        try {
          await page.waitForLoadState('domcontentloaded');
          await tryRobloxProfileClickUnfriend(page);
          await page.waitForTimeout(2200);
          await tryRobloxProfileClickUnfriend(page);
        } catch (autoErr) {
          console.log(`[WARN] Unfriend auto-click attempt: ${autoErr.message}`);
        }
        console.log(
          '[ACTION REQUIRED] If Unfriend did not complete automatically, use ⋯ then Unfriend. The script continues when Roblox reports you are no longer friends, or when you close the tab or browser.'
        );

        await waitUntilUnfriendSessionEnds(browser, context, page, {
          assetCookie,
          assetUserId,
          friendTargetUserId,
          assetLabel: assetAccount.name
        });
      } catch (stepErr) {
        console.log(`[WARN] Unfriend helper failed for ${assetAccount.name}: ${stepErr.message}`);
        console.log('[INFO] Continuing with remaining accounts in fresh browser windows.');
      } finally {
        try {
          if (browser && typeof browser.isConnected === 'function' && browser.isConnected()) {
            await browser.close();
          }
        } catch {
          // ignore
        }
      }
    }
  } catch (err) {
    console.log(`[WARN] Playwright unfriend helper setup failed (${err.message}).`);
  }
}

const ROBLOX_PUBLIC_FETCH_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 PBB-AutoReuploader'
};

function extractPlaceIdFromRobloxGamesUrl(healthUrl) {
  const s = String(healthUrl || '').trim();
  const m = s.match(/roblox\.com\/games\/(\d{5,})/i) || s.match(/\/games\/(\d{5,})/i);
  return m ? m[1] : null;
}

function isRobloxAccountModerationError(err) {
  const msg = String(err?.message || '');
  return /\b403\b/.test(msg) && /User is moderated/i.test(msg);
}

async function shouldReupload(config) {
  let healthUrl = String(config.monitor?.healthUrl || '').trim();
  const configuredUniverse = config.accountPool?.primary?.experienceId ?? config.experienceId;

  // If the saved health URL points at a different universe, resolve the configured
  // universe's current root place instead of falsely declaring the experience down.
  const savedPlaceId = extractPlaceIdFromRobloxGamesUrl(healthUrl);
  if (savedPlaceId && configuredUniverse != null && String(configuredUniverse).trim() !== '') {
    try {
      const mapped = await requestJson(
        `https://apis.roblox.com/universes/v1/places/${encodeURIComponent(savedPlaceId)}/universe`,
        { headers: ROBLOX_PUBLIC_FETCH_HEADERS },
        { operation: 'Roblox saved health place universe check', retries: 2, timeoutMs: 15_000, baseMs: 1000, maxMs: 10_000 }
      );
      const mappedUniverse = mapped?.universeId;
      if (mappedUniverse != null && Number(mappedUniverse) !== Number(configuredUniverse)) {
        try {
          const gameJson = await requestJson(
            `https://games.roblox.com/v1/games?universeIds=${encodeURIComponent(configuredUniverse)}`,
            { headers: ROBLOX_PUBLIC_FETCH_HEADERS },
            { operation: 'Roblox configured universe metadata for health target', retries: 2, timeoutMs: 15_000, baseMs: 1000, maxMs: 10_000 }
          );
          const rootPlaceId = gameJson?.data?.[0]?.rootPlaceId;
          if (rootPlaceId != null && String(rootPlaceId).trim() !== '') {
            healthUrl = buildRobloxGameHealthUrl(rootPlaceId);
            console.log(
              `[INFO] Corrected stale monitor.healthUrl from place ${savedPlaceId} ` +
                `(universe ${mappedUniverse}) to configured universe ${configuredUniverse} ` +
                `root place ${rootPlaceId}.`
            );
          } else {
            console.log(
              `[WARN] monitor.healthUrl points to universe ${mappedUniverse}, but configured universe ${configuredUniverse} ` +
                `has no public rootPlaceId metadata; treating health as unavailable.`
            );
            return { shouldReupload: true, reason: 'configured-universe-no-root-place' };
          }
        } catch {
          return { shouldReupload: true, reason: 'configured-universe-health-target-error' };
        }
      }
    } catch {
      // Continue using the configured URL. The normal health/API checks below remain authoritative.
    }
  }

  if (!healthUrl) {
    return {
      shouldReupload: true,
      reason: 'missing-health-url'
    };
  }

  let pageUnhealthy = false;
  let pageReason = 'health-page-ok';
  try {
    const response = await requestWithRetry(healthUrl, { headers: ROBLOX_PUBLIC_FETCH_HEADERS }, { operation: 'Roblox health page', retries: 2, timeoutMs: 15_000, baseMs: 1000, maxMs: 10_000 });
    const text = await response.text();
    pageUnhealthy = !response.ok || text.trim().length === 0;
    pageReason = pageUnhealthy ? 'health-page-unhealthy' : 'health-page-ok';
  } catch {
    return {
      shouldReupload: true,
      reason: 'health-fetch-error'
    };
  }

  const placeId = extractPlaceIdFromRobloxGamesUrl(healthUrl);
  if (!placeId) {
    return {
      shouldReupload: pageUnhealthy,
      reason: pageUnhealthy ? pageReason : 'health-ok'
    };
  }

  let apiUnhealthy = false;
  let apiReason = 'health-api-ok';
  try {
    const uniJson = await requestJson(
      `https://apis.roblox.com/universes/v1/places/${encodeURIComponent(placeId)}/universe`,
      { headers: ROBLOX_PUBLIC_FETCH_HEADERS },
      { operation: 'Roblox place-to-universe health check', retries: 2, timeoutMs: 15_000, baseMs: 1000, maxMs: 10_000 }
    );
    const universeId = uniJson?.universeId;
    if (universeId == null || universeId === '') {
      apiUnhealthy = true;
      apiReason = 'health-place-universe-empty';
    } else {
      const expectedUniverse = configuredUniverse;
      if (expectedUniverse != null && expectedUniverse !== '' && Number(expectedUniverse) !== Number(universeId)) {
        apiUnhealthy = true;
        apiReason = 'health-universe-id-mismatch';
        console.log(
          `[WARN] health target place ${placeId} still resolves to universe ${universeId}, ` +
            `while config experienceId is ${expectedUniverse}.`
        );
      }

      const gamesJson = await requestJson(
        `https://games.roblox.com/v1/games?universeIds=${encodeURIComponent(universeId)}`,
        { headers: ROBLOX_PUBLIC_FETCH_HEADERS },
        { operation: 'Roblox game metadata health check', retries: 2, timeoutMs: 15_000, baseMs: 1000, maxMs: 10_000 }
      );
      if (!Array.isArray(gamesJson?.data) || gamesJson.data.length === 0) {
        apiUnhealthy = true;
        apiReason = 'health-no-game-metadata';
        console.log(
          `[WARN] games.roblox.com returned no listing for universe ${universeId} (place ${placeId}). ` +
            'The place may be moderated or delisted; treating as unhealthy.'
        );
      }
    }
  } catch {
    apiUnhealthy = true;
    apiReason = 'health-api-fetch-error';
  }

  const combined = pageUnhealthy || apiUnhealthy;
  let reason = 'health-ok';
  if (combined) {
    reason = apiUnhealthy ? apiReason : pageReason;
  }
  return { shouldReupload: combined, reason, healthUrl };
}

async function isRobloxBaseHealthy() {
  try {
    const response = await requestWithRetry('https://www.roblox.com', {}, { operation: 'Roblox base health', retries: 2, timeoutMs: 15_000, baseMs: 1000, maxMs: 10_000 });
    const text = await response.text();
    return response.ok && text.trim().length > 0;
  } catch {
    return false;
  }
}

async function evaluateReuploadDecision(config) {
  const retryCountRaw = Number(config.monitor?.retryCount);
  const retryDelayRaw = Number(config.monitor?.retryDelayMs);
  const confirmDelayRaw = Number(config.monitor?.confirmDelayMs);
  const retryCount = Number.isFinite(retryCountRaw) && retryCountRaw >= 1 ? Math.floor(retryCountRaw) : 2;
  const retryDelayMs = Number.isFinite(retryDelayRaw) && retryDelayRaw >= 5_000 ? Math.floor(retryDelayRaw) : 30_000;
  const confirmDelayMs = Number.isFinite(confirmDelayRaw) && confirmDelayRaw >= 1_000 ? Math.floor(confirmDelayRaw) : 5_000;
  const robloxDownAttempts = retryCount + 1;

  for (let robloxAttempt = 1; robloxAttempt <= robloxDownAttempts; robloxAttempt += 1) {
    const firstHealth = await shouldReupload(config);
    if (!firstHealth.shouldReupload) {
      return { shouldReupload: false, reason: 'health-ok' };
    }

    const robloxHealthy = await isRobloxBaseHealthy();
    if (!robloxHealthy) {
      if (robloxAttempt < robloxDownAttempts) {
        console.log(
          `[WARN] Roblox base URL check failed (${robloxAttempt}/${robloxDownAttempts}) while game health looked unhealthy. ` +
            `Waiting ${Math.round(retryDelayMs / 1000)}s before retrying.`
        );
        await sleep(retryDelayMs);
        continue;
      }
      console.log('[WARN] Roblox base URL still unavailable after retries; skipping redeploy this cycle.');
      return { shouldReupload: false, reason: 'roblox-down' };
    }

    console.log(
      `[WARN] Game health check failed while Roblox is reachable; waiting ${Math.round(confirmDelayMs / 1000)}s before confirm check.`
    );
    await sleep(confirmDelayMs);

    const secondHealth = await shouldReupload(config);
    if (!secondHealth.shouldReupload) {
      console.log('[INFO] Health recovered on confirm check; skipping upload.');
      return { shouldReupload: false, reason: 'health-ok' };
    }

    return { shouldReupload: true, reason: secondHealth.reason };
  }

  return { shouldReupload: false, reason: 'unknown' };
}

export async function runReuploader(config, options = {}) {
  config = withPrimaryAccountApplied(config);
  const skipHealthCheck = Boolean(options.skipHealthCheck);
  const monitorUniverseId =
    config.accountPool?.primary?.experienceId ||
    config.experienceId;
  if (!skipHealthCheck) {
    const decision = await evaluateReuploadDecision(config);
    let livePlayers = 0;
    if (monitorUniverseId) {
      try {
        livePlayers = await fetchUniversePlayerCount(monitorUniverseId);
      } catch (err) {
        console.log(`[WARN] Could not fetch live player count: ${err.message}`);
      }
    } else {
      console.log('[WARN] Missing experienceId; cannot fetch live player count.');
    }
    const precheckVoiceCount = (decision.shouldReupload || decision.reason === 'roblox-down') ? 0 : livePlayers;
    spawnDiscordTask('reupload voice pre-check', async () => {
      await updateDiscordVoiceChannelPlayerCount(config, precheckVoiceCount);
    });
    if (!decision.shouldReupload) {
      spawnDiscordTask(
        decision.reason === 'roblox-down' ? 'reupload status down (roblox-down)' : 'reupload status up',
        async () => {
          await updateDiscordStatusChannel(config, decision.reason === 'roblox-down' ? 'down' : 'up');
        }
      );
      if (decision.reason === 'roblox-down') {
        console.log('[INFO] Roblox appears unavailable after retries; reupload skipped.');
      } else {
        console.log('[INFO] Existing game health check returned content. Reupload skipped.');
      }
      return;
    }
  }

  let uploadConfig = config;
  const resolvedConfigPath = options.configPath ? path.resolve(options.configPath) : '';
  if (config.accountPool?.backups?.length) {
    const previousExperienceId =
      config.accountPool?.primary?.experienceId ||
      config.experienceId;
    const rotatedTo = config.accountPool.backups.shift();
    if (!rotatedTo.experienceId && previousExperienceId) {
      rotatedTo.experienceId = previousExperienceId;
    }
    config.accountPool.primary = rotatedTo;
    uploadConfig = config;
    if (resolvedConfigPath) {
      saveRawConfig(resolvedConfigPath, config);
    } else {
      console.log('[WARN] Reupload rotation happened in memory only (no configPath provided to persist accountPool changes).');
    }
    console.log(`[INFO] Rotated primary uploader account to backup: ${rotatedTo.name || rotatedTo.userId}`);
  }

  console.log('[INFO] Health check failed or disabled; running normal upload pipeline...');
  return await runNormalUploadPipeline(uploadConfig, { configPath: resolvedConfigPath });
}

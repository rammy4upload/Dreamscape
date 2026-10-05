import fs from 'fs';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import readline from 'readline/promises';
import { RobloxClient, readBinaryFile } from '../src/shared/robloxClient.js';
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

function withPrimaryAccountApplied(config) {
  const pool = config.accountPool;
  if (!pool?.primary) {
    return config;
  }

  const primary = pool.primary;
  const next = structuredClone(config);
  const isGroup = coerceConfigBoolean(primary.isGroup, false);

  next.creatorAccount = {
    ...(next.creatorAccount || {}),
    name: primary.name || next.creatorAccount?.name || 'Primary Account',
    userId: primary.userId || next.creatorAccount?.userId,
    cookie: primary.cookie || next.creatorAccount?.cookie,
    apiKey: primary.apiKey || next.creatorAccount?.apiKey,
    isGroup
  };

  if (isGroup) {
    if (primary.groupId !== undefined && primary.groupId !== null && String(primary.groupId).trim() !== '') {
      next.creatorAccount.groupId = primary.groupId;
    }
    if (primary.groupApiKey) {
      next.creatorAccount.groupApiKey = primary.groupApiKey;
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
  fs.writeFileSync(path.resolve(configPath), `${stringifyConfigWithInlineAssetArrays(config)}\n`);
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
  if (config.accountPool?.primary) {
    return coerceConfigBoolean(config.accountPool.primary.isGroup, false);
  }

  return (
    coerceConfigBoolean(config.creatorAccount?.isGroup, false) ||
    coerceConfigBoolean(config.experience?.isGroup, false) ||
    coerceConfigBoolean(config.isGroup, false)
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
    config.groupApiKey
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

  const response = await client.get(`https://friends.roblox.com/v1/users/${sourceId}/friends/statuses?${query.toString()}`);
  return response.data?.find((status) => String(status.id) === targetId)?.status;
}

async function sendFriendRequest(client, targetUserId) {
  const targetId = normalizeUserId(targetUserId, 'target user ID');
  return client.post(`https://friends.roblox.com/v1/users/${targetId}/request-friendship`, {});
}

async function acceptFriendRequest(client, requesterUserId) {
  const requesterId = normalizeUserId(requesterUserId, 'requester user ID');
  return client.post(`https://friends.roblox.com/v1/users/${requesterId}/accept-friend-request`, {});
}

async function getUniversePlaces(client, universeId) {
  return client.get(`https://develop.roblox.com/v1/universes/${universeId}/places?sortOrder=Asc&limit=100`);
}

async function getUniversePermissions(client, universeId) {
  const query = new URLSearchParams();
  query.append('ids', String(universeId));
  const response = await client.get(`https://develop.roblox.com/v1/universes/multiget/permissions?${query.toString()}`);
  return response.data?.[0];
}

async function getUniverseMainPlaceId(client, universeId) {
  const query = new URLSearchParams();
  query.append('universeIds', String(universeId));
  const response = await client.get(`https://games.roblox.com/v1/games?${query.toString()}`);
  return response.data?.[0]?.rootPlaceId;
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
  const body = {
    desktopEnabled: true,
    mobileEnabled: true,
    tabletEnabled: true,
    consoleEnabled: true,
    vrEnabled: true
  };

  const masks = ['desktopEnabled', 'mobileEnabled', 'tabletEnabled', 'consoleEnabled', 'vrEnabled'];
  if (voiceOn) {
    body.voiceChatEnabled = true;
    masks.push('voiceChatEnabled');
  }

  const query = new URLSearchParams();
  query.append('updateMask', [...new Set(masks)].join(','));

  const response = await fetch(`https://apis.roblox.com/cloud/v2/universes/${universeId}?${query.toString()}`, {
    method: 'PATCH',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-api-key': apiKey
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Cloud universe update failed: ${response.status} ${response.statusText} ${bodyText}`);
  }

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

function isRobloxPrivateServerSettingsError(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  const m = error.message;
  return /private server settings/i.test(m) || (/\b500\b/.test(m) && /"code"\s*:\s*27\b/.test(m));
}

async function configureUniverse(client, universeId, experience, config) {
  const desiredAvatarType = 'MorphToPlayerChoice'; // R6 + R15 (player choice)
  try {
    const configUrl = `https://develop.roblox.com/v2/universes/${universeId}/configuration`;
    const basePayload = {
      name: experience.name,
      description: experience.description,
      universeAvatarType: desiredAvatarType,
      playerAvatarType: desiredAvatarType,
      universeAnimationType: 'PlayerChoice',
      isArchived: false,
      permissions: {
        IsThirdPartyTeleportAllowed: true,
        IsThirdPartyAssetAllowed: true,
        IsThirdPartyPurchaseAllowed: true,
        IsClientTeleportAllowed: true
      }
    };
    try {
      await client.patch(configUrl, {
        ...basePayload,
        allowPrivateServers: false,
        privateServerPrice: null
      });
    } catch (err) {
      // Roblox sometimes 500s (code 27) on the private-server fields (common for group-owned
      // experiences / universes where private servers are already off). Retry without them.
      if (!isRobloxPrivateServerSettingsError(err)) {
        throw err;
      }
      console.log(
        `[WARN] Roblox rejected private server settings for universe ${universeId} (500 code 27); retrying configuration without them.`
      );
      try {
        await client.patch(configUrl, basePayload);
      } catch (retryErr) {
        if (!isRobloxPrivateServerSettingsError(retryErr)) {
          throw retryErr;
        }
        console.log(
          `[WARN] Roblox still returned code 27 for universe ${universeId}; skipping this configuration PATCH and continuing (check name/description/avatar settings manually if needed).`
        );
      }
    }
  } catch (err) {
    if (!isRobloxUnauthorized(err)) {
      throw err;
    }

    console.log(`[WARN] Creator account is not authorized to configure universe ${universeId}; skipping universe configuration.`);
    return;
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
      playableDevices: ['Computer', 'Phone', 'Tablet', 'Console']
    });
    console.log(`[SUCCESS] Enabled Console as a playable device for universe ${universeId}`);
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

async function uploadPlaceFile(universeId, placeId, rbxlPath, apiKey, config = null) {
  requireValue(apiKey, 'Open Cloud API key for place publishing');

  let data = readBinaryFile(rbxlPath);
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
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'x-api-key': apiKey,
        'content-type': 'application/octet-stream'
      },
      body: data
    });

    if (response.ok) {
      return response.json();
    }

    lastStatus = response.status;
    lastBody = await response.text();

    if (attempt < maxAttempts && isOpenCloudPlacePublishRetryable(lastStatus, lastBody)) {
      const delayMs = openCloudPlacePublishBackoffMs(attempt - 1);
      console.log(
        `[INFO] Open Cloud place publish busy or transient (${lastStatus}) for place ${placeId}; ` +
          `retry ${attempt + 1}/${maxAttempts} after ${Math.round(delayMs / 1000)}s…`
      );
      await sleep(delayMs);
      continue;
    }

    if (isOpenCloudInsufficientScopes(lastStatus, lastBody)) {
      throw new Error(
        `Open Cloud place publish failed for place ${placeId}: API key is missing the **Universe Places → Write** scope ` +
          `(401 insufficient scopes). ${config ? openCloudPlacePublishScopeSetupHint(config) : 'Add Universe Places → Write on your Creator Dashboard API key.'} ` +
          `Roblox response: ${lastBody}`
      );
    }

    throw new Error(`Open Cloud place publish failed for place ${placeId}: ${lastStatus} ${response.statusText} ${lastBody}`);
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
  const response = await fetch(`https://discord.com/api/v10${endpointPath}`, {
    ...options,
    headers: {
      authorization: `Bot ${botToken}`,
      ...(options.headers || {})
    }
  });

  return response;
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
  const response = await fetch(`https://games.roblox.com/v1/games?universeIds=${encodeURIComponent(id)}`);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Roblox games API failed: ${response.status} ${response.statusText} ${body}`);
  }
  const payload = await response.json();
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
    ? '❌・DOWN'
    : status === 'reuploading'
      ? '🟡・REUPLOADING'
      : '✅・UP';

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
  fs.writeFileSync(resolvedPath, `${stringifyConfigWithInlineAssetArrays(data)}\n`);
}

async function updateDiscordVoiceChannelsAtUploadStart(config) {
  await updateDiscordVoiceChannelPlayerCount(config, 0);
  await updateDiscordStatusChannel(config, 'reuploading');
}

async function updateDiscordVoiceChannelsOnUploadFailure(config) {
  await updateDiscordVoiceChannelPlayerCount(config, 0);
  await updateDiscordStatusChannel(config, 'down');
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
  await updateDiscordStatusChannel(config, 'up');
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
  fs.writeFileSync(resolvedPath, `${stringifyConfigWithInlineAssetArrays(data)}\n`);
  console.log(`[SUCCESS] Updated monitor.healthUrl in ${resolvedPath}`);
  console.log(`[INFO] ${data.monitor.healthUrl}`);
}

async function resolveExperiencePlaceIds(client, config) {
  const experience = config.experience;
  const universeId = requireValue(config.experienceId, 'experienceId');
  requireValue(experience?.name, 'experience.name');
  requireValue(experience?.description, 'experience.description');
  requireValue(experience?.rbxlPath, 'experience.rbxlPath');
  const universePermissions = await getUniversePermissions(client, universeId);
  if (!universePermissions?.canManage) {
    throw new Error(
      `Configured creator account cannot manage universe ${universeId}. ` +
      'Use the universe owner account cookie, or for group-owned games use a member cookie with Manage experience permission on the group.'
    );
  }

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
  

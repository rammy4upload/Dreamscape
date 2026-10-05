import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import './promptBridgeClient.js';
import {
  runReuploader,
  runFullUploadPipeline,
  runNormalUploadPipeline,
  runRbxlUploadOnly,
  runConfigureExperienceOnly,
  runPushPlaceIdsOnly,
  runGrantFriendsPipeline,
  runGrantPermissionsPipeline,
  runMonitorService,
  runChannelStatusService,
  runModeAddBackupAccount,
} from './reuploader.js';

const DEFAULT_CONFIG = process.env.CONFIG_PATH || './config.json';

function readConfig(configPath) {
  return JSON.parse(fs.readFileSync(path.resolve(configPath), 'utf8'));
}

function parseCli(argv) {
  let configPath = DEFAULT_CONFIG;
  const tokens = [];

  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--config' || a === '-c') {
      configPath = argv[i + 1] || configPath;
      i += 1;
      continue;
    }

    if (a.startsWith('--config=')) {
      configPath = a.slice('--config='.length);
      continue;
    }

    tokens.push(a);
  }

  const commandNames = tokens.map((t) => (t.startsWith('--') ? t.slice(2) : t));
  const has = (n) => commandNames.includes(n);

  if (has('help') || has('h') || tokens.includes('-h')) {
    return { command: 'help', configPath };
  }

  const priority = [
    'service',
    'channelstatusservice',
    'fullupload',
    'normalupload',
    'configureexperience',
    'pushplaceids',
    'rbxlupload',
    'addfriends',
    'grantpermissions',
    'add-backup-account',
    'reupload'
  ];

  for (const c of priority) {
    if (has(c)) {
      return { command: c, configPath };
    }
  }

  return { command: 'reupload', configPath };
}

function programName() {
  const base = path.basename(process.argv[1] || '', '.js');
  if (base && base !== 'node' && base !== 'index') {
    return base;
  }

  return 'autoreuploader';
}

function printHelp() {
  const name = programName();
  console.log(`Pokemon Brick Bronze AutoReuploader

Usage:
  ${name} <command> [options]
  node index.js <command> [options]

Commands:
  --fullupload     Full upload with permissions: friends, universe edit / Team Create, Open Cloud
                   asset Use grants, unfriend helper, then universe/places, RBXL, media, place IDs.
                   Writes monitor.healthUrl to https://www.roblox.com/games/<Main place id>.
  --normalupload   Full publish path without friend automation or permission grants:
                   configure universe/places, RBXL upload, media, place IDs, health URL update.
  --configureexperience
                   Configure universe + Main/Battle/Trade + icons/thumbnails on Roblox only.
                   No RBXL, friends/grants, place ID file/git push, or monitor.healthUrl update.
  --pushplaceids   Push placeids.json only using config.experience.places.*.placeId
                   and placeIds.git settings (git add/commit/push).
  --rbxlupload     Open Cloud RBXL publish to Main / Battle / Trade only.
  --addfriends     Friend requests/accepts only, then opens Roblox Studio on the Main place so you
                   can grant collaborators manually. No automatic Team Create grants, no Open Cloud
                   asset grants, no unfriend helper.
  --grantpermissions
                   Same permission slice as full upload: friends + universe edit / Team Create,
                   Open Cloud asset Use grants, unfriend helper. No RBXL or media.
  --reupload       One-shot: GET monitor.healthUrl; if OK and body non-empty, exit (no work).
                   On failure, rotate to first backup account (if available), promote it to primary,
                   then run like --normalupload and update monitor.healthUrl.
                   Does NOT start --service (use --service for a long-running monitor).
  --service        Loop: sleep intervalMs, check health URL, on failure rotate backup and run
                   like --normalupload, then update monitor.healthUrl. Ctrl+C to stop.
  --channelstatusservice
                   Loop: same intervalMs as --service; updates Discord player-count and status
                   voice channels only (no upload, no account rotation). Ctrl+C to stop.
  --add-backup-account
                   Interactive: add accountPool.backups entry (name, userId, cookie, apiKey, experienceId;
                   optional group fields: isGroup, groupId, groupApiKey, groupOwnerUserId, groupOwnerName,
                   groupOwnerCookie), save config, then run the same permission grants as --grantpermissions.

Flags:
  --config, -c PATH   Config JSON (default: ${DEFAULT_CONFIG})

Set AUTOREUPLOADER_NO_HELP_PAUSE=1 to skip the "press a key" wait after --help.
`);
}

async function pauseAfterHelpIfUseful() {
  if (process.env.CI || process.env.AUTOREUPLOADER_NO_HELP_PAUSE) {
    return;
  }

  if (!process.stdout.isTTY) {
    return;
  }

  if (process.stdin.isTTY) {
    const readline = await import('readline/promises');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    try {
      await rl.question('\nPress Enter to exit...');
    } finally {
      rl.close();
    }

    return;
  }

  if (process.platform === 'win32') {
    const shell = process.env.ComSpec || 'cmd.exe';
    spawnSync(shell, ['/d', '/c', 'pause'], { stdio: 'inherit' });
  }
}

export async function main() {
  const { command, configPath } = parseCli(process.argv);

  if (command === 'help') {
    printHelp();
    await pauseAfterHelpIfUseful();
    return;
  }

  if (command === 'service') {
    await runMonitorService(configPath);
    return;
  }

  if (command === 'channelstatusservice') {
    await runChannelStatusService(configPath);
    return;
  }

  if (command === 'add-backup-account') {
    await runModeAddBackupAccount(configPath);
    return;
  }

  const config = readConfig(configPath);

  switch (command) {
    case 'fullupload':
      await runFullUploadPipeline(config, { configPath });
      break;
    case 'normalupload':
      await runNormalUploadPipeline(config, { configPath });
      break;
    case 'configureexperience':
      await runConfigureExperienceOnly(config);
      break;
    case 'pushplaceids':
      await runPushPlaceIdsOnly(config, { configPath });
      break;
    case 'rbxlupload':
      await runRbxlUploadOnly(config, { configPath });
      break;
    case 'addfriends':
      await runGrantFriendsPipeline(config);
      break;
    case 'grantpermissions':
      await runGrantPermissionsPipeline(config);
      break;
    case 'reupload':
      await runReuploader(config, { configPath });
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

process.on('unhandledRejection', (reason) => {
  console.error('[FAIL] Unhandled rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[FAIL] Uncaught exception:', err);
});

const entryPath = process.argv[1] && path.resolve(process.argv[1]);
const thisFile = fileURLToPath(import.meta.url);
const ranAsThisFile = entryPath && path.resolve(thisFile) === entryPath;

if (ranAsThisFile) {
  main().catch((err) => {
    console.error('[FAIL]', err);
    process.exitCode = 1;
  });
}

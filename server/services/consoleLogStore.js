import fs from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { dataPath, ensureDataDir } from '../config.js';
import { broadcast } from './wsHub.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const MAX_BYTES = 2 * 1024 * 1024;

let buffer = '';
let initialized = false;
let currentDeployId = '';

function metaPath() {
  return dataPath('dashboard-console.meta.json');
}

function logPath() {
  return dataPath('dashboard-console.log');
}

function readLocalGitCommit() {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export function getDeployId() {
  return (
    process.env.RAILWAY_GIT_COMMIT_SHA ||
    process.env.RAILWAY_DEPLOYMENT_ID ||
    process.env.SOURCE_VERSION ||
    process.env.GIT_COMMIT ||
    readLocalGitCommit() ||
    'local'
  );
}

function trimBuffer() {
  if (Buffer.byteLength(buffer, 'utf8') <= MAX_BYTES) {
    return false;
  }

  const bytes = Buffer.from(buffer, 'utf8');
  buffer = bytes.subarray(bytes.length - MAX_BYTES).toString('utf8');
  return true;
}

function writeLogFile() {
  fs.writeFileSync(logPath(), buffer, 'utf8');
}

function persistBuffer() {
  ensureDataDir();
  writeLogFile();
}

export function initDashboardConsole() {
  if (initialized) {
    return { deployId: currentDeployId, reset: false };
  }

  ensureDataDir();
  currentDeployId = getDeployId();

  let previousDeployId = null;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath(), 'utf8'));
    previousDeployId = meta.deployId;
  } catch {
    previousDeployId = null;
  }

  const reset = previousDeployId !== currentDeployId;
  if (reset) {
    const shortId = currentDeployId.slice(0, 12);
    buffer = `[dashboard] Console reset for deploy ${shortId}\n`;
    persistBuffer();
    fs.writeFileSync(
      metaPath(),
      JSON.stringify({ deployId: currentDeployId, resetAt: new Date().toISOString() }, null, 2),
      'utf8'
    );
  } else {
    try {
      buffer = fs.readFileSync(logPath(), 'utf8');
    } catch {
      buffer = '';
    }
  }

  initialized = true;
  return { deployId: currentDeployId, reset };
}

export function getDashboardConsoleText() {
  if (!initialized) {
    initDashboardConsole();
  }
  return buffer;
}

export function appendDashboardConsole(text, { taskId, broadcast: shouldBroadcast = true } = {}) {
  if (!text) {
    return;
  }

  if (!initialized) {
    initDashboardConsole();
  }

  buffer += text;
  const trimmed = trimBuffer();
  if (trimmed) {
    persistBuffer();
  } else {
    try {
      fs.appendFileSync(logPath(), text, 'utf8');
    } catch {
      persistBuffer();
    }
  }

  if (shouldBroadcast) {
    broadcast({
      type: 'console-log',
      chunk: text,
      ...(taskId ? { taskId } : {}),
    });
  }
}

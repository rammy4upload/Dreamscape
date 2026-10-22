import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { Router } from 'express';
import { requireDashboardAuth } from '../middleware/auth.js';
import { serverConfig } from '../config.js';
import { broadcast } from '../services/wsHub.js';
import { appendDashboardConsole } from '../services/consoleLogStore.js';
import { openTaskPrompt, waitForTaskPrompt, resolveTaskPrompt } from '../services/taskPrompts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

/** @type {Map<string, { id: string, command: string, args: string[], process: import('child_process').ChildProcess, logs: string[], status: string, prompts: object[], exitCode?: number }>} */
const tasks = new Map();

const COMMAND_ALIASES = {
  reupload: '--reupload',
  fullupload: '--fullupload',
  normalupload: '--normalupload',
  configureexperience: '--configureexperience',
  configure: '--configureexperience',
  pushplaceids: '--pushplaceids',
  rbxlupload: '--rbxlupload',
  addfriends: '--addfriends',
  grantpermissions: '--grantpermissions',
  service: '--service',
  channelstatusservice: '--channelstatusservice',
  'add-backup-account': '--add-backup-account',
  help: '--help',
};

export function normalizeCommand(command) {
  const raw = String(command || '').trim();
  if (!raw) {
    return '--reupload';
  }
  if (raw.startsWith('--')) {
    return raw;
  }
  const key = raw.toLowerCase().replace(/\s+/g, '');
  return COMMAND_ALIASES[key] || `--${key}`;
}

function createTaskId() {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function appendLog(task, chunk) {
  const text = chunk.toString();
  task.logs.push(text);
  if (task.logs.length > 2000) {
    task.logs.splice(0, task.logs.length - 2000);
  }

  appendDashboardConsole(text, { taskId: task.id, broadcast: false });

  broadcast({
    type: 'task-log',
    taskId: task.id,
    command: task.command,
    chunk: text,
  });

  if (text.includes('[ACTION REQUIRED]')) {
    const prompt = {
      id: `prompt-${Date.now()}`,
      message: text.trim(),
      createdAt: new Date().toISOString(),
      resolved: false,
    };
    task.prompts.push(prompt);
    broadcast({ type: 'task-prompt', taskId: task.id, prompt });
  }
}

export function startTask(command, args = []) {
  const normalized = normalizeCommand(command);
  const id = createTaskId();
  const child = spawn(
    process.execPath,
    [path.join(projectRoot, 'cli/index.js'), normalized, '--config', serverConfig.configPath, ...args],
    {
    cwd: projectRoot,
    env: {
      ...process.env,
      WEB_PROMPTS: '1',
      HEADLESS: serverConfig.headless ? '1' : '0',
      CONFIG_PATH: serverConfig.configPath,
      DATA_DIR: serverConfig.dataDir,
      TSHIRT_TEMPLATE_PATH: serverConfig.tshirtTemplatePath,
      AUTO_REUPLOADER_TASK_ID: id,
      PORT: String(serverConfig.port),
      ...(serverConfig.dashboardPassword
        ? { DASHBOARD_PASSWORD: serverConfig.dashboardPassword }
        : {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const task = {
    id,
    command: normalized,
    args,
    process: child,
    logs: [],
    status: 'running',
    prompts: [],
  };
  tasks.set(id, task);

  const startLine = `\n[task ${id}] started ${normalized}\n`;
  appendDashboardConsole(startLine, { taskId: id, broadcast: true });

  broadcast({
    type: 'task-start',
    taskId: id,
    command: normalized,
  });

  child.stdout.on('data', (chunk) => appendLog(task, chunk));
  child.stderr.on('data', (chunk) => appendLog(task, chunk));
  child.on('close', (code) => {
    task.status = code === 0 ? 'completed' : 'failed';
    task.exitCode = code;
    const endLine = `\n[task ${id}] ${task.status} (exit ${code})\n`;
    appendDashboardConsole(endLine, { taskId: id, broadcast: true });

    broadcast({
      type: 'task-end',
      taskId: id,
      status: task.status,
      exitCode: code,
    });
  });

  appendLog(task, `[dashboard] Started ${normalized}\n`);

  const needsOperator =
    normalized.includes('fullupload') ||
    normalized.includes('grantpermissions') ||
    normalized.includes('addfriends') ||
    normalized.includes('add-backup-account');
  if (needsOperator && (process.env.RAILWAY_ENVIRONMENT || process.env.WEB_PROMPTS === '1')) {
    appendLog(
      task,
      '[dashboard] Railway mode: keep this tab open. Manual steps show in **Manual prompt** — type answers when asked, or click Continue for action-only steps.\n'
    );
  }

  return task;
}

const router = Router();
router.use(requireDashboardAuth);

router.get('/tasks', (_req, res) => {
  res.json({
    tasks: [...tasks.values()].map((task) => ({
      id: task.id,
      command: task.command,
      args: task.args,
      status: task.status,
      exitCode: task.exitCode,
      promptCount: task.prompts.filter((p) => !p.resolved).length,
      logTail: task.logs.slice(-40).join(''),
    })),
  });
});

router.get('/tasks/:id', (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  return res.json({
    id: task.id,
    command: task.command,
    args: task.args,
    status: task.status,
    exitCode: task.exitCode,
    logs: task.logs.join(''),
    prompts: task.prompts,
  });
});

router.post('/tasks', (req, res) => {
  const { command = 'reupload', args = [] } = req.body || {};
  const task = startTask(command, args);
  return res.status(201).json({ id: task.id, status: task.status, command: task.command });
});

router.post('/tasks/:id/prompts', (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  if (task.status !== 'running') {
    return res.status(400).json({ error: 'Task is not running' });
  }

  const { message = '', meta = {} } = req.body || {};
  const promptId = openTaskPrompt(task.id, String(message), meta);
  return res.status(201).json({ promptId });
});

router.get('/tasks/:id/prompts/:promptId/wait', async (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const timeoutMs = Number(req.query.timeoutMs) || 25000;
  const answer = await waitForTaskPrompt(req.params.promptId, timeoutMs);
  if (answer === null) {
    return res.status(408).json({ error: 'Prompt still pending' });
  }

  return res.json({ answer });
});

router.post('/tasks/:id/ack', (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  if (task.status !== 'running') {
    return res.status(400).json({ error: 'Task is not running' });
  }

  const answer = req.body?.answer === 'quit' ? 'quit\n' : '\n';
  task.process.stdin.write(answer);

  const pending = task.prompts.find((p) => !p.resolved);
  if (pending) {
    pending.resolved = true;
    pending.resolvedAt = new Date().toISOString();
  }

  return res.json({ ok: true });
});

router.delete('/tasks/:id', (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  task.process.kill('SIGTERM');
  task.status = 'stopped';
  return res.json({ ok: true });
});

export default router;
export { tasks, resolveTaskPrompt };

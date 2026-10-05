import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { serverConfig, ensureDataDir } from './config.js';
import { ensureConfigFile } from './services/configStore.js';
import { normalizePersistedAssetPaths } from './services/assetStore.js';
import {
  appendDashboardConsole,
  getDashboardConsoleText,
  getDeployId,
  initDashboardConsole,
} from './services/consoleLogStore.js';
import { initDashboardAuth, getAuthEpoch } from './services/dashboardAuth.js';
import { getDeploymentStatus, logDeploymentStatus } from './services/railwaySetup.js';
import { requireDashboardAuth } from './middleware/auth.js';
import productsRouter from './routes/products.js';
import codesRouter from './routes/codes.js';
import autoreuploaderRouter, { tasks, resolveTaskPrompt } from './routes/autoreuploader.js';
import placeidsRouter from './routes/placeids.js';
import dashboardRouter from './routes/dashboard.js';
import integrationRouter from './routes/integration.js';
import { registerClient, broadcast, disconnectAllClients } from './services/wsHub.js';
import {
  browserSessions,
  captureSessionScreenshot,
  setWebPromptHandler,
} from '../src/shared/promptBridge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

ensureDataDir();
ensureConfigFile();
normalizePersistedAssetPaths({ save: true });
initDashboardAuth();

const consoleInit = initDashboardConsole();
if (consoleInit.reset) {
  const deployment = getDeploymentStatus();
  for (const warning of deployment.warnings || []) {
    appendDashboardConsole(`[dashboard] ${warning}\n`, { broadcast: false });
  }
  if (deployment.publicUrl) {
    appendDashboardConsole(`[dashboard] Public URL: ${deployment.publicUrl}\n`, { broadcast: false });
  }
  if (deployment.gameIntegration?.productBridgeBaseUrl) {
    appendDashboardConsole(
      `[dashboard] Game URL: ${deployment.gameIntegration.productBridgeBaseUrl}\n` +
        `[dashboard] Codes: ${deployment.gameIntegration.codesUrl || 'n/a'}\n`,
      { broadcast: false }
    );
  }
}
app.use(
  '/api/dashboard/assets',
  express.raw({ type: 'application/octet-stream', limit: '250mb' })
);
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'dashboard', 'static')));

app.get('/health', (_req, res) => {
  const deployment = getDeploymentStatus();
  res.json({
    ok: deployment.ok,
    tasks: tasks.size,
    browserSessions: browserSessions.size,
    deployment,
  });
});

app.use('/api/integration', integrationRouter);
app.use('/api/products', productsRouter);
app.use('/api/codes', codesRouter);
app.use('/api/placeids', placeidsRouter);
app.use('/api/autoreuploader', autoreuploaderRouter);
app.use('/api/dashboard', dashboardRouter);

app.get('/api/browser-sessions', requireDashboardAuth, (_req, res) => {
  res.json({
    sessions: [...browserSessions.entries()].map(([id, entry]) => ({
      id,
      meta: entry.meta,
      createdAt: entry.createdAt,
    })),
  });
});

app.get('/api/browser-sessions/:id/screenshot', requireDashboardAuth, async (req, res) => {
  const image = await captureSessionScreenshot(req.params.id);
  if (!image) {
    return res.status(404).json({ error: 'No screenshot available' });
  }
  return res.json({ imageBase64: image });
});

const server = app.listen(serverConfig.port, () => {
  console.log(`[server] Listening on port ${serverConfig.port}`);
  console.log(`[server] Dashboard: http://localhost:${serverConfig.port}`);
  console.log(`[server] Product API: POST /api/products/resolve`);
  logDeploymentStatus();
});

const wss = new WebSocketServer({ server, path: '/ws' });

/** @type {Map<string, { resolve: (value: string) => void, reject: (error: Error) => void }>} */
const pendingPrompts = new Map();

setWebPromptHandler(async (message, meta = {}) => {
  const promptId = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const payload = {
    type: 'prompt',
    id: promptId,
    message,
    meta,
    createdAt: new Date().toISOString(),
  };

  const clients = [...wss.clients].filter((client) => client.readyState === 1);
  if (!clients.length) {
    throw new Error('No dashboard client connected to acknowledge manual prompts.');
  }

  broadcast(payload);

  return new Promise((resolve, reject) => {
    pendingPrompts.set(promptId, { resolve, reject });
    setTimeout(() => {
      if (pendingPrompts.has(promptId)) {
        pendingPrompts.delete(promptId);
        reject(new Error(`Prompt timed out: ${message}`));
      }
    }, 30 * 60 * 1000);
  });
});

function attachSocketMessageHandler(socket) {
  socket.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (data.type === 'prompt-ack' && data.id) {
      if (pendingPrompts.has(data.id)) {
        const pending = pendingPrompts.get(data.id);
        pendingPrompts.delete(data.id);
        pending.resolve(data.answer === 'quit' ? 'quit' : data.answer ?? '');
      } else if (resolveTaskPrompt(data.id, data.answer === 'quit' ? 'quit' : data.answer ?? '')) {
        // Task subprocess prompt resolved.
      }
    }
  });
}

wss.on('connection', (socket) => {
  const finishAuth = () => {
    registerClient(socket);
    socket.send(
      JSON.stringify({
        type: 'hello',
        tasks: tasks.size,
        deployId: getDeployId(),
        authEpoch: getAuthEpoch(),
        consoleSnapshot: getDashboardConsoleText(),
      })
    );
    attachSocketMessageHandler(socket);
  };

  if (!serverConfig.dashboardPassword) {
    finishAuth();
    return;
  }

  let authed = false;
  const authTimeout = setTimeout(() => {
    if (!authed) socket.close(4401, 'Unauthorized');
  }, 10000);

  const authHandler = (raw) => {
    let data;
    try {
      data = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (data.type !== 'auth') {
      return;
    }

    socket.removeListener('message', authHandler);
    clearTimeout(authTimeout);

    const token = String(data.token || '').trim();
    if (token !== serverConfig.dashboardPassword) {
      socket.close(4401, 'Unauthorized');
      return;
    }

    authed = true;
    finishAuth();
  };

  socket.send(JSON.stringify({ type: 'auth-required' }));
  socket.on('message', authHandler);
});

setInterval(async () => {
  for (const [sessionId] of browserSessions.entries()) {
    const image = await captureSessionScreenshot(sessionId);
    if (!image) {
      continue;
    }
    broadcast({
      type: 'browser-screenshot',
      sessionId,
      imageBase64: image,
    });
  }
}, 4000);

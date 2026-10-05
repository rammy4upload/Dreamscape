import { setWebPromptHandler } from '../src/shared/promptBridge.js';

async function requestDashboardPrompt(message, meta = {}) {
  const taskId = process.env.AUTO_REUPLOADER_TASK_ID;
  if (!taskId) {
    throw new Error('AUTO_REUPLOADER_TASK_ID is not set');
  }

  const port = process.env.PORT || '3000';
  const base = process.env.DASHBOARD_INTERNAL_URL || `http://127.0.0.1:${port}`;
  const token = process.env.DASHBOARD_PASSWORD || '';
  const headers = {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };

  const createRes = await fetch(`${base}/api/autoreuploader/tasks/${taskId}/prompts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message, meta }),
  });

  if (!createRes.ok) {
    const body = await createRes.text();
    throw new Error(`Dashboard prompt failed (${createRes.status}): ${body}`);
  }

  const { promptId } = await createRes.json();
  if (!promptId) {
    throw new Error('Dashboard prompt did not return a promptId');
  }

  for (let attempt = 0; attempt < 240; attempt += 1) {
    const waitRes = await fetch(
      `${base}/api/autoreuploader/tasks/${taskId}/prompts/${promptId}/wait?timeoutMs=25000`,
      { headers: token ? { authorization: `Bearer ${token}` } : {} }
    );

    if (waitRes.status === 200) {
      const data = await waitRes.json();
      if (data.answer === 'quit') {
        throw new Error('Operator aborted the current action.');
      }
      return data.answer ?? '';
    }

    if (waitRes.status !== 408) {
      const body = await waitRes.text();
      throw new Error(`Dashboard prompt wait failed (${waitRes.status}): ${body}`);
    }
  }

  throw new Error(`Prompt timed out waiting for dashboard input: ${message}`);
}

if (process.env.WEB_PROMPTS === '1' && process.env.AUTO_REUPLOADER_TASK_ID) {
  setWebPromptHandler(async (message, meta = {}) => {
    const kind = meta.kind === 'input' ? 'input' : 'confirm';
    return requestDashboardPrompt(message, { ...meta, kind });
  });
}

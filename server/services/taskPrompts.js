import { broadcast } from './wsHub.js';

/** @type {Map<string, { taskId: string, message: string, meta: Record<string, unknown>, settled: boolean, answer: string | null, waiters: Array<(value: string) => void> }>} */
const pending = new Map();

export function openTaskPrompt(taskId, message, meta = {}) {
  const kind = meta.kind === 'input' ? 'input' : 'confirm';
  const promptId = `taskprompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  pending.set(promptId, {
    taskId,
    message,
    meta: { ...meta, kind },
    settled: false,
    answer: null,
    waiters: [],
  });

  broadcast({
    type: 'prompt',
    id: promptId,
    taskId,
    message,
    meta: { ...meta, kind },
    createdAt: new Date().toISOString(),
  });

  setTimeout(() => {
    if (pending.has(promptId) && !pending.get(promptId).settled) {
      settleTaskPrompt(promptId, '', { timedOut: true });
    }
  }, 30 * 60 * 1000);

  return promptId;
}

export function settleTaskPrompt(promptId, answer, { timedOut = false } = {}) {
  const entry = pending.get(promptId);
  if (!entry || entry.settled) {
    return false;
  }

  entry.settled = true;
  entry.answer = answer;
  const waiters = [...entry.waiters];
  entry.waiters.length = 0;
  pending.delete(promptId);

  for (const waiter of waiters) {
    waiter(answer);
  }

  if (timedOut) {
    broadcast({
      type: 'prompt-timeout',
      id: promptId,
      taskId: entry.taskId,
    });
  }

  return true;
}

export function waitForTaskPrompt(promptId, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const entry = pending.get(promptId);
    if (!entry) {
      resolve(null);
      return;
    }

    if (entry.settled) {
      resolve(entry.answer);
      return;
    }

    const timer = setTimeout(() => {
      const idx = entry.waiters.indexOf(onAnswer);
      if (idx >= 0) {
        entry.waiters.splice(idx, 1);
      }
      resolve(null);
    }, timeoutMs);

    function onAnswer(value) {
      clearTimeout(timer);
      resolve(value);
    }

    entry.waiters.push(onAnswer);
  });
}

export function resolveTaskPrompt(promptId, answer) {
  return settleTaskPrompt(promptId, answer);
}

import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

/** @type {((message: string, meta?: Record<string, unknown>) => Promise<string>) | null} */
let webPromptHandler = null;

/** Active Playwright sessions keyed by session id (for dashboard screenshots). */
export const browserSessions = new Map();

export function setWebPromptHandler(handler) {
  webPromptHandler = handler;
}

export function isWebPromptMode() {
  return Boolean(webPromptHandler);
}

/**
 * Wait for the operator to acknowledge a manual step.
 * In web mode the dashboard shows the message and resolves when the user clicks Continue.
 */
export async function waitForEnterPrompt(message, meta = {}) {
  if (webPromptHandler) {
    const response = await webPromptHandler(message, { ...meta, kind: 'confirm' });
    if (response === 'quit') {
      throw new Error('Operator aborted the current action.');
    }
    return response;
  }

  if (!input.isTTY) {
    throw new Error(
      `Manual step required but stdin is not interactive: ${message}\nUse the web dashboard or run from a terminal.`
    );
  }

  console.log(message);
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question('Press Enter to continue (type quit to abort)... ');
    if (String(answer).trim().toLowerCase() === 'quit') {
      throw new Error('Operator aborted the current action.');
    }
    return answer;
  } finally {
    rl.close();
  }
}

/**
 * Prompt for a line of text (backup account wizard, etc.).
 */
export async function waitForLinePrompt(message, meta = {}) {
  if (webPromptHandler) {
    console.log(message);
    const response = await webPromptHandler(message, { ...meta, kind: 'input' });
    if (response === 'quit') {
      throw new Error('Operator aborted the current action.');
    }
    return response;
  }

  if (!input.isTTY) {
    throw new Error(
      `Input required but stdin is not interactive: ${message}\nUse the web dashboard or run from a terminal.`
    );
  }

  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(message);
    if (String(answer).trim().toLowerCase() === 'quit') {
      throw new Error('Operator aborted the current action.');
    }
    return answer;
  } finally {
    rl.close();
  }
}

export function createPromptInterface() {
  return {
    async question(message) {
      const isSensitive = /cookie|api key|password|token/i.test(message);
      return waitForLinePrompt(message, {
        kind: 'input',
        inputType: isSensitive ? 'password' : 'text',
      });
    },
    close() {},
  };
}

export function registerBrowserSession(sessionId, browser, meta = {}) {
  browserSessions.set(sessionId, { browser, meta, createdAt: Date.now() });
}

export function unregisterBrowserSession(sessionId) {
  browserSessions.delete(sessionId);
}

export async function captureSessionScreenshot(sessionId) {
  const entry = browserSessions.get(sessionId);
  if (!entry?.browser) {
    return null;
  }

  try {
    const contexts = entry.browser.contexts();
    const page = contexts[0]?.pages()?.[0];
    if (!page) {
      return null;
    }
    const buffer = await page.screenshot({ type: 'jpeg', quality: 70 });
    return buffer.toString('base64');
  } catch {
    return null;
  }
}

import { safeErrorMessage, log } from './structuredLogger.js';

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 520, 522, 524]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredBackoff(attempt, baseMs = 1000, maxMs = 60_000) {
  const exp = Math.min(maxMs, baseMs * (2 ** Math.max(0, attempt - 1)));
  return Math.min(maxMs, Math.round(exp * (0.75 + Math.random() * 0.5)));
}

export async function requestWithRetry(url, options = {}, retryOptions = {}) {
  const retries = Math.max(0, Number(retryOptions.retries ?? 5));
  const timeoutMs = Math.max(1000, Number(retryOptions.timeoutMs ?? 30_000));
  const operation = retryOptions.operation || 'http-request';
  let lastError;

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeout);

      if (response.ok) return response;

      if (!RETRYABLE.has(response.status) || attempt > retries) {
        return response;
      }

      let delayMs = jitteredBackoff(attempt, retryOptions.baseMs ?? 1000, retryOptions.maxMs ?? 60_000);
      const retryAfter = Number(response.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        delayMs = Math.min(retryOptions.maxMs ?? 60_000, Math.max(delayMs, retryAfter * 1000));
      }
      log('RETRY', `${operation} retry scheduled`, { attempt, status: response.status, delayMs });
      await sleep(delayMs);
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (attempt > retries) throw error;
      const delayMs = jitteredBackoff(attempt, retryOptions.baseMs ?? 1000, retryOptions.maxMs ?? 60_000);
      log('RETRY', `${operation} transport retry scheduled`, { attempt, delayMs, error: safeErrorMessage(error) });
      await sleep(delayMs);
    }
  }

  throw lastError || new Error(`${operation} failed`);
}

export async function requestJson(url, options = {}, retryOptions = {}) {
  const response = await requestWithRetry(url, options, retryOptions);
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`${retryOptions.operation || 'request'} failed: HTTP ${response.status}`);
    error.status = response.status;
    error.body = text.slice(0, 1000);
    throw error;
  }
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error(`${retryOptions.operation || 'request'} returned malformed JSON`);
    error.status = response.status;
    throw error;
  }
}

export function isRetryableStatus(status) {
  return RETRYABLE.has(Number(status));
}

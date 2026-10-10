import fs from 'fs';
import { safeErrorMessage, log } from './structuredLogger.js';
import { isRetryableStatus } from './httpClient.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredBackoff(attempt, baseMs, maxMs) {
  const exp = Math.min(maxMs, baseMs * (2 ** Math.max(0, attempt - 1)));
  return Math.min(maxMs, Math.round(exp * (0.75 + Math.random() * 0.5)));
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text) return null;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json') || /^[\s]*[\[{]/.test(text)) {
    try { return JSON.parse(text); } catch { return text; }
  }
  return text;
}

export class RobloxClient {
  constructor(cookie, label = 'Roblox account', options = {}) {
    if (!cookie) throw new Error(`Missing .ROBLOSECURITY cookie for ${label}`);
    this.cookie = String(cookie).replace(/^\.ROBLOSECURITY=/, '').trim();
    this.label = label;
    this.csrfToken = null;
    this.retries = Math.max(0, Number(options.retries ?? 5));
    this.baseDelayMs = Math.max(100, Number(options.baseDelayMs ?? 1000));
    this.maxDelayMs = Math.max(this.baseDelayMs, Number(options.maxDelayMs ?? 60_000));
    this.defaultTimeoutMs = Math.max(1000, Number(options.timeoutMs ?? 30_000));
  }

  buildHeaders(extra = {}) {
    return {
      cookie: `.ROBLOSECURITY=${this.cookie}`,
      accept: 'application/json',
      'user-agent': 'Monster-AutoReuploader/1.0',
      ...(this.csrfToken ? { 'x-csrf-token': this.csrfToken } : {}),
      ...extra,
    };
  }

  async request(url, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const timeoutMs = Math.max(1000, Number(options.timeoutMs ?? this.defaultTimeoutMs));
    const retryLimit = Math.max(0, Number(options.retries ?? this.retries));
    const operation = options.operation || `${method} ${url}`;
    let csrfRefreshUsed = false;

    for (let attempt = 1; attempt <= retryLimit + 1; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers = this.buildHeaders(options.headers || {});
        const fetchOptions = { ...options, timeoutMs: undefined, retries: undefined, operation: undefined, headers, signal: controller.signal };
        delete fetchOptions.timeoutMs;
        delete fetchOptions.retries;
        delete fetchOptions.operation;

        const response = await fetch(url, fetchOptions);
        clearTimeout(timeout);

        const responseCsrf = response.headers.get('x-csrf-token');
        if (response.status === 403 && responseCsrf && !csrfRefreshUsed) {
          this.csrfToken = responseCsrf;
          csrfRefreshUsed = true;
          log('RETRY', 'Roblox CSRF token refreshed', { operation, attempt });
          continue;
        }

        if (response.ok) return response;

        if (!isRetryableStatus(response.status) || attempt > retryLimit) {
          const body = await response.clone().text().catch(() => '');
          const error = new Error(`${this.label} request failed: HTTP ${response.status} ${response.statusText}${body ? ` ${body.slice(0, 500)}` : ''}`);
          error.status = response.status;
          error.response = response;
          throw error;
        }

        let delayMs = jitteredBackoff(attempt, this.baseDelayMs, this.maxDelayMs);
        const retryAfter = Number(response.headers.get('retry-after'));
        if (Number.isFinite(retryAfter) && retryAfter > 0) {
          delayMs = Math.min(this.maxDelayMs, Math.max(delayMs, retryAfter * 1000));
        }
        log('RETRY', 'Roblox request retry scheduled', { operation, attempt, status: response.status, delayMs });
        await sleep(delayMs);
      } catch (error) {
        clearTimeout(timeout);
        if (error?.status && !isRetryableStatus(error.status)) throw error;
        if (attempt > retryLimit) {
          throw new Error(`${this.label} request failed after ${attempt} attempt(s): ${safeErrorMessage(error)}`);
        }
        const delayMs = jitteredBackoff(attempt, this.baseDelayMs, this.maxDelayMs);
        log('RETRY', 'Roblox transport retry scheduled', { operation, attempt, delayMs, error: safeErrorMessage(error) });
        await sleep(delayMs);
      }
    }

    throw new Error(`${operation} failed`);
  }

  async json(url, options = {}) {
    const response = await this.request(url, options);
    const data = await readResponseBody(response);
    if (data === null || typeof data !== 'object') {
      throw new Error(`${this.label} returned an unexpected JSON response`);
    }
    return data;
  }

  get(url, options = {}) {
    return this.request(url, { method: 'GET', ...options });
  }

  post(url, body, headers = {}, options = {}) {
    const contentType = headers['content-type'] || headers['Content-Type'];
    return this.request(url, {
      method: 'POST',
      ...options,
      headers: { 'content-type': contentType || 'application/json', ...headers },
      body: body === undefined ? undefined : (contentType === 'application/octet-stream' || Buffer.isBuffer(body) ? body : JSON.stringify(body ?? {})),
    });
  }

  patch(url, body, headers = {}, options = {}) {
    return this.request(url, {
      method: 'PATCH',
      ...options,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body ?? {}),
    });
  }

  put(url, body, headers = {}, options = {}) {
    return this.request(url, {
      method: 'PUT',
      ...options,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body ?? {}),
    });
  }
}

export function readBinaryFile(filePath) {
  if (!filePath) throw new Error('Missing file path');
  return fs.readFileSync(filePath);
}

export class RobloxOpenCloudClient {
  constructor(apiKey, label = 'Roblox Open Cloud', options = {}) {
    if (!apiKey) throw new Error(`Missing Open Cloud API key for ${label}`);
    this.apiKey = String(apiKey).trim();
    this.label = label;
    this.retries = Math.max(0, Number(options.retries ?? 5));
    this.baseDelayMs = Math.max(100, Number(options.baseDelayMs ?? 1000));
    this.maxDelayMs = Math.max(this.baseDelayMs, Number(options.maxDelayMs ?? 60_000));
  }

  async request(url, options = {}) {
    const timeoutMs = Math.max(1000, Number(options.timeoutMs ?? 120_000));
    const retryLimit = Math.max(0, Number(options.retries ?? this.retries));
    const operation = options.operation || `${options.method || 'GET'} ${url}`;
    for (let attempt = 1; attempt <= retryLimit + 1; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          ...options,
          headers: { accept: 'application/json', 'x-api-key': this.apiKey, ...(options.headers || {}) },
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (response.ok) return response;
        if (![408, 429, 500, 502, 503, 504, 520, 522, 524].includes(response.status) || attempt > retryLimit) {
          const body = await response.clone().text().catch(() => '');
          const error = new Error(`${this.label} failed: HTTP ${response.status} ${response.statusText}${body ? ` ${body.slice(0, 500)}` : ''}`);
          error.status = response.status;
          throw error;
        }
        let delay = jitteredBackoff(attempt, this.baseDelayMs, this.maxDelayMs);
        const retryAfter = Number(response.headers.get('retry-after'));
        if (Number.isFinite(retryAfter) && retryAfter > 0) delay = Math.min(this.maxDelayMs, Math.max(delay, retryAfter * 1000));
        log('RETRY', 'Roblox Open Cloud retry scheduled', { operation, attempt, status: response.status, delayMs: delay });
        await sleep(delay);
      } catch (error) {
        clearTimeout(timer);
        if (error?.status && ![408, 429, 500, 502, 503, 504, 520, 522, 524].includes(error.status)) throw error;
        if (attempt > retryLimit) throw new Error(`${this.label} failed after ${attempt} attempt(s): ${safeErrorMessage(error)}`);
        const delay = jitteredBackoff(attempt, this.baseDelayMs, this.maxDelayMs);
        log('RETRY', 'Roblox Open Cloud transport retry scheduled', { operation, attempt, delayMs: delay, error: safeErrorMessage(error) });
        await sleep(delay);
      }
    }
    throw new Error(`${this.label} failed`);
  }
}

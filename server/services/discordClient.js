import { log, safeErrorMessage } from '../../src/shared/structuredLogger.js';

const API = 'https://discord.com/api/v10';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export class DiscordClient {
  constructor(token) {
    this.token = String(token || '').trim();
    if (!this.token) throw new Error('Discord bot token is not configured');
  }

  async request(endpoint, options = {}) {
    const retries = Math.max(0, Number(options.retries ?? 4));
    const timeoutMs = Math.max(1000, Number(options.timeoutMs ?? 30_000));
    // Channel renames are limited to ~2 per 10 minutes. Sleeping through that inside a request
    // blocks whoever awaits it (including an upload that holds the operation lock), so a 429 whose
    // wait is longer than this is returned to the caller, which schedules its own background retry.
    const maxRateLimitWaitMs = Math.max(0, Number(options.maxRateLimitWaitMs ?? 5_000));
    const url = endpoint.startsWith('http') ? endpoint : `${API}${endpoint}`;
    const fetchOptions = { ...options };
    delete fetchOptions.retries;
    delete fetchOptions.timeoutMs;
    delete fetchOptions.maxRateLimitWaitMs;

    for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          ...fetchOptions,
          headers: { authorization: `Bot ${this.token}`, ...(options.headers || {}) },
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (response.ok) return response;

        const retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
        if (!retryable || attempt > retries) return response;
        let delay = Math.min(60_000, Math.round((1000 * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5)));
        const retryAfterHeader = Number(response.headers.get('retry-after'));
        const resetAfterHeader = Number(response.headers.get('x-ratelimit-reset-after'));
        const serverWaitMs = Math.max(
          Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader * 1000 : 0,
          Number.isFinite(resetAfterHeader) && resetAfterHeader > 0 ? resetAfterHeader * 1000 : 0,
        );
        if (response.status === 429 && serverWaitMs > maxRateLimitWaitMs) {
          log('WARN', 'Discord rate limit too long to wait inline; returning 429 to caller', { endpoint, waitMs: Math.round(serverWaitMs) });
          return response;
        }
        if (serverWaitMs > 0) delay = Math.min(60_000, Math.max(delay, serverWaitMs));
        log('RETRY', 'Discord request retry scheduled', { endpoint, attempt, status: response.status, delayMs: delay });
        await sleep(delay);
      } catch (error) {
        clearTimeout(timer);
        if (attempt > retries) throw error;
        const delay = Math.min(60_000, Math.round((1000 * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5)));
        log('RETRY', 'Discord transport retry scheduled', { endpoint, attempt, delayMs: delay, error: safeErrorMessage(error) });
        await sleep(delay);
      }
    }
    throw new Error('Discord request failed');
  }

  async json(endpoint, options = {}) {
    const response = await this.request(endpoint, options);
    const text = await response.text();
    if (!response.ok) {
      let message = `Discord API failed: HTTP ${response.status}${text ? ` ${text.slice(0, 500)}` : ''}`;
      if (response.status === 403) {
        let payload = null;
        try { payload = text ? JSON.parse(text) : null; } catch {}
        if (Number(payload?.code) === 50001 || /missing access/i.test(String(payload?.message || text))) {
          message = 'Discord API failed: HTTP 403 Missing Access (code 50001). Make sure the bot is in the server that owns this channel. Grant View Channel and Send Messages; channel rename/player-count voice updates also need Manage Channels. Check the configured channel ID. Original response: ' + String(payload?.message || 'Missing Access');
        }
      }
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    if (!text.trim()) return null;
    try { return JSON.parse(text); } catch { throw new Error('Discord returned malformed JSON'); }
  }

  async getChannel(channelId) { return this.json(`/channels/${encodeURIComponent(channelId)}`); }

  async renameChannel(channelId, name) {
    return this.json(`/channels/${encodeURIComponent(channelId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  }

  async listMessages(channelId, before = '') {
    const query = before ? `?limit=100&before=${encodeURIComponent(before)}` : '?limit=100';
    return this.json(`/channels/${encodeURIComponent(channelId)}/messages${query}`);
  }

  async sendMessagePayload(channelId, payload = {}) {
    return this.json(`/channels/${encodeURIComponent(channelId)}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  async sendMessage(channelId, content) {
    return this.sendMessagePayload(channelId, { content });
  }

  async editMessagePayload(channelId, messageId, payload = {}) {
    return this.json(`/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  async editMessage(channelId, messageId, content) {
    return this.editMessagePayload(channelId, messageId, { content });
  }
}

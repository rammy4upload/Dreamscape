import util from 'util';
import { redactSecrets } from './structuredLogger.js';

let installed = false;
const registeredSecrets = new Set();

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function configuredEnvSecrets() {
  const values = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (!/(cookie|authorization|api[-_]?key|token|password|secret|credential)/i.test(key)) continue;
    const text = String(value || '').trim();
    if (text.length >= 8 && !/^<[^>]*YOUR[^>]*>$/i.test(text) && !/^PASTE_YOUR/i.test(text)) {
      values.push(text);
    }
  }
  return values;
}

export function registerSecret(value) {
  const text = String(value || '').trim();
  if (text.length >= 8) registeredSecrets.add(text);
}

export function registerSecrets(values = []) {
  for (const value of values) registerSecret(value);
}

function redactRegisteredSecrets(text) {
  let result = String(text);
  for (const secret of registeredSecrets) {
    result = result.replace(new RegExp(escapeRegex(secret), 'g'), '[REDACTED]');
  }
  return result;
}

export function redactConsoleValue(value) {
  const rendered = typeof value === 'string' ? value : util.inspect(value, { depth: 6, breakLength: 160 });
  return redactRegisteredSecrets(redactSecrets(rendered));
}

export function installConsoleRedaction() {
  if (installed) return;
  installed = true;
  registerSecrets(configuredEnvSecrets());
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[method].bind(console);
    console[method] = (...args) => original(...args.map(redactConsoleValue));
  }
}

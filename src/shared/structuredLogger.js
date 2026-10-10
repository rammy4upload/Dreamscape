const SECRET_KEYS = /cookie|authorization|api[-_]?key|token|password|secret|credential/i;
const REDACTION = '[REDACTED]';

function sanitizeValue(value, key = '') {
  if (SECRET_KEYS.test(String(key))) {
    return REDACTION;
  }
  if (typeof value === 'string') {
    return value
      .replace(/(\.ROBLOSECURITY\s*[=:]\s*)[^\s,;]+/gi, `$1${REDACTION}`)
      .replace(/(Bearer\s+)[^\s]+/gi, `$1${REDACTION}`)
      .replace(/(x-api-key\s*[=:]\s*)[^\s,;]+/gi, `$1${REDACTION}`)
      .replace(/([?&](?:key|token|api[_-]?key|password)=)[^&\s]+/gi, `$1${REDACTION}`);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, key));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeValue(v, k)]));
  }
  return value;
}

export function redactSecrets(value) {
  return sanitizeValue(value);
}

export function safeErrorMessage(error) {
  return String(error?.message || error || 'Unknown error')
    .replace(/\.ROBLOSECURITY=[^\s]+/gi, '.ROBLOSECURITY=[REDACTED]')
    .replace(/authorization\s*[:=]\s*[^\s]+/gi, 'authorization=[REDACTED]')
    .replace(/x-api-key\s*[:=]\s*[^\s]+/gi, 'x-api-key=[REDACTED]');
}

export function log(level, message, fields = {}) {
  const timestamp = new Date().toISOString();
  const safeFields = redactSecrets(fields);
  const suffix = Object.keys(safeFields).length ? ` ${JSON.stringify(safeFields)}` : '';
  const line = `[${level}] ${timestamp} ${message}${suffix}`;
  if (level === 'ERROR' || level === 'WARN') console.error(line);
  else console.log(line);
  return line;
}

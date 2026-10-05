import fs from 'fs';

export class RobloxClient {
  constructor(cookie, label = 'Roblox account') {
    if (!cookie) {
      throw new Error(`Missing .ROBLOSECURITY cookie for ${label}`);
    }

    this.cookie = cookie;
    this.label = label;
    this.csrfToken = null;
  }

  async request(url, options = {}) {
    const headers = {
      cookie: `.ROBLOSECURITY=${this.cookie}`,
      ...options.headers
    };

    const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
    if (!isFormData && headers.accept === undefined) {
      headers.accept = 'application/json';
    }
    if (isFormData && headers.accept === undefined) {
      headers.accept = '*/*';
    }

    if (this.csrfToken) {
      headers['x-csrf-token'] = this.csrfToken;
    }

    let response = await fetch(url, {
      ...options,
      headers
    });

    const csrfToken = response.headers.get('x-csrf-token');
    if (response.status === 403 && csrfToken) {
      this.csrfToken = csrfToken;
      response = await fetch(url, {
        ...options,
        headers: {
          ...headers,
          'x-csrf-token': csrfToken
        }
      });
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`${this.label} request failed: ${response.status} ${response.statusText} ${body}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return response.json();
    }

    return response.text();
  }

  get(url) {
    return this.request(url, { method: 'GET' });
  }

  post(url, body, headers = {}) {
    return this.request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers
      },
      body: JSON.stringify(body ?? {})
    });
  }

  patch(url, body, headers = {}) {
    return this.request(url, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        ...headers
      },
      body: JSON.stringify(body ?? {})
    });
  }
}

export function readBinaryFile(path) {
  if (!path) {
    throw new Error('Missing file path');
  }

  return fs.readFileSync(path);
}

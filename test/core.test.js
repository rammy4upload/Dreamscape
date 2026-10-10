import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { atomicWriteJson, readJsonWithBackup } from '../src/shared/atomicStore.js';
import { redactSecrets, safeErrorMessage } from '../src/shared/structuredLogger.js';
import { installConsoleRedaction, registerSecret, redactConsoleValue } from '../src/shared/consoleRedaction.js';
import { FileLock } from '../src/shared/fileLock.js';
import {
  OPERATION_STATES,
  createOperation,
  listOperations,
  markInterruptedOperations,
  updateOperation,
} from '../src/shared/operationStore.js';
import { RobloxClient } from '../src/shared/robloxClient.js';
import { verifyExperienceState } from '../src/shared/robloxVerification.js';
import { applyFlatConfigUpdates } from '../server/services/configStore.js';
import { isConfiguredSecret } from '../server/config.js';
import { runTrackedOperation } from '../src/shared/operationRunner.js';
import {
  assertCanEditUniverse,
  configureUniverse,
  getUniverseDetails,
  getUniverseMainPlaceId,
  getUniversePlaces,
  getUniversePermissions,
  withPrimaryAccountApplied,
} from '../cli/reuploader.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'monster-autoreuploader-'));
}

test('atomic JSON writes create a usable backup and recover corrupted primary', () => {
  const dir = tempDir();
  const file = path.join(dir, 'config.json');
  atomicWriteJson(file, { version: 1 }, { backup: false });
  atomicWriteJson(file, { version: 2 }, { backup: true });
  fs.writeFileSync(file, '{broken');
  const recovered = readJsonWithBackup(file);
  assert.deepEqual(recovered, { version: 1 });
});

test('secret redaction never prints sensitive values', () => {
  const safe = redactSecrets({ cookie: 'abc', apiKey: 'key', nested: { token: 'tok' }, message: 'Authorization: Bearer secret' });
  assert.equal(safe.cookie, '[REDACTED]');
  assert.equal(safe.apiKey, '[REDACTED]');
  assert.equal(safe.nested.token, '[REDACTED]');
  assert.match(safe.message, /\[REDACTED\]/);
  assert.doesNotMatch(safeErrorMessage(new Error('.ROBLOSECURITY=secret')), /secret/);
});

test('file lock rejects a duplicate live operation', () => {
  const dir = tempDir();
  const first = new FileLock(path.join(dir, 'operation.lock'), { staleMs: 60_000 });
  const second = new FileLock(path.join(dir, 'operation.lock'), { staleMs: 60_000 });
  first.acquire({ type: 'REUPLOAD' });
  assert.throws(() => second.acquire({ type: 'REUPLOAD' }), (error) => error.code === 'LOCKED');
  first.release();
  second.acquire({ type: 'REUPLOAD' });
  second.release();
});

test('file lock recovers a lock owned by a dead process without waiting for stale timeout', () => {
  const dir = tempDir();
  const lockPath = path.join(dir, 'operation.lock');
  fs.writeFileSync(lockPath, JSON.stringify({
    owner: 'dead-owner',
    pid: 999999,
    createdAt: new Date().toISOString(),
    operationType: 'REUPLOAD',
    target: '10038497874',
  }));

  const lock = new FileLock(lockPath, { staleMs: 2 * 60 * 60_000 });
  lock.acquire({ type: 'NORMALUPLOAD' });
  assert.ok(fs.existsSync(lockPath));
  lock.release();
  assert.equal(fs.existsSync(lockPath), false);
});

test('operation journal recovers interrupted states', () => {
  const dir = tempDir();
  const op = createOperation(dir, 'REUPLOAD', '123');
  updateOperation(dir, op.id, { currentState: OPERATION_STATES.RUNNING });
  const recovered = markInterruptedOperations(dir);
  assert.equal(recovered[0].currentState, OPERATION_STATES.RECOVERY_REQUIRED);
  assert.equal(listOperations(dir, 1)[0].currentState, OPERATION_STATES.RECOVERY_REQUIRED);
});

test('config update rejects unsafe prototype paths and path traversal', () => {
  assert.throws(() => applyFlatConfigUpdates({}, { '__proto__.polluted': 'yes' }), /Unsafe configuration field path/);
  assert.throws(() => applyFlatConfigUpdates({ experience: { rbxlPath: './game.rbxl' } }, { 'experience.rbxlPath': '../secret.rbxl' }), /Unsafe path/);
});



test('group primary credentials are promoted to group mode and group-owner cookie', () => {
  const input = {
    accountPool: {
      primary: {
        name: 'Group Owner',
        userId: 12345,
        cookie: 'different-cookie',
        groupOwnerCookie: 'owner-cookie',
        groupId: 98765,
        apiKey: 'group-api-key',
        isGroup: false,
      }
    },
    experienceId: 10038497874,
  };

  const applied = withPrimaryAccountApplied(input);
  assert.equal(applied.creatorAccount.isGroup, true);
  assert.equal(applied.creatorAccount.groupId, 98765);
  assert.equal(applied.creatorAccount.groupApiKey, 'group-api-key');
  assert.equal(applied.creatorAccount.cookie, 'owner-cookie');
});

test('group-owned universe does not fail solely because the generic permissions endpoint is null', async () => {
  const calls = [];
  const fakeClient = {
    get: async (url) => {
      calls.push(String(url));
      if (String(url).includes('/multiget/permissions')) {
        return { data: [null] };
      }
      if (String(url).includes('/places?')) {
        return { data: [] };
      }
      throw new Error(`Unexpected GET ${url}`);
    }
  };

  const config = {
    accountPool: {
      primary: {
        isGroup: true,
        groupId: 98765,
        groupApiKey: 'group-api-key',
        groupOwnerCookie: 'owner-cookie',
      }
    }
  };

  const result = await assertCanEditUniverse(fakeClient, '10038497874', config);
  assert.equal(result, null);
  assert.equal(calls.length, 2);
});

test('universe lookup helpers decode native RobloxClient Response objects', async () => {
  const fakeClient = {
    get: async (url) => {
      const value = String(url);
      if (value.includes('/multiget/permissions')) {
        return new Response(JSON.stringify({ data: [{ canCloudEdit: true }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (value.includes('/v1/games?')) {
        return new Response(JSON.stringify({ data: [{ id: 10038497874, rootPlaceId: 136644826028724, creator: { type: 'Group', id: 34683071 } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (value.includes('/places?')) {
        return new Response(JSON.stringify({ data: [{ id: 136644826028724, name: 'Main Place' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected GET ${url}`);
    },
  };

  const details = await getUniverseDetails(fakeClient, '10038497874');
  const rootPlaceId = await getUniverseMainPlaceId(fakeClient, '10038497874');
  const places = await getUniversePlaces(fakeClient, '10038497874');
  const permissions = await getUniversePermissions(fakeClient, '10038497874');

  assert.equal(details.rootPlaceId, 136644826028724);
  assert.equal(rootPlaceId, 136644826028724);
  assert.equal(places.data[0].id, 136644826028724);
  assert.equal(permissions.canCloudEdit, true);
});

test('group apiKey is accepted as the group Open Cloud credential when groupApiKey is omitted', async () => {
  const fakeClient = {
    get: async (url) => {
      if (String(url).includes('/multiget/permissions')) return { data: [null] };
      if (String(url).includes('/places?')) return { data: [] };
      throw new Error(`Unexpected GET ${url}`);
    }
  };

  const config = {
    accountPool: {
      primary: {
        isGroup: true,
        groupId: 98765,
        apiKey: 'group-api-key',
        groupOwnerCookie: 'owner-cookie',
      }
    }
  };

  await assertCanEditUniverse(fakeClient, '10038497874', config);
});


test('universe configuration uses Roblox-supported avatar values and a minimal-safe payload', async () => {
  const payloads = [];
  const fakeClient = {
    patch: async (_url, body) => {
      payloads.push(body);
      return new Response('', { status: 200 });
    }
  };
  const experience = { name: 'Monster', description: 'Description', enableMicrophone: true };
  await configureUniverse(fakeClient, '10038497874', experience, {
    accountPool: { primary: { apiKey: 'group-key', isGroup: true } }
  });

  assert.equal(payloads[0].universeAvatarType, 'PlayerChoice');
  assert.equal(Object.hasOwn(payloads[0], 'playerAvatarType'), false);
  assert.equal(Object.hasOwn(payloads[0], 'privateServerPrice'), false);
});

test('universe configuration falls back to name/description after a Roblox 5xx payload failure', async () => {
  const payloads = [];
  let calls = 0;
  const fakeClient = {
    patch: async (_url, body) => {
      calls += 1;
      payloads.push(body);
      if (calls === 1) {
        const error = new Error('HTTP 500 Internal Server Error');
        error.status = 500;
        throw error;
      }
      return new Response('', { status: 200 });
    }
  };
  await configureUniverse(fakeClient, '10038497874', {
    name: 'Monster', description: 'Description', enableMicrophone: false
  }, { accountPool: { primary: { apiKey: 'key' } } });

  assert.equal(calls, 2);
  assert.deepEqual(payloads[1], { name: 'Monster', description: 'Description' });
});

test('Roblox client does not retry authentication failures', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response('unauthorized', { status: 401 });
  };
  try {
    const client = new RobloxClient('cookie', 'test', { retries: 5 });
    await assert.rejects(() => client.get('https://example.test/secure'), /HTTP 401/);
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Roblox client retries a 503 and succeeds', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response('busy', { status: 503, headers: { 'retry-after': '0' } });
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const client = new RobloxClient('cookie', 'test', { retries: 1, baseDelayMs: 1, maxDelayMs: 2 });
    const result = await client.json('https://example.test/secure');
    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('verification rejects deleted Roblox experiences and unexpected names', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ data: [{ id: 123, name: 'Content Deleted' }] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  try {
    const deleted = await verifyExperienceState({ universeId: '123456' });
    assert.equal(deleted.verified, false);
    assert.match(deleted.reason, /deleted/i);

    global.fetch = async () => new Response(JSON.stringify({ data: [{ id: 123, name: 'Actual Name' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
    const mismatch = await verifyExperienceState({ universeId: '123456', expectedName: 'Expected Name' });
    assert.equal(mismatch.verified, false);
    assert.match(mismatch.reason, /mismatch/i);
  } finally {
    global.fetch = originalFetch;
  }
});

test('verification fails closed on malformed or absent game metadata', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/games?')) {
      return new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not-found', { status: 404 });
  };
  try {
    const result = await verifyExperienceState({ universeId: '123456', expectedName: 'Monster' });
    assert.equal(result.verified, false);
  } finally {
    global.fetch = originalFetch;
  }
});


test('placeholder secrets are treated as missing', () => {
  assert.equal(isConfiguredSecret('<YOUR_API_KEY>'), false);
  assert.equal(isConfiguredSecret('PASTE_YOUR_ROBLOSECURITY_COOKIE'), false);
  assert.equal(isConfiguredSecret('real-secret-value-12345'), true);
});

test('uncertain operation remains recovery-required until remote state can be verified', async () => {
  const dir = tempDir();
  await assert.rejects(() => runTrackedOperation({
    dataDir: dir,
    type: 'UPLOAD',
    target: '123',
    fn: async () => { throw new Error('timeout'); },
    verify: async () => ({ verified: false, reason: 'remote state unavailable' }),
  }), /timeout/);
  assert.equal(listOperations(dir, 1)[0].currentState, OPERATION_STATES.RECOVERY_REQUIRED);
});

test('operation can be marked successful after an uncertain transport failure when verification succeeds', async () => {
  const dir = tempDir();
  const result = await runTrackedOperation({
    dataDir: dir,
    type: 'UPLOAD',
    target: '123',
    fn: async () => { throw new Error('timeout'); },
    verify: async () => ({ verified: true, universeId: '123' }),
  });
  assert.equal(result.verificationResult.verified, true);
  assert.equal(listOperations(dir, 1)[0].currentState, OPERATION_STATES.SUCCESS);
});

test('console redaction hides registered secrets in legacy log strings', () => {
  registerSecret('super-secret-cookie-value-123');
  installConsoleRedaction();
  const rendered = redactConsoleValue('cookie=super-secret-cookie-value-123');
  assert.equal(rendered.includes('super-secret-cookie-value-123'), false);
  assert.match(rendered, /REDACTED/);
});

test('file lock heartbeat-stale lock is recovered even when its pid looks alive', () => {
  const dir = tempDir();
  const lockPath = path.join(dir, 'operation.lock');
  fs.writeFileSync(lockPath, JSON.stringify({ owner: 'old', pid: process.ppid || 1, createdAt: new Date().toISOString(), operationType: 'REUPLOAD' }));
  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(lockPath, old, old);
  const lock = new FileLock(lockPath, { heartbeatMs: 0 });
  lock.acquire({ type: 'NORMALUPLOAD' });
  lock.release();
});

test('discord client returns long 429s instead of sleeping through them', async () => {
  const { DiscordClient } = await import('../server/services/discordClient.js');
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response('{}', { status: 429, headers: { 'retry-after': '300' } }); };
  try {
    const started = Date.now();
    const res = await new DiscordClient('t').request('/channels/1', { method: 'PATCH' });
    assert.equal(res.status, 429);
    assert.equal(calls, 1);
    assert.ok(Date.now() - started < 1000);
  } finally { globalThis.fetch = realFetch; }
});

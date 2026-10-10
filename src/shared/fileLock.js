import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { atomicWriteJson } from './atomicStore.js';

export class FileLock {
  constructor(filePath, options = {}) {
    this.filePath = path.resolve(filePath);
    this.staleMs = Number(options.staleMs ?? 2 * 60 * 60_000);
    this.owner = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    this.acquired = false;
    // The holder touches the lock file every heartbeatMs. A lock nobody has touched for
    // heartbeatStaleMs is dead even if its PID looks alive (PIDs get reused after a container
    // restart, e.g. "pid 13" on Railway), so it no longer blocks for the full staleMs.
    this.heartbeatMs = Number(options.heartbeatMs ?? 15_000);
    this.heartbeatStaleMs = Number(options.heartbeatStaleMs ?? 90_000);
    this._timer = null;
  }

  _startHeartbeat() {
    if (!(this.heartbeatMs > 0)) return;
    this._timer = setInterval(() => {
      try {
        const now = new Date();
        fs.utimesSync(this.filePath, now, now);
      } catch {}
    }, this.heartbeatMs);
    this._timer.unref?.();
  }

  _stopHeartbeat() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  _ownerProcessAlive(payload) {
    const pid = Number(payload?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (pid === process.pid) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code === 'EPERM';
    }
  }

  acquire(metadata = {}) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    try {
      const fd = fs.openSync(this.filePath, 'wx', 0o600);
      const payload = { owner: this.owner, pid: process.pid, createdAt: new Date().toISOString(), ...metadata };
      fs.writeFileSync(fd, JSON.stringify(payload, null, 2));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      this.acquired = true;
      this._startHeartbeat();
      return payload;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let existing = null;
      try { existing = JSON.parse(fs.readFileSync(this.filePath, 'utf8')); } catch {}

      let stale = false;
      try {
        const stat = fs.statSync(this.filePath);
        const idleMs = Date.now() - stat.mtimeMs;
        const ageStale = idleMs > this.staleMs;
        const heartbeatStale = this.heartbeatStaleMs > 0 && idleMs > this.heartbeatStaleMs;
        const ownerDead = existing ? !this._ownerProcessAlive(existing) : false;
        stale = ageStale || heartbeatStale || ownerDead;
      } catch {}
      if (stale) {
        try {
          fs.rmSync(this.filePath, { force: true });
          return this.acquire(metadata);
        } catch {}
      }

      const holder = existing
        ? ` by ${existing.operationType || 'operation'} on ${existing.target || 'unknown target'} (pid ${existing.pid}, started ${existing.createdAt})`
        : '';
      const err = new Error(`Operation lock is already held${holder}. Wait for it to finish; it clears itself if that process dies.`);
      err.code = 'LOCKED';
      err.existing = existing;
      throw err;
    }
  }

  release() {
    this._stopHeartbeat();
    if (!this.acquired) return;
    try {
      const existing = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (existing?.owner === this.owner) fs.rmSync(this.filePath, { force: true });
    } catch {
      fs.rmSync(this.filePath, { force: true });
    }
    this.acquired = false;
  }
}

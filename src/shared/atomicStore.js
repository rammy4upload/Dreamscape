import fs from 'fs';
import path from 'path';

export function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

export function atomicWriteFile(filePath, content, options = {}) {
  const resolved = path.resolve(filePath);
  ensureParentDir(resolved);
  const dir = path.dirname(resolved);
  const base = path.basename(resolved);
  const temp = path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);
  const mode = options.mode ?? 0o600;
  const encoding = options.encoding ?? 'utf8';

  try {
    if (options.backup && fs.existsSync(resolved)) {
      fs.copyFileSync(resolved, `${resolved}.bak`);
    }
    const fd = fs.openSync(temp, 'w', mode);
    try {
      if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
        fs.writeFileSync(fd, content);
      } else {
        fs.writeFileSync(fd, content, { encoding });
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, resolved);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch {}
    throw error;
  }
  return resolved;
}

export function atomicWriteJson(filePath, value, options = {}) {
  const content = `${JSON.stringify(value, null, options.indent ?? 2)}\n`;
  return atomicWriteFile(filePath, content, options);
}

export function readJsonFile(filePath, { fallback = null } = {}) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  } catch (error) {
    if (fallback !== null && (error.code === 'ENOENT' || error instanceof SyntaxError)) return fallback;
    throw error;
  }
}

export function readJsonWithBackup(filePath, { fallback = null, restore = true } = {}) {
  const target = path.resolve(filePath);
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    const backup = `${target}.bak`;
    try {
      const recovered = JSON.parse(fs.readFileSync(backup, 'utf8'));
      if (restore) atomicWriteJson(target, recovered, { backup: false });
      return recovered;
    } catch {
      if (fallback !== null) return fallback;
      throw error;
    }
  }
}

export function restoreJsonBackup(filePath) {
  const target = path.resolve(filePath);
  const backup = `${target}.bak`;
  if (!fs.existsSync(backup)) {
    throw new Error(`No backup exists for ${target}`);
  }
  const parsed = JSON.parse(fs.readFileSync(backup, 'utf8'));
  atomicWriteJson(target, parsed, { backup: false });
  return target;
}

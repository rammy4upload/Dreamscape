import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { atomicWriteJson, ensureParentDir } from './atomicStore.js';
import { safeErrorMessage, log } from './structuredLogger.js';

export const OPERATION_STATES = Object.freeze({
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  VERIFYING: 'VERIFYING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  RECOVERY_REQUIRED: 'RECOVERY_REQUIRED',
});

export function operationFile(dataDir) {
  return path.join(path.resolve(dataDir), 'operations.json');
}

function readOperations(dataDir) {
  const file = operationFile(dataDir);
  ensureParentDir(file);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    log('ERROR', 'Operation journal is corrupted', { error: safeErrorMessage(error) });
    const backup = `${file}.bak`;
    if (fs.existsSync(backup)) {
      try { return JSON.parse(fs.readFileSync(backup, 'utf8')); } catch {}
    }
    return [];
  }
}

function writeOperations(dataDir, operations) {
  return atomicWriteJson(operationFile(dataDir), operations.slice(-1000), { backup: true });
}

export function createOperation(dataDir, type, target, metadata = {}) {
  const now = new Date().toISOString();
  const operation = {
    id: `${type}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    type,
    target,
    startTime: now,
    currentState: OPERATION_STATES.PENDING,
    attemptCount: 0,
    lastError: null,
    verificationResult: null,
    completionTime: null,
    metadata,
  };
  const operations = readOperations(dataDir);
  operations.push(operation);
  writeOperations(dataDir, operations);
  return operation;
}

export function updateOperation(dataDir, operationId, patch) {
  const operations = readOperations(dataDir);
  const index = operations.findIndex((item) => item.id === operationId);
  if (index === -1) throw new Error(`Unknown operation ${operationId}`);
  operations[index] = { ...operations[index], ...patch };
  if (patch.currentState === OPERATION_STATES.SUCCESS || patch.currentState === OPERATION_STATES.FAILED) {
    operations[index].completionTime ||= new Date().toISOString();
  }
  writeOperations(dataDir, operations);
  return operations[index];
}

export function listOperations(dataDir, limit = 100) {
  return readOperations(dataDir).slice(-limit).reverse();
}

export function getOperation(dataDir, id) {
  return readOperations(dataDir).find((item) => item.id === id) || null;
}

export function markInterruptedOperations(dataDir) {
  const operations = readOperations(dataDir);
  let changed = false;
  for (const operation of operations) {
    if ([OPERATION_STATES.PENDING, OPERATION_STATES.RUNNING, OPERATION_STATES.VERIFYING].includes(operation.currentState)) {
      operation.currentState = OPERATION_STATES.RECOVERY_REQUIRED;
      operation.lastError = 'Process restarted while operation was incomplete';
      changed = true;
    }
  }
  if (changed) writeOperations(dataDir, operations);
  return operations.filter((item) => item.currentState === OPERATION_STATES.RECOVERY_REQUIRED);
}

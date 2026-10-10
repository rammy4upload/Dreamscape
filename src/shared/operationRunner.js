import path from 'path';
import { FileLock } from './fileLock.js';
import {
  OPERATION_STATES,
  createOperation,
  getOperation,
  updateOperation,
} from './operationStore.js';
import { log, safeErrorMessage } from './structuredLogger.js';

let activeOperation = null;
let signalHandlersInstalled = false;

function isDefinitiveOperationFailure(error) {
  const status = Number(
    error?.status ?? error?.statusCode ?? error?.response?.status ?? error?.cause?.status ?? 0
  );
  if (status >= 400 && status < 500) return true;
  const message = String(error?.message || error || '').toLowerCase();
  return /insufficient scopes?|permission_denied|missing access|not authorized|unauthorized|forbidden/.test(message)
    || /http\s+4\d{2}/.test(message);
}

function installSignalHandlers() {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  const shutdown = (signal) => {
    if (activeOperation) {
      try {
        updateOperation(activeOperation.dataDir, activeOperation.id, {
          currentState: OPERATION_STATES.RECOVERY_REQUIRED,
          lastError: `Process received ${signal} while operation was active`,
        });
      } catch {}
      try {
        activeOperation.lock?.release();
      } catch {}
    }
    process.exit(signal === 'SIGTERM' ? 143 : 130);
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

export async function runTrackedOperation({ dataDir, type, target, metadata = {}, verify, fn }) {
  installSignalHandlers();
  const lock = new FileLock(path.join(path.resolve(dataDir), 'operation.lock'), { staleMs: 2 * 60 * 60_000 });
  lock.acquire({ operationType: type, target });
  const operation = createOperation(dataDir, type, target, metadata);
  activeOperation = { dataDir, id: operation.id, lock };

  try {
    updateOperation(dataDir, operation.id, {
      currentState: OPERATION_STATES.RUNNING,
      attemptCount: Number(operation.attemptCount || 0) + 1,
    });
    log('INFO', 'Operation started', { operation: operation.id, type, target });

    let result;
    try {
      result = await fn(operation);
    } catch (error) {
      // A universe that still exists is not proof that an upload or configuration change succeeded.
      // Run the state verifier only to attach diagnostic context; never override the original error.
      let verificationResult = null;
      if (verify) {
        try {
          updateOperation(dataDir, operation.id, {
            currentState: OPERATION_STATES.VERIFYING,
            lastError: safeErrorMessage(error),
          });
          verificationResult = await verify(undefined, operation);
        } catch (verificationError) {
          verificationResult = { verified: false, diagnosticError: safeErrorMessage(verificationError) };
        }
      }

      const definitive = isDefinitiveOperationFailure(error);
      updateOperation(dataDir, operation.id, {
        currentState: definitive ? OPERATION_STATES.FAILED : OPERATION_STATES.RECOVERY_REQUIRED,
        lastError: safeErrorMessage(error),
        ...(verificationResult ? { verificationResult: { stateCheckOnly: true, ...verificationResult } } : {}),
      });
      log(definitive ? 'ERROR' : 'WARN', 'Operation failed; verifier cannot override the original error', {
        operation: operation.id,
        type,
        target,
        definitive,
        existingExperienceVerified: Boolean(verificationResult?.verified),
        error: safeErrorMessage(error),
      });
      throw error;
    }

    updateOperation(dataDir, operation.id, { currentState: OPERATION_STATES.VERIFYING });
    const verificationResult = verify ? await verify(result, operation) : { verified: true };
    if (!verificationResult?.verified) {
      const error = new Error(verificationResult?.reason || 'Post-operation verification failed');
      updateOperation(dataDir, operation.id, {
        currentState: OPERATION_STATES.FAILED,
        lastError: safeErrorMessage(error),
        verificationResult,
      });
      log('ERROR', 'Operation verification failed', { operation: operation.id, reason: verificationResult?.reason });
      throw error;
    }

    updateOperation(dataDir, operation.id, {
      currentState: OPERATION_STATES.SUCCESS,
      verificationResult,
      completionTime: new Date().toISOString(),
    });
    log('SUCCESS', 'Operation completed and verified', { operation: operation.id, type, target });
    return { result, operationId: operation.id, verificationResult };
  } catch (error) {
    try {
      const current = getOperation(dataDir, operation.id);
      if (current && ![OPERATION_STATES.FAILED, OPERATION_STATES.SUCCESS, OPERATION_STATES.RECOVERY_REQUIRED].includes(current.currentState)) {
        updateOperation(dataDir, operation.id, {
          currentState: OPERATION_STATES.RECOVERY_REQUIRED,
          lastError: safeErrorMessage(error),
        });
      }
    } catch {}
    throw error;
  } finally {
    activeOperation = null;
    lock.release();
  }
}

/** Returns the live lock holder's metadata, or null when no operation is running. */
export function getOperationLockHolder(dataDir) {
  const probe = new FileLock(path.join(path.resolve(dataDir), 'operation.lock'), { staleMs: 2 * 60 * 60_000 });
  try {
    probe.acquire({ operationType: 'PROBE' });
    probe.release();
    return null;
  } catch (error) {
    if (error?.code === 'LOCKED') return error.existing || { operationType: 'unknown' };
    throw error;
  }
}

import { loadServiceConfig } from '../config.js';
import { markInterruptedOperations, listOperations, OPERATION_STATES, updateOperation } from '../../src/shared/operationStore.js';
import { verifyExperienceState } from '../../src/shared/robloxVerification.js';
import { serverConfig } from '../config.js';
import { log } from '../../src/shared/structuredLogger.js';

export async function recoverInterruptedOperations() {
  const interrupted = markInterruptedOperations(serverConfig.dataDir);
  const config = loadServiceConfig() || {};
  const universeId = config?.accountPool?.primary?.experienceId || config?.experienceId;
  const mainPlaceId = config?.monitor?.healthUrl?.match(/\/games\/(\d+)/i)?.[1] || null;
  if (!interrupted.length || !universeId) return interrupted;

  const verification = await verifyExperienceState({ universeId, mainPlaceId, expectedName: config?.experience?.name || '' });
  for (const operation of interrupted) {
    if (verification.verified) {
      updateOperation(serverConfig.dataDir, operation.id, {
        currentState: OPERATION_STATES.SUCCESS,
        verificationResult: { recovered: true, ...verification },
        completionTime: new Date().toISOString(),
        lastError: null,
      });
    } else {
      updateOperation(serverConfig.dataDir, operation.id, {
        currentState: OPERATION_STATES.RECOVERY_REQUIRED,
        verificationResult: { recovered: false, ...verification },
      });
    }
  }
  log('INFO', 'Interrupted operation recovery scan complete', { interrupted: interrupted.length, verified: verification.verified });
  return listOperations(serverConfig.dataDir, 100);
}

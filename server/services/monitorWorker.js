import { loadServiceConfig } from '../config.js';
import { checkPrimaryHealth, checkRobloxBaseHealth, refreshHealthSnapshot } from './healthManager.js';
import { setSystemStatus, SYSTEM_STATUS } from './discordStatusManager.js';
import { startTask, hasRunningCommand } from '../routes/autoreuploader.js';
import { log, safeErrorMessage } from '../../src/shared/structuredLogger.js';

let timer = null;
let checking = false;

export async function monitorOnce() {
  if (checking) return;
  checking = true;
  try {
    const config = loadServiceConfig() || {};
    const result = await checkPrimaryHealth(config);
    await refreshHealthSnapshot({ primary: result });
    if (result.state === 'HEALTHY') {
      const gameLink = config?.monitor?.healthUrl || '';
      await setSystemStatus(SYSTEM_STATUS.UP, { gameLink }, config);
      return result;
    }
    if (result.state === 'DOWN') {
      const base = await checkRobloxBaseHealth();
      if (!base.available) {
        await setSystemStatus(SYSTEM_STATUS.DOWN, { gameLink: config?.monitor?.healthUrl || '', reason: 'Roblox platform is temporarily unavailable' }, config);
        return result;
      }
      await setSystemStatus(SYSTEM_STATUS.REUPLOADING, { gameLink: config?.monitor?.healthUrl || '', operation: 'health recovery' }, config);
      if (!hasRunningCommand('reupload')) {
        try {
          startTask('reupload', []);
        } catch (error) {
          log('WARN', 'Automatic reupload could not be started', { error: safeErrorMessage(error) });
          await setSystemStatus(SYSTEM_STATUS.DOWN, { gameLink: config?.monitor?.healthUrl || '', reason: safeErrorMessage(error) }, config);
        }
      }
    }
    return result;
  } finally {
    checking = false;
  }
}

export function startMonitorWorker() {
  if (timer) return;
  const config = loadServiceConfig() || {};
  const enabled = String(process.env.AUTO_MONITOR ?? config?.monitor?.enabled ?? '1') !== '0' && config?.monitor?.autoMonitor !== false;
  if (!enabled) {
    log('INFO', 'Automatic server monitor disabled');
    return;
  }
  const intervalMs = Math.max(30_000, Number(config.monitor?.intervalMs || 300_000));
  monitorOnce().catch((error) => log('WARN', 'Initial monitor check failed', { error: safeErrorMessage(error) }));
  timer = setInterval(() => monitorOnce().catch((error) => log('WARN', 'Monitor check failed', { error: safeErrorMessage(error) })), intervalMs);
  timer.unref?.();
  log('INFO', 'Automatic monitor worker started', { intervalMs });
}

export function stopMonitorWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

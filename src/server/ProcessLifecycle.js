import { createParentProcessWatchdog } from '../security/ParentProcessWatchdog.js';

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function createProcessLifecycle({
  application,
  input = process.stdin,
  processRef = process,
  parentPid = process.ppid,
  parentWatchdogFactory = createParentProcessWatchdog,
  shutdownTimeoutMs = 10_000,
  requestExit = (code) => process.exit(code),
  logger = console,
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (handle) => clearTimeout(handle),
} = {}) {
  if (!application || typeof application.close !== 'function') throw new Error('Application fermable requise.');
  if (!input || typeof input.once !== 'function') throw new Error('Flux STDIO surveillable requis.');
  if (!processRef || typeof processRef.once !== 'function') throw new Error('Processus surveillable requis.');
  if (!Number.isInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1) throw new Error('Délai d’arrêt invalide.');

  let started = false;
  let stopPromise;
  let watchdog;

  const handlers = {
    stdinEnd: () => void stop({ exitCode: 0, reason: 'stdin-end' }),
    stdinClose: () => void stop({ exitCode: 0, reason: 'stdin-close' }),
    stdinError: (error) => void stop({ exitCode: 1, reason: 'stdin-error', error }),
    sigint: () => void stop({ exitCode: 0, reason: 'SIGINT' }),
    sigterm: () => void stop({ exitCode: 0, reason: 'SIGTERM' }),
    uncaughtException: (error) => void stop({ exitCode: 1, reason: 'uncaughtException', error }),
    unhandledRejection: (reason) => void stop({ exitCode: 1, reason: 'unhandledRejection', error: reason }),
  };

  const attach = () => {
    input.once('end', handlers.stdinEnd);
    input.once('close', handlers.stdinClose);
    input.once('error', handlers.stdinError);
    processRef.once('SIGINT', handlers.sigint);
    processRef.once('SIGTERM', handlers.sigterm);
    processRef.once('uncaughtException', handlers.uncaughtException);
    processRef.once('unhandledRejection', handlers.unhandledRejection);
  };

  const detach = () => {
    input.off?.('end', handlers.stdinEnd);
    input.off?.('close', handlers.stdinClose);
    input.off?.('error', handlers.stdinError);
    processRef.off?.('SIGINT', handlers.sigint);
    processRef.off?.('SIGTERM', handlers.sigterm);
    processRef.off?.('uncaughtException', handlers.uncaughtException);
    processRef.off?.('unhandledRejection', handlers.unhandledRejection);
  };

  function stop({ exitCode = 0, reason = 'shutdown', error } = {}) {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      detach();
      watchdog?.close?.();
      if (error !== undefined) logger.error?.(`[nexus-indesign] Arrêt ${reason}: ${errorMessage(error)}`);

      let timedOut = false;
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimer(() => {
          timedOut = true;
          resolve();
        }, shutdownTimeoutMs);
        timer?.unref?.();
      });
      try {
        await Promise.race([
          Promise.resolve().then(() => application.close()).catch((closeError) => {
            exitCode = 1;
            logger.error?.(`[nexus-indesign] Fermeture incomplète: ${errorMessage(closeError)}`);
          }),
          timeout,
        ]);
        if (timedOut) {
          exitCode = 1;
          logger.error?.('[nexus-indesign] Fermeture interrompue après le délai de sécurité.');
        }
      } finally {
        if (timer !== undefined) clearTimer(timer);
        requestExit(exitCode);
      }
    })();
    return stopPromise;
  }

  async function start() {
    if (started) return;
    started = true;
    attach();
    try {
      const createdWatchdog = await parentWatchdogFactory({
        parentPid,
        onLost: ({ reason, cause }) => stop({
          exitCode: reason === 'probe-failed' ? 1 : 0,
          reason: `parent-${reason}`,
          error: cause,
        }),
      });
      if (stopPromise) createdWatchdog?.close?.();
      else watchdog = createdWatchdog;
    } catch (error) {
      detach();
      started = false;
      throw error;
    }
  }

  return {
    start,
    stop,
    get stopping() { return Boolean(stopPromise); },
  };
}

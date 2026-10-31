import { spawn as spawnChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { minimalWindowsEnvironment } from '../security/windowsEnvironment.js';

export const INDESIGN_AUTOMATION_MUTEX = 'Local\\NexusInDesignAutomation';
const INDESIGN_TEST_MUTEX_PATTERN = /^Local\\NexusInDesignAutomation\.Test\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

const HELPER_PATH = fileURLToPath(new URL('../../scripts/Hold-InDesignOperationMutex.ps1', import.meta.url));
const MAX_HANDSHAKE_BYTES = 8 * 1024;

function mutexError(message, code, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

async function assertNormalAbsoluteFile(filePath, code) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw mutexError('Le fichier privé associé au mutex InDesign doit être absolu.', code);
  }
  const stat = await fs.lstat(filePath).catch((error) => {
    throw mutexError('Le fichier privé associé au mutex InDesign est introuvable.', code, error);
  });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw mutexError('Le fichier privé associé au mutex InDesign doit être un fichier normal.', code);
  }
}

function powershellExecutable(source = process.env) {
  const key = Object.keys(source).find((candidate) => ['systemroot', 'windir'].includes(candidate.toLowerCase()));
  const windowsDirectory = (key ? source[key] : undefined) ?? 'C:\\Windows';
  return path.join(windowsDirectory, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Acquiert le mutex inter-processus commun dans un processus PowerShell dédié.
 * Le processus conserve le mutex jusqu’à recevoir un marqueur d’acquittement
 * portant le nonce privé du journal. La simple suppression du journal ne suffit
 * jamais à libérer une issue connue ou réconciliée.
 */
export async function acquireWindowsNamedMutexGuard({
  operationPath,
  timeoutMs = 120_000,
  expectedGuardProcessId,
  recovery = false,
  releaseNonce,
  mutexName = INDESIGN_AUTOMATION_MUTEX,
  allowTestMutex = false,
  spawnProcess = spawnChildProcess,
  environment = process.env,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 900_000) {
    throw mutexError('Le délai du mutex InDesign est invalide.', 'INDESIGN_MUTEX_TIMEOUT_INVALID');
  }
  await assertNormalAbsoluteFile(HELPER_PATH, 'INDESIGN_MUTEX_HELPER_INVALID');
  await assertNormalAbsoluteFile(operationPath, 'MUTEX_OPERATION_PATH_INVALID');
  if (expectedGuardProcessId !== undefined && (!Number.isInteger(expectedGuardProcessId) || expectedGuardProcessId <= 0)) {
    throw mutexError('Le PID du helper InDesign à reprendre est invalide.', 'INDESIGN_MUTEX_GUARD_IDENTITY_INVALID');
  }
  if (typeof releaseNonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(releaseNonce)) {
    throw mutexError('Le nonce privé d’acquittement du mutex est invalide.', 'OPERATION_RELEASE_NONCE_INVALID');
  }

  // Le nonce reste exclusivement dans le journal privé. Il ne doit jamais
  // apparaître dans la ligne de commande du helper (visible via WMI).
  let operationRecord;
  try {
    operationRecord = JSON.parse((await fs.readFile(operationPath, 'utf8')).trim().split(/\r?\n/).at(-1));
  } catch (cause) {
    throw mutexError('La preuve privée du mutex InDesign est illisible.', 'MUTEX_OPERATION_PATH_INVALID', cause);
  }
  if (operationRecord?.releaseNonce !== releaseNonce) {
    throw mutexError('Le nonce privé ne correspond pas au journal du mutex.', 'OPERATION_RELEASE_NONCE_INVALID');
  }
  if (
    mutexName !== INDESIGN_AUTOMATION_MUTEX
    && (allowTestMutex !== true || !INDESIGN_TEST_MUTEX_PATTERN.test(mutexName ?? ''))
  ) {
    throw mutexError('Le nom du mutex InDesign est invalide.', 'INDESIGN_MUTEX_NAME_INVALID');
  }

  const helperArguments = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', HELPER_PATH,
    '-OperationPath', operationPath,
    '-AcquireTimeoutMs', String(timeoutMs),
    '-MutexName', mutexName,
  ];
  if (expectedGuardProcessId !== undefined) {
    helperArguments.push('-ExpectedGuardProcessId', String(expectedGuardProcessId));
  }
  if (recovery) helperArguments.push('-Recovery');

  const child = spawnProcess(
    powershellExecutable(environment),
    helperArguments,
    {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: minimalWindowsEnvironment({}, environment),
    },
  );

  child.stderr?.resume();
  const exit = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', (error) => resolve({ code: null, signal: null, error }));
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let timer;
    const failAfterExit = (error, { kill = true } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      if (kill) {
        try { child.kill(); } catch {}
      }
      void exit.then(() => reject(error));
    };

    timer = setTimeout(() => {
      failAfterExit(mutexError('Le helper du mutex InDesign n’a pas confirmé son acquisition.', 'INDESIGN_MUTEX_HELPER_TIMEOUT'));
    }, timeoutMs + 5_000);
    timer.unref?.();

    const onData = (chunk) => {
      if (settled) return;
      stdout += chunk.toString('utf8');
      if (Buffer.byteLength(stdout, 'utf8') > MAX_HANDSHAKE_BYTES) {
        failAfterExit(mutexError('Le handshake du mutex InDesign est trop volumineux.', 'INDESIGN_MUTEX_HELPER_PROTOCOL_ERROR'));
        return;
      }
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      const line = stdout.slice(0, newline).trim();
      let handshake;
      try {
        handshake = JSON.parse(line);
      } catch (error) {
        failAfterExit(mutexError('Le handshake du mutex InDesign est invalide.', 'INDESIGN_MUTEX_HELPER_PROTOCOL_ERROR', error));
        return;
      }
      const expectedStatuses = expectedGuardProcessId === undefined
        ? ['acquired', 'abandoned']
        : ['watching', 'acquired', 'abandoned'];
      if (
        handshake?.ok !== true
        || !expectedStatuses.includes(handshake.status)
        || handshake.mutex !== mutexName
        || handshake.processId !== child.pid
        || (handshake.status === 'watching' && handshake.guardedProcessId !== expectedGuardProcessId)
      ) {
        const code = typeof handshake?.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(handshake.code)
          ? handshake.code
          : 'INDESIGN_MUTEX_HELPER_PROTOCOL_ERROR';
        failAfterExit(mutexError('Le mutex commun InDesign n’a pas été acquis.', code));
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stdout.resume();
      // Le helper écrit son identité dans le journal avant le handshake. Une
      // mort du parent à cet instant laisse donc une preuve récupérable.
      void fs.readFile(operationPath, 'utf8').then((raw) => {
        const persisted = JSON.parse(raw.trim().split(/\r?\n/).at(-1));
        const persistedPid = handshake.status === 'watching'
          ? persisted.recoveryWatcherProcessId
          : persisted.guardProcessId;
        if (persistedPid !== child.pid || persisted.releaseNonce !== releaseNonce) {
          throw mutexError('L’identité durable du helper InDesign ne correspond pas au handshake.', 'INDESIGN_MUTEX_HELPER_PROTOCOL_ERROR');
        }
        resolve({
          processId: child.pid,
          ...(handshake.status === 'watching' ? { guardedProcessId: handshake.guardedProcessId } : {}),
          mutex: mutexName,
          status: handshake.status,
          exit,
        });
      }).catch((error) => {
        try { child.kill(); } catch {}
        void exit.then(() => reject(error));
      });
    };

    child.stdout.on('data', onData);
    child.once('error', (error) => {
      failAfterExit(mutexError('Le helper du mutex InDesign n’a pas pu démarrer.', 'INDESIGN_MUTEX_HELPER_FAILED', error), { kill: false });
    });
    child.once('exit', (code) => {
      if (!settled) failAfterExit(mutexError(`Le helper du mutex InDesign s’est arrêté avant son handshake (${code ?? 'inconnu'}).`, 'INDESIGN_MUTEX_HELPER_FAILED'), { kill: false });
    });
  });
}

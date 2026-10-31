import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { minimalWindowsEnvironment } from './windowsEnvironment.js';

const execFileAsync = promisify(execFile);

const PROCESS_IDENTITY_PROBE = String.raw`
$ErrorActionPreference = 'Stop'
$pidToRead = [int]$env:INDESIGN_MCP_WATCHED_PARENT_PID
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$pidToRead"
if ($null -eq $process) {
  [pscustomobject]@{ exists = $false } | ConvertTo-Json -Compress
  exit 0
}
$created = $process.CreationDate
if ($created -is [datetime]) {
  $startedAt = $created.ToUniversalTime().ToString('o')
} else {
  try {
    $startedAt = [System.Management.ManagementDateTimeConverter]::ToDateTime([string]$created).ToUniversalTime().ToString('o')
  } catch {
    $startedAt = $null
  }
}
[pscustomobject]@{
  exists = $true
  processId = [int]$process.ProcessId
  startedAt = $startedAt
} | ConvertTo-Json -Compress
`;

function normalizeProcessIdentity(value, expectedPid) {
  if (
    value?.exists !== true
    || !Number.isInteger(value.processId)
    || value.processId !== expectedPid
    || typeof value.startedAt !== 'string'
    || Number.isNaN(Date.parse(value.startedAt))
  ) return undefined;
  return { processId: value.processId, startedAt: new Date(value.startedAt).toISOString() };
}

function sameProcess(left, right) {
  return Boolean(left && right)
    && left.processId === right.processId
    && left.startedAt === right.startedAt;
}

export async function readWindowsProcessIdentity(
  processId,
  {
    platform = process.platform,
    env = process.env,
    run = execFileAsync,
  } = {},
) {
  if (!Number.isInteger(processId) || processId <= 0) return undefined;
  if (platform !== 'win32') {
    try {
      process.kill(processId, 0);
      return { processId, startedAt: `pid:${processId}` };
    } catch (error) {
      if (error?.code === 'ESRCH') return undefined;
      throw error;
    }
  }
  const windowsDirectory = env.SystemRoot ?? env.WINDIR ?? 'C:\\Windows';
  const powershell = path.join(windowsDirectory, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await run(
    powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PROCESS_IDENTITY_PROBE],
    {
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
      env: minimalWindowsEnvironment({ INDESIGN_MCP_WATCHED_PARENT_PID: String(processId) }, env),
    },
  );
  const parsed = JSON.parse(String(stdout).trim() || '{"exists":false}');
  return normalizeProcessIdentity(parsed, processId);
}

// Présence native et instantanée du parent : EPERM signifie qu'il existe sous un autre compte.
export function isProcessAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

// Chaque tick vérifie nativement la présence du parent ; l'identité complète (PID + date de création, contre la
// réutilisation de PID) passe par une sonde PowerShell lente, limitée à identityIntervalMs. Une sonde lente ou en
// échec ne coupe jamais le serveur tant que le parent est présent : sous charge InDesign, PowerShell/CIM dépasse
// souvent quelques secondes et tuait le serveur en pleine mutation.
export async function createParentProcessWatchdog({
  parentPid = process.ppid,
  intervalMs = 5_000,
  identityIntervalMs = 60_000,
  initialProbeAttempts = 3,
  readIdentity = readWindowsProcessIdentity,
  isAlive = isProcessAlive,
  onLost,
  now = () => Date.now(),
  schedule = (callback, delay) => setInterval(callback, delay),
  cancel = (handle) => clearInterval(handle),
} = {}) {
  if (!Number.isInteger(parentPid) || parentPid <= 0) throw new Error('PID parent invalide pour la surveillance MCP.');
  if (!Number.isInteger(intervalMs) || intervalMs < 10) throw new Error('Intervalle de surveillance parent invalide.');
  if (!Number.isInteger(identityIntervalMs) || identityIntervalMs < intervalMs) throw new Error('Intervalle d’identité parent invalide.');
  if (!Number.isInteger(initialProbeAttempts) || initialProbeAttempts < 1) throw new Error('Tolérance de sonde parent invalide.');
  if (typeof readIdentity !== 'function' || typeof isAlive !== 'function' || typeof onLost !== 'function') throw new Error('Surveillance parent incomplète.');

  let expectedIdentity;
  let initialError;
  for (let attempt = 0; attempt < initialProbeAttempts && !expectedIdentity; attempt += 1) {
    try {
      expectedIdentity = await readIdentity(parentPid);
      if (!expectedIdentity) break;
    } catch (error) {
      initialError = error;
    }
  }
  let closed = false;
  let checking = false;
  let failures = 0;
  let lost = false;
  let lastIdentityCheck = now();
  let timer;
  const reportLost = (reason, cause) => {
    if (closed || lost) return;
    lost = true;
    if (timer !== undefined) cancel(timer);
    void Promise.resolve(onLost({
      reason,
      parentPid,
      expectedIdentity,
      cause,
    })).catch(() => {});
  };
  const check = async () => {
    if (closed || lost || checking) return { status: closed ? 'closed' : lost ? 'lost' : 'busy' };
    checking = true;
    try {
      if (!isAlive(parentPid)) {
        reportLost('parent-exited');
        return { status: 'lost' };
      }
      if (expectedIdentity && now() - lastIdentityCheck < identityIntervalMs) return { status: 'alive' };
      lastIdentityCheck = now();
      let currentIdentity;
      try {
        currentIdentity = await readIdentity(parentPid);
      } catch (error) {
        failures += 1;
        return { status: 'probe-failed', failures, error };
      }
      failures = 0;
      if (!currentIdentity) {
        if (!isAlive(parentPid)) {
          reportLost('parent-exited');
          return { status: 'lost' };
        }
        return { status: 'alive' };
      }
      if (!expectedIdentity) {
        expectedIdentity = currentIdentity;
        return { status: 'alive', currentIdentity };
      }
      if (!sameProcess(expectedIdentity, currentIdentity)) {
        reportLost('identity-changed');
        return { status: 'lost', currentIdentity };
      }
      return { status: 'alive', currentIdentity };
    } finally {
      checking = false;
    }
  };

  if (!expectedIdentity && !isAlive(parentPid)) {
    reportLost('parent-exited', initialError);
  } else {
    timer = schedule(() => void check(), intervalMs);
    timer?.unref?.();
  }

  return {
    parentPid,
    get expectedIdentity() { return expectedIdentity; },
    check,
    close() {
      if (closed) return;
      closed = true;
      if (timer !== undefined) cancel(timer);
    },
  };
}

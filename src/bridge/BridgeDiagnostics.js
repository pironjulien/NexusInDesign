import { execFile } from 'node:child_process';

const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

function validPid(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function endpointPort(endpoint) {
  const separator = endpoint.lastIndexOf(':');
  if (separator === -1) return undefined;
  const value = Number.parseInt(endpoint.slice(separator + 1), 10);
  return Number.isSafeInteger(value) ? value : undefined;
}

export function parseWindowsNetstatListenerOwner(output, { host, port }) {
  if (typeof output !== 'string' || typeof host !== 'string' || !Number.isSafeInteger(port)) return undefined;
  const expectedEndpoints = new Set([`${host}:${port}`, `[${host}]:${port}`]);
  for (const line of output.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5 || columns[0].toUpperCase() !== 'TCP' || columns[3].toUpperCase() !== 'LISTENING') continue;
    const [localEndpoint, remoteEndpoint] = columns.slice(1, 3);
    if (!expectedEndpoints.has(localEndpoint) || endpointPort(remoteEndpoint) !== 0) continue;
    const pid = Number.parseInt(columns.at(-1), 10);
    if (validPid(pid)) return pid;
  }
  return undefined;
}

export function parseWindowsNetstatConnectionOwner(output, { host, serverPort, clientPort }) {
  if (
    typeof output !== 'string'
    || typeof host !== 'string'
    || !Number.isSafeInteger(serverPort)
    || !Number.isSafeInteger(clientPort)
  ) return undefined;
  const clientEndpoints = new Set([`${host}:${clientPort}`, `[${host}]:${clientPort}`]);
  const serverEndpoints = new Set([`${host}:${serverPort}`, `[${host}]:${serverPort}`]);
  for (const line of output.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5 || columns[0].toUpperCase() !== 'TCP' || columns[3].toUpperCase() !== 'ESTABLISHED') continue;
    const [localEndpoint, remoteEndpoint] = columns.slice(1, 3);
    if (!clientEndpoints.has(localEndpoint) || !serverEndpoints.has(remoteEndpoint)) continue;
    const pid = Number.parseInt(columns.at(-1), 10);
    if (validPid(pid)) return pid;
  }
  return undefined;
}

export async function findWindowsTcpListenerOwnerPid({
  host,
  port,
  platform = process.platform,
  execFileImpl = execFile,
} = {}) {
  if (platform !== 'win32' || typeof host !== 'string' || !Number.isSafeInteger(port)) return undefined;
  return new Promise((resolve) => {
    try {
      execFileImpl(
        'netstat.exe',
        ['-ano', '-p', 'tcp'],
        { windowsHide: true, timeout: 1_500, maxBuffer: 1024 * 1024, encoding: 'utf8' },
        (error, stdout) => resolve(error ? undefined : parseWindowsNetstatListenerOwner(stdout, { host, port })),
      );
    } catch {
      resolve(undefined);
    }
  });
}

export async function findWindowsTcpConnectionOwnerPid({
  host,
  serverPort,
  clientPort,
  platform = process.platform,
  execFileImpl = execFile,
} = {}) {
  if (
    platform !== 'win32'
    || typeof host !== 'string'
    || !Number.isSafeInteger(serverPort)
    || !Number.isSafeInteger(clientPort)
  ) return undefined;
  return new Promise((resolve) => {
    try {
      execFileImpl(
        'netstat.exe',
        ['-ano', '-p', 'tcp'],
        { windowsHide: true, timeout: 1_500, maxBuffer: 1024 * 1024, encoding: 'utf8' },
        (error, stdout) => resolve(error ? undefined : parseWindowsNetstatConnectionOwner(stdout, { host, serverPort, clientPort })),
      );
    } catch {
      resolve(undefined);
    }
  });
}

export async function diagnoseBridgeStartupError(error, {
  host,
  port,
  ownerLookup = findWindowsTcpListenerOwnerPid,
} = {}) {
  const observedCode = typeof error?.code === 'string' && SAFE_ERROR_CODE.test(error.code)
    ? error.code
    : 'BRIDGE_START_FAILED';
  const diagnostic = { code: observedCode, reason: observedCode };
  if (observedCode !== 'EADDRINUSE') return diagnostic;

  diagnostic.port = port;
  try {
    const listenerOwnerPid = await ownerLookup({ host, port });
    if (validPid(listenerOwnerPid)) diagnostic.listenerOwnerPid = listenerOwnerPid;
  } catch {
    // Le PID est une aide facultative; l'échec de son diagnostic ne masque pas EADDRINUSE.
  }
  return diagnostic;
}

export function bridgeUnavailableStatus(diagnostic = {}) {
  const code = typeof diagnostic.code === 'string' && SAFE_ERROR_CODE.test(diagnostic.code)
    ? diagnostic.code
    : 'BRIDGE_START_FAILED';
  const collision = code === 'EADDRINUSE';
  return {
    available: false,
    mode: 'plugin-uxp',
    reason: code,
    code,
    ...(Number.isSafeInteger(diagnostic.port) ? { port: diagnostic.port } : {}),
    ...(validPid(diagnostic.listenerOwnerPid) ? { listenerOwnerPid: diagnostic.listenerOwnerPid } : {}),
    listenerOwnedByThisInstance: false,
    ownsPluginSession: false,
    message: collision
      ? 'Le port local du plugin est déjà écouté par une autre instance. Ce serveur MCP ne possède pas cette session UXP; le canal silencieux reste utilisable.'
      : 'Le plugin UXP est indisponible pour cette instance; le canal silencieux reste utilisable.',
  };
}

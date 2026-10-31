import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { WebSocket, WebSocketServer } from 'ws';
import { commandSignature, hmac, randomNonce, safeEqual } from '../security/crypto.js';
import { minimalWindowsEnvironment } from '../security/windowsEnvironment.js';
import { authorizeSharedCodexPeer } from '../security/SharedPeerPolicy.js';
import { FifoQueue } from '../core/FifoQueue.js';
import { PACKAGE_VERSION } from '../version.js';
import { acquireWindowsNamedMutexGuard } from './WindowsNamedMutexGuard.js';
import {
  SHARED_BRIDGE_VERSION,
  assertSafeSharedJson,
  isSharedBridgeRequest,
  publicSharedError,
  sharedClientProof,
  sharedServerProof,
  sharedSessionId,
  signSharedMessage,
  validSharedId,
  validSharedNonce,
  verifySharedMessage,
} from './SharedBridgeProtocol.js';

const EXPECTED_PLUGIN_ID = 'fr.pironjulien.indesign.mcp';
const EXPECTED_PLUGIN_VERSION = PACKAGE_VERSION;
export const EXPECTED_UXP_ORIGIN = 'file://';
const OPERATION_RETENTION_MS = 24 * 60 * 60 * 1000;
const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RELEASE_NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RECONCILIATION_RESPONSE_LIMIT = 1024 * 1024;
const PAIRING_CODE_PATTERN = /^[A-F0-9]{16}$/;
const PAIRING_MAX_ATTEMPTS = 3;
const PAIRING_HASH_DOMAIN = Buffer.from('indesign-mcp-pairing-code-v1\0', 'utf8');
const MAX_HOST_PROCESSES = 32;
const MAX_SHARED_REQUESTS_PER_SESSION = 10_000;
const SHARED_METHODS = new Set([
  'status',
  'execute',
  'operationStatus',
  'acknowledgeOperation',
  'runOperationReconciliation',
  'openPairingWindow',
  'armPairingClipboard',
]);
const execFileAsync = promisify(execFile);

function isLoopback(remoteAddress) {
  return remoteAddress === '127.0.0.1' || remoteAddress === '::ffff:127.0.0.1';
}

function listenerErrorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
    ? error.code
    : 'BRIDGE_LISTENER_FAILED';
}

export class BridgeProtocolError extends Error {
  constructor(message, code = 'BRIDGE_PROTOCOL_ERROR', details) {
    super(message);
    this.name = 'BridgeProtocolError';
    this.code = code;
    this.details = details;
  }
}

function validIdentity(value, maxLength) {
  return typeof value === 'string' && value.length >= 1 && value.length <= maxLength && /^[A-Za-z0-9._-]+$/.test(value);
}

function generatePairingCode() {
  return randomBytes(8).toString('hex').toUpperCase().match(/.{1,4}/g).join('-');
}

function normalizePairingCode(value) {
  if (typeof value !== 'string' || value.length > 64) return '';
  return value.trim().toUpperCase().replace(/[\s-]/g, '');
}

function pairingCodeHash(salt, normalizedCode) {
  return createHash('sha256')
    .update(PAIRING_HASH_DOMAIN)
    .update(salt)
    .update(normalizedCode, 'utf8')
    .digest();
}

async function captureWindowsInDesignProcesses() {
  if (process.platform !== 'win32') return [];
  const windowsDirectory = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const powershell = path.join(windowsDirectory, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const source = `$items = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'InDesign.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
  $created = $_.CreationDate
  if ($created -is [datetime]) { $startedAt = $created.ToUniversalTime().ToString('o') }
  else { try { $startedAt = [System.Management.ManagementDateTimeConverter]::ToDateTime([string]$created).ToUniversalTime().ToString('o') } catch { $startedAt = $null } }
  if ([int]$_.ProcessId -gt 0 -and $startedAt) { [pscustomobject]@{ processId = [int]$_.ProcessId; startedAt = $startedAt } }
})
@($items) | ConvertTo-Json -Compress`;
  const { stdout } = await execFileAsync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', source], {
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    env: minimalWindowsEnvironment(),
  });
  const parsed = JSON.parse(String(stdout).trim() || '[]');
  return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
}

function normalizeHostProcesses(value) {
  if (!Array.isArray(value) || value.length > MAX_HOST_PROCESSES) return undefined;
  const normalized = value.map((entry) => {
    if (
      !Number.isInteger(entry?.processId)
      || entry.processId <= 0
      || typeof entry.startedAt !== 'string'
      || Number.isNaN(Date.parse(entry.startedAt))
    ) return undefined;
    return { processId: entry.processId, startedAt: new Date(entry.startedAt).toISOString() };
  });
  if (normalized.some((entry) => !entry)) return undefined;
  normalized.sort((left, right) => left.processId - right.processId || left.startedAt.localeCompare(right.startedAt));
  const identities = normalized.map((entry) => `${entry.processId}|${entry.startedAt}`);
  if (new Set(identities).size !== identities.length) return undefined;
  return normalized;
}

export class InDesignBridge {
  constructor({
    config,
    secret,
    operationDirectory,
    protect = async () => {},
    operationMutexFactory = acquireWindowsNamedMutexGuard,
    hostProcessSnapshot,
    peerAuthorizer,
    maxSharedRequestsPerSession = MAX_SHARED_REQUESTS_PER_SESSION,
  }) {
    this.config = config;
    this.secret = secret;
    this.queue = new FifoQueue({ maxLength: config.maxQueueLength });
    this.server = undefined;
    this.socket = undefined;
    this.session = undefined;
    this.pending = new Map();
    this.completedOperations = new Map();
    this.persistedOperations = new Map();
    this.operationMutexGuards = new Map();
    this.mutexRecoveryOperations = new Map();
    this.mutexRecoveryFailures = new Map();
    this.reconciliationRequests = new Map();
    this.operationRemovals = new Set();
    this.operationContext = new AsyncLocalStorage();
    this.acknowledgedReleaseMarkers = new Map();
    this.operationDirectory = operationDirectory;
    this.protect = protect;
    this.operationMutexFactory = operationMutexFactory;
    this.hostProcessSnapshot = hostProcessSnapshot ?? (config.port === 0 ? async () => [] : captureWindowsInDesignProcesses);
    this.requireHostProcessAtDispatch = config.port !== 0 || hostProcessSnapshot !== undefined;
    this.peerAuthorizer = peerAuthorizer ?? (config.port === 0
      ? async () => ({ verified: true, processId: process.pid })
      : ({ serverPort, clientPort }) => authorizeSharedCodexPeer({
          host: config.host,
          serverPort,
          clientPort,
          allowedPaths: config.allowedParentPaths,
          allowedSigners: config.allowedParentSigners,
          allowedNames: config.allowedParentNames,
        }));
    this.maxSharedRequestsPerSession = Number.isSafeInteger(maxSharedRequestsPerSession) && maxSharedRequestsPerSession > 0
      ? maxSharedRequestsPerSession
      : MAX_SHARED_REQUESTS_PER_SESSION;
    this.pairingDeadline = 0;
    this.pairingConsumed = false;
    this.pairingProof = undefined;
    this.pairingClipboardArmed = false;
    this.pairingClipboardTrigger = undefined;
    this.pairingClipboardSignalsRemaining = 0;
    this.sessionChallenge = undefined;
    this.authenticationTimer = undefined;
    this.listenerFailure = undefined;
    this.closing = false;
    this.peerSessions = new Map();
    this.peerCandidates = new Set();
  }

  async start() {
    if (this.server) return;
    this.closing = false;
    const server = new WebSocketServer({
      host: this.config.host,
      port: this.config.port,
      maxPayload: this.config.maxPayloadBytes,
      perMessageDeflate: false,
      clientTracking: false,
      verifyClient: ({ origin, req }, done) => {
        const pluginRequest = (req.url === '/' || req.url === undefined) && origin === EXPECTED_UXP_ORIGIN;
        const allowed = isLoopback(req.socket.remoteAddress) && (pluginRequest || isSharedBridgeRequest(req));
        done(allowed, 403, 'UXP origin required');
      },
    });
    this.listenerFailure = undefined;
    this.server = server;
    let runtimeReady = false;
    server.on('connection', (socket, request) => {
      if (!runtimeReady) {
        socket.close(1013, 'bridge_starting');
        return;
      }
      if (isSharedBridgeRequest(request)) this.#onPeerConnection(socket, request);
      else this.#onConnection(socket, request);
    });
    let listening = false;
    const onRuntimeError = (error) => {
      if (listening) this.#handleRuntimeServerError(server, error);
    };
    server.on('error', onRuntimeError);
    try {
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          server.off('listening', onListening);
          server.off('error', onError);
        };
        const onListening = () => { listening = true; cleanup(); resolve(); };
        const onError = (error) => { cleanup(); reject(error); };
        server.once('listening', onListening);
        server.once('error', onError);
      });
    } catch (error) {
      if (this.server === server) this.server = undefined;
      this.listenerFailure = { code: listenerErrorCode(error), reason: listenerErrorCode(error), port: this.config.port };
      server.removeAllListeners('connection');
      server.off('error', onRuntimeError);
      throw error;
    }
    try {
      // Une instance secondaire doit échouer sur le port avant de lire ou de
      // reprendre les journaux privés du propriétaire. Sinon deux tâches Codex
      // peuvent acquitter la même garde et laisser un mutex orphelin.
      await this.#initializeOperationJournal();
      await this.#finishAcknowledgedOperations();
      await this.#recoverPersistedOperationGuards();
      runtimeReady = true;
    } catch (error) {
      const code = listenerErrorCode(error);
      this.listenerFailure = { code, reason: code, port: this.config.port };
      server.removeAllListeners('connection');
      server.off('error', onRuntimeError);
      await new Promise((resolve) => server.close(resolve)).catch(() => {});
      if (this.server === server) this.server = undefined;
      throw error;
    }
  }

  address() {
    const address = this.server?.address();
    return typeof address === 'object' && address ? address : undefined;
  }

  status() {
    const address = this.address();
    const pairingActive = this.#pairingIsActive();
    return {
      available: Boolean(address) && !this.listenerFailure && this.mutexRecoveryFailures.size === 0,
      listening: Boolean(address),
      connected: this.socket?.readyState === WebSocket.OPEN,
      authenticated: Boolean(this.session),
      pluginId: this.session?.pluginId,
      pluginVersion: this.session?.version,
      queueLength: this.queue.length,
      port: address?.port ?? this.config.port,
      pairingActive,
      ...(pairingActive ? { pairingExpiresAt: new Date(this.pairingDeadline).toISOString() } : {}),
      ...(pairingActive ? { pairingAttemptsRemaining: this.pairingProof.attemptsRemaining } : {}),
      reconcilableOperations: this.pending.size + this.completedOperations.size,
      persistedUnknownOperations: this.persistedOperations.size,
      ...(this.mutexRecoveryFailures.size > 0 ? {
        mutexRecoveryFailed: true,
        mutexRecoveryFailureCount: this.mutexRecoveryFailures.size,
      } : {}),
      ...(this.listenerFailure ?? {}),
      brokerRole: 'owner',
      sharedConnection: false,
      sharedClientCount: this.peerSessions.size,
    };
  }

  openPairingWindow({ windowSeconds = 120 } = {}) {
    const address = this.address();
    if (!address || this.listenerFailure) {
      throw new BridgeProtocolError(
        'Seule l’instance propriétaire du listener UXP peut ouvrir l’appairage.',
        'PAIRING_LISTENER_NOT_OWNED',
      );
    }
    if (!Number.isInteger(windowSeconds) || windowSeconds < 30 || windowSeconds > 300) {
      throw new BridgeProtocolError('La durée d’appairage est invalide.', 'PAIRING_WINDOW_INVALID');
    }
    if (this.session) {
      throw new BridgeProtocolError(
        'Le plugin est déjà authentifié; oubliez d’abord l’appairage depuis le panneau pour le renouveler.',
        'PLUGIN_ALREADY_AUTHENTICATED',
      );
    }
    this.#discardPairingProof();
    const pairingCode = generatePairingCode();
    const normalizedCode = normalizePairingCode(pairingCode);
    const salt = randomBytes(32);
    this.pairingConsumed = false;
    this.pairingDeadline = Date.now() + (windowSeconds * 1000);
    this.pairingProof = {
      salt,
      digest: pairingCodeHash(salt, normalizedCode),
      attemptsRemaining: PAIRING_MAX_ATTEMPTS,
    };
    this.pairingClipboardArmed = false;
    this.pairingClipboardTrigger = undefined;
    this.pairingClipboardSignalsRemaining = PAIRING_MAX_ATTEMPTS;
    return {
      ok: true,
      pairingActive: true,
      pairingExpiresAt: new Date(this.pairingDeadline).toISOString(),
      pairingCode,
      pairingAttempts: PAIRING_MAX_ATTEMPTS,
      windowSeconds,
      port: address.port,
    };
  }

  armPairingClipboard() {
    const address = this.address();
    if (!address || this.listenerFailure) {
      throw new BridgeProtocolError(
        'Seule l’instance propriétaire du listener UXP peut armer le presse-papiers.',
        'PAIRING_LISTENER_NOT_OWNED',
      );
    }
    if (this.session) {
      throw new BridgeProtocolError(
        'Le plugin est déjà authentifié.',
        'PLUGIN_ALREADY_AUTHENTICATED',
      );
    }
    if (!this.#pairingIsActive()) {
      throw new BridgeProtocolError(
        'Ouvrez d’abord une fenêtre d’appairage contrôlée.',
        'PAIRING_DISABLED',
      );
    }
    if (this.pairingClipboardSignalsRemaining <= 0) {
      throw new BridgeProtocolError(
        'Le nombre de lectures automatiques du presse-papiers est épuisé.',
        'PAIRING_CLIPBOARD_ATTEMPTS_EXHAUSTED',
      );
    }
    this.pairingClipboardSignalsRemaining -= 1;
    this.pairingClipboardArmed = true;
    this.pairingClipboardTrigger = randomNonce();
    const delivered = this.#deliverPairingClipboardSignal(this.socket);
    return {
      ok: true,
      pairingActive: true,
      clipboardReadArmed: true,
      clipboardSignalDelivered: delivered,
      pairingExpiresAt: new Date(this.pairingDeadline).toISOString(),
      clipboardSignalsRemaining: this.pairingClipboardSignalsRemaining,
      port: address.port,
    };
  }

  operationStatus(operationId) {
    this.#cleanupOperationHistory();
    const pending = this.pending.get(operationId);
    if (pending) {
      return {
        ok: true,
        operationId,
        status: pending.disconnected ? 'pending-after-disconnect' : pending.timedOut ? 'pending-after-timeout' : 'pending',
        command: pending.command,
        requiresInspection: pending.timedOut === true || pending.disconnected === true,
      };
    }
    const completed = this.completedOperations.get(operationId);
    if (completed) return { ok: true, operationId, status: 'completed', ...completed };
    const persisted = this.persistedOperations.get(operationId);
    if (persisted) {
      return {
        ok: true,
        operationId,
        status: persisted.status === 'completed-after-timeout'
          ? 'completed-after-restart'
          : 'pending-after-restart',
        command: persisted.command,
        completionKind: persisted.completionKind,
        updatedAt: persisted.updatedAt,
        persisted: true,
        requiresInspection: true,
      };
    }
    return { ok: true, operationId, status: 'not-found', requiresInspection: true };
  }

  #cleanupOperationHistory() {
    const cutoff = Date.now() - OPERATION_RETENTION_MS;
    for (const [operationId, operation] of this.completedOperations) {
      if (operation.completedAtMs < cutoff) this.completedOperations.delete(operationId);
    }
    for (const [operationId, operation] of this.pending) {
      if (operation.uncertainAtMs && operation.uncertainAtMs < cutoff) {
        clearTimeout(operation.timer);
        this.pending.delete(operationId);
      }
    }
  }

  execute(command) {
    const operationId = this.operationContext.getStore();
    return this.queue.enqueue(() => this.operationContext.run(operationId, () => {
      if (this.persistedOperations.size > 0) {
        const error = new BridgeProtocolError(
          'Une commande InDesign possède encore une issue inconnue; consultez son statut puis réconciliez-la avant toute nouvelle commande.',
          'PERSISTED_OPERATION_REQUIRES_RECONCILIATION',
        );
        error.operationIds = [...this.persistedOperations.keys()].slice(0, 10);
        error.requiresInspection = true;
        throw error;
      }
      return this.#sendCommand(command);
    }));
  }

  withOperationId(operationId, operation) {
    if (!OPERATION_ID_PATTERN.test(operationId ?? '')) {
      throw new BridgeProtocolError('L’identifiant de contexte InDesign est invalide.', 'OPERATION_ID_INVALID');
    }
    if (typeof operation !== 'function') {
      throw new BridgeProtocolError('Le contexte InDesign exige une fonction.', 'OPERATION_CONTEXT_INVALID');
    }
    return this.operationContext.run(operationId, operation);
  }

  async acknowledgeOperation(operationId) {
    if (!OPERATION_ID_PATTERN.test(operationId ?? '')) {
      throw new BridgeProtocolError('L’identifiant de l’opération à acquitter est invalide.', 'OPERATION_ID_INVALID');
    }
    const pending = this.pending.get(operationId);
    if (pending && !pending.timedOut && !pending.disconnected) {
      throw new BridgeProtocolError('Une opération encore active ne peut pas être acquittée.', 'OPERATION_STILL_ACTIVE');
    }
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(operationId);
    }
    const existed = Boolean(pending || this.completedOperations.has(operationId) || this.persistedOperations.has(operationId));
    this.completedOperations.delete(operationId);
    await this.#removeOperationRecord(operationId);
    return existed;
  }

  async runOperationReconciliation({
    operationId,
    scriptPath,
    language,
    completionPath,
    completionTimeoutMs = 120_000,
  }) {
    if (!OPERATION_ID_PATTERN.test(operationId ?? '')) {
      throw new BridgeProtocolError('L’identifiant de réconciliation est invalide.', 'OPERATION_ID_INVALID');
    }
    if (!this.persistedOperations.has(operationId)) {
      throw new BridgeProtocolError('Aucune issue plugin inconnue ne correspond à cette réconciliation.', 'RECONCILIATION_OPERATION_NOT_FOUND');
    }
    const pending = this.pending.get(operationId);
    if (pending && !pending.timedOut && !pending.disconnected) {
      throw new BridgeProtocolError('La commande plugin est encore active et ne peut pas être réconciliée.', 'OPERATION_STILL_ACTIVE');
    }
    if (!['UXP', 'JAVASCRIPT'].includes(language)) {
      throw new BridgeProtocolError('Le langage de réconciliation est invalide.', 'RECONCILIATION_REQUEST_INVALID');
    }
    if (!Number.isInteger(completionTimeoutMs) || completionTimeoutMs < 1_000 || completionTimeoutMs > 900_000) {
      throw new BridgeProtocolError('Le délai de réconciliation est invalide.', 'RECONCILIATION_REQUEST_INVALID');
    }
    if (this.reconciliationRequests.has(operationId)) {
      throw new BridgeProtocolError('Une requête de réconciliation est déjà active pour cette opération.', 'RECONCILIATION_REQUEST_ACTIVE');
    }
    await this.#assertInDesignHostRestartedForPending(operationId);
    await this.#validateReconciliationPaths({ scriptPath, completionPath, language });
    const guard = this.operationMutexGuards.get(operationId) ?? await this.#recoverPersistedOperationGuard(operationId);
    if (!guard || guard.exited) {
      throw new BridgeProtocolError('Le helper détenteur du mutex InDesign est indisponible.', 'INDESIGN_MUTEX_RECOVERY_FAILED');
    }

    const requestId = randomUUID();
    const paths = this.#reconciliationRequestPaths(operationId, requestId);
    const request = {
      schemaVersion: 1,
      operationId,
      requestId,
      scriptPath,
      language,
      completionPath,
      completionTimeoutMs,
      createdAt: new Date().toISOString(),
    };
    const stagedRequestPath = `${paths.request}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(stagedRequestPath, JSON.stringify(request), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await this.protect(stagedRequestPath, { kind: 'file' });
      await fs.rename(stagedRequestPath, paths.request);
    } finally {
      await fs.rm(stagedRequestPath, { force: true }).catch(() => {});
    }
    this.reconciliationRequests.set(operationId, { requestId, ...paths });
    let cleanupRequest = false;
    try {
      const response = await this.#waitForReconciliationResponse({
        operationId,
        requestId,
        responsePath: paths.response,
        timeoutMs: completionTimeoutMs + 10_000,
      });
      cleanupRequest = response.ok === true;
      if (response.ok !== true) {
        const error = new BridgeProtocolError(
          'Le helper InDesign a refusé ou interrompu la requête privée de réconciliation.',
          typeof response.code === 'string' ? response.code : 'RECONCILIATION_HELPER_FAILED',
        );
        error.operationId = operationId;
        error.requiresInspection = true;
        throw error;
      }
      return { stdout: JSON.stringify({ ok: true, result: response.result }) };
    } finally {
      this.reconciliationRequests.delete(operationId);
      if (cleanupRequest) {
        await Promise.all([
          fs.rm(paths.request, { force: true }),
          fs.rm(paths.processing, { force: true }),
          fs.rm(paths.response, { force: true }),
        ]).catch(() => {});
      }
    }
  }

  async close() {
    this.closing = true;
    this.#discardPairingProof();
    this.#markPendingUnknown(new BridgeProtocolError('La passerelle InDesign s’arrête.', 'BRIDGE_CLOSED'));
    if (this.socket) this.socket.terminate();
    for (const peer of this.peerSessions.keys()) {
      try { peer.close(1001, 'broker_shutdown'); } catch {}
    }
    for (const peer of this.peerCandidates) {
      try { peer.close(1001, 'broker_shutdown'); } catch {}
    }
    this.peerSessions.clear();
    this.peerCandidates.clear();
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    await new Promise((resolve) => server.close(resolve));
  }

  #handleRuntimeServerError(server, error) {
    if (this.server !== server) return;
    const code = listenerErrorCode(error);
    this.listenerFailure = { code, reason: code, port: this.config.port };
    this.server = undefined;
    const socket = this.socket;
    this.socket = undefined;
    this.session = undefined;
    this.sessionChallenge = undefined;
    clearTimeout(this.authenticationTimer);
    this.authenticationTimer = undefined;
    this.#markPendingUnknown(new BridgeProtocolError('Le listener du plugin InDesign est devenu indisponible.', 'BRIDGE_LISTENER_FAILED'));
    try { socket?.terminate(); } catch {}
    for (const peer of this.peerSessions.keys()) {
      try { peer.terminate(); } catch {}
    }
    for (const peer of this.peerCandidates) {
      try { peer.terminate(); } catch {}
    }
    this.peerSessions.clear();
    this.peerCandidates.clear();
    server.removeAllListeners('connection');
    try { server.close(() => {}); } catch {}
  }

  #onPeerConnection(socket, request) {
    if (!isLoopback(request.socket.remoteAddress) || !isSharedBridgeRequest(request)) {
      socket.close(1008, 'peer_loopback_only');
      return;
    }
    if (this.peerSessions.size + this.peerCandidates.size >= this.config.maxQueueLength) {
      socket.close(1013, 'peer_capacity_reached');
      return;
    }
    this.peerCandidates.add(socket);
    const serverNonce = randomNonce();
    const session = {
      processAuthorized: false,
      authenticated: false,
      serverNonce,
      sessionId: undefined,
      usedNonces: new Set(),
      authenticationTimer: undefined,
    };
    session.authenticationTimer = setTimeout(
      () => socket.close(1008, 'peer_process_timeout'),
      this.config.authenticationTimeoutMs + 12_000,
    );
    session.authenticationTimer.unref?.();
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, 'json_text_only');
        return;
      }
      void this.#onPeerMessage(socket, session, data.toString()).catch(() => socket.close(1008, 'invalid_peer_message'));
    });
    socket.once('close', () => {
      clearTimeout(session.authenticationTimer);
      this.peerCandidates.delete(socket);
      const wasAuthenticated = this.peerSessions.delete(socket);
      if (wasAuthenticated) this.#broadcastPeerStatus();
    });
    socket.once('error', () => {});
    void Promise.resolve(this.peerAuthorizer({
      serverPort: request.socket.localPort,
      clientPort: request.socket.remotePort,
    })).then((identity) => {
      if (identity?.verified !== true || socket.readyState !== WebSocket.OPEN) {
        socket.close(1008, 'peer_process_unauthorized');
        return;
      }
      session.processAuthorized = true;
      session.processId = identity.processId;
      clearTimeout(session.authenticationTimer);
      session.authenticationTimer = setTimeout(
        () => socket.close(1008, 'peer_authentication_timeout'),
        this.config.authenticationTimeoutMs,
      );
      session.authenticationTimer.unref?.();
      this.#send(socket, { type: 'peer_challenge', version: SHARED_BRIDGE_VERSION, serverNonce });
    }).catch(() => socket.close(1008, 'peer_process_unauthorized'));
  }

  async #onPeerMessage(socket, session, raw) {
    let message;
    try { message = JSON.parse(raw); } catch { throw new BridgeProtocolError('Message partagé JSON invalide.'); }
    assertSafeSharedJson(message);
    if (!session.processAuthorized) {
      throw new BridgeProtocolError('Processus du client (Codex ou Claude) non autorisé.', 'SHARED_BRIDGE_PROCESS_UNAUTHORIZED');
    }
    if (!session.authenticated) {
      if (
        message?.type !== 'peer_auth'
        || message.version !== SHARED_BRIDGE_VERSION
        || !validSharedNonce(message.clientNonce)
        || !safeEqual(message.proof, sharedClientProof(this.secret, session.serverNonce, message.clientNonce))
      ) {
        throw new BridgeProtocolError('Authentification du client (Codex ou Claude) refusée.', 'SHARED_BRIDGE_AUTH_FAILED');
      }
      session.authenticated = true;
      clearTimeout(session.authenticationTimer);
      session.authenticationTimer = undefined;
      session.sessionId = sharedSessionId(this.secret, session.serverNonce, message.clientNonce);
      this.peerCandidates.delete(socket);
      this.peerSessions.set(socket, session);
      this.#send(socket, {
        type: 'peer_auth_ok',
        version: SHARED_BRIDGE_VERSION,
        ownerProcessId: process.pid,
        proof: sharedServerProof(this.secret, session.serverNonce, message.clientNonce),
        status: this.status(),
      });
      this.#broadcastPeerStatus();
      return;
    }
    if (
      message?.type !== 'peer_request'
      || !validSharedId(message.id)
      || !validSharedNonce(message.nonce)
      || !SHARED_METHODS.has(message.method)
      || !message.params
      || typeof message.params !== 'object'
      || Array.isArray(message.params)
      || session.usedNonces.has(message.nonce)
      || !verifySharedMessage(this.secret, session.sessionId, message, 'request')
    ) {
      throw new BridgeProtocolError('Requête du client (Codex ou Claude) invalide.', 'SHARED_BRIDGE_REQUEST_INVALID');
    }
    if (session.usedNonces.size >= this.maxSharedRequestsPerSession) {
      throw new BridgeProtocolError('La session partagée doit renouveler son authentification.', 'SHARED_BRIDGE_SESSION_LIMIT');
    }
    session.usedNonces.add(message.nonce);
    try {
      const result = await this.#dispatchPeerMethod(message.method, message.params);
      this.#sendPeerResponse(socket, session, {
        type: 'peer_response',
        id: message.id,
        nonce: randomNonce(),
        ok: true,
        result: JSON.parse(JSON.stringify(result ?? null)),
        ownerStatus: this.status(),
      });
    } catch (error) {
      this.#sendPeerResponse(socket, session, {
        type: 'peer_response',
        id: message.id,
        nonce: randomNonce(),
        ok: false,
        error: JSON.parse(JSON.stringify(publicSharedError(error))),
      });
    }
  }

  async #dispatchPeerMethod(method, params) {
    if (method === 'status') return this.status();
    if (method === 'execute') {
      if (!validSharedId(params.operationId) || !params.command || typeof params.command !== 'object' || Array.isArray(params.command)) {
        throw new BridgeProtocolError('Commande partagée invalide.', 'SHARED_BRIDGE_REQUEST_INVALID');
      }
      return this.withOperationId(params.operationId, () => this.execute(params.command));
    }
    if (!validSharedId(params.operationId) && method !== 'openPairingWindow' && method !== 'armPairingClipboard') {
      throw new BridgeProtocolError('Identifiant d’opération partagé invalide.', 'SHARED_BRIDGE_REQUEST_INVALID');
    }
    if (method === 'operationStatus') return this.operationStatus(params.operationId);
    if (method === 'acknowledgeOperation') return this.acknowledgeOperation(params.operationId);
    if (method === 'runOperationReconciliation') return this.runOperationReconciliation(params);
    if (method === 'openPairingWindow') return this.openPairingWindow(params);
    if (method === 'armPairingClipboard') return this.armPairingClipboard();
    throw new BridgeProtocolError('Méthode partagée interdite.', 'SHARED_BRIDGE_METHOD_FORBIDDEN');
  }

  #sendPeerResponse(socket, session, envelope) {
    const safeEnvelope = JSON.parse(JSON.stringify(envelope));
    safeEnvelope.proof = signSharedMessage(this.secret, session.sessionId, safeEnvelope, 'response');
    this.#send(socket, safeEnvelope);
  }

  #broadcastPeerStatus() {
    for (const [socket, session] of this.peerSessions) {
      if (socket.readyState !== WebSocket.OPEN || !session.authenticated) continue;
      this.#sendPeerResponse(socket, session, {
        type: 'peer_status',
        id: randomUUID(),
        nonce: randomNonce(),
        ok: true,
        result: this.status(),
      });
    }
  }

  #onConnection(socket, request) {
    const remote = request.socket.remoteAddress;
    if (!isLoopback(remote) || request.headers.origin !== EXPECTED_UXP_ORIGIN) {
      socket.close(1008, 'loopback_only');
      return;
    }
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
      socket.close(1013, 'single_connection_only');
      return;
    }

    this.socket = socket;
    this.session = undefined;
    const challenge = randomNonce();
    const authenticationTimer = setTimeout(() => socket.close(1008, 'authentication_timeout'), this.config.authenticationTimeoutMs);
    this.authenticationTimer = authenticationTimer;
    authenticationTimer.unref?.();
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, 'json_text_only');
        return;
      }
      void this.#onMessage(socket, challenge, data.toString()).catch(() => socket.close(1008, 'invalid_message'));
    });
    socket.once('close', () => {
      clearTimeout(authenticationTimer);
      if (this.socket === socket) {
        this.socket = undefined;
        this.session = undefined;
        this.sessionChallenge = undefined;
        this.authenticationTimer = undefined;
        this.#markPendingUnknown(new BridgeProtocolError('Le plugin InDesign est déconnecté.', 'PLUGIN_DISCONNECTED'));
        this.#broadcastPeerStatus();
      }
    });
    socket.once('error', () => {});
    this.#send(socket, { type: 'auth_challenge', nonce: challenge });
    this.#deliverPairingClipboardSignal(socket);
  }

  async #onMessage(socket, challenge, raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      throw new BridgeProtocolError('Message JSON invalide.');
    }
    if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') {
      throw new BridgeProtocolError('Enveloppe de message invalide.');
    }

    if (!this.session) {
      if (message.type === 'pairing_required' || message.type === 'pair_stored') return;
      if (message.type === 'pair_request') {
        this.#handlePairRequest(socket, message);
        return;
      }
      if (message.type !== 'auth_proof') throw new BridgeProtocolError('Authentification requise.');
      this.#handleAuthentication(socket, challenge, message);
      return;
    }

    if (message.type === 'ready') {
      if (Array.isArray(message.commands)) this.session.commands = message.commands.filter((item) => typeof item === 'string').slice(0, 500);
      this.#broadcastPeerStatus();
      return;
    }

    if (message.type !== 'result' && message.type !== 'error') {
      throw new BridgeProtocolError('Le plugin a envoyé un type de réponse interdit.');
    }
    if (typeof message.id !== 'string' || !this.pending.has(message.id)) return;
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.type === 'error') {
      const payload = message.error && typeof message.error === 'object' ? message.error : message;
      const error = new BridgeProtocolError(
        typeof payload.message === 'string' ? payload.message : 'Erreur InDesign sans message.',
        typeof payload.code === 'string' ? payload.code : 'INDESIGN_ERROR',
        payload.details,
      );
      const requiresInspection = payload.requiresInspection === true || payload.details?.requiresInspection === true;
      if (requiresInspection) {
        error.operationId = message.id;
        error.requiresInspection = true;
        if (Array.isArray(payload.documentStates)) error.documentStates = payload.documentStates;
      }
      if (pending.timedOut || requiresInspection) {
        const completed = {
          command: pending.command,
          outcome: {
            ok: false,
            error: {
              code: error.code,
              message: error.message,
              details: error.details,
              requiresInspection,
              documentStates: error.documentStates,
            },
          },
          completedAt: new Date().toISOString(),
          completedAtMs: Date.now(),
          requiresInspection: true,
        };
        await this.#appendOperationEvent(message.id, {
          command: pending.command,
          status: 'completed-after-timeout',
          completionKind: 'error',
          updatedAt: completed.completedAt,
        }).catch(() => {});
        this.completedOperations.set(message.id, completed);
        if (!pending.clientSettled) {
          pending.clientSettled = true;
          pending.reject(error);
        }
      } else {
        const released = await this.#releaseKnownOperationRecord(message.id, pending, {
          ok: false,
          error: { code: error.code, message: error.message, details: error.details },
        });
        if (!released) return;
        pending.reject(error);
      }
      return;
    }
    const response = { result: message.result, documentId: message.result?.documentId, revision: message.result?.revision, operationId: message.id };
    if (pending.timedOut) {
      const completed = {
        command: pending.command,
        outcome: { ok: true, ...response },
        completedAt: new Date().toISOString(),
        completedAtMs: Date.now(),
        requiresInspection: true,
      };
      await this.#appendOperationEvent(message.id, {
        command: pending.command,
        status: 'completed-after-timeout',
        completionKind: 'success',
        updatedAt: completed.completedAt,
      }).catch(() => {});
      this.completedOperations.set(message.id, completed);
    } else {
      const released = await this.#releaseKnownOperationRecord(message.id, pending, { ok: true, ...response });
      if (!released) return;
      pending.resolve(response);
    }
  }

  async #releaseKnownOperationRecord(operationId, pending, outcome) {
    try {
      await this.#removeOperationRecord(operationId);
      return true;
    } catch {
      const completedAt = new Date().toISOString();
      this.completedOperations.set(operationId, {
        command: pending.command,
        outcome,
        completedAt,
        completedAtMs: Date.now(),
        requiresInspection: true,
      });
      const error = new BridgeProtocolError(
        'La réponse InDesign est connue, mais son verrou privé n’a pas pu être acquitté.',
        'OPERATION_ACKNOWLEDGEMENT_FAILED',
      );
      error.operationId = operationId;
      error.requiresInspection = true;
      pending.clientSettled = true;
      pending.reject(error);
      return false;
    }
  }

  #handlePairRequest(socket, message) {
    if (
      !validIdentity(message.pluginId, 128)
      || !validIdentity(message.version, 32)
      || message.pluginId !== EXPECTED_PLUGIN_ID
      || message.version !== EXPECTED_PLUGIN_VERSION
    ) {
      throw new BridgeProtocolError('Identité du plugin invalide.');
    }
    const active = this.#pairingIsActive();
    if (!active) throw new BridgeProtocolError('Le mode d’appairage contrôlé n’est pas actif.', 'PAIRING_DISABLED');
    if (typeof message.pairingNonce !== 'string' || message.pairingNonce.length < 32 || message.pairingNonce.length > 256) {
      throw new BridgeProtocolError('Nonce d’appairage invalide.');
    }
    const normalizedCode = normalizePairingCode(message.pairingCode);
    const candidateDigest = pairingCodeHash(this.pairingProof.salt, normalizedCode);
    const proofMatches = timingSafeEqual(candidateDigest, this.pairingProof.digest);
    const codeAccepted = PAIRING_CODE_PATTERN.test(normalizedCode) && proofMatches;
    this.pairingProof.attemptsRemaining -= 1;
    if (!codeAccepted) {
      if (this.pairingProof.attemptsRemaining <= 0) this.#discardPairingProof();
      throw new BridgeProtocolError('Code d’appairage refusé.', 'PAIRING_CODE_INVALID');
    }
    this.#discardPairingProof();
    this.#send(socket, { type: 'pair_secret', secret: this.secret, pairingNonce: message.pairingNonce });
  }

  #pairingIsActive() {
    if (this.pairingConsumed || !this.pairingProof) return false;
    if (Date.now() >= this.pairingDeadline || this.pairingProof.attemptsRemaining <= 0) {
      this.#discardPairingProof();
      return false;
    }
    return true;
  }

  #deliverPairingClipboardSignal(socket) {
    if (
      !this.pairingClipboardArmed
      || !this.pairingClipboardTrigger
      || !this.#pairingIsActive()
      || this.session
      || !socket
      || socket.readyState !== WebSocket.OPEN
    ) return false;
    this.#send(socket, {
      type: 'pairing_clipboard_ready',
      trigger: this.pairingClipboardTrigger,
      pairingExpiresAt: new Date(this.pairingDeadline).toISOString(),
    });
    this.pairingClipboardArmed = false;
    this.pairingClipboardTrigger = undefined;
    return true;
  }

  #discardPairingProof() {
    this.pairingConsumed = true;
    this.pairingDeadline = 0;
    this.pairingClipboardArmed = false;
    this.pairingClipboardTrigger = undefined;
    this.pairingClipboardSignalsRemaining = 0;
    if (this.pairingProof) {
      this.pairingProof.salt.fill(0);
      this.pairingProof.digest.fill(0);
      this.pairingProof = undefined;
    }
  }

  async #assertInDesignHostRestartedForPending(operationId) {
    let operation = this.persistedOperations.get(operationId);
    if (!operation || operation.status !== 'pending') return;
    const original = normalizeHostProcesses(operation.hostProcessesAtDispatch);
    let current;
    try {
      current = normalizeHostProcesses(await this.hostProcessSnapshot());
    } catch {
      current = undefined;
    }
    // Une réponse plugin peut être arrivée pendant la lecture des processus.
    // Dans ce cas le code UXP a réellement terminé et le redémarrage n’est plus
    // nécessaire; l’inspection reste toutefois obligatoire.
    operation = this.persistedOperations.get(operationId);
    if (!operation || operation.status !== 'pending') return;
    const identity = (entry) => `${entry.processId}|${entry.startedAt}`;
    const originalIdentities = new Set((original ?? []).map(identity));
    const originalStillAlive = (current ?? []).some((entry) => originalIdentities.has(identity(entry)));
    if (!original?.length || !current?.length || originalStillAlive) {
      const error = new BridgeProtocolError(
        'Le code UXP peut encore reprendre : fermez complètement InDesign, relancez-le, puis recommencez la réconciliation.',
        'RECONCILIATION_RESTART_REQUIRED',
      );
      error.operationId = operationId;
      error.requiresInspection = true;
      throw error;
    }
  }

  #handleAuthentication(socket, challenge, message) {
    if (
      !validIdentity(message.pluginId, 128)
      || !validIdentity(message.version, 32)
      || message.pluginId !== EXPECTED_PLUGIN_ID
      || message.version !== EXPECTED_PLUGIN_VERSION
      || message.nonce !== challenge
      || typeof message.pluginNonce !== 'string'
      || message.pluginNonce.length < 32
      || message.pluginNonce.length > 256
      || !/^[A-Za-z0-9_-]+$/.test(message.pluginNonce)
    ) {
      throw new BridgeProtocolError('Preuve d’authentification mal formée.');
    }
    const expected = hmac(this.secret, `plugin:${challenge}:${message.pluginNonce}:${message.pluginId}:${message.version}`);
    if (!safeEqual(expected, message.proof)) throw new BridgeProtocolError('Preuve d’authentification refusée.', 'AUTHENTICATION_FAILED');
    this.#discardPairingProof();
    this.session = { pluginId: message.pluginId, version: message.version, pluginNonce: message.pluginNonce };
    this.sessionChallenge = `${challenge}:${message.pluginNonce}`;
    clearTimeout(this.authenticationTimer);
    this.authenticationTimer = undefined;
    const proof = hmac(this.secret, `bridge:${challenge}:${message.pluginNonce}:${message.pluginId}:${message.version}`);
    this.#send(socket, { type: 'auth_ok', nonce: challenge, pluginNonce: message.pluginNonce, proof });
    this.#broadcastPeerStatus();
  }

  async #sendCommand({ command, args, documentId, expectedRevision, expectedStateToken }) {
    const socket = this.socket;
    const sessionChallenge = this.sessionChallenge;
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.session) {
      throw new BridgeProtocolError('Le plugin InDesign authentifié n’est pas connecté.', 'PLUGIN_NOT_CONNECTED');
    }
    let safeArgs;
    try {
      safeArgs = JSON.parse(JSON.stringify(args ?? {}));
    } catch {
      throw new BridgeProtocolError('Les arguments ne sont pas du JSON sérialisable.', 'INVALID_ARGS');
    }
    const id = this.operationContext.getStore() ?? randomUUID();
    const nonce = randomNonce();
    const releaseNonce = randomNonce();
    const envelope = { type: 'command', id, command, args: safeArgs, documentId, expectedRevision, expectedStateToken, nonce };
    envelope.sessionChallenge = sessionChallenge;
    envelope.proof = commandSignature(this.secret, envelope);
    delete envelope.sessionChallenge;

    await this.#appendOperationEvent(id, {
      command,
      status: 'pending',
      releaseNonce,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    let mutexGuard;
    try {
      mutexGuard = await this.#acquireOperationMutex(id);
    } catch (sourceError) {
      await this.#removeOperationRecord(id).catch(() => {});
      if (sourceError instanceof BridgeProtocolError) throw sourceError;
      throw new BridgeProtocolError(
        sourceError?.message ?? 'Le mutex commun InDesign n’a pas pu être acquis.',
        sourceError?.code ?? 'INDESIGN_MUTEX_ACQUISITION_FAILED',
      );
    }

    if (mutexGuard?.status === 'abandoned') {
      const error = new BridgeProtocolError(
        'Le mutex commun InDesign a été abandonné; l’issue précédente doit être inspectée avant toute nouvelle commande.',
        'INDESIGN_MUTEX_ABANDONED',
      );
      error.operationId = id;
      error.requiresInspection = true;
      throw error;
    }

    if (
      mutexGuard?.exited
      || socket !== this.socket
      || socket.readyState !== WebSocket.OPEN
      || !this.session
      || this.sessionChallenge !== sessionChallenge
    ) {
      await this.#removeOperationRecord(id).catch(() => {});
      throw new BridgeProtocolError('La session plugin a changé avant l’envoi; aucune commande n’a été envoyée.', 'PLUGIN_NOT_CONNECTED');
    }

    let hostProcessesAtDispatch;
    try {
      hostProcessesAtDispatch = normalizeHostProcesses(await this.hostProcessSnapshot());
      if (!hostProcessesAtDispatch || (this.requireHostProcessAtDispatch && hostProcessesAtDispatch.length === 0)) {
        throw new BridgeProtocolError(
          'L’identité du processus InDesign n’a pas pu être capturée avant la commande.',
          'INDESIGN_HOST_IDENTITY_UNAVAILABLE',
        );
      }
      await this.#appendOperationEvent(id, {
        command,
        status: 'pending',
        hostProcessesAtDispatch,
        updatedAt: new Date().toISOString(),
      });
    } catch (sourceError) {
      await this.#removeOperationRecord(id).catch(() => {});
      if (sourceError instanceof BridgeProtocolError) throw sourceError;
      throw new BridgeProtocolError(
        'L’identité du processus InDesign n’a pas pu être capturée avant la commande.',
        'INDESIGN_HOST_IDENTITY_UNAVAILABLE',
      );
    }

    let settle;
    const result = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    const timer = setTimeout(() => {
      const current = this.pending.get(id);
      if (!current) return;
      current.timedOut = true;
      current.uncertainAtMs ??= Date.now();
      const error = new BridgeProtocolError(`Délai dépassé pour ${command}; l’issue doit être réconciliée avant toute nouvelle mutation.`, 'COMMAND_TIMEOUT');
      error.operationId = id;
      error.requiresInspection = true;
      if (!current.clientSettled) {
        current.clientSettled = true;
        current.reject(error);
      }
    }, this.config.commandTimeoutMs);
    timer.unref?.();
    const pending = {
      ...settle,
      timer,
      command,
      timedOut: false,
      disconnected: false,
      sent: false,
      clientSettled: false,
    };
    this.pending.set(id, pending);
    try {
      socket.send(JSON.stringify(envelope), (sendError) => {
        if (!sendError) return;
        const current = this.pending.get(id);
        if (!current) return;
        const error = new BridgeProtocolError('L’envoi de la commande au plugin a été interrompu; son issue est inconnue.', 'PLUGIN_SEND_FAILED');
        this.#markOperationUnknown(id, current, error);
      });
      pending.sent = true;
    } catch (sourceError) {
      clearTimeout(timer);
      this.pending.delete(id);
      await this.#removeOperationRecord(id).catch(() => {});
      throw sourceError;
    }
    return result;
  }

  async #acquireOperationMutex(operationId, { expectedGuardProcessId, recovery = false } = {}) {
    const operationPath = this.#operationRecordPath(operationId);
    if (!operationPath) return undefined;
    let operation = this.persistedOperations.get(operationId);
    if (!operation) {
      throw new BridgeProtocolError('Le journal à protéger a disparu avant l’acquisition du mutex.', 'OPERATION_JOURNAL_MISSING');
    }
    if (!RELEASE_NONCE_PATTERN.test(operation.releaseNonce ?? '')) {
      await this.#appendOperationEvent(operationId, {
        command: operation.command,
        status: operation.status,
        completionKind: operation.completionKind,
        createdAt: operation.createdAt,
        guardProcessId: operation.guardProcessId,
        releaseNonce: randomNonce(),
        updatedAt: new Date().toISOString(),
      });
      operation = this.persistedOperations.get(operationId);
    }
    const acquired = await this.operationMutexFactory({
      operationPath,
      timeoutMs: 120_000,
      expectedGuardProcessId,
      recovery,
      releaseNonce: operation.releaseNonce,
    });
    if (
      !acquired
      || !Number.isInteger(acquired.processId)
      || acquired.processId <= 0
      || typeof acquired.exit?.then !== 'function'
    ) {
      throw new BridgeProtocolError('Le helper du mutex InDesign a renvoyé une garde invalide.', 'INDESIGN_MUTEX_HELPER_PROTOCOL_ERROR');
    }
    const durableGuardProcessId = acquired.status === 'watching'
      ? (acquired.guardedProcessId ?? expectedGuardProcessId)
      : acquired.processId;
    if (!Number.isInteger(durableGuardProcessId) || durableGuardProcessId <= 0) {
      throw new BridgeProtocolError('Le helper de reprise n’a pas identifié le détenteur original du mutex.', 'INDESIGN_MUTEX_HELPER_PROTOCOL_ERROR');
    }
    const guard = { ...acquired, exited: false, exitState: undefined };
    this.operationMutexGuards.set(operationId, guard);
    void Promise.resolve(acquired.exit).then(
      (exitState) => this.#handleOperationMutexExit(operationId, guard, exitState),
      (error) => this.#handleOperationMutexExit(operationId, guard, { code: null, signal: null, error }),
    );
    operation = this.persistedOperations.get(operationId);
    if (!operation) {
      throw new BridgeProtocolError('Le journal à protéger a disparu pendant l’acquisition du mutex.', 'OPERATION_JOURNAL_MISSING');
    }
    await this.#appendOperationEvent(operationId, {
      command: operation.command,
      status: operation.status,
      completionKind: operation.completionKind,
      createdAt: operation.createdAt,
      guardProcessId: durableGuardProcessId,
      recoveryWatcherProcessId: acquired.status === 'watching' ? acquired.processId : undefined,
      releaseNonce: operation.releaseNonce,
      updatedAt: new Date().toISOString(),
    });
    this.mutexRecoveryFailures.delete(operationId);
    return guard;
  }

  #handleOperationMutexExit(operationId, guard, exitState) {
    guard.exited = true;
    guard.exitState = exitState;
    if (this.operationMutexGuards.get(operationId) === guard) this.operationMutexGuards.delete(operationId);
    if (this.closing) return;
    if (this.operationRemovals.has(operationId)) return;
    if (!this.persistedOperations.has(operationId)) return;
    const pending = this.pending.get(operationId);
    if (pending) {
      const error = new BridgeProtocolError(
        'Le processus qui protégeait la commande InDesign s’est arrêté avant son acquittement; l’issue doit être réconciliée.',
        'INDESIGN_MUTEX_GUARD_LOST',
        { exitCode: Number.isInteger(exitState?.code) ? exitState.code : undefined },
      );
      this.#markOperationUnknown(operationId, pending, error);
    }
    void this.#recoverPersistedOperationGuard(operationId).catch((error) => {
      if (!this.persistedOperations.has(operationId)) return;
      this.mutexRecoveryFailures.set(operationId, {
        code: error?.code ?? 'INDESIGN_MUTEX_RECOVERY_FAILED',
        failedAt: new Date().toISOString(),
      });
    });
  }

  async #recoverPersistedOperationGuards() {
    if (this.persistedOperations.size > 1) {
      const missingGuardIdentity = [...this.persistedOperations.values()].some((operation) => !Number.isInteger(operation.guardProcessId));
      if (missingGuardIdentity) {
        throw new BridgeProtocolError(
          'Plusieurs journaux hérités sans identité de mutex ne peuvent pas être repris sans risque.',
          'MULTIPLE_OPERATION_GUARDS_UNSAFE',
        );
      }
    }
    await Promise.all([...this.persistedOperations.keys()].map((operationId) => this.#recoverPersistedOperationGuard(operationId)));
  }

  async #finishAcknowledgedOperations() {
    for (const [operationId, markerPath] of this.acknowledgedReleaseMarkers) {
      this.operationRemovals.add(operationId);
      try {
        const guard = await this.#recoverPersistedOperationGuard(operationId);
        if (guard) {
          const exitState = await this.#waitForOperationGuardExit(operationId, guard);
          if (exitState?.code !== 0) {
            throw new BridgeProtocolError('Le helper repris ne s’est pas arrêté proprement après son acquittement.', 'OPERATION_GUARD_RELEASE_FAILED');
          }
        }
        const recordPath = this.#operationRecordPath(operationId);
        if (recordPath) await fs.rm(recordPath, { force: true });
        await fs.rm(markerPath, { force: true });
        this.persistedOperations.delete(operationId);
        this.mutexRecoveryFailures.delete(operationId);
        this.acknowledgedReleaseMarkers.delete(operationId);
        this.operationRemovals.delete(operationId);
      } catch (error) {
        this.operationRemovals.add(operationId);
        throw error;
      }
    }
  }

  #recoverPersistedOperationGuard(operationId) {
    if (this.operationMutexGuards.has(operationId) || !this.persistedOperations.has(operationId)) {
      return Promise.resolve(this.operationMutexGuards.get(operationId));
    }
    const inProgress = this.mutexRecoveryOperations.get(operationId);
    if (inProgress) return inProgress;
    const recovery = (async () => {
      const persisted = this.persistedOperations.get(operationId);
      if (!persisted) return undefined;
      if (Number.isInteger(persisted.guardProcessId) && persisted.guardProcessId > 0) {
        try {
          return await this.#acquireOperationMutex(operationId, {
            expectedGuardProcessId: persisted.guardProcessId,
            recovery: true,
          });
        } catch (error) {
          if (this.operationMutexGuards.has(operationId)) throw error;
          if (!this.persistedOperations.has(operationId)) return undefined;
        }
      }
      return this.#acquireOperationMutex(operationId, { recovery: true });
    })();
    this.mutexRecoveryOperations.set(operationId, recovery);
    return recovery.finally(() => {
      if (this.mutexRecoveryOperations.get(operationId) === recovery) this.mutexRecoveryOperations.delete(operationId);
    });
  }

  #send(socket, message) {
    socket.send(JSON.stringify(message));
  }

  #markOperationUnknown(operationId, pending, sourceError) {
    clearTimeout(pending.timer);
    pending.timedOut = true;
    pending.disconnected = true;
    pending.uncertainAtMs ??= Date.now();
    if (pending.clientSettled) return;
    const error = new BridgeProtocolError(sourceError.message, sourceError.code, sourceError.details);
    error.operationId = operationId;
    error.requiresInspection = true;
    pending.clientSettled = true;
    pending.reject(error);
  }

  #markPendingUnknown(error) {
    for (const [operationId, pending] of this.pending) {
      if (!pending.sent) {
        clearTimeout(pending.timer);
        this.pending.delete(operationId);
        void this.#removeOperationRecord(operationId).catch(() => {});
        pending.reject(error);
        continue;
      }
      this.#markOperationUnknown(operationId, pending, error);
    }
  }

  async #validateReconciliationPaths({ scriptPath, completionPath, language }) {
    if (typeof scriptPath !== 'string' || !path.isAbsolute(scriptPath)) {
      throw new BridgeProtocolError('Le script privé de réconciliation doit être absolu.', 'RECONCILIATION_REQUEST_INVALID');
    }
    const scriptStat = await fs.lstat(scriptPath).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!scriptStat?.isFile() || scriptStat.isSymbolicLink()) {
      throw new BridgeProtocolError('Le script privé de réconciliation est invalide.', 'RECONCILIATION_REQUEST_INVALID');
    }
    if (completionPath === undefined) return;
    if (language !== 'UXP' || typeof completionPath !== 'string' || !path.isAbsolute(completionPath)) {
      throw new BridgeProtocolError('Le résultat asynchrone de réconciliation est invalide.', 'RECONCILIATION_REQUEST_INVALID');
    }
    const parentStat = await fs.lstat(path.dirname(completionPath)).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!parentStat?.isDirectory() || parentStat.isSymbolicLink()) {
      throw new BridgeProtocolError('Le dossier du résultat de réconciliation est invalide.', 'RECONCILIATION_REQUEST_INVALID');
    }
    const existing = await fs.lstat(completionPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (existing) {
      throw new BridgeProtocolError('Le résultat privé de réconciliation doit être absent avant l’exécution.', 'RECONCILIATION_REQUEST_INVALID');
    }
  }

  #reconciliationRequestPaths(operationId, requestId) {
    if (!this.operationDirectory || !OPERATION_ID_PATTERN.test(operationId) || !OPERATION_ID_PATTERN.test(requestId)) {
      throw new BridgeProtocolError('Les chemins privés de réconciliation sont invalides.', 'RECONCILIATION_REQUEST_INVALID');
    }
    const prefix = path.join(this.operationDirectory, `${operationId}.${requestId}.reconcile`);
    return {
      request: `${prefix}-request.json`,
      processing: `${prefix}-processing.json`,
      response: `${prefix}-response.json`,
    };
  }

  async #waitForReconciliationResponse({ operationId, requestId, responsePath, timeoutMs }) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const stat = await fs.lstat(responsePath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (stat) {
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > RECONCILIATION_RESPONSE_LIMIT) {
          throw new BridgeProtocolError('La réponse privée de réconciliation est invalide.', 'RECONCILIATION_RESPONSE_INVALID');
        }
        await this.protect(responsePath, { kind: 'file' });
        let response;
        try {
          response = JSON.parse(await fs.readFile(responsePath, 'utf8'));
        } catch {
          throw new BridgeProtocolError('La réponse privée de réconciliation est illisible.', 'RECONCILIATION_RESPONSE_INVALID');
        }
        if (
          response?.schemaVersion !== 1
          || response.operationId !== operationId
          || response.requestId !== requestId
          || typeof response.ok !== 'boolean'
        ) {
          throw new BridgeProtocolError('La réponse privée de réconciliation ne correspond pas à la demande.', 'RECONCILIATION_RESPONSE_INVALID');
        }
        return response;
      }
      const guard = this.operationMutexGuards.get(operationId);
      if (!guard || guard.exited) {
        const error = new BridgeProtocolError('Le helper du mutex a quitté avant la réponse de réconciliation.', 'RECONCILIATION_HELPER_DISCONNECTED');
        error.operationId = operationId;
        error.requiresInspection = true;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const error = new BridgeProtocolError('La requête privée de réconciliation a dépassé son délai.', 'RECONCILIATION_REQUEST_TIMEOUT');
    error.operationId = operationId;
    error.requiresInspection = true;
    throw error;
  }

  #operationRecordPath(operationId) {
    if (!this.operationDirectory || !OPERATION_ID_PATTERN.test(operationId ?? '')) return undefined;
    return path.join(this.operationDirectory, `${operationId}.jsonl`);
  }

  #releaseMarkerPath(operationId, releaseNonce) {
    if (
      !this.operationDirectory
      || !OPERATION_ID_PATTERN.test(operationId ?? '')
      || !RELEASE_NONCE_PATTERN.test(releaseNonce ?? '')
    ) return undefined;
    return path.join(this.operationDirectory, `${operationId}.${releaseNonce}.release.json`);
  }

  async #writeReleaseMarker(operationId, releaseNonce) {
    if (!RELEASE_NONCE_PATTERN.test(releaseNonce ?? '')) {
      throw new BridgeProtocolError('Le nonce privé d’acquittement est absent.', 'OPERATION_RELEASE_NONCE_INVALID');
    }
    const markerPath = this.#releaseMarkerPath(operationId, releaseNonce);
    if (!markerPath) throw new BridgeProtocolError('Le marqueur privé d’acquittement est invalide.', 'OPERATION_RELEASE_MARKER_INVALID');
    const existing = await fs.lstat(markerPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink() || existing.size <= 0 || existing.size > 8_192) {
        throw new BridgeProtocolError('Le marqueur privé d’acquittement existant est invalide.', 'OPERATION_RELEASE_MARKER_INVALID');
      }
      let marker;
      try { marker = JSON.parse(await fs.readFile(markerPath, 'utf8')); } catch {}
      if (marker?.schemaVersion !== 1 || marker.operationId !== operationId || marker.releaseNonce !== releaseNonce || marker.status !== 'acknowledged') {
        throw new BridgeProtocolError('Le marqueur privé d’acquittement ne correspond pas au journal.', 'OPERATION_RELEASE_MARKER_INVALID');
      }
      return markerPath;
    }
    const marker = {
      schemaVersion: 1,
      operationId,
      releaseNonce,
      status: 'acknowledged',
      acknowledgedAt: new Date().toISOString(),
    };
    const stagingPath = `${markerPath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(stagingPath, JSON.stringify(marker), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await this.protect(stagingPath, { kind: 'file' });
      await fs.rename(stagingPath, markerPath);
    } finally {
      await fs.rm(stagingPath, { force: true }).catch(() => {});
    }
    return markerPath;
  }

  async #initializeOperationJournal() {
    if (!this.operationDirectory) return;
    if (!path.isAbsolute(this.operationDirectory)) throw new BridgeProtocolError('Le journal privé des opérations doit être absolu.', 'OPERATION_JOURNAL_INVALID');
    await fs.mkdir(this.operationDirectory, { recursive: true, mode: 0o700 });
    const directoryStat = await fs.lstat(this.operationDirectory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new BridgeProtocolError('Le journal privé des opérations doit être un dossier normal.', 'OPERATION_JOURNAL_INVALID');
    }
    await this.protect(this.operationDirectory, { kind: 'directory', recursive: true });
    const entries = await fs.readdir(this.operationDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const match = entry.name.match(/^([0-9a-f-]{36})\.jsonl$/i);
      if (!match) continue;
      const operationId = match[1];
      if (!OPERATION_ID_PATTERN.test(operationId) || !entry.isFile() || entry.isSymbolicLink()) {
        throw new BridgeProtocolError('Le journal privé des opérations contient une entrée invalide.', 'OPERATION_JOURNAL_INVALID');
      }
      const recordPath = this.#operationRecordPath(operationId);
      const stat = await fs.lstat(recordPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536) {
        throw new BridgeProtocolError('Un historique privé d’opération est invalide.', 'OPERATION_JOURNAL_INVALID');
      }
      const records = (await fs.readFile(recordPath, 'utf8'))
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .filter((record) => record?.schemaVersion === 1 && record.operationId === operationId);
      const latest = records.at(-1);
      if (!latest || !validIdentity(latest.command, 128) || !['pending', 'completed-after-timeout'].includes(latest.status)) {
        throw new BridgeProtocolError('Un historique privé d’opération est illisible.', 'OPERATION_JOURNAL_INVALID');
      }
      if (latest.guardProcessId !== undefined && (!Number.isInteger(latest.guardProcessId) || latest.guardProcessId <= 0)) {
        throw new BridgeProtocolError('L’identité du helper dans le journal privé est invalide.', 'OPERATION_JOURNAL_INVALID');
      }
      if (latest.recoveryWatcherProcessId !== undefined && (!Number.isInteger(latest.recoveryWatcherProcessId) || latest.recoveryWatcherProcessId <= 0)) {
        throw new BridgeProtocolError('L’identité du watcher dans le journal privé est invalide.', 'OPERATION_JOURNAL_INVALID');
      }
      if (latest.releaseNonce !== undefined && !RELEASE_NONCE_PATTERN.test(latest.releaseNonce)) {
        throw new BridgeProtocolError('Le nonce d’acquittement du journal privé est invalide.', 'OPERATION_JOURNAL_INVALID');
      }
      const hostProcessesAtDispatch = latest.hostProcessesAtDispatch === undefined
        ? undefined
        : normalizeHostProcesses(latest.hostProcessesAtDispatch);
      if (latest.hostProcessesAtDispatch !== undefined && !hostProcessesAtDispatch) {
        throw new BridgeProtocolError('Les identités InDesign du journal privé sont invalides.', 'OPERATION_JOURNAL_INVALID');
      }
      const updatedAtMs = Date.parse(latest.updatedAt);
      if (!Number.isFinite(updatedAtMs)) throw new BridgeProtocolError('Un historique privé d’opération est daté de façon invalide.', 'OPERATION_JOURNAL_INVALID');
      this.persistedOperations.set(operationId, { ...latest, hostProcessesAtDispatch, updatedAtMs });
    }
    for (const entry of entries) {
      const match = entry.name.match(/^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})\.release\.json$/i);
      if (!match) continue;
      const [, operationId, releaseNonce] = match;
      const operation = this.persistedOperations.get(operationId);
      if (!operation || operation.releaseNonce !== releaseNonce) continue;
      const markerPath = this.#releaseMarkerPath(operationId, releaseNonce);
      const stat = await fs.lstat(markerPath);
      if (!entry.isFile() || entry.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 8_192) {
        throw new BridgeProtocolError('Un acquittement privé résiduel est invalide.', 'OPERATION_RELEASE_MARKER_INVALID');
      }
      await this.protect(markerPath, { kind: 'file' });
      let marker;
      try { marker = JSON.parse(await fs.readFile(markerPath, 'utf8')); } catch {}
      if (marker?.schemaVersion !== 1 || marker.operationId !== operationId || marker.releaseNonce !== releaseNonce || marker.status !== 'acknowledged') {
        throw new BridgeProtocolError('Un acquittement privé résiduel ne correspond pas à son journal.', 'OPERATION_RELEASE_MARKER_INVALID');
      }
      this.acknowledgedReleaseMarkers.set(operationId, markerPath);
    }
  }

  async #appendOperationEvent(operationId, record) {
    const recordPath = this.#operationRecordPath(operationId);
    if (!recordPath) return;
    const updatedAt = record.updatedAt ?? new Date().toISOString();
    const previous = this.persistedOperations.get(operationId);
    const requestedHostProcesses = record.hostProcessesAtDispatch !== undefined
      ? record.hostProcessesAtDispatch
      : previous?.hostProcessesAtDispatch;
    const hostProcessesAtDispatch = requestedHostProcesses === undefined
      ? undefined
      : normalizeHostProcesses(requestedHostProcesses);
    if (requestedHostProcesses !== undefined && !hostProcessesAtDispatch) {
      throw new BridgeProtocolError('Identités du processus InDesign invalides.', 'OPERATION_JOURNAL_INVALID');
    }
    const recoveryWatcherProcessId = Object.hasOwn(record, 'recoveryWatcherProcessId')
      ? record.recoveryWatcherProcessId
      : previous?.recoveryWatcherProcessId;
    const persisted = {
      schemaVersion: 1,
      operationId,
      command: record.command,
      status: record.status,
      completionKind: record.completionKind,
      guardProcessId: record.guardProcessId ?? previous?.guardProcessId,
      recoveryWatcherProcessId,
      releaseNonce: record.releaseNonce ?? previous?.releaseNonce,
      hostProcessesAtDispatch,
      createdAt: record.createdAt ?? previous?.createdAt,
      updatedAt,
    };
    if (!validIdentity(persisted.command, 128) || !['pending', 'completed-after-timeout'].includes(persisted.status)) {
      throw new BridgeProtocolError('Métadonnées du journal d’opération invalides.', 'OPERATION_JOURNAL_INVALID');
    }
    if (persisted.guardProcessId !== undefined && (!Number.isInteger(persisted.guardProcessId) || persisted.guardProcessId <= 0)) {
      throw new BridgeProtocolError('Identité du helper de mutex invalide.', 'OPERATION_JOURNAL_INVALID');
    }
    if (persisted.recoveryWatcherProcessId !== undefined && (!Number.isInteger(persisted.recoveryWatcherProcessId) || persisted.recoveryWatcherProcessId <= 0)) {
      throw new BridgeProtocolError('Identité du watcher de mutex invalide.', 'OPERATION_JOURNAL_INVALID');
    }
    if (persisted.releaseNonce !== undefined && !RELEASE_NONCE_PATTERN.test(persisted.releaseNonce)) {
      throw new BridgeProtocolError('Nonce privé d’acquittement invalide.', 'OPERATION_JOURNAL_INVALID');
    }
    const existing = await fs.lstat(recordPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.size > 65_536)) {
      throw new BridgeProtocolError('Le fichier privé d’opération est invalide.', 'OPERATION_JOURNAL_INVALID');
    }
    const handle = await fs.open(recordPath, 'a', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(persisted)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.protect(recordPath, { kind: 'file' });
    this.persistedOperations.set(operationId, { ...persisted, updatedAtMs: Date.parse(updatedAt) });
  }

  async #removeOperationRecord(operationId) {
    this.operationRemovals.add(operationId);
    let releaseSignaled = false;
    try {
      const operation = this.persistedOperations.get(operationId);
      const guard = this.operationMutexGuards.get(operationId);
      let markerPath;
      if (guard && operation?.releaseNonce) {
        markerPath = await this.#writeReleaseMarker(operationId, operation.releaseNonce);
        releaseSignaled = true;
        const exitState = await this.#waitForOperationGuardExit(operationId, guard);
        if (exitState?.code !== 0) {
          throw new BridgeProtocolError('Le helper du mutex ne s’est pas arrêté proprement après acquittement.', 'OPERATION_GUARD_RELEASE_FAILED');
        }
      }
      const recordPath = this.#operationRecordPath(operationId);
      if (recordPath) await fs.rm(recordPath, { force: true });
      if (markerPath) await fs.rm(markerPath, { force: true });
      this.persistedOperations.delete(operationId);
      this.mutexRecoveryFailures.delete(operationId);
      this.operationRemovals.delete(operationId);
    } finally {
      if (!releaseSignaled) this.operationRemovals.delete(operationId);
    }
  }

  async #waitForOperationGuardExit(operationId, guard, timeoutMs = 10_000) {
    let timer;
    try {
      return await Promise.race([
        guard.exit,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new BridgeProtocolError('Le helper du mutex n’a pas confirmé sa sortie après acquittement.', 'OPERATION_GUARD_RELEASE_TIMEOUT');
            error.operationId = operationId;
            error.requiresInspection = true;
            reject(error);
          }, timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

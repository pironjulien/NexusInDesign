import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { randomNonce, safeEqual } from '../security/crypto.js';
import {
  SHARED_BRIDGE_ORIGIN,
  SHARED_BRIDGE_PATH,
  SHARED_BRIDGE_PROTOCOL,
  SHARED_BRIDGE_VERSION,
  sharedClientProof,
  sharedError,
  sharedServerProof,
  sharedSessionId,
  signSharedMessage,
  validSharedId,
  validSharedNonce,
  verifySharedMessage,
} from './SharedBridgeProtocol.js';

const RECONNECT_ATTEMPTS = 3;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function asOwnerStatus(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export class SharedInDesignBridgeClient {
  constructor({ config, secret, expectedOwnerPid, takeoverFactory } = {}) {
    this.config = config;
    this.secret = secret;
    this.expectedOwnerPid = expectedOwnerPid;
    this.takeoverFactory = takeoverFactory;
    this.delegate = undefined;
    this.socket = undefined;
    this.pending = new Map();
    this.operationContext = new AsyncLocalStorage();
    this.ownerStatus = {};
    this.ownerProcessId = undefined;
    this.sessionId = undefined;
    this.authenticated = false;
    this.closed = false;
    this.startPromise = undefined;
    this.everConnected = false;
  }

  async start() {
    if (this.delegate || (this.authenticated && this.socket?.readyState === WebSocket.OPEN)) return;
    if (this.startPromise) return this.startPromise;
    this.closed = false;
    const attempt = this.#connectWithRetry();
    this.startPromise = attempt;
    try {
      await attempt;
    } finally {
      if (this.startPromise === attempt) this.startPromise = undefined;
    }
  }

  async #connectWithRetry() {
    let lastError;
    for (let attempt = 0; attempt < RECONNECT_ATTEMPTS; attempt += 1) {
      try {
        await this.#connectOnce();
        return;
      } catch (error) {
        lastError = error;
        if (this.closed || attempt === RECONNECT_ATTEMPTS - 1) break;
        await delay(100 * (attempt + 1));
      }
    }
    const error = new Error('Le courtier InDesign propriétaire du port ne répond pas ou refuse l’authentification.');
    error.code = 'SHARED_BRIDGE_UNAVAILABLE';
    error.cause = lastError;
    throw error;
  }

  async #connectOnce() {
    const url = `ws://${this.config.host}:${this.config.port}${SHARED_BRIDGE_PATH}`;
    const socket = new WebSocket(url, SHARED_BRIDGE_PROTOCOL, {
      origin: SHARED_BRIDGE_ORIGIN,
      perMessageDeflate: false,
      maxPayload: this.config.maxPayloadBytes,
      handshakeTimeout: this.config.authenticationTimeoutMs,
    });
    this.socket = socket;
    this.authenticated = false;
    this.sessionId = undefined;

    await new Promise((resolve, reject) => {
      let settled = false;
      let serverNonce;
      let clientNonce;
      const timer = setTimeout(() => fail(new Error('Délai d’authentification du courtier dépassé.')), this.config.authenticationTimeoutMs);
      timer.unref?.();
      const cleanupHandshake = () => clearTimeout(timer);
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanupHandshake();
        try { socket.close(); } catch {}
        reject(error);
      };
      socket.once('error', fail);
      socket.once('close', () => fail(new Error('Le courtier a fermé la connexion pendant l’authentification.')));
      socket.on('message', (data, isBinary) => {
        if (settled || isBinary) return;
        let message;
        try { message = JSON.parse(data.toString()); } catch { fail(new Error('Réponse JSON du courtier invalide.')); return; }
        if (message.type === 'peer_challenge') {
          if (message.version !== SHARED_BRIDGE_VERSION || !validSharedNonce(message.serverNonce)) {
            fail(new Error('Challenge du courtier invalide.'));
            return;
          }
          serverNonce = message.serverNonce;
          clientNonce = randomNonce();
          socket.send(JSON.stringify({
            type: 'peer_auth',
            version: SHARED_BRIDGE_VERSION,
            clientNonce,
            proof: sharedClientProof(this.secret, serverNonce, clientNonce),
          }));
          return;
        }
        if (message.type !== 'peer_auth_ok' || !serverNonce || !clientNonce) return;
        if (
          message.version !== SHARED_BRIDGE_VERSION
          || !safeEqual(message.proof, sharedServerProof(this.secret, serverNonce, clientNonce))
          || !Number.isInteger(message.ownerProcessId)
          || message.ownerProcessId <= 0
          || (Number.isInteger(this.expectedOwnerPid) && message.ownerProcessId !== this.expectedOwnerPid)
        ) {
          fail(new Error('Preuve mutuelle ou identité du courtier invalide.'));
          return;
        }
        settled = true;
        cleanupHandshake();
        socket.removeListener('error', fail);
        this.sessionId = sharedSessionId(this.secret, serverNonce, clientNonce);
        this.ownerProcessId = message.ownerProcessId;
        this.ownerStatus = asOwnerStatus(message.status);
        this.authenticated = true;
        this.everConnected = true;
        this.expectedOwnerPid = undefined;
        socket.removeAllListeners('message');
        socket.on('message', (nextData, binary) => this.#onMessage(nextData, binary));
        socket.once('close', () => this.#onDisconnect('SHARED_BRIDGE_DISCONNECTED'));
        socket.once('error', () => this.#onDisconnect('SHARED_BRIDGE_DISCONNECTED'));
        resolve();
      });
    });
  }

  status() {
    if (this.delegate) return this.delegate.status();
    const connected = this.authenticated && this.socket?.readyState === WebSocket.OPEN;
    return {
      ...this.ownerStatus,
      available: connected && this.ownerStatus.available !== false,
      listening: false,
      sharedConnection: true,
      brokerRole: 'client',
      brokerConnected: connected,
      brokerOwnerPid: this.ownerProcessId,
      connected: connected && this.ownerStatus.connected === true,
      authenticated: connected && this.ownerStatus.authenticated === true,
      port: this.config.port,
    };
  }

  async refreshStatus() {
    if (this.delegate) return typeof this.delegate.refreshStatus === 'function'
      ? this.delegate.refreshStatus()
      : this.delegate.status();
    this.ownerStatus = asOwnerStatus(await this.#request('status', {}));
    return this.status();
  }

  withOperationId(operationId, operation) {
    if (!validSharedId(operationId) || typeof operation !== 'function') {
      const error = new Error('Le contexte partagé InDesign est invalide.');
      error.code = 'OPERATION_CONTEXT_INVALID';
      throw error;
    }
    return this.operationContext.run(operationId, operation);
  }

  async execute(command) {
    const operationId = this.operationContext.getStore() ?? randomUUID();
    try {
      if (this.delegate) return await this.delegate.withOperationId(operationId, () => this.delegate.execute(command));
      return await this.#request('execute', { operationId, command }, { operationId, requiresInspectionOnTimeout: true });
    } catch (error) {
      error.operationId ??= operationId;
      throw error;
    }
  }

  operationStatus(operationId) {
    if (this.delegate) return this.delegate.operationStatus(operationId);
    return this.#request('operationStatus', { operationId });
  }

  acknowledgeOperation(operationId) {
    if (this.delegate) return this.delegate.acknowledgeOperation(operationId);
    return this.#request('acknowledgeOperation', { operationId });
  }

  runOperationReconciliation(options) {
    if (this.delegate) return this.delegate.runOperationReconciliation(options);
    const timeoutMs = Math.max(this.config.commandTimeoutMs + 15_000, Number(options?.completionTimeoutMs) + 20_000 || 0);
    return this.#request('runOperationReconciliation', options, { timeoutMs, operationId: options?.operationId, requiresInspectionOnTimeout: true });
  }

  openPairingWindow(options) {
    if (this.delegate) return this.delegate.openPairingWindow(options);
    return this.#request('openPairingWindow', options);
  }

  armPairingClipboard() {
    if (this.delegate) return this.delegate.armPairingClipboard();
    return this.#request('armPairingClipboard', {});
  }

  async close() {
    this.closed = true;
    this.authenticated = false;
    this.sessionId = undefined;
    const delegate = this.delegate;
    this.delegate = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'client_shutdown');
    this.#rejectPending('SHARED_BRIDGE_CLOSED');
    await delegate?.close?.();
  }

  async #ensureConnected() {
    if (this.delegate || (this.authenticated && this.socket?.readyState === WebSocket.OPEN)) return;
    try {
      await this.start();
      return;
    } catch (connectionError) {
      if (!this.everConnected || typeof this.takeoverFactory !== 'function' || this.closed) throw connectionError;
    }
    let candidate;
    try {
      candidate = this.takeoverFactory();
      await candidate.start();
      this.delegate = candidate;
      this.ownerStatus = {};
      this.ownerProcessId = process.pid;
      return;
    } catch (takeoverError) {
      await Promise.resolve(candidate?.close?.()).catch(() => {});
      if (takeoverError?.code !== 'EADDRINUSE') throw takeoverError;
    }
    await delay(150);
    await this.start();
  }

  async #request(method, params, options = {}) {
    await this.#ensureConnected();
    if (this.delegate) return this.#requestViaDelegate(method, params);
    const id = randomUUID();
    const nonce = randomNonce();
    const envelope = JSON.parse(JSON.stringify({ type: 'peer_request', id, nonce, method, params: params ?? {} }));
    envelope.proof = signSharedMessage(this.secret, this.sessionId, envelope, 'request');
    const timeoutMs = options.timeoutMs ?? (this.config.commandTimeoutMs + 15_000);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Délai dépassé pour la commande partagée ${method}.`);
        error.code = 'SHARED_BRIDGE_TIMEOUT';
        if (options.operationId) error.operationId = options.operationId;
        if (options.requiresInspectionOnTimeout) error.requiresInspection = true;
        reject(error);
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        operationId: options.operationId,
        requiresInspection: options.requiresInspectionOnTimeout === true,
      });
      try {
        this.socket.send(JSON.stringify(envelope), (sendError) => {
          if (!sendError) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          clearTimeout(pending.timer);
          const error = new Error('L’envoi au courtier InDesign a échoué.');
          error.code = 'SHARED_BRIDGE_SEND_FAILED';
          if (options.operationId) error.operationId = options.operationId;
          if (options.requiresInspectionOnTimeout) error.requiresInspection = true;
          pending.reject(error);
        });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  #requestViaDelegate(method, params) {
    if (method === 'status') return this.delegate.status();
    if (method === 'execute') return this.delegate.withOperationId(params.operationId, () => this.delegate.execute(params.command));
    if (method === 'operationStatus') return this.delegate.operationStatus(params.operationId);
    if (method === 'acknowledgeOperation') return this.delegate.acknowledgeOperation(params.operationId);
    if (method === 'runOperationReconciliation') return this.delegate.runOperationReconciliation(params);
    if (method === 'openPairingWindow') return this.delegate.openPairingWindow(params);
    if (method === 'armPairingClipboard') return this.delegate.armPairingClipboard();
    const error = new Error('Méthode de reprise InDesign interdite.');
    error.code = 'SHARED_BRIDGE_METHOD_FORBIDDEN';
    throw error;
  }

  #onMessage(data, isBinary) {
    if (isBinary || !this.authenticated || !this.sessionId) return;
    let message;
    try { message = JSON.parse(data.toString()); } catch { this.#onDisconnect('SHARED_BRIDGE_PROTOCOL_ERROR'); return; }
    if (message.type === 'peer_status') {
      if (!verifySharedMessage(this.secret, this.sessionId, message, 'response')) return;
      this.ownerStatus = asOwnerStatus(message.result);
      return;
    }
    if (message.type !== 'peer_response' || !validSharedId(message.id)) return;
    if (!verifySharedMessage(this.secret, this.sessionId, message, 'response')) {
      this.#onDisconnect('SHARED_BRIDGE_PROTOCOL_ERROR');
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok === true) {
      if (message.ownerStatus) this.ownerStatus = asOwnerStatus(message.ownerStatus);
      pending.resolve(message.result);
    } else {
      pending.reject(sharedError(message.error));
    }
  }

  #onDisconnect(code) {
    if (!this.authenticated && !this.socket) return;
    this.authenticated = false;
    this.sessionId = undefined;
    this.socket = undefined;
    this.#rejectPending(code);
  }

  #rejectPending(code) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      const error = new Error('La connexion au courtier InDesign a été interrompue.');
      error.code = code;
      if (pending.operationId) error.operationId = pending.operationId;
      if (pending.requiresInspection) error.requiresInspection = true;
      pending.reject(error);
    }
    this.pending.clear();
  }
}

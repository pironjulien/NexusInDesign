import { hmac, safeEqual, stableJson } from '../security/crypto.js';

export const SHARED_BRIDGE_PATH = '/codex-peer-v1';
export const SHARED_BRIDGE_PROTOCOL = 'indesign-mcp-peer-v1';
export const SHARED_BRIDGE_ORIGIN = 'http://127.0.0.1';
export const SHARED_BRIDGE_VERSION = 1;

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

export function isSharedBridgeRequest(request) {
  const protocol = String(request.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((value) => value.trim());
  return request.url === SHARED_BRIDGE_PATH
    && request.headers.origin === SHARED_BRIDGE_ORIGIN
    && protocol.includes(SHARED_BRIDGE_PROTOCOL);
}

export function validSharedId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

export function validSharedNonce(value) {
  return typeof value === 'string' && NONCE_PATTERN.test(value);
}

export function assertSafeSharedJson(value, depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (budget.nodes > 20_000 || depth > 32) throw new Error('Charge JSON partagée trop complexe.');
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) assertSafeSharedJson(item, depth + 1, budget);
    return;
  }
  if (!value || typeof value !== 'object') throw new Error('Type JSON partagé invalide.');
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Clé JSON partagée interdite.');
    assertSafeSharedJson(item, depth + 1, budget);
  }
}

export function sharedClientProof(secret, serverNonce, clientNonce) {
  return hmac(secret, `shared-client:${SHARED_BRIDGE_VERSION}:${serverNonce}:${clientNonce}`);
}

export function sharedServerProof(secret, serverNonce, clientNonce) {
  return hmac(secret, `shared-server:${SHARED_BRIDGE_VERSION}:${serverNonce}:${clientNonce}`);
}

function canonicalMessage(message) {
  return stableJson({
    id: message.id,
    nonce: message.nonce,
    method: message.method ?? null,
    params: message.params ?? null,
    ok: message.ok ?? null,
    result: message.result ?? null,
    error: message.error ?? null,
    ownerStatus: message.ownerStatus ?? null,
  });
}

export function signSharedMessage(secret, sessionId, message, direction) {
  return hmac(secret, `shared-${direction}:${SHARED_BRIDGE_VERSION}:${sessionId}:${canonicalMessage(message)}`);
}

export function verifySharedMessage(secret, sessionId, message, direction) {
  return safeEqual(message?.proof, signSharedMessage(secret, sessionId, message, direction));
}

export function sharedSessionId(secret, serverNonce, clientNonce) {
  return hmac(secret, `shared-session:${SHARED_BRIDGE_VERSION}:${serverNonce}:${clientNonce}`);
}

export function publicSharedError(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'SHARED_BRIDGE_ERROR',
    message: error instanceof Error ? error.message : String(error),
    ...(error?.details !== undefined ? { details: error.details } : {}),
    ...(typeof error?.operationId === 'string' ? { operationId: error.operationId } : {}),
    ...(error?.requiresInspection === true ? { requiresInspection: true } : {}),
    ...(Array.isArray(error?.documentStates) ? { documentStates: error.documentStates } : {}),
  };
}

export function sharedError(payload) {
  const error = new Error(typeof payload?.message === 'string' ? payload.message : 'Erreur du courtier InDesign.');
  error.code = typeof payload?.code === 'string' ? payload.code : 'SHARED_BRIDGE_ERROR';
  if (payload?.details !== undefined) error.details = payload.details;
  if (typeof payload?.operationId === 'string') error.operationId = payload.operationId;
  if (payload?.requiresInspection === true) error.requiresInspection = true;
  if (Array.isArray(payload?.documentStates)) error.documentStates = payload.documentStates;
  return error;
}

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function randomNonce() {
  return randomBytes(32).toString('base64url');
}

export function hmac(secret, value) {
  return createHmac('sha256', secret).update(value, 'utf8').digest('hex');
}

export function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

export function commandSignature(secret, envelope) {
  const canonical = stableJson({
    id: envelope.id,
    command: envelope.command,
    documentId: envelope.documentId ?? null,
    expectedRevision: envelope.expectedRevision ?? null,
    expectedStateToken: envelope.expectedStateToken ?? null,
    nonce: envelope.nonce,
    args: envelope.args ?? {},
  });
  return hmac(secret, `command:${envelope.sessionChallenge}:${canonical}`);
}

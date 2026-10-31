import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertSafeSharedJson,
  sharedSessionId,
  signSharedMessage,
  verifySharedMessage,
} from '../src/bridge/SharedBridgeProtocol.js';

test('la session et chaque message du courtier sont liés au secret et à leur direction', () => {
  const session = sharedSessionId('secret-a', 'a'.repeat(43), 'b'.repeat(43));
  assert.notEqual(session, sharedSessionId('secret-b', 'a'.repeat(43), 'b'.repeat(43)));
  const message = {
    type: 'peer_request',
    id: 'e63d90c7-a25b-41f8-a1d1-b63d9b62d36f',
    nonce: 'c'.repeat(43),
    method: 'status',
    params: {},
  };
  message.proof = signSharedMessage('secret-a', session, message, 'request');
  assert.equal(verifySharedMessage('secret-a', session, message, 'request'), true);
  assert.equal(verifySharedMessage('secret-a', session, message, 'response'), false);
  assert.equal(verifySharedMessage('secret-b', session, message, 'request'), false);
  assert.equal(verifySharedMessage('secret-a', session, { ...message, method: 'execute' }, 'request'), false);
});

test('le protocole refuse les clés dangereuses, les nombres non finis et les charges trop profondes', () => {
  assert.throws(() => assertSafeSharedJson(JSON.parse('{"constructor":{"prototype":{}}}')));
  assert.throws(() => assertSafeSharedJson({ value: Number.POSITIVE_INFINITY }));
  let value = {};
  for (let depth = 0; depth < 34; depth += 1) value = { next: value };
  assert.throws(() => assertSafeSharedJson(value));
});

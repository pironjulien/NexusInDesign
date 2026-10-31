import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeSharedCodexPeer } from '../src/security/SharedPeerPolicy.js';

test('le client du courtier doit appartenir à une chaîne Codex signée autorisée', async () => {
  let verifiedPid;
  const result = await authorizeSharedCodexPeer({
    host: '127.0.0.1',
    serverPort: 33171,
    clientPort: 53100,
    allowedPaths: ['C:\\Program Files\\WindowsApps'],
    allowedSigners: ['OpenAI OpCo, LLC'],
    platform: 'win32',
    ownerLookup: async () => 48212,
    verifyParent: async (options) => {
      verifiedPid = options.parentPid;
      return { verified: true, processId: 41000 };
    },
  });
  assert.equal(verifiedPid, 48212);
  assert.deepEqual(result, { verified: true, processId: 48212, codexProcessId: 41000 });
});

test('le courtier refuse un PID introuvable, une chaîne non vérifiée et une plateforme non prise en charge', async () => {
  const base = {
    host: '127.0.0.1',
    serverPort: 33171,
    clientPort: 53100,
    allowedPaths: ['C:\\Program Files\\WindowsApps'],
    allowedSigners: ['OpenAI OpCo, LLC'],
    platform: 'win32',
  };
  await assert.rejects(authorizeSharedCodexPeer({ ...base, ownerLookup: async () => undefined }));
  await assert.rejects(authorizeSharedCodexPeer({
    ...base,
    ownerLookup: async () => 48212,
    verifyParent: async () => ({ verified: false }),
  }));
  await assert.rejects(authorizeSharedCodexPeer({ ...base, platform: 'linux' }));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bridgeUnavailableStatus,
  diagnoseBridgeStartupError,
  findWindowsTcpListenerOwnerPid,
  parseWindowsNetstatConnectionOwner,
  parseWindowsNetstatListenerOwner,
} from '../src/bridge/BridgeDiagnostics.js';

test('le parseur netstat identifie uniquement le listener Windows du port demandé', () => {
  const output = `
  TCP    127.0.0.1:33171      0.0.0.0:0          LISTENING       36760
  TCP    127.0.0.1:33171      127.0.0.1:53100    ESTABLISHED     99999
  TCP    127.0.0.1:33171      0.0.0.0:0          BOUND           88888
  TCP    127.0.0.1:33172      0.0.0.0:0          LISTENING       12345
`;
  assert.equal(parseWindowsNetstatListenerOwner(output, { host: '127.0.0.1', port: 33171 }), 36760);
  assert.equal(parseWindowsNetstatListenerOwner(output, { host: '127.0.0.1', port: 33173 }), undefined);
});

test('le parseur netstat retrouve uniquement le PID du côté client de la connexion', () => {
  const output = `
  TCP    127.0.0.1:33171      127.0.0.1:53100    ESTABLISHED     36760
  TCP    127.0.0.1:53100      127.0.0.1:33171    ESTABLISHED     48212
  TCP    127.0.0.1:53101      127.0.0.1:33171    ESTABLISHED     77777
  `;
  assert.equal(parseWindowsNetstatConnectionOwner(output, {
    host: '127.0.0.1',
    serverPort: 33171,
    clientPort: 53100,
  }), 48212);
  assert.equal(parseWindowsNetstatConnectionOwner(output, {
    host: '127.0.0.1',
    serverPort: 33171,
    clientPort: 53102,
  }), undefined);
});

test('la recherche du PID reste facultative et sans dépendance sur les autres plateformes', async () => {
  let invoked = false;
  const ownerPid = await findWindowsTcpListenerOwnerPid({
    host: '127.0.0.1',
    port: 33171,
    platform: 'linux',
    execFileImpl: () => { invoked = true; },
  });
  assert.equal(ownerPid, undefined);
  assert.equal(invoked, false);
});

test('EADDRINUSE produit un état indisponible sans inventer l’état de la session distante', async () => {
  const diagnostic = await diagnoseBridgeStartupError(
    Object.assign(new Error('détail interne'), { code: 'EADDRINUSE' }),
    { host: '127.0.0.1', port: 33171, ownerLookup: async () => 45678 },
  );
  const status = bridgeUnavailableStatus(diagnostic);
  assert.deepEqual(diagnostic, {
    code: 'EADDRINUSE',
    reason: 'EADDRINUSE',
    port: 33171,
    listenerOwnerPid: 45678,
  });
  assert.equal(status.available, false);
  assert.equal(status.listenerOwnedByThisInstance, false);
  assert.equal(status.ownsPluginSession, false);
  assert.equal('connected' in status, false);
  assert.equal('authenticated' in status, false);
});

test('un échec du diagnostic PID ne masque jamais EADDRINUSE', async () => {
  const diagnostic = await diagnoseBridgeStartupError(
    Object.assign(new Error('port occupé'), { code: 'EADDRINUSE' }),
    { host: '127.0.0.1', port: 33171, ownerLookup: async () => { throw new Error('netstat indisponible'); } },
  );
  assert.deepEqual(diagnostic, { code: 'EADDRINUSE', reason: 'EADDRINUSE', port: 33171 });
});

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { WebSocket } from 'ws';
import { EXPECTED_UXP_ORIGIN, InDesignBridge } from '../src/bridge/InDesignBridge.js';
import { acquireWindowsNamedMutexGuard, INDESIGN_AUTOMATION_MUTEX } from '../src/bridge/WindowsNamedMutexGuard.js';
import { hmac } from '../src/security/crypto.js';
import { PACKAGE_VERSION } from '../src/version.js';

const HOST_BEFORE = { processId: 41_001, startedAt: '2026-07-15T08:00:00.000Z' };
const HOST_AFTER = { processId: 41_002, startedAt: '2026-07-15T08:01:00.000Z' };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function autoReleasingGuard(options, processId, status = 'acquired') {
  const exited = deferred();
  const operationId = path.basename(options.operationPath, '.jsonl');
  const markerPath = path.join(path.dirname(options.operationPath), `${operationId}.${options.releaseNonce}.release.json`);
  let checking = false;
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
      if (marker.operationId === operationId && marker.releaseNonce === options.releaseNonce && marker.status === 'acknowledged') {
        exited.resolve({ code: 0, signal: null });
      }
    } catch {}
    checking = false;
  }, 5);
  timer.unref?.();
  void exited.promise.finally(() => clearInterval(timer));
  return {
    guard: { processId, mutex: INDESIGN_AUTOMATION_MUTEX, status, exit: exited.promise },
    exited,
  };
}

function fakeMutexFactory() {
  const guards = [];
  const calls = [];
  let nextProcessId = 42;
  const factory = async (options) => {
    calls.push(options);
    const processId = nextProcessId;
    nextProcessId += 1;
    const created = autoReleasingGuard(options, processId);
    guards.push(created.exited);
    return created.guard;
  };
  return { factory, guards, calls };
}

function lastJsonlRecord(raw) {
  return JSON.parse(raw.trim().split(/\r?\n/).at(-1));
}

async function waitForMatchingFile(directory, pattern, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = (await fs.readdir(directory)).find((name) => pattern.test(name));
    if (match) return path.join(directory, match);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Fichier privé attendu absent dans ${path.basename(directory)}.`);
}

async function waitForOperationStatus(bridge, operationId, expectedStatus, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let status;
  while (Date.now() < deadline) {
    status = bridge.operationStatus(operationId);
    if (status.status === expectedStatus) return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Statut ${expectedStatus} absent pour l’opération ${operationId}; dernier statut: ${status?.status}.`);
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => resolve(JSON.parse(data.toString())));
    socket.once('error', reject);
  });
}

function rejectedHandshake(url, options) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    const timer = setTimeout(() => reject(new Error('Le handshake hostile n’a pas été refusé.')), 2_000);
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      response.resume();
      resolve(response.statusCode);
    });
    socket.once('open', () => {
      clearTimeout(timer);
      socket.terminate();
      reject(new Error('Le handshake hostile a été accepté.'));
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function connectAuthenticated(bridge, secret, pluginNonce = 'n'.repeat(48)) {
  const socket = new WebSocket(`ws://127.0.0.1:${bridge.address().port}`, { origin: EXPECTED_UXP_ORIGIN });
  const challengePromise = nextMessage(socket);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const challenge = await challengePromise;
  const pluginId = 'fr.pironjulien.indesign.mcp';
  const version = PACKAGE_VERSION;
  const authenticated = nextMessage(socket);
  socket.send(JSON.stringify({
    type: 'auth_proof', pluginId, version, nonce: challenge.nonce, pluginNonce,
    proof: hmac(secret, `plugin:${challenge.nonce}:${pluginNonce}:${pluginId}:${version}`),
  }));
  assert.equal((await authenticated).type, 'auth_ok');
  return socket;
}

test('un échec EADDRINUSE ne laisse jamais croire que cette instance écoute', async (t) => {
  const baseConfig = {
    host: '127.0.0.1',
    pairing: false,
    pairingWindowMs: 5_000,
    authenticationTimeoutMs: 5_000,
    commandTimeoutMs: 1_000,
    maxQueueLength: 10,
    maxPayloadBytes: 64 * 1024,
  };
  const owner = new InDesignBridge({ secret: 'owner-secret', config: { ...baseConfig, port: 0 } });
  await owner.start();
  t.after(() => owner.close());

  const competingRuntime = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-secondary-runtime-'));
  const untouchedJournal = path.join(competingRuntime, '12345678-1234-4123-8123-123456789abc.jsonl');
  await fs.writeFile(untouchedJournal, 'journal volontairement invalide\n');
  t.after(() => fs.rm(competingRuntime, { recursive: true, force: true }));

  const competing = new InDesignBridge({
    secret: 'competing-secret',
    config: { ...baseConfig, port: owner.address().port },
    operationDirectory: competingRuntime,
  });
  await assert.rejects(competing.start(), (error) => error.code === 'EADDRINUSE');
  assert.equal(await fs.readFile(untouchedJournal, 'utf8'), 'journal volontairement invalide\n');
  assert.equal(competing.address(), undefined);
  assert.equal(competing.status().listening, false);
  await competing.close();
});

test('une erreur listener après démarrage est absorbée et marque le bridge indisponible', async () => {
  const bridge = new InDesignBridge({
    secret: 'runtime-listener-secret',
    config: {
      host: '127.0.0.1',
      port: 0,
      pairing: false,
      pairingWindowMs: 5_000,
      authenticationTimeoutMs: 5_000,
      commandTimeoutMs: 1_000,
      maxQueueLength: 10,
      maxPayloadBytes: 64 * 1024,
    },
  });
  await bridge.start();
  const server = bridge.server;
  assert.equal(bridge.status().available, true);

  assert.doesNotThrow(() => server.emit('error', Object.assign(new Error('listener interrompu'), { code: 'EIO' })));
  assert.equal(bridge.address(), undefined);
  assert.deepEqual(bridge.status(), {
    available: false,
    listening: false,
    connected: false,
    authenticated: false,
    pluginId: undefined,
    pluginVersion: undefined,
    queueLength: 0,
    port: 0,
    pairingActive: false,
    reconcilableOperations: 0,
    persistedUnknownOperations: 0,
    code: 'EIO',
    reason: 'EIO',
    brokerRole: 'owner',
    sharedConnection: false,
    sharedClientCount: 0,
  });
  await bridge.close();
});

test('l’appairage exige le code temporaire hors canal avant d’envoyer le secret', async (t) => {
  const bridge = new InDesignBridge({
    secret: 'test-secret-ne-jamais-journaliser',
    config: { host: '127.0.0.1', port: 0, pairing: true, pairingWindowMs: 5_000, authenticationTimeoutMs: 5_000, commandTimeoutMs: 1_000, maxQueueLength: 10, maxPayloadBytes: 64 * 1024 },
  });
  await bridge.start();
  t.after(() => bridge.close());
  const opened = bridge.openPairingWindow({ windowSeconds: 30 });
  assert.match(opened.pairingCode, /^[A-F0-9]{4}(?:-[A-F0-9]{4}){3}$/);
  assert.equal(opened.pairingAttempts, 3);
  assert.equal('pairingCode' in bridge.status(), false);
  assert.equal('pairingCode' in bridge.pairingProof, false, 'le code en clair ne doit pas rester en mémoire côté bridge');
  assert.equal(Buffer.isBuffer(bridge.pairingProof.digest), true);
  const first = new WebSocket(`ws://127.0.0.1:${bridge.address().port}`, { origin: EXPECTED_UXP_ORIGIN });
  const challengePromise = nextMessage(first);
  await new Promise((resolve, reject) => { first.once('open', resolve); first.once('error', reject); });
  t.after(() => first.terminate());
  assert.equal((await challengePromise).type, 'auth_challenge');

  const pairingNonce = 'p'.repeat(48);
  const pairSecretPromise = nextMessage(first);
  first.send(JSON.stringify({
    type: 'pair_request',
    pluginId: 'fr.pironjulien.indesign.mcp',
    version: PACKAGE_VERSION,
    pairingNonce,
    pairingCode: opened.pairingCode,
  }));
  const pairSecret = await pairSecretPromise;
  assert.equal(pairSecret.type, 'pair_secret');
  assert.equal(pairSecret.pairingNonce, pairingNonce);
  assert.equal(pairSecret.secret, 'test-secret-ne-jamais-journaliser');

  const second = new WebSocket(`ws://127.0.0.1:${bridge.address().port}`, { origin: EXPECTED_UXP_ORIGIN });
  const close = new Promise((resolve) => second.once('close', (code) => resolve(code)));
  await new Promise((resolve, reject) => { second.once('open', resolve); second.once('error', reject); });
  assert.equal(await close, 1013);
});

test('le bridge arme une seule lecture de presse-papiers sans transmettre le code sur WebSocket', async (t) => {
  const secret = 'secret-appairage-automatique-ne-jamais-journaliser';
  const bridge = new InDesignBridge({
    secret,
    config: { host: '127.0.0.1', port: 0, pairing: false, pairingWindowMs: 5_000, authenticationTimeoutMs: 5_000, commandTimeoutMs: 1_000, maxQueueLength: 10, maxPayloadBytes: 64 * 1024 },
  });
  await bridge.start();
  t.after(() => bridge.close());
  const opened = bridge.openPairingWindow({ windowSeconds: 30 });
  const socket = new WebSocket(`ws://127.0.0.1:${bridge.address().port}`, { origin: EXPECTED_UXP_ORIGIN });
  const challengePromise = nextMessage(socket);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  t.after(() => socket.terminate());
  assert.equal((await challengePromise).type, 'auth_challenge');

  const signalPromise = nextMessage(socket);
  const armed = bridge.armPairingClipboard();
  assert.equal(armed.clipboardReadArmed, true);
  assert.equal(armed.clipboardSignalDelivered, true);
  assert.equal(armed.clipboardSignalsRemaining, 2);
  const signal = await signalPromise;
  assert.equal(signal.type, 'pairing_clipboard_ready');
  assert.match(signal.trigger, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(signal.pairingExpiresAt, opened.pairingExpiresAt);
  assert.equal(JSON.stringify(signal).includes(opened.pairingCode), false);
  assert.equal('pairingCode' in signal, false);

  const pairingNonce = 'a'.repeat(48);
  const secretPromise = nextMessage(socket);
  socket.send(JSON.stringify({
    type: 'pair_request',
    pluginId: 'fr.pironjulien.indesign.mcp',
    version: PACKAGE_VERSION,
    pairingNonce,
    pairingCode: opened.pairingCode,
  }));
  assert.deepEqual(await secretPromise, { type: 'pair_secret', secret, pairingNonce });
  assert.throws(
    () => bridge.armPairingClipboard(),
    (error) => error.code === 'PAIRING_DISABLED',
  );
});

test('l’instance propriétaire peut ouvrir l’appairage à chaud sans second listener', async (t) => {
  const secret = 'secret-ouverture-a-chaud-ne-jamais-journaliser';
  const bridge = new InDesignBridge({
    secret,
    config: { host: '127.0.0.1', port: 0, pairing: false, pairingWindowMs: 5_000, authenticationTimeoutMs: 5_000, commandTimeoutMs: 1_000, maxQueueLength: 10, maxPayloadBytes: 64 * 1024 },
  });
  await bridge.start();
  t.after(() => bridge.close());
  assert.equal(bridge.status().pairingActive, false);

  const opened = bridge.openPairingWindow({ windowSeconds: 30 });
  assert.equal(opened.pairingActive, true);
  assert.equal(opened.port, bridge.address().port);
  assert.match(opened.pairingExpiresAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(opened.pairingCode, /^[A-F0-9]{4}(?:-[A-F0-9]{4}){3}$/);
  assert.equal(bridge.status().pairingActive, true);
  assert.equal(bridge.status().pairingExpiresAt, opened.pairingExpiresAt);

  const socket = new WebSocket(`ws://127.0.0.1:${bridge.address().port}`, { origin: EXPECTED_UXP_ORIGIN });
  const challengePromise = nextMessage(socket);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  t.after(() => socket.terminate());
  assert.equal((await challengePromise).type, 'auth_challenge');

  const pairingNonce = 'q'.repeat(48);
  const pairSecretPromise = nextMessage(socket);
  socket.send(JSON.stringify({
    type: 'pair_request',
    pluginId: 'fr.pironjulien.indesign.mcp',
    version: PACKAGE_VERSION,
    pairingNonce,
    pairingCode: opened.pairingCode,
  }));
  assert.deepEqual(await pairSecretPromise, { type: 'pair_secret', secret, pairingNonce });
  assert.equal(bridge.status().pairingActive, false);
});

test('un code erroné est borné à trois essais puis la preuve est détruite', async (t) => {
  const bridge = new InDesignBridge({
    secret: 'secret-code-borne-ne-jamais-journaliser',
    config: { host: '127.0.0.1', port: 0, authenticationTimeoutMs: 5_000, commandTimeoutMs: 1_000, maxQueueLength: 10, maxPayloadBytes: 64 * 1024 },
  });
  await bridge.start();
  t.after(() => bridge.close());
  const opened = bridge.openPairingWindow({ windowSeconds: 30 });
  const compactCode = opened.pairingCode.replace(/-/g, '');
  const wrongPrefix = compactCode[0] === 'A' ? 'B' : 'A';
  const wrongCode = `${wrongPrefix}${compactCode.slice(1)}`;
  const secondWrongPrefix = compactCode[0] === 'C' ? 'D' : 'C';
  const secondWrongCode = `${secondWrongPrefix}${compactCode.slice(1)}`;

  const rejectCode = async (pairingCode) => {
    const socket = new WebSocket(`ws://127.0.0.1:${bridge.address().port}`, { origin: EXPECTED_UXP_ORIGIN });
    const challenge = nextMessage(socket);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    await challenge;
    const closed = new Promise((resolve) => socket.once('close', (code) => resolve(code)));
    socket.send(JSON.stringify({
      type: 'pair_request', pluginId: 'fr.pironjulien.indesign.mcp', version: PACKAGE_VERSION,
      pairingNonce: 'x'.repeat(48), pairingCode,
    }));
    assert.equal(await closed, 1008);
  };

  await rejectCode(wrongCode);
  assert.equal(bridge.status().pairingAttemptsRemaining, 2);
  await rejectCode(secondWrongCode);
  assert.equal(bridge.status().pairingAttemptsRemaining, 1);
  await rejectCode('code-mal-forme');
  assert.equal(bridge.status().pairingActive, false);
  assert.equal(bridge.pairingProof, undefined);
});

test('ouvrir une nouvelle fenêtre invalide le code précédent et l’expiration efface sa preuve', async (t) => {
  const bridge = new InDesignBridge({
    secret: 'secret-code-remplace-ne-jamais-journaliser',
    config: { host: '127.0.0.1', port: 0, authenticationTimeoutMs: 5_000, commandTimeoutMs: 1_000, maxQueueLength: 10, maxPayloadBytes: 64 * 1024 },
  });
  await bridge.start();
  t.after(() => bridge.close());
  const first = bridge.openPairingWindow({ windowSeconds: 30 });
  const second = bridge.openPairingWindow({ windowSeconds: 30 });
  assert.notEqual(first.pairingCode, second.pairingCode);

  const socket = new WebSocket(`ws://127.0.0.1:${bridge.address().port}`, { origin: EXPECTED_UXP_ORIGIN });
  const challenge = nextMessage(socket);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  await challenge;
  const closed = new Promise((resolve) => socket.once('close', (code) => resolve(code)));
  socket.send(JSON.stringify({
    type: 'pair_request', pluginId: 'fr.pironjulien.indesign.mcp', version: PACKAGE_VERSION,
    pairingNonce: 'y'.repeat(48), pairingCode: first.pairingCode,
  }));
  assert.equal(await closed, 1008);
  assert.equal(bridge.status().pairingAttemptsRemaining, 2);

  bridge.pairingDeadline = Date.now() - 1;
  assert.equal(bridge.status().pairingActive, false);
  assert.equal(bridge.pairingProof, undefined);
});

test('une instance sans listener ne peut jamais ouvrir l’appairage', () => {
  const bridge = new InDesignBridge({
    secret: 'secret-instance-sans-listener',
    config: { host: '127.0.0.1', port: 0, pairing: false, pairingWindowMs: 5_000, authenticationTimeoutMs: 5_000, commandTimeoutMs: 1_000, maxQueueLength: 10, maxPayloadBytes: 64 * 1024 },
  });
  assert.throws(
    () => bridge.openPairingWindow({ windowSeconds: 120 }),
    (error) => error.code === 'PAIRING_LISTENER_NOT_OWNED',
  );
});

test('le bridge refuse un navigateur hostile et une origine absente avant tout challenge', async (t) => {
  const bridge = new InDesignBridge({
    secret: 'test-secret-ne-jamais-journaliser',
    config: { host: '127.0.0.1', port: 0, pairing: true, pairingWindowMs: 5_000, authenticationTimeoutMs: 5_000, commandTimeoutMs: 1_000, maxQueueLength: 10, maxPayloadBytes: 64 * 1024 },
  });
  await bridge.start();
  t.after(() => bridge.close());
  bridge.openPairingWindow({ windowSeconds: 30 });
  const url = `ws://127.0.0.1:${bridge.address().port}`;
  assert.equal(await rejectedHandshake(url, { origin: 'https://evil.example' }), 403);
  assert.equal(await rejectedHandshake(url), 403);
  assert.equal(bridge.status().connected, false);
  assert.equal(bridge.status().pairingActive, true);
});

test('l’authentification refuse une preuve sans nonce propre au plugin', async (t) => {
  const secret = 'test-secret-ne-jamais-journaliser';
  const bridge = new InDesignBridge({
    secret,
    config: { host: '127.0.0.1', port: 0, pairing: false, pairingWindowMs: 5_000, authenticationTimeoutMs: 5_000, commandTimeoutMs: 1_000, maxQueueLength: 10, maxPayloadBytes: 64 * 1024 },
  });
  await bridge.start();
  t.after(() => bridge.close());

  const socket = new WebSocket(`ws://127.0.0.1:${bridge.address().port}`, { origin: EXPECTED_UXP_ORIGIN });
  const challengePromise = nextMessage(socket);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const challenge = await challengePromise;
  const pluginId = 'fr.pironjulien.indesign.mcp';
  const version = PACKAGE_VERSION;
  const closed = new Promise((resolve) => socket.once('close', (code) => resolve(code)));
  socket.send(JSON.stringify({
    type: 'auth_proof',
    pluginId,
    version,
    nonce: challenge.nonce,
    proof: hmac(secret, `plugin:${challenge.nonce}:${pluginId}:${version}`),
  }));
  assert.equal(await closed, 1008);
});

test('une réponse plugin tardive reste réconciliable après le délai', async (t) => {
  const secret = 'secret-local-de-test';
  const bridge = new InDesignBridge({
    secret,
    config: { host: '127.0.0.1', port: 0, pairing: false, pairingWindowMs: 5_000, authenticationTimeoutMs: 5_000, commandTimeoutMs: 40, maxQueueLength: 10, maxPayloadBytes: 64 * 1024 },
  });
  await bridge.start();
  t.after(() => bridge.close());
  const socket = new WebSocket(`ws://127.0.0.1:${bridge.address().port}`, { origin: EXPECTED_UXP_ORIGIN });
  const challengePromise = nextMessage(socket);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  t.after(() => socket.terminate());
  const challenge = await challengePromise;
  const pluginId = 'fr.pironjulien.indesign.mcp';
  const version = PACKAGE_VERSION;
  const pluginNonce = 'n'.repeat(48);
  const authenticated = nextMessage(socket);
  socket.send(JSON.stringify({
    type: 'auth_proof', pluginId, version, nonce: challenge.nonce, pluginNonce,
    proof: hmac(secret, `plugin:${challenge.nonce}:${pluginNonce}:${pluginId}:${version}`),
  }));
  assert.equal((await authenticated).type, 'auth_ok');

  const commandPromise = nextMessage(socket);
  const execution = bridge.execute({ command: 'set_document_preferences', documentId: 9, expectedRevision: 2, args: {} });
  const command = await commandPromise;
  let timeoutError;
  await assert.rejects(execution, (error) => {
    timeoutError = error;
    return error.code === 'COMMAND_TIMEOUT' && error.operationId === command.id && error.requiresInspection === true;
  });
  assert.equal(bridge.operationStatus(timeoutError.operationId).status, 'pending-after-timeout');
  socket.send(JSON.stringify({ type: 'result', id: command.id, result: { documentId: 9, revision: 3, changed: true } }));
  const completed = await waitForOperationStatus(bridge, timeoutError.operationId, 'completed');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.outcome.ok, true);
  assert.equal(completed.outcome.revision, 3);
  assert.equal(completed.requiresInspection, true);
});

test('une déconnexion après envoi conserve une issue inconnue réconciliable', async (t) => {
  const secret = 'secret-local-de-test';
  const bridge = new InDesignBridge({
    secret,
    config: { host: '127.0.0.1', port: 0, pairing: false, pairingWindowMs: 5_000, authenticationTimeoutMs: 5_000, commandTimeoutMs: 1_000, maxQueueLength: 10, maxPayloadBytes: 64 * 1024 },
  });
  await bridge.start();
  t.after(() => bridge.close());

  const first = await connectAuthenticated(bridge, secret);
  const commandPromise = nextMessage(first);
  const execution = bridge.execute({
    command: 'set_document_preferences',
    documentId: 12,
    expectedRevision: 4,
    args: { marker: 'contenu-qui-ne-doit-pas-etre-conserve-dans-le-statut' },
  });
  const command = await commandPromise;
  first.terminate();

  await assert.rejects(execution, (error) => (
    error.code === 'PLUGIN_DISCONNECTED'
    && error.operationId === command.id
    && error.requiresInspection === true
  ));
  const unknown = bridge.operationStatus(command.id);
  assert.deepEqual(unknown, {
    ok: true,
    operationId: command.id,
    status: 'pending-after-disconnect',
    command: 'set_document_preferences',
    requiresInspection: true,
  });
  assert.equal(JSON.stringify(unknown).includes('contenu-qui-ne-doit-pas-etre-conserve'), false);

  const second = await connectAuthenticated(bridge, secret, 'r'.repeat(48));
  t.after(() => second.terminate());
  second.send(JSON.stringify({ type: 'result', id: command.id, result: { documentId: 12, revision: 5, changed: true } }));
  const completed = await waitForOperationStatus(bridge, command.id, 'completed');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.outcome.ok, true);
  assert.equal(completed.outcome.revision, 5);
  assert.equal(completed.requiresInspection, true);
});

test('une issue plugin inconnue survit au redémarrage sans conserver les arguments', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-plugin-operations-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const secret = 'secret-local-de-test';
  const config = { host: '127.0.0.1', port: 0, pairing: false, pairingWindowMs: 5_000, authenticationTimeoutMs: 5_000, commandTimeoutMs: 1_000, maxQueueLength: 10, maxPayloadBytes: 64 * 1024 };
  const mutexes = fakeMutexFactory();
  const firstBridge = new InDesignBridge({
    secret,
    config,
    operationDirectory: directory,
    protect: async () => {},
    operationMutexFactory: mutexes.factory,
  });
  await firstBridge.start();
  const socket = await connectAuthenticated(firstBridge, secret);
  const commandPromise = nextMessage(socket);
  const execution = firstBridge.execute({
    command: 'set_document_preferences',
    documentId: 21,
    expectedRevision: 8,
    args: { confidentialMarker: 'contenu-confidentiel-interdit-dans-le-journal' },
  });
  const command = await commandPromise;
  socket.terminate();
  await assert.rejects(execution, (error) => error.operationId === command.id && error.requiresInspection === true);
  await firstBridge.close();

  const journal = await fs.readFile(path.join(directory, `${command.id}.jsonl`), 'utf8');
  assert.equal(journal.includes('contenu-confidentiel-interdit-dans-le-journal'), false);
  assert.equal(journal.includes(secret), false);

  const restarted = new InDesignBridge({
    secret,
    config,
    operationDirectory: directory,
    protect: async () => {},
    operationMutexFactory: mutexes.factory,
  });
  await restarted.start();
  t.after(() => restarted.close());
  assert.equal(mutexes.calls.length, 2);
  assert.equal(mutexes.calls[1].expectedGuardProcessId, 42);
  assert.equal(mutexes.calls[1].recovery, true);
  const recoveredJournal = await fs.readFile(path.join(directory, `${command.id}.jsonl`), 'utf8');
  assert.equal(lastJsonlRecord(recoveredJournal).guardProcessId, 43);
  assert.deepEqual(restarted.operationStatus(command.id), {
    ok: true,
    operationId: command.id,
    status: 'pending-after-restart',
    command: 'set_document_preferences',
    completionKind: undefined,
    updatedAt: lastJsonlRecord(recoveredJournal).updatedAt,
    persisted: true,
    requiresInspection: true,
  });
  await assert.rejects(
    restarted.execute({ command: 'get_document_info', args: {} }),
    (error) => error.code === 'PERSISTED_OPERATION_REQUIRES_RECONCILIATION'
      && error.requiresInspection === true
      && error.operationIds.includes(command.id),
  );
  assert.equal(await restarted.acknowledgeOperation(command.id), true);
  assert.equal(restarted.operationStatus(command.id).status, 'not-found');
  await assert.rejects(fs.access(path.join(directory, `${command.id}.jsonl`)));
  for (const guard of mutexes.guards) guard.resolve({ code: 0, signal: null });
});

test('un PID de helper périmé déclenche une réacquisition sûre au démarrage', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-plugin-stale-guard-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const operationId = '22222222-2222-4222-8222-222222222222';
  const operationPath = path.join(directory, `${operationId}.jsonl`);
  const now = new Date().toISOString();
  await fs.writeFile(operationPath, `${JSON.stringify({
    schemaVersion: 1,
    operationId,
    command: 'set_document_preferences',
    status: 'pending',
    guardProcessId: 987654,
    createdAt: now,
    updatedAt: now,
  })}\n`, { encoding: 'utf8', mode: 0o600 });
  const calls = [];
  let recoveredGuard;
  const bridge = new InDesignBridge({
    secret: 'secret-local-de-test',
    config: { host: '127.0.0.1', port: 0, pairing: false, pairingWindowMs: 5_000, authenticationTimeoutMs: 5_000, commandTimeoutMs: 1_000, maxQueueLength: 10, maxPayloadBytes: 64 * 1024 },
    operationDirectory: directory,
    protect: async () => {},
    operationMutexFactory: async (options) => {
      calls.push(options);
      if (options.expectedGuardProcessId !== undefined) {
        const error = new Error('PID périmé simulé');
        error.code = 'INDESIGN_MUTEX_GUARD_IDENTITY_INVALID';
        throw error;
      }
      recoveredGuard = autoReleasingGuard(options, 84);
      return recoveredGuard.guard;
    },
  });
  await bridge.start();
  t.after(() => bridge.close());
  assert.equal(calls.length, 2);
  assert.equal(calls[0].expectedGuardProcessId, 987654);
  assert.equal(calls[0].recovery, true);
  assert.equal(calls[1].expectedGuardProcessId, undefined);
  assert.equal(calls[1].recovery, true);
  assert.equal(lastJsonlRecord(await fs.readFile(operationPath, 'utf8')).guardProcessId, 84);
  assert.equal(await bridge.acknowledgeOperation(operationId), true);
  recoveredGuard.exited.resolve({ code: 0, signal: null });
});

test('un watcher de reprise conserve le PID du détenteur original dans le journal', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-plugin-watcher-identity-'));
  const operationId = '12345678-1234-4123-8123-123456789abc';
  const operationPath = path.join(directory, `${operationId}.jsonl`);
  const releaseNonce = 'w'.repeat(43);
  await fs.writeFile(operationPath, `${JSON.stringify({
    schemaVersion: 1,
    operationId,
    command: 'execute_uxp',
    status: 'pending',
    guardProcessId: 700,
    releaseNonce,
    hostProcessesAtDispatch: [HOST_BEFORE],
    createdAt: '2026-07-15T08:00:00.000Z',
    updatedAt: '2026-07-15T08:00:01.000Z',
  })}\n`);
  const watcherExit = deferred();
  const bridge = new InDesignBridge({
    secret: 'secret-local-de-test',
    config: { host: '127.0.0.1', port: 0, authenticationTimeoutMs: 5_000, commandTimeoutMs: 1_000, maxQueueLength: 10, maxPayloadBytes: 64 * 1024 },
    operationDirectory: directory,
    protect: async () => {},
    operationMutexFactory: async ({ expectedGuardProcessId, recovery }) => {
      assert.equal(expectedGuardProcessId, 700);
      assert.equal(recovery, true);
      return {
        processId: 701,
        guardedProcessId: 700,
        status: 'watching',
        mutex: INDESIGN_AUTOMATION_MUTEX,
        exit: watcherExit.promise,
      };
    },
  });
  await bridge.start();
  const latest = lastJsonlRecord(await fs.readFile(operationPath, 'utf8'));
  assert.equal(latest.guardProcessId, 700);
  assert.equal(latest.recoveryWatcherProcessId, 701);
  await bridge.close();
  watcherExit.resolve({ code: 0, signal: null });
  await fs.rm(directory, { recursive: true, force: true });
});

test('un mutex abandonné devient une issue inconnue durable sans envoyer la commande', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-plugin-abandoned-mutex-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const secret = 'secret-local-de-test';
  let abandonedGuard;
  const bridge = new InDesignBridge({
    secret,
    config: { host: '127.0.0.1', port: 0, pairing: false, pairingWindowMs: 5_000, authenticationTimeoutMs: 5_000, commandTimeoutMs: 1_000, maxQueueLength: 10, maxPayloadBytes: 64 * 1024 },
    operationDirectory: directory,
    protect: async () => {},
    operationMutexFactory: async (options) => {
      abandonedGuard = autoReleasingGuard(options, 91, 'abandoned');
      return abandonedGuard.guard;
    },
  });
  await bridge.start();
  t.after(() => bridge.close());
  const socket = await connectAuthenticated(bridge, secret);
  t.after(() => socket.terminate());
  let commandSeen = false;
  socket.on('message', () => { commandSeen = true; });

  let abandoned;
  await assert.rejects(
    bridge.execute({ command: 'get_document_info', documentId: 77, args: {} }),
    (error) => {
      abandoned = error;
      return error.code === 'INDESIGN_MUTEX_ABANDONED'
        && error.requiresInspection === true
        && /^[0-9a-f-]{36}$/i.test(error.operationId);
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(commandSeen, false);
  const operationPath = path.join(directory, `${abandoned.operationId}.jsonl`);
  await fs.access(operationPath);
  assert.equal(lastJsonlRecord(await fs.readFile(operationPath, 'utf8')).guardProcessId, 91);
  await assert.rejects(
    bridge.execute({ command: 'get_document_info', documentId: 77, args: {} }),
    (error) => error.code === 'PERSISTED_OPERATION_REQUIRES_RECONCILIATION',
  );
  assert.equal(await bridge.acknowledgeOperation(abandoned.operationId), true);
  abandonedGuard.exited.resolve({ code: 0, signal: null });
});

test('le bridge attend le handshake du mutex avant tout envoi WebSocket', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-plugin-mutex-handshake-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const secret = 'secret-local-de-test';
  const acquisition = deferred();
  const factoryCalled = deferred();
  let commandGuard;
  const bridge = new InDesignBridge({
    secret,
    config: { host: '127.0.0.1', port: 0, pairing: false, pairingWindowMs: 5_000, authenticationTimeoutMs: 5_000, commandTimeoutMs: 1_000, maxQueueLength: 10, maxPayloadBytes: 64 * 1024 },
    operationDirectory: directory,
    protect: async () => {},
    operationMutexFactory: async (options) => {
      factoryCalled.resolve(options);
      await acquisition.promise;
      commandGuard = autoReleasingGuard(options, 43);
      return commandGuard.guard;
    },
  });
  await bridge.start();
  t.after(() => bridge.close());
  const socket = await connectAuthenticated(bridge, secret);
  t.after(() => socket.terminate());

  let commandSeen = false;
  const commandPromise = nextMessage(socket).then((message) => {
    commandSeen = true;
    return message;
  });
  const expectedStateToken = 'a'.repeat(16);
  const execution = bridge.execute({ command: 'get_document_info', documentId: 31, expectedRevision: 2, expectedStateToken, args: {} });
  const { operationPath, timeoutMs } = await factoryCalled.promise;
  assert.equal(timeoutMs, 120_000);
  assert.match(path.basename(operationPath), /^[0-9a-f-]{36}\.jsonl$/i);
  assert.match(await fs.readFile(operationPath, 'utf8'), /"status":"pending"/);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(commandSeen, false);

  acquisition.resolve();
  const command = await commandPromise;
  assert.equal(command.expectedStateToken, expectedStateToken);
  socket.send(JSON.stringify({ type: 'result', id: command.id, result: { documentId: 31, revision: 2 } }));
  assert.equal((await execution).operationId, command.id);
  await assert.rejects(fs.access(operationPath));
  commandGuard.exited.resolve({ code: 0, signal: null });
});

test('un contexte externe réutilise le même UUID après nettoyage complet de chaque sous-commande', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-plugin-operation-context-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const secret = 'secret-local-de-test';
  const mutexes = fakeMutexFactory();
  const bridge = new InDesignBridge({
    secret,
    config: { host: '127.0.0.1', port: 0, pairing: false, pairingWindowMs: 5_000, authenticationTimeoutMs: 5_000, commandTimeoutMs: 1_000, maxQueueLength: 10, maxPayloadBytes: 64 * 1024 },
    operationDirectory: directory,
    protect: async () => {},
    operationMutexFactory: mutexes.factory,
  });
  await bridge.start();
  t.after(() => bridge.close());
  const socket = await connectAuthenticated(bridge, secret);
  t.after(() => socket.terminate());
  const operationId = '66666666-6666-4666-8666-666666666666';

  await bridge.withOperationId(operationId, async () => {
    const firstMessage = nextMessage(socket);
    const firstExecution = bridge.execute({ command: 'get_document_info', documentId: 66, args: {} });
    const first = await firstMessage;
    assert.equal(first.id, operationId);
    socket.send(JSON.stringify({ type: 'result', id: first.id, result: { documentId: 66, revision: 1 } }));
    assert.equal((await firstExecution).operationId, operationId);
    assert.equal(bridge.operationStatus(operationId).status, 'not-found');
    assert.equal((await fs.readdir(directory)).some((name) => name.startsWith(`${operationId}.`)), false);

    const secondMessage = nextMessage(socket);
    const secondExecution = bridge.execute({ command: 'get_document_info', documentId: 66, args: {} });
    const second = await secondMessage;
    assert.equal(second.id, operationId);
    socket.send(JSON.stringify({ type: 'result', id: second.id, result: { documentId: 66, revision: 2 } }));
    assert.equal((await secondExecution).operationId, operationId);
  });

  assert.equal(mutexes.calls.length, 2);
  assert.notEqual(mutexes.calls[0].releaseNonce, mutexes.calls[1].releaseNonce);
  assert.equal((await fs.readdir(directory)).some((name) => name.startsWith(`${operationId}.`)), false);
});

test('un ACK signé résiduel est terminé avant la reprise du bridge', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-plugin-residual-ack-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const operationId = '77777777-7777-4777-8777-777777777777';
  const releaseNonce = 'r'.repeat(43);
  const operationPath = path.join(directory, `${operationId}.jsonl`);
  const markerPath = path.join(directory, `${operationId}.${releaseNonce}.release.json`);
  const now = new Date().toISOString();
  await fs.writeFile(operationPath, `${JSON.stringify({
    schemaVersion: 1,
    operationId,
    command: 'set_document_preferences',
    status: 'pending',
    guardProcessId: 777,
    releaseNonce,
    createdAt: now,
    updatedAt: now,
  })}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.writeFile(markerPath, JSON.stringify({
    schemaVersion: 1,
    operationId,
    releaseNonce,
    status: 'acknowledged',
    acknowledgedAt: now,
  }), { encoding: 'utf8', mode: 0o600 });
  const calls = [];
  const bridge = new InDesignBridge({
    secret: 'secret-local-de-test',
    config: { host: '127.0.0.1', port: 0, pairing: false, pairingWindowMs: 5_000, authenticationTimeoutMs: 5_000, commandTimeoutMs: 1_000, maxQueueLength: 10, maxPayloadBytes: 64 * 1024 },
    operationDirectory: directory,
    protect: async () => {},
    operationMutexFactory: async (options) => {
      calls.push(options);
      return autoReleasingGuard(options, 778, 'watching').guard;
    },
  });
  await bridge.start();
  t.after(() => bridge.close());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].expectedGuardProcessId, 777);
  assert.equal(calls[0].recovery, true);
  assert.equal(calls[0].releaseNonce, releaseNonce);
  assert.equal(bridge.operationStatus(operationId).status, 'not-found');
  await assert.rejects(fs.access(operationPath));
  await assert.rejects(fs.access(markerPath));
});

test('un timeout conserve le mutex et bloque les commandes jusqu’à acquittement', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-plugin-mutex-timeout-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const secret = 'secret-local-de-test';
  const mutexes = fakeMutexFactory();
  const bridge = new InDesignBridge({
    secret,
    config: { host: '127.0.0.1', port: 0, pairing: false, pairingWindowMs: 5_000, authenticationTimeoutMs: 5_000, commandTimeoutMs: 40, maxQueueLength: 10, maxPayloadBytes: 64 * 1024 },
    operationDirectory: directory,
    protect: async () => {},
    operationMutexFactory: mutexes.factory,
  });
  await bridge.start();
  t.after(() => bridge.close());
  const socket = await connectAuthenticated(bridge, secret);
  t.after(() => socket.terminate());

  const firstCommandPromise = nextMessage(socket);
  const execution = bridge.execute({ command: 'set_document_preferences', documentId: 44, expectedRevision: 6, args: {} });
  const firstCommand = await firstCommandPromise;
  await assert.rejects(execution, (error) => error.code === 'COMMAND_TIMEOUT' && error.operationId === firstCommand.id);
  const operationPath = path.join(directory, `${firstCommand.id}.jsonl`);
  await fs.access(operationPath);
  const releaseNonce = lastJsonlRecord(await fs.readFile(operationPath, 'utf8')).releaseNonce;
  assert.match(releaseNonce, /^[A-Za-z0-9_-]{43}$/);
  await assert.rejects(
    bridge.execute({ command: 'get_document_info', documentId: 44, args: {} }),
    (error) => error.code === 'PERSISTED_OPERATION_REQUIRES_RECONCILIATION'
      && error.operationIds.includes(firstCommand.id),
  );

  assert.equal(await bridge.acknowledgeOperation(firstCommand.id), true);
  await assert.rejects(fs.access(operationPath));
  await assert.rejects(fs.access(path.join(directory, `${firstCommand.id}.${releaseNonce}.release.json`)));
  assert.equal(bridge.operationStatus(firstCommand.id).status, 'not-found');
  mutexes.guards[0].resolve({ code: 0, signal: null });

  const secondCommandPromise = nextMessage(socket);
  const secondExecution = bridge.execute({ command: 'get_document_info', documentId: 44, args: {} });
  const secondCommand = await secondCommandPromise;
  socket.send(JSON.stringify({ type: 'result', id: secondCommand.id, result: { documentId: 44, revision: 6 } }));
  assert.equal((await secondExecution).operationId, secondCommand.id);
  mutexes.guards[1].resolve({ code: 0, signal: null });
});

test('une erreur plugin tardive reste réconciliable via le helper détenteur du mutex', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-plugin-private-reconciliation-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const scriptPath = path.join(directory, 'inspection.idjs');
  await fs.writeFile(scriptPath, 'return { stable: true };', { encoding: 'utf8', mode: 0o600 });
  const secret = 'secret-local-de-test';
  const mutexes = fakeMutexFactory();
  let hostSnapshotCalls = 0;
  let latePersistenceBlocked = false;
  let markLatePersistenceStarted;
  let releaseLatePersistence;
  const latePersistenceStarted = new Promise((resolve) => { markLatePersistenceStarted = resolve; });
  const latePersistenceGate = new Promise((resolve) => { releaseLatePersistence = resolve; });
  const bridge = new InDesignBridge({
    secret,
    config: { host: '127.0.0.1', port: 0, pairing: false, pairingWindowMs: 5_000, authenticationTimeoutMs: 5_000, commandTimeoutMs: 40, maxQueueLength: 10, maxPayloadBytes: 64 * 1024 },
    operationDirectory: directory,
    protect: async (targetPath) => {
      if (!targetPath.endsWith('.jsonl') || latePersistenceBlocked) return;
      const latest = lastJsonlRecord(await fs.readFile(targetPath, 'utf8'));
      if (latest.status !== 'completed-after-timeout') return;
      latePersistenceBlocked = true;
      markLatePersistenceStarted();
      await latePersistenceGate;
    },
    operationMutexFactory: mutexes.factory,
    hostProcessSnapshot: async () => { hostSnapshotCalls += 1; return [HOST_BEFORE]; },
  });
  await bridge.start();
  t.after(() => bridge.close());
  const socket = await connectAuthenticated(bridge, secret);
  t.after(() => socket.terminate());

  const commandPromise = nextMessage(socket);
  const execution = bridge.execute({ command: 'set_document_preferences', documentId: 55, expectedRevision: 9, args: {} });
  const command = await commandPromise;
  await assert.rejects(execution, (error) => error.code === 'COMMAND_TIMEOUT' && error.operationId === command.id);
  socket.send(JSON.stringify({
    type: 'error',
    id: command.id,
    error: { code: 'INDESIGN_LATE_FAILURE', message: 'Échec tardif contrôlé' },
  }));
  await latePersistenceStarted;
  try {
    assert.equal(
      bridge.operationStatus(command.id).status,
      'pending-after-restart',
      'une réponse tardive ne doit pas être publiée avant son journal durable',
    );
  } finally {
    releaseLatePersistence();
  }
  const late = await waitForOperationStatus(bridge, command.id, 'completed');
  assert.equal(late.status, 'completed');
  assert.equal(late.outcome.ok, false);
  assert.equal(late.outcome.error.code, 'INDESIGN_LATE_FAILURE');

  const reconciliation = bridge.runOperationReconciliation({
    operationId: command.id,
    scriptPath,
    language: 'UXP',
    completionTimeoutMs: 1_000,
  });
  const requestPath = await waitForMatchingFile(
    directory,
    new RegExp(`^${command.id}\\.([0-9a-f-]{36})\\.reconcile-request\\.json$`, 'i'),
  );
  const request = JSON.parse(await fs.readFile(requestPath, 'utf8'));
  assert.equal(request.operationId, command.id);
  assert.equal(request.scriptPath, scriptPath);
  assert.equal(request.language, 'UXP');
  const responsePath = requestPath.replace('-request.json', '-response.json');
  await fs.writeFile(responsePath, JSON.stringify({
    schemaVersion: 1,
    operationId: command.id,
    requestId: request.requestId,
    ok: true,
    result: { stable: true },
  }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  const runnerResult = await reconciliation;
  assert.deepEqual(JSON.parse(runnerResult.stdout), { ok: true, result: { stable: true } });
  assert.equal(hostSnapshotCalls, 1, 'une réponse tardive prouve la fin du code sans exiger un redémarrage');
  assert.equal((await fs.readdir(directory)).some((name) => name.includes(request.requestId)), false);
  await assert.rejects(
    bridge.execute({ command: 'get_document_info', documentId: 55, args: {} }),
    (error) => error.code === 'PERSISTED_OPERATION_REQUIRES_RECONCILIATION',
  );
  assert.equal(await bridge.acknowledgeOperation(command.id), true);
  await assert.rejects(fs.access(path.join(directory, `${command.id}.jsonl`)));
  mutexes.guards[0].resolve({ code: 0, signal: null });
});

test('une issue plugin encore pending exige un vrai redémarrage InDesign avant réconciliation', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-plugin-restart-proof-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const scriptPath = path.join(directory, 'inspection-apres-restart.idjs');
  await fs.writeFile(scriptPath, 'return { stable: true };', { encoding: 'utf8', mode: 0o600 });
  const secret = 'secret-local-de-test';
  const mutexes = fakeMutexFactory();
  let currentHosts = [HOST_BEFORE];
  const bridge = new InDesignBridge({
    secret,
    config: { host: '127.0.0.1', port: 0, authenticationTimeoutMs: 5_000, commandTimeoutMs: 40, maxQueueLength: 10, maxPayloadBytes: 64 * 1024 },
    operationDirectory: directory,
    protect: async () => {},
    operationMutexFactory: mutexes.factory,
    hostProcessSnapshot: async () => currentHosts,
  });
  await bridge.start();
  t.after(() => bridge.close());
  const socket = await connectAuthenticated(bridge, secret);
  t.after(() => socket.terminate());

  const commandPromise = nextMessage(socket);
  const execution = bridge.execute({ command: 'execute_uxp', documentId: 71, expectedRevision: 3, args: {} });
  const command = await commandPromise;
  const operationPath = path.join(directory, `${command.id}.jsonl`);
  assert.deepEqual(lastJsonlRecord(await fs.readFile(operationPath, 'utf8')).hostProcessesAtDispatch, [HOST_BEFORE]);
  await assert.rejects(execution, (error) => error.code === 'COMMAND_TIMEOUT' && error.operationId === command.id);

  const reconcile = () => bridge.runOperationReconciliation({
    operationId: command.id,
    scriptPath,
    language: 'UXP',
    completionTimeoutMs: 1_000,
  });
  await assert.rejects(reconcile(), (error) => error.code === 'RECONCILIATION_RESTART_REQUIRED' && error.requiresInspection === true);
  currentHosts = [];
  await assert.rejects(reconcile(), (error) => error.code === 'RECONCILIATION_RESTART_REQUIRED' && error.requiresInspection === true);

  currentHosts = [HOST_AFTER];
  const reconciliation = reconcile();
  const requestPath = await waitForMatchingFile(
    directory,
    new RegExp(`^${command.id}\\.([0-9a-f-]{36})\\.reconcile-request\\.json$`, 'i'),
  );
  const request = JSON.parse(await fs.readFile(requestPath, 'utf8'));
  await fs.writeFile(requestPath.replace('-request.json', '-response.json'), JSON.stringify({
    schemaVersion: 1,
    operationId: command.id,
    requestId: request.requestId,
    ok: true,
    result: { stable: true },
  }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  assert.deepEqual(JSON.parse((await reconciliation).stdout), { ok: true, result: { stable: true } });
  assert.equal(await bridge.acknowledgeOperation(command.id), true);
});

test('une erreur plugin signalant une mutation partielle conserve le verrou jusqu’à acquittement', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-plugin-partial-mutation-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const secret = 'secret-local-de-test';
  const mutexes = fakeMutexFactory();
  const bridge = new InDesignBridge({
    secret,
    config: { host: '127.0.0.1', port: 0, pairing: false, pairingWindowMs: 5_000, authenticationTimeoutMs: 5_000, commandTimeoutMs: 1_000, maxQueueLength: 10, maxPayloadBytes: 64 * 1024 },
    operationDirectory: directory,
    protect: async () => {},
    operationMutexFactory: mutexes.factory,
  });
  await bridge.start();
  t.after(() => bridge.close());
  const socket = await connectAuthenticated(bridge, secret);
  t.after(() => socket.terminate());

  const operationId = '77777777-7777-4777-8777-777777777777';
  const documentStates = [{ documentId: 88, revision: 4, stateToken: 'a'.repeat(16) }];
  const commandPromise = nextMessage(socket);
  const execution = bridge.withOperationId(operationId, () => bridge.execute({
    command: 'execute_uxp',
    documentId: 88,
    expectedRevision: 3,
    expectedStateToken: 'b'.repeat(64),
    args: { code: 'throw new Error("mutation partielle")' },
  }));
  const command = await commandPromise;
  assert.equal(command.id, operationId);
  socket.send(JSON.stringify({
    type: 'error',
    id: command.id,
    error: {
      code: 'INDESIGN_PARTIAL_MUTATION',
      message: 'Mutation partielle contrôlée',
      requiresInspection: true,
      documentStates,
      details: { requiresInspection: true, documentStates },
    },
  }));

  await assert.rejects(execution, (error) => (
    error.code === 'INDESIGN_PARTIAL_MUTATION'
    && error.operationId === operationId
    && error.requiresInspection === true
    && JSON.stringify(error.documentStates) === JSON.stringify(documentStates)
  ));
  const completed = bridge.operationStatus(operationId);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.outcome.ok, false);
  assert.equal(completed.requiresInspection, true);
  assert.deepEqual(completed.outcome.error.documentStates, documentStates);
  await assert.rejects(
    bridge.execute({ command: 'get_document_info', documentId: 88, args: {} }),
    (error) => error.code === 'PERSISTED_OPERATION_REQUIRES_RECONCILIATION'
      && error.operationIds.includes(operationId),
  );
  await fs.access(path.join(directory, `${operationId}.jsonl`));

  assert.equal(await bridge.acknowledgeOperation(operationId), true);
  assert.equal(bridge.operationStatus(operationId).status, 'not-found');
  await assert.rejects(fs.access(path.join(directory, `${operationId}.jsonl`)));
});

test('un handshake mutex refusé tue le helper et attend sa sortie avant le rejet', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-plugin-helper-handshake-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const operationPath = path.join(directory, '55555555-5555-4555-8555-555555555555.jsonl');
  await fs.writeFile(operationPath, `${JSON.stringify({
    schemaVersion: 1,
    operationId: '55555555-5555-4555-8555-555555555555',
    command: 'test',
    status: 'pending',
    releaseNonce: 'r'.repeat(43),
  })}\n`, { encoding: 'utf8', mode: 0o600 });
  const child = new EventEmitter();
  child.pid = 501;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let killed = false;
  let exited = false;
  let spawnedArguments;
  child.kill = () => {
    killed = true;
    setImmediate(() => {
      exited = true;
      child.emit('exit', 9, null);
    });
    return true;
  };

  await assert.rejects(
    acquireWindowsNamedMutexGuard({
      operationPath,
      timeoutMs: 1_000,
      releaseNonce: 'r'.repeat(43),
      spawnProcess: (_executable, args) => {
        spawnedArguments = args;
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({ ok: false, code: 'INDESIGN_MUTEX_BUSY' })}\n`));
        return child;
      },
    }),
    (error) => error.code === 'INDESIGN_MUTEX_BUSY' && killed === true && exited === true,
  );
  assert.equal(spawnedArguments.includes('-ReleaseNonce'), false);
  assert.equal(spawnedArguments.includes('r'.repeat(43)), false, 'le nonce privé ne doit jamais apparaître dans la ligne de commande');
});

test('le helper Windows accepte un chemin absolu normalisable et persiste son PID avant handshake dans un journal plugin JSONL', {
  skip: process.platform !== 'win32',
  timeout: 15_000,
}, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-plugin-real-helper-'));
  const operationId = crypto.randomUUID();
  const releaseNonce = Buffer.from(crypto.randomBytes(32)).toString('base64url');
  const operationPath = path.join(directory, `${operationId}.jsonl`);
  const helperOperationPath = operationPath.replaceAll('\\', '/');
  const markerPath = path.join(directory, `${operationId}.${releaseNonce}.release.json`);
  const mutexName = `Local\\NexusInDesignAutomation.Test.${crypto.randomUUID()}`;
  await fs.writeFile(operationPath, `${JSON.stringify({ schemaVersion: 1, operationId, command: 'test', status: 'pending', releaseNonce })}\n`);
  let guard;
  t.after(async () => {
    if (guard) {
      await fs.writeFile(markerPath, JSON.stringify({ schemaVersion: 1, operationId, releaseNonce, status: 'acknowledged' })).catch(() => {});
      await Promise.race([guard.exit, new Promise((resolve) => setTimeout(resolve, 3_000))]);
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  guard = await acquireWindowsNamedMutexGuard({
    operationPath: helperOperationPath,
    releaseNonce,
    timeoutMs: 3_000,
    mutexName,
    allowTestMutex: true,
  });
  const records = (await fs.readFile(operationPath, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  assert.ok(records.length >= 2, 'le helper doit ajouter une preuve durable au journal plugin');
  assert.equal(records.at(-1).guardProcessId, guard.processId);
  assert.equal(records.at(-1).releaseNonce, releaseNonce);
  await fs.writeFile(markerPath, JSON.stringify({ schemaVersion: 1, operationId, releaseNonce, status: 'acknowledged' }));
  assert.deepEqual(await guard.exit, { code: 0, signal: null });
  guard = undefined;
});

test('le helper Windows refuse un chemin absolu contenant un segment parent', {
  skip: process.platform !== 'win32',
  timeout: 10_000,
}, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-plugin-parent-path-'));
  const nestedDirectory = path.join(directory, 'nested');
  const operationId = crypto.randomUUID();
  const releaseNonce = Buffer.from(crypto.randomBytes(32)).toString('base64url');
  const operationPath = path.join(directory, `${operationId}.jsonl`);
  const unsafeOperationPath = `${nestedDirectory.replaceAll('\\', '/')}/../${operationId}.jsonl`;
  const mutexName = `Local\\NexusInDesignAutomation.Test.${crypto.randomUUID()}`;
  await fs.mkdir(nestedDirectory);
  await fs.writeFile(operationPath, `${JSON.stringify({ schemaVersion: 1, operationId, command: 'test', status: 'pending', releaseNonce })}\n`);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  await assert.rejects(
    acquireWindowsNamedMutexGuard({
      operationPath: unsafeOperationPath,
      releaseNonce,
      timeoutMs: 1_000,
      mutexName,
      allowTestMutex: true,
    }),
    (error) => error.code === 'MUTEX_OPERATION_PATH_INVALID',
  );
});

test('le launcher silencieux et le helper utilisent le même mutex global', async () => {
  const launcher = await fs.readFile(path.resolve('scripts', 'Invoke-InDesignScript.ps1'), 'utf8');
  const helper = await fs.readFile(path.resolve('scripts', 'Hold-InDesignOperationMutex.ps1'), 'utf8');
  const mutexLiteral = 'Local\\NexusInDesignAutomation';
  assert.equal(INDESIGN_AUTOMATION_MUTEX, mutexLiteral);
  assert.equal(launcher.includes(mutexLiteral), true);
  assert.equal(helper.includes(mutexLiteral), true);
  assert.equal(launcher.includes('Local\\InDesignMcpSecureScript'), false);
  assert.match(helper, /Invoke-PendingReconciliationRequests/);
  assert.match(helper, /\.DoScript\(/);
  assert.match(helper, /Test-ReleaseAcknowledgement/);
  assert.equal(helper.includes('if (-not (Test-Path -LiteralPath $OperationPath)) { break }'), false);
  assert.ok(helper.indexOf('Invoke-PendingReconciliationRequests -OperationPath') < helper.indexOf('$mutex.ReleaseMutex()'));
  assert.equal(helper.slice(0, helper.indexOf('$ErrorActionPreference')).includes('ReleaseNonce'), false, 'le nonce ne doit pas être un paramètre de ligne de commande');
  assert.ok(launcher.indexOf('durableLeasePath') < launcher.indexOf('New-Object System.Threading.Mutex'), 'le lease durable doit être vérifié avant le mutex abandonné');
  assert.match(launcher, /\[string\]\$lease\.kind -ne 'external'/);
  assert.match(launcher, /\[string\]\$lease\.operationId -ne \$ExpectedLeaseOperationId/);
  assert.ok(launcher.lastIndexOf('Assert-NoDurableInDesignOperation') > launcher.indexOf('$mutex.WaitOne'), 'le lease doit être revérifié après attente du mutex');
  assert.ok(helper.indexOf("Update-OperationRecord -Changes @{ guardProcessId = $PID") < helper.indexOf("Write-Handshake @{ ok = $true; status = 'acquired'"), 'le PID du helper doit être durable avant son handshake');
});

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { EXPECTED_UXP_ORIGIN, InDesignBridge } from '../src/bridge/InDesignBridge.js';
import { SharedInDesignBridgeClient } from '../src/bridge/SharedInDesignBridgeClient.js';
import { INDESIGN_AUTOMATION_MUTEX } from '../src/bridge/WindowsNamedMutexGuard.js';
import { hmac } from '../src/security/crypto.js';
import { PACKAGE_VERSION } from '../src/version.js';

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function autoReleasingMutexFactory() {
  let nextProcessId = 70_000;
  return async (options) => {
    const exited = deferred();
    const operationId = path.basename(options.operationPath, '.jsonl');
    const markerPath = path.join(path.dirname(options.operationPath), `${operationId}.${options.releaseNonce}.release.json`);
    const timer = setInterval(async () => {
      try {
        const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
        if (marker.operationId === operationId && marker.releaseNonce === options.releaseNonce && marker.status === 'acknowledged') {
          clearInterval(timer);
          exited.resolve({ code: 0, signal: null });
        }
      } catch {}
    }, 5);
    timer.unref?.();
    return {
      processId: nextProcessId++,
      mutex: INDESIGN_AUTOMATION_MUTEX,
      status: 'acquired',
      exit: exited.promise,
    };
  };
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => resolve(JSON.parse(data.toString())));
    socket.once('error', reject);
  });
}

async function connectPlugin(bridge, secret) {
  const socket = new WebSocket(`ws://127.0.0.1:${bridge.address().port}`, { origin: EXPECTED_UXP_ORIGIN });
  const challengePromise = nextMessage(socket);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const challenge = await challengePromise;
  const pluginId = 'fr.pironjulien.indesign.mcp';
  const version = PACKAGE_VERSION;
  const pluginNonce = 'p'.repeat(48);
  const authenticated = nextMessage(socket);
  socket.send(JSON.stringify({
    type: 'auth_proof',
    pluginId,
    version,
    nonce: challenge.nonce,
    pluginNonce,
    proof: hmac(secret, `plugin:${challenge.nonce}:${pluginNonce}:${pluginId}:${version}`),
  }));
  assert.equal((await authenticated).type, 'auth_ok');
  return socket;
}

function config(port) {
  return {
    host: '127.0.0.1',
    port,
    authenticationTimeoutMs: 1_000,
    commandTimeoutMs: 1_000,
    maxQueueLength: 10,
    maxPayloadBytes: 64 * 1024,
  };
}

test('plusieurs tâches Codex partagent une unique session UXP authentifiée et sérialisée', async (t) => {
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-shared-bridge-'));
  const secret = 'secret-partage-entre-processus-codex';
  const owner = new InDesignBridge({
    config: config(0),
    secret,
    operationDirectory: runtime,
    operationMutexFactory: autoReleasingMutexFactory(),
    hostProcessSnapshot: async () => [{ processId: 99, startedAt: '2026-07-17T12:00:00.000Z' }],
  });
  await owner.start();
  const ownerPort = owner.address().port;
  const first = new SharedInDesignBridgeClient({ config: config(ownerPort), secret, expectedOwnerPid: process.pid });
  const second = new SharedInDesignBridgeClient({ config: config(ownerPort), secret, expectedOwnerPid: process.pid });
  await Promise.all([first.start(), second.start()]);
  assert.equal(first.status().authenticated, false);
  const plugin = await connectPlugin(owner, secret);
  for (let attempt = 0; attempt < 20 && !first.status().authenticated; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const received = [];
  plugin.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type !== 'command') return;
    received.push(message);
    setTimeout(() => plugin.send(JSON.stringify({
      type: 'result',
      id: message.id,
      result: { pong: true, sequence: received.length },
    })), 10);
  });
  t.after(async () => {
    await Promise.all([first.close(), second.close()]);
    plugin.close();
    await owner.close();
    await fs.rm(runtime, { recursive: true, force: true });
  });

  assert.equal(first.status().brokerRole, 'client');
  assert.equal(first.status().authenticated, true);
  assert.equal(first.status().listening, false);
  assert.equal(owner.status().sharedClientCount, 2);

  const [firstResult, secondResult] = await Promise.all([
    first.execute({ command: 'ping', args: {} }),
    second.execute({ command: 'ping', args: {} }),
  ]);
  assert.equal(firstResult.result.pong, true);
  assert.equal(secondResult.result.pong, true);
  assert.equal(received.length, 2);
  assert.notEqual(received[0].id, received[1].id);
  assert.equal(owner.status().queueLength, 0);
  plugin.close();
  for (let attempt = 0; attempt < 20 && first.status().authenticated; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(first.status().brokerConnected, true);
  assert.equal(first.status().authenticated, false);
});

test('une tâche partagée reste connectée après l’expiration du délai réservé au handshake', async (t) => {
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-shared-handshake-'));
  const secret = 'secret-session-persistante';
  const shortConfig = { ...config(0), authenticationTimeoutMs: 40 };
  const owner = new InDesignBridge({ config: shortConfig, secret, operationDirectory: runtime });
  await owner.start();
  const client = new SharedInDesignBridgeClient({
    config: { ...shortConfig, port: owner.address().port },
    secret,
    expectedOwnerPid: process.pid,
  });
  await client.start();
  t.after(async () => {
    await client.close();
    await owner.close();
    await fs.rm(runtime, { recursive: true, force: true });
  });

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(client.status().brokerConnected, true);
  assert.equal(owner.status().sharedClientCount, 1);
});

test('une session renouvelle son authentification avant d’oublier un nonce anti-rejeu', async (t) => {
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-shared-renewal-'));
  const secret = 'secret-renouvellement-session';
  const owner = new InDesignBridge({
    config: config(0),
    secret,
    operationDirectory: runtime,
    maxSharedRequestsPerSession: 1,
  });
  await owner.start();
  const client = new SharedInDesignBridgeClient({
    config: config(owner.address().port),
    secret,
    expectedOwnerPid: process.pid,
  });
  await client.start();
  t.after(async () => {
    await client.close();
    await owner.close();
    await fs.rm(runtime, { recursive: true, force: true });
  });

  await client.refreshStatus();
  await assert.rejects(client.refreshStatus(), (error) => error.code === 'SHARED_BRIDGE_DISCONNECTED');
  const renewed = await client.refreshStatus();
  assert.equal(renewed.brokerConnected, true);
  assert.equal(owner.status().sharedClientCount, 1);
});

test('le courtier refuse un processus local qui ne possède pas le secret ou le PID attendu', async (t) => {
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-shared-auth-'));
  const owner = new InDesignBridge({ config: config(0), secret: 'secret-legitime', operationDirectory: runtime });
  await owner.start();
  t.after(async () => {
    await owner.close();
    await fs.rm(runtime, { recursive: true, force: true });
  });

  const wrongSecret = new SharedInDesignBridgeClient({ config: config(owner.address().port), secret: 'secret-incorrect' });
  await assert.rejects(wrongSecret.start(), (error) => error.code === 'SHARED_BRIDGE_UNAVAILABLE');
  await wrongSecret.close();

  const wrongPid = new SharedInDesignBridgeClient({
    config: config(owner.address().port),
    secret: 'secret-legitime',
    expectedOwnerPid: process.pid + 10_000,
  });
  await assert.rejects(wrongPid.start(), (error) => error.code === 'SHARED_BRIDGE_UNAVAILABLE');
  await wrongPid.close();
  for (let attempt = 0; attempt < 20 && owner.status().sharedClientCount !== 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(owner.status().sharedClientCount, 0);
});

test('le propriétaire refuse un client dont la chaîne de processus Codex n’est pas autorisée', async (t) => {
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-shared-process-'));
  let observedConnection;
  const owner = new InDesignBridge({
    config: config(0),
    secret: 'secret-processus-codex',
    operationDirectory: runtime,
    peerAuthorizer: async (connection) => {
      observedConnection = connection;
      throw new Error('chaîne non autorisée');
    },
  });
  await owner.start();
  const client = new SharedInDesignBridgeClient({
    config: config(owner.address().port),
    secret: 'secret-processus-codex',
  });
  await assert.rejects(client.start(), (error) => error.code === 'SHARED_BRIDGE_UNAVAILABLE');
  t.after(async () => {
    await client.close();
    await owner.close();
    await fs.rm(runtime, { recursive: true, force: true });
  });
  assert.equal(observedConnection.serverPort, owner.address().port);
  assert.ok(Number.isSafeInteger(observedConnection.clientPort));
  assert.equal(owner.status().sharedClientCount, 0);
});

test('un client existant reprend automatiquement le port quand la tâche propriétaire se ferme', async (t) => {
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-shared-takeover-'));
  const secret = 'secret-reprise-courtier';
  const owner = new InDesignBridge({ config: config(0), secret, operationDirectory: runtime });
  await owner.start();
  const ownerPort = owner.address().port;
  let promoted;
  const client = new SharedInDesignBridgeClient({
    config: config(ownerPort),
    secret,
    expectedOwnerPid: process.pid,
    takeoverFactory: () => {
      promoted = new InDesignBridge({
        config: config(ownerPort),
        secret,
        operationDirectory: runtime,
        peerAuthorizer: async () => ({ verified: true, processId: process.pid }),
      });
      return promoted;
    },
  });
  await client.start();
  assert.equal(client.status().brokerRole, 'client');
  await owner.close();
  for (let attempt = 0; attempt < 20 && client.status().brokerConnected; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const status = await client.refreshStatus();
  t.after(async () => {
    await client.close();
    await fs.rm(runtime, { recursive: true, force: true });
  });
  assert.ok(promoted);
  assert.equal(status.brokerRole, 'owner');
  assert.equal(status.listening, true);
  assert.equal(promoted.address().port, ownerPort);
});

test('deux clients en reprise élisent un seul nouveau propriétaire et l’autre le rejoint', async (t) => {
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-shared-election-'));
  const secret = 'secret-election-courtier';
  const owner = new InDesignBridge({ config: config(0), secret, operationDirectory: runtime });
  await owner.start();
  const ownerPort = owner.address().port;
  const candidates = [];
  const makeClient = () => new SharedInDesignBridgeClient({
    config: config(ownerPort),
    secret,
    expectedOwnerPid: process.pid,
    takeoverFactory: () => {
      const candidate = new InDesignBridge({
        config: config(ownerPort),
        secret,
        operationDirectory: runtime,
        peerAuthorizer: async () => ({ verified: true, processId: process.pid }),
      });
      candidates.push(candidate);
      return candidate;
    },
  });
  const first = makeClient();
  const second = makeClient();
  await Promise.all([first.start(), second.start()]);
  await owner.close();
  for (let attempt = 0; attempt < 20 && (first.status().brokerConnected || second.status().brokerConnected); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const [firstStatus, secondStatus] = await Promise.all([first.refreshStatus(), second.refreshStatus()]);
  t.after(async () => {
    await Promise.all([first.close(), second.close()]);
    await fs.rm(runtime, { recursive: true, force: true });
  });
  assert.deepEqual([firstStatus.brokerRole, secondStatus.brokerRole].sort(), ['client', 'owner']);
  assert.equal(candidates.filter((candidate) => candidate.status().listening).length, 1);
  assert.equal(firstStatus.authenticated, false);
  assert.equal(secondStatus.authenticated, false);
});

test('la perte du propriétaire pendant une commande conserve son identifiant et exige une inspection', async (t) => {
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-shared-unknown-'));
  const secret = 'secret-issue-inconnue-partagee';
  const owner = new InDesignBridge({
    config: config(0),
    secret,
    operationDirectory: runtime,
    operationMutexFactory: autoReleasingMutexFactory(),
    hostProcessSnapshot: async () => [{ processId: 99, startedAt: '2026-07-17T12:00:00.000Z' }],
  });
  await owner.start();
  const plugin = await connectPlugin(owner, secret);
  const commandReceived = deferred();
  plugin.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === 'command') commandReceived.resolve(message);
  });
  const client = new SharedInDesignBridgeClient({ config: config(owner.address().port), secret, expectedOwnerPid: process.pid });
  await client.start();
  const execution = client.execute({ command: 'ping', args: {} });
  const command = await commandReceived.promise;
  await owner.close();
  await assert.rejects(execution, (error) => {
    assert.equal(error.operationId, command.id);
    assert.equal(error.requiresInspection, true);
    return error.code === 'SHARED_BRIDGE_DISCONNECTED';
  });
  t.after(async () => {
    await client.close();
    plugin.close();
    await fs.rm(runtime, { recursive: true, force: true });
  });
});

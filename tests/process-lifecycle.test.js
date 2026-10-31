import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createParentProcessWatchdog } from '../src/security/ParentProcessWatchdog.js';
import { createProcessLifecycle } from '../src/server/ProcessLifecycle.js';

const PARENT = { processId: 42, startedAt: '2026-07-17T08:00:00.000Z' };
const execFileAsync = promisify(execFile);
const serverHarnessPath = fileURLToPath(new URL('./helpers/processLifecycleServer.js', import.meta.url));

function manualSchedule() {
  let callback;
  let cancelled = 0;
  return {
    schedule(fn) {
      callback = fn;
      return { unref() {} };
    },
    cancel() { cancelled += 1; },
    tick() { return callback?.(); },
    get cancelled() { return cancelled; },
  };
}

test('le watchdog distingue la disparition du parent et la réutilisation de son PID', async () => {
  for (const replacement of [undefined, { processId: 42, startedAt: '2026-07-17T09:00:00.000Z' }]) {
    const scheduler = manualSchedule();
    const values = [PARENT, replacement];
    const losses = [];
    let clock = 0;
    const watchdog = await createParentProcessWatchdog({
      parentPid: 42,
      intervalMs: 10,
      identityIntervalMs: 10,
      readIdentity: async () => values.shift(),
      // Parent présent pour le PID réutilisé, absent sinon.
      isAlive: () => Boolean(replacement) || values.length > 0,
      now: () => (clock += 100),
      onLost: (event) => { losses.push(event); },
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
    });

    const state = await watchdog.check();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.status, 'lost');
    assert.equal(losses.length, 1);
    assert.equal(losses[0].reason, replacement ? 'identity-changed' : 'parent-exited');
    watchdog.close();
  }
});

test('le watchdog ne coupe jamais le serveur sur une sonde lente tant que le parent est présent', async () => {
  const scheduler = manualSchedule();
  let calls = 0;
  let alive = true;
  let clock = 0;
  const losses = [];
  const watchdog = await createParentProcessWatchdog({
    parentPid: 42,
    intervalMs: 10,
    identityIntervalMs: 10,
    readIdentity: async () => {
      calls += 1;
      if (calls === 1) return PARENT;
      throw new Error('sonde indisponible');
    },
    isAlive: () => alive,
    now: () => (clock += 100),
    onLost: (event) => { losses.push(event); },
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });

  for (let index = 0; index < 5; index += 1) assert.equal((await watchdog.check()).status, 'probe-failed');
  assert.equal(losses.length, 0);
  alive = false;
  assert.equal((await watchdog.check()).status, 'lost');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(losses.length, 1);
  assert.equal(losses[0].reason, 'parent-exited');
});

test('le watchdog limite la sonde PowerShell et survit à un premier échec au démarrage', async () => {
  const scheduler = manualSchedule();
  let probes = 0;
  let clock = 0;
  const losses = [];
  const watchdog = await createParentProcessWatchdog({
    parentPid: 42,
    intervalMs: 10,
    identityIntervalMs: 1_000,
    readIdentity: async () => {
      probes += 1;
      if (probes === 1) throw new Error('démarrage lent');
      return PARENT;
    },
    isAlive: () => true,
    now: () => clock,
    onLost: (event) => { losses.push(event); },
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });
  assert.equal(probes, 2);
  assert.deepEqual(watchdog.expectedIdentity, PARENT);
  for (let index = 0; index < 10; index += 1) assert.equal((await watchdog.check()).status, 'alive');
  assert.equal(probes, 2, 'pas de sonde PowerShell avant identityIntervalMs');
  clock = 1_000;
  assert.equal((await watchdog.check()).status, 'alive');
  assert.equal(probes, 3);
  assert.equal(losses.length, 0);
  watchdog.close();
});

function lifecycleFixture({ close = async () => {}, shutdownTimeoutMs = 100 } = {}) {
  const input = new EventEmitter();
  const processRef = new EventEmitter();
  let closeCalls = 0;
  let watcherCloses = 0;
  let onLost;
  const exits = [];
  let resolveExit;
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });
  const lifecycle = createProcessLifecycle({
    application: { async close() { closeCalls += 1; await close(); } },
    input,
    processRef,
    parentPid: 42,
    shutdownTimeoutMs,
    parentWatchdogFactory: async (options) => {
      onLost = options.onLost;
      return { close() { watcherCloses += 1; } };
    },
    requestExit: (code) => {
      exits.push(code);
      resolveExit(code);
    },
    logger: { error() {} },
  });
  return {
    lifecycle,
    input,
    processRef,
    exits,
    exitPromise,
    get closeCalls() { return closeCalls; },
    get watcherCloses() { return watcherCloses; },
    loseParent(event = { reason: 'parent-exited' }) { return onLost(event); },
  };
}

test('fin STDIO, fermeture du flux et signal simultanés ferment une seule fois', async () => {
  const fixture = lifecycleFixture();
  await fixture.lifecycle.start();
  fixture.input.emit('end');
  fixture.input.emit('close');
  fixture.processRef.emit('SIGTERM');
  assert.equal(await fixture.exitPromise, 0);
  assert.equal(fixture.closeCalls, 1);
  assert.equal(fixture.watcherCloses, 1);
  assert.deepEqual(fixture.exits, [0]);
});

test('la perte du parent ferme le serveur même si STDIO ne se ferme pas', async () => {
  const fixture = lifecycleFixture();
  await fixture.lifecycle.start();
  fixture.loseParent();
  assert.equal(await fixture.exitPromise, 0);
  assert.equal(fixture.closeCalls, 1);
  assert.deepEqual(fixture.exits, [0]);
});

test('trois échecs de contrôle du parent provoquent une sortie en erreur', async () => {
  const fixture = lifecycleFixture();
  await fixture.lifecycle.start();
  fixture.loseParent({ reason: 'probe-failed', cause: new Error('contrôle indisponible') });
  assert.equal(await fixture.exitPromise, 1);
  assert.equal(fixture.closeCalls, 1);
  assert.deepEqual(fixture.exits, [1]);
});

test('un arrêt bloqué atteint le délai de sécurité sans deuxième fermeture', async () => {
  const fixture = lifecycleFixture({ close: () => new Promise(() => {}), shutdownTimeoutMs: 20 });
  await fixture.lifecycle.start();
  fixture.input.emit('end');
  assert.equal(await fixture.exitPromise, 1);
  assert.equal(fixture.closeCalls, 1);
  assert.deepEqual(fixture.exits, [1]);
});

async function listeningPortsForProcess(processId) {
  const windowsDirectory = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const netstat = path.join(windowsDirectory, 'System32', 'netstat.exe');
  const { stdout } = await execFileAsync(netstat, ['-ano', '-p', 'tcp'], {
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  });
  const ports = new Set();
  for (const line of String(stdout).split(/\r?\n/)) {
    const match = line.match(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (match && Number(match[2]) === processId) ports.add(Number(match[1]));
  }
  return [...ports];
}

async function waitForNetworkListeners(child, stderr, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Le serveur enfant s’est arrêté avant d’écouter (code ${child.exitCode}): ${stderr()}`);
    }
    const ports = await listeningPortsForProcess(child.pid);
    if (ports.length > 0) return ports;
    await delay(50);
  }
  throw new Error(`Le serveur enfant n’a ouvert aucun listener dans le délai: ${stderr()}`);
}

async function waitForExit(child, stderr, timeoutMs = 10_000) {
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode };
  let timer;
  try {
    return await Promise.race([
      new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Le serveur enfant ne s’est pas arrêté après la fermeture de STDIN: ${stderr()}`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function provePortCanBeReused(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
  });
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test('le vrai serveur libère STDIO et tous ses listeners quand son entrée se ferme', {
  skip: process.platform !== 'win32',
  timeout: 30_000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-mcp-process-lifecycle-'));
  const secureRoot = path.join(root, 'secure');
  const readRoot = path.join(root, 'read');
  const writeRoot = path.join(root, 'write');
  await Promise.all([
    fs.mkdir(secureRoot),
    fs.mkdir(readRoot),
    fs.mkdir(writeRoot),
  ]);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const child = spawn(process.execPath, [serverHarnessPath], {
    cwd: path.dirname(serverHarnessPath),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      INDESIGN_MCP_TOKEN_FILE: path.join(secureRoot, 'token'),
      INDESIGN_MCP_BACKUP_ROOT: path.join(secureRoot, 'backups'),
      INDESIGN_MCP_READ_ROOTS: readRoot,
      INDESIGN_MCP_WRITE_ROOTS: writeRoot,
      INDESIGN_MCP_PORT: '0',
      INDESIGN_MCP_COMMAND_TIMEOUT_MS: '1000',
    },
  });
  const stderrChunks = [];
  child.stderr.on('data', (chunk) => {
    if (stderrChunks.reduce((total, item) => total + item.length, 0) < 64 * 1024) stderrChunks.push(Buffer.from(chunk));
  });
  child.stdout.resume();
  const stderr = () => Buffer.concat(stderrChunks).toString('utf8').trim();
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });

  const ports = await waitForNetworkListeners(child, stderr);
  assert.equal(ports.length, 1, `Un seul listener loopback est attendu, obtenu: ${ports.join(', ')}`);
  child.stdin.end();
  const exit = await waitForExit(child, stderr);
  assert.deepEqual(exit, { code: 0, signal: null }, stderr());
  for (const port of ports) await provePortCanBeReused(port);
});

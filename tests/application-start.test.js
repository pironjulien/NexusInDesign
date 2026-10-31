import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApplication } from '../src/server/createApplication.js';

async function fixture(t, name) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
  const readRoot = path.join(directory, 'read');
  const writeRoot = path.join(directory, 'write');
  const secureRoot = path.join(directory, 'secure');
  await Promise.all([fs.mkdir(readRoot), fs.mkdir(writeRoot), fs.mkdir(secureRoot)]);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return {
    directory,
    secureRoot,
    env: {
      INDESIGN_MCP_TOKEN_FILE: path.join(secureRoot, 'token'),
      INDESIGN_MCP_BACKUP_ROOT: path.join(secureRoot, 'backups'),
      INDESIGN_MCP_READ_ROOTS: readRoot,
      INDESIGN_MCP_WRITE_ROOTS: writeRoot,
      INDESIGN_MCP_PORT: '0',
      INDESIGN_MCP_COMMAND_TIMEOUT_MS: '1000',
    },
  };
}

function transport({ onStart = async () => {}, onClose = async () => {} } = {}) {
  return {
    onmessage: undefined,
    onerror: undefined,
    onclose: undefined,
    async start() { await onStart(); },
    async send() {},
    async close() {
      await onClose();
      this.onclose?.();
    },
  };
}

test('le port de test isole son runtime et deux start simultanes ne demarrent qu une fois', async (t) => {
  const { directory, secureRoot, env } = await fixture(t, 'indesign-application-start');
  const previousLocalAppData = process.env.LOCALAPPDATA;
  const fakeLocalAppData = path.join(directory, 'local-appdata');
  process.env.LOCALAPPDATA = fakeLocalAppData;
  t.after(() => {
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
  });

  let releaseParentCheck;
  const parentCheck = new Promise((resolve) => { releaseParentCheck = resolve; });
  let parentChecks = 0;
  let silentFactories = 0;
  let bridgeFactories = 0;
  let transportFactories = 0;
  let silentOptions;
  let bridgeOptions;
  const application = await createApplication({
    env,
    verifyParent: async () => {
      parentChecks += 1;
      await parentCheck;
      return { verified: true };
    },
    silentBridgeFactory: (options) => {
      silentFactories += 1;
      silentOptions = options;
      return { initialize: async () => {}, close: async () => {} };
    },
    bridgeFactory: (options) => {
      bridgeFactories += 1;
      bridgeOptions = options;
      return { start: async () => {}, close: async () => {} };
    },
    transportFactory: () => {
      transportFactories += 1;
      return transport();
    },
  });
  t.after(() => application.close());

  const first = application.start();
  const second = application.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(parentChecks, 1);
  releaseParentCheck();
  await Promise.all([first, second]);

  const expectedRuntime = await fs.realpath(path.join(secureRoot, '.test-runtime'));
  assert.equal(path.dirname(silentOptions.runtimeRoot), expectedRuntime);
  assert.equal(path.dirname(bridgeOptions.operationDirectory), expectedRuntime);
  assert.equal(Object.hasOwn(silentOptions, 'operationMutexFactory'), false);
  assert.equal(Object.hasOwn(bridgeOptions, 'operationMutexFactory'), false);
  assert.equal(parentChecks, 1);
  assert.equal(silentFactories, 1);
  assert.equal(bridgeFactories, 1);
  assert.equal(transportFactories, 1);
  await assert.rejects(fs.lstat(path.join(fakeLocalAppData, 'InDesignMCPSecure')), (error) => error.code === 'ENOENT');
});

test('une fabrique de mutex injectée est partagée sans que le port de test contourne le verrou de production', async (t) => {
  const { env } = await fixture(t, 'indesign-application-mutex-injecte');
  const observed = { guardCalls: [] };
  const operationMutexGuardFactory = async (options) => {
    observed.guardCalls.push(options);
    return options;
  };
  const application = await createApplication({
    env,
    verifyParent: async () => ({ verified: true }),
    operationMutexGuardFactory,
    silentBridgeFactory: (options) => {
      observed.silentOptions = options;
      return { initialize: async () => {}, close: async () => {} };
    },
    bridgeFactory: (options) => {
      observed.bridgeOptions = options;
      return { start: async () => {}, close: async () => {} };
    },
    transportFactory: () => transport(),
  });
  t.after(() => application.close());
  await application.start();

  assert.equal(observed.silentOptions.operationMutexFactory, operationMutexGuardFactory);
  assert.equal(observed.bridgeOptions.operationMutexFactory, operationMutexGuardFactory);
  const silentCall = await observed.silentOptions.operationMutexFactory({ operationPath: 'silent-operation' });
  const pluginCall = await observed.bridgeOptions.operationMutexFactory({ operationPath: 'plugin-operation' });
  assert.deepEqual(observed.guardCalls, [silentCall, pluginCall]);

  const { env: defaultEnv } = await fixture(t, 'indesign-application-mutex-par-defaut');
  let silentOptions;
  let bridgeOptions;
  const defaultApplication = await createApplication({
    env: defaultEnv,
    verifyParent: async () => ({ verified: true }),
    silentBridgeFactory: (options) => {
      silentOptions = options;
      return { initialize: async () => {}, close: async () => {} };
    },
    bridgeFactory: (options) => {
      bridgeOptions = options;
      return { start: async () => {}, close: async () => {} };
    },
    transportFactory: () => transport(),
  });
  t.after(() => defaultApplication.close());
  await defaultApplication.start();
  assert.equal(defaultApplication.operationMutexGuardFactory, undefined);
  assert.equal(Object.hasOwn(silentOptions, 'operationMutexFactory'), false);
  assert.equal(Object.hasOwn(bridgeOptions, 'operationMutexFactory'), false);
});

test('un echec de connexion MCP ferme toutes les ressources et autorise une nouvelle tentative', async (t) => {
  const { env } = await fixture(t, 'indesign-application-rollback');
  let silentFactories = 0;
  let silentCloses = 0;
  let bridgeFactories = 0;
  let bridgeCloses = 0;
  let transportFactories = 0;
  let transportCloses = 0;
  const application = await createApplication({
    env,
    verifyParent: async () => ({ verified: true }),
    silentBridgeFactory: () => {
      silentFactories += 1;
      return { initialize: async () => {}, close: async () => { silentCloses += 1; } };
    },
    bridgeFactory: () => {
      bridgeFactories += 1;
      return { start: async () => {}, close: async () => { bridgeCloses += 1; } };
    },
    transportFactory: () => {
      transportFactories += 1;
      const attempt = transportFactories;
      return transport({
        onStart: async () => {
          if (attempt === 1) throw new Error('transport indisponible');
        },
        onClose: async () => { transportCloses += 1; },
      });
    },
  });
  t.after(() => application.close());

  await assert.rejects(application.start(), /transport indisponible/);
  assert.equal(application.started, false);
  assert.equal(application.startPromise, null);
  assert.equal(application.transport, undefined);
  assert.equal(application.bridge, undefined);
  assert.equal(application.silentBridge, undefined);
  assert.equal(silentFactories, 1);
  assert.equal(silentCloses, 1);
  assert.equal(bridgeFactories, 1);
  assert.equal(bridgeCloses, 1);
  assert.equal(transportFactories, 1);
  assert.equal(transportCloses, 1);

  await application.start();
  assert.equal(application.started, true);
  assert.equal(silentFactories, 2);
  assert.equal(bridgeFactories, 2);
  assert.equal(transportFactories, 2);
});

test('un bridge partiellement demarre est ferme avant le mode degrade', async (t) => {
  const { env } = await fixture(t, 'indesign-application-bridge-rollback');
  let bridgeCloses = 0;
  const application = await createApplication({
    env,
    verifyParent: async () => ({ verified: true }),
    silentBridgeFactory: () => ({ initialize: async () => {}, close: async () => {} }),
    bridgeFactory: () => ({
      start: async () => { throw Object.assign(new Error('port occupe'), { code: 'EADDRINUSE' }); },
      close: async () => { bridgeCloses += 1; },
    }),
    portOwnerLookup: async () => 4242,
    transportFactory: () => transport(),
  });
  t.after(() => application.close());

  await application.start();
  assert.equal(application.started, true);
  assert.equal(application.bridgeError.code, 'EADDRINUSE');
  assert.equal(application.bridgeError.listenerOwnerPid, 4242);
  assert.equal(bridgeCloses, 1);
});

test('le runtime de production reste sous le stockage privé, hors %LOCALAPPDATA% virtualisable', async () => {
  const source = await fs.readFile(new URL('../src/server/Application.js', import.meta.url), 'utf8');
  assert.match(source, /runtimeRoot = path\.join\(privateRoot, 'runtime'\)/);
  assert.equal(source.includes("path.join(localAppData, 'InDesignMCPSecure')"), false);
  const bridge = await fs.readFile(new URL('../src/bridge/InDesignSilentBridge.js', import.meta.url), 'utf8');
  assert.match(bridge, /'-RuntimeRoot', path\.dirname\(this\.runtimeRoot\)/);
  const launcher = await fs.readFile(new URL('../scripts/Invoke-InDesignScript.ps1', import.meta.url), 'utf8');
  assert.equal(launcher.includes('$env:LOCALAPPDATA'), false);
});

test('le lanceur ne paie la sonde CIM complète que si InDesign n’était pas déjà lancé', async () => {
  const launcher = await fs.readFile(new URL('../scripts/Invoke-InDesignScript.ps1', import.meta.url), 'utf8');
  const module = await fs.readFile(new URL('../scripts/InDesignComLifecycle.psm1', import.meta.url), 'utf8');
  assert.match(launcher, /\$hostProcessesBefore = @\(Get-InDesignHostProcessesFast\)/);
  assert.match(launcher, /\$hostProcessesBefore\.Count -gt 0\) \{ \{ @\(Get-InDesignHostProcessesFast\) \} \} else \{ \{ @\(Get-InDesignHostProcesses\) \} \}/);
  assert.match(launcher, /-SnapshotProvider \$hostProbe/);
  assert.equal((launcher.match(/@\(Get-InDesignHostProcesses\)/g) ?? []).length, 1, 'la sonde complète n’est utilisée que pour un hôte absent');
  assert.match(module, /'Get-InDesignHostProcessesFast'/);
});

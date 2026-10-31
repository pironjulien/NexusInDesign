import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const pluginSource = await fs.readFile(new URL('../plugin/index.js', import.meta.url), 'utf8');

class FakeClock {
  constructor() {
    this.now = 0;
    this.nextId = 0;
    this.tasks = new Map();
  }

  setTimeout(callback, delay = 0) {
    const id = this.nextId++;
    this.tasks.set(id, { callback, at: this.now + Number(delay) });
    return id;
  }

  clearTimeout(id) {
    this.tasks.delete(id);
  }

  runNext() {
    const next = [...this.tasks.entries()].sort((left, right) => left[1].at - right[1].at)[0];
    assert.ok(next, 'aucune minuterie en attente');
    const [id, task] = next;
    this.tasks.delete(id);
    this.now = task.at;
    task.callback();
  }
}

function createElement() {
  const listeners = new Map();
  return {
    textContent: '',
    value: '',
    className: '',
    disabled: false,
    addEventListener(type, callback) { listeners.set(type, callback); },
    trigger(type) {
      const callback = listeners.get(type);
      assert.ok(callback, `écouteur ${type} absent`);
      callback();
    },
  };
}

function asciiBytes(value) {
  return new Uint8Array([...value].map((character) => character.charCodeAt(0)));
}

function createHarness(storedSecret = null, {
  deferSecretLoad = false,
  failSecretLoad = false,
  clipboard = undefined,
  commandRegistry = {},
  executeCommand = async () => ({}),
} = {}) {
  const clock = new FakeClock();
  const sockets = [];
  const logs = [];
  const storedValues = new Map();
  if (storedSecret) storedValues.set('indesign-mcp-shared-secret-v1', asciiBytes(storedSecret));
  let releaseSecretLoad;
  const secretLoadGate = deferSecretLoad
    ? new Promise((resolve) => { releaseSecretLoad = resolve; })
    : Promise.resolve();

  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;

    constructor(url) {
      this.url = url;
      this.readyState = MockWebSocket.CONNECTING;
      this.sent = [];
      sockets.push(this);
    }

    send(payload) {
      this.sent.push(payload);
    }

    close() {
      // Reproduit le comportement UXP observé : une erreur de connexion peut
      // fermer la socket sans émettre ensuite d'événement `close` exploitable.
      this.readyState = MockWebSocket.CLOSED;
    }
  }

  class CommandError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  const elements = Object.fromEntries(
    ['status', 'detail', 'statusDot', 'pairingCode', 'pairButton', 'pastePairButton', 'reconnectButton', 'resetButton']
      .map((id) => [id, createElement()]),
  );
  let panelDefinition;
  let randomByte = 1;
  const customRequire = (specifier) => {
    if (specifier === 'indesign') return { app: {} };
    if (specifier === 'uxp') {
      return {
        entrypoints: { setup(definition) { panelDefinition = definition; } },
        storage: {
          secureStorage: {
            async getItem(key) {
              await secretLoadGate;
              if (failSecretLoad) throw new Error('secureStorage indisponible');
              return storedValues.get(key) ?? null;
            },
            async setItem(key, value) { storedValues.set(key, value); },
            async removeItem(key) { storedValues.delete(key); },
          },
        },
      };
    }
    if (specifier === './commands') {
      return { createCommandRegistry: () => commandRegistry, executeCommand };
    }
    if (specifier === './validation') return { CommandError, assertSafeJson() {} };
    if (specifier === './security-crypto') {
      return {
        bytesToHex: (bytes) => [...bytes].map((value) => value.toString(16).padStart(2, '0')).join(''),
        canonicalCommand: (message, sessionChallenge) => JSON.stringify({ message, sessionChallenge }),
        importHmacKey: async () => ({ mode: 'test' }),
        resolveCryptoApi: () => ({
          getRandomValues(bytes) {
            for (let index = 0; index < bytes.length; index += 1) bytes[index] = randomByte++ % 256;
            return bytes;
          },
        }),
        signHmacHex: async () => 'proof',
        utf8Encode: asciiBytes,
        verifyHmacHex: async () => true,
      };
    }
    throw new Error(`require inattendu : ${specifier}`);
  };

  vm.runInNewContext(pluginSource, {
    console: { log(value) { logs.push(String(value)); } },
    document: { getElementById: (id) => elements[id] },
    navigator: { clipboard },
    require: customRequire,
    WebSocket: MockWebSocket,
    setTimeout: clock.setTimeout.bind(clock),
    clearTimeout: clock.clearTimeout.bind(clock),
    Uint8Array,
    Map,
    Promise,
    Date,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
  }, { filename: 'plugin/index.js' });

  return {
    clock,
    elements,
    sockets,
    storedValues,
    logs,
    getPanelDefinition: () => panelDefinition,
    releaseSecretLoad: () => releaseSecretLoad?.(),
    MockWebSocket,
  };
}

async function flushMicrotasks() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

test('le plugin se reconnecte automatiquement après appairage même si UXP ne signale que onerror', async () => {
  const harness = createHarness();
  await flushMicrotasks();
  assert.equal(harness.sockets.length, 1);

  const pairingSocket = harness.sockets[0];
  pairingSocket.readyState = harness.MockWebSocket.OPEN;
  pairingSocket.onopen();
  harness.elements.pairingCode.value = 'ABCD-EF01-2345-6789';
  harness.elements.pairingCode.trigger('input');
  harness.elements.pairButton.trigger('click');
  await flushMicrotasks();

  const request = JSON.parse(pairingSocket.sent.at(-1));
  assert.equal(request.type, 'pair_request');
  assert.equal(request.pairingCode, 'ABCDEF0123456789');
  const secret = 'A'.repeat(48);
  pairingSocket.onmessage({
    data: JSON.stringify({ type: 'pair_secret', pairingNonce: request.pairingNonce, secret }),
  });
  await flushMicrotasks();
  assert.ok(harness.storedValues.has('indesign-mcp-shared-secret-v1'));

  harness.clock.runNext(); // forceReconnect après enregistrement du secret
  harness.clock.runNext(); // nouvelle tentative 100 ms plus tard
  assert.equal(harness.sockets.length, 2);

  const transientSocket = harness.sockets[1];
  transientSocket.onerror(); // aucun onclose ne suit dans ce scénario UXP
  const timersAfterError = harness.clock.tasks.size;
  transientSocket.onclose(); // un close tardif éventuel reste idempotent
  assert.equal(harness.clock.tasks.size, timersAfterError);
  harness.clock.runNext();
  assert.equal(harness.sockets.length, 3, 'la boucle automatique doit créer une nouvelle socket');

  const standardSocket = harness.sockets[2];
  standardSocket.readyState = harness.MockWebSocket.OPEN;
  standardSocket.onopen();
  const bridgeNonce = 'b'.repeat(32);
  standardSocket.onmessage({ data: JSON.stringify({ type: 'auth_challenge', nonce: bridgeNonce }) });
  await flushMicrotasks();
  const proof = JSON.parse(standardSocket.sent.at(-1));
  assert.equal(proof.type, 'auth_proof');
  standardSocket.onmessage({
    data: JSON.stringify({
      type: 'auth_ok',
      nonce: bridgeNonce,
      pluginNonce: proof.pluginNonce,
      proof: 'bridge-proof',
    }),
  });
  await flushMicrotasks();

  assert.equal(harness.elements.status.textContent, 'Connecte et authentifie');
  assert.equal(JSON.parse(standardSocket.sent.at(-1)).type, 'ready');
});

test('un clic utilisateur lit getContent puis appaire sans conserver ni journaliser le code', async () => {
  const code = 'ABCD-EF01-2345-6789';
  let reads = 0;
  const harness = createHarness(null, {
    clipboard: {
      async getContent() {
        reads += 1;
        return { 'text/plain': code };
      },
    },
  });
  await flushMicrotasks();
  const socket = harness.sockets[0];
  socket.readyState = harness.MockWebSocket.OPEN;
  socket.onopen();

  assert.equal(reads, 0, 'le presse-papiers ne doit jamais être lu sans clic');
  harness.elements.pastePairButton.trigger('click');
  await flushMicrotasks();

  assert.equal(reads, 1);
  const request = JSON.parse(socket.sent.at(-1));
  assert.equal(request.type, 'pair_request');
  assert.equal(request.pairingCode, 'ABCDEF0123456789');
  assert.equal(harness.elements.pairingCode.value, '', 'le code ne doit pas rester dans le panneau après envoi');
  assert.equal(harness.storedValues.size, 0, 'seul le secret final pourra être écrit dans secureStorage');
  assert.equal(harness.logs.join('\n').includes(code), false, 'le code ne doit jamais être journalisé');
  assert.equal(harness.logs.join('\n').includes(request.pairingCode), false, 'le code normalisé ne doit jamais être journalisé');
});

test('un signal serveur borné déclenche exactement une lecture automatique du presse-papiers', async () => {
  const code = 'ABCD-EF01-2345-6789';
  let reads = 0;
  const harness = createHarness(null, {
    clipboard: {
      async getContent() {
        reads += 1;
        return { 'text/plain': code };
      },
    },
  });
  await flushMicrotasks();
  const socket = harness.sockets[0];
  socket.readyState = harness.MockWebSocket.OPEN;
  socket.onopen();
  const signal = {
    type: 'pairing_clipboard_ready',
    trigger: 't'.repeat(43),
    pairingExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  };

  socket.onmessage({ data: JSON.stringify(signal) });
  await flushMicrotasks();

  assert.equal(reads, 1);
  const request = JSON.parse(socket.sent.at(-1));
  assert.equal(request.type, 'pair_request');
  assert.equal(request.pairingCode, 'ABCDEF0123456789');
  assert.equal(harness.elements.pairingCode.value, '');
  assert.equal(harness.logs.join('\n').includes(code), false);
  assert.equal(harness.logs.join('\n').includes(request.pairingCode), false);

  const sentAfterFirstSignal = socket.sent.length;
  socket.onmessage({ data: JSON.stringify(signal) });
  await flushMicrotasks();
  assert.equal(reads, 1, 'un même signal ne doit jamais relire le presse-papiers');
  assert.equal(socket.sent.length, sentAfterFirstSignal);
});

test('un signal automatique périmé ne lit jamais le presse-papiers', async () => {
  let reads = 0;
  const harness = createHarness(null, {
    clipboard: {
      async readText() {
        reads += 1;
        return 'ABCD-EF01-2345-6789';
      },
    },
  });
  await flushMicrotasks();
  const socket = harness.sockets[0];
  socket.readyState = harness.MockWebSocket.OPEN;
  socket.onopen();
  socket.onmessage({
    data: JSON.stringify({
      type: 'pairing_clipboard_ready',
      trigger: 'e'.repeat(43),
      pairingExpiresAt: new Date(Date.now() - 1_000).toISOString(),
    }),
  });
  await flushMicrotasks();

  assert.equal(reads, 0);
  const response = JSON.parse(socket.sent.at(-1));
  assert.equal(response.type, 'protocol_error');
  assert.equal(response.error.code, 'PAIRING_CLIPBOARD_SIGNAL_EXPIRED');
});

test('le presse-papiers UXP retombe sur readText lorsque getContent est indisponible', async () => {
  let getContentReads = 0;
  let textReads = 0;
  const harness = createHarness(null, {
    clipboard: {
      async getContent() {
        getContentReads += 1;
        throw new Error('API héritée indisponible');
      },
      async readText() {
        textReads += 1;
        return '0123 4567 89ab cdef';
      },
    },
  });
  await flushMicrotasks();
  const socket = harness.sockets[0];
  socket.readyState = harness.MockWebSocket.OPEN;
  socket.onopen();

  harness.elements.pastePairButton.trigger('click');
  await flushMicrotasks();

  assert.equal(getContentReads, 1);
  assert.equal(textReads, 1);
  assert.equal(JSON.parse(socket.sent.at(-1)).pairingCode, '0123456789ABCDEF');
});

test('un contenu de presse-papiers invalide est refusé sans envoi ni trace', async () => {
  const clipboardText = 'ceci ne constitue pas un code';
  const harness = createHarness(null, {
    clipboard: { async readText() { return clipboardText; } },
  });
  await flushMicrotasks();
  const socket = harness.sockets[0];
  socket.readyState = harness.MockWebSocket.OPEN;
  socket.onopen();

  harness.elements.pastePairButton.trigger('click');
  await flushMicrotasks();

  assert.equal(socket.sent.length, 0);
  assert.equal(harness.elements.status.textContent, 'Appairage impossible');
  assert.equal(harness.logs.join('\n').includes(clipboardText), false);
  assert.equal(harness.storedValues.size, 0);
});

test('un identifiant de timer égal à zéro est annulé avant la reconnexion', async () => {
  const harness = createHarness('B'.repeat(48));
  await flushMicrotasks();
  assert.equal(harness.clock.tasks.has(0), true, 'le garde-fou initial doit utiliser l’identifiant zéro du mock');

  harness.sockets[0].onerror();
  assert.equal(harness.clock.tasks.has(0), false, 'le timer zéro doit être réellement annulé');
  assert.equal(harness.clock.tasks.size, 1, 'une seule reconnexion doit rester planifiée');
  harness.clock.runNext();
  assert.equal(harness.sockets.length, 2);
});

test('destroy ferme la socket sans créer de reconnexion fantôme', async () => {
  const harness = createHarness('B'.repeat(48));
  await flushMicrotasks();
  const socket = harness.sockets[0];
  const panel = harness.getPanelDefinition().panels.indesignMcpPanel;

  panel.destroy();
  assert.equal(harness.clock.tasks.size, 0);
  socket.onclose();
  assert.equal(harness.clock.tasks.size, 0, 'un close tardif ne doit pas recréer de timer');

  panel.show();
  await flushMicrotasks();
  assert.equal(harness.sockets.length, 2, 'une nouvelle ouverture explicite doit pouvoir redémarrer la connexion');
});

test('destroy invalide la session et annule les commandes encore en file', async () => {
  const executedCommands = [];
  let releaseFirstCommand;
  const firstCommandGate = new Promise((resolve) => { releaseFirstCommand = resolve; });
  const harness = createHarness('B'.repeat(48), {
    commandRegistry: { first_command: {}, second_command: {} },
    executeCommand: async (_registry, _app, command) => {
      executedCommands.push(command);
      if (command === 'first_command') await firstCommandGate;
      return { command };
    },
  });
  await flushMicrotasks();
  const socket = harness.sockets[0];
  socket.readyState = harness.MockWebSocket.OPEN;
  socket.onopen();
  const bridgeNonce = 'q'.repeat(32);
  socket.onmessage({ data: JSON.stringify({ type: 'auth_challenge', nonce: bridgeNonce }) });
  await flushMicrotasks();
  const authProof = JSON.parse(socket.sent.at(-1));
  socket.onmessage({
    data: JSON.stringify({
      type: 'auth_ok',
      nonce: bridgeNonce,
      pluginNonce: authProof.pluginNonce,
      proof: 'bridge-proof',
    }),
  });
  await flushMicrotasks();
  assert.equal(harness.elements.status.textContent, 'Connecte et authentifie');

  socket.onmessage({
    data: JSON.stringify({
      type: 'command',
      id: 'first',
      command: 'first_command',
      nonce: '1'.repeat(32),
      proof: 'proof',
      args: {},
    }),
  });
  for (let attempt = 0; attempt < 20 && executedCommands.length === 0; attempt += 1) {
    await Promise.resolve();
  }
  assert.deepEqual(executedCommands, ['first_command']);

  socket.onmessage({
    data: JSON.stringify({
      type: 'command',
      id: 'second',
      command: 'second_command',
      nonce: '2'.repeat(32),
      proof: 'proof',
      args: {},
    }),
  });
  await flushMicrotasks();
  assert.deepEqual(executedCommands, ['first_command'], 'la seconde commande doit attendre dans la file');

  const sentBeforeDestroy = socket.sent.length;
  harness.getPanelDefinition().panels.indesignMcpPanel.destroy();
  releaseFirstCommand();
  await flushMicrotasks();

  assert.deepEqual(executedCommands, ['first_command'], 'aucune commande en attente ne doit survivre à destroy');
  assert.equal(socket.sent.length, sentBeforeDestroy, 'la commande en cours ne doit pas répondre après invalidation de session');
  assert.equal(harness.clock.tasks.size, 0, 'destroy ne doit laisser ni reprise de file ni reconnexion');
});

test('un ancien secret n’empêche pas de saisir le nouveau code hors canal', async () => {
  const harness = createHarness('C'.repeat(48));
  await flushMicrotasks();
  assert.equal(harness.sockets.length, 1);

  const staleSocket = harness.sockets[0];
  staleSocket.readyState = harness.MockWebSocket.OPEN;
  staleSocket.onopen();
  staleSocket.onmessage({ data: JSON.stringify({ type: 'auth_challenge', nonce: 's'.repeat(32) }) });
  await flushMicrotasks();
  assert.equal(JSON.parse(staleSocket.sent.at(-1)).type, 'auth_proof');

  harness.elements.pairingCode.value = '0123-4567-89AB-CDEF';
  harness.elements.pairingCode.trigger('input');
  assert.equal(harness.elements.pairButton.disabled, false, 'le secret périmé ne doit pas bloquer le renouvellement');
  harness.elements.pairButton.trigger('click');
  await flushMicrotasks();

  harness.clock.runNext();
  assert.equal(harness.sockets.length, 2);
  const renewedSocket = harness.sockets[1];
  renewedSocket.readyState = harness.MockWebSocket.OPEN;
  renewedSocket.onopen();
  renewedSocket.onmessage({ data: JSON.stringify({ type: 'auth_challenge', nonce: 'n'.repeat(32) }) });
  await flushMicrotasks();

  const request = JSON.parse(renewedSocket.sent.at(-1));
  assert.equal(request.type, 'pair_request');
  assert.equal(request.pairingCode, '0123456789ABCDEF');
});

test('show attend la lecture de secureStorage avant de créer la première socket', async () => {
  const harness = createHarness('D'.repeat(48), { deferSecretLoad: true });
  const panel = harness.getPanelDefinition().panels.indesignMcpPanel;
  panel.show();
  await flushMicrotasks();
  assert.equal(harness.sockets.length, 0, 'aucun challenge ne doit précéder loadSecret');

  harness.releaseSecretLoad();
  await flushMicrotasks();
  assert.equal(harness.sockets.length, 1, 'show et le démarrage automatique partagent une seule initialisation');
});

test('une panne secureStorage ne lance aucune socket et interdit l’appairage', async () => {
  const harness = createHarness(null, { failSecretLoad: true });
  await flushMicrotasks();
  harness.getPanelDefinition().panels.indesignMcpPanel.show();
  await flushMicrotasks();
  assert.equal(harness.sockets.length, 0);
  assert.equal(harness.elements.status.textContent, 'Initialisation impossible');
  assert.equal(harness.elements.pairButton.disabled, true);
});

test('une socket UXP bloquée en connexion est abandonnée puis retentée', async () => {
  const harness = createHarness('B'.repeat(48));
  await flushMicrotasks();
  assert.equal(harness.sockets.length, 1);

  harness.clock.runNext(); // expiration du garde-fou de connexion
  harness.clock.runNext(); // temporisation de reconnexion
  assert.equal(harness.sockets.length, 2);
});

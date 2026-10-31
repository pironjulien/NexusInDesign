import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApplication } from '../src/server/createApplication.js';
import { createInddFixture } from './helpers/artifactFixtures.js';
import { PACKAGE_VERSION } from '../src/version.js';

test('une panne du canal silencieux ne bloque pas le serveur MCP existant', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-silent-fallback-'));
  const readRoot = path.join(directory, 'read');
  const writeRoot = path.join(directory, 'write');
  const secureRoot = path.join(directory, 'secure');
  await Promise.all([fs.mkdir(readRoot), fs.mkdir(writeRoot), fs.mkdir(secureRoot)]);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const application = await createApplication({
    env: {
      INDESIGN_MCP_TOKEN_FILE: path.join(secureRoot, 'token'),
      INDESIGN_MCP_BACKUP_ROOT: path.join(secureRoot, 'backups'),
      INDESIGN_MCP_READ_ROOTS: readRoot,
      INDESIGN_MCP_WRITE_ROOTS: writeRoot,
      INDESIGN_MCP_PORT: '0',
      INDESIGN_MCP_COMMAND_TIMEOUT_MS: '1000',
    },
    verifyParent: async () => ({ verified: true }),
    transportFactory: () => serverTransport,
    silentBridgeFactory: () => ({ initialize: async () => { throw new Error('indisponible'); } }),
  });
  const client = new Client({ name: 'fallback-test', version: '1.0.0' });
  t.after(async () => {
    await client.close().catch(() => {});
    await application.close().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });

  await application.start();
  await client.connect(clientTransport);
  const legacy = await client.callTool({ name: 'bridge_status', arguments: {} });
  assert.equal(legacy.structuredContent.listening, true);
  const silent = await client.callTool({ name: 'silent_status', arguments: {} });
  assert.equal(silent.structuredContent.available, false);
  assert.match(silent.structuredContent.message, /plugin UXP existant reste opérationnel/);
});

test('une collision du port plugin ne bloque plus le canal silencieux', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-plugin-fallback-'));
  const readRoot = path.join(directory, 'read');
  const writeRoot = path.join(directory, 'write');
  const secureRoot = path.join(directory, 'secure');
  await Promise.all([fs.mkdir(readRoot), fs.mkdir(writeRoot), fs.mkdir(secureRoot)]);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const application = await createApplication({
    env: {
      INDESIGN_MCP_TOKEN_FILE: path.join(secureRoot, 'token'),
      INDESIGN_MCP_BACKUP_ROOT: path.join(secureRoot, 'backups'),
      INDESIGN_MCP_READ_ROOTS: readRoot,
      INDESIGN_MCP_WRITE_ROOTS: writeRoot,
      INDESIGN_MCP_PORT: '33171',
      INDESIGN_MCP_COMMAND_TIMEOUT_MS: '1000',
    },
    verifyParent: async () => ({ verified: true }),
    transportFactory: () => serverTransport,
    silentBridgeFactory: () => ({
      initialize: async () => {},
      status: async () => ({ mode: 'silent-com-uxp', version: '21.4.1.4', openDocuments: 0 }),
      close: async () => {},
    }),
    bridgeFactory: () => ({
      start: async () => { throw Object.assign(new Error('port occupé'), { code: 'EADDRINUSE' }); },
      close: async () => {},
    }),
    portOwnerLookup: async ({ host, port }) => {
      assert.equal(host, '127.0.0.1');
      assert.equal(port, 33171);
      return 4242;
    },
  });
  const client = new Client({ name: 'plugin-fallback-test', version: '1.0.0' });
  t.after(async () => {
    await client.close().catch(() => {});
    await application.close().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });

  await application.start();
  await client.connect(clientTransport);
  const plugin = await client.callTool({ name: 'bridge_status', arguments: {} });
  assert.equal(plugin.structuredContent.available, false);
  assert.equal(plugin.structuredContent.reason, 'EADDRINUSE');
  assert.equal(plugin.structuredContent.code, 'EADDRINUSE');
  assert.equal(plugin.structuredContent.port, 33171);
  assert.equal(plugin.structuredContent.listenerOwnerPid, 4242);
  assert.equal(plugin.structuredContent.listenerOwnedByThisInstance, false);
  assert.equal(plugin.structuredContent.ownsPluginSession, false);
  assert.equal('connected' in plugin.structuredContent, false);
  assert.equal('authenticated' in plugin.structuredContent, false);
  const pairing = await client.callTool({
    name: 'bridge_open_pairing_window',
    arguments: { windowSeconds: 120, reason: 'Refuser la seconde instance d’appairage' },
  });
  assert.equal(pairing.isError, true);
  assert.match(pairing.content[0].text, /PAIRING_LISTENER_NOT_OWNED/);
  assert.match(pairing.content[0].text, /PID 4242/);
  const doctor = await client.callTool({ name: 'indesign_doctor', arguments: {} });
  const doctorPlugin = doctor.structuredContent.channels.plugin;
  assert.equal(doctorPlugin.available, false);
  assert.equal(doctorPlugin.reason, 'EADDRINUSE');
  assert.equal(doctorPlugin.code, 'EADDRINUSE');
  assert.equal(doctorPlugin.listenerOwnerPid, 4242);
  assert.equal(doctorPlugin.listenerOwnedByThisInstance, false);
  assert.equal(doctorPlugin.ownsPluginSession, false);
  assert.equal('connected' in doctorPlugin, false);
  assert.equal('authenticated' in doctorPlugin, false);
  const pluginCheck = doctor.structuredContent.checks.find((entry) => entry.id === 'plugin-channel');
  assert.equal(pluginCheck.status, 'unavailable');
  assert.equal(pluginCheck.code, 'EADDRINUSE');
  const silent = await client.callTool({ name: 'silent_status', arguments: {} });
  assert.equal(silent.structuredContent.available, true);
  assert.equal(silent.structuredContent.version, '21.4.1.4');
});

test('une collision du port rejoint le courtier partagé et conserve tous les outils plugin', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-plugin-broker-'));
  const readRoot = path.join(directory, 'read');
  const writeRoot = path.join(directory, 'write');
  const secureRoot = path.join(directory, 'secure');
  await Promise.all([fs.mkdir(readRoot), fs.mkdir(writeRoot), fs.mkdir(secureRoot)]);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let sharedOptions;
  const sharedCalls = [];
  const sharedBridge = {
    start: async () => {},
    close: async () => {},
    status: () => ({
      available: true,
      listening: false,
      connected: true,
      authenticated: true,
      pluginVersion: PACKAGE_VERSION,
      port: 33171,
      brokerRole: 'client',
      brokerConnected: true,
      brokerOwnerPid: 4242,
      sharedConnection: true,
    }),
    refreshStatus() { return this.status(); },
    execute: async (command) => {
      sharedCalls.push(command);
      return { result: { pong: true, via: 'broker' } };
    },
    openPairingWindow: async () => ({ ok: true, pairingActive: true, via: 'broker' }),
  };
  const application = await createApplication({
    env: {
      INDESIGN_MCP_TOKEN_FILE: path.join(secureRoot, 'token'),
      INDESIGN_MCP_BACKUP_ROOT: path.join(secureRoot, 'backups'),
      INDESIGN_MCP_READ_ROOTS: readRoot,
      INDESIGN_MCP_WRITE_ROOTS: writeRoot,
      INDESIGN_MCP_PORT: '33171',
      INDESIGN_MCP_COMMAND_TIMEOUT_MS: '1000',
    },
    verifyParent: async () => ({ verified: true }),
    transportFactory: () => serverTransport,
    silentBridgeFactory: () => ({ initialize: async () => {}, close: async () => {} }),
    bridgeFactory: () => ({
      start: async () => { throw Object.assign(new Error('port occupé'), { code: 'EADDRINUSE' }); },
      close: async () => {},
    }),
    sharedBridgeFactory: (options) => {
      sharedOptions = options;
      return sharedBridge;
    },
    portOwnerLookup: async () => 4242,
  });
  const client = new Client({ name: 'plugin-broker-test', version: '1.0.0' });
  t.after(async () => {
    await client.close().catch(() => {});
    await application.close().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });

  await application.start();
  await client.connect(clientTransport);
  assert.equal(sharedOptions.expectedOwnerPid, 4242);
  const status = await client.callTool({ name: 'bridge_status', arguments: {} });
  assert.equal(status.structuredContent.available, true);
  assert.equal(status.structuredContent.sharedConnection, true);
  assert.equal(status.structuredContent.brokerRole, 'client');
  assert.equal(status.structuredContent.listenerOwnedByThisInstance, false);
  assert.equal(status.structuredContent.ownsPluginSession, false);
  assert.equal(status.structuredContent.pluginSessionUsable, true);
  const ping = await client.callTool({ name: 'ping', arguments: {} });
  assert.equal(ping.structuredContent.pong, true);
  assert.equal(ping.structuredContent.via, 'broker');
  assert.equal(sharedCalls.at(-1).command, 'ping');
});

test('open_document reste opérationnel par le canal silencieux quand le plugin est indisponible', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-open-fallback-'));
  const readRoot = path.join(directory, 'read');
  const writeRoot = path.join(directory, 'write');
  const secureRoot = path.join(directory, 'secure');
  await Promise.all([fs.mkdir(readRoot), fs.mkdir(writeRoot), fs.mkdir(secureRoot)]);
  const documentPath = path.join(readRoot, 'source.indd');
  await fs.writeFile(documentPath, createInddFixture());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let openedPath;
  const application = await createApplication({
    env: {
      INDESIGN_MCP_TOKEN_FILE: path.join(secureRoot, 'token'),
      INDESIGN_MCP_BACKUP_ROOT: path.join(secureRoot, 'backups'),
      INDESIGN_MCP_READ_ROOTS: readRoot,
      INDESIGN_MCP_WRITE_ROOTS: writeRoot,
      INDESIGN_MCP_PORT: '33171',
      INDESIGN_MCP_COMMAND_TIMEOUT_MS: '1000',
    },
    verifyParent: async () => ({ verified: true }),
    transportFactory: () => serverTransport,
    silentBridgeFactory: () => ({
      initialize: async () => {},
      openDocument: async (candidate) => {
        openedPath = candidate;
        return { success: true, documentId: 81, revision: 0, stateToken: 'a'.repeat(16), alreadyOpen: false };
      },
      close: async () => {},
    }),
    bridgeFactory: () => ({
      start: async () => { throw Object.assign(new Error('port occupé'), { code: 'EADDRINUSE' }); },
      close: async () => {},
    }),
  });
  const client = new Client({ name: 'silent-open-test', version: '1.0.0' });
  t.after(async () => {
    await client.close().catch(() => {});
    await application.close().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });

  await application.start();
  await client.connect(clientTransport);
  const plugin = await client.callTool({ name: 'bridge_status', arguments: {} });
  assert.equal(plugin.structuredContent.available, false);
  const opened = await client.callTool({ name: 'open_document', arguments: { expectedRevision: 0, path: documentPath } });
  assert.equal(opened.isError, undefined);
  assert.equal(opened.structuredContent.documentId, 81);
  assert.equal(opened.structuredContent.revision, 0);
  assert.equal(openedPath, await fs.realpath(documentPath));
});

test('create_document passe par le canal silencieux quand le plugin n’est pas jumelé', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-create-fallback-'));
  const readRoot = path.join(directory, 'read');
  const writeRoot = path.join(directory, 'write');
  const secureRoot = path.join(directory, 'secure');
  await Promise.all([fs.mkdir(readRoot), fs.mkdir(writeRoot), fs.mkdir(secureRoot)]);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const requests = [];
  const application = await createApplication({
    env: {
      INDESIGN_MCP_TOKEN_FILE: path.join(secureRoot, 'token'),
      INDESIGN_MCP_BACKUP_ROOT: path.join(secureRoot, 'backups'),
      INDESIGN_MCP_READ_ROOTS: readRoot,
      INDESIGN_MCP_WRITE_ROOTS: writeRoot,
      INDESIGN_MCP_PORT: '33172',
      INDESIGN_MCP_COMMAND_TIMEOUT_MS: '1000',
    },
    verifyParent: async () => ({ verified: true }),
    transportFactory: () => serverTransport,
    silentBridgeFactory: () => ({
      initialize: async () => {},
      createDocument: async (spec) => {
        requests.push(spec);
        return { success: true, documentId: 82, revision: 0, stateToken: 'c'.repeat(16), executionChannel: 'silent' };
      },
      close: async () => {},
    }),
    bridgeFactory: () => ({
      start: async () => { throw Object.assign(new Error('port occupé'), { code: 'EADDRINUSE' }); },
      close: async () => {},
    }),
  });
  const client = new Client({ name: 'silent-create-test', version: '1.0.0' });
  t.after(async () => {
    await client.close().catch(() => {});
    await application.close().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });

  await application.start();
  await client.connect(clientTransport);
  const created = await client.callTool({ name: 'create_document', arguments: { expectedRevision: 0, width: 210, height: 297 } });
  assert.equal(created.isError, undefined);
  assert.equal(created.structuredContent.documentId, 82);
  assert.equal(created.structuredContent.revision, 0);
  assert.equal(created.structuredContent.stateToken, 'c'.repeat(16));
  assert.deepEqual(requests[0], { width: 210, height: 297, pageCount: 1, facingPages: true, units: 'mm', margins: [12, 12, 12, 12], bleed: [3, 3, 3, 3] });

  const existing = path.join(writeRoot, 'existe.indd');
  await fs.writeFile(existing, createInddFixture());
  const refused = await client.callTool({ name: 'create_document', arguments: { expectedRevision: 0, width: 210, height: 297, path: existing } });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /TARGET_EXISTS/);
  const outside = await client.callTool({ name: 'create_document', arguments: { expectedRevision: 0, width: 210, height: 297, path: path.join(readRoot, 'hors.indd') } });
  assert.equal(outside.isError, true);
  assert.equal(requests.length, 1);
});

test('les lectures, l’audit, le préflight et la fermeture restent disponibles sans plugin', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-read-fallback-'));
  const readRoot = path.join(directory, 'read');
  const writeRoot = path.join(directory, 'write');
  const secureRoot = path.join(directory, 'secure');
  await Promise.all([fs.mkdir(readRoot), fs.mkdir(writeRoot), fs.mkdir(secureRoot)]);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const calls = [];
  const layoutSnapshot = {
    success: true, documentId: 7, revision: 2, capturedAt: '2026-07-14T00:00:00.000Z',
    document: { id: 7, name: 'preuve.indd', path: 'C:\\preuve.indd', modified: false, pageCount: 1, spreadCount: 1, facingPages: false, widthMm: 148, heightMm: 210, bleedMm: { top: 3, inside: 3, bottom: 3, outside: 3 } },
    pages: [{ id: 11, index: 0, name: '1', bounds: [0, 0, 210, 148], widthMm: 148, heightMm: 210, margins: { top: 10, left: 10, bottom: 10, right: 10 }, columns: { count: 1, gutterMm: 4 }, appliedMaster: null }],
    items: [], links: [], fonts: [], images: [], designSystem: { layers: [], swatches: [], paragraphStyles: [], characterStyles: [], objectStyles: [] }, totalItems: 0, truncated: false,
  };
  const readResults = {
    get_document_info: { success: true, documentId: 7, revision: 2, document: { id: 7, name: 'preuve.indd', path: 'C:\\preuve.indd', pages: 1, spreads: 1, layers: 1, masterSpreads: 1, widthMm: 148, heightMm: 210, facingPages: false, modified: false } },
    list_pages: { success: true, documentId: 7, revision: 2, pages: [{ id: 11, pageId: 11, index: 0, name: '1', bounds: [0, 0, 210, 148], appliedMaster: null }] },
    get_links: { success: true, documentId: 7, revision: 2, links: [] },
    get_fonts: { success: true, documentId: 7, revision: 2, fonts: [] },
    get_overset_text: { success: true, documentId: 7, revision: 2, count: 0, frames: [] },
    get_images: { success: true, documentId: 7, revision: 2, images: [] },
  };
  const application = await createApplication({
    env: {
      INDESIGN_MCP_TOKEN_FILE: path.join(secureRoot, 'token'),
      INDESIGN_MCP_BACKUP_ROOT: path.join(secureRoot, 'backups'),
      INDESIGN_MCP_READ_ROOTS: readRoot,
      INDESIGN_MCP_WRITE_ROOTS: writeRoot,
      INDESIGN_MCP_PORT: '33172',
      INDESIGN_MCP_COMMAND_TIMEOUT_MS: '1000',
    },
    verifyParent: async () => ({ verified: true }),
    transportFactory: () => serverTransport,
    silentBridgeFactory: () => ({
      initialize: async () => {},
      acquireExternalMutationLease: async () => {},
      withExpectedExternalLease: async (_operationId, callback) => callback(),
      releaseExternalMutationLease: async () => {},
      transferExternalMutationLease: async () => {},
      readDocument: async (name) => {
        calls.push(name);
        return name === 'analyze_layout' ? layoutSnapshot : readResults[name];
      },
      auditDocument: async () => {
        calls.push('silent_audit_document');
        return { ...layoutSnapshot, stateToken: 'a'.repeat(16), counts: { pages: 1, spreads: 1, layers: 1, masterSpreads: 1 }, oversetText: { count: 0, frames: [] }, inspectedItems: 0 };
      },
      preflightDocument: async () => {
        calls.push('preflight_document');
        return { success: true, documentId: 7, revision: 2, profile: 'Contrôle', aggregatedResults: ['preuve.indd', 'Contrôle', []], processResults: 'completed', operationId: 'ignored' };
      },
      closeDocument: async (args) => {
        calls.push('silent_close_document');
        assert.equal(args.save, false);
        return { success: true, closedDocumentId: 7, saved: false, operationId: crypto.randomUUID() };
      },
      close: async () => {},
    }),
    bridgeFactory: () => ({
      start: async () => { throw Object.assign(new Error('plugin absent'), { code: 'EADDRINUSE' }); },
      close: async () => {},
    }),
  });
  const client = new Client({ name: 'silent-read-test', version: '1.0.0' });
  t.after(async () => {
    await client.close().catch(() => {});
    await application.close().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });

  await application.start();
  await client.connect(clientTransport);
  for (const name of Object.keys(readResults)) {
    const result = await client.callTool({ name, arguments: { documentId: 7 } });
    assert.equal(result.isError, undefined, name);
  }
  const analysis = await client.callTool({ name: 'analyze_layout', arguments: { documentId: 7 } });
  assert.equal(analysis.structuredContent.lint.passed, true);
  const audit = await client.callTool({ name: 'silent_audit_document', arguments: { documentId: 7 } });
  assert.equal(audit.structuredContent.stateToken, 'a'.repeat(16));
  const preflight = await client.callTool({ name: 'preflight_document', arguments: { documentId: 7 } });
  assert.deepEqual(preflight.structuredContent.aggregatedResults[2], []);
  assert.equal(preflight.structuredContent.operationId, undefined);
  const closed = await client.callTool({ name: 'silent_close_document', arguments: { documentId: 7, expectedRevision: 2, expectedStateToken: 'a'.repeat(16), save: false, reason: 'Fermer le document de preuve' } });
  assert.equal(closed.structuredContent.saved, false);
  for (const expected of [...Object.keys(readResults), 'analyze_layout', 'silent_audit_document', 'preflight_document', 'silent_close_document']) assert.ok(calls.includes(expected), expected);
});

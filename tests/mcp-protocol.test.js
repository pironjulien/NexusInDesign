import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WebSocket } from 'ws';
import { EXPECTED_UXP_ORIGIN } from '../src/bridge/InDesignBridge.js';
import { createApplication } from '../src/server/createApplication.js';
import { commandSignature, hmac, safeEqual } from '../src/security/crypto.js';
import { createInddFixture, createMinimalIdml, createMinimalPdf, createRgbaPng } from './helpers/artifactFixtures.js';
import { PACKAGE_VERSION } from '../src/version.js';

function waitMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => resolve(JSON.parse(data.toString())));
    socket.once('error', reject);
  });
}

function fakeOperationMutexHarness() {
  const guards = new Set();
  let nextProcessId = 50_000;
  const factory = async (options) => {
    let resolveExit;
    const exit = new Promise((resolve) => { resolveExit = resolve; });
    const operationId = path.basename(options.operationPath, '.jsonl');
    const markerPath = path.join(
      path.dirname(options.operationPath),
      `${operationId}.${options.releaseNonce}.release.json`,
    );
    const guard = { timer: undefined, resolveExit };
    let checking = false;
    guard.timer = setInterval(async () => {
      if (checking) return;
      checking = true;
      try {
        const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
        if (
          marker.operationId === operationId
          && marker.releaseNonce === options.releaseNonce
          && marker.status === 'acknowledged'
        ) {
          resolveExit({ code: 0, signal: null });
        }
      } catch {}
      checking = false;
    }, 5);
    guard.timer.unref?.();
    guards.add(guard);
    void exit.finally(() => {
      clearInterval(guard.timer);
      guards.delete(guard);
    });
    return {
      processId: nextProcessId += 1,
      mutex: 'test-in-memory',
      status: options.expectedGuardProcessId ? 'watching' : 'acquired',
      guardedProcessId: options.expectedGuardProcessId,
      exit,
    };
  };
  const close = () => {
    for (const guard of guards) {
      clearInterval(guard.timer);
      guard.resolveExit({ code: 0, signal: null });
    }
    guards.clear();
  };
  return { factory, close };
}

test('MCP STDIO simulé pilote un plugin WS authentifié, signé, FIFO et sauvegardé', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-mcp-integration-'));
  const readRoot = path.join(directory, 'read');
  const writeRoot = path.join(directory, 'write');
  const secureRoot = path.join(directory, 'secure');
  await Promise.all([fs.mkdir(readRoot), fs.mkdir(writeRoot), fs.mkdir(secureRoot)]);
  const tokenFile = path.join(secureRoot, 'token');
  const auditFile = path.join(secureRoot, 'audit', 'events.jsonl');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const documentStates = new Map([
    [17, { documentId: 17, revision: 3, stateToken: '1'.repeat(16) }],
    [21, { documentId: 21, revision: 5, stateToken: '2'.repeat(16) }],
    [22, { documentId: 22, revision: 8, stateToken: '3'.repeat(16) }],
  ]);
  const activeExternalLeases = new Set();
  const externalLeaseContexts = [];
  const silentInspectionLeaseIds = [];
  const silentExports = [];
  let currentExternalLease;
  const fakeSilent = {
    initialize: async () => {}, close: async () => {},
    acquireExternalMutationLease: async (operationId) => { activeExternalLeases.add(operationId); },
    withExpectedExternalLease: async (operationId, callback) => {
      assert.equal(activeExternalLeases.has(operationId), true, 'Application doit entrer dans le contexte du lease acquis');
      externalLeaseContexts.push(operationId);
      const previous = currentExternalLease;
      currentExternalLease = operationId;
      try { return await callback(); } finally { currentExternalLease = previous; }
    },
    releaseExternalMutationLease: async (operationId) => activeExternalLeases.delete(operationId),
    transferExternalMutationLease: async (currentOperationId, nextOperationId) => {
      activeExternalLeases.delete(currentOperationId);
      activeExternalLeases.add(nextOperationId);
    },
    listDocuments: async () => ({
      documents: [...documentStates.values()].map(({ documentId, revision }) => ({ documentId, revision })),
    }),
    inspectDocument: async (documentId) => {
      if (currentExternalLease) silentInspectionLeaseIds.push(currentExternalLease);
      const document = documentStates.get(documentId);
      if (!document) {
        const error = new Error('Document simulé introuvable');
        error.code = 'DOCUMENT_NOT_FOUND';
        throw error;
      }
      return { document: { ...document } };
    },
    withSilentMutationLease: async (_operationId, callback) => callback(),
    exportDocument: async (request) => {
      silentExports.push(request);
      assert.equal(request.command, 'package_document');
      await fs.writeFile(path.join(request.folderPath, 'package.indd'), 'indd-package');
      const state = documentStates.get(request.documentId);
      return { ok: true, result: { success: true, folderPath: request.folderPath }, documentId: request.documentId, revision: state.revision, stateToken: state.stateToken, safetyBackups: [] };
    },
    registerExternalBackup: async ({ backupId }) => ({
      metadataPath: path.join(secureRoot, 'backups', `backup-${backupId}.json`),
      artifact: { sha256: 'a'.repeat(64) },
    }),
  };
  let parentVerified = false;
  const operationMutex = fakeOperationMutexHarness();
  const application = await createApplication({
    env: {
      INDESIGN_MCP_TOKEN_FILE: tokenFile,
      INDESIGN_MCP_BACKUP_ROOT: path.join(secureRoot, 'backups'),
      INDESIGN_MCP_READ_ROOTS: readRoot,
      INDESIGN_MCP_WRITE_ROOTS: writeRoot,
      INDESIGN_MCP_PORT: '0',
      INDESIGN_MCP_COMMAND_TIMEOUT_MS: '1000',
      INDESIGN_MCP_AUDIT_FILE: auditFile,
      INDESIGN_MCP_ALLOWED_PARENT_PATHS: 'C:\\Program Files\\OpenAI\\Codex.exe',
      INDESIGN_MCP_TOOL_PROFILE: 'full',
    },
    verifyParent: async () => { parentVerified = true; return { verified: true }; },
    operationMutexGuardFactory: operationMutex.factory,
    transportFactory: () => serverTransport,
    silentBridgeFactory: () => fakeSilent,
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  t.after(async () => {
    await client.close().catch(() => {});
    await application.close().catch(() => {});
    operationMutex.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  await application.start();
  const expectedBackupRoot = await fs.realpath(path.join(secureRoot, 'backups'));
  await client.connect(clientTransport);
  assert.equal(parentVerified, true);
  const pairingWindow = await client.callTool({
    name: 'bridge_open_pairing_window',
    arguments: { windowSeconds: 30, reason: 'Renouveler le lien UXP depuis l’instance propriétaire' },
  });
  assert.equal(pairingWindow.isError, undefined, JSON.stringify(pairingWindow));
  assert.equal(pairingWindow.structuredContent.pairingActive, true);
  assert.equal(pairingWindow.structuredContent.windowSeconds, 30);
  assert.match(pairingWindow.structuredContent.pairingExpiresAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(pairingWindow.structuredContent.pairingCode, /^[A-F0-9]{4}(?:-[A-F0-9]{4}){3}$/);
  assert.equal(pairingWindow.structuredContent.pairingAttempts, 3);
  const pairingCode = pairingWindow.structuredContent.pairingCode;
  const secret = (await fs.readFile(tokenFile, 'utf8')).trim();
  const port = application.bridge.address().port;
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin: EXPECTED_UXP_ORIGIN });
  const challengePromise = waitMessage(socket);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  t.after(() => socket.close());

  const challenge = await challengePromise;
  assert.equal(challenge.type, 'auth_challenge');
  const pluginId = 'fr.pironjulien.indesign.mcp';
  const version = PACKAGE_VERSION;
  const pluginNonce = 'plugin-session-nonce-'.padEnd(48, 'p');
  const sessionChallenge = `${challenge.nonce}:${pluginNonce}`;
  const authOkPromise = waitMessage(socket);
  socket.send(JSON.stringify({
    type: 'auth_proof',
    pluginId,
    version,
    nonce: challenge.nonce,
    pluginNonce,
    proof: hmac(secret, `plugin:${challenge.nonce}:${pluginNonce}:${pluginId}:${version}`),
  }));
  const authOk = await authOkPromise;
  assert.equal(authOk.type, 'auth_ok');
  assert.equal(authOk.pluginNonce, pluginNonce);
  assert.ok(safeEqual(authOk.proof, hmac(secret, `bridge:${challenge.nonce}:${pluginNonce}:${pluginId}:${version}`)));

  const received = [];
  socket.on('message', async (data) => {
    const message = JSON.parse(data.toString());
    if (message.type !== 'command') return;
    received.push(message);
    assert.equal(typeof message.documentId === 'number' || message.documentId === undefined, true);
    const expectedProof = commandSignature(secret, { ...message, sessionChallenge });
    assert.ok(safeEqual(message.proof, expectedProof));
    if (message.command === 'create_safety_backup') {
      assert.equal(message.args.backupDirectory, expectedBackupRoot);
      const backupId = String(received.length).padStart(36, 'a');
      const backupPath = path.join(secureRoot, 'backups', `backup-${backupId}.indd`);
      await fs.writeFile(backupPath, createInddFixture());
      socket.send(JSON.stringify({ type: 'result', id: message.id, result: { backupId, backupPath, documentId: message.documentId, revision: message.expectedRevision } }));
    } else if (message.command === 'list_documents') {
      const documents = [...documentStates.values()].map(({ documentId, revision }) => ({ documentId, revision }));
      socket.send(JSON.stringify({ type: 'result', id: message.id, result: { success: true, documents } }));
    } else if (message.command === 'get_document_info') {
      socket.send(JSON.stringify({ type: 'result', id: message.id, result: { success: true, documentId: message.documentId, revision: message.expectedRevision, pages: 2 } }));
    } else if (message.command === 'execute_uxp') {
      if (message.args.scope === 'document') assert.ok(message.args.backupId);
      else assert.ok(Array.isArray(message.args.backupIds));
      for (const [documentId, state] of documentStates) {
        documentStates.set(documentId, { ...state, revision: state.revision + 1 });
      }
      const revisions = [...documentStates.values()].map(({ documentId, revision }) => ({ documentId, revision }));
      const returnedDocumentStates = [...documentStates.values()].map(({ documentId, revision, stateToken }) => ({ documentId, revision, stateToken }));
      const targetRevision = Number.isInteger(message.documentId) ? documentStates.get(message.documentId)?.revision : undefined;
      const codeSha256 = createHash('sha256').update(message.args.code, 'utf8').digest('hex');
      socket.send(JSON.stringify({
        type: 'result',
        id: message.id,
        result: {
          success: true,
          value: 42,
          documentId: message.documentId,
          revision: targetRevision,
          revisions,
          documentStates: returnedDocumentStates,
          _execution: {
            codeSha256,
            payloadHasActiveDocument: /\bapp\.activeDocument\b/.test(message.args.code),
            payloadHasTargetDocument: /\btargetDocument\b/.test(message.args.code),
            requestedDocumentId: message.documentId ?? null,
            resolvedTargetDocumentId: message.documentId ?? null,
            activeDocumentIdBefore: message.documentId ?? null,
            activeDocumentIdAfter: message.documentId ?? null,
            resolutionMethod: message.documentId === undefined ? 'application' : 'itemByID.getElements',
            usedUndoTransaction: false,
          },
        },
      }));
    } else if (message.command === 'restore_safety_backup') {
      assert.notEqual(message.args.backupId, message.args.recoveryBackupId);
      assert.match(message.args.workingCopyPath, /[\\/]restored[\\/]restore-[a-f0-9-]{36}\.indd$/);
      assert.equal((await fs.stat(message.args.workingCopyPath)).isFile(), true);
      documentStates.delete(message.documentId);
      documentStates.set(99, { documentId: 99, revision: 3, stateToken: '5'.repeat(16) });
      socket.send(JSON.stringify({ type: 'result', id: message.id, result: { success: true, restoredDocumentId: 99, revision: 3, stateToken: documentStates.get(99).stateToken } }));
    } else if (message.command === 'create_document') {
      documentStates.set(55, { documentId: 55, revision: 0, stateToken: '6'.repeat(16) });
      socket.send(JSON.stringify({ type: 'result', id: message.id, result: { success: true, documentId: 55, revision: 0, stateToken: documentStates.get(55).stateToken } }));
    } else if (message.command === 'create_layer') {
      const current = documentStates.get(message.documentId);
      const updated = { ...current, revision: current.revision + 1, stateToken: '4'.repeat(16) };
      documentStates.set(message.documentId, updated);
      socket.send(JSON.stringify({ type: 'result', id: message.id, result: { success: true, documentId: message.documentId, revision: updated.revision, stateToken: updated.stateToken } }));
    } else if (message.command === 'close_document') {
      documentStates.delete(message.documentId);
      socket.send(JSON.stringify({ type: 'result', id: message.id, result: { success: true, closedDocumentId: message.documentId } }));
    } else if (message.command === 'export_pdf') {
      await fs.writeFile(message.args.filePath, createMinimalPdf());
      socket.send(JSON.stringify({ type: 'result', id: message.id, result: { success: true, documentId: message.documentId, revision: message.expectedRevision, stateToken: documentStates.get(message.documentId).stateToken } }));
    } else if (message.command === 'export_idml') {
      await fs.writeFile(message.args.filePath, createMinimalIdml());
      socket.send(JSON.stringify({ type: 'result', id: message.id, result: { success: true, documentId: message.documentId, revision: message.expectedRevision, stateToken: documentStates.get(message.documentId).stateToken } }));
    } else if (message.command === 'export_png') {
      const png = createRgbaPng();
      const paths = [];
      if (message.args.folderPath?.endsWith('sortie-partielle-inconnue')) {
        const partialPath = path.join(message.args.folderPath, 'page-001.png');
        await fs.writeFile(partialPath, png);
        socket.close(1011, 'test_unknown_outcome');
        return;
      }
      if (message.args.filePath) {
        await fs.writeFile(message.args.filePath, png);
        paths.push(message.args.filePath);
      } else {
        const count = message.args.pageRange === '1-2' ? 2 : 1;
        for (let index = 1; index <= count; index += 1) {
          const exportedPath = path.join(message.args.folderPath, `page-${String(index).padStart(3, '0')}.png`);
          await fs.writeFile(exportedPath, png);
          paths.push(exportedPath);
        }
      }
      socket.send(JSON.stringify({ type: 'result', id: message.id, result: { success: true, paths, documentId: message.documentId, revision: message.expectedRevision, stateToken: documentStates.get(message.documentId).stateToken } }));
    } else if (message.command === 'package_document') {
      await fs.mkdir(message.args.folderPath, { recursive: true });
      await fs.writeFile(path.join(message.args.folderPath, 'package.indd'), 'indd-package');
      socket.send(JSON.stringify({ type: 'result', id: message.id, result: { success: true, documentId: message.documentId, revision: message.expectedRevision, stateToken: documentStates.get(message.documentId).stateToken } }));
    } else {
      socket.send(JSON.stringify({ type: 'result', id: message.id, result: { pong: true, documentId: message.documentId, revision: message.expectedRevision } }));
    }
  });

  const tools = await client.listTools();
  assert.ok(tools.tools.length >= 135);
  assert.ok(tools.tools.find((tool) => tool.name === 'execute_uxp'));
  assert.ok(tools.tools.find((tool) => tool.name === 'bridge_open_pairing_window'));

  const originalAuditWrite = application.audit.write.bind(application.audit);
  const beforeBlocked = received.length;
  application.audit.write = async (event) => {
    if (event.event === 'tool_call_start') throw new Error('audit indisponible avant envoi');
    return originalAuditWrite(event);
  };
  const blockedByAudit = await client.callTool({ name: 'ping', arguments: {} });
  assert.equal(blockedByAudit.isError, true);
  assert.equal(received.length, beforeBlocked);

  const auditEvents = [];
  application.audit.write = async (event) => {
    auditEvents.push(event);
    if (event.event === 'tool_call' && event.outcome === 'success') throw new Error('audit final indisponible');
    return originalAuditWrite(event);
  };
  const beforeAuditWarning = received.length;
  const staleState = await client.callTool({
    name: 'create_layer',
    arguments: { documentId: 21, expectedRevision: 5, expectedStateToken: 'f'.repeat(16), name: 'Calque refusé', reason: 'Refuser un état périmé' },
  });
  assert.equal(staleState.isError, true);
  assert.match(staleState.content[0].text, /STATE_CONFLICT/);
  assert.equal(received.length, beforeAuditWarning);
  auditEvents.length = 0;

  const mutationWithAuditWarning = await client.callTool({
    name: 'create_layer',
    arguments: { documentId: 21, expectedRevision: 5, expectedStateToken: documentStates.get(21).stateToken, name: 'Calque audit', reason: 'Créer le calque contrôlé' },
  });
  assert.equal(mutationWithAuditWarning.isError, undefined, JSON.stringify(mutationWithAuditWarning));
  assert.match(mutationWithAuditWarning.structuredContent.auditWarning, /résultat InDesign est valide/);
  assert.equal(mutationWithAuditWarning.structuredContent.stateToken, documentStates.get(21).stateToken);
  assert.equal(received.length, beforeAuditWarning + 2);
  assert.deepEqual(received.slice(beforeAuditWarning).map((message) => message.command), ['create_safety_backup', 'create_layer']);
  assert.deepEqual(auditEvents.map((event) => event.event), ['tool_call_start', 'tool_call']);
  application.audit.write = originalAuditWrite;

  const ping = await client.callTool({ name: 'ping', arguments: {} });
  assert.equal(ping.isError, undefined);
  assert.equal(ping.structuredContent.pong, true);

  const created = await client.callTool({
    name: 'create_document',
    arguments: { expectedRevision: 0, width: 148, height: 210, pageCount: 1, facingPages: false, units: 'mm', margins: [12, 12, 12, 12], bleed: [3, 3, 3, 3] },
  });
  assert.equal(created.isError, undefined);
  assert.equal(created.structuredContent.documentId, 55);
  assert.equal(created.structuredContent.stateToken, documentStates.get(55).stateToken);
  const closed = await client.callTool({
    name: 'close_document',
    arguments: { documentId: 55, expectedRevision: 0, expectedStateToken: documentStates.get(55).stateToken, save: false, reason: 'Fermer le document simulé' },
  });
  assert.equal(closed.isError, undefined);
  assert.equal(closed.structuredContent.closedDocumentId, 55);
  assert.equal(closed.structuredContent.stateToken, undefined);

  const codeMarker = 'SECRET-CONTENT-MUST-NOT-BE-AUDITED';
  const reason = 'Correction contrôlée de la maquette';
  const execution = await client.callTool({ name: 'execute_uxp', arguments: { scope: 'document', documentId: 17, expectedRevision: 3, expectedStateToken: documentStates.get(17).stateToken, reason, code: `return '${codeMarker}';` } });
  assert.equal(execution.isError, undefined, JSON.stringify(execution));
  assert.deepEqual(received.slice(-5).map((message) => message.command), ['list_documents', 'create_safety_backup', 'create_safety_backup', 'create_safety_backup', 'execute_uxp']);
  assert.equal(received.at(-1).documentId, 17);
  assert.equal(received.at(-1).expectedRevision, 3);
  assert.equal(execution.structuredContent.safetyBackups.length, 3);
  assert.ok(execution.structuredContent.safetyBackups.every((backup) => backup.backupPath.endsWith('.indd')));
  assert.ok(execution.structuredContent.safetyBackups.every((backup) => backup.metadataPath.endsWith('.json')));
  assert.ok(execution.structuredContent.safetyBackups.every((backup) => backup.artifactSha256 === 'a'.repeat(64)));

  const beforeRestore = received.length;
  const restored = await client.callTool({
    name: 'restore_safety_backup',
    arguments: {
      documentId: 17,
      expectedRevision: 4,
      expectedStateToken: documentStates.get(17).stateToken,
      backupId: execution.structuredContent.safetyBackups[0].backupId,
      reason: 'Revenir à la copie contrôlée',
    },
  });
  assert.equal(restored.isError, undefined);
  assert.deepEqual(received.slice(beforeRestore).map((message) => message.command), ['create_safety_backup', 'restore_safety_backup']);
  assert.ok(restored.structuredContent.recoveryBackupId);
  assert.equal(restored.structuredContent.stateToken, documentStates.get(99).stateToken);
  assert.equal(restored.structuredContent.restoredStateToken, documentStates.get(99).stateToken);
  assert.match(restored.structuredContent.restoredWorkingPath, /[\\/]restored[\\/]restore-[a-f0-9-]{36}\.indd$/);

  const beforeApplication = received.length;
  const applicationExecution = await client.callTool({ name: 'execute_uxp', arguments: { scope: 'application', reason: 'Créer des préférences globales', code: 'return 7;' } });
  assert.equal(applicationExecution.isError, undefined);
  const applicationCommands = received.slice(beforeApplication);
  assert.deepEqual(applicationCommands.map((message) => message.command), ['list_documents', 'create_safety_backup', 'create_safety_backup', 'create_safety_backup', 'execute_uxp']);
  assert.equal(applicationCommands.at(-1).documentId, undefined);
  assert.equal(applicationCommands.at(-1).args.backupIds.length, 3);

  const invalid = await client.callTool({ name: 'ping', arguments: { rogue: true } });
  assert.equal(invalid.isError, true);

  const existingPdf = path.join(writeRoot, 'livret-existant.pdf');
  await fs.writeFile(existingPdf, 'ancienne-version-pdf');
  const beforeRefusal = received.length;
  const refusedOverwrite = await client.callTool({
    name: 'export_pdf',
    arguments: { documentId: 21, expectedRevision: documentStates.get(21).revision, expectedStateToken: documentStates.get(21).stateToken, filePath: existingPdf, reason: 'Exporter le livret final' },
  });
  assert.equal(refusedOverwrite.isError, true);
  assert.match(refusedOverwrite.content[0].text, /TARGET_EXISTS/);
  assert.equal(received.length, beforeRefusal);

  const beforeProtectedOverwrite = received.length;
  const protectedOverwrite = await client.callTool({
    name: 'export_pdf',
    arguments: { documentId: 21, expectedRevision: documentStates.get(21).revision, expectedStateToken: documentStates.get(21).stateToken, filePath: existingPdf, overwrite: true, reason: 'Remplacer le livret final' },
  });
  assert.equal(protectedOverwrite.isError, undefined);
  assert.deepEqual(received.slice(beforeProtectedOverwrite).map((message) => message.command), ['create_safety_backup', 'export_pdf']);
  assert.equal(await fs.readFile(protectedOverwrite.structuredContent.targetBackupPath, 'utf8'), 'ancienne-version-pdf');
  assert.match(protectedOverwrite.structuredContent.backupMetadataPath, /backup-[a-f0-9]{36}\.json$/);
  assert.equal(protectedOverwrite.structuredContent.backupArtifactSha256, 'a'.repeat(64));
  assert.equal(protectedOverwrite.structuredContent.artifactVerification.valid, true);
  assert.equal(protectedOverwrite.structuredContent.artifactVerification.kind, 'pdf');

  const pngFolder = path.join(writeRoot, 'aperçus-png');
  const beforePngExport = received.length;
  const pngExport = await client.callTool({
    name: 'export_png',
    arguments: { documentId: 21, expectedRevision: documentStates.get(21).revision, expectedStateToken: documentStates.get(21).stateToken, folderPath: pngFolder, pageRange: '1-2', reason: 'Exporter les aperçus PNG' },
  });
  assert.equal(pngExport.isError, undefined);
  assert.deepEqual(received.slice(beforePngExport).map((message) => message.command), ['get_document_info', 'create_safety_backup', 'export_png']);
  const receivedPngFolder = received.at(-1).args.folderPath;
  const [receivedPngStat, expectedPngStat] = await Promise.all([
    fs.stat(receivedPngFolder),
    fs.stat(pngFolder),
  ]);
  assert.equal(receivedPngStat.dev, expectedPngStat.dev);
  assert.equal(receivedPngStat.ino, expectedPngStat.ino);
  assert.equal((await fs.stat(pngFolder)).isDirectory(), true);
  assert.equal(pngExport.structuredContent.artifactVerification.validPngCount, 2);

  const existingPngFolder = path.join(writeRoot, 'aperçus-png-existants');
  await fs.mkdir(existingPngFolder);
  await fs.writeFile(path.join(existingPngFolder, 'ancien.txt'), 'ancienne sortie');
  const replacedPngExport = await client.callTool({
    name: 'export_png',
    arguments: { documentId: 21, expectedRevision: documentStates.get(21).revision, expectedStateToken: documentStates.get(21).stateToken, folderPath: existingPngFolder, pageRange: '1', overwrite: true, reason: 'Remplacer les aperçus PNG' },
  });
  assert.equal(replacedPngExport.isError, undefined);
  assert.equal(await fs.readFile(path.join(replacedPngExport.structuredContent.targetBackupPath, 'ancien.txt'), 'utf8'), 'ancienne sortie');
  assert.deepEqual(await fs.readdir(existingPngFolder), ['page-001.png']);

  const existingPackageFolder = path.join(writeRoot, 'assemblage-existant');
  await fs.mkdir(existingPackageFolder);
  await fs.writeFile(path.join(existingPackageFolder, 'ancien-confidentiel.txt'), 'ancienne sortie à isoler');
  const beforePackage = received.length;
  const replacedPackage = await client.callTool({
    name: 'package_document',
    arguments: { documentId: 21, expectedRevision: documentStates.get(21).revision, expectedStateToken: documentStates.get(21).stateToken, folderPath: existingPackageFolder, overwrite: true, reason: 'Remplacer l’assemblage contrôlé' },
  });
  assert.equal(replacedPackage.isError, undefined);
  assert.deepEqual(received.slice(beforePackage).map((message) => message.command), [], 'l’assemblage ne passe plus par le plugin');
  assert.equal(replacedPackage.structuredContent.executionChannel, 'silent');
  assert.equal(silentExports.at(-1).folderPath, await fs.realpath(existingPackageFolder));
  assert.equal(silentExports.at(-1).ignorePreflightErrors, false);
  assert.equal(await fs.readFile(path.join(replacedPackage.structuredContent.targetBackupPath, 'ancien-confidentiel.txt'), 'utf8'), 'ancienne sortie à isoler');
  assert.deepEqual(await fs.readdir(existingPackageFolder), ['package.indd']);

  const legacyImageFolder = path.join(writeRoot, 'images-héritées');
  const beforeLegacyImages = received.length;
  const legacyImages = await client.callTool({
    name: 'export_images',
    arguments: {
      scope: 'document', documentId: 21, expectedRevision: documentStates.get(21).revision, expectedStateToken: documentStates.get(21).stateToken, reason: 'Exporter les images héritées',
      outputPath: legacyImageFolder, pages: '1-2', format: 'PNG', resolution: 450,
    },
  });
  assert.equal(legacyImages.isError, undefined);
  assert.deepEqual(received.slice(beforeLegacyImages).map((message) => message.command), ['list_documents', 'create_safety_backup', 'create_safety_backup', 'create_safety_backup', 'execute_uxp']);
  assert.equal((await fs.stat(legacyImageFolder)).isDirectory(), true);
  const legacyCode = received.at(-1).args.code;
  const embeddedFolder = legacyCode.match(/const folder = ("(?:\\.|[^"\\])*");/)?.[1];
  assert.ok(embeddedFolder, 'Le code UXP doit contenir le dossier de sortie sérialisé.');
  const [embeddedFolderStat, expectedLegacyFolderStat] = await Promise.all([
    fs.stat(JSON.parse(embeddedFolder)),
    fs.stat(legacyImageFolder),
  ]);
  assert.equal(embeddedFolderStat.dev, expectedLegacyFolderStat.dev);
  assert.equal(embeddedFolderStat.ino, expectedLegacyFolderStat.ino);
  assert.ok(legacyCode.includes('const requestedPages = [1,2]'));
  assert.doesNotMatch(legacyCode, /\bapp\.activeDocument\b/);
  assert.match(legacyCode, /\btargetDocument\b/);

  const partialUnknownFolder = path.join(writeRoot, 'sortie-partielle-inconnue');
  const uncertainExport = await client.callTool({
    name: 'export_png',
    arguments: { documentId: 21, expectedRevision: documentStates.get(21).revision, expectedStateToken: documentStates.get(21).stateToken, folderPath: partialUnknownFolder, pageRange: '1', reason: 'Tester une sortie interrompue' },
  });
  assert.equal(uncertainExport.isError, true);
  assert.equal(uncertainExport.structuredContent.requiresInspection, true);
  assert.equal(uncertainExport.structuredContent.partialOutputPath, partialUnknownFolder);
  assert.equal((await fs.stat(path.join(partialUnknownFolder, 'page-001.png'))).isFile(), true);
  assert.match(uncertainExport.structuredContent.operationId, /^[0-9a-f-]{36}$/i);
  assert.equal(application.bridge.operationStatus(uncertainExport.structuredContent.operationId).requiresInspection, true);
  assert.equal(await application.bridge.acknowledgeOperation(uncertainExport.structuredContent.operationId), true);

  const existingXml = path.join(writeRoot, 'export-existant.xml');
  await fs.writeFile(existingXml, '<ancienne-version/>');
  const beforeLegacyRefusal = received.length;
  const legacyOverwrite = await client.callTool({
    name: 'export_document_xml',
    arguments: { filePath: existingXml, scope: 'document', documentId: 21, expectedRevision: documentStates.get(21).revision, expectedStateToken: documentStates.get(21).stateToken, reason: 'Exporter le document XML' },
  });
  assert.equal(legacyOverwrite.isError, true);
  assert.match(legacyOverwrite.content[0].text, /TARGET_EXISTS/);
  assert.equal(received.length, beforeLegacyRefusal);

  const audit = await fs.readFile(auditFile, 'utf8');
  assert.equal(audit.includes(codeMarker), false);
  assert.equal(audit.includes(reason), false);
  assert.equal(audit.includes(pairingCode), false, 'le code temporaire ne doit jamais entrer dans l’audit');
  assert.ok(externalLeaseContexts.length > 0, 'les mutations MCP doivent propager leur operationId au contexte silencieux');
  assert.ok(silentInspectionLeaseIds.length > 0, 'les inspections pré/post mutation doivent s’exécuter dans ce contexte');
  assert.ok(silentInspectionLeaseIds.every((operationId) => externalLeaseContexts.includes(operationId)));
});

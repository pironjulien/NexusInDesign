import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ScriptExecutor } from '../src/core/scriptExecutor.js';
import { DocumentHandlers } from '../src/handlers/documentHandlers.js';
import { formatResponse } from '../src/utils/stringUtils.js';
import { createInddFixture } from './helpers/artifactFixtures.js';

const TOKEN_A = 'a'.repeat(16);
const TOKEN_B = 'b'.repeat(16);

async function setup(t, { stateToken = TOKEN_A, stateTokens } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-script-executor-'));
  const backupId = 'c'.repeat(36);
  const backupPath = path.join(directory, `backup-${backupId}.indd`);
  const commands = [];
  const registered = [];
  let executed = false;
  const bridge = {
    async execute(message) {
      commands.push(message);
      if (message.command === 'list_documents') return { result: { documents: [{ documentId: 7, revision: 2 }] } };
      if (message.command === 'create_safety_backup') {
        await fs.writeFile(backupPath, createInddFixture());
        return { result: { backupId, backupPath } };
      }
      if (message.command === 'execute_uxp') {
        executed = true;
        const codeSha256 = createHash('sha256').update(message.args.code, 'utf8').digest('hex');
        return {
          result: {
            success: true,
            revisions: [{ documentId: 7, revision: 3 }],
            documentStates: [{ documentId: 7, revision: 3, stateToken }],
            _execution: {
              codeSha256,
              payloadHasActiveDocument: /\bapp\.activeDocument\b/.test(message.args.code),
              payloadHasTargetDocument: /\btargetDocument\b/.test(message.args.code),
              requestedDocumentId: message.documentId ?? null,
              resolvedTargetDocumentId: message.documentId ?? null,
              activeDocumentIdBefore: 7,
              activeDocumentIdAfter: 7,
              resolutionMethod: 'itemByID.getElements',
              usedUndoTransaction: false,
            },
          },
          revision: 3,
          operationId: '12345678-1234-4123-8123-123456789abc',
        };
      }
      throw new Error(`Commande inattendue: ${message.command}`);
    },
  };
  const silentBridge = {
    async listDocuments() {
      return { documents: [{ documentId: 7, revision: executed ? 3 : 2 }] };
    },
    async inspectDocument(documentId) {
      const nextStateToken = stateTokens?.length ? stateTokens.shift() : stateToken;
      return { document: { documentId, revision: executed ? 3 : 2, stateToken: nextStateToken } };
    },
    async registerExternalBackup(input) {
      registered.push(input);
      return { metadataPath: `${input.backupPath}.meta.json`, artifact: { sha256: 'd'.repeat(64) } };
    },
  };
  ScriptExecutor.configure({ bridge, silentBridge, backupDirectory: directory, audit: { write: async () => {} } });
  t.after(async () => fs.rm(directory, { recursive: true, force: true }));
  return { commands, registered, backupId, backupPath };
}

test('les commandes legacy ciblées vérifient le stateToken et persistent chaque sauvegarde', async (t) => {
  const { commands, registered, backupId, backupPath } = await setup(t);
  const result = await ScriptExecutor.withContext({
    toolName: 'get_document_colors',
    scope: 'document',
    documentId: 7,
    expectedRevision: 2,
    expectedStateToken: TOKEN_A,
    reason: 'Lire les couleurs du document ciblé',
    legacyGeneratedCode: true,
  }, () => ScriptExecutor.executeViaUXP('const doc = app.activeDocument; return { success: true, id: app.activeDocument.id };'));

  assert.equal(result.success, true);
  assert.deepEqual(commands.map((entry) => entry.command), ['list_documents', 'create_safety_backup', 'execute_uxp']);
  assert.equal(commands[1].expectedStateToken, TOKEN_A);
  assert.equal(commands[2].expectedStateToken, TOKEN_A);
  assert.doesNotMatch(commands[2].args.code, /app\.activeDocument/);
  assert.match(commands[2].args.code, /const doc = targetDocument/);
  assert.match(commands[2].args.code, /id: targetDocument\.id/);
  assert.deepEqual(commands[2].args.expectedDocumentStates, [{ documentId: 7, revision: 2, stateToken: TOKEN_A }]);
  assert.deepEqual(registered, [{ backupId, backupPath, documentId: 7, revision: 2, stateToken: TOKEN_A }]);
  assert.equal(result.safetyBackups[0].artifactSha256, 'd'.repeat(64));
  assert.equal(result.safetyBackups[0].stateToken, TOKEN_A);
  assert.deepEqual(result.documentStates, [{ documentId: 7, revision: 3, stateToken: TOKEN_A }]);
});

test('le code libre conserve app.activeDocument sans réécriture implicite', async (t) => {
  const { commands } = await setup(t);
  const code = 'return { success: true, activeId: app.activeDocument.id, targetId: targetDocument.id };';

  await ScriptExecutor.withContext({
    toolName: 'execute_uxp',
    scope: 'document',
    documentId: 7,
    expectedRevision: 2,
    expectedStateToken: TOKEN_A,
    reason: 'Préserver exactement le code UXP libre demandé',
  }, () => ScriptExecutor.executeViaUXP(code));

  assert.equal(commands.find((entry) => entry.command === 'execute_uxp').args.code, code);
});

test('get_document_colors conserve les nuances et expose les sauvegardes au niveau MCP', async (t) => {
  await setup(t);
  const originalExecute = ScriptExecutor.bridge.execute.bind(ScriptExecutor.bridge);
  let executedCode = '';
  ScriptExecutor.bridge.execute = async (message) => {
    const response = await originalExecute(message);
    if (message.command !== 'execute_uxp') return response;
    executedCode = message.args.code;
    return {
      ...response,
      result: {
        ...response.result,
        colors: [{ name: 'Bleu E2E', model: 'PROCESS' }],
        swatches: ['Bleu E2E'],
        gradients: null,
        tints: null,
      },
    };
  };

  const response = await ScriptExecutor.withContext({
    toolName: 'get_document_colors',
    scope: 'document',
    documentId: 7,
    expectedRevision: 2,
    expectedStateToken: TOKEN_A,
    reason: 'Vérifier le format de réponse legacy',
    legacyGeneratedCode: true,
  }, () => DocumentHandlers.getDocumentColors({
    includeSwatches: true,
    includeGradients: false,
    includeTints: false,
  }));

  assert.equal(response.success, true);
  assert.match(executedCode, /const doc = targetDocument/);
  assert.doesNotMatch(executedCode, /app\.activeDocument/);
  assert.deepEqual(response.result.swatches, ['Bleu E2E']);
  assert.equal(response.result.safetyBackups.length, 1);
  assert.equal(response.safetyBackups.length, 1);
  assert.deepEqual(response.documentStates, [{ documentId: 7, revision: 3, stateToken: TOKEN_A }]);
});

test('une ancienne réponse textuelle conserve automatiquement les métadonnées de sécurité', async (t) => {
  const { backupId } = await setup(t);
  const response = await ScriptExecutor.withContext({
    toolName: 'create_rectangle',
    scope: 'document',
    documentId: 7,
    expectedRevision: 2,
    expectedStateToken: TOKEN_A,
    reason: 'Conserver les preuves malgré une réponse historique textuelle',
  }, async () => {
    await ScriptExecutor.executeViaUXP('return { success: true };');
    return formatResponse('Rectangle créé', 'Create Rectangle');
  });

  assert.equal(response.result, 'Rectangle créé');
  assert.equal(response.backupId, backupId);
  assert.equal(response.safetyBackups[0].backupId, backupId);
  assert.deepEqual(response.documentStates, [{ documentId: 7, revision: 3, stateToken: TOKEN_A }]);
});

test('une réponse plugin sans inventaire post-exécution reste bloquée comme issue à inspecter', async (t) => {
  const { commands } = await setup(t);
  const originalExecute = ScriptExecutor.bridge.execute.bind(ScriptExecutor.bridge);
  ScriptExecutor.bridge.execute = async (message) => {
    const response = await originalExecute(message);
    if (message.command === 'execute_uxp') {
      return { ...response, result: { success: true, _execution: response.result._execution } };
    }
    return response;
  };

  await assert.rejects(
    ScriptExecutor.withContext({
      toolName: 'get_document_colors',
      scope: 'document',
      documentId: 7,
      expectedRevision: 2,
      expectedStateToken: TOKEN_A,
      reason: 'Refuser un résultat post-exécution incomplet',
    }, () => ScriptExecutor.executeViaUXP('return { success: true };')),
    (error) => error.code === 'DOCUMENT_STATE_INVALID'
      && error.requiresInspection === true
      && Array.isArray(error.safetyBackups),
  );
  assert.deepEqual(commands.map((entry) => entry.command), ['list_documents', 'create_safety_backup', 'execute_uxp']);
});

test('une preuve UXP absente ou incohérente bloque le résultat comme issue à inspecter', async (t) => {
  await setup(t);
  const originalExecute = ScriptExecutor.bridge.execute.bind(ScriptExecutor.bridge);
  ScriptExecutor.bridge.execute = async (message) => {
    const response = await originalExecute(message);
    if (message.command !== 'execute_uxp') return response;
    return {
      ...response,
      result: {
        ...response.result,
        _execution: {
          ...response.result._execution,
          resolvedTargetDocumentId: 999,
        },
      },
    };
  };

  await assert.rejects(
    ScriptExecutor.withContext({
      toolName: 'get_document_colors',
      scope: 'document',
      documentId: 7,
      expectedRevision: 2,
      expectedStateToken: TOKEN_A,
      reason: 'Refuser une preuve de cible incohérente',
      legacyGeneratedCode: true,
    }, () => ScriptExecutor.executeViaUXP('const doc = app.activeDocument; return { success: true, id: doc.id };')),
    (error) => error.code === 'EXECUTION_EVIDENCE_INVALID'
      && error.requiresInspection === true
      && Array.isArray(error.safetyBackups),
  );
});

test('une preuve UXP document avec une résolution de repli est refusée', async (t) => {
  await setup(t);
  const originalExecute = ScriptExecutor.bridge.execute.bind(ScriptExecutor.bridge);
  ScriptExecutor.bridge.execute = async (message) => {
    const response = await originalExecute(message);
    if (message.command !== 'execute_uxp') return response;
    return {
      ...response,
      result: {
        ...response.result,
        _execution: {
          ...response.result._execution,
          resolutionMethod: 'collection.item-fallback',
        },
      },
    };
  };

  await assert.rejects(
    ScriptExecutor.withContext({
      toolName: 'get_document_colors',
      scope: 'document',
      documentId: 7,
      expectedRevision: 2,
      expectedStateToken: TOKEN_A,
      reason: 'Refuser toute résolution autre que itemByID',
      legacyGeneratedCode: true,
    }, () => ScriptExecutor.executeViaUXP('const doc = app.activeDocument; return { success: true, id: doc.id };')),
    (error) => error.code === 'EXECUTION_EVIDENCE_INVALID'
      && error.requiresInspection === true
      && Array.isArray(error.safetyBackups),
  );
});

test('un échec métier legacy devient un vrai échec MCP avec sa copie de sécurité', async (t) => {
  const { backupId } = await setup(t);
  const originalExecute = ScriptExecutor.bridge.execute.bind(ScriptExecutor.bridge);
  ScriptExecutor.bridge.execute = async (message) => {
    const response = await originalExecute(message);
    if (message.command !== 'execute_uxp') return response;
    return {
      ...response,
      result: {
        ...response.result,
        success: false,
        error: 'La commande InDesign a refusé la modification.',
      },
    };
  };

  await assert.rejects(
    ScriptExecutor.withContext({
      toolName: 'remove_item_from_group',
      scope: 'document',
      documentId: 7,
      expectedRevision: 2,
      expectedStateToken: TOKEN_A,
      reason: 'Vérifier la remontée réelle des erreurs legacy',
    }, () => ScriptExecutor.executeViaUXP('return { success: false };')),
    (error) => error.code === 'LEGACY_UXP_COMMAND_FAILED'
      && error.message === 'La commande InDesign a refusé la modification.'
      && error.backupId === backupId
      && error.safetyBackups?.[0]?.backupId === backupId
      && error.documentStates?.[0]?.revision === 3
      && error.requiresInspection !== true,
  );
});

test('un inventaire post-exécution différent de l’état réellement ouvert reste bloqué', async (t) => {
  await setup(t);
  ScriptExecutor.silentBridge.listDocuments = async () => ({ documents: [{ documentId: 7, revision: 4 }] });

  await assert.rejects(
    ScriptExecutor.withContext({
      toolName: 'get_document_colors',
      scope: 'document',
      documentId: 7,
      expectedRevision: 2,
      expectedStateToken: TOKEN_A,
      reason: 'Refuser un inventaire post-exécution incohérent',
    }, () => ScriptExecutor.executeViaUXP('return { success: true };')),
    (error) => error.code === 'STATE_VERIFICATION_FAILED'
      && error.requiresInspection === true
      && Array.isArray(error.safetyBackups),
  );
});

test('une panne de lecture silencieuse après exécution conserve le verrou de réconciliation', async (t) => {
  const { backupId } = await setup(t);
  ScriptExecutor.silentBridge.listDocuments = async () => {
    throw new Error('Canal silencieux interrompu après la mutation');
  };

  await assert.rejects(
    ScriptExecutor.withContext({
      toolName: 'move_page',
      scope: 'document',
      documentId: 7,
      expectedRevision: 2,
      expectedStateToken: TOKEN_A,
      reason: 'Conserver le verrou après une vérification interrompue',
    }, () => ScriptExecutor.executeViaUXP('return { success: true };')),
    (error) => error.code === 'STATE_VERIFICATION_FAILED'
      && error.operationId === '12345678-1234-4123-8123-123456789abc'
      && error.requiresInspection === true
      && error.backupId === backupId,
  );
});

test('un token legacy périmé bloque toute sauvegarde et toute exécution', async (t) => {
  const { commands, registered } = await setup(t, { stateToken: TOKEN_B });
  await assert.rejects(
    ScriptExecutor.withContext({
      toolName: 'get_document_colors',
      scope: 'document',
      documentId: 7,
      expectedRevision: 2,
      expectedStateToken: TOKEN_A,
      reason: 'Refuser un état devenu périmé',
    }, () => ScriptExecutor.executeViaUXP('return { success: true };')),
    (error) => error.code === 'STATE_CONFLICT',
  );
  assert.deepEqual(commands.map((entry) => entry.command), ['list_documents']);
  assert.deepEqual(registered, []);
});

test('un changement après sauvegarde bloque la commande legacy juste avant son exécution', async (t) => {
  const { commands, registered } = await setup(t, { stateTokens: [TOKEN_A, TOKEN_A, TOKEN_B] });
  await assert.rejects(
    ScriptExecutor.withContext({
      toolName: 'get_document_colors',
      scope: 'document',
      documentId: 7,
      expectedRevision: 2,
      expectedStateToken: TOKEN_A,
      reason: 'Refuser un changement après la sauvegarde',
    }, () => ScriptExecutor.executeViaUXP('return { success: true };')),
    (error) => error.code === 'STATE_CONFLICT' && Array.isArray(error.safetyBackups),
  );
  assert.deepEqual(commands.map((entry) => entry.command), ['list_documents', 'create_safety_backup']);
  assert.equal(registered.length, 1);
});

test('deux étapes UXP legacy réutilisent la révision et le stateToken réellement vérifiés', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-script-sequence-'));
  t.after(async () => fs.rm(directory, { recursive: true, force: true }));
  const states = [
    { documentId: 7, revision: 2, stateToken: TOKEN_A },
    { documentId: 7, revision: 3, stateToken: TOKEN_B },
    { documentId: 7, revision: 4, stateToken: 'c'.repeat(16) },
  ];
  const executeMessages = [];
  let stateIndex = 0;
  let backupIndex = 0;
  const bridge = {
    async execute(message) {
      const current = states[stateIndex];
      if (message.command === 'list_documents') {
        return { result: { documents: [{ documentId: current.documentId, revision: current.revision }] } };
      }
      if (message.command === 'create_safety_backup') {
        const backupId = `${String(backupIndex).padStart(8, '0')}-1234-4123-8123-123456789abc`;
        backupIndex += 1;
        const backupPath = path.join(directory, `backup-${backupId}.indd`);
        await fs.writeFile(backupPath, createInddFixture());
        return { result: { backupId, backupPath } };
      }
      if (message.command === 'execute_uxp') {
        executeMessages.push(structuredClone(message));
        stateIndex += 1;
        const next = states[stateIndex];
        const codeSha256 = createHash('sha256').update(message.args.code, 'utf8').digest('hex');
        return {
          result: {
            success: true,
            revisions: [{ documentId: next.documentId, revision: next.revision }],
            documentStates: [next],
            _execution: {
              codeSha256,
              payloadHasActiveDocument: /\bapp\.activeDocument\b/.test(message.args.code),
              payloadHasTargetDocument: /\btargetDocument\b/.test(message.args.code),
              requestedDocumentId: message.documentId,
              resolvedTargetDocumentId: message.documentId,
              activeDocumentIdBefore: message.documentId,
              activeDocumentIdAfter: message.documentId,
              resolutionMethod: 'itemByID.getElements',
              usedUndoTransaction: false,
            },
          },
          revision: next.revision,
          operationId: `12345678-1234-4123-8123-123456789ab${stateIndex}`,
        };
      }
      throw new Error(`Commande inattendue: ${message.command}`);
    },
  };
  const silentBridge = {
    async listDocuments() {
      const current = states[stateIndex];
      return { documents: [{ documentId: current.documentId, revision: current.revision }] };
    },
    async inspectDocument(documentId) {
      return { document: { ...states[stateIndex], documentId } };
    },
    async registerExternalBackup(input) {
      return { metadataPath: `${input.backupPath}.meta.json`, artifact: { sha256: 'd'.repeat(64) } };
    },
  };
  ScriptExecutor.configure({ bridge, silentBridge, backupDirectory: directory, audit: { write: async () => {} } });

  const result = await ScriptExecutor.withContext({
    toolName: 'data_merge',
    scope: 'document',
    documentId: 7,
    expectedRevision: 2,
    expectedStateToken: TOKEN_A,
    reason: 'Tester une ancienne commande en deux étapes',
  }, async () => {
    await ScriptExecutor.executeViaUXP('return { success: true, phase: 1 };');
    return ScriptExecutor.executeViaUXP('return { success: true, phase: 2 };');
  });

  assert.equal(result.success, true);
  assert.equal(executeMessages.length, 2);
  assert.equal(executeMessages[0].expectedRevision, 2);
  assert.equal(executeMessages[0].expectedStateToken, TOKEN_A);
  assert.equal(executeMessages[1].expectedRevision, 3);
  assert.equal(executeMessages[1].expectedStateToken, TOKEN_B);
  assert.deepEqual(executeMessages[1].args.expectedDocumentStates, [states[1]]);
  assert.deepEqual(result.documentStates, [states[2]]);
});

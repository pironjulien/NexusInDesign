import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import test from 'node:test';
import { TOOL_DEFINITIONS } from '../src/tools/definitions.js';
import { PACKAGE_VERSION } from '../src/version.js';

const require = createRequire(import.meta.url);
const { createCommandRegistry, documentStateToken, executeCommand, getRevision } = require('../plugin/commands.js');

const pluginSource = await fs.readFile(new URL('../plugin/index.js', import.meta.url), 'utf8');
const pluginHtml = await fs.readFile(new URL('../plugin/index.html', import.meta.url), 'utf8');
const commandSource = await fs.readFile(new URL('../plugin/commands.js', import.meta.url), 'utf8');
const securityCryptoSource = await fs.readFile(new URL('../plugin/security-crypto.js', import.meta.url), 'utf8');
const bridgeSource = await fs.readFile(new URL('../src/bridge/InDesignBridge.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await fs.readFile(new URL('../plugin/manifest.json', import.meta.url), 'utf8'));

function emptyCollection(entries = []) {
  const collection = [...entries];
  collection.item = (index) => collection[index];
  return collection;
}

function makeDocument(id, options = {}) {
  const labels = new Map();
  const name = options.name ?? `document-${id}.indd`;
  const document = {
    id,
    name,
    fullName: options.fullName === undefined ? `C:\\Documents\\${name}` : options.fullName,
    filePath: options.filePath === undefined ? 'C:\\Documents' : options.filePath,
    isValid: true,
    modified: false,
    saved: true,
    pages: emptyCollection(options.pages),
    spreads: emptyCollection(),
    masterSpreads: emptyCollection(),
    stories: emptyCollection(),
    links: emptyCollection(),
    layers: emptyCollection(),
    allPageItems: emptyCollection(),
    swatches: emptyCollection(),
    colors: emptyCollection(),
    gradients: emptyCollection(),
    paragraphStyles: emptyCollection(),
    characterStyles: emptyCollection(),
    objectStyles: emptyCollection(),
    tableStyles: emptyCollection(),
    cellStyles: emptyCollection(),
    documentPreferences: { properties: {} },
    viewPreferences: { horizontalMeasurementUnits: 'pt', verticalMeasurementUnits: 'pt' },
    extractLabel: (key) => labels.get(key) ?? '',
    insertLabel: (key, value) => { labels.set(key, value); },
    saveACopy: async () => {},
    save: async (path) => {
      if (path) {
        const normalized = String(path).replace(/\//g, '\\');
        document.fullName = normalized;
        document.name = normalized.slice(normalized.lastIndexOf('\\') + 1);
        document.filePath = normalized.slice(0, normalized.lastIndexOf('\\'));
      }
      document.saved = true;
      document.modified = false;
    },
  };
  return Object.assign(document, options.overrides || {});
}

function makeApp(documents) {
  const collection = emptyCollection(documents);
  collection.itemByID = (id) => ({
    getElements: () => {
      const document = collection.find((candidate) => Number(candidate.id) === Number(id));
      return document ? [document] : [];
    },
  });
  return {
    documents: collection,
    activeDocument: documents[documents.length - 1] ?? null,
    doScript(callback) { return callback(); },
  };
}

function expectedStates(documents) {
  return documents.map((document) => ({
    documentId: Number(document.id),
    revision: getRevision(document),
    stateToken: documentStateToken(document),
  }));
}

async function createBackups(registry, documents, reason, toolName = 'execute_uxp') {
  const results = [];
  for (const document of documents) {
    results.push(await registry.create_safety_backup.handler(
      { reason, toolName, backupDirectory: 'C:\\Backups' },
      { doc: document, documentId: Number(document.id), revision: getRevision(document) },
    ));
  }
  return results;
}

test('le manifeste conserve les capacités UXP nécessaires et le transport reste figé sur le pont local', () => {
  assert.match(pluginHtml, new RegExp(`Extension UXP ${manifest.version.replaceAll('.', '\\.')}`));
  assert.equal(manifest.manifestVersion, 5);
  assert.equal(manifest.id, 'fr.pironjulien.indesign.mcp');
  assert.equal(manifest.version, PACKAGE_VERSION);
  assert.equal(manifest.host.minVersion, '19.0.0');
  assert.equal(manifest.requiredPermissions.network.domains, 'all');
  assert.match(pluginSource, /const BRIDGE_URL = "ws:\/\/127\.0\.0\.1:33171"/);
  assert.equal(manifest.requiredPermissions.clipboard, 'read');
  assert.match(pluginHtml, /id="pastePairButton"/);
  assert.match(pluginSource, /navigator\.clipboard/);
  assert.doesNotMatch(pluginSource, /clipboard\.(?:setContent|write|writeText)\s*\(/);
  assert.equal(manifest.requiredPermissions.localFileSystem, 'fullAccess');
  assert.equal(manifest.requiredPermissions.allowCodeGenerationFromStrings, true);
  assert.equal(manifest.requiredPermissions.launchProcess, undefined);
});

test('le plugin implémente chaque commande structurée et les capacités avancées', () => {
  const implemented = new Set([...commandSource.matchAll(/commands\.([a-z][a-z0-9_]*)\s*=\s*definition/g)].map((match) => match[1]));
  for (const definition of TOOL_DEFINITIONS.filter((item) => item.route === 'direct')) {
    assert.ok(implemented.has(definition.command), `commande UXP absente: ${definition.command}`);
  }
  for (const name of ['analyze_layout', 'create_safety_backup', 'restore_safety_backup', 'execute_uxp']) assert.ok(implemented.has(name));
  assert.equal(implemented.size, 38);
});

test('la restauration tolère les proxys InDesign transitoirement invalides', () => {
  assert.match(commandSource, /function waitForDocumentState\(/);
  assert.match(commandSource, /await waitForDocumentState\(app, context\.documentId, false, 10000\)/);
  assert.match(commandSource, /await waitForDocumentState\(app, restoredDocumentId, true, 10000\)/);
  const waitBlock = commandSource.slice(
    commandSource.indexOf('async function waitForDocumentState'),
    commandSource.indexOf('function getOptionalDocument'),
  );
  assert.match(waitBlock, /try \{ document = getDocumentById\(app, documentId\); \} catch \(_\) \{\}/);
});

test('le contrat plugin exige une sauvegarde pour chaque vraie mutation existante', () => {
  const registry = createCommandRegistry({}, {}, {}, require);
  const protectedMutators = [
    'save_document', 'save_as', 'close_document', 'add_pages', 'create_layer',
    'create_color_swatch', 'create_paragraph_style', 'create_character_style',
    'create_object_style', 'create_text_frame', 'edit_text_frame', 'create_rectangle',
    'place_file', 'set_page_item_bounds', 'delete_page_item', 'create_master_spread',
    'apply_master_spread', 'export_pdf', 'export_idml', 'export_png', 'package_document',
  ];
  for (const name of protectedMutators) assert.equal(registry[name].requiresBackup, true, name);
  for (const name of ['create_document', 'open_document', 'preflight_document']) {
    assert.equal(registry[name].requiresBackup, false, name);
  }
});

test('le code legacy reçoit la cible gouvernée sans dépendre du document actif', async () => {
  const target = makeDocument(41);
  const other = makeDocument(99);
  const documents = [target, other];
  const app = makeApp(documents);
  const registry = createCommandRegistry(app, {}, {}, require);
  const reason = 'Vérifier la cible legacy';
  const targetStateToken = documentStateToken(target);
  const backupResults = await createBackups(registry, documents, reason, 'get_document_colors');

  const result = await executeCommand(registry, app, 'execute_uxp', {
    scope: 'document',
    reason,
    backupId: backupResults[0].backupId,
    backupIds: backupResults.map((backup) => backup.backupId),
    expectedDocumentStates: expectedStates(documents),
    code: 'return { activeId: Number(app.activeDocument.id), targetId: Number(targetDocument.id), _execution: { codeSha256: "usurpe" } };',
  }, { documentId: target.id, expectedRevision: 0, expectedStateToken: targetStateToken });

  const code = 'return { activeId: Number(app.activeDocument.id), targetId: Number(targetDocument.id), _execution: { codeSha256: "usurpe" } };';
  assert.equal(result.activeId, other.id);
  assert.equal(result.targetId, target.id);
  assert.equal(Number(app.activeDocument.id), other.id);
  assert.deepEqual(result._execution, {
    codeSha256: createHash('sha256').update(code, 'utf8').digest('hex'),
    payloadHasActiveDocument: true,
    payloadHasTargetDocument: true,
    requestedDocumentId: target.id,
    resolvedTargetDocumentId: target.id,
    activeDocumentIdBefore: other.id,
    activeDocumentIdAfter: other.id,
    resolutionMethod: 'itemByID.getElements',
    usedUndoTransaction: false,
  });
});

test('l’exécution UXP asynchrone ne dépend pas de doScript et cible par identifiant', async () => {
  const target = makeDocument(51);
  const other = makeDocument(59);
  const documents = [target, other];
  const app = makeApp(documents);
  let doScriptCalls = 0;
  app.doScript = () => {
    doScriptCalls += 1;
    throw new Error('doScript ne doit pas être appelé pour du code asynchrone');
  };
  const registry = createCommandRegistry(app, {}, {}, require);
  const reason = 'Exécuter un payload asynchrone sans perdre sa preuve';
  const backups = await createBackups(registry, documents, reason, 'get_document_colors');

  const result = await executeCommand(registry, app, 'execute_uxp', {
    scope: 'document',
    reason,
    backupId: backups[0].backupId,
    backupIds: backups.map((backup) => backup.backupId),
    expectedDocumentStates: expectedStates(documents),
    code: 'await Promise.resolve(); return { activeId: Number(app.activeDocument.id), targetId: Number(targetDocument.id) };',
  }, {
    documentId: target.id,
    expectedRevision: 0,
    expectedStateToken: documentStateToken(target),
  });

  assert.equal(doScriptCalls, 0);
  assert.equal(result._execution.usedUndoTransaction, false);
  assert.equal(result._execution.resolutionMethod, 'itemByID.getElements');
  assert.equal(result._execution.requestedDocumentId, target.id);
  assert.equal(result._execution.resolvedTargetDocumentId, target.id);
  assert.equal(result._execution.activeDocumentIdBefore, other.id);
  assert.equal(result._execution.activeDocumentIdAfter, other.id);
  assert.equal(result.activeId, other.id);
  assert.equal(result.targetId, target.id);
  assert.equal(Number(app.activeDocument.id), other.id);
});

test('l’exécution UXP relit un proxy DOM frais juste avant le code asynchrone', async () => {
  const target = makeDocument(61, { overrides: { proxyMarker: 'initial' } });
  const freshTarget = makeDocument(61, { overrides: { proxyMarker: 'fresh' } });
  const other = makeDocument(69);
  const documents = [target, other];
  const app = makeApp(documents);
  let targetResolutionCalls = 0;
  let doScriptCalls = 0;
  app.documents.itemByID = (id) => ({
    getElements: () => {
      if (Number(id) !== target.id) {
        const document = app.documents.find((candidate) => Number(candidate.id) === Number(id));
        return document ? [document] : [];
      }
      targetResolutionCalls += 1;
      return [targetResolutionCalls === 1 ? target : freshTarget];
    },
  });
  app.doScript = () => {
    doScriptCalls += 1;
    throw new Error('doScript ne doit pas être appelé');
  };
  const registry = createCommandRegistry(app, {}, {}, require);
  const reason = 'Relire un proxy DOM frais avant le payload asynchrone';
  const backups = await createBackups(registry, documents, reason, 'get_document_colors');

  const result = await executeCommand(registry, app, 'execute_uxp', {
    scope: 'document',
    reason,
    backupId: backups[0].backupId,
    backupIds: backups.map((backup) => backup.backupId),
    expectedDocumentStates: expectedStates(documents),
    code: 'await Promise.resolve(); return { activeId: Number(app.activeDocument.id), targetId: Number(targetDocument.id), proxyMarker: String(targetDocument.proxyMarker) };',
  }, {
    documentId: target.id,
    expectedRevision: 0,
    expectedStateToken: documentStateToken(target),
  });

  assert.equal(doScriptCalls, 0);
  assert.equal(targetResolutionCalls, 2);
  assert.equal(result._execution.usedUndoTransaction, false);
  assert.equal(result._execution.resolutionMethod, 'itemByID.getElements');
  assert.equal(result._execution.resolvedTargetDocumentId, freshTarget.id);
  assert.equal(result.proxyMarker, 'fresh');
  assert.equal(result.activeId, other.id);
  assert.equal(result.targetId, target.id);
  assert.equal(Number(app.activeDocument.id), other.id);
});

test('l’absence de itemByID échoue fermé sans repli par parcours', async () => {
  const target = makeDocument(71);
  const other = makeDocument(79);
  const documents = [target, other];
  const app = makeApp(documents);
  delete app.documents.itemByID;
  const registry = createCommandRegistry(app, {}, {}, require);
  const reason = 'Vérifier le repli réservé aux doubles de test';
  const backups = await createBackups(registry, documents, reason, 'get_document_colors');

  await assert.rejects(
    executeCommand(registry, app, 'execute_uxp', {
      scope: 'document',
      reason,
      backupId: backups[0].backupId,
      backupIds: backups.map((backup) => backup.backupId),
      expectedDocumentStates: expectedStates(documents),
      code: 'return { targetId: Number(targetDocument.id) };',
    }, {
      documentId: target.id,
      expectedRevision: 0,
      expectedStateToken: documentStateToken(target),
    }),
    /résolution DOM officielle itemByID est indisponible/,
  );
});

test('itemByID présent échoue fermé au lieu de masquer une résolution officielle invalide', async () => {
  const target = makeDocument(81);
  const documents = [target];
  const app = makeApp(documents);
  app.documents.itemByID = () => ({ getElements: () => [] });
  const registry = createCommandRegistry(app, {}, {}, require);

  await assert.rejects(
    executeCommand(registry, app, 'execute_uxp', {
      scope: 'document',
      reason: 'Refuser un résultat itemByID invalide',
      expectedDocumentStates: expectedStates(documents),
      code: 'return Number(targetDocument.id);',
    }, {
      documentId: target.id,
      expectedRevision: 0,
      expectedStateToken: documentStateToken(target),
    }),
    { code: 'DOCUMENT_NOT_FOUND' },
  );
});

test('execute_uxp rejette les états documentaires absents, incomplets, dupliqués ou périmés avant toute exécution', async () => {
  const documents = [makeDocument(201), makeDocument(202)];
  const app = makeApp(documents);
  const registry = createCommandRegistry(app, {}, {}, require);
  const targetToken = documentStateToken(documents[0]);
  const baseArgs = {
    scope: 'document',
    reason: 'Valider strictement les états ouverts',
    code: 'return true;',
  };
  const envelope = { documentId: 201, expectedRevision: 0, expectedStateToken: targetToken };

  await assert.rejects(executeCommand(registry, app, 'execute_uxp', baseArgs, envelope), { code: 'STATE_TOKEN_REQUIRED' });
  await assert.rejects(executeCommand(registry, app, 'execute_uxp', {
    ...baseArgs,
    expectedDocumentStates: expectedStates(documents).slice(0, 1),
  }, envelope), { code: 'STATE_CONFLICT' });
  await assert.rejects(executeCommand(registry, app, 'execute_uxp', {
    ...baseArgs,
    expectedDocumentStates: [expectedStates(documents)[0], expectedStates(documents)[0]],
  }, envelope), { code: 'DOCUMENT_STATE_INVALID' });
  await assert.rejects(executeCommand(registry, app, 'execute_uxp', {
    ...baseArgs,
    expectedDocumentStates: expectedStates(documents).map((state, index) => (
      index === 1 ? { ...state, stateToken: '0000000000000000' } : state
    )),
  }, envelope), { code: 'STATE_CONFLICT' });
  assert.deepEqual(documents.map((document) => getRevision(document)), [0, 0]);
});

test('execute_uxp en portée document exige exactement une sauvegarde de chaque document ouvert et les consomme toutes', async () => {
  const documents = [makeDocument(211), makeDocument(212), makeDocument(213)];
  const app = makeApp(documents);
  const registry = createCommandRegistry(app, {}, {}, require);
  const reason = 'Protéger tous les documents ouverts';
  const backupResults = await createBackups(registry, documents, reason);
  const extraBackup = (await createBackups(registry, [documents[0]], reason))[0];
  const baseArgs = {
    scope: 'document',
    reason,
    backupId: backupResults[0].backupId,
    expectedDocumentStates: expectedStates(documents),
    code: 'return { success: true };',
  };
  const envelope = { documentId: 211, expectedRevision: 0, expectedStateToken: documentStateToken(documents[0]) };

  await assert.rejects(executeCommand(registry, app, 'execute_uxp', {
    ...baseArgs,
    backupIds: [backupResults[0].backupId, backupResults[0].backupId, backupResults[2].backupId],
  }, envelope), { code: 'BACKUP_MISMATCH' });
  await assert.rejects(executeCommand(registry, app, 'execute_uxp', {
    ...baseArgs,
    backupIds: [...backupResults.map((backup) => backup.backupId), extraBackup.backupId],
  }, envelope), { code: 'BACKUP_REQUIRED' });
  await assert.rejects(executeCommand(registry, app, 'execute_uxp', {
    ...baseArgs,
    backupIds: backupResults.slice(0, 2).map((backup) => backup.backupId),
  }, envelope), { code: 'BACKUP_REQUIRED' });

  const result = await executeCommand(registry, app, 'execute_uxp', {
    ...baseArgs,
    backupIds: backupResults.map((backup) => backup.backupId),
  }, envelope);
  assert.deepEqual(result.documentStates.map(({ documentId, revision }) => ({ documentId, revision })), [
    { documentId: 211, revision: 1 },
    { documentId: 212, revision: 1 },
    { documentId: 213, revision: 1 },
  ]);

  for (let index = 0; index < documents.length; index += 1) {
    await assert.rejects(executeCommand(registry, app, 'save_document', {
      backupId: backupResults[index].backupId,
      reason,
    }, {
      documentId: documents[index].id,
      expectedRevision: 1,
      expectedStateToken: documentStateToken(documents[index]),
    }), { code: 'BACKUP_ALREADY_USED' });
  }
});

test('execute_uxp en portée application protège lui aussi chaque document ouvert sans sauvegarde en trop', async () => {
  const documents = [makeDocument(214), makeDocument(215)];
  const app = makeApp(documents);
  const registry = createCommandRegistry(app, {}, {}, require);
  const reason = 'Protéger la portée application complète';
  const backupResults = await createBackups(registry, documents, reason);
  const args = {
    scope: 'application',
    reason,
    expectedDocumentStates: expectedStates(documents),
    code: 'return 7;',
  };

  await assert.rejects(executeCommand(registry, app, 'execute_uxp', {
    ...args,
    backupIds: backupResults.slice(0, 1).map((backup) => backup.backupId),
  }, {}), { code: 'BACKUP_REQUIRED' });
  const result = await executeCommand(registry, app, 'execute_uxp', {
    ...args,
    backupIds: backupResults.map((backup) => backup.backupId),
  }, {});
  assert.equal(result.value, 7);
  assert.deepEqual(result.documentStates.map((state) => state.revision), [1, 1]);
});

test('une mutation UXP suivie d’une exception impose l’inspection et publie les états post-échec', async () => {
  const documents = [makeDocument(221), makeDocument(222)];
  const app = makeApp(documents);
  const registry = createCommandRegistry(app, {}, {}, require);
  const reason = 'Tester une mutation partielle réelle';
  const targetToken = documentStateToken(documents[0]);
  const backupResults = await createBackups(registry, documents, reason);
  let failure;
  try {
    await executeCommand(registry, app, 'execute_uxp', {
      scope: 'document',
      reason,
      backupId: backupResults[0].backupId,
      backupIds: backupResults.map((backup) => backup.backupId),
      expectedDocumentStates: expectedStates(documents),
      code: 'app.documents.item(0).modified = true; throw new Error("mutation interrompue");',
    }, { documentId: 221, expectedRevision: 0, expectedStateToken: targetToken });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure);
  assert.equal(failure.requiresInspection, true);
  assert.equal(failure.details.requiresInspection, true);
  assert.equal(failure.documentStates.length, 2);
  assert.deepEqual(failure.documentStates.map(({ documentId, revision }) => ({ documentId, revision })), [
    { documentId: 221, revision: 1 },
    { documentId: 222, revision: 1 },
  ]);
  for (const state of failure.documentStates) {
    const document = documents.find((candidate) => candidate.id === state.documentId);
    assert.equal(state.stateToken, documentStateToken(document));
  }
  assert.notEqual(failure.documentStates[0].stateToken, targetToken);
});

test('save_as change l’identité fichier, incrémente la révision et renvoie le nouveau jeton', async () => {
  const document = makeDocument(231, { name: 'ancien.indd', fullName: 'C:\\Documents\\ancien.indd' });
  const app = makeApp([document]);
  const registry = createCommandRegistry(app, {}, {}, require);
  const reason = 'Déplacer le document de façon sûre';
  const beforeToken = documentStateToken(document);
  const backup = (await createBackups(registry, [document], reason, 'save_as'))[0];

  const result = await executeCommand(registry, app, 'save_as', {
    path: 'C:\\Livrables\\nouveau.indd',
    backupId: backup.backupId,
    reason,
  }, { documentId: 231, expectedRevision: 0, expectedStateToken: beforeToken });

  assert.equal(registry.save_as.contentMutation, true);
  assert.equal(result.revision, 1);
  assert.equal(result.stateToken, documentStateToken(document));
  assert.notEqual(result.stateToken, beforeToken);
  assert.equal(document.name, 'nouveau.indd');
});

test('une mutation structurée partielle après consommation du backup impose une inspection sans doubler la révision', async () => {
  const page = (id) => ({
    id,
    name: String(id),
    marginPreferences: { properties: {} },
    guides: emptyCollection(),
    bounds: [0, 0, 297, 210],
    side: 'right',
    appliedMaster: null,
    appliedParentPage: null,
  });
  const target = makeDocument(236, { pages: [page(1)] });
  const other = makeDocument(237);
  let additions = 0;
  target.pages.add = () => {
    additions += 1;
    if (additions === 2) throw new Error('échec après la première page');
    const added = page(2);
    target.pages.push(added);
    target.modified = true;
    return added;
  };
  const app = makeApp([target, other]);
  const registry = createCommandRegistry(app, { LocationOptions: { after: 'after' } }, {}, require);
  const reason = 'Tester une mutation structurée partielle';
  const beforeToken = documentStateToken(target);
  const backup = (await createBackups(registry, [target], reason, 'add_pages'))[0];
  const args = { count: 2, backupId: backup.backupId, reason };

  let knownFailure;
  try {
    await executeCommand(registry, app, 'add_pages', args, {
      documentId: target.id,
      expectedRevision: 1,
      expectedStateToken: beforeToken,
    });
  } catch (error) {
    knownFailure = error;
  }
  assert.equal(knownFailure.code, 'REVISION_CONFLICT');
  assert.notEqual(knownFailure.requiresInspection, true);
  assert.equal(getRevision(target), 0);

  let failure;
  try {
    await executeCommand(registry, app, 'add_pages', args, {
      documentId: target.id,
      expectedRevision: 0,
      expectedStateToken: beforeToken,
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure);
  assert.equal(failure.requiresInspection, true);
  assert.equal(failure.details.requiresInspection, true);
  assert.equal(target.pages.length, 2);
  assert.equal(getRevision(target), 1);
  assert.equal(getRevision(other), 0);
  assert.deepEqual(failure.documentStates.map(({ documentId, revision }) => ({ documentId, revision })), [
    { documentId: 236, revision: 1 },
    { documentId: 237, revision: 0 },
  ]);
  assert.equal(failure.documentStates[0].stateToken, documentStateToken(target));
  assert.notEqual(failure.documentStates[0].stateToken, beforeToken);
});

test('create_document et open_document renvoient immédiatement un jeton plugin calculé sur le document réel', async () => {
  const page = { marginPreferences: {}, guides: emptyCollection(), bounds: [0, 0, 297, 210], side: 'right' };
  const created = makeDocument(241, { name: 'Sans titre-1', fullName: null, filePath: null, pages: [page] });
  created.pages.add = () => {
    const added = { marginPreferences: {}, guides: emptyCollection(), bounds: [0, 0, 297, 210], side: 'right' };
    created.pages.push(added);
    return added;
  };
  const opened = makeDocument(242, { name: 'ouvert.indd', fullName: 'C:\\Documents\\ouvert.indd' });
  const app = makeApp([opened]);
  app.documents.add = () => created;
  app.open = async () => opened;
  const registry = createCommandRegistry(app, { MeasurementUnits: { millimeters: 'mm' } }, {}, require);

  const creation = await registry.create_document.handler({});
  const opening = await registry.open_document.handler({ path: 'C:\\Documents\\ouvert.indd' });

  assert.equal(creation.stateToken, documentStateToken(created));
  assert.equal(opening.stateToken, documentStateToken(opened));
  assert.match(creation.stateToken, /^[a-f0-9]{16}$/);
  assert.match(opening.stateToken, /^[a-f0-9]{16}$/);
});

test('ping expose les versions hôte, UXP et DOM réellement observées', async () => {
  const app = {
    name: 'Adobe InDesign',
    version: '21.4.1.4',
    locale: 'fr_FR',
    scriptPreferences: { version: '21.0' },
    documents: { length: 2 },
  };
  const uxp = {
    host: { name: 'InDesign', version: '21.4.1.4', uiLocale: 'fr_FR' },
    versions: { uxp: '8.1.0' },
  };
  const registry = createCommandRegistry(app, {}, uxp, require);
  assert.deepEqual(await registry.ping.handler(), {
    success: true,
    pluginVersion: PACKAGE_VERSION,
    hostName: 'InDesign',
    hostVersion: '21.4.1.4',
    uxpVersion: '8.1.0',
    domVersion: '21.0',
    locale: 'fr_FR',
    openDocuments: 2,
  });
});

test('create_object_style applique réellement les trois modes d’habillage Adobe', async () => {
  const modes = { NONE: 1, BOUNDING_BOX_TEXT_WRAP: 2, CONTOUR: 3 };
  const indesign = { TextWrapModes: modes };
  for (const [requested, expected] of [['none', 1], ['boundingBox', 2], ['contour', 3]]) {
    const textWrapPreferences = { isValid: true, textWrapMode: null };
    const style = { id: 7, name: 'Style premium', isValid: true, enableTextWrapAndOthers: false, textWrapPreferences };
    const doc = { objectStyles: { itemByName: () => style } };
    const registry = createCommandRegistry({}, indesign, {}, require);
    const result = await registry.create_object_style.handler({ name: style.name, textWrap: requested }, { doc });
    assert.equal(result.success, true, requested);
    assert.equal(style.enableTextWrapAndOthers, true, requested);
    assert.equal(textWrapPreferences.textWrapMode, expected, requested);
  }
});

test('le contrat plugin et bridge partage identité, version et double nonce', () => {
  for (const value of [manifest.id, manifest.version]) assert.ok(pluginSource.includes(value));
  assert.ok(bridgeSource.includes(manifest.id));
  // Le pont lit la version dans package.json (src/version.js) : elle doit rester celle du manifeste UXP.
  assert.equal(manifest.version, PACKAGE_VERSION);
  assert.ok(bridgeSource.includes('EXPECTED_PLUGIN_VERSION = PACKAGE_VERSION'));
  assert.ok(pluginSource.includes('pluginNonce'));
  assert.ok(bridgeSource.includes('message.pluginNonce'));
  assert.doesNotMatch(commandSource, /app\.doScript\s*\(/);
  assert.ok(commandSource.includes('const wrapped = await run()'));
});

test('le plugin UXP ne dépend pas de SubtleCrypto pour conserver HMAC-SHA256', () => {
  assert.ok(pluginSource.includes('resolveCryptoApi()'));
  assert.ok(commandSource.includes('resolveCryptoApi()'));
  assert.ok(pluginSource.includes('signHmacHex'));
  assert.ok(pluginSource.includes('verifyHmacHex'));
  assert.ok(securityCryptoSource.includes('window.crypto'));
  assert.ok(securityCryptoSource.includes('sha256.hmac'));
  assert.ok(securityCryptoSource.includes('mode: "local"'));
  assert.doesNotMatch(pluginSource, /cryptoApi\.subtle/);
  assert.doesNotMatch(commandSource, /cryptoApi\.subtle/);
  const nonceBlock = pluginSource.slice(pluginSource.indexOf('function randomNonce'), pluginSource.indexOf('async function sign'));
  const idBlock = commandSource.slice(commandSource.indexOf('function randomId'), commandSource.indexOf('function definition'));
  assert.doesNotMatch(nonceBlock + idBlock, /Math\.random/);
});

test('les actions du panneau restent visibles dans le moteur CSS UXP', () => {
  const actionsRule = pluginHtml.match(/\.actions\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(actionsRule, /display:\s*flex/);
  assert.match(actionsRule, /flex-direction:\s*column/);
  assert.doesNotMatch(actionsRule, /display:\s*grid/);
});

test('les sauvegardes sont durables et compatibles avec la rétention Node', () => {
  assert.ok(commandSource.includes('"backup-" + backupId + ".indd"'));
  assert.ok(!commandSource.includes('getTemporaryFolder'));
  assert.ok(commandSource.includes('saveACopy'));
  assert.ok(commandSource.includes('BACKUP_ALREADY_USED'));
});

test('export_png du plugin distingue le fichier page du dossier multipage', () => {
  const block = commandSource.slice(commandSource.indexOf('commands.export_png'), commandSource.indexOf('commands.package_document'));
  assert.ok(commandSource.includes('function normalizePngExportTarget'));
  assert.ok(block.includes('normalizePngExportTarget(args)'));
  assert.ok(commandSource.includes('args.folderPath'));
  assert.doesNotMatch(block, /args\.outputDirectory/);
  assert.match(block, /parsePageRange\(pageRange, context\.doc\.pages\.length\)/);
  assert.doesNotMatch(block, /page\.exportFile/);
  assert.match(block, /preferences\.pngExportRange = exportRange/);
  assert.match(block, /preferences\.pageString = "\+" \+ String\(page\.documentOffset \+ 1\)/);
  assert.match(block, /context\.doc\.exportFile/);
  assert.match(block, /indesign\.ExportFormat\.PNG_FORMAT/);
  assert.match(block, /indesign\.ExportFormat\.pngFormat/);
});

test('export_png sélectionne chaque page par les préférences Adobe puis les restaure', async () => {
  const pages = [
    { id: 701, name: 'A-1', documentOffset: 0, isValid: true },
    { id: 702, name: 'A-2', documentOffset: 1, isValid: true },
  ];
  const exported = [];
  const document = makeDocument(700, {
    pages,
    overrides: {
      exportFile: async (format, target, showingOptions) => {
        exported.push({
          format,
          target,
          showingOptions,
          pageString: app.pngExportPreferences.pageString,
          range: app.pngExportPreferences.pngExportRange,
          exportingSpread: app.pngExportPreferences.exportingSpread,
        });
      },
    },
  });
  const app = makeApp([document]);
  app.pngExportPreferences = {
    exportResolution: 144,
    transparentBackground: false,
    exportingSpread: true,
    pngExportRange: 'all',
    pageString: 'ancienne-plage',
  };
  const indesign = {
    ExportFormat: { PNG_FORMAT: 'png-officiel' },
    PNGExportRangeEnum: { EXPORT_RANGE: 'range' },
  };
  const registry = createCommandRegistry(app, indesign, {}, require);

  const result = await registry.export_png.handler({
    folderPath: 'C:\\Exports',
    pageRange: '1-2',
    resolution: 300,
    transparentBackground: true,
  }, { doc: document });

  assert.deepEqual(exported, [
    { format: 'png-officiel', target: 'C:\\Exports\\page-0001.png', showingOptions: false, pageString: '+1', range: 'range', exportingSpread: false },
    { format: 'png-officiel', target: 'C:\\Exports\\page-0002.png', showingOptions: false, pageString: '+2', range: 'range', exportingSpread: false },
  ]);
  assert.deepEqual(result.paths, ['C:\\Exports\\page-0001.png', 'C:\\Exports\\page-0002.png']);
  assert.deepEqual(app.pngExportPreferences, {
    exportResolution: 144,
    transparentBackground: false,
    exportingSpread: true,
    pngExportRange: 'all',
    pageString: 'ancienne-plage',
  });
});

test('export_png pageId respecte le fichier exact et restaure les préférences après erreur', async () => {
  const page = { id: 711, name: 'Section:9', documentOffset: 3, isValid: true };
  const failure = new Error('échec réel InDesign');
  const document = makeDocument(710, {
    pages: [page],
    overrides: {
      exportFile: async (format, target) => {
        assert.equal(format, 'png');
        assert.equal(target, 'C:\\Exports\\selection.png');
        assert.equal(app.pngExportPreferences.pageString, '+4');
        assert.equal(app.pngExportPreferences.pngExportRange, 'range');
        assert.equal(app.pngExportPreferences.exportingSpread, false);
        throw failure;
      },
    },
  });
  const app = makeApp([document]);
  app.pngExportPreferences = {
    exportResolution: 72,
    transparentBackground: false,
    exportingSpread: true,
    pngExportRange: 'all',
    pageString: 'avant',
  };
  const registry = createCommandRegistry(app, {
    ExportFormat: { pngFormat: 'png' },
    PNGExportRangeEnum: { exportRange: 'range' },
  }, {}, require);

  await assert.rejects(registry.export_png.handler({
    pageId: page.id,
    filePath: 'C:\\Exports\\selection.png',
    resolution: 600,
    transparentBackground: true,
  }, { doc: document }), failure);

  assert.deepEqual(app.pngExportPreferences, {
    exportResolution: 72,
    transparentBackground: false,
    exportingSpread: true,
    pngExportRange: 'all',
    pageString: 'avant',
  });
});

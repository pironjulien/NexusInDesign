import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApplication } from '../src/server/createApplication.js';
import { analyzeLayoutSnapshot, layoutFingerprint, lintLayoutSnapshot, summarizeLayoutAnomalies } from '../src/workflows/LayoutWorkflow.js';
import { createInddFixture, createMinimalPdf, createRgbaPng } from './helpers/artifactFixtures.js';

const require = createRequire(import.meta.url);
const { createCommandRegistry } = require('../plugin/commands.js');

function snapshot(overrides = {}) {
  return {
    success: true,
    capturedAt: '2026-07-14T00:00:00.000Z',
    documentId: 7,
    revision: 3,
    document: { id: 7, name: 'source.indd', path: 'C:\\source.indd', modified: false, pageCount: 2, facingPages: true, widthMm: 148, heightMm: 210 },
    pages: [
      { id: 11, index: 0, bounds: [0, 0, 210, 148], widthMm: 148, heightMm: 210, margins: { top: 12, left: 12, bottom: 12, right: 12 } },
      { id: 12, index: 1, bounds: [0, 148, 210, 296], widthMm: 148, heightMm: 210, margins: { top: 12, left: 12, bottom: 12, right: 12 } },
    ],
    items: [{ id: 101, type: 'TextFrame', pageId: 11, bounds: [12, 12, 80, 136], overflows: false }],
    links: [{ id: 201, name: 'photo.jpg', statusName: 'NORMAL' }],
    images: [{ id: 301, pageId: 11, effectivePpi: [300, 300] }],
    fonts: [{ name: 'Source Sans 3\tRegular', family: 'Source Sans 3', statusName: 'INSTALLED' }],
    designSystem: {
      layers: [{ name: 'Contenu' }], swatches: [{ name: 'Bleu' }],
      paragraphStyles: [{ name: 'Titre', pointSize: 20 }], characterStyles: [{ name: 'Accent', pointSize: 10 }], objectStyles: [{ name: 'Image' }],
    },
    totalItems: 1,
    truncated: false,
    ...overrides,
  };
}

test('l’empreinte de mise en page ignore les métadonnées volatiles mais détecte la géométrie', () => {
  const baseline = snapshot();
  const sameLayout = snapshot({ capturedAt: '2026-07-15T00:00:00.000Z', documentId: 99, revision: 12, document: { ...snapshot().document, id: 99, name: 'copie.indd', path: 'C:\\copie.indd', modified: true } });
  assert.equal(layoutFingerprint(baseline), layoutFingerprint(sameLayout));
  const changed = snapshot({ items: [{ ...baseline.items[0], bounds: [12, 12, 90, 136] }] });
  assert.notEqual(layoutFingerprint(baseline), layoutFingerprint(changed));
});

test('le lint applique uniquement des règles explicites et bloque les défauts structurels', () => {
  const valid = lintLayoutSnapshot(snapshot(), {
    minEffectivePpi: 240,
    requiredLayers: ['Contenu'],
    requiredParagraphStyles: ['Titre'],
    allowedFonts: ['Source Sans 3'],
    allowedPageSizes: [{ widthMm: 148, heightMm: 210, toleranceMm: 0.1, allowRotation: true }],
  });
  assert.equal(valid.passed, true);

  const invalid = lintLayoutSnapshot(snapshot({
    truncated: true,
    totalItems: 3,
    items: [{ id: 101, type: 'TextFrame', pageId: 11, bounds: [12, 12, 80, 136], overflows: true }],
    links: [{ id: 201, name: 'photo.jpg', statusName: 'LINK_MISSING' }],
    images: [{ id: 301, pageId: 11, effectivePpi: [96, 96] }],
  }), { minEffectivePpi: 240, requiredObjectStyles: ['Carte'] });
  assert.equal(invalid.passed, false);
  assert.deepEqual(new Set(invalid.issues.map((entry) => entry.code)), new Set(['SNAPSHOT_TRUNCATED', 'OVERSET_TEXT', 'MISSING_LINK', 'LOW_EFFECTIVE_PPI', 'REQUIRED_OBJECT_STYLE_MISSING']));
});

test('le lint accepte les traits graphiques horizontaux ou verticaux mais refuse un point sans longueur', () => {
  const validLines = lintLayoutSnapshot(snapshot({
    items: [
      { id: 401, type: 'GraphicLine', pageId: 11, bounds: [20, 10, 20, 138] },
      { id: 402, type: 'GraphicLine', pageId: 11, bounds: [20, 40, 180, 40] },
    ],
    totalItems: 2,
  }));
  assert.equal(validLines.passed, true);

  const point = lintLayoutSnapshot(snapshot({
    items: [{ id: 403, type: 'GraphicLine', pageId: 11, bounds: [20, 40, 20, 40] }],
  }));
  assert.equal(point.passed, false);
  assert.equal(point.issues[0].code, 'INVALID_ITEM_GEOMETRY');
});

test('le diagnostic joint empreinte, statistiques et résultat contractuel', () => {
  const analysis = analyzeLayoutSnapshot(snapshot(), { minMarginMm: 10 });
  assert.match(analysis.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(analysis.statistics.pages, 2);
  assert.equal(analysis.statistics.items, 1);
  assert.equal(analysis.lint.passed, true);
});

test('le résumé de comparaison borne les anomalies sans en masquer le total', () => {
  const issues = Array.from({ length: 50_000 }, (_, index) => ({
    code: index % 2 === 0 ? 'OVERSET_TEXT' : 'INVALID_ITEM_GEOMETRY',
    severity: 'error',
    message: 'Anomalie de test',
    itemId: index + 1,
  }));
  const anomalies = summarizeLayoutAnomalies({ issues, counts: { error: issues.length, warning: 0 } });
  assert.equal(anomalies.total, 50_000);
  assert.equal(anomalies.returned, 200);
  assert.equal(anomalies.truncated, true);
  assert.deepEqual(anomalies.byCode, { INVALID_ITEM_GEOMETRY: 25_000, OVERSET_TEXT: 25_000 });
  assert.ok(JSON.stringify(anomalies).length < 50_000);
});

test('la capture UXP restitue la géométrie et les ressources sans modifier le document', async () => {
  const page = {
    id: 11, name: '1', bounds: [0, 0, 210, 148], appliedMaster: null,
    marginPreferences: { top: 12, left: 12, bottom: 12, right: 12, columnCount: 2, columnGutter: 5 },
  };
  const item = {
    id: 101, constructorName: 'TextFrame', name: 'Titre', parentPage: page,
    itemLayer: { name: 'Contenu', isValid: true }, geometricBounds: [12, 12, 80, 136],
    locked: false, visible: true, nonprinting: false, overflows: false, appliedObjectStyle: null,
  };
  const doc = {
    id: 7, name: 'source.indd', modified: false, extractLabel: () => '3',
    filePath: null, fullName: null,
    viewPreferences: { horizontalMeasurementUnits: 1, verticalMeasurementUnits: 1 },
    documentPreferences: {
      pageWidth: 148, pageHeight: 210, facingPages: true,
      documentBleedTopOffset: 3, documentBleedInsideOrLeftOffset: 3,
      documentBleedBottomOffset: 3, documentBleedOutsideOrRightOffset: 3,
    },
    pages: [page], spreads: [{}], allPageItems: [item], links: [], fonts: [], allGraphics: [],
    swatches: [{ id: 1, name: 'Bleu', colorValue: [100, 80, 0, 10], space: 1, model: 1 }],
    layers: [{ id: 2, name: 'Contenu', visible: true, locked: false, printable: true }],
    paragraphStyles: [], characterStyles: [], objectStyles: [],
  };
  const registry = createCommandRegistry({}, { MeasurementUnits: { millimeters: 2 } }, {}, require);
  const result = await registry.analyze_layout.handler({ maxItems: 100 }, { doc });
  assert.equal(result.document.widthMm, 148);
  assert.equal(result.pages[0].columns.count, 2);
  assert.deepEqual(result.items[0].bounds, [12, 12, 80, 136]);
  assert.equal(result.designSystem.layers[0].name, 'Contenu');
  assert.equal(result.truncated, false);
  assert.equal(doc.viewPreferences.horizontalMeasurementUnits, 1);
});

test('les workflows MCP composent copie, aperçu et finalisation sur les primitives sécurisées', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-layout-workflow-'));
  const readRoot = path.join(directory, 'read');
  const writeRoot = path.join(directory, 'write');
  const secureRoot = path.join(directory, 'secure');
  await Promise.all([fs.mkdir(readRoot), fs.mkdir(writeRoot), fs.mkdir(secureRoot)]);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const calls = [];
  let adobePreflightIssues = [];
  const sourceState = { documentId: 7, revision: 3, stateToken: 'a'.repeat(16) };
  const workingState = { documentId: 99, revision: 3, stateToken: 'b'.repeat(16) };
  const fakeBridge = {
    start: async () => {}, close: async () => {}, status: () => ({ authenticated: true }),
    execute: async ({ command, args, documentId, expectedRevision }) => {
      calls.push(command);
      if (command === 'analyze_layout') return { result: snapshot(), documentId, revision: expectedRevision ?? 3 };
      if (command === 'get_document_info') return { result: { pages: 2 }, documentId, revision: expectedRevision };
      if (command === 'create_safety_backup') {
        const backupId = crypto.randomUUID();
        const backupPath = path.join(args.backupDirectory, `backup-${backupId}.indd`);
        await fs.writeFile(backupPath, createInddFixture());
        return { result: { backupId, backupPath }, documentId, revision: expectedRevision };
      }
      if (command === 'export_png') {
        const paths = [];
        for (let page = 1; page <= 2; page += 1) {
          const output = path.join(args.folderPath, `page-${String(page).padStart(4, '0')}.png`);
          await fs.writeFile(output, createRgbaPng());
          paths.push(output);
        }
        return { result: { paths }, documentId, revision: expectedRevision };
      }
      if (command === 'preflight_document') return { result: { success: true, profile: 'Contrôle', aggregatedResults: ['document.indd', 'Contrôle', adobePreflightIssues], processResults: 'completed' }, documentId, revision: expectedRevision };
      if (command === 'export_pdf') {
        await fs.writeFile(args.filePath, createMinimalPdf());
        return { result: { path: args.filePath }, documentId, revision: expectedRevision };
      }
      if (command === 'open_document') return { result: { documentId: 99, revision: 3 } };
      throw new Error(`Commande simulée inattendue: ${command}`);
    },
  };
  const fakeSilent = {
    initialize: async () => {}, close: async () => {},
    acquireExternalMutationLease: async () => {}, withExpectedExternalLease: async (_operationId, callback) => callback(), releaseExternalMutationLease: async () => {}, transferExternalMutationLease: async () => {},
    inspectDocument: async (documentId) => {
      if (documentId === sourceState.documentId) return { document: sourceState };
      if (documentId === workingState.documentId) return { document: workingState };
      const error = new Error('Document simulé introuvable');
      error.code = 'DOCUMENT_NOT_FOUND';
      throw error;
    },
    registerExternalBackup: async ({ backupId }) => ({
      metadataPath: path.join(secureRoot, 'backups', `backup-${backupId}.json`),
      artifact: { sha256: 'a'.repeat(64) },
    }),
    readDocument: async (command) => {
      calls.push(`silent:${command}`);
      if (command === 'analyze_layout') return snapshot();
      throw new Error(`Lecture silencieuse simulée inattendue: ${command}`);
    },
    preflightDocument: async () => {
      calls.push('silent:preflight_document');
      return { success: true, profile: 'Contrôle', aggregatedResults: ['document.indd', 'Contrôle', adobePreflightIssues], processResults: 'completed', documentId: 7, revision: 3 };
    },
  };
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
    bridgeFactory: () => fakeBridge,
    silentBridgeFactory: () => fakeSilent,
  });
  const client = new Client({ name: 'workflow-test', version: '1.0.0' });
  t.after(async () => {
    await client.close().catch(() => {});
    await application.close().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });
  await application.start();
  await client.connect(clientTransport);

  const analysis = await client.callTool({ name: 'analyze_layout', arguments: { documentId: 7 } });
  assert.equal(analysis.structuredContent.lint.passed, true);
  const compared = await client.callTool({ name: 'compare_layout_snapshot', arguments: { documentId: 7, baselineFingerprint: analysis.structuredContent.fingerprint } });
  assert.equal(compared.structuredContent.matches, true);
  assert.deepEqual(Object.keys(compared.structuredContent).sort(), [
    'anomalies',
    'baselineFingerprint',
    'currentFingerprint',
    'matches',
    'statistics',
  ]);
  assert.equal(compared.structuredContent.statistics.items, 1);
  assert.deepEqual(compared.structuredContent.anomalies, {
    total: 0,
    returned: 0,
    truncated: false,
    counts: { error: 0, warning: 0 },
    byCode: {},
    items: [],
  });
  assert.equal(JSON.stringify(compared.structuredContent).includes('snapshot'), false);

  const workingPath = path.join(writeRoot, 'travail.indd');
  const working = await client.callTool({ name: 'create_working_copy', arguments: { documentId: 7, expectedRevision: 3, expectedStateToken: sourceState.stateToken, path: workingPath, reason: 'Créer une copie de travail contrôlée' } });
  assert.equal(working.structuredContent.sourceUnchanged, true);
  assert.equal(working.structuredContent.workingDocumentId, 99);
  assert.equal(working.structuredContent.stateToken, workingState.stateToken);
  assert.equal(working.structuredContent.workingStateToken, workingState.stateToken);
  assert.match(working.structuredContent.backupMetadataPath, /backup-[a-f0-9-]{36}\.json$/);
  assert.equal(working.structuredContent.backupArtifactSha256, 'a'.repeat(64));
  assert.equal((await fs.stat(workingPath)).isFile(), true);

  const previewFolder = path.join(writeRoot, 'preview');
  const preview = await client.callTool({ name: 'preview_layout', arguments: { documentId: 7, expectedRevision: 3, expectedStateToken: sourceState.stateToken, folderPath: previewFolder, reason: 'Produire un aperçu contrôlé' } });
  assert.equal(preview.structuredContent.sourceUnchanged, true);
  assert.equal(preview.structuredContent.preview.artifactVerification.validPngCount, 2);
  assert.equal(preview.structuredContent.stateToken, sourceState.stateToken);

  const pdfPath = path.join(writeRoot, 'final.pdf');
  const finalized = await client.callTool({ name: 'finalize_layout', arguments: { documentId: 7, expectedRevision: 3, expectedStateToken: sourceState.stateToken, filePath: pdfPath, reason: 'Produire le PDF final contrôlé' } });
  assert.equal(finalized.structuredContent.exported, true);
  assert.equal(finalized.structuredContent.pdf.artifactVerification.kind, 'pdf');
  assert.equal(finalized.structuredContent.stateToken, sourceState.stateToken);
  assert.ok(calls.includes('silent:preflight_document'));

  adobePreflightIssues = [[17, 'Image Resolution', '1', 'Résolution insuffisante', []]];
  const blockedPdfPath = path.join(writeRoot, 'bloque.pdf');
  const exportsBeforeGate = calls.filter((command) => command === 'export_pdf').length;
  const blocked = await client.callTool({ name: 'finalize_layout', arguments: { documentId: 7, expectedRevision: 3, expectedStateToken: sourceState.stateToken, filePath: blockedPdfPath, reason: 'Refuser un PDF non conforme' } });
  assert.equal(blocked.structuredContent.exported, false);
  assert.equal(blocked.structuredContent.gate, 'adobe-preflight');
  assert.equal(blocked.structuredContent.preflightIssues, 1);
  assert.equal(calls.filter((command) => command === 'export_pdf').length, exportsBeforeGate);
  await assert.rejects(fs.access(blockedPdfPath));
});

test('les exports et workflows basculent silencieusement avant envoi quand le plugin est déconnecté', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-layout-silent-fallback-'));
  const readRoot = path.join(directory, 'read');
  const writeRoot = path.join(directory, 'write');
  const secureRoot = path.join(directory, 'secure');
  await Promise.all([fs.mkdir(readRoot), fs.mkdir(writeRoot), fs.mkdir(secureRoot)]);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const state = { documentId: 7, revision: 3, stateToken: 'a'.repeat(16) };
  const pluginCalls = [];
  const silentExports = [];
  const leaseEvents = [];
  let activeLease;
  const fakeBridge = {
    start: async () => {}, close: async () => {}, status: () => ({ listening: true, authenticated: false }),
    execute: async (request) => { pluginCalls.push(request); throw new Error('Le plugin ne doit pas recevoir cet export.'); },
  };
  const fakeSilent = {
    initialize: async () => {}, close: async () => {},
    withSilentMutationLease: async (operationId, callback) => {
      leaseEvents.push(`enter:${operationId}`);
      activeLease = operationId;
      try { return await callback(); }
      finally { leaseEvents.push(`exit:${operationId}`); activeLease = undefined; }
    },
    inspectDocument: async () => ({ document: { ...state } }),
    readDocument: async (command) => {
      if (command === 'get_document_info') return { document: { pages: 2 }, ...state };
      if (command === 'analyze_layout') return snapshot();
      throw new Error(`Lecture silencieuse inattendue: ${command}`);
    },
    preflightDocument: async () => ({
      success: true,
      profile: 'Contrôle',
      aggregatedResults: ['source.indd', 'Contrôle', []],
      processResults: 'completed',
      ...state,
    }),
    exportDocument: async (request) => {
      assert.ok(activeLease, 'l’export doit rester sous le lease silencieux du workflow complet');
      silentExports.push({ ...request, lease: activeLease });
      const backupId = crypto.randomUUID();
      const backupPath = path.join(secureRoot, 'backups', `backup-${backupId}.indd`);
      await fs.mkdir(path.dirname(backupPath), { recursive: true });
      await fs.writeFile(backupPath, createInddFixture());
      const safetyBackups = [{ ...state, backupId, backupPath, metadataPath: `${backupPath}.json`, artifactSha256: 'b'.repeat(64) }];
      if (request.command === 'export_pdf') {
        await fs.writeFile(request.filePath, createMinimalPdf());
        return { result: { success: true, path: request.filePath }, ...state, safetyBackups };
      }
      const paths = [1, 2].map((page) => path.join(request.folderPath, `page-${String(page).padStart(4, '0')}.png`));
      await Promise.all(paths.map((output) => fs.writeFile(output, createRgbaPng())));
      return { result: { success: true, paths }, ...state, safetyBackups };
    },
  };
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
    bridgeFactory: () => fakeBridge,
    silentBridgeFactory: () => fakeSilent,
  });
  const client = new Client({ name: 'silent-fallback-test', version: '1.0.0' });
  t.after(async () => {
    await client.close().catch(() => {});
    await application.close().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });
  await application.start();
  await client.connect(clientTransport);

  const directPdfPath = path.join(writeRoot, 'direct.pdf');
  const directPdf = await client.callTool({ name: 'export_pdf', arguments: { documentId: state.documentId, expectedRevision: state.revision, expectedStateToken: state.stateToken, filePath: directPdfPath, reason: 'Exporter sans plugin connecté' } });
  assert.equal(directPdf.isError, undefined, JSON.stringify(directPdf));
  assert.equal(directPdf.structuredContent.executionChannel, 'silent');
  assert.equal(directPdf.structuredContent.artifactVerification.kind, 'pdf');

  const previewFolder = path.join(writeRoot, 'preview');
  const preview = await client.callTool({ name: 'preview_layout', arguments: { documentId: state.documentId, expectedRevision: state.revision, expectedStateToken: state.stateToken, folderPath: previewFolder, pageRange: '1-2', reason: 'Prévisualiser sans plugin connecté' } });
  assert.equal(preview.isError, undefined, JSON.stringify(preview));
  assert.equal(preview.structuredContent.preview.executionChannel, 'silent');
  assert.equal(preview.structuredContent.preview.artifactVerification.validPngCount, 2);

  const finalPath = path.join(writeRoot, 'final.pdf');
  const final = await client.callTool({ name: 'finalize_layout', arguments: { documentId: state.documentId, expectedRevision: state.revision, expectedStateToken: state.stateToken, filePath: finalPath, reason: 'Finaliser sans plugin connecté' } });
  assert.equal(final.isError, undefined, JSON.stringify(final));
  assert.equal(final.structuredContent.pdf.executionChannel, 'silent');
  assert.equal(pluginCalls.length, 0);
  assert.deepEqual(silentExports.map((entry) => entry.command), ['export_pdf', 'export_png', 'export_pdf']);
  assert.equal(new Set(silentExports.map((entry) => entry.lease)).size, 3);
  assert.equal(leaseEvents.filter((entry) => entry.startsWith('enter:')).length, 3);
  assert.equal(leaseEvents.filter((entry) => entry.startsWith('exit:')).length, 3);
});

test('une erreur du plugin authentifié n’est jamais rejouée sur le canal silencieux', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-layout-no-retry-'));
  const readRoot = path.join(directory, 'read');
  const writeRoot = path.join(directory, 'write');
  const secureRoot = path.join(directory, 'secure');
  await Promise.all([fs.mkdir(readRoot), fs.mkdir(writeRoot), fs.mkdir(secureRoot)]);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const state = { documentId: 7, revision: 3, stateToken: 'a'.repeat(16) };
  let silentExportCalls = 0;
  const fakeBridge = {
    start: async () => {}, close: async () => {}, status: () => ({ listening: true, authenticated: true }),
    execute: async ({ command, args, documentId, expectedRevision }) => {
      if (command === 'create_safety_backup') {
        const backupId = crypto.randomUUID();
        const backupPath = path.join(args.backupDirectory, `backup-${backupId}.indd`);
        await fs.writeFile(backupPath, createInddFixture());
        return { result: { backupId, backupPath }, documentId, revision: expectedRevision };
      }
      assert.equal(command, 'export_pdf');
      const error = new Error('Le délai plugin est dépassé et son issue est inconnue.');
      error.code = 'PLUGIN_TIMEOUT';
      error.requiresInspection = true;
      throw error;
    },
  };
  const fakeSilent = {
    initialize: async () => {}, close: async () => {},
    acquireExternalMutationLease: async () => {},
    withExpectedExternalLease: async (_operationId, callback) => callback(),
    releaseExternalMutationLease: async () => {},
    transferExternalMutationLease: async () => {},
    inspectDocument: async () => ({ document: { ...state } }),
    registerExternalBackup: async ({ backupId }) => ({
      metadataPath: path.join(secureRoot, 'backups', `backup-${backupId}.json`),
      artifact: { sha256: 'c'.repeat(64) },
    }),
    exportDocument: async () => { silentExportCalls += 1; throw new Error('Rejeu silencieux interdit.'); },
  };
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
    bridgeFactory: () => fakeBridge,
    silentBridgeFactory: () => fakeSilent,
  });
  const client = new Client({ name: 'no-retry-test', version: '1.0.0' });
  t.after(async () => {
    await client.close().catch(() => {});
    await application.close().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });
  await application.start();
  await client.connect(clientTransport);

  const result = await client.callTool({
    name: 'export_pdf',
    arguments: {
      documentId: state.documentId,
      expectedRevision: state.revision,
      expectedStateToken: state.stateToken,
      filePath: path.join(writeRoot, 'inconnu.pdf'),
      reason: 'Prouver l’absence de double export après délai',
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /PLUGIN_TIMEOUT/);
  assert.equal(silentExportCalls, 0);
});

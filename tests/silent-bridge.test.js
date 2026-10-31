import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { InDesignSilentBridge } from '../src/bridge/InDesignSilentBridge.js';
import { acquireWindowsNamedMutexGuard } from '../src/bridge/WindowsNamedMutexGuard.js';
import { createInddFixture, createMinimalPdf, createRgbaPng } from './helpers/artifactFixtures.js';

const execFileAsync = promisify(execFile);
const pluginRequire = createRequire(import.meta.url);
const { documentStateToken } = pluginRequire('../plugin/commands.js');
const TOKEN_A = 'a'.repeat(16);
const TOKEN_B = 'b'.repeat(16);
const HOST_BEFORE = { processId: 31_001, startedAt: '2026-07-15T08:00:00.000Z' };
const HOST_AFTER = { processId: 31_002, startedAt: '2026-07-15T08:01:00.000Z' };

function jsonAssignment(source, name) {
  const match = source.match(new RegExp(`const ${name} = ("(?:\\\\.|[^"\\\\])*");`));
  assert.ok(match, `${name} doit être sérialisé dans le script privé.`);
  return JSON.parse(match[1]);
}

function backupRequest(source) {
  const backupPathMatch = source.match(/saveACopy\(File\(("(?:\\.|[^"\\])*")\)\)/);
  const backupIdMatch = source.match(/return "OK\|" \+ ("[a-f0-9-]{36}")/);
  return {
    documentId: Number(source.match(/var wanted = (\d+);/)?.[1]),
    revision: Number(source.match(/var expected = (\d+);/)?.[1]),
    backupPath: JSON.parse(backupPathMatch?.[1]),
    backupId: JSON.parse(backupIdMatch?.[1]),
  };
}

function requestedDocumentId(source) {
  return Number(source.match(/const wanted = (\d+);/)?.[1]);
}

async function writeBackupWithMetadata(directory, { backupId, documentId, revision, stateToken, content }) {
  const backupPath = path.join(directory, `backup-${backupId}.indd`);
  await fs.writeFile(backupPath, content);
  const metadataPath = path.join(directory, `backup-${backupId}.meta.json`);
  await fs.writeFile(metadataPath, JSON.stringify({
    schemaVersion: 1,
    backupId,
    documentId,
    revision,
    stateToken,
    createdAt: new Date().toISOString(),
    artifact: {
      fileName: path.basename(backupPath),
      size: Buffer.byteLength(content),
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
    },
  }));
  return { backupPath, metadataPath };
}

async function fixture(t, responder, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-silent-'));
  const calls = [];
  const mutexes = fakeMutexFactory();
  const invoke = async (file, args, runOptions) => {
    const scriptPath = args[args.indexOf('-ScriptPath') + 1];
    const language = args[args.indexOf('-Language') + 1];
    const source = await fs.readFile(scriptPath, 'utf8');
    calls.push({ file, args, options: runOptions, scriptPath, language, source });
    const result = await responder({ language, source, calls, directory });
    return { stdout: JSON.stringify({ ok: true, result }) };
  };
  const guardedRun = async ({ operationId, scriptPath, language, completionPath, completionTimeoutMs, mutationDispatch }) => {
    if (mutationDispatch === true) {
      const operationPath = mutexes.calls.findLast((entry) => entry.operationPath.endsWith(`${operationId}.jsonl`))?.operationPath;
      assert.ok(operationPath, 'le journal durable doit exister avant l’envoi UXP');
      const record = JSON.parse(await fs.readFile(operationPath, 'utf8'));
      await fs.writeFile(operationPath, JSON.stringify({
        ...record,
        status: 'uxp-dispatched',
        uxpDispatchedAt: new Date().toISOString(),
        hostProcessesAtDispatch: [HOST_BEFORE],
      }));
    }
    const args = ['-ScriptPath', scriptPath, '-Language', language];
    if (completionPath) args.push('-CompletionPath', completionPath, '-CompletionTimeoutMs', String(completionTimeoutMs));
    return invoke('mutex-helper', args, { guarded: true });
  };
  const bridge = new InDesignSilentBridge({
    backupDirectory: directory,
    timeoutMs: options.timeoutMs ?? 500,
    protect: async () => {},
    run: invoke,
    operationMutexFactory: mutexes.factory,
    guardedRun,
    hostProcessSnapshot: options.hostProcessSnapshot ?? (async () => [HOST_AFTER]),
  });
  await bridge.initialize();
  t.after(async () => {
    mutexes.resolveAll();
    await bridge.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { bridge, calls, directory, mutexes, guardedRun, run: invoke };
}

function fakeMutexFactory() {
  let nextProcessId = 40_000;
  const calls = [];
  const guards = [];
  const factory = async (options) => {
    calls.push(options);
    let resolveExit;
    const exit = new Promise((resolve) => { resolveExit = resolve; });
    const guard = {
      processId: nextProcessId += 1,
      mutex: 'Local\\NexusInDesignAutomation',
      status: options.expectedGuardProcessId ? 'watching' : 'acquired',
      exit,
      resolve: (state = { code: 0, signal: null }) => resolveExit(state),
    };
    guards.push({ ...guard, operationPath: options.operationPath, releaseNonce: options.releaseNonce });
    const markerPath = path.join(
      path.dirname(options.operationPath),
      `${path.basename(options.operationPath, path.extname(options.operationPath))}.${options.releaseNonce}.release.json`,
    );
    const timer = setInterval(async () => {
      const exists = await fs.access(markerPath).then(() => true).catch(() => false);
      if (!exists) return;
      clearInterval(timer);
      resolveExit({ code: 0, signal: null });
    }, 5);
    timer.unref?.();
    exit.finally(() => clearInterval(timer)).catch(() => {});
    return guard;
  };
  return {
    factory,
    calls,
    guards,
    resolveAll() {
      for (const guard of guards) guard.resolve();
    },
  };
}

async function probeWindowsInDesignMutex(timeoutMs = 250, mutexName = 'Local\\NexusInDesignAutomation') {
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const powershell = path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const source = `$mutex = New-Object System.Threading.Mutex($false, '${mutexName}')
$acquired = $false
$abandoned = $false
try { $acquired = $mutex.WaitOne(${Number(timeoutMs)}) }
catch [System.Threading.AbandonedMutexException] { $acquired = $true; $abandoned = $true }
finally {
  if ($acquired) { try { $mutex.ReleaseMutex() } catch {} }
  $mutex.Dispose()
}
[pscustomobject]@{ acquired = $acquired; abandoned = $abandoned } | ConvertTo-Json -Compress`;
  const { stdout } = await execFileAsync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', source], {
    windowsHide: true,
    timeout: Math.max(5_000, timeoutMs + 2_000),
  });
  return JSON.parse(String(stdout).trim());
}

function isList(source) {
  return source.includes('documents.push({ documentId:');
}

function isInspect(source) {
  return source.includes('script.setResult(JSON.stringify({ ok: true, document:')
    && source.includes('stateToken: documentStateToken(doc)');
}

function uxpCollection(values = []) {
  return {
    length: values.length,
    item(index) { return values[index]; },
  };
}

function exportPreferenceState(app) {
  return {
    interaction: app.scriptPreferences.userInteractionLevel,
    redraw: app.scriptPreferences.enableRedraw,
    pdf: {
      pageRange: app.pdfExportPreferences.pageRange,
      bleed: app.pdfExportPreferences.useDocumentBleedWithPDF,
      cropMarks: app.pdfExportPreferences.cropMarks,
    },
    png: {
      resolution: app.pngExportPreferences.exportResolution,
      transparent: app.pngExportPreferences.transparentBackground,
      range: app.pngExportPreferences.pngExportRange,
      pageString: app.pngExportPreferences.pageString,
      exportingSpread: app.pngExportPreferences.exportingSpread,
    },
  };
}

function createExecutableExportUxp({
  directory,
  documentId = 42,
  revision = 7,
  pageIds = [501, 502],
  refusePngPageStringRestore = false,
  packageCompletes = true,
  graphics = [],
} = {}) {
  const empty = () => uxpCollection();
  const pages = pageIds.map((id, index) => ({
    id,
    name: String(index + 1),
    constructorName: 'Page',
    documentOffset: index,
    bounds: [0, 0, 210, 148],
    side: 'single',
    appliedMaster: null,
    appliedParentPage: null,
    marginPreferences: {
      properties: { top: 12, bottom: 12, left: 12, right: 12 },
      top: 12,
      bottom: 12,
      left: 12,
      right: 12,
      columnCount: 1,
      columnGutter: 4,
      columnDirection: 'horizontal',
    },
    guides: empty(),
  }));
  const pageCollection = uxpCollection(pages);
  const documentPreferences = {
    properties: { pageWidth: 148, pageHeight: 210, facingPages: false },
    pageWidth: 148,
    pageHeight: 210,
    facingPages: false,
    pagesPerDocument: pages.length,
    pageBinding: 'left',
    startPageNumber: 1,
    documentBleedTopOffset: 3,
    documentBleedBottomOffset: 3,
    documentBleedInsideOrLeftOffset: 3,
    documentBleedOutsideOrRightOffset: 3,
    slugTopOffset: 0,
    slugBottomOffset: 0,
    slugInsideOrLeftOffset: 0,
    slugRightOrOutsideOffset: 0,
  };
  const exports = [];
  let app;
  const document = {
    id: documentId,
    isValid: true,
    name: 'cible.indd',
    fullName: path.join(directory, 'cible.indd'),
    filePath: directory,
    modified: false,
    saved: true,
    pages: pageCollection,
    spreads: empty(),
    masterSpreads: empty(),
    stories: empty(),
    links: empty(),
    layers: empty(),
    allPageItems: [],
    swatches: empty(),
    colors: empty(),
    gradients: empty(),
    paragraphStyles: empty(),
    characterStyles: empty(),
    objectStyles: empty(),
    tableStyles: empty(),
    cellStyles: empty(),
    documentPreferences,
    extractLabel: () => String(revision),
    async exportFile(format, targetPath, showOptions, preset) {
      exports.push({
        format,
        targetPath,
        showOptions,
        preset,
        preferences: exportPreferenceState(app),
      });
      await fs.writeFile(targetPath, format === 'pdf-format' ? createMinimalPdf() : createRgbaPng());
    },
    allGraphics: graphics,
    fonts: empty(),
    packageForPrint(...packageArgs) {
      exports.push({ format: 'package', packageArgs, preferences: exportPreferenceState(app) });
      return packageCompletes;
    },
  };
  const pngPreferences = {
    exportResolution: 72,
    transparentBackground: false,
    pngExportRange: 'png-range-initial',
    exportingSpread: true,
  };
  let pngPageString = 'page-initiale';
  let pngPageStringChanged = false;
  Object.defineProperty(pngPreferences, 'pageString', {
    enumerable: true,
    get: () => pngPageString,
    set: (value) => {
      if (refusePngPageStringRestore && pngPageStringChanged && value === 'page-initiale') {
        throw new Error('restauration pageString refusée');
      }
      if (value !== 'page-initiale') pngPageStringChanged = true;
      pngPageString = value;
    },
  });
  app = {
    modalState: false,
    documents: uxpCollection([document]),
    scriptPreferences: { userInteractionLevel: 'interaction-initiale', enableRedraw: true },
    pdfExportPreferences: { pageRange: 'pdf-range-initial', useDocumentBleedWithPDF: false, cropMarks: true },
    pngExportPreferences: pngPreferences,
    pdfExportPresets: {
      itemByName(name) { return { isValid: true, name }; },
    },
  };
  const indesign = {
    app,
    UserInteractionLevels: { NEVER_INTERACT: 'never-interact' },
    PageRange: { ALL_PAGES: 'all-pages' },
    ExportFormat: { pdfType: 'pdf-format', PNG_FORMAT: 'png-format' },
    PNGExportRangeEnum: { EXPORT_RANGE: 'png-range-export' },
  };
  return {
    app,
    document,
    documents: [{ documentId, name: document.name, revision, active: true }],
    exports,
    indesign,
    stateToken: documentStateToken(document),
  };
}

async function executeGeneratedAsyncUxp(source, harness) {
  const requireUxp = (name) => {
    if (name === 'indesign') return harness.indesign;
    if (name === 'uxp') return {};
    if (name === 'fs') return fs;
    throw new Error(`Module UXP inattendu: ${name}`);
  };
  await new Function('require', `return (async function generatedUxpScript() {\n${source}\n}());`)(requireUxp);
}

test('le canal silencieux utilise un script privé unique puis le supprime', async (t) => {
  const { bridge, calls } = await fixture(t, () => JSON.stringify({ ok: true, mode: 'silent-com-uxp', version: '21.4.1.4', openDocuments: 0 }));
  const result = await bridge.status();
  assert.equal(result.mode, 'silent-com-uxp');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'pwsh.exe');
  assert.equal(calls[0].language, 'UXP');
  assert.equal(calls[0].options.windowsHide, true);
  assert.match(calls[0].source, /durableOperationMutex: true/);
  await assert.rejects(fs.access(calls[0].scriptPath));
  assert.ok(!JSON.stringify(calls[0].args).includes('silent-com-uxp'));
});

test('le runtime silencieux peut rester local tandis que les sauvegardes restent persistantes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-runtime-split-'));
  const backupDirectory = path.join(root, 'persistent-backups');
  const runtimeRoot = path.join(root, 'local-runtime');
  await fs.mkdir(backupDirectory);
  const bridge = new InDesignSilentBridge({
    backupDirectory,
    runtimeRoot,
    protect: async () => {},
    run: async () => ({ stdout: JSON.stringify({ ok: true, result: JSON.stringify({ ok: true, modalState: false }) }) }),
  });
  await bridge.initialize();
  t.after(async () => {
    await bridge.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  assert.equal(bridge.runtimeRoot, runtimeRoot);
  assert.equal(bridge.backupDirectory, backupDirectory);
  assert.equal((await fs.stat(runtimeRoot)).isDirectory(), true);
  await assert.rejects(fs.access(path.join(backupDirectory, '.silent-runtime')));
});

test('enregistre durablement la provenance d’une sauvegarde créée par le plugin', async (t) => {
  const { bridge, directory } = await fixture(t, () => JSON.stringify({ ok: true, mode: 'silent-com-uxp', version: '21.4.1.4', openDocuments: 0 }));
  const backupId = 'a'.repeat(36);
  const backupPath = path.join(directory, `backup-${backupId}.indd`);
  await fs.writeFile(backupPath, createInddFixture());

  const metadata = await bridge.registerExternalBackup({
    backupId,
    backupPath,
    documentId: 42,
    revision: 7,
    stateToken: TOKEN_A,
  });

  assert.equal(metadata.backupId, backupId);
  assert.equal(metadata.documentId, 42);
  assert.equal(metadata.revision, 7);
  assert.equal(metadata.stateToken, TOKEN_A);
  assert.match(metadata.artifact.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(directory, `backup-${backupId}.meta.json`), 'utf8')),
    {
      schemaVersion: 1,
      backupId,
      documentId: 42,
      revision: 7,
      stateToken: TOKEN_A,
      createdAt: metadata.createdAt,
      artifact: metadata.artifact,
    },
  );

  await assert.rejects(
    bridge.registerExternalBackup({ backupId, backupPath: path.join(directory, 'autre.indd'), documentId: 42, revision: 7, stateToken: TOKEN_A }),
    (error) => error.code === 'BACKUP_PATH_MISMATCH',
  );
});

test('un lease externe attendu autorise seulement ses inspections silencieuses exactes', async (t) => {
  const { bridge, calls } = await fixture(t, () => JSON.stringify({ ok: true, modalState: false, openDocuments: 0 }));
  const operationId = crypto.randomUUID();
  await bridge.acquireExternalMutationLease(operationId);
  await assert.rejects(
    bridge.withExpectedExternalLease(crypto.randomUUID(), () => bridge.status()),
    (error) => error.code === 'EXTERNAL_LEASE_CONTEXT_MISMATCH',
  );
  await bridge.withExpectedExternalLease(operationId, () => bridge.status());
  const expectedIndex = calls.at(-1).args.indexOf('-ExpectedLeaseOperationId');
  assert.ok(expectedIndex >= 0);
  assert.equal(calls.at(-1).args[expectedIndex + 1], operationId);
  await bridge.releaseExternalMutationLease(operationId);
  await bridge.status();
  assert.equal(calls.at(-1).args.includes('-ExpectedLeaseOperationId'), false, 'le contexte externe ne doit pas fuir vers une lecture suivante');
});

test('une écriture asynchrone sauvegarde tous les documents et produit un état vérifiable', async (t) => {
  const documents = [
    { documentId: 42, name: 'cible.indd', revision: 7, active: true },
    { documentId: 99, name: 'autre.indd', revision: 3, active: false },
  ];
  const { bridge, calls, directory, mutexes } = await fixture(t, async ({ language, source }) => {
    if (language === 'JAVASCRIPT') {
      const request = backupRequest(source);
      await fs.writeFile(request.backupPath, createInddFixture());
      return `OK|${request.backupId}|${request.documentId}|${request.revision}`;
    }
    if (isList(source)) return JSON.stringify({ ok: true, documents });
    if (isInspect(source)) {
      const document = documents.find((entry) => entry.documentId === requestedDocumentId(source));
      return JSON.stringify({ ok: true, document: { ...document, stateToken: TOKEN_A } });
    }
    assert.doesNotThrow(
      () => new Function(`return async function generatedUxpScript() {\n${source}\n}`),
      'Le JavaScript UXP généré doit être syntaxiquement valide avant son envoi à InDesign.',
    );
    const resultPath = jsonAssignment(source, '__resultPath');
    const operationId = jsonAssignment(source, '__operationId');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await fs.writeFile(resultPath, JSON.stringify({
      ok: true,
      result: { changed: true },
      documentId: 42,
      revision: 8,
      revisions: [{ documentId: 42, revision: 8 }, { documentId: 99, revision: 4 }],
      stateToken: TOKEN_B,
      operationId,
    }));
    return null;
  });

  const result = await bridge.executeDocument({
    documentId: 42,
    expectedRevision: 7,
    expectedStateToken: TOKEN_A,
    reason: 'Ajuster le bloc',
    code: 'await Promise.resolve(); return { changed: true };',
    input: { x: 1 },
  });

  assert.equal(calls.filter((call) => call.language === 'JAVASCRIPT').length, 2);
  assert.equal(calls.at(-1).language, 'UXP');
  assert.equal(calls.at(-1).file, 'mutex-helper');
  assert.equal(calls.at(-1).options.guarded, true);
  assert.equal(mutexes.calls.length, 1);
  assert.match(mutexes.calls[0].operationPath, /[\\/][a-f0-9-]{36}\.jsonl$/);
  assert.match(mutexes.calls[0].releaseNonce, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(calls.at(-1).args.includes('-UndoName'), false);
  assert.match(calls.at(-1).source, /new Function\("app", "indesign", "doc", "input"/);
  assert.match(calls.at(-1).source, /const expectedDocuments = \[/);
  assert.match(calls.at(-1).source, /DOCUMENT_STATE_CONFLICT/);
  assert.ok(calls.findIndex((call) => call.language === 'JAVASCRIPT') > calls.findIndex((call) => call.options.guarded === true), 'le mutex doit précéder toute sauvegarde');
  assert.doesNotMatch(calls.at(-1).source, /documentsBefore\.length\s*=/);
  assert.match(calls.at(-1).source, /finally \{/);
  assert.equal(result.revision, 8);
  assert.equal(result.result.changed, true);
  assert.equal(result.stateToken, TOKEN_B);
  assert.equal(result.safetyBackups.length, 2);
  for (const backup of result.safetyBackups) {
    assert.match(backup.backupPath, new RegExp(`^${directory.replaceAll('\\', '\\\\')}`));
    assert.equal((await fs.stat(backup.backupPath)).size > 0, true);
    assert.equal(backup.stateToken, TOKEN_A);
    assert.equal((await fs.stat(backup.metadataPath)).isFile(), true);
    const metadata = JSON.parse(await fs.readFile(backup.metadataPath, 'utf8'));
    assert.equal(metadata.documentId, backup.documentId);
    assert.equal(metadata.revision, backup.revision);
    assert.equal(metadata.stateToken, backup.stateToken);
  }
});

test('les exports silencieux PDF et PNG restaurent les préférences et ne changent aucun document', async (t) => {
  let harness;
  const { bridge, calls } = await fixture(t, async ({ language, source }) => {
    if (language === 'JAVASCRIPT') {
      const request = backupRequest(source);
      await fs.writeFile(request.backupPath, createInddFixture());
      return `OK|${request.backupId}|${request.documentId}|${request.revision}`;
    }
    if (isList(source)) return JSON.stringify({ ok: true, documents: harness.documents });
    if (isInspect(source)) {
      const document = harness.documents.find((entry) => entry.documentId === requestedDocumentId(source));
      return JSON.stringify({ ok: true, document: { ...document, stateToken: harness.stateToken } });
    }
    await executeGeneratedAsyncUxp(source, harness);
    return null;
  });
  harness = createExecutableExportUxp({ directory: bridge.backupDirectory });
  const initialPreferences = exportPreferenceState(harness.app);
  const pdfPath = path.join(bridge.backupDirectory, 'preuve.pdf');
  const pngPath = path.join(bridge.backupDirectory, 'page-cible.png');

  const pdf = await bridge.exportDocument({
    command: 'export_pdf',
    documentId: 42,
    expectedRevision: 7,
    expectedStateToken: harness.stateToken,
    filePath: pdfPath,
    presetName: 'Qualité contrôlée',
  });
  const png = await bridge.exportDocument({
    command: 'export_png',
    documentId: 42,
    expectedRevision: 7,
    expectedStateToken: harness.stateToken,
    pageId: 502,
    filePath: pngPath,
    resolution: 144,
    transparentBackground: true,
  });

  assert.equal(pdf.revision, 7);
  assert.equal(png.revision, 7);
  assert.equal(pdf.stateToken, harness.stateToken);
  assert.equal(png.stateToken, harness.stateToken);
  assert.equal(pdf.safetyBackups.length, 1);
  assert.equal(png.safetyBackups.length, 1);
  assert.equal((await fs.stat(pdfPath)).size > 0, true);
  assert.equal((await fs.stat(pngPath)).size > 0, true);
  assert.deepEqual(png.result.paths, [pngPath.replaceAll('\\', '/')]);
  assert.deepEqual(exportPreferenceState(harness.app), initialPreferences);
  assert.equal(harness.exports.length, 2);
  assert.deepEqual(harness.exports[0], {
    format: 'pdf-format',
    targetPath: pdfPath.replaceAll('\\', '/'),
    showOptions: false,
    preset: { isValid: true, name: 'Qualité contrôlée' },
    preferences: {
      ...initialPreferences,
      interaction: 'never-interact',
      redraw: false,
      pdf: { pageRange: 'all-pages', bleed: true, cropMarks: false },
    },
  });
  assert.deepEqual(harness.exports[1], {
    format: 'png-format',
    targetPath: pngPath.replaceAll('\\', '/'),
    showOptions: false,
    preset: undefined,
    preferences: {
      ...initialPreferences,
      interaction: 'never-interact',
      redraw: false,
      png: {
        resolution: 144,
        transparent: true,
        range: 'png-range-export',
        pageString: '+2',
        exportingSpread: false,
      },
    },
  });
  const exportSources = calls.filter((call) => call.source.includes('restorationFailures'));
  assert.equal(exportSources.length, 2);
  for (const call of exportSources) {
    assert.match(call.source, /EXPORT_PREFERENCES_RESTORE_FAILED/);
    assert.match(call.source, /EXPORT_DOCUMENT_STATE_CHANGED/);
    assert.doesNotMatch(call.source, /insertLabel\(/);
    assert.doesNotMatch(call.source, /expectedRevision \+ 1/);
  }
});

test('l’assemblage silencieux tourne sans dialogue et explique un refus d’InDesign', async (t) => {
  let harness;
  const { bridge } = await fixture(t, async ({ language, source }) => {
    if (language === 'JAVASCRIPT') {
      const request = backupRequest(source);
      await fs.writeFile(request.backupPath, createInddFixture());
      return `OK|${request.backupId}|${request.documentId}|${request.revision}`;
    }
    if (isList(source)) return JSON.stringify({ ok: true, documents: harness.documents });
    if (isInspect(source)) {
      return JSON.stringify({ ok: true, document: { ...harness.documents[0], stateToken: harness.stateToken } });
    }
    await executeGeneratedAsyncUxp(source, harness);
    return null;
  });
  const rgbImage = { space: 'RVB', itemLink: { name: 'badge.png' } };
  harness = createExecutableExportUxp({ directory: bridge.backupDirectory, packageCompletes: false, graphics: [rgbImage, { space: 'CMJN', itemLink: { name: 'fond.tif' } }] });
  const initialPreferences = exportPreferenceState(harness.app);
  const folderPath = path.join(bridge.backupDirectory, 'assemblage');
  const request = { command: 'package_document', documentId: 42, expectedRevision: 7, expectedStateToken: harness.stateToken, folderPath };

  await assert.rejects(bridge.exportDocument(request), (error) => {
    assert.equal(error.code, 'PACKAGE_REFUSED_BY_CHECKS');
    assert.match(error.message, /1 image\(s\) RVB : badge\.png/);
    assert.match(error.message, /ignorePreflightErrors=true/);
    assert.notEqual(error.requiresInspection, true);
    assert.equal(error.safetyBackups.length, 1);
    return true;
  });
  assert.deepEqual(exportPreferenceState(harness.app), initialPreferences);
  const refused = harness.exports.at(-1);
  assert.equal(refused.format, 'package');
  assert.equal(refused.preferences.interaction, 'never-interact');
  assert.deepEqual(refused.packageArgs.slice(0, 11), [folderPath.replaceAll('\\', '/'), true, true, true, true, false, false, true, true, true, '']);

  harness = createExecutableExportUxp({ directory: bridge.backupDirectory, graphics: [rgbImage] });
  const packaged = await bridge.exportDocument({ ...request, expectedStateToken: harness.stateToken, ignorePreflightErrors: true, includePdf: false });
  assert.equal(packaged.result.success, true);
  assert.equal(packaged.revision, 7);
  assert.equal(packaged.stateToken, harness.stateToken);
  assert.equal(harness.exports.at(-1).packageArgs[6], true);
  assert.equal(harness.exports.at(-1).packageArgs[9], false);
  await assert.rejects(bridge.exportDocument({ ...request, includeFonts: 'oui' }), { code: 'PACKAGE_OPTIONS_INVALID' });
});

test('un export PNG partiel dont la préférence ne se restaure pas conserve son lease', async (t) => {
  let harness;
  const { bridge } = await fixture(t, async ({ language, source }) => {
    if (language === 'JAVASCRIPT') {
      const request = backupRequest(source);
      await fs.writeFile(request.backupPath, createInddFixture());
      return `OK|${request.backupId}|${request.documentId}|${request.revision}`;
    }
    if (isList(source)) return JSON.stringify({ ok: true, documents: harness.documents });
    if (isInspect(source)) {
      return JSON.stringify({ ok: true, document: { ...harness.documents[0], stateToken: harness.stateToken } });
    }
    await executeGeneratedAsyncUxp(source, harness);
    return null;
  });
  harness = createExecutableExportUxp({
    directory: bridge.backupDirectory,
    pageIds: [501],
    refusePngPageStringRestore: true,
  });
  const outputPath = path.join(bridge.backupDirectory, 'partiel.png');
  let exportError;

  await assert.rejects(
    bridge.exportDocument({
      command: 'export_png',
      documentId: 42,
      expectedRevision: 7,
      expectedStateToken: harness.stateToken,
      pageId: 501,
      filePath: outputPath,
      resolution: 144,
      transparentBackground: false,
    }),
    (error) => {
      exportError = error;
      return error.code === 'EXPORT_PREFERENCES_RESTORE_FAILED'
        && error.requiresInspection === true
        && Array.isArray(error.safetyBackups)
        && error.safetyBackups.length === 1;
    },
  );

  assert.equal((await fs.stat(outputPath)).size > 0, true, 'le fichier partiel doit rester disponible pour inspection');
  assert.equal(harness.app.scriptPreferences.userInteractionLevel, 'interaction-initiale');
  assert.equal(harness.app.scriptPreferences.enableRedraw, true);
  assert.equal(harness.app.pngExportPreferences.exportResolution, 72);
  assert.equal(harness.app.pngExportPreferences.transparentBackground, false);
  assert.equal(harness.app.pngExportPreferences.pngExportRange, 'png-range-initial');
  assert.equal(harness.app.pngExportPreferences.exportingSpread, true);
  assert.equal(harness.app.pngExportPreferences.pageString, '+1', 'la préférence refusée prouve la nécessité d’inspection');
  const lease = JSON.parse(await fs.readFile(path.join(bridge.runtimeRoot, '.mutation-lease.json'), 'utf8'));
  assert.equal(lease.operationId, exportError.operationId);
  const status = await bridge.operationStatus(exportError.operationId);
  assert.equal(status.status, 'completed-requires-reconciliation');
  assert.equal(status.requiresInspection, true);
  assert.equal(status.requiresReconciliation, true);
});

test('un stateToken périmé bloque l’écriture avant toute sauvegarde', async (t) => {
  const { bridge, calls } = await fixture(t, ({ source }) => {
    if (isList(source)) return JSON.stringify({ ok: true, documents: [{ documentId: 5, name: 'test.indd', revision: 0 }] });
    if (isInspect(source)) return JSON.stringify({ ok: true, document: { documentId: 5, revision: 0, stateToken: TOKEN_B } });
    throw new Error('Aucune sauvegarde ni mutation ne doit être atteinte.');
  });
  await assert.rejects(
    bridge.executeDocument({ documentId: 5, expectedRevision: 0, expectedStateToken: TOKEN_A, reason: 'Tester le verrou', code: 'return 1;' }),
    (error) => error.code === 'STATE_CONFLICT',
  );
  assert.equal(calls.length, 2);
});

test('l’audit silencieux mutualise les lectures structurées sans modifier le document', async (t) => {
  const audit = {
    success: true,
    documentId: 12,
    revision: 4,
    capturedAt: '2026-07-14T12:00:00.000Z',
    stateToken: TOKEN_A,
    document: { id: 12, name: 'audit.indd', path: 'C:\\audit.indd', modified: false, pageCount: 1, spreadCount: 1, facingPages: true, widthMm: 148, heightMm: 210, bleedMm: { top: 3, inside: 3, bottom: 3, outside: 3 } },
    counts: { pages: 1, spreads: 1, layers: 1, masterSpreads: 1 },
    pages: [{ id: 21, index: 0, name: '1', bounds: [0, 0, 210, 148], widthMm: 148, heightMm: 210, margins: { top: 10, left: 10, bottom: 10, right: 10 }, columns: { count: 1, gutterMm: 4 }, appliedMaster: { id: 31, name: 'A-Gabarit' } }],
    items: [{ id: 41, type: 'TextFrame', name: 'Titre', pageId: 21, layerName: 'Contenu', bounds: [10, 10, 40, 138], locked: false, visible: true, nonprinting: false, pageIndex: 0, objectStyle: null, widthMm: 128, heightMm: 30, overflows: false }],
    links: [{ id: 51, name: 'photo.jpg', path: 'C:\\photo.jpg', status: 1, statusName: 'normal', pageItemId: 41, pageId: 21 }],
    fonts: [{ name: 'Marianne Regular', family: 'Marianne', style: 'Regular', status: 1, statusName: 'installed' }],
    images: [{ id: 61, type: 'Image', frameId: 62, pageId: 21, bounds: [50, 10, 100, 138], actualPpi: [300, 300], effectivePpi: [300, 300], link: { id: 51, name: 'photo.jpg', path: 'C:\\photo.jpg', status: 1 } }],
    oversetText: { count: 1, frames: [{ id: 71, type: 'TextFrame', name: 'Texte', pageId: 21, layerName: 'Contenu', bounds: [110, 10, 150, 138], locked: false, visible: true, nonprinting: false, storyId: 81 }] },
    designSystem: { layers: [{ id: 1, name: 'Contenu', index: 0, visible: true, locked: false, printable: true }], swatches: [], paragraphStyles: [], characterStyles: [], objectStyles: [] },
    totalItems: 1,
    inspectedItems: 1,
    truncated: false,
  };
  const { bridge, calls } = await fixture(t, async ({ language, source }) => {
    assert.equal(language, 'UXP');
    assert.doesNotThrow(() => new Function(`return async function generatedUxpScript() {\n${source}\n}`));
    assert.match(source, /auditNativePath/);
    assert.match(source, /async function auditNativePath|await auditNativePath/);
    assert.match(source, /candidate === "\[object Promise\]"/);
    assert.match(source, /DOCUMENT_CHANGED_DURING_READ/);
    const resultPath = jsonAssignment(source, '__resultPath');
    await fs.writeFile(resultPath, JSON.stringify({ ok: true, audit }));
    return null;
  });

  const info = await bridge.readDocument('get_document_info', { documentId: 12 });
  const pages = await bridge.readDocument('list_pages', { documentId: 12 });
  const links = await bridge.readDocument('get_links', { documentId: 12 });
  const fonts = await bridge.readDocument('get_fonts', { documentId: 12 });
  const overset = await bridge.readDocument('get_overset_text', { documentId: 12 });
  const images = await bridge.readDocument('get_images', { documentId: 12 });
  const layout = await bridge.readDocument('analyze_layout', { documentId: 12, maxItems: 200 });

  assert.deepEqual(Object.keys(info.document), ['id', 'name', 'path', 'pages', 'spreads', 'layers', 'masterSpreads', 'widthMm', 'heightMm', 'facingPages', 'modified']);
  assert.deepEqual(pages.pages[0], { id: 21, pageId: 21, index: 0, name: '1', bounds: [0, 0, 210, 148], appliedMaster: { id: 31, name: 'A-Gabarit' } });
  assert.deepEqual(links.links[0], { id: 51, name: 'photo.jpg', path: 'C:\\photo.jpg', status: 1, pageItemId: 41 });
  assert.deepEqual(fonts.fonts[0], { name: 'Marianne Regular', family: 'Marianne', style: 'Regular', status: 1 });
  assert.equal(overset.count, 1);
  assert.equal(images.images[0].effectivePpi[0], 300);
  assert.deepEqual(layout.images[0].link, { id: 51, name: 'photo.jpg' });
  assert.equal(layout.totalItems, 1);
  assert.equal(calls.length, 7);
  assert.equal(calls.some((call) => call.language === 'JAVASCRIPT'), false);
});

test('le préflight silencieux respecte son délai et nettoie son processus Adobe', async (t) => {
  const { bridge, calls } = await fixture(t, ({ language, source }) => {
    assert.equal(language, 'UXP');
    assert.doesNotThrow(() => new Function(`return async function generatedUxpScript() {\n${source}\n}`));
    assert.match(source, /app\.preflightProcesses\.add/);
    assert.match(source, /process\.remove\(\)/);
    return JSON.stringify({ ok: true, success: true, profile: 'Contrôle', aggregatedResults: ['audit.indd', 'Contrôle', []], processResults: 'completed', documentId: 12, revision: 4 });
  }, { timeoutMs: 500 });

  const result = await bridge.preflightDocument({ documentId: 12, expectedRevision: 4, timeoutSeconds: 2 });

  assert.equal(result.profile, 'Contrôle');
  assert.deepEqual(result.aggregatedResults[2], []);
  assert.equal(calls[0].args.includes('-CompletionTimeoutMs'), false);
  assert.equal(calls[0].options.timeout, 7000);
  assert.equal(calls.some((call) => call.language === 'JAVASCRIPT'), false);
});

test('un échec de restauration du préflight exige une inspection', async (t) => {
  let processRemoved = false;
  const { bridge } = await fixture(t, ({ language, source }) => {
    assert.equal(language, 'UXP');
    assert.match(source, /PREFLIGHT_PREFERENCES_RESTORE_FAILED/);
    assert.match(source, /requiresInspection: Boolean\(error\.requiresInspection\)/);

    const emptyCollection = { length: 0, item: () => undefined };
    const profile = { isValid: true, name: 'Contrôle' };
    let preflightOff = true;
    const preflightOptions = { preflightWorkingProfile: profile };
    Object.defineProperty(preflightOptions, 'preflightOff', {
      enumerable: true,
      get: () => preflightOff,
      set: (value) => {
        if (value === true && preflightOff === false) throw new Error('restauration refusée');
        preflightOff = value;
      },
    });
    const document = {
      id: 12,
      isValid: true,
      name: 'audit.indd',
      modified: false,
      saved: true,
      extractLabel: () => '4',
      documentPreferences: { properties: {} },
      preflightOptions,
      pages: emptyCollection,
      spreads: emptyCollection,
      masterSpreads: emptyCollection,
      stories: emptyCollection,
      links: emptyCollection,
      layers: emptyCollection,
      allPageItems: [],
      swatches: emptyCollection,
      colors: emptyCollection,
      gradients: emptyCollection,
      paragraphStyles: emptyCollection,
      characterStyles: emptyCollection,
      objectStyles: emptyCollection,
      tableStyles: emptyCollection,
      cellStyles: emptyCollection,
    };
    const app = {
      modalState: false,
      documents: { length: 1, item: () => document },
      preflightProfiles: emptyCollection,
      preflightProcesses: {
        add: () => ({
          waitForProcess: () => true,
          aggregatedResults: ['audit.indd', 'Contrôle', []],
          processResults: 'completed',
          remove: () => { processRemoved = true; },
        }),
      },
    };
    let scriptResult;
    const requireUxp = (name) => {
      if (name === 'indesign') return { app };
      if (name === 'uxp') return { script: { setResult: (value) => { scriptResult = value; } } };
      throw new Error(`Module UXP inattendu: ${name}`);
    };
    new Function('require', source)(requireUxp);
    return scriptResult;
  }, { timeoutMs: 500 });

  await assert.rejects(
    bridge.preflightDocument({ documentId: 12, expectedRevision: 4, timeoutSeconds: 2 }),
    (error) => error.code === 'PREFLIGHT_PREFERENCES_RESTORE_FAILED' && error.requiresInspection === true,
  );
  assert.equal(processRemoved, true);
});

test('silent_close_document ferme uniquement avec save=false sans sauvegarde ni autre mutation', async (t) => {
  const documents = [{ documentId: 42, name: 'preuve.indd', revision: 7, active: true }];
  const { bridge, calls } = await fixture(t, async ({ language, source }) => {
    if (isList(source)) return JSON.stringify({ ok: true, documents });
    if (isInspect(source)) return JSON.stringify({ ok: true, document: { ...documents[0], stateToken: TOKEN_A } });
    assert.equal(language, 'UXP');
    assert.doesNotThrow(() => new Function(`return async function generatedUxpScript() {\n${source}\n}`));
    assert.match(source, /target\.close\(indesign\.SaveOptions\.no\)/);
    assert.doesNotMatch(source, /saveACopy|\.save\(/);
    assert.match(source, /layoutWindow\.bringToFront\(\)/);
    assert.match(source, /SILENT_CLOSE_FOCUS_CHANGED_DOCUMENT/);
    assert.match(source, /captureStableDocumentProfile/);
    assert.match(source, /documentProfilesEqual\(previous, current\)/);
    assert.match(source, /assertFocusOnlyTransition\(initialProfile, focusedProfile/);
    assert.doesNotMatch(source, /SILENT_CLOSE_FOCUS_RESTORE_FAILED/);
    assert.match(source, /if \(app\.documents\.length > 0\)/);
    assert.match(source, /catch \(_\) \{\}/);
    assert.match(source, /assertDocumentProfile\(preservedBaseline, finalProfile/);
    const resultPath = jsonAssignment(source, '__resultPath');
    const operationId = jsonAssignment(source, '__operationId');
    await fs.writeFile(resultPath, JSON.stringify({ ok: true, success: true, closedDocumentId: 42, saved: false, operationId }));
    return null;
  });

  await assert.rejects(
    bridge.closeDocument({ documentId: 42, expectedRevision: 7, expectedStateToken: TOKEN_A, save: true }),
    (error) => error.code === 'SILENT_CLOSE_SAVE_FORBIDDEN',
  );
  const result = await bridge.closeDocument({ documentId: 42, expectedRevision: 7, expectedStateToken: TOKEN_A, save: false });

  assert.equal(result.closedDocumentId, 42);
  assert.equal(result.saved, false);
  assert.equal(calls.filter((call) => call.language === 'JAVASCRIPT').length, 0);
  assert.equal(calls.length, 3);
});

test('l’ouverture silencieuse valide l’INDD puis produit un état réconciliable sans plugin', async (t) => {
  let documentPath;
  const { bridge, calls, directory } = await fixture(t, async ({ language, source }) => {
    assert.equal(language, 'UXP');
    assert.doesNotThrow(() => new Function(`return async function generatedUxpScript() {\n${source}\n}`));
    assert.ok(source.includes(documentPath.replaceAll('\\', '/')));
    assert.match(source, /opened = await app\.open\(sourcePath, true\)/);
    assert.match(source, /layoutWindow\.bringToFront\(\)/);
    assert.match(source, /captureStableDocumentProfile/);
    assert.match(source, /const openProfileDeadline = Date\.now\(\) \+ 110000/);
    assert.match(source, /OPEN_INITIAL_PROFILE_UNSTABLE/);
    assert.match(source, /OPEN_PROFILE_UNSTABLE/);
    assert.match(source, /initialProfileDeadline = Math\.min\(openProfileDeadline, Date\.now\(\) \+ 10000\)/);
    assert.match(source, /captureStableDocumentProfile\("OPEN_PROFILE_UNSTABLE"[^\n]+openProfileDeadline\)/);
    assert.match(source, /assertFocusOnlyTransition\(documentsBefore, existingAfterOpen/);
    assert.doesNotMatch(source, /OPEN_FOCUS_RESTORE_FAILED/);
    assert.match(source, /if \(app\.documents\.length > 0\)/);
    assert.match(source, /UserInteractionLevels\.NEVER_INTERACT/);
    const resultPath = jsonAssignment(source, '__resultPath');
    const operationId = jsonAssignment(source, '__operationId');
    await fs.writeFile(resultPath, JSON.stringify({
      ok: true,
      success: true,
      documentId: 77,
      name: 'source.indd',
      revision: 0,
      stateToken: TOKEN_A,
      alreadyOpen: false,
      operationId,
    }));
    return null;
  }, { timeoutMs: 120_000 });
  documentPath = path.join(directory, 'source.indd');
  await fs.writeFile(documentPath, createInddFixture());

  const result = await bridge.openDocument(documentPath);

  assert.equal(result.documentId, 77);
  assert.equal(result.revision, 0);
  assert.equal(result.stateToken, TOKEN_A);
  assert.equal(result.alreadyOpen, false);
  assert.equal(result.artifactVerification.valid, true);
  assert.equal(result.artifactVerification.kind, 'indd');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.includes('-CompletionPath'), true);
  await assert.rejects(fs.access(path.join(directory, '.silent-runtime', '.mutation-lease.json')));
});

test('la création silencieuse contrôle le profil documentaire, convertit les points et enregistre sans écraser', async (t) => {
  let savePath;
  const { bridge, calls, directory } = await fixture(t, async ({ language, source }) => {
    assert.equal(language, 'UXP');
    assert.doesNotThrow(() => new Function(`return async function generatedUxpScript() {\n${source}\n}`));
    assert.match(source, /created = await Promise\.resolve\(app\.documents\.add\(\)\)/);
    assert.match(source, /UserInteractionLevels\.NEVER_INTERACT/);
    assert.match(source, /captureStableDocumentProfile\("CREATE_INITIAL_PROFILE_UNSTABLE"/);
    assert.match(source, /captureStableDocumentProfile\("CREATE_PROFILE_UNSTABLE"/);
    assert.match(source, /assertFocusOnlyTransition\(documentsBefore, [^\n]+"CREATE_EXISTING_DOCUMENT_CHANGED"/);
    assert.match(source, /CREATE_GEOMETRY_MISMATCH/);
    assert.match(source, /created\.save\(savePath\)/);
    assert.ok(source.includes(savePath.replaceAll('\\', '/')));
    const spec = JSON.parse(source.match(/const spec = (\{[^\n]+\});/)[1]);
    assert.ok(Math.abs(spec.width - 210) < 0.001 && Math.abs(spec.height - 297) < 0.001);
    assert.deepEqual(spec.margins, [25.4, 25.4, 25.4, 25.4]);
    assert.equal(spec.pageCount, 2);
    await fs.writeFile(savePath, createInddFixture());
    await fs.writeFile(jsonAssignment(source, '__resultPath'), JSON.stringify({
      ok: true, success: true, documentId: 91, name: 'nouveau.indd', revision: 0, stateToken: TOKEN_A, saved: true,
      operationId: jsonAssignment(source, '__operationId'),
    }));
    return null;
  });
  savePath = path.join(directory, 'nouveau.indd');

  const result = await bridge.createDocument({ width: 595.2756, height: 841.8898, units: 'pt', pageCount: 2, margins: [72, 72, 72, 72], bleed: [0, 0, 0, 0], path: savePath });

  assert.equal(result.documentId, 91);
  assert.equal(result.revision, 0);
  assert.equal(result.stateToken, TOKEN_A);
  assert.equal(result.executionChannel, 'silent');
  assert.equal(result.artifactVerification.kind, 'indd');
  assert.equal(calls.length, 1);
  await assert.rejects(fs.access(path.join(directory, '.silent-runtime', '.mutation-lease.json')));
  await assert.rejects(
    bridge.createDocument({ width: 210, height: 297, path: savePath }),
    (error) => error.code === 'TARGET_EXISTS',
  );
  assert.equal(calls.length, 1);
});

test('l’ouverture silencieuse refuse un faux INDD avant tout appel à InDesign', async (t) => {
  const { bridge, calls, directory } = await fixture(t, async () => {
    throw new Error('InDesign ne doit pas être appelé pour un artefact invalide.');
  });
  const documentPath = path.join(directory, 'faux.indd');
  await fs.writeFile(documentPath, Buffer.alloc(128, 0x41));
  await assert.rejects(
    bridge.openDocument(documentPath),
    (error) => error.code === 'ARTIFACT_INDD_SIGNATURE_MISMATCH',
  );
  assert.equal(calls.length, 0);
});

test('un dépassement de délai garde une opération réconciliable et ses sauvegardes', async (t) => {
  let trackedResultPath;
  const { bridge, directory, mutexes } = await fixture(t, async ({ language, source }) => {
    if (language === 'JAVASCRIPT') {
      const request = backupRequest(source);
      await fs.writeFile(request.backupPath, createInddFixture());
      return `OK|${request.backupId}|${request.documentId}|${request.revision}`;
    }
    if (isList(source)) return JSON.stringify({ ok: true, documents: [{ documentId: 5, name: 'test.indd', revision: 0 }] });
    if (isInspect(source)) return JSON.stringify({ ok: true, document: { documentId: 5, revision: 0, stateToken: TOKEN_A } });
    trackedResultPath = jsonAssignment(source, '__resultPath');
    return null;
  }, { timeoutMs: 60 });

  let timeoutError;
  await assert.rejects(
    bridge.executeDocument({ documentId: 5, expectedRevision: 0, expectedStateToken: TOKEN_A, reason: 'Tester le délai', code: 'await new Promise(() => {});' }),
    (error) => {
      timeoutError = error;
      return error.code === 'UXP_OUTCOME_UNKNOWN' && error.requiresInspection === true && error.safetyBackups.length === 1;
    },
  );
  const pending = await bridge.operationStatus(timeoutError.operationId);
  assert.equal(pending.status, 'pending');
  await fs.writeFile(trackedResultPath, JSON.stringify({ ok: true, result: 1, operationId: timeoutError.operationId }));
  const completed = await bridge.operationStatus(timeoutError.operationId);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.outcome.result, 1);
  assert.equal(completed.requiresInspection, false);
  assert.equal(completed.requiresReconciliation, false);
  const repeated = await bridge.operationStatus(timeoutError.operationId);
  assert.equal(repeated.status, 'completed');
  assert.equal(repeated.outcome.result, 1);
  await assert.rejects(fs.access(path.join(directory, '.silent-runtime', '.mutation-lease.json')));
});

test('operationStatus ne libère jamais un résultat qui exige encore une inspection', async (t) => {
  let trackedResultPath;
  const { bridge, directory } = await fixture(t, async ({ language, source }) => {
    if (language === 'JAVASCRIPT') {
      const request = backupRequest(source);
      await fs.writeFile(request.backupPath, createInddFixture());
      return `OK|${request.backupId}|${request.documentId}|${request.revision}`;
    }
    if (isList(source)) return JSON.stringify({ ok: true, documents: [{ documentId: 51, name: 'incertain.indd', revision: 1 }] });
    if (isInspect(source)) return JSON.stringify({ ok: true, document: { documentId: 51, revision: 1, stateToken: TOKEN_A } });
    trackedResultPath = jsonAssignment(source, '__resultPath');
    return null;
  }, { timeoutMs: 60 });
  let operationId;
  await assert.rejects(
    bridge.executeDocument({ documentId: 51, expectedRevision: 1, expectedStateToken: TOKEN_A, reason: 'Produire un résultat incertain', code: 'throw new Error("incertain");' }),
    (error) => { operationId = error.operationId; return error.code === 'UXP_OUTCOME_UNKNOWN'; },
  );
  await fs.writeFile(trackedResultPath, JSON.stringify({ ok: false, code: 'UXP_ERROR', operationId, requiresInspection: true }));
  const status = await bridge.operationStatus(operationId);
  assert.equal(status.status, 'completed-requires-reconciliation');
  assert.equal(status.requiresInspection, true);
  assert.equal(status.requiresReconciliation, true);
  await assert.rejects(
    bridge.reconcileUnknownOperation({ operationId, reason: 'Refuser un acquittement dans la session encore active' }),
    (error) => error.code === 'RECONCILIATION_NOT_CRASHED' && error.requiresInspection === true,
  );
  await fs.access(path.join(directory, '.silent-runtime', '.mutation-lease.json'));
});

test('une opération indéterminée reste réconciliable après redémarrage du serveur', async (t) => {
  let resultPath;
  const { bridge, directory, mutexes } = await fixture(t, async ({ language, source }) => {
    if (language === 'JAVASCRIPT') {
      const request = backupRequest(source);
      await fs.writeFile(request.backupPath, createInddFixture());
      return `OK|${request.backupId}|${request.documentId}|${request.revision}`;
    }
    if (isList(source)) return JSON.stringify({ ok: true, documents: [{ documentId: 6, name: 'test.indd', revision: 0 }] });
    if (isInspect(source)) return JSON.stringify({ ok: true, document: { documentId: 6, revision: 0, stateToken: TOKEN_A } });
    resultPath = jsonAssignment(source, '__resultPath');
    return null;
  }, { timeoutMs: 60 });
  let operationId;
  await assert.rejects(
    bridge.executeDocument({ documentId: 6, expectedRevision: 0, expectedStateToken: TOKEN_A, reason: 'Tester la reprise', code: 'await new Promise(() => {});' }),
    (error) => { operationId = error.operationId; return error.code === 'UXP_OUTCOME_UNKNOWN'; },
  );
  await bridge.close();

  const restarted = new InDesignSilentBridge({
    backupDirectory: directory,
    timeoutMs: 60,
    protect: async () => {},
    operationMutexFactory: mutexes.factory,
    run: async () => { throw new Error('aucune exécution attendue'); },
  });
  await restarted.initialize();
  t.after(() => restarted.close());
  assert.equal((await restarted.operationStatus(operationId)).status, 'pending');
  await fs.writeFile(resultPath, JSON.stringify({ ok: true, result: 77, operationId }));
  const recovered = await restarted.operationStatus(operationId);
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.outcome.result, 77);
});

test('un lease sans preuve ne se réconcilie qu’après un redémarrage complet d’InDesign', async (t) => {
  const documents = [{ documentId: 61, name: 'apres-crash.indd', revision: 3 }];
  const { bridge, directory, mutexes } = await fixture(t, async ({ language, source }) => {
    if (language === 'JAVASCRIPT') {
      const request = backupRequest(source);
      await fs.writeFile(request.backupPath, createInddFixture());
      return `OK|${request.backupId}|${request.documentId}|${request.revision}`;
    }
    if (isList(source)) return JSON.stringify({ ok: true, documents });
    if (isInspect(source)) return JSON.stringify({ ok: true, document: { ...documents[0], stateToken: TOKEN_A } });
    return null;
  }, { timeoutMs: 60 });
  let operationId;
  await assert.rejects(
    bridge.executeDocument({ documentId: 61, expectedRevision: 3, expectedStateToken: TOKEN_A, reason: 'Créer une issue inconnue', code: 'await new Promise(() => {});' }),
    (error) => { operationId = error.operationId; return error.code === 'UXP_OUTCOME_UNKNOWN'; },
  );
  await bridge.close();
  // Session coupée avant l'envoi du script : le verrou reste, aucune preuve privée.
  for (const entry of await fs.readdir(path.join(directory, '.silent-runtime'), { withFileTypes: true })) {
    if (entry.isDirectory() && /^[0-9a-f-]{36}$/.test(entry.name)) await fs.rm(path.join(directory, '.silent-runtime', entry.name), { recursive: true, force: true });
  }
  let hostStartedAt = HOST_AFTER.startedAt;

  const restartRun = async (_file, args) => {
    const scriptPath = args[args.indexOf('-ScriptPath') + 1];
    const language = args[args.indexOf('-Language') + 1];
    const source = await fs.readFile(scriptPath, 'utf8');
    let result;
    if (language === 'JAVASCRIPT') {
      const request = backupRequest(source);
      await fs.writeFile(request.backupPath, createInddFixture());
      result = `OK|${request.backupId}|${request.documentId}|${request.revision}`;
    } else if (source.includes('capabilities: { asyncCompletionFile:')) {
      result = JSON.stringify({ ok: true, modalState: false });
    } else if (isList(source)) {
      result = JSON.stringify({ ok: true, documents });
    } else if (isInspect(source)) {
      result = JSON.stringify({ ok: true, document: { ...documents[0], stateToken: TOKEN_A } });
    } else {
      throw new Error('Aucune nouvelle mutation ne doit être lancée pendant la réconciliation.');
    }
    return { stdout: JSON.stringify({ ok: true, result }) };
  };
  const restarted = new InDesignSilentBridge({
    backupDirectory: directory,
    timeoutMs: 500,
    protect: async () => {},
    run: restartRun,
    operationMutexFactory: mutexes.factory,
    guardedRun: ({ scriptPath, language, completionPath, completionTimeoutMs }) => {
      const args = ['-ScriptPath', scriptPath, '-Language', language];
      if (completionPath) args.push('-CompletionPath', completionPath, '-CompletionTimeoutMs', String(completionTimeoutMs));
      return restartRun('mutex-helper', args);
    },
    hostProcessSnapshot: async () => [{ processId: HOST_AFTER.processId, startedAt: hostStartedAt }],
  });
  await restarted.initialize();
  t.after(() => restarted.close());
  await assert.rejects(
    restarted.reconcileUnknownOperation({ operationId, reason: 'Refuser sans preuve ni redémarrage InDesign' }),
    (error) => error.code === 'RECONCILIATION_EVIDENCE_MISSING',
  );
  hostStartedAt = new Date(Date.now() + 60_000).toISOString();
  const reconciled = await restarted.reconcileUnknownOperation({ operationId, reason: 'Acquitter après redémarrage complet InDesign' });
  assert.equal(reconciled.status, 'reconciled-unknown');
  assert.equal(reconciled.requiresInspection, true);
  assert.equal(reconciled.requiresReconciliation, false);
  await assert.rejects(fs.access(path.join(directory, '.silent-runtime', '.mutation-lease.json')));
});

test('un lease silencieux hérité exige une réconciliation stable et de nouvelles sauvegardes', async (t) => {
  const documents = [{ documentId: 61, name: 'apres-crash.indd', revision: 3 }];
  const { bridge, directory, mutexes } = await fixture(t, async ({ language, source }) => {
    if (language === 'JAVASCRIPT') {
      const request = backupRequest(source);
      await fs.writeFile(request.backupPath, createInddFixture());
      return `OK|${request.backupId}|${request.documentId}|${request.revision}`;
    }
    if (isList(source)) return JSON.stringify({ ok: true, documents });
    if (isInspect(source)) return JSON.stringify({ ok: true, document: { ...documents[0], stateToken: TOKEN_A } });
    return null;
  }, { timeoutMs: 60 });
  let operationId;
  await assert.rejects(
    bridge.executeDocument({ documentId: 61, expectedRevision: 3, expectedStateToken: TOKEN_A, reason: 'Créer une issue inconnue', code: 'await new Promise(() => {});' }),
    (error) => { operationId = error.operationId; return error.code === 'UXP_OUTCOME_UNKNOWN'; },
  );
  await bridge.close();

  const restartRun = async (_file, args) => {
    const scriptPath = args[args.indexOf('-ScriptPath') + 1];
    const language = args[args.indexOf('-Language') + 1];
    const source = await fs.readFile(scriptPath, 'utf8');
    let result;
    if (language === 'JAVASCRIPT') {
      const request = backupRequest(source);
      await fs.writeFile(request.backupPath, createInddFixture());
      result = `OK|${request.backupId}|${request.documentId}|${request.revision}`;
    } else if (source.includes('capabilities: { asyncCompletionFile:')) {
      result = JSON.stringify({ ok: true, modalState: false });
    } else if (isList(source)) {
      result = JSON.stringify({ ok: true, documents });
    } else if (isInspect(source)) {
      result = JSON.stringify({ ok: true, document: { ...documents[0], stateToken: TOKEN_A } });
    } else {
      throw new Error('Aucune nouvelle mutation ne doit être lancée pendant la réconciliation.');
    }
    return { stdout: JSON.stringify({ ok: true, result }) };
  };
  const restarted = new InDesignSilentBridge({
    backupDirectory: directory,
    timeoutMs: 500,
    protect: async () => {},
    run: restartRun,
    operationMutexFactory: mutexes.factory,
    guardedRun: ({ scriptPath, language, completionPath, completionTimeoutMs }) => {
      const args = ['-ScriptPath', scriptPath, '-Language', language];
      if (completionPath) args.push('-CompletionPath', completionPath, '-CompletionTimeoutMs', String(completionTimeoutMs));
      return restartRun('mutex-helper', args);
    },
    hostProcessSnapshot: async () => [HOST_AFTER],
  });
  await restarted.initialize();
  t.after(() => restarted.close());
  const reconciled = await restarted.reconcileUnknownOperation({ operationId, reason: 'Confirmer manuellement la reprise après arrêt du serveur' });
  assert.equal(reconciled.status, 'reconciled-unknown');
  assert.equal(reconciled.requiresInspection, true);
  assert.equal(reconciled.requiresReconciliation, false);
  assert.ok(!Number.isNaN(Date.parse(reconciled.releaseConfirmedAt)));
  assert.equal(reconciled.snapshots.length, 1);
  assert.equal(reconciled.snapshots[0].stateToken, TOKEN_A);
  assert.equal(reconciled.safetyBackups.length, 1);
  assert.equal((await fs.stat(reconciled.safetyBackups[0].metadataPath)).isFile(), true);
  await assert.rejects(fs.access(path.join(directory, '.silent-runtime', '.mutation-lease.json')));
  const reconciliationFiles = (await fs.readdir(path.dirname(path.join(directory, '.silent-runtime', 'x')) , { recursive: true })).filter((entry) => String(entry).endsWith('.reconciliation.json'));
  assert.equal(reconciliationFiles.length, 1);
  const reconciledStatus = await restarted.operationStatus(operationId);
  assert.equal(reconciledStatus.status, 'reconciled-unknown');
  assert.equal(reconciledStatus.requiresInspection, true);
  assert.equal(reconciledStatus.requiresReconciliation, false);
  assert.equal(reconciledStatus.reconciledAt, reconciled.reconciledAt);
  assert.equal(reconciledStatus.releaseConfirmedAt, reconciled.releaseConfirmedAt);
  await restarted.close();
  const recordsAfterClose = (await fs.readdir(path.join(directory, '.silent-runtime'), { recursive: true })).filter((entry) => String(entry).endsWith('.reconciliation.json'));
  assert.equal(recordsAfterClose.length, 1, 'la preuve de réconciliation doit survivre à l’arrêt du serveur');

  const statusReader = new InDesignSilentBridge({
    backupDirectory: directory,
    protect: async () => {},
    run: async () => { throw new Error('aucune exécution InDesign attendue pour relire le reçu'); },
  });
  await statusReader.initialize();
  const durableStatus = await statusReader.operationStatus(operationId);
  assert.equal(durableStatus.status, 'reconciled-unknown');
  assert.equal(durableStatus.requiresReconciliation, false);
  assert.equal(durableStatus.releaseConfirmedAt, reconciled.releaseConfirmedAt);
  await statusReader.close();
});

test('une UXP indéterminée interdit la réconciliation tant que le même processus InDesign vit', async (t) => {
  const documents = [{ documentId: 63, name: 'toujours-actif.indd', revision: 1 }];
  const { bridge, directory, mutexes } = await fixture(t, async ({ language, source }) => {
    if (language === 'JAVASCRIPT') {
      const request = backupRequest(source);
      await fs.writeFile(request.backupPath, createInddFixture());
      return `OK|${request.backupId}|${request.documentId}|${request.revision}`;
    }
    if (isList(source)) return JSON.stringify({ ok: true, documents });
    if (isInspect(source)) return JSON.stringify({ ok: true, document: { ...documents[0], stateToken: TOKEN_A } });
    return null;
  }, { timeoutMs: 60 });
  let operationId;
  await assert.rejects(
    bridge.executeDocument({ documentId: 63, expectedRevision: 1, expectedStateToken: TOKEN_A, code: 'await new Promise(() => {});' }),
    (error) => { operationId = error.operationId; return error.code === 'UXP_OUTCOME_UNKNOWN'; },
  );
  const leasePath = path.join(directory, '.silent-runtime', '.mutation-lease.json');
  const originalLease = JSON.parse(await fs.readFile(leasePath, 'utf8'));
  await bridge.close();

  const restarted = new InDesignSilentBridge({
    backupDirectory: directory,
    timeoutMs: 100,
    protect: async () => {},
    operationMutexFactory: mutexes.factory,
    guardedRun: async () => { throw new Error('aucune inspection ne doit démarrer avant le redémarrage InDesign'); },
    run: async () => { throw new Error('launcher normal interdit'); },
    hostProcessSnapshot: async () => [HOST_BEFORE],
  });
  await restarted.initialize();
  t.after(() => restarted.close());
  await assert.rejects(
    restarted.reconcileUnknownOperation({ operationId, reason: 'Tester le refus avant un vrai redémarrage InDesign' }),
    (error) => error.code === 'RECONCILIATION_RESTART_REQUIRED' && error.requiresInspection === true,
  );
  const recoveredLease = JSON.parse(await fs.readFile(leasePath, 'utf8'));
  assert.equal(recoveredLease.guardProcessId, originalLease.guardProcessId, 'un watcher ne doit jamais remplacer le PID du détenteur original');
  assert.notEqual(recoveredLease.recoveryWatcherProcessId, originalLease.guardProcessId);
  const releaseFiles = (await fs.readdir(path.join(directory, '.silent-runtime', '.mutex-operations'))).filter((name) => name.endsWith('.release.json'));
  assert.equal(releaseFiles.length, 0, 'aucun acquittement ne doit libérer le mutex tant que l’ancien InDesign vit');
});

test('une réservation durable empêche deux tâches de lancer des watchers de réconciliation', async (t) => {
  const documents = [{ documentId: 64, name: 'claim.indd', revision: 0 }];
  const { bridge, directory, mutexes } = await fixture(t, async ({ language, source }) => {
    if (language === 'JAVASCRIPT') {
      const request = backupRequest(source);
      await fs.writeFile(request.backupPath, createInddFixture());
      return `OK|${request.backupId}|${request.documentId}|${request.revision}`;
    }
    if (isList(source)) return JSON.stringify({ ok: true, documents });
    if (isInspect(source)) return JSON.stringify({ ok: true, document: { ...documents[0], stateToken: TOKEN_A } });
    return null;
  }, { timeoutMs: 60 });
  let operationId;
  await assert.rejects(
    bridge.executeDocument({ documentId: 64, expectedRevision: 0, expectedStateToken: TOKEN_A, code: 'await new Promise(() => {});' }),
    (error) => { operationId = error.operationId; return error.code === 'UXP_OUTCOME_UNKNOWN'; },
  );
  await bridge.close();
  const callsBefore = mutexes.calls.length;
  const claimPath = path.join(directory, '.silent-runtime', '.mutex-operations', `${operationId}.reconciliation.claim.json`);
  await fs.writeFile(claimPath, JSON.stringify({ schemaVersion: 1, operationId, sessionId: crypto.randomUUID(), processId: process.pid }));
  const restarted = new InDesignSilentBridge({
    backupDirectory: directory,
    protect: async () => {},
    operationMutexFactory: mutexes.factory,
    hostProcessSnapshot: async () => [HOST_AFTER],
  });
  await restarted.initialize();
  t.after(() => restarted.close());
  await assert.rejects(
    restarted.reconcileUnknownOperation({ operationId, reason: 'Refuser une seconde tâche de réconciliation simultanée' }),
    (error) => error.code === 'RECONCILIATION_ALREADY_ACTIVE_CROSS_PROCESS',
  );
  assert.equal(mutexes.calls.length, callsBefore, 'aucun watcher supplémentaire ne doit être créé');
  await fs.rm(claimPath, { force: true });
});

test('un lease externe peut être réconcilié sans preuve UXP locale mais jamais sans sauvegardes', async (t) => {
  const operationId = '42345678-1234-4123-8123-123456789abc';
  const documents = [{ documentId: 62, name: 'plugin.indd', revision: 9 }];
  const { bridge, directory, mutexes } = await fixture(t, async ({ language, source }) => {
    if (language === 'JAVASCRIPT') {
      const request = backupRequest(source);
      await fs.writeFile(request.backupPath, createInddFixture());
      return `OK|${request.backupId}|${request.documentId}|${request.revision}`;
    }
    if (source.includes('capabilities: { asyncCompletionFile:')) return JSON.stringify({ ok: true, modalState: false });
    if (isList(source)) return JSON.stringify({ ok: true, documents });
    if (isInspect(source)) return JSON.stringify({ ok: true, document: { ...documents[0], stateToken: TOKEN_A } });
    throw new Error('Aucune mutation UXP locale ne doit être lancée.');
  });
  await bridge.acquireExternalMutationLease(operationId);
  const lease = JSON.parse(await fs.readFile(path.join(directory, '.silent-runtime', '.mutation-lease.json'), 'utf8'));
  assert.equal(lease.kind, 'external');
  const pendingStatus = await bridge.operationStatus(operationId);
  assert.equal(pendingStatus.status, 'pending');
  assert.equal(pendingStatus.leaseKind, 'external');
  assert.equal(pendingStatus.requiresReconciliation, true);
  const reconciled = await bridge.reconcileUnknownOperation({ operationId, reason: 'Réconcilier la commande structurée sans réponse du plugin' });
  assert.equal(reconciled.status, 'reconciled-unknown');
  assert.equal(reconciled.safetyBackups.length, 1);
  assert.equal(reconciled.safetyBackups[0].stateToken, TOKEN_A);
  await assert.rejects(fs.access(path.join(directory, '.silent-runtime', '.mutation-lease.json')));
  const reconciledStatus = await bridge.operationStatus(operationId);
  assert.equal(reconciledStatus.status, 'reconciled-unknown');
  assert.equal(reconciledStatus.requiresInspection, true);
  assert.equal(reconciledStatus.requiresReconciliation, false);
});

test('les reçus préparés ne deviennent terminaux qu’après disparition prouvée du lease et de la garde', async (t) => {
  const { bridge } = await fixture(t, async () => { throw new Error('aucune exécution InDesign attendue'); });
  const legacyOperationId = '43345678-1234-4123-8123-123456789abc';
  const preparedOperationId = '44345678-1234-4123-8123-123456789abc';
  const activePreparedOperationId = '45345678-1234-4123-8123-123456789abc';
  const reconciledPreparedOperationId = '46345678-1234-4123-8123-123456789abc';
  const baseRecord = {
    schemaVersion: 1,
    leaseKind: 'silent',
    reconciledAt: new Date().toISOString(),
    status: 'reconciled-unknown',
    reasonSha256: 'a'.repeat(64),
    snapshots: [],
    backupIds: [],
    quarantinedScript: null,
  };
  await fs.writeFile(
    path.join(bridge.runtimeDirectory, `${legacyOperationId}.${crypto.randomUUID()}.reconciliation.json`),
    JSON.stringify({ ...baseRecord, operationId: legacyOperationId }),
  );
  await fs.writeFile(
    path.join(bridge.runtimeDirectory, `${preparedOperationId}.${crypto.randomUUID()}.reconciliation.json`),
    JSON.stringify({ ...baseRecord, operationId: preparedOperationId, releaseState: 'prepared', requiresInspection: true }),
  );
  const activeReceiptPath = path.join(bridge.runtimeDirectory, `${activePreparedOperationId}.${crypto.randomUUID()}.reconciliation.json`);
  await fs.writeFile(
    activeReceiptPath,
    JSON.stringify({ ...baseRecord, operationId: activePreparedOperationId, releaseState: 'prepared', requiresInspection: true }),
  );
  await fs.writeFile(
    path.join(bridge.mutexOperationDirectory, `${activePreparedOperationId}.jsonl`),
    JSON.stringify({ schemaVersion: 1, operationId: activePreparedOperationId, status: 'guarded' }),
  );
  const reconciledReceiptPath = path.join(bridge.runtimeDirectory, `${reconciledPreparedOperationId}.${crypto.randomUUID()}.reconciliation.json`);
  await fs.writeFile(
    reconciledReceiptPath,
    JSON.stringify({ ...baseRecord, operationId: reconciledPreparedOperationId, releaseState: 'prepared', requiresInspection: true }),
  );

  const legacyStatus = await bridge.operationStatus(legacyOperationId);
  assert.equal(legacyStatus.status, 'reconciled-unknown');
  assert.equal(legacyStatus.requiresInspection, true);
  assert.equal(legacyStatus.requiresReconciliation, false);

  const preparedStatus = await bridge.operationStatus(preparedOperationId);
  assert.equal(preparedStatus.status, 'reconciled-unknown');
  assert.equal(preparedStatus.requiresInspection, true);
  assert.equal(preparedStatus.requiresReconciliation, false);
  assert.match(preparedStatus.releaseConfirmedAt, /^\d{4}-\d{2}-\d{2}T/);

  const activePreparedStatus = await bridge.operationStatus(activePreparedOperationId);
  assert.equal(activePreparedStatus.status, 'reconciliation-release-pending');
  assert.equal(activePreparedStatus.requiresInspection, true);
  assert.equal(activePreparedStatus.requiresReconciliation, true);
  assert.equal(JSON.parse(await fs.readFile(activeReceiptPath, 'utf8')).releaseState, 'prepared');

  const repaired = await bridge.reconcileUnknownOperation({
    operationId: reconciledPreparedOperationId,
    reason: 'Réparer le reçu préparé après la libération déjà confirmée du mutex',
  });
  assert.equal(repaired.status, 'reconciled-unknown');
  assert.equal(repaired.requiresReconciliation, false);
  assert.match(repaired.releaseConfirmedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(JSON.parse(await fs.readFile(reconciledReceiptPath, 'utf8')).releaseState, 'confirmed');
});

test('la réconciliation plugin exécute toutes ses inspections sous le mutex déjà détenu', async (t) => {
  const operationId = '52345678-1234-4123-8123-123456789abc';
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-private-reconciliation-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let normalLauncherCalls = 0;
  const bridge = new InDesignSilentBridge({
    backupDirectory: directory,
    timeoutMs: 500,
    protect: async () => {},
    run: async () => {
      normalLauncherCalls += 1;
      throw new Error('Le launcher normal ne doit pas attendre le mutex détenu.');
    },
  });
  await bridge.initialize();
  t.after(() => bridge.close());
  await bridge.acquireExternalMutationLease(operationId);
  const documents = [{ documentId: 63, name: 'plugin-verrouille.indd', revision: 4 }];
  const privateCalls = [];
  const runScript = async ({ scriptPath, language }) => {
    const source = await fs.readFile(scriptPath, 'utf8');
    privateCalls.push({ language, source });
    let result;
    if (language === 'JAVASCRIPT') {
      const request = backupRequest(source);
      await fs.writeFile(request.backupPath, createInddFixture());
      result = `OK|${request.backupId}|${request.documentId}|${request.revision}`;
    } else if (source.includes('capabilities: { asyncCompletionFile:')) {
      result = JSON.stringify({ ok: true, modalState: false });
    } else if (isList(source)) {
      result = JSON.stringify({ ok: true, documents });
    } else if (isInspect(source)) {
      result = JSON.stringify({ ok: true, document: { ...documents[0], stateToken: TOKEN_A } });
    } else {
      throw new Error('Sous-commande privée inattendue.');
    }
    return { stdout: JSON.stringify({ ok: true, result }) };
  };

  const reconciled = await bridge.reconcileUnknownOperation(
    { operationId, reason: 'Réconcilier sans relâcher le mutex détenu par le plugin' },
    { runScript },
  );

  assert.equal(reconciled.status, 'reconciled-unknown');
  assert.equal(reconciled.safetyBackups.length, 1);
  assert.equal(normalLauncherCalls, 0);
  assert.ok(privateCalls.length >= 8);
  assert.ok(privateCalls.some((call) => call.language === 'JAVASCRIPT'));
  await assert.rejects(fs.access(path.join(directory, '.silent-runtime', '.mutation-lease.json')));
});

test('un lease externe avec une session invalide est refusé', async (t) => {
  const { bridge, directory } = await fixture(t, async () => {
    throw new Error('aucune commande InDesign attendue');
  });
  const leasePath = path.join(directory, '.silent-runtime', '.mutation-lease.json');
  await fs.writeFile(leasePath, JSON.stringify({
    schemaVersion: 1,
    kind: 'external',
    operationId: '72345678-1234-4123-8123-123456789abc',
    sessionId: 'session-invalide',
    acquiredAt: new Date().toISOString(),
  }));
  await assert.rejects(
    bridge.acquireExternalMutationLease('82345678-1234-4123-8123-123456789abc'),
    (error) => error.code === 'MUTATION_LEASE_INVALID' && error.requiresInspection === true,
  );
});

test('le rafraîchissement des copies restaurées retire uniquement le marqueur d’une copie fermée', async (t) => {
  let openPath;
  const { bridge, directory } = await fixture(t, async ({ source }) => {
    assert.match(source, /const openPaths = \[\]/);
    assert.match(source, /await auditNativePath\(doc\)/);
    const resultPath = jsonAssignment(source, '__resultPath');
    await fs.writeFile(resultPath, JSON.stringify({ ok: true, pathsReadable: true, openPaths: [openPath] }));
    return null;
  });
  const restoredDirectory = path.join(directory, 'restored');
  await fs.mkdir(restoredDirectory);
  const openId = '52345678-1234-4123-8123-123456789abc';
  const closedId = '62345678-1234-4123-8123-123456789abc';
  const openFile = path.join(restoredDirectory, `restore-${openId}.indd`);
  const closedFile = path.join(restoredDirectory, `restore-${closedId}.indd`);
  const openMarker = openFile.replace(/\.indd$/, '.open.json');
  const closedMarker = closedFile.replace(/\.indd$/, '.open.json');
  openPath = openFile;
  await Promise.all([
    fs.writeFile(openFile, createInddFixture()),
    fs.writeFile(closedFile, createInddFixture()),
    fs.writeFile(openMarker, JSON.stringify({ schemaVersion: 1, workingFile: path.basename(openFile) })),
    fs.writeFile(closedMarker, JSON.stringify({ schemaVersion: 1, workingFile: path.basename(closedFile) })),
  ]);
  const refreshed = await bridge.refreshRestoredMarkers();
  assert.deepEqual(refreshed, { inspected: 2, removed: 1, keptOpen: 1, skippedUnreadable: 0 });
  await fs.access(openMarker);
  await assert.rejects(fs.access(closedMarker));
  await fs.access(openFile);
  await fs.access(closedFile);
});

test('le rafraîchissement ne retire aucun marqueur si un chemin InDesign est illisible', async (t) => {
  const { bridge, directory } = await fixture(t, async ({ source }) => {
    const resultPath = jsonAssignment(source, '__resultPath');
    await fs.writeFile(resultPath, JSON.stringify({ ok: true, pathsReadable: false, openPaths: [] }));
    return null;
  });
  const restoredDirectory = path.join(directory, 'restored');
  await fs.mkdir(restoredDirectory);
  const id = '72345678-1234-4123-8123-123456789abc';
  const workingFile = `restore-${id}.indd`;
  const markerPath = path.join(restoredDirectory, `restore-${id}.open.json`);
  await fs.writeFile(markerPath, JSON.stringify({ schemaVersion: 1, workingFile }));
  const refreshed = await bridge.refreshRestoredMarkers();
  assert.deepEqual(refreshed, { inspected: 1, removed: 0, keptOpen: 0, skippedUnreadable: 1 });
  await fs.access(markerPath);
});

test('un second processus ne peut pas dépasser une mutation silencieuse indéterminée', async (t) => {
  const { bridge, directory, mutexes } = await fixture(t, async ({ language, source }) => {
    if (language === 'JAVASCRIPT') {
      const request = backupRequest(source);
      await fs.writeFile(request.backupPath, createInddFixture());
      return `OK|${request.backupId}|${request.documentId}|${request.revision}`;
    }
    if (isList(source)) return JSON.stringify({ ok: true, documents: [{ documentId: 8, name: 'test.indd', revision: 0 }] });
    if (isInspect(source)) return JSON.stringify({ ok: true, document: { documentId: 8, revision: 0, stateToken: TOKEN_A } });
    return null;
  }, { timeoutMs: 60 });
  let activeOperationId;
  await assert.rejects(
    bridge.executeDocument({ documentId: 8, expectedRevision: 0, expectedStateToken: TOKEN_A, reason: 'Tester le verrou global', code: 'await new Promise(() => {});' }),
    (error) => { activeOperationId = error.operationId; return error.code === 'UXP_OUTCOME_UNKNOWN'; },
  );

  const secondary = new InDesignSilentBridge({
    backupDirectory: directory,
    timeoutMs: 60,
    protect: async () => {},
    operationMutexFactory: mutexes.factory,
    run: async (_file, args) => {
      const scriptPath = args[args.indexOf('-ScriptPath') + 1];
      const language = args[args.indexOf('-Language') + 1];
      const source = await fs.readFile(scriptPath, 'utf8');
      if (language === 'JAVASCRIPT') {
        const request = backupRequest(source);
        await fs.writeFile(request.backupPath, createInddFixture());
        return { stdout: JSON.stringify({ ok: true, result: `OK|${request.backupId}|${request.documentId}|${request.revision}` }) };
      }
      if (isList(source)) return { stdout: JSON.stringify({ ok: true, result: JSON.stringify({ ok: true, documents: [{ documentId: 8, name: 'test.indd', revision: 0 }] }) }) };
      if (isInspect(source)) return { stdout: JSON.stringify({ ok: true, result: JSON.stringify({ ok: true, document: { documentId: 8, revision: 0, stateToken: TOKEN_A } }) }) };
      throw new Error('La seconde mutation ne doit jamais être lancée dans InDesign.');
    },
  });
  await secondary.initialize();
  t.after(() => secondary.close());
  await assert.rejects(
    secondary.executeDocument({ documentId: 8, expectedRevision: 0, expectedStateToken: TOKEN_A, reason: 'Tenter une seconde mutation', code: 'return 2;' }),
    (error) => error.code === 'MUTATION_IN_PROGRESS' && error.operationId === activeOperationId && error.requiresInspection === true,
  );
});

test('Windows conserve réellement le mutex silencieux après timeout et le reprend au redémarrage', {
  skip: process.platform !== 'win32',
  timeout: 30_000,
}, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-silent-real-mutex-'));
  const documentPath = path.join(directory, 'source.indd');
  await fs.writeFile(documentPath, createInddFixture());
  const mutexName = `Local\\NexusInDesignAutomation.Test.${crypto.randomUUID()}`;
  const mutexCalls = [];
  const mutexFactory = (options) => {
    mutexCalls.push(options);
    return acquireWindowsNamedMutexGuard({ ...options, timeoutMs: 3_000, mutexName, allowTestMutex: true });
  };
  let bridge;
  let restarted;
  let operationId;
  t.after(async () => {
    await restarted?.close().catch(() => {});
    await bridge?.close().catch(() => {});
    const leasePath = path.join(directory, '.silent-runtime', '.mutation-lease.json');
    const lease = await fs.readFile(leasePath, 'utf8').then(JSON.parse).catch(() => null);
    if (lease?.operationId && lease?.releaseNonce) {
      const markerPath = path.join(
        directory,
        '.silent-runtime',
        '.mutex-operations',
        `${lease.operationId}.${lease.releaseNonce}.release.json`,
      );
      await fs.writeFile(markerPath, JSON.stringify({
        schemaVersion: 1,
        operationId: lease.operationId,
        releaseNonce: lease.releaseNonce,
        status: 'acknowledged',
      })).catch(() => {});
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const probe = await probeWindowsInDesignMutex(50, mutexName).catch(() => ({ acquired: false }));
        if (probe.acquired) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    await fs.rm(directory, { recursive: true, force: true });
  });

  bridge = new InDesignSilentBridge({
    backupDirectory: directory,
    timeoutMs: 100,
    protect: async () => {},
    operationMutexFactory: mutexFactory,
    run: async () => { throw new Error('Le launcher normal ne doit pas exécuter la mutation protégée.'); },
    guardedRun: async () => {
      const error = new Error('Timeout simulé côté appelant.');
      error.code = 'ETIMEDOUT';
      error.requiresInspection = true;
      throw error;
    },
  });
  await bridge.initialize();
  await assert.rejects(
    bridge.openDocument(documentPath),
    (error) => {
      operationId = error.operationId;
      return error.code === 'UXP_OUTCOME_UNKNOWN' && error.requiresInspection === true;
    },
  );

  const leasePath = path.join(directory, '.silent-runtime', '.mutation-lease.json');
  const firstLease = JSON.parse(await fs.readFile(leasePath, 'utf8'));
  assert.equal(firstLease.operationId, operationId);
  assert.match(firstLease.releaseNonce, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(Number.isInteger(firstLease.guardProcessId));
  const operationPath = path.join(directory, '.silent-runtime', '.mutex-operations', `${operationId}.jsonl`);
  const operationRecord = JSON.parse(await fs.readFile(operationPath, 'utf8'));
  await fs.writeFile(operationPath, JSON.stringify({
    ...operationRecord,
    status: 'uxp-dispatched',
    uxpDispatchedAt: new Date().toISOString(),
    hostProcessesAtDispatch: [HOST_BEFORE],
  }));
  assert.deepEqual(await probeWindowsInDesignMutex(250, mutexName), { acquired: false, abandoned: false });

  await bridge.close();
  let normalLauncherCalls = 0;
  let guardedReconciliationCalls = 0;
  restarted = new InDesignSilentBridge({
    backupDirectory: directory,
    timeoutMs: 500,
    protect: async () => {},
    operationMutexFactory: mutexFactory,
    run: async () => {
      normalLauncherCalls += 1;
      throw new Error('La réconciliation silencieuse ne doit jamais reprendre le mutex dans le launcher normal.');
    },
    guardedRun: async ({ scriptPath }) => {
      guardedReconciliationCalls += 1;
      const source = await fs.readFile(scriptPath, 'utf8');
      let result;
      if (source.includes('capabilities: { asyncCompletionFile:')) {
        result = JSON.stringify({ ok: true, modalState: false });
      } else if (isList(source)) {
        result = JSON.stringify({ ok: true, documents: [] });
      } else {
        throw new Error('Sous-commande inattendue pendant la réconciliation silencieuse.');
      }
      return { stdout: JSON.stringify({ ok: true, result }) };
    },
    hostProcessSnapshot: async () => [HOST_AFTER],
  });
  await restarted.initialize();
  assert.equal(mutexCalls.some((call) => call.recovery === true), false, 'initialize ne doit jamais créer de watcher partagé');
  assert.deepEqual(await probeWindowsInDesignMutex(250, mutexName), { acquired: false, abandoned: false });

  const reconciled = await restarted.reconcileUnknownOperation({
    operationId,
    reason: 'Vérifier la reprise durable du mutex silencieux après redémarrage',
  });
  assert.ok(mutexCalls.some((call) => call.expectedGuardProcessId === firstLease.guardProcessId && call.recovery === true));
  assert.equal(reconciled.status, 'reconciled-unknown');
  assert.equal(normalLauncherCalls, 0);
  assert.ok(guardedReconciliationCalls >= 4);
  assert.deepEqual(await probeWindowsInDesignMutex(1_000, mutexName), { acquired: true, abandoned: false });
  await assert.rejects(fs.access(leasePath));
});

test('une copie silencieuse est restaurable sans mémoire interne du plugin', async (t) => {
  const backupId = '12345678-1234-4123-8123-123456789abc';
  const documents = [{ documentId: 7, name: 'courant.indd', revision: 4, active: true }];
  const { bridge, directory, calls } = await fixture(t, async ({ language, source }) => {
    if (language === 'JAVASCRIPT') {
      const request = backupRequest(source);
      await fs.writeFile(request.backupPath, createInddFixture());
      return `OK|${request.backupId}|${request.documentId}|${request.revision}`;
    }
    if (isList(source)) return JSON.stringify({ ok: true, documents });
    if (isInspect(source)) return JSON.stringify({ ok: true, document: { ...documents[0], stateToken: TOKEN_A } });
    const resultPath = jsonAssignment(source, '__resultPath');
    const operationId = jsonAssignment(source, '__operationId');
    await fs.writeFile(resultPath, JSON.stringify({ ok: true, restoredDocumentId: 70, originalDocumentId: 7, revision: 5, stateToken: TOKEN_B, operationId }));
    return null;
  });
  await writeBackupWithMetadata(directory, {
    backupId,
    documentId: 7,
    revision: 2,
    stateToken: TOKEN_B,
    content: createInddFixture(),
  });

  const result = await bridge.restoreBackup({
    documentId: 7,
    expectedRevision: 4,
    expectedStateToken: TOKEN_A,
    backupId,
    reason: 'Restaurer le document',
  });

  const restoreSource = calls.findLast((call) => call.language === 'UXP').source;
  assert.ok(restoreSource.indexOf('mutationStarted = true;') < restoreSource.indexOf('opened = await app.open'), 'la restauration doit être considérée mutante avant app.open');
  assert.match(restoreSource, /const expectedDocuments = \[/);
  assert.match(restoreSource, /DOCUMENT_STATE_CONFLICT/);

  assert.equal(result.restoredDocumentId, 70);
  assert.equal(result.restoredFromBackupId, backupId);
  assert.equal(result.restoredSourceRevision, 2);
  assert.equal(result.restoredSourceStateToken, TOKEN_B);
  assert.equal(result.recoveryBackups.length, 1);
  assert.match(result.restoredWorkingPath, /[\\/]restored[\\/]restore-[a-f0-9-]{36}\.indd$/);
  assert.equal((await fs.stat(result.restoredWorkingPath)).isFile(), true);
  assert.match(calls.at(-1).source, /opened = await app\.open/);
  assert.ok(calls.at(-1).source.includes(result.restoredWorkingPath.replaceAll('\\', '/')));
  assert.equal(calls.at(-1).source.includes(path.join(directory, `backup-${backupId}.indd`).replaceAll('\\', '/')), false);
  assert.match(calls.at(-1).source, /await current\.close/);
});

test('la restauration refuse une sauvegarde sans provenance ou altérée', async (t) => {
  const missingMetadataId = '22345678-1234-4123-8123-123456789abc';
  const alteredId = '32345678-1234-4123-8123-123456789abc';
  const wrongDocumentId = '82345678-1234-4123-8123-123456789abc';
  const { bridge, directory, calls } = await fixture(t, async () => {
    throw new Error('InDesign ne doit pas être interrogé avant la validation de provenance.');
  });
  await fs.writeFile(path.join(directory, `backup-${missingMetadataId}.indd`), createInddFixture());
  await assert.rejects(
    bridge.restoreBackup({ documentId: 7, expectedRevision: 4, expectedStateToken: TOKEN_A, backupId: missingMetadataId, reason: 'Refuser une provenance absente' }),
    (error) => error.code === 'BACKUP_METADATA_MISSING',
  );

  const { backupPath } = await writeBackupWithMetadata(directory, {
    backupId: alteredId,
    documentId: 7,
    revision: 2,
    stateToken: TOKEN_B,
    content: createInddFixture(),
  });
  const alteredArtifact = createInddFixture();
  alteredArtifact[32] = 1;
  await fs.writeFile(backupPath, alteredArtifact);
  await assert.rejects(
    bridge.restoreBackup({ documentId: 7, expectedRevision: 4, expectedStateToken: TOKEN_A, backupId: alteredId, reason: 'Refuser une copie altérée' }),
    (error) => error.code === 'BACKUP_INTEGRITY_FAILED',
  );
  await writeBackupWithMetadata(directory, {
    backupId: wrongDocumentId,
    documentId: 8,
    revision: 2,
    stateToken: TOKEN_B,
    content: createInddFixture(),
  });
  await assert.rejects(
    bridge.restoreBackup({ documentId: 7, expectedRevision: 4, expectedStateToken: TOKEN_A, backupId: wrongDocumentId, reason: 'Refuser la sauvegarde d’un autre document' }),
    (error) => error.code === 'BACKUP_PROVENANCE_MISMATCH',
  );
  assert.equal(calls.length, 0);
});

function fastRequest(source) {
  const slots = JSON.parse(source.match(/const slots = (\[[^\]]*\]);/)[1]);
  const previewPath = JSON.parse(source.match(/exportFile\(indesign\.ExportFormat\.PNG_FORMAT, ("(?:\\.|[^"\\])*"), false\)/)[1]);
  return { slots, previewPath, resultPath: jsonAssignment(source, '__resultPath'), operationId: jsonAssignment(source, '__operationId') };
}

function fastResponder({ scriptOk = true } = {}) {
  return async ({ source }) => {
    assert.doesNotThrow(() => new Function(`return async function generatedUxpScript() {\n${source}\n}`));
    assert.match(source, /target\.revision !== expectedRevision/);
    assert.match(source, /target\.stateToken !== expectedStateToken/);
    assert.ok(source.indexOf('saveACopy(slots[index])') < source.indexOf('executeUserCode(app'), 'les sauvegardes précèdent le script');
    assert.match(source, /if \(after !== entry\.stateToken\)/, 'seuls les documents modifiés avancent');
    const request = fastRequest(source);
    await fs.writeFile(request.slots[0], createInddFixture());
    await fs.writeFile(request.slots[1], createInddFixture());
    await fs.writeFile(request.previewPath, createRgbaPng());
    await fs.writeFile(request.resultPath, JSON.stringify({
      ok: true,
      scriptOk,
      scriptError: scriptOk ? null : { message: 'boom', line: 3 },
      result: scriptOk ? { frames: 2 } : null,
      documentId: 42,
      revision: 8,
      stateToken: TOKEN_B,
      revisions: [{ documentId: 42, revision: 8 }, { documentId: 99, revision: 4 }],
      saved: scriptOk,
      backups: [
        { slot: 0, documentId: 42, revision: 7, stateToken: TOKEN_A },
        { slot: 1, documentId: 99, revision: 3, stateToken: TOKEN_A },
      ],
      preview: { pages: '1' },
      operationId: request.operationId,
    }));
    return null;
  };
}

test('run_layout_script sauvegarde, exécute et rend un aperçu vérifié en un seul passage InDesign', async (t) => {
  const { bridge, calls, directory } = await fixture(t, fastResponder());
  const result = await bridge.runLayoutScript({ documentId: 42, expectedRevision: 7, expectedStateToken: TOKEN_A, code: 'return 1;', save: true });
  assert.equal(calls.length, 1, 'un seul passage InDesign');
  assert.equal(result.scriptOk, true);
  assert.equal(result.revision, 8);
  assert.equal(result.stateToken, TOKEN_B);
  assert.equal(result.saved, true);
  assert.equal(result.safetyBackups.length, 2);
  assert.equal(result.backupId, result.safetyBackups.find((backup) => backup.documentId === 42).backupId);
  for (const backup of result.safetyBackups) {
    const metadata = JSON.parse(await fs.readFile(backup.metadataPath, 'utf8'));
    assert.equal(metadata.backupId, backup.backupId);
    assert.equal(metadata.artifact.sha256, crypto.createHash('sha256').update(await fs.readFile(backup.backupPath)).digest('hex'));
  }
  assert.equal(result.previewPaths.length, 1);
  assert.equal(path.dirname(result.previewPaths[0]), path.join(directory, 'previews'));
  assert.equal(Object.hasOwn(result, 'backups'), false);
  await assert.rejects(fs.access(path.join(directory, '.silent-runtime', '.mutation-lease.json')));
});

test('run_layout_script renvoie un échec de script comme issue connue, avec sauvegarde, sans bloquer la suite', async (t) => {
  const { bridge, directory } = await fixture(t, fastResponder({ scriptOk: false }));
  const result = await bridge.runLayoutScript({ documentId: 42, expectedRevision: 7, expectedStateToken: TOKEN_A, code: 'throw new Error("boom");', save: true });
  assert.equal(result.scriptOk, false);
  assert.equal(result.scriptError.message, 'boom');
  assert.equal(result.saved, false);
  assert.equal(result.requiresInspection, true);
  assert.match(result.nextStep, /silent_restore_backup/);
  assert.ok(result.backupId);
  await assert.rejects(fs.access(path.join(directory, '.silent-runtime', '.mutation-lease.json')), 'le verrou est libéré');
});

test('run_layout_script refuse de fermer sans enregistrer', async (t) => {
  const { bridge, calls } = await fixture(t, fastResponder());
  await assert.rejects(
    bridge.runLayoutScript({ documentId: 42, expectedRevision: 7, expectedStateToken: TOKEN_A, code: 'return 1;', close: true }),
    (error) => error.code === 'CLOSE_REQUIRES_SAVE',
  );
  assert.equal(calls.length, 0, 'rien n’est envoyé à InDesign');
});

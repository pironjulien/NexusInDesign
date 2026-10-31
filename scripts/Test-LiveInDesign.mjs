#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function integerOption(name, fallback, minimum, maximum) {
  const prefix = `--${name}=`;
  const raw = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  assert.ok(Number.isInteger(value) && value >= minimum && value <= maximum, `${name} invalide`);
  return value;
}

const REQUEST_TIMEOUT_MS = 180_000;
const BRIDGE_WAIT_MS = 45_000;
const PAIRING_WINDOW_SECONDS = integerOption('pairing-window-seconds', 120, 30, 300);
const PAIRING_WAIT_MS = (PAIRING_WINDOW_SECONDS * 1000) + 5_000;
const BRIDGE_PORT = integerOption('port', 33171, 1, 65535);
const CONNECTION_ONLY = process.argv.includes('--connection-only');
const PAIRING = process.argv.includes('--pair');
const SMOKE = process.argv.includes('--smoke');
const REQUIRED_TOOLS = [
  'bridge_status',
  'bridge_open_pairing_window',
  'bridge_arm_pairing_clipboard',
  'bridge_operation_status',
  'ping',
  'list_documents',
  'silent_list_documents',
  'silent_inspect_document',
  'silent_close_document',
  'silent_reconcile_unknown_operation',
  'create_document',
  'get_document_info',
  'get_document_colors',
  'list_pages',
  'create_color_swatch',
  'create_rectangle',
  'create_text_frame',
  'edit_text_frame',
  'list_page_items',
  'get_overset_text',
  'preflight_document',
  'save_as',
  'save_document',
  'restore_safety_backup',
  'execute_uxp',
  'export_pdf',
  'export_idml',
  'export_png',
  'export_images',
  'close_document',
];

// Runtime installé par install.ps1 hors OneDrive : le serveur y trouve node_modules et refuse un stockage privé
// sous OneDrive (comme le plugin). Aucune donnée de test n'est écrite dans le dépôt.
const runtimeRoot = path.join(os.homedir(), '.nexus', 'indesign-mcp-secure');
const entryPoint = path.join(runtimeRoot, 'src', 'index.js');
const outputRoot = path.join(runtimeRoot, 'e2e');
const expectedPluginVersion = JSON.parse(await fs.readFile(path.join(runtimeRoot, 'package.json'), 'utf8')).version;
const runId = `${new Date().toISOString().replace(/[-:.]/g, '').replace('Z', '')}-${randomUUID().slice(0, 8)}`;
const outputDirectory = path.join(outputRoot, runId);
const oneDriveRoot = process.env.OneDrive || process.env.OneDriveConsumer;
const secureTestRoot = oneDriveRoot ? path.join(runtimeRoot, 'private', 'live-e2e', runId) : null;
const backupRoot = secureTestRoot ? path.join(secureTestRoot, 'backups') : null;
const auditFile = secureTestRoot ? path.join(secureTestRoot, 'audit.jsonl') : null;
const inddPath = path.join(outputDirectory, 'a5-live.indd');
const pdfPath = path.join(outputDirectory, 'a5-live.pdf');
const idmlPath = path.join(outputDirectory, 'a5-live.idml');
const pngPath = path.join(outputDirectory, 'a5-page-1.png');
const legacyPngDirectory = path.join(outputDirectory, 'legacy-png');
const legacyJpegDirectory = path.join(outputDirectory, 'legacy-jpeg');

let serverStderr = '';

function logStep(message) {
  process.stdout.write(`[E2E InDesign] ${message}\n`);
}

function errorText(response) {
  return (response?.content ?? [])
    .filter((entry) => entry?.type === 'text')
    .map((entry) => entry.text)
    .join('\n');
}

function samePath(left, right) {
  return path.resolve(left).toLocaleLowerCase('en-US') === path.resolve(right).toLocaleLowerCase('en-US');
}

function runClipboardPowerShell(source, input) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new Error('PAIRING_CLIPBOARD_UNSUPPORTED: Windows est requis pour l’appairage automatique.'));
      return;
    }
    const windowsRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const powershell = path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(
      powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-Command', source],
      { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] },
    );
    let settled = false;
    child.once('error', () => {
      if (settled) return;
      settled = true;
      reject(new Error('PAIRING_CLIPBOARD_FAILED: le presse-papiers Windows est indisponible.'));
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve();
      else reject(new Error('PAIRING_CLIPBOARD_FAILED: le presse-papiers Windows est indisponible.'));
    });
    child.stdin.end(input, 'utf8');
  });
}

async function placePairingCodeOnClipboard(pairingCode) {
  await runClipboardPowerShell(
    "$value = [Console]::In.ReadToEnd(); Set-Clipboard -Value $value",
    pairingCode,
  );
}

async function clearPairingCodeFromClipboard(pairingCode) {
  await runClipboardPowerShell(
    "$expected = [Console]::In.ReadToEnd(); $current = $null; try { $current = Get-Clipboard -Raw -ErrorAction Stop } catch {}; if ([string]$current -ceq $expected) { Set-Clipboard -Value ([string]::Empty) }",
    pairingCode,
  );
}

async function assertFile(filePath, { minimumBytes, prefix } = {}) {
  const stat = await fs.stat(filePath);
  assert.equal(stat.isFile(), true, `${filePath} n'est pas un fichier`);
  assert.ok(stat.size >= (minimumBytes ?? 1), `${filePath} est vide ou incomplet (${stat.size} octets)`);
  if (prefix) {
    const handle = await fs.open(filePath, 'r');
    try {
      const actual = Buffer.alloc(prefix.length);
      const { bytesRead } = await handle.read(actual, 0, actual.length, 0);
      assert.equal(bytesRead, prefix.length, `signature incomplète pour ${filePath}`);
      assert.deepEqual(actual, prefix, `signature invalide pour ${filePath}`);
    } finally {
      await handle.close();
    }
  }
  return stat;
}

async function main() {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  assert.equal(nodeMajor, 24, `Node.js 24 est requis, version détectée : ${process.versions.node}`);

  const tokenFile = process.env.INDESIGN_MCP_TOKEN_FILE
    || (oneDriveRoot ? path.join(oneDriveRoot, 'Documents', 'NexusSecure', 'InDesignMCP', 'bridge-token') : null);
  assert.ok(tokenFile && path.isAbsolute(tokenFile), 'Le fichier de secret NexusSecure est introuvable.');
  assert.ok(secureTestRoot && backupRoot && auditFile, 'Le stockage de test privé local est introuvable.');
  await fs.access(tokenFile);
  await fs.access(entryPoint);
  await fs.mkdir(outputRoot, { recursive: true });
  if (!CONNECTION_ONLY) await fs.mkdir(outputDirectory, { recursive: false });
  await fs.mkdir(backupRoot, { recursive: true });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entryPoint],
    cwd: runtimeRoot,
    stderr: 'pipe',
    env: {
      INDESIGN_MCP_TOKEN_FILE: tokenFile,
      INDESIGN_MCP_PRIVATE_ROOT: secureTestRoot,
      INDESIGN_MCP_BACKUP_ROOT: backupRoot,
      INDESIGN_MCP_READ_ROOTS: outputRoot,
      INDESIGN_MCP_WRITE_ROOTS: outputRoot,
      INDESIGN_MCP_AUDIT_FILE: auditFile,
      INDESIGN_MCP_PORT: String(BRIDGE_PORT),
      INDESIGN_MCP_COMMAND_TIMEOUT_MS: '120000',
    },
  });
  transport.stderr?.on('data', (chunk) => {
    serverStderr = (serverStderr + chunk.toString('utf8')).slice(-4000);
  });

  const client = new Client({ name: 'nexus-indesign-live-e2e', version: '1.0.0' });
  const ownedDocumentIds = new Set();
  const unresolvedInspectionOperations = new Set();
  let unresolvedInspectionWithoutOperation = false;
  let activeDocumentId = null;
  let pairingClipboardCode = null;

  const rawCall = async (name, args = {}) => {
    const response = await client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: REQUEST_TIMEOUT_MS, maxTotalTimeout: REQUEST_TIMEOUT_MS },
    );
    if (response.isError && response.structuredContent?.requiresInspection === true) {
      const operationId = response.structuredContent.operationId;
      if (typeof operationId === 'string' && operationId.length > 0) {
        unresolvedInspectionOperations.add(operationId);
      } else if (unresolvedInspectionOperations.size === 0) {
        unresolvedInspectionWithoutOperation = true;
      }
    }
    return response;
  };

  const call = async (name, args = {}) => {
    const response = await rawCall(name, args);
    if (response.isError) throw new Error(`${name}: ${errorText(response) || 'erreur MCP sans détail'}`);
    assert.ok(response.structuredContent && typeof response.structuredContent === 'object', `${name}: résultat structuré absent`);
    return response.structuredContent;
  };

  const inspectDocumentState = async (documentId) => {
    const inspected = await call('silent_inspect_document', { documentId });
    const document = inspected.document;
    assert.equal(document?.documentId, documentId, `silent_inspect_document: document ${documentId} introuvable`);
    assert.ok(Number.isInteger(document.revision) && document.revision >= 0, 'révision InDesign invalide');
    assert.match(document.stateToken ?? '', /^[a-f0-9]{16}$/, 'stateToken InDesign invalide');
    return document;
  };

  const expectError = async (name, args, pattern) => {
    const response = await rawCall(name, args);
    assert.equal(response.isError, true, `${name} devait être refusé`);
    assert.match(errorText(response), pattern, `${name}: mauvaise erreur`);
    return response;
  };

  const cleanupOwnedDocuments = async () => {
    if (ownedDocumentIds.size === 0) return true;
    try {
      const listed = await rawCall('silent_list_documents', {});
      if (listed.isError || !listed.structuredContent) return false;
      for (const document of listed.structuredContent.documents ?? []) {
        if (unresolvedInspectionWithoutOperation || unresolvedInspectionOperations.size > 0) break;
        if (!ownedDocumentIds.has(document.documentId)) continue;
        const inspected = await rawCall('silent_inspect_document', { documentId: document.documentId });
        const state = inspected.isError ? null : inspected.structuredContent?.document;
        if (!state) continue;
        await rawCall('silent_close_document', {
          documentId: state.documentId,
          expectedRevision: state.revision,
          expectedStateToken: state.stateToken,
          save: false,
          reason: 'Nettoyer le document créé par le test E2E interrompu',
        }).catch(() => {});
      }
      if (unresolvedInspectionWithoutOperation || unresolvedInspectionOperations.size > 0) return false;
      const verified = await rawCall('silent_list_documents', {});
      if (verified.isError || !verified.structuredContent) return false;
      const remainingIds = new Set((verified.structuredContent.documents ?? []).map((document) => document.documentId));
      const allClosed = [...ownedDocumentIds].every((documentId) => !remainingIds.has(documentId));
      if (allClosed) ownedDocumentIds.clear();
      return allClosed;
    } catch (_) {
      // La fermeture principale reste prioritaire; l'erreur initiale sera conservée.
      return false;
    }
  };

  const reconcileBeforeCleanup = async () => {
    for (const operationId of [...unresolvedInspectionOperations]) {
      try {
        const reconciled = await rawCall('silent_reconcile_unknown_operation', {
          operationId,
          reason: 'Réconcilier une issue inconnue avant le nettoyage conservateur du test E2E',
        });
        if (reconciled.isError) continue;
        const status = await rawCall('bridge_operation_status', { operationId });
        if (!status.isError && status.structuredContent?.status === 'not-found') {
          unresolvedInspectionOperations.delete(operationId);
        }
      } catch (_) {
        // Les preuves et documents restent intacts si la réconciliation échoue.
      }
    }
  };

  try {
    logStep('connexion au serveur MCP STDIO réel');
    await client.connect(transport);

    const tools = await client.listTools(undefined, { timeout: REQUEST_TIMEOUT_MS });
    const toolNames = new Set(tools.tools.map((tool) => tool.name));
    assert.ok(tools.tools.length >= 151, `catalogue incomplet : ${tools.tools.length} outils`);
    for (const name of REQUIRED_TOOLS) assert.ok(toolNames.has(name), `outil requis absent : ${name}`);

    const initialBridgeStatus = await call('bridge_status');
    if (PAIRING && !initialBridgeStatus.authenticated) {
      if (initialBridgeStatus.listening !== true) {
        const owner = Number.isInteger(initialBridgeStatus.listenerOwnerPid) ? ` (PID ${initialBridgeStatus.listenerOwnerPid})` : '';
        throw new Error(`PAIRING_LISTENER_NOT_OWNED: le listener UXP appartient à une autre tâche${owner}; appelez bridge_open_pairing_window dans cette tâche propriétaire.`);
      }
      const pairingWindow = await call('bridge_open_pairing_window', {
        windowSeconds: PAIRING_WINDOW_SECONDS,
        reason: 'Renouveler l’appairage avant le test de connexion réel',
      });
      assert.equal(pairingWindow.pairingActive, true);
      assert.match(pairingWindow.pairingCode ?? '', /^[A-F0-9]{4}(?:-[A-F0-9]{4}){3}$/);
      pairingClipboardCode = pairingWindow.pairingCode;
      await placePairingCodeOnClipboard(pairingClipboardCode);
      const armed = await call('bridge_arm_pairing_clipboard', {
        reason: 'Autoriser une lecture unique du code temporaire déjà copié localement',
      });
      assert.equal(armed.clipboardReadArmed, true);
      assert.equal(armed.pairingActive, true);
      logStep('appairage automatique armé par une lecture unique du presse-papiers local');
    }

    const deadline = Date.now() + (PAIRING ? PAIRING_WAIT_MS : BRIDGE_WAIT_MS);
    let bridgeStatus = initialBridgeStatus;
    do {
      bridgeStatus = await call('bridge_status');
      if (bridgeStatus.connected && bridgeStatus.authenticated) break;
      await new Promise((resolve) => setTimeout(resolve, 750));
    } while (Date.now() < deadline);
    if (bridgeStatus?.authenticated !== true) {
      const diagnostic = {
        listening: bridgeStatus?.listening === true,
        connected: bridgeStatus?.connected === true,
        authenticated: bridgeStatus?.authenticated === true,
        pluginId: bridgeStatus?.pluginId ?? null,
        pluginVersion: bridgeStatus?.pluginVersion ?? null,
        listenerOwnerPid: Number.isSafeInteger(bridgeStatus?.listenerOwnerPid) ? bridgeStatus.listenerOwnerPid : null,
        listenerFailure: bridgeStatus?.listenerFailure ?? null,
      };
      throw new Error(`Le plugin UXP ne s’est pas authentifié dans le délai prévu : ${JSON.stringify(diagnostic)}`);
    }
    assert.equal(bridgeStatus?.pluginId, 'fr.pironjulien.indesign.mcp');
    assert.equal(bridgeStatus?.pluginVersion, expectedPluginVersion);
    if (pairingClipboardCode) {
      await clearPairingCodeFromClipboard(pairingClipboardCode).catch(() => {});
      pairingClipboardCode = null;
    }
    await call('ping');

    const initialDocuments = await call('list_documents');
    if (CONNECTION_ONLY) {
      logStep('SUCCÈS — connexion MCP → UXP → InDesign validée sans modifier les documents ouverts');
      process.stdout.write(`${JSON.stringify({
        ok: true,
        mode: 'connection-only',
        pluginId: bridgeStatus.pluginId,
        pluginVersion: bridgeStatus.pluginVersion,
        authenticated: bridgeStatus.authenticated,
        openDocumentsPreserved: initialDocuments.documents?.length ?? 0,
      }, null, 2)}\n`);
      return;
    }
    assert.equal(
      initialDocuments.documents?.length ?? 0,
      0,
      'Le test legacy exige une session InDesign sans document utilisateur ouvert.',
    );
    const initialDocumentIds = new Set((initialDocuments.documents ?? []).map((document) => document.documentId));

    logStep('création du document A5 réel');
    const created = await call('create_document', {
      expectedRevision: 0,
      width: 148.5,
      height: 210,
      pageCount: 2,
      facingPages: true,
      units: 'mm',
      margins: [12, 12, 14, 12],
      bleed: [3, 3, 3, 3],
    });
    activeDocumentId = created.documentId;
    ownedDocumentIds.add(activeDocumentId);
    assert.equal(initialDocumentIds.has(activeDocumentId), false, 'InDesign a réutilisé un document déjà ouvert');
    let revision = created.revision;
    assert.equal(revision, 0);
    let stateToken = created.stateToken;
    assert.match(stateToken ?? '', /^[a-f0-9]{16}$/);

    const createdInfo = await call('get_document_info', { documentId: activeDocumentId });
    assert.ok(Math.abs(createdInfo.document.widthMm - 148.5) < 0.01, `largeur inattendue : ${createdInfo.document.widthMm}`);
    assert.ok(Math.abs(createdInfo.document.heightMm - 210) < 0.01, `hauteur inattendue : ${createdInfo.document.heightMm}`);
    assert.equal(createdInfo.document.facingPages, true);
    assert.equal(createdInfo.document.pages, 2);
    revision = createdInfo.revision;
    ({ stateToken } = await inspectDocumentState(activeDocumentId));

    let pagesResult = await call('list_pages', { documentId: activeDocumentId });
    assert.equal(pagesResult.pages.length, 2);
    let firstPageId = pagesResult.pages[0].pageId;

    const swatch = await call('create_color_swatch', {
      documentId: activeDocumentId,
      expectedRevision: revision,
      expectedStateToken: stateToken,
      name: 'Bleu E2E',
      colorSpace: 'CMYK',
      values: [100, 80, 0, 10],
      reason: 'Créer la nuance du document jetable E2E',
    });
    revision = swatch.revision;
    stateToken = swatch.stateToken;

    if (!SMOKE) {
    logStep('preuve de ciblage d’une commande legacy sur deux documents jetables');
    const decoyCreated = await call('create_document', {
      expectedRevision: 0,
      width: 148.5,
      height: 210,
      pageCount: 1,
      facingPages: false,
      units: 'mm',
      margins: [12, 12, 12, 12],
      bleed: [0, 0, 0, 0],
    });
    const decoyDocumentId = decoyCreated.documentId;
    ownedDocumentIds.add(decoyDocumentId);
    let decoyRevision = decoyCreated.revision;
    let decoyStateToken = decoyCreated.stateToken;
    const decoySwatchName = `Leurre legacy ${runId.slice(-8)}`;
    const decoySwatch = await call('create_color_swatch', {
      documentId: decoyDocumentId,
      expectedRevision: decoyRevision,
      expectedStateToken: decoyStateToken,
      name: decoySwatchName,
      colorSpace: 'CMYK',
      values: [0, 100, 100, 0],
      reason: 'Créer la nuance leurre du second document jetable E2E',
    });
    decoyRevision = decoySwatch.revision;
    decoyStateToken = decoySwatch.stateToken;

    const beforeLegacy = await call('list_documents');
    assert.equal(beforeLegacy.documents?.length, 2, 'seuls les deux documents jetables doivent être ouverts avant la commande legacy');
    assert.equal(
      beforeLegacy.documents.every((document) => ownedDocumentIds.has(document.documentId)),
      true,
      'un document non créé par le test est ouvert; la preuve legacy est annulée',
    );
    assert.equal(
      beforeLegacy.documents?.find((document) => document.documentId === decoyDocumentId)?.active,
      true,
      'le second document jetable devait être actif avant la commande legacy',
    );
    const legacyColors = await call('get_document_colors', {
      scope: 'document',
      documentId: activeDocumentId,
      expectedRevision: revision,
      expectedStateToken: stateToken,
      includeSwatches: true,
      includeGradients: false,
      includeTints: false,
      reason: 'Prouver le ciblage exact de l’ancienne commande de lecture des nuances',
    });
    assert.ok(legacyColors.result?.swatches?.includes('Bleu E2E'), 'la commande legacy n’a pas lu le document ciblé');
    assert.equal(
      legacyColors.result?.swatches?.includes(decoySwatchName),
      false,
      'la commande legacy a lu le document actif au lieu du documentId ciblé',
    );
    assert.ok(Array.isArray(legacyColors.result?.safetyBackups) && legacyColors.result.safetyBackups.length === 2, 'les deux documents jetables devaient être protégés');

    const decoyState = await inspectDocumentState(decoyDocumentId);
    decoyRevision = decoyState.revision;
    decoyStateToken = decoyState.stateToken;
    const decoyClosed = await call('close_document', {
      documentId: decoyDocumentId,
      expectedRevision: decoyRevision,
      expectedStateToken: decoyStateToken,
      save: false,
      reason: 'Fermer sans sauvegarde le document leurre du test legacy',
    });
    assert.equal(decoyClosed.closedDocumentId, decoyDocumentId);

    const targetStateAfterLegacy = await inspectDocumentState(activeDocumentId);
    revision = targetStateAfterLegacy.revision;
    stateToken = targetStateAfterLegacy.stateToken;
    }

    const staleRevision = revision;
    const rectangle = await call('create_rectangle', {
      documentId: activeDocumentId,
      expectedRevision: revision,
      expectedStateToken: stateToken,
      pageId: firstPageId,
      bounds: [12, 12, 20, 136.5],
      fillColorName: 'Bleu E2E',
      strokeColorName: 'Bleu E2E',
      strokeWeight: 0,
      reason: 'Créer le bandeau du document jetable E2E',
    });
    revision = rectangle.revision;
    stateToken = rectangle.stateToken;
    assert.ok(rectangle.pageItem?.id > 0);

    logStep('contrôle du verrou de révision périmée');
    await expectError('create_rectangle', {
      documentId: activeDocumentId,
      expectedRevision: staleRevision,
      expectedStateToken: stateToken,
      pageId: firstPageId,
      bounds: [24, 12, 30, 136.5],
      fillColorName: 'Bleu E2E',
      strokeWeight: 0,
      reason: 'Vérifier le refus d’une révision périmée',
    }, /REVISION_CONFLICT/);
    const afterConflict = await call('get_document_info', { documentId: activeDocumentId });
    assert.equal(afterConflict.revision, revision, 'la révision a changé malgré le refus de la commande périmée');
    assert.equal((await inspectDocumentState(activeDocumentId)).stateToken, stateToken, 'le contenu a changé malgré le refus de la commande périmée');

    const originalText = 'Test MCP réel\nDocument A5 en vis-à-vis';
    const textFrame = await call('create_text_frame', {
      documentId: activeDocumentId,
      expectedRevision: revision,
      expectedStateToken: stateToken,
      pageId: firstPageId,
      bounds: [30, 18, 76, 130.5],
      text: originalText,
      reason: 'Créer le texte du document jetable E2E',
    });
    revision = textFrame.revision;
    stateToken = textFrame.stateToken;
    let textFrameId = textFrame.pageItem?.id;
    assert.ok(textFrameId > 0);
    assert.equal(textFrame.overflows, false);

    logStep('enregistrement INDD et inspection du document');
    const savedAs = await call('save_as', {
      documentId: activeDocumentId,
      expectedRevision: revision,
      expectedStateToken: stateToken,
      path: inddPath,
      overwrite: false,
      reason: 'Enregistrer le document A5 du test E2E réel',
    });
    assert.ok(savedAs.backupId, 'save_as n’a pas créé sa sauvegarde de sécurité');
    assert.ok(samePath(savedAs.path, inddPath));
    revision = savedAs.revision;
    stateToken = savedAs.stateToken;
    const saved = await call('save_document', {
      documentId: activeDocumentId,
      expectedRevision: revision,
      expectedStateToken: stateToken,
      reason: 'Enregistrer le document jetable E2E',
    });
    revision = saved.revision;
    stateToken = saved.stateToken;
    await assertFile(inddPath, { minimumBytes: 4096 });

    let items = await call('list_page_items', { documentId: activeDocumentId, pageId: firstPageId });
    assert.equal(items.items.length, 2, `deux objets attendus, ${items.items.length} obtenus`);
    assert.ok(items.items.some((item) => item.type === 'TextFrame'));
    assert.ok(items.items.some((item) => item.type === 'Rectangle'));
    const overset = await call('get_overset_text', { documentId: activeDocumentId });
    assert.equal(overset.count, 0);
    const preflight = await call('preflight_document', { documentId: activeDocumentId, timeoutSeconds: 60 });
    assert.equal(preflight.success, true);
    const stateAfterPreflight = await inspectDocumentState(activeDocumentId);
    revision = stateAfterPreflight.revision;
    stateToken = stateAfterPreflight.stateToken;

    if (!SMOKE) {
    logStep('mutation partielle volontaire, blocage durable et réconciliation réelle');
    const stateBeforePartialFailure = { documentId: activeDocumentId, revision, stateToken };
    const partialFailureResponse = await expectError('execute_uxp', {
      scope: 'document',
      documentId: activeDocumentId,
      expectedRevision: revision,
      expectedStateToken: stateToken,
      reason: 'Prouver la reprise après une mutation UXP partielle volontaire',
      input: { documentId: activeDocumentId, itemId: textFrameId },
      code: `
        let target = null;
        for (let i = 0; i < app.documents.length; i += 1) {
          const candidate = app.documents.item(i);
          if (Number(candidate.id) === Number(input.documentId)) { target = candidate; break; }
        }
        if (!target || target.isValid === false) throw new Error('E2E_CIBLE_PARTIELLE_INTROUVABLE');
        let frame = null;
        for (let i = 0; i < target.textFrames.length; i += 1) {
          const candidate = target.textFrames.item(i);
          if (Number(candidate.id) === Number(input.itemId)) { frame = candidate; break; }
        }
        if (!frame || frame.isValid === false) throw new Error('E2E_BLOC_PARTIEL_INTROUVABLE');
        frame.contents = 'MUTATION PARTIELLE VOLONTAIRE E2E';
        throw new Error('E2E_MUTATION_PARTIELLE_VOLONTAIRE');
      `,
    }, /INDESIGN_ERROR.*E2E_MUTATION_PARTIELLE_VOLONTAIRE/s);
    const partialFailure = partialFailureResponse.structuredContent;
    assert.ok(partialFailure && typeof partialFailure === 'object', 'execute_uxp: preuve structurée de panne absente');
    assert.equal(partialFailure.requiresInspection, true, 'la mutation partielle devait imposer une inspection');
    assert.match(partialFailure.operationId ?? '', /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i, 'operationId de panne invalide');
    assert.ok(Array.isArray(partialFailure.documentStates), 'les états post-échec des documents sont absents');
    const failedTargetState = partialFailure.documentStates.find((entry) => entry.documentId === activeDocumentId);
    assert.ok(failedTargetState, 'l’état post-échec du document ciblé est absent');
    assert.equal(failedTargetState.revision, stateBeforePartialFailure.revision + 1, 'la révision post-échec n’a pas avancé');
    assert.match(failedTargetState.stateToken ?? '', /^[a-f0-9]{16}$/, 'stateToken post-échec invalide');
    assert.notEqual(failedTargetState.stateToken, stateBeforePartialFailure.stateToken, 'la mutation partielle réelle n’a pas modifié le document');
    const partialFailureBackup = partialFailure.safetyBackups?.find((backup) => backup.documentId === activeDocumentId);
    assert.ok(partialFailureBackup?.backupId, 'la sauvegarde précédant la mutation partielle est absente');
    assert.equal(partialFailure.backupId, partialFailureBackup.backupId, 'la sauvegarde principale ne correspond pas au document ciblé');
    assert.ok(partialFailureBackup.backupPath && await fs.stat(partialFailureBackup.backupPath));

    const blockedOperation = await call('bridge_operation_status', { operationId: partialFailure.operationId });
    assert.equal(blockedOperation.status, 'completed', `statut de panne plugin inattendu : ${blockedOperation.status}`);
    assert.equal(blockedOperation.requiresInspection, true, 'le statut plugin devait rester bloqué pour inspection');
    assert.equal(blockedOperation.outcome?.ok, false, 'le statut plugin ne conserve pas l’échec réel');
    assert.ok(
      blockedOperation.outcome?.error?.documentStates?.some((entry) => entry.documentId === activeDocumentId),
      'le statut plugin ne conserve pas les états post-échec',
    );
    await expectError('ping', {}, /PERSISTED_OPERATION_REQUIRES_RECONCILIATION/);

    const reconciled = await call('silent_reconcile_unknown_operation', {
      operationId: partialFailure.operationId,
      reason: 'Stabiliser, sauvegarder et acquitter la mutation partielle volontaire E2E',
    });
    assert.equal(reconciled.operationId, partialFailure.operationId);
    assert.equal(reconciled.status, 'reconciled-unknown', `statut de réconciliation inattendu : ${reconciled.status}`);
    assert.equal(reconciled.requiresInspection, true);
    assert.ok(reconciled.snapshots?.some((snapshot) => snapshot.documentId === activeDocumentId), 'la réconciliation n’a pas inspecté le document ciblé');
    assert.ok(reconciled.safetyBackups?.some((backup) => backup.documentId === activeDocumentId), 'la réconciliation n’a pas protégé le document ciblé');
    const releasedOperation = await call('bridge_operation_status', { operationId: partialFailure.operationId });
    assert.equal(releasedOperation.status, 'not-found', 'le verrou plugin n’a pas été acquitté après réconciliation');
    unresolvedInspectionOperations.delete(partialFailure.operationId);

    const stateAfterReconciliation = await inspectDocumentState(activeDocumentId);
    assert.equal(stateAfterReconciliation.revision, failedTargetState.revision, 'la réconciliation a modifié la révision du document');
    assert.equal(stateAfterReconciliation.stateToken, failedTargetState.stateToken, 'la réconciliation a modifié le document');
    const failedDocumentId = activeDocumentId;
    const restoredAfterFailure = await call('restore_safety_backup', {
      documentId: failedDocumentId,
      expectedRevision: stateAfterReconciliation.revision,
      expectedStateToken: stateAfterReconciliation.stateToken,
      backupId: partialFailureBackup.backupId,
      reason: 'Restaurer le document avant la mutation partielle volontaire E2E',
    });
    assert.equal(restoredAfterFailure.restoredFromBackupId, partialFailureBackup.backupId);
    assert.equal(restoredAfterFailure.sourceRevision, stateBeforePartialFailure.revision);
    assert.equal(restoredAfterFailure.revision, stateAfterReconciliation.revision + 1, 'la restauration post-échec doit avancer la révision');
    assert.ok(restoredAfterFailure.recoveryBackupId, 'la restauration post-échec n’a pas protégé l’état abandonné');
    activeDocumentId = restoredAfterFailure.restoredDocumentId;
    ownedDocumentIds.add(activeDocumentId);
    revision = restoredAfterFailure.revision;
    stateToken = restoredAfterFailure.stateToken;
    const stateAfterFailureRestore = await inspectDocumentState(activeDocumentId);
    assert.equal(stateAfterFailureRestore.revision, revision);
    assert.equal(stateAfterFailureRestore.stateToken, stateToken);
    pagesResult = await call('list_pages', { documentId: activeDocumentId });
    firstPageId = pagesResult.pages[0].pageId;
    items = await call('list_page_items', { documentId: activeDocumentId, pageId: firstPageId });
    const restoredTextFrame = items.items.find((item) => item.type === 'TextFrame');
    assert.ok(restoredTextFrame?.id > 0, 'le bloc texte est absent après la restauration post-échec');
    textFrameId = restoredTextFrame.id;

    logStep('modification destructive, sauvegarde automatique et restauration réelle');
    const preEditRevision = revision;
    const edited = await call('edit_text_frame', {
      documentId: activeDocumentId,
      expectedRevision: revision,
      expectedStateToken: stateToken,
      itemId: textFrameId,
      text: 'CONTENU TEMPORAIRE À RESTAURER',
      append: false,
      reason: 'Vérifier la sauvegarde automatique avant modification du texte',
    });
    assert.ok(edited.backupId, 'edit_text_frame n’a pas renvoyé de sauvegarde de sécurité');
    assert.ok(edited.backupPath && await fs.stat(edited.backupPath));
    revision = edited.revision;
    stateToken = edited.stateToken;
    assert.equal(revision, preEditRevision + 1);

    const restored = await call('restore_safety_backup', {
      documentId: activeDocumentId,
      expectedRevision: revision,
      expectedStateToken: stateToken,
      backupId: edited.backupId,
      reason: 'Restaurer réellement le document avant la modification temporaire',
    });
    assert.ok(restored.recoveryBackupId, 'la restauration n’a pas protégé l’état abandonné');
    assert.ok(restored.recoveryBackupPath && await fs.stat(restored.recoveryBackupPath));
    assert.equal(restored.restoredFromBackupId, edited.backupId);
    assert.equal(restored.sourceRevision, preEditRevision);
    assert.equal(restored.revision, revision + 1, 'la restauration doit avancer la révision de façon monotone');
    activeDocumentId = restored.restoredDocumentId;
    ownedDocumentIds.add(activeDocumentId);
    revision = restored.revision;
    stateToken = restored.stateToken;

    const restoredInfo = await call('get_document_info', { documentId: activeDocumentId });
    assert.equal(restoredInfo.revision, restored.revision);
    assert.ok(
      samePath(restoredInfo.document.path, edited.backupPath),
      `la copie restaurée n’est pas le fichier de sauvegarde attendu (${restoredInfo.document.path} != ${edited.backupPath})`,
    );
    pagesResult = await call('list_pages', { documentId: activeDocumentId });
    firstPageId = pagesResult.pages[0].pageId;
    items = await call('list_page_items', { documentId: activeDocumentId, pageId: firstPageId });
    assert.equal(items.items.length, 2, 'la restauration n’a pas retrouvé les deux objets initiaux');

    const restoredText = await call('execute_uxp', {
      scope: 'document',
      documentId: activeDocumentId,
      expectedRevision: revision,
      expectedStateToken: stateToken,
      reason: 'Vérifier le contenu restauré du document E2E',
      input: { documentId: activeDocumentId },
      code: `
        let target = null;
        for (let i = 0; i < app.documents.length; i += 1) {
          const candidate = app.documents.item(i);
          if (Number(candidate.id) === Number(input.documentId)) { target = candidate; break; }
        }
        if (!target || target.isValid === false || target.textFrames.length !== 1) {
          throw new Error('Le bloc texte restauré est introuvable');
        }
        return { contents: String(target.textFrames.item(0).contents) };
      `,
    });
    assert.ok(
      restoredText.safetyBackups?.some((backup) => backup.documentId === activeDocumentId),
      'execute_uxp n’a pas protégé le document avant inspection avancée',
    );
    const normalizeLineEndings = (value) => String(value).replace(/\r\n?|\n/g, '\n');
    assert.equal(normalizeLineEndings(restoredText.contents), normalizeLineEndings(originalText));
    revision = restoredText.revision;
    stateToken = restoredText.stateToken;
    } else {
      logStep('mode rapide : ciblage multi-document et restauration vérifiés par leurs diagnostics dédiés');
    }

    logStep('exports PDF, IDML et PNG réels');
    const exportedPdf = await call('export_pdf', {
      documentId: activeDocumentId,
      expectedRevision: revision,
      expectedStateToken: stateToken,
      filePath: pdfPath,
      overwrite: false,
      reason: 'Exporter le PDF du test E2E réel',
    });
    assert.ok(exportedPdf.backupId);
    assert.ok(samePath(exportedPdf.path, pdfPath));
    revision = exportedPdf.revision;
    stateToken = exportedPdf.stateToken;

    const exportedIdml = await call('export_idml', {
      documentId: activeDocumentId,
      expectedRevision: revision,
      expectedStateToken: stateToken,
      filePath: idmlPath,
      overwrite: false,
      reason: 'Exporter l’IDML du test E2E réel',
    });
    assert.ok(exportedIdml.backupId);
    assert.ok(samePath(exportedIdml.path, idmlPath));
    revision = exportedIdml.revision;
    stateToken = exportedIdml.stateToken;

    const exportedPng = await call('export_png', {
      documentId: activeDocumentId,
      expectedRevision: revision,
      expectedStateToken: stateToken,
      pageId: firstPageId,
      filePath: pngPath,
      resolution: 150,
      transparentBackground: false,
      overwrite: false,
      reason: 'Exporter la première page PNG du test E2E réel',
    });
    assert.ok(exportedPng.backupId);
    assert.ok((exportedPng.paths ?? []).some((entry) => samePath(entry, pngPath)));
    revision = exportedPng.revision;
    stateToken = exportedPng.stateToken;

    await assertFile(pdfPath, { minimumBytes: 1024, prefix: Buffer.from('%PDF-', 'ascii') });
    await assertFile(idmlPath, { minimumBytes: 1024, prefix: Buffer.from([0x50, 0x4b]) });
    await assertFile(pngPath, { minimumBytes: 1024, prefix: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) });

    logStep('exports PNG et JPEG de la commande héritée réelle');
    const legacyPng = await call('export_images', {
      scope: 'document',
      documentId: activeDocumentId,
      expectedRevision: revision,
      expectedStateToken: stateToken,
      outputPath: legacyPngDirectory,
      pages: '1-2',
      format: 'PNG',
      resolution: 150,
      reason: 'Valider l’export PNG de la commande héritée sur le document E2E',
    });
    assert.equal(legacyPng.success, true);
    ({ revision, stateToken } = await inspectDocumentState(activeDocumentId));
    const legacyPngPaths = [
      path.join(legacyPngDirectory, 'page_1.png'),
      path.join(legacyPngDirectory, 'page_2.png'),
    ];
    for (const legacyPngPath of legacyPngPaths) {
      await assertFile(legacyPngPath, {
        minimumBytes: 1024,
        prefix: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      });
    }

    const legacyJpeg = await call('export_images', {
      scope: 'document',
      documentId: activeDocumentId,
      expectedRevision: revision,
      expectedStateToken: stateToken,
      outputPath: legacyJpegDirectory,
      pages: '1',
      format: 'JPEG',
      resolution: 150,
      quality: 90,
      reason: 'Valider l’export JPEG de la commande héritée sur le document E2E',
    });
    assert.equal(legacyJpeg.success, true);
    ({ revision, stateToken } = await inspectDocumentState(activeDocumentId));
    const legacyJpegPath = path.join(legacyJpegDirectory, 'page_1.jpg');
    await assertFile(legacyJpegPath, {
      minimumBytes: 1024,
      prefix: Buffer.from([0xff, 0xd8, 0xff]),
    });

    const closed = await call('close_document', {
      documentId: activeDocumentId,
      expectedRevision: revision,
      expectedStateToken: stateToken,
      save: false,
      reason: 'Fermer le document du test E2E après validation des exports',
    });
    assert.equal(closed.closedDocumentId, activeDocumentId);
    activeDocumentId = null;

    const finalDocuments = await call('list_documents');
    for (const document of finalDocuments.documents ?? []) {
      assert.equal(ownedDocumentIds.has(document.documentId), false, `document E2E encore ouvert : ${document.documentId}`);
    }
    ownedDocumentIds.clear();

    logStep('SUCCÈS — chaîne MCP → UXP → InDesign validée de bout en bout');
    process.stdout.write(`${JSON.stringify({
      mode: SMOKE ? 'smoke' : 'full',
      outputDirectory,
      files: {
        inddPath,
        pdfPath,
        idmlPath,
        pngPath,
        legacyPngDirectory,
        legacyJpegDirectory,
      },
    }, null, 2)}\n`);
  } finally {
    if (pairingClipboardCode) {
      await clearPairingCodeFromClipboard(pairingClipboardCode).catch(() => {});
      pairingClipboardCode = null;
    }
    await reconcileBeforeCleanup();
    let cleanupConfirmed = ownedDocumentIds.size === 0;
    if (!unresolvedInspectionWithoutOperation && unresolvedInspectionOperations.size === 0) {
      cleanupConfirmed = await cleanupOwnedDocuments();
    } else {
      logStep('preuves et documents E2E conservés : une issue InDesign reste à inspecter');
    }
    await client.close().catch(() => {});
    if (!unresolvedInspectionWithoutOperation && unresolvedInspectionOperations.size === 0 && cleanupConfirmed) {
      await fs.rm(secureTestRoot, { recursive: true, force: true }).catch(() => {});
    } else if (!cleanupConfirmed) {
      logStep('preuves privées conservées : la fermeture silencieuse des documents E2E n’est pas confirmée');
    }
  }
}

main().catch((error) => {
  process.stderr.write(`[E2E InDesign] ÉCHEC — ${error.stack || error.message}\n`);
  if (serverStderr.trim()) process.stderr.write(`[Serveur MCP] ${serverStderr.trim()}\n`);
  process.exitCode = 1;
});

import { execFile } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { applyWindowsPrivateAcl } from '../security/PrivateAcl.js';
import { minimalWindowsEnvironment } from '../security/windowsEnvironment.js';
import { verifyArtifact } from '../verification/ArtifactVerifier.js';
import { acquireWindowsNamedMutexGuard } from './WindowsNamedMutexGuard.js';

const execFileAsync = promisify(execFile);
const pluginRequire = createRequire(import.meta.url);
const { documentStateToken } = pluginRequire('../../plugin/commands.js');
const REVISION_LABEL = 'fr.pironjulien.indesign.mcp.revision';
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const BACKUP_ID_PATTERN = /^(?:[a-f0-9]{36}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/;
const STATE_TOKEN_PATTERN = /^[a-f0-9]{16}$/;
const BACKUP_METADATA_VERSION = 1;
const RESTORED_MARKER_PATTERN = /^restore-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.open\.json$/i;
const RUNTIME_RETENTION_MS = 24 * 60 * 60 * 1000;
const FAST_BACKUP_SLOTS = 16;
const POWERSHELL_LAUNCHER = fileURLToPath(new URL('../../scripts/Invoke-InDesignScript.ps1', import.meta.url));
const RELEASE_NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const GUARDED_RESPONSE_LIMIT = 1024 * 1024;
const RECONCILIATION_RECORD_LIMIT = 1024 * 1024;

// Assemblage silencieux : packageForPrint renvoie false, sans dire pourquoi, quand ses contrôles trouvent un problème
// (une seule image RVB suffit) et que ignorePreflightErrors vaut false. Sous NEVER_INTERACT aucune alerte ne bloque
// InDesign ; un refus est relu (images RVB, liens, polices, texte en excès) et rendu explicite.
const PACKAGE_ACTION = (options) => `  const packageOptions = ${jsonLiteral(options)};
  try {
    exportStarted = true;
    const completed = targetDocument.packageForPrint(
      packageOptions.folderPath,
      packageOptions.includeFonts,
      packageOptions.includeLinks,
      packageOptions.includeProfiles,
      true,
      packageOptions.includeHiddenLayers,
      packageOptions.ignorePreflightErrors,
      true,
      packageOptions.includeIdml,
      packageOptions.includePdf,
      packageOptions.pdfPresetName,
      true,
      "InDesign MCP Secure",
      false
    );
    if (completed === false) {
      const findings = [];
      const limit = (list) => list.slice(0, 10).join(", ") + (list.length > 10 ? "…" : "");
      const rgb = []; const links = []; const fonts = []; let overset = 0;
      try {
        const graphics = targetDocument.allGraphics;
        for (let index = 0; index < graphics.length; index += 1) {
          const graphic = graphics[index];
          let space = ""; try { space = String(graphic.space); } catch (_) {}
          if (/^(RGB|RVB)$/i.test(space)) { let name = ""; try { name = String(graphic.itemLink.name); } catch (_) {} rgb.push(name || "image"); }
        }
      } catch (_) {}
      try {
        for (let index = 0; index < targetDocument.links.length; index += 1) {
          const link = targetDocument.links.item(index);
          const status = String(link.status);
          if (!/^(NORMAL|normal)$/.test(status) && !/normal/i.test(status)) links.push(String(link.name) + " (" + status + ")");
        }
      } catch (_) {}
      try {
        for (let index = 0; index < targetDocument.fonts.length; index += 1) {
          const font = targetDocument.fonts.item(index);
          const status = String(font.status);
          if (!/installed/i.test(status)) fonts.push(String(font.name).replace(/\t/g, " ") + " (" + status + ")");
        }
      } catch (_) {}
      try {
        for (let index = 0; index < targetDocument.stories.length; index += 1) if (targetDocument.stories.item(index).overflows) overset += 1;
      } catch (_) {}
      if (rgb.length) findings.push(rgb.length + " image(s) RVB : " + limit([...new Set(rgb)]));
      if (links.length) findings.push(links.length + " lien(s) à revoir : " + limit(links));
      if (fonts.length) findings.push(fonts.length + " police(s) non installée(s) : " + limit(fonts));
      if (overset) findings.push(overset + " bloc(s) de texte en excès");
      const error = new Error(packageOptions.ignorePreflightErrors
        ? "InDesign n’a pas créé l’assemblage" + (findings.length ? " (" + findings.join(" ; ") + ")" : "")
        : "InDesign refuse l’assemblage tant que ses contrôles signalent un problème : "
          + (findings.length ? findings.join(" ; ") : "problème non identifié")
          + ". Corrigez-le, ou repassez ignorePreflightErrors=true pour assembler malgré ces alertes.");
      error.code = packageOptions.ignorePreflightErrors ? "PACKAGE_FAILED" : "PACKAGE_REFUSED_BY_CHECKS";
      throw error;
    }
    exportResult = { success: true, folderPath: packageOptions.folderPath };
  } catch (error) { exportFailure = error; }`;

async function captureWindowsInDesignProcesses() {
  if (process.platform !== 'win32') return [];
  const windowsDirectory = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const powershell = path.join(windowsDirectory, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const source = `$items = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'InDesign.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
  $created = $_.CreationDate
  if ($created -is [datetime]) { $startedAt = $created.ToUniversalTime().ToString('o') }
  else { try { $startedAt = [System.Management.ManagementDateTimeConverter]::ToDateTime([string]$created).ToUniversalTime().ToString('o') } catch { $startedAt = $null } }
  if ([int]$_.ProcessId -gt 0 -and $startedAt) { [pscustomobject]@{ processId = [int]$_.ProcessId; startedAt = $startedAt } }
})
@($items) | ConvertTo-Json -Compress`;
  const { stdout } = await execFileAsync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', source], {
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    env: minimalWindowsEnvironment(),
  });
  const parsed = JSON.parse(String(stdout).trim() || '[]');
  const values = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  return values
    .filter((entry) => Number.isInteger(entry?.processId) && entry.processId > 0 && typeof entry.startedAt === 'string' && !Number.isNaN(Date.parse(entry.startedAt)))
    .map(({ processId, startedAt }) => ({ processId, startedAt: new Date(startedAt).toISOString() }))
    .sort((left, right) => left.processId - right.processId);
}

function jsonLiteral(value) {
  return JSON.stringify(value).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}

function uxpPath(filePath) {
  return filePath.replaceAll('\\', '/');
}

function parseUxpResult(value) {
  const output = typeof value === 'string' ? JSON.parse(value) : value;
  if (output?.ok === false) {
    const error = new Error(output.message || 'L’exécution InDesign a échoué.');
    error.code = output.code || 'UXP_ERROR';
    error.operationId = output.operationId;
    error.requiresInspection = output.requiresInspection === true;
    throw error;
  }
  return output;
}

async function sha256File(filePath) {
  const handle = await fs.open(filePath, 'r');
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

function assertGeneratedUxpSyntax(source) {
  try {
    // Parsing inside an async function accepts the global-await syntax used by
    // InDesign UXP while executing none of the generated code.
    new Function(`return async function generatedUxpScript() {\n${source}\n}`);
  } catch (cause) {
    const error = new Error(`Le script UXP généré est invalide et n’a pas été envoyé à InDesign: ${cause.message}`);
    error.code = 'GENERATED_UXP_SYNTAX_ERROR';
    error.cause = cause;
    throw error;
  }
}

function assertGeneratedSyncUxpSyntax(source) {
  try {
    // Les appels synchrones passent par app.doScript sans contexte de module.
    // Un await de premier niveau ferait basculer le chargeur UXP et ouvrirait
    // une boîte d’erreur Adobe au lieu de produire un résultat structuré.
    new Function(source);
  } catch (cause) {
    const error = new Error(`Le script UXP synchrone généré est invalide et n’a pas été envoyé à InDesign: ${cause.message}`);
    error.code = 'GENERATED_SYNC_UXP_SYNTAX_ERROR';
    error.cause = cause;
    throw error;
  }
}

const DOCUMENT_STATE_FUNCTION = documentStateToken.toString();
// Profil documentaire commun à l'ouverture et à la création silencieuses : inventaire stable des documents ouverts
// (révision, jeton, modifié, enregistré, actif), contrôles avant/après et mise au premier plan vérifiée.
const DOCUMENT_PROFILE_HELPERS = `  const captureDocumentProfile = () => {
    let activeId = null;
    if (app.documents.length > 0) {
      try {
        const activeDocument = app.activeDocument;
        if (activeDocument && activeDocument.isValid !== false) activeId = Number(activeDocument.id);
      } catch (_) {}
    }
    const profile = [];
    for (let index = 0; index < app.documents.length; index += 1) {
      const doc = app.documents.item(index);
      const rawRevision = doc.extractLabel(${jsonLiteral(REVISION_LABEL)});
      const parsedRevision = Number.parseInt(rawRevision || "0", 10);
      profile.push({
        doc,
        documentId: Number(doc.id),
        revision: Number.isInteger(parsedRevision) && parsedRevision >= 0 ? parsedRevision : 0,
        stateToken: documentStateToken(doc),
        modified: Boolean(doc.modified),
        saved: Boolean(doc.saved),
        active: Number(doc.id) === activeId
      });
    }
    return profile.sort((left, right) => left.documentId - right.documentId);
  };
  const normalizeDocumentProfile = (profile) => profile
      .map((entry) => ({ documentId: entry.documentId, revision: entry.revision, stateToken: entry.stateToken, modified: entry.modified === true, saved: entry.saved === true, active: entry.active === true }))
      .sort((left, right) => left.documentId - right.documentId);
  const normalizeDocumentMetadata = (profile) => profile
      .map((entry) => ({ documentId: entry.documentId, revision: entry.revision, modified: entry.modified === true, saved: entry.saved === true }))
      .sort((left, right) => left.documentId - right.documentId);
  const documentProfilesEqual = (left, right) =>
    JSON.stringify(normalizeDocumentProfile(left)) === JSON.stringify(normalizeDocumentProfile(right));
  const assertFocusOnlyTransition = (expected, actual, code, message) => {
    if (JSON.stringify(normalizeDocumentMetadata(expected)) !== JSON.stringify(normalizeDocumentMetadata(actual))) {
      const error = new Error(message); error.code = code; throw error;
    }
  };
  const assertDocumentProfile = (expected, actual, code, message) => {
    if (!documentProfilesEqual(expected, actual)) {
      const error = new Error(message); error.code = code; throw error;
    }
  };
  const captureStableDocumentProfile = async (code, message, deadline) => {
    let previous = null;
    while (Date.now() < deadline) {
      let current;
      try { current = captureDocumentProfile(); }
      catch (_) { previous = null; await new Promise((resolve) => setTimeout(resolve, 50)); continue; }
      if (previous && documentProfilesEqual(previous, current)) return current;
      previous = current;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const error = new Error(message); error.code = code; throw error;
  };
  const bringDocumentToFront = async (doc, code) => {
    const windows = doc && doc.layoutWindows;
    const layoutWindow = windows && windows.length > 0 ? windows.item(0) : null;
    if (!layoutWindow || layoutWindow.isValid === false || typeof layoutWindow.bringToFront !== "function") {
      const error = new Error("Aucune fenêtre de mise en page ne permet de vérifier le changement de focus"); error.code = code; throw error;
    }
    await Promise.resolve(layoutWindow.bringToFront());
    const deadline = Date.now() + 2000;
    while ((!app.activeDocument || Number(app.activeDocument.id) !== Number(doc.id)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!app.activeDocument || Number(app.activeDocument.id) !== Number(doc.id)) {
      const error = new Error("Le changement de document actif n’a pas été confirmé"); error.code = code; throw error;
    }
  };
`;

const DOCUMENT_AUDIT_FUNCTIONS = `function auditCollectionItem(collection, index) {
  return collection && typeof collection.item === "function" ? collection.item(index) : collection[index];
}
function auditNumericArray(value) {
  if (!value || typeof value.length !== "number") return [];
  const output = [];
  for (let index = 0; index < value.length; index += 1) output.push(Number(value[index]));
  return output;
}
function auditItemType(item) {
  try { return item.constructorName || (item.constructor && item.constructor.name) || "PageItem"; }
  catch (_) { return "PageItem"; }
}
function auditNamedReference(value) {
  try {
    if (!value || value.isValid === false) return null;
    return { id: Number.isFinite(Number(value.id)) ? Number(value.id) : null, name: typeof value.name === "string" ? value.name : String(value.name || "") };
  } catch (_) { return null; }
}
function auditEnumSummary(value, enumeration) {
  let numeric = null;
  let name = "";
  try { if (Number.isFinite(Number(value))) numeric = Number(value); } catch (_) {}
  try { name = String(value); } catch (_) {}
  if (enumeration && typeof enumeration === "object") {
    try {
      const keys = Object.keys(enumeration);
      for (let index = 0; index < keys.length; index += 1) {
        if (enumeration[keys[index]] === value || Number(enumeration[keys[index]]) === numeric) { name = keys[index]; break; }
      }
    } catch (_) {}
  }
  return { value: numeric, name };
}
function auditPageItemSummary(item) {
  let pageId = null;
  let layerName = null;
  try { pageId = item.parentPage && item.parentPage.isValid !== false ? Number(item.parentPage.id) : null; } catch (_) {}
  try { layerName = item.itemLayer && item.itemLayer.isValid !== false ? String(item.itemLayer.name) : null; } catch (_) {}
  return {
    id: Number(item.id), type: auditItemType(item), name: typeof item.name === "string" ? item.name : "",
    pageId, layerName, bounds: auditNumericArray(item.geometricBounds), locked: Boolean(item.locked),
    visible: item.visible !== false, nonprinting: Boolean(item.nonprinting)
  };
}
function auditStyleSummary(style, kind) {
  const output = { id: Number.isFinite(Number(style.id)) ? Number(style.id) : null, name: typeof style.name === "string" ? style.name : "", basedOn: null };
  try { output.basedOn = auditNamedReference(style.basedOn); } catch (_) {}
  if (kind === "paragraph" || kind === "character") {
    try { output.fontFamily = style.appliedFont && (style.appliedFont.fontFamily || style.appliedFont.name) || null; } catch (_) { output.fontFamily = null; }
    try { output.fontStyle = style.fontStyle || null; } catch (_) { output.fontStyle = null; }
    try { output.pointSize = Number.isFinite(Number(style.pointSize)) ? Number(style.pointSize) : null; } catch (_) { output.pointSize = null; }
    try { output.leading = Number.isFinite(Number(style.leading)) ? Number(style.leading) : null; } catch (_) { output.leading = null; }
    try { output.fillColor = auditNamedReference(style.fillColor); } catch (_) { output.fillColor = null; }
    try { output.justification = auditEnumSummary(style.justification); } catch (_) { output.justification = { value: null, name: "" }; }
    try { output.tracking = Number.isFinite(Number(style.tracking)) ? Number(style.tracking) : null; } catch (_) { output.tracking = null; }
  } else if (kind === "object") {
    try { output.fillColor = auditNamedReference(style.fillColor); } catch (_) { output.fillColor = null; }
    try { output.strokeColor = auditNamedReference(style.strokeColor); } catch (_) { output.strokeColor = null; }
    try { output.strokeWeight = Number.isFinite(Number(style.strokeWeight)) ? Number(style.strokeWeight) : null; } catch (_) { output.strokeWeight = null; }
    try { output.textWrapMode = auditEnumSummary(style.textWrapPreferences.textWrapMode); } catch (_) { output.textWrapMode = { value: null, name: "" }; }
  }
  return output;
}
function auditCollectionSummary(collection, mapper) {
  const output = [];
  if (!collection) return output;
  for (let index = 0; index < collection.length; index += 1) {
    try { output.push(mapper(auditCollectionItem(collection, index), index)); } catch (_) {}
  }
  return output;
}
async function auditNativePath(doc) {
  let documentName = null;
  try {
    const value = await doc.name;
    documentName = typeof value === "string" ? value : null;
  } catch (_) {}
  for (const property of ["fullName", "filePath"]) {
    let fileLike = null;
    try { fileLike = await doc[property]; } catch (_) { continue; }
    if (!fileLike) continue;
    const candidates = [];
    if (typeof fileLike === "string") candidates.push(fileLike);
    else {
      for (const field of ["nativePath", "fsName", "url"]) {
        try { candidates.push(await fileLike[field]); } catch (_) {}
      }
      try { candidates.push(String(fileLike)); } catch (_) {}
    }
    for (let candidate of candidates) {
      if (typeof candidate !== "string") continue;
      candidate = candidate.trim();
      if (!candidate || candidate === "[object Object]" || candidate === "[object Promise]" || candidate.includes(String.fromCharCode(0))) continue;
      if (property === "filePath" && documentName) {
        const normalized = candidate.replaceAll(String.fromCharCode(92), "/");
        const last = normalized.slice(normalized.lastIndexOf("/") + 1);
        if (last.toLowerCase() !== documentName.toLowerCase()) {
          const separator = candidate.includes(String.fromCharCode(92)) ? String.fromCharCode(92) : "/";
          while (candidate.endsWith("/") || candidate.endsWith(String.fromCharCode(92))) candidate = candidate.slice(0, -1);
          candidate = candidate + separator + documentName;
        }
      }
      return candidate;
    }
  }
  return null;
}`;

function layoutSnapshotFromAudit(audit) {
  const images = (audit.images ?? []).map((image) => ({
    ...image,
    link: image.link ? { id: image.link.id, name: image.link.name } : null,
  }));
  return {
    success: true,
    documentId: audit.documentId,
    revision: audit.revision,
    capturedAt: audit.capturedAt,
    document: audit.document,
    pages: audit.pages ?? [],
    items: audit.items ?? [],
    links: audit.links ?? [],
    fonts: audit.fonts ?? [],
    images,
    designSystem: audit.designSystem ?? { layers: [], swatches: [], paragraphStyles: [], characterStyles: [], objectStyles: [] },
    totalItems: audit.totalItems ?? 0,
    truncated: audit.truncated === true,
  };
}

function syncUxpEnvelope(body) {
  return `const indesign = require("indesign");\nconst { app } = indesign;\nconst { script } = require("uxp");\n${DOCUMENT_STATE_FUNCTION}\ntry {\n${body}\n} catch (error) {\n  script.setResult(JSON.stringify({ ok: false, code: error.code || "UXP_ERROR", message: String(error.message || error), requiresInspection: Boolean(error.requiresInspection) }));\n}`;
}

function asyncUxpEnvelope({ body, resultPath, maxResultBytes, operationId }) {
  return `const indesign = require("indesign");
const { app } = indesign;
const uxp = require("uxp");
const fs = require("fs");
${DOCUMENT_STATE_FUNCTION}
const __resultPath = ${jsonLiteral(uxpPath(resultPath))};
const __operationId = ${jsonLiteral(operationId)};
async function __writeResult(value) {
  let serialized;
  try { serialized = JSON.stringify(value); }
  catch (error) { serialized = JSON.stringify({ ok: false, code: "RESULT_NOT_SERIALIZABLE", message: String(error.message || error), operationId: __operationId, requiresInspection: true }); }
  let byteLength = 0;
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index);
    if (code < 128) byteLength += 1;
    else if (code < 2048) byteLength += 2;
    else if (code >= 55296 && code <= 56319 && index + 1 < serialized.length && serialized.charCodeAt(index + 1) >= 56320 && serialized.charCodeAt(index + 1) <= 57343) { byteLength += 4; index += 1; }
    else byteLength += 3;
  }
  if (byteLength > ${maxResultBytes}) serialized = JSON.stringify({ ok: false, code: "RESULT_TOO_LARGE_AFTER_MUTATION", message: "Le résultat dépasse la limite MCP; relisez le document.", operationId: __operationId, requiresInspection: true });
  await fs.writeFile(__resultPath, serialized, { encoding: "utf8" });
}
try {
${body}
} catch (error) {
  await __writeResult({ ok: false, code: error.code || "UXP_ERROR", message: String(error.message || error), operationId: __operationId, requiresInspection: Boolean(error.requiresInspection) });
}`;
}

export class InDesignSilentBridge {
  constructor({
    backupDirectory,
    runtimeRoot,
    timeoutMs = 30_000,
    maxResultBytes = 4_194_304,
    run = execFileAsync,
    protect = applyWindowsPrivateAcl,
    operationMutexFactory = acquireWindowsNamedMutexGuard,
    guardedRun,
    hostProcessSnapshot = captureWindowsInDesignProcesses,
  } = {}) {
    if (!path.isAbsolute(backupDirectory ?? '')) throw new Error('backupDirectory absolu requis.');
    if (runtimeRoot !== undefined && !path.isAbsolute(runtimeRoot)) throw new Error('runtimeRoot absolu requis.');
    this.backupDirectory = backupDirectory;
    this.runtimeRoot = runtimeRoot ?? path.join(backupDirectory, '.silent-runtime');
    this.mutationLeasePath = path.join(this.runtimeRoot, '.mutation-lease.json');
    this.mutexOperationDirectory = path.join(this.runtimeRoot, '.mutex-operations');
    this.sessionId = crypto.randomUUID();
    this.runtimeDirectory = path.join(this.runtimeRoot, this.sessionId);
    this.timeoutMs = timeoutMs;
    this.maxResultBytes = maxResultBytes;
    this.run = run;
    this.protect = protect;
    this.operationMutexFactory = operationMutexFactory;
    this.guardedRun = guardedRun;
    this.hostProcessSnapshot = hostProcessSnapshot;
    this.mutationContext = new AsyncLocalStorage();
    this.externalLeaseContext = new AsyncLocalStorage();
    this.pendingOperations = new Map();
    this.operationMutexGuards = new Map();
    this.mutexRecoveryOperations = new Map();
    this.releasingMutexOperations = new Set();
    this.reconciliationRunScript = undefined;
    this.reconciliationActive = false;
    this.closed = false;
  }

  async initialize() {
    await fs.mkdir(this.runtimeRoot, { recursive: true });
    await this.protect(this.runtimeRoot, { kind: 'directory', recursive: true });
    await this.#cleanupStaleRuntimeSessions();
    await fs.mkdir(this.mutexOperationDirectory, { recursive: true });
    await this.protect(this.mutexOperationDirectory, { kind: 'directory', recursive: true });
    await fs.mkdir(this.runtimeDirectory, { recursive: false });
    await this.protect(this.runtimeDirectory, { kind: 'directory', recursive: true });
    // Ne jamais lancer de watcher de récupération à l'initialisation : plusieurs
    // tâches Codex partagent ce runtime. La reprise reste explicite et bornée à
    // operationStatus/reconcileUnknownOperation.
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const hasUnresolvedOperations = this.pendingOperations.size > 0;
    this.pendingOperations.clear();
    const retainedEntries = await fs.readdir(this.runtimeDirectory).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    if (!hasUnresolvedOperations && retainedEntries.length === 0) {
      await fs.rm(this.runtimeDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }

  async operationStatus(operationId) {
    const operation = this.pendingOperations.get(operationId) ?? await this.#findRetainedOperation(operationId);
    let reconciliation = await this.#findReconciliationRecord(operationId);
    if (reconciliation?.releaseState === 'prepared') {
      reconciliation = await this.#promotePreparedReconciliation(reconciliation);
    }
    if (reconciliation && await this.#reconciliationIsConfirmed(reconciliation)) {
      const state = operation ? await this.#readResult(operation.resultPath) : { pending: true };
      const requiresInspection = typeof reconciliation.requiresInspection === 'boolean'
        ? reconciliation.requiresInspection
        : reconciliation.status === 'reconciled-unknown'
          || state.pending
          || state.result?.requiresInspection === true;
      return {
        ok: true,
        operationId,
        status: reconciliation.status,
        ...(!state.pending ? { outcome: state.result } : {}),
        reconciledAt: reconciliation.reconciledAt,
        ...(reconciliation.releaseConfirmedAt ? { releaseConfirmedAt: reconciliation.releaseConfirmedAt } : {}),
        backupIds: reconciliation.backupIds,
        retainedUntil: reconciliation.retainedUntil,
        requiresInspection,
        requiresReconciliation: false,
      };
    }
    if (reconciliation?.releaseState === 'prepared') {
      return {
        ok: true,
        operationId,
        status: 'reconciliation-release-pending',
        reconciledAt: reconciliation.reconciledAt,
        retainedUntil: reconciliation.retainedUntil,
        requiresInspection: true,
        requiresReconciliation: true,
      };
    }
    if (!operation) {
      const lease = await this.#readMutationLease();
      if (lease?.operationId === operationId) {
        return { ok: true, operationId, status: 'pending', leaseKind: lease.kind, requiresInspection: true, requiresReconciliation: true };
      }
      return { ok: true, operationId, status: 'not-found', requiresInspection: true, requiresReconciliation: false };
    }
    const state = await this.#readResult(operation.resultPath);
    if (state.pending) return { ok: true, operationId, status: 'pending', launchedAt: operation.launchedAt, requiresInspection: true, requiresReconciliation: true };
    if (state.result?.requiresInspection === true) {
      return { ok: true, operationId, status: 'completed-requires-reconciliation', outcome: state.result, retainedUntil: operation.retainedUntil, requiresInspection: true, requiresReconciliation: true };
    }
    await this.#releaseMutationLease(operationId);
    return { ok: true, operationId, status: 'completed', outcome: state.result, retainedUntil: operation.retainedUntil, requiresInspection: false, requiresReconciliation: false };
  }

  async reconcileUnknownOperation(input, { runScript } = {}) {
    if (runScript !== undefined && typeof runScript !== 'function') {
      const error = new Error('Le canal privé de réconciliation est invalide.');
      error.code = 'RECONCILIATION_RUNNER_INVALID';
      throw error;
    }
    if (this.reconciliationActive) {
      const error = new Error('Une réconciliation InDesign est déjà active.');
      error.code = 'RECONCILIATION_ALREADY_ACTIVE';
      error.requiresInspection = true;
      throw error;
    }
    const operationId = input?.operationId;
    const claimPath = await this.#claimReconciliation(operationId);
    this.reconciliationActive = true;
    this.reconciliationRunScript = runScript;
    try {
      // Verrou externe orphelin (canal plugin d’un serveur disparu) : sans exécuteur plugin, les scripts de
      // réconciliation passent par le lanceur en présentant l’identifiant du verrou, seul moyen qu’il les accepte.
      const lease = runScript ? null : await this.#readMutationLease();
      if (lease?.kind === "external" && lease.operationId === operationId) {
        return await this.externalLeaseContext.run({ operationId }, () => this.#reconcileUnknownOperation(input));
      }
      return await this.#reconcileUnknownOperation(input);
    } finally {
      this.reconciliationRunScript = undefined;
      this.reconciliationActive = false;
      await fs.rm(claimPath, { force: true }).catch(() => {});
    }
  }

  async #claimReconciliation(operationId) {
    if (!UUID_PATTERN.test(operationId ?? '')) {
      const error = new Error('Identifiant d’opération silencieuse invalide.');
      error.code = 'OPERATION_ID_INVALID';
      throw error;
    }
    const claimPath = path.join(this.mutexOperationDirectory, `${operationId}.reconciliation.claim.json`);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await fs.open(claimPath, 'wx', 0o600);
        try {
          await handle.writeFile(JSON.stringify({ schemaVersion: 1, operationId, sessionId: this.sessionId, processId: process.pid, claimedAt: new Date().toISOString() }), 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        await this.protect(claimPath, { kind: 'file' });
        return claimPath;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const stat = await fs.lstat(claimPath).catch(() => null);
        if (!stat?.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 4096) {
          const invalid = new Error('La réservation inter-processus de réconciliation est invalide.');
          invalid.code = 'RECONCILIATION_CLAIM_INVALID';
          invalid.requiresInspection = true;
          throw invalid;
        }
        let claim;
        try { claim = JSON.parse(await fs.readFile(claimPath, 'utf8')); } catch {}
        if (claim?.schemaVersion !== 1 || claim.operationId !== operationId || !Number.isInteger(claim.processId) || claim.processId <= 0) {
          const invalid = new Error('La réservation inter-processus de réconciliation est illisible.');
          invalid.code = 'RECONCILIATION_CLAIM_INVALID';
          invalid.requiresInspection = true;
          throw invalid;
        }
        let ownerAlive = true;
        try { process.kill(claim.processId, 0); } catch (cause) { ownerAlive = cause?.code !== 'ESRCH'; }
        if (ownerAlive) {
          const busy = new Error('Une autre tâche réconcilie déjà cette opération InDesign.');
          busy.code = 'RECONCILIATION_ALREADY_ACTIVE_CROSS_PROCESS';
          busy.operationId = operationId;
          busy.requiresInspection = true;
          throw busy;
        }
        const stalePath = `${claimPath}.${crypto.randomUUID()}.stale`;
        try { await fs.rename(claimPath, stalePath); } catch (renameError) {
          if (renameError.code === 'ENOENT') continue;
          throw renameError;
        }
        await fs.rm(stalePath, { force: true }).catch(() => {});
      }
    }
    const busy = new Error('La réservation inter-processus de réconciliation n’a pas pu être acquise.');
    busy.code = 'RECONCILIATION_ALREADY_ACTIVE_CROSS_PROCESS';
    busy.operationId = operationId;
    busy.requiresInspection = true;
    throw busy;
  }

  async #reconcileUnknownOperation({ operationId, reason }) {
    if (!UUID_PATTERN.test(operationId ?? '')) {
      const error = new Error('Identifiant d’opération silencieuse invalide.');
      error.code = 'OPERATION_ID_INVALID';
      throw error;
    }
    if (typeof reason !== 'string' || reason.trim().length < 8 || reason.length > 500) {
      const error = new Error('Un motif de réconciliation explicite est requis.');
      error.code = 'RECONCILIATION_REASON_REQUIRED';
      throw error;
    }

    let preparedReconciliation = await this.#findReconciliationRecord(operationId);
    if (preparedReconciliation?.releaseState === 'prepared') {
      preparedReconciliation = await this.#promotePreparedReconciliation(preparedReconciliation);
      if (preparedReconciliation.releaseState === 'confirmed') {
        const retainedOperation = await this.#findRetainedOperation(operationId);
        const retainedState = retainedOperation ? await this.#readResult(retainedOperation.resultPath) : { pending: true };
        return {
          ok: true,
          operationId,
          status: preparedReconciliation.status,
          ...(!retainedState.pending ? { outcome: retainedState.result } : {}),
          snapshots: preparedReconciliation.snapshots,
          safetyBackups: [],
          backupIds: preparedReconciliation.backupIds,
          reconciledAt: preparedReconciliation.reconciledAt,
          releaseConfirmedAt: preparedReconciliation.releaseConfirmedAt,
          requiresInspection: preparedReconciliation.requiresInspection ?? true,
          requiresReconciliation: false,
        };
      }
      const preparedLease = await this.#readMutationLease();
      if (!preparedLease || preparedLease.operationId !== operationId) {
        const error = new Error('La libération de l’opération réconciliée ne peut pas encore être prouvée.');
        error.code = 'RECONCILIATION_RELEASE_PENDING';
        error.operationId = operationId;
        error.requiresInspection = true;
        throw error;
      }
    }

    const lease = await this.#readMutationLease();
    if (!lease || lease.operationId !== operationId) {
      const error = new Error('Le verrou à réconcilier est absent ou a changé.');
      error.code = 'RECONCILIATION_LEASE_MISMATCH';
      error.requiresInspection = true;
      throw error;
    }
    const silentLease = lease.kind === 'silent';
    if (silentLease && (!UUID_PATTERN.test(lease.sessionId ?? '') || lease.sessionId === this.sessionId)) {
      const error = new Error('Seule une opération issue d’une session interrompue peut être réconciliée.');
      error.code = 'RECONCILIATION_NOT_CRASHED';
      error.operationId = operationId;
      error.requiresInspection = true;
      throw error;
    }
    if (silentLease) {
      await this.#recoverSilentOperationGuard(operationId);
      this.reconciliationRunScript = (options) => this.#runThroughSilentOperationGuard(operationId, options);
    }
    const retained = await this.#findRetainedOperation(operationId);
    // Sans preuve (session coupée entre la pose du verrou et l'envoi du script), seul un redémarrage complet
    // d'InDesign postérieur au verrou garantit qu'aucun script de l'opération ne peut encore s'exécuter.
    if (silentLease && !retained && !await this.#inDesignRestartedSince(lease.createdAt)) {
      const error = new Error('Les preuves privées de l’opération interrompue sont introuvables. Fermez complètement puis relancez InDesign avant de réconcilier.');
      error.code = 'RECONCILIATION_EVIDENCE_MISSING';
      error.operationId = operationId;
      error.requiresInspection = true;
      throw error;
    }
    const initialResult = retained ? await this.#readResult(retained.resultPath) : { pending: true };
    if (!initialResult.pending && initialResult.result?.requiresInspection !== true) {
      if (!await this.#releaseMutationLease(operationId)) {
        const error = new Error('Le verrou n’a pas pu être libéré après la confirmation du résultat.');
        error.code = 'RECONCILIATION_RELEASE_FAILED';
        error.operationId = operationId;
        error.requiresInspection = true;
        throw error;
      }
      return { ok: true, operationId, status: 'completed', outcome: initialResult.result, safetyBackups: [], snapshots: [], requiresInspection: false, requiresReconciliation: false };
    }

    if (silentLease && initialResult.pending) {
      await this.#assertInDesignHostRestarted(operationId);
    }

    const initialStatus = await this.status();
    if (initialStatus.modalState) {
      const error = new Error('InDesign est encore modal; la réconciliation reste bloquée.');
      error.code = 'RECONCILIATION_HOST_BUSY';
      error.operationId = operationId;
      error.requiresInspection = true;
      throw error;
    }
    const firstSnapshots = await this.#snapshotAllDocuments();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const secondSnapshots = await this.#snapshotAllDocuments();
    this.#assertStableSnapshots(firstSnapshots, secondSnapshots, 'Les documents ne sont pas stables pendant la réconciliation.');
    const safetyBackups = await this.#backupDocuments(secondSnapshots);
    const finalSnapshots = await this.#snapshotAllDocuments();
    this.#assertStableSnapshots(secondSnapshots, finalSnapshots, 'Les documents ont changé après les sauvegardes de réconciliation.');
    const finalStatus = await this.status();
    if (finalStatus.modalState) {
      const error = new Error('InDesign est redevenu modal pendant la réconciliation.');
      error.code = 'RECONCILIATION_HOST_BUSY';
      error.operationId = operationId;
      error.safetyBackups = safetyBackups;
      error.requiresInspection = true;
      throw error;
    }

    let finalResult = retained ? await this.#readResult(retained.resultPath) : { pending: true };
    const currentLease = await this.#readMutationLease();
    if (!currentLease || currentLease.operationId !== operationId || currentLease.sessionId !== lease.sessionId) {
      const error = new Error('Le verrou a changé pendant la réconciliation.');
      error.code = 'RECONCILIATION_LEASE_MISMATCH';
      error.operationId = operationId;
      error.safetyBackups = safetyBackups;
      error.requiresInspection = true;
      throw error;
    }

    let quarantinedScriptPath;
    if (finalResult.pending && retained) {
      const scriptStat = await fs.lstat(retained.scriptPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (scriptStat) {
        if (!scriptStat.isFile() || scriptStat.isSymbolicLink()) {
          const error = new Error('Le script privé à neutraliser est invalide.');
          error.code = 'RECONCILIATION_EVIDENCE_INVALID';
          error.operationId = operationId;
          error.safetyBackups = safetyBackups;
          error.requiresInspection = true;
          throw error;
        }
        quarantinedScriptPath = retained.quarantinedScriptPath;
        const quarantinedStat = await fs.lstat(quarantinedScriptPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
        if (quarantinedStat) {
          if (!quarantinedStat.isFile() || quarantinedStat.isSymbolicLink()) {
            const error = new Error('La quarantaine du script privé est invalide.');
            error.code = 'RECONCILIATION_EVIDENCE_INVALID';
            error.operationId = operationId;
            error.safetyBackups = safetyBackups;
            error.requiresInspection = true;
            throw error;
          }
          await fs.unlink(retained.scriptPath);
        } else {
          await fs.rename(retained.scriptPath, quarantinedScriptPath);
        }
        await this.protect(quarantinedScriptPath, { kind: 'file' });
      } else {
        const quarantinedStat = await fs.lstat(retained.quarantinedScriptPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
        if (!quarantinedStat?.isFile() || quarantinedStat.isSymbolicLink()) {
          const error = new Error('Le script privé interrompu ne peut pas être neutralisé.');
          error.code = 'RECONCILIATION_EVIDENCE_MISSING';
          error.operationId = operationId;
          error.safetyBackups = safetyBackups;
          error.requiresInspection = true;
          throw error;
        }
        quarantinedScriptPath = retained.quarantinedScriptPath;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
    const settledStatus = await this.status();
    if (settledStatus.modalState) {
      const error = new Error('InDesign est redevenu modal après la neutralisation de l’opération.');
      error.code = 'RECONCILIATION_HOST_BUSY';
      error.operationId = operationId;
      error.safetyBackups = safetyBackups;
      error.requiresInspection = true;
      throw error;
    }
    const settledSnapshots = await this.#snapshotAllDocuments();
    this.#assertStableSnapshots(finalSnapshots, settledSnapshots, 'Les documents ont changé après la neutralisation de l’opération.');
    finalResult = retained ? await this.#readResult(retained.resultPath) : { pending: true };

    const reconciledAt = new Date().toISOString();
    const reconciliationDirectory = retained ? path.dirname(retained.resultPath) : this.runtimeDirectory;
    const reconciliationPath = path.join(reconciliationDirectory, `${operationId}.${crypto.randomUUID()}.reconciliation.json`);
    const reconciliationRecord = {
      schemaVersion: 1,
      operationId,
      leaseKind: lease.kind,
      reconciledAt,
      status: finalResult.pending ? 'reconciled-unknown' : 'completed-during-reconciliation',
      releaseState: 'prepared',
      requiresInspection: finalResult.pending || finalResult.result?.requiresInspection === true,
      reasonSha256: crypto.createHash('sha256').update(reason.trim(), 'utf8').digest('hex'),
      snapshots: settledSnapshots,
      backupIds: safetyBackups.map((backup) => backup.backupId),
      quarantinedScript: quarantinedScriptPath ? path.basename(quarantinedScriptPath) : null,
    };
    await this.#writeAtomicPrivateJson(reconciliationPath, reconciliationRecord);
    if (!await this.#releaseMutationLease(operationId)) {
      const error = new Error('Le verrou n’a pas pu être libéré après réconciliation.');
      error.code = 'RECONCILIATION_RELEASE_FAILED';
      error.operationId = operationId;
      error.safetyBackups = safetyBackups;
      error.requiresInspection = true;
      throw error;
    }
    const releaseConfirmedAt = new Date().toISOString();
    const confirmedReconciliationRecord = {
      ...reconciliationRecord,
      releaseState: 'confirmed',
      releaseConfirmedAt,
    };
    await this.#writeAtomicPrivateJson(reconciliationPath, confirmedReconciliationRecord);
    return {
      ok: true,
      operationId,
      status: confirmedReconciliationRecord.status,
      outcome: finalResult.pending ? undefined : finalResult.result,
      snapshots: settledSnapshots,
      safetyBackups,
      reconciledAt,
      releaseConfirmedAt,
      requiresInspection: confirmedReconciliationRecord.requiresInspection,
      requiresReconciliation: false,
    };
  }

  async acquireExternalMutationLease(operationId) {
    if (!UUID_PATTERN.test(operationId ?? '')) throw new Error('Identifiant de verrou inter-processus invalide.');
    await this.#acquireMutationLease(operationId, { kind: 'external' });
  }

  async withSilentMutationLease(operationId, callback) {
    if (!UUID_PATTERN.test(operationId ?? '') || typeof callback !== 'function') {
      const error = new Error('Le contexte du lease silencieux est invalide.');
      error.code = 'SILENT_LEASE_CONTEXT_INVALID';
      throw error;
    }
    const active = this.mutationContext.getStore();
    if (active) {
      if (active.operationId !== operationId) {
        const error = new Error('Une autre opération silencieuse est déjà active dans ce contexte.');
        error.code = 'SILENT_LEASE_CONTEXT_MISMATCH';
        error.operationId = active.operationId;
        error.requiresInspection = true;
        throw error;
      }
      return callback();
    }
    return this.#withMutationGuard(operationId, callback);
  }

  async withExpectedExternalLease(operationId, callback) {
    if (!UUID_PATTERN.test(operationId ?? '') || typeof callback !== 'function') {
      const error = new Error('Le contexte du lease externe est invalide.');
      error.code = 'EXTERNAL_LEASE_CONTEXT_INVALID';
      throw error;
    }
    const lease = await this.#readMutationLease();
    if (!lease || lease.operationId !== operationId || lease.kind !== 'external') {
      const error = new Error('Le lease externe attendu est absent ou ne correspond pas à cette opération.');
      error.code = 'EXTERNAL_LEASE_CONTEXT_MISMATCH';
      error.operationId = operationId;
      error.requiresInspection = true;
      throw error;
    }
    return this.externalLeaseContext.run({ operationId }, callback);
  }

  async releaseExternalMutationLease(operationId) {
    if (!UUID_PATTERN.test(operationId ?? '')) return false;
    return this.#releaseMutationLease(operationId);
  }

  async transferExternalMutationLease(currentOperationId, nextOperationId) {
    if (!UUID_PATTERN.test(currentOperationId ?? '') || !UUID_PATTERN.test(nextOperationId ?? '')) {
      throw new Error('Identifiant de transfert du verrou inter-processus invalide.');
    }
    const existing = await this.#readMutationLease();
    if (!existing || existing.operationId !== currentOperationId) throw new Error('Le verrou inter-processus a changé avant son transfert.');
    if (existing.kind !== 'external') throw new Error('Seul un verrou externe peut être transféré au canal plugin.');
    await this.#writeAtomicPrivateJson(this.mutationLeasePath, { ...existing, operationId: nextOperationId, transferredAt: new Date().toISOString() });
  }

  async #writeAtomicPrivateJson(targetPath, value) {
    const stagedPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(stagedPath, JSON.stringify(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await this.protect(stagedPath, { kind: 'file' });
      await fs.rename(stagedPath, targetPath);
      await this.protect(targetPath, { kind: 'file' });
    } finally {
      await fs.rm(stagedPath, { force: true }).catch(() => {});
    }
  }

  async #readMutationLease() {
    const stat = await fs.lstat(this.mutationLeasePath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) {
      const error = new Error('Le verrou inter-processus InDesign est invalide.');
      error.code = 'MUTATION_LEASE_INVALID';
      error.requiresInspection = true;
      throw error;
    }
    let lease;
    try { lease = JSON.parse(await fs.readFile(this.mutationLeasePath, 'utf8')); }
    catch {
      const error = new Error('Le verrou inter-processus InDesign est illisible.');
      error.code = 'MUTATION_LEASE_INVALID';
      error.requiresInspection = true;
      throw error;
    }
    if (!UUID_PATTERN.test(lease?.operationId ?? '')) {
      const error = new Error('Le verrou inter-processus InDesign ne contient pas un identifiant valide.');
      error.code = 'MUTATION_LEASE_INVALID';
      error.requiresInspection = true;
      throw error;
    }
    if (!UUID_PATTERN.test(lease?.sessionId ?? '')) {
      const error = new Error('Le verrou inter-processus InDesign ne contient pas une session valide.');
      error.code = 'MUTATION_LEASE_INVALID';
      error.requiresInspection = true;
      throw error;
    }
    if (lease.schemaVersion !== undefined && lease.schemaVersion !== 1) {
      const error = new Error('Le verrou inter-processus InDesign utilise une version inconnue.');
      error.code = 'MUTATION_LEASE_INVALID';
      error.requiresInspection = true;
      throw error;
    }
    if (lease.kind === undefined) lease.kind = 'silent';
    if (!['silent', 'external'].includes(lease.kind)) {
      const error = new Error('Le verrou inter-processus InDesign contient un type invalide.');
      error.code = 'MUTATION_LEASE_INVALID';
      error.requiresInspection = true;
      throw error;
    }
    if (lease.releaseNonce !== undefined && !RELEASE_NONCE_PATTERN.test(lease.releaseNonce)) {
      const error = new Error('Le verrou inter-processus InDesign contient un acquittement invalide.');
      error.code = 'MUTATION_LEASE_INVALID';
      error.requiresInspection = true;
      throw error;
    }
    if (lease.guardProcessId !== undefined && (!Number.isInteger(lease.guardProcessId) || lease.guardProcessId <= 0)) {
      const error = new Error('Le verrou inter-processus InDesign contient une identité de garde invalide.');
      error.code = 'MUTATION_LEASE_INVALID';
      error.requiresInspection = true;
      throw error;
    }
    if (lease.recoveryWatcherProcessId !== undefined && (!Number.isInteger(lease.recoveryWatcherProcessId) || lease.recoveryWatcherProcessId <= 0)) {
      const error = new Error('Le verrou inter-processus InDesign contient une identité de watcher invalide.');
      error.code = 'MUTATION_LEASE_INVALID';
      error.requiresInspection = true;
      throw error;
    }
    return lease;
  }

  async #readMutexOperationRecord(operationId) {
    const operationPath = this.#mutexOperationRecordPath(operationId);
    const stat = await fs.lstat(operationPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 65_536) {
      const error = new Error('La preuve privée du mutex silencieux est absente ou invalide.');
      error.code = 'MUTEX_OPERATION_RECORD_INVALID';
      error.operationId = operationId;
      error.requiresInspection = true;
      throw error;
    }
    let record;
    try { record = JSON.parse((await fs.readFile(operationPath, 'utf8')).trim().split(/\r?\n/).at(-1)); }
    catch {
      const error = new Error('La preuve privée du mutex silencieux est illisible.');
      error.code = 'MUTEX_OPERATION_RECORD_INVALID';
      error.operationId = operationId;
      error.requiresInspection = true;
      throw error;
    }
    if (record?.schemaVersion !== 1 || record.operationId !== operationId || !RELEASE_NONCE_PATTERN.test(record.releaseNonce ?? '')) {
      const error = new Error('La preuve privée du mutex silencieux ne correspond pas à l’opération.');
      error.code = 'MUTEX_OPERATION_RECORD_INVALID';
      error.operationId = operationId;
      error.requiresInspection = true;
      throw error;
    }
    await this.protect(operationPath, { kind: 'file' });
    return record;
  }

  async #assertInDesignHostRestarted(operationId) {
    const record = await this.#readMutexOperationRecord(operationId);
    const original = Array.isArray(record.hostProcessesAtDispatch) ? record.hostProcessesAtDispatch : [];
    const validOriginal = original.filter((entry) => Number.isInteger(entry?.processId) && entry.processId > 0 && typeof entry.startedAt === 'string' && !Number.isNaN(Date.parse(entry.startedAt)));
    const current = await this.hostProcessSnapshot();
    const validCurrent = Array.isArray(current)
      ? current.filter((entry) => Number.isInteger(entry?.processId) && entry.processId > 0 && typeof entry.startedAt === 'string' && !Number.isNaN(Date.parse(entry.startedAt)))
      : [];
    const identity = (entry) => `${entry.processId}|${new Date(entry.startedAt).toISOString()}`;
    const originalIdentities = new Set(validOriginal.map(identity));
    const originalStillAlive = validCurrent.some((entry) => originalIdentities.has(identity(entry)));
    // Opération jamais envoyée (aucun hôte noté) : InDesign doit avoir démarré après la pose du verrou.
    const restartedSinceLease = validOriginal.length === 0
      && await this.#inDesignRestartedSince((await this.#readMutationLease())?.createdAt);
    if ((validOriginal.length === 0 && !restartedSinceLease) || validCurrent.length === 0 || originalStillAlive) {
      const error = new Error('Le script UXP peut encore reprendre : fermez complètement InDesign, relancez-le, puis recommencez la réconciliation.');
      error.code = 'RECONCILIATION_RESTART_REQUIRED';
      error.operationId = operationId;
      error.requiresInspection = true;
      throw error;
    }
    return { original: validOriginal, current: validCurrent };
  }

  async #snapshotAllDocuments() {
    const inventory = await this.listDocuments();
    const documents = Array.isArray(inventory.documents) ? inventory.documents : [];
    const snapshots = [];
    for (const document of [...documents].sort((left, right) => left.documentId - right.documentId)) {
      const inspected = await this.inspectDocument(document.documentId);
      const snapshot = inspected?.document;
      if (!snapshot || snapshot.documentId !== document.documentId || snapshot.revision !== document.revision || !STATE_TOKEN_PATTERN.test(snapshot.stateToken ?? '')) {
        const error = new Error('L’inspection stable du document a échoué.');
        error.code = 'DOCUMENT_SNAPSHOT_INVALID';
        error.requiresInspection = true;
        throw error;
      }
      snapshots.push({ documentId: snapshot.documentId, revision: snapshot.revision, stateToken: snapshot.stateToken });
    }
    return snapshots;
  }

  #assertStableSnapshots(expected, actual, message) {
    const normalize = (snapshots) => [...snapshots]
      .sort((left, right) => left.documentId - right.documentId)
      .map(({ documentId, revision, stateToken }) => ({ documentId, revision, stateToken }));
    if (JSON.stringify(normalize(expected)) !== JSON.stringify(normalize(actual))) {
      const error = new Error(message);
      error.code = 'BACKUP_SOURCE_UNSTABLE';
      error.requiresInspection = true;
      throw error;
    }
  }

  #assertInventoryMatches(expectedDocuments, snapshots) {
    const expected = [...expectedDocuments]
      .sort((left, right) => left.documentId - right.documentId)
      .map(({ documentId, revision }) => ({ documentId, revision }));
    const actual = [...snapshots]
      .sort((left, right) => left.documentId - right.documentId)
      .map(({ documentId, revision }) => ({ documentId, revision }));
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      const error = new Error('L’inventaire InDesign a changé avant les sauvegardes.');
      error.code = 'BACKUP_SOURCE_UNSTABLE';
      error.requiresInspection = true;
      throw error;
    }
  }

  async #acquireMutationLease(operationId, { kind = 'silent' } = {}) {
    if (!['silent', 'external'].includes(kind)) throw new Error('Type de verrou inter-processus invalide.');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const handle = await fs.open(this.mutationLeasePath, 'wx', 0o600);
        const lease = {
          schemaVersion: 1,
          operationId,
          sessionId: this.sessionId,
          kind,
          createdAt: new Date().toISOString(),
          ...(kind === 'silent' ? { releaseNonce: crypto.randomBytes(32).toString('base64url') } : {}),
        };
        try {
          await handle.writeFile(JSON.stringify(lease), 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        await this.protect(this.mutationLeasePath, { kind: 'file' });
        return lease;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const stat = await fs.lstat(this.mutationLeasePath).catch(() => null);
        if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 4096) {
          const invalid = new Error('Le verrou inter-processus InDesign est invalide; aucune mutation n’est autorisée.');
          invalid.code = 'MUTATION_LEASE_INVALID';
          invalid.requiresInspection = true;
          throw invalid;
        }
        let existing;
        try { existing = JSON.parse(await fs.readFile(this.mutationLeasePath, 'utf8')); }
        catch {
          const invalid = new Error('Le verrou inter-processus InDesign est illisible; aucune mutation n’est autorisée.');
          invalid.code = 'MUTATION_LEASE_INVALID';
          invalid.requiresInspection = true;
          throw invalid;
        }
        if (!UUID_PATTERN.test(existing?.operationId ?? '')) {
          const invalid = new Error('Le verrou inter-processus InDesign ne contient pas un identifiant valide.');
          invalid.code = 'MUTATION_LEASE_INVALID';
          invalid.requiresInspection = true;
          throw invalid;
        }
        if (!UUID_PATTERN.test(existing?.sessionId ?? '') || !['silent', 'external'].includes(existing?.kind ?? 'silent')) {
          const invalid = new Error('Le verrou inter-processus InDesign ne contient pas une session ou un type valide.');
          invalid.code = 'MUTATION_LEASE_INVALID';
          invalid.requiresInspection = true;
          throw invalid;
        }
        const retained = await this.#findRetainedOperation(existing.operationId);
        if (retained) {
          let state;
          try { state = await this.#readResult(retained.resultPath); }
          catch (readError) {
            readError.operationId ??= existing.operationId;
            readError.requiresInspection = true;
            throw readError;
          }
          if (!state.pending && state.result?.requiresInspection !== true) {
            await this.#releaseMutationLease(existing.operationId);
            continue;
          }
        }
        const busy = new Error('Une autre mutation InDesign est encore active ou son issue doit être réconciliée.');
        busy.code = 'MUTATION_IN_PROGRESS';
        busy.operationId = existing.operationId;
        busy.requiresInspection = true;
        throw busy;
      }
    }
    const busy = new Error('Le verrou inter-processus InDesign n’a pas pu être acquis.');
    busy.code = 'MUTATION_IN_PROGRESS';
    busy.requiresInspection = true;
    throw busy;
  }

  async #releaseMutationLease(operationId) {
    const stat = await fs.lstat(this.mutationLeasePath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!stat) return false;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return false;
    let existing;
    try { existing = JSON.parse(await fs.readFile(this.mutationLeasePath, 'utf8')); }
    catch { return false; }
    if (existing.operationId !== operationId) return false;
    if ((existing.kind ?? 'silent') === 'silent') await this.#releaseSilentOperationGuard(operationId, existing);
    await fs.unlink(this.mutationLeasePath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    return true;
  }

  async #discardUnstartedSilentOperation(operationId) {
    const lease = await this.#readMutationLease();
    if (!lease || lease.operationId !== operationId || lease.kind !== 'silent') return false;
    const guard = this.operationMutexGuards.get(operationId);
    if (guard && !guard.exited) return false;
    await Promise.all([
      fs.rm(this.#mutexOperationRecordPath(operationId), { force: true }),
      fs.rm(this.mutationLeasePath, { force: true }),
    ]);
    return true;
  }

  #mutexOperationRecordPath(operationId) {
    if (!UUID_PATTERN.test(operationId ?? '')) return undefined;
    return path.join(this.mutexOperationDirectory, `${operationId}.jsonl`);
  }

  #mutexReleaseMarkerPath(operationId, releaseNonce) {
    if (!UUID_PATTERN.test(operationId ?? '') || !RELEASE_NONCE_PATTERN.test(releaseNonce ?? '')) return undefined;
    return path.join(this.mutexOperationDirectory, `${operationId}.${releaseNonce}.release.json`);
  }

  async #ensureSilentGuardEvidence(operationId, sourceLease) {
    let lease = sourceLease ?? await this.#readMutationLease();
    if (!lease || lease.operationId !== operationId || lease.kind !== 'silent') {
      const error = new Error('Le verrou silencieux à protéger est absent ou a changé.');
      error.code = 'MUTATION_LEASE_MISMATCH';
      error.operationId = operationId;
      error.requiresInspection = true;
      throw error;
    }
    if (!RELEASE_NONCE_PATTERN.test(lease.releaseNonce ?? '')) {
      lease = { ...lease, schemaVersion: 1, releaseNonce: crypto.randomBytes(32).toString('base64url') };
      await this.#writeAtomicPrivateJson(this.mutationLeasePath, lease);
    }
    const operationPath = this.#mutexOperationRecordPath(operationId);
    const existing = await fs.lstat(operationPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink() || existing.size <= 0 || existing.size > 65_536) {
        const error = new Error('La preuve privée du mutex silencieux est invalide.');
        error.code = 'MUTEX_OPERATION_RECORD_INVALID';
        error.operationId = operationId;
        error.requiresInspection = true;
        throw error;
      }
      let record;
      try { record = JSON.parse((await fs.readFile(operationPath, 'utf8')).trim().split(/\r?\n/).at(-1)); }
      catch {
        const error = new Error('La preuve privée du mutex silencieux est illisible.');
        error.code = 'MUTEX_OPERATION_RECORD_INVALID';
        error.operationId = operationId;
        error.requiresInspection = true;
        throw error;
      }
      if (record?.schemaVersion !== 1 || record.operationId !== operationId || record.releaseNonce !== lease.releaseNonce) {
        const error = new Error('La preuve privée du mutex silencieux ne correspond pas au lease.');
        error.code = 'MUTEX_OPERATION_RECORD_INVALID';
        error.operationId = operationId;
        error.requiresInspection = true;
        throw error;
      }
      await this.protect(operationPath, { kind: 'file' });
      return { lease, operationPath };
    }
    await this.#writeAtomicPrivateJson(operationPath, {
      schemaVersion: 1,
      operationId,
      sessionId: lease.sessionId,
      releaseNonce: lease.releaseNonce,
      status: 'unresolved',
      createdAt: lease.createdAt ?? new Date().toISOString(),
    });
    return { lease, operationPath };
  }

  async #acquireSilentOperationGuard(operationId, { expectedGuardProcessId, recovery = false } = {}) {
    const { lease, operationPath } = await this.#ensureSilentGuardEvidence(operationId);
    const acquired = await this.operationMutexFactory({
      operationPath,
      timeoutMs: 120_000,
      expectedGuardProcessId,
      recovery,
      releaseNonce: lease.releaseNonce,
    });
    if (
      !acquired
      || !Number.isInteger(acquired.processId)
      || acquired.processId <= 0
      || typeof acquired.exit?.then !== 'function'
    ) {
      const error = new Error('Le helper du mutex silencieux a renvoyé une garde invalide.');
      error.code = 'INDESIGN_MUTEX_HELPER_PROTOCOL_ERROR';
      error.operationId = operationId;
      error.requiresInspection = true;
      throw error;
    }
    const guard = { ...acquired, exited: false, releasing: false, exitState: undefined };
    this.operationMutexGuards.set(operationId, guard);
    const operationRecord = await this.#readMutexOperationRecord(operationId);
    await this.#writeAtomicPrivateJson(operationPath, {
      ...operationRecord,
      ...(acquired.status === 'watching'
        ? { recoveryWatcherProcessId: acquired.processId, recoveryWatcherAt: new Date().toISOString() }
        : { guardProcessId: acquired.processId, guardStatus: acquired.status, guardedAt: new Date().toISOString() }),
    });
    const currentLease = await this.#readMutationLease();
    if (!currentLease || currentLease.operationId !== operationId || currentLease.releaseNonce !== lease.releaseNonce) {
      const error = new Error('Le lease silencieux a changé pendant l’acquisition du mutex.');
      error.code = 'MUTATION_LEASE_MISMATCH';
      error.operationId = operationId;
      error.requiresInspection = true;
      throw error;
    }
    const { recoveryWatcherProcessId: _previousRecoveryWatcherProcessId, ...leaseWithoutWatcher } = currentLease;
    await this.#writeAtomicPrivateJson(this.mutationLeasePath, {
      ...leaseWithoutWatcher,
      guardProcessId: acquired.status === 'watching' ? expectedGuardProcessId : acquired.processId,
      ...(acquired.status === 'watching' ? { recoveryWatcherProcessId: acquired.processId } : {}),
      guardStatus: acquired.status,
      guardedAt: new Date().toISOString(),
    });
    void Promise.resolve(acquired.exit).then(
      (exitState) => this.#handleSilentOperationGuardExit(operationId, guard, exitState),
      (error) => this.#handleSilentOperationGuardExit(operationId, guard, { code: null, signal: null, error }),
    );
    return guard;
  }

  #handleSilentOperationGuardExit(operationId, guard, exitState) {
    guard.exited = true;
    guard.exitState = exitState;
    if (this.operationMutexGuards.get(operationId) === guard) this.operationMutexGuards.delete(operationId);
    // Un helper mort laisse volontairement le lease durable en place. La
    // récupération ne démarre jamais automatiquement dans plusieurs tâches.
  }

  #recoverSilentOperationGuard(operationId) {
    const active = this.operationMutexGuards.get(operationId);
    if (active && !active.exited) return Promise.resolve(active);
    const inProgress = this.mutexRecoveryOperations.get(operationId);
    if (inProgress) return inProgress;
    const recovery = (async () => {
      const lease = await this.#readMutationLease();
      if (!lease || lease.operationId !== operationId || lease.kind !== 'silent') return undefined;
      await this.#ensureSilentGuardEvidence(operationId, lease);
      if (Number.isInteger(lease.guardProcessId) && lease.guardProcessId > 0) {
        try {
          return await this.#acquireSilentOperationGuard(operationId, {
            expectedGuardProcessId: lease.guardProcessId,
            recovery: true,
          });
        } catch (error) {
          const nowActive = this.operationMutexGuards.get(operationId);
          if (nowActive && !nowActive.exited) return nowActive;
        }
      }
      if (Number.isInteger(lease.recoveryWatcherProcessId) && lease.recoveryWatcherProcessId > 0) {
        try {
          return await this.#acquireSilentOperationGuard(operationId, {
            expectedGuardProcessId: lease.recoveryWatcherProcessId,
            recovery: true,
          });
        } catch (error) {
          const nowActive = this.operationMutexGuards.get(operationId);
          if (nowActive && !nowActive.exited) return nowActive;
        }
      }
      return this.#acquireSilentOperationGuard(operationId, { recovery: true });
    })();
    this.mutexRecoveryOperations.set(operationId, recovery);
    return recovery.finally(() => {
      if (this.mutexRecoveryOperations.get(operationId) === recovery) this.mutexRecoveryOperations.delete(operationId);
    });
  }

  async #releaseSilentOperationGuard(operationId, sourceLease) {
    const { lease, operationPath } = await this.#ensureSilentGuardEvidence(operationId, sourceLease);
    this.releasingMutexOperations.add(operationId);
    try {
      const guard = this.operationMutexGuards.get(operationId) ?? await this.#recoverSilentOperationGuard(operationId);
      if (!guard || guard.exited) {
        const error = new Error('Le helper détenteur du mutex silencieux est indisponible.');
        error.code = 'INDESIGN_MUTEX_RECOVERY_FAILED';
        error.operationId = operationId;
        error.requiresInspection = true;
        throw error;
      }
      const markerPath = this.#mutexReleaseMarkerPath(operationId, lease.releaseNonce);
      guard.releasing = true;
      await this.#writeAtomicPrivateJson(markerPath, {
        schemaVersion: 1,
        operationId,
        releaseNonce: lease.releaseNonce,
        status: 'acknowledged',
        acknowledgedAt: new Date().toISOString(),
      });
      let timer;
      let exitState;
      try {
        exitState = await Promise.race([
          guard.exit,
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              const error = new Error('Le helper du mutex silencieux n’a pas confirmé son arrêt après acquittement.');
              error.code = 'OPERATION_GUARD_RELEASE_TIMEOUT';
              error.operationId = operationId;
              error.requiresInspection = true;
              reject(error);
            }, 10_000);
            timer.unref?.();
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (exitState?.code !== 0) {
        const error = new Error('Le helper du mutex silencieux ne s’est pas arrêté proprement après acquittement.');
        error.code = 'OPERATION_GUARD_RELEASE_FAILED';
        error.operationId = operationId;
        error.requiresInspection = true;
        throw error;
      }
      this.operationMutexGuards.delete(operationId);
      await Promise.all([
        fs.rm(markerPath, { force: true }),
        fs.rm(operationPath, { force: true }),
      ]);
    } finally {
      this.releasingMutexOperations.delete(operationId);
    }
  }

  #guardRequestPaths(operationId, requestId) {
    const prefix = path.join(this.mutexOperationDirectory, `${operationId}.${requestId}.reconcile`);
    return {
      request: `${prefix}-request.json`,
      processing: `${prefix}-processing.json`,
      response: `${prefix}-response.json`,
    };
  }

  async #validateGuardedScriptPaths({ scriptPath, language, completionPath }) {
    if (!['UXP', 'JAVASCRIPT'].includes(language) || typeof scriptPath !== 'string' || !path.isAbsolute(scriptPath)) {
      throw new Error('La requête privée du mutex silencieux est invalide.');
    }
    const scriptStat = await fs.lstat(scriptPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!scriptStat?.isFile() || scriptStat.isSymbolicLink()) throw new Error('Le script privé du mutex silencieux est invalide.');
    if (completionPath === undefined) return;
    if (language !== 'UXP' || typeof completionPath !== 'string' || !path.isAbsolute(completionPath)) {
      throw new Error('Le résultat privé du mutex silencieux est invalide.');
    }
    const parent = await fs.lstat(path.dirname(completionPath)).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!parent?.isDirectory() || parent.isSymbolicLink()) throw new Error('Le dossier du résultat privé du mutex silencieux est invalide.');
    const existing = await fs.lstat(completionPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (existing) throw new Error('Le résultat privé du mutex silencieux doit être absent avant l’exécution.');
  }

  async #runThroughSilentOperationGuard(operationId, options) {
    const guard = this.operationMutexGuards.get(operationId) ?? await this.#recoverSilentOperationGuard(operationId);
    if (!guard || guard.exited) {
      const error = new Error('Le helper détenteur du mutex silencieux est indisponible.');
      error.code = 'INDESIGN_MUTEX_RECOVERY_FAILED';
      error.operationId = operationId;
      error.requiresInspection = true;
      throw error;
    }
    await this.#validateGuardedScriptPaths(options);
    if (typeof this.guardedRun === 'function') return this.guardedRun({ operationId, guard, ...options });

    const requestId = crypto.randomUUID();
    const paths = this.#guardRequestPaths(operationId, requestId);
    const completionTimeoutMs = Math.max(1_000, Math.min(900_000, Number(options.completionTimeoutMs) || this.timeoutMs));
    const request = {
      schemaVersion: 1,
      operationId,
      requestId,
      scriptPath: options.scriptPath,
      language: options.language,
      completionPath: options.completionPath,
      completionTimeoutMs,
      mutationDispatch: options.mutationDispatch === true,
      createdAt: new Date().toISOString(),
    };
    const stagedPath = `${paths.request}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(stagedPath, JSON.stringify(request), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await this.protect(stagedPath, { kind: 'file' });
      await fs.rename(stagedPath, paths.request);
    } finally {
      await fs.rm(stagedPath, { force: true }).catch(() => {});
    }

    let response;
    const deadline = Date.now() + completionTimeoutMs + 10_000;
    while (Date.now() < deadline) {
      const responseStat = await fs.lstat(paths.response).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (responseStat) {
        if (!responseStat.isFile() || responseStat.isSymbolicLink() || responseStat.size <= 0 || responseStat.size > GUARDED_RESPONSE_LIMIT) {
          const error = new Error('La réponse privée du mutex silencieux est invalide.');
          error.code = 'RECONCILIATION_RESPONSE_INVALID';
          throw error;
        }
        await this.protect(paths.response, { kind: 'file' });
        try { response = JSON.parse(await fs.readFile(paths.response, 'utf8')); }
        catch {
          const error = new Error('La réponse privée du mutex silencieux est illisible.');
          error.code = 'RECONCILIATION_RESPONSE_INVALID';
          throw error;
        }
        break;
      }
      const current = this.operationMutexGuards.get(operationId);
      if (!current || current.exited) await this.#recoverSilentOperationGuard(operationId);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!response) {
      const error = new Error('La requête privée du mutex silencieux a dépassé son délai.');
      error.code = 'RECONCILIATION_REQUEST_TIMEOUT';
      error.operationId = operationId;
      error.requiresInspection = true;
      throw error;
    }
    if (response.schemaVersion !== 1 || response.operationId !== operationId || response.requestId !== requestId || typeof response.ok !== 'boolean') {
      const error = new Error('La réponse privée du mutex silencieux ne correspond pas à la requête.');
      error.code = 'RECONCILIATION_RESPONSE_INVALID';
      error.operationId = operationId;
      error.requiresInspection = true;
      throw error;
    }
    if (response.ok !== true) {
      const error = new Error('Le helper InDesign a refusé ou interrompu la requête privée du canal silencieux.');
      error.code = typeof response.code === 'string' ? response.code : 'RECONCILIATION_HELPER_FAILED';
      error.operationId = operationId;
      error.requiresInspection = true;
      throw error;
    }
    await Promise.all([
      fs.rm(paths.request, { force: true }),
      fs.rm(paths.processing, { force: true }),
      fs.rm(paths.response, { force: true }),
    ]).catch(() => {});
    return { stdout: JSON.stringify({ ok: true, result: response.result }) };
  }

  async #findReconciliationRecord(operationId) {
    if (!UUID_PATTERN.test(operationId)) return null;
    const records = [];
    const entries = await fs.readdir(this.runtimeRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
      const directory = path.join(this.runtimeRoot, entry.name);
      const directoryStat = await fs.lstat(directory).catch(() => null);
      if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) continue;
      const files = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const file of files) {
        const prefix = `${operationId}.`;
        const suffix = '.reconciliation.json';
        if (!file.name.startsWith(prefix) || !file.name.endsWith(suffix)) continue;
        const receiptId = file.name.slice(prefix.length, -suffix.length);
        if (!UUID_PATTERN.test(receiptId)) continue;
        const recordPath = path.join(directory, file.name);
        const stat = await fs.lstat(recordPath).catch(() => null);
        if (!stat?.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > RECONCILIATION_RECORD_LIMIT) {
          const error = new Error('La preuve privée de réconciliation est invalide.');
          error.code = 'RECONCILIATION_EVIDENCE_INVALID';
          error.operationId = operationId;
          error.requiresInspection = true;
          throw error;
        }
        await this.protect(recordPath, { kind: 'file' });
        let record;
        try { record = JSON.parse(await fs.readFile(recordPath, 'utf8')); }
        catch {
          const error = new Error('La preuve privée de réconciliation est illisible.');
          error.code = 'RECONCILIATION_EVIDENCE_INVALID';
          error.operationId = operationId;
          error.requiresInspection = true;
          throw error;
        }
        const validReleaseState = record?.releaseState === undefined
          || (record.releaseState === 'prepared' && record.releaseConfirmedAt === undefined)
          || (record.releaseState === 'confirmed'
            && typeof record.releaseConfirmedAt === 'string'
            && !Number.isNaN(Date.parse(record.releaseConfirmedAt)));
        if (
          record?.schemaVersion !== 1
          || record.operationId !== operationId
          || !['silent', 'external'].includes(record.leaseKind)
          || !['reconciled-unknown', 'completed-during-reconciliation'].includes(record.status)
          || typeof record.reconciledAt !== 'string'
          || Number.isNaN(Date.parse(record.reconciledAt))
          || !/^[a-f0-9]{64}$/.test(record.reasonSha256 ?? '')
          || !Array.isArray(record.snapshots)
          || !Array.isArray(record.backupIds)
          || !record.backupIds.every((backupId) => BACKUP_ID_PATTERN.test(backupId))
          || (record.requiresInspection !== undefined && typeof record.requiresInspection !== 'boolean')
          || !validReleaseState
        ) {
          const error = new Error('La preuve privée de réconciliation ne correspond pas à l’opération.');
          error.code = 'RECONCILIATION_EVIDENCE_INVALID';
          error.operationId = operationId;
          error.requiresInspection = true;
          throw error;
        }
        records.push({
          ...record,
          recordPath,
          retainedUntil: new Date(stat.mtimeMs + RUNTIME_RETENTION_MS).toISOString(),
        });
      }
    }
    records.sort((left, right) => Date.parse(left.reconciledAt) - Date.parse(right.reconciledAt));
    return records.at(-1) ?? null;
  }

  async #reconciliationIsConfirmed(record) {
    if (record.releaseState === 'confirmed') return true;
    if (record.releaseState === 'prepared') return false;

    // Les reçus créés avant l'ajout du protocole en deux phases n'ont pas de
    // releaseState. Ils ne sont terminaux que si aucun verrou résiduel ne peut
    // encore appartenir à l'opération.
    const lease = await this.#readMutationLease();
    if (lease?.operationId === record.operationId) return false;
    if (record.leaseKind === 'silent') {
      const operationPath = this.#mutexOperationRecordPath(record.operationId);
      const operationStat = await fs.lstat(operationPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (operationStat) return false;
    }
    return true;
  }

  async #promotePreparedReconciliation(record) {
    if (record?.releaseState !== 'prepared') return record;
    const operationId = record.operationId;
    const lease = await this.#readMutationLease();
    if (lease?.operationId === operationId) return record;
    if (
      this.operationMutexGuards.has(operationId)
      || this.mutexRecoveryOperations.has(operationId)
      || this.releasingMutexOperations.has(operationId)
    ) return record;

    let entries;
    try {
      entries = await fs.readdir(this.mutexOperationDirectory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') entries = [];
      else {
        error.code ??= 'RECONCILIATION_RELEASE_EVIDENCE_UNAVAILABLE';
        error.operationId = operationId;
        error.requiresInspection = true;
        throw error;
      }
    }
    const prefix = `${operationId}.`;
    const hasGuardTrace = entries.some((entry) => entry.name === `${operationId}.jsonl`
      || (entry.name.startsWith(prefix) && (
        entry.name.endsWith('.release.json')
        || entry.name.endsWith('.reconcile-request.json')
        || entry.name.endsWith('.reconcile-processing.json')
        || entry.name.endsWith('.reconcile-response.json')
      )));
    if (hasGuardTrace) return record;

    const releaseConfirmedAt = new Date().toISOString();
    const confirmed = { ...record, releaseState: 'confirmed', releaseConfirmedAt };
    const persisted = { ...confirmed };
    delete persisted.recordPath;
    delete persisted.retainedUntil;
    await this.#writeAtomicPrivateJson(record.recordPath, persisted);
    return confirmed;
  }

  async #inDesignRestartedSince(isoDate) {
    const since = Date.parse(isoDate ?? '');
    if (Number.isNaN(since)) return false;
    const hosts = await this.hostProcessSnapshot().catch(() => []);
    return hosts.length > 0 && hosts.every((host) => Date.parse(host.startedAt) > since);
  }

  async #findRetainedOperation(operationId) {
    if (!UUID_PATTERN.test(operationId)) return null;
    const entries = await fs.readdir(this.runtimeRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
      const directory = path.join(this.runtimeRoot, entry.name);
      const stat = await fs.lstat(directory).catch(() => null);
      if (!stat?.isDirectory() || stat.isSymbolicLink()) continue;
      const resultPath = path.join(directory, `${operationId}.result.json`);
      const scriptPath = path.join(directory, `${operationId}.idjs`);
      const quarantinedScriptPath = path.join(directory, `${operationId}.quarantined.idjs`);
      const [resultExists, scriptExists, quarantinedScriptExists] = await Promise.all([
        fs.lstat(resultPath).then((item) => item.isFile() && !item.isSymbolicLink()).catch(() => false),
        fs.lstat(scriptPath).then((item) => item.isFile() && !item.isSymbolicLink()).catch(() => false),
        fs.lstat(quarantinedScriptPath).then((item) => item.isFile() && !item.isSymbolicLink()).catch(() => false),
      ]);
      if (resultExists || scriptExists || quarantinedScriptExists) {
        return {
          resultPath,
          scriptPath,
          quarantinedScriptPath,
          launchedAt: stat.birthtime.toISOString(),
          retainedUntil: new Date(stat.mtimeMs + RUNTIME_RETENTION_MS).toISOString(),
        };
      }
    }
    return null;
  }

  async #cleanupStaleRuntimeSessions() {
    const entries = await fs.readdir(this.runtimeRoot, { withFileTypes: true }).catch(() => []);
    const cutoff = Date.now() - RUNTIME_RETENTION_MS;
    let leasedSessionId;
    try {
      const lease = JSON.parse(await fs.readFile(this.mutationLeasePath, 'utf8'));
      if (UUID_PATTERN.test(lease?.sessionId ?? '')) leasedSessionId = lease.sessionId;
    } catch {}
    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
      if (entry.name === leasedSessionId) continue;
      const directory = path.join(this.runtimeRoot, entry.name);
      const stat = await fs.lstat(directory).catch(() => null);
      if (stat?.isDirectory() && !stat.isSymbolicLink() && stat.mtimeMs < cutoff) {
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
  }

  async status() {
    const body = `  const uxpRuntime = require("uxp");
  const versions = { uxp: String(uxpRuntime.versions.uxp || "unknown"), plugin: String(uxpRuntime.versions.plugin || "script") };
  const host = { name: String(uxpRuntime.host.name || app.name), version: String(uxpRuntime.host.version || app.version), uiLocale: String(uxpRuntime.host.uiLocale || app.locale) };
  script.setResult(JSON.stringify({ ok: true, mode: "silent-com-uxp", application: app.name, version: String(app.version), domVersion: String(app.scriptPreferences.version), locale: String(app.locale), modalState: Boolean(app.modalState), openDocuments: app.documents.length, host, uxpVersions: versions, capabilities: { asyncCompletionFile: true, uxpEntireScriptUndo: false, stateToken: true, expandedStateCoverage: true, allDocumentBackups: true, silentOpen: true, silentStructuredAudit: true, silentPreflight: true, silentCloseWithoutSave: true, silentRestore: true, interprocessMutationLease: true, durableOperationMutex: true } }));`;
    const status = await this.#runUxpSync(syncUxpEnvelope(body));
    const restoredMarkerRefresh = status.modalState
      ? { inspected: 0, removed: 0, keptOpen: 0, skippedUnreadable: 0, deferredForModalState: true }
      : await this.refreshRestoredMarkers();
    return { ...status, restoredMarkerRefresh };
  }

  async refreshRestoredMarkers() {
    const restoredDirectory = path.join(this.backupDirectory, 'restored');
    const directoryStat = await fs.lstat(restoredDirectory).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!directoryStat) return { inspected: 0, removed: 0, keptOpen: 0, skippedUnreadable: 0 };
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      return { inspected: 0, removed: 0, keptOpen: 0, skippedUnreadable: 1 };
    }
    const entries = await fs.readdir(restoredDirectory, { withFileTypes: true });
    const markers = entries.filter((entry) => entry.isFile() && RESTORED_MARKER_PATTERN.test(entry.name));
    if (markers.length === 0) return { inspected: 0, removed: 0, keptOpen: 0, skippedUnreadable: 0 };
    const leaseStat = await fs.lstat(this.mutationLeasePath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (leaseStat) {
      return { inspected: markers.length, removed: 0, keptOpen: 0, skippedUnreadable: 0, deferredForActiveMutation: true };
    }

    const body = `${DOCUMENT_AUDIT_FUNCTIONS}
  const openPaths = [];
  let pathsReadable = true;
  for (let index = 0; index < app.documents.length; index += 1) {
    const doc = app.documents.item(index);
    try {
      const nativePath = await auditNativePath(doc);
      if (!nativePath) pathsReadable = false;
      else openPaths.push(String(nativePath));
    } catch (_) { pathsReadable = false; }
  }
  await __writeResult({ ok: true, pathsReadable, openPaths, operationId: __operationId });`;
    const hostState = await this.#runUxpRead(body);
    if (hostState.pathsReadable !== true || !Array.isArray(hostState.openPaths) || hostState.openPaths.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
      return { inspected: markers.length, removed: 0, keptOpen: 0, skippedUnreadable: markers.length };
    }
    const normalizePath = (value) => {
      try {
        const native = /^file:/i.test(value) ? fileURLToPath(value) : value;
        const normalized = path.resolve(native);
        return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
      } catch { return null; }
    };
    const normalizedOpenPaths = new Set(hostState.openPaths.map(normalizePath).filter(Boolean));
    if (normalizedOpenPaths.size !== hostState.openPaths.length) {
      return { inspected: markers.length, removed: 0, keptOpen: 0, skippedUnreadable: markers.length };
    }

    let removed = 0;
    let keptOpen = 0;
    let skippedUnreadable = 0;
    for (const entry of markers) {
      const match = entry.name.match(RESTORED_MARKER_PATTERN);
      const markerPath = path.join(restoredDirectory, entry.name);
      const stat = await fs.lstat(markerPath).catch(() => null);
      if (!match || !stat?.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > 4096) {
        skippedUnreadable += 1;
        continue;
      }
      let marker;
      try { marker = JSON.parse(await fs.readFile(markerPath, 'utf8')); }
      catch { skippedUnreadable += 1; continue; }
      const expectedWorkingFile = `restore-${match[1]}.indd`;
      if (marker?.schemaVersion !== 1 || marker.workingFile?.toLowerCase() !== expectedWorkingFile.toLowerCase()) {
        skippedUnreadable += 1;
        continue;
      }
      const workingPath = normalizePath(path.join(restoredDirectory, expectedWorkingFile));
      if (!workingPath) { skippedUnreadable += 1; continue; }
      if (normalizedOpenPaths.has(workingPath)) {
        keptOpen += 1;
        continue;
      }
      await fs.unlink(markerPath);
      removed += 1;
    }
    return { inspected: markers.length, removed, keptOpen, skippedUnreadable };
  }

  async listDocuments() {
    const body = `  const documents = [];
  for (let index = 0; index < app.documents.length; index += 1) {
    const doc = app.documents.item(index);
    const rawRevision = doc.extractLabel(${jsonLiteral(REVISION_LABEL)});
    const parsedRevision = Number.parseInt(rawRevision || "0", 10);
    documents.push({ documentId: Number(doc.id), name: String(doc.name), pages: doc.pages.length, modified: Boolean(doc.modified), revision: Number.isInteger(parsedRevision) && parsedRevision >= 0 ? parsedRevision : 0, active: Boolean(app.activeDocument && Number(app.activeDocument.id) === Number(doc.id)) });
  }
  script.setResult(JSON.stringify({ ok: true, documents }));`;
    return this.#runUxpSync(syncUxpEnvelope(body));
  }

  async inspectDocument(documentId) {
    const body = `  const wanted = ${Number(documentId)};
  let doc = null;
  for (let index = 0; index < app.documents.length; index += 1) { const candidate = app.documents.item(index); if (Number(candidate.id) === wanted) { doc = candidate; break; } }
  if (!doc) { const error = new Error("Document introuvable"); error.code = "DOCUMENT_NOT_FOUND"; throw error; }
  const rawRevision = doc.extractLabel(${jsonLiteral(REVISION_LABEL)});
  const parsedRevision = Number.parseInt(rawRevision || "0", 10);
  script.setResult(JSON.stringify({ ok: true, document: { documentId: Number(doc.id), name: String(doc.name), pages: doc.pages.length, spreads: doc.spreads.length, pageItems: doc.allPageItems.length, width: Number(doc.documentPreferences.pageWidth), height: Number(doc.documentPreferences.pageHeight), facingPages: Boolean(doc.documentPreferences.facingPages), modified: Boolean(doc.modified), saved: Boolean(doc.saved), revision: Number.isInteger(parsedRevision) && parsedRevision >= 0 ? parsedRevision : 0, stateToken: documentStateToken(doc) } }));`;
    return this.#runUxpSync(syncUxpEnvelope(body));
  }

  async auditDocument(documentId, { maxItems = 20_000, sections = ['all'] } = {}) {
    if (!Number.isInteger(documentId) || documentId < 1) {
      const error = new Error('Identifiant de document invalide pour l’audit silencieux.');
      error.code = 'DOCUMENT_ID_INVALID';
      throw error;
    }
    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 50_000) {
      const error = new Error('La limite de l’audit silencieux doit être comprise entre 1 et 50 000 objets.');
      error.code = 'AUDIT_LIMIT_INVALID';
      throw error;
    }
    const allowedSections = new Set(['all', 'document', 'pages', 'items', 'links', 'fonts', 'images', 'overset', 'designSystem']);
    if (!Array.isArray(sections) || sections.length === 0 || sections.some((entry) => !allowedSections.has(entry))) {
      const error = new Error('Les sections demandées pour l’audit silencieux sont invalides.');
      error.code = 'AUDIT_SECTIONS_INVALID';
      throw error;
    }
    const requested = new Set(sections);
    const all = requested.has('all');
    const includePages = all || requested.has('pages') || requested.has('items');
    const includeItems = all || requested.has('items');
    const includeLinks = all || requested.has('links');
    const includeFonts = all || requested.has('fonts');
    const includeImages = all || requested.has('images');
    const includeOverset = all || requested.has('overset');
    const includeDesignSystem = all || requested.has('designSystem');
    const resultBudget = Math.max(1_024, this.maxResultBytes - Math.min(16_384, Math.floor(this.maxResultBytes / 4)));

    const body = `${DOCUMENT_AUDIT_FUNCTIONS}
  const wanted = ${Number(documentId)};
  const itemLimit = ${Number(maxItems)};
  let doc = null;
  for (let index = 0; index < app.documents.length; index += 1) {
    const candidate = app.documents.item(index);
    if (candidate && candidate.isValid !== false && Number(candidate.id) === wanted) { doc = candidate; break; }
  }
  if (!doc) { const error = new Error("Document introuvable"); error.code = "DOCUMENT_NOT_FOUND"; throw error; }
  if (app.modalState) { const error = new Error("InDesign affiche une boîte de dialogue modale"); error.code = "INDESIGN_MODAL"; throw error; }
  const rawRevision = doc.extractLabel(${jsonLiteral(REVISION_LABEL)});
  const parsedRevision = Number.parseInt(rawRevision || "0", 10);
  const revision = Number.isInteger(parsedRevision) && parsedRevision >= 0 ? parsedRevision : 0;
  const stateBefore = documentStateToken(doc);
  const unitPreferences = doc.viewPreferences;
  const previousHorizontal = unitPreferences.horizontalMeasurementUnits;
  const previousVertical = unitPreferences.verticalMeasurementUnits;
  let audit;
  try {
    unitPreferences.horizontalMeasurementUnits = indesign.MeasurementUnits.millimeters;
    unitPreferences.verticalMeasurementUnits = indesign.MeasurementUnits.millimeters;
    const preferences = doc.documentPreferences;
    const pages = [];
    const pageIndexes = Object.create(null);
    if (${includePages}) {
      for (let index = 0; index < doc.pages.length; index += 1) {
        const page = auditCollectionItem(doc.pages, index);
        const bounds = auditNumericArray(page.bounds);
        pageIndexes[String(Number(page.id))] = index;
        const margins = page.marginPreferences;
        pages.push({
          id: Number(page.id), index, name: String(page.name), bounds,
          widthMm: bounds.length === 4 ? Math.abs(bounds[3] - bounds[1]) : Number(preferences.pageWidth),
          heightMm: bounds.length === 4 ? Math.abs(bounds[2] - bounds[0]) : Number(preferences.pageHeight),
          margins: { top: Number(margins.top), left: Number(margins.left), bottom: Number(margins.bottom), right: Number(margins.right) },
          columns: { count: Number(margins.columnCount), gutterMm: Number(margins.columnGutter) },
          appliedMaster: auditNamedReference(page.appliedMaster)
        });
      }
    }
    const allItems = doc.allPageItems;
    const totalItems = allItems.length;
    const inspectedItems = ${includeItems} ? Math.min(totalItems, itemLimit) : 0;
    const items = [];
    if (${includeItems}) {
      for (let index = 0; index < inspectedItems; index += 1) {
        const item = auditCollectionItem(allItems, index);
        const summary = auditPageItemSummary(item);
        summary.pageIndex = summary.pageId === null ? null : (pageIndexes[String(summary.pageId)] ?? null);
        summary.objectStyle = auditNamedReference(item.appliedObjectStyle);
        summary.widthMm = summary.bounds.length === 4 ? Math.abs(summary.bounds[3] - summary.bounds[1]) : null;
        summary.heightMm = summary.bounds.length === 4 ? Math.abs(summary.bounds[2] - summary.bounds[0]) : null;
        try { summary.overflows = Boolean(item.overflows); } catch (_) { summary.overflows = false; }
        items.push(summary);
      }
    }
    const links = ${includeLinks} ? auditCollectionSummary(doc.links, (link) => {
      let pageItemId = null;
      let pageId = null;
      try { pageItemId = Number(link.parent.parent.id); } catch (_) {}
      try { pageId = Number(link.parent.parent.parentPage.id); } catch (_) {}
      const status = auditEnumSummary(link.status, indesign.LinkStatus);
      return { id: Number(link.id), name: String(link.name || ""), path: link.filePath || null, status: status.value, statusName: status.name, pageItemId, pageId };
    }) : [];
    const fonts = ${includeFonts} ? auditCollectionSummary(doc.fonts, (font) => {
      const status = auditEnumSummary(font.status, indesign.FontStatus);
      return { name: String(font.name || ""), family: font.fontFamily || null, style: font.fontStyleName || null, status: status.value, statusName: status.name };
    }) : [];
    const images = ${includeImages} ? auditCollectionSummary(doc.allGraphics, (graphic) => {
      const frame = graphic.parent;
      let link = null;
      try {
        if (graphic.itemLink && graphic.itemLink.isValid) {
          link = { id: Number(graphic.itemLink.id), name: String(graphic.itemLink.name || ""), path: graphic.itemLink.filePath || null, status: Number(graphic.itemLink.status) };
        }
      } catch (_) {}
      let pageId = null;
      try { pageId = frame.parentPage && frame.parentPage.isValid !== false ? Number(frame.parentPage.id) : null; } catch (_) {}
      return { id: Number(graphic.id), type: auditItemType(graphic), frameId: frame && frame.isValid !== false ? Number(frame.id) : null, pageId, bounds: frame ? auditNumericArray(frame.geometricBounds) : [], actualPpi: auditNumericArray(graphic.actualPpi), effectivePpi: auditNumericArray(graphic.effectivePpi), link };
    }) : [];
    const oversetFrames = [];
    if (${includeOverset}) {
      for (let index = 0; index < doc.textFrames.length; index += 1) {
        const frame = auditCollectionItem(doc.textFrames, index);
        if (frame.overflows) {
          const summary = auditPageItemSummary(frame);
          summary.storyId = frame.parentStory ? Number(frame.parentStory.id) : null;
          oversetFrames.push(summary);
        }
      }
    }
    const emptyDesignSystem = { layers: [], swatches: [], paragraphStyles: [], characterStyles: [], objectStyles: [] };
    const designSystem = ${includeDesignSystem} ? {
      layers: auditCollectionSummary(doc.layers, (layer, index) => ({ id: Number(layer.id), name: String(layer.name || ""), index, visible: layer.visible !== false, locked: Boolean(layer.locked), printable: layer.printable !== false })),
      swatches: auditCollectionSummary(doc.swatches, (swatch) => {
        let colorValue = null;
        let space = { value: null, name: "" };
        let model = { value: null, name: "" };
        try { colorValue = auditNumericArray(swatch.colorValue); } catch (_) {}
        try { space = auditEnumSummary(swatch.space); } catch (_) {}
        try { model = auditEnumSummary(swatch.model); } catch (_) {}
        return { id: Number.isFinite(Number(swatch.id)) ? Number(swatch.id) : null, name: String(swatch.name || ""), colorValue, space, model };
      }),
      paragraphStyles: auditCollectionSummary(doc.paragraphStyles, (style) => auditStyleSummary(style, "paragraph")),
      characterStyles: auditCollectionSummary(doc.characterStyles, (style) => auditStyleSummary(style, "character")),
      objectStyles: auditCollectionSummary(doc.objectStyles, (style) => auditStyleSummary(style, "object"))
    } : emptyDesignSystem;
    audit = {
      success: true, documentId: Number(doc.id), revision, capturedAt: new Date().toISOString(),
      document: {
        id: Number(doc.id), name: String(doc.name), path: await auditNativePath(doc), modified: Boolean(doc.modified),
        pageCount: doc.pages.length, spreadCount: doc.spreads.length, facingPages: Boolean(preferences.facingPages),
        widthMm: Number(preferences.pageWidth), heightMm: Number(preferences.pageHeight),
        bleedMm: { top: Number(preferences.documentBleedTopOffset), inside: Number(preferences.documentBleedInsideOrLeftOffset), bottom: Number(preferences.documentBleedBottomOffset), outside: Number(preferences.documentBleedOutsideOrRightOffset) }
      },
      counts: { pages: doc.pages.length, spreads: doc.spreads.length, layers: doc.layers.length, masterSpreads: doc.masterSpreads.length },
      pages, items, links, fonts, images, oversetText: { count: oversetFrames.length, frames: oversetFrames }, designSystem,
      totalItems, inspectedItems: items.length, truncated: ${includeItems} && totalItems > items.length
    };
  } finally {
    try { unitPreferences.horizontalMeasurementUnits = previousHorizontal; } catch (_) {}
    try { unitPreferences.verticalMeasurementUnits = previousVertical; } catch (_) {}
  }
  if (!doc || doc.isValid === false) { const error = new Error("Le document a été fermé pendant l’audit"); error.code = "DOCUMENT_CHANGED_DURING_READ"; throw error; }
  const stateAfter = documentStateToken(doc);
  if (stateAfter !== stateBefore) { const error = new Error("Le document a changé pendant l’audit"); error.code = "DOCUMENT_CHANGED_DURING_READ"; throw error; }
  audit.stateToken = stateAfter;
  let serialized = JSON.stringify({ ok: true, audit });
  if (serialized.length > ${resultBudget} && audit.items.length > 0) {
    let low = 0;
    let high = audit.items.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      audit.items = audit.items.slice(0, middle);
      audit.inspectedItems = audit.items.length;
      audit.truncated = true;
      audit.truncationReason = "result-size";
      const candidate = JSON.stringify({ ok: true, audit });
      if (candidate.length <= ${resultBudget}) low = middle;
      else high = middle - 1;
      audit.items = items.slice();
    }
    audit.items = items.slice(0, low);
    audit.inspectedItems = audit.items.length;
    audit.truncated = true;
    audit.truncationReason = "result-size";
    serialized = JSON.stringify({ ok: true, audit });
  }
  if (serialized.length > ${resultBudget}) { const error = new Error("L’audit dépasse la limite de résultat même sans les objets de page"); error.code = "AUDIT_RESULT_TOO_LARGE"; throw error; }
  await __writeResult(JSON.parse(serialized));`;

    const result = await this.#runUxpRead(body);
    if (!result?.audit || result.audit.documentId !== documentId || !STATE_TOKEN_PATTERN.test(result.audit.stateToken ?? '')) {
      const error = new Error('Le résultat de l’audit silencieux est invalide.');
      error.code = 'AUDIT_RESULT_INVALID';
      throw error;
    }
    return result.audit;
  }

  async readDocument(command, args) {
    const sectionByCommand = {
      get_document_info: ['document'],
      list_pages: ['pages'],
      get_links: ['links'],
      get_fonts: ['fonts'],
      get_overset_text: ['overset'],
      get_images: ['images'],
      analyze_layout: ['pages', 'items', 'links', 'fonts', 'images', 'designSystem'],
    };
    const sections = sectionByCommand[command];
    if (!sections) {
      const error = new Error('Lecture silencieuse inconnue.');
      error.code = 'SILENT_READ_UNKNOWN';
      throw error;
    }
    const audit = await this.auditDocument(args.documentId, {
      maxItems: args.maxItems ?? 20_000,
      sections,
    });
    const common = { success: true, documentId: audit.documentId, revision: audit.revision };
    if (command === 'get_document_info') {
      return {
        ...common,
        document: {
          id: audit.document.id, name: audit.document.name, path: audit.document.path,
          pages: audit.counts.pages, spreads: audit.counts.spreads, layers: audit.counts.layers, masterSpreads: audit.counts.masterSpreads,
          widthMm: audit.document.widthMm, heightMm: audit.document.heightMm,
          facingPages: audit.document.facingPages, modified: audit.document.modified,
        },
      };
    }
    if (command === 'list_pages') {
      return { ...common, pages: audit.pages.map((page) => ({ id: page.id, pageId: page.id, index: page.index, name: page.name, bounds: page.bounds, appliedMaster: page.appliedMaster })) };
    }
    if (command === 'get_links') {
      return { ...common, links: audit.links.map(({ id, name, path: linkPath, status, pageItemId }) => ({ id, name, path: linkPath, status, pageItemId })) };
    }
    if (command === 'get_fonts') {
      return { ...common, fonts: audit.fonts.map(({ name, family, style, status }) => ({ name, family, style, status })) };
    }
    if (command === 'get_overset_text') return { ...common, ...audit.oversetText };
    if (command === 'get_images') return { ...common, images: audit.images };
    return layoutSnapshotFromAudit(audit);
  }

  async preflightDocument({ documentId, expectedRevision, profileName, timeoutSeconds = 60 }) {
    if (!Number.isInteger(documentId) || documentId < 1) {
      const error = new Error('Identifiant de document invalide pour le contrôle Adobe.');
      error.code = 'DOCUMENT_ID_INVALID';
      throw error;
    }
    if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision < 0)) {
      const error = new Error('La révision attendue du contrôle Adobe est invalide.');
      error.code = 'REVISION_INVALID';
      throw error;
    }
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) {
      const error = new Error('Le délai du contrôle Adobe doit être compris entre 1 et 600 secondes.');
      error.code = 'PREFLIGHT_TIMEOUT_INVALID';
      throw error;
    }
    if (profileName !== undefined && (typeof profileName !== 'string' || profileName.length < 1 || profileName.length > 256)) {
      const error = new Error('Le nom du profil de contrôle Adobe est invalide.');
      error.code = 'PREFLIGHT_PROFILE_INVALID';
      throw error;
    }
    const body = `  const wanted = ${Number(documentId)};
  const requestedProfile = ${jsonLiteral(profileName ?? null)};
  const timeoutSeconds = ${Number(timeoutSeconds)};
  let doc = null;
  for (let index = 0; index < app.documents.length; index += 1) {
    const candidate = app.documents.item(index);
    if (candidate && candidate.isValid !== false && Number(candidate.id) === wanted) { doc = candidate; break; }
  }
  if (!doc) { const error = new Error("Document introuvable"); error.code = "DOCUMENT_NOT_FOUND"; throw error; }
  if (app.modalState) { const error = new Error("InDesign affiche une boîte de dialogue modale"); error.code = "INDESIGN_MODAL"; throw error; }
  const stateBefore = documentStateToken(doc);
  const rawRevision = doc.extractLabel(${jsonLiteral(REVISION_LABEL)});
  const parsedRevision = Number.parseInt(rawRevision || "0", 10);
  const revision = Number.isInteger(parsedRevision) && parsedRevision >= 0 ? parsedRevision : 0;
  const expectedRevision = ${expectedRevision === undefined ? 'null' : Number(expectedRevision)};
  if (expectedRevision !== null && revision !== expectedRevision) { const error = new Error("Le document a changé depuis la dernière lecture"); error.code = "REVISION_CONFLICT"; throw error; }
  const preflightOptions = doc.preflightOptions;
  const originalPreflightOff = Boolean(preflightOptions.preflightOff);
  const safeValue = (value, depth = 0, seen = new Set()) => {
    if (value === null || value === undefined) return null;
    if (["string", "number", "boolean"].includes(typeof value)) return typeof value === "string" ? value.slice(0, 200000) : value;
    if (depth >= 8) return "[profondeur limitee]";
    if (Array.isArray(value)) {
      if (value.length > 50000) { const error = new Error("Le résultat du contrôle Adobe est trop volumineux"); error.code = "PREFLIGHT_RESULT_TOO_LARGE"; throw error; }
      return value.map((entry) => safeValue(entry, depth + 1, seen));
    }
    if (typeof value === "object") {
      if (seen.has(value)) return "[reference circulaire]";
      seen.add(value);
      const output = {};
      for (const key of Object.keys(value).slice(0, 500)) {
        if (["__proto__", "prototype", "constructor"].includes(key)) continue;
        try { output[key] = safeValue(value[key], depth + 1, seen); }
        catch (error) { if (error && error.code === "PREFLIGHT_RESULT_TOO_LARGE") throw error; output[key] = null; }
      }
      seen.delete(value);
      return output;
    }
    return String(value);
  };
  const profileByName = (name) => {
    let candidate = null;
    try { candidate = doc.preflightProfiles.itemByName(name); } catch (_) {}
    if (candidate && candidate.isValid) return candidate;
    try { candidate = app.preflightProfiles.itemByName(name); } catch (_) {}
    return candidate && candidate.isValid ? candidate : null;
  };
  let profile = null;
  if (requestedProfile) {
    profile = profileByName(requestedProfile);
    if (!profile) { const error = new Error("Profil de contrôle introuvable"); error.code = "PREFLIGHT_PROFILE_NOT_FOUND"; throw error; }
  } else {
    let workingProfile = null;
    try { workingProfile = preflightOptions.preflightWorkingProfile; } catch (_) {}
    if (workingProfile && typeof workingProfile === "object" && workingProfile.isValid) profile = workingProfile;
    else if (typeof workingProfile === "string" && workingProfile) profile = profileByName(workingProfile);
    if (!profile && app.preflightProfiles.length > 0) profile = app.preflightProfiles.item(0);
    if (!profile || profile.isValid === false) { const error = new Error("Aucun profil de contrôle disponible"); error.code = "PREFLIGHT_PROFILE_NOT_FOUND"; throw error; }
  }
  let process = null;
  let operationStarted = false;
  let outcome;
  try {
    if (originalPreflightOff) preflightOptions.preflightOff = false;
    process = app.preflightProcesses.add(doc, profile);
    operationStarted = true;
    const startedAt = Date.now();
    let completed = Boolean(process.waitForProcess(timeoutSeconds));
    if (!completed) {
      const remaining = timeoutSeconds - Math.ceil((Date.now() - startedAt) / 1000);
      if (remaining > 0) completed = Boolean(process.waitForProcess(remaining));
    }
    let aggregated = null;
    let report = "";
    try { aggregated = safeValue(process.aggregatedResults); } catch (error) { throw error; }
    try { report = String(process.processResults || "").slice(0, 200000); } catch (_) {}
    if (!completed && Array.isArray(aggregated) && aggregated.length >= 3 && report.length > 0) completed = true;
    if (!completed) { const error = new Error("Le contrôle Adobe n’est pas terminé"); error.code = "PREFLIGHT_TIMEOUT"; throw error; }
    outcome = { ok: true, success: true, profile: String(profile.name), aggregatedResults: aggregated, processResults: report, documentId: wanted, revision };
  } catch (error) {
    error.requiresInspection = operationStarted;
    throw error;
  } finally {
    if (process) { try { process.remove(); } catch (_) {} }
    if (originalPreflightOff) {
      let restorationFailed = false;
      try {
        preflightOptions.preflightOff = true;
        restorationFailed = Boolean(preflightOptions.preflightOff) !== originalPreflightOff;
      } catch (_) {
        restorationFailed = true;
      }
      if (restorationFailed) {
        const error = new Error("La préférence de préflight InDesign n’a pas pu être restaurée");
        error.code = "PREFLIGHT_PREFERENCES_RESTORE_FAILED";
        error.requiresInspection = true;
        throw error;
      }
    }
  }
  if (!doc || doc.isValid === false || documentStateToken(doc) !== stateBefore) {
    const error = new Error("Le document a changé pendant le contrôle Adobe");
    error.code = "DOCUMENT_CHANGED_DURING_READ";
    error.requiresInspection = true;
    throw error;
  }
  script.setResult(JSON.stringify(outcome));`;
    return this.#runUxpSync(syncUxpEnvelope(body), {
      timeoutMs: Math.max(this.timeoutMs, (timeoutSeconds * 1000) + 5_000),
    });
  }

  async closeDocument({ documentId, expectedRevision, expectedStateToken, save }) {
    if (save !== false) {
      const error = new Error('La fermeture silencieuse interdit tout enregistrement : save doit valoir false.');
      error.code = 'SILENT_CLOSE_SAVE_FORBIDDEN';
      throw error;
    }
    const operationId = crypto.randomUUID();
    return this.#withMutationGuard(operationId, async () => {
    const snapshots = await this.#snapshotAllDocuments();
    const target = snapshots.find((document) => document.documentId === documentId);
    if (!target) {
      const error = new Error('Document à fermer introuvable.');
      error.code = 'DOCUMENT_NOT_FOUND';
      throw error;
    }
    if (target.revision !== expectedRevision) {
      const error = new Error('Le document a changé depuis la dernière lecture.');
      error.code = 'REVISION_CONFLICT';
      throw error;
    }
    if (target.stateToken !== expectedStateToken) {
      const error = new Error('Le document a changé depuis la dernière inspection.');
      error.code = 'STATE_CONFLICT';
      throw error;
    }
    const body = `  if (app.modalState) { const error = new Error("InDesign affiche une boîte de dialogue modale"); error.code = "INDESIGN_MODAL"; throw error; }
  const wanted = ${Number(documentId)};
  const expectedRevision = ${Number(expectedRevision)};
  const expectedStateToken = ${jsonLiteral(expectedStateToken)};
  const expectedDocuments = ${jsonLiteral(snapshots)};
  const captureDocumentProfile = () => {
    let activeId = null;
    if (app.documents.length > 0) {
      try {
        const activeDocument = app.activeDocument;
        if (activeDocument && activeDocument.isValid !== false) activeId = Number(activeDocument.id);
      } catch (_) {}
    }
    const profile = [];
    for (let index = 0; index < app.documents.length; index += 1) {
      const doc = app.documents.item(index);
      const rawRevision = doc.extractLabel(${jsonLiteral(REVISION_LABEL)});
      const parsedRevision = Number.parseInt(rawRevision || "0", 10);
      profile.push({
        doc,
        documentId: Number(doc.id),
        revision: Number.isInteger(parsedRevision) && parsedRevision >= 0 ? parsedRevision : 0,
        stateToken: documentStateToken(doc),
        modified: Boolean(doc.modified),
        saved: Boolean(doc.saved),
        active: Number(doc.id) === activeId
      });
    }
    return profile.sort((left, right) => left.documentId - right.documentId);
  };
  const normalizeDocumentProfile = (profile) => profile
      .map((entry) => ({ documentId: entry.documentId, revision: entry.revision, stateToken: entry.stateToken, modified: entry.modified === true, saved: entry.saved === true, active: entry.active === true }))
      .sort((left, right) => left.documentId - right.documentId);
  const normalizeDocumentMetadata = (profile) => profile
      .map((entry) => ({ documentId: entry.documentId, revision: entry.revision, modified: entry.modified === true, saved: entry.saved === true }))
      .sort((left, right) => left.documentId - right.documentId);
  const documentProfilesEqual = (left, right) =>
    JSON.stringify(normalizeDocumentProfile(left)) === JSON.stringify(normalizeDocumentProfile(right));
  const assertFocusOnlyTransition = (expected, actual, code, message) => {
    if (JSON.stringify(normalizeDocumentMetadata(expected)) !== JSON.stringify(normalizeDocumentMetadata(actual))) {
      const error = new Error(message); error.code = code; throw error;
    }
  };
  const assertDocumentProfile = (expected, actual, code, message) => {
    if (!documentProfilesEqual(expected, actual)) {
      const error = new Error(message); error.code = code; throw error;
    }
  };
  const captureStableDocumentProfile = async (code, message) => {
    const deadline = Date.now() + 10000;
    let previous = null;
    while (Date.now() < deadline) {
      let current;
      try { current = captureDocumentProfile(); }
      catch (_) { previous = null; await new Promise((resolve) => setTimeout(resolve, 50)); continue; }
      if (previous && documentProfilesEqual(previous, current)) return current;
      previous = current;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const error = new Error(message); error.code = code; throw error;
  };
  const bringDocumentToFront = async (doc, code) => {
    const windows = doc && doc.layoutWindows;
    const layoutWindow = windows && windows.length > 0 ? windows.item(0) : null;
    if (!layoutWindow || layoutWindow.isValid === false || typeof layoutWindow.bringToFront !== "function") {
      const error = new Error("Aucune fenêtre de mise en page ne permet de vérifier le changement de focus"); error.code = code; throw error;
    }
    await Promise.resolve(layoutWindow.bringToFront());
    const deadline = Date.now() + 2000;
    while ((!app.activeDocument || Number(app.activeDocument.id) !== Number(doc.id)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!app.activeDocument || Number(app.activeDocument.id) !== Number(doc.id)) {
      const error = new Error("Le changement de document actif n’a pas été confirmé"); error.code = code; throw error;
    }
  };
  if (app.documents.length !== expectedDocuments.length) { const error = new Error("L’inventaire des documents a changé"); error.code = "DOCUMENT_INVENTORY_CONFLICT"; throw error; }
  let target = null;
  const preserved = [];
  for (let index = 0; index < app.documents.length; index += 1) {
    const candidate = app.documents.item(index);
    const expected = expectedDocuments.find((entry) => Number(entry.documentId) === Number(candidate.id));
    const actual = Number.parseInt(candidate.extractLabel(${jsonLiteral(REVISION_LABEL)}) || "0", 10) || 0;
    if (!expected || actual !== Number(expected.revision) || documentStateToken(candidate) !== expected.stateToken) { const error = new Error("Un document a changé avant la fermeture"); error.code = "DOCUMENT_STATE_CONFLICT"; throw error; }
    if (Number(candidate.id) === wanted) target = candidate;
    else preserved.push({ doc: candidate, documentId: Number(candidate.id) });
  }
  if (!target) { const error = new Error("Document introuvable"); error.code = "DOCUMENT_NOT_FOUND"; throw error; }
  const actualRevision = Number.parseInt(target.extractLabel(${jsonLiteral(REVISION_LABEL)}) || "0", 10) || 0;
  if (actualRevision !== expectedRevision) { const error = new Error("Le document a changé depuis la dernière lecture"); error.code = "REVISION_CONFLICT"; throw error; }
  if (documentStateToken(target) !== expectedStateToken) { const error = new Error("Le document a changé depuis la dernière inspection"); error.code = "STATE_CONFLICT"; throw error; }
  const previousInteraction = app.scriptPreferences.userInteractionLevel;
  const previousRedraw = app.scriptPreferences.enableRedraw;
  let closeStarted = false;
  let outcome;
  try {
    app.scriptPreferences.userInteractionLevel = indesign.UserInteractionLevels.NEVER_INTERACT !== undefined ? indesign.UserInteractionLevels.NEVER_INTERACT : indesign.UserInteractionLevels.neverInteract;
    app.scriptPreferences.enableRedraw = false;
    const initialProfile = await captureStableDocumentProfile("SILENT_CLOSE_PROFILE_UNSTABLE", "Le profil documentaire initial ne se stabilise pas");
    const initialTarget = initialProfile.find((entry) => entry.documentId === wanted);
    let preservedBaseline = initialProfile.filter((entry) => entry.documentId !== wanted);
    if (initialTarget && initialTarget.active && preserved.length > 0) {
      const keeper = [...preserved]
        .sort((left, right) => left.documentId - right.documentId)
        .find((entry) => entry.doc && entry.doc.layoutWindows && entry.doc.layoutWindows.length > 0);
      if (!keeper) {
        const error = new Error("Aucun document restant ne possède de fenêtre vérifiable"); error.code = "SILENT_CLOSE_FOCUS_UNAVAILABLE"; throw error;
      }
      await bringDocumentToFront(keeper.doc, "SILENT_CLOSE_FOCUS_SWITCH_FAILED");
      const focusedProfile = await captureStableDocumentProfile("SILENT_CLOSE_PROFILE_UNSTABLE", "Le profil documentaire de fermeture ne se stabilise pas");
      assertFocusOnlyTransition(initialProfile, focusedProfile, "SILENT_CLOSE_FOCUS_CHANGED_DOCUMENT", "Le changement de fenêtre a modifié un document");
      preservedBaseline = focusedProfile.filter((entry) => entry.documentId !== wanted);
    }
    closeStarted = true;
    await target.close(indesign.SaveOptions.no);
    const deadline = Date.now() + 10000;
    let stillOpen = true;
    while (stillOpen && Date.now() < deadline) {
      stillOpen = false;
      // Un document en cours de fermeture peut rester listé puis devenir invalide (« Object is invalid »).
      try {
        for (let index = 0; index < app.documents.length; index += 1) {
          if (Number(app.documents.item(index).id) === wanted) { stillOpen = true; break; }
        }
      } catch (_) { stillOpen = true; }
      if (stillOpen) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (stillOpen) { const error = new Error("La fermeture du document n’a pas été confirmée"); error.code = "SILENT_CLOSE_NOT_CONFIRMED"; throw error; }
    const finalProfile = await captureStableDocumentProfile("SILENT_CLOSE_PROFILE_UNSTABLE", "Le profil documentaire après fermeture ne se stabilise pas");
    assertDocumentProfile(preservedBaseline, finalProfile, "SILENT_CLOSE_OTHER_DOCUMENT_CHANGED", "Un autre document a changé pendant la fermeture");
    const activeDocumentId = finalProfile.find((entry) => entry.active)?.documentId ?? null;
    outcome = {
      ok: true,
      success: true,
      closedDocumentId: wanted,
      saved: false,
      activeDocumentId,
      documentStates: finalProfile.map(({ documentId, revision, stateToken }) => ({ documentId, revision, stateToken })),
      operationId: __operationId
    };
  } catch (error) {
    error.requiresInspection = closeStarted;
    throw error;
  } finally {
    try { app.scriptPreferences.userInteractionLevel = previousInteraction; } catch (_) {}
    try { app.scriptPreferences.enableRedraw = previousRedraw; } catch (_) {}
  }
  await __writeResult(outcome);`;
    return this.#runUxpTracked({ body, operationId });
    });
  }

  async openDocument(filePath) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.includes('\0')) {
      const error = new Error('Un chemin absolu valide est requis pour ouvrir le document.');
      error.code = 'OPEN_PATH_INVALID';
      throw error;
    }
    const extension = path.extname(filePath).toLowerCase();
    const artifactKind = extension === '.indd' ? 'indd' : extension === '.idml' ? 'idml' : null;
    if (!artifactKind) {
      const error = new Error('Seuls les fichiers INDD et IDML peuvent être ouverts silencieusement.');
      error.code = 'OPEN_EXTENSION_UNSUPPORTED';
      throw error;
    }
    const before = await fs.lstat(filePath).catch((cause) => {
      const error = new Error('Le document à ouvrir est introuvable ou inaccessible.');
      error.code = 'OPEN_SOURCE_UNAVAILABLE';
      error.cause = cause;
      throw error;
    });
    if (!before.isFile() || before.isSymbolicLink()) {
      const error = new Error('Le document à ouvrir doit être un fichier normal, jamais un lien.');
      error.code = 'OPEN_SOURCE_INVALID';
      throw error;
    }
    const artifactVerification = await verifyArtifact({ targetPath: filePath, kind: artifactKind });
    const after = await fs.lstat(filePath);
    if (!after.isFile() || after.isSymbolicLink() || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      const error = new Error('Le document a changé pendant sa validation et n’a pas été envoyé à InDesign.');
      error.code = 'OPEN_SOURCE_CHANGED';
      throw error;
    }

    const operationId = crypto.randomUUID();
    const stabilizationMarginMs = Math.min(10_000, Math.max(250, Math.floor(this.timeoutMs * 0.1)));
    const openProfileBudgetMs = Math.max(250, this.timeoutMs - stabilizationMarginMs);
    const body = `  if (app.modalState) { const error = new Error("InDesign affiche une boîte de dialogue modale"); error.code = "INDESIGN_MODAL"; throw error; }
  const sourcePath = ${jsonLiteral(uxpPath(filePath))};
  const openProfileDeadline = Date.now() + ${openProfileBudgetMs};
${DOCUMENT_PROFILE_HELPERS}  const initialProfileDeadline = Math.min(openProfileDeadline, Date.now() + 10000);
  const documentsBefore = await captureStableDocumentProfile("OPEN_INITIAL_PROFILE_UNSTABLE", "Le profil documentaire initial ne se stabilise pas", initialProfileDeadline);
  const previousActive = documentsBefore.find((entry) => entry.active);
  if (documentsBefore.length > 0 && !previousActive) {
    const error = new Error("Le document actif initial est introuvable"); error.code = "OPEN_ACTIVE_DOCUMENT_MISSING"; throw error;
  }
  const previousInteraction = app.scriptPreferences.userInteractionLevel;
  const previousRedraw = app.scriptPreferences.enableRedraw;
  let opened = null;
  let mutationStarted = false;
  let outcome;
  try {
    app.scriptPreferences.userInteractionLevel = indesign.UserInteractionLevels.NEVER_INTERACT !== undefined ? indesign.UserInteractionLevels.NEVER_INTERACT : indesign.UserInteractionLevels.neverInteract;
    app.scriptPreferences.enableRedraw = false;
    mutationStarted = true;
    opened = await app.open(sourcePath, true);
    if (!opened || opened.isValid === false) { const error = new Error("InDesign n’a pas renvoyé de document valide"); error.code = "OPEN_RESULT_INVALID"; throw error; }
    await bringDocumentToFront(opened, "OPEN_FOCUS_SWITCH_FAILED");
    const openedId = Number(opened.id);
    const alreadyOpen = documentsBefore.some((entry) => entry.documentId === openedId);
    const expectedCount = documentsBefore.length + (alreadyOpen ? 0 : 1);
    if (app.documents.length !== expectedCount) { const error = new Error("L’inventaire des documents ouverts est inattendu"); error.code = "OPEN_INVENTORY_MISMATCH"; throw error; }
    const openedProfile = await captureStableDocumentProfile("OPEN_PROFILE_UNSTABLE", "Le profil documentaire après ouverture ne se stabilise pas", openProfileDeadline);
    const beforeIds = new Set(documentsBefore.map((entry) => entry.documentId));
    const existingAfterOpen = openedProfile.filter((entry) => beforeIds.has(entry.documentId));
    assertFocusOnlyTransition(documentsBefore, existingAfterOpen, "OPEN_EXISTING_DOCUMENT_CHANGED", "Un document déjà ouvert a changé pendant l’ouverture");
    if (alreadyOpen && previousActive?.documentId === openedId) {
      assertDocumentProfile(documentsBefore, openedProfile, "OPEN_EXISTING_DOCUMENT_CHANGED", "Le document déjà ouvert a changé pendant sa réactivation");
    }
    const rawRevision = opened.extractLabel(${jsonLiteral(REVISION_LABEL)});
    const parsedRevision = Number.parseInt(rawRevision || "0", 10);
    const revision = Number.isInteger(parsedRevision) && parsedRevision >= 0 ? parsedRevision : 0;
    const finalProfile = openedProfile;
    outcome = {
      ok: true,
      success: true,
      documentId: openedId,
      name: String(opened.name),
      revision,
      stateToken: documentStateToken(opened),
      alreadyOpen,
      activeDocumentId: openedId,
      documentStates: finalProfile.map(({ documentId, revision: documentRevision, stateToken }) => ({ documentId, revision: documentRevision, stateToken })),
      operationId: __operationId
    };
  } catch (error) {
    error.requiresInspection = mutationStarted;
    throw error;
  } finally {
    try { app.scriptPreferences.userInteractionLevel = previousInteraction; } catch (_) {}
    try { app.scriptPreferences.enableRedraw = previousRedraw; } catch (_) {}
  }
  await __writeResult(outcome);`;

    const result = await this.#runUxpTracked({ body, operationId });
    return { ...result, artifactVerification };
  }

  // Création silencieuse : même garde que l'ouverture (bail commun, NEVER_INTERACT, profil documentaire stable avant et
  // après, aucun autre document modifié). Avec path, le document est enregistré aussitôt pour que run_layout_script
  // puisse ensuite enregistrer (save=true) sans boîte de dialogue.
  async createDocument({ width, height, pageCount = 1, facingPages = true, units = 'mm', margins = [12, 12, 12, 12], bleed = [3, 3, 3, 3], path: savePath } = {}) {
    const toMillimeters = (value) => (units === 'pt' ? (value * 25.4) / 72 : value);
    const spec = {
      width: toMillimeters(width),
      height: toMillimeters(height),
      pageCount,
      facingPages: facingPages === true,
      margins: margins.map(toMillimeters),
      bleed: bleed.map(toMillimeters),
    };
    const valid = Number.isFinite(spec.width) && spec.width > 0 && Number.isFinite(spec.height) && spec.height > 0
      && Number.isInteger(pageCount) && pageCount >= 1 && pageCount <= 10_000
      && [...spec.margins, ...spec.bleed].length === 8 && [...spec.margins, ...spec.bleed].every((value) => Number.isFinite(value) && value >= 0);
    if (!valid) {
      const error = new Error('Dimensions, pages, marges ou fond perdu invalides pour la création du document.');
      error.code = 'CREATE_ARGS_INVALID';
      throw error;
    }
    if (savePath !== undefined) {
      if (typeof savePath !== 'string' || !path.isAbsolute(savePath) || savePath.includes('\0') || path.extname(savePath).toLowerCase() !== '.indd') {
        const error = new Error('Le chemin d’enregistrement du nouveau document doit être un fichier INDD absolu.');
        error.code = 'CREATE_PATH_INVALID';
        throw error;
      }
      const existing = await fs.lstat(savePath).catch((cause) => (cause.code === 'ENOENT' ? null : Promise.reject(cause)));
      if (existing) {
        const error = new Error('Un fichier existe déjà à cet emplacement; la création n’écrase rien.');
        error.code = 'TARGET_EXISTS';
        throw error;
      }
    }

    const operationId = crypto.randomUUID();
    const stabilizationMarginMs = Math.min(10_000, Math.max(250, Math.floor(this.timeoutMs * 0.1)));
    const profileBudgetMs = Math.max(250, this.timeoutMs - stabilizationMarginMs);
    const body = `  if (app.modalState) { const error = new Error("InDesign affiche une boîte de dialogue modale"); error.code = "INDESIGN_MODAL"; throw error; }
  const spec = ${jsonLiteral(spec)};
  const savePath = ${jsonLiteral(savePath === undefined ? null : uxpPath(savePath))};
  const openProfileDeadline = Date.now() + ${profileBudgetMs};
${DOCUMENT_PROFILE_HELPERS}  const initialProfileDeadline = Math.min(openProfileDeadline, Date.now() + 10000);
  const documentsBefore = await captureStableDocumentProfile("CREATE_INITIAL_PROFILE_UNSTABLE", "Le profil documentaire initial ne se stabilise pas", initialProfileDeadline);
  if (documentsBefore.length > 0 && !documentsBefore.some((entry) => entry.active)) {
    const error = new Error("Le document actif initial est introuvable"); error.code = "CREATE_ACTIVE_DOCUMENT_MISSING"; throw error;
  }
  const previousInteraction = app.scriptPreferences.userInteractionLevel;
  const previousRedraw = app.scriptPreferences.enableRedraw;
  let created = null;
  let mutationStarted = false;
  let outcome;
  try {
    app.scriptPreferences.userInteractionLevel = indesign.UserInteractionLevels.NEVER_INTERACT !== undefined ? indesign.UserInteractionLevels.NEVER_INTERACT : indesign.UserInteractionLevels.neverInteract;
    app.scriptPreferences.enableRedraw = false;
    mutationStarted = true;
    created = await Promise.resolve(app.documents.add());
    if (!created || created.isValid === false) { const error = new Error("InDesign n’a pas renvoyé de document valide"); error.code = "CREATE_RESULT_INVALID"; throw error; }
    const createdId = Number(created.id);
    if (documentsBefore.some((entry) => entry.documentId === createdId)) { const error = new Error("Le nouveau document reprend l’identifiant d’un document ouvert"); error.code = "CREATE_INVENTORY_MISMATCH"; throw error; }
    const view = created.viewPreferences;
    const millimeters = indesign.MeasurementUnits.MILLIMETERS !== undefined ? indesign.MeasurementUnits.MILLIMETERS : indesign.MeasurementUnits.millimeters;
    const previousUnits = [view.horizontalMeasurementUnits, view.verticalMeasurementUnits];
    let geometry;
    try {
      view.horizontalMeasurementUnits = millimeters;
      view.verticalMeasurementUnits = millimeters;
      const prefs = created.documentPreferences;
      prefs.facingPages = spec.facingPages;
      prefs.pageWidth = spec.width;
      prefs.pageHeight = spec.height;
      prefs.pagesPerDocument = spec.pageCount;
      prefs.documentBleedTopOffset = spec.bleed[0];
      prefs.documentBleedInsideOrLeftOffset = spec.bleed[1];
      prefs.documentBleedBottomOffset = spec.bleed[2];
      prefs.documentBleedOutsideOrRightOffset = spec.bleed[3];
      const applyMargins = (target) => {
        const margin = target.marginPreferences;
        margin.top = spec.margins[0];
        margin.left = spec.margins[1];
        margin.bottom = spec.margins[2];
        margin.right = spec.margins[3];
      };
      applyMargins(created);
      for (let spread = 0; spread < created.masterSpreads.length; spread += 1) {
        const pages = created.masterSpreads.item(spread).pages;
        for (let page = 0; page < pages.length; page += 1) applyMargins(pages.item(page));
      }
      for (let page = 0; page < created.pages.length; page += 1) applyMargins(created.pages.item(page));
      const firstMargins = created.pages.item(0).marginPreferences;
      geometry = {
        width: Number(prefs.pageWidth),
        height: Number(prefs.pageHeight),
        pages: created.pages.length,
        facingPages: Boolean(prefs.facingPages),
        margins: [Number(firstMargins.top), Number(firstMargins.left), Number(firstMargins.bottom), Number(firstMargins.right)],
      };
    } finally {
      try { view.horizontalMeasurementUnits = previousUnits[0]; } catch (_) {}
      try { view.verticalMeasurementUnits = previousUnits[1]; } catch (_) {}
    }
    const near = (left, right) => Math.abs(left - right) < 0.01;
    if (!near(geometry.width, spec.width) || !near(geometry.height, spec.height) || geometry.pages !== spec.pageCount
      || geometry.facingPages !== spec.facingPages || !geometry.margins.every((value, index) => near(value, spec.margins[index]))) {
      const error = new Error("La géométrie relue ne correspond pas à la demande"); error.code = "CREATE_GEOMETRY_MISMATCH"; throw error;
    }
    created.insertLabel(${jsonLiteral(REVISION_LABEL)}, "0");
    if (savePath) await Promise.resolve(created.save(savePath));
    await bringDocumentToFront(created, "CREATE_FOCUS_SWITCH_FAILED");
    if (app.documents.length !== documentsBefore.length + 1) { const error = new Error("L’inventaire des documents ouverts est inattendu"); error.code = "CREATE_INVENTORY_MISMATCH"; throw error; }
    const createdProfile = await captureStableDocumentProfile("CREATE_PROFILE_UNSTABLE", "Le profil documentaire après création ne se stabilise pas", openProfileDeadline);
    const beforeIds = new Set(documentsBefore.map((entry) => entry.documentId));
    assertFocusOnlyTransition(documentsBefore, createdProfile.filter((entry) => beforeIds.has(entry.documentId)), "CREATE_EXISTING_DOCUMENT_CHANGED", "Un document déjà ouvert a changé pendant la création");
    if (!createdProfile.some((entry) => entry.documentId === createdId && entry.active)) { const error = new Error("Le nouveau document n’est pas le document actif"); error.code = "CREATE_FOCUS_SWITCH_FAILED"; throw error; }
    outcome = {
      ok: true,
      success: true,
      documentId: createdId,
      name: String(created.name),
      revision: 0,
      stateToken: documentStateToken(created),
      saved: Boolean(savePath),
      geometry,
      activeDocumentId: createdId,
      documentStates: createdProfile.map(({ documentId, revision: documentRevision, stateToken }) => ({ documentId, revision: documentRevision, stateToken })),
      operationId: __operationId
    };
  } catch (error) {
    error.requiresInspection = mutationStarted;
    throw error;
  } finally {
    try { app.scriptPreferences.userInteractionLevel = previousInteraction; } catch (_) {}
    try { app.scriptPreferences.enableRedraw = previousRedraw; } catch (_) {}
  }
  await __writeResult(outcome);`;

    const result = await this.#runUxpTracked({ body, operationId });
    const artifactVerification = savePath === undefined ? undefined : await verifyArtifact({ targetPath: savePath, kind: 'indd' });
    return { ...result, executionChannel: 'silent', ...(artifactVerification ? { path: savePath, artifactVerification } : {}) };
  }

  async exportDocument(request) {
    const {
      command,
      documentId,
      expectedRevision,
      expectedStateToken,
      filePath,
      folderPath,
      pageId,
      pageRange = 'all',
      resolution = 300,
      transparentBackground = false,
      presetName,
      includeFonts = true,
      includeLinks = true,
      includeProfiles = true,
      includeHiddenLayers = false,
      ignorePreflightErrors = false,
      includeIdml = true,
      includePdf = true,
      pdfPresetName,
    } = request ?? {};
    if (!['export_pdf', 'export_png', 'package_document'].includes(command)) {
      const error = new Error('Type d’export silencieux inconnu.');
      error.code = 'SILENT_EXPORT_UNKNOWN';
      throw error;
    }
    if (!Number.isInteger(documentId) || documentId < 1) {
      const error = new Error('Identifiant de document invalide pour l’export silencieux.');
      error.code = 'DOCUMENT_ID_INVALID';
      throw error;
    }
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      const error = new Error('Révision invalide pour l’export silencieux.');
      error.code = 'REVISION_INVALID';
      throw error;
    }
    if (!STATE_TOKEN_PATTERN.test(expectedStateToken ?? '')) {
      const error = new Error('Empreinte documentaire invalide pour l’export silencieux.');
      error.code = 'STATE_TOKEN_REQUIRED';
      throw error;
    }
    const validAbsolutePath = (value, extension) => typeof value === 'string'
      && path.isAbsolute(value)
      && !value.includes('\0')
      && path.extname(value).toLowerCase() === extension;
    if (command === 'export_pdf') {
      if (!validAbsolutePath(filePath, '.pdf')) {
        const error = new Error('Un chemin PDF absolu valide est requis.');
        error.code = 'EXPORT_PATH_INVALID';
        throw error;
      }
      if (presetName !== undefined && (typeof presetName !== 'string' || presetName.length < 1 || presetName.length > 300)) {
        const error = new Error('Le nom du paramètre PDF est invalide.');
        error.code = 'PDF_PRESET_INVALID';
        throw error;
      }
    } else if (command === 'package_document') {
      if (typeof folderPath !== 'string' || !path.isAbsolute(folderPath) || folderPath.includes('\0')) {
        const error = new Error('Un dossier d’assemblage absolu valide est requis.');
        error.code = 'PACKAGE_TARGET_INVALID';
        throw error;
      }
      const flags = [includeFonts, includeLinks, includeProfiles, includeHiddenLayers, ignorePreflightErrors, includeIdml, includePdf];
      if (flags.some((flag) => typeof flag !== 'boolean')
        || (pdfPresetName !== undefined && (typeof pdfPresetName !== 'string' || pdfPresetName.length < 1 || pdfPresetName.length > 300))) {
        const error = new Error('Les paramètres de l’assemblage sont invalides.');
        error.code = 'PACKAGE_OPTIONS_INVALID';
        throw error;
      }
    } else {
      const singlePage = Number.isInteger(pageId) && pageId > 0;
      if (singlePage !== validAbsolutePath(filePath, '.png') || singlePage === (typeof folderPath === 'string')) {
        const error = new Error('L’export PNG exige soit pageId avec filePath, soit folderPath seul.');
        error.code = 'PNG_TARGET_INVALID';
        throw error;
      }
      if (!singlePage && (typeof folderPath !== 'string' || !path.isAbsolute(folderPath) || folderPath.includes('\0'))) {
        const error = new Error('Un dossier PNG absolu valide est requis.');
        error.code = 'PNG_TARGET_INVALID';
        throw error;
      }
      if (!Number.isInteger(resolution) || resolution < 36 || resolution > 2400) {
        const error = new Error('La résolution PNG doit être comprise entre 36 et 2400 ppp.');
        error.code = 'PNG_RESOLUTION_INVALID';
        throw error;
      }
      if (typeof transparentBackground !== 'boolean' || typeof pageRange !== 'string' || pageRange.length < 1 || pageRange.length > 128) {
        const error = new Error('Les paramètres de l’export PNG sont invalides.');
        error.code = 'PNG_OPTIONS_INVALID';
        throw error;
      }
    }

    const active = this.mutationContext.getStore();
    const operationId = active?.operationId ?? crypto.randomUUID();
    if (!active) return this.withSilentMutationLease(operationId, () => this.exportDocument(request));

    const inventory = await this.listDocuments();
    const documents = Array.isArray(inventory.documents) ? inventory.documents : [];
    const target = documents.find((document) => document.documentId === documentId);
    if (!target) {
      const error = new Error('Document introuvable avant l’export silencieux.');
      error.code = 'DOCUMENT_NOT_FOUND';
      throw error;
    }
    if (target.revision !== expectedRevision) {
      const error = new Error('Le document a changé depuis la dernière lecture.');
      error.code = 'REVISION_CONFLICT';
      throw error;
    }
    const inspected = await this.inspectDocument(documentId);
    if (inspected?.document?.stateToken !== expectedStateToken) {
      const error = new Error('Le contenu ou la structure du document a changé depuis la dernière inspection.');
      error.code = 'STATE_CONFLICT';
      throw error;
    }

    let safetyBackups = [];
    try {
      safetyBackups = await this.#backupDocuments(documents);
      const expectedDocuments = safetyBackups.map(({ documentId: id, revision, stateToken }) => ({ documentId: id, revision, stateToken }));
      const exportAction = command === 'package_document' ? PACKAGE_ACTION({
        folderPath: uxpPath(folderPath),
        includeFonts,
        includeLinks,
        includeProfiles,
        includeHiddenLayers,
        ignorePreflightErrors,
        includeIdml,
        includePdf,
        pdfPresetName: pdfPresetName ?? '',
      }) : command === 'export_pdf'
        ? `  const requestedPreset = ${jsonLiteral(presetName ?? null)};
  let preset;
  if (requestedPreset) {
    preset = app.pdfExportPresets.itemByName(requestedPreset);
    if (!preset || preset.isValid === false) { const error = new Error("Paramètre PDF introuvable"); error.code = "PDF_PRESET_NOT_FOUND"; throw error; }
  }
  const preferences = app.pdfExportPreferences;
  const previousPageRange = preferences.pageRange;
  const previousBleed = preferences.useDocumentBleedWithPDF;
  const previousCropMarks = preferences.cropMarks;
  try {
    const allPages = indesign.PageRange ? (indesign.PageRange.ALL_PAGES !== undefined ? indesign.PageRange.ALL_PAGES : indesign.PageRange.allPages) : undefined;
    preferences.pageRange = allPages !== undefined ? allPages : "all";
    preferences.useDocumentBleedWithPDF = true;
    preferences.cropMarks = false;
    exportStarted = true;
    await targetDocument.exportFile(indesign.ExportFormat.pdfType, ${jsonLiteral(uxpPath(filePath))}, false, preset);
    exportResult = { success: true, path: ${jsonLiteral(uxpPath(filePath))}, preset: requestedPreset, pageRange: "all" };
  } catch (error) { exportFailure = error; }
  finally {
    try { preferences.pageRange = previousPageRange; } catch (_) { restorationFailures.push("pdf.pageRange"); }
    try { preferences.useDocumentBleedWithPDF = previousBleed; } catch (_) { restorationFailures.push("pdf.bleed"); }
    try { preferences.cropMarks = previousCropMarks; } catch (_) { restorationFailures.push("pdf.cropMarks"); }
  }`
        : `  const outputDirectory = ${jsonLiteral(folderPath ? uxpPath(folderPath) : null)};
  const singleFilePath = ${jsonLiteral(filePath ? uxpPath(filePath) : null)};
  const requestedPageId = ${Number.isInteger(pageId) ? Number(pageId) : 'null'};
  const requestedPageRange = ${jsonLiteral(pageRange)};
  const preferences = app.pngExportPreferences;
  const previousResolution = preferences.exportResolution;
  const previousTransparent = preferences.transparentBackground;
  const previousRange = preferences.pngExportRange;
  const previousPageString = preferences.pageString;
  const previousExportingSpread = preferences.exportingSpread;
  const rangeEnum = indesign.PNGExportRangeEnum || indesign.ExportRangeOrAllPages;
  const exportRange = rangeEnum && (rangeEnum.EXPORT_RANGE !== undefined ? rangeEnum.EXPORT_RANGE : rangeEnum.exportRange);
  const pngFormat = indesign.ExportFormat && (indesign.ExportFormat.PNG_FORMAT !== undefined ? indesign.ExportFormat.PNG_FORMAT : indesign.ExportFormat.pngFormat);
  if (exportRange === undefined || pngFormat === undefined) { const error = new Error("L’API d’export PNG est indisponible"); error.code = "INDESIGN_API_UNAVAILABLE"; throw error; }
  const parsePageIndexes = (value, pageCount) => {
    if (String(value).trim().toLowerCase() === "all") return Array.from({ length: pageCount }, (_, index) => index);
    const indexes = new Set();
    for (const token of String(value).split(",")) {
      const match = /^(\\d+)(?:-(\\d+))?$/.exec(token.trim());
      if (!match) { const error = new Error("La plage de pages PNG est invalide"); error.code = "PAGE_RANGE_INVALID"; throw error; }
      const start = Number(match[1]); const end = Number(match[2] || match[1]);
      if (start < 1 || end < start || end > pageCount) { const error = new Error("La plage de pages PNG sort du document"); error.code = "PAGE_RANGE_INVALID"; throw error; }
      for (let page = start; page <= end; page += 1) indexes.add(page - 1);
    }
    return [...indexes].sort((left, right) => left - right);
  };
  const exportedPaths = [];
  try {
    preferences.exportResolution = ${Number(resolution)};
    preferences.transparentBackground = ${transparentBackground === true};
    preferences.exportingSpread = false;
    preferences.pngExportRange = exportRange;
    if (requestedPageId !== null) {
      let page = null;
      for (let index = 0; index < targetDocument.pages.length; index += 1) { const candidate = targetDocument.pages.item(index); if (Number(candidate.id) === requestedPageId) { page = candidate; break; } }
      if (!page) { const error = new Error("Page introuvable"); error.code = "PAGE_NOT_FOUND"; throw error; }
      preferences.pageString = "+" + String(Number(page.documentOffset) + 1);
      exportStarted = true;
      await targetDocument.exportFile(pngFormat, singleFilePath, false);
      exportedPaths.push(singleFilePath);
    } else {
      const indexes = parsePageIndexes(requestedPageRange, targetDocument.pages.length);
      for (const index of indexes) {
        const targetPath = outputDirectory.replace(/[\\\\/]$/, "") + "/page-" + String(index + 1).padStart(4, "0") + ".png";
        preferences.pageString = "+" + String(index + 1);
        exportStarted = true;
        await targetDocument.exportFile(pngFormat, targetPath, false);
        exportedPaths.push(targetPath);
      }
    }
    exportResult = { success: true, paths: exportedPaths, resolution: ${Number(resolution)}, pageId: requestedPageId, pageRange: requestedPageRange };
  } catch (error) { exportFailure = error; }
  finally {
    try { preferences.exportResolution = previousResolution; } catch (_) { restorationFailures.push("png.resolution"); }
    try { preferences.transparentBackground = previousTransparent; } catch (_) { restorationFailures.push("png.transparent"); }
    try { preferences.exportingSpread = previousExportingSpread; } catch (_) { restorationFailures.push("png.spread"); }
    try { preferences.pageString = previousPageString; } catch (_) { restorationFailures.push("png.pageString"); }
    try { preferences.pngExportRange = previousRange; } catch (_) { restorationFailures.push("png.range"); }
  }`;

      const body = `  if (app.modalState) { const error = new Error("InDesign affiche une boîte de dialogue modale"); error.code = "INDESIGN_MODAL"; throw error; }
  const wanted = ${Number(documentId)};
  const expectedRevision = ${Number(expectedRevision)};
  const expectedStateToken = ${jsonLiteral(expectedStateToken)};
  const expectedDocuments = ${jsonLiteral(expectedDocuments)};
  const assertExpectedDocuments = (code) => {
    if (app.documents.length !== expectedDocuments.length) { const error = new Error("L’inventaire des documents a changé"); error.code = code; error.requiresInspection = true; throw error; }
    let selected = null;
    for (let index = 0; index < app.documents.length; index += 1) {
      const candidate = app.documents.item(index);
      const expected = expectedDocuments.find((entry) => Number(entry.documentId) === Number(candidate.id));
      const actualRevision = Number.parseInt(candidate.extractLabel(${jsonLiteral(REVISION_LABEL)}) || "0", 10) || 0;
      if (!expected || actualRevision !== Number(expected.revision) || documentStateToken(candidate) !== expected.stateToken) { const error = new Error("Un document a changé pendant l’export"); error.code = code; error.requiresInspection = true; throw error; }
      if (Number(candidate.id) === wanted) selected = candidate;
    }
    if (!selected) { const error = new Error("Document introuvable"); error.code = "DOCUMENT_NOT_FOUND"; throw error; }
    return selected;
  };
  const targetDocument = assertExpectedDocuments("DOCUMENT_STATE_CONFLICT");
  const actualRevision = Number.parseInt(targetDocument.extractLabel(${jsonLiteral(REVISION_LABEL)}) || "0", 10) || 0;
  if (actualRevision !== expectedRevision) { const error = new Error("Le document a changé depuis la dernière lecture"); error.code = "REVISION_CONFLICT"; throw error; }
  if (documentStateToken(targetDocument) !== expectedStateToken) { const error = new Error("Le document a changé depuis la dernière inspection"); error.code = "STATE_CONFLICT"; throw error; }
  const previousInteraction = app.scriptPreferences.userInteractionLevel;
  const previousRedraw = app.scriptPreferences.enableRedraw;
  const restorationFailures = [];
  let exportStarted = false;
  let exportFailure = null;
  let exportResult = null;
  try {
    app.scriptPreferences.userInteractionLevel = indesign.UserInteractionLevels.NEVER_INTERACT !== undefined ? indesign.UserInteractionLevels.NEVER_INTERACT : indesign.UserInteractionLevels.neverInteract;
    app.scriptPreferences.enableRedraw = false;
${exportAction}
  } finally {
    try { app.scriptPreferences.userInteractionLevel = previousInteraction; } catch (_) { restorationFailures.push("interaction"); }
    try { app.scriptPreferences.enableRedraw = previousRedraw; } catch (_) { restorationFailures.push("redraw"); }
  }
  if (restorationFailures.length > 0) { const error = new Error("Les préférences InDesign n’ont pas toutes été restaurées"); error.code = "EXPORT_PREFERENCES_RESTORE_FAILED"; error.requiresInspection = true; throw error; }
  if (exportFailure) {
    if (exportFailure.code === "PACKAGE_REFUSED_BY_CHECKS") assertExpectedDocuments("EXPORT_DOCUMENT_STATE_CHANGED");
    else exportFailure.requiresInspection = exportStarted;
    throw exportFailure;
  }
  const verifiedTarget = assertExpectedDocuments("EXPORT_DOCUMENT_STATE_CHANGED");
  await __writeResult({ ok: true, result: exportResult, documentId: wanted, revision: expectedRevision, stateToken: documentStateToken(verifiedTarget), operationId: __operationId });`;

      const result = await this.#runUxpTracked({ body, operationId });
      const after = await this.#snapshotAllDocuments();
      this.#assertStableSnapshots(expectedDocuments, after, 'Un document a changé pendant l’export silencieux.');
      return { ...result, safetyBackups };
    } catch (error) {
      error.safetyBackups ??= safetyBackups;
      const targetBackup = error.safetyBackups.find((backup) => backup.documentId === documentId);
      error.backupId ??= targetBackup?.backupId;
      error.backupPath ??= targetBackup?.backupPath;
      throw error;
    }
  }

  async executeDocument({ documentId, expectedRevision, expectedStateToken, code, input }) {
    const operationId = crypto.randomUUID();
    return this.#withMutationGuard(operationId, async () => {
    const inventory = await this.listDocuments();
    const documents = Array.isArray(inventory.documents) ? inventory.documents : [];
    const target = documents.find((document) => document.documentId === documentId);
    if (!target) {
      const error = new Error('Document introuvable avant sauvegarde.');
      error.code = 'DOCUMENT_NOT_FOUND';
      throw error;
    }
    if (target.revision !== expectedRevision) {
      const error = new Error('Le document a changé depuis la dernière lecture.');
      error.code = 'REVISION_CONFLICT';
      throw error;
    }
    const inspected = await this.inspectDocument(documentId);
    if (inspected.document.stateToken !== expectedStateToken) {
      const error = new Error('Le contenu ou la structure du document a changé depuis la dernière inspection.');
      error.code = 'STATE_CONFLICT';
      throw error;
    }

    const safetyBackups = await this.#backupDocuments(documents);
    const expectedDocuments = safetyBackups.map(({ documentId: id, revision, stateToken }) => ({ documentId: id, revision, stateToken }));

    const body = `  if (app.modalState) { const error = new Error("InDesign affiche une boîte de dialogue modale"); error.code = "INDESIGN_MODAL"; throw error; }
  const wanted = ${Number(documentId)};
  const expectedRevision = ${Number(expectedRevision)};
  const expectedStateToken = ${jsonLiteral(expectedStateToken)};
  const expectedDocuments = ${jsonLiteral(expectedDocuments)};
  if (app.documents.length !== expectedDocuments.length) { const error = new Error("L’inventaire des documents a changé"); error.code = "DOCUMENT_INVENTORY_CONFLICT"; throw error; }
  let targetDocument = null;
  for (let index = 0; index < app.documents.length; index += 1) {
    const candidate = app.documents.item(index);
    const expected = expectedDocuments.find((entry) => Number(entry.documentId) === Number(candidate.id));
    const actual = Number.parseInt(candidate.extractLabel(${jsonLiteral(REVISION_LABEL)}) || "0", 10) || 0;
    if (!expected || actual !== Number(expected.revision) || documentStateToken(candidate) !== expected.stateToken) { const error = new Error("Un document a changé après les sauvegardes"); error.code = "DOCUMENT_STATE_CONFLICT"; throw error; }
    if (Number(candidate.id) === wanted) targetDocument = candidate;
  }
  if (!targetDocument) { const error = new Error("Document introuvable"); error.code = "DOCUMENT_NOT_FOUND"; throw error; }
  const rawRevision = targetDocument.extractLabel(${jsonLiteral(REVISION_LABEL)});
  const actualRevision = Number.parseInt(rawRevision || "0", 10) || 0;
  if (actualRevision !== expectedRevision) { const error = new Error("Le document a changé depuis la dernière lecture"); error.code = "REVISION_CONFLICT"; throw error; }
  if (documentStateToken(targetDocument) !== expectedStateToken) { const error = new Error("Le document a changé depuis la dernière inspection"); error.code = "STATE_CONFLICT"; throw error; }
  const documentsBefore = [];
  for (let index = 0; index < app.documents.length; index += 1) { const current = app.documents.item(index); const raw = Number.parseInt(current.extractLabel(${jsonLiteral(REVISION_LABEL)}) || "0", 10) || 0; documentsBefore.push({ doc: current, documentId: Number(current.id), revision: raw }); }
  const userInput = ${jsonLiteral(input ?? null)};
  const userCode = ${jsonLiteral(code)};
  const previousInteraction = app.scriptPreferences.userInteractionLevel;
  const previousRedraw = app.scriptPreferences.enableRedraw;
  let mutationStarted = false;
  let revisionsWritten = false;
  const advanceRevisions = () => {
    if (revisionsWritten) return [];
    revisionsWritten = true;
    const revisions = [];
    for (const entry of documentsBefore) { try { if (entry.doc && entry.doc.isValid !== false) { const next = entry.revision + 1; entry.doc.insertLabel(${jsonLiteral(REVISION_LABEL)}, String(next)); revisions.push({ documentId: entry.documentId, revision: next }); } } catch (_) {} }
    return revisions;
  };
  let outcome;
  try {
    app.scriptPreferences.userInteractionLevel = indesign.UserInteractionLevels.NEVER_INTERACT !== undefined ? indesign.UserInteractionLevels.NEVER_INTERACT : indesign.UserInteractionLevels.neverInteract;
    app.scriptPreferences.enableRedraw = false;
    mutationStarted = true;
    const executeUserCode = new Function("app", "indesign", "doc", "input", '"use strict"; return (async function () {\\n' + userCode + '\\n}).call(null);');
    const value = await executeUserCode(app, indesign, targetDocument, userInput);
    const revisions = advanceRevisions();
    const currentTarget = revisions.find((entry) => entry.documentId === wanted);
    outcome = { ok: true, result: value === undefined ? null : value, documentId: wanted, revision: currentTarget ? currentTarget.revision : null, revisions, stateToken: targetDocument && targetDocument.isValid !== false ? documentStateToken(targetDocument) : null, operationId: __operationId };
  } catch (error) {
    if (mutationStarted) advanceRevisions();
    error.requiresInspection = mutationStarted;
    throw error;
  } finally {
    try { app.scriptPreferences.userInteractionLevel = previousInteraction; } catch (_) {}
    try { app.scriptPreferences.enableRedraw = previousRedraw; } catch (_) {}
  }
  await __writeResult(outcome);`;

    try {
      const result = await this.#runUxpTracked({ body, operationId });
      return { ...result, safetyBackups };
    } catch (error) {
      error.safetyBackups = safetyBackups;
      error.backupId = safetyBackups.find((backup) => backup.documentId === documentId)?.backupId;
      error.backupPath = safetyBackups.find((backup) => backup.documentId === documentId)?.backupPath;
      throw error;
    }
    });
  }

  // Outil rapide : contrôle d'état, sauvegarde de tous les documents ouverts, script, enregistrement optionnel et
  // aperçu PNG en un seul passage UXP suivi (verrou durable, réconciliation si l'issue est inconnue). Un échec du
  // script lui-même est une issue connue : il est renvoyé avec les sauvegardes, sans bloquer les commandes suivantes.
  async runLayoutScript({ documentId, expectedRevision, expectedStateToken, code, input, save = false, close = false, previewPages, previewResolution = 96 }) {
    if (close && !save) {
      const error = new Error('close exige save=true : fermer sans enregistrer perdrait le travail du script.');
      error.code = 'CLOSE_REQUIRES_SAVE';
      throw error;
    }
    const operationId = crypto.randomUUID();
    return this.#withMutationGuard(operationId, async () => {
    const slots = Array.from({ length: FAST_BACKUP_SLOTS }, () => {
      const backupId = crypto.randomUUID();
      return { backupId, backupPath: path.join(this.backupDirectory, `backup-${backupId}.indd`) };
    });
    const previewDirectory = path.join(this.backupDirectory, 'previews');
    await fs.mkdir(previewDirectory, { recursive: true });
    const previewPath = path.join(previewDirectory, `${operationId}.png`);
    const body = `  if (app.modalState) { const error = new Error("InDesign affiche une boîte de dialogue modale"); error.code = "INDESIGN_MODAL"; throw error; }
  const wanted = ${Number(documentId)};
  const expectedRevision = ${Number(expectedRevision)};
  const expectedStateToken = ${jsonLiteral(expectedStateToken)};
  const slots = ${jsonLiteral(slots.map((slot) => uxpPath(slot.backupPath)))};
  const label = ${jsonLiteral(REVISION_LABEL)};
  if (app.documents.length > slots.length) { const error = new Error("Trop de documents ouverts pour l’outil rapide"); error.code = "TOO_MANY_OPEN_DOCUMENTS"; throw error; }
  const readRevision = (doc) => Number.parseInt(doc.extractLabel(label) || "0", 10) || 0;
  const open = [];
  let target = null;
  for (let index = 0; index < app.documents.length; index += 1) {
    const doc = app.documents.item(index);
    const entry = { doc, documentId: Number(doc.id), revision: readRevision(doc), stateToken: documentStateToken(doc) };
    open.push(entry);
    if (entry.documentId === wanted) target = entry;
  }
  if (!target) { const error = new Error("Document introuvable"); error.code = "DOCUMENT_NOT_FOUND"; throw error; }
  if (target.revision !== expectedRevision) { const error = new Error("Le document a changé depuis la dernière lecture"); error.code = "REVISION_CONFLICT"; throw error; }
  if (target.stateToken !== expectedStateToken) { const error = new Error("Le document a changé depuis la dernière inspection"); error.code = "STATE_CONFLICT"; throw error; }
  // Document enregistré et sans modification en cours : son fichier est exactement son état, la sauvegarde est une
  // copie d'octets (rapide, et absente des fichiers récents d'InDesign). Sinon saveACopy.
  // UXP : fullName est une promesse (chaîne ou objet fichier selon la version).
  const sourcePathOf = async (doc) => {
    try {
      const name = await doc.fullName;
      const value = typeof name === "string" ? name : (name && (name.fsName || name.nativePath)) || "";
      return /\\.indd$/i.test(value) ? value : "";
    } catch (_) { return ""; }
  };
  const backups = [];
  for (let index = 0; index < open.length; index += 1) {
    const entry = open[index];
    let method = "saveACopy";
    const source = entry.doc.saved && !entry.doc.modified ? await sourcePathOf(entry.doc) : "";
    if (source) {
      try { await fs.writeFile(slots[index], await fs.readFile(source)); method = "copy"; }
      catch (_) { method = "saveACopy"; }
    }
    if (method === "saveACopy") entry.doc.saveACopy(slots[index]);
    backups.push({ slot: index, documentId: entry.documentId, revision: entry.revision, stateToken: entry.stateToken, method });
  }
  const userInput = ${jsonLiteral(input ?? null)};
  const userCode = ${jsonLiteral(code)};
  const previousInteraction = app.scriptPreferences.userInteractionLevel;
  const previousRedraw = app.scriptPreferences.enableRedraw;
  let value = null;
  let scriptError = null;
  try {
    app.scriptPreferences.userInteractionLevel = indesign.UserInteractionLevels.NEVER_INTERACT !== undefined ? indesign.UserInteractionLevels.NEVER_INTERACT : indesign.UserInteractionLevels.neverInteract;
    app.scriptPreferences.enableRedraw = false;
    const executeUserCode = new Function("app", "indesign", "doc", "input", '"use strict"; return (async function () {\\n' + userCode + '\\n}).call(null);');
    value = await executeUserCode(app, indesign, target.doc, userInput);
  } catch (error) {
    scriptError = { message: String(error && error.message ? error.message : error), line: error && error.line !== undefined ? Number(error.line) : null };
  } finally {
    try { app.scriptPreferences.userInteractionLevel = previousInteraction; } catch (_) {}
    try { app.scriptPreferences.enableRedraw = previousRedraw; } catch (_) {}
  }
  // Seuls les documents dont l'empreinte a changé avancent : un document non touché (cible d'un script de lecture
  // compris) garde sa révision et son jeton, et n'est pas marqué modifié par l'étiquette de révision.
  const revisions = [];
  for (const entry of open) {
    try {
      if (entry.doc && entry.doc.isValid !== false) {
        const after = documentStateToken(entry.doc);
        if (after !== entry.stateToken) {
          const next = entry.revision + 1;
          entry.doc.insertLabel(label, String(next));
          revisions.push({ documentId: entry.documentId, revision: next, stateToken: after });
        }
      }
    } catch (_) {}
  }
  const targetValid = target.doc && target.doc.isValid !== false;
  let saved = false;
  if (${save ? 'true' : 'false'} && targetValid && !scriptError) { target.doc.save(); saved = true; }
  let preview = null;
  if (targetValid) {
    try {
      const prefs = app.pngExportPreferences;
      const previous = { range: prefs.pngExportRange, pages: prefs.pageString, resolution: prefs.exportResolution };
      prefs.pngExportRange = indesign.PNGExportRangeEnum.EXPORT_RANGE;
      prefs.pageString = ${previewPages ? jsonLiteral(previewPages) : 'String(target.doc.pages.item(0).name)'};
      prefs.exportResolution = ${Number(previewResolution)};
      const pages = String(prefs.pageString);
      target.doc.exportFile(indesign.ExportFormat.PNG_FORMAT, ${jsonLiteral(uxpPath(previewPath))}, false);
      try { prefs.pngExportRange = previous.range; prefs.pageString = previous.pages; prefs.exportResolution = previous.resolution; } catch (_) {}
      preview = { pages };
    } catch (error) { preview = { error: String(error && error.message ? error.message : error) }; }
  }
  const current = revisions.find((entry) => entry.documentId === wanted);
  const finalStateToken = targetValid ? documentStateToken(target.doc) : null;
  let closed = false;
  if (${close ? 'true' : 'false'} && saved) { await target.doc.close(indesign.SaveOptions.NO); closed = true; }
  await __writeResult({
    ok: true,
    scriptOk: scriptError === null,
    scriptError,
    result: value === undefined ? null : value,
    documentId: wanted,
    revision: current ? current.revision : target.revision,
    stateToken: closed ? null : finalStateToken,
    revisions,
    saved,
    closed,
    backups,
    preview,
    operationId: __operationId
  });`;
    const outcome = await this.#runUxpTracked({ body, operationId });
    const safetyBackups = [];
    for (const backup of Array.isArray(outcome.backups) ? outcome.backups : []) {
      const slot = slots[backup.slot];
      if (!slot) {
        const error = new Error('La sauvegarde rapide ne correspond à aucun emplacement signé localement.');
        error.code = 'BACKUP_RESPONSE_MISMATCH';
        throw error;
      }
      const metadata = await this.#writeBackupMetadata({ backupId: slot.backupId, backupPath: slot.backupPath, documentId: backup.documentId, revision: backup.revision, stateToken: backup.stateToken });
      safetyBackups.push({ documentId: backup.documentId, revision: backup.revision, stateToken: backup.stateToken, backupId: slot.backupId, backupPath: slot.backupPath, metadataPath: metadata.metadataPath, artifactSha256: metadata.artifact.sha256, method: backup.method === 'copy' ? 'copy' : 'saveACopy' });
    }
    const previewFiles = (await fs.readdir(previewDirectory).catch(() => []))
      .filter((name) => name.startsWith(operationId) && name.endsWith('.png'))
      .map((name) => path.join(previewDirectory, name))
      .sort();
    for (const file of previewFiles) await verifyArtifact({ targetPath: file, kind: 'png' });
    const { backups: _backups, ...rest } = outcome;
    return {
      ...rest,
      previewPaths: previewFiles,
      safetyBackups,
      backupId: safetyBackups.find((backup) => backup.documentId === documentId)?.backupId,
      ...(outcome.scriptOk ? {} : { requiresInspection: true, nextStep: 'Le script a échoué : relisez l’aperçu, corrigez puis relancez, ou restaurez avec silent_restore_backup et backupId.' }),
    };
    });
  }

  async restoreBackup({ documentId, expectedRevision, expectedStateToken, backupId }) {
    if (!BACKUP_ID_PATTERN.test(backupId ?? '')) {
      const error = new Error('Identifiant de sauvegarde silencieuse invalide.');
      error.code = 'BACKUP_ID_INVALID';
      throw error;
    }
    const backupPath = path.join(this.backupDirectory, `backup-${backupId}.indd`);
    const backupMetadata = await this.#readBackupMetadata({ backupId, backupPath, documentId });
    const operationId = crypto.randomUUID();
    return this.#withMutationGuard(operationId, async () => {
    const inventory = await this.listDocuments();
    const documents = Array.isArray(inventory.documents) ? inventory.documents : [];
    const target = documents.find((document) => document.documentId === documentId);
    if (!target) {
      const error = new Error('Document à restaurer introuvable.');
      error.code = 'DOCUMENT_NOT_FOUND';
      throw error;
    }
    if (target.revision !== expectedRevision) {
      const error = new Error('Le document a changé depuis la dernière lecture.');
      error.code = 'REVISION_CONFLICT';
      throw error;
    }
    const inspected = await this.inspectDocument(documentId);
    if (inspected.document.stateToken !== expectedStateToken) {
      const error = new Error('Le document a changé depuis la dernière inspection.');
      error.code = 'STATE_CONFLICT';
      throw error;
    }
    const recoveryBackups = await this.#backupDocuments(documents);
    const expectedDocuments = recoveryBackups.map(({ documentId: id, revision, stateToken }) => ({ documentId: id, revision, stateToken }));
    const restoredDirectory = path.join(this.backupDirectory, 'restored');
    await fs.mkdir(restoredDirectory, { recursive: true });
    const restoredDirectoryStat = await fs.lstat(restoredDirectory);
    if (!restoredDirectoryStat.isDirectory() || restoredDirectoryStat.isSymbolicLink()) {
      const error = new Error('Le dossier privé des copies restaurées est invalide.');
      error.code = 'RESTORED_DIRECTORY_INVALID';
      throw error;
    }
    await this.protect(restoredDirectory, { kind: 'directory', recursive: true });
    const restoredWorkingPath = path.join(restoredDirectory, `restore-${crypto.randomUUID()}.indd`);
    const restoredMarkerPath = restoredWorkingPath.replace(/\.indd$/i, '.open.json');
    const restoredMarker = {
      schemaVersion: 1,
      operationId,
      backupId,
      workingFile: path.basename(restoredWorkingPath),
      status: 'reserved-or-open',
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(restoredMarkerPath, JSON.stringify(restoredMarker), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await this.protect(restoredMarkerPath, { kind: 'file' });
    try {
      await fs.copyFile(backupPath, restoredWorkingPath, fs.constants.COPYFILE_EXCL);
      await this.#validateBackupArtifact(restoredWorkingPath);
    } catch (error) {
      await fs.unlink(restoredWorkingPath).catch(() => {});
      await fs.unlink(restoredMarkerPath).catch(() => {});
      throw error;
    }
    const body = `  if (app.modalState) { const error = new Error("InDesign affiche une boîte de dialogue modale"); error.code = "INDESIGN_MODAL"; throw error; }
  const wanted = ${Number(documentId)};
  const expectedRevision = ${Number(expectedRevision)};
  const expectedStateToken = ${jsonLiteral(expectedStateToken)};
  const expectedDocuments = ${jsonLiteral(expectedDocuments)};
  if (app.documents.length !== expectedDocuments.length) { const error = new Error("L’inventaire des documents a changé"); error.code = "DOCUMENT_INVENTORY_CONFLICT"; throw error; }
  let current = null;
  for (let index = 0; index < app.documents.length; index += 1) {
    const candidate = app.documents.item(index);
    const expected = expectedDocuments.find((entry) => Number(entry.documentId) === Number(candidate.id));
    const actual = Number.parseInt(candidate.extractLabel(${jsonLiteral(REVISION_LABEL)}) || "0", 10) || 0;
    if (!expected || actual !== Number(expected.revision) || documentStateToken(candidate) !== expected.stateToken) { const error = new Error("Un document a changé après les sauvegardes"); error.code = "DOCUMENT_STATE_CONFLICT"; throw error; }
    if (Number(candidate.id) === wanted) current = candidate;
  }
  if (!current) { const error = new Error("Document introuvable"); error.code = "DOCUMENT_NOT_FOUND"; throw error; }
  const actualRevision = Number.parseInt(current.extractLabel(${jsonLiteral(REVISION_LABEL)}) || "0", 10) || 0;
  if (actualRevision !== expectedRevision) { const error = new Error("Le document a changé depuis la dernière lecture"); error.code = "REVISION_CONFLICT"; throw error; }
  if (documentStateToken(current) !== expectedStateToken) { const error = new Error("Le document a changé depuis la dernière inspection"); error.code = "STATE_CONFLICT"; throw error; }
  const previousInteraction = app.scriptPreferences.userInteractionLevel;
  const previousRedraw = app.scriptPreferences.enableRedraw;
  let opened = null;
  let mutationStarted = false;
  let outcome;
  try {
    app.scriptPreferences.userInteractionLevel = indesign.UserInteractionLevels.NEVER_INTERACT !== undefined ? indesign.UserInteractionLevels.NEVER_INTERACT : indesign.UserInteractionLevels.neverInteract;
    app.scriptPreferences.enableRedraw = false;
    mutationStarted = true;
    opened = await app.open(${jsonLiteral(uxpPath(restoredWorkingPath))}, true);
    if (Number(opened.id) === wanted) { const error = new Error("La copie restaurée a réutilisé l’identifiant courant"); error.code = "RESTORE_COLLISION"; throw error; }
    await current.close(indesign.SaveOptions.no);
    const closeDeadline = Date.now() + 10000;
    let currentStillOpen = true;
    while (currentStillOpen && Date.now() < closeDeadline) {
      currentStillOpen = false;
      for (let index = 0; index < app.documents.length; index += 1) {
        if (Number(app.documents.item(index).id) === wanted) { currentStillOpen = true; break; }
      }
      if (currentStillOpen) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (currentStillOpen) { const error = new Error("La fermeture du document remplacé n’a pas été confirmée"); error.code = "RESTORE_CLOSE_NOT_CONFIRMED"; throw error; }
    const restoredRevision = expectedRevision + 1;
    opened.insertLabel(${jsonLiteral(REVISION_LABEL)}, String(restoredRevision));
    outcome = { ok: true, restoredDocumentId: Number(opened.id), originalDocumentId: wanted, revision: restoredRevision, stateToken: documentStateToken(opened), operationId: __operationId };
  } catch (error) {
    error.requiresInspection = mutationStarted;
    if (!mutationStarted && opened && opened.isValid !== false) { try { await opened.close(indesign.SaveOptions.no); } catch (_) {} }
    throw error;
  } finally {
    try { app.scriptPreferences.userInteractionLevel = previousInteraction; } catch (_) {}
    try { app.scriptPreferences.enableRedraw = previousRedraw; } catch (_) {}
  }

  await __writeResult(outcome);`;
    try {
      const result = await this.#runUxpTracked({ body, operationId });
      return {
        ...result,
        restoredFromBackupId: backupId,
        restoredSourceRevision: backupMetadata.revision,
        restoredSourceStateToken: backupMetadata.stateToken,
        restoredWorkingPath,
        recoveryBackups,
      };
    } catch (error) {
      error.safetyBackups = recoveryBackups;
      const targetRecovery = recoveryBackups.find((backup) => backup.documentId === documentId);
      error.backupId = targetRecovery?.backupId;
      error.backupPath = targetRecovery?.backupPath;
      if (error.requiresInspection !== true) {
        await fs.unlink(restoredWorkingPath).catch(() => {});
        await fs.unlink(restoredMarkerPath).catch(() => {});
      }
      throw error;
    }
    });
  }

  async registerExternalBackup({ backupId, backupPath, documentId, revision, stateToken }) {
    if (!BACKUP_ID_PATTERN.test(backupId ?? '')) {
      const error = new Error('Identifiant de sauvegarde externe invalide.');
      error.code = 'BACKUP_ID_INVALID';
      throw error;
    }
    const expectedPath = path.join(this.backupDirectory, `backup-${backupId}.indd`);
    if (path.resolve(backupPath ?? '') !== path.resolve(expectedPath)) {
      const error = new Error('La sauvegarde externe ne se trouve pas dans le stockage privé attendu.');
      error.code = 'BACKUP_PATH_MISMATCH';
      throw error;
    }
    return this.#writeBackupMetadata({ backupId, backupPath: expectedPath, documentId, revision, stateToken });
  }

  async #backupDocuments(documents) {
    const safetyBackups = [];
    try {
      const sourceSnapshots = await this.#snapshotAllDocuments();
      this.#assertInventoryMatches(documents, sourceSnapshots);
      for (const document of sourceSnapshots) {
        const backupId = crypto.randomUUID();
        const backupPath = path.join(this.backupDirectory, `backup-${backupId}.indd`);
        await this.#createBackup({ documentId: document.documentId, expectedRevision: document.revision, backupPath, backupId });
        const verified = await this.inspectDocument(document.documentId);
        this.#assertStableSnapshots([document], [verified.document], 'Le document a changé pendant sa sauvegarde.');
        const metadata = await this.#writeBackupMetadata({ backupId, backupPath, ...document });
        safetyBackups.push({
          documentId: document.documentId,
          revision: document.revision,
          stateToken: document.stateToken,
          backupId,
          backupPath,
          metadataPath: metadata.metadataPath,
          artifactSha256: metadata.artifact.sha256,
        });
      }
      const finalSnapshots = await this.#snapshotAllDocuments();
      this.#assertStableSnapshots(sourceSnapshots, finalSnapshots, 'Les documents ont changé pendant la série de sauvegardes.');
    } catch (error) {
      error.safetyBackups = safetyBackups;
      throw error;
    }
    return safetyBackups;
  }

  async #validateBackupArtifact(backupPath) {
    const stat = await fs.lstat(backupPath).catch((error) => {
      if (error.code === 'ENOENT') {
        const missing = new Error('La copie INDD de sécurité est introuvable.');
        missing.code = 'BACKUP_ARTIFACT_MISSING';
        throw missing;
      }
      throw error;
    });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
      const error = new Error('La copie INDD de sécurité est vide ou invalide.');
      error.code = 'BACKUP_ARTIFACT_INVALID';
      throw error;
    }
    await this.protect(backupPath, { kind: 'file' });
    try {
      await verifyArtifact({ targetPath: backupPath, kind: 'indd' });
    } catch (cause) {
      const error = new Error('La copie INDD de sécurité ne possède pas une structure binaire InDesign crédible.');
      error.code = 'BACKUP_ARTIFACT_INVALID';
      error.cause = cause;
      throw error;
    }
    return stat;
  }

  async #writeBackupMetadata({ backupId, backupPath, documentId, revision, stateToken }) {
    if (!BACKUP_ID_PATTERN.test(backupId) || !Number.isInteger(documentId) || !Number.isInteger(revision) || revision < 0 || !STATE_TOKEN_PATTERN.test(stateToken ?? '')) {
      const error = new Error('La provenance de la sauvegarde silencieuse est invalide.');
      error.code = 'BACKUP_PROVENANCE_INVALID';
      throw error;
    }
    const before = await this.#validateBackupArtifact(backupPath);
    const sha256 = await sha256File(backupPath);
    const after = await fs.lstat(backupPath);
    if (!after.isFile() || after.isSymbolicLink() || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      const error = new Error('La sauvegarde a changé pendant le calcul de son empreinte.');
      error.code = 'BACKUP_ARTIFACT_UNSTABLE';
      throw error;
    }
    const metadataPath = path.join(this.backupDirectory, `backup-${backupId}.meta.json`);
    const metadata = {
      schemaVersion: BACKUP_METADATA_VERSION,
      backupId,
      documentId,
      revision,
      stateToken,
      createdAt: new Date().toISOString(),
      artifact: { fileName: path.basename(backupPath), size: after.size, sha256 },
    };
    try {
      await fs.writeFile(metadataPath, JSON.stringify(metadata), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await this.protect(metadataPath, { kind: 'file' });
    } catch (error) {
      await fs.unlink(metadataPath).catch(() => {});
      throw error;
    }
    return { ...metadata, metadataPath };
  }

  async #readBackupMetadata({ backupId, backupPath, documentId }) {
    const metadataPath = path.join(this.backupDirectory, `backup-${backupId}.meta.json`);
    const stat = await fs.lstat(metadataPath).catch((error) => {
      if (error.code === 'ENOENT') {
        const missing = new Error('La provenance privée de la sauvegarde est introuvable.');
        missing.code = 'BACKUP_METADATA_MISSING';
        throw missing;
      }
      throw error;
    });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > 16_384) {
      const error = new Error('La provenance privée de la sauvegarde est invalide.');
      error.code = 'BACKUP_METADATA_INVALID';
      throw error;
    }
    await this.protect(metadataPath, { kind: 'file' });
    let metadata;
    try { metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')); }
    catch {
      const error = new Error('La provenance privée de la sauvegarde est illisible.');
      error.code = 'BACKUP_METADATA_INVALID';
      throw error;
    }
    const valid = metadata?.schemaVersion === BACKUP_METADATA_VERSION
      && metadata.backupId === backupId
      && metadata.documentId === documentId
      && Number.isInteger(metadata.revision) && metadata.revision >= 0
      && STATE_TOKEN_PATTERN.test(metadata.stateToken ?? '')
      && metadata.artifact?.fileName === path.basename(backupPath)
      && Number.isInteger(metadata.artifact.size) && metadata.artifact.size > 0
      && /^[a-f0-9]{64}$/.test(metadata.artifact.sha256 ?? '');
    if (!valid) {
      const error = new Error('La sauvegarde ne correspond pas au document demandé ou sa provenance est invalide.');
      error.code = 'BACKUP_PROVENANCE_MISMATCH';
      throw error;
    }
    const artifactStat = await this.#validateBackupArtifact(backupPath);
    const artifactSha256 = await sha256File(backupPath);
    if (artifactStat.size !== metadata.artifact.size || artifactSha256 !== metadata.artifact.sha256) {
      const error = new Error('La sauvegarde ne correspond plus à sa provenance privée.');
      error.code = 'BACKUP_INTEGRITY_FAILED';
      throw error;
    }
    return { ...metadata, metadataPath };
  }

  async #createBackup({ documentId, expectedRevision, backupPath, backupId }) {
    const source = `(function () {
  var wanted = ${Number(documentId)};
  var expected = ${Number(expectedRevision)};
  var label = ${jsonLiteral(REVISION_LABEL)};
  var doc = null;
  for (var index = 0; index < app.documents.length; index += 1) { if (Number(app.documents.item(index).id) === wanted) { doc = app.documents.item(index); break; } }
  if (!doc) { return "ERR|DOCUMENT_NOT_FOUND|Document introuvable"; }
  var actual = parseInt(doc.extractLabel(label) || "0", 10) || 0;
  if (actual !== expected) { return "ERR|REVISION_CONFLICT|Le document a change depuis la derniere lecture"; }
  try { doc.saveACopy(File(${jsonLiteral(uxpPath(backupPath))})); }
  catch (error) { return "ERR|BACKUP_FAILED|" + String(error && error.message ? error.message : error); }
  return "OK|" + ${jsonLiteral(backupId)} + "|" + wanted + "|" + actual;
}());`;
    const result = await this.#runScript({ language: 'JAVASCRIPT', extension: '.jsx', source });
    const fields = String(result).split('|');
    if (fields[0] === 'ERR') {
      const error = new Error(fields.slice(2).join('|') || 'La sauvegarde InDesign a échoué.');
      error.code = fields[1] || 'BACKUP_FAILED';
      throw error;
    }
    if (fields[0] !== 'OK' || fields.length !== 4) throw new Error('Réponse de sauvegarde InDesign invalide.');
    if (fields[1] !== backupId || Number(fields[2]) !== documentId || Number(fields[3]) !== expectedRevision) {
      const error = new Error('La sauvegarde InDesign ne correspond pas à la requête signée localement.');
      error.code = 'BACKUP_RESPONSE_MISMATCH';
      throw error;
    }
    await this.#validateBackupArtifact(backupPath);
    return { ok: true, backupId: fields[1], documentId: Number(fields[2]), revision: Number(fields[3]) };
  }

  async #runUxpSync(source, { timeoutMs = this.timeoutMs } = {}) {
    assertGeneratedSyncUxpSyntax(source);
    return parseUxpResult(await this.#runScript({ language: 'UXP', extension: '.idjs', source, timeoutMs }));
  }

  async #runUxpRead(body, { timeoutMs = this.timeoutMs } = {}) {
    const operationId = crypto.randomUUID();
    const resultPath = path.join(this.runtimeDirectory, `${operationId}.result.json`);
    const source = asyncUxpEnvelope({ body, resultPath, maxResultBytes: this.maxResultBytes, operationId });
    assertGeneratedUxpSyntax(source);
    try {
      await this.#runScript({ language: 'UXP', extension: '.idjs', source, completionPath: resultPath, timeoutMs });
      const result = await this.#waitForResult(resultPath, operationId, timeoutMs);
      return parseUxpResult(result);
    } catch (error) {
      if (error.code === 'UXP_OUTCOME_UNKNOWN') {
        error.code = 'UXP_READ_OUTCOME_UNKNOWN';
        error.message = 'La lecture UXP asynchrone n’a pas produit de résultat vérifiable.';
      }
      throw error;
    } finally {
      await fs.unlink(resultPath).catch(() => {});
    }
  }

  async #withMutationGuard(operationId, callback) {
    await this.#acquireMutationLease(operationId);
    let mutexGuard;
    try {
      mutexGuard = await this.#acquireSilentOperationGuard(operationId);
      if (mutexGuard.status === 'abandoned') {
        const error = new Error('Le mutex commun InDesign a été abandonné; l’issue précédente doit être réconciliée avant toute nouvelle commande.');
        error.code = 'INDESIGN_MUTEX_ABANDONED';
        error.operationId = operationId;
        error.requiresInspection = true;
        throw error;
      }
      const result = await this.mutationContext.run({ operationId }, callback);
      await this.#releaseMutationLease(operationId);
      const completedOperation = this.pendingOperations.get(operationId);
      this.pendingOperations.delete(operationId);
      if (completedOperation) {
        await fs.unlink(completedOperation.resultPath).catch(() => {});
        await fs.unlink(completedOperation.scriptPath).catch(() => {});
      }
      return result;
    } catch (error) {
      error.operationId ??= operationId;
      if (error.requiresInspection !== true) {
        if (mutexGuard) await this.#releaseMutationLease(operationId);
        else await this.#discardUnstartedSilentOperation(operationId);
      }
      throw error;
    }
  }

  async #runUxpTracked({ body, operationId, timeoutMs = this.timeoutMs }) {
    const active = this.mutationContext.getStore();
    if (!active || active.operationId !== operationId) {
      return this.#withMutationGuard(operationId, () => this.#runUxpTracked({ body, operationId, timeoutMs }));
    }
    const resultPath = path.join(this.runtimeDirectory, `${operationId}.result.json`);
    const scriptPath = path.join(this.runtimeDirectory, `${operationId}.idjs`);
    const source = asyncUxpEnvelope({ body, resultPath, maxResultBytes: this.maxResultBytes, operationId });
    assertGeneratedUxpSyntax(source);
    try {
      this.pendingOperations.set(operationId, { resultPath, scriptPath, launchedAt: new Date().toISOString(), retainedUntil: new Date(Date.now() + RUNTIME_RETENTION_MS).toISOString() });
      await this.#runScript({
        language: 'UXP',
        extension: '.idjs',
        source,
        scriptPath,
        retain: true,
        completionPath: resultPath,
        timeoutMs,
        mutationDispatch: true,
        runScript: (options) => this.#runThroughSilentOperationGuard(operationId, options),
      });
      const result = await this.#waitForResult(resultPath, operationId, timeoutMs);
      await this.protect(resultPath, { kind: 'file' });
      const parsed = parseUxpResult(result);
      return parsed;
    } catch (error) {
      error.operationId ??= operationId;
      if (
        error.requiresInspection === true
        && !this.pendingOperations.has(operationId)
        && this.operationMutexGuards.has(operationId)
      ) {
        this.pendingOperations.set(operationId, {
          resultPath,
          scriptPath,
          launchedAt: new Date().toISOString(),
          retainedUntil: new Date(Date.now() + RUNTIME_RETENTION_MS).toISOString(),
        });
        const state = await this.#readResult(resultPath);
        if (state.pending) {
          await fs.writeFile(resultPath, JSON.stringify({
            ok: false,
            code: 'INDESIGN_MUTEX_GUARD_STATE_UNKNOWN',
            operationId,
            requiresInspection: true,
          }), { encoding: 'utf8', mode: 0o600, flag: 'wx' }).catch((writeError) => {
            if (writeError.code !== 'EEXIST') throw writeError;
          });
          await this.protect(resultPath, { kind: 'file' });
        }
      }
      if (error.requiresInspection !== true) {
        this.pendingOperations.delete(operationId);
        await fs.unlink(resultPath).catch(() => {});
        await fs.unlink(scriptPath).catch(() => {});
      }
      throw error;
    }
  }

  async #readResult(resultPath) {
    const stat = await fs.lstat(resultPath).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return { pending: true };
    await this.protect(resultPath, { kind: 'file' });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Le fichier résultat UXP n’est pas un fichier privé normal.');
    if (stat.size > this.maxResultBytes) {
      const error = new Error('Le résultat UXP dépasse la taille maximale autorisée.');
      error.code = 'RESULT_TOO_LARGE_AFTER_MUTATION';
      error.requiresInspection = true;
      throw error;
    }
    const raw = await fs.readFile(resultPath, 'utf8');
    try {
      const result = JSON.parse(raw);
      return { pending: false, result };
    }
    catch { return { pending: true }; }
  }

  async #waitForResult(resultPath, operationId, timeoutMs = this.timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const state = await this.#readResult(resultPath);
        if (!state.pending) return state.result;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const error = new Error('Le délai UXP est dépassé; l’issue peut être indéterminée. Inspectez le document avant toute nouvelle action.');
    error.code = 'UXP_OUTCOME_UNKNOWN';
    error.operationId = operationId;
    error.requiresInspection = true;
    throw error;
  }

  async #runScript({ language, extension, source, scriptPath: requestedScriptPath, retain = false, completionPath, timeoutMs = this.timeoutMs, mutationDispatch = false, runScript }) {
    const scriptPath = requestedScriptPath ?? path.join(this.runtimeDirectory, `${crypto.randomUUID()}${extension}`);
    await fs.writeFile(scriptPath, source, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      await this.protect(scriptPath, { kind: 'file' });
      const args = ['-NoProfile', '-NonInteractive', '-File', POWERSHELL_LAUNCHER, '-ScriptPath', scriptPath, '-Language', language, '-RuntimeRoot', path.dirname(this.runtimeRoot)];
      if (completionPath) args.push('-CompletionPath', completionPath, '-CompletionTimeoutMs', String(timeoutMs));
      const expectedExternalLease = this.externalLeaseContext.getStore();
      if (expectedExternalLease?.operationId) args.push('-ExpectedLeaseOperationId', expectedExternalLease.operationId);
      const activeMutation = this.mutationContext.getStore();
      const privateRun = runScript
        ?? (activeMutation ? (options) => this.#runThroughSilentOperationGuard(activeMutation.operationId, options) : undefined)
        ?? this.reconciliationRunScript;
      const { stdout } = privateRun
        ? await privateRun({
          scriptPath,
          language,
          completionPath,
          completionTimeoutMs: timeoutMs,
          mutationDispatch,
        })
        : await this.run('pwsh.exe', args, {
          windowsHide: true,
          timeout: completionPath ? (timeoutMs * 2) + 5_000 : timeoutMs,
          maxBuffer: this.maxResultBytes,
          env: minimalWindowsEnvironment(),
        });
      const envelope = JSON.parse(String(stdout).trim());
      if (!envelope.ok) throw new Error('L’appel COM InDesign a échoué.');
      return envelope.result;
    } catch (error) {
      // Once an asynchronous UXP script has been handed to InDesign, a launcher
      // failure cannot prove that the mutation did not start.  Treat every
      // non-zero launcher outcome as indeterminate and force reconciliation.
      if (completionPath) {
        error.code = 'UXP_OUTCOME_UNKNOWN';
        error.requiresInspection = true;
      } else if (error.killed || error.code === 'ETIMEDOUT') {
        error.code = 'COM_TIMEOUT_OUTCOME_UNKNOWN';
        error.requiresInspection = true;
      }
      throw error;
    } finally {
      if (!retain) await fs.unlink(scriptPath).catch(() => {});
    }
  }
}

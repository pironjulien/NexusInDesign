#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REQUEST_TIMEOUT_MS = 180_000;
const BRIDGE_WAIT_MS = 45_000;
const REQUIRED_TOOLS = [
  'bridge_status',
  'bridge_operation_status',
  'ping',
  'list_documents',
  'silent_list_documents',
  'silent_inspect_document',
  'silent_close_document',
  'silent_reconcile_unknown_operation',
  'create_document',
  'create_color_swatch',
  'execute_uxp',
  'get_document_colors',
];
const SAFE_FAILURE_CODES = new Set([
  'NODE_VERSION_INVALID',
  'SECURE_ROOT_MISSING',
  'TOKEN_FILE_INVALID',
  'TOOL_CATALOG_INCOMPLETE',
  'BRIDGE_NOT_READY',
  'BASELINE_NOT_ZERO',
  'DOCUMENT_CREATION_FAILED',
  'DOCUMENT_SET_CHANGED',
  'ACTIVE_DECOY_NOT_CONFIRMED',
  'LEGACY_CALL_FAILED',
  'MCP_CALL_FAILED',
  'DOCUMENT_INSPECTION_FAILED',
]);

const TARGET_PROBE_CODE = `
  if (!targetDocument || targetDocument.isValid === false) {
    return {
      success: true,
      targetValid: false,
      targetIdMatches: false,
      ownMarkerPresent: false,
      foreignMarkerPresent: false,
      pageCountMatches: false
    };
  }
  const names = [];
  for (let i = 0; i < targetDocument.swatches.length; i += 1) {
    names.push(String(targetDocument.swatches.item(i).name));
  }
  return {
    success: true,
    targetValid: true,
    targetIdMatches: Number(targetDocument.id) === Number(input.expectedDocumentId),
    ownMarkerPresent: names.includes(String(input.ownMarker)),
    foreignMarkerPresent: names.includes(String(input.foreignMarker)),
    pageCountMatches: Number(targetDocument.pages.length) === Number(input.expectedPageCount)
  };
`;

class DiagnosisStop extends Error {
  constructor(classification) {
    super('DIAGNOSIS_STOP');
    this.classification = classification;
  }
}

class McpCallFailure extends Error {
  constructor(toolName, code) {
    super(code);
    this.code = code;
    this.toolName = toolName;
  }
}

// Runtime installé par install.ps1 hors OneDrive : le serveur y trouve node_modules et refuse un stockage privé
// sous OneDrive (comme le plugin). Aucune donnée de test n'est écrite dans le dépôt.
const runtimeRoot = path.join(os.homedir(), '.nexus', 'indesign-mcp-secure');
const entryPoint = path.join(runtimeRoot, 'src', 'index.js');
const packageFile = path.join(runtimeRoot, 'package.json');
const documentRoot = path.join(runtimeRoot, 'e2e');
const oneDriveRoot = process.env.OneDrive || process.env.OneDriveConsumer;
const runId = randomUUID();
const secureTestRoot = oneDriveRoot ? path.join(runtimeRoot, 'private', 'live-targeting', runId) : null;
const backupRoot = secureTestRoot ? path.join(secureTestRoot, 'backups') : null;
const auditFile = secureTestRoot ? path.join(secureTestRoot, 'audit.jsonl') : null;

function stop(classification) {
  throw new DiagnosisStop(classification);
}

function normalizedFailureCode(error) {
  if (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.code)) return error.code;
  if (typeof error?.message === 'string' && SAFE_FAILURE_CODES.has(error.message)) return error.message;
  return 'UNCLASSIFIED_FAILURE';
}

function mcpFailureCode(response) {
  const structuredError = typeof response?.structuredContent?.error === 'string'
    ? response.structuredContent.error
    : '';
  const textError = (response?.content ?? [])
    .filter((entry) => entry?.type === 'text' && typeof entry.text === 'string')
    .map((entry) => entry.text)
    .join('\n');
  const match = /^([A-Z][A-Z0-9_]{2,63})(?::|\b)/.exec(structuredError || textError);
  return match?.[1] ?? 'MCP_CALL_FAILED';
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactlyOwnedDocuments(entries, ownedDocumentIds) {
  if (!Array.isArray(entries) || entries.length !== ownedDocumentIds.size) return false;
  const seen = new Set();
  for (const entry of entries) {
    if (!Number.isInteger(entry?.documentId) || !ownedDocumentIds.has(entry.documentId) || seen.has(entry.documentId)) {
      return false;
    }
    seen.add(entry.documentId);
  }
  return seen.size === ownedDocumentIds.size;
}

function hasCompleteSecurityMetadata(result, ownedDocumentIds) {
  return hasExactlyOwnedDocuments(result?.safetyBackups, ownedDocumentIds)
    && hasExactlyOwnedDocuments(result?.documentStates, ownedDocumentIds);
}

function stateFor(result, documentId) {
  const state = result?.documentStates?.find((entry) => entry?.documentId === documentId);
  if (
    !state
    || !Number.isInteger(state.revision)
    || state.revision < 0
    || typeof state.stateToken !== 'string'
    || !/^[a-f0-9]{16}$/.test(state.stateToken)
  ) {
    return null;
  }
  return state;
}

function probeShapeIsValid(result) {
  return isObject(result)
    && result.success === true
    && typeof result.targetValid === 'boolean'
    && typeof result.targetIdMatches === 'boolean'
    && typeof result.ownMarkerPresent === 'boolean'
    && typeof result.foreignMarkerPresent === 'boolean'
    && typeof result.pageCountMatches === 'boolean';
}

function legacyExecutionEvidenceIsValid(evidence, targetDocumentId, activeDocumentId) {
  return isObject(evidence)
    && /^[a-f0-9]{64}$/.test(evidence.codeSha256 ?? '')
    && /^[a-f0-9]{64}$/.test(evidence.sourceCodeSha256 ?? '')
    && /^[a-f0-9]{64}$/.test(evidence.payloadCodeSha256 ?? '')
    && evidence.requestedDocumentId === targetDocumentId
    && evidence.resolvedTargetDocumentId === targetDocumentId
    && evidence.activeDocumentIdBefore === activeDocumentId
    && evidence.activeDocumentIdAfter === activeDocumentId
    && evidence.payloadHasActiveDocument === false
    && evidence.payloadHasTargetDocument === true
    && evidence.resolutionMethod === 'itemByID.getElements'
    && evidence.rewriteApplied === false
    && evidence.sourceCodeSha256 === evidence.payloadCodeSha256
    && evidence.usedUndoTransaction === false;
}

function parseTextContent(response) {
  const texts = (response?.content ?? [])
    .filter((entry) => entry?.type === 'text')
    .map((entry) => entry.text);
  if (texts.length !== 1 || typeof texts[0] !== 'string') return null;
  try {
    return JSON.parse(texts[0]);
  } catch {
    return null;
  }
}

async function main() {
  const report = {
    ok: false,
    classification: 'INCONCLUSIVE',
    failureCode: null,
    failureTool: null,
    checks: {
      bridgeReady: false,
      baselineZero: false,
      twoOwnedDocuments: false,
      documentsDistinct: false,
      activeDecoyConfirmed: false,
      targetDocumentCorrect: false,
      domProxyCorrect: false,
      responseFormatCorrect: false,
      securityMetadataCorrect: false,
      legacyTargetCorrect: false,
      reconciliationConfirmed: false,
      ownedDocumentsClosed: false,
      baselineRestored: false,
    },
  };

  const ownedDocumentIds = new Set();
  const creationOrder = [];
  const unresolvedInspectionOperations = new Set();
  let unresolvedInspectionWithoutOperation = false;
  let cleanupFailureCode = null;
  let cleanupFailureTool = null;
  let clientConnected = false;
  let transport;
  const client = new Client({ name: 'nexus-indesign-live-targeting', version: '1.0.0' });

  const rememberInspectionRequirement = (response) => {
    if (response?.structuredContent?.requiresInspection !== true) return;
    const operationId = response.structuredContent.operationId;
    if (typeof operationId === 'string' && operationId.length > 0) {
      unresolvedInspectionOperations.add(operationId);
    } else {
      unresolvedInspectionWithoutOperation = true;
    }
  };

  const rawCall = async (name, args = {}) => {
    const response = await client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: REQUEST_TIMEOUT_MS, maxTotalTimeout: REQUEST_TIMEOUT_MS },
    );
    rememberInspectionRequirement(response);
    return response;
  };

  const call = async (name, args = {}) => {
    const response = await rawCall(name, args);
    if (response.isError || !isObject(response.structuredContent)) {
      throw new McpCallFailure(name, mcpFailureCode(response));
    }
    return response.structuredContent;
  };

  const inspectDocument = async (documentId) => {
    const response = await rawCall('silent_inspect_document', { documentId });
    const document = response.isError ? null : response.structuredContent?.document;
    if (
      !document
      || document.documentId !== documentId
      || !Number.isInteger(document.revision)
      || document.revision < 0
      || typeof document.stateToken !== 'string'
      || !/^[a-f0-9]{16}$/.test(document.stateToken)
    ) {
      if (response.isError) {
        throw new McpCallFailure('silent_inspect_document', mcpFailureCode(response));
      }
      throw new Error('DOCUMENT_INSPECTION_FAILED');
    }
    return document;
  };

  const runProbe = async ({ documentId, expectedRevision, expectedStateToken, ownMarker, foreignMarker, expectedPageCount }) => {
    const result = await call('execute_uxp', {
      scope: 'document',
      documentId,
      expectedRevision,
      expectedStateToken,
      reason: 'Diagnostiquer le ciblage explicite sur deux documents jetables',
      input: {
        expectedDocumentId: documentId,
        ownMarker,
        foreignMarker,
        expectedPageCount,
      },
      code: TARGET_PROBE_CODE,
    });
    if (!probeShapeIsValid(result)) stop('D');
    if (!hasCompleteSecurityMetadata(result, ownedDocumentIds)) {
      report.checks.securityMetadataCorrect = false;
      stop('D');
    }
    report.checks.securityMetadataCorrect = true;
    if (!result.targetValid || !result.targetIdMatches) {
      report.checks.targetDocumentCorrect = false;
      stop('B');
    }
    report.checks.targetDocumentCorrect = true;
    if (!result.ownMarkerPresent || result.foreignMarkerPresent || !result.pageCountMatches) {
      report.checks.domProxyCorrect = false;
      stop('C');
    }
    report.checks.domProxyCorrect = true;
    return result;
  };

  const reconcileOperations = async () => {
    if (unresolvedInspectionWithoutOperation) return false;
    for (const operationId of [...unresolvedInspectionOperations]) {
      try {
        const reconciled = await rawCall('silent_reconcile_unknown_operation', {
          operationId,
          reason: 'Réconcilier le diagnostic de ciblage avant de fermer ses documents jetables',
        });
        if (reconciled.isError) continue;
        const finalStatus = await rawCall('bridge_operation_status', { operationId });
        if (!finalStatus.isError && finalStatus.structuredContent?.status === 'not-found') {
          unresolvedInspectionOperations.delete(operationId);
        }
      } catch {
        // Une opération non confirmée reste conservée pour inspection.
      }
    }
    return !unresolvedInspectionWithoutOperation && unresolvedInspectionOperations.size === 0;
  };

  const cleanupOwnedDocuments = async () => {
    if (!(await reconcileOperations())) return false;
    for (const documentId of [...creationOrder].reverse()) {
      try {
        const listed = await rawCall('silent_list_documents', {});
        if (listed.isError || !Array.isArray(listed.structuredContent?.documents)) return false;
        if (!listed.structuredContent.documents.some((document) => document.documentId === documentId)) continue;
        const state = await inspectDocument(documentId);
        const closed = await rawCall('silent_close_document', {
          documentId,
          expectedRevision: state.revision,
          expectedStateToken: state.stateToken,
          save: false,
          reason: 'Fermer sans sauvegarde un document jetable du diagnostic de ciblage',
        });
        if (closed.isError) {
          cleanupFailureCode ??= mcpFailureCode(closed);
          cleanupFailureTool ??= 'silent_close_document';
          if (!(await reconcileOperations())) return false;
          const afterReconciliation = await rawCall('silent_list_documents', {});
          if (
            afterReconciliation.isError
            || !Array.isArray(afterReconciliation.structuredContent?.documents)
            || afterReconciliation.structuredContent.documents.some((document) => document.documentId === documentId)
          ) {
            return false;
          }
        }
      } catch {
        return false;
      }
    }
    if (!(await reconcileOperations())) return false;
    try {
      const silentListing = await rawCall('silent_list_documents', {});
      const pluginListing = await rawCall('list_documents', {});
      if (
        silentListing.isError
        || pluginListing.isError
        || !Array.isArray(silentListing.structuredContent?.documents)
        || !Array.isArray(pluginListing.structuredContent?.documents)
      ) {
        return false;
      }
      const silentIds = new Set(silentListing.structuredContent.documents.map((document) => document.documentId));
      const pluginIds = new Set(pluginListing.structuredContent.documents.map((document) => document.documentId));
      const ownedClosed = [...ownedDocumentIds].every((documentId) => !silentIds.has(documentId) && !pluginIds.has(documentId));
      report.checks.ownedDocumentsClosed = ownedClosed;
      report.checks.baselineRestored = ownedClosed && silentIds.size === 0 && pluginIds.size === 0;
      return report.checks.baselineRestored;
    } catch {
      return false;
    }
  };

  try {
    if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('NODE_VERSION_INVALID');
    if (!oneDriveRoot || !secureTestRoot || !backupRoot || !auditFile) throw new Error('SECURE_ROOT_MISSING');
    const tokenFile = process.env.INDESIGN_MCP_TOKEN_FILE
      || path.join(oneDriveRoot, 'Documents', 'NexusSecure', 'InDesignMCP', 'bridge-token');
    if (!path.isAbsolute(tokenFile)) throw new Error('TOKEN_FILE_INVALID');
    await fs.access(tokenFile);
    await fs.access(entryPoint);
    const packageMetadata = JSON.parse(await fs.readFile(packageFile, 'utf8'));
    await fs.mkdir(backupRoot, { recursive: true });
    await fs.mkdir(documentRoot, { recursive: true });

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [entryPoint],
      cwd: runtimeRoot,
      stderr: 'pipe',
      env: {
        INDESIGN_MCP_TOKEN_FILE: tokenFile,
        INDESIGN_MCP_PRIVATE_ROOT: secureTestRoot,
        INDESIGN_MCP_BACKUP_ROOT: backupRoot,
        INDESIGN_MCP_READ_ROOTS: documentRoot,
        INDESIGN_MCP_WRITE_ROOTS: documentRoot,
        INDESIGN_MCP_AUDIT_FILE: auditFile,
        INDESIGN_MCP_PORT: '33171',
        INDESIGN_MCP_COMMAND_TIMEOUT_MS: '120000',
      },
    });
    transport.stderr?.on('data', () => {});
    await client.connect(transport);
    clientConnected = true;

    const tools = await client.listTools(undefined, { timeout: REQUEST_TIMEOUT_MS });
    const toolNames = new Set(tools.tools.map((tool) => tool.name));
    if (!REQUIRED_TOOLS.every((name) => toolNames.has(name))) throw new Error('TOOL_CATALOG_INCOMPLETE');

    const deadline = Date.now() + BRIDGE_WAIT_MS;
    let bridgeStatus;
    do {
      bridgeStatus = await call('bridge_status');
      if (bridgeStatus.connected === true && bridgeStatus.authenticated === true) break;
      await new Promise((resolve) => setTimeout(resolve, 750));
    } while (Date.now() < deadline);
    if (
      bridgeStatus?.connected !== true
      || bridgeStatus?.authenticated !== true
      || bridgeStatus?.pluginId !== 'fr.pironjulien.indesign.mcp'
      || bridgeStatus?.pluginVersion !== packageMetadata.version
    ) {
      throw new Error('BRIDGE_NOT_READY');
    }
    await call('ping');
    report.checks.bridgeReady = true;

    const initialPluginListing = await call('list_documents');
    const initialSilentListing = await call('silent_list_documents');
    if (
      !Array.isArray(initialPluginListing.documents)
      || !Array.isArray(initialSilentListing.documents)
      || initialPluginListing.documents.length !== 0
      || initialSilentListing.documents.length !== 0
    ) {
      throw new Error('BASELINE_NOT_ZERO');
    }
    report.checks.baselineZero = true;

    const markerA = `MCP-DIAG-A-${randomUUID()}`;
    const markerB = `MCP-DIAG-B-${randomUUID()}`;

    const createdA = await call('create_document', {
      expectedRevision: 0,
      width: 121,
      height: 181,
      pageCount: 1,
      facingPages: false,
      units: 'mm',
      margins: [11, 11, 11, 11],
      bleed: [0, 0, 0, 0],
    });
    if (!Number.isInteger(createdA.documentId)) throw new Error('DOCUMENT_CREATION_FAILED');
    const documentA = createdA.documentId;
    ownedDocumentIds.add(documentA);
    creationOrder.push(documentA);

    let stateA = await inspectDocument(documentA);
    await call('create_color_swatch', {
      documentId: documentA,
      expectedRevision: stateA.revision,
      expectedStateToken: stateA.stateToken,
      name: markerA,
      colorSpace: 'CMYK',
      values: [100, 70, 0, 5],
      reason: 'Créer le marqueur privé du premier document jetable',
    });

    const createdB = await call('create_document', {
      expectedRevision: 0,
      width: 137,
      height: 199,
      pageCount: 2,
      facingPages: false,
      units: 'mm',
      margins: [13, 13, 13, 13],
      bleed: [0, 0, 0, 0],
    });
    if (!Number.isInteger(createdB.documentId) || createdB.documentId === documentA) throw new Error('DOCUMENT_CREATION_FAILED');
    const documentB = createdB.documentId;
    ownedDocumentIds.add(documentB);
    creationOrder.push(documentB);

    let stateB = await inspectDocument(documentB);
    await call('create_color_swatch', {
      documentId: documentB,
      expectedRevision: stateB.revision,
      expectedStateToken: stateB.stateToken,
      name: markerB,
      colorSpace: 'CMYK',
      values: [0, 95, 80, 0],
      reason: 'Créer le marqueur privé du second document jetable',
    });

    const ownedListing = await call('list_documents');
    if (
      !Array.isArray(ownedListing.documents)
      || ownedListing.documents.length !== 2
      || !ownedListing.documents.every((document) => ownedDocumentIds.has(document.documentId))
    ) {
      throw new Error('DOCUMENT_SET_CHANGED');
    }
    report.checks.twoOwnedDocuments = true;

    stateA = await inspectDocument(documentA);
    const probeA = await runProbe({
      documentId: documentA,
      expectedRevision: stateA.revision,
      expectedStateToken: stateA.stateToken,
      ownMarker: markerA,
      foreignMarker: markerB,
      expectedPageCount: 1,
    });

    stateB = stateFor(probeA, documentB);
    if (!stateB) stop('D');
    const probeB = await runProbe({
      documentId: documentB,
      expectedRevision: stateB.revision,
      expectedStateToken: stateB.stateToken,
      ownMarker: markerB,
      foreignMarker: markerA,
      expectedPageCount: 2,
    });

    report.checks.targetDocumentCorrect = true;
    report.checks.domProxyCorrect = true;
    report.checks.documentsDistinct = true;
    report.checks.securityMetadataCorrect = true;

    stateA = stateFor(probeB, documentA);
    if (!stateA) stop('D');
    const beforeLegacy = await call('list_documents');
    const activeB = beforeLegacy.documents?.find((document) => document.documentId === documentB)?.active === true;
    const activeA = beforeLegacy.documents?.find((document) => document.documentId === documentA)?.active === true;
    if (
      !Array.isArray(beforeLegacy.documents)
      || beforeLegacy.documents.length !== 2
      || !beforeLegacy.documents.every((document) => ownedDocumentIds.has(document.documentId))
      || !activeB
      || activeA
    ) {
      throw new Error('ACTIVE_DECOY_NOT_CONFIRMED');
    }
    report.checks.activeDecoyConfirmed = true;

    const legacyResponse = await rawCall('get_document_colors', {
      scope: 'document',
      documentId: documentA,
      expectedRevision: stateA.revision,
      expectedStateToken: stateA.stateToken,
      includeSwatches: true,
      includeGradients: false,
      includeTints: false,
      reason: 'Diagnostiquer le ciblage legacy sur deux documents jetables distincts',
    });
    if (legacyResponse.isError) throw new Error('LEGACY_CALL_FAILED');

    const structured = legacyResponse.structuredContent;
    const parsedText = parseTextContent(legacyResponse);
    const inner = structured?.result;
    const responseFormatCorrect = isObject(structured)
      && structured.success === true
      && structured.operation === 'Get Document Colors'
      && isObject(inner)
      && Array.isArray(inner.swatches)
      && parsedText !== null
      && isDeepStrictEqual(parsedText, structured);
    if (!responseFormatCorrect) stop('D');
    report.checks.responseFormatCorrect = true;

    if (
      !hasCompleteSecurityMetadata(inner, ownedDocumentIds)
      || !hasCompleteSecurityMetadata(structured, ownedDocumentIds)
      || !legacyExecutionEvidenceIsValid(inner._execution, documentA, documentB)
    ) {
      stop('D');
    }
    report.checks.securityMetadataCorrect = true;

    const targetMarkerPresent = inner.swatches.includes(markerA);
    const decoyMarkerPresent = inner.swatches.includes(markerB);
    if (targetMarkerPresent && !decoyMarkerPresent) {
      report.checks.legacyTargetCorrect = true;
      report.classification = 'OK';
    } else {
      const postLegacyStateA = stateFor(inner, documentA);
      if (!postLegacyStateA) stop('D');
      await runProbe({
        documentId: documentA,
        expectedRevision: postLegacyStateA.revision,
        expectedStateToken: postLegacyStateA.stateToken,
        ownMarker: markerA,
        foreignMarker: markerB,
        expectedPageCount: 1,
      });
      stop('A');
    }
  } catch (error) {
    report.classification = error instanceof DiagnosisStop ? error.classification : 'INCONCLUSIVE';
    report.failureCode = error instanceof DiagnosisStop ? null : normalizedFailureCode(error);
    report.failureTool = error instanceof DiagnosisStop || typeof error?.toolName !== 'string'
      ? null
      : error.toolName;
  } finally {
    if (clientConnected) {
      const cleaned = await cleanupOwnedDocuments();
      report.checks.reconciliationConfirmed = !unresolvedInspectionWithoutOperation
        && unresolvedInspectionOperations.size === 0;
      if (!cleaned) {
        report.checks.ownedDocumentsClosed = false;
        report.checks.baselineRestored = false;
        if (report.failureCode === null) {
          report.failureCode = cleanupFailureCode ?? 'CLEANUP_FAILED';
          report.failureTool = cleanupFailureTool;
        }
      }
      await client.close().catch(() => {});
    } else if (transport) {
      await transport.close().catch(() => {});
    }
    if (
      secureTestRoot
      && report.checks.reconciliationConfirmed
      && report.checks.baselineRestored
    ) {
      await fs.rm(secureTestRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  report.ok = report.classification === 'OK'
    && report.checks.legacyTargetCorrect
    && report.checks.reconciliationConfirmed
    && report.checks.baselineRestored;
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.ok) process.exitCode = 1;
}

main().catch(() => {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    classification: 'INCONCLUSIVE',
    failureCode: 'UNHANDLED_FAILURE',
    failureTool: null,
    checks: {
      bridgeReady: false,
      baselineZero: false,
      twoOwnedDocuments: false,
      documentsDistinct: false,
      activeDecoyConfirmed: false,
      targetDocumentCorrect: false,
      domProxyCorrect: false,
      responseFormatCorrect: false,
      securityMetadataCorrect: false,
      legacyTargetCorrect: false,
      reconciliationConfirmed: false,
      ownedDocumentsClosed: false,
      baselineRestored: false,
    },
  })}\n`);
  process.exitCode = 1;
});

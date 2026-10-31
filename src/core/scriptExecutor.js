import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { verifyArtifact } from '../verification/ArtifactVerifier.js';

const contextStorage = new AsyncLocalStorage();
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ACTIVE_DOCUMENT_PATTERN = /\bapp\.activeDocument\b/;
const TARGET_DOCUMENT_PATTERN = /\btargetDocument\b/;

function bindLegacyDocumentTarget(code, context) {
  if (context?.scope !== 'document' || context?.legacyGeneratedCode !== true) return code;
  // Les anciens handlers sont du code interne de confiance qui lisait le
  // document actif. Utiliser la cible explicite résolue et validée par le
  // plugin évite toute dépendance à la fenêtre placée au premier plan.
  const executableCode = code.replace(/\bapp\.activeDocument\b(?!\s*=(?!=))/g, 'targetDocument');
  if (ACTIVE_DOCUMENT_PATTERN.test(executableCode) || !TARGET_DOCUMENT_PATTERN.test(executableCode)) {
    const error = new Error('La commande historique ne cible pas explicitement le document demandé.');
    error.code = 'LEGACY_TARGET_BINDING_FAILED';
    throw error;
  }
  return executableCode;
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function validateExecutionEvidence({
  response,
  context,
  sourceCodeSha256,
  payloadCodeSha256,
  rewriteApplied,
  payloadHasActiveDocument,
  payloadHasTargetDocument,
}) {
  const evidence = response.result?._execution;
  const fail = (message) => {
    const error = new Error(message);
    error.code = 'EXECUTION_EVIDENCE_INVALID';
    error.operationId = response.operationId;
    error.requiresInspection = true;
    throw error;
  };
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    fail('Le plugin n’a pas fourni la preuve d’exécution UXP obligatoire.');
  }
  if (
    !SHA256_PATTERN.test(evidence.codeSha256 ?? '')
    || evidence.codeSha256 !== payloadCodeSha256
    || evidence.payloadHasActiveDocument !== payloadHasActiveDocument
    || evidence.payloadHasTargetDocument !== payloadHasTargetDocument
  ) {
    fail('La preuve du code UXP réellement reçu ne correspond pas au payload signé.');
  }
  if (context.scope === 'document') {
    if (
      evidence.requestedDocumentId !== context.documentId
      || evidence.resolvedTargetDocumentId !== context.documentId
      || evidence.resolutionMethod !== 'itemByID.getElements'
    ) {
      fail('Le plugin n’a pas résolu exactement le document demandé.');
    }
  } else if (
    evidence.requestedDocumentId !== null
    || evidence.resolvedTargetDocumentId !== null
  ) {
    fail('Une exécution application ne doit pas annoncer de document cible.');
  }
  if (
    typeof evidence.usedUndoTransaction !== 'boolean'
    || typeof evidence.resolutionMethod !== 'string'
    || evidence.resolutionMethod.length < 1
    || evidence.resolutionMethod.length > 64
  ) {
    fail('La preuve d’exécution UXP est incomplète.');
  }
  if (context.scope === 'document' && context.legacyGeneratedCode === true) {
    if (payloadHasActiveDocument || !payloadHasTargetDocument) {
      fail('La commande historique contient encore une dépendance au document actif.');
    }
  }
  return {
    ...evidence,
    sourceCodeSha256,
    payloadCodeSha256,
    rewriteApplied,
  };
}

export class ScriptExecutor {
  static bridge;
  static audit;

  static configure({ bridge, silentBridge, audit, backupDirectory, cleanupBackups }) {
    ScriptExecutor.bridge = bridge;
    ScriptExecutor.silentBridge = silentBridge;
    ScriptExecutor.audit = audit;
    ScriptExecutor.backupDirectory = backupDirectory;
    ScriptExecutor.cleanupBackups = cleanupBackups;
  }

  static withContext(context, operation) {
    return contextStorage.run({ ...context }, operation);
  }

  static currentSecurityMetadata() {
    const metadata = contextStorage.getStore()?.securityMetadata;
    return metadata && typeof metadata === 'object' ? metadata : undefined;
  }

  static async executeViaUXP(code, input = null) {
    const context = contextStorage.getStore();
    if (!ScriptExecutor.bridge || !ScriptExecutor.silentBridge || !context) throw new Error('Le contexte d’exécution UXP sécurisé est absent.');
    if (typeof code !== 'string' || code.length === 0 || code.length > 2_000_000) throw new Error('Le code UXP est vide ou trop volumineux.');
    if (!['document', 'application'].includes(context.scope) || !context.reason) {
      throw new Error('scope et reason sont obligatoires pour execute_uxp.');
    }
    if (context.scope === 'document' && (!Number.isInteger(context.documentId) || !Number.isInteger(context.expectedRevision) || !/^[a-f0-9]{16}$/.test(context.expectedStateToken ?? ''))) {
      throw new Error('documentId, expectedRevision et expectedStateToken sont obligatoires avec scope=document.');
    }

    const started = Date.now();
    let backupId;
    let backupIds;
    let safetyBackups;
    try {
      const listing = await ScriptExecutor.bridge.execute({ command: 'list_documents', args: {} });
      const documents = Array.isArray(listing.result?.documents) ? listing.result.documents : [];
      const verifiedDocuments = new Map();
      backupIds = [];
      safetyBackups = [];
      for (const document of documents) {
        if (!Number.isInteger(document.documentId) || !Number.isInteger(document.revision)) throw new Error('Inventaire des documents invalide avant execute_uxp.');
        const before = (await ScriptExecutor.silentBridge.inspectDocument(document.documentId)).document;
        if (!before || before.documentId !== document.documentId || before.revision !== document.revision || !/^[a-f0-9]{16}$/.test(before.stateToken ?? '')) {
          const error = new Error('Le document a changé entre les deux canaux avant sa sauvegarde.');
          error.code = 'STATE_CONFLICT';
          throw error;
        }
        verifiedDocuments.set(document.documentId, before);
        if (document.documentId === context.documentId && before.stateToken !== context.expectedStateToken) {
          const error = new Error('Le document ciblé a changé depuis la dernière inspection.');
          error.code = 'STATE_CONFLICT';
          throw error;
        }
        const backup = await ScriptExecutor.bridge.execute({
          command: 'create_safety_backup', documentId: document.documentId, expectedRevision: document.revision,
          expectedStateToken: before.stateToken,
          args: { reason: context.reason, toolName: context.toolName, backupDirectory: ScriptExecutor.backupDirectory },
        });
        if (!backup.result?.backupId) throw new Error('Sauvegarde UXP incomplète.');
        await verifyArtifact({ targetPath: backup.result.backupPath, kind: 'indd' });
        const after = (await ScriptExecutor.silentBridge.inspectDocument(document.documentId)).document;
        if (!after || after.revision !== before.revision || after.stateToken !== before.stateToken) {
          const error = new Error('Le document a changé pendant sa sauvegarde de sécurité.');
          error.code = 'STATE_CONFLICT';
          throw error;
        }
        const provenance = await ScriptExecutor.silentBridge.registerExternalBackup({
          backupId: backup.result.backupId,
          backupPath: backup.result.backupPath,
          documentId: document.documentId,
          revision: document.revision,
          stateToken: before.stateToken,
        });
        backupIds.push(backup.result.backupId);
        safetyBackups.push({ documentId: document.documentId, revision: document.revision, stateToken: before.stateToken, backupId: backup.result.backupId, backupPath: backup.result.backupPath, metadataPath: provenance.metadataPath, artifactSha256: provenance.artifact.sha256 });
        if (document.documentId === context.documentId) backupId = backup.result.backupId;
      }
      if (context.scope === 'document') {
        const target = documents.find((document) => document.documentId === context.documentId);
        if (!target) throw new Error('Le document ciblé n’est plus ouvert avant execute_uxp.');
        if (target.revision !== context.expectedRevision) {
          const error = new Error('Le document ciblé a changé depuis la dernière lecture.');
          error.code = 'REVISION_CONFLICT';
          throw error;
        }
        if (!backupId) throw new Error('La sauvegarde du document ciblé est absente.');
      }
      for (const document of documents) {
        const expected = verifiedDocuments.get(document.documentId);
        const ready = (await ScriptExecutor.silentBridge.inspectDocument(document.documentId)).document;
        if (
          !expected
          || !ready
          || ready.documentId !== expected.documentId
          || ready.revision !== expected.revision
          || ready.stateToken !== expected.stateToken
        ) {
          const error = new Error('Un document ouvert a changé entre sa sauvegarde et l’exécution UXP.');
          error.code = 'STATE_CONFLICT';
          throw error;
        }
      }
      /* Toutes les copies sont créées même en portée document, car du code UXP
         libre peut atteindre app, les autres documents, les fichiers et le réseau. */
      const executableCode = bindLegacyDocumentTarget(code, context);
      const sourceCodeSha256 = sha256(code);
      const payloadCodeSha256 = sha256(executableCode);
      const rewriteApplied = executableCode !== code;
      const payloadHasActiveDocument = ACTIVE_DOCUMENT_PATTERN.test(executableCode);
      const payloadHasTargetDocument = TARGET_DOCUMENT_PATTERN.test(executableCode);
      const response = await ScriptExecutor.bridge.execute({
        command: 'execute_uxp',
        documentId: context.documentId,
        expectedRevision: context.expectedRevision,
        expectedStateToken: context.scope === 'document' ? context.expectedStateToken : undefined,
        args: {
          scope: context.scope,
          code: executableCode,
          input,
          reason: context.reason,
          backupId,
          backupIds,
          expectedDocumentStates: [...verifiedDocuments.values()].map(({ documentId, revision, stateToken }) => ({ documentId, revision, stateToken })),
        },
      });
      let documentStates;
      let executionEvidence;
      try {
        executionEvidence = validateExecutionEvidence({
          response,
          context,
          sourceCodeSha256,
          payloadCodeSha256,
          rewriteApplied,
          payloadHasActiveDocument,
          payloadHasTargetDocument,
        });
        const revisionEntries = response.result?.revisions;
        const pluginStateEntries = response.result?.documentStates;
        if (!Array.isArray(revisionEntries) || !Array.isArray(pluginStateEntries)) {
          const error = new Error('Le plugin n’a pas renvoyé l’inventaire obligatoire des révisions après l’exécution UXP.');
          error.code = 'DOCUMENT_STATE_INVALID';
          throw error;
        }
        const pluginStatesById = new Map();
        for (const entry of pluginStateEntries) {
          if (
            !Number.isInteger(entry?.documentId)
            || !Number.isInteger(entry?.revision)
            || !/^[a-f0-9]{16}$/.test(entry?.stateToken ?? '')
            || pluginStatesById.has(entry.documentId)
          ) {
            const error = new Error('Le plugin a renvoyé un état de document invalide après l’exécution UXP.');
            error.code = 'DOCUMENT_STATE_INVALID';
            throw error;
          }
          pluginStatesById.set(entry.documentId, entry);
        }
        const postListing = await ScriptExecutor.silentBridge.listDocuments();
        const openDocuments = Array.isArray(postListing?.documents) ? postListing.documents : null;
        const returnedById = new Map();
        for (const revisionEntry of revisionEntries) {
          if (!Number.isInteger(revisionEntry?.documentId) || !Number.isInteger(revisionEntry?.revision)) {
            const error = new Error('Le plugin a renvoyé un inventaire de révisions invalide après l’exécution UXP.');
            error.code = 'DOCUMENT_STATE_INVALID';
            throw error;
          }
          if (returnedById.has(revisionEntry.documentId)) {
            const error = new Error('Le plugin a renvoyé deux fois le même document après l’exécution UXP.');
            error.code = 'DOCUMENT_STATE_INVALID';
            throw error;
          }
          returnedById.set(revisionEntry.documentId, revisionEntry.revision);
        }
        if (
          !openDocuments
          || openDocuments.length !== returnedById.size
          || pluginStatesById.size !== returnedById.size
          || openDocuments.some((document) => (
            !Number.isInteger(document?.documentId)
            || !Number.isInteger(document?.revision)
            || returnedById.get(document.documentId) !== document.revision
            || pluginStatesById.get(document.documentId)?.revision !== document.revision
          ))
        ) {
          const error = new Error('L’inventaire relu des documents ouverts ne correspond pas au résultat du plugin.');
          error.code = 'STATE_VERIFICATION_FAILED';
          throw error;
        }
        documentStates = [];
        for (const revisionEntry of revisionEntries) {
          const inspected = (await ScriptExecutor.silentBridge.inspectDocument(revisionEntry.documentId)).document;
          if (
            !inspected
            || inspected.documentId !== revisionEntry.documentId
            || inspected.revision !== revisionEntry.revision
            || inspected.stateToken !== pluginStatesById.get(revisionEntry.documentId)?.stateToken
          ) {
            const error = new Error('L’état relu après l’exécution UXP ne correspond pas au résultat du plugin.');
            error.code = 'STATE_VERIFICATION_FAILED';
            throw error;
          }
          documentStates.push({
            documentId: inspected.documentId,
            revision: inspected.revision,
            stateToken: inspected.stateToken,
          });
        }
        if (context.scope === 'document') {
          const nextTargetState = documentStates.find((entry) => entry.documentId === context.documentId);
          if (nextTargetState) {
            context.expectedRevision = nextTargetState.revision;
            context.expectedStateToken = nextTargetState.stateToken;
          }
        }
      } catch (cause) {
        const error = cause && (typeof cause === 'object' || typeof cause === 'function')
          ? cause
          : new Error(String(cause));
        error.code ??= 'STATE_VERIFICATION_FAILED';
        if (typeof response.operationId === 'string' && typeof error.operationId !== 'string') error.operationId = response.operationId;
        error.requiresInspection = true;
        throw error;
      }
      const result = response.result && typeof response.result === 'object' && !Array.isArray(response.result)
        ? { ...response.result }
        : { value: response.result };
      result._execution = executionEvidence;
      result.safetyBackups = safetyBackups;
      result.documentStates = documentStates;
      const previousSecurityMetadata = context.securityMetadata;
      const accumulatedBackups = [
        ...(Array.isArray(previousSecurityMetadata?.safetyBackups) ? previousSecurityMetadata.safetyBackups : []),
        ...safetyBackups,
      ];
      context.securityMetadata = {
        safetyBackups: [...new Map(accumulatedBackups.map((backup) => [backup.backupId, backup])).values()],
        documentStates,
        ...(backupId ? { backupId } : {}),
      };
      if (result.success === false) {
        const reportedMessage = typeof result.error === 'string' && result.error.trim().length > 0
          ? result.error.trim().slice(0, 1_000)
          : 'La commande UXP historique a signalé un échec.';
        const error = new Error(reportedMessage);
        error.code = 'LEGACY_UXP_COMMAND_FAILED';
        error.documentStates = documentStates;
        error.safetyBackups = safetyBackups;
        throw error;
      }
      let auditWarning = false;
      try {
        await ScriptExecutor.audit?.write({
          event: 'execute_uxp',
          toolName: context.toolName,
          documentId: context.documentId,
          expectedRevision: context.expectedRevision,
          reason: context.reason,
          backupId,
          backupIds,
          outcome: 'success',
          durationMs: Date.now() - started,
          ...executionEvidence,
        });
      } catch {
        auditWarning = true;
      }
      if (auditWarning) result.auditWarning = 'Le résultat UXP est valide, mais son événement final n’a pas pu être écrit dans le journal d’audit.';
      return result;
    } catch (error) {
      await ScriptExecutor.audit?.write({ event: 'execute_uxp', toolName: context.toolName, documentId: context.documentId, expectedRevision: context.expectedRevision, reason: context.reason, backupId, backupIds, operationId: error.operationId, requiresInspection: error.requiresInspection, errorCode: error.code, outcome: 'error', durationMs: Date.now() - started }).catch(() => {});
      if (safetyBackups?.length) {
        error.safetyBackups = safetyBackups;
        const targetBackup = safetyBackups.find((backup) => backup.documentId === context.documentId);
        error.backupId ??= targetBackup?.backupId;
        error.backupPath ??= targetBackup?.backupPath;
      }
      throw error;
    }
  }
}

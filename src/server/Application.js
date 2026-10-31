import Ajv2020 from 'ajv/dist/2020.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { InDesignMCPServer as LegacyServer } from '../core/InDesignMCPServer.js';
import { FifoQueue } from '../core/FifoQueue.js';
import { ScriptExecutor } from '../core/scriptExecutor.js';
import { handleLegacyMissing, LEGACY_MISSING_NAMES } from '../handlers/legacyMissingHandlers.js';
import { InDesignBridge } from '../bridge/InDesignBridge.js';
import { SharedInDesignBridgeClient } from '../bridge/SharedInDesignBridgeClient.js';
import { bridgeUnavailableStatus, diagnoseBridgeStartupError, findWindowsTcpListenerOwnerPid } from '../bridge/BridgeDiagnostics.js';
import { InDesignSilentBridge } from '../bridge/InDesignSilentBridge.js';
import { AuditLogger } from '../security/AuditLogger.js';
import { LEGACY_PATH_RULES } from '../security/legacyPathRules.js';
import { OutputTargetError, prepareOutputTarget } from '../security/OutputProtection.js';
import { PathPolicy } from '../security/PathPolicy.js';
import { applyWindowsPrivateAcl } from '../security/PrivateAcl.js';
import { TokenStore } from '../security/TokenStore.js';
import { cleanupBackups } from '../security/BackupRetention.js';
import { verifyArtifact } from '../verification/ArtifactVerifier.js';
import { runInDesignDoctor } from '../discovery/InDesignDoctor.js';
import { searchOfficialDom } from '../discovery/AdobeDomIndex.js';
import { analyzeLayoutSnapshot, summarizeLayoutAnomalies } from '../workflows/LayoutWorkflow.js';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { buildToolCatalog } from '../tools/catalog.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../version.js';

export const SERVER_INSTRUCTIONS = `Ce serveur donne à l’agent (Codex ou Claude Code) un accès complet et contrôlé à Adobe InDesign. Voie normale : silent_status, silent_list_documents, open_document (qui renvoie documentId, revision et stateToken), puis run_layout_script pour chaque changement cohérent : en un seul passage, il contrôle l’état, sauvegarde tous les documents ouverts, exécute le script UXP, enregistre si demandé et rend un aperçu PNG à regarder. Il renvoie la nouvelle revision et le nouveau stateToken : enchaînez sans réinspecter. Un échec du script renvoie scriptOk=false et backupId (silent_restore_backup), sans bloquer la suite. Regroupez le travail : chaque appel InDesign coûte environ dix secondes. Si le projet possède un générateur ou des scripts versionnés, ils restent la source de vérité ; passez leur contenu à run_layout_script.

Finalisez avec preflight_document puis finalize_layout ou export_pdf, et fermez avec silent_close_document. Le code libre (run_layout_script, execute_uxp_silent, execute_uxp) a les permissions système et réseau complètes des scripts Adobe : n’exécutez que du code décidé pour la tâche. Les chemins des outils structurés restent bornés. Toutes les commandes InDesign passent par une file commune, sont sauvegardées et auditées sans journaliser le code ni le contenu. Après une issue inconnue, consultez silent_operation_status ; si elle reste orpheline, silent_reconcile_unknown_operation avant toute nouvelle mutation (redémarrez InDesign s’il le demande). Le profil core expose ce noyau ; le profil full (INDESIGN_MCP_TOOL_PROFILE=full) ajoute les commandes historiques objet par objet.`;

function asObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return { value };
}

function publicTool(tool) {
  const legacyNotice = tool._meta?.route === 'legacy-uxp'
    ? 'Outil historique avancé : il exécute du code UXP libre et sauvegarde tous les documents ouverts. Préférez un outil structuré ou silencieux lorsqu’il existe. '
    : '';
  return {
    name: tool.name,
    title: tool.title,
    description: `${legacyNotice}${tool.description}`,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  };
}

function validationMessage(errors = []) {
  return errors.map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ');
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function preparePrivateDirectory(candidate, privateRoot) {
  if (!path.isAbsolute(candidate)) throw new Error('Le stockage interne doit utiliser un chemin absolu.');
  await fs.mkdir(candidate, { recursive: true });
  const [canonicalRoot, canonicalCandidate, stat] = await Promise.all([
    fs.realpath(privateRoot),
    fs.realpath(candidate),
    fs.lstat(candidate),
  ]);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !isInside(canonicalRoot, canonicalCandidate)) {
    throw new Error('Le stockage interne doit rester dans le dossier privé du jeton et ne peut pas être un lien.');
  }
  await applyWindowsPrivateAcl(canonicalCandidate, { kind: 'directory', recursive: true });
  return canonicalCandidate;
}

function expectedPageCount(pageRange, pageCount) {
  if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error('Le nombre de pages InDesign est invalide avant export.');
  const value = String(pageRange ?? 'all').trim().toLowerCase();
  if (value === 'all') return pageCount;
  const selected = new Set();
  for (const token of value.split(',')) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(token.trim());
    if (!match) throw new Error('La plage de pages PNG est invalide.');
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (start < 1 || end < start || end > pageCount) throw new Error('La plage de pages PNG sort du document.');
    for (let page = start; page <= end; page += 1) selected.add(page);
  }
  return selected.size;
}

const AUDIT_WARNING = 'Le résultat InDesign est valide, mais l’événement final n’a pas pu être écrit dans le journal d’audit.';
const OUTPUT_TARGETS = Object.freeze({
  save_as: { field: 'path', kind: 'file' },
  export_pdf: { field: 'filePath', kind: 'file' },
  export_idml: { field: 'filePath', kind: 'file' },
  export_png: (args) => args.pageId !== undefined
    ? { field: 'filePath', kind: 'file' }
    : { field: 'folderPath', kind: 'directory', createDirectory: true },
  package_document: { field: 'folderPath', kind: 'directory', createDirectory: true },
});
const ARTIFACT_TARGETS = Object.freeze({
  export_pdf: { field: 'filePath', kind: 'pdf' },
  export_idml: { field: 'filePath', kind: 'idml' },
  export_png: (args) => args.pageId !== undefined
    ? { field: 'filePath', kind: 'png' }
    : { field: 'folderPath', kind: 'multipage-png' },
  package_document: { field: 'folderPath', kind: 'package' },
});
const SILENT_STRUCTURED_READS = new Set([
  'get_document_info',
  'list_pages',
  'get_links',
  'get_fonts',
  'get_overset_text',
  'get_images',
]);
const STATE_GUARDED_ROUTES = new Set(['direct', 'workflow']);
const STATE_RETURNING_ROUTES = new Set(['direct', 'workflow', 'legacy-uxp', 'execute-uxp']);
const SILENT_EXPORT_TOOLS = new Set(['export_pdf', 'export_png', 'preview_layout', 'finalize_layout', 'package_document']);
// L'assemblage passe toujours par le canal silencieux : il y tourne sans boîte de dialogue (NEVER_INTERACT) et un refus
// d'InDesign y est expliqué, ce que la commande du plugin 3.2.2 ne fait pas.
const SILENT_FIRST_TOOLS = new Set(['package_document']);
const SILENT_DIRECT_TOOLS = new Set(['export_pdf', 'export_png', 'package_document']);
const STATE_TOKEN_PATTERN = /^[a-f0-9]{16}$/;

function requiresExpectedDocumentState(tool, args) {
  return STATE_GUARDED_ROUTES.has(tool._meta?.route)
    && tool._meta?.mutatesDocument === true
    && tool.name !== 'create_document'
    && Number.isInteger(args.documentId);
}

function resultDocumentTarget(tool, args, result) {
  if (tool.name === 'close_document') return undefined;
  const nestedResult = result?.result && typeof result.result === 'object' && !Array.isArray(result.result)
    ? result.result
    : undefined;
  if (Number.isInteger(result?.restoredDocumentId ?? nestedResult?.restoredDocumentId)) {
    return {
      documentId: result?.restoredDocumentId ?? nestedResult.restoredDocumentId,
      tokenField: 'restoredStateToken',
      revision: result?.revision ?? nestedResult?.revision,
    };
  }
  if (Number.isInteger(result?.workingDocumentId ?? nestedResult?.workingDocumentId)) {
    return {
      documentId: result?.workingDocumentId ?? nestedResult.workingDocumentId,
      tokenField: 'workingStateToken',
      revision: result?.workingRevision ?? nestedResult?.workingRevision,
    };
  }
  const documentId = Number.isInteger(result?.documentId)
    ? result.documentId
    : Number.isInteger(nestedResult?.documentId) ? nestedResult.documentId : args.documentId;
  if (!Number.isInteger(documentId)) return undefined;
  return { documentId, tokenField: undefined, revision: result?.revision ?? nestedResult?.revision };
}

function addAuditWarning(result) {
  const output = asObject(result);
  if (!output.auditWarning) output.auditWarning = AUDIT_WARNING;
  return output;
}

function preflightIssueCount(aggregatedResults) {
  if (!Array.isArray(aggregatedResults) || aggregatedResults.length < 3 || !Array.isArray(aggregatedResults[2])) {
    const error = new Error('Le contrôle Adobe n’a pas renvoyé sa structure de résultats officielle.');
    error.code = 'PREFLIGHT_RESULT_INVALID';
    throw error;
  }
  return aggregatedResults[2].length;
}

export class Application {
  constructor({
    config,
    verifyParent,
    transportFactory = () => new StdioServerTransport(),
    silentBridgeFactory = (options) => new InDesignSilentBridge(options),
    bridgeFactory = (options) => new InDesignBridge(options),
    sharedBridgeFactory = (options) => new SharedInDesignBridgeClient(options),
    operationMutexGuardFactory,
    portOwnerLookup = findWindowsTcpListenerOwnerPid,
  }) {
    this.config = config;
    this.verifyParent = verifyParent;
    this.transportFactory = transportFactory;
    this.silentBridgeFactory = silentBridgeFactory;
    this.bridgeFactory = bridgeFactory;
    this.sharedBridgeFactory = sharedBridgeFactory;
    this.operationMutexGuardFactory = operationMutexGuardFactory;
    this.portOwnerLookup = portOwnerLookup;
    this.operationQueue = new FifoQueue({ maxLength: config.maxQueueLength });
    this.audit = new AuditLogger(config.auditFile);
    this.tools = buildToolCatalog({ profile: config.toolProfile ?? 'full' });
    this.toolByName = new Map(this.tools.map((tool) => [tool.name, tool]));
    const ajv = new Ajv2020({ allErrors: true, strict: false, useDefaults: true });
    this.validators = new Map(this.tools.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]));
    this.server = new Server({ name: PACKAGE_NAME, version: PACKAGE_VERSION }, { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS });
    this.legacyServer = new LegacyServer();
    this.started = false;
    this.startPromise = null;
    this.#registerMcpHandlers();
  }

  async start() {
    if (this.started) return;
    if (this.startPromise) return this.startPromise;
    const attempt = this.#startOnce();
    this.startPromise = attempt;
    try {
      await attempt;
    } finally {
      if (this.startPromise === attempt) this.startPromise = null;
    }
  }

  async close() {
    const attempt = this.startPromise;
    if (attempt) await attempt.catch(() => {});
    await this.#rollbackStart();
  }

  async #startOnce() {
    try {
      await this.verifyParent({ allowedPaths: this.config.allowedParentPaths, allowedSigners: this.config.allowedParentSigners, allowedNames: this.config.allowedParentNames });
      const secret = await new TokenStore(this.config.tokenFile).ensure();
      const privateRoot = this.config.privateRoot;
      this.pathPolicy = await PathPolicy.create({
        readRoots: this.config.readRoots,
        writeRoots: this.config.writeRoots,
        deniedRoots: this.config.deniedRoots,
      });
      if (this.config.auditFile) {
        if (!['.jsonl', '.log'].includes(path.extname(this.config.auditFile).toLowerCase())) throw new Error('Le journal interne doit être un fichier .jsonl ou .log.');
        const auditDirectory = await preparePrivateDirectory(path.dirname(this.config.auditFile), privateRoot);
        const prospectiveAuditFile = path.join(auditDirectory, path.basename(this.config.auditFile));
        const handle = await fs.open(prospectiveAuditFile, 'a', 0o600);
        await handle.close();
        const auditStat = await fs.lstat(prospectiveAuditFile);
        if (!auditStat.isFile() || auditStat.isSymbolicLink()) throw new Error('Le journal interne ne peut pas être un lien.');
        this.audit.filePath = prospectiveAuditFile;
        await applyWindowsPrivateAcl(this.audit.filePath, { kind: 'file' });
      }
      this.backupRoot = await preparePrivateDirectory(this.config.backupRoot, privateRoot);
      let runtimeRoot;
      if (this.config.port === 0) {
        runtimeRoot = await preparePrivateDirectory(path.join(privateRoot, '.test-runtime'), privateRoot);
      } else {
        // Runtime sous le stockage privé local, jamais sous %LOCALAPPDATA% : une application empaquetée (Claude)
        // y voit une copie virtuelle qu'InDesign ne lit pas, et InDesign exécute alors le chemin comme du code.
        runtimeRoot = path.join(privateRoot, 'runtime');
        const oneDrive = process.env.OneDrive;
        if (oneDrive && path.isAbsolute(oneDrive) && isInside(path.resolve(oneDrive), runtimeRoot)) {
          throw new Error('Le runtime InDesign doit rester hors OneDrive; déclarez INDESIGN_MCP_PRIVATE_ROOT hors OneDrive.');
        }
        await fs.mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
        const runtimeStat = await fs.lstat(runtimeRoot);
        if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink()) throw new Error('Le runtime local InDesign doit être un dossier normal.');
        await applyWindowsPrivateAcl(runtimeRoot, { kind: 'directory', recursive: true });
      }
      this.cleanupBackups = () => cleanupBackups(this.backupRoot, {
        maxAgeMs: this.config.backupMaxAgeHours * 60 * 60 * 1000,
        maxFiles: this.config.backupMaxFiles,
      });
      await this.cleanupBackups();
      this.silentBridge = this.silentBridgeFactory({
        backupDirectory: this.backupRoot,
        runtimeRoot: path.join(runtimeRoot, 'silent-runtime'),
        timeoutMs: this.config.commandTimeoutMs,
        maxResultBytes: this.config.maxPayloadBytes,
        ...(this.operationMutexGuardFactory ? { operationMutexFactory: this.operationMutexGuardFactory } : {}),
      });
      try {
        await this.silentBridge.initialize();
        this.silentBridgeError = null;
      } catch (error) {
        this.silentBridgeError = error;
      }
      const bridgeOptions = {
        config: this.config,
        secret,
        operationDirectory: path.join(runtimeRoot, 'plugin-runtime'),
        protect: applyWindowsPrivateAcl,
        ...(this.operationMutexGuardFactory ? { operationMutexFactory: this.operationMutexGuardFactory } : {}),
      };
      this.bridge = this.bridgeFactory(bridgeOptions);
      try {
        await this.bridge.start();
        this.bridgeError = null;
      } catch (error) {
        // Un bridge partiellement ouvert doit être réellement fermé avant de
        // rejoindre le courtier détenu par la tâche propriétaire du port.
        await this.bridge.close();
        const diagnostic = await diagnoseBridgeStartupError(error, {
          host: this.config.host,
          port: this.config.port,
          ownerLookup: this.portOwnerLookup,
        });
        if (diagnostic.code === 'EADDRINUSE' && this.config.port !== 0) {
          const sharedBridge = this.sharedBridgeFactory({
            config: this.config,
            secret,
            expectedOwnerPid: diagnostic.listenerOwnerPid,
            takeoverFactory: () => this.bridgeFactory(bridgeOptions),
          });
          try {
            await sharedBridge.start();
            this.bridge = sharedBridge;
            this.bridgeError = null;
          } catch (sharedError) {
            await Promise.resolve(sharedBridge.close?.()).catch(() => {});
            this.bridge = undefined;
            this.bridgeError = {
              ...diagnostic,
              brokerCode: typeof sharedError?.code === 'string' ? sharedError.code : 'SHARED_BRIDGE_UNAVAILABLE',
            };
          }
        } else {
          this.bridge = undefined;
          this.bridgeError = diagnostic;
        }
      }
      ScriptExecutor.configure({ bridge: this.bridge, silentBridge: this.silentBridge, audit: this.audit, backupDirectory: this.backupRoot, cleanupBackups: this.cleanupBackups });
      this.transport = this.transportFactory();
      await this.server.connect(this.transport);
      this.started = true;
    } catch (error) {
      await this.#rollbackStart();
      throw error;
    }
  }

  async #rollbackStart() {
    const transport = this.transport;
    const bridge = this.bridge;
    const silentBridge = this.silentBridge;
    await this.server.close().catch(() => {});
    if (transport && this.server.transport === transport) {
      await transport.close?.().catch(() => {});
    }
    if (transport && this.server.transport === transport) {
      try { transport.onclose?.(); } catch {}
    }
    await bridge?.close?.().catch(() => {});
    await silentBridge?.close?.().catch(() => {});
    if (ScriptExecutor.bridge === bridge) {
      ScriptExecutor.configure({ bridge: undefined, silentBridge: undefined, audit: undefined, backupDirectory: undefined, cleanupBackups: undefined });
    }
    this.transport = undefined;
    this.bridge = undefined;
    this.silentBridge = undefined;
    this.bridgeError = undefined;
    this.silentBridgeError = undefined;
    this.pathPolicy = undefined;
    this.backupRoot = undefined;
    this.cleanupBackups = undefined;
    this.started = false;
  }

  #registerMcpHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.tools.map(publicTool) }));
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const started = Date.now();
      const name = request.params.name;
      const tool = this.toolByName.get(name);
      if (!tool) return this.#error(`Outil inconnu: ${name}`);
      const args = structuredClone(request.params.arguments ?? {});
      const validator = this.validators.get(name);
      if (!validator(args)) return this.#error(`Paramètres invalides: ${validationMessage(validator.errors)}`);
      try {
        await this.#applyPathPolicy(tool, args);
      } catch (error) {
        await this.audit.write({ event: 'tool_call', toolName: name, documentId: args.documentId, expectedRevision: args.expectedRevision, reason: args.reason, errorCode: error.code, outcome: 'validation_error', durationMs: Date.now() - started }).catch(() => {});
        return this.#error(`${error.code ? `${error.code}: ` : ''}${error.message}`);
      }
      try {
        await this.audit.write({ event: 'tool_call_start', toolName: name, documentId: args.documentId, expectedRevision: args.expectedRevision, reason: args.reason, outcome: 'started', durationMs: 0 });
      } catch {
        return this.#error('AUDIT_UNAVAILABLE: la commande n’a pas été envoyée à InDesign car le journal de début est indisponible.');
      }

      let result;
      try {
        result = await this.operationQueue.enqueue(() => this.#dispatchWithMutationLease(tool, args));
      } catch (error) {
        await this.audit.write({ event: 'tool_call', toolName: name, documentId: args.documentId, expectedRevision: args.expectedRevision, reason: args.reason, backupId: error.backupId, backupIds: error.safetyBackups?.map((backup) => backup.backupId), operationId: error.operationId, requiresInspection: error.requiresInspection, errorCode: error.code, outcome: 'error', durationMs: Date.now() - started }).catch(() => {});
        const recovery = (error.backupId || error.safetyBackups || error.operationId || error.targetBackupId || error.partialOutputPath || error.documentStates)
          ? {
              backupId: error.backupId,
              backupPath: error.backupPath,
              safetyBackups: error.safetyBackups,
              operationId: error.operationId,
              requiresInspection: error.requiresInspection === true,
              documentStates: error.documentStates,
              targetBackupId: error.targetBackupId,
              targetBackupPath: error.targetBackupPath,
              partialOutputPath: error.partialOutputPath,
            }
          : undefined;
        return this.#error(`${error.code ? `${error.code}: ` : ''}${error.message}`, recovery);
      }

      let structuredContent = asObject(result);
      try {
        const primaryBackup = structuredContent.backupId
          ?? structuredContent.safetyBackups?.find((backup) => backup.documentId === args.documentId)?.backupId;
        const backupIds = [
          ...(structuredContent.safetyBackups ?? []),
          ...(structuredContent.recoveryBackups ?? []),
        ].map((backup) => backup.backupId);
        await this.audit.write({ event: 'tool_call', toolName: name, documentId: args.documentId, expectedRevision: args.expectedRevision, reason: args.reason, backupId: primaryBackup, backupIds, operationId: structuredContent.operationId, requiresInspection: structuredContent.requiresInspection, outcome: 'success', durationMs: Date.now() - started });
      } catch {
        structuredContent = addAuditWarning(structuredContent);
      }
      return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
    });
  }

  async #applyPathPolicy(tool, args) {
    const rules = tool._meta?.pathRules?.length ? tool._meta.pathRules : LEGACY_PATH_RULES[tool.name] ?? [];
    for (const rule of rules) {
      if (args[rule.field] === undefined) continue;
      args[rule.field] = rule.access === 'read'
        ? await this.pathPolicy.validateRead(args[rule.field], rule)
        : await this.pathPolicy.validateWrite(args[rule.field], rule);
      if (rule.access === 'write' && rule.mustNotExist) {
        try {
          await fs.lstat(args[rule.field]);
          throw new OutputTargetError('La cible de cet outil hérité existe déjà; l’écrasement implicite est refusé.', 'TARGET_EXISTS');
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    }
  }

  async #dispatch(tool, args) {
    if (tool.name === 'indesign_doctor') {
      return runInDesignDoctor({
        tools: this.tools,
        config: this.config,
        bridge: this.bridge,
        bridgeError: this.bridgeError,
        silentBridge: this.silentBridge,
        silentBridgeError: this.silentBridgeError,
        includeTools: args.includeTools,
      });
    }
    if (tool.name === 'search_official_dom') return searchOfficialDom(args.query, { limit: args.limit });
    if (tool.name === 'bridge_status') {
      if (this.bridgeError) return bridgeUnavailableStatus(this.bridgeError);
      const status = typeof this.bridge.refreshStatus === 'function'
        ? await this.bridge.refreshStatus()
        : this.bridge.status();
      if (status.available === false) return bridgeUnavailableStatus(status);
      return {
        available: true,
        ...status,
        listenerOwnedByThisInstance: status.brokerRole === 'owner' && status.listening === true,
        ownsPluginSession: status.brokerRole === 'owner' && status.authenticated === true,
        pluginSessionUsable: status.authenticated === true,
        serverQueueLength: this.operationQueue.length,
      };
    }
    if (tool.name === 'bridge_open_pairing_window') {
      if (this.bridgeError) {
        const owner = Number.isSafeInteger(this.bridgeError.listenerOwnerPid)
          ? ` (PID ${this.bridgeError.listenerOwnerPid})`
          : '';
        const error = new Error(`Cette tâche ne possède pas le listener UXP${owner}; ouvrez l’appairage depuis la tâche propriétaire.`);
        error.code = 'PAIRING_LISTENER_NOT_OWNED';
        throw error;
      }
      return this.bridge.openPairingWindow({ windowSeconds: args.windowSeconds });
    }
    if (tool.name === 'bridge_arm_pairing_clipboard') {
      if (this.bridgeError) {
        const owner = Number.isSafeInteger(this.bridgeError.listenerOwnerPid)
          ? ` (PID ${this.bridgeError.listenerOwnerPid})`
          : '';
        const error = new Error(`Cette tâche ne possède pas le listener UXP${owner}; armez le presse-papiers depuis la tâche propriétaire.`);
        error.code = 'PAIRING_LISTENER_NOT_OWNED';
        throw error;
      }
      return this.bridge.armPairingClipboard();
    }
    if (tool.name === 'silent_status') {
      if (this.silentBridgeError) return { available: false, mode: 'silent-com-uxp', message: 'Le canal silencieux est indisponible; le plugin UXP existant reste opérationnel.' };
      try {
        const status = await this.silentBridge.status();
        const retention = status.restoredMarkerRefresh?.removed > 0 ? await this.cleanupBackups() : undefined;
        return { available: true, ...status, retention, serverQueueLength: this.operationQueue.length };
      } catch {
        return { available: false, mode: 'silent-com-uxp', message: 'InDesign ne répond pas par COM; le plugin UXP peut rester utilisable.' };
      }
    }
    if (tool.name === 'silent_list_documents') return this.#requireSilentBridge().listDocuments();
    if (tool.name === 'silent_inspect_document') return this.#requireSilentBridge().inspectDocument(args.documentId);
    if (tool.name === 'silent_audit_document') {
      return this.#requireSilentBridge().auditDocument(args.documentId, { maxItems: args.maxItems });
    }
    if (tool.name === 'silent_close_document') return this.#requireSilentBridge().closeDocument(args);
    if (tool.name === 'silent_operation_status') return this.#requireSilentBridge().operationStatus(args.operationId);
    if (tool.name === 'silent_reconcile_unknown_operation') {
      const pluginStatus = await this.bridge?.operationStatus(args.operationId);
      const pluginOperation = pluginStatus && pluginStatus.status !== 'not-found';
      const result = await this.#requireSilentBridge().reconcileUnknownOperation(args, {
        runScript: pluginOperation
          ? (options) => this.bridge.runOperationReconciliation({ operationId: args.operationId, ...options })
          : undefined,
      });
      if (pluginOperation) {
        const acknowledged = await this.bridge.acknowledgeOperation(args.operationId);
        if (!acknowledged) {
          const error = new Error('La réconciliation a réussi, mais le verrou plugin n’a pas confirmé son acquittement.');
          error.code = 'OPERATION_ACKNOWLEDGEMENT_FAILED';
          error.operationId = args.operationId;
          error.requiresInspection = true;
          throw error;
        }
      }
      return result;
    }
    if (tool.name === 'bridge_operation_status') return await this.#requirePluginBridge().operationStatus(args.operationId);
    if (tool.name === 'silent_restore_backup') {
      return this.#requireSilentBridge().restoreBackup(args);
    }
    if (tool.name === 'open_document') {
      return this.#requireSilentBridge().openDocument(args.path);
    }
    if (tool.name === 'create_document' && args.__createChannel === 'silent') {
      const { __createChannel: _channel, expectedRevision: _revision, documentId: _documentId, ...spec } = args;
      return this.#requireSilentBridge().createDocument(spec);
    }
    if (SILENT_STRUCTURED_READS.has(tool.name)) {
      return this.#requireSilentBridge().readDocument(tool.name, args);
    }
    if (tool.name === 'preflight_document') {
      const { operationId: _operationId, ...result } = await this.#requireSilentBridge().preflightDocument(args);
      return result;
    }
    if (tool.name === 'run_layout_script') return this.#requireSilentBridge().runLayoutScript(args);
    if (tool.name === 'execute_uxp_silent') {
      return this.#requireSilentBridge().executeDocument(args);
    }
    if (tool.name === 'execute_uxp') {
      this.#requirePluginBridge();
      return ScriptExecutor.withContext({ toolName: tool.name, scope: args.scope, documentId: args.documentId, expectedRevision: args.expectedRevision, expectedStateToken: args.expectedStateToken, reason: args.reason }, () => ScriptExecutor.executeViaUXP(args.code, args.input));
    }
    if (tool.name === 'restore_safety_backup') {
      this.#requirePluginBridge();
      return this.#restoreSafetyBackup(args);
    }
    if (tool._meta.route === 'workflow') return this.#dispatchWorkflow(tool, args);
    if (tool._meta.route === 'direct') return this.#dispatchDirect(tool, args);
    if (tool._meta.route === 'legacy-local') return this.legacyServer.handleToolCall(tool.name, args);

    return ScriptExecutor.withContext(
      {
        toolName: tool.name,
        scope: args.scope,
        documentId: args.documentId,
        expectedRevision: args.expectedRevision,
        expectedStateToken: args.expectedStateToken,
        reason: args.reason,
        legacyGeneratedCode: tool.name !== 'execute_indesign_code',
      },
      async () => {
        this.#requirePluginBridge();
        if (LEGACY_MISSING_NAMES.has(tool.name)) return handleLegacyMissing(tool.name, args);
        return this.legacyServer.handleToolCall(tool.name, args);
      },
    );
  }

  async #dispatchWithMutationLease(tool, args) {
    const needsExclusiveInDesignAccess = tool._meta?.mutatesDocument || tool.annotations?.destructiveHint;
    const silentToolOwnsItsLease = tool._meta.route === 'silent' && tool.name !== 'preflight_document';
    if (!needsExclusiveInDesignAccess || silentToolOwnsItsLease) return this.#dispatch(tool, args);
    // Sans panneau jumelé (ou pour enregistrer aussitôt), la création passe par le canal silencieux, qui tient son bail.
    // Le plugin ignore path : avec path, le canal silencieux est exigé (refus explicite s'il manque).
    if (tool.name === 'create_document' && (args.path !== undefined
      || (!this.silentBridgeError && this.silentBridge && !this.#pluginSessionUsable()))) {
      args.__createChannel = 'silent';
      return this.#dispatch(tool, args);
    }
    const leaseBridge = this.#requireSilentBridge();
    const leaseOperationId = crypto.randomUUID();
    if (this.#shouldUseSilentExport(tool)) {
      args.__exportChannel = 'silent';
      return leaseBridge.withSilentMutationLease(leaseOperationId, () => (
        this.#dispatchGuardedOperation(tool, args, leaseOperationId, { pluginOperation: false })
      ));
    }
    await leaseBridge.acquireExternalMutationLease(leaseOperationId);
    return leaseBridge.withExpectedExternalLease(leaseOperationId, async () => {
      try {
        const result = await this.#dispatchGuardedOperation(tool, args, leaseOperationId, { pluginOperation: true });
        await leaseBridge.releaseExternalMutationLease(leaseOperationId);
        return result;
      } catch (error) {
        if (error.requiresInspection === true) {
          if (typeof error.operationId === 'string' && error.operationId !== leaseOperationId) {
            await leaseBridge.transferExternalMutationLease(leaseOperationId, error.operationId);
          } else {
            error.operationId ??= leaseOperationId;
          }
        } else {
          await leaseBridge.releaseExternalMutationLease(leaseOperationId);
        }
        throw error;
      }
    });
  }

  #shouldUseSilentExport(tool) {
    if (!SILENT_EXPORT_TOOLS.has(tool.name) || this.silentBridgeError || !this.silentBridge) return false;
    if (SILENT_FIRST_TOOLS.has(tool.name)) return true;
    return !this.#pluginSessionUsable();
  }

  #pluginSessionUsable() {
    if (this.bridgeError || !this.bridge) return false;
    try {
      return this.bridge.status()?.authenticated === true;
    } catch {
      return false;
    }
  }

  async #dispatchGuardedOperation(tool, args, leaseOperationId, { pluginOperation }) {
    if (requiresExpectedDocumentState(tool, args)) {
      const inspected = await this.#inspectDocumentState(args.documentId);
      if (inspected.revision !== args.expectedRevision) {
        const error = new Error('Le document a changé depuis la dernière lecture.');
        error.code = 'REVISION_CONFLICT';
        throw error;
      }
      if (typeof args.expectedStateToken !== 'string' || !STATE_TOKEN_PATTERN.test(args.expectedStateToken)) {
        const error = new Error('Le stateToken observé avant la mutation est obligatoire.');
        error.code = 'STATE_TOKEN_REQUIRED';
        throw error;
      }
      if (inspected.stateToken !== args.expectedStateToken) {
        const error = new Error('Le contenu ou la structure du document a changé depuis la dernière inspection.');
        error.code = 'STATE_CONFLICT';
        throw error;
      }
      args.__verifiedStateToken = inspected.stateToken;
    }

    const dispatch = () => this.#dispatch(tool, args);
    let result = pluginOperation && typeof this.bridge?.withOperationId === 'function'
      ? await this.bridge.withOperationId(leaseOperationId, dispatch)
      : await dispatch();
    const resultTarget = STATE_RETURNING_ROUTES.has(tool._meta?.route) && tool._meta?.mutatesDocument === true
      ? resultDocumentTarget(tool, args, result)
      : undefined;
    if (!resultTarget) return result;

    let inspected;
    try {
      inspected = await this.#inspectDocumentState(resultTarget.documentId);
    } catch (error) {
      error.code ??= 'STATE_VERIFICATION_FAILED';
      error.requiresInspection = true;
      throw error;
    }
    if (Number.isInteger(resultTarget.revision) && inspected.revision !== resultTarget.revision) {
      const error = new Error('La révision relue après la commande ne correspond pas au résultat InDesign.');
      error.code = 'REVISION_RESULT_MISMATCH';
      error.requiresInspection = true;
      throw error;
    }
    const reportedStateToken = result?.stateToken ?? result?.result?.stateToken;
    const stateTokenRequired = tool._meta?.route === 'direct' && tool.name !== 'close_document';
    if (stateTokenRequired && !STATE_TOKEN_PATTERN.test(reportedStateToken ?? '')) {
      const error = new Error('Le canal d’exécution n’a pas renvoyé le stateToken obligatoire après la commande.');
      error.code = 'DOCUMENT_STATE_INVALID';
      error.requiresInspection = true;
      throw error;
    }
    if (reportedStateToken !== undefined && reportedStateToken !== inspected.stateToken) {
      const error = new Error('Le stateToken renvoyé ne correspond pas à l’état relu dans InDesign.');
      error.code = 'STATE_VERIFICATION_FAILED';
      error.requiresInspection = true;
      throw error;
    }
    result = {
      ...asObject(result),
      stateToken: inspected.stateToken,
      ...(resultTarget.tokenField ? { [resultTarget.tokenField]: inspected.stateToken } : {}),
    };
    return result;
  }

  #requireSilentBridge() {
    if (this.silentBridgeError) {
      const error = new Error('Le canal silencieux est indisponible; utilisez les outils UXP existants.');
      error.code = 'SILENT_CHANNEL_UNAVAILABLE';
      throw error;
    }
    return this.silentBridge;
  }

  #requirePluginBridge() {
    if (this.bridgeError) {
      const error = new Error('Le plugin UXP est indisponible; utilisez le canal silencieux ou relancez le plugin.');
      error.code = 'PLUGIN_CHANNEL_UNAVAILABLE';
      throw error;
    }
    return this.bridge;
  }

  async #inspectDocumentState(documentId) {
    const inspected = await this.#requireSilentBridge().inspectDocument(documentId);
    const document = inspected?.document;
    if (
      !document
      || document.documentId !== documentId
      || !Number.isInteger(document.revision)
      || document.revision < 0
      || !STATE_TOKEN_PATTERN.test(document.stateToken ?? '')
    ) {
      const error = new Error('L’inspection silencieuse du document a renvoyé un état invalide.');
      error.code = 'DOCUMENT_STATE_INVALID';
      throw error;
    }
    return document;
  }

  async #dispatchDirect(tool, input) {
    const useSilentExport = input.__exportChannel === 'silent' && SILENT_DIRECT_TOOLS.has(tool.name);
    if (useSilentExport) this.#requireSilentBridge();
    else this.#requirePluginBridge();
    const args = structuredClone(input);
    const documentId = args.documentId;
    const expectedRevision = args.expectedRevision;
    const reason = args.reason;
    const verifiedStateToken = args.__verifiedStateToken;
    delete args.documentId;
    delete args.expectedRevision;
    delete args.expectedStateToken;
    delete args.__verifiedStateToken;
    delete args.__exportChannel;
    delete args.reason;

    let expectedPngCount;
    if (tool.name === 'export_png' && args.pageId === undefined) {
      const documentInfo = useSilentExport
        ? await this.silentBridge.readDocument('get_document_info', { documentId })
        : await this.bridge.execute({ command: 'get_document_info', args: {}, documentId, expectedRevision });
      expectedPngCount = expectedPageCount(args.pageRange, useSilentExport ? documentInfo.document?.pages : documentInfo.result?.pages);
    }

    let targetProtection = {};
    const configuredOutputTarget = OUTPUT_TARGETS[tool.name];
    const outputTarget = typeof configuredOutputTarget === 'function'
      ? configuredOutputTarget(args)
      : configuredOutputTarget;
    if (outputTarget) {
      targetProtection = await prepareOutputTarget({
        targetPath: args[outputTarget.field],
        kind: outputTarget.kind,
        overwrite: args.overwrite,
        backupRoot: this.backupRoot,
      });
      delete args.overwrite;
    }

    let backupId;
    let backupPath;
    let backupProvenance;
    if (!useSilentExport && (tool._meta?.mutatesDocument || tool.annotations.destructiveHint) && Number.isInteger(documentId)) {
      const backup = await this.bridge.execute({
        command: 'create_safety_backup',
        documentId,
        expectedRevision,
        expectedStateToken: verifiedStateToken,
        args: { reason, toolName: tool.name, backupDirectory: this.backupRoot },
      });
      backupId = backup.result?.backupId;
      backupPath = backup.result?.backupPath;
      if (!backupId) throw new Error('La sauvegarde préalable n’a pas produit de backupId.');
      await verifyArtifact({ targetPath: backupPath, kind: 'indd' });
      const afterBackup = await this.#inspectDocumentState(documentId);
      if (afterBackup.revision !== expectedRevision || afterBackup.stateToken !== verifiedStateToken) {
        const error = new Error('Le document a changé pendant sa sauvegarde de sécurité.');
        error.code = 'STATE_CONFLICT';
        throw error;
      }
      backupProvenance = await this.silentBridge.registerExternalBackup({
        backupId,
        backupPath,
        documentId,
        revision: expectedRevision,
        stateToken: verifiedStateToken,
      });
      args.backupId = backupId;
      args.reason = reason;
    }

    let createdOutputDirectory = false;
    if (outputTarget?.createDirectory) {
      try {
        if (targetProtection.targetBackupId) await fs.rm(args[outputTarget.field], { recursive: true, force: false });
        await fs.mkdir(args[outputTarget.field], { recursive: false });
        createdOutputDirectory = true;
      } catch (error) {
        if (error.code === 'EEXIST') {
          throw new OutputTargetError('La cible a été créée entre sa vérification et l’export; aucun écrasement non protégé n’a eu lieu.', 'TARGET_EXISTS');
        }
        throw error;
      }
    }

    try {
      if (Number.isInteger(documentId) && verifiedStateToken) {
        const ready = await this.#inspectDocumentState(documentId);
        if (ready.revision !== expectedRevision || ready.stateToken !== verifiedStateToken) {
          const error = new Error('Le document a changé juste avant l’envoi de la commande à InDesign.');
          error.code = 'STATE_CONFLICT';
          throw error;
        }
      }
      const response = useSilentExport
        ? await this.silentBridge.exportDocument({ command: tool.name, documentId, expectedRevision, expectedStateToken: verifiedStateToken, ...args })
        : await this.bridge.execute({ command: tool.name, args, documentId, expectedRevision, expectedStateToken: verifiedStateToken });
      const safetyBackups = useSilentExport && Array.isArray(response.safetyBackups) ? response.safetyBackups : undefined;
      if (safetyBackups) {
        const targetBackup = safetyBackups.find((backup) => backup.documentId === documentId);
        backupId = targetBackup?.backupId;
        backupPath = targetBackup?.backupPath;
        backupProvenance = targetBackup
          ? { metadataPath: targetBackup.metadataPath, artifact: { sha256: targetBackup.artifactSha256 } }
          : undefined;
      }
      const configuredArtifactTarget = ARTIFACT_TARGETS[tool.name];
      const artifactTarget = typeof configuredArtifactTarget === 'function'
        ? configuredArtifactTarget(args)
        : configuredArtifactTarget;
      if (expectedPngCount !== undefined && (!Array.isArray(response.result?.paths) || response.result.paths.length !== expectedPngCount)) {
        const mismatch = new Error(`InDesign a déclaré ${response.result?.paths?.length ?? 0} PNG sur ${expectedPngCount} attendus.`);
        mismatch.code = 'ARTIFACT_PAGE_COUNT_MISMATCH';
        throw mismatch;
      }
      const artifactVerification = artifactTarget
        ? await verifyArtifact({ targetPath: args[artifactTarget.field], kind: artifactTarget.kind, expectedPaths: response.result?.paths })
        : undefined;
      return {
        ...asObject(response.result),
        documentId: response.documentId ?? documentId,
        revision: response.revision,
        stateToken: response.stateToken ?? response.result?.stateToken,
        backupId,
        backupPath,
        backupMetadataPath: backupProvenance?.metadataPath,
        backupArtifactSha256: backupProvenance?.artifact.sha256,
        safetyBackups,
        ...(SILENT_DIRECT_TOOLS.has(tool.name)
          ? { executionChannel: useSilentExport ? 'silent' : 'plugin' }
          : {}),
        ...targetProtection,
        artifactVerification,
      };
    } catch (error) {
      if (createdOutputDirectory && error.requiresInspection !== true) {
        await fs.rm(args[outputTarget.field], { recursive: true, force: true }).catch(() => {});
      } else if (createdOutputDirectory) {
        error.partialOutputPath ??= args[outputTarget.field];
      }
      error.backupId ??= backupId;
      error.backupPath ??= backupPath;
      error.targetBackupId ??= targetProtection.targetBackupId;
      error.targetBackupPath ??= targetProtection.targetBackupPath;
      throw error;
    }
  }

  async #captureLayout({ documentId, expectedRevision, maxItems, contract }) {
    const snapshot = await this.#requireSilentBridge().readDocument('analyze_layout', { documentId, maxItems });
    if (Number.isInteger(expectedRevision) && snapshot.revision !== expectedRevision) {
      const error = new Error('Le document a changé depuis la dernière lecture.');
      error.code = 'REVISION_CONFLICT';
      throw error;
    }
    return analyzeLayoutSnapshot(snapshot, contract ?? {});
  }

  async #dispatchWorkflow(tool, input) {
    if (tool.name === 'analyze_layout') return this.#captureLayout(input);
    if (tool.name === 'compare_layout_snapshot') {
      const analysis = await this.#captureLayout(input);
      return {
        matches: analysis.fingerprint === input.baselineFingerprint,
        baselineFingerprint: input.baselineFingerprint,
        currentFingerprint: analysis.fingerprint,
        statistics: analysis.statistics,
        anomalies: summarizeLayoutAnomalies(analysis.lint),
      };
    }
    if (tool.name === 'create_working_copy') return this.#createWorkingCopy(input);
    if (tool.name === 'preview_layout') {
      const analysisBefore = await this.#captureLayout(input);
      const exportTool = this.toolByName.get('export_png');
      const preview = await this.#dispatchDirect(exportTool, {
        documentId: input.documentId,
        expectedRevision: input.expectedRevision,
        expectedStateToken: input.expectedStateToken,
        __verifiedStateToken: input.__verifiedStateToken,
        __exportChannel: input.__exportChannel,
        reason: input.reason,
        folderPath: input.folderPath,
        pageRange: input.pageRange,
        resolution: input.resolution,
        transparentBackground: input.transparentBackground,
        overwrite: input.overwrite,
      });
      const analysisAfter = await this.#captureLayout({ ...input, expectedRevision: preview.revision ?? input.expectedRevision });
      if (analysisBefore.fingerprint !== analysisAfter.fingerprint) {
        const error = new Error('La mise en page a changé pendant la production de l’aperçu.');
        error.code = 'PREVIEW_ROUND_TRIP_MISMATCH';
        error.requiresInspection = true;
        error.partialOutputPath = input.folderPath;
        throw error;
      }
      return { preview, analysis: analysisAfter, sourceUnchanged: true };
    }
    if (tool.name === 'finalize_layout') {
      const analysis = await this.#captureLayout(input);
      if (!analysis.lint.passed) {
        return {
          exported: false,
          gate: 'layout-contract',
          message: 'Le PDF final n’a pas été produit car le contrat contient des écarts bloquants.',
          analysis,
        };
      }
      const preflight = await this.#requireSilentBridge().preflightDocument({
        documentId: input.documentId,
        expectedRevision: input.expectedRevision,
        profileName: input.profileName,
        timeoutSeconds: input.timeoutSeconds,
      });
      const preflightIssues = preflightIssueCount(preflight.aggregatedResults);
      if (preflightIssues > 0) {
        return {
          exported: false,
          gate: 'adobe-preflight',
          message: 'Le PDF final n’a pas été produit car le contrôle Adobe contient des erreurs.',
          analysis,
          preflight,
          preflightIssues,
        };
      }
      const exportTool = this.toolByName.get('export_pdf');
      const pdf = await this.#dispatchDirect(exportTool, {
        documentId: input.documentId,
        expectedRevision: input.expectedRevision,
        expectedStateToken: input.expectedStateToken,
        __verifiedStateToken: input.__verifiedStateToken,
        __exportChannel: input.__exportChannel,
        reason: input.reason,
        filePath: input.filePath,
        presetName: input.presetName,
        overwrite: input.overwrite,
      });
      return {
        exported: true,
        gate: 'passed',
        analysis,
        preflight,
        pdf,
      };
    }
    throw new Error(`Workflow inconnu: ${tool.name}`);
  }

  async #createWorkingCopy(input) {
    this.#requirePluginBridge();
    const silent = this.#requireSilentBridge();
    const verifiedStateToken = input.__verifiedStateToken ?? input.expectedStateToken;
    const before = (await silent.inspectDocument(input.documentId)).document;
    if (!before || before.revision !== input.expectedRevision) {
      const error = new Error('Le document source a changé avant la création de la copie de travail.');
      error.code = 'REVISION_CONFLICT';
      throw error;
    }
    if (before.stateToken !== verifiedStateToken) {
      const error = new Error('Le contenu du document source a changé avant la création de la copie de travail.');
      error.code = 'STATE_CONFLICT';
      throw error;
    }

    const targetProtection = await prepareOutputTarget({
      targetPath: input.path,
      kind: 'file',
      overwrite: input.overwrite,
      backupRoot: this.backupRoot,
    });
    const safety = await this.bridge.execute({
      command: 'create_safety_backup',
      documentId: input.documentId,
      expectedRevision: input.expectedRevision,
      expectedStateToken: before.stateToken,
      args: { reason: input.reason, toolName: 'create_working_copy', backupDirectory: this.backupRoot },
    });
    const backupId = safety.result?.backupId;
    const backupPath = safety.result?.backupPath;
    if (!backupId || !backupPath) throw new Error('La sauvegarde source n’a pas produit de copie exploitable.');
    await verifyArtifact({ targetPath: backupPath, kind: 'indd' });
    const afterBackup = (await silent.inspectDocument(input.documentId)).document;
    if (afterBackup?.revision !== before.revision || afterBackup?.stateToken !== before.stateToken) {
      const error = new Error('Le document source a changé pendant sa sauvegarde de sécurité.');
      error.code = 'STATE_CONFLICT';
      throw error;
    }
    const backupProvenance = await silent.registerExternalBackup({
      backupId,
      backupPath,
      documentId: input.documentId,
      revision: before.revision,
      stateToken: before.stateToken,
    });

    let copyCreated = false;
    let opened = false;
    try {
      if (targetProtection.targetBackupPath) await fs.unlink(input.path);
      await fs.copyFile(backupPath, input.path, fsConstants.COPYFILE_EXCL);
      copyCreated = true;
      const artifactVerification = await verifyArtifact({ targetPath: input.path, kind: 'indd' });
      const openResponse = await this.bridge.execute({ command: 'open_document', args: { path: input.path } });
      opened = true;
      const after = (await silent.inspectDocument(input.documentId)).document;
      const sourceUnchanged = after?.revision === before.revision && after?.stateToken === before.stateToken;
      if (!sourceUnchanged) {
        const error = new Error('Le document source a changé pendant la création de la copie de travail.');
        error.code = 'WORKING_COPY_SOURCE_CHANGED';
        error.requiresInspection = true;
        error.partialOutputPath = input.path;
        throw error;
      }
      return {
        success: true,
        sourceDocumentId: input.documentId,
        sourceRevision: before.revision,
        sourceStateToken: before.stateToken,
        sourceUnchanged: true,
        workingDocumentId: openResponse.result?.documentId,
        workingRevision: openResponse.result?.revision,
        workingCopyPath: input.path,
        backupId,
        backupPath,
        backupMetadataPath: backupProvenance.metadataPath,
        backupArtifactSha256: backupProvenance.artifact.sha256,
        artifactVerification,
        ...targetProtection,
      };
    } catch (error) {
      error.backupId ??= backupId;
      error.backupPath ??= backupPath;
      error.targetBackupId ??= targetProtection.targetBackupId;
      error.targetBackupPath ??= targetProtection.targetBackupPath;
      if (error.requiresInspection === true || opened) {
        error.partialOutputPath ??= input.path;
      } else if (copyCreated) {
        await fs.unlink(input.path).catch(() => {});
      }
      if (error.requiresInspection !== true && !opened && targetProtection.targetBackupPath) {
        await fs.copyFile(targetProtection.targetBackupPath, input.path).catch(() => {});
      }
      throw error;
    }
  }

  async #restoreSafetyBackup(input) {
    const { documentId, expectedRevision, reason, backupId: targetBackupId } = input;
    const verifiedStateToken = input.__verifiedStateToken ?? input.expectedStateToken;
    const sourceBackupPath = path.join(this.backupRoot, `backup-${targetBackupId}.indd`);
    await verifyArtifact({ targetPath: sourceBackupPath, kind: 'indd' });
    const readyForRecovery = await this.#inspectDocumentState(documentId);
    if (readyForRecovery.revision !== expectedRevision || readyForRecovery.stateToken !== verifiedStateToken) {
      const error = new Error('Le document a changé avant sa sauvegarde de récupération.');
      error.code = 'STATE_CONFLICT';
      throw error;
    }
    const recovery = await this.bridge.execute({
      command: 'create_safety_backup',
      documentId,
      expectedRevision,
      expectedStateToken: verifiedStateToken,
      args: { reason, toolName: 'restore_safety_backup', backupDirectory: this.backupRoot },
    });
    const recoveryBackupId = recovery.result?.backupId;
    if (!recoveryBackupId) throw new Error('La sauvegarde de l’état courant a échoué avant restauration.');
    await verifyArtifact({ targetPath: recovery.result?.backupPath, kind: 'indd' });
    const afterRecoveryBackup = await this.#inspectDocumentState(documentId);
    if (afterRecoveryBackup.revision !== expectedRevision || afterRecoveryBackup.stateToken !== verifiedStateToken) {
      const error = new Error('Le document a changé pendant la sauvegarde de récupération.');
      error.code = 'STATE_CONFLICT';
      throw error;
    }
    const recoveryProvenance = await this.silentBridge.registerExternalBackup({
      backupId: recoveryBackupId,
      backupPath: recovery.result.backupPath,
      documentId,
      revision: expectedRevision,
      stateToken: verifiedStateToken,
    });
    const restoredDirectory = path.join(this.backupRoot, 'restored');
    await fs.mkdir(restoredDirectory, { recursive: true });
    await applyWindowsPrivateAcl(restoredDirectory, { kind: 'directory', recursive: true });
    const restoredWorkingPath = path.join(restoredDirectory, `restore-${crypto.randomUUID()}.indd`);
    await fs.copyFile(sourceBackupPath, restoredWorkingPath, fs.constants.COPYFILE_EXCL);
    await applyWindowsPrivateAcl(restoredWorkingPath, { kind: 'file' });
    await verifyArtifact({ targetPath: restoredWorkingPath, kind: 'indd' });
    const readyForRestore = await this.#inspectDocumentState(documentId);
    if (readyForRestore.revision !== expectedRevision || readyForRestore.stateToken !== verifiedStateToken) {
      const error = new Error('Le document a changé juste avant sa restauration.');
      error.code = 'STATE_CONFLICT';
      throw error;
    }
    const response = await this.bridge.execute({
      command: 'restore_safety_backup',
      documentId,
      expectedRevision,
      expectedStateToken: verifiedStateToken,
      args: { backupId: targetBackupId, recoveryBackupId, reason, workingCopyPath: restoredWorkingPath },
    });
    return {
      ...asObject(response.result),
      restoredFromBackupId: targetBackupId,
      restoredWorkingPath,
      recoveryBackupId,
      recoveryBackupPath: recovery.result?.backupPath,
      recoveryBackupMetadataPath: recoveryProvenance.metadataPath,
      recoveryBackupArtifactSha256: recoveryProvenance.artifact.sha256,
    };
  }

  #error(message, details) {
    if (!details) return { isError: true, content: [{ type: 'text', text: message }] };
    const structuredContent = { error: message, ...details };
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
  }
}

import { z } from 'zod';
import { allToolDefinitions } from '../types/index.js';
import { TOOL_DEFINITIONS } from './definitions.js';

const LOCAL_TOOLS = new Set(['bridge_status', 'help', 'get_session_info', 'clear_session']);
const DIRECT_COMMANDS = new Set(TOOL_DEFINITIONS.filter((definition) => definition.route === 'direct').map((definition) => definition.command));
const LEGACY_APPLICATION_SCOPE_TOOLS = new Set([
  'add_document_to_book',
  'create_book',
  'export_book',
  'get_book_info',
  'list_books',
  'open_book',
  'open_cloud_document',
  'package_book',
  'preflight_book',
  'print_book',
  'repaginate_book',
  'set_book_properties',
  'synchronize_book',
  'update_all_cross_references',
  'update_all_numbers',
  'update_chapter_and_paragraph_numbers',
]);
// Profil « core » : le noyau sécurisé (canal silencieux, code UXP sauvegardé, workflows d'aperçu et de préflight,
// enregistrement et exports vérifiés). Les commandes unitaires historiques restent disponibles dans le profil « full ».
export const TOOL_PROFILES = Object.freeze(['core', 'full']);
export const CORE_TOOLS = Object.freeze(new Set([
  'analyze_layout', 'compare_layout_snapshot', 'create_working_copy', 'finalize_layout', 'preview_layout',
  'bridge_arm_pairing_clipboard', 'bridge_open_pairing_window', 'bridge_operation_status', 'bridge_status',
  'indesign_doctor', 'search_official_dom',
  'execute_uxp', 'execute_uxp_silent', 'run_layout_script',
  'get_document_info', 'get_fonts', 'get_images', 'get_links', 'get_overset_text', 'list_pages', 'open_document',
  'preflight_document', 'silent_audit_document', 'silent_close_document', 'silent_inspect_document',
  'silent_list_documents', 'silent_operation_status', 'silent_reconcile_unknown_operation', 'silent_restore_backup',
  'silent_status',
  'close_document', 'create_document', 'export_idml', 'export_pdf', 'export_png', 'list_documents',
  'package_document', 'ping', 'restore_safety_backup', 'save_as', 'save_document',
]));

const READ_PREFIX = /^(get|list|view|help|ping|preflight|validate|snapshot)_/;
const DESTRUCTIVE = /^(delete|remove|cleanup|close|print|move|resize|set_|edit|find_replace|organize|ungroup|apply|populate|reframe|clear|update|synchronize|repaginate)/;

function annotationsFor(name) {
  const readOnly = READ_PREFIX.test(name) || ['get_document_info', 'view_document', 'help'].includes(name);
  return {
    title: name.replaceAll('_', ' '),
    readOnlyHint: readOnly,
    destructiveHint: !readOnly && DESTRUCTIVE.test(name),
    idempotentHint: readOnly,
    openWorldHint: false,
  };
}

function addGovernance(schema, { reasonRequired, scopeMode = 'either', requireStateToken = false }) {
  const output = structuredClone(schema ?? { type: 'object', properties: {} });
  output.type = 'object';
  output.properties ??= {};
  output.required ??= [];
  output.additionalProperties = false;

  const requireField = (field) => {
    if (!output.required.includes(field)) output.required.push(field);
  };
  const addDocumentState = () => {
    output.properties.documentId ??= { type: 'integer', minimum: 1, description: 'Identifiant numérique InDesign du document.' };
    output.properties.expectedRevision ??= { type: 'integer', minimum: 0, description: 'Révision observée avant l’appel.' };
    if (requireStateToken) {
      output.properties.expectedStateToken ??= {
        type: 'string',
        pattern: '^[a-f0-9]{16}$',
        description: 'Jeton renvoyé par silent_inspect_document juste avant l’appel.',
      };
    }
  };

  if (scopeMode === 'application') {
    output.properties.scope = { type: 'string', const: 'application', description: 'Portée application requise pour cette opération.' };
  } else if (scopeMode === 'document') {
    output.properties.scope = { type: 'string', const: 'document', description: 'Portée document requise pour cette opération.' };
    addDocumentState();
    requireField('documentId');
    requireField('expectedRevision');
    if (requireStateToken) requireField('expectedStateToken');
  } else {
    output.properties.scope = { type: 'string', enum: ['document', 'application'], description: 'Portée de l’exécution UXP sous-jacente.' };
    addDocumentState();
    output.allOf ??= [];
    const stateFields = ['documentId', 'expectedRevision'];
    if (requireStateToken) stateFields.push('expectedStateToken');
    output.allOf.push({ if: { properties: { scope: { const: 'document' } }, required: ['scope'] }, then: { required: stateFields } });
  }
  if (!output.required.includes('scope')) output.required.push('scope');
  if (reasonRequired) {
    output.properties.reason ??= { type: 'string', minLength: 5, maxLength: 500, description: 'Motif opérationnel de l’action; son contenu n’est pas journalisé.' };
    requireField('reason');
  }
  return output;
}

function modernTool(definition) {
  const inputSchema = z.toJSONSchema(definition.schema);
  delete inputSchema.$schema;
  if (definition.jsonSchemaAllOf.length > 0) {
    inputSchema.allOf ??= [];
    inputSchema.allOf.push(...structuredClone(definition.jsonSchemaAllOf));
  }
  if (definition.annotations.destructiveHint) {
    inputSchema.properties.reason = { type: 'string', minLength: 5, maxLength: 500 };
    inputSchema.required ??= [];
    if (!inputSchema.required.includes('reason')) inputSchema.required.push('reason');
  }
  return {
    name: definition.name,
    title: definition.annotations.title,
    description: definition.description,
    inputSchema,
    annotations: definition.annotations,
    _meta: { route: definition.route ?? (definition.local ? 'local' : 'direct'), mutatesDocument: definition.mutatesDocument, pathRules: definition.pathRules },
  };
}

function legacyTool(definition) {
  const annotations = annotationsFor(definition.name);
  if (definition.name === 'clear_session') {
    annotations.readOnlyHint = false;
    annotations.destructiveHint = false;
    annotations.idempotentHint = true;
  }
  if (definition.name === 'execute_indesign_code') {
    annotations.openWorldHint = true;
  }
  const local = LOCAL_TOOLS.has(definition.name);
  const direct = DIRECT_COMMANDS.has(definition.name);
  const requiresExecuteUxp = !local && !direct;
  const route = local ? 'legacy-local' : direct ? 'direct' : 'legacy-uxp';
  let inputSchema = structuredClone(definition.inputSchema ?? { type: 'object', properties: {} });
  inputSchema.additionalProperties = false;
  if (requiresExecuteUxp) {
    annotations.readOnlyHint = false;
    annotations.destructiveHint = true;
    annotations.idempotentHint = false;
    const scopeMode = definition.name === 'execute_indesign_code'
      ? 'either'
      : LEGACY_APPLICATION_SCOPE_TOOLS.has(definition.name) ? 'application' : 'document';
    inputSchema = addGovernance(inputSchema, { reasonRequired: true, scopeMode, requireStateToken: true });
  } else if (!local && annotations.destructiveHint) {
    inputSchema = addGovernance(inputSchema, { reasonRequired: true });
  }
  return {
    ...structuredClone(definition),
    inputSchema,
    annotations,
    _meta: { route, mutatesDocument: requiresExecuteUxp ? true : local ? false : !annotations.readOnlyHint },
  };
}

export function buildToolCatalog({ profile = 'full' } = {}) {
  if (!TOOL_PROFILES.includes(profile)) throw new Error(`Profil d’outils inconnu: ${profile}`);
  const tools = new Map(allToolDefinitions.map((definition) => [definition.name, legacyTool(definition)]));
  for (const definition of TOOL_DEFINITIONS) tools.set(definition.name, modernTool(definition));
  tools.set('indesign_doctor', {
    name: 'indesign_doctor',
    title: 'Diagnostiquer les capacités disponibles',
    description: 'Vérifie localement le runtime, le stockage privé, les deux canaux et l’intégrité du registre sans démarrer ni contacter InDesign. Peut inclure le détail compact de chaque outil.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        includeTools: { type: 'boolean', default: false, description: 'Inclut le nom, la route, les indicateurs de sécurité et l’empreinte de schéma de chaque outil.' },
      },
    },
    annotations: { title: 'Doctor InDesign', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { route: 'local', mutatesDocument: false },
  });
  tools.set('search_official_dom', {
    name: 'search_official_dom',
    title: 'Rechercher dans le DOM officiel Adobe',
    description: 'Recherche hors ligne une classe ou une énumération dans l’index DOM officiel Adobe épinglé et renvoie les liens de référence exacts.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 128 },
        limit: { type: 'integer', minimum: 1, maximum: 25, default: 10 },
      },
      required: ['query'],
    },
    annotations: { title: 'Référence DOM officielle', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { route: 'local', mutatesDocument: false },
  });
  tools.set('execute_uxp', {
    name: 'execute_uxp',
    title: 'Exécuter du JavaScript UXP complet',
    description: 'Exécute du JavaScript UXP dans InDesign après sauvegarde de sécurité de tous les documents ouverts. Ce code libre peut accéder au DOM, aux fichiers et au réseau.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        scope: { type: 'string', enum: ['document', 'application'] },
        documentId: { type: 'integer', minimum: 1 },
        expectedRevision: { type: 'integer', minimum: 0 },
        expectedStateToken: { type: 'string', pattern: '^[a-f0-9]{16}$' },
        reason: { type: 'string', minLength: 5, maxLength: 500 },
        code: { type: 'string', minLength: 1, maxLength: 2_000_000 },
        input: {},
      },
      required: ['scope', 'reason', 'code'],
      allOf: [{ if: { properties: { scope: { const: 'document' } }, required: ['scope'] }, then: { required: ['documentId', 'expectedRevision', 'expectedStateToken'] } }],
    },
    annotations: { title: 'Exécuter UXP', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    _meta: { route: 'execute-uxp', mutatesDocument: true },
  });
  tools.set('silent_status', {
    name: 'silent_status',
    title: 'Tester InDesign sans panneau',
    description: 'Interroge directement InDesign 19 à 21 par COM et UXP, sans panneau, clic, WebSocket ni Computer Use.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'État silencieux', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { route: 'silent', mutatesDocument: false },
  });
  tools.set('silent_list_documents', {
    name: 'silent_list_documents',
    title: 'Lister les documents sans panneau',
    description: 'Liste les documents ouverts et leurs révisions par le canal local silencieux.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Documents silencieux', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { route: 'silent', mutatesDocument: false },
  });
  tools.set('silent_inspect_document', {
    name: 'silent_inspect_document',
    title: 'Inspecter un document sans panneau',
    description: 'Lit les propriétés essentielles, la révision et le stateToken du contenu réel. Réutilisez revision et stateToken pour toute écriture silencieuse.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { documentId: { type: 'integer', minimum: 1 } }, required: ['documentId'] },
    annotations: { title: 'Inspection silencieuse', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { route: 'silent', mutatesDocument: false },
  });
  tools.set('silent_audit_document', {
    name: 'silent_audit_document',
    title: 'Auditer entièrement un document sans panneau',
    description: 'Lit en un seul appel structuré les pages, objets, liens, polices, images, débordements et styles. La réponse signale explicitement toute troncature liée au nombre d’objets ou à la limite de résultat.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        documentId: { type: 'integer', minimum: 1 },
        maxItems: { type: 'integer', minimum: 1, maximum: 50_000, default: 20_000 },
      },
      required: ['documentId'],
    },
    annotations: { title: 'Audit silencieux complet', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { route: 'silent', mutatesDocument: false },
  });
  tools.set('silent_close_document', {
    name: 'silent_close_document',
    title: 'Fermer sans enregistrer et sans panneau',
    description: 'Ferme uniquement le document identifié avec save=false, après contrôle exact de revision et stateToken. N’enregistre pas et ne crée aucune copie du document.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        documentId: { type: 'integer', minimum: 1 },
        expectedRevision: { type: 'integer', minimum: 0 },
        expectedStateToken: { type: 'string', pattern: '^[a-f0-9]{16}$' },
        save: { const: false },
        reason: { type: 'string', minLength: 5, maxLength: 500 },
      },
      required: ['documentId', 'expectedRevision', 'expectedStateToken', 'save', 'reason'],
    },
    annotations: { title: 'Fermer sans enregistrer', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    _meta: { route: 'silent', mutatesDocument: true },
  });
  tools.set('silent_operation_status', {
    name: 'silent_operation_status',
    title: 'Réconcilier une opération silencieuse',
    description: 'Relit le résultat privé d’une opération dont le délai a expiré. Un résultat absent ou en attente impose toujours de réinspecter le document.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { operationId: { type: 'string', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' } }, required: ['operationId'] },
    annotations: { title: 'État d’une opération silencieuse', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { route: 'silent', mutatesDocument: false },
  });
  tools.set('silent_reconcile_unknown_operation', {
    name: 'silent_reconcile_unknown_operation',
    title: 'Sécuriser puis acquitter une issue inconnue',
    description: 'Après un arrêt ou une déconnexion, vérifie qu’InDesign est stable et non modal, sauvegarde tous les documents, conserve une preuve privée puis libère le verrou orphelin. Ne déduit jamais un faux succès.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        operationId: { type: 'string', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' },
        reason: { type: 'string', minLength: 8, maxLength: 500 },
      },
      required: ['operationId', 'reason'],
    },
    annotations: { title: 'Acquitter une issue inconnue', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    _meta: { route: 'silent', mutatesDocument: false },
  });
  tools.set('bridge_operation_status', {
    name: 'bridge_operation_status',
    title: 'Réconcilier une opération du plugin',
    description: 'Relit l’issue tardive d’une commande envoyée au plugin après un dépassement de délai. Une issue absente impose de réinspecter le document et interdit une nouvelle mutation.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { operationId: { type: 'string', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' } }, required: ['operationId'] },
    annotations: { title: 'État d’une opération du plugin', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { route: 'plugin-status', mutatesDocument: false },
  });
  tools.set('silent_restore_backup', {
    name: 'silent_restore_backup',
    title: 'Restaurer une copie silencieuse',
    description: 'Restaure une copie INDD vérifiée créée par le canal silencieux ou le plugin. Sauvegarde d’abord tous les documents ouverts, puis remplace sans enregistrer le document ciblé. Exige revision et stateToken relus juste avant.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        documentId: { type: 'integer', minimum: 1 },
        expectedRevision: { type: 'integer', minimum: 0 },
        expectedStateToken: { type: 'string', pattern: '^[a-f0-9]{16}$' },
        backupId: { type: 'string', pattern: '^(?:[a-f0-9]{36}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$' },
        reason: { type: 'string', minLength: 5, maxLength: 500 },
      },
      required: ['documentId', 'expectedRevision', 'expectedStateToken', 'backupId', 'reason'],
    },
    annotations: { title: 'Restaurer une copie silencieuse', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    _meta: { route: 'silent', mutatesDocument: true },
  });
  tools.set('run_layout_script', {
    name: 'run_layout_script',
    title: 'Script de mise en page rapide',
    description: 'Voie normale pour modifier un document : en un seul passage InDesign, contrôle revision et stateToken, sauvegarde tous les documents ouverts (restaurables par silent_restore_backup), exécute le code UXP (app, indesign, doc, input ; return pour renvoyer une valeur), enregistre si save=true, exporte un aperçu PNG relu, puis ferme si close=true (avec save=true). Renvoie la nouvelle revision et le nouveau stateToken : enchaînez les appels sans réinspecter. Un échec du script renvoie scriptOk=false, l’erreur, l’aperçu et backupId, sans bloquer la suite. Ce code libre peut accéder aux fichiers et au réseau.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        documentId: { type: 'integer', minimum: 1 },
        expectedRevision: { type: 'integer', minimum: 0 },
        expectedStateToken: { type: 'string', pattern: '^[a-f0-9]{16}$', description: 'Jeton renvoyé par open_document, silent_inspect_document ou l’appel précédent.' },
        reason: { type: 'string', minLength: 5, maxLength: 500 },
        code: { type: 'string', minLength: 1, maxLength: 2_000_000 },
        input: {},
        save: { type: 'boolean', default: false, description: 'Enregistre le document après un script réussi.' },
        close: { type: 'boolean', default: false, description: 'Ferme le document après enregistrement et aperçu ; exige save=true.' },
        previewPages: { type: 'string', minLength: 1, maxLength: 128, description: 'Pages à rendre (noms InDesign, ex. "1" ou "2-3") ; première page par défaut.' },
        previewResolution: { type: 'integer', minimum: 36, maximum: 300, default: 96 },
      },
      required: ['documentId', 'expectedRevision', 'expectedStateToken', 'reason', 'code'],
      allOf: [{ if: { properties: { close: { const: true } }, required: ['close'] }, then: { properties: { save: { const: true } }, required: ['save'] } }],
    },
    annotations: { title: 'Script rapide', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    _meta: { route: 'silent', mutatesDocument: true },
  });
  tools.set('execute_uxp_silent', {
    name: 'execute_uxp_silent',
    title: 'Exécuter UXP silencieusement',
    description: 'Exécute du JavaScript UXP synchrone ou asynchrone sans panneau. Contrôle revision et stateToken et sauvegarde tous les documents ouverts. UXP ne garantit pas une annulation atomique; utilisez silent_restore_backup. Ce code libre peut accéder aux fichiers et au réseau.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        documentId: { type: 'integer', minimum: 1 },
        expectedRevision: { type: 'integer', minimum: 0 },
        expectedStateToken: { type: 'string', pattern: '^[a-f0-9]{16}$', description: 'Jeton renvoyé par silent_inspect_document juste avant la modification.' },
        reason: { type: 'string', minLength: 5, maxLength: 500 },
        code: { type: 'string', minLength: 1, maxLength: 2_000_000 },
        input: {},
      },
      required: ['documentId', 'expectedRevision', 'expectedStateToken', 'reason', 'code'],
    },
    annotations: { title: 'UXP silencieux', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    _meta: { route: 'silent', mutatesDocument: true },
  });
  const selected = profile === 'core' ? [...tools.values()].filter((tool) => CORE_TOOLS.has(tool.name)) : [...tools.values()];
  return selected.sort((left, right) => left.name.localeCompare(right.name));
}

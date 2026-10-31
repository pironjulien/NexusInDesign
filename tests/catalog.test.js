import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { allToolDefinitions } from '../src/types/index.js';
import { buildToolCatalog } from '../src/tools/catalog.js';
import { LEGACY_MISSING_NAMES } from '../src/handlers/legacyMissingHandlers.js';
import { SERVER_INSTRUCTIONS } from '../src/server/Application.js';

const STATE_TOKEN = 'a'.repeat(16);

const LEGACY_APPLICATION_SCOPE_NAMES = [
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
];

test('le catalogue conserve tous les outils amont et expose execute_uxp', () => {
  const catalog = buildToolCatalog();
  const names = new Set(catalog.map((tool) => tool.name));
  assert.equal(names.size, catalog.length);
  for (const legacy of allToolDefinitions) assert.ok(names.has(legacy.name), `outil amont perdu: ${legacy.name}`);
  assert.ok(names.has('execute_uxp'));
  assert.ok(names.has('bridge_operation_status'));
  assert.ok(catalog.length >= 135);
  assert.ok(!names.has('execute_js_without_backup'));
  assert.equal(LEGACY_MISSING_NAMES.size, 17);
  assert.ok(catalog.every((tool) => tool.inputSchema.additionalProperties === false));
});

test('toutes les surfaces de code libre sont déclarées ouvertes', () => {
  const catalog = buildToolCatalog();
  for (const name of ['execute_uxp', 'execute_uxp_silent', 'execute_indesign_code']) {
    const tool = catalog.find((entry) => entry.name === name);
    assert.ok(tool, name);
    assert.equal(tool.annotations.openWorldHint, true, name);
    assert.equal(tool.annotations.destructiveHint, true, name);
  }
});

test('tout le catalogue legacy UXP est déclaré comme une mutation destructive', () => {
  const legacyTools = buildToolCatalog().filter((tool) => tool._meta.route === 'legacy-uxp');
  assert.equal(legacyTools.length, 112);
  for (const tool of legacyTools) {
    assert.equal(tool.annotations.readOnlyHint, false, `${tool.name}: lecture annoncée à tort`);
    assert.equal(tool.annotations.destructiveHint, true, `${tool.name}: destruction non annoncée`);
    assert.equal(tool.annotations.idempotentHint, false, `${tool.name}: idempotence annoncée à tort`);
    assert.equal(tool._meta.mutatesDocument, true, `${tool.name}: mutation non déclarée`);
    assert.ok(tool.inputSchema.required.includes('reason'), `${tool.name}: motif absent`);
  }
});

test('les 95 outils legacy documentaires imposent la cible, la révision et le stateToken', () => {
  const legacyTools = buildToolCatalog().filter((tool) => tool._meta.route === 'legacy-uxp');
  const documentTools = legacyTools.filter((tool) => tool.inputSchema.properties.scope?.const === 'document');
  assert.equal(documentTools.length, 95);
  for (const tool of documentTools) {
    assert.equal(tool.inputSchema.properties.scope.const, 'document', tool.name);
    for (const field of ['scope', 'documentId', 'expectedRevision', 'expectedStateToken', 'reason']) {
      assert.ok(tool.inputSchema.required.includes(field), `${tool.name}: ${field} absent`);
    }
    assert.equal(tool.inputSchema.properties.documentId.minimum, 1, tool.name);
    assert.equal(tool.inputSchema.properties.expectedRevision.minimum, 0, tool.name);
    assert.equal(tool.inputSchema.properties.expectedStateToken.pattern, '^[a-f0-9]{16}$', tool.name);
  }
});

test('les handlers legacy documentaires ciblent directement targetDocument avant la garde centrale', async () => {
  const documentTools = buildToolCatalog().filter(
    (tool) => tool._meta.route === 'legacy-uxp'
      && tool.inputSchema.properties.scope?.const === 'document',
  );
  assert.equal(documentTools.length, 95);

  const handlerDirectory = new URL('../src/handlers/', import.meta.url);
  const entries = await fs.readdir(handlerDirectory, { withFileTypes: true });
  const allowedApplicationAccesses = new Map([
    ['documentHandlers.js', [
      'app.activeDocument = doc;',
      ': Number(app.activeDocument.id);',
    ]],
  ]);
  let explicitTargetReferences = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    let source = await fs.readFile(new URL(entry.name, handlerDirectory), 'utf8');
    explicitTargetReferences += source.match(/\btargetDocument\b/g)?.length ?? 0;

    for (const allowed of allowedApplicationAccesses.get(entry.name) ?? []) {
      assert.equal(source.split(allowed).length - 1, 1, `${entry.name}: exception application absente ou dupliquée`);
      source = source.replace(allowed, '');
    }
    assert.doesNotMatch(source, /\bapp\.activeDocument\b/, `${entry.name}: dépendance résiduelle au document au premier plan`);
  }

  assert.ok(explicitTargetReferences >= documentTools.length, 'les handlers documentaires ne référencent pas tous une cible explicite');
});

test('les outils legacy de livre, cloud et application refusent la portée document', () => {
  const legacyTools = buildToolCatalog().filter((tool) => tool._meta.route === 'legacy-uxp');
  const applicationTools = legacyTools.filter((tool) => tool.inputSchema.properties.scope?.const === 'application');
  assert.deepEqual(applicationTools.map((tool) => tool.name).sort(), [...LEGACY_APPLICATION_SCOPE_NAMES].sort());
  for (const tool of applicationTools) {
    assert.deepEqual(tool.inputSchema.properties.scope, {
      type: 'string',
      const: 'application',
      description: 'Portée application requise pour cette opération.',
    }, tool.name);
    assert.ok(tool.inputSchema.required.includes('scope'), tool.name);
    assert.ok(tool.inputSchema.required.includes('reason'), tool.name);
    assert.equal(tool.inputSchema.properties.documentId, undefined, tool.name);
    assert.equal(tool.inputSchema.properties.expectedRevision, undefined, tool.name);
    assert.equal(tool.inputSchema.properties.expectedStateToken, undefined, tool.name);
  }
});

test('execute_indesign_code conserve ses deux portées mais sécurise la portée document', () => {
  const tool = buildToolCatalog().find((entry) => entry.name === 'execute_indesign_code');
  assert.equal(tool._meta.route, 'legacy-uxp');
  assert.deepEqual(tool.inputSchema.properties.scope.enum, ['document', 'application']);
  const conditional = tool.inputSchema.allOf.find((entry) => entry.if?.properties?.scope?.const === 'document');
  assert.deepEqual(conditional.then.required, ['documentId', 'expectedRevision', 'expectedStateToken']);
  assert.equal(tool.inputSchema.properties.expectedStateToken.pattern, '^[a-f0-9]{16}$');
});

test('clear_session reste une écriture purement locale sans gouvernance InDesign', () => {
  const tool = buildToolCatalog().find((entry) => entry.name === 'clear_session');
  assert.equal(tool._meta.route, 'legacy-local');
  assert.equal(tool._meta.mutatesDocument, false);
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.equal(tool.annotations.idempotentHint, true);
  assert.equal(tool.inputSchema.properties?.scope, undefined);
  assert.equal(tool.inputSchema.properties?.reason, undefined);
  assert.equal(tool.inputSchema.properties?.documentId, undefined);
  assert.equal(tool.inputSchema.properties?.expectedRevision, undefined);
  assert.equal(tool.inputSchema.properties?.expectedStateToken, undefined);
});

test('les instructions du serveur routent les écritures vers run_layout_script et la fin vers le préflight', () => {
  const opening = SERVER_INSTRUCTIONS.slice(0, 900);
  for (const expected of ['Codex', 'Claude Code', 'run_layout_script', 'open_document', 'documentId', 'revision', 'stateToken', 'sauvegarde', 'aperçu PNG', 'scripts versionnés']) {
    assert.ok(opening.includes(expected), expected);
  }
  for (const expected of ['preflight_document', 'chemins', 'silent_reconcile_unknown_operation', 'profil full']) {
    assert.ok(SERVER_INSTRUCTIONS.includes(expected), expected);
  }
  assert.doesNotMatch(SERVER_INSTRUCTIONS, /Les outils structurés sont préférables/);
});

test('les identifiants structurés correspondent au contrat numérique du plugin', () => {
  const catalog = buildToolCatalog();
  const schema = catalog.find((tool) => tool.name === 'delete_page_item').inputSchema;
  const ajv = new Ajv2020({ strict: false });
  const validate = ajv.compile(schema);
  assert.equal(validate({ documentId: 71, expectedRevision: 4, expectedStateToken: STATE_TOKEN, itemId: 990, reason: 'Correction du bloc' }), true);
  assert.equal(validate({ documentId: '71', expectedRevision: 4, expectedStateToken: STATE_TOKEN, itemId: '990', reason: 'Correction du bloc' }), false);
});

test('les contrats stories et hyperliens reflètent exactement le DOM Adobe', () => {
  const catalog = buildToolCatalog();
  const ajv = new Ajv2020({ strict: false });

  const storiesSchema = catalog.find((tool) => tool.name === 'get_document_stories').inputSchema;
  const validateStories = ajv.compile(storiesSchema);
  const storyContext = {
    scope: 'document', documentId: 71, expectedRevision: 4, expectedStateToken: 'a'.repeat(16), reason: 'Inspecter les textes',
  };
  assert.equal(storiesSchema.properties.includeHidden, undefined);
  assert.equal(validateStories({ ...storyContext, includeOverset: false }), true);
  assert.equal(validateStories({ ...storyContext, includeHidden: true }), false);

  const hyperlinkSchema = catalog.find((tool) => tool.name === 'create_document_hyperlink').inputSchema;
  const validateHyperlink = ajv.compile(hyperlinkSchema);
  const hyperlinkContext = {
    scope: 'document', documentId: 71, expectedRevision: 4, expectedStateToken: 'a'.repeat(16), reason: 'Créer un hyperlien', sourceText: 'Voir la suite',
  };
  assert.equal(validateHyperlink({ ...hyperlinkContext, linkType: 'PAGE', pageIndex: 2 }), true);
  assert.equal(validateHyperlink({ ...hyperlinkContext, linkType: 'PAGE', destination: 'ignorée' }), false);
  assert.equal(validateHyperlink({ ...hyperlinkContext, linkType: 'URL', destination: 'https://example.com' }), true);
  assert.equal(validateHyperlink({ ...hyperlinkContext, linkType: 'URL' }), false);
  assert.equal(validateHyperlink({ ...hyperlinkContext, destination: 'https://example.com' }), true);
});

test('chaque mutation de document structurée exige un motif et une sauvegarde', () => {
  const catalog = buildToolCatalog();
  const protectedMutators = [
    'save_document', 'save_as', 'close_document', 'restore_safety_backup',
    'add_pages', 'create_layer', 'create_color_swatch', 'create_paragraph_style',
    'create_character_style', 'create_object_style', 'create_text_frame',
    'edit_text_frame', 'create_rectangle', 'place_file', 'set_page_item_bounds',
    'delete_page_item', 'create_master_spread', 'apply_master_spread',
  ];
  for (const name of protectedMutators) {
    const tool = catalog.find((entry) => entry.name === name);
    assert.ok(tool, name);
    assert.equal(tool._meta.mutatesDocument, true, name);
    assert.equal(tool.annotations.destructiveHint, true, name);
    assert.ok(tool.inputSchema.required?.includes('reason'), `${name}: motif absent`);
    assert.ok(tool.inputSchema.required?.includes('expectedStateToken'), `${name}: stateToken absent`);
  }
});

test('les exports et assemblages sont exclusifs même sans mutation de contenu', () => {
  const catalog = buildToolCatalog();
  for (const name of ['export_pdf', 'export_idml', 'export_png', 'package_document']) {
    const tool = catalog.find((entry) => entry.name === name);
    assert.ok(tool, name);
    assert.equal(tool._meta.mutatesDocument, true, name);
  }
  for (const name of ['create_document', 'open_document']) {
    const tool = catalog.find((entry) => entry.name === name);
    assert.equal(tool._meta.mutatesDocument, true, name);
    assert.equal(tool.annotations.destructiveHint, false, name);
  }
  assert.equal(catalog.find((entry) => entry.name === 'open_document')._meta.route, 'silent');
});

test('les workflows haut niveau restent structurés, bornés et sans transport ouvert', () => {
  const catalog = buildToolCatalog();
  for (const name of ['analyze_layout', 'compare_layout_snapshot', 'create_working_copy', 'preview_layout', 'finalize_layout']) {
    const tool = catalog.find((entry) => entry.name === name);
    assert.ok(tool, name);
    assert.equal(tool._meta.route, 'workflow', name);
    assert.equal(tool.annotations.openWorldHint, false, name);
  }
  for (const name of ['create_working_copy', 'preview_layout', 'finalize_layout']) {
    const tool = catalog.find((entry) => entry.name === name);
    assert.equal(tool._meta.mutatesDocument, true, name);
    assert.equal(tool.annotations.destructiveHint, true, name);
    assert.ok(tool.inputSchema.required.includes('reason'), name);
  }
});

test('execute_uxp impose la gouvernance document et autorise la portée application', () => {
  const tool = buildToolCatalog().find((item) => item.name === 'execute_uxp');
  const validate = new Ajv2020({ strict: false }).compile(tool.inputSchema);
  assert.equal(validate({ scope: 'document', documentId: 9, expectedRevision: 2, expectedStateToken: 'a'.repeat(16), reason: 'Mise en page', code: 'return 1;' }), true);
  assert.equal(validate({ scope: 'document', documentId: 9, expectedRevision: 2, reason: 'Mise en page', code: 'return 1;' }), false);
  assert.equal(validate({ scope: 'document', reason: 'Mise en page', code: 'return 1;' }), false);
  assert.equal(validate({ scope: 'application', reason: 'Créer un document', code: 'return 1;' }), true);
  assert.equal(validate({ scope: 'application', reason: 'Créer un document', code: 'return 1;', extra: true }), false);
});

test('l’appairage à chaud reste local, borné et explicitement motivé', () => {
  const tool = buildToolCatalog().find((item) => item.name === 'bridge_open_pairing_window');
  assert.ok(tool);
  assert.equal(tool._meta.route, 'local');
  assert.equal(tool._meta.mutatesDocument, false);
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.openWorldHint, false);
  const validate = new Ajv2020({ strict: false }).compile(tool.inputSchema);
  assert.equal(validate({ windowSeconds: 120, reason: 'Renouveler l’appairage UXP' }), true);
  assert.equal(validate({ windowSeconds: 10, reason: 'Renouveler l’appairage UXP' }), false);
  assert.equal(validate({ windowSeconds: 120 }), false);
  assert.equal(validate({ windowSeconds: 120, reason: 'court' }), false);
  assert.equal(validate({ windowSeconds: 120, reason: 'ok assez', extra: true }), false);
});

test('l’armement automatique du presse-papiers reste local et explicitement motivé', () => {
  const tool = buildToolCatalog().find((item) => item.name === 'bridge_arm_pairing_clipboard');
  assert.ok(tool);
  assert.equal(tool._meta.route, 'local');
  assert.equal(tool._meta.mutatesDocument, false);
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.openWorldHint, false);
  const validate = new Ajv2020({ strict: false }).compile(tool.inputSchema);
  assert.equal(validate({ reason: 'Lire une seule fois le code déjà copié localement' }), true);
  assert.equal(validate({}), false);
  assert.equal(validate({ reason: 'court' }), false);
  assert.equal(validate({ reason: 'Lire le code local', extra: true }), false);
});

test('le canal silencieux est additif, borné au document et gouverné', () => {
  const catalog = buildToolCatalog();
  const names = new Set(catalog.map((tool) => tool.name));
  for (const name of ['silent_status', 'silent_list_documents', 'silent_inspect_document', 'silent_audit_document', 'silent_close_document', 'silent_operation_status', 'silent_reconcile_unknown_operation', 'silent_restore_backup', 'execute_uxp_silent']) assert.ok(names.has(name));
  const tool = catalog.find((item) => item.name === 'execute_uxp_silent');
  const validate = new Ajv2020({ strict: false }).compile(tool.inputSchema);
  const valid = { documentId: 9, expectedRevision: 2, expectedStateToken: 'a'.repeat(16), reason: 'Ajuster la maquette', code: 'return { changed: true };' };
  assert.equal(validate(valid), true);
  assert.equal(validate({ ...valid, documentId: undefined }), false);
  assert.equal(validate({ ...valid, expectedRevision: undefined }), false);
  assert.equal(validate({ ...valid, expectedStateToken: undefined }), false);
  assert.equal(validate({ ...valid, expectedStateToken: 'jeton-invente' }), false);
  assert.equal(validate({ ...valid, reason: 'non' }), false);
  assert.equal(validate({ ...valid, scope: 'application' }), false);
  assert.equal(tool.annotations.destructiveHint, true);
  assert.equal(tool.annotations.openWorldHint, true);
});

test('les lectures métier et le contrôle Adobe ne dépendent plus du plugin', () => {
  const catalog = buildToolCatalog();
  for (const name of ['get_document_info', 'list_pages', 'get_links', 'get_fonts', 'get_overset_text', 'get_images', 'preflight_document']) {
    const tool = catalog.find((entry) => entry.name === name);
    assert.ok(tool, name);
    assert.equal(tool._meta.route, 'silent', name);
    assert.equal(tool.annotations.readOnlyHint, true, name);
  }
});

test('la fermeture silencieuse impose save=false et l’état relu sans créer de sauvegarde implicite', () => {
  const tool = buildToolCatalog().find((entry) => entry.name === 'silent_close_document');
  const validate = new Ajv2020({ strict: false }).compile(tool.inputSchema);
  const valid = { documentId: 9, expectedRevision: 2, expectedStateToken: 'a'.repeat(16), save: false, reason: 'Fermer le document de preuve' };
  assert.equal(validate(valid), true);
  assert.equal(validate({ ...valid, save: true }), false);
  assert.equal(validate({ ...valid, expectedStateToken: undefined }), false);
  assert.equal(tool.annotations.destructiveHint, true);
  assert.equal(tool._meta.route, 'silent');
});

test('la restauration exige un état courant, une cible et un motif', () => {
  const tool = buildToolCatalog().find((item) => item.name === 'restore_safety_backup');
  const validate = new Ajv2020({ strict: false }).compile(tool.inputSchema);
  const valid = { documentId: 9, expectedRevision: 4, expectedStateToken: STATE_TOKEN, backupId: 'a'.repeat(36), reason: 'Revenir à la copie sûre' };
  assert.equal(validate(valid), true);
  assert.equal(validate({ ...valid, backupId: 'trop-court' }), false);
  assert.equal(validate({ ...valid, reason: undefined }), false);
});

test('les sorties structurées refusent l’écrasement par défaut', () => {
  const catalog = buildToolCatalog();
  const ajv = new Ajv2020({ strict: false, useDefaults: true });
  const samples = {
    save_as: { documentId: 1, expectedRevision: 0, expectedStateToken: STATE_TOKEN, path: 'C:\\Dev\\livret.indd', reason: 'Enregistrer la maquette' },
    export_pdf: { documentId: 1, expectedRevision: 0, expectedStateToken: STATE_TOKEN, filePath: 'C:\\Dev\\livret.pdf', reason: 'Exporter le livret' },
    export_idml: { documentId: 1, expectedRevision: 0, expectedStateToken: STATE_TOKEN, filePath: 'C:\\Dev\\livret.idml', reason: 'Exporter la source' },
    export_png: { documentId: 1, expectedRevision: 0, expectedStateToken: STATE_TOKEN, filePath: 'C:\\Dev\\page.png', pageId: 2, reason: 'Exporter la page' },
    package_document: { documentId: 1, expectedRevision: 0, expectedStateToken: STATE_TOKEN, folderPath: 'C:\\Dev\\package', reason: 'Assembler le livret' },
  };
  for (const [name, args] of Object.entries(samples)) {
    const validate = ajv.compile(catalog.find((tool) => tool.name === name).inputSchema);
    assert.equal(validate(args), true, name);
    assert.equal(args.overwrite, false, name);
  }
});

test('export_png impose un fichier pour une page ou un dossier pour plusieurs pages', () => {
  const schema = buildToolCatalog().find((tool) => tool.name === 'export_png').inputSchema;
  const validate = new Ajv2020({ strict: false, useDefaults: true }).compile(schema);
  const base = { documentId: 1, expectedRevision: 0, expectedStateToken: STATE_TOKEN, reason: 'Exporter les aperçus' };
  assert.equal(validate({ ...base, pageId: 2, filePath: 'C:\\Dev\\page.png' }), true);
  assert.equal(validate({ ...base, folderPath: 'C:\\Dev\\pages', pageRange: '1-4,7' }), true);
  assert.equal(validate({ ...base, filePath: 'C:\\Dev\\pages.png' }), false);
  assert.equal(validate({ ...base, pageId: 2, folderPath: 'C:\\Dev\\pages' }), false);
  assert.equal(validate({ ...base, pageId: 2, filePath: 'C:\\Dev\\page.png', folderPath: 'C:\\Dev\\pages' }), false);
  assert.equal(validate({ ...base, pageId: 2, filePath: 'C:\\Dev\\page.png', pageRange: '1-2' }), false);
});

test('export_images hérité utilise réellement outputPath et pages', () => {
  const schema = buildToolCatalog().find((tool) => tool.name === 'export_images').inputSchema;
  const validate = new Ajv2020({ strict: false, useDefaults: true }).compile(schema);
  const base = { scope: 'document', documentId: 1, expectedRevision: 0, expectedStateToken: 'a'.repeat(16), reason: 'Exporter les images' };
  assert.equal(validate({ ...base, outputPath: 'C:\\Dev\\images', pages: '1-3', format: 'PNG' }), true);
  assert.equal(validate({ ...base, folderPath: 'C:\\Dev\\images', pageRange: '1-3' }), false);
  assert.equal(validate({ ...base, outputPath: 'C:\\Dev\\images', format: 'TIFF' }), false);
});

test('le profil core expose le noyau sécurisé sans commande unitaire historique', async () => {
  const { CORE_TOOLS } = await import('../src/tools/catalog.js');
  const full = buildToolCatalog();
  const core = buildToolCatalog({ profile: 'core' });
  assert.deepEqual(core.map((tool) => tool.name).sort(), [...CORE_TOOLS].sort());
  assert.ok(core.length < full.length);
  assert.equal(core.filter((tool) => ['legacy-uxp', 'legacy-local'].includes(tool._meta.route)).length, 0);
  for (const name of ['execute_uxp_silent', 'silent_inspect_document', 'preview_layout', 'preflight_document', 'finalize_layout', 'silent_restore_backup']) {
    assert.ok(CORE_TOOLS.has(name), name);
  }
  assert.throws(() => buildToolCatalog({ profile: 'autre' }));
});

test('le skill indesign-studio ne cite que des outils existants et distingue ceux du profil full', async () => {
  const { CORE_TOOLS } = await import('../src/tools/catalog.js');
  const names = new Set(buildToolCatalog().map((tool) => tool.name));
  const dir = new URL('../codex-plugin/skills/indesign-studio/', import.meta.url);
  const files = [new URL('SKILL.md', dir), ...(await fs.readdir(new URL('references/', dir))).map((file) => new URL(`references/${file}`, dir))];
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8');
    for (const [, cited] of text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) {
      if (!names.has(cited)) continue;
      if (!CORE_TOOLS.has(cited)) assert.match(text, new RegExp(`${cited}[^\n]*profil \`full\`|profil \`full\`[^\n]*${cited}`), `${cited} hors core sans mention du profil full`);
    }
  }
});

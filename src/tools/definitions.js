import { z } from 'zod';
import { bounds, cmyk, documentRead, documentWrite, finite, id, lab, name, positive, rgb, strict } from './schemas.js';

const read = (title) => ({ title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const write = (title, { destructive = false, idempotent = false } = {}) => ({ title, readOnlyHint: false, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: false });
const file = (field, access, extensions, kind = 'file', mustNotExist = false) => ({ field, access, extensions, kind, mustNotExist });

const paragraphProperties = {
  basedOn: name.optional(), fontFamily: name.optional(), fontStyle: name.optional(), pointSize: positive.max(1000).optional(),
  leading: positive.max(2000).optional(), fillColorName: name.optional(), justification: z.enum(['left', 'center', 'right', 'justify']).optional(),
  spaceBefore: finite.min(0).optional(), spaceAfter: finite.min(0).optional(), hyphenation: z.boolean().optional(),
};
const characterProperties = {
  basedOn: name.optional(), fontFamily: name.optional(), fontStyle: name.optional(), pointSize: positive.max(1000).optional(),
  fillColorName: name.optional(), tracking: z.number().int().min(-10000).max(10000).optional(), capitalization: z.enum(['normal', 'allCaps', 'smallCaps']).optional(),
};
const objectProperties = {
  basedOn: name.optional(), fillColorName: name.optional(), strokeColorName: name.optional(), strokeWeight: finite.min(0).max(1000).optional(),
  textWrap: z.enum(['none', 'boundingBox', 'contour']).optional(), insetSpacing: z.tuple([finite.min(0), finite.min(0), finite.min(0), finite.min(0)]).optional(),
};

const layoutPageSize = z.strictObject({
  widthMm: positive.max(10_000),
  heightMm: positive.max(10_000),
  toleranceMm: finite.min(0).max(100).default(0.5),
  allowRotation: z.boolean().default(true),
});
const layoutContract = z.strictObject({
  requireCompleteSnapshot: z.boolean().default(true),
  allowOversetText: z.boolean().default(false),
  allowMissingLinks: z.boolean().default(false),
  allowOutdatedLinks: z.boolean().default(false),
  allowMissingFonts: z.boolean().default(false),
  minEffectivePpi: positive.max(10_000).optional(),
  minMarginMm: finite.min(0).max(1000).optional(),
  allowedPageSizes: z.array(layoutPageSize).max(50).optional(),
  requireFacingPages: z.boolean().optional(),
  maxPages: z.number().int().min(1).max(100_000).optional(),
  maxColors: z.number().int().min(1).max(100_000).optional(),
  requiredLayers: z.array(name).max(500).optional(),
  requiredParagraphStyles: z.array(name).max(2000).optional(),
  requiredCharacterStyles: z.array(name).max(2000).optional(),
  requiredObjectStyles: z.array(name).max(2000).optional(),
  allowedFonts: z.array(name).max(2000).optional(),
  minimumStylePointSizePt: positive.max(1000).optional(),
  maxOutsidePageMm: finite.min(0).max(1000).optional(),
});
const layoutInspection = {
  maxItems: z.number().int().min(1).max(50_000).default(20_000),
  contract: layoutContract.default({}),
};

function tool(nameValue, description, schema, annotations, options = {}) {
  return Object.freeze({
    name: nameValue,
    command: nameValue,
    description,
    schema,
    annotations,
    pathRules: options.pathRules ?? [],
    jsonSchemaAllOf: options.jsonSchemaAllOf ?? [],
    local: options.local ?? false,
    route: options.route ?? (options.local ? 'local' : 'direct'),
    mutatesDocument: options.mutatesDocument ?? false,
  });
}

export const TOOL_DEFINITIONS = Object.freeze([
  tool('bridge_status', 'Vérifie l’état local de la passerelle et de la connexion UXP sans contacter InDesign.', strict(), read('État de la passerelle'), { local: true }),
  tool(
    'bridge_open_pairing_window',
    'Génère un code temporaire à usage unique sur l’instance qui possède le listener UXP. Saisir ce code dans le panneau; le secret persistant n’est transmis qu’après validation de cette preuve hors WebSocket.',
    strict({
      windowSeconds: z.number().int().min(30).max(300).default(120),
      reason: z.string().min(8).max(500),
    }),
    write('Ouvrir l’appairage'),
    { local: true },
  ),
  tool(
    'bridge_arm_pairing_clipboard',
    'Arme une lecture unique du presse-papiers par le plugin pendant la fenêtre d’appairage déjà ouverte. Le code doit avoir été placé dans le presse-papiers avant cet appel.',
    strict({
      reason: z.string().min(8).max(500),
    }),
    write('Armer le presse-papiers'),
    { local: true },
  ),
  tool('ping', 'Vérifie que le plugin UXP authentifié répond.', strict(), read('Tester le plugin')),
  tool('list_documents', 'Liste les documents InDesign ouverts avec leur identifiant stable et leur révision.', strict(), read('Lister les documents')),
  tool('get_document_info', 'Lit silencieusement les propriétés du document et sa révision courante.', documentRead(), read('Inspecter le document'), { route: 'silent' }),
  tool('create_document', 'Crée un document InDesign avec dimensions, marges et fond perdu explicites ; renvoie documentId, revision et stateToken. Sans panneau jumelé, ou avec path (enregistrement immédiat en INDD, sans écrasement), passe par le canal silencieux.', strict({
    expectedRevision: z.literal(0), documentId: id.optional(), width: positive.max(10_000), height: positive.max(10_000), pageCount: z.number().int().min(1).max(10_000).default(1),
    facingPages: z.boolean().default(true), units: z.enum(['mm', 'pt']).default('mm'),
    margins: z.tuple([finite.min(0), finite.min(0), finite.min(0), finite.min(0)]).default([12, 12, 12, 12]),
    bleed: z.tuple([finite.min(0), finite.min(0), finite.min(0), finite.min(0)]).default([3, 3, 3, 3]),
    path: z.string().optional(),
  }), write('Créer un document'), { pathRules: [file('path', 'write', ['.indd'], 'file', true)], mutatesDocument: true }),
  tool('open_document', 'Ouvre silencieusement un fichier INDD ou IDML autorisé, sans dépendre du panneau UXP.', strict({ expectedRevision: z.literal(0), path: z.string() }), write('Ouvrir un document'), { route: 'silent', pathRules: [file('path', 'read', ['.indd', '.idml'])], mutatesDocument: true }),
  tool('save_document', 'Enregistre le document ouvert si sa révision correspond.', documentWrite(), write('Enregistrer le document', { destructive: true, idempotent: true }), { mutatesDocument: true }),
  tool('save_as', 'Enregistre une copie INDD dans une racine d’écriture autorisée.', documentWrite({ path: z.string(), overwrite: z.boolean().default(false) }), write('Enregistrer sous', { destructive: true, idempotent: true }), { pathRules: [file('path', 'write', ['.indd'])], mutatesDocument: true }),
  tool('close_document', 'Ferme le document; l’enregistrement doit être choisi explicitement.', documentWrite({ save: z.boolean() }), write('Fermer le document', { destructive: true, idempotent: true }), { mutatesDocument: true }),
  tool('restore_safety_backup', 'Ferme l’état courant après l’avoir sauvegardé, puis ouvre une copie de sécurité récente.', documentWrite({ backupId: z.string().regex(/^[a-f0-9]{36}$/) }), write('Restaurer une sauvegarde', { destructive: true }), { mutatesDocument: true }),
  tool('list_pages', 'Liste silencieusement les pages et leurs identifiants.', documentRead(), read('Lister les pages'), { route: 'silent' }),
  tool('add_pages', 'Ajoute un nombre borné de pages après une page optionnelle.', documentWrite({ count: z.number().int().min(1).max(500), afterPageId: id.optional() }), write('Ajouter des pages', { destructive: true }), { mutatesDocument: true }),
  tool('get_page_content_summary', 'Résume les blocs, images et textes d’une page.', documentRead({ pageId: id }), read('Résumer une page')),
  tool('list_page_items', 'Liste les objets d’une page avec identifiants, types et limites.', documentRead({ pageId: id }), read('Lister les objets')),
  tool('get_links', 'Liste silencieusement les liens, statuts, chemins et résolutions effectives.', documentRead(), read('Contrôler les liens'), { route: 'silent' }),
  tool('get_fonts', 'Liste silencieusement les polices utilisées et signale celles manquantes.', documentRead(), read('Contrôler les polices'), { route: 'silent' }),
  tool('get_overset_text', 'Détecte silencieusement les blocs de texte en débordement.', documentRead(), read('Détecter les débordements'), { route: 'silent' }),
  tool('get_images', 'Liste silencieusement les images avec lien, format et résolution effective.', documentRead(), read('Inspecter les images'), { route: 'silent' }),
  tool('create_layer', 'Crée un calque nommé avec propriétés explicites.', documentWrite({ name, visible: z.boolean().default(true), locked: z.boolean().default(false), printable: z.boolean().default(true) }), write('Créer un calque', { destructive: true }), { mutatesDocument: true }),
  tool('create_color_swatch', 'Crée ou met à jour une nuance RGB, CMJN ou Lab.', documentWrite({ name, colorSpace: z.enum(['RGB', 'CMYK', 'LAB']), values: z.union([rgb, cmyk, lab]) }), write('Créer une nuance', { destructive: true, idempotent: true }), { mutatesDocument: true }),
  tool('create_paragraph_style', 'Crée ou met à jour un style de paragraphe à propriétés autorisées.', documentWrite({ name, ...paragraphProperties }), write('Créer un style de paragraphe', { destructive: true, idempotent: true }), { mutatesDocument: true }),
  tool('create_character_style', 'Crée ou met à jour un style de caractère à propriétés autorisées.', documentWrite({ name, ...characterProperties }), write('Créer un style de caractère', { destructive: true, idempotent: true }), { mutatesDocument: true }),
  tool('create_object_style', 'Crée ou met à jour un style d’objet à propriétés autorisées.', documentWrite({ name, ...objectProperties }), write('Créer un style d’objet', { destructive: true, idempotent: true }), { mutatesDocument: true }),
  tool('create_text_frame', 'Crée un bloc texte borné sur une page.', documentWrite({ pageId: id, bounds, text: z.string().max(1_000_000).default(''), layerName: name.optional(), paragraphStyleName: name.optional(), objectStyleName: name.optional() }), write('Créer un bloc texte', { destructive: true }), { mutatesDocument: true }),
  tool('edit_text_frame', 'Modifie le contenu et les styles d’un bloc texte identifié.', documentWrite({ itemId: id, text: z.string().max(1_000_000).optional(), append: z.boolean().default(false), paragraphStyleName: name.optional(), characterStyleName: name.optional(), objectStyleName: name.optional() }).refine((value) => value.text !== undefined || value.paragraphStyleName || value.characterStyleName || value.objectStyleName, 'Au moins une modification est requise.'), write('Modifier un bloc texte', { destructive: true }), { mutatesDocument: true }),
  tool('create_rectangle', 'Crée un rectangle avec style ou couleurs explicites.', documentWrite({ pageId: id, bounds, layerName: name.optional(), objectStyleName: name.optional(), fillColorName: name.optional(), strokeColorName: name.optional(), strokeWeight: finite.min(0).max(1000).optional() }), write('Créer un rectangle', { destructive: true }), { mutatesDocument: true }),
  tool('place_file', 'Place un fichier autorisé dans un bloc graphique, sans code exécutable.', documentWrite({ pageId: id, path: z.string(), bounds, layerName: name.optional(), objectStyleName: name.optional(), fit: z.enum(['none', 'proportional', 'fill', 'frameToContent']).default('proportional'), pageNumber: z.number().int().min(1).optional() }), write('Placer un fichier', { destructive: true }), { pathRules: [file('path', 'read', ['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.psd', '.ai', '.pdf', '.svg', '.eps', '.indd', '.idml', '.txt', '.rtf', '.doc', '.docx', '.xlsx', '.csv'])], mutatesDocument: true }),
  tool('set_page_item_bounds', 'Change uniquement les limites d’un objet identifié.', documentWrite({ itemId: id, bounds }), write('Redimensionner un objet', { destructive: true, idempotent: true }), { mutatesDocument: true }),
  tool('delete_page_item', 'Supprime un objet identifié.', documentWrite({ itemId: id }), write('Supprimer un objet', { destructive: true, idempotent: true }), { mutatesDocument: true }),
  tool('create_master_spread', 'Crée un gabarit avec préfixe et nombre de pages bornés.', documentWrite({ name, prefix: z.string().min(1).max(8), pageCount: z.number().int().min(1).max(10) }), write('Créer un gabarit', { destructive: true }), { mutatesDocument: true }),
  tool('apply_master_spread', 'Applique un gabarit identifié à une liste de pages.', documentWrite({ masterSpreadId: id, pageIds: z.array(id).min(1).max(500) }), write('Appliquer un gabarit', { destructive: true, idempotent: true }), { mutatesDocument: true }),
  tool('preflight_document', 'Exécute silencieusement le contrôle prépresse et retourne les erreurs structurées sans modifier le document.', documentRead({ profileName: name.optional(), timeoutSeconds: z.number().int().min(1).max(600).default(60) }), read('Contrôler le document'), { route: 'silent', mutatesDocument: true }),
  tool('export_pdf', 'Exporte un PDF vers un fichier autorisé à la révision demandée.', documentWrite({ filePath: z.string(), presetName: name.optional(), overwrite: z.boolean().default(false) }), write('Exporter le PDF', { destructive: true, idempotent: true }), { pathRules: [file('filePath', 'write', ['.pdf'])], mutatesDocument: true }),
  tool('export_idml', 'Exporte une copie IDML vers un fichier autorisé.', documentWrite({ filePath: z.string(), overwrite: z.boolean().default(false) }), write('Exporter l’IDML', { destructive: true, idempotent: true }), { pathRules: [file('filePath', 'write', ['.idml'])], mutatesDocument: true }),
  tool('export_png', 'Exporte une page vers filePath, ou plusieurs pages vers folderPath, sans ambiguïté de cible.', documentWrite({ filePath: z.string().optional(), folderPath: z.string().optional(), pageId: id.optional(), pageRange: z.string().min(1).max(128).optional(), resolution: z.number().int().min(36).max(2400).default(300), transparentBackground: z.boolean().default(false), overwrite: z.boolean().default(false) }), write('Exporter le PNG', { destructive: true, idempotent: true }), {
    pathRules: [file('filePath', 'write', ['.png']), file('folderPath', 'write', undefined, 'directory')],
    jsonSchemaAllOf: [{
      oneOf: [
        { required: ['pageId', 'filePath'], not: { anyOf: [{ required: ['folderPath'] }, { required: ['pageRange'] }] } },
        { required: ['folderPath'], not: { anyOf: [{ required: ['pageId'] }, { required: ['filePath'] }] } },
      ],
    }],
    mutatesDocument: true,
  }),
  tool('package_document', 'Crée un assemblage InDesign dans un dossier autorisé.', documentWrite({ folderPath: z.string(), includeFonts: z.boolean().default(true), includeLinks: z.boolean().default(true), includeProfiles: z.boolean().default(true), includeHiddenLayers: z.boolean().default(false), ignorePreflightErrors: z.boolean().default(false), includeIdml: z.boolean().default(true), includePdf: z.boolean().default(true), pdfPresetName: name.optional(), overwrite: z.boolean().default(false) }), write('Assembler le document', { destructive: true, idempotent: true }), { pathRules: [file('folderPath', 'write', undefined, 'directory')], mutatesDocument: true }),
  tool('analyze_layout', 'Analyse sans modification la géométrie, les ressources, les styles et les écarts à un contrat de mise en page; renvoie une empreinte stable réutilisable.', documentRead(layoutInspection), read('Analyser la mise en page'), { route: 'workflow' }),
  tool('compare_layout_snapshot', 'Recalcule l’empreinte de mise en page et la compare à une empreinte de référence pour contrôler un aller-retour.', documentRead({ baselineFingerprint: z.string().regex(/^[a-f0-9]{64}$/), ...layoutInspection }), read('Comparer une empreinte de mise en page'), { route: 'workflow' }),
  tool('create_working_copy', 'Crée et ouvre une copie INDD de travail depuis une sauvegarde vérifiée, puis prouve que le document source est resté inchangé.', documentWrite({ path: z.string(), overwrite: z.boolean().default(false) }), write('Créer une copie de travail', { destructive: true }), { route: 'workflow', pathRules: [file('path', 'write', ['.indd'])], mutatesDocument: true }),
  tool('preview_layout', 'Produit un aperçu PNG multipage vérifié et joint le diagnostic de mise en page correspondant.', documentWrite({ folderPath: z.string(), pageRange: z.string().min(1).max(128).default('all'), resolution: z.number().int().min(36).max(600).default(144), transparentBackground: z.boolean().default(false), overwrite: z.boolean().default(false), ...layoutInspection }), write('Prévisualiser la mise en page', { destructive: true, idempotent: true }), { route: 'workflow', pathRules: [file('folderPath', 'write', undefined, 'directory')], mutatesDocument: true }),
  tool('finalize_layout', 'Exécute le diagnostic contractuel et le contrôle Adobe, puis exporte un PDF vérifié uniquement si aucun écart bloquant n’est détecté.', documentWrite({ filePath: z.string(), presetName: name.optional(), profileName: name.optional(), timeoutSeconds: z.number().int().min(1).max(600).default(60), overwrite: z.boolean().default(false), ...layoutInspection }), write('Finaliser la mise en page', { destructive: true, idempotent: true }), { route: 'workflow', pathRules: [file('filePath', 'write', ['.pdf'])], mutatesDocument: true }),
]);

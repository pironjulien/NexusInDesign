import crypto from 'node:crypto';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function fingerprintProjection(snapshot) {
  const copy = structuredClone(snapshot ?? {});
  delete copy.success;
  delete copy.capturedAt;
  delete copy.documentId;
  delete copy.revision;
  if (copy.document) {
    delete copy.document.id;
    delete copy.document.name;
    delete copy.document.path;
    delete copy.document.modified;
  }
  for (const collection of ['pages', 'items', 'links', 'images', 'fonts']) {
    if (Array.isArray(copy[collection])) {
      copy[collection].sort((left, right) => JSON.stringify(canonicalize(left)).localeCompare(JSON.stringify(canonicalize(right))));
    }
  }
  if (copy.designSystem) {
    for (const collection of Object.values(copy.designSystem)) {
      if (Array.isArray(collection)) collection.sort((left, right) => JSON.stringify(canonicalize(left)).localeCompare(JSON.stringify(canonicalize(right))));
    }
  }
  return copy;
}

export function layoutFingerprint(snapshot) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(fingerprintProjection(snapshot))), 'utf8').digest('hex');
}

function issue(code, severity, message, details = {}) {
  return { code, severity, message, ...details };
}

function nameSet(collection) {
  return new Set((collection ?? []).map((entry) => String(entry?.name ?? '').toLocaleLowerCase()).filter(Boolean));
}

function hasStatus(entry, pattern) {
  return pattern.test(String(entry?.statusName ?? entry?.status ?? ''));
}

function minimumPpi(image) {
  const values = Array.isArray(image?.effectivePpi) ? image.effectivePpi.filter(Number.isFinite) : [];
  return values.length > 0 ? Math.min(...values) : undefined;
}

function pageSizeMatches(page, candidate) {
  const tolerance = candidate.toleranceMm ?? 0.5;
  const direct = Math.abs(page.widthMm - candidate.widthMm) <= tolerance && Math.abs(page.heightMm - candidate.heightMm) <= tolerance;
  const rotated = candidate.allowRotation !== false
    && Math.abs(page.widthMm - candidate.heightMm) <= tolerance
    && Math.abs(page.heightMm - candidate.widthMm) <= tolerance;
  return direct || rotated;
}

export function lintLayoutSnapshot(snapshot, contract = {}) {
  const issues = [];
  const pages = snapshot?.pages ?? [];
  const items = snapshot?.items ?? [];
  const links = snapshot?.links ?? [];
  const images = snapshot?.images ?? [];
  const fonts = snapshot?.fonts ?? [];
  const designSystem = snapshot?.designSystem ?? {};

  if (snapshot?.truncated && contract.requireCompleteSnapshot !== false) {
    issues.push(issue('SNAPSHOT_TRUNCATED', 'error', 'Le diagnostic a atteint la limite d’objets; une validation exhaustive est impossible.', {
      totalItems: snapshot.totalItems,
      inspectedItems: items.length,
    }));
  }

  if (contract.allowOversetText !== true) {
    for (const item of items.filter((entry) => entry.overflows === true)) {
      issues.push(issue('OVERSET_TEXT', 'error', 'Un bloc de texte déborde.', { pageId: item.pageId, itemId: item.id }));
    }
  }

  if (contract.allowMissingLinks !== true) {
    for (const link of links.filter((entry) => hasStatus(entry, /missing|not\s*found|unavailable/i))) {
      issues.push(issue('MISSING_LINK', 'error', 'Un lien placé est manquant.', { linkId: link.id, name: link.name }));
    }
  }
  for (const link of links.filter((entry) => hasStatus(entry, /out.?of.?date|modified/i))) {
    issues.push(issue('OUTDATED_LINK', contract.allowOutdatedLinks === true ? 'warning' : 'error', 'Un lien placé n’est pas à jour.', { linkId: link.id, name: link.name }));
  }

  if (contract.allowMissingFonts !== true) {
    for (const font of fonts.filter((entry) => hasStatus(entry, /missing|not.?available|substitut/i))) {
      issues.push(issue('MISSING_FONT', 'error', 'Une police utilisée est indisponible ou substituée.', { name: font.name }));
    }
  }

  if (Number.isFinite(contract.minEffectivePpi)) {
    for (const image of images) {
      const ppi = minimumPpi(image);
      if (ppi !== undefined && ppi < contract.minEffectivePpi) {
        issues.push(issue('LOW_EFFECTIVE_PPI', 'error', 'La résolution effective d’une image est inférieure au contrat.', {
          imageId: image.id,
          pageId: image.pageId,
          effectivePpi: ppi,
          requiredPpi: contract.minEffectivePpi,
        }));
      }
    }
  }

  if (Number.isFinite(contract.minMarginMm)) {
    for (const page of pages) {
      const margins = Object.values(page.margins ?? {}).filter(Number.isFinite);
      if (margins.some((value) => value < contract.minMarginMm)) {
        issues.push(issue('MARGIN_BELOW_CONTRACT', 'error', 'Une marge de page est inférieure au contrat.', { pageId: page.id, margins: page.margins, requiredMm: contract.minMarginMm }));
      }
    }
  }

  if (Array.isArray(contract.allowedPageSizes) && contract.allowedPageSizes.length > 0) {
    for (const page of pages) {
      if (!contract.allowedPageSizes.some((candidate) => pageSizeMatches(page, candidate))) {
        issues.push(issue('PAGE_SIZE_NOT_ALLOWED', 'error', 'Le format d’une page ne correspond à aucun format autorisé.', { pageId: page.id, widthMm: page.widthMm, heightMm: page.heightMm }));
      }
    }
  }

  if (contract.requireFacingPages !== undefined && Boolean(snapshot?.document?.facingPages) !== contract.requireFacingPages) {
    issues.push(issue('FACING_PAGES_MISMATCH', 'error', 'Le réglage des pages en vis-à-vis ne respecte pas le contrat.', { actual: Boolean(snapshot?.document?.facingPages), expected: contract.requireFacingPages }));
  }
  if (Number.isInteger(contract.maxPages) && pages.length > contract.maxPages) {
    issues.push(issue('TOO_MANY_PAGES', 'error', 'Le document dépasse le nombre de pages autorisé.', { actual: pages.length, maximum: contract.maxPages }));
  }
  if (Number.isInteger(contract.maxColors) && (designSystem.swatches?.length ?? 0) > contract.maxColors) {
    issues.push(issue('TOO_MANY_SWATCHES', 'warning', 'Le document dépasse le nombre de nuances prévu par le contrat.', { actual: designSystem.swatches.length, maximum: contract.maxColors }));
  }

  const requiredCollections = [
    ['requiredLayers', 'layers', 'REQUIRED_LAYER_MISSING', 'Un calque requis est absent.'],
    ['requiredParagraphStyles', 'paragraphStyles', 'REQUIRED_PARAGRAPH_STYLE_MISSING', 'Un style de paragraphe requis est absent.'],
    ['requiredCharacterStyles', 'characterStyles', 'REQUIRED_CHARACTER_STYLE_MISSING', 'Un style de caractère requis est absent.'],
    ['requiredObjectStyles', 'objectStyles', 'REQUIRED_OBJECT_STYLE_MISSING', 'Un style d’objet requis est absent.'],
  ];
  for (const [contractField, snapshotField, code, message] of requiredCollections) {
    const existing = nameSet(designSystem[snapshotField]);
    for (const required of contract[contractField] ?? []) {
      if (!existing.has(required.toLocaleLowerCase())) issues.push(issue(code, 'error', message, { name: required }));
    }
  }

  if (Array.isArray(contract.allowedFonts) && contract.allowedFonts.length > 0) {
    const allowed = new Set(contract.allowedFonts.map((entry) => entry.toLocaleLowerCase()));
    for (const font of fonts) {
      const identifiers = [font.name, font.family].filter(Boolean).map((entry) => String(entry).toLocaleLowerCase());
      if (!identifiers.some((identifier) => allowed.has(identifier))) {
        issues.push(issue('FONT_NOT_ALLOWED', 'error', 'Une police utilisée ne figure pas dans le contrat.', { name: font.name, family: font.family }));
      }
    }
  }

  if (Number.isFinite(contract.minimumStylePointSizePt)) {
    for (const style of [...(designSystem.paragraphStyles ?? []), ...(designSystem.characterStyles ?? [])]) {
      if (Number.isFinite(style.pointSize) && style.pointSize > 0 && style.pointSize < contract.minimumStylePointSizePt) {
        issues.push(issue('STYLE_TEXT_TOO_SMALL', 'warning', 'Un style typographique utilise un corps inférieur au contrat.', { name: style.name, pointSize: style.pointSize, minimumPt: contract.minimumStylePointSizePt }));
      }
    }
  }

  for (const item of items) {
    const validBounds = Array.isArray(item.bounds) && item.bounds.length === 4 && item.bounds.every(Number.isFinite);
    const height = validBounds ? item.bounds[2] - item.bounds[0] : Number.NaN;
    const width = validBounds ? item.bounds[3] - item.bounds[1] : Number.NaN;
    const isGraphicLine = String(item.type ?? '').toLocaleLowerCase() === 'graphicline';
    const invalidGeometry = !validBounds || height < 0 || width < 0
      || (isGraphicLine ? (height === 0 && width === 0) : (height <= 0 || width <= 0));
    if (invalidGeometry) {
      issues.push(issue('INVALID_ITEM_GEOMETRY', 'error', 'Un objet possède une géométrie invalide.', { pageId: item.pageId, itemId: item.id, bounds: item.bounds }));
      continue;
    }
    if (Number.isFinite(contract.maxOutsidePageMm) && item.pageId !== null) {
      const page = pages.find((entry) => entry.id === item.pageId);
      if (page?.bounds?.length === 4) {
        const limit = contract.maxOutsidePageMm;
        const outside = item.bounds[0] < page.bounds[0] - limit || item.bounds[1] < page.bounds[1] - limit
          || item.bounds[2] > page.bounds[2] + limit || item.bounds[3] > page.bounds[3] + limit;
        if (outside) issues.push(issue('ITEM_OUTSIDE_PAGE_LIMIT', 'warning', 'Un objet dépasse la page au-delà de la tolérance du contrat.', { pageId: item.pageId, itemId: item.id, bounds: item.bounds, toleranceMm: limit }));
      }
    }
  }

  const counts = issues.reduce((accumulator, current) => {
    accumulator[current.severity] = (accumulator[current.severity] ?? 0) + 1;
    return accumulator;
  }, { error: 0, warning: 0 });
  return {
    passed: counts.error === 0,
    counts,
    issues,
    contractApplied: structuredClone(contract),
  };
}

export function analyzeLayoutSnapshot(snapshot, contract = {}) {
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.document || !Array.isArray(snapshot.pages) || !Array.isArray(snapshot.items)) {
    const error = new Error('Le diagnostic InDesign ne respecte pas le contrat de workflow.');
    error.code = 'LAYOUT_SNAPSHOT_INVALID';
    throw error;
  }
  const fingerprint = layoutFingerprint(snapshot);
  const lint = lintLayoutSnapshot(snapshot, contract);
  return {
    fingerprint,
    snapshot,
    lint,
    statistics: {
      pages: snapshot.pages.length,
      items: snapshot.items.length,
      totalItems: snapshot.totalItems ?? snapshot.items.length,
      links: snapshot.links?.length ?? 0,
      images: snapshot.images?.length ?? 0,
      fonts: snapshot.fonts?.length ?? 0,
      layers: snapshot.designSystem?.layers?.length ?? 0,
      paragraphStyles: snapshot.designSystem?.paragraphStyles?.length ?? 0,
      characterStyles: snapshot.designSystem?.characterStyles?.length ?? 0,
      objectStyles: snapshot.designSystem?.objectStyles?.length ?? 0,
      swatches: snapshot.designSystem?.swatches?.length ?? 0,
    },
  };
}

const MAX_COMPARISON_ANOMALIES = 200;

export function summarizeLayoutAnomalies(lint) {
  const issues = Array.isArray(lint?.issues) ? lint.issues : [];
  const byCode = {};
  for (const entry of issues) {
    const code = typeof entry?.code === 'string' ? entry.code : 'UNKNOWN';
    byCode[code] = (byCode[code] ?? 0) + 1;
  }
  const items = issues.slice(0, MAX_COMPARISON_ANOMALIES);
  return {
    total: issues.length,
    returned: items.length,
    truncated: items.length < issues.length,
    counts: lint?.counts ?? { error: 0, warning: 0 },
    byCode: Object.fromEntries(Object.entries(byCode).sort(([left], [right]) => left.localeCompare(right))),
    items,
  };
}

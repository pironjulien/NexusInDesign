@@AUDIT_FUNCTIONS@@
  const wanted = @@documentId@@;
  const itemLimit = @@maxItems@@;
  let doc = null;
  for (let index = 0; index < app.documents.length; index += 1) {
    const candidate = app.documents.item(index);
    if (candidate && candidate.isValid !== false && Number(candidate.id) === wanted) { doc = candidate; break; }
  }
  if (!doc) { const error = new Error("Document introuvable"); error.code = "DOCUMENT_NOT_FOUND"; throw error; }
  if (app.modalState) { const error = new Error("InDesign affiche une boîte de dialogue modale"); error.code = "INDESIGN_MODAL"; throw error; }
  const rawRevision = doc.extractLabel("fr.pironjulien.indesign.mcp.revision");
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
    if (@@includePages@@) {
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
    const inspectedItems = @@includeItems@@ ? Math.min(totalItems, itemLimit) : 0;
    const items = [];
    if (@@includeItems@@) {
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
    const links = @@includeLinks@@ ? auditCollectionSummary(doc.links, (link) => {
      let pageItemId = null;
      let pageId = null;
      try { pageItemId = Number(link.parent.parent.id); } catch (_) {}
      try { pageId = Number(link.parent.parent.parentPage.id); } catch (_) {}
      const status = auditEnumSummary(link.status, indesign.LinkStatus);
      return { id: Number(link.id), name: String(link.name || ""), path: link.filePath || null, status: status.value, statusName: status.name, pageItemId, pageId };
    }) : [];
    const fonts = @@includeFonts@@ ? auditCollectionSummary(doc.fonts, (font) => {
      const status = auditEnumSummary(font.status, indesign.FontStatus);
      return { name: String(font.name || ""), family: font.fontFamily || null, style: font.fontStyleName || null, status: status.value, statusName: status.name };
    }) : [];
    const images = @@includeImages@@ ? auditCollectionSummary(doc.allGraphics, (graphic) => {
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
    if (@@includeOverset@@) {
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
    const designSystem = @@includeDesignSystem@@ ? {
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
    const typography = @@includeTypography@@ ? auditTypography(doc, itemLimit) : null;
    audit = {
      success: true, documentId: Number(doc.id), revision, capturedAt: new Date().toISOString(),
      document: {
        id: Number(doc.id), name: String(doc.name), path: await auditNativePath(doc), modified: Boolean(doc.modified),
        pageCount: doc.pages.length, spreadCount: doc.spreads.length, facingPages: Boolean(preferences.facingPages),
        widthMm: Number(preferences.pageWidth), heightMm: Number(preferences.pageHeight),
        bleedMm: { top: Number(preferences.documentBleedTopOffset), inside: Number(preferences.documentBleedInsideOrLeftOffset), bottom: Number(preferences.documentBleedBottomOffset), outside: Number(preferences.documentBleedOutsideOrRightOffset) }
      },
      counts: { pages: doc.pages.length, spreads: doc.spreads.length, layers: doc.layers.length, masterSpreads: doc.masterSpreads.length },
      pages, items, links, fonts, images, oversetText: { count: oversetFrames.length, frames: oversetFrames }, designSystem, typography,
      totalItems, inspectedItems: items.length, truncated: @@includeItems@@ && totalItems > items.length
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
  if (serialized.length > @@resultBudget@@ && audit.items.length > 0) {
    let low = 0;
    let high = audit.items.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      audit.items = audit.items.slice(0, middle);
      audit.inspectedItems = audit.items.length;
      audit.truncated = true;
      audit.truncationReason = "result-size";
      const candidate = JSON.stringify({ ok: true, audit });
      if (candidate.length <= @@resultBudget@@) low = middle;
      else high = middle - 1;
      audit.items = items.slice();
    }
    audit.items = items.slice(0, low);
    audit.inspectedItems = audit.items.length;
    audit.truncated = true;
    audit.truncationReason = "result-size";
    serialized = JSON.stringify({ ok: true, audit });
  }
  if (serialized.length > @@resultBudget@@) { const error = new Error("L’audit dépasse la limite de résultat même sans les objets de page"); error.code = "AUDIT_RESULT_TOO_LARGE"; throw error; }
  await __writeResult(JSON.parse(serialized));

  if (app.modalState) { const error = new Error("InDesign affiche une boîte de dialogue modale"); error.code = "INDESIGN_MODAL"; throw error; }
  const spec = @@spec@@;
  const savePath = @@savePath@@;
  const openProfileDeadline = Date.now() + @@profileBudgetMs@@;
@@PROFILE_HELPERS@@  const initialProfileDeadline = Math.min(openProfileDeadline, Date.now() + 10000);
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
    created.insertLabel("fr.pironjulien.indesign.mcp.revision", "0");
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
  await __writeResult(outcome);

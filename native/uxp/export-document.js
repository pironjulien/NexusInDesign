  if (app.modalState) { const error = new Error("InDesign affiche une boîte de dialogue modale"); error.code = "INDESIGN_MODAL"; throw error; }
  const wanted = @@documentId@@;
  const expectedRevision = @@expectedRevision@@;
  const expectedStateToken = @@expectedStateToken@@;
  const expectedDocuments = @@expectedDocuments@@;
  const assertExpectedDocuments = (code) => {
    if (app.documents.length !== expectedDocuments.length) { const error = new Error("L’inventaire des documents a changé"); error.code = code; error.requiresInspection = true; throw error; }
    let selected = null;
    for (let index = 0; index < app.documents.length; index += 1) {
      const candidate = app.documents.item(index);
      const expected = expectedDocuments.find((entry) => Number(entry.documentId) === Number(candidate.id));
      const actualRevision = Number.parseInt(candidate.extractLabel("fr.pironjulien.indesign.mcp.revision") || "0", 10) || 0;
      if (!expected || actualRevision !== Number(expected.revision) || documentStateToken(candidate) !== expected.stateToken) { const error = new Error("Un document a changé pendant l’export"); error.code = code; error.requiresInspection = true; throw error; }
      if (Number(candidate.id) === wanted) selected = candidate;
    }
    if (!selected) { const error = new Error("Document introuvable"); error.code = "DOCUMENT_NOT_FOUND"; throw error; }
    return selected;
  };
  const targetDocument = assertExpectedDocuments("DOCUMENT_STATE_CONFLICT");
  const actualRevision = Number.parseInt(targetDocument.extractLabel("fr.pironjulien.indesign.mcp.revision") || "0", 10) || 0;
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
@@exportAction@@
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
  await __writeResult({ ok: true, result: exportResult, documentId: wanted, revision: expectedRevision, stateToken: documentStateToken(verifiedTarget), operationId: __operationId });

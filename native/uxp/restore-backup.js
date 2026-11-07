  if (app.modalState) { const error = new Error(__t("InDesign shows a modal dialog", "InDesign affiche une boîte de dialogue modale")); error.code = "INDESIGN_MODAL"; throw error; }
  const wanted = @@documentId@@;
  const expectedRevision = @@expectedRevision@@;
  const expectedStateToken = @@expectedStateToken@@;
  const expectedDocuments = @@expectedDocuments@@;
  if (app.documents.length !== expectedDocuments.length) { const error = new Error(__t("The document inventory changed", "L’inventaire des documents a changé")); error.code = "DOCUMENT_INVENTORY_CONFLICT"; throw error; }
  let current = null;
  for (let index = 0; index < app.documents.length; index += 1) {
    const candidate = app.documents.item(index);
    const expected = expectedDocuments.find((entry) => Number(entry.documentId) === Number(candidate.id));
    const actual = Number.parseInt(candidate.extractLabel("fr.pironjulien.indesign.mcp.revision") || "0", 10) || 0;
    if (!expected || actual !== Number(expected.revision) || documentStateToken(candidate) !== expected.stateToken) { const error = new Error(__t("A document changed after the backups", "Un document a changé après les sauvegardes")); error.code = "DOCUMENT_STATE_CONFLICT"; throw error; }
    if (Number(candidate.id) === wanted) current = candidate;
  }
  if (!current) { const error = new Error(__t("Document not found", "Document introuvable")); error.code = "DOCUMENT_NOT_FOUND"; throw error; }
  const actualRevision = Number.parseInt(current.extractLabel("fr.pironjulien.indesign.mcp.revision") || "0", 10) || 0;
  if (actualRevision !== expectedRevision) { const error = new Error(__t("The document changed since the last read", "Le document a changé depuis la dernière lecture")); error.code = "REVISION_CONFLICT"; throw error; }
  if (documentStateToken(current) !== expectedStateToken) { const error = new Error(__t("The document changed since the last inspection", "Le document a changé depuis la dernière inspection")); error.code = "STATE_CONFLICT"; throw error; }
  const previousInteraction = app.scriptPreferences.userInteractionLevel;
  const previousRedraw = app.scriptPreferences.enableRedraw;
  let opened = null;
  let mutationStarted = false;
  let outcome;
  try {
    app.scriptPreferences.userInteractionLevel = indesign.UserInteractionLevels.NEVER_INTERACT !== undefined ? indesign.UserInteractionLevels.NEVER_INTERACT : indesign.UserInteractionLevels.neverInteract;
    app.scriptPreferences.enableRedraw = false;
    mutationStarted = true;
    opened = await app.open(@@restoredWorkingPath@@, true);
    if (Number(opened.id) === wanted) { const error = new Error(__t("The restored copy reused the current id", "La copie restaurée a réutilisé l’identifiant courant")); error.code = "RESTORE_COLLISION"; throw error; }
    await current.close(indesign.SaveOptions.no);
    const closeDeadline = Date.now() + 10000;
    let currentStillOpen = true;
    while (currentStillOpen && Date.now() < closeDeadline) {
      currentStillOpen = false;
      for (let index = 0; index < app.documents.length; index += 1) {
        if (Number(app.documents.item(index).id) === wanted) { currentStillOpen = true; break; }
      }
      if (currentStillOpen) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (currentStillOpen) { const error = new Error(__t("Closing the replaced document was not confirmed", "La fermeture du document remplacé n’a pas été confirmée")); error.code = "RESTORE_CLOSE_NOT_CONFIRMED"; throw error; }
    const restoredRevision = expectedRevision + 1;
    opened.insertLabel("fr.pironjulien.indesign.mcp.revision", String(restoredRevision));
    outcome = { ok: true, restoredDocumentId: Number(opened.id), originalDocumentId: wanted, revision: restoredRevision, stateToken: documentStateToken(opened), operationId: __operationId };
  } catch (error) {
    error.requiresInspection = mutationStarted;
    if (!mutationStarted && opened && opened.isValid !== false) { try { await opened.close(indesign.SaveOptions.no); } catch (_) {} }
    throw error;
  } finally {
    try { app.scriptPreferences.userInteractionLevel = previousInteraction; } catch (_) {}
    try { app.scriptPreferences.enableRedraw = previousRedraw; } catch (_) {}
  }

  await __writeResult(outcome);

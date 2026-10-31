  if (app.modalState) { const error = new Error("InDesign affiche une boîte de dialogue modale"); error.code = "INDESIGN_MODAL"; throw error; }
  const wanted = @@documentId@@;
  const expectedRevision = @@expectedRevision@@;
  const expectedStateToken = @@expectedStateToken@@;
  const expectedDocuments = @@expectedDocuments@@;
  const savePath = @@savePath@@;
  const readRevision = (doc) => Number.parseInt(doc.extractLabel("fr.pironjulien.indesign.mcp.revision") || "0", 10) || 0;
  if (app.documents.length !== expectedDocuments.length) { const error = new Error("L’inventaire des documents a changé"); error.code = "DOCUMENT_INVENTORY_CONFLICT"; throw error; }
  let targetDocument = null;
  const others = [];
  for (let index = 0; index < app.documents.length; index += 1) {
    const candidate = app.documents.item(index);
    const expected = expectedDocuments.find((entry) => Number(entry.documentId) === Number(candidate.id));
    if (!expected || readRevision(candidate) !== Number(expected.revision) || documentStateToken(candidate) !== expected.stateToken) { const error = new Error("Un document a changé après les sauvegardes"); error.code = "DOCUMENT_STATE_CONFLICT"; throw error; }
    if (Number(candidate.id) === wanted) targetDocument = candidate;
    else others.push({ doc: candidate, documentId: Number(candidate.id), revision: Number(expected.revision), stateToken: expected.stateToken });
  }
  if (!targetDocument) { const error = new Error("Document introuvable"); error.code = "DOCUMENT_NOT_FOUND"; throw error; }
  if (readRevision(targetDocument) !== expectedRevision) { const error = new Error("Le document a changé depuis la dernière lecture"); error.code = "REVISION_CONFLICT"; throw error; }
  if (documentStateToken(targetDocument) !== expectedStateToken) { const error = new Error("Le document a changé depuis la dernière inspection"); error.code = "STATE_CONFLICT"; throw error; }
  if (!savePath && !targetDocument.saved) { const error = new Error("Le document n’a jamais été enregistré : utilisez save_as"); error.code = "SAVE_AS_REQUIRED"; throw error; }
  const previousInteraction = app.scriptPreferences.userInteractionLevel;
  const previousRedraw = app.scriptPreferences.enableRedraw;
  let saveStarted = false;
  let outcome;
  try {
    app.scriptPreferences.userInteractionLevel = indesign.UserInteractionLevels.NEVER_INTERACT !== undefined ? indesign.UserInteractionLevels.NEVER_INTERACT : indesign.UserInteractionLevels.neverInteract;
    app.scriptPreferences.enableRedraw = false;
    saveStarted = true;
    if (savePath) await Promise.resolve(targetDocument.save(savePath));
    else await Promise.resolve(targetDocument.save());
    if (!targetDocument || targetDocument.isValid === false) { const error = new Error("Le document enregistré n’est plus valide"); error.code = "SAVE_RESULT_INVALID"; throw error; }
    for (const entry of others) {
      if (!entry.doc || entry.doc.isValid === false || readRevision(entry.doc) !== entry.revision || documentStateToken(entry.doc) !== entry.stateToken) {
        const error = new Error("Un autre document a changé pendant l’enregistrement"); error.code = "SAVE_OTHER_DOCUMENT_CHANGED"; throw error;
      }
    }
    if (readRevision(targetDocument) !== expectedRevision) { const error = new Error("La révision a changé pendant l’enregistrement"); error.code = "SAVE_REVISION_CHANGED"; throw error; }
    outcome = { ok: true, result: { success: true, saved: true, path: savePath }, documentId: wanted, revision: expectedRevision, stateToken: documentStateToken(targetDocument), operationId: __operationId };
  } catch (error) {
    error.requiresInspection = saveStarted;
    throw error;
  } finally {
    try { app.scriptPreferences.userInteractionLevel = previousInteraction; } catch (_) {}
    try { app.scriptPreferences.enableRedraw = previousRedraw; } catch (_) {}
  }
  await __writeResult(outcome);

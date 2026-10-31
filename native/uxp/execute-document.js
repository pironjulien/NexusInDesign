  if (app.modalState) { const error = new Error("InDesign affiche une boîte de dialogue modale"); error.code = "INDESIGN_MODAL"; throw error; }
  const wanted = @@documentId@@;
  const expectedRevision = @@expectedRevision@@;
  const expectedStateToken = @@expectedStateToken@@;
  const expectedDocuments = @@expectedDocuments@@;
  if (app.documents.length !== expectedDocuments.length) { const error = new Error("L’inventaire des documents a changé"); error.code = "DOCUMENT_INVENTORY_CONFLICT"; throw error; }
  let targetDocument = null;
  for (let index = 0; index < app.documents.length; index += 1) {
    const candidate = app.documents.item(index);
    const expected = expectedDocuments.find((entry) => Number(entry.documentId) === Number(candidate.id));
    const actual = Number.parseInt(candidate.extractLabel("fr.pironjulien.indesign.mcp.revision") || "0", 10) || 0;
    if (!expected || actual !== Number(expected.revision) || documentStateToken(candidate) !== expected.stateToken) { const error = new Error("Un document a changé après les sauvegardes"); error.code = "DOCUMENT_STATE_CONFLICT"; throw error; }
    if (Number(candidate.id) === wanted) targetDocument = candidate;
  }
  if (!targetDocument) { const error = new Error("Document introuvable"); error.code = "DOCUMENT_NOT_FOUND"; throw error; }
  const rawRevision = targetDocument.extractLabel("fr.pironjulien.indesign.mcp.revision");
  const actualRevision = Number.parseInt(rawRevision || "0", 10) || 0;
  if (actualRevision !== expectedRevision) { const error = new Error("Le document a changé depuis la dernière lecture"); error.code = "REVISION_CONFLICT"; throw error; }
  if (documentStateToken(targetDocument) !== expectedStateToken) { const error = new Error("Le document a changé depuis la dernière inspection"); error.code = "STATE_CONFLICT"; throw error; }
  const documentsBefore = [];
  for (let index = 0; index < app.documents.length; index += 1) { const current = app.documents.item(index); const raw = Number.parseInt(current.extractLabel("fr.pironjulien.indesign.mcp.revision") || "0", 10) || 0; documentsBefore.push({ doc: current, documentId: Number(current.id), revision: raw }); }
  const userInput = @@input@@;
  const userCode = @@code@@;
  const previousInteraction = app.scriptPreferences.userInteractionLevel;
  const previousRedraw = app.scriptPreferences.enableRedraw;
  let mutationStarted = false;
  let revisionsWritten = false;
  const advanceRevisions = () => {
    if (revisionsWritten) return [];
    revisionsWritten = true;
    const revisions = [];
    for (const entry of documentsBefore) { try { if (entry.doc && entry.doc.isValid !== false) { const next = entry.revision + 1; entry.doc.insertLabel("fr.pironjulien.indesign.mcp.revision", String(next)); revisions.push({ documentId: entry.documentId, revision: next }); } } catch (_) {} }
    return revisions;
  };
  let outcome;
  try {
    app.scriptPreferences.userInteractionLevel = indesign.UserInteractionLevels.NEVER_INTERACT !== undefined ? indesign.UserInteractionLevels.NEVER_INTERACT : indesign.UserInteractionLevels.neverInteract;
    app.scriptPreferences.enableRedraw = false;
    mutationStarted = true;
    const executeUserCode = new Function("app", "indesign", "doc", "input", '"use strict"; return (async function () {\n' + userCode + '\n}).call(null);');
    const value = await executeUserCode(app, indesign, targetDocument, userInput);
    const revisions = advanceRevisions();
    const currentTarget = revisions.find((entry) => entry.documentId === wanted);
    outcome = { ok: true, result: value === undefined ? null : value, documentId: wanted, revision: currentTarget ? currentTarget.revision : null, revisions, stateToken: targetDocument && targetDocument.isValid !== false ? documentStateToken(targetDocument) : null, operationId: __operationId };
  } catch (error) {
    if (mutationStarted) advanceRevisions();
    error.requiresInspection = mutationStarted;
    throw error;
  } finally {
    try { app.scriptPreferences.userInteractionLevel = previousInteraction; } catch (_) {}
    try { app.scriptPreferences.enableRedraw = previousRedraw; } catch (_) {}
  }
  await __writeResult(outcome);

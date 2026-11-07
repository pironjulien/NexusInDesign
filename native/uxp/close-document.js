  if (app.modalState) { const error = new Error(__t("InDesign shows a modal dialog", "InDesign affiche une boîte de dialogue modale")); error.code = "INDESIGN_MODAL"; throw error; }
  const wanted = @@documentId@@;
  const expectedRevision = @@expectedRevision@@;
  const expectedStateToken = @@expectedStateToken@@;
  const expectedDocuments = @@expectedDocuments@@;
  const captureDocumentProfile = () => {
    let activeId = null;
    if (app.documents.length > 0) {
      try {
        const activeDocument = app.activeDocument;
        if (activeDocument && activeDocument.isValid !== false) activeId = Number(activeDocument.id);
      } catch (_) {}
    }
    const profile = [];
    for (let index = 0; index < app.documents.length; index += 1) {
      const doc = app.documents.item(index);
      const rawRevision = doc.extractLabel("fr.pironjulien.indesign.mcp.revision");
      const parsedRevision = Number.parseInt(rawRevision || "0", 10);
      profile.push({
        doc,
        documentId: Number(doc.id),
        revision: Number.isInteger(parsedRevision) && parsedRevision >= 0 ? parsedRevision : 0,
        stateToken: documentStateToken(doc),
        modified: Boolean(doc.modified),
        saved: Boolean(doc.saved),
        active: Number(doc.id) === activeId
      });
    }
    return profile.sort((left, right) => left.documentId - right.documentId);
  };
  const normalizeDocumentProfile = (profile) => profile
      .map((entry) => ({ documentId: entry.documentId, revision: entry.revision, stateToken: entry.stateToken, modified: entry.modified === true, saved: entry.saved === true, active: entry.active === true }))
      .sort((left, right) => left.documentId - right.documentId);
  const normalizeDocumentMetadata = (profile) => profile
      .map((entry) => ({ documentId: entry.documentId, revision: entry.revision, modified: entry.modified === true, saved: entry.saved === true }))
      .sort((left, right) => left.documentId - right.documentId);
  const documentProfilesEqual = (left, right) =>
    JSON.stringify(normalizeDocumentProfile(left)) === JSON.stringify(normalizeDocumentProfile(right));
  const assertFocusOnlyTransition = (expected, actual, code, message) => {
    if (JSON.stringify(normalizeDocumentMetadata(expected)) !== JSON.stringify(normalizeDocumentMetadata(actual))) {
      const error = new Error(message); error.code = code; throw error;
    }
  };
  const assertDocumentProfile = (expected, actual, code, message) => {
    if (!documentProfilesEqual(expected, actual)) {
      const error = new Error(message); error.code = code; throw error;
    }
  };
  const captureStableDocumentProfile = async (code, message) => {
    const deadline = Date.now() + 10000;
    let previous = null;
    while (Date.now() < deadline) {
      let current;
      try { current = captureDocumentProfile(); }
      catch (_) { previous = null; await new Promise((resolve) => setTimeout(resolve, 50)); continue; }
      if (previous && documentProfilesEqual(previous, current)) return current;
      previous = current;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const error = new Error(message); error.code = code; throw error;
  };
  const bringDocumentToFront = async (doc, code) => {
    const windows = doc && doc.layoutWindows;
    const layoutWindow = windows && windows.length > 0 ? windows.item(0) : null;
    if (!layoutWindow || layoutWindow.isValid === false || typeof layoutWindow.bringToFront !== "function") {
      const error = new Error(__t("No layout window can confirm the focus change", "Aucune fenêtre de mise en page ne permet de vérifier le changement de focus")); error.code = code; throw error;
    }
    await Promise.resolve(layoutWindow.bringToFront());
    const deadline = Date.now() + 2000;
    while ((!app.activeDocument || Number(app.activeDocument.id) !== Number(doc.id)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!app.activeDocument || Number(app.activeDocument.id) !== Number(doc.id)) {
      const error = new Error(__t("The active document change was not confirmed", "Le changement de document actif n’a pas été confirmé")); error.code = code; throw error;
    }
  };
  if (app.documents.length !== expectedDocuments.length) { const error = new Error(__t("The document inventory changed", "L’inventaire des documents a changé")); error.code = "DOCUMENT_INVENTORY_CONFLICT"; throw error; }
  let target = null;
  const preserved = [];
  for (let index = 0; index < app.documents.length; index += 1) {
    const candidate = app.documents.item(index);
    const expected = expectedDocuments.find((entry) => Number(entry.documentId) === Number(candidate.id));
    const actual = Number.parseInt(candidate.extractLabel("fr.pironjulien.indesign.mcp.revision") || "0", 10) || 0;
    if (!expected || actual !== Number(expected.revision) || documentStateToken(candidate) !== expected.stateToken) { const error = new Error(__t("A document changed before closing", "Un document a changé avant la fermeture")); error.code = "DOCUMENT_STATE_CONFLICT"; throw error; }
    if (Number(candidate.id) === wanted) target = candidate;
    else preserved.push({ doc: candidate, documentId: Number(candidate.id) });
  }
  if (!target) { const error = new Error(__t("Document not found", "Document introuvable")); error.code = "DOCUMENT_NOT_FOUND"; throw error; }
  const actualRevision = Number.parseInt(target.extractLabel("fr.pironjulien.indesign.mcp.revision") || "0", 10) || 0;
  if (actualRevision !== expectedRevision) { const error = new Error(__t("The document changed since the last read", "Le document a changé depuis la dernière lecture")); error.code = "REVISION_CONFLICT"; throw error; }
  if (documentStateToken(target) !== expectedStateToken) { const error = new Error(__t("The document changed since the last inspection", "Le document a changé depuis la dernière inspection")); error.code = "STATE_CONFLICT"; throw error; }
  const previousInteraction = app.scriptPreferences.userInteractionLevel;
  const previousRedraw = app.scriptPreferences.enableRedraw;
  let closeStarted = false;
  let outcome;
  try {
    app.scriptPreferences.userInteractionLevel = indesign.UserInteractionLevels.NEVER_INTERACT !== undefined ? indesign.UserInteractionLevels.NEVER_INTERACT : indesign.UserInteractionLevels.neverInteract;
    app.scriptPreferences.enableRedraw = false;
    const initialProfile = await captureStableDocumentProfile("SILENT_CLOSE_PROFILE_UNSTABLE", __t("The initial document profile does not settle", "Le profil documentaire initial ne se stabilise pas"));
    const initialTarget = initialProfile.find((entry) => entry.documentId === wanted);
    let preservedBaseline = initialProfile.filter((entry) => entry.documentId !== wanted);
    if (initialTarget && initialTarget.active && preserved.length > 0) {
      const keeper = [...preserved]
        .sort((left, right) => left.documentId - right.documentId)
        .find((entry) => entry.doc && entry.doc.layoutWindows && entry.doc.layoutWindows.length > 0);
      if (!keeper) {
        const error = new Error(__t("No remaining document has a window to check", "Aucun document restant ne possède de fenêtre vérifiable")); error.code = "SILENT_CLOSE_FOCUS_UNAVAILABLE"; throw error;
      }
      await bringDocumentToFront(keeper.doc, "SILENT_CLOSE_FOCUS_SWITCH_FAILED");
      const focusedProfile = await captureStableDocumentProfile("SILENT_CLOSE_PROFILE_UNSTABLE", __t("The closing document profile does not settle", "Le profil documentaire de fermeture ne se stabilise pas"));
      assertFocusOnlyTransition(initialProfile, focusedProfile, "SILENT_CLOSE_FOCUS_CHANGED_DOCUMENT", __t("The window change modified a document", "Le changement de fenêtre a modifié un document"));
      preservedBaseline = focusedProfile.filter((entry) => entry.documentId !== wanted);
    }
    closeStarted = true;
    await target.close(indesign.SaveOptions.no);
    const deadline = Date.now() + 10000;
    let stillOpen = true;
    while (stillOpen && Date.now() < deadline) {
      stillOpen = false;
      // A document being closed can stay listed, then become invalid ("Object is invalid").
      try {
        for (let index = 0; index < app.documents.length; index += 1) {
          if (Number(app.documents.item(index).id) === wanted) { stillOpen = true; break; }
        }
      } catch (_) { stillOpen = true; }
      if (stillOpen) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (stillOpen) { const error = new Error(__t("Closing the document was not confirmed", "La fermeture du document n’a pas été confirmée")); error.code = "SILENT_CLOSE_NOT_CONFIRMED"; throw error; }
    const finalProfile = await captureStableDocumentProfile("SILENT_CLOSE_PROFILE_UNSTABLE", __t("The document profile after closing does not settle", "Le profil documentaire après fermeture ne se stabilise pas"));
    assertDocumentProfile(preservedBaseline, finalProfile, "SILENT_CLOSE_OTHER_DOCUMENT_CHANGED", __t("Another document changed during closing", "Un autre document a changé pendant la fermeture"));
    const activeDocumentId = finalProfile.find((entry) => entry.active)?.documentId ?? null;
    outcome = {
      ok: true,
      success: true,
      closedDocumentId: wanted,
      saved: false,
      activeDocumentId,
      documentStates: finalProfile.map(({ documentId, revision, stateToken }) => ({ documentId, revision, stateToken })),
      operationId: __operationId
    };
  } catch (error) {
    error.requiresInspection = closeStarted;
    throw error;
  } finally {
    try { app.scriptPreferences.userInteractionLevel = previousInteraction; } catch (_) {}
    try { app.scriptPreferences.enableRedraw = previousRedraw; } catch (_) {}
  }
  await __writeResult(outcome);

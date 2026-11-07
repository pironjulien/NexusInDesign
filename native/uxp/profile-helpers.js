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
  const captureStableDocumentProfile = async (code, message, deadline) => {
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

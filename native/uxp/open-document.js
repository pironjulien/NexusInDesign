  if (app.modalState) { const error = new Error(__t("InDesign shows a modal dialog", "InDesign affiche une boîte de dialogue modale")); error.code = "INDESIGN_MODAL"; throw error; }
  const sourcePath = @@filePath@@;
  const openProfileDeadline = Date.now() + @@profileBudgetMs@@;
@@PROFILE_HELPERS@@  const initialProfileDeadline = Math.min(openProfileDeadline, Date.now() + 10000);
  const documentsBefore = await captureStableDocumentProfile("OPEN_INITIAL_PROFILE_UNSTABLE", __t("The initial document profile does not settle", "Le profil documentaire initial ne se stabilise pas"), initialProfileDeadline);
  const previousActive = documentsBefore.find((entry) => entry.active);
  if (documentsBefore.length > 0 && !previousActive) {
    const error = new Error(__t("The initial active document is missing", "Le document actif initial est introuvable")); error.code = "OPEN_ACTIVE_DOCUMENT_MISSING"; throw error;
  }
  const previousInteraction = app.scriptPreferences.userInteractionLevel;
  const previousRedraw = app.scriptPreferences.enableRedraw;
  let opened = null;
  let mutationStarted = false;
  let outcome;
  try {
    app.scriptPreferences.userInteractionLevel = indesign.UserInteractionLevels.NEVER_INTERACT !== undefined ? indesign.UserInteractionLevels.NEVER_INTERACT : indesign.UserInteractionLevels.neverInteract;
    app.scriptPreferences.enableRedraw = false;
    mutationStarted = true;
    opened = await app.open(sourcePath, true);
    if (!opened || opened.isValid === false) { const error = new Error(__t("InDesign did not return a valid document", "InDesign n’a pas renvoyé de document valide")); error.code = "OPEN_RESULT_INVALID"; throw error; }
    await bringDocumentToFront(opened, "OPEN_FOCUS_SWITCH_FAILED");
    const openedId = Number(opened.id);
    const alreadyOpen = documentsBefore.some((entry) => entry.documentId === openedId);
    const expectedCount = documentsBefore.length + (alreadyOpen ? 0 : 1);
    if (app.documents.length !== expectedCount) { const error = new Error(__t("The open document inventory is unexpected", "L’inventaire des documents ouverts est inattendu")); error.code = "OPEN_INVENTORY_MISMATCH"; throw error; }
    const openedProfile = await captureStableDocumentProfile("OPEN_PROFILE_UNSTABLE", __t("The document profile after opening does not settle", "Le profil documentaire après ouverture ne se stabilise pas"), openProfileDeadline);
    const beforeIds = new Set(documentsBefore.map((entry) => entry.documentId));
    const existingAfterOpen = openedProfile.filter((entry) => beforeIds.has(entry.documentId));
    assertFocusOnlyTransition(documentsBefore, existingAfterOpen, "OPEN_EXISTING_DOCUMENT_CHANGED", __t("An already open document changed during opening", "Un document déjà ouvert a changé pendant l’ouverture"));
    if (alreadyOpen && previousActive?.documentId === openedId) {
      assertDocumentProfile(documentsBefore, openedProfile, "OPEN_EXISTING_DOCUMENT_CHANGED", __t("The already open document changed during its reactivation", "Le document déjà ouvert a changé pendant sa réactivation"));
    }
    const rawRevision = opened.extractLabel("fr.pironjulien.indesign.mcp.revision");
    const parsedRevision = Number.parseInt(rawRevision || "0", 10);
    const revision = Number.isInteger(parsedRevision) && parsedRevision >= 0 ? parsedRevision : 0;
    const finalProfile = openedProfile;
    outcome = {
      ok: true,
      success: true,
      documentId: openedId,
      name: String(opened.name),
      revision,
      stateToken: documentStateToken(opened),
      alreadyOpen,
      activeDocumentId: openedId,
      documentStates: finalProfile.map(({ documentId, revision: documentRevision, stateToken }) => ({ documentId, revision: documentRevision, stateToken })),
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

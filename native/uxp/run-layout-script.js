  if (app.modalState) { const error = new Error(__t("InDesign shows a modal dialog", "InDesign affiche une boîte de dialogue modale")); error.code = "INDESIGN_MODAL"; throw error; }
  const wanted = @@documentId@@;
  const expectedRevision = @@expectedRevision@@;
  const expectedStateToken = @@expectedStateToken@@;
  const slots = @@slots@@;
  const label = "fr.pironjulien.indesign.mcp.revision";
  if (app.documents.length > slots.length) { const error = new Error(__t("Too many open documents for the quick tool", "Trop de documents ouverts pour l’outil rapide")); error.code = "TOO_MANY_OPEN_DOCUMENTS"; throw error; }
  const readRevision = (doc) => Number.parseInt(doc.extractLabel(label) || "0", 10) || 0;
  const open = [];
  let target = null;
  for (let index = 0; index < app.documents.length; index += 1) {
    const doc = app.documents.item(index);
    const entry = { doc, documentId: Number(doc.id), revision: readRevision(doc), stateToken: documentStateToken(doc) };
    open.push(entry);
    if (entry.documentId === wanted) target = entry;
  }
  if (!target) { const error = new Error(__t("Document not found", "Document introuvable")); error.code = "DOCUMENT_NOT_FOUND"; throw error; }
  if (target.revision !== expectedRevision) { const error = new Error(__t("The document changed since the last read", "Le document a changé depuis la dernière lecture")); error.code = "REVISION_CONFLICT"; throw error; }
  if (target.stateToken !== expectedStateToken) { const error = new Error(__t("The document changed since the last inspection", "Le document a changé depuis la dernière inspection")); error.code = "STATE_CONFLICT"; throw error; }
  // A saved document with no pending change: its file is exactly its state, so the backup is a byte copy (fast, and
  // kept out of InDesign's recent files). Otherwise saveACopy.
  // UXP: fullName is a promise (a string or a file object depending on the version).
  const sourcePathOf = async (doc) => {
    try {
      const name = await doc.fullName;
      const value = typeof name === "string" ? name : (name && (name.fsName || name.nativePath)) || "";
      return /\.indd$/i.test(value) ? value : "";
    } catch (_) { return ""; }
  };
  const backups = [];
  for (let index = 0; index < open.length; index += 1) {
    const entry = open[index];
    let method = "saveACopy";
    const source = entry.doc.saved && !entry.doc.modified ? await sourcePathOf(entry.doc) : "";
    if (source) {
      try { await fs.writeFile(slots[index], await fs.readFile(source)); method = "copy"; }
      catch (_) { method = "saveACopy"; }
    }
    if (method === "saveACopy") entry.doc.saveACopy(slots[index]);
    backups.push({ slot: index, documentId: entry.documentId, revision: entry.revision, stateToken: entry.stateToken, method });
  }
  const userInput = @@input@@;
  const userCode = @@code@@;
  const undoName = @@undoName@@;
  let grouped = false;
  const previousInteraction = app.scriptPreferences.userInteractionLevel;
  const previousRedraw = app.scriptPreferences.enableRedraw;
  let value = null;
  let scriptError = null;
  try {
    app.scriptPreferences.userInteractionLevel = indesign.UserInteractionLevels.NEVER_INTERACT !== undefined ? indesign.UserInteractionLevels.NEVER_INTERACT : indesign.UserInteractionLevels.neverInteract;
    app.scriptPreferences.enableRedraw = false;
    const executeUserCode = new Function("app", "indesign", "doc", "input", '"use strict"; return (async function () {\n' + userCode + '\n}).call(null);');
    // One undo step: the synchronous part of the script (everything before its first await) runs in a named
    // ENTIRE_SCRIPT doScript; an asynchronous UXP doScript groups nothing.
    let pending = null;
    try { app.doScript(() => { pending = executeUserCode(app, indesign, target.doc, userInput); }, indesign.ScriptLanguage.UXPSCRIPT, [], indesign.UndoModes.ENTIRE_SCRIPT, undoName); grouped = pending !== null; } catch (_) {}
    if (pending === null) pending = executeUserCode(app, indesign, target.doc, userInput);
    value = await pending;
  } catch (error) {
    scriptError = { message: String(error && error.message ? error.message : error), line: error && error.line !== undefined ? Number(error.line) : null };
  } finally {
    try { app.scriptPreferences.userInteractionLevel = previousInteraction; } catch (_) {}
    try { app.scriptPreferences.enableRedraw = previousRedraw; } catch (_) {}
  }
  // Only documents whose fingerprint changed move forward: an untouched document (the target of a read-only script
  // included) keeps its revision and token, and is not marked modified by the revision label.
  // AUTO_UNDO: the revision label joins the script's step, so an undo also brings back the previous revision.
  const revisions = [];
  const writeRevisions = () => {
    revisions.length = 0;
    for (const entry of open) {
      try {
        if (entry.doc && entry.doc.isValid !== false) {
          const after = documentStateToken(entry.doc);
          if (after !== entry.stateToken) {
            const next = entry.revision + 1;
            entry.doc.insertLabel(label, String(next));
            revisions.push({ documentId: entry.documentId, revision: next, stateToken: after });
          }
        }
      } catch (_) {}
    }
  };
  let labelled = false;
  if (grouped) { try { app.doScript(() => { writeRevisions(); labelled = true; }, indesign.ScriptLanguage.UXPSCRIPT, [], indesign.UndoModes.AUTO_UNDO, undoName); } catch (_) {} }
  if (!labelled) writeRevisions();
  const targetValid = target.doc && target.doc.isValid !== false;
  let saved = false;
  if (@@save@@ && targetValid && !scriptError) { target.doc.save(); saved = true; }
  let preview = null;
  if (targetValid) {
    try {
      const prefs = app.pngExportPreferences;
      const previous = { range: prefs.pngExportRange, pages: prefs.pageString, resolution: prefs.exportResolution };
      prefs.pngExportRange = indesign.PNGExportRangeEnum.EXPORT_RANGE;
      prefs.pageString = @@previewPages@@;
      prefs.exportResolution = @@previewResolution@@;
      const pages = String(prefs.pageString);
      target.doc.exportFile(indesign.ExportFormat.PNG_FORMAT, @@previewPath@@, false);
      try { prefs.pngExportRange = previous.range; prefs.pageString = previous.pages; prefs.exportResolution = previous.resolution; } catch (_) {}
      preview = { pages };
    } catch (error) { preview = { error: String(error && error.message ? error.message : error) }; }
  }
  const current = revisions.find((entry) => entry.documentId === wanted);
  let undo = null;
  if (current && targetValid) { try { undo = { name: undoName, singleStep: grouped && String(target.doc.undoName) === undoName }; } catch (_) {} }
  const finalStateToken = targetValid ? documentStateToken(target.doc) : null;
  let closed = false;
  if (@@close@@ && saved) { await target.doc.close(indesign.SaveOptions.NO); closed = true; }
  await __writeResult({
    ok: true,
    scriptOk: scriptError === null,
    scriptError,
    result: value === undefined ? null : value,
    documentId: wanted,
    revision: current ? current.revision : target.revision,
    stateToken: closed ? null : finalStateToken,
    revisions,
    saved,
    closed,
    backups,
    preview,
    undo,
    operationId: __operationId
  });

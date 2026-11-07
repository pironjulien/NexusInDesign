  const wanted = @@documentId@@;
  let doc = null;
  for (let index = 0; index < app.documents.length; index += 1) { const candidate = app.documents.item(index); if (Number(candidate.id) === wanted) { doc = candidate; break; } }
  if (!doc) { const error = new Error(__t("Document not found", "Document introuvable")); error.code = "DOCUMENT_NOT_FOUND"; throw error; }
  const rawRevision = doc.extractLabel("fr.pironjulien.indesign.mcp.revision");
  const parsedRevision = Number.parseInt(rawRevision || "0", 10);
  script.setResult(JSON.stringify({ ok: true, document: { documentId: Number(doc.id), name: String(doc.name), pages: doc.pages.length, spreads: doc.spreads.length, pageItems: doc.allPageItems.length, width: Number(doc.documentPreferences.pageWidth), height: Number(doc.documentPreferences.pageHeight), facingPages: Boolean(doc.documentPreferences.facingPages), modified: Boolean(doc.modified), saved: Boolean(doc.saved), revision: Number.isInteger(parsedRevision) && parsedRevision >= 0 ? parsedRevision : 0, stateToken: documentStateToken(doc) } }));

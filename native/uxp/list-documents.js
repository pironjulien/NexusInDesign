  const documents = [];
  for (let index = 0; index < app.documents.length; index += 1) {
    const doc = app.documents.item(index);
    const rawRevision = doc.extractLabel("fr.pironjulien.indesign.mcp.revision");
    const parsedRevision = Number.parseInt(rawRevision || "0", 10);
    documents.push({ documentId: Number(doc.id), name: String(doc.name), pages: doc.pages.length, modified: Boolean(doc.modified), revision: Number.isInteger(parsedRevision) && parsedRevision >= 0 ? parsedRevision : 0, active: Boolean(app.activeDocument && Number(app.activeDocument.id) === Number(doc.id)) });
  }
  script.setResult(JSON.stringify({ ok: true, documents }));

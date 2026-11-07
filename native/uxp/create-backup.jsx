(function () {
  var wanted = @@documentId@@;
  var expected = @@expectedRevision@@;
  var label = "fr.pironjulien.indesign.mcp.revision";
  var french = @@FRENCH@@;
  var doc = null;
  for (var index = 0; index < app.documents.length; index += 1) { if (Number(app.documents.item(index).id) === wanted) { doc = app.documents.item(index); break; } }
  if (!doc) { return "ERR|DOCUMENT_NOT_FOUND|" + (french ? "Document introuvable" : "Document not found"); }
  var actual = parseInt(doc.extractLabel(label) || "0", 10) || 0;
  if (actual !== expected) { return "ERR|REVISION_CONFLICT|" + (french ? "Le document a change depuis la derniere lecture" : "The document changed since the last read"); }
  try { doc.saveACopy(File(@@backupPath@@)); }
  catch (error) { return "ERR|BACKUP_FAILED|" + String(error && error.message ? error.message : error); }
  return "OK|" + @@backupId@@ + "|" + wanted + "|" + actual;
}());

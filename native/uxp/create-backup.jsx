(function () {
  var wanted = @@documentId@@;
  var expected = @@expectedRevision@@;
  var label = "fr.pironjulien.indesign.mcp.revision";
  var doc = null;
  for (var index = 0; index < app.documents.length; index += 1) { if (Number(app.documents.item(index).id) === wanted) { doc = app.documents.item(index); break; } }
  if (!doc) { return "ERR|DOCUMENT_NOT_FOUND|Document introuvable"; }
  var actual = parseInt(doc.extractLabel(label) || "0", 10) || 0;
  if (actual !== expected) { return "ERR|REVISION_CONFLICT|Le document a change depuis la derniere lecture"; }
  try { doc.saveACopy(File(@@backupPath@@)); }
  catch (error) { return "ERR|BACKUP_FAILED|" + String(error && error.message ? error.message : error); }
  return "OK|" + @@backupId@@ + "|" + wanted + "|" + actual;
}());

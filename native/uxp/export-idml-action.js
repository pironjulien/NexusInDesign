  const idmlFormat = indesign.ExportFormat && (indesign.ExportFormat.INDESIGN_MARKUP !== undefined ? indesign.ExportFormat.INDESIGN_MARKUP : indesign.ExportFormat.indesignMarkup);
  if (idmlFormat === undefined) { const error = new Error("L’API d’export IDML est indisponible"); error.code = "INDESIGN_API_UNAVAILABLE"; throw error; }
  try {
    exportStarted = true;
    await targetDocument.exportFile(idmlFormat, @@filePath@@, false);
    exportResult = { success: true, path: @@filePath@@ };
  } catch (error) { exportFailure = error; }

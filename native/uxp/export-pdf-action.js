  const requestedPreset = @@presetName@@;
  let preset;
  if (requestedPreset) {
    preset = app.pdfExportPresets.itemByName(requestedPreset);
    if (!preset || preset.isValid === false) { const error = new Error("Paramètre PDF introuvable"); error.code = "PDF_PRESET_NOT_FOUND"; throw error; }
  }
  const preferences = app.pdfExportPreferences;
  const previousPageRange = preferences.pageRange;
  const previousBleed = preferences.useDocumentBleedWithPDF;
  const previousCropMarks = preferences.cropMarks;
  try {
    const allPages = indesign.PageRange ? (indesign.PageRange.ALL_PAGES !== undefined ? indesign.PageRange.ALL_PAGES : indesign.PageRange.allPages) : undefined;
    preferences.pageRange = allPages !== undefined ? allPages : "all";
    preferences.useDocumentBleedWithPDF = true;
    preferences.cropMarks = false;
    exportStarted = true;
    await targetDocument.exportFile(indesign.ExportFormat.pdfType, @@filePath@@, false, preset);
    exportResult = { success: true, path: @@filePath@@, preset: requestedPreset, pageRange: "all" };
  } catch (error) { exportFailure = error; }
  finally {
    try { preferences.pageRange = previousPageRange; } catch (_) { restorationFailures.push("pdf.pageRange"); }
    try { preferences.useDocumentBleedWithPDF = previousBleed; } catch (_) { restorationFailures.push("pdf.bleed"); }
    try { preferences.cropMarks = previousCropMarks; } catch (_) { restorationFailures.push("pdf.cropMarks"); }
  }

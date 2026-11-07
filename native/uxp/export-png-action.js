@@ANNOTATE_FUNCTIONS@@
  const outputDirectory = @@folderPath@@;
  const annotateCopyPath = @@annotateCopyPath@@;
  let exportDocument = targetDocument;
  let annotated = null;
  const singleFilePath = @@filePath@@;
  const requestedPageId = @@pageId@@;
  const requestedPageRange = @@pageRange@@;
  const preferences = app.pngExportPreferences;
  const previousResolution = preferences.exportResolution;
  const previousTransparent = preferences.transparentBackground;
  const previousRange = preferences.pngExportRange;
  const previousPageString = preferences.pageString;
  const previousExportingSpread = preferences.exportingSpread;
  const rangeEnum = indesign.PNGExportRangeEnum || indesign.ExportRangeOrAllPages;
  const exportRange = rangeEnum && (rangeEnum.EXPORT_RANGE !== undefined ? rangeEnum.EXPORT_RANGE : rangeEnum.exportRange);
  const pngFormat = indesign.ExportFormat && (indesign.ExportFormat.PNG_FORMAT !== undefined ? indesign.ExportFormat.PNG_FORMAT : indesign.ExportFormat.pngFormat);
  if (exportRange === undefined || pngFormat === undefined) { const error = new Error(__t("The PNG export API is unavailable", "L’API d’export PNG est indisponible")); error.code = "INDESIGN_API_UNAVAILABLE"; throw error; }
  const parsePageIndexes = (value, pageCount) => {
    if (String(value).trim().toLowerCase() === "all") return Array.from({ length: pageCount }, (_, index) => index);
    const indexes = new Set();
    for (const token of String(value).split(",")) {
      const match = /^(\d+)(?:-(\d+))?$/.exec(token.trim());
      if (!match) { const error = new Error(__t("The PNG page range is invalid", "La plage de pages PNG est invalide")); error.code = "PAGE_RANGE_INVALID"; throw error; }
      const start = Number(match[1]); const end = Number(match[2] || match[1]);
      if (start < 1 || end < start || end > pageCount) { const error = new Error(__t("The PNG page range is outside the document", "La plage de pages PNG sort du document")); error.code = "PAGE_RANGE_INVALID"; throw error; }
      for (let page = start; page <= end; page += 1) indexes.add(page - 1);
    }
    return [...indexes].sort((left, right) => left - right);
  };
  const exportedPaths = [];
  try {
    if (annotateCopyPath !== null) {
      exportStarted = true;
      const opened = await openAnnotatedCopy(annotateCopyPath);
      exportDocument = opened.copy;
      annotated = opened.summary;
    }
    preferences.exportResolution = @@resolution@@;
    preferences.transparentBackground = @@transparentBackground@@;
    preferences.exportingSpread = false;
    preferences.pngExportRange = exportRange;
    if (requestedPageId !== null) {
      let page = null;
      for (let index = 0; index < exportDocument.pages.length; index += 1) { const candidate = exportDocument.pages.item(index); if (Number(candidate.id) === requestedPageId) { page = candidate; break; } }
      if (!page) { const error = new Error(__t("Page not found", "Page introuvable")); error.code = "PAGE_NOT_FOUND"; throw error; }
      preferences.pageString = "+" + String(Number(page.documentOffset) + 1);
      exportStarted = true;
      await exportDocument.exportFile(pngFormat, singleFilePath, false);
      exportedPaths.push(singleFilePath);
    } else {
      const indexes = parsePageIndexes(requestedPageRange, exportDocument.pages.length);
      for (const index of indexes) {
        const targetPath = outputDirectory.replace(/[\\/]$/, "") + "/page-" + String(index + 1).padStart(4, "0") + ".png";
        preferences.pageString = "+" + String(index + 1);
        exportStarted = true;
        await exportDocument.exportFile(pngFormat, targetPath, false);
        exportedPaths.push(targetPath);
      }
    }
    exportResult = { success: true, paths: exportedPaths, resolution: @@resolution@@, pageId: requestedPageId, pageRange: requestedPageRange, annotated };
  } catch (error) { exportFailure = error; }
  finally {
    try { preferences.exportResolution = previousResolution; } catch (_) { restorationFailures.push("png.resolution"); }
    try { preferences.transparentBackground = previousTransparent; } catch (_) { restorationFailures.push("png.transparent"); }
    try { preferences.exportingSpread = previousExportingSpread; } catch (_) { restorationFailures.push("png.spread"); }
    try { preferences.pageString = previousPageString; } catch (_) { restorationFailures.push("png.pageString"); }
    try { preferences.pngExportRange = previousRange; } catch (_) { restorationFailures.push("png.range"); }
    if (exportDocument !== targetDocument) { try { await exportDocument.close(indesign.SaveOptions.NO); } catch (_) { restorationFailures.push("annotated.close"); } }
  }

  const packageOptions = @@options@@;
  try {
    exportStarted = true;
    const completed = targetDocument.packageForPrint(
      packageOptions.folderPath,
      packageOptions.includeFonts,
      packageOptions.includeLinks,
      packageOptions.includeProfiles,
      true,
      packageOptions.includeHiddenLayers,
      packageOptions.ignorePreflightErrors,
      true,
      packageOptions.includeIdml,
      packageOptions.includePdf,
      packageOptions.pdfPresetName,
      true,
      "InDesign MCP Secure",
      false
    );
    if (completed === false) {
      const findings = [];
      const limit = (list) => list.slice(0, 10).join(", ") + (list.length > 10 ? "…" : "");
      const rgb = []; const links = []; const fonts = []; let overset = 0;
      try {
        const graphics = targetDocument.allGraphics;
        for (let index = 0; index < graphics.length; index += 1) {
          const graphic = graphics[index];
          let space = ""; try { space = String(graphic.space); } catch (_) {}
          if (/^(RGB|RVB)$/i.test(space)) { let name = ""; try { name = String(graphic.itemLink.name); } catch (_) {} rgb.push(name || "image"); }
        }
      } catch (_) {}
      try {
        for (let index = 0; index < targetDocument.links.length; index += 1) {
          const link = targetDocument.links.item(index);
          const status = String(link.status);
          if (!/^(NORMAL|normal)$/.test(status) && !/normal/i.test(status)) links.push(String(link.name) + " (" + status + ")");
        }
      } catch (_) {}
      try {
        for (let index = 0; index < targetDocument.fonts.length; index += 1) {
          const font = targetDocument.fonts.item(index);
          const status = String(font.status);
          if (!/installed/i.test(status)) fonts.push(String(font.name).replace(/	/g, " ") + " (" + status + ")");
        }
      } catch (_) {}
      try {
        for (let index = 0; index < targetDocument.stories.length; index += 1) if (targetDocument.stories.item(index).overflows) overset += 1;
      } catch (_) {}
      if (rgb.length) findings.push(rgb.length + " image(s) RVB : " + limit([...new Set(rgb)]));
      if (links.length) findings.push(links.length + " lien(s) à revoir : " + limit(links));
      if (fonts.length) findings.push(fonts.length + " police(s) non installée(s) : " + limit(fonts));
      if (overset) findings.push(overset + " bloc(s) de texte en excès");
      const error = new Error(packageOptions.ignorePreflightErrors
        ? "InDesign n’a pas créé l’assemblage" + (findings.length ? " (" + findings.join(" ; ") + ")" : "")
        : "InDesign refuse l’assemblage tant que ses contrôles signalent un problème : "
          + (findings.length ? findings.join(" ; ") : "problème non identifié")
          + ". Corrigez-le, ou repassez ignorePreflightErrors=true pour assembler malgré ces alertes.");
      error.code = packageOptions.ignorePreflightErrors ? "PACKAGE_FAILED" : "PACKAGE_REFUSED_BY_CHECKS";
      throw error;
    }
    exportResult = { success: true, folderPath: packageOptions.folderPath };
  } catch (error) { exportFailure = error; }

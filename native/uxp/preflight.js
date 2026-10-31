  const wanted = @@documentId@@;
  const requestedProfile = @@profileName@@;
  const timeoutSeconds = @@timeoutSeconds@@;
  let doc = null;
  for (let index = 0; index < app.documents.length; index += 1) {
    const candidate = app.documents.item(index);
    if (candidate && candidate.isValid !== false && Number(candidate.id) === wanted) { doc = candidate; break; }
  }
  if (!doc) { const error = new Error("Document introuvable"); error.code = "DOCUMENT_NOT_FOUND"; throw error; }
  if (app.modalState) { const error = new Error("InDesign affiche une boîte de dialogue modale"); error.code = "INDESIGN_MODAL"; throw error; }
  const stateBefore = documentStateToken(doc);
  const rawRevision = doc.extractLabel("fr.pironjulien.indesign.mcp.revision");
  const parsedRevision = Number.parseInt(rawRevision || "0", 10);
  const revision = Number.isInteger(parsedRevision) && parsedRevision >= 0 ? parsedRevision : 0;
  const expectedRevision = @@expectedRevision@@;
  if (expectedRevision !== null && revision !== expectedRevision) { const error = new Error("Le document a changé depuis la dernière lecture"); error.code = "REVISION_CONFLICT"; throw error; }
  const preflightOptions = doc.preflightOptions;
  const originalPreflightOff = Boolean(preflightOptions.preflightOff);
  const safeValue = (value, depth = 0, seen = new Set()) => {
    if (value === null || value === undefined) return null;
    if (["string", "number", "boolean"].includes(typeof value)) return typeof value === "string" ? value.slice(0, 200000) : value;
    if (depth >= 8) return "[profondeur limitee]";
    if (Array.isArray(value)) {
      if (value.length > 50000) { const error = new Error("Le résultat du contrôle Adobe est trop volumineux"); error.code = "PREFLIGHT_RESULT_TOO_LARGE"; throw error; }
      return value.map((entry) => safeValue(entry, depth + 1, seen));
    }
    if (typeof value === "object") {
      if (seen.has(value)) return "[reference circulaire]";
      seen.add(value);
      const output = {};
      for (const key of Object.keys(value).slice(0, 500)) {
        if (["__proto__", "prototype", "constructor"].includes(key)) continue;
        try { output[key] = safeValue(value[key], depth + 1, seen); }
        catch (error) { if (error && error.code === "PREFLIGHT_RESULT_TOO_LARGE") throw error; output[key] = null; }
      }
      seen.delete(value);
      return output;
    }
    return String(value);
  };
  const profileByName = (name) => {
    let candidate = null;
    try { candidate = doc.preflightProfiles.itemByName(name); } catch (_) {}
    if (candidate && candidate.isValid) return candidate;
    try { candidate = app.preflightProfiles.itemByName(name); } catch (_) {}
    return candidate && candidate.isValid ? candidate : null;
  };
  let profile = null;
  if (requestedProfile) {
    profile = profileByName(requestedProfile);
    if (!profile) { const error = new Error("Profil de contrôle introuvable"); error.code = "PREFLIGHT_PROFILE_NOT_FOUND"; throw error; }
  } else {
    let workingProfile = null;
    try { workingProfile = preflightOptions.preflightWorkingProfile; } catch (_) {}
    if (workingProfile && typeof workingProfile === "object" && workingProfile.isValid) profile = workingProfile;
    else if (typeof workingProfile === "string" && workingProfile) profile = profileByName(workingProfile);
    if (!profile && app.preflightProfiles.length > 0) profile = app.preflightProfiles.item(0);
    if (!profile || profile.isValid === false) { const error = new Error("Aucun profil de contrôle disponible"); error.code = "PREFLIGHT_PROFILE_NOT_FOUND"; throw error; }
  }
  let process = null;
  let operationStarted = false;
  let outcome;
  try {
    if (originalPreflightOff) preflightOptions.preflightOff = false;
    process = app.preflightProcesses.add(doc, profile);
    operationStarted = true;
    const startedAt = Date.now();
    let completed = Boolean(process.waitForProcess(timeoutSeconds));
    if (!completed) {
      const remaining = timeoutSeconds - Math.ceil((Date.now() - startedAt) / 1000);
      if (remaining > 0) completed = Boolean(process.waitForProcess(remaining));
    }
    let aggregated = null;
    let report = "";
    try { aggregated = safeValue(process.aggregatedResults); } catch (error) { throw error; }
    try { report = String(process.processResults || "").slice(0, 200000); } catch (_) {}
    if (!completed && Array.isArray(aggregated) && aggregated.length >= 3 && report.length > 0) completed = true;
    if (!completed) { const error = new Error("Le contrôle Adobe n’est pas terminé"); error.code = "PREFLIGHT_TIMEOUT"; throw error; }
    outcome = { ok: true, success: true, profile: String(profile.name), aggregatedResults: aggregated, processResults: report, documentId: wanted, revision };
  } catch (error) {
    error.requiresInspection = operationStarted;
    throw error;
  } finally {
    if (process) { try { process.remove(); } catch (_) {} }
    if (originalPreflightOff) {
      let restorationFailed = false;
      try {
        preflightOptions.preflightOff = true;
        restorationFailed = Boolean(preflightOptions.preflightOff) !== originalPreflightOff;
      } catch (_) {
        restorationFailed = true;
      }
      if (restorationFailed) {
        const error = new Error("La préférence de préflight InDesign n’a pas pu être restaurée");
        error.code = "PREFLIGHT_PREFERENCES_RESTORE_FAILED";
        error.requiresInspection = true;
        throw error;
      }
    }
  }
  if (!doc || doc.isValid === false || documentStateToken(doc) !== stateBefore) {
    const error = new Error("Le document a changé pendant le contrôle Adobe");
    error.code = "DOCUMENT_CHANGED_DURING_READ";
    error.requiresInspection = true;
    throw error;
  }
  script.setResult(JSON.stringify(outcome));

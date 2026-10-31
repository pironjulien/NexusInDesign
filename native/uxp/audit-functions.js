function auditCollectionItem(collection, index) {
  return collection && typeof collection.item === "function" ? collection.item(index) : collection[index];
}
function auditNumericArray(value) {
  if (!value || typeof value.length !== "number") return [];
  const output = [];
  for (let index = 0; index < value.length; index += 1) output.push(Number(value[index]));
  return output;
}
function auditItemType(item) {
  try { return item.constructorName || (item.constructor && item.constructor.name) || "PageItem"; }
  catch (_) { return "PageItem"; }
}
function auditNamedReference(value) {
  try {
    if (!value || value.isValid === false) return null;
    return { id: Number.isFinite(Number(value.id)) ? Number(value.id) : null, name: typeof value.name === "string" ? value.name : String(value.name || "") };
  } catch (_) { return null; }
}
function auditEnumSummary(value, enumeration) {
  let numeric = null;
  let name = "";
  try { if (Number.isFinite(Number(value))) numeric = Number(value); } catch (_) {}
  try { name = String(value); } catch (_) {}
  if (enumeration && typeof enumeration === "object") {
    try {
      const keys = Object.keys(enumeration);
      for (let index = 0; index < keys.length; index += 1) {
        if (enumeration[keys[index]] === value || Number(enumeration[keys[index]]) === numeric) { name = keys[index]; break; }
      }
    } catch (_) {}
  }
  return { value: numeric, name };
}
function auditPageItemSummary(item) {
  let pageId = null;
  let layerName = null;
  try { pageId = item.parentPage && item.parentPage.isValid !== false ? Number(item.parentPage.id) : null; } catch (_) {}
  try { layerName = item.itemLayer && item.itemLayer.isValid !== false ? String(item.itemLayer.name) : null; } catch (_) {}
  return {
    id: Number(item.id), type: auditItemType(item), name: typeof item.name === "string" ? item.name : "",
    pageId, layerName, bounds: auditNumericArray(item.geometricBounds), locked: Boolean(item.locked),
    visible: item.visible !== false, nonprinting: Boolean(item.nonprinting)
  };
}
function auditStyleSummary(style, kind) {
  const output = { id: Number.isFinite(Number(style.id)) ? Number(style.id) : null, name: typeof style.name === "string" ? style.name : "", basedOn: null };
  try { output.basedOn = auditNamedReference(style.basedOn); } catch (_) {}
  if (kind === "paragraph" || kind === "character") {
    try { output.fontFamily = style.appliedFont && (style.appliedFont.fontFamily || style.appliedFont.name) || null; } catch (_) { output.fontFamily = null; }
    try { output.fontStyle = style.fontStyle || null; } catch (_) { output.fontStyle = null; }
    try { output.pointSize = Number.isFinite(Number(style.pointSize)) ? Number(style.pointSize) : null; } catch (_) { output.pointSize = null; }
    try { output.leading = Number.isFinite(Number(style.leading)) ? Number(style.leading) : null; } catch (_) { output.leading = null; }
    try { output.fillColor = auditNamedReference(style.fillColor); } catch (_) { output.fillColor = null; }
    try { output.justification = auditEnumSummary(style.justification); } catch (_) { output.justification = { value: null, name: "" }; }
    try { output.tracking = Number.isFinite(Number(style.tracking)) ? Number(style.tracking) : null; } catch (_) { output.tracking = null; }
  } else if (kind === "object") {
    try { output.fillColor = auditNamedReference(style.fillColor); } catch (_) { output.fillColor = null; }
    try { output.strokeColor = auditNamedReference(style.strokeColor); } catch (_) { output.strokeColor = null; }
    try { output.strokeWeight = Number.isFinite(Number(style.strokeWeight)) ? Number(style.strokeWeight) : null; } catch (_) { output.strokeWeight = null; }
    try { output.textWrapMode = auditEnumSummary(style.textWrapPreferences.textWrapMode); } catch (_) { output.textWrapMode = { value: null, name: "" }; }
  }
  return output;
}
function auditCollectionSummary(collection, mapper) {
  const output = [];
  if (!collection) return output;
  for (let index = 0; index < collection.length; index += 1) {
    try { output.push(mapper(auditCollectionItem(collection, index), index)); } catch (_) {}
  }
  return output;
}
async function auditNativePath(doc) {
  let documentName = null;
  try {
    const value = await doc.name;
    documentName = typeof value === "string" ? value : null;
  } catch (_) {}
  for (const property of ["fullName", "filePath"]) {
    let fileLike = null;
    try { fileLike = await doc[property]; } catch (_) { continue; }
    if (!fileLike) continue;
    const candidates = [];
    if (typeof fileLike === "string") candidates.push(fileLike);
    else {
      for (const field of ["nativePath", "fsName", "url"]) {
        try { candidates.push(await fileLike[field]); } catch (_) {}
      }
      try { candidates.push(String(fileLike)); } catch (_) {}
    }
    for (let candidate of candidates) {
      if (typeof candidate !== "string") continue;
      candidate = candidate.trim();
      if (!candidate || candidate === "[object Object]" || candidate === "[object Promise]" || candidate.includes(String.fromCharCode(0))) continue;
      if (property === "filePath" && documentName) {
        const normalized = candidate.replaceAll(String.fromCharCode(92), "/");
        const last = normalized.slice(normalized.lastIndexOf("/") + 1);
        if (last.toLowerCase() !== documentName.toLowerCase()) {
          const separator = candidate.includes(String.fromCharCode(92)) ? String.fromCharCode(92) : "/";
          while (candidate.endsWith("/") || candidate.endsWith(String.fromCharCode(92))) candidate = candidate.slice(0, -1);
          candidate = candidate + separator + documentName;
        }
      }
      return candidate;
    }
  }
  return null;
}

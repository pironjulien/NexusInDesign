function documentStateToken(doc) {
  let first = 2166136261 >>> 0;
  let second = 2246822507 >>> 0;
  const update = (value) => {
    let text;
    if (Array.isArray(value)) text = value.map((entry) => String(entry)).join("|");
    else text = String(value === undefined || value === null ? "" : value);
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      first = Math.imul(first ^ code, 16777619) >>> 0;
      second = Math.imul(second ^ code, 3266489909) >>> 0;
    }
    update.separator = (update.separator + 1) >>> 0;
    first = Math.imul(first ^ update.separator, 16777619) >>> 0;
    second = Math.imul(second ^ update.separator, 3266489909) >>> 0;
  };
  update.separator = 0;
  const read = (getter, marker) => { try { update(getter()); } catch (_) { update(marker || "unreadable"); } };
  const objectRef = (value) => {
    if (!value || value.isValid === false) return "";
    let id = ""; let name = ""; let type = "";
    try { id = value.id; } catch (_) {}
    try { name = value.name; } catch (_) {}
    try { type = value.constructorName; } catch (_) {}
    return [type, id, name];
  };
  const synchronousFilePath = (value) => {
    if (typeof value === "string") {
      let candidate = value.trim();
      if (!candidate || candidate === "[object Object]" || candidate.indexOf("\0") !== -1) return "";
      if (/^file:/i.test(candidate)) {
        try { candidate = decodeURIComponent(candidate); } catch (_) { return ""; }
        const unc = candidate.match(/^file:\/\/([^/]+)(\/.*)$/i);
        if (unc && unc[1].toLowerCase() !== "localhost") candidate = "\\\\" + unc[1] + unc[2].replace(/\//g, "\\");
        else {
          candidate = candidate.replace(/^file:\/\/localhost\/?/i, "").replace(/^file:\/\//i, "");
          if (/^\/[A-Za-z]:/.test(candidate)) candidate = candidate.slice(1);
          candidate = candidate.replace(/\//g, "\\");
        }
      }
      return candidate.replace(/\//g, "\\");
    }
    if (!value || (typeof value !== "object" && typeof value !== "function")) return "";
    for (const property of ["nativePath", "fsName", "url"]) {
      try {
        const candidate = value[property];
        if (candidate && typeof candidate.then !== "function") {
          const path = synchronousFilePath(candidate);
          if (path) return path;
        }
      } catch (_) {}
    }
    return "";
  };
  const pathWithDocumentName = (path, name) => {
    if (!path || !name) return path || "";
    const normalized = path.replace(/\//g, "\\");
    const lastPart = normalized.slice(normalized.lastIndexOf("\\") + 1);
    if (lastPart.toLowerCase() === name.toLowerCase()) return normalized;
    return normalized.replace(/[\\/]+$/, "") + "\\" + name;
  };
  const propertySnapshot = (owner, label) => {
    read(() => {
      const properties = owner.properties;
      const keys = Object.keys(properties).sort();
      const snapshot = [label, keys.length];
      for (const key of keys) {
        let value;
        try { value = properties[key]; } catch (_) { snapshot.push(key, "unreadable"); continue; }
        if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") snapshot.push(key, value);
        else if (Array.isArray(value)) snapshot.push(key, value.map((entry) => entry && typeof entry === "object" ? objectRef(entry).join(":") : String(entry)).join(";"));
        else snapshot.push(key, objectRef(value).join(":"));
      }
      return snapshot;
    }, label + "-properties");
  };
  const styleCollection = (collection, fields) => {
    if (!collection) { update("styles-unavailable"); return; }
    let styleCount = 0;
    try { styleCount = collection.length; } catch (_) { update("styles-unreadable"); return; }
    read(() => styleCount, "styles");
    for (let index = 0; index < styleCount; index += 1) {
      const style = collection.item(index);
      read(() => objectRef(style), "style");
      for (const field of fields) read(() => objectRef(style[field]).join("|") || style[field], "style-" + field);
      propertySnapshot(style, "style");
    }
  };

  let documentName = "";
  try { documentName = typeof doc.name === "string" ? doc.name : ""; } catch (_) {}
  let fullNameIdentity = "";
  let filePathIdentity = "";
  try { fullNameIdentity = pathWithDocumentName(synchronousFilePath(doc.fullName), documentName); } catch (_) {}
  try { filePathIdentity = pathWithDocumentName(synchronousFilePath(doc.filePath), documentName); } catch (_) {}
  update([
    "document-file-identity",
    documentName,
    fullNameIdentity,
    filePathIdentity
  ]);
  read(() => doc.id); read(() => doc.modified); read(() => doc.saved);
  read(() => doc.pages.length); read(() => doc.spreads.length); read(() => doc.masterSpreads.length);
  read(() => doc.stories.length); read(() => doc.links.length); read(() => doc.layers.length);
  const preferences = doc.documentPreferences;
  propertySnapshot(preferences, "document-preferences");
  for (const field of ["pageWidth", "pageHeight", "facingPages", "pagesPerDocument", "pageBinding", "startPageNumber", "documentBleedTopOffset", "documentBleedBottomOffset", "documentBleedInsideOrLeftOffset", "documentBleedOutsideOrRightOffset", "slugTopOffset", "slugBottomOffset", "slugInsideOrLeftOffset", "slugRightOrOutsideOffset"]) {
    read(() => preferences[field], "preference-" + field);
  }

  for (let index = 0; index < doc.layers.length; index += 1) {
    const layer = doc.layers.item(index);
    read(() => objectRef(layer), "layer");
    propertySnapshot(layer, "layer");
    for (const field of ["visible", "locked", "printable", "showGuides", "lockGuides", "layerColor", "ignoreWrap"]) read(() => layer[field], "layer-" + field);
  }

  for (let index = 0; index < doc.pages.length; index += 1) {
    const page = doc.pages.item(index);
    read(() => objectRef(page), "page"); read(() => page.bounds); read(() => page.side);
    read(() => objectRef(page.appliedMaster), "page-master");
    read(() => objectRef(page.appliedParentPage), "page-parent");
    const margins = page.marginPreferences;
    propertySnapshot(margins, "page-margins");
    for (const field of ["top", "bottom", "left", "right", "columnCount", "columnGutter", "columnDirection"]) read(() => margins[field], "margin-" + field);
    const guides = page.guides;
    const guideCount = guides ? guides.length : 0;
    read(() => guideCount, "page-guides");
    for (let guideIndex = 0; guideIndex < guideCount; guideIndex += 1) {
      const guide = guides.item(guideIndex);
      read(() => [guide.id, guide.orientation, guide.location, objectRef(guide.itemLayer)], "guide");
    }
  }

  for (let index = 0; index < doc.stories.length; index += 1) {
    const story = doc.stories.item(index);
    read(() => objectRef(story), "story"); read(() => story.contents, "story-contents");
    read(() => story.textContainers.length, "story-containers");
    const tables = story.tables;
    const tableCount = tables ? tables.length : 0;
    read(() => tableCount, "story-tables");
    for (let tableIndex = 0; tableIndex < tableCount; tableIndex += 1) {
      const table = tables.item(tableIndex);
      read(() => [table.id, table.rows.length, table.columns.length, objectRef(table.appliedTableStyle)], "table");
      const cells = table.cells;
      const cellCount = cells ? cells.length : 0;
      read(() => cellCount, "table-cells");
      for (let cellIndex = 0; cellIndex < cellCount; cellIndex += 1) {
        const cell = cells.item(cellIndex);
        read(() => [cell.id, cell.contents, objectRef(cell.appliedCellStyle), objectRef(cell.fillColor), cell.fillTint], "cell");
      }
    }
    const ranges = story.textStyleRanges;
    const rangeCount = ranges ? ranges.length : 0;
    read(() => rangeCount, "text-ranges");
    for (let rangeIndex = 0; rangeIndex < rangeCount; rangeIndex += 1) {
      const range = ranges.item(rangeIndex);
      read(() => [range.index, range.length, objectRef(range.appliedParagraphStyle), objectRef(range.appliedCharacterStyle), objectRef(range.appliedFont), range.fontStyle, range.pointSize, range.leading, range.tracking, range.kerningValue, objectRef(range.fillColor), range.fillTint, objectRef(range.strokeColor), range.strokeTint, range.strokeWeight, range.capitalization, range.position, range.horizontalScale, range.verticalScale, range.skew], "text-range");
    }
  }

  const allItems = doc.allPageItems;
  const allItemCount = allItems ? allItems.length : 0;
  read(() => allItemCount, "all-page-items");
  for (let index = 0; index < allItemCount; index += 1) {
    const item = allItems[index];
    read(() => objectRef(item), "item");
    for (const field of ["geometricBounds", "visibleBounds", "locked", "visible", "rotationAngle", "shearAngle", "horizontalScale", "verticalScale", "absoluteRotationAngle", "absoluteShearAngle", "absoluteHorizontalScale", "absoluteVerticalScale", "fillTint", "strokeTint", "strokeWeight", "label", "contentType"]) read(() => item[field], "item-" + field);
    read(() => objectRef(item.itemLayer), "item-layer"); read(() => objectRef(item.fillColor), "item-fill");
    read(() => objectRef(item.strokeColor), "item-stroke"); read(() => objectRef(item.strokeType), "item-stroke-type");
    read(() => objectRef(item.appliedObjectStyle), "item-style");
    read(() => item.transparencySettings.blendingSettings.opacity, "item-opacity");
    read(() => [item.textFramePreferences.textColumnCount, item.textFramePreferences.textColumnGutter, item.textFramePreferences.insetSpacing, item.textFramePreferences.verticalJustification, item.textFramePreferences.autoSizingType], "text-frame-preferences");
    const itemPaths = item.paths;
    const itemPathCount = itemPaths ? itemPaths.length : 0;
    read(() => itemPathCount, "item-paths");
    for (let pathIndex = 0; pathIndex < itemPathCount; pathIndex += 1) {
      const currentPath = itemPaths.item(pathIndex);
      read(() => [currentPath.pathType, currentPath.entirePath], "item-path");
    }
  }

  for (let index = 0; index < doc.links.length; index += 1) {
    const link = doc.links.item(index);
    read(() => [objectRef(link), link.status, link.linkType, link.filePath, link.size, link.editOriginal], "link");
  }
  for (const collectionName of ["swatches", "colors", "gradients"]) {
    const collection = doc[collectionName];
    const collectionCount = collection ? collection.length : 0;
    read(() => collectionCount, collectionName);
    for (let index = 0; index < collectionCount; index += 1) {
      const swatch = collection.item(index);
      read(() => [objectRef(swatch), swatch.colorValue, swatch.space, swatch.model, swatch.gradientType, swatch.gradientStops && swatch.gradientStops.length], "swatch-" + collectionName);
      propertySnapshot(swatch, "swatch");
      if (collectionName === "gradients") {
        const stops = swatch.gradientStops;
        const stopCount = stops ? stops.length : 0;
        for (let stopIndex = 0; stopIndex < stopCount; stopIndex += 1) {
          const stop = stops.item(stopIndex);
          read(() => [stop.id, stop.location, stop.midPoint, objectRef(stop.stopColor)], "gradient-stop");
        }
      }
    }
  }
  styleCollection(doc.paragraphStyles, ["basedOn", "nextStyle", "appliedFont", "fillColor", "strokeColor"]);
  styleCollection(doc.characterStyles, ["basedOn", "appliedFont", "fillColor", "strokeColor"]);
  styleCollection(doc.objectStyles, ["basedOn", "fillColor", "strokeColor"]);
  styleCollection(doc.tableStyles, ["basedOn"]);
  styleCollection(doc.cellStyles, ["basedOn", "fillColor"]);
  return first.toString(16).padStart(8, "0") + second.toString(16).padStart(8, "0");
}

"use strict";

const v = require("./validation");
const { CommandError } = v;
const { bytesToHex, resolveCryptoApi } = require("./security-crypto");
const sha256 = require("./vendor/js-sha256");

const REVISION_LABEL = "fr.pironjulien.indesign.mcp.revision";
const BACKUP_MAX_AGE_MS = 5 * 60 * 1000;
const RESTORE_MAX_AGE_MS = 30 * 60 * 1000;
const MAX_DYNAMIC_CODE_LENGTH = 2000000;
const cryptoApi = resolveCryptoApi();
const backups = new Map();
const freezeObject = Object.freeze.bind(Object);
const hasOwnProperty = Function.prototype.call.bind(Object.prototype.hasOwnProperty);

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

function advanceOpenDocumentStates(app) {
  const documentStates = [];
  let count = 0;
  try { count = app.documents.length; } catch (_) { return documentStates; }
  for (let index = 0; index < count; index += 1) {
    try {
      const doc = collectionItem(app.documents, index);
      if (!doc || doc.isValid === false) continue;
      const documentId = Number(doc.id);
      if (!Number.isSafeInteger(documentId) || documentId <= 0) continue;
      const nextRevision = getRevision(doc) + 1;
      const revisionWritten = setRevision(doc, nextRevision);
      const state = { documentId, revision: revisionWritten ? getRevision(doc) : nextRevision };
      if (!revisionWritten || state.revision !== nextRevision) state.revisionWriteFailed = true;
      try {
        const stateToken = documentStateToken(doc);
        if (/^[a-f0-9]{16}$/.test(stateToken)) state.stateToken = stateToken;
      } catch (_) {}
      documentStates.push(state);
    } catch (_) {
      // Une référence DOM devenue invalide reste couverte par requiresInspection.
    }
  }
  return documentStates;
}

function decorateDynamicExecutionError(error, app) {
  let decorated = error && (typeof error === "object" || typeof error === "function")
    ? error
    : new CommandError("INDESIGN_ERROR", String(error));
  const documentStates = advanceOpenDocumentStates(app);
  const priorDetails = decorated.details && typeof decorated.details === "object" && !Array.isArray(decorated.details)
    ? decorated.details
    : {};
  try {
    decorated.requiresInspection = true;
    decorated.documentStates = documentStates;
    decorated.details = Object.assign({}, priorDetails, { requiresInspection: true, documentStates });
  } catch (_) {
    const replacement = new CommandError(
      typeof decorated.code === "string" ? decorated.code : "INDESIGN_ERROR",
      decorated.message ? String(decorated.message) : "L'execution UXP a echoue",
      Object.assign({}, priorDetails, { requiresInspection: true, documentStates })
    );
    replacement.requiresInspection = true;
    replacement.documentStates = documentStates;
    replacement.indesignDynamicExecution = true;
    decorated = replacement;
  }
  return decorated;
}

function snapshotOpenDocumentRevisions(app) {
  const revisions = new Map();
  let count = 0;
  try { count = app.documents.length; } catch (_) { return revisions; }
  for (let index = 0; index < count; index += 1) {
    try {
      const doc = collectionItem(app.documents, index);
      if (!doc || doc.isValid === false) continue;
      const documentId = Number(doc.id);
      if (Number.isSafeInteger(documentId) && documentId > 0) revisions.set(documentId, getRevision(doc));
    } catch (_) {}
  }
  return revisions;
}

function protectedPostDocumentStates(app, context, command) {
  const documentStates = [];
  const before = context.documentRevisionsBeforeHandler instanceof Map
    ? context.documentRevisionsBeforeHandler
    : new Map();
  let count = 0;
  try { count = app.documents.length; } catch (_) { return documentStates; }
  for (let index = 0; index < count; index += 1) {
    try {
      const doc = collectionItem(app.documents, index);
      if (!doc || doc.isValid === false) continue;
      const documentId = Number(doc.id);
      if (!Number.isSafeInteger(documentId) || documentId <= 0) continue;
      let currentRevision = getRevision(doc);
      const isTarget = documentId === context.documentId;
      const isReplacementCandidate = command.replacesDocument && !before.has(documentId);
      if (isTarget || isReplacementCandidate) {
        const baseline = before.has(documentId) ? before.get(documentId) : context.revision;
        const minimumRevision = (Number.isInteger(baseline) && baseline >= 0 ? baseline : currentRevision) + 1;
        if (currentRevision < minimumRevision) {
          const revisionWritten = setRevision(doc, minimumRevision);
          currentRevision = revisionWritten ? getRevision(doc) : minimumRevision;
          if (!revisionWritten || currentRevision !== minimumRevision) {
            const failedState = { documentId, revision: currentRevision, revisionWriteFailed: true };
            try { failedState.stateToken = documentStateToken(doc); } catch (_) {}
            documentStates.push(failedState);
            continue;
          }
        }
      }
      const state = { documentId, revision: currentRevision };
      try {
        const stateToken = documentStateToken(doc);
        if (/^[a-f0-9]{16}$/.test(stateToken)) state.stateToken = stateToken;
      } catch (_) {}
      documentStates.push(state);
    } catch (_) {
      // L'inventaire partiel reste explicitement soumis à inspection.
    }
  }
  return documentStates;
}

function decorateProtectedExecutionError(error, app, context, command) {
  let decorated = error && (typeof error === "object" || typeof error === "function")
    ? error
    : new CommandError("INDESIGN_ERROR", String(error));
  const documentStates = protectedPostDocumentStates(app, context, command);
  const priorDetails = decorated.details && typeof decorated.details === "object" && !Array.isArray(decorated.details)
    ? decorated.details
    : {};
  try {
    decorated.requiresInspection = true;
    decorated.documentStates = documentStates;
    decorated.details = Object.assign({}, priorDetails, { requiresInspection: true, documentStates });
  } catch (_) {
    const replacement = new CommandError(
      typeof decorated.code === "string" ? decorated.code : "INDESIGN_ERROR",
      decorated.message ? String(decorated.message) : "La commande InDesign protegee a echoue",
      Object.assign({}, priorDetails, { requiresInspection: true, documentStates })
    );
    replacement.requiresInspection = true;
    replacement.documentStates = documentStates;
    decorated = replacement;
  }
  return decorated;
}

function safeValue(value, depth, seen) {
  const currentDepth = depth || 0;
  const visited = seen || new Set();
  if (value === null || value === undefined) return null;
  if (["string", "number", "boolean"].includes(typeof value)) {
    if (typeof value === "string" && value.length > 200000) return value.slice(0, 200000);
    return value;
  }
  if (currentDepth >= 8) return "[profondeur limitee]";
  if (Array.isArray(value)) {
    return value.slice(0, 5000).map((entry) => safeValue(entry, currentDepth + 1, visited));
  }
  if (typeof value === "object") {
    if (visited.has(value)) return "[reference circulaire]";
    visited.add(value);
    const result = {};
    const keys = Object.keys(value).slice(0, 500);
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      if (["__proto__", "prototype", "constructor"].includes(key)) continue;
      try { result[key] = safeValue(value[key], currentDepth + 1, visited); } catch (_) { result[key] = null; }
    }
    visited.delete(value);
    return result;
  }
  return String(value);
}

function collectionItem(collection, index) {
  return collection && typeof collection.item === "function" ? collection.item(index) : collection[index];
}

function resolveDocumentById(app, documentId) {
  const wanted = v.id(documentId, "documentId");
  const documents = app && app.documents;
  if (!documents || typeof documents.itemByID !== "function") {
    throw new CommandError(
      "DOCUMENT_RESOLUTION_UNAVAILABLE",
      "La résolution DOM officielle itemByID est indisponible",
      { documentId: wanted }
    );
  }

  let doc = null;
  try {
    const specifier = documents.itemByID(wanted);
    if (!specifier || typeof specifier.getElements !== "function") {
      throw new CommandError("DOCUMENT_RESOLUTION_FAILED", "Le document cible ne fournit pas de résolution DOM officielle", { documentId: wanted });
    }
    const elements = specifier.getElements();
    doc = collectionItem(elements, 0);
  } catch (cause) {
    if (cause instanceof CommandError) throw cause;
    throw new CommandError("DOCUMENT_NOT_FOUND", "Document introuvable", {
      documentId: wanted,
      cause: String(cause && cause.message || cause)
    });
  }
  if (doc && doc.isValid !== false && Number(doc.id) === wanted) {
    return { document: doc, resolutionMethod: "itemByID.getElements" };
  }
  throw new CommandError("DOCUMENT_NOT_FOUND", "Document introuvable", { documentId: wanted });
}

function getDocumentById(app, documentId) {
  return resolveDocumentById(app, documentId).document;
}

function activeDocumentId(app) {
  try {
    const active = app && app.activeDocument;
    if (!active || active.isValid === false) return null;
    const id = Number(active.id);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch (_) {
    return null;
  }
}

async function waitForDocumentState(app, documentId, expectedOpen, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let document = null;
    try { document = getDocumentById(app, documentId); } catch (_) {}
    if (expectedOpen ? Boolean(document) : !document) return document;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new CommandError(
    expectedOpen ? "RESTORE_OPEN_NOT_CONFIRMED" : "RESTORE_CLOSE_NOT_CONFIRMED",
    expectedOpen ? "L'ouverture de la copie restauree n'a pas ete confirmee" : "La fermeture du document remplace n'a pas ete confirmee"
  );
}

function getOptionalDocument(app, documentId) {
  if (documentId !== undefined && documentId !== null) return getDocumentById(app, documentId);
  if (app.documents.length === 0) throw new CommandError("DOCUMENT_NOT_FOUND", "Aucun document ouvert");
  const doc = app.activeDocument || collectionItem(app.documents, 0);
  if (!doc || doc.isValid === false) throw new CommandError("DOCUMENT_NOT_FOUND", "Aucun document actif");
  return doc;
}

function getPageById(doc, pageId) {
  const wanted = v.id(pageId, "pageId");
  for (let i = 0; i < doc.pages.length; i += 1) {
    const page = collectionItem(doc.pages, i);
    if (page && page.isValid !== false && Number(page.id) === wanted) return page;
  }
  throw new CommandError("PAGE_NOT_FOUND", "Page introuvable");
}

function getPageItemById(doc, itemId) {
  const wanted = v.id(itemId, "pageItemId");
  const items = doc.allPageItems;
  for (let i = 0; i < items.length; i += 1) {
    const item = collectionItem(items, i);
    if (item && item.isValid !== false && Number(item.id) === wanted) return item;
  }
  throw new CommandError("PAGE_ITEM_NOT_FOUND", "Objet de page introuvable");
}

function getMasterById(doc, masterId) {
  const wanted = v.id(masterId, "masterSpreadId");
  for (let i = 0; i < doc.masterSpreads.length; i += 1) {
    const master = collectionItem(doc.masterSpreads, i);
    if (master && master.isValid !== false && Number(master.id) === wanted) return master;
  }
  throw new CommandError("MASTER_NOT_FOUND", "Gabarit introuvable");
}

function getRevision(doc) {
  try {
    const raw = doc.extractLabel(REVISION_LABEL);
    const revision = Number.parseInt(raw || "0", 10);
    return Number.isInteger(revision) && revision >= 0 ? revision : 0;
  } catch (_) {
    return 0;
  }
}

function setRevision(doc, revision) {
  try {
    doc.insertLabel(REVISION_LABEL, String(revision));
    return true;
  } catch (_) {
    return false;
  }
}

function itemType(item) {
  try { return item.constructorName || (item.constructor && item.constructor.name) || "PageItem"; } catch (_) { return "PageItem"; }
}

function numericArray(value) {
  if (!value || typeof value.length !== "number") return [];
  const result = [];
  for (let i = 0; i < value.length; i += 1) result.push(Number(value[i]));
  return result;
}

function pageItemSummary(item) {
  let pageId = null;
  let layerName = null;
  try { pageId = item.parentPage && item.parentPage.isValid !== false ? Number(item.parentPage.id) : null; } catch (_) {}
  try { layerName = item.itemLayer && item.itemLayer.isValid !== false ? item.itemLayer.name : null; } catch (_) {}
  return {
    id: Number(item.id),
    type: itemType(item),
    name: typeof item.name === "string" ? item.name : "",
    pageId,
    layerName,
    bounds: numericArray(item.geometricBounds),
    locked: Boolean(item.locked),
    visible: item.visible !== false,
    nonprinting: Boolean(item.nonprinting)
  };
}

function namedReference(value) {
  try {
    if (!value || value.isValid === false) return null;
    return { id: Number.isFinite(Number(value.id)) ? Number(value.id) : null, name: typeof value.name === "string" ? value.name : String(value.name || "") };
  } catch (_) {
    return null;
  }
}

function enumSummary(value, enumeration) {
  let numeric = null;
  let name = "";
  try { if (Number.isFinite(Number(value))) numeric = Number(value); } catch (_) {}
  try { name = String(value); } catch (_) {}
  if (enumeration && typeof enumeration === "object") {
    try {
      const keys = Object.keys(enumeration);
      for (let i = 0; i < keys.length; i += 1) {
        if (enumeration[keys[i]] === value || Number(enumeration[keys[i]]) === numeric) { name = keys[i]; break; }
      }
    } catch (_) {}
  }
  return { value: numeric, name };
}

function styleSummary(style, kind) {
  const result = {
    id: Number.isFinite(Number(style.id)) ? Number(style.id) : null,
    name: typeof style.name === "string" ? style.name : "",
    basedOn: null
  };
  try { result.basedOn = namedReference(style.basedOn); } catch (_) {}
  if (kind === "paragraph" || kind === "character") {
    try { result.fontFamily = style.appliedFont && (style.appliedFont.fontFamily || style.appliedFont.name) || null; } catch (_) { result.fontFamily = null; }
    try { result.fontStyle = style.fontStyle || null; } catch (_) { result.fontStyle = null; }
    try { result.pointSize = Number.isFinite(Number(style.pointSize)) ? Number(style.pointSize) : null; } catch (_) { result.pointSize = null; }
    try { result.leading = Number.isFinite(Number(style.leading)) ? Number(style.leading) : null; } catch (_) { result.leading = null; }
    try { result.fillColor = namedReference(style.fillColor); } catch (_) { result.fillColor = null; }
    try { result.justification = enumSummary(style.justification); } catch (_) { result.justification = { value: null, name: "" }; }
    try { result.tracking = Number.isFinite(Number(style.tracking)) ? Number(style.tracking) : null; } catch (_) { result.tracking = null; }
  } else if (kind === "object") {
    try { result.fillColor = namedReference(style.fillColor); } catch (_) { result.fillColor = null; }
    try { result.strokeColor = namedReference(style.strokeColor); } catch (_) { result.strokeColor = null; }
    try { result.strokeWeight = Number.isFinite(Number(style.strokeWeight)) ? Number(style.strokeWeight) : null; } catch (_) { result.strokeWeight = null; }
    try { result.textWrapMode = enumSummary(style.textWrapPreferences.textWrapMode); } catch (_) { result.textWrapMode = { value: null, name: "" }; }
  }
  return result;
}

function collectionSummary(collection, mapper) {
  const output = [];
  if (!collection) return output;
  for (let i = 0; i < collection.length; i += 1) {
    try { output.push(mapper(collectionItem(collection, i), i)); } catch (_) {}
  }
  return output;
}

function normalizeNativeFilePath(value) {
  if (typeof value !== "string") return null;
  let candidate = value.trim();
  if (!candidate || candidate === "[object Object]" || candidate.indexOf("\0") !== -1) return null;

  if (/^file:/i.test(candidate)) {
    try { candidate = decodeURIComponent(candidate); } catch (_) { return null; }
    const unc = candidate.match(/^file:\/\/([^/]+)(\/.*)$/i);
    if (unc && unc[1].toLowerCase() !== "localhost") {
      candidate = "\\\\" + unc[1] + unc[2].replace(/\//g, "\\");
    } else {
      candidate = candidate.replace(/^file:\/\/localhost\/?/i, "");
      candidate = candidate.replace(/^file:\/\//i, "");
      if (/^\/[A-Za-z]:/.test(candidate)) candidate = candidate.slice(1);
      candidate = candidate.replace(/\//g, "\\");
    }
  }
  return candidate;
}

async function fileLikePath(fileLike) {
  let resolved;
  try { resolved = await fileLike; } catch (_) { return null; }
  if (!resolved) return null;
  if (typeof resolved === "string") return normalizeNativeFilePath(resolved);
  for (const property of ["nativePath", "fsName", "url"]) {
    try {
      const candidate = normalizeNativeFilePath(await resolved[property]);
      if (candidate) return candidate;
    } catch (_) {}
  }
  try { return normalizeNativeFilePath(String(resolved)); } catch (_) { return null; }
}

function ensureFileName(candidate, documentName) {
  if (!candidate || !documentName) return candidate;
  const normalized = candidate.replace(/\//g, "\\");
  const lastPart = normalized.slice(normalized.lastIndexOf("\\") + 1);
  if (lastPart.toLowerCase() === documentName.toLowerCase()) return normalized;
  return normalized.replace(/[\\/]+$/, "") + "\\" + documentName;
}

async function nativePath(doc) {
  let documentName = null;
  try { documentName = typeof doc.name === "string" ? doc.name : null; } catch (_) {}

  // fullName est la propriété DOM autoritative : elle inclut explicitement le
  // nom du fichier, y compris après l'ouverture d'une sauvegarde saveACopy.
  try {
    const fullName = await fileLikePath(doc.fullName);
    if (fullName) return ensureFileName(fullName, documentName);
  } catch (_) {}

  // Repli pour les hôtes/états non enregistrés où fullName est indisponible.
  // Certaines versions renvoient ici un dossier : le nom est alors réattaché.
  try {
    const filePath = await fileLikePath(doc.filePath);
    return ensureFileName(filePath, documentName);
  } catch (_) {
    return null;
  }
}

async function withMillimeterUnits(doc, indesign, callback) {
  const prefs = doc.viewPreferences;
  const horizontal = prefs.horizontalMeasurementUnits;
  const vertical = prefs.verticalMeasurementUnits;
  try {
    prefs.horizontalMeasurementUnits = indesign.MeasurementUnits.millimeters;
    prefs.verticalMeasurementUnits = indesign.MeasurementUnits.millimeters;
    return await callback();
  } finally {
    try { prefs.horizontalMeasurementUnits = horizontal; } catch (_) {}
    try { prefs.verticalMeasurementUnits = vertical; } catch (_) {}
  }
}

function assertStyleDoesNotExist(collection, name, type) {
  try {
    const existing = collection.itemByName(name);
    if (existing && existing.isValid) throw new CommandError("ALREADY_EXISTS", type + " existe deja");
  } catch (error) {
    if (error instanceof CommandError) throw error;
  }
}

function applyItemColors(doc, item, args) {
  if (args.fillColor !== undefined) {
    const fill = doc.swatches.itemByName(v.string(args.fillColor, "fillColor", { max: 200 }));
    if (!fill || !fill.isValid) throw new CommandError("SWATCH_NOT_FOUND", "Nuance de fond introuvable");
    item.fillColor = fill;
  }
  if (args.strokeColor !== undefined) {
    const stroke = doc.swatches.itemByName(v.string(args.strokeColor, "strokeColor", { max: 200 }));
    if (!stroke || !stroke.isValid) throw new CommandError("SWATCH_NOT_FOUND", "Nuance de contour introuvable");
    item.strokeColor = stroke;
  }
  if (args.strokeWeight !== undefined) item.strokeWeight = v.number(args.strokeWeight, "strokeWeight", { min: 0, max: 1000 });
}

function cleanBackups() {
  const threshold = Date.now() - RESTORE_MAX_AGE_MS;
  for (const [id, backup] of backups.entries()) {
    if (backup.createdAtMs < threshold) backups.delete(id);
  }
}

function consumeSafetyBackup(args, documentId, revision, commandName) {
  cleanBackups();
  const backupId = v.string(args.backupId, "backupId", { min: 36, max: 64, pattern: /^[a-f0-9]+$/ });
  const reason = v.string(args.reason, "reason", { min: 5, max: 500 });
  const backup = backups.get(backupId);
  if (!backup) throw new CommandError("BACKUP_NOT_FOUND", "Sauvegarde de securite introuvable");
  if (backup.consumedAt) throw new CommandError("BACKUP_ALREADY_USED", "La sauvegarde a deja autorise une operation");
  if (Date.now() - backup.createdAtMs > BACKUP_MAX_AGE_MS) throw new CommandError("BACKUP_EXPIRED", "La sauvegarde n'est plus assez recente");
  if (backup.documentId !== documentId || backup.revision !== revision) {
    throw new CommandError("BACKUP_MISMATCH", "La sauvegarde ne correspond pas a l'etat du document");
  }
  if (backup.toolName !== commandName || backup.reason !== reason) {
    throw new CommandError("BACKUP_MISMATCH", "La sauvegarde n'autorise pas cette operation");
  }
  backup.consumedAt = new Date().toISOString();
  return backup;
}

function parsePageRange(pageRange, pageCount) {
  const value = v.string(pageRange || "all", "pageRange", { min: 1, max: 128 }).toLowerCase();
  if (value === "all") return Array.from({ length: pageCount }, (_, index) => index);
  const selected = new Set();
  const parts = value.split(",");
  for (let i = 0; i < parts.length; i += 1) {
    const token = parts[i].trim();
    const match = /^(\d+)(?:-(\d+))?$/.exec(token);
    if (!match) throw new CommandError("INVALID_PAGE_RANGE", "Plage de pages invalide");
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    if (start < 1 || end < start || end > pageCount) throw new CommandError("INVALID_PAGE_RANGE", "Plage de pages hors limites");
    for (let page = start; page <= end; page += 1) selected.add(page - 1);
  }
  return Array.from(selected).sort((left, right) => left - right);
}

function normalizePngExportTarget(args) {
  const pageId = v.optionalId(args.pageId, "pageId");
  const hasFilePath = args.filePath !== undefined && args.filePath !== null;
  const hasFolderPath = args.folderPath !== undefined && args.folderPath !== null;
  if (pageId !== undefined) {
    if (!hasFilePath || hasFolderPath || args.pageRange !== undefined) {
      throw new CommandError("INVALID_ARGS", "Une page exige uniquement pageId et filePath");
    }
    return {
      pageId,
      filePath: v.absolutePath(args.filePath, "filePath", [".png"]),
      folderPath: null
    };
  }
  if (!hasFolderPath || hasFilePath) {
    throw new CommandError("INVALID_ARGS", "Un export multipage exige uniquement folderPath");
  }
  return {
    pageId: undefined,
    filePath: null,
    folderPath: v.absolutePath(args.folderPath, "folderPath")
  };
}

function randomId() {
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== "function") {
    throw new CommandError("CRYPTO_UNAVAILABLE", "Web Crypto est indisponible dans cette version UXP");
  }
  const bytes = new Uint8Array(18);
  cryptoApi.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function definition(handler, options) {
  return Object.assign({ handler, requiresDocumentId: false, contentMutation: false, requireExpectedRevision: false, requiresBackup: false, replacesDocument: false }, options || {});
}

function createCommandRegistry(app, indesign, uxpModule, moduleRequire) {
  const commands = Object.create(null);

  commands.ping = definition(async () => ({
    success: true,
    pluginVersion: "3.2.2",
    hostName: String((uxpModule && uxpModule.host && uxpModule.host.name) || app.name || "InDesign"),
    hostVersion: String((uxpModule && uxpModule.host && uxpModule.host.version) || app.version || "unknown"),
    uxpVersion: String((uxpModule && uxpModule.versions && uxpModule.versions.uxp) || "unknown"),
    domVersion: String((app.scriptPreferences && app.scriptPreferences.version) || "unknown"),
    locale: String((uxpModule && uxpModule.host && uxpModule.host.uiLocale) || app.locale || "unknown"),
    openDocuments: app.documents.length
  }));

  commands.list_documents = definition(async () => {
    const documents = [];
    for (let i = 0; i < app.documents.length; i += 1) {
      const doc = collectionItem(app.documents, i);
      documents.push({
        id: Number(doc.id),
        documentId: Number(doc.id),
        name: doc.name,
        path: await nativePath(doc),
        pages: doc.pages.length,
        modified: Boolean(doc.modified),
        revision: getRevision(doc),
        active: app.activeDocument && Number(app.activeDocument.id) === Number(doc.id)
      });
    }
    return { success: true, documents };
  });

  commands.get_document_info = definition(async (args, context) => withMillimeterUnits(context.doc, indesign, async () => ({
    success: true,
    documentId: Number(context.doc.id),
    document: {
      id: Number(context.doc.id),
      name: context.doc.name,
      path: await nativePath(context.doc),
      pages: context.doc.pages.length,
      spreads: context.doc.spreads.length,
      layers: context.doc.layers.length,
      masterSpreads: context.doc.masterSpreads.length,
      widthMm: Number(context.doc.documentPreferences.pageWidth),
      heightMm: Number(context.doc.documentPreferences.pageHeight),
      facingPages: Boolean(context.doc.documentPreferences.facingPages),
      modified: Boolean(context.doc.modified)
    }
  })), { documentOptional: true });

  commands.create_document = definition(async (args) => {
    const units = v.oneOf(args.units, "units", ["mm", "pt"], "mm");
    const toMillimeters = (value) => units === "pt" ? value * 25.4 / 72 : value;
    const width = toMillimeters(v.optionalNumber(args.width !== undefined ? args.width : args.widthMm, "width", { min: 1, max: 10000 }) || 210);
    const height = toMillimeters(v.optionalNumber(args.height !== undefined ? args.height : args.heightMm, "height", { min: 1, max: 10000 }) || 297);
    const pageCount = v.optionalNumber(args.pageCount !== undefined ? args.pageCount : args.pages, "pageCount", { integer: true, min: 1, max: 10000 }) || 1;
    const facingPages = v.boolean(args.facingPages, "facingPages", true);
    let bleed = [0, 0, 0, 0];
    if (args.bleed !== undefined) {
      v.assert(Array.isArray(args.bleed) && args.bleed.length === 4, "INVALID_ARGS", "bleed doit contenir quatre valeurs");
      bleed = args.bleed.map((entry, index) => toMillimeters(v.number(entry, "bleed[" + index + "]", { min: 0, max: 1000 })));
    } else if (args.bleedMm !== undefined) {
      const uniform = v.number(args.bleedMm, "bleedMm", { min: 0, max: 100 });
      bleed = [uniform, uniform, uniform, uniform];
    }
    let margins = [12, 12, 12, 12];
    const rawMargins = args.margins !== undefined ? args.margins : args.marginsMm;
    if (rawMargins !== undefined) {
      v.assert(Array.isArray(rawMargins) && rawMargins.length === 4, "INVALID_ARGS", "margins doit contenir [haut, gauche, bas, droite]");
      margins = rawMargins.map((entry, index) => toMillimeters(v.number(entry, "margins[" + index + "]", { min: 0, max: 1000 })));
    }
    const doc = app.documents.add();
    await withMillimeterUnits(doc, indesign, async () => {
      doc.documentPreferences.pageWidth = width;
      doc.documentPreferences.pageHeight = height;
      doc.documentPreferences.facingPages = facingPages;
      doc.documentPreferences.documentBleedTopOffset = bleed[0];
      doc.documentPreferences.documentBleedInsideOrLeftOffset = bleed[1];
      doc.documentPreferences.documentBleedBottomOffset = bleed[2];
      doc.documentPreferences.documentBleedOutsideOrRightOffset = bleed[3];
      const firstPage = collectionItem(doc.pages, 0);
      firstPage.marginPreferences.top = margins[0];
      firstPage.marginPreferences.left = margins[1];
      firstPage.marginPreferences.bottom = margins[2];
      firstPage.marginPreferences.right = margins[3];
      for (let i = 1; i < pageCount; i += 1) doc.pages.add();
    });
    setRevision(doc, 0);
    return { success: true, documentId: Number(doc.id), name: doc.name, revision: 0, stateToken: documentStateToken(doc) };
  });

  commands.open_document = definition(async (args) => {
    const filePath = v.absolutePath(args.path !== undefined ? args.path : args.filePath, "path", [".indd", ".idml", ".indt"]);
    const doc = await app.open(filePath, true);
    const revision = getRevision(doc);
    return { success: true, documentId: Number(doc.id), name: doc.name, revision, stateToken: documentStateToken(doc) };
  });

  commands.save_document = definition(async (args, context) => {
    const path = await nativePath(context.doc);
    if (!path) throw new CommandError("SAVE_AS_REQUIRED", "Le document doit d'abord etre enregistre avec save_as");
    await context.doc.save();
    return { success: true };
  }, { requiresDocumentId: true, requireExpectedRevision: true, requiresBackup: true });

  commands.save_as = definition(async (args, context) => {
    const filePath = v.absolutePath(args.path !== undefined ? args.path : args.filePath, "path", [".indd"]);
    await context.doc.save(filePath);
    return { success: true, path: filePath };
  }, { requiresDocumentId: true, contentMutation: true, requireExpectedRevision: true, requiresBackup: true });

  commands.close_document = definition(async (args, context) => {
    const save = typeof args.save === "boolean" ? (args.save ? "save" : "discard") : v.oneOf(args.save, "save", ["save", "discard"], "save");
    if (save === "save" && !(await nativePath(context.doc))) {
      throw new CommandError("SAVE_AS_REQUIRED", "Le document non enregistre ne peut pas etre ferme avec sauvegarde");
    }
    await context.doc.close(save === "save" ? indesign.SaveOptions.yes : indesign.SaveOptions.no);
    return { success: true, closedDocumentId: context.documentId };
  }, { requiresDocumentId: true, requireExpectedRevision: true, requiresBackup: true });

  commands.list_pages = definition(async (args, context) => withMillimeterUnits(context.doc, indesign, async () => {
    const pages = [];
    for (let i = 0; i < context.doc.pages.length; i += 1) {
      const page = collectionItem(context.doc.pages, i);
      let master = null;
      try { master = page.appliedMaster && page.appliedMaster.isValid !== false ? { id: Number(page.appliedMaster.id), name: page.appliedMaster.name } : null; } catch (_) {}
      pages.push({ id: Number(page.id), pageId: Number(page.id), index: i, name: page.name, bounds: numericArray(page.bounds), appliedMaster: master });
    }
    return { success: true, pages };
  }), { documentOptional: true });

  commands.add_pages = definition(async (args, context) => {
    const count = v.number(args.count, "count", { integer: true, min: 1, max: 500 });
    const afterPageId = v.optionalId(args.afterPageId, "afterPageId");
    let reference = afterPageId ? getPageById(context.doc, afterPageId) : collectionItem(context.doc.pages, context.doc.pages.length - 1);
    const ids = [];
    for (let i = 0; i < count; i += 1) {
      const page = context.doc.pages.add(indesign.LocationOptions.after, reference);
      ids.push(Number(page.id));
      reference = page;
    }
    return { success: true, pageIds: ids };
  }, { requiresDocumentId: true, contentMutation: true, requireExpectedRevision: true, requiresBackup: true });

  commands.get_page_content_summary = definition(async (args, context) => {
    const page = getPageById(context.doc, v.id(args.pageId, "pageId"));
    let oversetFrames = 0;
    for (let i = 0; i < page.textFrames.length; i += 1) if (collectionItem(page.textFrames, i).overflows) oversetFrames += 1;
    return {
      success: true,
      pageId: Number(page.id),
      counts: {
        pageItems: page.allPageItems ? page.allPageItems.length : 0,
        textFrames: page.textFrames.length,
        rectangles: page.rectangles.length,
        ovals: page.ovals.length,
        polygons: page.polygons.length,
        graphics: page.allGraphics ? page.allGraphics.length : 0,
        oversetFrames
      }
    };
  }, { documentOptional: true });

  commands.list_page_items = definition(async (args, context) => withMillimeterUnits(context.doc, indesign, async () => {
    const page = getPageById(context.doc, v.id(args.pageId, "pageId"));
    const items = [];
    const all = page.allPageItems;
    for (let i = 0; i < all.length; i += 1) {
      const summary = pageItemSummary(collectionItem(all, i));
      summary.itemId = summary.id;
      items.push(summary);
    }
    return { success: true, pageId: Number(page.id), items };
  }), { documentOptional: true });

  commands.get_links = definition(async (args, context) => {
    const links = [];
    for (let i = 0; i < context.doc.links.length; i += 1) {
      const link = collectionItem(context.doc.links, i);
      let pageItemId = null;
      try { pageItemId = Number(link.parent.parent.id); } catch (_) {}
      links.push({ id: Number(link.id), name: link.name, path: link.filePath || null, status: Number(link.status), pageItemId });
    }
    return { success: true, links };
  }, { documentOptional: true });

  commands.get_fonts = definition(async (args, context) => {
    const fonts = [];
    for (let i = 0; i < context.doc.fonts.length; i += 1) {
      const font = collectionItem(context.doc.fonts, i);
      fonts.push({ name: font.name, family: font.fontFamily || null, style: font.fontStyleName || null, status: Number(font.status) });
    }
    return { success: true, fonts };
  }, { documentOptional: true });

  commands.get_overset_text = definition(async (args, context) => {
    const frames = [];
    for (let i = 0; i < context.doc.textFrames.length; i += 1) {
      const frame = collectionItem(context.doc.textFrames, i);
      if (frame.overflows) {
        const summary = pageItemSummary(frame);
        summary.storyId = frame.parentStory ? Number(frame.parentStory.id) : null;
        frames.push(summary);
      }
    }
    return { success: true, count: frames.length, frames };
  }, { documentOptional: true });

  commands.get_images = definition(async (args, context) => withMillimeterUnits(context.doc, indesign, async () => {
    const images = [];
    const graphics = context.doc.allGraphics;
    for (let i = 0; i < graphics.length; i += 1) {
      const graphic = collectionItem(graphics, i);
      const frame = graphic.parent;
      let link = null;
      try {
        if (graphic.itemLink && graphic.itemLink.isValid) {
          link = { id: Number(graphic.itemLink.id), name: graphic.itemLink.name, path: graphic.itemLink.filePath || null, status: Number(graphic.itemLink.status) };
        }
      } catch (_) {}
      images.push({
        id: Number(graphic.id),
        type: itemType(graphic),
        frameId: frame && frame.isValid !== false ? Number(frame.id) : null,
        pageId: frame && frame.parentPage ? Number(frame.parentPage.id) : null,
        bounds: frame ? numericArray(frame.geometricBounds) : [],
        actualPpi: numericArray(graphic.actualPpi),
        effectivePpi: numericArray(graphic.effectivePpi),
        link
      });
    }
    return { success: true, images };
  }), { documentOptional: true });

  commands.analyze_layout = definition(async (args, context) => withMillimeterUnits(context.doc, indesign, async () => {
    const maxItems = v.optionalNumber(args.maxItems, "maxItems", { integer: true, min: 1, max: 50000 }) || 20000;
    const doc = context.doc;
    const preferences = doc.documentPreferences;
    const pages = [];
    const pageIndexes = Object.create(null);
    for (let i = 0; i < doc.pages.length; i += 1) {
      const page = collectionItem(doc.pages, i);
      const bounds = numericArray(page.bounds);
      pageIndexes[String(Number(page.id))] = i;
      const margins = page.marginPreferences;
      pages.push({
        id: Number(page.id),
        index: i,
        name: String(page.name),
        bounds,
        widthMm: bounds.length === 4 ? Math.abs(bounds[3] - bounds[1]) : Number(preferences.pageWidth),
        heightMm: bounds.length === 4 ? Math.abs(bounds[2] - bounds[0]) : Number(preferences.pageHeight),
        margins: {
          top: Number(margins.top),
          left: Number(margins.left),
          bottom: Number(margins.bottom),
          right: Number(margins.right)
        },
        columns: { count: Number(margins.columnCount), gutterMm: Number(margins.columnGutter) },
        appliedMaster: namedReference(page.appliedMaster)
      });
    }

    const allItems = doc.allPageItems;
    const totalItems = allItems.length;
    const inspectedItems = Math.min(totalItems, maxItems);
    const items = [];
    for (let i = 0; i < inspectedItems; i += 1) {
      const item = collectionItem(allItems, i);
      const summary = pageItemSummary(item);
      summary.pageIndex = summary.pageId === null ? null : (pageIndexes[String(summary.pageId)] ?? null);
      summary.objectStyle = namedReference(item.appliedObjectStyle);
      summary.widthMm = summary.bounds.length === 4 ? Math.abs(summary.bounds[3] - summary.bounds[1]) : null;
      summary.heightMm = summary.bounds.length === 4 ? Math.abs(summary.bounds[2] - summary.bounds[0]) : null;
      try { summary.overflows = Boolean(item.overflows); } catch (_) { summary.overflows = false; }
      items.push(summary);
    }

    const links = collectionSummary(doc.links, (link) => {
      let pageItemId = null;
      let pageId = null;
      try { pageItemId = Number(link.parent.parent.id); } catch (_) {}
      try { pageId = Number(link.parent.parent.parentPage.id); } catch (_) {}
      const status = enumSummary(link.status, indesign.LinkStatus);
      return { id: Number(link.id), name: String(link.name || ""), path: link.filePath || null, status: status.value, statusName: status.name, pageItemId, pageId };
    });
    const fonts = collectionSummary(doc.fonts, (font) => {
      const status = enumSummary(font.status, indesign.FontStatus);
      return { name: String(font.name || ""), family: font.fontFamily || null, style: font.fontStyleName || null, status: status.value, statusName: status.name };
    });
    const images = collectionSummary(doc.allGraphics, (graphic) => {
      const frame = graphic.parent;
      let link = null;
      try { link = graphic.itemLink && graphic.itemLink.isValid ? namedReference(graphic.itemLink) : null; } catch (_) {}
      let pageId = null;
      try { pageId = frame.parentPage && frame.parentPage.isValid !== false ? Number(frame.parentPage.id) : null; } catch (_) {}
      return {
        id: Number(graphic.id),
        type: itemType(graphic),
        frameId: frame && frame.isValid !== false ? Number(frame.id) : null,
        pageId,
        bounds: frame ? numericArray(frame.geometricBounds) : [],
        actualPpi: numericArray(graphic.actualPpi),
        effectivePpi: numericArray(graphic.effectivePpi),
        link
      };
    });

    const swatches = collectionSummary(doc.swatches, (swatch) => {
      let colorValue = null;
      let space = { value: null, name: "" };
      let model = { value: null, name: "" };
      try { colorValue = numericArray(swatch.colorValue); } catch (_) {}
      try { space = enumSummary(swatch.space); } catch (_) {}
      try { model = enumSummary(swatch.model); } catch (_) {}
      return { id: Number.isFinite(Number(swatch.id)) ? Number(swatch.id) : null, name: String(swatch.name || ""), colorValue, space, model };
    });
    const layers = collectionSummary(doc.layers, (layer, index) => ({
      id: Number(layer.id), name: String(layer.name || ""), index, visible: layer.visible !== false,
      locked: Boolean(layer.locked), printable: layer.printable !== false
    }));
    const paragraphStyles = collectionSummary(doc.paragraphStyles, (style) => styleSummary(style, "paragraph"));
    const characterStyles = collectionSummary(doc.characterStyles, (style) => styleSummary(style, "character"));
    const objectStyles = collectionSummary(doc.objectStyles, (style) => styleSummary(style, "object"));

    return {
      success: true,
      documentId: Number(doc.id),
      revision: getRevision(doc),
      capturedAt: new Date().toISOString(),
      document: {
        id: Number(doc.id), name: String(doc.name), path: await nativePath(doc), modified: Boolean(doc.modified),
        pageCount: doc.pages.length, spreadCount: doc.spreads.length, facingPages: Boolean(preferences.facingPages),
        widthMm: Number(preferences.pageWidth), heightMm: Number(preferences.pageHeight),
        bleedMm: {
          top: Number(preferences.documentBleedTopOffset),
          inside: Number(preferences.documentBleedInsideOrLeftOffset),
          bottom: Number(preferences.documentBleedBottomOffset),
          outside: Number(preferences.documentBleedOutsideOrRightOffset)
        }
      },
      pages,
      items,
      links,
      fonts,
      images,
      designSystem: { layers, swatches, paragraphStyles, characterStyles, objectStyles },
      totalItems,
      truncated: totalItems > inspectedItems
    };
  }), { requiresDocumentId: true });

  commands.create_layer = definition(async (args, context) => {
    const name = v.string(args.name, "name", { max: 200 });
    try {
      const existing = context.doc.layers.itemByName(name);
      if (existing && existing.isValid) throw new CommandError("ALREADY_EXISTS", "Le calque existe deja");
    } catch (error) {
      if (error instanceof CommandError) throw error;
    }
    const layer = context.doc.layers.add({ name });
    if (args.visible !== undefined) layer.visible = v.boolean(args.visible, "visible");
    if (args.locked !== undefined) layer.locked = v.boolean(args.locked, "locked");
    if (args.printable !== undefined) layer.printable = v.boolean(args.printable, "printable");
    return { success: true, layer: { id: Number(layer.id), name: layer.name } };
  }, { requiresDocumentId: true, contentMutation: true, requireExpectedRevision: true, requiresBackup: true });

  commands.create_color_swatch = definition(async (args, context) => {
    const name = v.string(args.name, "name", { max: 200 });
    const space = v.oneOf(args.colorSpace !== undefined ? args.colorSpace : args.space, "colorSpace", ["CMYK", "RGB", "LAB"], "CMYK");
    const expectedLength = space === "CMYK" ? 4 : 3;
    v.assert(Array.isArray(args.values) && args.values.length === expectedLength, "INVALID_ARGS", "values a une taille invalide");
    const values = args.values.map((entry, index) => {
      if (space === "CMYK") return v.number(entry, "values[" + index + "]", { min: 0, max: 100 });
      if (space === "RGB") return v.number(entry, "values[" + index + "]", { min: 0, max: 255 });
      return v.number(entry, "values[" + index + "]", { min: index === 0 ? 0 : -128, max: index === 0 ? 100 : 127 });
    });
    let color = context.doc.colors.itemByName(name);
    if (!color || !color.isValid) color = context.doc.colors.add({ name });
    color.model = indesign.ColorModel.process;
    color.space = space === "CMYK" ? indesign.ColorSpace.cmyk : (space === "RGB" ? indesign.ColorSpace.rgb : indesign.ColorSpace.lab);
    color.colorValue = values;
    return { success: true, swatch: { id: Number(color.id), name: color.name, space, values: numericArray(color.colorValue) } };
  }, { requiresDocumentId: true, contentMutation: true, requireExpectedRevision: true, requiresBackup: true });

  commands.create_paragraph_style = definition(async (args, context) => {
    const name = v.string(args.name, "name", { max: 200 });
    let style = context.doc.paragraphStyles.itemByName(name);
    if (!style || !style.isValid) style = context.doc.paragraphStyles.add({ name });
    if (args.basedOn !== undefined) {
      const base = context.doc.paragraphStyles.itemByName(v.string(args.basedOn, "basedOn", { max: 200 }));
      if (!base || !base.isValid) throw new CommandError("STYLE_NOT_FOUND", "Style de base introuvable");
      style.basedOn = base;
    }
    if (args.fontFamily !== undefined) style.appliedFont = v.string(args.fontFamily, "fontFamily", { max: 300 });
    if (args.fontStyle !== undefined) style.fontStyle = v.string(args.fontStyle, "fontStyle", { max: 200 });
    if (args.pointSize !== undefined) style.pointSize = v.number(args.pointSize, "pointSize", { min: 0.1, max: 2000 });
    if (args.leading !== undefined) style.leading = v.number(args.leading, "leading", { min: 0, max: 5000 });
    if (args.spaceBefore !== undefined) style.spaceBefore = v.number(args.spaceBefore, "spaceBefore", { min: -5000, max: 5000 });
    if (args.spaceAfter !== undefined) style.spaceAfter = v.number(args.spaceAfter, "spaceAfter", { min: -5000, max: 5000 });
    const paragraphColor = args.fillColorName !== undefined ? args.fillColorName : args.fillColor;
    if (paragraphColor !== undefined) {
      const color = context.doc.swatches.itemByName(v.string(paragraphColor, "fillColorName", { max: 200 }));
      if (!color || !color.isValid) throw new CommandError("SWATCH_NOT_FOUND", "Nuance de texte introuvable");
      style.fillColor = color;
    }
    if (args.justification !== undefined) {
      const alignment = v.oneOf(args.justification, "justification", ["left", "center", "right", "fullyJustified", "justify"]);
      const map = {
        left: indesign.Justification.leftAlign,
        center: indesign.Justification.centerAlign,
        right: indesign.Justification.rightAlign,
        fullyJustified: indesign.Justification.fullyJustified,
        justify: indesign.Justification.fullyJustified
      };
      style.justification = map[alignment];
    }
    if (args.hyphenation !== undefined) style.hyphenation = v.boolean(args.hyphenation, "hyphenation");
    return { success: true, style: { id: Number(style.id), name: style.name } };
  }, { requiresDocumentId: true, contentMutation: true, requireExpectedRevision: true, requiresBackup: true });

  commands.create_character_style = definition(async (args, context) => {
    const name = v.string(args.name, "name", { max: 200 });
    let style = context.doc.characterStyles.itemByName(name);
    if (!style || !style.isValid) style = context.doc.characterStyles.add({ name });
    if (args.basedOn !== undefined) {
      const base = context.doc.characterStyles.itemByName(v.string(args.basedOn, "basedOn", { max: 200 }));
      if (!base || !base.isValid) throw new CommandError("STYLE_NOT_FOUND", "Style de base introuvable");
      style.basedOn = base;
    }
    if (args.fontFamily !== undefined) style.appliedFont = v.string(args.fontFamily, "fontFamily", { max: 300 });
    if (args.fontStyle !== undefined) style.fontStyle = v.string(args.fontStyle, "fontStyle", { max: 200 });
    if (args.pointSize !== undefined) style.pointSize = v.number(args.pointSize, "pointSize", { min: 0.1, max: 2000 });
    if (args.tracking !== undefined) style.tracking = v.number(args.tracking, "tracking", { min: -1000, max: 10000 });
    if (args.underline !== undefined) style.underline = v.boolean(args.underline, "underline");
    const characterColor = args.fillColorName !== undefined ? args.fillColorName : args.fillColor;
    if (characterColor !== undefined) {
      const color = context.doc.swatches.itemByName(v.string(characterColor, "fillColorName", { max: 200 }));
      if (!color || !color.isValid) throw new CommandError("SWATCH_NOT_FOUND", "Nuance de texte introuvable");
      style.fillColor = color;
    }
    if (args.capitalization !== undefined && indesign.Capitalization) {
      const capitalization = v.oneOf(args.capitalization, "capitalization", ["normal", "allCaps", "smallCaps"]);
      const map = { normal: indesign.Capitalization.normal, allCaps: indesign.Capitalization.allCaps, smallCaps: indesign.Capitalization.smallCaps };
      style.capitalization = map[capitalization];
    }
    return { success: true, style: { id: Number(style.id), name: style.name } };
  }, { requiresDocumentId: true, contentMutation: true, requireExpectedRevision: true, requiresBackup: true });

  commands.create_object_style = definition(async (args, context) => {
    const name = v.string(args.name, "name", { max: 200 });
    let style = context.doc.objectStyles.itemByName(name);
    if (!style || !style.isValid) style = context.doc.objectStyles.add({ name });
    if (args.basedOn !== undefined) {
      const base = context.doc.objectStyles.itemByName(v.string(args.basedOn, "basedOn", { max: 200 }));
      if (!base || !base.isValid) throw new CommandError("STYLE_NOT_FOUND", "Style de base introuvable");
      style.basedOn = base;
    }
    const objectFill = args.fillColorName !== undefined ? args.fillColorName : args.fillColor;
    if (objectFill !== undefined) {
      const fill = context.doc.swatches.itemByName(v.string(objectFill, "fillColorName", { max: 200 }));
      if (!fill || !fill.isValid) throw new CommandError("SWATCH_NOT_FOUND", "Nuance de fond introuvable");
      style.enableFill = true;
      style.fillColor = fill;
    }
    const objectStroke = args.strokeColorName !== undefined ? args.strokeColorName : args.strokeColor;
    if (objectStroke !== undefined) {
      const stroke = context.doc.swatches.itemByName(v.string(objectStroke, "strokeColorName", { max: 200 }));
      if (!stroke || !stroke.isValid) throw new CommandError("SWATCH_NOT_FOUND", "Nuance de contour introuvable");
      style.enableStroke = true;
      style.strokeColor = stroke;
    }
    if (args.strokeWeight !== undefined) style.strokeWeight = v.number(args.strokeWeight, "strokeWeight", { min: 0, max: 1000 });
    if (args.insetSpacing !== undefined && style.textFramePreferences) {
      v.assert(Array.isArray(args.insetSpacing) && args.insetSpacing.length === 4, "INVALID_ARGS", "insetSpacing doit contenir quatre valeurs");
      style.textFramePreferences.insetSpacing = args.insetSpacing.map((entry, index) => v.number(entry, "insetSpacing[" + index + "]", { min: 0, max: 10000 }));
    }
    if (args.textWrap !== undefined) {
      const requestedTextWrap = v.oneOf(args.textWrap, "textWrap", ["none", "boundingBox", "contour"]);
      const textWrapModes = indesign.TextWrapModes;
      const textWrapPreferences = style.textWrapPreferences;
      if (!textWrapModes || !textWrapPreferences || textWrapPreferences.isValid === false) {
        throw new CommandError("TEXT_WRAP_UNSUPPORTED", "Cette version InDesign ne permet pas de regler l'habillage sur un style d'objet");
      }
      const textWrapMap = {
        none: textWrapModes.NONE !== undefined ? textWrapModes.NONE : textWrapModes.none,
        boundingBox: textWrapModes.BOUNDING_BOX_TEXT_WRAP !== undefined ? textWrapModes.BOUNDING_BOX_TEXT_WRAP : textWrapModes.boundingBoxTextWrap,
        contour: textWrapModes.CONTOUR !== undefined ? textWrapModes.CONTOUR : textWrapModes.contour
      };
      const textWrapMode = textWrapMap[requestedTextWrap];
      if (textWrapMode === undefined) {
        throw new CommandError("TEXT_WRAP_UNSUPPORTED", "Le mode d'habillage demande n'est pas disponible dans cette version InDesign");
      }
      style.enableTextWrapAndOthers = true;
      textWrapPreferences.textWrapMode = textWrapMode;
    }
    return { success: true, style: { id: Number(style.id), name: style.name } };
  }, { requiresDocumentId: true, contentMutation: true, requireExpectedRevision: true, requiresBackup: true });

  commands.create_text_frame = definition(async (args, context) => withMillimeterUnits(context.doc, indesign, async () => {
    const page = getPageById(context.doc, v.id(args.pageId, "pageId"));
    const frameBounds = v.bounds(args.bounds, "bounds");
    let layer;
    if (args.layerName !== undefined) {
      layer = context.doc.layers.itemByName(v.string(args.layerName, "layerName", { max: 200 }));
      if (!layer || !layer.isValid) throw new CommandError("LAYER_NOT_FOUND", "Calque introuvable");
    }
    const frame = layer ? page.textFrames.add(layer) : page.textFrames.add();
    frame.geometricBounds = frameBounds;
    if (args.name !== undefined) frame.name = v.string(args.name, "name", { max: 200 });
    const initialText = args.text !== undefined ? args.text : args.contents;
    if (initialText !== undefined) frame.contents = v.string(initialText, "text", { min: 0, max: 2000000, trim: false });
    const paragraphStyleName = args.paragraphStyleName !== undefined ? args.paragraphStyleName : args.paragraphStyle;
    if (paragraphStyleName !== undefined) {
      const style = context.doc.paragraphStyles.itemByName(v.string(paragraphStyleName, "paragraphStyleName", { max: 200 }));
      if (!style || !style.isValid) throw new CommandError("STYLE_NOT_FOUND", "Style de paragraphe introuvable");
      frame.texts.item(0).appliedParagraphStyle = style;
    }
    const objectStyleName = args.objectStyleName !== undefined ? args.objectStyleName : args.objectStyle;
    if (objectStyleName !== undefined) {
      const style = context.doc.objectStyles.itemByName(v.string(objectStyleName, "objectStyleName", { max: 200 }));
      if (!style || !style.isValid) throw new CommandError("STYLE_NOT_FOUND", "Style d'objet introuvable");
      frame.applyObjectStyle(style, true);
    }
    return { success: true, pageItem: pageItemSummary(frame), overflows: Boolean(frame.overflows) };
  }), { requiresDocumentId: true, contentMutation: true, requireExpectedRevision: true, requiresBackup: true });

  commands.edit_text_frame = definition(async (args, context) => withMillimeterUnits(context.doc, indesign, async () => {
    const targetId = args.itemId !== undefined ? args.itemId : args.pageItemId;
    const frame = getPageItemById(context.doc, v.id(targetId, "itemId"));
    if (itemType(frame) !== "TextFrame") throw new CommandError("WRONG_ITEM_TYPE", "L'objet cible n'est pas un bloc de texte");
    const text = args.text !== undefined ? args.text : args.contents;
    if (text !== undefined) {
      const validatedText = v.string(text, "text", { min: 0, max: 2000000, trim: false });
      if (args.append === true) frame.insertionPoints.item(-1).contents = validatedText;
      else frame.contents = validatedText;
    }
    if (args.bounds !== undefined) frame.geometricBounds = v.bounds(args.bounds, "bounds");
    const paragraphStyleName = args.paragraphStyleName !== undefined ? args.paragraphStyleName : args.paragraphStyle;
    if (paragraphStyleName !== undefined) {
      const style = context.doc.paragraphStyles.itemByName(v.string(paragraphStyleName, "paragraphStyleName", { max: 200 }));
      if (!style || !style.isValid) throw new CommandError("STYLE_NOT_FOUND", "Style de paragraphe introuvable");
      frame.texts.item(0).appliedParagraphStyle = style;
    }
    if (args.characterStyleName !== undefined) {
      const style = context.doc.characterStyles.itemByName(v.string(args.characterStyleName, "characterStyleName", { max: 200 }));
      if (!style || !style.isValid) throw new CommandError("STYLE_NOT_FOUND", "Style de caractere introuvable");
      frame.texts.item(0).appliedCharacterStyle = style;
    }
    const objectStyleName = args.objectStyleName !== undefined ? args.objectStyleName : args.objectStyle;
    if (objectStyleName !== undefined) {
      const style = context.doc.objectStyles.itemByName(v.string(objectStyleName, "objectStyleName", { max: 200 }));
      if (!style || !style.isValid) throw new CommandError("STYLE_NOT_FOUND", "Style d'objet introuvable");
      frame.applyObjectStyle(style, Boolean(args.clearOverrides));
    }
    return { success: true, pageItem: pageItemSummary(frame), overflows: Boolean(frame.overflows) };
  }), { requiresDocumentId: true, contentMutation: true, requireExpectedRevision: true, requiresBackup: true });

  commands.create_rectangle = definition(async (args, context) => withMillimeterUnits(context.doc, indesign, async () => {
    const page = getPageById(context.doc, v.id(args.pageId, "pageId"));
    let layer;
    if (args.layerName !== undefined) {
      layer = context.doc.layers.itemByName(v.string(args.layerName, "layerName", { max: 200 }));
      if (!layer || !layer.isValid) throw new CommandError("LAYER_NOT_FOUND", "Calque introuvable");
    }
    const rectangle = layer ? page.rectangles.add(layer) : page.rectangles.add();
    rectangle.geometricBounds = v.bounds(args.bounds, "bounds");
    if (args.name !== undefined) rectangle.name = v.string(args.name, "name", { max: 200 });
    applyItemColors(context.doc, rectangle, {
      fillColor: args.fillColorName !== undefined ? args.fillColorName : args.fillColor,
      strokeColor: args.strokeColorName !== undefined ? args.strokeColorName : args.strokeColor,
      strokeWeight: args.strokeWeight
    });
    const rectangleStyleName = args.objectStyleName !== undefined ? args.objectStyleName : args.objectStyle;
    if (rectangleStyleName !== undefined) {
      const style = context.doc.objectStyles.itemByName(v.string(rectangleStyleName, "objectStyleName", { max: 200 }));
      if (!style || !style.isValid) throw new CommandError("STYLE_NOT_FOUND", "Style d'objet introuvable");
      rectangle.applyObjectStyle(style, true);
    }
    return { success: true, pageItem: pageItemSummary(rectangle) };
  }), { requiresDocumentId: true, contentMutation: true, requireExpectedRevision: true, requiresBackup: true });

  commands.place_file = definition(async (args, context) => withMillimeterUnits(context.doc, indesign, async () => {
    const filePath = v.absolutePath(args.path !== undefined ? args.path : args.filePath, "path", [".jpg", ".jpeg", ".png", ".tif", ".tiff", ".psd", ".ai", ".eps", ".pdf", ".svg", ".indd", ".idml", ".txt", ".rtf", ".doc", ".docx", ".xlsx", ".csv"]);
    let frame;
    if (args.pageItemId !== undefined) {
      frame = getPageItemById(context.doc, v.id(args.pageItemId, "pageItemId"));
      if (typeof frame.place !== "function") throw new CommandError("WRONG_ITEM_TYPE", "L'objet cible ne peut pas recevoir de fichier");
    } else {
      const page = getPageById(context.doc, v.id(args.pageId, "pageId"));
      frame = page.rectangles.add();
      frame.geometricBounds = v.bounds(args.bounds, "bounds");
      if (args.layerName !== undefined) {
        const layer = context.doc.layers.itemByName(v.string(args.layerName, "layerName", { max: 200 }));
        if (!layer || !layer.isValid) throw new CommandError("LAYER_NOT_FOUND", "Calque introuvable");
        frame.itemLayer = layer;
      }
      if (args.objectStyleName !== undefined) {
        const style = context.doc.objectStyles.itemByName(v.string(args.objectStyleName, "objectStyleName", { max: 200 }));
        if (!style || !style.isValid) throw new CommandError("STYLE_NOT_FOUND", "Style d'objet introuvable");
        frame.applyObjectStyle(style, true);
      }
    }
    const pdfPreferences = app.pdfPlacePreferences;
    let previousPdfPageNumber;
    let restorePdfPageNumber = false;
    if (args.pageNumber !== undefined && pdfPreferences) {
      previousPdfPageNumber = pdfPreferences.pageNumber;
      pdfPreferences.pageNumber = v.number(args.pageNumber, "pageNumber", { integer: true, min: 1, max: 100000 });
      restorePdfPageNumber = true;
    }
    let placed;
    try {
      placed = frame.place(filePath, false);
    } finally {
      if (restorePdfPageNumber) {
        try { pdfPreferences.pageNumber = previousPdfPageNumber; } catch (_) {}
      }
    }
    const fit = v.oneOf(args.fit, "fit", ["none", "proportional", "fill", "center", "frameToContent"], "proportional");
    const fitMap = {
      proportional: indesign.FitOptions.proportionally,
      fill: indesign.FitOptions.fillProportionally,
      center: indesign.FitOptions.centerContent,
      frameToContent: indesign.FitOptions.frameToContent
    };
    if (fit !== "none") frame.fit(fitMap[fit]);
    let graphicId = null;
    if (placed && placed.length) graphicId = Number(placed[0].id);
    return { success: true, pageItem: pageItemSummary(frame), graphicId };
  }), { requiresDocumentId: true, contentMutation: true, requireExpectedRevision: true, requiresBackup: true });

  commands.set_page_item_bounds = definition(async (args, context) => withMillimeterUnits(context.doc, indesign, async () => {
    const item = getPageItemById(context.doc, v.id(args.itemId !== undefined ? args.itemId : args.pageItemId, "itemId"));
    item.geometricBounds = v.bounds(args.bounds, "bounds");
    return { success: true, pageItem: pageItemSummary(item) };
  }), { requiresDocumentId: true, contentMutation: true, requireExpectedRevision: true, requiresBackup: true });

  commands.delete_page_item = definition(async (args, context) => {
    const item = getPageItemById(context.doc, v.id(args.itemId !== undefined ? args.itemId : args.pageItemId, "itemId"));
    const deletedId = Number(item.id);
    item.remove();
    return { success: true, deletedPageItemId: deletedId };
  }, { requiresDocumentId: true, contentMutation: true, requireExpectedRevision: true, requiresBackup: true });

  commands.create_master_spread = definition(async (args, context) => {
    const baseName = v.string(args.name !== undefined ? args.name : args.baseName, "name", { max: 200 });
    const prefix = v.optionalString(args.prefix !== undefined ? args.prefix : args.namePrefix, "prefix", { max: 10 });
    const pageCount = v.optionalNumber(args.pageCount, "pageCount", { integer: true, min: 1, max: 10 }) || 1;
    const master = context.doc.masterSpreads.add();
    master.baseName = baseName;
    if (prefix !== undefined) master.namePrefix = prefix;
    if (args.showMasterItems !== undefined) master.showMasterItems = v.boolean(args.showMasterItems, "showMasterItems");
    while (master.pages.length < pageCount) master.pages.add();
    return {
      success: true,
      masterSpread: {
        id: Number(master.id),
        name: master.name,
        namePrefix: master.namePrefix,
        baseName: master.baseName,
        pages: master.pages.length
      }
    };
  }, { requiresDocumentId: true, contentMutation: true, requireExpectedRevision: true, requiresBackup: true });

  commands.apply_master_spread = definition(async (args, context) => {
    const master = getMasterById(context.doc, v.id(args.masterSpreadId, "masterSpreadId"));
    const ids = v.pageIds(args.pageIds, "pageIds");
    for (let i = 0; i < ids.length; i += 1) getPageById(context.doc, ids[i]).appliedMaster = master;
    return { success: true, masterSpreadId: Number(master.id), appliedPageIds: ids };
  }, { requiresDocumentId: true, contentMutation: true, requireExpectedRevision: true, requiresBackup: true });

  commands.preflight_document = definition(async (args, context) => {
    const profileName = v.optionalString(args.profileName, "profileName", { max: 300 });
    const timeoutSeconds = v.optionalNumber(args.timeoutSeconds, "timeoutSeconds", { integer: true, min: 1, max: 600 }) || 60;
    const preflightOptions = context.doc.preflightOptions;
    const originalPreflightOff = Boolean(preflightOptions.preflightOff);

    function profileByName(name) {
      let candidate = null;
      try { candidate = context.doc.preflightProfiles.itemByName(name); } catch (_) {}
      if (candidate && candidate.isValid) return candidate;
      try { candidate = app.preflightProfiles.itemByName(name); } catch (_) {}
      return candidate && candidate.isValid ? candidate : null;
    }

    let profile;
    if (profileName) {
      profile = profileByName(profileName);
      if (!profile || !profile.isValid) throw new CommandError("PREFLIGHT_PROFILE_NOT_FOUND", "Profil de controle introuvable");
    } else {
      let workingProfile = null;
      try { workingProfile = preflightOptions.preflightWorkingProfile; } catch (_) {}
      if (workingProfile && typeof workingProfile === "object" && workingProfile.isValid) {
        profile = workingProfile;
      } else if (typeof workingProfile === "string" && workingProfile) {
        profile = profileByName(workingProfile);
      }
      if (!profile && app.preflightProfiles.length > 0) profile = collectionItem(app.preflightProfiles, 0);
      if (!profile || !profile.isValid) throw new CommandError("PREFLIGHT_PROFILE_NOT_FOUND", "Aucun profil de controle disponible");
    }

    // Un document peut hériter d'un contrôle dynamique désactivé. Le processus
    // explicite UXP ne progresse alors pas toujours; on l'active uniquement le
    // temps du contrôle puis on restitue exactement le réglage initial.
    if (originalPreflightOff) preflightOptions.preflightOff = false;
    const process = app.preflightProcesses.add(context.doc, profile);
    try {
      const startedAt = Date.now();
      let completed = Boolean(process.waitForProcess(timeoutSeconds));
      let aggregated = null;
      let report = null;

      // Certaines versions d'InDesign peuvent rendre la main avant la fin au
      // premier appel. Un second appel est alors nécessaire, sans dépasser le
      // délai total demandé par l'appelant.
      if (!completed) {
        const elapsedSeconds = Math.ceil((Date.now() - startedAt) / 1000);
        const remainingSeconds = timeoutSeconds - elapsedSeconds;
        if (remainingSeconds > 0) completed = Boolean(process.waitForProcess(remainingSeconds));
      }

      // InDesign 2026 peut également renvoyer false alors que les deux sorties
      // finales sont déjà disponibles. Elles constituent alors la preuve que le
      // contrôle est terminé, sans transformer un vrai délai dépassé en succès.
      try { aggregated = safeValue(process.aggregatedResults); } catch (_) {}
      try { report = String(process.processResults || "").slice(0, 200000); } catch (_) {}
      if (!completed && Array.isArray(aggregated) && aggregated.length >= 3 && report.length > 0) completed = true;
      if (!completed) {
        throw new CommandError("PREFLIGHT_TIMEOUT", "Le controle en amont n'est pas termine");
      }
      return { success: true, profile: profile.name, aggregatedResults: aggregated, processResults: report };
    } finally {
      try { process.remove(); } catch (_) {}
      if (originalPreflightOff) {
        try { preflightOptions.preflightOff = true; } catch (_) {}
      }
    }
  }, { requiresDocumentId: true });

  commands.export_pdf = definition(async (args, context) => {
    const filePath = v.absolutePath(args.path !== undefined ? args.path : args.filePath, "path", [".pdf"]);
    const presetName = v.optionalString(args.presetName, "presetName", { max: 300 });
    let preset;
    if (presetName) {
      preset = app.pdfExportPresets.itemByName(presetName);
      if (!preset || !preset.isValid) throw new CommandError("PDF_PRESET_NOT_FOUND", "Parametre PDF introuvable");
    }
    const preferences = app.pdfExportPreferences;
    const oldPageRange = preferences.pageRange;
    const oldBleed = preferences.useDocumentBleedWithPDF;
    const oldCropMarks = preferences.cropMarks;
    const pageRange = v.optionalString(args.pageRange, "pageRange", { max: 128 }) || "all";
    try {
      const allPages = indesign.PageRange
        ? (indesign.PageRange.ALL_PAGES !== undefined ? indesign.PageRange.ALL_PAGES : indesign.PageRange.allPages)
        : undefined;
      preferences.pageRange = pageRange.toLowerCase() === "all" && allPages !== undefined ? allPages : pageRange;
      preferences.useDocumentBleedWithPDF = v.boolean(args.useDocumentBleed, "useDocumentBleed", true);
      preferences.cropMarks = v.boolean(args.cropMarks, "cropMarks", false);
      await context.doc.exportFile(indesign.ExportFormat.pdfType, filePath, false, preset);
    } finally {
      try { preferences.pageRange = oldPageRange; } catch (_) {}
      try { preferences.useDocumentBleedWithPDF = oldBleed; } catch (_) {}
      try { preferences.cropMarks = oldCropMarks; } catch (_) {}
    }
    return { success: true, path: filePath, preset: presetName || null, pageRange };
  }, { requiresDocumentId: true, requiresBackup: true });

  commands.export_idml = definition(async (args, context) => {
    const filePath = v.absolutePath(args.path !== undefined ? args.path : args.filePath, "path", [".idml"]);
    await context.doc.exportFile(indesign.ExportFormat.indesignMarkup, filePath, false);
    return { success: true, path: filePath };
  }, { requiresDocumentId: true, requiresBackup: true });

  commands.export_png = definition(async (args, context) => {
    const target = normalizePngExportTarget(args);
    const outputDirectory = target.folderPath;
    const singleFilePath = target.filePath;
    const resolution = v.optionalNumber(args.resolution, "resolution", { min: 36, max: 2400 }) || 300;
    const pageId = target.pageId;
    const pageRange = v.optionalString(args.pageRange, "pageRange", { max: 128 }) || "all";
    const transparentBackground = v.boolean(args.transparentBackground, "transparentBackground", false);
    const preferences = app.pngExportPreferences;
    const oldResolution = preferences.exportResolution;
    const oldTransparent = preferences.transparentBackground;
    const oldRange = preferences.pngExportRange;
    const oldPageString = preferences.pageString;
    const oldExportingSpread = preferences.exportingSpread;
    const rangeEnum = indesign.PNGExportRangeEnum || indesign.ExportRangeOrAllPages;
    const exportRange = rangeEnum && (
      rangeEnum.EXPORT_RANGE !== undefined ? rangeEnum.EXPORT_RANGE : rangeEnum.exportRange
    );
    const pngFormat = indesign.ExportFormat && (
      indesign.ExportFormat.PNG_FORMAT !== undefined
        ? indesign.ExportFormat.PNG_FORMAT
        : indesign.ExportFormat.pngFormat
    );
    if (exportRange === undefined) {
      throw new CommandError("INDESIGN_API_UNAVAILABLE", "La plage d'export PNG est indisponible");
    }
    if (pngFormat === undefined) {
      throw new CommandError("INDESIGN_API_UNAVAILABLE", "Le format d'export PNG est indisponible");
    }
    const exportedPaths = [];
    try {
      preferences.exportResolution = resolution;
      preferences.transparentBackground = transparentBackground;
      preferences.exportingSpread = false;
      preferences.pngExportRange = exportRange;
      if (pageId) {
        const page = getPageById(context.doc, pageId);
        const target = singleFilePath || outputDirectory + (/[/\\]$/.test(outputDirectory) ? "" : "\\") + "page-" + String(page.documentOffset + 1).padStart(4, "0") + ".png";
        preferences.pageString = "+" + String(page.documentOffset + 1);
        await context.doc.exportFile(pngFormat, target, false);
        exportedPaths.push(target);
      } else {
        const indexes = parsePageRange(pageRange, context.doc.pages.length);
        for (let i = 0; i < indexes.length; i += 1) {
          const index = indexes[i];
          const page = collectionItem(context.doc.pages, index);
          const target = outputDirectory + (/[/\\]$/.test(outputDirectory) ? "" : "\\") + "page-" + String(index + 1).padStart(4, "0") + ".png";
          preferences.pageString = "+" + String(index + 1);
          await context.doc.exportFile(pngFormat, target, false);
          exportedPaths.push(target);
        }
      }
    } finally {
      try { preferences.exportResolution = oldResolution; } catch (_) {}
      try { preferences.transparentBackground = oldTransparent; } catch (_) {}
      try { preferences.exportingSpread = oldExportingSpread; } catch (_) {}
      try { preferences.pageString = oldPageString; } catch (_) {}
      try { preferences.pngExportRange = oldRange; } catch (_) {}
    }
    return { success: true, paths: exportedPaths, resolution, pageId: pageId || null, pageRange };
  }, { requiresDocumentId: true, requiresBackup: true });

  commands.package_document = definition(async (args, context) => {
    const folderPath = v.absolutePath(args.outputDirectory !== undefined ? args.outputDirectory : args.folderPath, "outputDirectory");
    const includeFonts = v.boolean(args.copyFonts !== undefined ? args.copyFonts : args.includeFonts, "copyFonts", true);
    const includeLinks = v.boolean(args.copyLinks !== undefined ? args.copyLinks : args.includeLinks, "copyLinks", true);
    const includeProfiles = v.boolean(args.includeProfiles, "includeProfiles", true);
    const includeHiddenLayers = v.boolean(args.includeHiddenLayers, "includeHiddenLayers", false);
    const ignorePreflightErrors = v.boolean(args.ignorePreflightErrors, "ignorePreflightErrors", false);
    const includeIdml = v.boolean(args.includeIdml, "includeIdml", true);
    const includePdf = v.boolean(args.includePdf, "includePdf", true);
    const updateGraphics = v.boolean(args.updateGraphics, "updateGraphics", true);
    const pdfPresetName = v.optionalString(args.pdfPresetName, "pdfPresetName", { max: 300 }) || "";
    const completed = context.doc.packageForPrint(
      folderPath,
      includeFonts,
      includeLinks,
      includeProfiles,
      updateGraphics,
      includeHiddenLayers,
      ignorePreflightErrors,
      true,
      includeIdml,
      includePdf,
      pdfPresetName,
      true,
      "InDesign MCP Secure 3.2.2",
      false
    );
    if (completed === false) throw new CommandError("PACKAGE_FAILED", "Le package InDesign n'a pas ete cree");
    return { success: true, folderPath };
  }, { requiresDocumentId: true, requiresBackup: true });

  commands.create_safety_backup = definition(async (args, context) => {
    cleanBackups();
    const reason = v.string(args.reason, "reason", { min: 5, max: 500 });
    const toolName = v.string(args.toolName, "toolName", { min: 1, max: 100, pattern: /^[a-z][a-z0-9_]*$/ });
    const backupDirectory = v.absolutePath(args.backupDirectory, "backupDirectory");
    const backupId = randomId();
    const separator = /[\\/]$/.test(backupDirectory) ? "" : "\\";
    const backupPath = backupDirectory + separator + "backup-" + backupId + ".indd";
    await context.doc.saveACopy(backupPath, false);
    const createdAt = new Date().toISOString();
    backups.set(backupId, {
      id: backupId,
      documentId: context.documentId,
      revision: context.revision,
      backupPath,
      originalPath: await nativePath(context.doc),
      createdAt,
      createdAtMs: Date.now(),
      reason,
      toolName,
      consumedAt: null
    });
    return { success: true, backupId, backupPath, revision: context.revision, createdAt };
  }, { requiresDocumentId: true, requireExpectedRevision: true });

  commands.restore_safety_backup = definition(async (args, context) => {
    cleanBackups();
    const backupId = v.string(args.backupId, "backupId", { min: 36, max: 64, pattern: /^[a-f0-9]+$/ });
    const recoveryBackupId = v.string(args.recoveryBackupId, "recoveryBackupId", { min: 36, max: 64, pattern: /^[a-f0-9]+$/ });
    const reason = v.string(args.reason, "reason", { min: 5, max: 500 });
    const workingCopyPath = v.absolutePath(args.workingCopyPath, "workingCopyPath", [".indd"]);
    if (backupId === recoveryBackupId) throw new CommandError("BACKUP_MISMATCH", "La cible et la sauvegarde de retour doivent etre distinctes");
    consumeSafetyBackup({ backupId: recoveryBackupId, reason }, context.documentId, context.revision, "restore_safety_backup");
    context.backupConsumed = true;
    const backup = backups.get(backupId);
    if (!backup) throw new CommandError("BACKUP_NOT_FOUND", "Sauvegarde de securite introuvable ou expiree");
    if (backup.documentId !== context.documentId) throw new CommandError("BACKUP_MISMATCH", "La sauvegarde ne correspond pas au document");
    if (Date.now() - backup.createdAtMs > RESTORE_MAX_AGE_MS) throw new CommandError("BACKUP_EXPIRED", "La sauvegarde de securite a expire");
    let currentExists = false;
    try {
      getDocumentById(app, context.documentId);
      currentExists = true;
    } catch (_) {}
    if (workingCopyPath === backup.backupPath) throw new CommandError("BACKUP_MISMATCH", "La restauration exige une copie de travail distincte");
    const opened = await app.open(workingCopyPath, true);
    const restoredDocumentId = Number(opened.id);
    try {
      if (currentExists) {
        const current = getDocumentById(app, context.documentId);
        if (Number(current.id) === restoredDocumentId) throw new CommandError("RESTORE_COLLISION", "La copie restauree a reutilise l'identifiant du document courant");
        await current.close(indesign.SaveOptions.no);
        await waitForDocumentState(app, context.documentId, false, 10000);
      }
    } catch (error) {
      try {
        const openedForCleanup = getDocumentById(app, restoredDocumentId);
        await openedForCleanup.close(indesign.SaveOptions.no);
      } catch (_) {}
      throw error;
    }
    const restored = await waitForDocumentState(app, restoredDocumentId, true, 10000);
    // Une restauration change l'état logique du document. La révision doit
    // rester strictement croissante afin qu'un ancien client ne puisse jamais
    // redevenir valide après le retour à une copie antérieure.
    const restoredRevision = context.revision + 1;
    if (!setRevision(restored, restoredRevision)) {
      try { await restored.close(indesign.SaveOptions.no); } catch (_) {}
      throw new CommandError("REVISION_WRITE_FAILED", "La revision de la copie restauree n'a pas pu etre securisee");
    }
    return {
      success: true,
      restoredDocumentId,
      originalDocumentId: backup.documentId,
      revision: restoredRevision,
      stateToken: documentStateToken(restored),
      sourceRevision: backup.revision,
      backupPath: backup.backupPath,
      workingCopyPath,
      originalPath: backup.originalPath
    };
  }, { requiresDocumentId: true, requireExpectedRevision: true, replacesDocument: true });

  commands.execute_uxp = definition(async (args, context) => {
    cleanBackups();
    const scope = v.oneOf(args.scope, "scope", ["document", "application"], "document");
    const reason = v.string(args.reason, "reason", { min: 5, max: 500 });
    const code = v.string(args.code, "code", { min: 1, max: MAX_DYNAMIC_CODE_LENGTH, trim: false });
    const input = args.input === undefined ? null : args.input;
    v.assertSafeJson(input);

    const before = [];
    for (let i = 0; i < app.documents.length; i += 1) {
      const doc = collectionItem(app.documents, i);
      before.push({ id: Number(doc.id), revision: getRevision(doc), stateToken: documentStateToken(doc), doc });
    }
    const expectedDocumentStates = args.expectedDocumentStates;
    v.assert(Array.isArray(expectedDocumentStates) && expectedDocumentStates.length <= 100, "STATE_TOKEN_REQUIRED", "expectedDocumentStates est obligatoire pour execute_uxp");
    const expectedById = new Map();
    for (let i = 0; i < expectedDocumentStates.length; i += 1) {
      const expected = v.object(expectedDocumentStates[i], "expectedDocumentStates");
      const expectedId = v.id(expected.documentId, "expectedDocumentStates.documentId");
      const expectedRevisionValue = v.number(expected.revision, "expectedDocumentStates.revision", { integer: true, min: 0 });
      const expectedToken = v.string(expected.stateToken, "expectedDocumentStates.stateToken", { min: 16, max: 16, pattern: /^[a-f0-9]{16}$/ });
      v.assert(!expectedById.has(expectedId), "DOCUMENT_STATE_INVALID", "expectedDocumentStates contient un doublon");
      expectedById.set(expectedId, { revision: expectedRevisionValue, stateToken: expectedToken });
    }
    v.assert(expectedById.size === before.length, "STATE_CONFLICT", "La liste des documents ouverts a change avant execute_uxp");
    for (let i = 0; i < before.length; i += 1) {
      const current = before[i];
      const expected = expectedById.get(current.id);
      if (!expected || expected.revision !== current.revision || expected.stateToken !== current.stateToken) {
        throw new CommandError("STATE_CONFLICT", "Un document ouvert a change juste avant execute_uxp", { documentId: current.id });
      }
    }

    if (scope === "document" && !context.doc) {
      throw new CommandError("DOCUMENT_REQUIRED", "documentId est obligatoire pour la portee document");
    }
    const rawBackupIds = args.backupIds === undefined ? [] : args.backupIds;
    v.assert(Array.isArray(rawBackupIds) && rawBackupIds.length <= 100, "INVALID_ARGS", "backupIds doit etre un tableau");
    const backupIds = [];
    const uniqueBackupIds = new Set();
    for (let i = 0; i < rawBackupIds.length; i += 1) {
      const backupId = v.string(rawBackupIds[i], "backupIds", { min: 36, max: 64, pattern: /^[a-f0-9]+$/ });
      if (uniqueBackupIds.has(backupId)) throw new CommandError("BACKUP_MISMATCH", "backupIds contient un doublon");
      uniqueBackupIds.add(backupId);
      backupIds.push(backupId);
    }
    if (backupIds.length !== before.length) {
      throw new CommandError("BACKUP_REQUIRED", "Une et une seule sauvegarde fraiche est requise pour chaque document ouvert");
    }

    const beforeById = new Map(before.map((entry) => [entry.id, entry]));
    const requiredBackups = [];
    const backedUpDocumentIds = new Set();
    for (let i = 0; i < backupIds.length; i += 1) {
      const backupId = backupIds[i];
      const backup = backups.get(backupId);
      if (!backup) throw new CommandError("BACKUP_NOT_FOUND", "Sauvegarde de securite introuvable");
      if (backup.consumedAt) throw new CommandError("BACKUP_ALREADY_USED", "La sauvegarde a deja autorise une execution");
      if (Date.now() - backup.createdAtMs > BACKUP_MAX_AGE_MS) throw new CommandError("BACKUP_EXPIRED", "La sauvegarde n'est plus assez recente");
      const expected = beforeById.get(backup.documentId);
      if (!expected || backup.revision !== expected.revision) {
        throw new CommandError("BACKUP_MISMATCH", "La sauvegarde ne correspond pas a l'etat du document");
      }
      if (backup.reason !== reason) {
        throw new CommandError("BACKUP_MISMATCH", "La sauvegarde n'autorise pas execute_uxp");
      }
      if (backedUpDocumentIds.has(backup.documentId)) {
        throw new CommandError("BACKUP_MISMATCH", "Plusieurs sauvegardes ont ete fournies pour le meme document");
      }
      backedUpDocumentIds.add(backup.documentId);
      requiredBackups.push({ backupId, documentId: backup.documentId, revision: backup.revision });
    }
    if (backedUpDocumentIds.size !== before.length) {
      throw new CommandError("BACKUP_REQUIRED", "Une sauvegarde fraiche manque pour un document ouvert");
    }
    if (scope === "document") {
      const primaryBackupId = v.string(args.backupId, "backupId", { min: 36, max: 64, pattern: /^[a-f0-9]+$/ });
      const primary = requiredBackups.find((entry) => entry.backupId === primaryBackupId);
      if (!primary || primary.documentId !== context.documentId) {
        throw new CommandError("BACKUP_MISMATCH", "backupId doit identifier la sauvegarde du document cible et appartenir a backupIds");
      }
    } else if (args.backupId !== undefined) {
      const primaryBackupId = v.string(args.backupId, "backupId", { min: 36, max: 64, pattern: /^[a-f0-9]+$/ });
      if (!uniqueBackupIds.has(primaryBackupId)) {
        throw new CommandError("BACKUP_MISMATCH", "backupId ne peut pas ajouter une sauvegarde hors de backupIds");
      }
    }
    const consumedAt = new Date().toISOString();
    for (let i = 0; i < requiredBackups.length; i += 1) backups.get(requiredBackups[i].backupId).consumedAt = consumedAt;

    try {
      const generated = new Function(
        "app",
        "indesign",
        "uxp",
        "require",
        "input",
        "targetDocument",
        "'use strict'; return (async function(){\n" + code + "\n}).call(null);"
      );
      const usedUndoTransaction = false;
      const run = async () => {
        const activeDocumentIdBefore = activeDocumentId(app);
        const codeSha256 = sha256(code);
        const payloadHasActiveDocument = /\bapp\.activeDocument\b/.test(code);
        const payloadHasTargetDocument = /\btargetDocument\b/.test(code);
        const requestedDocumentId = scope === "document" ? context.documentId : null;
        let targetDocument = null;
        let resolvedTargetDocumentId = null;
        let resolutionMethod = "not-applicable";
        if (scope === "document") {
          // Relire la cible juste avant le code fourni avec l'API DOM
          // officielle. Le document actif de l'interface n'est jamais utilisé
          // comme mécanisme de ciblage.
          const resolved = resolveDocumentById(app, context.documentId);
          targetDocument = resolved.document;
          resolvedTargetDocumentId = Number(targetDocument.id);
          resolutionMethod = resolved.resolutionMethod;
        }
        const value = await generated(app, indesign, uxpModule, moduleRequire, input, targetDocument);
        const execution = freezeObject({
          codeSha256,
          payloadHasActiveDocument,
          payloadHasTargetDocument,
          requestedDocumentId,
          resolvedTargetDocumentId,
          activeDocumentIdBefore,
          activeDocumentIdAfter: activeDocumentId(app),
          resolutionMethod,
          usedUndoTransaction
        });
        // L'enveloppe est créée après l'exécution du code fourni. Une propriété
        // `_execution` renvoyée par ce code reste une simple donnée métier et
        // sera systématiquement remplacée par cette preuve interne.
        return freezeObject({ value, execution });
      };
      // InDesign 2026 ne propage pas de façon fiable la Promise renvoyée par
      // une fonction asynchrone passée à app.doScript. L'exécution directe
      // conserve donc le résultat et sa preuve, y compris après un await.
      // Les sauvegardes fraîches de tous les documents restent obligatoires.
      const wrapped = await run();
      if (!wrapped || typeof wrapped !== "object" || !wrapped.execution || !hasOwnProperty(wrapped, "value")) {
        throw new CommandError("EXECUTION_PROOF_MISSING", "L'exécution UXP n'a pas renvoyé sa preuve d'exécution");
      }
      const serialized = safeValue(await Promise.resolve(wrapped.value));
      const execution = safeValue(wrapped.execution);
      if (serialized && typeof serialized === "object" && !Array.isArray(serialized)) {
        serialized._execution = execution;
        return serialized;
      }
      return { success: true, value: serialized, _execution: execution };
    } catch (error) {
      let executionError = error && (typeof error === "object" || typeof error === "function")
        ? error
        : new CommandError("INDESIGN_ERROR", String(error));
      try {
        executionError.indesignDynamicExecution = true;
      } catch (_) {
        executionError = new CommandError(
          typeof executionError.code === "string" ? executionError.code : "INDESIGN_ERROR",
          executionError.message ? String(executionError.message) : "L'execution UXP a echoue",
          executionError.details
        );
        executionError.indesignDynamicExecution = true;
      }
      throw executionError;
    }
  }, { dynamicExecution: true });

  return commands;
}

async function executeCommand(registry, app, name, args, envelope) {
  const command = registry[name];
  if (!command) throw new CommandError("UNKNOWN_COMMAND", "Commande inconnue");
  const safeArgs = v.object(args || {}, "args");
  const documentId = envelope.documentId;
  const expectedRevision = envelope.expectedRevision;
  const expectedStateToken = envelope.expectedStateToken;
  let doc = null;

  if (command.requiresDocumentId) {
    if (documentId === undefined || documentId === null) throw new CommandError("DOCUMENT_REQUIRED", "documentId est obligatoire");
    try { doc = getDocumentById(app, documentId); }
    catch (error) {
      if (!command.allowMissingDocument) throw error;
    }
  } else if (command.documentOptional) {
    doc = getOptionalDocument(app, documentId);
  } else if (documentId !== undefined && documentId !== null) {
    doc = getDocumentById(app, documentId);
  }

  let revision = doc ? getRevision(doc) : null;
  if (command.requireExpectedRevision) {
    if (expectedRevision === undefined || expectedRevision === null) throw new CommandError("REVISION_REQUIRED", "expectedRevision est obligatoire");
    const expected = v.number(expectedRevision, "expectedRevision", { integer: true, min: 0, max: Number.MAX_SAFE_INTEGER });
    if (revision !== expected) throw new CommandError("REVISION_CONFLICT", "Le document a change depuis la derniere lecture", { expected, actual: revision });
  } else if (doc && expectedRevision !== undefined && expectedRevision !== null) {
    const expected = v.number(expectedRevision, "expectedRevision", { integer: true, min: 0, max: Number.MAX_SAFE_INTEGER });
    if (revision !== expected) throw new CommandError("REVISION_CONFLICT", "Le document a change depuis la derniere lecture", { expected, actual: revision });
  }

  const requiresExpectedStateToken = Boolean(doc) && (
    command.requiresBackup
    || command.contentMutation
    || command.replacesDocument
    || name === "create_safety_backup"
    || (command.dynamicExecution && safeArgs.scope !== "application")
  );
  if (requiresExpectedStateToken && (typeof expectedStateToken !== "string" || !/^[a-f0-9]{16}$/.test(expectedStateToken))) {
    throw new CommandError("STATE_TOKEN_REQUIRED", "expectedStateToken est obligatoire pour cette commande");
  }
  if (doc && expectedStateToken !== undefined && expectedStateToken !== null) {
    if (typeof expectedStateToken !== "string" || !/^[a-f0-9]{16}$/.test(expectedStateToken)) {
      throw new CommandError("STATE_TOKEN_INVALID", "expectedStateToken est invalide");
    }
    const actualStateToken = documentStateToken(doc);
    if (actualStateToken !== expectedStateToken) {
      throw new CommandError("STATE_CONFLICT", "Le contenu ou la structure du document a change depuis la derniere inspection", { expected: expectedStateToken, actual: actualStateToken });
    }
  }

  const context = {
    app,
    doc,
    documentId: doc ? Number(doc.id) : (documentId || null),
    revision,
    backupConsumed: false,
    documentRevisionsBeforeHandler: snapshotOpenDocumentRevisions(app)
  };
  if (command.requiresBackup) {
    if (!doc) throw new CommandError("DOCUMENT_REQUIRED", "Document requis pour verifier la sauvegarde");
    consumeSafetyBackup(safeArgs, Number(doc.id), revision, name);
    context.backupConsumed = true;
  }
  if (command.dynamicExecution) {
    if (safeArgs.scope !== "application") {
      if (!doc) throw new CommandError("DOCUMENT_REQUIRED", "documentId est obligatoire pour la portee document");
      if (expectedRevision === undefined || expectedRevision === null) throw new CommandError("REVISION_REQUIRED", "expectedRevision est obligatoire");
      const expected = v.number(expectedRevision, "expectedRevision", { integer: true, min: 0 });
      if (revision !== expected) throw new CommandError("REVISION_CONFLICT", "Le document a change depuis la derniere lecture", { expected, actual: revision });
    }
    try {
      const result = await command.handler(safeArgs, context);
      const revisions = [];
      const documentStates = [];
      for (let i = 0; i < app.documents.length; i += 1) {
        const current = collectionItem(app.documents, i);
        const next = getRevision(current) + 1;
        setRevision(current, next);
        revisions.push({ documentId: Number(current.id), revision: next });
        documentStates.push({ documentId: Number(current.id), revision: next, stateToken: documentStateToken(current) });
      }
      result.revisions = revisions;
      result.documentStates = documentStates;
      if (doc && doc.isValid !== false) result.revision = getRevision(doc);
      return result;
    } catch (error) {
      if (error && error.indesignDynamicExecution === true) {
        throw decorateDynamicExecutionError(error, app);
      }
      throw error;
    }
  }

  let result;
  try {
    result = await command.handler(safeArgs, context);
  } catch (error) {
    if (
      context.backupConsumed === true
      && (command.requiresBackup || command.contentMutation || command.replacesDocument)
    ) {
      throw decorateProtectedExecutionError(error, app, context, command);
    }
    throw error;
  }
  if (command.contentMutation && doc && doc.isValid !== false) {
    revision += 1;
    setRevision(doc, revision);
  }
  if (result && typeof result === "object" && doc && doc.isValid !== false && !command.replacesDocument) {
    result.revision = command.contentMutation ? revision : getRevision(doc);
    result.stateToken = documentStateToken(doc);
  }
  return safeValue(result);
}

module.exports = {
  createCommandRegistry,
  executeCommand,
  getRevision,
  nativePath,
  normalizeNativeFilePath,
  setRevision,
  safeValue,
  documentStateToken,
  REVISION_LABEL
};

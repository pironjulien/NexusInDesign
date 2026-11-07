// Annotated preview: a private INDD copy (the document's safety backup) is opened without a window, gets an annotation
// layer (margins, gutters, outline and id of each frame, overset text in red), serves the PNG export, then is closed
// without saving. The source document is never touched.
async function openAnnotatedCopy(copyPath) {
  const copy = await app.open(copyPath, false);
  if (!copy || copy.isValid === false) { const error = new Error(__t("The annotated copy could not be opened", "La copie annotée n’a pas pu être ouverte")); error.code = "ANNOTATED_COPY_OPEN_FAILED"; throw error; }
  const pick = (enumeration, name) => (enumeration[name] !== undefined ? enumeration[name] : enumeration[name.toLowerCase().replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())]);
  const points = pick(indesign.MeasurementUnits, "POINTS");
  copy.viewPreferences.horizontalMeasurementUnits = points;
  copy.viewPreferences.verticalMeasurementUnits = points;
  const color = (name, value) => copy.colors.add({ name, model: pick(indesign.ColorModel, "PROCESS"), space: pick(indesign.ColorSpace, "RGB"), colorValue: value });
  const margin = color("Nexus annotation margins", [0, 150, 255]);
  const gutter = color("Nexus annotation gutters", [190, 60, 255]);
  const frame = color("Nexus annotation frames", [20, 90, 220]);
  const overset = color("Nexus annotation overset", [235, 20, 20]);
  const label = color("Nexus annotation label", [255, 225, 0]);
  const none = copy.swatches.itemByName("None");
  const black = copy.swatches.itemByName("Black");
  for (let index = 0; index < copy.layers.length; index += 1) { try { copy.layers.item(index).locked = false; } catch (_) {} }
  const layer = copy.layers.add({ name: "Nexus annotations", visible: true, printable: true, locked: false });
  try { layer.move(pick(indesign.LocationOptions, "AT_BEGINNING")); } catch (_) {}
  const leftHand = pick(indesign.PageSideOptions, "LEFT_HAND");
  const fitFrame = pick(indesign.FitOptions, "FRAME_TO_CONTENT");
  const summary = { pages: 0, items: 0, oversetItems: [] };
  const box = (page, bounds, properties) => page.rectangles.add(Object.assign({ itemLayer: layer, geometricBounds: bounds, fillColor: none, strokeColor: none, strokeWeight: 0 }, properties));
  for (let pageIndex = 0; pageIndex < copy.pages.length; pageIndex += 1) {
    const page = copy.pages.item(pageIndex);
    const items = page.pageItems.everyItem().getElements();
    const [top, left, bottom, right] = page.bounds.map(Number);
    const preferences = page.marginPreferences;
    let inside = Number(preferences.left);
    let outside = Number(preferences.right);
    if (copy.documentPreferences.facingPages && page.side === leftHand) [inside, outside] = [outside, inside];
    const content = [top + Number(preferences.top), left + inside, bottom - Number(preferences.bottom), right - outside];
    box(page, content, { strokeColor: margin, strokeWeight: 1 });
    const columns = Math.max(1, Number(preferences.columnCount) || 1);
    const space = Number(preferences.columnGutter) || 0;
    const width = (content[3] - content[1] - space * (columns - 1)) / columns;
    for (let column = 1; column < columns; column += 1) {
      const start = content[1] + column * width + (column - 1) * space;
      box(page, [content[0], start, content[2], start + Math.max(space, 0.5)], { fillColor: gutter, fillTint: 35 });
    }
    for (const item of items) {
      let visible = true;
      try { visible = item.visible !== false && item.itemLayer.visible !== false; } catch (_) {}
      if (!visible) continue;
      const bounds = item.geometricBounds.map(Number);
      let overflows = false;
      try { overflows = Boolean(item.overflows); } catch (_) {}
      const id = Number(item.id);
      box(page, bounds, { strokeColor: overflows ? overset : frame, strokeWeight: overflows ? 3 : 0.75 });
      // Label placed above the frame (inside only when it touches the top of the page): the content stays readable.
      const tagTop = bounds[0] - 12 >= top ? bounds[0] - 12 : bounds[0];
      const tag = page.textFrames.add({ itemLayer: layer, geometricBounds: [tagTop, bounds[1], tagTop + 12, bounds[1] + 60], fillColor: overflows ? overset : label });
      tag.contents = "#" + id + (overflows ? __t(" overset", " excès") : "");
      try { tag.texts.item(0).pointSize = 8; tag.texts.item(0).fillColor = black; } catch (_) {}
      try { tag.textFramePreferences.insetSpacing = [1, 2, 1, 2]; tag.fit(fitFrame); } catch (_) {}
      summary.items += 1;
      if (overflows) summary.oversetItems.push(id);
    }
    summary.pages += 1;
  }
  return { copy, summary };
}

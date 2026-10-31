import assert from 'node:assert/strict';
import test from 'node:test';
import { ScriptExecutor } from '../src/core/scriptExecutor.js';
import { DocumentHandlers } from '../src/handlers/documentHandlers.js';
import { PageHandlers } from '../src/handlers/pageHandlers.js';
import { handleLegacyMissing } from '../src/handlers/legacyMissingHandlers.js';
import { buildToolCatalog } from '../src/tools/catalog.js';

async function captureGeneratedCode(operation) {
  const original = ScriptExecutor.executeViaUXP;
  let generatedCode = '';
  ScriptExecutor.executeViaUXP = async (code) => {
    generatedCode = code;
    return { success: true };
  };
  try {
    await operation();
  } finally {
    ScriptExecutor.executeViaUXP = original;
  }
  assert.notEqual(generatedCode, '');
  return generatedCode;
}

async function runGeneratedCode(code, { app, indesign = {} }) {
  const execute = new Function('app', 'targetDocument', 'require', `return (async () => {${code}})();`);
  return execute(app, app.activeDocument, (name) => {
    assert.equal(name, 'indesign');
    return indesign;
  });
}

function collection(values) {
  return { length: values.length, item: (index) => values[index] };
}

test('adjust_page_layout transmet les mesures comme données à Page.adjustLayout', async () => {
  const code = await captureGeneratedCode(() => PageHandlers.adjustPageLayout({
    pageIndex: 0,
    width: '600px',
    height: '800px',
    leftMargin: '1in',
  }));
  let applied;
  const page = { adjustLayout: (changes) => { applied = changes; } };
  const app = { documents: { length: 1 }, activeDocument: { pages: collection([page]) } };

  const result = await runGeneratedCode(code, { app });
  assert.equal(result.success, true);
  assert.deepEqual(applied, { width: '600px', height: '800px', leftMargin: '1in' });
  assert.match(code, /page\.adjustLayout\(changes\)/);
  assert.doesNotMatch(code, /page\.resize|bleedBoxPreferences|\b600px\b\s*,/);
});

test('adjust_page_layout refuse explicitement les fonds perdus sans lancer UXP', async () => {
  const original = ScriptExecutor.executeViaUXP;
  ScriptExecutor.executeViaUXP = async () => assert.fail('UXP ne doit pas être lancé');
  try {
    const response = await PageHandlers.adjustPageLayout({ pageIndex: 0, width: '210mm', bleedTop: '3mm' });
    assert.equal(response.success, false);
    assert.match(response.result, /Adobe ignore les fonds perdus/);
  } finally {
    ScriptExecutor.executeViaUXP = original;
  }
});

test('resize_page respecte les énumérations et le tableau de dimensions Adobe', async () => {
  const code = await captureGeneratedCode(() => PageHandlers.resizePage({
    pageIndex: 0,
    width: 595,
    height: 842,
    coordinateSpace: 'PAGE_COORDINATES',
    anchorPoint: 'CENTER_ANCHOR',
    resizeMethod: 'REPLACING_CURRENT_DIMENSIONS_WITH',
  }));
  const calls = [];
  const page = { resize: (...args) => calls.push(args) };
  const app = { documents: { length: 1 }, activeDocument: { pages: collection([page]) } };
  const indesign = {
    CoordinateSpaces: { PAGE_COORDINATES: Symbol('page') },
    AnchorPoint: { CENTER_ANCHOR: Symbol('center') },
    ResizeMethods: { REPLACING_CURRENT_DIMENSIONS_WITH: Symbol('replace') },
  };

  const result = await runGeneratedCode(code, { app, indesign });
  assert.equal(result.success, true);
  assert.deepEqual(calls, [[
    indesign.CoordinateSpaces.PAGE_COORDINATES,
    indesign.AnchorPoint.CENTER_ANCHOR,
    indesign.ResizeMethods.REPLACING_CURRENT_DIMENSIONS_WITH,
    [595, 842],
  ]]);
});

test('place_file_on_page et place_xml_on_page utilisent les signatures Adobe exactes', async () => {
  const fileCode = await captureGeneratedCode(() => PageHandlers.placeFileOnPage({
    pageIndex: 0,
    filePath: 'C:\\Assets\\visuel.png',
    x: 12,
    y: 18,
    layerName: 'Images',
    showingOptions: true,
    autoflowing: false,
  }));
  const xmlCode = await captureGeneratedCode(() => PageHandlers.placeXmlOnPage({
    pageIndex: 0,
    xmlElementName: 'Article',
    x: 7,
    y: 9,
    autoflowing: true,
  }));
  const layer = { isValid: true, name: 'Images' };
  const xmlElement = { isValid: true, name: 'Article' };
  const calls = [];
  const page = {
    place: async (...args) => { calls.push(['file', ...args]); return [{ id: 41 }]; },
    placeXML: async (...args) => { calls.push(['xml', ...args]); return { id: 42 }; },
  };
  const doc = {
    pages: collection([page]),
    layers: { itemByName: (name) => { assert.equal(name, 'Images'); return layer; } },
    xmlElements: { itemByName: (name) => { assert.equal(name, 'Article'); return xmlElement; } },
  };
  const app = { documents: { length: 1 }, activeDocument: doc };

  const fileResult = await runGeneratedCode(fileCode, { app });
  const xmlResult = await runGeneratedCode(xmlCode, { app });
  assert.deepEqual(calls, [
    ['file', 'C:\\Assets\\visuel.png', ['12mm', '18mm'], layer, true, false],
    ['xml', xmlElement, ['7mm', '9mm'], true],
  ]);
  assert.deepEqual(fileResult.itemIds, ['41']);
  assert.equal(xmlResult.itemId, '42');
  assert.match(xmlCode, /page\.placeXML/);
  assert.doesNotMatch(xmlCode, /page\.place\(/);
});

test('snapshot_page_layout et zoom_to_page utilisent Page et LayoutWindow officiels', async () => {
  const snapshotCode = await captureGeneratedCode(() => PageHandlers.snapshotPageLayout({ pageIndex: 1 }));
  const zoomCode = await captureGeneratedCode(() => DocumentHandlers.zoomToPage({ pageIndex: 1, zoomLevel: 125 }));
  let snapshots = 0;
  const pages = [{}, { snapshotCurrentLayout: () => { snapshots += 1; } }];
  const layoutWindow = { isValid: true, activePage: undefined, zoomPercentage: 0 };
  const decoyWindow = { isValid: true, activePage: 'leurre', zoomPercentage: 50 };
  const app = {
    documents: { length: 1 },
    activeDocument: { pages: collection(pages), layoutWindows: collection([layoutWindow]) },
    activeWindow: decoyWindow,
  };

  await runGeneratedCode(snapshotCode, { app });
  const zoomResult = await runGeneratedCode(zoomCode, { app });
  assert.equal(snapshots, 1);
  assert.equal(layoutWindow.activePage, pages[1]);
  assert.equal(layoutWindow.zoomPercentage, 125);
  assert.equal(decoyWindow.activePage, 'leurre');
  assert.equal(decoyWindow.zoomPercentage, 50);
  assert.equal(zoomResult.success, true);
  assert.doesNotMatch(zoomCode, /app\.activeWindow/);
  assert.doesNotMatch(zoomCode, /zoomToFit/);
});

test('select_spread utilise la fenêtre appartenant au document demandé', async () => {
  const code = await captureGeneratedCode(() => handleLegacyMissing('select_spread', { spreadIndex: 0 }));
  const spread = { id: 81 };
  const layoutWindow = { isValid: true, activeSpread: null };
  const decoyWindow = { isValid: true, activeSpread: { id: 999 } };
  const doc = {
    spreads: collection([spread]),
    layoutWindows: collection([layoutWindow]),
  };

  const result = await runGeneratedCode(code, {
    app: { activeDocument: doc, activeWindow: decoyWindow },
  });

  assert.equal(result.success, true);
  assert.equal(layoutWindow.activeSpread, spread);
  assert.equal(decoyWindow.activeSpread.id, 999);
  assert.doesNotMatch(code, /app\.activeWindow/);
});

test('les guides et placements de spread suivent l’ordre des paramètres Adobe', async () => {
  const guidesCode = await captureGeneratedCode(() => handleLegacyMissing('create_spread_guides', {
    spreadIndex: 0,
    numberOfRows: 2,
    numberOfColumns: 3,
    rowGutter: 4,
    columnGutter: 6,
    guideColor: 'BLUE',
    fitMargins: true,
    removeExisting: true,
    layerName: 'Guides',
  }));
  const fileCode = await captureGeneratedCode(() => handleLegacyMissing('place_file_on_spread', {
    spreadIndex: 0,
    filePath: 'C:\\Assets\\plan.pdf',
    x: 1,
    y: 2,
    layerName: 'Imports',
    showingOptions: false,
    autoflowing: true,
  }));
  const xmlCode = await captureGeneratedCode(() => handleLegacyMissing('place_xml_on_spread', {
    spreadIndex: 0,
    xmlElementName: 'Catalogue',
    x: 3,
    y: 5,
    autoflowing: false,
  }));
  const guideLayer = { isValid: true };
  const importLayer = { isValid: true };
  const xmlElement = { isValid: true };
  const calls = [];
  const spread = {
    createGuides: (...args) => calls.push(['guides', ...args]),
    place: async (...args) => { calls.push(['file', ...args]); return [{ id: 7 }, { id: 8 }]; },
    placeXML: async (...args) => { calls.push(['xml', ...args]); return { id: 9 }; },
  };
  const doc = {
    spreads: collection([spread]),
    layers: { itemByName: (name) => name === 'Guides' ? guideLayer : importLayer },
    xmlElements: { itemByName: () => xmlElement },
  };
  const app = { activeDocument: doc };
  const UIColors = { BLUE: Symbol('blue') };

  await runGeneratedCode(guidesCode, { app, indesign: { UIColors } });
  const fileResult = await runGeneratedCode(fileCode, { app });
  const xmlResult = await runGeneratedCode(xmlCode, { app });
  assert.deepEqual(calls, [
    ['guides', 2, 3, '4mm', '6mm', UIColors.BLUE, true, true, guideLayer],
    ['file', 'C:\\Assets\\plan.pdf', ['1mm', '2mm'], importLayer, false, true],
    ['xml', xmlElement, ['3mm', '5mm'], false],
  ]);
  assert.deepEqual(fileResult.itemIds, ['7', '8']);
  assert.equal(xmlResult.itemId, '9');
});

test('detach_master_items crée de vrais overrides puis les détache', async () => {
  const code = await captureGeneratedCode(() => handleLegacyMissing('detach_master_items', { pageIndex: 0 }));
  const actions = [];
  const page = {};
  const masterItems = [11, 12].map((id) => ({
    override(destinationPage) {
      assert.equal(destinationPage, page);
      actions.push(`override:${id}`);
      return { id: id + 100, detach: () => actions.push(`detach:${id + 100}`) };
    },
  }));
  page.masterPageItems = masterItems;
  const app = { activeDocument: { pages: collection([page]) } };

  const result = await runGeneratedCode(code, { app });
  assert.deepEqual(actions, ['override:11', 'detach:111', 'override:12', 'detach:112']);
  assert.deepEqual(result.itemIds, ['111', '112']);
  assert.equal(result.count, 2);
});

test('export_epub utilise ExportFormat.EPUB et restaure la préférence CSS', async () => {
  const code = await captureGeneratedCode(() => handleLegacyMissing('export_epub', {
    filePath: 'C:\\Exports\\livret.epub',
    includeImages: true,
    includeStyles: false,
  }));
  const preferences = { isValid: true, generateCascadeStyleSheet: true };
  const exportCalls = [];
  const doc = {
    epubExportPreferences: preferences,
    exportFile: async (...args) => {
      exportCalls.push(args);
      assert.equal(preferences.generateCascadeStyleSheet, false);
    },
  };
  const EPUB = Symbol('EPUB');

  const result = await runGeneratedCode(code, {
    app: { activeDocument: doc },
    indesign: { ExportFormat: { EPUB } },
  });
  assert.equal(result.success, true);
  assert.deepEqual(exportCalls, [[EPUB, 'C:\\Exports\\livret.epub', false]]);
  assert.equal(preferences.generateCascadeStyleSheet, true);
  assert.match(code, /ExportFormat\.EPUB/);
  assert.doesNotMatch(code, /ExportFormat\.epub/);
});

test('les schémas publics imposent les paramètres réellement consommés', () => {
  const tools = new Map(buildToolCatalog().map((tool) => [tool.name, tool]));
  const adjust = tools.get('adjust_page_layout').inputSchema;
  const resize = tools.get('resize_page').inputSchema;
  const guides = tools.get('create_spread_guides').inputSchema;
  const epub = tools.get('export_epub').inputSchema;
  assert.equal('bleedTop' in adjust.properties, false);
  assert.ok(adjust.anyOf.some((entry) => entry.required.includes('width')));
  assert.ok(resize.required.includes('width'));
  assert.ok(resize.required.includes('height'));
  assert.equal(guides.properties.numberOfRows.type, 'integer');
  assert.equal(epub.properties.includeImages.const, true);
});

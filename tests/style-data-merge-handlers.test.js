import assert from 'node:assert/strict';
import test from 'node:test';
import { ScriptExecutor } from '../src/core/scriptExecutor.js';
import { DocumentHandlers } from '../src/handlers/documentHandlers.js';
import { StyleHandlers } from '../src/handlers/styleHandlers.js';
import { LEGACY_PATH_RULES } from '../src/security/legacyPathRules.js';
import { buildToolCatalog } from '../src/tools/catalog.js';

async function captureGeneratedCode(t, operation) {
  const original = ScriptExecutor.executeViaUXP;
  let generatedCode = '';
  ScriptExecutor.executeViaUXP = async (code) => {
    generatedCode = code;
    return { success: true };
  };
  t.after(() => { ScriptExecutor.executeViaUXP = original; });
  await operation();
  assert.notEqual(generatedCode, '');
  return generatedCode;
}

async function runGeneratedCode(code, { app, modules = {} }) {
  const execute = new Function('app', 'targetDocument', 'require', `return (async () => {${code}})();`);
  return execute(app, app.activeDocument, (name) => {
    assert.ok(Object.hasOwn(modules, name), `module UXP inattendu: ${name}`);
    return modules[name];
  });
}

function collection(values) {
  return {
    get length() { return values.length; },
    item(index) { return values[index]; },
  };
}

test('les contrats apply_color et data_merge ne déclarent que des cibles et options réelles', () => {
  const tools = new Map(buildToolCatalog().map((tool) => [tool.name, tool]));
  const applyColor = tools.get('apply_color').inputSchema;
  assert.deepEqual(
    ['pageIndex', 'objectIndex', 'colorName'].every((field) => applyColor.required.includes(field)),
    true,
  );
  assert.equal(applyColor.properties.pageIndex.type, 'integer');
  assert.equal(applyColor.properties.pageIndex.minimum, 0);
  assert.equal(applyColor.properties.objectIndex.type, 'integer');
  assert.equal(applyColor.properties.objectIndex.minimum, 0);
  assert.equal(applyColor.properties.frameIndex, undefined);
  assert.equal(applyColor.properties.targetType, undefined);

  for (const name of ['apply_paragraph_style', 'apply_character_style']) {
    const schema = tools.get(name).inputSchema;
    assert.ok(schema, name);
    for (const field of ['styleName', 'pageIndex', 'objectIndex']) assert.ok(schema.required.includes(field), `${name}: ${field}`);
    assert.equal(schema.properties.pageIndex.type, 'integer');
    assert.equal(schema.properties.objectIndex.type, 'integer');
    assert.equal(schema.properties.frameIndex, undefined);
  }

  const dataMerge = tools.get('data_merge').inputSchema;
  assert.deepEqual(
    Object.keys(dataMerge.properties).filter((field) => !['documentId', 'expectedRevision', 'expectedStateToken', 'scope', 'reason'].includes(field)).sort(),
    ['dataSource', 'linkImages', 'removeBlankLines'],
  );
  assert.equal(dataMerge.properties.targetPage, undefined);
  assert.equal(dataMerge.properties.createNewPages, undefined);
  assert.equal(dataMerge.properties.removeUnusedPages, undefined);
  assert.deepEqual(LEGACY_PATH_RULES.data_merge[0].extensions, ['.csv', '.txt']);

  assert.deepEqual(tools.get('get_document_elements').inputSchema.properties.elementType.enum, ['all', 'text', 'graphics', 'tables']);
});

test('apply_paragraph_style cible le pageItem exact et vérifie le premier paragraphe', async (t) => {
  const code = await captureGeneratedCode(t, () => StyleHandlers.applyParagraphStyle({
    styleName: 'Corps',
    pageIndex: 1,
    objectIndex: 0,
  }));
  const previous = { name: 'Ancien', isValid: true };
  const style = { name: 'Corps', isValid: true, equals: (other) => other === style };
  const decoyParagraph = { isValid: true, appliedParagraphStyle: previous, applyParagraphStyle: () => assert.fail('page leurre modifiée') };
  const targetParagraph = {
    isValid: true,
    appliedParagraphStyle: previous,
    applyParagraphStyle(actual, clearingOverrides) {
      assert.equal(actual, style);
      assert.equal(clearingOverrides, false);
      this.appliedParagraphStyle = actual;
    },
  };
  const decoy = { id: 10, isValid: true, paragraphs: collection([decoyParagraph]) };
  const target = { id: 20, isValid: true, paragraphs: collection([targetParagraph]) };
  const doc = {
    pages: collection([
      { isValid: true, pageItems: collection([decoy]) },
      { isValid: true, pageItems: collection([target]) },
    ]),
    paragraphStyles: { itemByName: () => style },
  };

  const result = await runGeneratedCode(code, { app: { documents: { length: 1 }, activeDocument: doc } });
  assert.equal(result.success, true);
  assert.equal(result.pageIndex, 1);
  assert.equal(result.objectIndex, 0);
  assert.equal(result.pageItemId, 20);
  assert.equal(targetParagraph.appliedParagraphStyle, style);
  assert.equal(decoyParagraph.appliedParagraphStyle, previous);
  assert.doesNotMatch(code, /doc\.pages\.item\(0\)/);
});

test('apply_character_style est exposé et applique exactement la plage demandée', async (t) => {
  const code = await captureGeneratedCode(t, () => StyleHandlers.applyCharacterStyle({
    styleName: 'Emphase',
    pageIndex: 1,
    objectIndex: 0,
    startIndex: 2,
    endIndex: -1,
  }));
  const previous = { name: 'Sans', isValid: true };
  const style = { name: 'Emphase', isValid: true };
  const range = {
    isValid: true,
    appliedCharacterStyle: previous,
    applyCharacterStyle(actual) {
      assert.equal(actual, style);
      this.appliedCharacterStyle = actual;
    },
  };
  const text = {
    characters: {
      length: 5,
      itemByRange(start, end) {
        assert.equal(start, 2);
        assert.equal(end, 4);
        return range;
      },
    },
  };
  const decoy = { id: 10, isValid: true, texts: collection([]) };
  const target = { id: 20, isValid: true, texts: collection([text]) };
  const doc = {
    pages: collection([
      { isValid: true, pageItems: collection([decoy]) },
      { isValid: true, pageItems: collection([target]) },
    ]),
    characterStyles: { itemByName: () => style },
  };

  const result = await runGeneratedCode(code, { app: { documents: { length: 1 }, activeDocument: doc } });
  assert.equal(result.success, true);
  assert.equal(result.startIndex, 2);
  assert.equal(result.endIndex, 4);
  assert.equal(result.pageItemId, 20);
  assert.equal(range.appliedCharacterStyle, style);
  assert.doesNotMatch(code, /doc\.pages\.item\(0\)/);
});

test('get_document_elements refuse une catégorie inconnue au lieu d’un succès vide', async (t) => {
  const code = await captureGeneratedCode(t, () => DocumentHandlers.getDocumentElements({ elementType: 'unknown' }));
  const result = await runGeneratedCode(code, {
    app: { documents: { length: 1 }, activeDocument: {} },
  });
  assert.equal(result.success, false);
  assert.match(result.error, /unknown element type/i);
});

test('apply_color modifie uniquement le pageItem demandé sur la page demandée et vérifie le résultat', async (t) => {
  const code = await captureGeneratedCode(t, () => StyleHandlers.applyColor({
    pageIndex: 1,
    objectIndex: 0,
    colorName: 'Accent',
    colorType: 'STROKE',
  }));
  const none = { name: '[None]', isValid: true };
  const accent = { name: 'Accent', isValid: true, equals: (other) => other === accent };
  const decoy = { id: 10, isValid: true, fillColor: none, strokeColor: none };
  const target = { id: 20, isValid: true, fillColor: none, strokeColor: none };
  const pages = [
    { isValid: true, pageItems: collection([decoy]) },
    { isValid: true, pageItems: collection([target]) },
  ];
  const doc = {
    pages: collection(pages),
    swatches: { itemByName: (name) => { assert.equal(name, 'Accent'); return accent; } },
  };

  const result = await runGeneratedCode(code, {
    app: { documents: { length: 1 }, activeDocument: doc },
  });

  assert.equal(result.success, true);
  assert.equal(result.pageIndex, 1);
  assert.equal(result.objectIndex, 0);
  assert.equal(result.colorType, 'STROKE');
  assert.equal(result.pageItemId, 20);
  assert.equal(target.strokeColor, accent);
  assert.equal(target.fillColor, none);
  assert.equal(decoy.strokeColor, none);
  assert.doesNotMatch(code, /doc\.pages\.item\(0\)/);
});

test('apply_color refuse un faux succès lorsque le DOM n’a pas conservé la nuance', async (t) => {
  const code = await captureGeneratedCode(t, () => StyleHandlers.applyColor({
    pageIndex: 0,
    objectIndex: 0,
    colorName: 'Accent',
    colorType: 'FILL',
  }));
  const none = { name: '[None]', isValid: true };
  const accent = { name: 'Accent', isValid: true };
  const target = { id: 20, isValid: true };
  Object.defineProperty(target, 'fillColor', {
    get: () => none,
    set: () => {},
  });
  const doc = {
    pages: collection([{ isValid: true, pageItems: collection([target]) }]),
    swatches: { itemByName: () => accent },
  };

  const result = await runGeneratedCode(code, {
    app: { documents: { length: 1 }, activeDocument: doc },
  });
  assert.equal(result.success, false);
  assert.match(result.error, /postcondition/i);
});

test('create_color_swatch applique réellement PROCESS ou SPOT et vérifie son modèle', async (t) => {
  const code = await captureGeneratedCode(t, () => StyleHandlers.createColorSwatch({
    name: 'Rouge spot',
    colorType: 'SPOT',
    red: 255,
    green: 0,
    blue: 0,
  }));
  const enumValue = (id) => ({ id, equals: (other) => other?.id === id });
  const ColorModel = { PROCESS: enumValue('process'), SPOT: enumValue('spot') };
  const ColorSpace = { CMYK: enumValue('cmyk') };
  let creationProperties;
  const doc = {
    colors: {
      add(properties) {
        creationProperties = properties;
        return { ...properties, isValid: true };
      },
    },
  };

  const result = await runGeneratedCode(code, {
    app: { documents: { length: 1 }, activeDocument: doc },
    modules: { indesign: { ColorModel, ColorSpace } },
  });
  assert.equal(result.success, true);
  assert.equal(result.colorType, 'SPOT');
  assert.equal(creationProperties.model, ColorModel.SPOT);
  assert.equal(creationProperties.space, ColorSpace.CMYK);
  assert.deepEqual(creationProperties.colorValue, [0, 100, 100, 0]);
});

test('data_merge utilise le File UXP autorisé, les placeholders natifs et crée un document vérifié', async (t) => {
  const code = await captureGeneratedCode(t, () => DocumentHandlers.dataMerge({
    dataSource: 'C:\\NexusData\\fusion.csv',
    removeBlankLines: true,
    linkImages: false,
  }));
  const documents = [];
  const options = { isValid: true, createNewDocument: false, removeBlankLines: false, linkImages: true };
  let selected = false;
  let mergeCalls = 0;
  const dataMergeProperties = {
    isValid: true,
    dataMergeFields: { length: 2 },
    async selectDataSource(entry) {
      assert.equal(entry.isFile, true);
      selected = true;
    },
    async mergeRecords(...args) {
      assert.deepEqual(args, []);
      assert.equal(selected, true);
      assert.equal(options.createNewDocument, true);
      assert.equal(options.removeBlankLines, true);
      assert.equal(options.linkImages, false);
      mergeCalls += 1;
      documents.push({ id: 202, isValid: true, pages: { length: 3 } });
    },
  };
  const target = {
    id: 101,
    isValid: true,
    pages: { length: 1 },
    dataMergeProperties,
    dataMergeOptions: options,
    dataMergeTextPlaceholders: { length: 1 },
    dataMergeImagePlaceholders: { length: 1 },
    dataMergeQrcodePlaceholders: { length: 0 },
    get dataMerge() { assert.fail('doc.dataMerge ne doit jamais être lu'); },
  };
  documents.push(target);
  const fileSystem = {
    async getEntryWithUrl(url) {
      assert.match(url, /^file:\/\/\/C:\/NexusData\/fusion\.csv$/i);
      return { isFile: true, nativePath: 'C:\\NexusData\\fusion.csv' };
    },
  };

  const result = await runGeneratedCode(code, {
    app: { documents: collection(documents), activeDocument: target },
    modules: { uxp: { storage: { localFileSystem: fileSystem } } },
  });

  assert.equal(result.success, true);
  assert.equal(result.dataSourceSelected, true);
  assert.equal(result.fieldCount, 2);
  assert.equal(result.placeholderCount, 2);
  assert.equal(mergeCalls, 1);
  assert.deepEqual(result.mergedDocuments, [{ documentId: 202, pageCount: 3 }]);
  assert.match(code, /dataMergeProperties\.selectDataSource|dataMerge\.selectDataSource/);
  assert.match(code, /dataMerge\.mergeRecords\(\)/);
  assert.doesNotMatch(code, /doc\.dataMerge\s*\(/);
});

test('data_merge refuse avant sélection une maquette sans placeholder InDesign natif', async (t) => {
  const code = await captureGeneratedCode(t, () => DocumentHandlers.dataMerge({
    dataSource: 'C:\\NexusData\\fusion.csv',
  }));
  let sourceSelections = 0;
  const target = {
    id: 101,
    isValid: true,
    dataMergeProperties: {
      isValid: true,
      dataMergeFields: { length: 1 },
      selectDataSource: () => { sourceSelections += 1; },
      mergeRecords: () => assert.fail('la fusion ne doit pas commencer'),
    },
    dataMergeOptions: { isValid: true },
    dataMergeTextPlaceholders: { length: 0 },
    dataMergeImagePlaceholders: { length: 0 },
    dataMergeQrcodePlaceholders: { length: 0 },
  };

  const result = await runGeneratedCode(code, {
    app: { documents: collection([target]), activeDocument: target },
    modules: { uxp: { storage: { localFileSystem: {} } } },
  });
  assert.equal(result.success, false);
  assert.match(result.error, /native InDesign data merge placeholder/i);
  assert.equal(sourceSelections, 0);
});

test('data_merge refuse un succès non prouvé si aucun nouveau document n’apparaît', async (t) => {
  const code = await captureGeneratedCode(t, () => DocumentHandlers.dataMerge({
    dataSource: 'C:\\NexusData\\fusion.csv',
  }));
  const target = {
    id: 101,
    isValid: true,
    pages: { length: 1 },
    dataMergeProperties: {
      isValid: true,
      dataMergeFields: { length: 1 },
      selectDataSource: async () => {},
      mergeRecords: async () => {},
    },
    dataMergeOptions: { isValid: true },
    dataMergeTextPlaceholders: { length: 1 },
    dataMergeImagePlaceholders: { length: 0 },
    dataMergeQrcodePlaceholders: { length: 0 },
  };

  const result = await runGeneratedCode(code, {
    app: { documents: collection([target]), activeDocument: target },
    modules: { uxp: { storage: { localFileSystem: { getEntryWithUrl: async () => ({ isFile: true }) } } } },
  });
  assert.equal(result.success, false);
  assert.match(result.error, /no verifiable document/i);
});

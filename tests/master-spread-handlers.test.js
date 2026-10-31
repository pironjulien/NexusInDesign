import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { ScriptExecutor } from '../src/core/scriptExecutor.js';
import { MasterSpreadHandlers } from '../src/handlers/masterSpreadHandlers.js';
import { masterSpreadToolDefinitions } from '../src/types/toolDefinitionsMasterSpread.js';

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

function invalidSpecifier() {
  return { isValid: false };
}

function createMasterSpreadCollection(initial = []) {
  const spreads = [];
  let nextId = 100;
  let nextPrefixCode = 'A'.charCodeAt(0);
  let lastDuplicateCall;

  const collection = {
    get length() { return spreads.length; },
    item: (index) => spreads[index] ?? invalidSpecifier(),
    itemByName: (name) => spreads.find((spread) => spread.isValid && spread.name === name) ?? invalidSpecifier(),
    add: () => {
      const spread = makeSpread({ namePrefix: String.fromCharCode(nextPrefixCode++), baseName: 'Master' });
      spreads.push(spread);
      return spread;
    },
  };

  function makeSpread({ namePrefix, baseName }) {
    const textFrames = [];
    const rectangles = [];
    const guides = [];
    const page = {
      isValid: true,
      textFrames: {
        add: () => {
          const text = {};
          const frame = { id: nextId++, isValid: true, texts: { item: () => text } };
          textFrames.push(frame);
          return frame;
        },
      },
      rectangles: {
        add: () => {
          const rectangle = { id: nextId++, isValid: true };
          rectangles.push(rectangle);
          return rectangle;
        },
      },
    };
    const spread = {
      id: nextId++,
      isValid: true,
      namePrefix,
      baseName,
      pageColor: null,
      showMasterItems: true,
      primaryTextFrame: invalidSpecifier(),
      pages: { length: 1, item: (index) => index === 0 ? page : invalidSpecifier() },
      textFrames: { get length() { return textFrames.length; } },
      rectangles: { get length() { return rectangles.length; } },
      ovals: { length: 0 },
      polygons: { length: 0 },
      groups: { length: 0 },
      guides: { get length() { return guides.length; }, item: (index) => guides[index] ?? invalidSpecifier() },
      allPageItems: { get length() { return textFrames.length + rectangles.length; } },
      get name() { return `${this.namePrefix}-${this.baseName}`; },
      get index() { return spreads.indexOf(this); },
      remove() {
        const index = spreads.indexOf(this);
        if (index >= 0) spreads.splice(index, 1);
        this.isValid = false;
      },
      duplicate(location, reference) {
        const duplicate = makeSpread({ namePrefix: String.fromCharCode(nextPrefixCode++), baseName: this.baseName });
        lastDuplicateCall = { location, reference, duplicate };
        if (location === 'AT_BEGINNING') spreads.unshift(duplicate);
        else if (location === 'BEFORE') spreads.splice(spreads.indexOf(reference), 0, duplicate);
        else if (location === 'AFTER') spreads.splice(spreads.indexOf(reference) + 1, 0, duplicate);
        else spreads.push(duplicate);
        return duplicate;
      },
      createGuides(...args) {
        guides.push({ id: nextId++, itemLayer: args[7], args });
      },
      _textFrames: textFrames,
      _rectangles: rectangles,
      _guides: guides,
    };
    return spread;
  }

  for (const entry of initial) {
    const separator = entry.indexOf('-');
    const namePrefix = separator === -1 ? String.fromCharCode(nextPrefixCode++) : entry.slice(0, separator);
    const baseName = separator === -1 ? entry : entry.slice(separator + 1);
    spreads.push(makeSpread({ namePrefix, baseName }));
    nextPrefixCode = Math.max(nextPrefixCode, namePrefix.charCodeAt(0) + 1);
  }

  return { collection, spreads, get lastDuplicateCall() { return lastDuplicateCall; } };
}

function createSwatches(names) {
  const values = new Map(names.map((name, index) => [name, { id: index + 1, name, isValid: true }]));
  return { itemByName: (name) => values.get(name) ?? invalidSpecifier() };
}

test('delete et get ciblent le vrai nom avec itemByName et vérifient la suppression', async () => {
  const masters = createMasterSpreadCollection(['A-Source', 'B-Référence']);
  const app = { documents: { length: 1 }, activeDocument: { masterSpreads: masters.collection } };

  const deleteCode = await captureGeneratedCode(() => MasterSpreadHandlers.deleteMasterSpread({ name: 'A-Source' }));
  const deleted = await runGeneratedCode(deleteCode, { app });
  assert.equal(deleted.success, true);
  assert.equal(deleted.deletedName, 'A-Source');
  assert.equal(deleted.postconditionVerified, true);
  assert.deepEqual(masters.spreads.map((spread) => spread.name), ['B-Référence']);
  assert.match(deleteCode, /itemByName\(requestedName\)/);

  const getCode = await captureGeneratedCode(() => MasterSpreadHandlers.getMasterSpreadInfo({ name: 'B-Référence' }));
  const info = await runGeneratedCode(getCode, { app });
  assert.equal(info.success, true);
  assert.equal(info.name, 'B-Référence');
  assert.equal(info.index, 0);
  assert.match(getCode, /if \(!ms\.isValid\)/);
});

test('duplicate utilise newName, referenceName et les LocationOptions Adobe en majuscules', async () => {
  const masters = createMasterSpreadCollection(['A-Source', 'B-Référence']);
  const app = { documents: { length: 1 }, activeDocument: { masterSpreads: masters.collection } };
  const LocationOptions = {
    AT_END: 'AT_END',
    AT_BEGINNING: 'AT_BEGINNING',
    BEFORE: 'BEFORE',
    AFTER: 'AFTER',
  };

  const code = await captureGeneratedCode(() => MasterSpreadHandlers.duplicateMasterSpread({
    name: 'A-Source',
    newName: 'Copie',
    position: 'BEFORE',
    referenceName: 'B-Référence',
  }));
  const result = await runGeneratedCode(code, { app, indesign: { LocationOptions } });

  assert.equal(result.success, true);
  assert.equal(result.baseName, 'Copie');
  assert.equal(result.index, 1);
  assert.equal(result.postconditionVerified, true);
  assert.equal(masters.lastDuplicateCall.location, LocationOptions.BEFORE);
  assert.equal(masters.lastDuplicateCall.reference.name, 'B-Référence');
  assert.deepEqual(masters.spreads.map((spread) => spread.name), ['A-Source', 'C-Copie', 'B-Référence']);
  assert.doesNotMatch(code, /LocationOptions\.(?:atEnd|atBeginning|before|after)/);
});

test('create_master_spread applique réellement pageColor et contrôle sa postcondition', async () => {
  const masters = createMasterSpreadCollection();
  const app = { documents: { length: 1 }, activeDocument: { masterSpreads: masters.collection } };
  const UIColors = { RED: 1767007588 };
  const code = await captureGeneratedCode(() => MasterSpreadHandlers.createMasterSpread({
    name: 'Titre',
    namePrefix: 'T',
    pageColor: 'RED',
  }));

  const result = await runGeneratedCode(code, { app, indesign: { UIColors } });
  assert.equal(result.success, true);
  assert.equal(result.name, 'T-Titre');
  assert.equal(result.pageColor, UIColors.RED);
  assert.equal(result.postconditionVerified, true);
});

test('le cadre texte applique justification, nuance, police et cadre principal réels', async () => {
  const masters = createMasterSpreadCollection(['A-Master']);
  const masterSpread = masters.spreads[0];
  const font = { isValid: true, fontFamily: 'Arial', fontStyleName: 'Regular' };
  const app = {
    documents: { length: 1 },
    fonts: { length: 1, itemByName: (name) => name === 'Arial\tRegular' ? font : invalidSpecifier(), item: () => font },
    activeDocument: {
      masterSpreads: masters.collection,
      swatches: createSwatches(['Accent']),
      viewPreferences: { horizontalMeasurementUnits: 'PICAS', verticalMeasurementUnits: 'INCHES' },
    },
  };
  const Justification = {
    LEFT_ALIGN: 1,
    CENTER_ALIGN: 2,
    RIGHT_ALIGN: 3,
    FULLY_JUSTIFIED: 4,
  };
  const MeasurementUnits = { MILLIMETERS: 'MILLIMETERS' };
  const code = await captureGeneratedCode(() => MasterSpreadHandlers.createMasterTextFrame({
    masterName: 'A-Master',
    content: 'Texte',
    x: 10,
    y: 20,
    width: 100,
    height: 40,
    fontSize: 11,
    fontFamily: 'Arial',
    fontStyle: 'Regular',
    textColor: 'Accent',
    alignment: 'JUSTIFY',
    isPrimaryTextFrame: true,
  }));

  const result = await runGeneratedCode(code, { app, indesign: { Justification, MeasurementUnits } });
  const frame = masterSpread._textFrames[0];
  const text = frame.texts.item(0);
  assert.equal(result.success, true);
  assert.equal(text.justification, Justification.FULLY_JUSTIFIED);
  assert.equal(text.fillColor.name, 'Accent');
  assert.equal(text.appliedFont, font);
  assert.equal(masterSpread.primaryTextFrame, frame);
  assert.deepEqual(result.geometricBounds, [20, 10, 60, 110]);
  assert.equal(app.activeDocument.viewPreferences.horizontalMeasurementUnits, 'PICAS');
  assert.equal(app.activeDocument.viewPreferences.verticalMeasurementUnits, 'INCHES');
  assert.match(code, /Justification\.FULLY_JUSTIFIED/);
});

test('le rectangle respecte strokeWidth et applique réellement les coins arrondis', async () => {
  const masters = createMasterSpreadCollection(['A-Master']);
  const masterSpread = masters.spreads[0];
  const app = {
    documents: { length: 1 },
    activeDocument: {
      masterSpreads: masters.collection,
      swatches: createSwatches(['[None]', '[Black]']),
      viewPreferences: { horizontalMeasurementUnits: 'PICAS', verticalMeasurementUnits: 'INCHES' },
    },
  };
  const CornerOptions = { ROUNDED_CORNER: 1667592804 };
  const MeasurementUnits = { MILLIMETERS: 'MILLIMETERS' };
  const code = await captureGeneratedCode(() => MasterSpreadHandlers.createMasterRectangle({
    masterName: 'A-Master',
    x: 1,
    y: 2,
    width: 30,
    height: 40,
    fillColor: 'None',
    strokeColor: 'Black',
    strokeWidth: 2.5,
    cornerRadius: 3,
  }));

  const result = await runGeneratedCode(code, { app, indesign: { CornerOptions, MeasurementUnits } });
  const rectangle = masterSpread._rectangles[0];
  assert.equal(result.success, true);
  assert.equal(rectangle.strokeWeight, 2.5);
  assert.equal(rectangle.topLeftCornerOption, CornerOptions.ROUNDED_CORNER);
  assert.equal(rectangle.bottomRightCornerRadius, 3);
  assert.equal(result.strokeWidth, 2.5);
  assert.deepEqual(result.geometricBounds, [2, 1, 42, 31]);
  assert.equal(app.activeDocument.viewPreferences.horizontalMeasurementUnits, 'PICAS');
  assert.equal(app.activeDocument.viewPreferences.verticalMeasurementUnits, 'INCHES');
  assert.doesNotMatch(code, /const \{[^}]*strokeWeight/);
});

test('les guides utilisent UIColors et transmettent le vrai calque', async () => {
  const masters = createMasterSpreadCollection(['A-Master']);
  const masterSpread = masters.spreads[0];
  const guideLayer = { id: 42, isValid: true, name: 'Repères' };
  const app = {
    documents: { length: 1 },
    activeDocument: {
      masterSpreads: masters.collection,
      layers: { itemByName: (name) => name === 'Repères' ? guideLayer : invalidSpecifier() },
    },
  };
  const UIColors = { BLUE: 1765960821 };
  const code = await captureGeneratedCode(() => MasterSpreadHandlers.createMasterGuides({
    masterName: 'A-Master',
    numberOfRows: 2,
    numberOfColumns: 3,
    rowGutter: 4,
    columnGutter: 5,
    guideColor: 'BLUE',
    fitMargins: true,
    removeExisting: false,
    layerName: 'Repères',
  }));

  const result = await runGeneratedCode(code, { app, indesign: { UIColors } });
  assert.equal(result.success, true);
  assert.equal(result.layerName, 'Repères');
  assert.deepEqual(masterSpread._guides[0].args, [2, 3, '4mm', '5mm', UIColors.BLUE, true, false, guideLayer]);
  assert.match(code, /UIColors\[colorKey\]/);
});

test('le schéma impose referenceName pour BEFORE/AFTER et reflète les vrais champs', () => {
  const definitions = new Map(masterSpreadToolDefinitions.map((definition) => [definition.name, definition]));
  const ajv = new Ajv2020({ strict: false, useDefaults: true });
  const duplicate = ajv.compile(definitions.get('duplicate_master_spread').inputSchema);
  assert.equal(duplicate({ name: 'A-Source', newName: 'Copie', position: 'BEFORE' }), false);
  assert.equal(duplicate({ name: 'A-Source', newName: 'Copie', position: 'AFTER', referenceName: 'B-Référence' }), true);

  const rectangleProperties = definitions.get('create_master_rectangle').inputSchema.properties;
  assert.ok(rectangleProperties.strokeWidth);
  assert.equal(rectangleProperties.strokeWeight, undefined);
  assert.ok(definitions.get('create_master_text_frame').inputSchema.properties.alignment.enum.includes('JUSTIFY'));

  const guides = ajv.compile(definitions.get('create_master_guides').inputSchema);
  assert.equal(guides({ masterName: 'A-Master' }), false);
  assert.equal(guides({ masterName: 'A-Master', numberOfColumns: 2 }), true);
});

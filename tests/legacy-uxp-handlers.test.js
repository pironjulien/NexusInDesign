import assert from 'node:assert/strict';
import test from 'node:test';
import { ScriptExecutor } from '../src/core/scriptExecutor.js';
import { DocumentHandlers } from '../src/handlers/documentHandlers.js';
import { StyleHandlers } from '../src/handlers/styleHandlers.js';
import { UtilityHandlers } from '../src/handlers/utilityHandlers.js';

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

async function runGeneratedCode(code, { app, indesign }) {
  const execute = new Function('app', 'targetDocument', 'require', `return (async () => {${code}})();`);
  return execute(app, app.activeDocument, (name) => {
    assert.equal(name, 'indesign');
    return indesign;
  });
}

test('view_document lit la fenêtre appartenant au document demandé', async (t) => {
  const code = await captureGeneratedCode(t, () => UtilityHandlers.viewDocument());
  const targetWindow = {
    isValid: true,
    zoomPercentage: 175,
    overprintPreview: true,
  };
  const decoyWindow = {
    isValid: true,
    zoomPercentage: 25,
    overprintPreview: false,
  };
  const page = {
    name: '1',
    bounds: [0, 0, 100, 80],
    textFrames: { length: 0 },
    rectangles: { length: 0 },
    ovals: { length: 0 },
    polygons: { length: 0 },
  };
  const doc = {
    name: 'Cible.indd',
    activePage: page,
    pages: { length: 1, item: () => page },
    layoutWindows: { length: 1, item: () => targetWindow },
  };

  const result = await runGeneratedCode(code, {
    app: { documents: { length: 2 }, activeDocument: doc, activeWindow: decoyWindow },
    indesign: {},
  });

  assert.equal(result.success, true);
  assert.equal(result.zoom, 175);
  assert.equal(result.viewMode, true);
  assert.doesNotMatch(code, /app\.activeWindow/);
});

test('list_styles compare les énumérations DOM avec equals()', async (t) => {
  const code = await captureGeneratedCode(t, () => StyleHandlers.listStyles({ styleType: 'PARAGRAPH' }));
  const enumValue = (id) => ({ id, equals: (other) => other?.id === id });
  const Justification = {
    leftAlign: enumValue('left'),
    centerAlign: enumValue('center'),
    rightAlign: enumValue('right'),
    fullyJustified: enumValue('full'),
  };
  const paragraphStyle = {
    isValid: true,
    name: 'Corps',
    appliedFont: { isValid: true, name: 'Minion Pro' },
    pointSize: 10,
    justification: enumValue('left'),
    fillColor: { isValid: true, name: 'Noir' },
  };
  const app = {
    documents: { length: 1 },
    activeDocument: {
      paragraphStyles: { length: 1, item: () => paragraphStyle },
      characterStyles: { length: 0, item: () => null },
    },
  };

  const result = await runGeneratedCode(code, { app, indesign: { Justification } });
  assert.equal(result.paragraphStyles[0].alignment, 'LEFT_ALIGN');
  assert.match(code, /\.equals\(/);
});

test('organize_document_layers fusionne et trie réellement les calques', async (t) => {
  const code = await captureGeneratedCode(t, () => DocumentHandlers.organizeDocumentLayers({
    deleteEmptyLayers: false,
    mergeSimilarLayers: true,
    sortLayers: true,
  }));
  const layers = [];
  const makeLayer = (name, locked = false) => {
    const layer = {
      name,
      locked,
      isValid: true,
      pageItems: { length: 1 },
      merge(other) {
        const index = layers.indexOf(other);
        assert.notEqual(index, -1);
        layers.splice(index, 1);
        other.isValid = false;
        return this;
      },
      move(location) {
        assert.equal(location, 1);
        const index = layers.indexOf(this);
        layers.splice(index, 1);
        layers.unshift(this);
      },
      remove() {
        const index = layers.indexOf(this);
        layers.splice(index, 1);
        this.isValid = false;
      },
    };
    layers.push(layer);
    return layer;
  };
  makeLayer('Zeta');
  const body = makeLayer('Body');
  makeLayer('  body  ', true);
  makeLayer('Alpha');
  const app = {
    documents: { length: 1 },
    activeDocument: { layers: { get length() { return layers.length; }, item: (index) => layers[index] } },
  };

  const result = await runGeneratedCode(code, { app, indesign: { LocationOptions: { AT_BEGINNING: 1 } } });
  assert.deepEqual(layers.map((layer) => layer.name), ['Alpha', 'Body', 'Zeta']);
  assert.equal(body.locked, true);
  assert.equal(result.success, true);
  assert.equal(result.actions.length, 2);
  assert.doesNotMatch(code, /not implemented/i);
});

test('find_text_in_document utilise réellement GREP et sait remplacer par une chaîne vide', async (t) => {
  const code = await captureGeneratedCode(t, () => DocumentHandlers.findTextInDocument({
    searchText: 'chapitre\\s+\\d+',
    replaceText: '',
    caseSensitive: false,
    wholeWord: true,
    useRegex: true,
  }));
  const nothing = Symbol('nothing');
  let findGrepPreferences;
  let changeGrepPreferences;
  let observedPattern;
  const app = {
    documents: { length: 1 },
    findChangeTextOptions: {},
    get findGrepPreferences() { return findGrepPreferences; },
    set findGrepPreferences(value) { findGrepPreferences = value === nothing ? {} : value; },
    get changeGrepPreferences() { return changeGrepPreferences; },
    set changeGrepPreferences(value) { changeGrepPreferences = value === nothing ? {} : value; },
  };
  app.activeDocument = {
    changeGrep: () => {
      observedPattern = app.findGrepPreferences.findWhat;
      assert.equal(app.changeGrepPreferences.changeTo, '');
      return [{}, {}];
    },
  };

  const result = await runGeneratedCode(code, { app, indesign: { NothingEnum: { nothing } } });
  assert.equal(result.mode, 'grep');
  assert.equal(result.action, 'replace');
  assert.equal(result.count, 2);
  assert.equal(observedPattern, '(?i)\\b(?:chapitre\\s+\\d+)\\b');
});

test('create_document_section applique le numéro initial et l’énumération Adobe', async (t) => {
  const code = await captureGeneratedCode(t, () => DocumentHandlers.createDocumentSection({
    startPage: 2,
    sectionPrefix: 'A-',
    startNumber: 7,
    numberingStyle: 'ROMAN_UPPER',
  }));
  const section = {};
  const page = { name: '3' };
  const app = {
    documents: { length: 1 },
    activeDocument: {
      pages: { item: (index) => { assert.equal(index, 2); return page; } },
      sections: { add: (target) => { assert.equal(target, page); return section; } },
    },
  };
  const PageNumberStyle = { ARABIC: 1, UPPER_ROMAN: 2, LOWER_ROMAN: 3, UPPER_LETTERS: 4, LOWER_LETTERS: 5 };

  const result = await runGeneratedCode(code, { app, indesign: { PageNumberStyle } });
  assert.equal(result.success, true);
  assert.equal(section.continueNumbering, false);
  assert.equal(section.pageNumberStart, 7);
  assert.equal(section.pageNumberStyle, PageNumberStyle.UPPER_ROMAN);
  assert.equal(section.sectionPrefix, 'A-');
  assert.equal(section.includeSectionPrefix, true);
});

test('create_document_hyperlink relie une vraie source texte à la destination', async (t) => {
  const code = await captureGeneratedCode(t, () => DocumentHandlers.createDocumentHyperlink({
    sourceText: 'OpenAI',
    destination: 'https://openai.com',
    linkType: 'URL',
  }));
  const nothing = Symbol('nothing');
  let findTextPreferences;
  const textRange = { id: 9 };
  const source = { isValid: true, remove: () => {} };
  const destination = { isValid: true, remove: () => {} };
  const doc = {
    findText: () => [textRange],
    hyperlinkTextSources: { add: (range) => { assert.equal(range, textRange); return source; } },
    hyperlinkURLDestinations: { add: (url) => { assert.equal(url, 'https://openai.com'); return destination; } },
    hyperlinks: { add: (actualSource, actualDestination) => {
      assert.equal(actualSource, source);
      assert.equal(actualDestination, destination);
      return { name: 'OpenAI' };
    } },
  };
  const app = {
    documents: { length: 1 },
    activeDocument: doc,
    get findTextPreferences() { return findTextPreferences; },
    set findTextPreferences(value) { findTextPreferences = value === nothing ? {} : value; },
  };

  const result = await runGeneratedCode(code, { app, indesign: { NothingEnum: { nothing } } });
  assert.equal(result.success, true);
  assert.equal(result.linkType, 'URL');
});

test('cleanup_document supprime réellement nuances, calques vides et éléments masqués', async (t) => {
  const code = await captureGeneratedCode(t, () => DocumentHandlers.cleanupDocument({
    removeUnusedStyles: false,
    removeUnusedColors: true,
    removeUnusedLayers: true,
    removeHiddenElements: true,
  }));
  let swatchRemoved = false;
  const unusedSwatches = [
    { name: '[Black]', isValid: true, remove: () => assert.fail('built-in swatch removed') },
    { name: 'Accent inutilisé', isValid: true, remove: () => { swatchRemoved = true; } },
  ];
  const layers = [];
  const contentLayer = { name: 'Contenu', locked: false, pageItems: { length: 1 } };
  const emptyLayer = {
    name: 'Vide', locked: true, pageItems: { length: 0 },
    remove: () => layers.splice(layers.indexOf(emptyLayer), 1),
  };
  layers.push(contentLayer, emptyLayer);
  let hiddenRemoved = false;
  const hiddenItem = {
    isValid: true, visible: false, locked: true, itemLayer: contentLayer,
    remove: () => { hiddenRemoved = true; },
  };
  const doc = {
    unusedSwatches,
    layers: { get length() { return layers.length; }, item: (index) => layers[index] },
    allPageItems: [hiddenItem],
  };
  const app = { documents: { length: 1 }, activeDocument: doc };

  const result = await runGeneratedCode(code, { app, indesign: {} });
  assert.equal(result.success, true);
  assert.equal(result.removedItems, 3);
  assert.equal(swatchRemoved, true);
  assert.equal(hiddenRemoved, true);
  assert.deepEqual(layers.map((layer) => layer.name), ['Contenu']);
});

test('get_document_stories utilise Story.overflows et n’invente pas de propriété hidden', async (t) => {
  const code = await captureGeneratedCode(t, () => DocumentHandlers.getDocumentStories({
    includeOverset: false,
  }));
  const story = (name, overflows) => new Proxy({ name, contents: `Texte ${name}`, overflows }, {
    get(target, property, receiver) {
      if (property === 'hidden' || property === 'overset') assert.fail(`propriété DOM inexistante lue: ${String(property)}`);
      return Reflect.get(target, property, receiver);
    },
  });
  const stories = [story('visible', false), story('débordant', true)];
  const app = {
    documents: { length: 1 },
    activeDocument: { stories: { length: stories.length, item: (index) => stories[index] } },
  };

  const result = await runGeneratedCode(code, { app, indesign: {} });
  assert.equal(result.success, true);
  assert.equal(result.count, 1);
  assert.deepEqual(result.stories[0], {
    name: 'visible',
    contents: 'Texte visible',
    overset: false,
    overflows: false,
  });
  assert.equal(result.hiddenStoryFilterSupported, false);
  assert.match(result.note, /no hidden flag/i);
  assert.doesNotMatch(code, /story\.(?:hidden|overset)\b/);
  assert.match(code, /story\.overflows\b/);
});

test('validate_document contrôle LinkStatus et FontStatus sans faux doublon de styles groupés', async (t) => {
  const code = await captureGeneratedCode(t, () => DocumentHandlers.validateDocument({
    checkLinks: true,
    checkFonts: true,
    checkImages: false,
    checkStyles: true,
  }));
  const enumValue = (id) => ({ id, equals: (other) => other?.id === id });
  const LinkStatus = {
    normal: enumValue('normal'),
    linkEmbedded: enumValue('embedded'),
    linkOutOfDate: enumValue('outdated'),
    linkMissing: enumValue('missing'),
    linkInaccessible: enumValue('inaccessible'),
  };
  const FontStatus = {
    INSTALLED: enumValue('installed'),
    NOT_AVAILABLE: enumValue('unavailable'),
    FAUXED: enumValue('fauxed'),
    SUBSTITUTED: enumValue('substituted'),
    UNKNOWN: enumValue('unknown'),
  };
  const collection = (values) => ({ length: values.length, item: (index) => values[index] });
  const namedStyle = { name: 'Corps', isValid: true };
  const doc = {
    links: collection([
      { name: 'normal.psd', isValid: true, status: enumValue('normal') },
      { name: 'intégré.ai', isValid: true, status: enumValue('embedded') },
      { name: 'ancien.pdf', isValid: true, status: enumValue('outdated') },
    ]),
    fonts: collection([
      { name: 'Source Sans 3 Regular', isValid: true, status: enumValue('installed') },
      { name: 'Police remplacée', isValid: true, status: enumValue('substituted') },
    ]),
    allParagraphStyles: [namedStyle, { ...namedStyle }],
    allCharacterStyles: [{ ...namedStyle }],
    allObjectStyles: [{ ...namedStyle }],
  };
  const app = { documents: { length: 1 }, activeDocument: doc };

  const result = await runGeneratedCode(code, { app, indesign: { LinkStatus, FontStatus } });
  assert.equal(result.success, true);
  assert.equal(result.isValid, false);
  assert.deepEqual(result.issues, [
    'Link status LINK_OUT_OF_DATE: ancien.pdf',
    'Font status SUBSTITUTED: Police remplacée',
  ]);
  assert.doesNotMatch(result.issues.join('\n'), /duplicate/i);
  assert.match(code, /LinkStatus\.NORMAL/);
  assert.match(code, /FontStatus\.INSTALLED/);
  assert.match(code, /\.equals\(/);
});

test('save_document_to_cloud refuse un lien non sain et accepte normal ou intégré', async (t) => {
  const code = await captureGeneratedCode(t, () => DocumentHandlers.saveDocumentToCloud({
    cloudName: 'Maquette',
    includeAssets: true,
  }));
  const enumValue = (id) => ({ id, equals: (other) => other?.id === id });
  const LinkStatus = {
    NORMAL: enumValue('normal'),
    LINK_EMBEDDED: enumValue('embedded'),
    LINK_OUT_OF_DATE: enumValue('outdated'),
    LINK_MISSING: enumValue('missing'),
    LINK_INACCESSIBLE: enumValue('inaccessible'),
  };
  const collection = (values) => ({ length: values.length, item: (index) => values[index] });
  let saves = 0;
  const unhealthyDocument = {
    links: collection([{ name: 'absent.tif', isValid: true, status: enumValue('missing') }]),
    isCloudDocument: false,
    saveACopyCloud: async () => { saves += 1; },
  };
  const unhealthyResult = await runGeneratedCode(code, {
    app: { documents: { length: 1 }, activeDocument: unhealthyDocument },
    indesign: { LinkStatus },
  });
  assert.equal(unhealthyResult.success, false);
  assert.match(unhealthyResult.error, /absent\.tif.*LINK_MISSING/);
  assert.equal(saves, 0);

  const healthyDocument = {
    links: collection([
      { name: 'normal.psd', isValid: true, status: enumValue('normal') },
      { name: 'intégré.ai', isValid: true, status: enumValue('embedded') },
    ]),
    isCloudDocument: false,
    saveACopyCloud: async (name) => { assert.equal(name, 'Maquette'); saves += 1; },
  };
  const healthyResult = await runGeneratedCode(code, {
    app: { documents: { length: 1 }, activeDocument: healthyDocument },
    indesign: { LinkStatus },
  });
  assert.equal(healthyResult.success, true);
  assert.equal(healthyResult.linkedAssetsVerified, 2);
  assert.equal(saves, 1);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { ScriptExecutor } from '../src/core/scriptExecutor.js';
import { PageHandlers } from '../src/handlers/pageHandlers.js';
import { pageToolDefinitions } from '../src/types/toolDefinitionsPage.js';

const LocationOptions = {
  AT_END: 'AT_END',
  AT_BEGINNING: 'AT_BEGINNING',
  BEFORE: 'BEFORE',
  AFTER: 'AFTER',
};
const BindingOptions = {
  DEFAULT_VALUE: 'DEFAULT_VALUE',
  LEFT_ALIGN: 'LEFT_ALIGN',
  RIGHT_ALIGN: 'RIGHT_ALIGN',
};

async function invoke(handler, args, app) {
  const original = ScriptExecutor.executeViaUXP;
  ScriptExecutor.executeViaUXP = async (code) => {
    const execute = new Function('app', 'targetDocument', 'require', `return (async () => {${code}})();`);
    return execute(app, app.activeDocument, (name) => {
      assert.equal(name, 'indesign');
      return { LocationOptions, BindingOptions };
    });
  };
  try {
    return await handler(args);
  } finally {
    ScriptExecutor.executeViaUXP = original;
  }
}

function pageFixture(count = 3) {
  const pages = [];
  let nextId = 1;
  let itemCalls = 0;
  let lastMove;

  const insertionIndex = (location, reference) => {
    if (location === LocationOptions.AT_BEGINNING) return 0;
    if (location === LocationOptions.BEFORE) return pages.indexOf(reference);
    if (location === LocationOptions.AFTER) return pages.indexOf(reference) + 1;
    return pages.length;
  };

  const makePage = (name) => ({
    id: nextId++,
    name,
    isValid: true,
    get documentOffset() { return pages.indexOf(this); },
    duplicate(location, reference) {
      const duplicate = makePage(`${this.name}-copie`);
      pages.splice(insertionIndex(location, reference), 0, duplicate);
      return duplicate;
    },
    move(location, reference, binding) {
      lastMove = { location, reference, binding };
      pages.splice(pages.indexOf(this), 1);
      pages.splice(insertionIndex(location, reference), 0, this);
      return this;
    },
  });

  const collection = {
    get length() { return pages.length; },
    item(index) { itemCalls += 1; return pages[index] ?? { isValid: false }; },
    add(location, reference) {
      const page = makePage(`P${nextId}`);
      pages.splice(insertionIndex(location, reference), 0, page);
      return page;
    },
  };
  for (let index = 0; index < count; index += 1) pages.push(makePage(`P${index + 1}`));
  const app = { documents: { length: 1 }, activeDocument: { pages: collection } };
  return {
    app,
    pages,
    get itemCalls() { return itemCalls; },
    get lastMove() { return lastMove; },
  };
}

test('add_page ne résout aucune référence pour AT_BEGINNING et vérifie la position', async () => {
  const fixture = pageFixture(2);
  const response = await invoke(PageHandlers.addPage, { position: 'AT_BEGINNING' }, fixture.app);

  assert.equal(response.success, true);
  assert.equal(response.result.pageIndex, 0);
  assert.equal(response.result.postconditionVerified, true);
  assert.equal(fixture.itemCalls, 0);
  assert.equal(fixture.pages.length, 3);
});

test('duplicate_page respecte BEFORE et la page de référence exacte', async () => {
  const fixture = pageFixture(3);
  const reference = fixture.pages[2];
  const response = await invoke(PageHandlers.duplicatePage, {
    pageIndex: 0,
    position: 'BEFORE',
    referencePageIndex: 2,
  }, fixture.app);

  assert.equal(response.success, true);
  assert.equal(response.result.postconditionVerified, true);
  assert.equal(fixture.pages[response.result.newPageIndex].name, 'P1-copie');
  assert.equal(response.result.newPageIndex + 1, reference.documentOffset);
});

test('move_page respecte AFTER, la référence et BindingOptions', async () => {
  const fixture = pageFixture(3);
  const moved = fixture.pages[0];
  const reference = fixture.pages[1];
  const response = await invoke(PageHandlers.movePage, {
    pageIndex: 0,
    position: 'AFTER',
    referencePageIndex: 1,
    binding: 'RIGHT_ALIGN',
  }, fixture.app);

  assert.equal(response.success, true);
  assert.equal(response.result.postconditionVerified, true);
  assert.equal(moved.documentOffset, reference.documentOffset + 1);
  assert.equal(fixture.lastMove.location, LocationOptions.AFTER);
  assert.equal(fixture.lastMove.reference, reference);
  assert.equal(fixture.lastMove.binding, BindingOptions.RIGHT_ALIGN);
});

test('les schémas refusent BEFORE/AFTER sans page de référence', () => {
  const definitions = new Map(pageToolDefinitions.map((definition) => [definition.name, definition]));
  const ajv = new Ajv2020({ strict: false });
  const add = ajv.compile(definitions.get('add_page').inputSchema);
  const duplicate = ajv.compile(definitions.get('duplicate_page').inputSchema);
  const move = ajv.compile(definitions.get('move_page').inputSchema);

  assert.equal(add({ position: 'BEFORE' }), false);
  assert.equal(duplicate({ pageIndex: 0, position: 'AFTER' }), false);
  assert.equal(move({ pageIndex: 0, position: 'BEFORE' }), false);
  assert.equal(move({ pageIndex: 0, position: 'BEFORE', referencePageIndex: 1 }), true);
});

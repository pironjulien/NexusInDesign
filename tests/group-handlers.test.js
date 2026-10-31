import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { ScriptExecutor } from '../src/core/scriptExecutor.js';
import { GroupHandlers } from '../src/handlers/groupHandlers.js';

function itemCollection(items) {
  return {
    get length() { return items.length; },
    item(index) { return items[index]; },
  };
}

function groupsCollection(items, createGroup) {
  return {
    get length() { return items.filter((item) => item.isValid !== false).length; },
    item(index) { return items.filter((item) => item.isValid !== false)[index]; },
    itemByID(id) { return items.find((item) => item.id === id) ?? { isValid: false }; },
    add(groupItems) {
      const group = createGroup(groupItems);
      items.push(group);
      return group;
    },
  };
}

async function invoke(handler, args, app) {
  const original = ScriptExecutor.executeViaUXP;
  ScriptExecutor.executeViaUXP = async (code) => Function('app', 'targetDocument', code)(app, app.activeDocument);
  try {
    return await handler(args);
  } finally {
    ScriptExecutor.executeViaUXP = original;
  }
}

function baseFixture() {
  const spread = { id: 10, constructor: { name: 'Spread' } };
  const page = { id: 20 };
  const documentGroups = [];
  let nextGroupId = 100;
  const createGroup = (members) => {
    const direct = [...members];
    const group = {
      id: nextGroupId++,
      name: '',
      visible: true,
      locked: false,
      isValid: true,
      parent: spread,
      parentPage: page,
      geometricBounds: [0, 0, 20, 20],
      constructor: { name: 'Group' },
      _direct: direct,
      get pageItems() { return itemCollection(direct); },
      get allPageItems() { return [...direct]; },
      ungroup() { this.isValid = false; for (const member of direct) member.parent = spread; },
    };
    for (const member of direct) member.parent = group;
    return group;
  };
  page.groups = groupsCollection(documentGroups, createGroup);
  page.allPageItems = [];
  const doc = {
    pages: { length: 1, item: () => page },
    groups: {
      itemByID(id) { return documentGroups.find((item) => item.id === id) ?? { isValid: false }; },
    },
  };
  const app = { documents: { length: 1 }, activeDocument: doc, selection: [] };
  return { app, doc, page, spread, documentGroups, createGroup };
}

function makePageItem(id, fixture) {
  return {
    id,
    isValid: true,
    locked: false,
    parent: fixture.spread,
    parentPage: fixture.page,
    constructor: { name: 'Rectangle' },
  };
}

test('create_group_from_items utilise uniquement l’API officielle page.groups.add', async () => {
  const fixture = baseFixture();
  const first = makePageItem(1, fixture);
  const second = makePageItem(2, fixture);
  fixture.page.allPageItems = [first, second];
  first.group = () => { throw new Error('API PageItem.group interdite'); };

  const response = await invoke(
    GroupHandlers.createGroupFromItems,
    { pageIndex: 0, itemIndices: [0, 1] },
    fixture.app,
  );

  assert.equal(response.success, true);
  assert.equal(response.result.itemCount, 2);
  assert.equal(fixture.documentGroups.length, 1);
});

test('create_group lit la sélection de la fenêtre du document demandé', async () => {
  const fixture = baseFixture();
  const first = makePageItem(1, fixture);
  const second = makePageItem(2, fixture);
  fixture.page.allPageItems = [first, second];
  fixture.doc.layoutWindows = itemCollection([{
    isValid: true,
    selection: [first, second],
  }]);
  fixture.app.selection = [
    { id: 91, isValid: true, parentPage: { id: 999 } },
    { id: 92, isValid: true, parentPage: { id: 999 } },
  ];

  const response = await invoke(GroupHandlers.createGroup, { pageIndex: 0 }, fixture.app);

  assert.equal(response.success, true);
  assert.equal(response.result.itemCount, 2);
  assert.deepEqual(fixture.documentGroups[0]._direct, [first, second]);
});

test('une forme ordinaire ne peut plus être confondue avec un groupe', async () => {
  const fixture = baseFixture();
  const rectangle = makePageItem(1, fixture);
  rectangle.pageItems = itemCollection([]);
  fixture.page.allPageItems = [rectangle];

  const response = await invoke(GroupHandlers.getGroupInfo, { pageIndex: 0, groupIndex: 0 }, fixture.app);

  assert.equal(response.success, false);
  assert.match(response.result, /Group index out of range/);
});

test('add_item_to_group crée un groupe englobant vérifié sans appeler Group.add', async () => {
  const fixture = baseFixture();
  const first = makePageItem(1, fixture);
  const second = makePageItem(2, fixture);
  const outside = makePageItem(3, fixture);
  const group = fixture.createGroup([first, second]);
  group.add = () => { throw new Error('API Group.add interdite'); };
  fixture.documentGroups.push(group);
  fixture.page.allPageItems = [group, first, second, outside];

  const response = await invoke(
    GroupHandlers.addItemToGroup,
    { pageIndex: 0, groupIndex: 0, itemIndex: 3 },
    fixture.app,
  );

  assert.equal(response.success, true);
  assert.equal(response.result.previousGroupId, group.id);
  assert.equal(response.result.itemId, outside.id);
  assert.equal(response.result.originalGroupPreservedAsSubgroup, true);
  assert.notEqual(response.result.groupId, group.id);
});

test('remove_item_from_group déplace seulement le membre demandé et conserve le groupe', async () => {
  const fixture = baseFixture();
  const members = [1, 2, 3].map((id) => makePageItem(id, fixture));
  const group = fixture.createGroup(members);
  fixture.documentGroups.push(group);
  fixture.page.allPageItems = [group, ...members];
  const removed = members[1];
  removed.move = (destination) => {
    group._direct.splice(group._direct.indexOf(removed), 1);
    removed.parent = destination;
  };
  group.remove = () => { throw new Error('Group.remove ne doit jamais être appelé'); };

  const response = await invoke(
    GroupHandlers.removeItemFromGroup,
    { pageIndex: 0, groupIndex: 0, itemIndex: 1 },
    fixture.app,
  );

  assert.equal(response.success, true);
  assert.equal(response.result.groupId, group.id);
  assert.equal(response.result.removedItemId, removed.id);
  assert.equal(group.pageItems.length, 2);
  assert.equal(removed.parent, fixture.spread);
});

test('le code des groupes ne contient plus les anciennes méthodes dangereuses', async () => {
  const source = await fs.readFile(new URL('../src/handlers/groupHandlers.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\.remove\(item\)/);
  assert.doesNotMatch(source, /\bgroup\.add\(/);
  assert.doesNotMatch(source, /selection\[0\]\.group\(/);
  assert.doesNotMatch(source, /items\[0\]\.group\(/);
  assert.doesNotMatch(source, /typeof\s+\w+\.pageItems\s*!==\s*['"]undefined['"]/);
});

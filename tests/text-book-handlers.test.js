import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { ScriptExecutor } from '../src/core/scriptExecutor.js';
import { BookHandlers } from '../src/handlers/bookHandlers.js';
import { TextHandlers } from '../src/handlers/textHandlers.js';
import { bookToolDefinitions } from '../src/types/toolDefinitionsBook.js';
import { contentToolDefinitions } from '../src/types/toolDefinitionsContent.js';

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

function makeTable(id, rowCount = 2, columnCount = 2, ignoredCell = null) {
  const values = Array.from({ length: rowCount }, () => Array(columnCount).fill(''));
  const rows = values.map((row, rowIndex) => ({
    cells: collection(row.map((_value, columnIndex) => {
      const cell = { isValid: true };
      Object.defineProperty(cell, 'contents', {
        get: () => values[rowIndex][columnIndex],
        set: (value) => {
          if (ignoredCell?.row !== rowIndex || ignoredCell?.column !== columnIndex) {
            values[rowIndex][columnIndex] = value;
          }
        },
      });
      return cell;
    })),
  }));
  return {
    id,
    isValid: true,
    rows: collection(rows),
    columns: collection(Array.from({ length: columnCount }, () => ({}))),
    values,
  };
}

function textFrame(tables) {
  return { isValid: true, tables: collection(tables) };
}

test('populate_table cible pageIndex et le tableIndex aplati, puis relit chaque cellule', async (t) => {
  const code = await captureGeneratedCode(t, () => TextHandlers.populateTable({
    pageIndex: 1,
    tableIndex: 1,
    data: [['A', 2], [true, null]],
  }));

  const wrongPageTable = makeTable(10);
  const firstTable = makeTable(20);
  const targetTable = makeTable(21);
  const thirdTable = makeTable(22);
  const pages = collection([
    { isValid: true, textFrames: collection([textFrame([wrongPageTable])]) },
    { isValid: true, textFrames: collection([textFrame([firstTable, targetTable]), textFrame([thirdTable])]) },
  ]);

  const result = await runGeneratedCode(code, {
    app: { documents: { length: 1 }, activeDocument: { pages } },
  });

  assert.equal(result.success, true);
  assert.equal(result.pageIndex, 1);
  assert.equal(result.tableIndex, 1);
  assert.equal(result.tableId, 21);
  assert.equal(result.changed, 4);
  assert.equal(result.verified, 4);
  assert.equal(result.postconditionVerified, true);
  assert.deepEqual(targetTable.values, [['A', '2'], ['true', '']]);
  assert.deepEqual(firstTable.values, [['', ''], ['', '']]);
  assert.deepEqual(thirdTable.values, [['', ''], ['', '']]);
  assert.deepEqual(wrongPageTable.values, [['', ''], ['', '']]);
});

test('populate_table échoue si une cellule ignore silencieusement son écriture', async (t) => {
  const code = await captureGeneratedCode(t, () => TextHandlers.populateTable({
    pageIndex: 0,
    tableIndex: 0,
    data: [['valeur']],
  }));
  const table = makeTable(30, 1, 1, { row: 0, column: 0 });
  const pages = collection([{ isValid: true, textFrames: collection([textFrame([table])]) }]);

  const result = await runGeneratedCode(code, {
    app: { documents: { length: 1 }, activeDocument: { pages } },
  });

  assert.equal(result.success, false);
  assert.match(result.error, /postcondition failed.*row 0, column 0/i);
});

test('set_book_properties applique, relit avant et après save, puis ferme sans sauvegarder de nouveau', async (t) => {
  const code = await captureGeneratedCode(t, () => BookHandlers.setBookProperties({
    bookPath: 'C:\\Documents\\ouvrage.indb',
    automaticPagination: true,
    synchronizeParagraphStyle: false,
  }));
  let saveCount = 0;
  const closeArguments = [];
  const book = {
    isValid: true,
    automaticPagination: false,
    synchronizeParagraphStyle: true,
    async save() { saveCount += 1; },
    async close(option) { closeArguments.push(option); this.isValid = false; },
  };

  const result = await runGeneratedCode(code, {
    app: { open: async () => book },
    modules: { indesign: { SaveOptions: { NO: 'NO' } } },
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.updatedProperties, ['automaticPagination', 'synchronizeParagraphStyle']);
  assert.equal(result.postconditionVerified, true);
  assert.equal(saveCount, 1);
  assert.deepEqual(closeArguments, ['NO']);
});

test('set_book_properties remonte une erreur de setter et ne sauvegarde pas', async (t) => {
  const code = await captureGeneratedCode(t, () => BookHandlers.setBookProperties({
    bookPath: 'C:\\Documents\\ouvrage.indb',
    automaticPagination: true,
  }));
  let saveCount = 0;
  const closeArguments = [];
  const book = {
    isValid: true,
    async save() { saveCount += 1; },
    async close(option) { closeArguments.push(option); this.isValid = false; },
  };
  Object.defineProperty(book, 'automaticPagination', {
    get: () => false,
    set: () => { throw new Error('setter rejected value'); },
  });

  const result = await runGeneratedCode(code, {
    app: { open: async () => book },
    modules: { indesign: { SaveOptions: { NO: 'NO' } } },
  });

  assert.equal(result.success, false);
  assert.match(result.error, /setter rejected value/i);
  assert.equal(saveCount, 0);
  assert.deepEqual(closeArguments, ['NO']);
});

test('set_book_properties détecte une propriété ignorée avant save', async (t) => {
  const code = await captureGeneratedCode(t, () => BookHandlers.setBookProperties({
    bookPath: 'C:\\Documents\\ouvrage.indb',
    automaticPagination: true,
  }));
  let saveCount = 0;
  const book = {
    isValid: true,
    async save() { saveCount += 1; },
    async close() { this.isValid = false; },
  };
  Object.defineProperty(book, 'automaticPagination', { get: () => false, set: () => {} });

  const result = await runGeneratedCode(code, {
    app: { open: async () => book },
    modules: { indesign: { SaveOptions: { NO: 'NO' } } },
  });

  assert.equal(result.success, false);
  assert.match(result.error, /postcondition failed before save.*automaticPagination/i);
  assert.equal(saveCount, 0);
});

test('set_book_properties relit encore les propriétés après save avant de réussir', async (t) => {
  const code = await captureGeneratedCode(t, () => BookHandlers.setBookProperties({
    bookPath: 'C:\\Documents\\ouvrage.indb',
    automaticPagination: true,
  }));
  const closeArguments = [];
  const book = {
    isValid: true,
    automaticPagination: false,
    async save() { this.automaticPagination = false; },
    async close(option) { closeArguments.push(option); this.isValid = false; },
  };

  const result = await runGeneratedCode(code, {
    app: { open: async () => book },
    modules: { indesign: { SaveOptions: { NO: 'NO' } } },
  });

  assert.equal(result.success, false);
  assert.match(result.error, /postcondition failed after save.*automaticPagination/i);
  assert.deepEqual(closeArguments, ['NO']);
});

test('les schémas exigent une page pour populate_table et au moins une propriété de livre', () => {
  const ajv = new Ajv2020({ strict: false, useDefaults: true });
  const populateSchema = contentToolDefinitions.find(({ name }) => name === 'populate_table').inputSchema;
  const bookSchema = bookToolDefinitions.find(({ name }) => name === 'set_book_properties').inputSchema;
  const validatePopulate = ajv.compile(populateSchema);
  const validateBook = ajv.compile(bookSchema);

  assert.equal(validatePopulate({ data: [['A']] }), false);
  assert.equal(validatePopulate({ pageIndex: 0.5, data: [['A']] }), false);
  assert.equal(validatePopulate({ pageIndex: 0, data: ['A'] }), false);
  assert.equal(validatePopulate({ pageIndex: 0, data: [['A', null]] }), true);
  assert.equal(validateBook({ bookPath: 'C:\\Documents\\ouvrage.indb' }), false);
  assert.equal(validateBook({ bookPath: 'C:\\Documents\\ouvrage.indb', automaticPagination: false }), true);
});

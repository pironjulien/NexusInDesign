import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ScriptExecutor } from '../src/core/scriptExecutor.js';
import { ExportHandlers, normalizeExportImagesArgs } from '../src/handlers/exportHandlers.js';

async function executeGeneratedExport(code, { app, document, indesign }) {
  const execute = new Function('app', 'targetDocument', 'require', `return (async () => {${code}})();`);
  return execute(app, document, (name) => {
    assert.equal(name, 'indesign');
    return indesign;
  });
}

test('le contrat export_images normalise outputPath, pages et les plages', () => {
  const result = normalizeExportImagesArgs({
    outputPath: 'C:\\Dev\\images',
    format: 'JPEG',
    pages: '1-3,5,3',
    resolution: 600,
    quality: 90,
  });
  assert.equal(result.outputPath, 'C:\\Dev\\images');
  assert.equal(result.pages, '1-3,5,3');
  assert.deepEqual(result.requestedPages, [1, 2, 3, 5]);
  assert.equal(result.resolution, 600);
  assert.equal(result.quality, 90);
  assert.throws(() => normalizeExportImagesArgs({ folderPath: 'C:\\Dev\\images', pageRange: '1-3' }), /outputPath/);
});

test('export_images crée le vrai dossier outputPath et transmet pages à UXP', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-export-contract-'));
  const outputPath = path.join(root, 'images');
  const originalExecute = ScriptExecutor.executeViaUXP;
  let capturedCode = '';
  ScriptExecutor.executeViaUXP = async (code) => {
    capturedCode = code;
    return { success: true, count: 3 };
  };
  t.after(async () => {
    ScriptExecutor.executeViaUXP = originalExecute;
    await fs.rm(root, { recursive: true, force: true });
  });

  const response = await ExportHandlers.exportImages({ outputPath, pages: '1-2,4', format: 'PNG', resolution: 450 });
  assert.equal(response.success, true);
  assert.equal((await fs.stat(outputPath)).isDirectory(), true);
  assert.ok(capturedCode.includes(JSON.stringify(outputPath)));
  assert.ok(capturedCode.includes('const requestedPages = [1,2,4]'));
  assert.ok(capturedCode.includes('preferences.exportResolution = 450'));
  assert.doesNotMatch(capturedCode, /folderPath|pageRange/);
  assert.doesNotMatch(capturedCode, /\.pages\.item\([^)]*\)\.exportFile/);
  assert.match(capturedCode, /preferences\.pageString = '\+' \+ String\(pageNum \+ 1\)/);
  assert.match(capturedCode, /await doc\.exportFile\(exportFormat, fileName, false\)/);
  assert.match(capturedCode, /preferences\[rangeProperty\] = exportRange/);

  const pages = [{ name: 'Section:A' }, { name: 'Section:B' }, { name: 'Section:C' }, { name: 'Section:D' }];
  const preferences = {
    exportResolution: 72,
    transparentBackground: false,
    exportingSpread: true,
    pngExportRange: 'all',
    pageString: 'avant',
  };
  const exports = [];
  const document = {
    pages: { length: pages.length, item: (index) => pages[index] },
    exportFile: async (format, target, showingOptions) => {
      exports.push({
        format,
        target,
        showingOptions,
        pageString: preferences.pageString,
        range: preferences.pngExportRange,
        exportingSpread: preferences.exportingSpread,
      });
    },
  };
  const runtimeResult = await executeGeneratedExport(capturedCode, {
    app: { documents: { length: 1 }, activeDocument: document, pngExportPreferences: preferences },
    document,
    indesign: {
      ExportFormat: { PNG_FORMAT: 'png' },
      ExportRangeOrAllPages: { EXPORT_RANGE: 'generic-range' },
      PNGExportRangeEnum: { EXPORT_RANGE: 'png-range' },
      JPEGOptionsQuality: {},
    },
  });
  assert.deepEqual(runtimeResult, { success: true, count: 3 });
  assert.deepEqual(exports.map(({ pageString }) => pageString), ['+1', '+2', '+4']);
  assert.ok(exports.every((entry) => entry.format === 'png' && entry.range === 'png-range' && entry.exportingSpread === false));
  assert.deepEqual(preferences, {
    exportResolution: 72,
    transparentBackground: false,
    exportingSpread: true,
    pngExportRange: 'all',
    pageString: 'avant',
  });
});

test('export_images JPEG exécute Document.exportFile et restaure toutes les préférences', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-export-jpeg-'));
  const outputPath = path.join(root, 'images');
  const originalExecute = ScriptExecutor.executeViaUXP;
  let capturedCode = '';
  ScriptExecutor.executeViaUXP = async (code) => {
    capturedCode = code;
    return { success: true, count: 2 };
  };
  t.after(async () => {
    ScriptExecutor.executeViaUXP = originalExecute;
    await fs.rm(root, { recursive: true, force: true });
  });

  const response = await ExportHandlers.exportImages({
    outputPath,
    pages: '1-2',
    format: 'JPEG',
    resolution: 300,
    quality: 90,
  });
  assert.equal(response.success, true);

  const preferences = {
    exportResolution: 96,
    jpegQuality: 'ancienne-qualité',
    exportingSpread: true,
    jpegExportRange: 'all',
    pageString: 'avant',
  };
  const exports = [];
  const document = {
    pages: { length: 2, item: (index) => ({ name: String(index + 1) }) },
    exportFile: async (format, target) => {
      exports.push({
        format,
        target,
        pageString: preferences.pageString,
        range: preferences.jpegExportRange,
        quality: preferences.jpegQuality,
      });
    },
  };
  const result = await executeGeneratedExport(capturedCode, {
    app: { documents: { length: 1 }, activeDocument: document, jpegExportPreferences: preferences },
    document,
    indesign: {
      ExportFormat: { JPG: 'jpeg' },
      ExportRangeOrAllPages: { EXPORT_RANGE: 'jpeg-range' },
      PNGExportRangeEnum: null,
      JPEGOptionsQuality: { MAXIMUM: 'maximum' },
    },
  });

  assert.deepEqual(result, { success: true, count: 2 });
  assert.deepEqual(exports.map(({ pageString }) => pageString), ['+1', '+2']);
  assert.ok(exports.every((entry) => entry.format === 'jpeg' && entry.range === 'jpeg-range' && entry.quality === 'maximum'));
  assert.deepEqual(preferences, {
    exportResolution: 96,
    jpegQuality: 'ancienne-qualité',
    exportingSpread: true,
    jpegExportRange: 'all',
    pageString: 'avant',
  });
});

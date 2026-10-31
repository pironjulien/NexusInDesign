import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateRawSync, deflateSync } from 'node:zlib';
import {
  ArtifactVerificationError,
  verifyArtifact,
  verifyMultipagePngDirectory,
  verifyPackageDirectory,
} from '../src/verification/ArtifactVerifier.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const INDD_SIGNATURE = Buffer.from([0x06, 0x06, 0xed, 0xf5, 0xd8, 0x1d, 0x46, 0xe5, 0xbd, 0x31, 0xef, 0xe7, 0xfe, 0x74, 0xb7, 0x1d]);
const IDML_MIMETYPE = 'application/vnd.adobe.indesign-idml-package';
const IDML_DESIGNMAP = '<?xml version="1.0" encoding="UTF-8"?><Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="21.0" />';

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

async function createSandbox(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'indesign-artifact-verifier-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function expectVerificationCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ArtifactVerificationError);
    assert.equal(error.code, code);
    return true;
  });
}

function createMinimalPdf() {
  const parts = [Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const offsets = [0];
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>\nendobj\n',
  ];
  for (const object of objects) {
    offsets.push(parts.reduce((total, part) => total + part.length, 0));
    parts.push(Buffer.from(object, 'ascii'));
  }
  const xrefOffset = parts.reduce((total, part) => total + part.length, 0);
  const xref = [
    'xref\n0 4\n',
    '0000000000 65535 f \n',
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`),
    'trailer\n<< /Size 4 /Root 1 0 R >>\n',
    `startxref\n${xrefOffset}\n%%EOF\n`,
  ].join('');
  parts.push(Buffer.from(xref, 'ascii'));
  return Buffer.concat(parts);
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function createRgbaPng({ red = 35, green = 89, blue = 144, alpha = 255, filter = 0 } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const scanline = Buffer.from([filter, red, green, blue, alpha]);
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(scanline)),
    pngChunk('IEND'),
  ]);
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const method = entry.store ? 0 : 8;
    const compressed = method === 0 ? data : deflateRawSync(data);
    const checksum = crc32(data);
    const flags = 0x0800;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + compressed.length;
  }

  const localData = Buffer.concat(localParts);
  const centralData = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralData.length, 12);
  eocd.writeUInt32LE(localData.length, 16);
  return Buffer.concat([localData, centralData, eocd]);
}

function createMinimalIdml({ mimetype = IDML_MIMETYPE, includeDesignmap = true } = {}) {
  const entries = [{ name: 'mimetype', data: mimetype, store: true }];
  if (includeDesignmap) entries.push({ name: 'designmap.xml', data: IDML_DESIGNMAP });
  return createZip(entries);
}

test('valide un PDF réel avec objets, xref, startxref et marque EOF', async (t) => {
  const root = await createSandbox(t);
  const filePath = path.join(root, 'document.pdf');
  const pdf = createMinimalPdf();
  await fs.writeFile(filePath, pdf);
  const result = await verifyArtifact({ targetPath: filePath, kind: 'pdf' });
  assert.equal(result.valid, true);
  assert.equal(result.kind, 'pdf');
  assert.equal(result.sizeBytes, pdf.length);
  assert.equal(result.version, '1.7');
  assert.ok(result.xrefOffset > 0);
});

test('refuse les faux PDF sans EOF ou avec un pointeur xref mensonger', async (t) => {
  const root = await createSandbox(t);
  const noEof = path.join(root, 'sans-fin.pdf');
  const badXref = path.join(root, 'mauvais-xref.pdf');
  const pdf = createMinimalPdf();
  await fs.writeFile(noEof, pdf.subarray(0, pdf.lastIndexOf('%%EOF')));
  await fs.writeFile(badXref, Buffer.from(pdf.toString('latin1').replace(/startxref\n\d+/, 'startxref\n12'), 'latin1'));
  await expectVerificationCode(verifyArtifact({ targetPath: noEof, kind: 'pdf' }), 'ARTIFACT_PDF_EOF_MISSING');
  await expectVerificationCode(verifyArtifact({ targetPath: badXref, kind: 'pdf' }), 'ARTIFACT_PDF_XREF_INVALID');
});

test('valide la structure, les CRC et le flux image d’un PNG réel', async (t) => {
  const root = await createSandbox(t);
  const filePath = path.join(root, 'page.png');
  const png = createRgbaPng();
  await fs.writeFile(filePath, png);
  assert.deepEqual(await verifyArtifact({ targetPath: filePath, kind: 'png' }), {
    valid: true,
    kind: 'png',
    sizeBytes: png.length,
    width: 1,
    height: 1,
    chunkCount: 3,
  });
});

test('refuse un PNG tronqué, un CRC corrompu, un filtre invalide et un faux flux IDAT', async (t) => {
  const root = await createSandbox(t);
  const truncatedPath = path.join(root, 'tronque.png');
  const badCrcPath = path.join(root, 'crc.png');
  const badFilterPath = path.join(root, 'filtre.png');
  const badDataPath = path.join(root, 'flux.png');
  const png = createRgbaPng();
  const badCrc = Buffer.from(png);
  badCrc[badCrc.length - 1] ^= 0xff;
  const ihdrEnd = PNG_SIGNATURE.length + 12 + 13;
  const badData = Buffer.concat([
    png.subarray(0, ihdrEnd),
    pngChunk('IDAT', Buffer.from('pas-un-flux-zlib')),
    pngChunk('IEND'),
  ]);
  await fs.writeFile(truncatedPath, PNG_SIGNATURE);
  await fs.writeFile(badCrcPath, badCrc);
  await fs.writeFile(badFilterPath, createRgbaPng({ filter: 5 }));
  await fs.writeFile(badDataPath, badData);
  await expectVerificationCode(verifyArtifact({ targetPath: truncatedPath, kind: 'png' }), 'ARTIFACT_PNG_TRUNCATED');
  await expectVerificationCode(verifyArtifact({ targetPath: badCrcPath, kind: 'png' }), 'ARTIFACT_PNG_CRC_INVALID');
  await expectVerificationCode(verifyArtifact({ targetPath: badFilterPath, kind: 'png' }), 'ARTIFACT_PNG_DATA_INVALID');
  await expectVerificationCode(verifyArtifact({ targetPath: badDataPath, kind: 'png' }), 'ARTIFACT_PNG_DATA_INVALID');
});

test('valide un véritable conteneur IDML avec mimetype et designmap.xml', async (t) => {
  const root = await createSandbox(t);
  const filePath = path.join(root, 'document.idml');
  const idml = createMinimalIdml();
  await fs.writeFile(filePath, idml);
  assert.deepEqual(await verifyArtifact({ targetPath: filePath, kind: 'idml' }), {
    valid: true,
    kind: 'idml',
    sizeBytes: idml.length,
    entryCount: 2,
  });
});

test('refuse les faux IDML, le mauvais mimetype et l’absence de designmap.xml', async (t) => {
  const root = await createSandbox(t);
  const fakePath = path.join(root, 'faux.idml');
  const mimePath = path.join(root, 'mime.idml');
  const missingPath = path.join(root, 'sans-designmap.idml');
  await fs.writeFile(fakePath, Buffer.from('PK\u0003\u0004contenu', 'binary'));
  await fs.writeFile(mimePath, createMinimalIdml({ mimetype: 'application/zip' }));
  await fs.writeFile(missingPath, createMinimalIdml({ includeDesignmap: false }));
  await expectVerificationCode(verifyArtifact({ targetPath: fakePath, kind: 'idml' }), 'ARTIFACT_IDML_ZIP_INVALID');
  await expectVerificationCode(verifyArtifact({ targetPath: mimePath, kind: 'idml' }), 'ARTIFACT_IDML_MIMETYPE_INVALID');
  await expectVerificationCode(verifyArtifact({ targetPath: missingPath, kind: 'idml' }), 'ARTIFACT_IDML_REQUIRED_ENTRY_MISSING');
});

test('refuse une entrée IDML requise dont les données ne correspondent plus au CRC', async (t) => {
  const root = await createSandbox(t);
  const filePath = path.join(root, 'corrompu.idml');
  const idml = createMinimalIdml();
  const marker = idml.indexOf(Buffer.from(IDML_MIMETYPE));
  assert.ok(marker > 0);
  idml[marker] ^= 0x01;
  await fs.writeFile(filePath, idml);
  await expectVerificationCode(verifyArtifact({ targetPath: filePath, kind: 'idml' }), 'ARTIFACT_IDML_CRC_INVALID');
});

test('valide le magic binaire INDD et refuse les fichiers opaques arbitraires', async (t) => {
  const root = await createSandbox(t);
  const validPath = path.join(root, 'backup.indd');
  const invalidPath = path.join(root, 'texte.indd');
  const valid = Buffer.alloc(128);
  INDD_SIGNATURE.copy(valid);
  await fs.writeFile(validPath, valid);
  await fs.writeFile(invalidPath, 'copie-indd-factice');
  assert.deepEqual(await verifyArtifact({ targetPath: validPath, kind: 'indd' }), {
    valid: true,
    kind: 'indd',
    sizeBytes: 128,
  });
  await expectVerificationCode(verifyArtifact({ targetPath: invalidPath, kind: 'indd' }), 'ARTIFACT_INDD_STRUCTURE_INVALID');
});

test('valide exactement tous les PNG multipages déclarés', async (t) => {
  const root = await createSandbox(t);
  const pagesPath = path.join(root, 'pages-valides');
  await fs.mkdir(pagesPath);
  const first = path.join(pagesPath, 'page-0001.png');
  const second = path.join(pagesPath, 'page-0002.PNG');
  await fs.writeFile(first, createRgbaPng({ red: 1 }));
  await fs.writeFile(second, createRgbaPng({ blue: 2 }));
  assert.deepEqual(await verifyMultipagePngDirectory(pagesPath, { expectedPaths: [first, second] }), {
    valid: true,
    kind: 'multipage-png',
    entryCount: 2,
    pngCandidateCount: 2,
    validPngCount: 2,
  });
  await expectVerificationCode(verifyMultipagePngDirectory(pagesPath, { expectedPaths: [first] }), 'ARTIFACT_PATH_SET_MISMATCH');
  await expectVerificationCode(verifyMultipagePngDirectory(pagesPath, { expectedPaths: [first, first] }), 'ARTIFACT_PATH_SET_MISMATCH');
});

test('refuse un multipage sans expectedPaths, avec un intrus ou avec un PNG invalide', async (t) => {
  const root = await createSandbox(t);
  const pagesPath = path.join(root, 'pages');
  await fs.mkdir(pagesPath);
  const page = path.join(pagesPath, 'page.png');
  await fs.writeFile(page, createRgbaPng());
  await expectVerificationCode(verifyMultipagePngDirectory(pagesPath), 'ARTIFACT_EXPECTED_PATHS_INVALID');
  const notes = path.join(pagesPath, 'notes.txt');
  await fs.writeFile(notes, 'intrus');
  await expectVerificationCode(verifyMultipagePngDirectory(pagesPath, { expectedPaths: [page] }), 'ARTIFACT_MULTIPAGE_UNEXPECTED_ENTRY');
  await fs.rm(notes);
  await fs.writeFile(page, Buffer.from('PNG invalide'));
  await expectVerificationCode(verifyMultipagePngDirectory(pagesPath, { expectedPaths: [page] }), 'ARTIFACT_MULTIPAGE_INVALID');
});

test('valide récursivement un package avec un fichier utile non vide', async (t) => {
  const root = await createSandbox(t);
  const packagePath = path.join(root, 'package');
  await fs.mkdir(path.join(packagePath, 'Links'), { recursive: true });
  await fs.writeFile(path.join(packagePath, 'desktop.ini'), 'métadonnée');
  await fs.writeFile(path.join(packagePath, 'Links', 'visuel.tif'), Buffer.from([1, 2, 3]));
  assert.deepEqual(await verifyPackageDirectory(packagePath), {
    valid: true,
    kind: 'package',
    entryCount: 3,
    fileCount: 2,
    usefulFileCount: 1,
    totalSizeBytes: Buffer.byteLength('métadonnée') + 3,
  });
});

test('refuse un package vide ou composé seulement de métadonnées et fichiers vides', async (t) => {
  const root = await createSandbox(t);
  const emptyPath = path.join(root, 'vide');
  const uselessPath = path.join(root, 'inutile');
  await fs.mkdir(emptyPath);
  await fs.mkdir(uselessPath);
  await fs.writeFile(path.join(uselessPath, 'Thumbs.db'), 'méta');
  await fs.writeFile(path.join(uselessPath, 'document.indd'), '');
  await expectVerificationCode(verifyPackageDirectory(emptyPath), 'ARTIFACT_PACKAGE_EMPTY');
  await expectVerificationCode(verifyPackageDirectory(uselessPath), 'ARTIFACT_PACKAGE_CONTENT_INVALID');
});

test('refuse les cibles incompatibles et les types inconnus', async (t) => {
  const root = await createSandbox(t);
  const filePath = path.join(root, 'document.pdf');
  await fs.writeFile(filePath, createMinimalPdf());
  await expectVerificationCode(verifyArtifact({ targetPath: root, kind: 'pdf' }), 'ARTIFACT_TYPE_MISMATCH');
  await expectVerificationCode(verifyArtifact({ targetPath: filePath, kind: 'package' }), 'ARTIFACT_TYPE_MISMATCH');
  await expectVerificationCode(verifyArtifact({ targetPath: filePath, kind: 'jpeg' }), 'ARTIFACT_KIND_UNSUPPORTED');
});

test('refuse un lien symbolique ou une jonction comme artefact', async (t) => {
  const root = await createSandbox(t);
  const targetDirectory = path.join(root, 'package-reel');
  const linkedDirectory = path.join(root, 'package-lie');
  await fs.mkdir(targetDirectory);
  await fs.writeFile(path.join(targetDirectory, 'document.indd'), Buffer.from([1]));
  await fs.symlink(targetDirectory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  await expectVerificationCode(verifyArtifact({ targetPath: linkedDirectory, kind: 'package' }), 'ARTIFACT_SYMBOLIC_LINK');
});

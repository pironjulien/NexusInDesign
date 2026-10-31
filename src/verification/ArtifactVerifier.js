import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { createInflate, createInflateRaw, inflateRawSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const INDD_SIGNATURE = Buffer.from([0x06, 0x06, 0xed, 0xf5, 0xd8, 0x1d, 0x46, 0xe5, 0xbd, 0x31, 0xef, 0xe7, 0xfe, 0x74, 0xb7, 0x1d]);
const IDML_MIMETYPE = 'application/vnd.adobe.indesign-idml-package';
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const MAX_ZIP_COMMENT_BYTES = 0xffff;
const MAX_IDML_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024;
const MAX_IDML_REQUIRED_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_IDML_TOTAL_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024;
const MAX_PNG_DECODED_BYTES = 1024 * 1024 * 1024;
const MAX_PACKAGE_ENTRIES = 100_000;
const READ_CHUNK_BYTES = 64 * 1024;
const IGNORED_PACKAGE_FILES = new Set(['.ds_store', 'desktop.ini', 'thumbs.db']);

const SUPPORTED_KINDS = new Set([
  'pdf',
  'png',
  'idml',
  'indd',
  'multipage-png',
  'package',
]);

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export class ArtifactVerificationError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.name = 'ArtifactVerificationError';
    this.code = code;
  }
}

function fail(message, code, cause) {
  throw new ArtifactVerificationError(message, code, cause ? { cause } : undefined);
}

function assertNonEmptyPath(targetPath) {
  if (typeof targetPath !== 'string' || targetPath.trim().length === 0) {
    fail('Le chemin de l’artefact est obligatoire.', 'ARTIFACT_PATH_INVALID');
  }
}

async function lstatArtifact(targetPath) {
  assertNonEmptyPath(targetPath);
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      fail('L’artefact est introuvable.', 'ARTIFACT_NOT_FOUND', error);
    }
    throw error;
  }
}

function assertNotSymbolicLink(stat) {
  if (stat.isSymbolicLink()) {
    fail('Les liens symboliques ne sont pas acceptés comme artefacts exportés.', 'ARTIFACT_SYMBOLIC_LINK');
  }
}

async function openRegularFile(filePath) {
  const entryStat = await lstatArtifact(filePath);
  assertNotSymbolicLink(entryStat);
  if (!entryStat.isFile()) {
    fail('L’artefact attendu doit être un fichier.', 'ARTIFACT_TYPE_MISMATCH');
  }

  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) fail('L’artefact attendu doit être un fichier.', 'ARTIFACT_TYPE_MISMATCH');
    if (stat.size === 0) fail('Le fichier exporté est vide.', 'ARTIFACT_EMPTY');
    return { handle, stat };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readExactly(handle, length, position, errorCode = 'ARTIFACT_TRUNCATED') {
  const buffer = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const { bytesRead } = await handle.read(buffer, total, length - total, position + total);
    if (bytesRead === 0) fail('Le fichier exporté est tronqué.', errorCode);
    total += bytesRead;
  }
  return buffer;
}

function updateCrc32(crc, buffer) {
  let value = crc >>> 0;
  for (const byte of buffer) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return value >>> 0;
}

function crc32(buffer) {
  return (updateCrc32(0xffffffff, buffer) ^ 0xffffffff) >>> 0;
}

async function verifyPdfFile(filePath) {
  const { handle, stat } = await openRegularFile(filePath);
  try {
    if (stat.size < 64) fail('Le PDF est trop court pour contenir une structure valide.', 'ARTIFACT_PDF_STRUCTURE_INVALID');

    const headLength = Math.min(stat.size, 64 * 1024);
    const head = await readExactly(handle, headLength, 0, 'ARTIFACT_PDF_STRUCTURE_INVALID');
    const headerMatch = head.toString('latin1', 0, Math.min(head.length, 16)).match(/^%PDF-(1\.[0-7]|2\.0)(?:\r\n|\r|\n)/);
    if (!headerMatch) fail('L’en-tête PDF est invalide.', 'ARTIFACT_SIGNATURE_MISMATCH');
    if (!/\d+\s+\d+\s+obj\b/.test(head.toString('latin1'))) {
      fail('Le PDF ne contient aucun objet lisible.', 'ARTIFACT_PDF_STRUCTURE_INVALID');
    }

    const tailLength = Math.min(stat.size, MAX_ZIP_COMMENT_BYTES + 2048);
    const tailOffset = stat.size - tailLength;
    const tailText = (await readExactly(handle, tailLength, tailOffset, 'ARTIFACT_PDF_STRUCTURE_INVALID')).toString('latin1');
    const eofIndex = tailText.lastIndexOf('%%EOF');
    if (eofIndex < 0 || !/^[\x00\x09\x0a\x0c\x0d\x20]*$/.test(tailText.slice(eofIndex + 5))) {
      fail('La marque de fin du PDF est absente ou invalide.', 'ARTIFACT_PDF_EOF_MISSING');
    }

    const beforeEof = tailText.slice(0, eofIndex);
    const startXrefMatches = [...beforeEof.matchAll(/startxref\s+(\d+)\s*/g)];
    const startXrefMatch = startXrefMatches.at(-1);
    if (!startXrefMatch) fail('Le pointeur startxref du PDF est absent.', 'ARTIFACT_PDF_XREF_INVALID');
    const xrefOffset = Number(startXrefMatch[1]);
    if (!Number.isSafeInteger(xrefOffset) || xrefOffset < 0 || xrefOffset >= stat.size) {
      fail('Le pointeur startxref du PDF sort du fichier.', 'ARTIFACT_PDF_XREF_INVALID');
    }

    const xrefProbeLength = Math.min(16 * 1024, stat.size - xrefOffset);
    const xrefProbe = (await readExactly(handle, xrefProbeLength, xrefOffset, 'ARTIFACT_PDF_XREF_INVALID')).toString('latin1');
    const classicXref = /^xref(?:\r\n|\r|\n|\s)/.test(xrefProbe);
    const streamXref = /^\d+\s+\d+\s+obj\b[\s\S]*?\/Type\s*\/XRef\b/.test(xrefProbe);
    if (!classicXref && !streamXref) {
      fail('Le pointeur startxref ne désigne pas une table ou un flux xref.', 'ARTIFACT_PDF_XREF_INVALID');
    }
    if (classicXref) {
      if (!/^xref\s+\d+\s+\d+\s+\d{10}\s+\d{5}\s+[nf](?:\s|\r|\n)/.test(xrefProbe)
          || !/trailer\s*<<[\s\S]*?\/Size\s+\d+/.test(beforeEof)) {
        fail('La table xref classique ou son dictionnaire trailer est invalide.', 'ARTIFACT_PDF_XREF_INVALID');
      }
    } else if (!/\/Size\s+\d+/.test(xrefProbe)) {
      fail('Le flux xref ne contient pas de taille.', 'ARTIFACT_PDF_XREF_INVALID');
    }

    return Object.freeze({
      valid: true,
      kind: 'pdf',
      sizeBytes: stat.size,
      version: headerMatch[1],
      xrefOffset,
    });
  } finally {
    await handle.close();
  }
}

function validatePngHeader(data) {
  const width = data.readUInt32BE(0);
  const height = data.readUInt32BE(4);
  const bitDepth = data[8];
  const colorType = data[9];
  const compression = data[10];
  const filter = data[11];
  const interlace = data[12];
  const allowedDepths = {
    0: new Set([1, 2, 4, 8, 16]),
    2: new Set([8, 16]),
    3: new Set([1, 2, 4, 8]),
    4: new Set([8, 16]),
    6: new Set([8, 16]),
  };

  if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) {
    fail('Les dimensions PNG sont invalides.', 'ARTIFACT_PNG_IHDR_INVALID');
  }
  if (!allowedDepths[colorType]?.has(bitDepth) || compression !== 0 || filter !== 0 || ![0, 1].includes(interlace)) {
    fail('Les paramètres IHDR du PNG sont invalides.', 'ARTIFACT_PNG_IHDR_INVALID');
  }
  return { width, height, bitDepth, colorType, interlace };
}

function pngDecodedLayout({ width, height, bitDepth, colorType, interlace }) {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const bitsPerPixel = channels * bitDepth;
  const passLayout = (startX, startY, stepX, stepY) => {
    const passWidth = width <= startX ? 0 : Math.ceil((width - startX) / stepX);
    const passHeight = height <= startY ? 0 : Math.ceil((height - startY) / stepY);
    const rowBytes = passWidth === 0 ? 0 : 1 + Math.ceil((passWidth * bitsPerPixel) / 8);
    return { rowCount: passHeight, rowBytes, size: passHeight * rowBytes };
  };
  const passes = interlace === 0
    ? [passLayout(0, 0, 1, 1)]
    : [
        [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
        [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
      ].map((pass) => passLayout(...pass)).filter((pass) => pass.rowCount > 0 && pass.rowBytes > 0);
  const size = passes.reduce((total, pass) => total + pass.size, 0);
  if (!Number.isSafeInteger(size) || size > MAX_PNG_DECODED_BYTES) {
    fail('Le PNG dépasse la limite de validation décompressée.', 'ARTIFACT_PNG_RESOURCE_LIMIT');
  }
  return { size, passes };
}

async function crc32FileRange(handle, typeBuffer, position, length) {
  let crc = updateCrc32(0xffffffff, typeBuffer);
  let offset = 0;
  while (offset < length) {
    const size = Math.min(READ_CHUNK_BYTES, length - offset);
    const data = await readExactly(handle, size, position + offset, 'ARTIFACT_PNG_TRUNCATED');
    crc = updateCrc32(crc, data);
    offset += size;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function* readFileRanges(handle, ranges, errorCode = 'ARTIFACT_PNG_TRUNCATED') {
  for (const range of ranges) {
    let offset = 0;
    while (offset < range.length) {
      const size = Math.min(READ_CHUNK_BYTES, range.length - offset);
      yield await readExactly(handle, size, range.position + offset, errorCode);
      offset += size;
    }
  }
}

async function validatePngImageData(handle, ranges, layout) {
  let decodedSize = 0;
  let passIndex = 0;
  let rowsRemaining = layout.passes[0]?.rowCount ?? 0;
  let bytesRemainingInRow = 0;
  try {
    const inflated = Readable.from(readFileRanges(handle, ranges)).pipe(createInflate());
    for await (const chunk of inflated) {
      decodedSize += chunk.length;
      if (decodedSize > layout.size) {
        inflated.destroy();
        fail('Les données décompressées du PNG dépassent ses dimensions.', 'ARTIFACT_PNG_DATA_INVALID');
      }
      let offset = 0;
      while (offset < chunk.length) {
        while (rowsRemaining === 0 && passIndex + 1 < layout.passes.length) {
          passIndex += 1;
          rowsRemaining = layout.passes[passIndex].rowCount;
        }
        if (bytesRemainingInRow === 0) {
          if (rowsRemaining === 0 || chunk[offset] > 4) {
            inflated.destroy();
            fail('Un octet de filtre PNG est invalide.', 'ARTIFACT_PNG_DATA_INVALID');
          }
          offset += 1;
          rowsRemaining -= 1;
          bytesRemainingInRow = layout.passes[passIndex].rowBytes - 1;
        }
        const consumed = Math.min(bytesRemainingInRow, chunk.length - offset);
        bytesRemainingInRow -= consumed;
        offset += consumed;
      }
    }
  } catch (error) {
    if (error instanceof ArtifactVerificationError) throw error;
    fail('Le flux IDAT du PNG est invalide.', 'ARTIFACT_PNG_DATA_INVALID', error);
  }
  if (decodedSize !== layout.size || rowsRemaining !== 0 || bytesRemainingInRow !== 0 || passIndex !== layout.passes.length - 1) {
    fail('Le flux IDAT du PNG ne correspond pas à ses dimensions.', 'ARTIFACT_PNG_DATA_INVALID');
  }
}

async function verifyPngFile(filePath) {
  const { handle, stat } = await openRegularFile(filePath);
  try {
    if (stat.size < PNG_SIGNATURE.length + 12) fail('Le PNG est tronqué.', 'ARTIFACT_PNG_TRUNCATED');
    const signature = await readExactly(handle, PNG_SIGNATURE.length, 0, 'ARTIFACT_PNG_TRUNCATED');
    if (!signature.equals(PNG_SIGNATURE)) fail('La signature du fichier PNG est invalide.', 'ARTIFACT_SIGNATURE_MISMATCH');

    let position = PNG_SIGNATURE.length;
    let chunkCount = 0;
    let pngHeader;
    let sawPalette = false;
    let idatChunkCount = 0;
    let idatEnded = false;
    let sawIend = false;
    const idatRanges = [];

    while (position < stat.size) {
      if (stat.size - position < 12) fail('Le dernier chunk PNG est tronqué.', 'ARTIFACT_PNG_TRUNCATED');
      const chunkHeader = await readExactly(handle, 8, position, 'ARTIFACT_PNG_TRUNCATED');
      const length = chunkHeader.readUInt32BE(0);
      const typeBuffer = chunkHeader.subarray(4, 8);
      const type = typeBuffer.toString('ascii');
      if (length > 0x7fffffff || !/^[A-Za-z]{4}$/.test(type) || (typeBuffer[2] & 0x20) !== 0) {
        fail('Le type ou la taille d’un chunk PNG est invalide.', 'ARTIFACT_PNG_CHUNK_INVALID');
      }
      const dataPosition = position + 8;
      const crcPosition = dataPosition + length;
      const nextPosition = crcPosition + 4;
      if (!Number.isSafeInteger(nextPosition) || nextPosition > stat.size) fail('Un chunk PNG est tronqué.', 'ARTIFACT_PNG_TRUNCATED');

      const expectedCrc = (await readExactly(handle, 4, crcPosition, 'ARTIFACT_PNG_TRUNCATED')).readUInt32BE(0);
      const actualCrc = await crc32FileRange(handle, typeBuffer, dataPosition, length);
      if (actualCrc !== expectedCrc) fail(`Le CRC du chunk ${type} est invalide.`, 'ARTIFACT_PNG_CRC_INVALID');

      if (chunkCount === 0 && type !== 'IHDR') fail('IHDR doit être le premier chunk PNG.', 'ARTIFACT_PNG_CHUNK_ORDER_INVALID');
      if ((typeBuffer[0] & 0x20) === 0 && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type)) {
        fail(`Le chunk critique PNG ${type} est inconnu.`, 'ARTIFACT_PNG_CHUNK_INVALID');
      }

      if (type === 'IHDR') {
        if (pngHeader || length !== 13 || chunkCount !== 0) fail('Le chunk IHDR est invalide.', 'ARTIFACT_PNG_IHDR_INVALID');
        pngHeader = validatePngHeader(await readExactly(handle, 13, dataPosition, 'ARTIFACT_PNG_TRUNCATED'));
      } else if (type === 'PLTE') {
        if (!pngHeader || sawPalette || idatChunkCount > 0 || length === 0 || length % 3 !== 0 || length > 768 || [0, 4].includes(pngHeader.colorType)
            || (pngHeader.colorType === 3 && length / 3 > 2 ** pngHeader.bitDepth)) {
          fail('Le chunk PLTE est invalide ou mal placé.', 'ARTIFACT_PNG_CHUNK_ORDER_INVALID');
        }
        sawPalette = true;
      } else if (type === 'IDAT') {
        if (!pngHeader || sawIend || idatEnded || (pngHeader.colorType === 3 && !sawPalette)) {
          fail('Un chunk IDAT est mal placé.', 'ARTIFACT_PNG_CHUNK_ORDER_INVALID');
        }
        idatChunkCount += 1;
        idatRanges.push({ position: dataPosition, length });
      } else {
        if (idatChunkCount > 0 && type !== 'IEND') idatEnded = true;
        if (type === 'IEND') {
          if (length !== 0 || idatChunkCount === 0 || sawIend) fail('Le chunk IEND est invalide.', 'ARTIFACT_PNG_CHUNK_ORDER_INVALID');
          sawIend = true;
          if (nextPosition !== stat.size) fail('Des octets suivent le chunk IEND.', 'ARTIFACT_PNG_TRAILING_DATA');
        }
      }

      chunkCount += 1;
      position = nextPosition;
      if (sawIend) break;
    }

    if (!pngHeader || !sawIend || idatChunkCount === 0) fail('La structure PNG est incomplète.', 'ARTIFACT_PNG_STRUCTURE_INVALID');
    await validatePngImageData(handle, idatRanges, pngDecodedLayout(pngHeader));
    return Object.freeze({
      valid: true,
      kind: 'png',
      sizeBytes: stat.size,
      width: pngHeader.width,
      height: pngHeader.height,
      chunkCount,
    });
  } finally {
    await handle.close();
  }
}

async function verifyInddFile(filePath) {
  const { handle, stat } = await openRegularFile(filePath);
  try {
    // INDD est un format propriétaire : on contrôle son magic stable et une taille
    // minimale crédible, sans prétendre interpréter sa structure interne.
    if (stat.size < 64) fail('La copie INDD est trop courte.', 'ARTIFACT_INDD_STRUCTURE_INVALID');
    const signature = await readExactly(handle, INDD_SIGNATURE.length, 0, 'ARTIFACT_INDD_STRUCTURE_INVALID');
    if (!signature.equals(INDD_SIGNATURE)) {
      fail('La signature binaire de la copie INDD est invalide.', 'ARTIFACT_INDD_SIGNATURE_MISMATCH');
    }
    return Object.freeze({ valid: true, kind: 'indd', sizeBytes: stat.size });
  } finally {
    await handle.close();
  }
}

function decodeZipName(buffer, flags) {
  return buffer.toString((flags & 0x0800) !== 0 ? 'utf8' : 'latin1');
}

function assertSafeZipName(name) {
  const segments = name.replaceAll('\\', '/').split('/');
  if (name.length === 0 || name.includes('\0') || name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:/.test(name) || segments.includes('..')) {
    fail('Une entrée IDML contient un chemin ZIP dangereux.', 'ARTIFACT_IDML_PATH_INVALID');
  }
}

async function locateZipEocd(handle, size) {
  const length = Math.min(size, MAX_ZIP_COMMENT_BYTES + 22);
  const start = size - length;
  const tail = await readExactly(handle, length, start, 'ARTIFACT_IDML_ZIP_INVALID');
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) !== ZIP_EOCD_SIGNATURE) continue;
    const commentLength = tail.readUInt16LE(index + 20);
    if (index + 22 + commentLength === tail.length) return { buffer: tail, offset: index, absoluteOffset: start + index };
  }
  fail('La fin du conteneur ZIP IDML est introuvable.', 'ARTIFACT_IDML_ZIP_INVALID');
}

async function readZipEntry(handle, entry) {
  if (entry.uncompressedSize > MAX_IDML_REQUIRED_ENTRY_BYTES || entry.compressedSize > MAX_IDML_REQUIRED_ENTRY_BYTES) {
    fail('Une entrée IDML requise dépasse la limite de validation.', 'ARTIFACT_IDML_RESOURCE_LIMIT');
  }
  const compressed = await readExactly(handle, entry.compressedSize, entry.dataOffset, 'ARTIFACT_IDML_ZIP_INVALID');
  let data;
  try {
    data = entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: MAX_IDML_REQUIRED_ENTRY_BYTES });
  } catch (error) {
    fail(`L’entrée IDML ${entry.name} ne peut pas être décompressée.`, 'ARTIFACT_IDML_ZIP_INVALID', error);
  }
  if (data.length !== entry.uncompressedSize || crc32(data) !== entry.crc) {
    fail(`L’entrée IDML ${entry.name} est corrompue.`, 'ARTIFACT_IDML_CRC_INVALID');
  }
  return data;
}

async function verifyZipEntryCrc(handle, entry) {
  let decodedSize = 0;
  let crc = 0xffffffff;
  try {
    const source = Readable.from(readFileRanges(handle, [{ position: entry.dataOffset, length: entry.compressedSize }], 'ARTIFACT_IDML_ZIP_INVALID'));
    const decoded = entry.method === 0 ? source : source.pipe(createInflateRaw());
    for await (const chunk of decoded) {
      decodedSize += chunk.length;
      if (decodedSize > entry.uncompressedSize) {
        decoded.destroy();
        fail(`L’entrée IDML ${entry.name} dépasse sa taille déclarée.`, 'ARTIFACT_IDML_CRC_INVALID');
      }
      crc = updateCrc32(crc, chunk);
    }
  } catch (error) {
    if (error instanceof ArtifactVerificationError) throw error;
    fail(`L’entrée IDML ${entry.name} ne peut pas être décompressée.`, 'ARTIFACT_IDML_ZIP_INVALID', error);
  }
  if (decodedSize !== entry.uncompressedSize || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) {
    fail(`L’entrée IDML ${entry.name} est corrompue.`, 'ARTIFACT_IDML_CRC_INVALID');
  }
}

async function verifyIdmlFile(filePath) {
  const { handle, stat } = await openRegularFile(filePath);
  try {
    if (stat.size < 22) fail('Le conteneur IDML est trop court.', 'ARTIFACT_IDML_ZIP_INVALID');
    const eocd = await locateZipEocd(handle, stat.size);
    const diskNumber = eocd.buffer.readUInt16LE(eocd.offset + 4);
    const centralDisk = eocd.buffer.readUInt16LE(eocd.offset + 6);
    const entriesOnDisk = eocd.buffer.readUInt16LE(eocd.offset + 8);
    const entryCount = eocd.buffer.readUInt16LE(eocd.offset + 10);
    const centralSize = eocd.buffer.readUInt32LE(eocd.offset + 12);
    const centralOffset = eocd.buffer.readUInt32LE(eocd.offset + 16);
    if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount || entryCount === 0 || entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      fail('Les archives IDML multidisques ou ZIP64 ne sont pas prises en charge.', 'ARTIFACT_IDML_ZIP_UNSUPPORTED');
    }
    if (centralSize > MAX_IDML_CENTRAL_DIRECTORY_BYTES || centralOffset + centralSize !== eocd.absoluteOffset) {
      fail('Le répertoire central IDML est invalide.', 'ARTIFACT_IDML_ZIP_INVALID');
    }

    const central = await readExactly(handle, centralSize, centralOffset, 'ARTIFACT_IDML_ZIP_INVALID');
    const entries = new Map();
    let totalUncompressedBytes = 0;
    let position = 0;
    for (let index = 0; index < entryCount; index += 1) {
      if (position + 46 > central.length || central.readUInt32LE(position) !== ZIP_CENTRAL_SIGNATURE) {
        fail('Une entrée du répertoire central IDML est invalide.', 'ARTIFACT_IDML_ZIP_INVALID');
      }
      const flags = central.readUInt16LE(position + 8);
      const method = central.readUInt16LE(position + 10);
      const crc = central.readUInt32LE(position + 16);
      const compressedSize = central.readUInt32LE(position + 20);
      const uncompressedSize = central.readUInt32LE(position + 24);
      const nameLength = central.readUInt16LE(position + 28);
      const extraLength = central.readUInt16LE(position + 30);
      const commentLength = central.readUInt16LE(position + 32);
      const diskStart = central.readUInt16LE(position + 34);
      const localOffset = central.readUInt32LE(position + 42);
      const next = position + 46 + nameLength + extraLength + commentLength;
      if (next > central.length || (flags & 1) !== 0 || ![0, 8].includes(method) || diskStart !== 0 || [compressedSize, uncompressedSize, localOffset].includes(0xffffffff)) {
        fail('Une entrée ZIP IDML utilise une structure non prise en charge.', 'ARTIFACT_IDML_ZIP_UNSUPPORTED');
      }
      const name = decodeZipName(central.subarray(position + 46, position + 46 + nameLength), flags);
      assertSafeZipName(name);
      if (entries.has(name)) fail('Le conteneur IDML contient une entrée dupliquée.', 'ARTIFACT_IDML_ZIP_INVALID');
      entries.set(name, { name, flags, method, crc, compressedSize, uncompressedSize, localOffset });
      totalUncompressedBytes += uncompressedSize;
      if (!Number.isSafeInteger(totalUncompressedBytes) || totalUncompressedBytes > MAX_IDML_TOTAL_UNCOMPRESSED_BYTES) {
        fail('Le contenu IDML dépasse la limite de validation.', 'ARTIFACT_IDML_RESOURCE_LIMIT');
      }
      position = next;
    }
    if (position !== central.length) fail('Le répertoire central IDML contient des données inattendues.', 'ARTIFACT_IDML_ZIP_INVALID');

    const localRanges = [];
    for (const entry of entries.values()) {
      if (entry.localOffset + 30 > centralOffset) fail('Une entrée locale IDML sort du conteneur.', 'ARTIFACT_IDML_ZIP_INVALID');
      const local = await readExactly(handle, 30, entry.localOffset, 'ARTIFACT_IDML_ZIP_INVALID');
      if (local.readUInt32LE(0) !== ZIP_LOCAL_SIGNATURE) fail('Un en-tête local IDML est invalide.', 'ARTIFACT_IDML_ZIP_INVALID');
      const localFlags = local.readUInt16LE(6);
      const localMethod = local.readUInt16LE(8);
      const localCrc = local.readUInt32LE(14);
      const localCompressedSize = local.readUInt32LE(18);
      const localUncompressedSize = local.readUInt32LE(22);
      const nameLength = local.readUInt16LE(26);
      const extraLength = local.readUInt16LE(28);
      const localNameBuffer = await readExactly(handle, nameLength, entry.localOffset + 30, 'ARTIFACT_IDML_ZIP_INVALID');
      const localName = decodeZipName(localNameBuffer, localFlags);
      const dataOffset = entry.localOffset + 30 + nameLength + extraLength;
      const dataEnd = dataOffset + entry.compressedSize;
      const sizesMismatch = (localFlags & 0x0008) === 0
        && (localCrc !== entry.crc || localCompressedSize !== entry.compressedSize || localUncompressedSize !== entry.uncompressedSize);
      if (localName !== entry.name || localMethod !== entry.method || localFlags !== entry.flags || sizesMismatch || dataEnd > centralOffset) {
        fail('Un en-tête local IDML ne correspond pas au répertoire central.', 'ARTIFACT_IDML_ZIP_INVALID');
      }
      entry.dataOffset = dataOffset;
      localRanges.push([entry.localOffset, dataEnd]);
    }
    localRanges.sort((left, right) => left[0] - right[0]);
    for (let index = 1; index < localRanges.length; index += 1) {
      if (localRanges[index][0] < localRanges[index - 1][1]) fail('Des entrées IDML locales se chevauchent.', 'ARTIFACT_IDML_ZIP_INVALID');
    }
    for (const entry of entries.values()) await verifyZipEntryCrc(handle, entry);

    const mimetypeEntry = entries.get('mimetype');
    const designmapEntry = entries.get('designmap.xml');
    if (!mimetypeEntry || !designmapEntry) {
      fail('Le paquet IDML doit contenir mimetype et designmap.xml à sa racine.', 'ARTIFACT_IDML_REQUIRED_ENTRY_MISSING');
    }
    if (mimetypeEntry.method !== 0 || mimetypeEntry.localOffset !== 0) fail('L’entrée mimetype IDML doit être la première et stockée sans compression.', 'ARTIFACT_IDML_MIMETYPE_INVALID');
    const mimetype = (await readZipEntry(handle, mimetypeEntry)).toString('utf8');
    if (mimetype !== IDML_MIMETYPE) fail('Le type MIME du paquet IDML est invalide.', 'ARTIFACT_IDML_MIMETYPE_INVALID');

    const designmap = (await readZipEntry(handle, designmapEntry)).toString('utf8');
    if (!/^\uFEFF?\s*(?:<\?[^>]+\?>\s*)*<Document\b/.test(designmap)
        || !/http:\/\/ns\.adobe\.com\/AdobeInDesign\/idml\/1\.0\/packaging/.test(designmap)) {
      fail('designmap.xml ne décrit pas un paquet IDML Adobe.', 'ARTIFACT_IDML_DESIGNMAP_INVALID');
    }

    return Object.freeze({ valid: true, kind: 'idml', sizeBytes: stat.size, entryCount });
  } finally {
    await handle.close();
  }
}

async function readArtifactDirectory(directoryPath) {
  const stat = await lstatArtifact(directoryPath);
  assertNotSymbolicLink(stat);
  if (!stat.isDirectory()) fail('L’artefact attendu doit être un dossier.', 'ARTIFACT_TYPE_MISMATCH');
  return fs.readdir(directoryPath, { withFileTypes: true });
}

function normalizeComparablePath(targetPath) {
  const resolved = path.resolve(targetPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export async function verifyMultipagePngDirectory(directoryPath, { expectedPaths } = {}) {
  const entries = await readArtifactDirectory(directoryPath);
  if (!Array.isArray(expectedPaths) || expectedPaths.length === 0 || expectedPaths.some((entry) => typeof entry !== 'string' || !path.isAbsolute(entry))) {
    fail('La liste absolue des PNG déclarés par InDesign est obligatoire.', 'ARTIFACT_EXPECTED_PATHS_INVALID');
  }
  if (entries.length === 0) fail('Le dossier multipage ne contient aucun PNG.', 'ARTIFACT_MULTIPAGE_EMPTY');
  if (entries.some((entry) => !entry.isFile() || path.extname(entry.name).toLowerCase() !== '.png')) {
    fail('Le dossier multipage contient une entrée qui n’est pas un fichier PNG.', 'ARTIFACT_MULTIPAGE_UNEXPECTED_ENTRY');
  }

  const actualPaths = entries.map((entry) => path.resolve(directoryPath, entry.name));
  const expectedComparable = expectedPaths.map(normalizeComparablePath);
  const actualComparable = actualPaths.map(normalizeComparablePath);
  const actualSet = new Set(actualComparable);
  if (new Set(expectedComparable).size !== expectedComparable.length
      || expectedComparable.length !== actualComparable.length
      || expectedComparable.some((entry) => !actualSet.has(entry))) {
    fail('Les PNG présents ne correspondent pas exactement aux fichiers déclarés par InDesign.', 'ARTIFACT_PATH_SET_MISMATCH');
  }

  for (const candidatePath of actualPaths) {
    try {
      await verifyPngFile(candidatePath);
    } catch (error) {
      if (!(error instanceof ArtifactVerificationError)) throw error;
      fail(`Le fichier ${path.basename(candidatePath)} n’est pas un PNG valide.`, 'ARTIFACT_MULTIPAGE_INVALID', error);
    }
  }

  return Object.freeze({
    valid: true,
    kind: 'multipage-png',
    entryCount: entries.length,
    pngCandidateCount: entries.length,
    validPngCount: entries.length,
  });
}

export async function verifyPackageDirectory(directoryPath) {
  await readArtifactDirectory(directoryPath);
  const pending = [path.resolve(directoryPath)];
  let entryCount = 0;
  let fileCount = 0;
  let usefulFileCount = 0;
  let totalSizeBytes = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > MAX_PACKAGE_ENTRIES) fail('Le package dépasse la limite de validation.', 'ARTIFACT_PACKAGE_RESOURCE_LIMIT');
      const entryPath = path.join(current, entry.name);
      const stat = await fs.lstat(entryPath);
      assertNotSymbolicLink(stat);
      if (stat.isDirectory()) {
        pending.push(entryPath);
      } else if (stat.isFile()) {
        fileCount += 1;
        totalSizeBytes += stat.size;
        if (stat.size > 0 && !IGNORED_PACKAGE_FILES.has(entry.name.toLowerCase())) usefulFileCount += 1;
      }
    }
  }

  if (entryCount === 0) fail('Le dossier package est vide.', 'ARTIFACT_PACKAGE_EMPTY');
  if (usefulFileCount === 0) fail('Le dossier package ne contient aucun fichier utile non vide.', 'ARTIFACT_PACKAGE_CONTENT_INVALID');
  return Object.freeze({ valid: true, kind: 'package', entryCount, fileCount, usefulFileCount, totalSizeBytes });
}

export async function verifyArtifact({ targetPath, kind, expectedPaths } = {}) {
  if (!SUPPORTED_KINDS.has(kind)) fail('Type d’artefact non pris en charge.', 'ARTIFACT_KIND_UNSUPPORTED');
  if (kind === 'pdf') return verifyPdfFile(targetPath);
  if (kind === 'png') return verifyPngFile(targetPath);
  if (kind === 'idml') return verifyIdmlFile(targetPath);
  if (kind === 'indd') return verifyInddFile(targetPath);
  if (kind === 'multipage-png') return verifyMultipagePngDirectory(targetPath, { expectedPaths });
  return verifyPackageDirectory(targetPath);
}

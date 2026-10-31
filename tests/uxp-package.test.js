import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { prepareUxpPackage, UXP_RUNTIME_FILES } from '../src/release/uxpPackage.js';
import { PACKAGE_VERSION } from '../src/version.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readCentralDirectory(archive) {
  const endSignature = 0x06054b50;
  let endOffset = -1;
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65_557); offset -= 1) {
    if (archive.readUInt32LE(offset) === endSignature) {
      endOffset = offset;
      break;
    }
  }
  assert.notEqual(endOffset, -1, 'enregistrement de fin ZIP absent');

  const entryCount = archive.readUInt16LE(endOffset + 10);
  let offset = archive.readUInt32LE(endOffset + 16);
  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(archive.readUInt32LE(offset), 0x02014b50, `entrée centrale ZIP ${index} invalide`);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    entries.push({
      name: archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'),
      dosTime: archive.readUInt16LE(offset + 12),
      dosDate: archive.readUInt16LE(offset + 14),
      externalAttributes: archive.readUInt32LE(offset + 38),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function createDeterministicCcx(sourceDirectory, destinationPath) {
  const result = spawnSync('pwsh', [
    '-NoProfile',
    '-File',
    path.join(repositoryRoot, 'scripts', 'New-DeterministicCcx.ps1'),
    '-SourceDirectory',
    sourceDirectory,
    '-DestinationPath',
    destinationPath,
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function verifyCcx(ccxPath, reportPath, normalize = false) {
  return spawnSync('pwsh', [
    '-NoProfile',
    '-Command',
    '& $env:UXP_VERIFY_SCRIPT -RepositoryRoot $env:UXP_VERIFY_REPO -CcxPath $env:UXP_VERIFY_CCX -ReportPath $env:UXP_VERIFY_REPORT -NormalizeLineEndings:([bool]::Parse($env:UXP_VERIFY_NORMALIZE)) | ConvertTo-Json -Compress',
  ], { encoding: 'utf8', windowsHide: true, env: {...process.env,
    UXP_VERIFY_SCRIPT: path.join(repositoryRoot, 'scripts', 'Test-UxpCcx.ps1'), UXP_VERIFY_REPO: repositoryRoot,
    UXP_VERIFY_CCX: ccxPath, UXP_VERIFY_REPORT: reportPath, UXP_VERIFY_NORMALIZE: String(normalize)} });
}

test('prépare un staging UXP minimal, déterministe et sans fichier documentaire', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'uxp-package-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = await prepareUxpPackage({
    sourceDirectory: path.join(repositoryRoot, 'plugin'),
    outputDirectory: path.join(root, 'first'),
    allowedOutputRoot: root,
  });
  const second = await prepareUxpPackage({
    sourceDirectory: path.join(repositoryRoot, 'plugin'),
    outputDirectory: path.join(root, 'second'),
    allowedOutputRoot: root,
  });

  assert.deepEqual(first.files, [...UXP_RUNTIME_FILES].sort());
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.version, PACKAGE_VERSION);
  assert.equal(first.host.minVersion, '19.0.0');
  assert.equal(await fs.stat(path.join(root, 'first', 'manifest.json')).then((value) => value.isFile()), true);
  assert.equal((await fs.readFile(path.join(root, 'first', 'manifest.json'), 'utf8')).endsWith('\n'), false);
  await assert.rejects(fs.access(path.join(root, 'first', 'README.md')));
  await assert.rejects(fs.access(path.join(root, 'first', 'package.json')));

  await fs.appendFile(path.join(root, 'first', 'index.js'), '\naltération locale à supprimer\n');
  const regenerated = await prepareUxpPackage({
    sourceDirectory: path.join(repositoryRoot, 'plugin'),
    outputDirectory: path.join(root, 'first'),
    allowedOutputRoot: root,
  });
  assert.equal(regenerated.fingerprint, first.fingerprint);
  assert.equal(sha256(await fs.readFile(path.join(root, 'first', 'index.js'))), first.fileHashes['index.js']);
});

test('un checkout CRLF produit exactement le paquet et les empreintes du checkout LF', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'uxp-package-eol-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const results = [];
  for (const eol of ['lf', 'crlf']) {
    const parent = path.join(root, eol);
    const source = path.join(parent, 'plugin');
    await fs.mkdir(source, {recursive: true});
    await fs.copyFile(path.join(repositoryRoot, 'package.json'), path.join(parent, 'package.json'));
    for (const file of UXP_RUNTIME_FILES) {
      const target = path.join(source, file);
      await fs.mkdir(path.dirname(target), {recursive: true});
      const text = (await fs.readFile(path.join(repositoryRoot, 'plugin', file), 'utf8')).replace(/\r\n/g, '\n');
      await fs.writeFile(target, eol === 'crlf' ? text.replace(/\n/g, '\r\n') : text);
    }
    results.push(await prepareUxpPackage({sourceDirectory: source,
      outputDirectory: path.join(root, eol + '-staged'), allowedOutputRoot: root}));
  }
  assert.equal(results[0].fingerprint, results[1].fingerprint);
  assert.deepEqual(results[0].fileHashes, results[1].fileHashes);
  const reportPath = path.join(root, 'report.json');
  await fs.writeFile(reportPath, JSON.stringify(results[0]));
  const legacyCcx = path.join(root, 'crlf.ccx');
  createDeterministicCcx(path.join(root, 'crlf', 'plugin'), legacyCcx);
  assert.notEqual(verifyCcx(legacyCcx, reportPath).status, 0, 'Le mode strict doit rester strict');
  const normalized = verifyCcx(legacyCcx, reportPath, true);
  assert.equal(normalized.status, 0, normalized.stderr || normalized.stdout);
  const proof = JSON.parse(normalized.stdout);
  assert.equal(proof.sourceFingerprint, results[0].fingerprint);
  assert.notEqual(proof.fingerprint, proof.sourceFingerprint, 'Empreinte brute du paquet conservée séparément');
  await fs.appendFile(path.join(root, 'crlf', 'plugin', 'index.js'), '\r\nthrow new Error("altered");\r\n');
  createDeterministicCcx(path.join(root, 'crlf', 'plugin'), legacyCcx);
  assert.notEqual(verifyCcx(legacyCcx, reportPath, true).status, 0, 'Une modification de code reste refusée');
});

test('refuse une sortie hors de la racine autorisée', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'uxp-package-root-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'uxp-package-outside-'));
  t.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(outside, { recursive: true, force: true }),
  ]));
  await assert.rejects(
    prepareUxpPackage({
      sourceDirectory: path.join(repositoryRoot, 'plugin'),
      outputDirectory: path.join(outside, 'package'),
      allowedOutputRoot: root,
    }),
    /UXP_OUTPUT_OUTSIDE_ALLOWED_ROOT/,
  );
});

test('refuse les secrets génériques dans le paquet UXP', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'uxp-package-secret-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'plugin');
  await Promise.all([
    fs.cp(path.join(repositoryRoot, 'plugin'), source, { recursive: true }),
    fs.copyFile(path.join(repositoryRoot, 'package.json'), path.join(root, 'package.json')),
  ]);

  const privateKeyMarker = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ');
  await fs.appendFile(path.join(source, 'index.js'), `\n// ${privateKeyMarker}\n`);
  await assert.rejects(
    prepareUxpPackage({
      sourceDirectory: source,
      outputDirectory: path.join(root, 'private-key-output'),
      allowedOutputRoot: root,
    }),
    /UXP_FORBIDDEN_CONTENT:PRIVATE_KEY:index\.js/,
  );

  await fs.copyFile(path.join(repositoryRoot, 'plugin', 'index.js'), path.join(source, 'index.js'));
  const pairingSecretMarker = ['pairing', 'secret'].join('_');
  await fs.appendFile(path.join(source, 'index.js'), `\n// ${pairingSecretMarker} = valeur-de-test\n`);
  await assert.rejects(
    prepareUxpPackage({
      sourceDirectory: source,
      outputDirectory: path.join(root, 'pairing-secret-output'),
      allowedOutputRoot: root,
    }),
    /UXP_FORBIDDEN_CONTENT:PAIRING_SECRET:index\.js/,
  );
});

test('refuse toute permission presse-papiers plus large que la lecture', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'uxp-package-clipboard-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'plugin');
  await Promise.all([
    fs.cp(path.join(repositoryRoot, 'plugin'), source, { recursive: true }),
    fs.copyFile(path.join(repositoryRoot, 'package.json'), path.join(root, 'package.json')),
  ]);
  const manifestPath = path.join(source, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.requiredPermissions.clipboard = 'readAndWrite';
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    prepareUxpPackage({
      sourceDirectory: source,
      outputDirectory: path.join(root, 'output'),
      allowedOutputRoot: root,
    }),
    /UXP_CLIPBOARD_PERMISSION_INVALID/,
  );
});

test('produit deux CCX strictement identiques depuis le même staging', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'uxp-ccx-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const staging = path.join(root, 'staging');
  await fs.mkdir(path.join(staging, 'vendor'), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(staging, 'manifest.json'), '{"manifestVersion":5}'),
    fs.writeFile(path.join(staging, 'index.js'), 'export const ready = true;\n'),
    fs.writeFile(path.join(staging, 'vendor', 'z.js'), 'z\n'),
    fs.writeFile(path.join(staging, 'vendor', 'a.js'), 'a\n'),
  ]);

  const oldTime = new Date('2001-02-03T04:05:06Z');
  const recentTime = new Date('2026-07-15T12:34:56Z');
  await Promise.all([
    fs.utimes(path.join(staging, 'manifest.json'), oldTime, oldTime),
    fs.utimes(path.join(staging, 'index.js'), recentTime, recentTime),
  ]);

  const firstPath = path.join(root, 'first.ccx');
  const secondPath = path.join(root, 'second.ccx');
  const first = createDeterministicCcx(staging, firstPath);

  await Promise.all([
    fs.utimes(path.join(staging, 'manifest.json'), recentTime, recentTime),
    fs.utimes(path.join(staging, 'index.js'), oldTime, oldTime),
  ]);
  const second = createDeterministicCcx(staging, secondPath);
  const [firstBytes, secondBytes] = await Promise.all([fs.readFile(firstPath), fs.readFile(secondPath)]);

  assert.equal(sha256(firstBytes), sha256(secondBytes));
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(first.entries, ['index.js', 'manifest.json', 'vendor/a.js', 'vendor/z.js']);
  assert.deepEqual(second.entries, first.entries);
  assert.deepEqual(readCentralDirectory(firstBytes), first.entries.map((name) => ({
    name,
    dosTime: 0,
    dosDate: 33,
    externalAttributes: 0,
  })));
});

test('sépare l’archive déterministe de référence du CCX officiel Adobe', async () => {
  const [buildScript, verifierScript] = await Promise.all([
    fs.readFile(path.join(repositoryRoot, 'scripts', 'Build-UxpCcx.ps1'), 'utf8'),
    fs.readFile(path.join(repositoryRoot, 'scripts', 'Test-UxpCcx.ps1'), 'utf8'),
  ]);
  assert.match(buildScript, /fr\.pironjulien\.indesign\.mcp_deterministic-reference\.ccx/);
  assert.doesNotMatch(buildScript, /fr\.pironjulien\.indesign\.mcp_ID\.ccx/);
  assert.match(buildScript, /Test-UxpCcx\.ps1/);
  assert.doesNotMatch(buildScript, /fingerprint\s*=\s*\$report\.fingerprint/);
  assert.match(verifierScript, /Get-PackageFingerprint/);
  assert.doesNotMatch(verifierScript, /fingerprint\s*=\s*\$report\.fingerprint/);
});

test('vérifie les huit octets utiles du CCX contre le rapport de staging', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'uxp-ccx-verify-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const staging = path.join(root, 'staging');
  const prepared = await prepareUxpPackage({
    sourceDirectory: path.join(repositoryRoot, 'plugin'),
    outputDirectory: staging,
    allowedOutputRoot: root,
  });
  const reportPath = path.join(root, 'report.json');
  await fs.writeFile(reportPath, JSON.stringify(prepared));
  const validCcx = path.join(root, 'valid.ccx');
  createDeterministicCcx(staging, validCcx);
  const valid = verifyCcx(validCcx, reportPath);
  assert.equal(valid.status, 0, valid.stderr || valid.stdout);

  await fs.writeFile(reportPath, JSON.stringify({ ...prepared, fingerprint: 'f'.repeat(64) }));
  const forgedFingerprint = verifyCcx(validCcx, reportPath);
  assert.notEqual(forgedFingerprint.status, 0);
  assert.match(forgedFingerprint.stderr, /empreinte logique.+staging/i);
  await fs.writeFile(reportPath, JSON.stringify(prepared));

  await fs.writeFile(path.join(staging, 'index.js'), '\naltération contrôlée\n', { flag: 'a' });
  const alteredCcx = path.join(root, 'altered.ccx');
  createDeterministicCcx(staging, alteredCcx);
  const altered = verifyCcx(alteredCcx, reportPath);
  assert.notEqual(altered.status, 0);
  assert.match(altered.stderr, /Empreinte CCX .* du staging/);
});

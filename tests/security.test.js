import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { FifoQueue, QueueFullError } from '../src/core/FifoQueue.js';
import { PathPolicy } from '../src/security/PathPolicy.js';
import { commandSignature, hmac, stableJson } from '../src/security/crypto.js';
import { applyWindowsTokenAcl, TokenStore } from '../src/security/TokenStore.js';
import { cleanupBackups } from '../src/security/BackupRetention.js';
import { verifyCodexParent } from '../src/security/ParentProcessPolicy.js';
import { prepareOutputTarget } from '../src/security/OutputProtection.js';
import { applyWindowsPrivateAcl } from '../src/security/PrivateAcl.js';
import { AuditLogger } from '../src/security/AuditLogger.js';
import { minimalWindowsEnvironment } from '../src/security/windowsEnvironment.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const { canonicalCommand: pluginCanonicalCommand, localHmacSha256Hex, utf8Encode } = require('../plugin/security-crypto.js');

async function temporaryDirectory() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'indesign-mcp-secure-'));
}

test('TokenStore publie un secret 256 bits stable sans course', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new TokenStore(path.join(directory, 'pairing.token'), { platform: 'linux' });
  const secrets = await Promise.all(Array.from({ length: 8 }, () => store.ensure()));
  assert.equal(new Set(secrets).size, 1);
  assert.equal(Buffer.from(secrets[0], 'base64url').length, 32);
  assert.equal((await fs.readFile(store.filePath, 'utf8')).trim(), secrets[0]);
});

test('TokenStore protège le dossier parent avant de créer son fichier temporaire', async (t) => {
  const directory = await temporaryDirectory();
  const tokenFile = path.join(directory, 'pairing.token');
  const order = [];
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new TokenStore(tokenFile, {
    platform: 'win32',
    applyPrivateAcl: async (target, options) => {
      assert.equal(target, directory);
      assert.deepEqual(options, { kind: 'directory', recursive: false });
      assert.deepEqual(await fs.readdir(directory), []);
      order.push('parent');
    },
    applyAcl: async () => order.push('file'),
  });
  await store.ensure();
  assert.deepEqual(order, ['parent', 'file']);
});

test('l’ACL Windows n’expose jamais le secret et refuse une vérification permissive', async () => {
  const calls = [];
  await applyWindowsTokenAcl('C:\\NexusSecure\\pairing.token', async (...args) => {
    calls.push(args);
    return { stdout: '{"protected":true,"badRules":0}' };
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'pwsh.exe');
  assert.equal(calls[0][2].env.INDESIGN_TOKEN_ACL_FILE, 'C:\\NexusSecure\\pairing.token');
  assert.equal(Object.keys(calls[0][2].env).some((key) => /token|secret/i.test(key) && key !== 'INDESIGN_TOKEN_ACL_FILE'), false);
  await assert.rejects(
    applyWindowsTokenAcl('C:\\NexusSecure\\pairing.token', async () => ({ stdout: '{"protected":false,"badRules":1}' })),
    /trop permissive/,
  );
});

test('l’environnement des contrôles Windows exclut les secrets du processus', () => {
  const environment = minimalWindowsEnvironment(
    { INDESIGN_MCP_PARENT_PID: '42' },
    { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', GITHUB_TOKEN: 'interdit', API_SECRET: 'interdit' },
  );
  assert.equal(environment.Path, 'C:\\Windows');
  assert.equal(environment.SystemRoot, 'C:\\Windows');
  assert.equal(environment.INDESIGN_MCP_PARENT_PID, '42');
  assert.equal(environment.GITHUB_TOKEN, undefined);
  assert.equal(environment.API_SECRET, undefined);
});

test('l’audit conserve la preuve de ciblage sans journaliser le code ni le motif', async (t) => {
  const directory = await temporaryDirectory();
  const auditFile = path.join(directory, 'audit.jsonl');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const logger = new AuditLogger(auditFile);
  await logger.write({
    event: 'execute_uxp',
    toolName: 'get_document_colors',
    documentId: 17,
    expectedRevision: 4,
    reason: 'MOTIF_CONFIDENTIEL_INTERDIT',
    sourceCodeSha256: 'a'.repeat(64),
    payloadCodeSha256: 'b'.repeat(64),
    rewriteApplied: true,
    payloadHasActiveDocument: false,
    payloadHasTargetDocument: true,
    requestedDocumentId: 17,
    resolvedTargetDocumentId: 17,
    activeDocumentIdBefore: 29,
    activeDocumentIdAfter: 29,
    resolutionMethod: 'itemByID.getElements',
    usedUndoTransaction: false,
    code: 'CODE_CONFIDENTIEL_INTERDIT',
    outcome: 'success',
    durationMs: 12,
  });
  const raw = await fs.readFile(auditFile, 'utf8');
  const event = JSON.parse(raw.trim());
  assert.equal(raw.includes('CODE_CONFIDENTIEL_INTERDIT'), false);
  assert.equal(raw.includes('MOTIF_CONFIDENTIEL_INTERDIT'), false);
  assert.equal(event.sourceCodeSha256, 'a'.repeat(64));
  assert.equal(event.payloadCodeSha256, 'b'.repeat(64));
  assert.equal(event.rewriteApplied, true);
  assert.equal(event.payloadHasActiveDocument, false);
  assert.equal(event.payloadHasTargetDocument, true);
  assert.equal(event.requestedDocumentId, 17);
  assert.equal(event.resolvedTargetDocumentId, 17);
  assert.equal(event.resolutionMethod, 'itemByID.getElements');
});

test('l’audit ne conserve que les codes erreur techniques bornés', async (t) => {
  const directory = await temporaryDirectory();
  const auditFile = path.join(directory, 'audit.jsonl');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const logger = new AuditLogger(auditFile);
  await logger.write({ event: 'tool_call', errorCode: 'STATE_CONFLICT', outcome: 'success' });
  await logger.write({ event: 'tool_call', errorCode: 'message prive interdit', outcome: 'error' });
  await logger.write({ event: 'tool_call', errorCode: 'OPEN_PROFILE_UNSTABLE\r\nCHEMIN_INTERDIT', outcome: 'error' });
  await logger.write({ event: 'tool_call', errorCode: `A${'B'.repeat(64)}`, outcome: 'error' });
  await logger.write({ event: 'tool_call', errorCode: 'OPEN_PROFILE_UNSTABLE', outcome: 'validation_error' });
  await logger.write({ event: 'execute_uxp', toolName: 'execute_uxp', errorCode: 'DOCUMENT_TEXT_SECRET', outcome: 'error' });
  await logger.write({ event: 'tool_call', toolName: 'execute_uxp_silent', errorCode: 'DOCUMENT_TEXT_SECRET', outcome: 'error' });
  const events = (await fs.readFile(auditFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(events[0].errorCode, undefined);
  assert.equal(events[1].errorCode, undefined);
  assert.equal(events[2].errorCode, undefined);
  assert.equal(events[3].errorCode, undefined);
  assert.equal(events[4].errorCode, 'OPEN_PROFILE_UNSTABLE');
  assert.equal(events[5].errorCode, undefined);
  assert.equal(events[6].errorCode, undefined);
});

test('l’ACL Windows réelle retire un droit tiers explicite', { skip: process.platform !== 'win32' }, async (t) => {
  const directory = await temporaryDirectory();
  const tokenFile = path.join(directory, 'pairing.token');
  await fs.writeFile(tokenFile, 'contenu-de-test');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await execFileAsync('icacls.exe', [tokenFile, '/grant', '*S-1-5-32-545:(R)', '/c'], { windowsHide: true });
  await applyWindowsTokenAcl(tokenFile);
});

test('le stockage privé transmet uniquement les droits utilisateur et SYSTEM', async () => {
  const calls = [];
  const result = await applyWindowsPrivateAcl('C:\\Dev\\work\\backups', {
    kind: 'directory',
    recursive: true,
    run: async (...args) => {
      calls.push(args);
      return { stdout: '{"protected":true,"badRules":0,"currentSidRules":1,"systemSidRules":1}' };
    },
  });
  assert.equal(result.badRules, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].env.INDESIGN_PRIVATE_ACL_PATH, 'C:\\Dev\\work\\backups');
  assert.equal(calls[0][2].env.INDESIGN_PRIVATE_ACL_KIND, 'directory');
  assert.equal(calls[0][2].env.INDESIGN_PRIVATE_ACL_RECURSIVE, '1');
  assert.match(calls[0][1].join(' '), /FileSystemAclExtensions/);
  assert.doesNotMatch(calls[0][1].join(' '), /(?:^|\n)\s*Set-Acl\b/);
  assert.equal(Object.keys(calls[0][2].env).some((key) => /token|secret/i.test(key)), false);
  await assert.rejects(
    applyWindowsPrivateAcl('C:\\Dev\\work\\audit', {
      kind: 'directory',
      run: async () => ({ stdout: '{"protected":false,"badRules":1,"currentSidRules":1,"systemSidRules":1}' }),
    }),
    /trop permissive/,
  );
});

test('les ACL Windows réelles protègent récursivement backups et audit', { skip: process.platform !== 'win32' }, async (t) => {
  const directory = await temporaryDirectory();
  const backupDirectory = path.join(directory, 'backups');
  const backupFile = path.join(backupDirectory, 'backup-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.indd');
  const auditDirectory = path.join(directory, 'audit');
  const auditFile = path.join(auditDirectory, 'events.jsonl');
  await Promise.all([fs.mkdir(backupDirectory), fs.mkdir(auditDirectory)]);
  await Promise.all([fs.writeFile(backupFile, 'backup-test'), fs.writeFile(auditFile, '')]);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await execFileAsync('icacls.exe', [backupDirectory, '/grant', '*S-1-5-32-545:(OI)(CI)(R)', '/c'], { windowsHide: true });
  await execFileAsync('icacls.exe', [backupFile, '/grant', '*S-1-5-32-545:(R)', '/c'], { windowsHide: true });
  const backups = await applyWindowsPrivateAcl(backupDirectory, { kind: 'directory', recursive: true });
  const auditDirectoryAcl = await applyWindowsPrivateAcl(auditDirectory, { kind: 'directory', recursive: true });
  const auditFileAcl = await applyWindowsPrivateAcl(auditFile, { kind: 'file' });
  assert.equal(backups.protected, true);
  assert.equal(backups.badRules, 0);
  assert.equal(auditDirectoryAcl.badRules, 0);
  assert.equal(auditFileAcl.protected, true);
  assert.equal(auditFileAcl.badRules, 0);
});

test('l’ACL privée réelle est idempotente sur un stockage Windows isolé sans privilège SACL', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const directory = await temporaryDirectory();
  await fs.writeFile(path.join(directory, 'secret-test'), 'valeur-factice');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const first = await applyWindowsPrivateAcl(directory, { kind: 'directory', recursive: true });
  const second = await applyWindowsPrivateAcl(directory, { kind: 'directory', recursive: true });
  assert.equal(first.protected, true);
  assert.equal(first.badRules, 0);
  assert.equal(second.protected, true);
  assert.equal(second.badRules, 0);
});

test('une sortie existante exige overwrite et reçoit une copie de sécurité', async (t) => {
  const directory = await temporaryDirectory();
  const backupRoot = path.join(directory, 'backups');
  const fileTarget = path.join(directory, 'livret.pdf');
  const folderTarget = path.join(directory, 'package');
  await Promise.all([fs.mkdir(backupRoot), fs.mkdir(folderTarget), fs.writeFile(fileTarget, 'ancienne-version')]);
  await fs.writeFile(path.join(folderTarget, 'document.indd'), 'package-original');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  await assert.rejects(
    prepareOutputTarget({ targetPath: fileTarget, kind: 'file', overwrite: false, backupRoot }),
    (error) => error.code === 'TARGET_EXISTS',
  );
  const fileBackup = await prepareOutputTarget({ targetPath: fileTarget, kind: 'file', overwrite: true, backupRoot });
  assert.equal(await fs.readFile(fileBackup.targetBackupPath, 'utf8'), 'ancienne-version');
  const folderBackup = await prepareOutputTarget({ targetPath: folderTarget, kind: 'directory', overwrite: true, backupRoot });
  assert.equal(await fs.readFile(path.join(folderBackup.targetBackupPath, 'document.indd'), 'utf8'), 'package-original');
  assert.deepEqual(await prepareOutputTarget({ targetPath: path.join(directory, 'nouveau.pdf'), kind: 'file', overwrite: false, backupRoot }), {});
});

test('stableJson et la signature de commande sont déterministes', () => {
  assert.equal(stableJson({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
  const envelope = { sessionChallenge: 'session', id: 'cmd-1', command: 'ping', documentId: 42, expectedRevision: 7, nonce: 'nonce', args: { b: 2, a: 1 } };
  assert.equal(commandSignature('secret', envelope), commandSignature('secret', { ...envelope, args: { a: 1, b: 2 } }));
  assert.notEqual(commandSignature('secret', envelope), hmac('secret', 'autre'));
});

test('le plugin et le serveur signent exactement le même état documentaire', () => {
  const secret = 'secret-de-test-partage-avec-le-plugin';
  const sessionChallenge = 'bridge-nonce:plugin-nonce';
  const envelope = {
    id: '12345678-1234-4123-8123-123456789abc',
    command: 'execute_uxp',
    documentId: 41,
    expectedRevision: 7,
    expectedStateToken: '0123456789abcdef', // gitleaks:allow
    nonce: 'n'.repeat(43),
    args: {
      scope: 'document',
      expectedDocumentStates: [
        { documentId: 41, revision: 7, stateToken: '0123456789abcdef' }, // gitleaks:allow
        { documentId: 99, revision: 2, stateToken: 'fedcba9876543210' }, // gitleaks:allow
      ],
      reason: 'Valider le vecteur partagé',
    },
  };
  const pluginProof = localHmacSha256Hex(
    utf8Encode(secret),
    utf8Encode(pluginCanonicalCommand(envelope, sessionChallenge)),
  );
  assert.equal(pluginProof, commandSignature(secret, { ...envelope, sessionChallenge }));
  assert.notEqual(
    pluginProof,
    commandSignature(secret, { ...envelope, sessionChallenge, expectedStateToken: '1111111111111111' }),
  );
});

test('PathPolicy bloque traversal, extension et jonction hors racine', async (t) => {
  const base = await temporaryDirectory();
  const readRoot = path.join(base, 'read');
  const writeRoot = path.join(base, 'write');
  const outside = path.join(base, 'outside');
  await Promise.all([fs.mkdir(readRoot), fs.mkdir(writeRoot), fs.mkdir(outside)]);
  await fs.writeFile(path.join(readRoot, 'source.pdf'), 'pdf');
  await fs.writeFile(path.join(readRoot, 'source.exe'), 'exe');
  await fs.writeFile(path.join(outside, 'secret.pdf'), 'secret');
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const policy = await PathPolicy.create({ readRoots: [readRoot], writeRoots: [writeRoot] });

  assert.equal(await policy.validateRead(path.join(readRoot, 'source.pdf'), { extensions: ['.pdf'] }), await fs.realpath(path.join(readRoot, 'source.pdf')));
  await assert.rejects(policy.validateRead(path.join(readRoot, 'source.exe'), { extensions: ['.pdf'] }), /extension non autorisée/);
  await assert.rejects(policy.validateRead(path.join(readRoot, '..', 'outside', 'secret.pdf'), { extensions: ['.pdf'] }), /sort des racines/);
  assert.equal(await policy.validateWrite(path.join(writeRoot, 'export.pdf'), { extensions: ['.pdf'] }), path.resolve(writeRoot, 'export.pdf'));
  await assert.rejects(policy.validateWrite(path.join(writeRoot, 'export.exe'), { extensions: ['.pdf'] }), /extension non autorisée/);

  const junction = path.join(readRoot, 'junction');
  try {
    await fs.symlink(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(policy.validateRead(path.join(junction, 'secret.pdf'), { extensions: ['.pdf'] }), /sort des racines/);
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
  }
});

test('PathPolicy donne toujours priorité aux racines privées interdites', async (t) => {
  const base = await temporaryDirectory();
  const allowed = path.join(base, 'documents');
  const denied = path.join(allowed, 'NexusSecure');
  await fs.mkdir(denied, { recursive: true });
  await fs.writeFile(path.join(allowed, 'maquette.indd'), 'document');
  await fs.writeFile(path.join(denied, 'bridge-token'), 'secret');
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const policy = await PathPolicy.create({
    readRoots: [allowed],
    writeRoots: [allowed],
    deniedRoots: [denied],
  });

  assert.equal(await policy.validateRead(path.join(allowed, 'maquette.indd')), await fs.realpath(path.join(allowed, 'maquette.indd')));
  await assert.rejects(policy.validateRead(path.join(denied, 'bridge-token')), /racine privée interdite/);
  await assert.rejects(policy.validateWrite(path.join(denied, 'export.pdf')), /racine privée interdite/);
});

test('FifoQueue conserve l’ordre réel et borne l’attente', async () => {
  const queue = new FifoQueue({ maxLength: 1 });
  const order = [];
  let release;
  const first = queue.enqueue(async () => { order.push('first-start'); await new Promise((resolve) => { release = resolve; }); order.push('first-end'); });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const second = queue.enqueue(async () => { order.push('second'); });
  await assert.rejects(queue.enqueue(async () => {}), QueueFullError);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);
});

test('la rétention ne supprime que les sauvegardes InDesign anciennes ou excédentaires', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const files = ['backup-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.indd', 'backup-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.indd', 'document.indd', 'target-backup-123e4567-e89b-42d3-a456-426614174000.pdf'];
  for (const file of files) await fs.writeFile(path.join(directory, file), file);
  const firstBackupMetadata = path.join(directory, files[0].replace(/\.indd$/i, '.meta.json'));
  await fs.writeFile(firstBackupMetadata, '{"schemaVersion":1}');
  const targetDirectory = path.join(directory, 'target-backup-123e4567-e89b-42d3-a456-426614174001');
  await fs.mkdir(targetDirectory);
  await fs.writeFile(path.join(targetDirectory, 'contenu.indd'), 'contenu');
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await fs.utimes(path.join(directory, files[0]), old, old);
  await fs.utimes(path.join(directory, files[3]), old, old);
  await fs.utimes(targetDirectory, old, old);
  const result = await cleanupBackups(directory, { maxAgeMs: 24 * 60 * 60 * 1000, maxFiles: 10 });
  assert.equal(result.removed, 3);
  await assert.rejects(fs.access(path.join(directory, files[0])));
  await assert.rejects(fs.access(firstBackupMetadata));
  await assert.rejects(fs.access(path.join(directory, files[3])));
  await assert.rejects(fs.access(targetDirectory));
  await fs.access(path.join(directory, files[1]));
  await fs.access(path.join(directory, files[2]));
});

test('la rétention conserve toute copie restaurée marquée comme potentiellement ouverte', async (t) => {
  const directory = await temporaryDirectory();
  const restoredDirectory = path.join(directory, 'restored');
  await fs.mkdir(restoredDirectory);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const protectedId = '12345678-1234-4123-8123-123456789abc';
  const removableId = '22345678-1234-4123-8123-123456789abc';
  const protectedCopy = path.join(restoredDirectory, `restore-${protectedId}.indd`);
  const protectedMarker = path.join(restoredDirectory, `restore-${protectedId}.open.json`);
  const removableCopy = path.join(restoredDirectory, `restore-${removableId}.indd`);
  await Promise.all([
    fs.writeFile(protectedCopy, 'copie-ouverte'),
    fs.writeFile(protectedMarker, JSON.stringify({ status: 'reserved-or-open' })),
    fs.writeFile(removableCopy, 'copie-fermee'),
  ]);
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await Promise.all([
    fs.utimes(protectedCopy, old, old),
    fs.utimes(protectedMarker, old, old),
    fs.utimes(removableCopy, old, old),
  ]);
  const result = await cleanupBackups(directory, { maxAgeMs: 1, maxFiles: 0 });
  assert.equal(result.removed, 1);
  assert.equal(result.skippedOpenRestored, 1);
  await fs.access(protectedCopy);
  await fs.access(protectedMarker);
  await assert.rejects(fs.access(removableCopy));
});

test('la rétention ne touche à aucune copie pendant une mutation inter-processus', async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const backup = path.join(directory, 'backup-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.indd');
  const runtime = path.join(directory, '.silent-runtime');
  await fs.mkdir(runtime);
  await fs.writeFile(backup, 'copie');
  await fs.writeFile(path.join(runtime, '.mutation-lease.json'), JSON.stringify({ operationId: '12345678-1234-4123-8123-123456789abc' }));
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await fs.utimes(backup, old, old);
  const result = await cleanupBackups(directory, { maxAgeMs: 1, maxFiles: 0 });
  assert.deepEqual(result, { inspected: 0, removed: 0, skippedForActiveMutation: true });
  await fs.access(backup);
});

test('la politique d’appelant exige codex.exe signé OpenAI, pas ChatGPT seul', async () => {
  const common = { allowedPaths: ['C:\\Program Files\\WindowsApps'], allowedSigners: ['OpenAI OpCo, LLC'], parentPid: 123, platform: 'win32' };
  const runFor = (executablePath) => async () => ({ stdout: JSON.stringify([{ processId: 123, executablePath, signatureStatus: 'Valid', signerSubject: 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC"' }]) });
  await assert.rejects(verifyCodexParent({ ...common, run: runFor('C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT_1\\ChatGPT.exe') }), /aucun ancêtre Codex/);
  const result = await verifyCodexParent({ ...common, run: runFor('C:\\Program Files\\WindowsApps\\OpenAI.Codex_1\\app\\resources\\codex.exe') });
  assert.equal(result.verified, true);
});

test('la politique d’appelant n’accepte claude.exe que nommé, signé Anthropic et dans son dossier', async () => {
  const claudeRoot = 'C:\\Users\\u\\AppData\\Roaming\\Claude\\claude-code';
  const claudeExe = `${claudeRoot}\\2.1.295\\abc\\claude.exe`;
  const anthropic = 'CN="Anthropic, PBC", O="Anthropic, PBC"';
  const runFor = (executablePath, signerSubject, signatureStatus = 'Valid') => async () => ({ stdout: JSON.stringify([{ processId: 123, executablePath, signatureStatus, signerSubject }]) });
  const both = { allowedPaths: ['C:\\Program Files\\WindowsApps', claudeRoot], allowedSigners: ['OpenAI OpCo, LLC', 'Anthropic, PBC'], parentPid: 123, platform: 'win32' };
  // Par défaut, seul codex.exe est accepté.
  await assert.rejects(verifyCodexParent({ ...both, run: runFor(claudeExe, anthropic) }), /aucun ancêtre/);
  const claude = { ...both, allowedNames: ['codex.exe', 'claude.exe'] };
  assert.equal((await verifyCodexParent({ ...claude, run: runFor(claudeExe, anthropic) })).verified, true);
  await assert.rejects(verifyCodexParent({ ...claude, run: runFor(claudeExe, anthropic, 'NotSigned') }), /aucun ancêtre/);
  await assert.rejects(verifyCodexParent({ ...claude, run: runFor(claudeExe, 'CN=Inconnu') }), /aucun ancêtre/);
  await assert.rejects(verifyCodexParent({ ...claude, run: runFor('C:\\Temp\\claude.exe', anthropic) }), /aucun ancêtre/);
  await assert.rejects(verifyCodexParent({ ...both, allowedNames: [], run: runFor(claudeExe, anthropic) }), /INDESIGN_MCP_ALLOWED_PARENT_NAMES/);
});

test('un fichier privé passe par icacls quand il ne reste que l’utilisateur et SYSTEM, sinon par PowerShell', { skip: process.platform !== 'win32' }, async (t) => {
  const directory = await temporaryDirectory();
  const file = path.join(directory, 'prive.json');
  await fs.writeFile(file, '{}');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sid = 'S-1-5-21-1-2-3-1001';
  const fakeNative = (listing) => {
    const calls = [];
    const native = async (exe, args) => {
      calls.push([path.basename(exe).toLowerCase(), ...args]);
      if (exe.toLowerCase().endsWith('whoami.exe')) return `"poste\exemple","${sid}"\r\n`;
      if (args.length === 1) return listing;
      return '';
    };
    return { native, calls };
  };
  const powershellCalls = [];
  const run = async (...args) => { powershellCalls.push(args); return { stdout: '{"protected":true,"badRules":0,"currentSidRules":1,"systemSidRules":1}' }; };

  const exact = fakeNative(`${file} AUTORITE NT\Système:(F)\r\n          POSTE\exemple:(F)\r\n\r\n1 fichiers traités\r\n`);
  const fast = await applyWindowsPrivateAcl(file, { kind: 'file', run, native: exact.native });
  assert.equal(fast.method, 'icacls');
  assert.equal(powershellCalls.length, 0);
  const grant = exact.calls.find((call) => call.includes('/inheritance:r'));
  assert.deepEqual(grant.slice(2), ['/inheritance:r', '/grant:r', `*${sid}:F`, '*S-1-5-18:F', '/q']);

  for (const listing of [
    `${file} AUTORITE NT\Système:(F)\r\n POSTE\exemple:(F)\r\n BUILTIN\Utilisateurs:(R)\r\n`,
    `${file} AUTORITE NT\Système:(I)(F)\r\n POSTE\exemple:(F)\r\n`,
    `${file} Tout le monde:(DENY)(F)\r\n POSTE\exemple:(F)\r\n`,
  ]) {
    const extra = fakeNative(listing);
    const fallback = await applyWindowsPrivateAcl(file, { kind: 'file', run, native: extra.native });
    assert.equal(fallback.method, undefined, 'repli PowerShell');
  }
  assert.equal(powershellCalls.length, 3);
});

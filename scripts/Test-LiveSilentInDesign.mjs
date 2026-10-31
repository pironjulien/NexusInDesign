import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { InDesignSilentBridge } from '../src/bridge/InDesignSilentBridge.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcher = path.join(repositoryRoot, 'scripts', 'Invoke-InDesignScript.ps1');
const fixtures = path.join(repositoryRoot, 'scripts', 'fixtures');
// Stockage privé du runtime local (install.ps1), hors OneDrive et hors dépôt.
const workRoot = path.join(os.homedir(), '.nexus', 'indesign-mcp-secure', 'private', 'live-test');
const backupRoot = path.join(workRoot, 'backups');

async function runFixture(name, language = 'UXP') {
  const scriptPath = path.join(fixtures, name);
  const { stdout } = await execFileAsync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', launcher, '-ScriptPath', scriptPath, '-Language', language], {
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 4_194_304,
  });
  const envelope = JSON.parse(stdout.trim());
  const result = typeof envelope.result === 'string' ? JSON.parse(envelope.result) : envelope.result;
  if (result?.ok === false) throw new Error(result.message || `${name} a échoué.`);
  return result;
}

async function main() {
  assert.equal(process.platform, 'win32', 'Le test InDesign réel exige Windows.');
  await fs.rm(workRoot, { recursive: true, force: true });
  await fs.mkdir(backupRoot, { recursive: true });
  const bridge = new InDesignSilentBridge({ backupDirectory: backupRoot, timeoutMs: 120_000 });
  await bridge.initialize();
  let created = false;
  let ownedDocumentId;
  let existingStates = new Map();
  try {
    const status = await bridge.status();
    assert.ok(Number.parseFloat(status.version) >= 19, `InDesign 19+ requis; version détectée: ${status.version}`);
    assert.ok(Number.parseFloat(status.domVersion) >= 19, `DOM InDesign 19+ requis; version détectée: ${status.domVersion}`);
    assert.equal(status.modalState, false);
    const before = await bridge.listDocuments();
    existingStates = new Map();
    for (const document of before.documents) {
      const inspected = await bridge.inspectDocument(document.documentId);
      existingStates.set(document.documentId, inspected.document.stateToken);
    }

    const createdResult = await runFixture('Create-LiveSilentDocument.idjs');
    created = true;
    ownedDocumentId = createdResult.documentId;
    const initial = await bridge.inspectDocument(createdResult.documentId);
    assert.equal(initial.document.pages, 2);
    assert.equal(initial.document.facingPages, true);
    assert.ok(Math.abs(initial.document.width - 148) < 0.01);
    assert.ok(Math.abs(initial.document.height - 210) < 0.01);
    assert.equal(initial.document.pageItems, 0);

    const firstMutation = await bridge.executeDocument({
        documentId: initial.document.documentId,
        expectedRevision: initial.document.revision,
        expectedStateToken: initial.document.stateToken,
        reason: 'Tester l’exécution asynchrone réelle',
        code: `const frame = doc.pages.item(0).textFrames.add();
frame.geometricBounds = [20, 20, 60, 120];
frame.contents = "Validation UXP silencieuse";
await new Promise((resolve) => setTimeout(resolve, 75));
return { frameId: Number(frame.id) };`,
    });
    assert.ok(firstMutation.result.frameId > 0);
    assert.equal(firstMutation.safetyBackups.length, before.documents.length + 1);
    const initialBackup = firstMutation.safetyBackups.find((backup) => backup.documentId === initial.document.documentId);
    assert.ok(initialBackup);
    assert.equal((await fs.stat(initialBackup.backupPath)).size > 0, true);
    const afterFirst = await bridge.inspectDocument(initial.document.documentId);
    assert.equal(afterFirst.document.revision, 1);
    assert.equal(afterFirst.document.pageItems, 1);
    assert.equal(afterFirst.document.stateToken, firstMutation.stateToken);

    await runFixture('Mutate-LiveSilentStyle.idjs');
    const manual = await bridge.inspectDocument(initial.document.documentId);
    assert.equal(manual.document.revision, 1);
    assert.notEqual(manual.document.stateToken, afterFirst.document.stateToken);
    await assert.rejects(
      bridge.executeDocument({
        documentId: manual.document.documentId,
        expectedRevision: 1,
        expectedStateToken: afterFirst.document.stateToken,
        reason: 'Vérifier le conflit réel',
        code: 'return null;',
      }),
      (error) => error.code === 'STATE_CONFLICT',
    );

    const secondMutation = await bridge.executeDocument({
      documentId: manual.document.documentId,
      expectedRevision: manual.document.revision,
      expectedStateToken: manual.document.stateToken,
      reason: 'Vérifier une seconde mutation asynchrone réelle',
      code: `const first = doc.pages.item(0).textFrames.add();
first.geometricBounds = [70, 20, 90, 120];
await new Promise((resolve) => setTimeout(resolve, 50));
const second = doc.pages.item(0).textFrames.add();
second.geometricBounds = [100, 20, 120, 120];
return { ids: [Number(first.id), Number(second.id)] };`,
    });
    assert.equal(secondMutation.result.ids.length, 2);
    const afterSecond = await bridge.inspectDocument(manual.document.documentId);
    assert.equal(afterSecond.document.pageItems, 3);
    assert.equal(afterSecond.document.revision, 2);

    const restored = await bridge.restoreBackup({
      documentId: afterSecond.document.documentId,
      expectedRevision: afterSecond.document.revision,
      expectedStateToken: afterSecond.document.stateToken,
      backupId: initialBackup.backupId,
      reason: 'Vérifier la restauration silencieuse réelle',
    });
    ownedDocumentId = restored.restoredDocumentId;
    const restoredInspection = await bridge.inspectDocument(restored.restoredDocumentId);
    assert.equal(restoredInspection.document.pageItems, 0);
    assert.equal(restoredInspection.document.revision, 3);
    assert.equal(restored.recoveryBackups.length, before.documents.length + 1);
    assert.equal((await fs.stat(restored.restoredWorkingPath)).size > 0, true);
    for (const [documentId, stateToken] of existingStates) {
      const inspected = await bridge.inspectDocument(documentId);
      assert.equal(inspected.document.stateToken, stateToken, 'Un document utilisateur a changé pendant le test.');
    }

    process.stdout.write(`${JSON.stringify({
      ok: true,
      inDesignVersion: status.version,
      domVersion: status.domVersion,
      asyncCompletion: true,
      staleStyleStateBlocked: true,
      revisionAndStateVerified: true,
      silentRestoreVerified: true,
      restoredWorkingCopyVerified: true,
      existingDocumentsPreserved: existingStates.size,
      verifiedBackupCount: firstMutation.safetyBackups.length + restored.recoveryBackups.length,
    }, null, 2)}\n`);
  } finally {
    try {
      if (created) {
        const cleanup = await runFixture('Cleanup-LiveSilentDocuments.idjs');
        assert.equal(cleanup?.ok, true, 'Le nettoyage synchrone ExtendScript n’a pas confirmé son exécution.');
        const deadline = Date.now() + 10_000;
        let remaining;
        do {
          remaining = await runFixture('Count-LiveSilentDocuments.idjs');
          if (remaining.owned > 0) await new Promise((resolve) => setTimeout(resolve, 50));
        } while (remaining.owned > 0 && Date.now() < deadline);
        assert.equal(remaining.owned, 0, 'Un document jetable du test est resté ouvert.');
      }
    } finally {
      await bridge.close();
      await fs.rm(workRoot, { recursive: true, force: true });
    }
  }
}

await main();

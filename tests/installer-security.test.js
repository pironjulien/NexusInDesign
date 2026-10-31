import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { PACKAGE_VERSION } from '../src/version.js';

const execFileAsync = promisify(execFile);

function packageFingerprint(files, fileHashes) {
  return createHash('sha256')
    .update([...files].sort().map((file) => `${file}\0${fileHashes[file]}`).join('\n'), 'utf8')
    .digest('hex');
}

test('le synchroniseur du plugin Codex autorise les documents sans exposer NexusSecure', async () => {
  const source = await fs.readFile(path.resolve('scripts', 'Sync-CodexPlugin.ps1'), 'utf8');
  const manifest = JSON.parse(await fs.readFile(path.resolve('codex-plugin', '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'nexus-indesign');
  const versionPattern = PACKAGE_VERSION.replaceAll('.', '\\.');
  assert.match(manifest.version, new RegExp(`^${versionPattern}\\+codex\\.\\d{14}$`));
  assert.equal(manifest.mcpServers, undefined);
  // Du runtime, seuls e2e et qualification sont des racines documents (src et private restent intouchables).
  assert.doesNotMatch(source, /\$documentRoots = @\([^\n]*\$runtime\b/);
  assert.match(source, /@\('e2e', 'qualification'\)/);
  // L'ancien plugin ne quitte le catalogue qu'après un retrait réussi.
  assert.ok(source.indexOf('plugin remove "indesign-secure') < source.lastIndexOf("Write-CodexMarketplace -Without 'nexus-indesign', 'indesign-secure'"));
  assert.match(source, /INDESIGN_MCP_READ_ROOTS/);
  assert.match(source, /INDESIGN_MCP_WRITE_ROOTS/);
  assert.match(source, /INDESIGN_MCP_DENIED_ROOTS/);
  assert.match(source, /Get-Command codex -All/);
  assert.match(source, /node_modules\\@openai\\codex/);
  assert.match(source, /Get-AuthenticodeSignature/);
  assert.match(source, /OpenAI OpCo, LLC/);
  assert.match(source, /Add-Member -NotePropertyName 'mcpServers' -NotePropertyValue '\.\/\.mcp\.json'/);
  assert.match(source, /NexusSecure/);
  assert.match(source, /Assert-InsideUserProfile/);
  assert.doesNotMatch(source, /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/);
});

test('le plugin Codex embarque ses vraies icônes Nexus InDesign, PNG 64 et 512 px', async () => {
  const root = path.resolve('codex-plugin');
  const manifest = JSON.parse(await fs.readFile(path.join(root, '.codex-plugin', 'plugin.json'), 'utf8'));
  for (const [field, size] of [['composerIcon', 64], ['logo', 512]]) {
    const relative = manifest.interface[field];
    assert.match(relative, /^\.\/assets\/[A-Za-z0-9_.-]+\.png$/);
    const png = await fs.readFile(path.join(root, relative));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [size, size]);
    assert.ok(png.length > 1000, `${field}: vraie image du produit, pas une pastille vide`);
  }
});

test('le skill InDesign route les écritures vers run_layout_script, l’aperçu regardé et la preuve finale', async () => {
  const skillRoot = path.resolve('codex-plugin', 'skills', 'indesign-studio');
  const [skill, workflows, recipes, interfaceMetadata, manifest] = await Promise.all([
    fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8'),
    fs.readFile(path.join(skillRoot, 'references', 'workflows.md'), 'utf8'),
    fs.readFile(path.join(skillRoot, 'references', 'editorial-recipes.md'), 'utf8'),
    fs.readFile(path.join(skillRoot, 'agents', 'openai.yaml'), 'utf8'),
    fs.readFile(path.resolve('codex-plugin', '.codex-plugin', 'plugin.json'), 'utf8').then(JSON.parse),
  ]);

  assert.match(skill, /\[editorial-recipes\.md\]\(references\/editorial-recipes\.md\)/);
  assert.match(skill, /`run_layout_script` avec `documentId`, `expectedRevision`, `expectedStateToken`/);
  assert.match(skill, /Ouvrir chaque fichier de `previewPaths` et le juger réellement/);
  assert.match(skill, /restent la source de vérité/);
  assert.match(skill, /`preflight_document`/);
  assert.match(skill, /`silent_restore_backup` et le `backupId`/);
  assert.match(skill, /Trois cycles de correction au plus/);
  assert.doesNotMatch(skill, /Réserver les outils structurés du plugin aux corrections ciblées/);
  assert.match(workflows, /le passer à `run_layout_script` plutôt que d'enchaîner des commandes unitaires/);
  assert.match(workflows, /Regrouper les petites corrections dans un même script/);
  assert.match(workflows, /utiliser le MCP pour l'audit InDesign final/);
  for (const term of ['magazine', 'brochure premium', 'rapport', 'couverture complète', 'catalogue']) {
    assert.match(skill, new RegExp(term, 'i'));
  }
  for (const heading of ['Magazine', 'Brochure premium', 'Rapport', 'Couverture complète', 'Catalogue']) {
    assert.match(recipes, new RegExp(`^## ${heading}$`, 'm'));
  }
  assert.match(recipes, /Ne jamais calculer ni finaliser une tranche sans spécification d'imprimeur/);
  assert.match(recipes, /Demander l'accord explicite avant la fusion/);
  assert.doesNotMatch(interfaceMetadata, /\uFFFD/);
  assert.match(interfaceMetadata, /\$indesign-studio/);
  assert.equal(manifest.interface.defaultPrompt.length, 3);
});

test('la vérification relit DENIED_ROOTS dans la table env et contrôle Adobe persistant', async () => {
  const source = await fs.readFile(path.resolve('scripts', 'Test-Installation.ps1'), 'utf8');
  assert.match(source, /serverEnvPattern/);
  assert.match(source, /\[regex\]::Match\(\$serverEnvBlock,\s*'\(\?m\)/);
  assert.match(source, /Adobe\\UXP\\PluginsInfo\\v1\\ID\.json/);
  assert.match(source, /Adobe\\UXP\\Plugins\\External/);
  assert.match(source, /versionString\s+-eq\s+\$expectedVersion/);
  assert.match(source, /status\s+-ne\s+'enabled'/);
  assert.match(source, /requiredPermissions\.clipboard\s+-ne\s+'read'/);
  assert.match(source, /Test-UxpPackageDirectory\.ps1/);
  assert.match(source, /Prepare-UxpPackage\.mjs/);
  assert.match(source, /work\\uxp-package-manifest\.json/);
  assert.match(source, /\$stagingVerification\.files\s+-ne\s+8/);
  assert.match(source, /\$externalPackageVerification\.files\s+-ne\s+8/);
  assert.match(source, /\$ccxVerification\.sourceFingerprint\s+-cne\s+\$stagingVerification\.fingerprint/);
  assert.match(source, /\$externalPackageVerification\.sourceFingerprint\s+-cne\s+\$stagingVerification\.fingerprint/);
  assert.match(source, /\$externalPackageVerification\.fingerprint\s+-cne\s+\$verifiedArtifact\.fingerprint/);
  const stagingRegeneration = source.indexOf('& node $stageScript');
  assert.ok(stagingRegeneration > -1, 'la régénération du staging doit être exécutée');
  assert.ok(stagingRegeneration < source.indexOf('& npm test'), 'le staging doit être régénéré avant les tests');
  assert.ok(stagingRegeneration < source.indexOf("& '.\\scripts\\Test-UxpCcx.ps1'"), 'le staging doit être régénéré avant le contrôle CCX');
});

test('la vérification Adobe External exige les huit fichiers exacts et leurs SHA-256', {
  skip: process.platform !== 'win32',
  timeout: 30_000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-adobe-external-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, `fr.pironjulien.indesign.mcp_${PACKAGE_VERSION}`);
  const reportPath = path.join(root, 'uxp-package-manifest.json');
  const verifier = path.resolve('scripts', 'Test-UxpPackageDirectory.ps1');
  const files = [
    'commands.js',
    'index.html',
    'index.js',
    'manifest.json',
    'security-crypto.js',
    'validation.js',
    'vendor/LICENSE.js-sha256.txt',
    'vendor/js-sha256.js',
  ];
  const contents = Object.fromEntries(files.map((file) => [file, `contenu vérifié : ${file}\n`]));
  const fileHashes = Object.fromEntries(files.map((file) => [
    file,
    createHash('sha256').update(contents[file]).digest('hex'),
  ]));
  const fingerprint = packageFingerprint(files, fileHashes);
  const validReport = { files, fileHashes, fingerprint };

  await Promise.all(files.map(async (file) => {
    const target = path.join(packageRoot, ...file.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents[file]);
  }));
  await fs.writeFile(reportPath, JSON.stringify(validReport));

  const verify = (rootToVerify = packageRoot) => execFileAsync('pwsh.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', verifier,
    '-PackageRoot', rootToVerify,
    '-ReportPath', reportPath,
  ], { timeout: 10_000, windowsHide: true });

  await verify();

  await fs.writeFile(reportPath, JSON.stringify({ ...validReport, fingerprint: '0'.repeat(64) }));
  await assert.rejects(verify(), /empreinte logique.+staging/i);
  await fs.writeFile(reportPath, JSON.stringify(validReport));

  const extraPath = path.join(packageRoot, 'README.md');
  await fs.writeFile(extraPath, 'fichier indésirable');
  await assert.rejects(verify(), /exactement huit fichiers uniques/i);
  await fs.rm(extraPath);

  const tamperedPath = path.join(packageRoot, 'index.js');
  await fs.writeFile(tamperedPath, 'contenu altéré');
  await assert.rejects(verify(), /Empreinte Adobe External diff/i);
  await fs.writeFile(tamperedPath, contents['index.js']);

  const missingPath = path.join(packageRoot, 'commands.js');
  await fs.rm(missingPath);
  await assert.rejects(verify(), /exactement huit fichiers uniques/i);
  await fs.writeFile(missingPath, contents['commands.js']);

  const rootJunction = path.join(root, 'package-root-junction');
  await fs.symlink(packageRoot, rootJunction, 'junction');
  await assert.rejects(verify(rootJunction), /racine.+reparse point/i);

  const linkedFile = path.join(packageRoot, 'linked-file.js');
  const linkedFileTarget = path.join(root, 'linked-file-target.js');
  await fs.writeFile(linkedFileTarget, 'cible hors paquet');
  try {
    await fs.symlink(linkedFileTarget, linkedFile, 'file');
    await assert.rejects(verify(), /reparse point interdit.+linked-file\.js/i);
    await fs.unlink(linkedFile);
  } catch (error) {
    if (error?.code !== 'EPERM') throw error;
    t.diagnostic('Le système ne permet pas de créer un lien symbolique de fichier sans élévation.');
  }

  const linkedDirectory = path.join(packageRoot, 'linked-directory');
  const linkedDirectoryTarget = path.join(root, 'linked-directory-target');
  await fs.mkdir(linkedDirectoryTarget);
  await fs.symlink(linkedDirectoryTarget, linkedDirectory, 'junction');
  await assert.rejects(verify(), /reparse point interdit.+linked-directory/i);
});

test('l’appairage live est automatique et le live conserve toute issue inconnue', async () => {
  const [liveTest, targetingDiagnostic, packageJson, configSource] = await Promise.all([
    fs.readFile(path.resolve('scripts', 'Test-LiveInDesign.mjs'), 'utf8'),
    fs.readFile(path.resolve('scripts', 'Diagnose-LiveTargeting.mjs'), 'utf8'),
    fs.readFile(path.resolve('package.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.resolve('src', 'config.js'), 'utf8'),
  ]);

  assert.equal(packageJson.scripts['test:live:smoke'], 'node scripts/Test-LiveInDesign.mjs --smoke');
  assert.equal(packageJson.scripts['pair:standalone'], undefined);
  // Plus d'inscription directe par la ligne de commande Codex : le plugin déclare le serveur.
  assert.equal(packageJson.scripts.pair, undefined);
  for (const removed of ['Install-CodexMcp.ps1', 'Start-SecurePairing.ps1']) {
    await assert.rejects(fs.access(path.resolve('scripts', removed)), { code: 'ENOENT' });
  }
  assert.match(configSource, /Le mode --pair est supprimé/);

  assert.match(liveTest, /bridge_arm_pairing_clipboard/);
  assert.match(liveTest, /child\.stdin\.end\(input, 'utf8'\)/);
  assert.match(liveTest, /appairage automatique armé par une lecture unique/);
  assert.doesNotMatch(liveTest, /code temporaire à saisir/);
  assert.match(liveTest, /const PAIRING_WAIT_MS = \(PAIRING_WINDOW_SECONDS \* 1000\) \+ 5_000/);
  const cleanupBlock = liveTest.slice(
    liveTest.indexOf('const cleanupOwnedDocuments'),
    liveTest.indexOf('const reconcileBeforeCleanup'),
  );
  assert.match(cleanupBlock, /rawCall\('silent_list_documents'/);
  assert.match(cleanupBlock, /rawCall\('silent_inspect_document'/);
  assert.match(cleanupBlock, /rawCall\('silent_close_document'/);
  assert.doesNotMatch(cleanupBlock, /rawCall\('list_documents'/);
  assert.match(liveTest, /unresolvedInspectionOperations/);
  assert.match(liveTest, /cleanupConfirmed/);
  assert.match(liveTest, /if \(!unresolvedInspectionWithoutOperation && unresolvedInspectionOperations\.size === 0 && cleanupConfirmed\)/);

  const targetingReconciliation = targetingDiagnostic.slice(
    targetingDiagnostic.indexOf('const reconcileOperations'),
    targetingDiagnostic.indexOf('const cleanupOwnedDocuments'),
  );
  assert.match(targetingReconciliation, /silent_reconcile_unknown_operation/);
  assert.doesNotMatch(targetingReconciliation, /initialStatus[\s\S]+status === 'not-found'/);
  assert.match(targetingDiagnostic, /activeDocumentIdBefore === activeDocumentId/);
  assert.match(targetingDiagnostic, /activeDocumentIdAfter === activeDocumentId/);
  assert.match(targetingDiagnostic, /payloadHasActiveDocument === false/);
  assert.match(targetingDiagnostic, /payloadHasTargetDocument === true/);
  assert.match(targetingDiagnostic, /resolutionMethod === 'itemByID\.getElements'/);
  assert.match(targetingDiagnostic, /rewriteApplied === false/);
  assert.match(targetingDiagnostic, /sourceCodeSha256 === evidence\.payloadCodeSha256/);
  assert.match(targetingDiagnostic, /failureCode: 'UNHANDLED_FAILURE'/);
  assert.match(targetingDiagnostic, /failureTool: null/);
  assert.match(targetingDiagnostic, /throw new McpCallFailure\(name, mcpFailureCode\(response\)\)/);
  assert.match(targetingDiagnostic, /return 'UNCLASSIFIED_FAILURE'/);
});

test('la release privée ancre le CCX et l’installation multi-PC reste vérifiable de bout en bout', {
  skip: process.platform !== 'win32',
  timeout: 30_000,
}, async () => {
  const packageJson = JSON.parse(await fs.readFile(path.resolve('package.json'), 'utf8'));
  const pluginManifest = JSON.parse(await fs.readFile(path.resolve('plugin', 'manifest.json'), 'utf8'));
  const releasePath = path.resolve('release', `v${packageJson.version}.json`);
  const release = JSON.parse(await fs.readFile(releasePath, 'utf8'));
  const [getVerified, workstation, publisher, synchronizer] = await Promise.all([
    fs.readFile(path.resolve('scripts', 'Get-VerifiedCcx.ps1'), 'utf8'),
    fs.readFile(path.resolve('scripts', 'Install-Workstation.ps1'), 'utf8'),
    fs.readFile(path.resolve('scripts', 'Publish-GitHubRelease.ps1'), 'utf8'),
    fs.readFile(path.resolve('scripts', 'Sync-CodexPlugin.ps1'), 'utf8'),
  ]);

  assert.equal(release.schemaVersion, 1);
  assert.equal(release.version, packageJson.version);
  assert.equal(release.version, pluginManifest.version);
  assert.equal(release.tag, `v${release.version}`);
  assert.equal(release.pluginId, pluginManifest.id);
  assert.match(release.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(release.asset.name, /^[A-Za-z0-9_.-]+\.ccx$/);
  assert.match(release.asset.sha256, /^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(release.asset.size) && release.asset.size > 0);
  assert.equal(release.package.files, 8);
  assert.match(release.package.fingerprint, /^[a-f0-9]{64}$/);

  assert.match(getVerified, /gh\.Source release download/);
  assert.match(getVerified, /Get-FileHash.+SHA256/s);
  assert.match(getVerified, /Test-UxpCcx\.ps1/);
  assert.match(getVerified, /fingerprint -cne \$release\.package\.fingerprint/);
  assert.match(workstation, /UnifiedPluginInstallerAgent\.exe/);
  assert.match(workstation, /\/install \$verifiedCcx\.path/);
  assert.match(workstation, /'install\.ps1'/);
  assert.match(workstation, /'scripts\\Sync-CodexPlugin\.ps1'\) -RepositoryRoot \$repo -Install/);
  assert.doesNotMatch(workstation, /update_plugin_cachebuster\.py|\$npm\.Source ci/);
  assert.match(workstation, /Test-Installation\.ps1/);
  assert.match(publisher, /git -C \$repo status --porcelain/);
  assert.match(publisher, /rev-parse '@\{upstream\}'/);
  assert.match(publisher, /refus d’écrasement implicite/);
  assert.match(synchronizer, /Initialize-SecureStorage\.mjs/);
  assert.match(synchronizer, /Protect-WindowsPrivatePath\.ps1/);

  for (const script of [
    'Get-VerifiedCcx.ps1',
    'Install-Workstation.ps1',
    'Publish-GitHubRelease.ps1',
    'Sync-CodexPlugin.ps1',
  ]) {
    await execFileAsync('pwsh.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile($env:SCRIPT,[ref]$tokens,[ref]$errors)|Out-Null; if($errors.Count -gt 0){$errors|ForEach-Object{$_.Message}|Write-Error; exit 1}',
    ], {
      env: { ...process.env, SCRIPT: path.resolve('scripts', script) },
      windowsHide: true,
    });
  }

  const officialCcx = path.resolve('dist', release.asset.name);
  try {
    const ccx = await fs.readFile(officialCcx);
    assert.equal(ccx.length, release.asset.size);
    assert.equal(createHash('sha256').update(ccx).digest('hex'), release.asset.sha256);
    const { stdout } = await execFileAsync('pwsh.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-File',
      path.resolve('scripts', 'Get-VerifiedCcx.ps1'),
      '-RepositoryRoot',
      path.resolve('.'),
      '-ReleaseManifest',
      releasePath,
      '-CcxPath',
      officialCcx,
    ], { windowsHide: true });
    assert.match(stdout, new RegExp(release.asset.sha256, 'i'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
});

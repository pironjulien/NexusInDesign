import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { minimalWindowsEnvironment } from './windowsEnvironment.js';

const execFileAsync = promisify(execFile);

const ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:INDESIGN_PRIVATE_ACL_PATH
$kind = $env:INDESIGN_PRIVATE_ACL_KIND
$recursive = $env:INDESIGN_PRIVATE_ACL_RECURSIVE -eq '1'
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$allowed = @($currentSid.Value, $systemSid.Value)

if ($kind -eq 'directory') {
  if (-not (Test-Path -LiteralPath $target -PathType Container)) { throw 'Le dossier prive est introuvable.' }
} elseif ($kind -eq 'file') {
  if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw 'Le fichier prive est introuvable.' }
} else {
  throw 'Type de cible ACL invalide.'
}

function Set-PrivateDacl([string]$path, [bool]$isDirectory) {
  # Construire un descripteur contenant uniquement la DACL evite que Set-Acl
  # tente aussi de reappliquer la SACL OneDrive, operation qui exigerait le
  # privilege SeSecurityPrivilege. Le proprietaire et l'audit restent intacts.
  $acl = if ($isDirectory) {
    [System.Security.AccessControl.DirectorySecurity]::new()
  } else {
    [System.Security.AccessControl.FileSecurity]::new()
  }
  $acl.SetAccessRuleProtection($true, $false)
  if ($isDirectory) {
    $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    $propagation = [System.Security.AccessControl.PropagationFlags]::None
    [void]$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($currentSid, 'FullControl', $inheritance, $propagation, 'Allow'))
    [void]$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($systemSid, 'FullControl', $inheritance, $propagation, 'Allow'))
    $info = [System.IO.DirectoryInfo]::new($path)
    [System.IO.FileSystemAclExtensions]::SetAccessControl($info, $acl)
  } else {
    [void]$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($currentSid, 'FullControl', 'Allow'))
    [void]$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($systemSid, 'FullControl', 'Allow'))
    $info = [System.IO.FileInfo]::new($path)
    [System.IO.FileSystemAclExtensions]::SetAccessControl($info, $acl)
  }
}

$children = @()
if ($kind -eq 'directory' -and $recursive) {
  $children = @(Get-ChildItem -LiteralPath $target -Force -Recurse)
  if (@($children | Where-Object { $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint }).Count -gt 0) {
    throw 'Une jonction ou un lien symbolique est interdit dans un stockage prive.'
  }
}

Set-PrivateDacl $target ($kind -eq 'directory')
foreach ($child in $children) {
  Set-PrivateDacl $child.FullName $child.PSIsContainer
}

$targets = @((Get-Item -LiteralPath $target))
if ($kind -eq 'directory' -and $recursive) {
  $targets += @(Get-ChildItem -LiteralPath $target -Force -Recurse)
}
$badRules = 0
foreach ($item in $targets) {
  $info = if ($item.PSIsContainer) { [System.IO.DirectoryInfo]::new($item.FullName) } else { [System.IO.FileInfo]::new($item.FullName) }
  $itemAcl = [System.IO.FileSystemAclExtensions]::GetAccessControl($info, [System.Security.AccessControl.AccessControlSections]::Access)
  foreach ($rule in @($itemAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))) {
    $ruleSid = $rule.IdentityReference.Value
    if ($allowed -notcontains $ruleSid -or $rule.AccessControlType -ne 'Allow') { $badRules++ }
  }
}
$targetInfo = if ($kind -eq 'directory') { [System.IO.DirectoryInfo]::new($target) } else { [System.IO.FileInfo]::new($target) }
$finalAcl = [System.IO.FileSystemAclExtensions]::GetAccessControl($targetInfo, [System.Security.AccessControl.AccessControlSections]::Access)
$finalRules = @($finalAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
[pscustomobject]@{
  protected = $finalAcl.AreAccessRulesProtected
  badRules = $badRules
  currentSidRules = @($finalRules | Where-Object { $_.IdentityReference.Value -eq $currentSid.Value }).Count
  systemSidRules = @($finalRules | Where-Object { $_.IdentityReference.Value -eq $systemSid.Value }).Count
} | ConvertTo-Json -Compress
`;

const SYSTEM_SID = 'S-1-5-18';
const currentSidByRunner = new WeakMap();

// Exécutable natif, entrée standard fermée : sous un serveur MCP en STDIO, un enfant ne doit jamais hériter du
// canal du protocole.
function runNative(file, args, { timeout = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: minimalWindowsEnvironment() });
    const chunks = [];
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${path.basename(file)} a dépassé son délai.`)); }, timeout);
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', () => {});
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks).toString('latin1'));
      else reject(new Error(`${path.basename(file)} a échoué (code ${code}).`));
    });
  });
}

function system32(executable) {
  return path.join(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows', 'System32', executable);
}

async function currentUserSid(native) {
  if (!currentSidByRunner.has(native)) {
    currentSidByRunner.set(native, native(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh']).then((output) => {
      const sid = output.match(/S-1-5-21-\d+-\d+-\d+-\d+/)?.[0];
      if (!sid) throw new Error('SID de l’utilisateur courant introuvable.');
      return sid;
    }));
  }
  try { return await currentSidByRunner.get(native); }
  catch (error) { currentSidByRunner.delete(native); throw error; }
}

// Voie rapide pour un fichier (~30 ms au lieu de ~400 ms) : héritage coupé, accès complet accordé à l'utilisateur
// courant et à SYSTEM, puis relecture. Exactement deux entrées après ces deux attributions = aucun autre accès.
// Toute autre situation repasse par la voie PowerShell, qui reconstruit une DACL neuve.
async function applyFilePrivateAclFast(targetPath, native) {
  const stat = await fs.lstat(targetPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Le fichier prive est introuvable.');
  const sid = await currentUserSid(native);
  await native(system32('icacls.exe'), [targetPath, '/inheritance:r', '/grant:r', `*${sid}:F`, `*${SYSTEM_SID}:F`, '/q']);
  const listing = await native(system32('icacls.exe'), [targetPath]);
  const entries = listing.split(/\r?\n/).filter((line) => line.includes(':('));
  const exact = entries.length === 2 && entries.every((line) => /:\(F\)\s*$/.test(line) && !line.includes('(I)') && !line.includes('(DENY)'));
  return exact ? { protected: true, badRules: 0, currentSidRules: 1, systemSidRules: 1, method: 'icacls' } : null;
}

export async function applyWindowsPrivateAcl(targetPath, { kind, recursive = false, run = execFileAsync, native } = {}) {
  if (!['directory', 'file'].includes(kind)) throw new Error('kind doit valoir directory ou file.');
  // Un run injecté sans native (tests de la voie PowerShell) garde la voie historique.
  if (kind === 'file' && process.platform === 'win32' && (native || run === execFileAsync)) {
    const fast = await applyFilePrivateAclFast(targetPath, native ?? runNative).catch(() => null);
    if (fast) return fast;
  }
  const { stdout } = await run('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', ACL_SCRIPT], {
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 256 * 1024,
    env: minimalWindowsEnvironment({
      INDESIGN_PRIVATE_ACL_PATH: targetPath,
      INDESIGN_PRIVATE_ACL_KIND: kind,
      INDESIGN_PRIVATE_ACL_RECURSIVE: recursive ? '1' : '0',
    }),
  });
  const verification = JSON.parse(stdout);
  if (
    verification.protected !== true
    || verification.badRules !== 0
    || verification.currentSidRules < 1
    || verification.systemSidRules < 1
  ) {
    throw new Error('L’ACL du stockage privé reste trop permissive après correction.');
  }
  return verification;
}

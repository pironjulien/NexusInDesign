import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { applyWindowsPrivateAcl } from './PrivateAcl.js';
import { minimalWindowsEnvironment } from './windowsEnvironment.js';

const execFileAsync = promisify(execFile);

const ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$p = $env:INDESIGN_TOKEN_ACL_FILE
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$allowed = @($currentSid.Value, $systemSid.Value)
if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { throw 'Le secret est introuvable.' }

# Utiliser directement l'API ACL .NET évite la dépendance au comportement de
# pipeline de l'exécutable icacls dans un serveur MCP lancé en STDIO.
$acl = [System.Security.AccessControl.FileSecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
[void]$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($currentSid, 'FullControl', 'Allow'))
[void]$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($systemSid, 'FullControl', 'Allow'))
$info = [System.IO.FileInfo]::new($p)
[System.IO.FileSystemAclExtensions]::SetAccessControl($info, $acl)

$finalAcl = [System.IO.FileSystemAclExtensions]::GetAccessControl(
  $info,
  [System.Security.AccessControl.AccessControlSections]::Access
)
$rules = @($finalAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
$bad = @($rules | Where-Object {
  $allowed -notcontains $_.IdentityReference.Value -or $_.AccessControlType -ne 'Allow'
})
[pscustomobject]@{
  protected = $finalAcl.AreAccessRulesProtected
  badRules = $bad.Count
} | ConvertTo-Json -Compress
`;

export async function applyWindowsTokenAcl(filePath, run = execFileAsync) {
  const { stdout } = await run('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', ACL_SCRIPT], {
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 128 * 1024,
    env: minimalWindowsEnvironment({ INDESIGN_TOKEN_ACL_FILE: filePath }),
  });
  const verification = JSON.parse(stdout);
  if (verification.protected !== true || verification.badRules !== 0) {
    throw new Error('L’ACL du secret reste trop permissive après correction.');
  }
}

function validateSecret(secret) {
  if (typeof secret !== 'string' || Buffer.from(secret, 'base64url').length !== 32) {
    throw new Error('Le secret d’appairage est invalide; supprimez le fichier et relancez l’appairage.');
  }
  return secret;
}

export class TokenStore {
  constructor(filePath, { platform = process.platform, applyAcl = applyWindowsTokenAcl, applyPrivateAcl = applyWindowsPrivateAcl } = {}) {
    if (!path.isAbsolute(filePath)) throw new Error('Le chemin du secret doit être absolu.');
    this.filePath = filePath;
    this.platform = platform;
    this.applyAcl = applyAcl;
    this.applyPrivateAcl = applyPrivateAcl;
  }

  async ensure() {
    const parent = path.dirname(this.filePath);
    await fs.access(parent, constants.W_OK);
    if (this.platform === 'win32') await this.applyPrivateAcl(parent, { kind: 'directory', recursive: false });
    try {
      const secret = validateSecret((await fs.readFile(this.filePath, 'utf8')).trim());
      if (this.platform === 'win32') await this.applyAcl(this.filePath);
      return secret;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const temporary = path.join(parent, `.${path.basename(this.filePath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
    const secret = randomBytes(32).toString('base64url');
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(secret, { encoding: 'utf8' });
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        // Le lien dur publie d’un coup un fichier déjà synchronisé et refuse l’écrasement.
        await fs.link(temporary, this.filePath);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      const stored = validateSecret((await fs.readFile(this.filePath, 'utf8')).trim());
      if (this.platform === 'win32') await this.applyAcl(this.filePath);
      return stored;
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temporary).catch(() => {});
    }
  }
}

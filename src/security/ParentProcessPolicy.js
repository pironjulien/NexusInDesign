import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { minimalWindowsEnvironment } from './windowsEnvironment.js';

const execFileAsync = promisify(execFile);

function isAllowedPath(candidate, allowed) {
  const normalized = path.normalize(candidate).toLowerCase();
  return allowed.some((entry) => {
    const expected = path.normalize(entry).toLowerCase();
    if (normalized === expected) return true;
    const relative = path.relative(expected, normalized);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
}

const POWERSHELL = String.raw`
$ErrorActionPreference = 'Stop'
$pidToRead = [int]$env:INDESIGN_MCP_PARENT_PID
$result = @()
for ($i = 0; $i -lt 20 -and $pidToRead -gt 0; $i++) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$pidToRead"
  if ($null -eq $process) { break }
  $status = $null
  $subject = $null
  if ($process.ExecutablePath) {
    $signature = Get-AuthenticodeSignature -LiteralPath $process.ExecutablePath
    $status = [string]$signature.Status
    if ($signature.SignerCertificate) { $subject = $signature.SignerCertificate.Subject }
  }
  $result += [pscustomobject]@{ processId=$process.ProcessId; parentProcessId=$process.ParentProcessId; executablePath=$process.ExecutablePath; signatureStatus=$status; signerSubject=$subject }
  $pidToRead = [int]$process.ParentProcessId
}
$result | ConvertTo-Json -Compress
`;

export async function verifyCodexParent({ allowedPaths, allowedSigners, allowedNames = ['codex.exe'], parentPid = process.ppid, platform = process.platform, run = execFileAsync } = {}) {
  if (platform !== 'win32') throw new Error('La politique de parent signée est conçue pour Windows.');
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) {
    throw new Error('INDESIGN_MCP_ALLOWED_PARENT_PATHS doit autoriser explicitement l’exécutable de l’agent (Codex ou Claude).');
  }
  if (!Array.isArray(allowedSigners) || allowedSigners.length === 0) {
    throw new Error('INDESIGN_MCP_ALLOWED_PARENT_SIGNERS doit contenir le signataire attendu.');
  }
  if (!Array.isArray(allowedNames) || allowedNames.length === 0) {
    throw new Error('INDESIGN_MCP_ALLOWED_PARENT_NAMES doit nommer l’exécutable de l’agent autorisé.');
  }
  const names = allowedNames.map((name) => String(name).toLowerCase());
  const { stdout } = await run('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL], {
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    env: minimalWindowsEnvironment({ INDESIGN_MCP_PARENT_PID: String(parentPid) }),
  });
  const parsed = JSON.parse(stdout || '[]');
  const chain = Array.isArray(parsed) ? parsed : [parsed];
  const authorized = chain.find((entry) =>
    typeof entry.executablePath === 'string'
    && names.includes(path.basename(entry.executablePath).toLowerCase())
    && entry.signatureStatus === 'Valid'
    && isAllowedPath(entry.executablePath, allowedPaths)
    && allowedSigners.some((signer) => String(entry.signerSubject ?? '').toLowerCase().includes(signer.toLowerCase())),
  );
  if (!authorized) throw new Error('Démarrage refusé: aucun ancêtre Codex ou agent signé ne correspond à la liste autorisée.');
  return { verified: true, processId: authorized.processId, executablePath: authorized.executablePath, signerSubject: authorized.signerSubject };
}

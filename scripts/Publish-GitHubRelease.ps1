[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$ReleaseManifest = '',
    [string]$CcxPath = '',
    [switch]$Draft
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = (Resolve-Path -LiteralPath $RepositoryRoot -ErrorAction Stop).Path
$packageJson = Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($ReleaseManifest)) {
    $ReleaseManifest = Join-Path $repo ("release\v{0}.json" -f $packageJson.version)
}
if ([string]::IsNullOrWhiteSpace($CcxPath)) {
    $CcxPath = Join-Path $repo 'dist\fr.pironjulien.indesign.mcp_ID.ccx'
}

$verified = & (Join-Path $repo 'scripts\Get-VerifiedCcx.ps1') `
    -RepositoryRoot $repo `
    -ReleaseManifest $ReleaseManifest `
    -CcxPath $CcxPath
$manifestPath = (Resolve-Path -LiteralPath $ReleaseManifest -ErrorAction Stop).Path
$assetPath = $verified.path
$checksumPath = Join-Path (Split-Path -Parent $assetPath) 'SHA256SUMS.txt'
$checksumLine = "$($verified.sha256)  $([System.IO.Path]::GetFileName($assetPath))`n"
[System.IO.File]::WriteAllText($checksumPath, $checksumLine, [System.Text.UTF8Encoding]::new($false))

$status = git -C $repo status --porcelain
if ($LASTEXITCODE -ne 0 -or $status) { throw 'La publication exige un dépôt Git propre.' }
$head = (git -C $repo rev-parse HEAD).Trim()
$upstream = (git -C $repo rev-parse '@{upstream}').Trim()
if ($LASTEXITCODE -ne 0 -or $head -cne $upstream) { throw 'La branche locale doit être poussée avant la release.' }

$gh = Get-Command gh -CommandType Application -ErrorAction Stop
& $gh.Source auth status *> $null
if ($LASTEXITCODE -ne 0) { throw 'GitHub CLI doit être authentifié pour publier la release.' }
& $gh.Source release view $verified.tag --repo $verified.repository *> $null
if ($LASTEXITCODE -eq 0) { throw "La release $($verified.tag) existe déjà ; refus d’écrasement implicite." }

if (-not $PSCmdlet.ShouldProcess("$($verified.repository) $($verified.tag)", 'Créer la release GitHub et téléverser le CCX vérifié')) {
    Write-Host 'Simulation terminée : aucune release GitHub créée.'
    return
}

$notes = @"
## Nexus InDesign $($verified.version)

Paquet Adobe UXP officiel vérifié contre les sources du dépôt.

- Plugin : $($verified.pluginId)
- Fichiers utiles : $($verified.files)
- SHA-256 : $($verified.sha256)
- Empreinte logique : $($verified.fingerprint)

Installation complète : pwsh -NoProfile -File scripts/Install-Workstation.ps1
"@
$arguments = @(
    'release', 'create', $verified.tag,
    '--repo', $verified.repository,
    '--target', $head,
    '--title', "Nexus InDesign $($verified.version)",
    '--notes', $notes,
    $assetPath,
    $checksumPath,
    $manifestPath
)
if ($Draft) { $arguments += '--draft' }
& $gh.Source @arguments
if ($LASTEXITCODE -ne 0) { throw 'La création de la release GitHub a échoué.' }

& $gh.Source release view $verified.tag --repo $verified.repository --json tagName,targetCommitish,isDraft,assets,url
if ($LASTEXITCODE -ne 0) { throw 'La release créée ne peut pas être relue.' }

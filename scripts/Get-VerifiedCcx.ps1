[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$ReleaseManifest = '',
    [string]$CcxPath = '',
    [string]$DestinationDirectory = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Resolve-FullPath {
    param([Parameter(Mandatory)][string]$Path)
    if ([System.IO.Path]::IsPathFullyQualified($Path)) {
        return [System.IO.Path]::GetFullPath($Path)
    }
    return [System.IO.Path]::GetFullPath((Join-Path $repo $Path))
}

$repo = (Resolve-Path -LiteralPath $RepositoryRoot -ErrorAction Stop).Path
$packageJson = Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json
$pluginManifest = Get-Content -LiteralPath (Join-Path $repo 'plugin\manifest.json') -Raw | ConvertFrom-Json

if ([string]::IsNullOrWhiteSpace($ReleaseManifest)) {
    $ReleaseManifest = Join-Path $repo ("release\v{0}.json" -f $packageJson.version)
}
$releaseManifestPath = (Resolve-Path -LiteralPath (Resolve-FullPath -Path $ReleaseManifest) -ErrorAction Stop).Path
$release = Get-Content -LiteralPath $releaseManifestPath -Raw | ConvertFrom-Json

if ($release.schemaVersion -ne 1) { throw 'Version de schéma de release non prise en charge.' }
if ($release.version -ne $packageJson.version -or $release.version -ne $pluginManifest.version) {
    throw 'La version de la release, du serveur et du plugin Adobe doit être identique.'
}
if ($release.tag -cne "v$($release.version)") { throw 'Le tag de release ne correspond pas à la version.' }
if ($release.pluginId -cne $pluginManifest.id) { throw 'La release ne cible pas le plugin Adobe courant.' }
if ($release.repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'Dépôt GitHub de release invalide.' }
if ($release.asset.name -notmatch '^[A-Za-z0-9_.-]+\.ccx$') { throw "Nom d'asset CCX invalide." }
if ($release.asset.sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Empreinte SHA-256 de release invalide.' }
if ([long]$release.asset.size -le 0) { throw 'Taille de release invalide.' }
if ([int]$release.package.files -ne 8 -or $release.package.fingerprint -cnotmatch '^[a-f0-9]{64}$') {
    throw 'Contrat logique du paquet de release invalide.'
}

if ([string]::IsNullOrWhiteSpace($CcxPath)) {
    if ([string]::IsNullOrWhiteSpace($DestinationDirectory)) {
        $DestinationDirectory = Join-Path $env:LOCALAPPDATA ("NexusTests\indesign-releases\{0}" -f $release.version)
    }
    $destination = Resolve-FullPath -Path $DestinationDirectory
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    # Premier gh du PATH : un poste peut en avoir plusieurs.
    $gh = Get-Command gh -CommandType Application -All -ErrorAction Stop | Select-Object -First 1
    & $gh.Source auth status *> $null
    if ($LASTEXITCODE -ne 0) { throw 'GitHub CLI doit être authentifié pour télécharger la release.' }
    & $gh.Source release download $release.tag `
        --repo $release.repository `
        --pattern $release.asset.name `
        --dir $destination `
        --clobber
    if ($LASTEXITCODE -ne 0) { throw "Téléchargement de la release $($release.tag) impossible." }
    $CcxPath = Join-Path $destination $release.asset.name
}

$ccx = (Resolve-Path -LiteralPath (Resolve-FullPath -Path $CcxPath) -ErrorAction Stop).Path
$ccxItem = Get-Item -LiteralPath $ccx -Force
if ($ccxItem.PSIsContainer -or (($ccxItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw 'Le CCX doit être un fichier réel, pas un dossier ou un lien.'
}
if ($ccxItem.Length -ne [long]$release.asset.size) { throw 'La taille du CCX ne correspond pas à la release.' }
$sha256 = (Get-FileHash -LiteralPath $ccx -Algorithm SHA256).Hash.ToLowerInvariant()
if ($sha256 -cne $release.asset.sha256) { throw 'Le SHA-256 du CCX ne correspond pas à la release suivie par Git.' }

$verificationRoot = Join-Path $env:LOCALAPPDATA ('NexusTests\indesign-release-check-' + [guid]::NewGuid().ToString('N'))
try {
& node (Join-Path $repo 'scripts\Prepare-UxpPackage.mjs') --work-root $verificationRoot | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'La préparation du staging UXP a échoué.' }
$reportPath = Join-Path $verificationRoot 'uxp-package-manifest.json'
$verification = & (Join-Path $repo 'scripts\Test-UxpCcx.ps1') `
    -RepositoryRoot $repo `
    -CcxPath $ccx `
    -ReportPath $reportPath -NormalizeLineEndings
if (-not $verification -or $verification.files -ne [int]$release.package.files) {
    throw "Le contenu du CCX n'a pas passé la vérification structurelle."
}
if ($verification.fingerprint -cne $release.package.fingerprint) {
    throw 'Le contenu logique du CCX ne correspond pas à la release suivie par Git.'
}
} finally {
    $allowedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'NexusTests')).TrimEnd('\') + '\'
    $resolvedVerificationRoot = [IO.Path]::GetFullPath($verificationRoot)
    if ($resolvedVerificationRoot.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedVerificationRoot)) {
        Remove-Item -LiteralPath $resolvedVerificationRoot -Recurse -Force
    }
}

[pscustomobject]@{
    path = $ccx
    tag = $release.tag
    version = $release.version
    repository = $release.repository
    pluginId = $release.pluginId
    sha256 = $sha256
    files = $verification.files
    fingerprint = $verification.fingerprint
}

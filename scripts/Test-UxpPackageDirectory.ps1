[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PackageRoot,

    [Parameter(Mandatory = $true)]
    [string]$ReportPath,
    [switch]$NormalizeLineEndings
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-PackageFingerprint {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Files,

        [Parameter(Mandatory = $true)]
        [hashtable]$Hashes
    )

    $lines = @($Files | ForEach-Object { "$_`0$($Hashes[$_])" })
    $payload = [System.Text.UTF8Encoding]::new($false).GetBytes([string]::Join("`n", $lines))
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return [Convert]::ToHexString($sha.ComputeHash($payload)).ToLowerInvariant() }
    finally { $sha.Dispose() }
}

$packageItem = Get-Item -LiteralPath $PackageRoot -Force -ErrorAction Stop
if (-not $packageItem.PSIsContainer -or (($packageItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw 'La racine du paquet Adobe External doit être un dossier réel, pas un reparse point.'
}
$package = $packageItem.FullName
$reportFile = (Resolve-Path -LiteralPath $ReportPath -ErrorAction Stop).Path
$report = Get-Content -LiteralPath $reportFile -Raw | ConvertFrom-Json

$expectedFiles = @($report.files | ForEach-Object {
    if ($_ -isnot [string] -or [string]::IsNullOrWhiteSpace($_)) {
        throw 'Le rapport UXP contient un chemin de fichier invalide.'
    }
    $relativePath = $_.Replace('\', '/')
    $segments = @($relativePath.Split('/'))
    if (
        [System.IO.Path]::IsPathFullyQualified($relativePath) -or
        $relativePath.StartsWith('/') -or
        $segments.Count -eq 0 -or
        @($segments | Where-Object { [string]::IsNullOrWhiteSpace($_) -or $_ -in @('.', '..') }).Count -gt 0
    ) {
        throw "Le rapport UXP contient un chemin non sûr : $relativePath"
    }
    $relativePath
})
[Array]::Sort($expectedFiles, [System.StringComparer]::Ordinal)

if ($expectedFiles.Count -ne 8 -or @($expectedFiles | Select-Object -Unique).Count -ne 8) {
    throw 'Le rapport UXP doit annoncer exactement huit fichiers uniques.'
}

$hashProperties = @($report.fileHashes.PSObject.Properties)
$hashPaths = @($hashProperties.Name | ForEach-Object { $_.Replace('\', '/') })
[Array]::Sort($hashPaths, [System.StringComparer]::Ordinal)
if (
    $hashPaths.Count -ne 8 -or
    @($hashPaths | Select-Object -Unique).Count -ne 8 -or
    @(Compare-Object -ReferenceObject $expectedFiles -DifferenceObject $hashPaths -CaseSensitive).Count -ne 0
) {
    throw 'Les empreintes du rapport UXP ne correspondent pas exactement aux huit fichiers annoncés.'
}

$packageEntries = @(Get-ChildItem -LiteralPath $package -Recurse -Force)
$reparsePoint = $packageEntries | Where-Object {
    ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
} | Select-Object -First 1
if ($reparsePoint) {
    $relativeReparsePath = [System.IO.Path]::GetRelativePath($package, $reparsePoint.FullName).Replace('\', '/')
    throw "Le paquet Adobe External contient un reparse point interdit : $relativeReparsePath"
}

$actualFileEntries = @($packageEntries | Where-Object { -not $_.PSIsContainer } | ForEach-Object {
    [pscustomobject]@{
        Path = $_.FullName
        RelativePath = [System.IO.Path]::GetRelativePath($package, $_.FullName).Replace('\', '/')
    }
})
$actualFiles = @($actualFileEntries.RelativePath)
[Array]::Sort($actualFiles, [System.StringComparer]::Ordinal)
if ($actualFiles.Count -ne 8 -or @($actualFiles | Select-Object -Unique).Count -ne 8) {
    throw 'Le dossier Adobe External doit contenir exactement huit fichiers uniques.'
}
if (@(Compare-Object -ReferenceObject $expectedFiles -DifferenceObject $actualFiles -CaseSensitive).Count -ne 0) {
    throw 'Les chemins du dossier Adobe External ne correspondent pas au staging vérifié.'
}

$actualHashes = @{}
$sourceHashes = @{}
if ($NormalizeLineEndings) { Import-Module (Join-Path $PSScriptRoot 'UxpTextHash.psm1') -Force }
foreach ($entry in $actualFileEntries) {
    $hashProperty = $report.fileHashes.PSObject.Properties[$entry.RelativePath]
    if (-not $hashProperty -or $hashProperty.Value -isnot [string] -or $hashProperty.Value -cnotmatch '^[a-f0-9]{64}$') {
        throw "Empreinte attendue invalide pour $($entry.RelativePath)."
    }
    $actualHash = (Get-FileHash -LiteralPath $entry.Path -Algorithm SHA256).Hash.ToLowerInvariant()
    $actualHashes[$entry.RelativePath] = $actualHash
    $comparisonHash = if ($NormalizeLineEndings) {
        Get-UxpTextHash -Bytes ([IO.File]::ReadAllBytes($entry.Path)) -Name $entry.RelativePath
    } else { $actualHash }
    $sourceHashes[$entry.RelativePath] = $comparisonHash
    if ($comparisonHash -cne $hashProperty.Value) {
        throw "Empreinte Adobe External différente du staging pour $($entry.RelativePath)."
    }
}

$actualFingerprint = Get-PackageFingerprint -Files $expectedFiles -Hashes $actualHashes
$sourceFingerprint = Get-PackageFingerprint -Files $expectedFiles -Hashes $sourceHashes
$fingerprintProperty = $report.PSObject.Properties['fingerprint']
if (-not $fingerprintProperty -or $fingerprintProperty.Value -isnot [string] -or $fingerprintProperty.Value -cnotmatch '^[a-f0-9]{64}$') {
    throw "L'empreinte logique du rapport UXP est invalide."
}
if ($sourceFingerprint -cne $fingerprintProperty.Value) {
    throw "L'empreinte logique du dossier Adobe External diffère du staging vérifié."
}

[pscustomobject]@{
    path = $package
    files = 8
    fingerprint = $actualFingerprint
    sourceFingerprint = $sourceFingerprint
}

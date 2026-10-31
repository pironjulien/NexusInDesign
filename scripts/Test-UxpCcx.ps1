[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$CcxPath = '',
    [string]$ReportPath = '',
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

$repo = (Resolve-Path -LiteralPath $RepositoryRoot -ErrorAction Stop).Path
if ([string]::IsNullOrWhiteSpace($CcxPath)) {
    $CcxPath = Join-Path $repo 'dist\fr.pironjulien.indesign.mcp_ID.ccx'
}
elseif (-not [System.IO.Path]::IsPathFullyQualified($CcxPath)) {
    $CcxPath = Join-Path $repo $CcxPath
}
if ([string]::IsNullOrWhiteSpace($ReportPath)) {
    $ReportPath = Join-Path $repo 'work\uxp-package-manifest.json'
}
elseif (-not [System.IO.Path]::IsPathFullyQualified($ReportPath)) {
    $ReportPath = Join-Path $repo $ReportPath
}

$ccx = (Resolve-Path -LiteralPath $CcxPath -ErrorAction Stop).Path
$reportFile = (Resolve-Path -LiteralPath $ReportPath -ErrorAction Stop).Path
$report = Get-Content -LiteralPath $reportFile -Raw | ConvertFrom-Json
$expectedFiles = @($report.files)
[Array]::Sort($expectedFiles, [System.StringComparer]::Ordinal)
if ($expectedFiles.Count -ne 8 -or @($expectedFiles | Select-Object -Unique).Count -ne 8) {
    throw "Le rapport UXP doit annoncer exactement huit fichiers uniques."
}

Add-Type -AssemblyName System.IO.Compression
$archive = [System.IO.Compression.ZipFile]::OpenRead($ccx)
$actualHashes = @{}
$sourceHashes = @{}
if ($NormalizeLineEndings) { Import-Module (Join-Path $PSScriptRoot 'UxpTextHash.psm1') -Force }
try {
    $entries = @($archive.Entries | Where-Object { -not [string]::IsNullOrWhiteSpace($_.Name) })
    $actualFiles = @($entries.FullName)
    [Array]::Sort($actualFiles, [System.StringComparer]::Ordinal)
    if ($entries.Count -ne 8 -or @($actualFiles | Select-Object -Unique).Count -ne 8) {
        throw "Le CCX doit contenir exactement huit fichiers uniques."
    }
    if (@(Compare-Object -ReferenceObject $expectedFiles -DifferenceObject $actualFiles).Count -ne 0) {
        throw "Les chemins du CCX ne correspondent pas au staging vérifié."
    }

    foreach ($entry in $entries) {
        $expectedHash = $report.fileHashes.($entry.FullName)
        if ($expectedHash -notmatch '^[a-f0-9]{64}$') {
            throw "Empreinte attendue invalide pour $($entry.FullName)."
        }
        $stream = $entry.Open()
        try {
            $sha = [System.Security.Cryptography.SHA256]::Create()
            try { $actualHash = [Convert]::ToHexString($sha.ComputeHash($stream)).ToLowerInvariant() }
            finally { $sha.Dispose() }
        }
        finally { $stream.Dispose() }
        $actualHashes[$entry.FullName] = $actualHash
        $comparisonHash = $actualHash
        if ($NormalizeLineEndings) {
            $content = [IO.MemoryStream]::new()
            $sourceStream = $entry.Open()
            try { $sourceStream.CopyTo($content); $comparisonHash = Get-UxpTextHash -Bytes $content.ToArray() -Name $entry.FullName }
            finally { $sourceStream.Dispose(); $content.Dispose() }
        }
        $sourceHashes[$entry.FullName] = $comparisonHash
        if ($comparisonHash -cne $expectedHash) {
            throw "Empreinte CCX différente du staging pour $($entry.FullName)."
        }
    }
}
finally {
    $archive.Dispose()
}

$actualFingerprint = Get-PackageFingerprint -Files $expectedFiles -Hashes $actualHashes
$sourceFingerprint = Get-PackageFingerprint -Files $expectedFiles -Hashes $sourceHashes
$fingerprintProperty = $report.PSObject.Properties['fingerprint']
if (-not $fingerprintProperty -or $fingerprintProperty.Value -isnot [string] -or $fingerprintProperty.Value -cnotmatch '^[a-f0-9]{64}$') {
    throw "L'empreinte logique du rapport UXP est invalide."
}
if ($sourceFingerprint -cne $fingerprintProperty.Value) {
    throw "L'empreinte logique du CCX diffère du staging vérifié."
}

[pscustomobject]@{
    path = $ccx
    sha256 = (Get-FileHash -LiteralPath $ccx -Algorithm SHA256).Hash.ToLowerInvariant()
    files = 8
    fingerprint = $actualFingerprint
    sourceFingerprint = $sourceFingerprint
}

[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$stageScript = Join-Path $repo 'scripts\Prepare-UxpPackage.mjs'
$archiveScript = Join-Path $repo 'scripts\New-DeterministicCcx.ps1'
$verificationScript = Join-Path $repo 'scripts\Test-UxpCcx.ps1'
$stageDirectory = Join-Path $repo 'work\uxp-package'
$reportPath = Join-Path $repo 'work\uxp-package-manifest.json'
$distDirectory = Join-Path $repo 'dist'
$ccxPath = Join-Path $distDirectory 'fr.pironjulien.indesign.mcp_deterministic-reference.ccx'

& node $stageScript | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'La préparation du paquet UXP a échoué.' }

New-Item -ItemType Directory -Path $distDirectory -Force | Out-Null
& $archiveScript -SourceDirectory $stageDirectory -DestinationPath $ccxPath | Out-Null

Add-Type -AssemblyName System.IO.Compression
$report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
$archive = [System.IO.Compression.ZipFile]::OpenRead($ccxPath)
try {
    $entries = @($archive.Entries | Where-Object { $_.Name })
    if ($entries.Count -ne 8) { throw "Le CCX contient $($entries.Count) fichiers au lieu de 8." }
    $expectedFiles = @($report.files)
    for ($index = 0; $index -lt $entries.Count; $index++) {
        $entry = $entries[$index]
        if ($entry.FullName -cne $expectedFiles[$index]) {
            throw "Ordre ou fichier CCX invalide à l'index ${index} : $($entry.FullName)"
        }
        if ($entry.LastWriteTime.DateTime -ne [DateTime]::new(1980, 1, 1, 0, 0, 0, [DateTimeKind]::Unspecified)) {
            throw "Horodatage CCX non déterministe : $($entry.FullName)"
        }
        $expectedHash = $report.fileHashes.($entry.FullName)
        if (-not $expectedHash) { throw "Fichier CCX inattendu : $($entry.FullName)" }
        $stream = $entry.Open()
        try {
            $sha = [System.Security.Cryptography.SHA256]::Create()
            $actualHash = [Convert]::ToHexString($sha.ComputeHash($stream)).ToLowerInvariant()
        }
        finally { $stream.Dispose() }
        if ($actualHash -ne $expectedHash) { throw "Empreinte CCX invalide : $($entry.FullName)" }
    }
}
finally { $archive.Dispose() }

$ccxVerification = & $verificationScript -RepositoryRoot $repo -CcxPath $ccxPath -ReportPath $reportPath
if (-not $ccxVerification -or $ccxVerification.files -ne 8) {
    throw "Le CCX déterministe n'a pas passé la vérification indépendante."
}

[pscustomobject]@{
    path = $ccxPath
    sha256 = (Get-FileHash -LiteralPath $ccxPath -Algorithm SHA256).Hash.ToLowerInvariant()
    files = 8
    fingerprint = $ccxVerification.fingerprint
} | ConvertTo-Json -Depth 4

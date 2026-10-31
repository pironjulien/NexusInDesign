[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$ReleaseManifest = '',
    [string]$CcxPath = '',
    [switch]$VerifyOnly,
    [switch]$SkipFullTests
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-PowerShellScript {
    param([Parameter(Mandatory)][string]$Path)
    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) { throw "Script PowerShell invalide : $Path" }
}

function Get-ExactAdobeInstallation {
    param(
        [Parameter(Mandatory)][string]$Repo,
        [Parameter(Mandatory)][string]$PluginId,
        [Parameter(Mandatory)][string]$Version,
        [Parameter(Mandatory)][string]$ExpectedFingerprint
    )

    $pluginsInfoPath = Join-Path $env:APPDATA 'Adobe\UXP\PluginsInfo\v1\ID.json'
    if (-not (Test-Path -LiteralPath $pluginsInfoPath -PathType Leaf)) { return $false }
    try { $pluginsInfo = Get-Content -LiteralPath $pluginsInfoPath -Raw | ConvertFrom-Json }
    catch { return $false }
    $matches = @($pluginsInfo.plugins | Where-Object {
        $_.pluginId -ceq $PluginId -and $_.versionString -ceq $Version -and $_.status -eq 'enabled' -and $_.type -eq 'uxp'
    })
    if ($matches.Count -ne 1) { return $false }
    $externalRoot = Join-Path $env:APPDATA ("Adobe\UXP\Plugins\External\{0}_{1}" -f $PluginId, $Version)
    if (-not (Test-Path -LiteralPath $externalRoot -PathType Container)) { return $false }
    $verificationRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA ('NexusTests\indesign-installed-check-' + [guid]::NewGuid().ToString('N'))))
    try {
        & node (Join-Path $Repo 'scripts\Prepare-UxpPackage.mjs') --work-root $verificationRoot | Out-Null
        if ($LASTEXITCODE) { return $false }
        $verification = & (Join-Path $Repo 'scripts\Test-UxpPackageDirectory.ps1') `
            -PackageRoot $externalRoot `
            -ReportPath (Join-Path $verificationRoot 'uxp-package-manifest.json') -NormalizeLineEndings
        return [bool]($verification -and $verification.files -eq 8 -and $verification.fingerprint -ceq $ExpectedFingerprint)
    }
    catch { return $false }
    finally {
        $allowedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'NexusTests')).TrimEnd('\') + '\'
        if ($verificationRoot.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $verificationRoot)) {
            Remove-Item -LiteralPath $verificationRoot -Recurse -Force
        }
    }
}

function Find-Upia {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe'),
        $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe' })
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }
    if ($candidates.Count -eq 0) { throw 'Adobe UPIA est introuvable ; Creative Cloud Desktop doit être installé.' }
    return (Resolve-Path -LiteralPath $candidates[0]).Path
}

if ($env:OS -ne 'Windows_NT') { throw 'Cette installation cible uniquement Windows 11.' }
$repo = (Resolve-Path -LiteralPath $RepositoryRoot -ErrorAction Stop).Path
if (-not (Test-Path -LiteralPath (Join-Path $repo '.git') -PathType Container)) {
    throw "L'installation doit être lancée depuis un clone Git complet du dépôt."
}
foreach ($script in @(
    'Get-VerifiedCcx.ps1',
    'Sync-CodexPlugin.ps1',
    'Test-Installation.ps1',
    'Test-UxpPackageDirectory.ps1'
)) {
    Assert-PowerShellScript -Path (Join-Path $repo "scripts\$script")
}

$node = Get-Command node -CommandType Application -All -ErrorAction Stop |
    Where-Object { (& $_.Source --version).Trim().StartsWith('v24.') } | Select-Object -First 1
if (-not $node) { throw 'Node.js 24 est requis.' }
$env:PATH = (Split-Path -Parent $node.Source) + [IO.Path]::PathSeparator + $env:PATH
$nodeVersion = (& $node.Source --version).Trim()
if (-not $nodeVersion.StartsWith('v24.')) { throw "Node.js 24 est requis ; version détectée : $nodeVersion" }
if ([string]::IsNullOrWhiteSpace($env:OneDrive) -or -not (Test-Path -LiteralPath $env:OneDrive -PathType Container)) {
    throw "OneDrive doit être configuré avant l'installation."
}
if (-not (Test-Path -LiteralPath (Join-Path $env:OneDrive 'Documents') -PathType Container)) {
    throw 'Le dossier Documents synchronisé par OneDrive est introuvable.'
}

$verifiedCcx = & (Join-Path $repo 'scripts\Get-VerifiedCcx.ps1') `
    -RepositoryRoot $repo `
    -ReleaseManifest $ReleaseManifest `
    -CcxPath $CcxPath
Write-Host "CCX vérifié : $($verifiedCcx.version), SHA-256 $($verifiedCcx.sha256)"
if ($VerifyOnly) {
    Write-Host 'Vérification de release terminée : aucun composant installé.'
    return
}

Push-Location $repo
try {
    if ($PSCmdlet.ShouldProcess($repo, 'Installer le runtime et les dépendances hors OneDrive')) {
        & pwsh -NoProfile -File (Join-Path $repo 'install.ps1')
        if ($LASTEXITCODE -ne 0) { throw "L'installation du runtime local a échoué." }
    }

    $adobeExact = Get-ExactAdobeInstallation `
        -Repo $repo `
        -PluginId $verifiedCcx.pluginId `
        -Version $verifiedCcx.version `
        -ExpectedFingerprint $verifiedCcx.fingerprint
    if (-not $adobeExact -and $PSCmdlet.ShouldProcess($verifiedCcx.path, 'Installer le CCX avec Adobe UPIA')) {
        $upia = Find-Upia
        & $upia /install $verifiedCcx.path
        if ($LASTEXITCODE -ne 0) { throw "Adobe UPIA a refusé le CCX avec le code $LASTEXITCODE." }
        $adobeExact = Get-ExactAdobeInstallation `
            -Repo $repo `
            -PluginId $verifiedCcx.pluginId `
            -Version $verifiedCcx.version `
            -ExpectedFingerprint $verifiedCcx.fingerprint
        if (-not $adobeExact) { throw "L'installation Adobe ne correspond pas exactement au CCX vérifié." }
    }
    elseif ($adobeExact) {
        Write-Host 'Adobe UXP : installation persistante déjà exacte, aucune réinstallation.'
    }

    if ($PSCmdlet.ShouldProcess('nexus-indesign', 'Créer le plugin Codex machine et sa configuration MCP privée')) {
        & pwsh -NoProfile -File (Join-Path $repo 'scripts\Sync-CodexPlugin.ps1') -RepositoryRoot $repo -Install
        if ($LASTEXITCODE -ne 0) { throw 'La synchronisation du plugin Codex a échoué.' }
    }

    if (-not $SkipFullTests -and $PSCmdlet.ShouldProcess($repo, "Exécuter la vérification complète de l'installation")) {
        & (Join-Path $repo 'scripts\Test-Installation.ps1') -RepositoryRoot $repo -CcxPath $verifiedCcx.path
        if ($LASTEXITCODE -ne 0) { throw "La vérification complète de l'installation a échoué." }
    }
}
finally {
    Pop-Location
}

if ($WhatIfPreference) {
    Write-Host "Simulation terminée : le CCX a été vérifié, aucune installation n'a été modifiée."
    return
}
Write-Host 'Installation de la station terminée et vérifiée.'
Write-Host "Fermer puis relancer InDesign et ouvrir une nouvelle tâche Codex pour l'appairage local si nécessaire."

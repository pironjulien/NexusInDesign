[CmdletBinding()]
param(
    [string]$Name = 'nexus-indesign',
    [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$CcxPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$sourceRepo = (Resolve-Path -LiteralPath $RepositoryRoot -ErrorAction Stop).Path
$verifiedArtifact = & (Join-Path $sourceRepo 'scripts\Get-VerifiedCcx.ps1') -RepositoryRoot $sourceRepo -CcxPath $CcxPath
$validationRoot = Join-Path $env:LOCALAPPDATA 'NexusTests\indesign-installation'
$repo = [IO.Path]::GetFullPath((Join-Path $validationRoot ([guid]::NewGuid().ToString('N'))))
if (-not $repo.StartsWith([IO.Path]::GetFullPath($validationRoot) + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Copie de vérification hors du dossier local autorisé.'
}
New-Item -ItemType Directory -Force -Path $repo | Out-Null
robocopy $sourceRepo $repo /E /XD node_modules work .git /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw 'Copie locale de vérification impossible.' }
$runtimeModules = Join-Path $env:USERPROFILE '.nexus\indesign-mcp-secure\node_modules'
if (-not (Test-Path -LiteralPath $runtimeModules)) { throw 'Installer le runtime avec install.ps1 avant la vérification.' }
New-Item -ItemType Junction -Path (Join-Path $repo 'node_modules') -Target $runtimeModules | Out-Null
Push-Location $repo
try {
    $nodeVersion = (& node --version).Trim()
    if (-not $nodeVersion.StartsWith('v24.')) {
        throw "Node.js 24 est requis ; version détectée : $nodeVersion"
    }

    $stageScript = Join-Path $repo 'scripts\Prepare-UxpPackage.mjs'
    $stageDirectory = Join-Path $repo 'work\uxp-package'
    $packageReportPath = Join-Path $repo 'work\uxp-package-manifest.json'
    & node $stageScript | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'La régénération du staging UXP depuis les sources du plugin a échoué.' }
    $stagingVerification = & '.\scripts\Test-UxpPackageDirectory.ps1' `
        -PackageRoot $stageDirectory `
        -ReportPath $packageReportPath
    if (-not $stagingVerification -or $stagingVerification.files -ne 8) {
        throw "Le staging UXP régénéré depuis les sources du plugin n'a pas été validé."
    }

    & node --check 'src\index.js'
    if ($LASTEXITCODE -ne 0) { throw "Le point d’entrée Node contient une erreur de syntaxe." }
    & node --check 'plugin\index.js'
    if ($LASTEXITCODE -ne 0) { throw 'Le plugin UXP contient une erreur de syntaxe.' }
    & node --check 'plugin\commands.js'
    if ($LASTEXITCODE -ne 0) { throw 'Le catalogue UXP contient une erreur de syntaxe.' }
    & node --check 'src\bridge\InDesignSilentBridge.js'
    if ($LASTEXITCODE -ne 0) { throw 'Le canal silencieux contient une erreur de syntaxe.' }
    & node --check 'src\bridge\InDesignBridge.js'
    if ($LASTEXITCODE -ne 0) { throw 'Le pont plugin contient une erreur de syntaxe.' }
    & node --check 'src\bridge\WindowsNamedMutexGuard.js'
    if ($LASTEXITCODE -ne 0) { throw 'Le gardien du verrou InDesign contient une erreur de syntaxe.' }
    & node --check 'scripts\Initialize-SecureStorage.mjs'
    if ($LASTEXITCODE -ne 0) { throw "L’initialiseur du stockage privé contient une erreur de syntaxe." }
    foreach ($powerShellScript in @(
        'scripts\Protect-WindowsPrivatePath.ps1',
        'scripts\Invoke-InDesignScript.ps1',
        'scripts\Hold-InDesignOperationMutex.ps1',
        'scripts\Get-VerifiedCcx.ps1',
        'scripts\Install-Workstation.ps1',
        'scripts\Publish-GitHubRelease.ps1',
        'scripts\Sync-CodexPlugin.ps1'
    )) {
        $tokens = $null
        $parseErrors = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile(
            (Join-Path $repo $powerShellScript),
            [ref]$tokens,
            [ref]$parseErrors
        )
        if ($parseErrors.Count -gt 0) { throw "Le script PowerShell $powerShellScript contient une erreur de syntaxe." }
    }

    & npm test
    if ($LASTEXITCODE -ne 0) { throw "La suite de tests a échoué." }
    & npm audit --audit-level=high
    if ($LASTEXITCODE -ne 0) { throw "L’audit npm a détecté une vulnérabilité de niveau élevé." }

    $ccxVerification = & '.\scripts\Test-UxpCcx.ps1' -RepositoryRoot $repo -ReportPath $packageReportPath -CcxPath $verifiedArtifact.path -NormalizeLineEndings
    if (-not $ccxVerification -or $ccxVerification.files -ne 8) { throw "Le CCX officiel Adobe n’a pas été validé." }
    if ($ccxVerification.sourceFingerprint -cne $stagingVerification.fingerprint) {
        throw "L'empreinte logique du CCX officiel ne correspond pas au staging régénéré."
    }

    $manifest = Get-Content -LiteralPath 'plugin\manifest.json' -Raw | ConvertFrom-Json
    if ($manifest.requiredPermissions.network.domains -ne 'all') {
        throw "Le plugin UXP doit déclarer le repli réseau UXP compatible avec InDesign 2026."
    }
    if ($manifest.requiredPermissions.clipboard -ne 'read') { throw "L’appairage UXP doit limiter le presse-papiers à la lecture." }
    if ($manifest.requiredPermissions.localFileSystem -ne 'fullAccess') { throw "L’accès fichiers UXP complet n’est pas actif." }
    if ($manifest.requiredPermissions.allowCodeGenerationFromStrings -ne $true) { throw "L’exécution UXP dynamique n’est pas active." }
    if ([version]$manifest.host.minVersion -lt [version]'19.0') { throw 'InDesign 19.0 minimum est requis par le contrat de compatibilité du plugin.' }

    $codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
    $codexConfig = Join-Path $codexHome 'config.toml'
    $configText = if (Test-Path -LiteralPath $codexConfig -PathType Leaf) {
        Get-Content -LiteralPath $codexConfig -Raw
    }
    else { '' }
    $serverPattern = '(?ms)^\[mcp_servers\.' + [regex]::Escape($Name) + '\]\s*$.*?(?=^\[|\z)'
    $serverBlock = [regex]::Match($configText, $serverPattern).Value
    $serverEnvPattern = '(?ms)^\[mcp_servers\.' + [regex]::Escape($Name) + '\.env\]\s*$.*?(?=^\[|\z)'
    $serverEnvBlock = [regex]::Match($configText, $serverEnvPattern).Value
    $globalConfigured = -not [string]::IsNullOrWhiteSpace($serverBlock)

    $pluginPattern = '(?ms)^\[plugins\."' + [regex]::Escape($Name) + '@[^"\r\n]+"\]\s*$\s*(?:(?!^\[).)*?^\s*enabled\s*=\s*true\s*$'
    $pluginEnabled = $configText -match $pluginPattern

    if ($globalConfigured -and $pluginEnabled) {
        throw "Le MCP $Name est déclaré à la fois par un plugin Codex et dans config.toml ; retirez le doublon."
    }
    if (-not $globalConfigured -and -not $pluginEnabled) {
        throw "Aucun plugin Codex actif ni serveur MCP global ne fournit $Name."
    }

    if (-not $env:OneDrive) { throw 'OneDrive est requis pour vérifier le stockage privé.' }
    $expectedDeniedRoot = [System.IO.Path]::GetFullPath((Join-Path $env:OneDrive 'Documents\NexusSecure'))

    if ($globalConfigured) {
        $codex = Get-Command codex -ErrorAction Stop
        $mcpStatus = (& $codex.Source mcp get $Name 2>&1) -join "`n"
        if ($LASTEXITCODE -ne 0) { throw "Le MCP $Name n’est pas enregistré dans Codex." }
        if ($mcpStatus -notmatch 'INDESIGN_MCP_COMMAND_TIMEOUT_MS') { throw "Le délai interne InDesign n’est pas configuré." }
        if ($mcpStatus -notmatch 'INDESIGN_MCP_ALLOWED_PARENT_PATHS') { throw "Le CLI Codex signé n’a pas de chemin exact autorisé." }
        if ($mcpStatus -notmatch 'INDESIGN_MCP_DENIED_ROOTS') { throw "Le coffre NexusSecure n’est pas explicitement interdit aux outils structurés." }
        if ($mcpStatus -notmatch 'startup_timeout_sec:\s+30') { throw "Le délai de démarrage Codex n’est pas réglé à 30 secondes." }
        if ($mcpStatus -notmatch 'tool_timeout_sec:\s+600') { throw "Le délai d’outil Codex n’est pas réglé à 600 secondes." }
        if ($serverBlock -notmatch '(?m)^required\s*=\s*true\s*$') {
            throw "Le serveur MCP global n’est pas obligatoire dans config.toml."
        }
        $deniedMatch = [regex]::Match($serverEnvBlock, '(?m)^\s*INDESIGN_MCP_DENIED_ROOTS\s*=\s*"(?<value>(?:\\.|[^"])*)"\s*$')
        if (-not $deniedMatch.Success) { throw 'La valeur DENIED_ROOTS du MCP global est introuvable.' }
        $configuredDeniedRoot = ('"' + $deniedMatch.Groups['value'].Value + '"') | ConvertFrom-Json
        if ([System.IO.Path]::GetFullPath($configuredDeniedRoot) -ine $expectedDeniedRoot) {
            throw "Le MCP global n’interdit pas exactement tout le coffre NexusSecure."
        }
        $installationMode = 'serveur MCP global'
    }
    else {
        # Le Desktop peut n'installer aucune commande codex dans le PATH.
        # Le synchroniseur vérifie le moteur signé, la configuration et la copie en cache.
        $marketplace = Get-Content -LiteralPath (Join-Path $env:USERPROFILE '.agents\plugins\marketplace.json') -Raw | ConvertFrom-Json
        $pluginEntry = @($marketplace.plugins | Where-Object { $_.name -ceq $Name })
        if ($pluginEntry.Count -ne 1) { throw 'Entrée du catalogue personnel absente ou dupliquée.' }
        $pluginRoot = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE $pluginEntry[0].source.path))
        & pwsh -NoProfile -File (Join-Path $sourceRepo 'scripts\Sync-CodexPlugin.ps1') -RepositoryRoot $sourceRepo -PluginRoot $pluginRoot -Install -CheckOnly
        if ($LASTEXITCODE) { throw 'Plugin Codex ou cache local obsolète.' }
        $pluginConfigPath = Join-Path $pluginRoot '.mcp.json'
        $pluginManifestPath = Join-Path $pluginRoot '.codex-plugin\plugin.json'
        if (-not (Test-Path -LiteralPath $pluginConfigPath -PathType Leaf)) { throw 'Le plugin Codex actif ne contient pas .mcp.json.' }
        if (-not (Test-Path -LiteralPath $pluginManifestPath -PathType Leaf)) { throw 'Le manifeste du plugin Codex actif est introuvable.' }
        $pluginConfig = Get-Content -LiteralPath $pluginConfigPath -Raw | ConvertFrom-Json
        $pluginServer = $pluginConfig.mcpServers.PSObject.Properties[$Name].Value
        if (-not $pluginServer) { throw "Le plugin Codex actif ne déclare pas le MCP $Name." }
        if ([System.IO.Path]::GetFullPath($pluginServer.env.INDESIGN_MCP_DENIED_ROOTS) -ine $expectedDeniedRoot) {
            throw "Le plugin Codex n’interdit pas exactement tout le coffre NexusSecure."
        }
        $pluginManifest = Get-Content -LiteralPath $pluginManifestPath -Raw | ConvertFrom-Json
        if ($pluginManifest.mcpServers -ne './.mcp.json') { throw 'Le manifeste installé ne relie pas sa configuration MCP.' }
        $installationMode = 'plugin Codex'
    }

    $secureRoot = Join-Path $env:OneDrive 'Documents\NexusSecure\InDesignMCP'
    & '.\scripts\Protect-WindowsPrivatePath.ps1' -TargetPath $secureRoot -Kind Directory -CheckOnly | Out-Null
    & '.\scripts\Protect-WindowsPrivatePath.ps1' -TargetPath (Join-Path $secureRoot 'bridge-token') -Kind File -CheckOnly | Out-Null

    $expectedVersion = (Get-Content -LiteralPath 'plugin\manifest.json' -Raw | ConvertFrom-Json).version
    $pluginsInfoPath = Join-Path $env:APPDATA 'Adobe\UXP\PluginsInfo\v1\ID.json'
    if (-not (Test-Path -LiteralPath $pluginsInfoPath -PathType Leaf)) { throw 'Le registre Adobe UXP InDesign est introuvable.' }
    $pluginsInfo = Get-Content -LiteralPath $pluginsInfoPath -Raw | ConvertFrom-Json
    $adobePlugins = @($pluginsInfo.plugins | Where-Object { $_.pluginId -eq 'fr.pironjulien.indesign.mcp' -and $_.versionString -eq $expectedVersion })
    if ($adobePlugins.Count -ne 1) { throw "L’installation Adobe persistante $expectedVersion est absente ou dupliquée." }
    if ($adobePlugins[0].status -ne 'enabled' -or $adobePlugins[0].type -ne 'uxp') { throw "L’extension Adobe persistante n’est pas activée comme plugin UXP." }
    $externalPluginRoot = Join-Path $env:APPDATA "Adobe\UXP\Plugins\External\fr.pironjulien.indesign.mcp_$expectedVersion"
    $externalManifestPath = Join-Path $externalPluginRoot 'manifest.json'
    if (-not (Test-Path -LiteralPath $externalManifestPath -PathType Leaf)) { throw "Les fichiers de l’extension Adobe persistante sont introuvables." }
    $externalManifest = Get-Content -LiteralPath $externalManifestPath -Raw | ConvertFrom-Json
    if ($externalManifest.id -ne 'fr.pironjulien.indesign.mcp' -or $externalManifest.version -ne $expectedVersion) {
        throw 'Le manifeste Adobe persistant ne correspond pas à la version source.'
    }
    $externalPackageVerification = & '.\scripts\Test-UxpPackageDirectory.ps1' `
        -PackageRoot $externalPluginRoot `
        -ReportPath $packageReportPath -NormalizeLineEndings
    if (-not $externalPackageVerification -or $externalPackageVerification.files -ne 8) {
        throw "Le contenu complet de l’installation Adobe persistante n’a pas été validé."
    }
    if ($externalPackageVerification.sourceFingerprint -cne $stagingVerification.fingerprint -or $externalPackageVerification.fingerprint -cne $verifiedArtifact.fingerprint) {
        throw "L'empreinte logique de l'installation Adobe ne correspond pas au staging régénéré."
    }

    Write-Host "Vérification locale réussie : $nodeVersion, $installationMode, Adobe UXP $expectedVersion, CCX $($ccxVerification.sha256), tests et audit valides."
    Write-Host "DACL vérifiée : stockage NexusSecure limité à l’utilisateur courant + SYSTEM ; dépôt maintenable par Codex."
    Write-Host "Lancer npm run test:live:silent pour la validation InDesign réelle ; les documents utilisateur ouverts sont empreintés, préservés et revérifiés."
}
finally {
    Pop-Location
    if ($repo.StartsWith([IO.Path]::GetFullPath($validationRoot) + '\', [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $repo -Recurse -Force
    }
}

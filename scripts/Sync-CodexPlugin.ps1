[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$PluginRoot = (Join-Path $env:USERPROFILE 'plugins\nexus-indesign'),
    [string]$RuntimeRoot = (Join-Path $env:USERPROFILE '.nexus\indesign-mcp-secure'),
    [switch]$CheckOnly,
    [switch]$Install
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Resolve-FullPath {
    param([Parameter(Mandatory)][string]$Path)
    return [System.IO.Path]::GetFullPath($Path)
}

function Assert-InsideUserProfile {
    param([Parameter(Mandatory)][string]$Path)
    $profile = (Resolve-FullPath -Path $env:USERPROFILE).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    $candidate = Resolve-FullPath -Path $Path
    $prefix = $profile + [System.IO.Path]::DirectorySeparatorChar
    if (-not $candidate.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Le plugin Codex personnel doit rester sous le profil utilisateur.'
    }
    return $candidate
}

function Get-SignedCodexExecutables {
    $candidates = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($command in @(Get-Command codex -All -ErrorAction SilentlyContinue)) {
        if ([string]::IsNullOrWhiteSpace($command.Source)) { continue }
        if ([System.IO.Path]::GetFileName($command.Source) -ieq 'codex.exe') {
            [void]$candidates.Add($command.Source)
        }

        $commandDirectory = Split-Path -Parent $command.Source
        $packageRoot = Join-Path $commandDirectory 'node_modules\@openai\codex'
        if (Test-Path -LiteralPath $packageRoot -PathType Container) {
            foreach ($candidate in @(Get-ChildItem -LiteralPath $packageRoot -Recurse -Filter 'codex.exe' -File -ErrorAction Stop)) {
                [void]$candidates.Add($candidate.FullName)
            }
        }
    }

    # Codex Desktop installe son moteur signé sous LocalAppData, sans ajouter de CLI au PATH.
    foreach ($process in @(Get-Process -Name codex -ErrorAction SilentlyContinue)) {
        if ($process.Path) { [void]$candidates.Add($process.Path) }
    }
    $desktopBin = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
    if (Test-Path -LiteralPath $desktopBin -PathType Container) {
        foreach ($candidate in @(Get-ChildItem -LiteralPath $desktopBin -Directory | ForEach-Object {
            Get-Item -LiteralPath (Join-Path $_.FullName 'codex.exe') -ErrorAction SilentlyContinue
        })) { [void]$candidates.Add($candidate.FullName) }
    }

    $signed = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($candidate in $candidates) {
        $resolved = (Resolve-Path -LiteralPath $candidate -ErrorAction Stop).Path
        $signature = Get-AuthenticodeSignature -LiteralPath $resolved
        if (
            $signature.Status -eq [System.Management.Automation.SignatureStatus]::Valid -and
            $signature.SignerCertificate -and
            $signature.SignerCertificate.Subject -like '*OpenAI OpCo, LLC*'
        ) {
            [void]$signed.Add($resolved)
        }
    }
    if (-not $signed.Count) { throw 'Aucun moteur Codex signé OpenAI valide trouvé (Desktop ou CLI).' }
    return @($signed | Sort-Object)
}

$repo = (Resolve-Path -LiteralPath $RepositoryRoot -ErrorAction Stop).Path
$source = Join-Path $repo 'codex-plugin'
$manifest = Join-Path $source '.codex-plugin\plugin.json'
$privateAclScript = Join-Path $repo 'scripts\Protect-WindowsPrivatePath.ps1'
$storageInitializer = Join-Path $repo 'scripts\Initialize-SecureStorage.mjs'
if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) {
    throw "Manifeste du plugin Codex introuvable : $manifest"
}
$sourceManifest = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
foreach ($field in 'composerIcon', 'logo') {
    $relative = $sourceManifest.interface.$field
    if ($relative -isnot [string] -or $relative -notmatch '^\./assets/[A-Za-z0-9_.-]+\.png$' -or
        -not (Test-Path -LiteralPath (Join-Path $source $relative) -PathType Leaf)) {
        throw "Icône du plugin Codex absente ou invalide : interface.$field"
    }
}
foreach ($requiredFile in @($privateAclScript, $storageInitializer)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Fichier d'installation introuvable : $requiredFile"
    }
}

# Premier node 24 du PATH : un poste peut garder plusieurs Node.js installés.
$node = Get-Command node -CommandType Application -All -ErrorAction Stop |
    Where-Object { (& $_.Source --version).Trim().StartsWith('v24.') } | Select-Object -First 1
if (-not $node) {
    throw 'Node.js 24 est requis.'
}

if ([string]::IsNullOrWhiteSpace($env:OneDrive)) {
    throw 'OneDrive est requis pour générer la configuration privée du plugin.'
}
$oneDriveDocuments = Resolve-FullPath -Path (Join-Path $env:OneDrive 'Documents')
$secureRoot = Resolve-FullPath -Path (Join-Path $oneDriveDocuments 'NexusSecure\InDesignMCP')
$tokenFile = Join-Path $secureRoot 'bridge-token'
$runtime = Assert-InsideUserProfile -Path $RuntimeRoot
$oneDrivePrefix = (Resolve-FullPath -Path $env:OneDrive).TrimEnd('\') + '\'
if ($runtime.StartsWith($oneDrivePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Le runtime InDesign et ses états doivent rester hors OneDrive.'
}
foreach ($runtimeFile in @('src\index.js', 'node_modules\@modelcontextprotocol\sdk\package.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $runtime $runtimeFile) -PathType Leaf)) {
        throw "Runtime InDesign incomplet : lancer install.ps1 avant la synchronisation du plugin."
    }
}
# Même stockage que le plugin Claude : le courtier authentifié partage ainsi
# la session UXP, au lieu de créer deux propriétaires sur le même port.
$privateRoot = Resolve-FullPath -Path (Join-Path $runtime 'private')
$backupRoot = Join-Path $privateRoot 'backups'
$auditFile = Join-Path $privateRoot 'audit\events.jsonl'
$auditDirectory = Split-Path -Parent $auditFile

$target = Assert-InsideUserProfile -Path $PluginRoot
$parent = Split-Path -Parent $target
$staging = Join-Path $parent ('.nexus-indesign-next-' + [guid]::NewGuid().ToString('N'))
$rollback = Join-Path $parent ('.nexus-indesign-previous-' + [guid]::NewGuid().ToString('N'))
[void](Assert-InsideUserProfile -Path $staging)
[void](Assert-InsideUserProfile -Path $rollback)

$allowedParentSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
[void]$allowedParentSet.Add('C:\Program Files\WindowsApps')
$signedCodex = @(Get-SignedCodexExecutables)
foreach ($codexExecutable in $signedCodex) { [void]$allowedParentSet.Add($codexExecutable) }
$allowedParents = @($allowedParentSet | Sort-Object)
$pathSeparator = [System.IO.Path]::PathSeparator
# Du runtime, seuls les dossiers d'essai (e2e, qualification) sont des racines documents :
# src, node_modules et private ne doivent jamais être inscriptibles par un export.
$runtimeDocumentRoots = @('e2e', 'qualification') | ForEach-Object {
    $runtimeDocumentRoot = Join-Path $runtime $_
    New-Item -ItemType Directory -Path $runtimeDocumentRoot -Force | Out-Null
    $runtimeDocumentRoot
}
$documentRoots = @(@($repo, $oneDriveDocuments) + $runtimeDocumentRoots + @('C:\Dev', 'D:\Dev')) |
    Where-Object { Test-Path -LiteralPath $_ -PathType Container } | Sort-Object -Unique
$server = [ordered]@{
    command = (Resolve-FullPath -Path $node.Source)
    args = @((Join-Path $runtime 'src\index.js'))
    cwd = $runtime
    env = [ordered]@{
        INDESIGN_MCP_TOKEN_FILE = $tokenFile
        INDESIGN_MCP_PRIVATE_ROOT = $privateRoot
        INDESIGN_MCP_BACKUP_ROOT = $backupRoot
        INDESIGN_MCP_READ_ROOTS = [string]::Join($pathSeparator, $documentRoots)
        INDESIGN_MCP_WRITE_ROOTS = [string]::Join($pathSeparator, $documentRoots)
        INDESIGN_MCP_DENIED_ROOTS = (Resolve-FullPath -Path (Join-Path $oneDriveDocuments 'NexusSecure'))
        INDESIGN_MCP_AUDIT_FILE = $auditFile
        INDESIGN_MCP_ALLOWED_PARENT_PATHS = [string]::Join($pathSeparator, $allowedParents)
        INDESIGN_MCP_COMMAND_TIMEOUT_MS = '120000'
    }
}
$mcpText = ([ordered]@{ mcpServers = [ordered]@{ 'nexus-indesign' = $server } } | ConvertTo-Json -Depth 8) + "`n"
$fingerprintInput = @($mcpText) + @(Get-ChildItem -LiteralPath $source -Recurse -Force -File | Sort-Object FullName | ForEach-Object {
    $_.FullName.Substring($source.Length) + ':' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
})
# Le cache doit aussi changer si le serveur ou ses lanceurs changent : sinon
# un plugin inchangé garde un processus chargé avec l'ancien code du runtime.
foreach ($runtimeDirectory in 'src', 'plugin', 'scripts') {
    $fingerprintInput += @(Get-ChildItem -LiteralPath (Join-Path $repo $runtimeDirectory) -Recurse -File | Sort-Object FullName | ForEach-Object {
        $_.FullName.Substring($repo.Length) + ':' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    })
}
$fingerprintInput += (Get-FileHash -LiteralPath (Join-Path $repo 'package-lock.json') -Algorithm SHA256).Hash
$fingerprint = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
    [Text.Encoding]::UTF8.GetBytes(($fingerprintInput -join "`n")))).ToLowerInvariant().Substring(0, 12)
$installedVersion = $sourceManifest.version.Split('+')[0] + '+local.' + $fingerprint
$marketPath = Join-Path $env:USERPROFILE '.agents\plugins\marketplace.json'
$market = if (Test-Path -LiteralPath $marketPath) { Get-Content -LiteralPath $marketPath -Raw | ConvertFrom-Json -AsHashtable } else {
    [ordered]@{ name = 'personal'; plugins = @() }
}
$marketName = $market.name
if ([string]::IsNullOrWhiteSpace($marketName)) { throw 'Le catalogue local Codex a un nom invalide.' }
$codexConfigPath = Join-Path $env:USERPROFILE '.codex\config.toml'
$pluginTablePattern = '(?ms)^\s*\[plugins\."' + [regex]::Escape("nexus-indesign@$marketName") + '"\]\s*\r?\n(.*?)(?=^\s*\[|\z)'
$configBeforeInstall = if (Test-Path -LiteralPath $codexConfigPath) { [IO.File]::ReadAllText($codexConfigPath) } else { '' }
$keepDisabled = [regex]::Match($configBeforeInstall, $pluginTablePattern).Groups[1].Value -match '(?m)^\s*enabled\s*=\s*false\b'

if ($CheckOnly) {
    $installedManifestPath = Join-Path $target '.codex-plugin\plugin.json'
    $installedMcpPath = Join-Path $target '.mcp.json'
    if (-not (Test-Path -LiteralPath $installedManifestPath) -or -not (Test-Path -LiteralPath $installedMcpPath)) {
        throw 'Plugin personnel InDesign absent : synchronisation nécessaire.'
    }
    $installedManifest = Get-Content -LiteralPath $installedManifestPath -Raw | ConvertFrom-Json
    if ($installedManifest.version -cne $installedVersion -or [IO.File]::ReadAllText($installedMcpPath) -cne $mcpText) {
        throw 'Plugin personnel InDesign obsolète : synchronisation nécessaire.'
    }
    foreach ($file in @(Get-ChildItem -LiteralPath $source -Recurse -Force -File | Where-Object { $_.FullName -cne $manifest })) {
        $copy = Join-Path $target $file.FullName.Substring($source.Length + 1)
        if (-not (Test-Path -LiteralPath $copy) -or (Get-FileHash -LiteralPath $copy).Hash -cne (Get-FileHash -LiteralPath $file.FullName).Hash) {
            throw 'Ressource du plugin personnel InDesign absente ou modifiée.'
        }
    }
    if (-not (Test-Path -LiteralPath $tokenFile -PathType Leaf)) { throw 'Secret InDesign absent de NexusSecure.' }
    if ($Install) {
        $cache = Join-Path $env:USERPROFILE ".codex\plugins\cache\$marketName\nexus-indesign\$installedVersion\.mcp.json"
        if (-not (Test-Path -LiteralPath $cache) -or [IO.File]::ReadAllText($cache) -cne $mcpText) {
            throw 'Copie installée du plugin InDesign obsolète : réinstallation nécessaire.'
        }
    }
    Write-Host 'Plugin Codex InDesign : configuration locale et runtime à jour.'
    return
}

if (-not $PSCmdlet.ShouldProcess($target, 'Synchroniser le plugin Codex Nexus InDesign')) {
    Write-Host 'Simulation terminée : aucun fichier modifié.'
    return
}

# Une nouvelle machine ne possède pas encore le stockage privé. Il est créé et
# verrouillé avant le premier octet du secret. Le jeton OneDrive est protégé
# séparément, sans parcourir ses points de réanalyse Files On-Demand.
New-Item -ItemType Directory -Path $parent -Force | Out-Null
New-Item -ItemType Directory -Path $secureRoot -Force | Out-Null
& $node.Source $storageInitializer $secureRoot $tokenFile $privateRoot $backupRoot $auditFile | Out-Null
if ($LASTEXITCODE -ne 0) { throw "L'initialisation du stockage privé a échoué." }
& $privateAclScript -TargetPath $privateRoot -Kind Directory -Recursive | Out-Null
& $privateAclScript -TargetPath $backupRoot -Kind Directory -Recursive | Out-Null
& $privateAclScript -TargetPath $auditDirectory -Kind Directory -Recursive | Out-Null
& $privateAclScript -TargetPath $auditFile -Kind File | Out-Null

try {
    New-Item -ItemType Directory -Path $staging -ErrorAction Stop | Out-Null
    foreach ($entry in Get-ChildItem -LiteralPath $source -Force) {
        Copy-Item -LiteralPath $entry.FullName -Destination $staging -Recurse -Force
    }

    [IO.File]::WriteAllText((Join-Path $staging '.mcp.json'), $mcpText, [Text.UTF8Encoding]::new($false))

    # La source Git reste un plugin skill valide sans faux chemin MCP. La
    # configuration machine, qui contient des chemins privés locaux, n’est
    # déclarée que dans le staging réellement installé.
    $stagedManifestPath = Join-Path $staging '.codex-plugin\plugin.json'
    $stagedManifest = Get-Content -LiteralPath $stagedManifestPath -Raw | ConvertFrom-Json
    $stagedManifest | Add-Member -NotePropertyName 'mcpServers' -NotePropertyValue './.mcp.json' -Force
    $stagedManifest.version = $installedVersion
    $stagedManifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $stagedManifestPath -Encoding utf8NoBOM

    if (Test-Path -LiteralPath $target) {
        Move-Item -LiteralPath $target -Destination $rollback
    }
    Move-Item -LiteralPath $staging -Destination $target
    if (Test-Path -LiteralPath $rollback) {
        Remove-Item -LiteralPath $rollback -Recurse -Force
    }
}
catch {
    $failure = $_
    if (Test-Path -LiteralPath $staging) {
        Remove-Item -LiteralPath $staging -Recurse -Force
    }
    if ((Test-Path -LiteralPath $rollback) -and -not (Test-Path -LiteralPath $target)) {
        Move-Item -LiteralPath $rollback -Destination $target
    }
    throw $failure
}

Write-Host "Source du plugin Codex synchronisée : $target"
Write-Host 'Les Documents OneDrive sont autorisés, mais NexusSecure reste explicitement interdit aux outils structurés.'
if ($Install) {
    # Les sources d'un catalogue personnel sont résolues depuis le profil,
    # comme les autres plugins locaux de Codex ; un chemin absolu est ignoré.
    $marketSource = './' + [IO.Path]::GetRelativePath($env:USERPROFILE, $target).Replace('\', '/')
    # 'indesign-secure' : ancien nom du plugin (avant 24/10/2026). Son entrée du catalogue n'est retirée
    # qu'après un `codex plugin remove` réussi : sinon Codex garderait un plugin installé introuvable.
    $legacyCache = Join-Path $env:USERPROFILE ".codex\plugins\cache\$marketName\indesign-secure"
    $legacyRemoved = -not (Test-Path -LiteralPath $legacyCache)
    function Write-CodexMarketplace {
        param([string[]]$Without)
        $market.plugins = @($market.plugins | Where-Object { $_.name -notin $Without }) + @(
            [ordered]@{ name = 'nexus-indesign'; source = [ordered]@{ source = 'local'; path = $marketSource };
                policy = [ordered]@{ installation = 'AVAILABLE'; authentication = 'ON_INSTALL' }; category = 'Productivity' }
        )
        $marketText = ($market | ConvertTo-Json -Depth 10) + "`n"
        if (-not (Test-Path -LiteralPath $marketPath) -or [IO.File]::ReadAllText($marketPath) -cne $marketText) {
            $marketBackups = Join-Path $env:USERPROFILE '.codex\backups'
            New-Item -ItemType Directory -Path $marketBackups -Force | Out-Null
            if (Test-Path -LiteralPath $marketPath) {
                Copy-Item -LiteralPath $marketPath -Destination (Join-Path $marketBackups ('marketplace-' + [guid]::NewGuid().ToString('N') + '.json'))
            }
            New-Item -ItemType Directory -Path (Split-Path -Parent $marketPath) -Force | Out-Null
            [IO.File]::WriteAllText($marketPath, $marketText, [Text.UTF8Encoding]::new($false))
        }
    }
    Write-CodexMarketplace -Without $(if ($legacyRemoved) { 'nexus-indesign', 'indesign-secure' } else { 'nexus-indesign' })
    $codex = @(Get-Process -Name codex -ErrorAction SilentlyContinue | Where-Object { $_.Path -in $signedCodex } |
        Select-Object -ExpandProperty Path -Unique | Select-Object -First 1)
    if (-not $codex.Count) { $codex = @($signedCodex | ForEach-Object { Get-Item -LiteralPath $_ } | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName) }
    try {
        & $codex[0] plugin add nexus-indesign --marketplace $marketName --json
        if ($LASTEXITCODE -ne 0) { throw 'Installation du plugin InDesign dans Codex échouée.' }
    } finally {
        # `plugin add` réactive le plugin même pour une simple mise à jour d'icône. Garder le choix explicite existant,
        # y compris après un échec partiel du CLI, sans réécrire les autres réglages du profil.
        if ($keepDisabled) {
            $latestConfig = [IO.File]::ReadAllText($codexConfigPath)
            $table = [regex]::Match($latestConfig, $pluginTablePattern)
            if (-not $table.Success) { throw 'Le CLI a retiré la configuration de désactivation du plugin InDesign.' }
            $body = $table.Groups[1]
            $disabledBody = [regex]::Replace($body.Value, '(?m)^(\s*enabled\s*=\s*)true\b', '${1}false')
            $updatedConfig = $latestConfig.Remove($body.Index, $body.Length).Insert($body.Index, $disabledBody)
            if ($updatedConfig -cne $latestConfig) {
                if ([IO.File]::ReadAllText($codexConfigPath) -cne $latestConfig) { throw 'Configuration Codex modifiée simultanément : désactivation à réconcilier.' }
                $temporaryConfig = $codexConfigPath + '.indesign-' + [guid]::NewGuid().ToString('N') + '.tmp'
                try {
                    [IO.File]::WriteAllText($temporaryConfig, $updatedConfig, [Text.UTF8Encoding]::new($false))
                    Move-Item -LiteralPath $temporaryConfig -Destination $codexConfigPath -Force
                } finally {
                    if (Test-Path -LiteralPath $temporaryConfig) { Remove-Item -LiteralPath $temporaryConfig -Force }
                }
            }
        }
    }
    if (-not $legacyRemoved) {
        & $codex[0] plugin remove "indesign-secure@$marketName" --json | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-CodexMarketplace -Without 'nexus-indesign', 'indesign-secure'
            $legacyRemoved = $true
        }
        else {
            # Non bloquant : nexus-indesign est installé ; l'ancien reste au catalogue et sera retiré au prochain -Install.
            Write-Warning "Retrait de l'ancien plugin Codex indesign-secure échoué ; nouvel essai au prochain -Install."
        }
    }
    $legacySource = Join-Path $parent 'indesign-secure'
    if ($legacyRemoved -and (Test-Path -LiteralPath $legacySource) -and $legacySource -ine $target) {
        Remove-Item -LiteralPath $legacySource -Recurse -Force
    }
}

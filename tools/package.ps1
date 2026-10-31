# Release files of one version (used by .github/workflows/release.yml, runnable locally to check a release):
#   NexusInDesign-win-x64.zip, NexusInDesign-win-arm64.zip    self-contained single-file NexusInDesign.exe per architecture
#   nexus-indesign-<version>-win-x64.mcpb, …-win-arm64.mcpb   MCP bundles (manifest.json, icon, server\NexusInDesign.exe)
#   get.ps1                                                   the installer, checked and attested like the packages
#   SHA256SUMS.txt                                            SHA-256 of every file above
# Build outputs in ~\.nexus\build\nexusindesign\release; nothing written to the sources.
# Usage: pwsh -File tools/package.ps1 -Version 4.0.0 [-Out <folder>]
param([Parameter(Mandatory)] [ValidatePattern('^\d+\.\d+\.\d+$')] [string]$Version, [string]$Out)
$ErrorActionPreference = 'Stop'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_NOLOGO = '1'
$repo = Split-Path $PSScriptRoot
$work = Join-Path $env:USERPROFILE '.nexus\build\nexusindesign\release'
if (-not $Out) { $Out = Join-Path $work 'dist' }

$engine = [IO.File]::ReadAllText((Join-Path $repo 'native\Program.cs'))
if ($engine -notmatch 'public const string Version = "([^"]+)"' -or $Matches[1] -ne $Version) {
    throw "native\Program.cs has version $($Matches[1]), not $Version."
}
foreach ($folder in $work, $Out) { if (Test-Path $folder) { Remove-Item $folder -Recurse -Force } }
New-Item -ItemType Directory -Force $Out | Out-Null

foreach ($rid in 'win-x64', 'win-arm64') {
    $publish = Join-Path $work $rid
    dotnet publish (Join-Path $repo 'native\NexusInDesign.csproj') -c Release -r $rid --self-contained true `
        -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:DebugType=none `
        -p:NexusBuild="$work\$rid-build\" -o $publish -v q
    if ($LASTEXITCODE) { throw "dotnet publish $rid failed." }
    Compress-Archive -LiteralPath (Join-Path $publish 'NexusInDesign.exe') -DestinationPath (Join-Path $Out "NexusInDesign-$rid.zip")
}

# MCP bundles (https://github.com/modelcontextprotocol/mcpb), one per architecture, same manifest.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$tools = [IO.File]::ReadAllText((Join-Path $repo 'native\tool-contracts.json')) | ConvertFrom-Json
foreach ($rid in 'win-x64', 'win-arm64') {
    $bundle = Join-Path $work "mcpb-$rid"
    New-Item -ItemType Directory -Force (Join-Path $bundle 'server') | Out-Null
    Copy-Item (Join-Path $work "$rid\NexusInDesign.exe") (Join-Path $bundle 'server')
    Copy-Item (Join-Path $repo 'plugin\assets\logo.png') (Join-Path $bundle 'icon.png')
    $manifest = [ordered]@{
        manifest_version = '0.3'
        name = 'nexus-indesign'
        display_name = 'NexusInDesign'
        version = $Version
        description = 'Adobe InDesign through its COM automation only: scripts, previews, preflight and verified exports, every change backed up.'
        long_description = 'Open, inspect, script (UXP), preview, preflight and export Adobe InDesign 2024 to 2026 documents. ' +
            'Everything runs through InDesign''s own COM automation (DoScript, NEVER_INTERACT): no panel, no UXP plugin, no ' +
            'network listener. Each mutation checks the document revision and state token, backs up every open document ' +
            'first and keeps an audit journal without document content.'
        author = [ordered]@{ name = 'Julien Piron'; url = 'https://github.com/pironjulien' }
        repository = [ordered]@{ type = 'git'; url = 'https://github.com/pironjulien/NexusInDesign' }
        homepage = 'https://github.com/pironjulien/NexusInDesign'
        documentation = 'https://github.com/pironjulien/NexusInDesign#readme'
        support = 'https://github.com/pironjulien/NexusInDesign/issues'
        icon = 'icon.png'
        server = [ordered]@{
            type = 'binary'
            entry_point = 'server/NexusInDesign.exe'
            mcp_config = [ordered]@{ command = '${__dirname}/server/NexusInDesign.exe'; args = @('--mcp'); env = [ordered]@{} }
        }
        tools = @($tools | ForEach-Object { [ordered]@{ name = $_.name; description = ($_.description -split '\r?\n')[0] } })
        keywords = @('indesign', 'adobe', 'layout', 'desktop-publishing', 'uxp')
        license = 'MIT'
        compatibility = [ordered]@{ platforms = @('win32') }
    }
    [IO.File]::WriteAllText((Join-Path $bundle 'manifest.json'), ($manifest | ConvertTo-Json -Depth 10) + "`n", [Text.UTF8Encoding]::new($false))
    [IO.Compression.ZipFile]::CreateFromDirectory($bundle, (Join-Path $Out "nexus-indesign-$Version-$rid.mcpb"))
}

Copy-Item (Join-Path $repo 'get.ps1') $Out
Get-ChildItem $Out -File | Sort-Object Name | ForEach-Object {
    '{0}  {1}' -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $_.Name
} | Set-Content (Join-Path $Out 'SHA256SUMS.txt') -Encoding utf8NoBOM
Get-ChildItem $Out -File | ForEach-Object { '{0,12:N0}  {1}' -f $_.Length, $_.Name }

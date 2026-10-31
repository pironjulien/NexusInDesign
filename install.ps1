# Installe le serveur InDesign MCP et ses dépendances Node.js hors de OneDrive (~/.nexus/indesign-mcp-secure),
# chemin lancé par le plugin Claude nexus-indesign@nexus (src\index.js).
[CmdletBinding()]
param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$runtime = Join-Path $HOME '.nexus\indesign-mcp-secure'
$runtime = [IO.Path]::GetFullPath($runtime)
$expectedParent = [IO.Path]::GetFullPath((Join-Path $HOME '.nexus')).TrimEnd('\') + '\'
if (-not $runtime.StartsWith($expectedParent, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Le runtime InDesign doit rester dans le dossier local .nexus.'
}
$different = [Collections.Generic.List[string]]::new()
foreach ($privateDir in 'private', 'private\backups', 'private\audit') {
    if (-not (Test-Path -LiteralPath (Join-Path $runtime $privateDir) -PathType Container)) { $different.Add($privateDir) }
}
foreach ($dir in 'src', 'plugin', 'scripts') {
    $source = Join-Path $PSScriptRoot $dir
    $target = Join-Path $runtime $dir
    $wanted = @(Get-ChildItem -LiteralPath $source -Recurse -File | ForEach-Object { $_.FullName.Substring($source.Length + 1) })
    $present = @(Get-ChildItem -LiteralPath $target -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName.Substring($target.Length + 1) })
    if (Compare-Object $wanted $present) { $different.Add($dir); continue }
    foreach ($file in $wanted) {
        if ((Get-FileHash -LiteralPath (Join-Path $source $file)).Hash -cne (Get-FileHash -LiteralPath (Join-Path $target $file)).Hash) {
            $different.Add($dir); break
        }
    }
}
# Dépendances jugées sur le verrou réellement installé (marque posée après un npm ci réussi), pas sur la copie de
# package-lock.json : celle-ci est faite avant npm ci, et un npm ci interrompu laissait le contrôle dire OK (20/10/2026).
$lockMark = Join-Path $runtime 'node_modules\.nexus-installed-lock'
$lockSource = Join-Path $PSScriptRoot 'package-lock.json'
$lockHash = if (Test-Path -LiteralPath $lockSource) { (Get-FileHash -LiteralPath $lockSource).Hash } else { 'sans-verrou' }
$dependenciesChanged = -not (Test-Path -LiteralPath (Join-Path $runtime 'node_modules\@modelcontextprotocol\sdk\package.json')) -or
    -not (Test-Path -LiteralPath $lockMark) -or (Get-Content -LiteralPath $lockMark -Raw).Trim() -cne $lockHash
foreach ($file in 'package.json', 'package-lock.json') {
    $source = Join-Path $PSScriptRoot $file
    $target = Join-Path $runtime $file
    if (-not (Test-Path -LiteralPath $target) -or (Get-FileHash -LiteralPath $source).Hash -cne (Get-FileHash -LiteralPath $target).Hash) {
        $different.Add($file); $dependenciesChanged = $true
    }
}
if ($CheckOnly) {
    if ($different.Count -or $dependenciesChanged) { throw "Runtime InDesign à mettre à jour : $($different -join ', ')." }
    Write-Host 'Runtime InDesign : sources et dépendances installées hors OneDrive.'
    return
}
New-Item -ItemType Directory -Force $runtime | Out-Null

# Code exécuté par le serveur : src, plugin (commands.js) et scripts (lanceurs PowerShell). private\ reste intact.
foreach ($dir in 'src', 'plugin', 'scripts') {
    $target = [IO.Path]::GetFullPath((Join-Path $runtime $dir))
    if (-not $target.StartsWith($runtime + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Destination de copie hors runtime.' }
    robocopy (Join-Path $PSScriptRoot $dir) $target /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Copie de $dir vers $runtime échouée ($LASTEXITCODE)." }
}
$global:LASTEXITCODE = 0

# Dossiers privés exigés au démarrage (config.js les résout par realpath) : journal d'audit et sauvegardes.
foreach ($dir in 'private', 'private\backups', 'private\audit') {
    New-Item -ItemType Directory -Force (Join-Path $runtime $dir) | Out-Null
}

Copy-Item (Join-Path $PSScriptRoot 'package.json') (Join-Path $runtime 'package.json')
if (Test-Path (Join-Path $PSScriptRoot 'package-lock.json')) {
    Copy-Item (Join-Path $PSScriptRoot 'package-lock.json') (Join-Path $runtime 'package-lock.json')
}

# npm ci contrôle la version de Node exigée par package.json : la première du PATH peut être plus ancienne (Node 22
# installé pour la machine devant Node 24 installé pour l'utilisateur, 20/10/2026). La plus récente trouvée est prise.
$nodes = @(@(Get-Command node -All -ErrorAction SilentlyContinue | ForEach-Object Source) +
    @((Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'), (Join-Path $env:ProgramFiles 'nodejs\node.exe')) |
    Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Sort-Object -Unique)
$node = $nodes | Sort-Object { [version]((& $_ -v).TrimStart('v')) } -Descending | Select-Object -First 1
if ($node) { $env:Path = (Split-Path $node) + ';' + $env:Path }
Push-Location $runtime
try {
    if ($dependenciesChanged) {
        npm ci --prefer-offline --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE) { throw 'npm ci a échoué dans ~/.nexus/indesign-mcp-secure.' }
        [IO.File]::WriteAllText($lockMark, $lockHash)
    }
} finally {
    Pop-Location
}
Write-Host "InDesign MCP installé dans $runtime." -ForegroundColor Green

# Contrôle complet du dépôt, hors ligne et sans InDesign (convention Nexus : test.ps1 à la racine).
# Environnement et node_modules HORS OneDrive (~/.nexus/indesign-mcp-secure) préparés par install.ps1.
$ErrorActionPreference = 'Stop'
$node = Get-Command node -CommandType Application -All -ErrorAction Stop |
    Where-Object { (& $_.Source --version) -match '^v24\.' } | Select-Object -First 1 -ExpandProperty Source
if (-not $node) { throw 'Node.js 24 est requis.' }
$env:PATH = (Split-Path -Parent $node) + [IO.Path]::PathSeparator + $env:PATH

$runtime = Join-Path $HOME '.nexus\indesign-mcp-secure'
if (-not (Test-Path (Join-Path $runtime 'node_modules'))) {
    throw 'node_modules absent de ~/.nexus/indesign-mcp-secure : lancer install.ps1.'
}

# Test dans une copie miroir sous %LOCALAPPDATA% pour ne rien écrire dans OneDrive
$work = Join-Path $env:LOCALAPPDATA 'NexusTests\indesign-mcp-secure'
$copy = Join-Path $work 'repo'
New-Item -ItemType Directory -Force $copy | Out-Null
robocopy $PSScriptRoot $copy /MIR /XD node_modules work .git /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Robocopy vers $copy a échoué ($LASTEXITCODE)" }

# Copier ou lier le node_modules depuis ~/.nexus
$copyModules = Join-Path $copy 'node_modules'
if (-not (Test-Path $copyModules)) {
    cmd /c mklink /j $copyModules (Join-Path $runtime 'node_modules') | Out-Null
}

Push-Location $copy
try {
    npm test
    if ($LASTEXITCODE) { throw 'npm test a échoué.' }
} finally {
    Pop-Location
}

Push-Location $PSScriptRoot
try {
    gitleaks git . --no-banner --redact --exit-code 1 --log-level warn
    if ($LASTEXITCODE) { throw 'gitleaks : secret dans l''historique Git.' }
} finally {
    Pop-Location
}

# Full offline check (xUnit, `dotnet test`): the engine against an emulated InDesign, the COM host's mutex, the UXP
# scripts' syntax (node --check, test only) and get.ps1 with a local package. No InDesign is started. Build and test
# outputs go to ~\.nexus\build\nexusindesign.
$ErrorActionPreference = 'Stop'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_NOLOGO = '1'
Push-Location $PSScriptRoot
try {
    dotnet test --project tests/NexusInDesign.Tests.csproj
    if ($LASTEXITCODE) { throw 'Tests failed.' }
} finally { Pop-Location }
Write-Host 'NexusInDesign: all checks passed.'

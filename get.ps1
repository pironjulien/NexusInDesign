# NexusInDesign for Windows 10/11 (Windows PowerShell 5.1 or PowerShell 7), no administrator rights, nothing else to
# install (no Node.js, no .NET, no Adobe UXP plugin: the engine is self-contained and drives InDesign through COM).
# Usual way: the NexusSystem app (Microsoft Store), which runs this file and adds the nexus-indesign plugin to Claude
# Code and Codex from the Nexus catalog. By hand: download get.ps1 and SHA256SUMS.txt from the latest release, check
# the hash (and `gh attestation verify get.ps1 --repo pironjulien/NexusInDesign`), then:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\get.ps1          install or update
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\get.ps1 -Remove  program removed (backups and audit stay in
#                                                                          ~\.nexus\nexus-indesign\private)
# It downloads the latest release's NexusInDesign-win-x64.zip or NexusInDesign-win-arm64.zip (by the PC's
# architecture), checks its SHA-256 against the release's SHA256SUMS.txt before extracting anything (build provenance:
# `gh attestation verify <file> --repo pironjulien/NexusInDesign`), then installs NexusInDesign.exe as
# %USERPROFILE%\.nexus\nexus-indesign\NexusInDesign.exe, the path the plugins start. A running session keeps its copy
# (renamed NexusInDesign.exe.old-<id>, removed by a later run); new sessions get the new version. Run it again to update.
# NEXUS_PACK=1 (the Nexus pack): no question, no window; exit code 0 on success; a last "NEXUS_PACK_RESULT ..." line.
# NEXUS_RELEASE_TAG: install that release (vX.Y.Z or vX.Y.Z-dev.N) instead of the latest.
# For tests only: NEXUS_INDESIGN_SOURCE (a local zip instead of the latest release) and NEXUS_INDESIGN_HOME (another
# install folder). A local zip aimed at the real install folder is refused unless -Real is given.
[CmdletBinding()]
param([switch]$Remove, [switch]$Real)

$ErrorActionPreference = 'Stop'
# Windows PowerShell started from PowerShell 7 inherits its module folders, whose modules it cannot load (Get-FileHash,
# Unblock-File...): keep only its own.
if ($PSVersionTable.PSEdition -ne 'Core') {
    $env:PSModulePath = (($env:PSModulePath -split ';') | Where-Object { $_ -and $_ -notmatch '\\PowerShell\\(7|Modules)' }) -join ';'
}
$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest is many times slower with its progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo = 'pironjulien/NexusInDesign'
$Pack = $env:NEXUS_PACK -eq '1'
$Root = if ($env:NEXUS_INDESIGN_HOME) { $env:NEXUS_INDESIGN_HOME } else { Join-Path $env:USERPROFILE '.nexus\nexus-indesign' }
$Stable = Join-Path $Root 'NexusInDesign.exe'
$Arch = if (($env:PROCESSOR_ARCHITEW6432, $env:PROCESSOR_ARCHITECTURE) -contains 'ARM64') { 'win-arm64' } else { 'win-x64' }
$Package = "NexusInDesign-$Arch.zip"

function Say([string]$Text, [string]$Color = 'Gray') { if (-not $Pack) { Write-Host $Text -ForegroundColor $Color } }

function Get-LatestTag {
    if ($env:NEXUS_RELEASE_TAG) {
        if ($env:NEXUS_RELEASE_TAG -notmatch '^v\d+\.\d+\.\d+(-dev\.\d+)?$') { throw "NEXUS_RELEASE_TAG is not a release tag: $env:NEXUS_RELEASE_TAG" }
        return $env:NEXUS_RELEASE_TAG
    }
    # The latest release's tag from the redirect of github.com/<repo>/releases/latest: no GitHub API (60 anonymous
    # requests an hour per IP). The API stays as a fallback.
    try {
        $request = [Net.HttpWebRequest]::Create("https://github.com/$Repo/releases/latest")
        $request.AllowAutoRedirect = $false
        $request.UserAgent = 'NexusInDesign-get'
        $response = $request.GetResponse()
        try { $location = $response.Headers['Location'] } finally { $response.Close() }
        if ($location -match '/releases/tag/(v[0-9][^/?#]*)$') { return $Matches[1] }
    } catch { Write-Verbose "Redirect lookup failed: $($_.Exception.Message)" }
    return (Invoke-RestMethod -UseBasicParsing "https://api.github.com/repos/$Repo/releases/latest").tag_name
}

function Get-ExpectedHash([byte[]]$Manifest, [string]$Name) {
    $text = [Text.UTF8Encoding]::new($false, $true).GetString($Manifest).TrimStart([char]0xfeff)
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    $expected = $null
    foreach ($line in ($text -split '\r?\n' | Where-Object { $_.Trim() })) {
        if ($line -cnotmatch '^([0-9a-f]{64})\s+\*?(\S+)\s*$') { throw 'SHA256SUMS.txt has an invalid entry: installation refused.' }
        if (-not $seen.Add($Matches[2])) { throw 'SHA256SUMS.txt lists a file more than once: installation refused.' }
        if ($Matches[2] -ceq $Name) { $expected = $Matches[1] }
    }
    if (-not $expected) { throw "$Name is absent from SHA256SUMS.txt: installation refused." }
    return $expected
}

function Invoke-WhileHeld([string]$Staged, [scriptblock]$Action) {
    # Renaming the freshly copied executable fails while another process holds it open without delete sharing. This
    # installer never runs or keeps open the staged copy, but antivirus and indexing services open freshly written
    # executables for a moment to scan them ("being used by another process", seen once with NexusAGYmail on a fresh
    # GitHub Windows runner). Only that external, transient hold (sharing, lock or access violation while the staged
    # copy is still there) is waited out, at most 10 s; any other error, or a longer hold, fails.
    $transient = 0x80070020, 0x80070021, 0x80070005  # ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION, ERROR_ACCESS_DENIED
    for ($attempt = 1; ; $attempt++) {
        try { & $Action; return }
        catch {
            $failure = $_.Exception
            while ($failure.InnerException -and $failure -is [Management.Automation.MethodInvocationException]) { $failure = $failure.InnerException }
            $held = ($failure -is [IO.IOException] -or $failure -is [UnauthorizedAccessException]) -and
                ($transient -contains $failure.HResult) -and (Test-Path -LiteralPath $Staged)
            if (-not $held -or $attempt -ge 40) { throw "Cannot install $Staged as $($Stable): $($failure.Message)" }
            Start-Sleep -Milliseconds 250
        }
    }
}

# A running EXE cannot be overwritten but can be renamed: the new one replaces it, the running copy becomes
# NexusInDesign.exe.old-<id>, removed by a later run once its session has ended. Returns that copy's path (empty for a
# first installation), so a new executable that does not run can be taken back.
function Update-Stable([string]$Source) {
    New-Item -ItemType Directory -Force -Path $Root | Out-Null
    $staged = Join-Path $Root ('NexusInDesign.exe.new-' + [guid]::NewGuid().ToString('N'))
    $backup = ''
    Copy-Item -LiteralPath $Source -Destination $staged
    try {
        if (Test-Path -LiteralPath $Stable) {
            $backup = Join-Path $Root ('NexusInDesign.exe.old-' + [guid]::NewGuid().ToString('N'))
            Invoke-WhileHeld $staged { [IO.File]::Replace($staged, $Stable, $backup) }
        } else {
            Invoke-WhileHeld $staged { [IO.File]::Move($staged, $Stable) }
        }
    } finally {
        Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
    }
    return $backup
}

# The new executable did not run: the previous one goes back in place (a running session keeps its own copy), or, on a
# first installation, the new one is removed.
function Undo-Stable([string]$Backup) {
    if ($Backup -and (Test-Path -LiteralPath $Backup)) {
        $failed = Join-Path $Root ('NexusInDesign.exe.old-' + [guid]::NewGuid().ToString('N'))
        Invoke-WhileHeld $Backup { [IO.File]::Replace($Backup, $Stable, $failed) }
    } else {
        Remove-Item -LiteralPath $Stable -Force -ErrorAction SilentlyContinue
    }
}

function Remove-Leftovers {
    foreach ($old in @(Get-ChildItem -LiteralPath $Root -Filter 'NexusInDesign.exe.old-*' -File -ErrorAction SilentlyContinue)) {
        Remove-Item -LiteralPath $old.FullName -Force -ErrorAction SilentlyContinue
    }
}

function Install-NexusInDesign {
    $work = Join-Path ([IO.Path]::GetTempPath()) "nexusindesign-$PID-$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    try {
        if ($env:NEXUS_INDESIGN_SOURCE) {
            $zip = (Resolve-Path -LiteralPath $env:NEXUS_INDESIGN_SOURCE).Path
            Say "Installing NexusInDesign from $zip..."
        } else {
            $tag = Get-LatestTag
            $base = "https://github.com/$Repo/releases/download/$tag"
            Say "Downloading NexusInDesign $tag ($Arch)..." Cyan
            $zip = Join-Path $work $Package
            Invoke-WebRequest -UseBasicParsing "$base/$Package" -OutFile $zip
            $manifest = (Invoke-WebRequest -UseBasicParsing "$base/SHA256SUMS.txt").RawContentStream.ToArray()
            $expected = Get-ExpectedHash $manifest $Package
            $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($expected -ne $actual) { throw "SHA-256 mismatch for $($Package): the download is not the published file." }
        }
        $unpacked = Join-Path $work 'package'
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [IO.Compression.ZipFile]::ExtractToDirectory($zip, $unpacked)
        $exe = Join-Path $unpacked 'NexusInDesign.exe'
        if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Not a NexusInDesign package.' }
        Get-ChildItem -LiteralPath $unpacked -Recurse -File | Unblock-File
        # The version from the executable's version resource, without running it: a program just run is what scanners
        # open right after, when its copy has to be renamed into place.
        $version = "$((Get-Item -LiteralPath $exe).VersionInfo.ProductVersion)".Split('+')[0].Trim()
        if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Not a NexusInDesign package (no version).' }
        $backup = Update-Stable $exe
        # Run once in place: the package must start on this PC's architecture and report the version it carries.
        $answer = ((& $Stable --version) -replace '^NexusInDesign\s+', '').Trim()
        if ($LASTEXITCODE -or $answer -ne $version) {
            Undo-Stable $backup
            throw "The package does not run on this PC ($Arch)."
        }
        Remove-Leftovers
        Say "NexusInDesign $version is in $Root." Green
        if (-not $Pack) {
            Say 'Add the nexus-indesign plugin to Claude Code or Codex (NexusSystem does it), then open a new conversation.' Yellow
        }
        return "NEXUS_PACK_RESULT NexusInDesign=installed $version"
    } finally {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Remove-NexusInDesign {
    if (-not (Test-Path -LiteralPath $Stable)) { Say 'NexusInDesign is not installed.'; return 'NEXUS_PACK_RESULT NexusInDesign=absent' }
    foreach ($item in @(Get-ChildItem -LiteralPath $Root -Filter 'NexusInDesign.exe*' -File -Force)) {
        try { Remove-Item -LiteralPath $item.FullName -Force -ErrorAction Stop } catch { Say "Still in use (removed later): $($item.Name)" Yellow }
    }
    Say 'NexusInDesign removed. Backups, audit journal and settings stay in ~\.nexus\nexus-indesign (delete that folder to forget them).' Green
    return 'NEXUS_PACK_RESULT NexusInDesign=removed'
}

$code = 1
$result = $null
try {
    if ($env:NEXUS_INDESIGN_SOURCE -and -not $env:NEXUS_INDESIGN_HOME -and -not $Real) {
        throw 'NEXUS_INDESIGN_SOURCE (a test package) is set but NEXUS_INDESIGN_HOME is not: refusing to install for real. Set NEXUS_INDESIGN_HOME to a test folder, or pass -Real.'
    }
    if ($env:OS -ne 'Windows_NT') { throw 'NexusInDesign runs on Windows 10 or 11 only.' }
    $result = if ($Remove) { Remove-NexusInDesign } else { Install-NexusInDesign }
    $code = 0
} catch {
    Say "NexusInDesign: $($_.Exception.Message)" Red
    if ($Pack) { Write-Host "NexusInDesign: $($_.Exception.Message)" }
    $result = 'NEXUS_PACK_RESULT NexusInDesign=failed'
    $code = 1
}
if ($Pack -and $result) { Write-Output $result }
if ($PSCommandPath) { exit $code }
if ($code) { throw 'NexusInDesign: not installed (see above).' }

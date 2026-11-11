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
# `gh attestation verify <file> --repo pironjulien/NexusInDesign`), then installs into %USERPROFILE%\.nexus\nexus-indesign:
#   versions\<version>-<hash>\NexusInDesign.exe   the engine, in a folder of its own never modified once written
#   current.txt                                   the name of that folder: the version new sessions start
#   NexusInDesign.exe                             the launcher (Native AOT) the plugins start: it runs the engine
#                                                 current.txt names
# A session already open keeps running its own engine, whose file never changes under it; an older version's folder is
# removed once no process runs its engine any more, by a later run or by the launcher when a session starts (4.3.1).
# Run it again to update.
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
$Versions = Join-Path $Root 'versions'
$Pointer = Join-Path $Root 'current.txt'
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

function Invoke-WhileHeld([string]$Staged, [string]$Target, [scriptblock]$Action) {
    # Renaming a freshly copied executable (or the folder holding it) fails while another process holds it open without
    # delete sharing. This installer never keeps a staged copy open, but antivirus and indexing services open freshly
    # written executables for a moment to scan them ("being used by another process", seen once with NexusAGYmail on a
    # fresh GitHub Windows runner). Only that external, transient hold (sharing, lock or access violation while the
    # staged copy is still there) is waited out, at most 10 s; any other error, or a longer hold, fails.
    $transient = 0x80070020, 0x80070021, 0x80070005  # ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION, ERROR_ACCESS_DENIED
    for ($attempt = 1; ; $attempt++) {
        try { & $Action; return }
        catch {
            $failure = $_.Exception
            while ($failure.InnerException -and $failure -is [Management.Automation.MethodInvocationException]) { $failure = $failure.InnerException }
            $held = ($failure -is [IO.IOException] -or $failure -is [UnauthorizedAccessException]) -and
                ($transient -contains $failure.HResult) -and (Test-Path -LiteralPath $Staged)
            if (-not $held -or $attempt -ge 40) { throw "Cannot install $Staged as $($Target): $($failure.Message)" }
            Start-Sleep -Milliseconds 250
        }
    }
}

function Get-Sha256([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

# The engine goes to versions\<version>-<first 16 hex digits of its SHA-256>, copied under a temporary name and renamed
# into place in one step, then never modified: a session that runs it keeps a file that never changes under it (up to
# 4.2.x the engine was a self-contained single-file .NET program, which reads its own file again each time it loads an
# assembly; since 4.3.0 it is Native AOT). Returns the folder's name and whether this run wrote it.
function Install-Engine([string]$Source, [string]$Version) {
    $hash = Get-Sha256 $Source
    $name = "$Version-$($hash.Substring(0, 16))"
    $target = Join-Path $Versions $name
    $engine = Join-Path $target 'NexusInDesign.exe'
    if ((Test-Path -LiteralPath $engine -PathType Leaf) -and (Get-Sha256 $engine) -eq $hash) { return $name, $false }
    if (Test-Path -LiteralPath $target) {
        # A folder left incomplete or altered: never a running engine's (its file could not be deleted).
        try { Remove-Item -LiteralPath $target -Recurse -Force }
        catch { throw "$target is not the published engine and cannot be removed: $($_.Exception.Message)" }
    }
    New-Item -ItemType Directory -Force -Path $Versions | Out-Null
    $staged = Join-Path $Versions ('.new-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $staged | Out-Null
    try {
        Copy-Item -LiteralPath $Source -Destination (Join-Path $staged 'NexusInDesign.exe')
        Invoke-WhileHeld $staged $target { [IO.Directory]::Move($staged, $target) }
    } finally {
        Remove-Item -LiteralPath $staged -Recurse -Force -ErrorAction SilentlyContinue
    }
    return $name, $true
}

# The launcher the plugins start, a native program (it never reads its own file again once started): a running copy
# can be renamed aside (NexusInDesign.exe.old-<id>, removed by a later run once its session has ended) and the new one
# put in its place. Nothing to do when it is already this one. Returns the previous copy's path ('' for a first
# installation or no change) and whether it changed.
function Update-Stable([string]$Source) {
    if ((Test-Path -LiteralPath $Stable -PathType Leaf) -and (Get-Sha256 $Stable) -eq (Get-Sha256 $Source)) { return '', $false }
    New-Item -ItemType Directory -Force -Path $Root | Out-Null
    $staged = Join-Path $Root ('NexusInDesign.exe.new-' + [guid]::NewGuid().ToString('N'))
    $backup = ''
    Copy-Item -LiteralPath $Source -Destination $staged
    try {
        if (Test-Path -LiteralPath $Stable) {
            $backup = Join-Path $Root ('NexusInDesign.exe.old-' + [guid]::NewGuid().ToString('N'))
            Invoke-WhileHeld $staged $Stable { [IO.File]::Replace($staged, $Stable, $backup) }
        } else {
            Invoke-WhileHeld $staged $Stable { [IO.File]::Move($staged, $Stable) }
        }
    } finally {
        Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
    }
    return $backup, $true
}

# The launcher just installed did not run: the previous one goes back in place, or, on a first installation, the new
# one is removed.
function Undo-Stable([string]$Backup) {
    if ($Backup -and (Test-Path -LiteralPath $Backup)) {
        $failed = Join-Path $Root ('NexusInDesign.exe.old-' + [guid]::NewGuid().ToString('N'))
        Invoke-WhileHeld $Backup $Stable { [IO.File]::Replace($Backup, $Stable, $failed) }
    } else {
        Remove-Item -LiteralPath $Stable -Force -ErrorAction SilentlyContinue
    }
}

function Get-Current {
    if (-not (Test-Path -LiteralPath $Pointer -PathType Leaf)) { return '' }
    return ([IO.File]::ReadAllText($Pointer)).Trim()
}

# current.txt names the version new sessions start; replaced in one step, so a launcher reads the old name or the new.
function Set-Current([string]$Name) {
    if (-not $Name) { Remove-Item -LiteralPath $Pointer -Force -ErrorAction SilentlyContinue; return }
    $staged = $Pointer + '.new-' + [guid]::NewGuid().ToString('N')
    [IO.File]::WriteAllText($staged, $Name, [Text.UTF8Encoding]::new($false))
    try {
        if (Test-Path -LiteralPath $Pointer) { [IO.File]::Replace($staged, $Pointer, [NullString]::Value) } else { [IO.File]::Move($staged, $Pointer) }
    } finally {
        Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
    }
}

# Removes what no process uses any more: renamed launchers, staged copies, and the folders of other versions. A
# running program's file cannot be deleted, so the folder of an engine a session still runs stays, whole, until a later
# run.
function Remove-Leftovers([string]$Keep) {
    foreach ($old in @(Get-ChildItem -LiteralPath $Root -Filter 'NexusInDesign.exe.old-*' -File -ErrorAction SilentlyContinue)) {
        Remove-Item -LiteralPath $old.FullName -Force -ErrorAction SilentlyContinue
    }
    foreach ($folder in @(Get-ChildItem -LiteralPath $Versions -Directory -Force -ErrorAction SilentlyContinue)) {
        if ($folder.Name -eq $Keep) { continue }
        $engine = Join-Path $folder.FullName 'NexusInDesign.exe'
        try { if (Test-Path -LiteralPath $engine) { Remove-Item -LiteralPath $engine -Force -ErrorAction Stop } }
        catch { continue }  # still running
        Remove-Item -LiteralPath $folder.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Test-Engine([string]$Path, [string]$Version) {
    $answer = ((& $Path --version) -replace '^NexusInDesign\s+', '').Trim()
    return (-not $LASTEXITCODE) -and $answer -eq $Version
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
        $launcher = Join-Path $unpacked 'NexusInDesignLauncher.exe'
        if (-not (Test-Path -LiteralPath $exe -PathType Leaf) -or -not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'Not a NexusInDesign package.' }
        Get-ChildItem -LiteralPath $unpacked -Recurse -File | Unblock-File
        # The version from the engine's version resource.
        $version = "$((Get-Item -LiteralPath $exe).VersionInfo.ProductVersion)".Split('+')[0].Trim()
        if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Not a NexusInDesign package (no version).' }

        $name, $written = Install-Engine $exe $version
        # Run once from its own folder (nothing renames it afterwards): the package must start on this PC's
        # architecture and report the version it carries.
        if (-not (Test-Engine (Join-Path $Versions "$name\NexusInDesign.exe") $version)) {
            if ($written -and $name -ne (Get-Current)) { Remove-Item -LiteralPath (Join-Path $Versions $name) -Recurse -Force -ErrorAction SilentlyContinue }
            throw "The package does not run on this PC ($Arch)."
        }
        $previous = Get-Current
        $backup, $changed = Update-Stable $launcher
        Set-Current $name
        # Then as the plugins start it: the launcher, which runs the engine current.txt names.
        if (-not (Test-Engine $Stable $version)) {
            Set-Current $previous
            if ($changed) { Undo-Stable $backup }
            throw "The package does not run on this PC ($Arch)."
        }
        Remove-Leftovers $name
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
    if (-not (Test-Path -LiteralPath $Stable) -and -not (Test-Path -LiteralPath $Versions)) {
        Say 'NexusInDesign is not installed.'
        return 'NEXUS_PACK_RESULT NexusInDesign=absent'
    }
    $busy = @()
    foreach ($item in @(Get-ChildItem -LiteralPath $Root -Filter 'NexusInDesign.exe*' -File -Force)) {
        try { Remove-Item -LiteralPath $item.FullName -Force -ErrorAction Stop } catch { $busy += $item.Name }
    }
    Set-Current ''
    foreach ($folder in @(Get-ChildItem -LiteralPath $Versions -Directory -Force -ErrorAction SilentlyContinue)) {
        try { Remove-Item -LiteralPath $folder.FullName -Recurse -Force -ErrorAction Stop } catch { $busy += "versions\$($folder.Name)" }
    }
    if (-not $busy) { Remove-Item -LiteralPath $Versions -Force -ErrorAction SilentlyContinue }
    foreach ($name in $busy) { Say "Still in use (removed later): $name" Yellow }
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

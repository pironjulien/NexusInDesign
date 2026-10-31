[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$SourceDirectory,

    [Parameter(Mandatory)]
    [string]$DestinationPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$source = (Resolve-Path -LiteralPath $SourceDirectory).Path
$destination = [System.IO.Path]::GetFullPath($DestinationPath)
$relativeDestination = [System.IO.Path]::GetRelativePath($source, $destination)
if (
    $relativeDestination -eq '.' -or
    (-not $relativeDestination.StartsWith("..$([System.IO.Path]::DirectorySeparatorChar)") -and
        $relativeDestination -ne '..' -and
        -not [System.IO.Path]::IsPathRooted($relativeDestination))
) {
    throw 'CCX_DESTINATION_INSIDE_SOURCE'
}

$items = @(Get-ChildItem -LiteralPath $source -Recurse -Force)
$reparsePoint = $items | Where-Object { $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint } | Select-Object -First 1
if ($reparsePoint) {
    throw "CCX_REPARSE_POINT_FORBIDDEN:$($reparsePoint.Name)"
}

$relativePaths = @(
    $items |
        Where-Object { -not $_.PSIsContainer } |
        ForEach-Object {
            [System.IO.Path]::GetRelativePath($source, $_.FullName).Replace(
                [System.IO.Path]::DirectorySeparatorChar,
                [char]'/'
            )
        }
)
if ($relativePaths.Count -eq 0) {
    throw 'CCX_SOURCE_EMPTY'
}
[Array]::Sort($relativePaths, [System.StringComparer]::Ordinal)

$destinationDirectory = [System.IO.Path]::GetDirectoryName($destination)
[System.IO.Directory]::CreateDirectory($destinationDirectory) | Out-Null
$temporaryPath = "$destination.tmp-$PID-$([Guid]::NewGuid().ToString('N'))"
$fixedTimestamp = [DateTimeOffset]::new(1980, 1, 1, 0, 0, 0, [TimeSpan]::Zero)

Add-Type -AssemblyName System.IO.Compression
try {
    $output = [System.IO.File]::Open($temporaryPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    try {
        $archive = [System.IO.Compression.ZipArchive]::new(
            $output,
            [System.IO.Compression.ZipArchiveMode]::Create,
            $false,
            [System.Text.Encoding]::UTF8
        )
        try {
            foreach ($relativePath in $relativePaths) {
                $entry = $archive.CreateEntry($relativePath, [System.IO.Compression.CompressionLevel]::Optimal)
                $entry.LastWriteTime = $fixedTimestamp
                $entry.ExternalAttributes = 0

                $input = [System.IO.File]::OpenRead((Join-Path $source $relativePath.Replace('/', [System.IO.Path]::DirectorySeparatorChar)))
                try {
                    $entryStream = $entry.Open()
                    try { $input.CopyTo($entryStream) }
                    finally { $entryStream.Dispose() }
                }
                finally { $input.Dispose() }
            }
        }
        finally { $archive.Dispose() }
    }
    finally { $output.Dispose() }

    [System.IO.File]::Move($temporaryPath, $destination, $true)
}
catch {
    [System.IO.File]::Delete($temporaryPath)
    throw
}

[pscustomobject]@{
    path = $destination
    sha256 = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
    files = $relativePaths.Count
    entries = $relativePaths
    timestamp = $fixedTimestamp.ToString('O')
} | ConvertTo-Json -Depth 4

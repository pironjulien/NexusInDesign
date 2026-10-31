param(
  [Parameter(Mandatory = $true)][string]$OperationPath,
  [ValidateRange(100, 900000)][int]$AcquireTimeoutMs = 120000,
  [ValidateRange(0, 2147483647)][int]$ExpectedGuardProcessId = 0,
  [ValidatePattern('^Local\\NexusInDesignAutomation(?:\.Test\.[0-9a-fA-F-]{36})?$')][string]$MutexName = 'Local\NexusInDesignAutomation',
  [switch]$Recovery
)

$ErrorActionPreference = 'Stop'
$mutexName = $MutexName
$mutex = $null
$mutexAcquired = $false
$abandoned = $false
$handshakeWritten = $false
$stage = 'validation'
$ReleaseNonce = $null

function Write-Handshake {
  param([Parameter(Mandatory = $true)][hashtable]$Value)
  [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

function Test-FullyQualifiedPath {
  param([Parameter(Mandatory = $true)][string]$Value)
  try {
    if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
    $isDriveAbsolute = [Text.RegularExpressions.Regex]::IsMatch($Value, '^[A-Za-z]:[\\/]')
    $isUncAbsolute = [Text.RegularExpressions.Regex]::IsMatch($Value, '^[\\/]{2}[^\\/]+[\\/]+[^\\/]+(?:[\\/]|$)')
    if (-not $isDriveAbsolute -and -not $isUncAbsolute) { return $false }
    if (@($Value -split '[\\/]' | Where-Object { $_ -eq '..' }).Count -gt 0) { return $false }
    $null = [System.IO.Path]::GetFullPath($Value)
    return $true
  }
  catch {
    return $false
  }
}

function Test-CommandLineArgument {
  param(
    [Parameter(Mandatory = $true)][string]$CommandLine,
    [Parameter(Mandatory = $true)][string]$Value
  )
  $escaped = [System.Text.RegularExpressions.Regex]::Escape($Value)
  $pattern = '(?i)(?:^|\s)(?:"' + $escaped + '"|' + $escaped + ')(?=\s|$)'
  return [System.Text.RegularExpressions.Regex]::IsMatch($CommandLine, $pattern)
}

function Test-ExpectedGuardProcess {
  param([Parameter(Mandatory = $true)][int]$ProcessId)
  try {
    if ($ProcessId -eq $PID) { return $false }
    $process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
    if ($null -eq $process -or [string]::IsNullOrWhiteSpace([string]$process.ExecutablePath)) { return $false }
    $currentExecutable = [System.IO.Path]::GetFullPath((Get-Process -Id $PID -ErrorAction Stop).Path)
    $guardExecutable = [System.IO.Path]::GetFullPath([string]$process.ExecutablePath)
    if (-not [System.StringComparer]::OrdinalIgnoreCase.Equals($currentExecutable, $guardExecutable)) { return $false }
    $commandLine = [string]$process.CommandLine
    if (-not [System.Text.RegularExpressions.Regex]::IsMatch($commandLine, '(?i)(?:^|\s)-File(?=\s|$)')) { return $false }
    if (-not [System.Text.RegularExpressions.Regex]::IsMatch($commandLine, '(?i)(?:^|\s)-OperationPath(?=\s|$)')) { return $false }
    if (-not (Test-CommandLineArgument -CommandLine $commandLine -Value $PSCommandPath)) { return $false }
    if (-not (Test-CommandLineArgument -CommandLine $commandLine -Value $OperationPath)) { return $false }
    if ($MutexName -ne 'Local\NexusInDesignAutomation') {
      if (-not [System.Text.RegularExpressions.Regex]::IsMatch($commandLine, '(?i)(?:^|\s)-MutexName(?=\s|$)')) { return $false }
      if (-not (Test-CommandLineArgument -CommandLine $commandLine -Value $MutexName)) { return $false }
    }
    return $true
  }
  catch {
    return $false
  }
}

function Read-OperationRecord {
  param([Parameter(Mandatory = $true)][string]$Path)
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if ($item.PSIsContainer -or $item.Length -le 0 -or $item.Length -gt 65536 -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw 'invalid-operation-record'
  }
  $lines = @([IO.File]::ReadAllLines($item.FullName) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  if ($lines.Count -eq 0) { throw 'invalid-operation-record' }
  $value = $lines[-1] | ConvertFrom-Json -ErrorAction Stop
  $operationId = [IO.Path]::GetFileNameWithoutExtension($Path)
  if (
    [int]$value.schemaVersion -ne 1 -or
    [string]$value.operationId -ne $operationId -or
    [string]$value.releaseNonce -notmatch '^[A-Za-z0-9_-]{43}$'
  ) { throw 'invalid-operation-record' }
  return $value
}

function Update-OperationRecord {
  param([Parameter(Mandatory = $true)][hashtable]$Changes)
  $current = Read-OperationRecord -Path $OperationPath
  $value = @{}
  foreach ($property in $current.PSObject.Properties) { $value[$property.Name] = $property.Value }
  foreach ($entry in $Changes.GetEnumerator()) { $value[$entry.Key] = $entry.Value }
  if (-not [string]::IsNullOrWhiteSpace([string]$current.command)) {
    $jsonLine = ($value | ConvertTo-Json -Compress -Depth 20) + [Environment]::NewLine
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $bytes = $utf8.GetBytes($jsonLine)
    $stream = New-Object System.IO.FileStream($OperationPath, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::Read, 4096, [IO.FileOptions]::WriteThrough)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  }
  else {
    Write-AtomicJson -Path $OperationPath -Value $value
  }
}

function Get-InDesignProcessSnapshot {
  $items = @()
  foreach ($process in Get-CimInstance -ClassName Win32_Process -Filter "Name = 'InDesign.exe'" -ErrorAction SilentlyContinue) {
    $startedAt = $null
    try {
      if ($process.CreationDate -is [datetime]) { $startedAt = $process.CreationDate.ToUniversalTime().ToString('o') }
      else { $startedAt = [System.Management.ManagementDateTimeConverter]::ToDateTime([string]$process.CreationDate).ToUniversalTime().ToString('o') }
    } catch {}
    if ([int]$process.ProcessId -gt 0 -and -not [string]::IsNullOrWhiteSpace($startedAt)) {
      $items += @{ processId = [int]$process.ProcessId; startedAt = $startedAt }
    }
  }
  return @($items | Sort-Object processId)
}

function Test-ReleaseAcknowledgement {
  param(
    [Parameter(Mandatory = $true)][string]$OperationPath,
    [Parameter(Mandatory = $true)][string]$ReleaseNonce
  )
  try {
    $operationId = [IO.Path]::GetFileNameWithoutExtension($OperationPath)
    $markerPath = Join-Path ([IO.Path]::GetDirectoryName($OperationPath)) "$operationId.$ReleaseNonce.release.json"
    $marker = Get-Item -LiteralPath $markerPath -Force -ErrorAction Stop
    if (
      $marker.PSIsContainer -or
      $marker.Length -le 0 -or
      $marker.Length -gt 8192 -or
      (($marker.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
    ) {
      return $false
    }
    $value = [IO.File]::ReadAllText($marker.FullName) | ConvertFrom-Json -ErrorAction Stop
    return (
      [int]$value.schemaVersion -eq 1 -and
      [string]$value.operationId -eq $operationId -and
      [string]$value.releaseNonce -eq $ReleaseNonce -and
      [string]$value.status -eq 'acknowledged'
    )
  }
  catch {
    return $false
  }
}

function Write-AtomicJson {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][object]$Value
  )
  $temporaryPath = "$Path.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  try {
    $json = $Value | ConvertTo-Json -Compress -Depth 20
    [System.IO.File]::WriteAllText($temporaryPath, $json, $utf8)
    Move-Item -LiteralPath $temporaryPath -Destination $Path -Force -ErrorAction Stop
  }
  finally {
    if (Test-Path -LiteralPath $temporaryPath) {
      Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    }
  }
}

function Write-ReconciliationFailure {
  param(
    [Parameter(Mandatory = $true)][string]$ResponsePath,
    [Parameter(Mandatory = $true)][string]$OperationId,
    [Parameter(Mandatory = $true)][string]$RequestId,
    [Parameter(Mandatory = $true)][string]$Code
  )
  if (Test-Path -LiteralPath $ResponsePath) { return }
  Write-AtomicJson -Path $ResponsePath -Value @{
    schemaVersion = 1
    operationId = $OperationId
    requestId = $RequestId
    ok = $false
    code = $Code
    completedAt = [DateTime]::UtcNow.ToString('o')
  }
}

function Get-CompatibleInDesignApplication {
  $lastError = $null
  foreach ($progId in @('InDesign.Application.2026', 'InDesign.Application.2025', 'InDesign.Application.2024')) {
    try {
      return New-Object -ComObject $progId -ErrorAction Stop
    }
    catch {
      $lastError = $_
    }
  }
  throw $lastError
}

function Invoke-ReconciliationRequest {
  param(
    [Parameter(Mandatory = $true)][System.IO.FileInfo]$RequestFile,
    [Parameter(Mandatory = $true)][string]$OperationId
  )
  $namePattern = '^' + [Regex]::Escape($OperationId) + '\.([0-9a-f-]{36})\.reconcile-request\.json$'
  $match = [Regex]::Match($RequestFile.Name, $namePattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if (-not $match.Success) { return }
  $requestId = $match.Groups[1].Value
  if ($requestId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') { return }
  $prefix = Join-Path $RequestFile.DirectoryName "$OperationId.$requestId.reconcile"
  $processingPath = "$prefix-processing.json"
  $responsePath = "$prefix-response.json"
  if (Test-Path -LiteralPath $responsePath) { return }
  if (
    $RequestFile.Length -le 0 -or
    $RequestFile.Length -gt 65536 -or
    (($RequestFile.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
  ) {
    Write-ReconciliationFailure -ResponsePath $responsePath -OperationId $OperationId -RequestId $requestId -Code 'RECONCILIATION_REQUEST_INVALID'
    return
  }

  try {
    $request = [System.IO.File]::ReadAllText($RequestFile.FullName) | ConvertFrom-Json -ErrorAction Stop
    if (
      [int]$request.schemaVersion -ne 1 -or
      [string]$request.operationId -ne $OperationId -or
      [string]$request.requestId -ne $requestId -or
      @('UXP', 'JAVASCRIPT') -notcontains [string]$request.language -or
      [int]$request.completionTimeoutMs -lt 1000 -or
      [int]$request.completionTimeoutMs -gt 900000 -or
      -not (Test-FullyQualifiedPath ([string]$request.scriptPath))
    ) {
      throw 'invalid-request'
    }
    if ($null -ne $request.mutationDispatch -and $request.mutationDispatch -isnot [bool]) { throw 'invalid-mutation-flag' }
    $script = Get-Item -LiteralPath ([string]$request.scriptPath) -Force -ErrorAction Stop
    if ($script.PSIsContainer -or (($script.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
      throw 'invalid-script'
    }
    $completionPath = [string]$request.completionPath
    if (-not [string]::IsNullOrWhiteSpace($completionPath)) {
      if ([string]$request.language -ne 'UXP' -or -not (Test-FullyQualifiedPath $completionPath)) {
        throw 'invalid-completion'
      }
      $completionParent = Get-Item -LiteralPath ([IO.Path]::GetDirectoryName($completionPath)) -Force -ErrorAction Stop
      if (-not $completionParent.PSIsContainer -or (($completionParent.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw 'invalid-completion-parent'
      }
      if (Test-Path -LiteralPath $completionPath) { throw 'completion-already-exists' }
    }
  }
  catch {
    Write-ReconciliationFailure -ResponsePath $responsePath -OperationId $OperationId -RequestId $requestId -Code 'RECONCILIATION_REQUEST_INVALID'
    return
  }

  try {
    Move-Item -LiteralPath $RequestFile.FullName -Destination $processingPath -ErrorAction Stop
  }
  catch {
    return
  }

  try {
    $application = Get-CompatibleInDesignApplication
    $languageId = if ([string]$request.language -eq 'UXP') { 1431522407 } else { 1246973031 }
    $payload = if ([string]$request.language -eq 'UXP') {
      [string]$request.scriptPath
    }
    else {
      [System.IO.File]::ReadAllText([string]$request.scriptPath)
    }
    if ([bool]$request.mutationDispatch) {
      $hostProcesses = @(Get-InDesignProcessSnapshot)
      if ($hostProcesses.Count -eq 0) { throw 'indesign-process-identity-missing' }
      Update-OperationRecord -Changes @{
        status = 'uxp-dispatched'
        uxpDispatchedAt = [DateTime]::UtcNow.ToString('o')
        hostProcessesAtDispatch = $hostProcesses
      }
    }
    $result = $application.DoScript($payload, $languageId)
    if (-not [string]::IsNullOrWhiteSpace($completionPath)) {
      $deadline = [DateTime]::UtcNow.AddMilliseconds([int]$request.completionTimeoutMs)
      $completed = $false
      do {
        if (Test-Path -LiteralPath $completionPath -PathType Leaf) {
          try {
            $rawCompletion = [System.IO.File]::ReadAllText($completionPath)
            if ($rawCompletion.Length -gt 0) {
              $null = $rawCompletion | ConvertFrom-Json -ErrorAction Stop
              $completed = $true
            }
          }
          catch {
            $completed = $false
          }
        }
        if (-not $completed) { Start-Sleep -Milliseconds 25 }
      } while (-not $completed -and [DateTime]::UtcNow -lt $deadline)
      if (-not $completed) { throw 'completion-timeout' }
      $quiescenceDeadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Min([int]$request.completionTimeoutMs, 30000))
      $modal = $true
      do {
        try { $modal = [bool]$application.ModalState }
        catch { $modal = $true }
        if ($modal) { Start-Sleep -Milliseconds 25 }
      } while ($modal -and [DateTime]::UtcNow -lt $quiescenceDeadline)
      if ($modal) { throw 'host-modal' }
    }
    if ([bool]$request.mutationDispatch) {
      Update-OperationRecord -Changes @{
        status = 'uxp-completed'
        uxpCompletedAt = [DateTime]::UtcNow.ToString('o')
      }
    }
    Write-AtomicJson -Path $responsePath -Value @{
      schemaVersion = 1
      operationId = $OperationId
      requestId = $requestId
      ok = $true
      result = $result
      completedAt = [DateTime]::UtcNow.ToString('o')
    }
    Remove-Item -LiteralPath $processingPath -Force -ErrorAction SilentlyContinue
  }
  catch {
    Write-ReconciliationFailure -ResponsePath $responsePath -OperationId $OperationId -RequestId $requestId -Code 'RECONCILIATION_DOSCRIPT_FAILED'
    # Le fichier processing reste la preuve que l'issue de cette sous-commande doit être contrôlée.
  }
}

function Invoke-PendingReconciliationRequests {
  param([Parameter(Mandatory = $true)][string]$OperationPath)
  $operationId = [IO.Path]::GetFileNameWithoutExtension($OperationPath)
  $directory = [IO.Path]::GetDirectoryName($OperationPath)
  $pattern = "$operationId.*.reconcile-request.json"
  foreach ($requestFile in Get-ChildItem -LiteralPath $directory -Filter $pattern -File -Force -ErrorAction SilentlyContinue) {
    Invoke-ReconciliationRequest -RequestFile $requestFile -OperationId $operationId
  }
}

try {
  if (-not (Test-FullyQualifiedPath $OperationPath)) {
    Write-Handshake @{ ok = $false; code = 'MUTEX_OPERATION_PATH_INVALID' }
    exit 2
  }
  $operation = Get-Item -LiteralPath $OperationPath -Force -ErrorAction Stop
  if (
    $operation.PSIsContainer -or
    (($operation.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
  ) {
    Write-Handshake @{ ok = $false; code = 'MUTEX_OPERATION_PATH_INVALID' }
    exit 2
  }
  $operationRecord = Read-OperationRecord -Path $OperationPath
  $ReleaseNonce = [string]$operationRecord.releaseNonce

  $stage = 'mutex-creation'
  $mutex = New-Object System.Threading.Mutex($false, $mutexName)

  if ($ExpectedGuardProcessId -gt 0) {
    $stage = 'guard-validation'
    if (-not (Test-ExpectedGuardProcess -ProcessId $ExpectedGuardProcessId)) {
      Write-Handshake @{ ok = $false; code = 'INDESIGN_MUTEX_GUARD_IDENTITY_INVALID'; mutex = $mutexName }
      exit 6
    }
    Update-OperationRecord -Changes @{
      recoveryWatcherProcessId = $PID
      recoveryWatcherAt = [DateTime]::UtcNow.ToString('o')
    }
    Write-Handshake @{
      ok = $true
      status = 'watching'
      mutex = $mutexName
      processId = $PID
      guardedProcessId = $ExpectedGuardProcessId
    }
    $handshakeWritten = $true
    $Recovery = $true
  }

  $stage = 'mutex-acquisition'
  $deadline = [DateTime]::UtcNow.AddMilliseconds($AcquireTimeoutMs)
  do {
    if (-not (Test-Path -LiteralPath $OperationPath)) { exit 0 }
    try {
      $mutexAcquired = $mutex.WaitOne([Math]::Min(100, $AcquireTimeoutMs))
    }
    catch [System.Threading.AbandonedMutexException] {
      $mutexAcquired = $true
      $abandoned = $true
    }
  } while (-not $mutexAcquired -and [DateTime]::UtcNow -lt $deadline)

  if ($abandoned -and -not $Recovery) {
    Update-OperationRecord -Changes @{ guardProcessId = $PID; guardStatus = 'abandoned'; guardedAt = [DateTime]::UtcNow.ToString('o') }
    Write-Handshake @{ ok = $true; status = 'abandoned'; mutex = $mutexName; processId = $PID }
    $handshakeWritten = $true
  }
  if (-not $mutexAcquired) {
    if (-not $handshakeWritten) {
      Write-Handshake @{ ok = $false; code = 'INDESIGN_MUTEX_BUSY'; mutex = $mutexName }
    }
    exit 4
  }

  if (-not $handshakeWritten) {
    Update-OperationRecord -Changes @{ guardProcessId = $PID; guardStatus = 'acquired'; guardedAt = [DateTime]::UtcNow.ToString('o') }
    Write-Handshake @{ ok = $true; status = 'acquired'; mutex = $mutexName; processId = $PID }
    $handshakeWritten = $true
  }
  elseif (-not $abandoned) {
    Write-Handshake @{ ok = $true; status = 'acquired'; mutex = $mutexName; processId = $PID }
  }

  $stage = 'retention'
  while ($true) {
    if (Test-ReleaseAcknowledgement -OperationPath $OperationPath -ReleaseNonce $ReleaseNonce) { break }
    $current = Get-Item -LiteralPath $OperationPath -Force -ErrorAction SilentlyContinue
    if (
      $null -eq $current -or
      $current.PSIsContainer -or
      (($current.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
    ) {
      # Une entree devenue illisible ou remplacee ne prouve pas une fin sure.
      Start-Sleep -Milliseconds 50
      continue
    }
    Invoke-PendingReconciliationRequests -OperationPath $OperationPath
    Start-Sleep -Milliseconds 25
  }
}
catch {
  if (-not $handshakeWritten) {
    Write-Handshake @{
      ok = $false
      code = 'INDESIGN_MUTEX_HELPER_FAILED'
      stage = $stage
      errorType = $_.Exception.GetType().Name
    }
  }
  exit 5
}
finally {
  if ($mutexAcquired) {
    try { $mutex.ReleaseMutex() } catch {}
  }
  if ($null -ne $mutex) { $mutex.Dispose() }
}

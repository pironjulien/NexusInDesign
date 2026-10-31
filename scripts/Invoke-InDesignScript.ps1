param(
  [Parameter(Mandatory = $true)][string]$ScriptPath,
  [Parameter(Mandatory = $true)][ValidateSet('UXP', 'JAVASCRIPT')][string]$Language,
  [string]$CompletionPath,
  [ValidateRange(1000, 900000)][int]$CompletionTimeoutMs = 120000,
  [ValidatePattern('^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')][string]$ExpectedLeaseOperationId,
  # Dossier d'exécution partagé (silent-runtime, plugin-runtime) ; transmis par le serveur MCP.
  [string]$RuntimeRoot
)

$ErrorActionPreference = 'Stop'
$lifecycleModule = Join-Path $PSScriptRoot 'InDesignComLifecycle.psm1'
Import-Module -Name $lifecycleModule -Force -ErrorAction Stop
$mutex = $null
$mutexAcquired = $false
$mutexAbandoned = $false
$application = $null
$hostResolution = $null
$hostDisposition = $null
$operationError = $null
$lifecycleError = $null
$outcomeKnown = $false
$result = $null
$mutexName = 'Local\NexusInDesignAutomation'
# Sans -RuntimeRoot (lancement manuel), runtime par défaut des installateurs, hors OneDrive :
# INDESIGN_MCP_PRIVATE_ROOT\runtime, soit ~\.nexus\indesign-mcp-secure\private\runtime.
if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
  $RuntimeRoot = Join-Path $HOME '.nexus\indesign-mcp-secure\private\runtime'
}
$durableLeasePath = if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
  $null
} else {
  Join-Path $RuntimeRoot 'silent-runtime\.mutation-lease.json'
}
$pluginOperationDirectory = if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
  $null
} else {
  Join-Path $RuntimeRoot 'plugin-runtime'
}

function Assert-NoDurableInDesignOperation {
  if ($durableLeasePath -and (Test-Path -LiteralPath $durableLeasePath -PathType Leaf)) {
    $leaseItem = Get-Item -LiteralPath $durableLeasePath -Force -ErrorAction Stop
    if ($leaseItem.Length -le 0 -or $leaseItem.Length -gt 4096 -or (($leaseItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
      throw 'Le lease durable InDesign est invalide; toute commande est interdite.'
    }
    try { $lease = [IO.File]::ReadAllText($leaseItem.FullName) | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'Le lease durable InDesign est illisible; toute commande est interdite.' }
    $expectedLease = -not [string]::IsNullOrWhiteSpace($ExpectedLeaseOperationId)
    if (
      -not $expectedLease -or
      [int]$lease.schemaVersion -ne 1 -or
      [string]$lease.kind -ne 'external' -or
      [string]$lease.operationId -ne $ExpectedLeaseOperationId
    ) {
      throw 'Une mutation InDesign est verrouillée par un lease durable; réconciliez-la avant toute nouvelle commande.'
    }
  }
  elseif (-not [string]::IsNullOrWhiteSpace($ExpectedLeaseOperationId)) {
    throw 'Le lease externe InDesign attendu est absent; toute commande est interdite.'
  }
  if ($pluginOperationDirectory -and (Test-Path -LiteralPath $pluginOperationDirectory -PathType Container)) {
    $pendingPluginOperation = Get-ChildItem -LiteralPath $pluginOperationDirectory -Filter '*.jsonl' -File -Force -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $pendingPluginOperation) {
      throw 'Une mutation InDesign du plugin reste indéterminée; réconciliez-la avant toute nouvelle commande.'
    }
  }
}

function Test-FullyQualifiedFilePath {
  param([string]$PathToTest)
  if ([string]::IsNullOrWhiteSpace($PathToTest)) { return $false }
  $uri = $null
  return [Uri]::TryCreate($PathToTest, [UriKind]::Absolute, [ref]$uri) -and $uri.IsAbsoluteUri -and $uri.IsFile
}

if (-not (Test-FullyQualifiedFilePath -PathToTest $ScriptPath)) {
  throw 'Le chemin du script InDesign doit etre absolu.'
}
if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
  throw 'Le script InDesign est introuvable.'
}
if ($CompletionPath -and -not (Test-FullyQualifiedFilePath -PathToTest $CompletionPath)) {
  throw 'Le chemin du résultat UXP doit etre absolu.'
}
if ($CompletionPath -and $Language -ne 'UXP') {
  throw 'Un résultat asynchrone est uniquement valide avec UXP.'
}
Assert-NoDurableInDesignOperation

try {
  $mutex = New-Object System.Threading.Mutex($false, $mutexName)
  try {
    $mutexAcquired = $mutex.WaitOne(120000)
  }
  catch [System.Threading.AbandonedMutexException] {
    $mutexAcquired = $true
    $mutexAbandoned = $true
  }
  if ($mutexAbandoned) {
    throw 'Le mutex commun InDesign a ete abandonne; la commande precedente doit etre verifiee avant de recommencer.'
  }
  if (-not $mutexAcquired) {
    throw 'Le délai de la file InDesign inter-processus est dépassé.'
  }
  # Ferme la fenêtre entre le premier contrôle et l’acquisition du mutex.
  Assert-NoDurableInDesignOperation
  # InDesign déjà lancé : sonde rapide pour tout l'appel ; sinon sonde complète (parents, DCOM) pour savoir si
  # l'appel COM a démarré l'hôte et doit le refermer.
  $hostProcessesBefore = @(Get-InDesignHostProcessesFast)
  $hostProbe = if ($hostProcessesBefore.Count -gt 0) { { @(Get-InDesignHostProcessesFast) } } else { { @(Get-InDesignHostProcesses) } }
  $languageId = if ($Language -eq 'UXP') { 1431522407 } else { 1246973031 }
  $lastComError = $null
  foreach ($progId in @('InDesign.Application.2026', 'InDesign.Application.2025', 'InDesign.Application.2024')) {
    try {
      $application = New-Object -ComObject $progId -ErrorAction Stop
      break
    }
    catch {
      $lastComError = $_
    }
  }
  if ($null -eq $application) {
    throw "Aucune version InDesign compatible (19 a 21) n'est enregistree pour COM. $($lastComError.Exception.Message)"
  }
  $hostProcessesAfter = @(& $hostProbe)
  $hostResolution = Resolve-InDesignComHost -Before $hostProcessesBefore -After $hostProcessesAfter -LauncherProcessId $PID
  $payload = if ($Language -eq 'UXP') { $ScriptPath } else { [System.IO.File]::ReadAllText($ScriptPath) }
  $result = $application.DoScript($payload, $languageId)
  if ($CompletionPath) {
    $deadline = [DateTime]::UtcNow.AddMilliseconds($CompletionTimeoutMs)
    $completed = $false
    do {
      if (Test-Path -LiteralPath $CompletionPath -PathType Leaf) {
        try {
          $rawCompletion = [System.IO.File]::ReadAllText($CompletionPath)
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
    if (-not $completed) {
      throw 'Le délai du résultat UXP asynchrone est dépassé; issue indéterminée.'
    }
    $quiescenceDeadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Min($CompletionTimeoutMs, 30000))
    $modal = $true
    do {
      try { $modal = [bool]$application.ModalState }
      catch { $modal = $true }
      if ($modal) { Start-Sleep -Milliseconds 25 }
    } while ($modal -and [DateTime]::UtcNow -lt $quiescenceDeadline)
    if ($modal) {
      throw 'InDesign reste en etat modal apres le résultat UXP; issue indeterminee.'
    }
  }
  $outcomeKnown = $true
}
catch {
  $operationError = $_
}
finally {
  try {
    if ($null -ne $application) {
      if ($null -eq $hostResolution) {
        $hostProcessesAfter = @(& $hostProbe)
        $hostResolution = Resolve-InDesignComHost -Before @($hostProcessesBefore) -After $hostProcessesAfter -LauncherProcessId $PID
      }
      $hostDisposition = Invoke-InDesignHostDisposition -Application $application -HostResolution $hostResolution -OutcomeKnown $outcomeKnown -SnapshotProvider $hostProbe
    }
  }
  catch {
    $lifecycleError = $_
  }
  finally {
    try { Remove-InDesignComReference -Application $application }
    catch { if ($null -eq $lifecycleError) { $lifecycleError = $_ } }
    if ($mutexAcquired) { $mutex.ReleaseMutex() }
    if ($null -ne $mutex) { $mutex.Dispose() }
  }
}

if ($null -ne $lifecycleError) {
  if ($null -ne $operationError) {
    $combined = [InvalidOperationException]::new("INDESIGN_OPERATION_AND_HOST_DISPOSITION_FAILED: l’opération et la disposition sûre de l’hôte doivent être vérifiées.", $operationError.Exception)
    $combined.Data['hostDispositionError'] = $lifecycleError.Exception.Message
    throw $combined
  }
  throw $lifecycleError
}
if ($null -ne $operationError) { throw $operationError }

[pscustomobject]@{
  ok = $true
  result = $result
  hostDisposition = if ($null -eq $hostDisposition) { $null } else { $hostDisposition.disposition }
} | ConvertTo-Json -Compress -Depth 20

Set-StrictMode -Version 3.0

function Get-InDesignProcessIdentityKey {
  param([Parameter(Mandatory = $true)][object]$Process)

  try {
    $processId = [int]$Process.ProcessId
    if ($processId -le 0) { return $null }
    $startedAt = ([datetime]$Process.StartedAt).ToUniversalTime().ToString('o')
    return "$processId|$startedAt"
  }
  catch {
    return $null
  }
}

function Get-InDesignHostProcesses {
  $dcomLaunchProcessId = 0
  try {
    $dcomLaunchService = Get-CimInstance Win32_Service -Filter "Name = 'DcomLaunch'" -ErrorAction Stop
    if ($null -ne $dcomLaunchService -and [string]$dcomLaunchService.State -eq 'Running') {
      $dcomLaunchProcessId = [int]$dcomLaunchService.ProcessId
    }
  }
  catch {
    # Sans preuve du service DCOM, la résolution restera volontairement non propriétaire.
    $dcomLaunchProcessId = 0
  }
  $items = @(Get-CimInstance Win32_Process -Filter "Name = 'InDesign.exe'" -ErrorAction Stop)
  foreach ($item in $items) {
    $created = $item.CreationDate
    if ($created -is [datetime]) {
      $startedAt = $created.ToUniversalTime().ToString('o')
    }
    else {
      try { $startedAt = [System.Management.ManagementDateTimeConverter]::ToDateTime([string]$created).ToUniversalTime().ToString('o') }
      catch { $startedAt = $null }
    }
    if (-not $startedAt -or [int]$item.ProcessId -le 0) {
      throw 'La sonde InDesign a renvoyé une identité de processus invalide.'
    }
    $desktopProcess = Get-Process -Id ([int]$item.ProcessId) -ErrorAction SilentlyContinue
    $mainWindowHandle = if ($null -eq $desktopProcess) { $null } else { [int64]$desktopProcess.MainWindowHandle }
    $parentProcessId = [int]$item.ParentProcessId
    $parentProcessName = $null
    if ($parentProcessId -gt 0) {
      try {
        $parentProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $parentProcessId" -ErrorAction Stop
        if ($null -ne $parentProcess) { $parentProcessName = [string]$parentProcess.Name }
      }
      catch {
        $parentProcessName = $null
      }
    }
    $parentIsDcomLaunch = (
      $dcomLaunchProcessId -gt 0 -and
      $parentProcessId -eq $dcomLaunchProcessId -and
      [string]::Equals($parentProcessName, 'svchost.exe', [StringComparison]::OrdinalIgnoreCase)
    )
    [pscustomobject]@{
      ProcessId = [int]$item.ProcessId
      ParentProcessId = $parentProcessId
      ParentProcessName = $parentProcessName
      ParentIsDcomLaunch = $parentIsDcomLaunch
      DcomLaunchProcessId = if ($parentIsDcomLaunch) { $dcomLaunchProcessId } else { 0 }
      StartedAt = $startedAt
      MainWindowHandle = $mainWindowHandle
    }
  }
}

# Identité rapide (Get-Process, sans CIM) : suffit quand InDesign tournait déjà avant l'appel COM, puisque le
# lanceur ne peut alors jamais être propriétaire de l'hôte. Ne pas mélanger avec Get-InDesignHostProcesses :
# les dates de démarrage des deux sondes n'ont pas la même précision.
function Get-InDesignHostProcessesFast {
  foreach ($item in @(Get-Process -Name InDesign -ErrorAction SilentlyContinue)) {
    try { $startedAt = $item.StartTime.ToUniversalTime().ToString('o') }
    catch { throw 'La sonde InDesign rapide a renvoyé une identité de processus invalide.' }
    [pscustomobject]@{
      ProcessId = [int]$item.Id
      ParentProcessId = 0
      ParentProcessName = $null
      ParentIsDcomLaunch = $false
      DcomLaunchProcessId = 0
      StartedAt = $startedAt
      MainWindowHandle = [int64]$item.MainWindowHandle
    }
  }
}

function Resolve-InDesignComHost {
  param(
    [object[]]$Before = @(),
    [object[]]$After = @(),
    [Parameter(Mandatory = $true)][int]$LauncherProcessId
  )

  $beforeIdentities = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  $beforeProcessIds = [System.Collections.Generic.HashSet[int]]::new()
  foreach ($candidate in @($Before)) {
    $identity = Get-InDesignProcessIdentityKey -Process $candidate
    if ($identity) {
      $null = $beforeIdentities.Add($identity)
      $null = $beforeProcessIds.Add([int]$candidate.ProcessId)
    }
  }

  $validAfter = @()
  $newCandidates = @()
  foreach ($candidate in @($After)) {
    $identity = Get-InDesignProcessIdentityKey -Process $candidate
    if (-not $identity) { continue }
    $entry = [pscustomobject]@{ Process = $candidate; Identity = $identity }
    $validAfter += $entry
    if (-not $beforeIdentities.Contains($identity)) { $newCandidates += $entry }
  }
  $ownedCandidates = @($newCandidates | Where-Object {
    $dcomEvidence = $_.Process.PSObject.Properties['ParentIsDcomLaunch']
    $dcomProcessIdEvidence = $_.Process.PSObject.Properties['DcomLaunchProcessId']
    $parentNameEvidence = $_.Process.PSObject.Properties['ParentProcessName']
    $isVerifiedDcomLaunch = (
      $null -ne $dcomEvidence -and
      [bool]$dcomEvidence.Value -and
      $null -ne $dcomProcessIdEvidence -and
      [int]$dcomProcessIdEvidence.Value -gt 0 -and
      [int]$_.Process.ParentProcessId -eq [int]$dcomProcessIdEvidence.Value -and
      $null -ne $parentNameEvidence -and
      [string]::Equals([string]$parentNameEvidence.Value, 'svchost.exe', [StringComparison]::OrdinalIgnoreCase)
    )
    [int]$_.Process.ParentProcessId -eq $LauncherProcessId -or
      $isVerifiedDcomLaunch
  })
  $owned = (
    $beforeIdentities.Count -eq 0 -and
    $newCandidates.Count -eq 1 -and
    $ownedCandidates.Count -eq 1 -and
    -not $beforeProcessIds.Contains([int]$ownedCandidates[0].Process.ProcessId)
  )
  $target = $null
  if ($owned) {
    $target = $ownedCandidates[0]
  }
  elseif ($newCandidates.Count -eq 1) {
    $target = $newCandidates[0]
  }
  elseif ($validAfter.Count -eq 1) {
    $target = $validAfter[0]
  }

  [pscustomobject]@{
    Owned = $owned
    OwnershipAmbiguous = (-not $owned -and ($newCandidates.Count -gt 0 -or $validAfter.Count -ne 1))
    TargetIdentity = if ($null -eq $target) { $null } else { $target.Identity }
    TargetProcessId = if ($null -eq $target) { $null } else { [int]$target.Process.ProcessId }
    ObservedProcesses = @($validAfter | ForEach-Object { $_.Process })
    BaselineProcesses = @($Before)
    LauncherProcessId = $LauncherProcessId
  }
}

function Select-InDesignHostDisposition {
  param(
    [Parameter(Mandatory = $true)][bool]$Owned,
    [Parameter(Mandatory = $true)][bool]$OutcomeKnown,
    [object]$DocumentCount,
    [Parameter(Mandatory = $true)][bool]$ModalStateKnown,
    [Parameter(Mandatory = $true)][bool]$ModalState,
    [Parameter(Mandatory = $true)][bool]$VisibilityKnown,
    [Parameter(Mandatory = $true)][bool]$Visible
  )

  $documentCountKnown = $null -ne $DocumentCount -and $DocumentCount -is [ValueType]
  if (
    $Owned -and
    $OutcomeKnown -and
    $documentCountKnown -and
    [int]$DocumentCount -eq 0 -and
    $ModalStateKnown -and
    -not $ModalState -and
    $VisibilityKnown -and
    -not $Visible
  ) {
    return 'quit'
  }
  if ($VisibilityKnown -and $Visible) { return 'preserve-visible' }
  return 'activate'
}

function Get-InDesignApplicationState {
  param([Parameter(Mandatory = $true)][object]$Application)

  $documentsReference = $null
  $documentCount = $null
  try {
    $documentsReference = $Application.Documents
    $documentCount = [int]$documentsReference.Count
  }
  catch {
    $documentCount = $null
  }
  finally {
    if ($null -ne $documentsReference -and [Runtime.InteropServices.Marshal]::IsComObject($documentsReference)) {
      $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($documentsReference)
    }
  }

  $modalState = $true
  $modalStateKnown = $false
  try {
    $modalState = [bool]$Application.ModalState
    $modalStateKnown = $true
  }
  catch {
    $modalState = $true
  }
  return [pscustomobject]@{
    DocumentCount = $documentCount
    ModalState = $modalState
    ModalStateKnown = $modalStateKnown
  }
}

function Find-InDesignProcessByIdentity {
  param([object[]]$Processes, [string]$Identity)
  if ([string]::IsNullOrWhiteSpace($Identity)) { return $null }
  foreach ($candidate in @($Processes)) {
    if ((Get-InDesignProcessIdentityKey -Process $candidate) -eq $Identity) { return $candidate }
  }
  return $null
}

function New-InDesignLifecycleException {
  param([string]$Code, [string]$Message, [Exception]$InnerException)
  $fullMessage = "$Code`: $Message"
  $exception = if ($null -eq $InnerException) {
    [InvalidOperationException]::new($fullMessage)
  } else {
    [InvalidOperationException]::new($fullMessage, $InnerException)
  }
  $exception.Data['errorCode'] = $Code
  return $exception
}

function Invoke-InDesignHostSnapshot {
  param([Parameter(Mandatory = $true)][scriptblock]$SnapshotProvider)
  try {
    return @(& $SnapshotProvider)
  }
  catch {
    throw (New-InDesignLifecycleException -Code 'INDESIGN_HOST_PROCESS_PROBE_FAILED' -Message "L’identité du processus InDesign n’a pas pu être vérifiée; aucune fermeture n’a été supposée." -InnerException $_.Exception)
  }
}

function Invoke-InDesignHostDisposition {
  param(
    [Parameter(Mandatory = $true)][object]$Application,
    [Parameter(Mandatory = $true)][object]$HostResolution,
    [Parameter(Mandatory = $true)][bool]$OutcomeKnown,
    [ValidateRange(100, 60000)][int]$TimeoutMs = 10000,
    [ValidateRange(1, 1000)][int]$PollIntervalMs = 50,
    [scriptblock]$SnapshotProvider = { @(Get-InDesignHostProcesses) },
    [scriptblock]$ActivateAction = { param($TargetApplication) $TargetApplication.Activate() },
    [scriptblock]$QuitAction = { param($TargetApplication) $TargetApplication.Quit() },
    [scriptblock]$SleepAction = { param($Milliseconds) Start-Sleep -Milliseconds $Milliseconds }
  )

  $applicationState = Get-InDesignApplicationState -Application $Application

  $currentProcesses = @(Invoke-InDesignHostSnapshot -SnapshotProvider $SnapshotProvider)
  $initialTargetIdentity = [string]$HostResolution.TargetIdentity
  if ([string]::IsNullOrWhiteSpace($initialTargetIdentity) -or [bool]$HostResolution.OwnershipAmbiguous) {
    $initialObservedProcesses = @($HostResolution.ObservedProcesses)
    $historicallyAmbiguous = [bool]$HostResolution.OwnershipAmbiguous -and $initialObservedProcesses.Count -gt 0
    $baselineProperty = $HostResolution.PSObject.Properties['BaselineProcesses']
    $launcherProperty = $HostResolution.PSObject.Properties['LauncherProcessId']
    if ($null -ne $baselineProperty -and $null -ne $launcherProperty -and [int]$launcherProperty.Value -gt 0) {
      $HostResolution = Resolve-InDesignComHost `
        -Before @($baselineProperty.Value) `
        -After $currentProcesses `
        -LauncherProcessId ([int]$launcherProperty.Value)
      if ($historicallyAmbiguous) {
        $HostResolution.Owned = $false
        $HostResolution.OwnershipAmbiguous = $true
      }
    }
  }
  $targetIdentity = [string]$HostResolution.TargetIdentity
  $targetProcess = Find-InDesignProcessByIdentity -Processes $currentProcesses -Identity $targetIdentity
  $targetHandle = if ($null -ne $targetProcess -and $null -ne $targetProcess.MainWindowHandle) { [int64]$targetProcess.MainWindowHandle } else { $null }
  $visibilityKnown = $null -ne $targetHandle
  $visible = $visibilityKnown -and $targetHandle -ne 0
  if ([string]::IsNullOrWhiteSpace($targetIdentity) -and $currentProcesses.Count -gt 0) {
    $unknownHandles = @($currentProcesses | Where-Object { $null -eq $_.MainWindowHandle })
    $visibilityKnown = $unknownHandles.Count -eq 0
    $visible = $visibilityKnown -and @($currentProcesses | Where-Object { [int64]$_.MainWindowHandle -eq 0 }).Count -eq 0
  }

  $decision = Select-InDesignHostDisposition `
    -Owned ([bool]$HostResolution.Owned) `
    -OutcomeKnown $OutcomeKnown `
    -DocumentCount $applicationState.DocumentCount `
    -ModalStateKnown $applicationState.ModalStateKnown `
    -ModalState $applicationState.ModalState `
    -VisibilityKnown $visibilityKnown `
    -Visible $visible

  if ($decision -eq 'preserve-visible') {
    return [pscustomobject]@{
      disposition = 'preserved-visible'
      owned = [bool]$HostResolution.Owned
      ownershipAmbiguous = [bool]$HostResolution.OwnershipAmbiguous
      processId = $HostResolution.TargetProcessId
    }
  }

  if ($decision -eq 'quit') {
    $currentProcesses = @(Invoke-InDesignHostSnapshot -SnapshotProvider $SnapshotProvider)
    $targetProcess = Find-InDesignProcessByIdentity -Processes $currentProcesses -Identity $targetIdentity
    if ($null -eq $targetProcess) {
      return [pscustomobject]@{
        disposition = 'already-exited'
        owned = $true
        ownershipAmbiguous = $false
        processId = $HostResolution.TargetProcessId
      }
    }
    if ($null -eq $targetProcess.MainWindowHandle) {
      $decision = 'activate'
    }
    elseif ([int64]$targetProcess.MainWindowHandle -ne 0) {
      return [pscustomobject]@{
        disposition = 'preserved-visible'
        owned = $true
        ownershipAmbiguous = $false
        processId = $HostResolution.TargetProcessId
      }
    }
    $finalApplicationState = Get-InDesignApplicationState -Application $Application
    if (
      $null -eq $finalApplicationState.DocumentCount -or
      [int]$finalApplicationState.DocumentCount -ne 0 -or
      -not $finalApplicationState.ModalStateKnown -or
      $finalApplicationState.ModalState
    ) {
      $decision = 'activate'
    }
  }

  if ($decision -eq 'quit') {
    try { $null = & $QuitAction $Application }
    catch { throw (New-InDesignLifecycleException -Code 'INDESIGN_HOST_QUIT_FAILED' -Message "InDesign n’a pas accepté la fermeture de son hôte COM." -InnerException $_.Exception) }
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    do {
      $currentProcesses = @(Invoke-InDesignHostSnapshot -SnapshotProvider $SnapshotProvider)
      if ($null -eq (Find-InDesignProcessByIdentity -Processes $currentProcesses -Identity $targetIdentity)) {
        return [pscustomobject]@{
          disposition = 'quit-confirmed'
          owned = $true
          ownershipAmbiguous = $false
          processId = $HostResolution.TargetProcessId
        }
      }
      $null = & $SleepAction $PollIntervalMs
    } while ([DateTime]::UtcNow -lt $deadline)
    throw (New-InDesignLifecycleException -Code 'INDESIGN_HOST_EXIT_UNCONFIRMED' -Message "Le processus InDesign créé par le launcher reste actif; aucune terminaison forcée n’a été tentée." -InnerException $null)
  }

  $hiddenIdentities = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  foreach ($candidate in @($HostResolution.ObservedProcesses)) {
    $identity = Get-InDesignProcessIdentityKey -Process $candidate
    if ($identity -and [int64]$candidate.MainWindowHandle -eq 0) { $null = $hiddenIdentities.Add($identity) }
  }
  try { $null = & $ActivateAction $Application }
  catch { throw (New-InDesignLifecycleException -Code 'INDESIGN_HOST_ACTIVATION_FAILED' -Message "InDesign n’a pas accepté son activation visible." -InnerException $_.Exception) }
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  do {
    $currentProcesses = @(Invoke-InDesignHostSnapshot -SnapshotProvider $SnapshotProvider)
    if (-not [string]::IsNullOrWhiteSpace($targetIdentity)) {
      $targetProcess = Find-InDesignProcessByIdentity -Processes $currentProcesses -Identity $targetIdentity
      if ($null -ne $targetProcess -and [int64]$targetProcess.MainWindowHandle -ne 0) {
        return [pscustomobject]@{
          disposition = 'activated-visible'
          owned = [bool]$HostResolution.Owned
          ownershipAmbiguous = [bool]$HostResolution.OwnershipAmbiguous
          processId = $HostResolution.TargetProcessId
        }
      }
    }
    else {
      foreach ($candidate in $currentProcesses) {
        $identity = Get-InDesignProcessIdentityKey -Process $candidate
        if ($identity -and $hiddenIdentities.Contains($identity) -and [int64]$candidate.MainWindowHandle -ne 0) {
          return [pscustomobject]@{
            disposition = 'activated-visible'
            owned = $false
            ownershipAmbiguous = $true
            processId = [int]$candidate.ProcessId
          }
        }
      }
    }
    $null = & $SleepAction $PollIntervalMs
  } while ([DateTime]::UtcNow -lt $deadline)
  throw (New-InDesignLifecycleException -Code 'INDESIGN_HOST_VISIBILITY_UNCONFIRMED' -Message "L’hôte InDesign reste sans fenêtre confirmée; aucun processus ambigu n’a été arrêté." -InnerException $null)
}

function Remove-InDesignComReference {
  param([object]$Application)
  if ($null -ne $Application -and [Runtime.InteropServices.Marshal]::IsComObject($Application)) {
    $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($Application)
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
  [GC]::Collect()
}

Export-ModuleMember -Function @(
  'Get-InDesignHostProcessesFast',
  'Get-InDesignHostProcesses',
  'Get-InDesignProcessIdentityKey',
  'Resolve-InDesignComHost',
  'Select-InDesignHostDisposition',
  'Invoke-InDesignHostDisposition',
  'Remove-InDesignComReference'
)

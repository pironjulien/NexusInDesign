import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const modulePath = path.resolve('scripts', 'InDesignComLifecycle.psm1');
const launcherPath = path.resolve('scripts', 'Invoke-InDesignScript.ps1');

function encodedPowerShell(source) {
  return Buffer.from(source, 'utf16le').toString('base64');
}

async function runHarness() {
  const source = String.raw`
$ErrorActionPreference = 'Stop'
Import-Module -Name $env:INDESIGN_LIFECYCLE_MODULE -Force -ErrorAction Stop

function New-ProcessState([int]$Id, [int]$ParentId, [string]$StartedAt, [long]$Handle, [bool]$DcomLaunch = $false) {
  [pscustomobject]@{
    ProcessId=$Id
    ParentProcessId=$ParentId
    ParentProcessName=if ($DcomLaunch) { 'svchost.exe' } else { 'powershell.exe' }
    ParentIsDcomLaunch=$DcomLaunch
    DcomLaunchProcessId=if ($DcomLaunch) { $ParentId } else { 0 }
    StartedAt=$StartedAt
    MainWindowHandle=$Handle
  }
}
function New-UnknownVisibilityProcessState([int]$Id, [int]$ParentId, [string]$StartedAt, [bool]$DcomLaunch = $false) {
  [pscustomobject]@{
    ProcessId=$Id
    ParentProcessId=$ParentId
    ParentProcessName=if ($DcomLaunch) { 'svchost.exe' } else { 'powershell.exe' }
    ParentIsDcomLaunch=$DcomLaunch
    DcomLaunchProcessId=if ($DcomLaunch) { $ParentId } else { 0 }
    StartedAt=$StartedAt
    MainWindowHandle=$null
  }
}
function New-FakeApplication([int]$Documents, [bool]$Modal) {
  $application = [pscustomobject]@{ Documents=[pscustomobject]@{ Count=$Documents }; ModalState=$Modal; QuitCalls=0; ActivateCalls=0 }
  $application | Add-Member -MemberType ScriptMethod -Name Quit -Value { $this.QuitCalls += 1 }
  $application | Add-Member -MemberType ScriptMethod -Name Activate -Value { $this.ActivateCalls += 1 }
  return $application
}
function Invoke-Scenario([string]$Name, [object[]]$Before, [object[]]$After, [bool]$OutcomeKnown, [int]$Documents, [bool]$Modal, [object[]]$Confirmation, [bool]$ExpectError, [bool]$FailConfirmationProbe = $false) {
  $application = New-FakeApplication -Documents $Documents -Modal $Modal
  $resolution = Resolve-InDesignComHost -Before $Before -After $After -LauncherProcessId 900
  $queue = [System.Collections.Queue]::new()
  $queue.Enqueue([pscustomobject]@{ Items=@($After) })
  if ($resolution.Owned -and $OutcomeKnown -and $Documents -eq 0 -and -not $Modal) {
    $queue.Enqueue([pscustomobject]@{ Items=@($After) })
  }
  $queue.Enqueue([pscustomobject]@{ Items=@($Confirmation) })
  $providerState = [pscustomobject]@{ Calls = 0 }
  $provider = {
    $providerState.Calls += 1
    if ($FailConfirmationProbe -and $providerState.Calls -ge 3) { throw 'sonde CIM indisponible' }
    if ($queue.Count -gt 1) { return @($queue.Dequeue().Items) }
    if ($queue.Count -eq 1) { return @($queue.Peek().Items) }
    return @()
  }.GetNewClosure()
  $errorCode = $null
  $disposition = $null
  try {
    $result = Invoke-InDesignHostDisposition -Application $application -HostResolution $resolution -OutcomeKnown $OutcomeKnown -TimeoutMs 100 -PollIntervalMs 1 -SnapshotProvider $provider -SleepAction { param($Milliseconds) }
    $disposition = $result.disposition
  }
  catch {
    $errorCode = [string]$_.Exception.Data['errorCode']
    if (-not $ExpectError) { throw }
  }
  [pscustomobject]@{
    name=$Name
    owned=$resolution.Owned
    ambiguous=$resolution.OwnershipAmbiguous
    disposition=$disposition
    quitCalls=$application.QuitCalls
    activateCalls=$application.ActivateCalls
    errorCode=$errorCode
  }
}

function Invoke-RefreshScenario([string]$Name, [object[]]$InitialAfter, [object]$FreshHidden, [object]$FreshVisible, [bool]$CanBecomeOwned) {
  $application = New-FakeApplication -Documents 0 -Modal $false
  $initialResolution = Resolve-InDesignComHost -Before @() -After $InitialAfter -LauncherProcessId 900
  $queue = [System.Collections.Queue]::new()
  $queue.Enqueue([pscustomobject]@{ Items=@($FreshHidden) })
  if ($CanBecomeOwned) {
    $queue.Enqueue([pscustomobject]@{ Items=@($FreshHidden) })
    $queue.Enqueue([pscustomobject]@{ Items=@() })
  }
  else {
    $queue.Enqueue([pscustomobject]@{ Items=@($FreshVisible) })
  }
  $provider = {
    if ($queue.Count -gt 1) { return @($queue.Dequeue().Items) }
    return @($queue.Peek().Items)
  }.GetNewClosure()
  $result = Invoke-InDesignHostDisposition -Application $application -HostResolution $initialResolution -OutcomeKnown $true -TimeoutMs 100 -PollIntervalMs 1 -SnapshotProvider $provider -SleepAction { param($Milliseconds) }
  [pscustomobject]@{
    name=$Name
    initialTarget=$initialResolution.TargetIdentity
    initialAmbiguous=$initialResolution.OwnershipAmbiguous
    disposition=$result.disposition
    owned=$result.owned
    quitCalls=$application.QuitCalls
    activateCalls=$application.ActivateCalls
  }
}

$old = '2026-07-17T08:00:00.000Z'
$new = '2026-07-17T09:00:00.000Z'
$visible = New-ProcessState 10 1 $old 100
$hidden = New-ProcessState 10 1 $old 0
$ownedHidden = New-ProcessState 20 1352 $new 0 $true
$ownedVisible = New-ProcessState 20 1352 $new 200 $true
$ownedUnknown = New-UnknownVisibilityProcessState 20 1352 $new $true
$directOwnedHidden = New-ProcessState 21 900 $new 0
$ambiguousA = New-ProcessState 30 1352 $new 0 $true
$ambiguousB = New-ProcessState 31 1352 $new 0 $true
$unrelated = New-ProcessState 32 901 $new 0
$reusedBefore = New-ProcessState 40 1 $old 100
$reusedAfter = New-ProcessState 40 1352 $new 0 $true
$reusedVisible = New-ProcessState 40 1352 $new 400 $true
$mismatchedDcom = New-ProcessState 50 1353 $new 0 $true
$mismatchedDcom.DcomLaunchProcessId = 1352
$mismatchedDcomVisible = New-ProcessState 50 1353 $new 500 $true
$mismatchedDcomVisible.DcomLaunchProcessId = 1352

$results = @(
  Invoke-Scenario 'owned-empty' @() @($ownedHidden) $true 0 $false @() $false
  Invoke-Scenario 'direct-owned-empty' @() @($directOwnedHidden) $true 0 $false @() $false
  Invoke-Scenario 'owned-document' @() @($ownedHidden) $true 1 $false @($ownedVisible) $false
  Invoke-Scenario 'owned-unknown' @() @($ownedHidden) $false 0 $false @($ownedVisible) $false
  Invoke-Scenario 'owned-modal' @() @($ownedHidden) $true 0 $true @($ownedVisible) $false
  Invoke-Scenario 'owned-visible-empty' @() @($ownedVisible) $true 0 $false @() $false
  Invoke-Scenario 'existing-visible' @($visible) @($visible) $true 0 $false @() $false
  Invoke-Scenario 'existing-hidden' @($hidden) @($hidden) $true 0 $false @($visible) $false
  Invoke-Scenario 'preexisting-plus-child' @($visible) @($visible,$ownedHidden) $true 0 $false @($visible,$ownedVisible) $false
  Invoke-Scenario 'owned-visibility-unknown' @() @($ownedUnknown) $true 0 $false @($ownedVisible) $false
  Invoke-Scenario 'ambiguous' @() @($ambiguousA,$ambiguousB) $true 0 $false @($ambiguousA,$ambiguousB) $true
  Invoke-Scenario 'ambiguous-mixed' @() @($ownedHidden,$unrelated) $true 0 $false @($ownedHidden,$unrelated) $true
  Invoke-Scenario 'reused-pid' @($reusedBefore) @($reusedAfter) $true 0 $false @($reusedVisible) $false
  Invoke-Scenario 'mismatched-dcom-evidence' @() @($mismatchedDcom) $true 0 $false @($mismatchedDcomVisible) $false
  Invoke-Scenario 'quit-unconfirmed' @() @($ownedHidden) $true 0 $false @($ownedHidden) $true
  Invoke-Scenario 'quit-probe-failed' @() @($ownedHidden) $true 0 $false @() $true $true
  Invoke-Scenario 'visible-unconfirmed' @() @($ownedHidden) $true 1 $false @($ownedHidden) $true
  Invoke-RefreshScenario 'delayed-dcom-discovery' @() $ownedHidden $ownedVisible $true
  Invoke-RefreshScenario 'ambiguous-then-unique-dcom' @($ownedHidden,$unrelated) $ownedHidden $ownedVisible $false
)
$results | ConvertTo-Json -Compress -Depth 8
`;
  const { stdout } = await execFileAsync('pwsh.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encodedPowerShell(source),
  ], {
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, INDESIGN_LIFECYCLE_MODULE: modulePath },
  });
  return JSON.parse(stdout.trim());
}

test('la politique COM quitte uniquement son hôte vide et active les hôtes cachés', {
  skip: process.platform !== 'win32',
}, async () => {
  const results = Object.fromEntries((await runHarness()).map((entry) => [entry.name, entry]));
  assert.deepEqual(results['owned-empty'], {
    name: 'owned-empty', owned: true, ambiguous: false, disposition: 'quit-confirmed', quitCalls: 1, activateCalls: 0, errorCode: null,
  });
  assert.equal(results['direct-owned-empty'].owned, true);
  assert.equal(results['direct-owned-empty'].disposition, 'quit-confirmed');
  for (const name of ['owned-document', 'owned-unknown', 'owned-modal']) {
    assert.equal(results[name].disposition, 'activated-visible');
    assert.equal(results[name].quitCalls, 0);
    assert.equal(results[name].activateCalls, 1);
  }
  assert.equal(results['existing-visible'].disposition, 'preserved-visible');
  assert.equal(results['existing-visible'].quitCalls, 0);
  assert.equal(results['existing-visible'].activateCalls, 0);
  assert.equal(results['existing-hidden'].disposition, 'activated-visible');
  assert.equal(results['existing-hidden'].quitCalls, 0);
  assert.equal(results['existing-hidden'].activateCalls, 1);
  assert.equal(results['preexisting-plus-child'].owned, false);
  assert.equal(results['preexisting-plus-child'].quitCalls, 0);
  assert.equal(results['preexisting-plus-child'].disposition, 'activated-visible');
  assert.equal(results['owned-visibility-unknown'].owned, true);
  assert.equal(results['owned-visibility-unknown'].quitCalls, 0);
  assert.equal(results['owned-visibility-unknown'].disposition, 'activated-visible');
  assert.equal(results['owned-visible-empty'].owned, true);
  assert.equal(results['owned-visible-empty'].disposition, 'preserved-visible');
  assert.equal(results['owned-visible-empty'].quitCalls, 0);
  assert.equal(results['delayed-dcom-discovery'].initialAmbiguous, true);
  assert.equal(results['delayed-dcom-discovery'].owned, true);
  assert.equal(results['delayed-dcom-discovery'].disposition, 'quit-confirmed');
  assert.equal(results['delayed-dcom-discovery'].quitCalls, 1);
  assert.equal(results['delayed-dcom-discovery'].activateCalls, 0);
  assert.equal(results['delayed-dcom-discovery'].initialTarget, null);
  assert.equal(results['ambiguous-then-unique-dcom'].initialAmbiguous, true);
  assert.equal(results['ambiguous-then-unique-dcom'].owned, false);
  assert.equal(results['ambiguous-then-unique-dcom'].disposition, 'activated-visible');
  assert.equal(results['ambiguous-then-unique-dcom'].quitCalls, 0);
  assert.equal(results['ambiguous-then-unique-dcom'].activateCalls, 1);
});

test('une identité ambiguë ou non confirmée ne déclenche jamais de terminaison forcée', {
  skip: process.platform !== 'win32',
}, async () => {
  const results = Object.fromEntries((await runHarness()).map((entry) => [entry.name, entry]));
  assert.equal(results.ambiguous.owned, false);
  assert.equal(results.ambiguous.ambiguous, true);
  assert.equal(results.ambiguous.quitCalls, 0);
  assert.equal(results.ambiguous.errorCode, 'INDESIGN_HOST_VISIBILITY_UNCONFIRMED');
  assert.equal(results['ambiguous-mixed'].owned, false);
  assert.equal(results['ambiguous-mixed'].ambiguous, true);
  assert.equal(results['ambiguous-mixed'].quitCalls, 0);
  assert.equal(results['reused-pid'].owned, false);
  assert.equal(results['reused-pid'].ambiguous, true);
  assert.equal(results['reused-pid'].quitCalls, 0);
  assert.equal(results['reused-pid'].disposition, 'activated-visible');
  assert.equal(results['mismatched-dcom-evidence'].owned, false);
  assert.equal(results['mismatched-dcom-evidence'].quitCalls, 0);
  assert.equal(results['mismatched-dcom-evidence'].disposition, 'activated-visible');
  assert.equal(results['quit-unconfirmed'].quitCalls, 1);
  assert.equal(results['quit-unconfirmed'].errorCode, 'INDESIGN_HOST_EXIT_UNCONFIRMED');
  assert.equal(results['quit-probe-failed'].quitCalls, 1);
  assert.equal(results['quit-probe-failed'].errorCode, 'INDESIGN_HOST_PROCESS_PROBE_FAILED');
  assert.equal(results['visible-unconfirmed'].quitCalls, 0);
  assert.equal(results['visible-unconfirmed'].errorCode, 'INDESIGN_HOST_VISIBILITY_UNCONFIRMED');
});

test('le launcher câble la disposition avant le mutex sans terminaison aveugle', async () => {
  const [launcher, lifecycle] = await Promise.all([
    fs.readFile(launcherPath, 'utf8'),
    fs.readFile(modulePath, 'utf8'),
  ]);
  assert.match(launcher, /Join-Path \$PSScriptRoot 'InDesignComLifecycle\.psm1'/);
  const processProbeIndex = launcher.indexOf('Get-InDesignHostProcesses');
  const comCreationIndex = launcher.indexOf('New-Object -ComObject');
  const dispositionIndex = launcher.indexOf('Invoke-InDesignHostDisposition');
  const releaseIndex = launcher.indexOf('$mutex.ReleaseMutex()');
  const releaseComIndex = launcher.indexOf('Remove-InDesignComReference');
  for (const index of [processProbeIndex, comCreationIndex, dispositionIndex, releaseIndex, releaseComIndex]) assert.ok(index >= 0);
  assert.ok(processProbeIndex < comCreationIndex);
  assert.ok(dispositionIndex < releaseIndex);
  assert.ok(releaseComIndex < releaseIndex);
  assert.equal(/Stop-Process|\.Kill\(/.test(`${launcher}\n${lifecycle}`), false);
  assert.equal(launcher.includes('IsPathFullyQualified'), false);
  assert.match(lifecycle, /Win32_Service -Filter "Name = 'DcomLaunch'"/);
  assert.match(lifecycle, /ParentIsDcomLaunch/);
});

test('la validation des chemins fonctionne sous PowerShell 7 et Windows PowerShell 5.1', {
  skip: process.platform !== 'win32',
}, async () => {
  const missingScript = path.resolve('tests', '__indesign_lifecycle_missing__.jsx');
  const executables = [
    'pwsh.exe',
    path.join(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ];
  for (const executable of executables) {
    await assert.rejects(execFileAsync(executable, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-File', launcherPath,
      '-ScriptPath', missingScript, '-Language', 'JAVASCRIPT',
    ], {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    }), (error) => {
      const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
      assert.match(output, /script InDesign est introuvable/i);
      assert.doesNotMatch(output, /IsPathFullyQualified|MethodNotFound/i);
      return true;
    });
  }
});

test('le launcher et son module passent le parseur PowerShell sans exécution', {
  skip: process.platform !== 'win32',
}, async () => {
  const source = String.raw`
$ErrorActionPreference = 'Stop'
$failed = @()
foreach ($file in @($env:INDESIGN_LAUNCHER, $env:INDESIGN_LIFECYCLE_MODULE)) {
  $tokens = $null
  $errors = $null
  $null = [System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
  if ($errors.Count -gt 0) { $failed += @($errors | ForEach-Object { $_.Message }) }
}
if ($failed.Count -gt 0) { throw ($failed -join ' | ') }
'ok'
`;
  const { stdout } = await execFileAsync('pwsh.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(source),
  ], {
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    env: {
      ...process.env,
      INDESIGN_LAUNCHER: launcherPath,
      INDESIGN_LIFECYCLE_MODULE: modulePath,
    },
  });
  assert.equal(stdout.trim(), 'ok');
});

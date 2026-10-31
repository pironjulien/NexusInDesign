[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory)][string]$TargetPath,
    [ValidateSet('Auto', 'Directory', 'File')][string]$Kind = 'Auto',
    [switch]$Recursive,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$resolved = Resolve-Path -LiteralPath $TargetPath -ErrorAction Stop
$target = $resolved.Path
$item = Get-Item -LiteralPath $target -Force
if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    # Un contrôle non récursif peut lire la DACL d'un placeholder OneDrive.
    # Aucune modification de DACL, aucun lien arbitraire et aucun parcours permis.
    $cloudPlaceholder = $false
    if ($CheckOnly -and -not $Recursive -and -not $item.LinkType) {
        $metadata = (& fsutil.exe reparsepoint query $target 2>$null) -join "`n"
        $tag = [regex]::Match($metadata, '0x([0-9a-fA-F]{8})')
        if ($LASTEXITCODE -eq 0 -and $tag.Success) {
            $value = [Convert]::ToUInt32($tag.Groups[1].Value, 16)
            $cloudPlaceholder = ($value -band ([Convert]::ToUInt32('ffff0fff', 16))) -eq [Convert]::ToUInt32('9000001a', 16)
        }
    }
    if (-not $cloudPlaceholder) { throw 'Une jonction ou un lien symbolique ne peut pas recevoir une ACL privee.' }
}

$isDirectory = $item.PSIsContainer
if ($Kind -eq 'Directory' -and -not $isDirectory) { throw 'La cible doit etre un dossier.' }
if ($Kind -eq 'File' -and $isDirectory) { throw 'La cible doit etre un fichier.' }
if ($Recursive -and -not $isDirectory) { throw 'Le mode recursif exige un dossier.' }

$children = @()
if ($Recursive) {
    # PowerShell ne suit pas les liens sans -FollowSymlink. La verification est
    # terminee avant la premiere modification de DACL.
    $children = @(Get-ChildItem -LiteralPath $target -Force -Recurse)
    if (@($children | Where-Object { $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint }).Count -gt 0) {
        throw 'Une jonction ou un lien symbolique est interdit dans une arborescence privee.'
    }
}

$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$allowedSids = @($currentSid.Value, $systemSid.Value)

function Set-PrivateDacl {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][bool]$Directory
    )

    # Seule la DACL est reconstruite. Le proprietaire et la SACL OneDrive ne
    # sont jamais reappliques, ce qui evite d'exiger SeSecurityPrivilege.
    if ($Directory) {
        $acl = [System.Security.AccessControl.DirectorySecurity]::new()
        $acl.SetAccessRuleProtection($true, $false)
        $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
        $propagation = [System.Security.AccessControl.PropagationFlags]::None
        [void]$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($currentSid, 'FullControl', $inheritance, $propagation, 'Allow'))
        [void]$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($systemSid, 'FullControl', $inheritance, $propagation, 'Allow'))
        [System.IO.FileSystemAclExtensions]::SetAccessControl([System.IO.DirectoryInfo]::new($Path), $acl)
        return
    }

    $acl = [System.Security.AccessControl.FileSecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    [void]$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($currentSid, 'FullControl', 'Allow'))
    [void]$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($systemSid, 'FullControl', 'Allow'))
    [System.IO.FileSystemAclExtensions]::SetAccessControl([System.IO.FileInfo]::new($Path), $acl)
}

function Test-PrivateDacl {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][bool]$Directory
    )

    $info = if ($Directory) { [System.IO.DirectoryInfo]::new($Path) } else { [System.IO.FileInfo]::new($Path) }
    $acl = [System.IO.FileSystemAclExtensions]::GetAccessControl(
        $info,
        [System.Security.AccessControl.AccessControlSections]::Access
    )
    $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    $badRules = @($rules | Where-Object {
        $allowedSids -notcontains $_.IdentityReference.Value -or $_.AccessControlType -ne 'Allow'
    })
    $fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
    $currentRules = @($rules | Where-Object {
        $_.IdentityReference.Value -eq $currentSid.Value -and
        $_.AccessControlType -eq 'Allow' -and
        ($_.FileSystemRights -band $fullControl) -eq $fullControl
    })
    $systemRules = @($rules | Where-Object {
        $_.IdentityReference.Value -eq $systemSid.Value -and
        $_.AccessControlType -eq 'Allow' -and
        ($_.FileSystemRights -band $fullControl) -eq $fullControl
    })
    return $acl.AreAccessRulesProtected -and $badRules.Count -eq 0 -and $currentRules.Count -gt 0 -and $systemRules.Count -gt 0
}

if (-not $CheckOnly -and -not $PSCmdlet.ShouldProcess($target, 'Remplacer la DACL par utilisateur courant + SYSTEM')) {
    return
}

if (-not $CheckOnly) {
    Set-PrivateDacl -Path $target -Directory $isDirectory
    foreach ($child in $children) {
        Set-PrivateDacl -Path $child.FullName -Directory $child.PSIsContainer
    }
}

$verified = 0
$targets = @($item) + $children
foreach ($candidate in $targets) {
    if (-not (Test-PrivateDacl -Path $candidate.FullName -Directory $candidate.PSIsContainer)) {
        throw "La DACL reste trop permissive : $($candidate.FullName)"
    }
    $verified++
}

[pscustomobject]@{
    protected = $true
    verifiedItems = $verified
    currentSid = $currentSid.Value
    systemSid = $systemSid.Value
}

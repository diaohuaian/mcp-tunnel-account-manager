<#
.SYNOPSIS
    Restricts NTFS ACLs on McpTunnelAccountManager data directory to current user and SYSTEM only.

.DESCRIPTION
    Disables access rule inheritance on %LOCALAPPDATA%/McpTunnelAccountManager (or a specified target directory),
    removes any existing rules, and grants FullControl exclusively to the executing user and NT AUTHORITY\SYSTEM.
    Recursively secures any pre-existing child containers and items.

.PARAMETER TargetDirectory
    Directory path to protect. Defaults to %LOCALAPPDATA%/McpTunnelAccountManager.
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0, Mandatory = $false)]
    [string]$TargetDirectory = $(
        if ($env:LOCALAPPDATA) {
            Join-Path $env:LOCALAPPDATA "McpTunnelAccountManager"
        } else {
            Join-Path $HOME "AppData\Local\McpTunnelAccountManager"
        }
    )
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$resolvedPath = [System.IO.Path]::GetFullPath($TargetDirectory)
Write-Host "[protect-data] Target directory: $resolvedPath"

if (-not (Test-Path -LiteralPath $resolvedPath)) {
    Write-Host "[protect-data] Creating directory: $resolvedPath"
    New-Item -ItemType Directory -Path $resolvedPath -Force | Out-Null
}

$currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = New-Object System.Security.Principal.SecurityIdentifier([System.Security.Principal.WellKnownSidType]::LocalSystemSid, $null)

# Access rules for directories (containers)
$dirUserRule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $currentUserSid,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
)

$dirSystemRule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $systemSid,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
)

# Access rules for files (leaf objects)
$fileUserRule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $currentUserSid,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.Security.AccessControl.InheritanceFlags]::None,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
)

$fileSystemRule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $systemSid,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.Security.AccessControl.InheritanceFlags]::None,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
)

# Configure target root directory
$rootAcl = Get-Acl -LiteralPath $resolvedPath
# Disable inheritance and purge inherited rules ($isProtected = $true, $preserveInheritance = $false)
$rootAcl.SetAccessRuleProtection($true, $false)

$existingRules = @($rootAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
foreach ($rule in $existingRules) {
    [void]$rootAcl.RemoveAccessRuleSpecific($rule)
}

$rootAcl.AddAccessRule($dirUserRule)
$rootAcl.AddAccessRule($dirSystemRule)
Set-Acl -LiteralPath $resolvedPath -AclObject $rootAcl

# Configure existing child items if any
Get-ChildItem -LiteralPath $resolvedPath -Recurse -Force | ForEach-Object {
    $childPath = $_.FullName
    $childAcl = Get-Acl -LiteralPath $childPath
    $childAcl.SetAccessRuleProtection($true, $false)

    $childExisting = @($childAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    foreach ($rule in $childExisting) {
        [void]$childAcl.RemoveAccessRuleSpecific($rule)
    }

    if ($_.PSIsContainer) {
        $childAcl.AddAccessRule($dirUserRule)
        $childAcl.AddAccessRule($dirSystemRule)
    } else {
        $childAcl.AddAccessRule($fileUserRule)
        $childAcl.AddAccessRule($fileSystemRule)
    }

    Set-Acl -LiteralPath $childPath -AclObject $childAcl
}

Write-Host "[protect-data] Successfully restricted ACLs on $resolvedPath to current user and SYSTEM only, with inheritance disabled."

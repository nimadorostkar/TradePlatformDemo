param(
  [Parameter(Mandatory = $true)]
  [string]$Config
)
$ErrorActionPreference = "Stop"

if (-not (Test-Path $Config)) { throw "$Config not found" }

# Secrets still need to exist on disk for a non-interactive SYSTEM task, but
# they should not live in an executable batch file or inherit broad directory
# permissions. Restrict the config to SYSTEM and local Administrators only.
$acl = New-Object System.Security.AccessControl.FileSecurity
$acl.SetAccessRuleProtection($true, $false)
$inheritance = [System.Security.AccessControl.InheritanceFlags]::None
$propagation = [System.Security.AccessControl.PropagationFlags]::None
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl

foreach ($identity in @("NT AUTHORITY\SYSTEM", "BUILTIN\Administrators")) {
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $identity, $fullControl, $inheritance, $propagation, $allow
  )
  $acl.AddAccessRule($rule)
}

Set-Acl -Path $Config -AclObject $acl

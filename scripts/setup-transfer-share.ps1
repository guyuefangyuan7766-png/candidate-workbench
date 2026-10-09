# Set up a read-only SMB share of this project so IT can copy it over the intranet.
# Must run elevated (Administrator). Idempotent: safe to re-run.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-transfer-share.ps1
#   ... -Remove        remove the share and firewall rules again (after the transfer)
[CmdletBinding()]
param(
  [string]$ShareName = 'talent-workbench',
  [string]$Path = 'D:\talent-asset-workbench',
  [string[]]$AllowRemote = @('192.168.8.12', '192.168.190.0/23'),
  [string]$LogPath = 'D:\talent-asset-workbench\data\deploy\share-setup.log',
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
function Write-Step([string]$text) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $text
  Write-Host $line
  try {
    $dir = Split-Path -Parent $LogPath
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
  } catch {}
}

try {

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'This script must run elevated (Administrator).' }

if ($Remove) {
  Write-Step "removing share $ShareName and firewall rules"
  if (Get-SmbShare -Name $ShareName -ErrorAction SilentlyContinue) { Remove-SmbShare -Name $ShareName -Force }
  Get-NetFirewallRule -DisplayName "Talent transfer *" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  Write-Step 'done'
  exit 0
}

if (-not (Test-Path -LiteralPath $Path)) { throw "path not found: $Path" }

# 1. share (read-only for Everyone at the share level)
if (-not (Get-SmbShare -Name $ShareName -ErrorAction SilentlyContinue)) {
  Write-Step "creating share $ShareName -> $Path"
  New-SmbShare -Name $ShareName -Path $Path -ReadAccess 'Everyone' -Description 'Talent asset workbench transfer (read-only)' | Out-Null
} else {
  Write-Step "share $ShareName already exists (leaving as-is)"
}

# 2. NTFS: grant read to Everyone so the share is actually readable over SMB
Write-Step 'granting NTFS read (Everyone)'
$acl = Get-Acl -LiteralPath $Path
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule('Everyone', 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.SetAccessRule($rule)
Set-Acl -LiteralPath $Path -AclObject $acl

# 3. firewall: SMB (445) + ICMP, scoped to the server and the local subnet
Write-Step ("allowing SMB/ICMP from: {0}" -f ($AllowRemote -join ', '))
if (-not (Get-NetFirewallRule -DisplayName 'Talent transfer SMB' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName 'Talent transfer SMB' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 445 `
    -RemoteAddress $AllowRemote -Profile Domain,Private -Description 'Read-only project transfer to IT' | Out-Null
}
if (-not (Get-NetFirewallRule -DisplayName 'Talent transfer ICMP' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName 'Talent transfer ICMP' -Direction Inbound -Action Allow -Protocol ICMPv4 `
    -RemoteAddress $AllowRemote -Profile Domain,Private -Description 'Ping test for the transfer' | Out-Null
}

Write-Step 'summary'
Get-SmbShare -Name $ShareName | Select-Object Name, Path, Description | Format-List
Get-SmbShareAccess -Name $ShareName | Select-Object AccountName, AccessRight, AccessControlType | Format-Table -AutoSize
Get-NetFirewallRule -DisplayName 'Talent transfer *' | Select-Object DisplayName, Enabled, Direction, Action | Format-Table -AutoSize

$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '192.168.*' } | Select-Object -First 1).IPAddress
Write-Host ''
Write-Host 'Use these paths from the server:'
Write-Host ("    \\{0}\{1}" -f $ip, $ShareName)
Write-Host ("    \\{0}\{1}" -f $env:COMPUTERNAME, $ShareName)
Write-Host ''
Write-Host 'Remove after the transfer:'
Write-Host ("    powershell -NoProfile -ExecutionPolicy Bypass -File '{0}\scripts\setup-transfer-share.ps1' -Remove" -f $Path)
} catch {
  Write-Step ("ERROR: {0}" -f $_.Exception.Message)
  Write-Step ("at: {0}" -f ($_.InvocationInfo?.PositionMessage -replace "`r?`n", ' | '))
  exit 1
}

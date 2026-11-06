#Requires -Version 5.1
param(
    [switch]$OpenAfterInstall,
    [string]$ShortcutDirectory = '',
    [string]$BackupDirectory = ''
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskEntry = Join-Path $PSScriptRoot 'open-portable-console.ps1'
if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'src\main.mjs') -PathType Leaf)) { throw 'Extract the complete release before creating a shortcut.' }
if (-not $ShortcutDirectory) { $ShortcutDirectory = [Environment]::GetFolderPath('DesktopDirectory') }
if (-not $BackupDirectory) { $BackupDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'McpTunnelAccountManager\shortcut-backups' }
$ShortcutDirectory = [IO.Path]::GetFullPath($ShortcutDirectory)
$BackupDirectory = [IO.Path]::GetFullPath($BackupDirectory)
$null = New-Item -ItemType Directory -Path $ShortcutDirectory -Force
$taskLink = Join-Path $ShortcutDirectory 'MCP 隧道账号控制台.lnk'
if (Test-Path -LiteralPath $taskLink -PathType Leaf) {
    $null = New-Item -ItemType Directory -Path $BackupDirectory -Force
    $taskBackup = Join-Path $BackupDirectory ('MCP-console-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-' + [guid]::NewGuid().ToString('N') + '.lnk')
    Copy-Item -LiteralPath $taskLink -Destination $taskBackup -ErrorAction Stop
    Write-Host ('Existing shortcut backed up to: ' + $taskBackup)
}
$taskShell = New-Object -ComObject WScript.Shell
try {
    $taskShortcut = $taskShell.CreateShortcut($taskLink)
    $taskShortcut.TargetPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $taskShortcut.Arguments = '-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $taskEntry + '"'
    $taskShortcut.WorkingDirectory = $taskRoot
    $taskShortcut.Description = 'Local MCP Tunnel Account Manager'
    $taskShortcut.WindowStyle = 7
    $taskShortcut.Save()
} finally { $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($taskShell) }
Write-Host ('Shortcut created: ' + $taskLink)
if ($OpenAfterInstall) { & $taskEntry }

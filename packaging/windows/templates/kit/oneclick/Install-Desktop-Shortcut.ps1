#Requires -Version 5.1
<#
  Creates (or refreshes) the desktop shortcut "MCP Tunnel 一键启动".

  The shortcut runs Start-McpTunnel-Console.ps1 from a stable per-user location
  (%LOCALAPPDATA%\McpTunnelAccountManager\launcher) and passes the deployment kit
  root, so the shortcut keeps working if the repository folder is moved or deleted.

  Usage, from the extracted deployment kit root:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\oneclick\Install-Desktop-Shortcut.ps1
  or from a repository checkout against an extracted kit:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\packaging\windows\templates\kit\oneclick\Install-Desktop-Shortcut.ps1 -BundleRoot "D:\MCP"

  The installer copies only the launcher script and icon; it does not read,
  print or store any tunnel ID, API key or account data.
#>
param(
    [string]$BundleRoot = '',
    [ValidateRange(1, 65535)][int]$Port = 17642,
    [string]$ShortcutName = 'MCP Tunnel 一键启动',
    [string]$IconPath = '',
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$launcherDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'McpTunnelAccountManager\launcher'
$backupDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'McpTunnelAccountManager\shortcut-backups'
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

function Resolve-BundleRoot {
    if ($BundleRoot) {
        return (Resolve-Path -LiteralPath $BundleRoot -ErrorAction Stop).Path
    }
    $dir = $PSScriptRoot
    for ($i = 0; $i -lt 6 -and $dir; $i++) {
        if (Test-Path -LiteralPath (Join-Path $dir 'Start-Console.ps1') -PathType Leaf) {
            return (Resolve-Path -LiteralPath $dir).Path
        }
        $parent = Split-Path -Parent $dir
        if (-not $parent -or $parent -eq $dir) { break }
        $dir = $parent
    }
    throw 'BUNDLE_ROOT_REQUIRED: pass -BundleRoot pointing at the extracted deployment kit root.'
}

try {
    $bundle = Resolve-BundleRoot
    $starter = Join-Path $bundle 'Start-Console.ps1'
    if (-not (Test-Path -LiteralPath $starter -PathType Leaf)) {
        throw ('Start-Console.ps1 not found under: ' + $bundle)
    }

    $sourceLauncher = Join-Path $PSScriptRoot 'Start-McpTunnel-Console.ps1'
    if (-not (Test-Path -LiteralPath $sourceLauncher -PathType Leaf)) {
        throw ('Launcher script missing next to installer: ' + $sourceLauncher)
    }

    $null = New-Item -ItemType Directory -Path $launcherDir -Force
    $installedLauncher = Join-Path $launcherDir 'Start-McpTunnel-Console.ps1'
    Copy-Item -LiteralPath $sourceLauncher -Destination $installedLauncher -Force

    if (-not $IconPath) {
        $IconPath = Join-Path $PSScriptRoot 'mcp-tunnel.ico'
    }
    $installedIcon = $null
    if (Test-Path -LiteralPath $IconPath -PathType Leaf) {
        $installedIcon = Join-Path $launcherDir 'mcp-tunnel.ico'
        Copy-Item -LiteralPath $IconPath -Destination $installedIcon -Force
    }

    $desktop = [Environment]::GetFolderPath('DesktopDirectory')
    $linkPath = Join-Path $desktop ($ShortcutName + '.lnk')
    if (Test-Path -LiteralPath $linkPath -PathType Leaf) {
        $null = New-Item -ItemType Directory -Path $backupDir -Force
        $backupPath = Join-Path $backupDir ('oneclick-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-' + [guid]::NewGuid().ToString('N') + '.lnk')
        Copy-Item -LiteralPath $linkPath -Destination $backupPath -ErrorAction Stop
        Write-Host ('Existing shortcut backed up to: ' + $backupPath)
    }

    $arguments = '-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $installedLauncher + '" -BundleRoot "' + $bundle + '" -Port ' + $Port
    $shell = New-Object -ComObject WScript.Shell
    try {
        $shortcut = $shell.CreateShortcut($linkPath)
        $shortcut.TargetPath = $psExe
        $shortcut.Arguments = $arguments
        $shortcut.WorkingDirectory = $bundle
        $shortcut.Description = 'One-click start MCP Tunnel console (http://127.0.0.1:' + $Port + ')'
        $shortcut.WindowStyle = 7
        if ($installedIcon) {
            $shortcut.IconLocation = $installedIcon + ',0'
        }
        $shortcut.Save()
    } finally {
        $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
    }

    $check = (New-Object -ComObject WScript.Shell).CreateShortcut($linkPath)
    if (($check.TargetPath -ine $psExe) -or ($check.Arguments -cne $arguments)) {
        throw 'SHORTCUT_VERIFY_FAILED'
    }

    Write-Host ('Shortcut created: ' + $linkPath)
    Write-Host ('Bundle root: ' + $bundle)
    Write-Host ('Launcher: ' + $installedLauncher)
    if ($installedIcon) { Write-Host ('Icon: ' + $installedIcon) }

    if (-not $NoLaunch) {
        & $psExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installedLauncher -BundleRoot $bundle -Port $Port
    }
    exit 0
} catch {
    Write-Host ('One-click shortcut install failed: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}

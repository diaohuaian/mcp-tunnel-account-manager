# scripts/start-manager.ps1
# Detached, independent Windows startup script for MCP Tunnel Account Manager
[CmdletBinding()]
param(
    [switch]$Foreground,
    [int]$Port = 17642,
    [string]$HostAddress = "127.0.0.1"
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Split-Path -Parent $ScriptDir
$EntryScript = Join-Path $RootDir "src\main.mjs"

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "    MCP Tunnel Account Manager - PowerShell Startup Launcher    " -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan

# 1. Verify Node.js existence
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "[ERROR] Node.js is not found in PATH. Node.js 22+ is required."
    exit 1
}

# 2. Verify Node.js version >= 22
$nodeCheckScript = "const v = parseInt(process.versions.node.split('.')[0], 10); if (v < 22) { console.error('[ERROR] Node.js 22+ required. Found: v' + process.versions.node); process.exit(1); }"
& node -e $nodeCheckScript
if ($LASTEXITCODE -ne 0) {
    Write-Error "[ERROR] Node.js version check failed. Node.js version 22 or higher is required."
    exit 1
}

$nodeVersion = (& node -v).Trim()
Write-Host "[OK] Node.js runtime verified ($nodeVersion)." -ForegroundColor Green

Set-Location $RootDir
$env:HOST = $HostAddress
$env:PORT = [string]$Port

if ($Foreground) {
    Write-Host "Launching in foreground on http://$($HostAddress):$($Port)..." -ForegroundColor Yellow
    & node "$EntryScript"
} else {
    Write-Host "Launching detached background process on http://$($HostAddress):$($Port)..." -ForegroundColor Green
    $proc = Start-Process -FilePath "node" -ArgumentList "`"$EntryScript`"" -WorkingDirectory $RootDir -WindowStyle Hidden -PassThru
    Write-Host "[OK] Process successfully launched in background." -ForegroundColor Green
    Write-Host "Process ID (PID): $($proc.Id)" -ForegroundColor Cyan
    Write-Host "Dashboard URL   : http://$($HostAddress):$($Port)" -ForegroundColor Cyan
}

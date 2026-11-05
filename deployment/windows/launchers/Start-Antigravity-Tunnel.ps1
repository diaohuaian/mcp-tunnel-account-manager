#Requires -Version 5.1
param([string]$ProfileFile = "$PSScriptRoot\..\generated-profiles\antigravity-local.yaml")
$ErrorActionPreference = 'Stop'
$taskExit = 1
try {
    . "$PSScriptRoot\Runtime-Helpers.ps1"
    $taskBundle = Split-Path -Parent $PSScriptRoot
    $taskPython = Get-McpPython
    $taskWork = (Get-Item -LiteralPath (Join-Path $taskBundle 'servers\antigravity-mcp')).FullName
    $taskCommand = Join-McpCommand -Arguments @($taskPython,'-m','antigravity_mcp')
    & "$PSScriptRoot\Start-Mcp-Tunnel.ps1" -ClientPath (Join-Path $taskBundle 'tunnel-client\tunnel-client.exe') -ProfileFile $ProfileFile -WorkingDirectory $taskWork -McpCommand $taskCommand
    $taskExit = $LASTEXITCODE
} catch { Write-Host 'Antigravity 启动条件未满足。请安装 Python 3.9+，并先打开 Antigravity IDE。' -ForegroundColor Red }
exit $taskExit

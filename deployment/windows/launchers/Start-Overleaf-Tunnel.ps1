#Requires -Version 5.1
param([string]$ProfileFile = "$PSScriptRoot\..\generated-profiles\overleaf-local.yaml")
$ErrorActionPreference = 'Stop'
$taskExit = 1
try {
    . "$PSScriptRoot\Runtime-Helpers.ps1"
    $taskBundle = Split-Path -Parent $PSScriptRoot
    $taskNode = Get-McpNode -BundleRoot $taskBundle -MinimumMajor 18
    $taskEntry = (Get-Item -LiteralPath (Join-Path $taskBundle 'servers\overleaf-mcp\node_modules\mcp-server-overleaf\dist\index.js')).FullName
    $taskCommand = Join-McpCommand -Arguments @($taskNode,$taskEntry,'--stdio')
    & "$PSScriptRoot\Start-Mcp-Tunnel.ps1" -ClientPath (Join-Path $taskBundle 'tunnel-client\tunnel-client.exe') -ProfileFile $ProfileFile -WorkingDirectory $taskBundle -McpCommand $taskCommand
    $taskExit = $LASTEXITCODE
} catch { Write-Host 'Overleaf 启动条件未满足。请运行配置向导并查看说明。' -ForegroundColor Red }
exit $taskExit

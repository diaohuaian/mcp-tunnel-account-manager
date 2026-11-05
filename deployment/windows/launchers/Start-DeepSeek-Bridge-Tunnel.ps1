#Requires -Version 5.1
param([string]$ProfileFile = "$PSScriptRoot\..\generated-profiles\deepseek-local.yaml")
$ErrorActionPreference = 'Stop'
$taskExit = 1
try {
    $taskBundle = Split-Path -Parent $PSScriptRoot
    Write-Host '请先在此电脑启动 DSH，并加载本包对应的桥接插件，监听 127.0.0.1:3456。此脚本只启动隧道。'
    & "$PSScriptRoot\Start-Mcp-Tunnel.ps1" -ClientPath (Join-Path $taskBundle 'tunnel-client\tunnel-client.exe') -ProfileFile $ProfileFile -WorkingDirectory $taskBundle -BridgeAuthentication
    $taskExit = $LASTEXITCODE
} catch { Write-Host '桥接隧道启动条件未满足。请查看部署说明。' -ForegroundColor Red }
exit $taskExit

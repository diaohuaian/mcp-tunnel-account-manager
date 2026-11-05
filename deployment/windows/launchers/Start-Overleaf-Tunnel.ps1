#Requires -Version 5.1
<#
.SYNOPSIS
  启动 Overleaf MCP 隧道的安全启动器
.DESCRIPTION
  加载或提示输入 Tunnel ID 与运行时 API 密钥，并通过安全环境变量传递给 tunnel-client。
#>
param(
    [string]$ProfileFile = "$PSScriptRoot\..\generated-profiles\overleaf-local.yaml"
)
$ErrorActionPreference = 'Stop'
$bundleRoot = Split-Path -Parent $PSScriptRoot
$clientPath = Join-Path $bundleRoot "tunnel-client\tunnel-client.exe"
$workingDir = $bundleRoot

if (-not (Test-Path $ProfileFile)) {
    Write-Host "找不到配置文件: $ProfileFile" -ForegroundColor Yellow
    Write-Host "请先运行 Install-And-Setup.ps1 生成目标机器配置文件。" -ForegroundColor Yellow
    exit 1
}

& "$PSScriptRoot\Start-Mcp-Tunnel.ps1" -ClientPath $clientPath -ProfileFile $ProfileFile -WorkingDirectory $workingDir

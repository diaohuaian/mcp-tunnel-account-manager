#Requires -Version 5.1
<#
.SYNOPSIS
  启动 DeepSeek Harness Bridge MCP 隧道的安全启动器
.DESCRIPTION
  提示输入 DSH Bridge Token 与 OpenAI Tunnel Runtime API 密钥，并通过环境变量传递给 tunnel-client。
#>
param(
    [string]$ProfileFile = "$PSScriptRoot\..\generated-profiles\deepseek-bridge-local.yaml"
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

$bridgeToken = Read-Host "DeepSeek Harness Bridge Token (留空则使用当前环境变量)" -AsSecureString
if ($bridgeToken.Length -gt 0) {
    $env:DSH_CHATGPT_BRIDGE_TOKEN = [Net.NetworkCredential]::new('', $bridgeToken).Password
}

try {
    & "$PSScriptRoot\Start-Mcp-Tunnel.ps1" -ClientPath $clientPath -ProfileFile $ProfileFile -WorkingDirectory $workingDir
} finally {
    if ($bridgeToken.Length -gt 0) {
        Remove-Item Env:DSH_CHATGPT_BRIDGE_TOKEN -ErrorAction SilentlyContinue
    }
}

#Requires -Version 5.1
param(
    [ValidateRange(1,65535)][int]$Port = 17643,
    [string]$DataDirectory = '',
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
# 本仓库自带独立开发环境：默认数据目录与隧道客户端都留在工作树内，不与已部署
# 版本共用 %LOCALAPPDATA%\McpTunnelAccountManager。并发实例层会把"生产数据目录"
# 判为 INVALID_INSTANCE（实例 adapter 无法创建 → INSTANCE_ADAPTER_UNAVAILABLE），
# 而缺失的隧道客户端会让每次启动报 EXECUTABLE_NOT_FOUND。
if (-not $DataDirectory) { $DataDirectory = Join-Path $taskRoot 'data' }
$taskTunnelClient = Join-Path $taskRoot 'tools\tunnel-client\tunnel-client.exe'
if ((-not $env:TUNNEL_CLIENT_BIN) -and (Test-Path -LiteralPath $taskTunnelClient -PathType Leaf)) {
    $env:TUNNEL_CLIENT_BIN = $taskTunnelClient
}
# 旧式整服务启动会改写 %APPDATA%\tunnel-client\<service>.yaml。指向工作树内的副本，
# 这样本仓库的任何启动路径都不会碰到已部署版本的隧道配置。
$taskAppData = Join-Path $taskRoot 'data\appdata'
if (Test-Path -LiteralPath (Join-Path $taskAppData 'tunnel-client') -PathType Container) {
    $env:APPDATA = $taskAppData
}
& "$PSScriptRoot\open-mcp-tunnel-console.ps1" -Port $Port -DataDirectory $DataDirectory -NoBrowser:$NoBrowser

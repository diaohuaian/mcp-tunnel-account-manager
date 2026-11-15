#Requires -Version 5.1
param(
    [ValidateRange(1,65535)][int]$Port = 17643,
    [string]$DataDirectory = ''
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
# 与 open-portable-console.ps1 保持一致：默认停本仓库自己的 data\ 目录。
# start-manager.ps1 -Stop 只停 pid 记录里"可执行文件绝对路径 + 创建时间"都对得上的进程，
# 不按端口强杀；数据目录指错就会报"找不到本版本的进程"，或者误判端口占用。
if (-not $DataDirectory -and $env:DATA_DIR) { $DataDirectory = $env:DATA_DIR }
if (-not $DataDirectory) { $DataDirectory = Join-Path $taskRoot 'data' }
try {
    & "$PSScriptRoot\start-manager.ps1" -Stop -Port $Port -DataDirectory $DataDirectory
} catch {
    Write-Error $_
    exit 1
}
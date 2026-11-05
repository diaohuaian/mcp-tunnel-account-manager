#Requires -Version 5.1
<#
.SYNOPSIS
  新 Windows 机器环境初始化与隧道配置文件生成脚本
.DESCRIPTION
  在新机器上验证依赖（Node.js, Python, Antigravity IDE, DeepSeek Harness），
  根据用户输入的 Tunnel ID 为 3 个 MCP 服务生成绑定配置文件。
#>
$ErrorActionPreference = 'Stop'
$bundleRoot = $PSScriptRoot
$profilesDir = Join-Path $bundleRoot "generated-profiles"
New-Item -ItemType Directory -Force -Path $profilesDir | Out-Null

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  MCP Windows 部署包 - 新机器配置向导" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. 检查 Node.js
Write-Host "1. 检查 Node.js 运行时..." -NoNewline
try {
    $nodeVer = & node --version
    Write-Host " [OK] ($nodeVer)" -ForegroundColor Green
} catch {
    Write-Host " [未检测到] 请安装 Node.js >= 18 以运行 Overleaf/DeepSeek MCP" -ForegroundColor Yellow
}

# 2. 检查 Python
Write-Host "2. 检查 Python 运行时..." -NoNewline
try {
    $pyVer = & python --version
    Write-Host " [OK] ($pyVer)" -ForegroundColor Green
} catch {
    Write-Host " [未检测到] 请安装 Python >= 3.9 以运行 Antigravity MCP" -ForegroundColor Yellow
}

# 3. 生成配置文件
Write-Host "
3. 配置 Tunnel ID" -ForegroundColor Cyan
Write-Host "注意：Windows 2 上 3 个并发服务需要各自独立的 OpenAI Tunnel ID。" -ForegroundColor Gray

$overleafId = Read-Host "请输入 Overleaf MCP Tunnel ID (留空使用默认占位符)"
if (-not $overleafId) { $overleafId = "<TUNNEL_ID_OVERLEAF>" }

$antigravityId = Read-Host "请输入 Antigravity MCP Tunnel ID (留空使用默认占位符)"
if (-not $antigravityId) { $antigravityId = "<TUNNEL_ID_ANTIGRAVITY>" }

$deepseekId = Read-Host "请输入 DeepSeek MCP Tunnel ID (留空使用默认占位符)"
if (-not $deepseekId) { $deepseekId = "<TUNNEL_ID_DEEPSEEK>" }

# 生成 Overleaf profile
$tplOverleaf = Get-Content (Join-Path $bundleRoot "templates\overleaf-tunnel.yaml.template") -Raw
$overleafProfile = $tplOverleaf.Replace("<TUNNEL_ID_PLACEHOLDER>", $overleafId)
[IO.File]::WriteAllText((Join-Path $profilesDir "overleaf-local.yaml"), $overleafProfile, [Text.UTF8Encoding]::new($false))

# 生成 Antigravity profile
$tplAntigravity = Get-Content (Join-Path $bundleRoot "templates\antigravity-tunnel.yaml.template") -Raw
$antigravityProfile = $tplAntigravity.Replace("<TUNNEL_ID_PLACEHOLDER>", $antigravityId)
[IO.File]::WriteAllText((Join-Path $profilesDir "antigravity-local.yaml"), $antigravityProfile, [Text.UTF8Encoding]::new($false))

# 生成 DeepSeek profile
$tplDeepseek = Get-Content (Join-Path $bundleRoot "templates\deepseek-bridge-tunnel.yaml.template") -Raw
$deepseekProfile = $tplDeepseek.Replace("<TUNNEL_ID_PLACEHOLDER>", $deepseekId)
[IO.File]::WriteAllText((Join-Path $profilesDir "deepseek-bridge-local.yaml"), $deepseekProfile, [Text.UTF8Encoding]::new($false))

Write-Host "
配置文件已生成于 $profilesDir" -ForegroundColor Green
Write-Host "可通过 launchers/ 目录下的启动脚本启动相应隧道。" -ForegroundColor Green

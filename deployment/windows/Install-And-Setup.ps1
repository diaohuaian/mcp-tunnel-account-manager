#Requires -Version 5.1
param(
    [ValidateSet('overleaf','antigravity','deepseek')][string[]]$Services = @('overleaf','antigravity','deepseek'),
    [string]$OverleafTunnelId = '',
    [string]$AntigravityTunnelId = '',
    [string]$DeepSeekTunnelId = '',
    [switch]$NonInteractive,
    [switch]$Force
)
$ErrorActionPreference = 'Stop'
$taskExit = 1
try {
    . "$PSScriptRoot\launchers\Runtime-Helpers.ps1"
    $taskServices = @($Services | Select-Object -Unique)
    if ($taskServices.Count -eq 0) { throw '至少选择一项服务。' }
    $taskIds = @{ overleaf = $OverleafTunnelId; antigravity = $AntigravityTunnelId; deepseek = $DeepSeekTunnelId }
    $taskSeen = @{}
    $taskOutput = Join-Path $PSScriptRoot 'generated-profiles'
    $taskFiles = @{ overleaf = 'overleaf'; antigravity = 'antigravity'; deepseek = 'deepseek-bridge' }
    $taskReady = @{}
    foreach ($taskService in $taskServices) {
        $taskId = [string]$taskIds[$taskService]
        if ([string]::IsNullOrWhiteSpace($taskId) -and -not $NonInteractive) { $taskId = Read-Host ($taskService + ' 的新 Tunnel ID') }
        $taskId = $taskId.Trim()
        if ($taskId -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' -or $taskId -match 'PLACEHOLDER|REPLACE_|YOUR_') { throw 'Tunnel ID 未填写或格式无效；未生成新配置。' }
        if ($taskSeen.ContainsKey($taskId)) { throw '多项服务必须使用不同的 Tunnel ID。' }
        $taskSeen[$taskId] = $true
        $taskPath = Join-Path $taskOutput ($taskService + '-local.yaml')
        if ((Test-Path -LiteralPath $taskPath) -and -not $Force) { throw '配置已存在。确认需要覆盖后使用 -Force；未覆盖已有配置。' }
        $taskTemplate = Join-Path $PSScriptRoot ('templates\' + $taskFiles[$taskService] + '-tunnel.yaml.template')
        $taskContent = [IO.File]::ReadAllText($taskTemplate).Replace('<TUNNEL_ID_YAML>',("'" + $taskId + "'"))
        if ($taskContent -match '<[A-Z][A-Z0-9_]*>|\$\{') { throw '配置模板仍有未处理的占位符。' }
        $taskReady[$taskPath] = $taskContent
    }
    # Probe real exit codes and versions before writing any profiles.
    if ($taskServices -contains 'overleaf') {
        $null = Get-McpNode -BundleRoot $PSScriptRoot -MinimumMajor 18
        $null = Get-Item -LiteralPath "$PSScriptRoot\servers\overleaf-mcp\node_modules\mcp-server-overleaf\dist\index.js"
    }
    if ($taskServices -contains 'antigravity') {
        $null = Get-McpPython
        $null = Get-Item -LiteralPath "$PSScriptRoot\servers\antigravity-mcp\antigravity_mcp\__main__.py"
    }
    if ($taskServices -contains 'deepseek') {
        $null = Get-McpNode -BundleRoot $PSScriptRoot -MinimumMajor 22
        $null = Get-Item -LiteralPath "$PSScriptRoot\servers\deepseek-mcp\lib\index.js"
        $null = Get-Item -LiteralPath "$PSScriptRoot\servers\deepseek-mcp\cordis.patch.yml"
    }
    $null = Get-Item -LiteralPath "$PSScriptRoot\tunnel-client\tunnel-client.exe"
    $null = New-Item -ItemType Directory -Path $taskOutput -Force
    foreach ($taskPath in $taskReady.Keys) {
        [IO.File]::WriteAllText($taskPath,$taskReady[$taskPath],(New-Object Text.UTF8Encoding($false)))
        Write-Host ('已生成：' + $taskPath)
    }
    Write-Host '配置已生成，尚未启动任何服务。请按 README.zh-CN.md 完成目标机登录和依赖准备，再运行对应启动器。'
    if ($taskServices -contains 'deepseek') { Write-Host 'DSH 主程序和桥接依赖需要在目标机另行安装、加载；本向导不安装或启动 DSH。' }
    $taskExit = 0
} catch {
    Write-Host '配置未完成。请检查 Tunnel ID、已有配置、Node/Python 以及包内文件；详见部署说明。' -ForegroundColor Red
}
exit $taskExit

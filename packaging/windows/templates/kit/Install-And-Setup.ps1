#Requires -Version 5.1
param(
    [ValidateSet('overleaf','antigravity','deepseek')][string[]]$Services = @('overleaf'),
    [string]$OverleafTunnelId = '',
    [string]$AntigravityTunnelId = '',
    [string]$DeepSeekTunnelId = '',
    [switch]$NonInteractive,
    [switch]$Force
)
$ErrorActionPreference = 'Stop'
try {
    . "$PSScriptRoot\launchers\Runtime-Helpers.ps1"
    $taskServices = @($Services | Select-Object -Unique)
    if ($taskServices.Count -eq 0) { throw '至少选择一项服务。' }
    $taskIds = @{ overleaf=$OverleafTunnelId; antigravity=$AntigravityTunnelId; deepseek=$DeepSeekTunnelId }
    $taskNames = @{ overleaf='overleaf'; antigravity='antigravity'; deepseek='deepseek-bridge' }
    $taskOutput = Join-Path $PSScriptRoot 'generated-profiles'
    $taskSeen = @{}
    $taskReady = [ordered]@{}
    $taskServers = [ordered]@{}
    $taskNode = Get-McpNode -BundleRoot $PSScriptRoot
    foreach ($taskService in $taskServices) {
        $taskId = [string]$taskIds[$taskService]
        if ([string]::IsNullOrWhiteSpace($taskId) -and -not $NonInteractive) { $taskId = Read-Host ($taskService + ' 的新 Tunnel ID') }
        $taskId = $taskId.Trim()
        if ($taskId -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' -or $taskId -match 'PLACEHOLDER|REPLACE_|YOUR_') { throw 'Tunnel ID 未填写或格式无效。' }
        if ($taskSeen.ContainsKey($taskId)) { throw '每项服务必须使用不同的 Tunnel ID。' }
        $taskSeen[$taskId] = $true
        $taskPath = Join-Path $taskOutput ($taskService + '-local.yaml')
        $taskTemplate = Join-Path $PSScriptRoot ('templates\' + $taskNames[$taskService] + '-tunnel.yaml.template')
        $taskText = [IO.File]::ReadAllText($taskTemplate).Replace('<TUNNEL_ID_YAML>',("'" + $taskId + "'"))
        if ($taskText -match '<[A-Z][A-Z0-9_]*>|\$\{') { throw '配置模板仍有未处理的占位符。' }
        $taskReady[$taskPath] = $taskText
        switch ($taskService) {
            'overleaf' {
                $taskEntry = (Get-Item -LiteralPath "$PSScriptRoot\servers\overleaf-mcp\node_modules\mcp-server-overleaf\dist\index.js").FullName
                $taskServers['overleaf-mcp'] = [ordered]@{ command=$taskNode; args=@($taskEntry,'--stdio'); cwd=$PSScriptRoot; env=@{} }
            }
            'antigravity' {
                $taskPython = Get-McpPython
                $taskWork = (Get-Item -LiteralPath "$PSScriptRoot\servers\antigravity-mcp").FullName
                $null = Get-Item -LiteralPath (Join-Path $taskWork 'antigravity_mcp\__main__.py')
                $taskServers['antigravity-mcp'] = [ordered]@{ command=$taskPython; args=@('-m','antigravity_mcp'); cwd=$taskWork; env=@{} }
            }
            'deepseek' {
                $null = Get-Item -LiteralPath "$PSScriptRoot\servers\deepseek-mcp\lib\index.js"
                $null = Get-Item -LiteralPath "$PSScriptRoot\servers\deepseek-mcp\cordis.patch.yml"
            }
        }
    }
    if ($taskServers.Count -gt 0) {
        $taskConfigPath = Join-Path $taskOutput 'console-services.json'
        $taskReady[$taskConfigPath] = ([ordered]@{ mcpServers=$taskServers } | ConvertTo-Json -Depth 12)
    }
    foreach ($taskPath in $taskReady.Keys) {
        if ((Test-Path -LiteralPath $taskPath) -and -not $Force) { throw ('配置已存在；需要覆盖时明确加 -Force：' + [IO.Path]::GetFileName($taskPath)) }
    }
    $null = Get-Item -LiteralPath "$PSScriptRoot\tunnel-client\tunnel-client.exe"
    # All IDs and executable paths are validated before creating any configuration.
    $null = New-Item -ItemType Directory -Path $taskOutput -Force
    foreach ($taskPath in $taskReady.Keys) {
        $taskMode = [IO.FileMode]::CreateNew
        if ($Force) { $taskMode = [IO.FileMode]::Create }
        $taskStream = [IO.File]::Open($taskPath,$taskMode,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try {
            $taskBytes = (New-Object Text.UTF8Encoding($false)).GetBytes([string]$taskReady[$taskPath])
            $taskStream.Write($taskBytes,0,$taskBytes.Length)
        } finally { $taskStream.Dispose() }
        Write-Host ('已生成：' + $taskPath)
    }
    Write-Host '配置已生成，尚未启动服务，也未安装或启动 DSH。Runtime API Key 在启动时隐藏输入，不写进这些配置。'
    if ($taskServers.Count -gt 0) { Write-Host '如需控制台管理：在页面中导入 generated-profiles/console-services.json，核对绑定，并另行添加自己的账号和 Tunnel ID。' }
    if ($taskServices -contains 'deepseek') { Write-Host 'DSH 主程序、桥接依赖、Web profile 和桥接令牌需要另行准备；请先阅读部署说明。' }
    exit 0
} catch {
    Write-Error ('配置未完成：' + $_.Exception.Message)
    exit 1
}

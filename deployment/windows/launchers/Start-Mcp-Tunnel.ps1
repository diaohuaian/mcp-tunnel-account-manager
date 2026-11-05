#Requires -Version 5.1
param(
    [Parameter(Mandatory=$true)][string]$ClientPath,
    [Parameter(Mandatory=$true)][string]$ProfileFile,
    [Parameter(Mandatory=$true)][string]$WorkingDirectory,
    [string]$McpCommand = '',
    [switch]$BridgeAuthentication
)
$ErrorActionPreference = 'Stop'
$taskPrevious = @{}
$taskNames = @(
    'CONTROL_PLANE_API_KEY','CONTROL_PLANE_TUNNEL_ID','CONTROL_PLANE_ORGANIZATION_ID',
    'CONTROL_PLANE_BASE_URL','CONTROL_PLANE_URL_PATH','CONTROL_PLANE_EXTRA_HEADERS',
    'MCP_COMMAND','MCP_SERVER_URL','MCP_EXTRA_HEADERS','MCP_DISCOVERY_EXTRA_HEADERS',
    'TUNNEL_CLIENT_CONFIG','TUNNEL_CLIENT_PROFILE','TUNNEL_CLIENT_PROFILE_FILE',
    'DEPLOYMENT_MCP_COMMAND','DSH_CHATGPT_BRIDGE_TOKEN','DSH_CHATGPT_BRIDGE_AUTHORIZATION'
)
$taskOriginalDirectory = (Get-Location).Path
$taskExit = 1
$taskSecureKey = $null
$taskSecureBridge = $null
try {
    foreach ($taskName in $taskNames) {
        $taskPrevious[$taskName] = [Environment]::GetEnvironmentVariable($taskName,'Process')
        [Environment]::SetEnvironmentVariable($taskName,$null,'Process')
    }
    $taskClient = (Get-Item -LiteralPath $ClientPath -ErrorAction Stop).FullName
    $taskProfile = (Get-Item -LiteralPath $ProfileFile -ErrorAction Stop).FullName
    $taskWork = (Get-Item -LiteralPath $WorkingDirectory -ErrorAction Stop).FullName
    if ([IO.Path]::GetExtension($taskClient) -ine '.exe') { throw 'TUNNEL_CLIENT_EXECUTABLE_REQUIRED' }
    $taskProfileText = [IO.File]::ReadAllText($taskProfile)
    if ($taskProfileText -match '<[A-Z][A-Z0-9_]*>|\$\{') { throw 'PROFILE_NOT_CONFIGURED' }
    if ($McpCommand) { $env:DEPLOYMENT_MCP_COMMAND = $McpCommand }
    if ($BridgeAuthentication) {
        $taskSecureBridge = Read-Host 'DSH 桥接令牌（留空使用本进程已有的 DSH_CHATGPT_BRIDGE_TOKEN）' -AsSecureString
        if ($taskSecureBridge.Length -gt 0) {
            $env:DSH_CHATGPT_BRIDGE_TOKEN = [Net.NetworkCredential]::new('', $taskSecureBridge).Password
        } else {
            $env:DSH_CHATGPT_BRIDGE_TOKEN = $taskPrevious['DSH_CHATGPT_BRIDGE_TOKEN']
        }
        if ([string]::IsNullOrWhiteSpace($env:DSH_CHATGPT_BRIDGE_TOKEN)) { throw 'BRIDGE_TOKEN_REQUIRED' }
        if ($env:DSH_CHATGPT_BRIDGE_TOKEN -match '[\r\n]') { throw 'INVALID_BRIDGE_TOKEN' }
        $env:DSH_CHATGPT_BRIDGE_AUTHORIZATION = 'Bearer ' + $env:DSH_CHATGPT_BRIDGE_TOKEN
    }
    $taskSecureKey = Read-Host 'OpenAI Tunnel Runtime API Key（仅用于本次运行）' -AsSecureString
    if ($taskSecureKey.Length -eq 0) { throw 'RUNTIME_KEY_REQUIRED' }
    $env:CONTROL_PLANE_API_KEY = [Net.NetworkCredential]::new('', $taskSecureKey).Password
    Set-Location -LiteralPath $taskWork
    $ErrorActionPreference = 'Continue'
    & $taskClient run --config $taskProfile
    $taskExit = $LASTEXITCODE
    if ($null -eq $taskExit) { $taskExit = 1 }
} catch {
    Write-Host '隧道未能启动。请先运行配置向导，并确认程序、配置和运行环境。' -ForegroundColor Red
    $taskExit = 1
} finally {
    $ErrorActionPreference = 'Stop'
    if ($null -ne $taskSecureKey) { $taskSecureKey.Dispose() }
    if ($null -ne $taskSecureBridge) { $taskSecureBridge.Dispose() }
    foreach ($taskName in $taskNames) {
        if ($taskPrevious.ContainsKey($taskName)) {
            [Environment]::SetEnvironmentVariable($taskName,$taskPrevious[$taskName],'Process')
        }
    }
    Set-Location -LiteralPath $taskOriginalDirectory
}
# Do not exit here: callers must retain control for their own cleanup.
$global:LASTEXITCODE = [int]$taskExit

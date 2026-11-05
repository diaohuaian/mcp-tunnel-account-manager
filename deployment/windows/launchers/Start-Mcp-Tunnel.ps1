#Requires -Version 5.1
param([Parameter(Mandatory=$true)][string]$ClientPath,[Parameter(Mandatory=$true)][string]$ProfileFile,[Parameter(Mandatory=$true)][string]$WorkingDirectory)
$ErrorActionPreference = 'Stop'
$taskPrevious = @{}
$taskNames = @('CONTROL_PLANE_API_KEY','CONTROL_PLANE_TUNNEL_ID','MCP_COMMAND','MCP_SERVER_URL','MCP_EXTRA_HEADERS','MCP_DISCOVERY_EXTRA_HEADERS','TUNNEL_CLIENT_CONFIG','TUNNEL_CLIENT_PROFILE','TUNNEL_CLIENT_PROFILE_FILE')
$taskOriginalDirectory = (Get-Location).Path
$taskExit = 1
$taskSecureKey = $null
try {
    $taskClient = (Get-Item -LiteralPath $ClientPath -ErrorAction Stop).FullName
    $taskProfile = (Get-Item -LiteralPath $ProfileFile -ErrorAction Stop).FullName
    $taskWork = (Get-Item -LiteralPath $WorkingDirectory -ErrorAction Stop).FullName
    if ([IO.Path]::GetExtension($taskClient) -ine '.exe') { throw 'TUNNEL_CLIENT_EXECUTABLE_REQUIRED' }
    foreach ($taskName in $taskNames) {
        $taskPrevious[$taskName] = [Environment]::GetEnvironmentVariable($taskName,'Process')
        Remove-Item ('Env:' + $taskName) -ErrorAction SilentlyContinue
    }
    $taskSecureKey = Read-Host 'OpenAI Tunnel Runtime API Key（仅用于本次运行）' -AsSecureString
    if ($taskSecureKey.Length -eq 0) { throw 'RUNTIME_KEY_REQUIRED' }
    $env:CONTROL_PLANE_API_KEY = [Net.NetworkCredential]::new('', $taskSecureKey).Password
    Set-Location -LiteralPath $taskWork
    $ErrorActionPreference = 'Continue'
    & $taskClient run --config $taskProfile
    $taskExit = $LASTEXITCODE
} catch {
    Write-Host '隧道未能启动。请确认程序、配置和工作目录，并查看本机客户端提示。' -ForegroundColor Red
    $taskExit = 1
} finally {
    $ErrorActionPreference = 'Stop'
    if ($null -ne $taskSecureKey) { $taskSecureKey.Dispose() }
    foreach ($taskName in $taskNames) {
        if ($taskPrevious.ContainsKey($taskName)) {
            if ($null -eq $taskPrevious[$taskName]) { Remove-Item ('Env:' + $taskName) -ErrorAction SilentlyContinue }
            else { [Environment]::SetEnvironmentVariable($taskName,$taskPrevious[$taskName],'Process') }
        }
    }
    Set-Location -LiteralPath $taskOriginalDirectory
}
exit $taskExit
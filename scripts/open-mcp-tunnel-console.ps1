#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
$taskConsoleUrl = 'http://127.0.0.1:17642'
$taskProjectRoot = Split-Path -Parent $PSScriptRoot
$taskStarterPath = Join-Path $PSScriptRoot 'start-manager.ps1'

function Test-McpConsoleReady {
    try {
        $taskState = Invoke-RestMethod -Method Get -Uri ($taskConsoleUrl + '/api/auth/state') -TimeoutSec 1 -MaximumRedirection 0 -ErrorAction Stop
        return (($null -ne $taskState) -and ($taskState.configured -is [bool]) -and ($taskState.authenticated -is [bool]))
    }
    catch { return $false }
}

try {
    if (-not (Test-Path -LiteralPath $taskStarterPath -PathType Leaf)) {
        throw 'STARTER_NOT_FOUND'
    }
    if (-not (Test-McpConsoleReady)) {
        $taskPreviousDataDir = [Environment]::GetEnvironmentVariable('DATA_DIR', 'Process')
        try {
            $env:DATA_DIR = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'McpTunnelAccountManager'
            & $taskStarterPath -HostAddress '127.0.0.1' -Port 17642 | Out-Null
        }
        finally {
            if ($null -eq $taskPreviousDataDir) {
                Remove-Item Env:DATA_DIR -ErrorAction SilentlyContinue
            }
            else { $env:DATA_DIR = $taskPreviousDataDir }
        }
    }
    $taskClock = [Diagnostics.Stopwatch]::StartNew()
    while ($taskClock.Elapsed.TotalSeconds -lt 30) {
        if (Test-McpConsoleReady) {
            Start-Process -FilePath $taskConsoleUrl
            exit 0
        }
        Start-Sleep -Milliseconds 400
    }
    throw 'CONSOLE_START_TIMEOUT'
}
catch {     Add-Type -AssemblyName System.Windows.Forms
    $taskFallbackPath = Join-Path $taskProjectRoot 'start-manager.cmd'
    [System.Windows.Forms.MessageBox]::Show(
        ('控制台未能启动。请手动运行：' + [Environment]::NewLine + $taskFallbackPath),
        'MCP 隧道账号控制台',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Warning
    ) | Out-Null
    exit 1
}

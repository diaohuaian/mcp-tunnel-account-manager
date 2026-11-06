#Requires -Version 5.1
param(
    [ValidateRange(1,65535)][int]$Port = 17642,
    [string]$DataDirectory = '',
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
try {
    & "$PSScriptRoot\start-manager.ps1" -Port $Port -DataDirectory $DataDirectory
    $taskUrl = 'http://127.0.0.1:' + $Port
    $taskReady = $false
    $taskDeadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $taskDeadline) {
        try {
            $taskReply = Invoke-RestMethod -Uri ($taskUrl + '/api/auth/state') -TimeoutSec 2 -UseBasicParsing
            if ($taskReply.configured -is [bool] -and $taskReply.authenticated -is [bool]) { $taskReady = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 300
    }
    if (-not $taskReady) { throw 'Console did not become ready within 30 seconds. Check the local stderr log.' }
    Write-Host ('Console ready: ' + $taskUrl)
    if (-not $NoBrowser) { Start-Process $taskUrl }
} catch {
    Write-Error $_
    exit 1
}

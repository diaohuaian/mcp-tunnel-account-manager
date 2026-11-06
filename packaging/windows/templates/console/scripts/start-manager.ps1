#Requires -Version 5.1
param(
    [switch]$Foreground,
    [switch]$Stop,
    [ValidateRange(1,65535)][int]$Port = 17642,
    [ValidateSet('127.0.0.1')][string]$HostAddress = '127.0.0.1',
    [string]$DataDirectory = ''
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskEntry = Join-Path $PSScriptRoot 'launch-manager.mjs'
$taskNode = Join-Path $taskRoot 'runtime\node.exe'
if (-not (Test-Path -LiteralPath $taskNode -PathType Leaf)) {
    $taskCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $taskCommand) { throw 'Node.js 22.14+ is required. Use the portable ZIP with its runtime, or install Node.js.' }
    $taskNode = $taskCommand.Source
}
$taskVersion = (& $taskNode -p 'process.versions.node')
if ($LASTEXITCODE -ne 0 -or [version]$taskVersion -lt [version]'22.14.0') { throw 'Node.js 22.14+ is required.' }
if (-not $DataDirectory) {
    if ($env:DATA_DIR) { $DataDirectory = $env:DATA_DIR }
    else { $DataDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'McpTunnelAccountManager' }
}
$DataDirectory = [IO.Path]::GetFullPath($DataDirectory)
$null = New-Item -ItemType Directory -Path $DataDirectory -Force
$taskPidFile = Join-Path $DataDirectory ('console-' + $Port + '.pid.json')

function Get-OwnedConsoleProcess {
    if (-not (Test-Path -LiteralPath $taskPidFile -PathType Leaf)) { return $null }
    try {
        $taskRecord = [IO.File]::ReadAllText($taskPidFile) | ConvertFrom-Json
        $taskProcess = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$taskRecord.processId) -ErrorAction Stop
        if ($null -eq $taskProcess) { return $null }
        if ($taskProcess.ExecutablePath -ine $taskNode) { return $null }
        if ([string]::IsNullOrEmpty($taskProcess.CommandLine) -or $taskProcess.CommandLine.IndexOf($taskEntry,[StringComparison]::OrdinalIgnoreCase) -lt 0) { return $null }
        if ($taskProcess.CreationDate.ToUniversalTime().Ticks.ToString() -ne [string]$taskRecord.creationTicks) { return $null }
        return $taskProcess
    } catch { return $null }
}

$taskOwned = Get-OwnedConsoleProcess
if ($Stop) {
    if ($null -eq $taskOwned) { throw 'No owned console process was found for this release and data directory. No process was stopped.' }
    Stop-Process -Id ([int]$taskOwned.ProcessId) -ErrorAction Stop
    Write-Host 'Stopped this release console only. No tunnel, IDE, or unrelated listener was stopped.'
    return
}
$taskListeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if ($taskListeners.Count -gt 0) {
    if ($null -ne $taskOwned -and @($taskListeners | Where-Object { $_.OwningProcess -eq $taskOwned.ProcessId }).Count -eq $taskListeners.Count) {
        Write-Host ('This release is already listening on http://127.0.0.1:' + $Port)
        return
    }
    throw ('Port ' + $Port + ' is in use by another process or an older release. Close that console explicitly or choose -Port. No process was stopped.')
}
$taskPrevious = @{ DATA_DIR=$env:DATA_DIR; PORT=$env:PORT; HOST=$env:HOST; PATH=$env:PATH }
try {
    $env:DATA_DIR = $DataDirectory
    $env:PORT = [string]$Port
    $env:HOST = $HostAddress
    $env:PATH = (Split-Path -Parent $taskNode) + ';' + $env:PATH
    if ($Foreground) {
        & $taskNode $taskEntry
        if ($LASTEXITCODE -ne 0) { throw ('Console exited with code ' + $LASTEXITCODE) }
    } else {
        $taskOut = Join-Path $DataDirectory ('console-' + $Port + '.stdout.log')
        $taskErr = Join-Path $DataDirectory ('console-' + $Port + '.stderr.log')
        $taskChild = Start-Process -FilePath $taskNode -ArgumentList @('"' + $taskEntry + '"') -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput $taskOut -RedirectStandardError $taskErr -PassThru
        $taskInfo = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $taskChild.Id) -ErrorAction Stop
        if ($null -eq $taskInfo) { throw ('Console exited during startup. See ' + $taskErr) }
        $taskRecord = @{ processId=$taskChild.Id; creationTicks=$taskInfo.CreationDate.ToUniversalTime().Ticks.ToString(); entry=$taskEntry }
        [IO.File]::WriteAllText($taskPidFile,($taskRecord | ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
        Write-Host ('Started console. Local logs: ' + $DataDirectory)
    }
} finally {
    foreach ($taskName in $taskPrevious.Keys) { [Environment]::SetEnvironmentVariable($taskName,$taskPrevious[$taskName],'Process') }
}

#Requires -Version 5.1
param(
    [switch]$Foreground,
    [switch]$Stop,
    [ValidateRange(1,65535)][int]$Port = 17643,
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
        # 用 .NET 直接取进程对象：Get-CimInstance Win32_Process 在本机单次约 1.2 秒，
        # 而 GetProcessById 是原生调用（毫秒级）。身份判据仍为「可执行文件绝对路径 +
        # 创建时间」，与 pid 文件记录逐项比对，不依赖 WMI。
        $taskProcess = [System.Diagnostics.Process]::GetProcessById([int]$taskRecord.processId)
        if ($null -eq $taskProcess -or $taskProcess.HasExited) { return $null }
        $taskExe = $null
        try { $taskExe = $taskProcess.MainModule.FileName } catch { return $null }
        if ([string]::IsNullOrEmpty($taskExe) -or $taskExe -ine $taskNode) { return $null }
        if ($taskProcess.StartTime.ToUniversalTime().Ticks.ToString() -ne [string]$taskRecord.creationTicks) { return $null }
        return $taskProcess
    } catch { return $null }
}

$taskOwned = Get-OwnedConsoleProcess
if ($Stop) {
    if ($null -eq $taskOwned) { throw 'No owned console process was found for this release and data directory. No process was stopped.' }
    Stop-Process -Id ([int]$taskOwned.Id) -ErrorAction Stop
    Write-Host 'Stopped this release console only. No tunnel, IDE, or unrelated listener was stopped.'
    return
}
function Get-PortListenerProcessIds {
    # Get-NetTCPConnection 在本机单次耗时约 4-6 秒（WMI/CIM 开销），而 netstat 约 100 毫秒，
    # 它是控制台冷启动的主要瓶颈。这里解析 netstat -ano 的 LISTENING 行，语义与
    # -State Listen + -LocalPort 等价。
    param([Parameter(Mandatory = $true)][int]$TargetPort)
    $taskPids = New-Object 'System.Collections.Generic.HashSet[int]'
    $taskLines = & netstat.exe -ano 2>$null
    foreach ($taskLine in $taskLines) {
        if ($taskLine -notmatch '^\s*(?<proto>\S+)\s+(?<local>\S+)\s+(?<remote>\S+)\s+(?<state>LISTENING)\s+(?<pid>\d+)\s*$') { continue }
        $taskLocal = $Matches['local']
        $taskColon = $taskLocal.LastIndexOf(':')
        if ($taskColon -lt 0) { continue }
        if ($taskLocal.Substring($taskColon + 1) -ne [string]$TargetPort) { continue }
        [void]$taskPids.Add([int]$Matches['pid'])
    }
    return @($taskPids)
}

$taskListenerPids = @(Get-PortListenerProcessIds -TargetPort $Port)
if ($taskListenerPids.Count -gt 0) {
    if ($null -ne $taskOwned -and @($taskListenerPids | Where-Object { $_ -ne [int]$taskOwned.Id }).Count -eq 0) {
        Write-Host ('This release is already listening on http://127.0.0.1:' + $Port)
        return
    }
    throw ('Port ' + $Port + ' is in use by another process or an older release. Close that console explicitly or choose -Port. No process was stopped.')
}
$taskPrevious = @{ DATA_DIR=$env:DATA_DIR; PORT=$env:PORT; HOST=$env:HOST; PATH=$env:PATH }
$taskRemovedEnv = @()

function Remove-DuplicateCaseEnvironment {
    # Windows 环境变量名大小写不敏感，但 PowerShell 5.1 的 Start-Process 在
    # 构造子进程环境块时，会把 NO_PROXY / no_proxy 这类同名不同大小写的键
    # 当作字典重复键并抛出 ArgumentException：
    #   "Item has already been added. Key in dictionary: 'NO_PROXY' ..."
    # 这会让本脚本在同时导出两种大小写（常见于 git-bash/MSYS 环境）时无法启动。
    # 这里临时移除重复的小写变体，结束后由 finally 原样恢复。
    $taskSnapshot = [System.Environment]::GetEnvironmentVariables()
    $taskGroups = $taskSnapshot.Keys |
        Group-Object { $_.ToString().ToUpperInvariant() } |
        Where-Object { $_.Count -gt 1 }
    foreach ($taskGroup in $taskGroups) {
        $taskNames = @($taskGroup.Group)
        $taskKeep = $taskNames | Where-Object { $_ -ceq $_.ToString().ToUpperInvariant() } | Select-Object -First 1
        if ($null -eq $taskKeep) { $taskKeep = $taskNames[0] }
        foreach ($taskName in $taskNames) {
            if ($taskName -cne $taskKeep) {
                $script:taskRemovedEnv += [PSCustomObject]@{ Name = $taskName; Value = $taskSnapshot[$taskName] }
                [Environment]::SetEnvironmentVariable($taskName, $null, 'Process')
            }
        }
    }
}

try {
    $env:DATA_DIR = $DataDirectory
    $env:PORT = [string]$Port
    $env:HOST = $HostAddress
    $env:PATH = (Split-Path -Parent $taskNode) + ';' + $env:PATH
    if ($Foreground) {
        & $taskNode $taskEntry
        if ($LASTEXITCODE -ne 0) { throw ('Console exited with code ' + $LASTEXITCODE) }
    } else {
        Remove-DuplicateCaseEnvironment
        $taskOut = Join-Path $DataDirectory ('console-' + $Port + '.stdout.log')
        $taskErr = Join-Path $DataDirectory ('console-' + $Port + '.stderr.log')
        $taskChild = Start-Process -FilePath $taskNode -ArgumentList @('"' + $taskEntry + '"') -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput $taskOut -RedirectStandardError $taskErr -PassThru
        # 同样用 .NET 取创建时间，避免再付一次 Get-CimInstance 的约 1.2 秒。
        $taskChild.Refresh()
        if ($null -eq $taskChild -or $taskChild.HasExited) { throw ('Console exited during startup. See ' + $taskErr) }
        $taskRecord = @{ processId=$taskChild.Id; creationTicks=$taskChild.StartTime.ToUniversalTime().Ticks.ToString(); entry=$taskEntry }
        [IO.File]::WriteAllText($taskPidFile,($taskRecord | ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
        Write-Host ('Started console. Local logs: ' + $DataDirectory)
    }
} finally {
    foreach ($taskItem in $taskRemovedEnv) {
        [Environment]::SetEnvironmentVariable($taskItem.Name, $taskItem.Value, 'Process')
    }
    foreach ($taskName in $taskPrevious.Keys) { [Environment]::SetEnvironmentVariable($taskName,$taskPrevious[$taskName],'Process') }
}

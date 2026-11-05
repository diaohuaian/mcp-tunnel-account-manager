#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskRuntimeDir = Join-Path $taskRoot 'runtime'
$taskNode = Join-Path $taskRuntimeDir 'node.exe'
$taskOpener = Join-Path $PSScriptRoot 'open-mcp-tunnel-console.ps1'
$taskPreviousPath = [Environment]::GetEnvironmentVariable('PATH', 'Process')
try {
    if (-not (Test-Path -LiteralPath $taskNode -PathType Leaf)) { throw 'BUNDLED_NODE_MISSING' }
    if (-not (Test-Path -LiteralPath $taskOpener -PathType Leaf)) { throw 'CONSOLE_LAUNCHER_MISSING' }
    $taskVersion = (& $taskNode --version).Trim()
    if (($LASTEXITCODE -ne 0) -or ($taskVersion -notmatch '^v(\d+)\.')) { throw 'BUNDLED_NODE_UNSUPPORTED' }
    if ([int]$Matches[1] -lt 22) { throw 'BUNDLED_NODE_UNSUPPORTED' }
    $env:PATH = $taskRuntimeDir + [IO.Path]::PathSeparator + $taskPreviousPath
    $taskPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    & $taskPowerShell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $taskOpener
    $taskExit = $LASTEXITCODE
} catch {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
        '无法启动控制台。请先将整个压缩包解压到固定文件夹，再运行“启动控制台.cmd”。',
        'MCP 隧道账号控制台',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Warning
    ) | Out-Null
    $taskExit = 1
} finally {
    if ($null -eq $taskPreviousPath) { Remove-Item Env:PATH -ErrorAction SilentlyContinue }
    else { $env:PATH = $taskPreviousPath }
}
exit $taskExit

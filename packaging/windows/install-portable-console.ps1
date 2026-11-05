#Requires -Version 5.1
param([switch]$OpenAfterInstall)
$ErrorActionPreference = 'Stop'
try {
    $taskRoot = Split-Path -Parent $PSScriptRoot
    $taskLauncher = Join-Path $PSScriptRoot 'open-portable-console.ps1'
    foreach ($taskRequired in @($taskLauncher, (Join-Path $taskRoot 'runtime\node.exe'), (Join-Path $taskRoot 'src\main.mjs'))) {
        if (-not (Test-Path -LiteralPath $taskRequired -PathType Leaf)) { throw 'PACKAGE_INCOMPLETE' }
    }
    $taskDesktop = [Environment]::GetFolderPath('DesktopDirectory')
    $taskLinkPath = Join-Path $taskDesktop 'MCP 隧道账号控制台.lnk'
    $taskPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $taskArguments = '-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $taskLauncher + '"'
    $taskShell = New-Object -ComObject WScript.Shell
    if (Test-Path -LiteralPath $taskLinkPath -PathType Leaf) {
        $taskBackupRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'McpTunnelAccountManager\shortcut-backups'
        [IO.Directory]::CreateDirectory($taskBackupRoot) | Out-Null
        Copy-Item -LiteralPath $taskLinkPath -Destination (Join-Path $taskBackupRoot ('console-' + [Guid]::NewGuid().ToString('N') + '.lnk'))
    }
    $taskLink = $taskShell.CreateShortcut($taskLinkPath)
    $taskLink.TargetPath = $taskPowerShell
    $taskLink.Arguments = $taskArguments
    $taskLink.WorkingDirectory = $taskRoot
    $taskLink.Description = '启动 MCP 隧道账号控制台'
    $taskLink.IconLocation = (Join-Path $env:SystemRoot 'System32\shell32.dll') + ',21'
    $taskLink.WindowStyle = 7
    $taskLink.Save()
    $taskCheck = $taskShell.CreateShortcut($taskLinkPath)
    if (($taskCheck.TargetPath -ine $taskPowerShell) -or ($taskCheck.Arguments -cne $taskArguments) -or ($taskCheck.WorkingDirectory -ine $taskRoot)) { throw 'SHORTCUT_READBACK_FAILED' }
    Write-Host '桌面图标已创建：MCP 隧道账号控制台'
    if ($OpenAfterInstall) {
        & $taskPowerShell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $taskLauncher
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    exit 0
} catch {
    Write-Host '创建图标失败。请先完整解压，再运行安装程序。' -ForegroundColor Red
    exit 1
}

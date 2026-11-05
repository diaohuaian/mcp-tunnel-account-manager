#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
try {
    $taskRoot = Split-Path -Parent $PSScriptRoot
    $taskRuntime = Join-Path $taskRoot 'runtime\node.exe'
    if (Test-Path -LiteralPath $taskRuntime -PathType Leaf) {
        $taskInstaller = Join-Path $PSScriptRoot 'install-portable-console.ps1'
        if (-not (Test-Path -LiteralPath $taskInstaller -PathType Leaf)) { throw 'PORTABLE_INSTALLER_MISSING' }
        $taskPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        & $taskPowerShell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $taskInstaller
        exit $LASTEXITCODE
    }
    $taskLauncher = Join-Path $PSScriptRoot 'open-mcp-tunnel-console.ps1'
    if (-not (Test-Path -LiteralPath $taskLauncher -PathType Leaf)) { throw 'LAUNCHER_MISSING' }
    $taskDesktop = [Environment]::GetFolderPath('DesktopDirectory')
    $taskLinkPath = Join-Path $taskDesktop 'MCP 隧道账号控制台.lnk'
    if (Test-Path -LiteralPath $taskLinkPath -PathType Leaf) {
        $taskBackups = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'McpTunnelAccountManager\shortcut-backups'
        [IO.Directory]::CreateDirectory($taskBackups) | Out-Null
        Copy-Item -LiteralPath $taskLinkPath -Destination (Join-Path $taskBackups ('console-' + [Guid]::NewGuid().ToString('N') + '.lnk'))
    }
    $taskPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $taskArguments = '-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $taskLauncher + '"'
    $taskShell = New-Object -ComObject WScript.Shell
    $taskLink = $taskShell.CreateShortcut($taskLinkPath)
    $taskLink.TargetPath = $taskPowerShell
    $taskLink.Arguments = $taskArguments
    $taskLink.WorkingDirectory = $taskRoot
    $taskLink.Description = '启动 MCP 隧道账号控制台'
    $taskLink.IconLocation = (Join-Path $env:SystemRoot 'System32\shell32.dll') + ',21'
    $taskLink.WindowStyle = 7
    $taskLink.Save()
    $taskCheck = $taskShell.CreateShortcut($taskLinkPath)
    if (($taskCheck.TargetPath -ine $taskPowerShell) -or ($taskCheck.Arguments -cne $taskArguments) -or ($taskCheck.WorkingDirectory -ine $taskRoot)) { throw 'SHORTCUT_VERIFY_FAILED' }
    Write-Host '桌面图标已创建：MCP 隧道账号控制台'
    exit 0
} catch {
    Write-Host '桌面图标创建失败。请确认已完整解压程序文件。' -ForegroundColor Red
    exit 1
}

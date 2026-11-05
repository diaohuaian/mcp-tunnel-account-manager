#Requires -Version 5.1
param([Parameter(Mandatory=$true)][string]$PackageRoot,[Parameter(Mandatory=$true)][ValidateSet('x64','arm64','ia32')][string]$Architecture)
$ErrorActionPreference = 'Stop'
try {
    $taskRoot = [IO.Path]::GetFullPath($PackageRoot)
    if ((Split-Path -Leaf $taskRoot) -cne 'MCP-Tunnel-Console') { throw 'PACKAGE_ROOT_INVALID' }
    $taskDesktop = [Environment]::GetFolderPath('DesktopDirectory')
    $taskName = 'MCP隧道账号控制台-Windows-' + $Architecture + '-' + (Get-Date -Format 'yyyyMMdd') + '.zip'
    $taskZipPath = Join-Path $taskDesktop $taskName
    if (Test-Path -LiteralPath $taskZipPath) {
        $taskName = 'MCP隧道账号控制台-Windows-' + $Architecture + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip'
        $taskZipPath = Join-Path $taskDesktop $taskName
    }
    if (Test-Path -LiteralPath $taskZipPath) { throw 'PACKAGE_ZIP_COLLISION' }
    Compress-Archive -LiteralPath $taskRoot -DestinationPath $taskZipPath -CompressionLevel Optimal
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $taskArchive = [IO.Compression.ZipFile]::OpenRead($taskZipPath)
    try {
        $taskFiles = @($taskArchive.Entries | Where-Object { -not $_.FullName.EndsWith('/') })
        $taskNames = @($taskFiles | ForEach-Object { $_.FullName.Replace('\','/') })
        $taskRequired = @('runtime/node.exe','runtime/LICENSE','src/main.mjs','public/app.js','scripts/open-portable-console.ps1','scripts/install-portable-console.ps1','安装桌面图标.cmd','启动控制台.cmd','使用说明.txt')
        foreach ($taskRelative in $taskRequired) {
            if (('MCP-Tunnel-Console/' + $taskRelative) -cnotin $taskNames) { throw 'ZIP_ENTRY_MISSING' }
        }
        foreach ($taskEntry in $taskNames) {
            if ($taskEntry -notmatch '^MCP-Tunnel-Console/' -or $taskEntry -match '(?i)(?:^|/)(?:reports|tests|data|logs|node_modules|\.git|\.task-work|\.gpt-work)(?:/|$)|(?:\.db|\.sqlite|\.sqlite3|\.env|\.key)$|(?:^|/)bootstrap-code\.txt$') { throw 'UNEXPECTED_PACKAGE_ENTRY' }
        }
        $taskFileCount = @(Get-ChildItem -LiteralPath $taskRoot -Recurse -File).Count
        if ($taskFiles.Count -ne $taskFileCount) { throw 'ZIP_FILE_COUNT_MISMATCH' }
    } finally { $taskArchive.Dispose() }
    $taskZip = Get-Item -LiteralPath $taskZipPath
    $taskHash = (Get-FileHash -LiteralPath $taskZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    'MCP_PORTABLE_ZIP_RESULT=' + ([pscustomobject]@{success=$true;zipPath=$taskZipPath;fileName=$taskName;sizeBytes=$taskZip.Length;sha256=$taskHash;fileCount=$taskFileCount;requiredEntriesPresent=$true;excludedPrivateData=$true} | ConvertTo-Json -Compress)
    exit 0
} catch {
    'MCP_PORTABLE_ZIP_RESULT=' + ([pscustomobject]@{success=$false;errorCode='PORTABLE_ZIP_FAILED';hresult=$_.Exception.HResult} | ConvertTo-Json -Compress)
    exit 1
}

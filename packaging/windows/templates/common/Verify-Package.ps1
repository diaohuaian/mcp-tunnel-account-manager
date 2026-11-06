#Requires -Version 5.1
param([string]$Root = $PSScriptRoot, [switch]$AllowGeneratedProfiles)
$ErrorActionPreference = 'Stop'
try {
    $taskRoot = (Get-Item -LiteralPath $Root -ErrorAction Stop).FullName.TrimEnd('\')
    $taskList = Join-Path $taskRoot 'FILES.sha256'
    $taskExpected = @{}
    foreach ($taskLine in [IO.File]::ReadAllLines($taskList)) {
        if (-not $taskLine.Trim()) { continue }
        if ($taskLine -notmatch '^([a-fA-F0-9]{64})  (.+)$') { throw 'INVALID_CHECKSUM_LIST' }
        $taskHash = $Matches[1].ToLowerInvariant()
        $taskRelative = $Matches[2].Replace('/','\')
        if ([IO.Path]::IsPathRooted($taskRelative) -or @($taskRelative.Split('\') | Where-Object { $_ -eq '..' -or $_ -eq '' }).Count -gt 0) { throw 'UNSAFE_CHECKSUM_PATH' }
        if ($taskExpected.ContainsKey($taskRelative)) { throw 'DUPLICATE_CHECKSUM_PATH' }
        $taskPath = [IO.Path]::GetFullPath((Join-Path $taskRoot $taskRelative))
        if (-not $taskPath.StartsWith($taskRoot + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'UNSAFE_CHECKSUM_PATH' }
        $taskItem = Get-Item -LiteralPath $taskPath -ErrorAction Stop
        if ($taskItem.PSIsContainer -or ($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'INVALID_PAYLOAD_FILE' }
        if ((Get-FileHash -LiteralPath $taskPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskHash) { throw ('CHECKSUM_MISMATCH: ' + $taskRelative) }
        $taskExpected[$taskRelative] = $true
    }
    if ($taskExpected.Count -eq 0) { throw 'EMPTY_CHECKSUM_LIST' }
    foreach ($taskItem in Get-ChildItem -LiteralPath $taskRoot -Force -Recurse) {
        if ($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'REPARSE_POINT_NOT_ALLOWED' }
        if ($taskItem.PSIsContainer) { continue }
        $taskRelative = $taskItem.FullName.Substring($taskRoot.Length + 1)
        if ($taskRelative -eq 'FILES.sha256') { continue }
        if ($AllowGeneratedProfiles -and $taskRelative.StartsWith('generated-profiles\',[StringComparison]::OrdinalIgnoreCase)) { continue }
        if (-not $taskExpected.ContainsKey($taskRelative)) { throw ('UNEXPECTED_FILE: ' + $taskRelative) }
    }
    Write-Host ('SHA256 verification passed: ' + $taskExpected.Count + ' files.')
    exit 0
} catch {
    Write-Error ('Package verification failed: ' + $_.Exception.Message)
    exit 1
}

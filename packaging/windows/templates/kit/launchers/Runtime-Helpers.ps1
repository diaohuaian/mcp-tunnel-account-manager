#Requires -Version 5.1
Set-StrictMode -Version 2.0

function Get-McpNode {
    param([string]$BundleRoot, [int]$MinimumMajor = 22, [version]$MinimumVersion = '22.14.0')
    $taskCandidates = @((Join-Path $BundleRoot 'console\runtime\node.exe'),(Join-Path $BundleRoot 'runtime\node\node.exe'))
    $taskCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $taskCommand) { $taskCandidates += $taskCommand.Source }
    foreach ($taskCandidate in $taskCandidates) {
        if (-not (Test-Path -LiteralPath $taskCandidate -PathType Leaf)) { continue }
        try {
            $taskVersion = @(& $taskCandidate --version 2>$null)
            if ($LASTEXITCODE -eq 0 -and $taskVersion.Count -eq 1 -and $taskVersion[0] -match '^v(\d+\.\d+\.\d+)') {
                $taskParsed = [version]$Matches[1]
                if ($taskParsed.Major -ge $MinimumMajor -and $taskParsed -ge $MinimumVersion) { return (Get-Item -LiteralPath $taskCandidate).FullName }
            }
        } catch { }
    }
    throw ('需要 Node.js ' + $MinimumVersion + '+。请完整解压，检查 console/runtime/node.exe，或安装 Node.js。')
}

function Get-McpPython {
    $taskCandidates = @(Get-Command python.exe, python3.exe, py.exe -CommandType Application -ErrorAction SilentlyContinue)
    $taskProbe = "import sys; print(sys.executable); print('.'.join(map(str,sys.version_info[:3])))"
    foreach ($taskCandidate in $taskCandidates) {
        try {
            $taskArgs = @('-c',$taskProbe)
            if ($taskCandidate.Name -ieq 'py.exe') { $taskArgs = @('-3') + $taskArgs }
            $taskReply = @(& $taskCandidate.Source @taskArgs 2>$null)
            if ($LASTEXITCODE -ne 0 -or $taskReply.Count -ne 2) { continue }
            $taskVersion = [version]$taskReply[1]
            if ($taskVersion.Major -eq 3 -and $taskVersion.Minor -ge 9 -and (Test-Path -LiteralPath $taskReply[0] -PathType Leaf)) {
                return (Get-Item -LiteralPath $taskReply[0]).FullName
            }
        } catch { }
    }
    throw '需要可运行的 Python 3.9+。应用商店占位命令不算已安装；请安装 Python 或 py 启动器。'
}

function Join-McpCommand {
    param([Parameter(Mandatory=$true)][string[]]$Arguments)
    $taskQuoted = foreach ($taskArgument in $Arguments) {
        if ($taskArgument.IndexOfAny([char[]]@([char]0,[char]10,[char]13)) -ge 0) { throw '无效的程序参数。' }
        # tunnel-client v0.0.19 has its own quote/backslash parser, not cmd.exe.
        '"' + $taskArgument.Replace('\','\\').Replace('"','\"') + '"'
    }
    return ($taskQuoted -join ' ')
}

#Requires -Version 5.1
Set-StrictMode -Version 2.0

function Get-McpNode {
    param([string]$BundleRoot, [int]$MinimumMajor = 18)
    $taskCandidates = @((Join-Path $BundleRoot 'runtime\node\node.exe'))
    $taskCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $taskCommand) { $taskCandidates += $taskCommand.Source }
    foreach ($taskCandidate in $taskCandidates) {
        if (-not (Test-Path -LiteralPath $taskCandidate -PathType Leaf)) { continue }
        try {
            $taskVersion = @(& $taskCandidate --version 2>$null)
            $taskStatus = $LASTEXITCODE
            if ($taskStatus -eq 0 -and $taskVersion.Count -eq 1 -and $taskVersion[0] -match '^v(\d+)\.\d+\.\d+') {
                if ([int]$Matches[1] -ge $MinimumMajor) { return (Get-Item -LiteralPath $taskCandidate).FullName }
            }
        } catch { }
    }
    throw ('需要可运行的 Node.js ' + $MinimumMajor + '+。请安装后重试，或检查包内 runtime/node/node.exe。')
}

function Get-McpPython {
    $taskCandidates = @(Get-Command python.exe, python3.exe, py.exe -CommandType Application -ErrorAction SilentlyContinue)
    $taskProbe = 'import sys,json; print(json.dumps({\"exe\":sys.executable,\"version\":list(sys.version_info[:3])}))'
    foreach ($taskCandidate in $taskCandidates) {
        try {
            $taskArgs = @('-c', $taskProbe)
            if ($taskCandidate.Name -ieq 'py.exe') { $taskArgs = @('-3') + $taskArgs }
            $taskReply = @(& $taskCandidate.Source @taskArgs 2>$null)
            $taskStatus = $LASTEXITCODE
            if ($taskStatus -ne 0 -or $taskReply.Count -ne 1) { continue }
            $taskRuntime = $taskReply[0] | ConvertFrom-Json
            if ($taskRuntime.version[0] -eq 3 -and $taskRuntime.version[1] -ge 9 -and (Test-Path -LiteralPath $taskRuntime.exe -PathType Leaf)) {
                return (Get-Item -LiteralPath $taskRuntime.exe).FullName
            }
        } catch { }
    }
    throw '需要可运行的 Python 3.9+。Windows 应用商店占位命令不算已安装；请安装 Python 或 py 启动器后重试。'
}

function Join-McpCommand {
    param([Parameter(Mandatory=$true)][string[]]$Arguments)
    $taskQuoted = foreach ($taskArgument in $Arguments) {
        if ($taskArgument.IndexOfAny([char[]]@([char]0,[char]10,[char]13)) -ge 0) { throw '无效的程序参数。' }
        # tunnel-client v0.0.19 uses its own quote/backslash parser, not cmd.exe.
        '"' + $taskArgument.Replace('\','\\').Replace('"','\"') + '"'
    }
    return ($taskQuoted -join ' ')
}

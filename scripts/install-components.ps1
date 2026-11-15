#Requires -Version 5.1
<#
.SYNOPSIS
    一键安装 MCP Tunnel 控制台所需的外部组件：tunnel-client、overleaf-mcp、antigravity-mcp。

.DESCRIPTION
    只从官方/固定来源下载固定版本，校验 SHA256 或 npm integrity 后安装到当前用户可写目录。
    不修改系统级环境变量，不写入 D:\Mcp 等外部生产目录，不需要管理员权限。

    安装位置与控制台默认读取位置一致（见 README「安装路径」）：
      tunnel-client   %USERPROFILE%\.openai-tunnel\tunnel-client.exe
      overleaf-mcp    %USERPROFILE%\.overleaf-mcp\runtime\node_modules\mcp-server-overleaf
      antigravity-mcp %USERPROFILE%\.antigravity-mcp\venv  +  .antigravity-mcp\app（固定 commit 源码）
      隧道配置        %APPDATA%\tunnel-client\overleaf.yaml / antigravity-local.yaml

    可重复运行：已安装且版本一致时跳过；-Force 强制重装。
    失败时以非零退出码结束。已存在的用户文件（tunnel.env、启动脚本、个人隧道配置）不会被删除。

.PARAMETER Component
    要安装的组件，可多选：all（默认）、tunnel-client、overleaf-mcp、antigravity-mcp。

.PARAMETER ProfileRoot
    用户配置根目录，默认 $env:USERPROFILE。仅用于隔离测试。

.PARAMETER AppDataRoot
    漫游配置根目录，默认 $env:APPDATA。仅用于隔离测试。

.PARAMETER Force
    即使已安装同版本也重新安装（不会删除用户文件）。

.PARAMETER VerifyOnly
    只检查已安装版本、入口与隧道配置，不下载、不安装。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-components.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-components.ps1 -Component overleaf-mcp,antigravity-mcp

.NOTES
    Windows 10/11 x64 + Windows PowerShell 5.1。
    overleaf-mcp 需要 Node.js >= 22.14.0；antigravity-mcp 需要 Python >= 3.9（推荐 3.12）。
#>
[CmdletBinding()]
param(
    [ValidateSet('all', 'tunnel-client', 'overleaf-mcp', 'antigravity-mcp')]
    [string[]]$Component = @('all'),

    [string]$ProfileRoot = $env:USERPROFILE,

    [string]$AppDataRoot = '',

    [switch]$Force,

    [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ---------------------------------------------------------------------------
# 固定版本与校验值（升级时同步修改这里）
# ---------------------------------------------------------------------------
$script:TunnelClientVersion = '0.0.19'
$script:TunnelClientUrl = 'https://github.com/openai/tunnel-client/releases/download/v0.0.19/tunnel-client-v0.0.19-windows-amd64.zip'
$script:TunnelClientSha256 = '1d0ecc3a54f2a51e27a635ac155f40fbb95df58c52cdeddf6c75532cc0bbeb25'

$script:OverleafPackage = 'mcp-server-overleaf'
$script:OverleafVersion = '0.3.9'
$script:OverleafIntegrity = 'sha512-j+NsA9bWyyNHM5hUqdn1+aAmGBiYvs4Rlslwi/BEoP/vfs3Gy8OXh51WMG/8cIKV+e0BMFsMFH+d4Exu+OyNPg=='
$script:OverleafNodeMinimum = '22.14.0'

$script:AntigravityRepo = 'https://github.com/zwsxzy/antigravity-mcp-fork'
$script:AntigravityCommit = '02df3ed95aae0c5103f5db7b332d0c4e6f1eec50'
$script:AntigravityVersion = '1.1.0.post1'
$script:AntigravityUrl = 'https://codeload.github.com/zwsxzy/antigravity-mcp-fork/tar.gz/02df3ed95aae0c5103f5db7b332d0c4e6f1eec50'
$script:AntigravitySha256 = '1fec6740ac07a0202e92ba8bc657ce35de2b9726feb29d36ee9c15723b79a921'
$script:AntigravityPythonMinimum = '3.9'

# ---------------------------------------------------------------------------
# 输出
# ---------------------------------------------------------------------------
function Write-Step { param([string]$Message) Write-Host ''; Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok { param([string]$Message) Write-Host "    [OK]   $Message" -ForegroundColor Green }
function Write-Info { param([string]$Message) Write-Host "    [INFO] $Message" -ForegroundColor Gray }
function Write-Warn { param([string]$Message) Write-Host "    [WARN] $Message" -ForegroundColor Yellow }
function Write-Fail { param([string]$Message) Write-Host "    [FAIL] $Message" -ForegroundColor Red }

# ---------------------------------------------------------------------------
# 原生命令执行：Windows PowerShell 5.1 在 $ErrorActionPreference='Stop' 时会把
# 正常 stderr（例如 npm/pip 的 warning）升级为 NativeCommandError。这里在调用期间
# 临时降级 EAP，调用后立即取真实退出码，再把两者交回调用方判断。
# ---------------------------------------------------------------------------
function Format-NativeArgumentString {
    # CommandLineToArgvW 规则：含空格/制表符/引号或为空时才加引号，
    # 引号前的反斜杠按 2n+1 转义，末尾反斜杠按 2n 转义，保证路径仍是单一参数。
    param([string[]]$Arguments = @())
    $parts = @()
    foreach ($argument in $Arguments) {
        if ($null -eq $argument) { continue }
        if ($argument -ne '' -and $argument -notmatch '[\s"]') { $parts += $argument; continue }
        if ($argument -eq '') { $parts += '""'; continue }
        $builder = New-Object System.Text.StringBuilder
        [void]$builder.Append('"')
        $backslashes = 0
        foreach ($character in $argument.ToCharArray()) {
            if ($character -eq [char]'\') { $backslashes++; continue }
            if ($character -eq [char]'"') {
                if ($backslashes -gt 0) { [void]$builder.Append(('\' * (($backslashes * 2) + 1))) }
                else { [void]$builder.Append('\') }
                [void]$builder.Append('"')
                $backslashes = 0
                continue
            }
            if ($backslashes -gt 0) { [void]$builder.Append(('\' * $backslashes)); $backslashes = 0 }
            [void]$builder.Append($character)
        }
        if ($backslashes -gt 0) { [void]$builder.Append(('\' * ($backslashes * 2))) }
        [void]$builder.Append('"')
        $parts += $builder.ToString()
    }
    return ($parts -join ' ')
}

function Get-DescendantProcessIds {
    # 仅用于超时后清理本调用自己启动的子进程树，绝不按名称匹配共享进程。
    param([int[]]$ParentIds = @())
    $result = @()
    if ($ParentIds.Count -eq 0) { return $result }
    $snapshot = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Select-Object ProcessId, ParentProcessId)
    $frontier = @($ParentIds)
    while ($frontier.Count -gt 0) {
        $next = @()
        foreach ($candidate in $snapshot) {
            if ($frontier -contains [int]$candidate.ParentProcessId) {
                $childId = [int]$candidate.ProcessId
                if (($result -notcontains $childId) -and ($ParentIds -notcontains $childId)) { $next += $childId }
            }
        }
        $next = @($next | Select-Object -Unique)
        if ($next.Count -eq 0) { break }
        $result += $next
        $frontier = $next
    }
    return $result
}

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [int]$TimeoutSeconds = 0,
        [string]$WorkingDirectory = ''
    )

    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
        return [pscustomobject]@{ ExitCode = -1; Output = "可执行文件不存在：$FilePath"; TimedOut = $false }
    }

    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $lines = @()
    $exitCode = $null
    $timedOut = $false
    try {
        if ($TimeoutSeconds -le 0) {
            $raw = & $FilePath @Arguments 2>&1
            $exitCode = $LASTEXITCODE
            if ($null -ne $raw) {
                foreach ($item in @($raw)) {
                    if ($null -eq $item) { continue }
                    if ($item -is [System.Management.Automation.ErrorRecord]) { $lines += $item.ToString() }
                    else { $lines += [string]$item }
                }
            }
        } else {
            # 不用 Start-Process：它会为子进程重建环境字典，遇到 NO_PROXY/no_proxy 这类
            # 仅大小写不同的重复键会抛 "Item has already been added"。
            # .NET Framework 4.8 的 ProcessStartInfo.EnvironmentVariables 又是只读且初始为 null，
            # 无法显式重建；直接使用 ProcessStartInfo 时子进程继承父进程环境块，
            # 重复键按原样传递，实测在本机（同时存在 NO_PROXY 与 no_proxy）可正常启动子进程。
            $psi = New-Object System.Diagnostics.ProcessStartInfo
            $psi.FileName = $FilePath
            $psi.Arguments = (Format-NativeArgumentString -Arguments $Arguments)
            if ($WorkingDirectory) { $psi.WorkingDirectory = $WorkingDirectory }
            $psi.UseShellExecute = $false
            $psi.CreateNoWindow = $true
            $psi.RedirectStandardOutput = $true
            $psi.RedirectStandardError = $true
            $process = New-Object System.Diagnostics.Process
            $process.StartInfo = $psi
            [void]$process.Start()
            $stdoutTask = $process.StandardOutput.ReadToEndAsync()
            $stderrTask = $process.StandardError.ReadToEndAsync()
            if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
                $timedOut = $true
                $ownedIds = @(Get-DescendantProcessIds -ParentIds @([int]$process.Id))
                try { $process.Kill() } catch { }
                [void]$process.WaitForExit(5000)
                foreach ($ownedId in ($ownedIds | Sort-Object -Descending)) {
                    try { Stop-Process -Id $ownedId -Force -ErrorAction Stop } catch { }
                }
                $exitCode = 124
            } else {
                $exitCode = $process.ExitCode
            }
            $stdoutText = ''
            $stderrText = ''
            try { $stdoutText = $stdoutTask.Result } catch { }
            try { $stderrText = $stderrTask.Result } catch { }
            $process.Dispose()
            foreach ($chunk in @($stdoutText, $stderrText)) {
                if ($chunk) { $lines += ($chunk -split "`r?`n") }
            }
        }
    } catch {
        $lines += $_.Exception.Message
        $exitCode = -1
    } finally {
        $ErrorActionPreference = $previous
    }

    if ($null -eq $exitCode) { $exitCode = -1 }
    $text = (($lines | Where-Object { $null -ne $_ -and ([string]$_).Trim() -ne '' }) -join [Environment]::NewLine).Trim()
    return [pscustomobject]@{ ExitCode = [int]$exitCode; Output = $text; TimedOut = $timedOut }
}

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-VersionAtLeast {
    param(
        [Parameter(Mandatory = $true)][string]$Actual,
        [Parameter(Mandatory = $true)][string]$Minimum
    )
    $clean = ($Actual -replace '^[vV]', '') -replace '[^0-9.].*$', ''
    $actualParts = @()
    foreach ($piece in $clean.Split('.')) { if ($piece -eq '') { $actualParts += 0 } else { $actualParts += [int]$piece } }
    while ($actualParts.Count -lt 3) { $actualParts += 0 }
    $minParts = @()
    foreach ($piece in $Minimum.Split('.')) { if ($piece -eq '') { $minParts += 0 } else { $minParts += [int]$piece } }
    while ($minParts.Count -lt 3) { $minParts += 0 }
    for ($i = 0; $i -lt 3; $i++) {
        if ($actualParts[$i] -gt $minParts[$i]) { return $true }
        if ($actualParts[$i] -lt $minParts[$i]) { return $false }
    }
    return $true
}

function Invoke-VerifiedDownload {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256
    )
    $parent = Split-Path -Parent $Destination
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    $temp = "$Destination.partial"
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
    Write-Info "下载 $Url"
    try {
        Invoke-WebRequest -Uri $Url -OutFile $temp -UseBasicParsing -ErrorAction Stop
    } catch {
        if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
        throw "下载失败：$Url（$($_.Exception.Message)）"
    }
    $actual = Get-Sha256 -Path $temp
    if ($actual -ne $ExpectedSha256.ToLowerInvariant()) {
        Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
        throw "SHA256 校验失败：期望 $ExpectedSha256，实际 $actual。已删除下载文件，未安装任何内容。"
    }
    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force }
    Move-Item -LiteralPath $temp -Destination $Destination
    Write-Ok "SHA256 校验通过：$actual"
    return $actual
}

function Remove-TreeSafely {
    # 超长路径（>260）时普通 cmdlet 会失败；用 \\?\ 前缀重试一次。
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    try { Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop; return } catch { }
    $full = [IO.Path]::GetFullPath($Path)
    if ($full.StartsWith('\\?\')) { throw "无法删除目录：$Path" }
    $prefixed = '\\?\' + $full
    Remove-Item -LiteralPath $prefixed -Recurse -Force -ErrorAction Stop
}

function Expand-ZipArchive {
    param([Parameter(Mandatory = $true)][string]$Archive, [Parameter(Mandatory = $true)][string]$Destination)
    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($Archive, $Destination)
}

function Expand-TarGzArchive {
    param([Parameter(Mandatory = $true)][string]$Archive, [Parameter(Mandatory = $true)][string]$Destination)
    $tar = Get-Command -Name 'tar.exe' -ErrorAction SilentlyContinue
    if (-not $tar) { throw '系统缺少 tar.exe（Windows 10 1809 及以上自带）。请升级 Windows 后重试。' }
    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    $result = Invoke-NativeCommand -FilePath $tar.Source -Arguments @('-xzf', $Archive, '-C', $Destination) -TimeoutSeconds 120
    if ($result.ExitCode -ne 0) { throw "解压失败：$Archive（tar 退出码 $($result.ExitCode)：$($result.Output)）" }
}

# ---------------------------------------------------------------------------
# 状态记录
# ---------------------------------------------------------------------------
function Get-StatePath { return (Join-Path (Join-Path $script:ResolvedProfileRoot '.mcp-tunnel-kit') 'install-state.json') }

function Read-InstallState {
    $path = Get-StatePath
    if (-not (Test-Path -LiteralPath $path)) {
        return [pscustomobject]@{ schemaVersion = 1; components = [pscustomobject]@{} }
    }
    try {
        $parsed = (Get-Content -LiteralPath $path -Raw -Encoding UTF8) | ConvertFrom-Json
        if (-not $parsed.components) {
            $parsed | Add-Member -NotePropertyName components -NotePropertyValue ([pscustomobject]@{}) -Force
        }
        return $parsed
    } catch {
        Write-Warn "安装状态文件无法解析，将重建：$path"
        return [pscustomobject]@{ schemaVersion = 1; components = [pscustomobject]@{} }
    }
}

function Save-InstallState {
    param([Parameter(Mandatory = $true)]$State)
    $path = Get-StatePath
    $dir = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $State | Add-Member -NotePropertyName updatedAt -NotePropertyValue ((Get-Date).ToUniversalTime().ToString('o')) -Force
    $State | Add-Member -NotePropertyName profileRoot -NotePropertyValue $script:ResolvedProfileRoot -Force
    $State | Add-Member -NotePropertyName appDataRoot -NotePropertyValue $script:ResolvedAppDataRoot -Force
    [IO.File]::WriteAllText($path, ($State | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
}

function Set-ComponentState {
    param($State, [string]$Id, [hashtable]$Record)
    $merged = [ordered]@{}
    if ($State.components) {
        foreach ($prop in $State.components.PSObject.Properties) { $merged[$prop.Name] = $prop.Value }
    }
    $merged[$Id] = [pscustomobject]$Record
    $State.components = [pscustomobject]$merged
}

# ---------------------------------------------------------------------------
# 隧道配置 YAML
# ---------------------------------------------------------------------------
function ConvertTo-YamlCommandScalar {
    param([Parameter(Mandatory = $true)][string]$Command)
    return "'" + $Command.Replace("'", "''") + "'"
}

function Get-YamlCommandValue {
    param([Parameter(Mandatory = $true)][string]$Content)
    $match = [regex]::Match($Content, "(?m)^\s*command:\s*(.+?)\s*$")
    if (-not $match.Success) { return $null }
    $value = $match.Groups[1].Value.Trim()
    if ($value.Length -ge 2 -and $value.StartsWith("'") -and $value.EndsWith("'")) {
        return $value.Substring(1, $value.Length - 2).Replace("''", "'")
    }
    if ($value.Length -ge 2 -and $value.StartsWith('"') -and $value.EndsWith('"')) {
        return $value.Substring(1, $value.Length - 2)
    }
    return $value
}

function Get-CommandExecutablePath {
    param([Parameter(Mandatory = $true)][string]$Command)
    $trimmed = $Command.Trim()
    if ($trimmed.StartsWith('"')) {
        $end = $trimmed.IndexOf('"', 1)
        if ($end -gt 1) { return $trimmed.Substring(1, $end - 1) }
        return $null
    }
    $first = ($trimmed -split '\s+')[0]
    if ([string]::IsNullOrWhiteSpace($first)) { return $null }
    return $first
}

function Write-TunnelProfile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$McpCommand
    )
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

    $commandLine = '      command: ' + (ConvertTo-YamlCommandScalar -Command $McpCommand)
    $mcpBlock = @('mcp:', '  commands:', '    - channel: main', $commandLine)

    if (-not (Test-Path -LiteralPath $Path)) {
        $lines = @(
            'config_version: 1',
            'control_plane:',
            "  base_url: 'https://api.openai.com'",
            '  tunnel_id: ""',
            "  api_key: 'env:CONTROL_PLANE_API_KEY'",
            'health:',
            "  listen_addr: '127.0.0.1:0'",
            'admin_ui:',
            '  open_browser: false',
            'log:',
            '  level: info',
            '  format: json'
        ) + $mcpBlock
        [IO.File]::WriteAllText($Path, (($lines -join [Environment]::NewLine) + [Environment]::NewLine), (New-Object System.Text.UTF8Encoding($false)))
        Write-Ok "已写入隧道配置模板（Tunnel ID 留空，稍后在控制台账号页填写）：$Path"
        return 'created'
    }

    $current = [IO.File]::ReadAllText($Path)
    if ($current -notmatch '(?m)^mcp:\s*$') {
        $merged = $current.TrimEnd() + [Environment]::NewLine + ($mcpBlock -join [Environment]::NewLine) + [Environment]::NewLine
        [IO.File]::WriteAllText($Path, $merged, (New-Object System.Text.UTF8Encoding($false)))
        Write-Ok "已向现有配置补充 mcp 段（控制面凭据保持原样）：$Path"
        return 'appended'
    }

    $existingCommand = Get-YamlCommandValue -Content $current
    if ($existingCommand -eq $McpCommand) {
        Write-Ok "隧道配置命令正确：$Path"
        return 'ok'
    }

    $existingExe = $null
    if ($existingCommand) { $existingExe = Get-CommandExecutablePath -Command $existingCommand }
    $existingExeUsable = $false
    if ($existingExe) {
        $normalized = $existingExe.Replace('/', '\')
        if (Test-Path -LiteralPath $normalized -PathType Leaf) { $existingExeUsable = $true }
        elseif (-not $normalized.Contains('\') -and (Get-Command -Name $normalized -ErrorAction SilentlyContinue)) { $existingExeUsable = $true }
    }

    if (-not $existingExeUsable) {
        $scalarLine = ConvertTo-YamlCommandScalar -Command $McpCommand
        $commandRegex = New-Object System.Text.RegularExpressions.Regex('(?m)^(\s*)command:\s*.+?$')
        $evaluator = [System.Text.RegularExpressions.MatchEvaluator]{
            param($match)
            return $match.Groups[1].Value + 'command: ' + $scalarLine
        }
        $replaced = $commandRegex.Replace($current, $evaluator, 1)
        [IO.File]::WriteAllText($Path, $replaced, (New-Object System.Text.UTF8Encoding($false)))
        Write-Warn "原命令指向的程序不存在，已改为安装路径（其余配置保留）：$Path"
        return 'repaired'
    }

    $suggested = $Path + '.suggested'
    $body = @(
        '# 安装器建议的 mcp 命令（当前配置的命令与本次安装路径不同，但原程序仍存在）',
        ($mcpBlock -join [Environment]::NewLine)
    ) -join [Environment]::NewLine
    [IO.File]::WriteAllText($suggested, ($body + [Environment]::NewLine), (New-Object System.Text.UTF8Encoding($false)))
    Write-Warn "现有配置里的 MCP 命令与本次安装路径不同，未自动改动：$Path"
    Write-Warn "如需切换，可参考：$suggested"
    return 'differs'
}

function Test-TunnelProfileCommand {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$ExpectedCommand)
    if (-not (Test-Path -LiteralPath $Path)) { return [pscustomobject]@{ Ok = $false; Reason = '配置文件不存在' } }
    $content = [IO.File]::ReadAllText($Path)
    if ($content -notmatch '(?m)^mcp:\s*$') { return [pscustomobject]@{ Ok = $false; Reason = '配置缺少 mcp 段' } }
    $actual = Get-YamlCommandValue -Content $content
    if ($actual -eq $ExpectedCommand) { return [pscustomobject]@{ Ok = $true; Reason = '命令一致' } }
    $exe = $null
    if ($actual) { $exe = Get-CommandExecutablePath -Command $actual }
    if ($exe -and (Test-Path -LiteralPath $exe.Replace('/', '\'))) {
        return [pscustomobject]@{ Ok = $true; Reason = "命令与本机安装不同但目标程序存在：$actual" }
    }
    return [pscustomobject]@{ Ok = $false; Reason = "命令不可用：$actual" }
}

function Format-CommandToken {
    param([Parameter(Mandatory = $true)][string]$Value)
    $posix = $Value.Replace('\', '/')
    if ($posix -match '\s') { return '"' + $posix + '"' }
    return $posix
}

# ---------------------------------------------------------------------------
# 组件：tunnel-client
# ---------------------------------------------------------------------------
function Install-TunnelClient {
    param($State)

    Write-Step "tunnel-client v$($script:TunnelClientVersion)（OpenAI 官方固定兼容版本，非最新版）"

    $tunnelHome = Join-Path $script:ResolvedProfileRoot '.openai-tunnel'
    $exe = Join-Path $tunnelHome 'tunnel-client.exe'
    $recorded = $State.components.'tunnel-client'

    if ($VerifyOnly) {
        if (-not (Test-Path -LiteralPath $exe)) { Write-Fail "未安装：$exe"; return $false }
        $probe = Invoke-NativeCommand -FilePath $exe -Arguments @('--version') -TimeoutSeconds 20
        if ($probe.ExitCode -ne 0) { Write-Fail "无法运行 --version（退出码 $($probe.ExitCode)）：$($probe.Output)"; return $false }
        if ($probe.Output -match [regex]::Escape($script:TunnelClientVersion)) { Write-Ok "版本：$($probe.Output)"; return $true }
        Write-Fail "版本不符：$($probe.Output)"; return $false
    }

    if (-not $Force -and (Test-Path -LiteralPath $exe) -and $recorded -and $recorded.version -eq $script:TunnelClientVersion) {
        Write-Ok "已安装 v$($recorded.version)，跳过下载与覆盖（-Force 可强制重装）"
        return $true
    }

    $cache = Join-Path (Join-Path $script:ResolvedProfileRoot '.mcp-tunnel-kit') 'cache'
    $archive = Join-Path $cache "tunnel-client-v$($script:TunnelClientVersion)-windows-amd64.zip"
    if ((Test-Path -LiteralPath $archive) -and (Get-Sha256 -Path $archive) -eq $script:TunnelClientSha256) {
        Write-Ok "复用已校验的安装包缓存：$archive"
    } else {
        [void](Invoke-VerifiedDownload -Url $script:TunnelClientUrl -Destination $archive -ExpectedSha256 $script:TunnelClientSha256)
    }

    $staging = Join-Path $cache 'tc-stage'
    Expand-ZipArchive -Archive $archive -Destination $staging
    $stagedExe = Get-ChildItem -LiteralPath $staging -Recurse -Filter 'tunnel-client.exe' -File | Select-Object -First 1
    if (-not $stagedExe) { throw "安装包内未找到 tunnel-client.exe：$archive" }
    $sourceRoot = Split-Path -Parent $stagedExe.FullName

    # 只覆盖发行包内的程序与伴随资源；目录本身和其它文件（tunnel.env、启动脚本、个人配置）一律保留。
    $allowedNames = @('tunnel-client.exe', 'cloudflared.exe', 'cloudflared-manifest.json', 'LICENSE', 'NOTICE')
    $allowedPatterns = @('*-licenses.txt', '*.spdx.json', '*.sigstore.json', '*.openvex.json')
    $copied = @()
    $preserved = 0
    if (-not (Test-Path -LiteralPath $tunnelHome)) { New-Item -ItemType Directory -Force -Path $tunnelHome | Out-Null }
    else { $preserved = (Get-ChildItem -LiteralPath $tunnelHome -Force | Measure-Object).Count }

    foreach ($item in Get-ChildItem -LiteralPath $sourceRoot -File -Force) {
        $allowed = $allowedNames -contains $item.Name
        if (-not $allowed) {
            foreach ($pattern in $allowedPatterns) { if ($item.Name -like $pattern) { $allowed = $true; break } }
        }
        if (-not $allowed) { continue }
        Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $tunnelHome $item.Name) -Force
        $copied += $item.Name
    }
    if ($copied.Count -eq 0) { throw "安装包内没有可安装的发行文件：$sourceRoot" }
    Remove-TreeSafely -Path $staging

    if (-not (Test-Path -LiteralPath $exe)) { throw "安装后未找到 $exe" }
    Write-Ok ("已覆盖 {0} 个发行文件：{1}" -f $copied.Count, ($copied -join ', '))
    if ($preserved -gt 0) { Write-Info "保留了目录中已有的 $preserved 个其它条目（含用户配置/启动脚本）" }

    $versionOutput = ''
    $probe = Invoke-NativeCommand -FilePath $exe -Arguments @('--version') -TimeoutSeconds 20
    if ($probe.ExitCode -eq 0) { $versionOutput = $probe.Output }
    if ($versionOutput -notmatch [regex]::Escape($script:TunnelClientVersion)) {
        Write-Warn "无法从 --version 输出确认版本（退出码 $($probe.ExitCode)，输出：$versionOutput）。安装包已通过固定 SHA256 校验。"
    } else {
        Write-Ok "版本自检：$versionOutput"
    }

    Set-ComponentState -State $State -Id 'tunnel-client' -Record @{
        version = $script:TunnelClientVersion
        path = $exe
        home = $tunnelHome
        sha256 = $script:TunnelClientSha256
        source = $script:TunnelClientUrl
        installedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    Write-Ok "已安装：$exe"
    return $true
}

# ---------------------------------------------------------------------------
# 组件：overleaf-mcp
# ---------------------------------------------------------------------------
function Resolve-NodeTool {
    foreach ($candidate in @(Get-Command -Name 'node.exe' -ErrorAction SilentlyContinue)) {
        if ($candidate -and $candidate.Source) { return [string]$candidate.Source }
    }
    foreach ($candidate in @(Get-Command -Name 'node' -ErrorAction SilentlyContinue)) {
        if ($candidate -and $candidate.Source) { return [string]$candidate.Source }
    }
    return $null
}

function Resolve-NpmTool {
    foreach ($candidate in @(Get-Command -Name 'npm.cmd' -ErrorAction SilentlyContinue)) {
        if ($candidate -and $candidate.Source) { return [string]$candidate.Source }
    }
    foreach ($candidate in @(Get-Command -Name 'npm' -ErrorAction SilentlyContinue)) {
        if ($candidate -and $candidate.Source) { return [string]$candidate.Source }
    }
    return $null
}

function Get-OverleafCommand {
    param([Parameter(Mandatory = $true)][string]$NodeExe, [Parameter(Mandatory = $true)][string]$EntryPath)
    return (Format-CommandToken -Value $NodeExe) + ' ' + (Format-CommandToken -Value $EntryPath) + ' --stdio'
}

function Install-OverleafMcp {
    param($State)

    Write-Step "overleaf-mcp（npm $($script:OverleafPackage)@$($script:OverleafVersion)）"

    $runtime = Join-Path (Join-Path $script:ResolvedProfileRoot '.overleaf-mcp') 'runtime'
    $entry = Join-Path $runtime "node_modules\$($script:OverleafPackage)\dist\index.js"
    $packageManifest = Join-Path $runtime "node_modules\$($script:OverleafPackage)\package.json"
    $yamlPath = Join-Path (Join-Path $script:ResolvedAppDataRoot 'tunnel-client') 'overleaf.yaml'
    $recorded = $State.components.'overleaf-mcp'

    $nodeExe = Resolve-NodeTool

    if ($VerifyOnly) {
        if (-not (Test-Path -LiteralPath $entry)) { Write-Fail "未安装入口：$entry"; return $false }
        $installedVersion = $null
        try { $installedVersion = (Get-Content -LiteralPath $packageManifest -Raw | ConvertFrom-Json).version } catch { $installedVersion = $null }
        if ($installedVersion -ne $script:OverleafVersion) { Write-Fail "版本不符：期望 $($script:OverleafVersion)，实际 $installedVersion"; return $false }
        Write-Ok "已安装版本：$installedVersion"
        if (-not $nodeExe) { Write-Fail '未找到 Node.js，无法确认命令可用'; return $false }
        $expected = Get-OverleafCommand -NodeExe $nodeExe -EntryPath $entry
        $configCheck = Test-TunnelProfileCommand -Path $yamlPath -ExpectedCommand $expected
        if (-not $configCheck.Ok) { Write-Fail "隧道配置不可用：$($configCheck.Reason)"; return $false }
        Write-Ok "隧道配置：$($configCheck.Reason)"
        return $true
    }

    if (-not $Force -and (Test-Path -LiteralPath $entry) -and $recorded -and $recorded.version -eq $script:OverleafVersion) {
        Write-Ok "已安装 v$($recorded.version)，跳过下载"
    } else {
        if (-not $nodeExe) { throw "未找到 Node.js。请先安装 Node.js >= $($script:OverleafNodeMinimum)（https://nodejs.org/），再重新运行本脚本。" }
        $nodeProbe = Invoke-NativeCommand -FilePath $nodeExe -Arguments @('--version') -TimeoutSeconds 20
        if ($nodeProbe.ExitCode -ne 0) { throw "无法运行 node --version（退出码 $($nodeProbe.ExitCode)）：$($nodeProbe.Output)" }
        $nodeVersion = $nodeProbe.Output.Trim()
        if (-not (Test-VersionAtLeast -Actual $nodeVersion -Minimum $script:OverleafNodeMinimum)) {
            throw "Node.js 版本过低：$nodeVersion，需要 >= $($script:OverleafNodeMinimum)。"
        }
        Write-Ok "Node.js $nodeVersion"

        $npmExe = Resolve-NpmTool
        if (-not $npmExe) { throw '未找到 npm.cmd。请重新安装 Node.js（包含 npm）后重试。' }

        if (-not (Test-Path -LiteralPath $runtime)) { New-Item -ItemType Directory -Force -Path $runtime | Out-Null }

        $packageJson = [ordered]@{
            name = 'mcp-tunnel-overleaf-runtime'
            version = '1.0.0'
            private = $true
            description = 'Pinned runtime for mcp-server-overleaf used by MCP Tunnel Account Manager.'
            dependencies = [ordered]@{ $script:OverleafPackage = $script:OverleafVersion }
        }
        [IO.File]::WriteAllText((Join-Path $runtime 'package.json'), ($packageJson | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))

        Write-Info "npm install（prefix=`"$runtime`"）"
        $npmCache = Join-Path (Join-Path $script:ResolvedProfileRoot '.mcp-tunnel-kit') 'npm-cache'
        if (-not (Test-Path -LiteralPath $npmCache)) { New-Item -ItemType Directory -Force -Path $npmCache | Out-Null }
        $previousNpmCache = $env:npm_config_cache
        $env:npm_config_cache = $npmCache
        try {
            $npmResult = Invoke-NativeCommand -FilePath $npmExe -Arguments @('install', '--no-audit', '--no-fund', '--omit=dev', '--ignore-scripts', '--loglevel=error') -TimeoutSeconds 600 -WorkingDirectory $runtime
        } finally {
            [Environment]::SetEnvironmentVariable('npm_config_cache', $previousNpmCache, 'Process')
        }
        if ($npmResult.Output) { foreach ($line in ($npmResult.Output -split "`r?`n")) { if ($line.Trim()) { Write-Info $line.Trim() } } }
        if ($npmResult.ExitCode -ne 0) { throw "npm install 失败（退出码 $($npmResult.ExitCode)）" }

        if (-not (Test-Path -LiteralPath $entry)) { throw "安装后未找到入口文件：$entry" }
        $installedVersion = (Get-Content -LiteralPath $packageManifest -Raw | ConvertFrom-Json).version
        if ($installedVersion -ne $script:OverleafVersion) {
            throw "版本不符：期望 $($script:OverleafVersion)，实际 $installedVersion"
        }
        Write-Ok "已安装版本：$installedVersion"

        $lockPath = Join-Path $runtime 'package-lock.json'
        if (Test-Path -LiteralPath $lockPath) {
            # Windows PowerShell 5.1 的 ConvertFrom-Json 无法处理 package-lock 的空字符串键，
            # 且 5.1 传给原生程序的内嵌双引号会被破坏，因此把探针写成独立脚本再执行。
            $probeFile = Join-Path $runtime '.integrity-probe.cjs'
            $probeSource = @'
const lock = require(process.argv[2]);
const entry = lock.packages && lock.packages['node_modules/mcp-server-overleaf'];
process.stdout.write((entry && entry.integrity) || '');
'@
            [IO.File]::WriteAllText($probeFile, $probeSource, (New-Object System.Text.UTF8Encoding($false)))
            try {
                $integrityProbe = Invoke-NativeCommand -FilePath $nodeExe -Arguments @($probeFile, $lockPath) -TimeoutSeconds 60
            } finally {
                Remove-Item -LiteralPath $probeFile -Force -ErrorAction SilentlyContinue
            }
            $lockIntegrity = $integrityProbe.Output.Trim()
            if ($integrityProbe.ExitCode -ne 0) {
                Write-Warn "读取 package-lock.json 失败，已跳过 integrity 比对：$lockIntegrity"
            } elseif ([string]::IsNullOrWhiteSpace($lockIntegrity)) {
                Write-Warn 'package-lock.json 中未找到 integrity 字段，已跳过 integrity 比对。'
            } elseif ($lockIntegrity -ne $script:OverleafIntegrity) {
                throw "npm integrity 与固定值不一致：期望 $($script:OverleafIntegrity)，实际 $lockIntegrity"
            } else {
                Write-Ok 'npm integrity 与固定值一致'
            }
        } else {
            Write-Warn '未生成 package-lock.json，已跳过 integrity 比对。'
        }
    }

    if (-not $nodeExe) { throw '未找到 Node.js，无法生成隧道命令。' }
    $command = Get-OverleafCommand -NodeExe $nodeExe -EntryPath $entry
    $yamlResult = Write-TunnelProfile -Path $yamlPath -McpCommand $command

    Set-ComponentState -State $State -Id 'overleaf-mcp' -Record @{
        version = $script:OverleafVersion
        path = $entry
        runtime = $runtime
        node = $nodeExe
        integrity = $script:OverleafIntegrity
        source = "https://registry.npmjs.org/$($script:OverleafPackage)/-/$($script:OverleafPackage)-$($script:OverleafVersion).tgz"
        profileYaml = $yamlPath
        profileYamlAction = $yamlResult
        command = $command
        installedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    Write-Ok "已安装：$entry"
    return $true
}

# ---------------------------------------------------------------------------
# 组件：antigravity-mcp
# ---------------------------------------------------------------------------
function Resolve-PythonTool {
    # 同名命令可能同时存在多个（例如 Anaconda 与 Windows 应用商店占位程序），逐个探测。
    $candidates = New-Object System.Collections.ArrayList
    foreach ($py in @(Get-Command -Name 'py.exe' -ErrorAction SilentlyContinue)) {
        if ($py -and $py.Source) { [void]$candidates.Add(@{ Exe = [string]$py.Source; Prefix = @('-3') }) }
    }
    foreach ($python in @(Get-Command -Name 'python.exe' -ErrorAction SilentlyContinue)) {
        if ($python -and $python.Source) { [void]$candidates.Add(@{ Exe = [string]$python.Source; Prefix = @() }) }
    }
    foreach ($python in @(Get-Command -Name 'python' -ErrorAction SilentlyContinue)) {
        if ($python -and $python.Source) { [void]$candidates.Add(@{ Exe = [string]$python.Source; Prefix = @() }) }
    }

    $seen = @{}
    foreach ($candidate in $candidates) {
        $key = ([string]$candidate.Exe).ToLowerInvariant()
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        # 5.1 传给原生程序的内嵌双引号会被破坏，这里只用无引号的 Python 代码。
        $probeArgs = @($candidate.Prefix) + @('-c', 'import sys;print(sys.version_info[0],sys.version_info[1],sys.version_info[2])')
        $probe = Invoke-NativeCommand -FilePath ([string]$candidate.Exe) -Arguments $probeArgs -TimeoutSeconds 30
        if ($probe.ExitCode -eq 0 -and $probe.Output -match '^\d+\s+\d+\s+\d+$') {
            return @{ Exe = [string]$candidate.Exe; Prefix = $candidate.Prefix; Version = (($probe.Output -split '\s+') -join '.') }
        }
    }
    return $null
}

function Get-AntigravityCommand {
    param([Parameter(Mandatory = $true)][string]$VenvPython)
    return (Format-CommandToken -Value $VenvPython) + ' -X utf8 -u -m antigravity_mcp'
}

function Install-AntigravityMcp {
    param($State)

    Write-Step "antigravity-mcp（$($script:AntigravityRepo) @ $($script:AntigravityCommit.Substring(0, 7))，零运行依赖）"

    $root = Join-Path $script:ResolvedProfileRoot '.antigravity-mcp'
    $venv = Join-Path $root 'venv'
    $venvPython = Join-Path $venv 'Scripts\python.exe'
    $appDir = Join-Path $root 'app'
    $packageDir = Join-Path $appDir 'antigravity_mcp'
    $yamlPath = Join-Path (Join-Path $script:ResolvedAppDataRoot 'tunnel-client') 'antigravity-local.yaml'
    $recorded = $State.components.'antigravity-mcp'

    if ($VerifyOnly) {
        if (-not (Test-Path -LiteralPath $venvPython)) { Write-Fail "未安装虚拟环境：$venvPython"; return $false }
        if (-not (Test-Path -LiteralPath (Join-Path $packageDir 'workflow_settings.json'))) { Write-Fail "缺少 workflow_settings.json：$packageDir"; return $false }
        $versionProbe = Invoke-NativeCommand -FilePath $venvPython -Arguments @('-c', 'import antigravity_mcp;print(antigravity_mcp.__version__)') -TimeoutSeconds 60
        if ($versionProbe.ExitCode -ne 0) { Write-Fail "导入 antigravity_mcp 失败：$($versionProbe.Output)"; return $false }
        if ($versionProbe.Output.Trim() -ne $script:AntigravityVersion) { Write-Fail "版本不符：期望 $($script:AntigravityVersion)，实际 $($versionProbe.Output.Trim())"; return $false }
        Write-Ok "已安装版本：$($versionProbe.Output.Trim())"
        $expected = Get-AntigravityCommand -VenvPython $venvPython
        $configCheck = Test-TunnelProfileCommand -Path $yamlPath -ExpectedCommand $expected
        if (-not $configCheck.Ok) { Write-Fail "隧道配置不可用：$($configCheck.Reason)"; return $false }
        Write-Ok "隧道配置：$($configCheck.Reason)"
        return $true
    }

    $needsInstall = $true
    if (-not $Force -and (Test-Path -LiteralPath $venvPython) -and (Test-Path -LiteralPath (Join-Path $packageDir '__init__.py')) -and $recorded -and $recorded.version -eq $script:AntigravityVersion) {
        $needsInstall = $false
        Write-Ok "已安装 v$($recorded.version)，跳过下载"
    }

    if ($needsInstall) {
        $python = Resolve-PythonTool
        if (-not $python) { throw "未找到可用的 Python。请先安装 Python >= $($script:AntigravityPythonMinimum)（推荐 3.12，安装时勾选 Add to PATH），再重新运行本脚本。" }
        if (-not (Test-VersionAtLeast -Actual $python.Version -Minimum $script:AntigravityPythonMinimum)) {
            throw "Python 版本过低：$($python.Version)，需要 >= $($script:AntigravityPythonMinimum)。"
        }
        Write-Ok "Python $($python.Version)（$($python.Exe)）"

        $cache = Join-Path (Join-Path $script:ResolvedProfileRoot '.mcp-tunnel-kit') 'cache'
        $archive = Join-Path $cache "antigravity-mcp-fork-$($script:AntigravityCommit.Substring(0, 7)).tar.gz"
        if ((Test-Path -LiteralPath $archive) -and (Get-Sha256 -Path $archive) -eq $script:AntigravitySha256) {
            Write-Ok "复用已校验的安装包缓存：$archive"
        } else {
            [void](Invoke-VerifiedDownload -Url $script:AntigravityUrl -Destination $archive -ExpectedSha256 $script:AntigravitySha256)
        }

        $staging = Join-Path $cache 'agy-stage'
        Expand-TarGzArchive -Archive $archive -Destination $staging
        $sourceDir = Get-ChildItem -LiteralPath $staging -Directory | Select-Object -First 1
        if (-not $sourceDir) { throw "安装包解压后为空：$archive" }
        # 归档内顶层目录名很长（含完整 commit），改名为短名以避免 Windows MAX_PATH 溢出。
        $shortSource = Join-Path $staging 'pkg'
        if ($sourceDir.Name -ne 'pkg') {
            if (Test-Path -LiteralPath $shortSource) { Remove-TreeSafely -Path $shortSource }
            Rename-Item -LiteralPath $sourceDir.FullName -NewName 'pkg'
            $sourceDir = Get-Item -LiteralPath $shortSource
        }
        $sourcePackage = Join-Path $sourceDir.FullName 'src\antigravity_mcp'
        if (-not (Test-Path -LiteralPath (Join-Path $sourcePackage '__init__.py'))) {
            throw "安装包内未找到 src\antigravity_mcp：$($sourceDir.FullName)"
        }

        # 该 fork 的 dependencies 为空、纯标准库实现，官方支持从固定源码以 stdio 启动。
        # 因此不做 pip 构建（避免 hatchling 构建隔离在 Windows 上长时间占满 CPU），
        # 直接把固定 commit 的包放入独立 app 目录，并让 venv 通过 .pth 找到它。
        if (Test-Path -LiteralPath $appDir) { Remove-TreeSafely -Path $appDir }
        New-Item -ItemType Directory -Force -Path $appDir | Out-Null
        New-Item -ItemType Directory -Force -Path $packageDir | Out-Null
        foreach ($item in Get-ChildItem -LiteralPath $sourcePackage -Force) {
            Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $packageDir $item.Name) -Recurse -Force
        }
        foreach ($extra in @('LICENSE', 'README.md', 'pyproject.toml')) {
            $extraPath = Join-Path $sourceDir.FullName $extra
            if (Test-Path -LiteralPath $extraPath) { Copy-Item -LiteralPath $extraPath -Destination (Join-Path $appDir $extra) -Force }
        }
        $sourceMarker = @{
            repository = $script:AntigravityRepo
            commit = $script:AntigravityCommit
            version = $script:AntigravityVersion
            archiveSha256 = $script:AntigravitySha256
            installedAt = (Get-Date).ToUniversalTime().ToString('o')
        }
        [IO.File]::WriteAllText((Join-Path $appDir 'SOURCE.json'), ($sourceMarker | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
        Remove-TreeSafely -Path $staging

        if (Test-Path -LiteralPath $venv) { Remove-TreeSafely -Path $venv }
        Write-Info "创建独立虚拟环境：$venv"
        $venvArgs = @($python.Prefix) + @('-m', 'venv', $venv)
        $venvResult = Invoke-NativeCommand -FilePath $python.Exe -Arguments $venvArgs -TimeoutSeconds 300
        if ($venvResult.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $venvPython)) {
            throw "创建虚拟环境失败（退出码 $($venvResult.ExitCode)）：$($venvResult.Output)"
        }

        $sitePackages = Join-Path $venv 'Lib\site-packages'
        if (-not (Test-Path -LiteralPath $sitePackages)) { New-Item -ItemType Directory -Force -Path $sitePackages | Out-Null }
        # .pth 必须纯 ASCII：site.py 在 Python <= 3.12 用 locale 编码读取它，
        # 中文用户名会让绝对路径读取失败。site-packages 到 app 的相对路径固定为 3 级上行。
        $relativeApp = '..\..\..\app'
        [IO.File]::WriteAllText((Join-Path $sitePackages '_antigravity_mcp_src.pth'), ($relativeApp + [Environment]::NewLine), (New-Object System.Text.ASCIIEncoding))
        Write-Ok "已写入源码相对路径：$relativeApp（ASCII，兼容中文用户名）"

        $versionProbe = Invoke-NativeCommand -FilePath $venvPython -Arguments @('-c', 'import antigravity_mcp;print(antigravity_mcp.__version__)') -TimeoutSeconds 60
        if ($versionProbe.ExitCode -ne 0) { throw "导入 antigravity_mcp 失败：$($versionProbe.Output)" }
        if ($versionProbe.Output.Trim() -ne $script:AntigravityVersion) {
            throw "版本不符：期望 $($script:AntigravityVersion)，实际 $($versionProbe.Output.Trim())"
        }
        Write-Ok "已安装版本：$($versionProbe.Output.Trim())"

        if (-not (Test-Path -LiteralPath (Join-Path $packageDir 'workflow_settings.json'))) {
            throw "安装后未找到 workflow_settings.json：$packageDir"
        }
        Write-Ok 'workflow_settings.json 存在'
    }

    if (-not (Test-Path -LiteralPath $venvPython)) { throw "虚拟环境缺失：$venvPython" }
    $command = Get-AntigravityCommand -VenvPython $venvPython
    $yamlResult = Write-TunnelProfile -Path $yamlPath -McpCommand $command

    Set-ComponentState -State $State -Id 'antigravity-mcp' -Record @{
        version = $script:AntigravityVersion
        path = $venvPython
        venv = $venv
        app = $appDir
        commit = $script:AntigravityCommit
        sha256 = $script:AntigravitySha256
        source = $script:AntigravityRepo
        stateDir = (Join-Path $env:LOCALAPPDATA 'antigravity-mcp')
        profileYaml = $yamlPath
        profileYamlAction = $yamlResult
        command = $command
        installedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    Write-Ok "已安装：$venvPython"
    return $true
}

# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
$script:ResolvedProfileRoot = [IO.Path]::GetFullPath($ProfileRoot)
if ([string]::IsNullOrWhiteSpace($AppDataRoot)) {
    if ($script:ResolvedProfileRoot -eq [IO.Path]::GetFullPath($env:USERPROFILE)) {
        $script:ResolvedAppDataRoot = $env:APPDATA
    } else {
        $script:ResolvedAppDataRoot = Join-Path $script:ResolvedProfileRoot 'AppData\Roaming'
    }
} else {
    $script:ResolvedAppDataRoot = [IO.Path]::GetFullPath($AppDataRoot)
}

$selected = @()
if ($Component -contains 'all') { $selected = @('tunnel-client', 'overleaf-mcp', 'antigravity-mcp') }
else { $selected = $Component | Select-Object -Unique }

Write-Host ''
Write-Host 'MCP Tunnel 组件一键安装' -ForegroundColor White
Write-Host "  用户目录：$script:ResolvedProfileRoot"
Write-Host "  配置目录：$script:ResolvedAppDataRoot"
Write-Host "  组件：$($selected -join ', ')"
if ($VerifyOnly) { Write-Host '  模式：仅检查（VerifyOnly）' -ForegroundColor Yellow }

$state = Read-InstallState
$failures = @()

foreach ($id in $selected) {
    try {
        if ($id -eq 'tunnel-client') { $ok = Install-TunnelClient -State $state }
        elseif ($id -eq 'overleaf-mcp') { $ok = Install-OverleafMcp -State $state }
        elseif ($id -eq 'antigravity-mcp') { $ok = Install-AntigravityMcp -State $state }
        else { throw "未知组件：$id" }
        if (-not $ok) { $failures += $id }
    } catch {
        Write-Fail "$id 安装失败：$($_.Exception.Message)"
        $failures += $id
    }
}

if (-not $VerifyOnly) {
    try { Save-InstallState -State $state } catch { Write-Warn "安装状态写入失败：$($_.Exception.Message)" }
}

Write-Host ''
Write-Host '安装结果' -ForegroundColor White
foreach ($id in $selected) {
    if ($failures -contains $id) { Write-Host "  [失败] $id" -ForegroundColor Red }
    else { Write-Host "  [完成] $id" -ForegroundColor Green }
}

if ($failures.Count -gt 0) {
    Write-Host ''
    Write-Host "有 $($failures.Count) 个组件未完成：$($failures -join ', ')" -ForegroundColor Red
    Write-Host '请按上面的提示处理后重新运行本脚本；已完成的组件会自动跳过。' -ForegroundColor Yellow
    exit 1
}

Write-Host ''
if ($VerifyOnly) {
    Write-Host '检查通过。' -ForegroundColor Green
} else {
    Write-Host '全部完成。下一步：' -ForegroundColor Green
    Write-Host '  1) 双击项目根目录的 Start-Console.cmd 启动控制台（默认 http://127.0.0.1:17643）'
    Write-Host '  2) 首次使用按页面提示设置管理员密码'
    Write-Host '  3) 在「账号配置」里为每个 MCP 服务填写自己的 Tunnel ID 与 Runtime API Key'
    Write-Host '  详细步骤见 README.md 的「新手配置」一节。'
}
exit 0

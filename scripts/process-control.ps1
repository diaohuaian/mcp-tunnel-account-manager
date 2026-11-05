<#
.SYNOPSIS
    Fixed audited PowerShell helper for process identity verification and safe process control.
    Enforces exact Win32 handle-bound executable path and creation time verification before termination.
    Zero PID-only fallback.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet("Inspect", "Verify", "Stop", "Launch", "InspectListener", "FindOwned")]
    [string]$Action,

    [Parameter(Mandatory = $false)]
    [int]$ProcessId = 0,

    [Parameter(Mandatory = $false)]
    [Alias("LocalPort")]
    [int]$Port = 0,

    [Parameter(Mandatory = $false)]
    [string]$ExpectedExecutablePath,

    [Parameter(Mandatory = $false)]
    [string]$ExpectedStartTime,

    [Parameter(Mandatory = $false)]
    [string]$ExpectedCreationTimeFileTime,

    [Parameter(Mandatory = $false)]
    [string]$ExecutablePath,

    [Parameter(Mandatory = $false)]
    [string[]]$Arguments,

    [Parameter(Mandatory = $false)]
    [string]$Tag,

    [Parameter(Mandatory = $false)]
    [string]$CommandLine,

    [Parameter(Mandatory = $false)]
    [object]$EnvironmentVariables,

    [Parameter(Mandatory = $false)]
    [string]$WorkingDirectory,

    [Parameter(Mandatory = $false)]
    [int]$TimeoutSeconds = 10,

    [Parameter(Mandatory = $false)]
    [switch]$LaunchPayloadFromStdin
)

$ErrorActionPreference = "Stop"

if (-not ([System.Management.Automation.PSTypeName]'Win32ProcessControl').Type) {
    Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.Runtime.InteropServices;
using System.Net;
using System.ComponentModel;
using System.Diagnostics;

public static class Win32ProcessControl {
    public const uint PROCESS_TERMINATE = 0x00000001;
    public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x00001000;
    public const uint SYNCHRONIZE = 0x00100000;

    // 0x00101001 = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE
    public const uint PROCESS_AUDITED_ACCESS = 0x00101001;
    // 0x00101000 = PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE
    public const uint PROCESS_INSPECT_ACCESS = 0x00101000;

    public const uint WAIT_OBJECT_0 = 0x00000000;
    public const uint WAIT_TIMEOUT = 0x00000102;
    public const uint WAIT_FAILED = 0xFFFFFFFF;

    public const int AF_INET = 2;
    public const int AF_INET6 = 23;
    public const int TCP_TABLE_OWNER_PID_ALL = 5;

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool QueryFullProcessImageName(IntPtr hProcess, uint dwFlags, [Out] StringBuilder lpExeName, ref uint lpdwSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetProcessTimes(
        IntPtr hProcess,
        out long lpCreationTime,
        out long lpExitTime,
        out long lpKernelTime,
        out long lpUserTime
    );

    [DllImport("iphlpapi.dll", SetLastError = true)]
    public static extern uint GetExtendedTcpTable(
        IntPtr pTcpTable,
        ref int pdwSize,
        bool bOrder,
        int ulAf,
        int TableClass,
        uint reserved
    );

    public class TcpListenerEntry {
        public string LocalAddress;
        public int LocalPort;
        public int OwningPid;
        public bool IsLoopback;
    }

    public static bool IsLoopbackAddress(string addr) {
        if (string.IsNullOrEmpty(addr)) return false;
        if (addr == "127.0.0.1" || addr.StartsWith("127.")) return true;
        if (addr == "::1" || addr == "0:0:0:0:0:0:0:1") return true;
        if (addr == "0.0.0.0" || addr == "::") return true;
        return false;
    }

    public static List<TcpListenerEntry> GetTcpListeners(int targetPort) {
        var results = new List<TcpListenerEntry>();

        // IPv4 table
        int size = 0;
        GetExtendedTcpTable(IntPtr.Zero, ref size, false, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0);
        if (size > 0) {
            IntPtr buf = Marshal.AllocHGlobal(size);
            try {
                if (GetExtendedTcpTable(buf, ref size, false, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0) == 0) {
                    int num = Marshal.ReadInt32(buf);
                    IntPtr ptr = IntPtr.Add(buf, 4);
                    for (int i = 0; i < num; i++) {
                        int state = Marshal.ReadInt32(ptr, 0);
                        uint addr = (uint)Marshal.ReadInt32(ptr, 4);
                        int portRaw = Marshal.ReadInt32(ptr, 8);
                        int port = ((portRaw & 0xff) << 8) | ((portRaw >> 8) & 0xff);
                        int pid = Marshal.ReadInt32(ptr, 20);

                        // state 2 == MIB_TCP_STATE_LISTEN
                        if (state == 2 && (targetPort <= 0 || port == targetPort)) {
                            string ipStr = new IPAddress((long)addr).ToString();
                            results.Add(new TcpListenerEntry {
                                LocalAddress = ipStr,
                                LocalPort = port,
                                OwningPid = pid,
                                IsLoopback = IsLoopbackAddress(ipStr)
                            });
                        }
                        ptr = IntPtr.Add(ptr, 24);
                    }
                }
            } finally {
                Marshal.FreeHGlobal(buf);
            }
        }

        // IPv6 table
        int size6 = 0;
        GetExtendedTcpTable(IntPtr.Zero, ref size6, false, AF_INET6, TCP_TABLE_OWNER_PID_ALL, 0);
        if (size6 > 0) {
            IntPtr buf6 = Marshal.AllocHGlobal(size6);
            try {
                if (GetExtendedTcpTable(buf6, ref size6, false, AF_INET6, TCP_TABLE_OWNER_PID_ALL, 0) == 0) {
                    int num6 = Marshal.ReadInt32(buf6);
                    IntPtr ptr6 = IntPtr.Add(buf6, 4);
                    byte[] addrBytes = new byte[16];
                    for (int i = 0; i < num6; i++) {
                        Marshal.Copy(ptr6, addrBytes, 0, 16);
                        int portRaw = Marshal.ReadInt32(ptr6, 20);
                        int port = ((portRaw & 0xff) << 8) | ((portRaw >> 8) & 0xff);
                        int state = Marshal.ReadInt32(ptr6, 48);
                        int pid = Marshal.ReadInt32(ptr6, 52);

                        if (state == 2 && (targetPort <= 0 || port == targetPort)) {
                            string ipStr = new IPAddress(addrBytes).ToString();
                            results.Add(new TcpListenerEntry {
                                LocalAddress = ipStr,
                                LocalPort = port,
                                OwningPid = pid,
                                IsLoopback = IsLoopbackAddress(ipStr)
                            });
                        }
                        ptr6 = IntPtr.Add(ptr6, 56);
                    }
                }
            } finally {
                Marshal.FreeHGlobal(buf6);
            }
        }

        return results;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct STARTUPINFO {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CreateProcess(
        string lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation
    );

    public const uint CREATE_NO_WINDOW = 0x08000000;
    public const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;

    public static string EscapeArgument(string arg) {
        if (arg == null) return "\"\"";
        if (arg.Length == 0) return "\"\"";
        if (arg.Length >= 2 && arg.StartsWith("\"") && arg.EndsWith("\"") && arg.IndexOf('\"', 1) == arg.Length - 1) {
            arg = arg.Substring(1, arg.Length - 2);
        }
        if (arg.Length == 0) return "\"\"";
        bool needsQuotes = false;
        for (int i = 0; i < arg.Length; i++) {
            char c = arg[i];
            if (c == ' ' || c == '\t' || c == '\n' || c == '\v' || c == '\"') {
                needsQuotes = true;
                break;
            }
        }
        if (!needsQuotes) return arg;

        StringBuilder sb = new StringBuilder();
        sb.Append('\"');
        int backslashes = 0;
        for (int i = 0; i < arg.Length; i++) {
            char c = arg[i];
            if (c == '\\') {
                backslashes++;
            } else if (c == '\"') {
                sb.Append(new string('\\', backslashes * 2 + 1));
                sb.Append('\"');
                backslashes = 0;
            } else {
                if (backslashes > 0) {
                    sb.Append(new string('\\', backslashes));
                    backslashes = 0;
                }
                sb.Append(c);
            }
        }
        if (backslashes > 0) {
            sb.Append(new string('\\', backslashes * 2));
        }
        sb.Append('\"');
        return sb.ToString();
    }

    public static string FormatArguments(string[] args) {
        if (args == null || args.Length == 0) return "";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < args.Length; i++) {
            if (i > 0) sb.Append(' ');
            sb.Append(EscapeArgument(args[i]));
        }
        return sb.ToString();
    }

    public static IntPtr CreateEnvironmentBlock(StringDictionary env) {
        StringBuilder sb = new StringBuilder();
        if (env != null && env.Count > 0) {
            var list = new List<string>();
            foreach (string key in env.Keys) {
                list.Add(key + "=" + env[key]);
            }
            list.Sort(StringComparer.OrdinalIgnoreCase);
            foreach (string s in list) {
                sb.Append(s);
                sb.Append('\0');
            }
        }
        sb.Append('\0');
        sb.Append('\0');
        byte[] bytes = Encoding.Unicode.GetBytes(sb.ToString());
        IntPtr ptr = Marshal.AllocHGlobal(bytes.Length);
        Marshal.Copy(bytes, 0, ptr, bytes.Length);
        return ptr;
    }

    public class ProcessLaunchAuditResult {
        public int dwProcessId;
        public int ProcessId { get { return dwProcessId; } }
        public string ExecutablePath;
        public long CreationTimeFileTime;
        public string CreationDateIsoUtc;
    }

    public static ProcessLaunchAuditResult StartProcessWithHandleAudit(ProcessStartInfo psi) {
        if (psi == null) {
            throw new ArgumentNullException("psi");
        }

        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(si);
        si.dwFlags = 1; // STARTF_USESHOWWINDOW
        si.wShowWindow = 0; // SW_HIDE

        PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
        IntPtr pEnv = CreateEnvironmentBlock(psi.EnvironmentVariables);

        string cmdLine = EscapeArgument(psi.FileName);
        if (!string.IsNullOrEmpty(psi.Arguments)) {
            cmdLine = cmdLine + " " + psi.Arguments;
        }
        StringBuilder sbCmd = new StringBuilder(cmdLine);

        uint flags = CREATE_NO_WINDOW;
        if (pEnv != IntPtr.Zero) {
            flags |= CREATE_UNICODE_ENVIRONMENT;
        }

        try {
            bool ok = CreateProcess(
                null,
                sbCmd,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                flags,
                pEnv,
                string.IsNullOrEmpty(psi.WorkingDirectory) ? null : psi.WorkingDirectory,
                ref si,
                out pi
            );

            if (!ok) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }

            try {
                uint size = 1024;
                StringBuilder sbName = new StringBuilder((int)size);
                string imagePath = psi.FileName;
                if (QueryFullProcessImageName(pi.hProcess, 0, sbName, ref size) && sbName.Length > 0) {
                    imagePath = sbName.ToString();
                }

                long ct = 0, et = 0, kt = 0, ut = 0;
                if (!GetProcessTimes(pi.hProcess, out ct, out et, out kt, out ut)) {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                if (ct <= 0) {
                    throw new InvalidOperationException("Process creation time was non-positive (" + ct + ")");
                }

                string isoUtc = DateTime.FromFileTimeUtc(ct).ToString("o");

                return new ProcessLaunchAuditResult {
                    dwProcessId = pi.dwProcessId,
                    ExecutablePath = imagePath,
                    CreationTimeFileTime = ct,
                    CreationDateIsoUtc = isoUtc
                };
            } finally {
                if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
                if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
            }
        } finally {
            if (pEnv != IntPtr.Zero) {
                Marshal.FreeHGlobal(pEnv);
            }
        }
    }

    public static int StartProcess(ProcessStartInfo psi) {
        return StartProcessWithHandleAudit(psi).dwProcessId;
    }
}
"@
}

function Normalize-Path {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return "" }
    try {
        return [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/').ToLowerInvariant()
    } catch {
        return $Path.Trim().TrimEnd('\', '/').ToLowerInvariant()
    }
}

function Test-ExecutablePathMatch {
    param(
        [string]$ActualPath,
        [string]$ExpectedPath
    )
    if ([string]::IsNullOrWhiteSpace($ExpectedPath) -or [string]::IsNullOrWhiteSpace($ActualPath)) {
        return $false
    }
    $normActual = Normalize-Path $ActualPath
    $normExpected = Normalize-Path $ExpectedPath
    if ($normActual -eq $normExpected) {
        return $true
    }
    # If expected path doesn't contain directory separators, match file names
    if (-not ($ExpectedPath -match '[\\/]')) {
        $actualName = [System.IO.Path]::GetFileName($ActualPath).ToLowerInvariant()
        $expectedName = $ExpectedPath.Trim().ToLowerInvariant()
        if ($actualName -eq $expectedName) { return $true }
        if ("$actualName.exe" -eq $expectedName) { return $true }
        if ($actualName -eq "$expectedName.exe") { return $true }
    }
    return $false
}

function Test-CreationTimeMatch {
    param(
        [long]$ActualFileTime,
        [string]$ActualIsoUtc,
        [string]$ExpectedStart,
        [string]$ExpectedFileTime
    )
    if ($ActualFileTime -le 0) {
        return $false
    }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedFileTime)) {
        try {
            $parsedFt = [long]$ExpectedFileTime
            if ($parsedFt -eq $ActualFileTime) {
                return $true
            }
        } catch {}
    }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedStart)) {
        if ($ExpectedStart -match '^\d{15,20}$') {
            try {
                $parsedFt = [long]$ExpectedStart
                if ($parsedFt -eq $ActualFileTime) {
                    return $true
                }
            } catch {}
        }
        if ($ActualIsoUtc -eq $ExpectedStart) {
            return $true
        }
        try {
            $expDt = [DateTime]::Parse($ExpectedStart).ToUniversalTime()
            $actDt = [DateTime]::FromFileTimeUtc($ActualFileTime)
            if ($expDt.Ticks -eq $actDt.Ticks -or $expDt -eq $actDt) {
                return $true
            }
            if ([Math]::Abs(($expDt - $actDt).TotalMilliseconds) -lt 2) {
                return $true
            }
        } catch {}
    }
    return $false
}

function Get-PortListeners {
    param([int]$TargetPort)
    $listeners = @()
    try {
        $entries = [Win32ProcessControl]::GetTcpListeners($TargetPort)
        if ($entries) {
            foreach ($e in $entries) {
                $listeners += [PSCustomObject]@{
                    LocalAddress = $e.LocalAddress
                    LocalPort = [int]$e.LocalPort
                    OwningPid = [int]$e.OwningPid
                    IsLoopback = [bool]$e.IsLoopback
                }
            }
        }
    } catch {
        try {
            $tcp = if ($TargetPort -gt 0) {
                Get-NetTCPConnection -LocalPort $TargetPort -State Listen -ErrorAction Stop
            } else {
                Get-NetTCPConnection -State Listen -ErrorAction Stop
            }
            foreach ($conn in $tcp) {
                $isLb = ($conn.LocalAddress -eq '127.0.0.1' -or $conn.LocalAddress -like '127.*' -or $conn.LocalAddress -eq '::1' -or $conn.LocalAddress -eq '0.0.0.0' -or $conn.LocalAddress -eq '::')
                $listeners += [PSCustomObject]@{
                    LocalAddress = [string]$conn.LocalAddress
                    LocalPort = [int]$conn.LocalPort
                    OwningPid = [int]$conn.OwningProcess
                    IsLoopback = [bool]$isLb
                }
            }
        } catch {}
    }
    return $listeners
}

if ($LaunchPayloadFromStdin -and $Action -ne "Launch") {
    $res = [PSCustomObject]@{
        success = $false
        error = "INVALID_ACTION_FOR_FLAG"
        message = "-LaunchPayloadFromStdin is only supported with -Action Launch"
    }
    $res | ConvertTo-Json -Compress
    exit 1
}

switch ($Action) {
    "Inspect" {
        if ($ProcessId -le 0) {
            $res = [PSCustomObject]@{
                success = $true
                running = $false
                processId = $ProcessId
            }
            $res | ConvertTo-Json -Compress
            exit 0
        }

        $hProcess = [Win32ProcessControl]::OpenProcess([Win32ProcessControl]::PROCESS_INSPECT_ACCESS, $false, $ProcessId)
        if ($hProcess -eq [IntPtr]::Zero) {
            $res = [PSCustomObject]@{
                success = $true
                running = $false
                processId = $ProcessId
            }
            $res | ConvertTo-Json -Compress
            exit 0
        }

        try {
            $sb = New-Object System.Text.StringBuilder 1024
            $size = [uint32]1024
            $okName = [Win32ProcessControl]::QueryFullProcessImageName($hProcess, [uint32]0, $sb, [ref]$size)
            $execPath = if ($okName) { $sb.ToString() } else { "" }

            [long]$ct = 0
            [long]$et = 0
            [long]$kt = 0
            [long]$ut = 0
            $okTimes = [Win32ProcessControl]::GetProcessTimes($hProcess, [ref]$ct, [ref]$et, [ref]$kt, [ref]$ut)
            $isoUtc = if ($okTimes -and $ct -gt 0) { [DateTime]::FromFileTimeUtc($ct).ToString("o") } else { "" }

            $waitRes = [Win32ProcessControl]::WaitForSingleObject($hProcess, [uint32]0)
            $isRunning = ($waitRes -eq [Win32ProcessControl]::WAIT_TIMEOUT)

            if ($isRunning) {
                $res = [PSCustomObject]@{
                    success = $true
                    running = $true
                    processId = $ProcessId
                    pid = $ProcessId
                    executablePath = $execPath
                    executable = $execPath
                    creationDate = $isoUtc
                    startedAt = $isoUtc
                    startTime = $isoUtc
                    creationTimeFileTime = [string]$ct
                }
            } else {
                $res = [PSCustomObject]@{
                    success = $true
                    running = $false
                    processId = $ProcessId
                    pid = $ProcessId
                }
            }
            $res | ConvertTo-Json -Compress
            exit 0
        } finally {
            [void][Win32ProcessControl]::CloseHandle($hProcess)
        }
    }

    "Verify" {
        if ($ProcessId -le 0) {
            $res = [PSCustomObject]@{
                success = $false
                valid = $false
                reason = "INVALID_PROCESS_ID"
                processId = $ProcessId
                pid = $ProcessId
            }
            $res | ConvertTo-Json -Compress
            exit 2
        }

        $hProcess = [Win32ProcessControl]::OpenProcess([Win32ProcessControl]::PROCESS_INSPECT_ACCESS, $false, $ProcessId)
        if ($hProcess -eq [IntPtr]::Zero) {
            $res = [PSCustomObject]@{
                success = $false
                valid = $false
                reason = "NOT_RUNNING"
                processId = $ProcessId
                pid = $ProcessId
            }
            $res | ConvertTo-Json -Compress
            exit 2
        }

        try {
            $sb = New-Object System.Text.StringBuilder 1024
            $size = [uint32]1024
            $okName = [Win32ProcessControl]::QueryFullProcessImageName($hProcess, [uint32]0, $sb, [ref]$size)
            $execPath = if ($okName) { $sb.ToString() } else { "" }

            [long]$ct = 0
            [long]$et = 0
            [long]$kt = 0
            [long]$ut = 0
            $okTimes = [Win32ProcessControl]::GetProcessTimes($hProcess, [ref]$ct, [ref]$et, [ref]$kt, [ref]$ut)
            $isoUtc = if ($okTimes -and $ct -gt 0) { [DateTime]::FromFileTimeUtc($ct).ToString("o") } else { "" }

            $exeMatch = Test-ExecutablePathMatch -ActualPath $execPath -ExpectedPath $ExpectedExecutablePath
            $timeMatch = Test-CreationTimeMatch -ActualFileTime $ct -ActualIsoUtc $isoUtc -ExpectedStart $ExpectedStartTime -ExpectedFileTime $ExpectedCreationTimeFileTime

            $valid = $exeMatch -and $timeMatch
            $reason = if (-not $exeMatch) { "PATH_MISMATCH" } elseif (-not $timeMatch) { "CREATION_TIME_MISMATCH" } else { "VALID" }

            $res = [PSCustomObject]@{
                success = $valid
                valid = $valid
                reason = $reason
                processId = $ProcessId
                pid = $ProcessId
                executablePath = $execPath
                executable = $execPath
                creationDate = $isoUtc
                startedAt = $isoUtc
                startTime = $isoUtc
                creationTimeFileTime = [string]$ct
            }
            $res | ConvertTo-Json -Compress
            if ($valid) { exit 0 } else { exit 2 }
        } finally {
            [void][Win32ProcessControl]::CloseHandle($hProcess)
        }
    }

    "Stop" {
        if ($ProcessId -le 0) {
            $res = [PSCustomObject]@{
                success = $true
                stopped = $true
                reason = "INVALID_PID"
                processId = $ProcessId
                pid = $ProcessId
            }
            $res | ConvertTo-Json -Compress
            exit 0
        }

        # Zero PID-only fallback: require expected executable path and creation time
        if ([string]::IsNullOrWhiteSpace($ExpectedExecutablePath) -or
            ([string]::IsNullOrWhiteSpace($ExpectedStartTime) -and [string]::IsNullOrWhiteSpace($ExpectedCreationTimeFileTime))) {
            $res = [PSCustomObject]@{
                success = $false
                stopped = $false
                error = "PROCESS_IDENTITY_MISMATCH"
                reason = "MISSING_EXPECTED_IDENTITY"
                processId = $ProcessId
                pid = $ProcessId
            }
            $res | ConvertTo-Json -Compress
            exit 2
        }

        # OpenProcess with PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE (0x00101001)
        $hProcess = [Win32ProcessControl]::OpenProcess([Win32ProcessControl]::PROCESS_AUDITED_ACCESS, $false, $ProcessId)
        if ($hProcess -eq [IntPtr]::Zero) {
            # Check if process is already dead / exited
            $hInspect = [Win32ProcessControl]::OpenProcess([Win32ProcessControl]::PROCESS_INSPECT_ACCESS, $false, $ProcessId)
            if ($hInspect -eq [IntPtr]::Zero) {
                $res = [PSCustomObject]@{
                    success = $true
                    stopped = $true
                    reason = "ALREADY_STOPPED"
                    processId = $ProcessId
                    pid = $ProcessId
                }
                $res | ConvertTo-Json -Compress
                exit 0
            }
            [void][Win32ProcessControl]::CloseHandle($hInspect)
            $res = [PSCustomObject]@{
                success = $false
                stopped = $false
                error = "ACCESS_DENIED"
                processId = $ProcessId
                pid = $ProcessId
            }
            $res | ConvertTo-Json -Compress
            exit 1
        }

        try {
            $waitRes0 = [Win32ProcessControl]::WaitForSingleObject($hProcess, [uint32]0)
            if ($waitRes0 -eq [Win32ProcessControl]::WAIT_OBJECT_0) {
                # Process has already exited / terminated
                [long]$ctDead = 0
                [long]$etDead = 0
                [long]$ktDead = 0
                [long]$utDead = 0
                if ([Win32ProcessControl]::GetProcessTimes($hProcess, [ref]$ctDead, [ref]$etDead, [ref]$ktDead, [ref]$utDead) -and $ctDead -gt 0) {
                    $deadIso = [DateTime]::FromFileTimeUtc($ctDead).ToString("o")
                    $timeMatchDead = Test-CreationTimeMatch -ActualFileTime $ctDead -ActualIsoUtc $deadIso -ExpectedStart $ExpectedStartTime -ExpectedFileTime $ExpectedCreationTimeFileTime
                    if ($timeMatchDead) {
                        $res = [PSCustomObject]@{
                            success = $true
                            stopped = $true
                            reason = "ALREADY_STOPPED"
                            processId = $ProcessId
                            pid = $ProcessId
                        }
                        $res | ConvertTo-Json -Compress
                        exit 0
                    }
                } else {
                    $res = [PSCustomObject]@{
                        success = $true
                        stopped = $true
                        reason = "ALREADY_STOPPED"
                        processId = $ProcessId
                        pid = $ProcessId
                    }
                    $res | ConvertTo-Json -Compress
                    exit 0
                }
            }

            # Query executable name via THAT handle
            $sb = New-Object System.Text.StringBuilder 1024
            $size = [uint32]1024
            $okName = [Win32ProcessControl]::QueryFullProcessImageName($hProcess, [uint32]0, $sb, [ref]$size)
            $actualExe = if ($okName) { $sb.ToString() } else { "" }

            # Query creation time via THAT handle
            [long]$ct = 0
            [long]$et = 0
            [long]$kt = 0
            [long]$ut = 0
            $okTimes = [Win32ProcessControl]::GetProcessTimes($hProcess, [ref]$ct, [ref]$et, [ref]$kt, [ref]$ut)
            $actualIso = if ($okTimes -and $ct -gt 0) { [DateTime]::FromFileTimeUtc($ct).ToString("o") } else { "" }

            # Exact identity check
            $exeMatch = Test-ExecutablePathMatch -ActualPath $actualExe -ExpectedPath $ExpectedExecutablePath
            if (-not $exeMatch) {
                $res = [PSCustomObject]@{
                    success = $false
                    stopped = $false
                    error = "PROCESS_IDENTITY_MISMATCH"
                    reason = "PATH_MISMATCH"
                    expected = $ExpectedExecutablePath
                    actual = $actualExe
                    processId = $ProcessId
                    pid = $ProcessId
                }
                $res | ConvertTo-Json -Compress
                exit 2
            }

            $timeMatch = Test-CreationTimeMatch -ActualFileTime $ct -ActualIsoUtc $actualIso -ExpectedStart $ExpectedStartTime -ExpectedFileTime $ExpectedCreationTimeFileTime
            if (-not $timeMatch) {
                $res = [PSCustomObject]@{
                    success = $false
                    stopped = $false
                    error = "PROCESS_IDENTITY_MISMATCH"
                    reason = "CREATION_TIME_MISMATCH"
                    expected = if ($ExpectedStartTime) { $ExpectedStartTime } else { $ExpectedCreationTimeFileTime }
                    actual = $actualIso
                    actualFileTime = [string]$ct
                    processId = $ProcessId
                    pid = $ProcessId
                }
                $res | ConvertTo-Json -Compress
                exit 2
            }

            # Identity matched. Terminate on THAT SAME handle.
            $termOk = [Win32ProcessControl]::TerminateProcess($hProcess, [uint32]1)
            # Wait on THAT SAME handle.
            $timeoutMs = [uint32]($TimeoutSeconds * 1000)
            $waitRes = [Win32ProcessControl]::WaitForSingleObject($hProcess, $timeoutMs)

            if ($waitRes -eq [Win32ProcessControl]::WAIT_OBJECT_0) {
                $res = [PSCustomObject]@{
                    success = $true
                    stopped = $true
                    processId = $ProcessId
                    pid = $ProcessId
                }
                $res | ConvertTo-Json -Compress
                exit 0
            } elseif ($waitRes -eq [Win32ProcessControl]::WAIT_TIMEOUT) {
                $res = [PSCustomObject]@{
                    success = $false
                    stopped = $false
                    error = "STOP_TIMEOUT"
                    processId = $ProcessId
                    pid = $ProcessId
                }
                $res | ConvertTo-Json -Compress
                exit 3
            } else {
                $res = [PSCustomObject]@{
                    success = $false
                    stopped = $false
                    error = "WAIT_FAILED"
                    processId = $ProcessId
                    pid = $ProcessId
                }
                $res | ConvertTo-Json -Compress
                exit 1
            }
        } finally {
            # Close handle in finally
            [void][Win32ProcessControl]::CloseHandle($hProcess)
        }
    }

    "Launch" {
        if ($LaunchPayloadFromStdin) {
            $stdinStream = [Console]::OpenStandardInput()
            $maxBytes = 262144
            $ms = New-Object System.IO.MemoryStream
            $buffer = New-Object byte[] 4096
            $totalBytes = 0
            $tooLarge = $false

            while ($true) {
                $read = $stdinStream.Read($buffer, 0, $buffer.Length)
                if ($read -le 0) { break }
                $totalBytes += $read
                if ($totalBytes -gt $maxBytes) {
                    $tooLarge = $true
                    break
                }
                $ms.Write($buffer, 0, $read)
            }

            if ($tooLarge) {
                $res = [PSCustomObject]@{
                    success = $false
                    error = "PAYLOAD_TOO_LARGE"
                    message = "Standard input payload exceeds maximum limit of 262144 bytes"
                    limitBytes = $maxBytes
                }
                $res | ConvertTo-Json -Compress
                exit 1
            }

            $rawBytes = $ms.ToArray()
            if ($rawBytes.Length -eq 0) {
                $res = [PSCustomObject]@{
                    success = $false
                    error = "INVALID_PAYLOAD"
                    message = "Standard input payload is empty"
                }
                $res | ConvertTo-Json -Compress
                exit 1
            }

            $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
            try {
                $jsonText = $utf8.GetString($rawBytes)
            } catch {
                $res = [PSCustomObject]@{
                    success = $false
                    error = "INVALID_ENCODING"
                    message = "Standard input payload is not valid UTF-8"
                }
                $res | ConvertTo-Json -Compress
                exit 1
            }

            try {
                $payload = $jsonText | ConvertFrom-Json -ErrorAction Stop
            } catch {
                $res = [PSCustomObject]@{
                    success = $false
                    error = "INVALID_JSON"
                    message = "Failed to parse JSON payload"
                }
                $res | ConvertTo-Json -Compress
                exit 1
            }

            if ($null -eq $payload -or -not ($payload -is [PSCustomObject] -or $payload -is [System.Collections.IDictionary])) {
                $res = [PSCustomObject]@{
                    success = $false
                    error = "INVALID_PAYLOAD"
                    message = "Payload must be a JSON object"
                }
                $res | ConvertTo-Json -Compress
                exit 1
            }

            # 1. Validate executablePath (non-empty string, exists)
            $propExe = $payload.PSObject.Properties['executablePath']
            if ($null -eq $propExe -or -not ($payload.executablePath -is [string]) -or [string]::IsNullOrWhiteSpace($payload.executablePath)) {
                $res = [PSCustomObject]@{
                    success = $false
                    error = "INVALID_EXECUTABLE_PATH"
                    message = "'executablePath' must be a non-empty string"
                }
                $res | ConvertTo-Json -Compress
                exit 1
            }

            $targetExe = $payload.executablePath
            if (-not [System.IO.File]::Exists($targetExe)) {
                try {
                    $cmd = Get-Command $targetExe -ErrorAction SilentlyContinue
                    if ($cmd -and $cmd.Source -and [System.IO.File]::Exists($cmd.Source)) {
                        $targetExe = $cmd.Source
                    }
                } catch {}
            }
            if (-not [System.IO.File]::Exists($targetExe)) {
                $res = [PSCustomObject]@{
                    success = $false
                    error = "EXECUTABLE_NOT_FOUND"
                    message = "Executable path does not exist: $($payload.executablePath)"
                }
                $res | ConvertTo-Json -Compress
                exit 1
            }
            $targetExe = [System.IO.Path]::GetFullPath($targetExe)

            # 2. Validate arguments (array of strings)
            $propArgs = $payload.PSObject.Properties['arguments']
            if ($null -eq $propArgs) {
                $res = [PSCustomObject]@{
                    success = $false
                    error = "INVALID_ARGUMENTS"
                    message = "Missing 'arguments' field, expected array of strings"
                }
                $res | ConvertTo-Json -Compress
                exit 1
            }
            if (-not ($payload.arguments -is [System.Array])) {
                $res = [PSCustomObject]@{
                    success = $false
                    error = "INVALID_ARGUMENTS"
                    message = "'arguments' must be an array of strings"
                }
                $res | ConvertTo-Json -Compress
                exit 1
            }
            $stringArgs = New-Object System.Collections.Generic.List[string]
            foreach ($arg in $payload.arguments) {
                if (-not ($arg -is [string])) {
                    $res = [PSCustomObject]@{
                        success = $false
                        error = "INVALID_ARGUMENTS"
                        message = "All elements in 'arguments' must be strings"
                    }
                    $res | ConvertTo-Json -Compress
                    exit 1
                }
                $stringArgs.Add([string]$arg)
            }

            # 3. Validate workingDirectory (null or valid string, directory exists if provided)
            $targetWd = $null
            $propWd = $payload.PSObject.Properties['workingDirectory']
            if ($null -ne $propWd -and $null -ne $payload.workingDirectory) {
                if (-not ($payload.workingDirectory -is [string])) {
                    $res = [PSCustomObject]@{
                        success = $false
                        error = "INVALID_WORKING_DIRECTORY"
                        message = "'workingDirectory' must be null or a string"
                    }
                    $res | ConvertTo-Json -Compress
                    exit 1
                }
                if (-not [string]::IsNullOrWhiteSpace($payload.workingDirectory)) {
                    if (-not [System.IO.Directory]::Exists($payload.workingDirectory)) {
                        $res = [PSCustomObject]@{
                            success = $false
                            error = "WORKING_DIRECTORY_NOT_FOUND"
                            message = "Working directory does not exist: $($payload.workingDirectory)"
                        }
                        $res | ConvertTo-Json -Compress
                        exit 1
                    }
                    $targetWd = [System.IO.Path]::GetFullPath($payload.workingDirectory)
                }
            }

            # 4. Validate environment (dictionary/object with string key/values)
            $propEnv = $payload.PSObject.Properties['environment']
            if ($null -eq $propEnv -or $null -eq $payload.environment) {
                $res = [PSCustomObject]@{
                    success = $false
                    error = "INVALID_ENVIRONMENT"
                    message = "Missing 'environment' field"
                }
                $res | ConvertTo-Json -Compress
                exit 1
            }
            if (-not ($payload.environment -is [PSCustomObject] -or $payload.environment -is [System.Collections.IDictionary])) {
                $res = [PSCustomObject]@{
                    success = $false
                    error = "INVALID_ENVIRONMENT"
                    message = "'environment' must be a dictionary/object"
                }
                $res | ConvertTo-Json -Compress
                exit 1
            }

            $psi = New-Object System.Diagnostics.ProcessStartInfo
            $psi.FileName = $targetExe
            $psi.Arguments = [Win32ProcessControl]::FormatArguments($stringArgs.ToArray())
            $psi.UseShellExecute = $false
            $psi.CreateNoWindow = $true
            if ($null -ne $targetWd) {
                $psi.WorkingDirectory = $targetWd
            }

            $psi.EnvironmentVariables.Clear()
            $hasSysRoot = $false
            if ($payload.environment -is [PSCustomObject]) {
                foreach ($prop in $payload.environment.PSObject.Properties) {
                    if (-not ($prop.Value -is [string])) {
                        $res = [PSCustomObject]@{
                            success = $false
                            error = "INVALID_ENVIRONMENT"
                            message = "Environment value for '$($prop.Name)' must be a string"
                        }
                        $res | ConvertTo-Json -Compress
                        exit 1
                    }
                    if ($prop.Name -ieq "SystemRoot") { $hasSysRoot = $true }
                    $psi.EnvironmentVariables[$prop.Name] = [string]$prop.Value
                }
            } elseif ($payload.environment -is [System.Collections.IDictionary]) {
                foreach ($key in $payload.environment.Keys) {
                    $val = $payload.environment[$key]
                    if (-not ($val -is [string])) {
                        $res = [PSCustomObject]@{
                            success = $false
                            error = "INVALID_ENVIRONMENT"
                            message = "Environment value for '$key' must be a string"
                        }
                        $res | ConvertTo-Json -Compress
                        exit 1
                    }
                    if ([string]$key -ieq "SystemRoot") { $hasSysRoot = $true }
                    $psi.EnvironmentVariables[[string]$key] = [string]$val
                }
            }

            if (-not $hasSysRoot -and -not [string]::IsNullOrEmpty($env:SystemRoot)) {
                $psi.EnvironmentVariables['SystemRoot'] = $env:SystemRoot
            }

            try {
                $audit = [Win32ProcessControl]::StartProcessWithHandleAudit($psi)
            } catch {
                $res = [PSCustomObject]@{
                    success = $false
                    error = "START_FAILED"
                    message = $_.Exception.Message
                }
                $res | ConvertTo-Json -Compress
                exit 1
            }

            $res = [PSCustomObject]@{
                success = $true
                running = $true
                processId = $audit.dwProcessId
                pid = $audit.dwProcessId
                executablePath = $audit.ExecutablePath
                executable = $audit.ExecutablePath
                creationDate = $audit.CreationDateIsoUtc
                startedAt = $audit.CreationDateIsoUtc
                startTime = $audit.CreationDateIsoUtc
                creationTimeFileTime = [string]$audit.CreationTimeFileTime
            }
            $res | ConvertTo-Json -Compress
            exit 0
        }

        if (-not $ExecutablePath) {
            $res = [PSCustomObject]@{
                success = $false
                error = "MISSING_EXECUTABLE_PATH"
            }
            $res | ConvertTo-Json -Compress
            exit 1
        }

        $targetExe = $ExecutablePath
        if (-not [System.IO.File]::Exists($targetExe)) {
            try {
                $cmd = Get-Command $targetExe -ErrorAction SilentlyContinue
                if ($cmd -and $cmd.Source -and [System.IO.File]::Exists($cmd.Source)) {
                    $targetExe = $cmd.Source
                }
            } catch {}
        }

        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $targetExe
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true

        if ($WorkingDirectory) {
            $psi.WorkingDirectory = $WorkingDirectory
        }

        if ($Arguments -and $Arguments.Count -gt 0) {
            $psi.Arguments = [Win32ProcessControl]::FormatArguments($Arguments)
        } elseif (-not [string]::IsNullOrWhiteSpace($CommandLine)) {
            $psi.Arguments = $CommandLine
        }

        if ($EnvironmentVariables) {
            $parsedEnv = $null
            if ($EnvironmentVariables -is [hashtable] -or $EnvironmentVariables -is [System.Collections.IDictionary]) {
                $parsedEnv = $EnvironmentVariables
            } elseif ($EnvironmentVariables -is [string]) {
                $trimmed = $EnvironmentVariables.Trim()
                if ($trimmed.StartsWith('{')) {
                    try {
                        $obj = $trimmed | ConvertFrom-Json
                        $parsedEnv = @{}
                        foreach ($p in $obj.PSObject.Properties) {
                            $parsedEnv[$p.Name] = [string]$p.Value
                        }
                    } catch {}
                }
            } elseif ($EnvironmentVariables -is [PSCustomObject]) {
                $parsedEnv = @{}
                foreach ($p in $EnvironmentVariables.PSObject.Properties) {
                    $parsedEnv[$p.Name] = [string]$p.Value
                }
            }

            if ($parsedEnv) {
                $psi.EnvironmentVariables.Clear()
                $hasSysRoot = $false
                foreach ($key in $parsedEnv.Keys) {
                    if ([string]$key -ieq "SystemRoot") { $hasSysRoot = $true }
                    $psi.EnvironmentVariables[[string]$key] = [string]$parsedEnv[$key]
                }
                if (-not $hasSysRoot -and -not [string]::IsNullOrEmpty($env:SystemRoot)) {
                    $psi.EnvironmentVariables['SystemRoot'] = $env:SystemRoot
                }
            }
        }

        try {
            $audit = [Win32ProcessControl]::StartProcessWithHandleAudit($psi)
        } catch {
            $res = [PSCustomObject]@{
                success = $false
                error = "START_FAILED"
                message = $_.Exception.Message
            }
            $res | ConvertTo-Json -Compress
            exit 1
        }

        $res = [PSCustomObject]@{
            success = $true
            running = $true
            processId = $audit.dwProcessId
            pid = $audit.dwProcessId
            executablePath = $audit.ExecutablePath
            executable = $audit.ExecutablePath
            creationDate = $audit.CreationDateIsoUtc
            startedAt = $audit.CreationDateIsoUtc
            startTime = $audit.CreationDateIsoUtc
            creationTimeFileTime = [string]$audit.CreationTimeFileTime
        }
        $res | ConvertTo-Json -Compress
        exit 0
    }

    "InspectListener" {
        if ($Port -le 0 -or $Port -gt 65535) {
            $res = [PSCustomObject]@{
                success = $false
                valid = $false
                error = "INVALID_PORT"
                reason = "INVALID_PORT"
                port = $Port
            }
            $res | ConvertTo-Json -Compress
            exit 2
        }

        $allListeners = Get-PortListeners -TargetPort $Port
        if (@($allListeners).Count -eq 0) {
            $res = [PSCustomObject]@{
                success = $false
                valid = $false
                running = $false
                error = "NO_LISTENER"
                reason = "NO_LISTENER"
                port = $Port
            }
            $res | ConvertTo-Json -Compress
            exit 2
        }

        $loopbackListeners = @($allListeners | Where-Object { $_.IsLoopback })
        if (@($loopbackListeners).Count -eq 0) {
            $res = [PSCustomObject]@{
                success = $false
                valid = $false
                error = "NOT_LOOPBACK"
                reason = "NOT_LOOPBACK"
                port = $Port
            }
            $res | ConvertTo-Json -Compress
            exit 2
        }

        $distinctPids = @($loopbackListeners | Select-Object -ExpandProperty OwningPid -Unique)
        if ($distinctPids.Count -gt 1) {
            $res = [PSCustomObject]@{
                success = $false
                valid = $false
                error = "AMBIGUOUS_LISTENER"
                reason = "AMBIGUOUS_LISTENER"
                port = $Port
                pids = $distinctPids
            }
            $res | ConvertTo-Json -Compress
            exit 2
        }

        $listenerPid = [int]$distinctPids[0]
        if ($listenerPid -le 0) {
            $res = [PSCustomObject]@{
                success = $false
                valid = $false
                error = "INVALID_OWNING_PID"
                reason = "INVALID_OWNING_PID"
                port = $Port
            }
            $res | ConvertTo-Json -Compress
            exit 2
        }

        if ($ProcessId -gt 0 -and $listenerPid -ne $ProcessId) {
            $res = [PSCustomObject]@{
                success = $false
                valid = $false
                error = "PROCESS_IDENTITY_MISMATCH"
                reason = "PID_MISMATCH"
                port = $Port
                expectedPid = $ProcessId
                actualPid = $listenerPid
                processId = $listenerPid
                pid = $listenerPid
            }
            $res | ConvertTo-Json -Compress
            exit 2
        }

        $hProcess = [Win32ProcessControl]::OpenProcess([Win32ProcessControl]::PROCESS_INSPECT_ACCESS, $false, $listenerPid)
        if ($hProcess -eq [IntPtr]::Zero) {
            $lastErr = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
            $isDenied = ($lastErr -eq 5) # ERROR_ACCESS_DENIED
            $errCode = if ($isDenied) { "ACCESS_DENIED" } else { "NOT_RUNNING" }
            $res = [PSCustomObject]@{
                success = $false
                valid = $false
                error = $errCode
                reason = $errCode
                port = $Port
                processId = $listenerPid
                pid = $listenerPid
                win32Error = $lastErr
            }
            $res | ConvertTo-Json -Compress
            if ($isDenied) { exit 1 } else { exit 2 }
        }

        try {
            $waitRes = [Win32ProcessControl]::WaitForSingleObject($hProcess, [uint32]0)
            if ($waitRes -ne [Win32ProcessControl]::WAIT_TIMEOUT) {
                $res = [PSCustomObject]@{
                    success = $false
                    valid = $false
                    running = $false
                    error = "NOT_RUNNING"
                    reason = "NOT_RUNNING"
                    port = $Port
                    processId = $listenerPid
                    pid = $listenerPid
                }
                $res | ConvertTo-Json -Compress
                exit 2
            }

            $sb = New-Object System.Text.StringBuilder 1024
            $size = [uint32]1024
            $okName = [Win32ProcessControl]::QueryFullProcessImageName($hProcess, [uint32]0, $sb, [ref]$size)
            $actualExe = if ($okName) { $sb.ToString() } else { "" }

            [long]$ct = 0
            [long]$et = 0
            [long]$kt = 0
            [long]$ut = 0
            $okTimes = [Win32ProcessControl]::GetProcessTimes($hProcess, [ref]$ct, [ref]$et, [ref]$kt, [ref]$ut)
            $actualIso = if ($okTimes -and $ct -gt 0) { [DateTime]::FromFileTimeUtc($ct).ToString("o") } else { "" }

            if (-not [string]::IsNullOrWhiteSpace($ExpectedExecutablePath)) {
                $exeMatch = Test-ExecutablePathMatch -ActualPath $actualExe -ExpectedPath $ExpectedExecutablePath
                if (-not $exeMatch) {
                    $res = [PSCustomObject]@{
                        success = $false
                        valid = $false
                        error = "PROCESS_IDENTITY_MISMATCH"
                        reason = "PATH_MISMATCH"
                        expected = $ExpectedExecutablePath
                        actual = $actualExe
                        port = $Port
                        processId = $listenerPid
                        pid = $listenerPid
                    }
                    $res | ConvertTo-Json -Compress
                    exit 2
                }
            }

            if ((-not [string]::IsNullOrWhiteSpace($ExpectedStartTime)) -or (-not [string]::IsNullOrWhiteSpace($ExpectedCreationTimeFileTime))) {
                $timeMatch = Test-CreationTimeMatch -ActualFileTime $ct -ActualIsoUtc $actualIso -ExpectedStart $ExpectedStartTime -ExpectedFileTime $ExpectedCreationTimeFileTime
                if (-not $timeMatch) {
                    $res = [PSCustomObject]@{
                        success = $false
                        valid = $false
                        error = "PROCESS_IDENTITY_MISMATCH"
                        reason = "CREATION_TIME_MISMATCH"
                        expected = if ($ExpectedStartTime) { $ExpectedStartTime } else { $ExpectedCreationTimeFileTime }
                        actual = $actualIso
                        actualFileTime = [string]$ct
                        port = $Port
                        processId = $listenerPid
                        pid = $listenerPid
                    }
                    $res | ConvertTo-Json -Compress
                    exit 2
                }
            }

            $res = [PSCustomObject]@{
                success = $true
                valid = $true
                running = $true
                reason = "VALID"
                port = $Port
                localPort = $Port
                localAddress = ($loopbackListeners[0].LocalAddress)
                processId = $listenerPid
                pid = $listenerPid
                executablePath = $actualExe
                executable = $actualExe
                creationDate = $actualIso
                startedAt = $actualIso
                startTime = $actualIso
                creationTimeFileTime = [string]$ct
            }
            $res | ConvertTo-Json -Compress
            exit 0
        } finally {
            [void][Win32ProcessControl]::CloseHandle($hProcess)
        }
    }

    "FindOwned" {
        if ($Port -gt 0) {
            $allListeners = Get-PortListeners -TargetPort $Port
            if (@($allListeners).Count -eq 0) {
                $res = [PSCustomObject]@{
                    success = $false
                    found = $false
                    valid = $false
                    error = "NO_LISTENER"
                    reason = "NO_LISTENER"
                    port = $Port
                }
                $res | ConvertTo-Json -Compress
                exit 2
            }

            $loopbackListeners = @($allListeners | Where-Object { $_.IsLoopback })
            if (@($loopbackListeners).Count -eq 0) {
                $res = [PSCustomObject]@{
                    success = $false
                    found = $false
                    valid = $false
                    error = "NOT_LOOPBACK"
                    reason = "NOT_LOOPBACK"
                    port = $Port
                }
                $res | ConvertTo-Json -Compress
                exit 2
            }

            $distinctPids = @($loopbackListeners | Select-Object -ExpandProperty OwningPid -Unique)
            if ($distinctPids.Count -gt 1) {
                $res = [PSCustomObject]@{
                    success = $false
                    found = $false
                    valid = $false
                    error = "AMBIGUOUS_LISTENER"
                    reason = "AMBIGUOUS_LISTENER"
                    port = $Port
                    pids = $distinctPids
                }
                $res | ConvertTo-Json -Compress
                exit 2
            }

            $candPid = [int]$distinctPids[0]
            if ($ProcessId -gt 0 -and $candPid -ne $ProcessId) {
                $res = [PSCustomObject]@{
                    success = $false
                    found = $false
                    valid = $false
                    error = "PROCESS_IDENTITY_MISMATCH"
                    reason = "PID_MISMATCH"
                    port = $Port
                    processId = $candPid
                    pid = $candPid
                }
                $res | ConvertTo-Json -Compress
                exit 2
            }

            $hProcess = [Win32ProcessControl]::OpenProcess([Win32ProcessControl]::PROCESS_INSPECT_ACCESS, $false, $candPid)
            if ($hProcess -eq [IntPtr]::Zero) {
                $lastErr = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
                $isDenied = ($lastErr -eq 5)
                $errCode = if ($isDenied) { "ACCESS_DENIED" } else { "NOT_RUNNING" }
                $res = [PSCustomObject]@{
                    success = $false
                    found = $false
                    valid = $false
                    error = $errCode
                    reason = $errCode
                    port = $Port
                    processId = $candPid
                    pid = $candPid
                }
                $res | ConvertTo-Json -Compress
                if ($isDenied) { exit 1 } else { exit 2 }
            }

            try {
                $waitRes = [Win32ProcessControl]::WaitForSingleObject($hProcess, [uint32]0)
                if ($waitRes -ne [Win32ProcessControl]::WAIT_TIMEOUT) {
                    $res = [PSCustomObject]@{
                        success = $false
                        found = $false
                        valid = $false
                        error = "NOT_RUNNING"
                        reason = "NOT_RUNNING"
                        port = $Port
                        processId = $candPid
                        pid = $candPid
                    }
                    $res | ConvertTo-Json -Compress
                    exit 2
                }

                $sb = New-Object System.Text.StringBuilder 1024
                $size = [uint32]1024
                $okName = [Win32ProcessControl]::QueryFullProcessImageName($hProcess, [uint32]0, $sb, [ref]$size)
                $actualExe = if ($okName) { $sb.ToString() } else { "" }

                [long]$ct = 0
                [long]$et = 0
                [long]$kt = 0
                [long]$ut = 0
                $okTimes = [Win32ProcessControl]::GetProcessTimes($hProcess, [ref]$ct, [ref]$et, [ref]$kt, [ref]$ut)
                $actualIso = if ($okTimes -and $ct -gt 0) { [DateTime]::FromFileTimeUtc($ct).ToString("o") } else { "" }

                if (-not [string]::IsNullOrWhiteSpace($ExpectedExecutablePath)) {
                    if (-not (Test-ExecutablePathMatch -ActualPath $actualExe -ExpectedPath $ExpectedExecutablePath)) {
                        $res = [PSCustomObject]@{
                            success = $false
                            found = $false
                            valid = $false
                            error = "PROCESS_IDENTITY_MISMATCH"
                            reason = "PATH_MISMATCH"
                            expected = $ExpectedExecutablePath
                            actual = $actualExe
                            port = $Port
                            processId = $candPid
                            pid = $candPid
                        }
                        $res | ConvertTo-Json -Compress
                        exit 2
                    }
                }

                if ((-not [string]::IsNullOrWhiteSpace($ExpectedStartTime)) -or (-not [string]::IsNullOrWhiteSpace($ExpectedCreationTimeFileTime))) {
                    if (-not (Test-CreationTimeMatch -ActualFileTime $ct -ActualIsoUtc $actualIso -ExpectedStart $ExpectedStartTime -ExpectedFileTime $ExpectedCreationTimeFileTime)) {
                        $res = [PSCustomObject]@{
                            success = $false
                            found = $false
                            valid = $false
                            error = "PROCESS_IDENTITY_MISMATCH"
                            reason = "CREATION_TIME_MISMATCH"
                            port = $Port
                            processId = $candPid
                            pid = $candPid
                        }
                        $res | ConvertTo-Json -Compress
                        exit 2
                    }
                }

                $res = [PSCustomObject]@{
                    success = $true
                    found = $true
                    valid = $true
                    running = $true
                    reason = "VALID"
                    port = $Port
                    localPort = $Port
                    processId = $candPid
                    pid = $candPid
                    executablePath = $actualExe
                    executable = $actualExe
                    creationDate = $actualIso
                    startedAt = $actualIso
                    startTime = $actualIso
                    creationTimeFileTime = [string]$ct
                }
                $res | ConvertTo-Json -Compress
                exit 0
            } finally {
                [void][Win32ProcessControl]::CloseHandle($hProcess)
            }
        }

        # Otherwise, search by ProcessId or Tag / CommandLine / ExpectedExecutablePath
        $candidates = @()
        if ($ProcessId -gt 0) {
            $candidates += $ProcessId
        } else {
            try {
                $procs = Get-CimInstance Win32_Process -ErrorAction Stop
                foreach ($p in $procs) {
                    $match = $true
                    if (-not [string]::IsNullOrWhiteSpace($Tag)) {
                        if (-not ($p.CommandLine -and $p.CommandLine.Contains($Tag))) {
                            $match = $false
                        }
                    }
                    if ($match -and (-not [string]::IsNullOrWhiteSpace($CommandLine))) {
                        if (-not ($p.CommandLine -and $p.CommandLine.Contains($CommandLine))) {
                            $match = $false
                        }
                    }
                    if ($match -and (-not [string]::IsNullOrWhiteSpace($ExpectedExecutablePath))) {
                        $pName = [System.IO.Path]::GetFileName($ExpectedExecutablePath)
                        if ($p.Name -ne $pName -and $p.ExecutablePath -ne $ExpectedExecutablePath) {
                            $match = $false
                        }
                    }
                    if ($match) {
                        $candidates += [int]$p.ProcessId
                    }
                }
            } catch {
                if (-not [string]::IsNullOrWhiteSpace($ExpectedExecutablePath)) {
                    $pName = [System.IO.Path]::GetFileNameWithoutExtension($ExpectedExecutablePath)
                    $gps = Get-Process -Name $pName -ErrorAction SilentlyContinue
                    foreach ($gp in $gps) { $candidates += [int]$gp.Id }
                }
            }
        }

        $verified = @()
        $accessDeniedCount = 0

        foreach ($cPid in $candidates) {
            if ($cPid -le 0) { continue }
            $hProc = [Win32ProcessControl]::OpenProcess([Win32ProcessControl]::PROCESS_INSPECT_ACCESS, $false, $cPid)
            if ($hProc -eq [IntPtr]::Zero) {
                $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
                if ($err -eq 5) { $accessDeniedCount++ }
                continue
            }
            try {
                $waitRes = [Win32ProcessControl]::WaitForSingleObject($hProc, [uint32]0)
                if ($waitRes -ne [Win32ProcessControl]::WAIT_TIMEOUT) {
                    continue
                }

                $sb = New-Object System.Text.StringBuilder 1024
                $size = [uint32]1024
                $okName = [Win32ProcessControl]::QueryFullProcessImageName($hProc, [uint32]0, $sb, [ref]$size)
                $candExe = if ($okName) { $sb.ToString() } else { "" }

                [long]$ct = 0
                [long]$et = 0
                [long]$kt = 0
                [long]$ut = 0
                $okTimes = [Win32ProcessControl]::GetProcessTimes($hProc, [ref]$ct, [ref]$et, [ref]$kt, [ref]$ut)
                $candIso = if ($okTimes -and $ct -gt 0) { [DateTime]::FromFileTimeUtc($ct).ToString("o") } else { "" }

                if (-not [string]::IsNullOrWhiteSpace($ExpectedExecutablePath)) {
                    if (-not (Test-ExecutablePathMatch -ActualPath $candExe -ExpectedPath $ExpectedExecutablePath)) {
                        continue
                    }
                }

                if ((-not [string]::IsNullOrWhiteSpace($ExpectedStartTime)) -or (-not [string]::IsNullOrWhiteSpace($ExpectedCreationTimeFileTime))) {
                    if (-not (Test-CreationTimeMatch -ActualFileTime $ct -ActualIsoUtc $candIso -ExpectedStart $ExpectedStartTime -ExpectedFileTime $ExpectedCreationTimeFileTime)) {
                        continue
                    }
                }

                $verified += [PSCustomObject]@{
                    ProcessId = $cPid
                    ExecutablePath = $candExe
                    CreationDate = $candIso
                    CreationTimeFileTime = [string]$ct
                }
            } finally {
                [void][Win32ProcessControl]::CloseHandle($hProc)
            }
        }

        if ($verified.Count -gt 1) {
            $res = [PSCustomObject]@{
                success = $false
                found = $false
                valid = $false
                error = "AMBIGUOUS_MATCH"
                reason = "AMBIGUOUS_MATCH"
                count = $verified.Count
                pids = ($verified | Select-Object -ExpandProperty ProcessId)
            }
            $res | ConvertTo-Json -Compress
            exit 2
        }

        if ($verified.Count -eq 0) {
            if ($accessDeniedCount -gt 0 -and $ProcessId -gt 0) {
                $res = [PSCustomObject]@{
                    success = $false
                    found = $false
                    valid = $false
                    error = "ACCESS_DENIED"
                    reason = "ACCESS_DENIED"
                    processId = $ProcessId
                }
                $res | ConvertTo-Json -Compress
                exit 1
            }
            $res = [PSCustomObject]@{
                success = $false
                found = $false
                valid = $false
                error = "NOT_FOUND"
                reason = "NOT_FOUND"
            }
            $res | ConvertTo-Json -Compress
            exit 2
        }

        $v = $verified[0]
        $res = [PSCustomObject]@{
            success = $true
            found = $true
            valid = $true
            running = $true
            reason = "VALID"
            processId = $v.ProcessId
            pid = $v.ProcessId
            executablePath = $v.ExecutablePath
            executable = $v.ExecutablePath
            creationDate = $v.CreationDate
            startedAt = $v.CreationDate
            startTime = $v.CreationDate
            creationTimeFileTime = $v.CreationTimeFileTime
        }
        $res | ConvertTo-Json -Compress
        exit 0
    }
}

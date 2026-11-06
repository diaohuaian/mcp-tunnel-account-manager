#Requires -Version 5.1
param(
    [Parameter(Mandatory=$true)][string]$SourceDirectory,
    [Parameter(Mandatory=$true)][string]$DestinationZip
)
$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $taskSource = (Get-Item -LiteralPath $SourceDirectory -ErrorAction Stop).FullName.TrimEnd('\')
    if (-not (Test-Path -LiteralPath $taskSource -PathType Container)) { throw 'Source must be a directory.' }
    $taskZip = [IO.Path]::GetFullPath($DestinationZip)
    if ([IO.Path]::GetExtension($taskZip) -ine '.zip') { throw 'Destination must have the .zip extension.' }
    if ($taskZip.StartsWith($taskSource + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Destination cannot be inside the source tree.' }
    if (Test-Path -LiteralPath $taskZip) { throw 'Destination already exists. No file was overwritten.' }
    $taskItems = @(Get-ChildItem -LiteralPath $taskSource -Force -Recurse | Sort-Object FullName)
    foreach ($taskItem in $taskItems) {
        if ($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('Links are forbidden: ' + $taskItem.FullName) }
    }
    $null = New-Item -ItemType Directory -Path (Split-Path -Parent $taskZip) -Force
    $taskStream = [IO.File]::Open($taskZip,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    $taskArchive = $null
    try {
        $taskArchive = New-Object IO.Compression.ZipArchive($taskStream,[IO.Compression.ZipArchiveMode]::Create,$false,(New-Object Text.UTF8Encoding($false)))
        $taskTop = Split-Path -Leaf $taskSource
        foreach ($taskItem in $taskItems) {
            if ($taskItem.PSIsContainer) { continue }
            $taskRelative = $taskTop + '/' + $taskItem.FullName.Substring($taskSource.Length + 1).Replace('\','/')
            $taskEntry = $taskArchive.CreateEntry($taskRelative,[IO.Compression.CompressionLevel]::Optimal)
            $taskEntry.LastWriteTime = New-Object DateTimeOffset(2026,11,6,0,0,0,[TimeSpan]::Zero)
            $taskInput = [IO.File]::OpenRead($taskItem.FullName)
            $taskOutput = $taskEntry.Open()
            try { $taskInput.CopyTo($taskOutput) }
            finally { $taskOutput.Dispose(); $taskInput.Dispose() }
        }
    } finally {
        if ($null -ne $taskArchive) { $taskArchive.Dispose() }
        $taskStream.Dispose()
    }
    $taskHash = (Get-FileHash -LiteralPath $taskZip -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Host ('ZIP created: ' + $taskZip)
    Write-Host ('SHA256: ' + $taskHash)
} catch {
    Write-Error $_
    exit 1
}

#Requires -Version 5.1
param(
    [ValidateRange(1,65535)][int]$Port = 17642,
    [string]$DataDirectory = '',
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
& "$PSScriptRoot\open-mcp-tunnel-console.ps1" -Port $Port -DataDirectory $DataDirectory -NoBrowser:$NoBrowser

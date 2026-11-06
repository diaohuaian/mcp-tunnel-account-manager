@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0console\scripts\install-portable-console.ps1" -OpenAfterInstall
set "MCP_EXIT=%ERRORLEVEL%"
if not "%MCP_EXIT%"=="0" pause
exit /b %MCP_EXIT%

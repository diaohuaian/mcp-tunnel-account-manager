@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-portable-console.ps1" -OpenAfterInstall
set "MCP_PORTABLE_EXIT=%ERRORLEVEL%"
if not "%MCP_PORTABLE_EXIT%"=="0" pause
exit /b %MCP_PORTABLE_EXIT%

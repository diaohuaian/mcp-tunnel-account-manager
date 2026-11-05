@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\open-portable-console.ps1"
set "MCP_PORTABLE_EXIT=%ERRORLEVEL%"
if not "%MCP_PORTABLE_EXIT%"=="0" pause
exit /b %MCP_PORTABLE_EXIT%

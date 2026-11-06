@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Verify-Package.ps1"
set "MCP_EXIT=%ERRORLEVEL%"
pause
exit /b %MCP_EXIT%

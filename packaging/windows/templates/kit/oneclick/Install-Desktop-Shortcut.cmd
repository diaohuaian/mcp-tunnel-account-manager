@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Desktop-Shortcut.ps1" %*
set "MCP_EXIT=%ERRORLEVEL%"
if not "%MCP_EXIT%"=="0" pause
exit /b %MCP_EXIT%

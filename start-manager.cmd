@echo off
setlocal
rem MCP Tunnel Account Manager - Node.js 22+ - default http://127.0.0.1:17642
where node.exe >nul 2>&1
if errorlevel 1 (
  echo Node.js 22 or later is required. 1>&2
  exit /b 1
)
node.exe -e "if (Number(process.versions.node.split('.')[0]) < 22) { console.error('Node.js 22 or later is required.'); process.exit(1); }"
if errorlevel 1 exit /b 1
if not exist "%~dp0scripts\start-manager.ps1" (
  echo Missing scripts\start-manager.ps1. 1>&2
  exit /b 1
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-manager.ps1" %*
set "MCP_MANAGER_LAUNCH_EXIT=%ERRORLEVEL%"
exit /b %MCP_MANAGER_LAUNCH_EXIT%

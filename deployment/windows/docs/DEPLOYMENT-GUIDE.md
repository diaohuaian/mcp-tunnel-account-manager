# MCP Windows Deployment Guide

## Prerequisites on Target PC (Windows 2)

1. **Node.js**: Version >= 18 (for `overleaf-mcp`) and Version >= 22 (for `deepseek-mcp`).
2. **Python**: Version >= 3.9 (for `antigravity-mcp`).
3. **Antigravity IDE**: Installed and running (for local IPC discovery).
4. **DeepSeek Harness (DSH)**: Installed and running with `dsh-chatgpt-bridge` mounted on port 3456.

## Installation Steps

1. Extract the deployment kit to a destination folder of your choice (e.g. `C:\MCP-Deployment`).
2. Run `powershell -ExecutionPolicy Bypass -File .\Install-And-Setup.ps1`.
3. Provide your 3 independent OpenAI Tunnel IDs when prompted.
4. Launch each tunnel using the scripts in `launchers/`:
   - `powershell -ExecutionPolicy Bypass -File .\launchers\Start-Overleaf-Tunnel.ps1`
   - `powershell -ExecutionPolicy Bypass -File .\launchers\Start-Antigravity-Tunnel.ps1`
   - `powershell -ExecutionPolicy Bypass -File .\launchers\Start-DeepSeek-Bridge-Tunnel.ps1`

# MCP Windows Deployment & Migration Guide

This package provides runtime code, configuration templates, launchers, OpenAI tunnel-client, and a standalone account management console for 3 MCP servers: Overleaf, Antigravity, and DeepSeek Harness (DSH) Bridge.

## Prerequisites on Target Machine (Windows 2)

| Service | Transport | Prerequisites |
| --- | --- | --- |
| Overleaf | stdio | Bundled Node or system Node 18+; dependencies bundled; re-authorize browser/account on target |
| Antigravity | stdio | Python 3.9+; Antigravity IDE installed and open; launched as Python module |
| DSH Bridge | HTTP (127.0.0.1:3456/mcp) | Node 22+, matching version of DSH host, bridge plugin mounted in DSH web profile; DSH and plugin dependencies are NOT in this kit |

## Step-by-Step Installation

1. Extract the package into a dedicated directory (e.g., `C:\MCP-Deployment`).
2. Run the interactive setup wizard:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-And-Setup.ps1
   ```
   Or select specific services:
   ```powershell
   .\Install-And-Setup.ps1 -Services overleaf,antigravity
   ```
3. Generated profiles are saved in `generated-profiles/`. Each profile uses an independent OpenAI Tunnel ID. Existing profiles are protected by default (use `-Force` to overwrite).
4. Launch each required tunnel in a dedicated console:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\launchers\Start-Overleaf-Tunnel.ps1
   powershell -NoProfile -ExecutionPolicy Bypass -File .\launchers\Start-Antigravity-Tunnel.ps1
   ```
   For Antigravity, the launcher executes `python -m antigravity_mcp` from the package directory.
5. For DSH ChatGPT bridge:
   - Mount `servers/deepseek-mcp` into your DSH web profile and install peer dependencies.
   - Start DSH web server listening on `127.0.0.1:3456`.
   - Run `powershell -NoProfile -ExecutionPolicy Bypass -File .\launchers\Start-DeepSeek-Bridge-Tunnel.ps1`.
   - Provide the active DSH profile bridge token and OpenAI Tunnel Runtime API Key when prompted.

## Privacy & Security

- No live credentials, passwords, session tokens, or personal paths are stored in configuration files or Git.
- Runtime keys are entered via masked secure strings and injected only into the process environment during execution, restoring the original environment upon exit.

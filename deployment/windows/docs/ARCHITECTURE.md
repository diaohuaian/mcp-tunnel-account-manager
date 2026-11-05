# MCP Windows Migration Architecture

This deployment package facilitates migrating three live MCP servers and their OpenAI tunnel runtime from one Windows machine to another.

## 1. Packaged Components

| Component ID | Implementation | Transport | Runtime | Entry File | Dependencies |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `overleaf-mcp` | `mcp-server-overleaf` v0.3.9 | stdio | node | `servers/overleaf-mcp/node_modules/mcp-server-overleaf/dist/index.js` | Bundled in node_modules |
| `antigravity-mcp` | `antigravity-mcp` v1.1.0 | stdio | python | `servers/antigravity-mcp/antigravity_mcp/__main__.py` | Standard library only |
| `deepseek-mcp` | `dsh-chatgpt-bridge` v0.6.0 | http | node | `servers/deepseek-mcp/lib/index.js` | DSH Cordis plugin / npm dependencies |

## 2. Tunnel Client & Management Console

- **Tunnel Client**: `tunnel-client/tunnel-client.exe` (v0.0.19) with Cloudflare Tunnel companion (`cloudflared.exe`) and upstream SPDX / NOTICE.
- **Console Archive**: `manager/MCP隧道账号控制台-Windows-x64-20261105-211616.zip` (SHA256: `c75e0472ac1b5de39358119f190e3a32fb55bb70cd892a5c7e1da4c423d81039`).

## 3. Privacy & Security Boundary

- **Zero Credentials**: No live API keys, session tokens, account databases, private papers, or personal paths are included.
- **Runtime Injection**: API keys are passed per-process via `Start-Mcp-Tunnel.ps1` using secure strings and environment variable injection that restores original environment upon exit.

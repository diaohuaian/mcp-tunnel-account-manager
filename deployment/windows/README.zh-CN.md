# MCP Windows 部署与迁移工具包

本部署包包含完整的 3 个 MCP 服务实际实现代码、OpenAI 隧道客户端、管理控制台安装包及便携启动脚本，专用于在新 Windows 机器（Windows 2）上无缝复现当前的 MCP 服务体系。

## 包含内容

1. **三大 MCP 服务实现** (`servers/`):
   - **Overleaf MCP** (`overleaf-mcp`): 基于 `mcp-server-overleaf` (Node.js / stdio 协议)
   - **Antigravity MCP** (`antigravity-mcp`): 基于 `antigravity-mcp` v1.1.0 (Python / stdio 协议)
   - **DeepSeek MCP** (`deepseek-mcp`): 基于 `dsh-chatgpt-bridge` v0.6.0 (Node.js / HTTP 协议，端口 3456)
2. **隧道客户端** (`tunnel-client/`): `tunnel-client.exe` (v0.0.19) 及 `cloudflared.exe`
3. **账号控制台** (`manager/`): `MCP隧道账号控制台-Windows-x64-20261105-211616.zip` (哈希已核实)
4. **模板与启动器** (`templates/`, `launchers/`): 包含安全密钥注入的 PowerShell 启动脚本
5. **初始化向导** (`Install-And-Setup.ps1`): 自动检测依赖并生成新机器配置文件

## 快速使用

1. 解压本工具包至新机器任意目录。
2. 运行 `powershell -ExecutionPolicy Bypass -File .\Install-And-Setup.ps1`。
3. 按照向导输入在新机器上为每个服务分配的 Tunnel ID。
4. 在 `launchers/` 目录下启动对应的隧道服务。

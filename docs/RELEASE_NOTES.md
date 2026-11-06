# MCP Tunnel Account Manager 1.2.0 Preview 1

Windows 本地 MCP 隧道账号控制台的公开预览版更新（包含最新控制台便携包与 Windows MCP 部署套件）。

## 本次版本核心更新

1. **隧道客户端生命周期接管与实时状态同步**：
   - 支持从控制台直接对已注册的 `stdio` / `http` MCP 服务执行隧道启动（`start`）、重启（`restart`）、停止（`stop`）与多账号切换（`switch`）。
   - 修复单服务启停后 `active_profiles` 版本号记录缺失导致误报 `pendingApply`（配置待应用）的问题，动作完成后立即刷新 `runtimeObserver` 内存态与前端视图。
   - 新增安全恢复闸门确认与解除机制，支持 carrier 服务确认保护与 TXT 批量配置导入导出。
2. **隧道启动与探测速度大幅提升**：
   - 将启动时首次控制面轮询参数优化为 `--control-plane.initial-poll-timeout 100ms`（保持后续轮询 `--control-plane.poll-timeout 10s`），消除启动阶段首次轮询干等 10 秒的问题，避免因首次长轮询未返回而误触发 `VERIFY_FAILED`。
   - `scripts/process-control.ps1` 引入 C# `Win32ProcessControl` 编译程序集磁盘缓存，配合常驻 PowerShell Worker 与原生 `Get-Process` 预筛选，将单次进程探测耗时从 **1450ms** 降至 **17ms~24ms**。
3. **路径探测与本地工具完善**：
   - 支持 Node.js、Python（`pyvenv.cfg` / `Scripts/*.exe`）及外部 HTTP/Bridge 服务的安装根目录、来源配置与可执行程序路径探测及环境变量（`%APPDATA%` / `%USERPROFILE%`）自动展开。
   - `scripts/start-manager.ps1` 新增 `-Stop` 参数，支持一键安全关闭本地 `127.0.0.1:17642` 控制台服务。

## 发行附件说明

- `MCP隧道账号控制台-Windows-x64-20261106.zip`：Windows x64 独立便携版控制台（内置 Node.js v25.9.0 运行时及许可证，解压后双击 `安装桌面图标.cmd` 即可使用）。
- `MCP-Windows-Deployment-Kit-20261106.zip`：包含 `overleaf-mcp`、`antigravity-mcp`、`deepseek-mcp` 及新版便携控制台的完整 Windows 部署迁移包。
- 发布包不含维护者的真实账号、API 密钥、隧道 ID 或本机私有配置。

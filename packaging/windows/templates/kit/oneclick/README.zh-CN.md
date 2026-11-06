# MCP Tunnel 一键启动（控制台）

可选组件：在桌面创建一个 **“MCP Tunnel 一键启动”** 快捷方式，用来启动本地控制台服务
<http://127.0.0.1:17642>。

它**只负责控制台本身**：

- 控制台已在运行时，直接打开页面；
- 未运行时，隐藏启动控制台，等待 `/api/auth/state` 就绪（通常几秒）后打开页面；
- **不会启动或停止** Overleaf / Antigravity 隧道，隧道在控制台页面里管理；
- 不读取、不打印、不保存任何 Tunnel ID、Runtime API Key 或账号数据。

## 安装

### 方式 A：部署包内已带 `oneclick` 目录（新构建）

在解压后的完整部署包根目录（应能看到 `Start-Console.ps1`）双击：

```text
oneclick\Install-Desktop-Shortcut.cmd
```

### 方式 B：使用仓库里的脚本（`v1.2.0-preview.2` 发行包尚未包含 `oneclick`）

先解压完整部署包，再在仓库 checkout 中指定解压目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\packaging\windows\templates\kit\oneclick\Install-Desktop-Shortcut.ps1 -BundleRoot "D:\MCP"
```

可选参数：`-Port 17643`（换端口）、`-ShortcutName "自定义名称"`、`-NoLaunch`（只建快捷方式、不立即打开页面）。

## 安装器做了什么

1. 校验目标目录下存在 `Start-Console.ps1`；
2. 把启动脚本和图标复制到稳定位置：
   `%LOCALAPPDATA%\McpTunnelAccountManager\launcher\`
   （因此移动/删除仓库目录后，快捷方式仍可用）；
3. 在桌面创建 `MCP Tunnel 一键启动.lnk`，目标为 Windows PowerShell，参数中带
   `-BundleRoot "<解压目录>"`；
4. 已存在同名快捷方式时，先备份到
   `%LOCALAPPDATA%\McpTunnelAccountManager\shortcut-backups\`；
5. 创建后回读校验目标路径与参数。

## 运行与日志

- 日志：`%LOCALAPPDATA%\McpTunnelAccountManager\logs\oneclick-console.log`
- 控制台启动输出：同目录下 `console-start.out.log` / `console-start.err.log`
- 如果控制台 60 秒内没有就绪，会弹出错误提示框并退出（退出码 1）

## 卸载

删除桌面上的 `MCP Tunnel 一键启动.lnk`，再删除
`%LOCALAPPDATA%\McpTunnelAccountManager\launcher\` 即可；不影响控制台数据和隧道配置。

## 常见问题

- **找不到 `Start-Console.ps1`**：`-BundleRoot` 要指向完整部署包的根目录（含 `Start-Console.ps1`、`console\`），不是 ZIP 内部或子目录。
- **桌面图标没刷新**：按 F5 刷新桌面；必要时重启资源管理器。
- **端口被占用**：控制台默认拒绝启动而不是强杀进程；换 `-Port` 或先关闭占用端口的旧实例。
- **想开机自启**：可把该快捷方式放入 `shell:startup`，但请确认不会与控制台自身的启动方式重复。

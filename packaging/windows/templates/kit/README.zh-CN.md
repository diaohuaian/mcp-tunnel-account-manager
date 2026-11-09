# MCP Windows 完整部署工具包

**构建标识：{{RELEASE_ID}} · Windows 10/11 x64 · 本地优先 · 不携带账号与密钥**

这是为其他电脑重新部署准备的完整工具包，控制台来自当前源码（快照 `{{SOURCE_SNAPSHOT}}`，合并 `main` 与 `new` 两条分支的全部修复）。应用版本保持 `1.0.0`；此构建标识不是已经创建或验证过的 GitHub Release tag。

## 包含与不包含

| 组件 | 状态 |
| --- | --- |
| 本地账号控制台 / Web 界面 | [console](<console/>)，以合并后源码构建；含凭证掩码自愈保护、有界并发校验、真实 PID 观测与隐藏控制台继承修复 |
| Node.js v25.9.0 Windows x64 | [console/runtime](<console/runtime/>)，供控制台与 Overleaf 共用，不需 npm install；此版本为非 LTS，本轮未联网替换 |
| OpenAI tunnel-client 0.0.19 / Cloudflared 2026.10.2 | [tunnel-client](<tunnel-client/>)，保留原许可证、NOTICE、SPDX 和版本来源信息 |
| Overleaf MCP 0.3.9 | [servers/overleaf-mcp](<servers/overleaf-mcp/>)，包含现有 npm 生产依赖和锁文件，Node 最低 **22.14.0** |
| Antigravity MCP 1.1.0 | [servers/antigravity-mcp](<servers/antigravity-mcp/>)，Python 标准库实现；需自行安装 **Python 3.9+** 和已登录的 Antigravity IDE |
| DSH ChatGPT bridge 0.6.0 | [servers/deepseek-mcp](<servers/deepseek-mcp/>)，可选的本地 RC.2 兼容插件代码；**未捆绑 DSH 主程序和桥接依赖** |
| 账号 / API Key / Tunnel ID / 登录授权 | **不包含**。目标机需要自己的有效配置、网络和服务授权 |

“包含依赖”指控制台、Node、隧道程序与 Overleaf 的现有本地运行文件齐全，不代表所有外部服务都能离线使用，也不代表 Python、IDE、DSH 已安装。

## A. 先启动控制台

1. 把整个 ZIP 解压到固定、当前用户可写的目录，例如 `C:\MCP-Tools`。不要在 ZIP 内运行，也不要只复制某个启动器。
2. 双击 [Verify-Package.cmd](<Verify-Package.cmd>)；另对照 Release 的 SHA256SUMS.txt 校验 ZIP。校验通过后再开始本机配置。
3. 双击根目录 [Start-Console.cmd](<Start-Console.cmd>)，浏览器应打开 `http://127.0.0.1:17642`。
4. 第一次运行，在 `%LOCALAPPDATA%\McpTunnelAccountManager\bootstrap-code.txt` 找到本机新生成的初始化码，设置自己的管理密码。不要把初始化码发给别人。
5. 可选：双击 [Install-Console-Shortcut.cmd](<Install-Console-Shortcut.cmd>) 创建桌面快捷方式。同名旧链接会先备份；移动安装目录后应重新创建链接。

控制台只绑定 `127.0.0.1`，不能直接当公网管理后台使用。完整包的入口会给控制台指定包内 tunnel-client 路径；不需要往原机器的用户目录复制任何程序。

若端口已被旧版占用，新版会拒绝而不是结束其他进程。请手动关闭旧版，或先用独立端口与数据目录试用：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Start-Console.ps1 -Port 17643 -DataDirectory "$env:LOCALAPPDATA\McpTunnelAccountManager-Preview"
```

停止此目录启动器创建的控制台（参数必须与启动时一致）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\console\scripts\start-manager.ps1 -Stop
```

只会停止经过路径、命令行、创建时间核对的本版本进程，不会按端口批量杀进程，也不停止 IDE 或已运行的隧道。

## B. 准备自己的 Tunnel ID

在 OpenAI 隧道管理侧取得服务所需的独立 Tunnel ID 和 **Runtime API Key**。每个服务、每台同时在线的电脑应使用不同 Tunnel ID，不能直接复用作者机器的 ID。Runtime API Key 也不是 ChatGPT API key、Overleaf Cookie 或 DSH 桥接令牌。

只部署 Overleaf（默认选择，不依赖 Python/DSH）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-And-Setup.ps1 -Services overleaf -OverleafTunnelId "替换为你自己的TunnelID"
```

也部署 Antigravity（先在目标机安装 Python 3.9+，确保 Antigravity IDE 可正常登录使用）：

```powershell
# 使用 PowerShell 直接调用，以正确传递 string[] 参数。
.\Install-And-Setup.ps1 -Services overleaf,antigravity -OverleafTunnelId "自己的OverleafID" -AntigravityTunnelId "自己的AntigravityID"
```

需要先允许此解压目录的脚本执行时，可仅对当前 PowerShell 进程设置：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
```

向导只生成本机 [generated-profiles](<generated-profiles/>) 配置，不启动隧道、不安装插件，也不写入 API Key。缺少依赖、空 ID、重复 ID 时会拒绝；已存在配置默认不覆盖，需要明确加 `-Force`。生成的路径指向当前解压目录，因此移动文件夹后要重新生成配置。只选择你要使用的服务；完整包存在 DSH 代码并不要求启用 DSH。

## C. 两种运行方式，选一种管理同一项服务

### 方式一：独立隧道启动器（最直接的冒烟验证）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\launchers\Start-Overleaf-Tunnel.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\launchers\Start-Antigravity-Tunnel.ps1
```

每个启动器单独运行；运行时会隐藏输入 Runtime API Key，并仅放入该子进程的环境变量。关闭启动窗口或 Ctrl+C 停止当前隧道。启动器不把 Key 写进 YAML，不修改系统级环境变量；结束后恢复原进程环境。

Overleaf 首次需要的浏览器授权/会话、Antigravity IDE 登录及其本地可用性，要由目标机自己完成。不要把别人的 Cookie、浏览器目录或 IDE 账户目录复制到安装包。

### 方式二：交给账号控制台管理

向导为所选的 Overleaf/Antigravity 同时生成 [console-services.json](<generated-profiles/console-services.json>)，格式为 `mcpServers`，包含包内可执行文件、参数及工作目录，**没有凭据**。

1. 在控制台页面使用“导入配置”选取这个 JSON；确认服务名称、stdio 程序路径、参数和工作目录。
2. 对照你的隧道配置，在控制台为自己的账号填写各服务的 Tunnel ID / Runtime API Key；初始占位服务的 `node` 或 `antigravity-mcp` 默认绑定不能视作已经安装好，需要按导入结果核对。
3. 再执行页面里的探测/启用流程，确认 MCP 初始化与隧道状态。
4. 不要同时用独立启动器和控制台启动同一个 Tunnel ID，避免抢占。先明确停止前一种管理方式再切换。

完整包只自动提供隧道程序路径，不擅自更改用户账号库或自动导入凭据，也不会绕过服务自身授权。

## D. 可选：DSH ChatGPT 桥接

不使用此服务可以跳过。这里带的是桥接插件代码，不是独立 HTTP 程序；不能直接 `node lib/index.js` 当服务启动。

本地副本的桥接包版本 `0.6.0`，peer dependencies 指向 DSH `0.2.0-rc.2`。同为 `0.6.0` 的其他分发可能采用不同 Cordis 插件接口，不能只按版本名替换。DSH 主程序和桥接依赖需要在目标机联网安装，此包不自动安装，也不改变任何现有 DSH profile。

以下操作仅在目标机、使用相容的 DSH 主程序时手动执行，先核对官方 CLI 版本和插件说明：

```powershell
$bridgeFolder = (Resolve-Path .\servers\deepseek-mcp).Path
npx --yes @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add ("file:" + $bridgeFolder)
npx --yes @deepseek-ai/dsh@0.2.0-rc.2 web
```

必须在实际启动 Web 的 **web profile** 加载桥接，不是装在另一个 profile 后期望当前 Web 自动生效。确认桥接已在 `http://127.0.0.1:3456/mcp` 提供服务，并在目标机配置自己的桥接令牌后，才生成并运行桥接隧道：

```powershell
.\Install-And-Setup.ps1 -Services deepseek -DeepSeekTunnelId "自己的DSH隧道ID"
.\launchers\Start-DeepSeek-Bridge-Tunnel.ps1
```

启动器分别隐藏输入 OpenAI Runtime API Key 与 DSH 桥接令牌；二者不是同一种凭据。该可选链路本轮没有替你安装、启动或完成外网端到端验证。

## E. 数据、更新和验证范围

- 本地账号库、加密主密钥、管理密码、初始化码和日志默认留在 `%LOCALAPPDATA%\McpTunnelAccountManager`。安装目录可以替换，用户数据不能公开上传；备份时连同主密钥妥善保管。
- 升级前退出旧控制台并备份自己的数据目录，再解压新版本。不要并行运行两份程序访问同一数据库；也不要用旧包整体覆盖新包。
- 运行向导后出现的新配置不属于原始发布文件。需要再次校验原包文件且容许这些配置时，使用 `powershell -File .\Verify-Package.ps1 -AllowGeneratedProfiles`。
- 本次验证会在同一 Windows 主机上重新解压到隔离目录，测试校验、运行环境、登录/CSRF/加密持久化、快捷方式安装到临时目录，以及 MCP initialize/tools-list。不发送模型任务，不使用真实账号或 API Key。
- 这不是第二台实体机验收，也不是完整上游回归、联网漏洞审计、真实 Overleaf/Antigravity/DSH 外网业务认证。实际执行结果与限制以 Release 验证报告为准。

组件与来源见 [package-manifest.json](<package-manifest.json>)，文件哈希见 [FILES.sha256](<FILES.sha256>)。原源码旧 manifest 中两项哈希已过时，本包使用快捷方式目标目录的实际文件；来源差异见 [source-provenance.json](<console/source-provenance.json>)，当前源码及新发布包各自重新记录校验值。授权说明见 [THIRD-PARTY-NOTICES.md](<THIRD-PARTY-NOTICES.md>)，控制台详情见 [console/README.md](<console/README.md>)。原控制台未附项目自身许可证，本次不替作者擅自选定许可；公开发布前请确认项目授权。

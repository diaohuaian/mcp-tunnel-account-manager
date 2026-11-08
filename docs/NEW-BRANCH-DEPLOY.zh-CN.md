# new 分支部署说明（Windows）

`new` 是本次功能更新的独立源码分支，基于 `main` 的 [0d8eea4](https://github.com/zwsxzy/mcp-tunnel-account-manager/commit/0d8eea4d13eea8f4d27ec02ea0010e3d6a623a5c) 快照，保留已合入的一键桌面快捷方式功能，并加入检验提速、真实 PID 显示与后端隐藏控制台修复。

**旧的 `v1.2.0-preview.2` Release ZIP 不含这些新修复。** 本说明不要求替换旧 Release、关闭现有 MCP/DSH 或复用作者机器的配置。

## 1. 准备环境

- Windows 10/11 **x64**、浏览器、系统自带 Windows PowerShell **5.1**。
- 安装 [Node.js](https://nodejs.org/) **22.14.0+**，建议使用受支持的 LTS 版本，并确保 `node` 在 PATH 中。
- 使用 Git 克隆时安装 [Git for Windows](https://gitforwindows.org/)。也可直接下载下方源码 ZIP。
- 控制台没有第三方 npm 运行依赖，**不用 `npm install`**。这不代表各个 MCP 后端也不需要安装依赖。

确认 Node 版本：

```powershell
node --version
```

建议放在短、固定、当前用户可写的目录。不要在 ZIP 内运行，不要以管理员权限共享一份账号库。

## 2. 下载并启动

### 用 Git

在你选定的父目录执行：

```powershell
git clone --branch new --single-branch https://github.com/zwsxzy/mcp-tunnel-account-manager.git mcp-tunnel-account-manager-new
cd mcp-tunnel-account-manager-new
git branch --show-current
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\open-portable-console.ps1
```

分支应为 `new`。启动器会在后台启动管理器、确认就绪，然后打开 <http://127.0.0.1:17642>。它不会按端口强杀已有程序，也不会替你登录外部服务。

### 不用 Git

下载 [new 分支源码 ZIP](https://github.com/zwsxzy/mcp-tunnel-account-manager/archive/refs/heads/new.zip)，解压后进入有 [package.json](../package.json) 的仓库根目录，再运行相同启动命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\open-portable-console.ps1
```

**源码 ZIP 不含 Node、隧道二进制或完整 MCP 生产依赖。** 不要把它当作旧版完整部署包，也不要把旧包的 console 目录覆盖到此目录。

## 3. 首次初始化与数据位置

首次运行时，在自己的本地数据目录找到初始化码，用它在浏览器中设置管理密码：

```text
%LOCALAPPDATA%\McpTunnelAccountManager\bootstrap-code.txt
```

初始化码不写入后台日志。不要把它、账号库、主密钥、API Key、Cookie、浏览器/IDE profile 或初始化后的整个数据目录发给别人，也不要上传 GitHub。

每台电脑分别初始化，分别使用自己的账号和授权；不要直接复制维护者的数据目录。

## 4. 准备你要用的服务

只启动管理器不代表所有 MCP 后端已经安装。按实际需要准备：

| 组件 | 目标机准备事项 |
| --- | --- |
| 隧道客户端 | 从可信来源安装 Windows x64 `tunnel-client` 及其所需配套文件，使用自己的 Tunnel ID、Runtime API Key 和授权。源码模式默认查找 `%USERPROFILE%\.openai-tunnel\tunnel-client.exe`。 |
| Overleaf MCP | 安装对应 MCP 后端及其生产依赖，使用自己的项目和凭据；Git 相关工具需要 Git for Windows，只有本地编译还需要 TeX/latexmk。 |
| Antigravity MCP | Python 3.9+、后端所需 Python 依赖，以及可正常运行、已登录的 Antigravity IDE。 |
| 可选 DSH Bridge | 与实际 DSH 宿主匹配的插件、依赖、登录与自己的令牌；不能只看桥接版本号猜测兼容性。暂时不用时明确禁用其参与切换，不删除配置、不绕过认证。 |

可以把已核验的旧完整部署包作为**第三方程序与依赖的来源**，但不要启动其中的旧控制台来代替 `new`，也不要套用旧包的源码哈希验证本分支。依赖范围可参考[旧发行版部署指南](releases/v1.2.0-preview.2/README-Release.zh-CN.md#2-外部依赖不是所有服务都能离线开箱使用)；其旧包启动步骤不适用于本分支源码。

在管理器中添加/导入自己的账号与 MCP 服务配置，核对程序路径、工作目录和服务是否参与切换，再填写自己的凭据。默认内置服务的本地隧道配置位置是：

```text
%APPDATA%\tunnel-client\overleaf.yaml
%APPDATA%\tunnel-client\antigravity-local.yaml
```

配置里的后端程序必须在目标机真实存在，不能照抄作者机器的路径。若填写由 Go 隧道客户端解析的 Windows MCP 命令，建议将路径写成 `C:/...` 形式，避免命令词法解析把反斜杠当成转义。也不要同时用独立启动器和管理器启动同一个 Tunnel ID；每台同时在线的电脑、每项服务应使用独立 ID。

仓库的历史 [deployment/windows](../deployment/windows) 是源码与旧说明，不是含全部二进制的完整包。原始模板中的路径和 ID 只是示例，不能替代上述安装与本机配置。

## 5. 已有版本正在运行：先隔离试用

**不要让两份管理器同时打开同一个账号库。** 试用时使用独立数据目录和端口；先初始化空配置，不要让两份实例同时启用同一个 Tunnel ID：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\open-portable-console.ps1 -Port 17643 -DataDirectory "$env:LOCALAPPDATA\McpTunnelAccountManager-new"
```

地址是 <http://127.0.0.1:17643>，初始化码在这个独立数据目录中。此操作不迁移旧账号库，不会主动关闭旧管理器、MCP 或 DSH。

确认后再备份自己的旧数据，使用旧版本对应的停止方式退出旧管理器，再选择是否迁移；不要仅因端口被占用就执行按程序名批量终止命令。移动安装目录后，原快捷方式、配置中的路径也应相应更新。

## 6. 窗口、PID 与停止方式

- 管理器后台入口不会要求保留一个 cmd 窗口；主动在终端执行 `npm.cmd start` 则是前台调试模式，终端保留是正常行为。
- 新启动的 Windows 隧道使用真实隐藏控制台，普通后端子进程继承该控制台；不是启动后遍历并隐藏系统里所有终端。
- **只影响下次启动或切换。已有窗口不会被强行隐藏或关闭，当前 MCP/DSH 不会因安装源码而重启。** 如果后端显式创建自己的 GUI/新窗口，不把该行为算作可普遍隐藏的普通控制台继承。
- 服务状态仍显示真实 PID；核验保留可执行文件、精确启动时间、监听归属、配置指纹和认证证据。提速不是跳过健康检查。
- 切换准备、应用和回滚仍按安全顺序执行；单轮严格验证有界并发，复用该轮进程快照，不跨轮缓存认证成功结果。

使用后台入口启动后，在**同一个源码目录**停止这个管理器：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-manager.ps1 -Stop
```

独立试用实例的停止参数必须与启动时一致：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-manager.ps1 -Stop -Port 17643 -DataDirectory "$env:LOCALAPPDATA\McpTunnelAccountManager-new"
```

停止器核对自己记录的程序、入口和创建时间，不会按 PID 猜测或按端口批量终止。它只停止管理器，不自动停止所有隧道、IDE 或 DSH。前台调试模式用 Ctrl+C 退出，不使用后台 PID 文件停止器。

## 7. 验证与故障排查

发布前运行的验证入口，不需要你的真实隧道账号：

```powershell
npm.cmd run check
npm.cmd run test:all
npm.cmd run validate-all
```

### 本分支发布前已执行的检查（2026-11-06）

验证环境为同一台 Windows x64 主机、Windows PowerShell 5.1、Node v25.9.0；不是第二台实体机验证，也没有覆盖所有满足最低版本声明的 Node 运行时。

- **语法检查：114/114 个文件通过。**
- **完整回归：62/62 个测试文件通过。** 清理测试样例中的作者用户名后再次执行，仍为 62/62。
- **质量门禁复查：43/43 个轻量测试文件通过。** 但不能据此声称没有下述既有测试波动。
- **按本文后台入口做全新部署冒烟检查通过**：独立用户环境、含空格的独立数据目录、随机本地端口、不打开浏览器；首次未初始化状态正确，受保护 API 返回 401，提供的前端与新源码一致，停止器只停止该测试管理器。未启动真实外部服务。
- **公开文件检查**：对暂存源码快照扫描，未留待处理的敏感信息命中；14 处扫描命中逐项确认为既有的确定性测试凭据/密码样例。未纳入本机账号库、密钥、日志、运行身份记录或服务二进制；测试路径改为通用样例。

**已知问题，不以复查通过掩盖**：一次重复质量门禁中，既有的“超过 1 MiB 请求应返回 413”用例出现 `read ECONNRESET`。对未修改的 HTTP 服务端及该测试专项执行 10 轮，8 轮通过、2 轮同样出现连接重置；随后的一次明确门禁复查通过。这意味着超限请求的客户端仍可能收到连接重置而非完整 413 响应，**本分支没有修复该既有问题**。原始失败记录已保留，没有改断言或静默重试；它不改变完整回归与隔离启动检查的实际结果，也不代表质量门禁每次都能通过。

### 隐藏控制台验证边界

本次修复已在同一台 Windows 主机对候选和实际部署代码验证：官方 Go 隧道的隔离副本、本机 mock 控制面和合成凭据启动 Go → Node → C# 后端；三者共享同一个真实隐藏控制台，子进程 stdio 回环通过。该检查没有向控制面派发 MCP 初始化请求，不等于公网 ChatGPT 对话或真实业务工具验收，也不是第二台实体机验证。现有真实服务另行通过严格认证核验，未为隐藏窗口而重启。

常见问题：

- **找不到 Node / 版本过低**：安装 22.14.0+，重新打开终端后再检查 PATH。
- **端口占用**：选择独立端口，不要批量终止 node/cmd/powershell。
- **首次启动失败**：检查所选数据目录中对应端口的 stderr 日志；本地路径、ACL、PowerShell 或 .NET 的错误应先解决，不应关闭认证绕过。
- **找不到隧道或后端程序**：源码包不是依赖全集，回到第 4 节检查本机安装和路径。
- **切换 VERIFY_FAILED**：查看目标服务和脱敏原因，先修复对应上游/授权；参考[安全切换说明](SAFE-SWITCH-FIX.zh-CN.md)，不要把返回 200 或仅有 PID 当成认证成功。
- **公开求助**：仅分享脱敏错误，不要贴完整环境变量、启动命令、账号库、初始化码、Runtime API Key、Bearer token 或本地配置全文。

旧 Release 的固定构建号、来源哈希和第三方许可索引保持原样。`new` 未创建新的二进制 Release；若维护者后续重新打包，应使用新的构建标识、来源清单和验证报告，不能冒用旧 RC19 的校验结果。

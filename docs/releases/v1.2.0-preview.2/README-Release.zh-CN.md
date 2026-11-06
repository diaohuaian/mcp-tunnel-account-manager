# MCP 隧道账号控制台：Release 上传与部署说明

发行构建标识：`20261106-rc19-r1`。目标平台：**Windows 10/11 x64**。

这是桌面快捷方式实际指向的 RC19 项目对应的发行文件，不是把整台电脑、账号资料或旧部署目录直接压缩。控制台应用元数据仍是 `1.0.0`；本次 GitHub 预览 tag 为 `v1.2.0-preview.2`，与构建标识 `20261106-rc19-r1` 相互独立。

## 1. 下载哪个包

| 文件 | 大小（十进制） | 用途 |
| --- | ---: | --- |
| [MCP-Windows-Deployment-Kit-20261106-rc19-r1.zip](https://github.com/zwsxzy/mcp-tunnel-account-manager/releases/download/v1.2.0-preview.2/MCP-Windows-Deployment-Kit-20261106-rc19-r1.zip) | 68.8 MB | **推荐给其他电脑部署**。包含控制台、共用 Node、tunnel-client、Cloudflared、Overleaf MCP 的现有 npm 生产依赖、Antigravity MCP 源码，以及可选 DSH 桥接代码。 |
| [MCP-Tunnel-Console-Windows-x64-20261106-rc19-r1.zip](https://github.com/zwsxzy/mcp-tunnel-account-manager/releases/download/v1.2.0-preview.2/MCP-Tunnel-Console-Windows-x64-20261106-rc19-r1.zip) | 35.9 MB | 仅控制台和 Node；不带隧道及 MCP 服务程序，适合已有服务环境的人。 |
| [MCP-Tunnel-Console-Source-20261106-rc19-r1.zip](https://github.com/zwsxzy/mcp-tunnel-account-manager/releases/download/v1.2.0-preview.2/MCP-Tunnel-Console-Source-20261106-rc19-r1.zip) | 0.275 MB | 控制台源码、部署脚本、打包工具和发行测试；不带 Node，也不是完整依赖部署包。 |

三个包是不同用途，**不需要叠加解压**，也不要把旧工具包的 console 目录覆盖到新包。

发行包中的核心业务源码共 35 个文件与快捷方式目标快照一致。旧源目录 manifest 有两项历史哈希过时，已以当前实际文件为准核验，未为了匹配旧哈希而回退文件。包内保留来源差异说明和新文件哈希。

## 2. 外部依赖：不是所有服务都能离线开箱使用

按实际启用的服务准备，不需要为了只用控制台而安装所有组件。

| 使用范围 | 目标机还需要什么 |
| --- | --- |
| 只运行完整包或便携包的控制台 | Windows x64、系统自带 Windows PowerShell 5.1、浏览器。Node v25.9.0 已带，不必 npm install。该 Node 为非 LTS，本次未联网替换。 |
| Overleaf 的 Git 相关读写/同步工具 | **Git for Windows，且 git 在 PATH 中**；自己的 Overleaf 项目配置和 Git token；项目拥有可用的 Git integration 权限。Git 未捆绑。权限取决于项目所有者的订阅或机构授权，不能仅凭访问者是免费账号就断定不可用。 |
| Overleaf 的 compile_project | 另外安装 latexmk 和 TeX 发行版；其他工具不要求 TeX。TeX 未捆绑。 |
| Antigravity MCP | Python 3.9+、可正常使用并已登录的 Antigravity IDE，及对应授权/网络；Python 和 IDE 未捆绑。 |
| 可选 DSH ChatGPT 桥接 | 相容的 DSH 主程序、插件依赖、有效登录和自己的桥接令牌。包中仅带本地 RC.2 兼容桥接代码，不承诺与任意 DSH 版本兼容。 |
| 对外隧道 | 每个服务、每台同时在线的电脑独立的 Tunnel ID、自己的 Runtime API Key，以及可用网络和服务授权。Key 不是 Overleaf Cookie，也不是 DSH 桥接令牌。 |

Overleaf 上游 README 说明其 Windows Git/TeX 业务流程尚未纳入原上游验证矩阵；本次只验证本地 MCP initialize/tools-list，没有替目标机验证真实读写、推送或编译。

## 3. 新电脑快速开始（推荐完整包）

1. 下载完整包及校验文件。对下载 ZIP 计算 SHA256，与 [SHA256SUMS.txt](<SHA256SUMS.txt>) 对照：

   ```powershell
   Get-FileHash -Algorithm SHA256 -LiteralPath .\MCP-Windows-Deployment-Kit-20261106-rc19-r1.zip
   ```

2. **解压到短、固定、当前用户可写的目录**，例如 `C:\MCP` 或 `D:\MCP`。ZIP 自带顶层目录；不要放进很深的“下载/项目/备份”多层目录，也不要在 ZIP 内直接运行。实测过深路径会触及 Windows 传统 260 字符限制；无需为此修改系统注册表或权限。
3. 进入解压后的完整工具包根目录，先验证，再启动：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\Verify-Package.ps1
   .\Start-Console.cmd
   ```

4. 浏览器默认打开 `http://127.0.0.1:17642`。首次初始化码只在本机生成，位于 `%LOCALAPPDATA%\McpTunnelAccountManager\bootstrap-code.txt`，用它设置自己的管理密码。不要公开这个码或本地数据目录。
5. 可选创建桌面快捷方式：

   ```powershell
   .\Install-Console-Shortcut.cmd
   ```

   同名旧链接会先备份；移动安装目录后需重新创建链接。

### 配置并启用服务

先按第 2 节准备所选服务的外部依赖。Overleaf 可先检查：

```powershell
git --version
```

然后在完整工具包根目录运行向导，只选择需要的服务。以下命令的 ID 必须替换为自己的真实 ID：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-And-Setup.ps1 -Services overleaf -OverleafTunnelId "替换为你自己的TunnelID"
```

向导只生成本机配置，不启动隧道、不安装 DSH、不保存 API Key。已存在配置默认不覆盖。配置记录当前安装路径，移动目录后需重新生成。

后续选择一种方式：

- 在控制台中导入向导生成的 `generated-profiles\console-services.json`，核对程序路径、参数和工作目录，再填写自己的服务配置与凭据；或
- 按包内中文说明使用独立服务启动器，在运行时安全输入自己的 Runtime API Key。

不要同时用两种方式启动同一个 Tunnel ID。Overleaf 的 token/项目、可选 Cookie、Antigravity 登录都应在目标机自行配置，不要复制作者机器的登录目录。

### 旧版本仍在运行时

新启动器不会按端口强杀进程。先在新端口和独立数据目录试用，避免两份程序同时访问同一个账号库：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Start-Console.ps1 -Port 17643 -DataDirectory "$env:LOCALAPPDATA\McpTunnelAccountManager-Preview"
```

确认后，手动退出旧版并妥善备份自己的原数据目录，再切换。停止新包启动的实例时，端口、数据目录必须与启动时一致：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\console\scripts\start-manager.ps1 -Stop -Port 17643 -DataDirectory "$env:LOCALAPPDATA\McpTunnelAccountManager-Preview"
```

不要上传本地账号库、加密主密钥、初始化码、日志或配置中加入的真实凭据。

## 4. 上传 GitHub Release

本构建的发布目标是 [zwsxzy/mcp-tunnel-account-manager 的 v1.2.0-preview.2 预览版](https://github.com/zwsxzy/mcp-tunnel-account-manager/releases/tag/v1.2.0-preview.2)。部署文件验证与 GitHub 发布是独立步骤；下列检查清单也适用于维护者后续发布。

1. 先确认项目自身的公开分发许可。原控制台快照没有附项目许可证，本次不擅自替作者选择 MIT/Apache；第三方许可证、NOTICE 和组件清单已随包保留，但这不等于法律合规审计。
2. 本次使用 `v1.2.0-preview.2` 并标记为 Prerelease；后续发布仍应由维护者确认目标仓库和新 tag，不覆盖历史 tag 或提交。构建标识用于追踪发行载荷，不代替 GitHub tag。
3. 复制 [RELEASE_NOTES.zh-CN.md](<RELEASE_NOTES.zh-CN.md>) 作为 Release 正文。
4. 上传本目录中的三个 ZIP、[SHA256SUMS.txt](<SHA256SUMS.txt>)、本说明和验证报告。不要上传测试工作区、真实账号库、原桌面快捷方式、IDE/浏览器 profile 或日志。
5. GitHub 自动生成的 “Source code (zip/tar.gz)” 对应 tag/commit，**不会因为上传自定义源码 ZIP 而自动改变**。本次发布流程会先同步核心源码对应的启动器、打包工具和模板，再为该提交创建 tag；仓库保留既有测试。自动源码仍不含 Node、隧道二进制及完整 MCP 依赖，不能当作完整部署包。
6. 发布后，最好在另一台干净的 Windows x64 电脑按本说明验收。当前结果是同一主机隔离解压验证，不是第二台实体机或真实外网业务验收。

已执行的检查、未执行的链路与限制见 [VALIDATION.zh-CN.md](<VALIDATION.zh-CN.md>)；机器可读结果见 [validation-report.json](<validation-report.json>)。

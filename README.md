# MCP Tunnel Account Manager

Windows 本地 MCP 隧道与账号管理控制台，通过浏览器管理多个账号、MCP 配置及安装位置。

**当前公开预览版：[v1.2.0-preview.4](https://github.com/zwsxzy/mcp-tunnel-account-manager/releases/tag/v1.2.0-preview.4)**，部署构建标识 `20261109-rc21-r1`。应用元数据仍为 `1.0.0`，不把部署构建号冒充业务版本号。

**当前分支：`final` 综合合并版**，完整合并并保留了 `main` 分支（含 v1.2.0-preview.3 的凭证掩码自愈与保护、异步监听器有界探测、审计回滚恢复）与 `new` 分支（含验证检验并发提速、进程真实 PID 观测、Windows 后端子进程隐藏控制台继承修复）的所有功能与修复，并通过了全套测试。

`v1.2.0-preview.4`（构建标识 `20261109-rc21-r1`）相对 `v1.2.0-preview.3` 的变化：合并 `new` 分支的验证并发提速、进程真实 PID 观测与 Windows 隐藏控制台继承修复；按合并后的源码重新计算 `source-core-hashes.json` 基线（旧 RC19/RC20 基线已不再成立），并在 `source-provenance.json` 中补齐 `new` 分支特性记录；修正前端编辑态下"整条服务无变更即整体省略"与测试断言不一致导致的 `ui-registry` 用例失败。

## 部署与启动

### macOS 部署与启动

macOS 系统要求：Node.js **22.14.0+**（推荐通过 `brew install node` 安装）及 Git。控制台为纯 Node.js 标准库实现，零第三方 npm 运行依赖，无需 `npm install`。

**1. 快捷启动（双击或终端启动）**：
- **Finder 双击**：直接双击项目根目录下的 `Start-Console.command` 即可一键启动后台服务并在浏览器中打开控制台。
- **终端启动**：
```bash
./start-manager.sh
```
该脚本会在后台安全启动管理器，自动探测就绪状态并在系统默认浏览器中打开 <http://127.0.0.1:17642>，并输出本次实例的初次访问引导码（Bootstrap Code）。

常用参数：
- 停止后台服务：`./start-manager.sh --stop`
- 前台运行调试：`./start-manager.sh --foreground`（或 `npm start`）
- 自定义端口：`./start-manager.sh --port 18000`

**2. 安装 OpenAI tunnel-client（如果本地未安装）**：
控制台配套的隧道进程需要 OpenAI 官方的 `tunnel-client` 及 `cloudflared`。本项目提供了 macOS 原生二进制一键安装脚本：
```bash
./scripts/install-tunnel-client.sh
```
该脚本会自动检测当前芯片架构（Apple Silicon `arm64` 或 Intel `amd64`），从 OpenAI 官方仓库安全下载匹配的 v0.0.19 原生二进制文件并安装至 `~/.openai-tunnel/`，解除 macOS 隔离属性并赋予执行权限。

**3. 安装 Overleaf MCP 服务（如果本地未安装）**：
如需连接 Overleaf 文档编辑能力，可运行配套的安装脚本：
```bash
./scripts/install-overleaf-mcp.sh
```
该脚本会将官方 `mcp-server-overleaf`（0.3.9）安装至 `~/.overleaf-mcp/runtime`，并创建全局快捷软链接 `mcp-server-overleaf`。

**4. 安装 Antigravity MCP 服务（如果本地未安装）**：
如需连接本地 Antigravity IDE 智能体引擎调度能力，可运行配套的安装脚本：
```bash
./scripts/install-antigravity-mcp.sh
```
该脚本会将 [Kio-pon/antigravity-mcp](https://github.com/Kio-pon/antigravity-mcp) 克隆至 `~/.antigravity-mcp`，并生成全局执行入口 `antigravity-mcp`。

**5. 安装桌面快捷方式（可选）**：
```bash
./Install-Desktop-Shortcut.sh
```
执行后会在 `~/Desktop` 生成可直接双击启动的 `MCP Tunnel Account Manager.command` 快捷方式。

macOS 默认数据存储目录位于：
```text
~/Library/Application Support/McpTunnelAccountManager
```

---

### Windows 部署与启动

Windows 10/11 x64，先安装 Node.js **22.14.0+**、Git 和系统自带 Windows PowerShell 5.1。控制台本身没有第三方 npm 运行依赖，无需 `npm install`：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\open-portable-console.ps1
```

或使用 Windows 批处理入口：
```cmd
.\Start-Console.cmd
```

该入口后台启动管理器，确认就绪后打开 <http://127.0.0.1:17642>。首次使用在本机初始化自己的账号与密码；MCP 服务、隧道程序及外部登录需要自行准备，仓库不提供维护者的账号、密钥或运行数据。

- **检验并发提速**：使用有界并发和单轮快照复用，严格认证及回滚顺序不变。
- **真实 PID 观测**：服务卡片保留真实 PID；过期或未经证实的进程状态清晰标注。
- **Windows 后端隐藏窗口修复**：新启动的后端继承真实隐藏控制台，不只是隐藏根进程，彻底杜绝 stdio 子进程弹框。
- **凭证脱敏与自愈保护**：表单保存与切换自动阻断掩码假值，自愈历史被污染的脱敏 ID，杜绝回滚。
- **一键桌面快捷方式**：可选运行 `Install-Desktop-Shortcut.cmd` 安装桌面便捷启动入口。

## 安全切换与凭证脱敏自愈保护

在 `v1.2.0-preview.3` 中，彻底解决了切换账号或保存配置时脱敏掩码（如 `tun_***4a5`）污染真实加密凭证导致后续原子事务在校验阶段报 `VERIFY_FAILED / HEALTH_URL_REQUIRED` 并触发回滚的问题：
1. **前端星号掩码拦截**：UI 在表单提交和切换请求中自动识别并剔除脱敏假值，避免将掩码发往后端；
2. **后端 Store 保护与自愈**：在更新 Profile 时如遇掩码自动保留已有真实值；服务启动与预热时自动检测并从有效账号自愈恢复历史被污染的脱敏 ID；
3. **适配器预检诊断**：MCP 适配器层增加前置凭证完整性校验，精准提示缺失凭证并阻断无效请求；
4. **零隐私泄漏**：严密的代码与打包审计，代码库与发布包绝不携带任何真实 API Key、Cloudflare 真实隧道 ID 或主密钥文件。

## 上一版 Release 的 Windows 部署（rc20 / v1.2.0-preview.3，历史版本与依赖参考）

目标平台：Windows 10/11 x64。普通用户无需从源码安装依赖。以下步骤对当前 `v1.2.0-preview.4` 同样适用，仅需把链接替换为上表对应附件。

1. 从上表或 [上一版 Release](https://github.com/zwsxzy/mcp-tunnel-account-manager/releases/tag/v1.2.0-preview.3) 下载 **[完整部署包](https://github.com/zwsxzy/mcp-tunnel-account-manager/releases/download/v1.2.0-preview.3/MCP-Windows-Deployment-Kit-20261108-rc20-r1.zip)** 和 [SHA256 校验清单](https://github.com/zwsxzy/mcp-tunnel-account-manager/releases/download/v1.2.0-preview.3/SHA256SUMS.txt)。
2. 对照清单核验下载文件，解压到短、固定、当前用户可写的目录，如 `C:\MCP` 或 `D:\MCP`。不要放在过深目录或直接从 ZIP 内运行。
3. 进入解压后的完整工具包根目录，先校验、再启动：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Verify-Package.ps1
.\Start-Console.cmd
```

4. 浏览器默认打开 <http://127.0.0.1:17642>。按照本机初始化提示设置管理密码；不要公开初始化码。
5. 可选运行根目录的快捷方式安装器。配置服务、独立 Tunnel ID、凭据输入、升级隔离和停止方式请看 [完整中文部署说明](docs/releases/v1.2.0-preview.4/README-Release.zh-CN.md)。

> `new` 分支带来的两个修复只对**下次启动或切换**生效：已有窗口不会被强行隐藏或关闭，当前 MCP/DSH 不会因安装源码而重启。边界与重装步骤见 [合并版部署与验证边界](docs/NEW-BRANCH-DEPLOY.zh-CN.md)。

完整包包含控制台、共用 Node、tunnel-client、Cloudflared、Overleaf MCP 及 npm 生产依赖、Antigravity MCP 源码和可选 DSH 桥接代码；不包含个人账号、密钥或 IDE 登录数据。便携程序所带 Node v25.9.0 为非 LTS，未验证所有替代运行时。

### 一键启动桌面按钮（可选）

完整部署包的 `oneclick` 目录提供可选的桌面按钮：点击后只在需要时启动控制台并打开 <http://127.0.0.1:17642>，**不会启动或停止隧道**；不读取任何账号或密钥。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\oneclick\Install-Desktop-Shortcut.ps1
```

快捷方式由 `%LOCALAPPDATA%\McpTunnelAccountManager\launcher` 下的稳定副本启动，移动或删除仓库目录后仍可用。图标、日志、卸载与排查见 [oneclick/README.zh-CN.md](packaging/windows/templates/kit/oneclick/README.zh-CN.md)。

### 下载选择

| 附件 | 用途 |
| --- | --- |
| [完整部署包，约 68.9 MB](https://github.com/zwsxzy/mcp-tunnel-account-manager/releases/download/v1.2.0-preview.4/MCP-Windows-Deployment-Kit-20261109-rc21-r1.zip) | **推荐其他电脑部署**；整合 `main` 与 `new` 分支修复，不需要叠加解压另一个控制台包 |
| [控制台便携包，约 36.0 MB](https://github.com/zwsxzy/mcp-tunnel-account-manager/releases/download/v1.2.0-preview.4/MCP-Tunnel-Console-Windows-x64-20261109-rc21-r1.zip) | 控制台与 Node；适合已有服务和隧道程序的人 |
| [源码与打包工具，约 0.358 MB](https://github.com/zwsxzy/mcp-tunnel-account-manager/releases/download/v1.2.0-preview.4/MCP-Tunnel-Console-Source-20261109-rc21-r1.zip) | 固定 RC21 发行源码与构建工具；没有 Node 或服务运行依赖 |

GitHub 自动生成的 Source code ZIP 对应 tag 的仓库源码，包含这里的开发文件，但**不是完整部署包**。旧的 [deployment/windows](deployment/windows) 保留早期源码与指南；最新发行外壳以 [packaging/windows/templates](packaging/windows/templates) 为准，不要将旧目录覆盖到新包。

## 外部依赖：按所用服务准备

- **只运行控制台**：Windows x64、Windows PowerShell 5.1 和浏览器；部署包已带 Node。
- **Overleaf Git 读写/同步**：自行安装 Git for Windows 并加入 PATH；使用自己的项目和 Git token，且项目具备 Git integration 权限。只有本地 `compile_project` 还需要 latexmk 和 TeX。Git 和 TeX 未捆绑。
- **Antigravity MCP**：Python 3.9+、可正常使用且已登录的 Antigravity IDE；Python 和 IDE 未捆绑。
- **可选 DSH 桥接**：匹配的 DSH 宿主、插件依赖、登录和令牌；不能仅凭桥接版本号相同就假定兼容任意 DSH。
- **对外服务**：每台同时在线的电脑、每项服务使用自己的独立 Tunnel ID、Runtime API Key、授权与网络。

此包不是所有外部服务都能离线使用的系统镜像。Overleaf 上游也提示其 Windows Git/TeX 业务流程未纳入原验证矩阵。

## 数据与进程安全

控制台只监听本机 `127.0.0.1`。默认数据目录：

```text
%LOCALAPPDATA%\McpTunnelAccountManager
```

每台电脑独立初始化和配置，发布内容不包含维护者的账号库、密钥、Cookie、初始化码或浏览器/IDE profile。不要把使用后生成的数据、配置、日志再次上传。

新启动器拒绝外网 HOST、非法端口和其他进程占用的端口，不按端口批量杀进程。停止时核对执行文件、入口和创建时间。切换旧版前请退出旧实例并备份自己的数据；试用新版应选独立端口和独立数据目录，避免同时打开同一个账号库。

## 源码运行与测试

源码运行需要 Node.js **22.14.0+**，控制台没有第三方 npm 运行依赖。上方部署入口为后台模式；调试时可用以下前台模式，结束时按 Ctrl+C：

```powershell
git clone https://github.com/zwsxzy/mcp-tunnel-account-manager.git
cd mcp-tunnel-account-manager
npm.cmd start
```

仓库保留原有测试文件和测试命令；新增的有界发行测试使用临时目录、模拟凭据和随机本地端口，不需要真实隧道或账号：

```powershell
npm.cmd run check
npm.cmd run test:release
```

历史自定义源码 ZIP 的默认测试仅为这组发行测试，不能据此替代仓库完整回归。本轮 `main` 安全切换修复另行通过了 111 个文件语法检查及 **60/60 个完整回归测试文件**，并在原控制台上完成 Overleaf + Antigravity 的真实严格认证切换；范围与限制见 [修复验证记录](docs/SAFE-SWITCH-FIX.zh-CN.md#本轮已执行的验证2026-11-06)。

## 构建、版本和验证

- [离线构建说明](docs/BUILD-RELEASE.md)：固定允许的源码和模板输入、拒绝私密/运行数据、生成逐文件哈希；输出目录不能覆盖既有内容。
- [本次发布说明](docs/releases/v1.2.0-preview.4/RELEASE_NOTES.zh-CN.md)
- [隔离验证报告](docs/releases/v1.2.0-preview.4/VALIDATION.zh-CN.md)及[机器可读报告](docs/releases/v1.2.0-preview.4/validation-report.json)
- [上一版发布说明](docs/releases/v1.2.0-preview.3/RELEASE_NOTES.zh-CN.md)

发行包中的 35 个核心业务文件以合并后的源码重新计算哈希并记录在 `source-core-hashes.json`（构建标识 `20261109-rc21-r1`，取代 RC19/RC20 基线）。三个分发包各 4 项发行测试；Windows 启停、快捷方式和配置向导经过隔离检查；Overleaf/Antigravity 通过 MCP 初始化与工具发现，未执行业务工具或模型任务。

这些结果不是第二台实体机、真实公网隧道、Overleaf 读写/推送/编译、Antigravity 任务或 DSH 端到端验收，也不构成漏洞、真实性、数字签名或法律合规审计。

## 许可

项目自身许可证尚未指定，本次不代作者选择 MIT/Apache 或授予额外权利。第三方许可证、NOTICE、SPDX 及来源信息保留在相应发行包中；公开分发仍应由维护者确认授权。

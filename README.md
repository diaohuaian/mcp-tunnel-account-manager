# MCP Tunnel Account Manager

Windows 本地 MCP 隧道与账号管理控制台，通过浏览器管理多个账号、MCP 配置及安装位置。

**当前公开预览版：[v1.2.0-preview.2](https://github.com/zwsxzy/mcp-tunnel-account-manager/releases/tag/v1.2.0-preview.2)**，部署构建标识 `20261106-rc19-r1`。应用元数据仍为 `1.0.0`，不把部署构建号冒充业务版本号。

## main 分支安全切换修复

`main` 已补充 `VERIFY_FAILED` 的目标服务/脱敏原因诊断、本机 HTTP MCP 上游的无凭据 TCP 预检及回归测试；严格认证验证和原子回滚保持不变。Bridge 因宿主版本不匹配无法启动时，应先明确禁用其参与切换并保留配置，而不是强制激活或跳过健康校验。见 [问题原因、处理方案与验证边界](docs/SAFE-SWITCH-FIX.zh-CN.md)。

**以下预览发行附件仍是固定 RC19 快照，不含此 main 分支修复；没有替换旧标签、ZIP 或基线哈希。**

## Windows 新电脑快速部署

目标平台：Windows 10/11 x64。普通用户无需从源码安装依赖。

1. 从上述 Release 下载 **[完整部署包](https://github.com/zwsxzy/mcp-tunnel-account-manager/releases/download/v1.2.0-preview.2/MCP-Windows-Deployment-Kit-20261106-rc19-r1.zip)** 和 [SHA256 校验清单](https://github.com/zwsxzy/mcp-tunnel-account-manager/releases/download/v1.2.0-preview.2/SHA256SUMS.txt)。
2. 对照清单核验下载文件，解压到短、固定、当前用户可写的目录，如 `C:\MCP` 或 `D:\MCP`。不要放在过深目录或直接从 ZIP 内运行。
3. 进入解压后的完整工具包根目录，先校验、再启动：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Verify-Package.ps1
.\Start-Console.cmd
```

4. 浏览器默认打开 <http://127.0.0.1:17642>。按照本机初始化提示设置管理密码；不要公开初始化码。
5. 可选运行根目录的快捷方式安装器。配置服务、独立 Tunnel ID、凭据输入、升级隔离和停止方式请看 [完整中文部署说明](docs/releases/v1.2.0-preview.2/README-Release.zh-CN.md)。

完整包包含控制台、共用 Node、tunnel-client、Cloudflared、Overleaf MCP 及 npm 生产依赖、Antigravity MCP 源码和可选 DSH 桥接代码；不包含个人账号、密钥或 IDE 登录数据。便携程序所带 Node v25.9.0 为非 LTS，未验证所有替代运行时。

### 下载选择

| 附件 | 用途 |
| --- | --- |
| [完整部署包，约 68.8 MB](https://github.com/zwsxzy/mcp-tunnel-account-manager/releases/download/v1.2.0-preview.2/MCP-Windows-Deployment-Kit-20261106-rc19-r1.zip) | **推荐其他电脑部署**；不需要叠加解压另一个控制台包 |
| [控制台便携包，约 35.9 MB](https://github.com/zwsxzy/mcp-tunnel-account-manager/releases/download/v1.2.0-preview.2/MCP-Tunnel-Console-Windows-x64-20261106-rc19-r1.zip) | 控制台与 Node；适合已有服务和隧道程序的人 |
| [源码与打包工具，约 0.275 MB](https://github.com/zwsxzy/mcp-tunnel-account-manager/releases/download/v1.2.0-preview.2/MCP-Tunnel-Console-Source-20261106-rc19-r1.zip) | 固定 RC19 发行源码与构建工具；没有 Node 或服务运行依赖 |

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

源码运行需要 Node.js **22.14.0+**，控制台没有第三方 npm 运行依赖：

```powershell
git clone https://github.com/zwsxzy/mcp-tunnel-account-manager.git
cd mcp-tunnel-account-manager
npm start
```

仓库保留原有测试文件和测试命令；新增的有界发行测试使用临时目录、模拟凭据和随机本地端口，不需要真实隧道或账号：

```powershell
npm run check
npm run test:release
```

历史自定义源码 ZIP 的默认测试仅为这组发行测试，不能据此替代仓库完整回归。本轮 `main` 安全切换修复另行通过了 111 个文件语法检查及 **60/60 个完整回归测试文件**，并在原控制台上完成 Overleaf + Antigravity 的真实严格认证切换；范围与限制见 [修复验证记录](docs/SAFE-SWITCH-FIX.zh-CN.md#本轮已执行的验证2026-11-06)。

## 构建、版本和验证

- [离线构建说明](docs/BUILD-RELEASE.md)：固定允许的源码和模板输入、拒绝私密/运行数据、生成逐文件哈希；输出目录不能覆盖既有内容。
- [本次发布说明](docs/releases/v1.2.0-preview.2/RELEASE_NOTES.zh-CN.md)
- [隔离验证报告](docs/releases/v1.2.0-preview.2/VALIDATION.zh-CN.md)及[机器可读报告](docs/releases/v1.2.0-preview.2/validation-report.json)

发行包中的 35 个核心业务文件保持 RC19 快照字节不变。三个分发包各 4 项发行测试，共 12/12 通过；Windows 启停、快捷方式和配置向导经过隔离检查；Overleaf/Antigravity 通过 MCP 初始化与工具发现，未执行业务工具或模型任务。随附工具在同一主机离线重建三个 ZIP，均与发行文件逐字节一致。

这些结果不是第二台实体机、真实公网隧道、Overleaf 读写/推送/编译、Antigravity 任务或 DSH 端到端验收，也不构成漏洞、真实性、数字签名或法律合规审计。

## 许可

项目自身许可证尚未指定，本次不代作者选择 MIT/Apache 或授予额外权利。第三方许可证、NOTICE、SPDX 及来源信息保留在相应发行包中；公开分发仍应由维护者确认授权。

# MCP 隧道账号控制台：Release 上传与部署说明

发行构建标识：`20261108-rc20-r1`。目标平台：**Windows 10/11 x64**。

这是包含安全切换修复与脱敏自愈保护的 RC20 项目对应的发行文件，不是把整台电脑、账号资料或旧部署目录直接压缩。控制台应用元数据仍是 `1.0.0`；本次 GitHub 预览 tag 为 `v1.2.0-preview.3`，与构建标识 `20261108-rc20-r1` 相互独立。

## 1. 下载哪个包

| 文件 | 大小（十进制） | 用途 |
| --- | ---: | --- |
| [MCP-Windows-Deployment-Kit-20261108-rc20-r1.zip](https://github.com/zwsxzy/mcp-tunnel-account-manager/releases/download/v1.2.0-preview.3/MCP-Windows-Deployment-Kit-20261108-rc20-r1.zip) | 68.9 MB | **推荐给其他电脑部署**。包含控制台、共用 Node、tunnel-client、Cloudflared、Overleaf MCP 的现有 npm 生产依赖、Antigravity MCP 源码，以及可选 DSH 桥接代码。 |
| [MCP-Tunnel-Console-Windows-x64-20261108-rc20-r1.zip](https://github.com/zwsxzy/mcp-tunnel-account-manager/releases/download/v1.2.0-preview.3/MCP-Tunnel-Console-Windows-x64-20261108-rc20-r1.zip) | 36.0 MB | 仅控制台和 Node；不带隧道及 MCP 服务程序，适合已有服务环境的人。 |
| [MCP-Tunnel-Console-Source-20261108-rc20-r1.zip](https://github.com/zwsxzy/mcp-tunnel-account-manager/releases/download/v1.2.0-preview.3/MCP-Tunnel-Console-Source-20261108-rc20-r1.zip) | 0.358 MB | 控制台源码、部署脚本、打包工具和发行测试；不带 Node，也不是完整依赖部署包。 |

三个包是不同用途，**不需要叠加解压**，也不要把旧工具包的 console 目录覆盖到新包。

发行包中的核心业务源码共 35 个文件已经与基线一致性锁定。发布包内置了防脱敏污染和数据库历史配置自愈机制，杜绝 `VERIFY_FAILED / HEALTH_URL_REQUIRED` 伪错误。

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
   Get-FileHash -Algorithm SHA256 -LiteralPath .\MCP-Windows-Deployment-Kit-20261108-rc20-r1.zip
   ```

2. **解压到短、固定、当前用户可写的目录**，例如 `C:\MCP` 或 `D:\MCP`。ZIP 自带顶层目录；不要放进很深的“下载/项目/备份”多层目录，也不要在 ZIP 内直接运行。实测过深路径会触及 Windows 传统 260 字符限制；无需为此修改系统注册表或权限。
3. 进入解压后的完整工具包根目录，先验证，再启动：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\Verify-Package.ps1
   .\Start-Console.cmd
   ```

4. 浏览器默认打开 `http://127.0.0.1:17642`。首次初始化码只在本机生成，位于 `%LOCALAPPDATA%\McpTunnelAccountManager\bootstrap-code.txt`，用它设置自己的管理密码。不要公开这个码或本地数据目录。

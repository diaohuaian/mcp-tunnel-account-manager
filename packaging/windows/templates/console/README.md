# MCP 隧道账号控制台 · Windows x64 部署快照

发布构建标识：**{{RELEASE_ID}}**。应用自身版本仍为 `1.0.0`，未擅自更改上游版本或创建 GitHub tag。

这是桌面快捷方式所指向的源码快照（来源快照 `{{SOURCE_SNAPSHOT}}`），不是旧部署包中遗留的控制台。业务代码 [src](<src/>) 和前端 [public](<public/>) 按原文件复制；新增加便携入口、部署测试、构建和校验工具，调整启动脚本与部署文档。原项目目录、旧快捷方式和已有账号库不随打包修改。

来源核验以合并后的源码重新计算哈希并记录在 [source-core-hashes.json](<source-core-hashes.json>)；旧 RC19/RC20 基线已不再适用。来源、合并血缘与已验证特性记录在 [source-provenance.json](<source-provenance.json>)，发布内容重新生成完整校验清单。

## 选择下载包

- **MCP-Windows-Deployment-Kit-{{RELEASE_ID}}.zip（推荐）**：本控制台、Node.js、tunnel-client/Cloudflared、Overleaf 及其 npm 运行依赖、Antigravity 服务代码、可选 DSH 桥接代码、配置模板和启动器。
- **MCP-Tunnel-Console-Windows-x64-{{RELEASE_ID}}.zip**：仅控制台和 Node.js；如果 MCP 服务与隧道已部署，可用这个较小的包。
- **MCP-Tunnel-Console-Source-{{RELEASE_ID}}.zip**：业务源码与发布工具，不含 Node.exe、第三方二进制或服务的 node_modules；不是可直接离线使用的完整部署包。

这里的包名是本次输出的资产名，不代表已上传 GitHub。

## 运行控制台

1. Windows 10/11 **x64**。把 ZIP 完整解压到固定的、当前用户可写目录；不要直接在压缩包内双击运行，不建议放在 Program Files。
2. 首次运行前，双击 [Verify-Package.cmd](<Verify-Package.cmd>) 校验解压内容；同时对照 Release 单独提供的 SHA256SUMS.txt 核对 ZIP。
3. 双击 [Start-Console.cmd](<Start-Console.cmd>)。便携包自带 Node.js v25.9.0，无需安装 Node 或执行 npm install。Node v25 是非 LTS 版本，本轮未联网替换为其他版本；运行环境来源和哈希见 [build-info.json](<build-info.json>)。
4. 页面只在 `http://127.0.0.1:17642` 监听，不要对公网暴露。首次初始化所需的 bootstrap code 由新电脑现场生成，位于 `%LOCALAPPDATA%\McpTunnelAccountManager\bootstrap-code.txt`；按页面提示设置自己的密码。
5. 可选：双击 [Install-Desktop-Shortcut.cmd](<Install-Desktop-Shortcut.cmd>) 创建桌面快捷方式。同名旧快捷方式先备份到本机用户数据目录，随后才更新；这里只建立链接，不复制或移动程序文件，因此安装目录以后不能随意搬走。

### 端口冲突、停止与升级

新包**不会杀掉占用端口的旧控制台或其他程序**。如果 17642 已在使用，请先明确关闭旧版，或在解压目录用新端口试运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\open-portable-console.ps1 -Port 17643
```

可为试运行选择隔离数据目录，避免读写原账号库：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\open-portable-console.ps1 -Port 17643 -DataDirectory "$env:LOCALAPPDATA\McpTunnelAccountManager-Preview"
```

停止**由此发布目录的启动器启动**的后台控制台（端口和数据目录应与启动时相同）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-manager.ps1 -Stop
```

停止操作使用本地 PID 记录，并核对 Node 程序路径、入口命令行、进程创建时间；不会按端口批量结束进程，也不会停止隧道或 IDE。未通过所有权校验时会拒绝停止。升级建议先退出旧控制台、备份自己的数据目录，再解压到新的固定目录，确认可用后更新快捷方式；不要两份控制台同时访问同一个账号库。

## MCP 与外部依赖

控制台本身没有外部 npm 运行依赖。完整包会自动为控制台指定包内 tunnel-client 的路径；仅控制台包仍使用项目原来的每用户隧道位置，或需要你自行完成服务部署。

**仅启动网页不等于 MCP 已可用。** 需要在目标机配置 stdio/HTTP 绑定、独立 Tunnel ID、Runtime API Key，以及服务自身的登录。Python 3.9+、Antigravity IDE、DSH 主程序/插件依赖、浏览器和账号授权不在完整包内。完整包的根目录另有逐步部署说明。

新电脑不继承本机的账号、会话、浏览器 Cookie、API Key、配置和授权。每项服务/每台同时运行的电脑应使用独立 Tunnel ID，避免抢占隧道。

## 验证与源码运行

便携包使用内置 Node：

```powershell
.\runtime\node.exe scripts\check.mjs
.\runtime\node.exe --test tests\release-deployment.test.mjs
```

源码包需安装 Node.js **22.14.0 或更高版本**（必须支持 `node:sqlite`）：

```powershell
node scripts\check.mjs
node --test tests\release-deployment.test.mjs
node scripts\launch-manager.mjs
```

本快照的 [package.json](<package.json>) 中 `npm test` / `npm run test:release` 只执行新增的部署冒烟测试。原快照没有随附完整上游 tests 目录；不宣称完整业务回归通过。历史测试辅助脚本保留作源码参考，但不再作为已验证的 npm 测试入口。

部署测试使用随机临时用户目录、随机本地端口和运行时生成的假凭据，覆盖初始化、登录、CSRF、账号加密保存和重启；不使用真实隧道 Key，也不进行模型任务或真实账号切换。第二台实体机和真实外网业务验收仍须由目标机完成。最终打包验证结果见 Release 提供的验证报告。

## 重建发布包

源码包携带 [构建工具](<packaging/windows/build-release.mjs>)、[ZIP 工具](<packaging/windows/create-zip.ps1>) 与模板。详细命令见 [BUILD.md](<docs/BUILD.md>)。工具只复制允许的程序目录，拒绝链接/凭据文件，不执行 npm 安装脚本，不读取用户数据目录，也不会发布到 GitHub。

## 安全与许可证

包内不包含 `.env` 实值文件、账号数据库、master.key、auth.json、bootstrap code、真实 Tunnel ID 或 API Key；所有初始化数据由目标机新建。用户数据和日志一律留在本机用户目录，**不要把该目录或生成后的配置再次打进公开 Release**。

第三方原许可证与 NOTICE 保留，见 [THIRD-PARTY-NOTICES.md](<THIRD-PARTY-NOTICES.md>) 和 [Node 许可证](<runtime/LICENSE>)（源码包不含运行环境目录）。原项目未附项目自身的开源许可证，本次没有替作者擅自添加；公开发版前请仓库作者确认自己的授权条款。MIT/Apache 第三方许可证不自动覆盖此项目自身代码。

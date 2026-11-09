# MCP 隧道账号控制台 v1.2.0-preview.4

面向 Windows 10/11 x64 的公开预览版，部署构建标识为 `20261109-rc21-r1`。本版本基于 RC21 快照，完成了 **main 分支与 new 分支的完整合并**，同时具备**安全切换凭据脱敏自愈保护**与**验证检验并发提速、进程真实 PID 观测、Windows 后端子进程隐藏控制台继承修复**，并更新构建系统支持模板动态构建标识注入与最新源码哈希基线。应用元数据仍为 `1.0.0`；构建标识与 GitHub tag 相互独立。

本 tag 同步启动器、打包工具和模板，保留仓库原有测试；发行 ZIP 的默认测试仅为随附的部署测试，不冒充完整上游回归。

## 核心修复与改进

- **main 分支合并：防止脱敏 ID 污染真实凭据**：彻底解决了当从 UI 切换或保存配置时，脱敏掩码（如 `tun_***4a5`）被当成真实隧道 ID 写回数据库，导致后续切换因无法连接目标隧道出现 `VERIFY_FAILED / HEALTH_URL_REQUIRED` 并触发原子回滚的问题。前后端双层自愈与防护，适配器层前置脱敏 ID 校验。
- **new 分支合并：目标验证并发提速与并行探测**：
  - 核心切换逻辑采用最大并发度为 3 的有界并发校验池（`Math.min(3, targets.length)`），大幅缩短多服务切换延迟；保持准备、应用与回滚的严格原子顺序；
  - 适配器层对 `/health?details=true` 与 `/api/status` 执行并行获取，消除冗余等待。
- **new 分支合并：真实 PID 观测与徽章展示**：
  - 前端控制台严谨过滤已失效、未确认或已过期的 PID，仅对处于活跃运行中的受管/未接管进程展示真实 PID；
  - 避免将保存的历史 PID 或未知状态伪装为活跃运行徽章。
- **new 分支合并：Windows 后端子进程隐藏控制台继承修复**：
  - P/Invoke 调用底层 `CreateProcess`，利用 `CREATE_NEW_CONSOLE` 与 `SW_HIDE` 为被管理隧道分配真实但初始隐藏的控制台窗口；
  - 彻底解决后代 stdio 子进程继承无控制台环境时自动弹出 Windows Terminal / conhost 窗口的问题。
- **构建系统与测试回归**：
  - 修复前端编辑态下"整条服务无变更即整体省略"与测试断言不一致导致的 `ui-registry` 2.8 单元测试失败；
  - 重新计算并锁定 35 个核心业务文件的 `source-core-hashes.json`，更新 `source-provenance.json` 记录合并血缘；
  - 打包工具增加模板标识占位符替换，彻底杜绝已分发包模板中残留历史 RC19 构建号；
  - 发布制品零隐私泄漏保证，不含私密凭据、个人目录或未授权数据。

## 下载选择

- **[完整部署包（推荐，约 68.9 MB）](https://github.com/zwsxzy/mcp-tunnel-account-manager/releases/download/v1.2.0-preview.4/MCP-Windows-Deployment-Kit-20261109-rc21-r1.zip)**：控制台、Node、tunnel-client、Cloudflared、Overleaf MCP 及 npm 生产依赖、Antigravity MCP，以及可选 DSH 桥接代码。
- [控制台 Windows x64 便携包（约 36.0 MB）](https://github.com/zwsxzy/mcp-tunnel-account-manager/releases/download/v1.2.0-preview.4/MCP-Tunnel-Console-Windows-x64-20261109-rc21-r1.zip)：仅控制台与 Node，适合已有隧道和 MCP 服务环境的人。
- [源码与打包工具（约 0.358 MB）](https://github.com/zwsxzy/mcp-tunnel-account-manager/releases/download/v1.2.0-preview.4/MCP-Tunnel-Console-Source-20261109-rc21-r1.zip)：不含 Node 或完整服务依赖。

请同时下载 [SHA256 校验清单](https://github.com/zwsxzy/mcp-tunnel-account-manager/releases/download/v1.2.0-preview.4/SHA256SUMS.txt)、[中文部署说明](https://github.com/zwsxzy/mcp-tunnel-account-manager/blob/v1.2.0-preview.4/docs/releases/v1.2.0-preview.4/README-Release.zh-CN.md)与[验证报告](https://github.com/zwsxzy/mcp-tunnel-account-manager/blob/v1.2.0-preview.4/docs/releases/v1.2.0-preview.4/VALIDATION.zh-CN.md)。普通用户不要把 GitHub 自动生成的 Source code ZIP 当作完整部署包。

## 部署与隐私

- 建议解压到 **C:\MCP 或 D:\MCP 等短、可写目录**，避免 Windows 传统 260 字符路径限制；不要在 ZIP 内直接启动。
- 首次先校验包，再运行根目录 Start-Console.cmd；管理界面只绑定 127.0.0.1，默认端口 17642。
- 首次初始化码、管理密码、数据库与密钥均在目标电脑本地生成；发行文件不携带作者账号、真实 API Key、数据库、Cookie、浏览器或 IDE 登录目录。
- 端口冲突时拒绝启动，不按端口批量杀进程；停止时核对程序路径、命令行与创建时间。升级前请退出旧版并备份自己的数据，避免两份程序同时访问同一账号库。
- 安装向导只生成本机服务绑定与无密钥配置，不会自动启动隧道或安装 DSH。每台同时在线的电脑、每项服务应使用自己的独立 Tunnel ID。
- **注意**：Windows 控制台隐藏修复只对**下次启动或切换**生效，不会强行关闭当前正在运行的窗口或重启现有服务。

## 已带组件及外部要求

- 已带 Node v25.9.0 Windows x64（非 LTS）、tunnel-client 0.0.19、Cloudflared 2026.10.2、Overleaf MCP 0.3.9 及 npm 生产依赖、Antigravity MCP 1.1.0，以及可选 DSH 桥接 0.6.0 本地兼容代码。
- **Overleaf 仍需自行安装 Git for Windows 并加入 PATH**，配置自己的项目和 Git token，且项目具备 Git integration 权限；只有本地 compile_project 另需 latexmk 与 TeX 发行版。Git、TeX 未捆绑。
- Antigravity 仍需 Python 3.9+ 和可用、已登录的 Antigravity IDE；Python 和 IDE 未捆绑。
- 可选 DSH 桥接仍需相容 DSH 主程序及插件依赖、账号与令牌，不保证任意 DSH 版本兼容。
- 对外隧道和外部业务需要目标用户自己的授权、Runtime API Key 与网络；这不是所有外部服务都能离线使用的一键镜像。

## 验证范围

已核验 ZIP 完整性、逐文件哈希、敏感数据模式与当前核心源码一致性；随包发行测试共 12/12 通过。源码和打包工具在本机离线重建出的三个 ZIP 与发行文件逐字节一致。Overleaf、Antigravity 的 stdio initialize 和 tools/list 已通过，未执行任何业务工具或模型任务。

Windows 启动、停止、快捷方式、配置向导等实际检查及完整范围，以随附验证报告为准。未验证第二台实体机、真实 Overleaf 读写/推送/编译、Antigravity 任务、DSH 外网桥接或公网隧道全链路；未做远端组件真实性、漏洞或法律合规审计。Overleaf 上游也提示其 Windows Git/TeX 业务流程未纳入原测试矩阵。

原控制台快照未附项目自身许可证，公开发布前须由维护者确认授权；第三方原有许可证、NOTICE、SPDX 和版本来源信息已保留。

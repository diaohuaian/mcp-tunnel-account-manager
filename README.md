<div align="center">

# MCP Tunnel Account Manager

### 多个账号、多种 MCP，一个 Windows 本地控制台。

在浏览器里管理账号配置、切换服务、并行启动隧道。  
把 Overleaf 写作与 Antigravity Agent 接入同一套管理入口，让日常使用少一点重复配置。

[![GitHub Stars](https://img.shields.io/github/stars/zwsxzy/mcp-tunnel-account-manager?style=flat-square)](https://github.com/zwsxzy/mcp-tunnel-account-manager/stargazers)
![Windows 10 / 11](https://img.shields.io/badge/Windows-10%20%2F%2011-0078D6?style=flat-square)
![Node.js 22.14+](https://img.shields.io/badge/Node.js-22.14%2B-339933?style=flat-square)
![Python 3.9+](https://img.shields.io/badge/Python-3.9%2B-3776AB?style=flat-square)

**[下载 final 源码](https://github.com/zwsxzy/mcp-tunnel-account-manager/archive/refs/heads/final.zip) · [快速开始](#quick-start) · [配置指南](#configuration) · [反馈问题](https://github.com/zwsxzy/mcp-tunnel-account-manager/issues)**

</div>

> 如果这个项目帮你省去了反复配置和切换的麻烦，欢迎点亮右上角 **⭐ Star**，让更多有同样需求的人发现它。

## 为什么做这个项目

用上多个 MCP 之后，麻烦往往来自日常管理：这个服务用哪个账号、那个隧道读哪份配置、换一套环境又要改哪些路径。

MCP Tunnel Account Manager 把这些操作集中到一个本地网页里。**保存好配置，选择要运行的服务与账号，再执行切换或并行启动。**

| 你想做的事 | 项目提供的能力 |
| --- | --- |
| 在多套账号配置之间切换 | 保存命名配置，按服务填写凭据，在页面中选择并切换 |
| 同时运行不同账号或多个 MCP | 多选服务与配置，使用并行启动；各运行实例使用独立的 Tunnel ID |
| 接入 Overleaf 和 Antigravity | 内置两个服务定义，提供固定版本的组件安装脚本 |
| 少手工编辑配置文件 | 在网页中管理程序路径、参数、环境变量，查看运行状态和错误信息 |
| 把配置留在自己的电脑上 | 控制台默认只监听本机地址，账号凭据加密保存在本机数据目录 |

**适合你，如果你正在：**

- 在 Windows 上使用 Overleaf MCP、Antigravity MCP，想集中管理它们的隧道。
- 为不同用途维护多套账号配置，希望切换和并行运行更方便。
- 第一次接触 MCP，希望从安装脚本和可视化页面开始上手。

**当前使用入口是 `final` 分支。** 本文对应这套源码；旧的 `v1.2.0-preview.*` 发行包与迁移工具说明放在[历史版本](#history)，请按本文的当前安装流程使用。

## 导航

[快速开始](#quick-start) · [第一次配置](#configuration) · [三个组件](#components) · [安装路径](#paths) · [进阶设置](#advanced) · [常见问题](#faq) · [验证记录](#validation) · [参与项目](#contributing)

<a id="quick-start"></a>

## 快速开始

### 1. 准备运行环境

| 环境 | 要求 |
| --- | --- |
| 系统 | Windows 10 / 11 x64，系统自带的 Windows PowerShell 5.1 |
| Node.js | **22.14.0 或更高版本** |
| Python | **3.9 或更高版本**，推荐 3.12；安装时勾选加入 PATH |
| 网络 | 首次安装需要访问 GitHub 与 npm registry |

按需要准备：Overleaf 的 Git 读写 / 同步需要 **Git for Windows**，本地编译需要 **TeX / latexmk**；Antigravity 的原生 Agent 功能需要 **已安装、已登录并正在运行的 Antigravity IDE**。

一键安装脚本负责安装下面三个组件；Node.js、Python 和 IDE 等基础环境需要先准备好。控制台自身没有第三方 npm 运行依赖，启动前无需执行 `npm install`。

### 2. 下载项目，安装组件

**[点击下载 final 分支 ZIP](https://github.com/zwsxzy/mcp-tunnel-account-manager/archive/refs/heads/final.zip)**，解压后进入包含 `Install-Components.cmd` 的项目根目录。

也可以用 Git 获取：

```powershell
git clone --branch final --single-branch https://github.com/zwsxzy/mcp-tunnel-account-manager.git
cd mcp-tunnel-account-manager
```

双击 **`Install-Components.cmd`**，安装 `tunnel-client`、`overleaf-mcp` 和 `antigravity-mcp`。安装到当前用户目录，无需管理员权限。

### 3. 打开控制台

双击 **`Start-Console.cmd`**，浏览器会打开：

**<http://127.0.0.1:17643>**

首次进入时，按提示输入引导码并设置管理员密码。引导码文件位于：

```text
<项目根目录>\data\bootstrap-code.txt
```

初始化完成后，用管理员密码登录，继续下面的[第一次配置](#configuration)。引导码和个人凭据请只保留在自己的电脑上。

要关闭控制台，双击 **`Stop-Console.cmd`**。它只停掉本目录自己启动的那个控制台进程（按 pid 记录里的可执行文件路径与创建时间核对），不会按端口强杀，也不会动隧道、IDE 或无关监听。

<details>
<summary>习惯用终端？等价命令在这里</summary>

在项目根目录打开 PowerShell：

```powershell
# 安装三个组件
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-components.ps1

# 后台启动控制台并打开浏览器
.\Start-Console.cmd

# 或以前台模式启动，方便查看输出；Ctrl+C 结束
.\start-manager.cmd

# 关闭本目录启动的控制台（只停自己记录的进程）
.\Stop-Console.cmd
```

</details>

<a id="configuration"></a>

## 第一次配置：在网页里完成

### 先分清两个页面

| 页面 | 管理什么 |
| --- | --- |
| **账号配置** | 账号名称，以及每个 MCP 服务对应的 Tunnel ID、Runtime API Key、Organization ID |
| **MCP 服务** | 本机服务的可执行文件、启动参数、工作目录、环境变量与运行状态 |

控制台已内置并启用 **`overleaf-mcp`** 与 **`antigravity-mcp`**。使用默认安装位置时，可以直接配置账号凭据，无需重新添加这两个服务。

使用 Overleaf 项目功能前，还需要完成下方的[项目配置向导](#overleaf-setup)；使用 Antigravity 原生 Agent 功能时，请保持 IDE 已登录并运行。

### 添加自己的账号配置

1. 打开 **「账号配置」**，点击 **「添加新配置」**。
2. 填写便于识别的名称，例如 `论文工作区` 或 `日常开发`。
3. 为要使用的 MCP 服务填写以下字段，然后点击 **「保存配置」**。

| 字段 | 填写内容 |
| --- | --- |
| **Tunnel ID** | 在 [OpenAI Tunnels 页面](https://platform.openai.com/settings/organization/tunnels)创建或查看该服务的隧道 ID |
| **API Key** | 在 [OpenAI API Keys 页面](https://platform.openai.com/settings/organization/api-keys)创建对应的 **Runtime API Key** |
| **Organization ID** | 可选，按自己的账号情况填写 |

需要具备相应的 Tunnels 权限；角色与权限要求可查阅 [tunnel-client 官方说明](https://github.com/openai/tunnel-client/blob/v0.0.19/docs/permissions.md)。

**同时在线的不同电脑、服务或并行实例，应使用各自独立的 Tunnel ID。** 安装器会生成配置模板，真实凭据由你在控制台填写。

编辑已有配置时，API Key 留空表示保留原值。页面上的脱敏值用于展示，请勿把 `tun_***4a5` 这类脱敏文本填回输入框。

### 启动、切换与并行运行

启动隧道前请确认代理设置：未设置代理环境变量时，当前默认使用 `http://127.0.0.1:7897`，详见[进阶设置](#advanced)。

1. 在 **「账号配置」** 页选择 **「1. 选择目标生效服务」**。
2. 选择 **「2. 选择待激活配置文件」**。
3. 点击 **「3. 执行原子切换」**；需要同时运行多套配置时，使用 **「并行启动」**。
4. 查看页面显示的状态与错误信息；需要停止时使用 **「停止全部 Tunnel Client」**。

切换流程包含失败回滚处理。若操作失败，请根据页面错误信息排查后再重试。

<a id="components"></a>

## 三个组件，各自负责什么

| 组件 | 职责 | 本项目固定安装版本 |
| --- | --- | --- |
| [tunnel-client](https://github.com/openai/tunnel-client) | 将本机 MCP 服务连接到 OpenAI 隧道 | `v0.0.19`，固定兼容版本 |
| [Overleaf MCP](https://github.com/yangzichao/mcp-server-overleaf) | 提供 Overleaf 项目相关 MCP 工具 | `mcp-server-overleaf@0.3.9` |
| [Antigravity MCP fork](https://github.com/zwsxzy/antigravity-mcp-fork) | 将 Antigravity IDE 的本地 Agent 能力提供为 MCP 工具 | `1.1.0.post1`，固定提交 [`02df3ed`](https://github.com/zwsxzy/antigravity-mcp-fork/commit/02df3ed95aae0c5103f5db7b332d0c4e6f1eec50) |

### tunnel-client：连接本机服务与隧道

安装器会在 `%APPDATA%\tunnel-client\` 生成两个服务的 YAML 模板，`tunnel_id` 初始留空，执行切换时由控制台写入真实值。

已有配置的程序路径失效时，安装器会修复到当前安装位置；若原命令仍有效但与本次安装不同，会保留原配置并生成 `*.yaml.suggested` 供你对照。

<a id="overleaf-setup"></a>

### Overleaf MCP：先配置自己的项目

在 PowerShell 中运行上游提供的项目配置向导：

```powershell
npx --yes mcp-server-overleaf@0.3.9 setup --clients none
```

`--clients none` 仅准备 Overleaf 项目配置，不向其他 MCP 客户端写入配置。Windows 默认写入 `%APPDATA%\overleaf-mcp\projects.json`；设置了 `XDG_CONFIG_HOME` 时，以该配置根目录为准。

- **Runtime API Key** 用于隧道连接，填写在本项目的「账号配置」中。
- **Overleaf 个人 Git token** 用于项目 Git 读写与同步，按 Overleaf 向导配置。
- Git 同步需要 Git for Windows；本地编译需要 TeX / latexmk。

运行服务时可以通过 `OVERLEAF_PROJECTS_CONFIG` 指定项目清单，通过 `OVERLEAF_MCP_WORKSPACE_DIR` 指定项目工作区。前者影响服务读取配置的位置，**不会让 setup 向导自动改写到该位置**。

### Antigravity MCP：连接正在运行的 IDE

请先安装、登录并启动 **Antigravity IDE**。原生多 Agent 协作依赖 IDE 的本地语言服务器；Gemini REST API fallback 不提供原生多 Agent 协作。

安装器使用独立 Python venv，通过 `.pth` 引用固定提交的源码；该包运行依赖为 Python 标准库，无需 pip 构建。YAML 中的启动形式为：

```text
"<venv>\Scripts\python.exe" -X utf8 -u -m antigravity_mcp
```

`-X utf8 -u` 用于 UTF-8 编码和无缓冲输出。该 MCP 使用 **stdio** 传输，由 tunnel-client 桥接。

如果希望使用独立的任务状态目录：

1. 打开 **「MCP 服务」**，编辑 `antigravity-mcp`。
2. 在 **「环境变量列表」** 中添加 `ANTIGRAVITY_STATE_DIR`。
3. 填写真实的**绝对路径**，例如 `C:\Users\你的用户名\.antigravity-mcp\state`。
4. 保存后重新执行切换，让新配置生效。

这里的路径需要替换为自己的实际路径，环境变量值不会自动展开 `%USERPROFILE%`。安装器不会自动更改状态目录；默认仍为 `%LOCALAPPDATA%\antigravity-mcp`。

<details>
<summary>Antigravity 进阶注意事项</summary>

- 安装源码固定为 `02df3ed95aae0c5103f5db7b332d0c4e6f1eec50`，方便复现与排查。
- 包内 `workflow_settings.json` 有上游约定，尤其不要随意修改 `default_model`。
- 不要用 `--version` 探测 MCP 是否可用；该入口可能等待标准输入，应使用 MCP 握手检查。
- 本项目安装的是 MCP 服务，Antigravity IDE 仍需独立安装与登录。

</details>

<a id="paths"></a>

## 安装路径与数据位置

`%USERPROFILE%` 通常类似 `C:\Users\你的用户名`；`%APPDATA%` 和 `%LOCALAPPDATA%` 分别指当前用户的漫游与本地应用数据目录。

| 内容 | 默认位置 |
| --- | --- |
| 控制台源码 | 解压后的项目目录 |
| tunnel-client | `%USERPROFILE%\.openai-tunnel\tunnel-client.exe` |
| cloudflared 伴随程序 | `%USERPROFILE%\.openai-tunnel\cloudflared.exe` |
| Overleaf MCP 入口 | `%USERPROFILE%\.overleaf-mcp\runtime\node_modules\mcp-server-overleaf\dist\index.js` |
| Overleaf 项目工作区 | `%USERPROFILE%\.overleaf-mcp\projects` |
| Antigravity Python | `%USERPROFILE%\.antigravity-mcp\venv\Scripts\python.exe` |
| Antigravity MCP 源码 | `%USERPROFILE%\.antigravity-mcp\app` |
| Antigravity 任务状态 | `%LOCALAPPDATA%\antigravity-mcp`，可在服务环境变量中另行指定 |
| Overleaf 隧道配置 | `%APPDATA%\tunnel-client\overleaf.yaml` |
| Antigravity 隧道配置 | `%APPDATA%\tunnel-client\antigravity-local.yaml` |
| 安装状态与下载缓存 | `%USERPROFILE%\.mcp-tunnel-kit\`，包含 `install-state.json`、`cache` 等 |
| 控制台账号库、密钥与日志 | `%LOCALAPPDATA%\McpTunnelAccountManager` |
| 首次初始化引导码 | `%LOCALAPPDATA%\McpTunnelAccountManager\bootstrap-code.txt` |

默认路径与控制台内置配置相匹配。个人凭据、初始化码、真实运行配置和数据目录请留在本机，不要提交到仓库。

<a id="advanced"></a>

## 进阶设置

<details>
<summary><strong>单独安装、检查与重新安装</strong></summary>

在项目根目录的 PowerShell 中执行：

```powershell
# 单独安装指定组件
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-tunnel-client.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-overleaf-mcp.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-antigravity-mcp.ps1

# 只检查已安装版本、入口与配置，不下载、不安装
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-components.ps1 -VerifyOnly

# 需要重新安装时，显式使用 -Force
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-components.ps1 -Force
```

安装器校验 tunnel-client 的 SHA256、Overleaf 的 npm integrity，以及 Antigravity 源码归档的 SHA256，并记录版本与提交。重复运行会跳过已经完成的同版本组件。

重新安装只覆盖组件发行文件，保留 `.openai-tunnel` 中已有的 `tunnel.env`、个人启动脚本及其他用户文件。安装失败会返回非零退出码，可根据 `[FAIL]` 输出修复后重试。

安装器不提供自动卸载。手动删除组件目录前，请备份隧道 YAML、控制台数据目录以及需要保留的项目与任务记录。

</details>

<details>
<summary><strong>端口、代理与 MCP 环境变量</strong></summary>

控制台变量可在启动前通过 PowerShell 设置，例如 `$env:PORT = "17643"`；长期使用可设置为 Windows 用户环境变量，然后重开终端。

MCP 服务自己的变量，请在 **「MCP 服务 → 编辑 → 环境变量列表」** 中填写，以便控制台明确传给子进程。路径类值使用完整绝对路径。

| 变量 | 用途 |
| --- | --- |
| `PORT` | 控制台端口，默认 `17643` |
| `HOST` | 只允许 `127.0.0.1`，其他值会拒绝启动 |
| `DATA_DIR` | 覆盖控制台数据目录 |
| `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` | 隧道子进程的代理设置；均未设置时，当前启动策略默认使用 `http://127.0.0.1:7897` |
| `OVERLEAF_PROJECTS_CONFIG` | Overleaf 服务读取的 `projects.json`，不改变 setup 向导的默认写入位置 |
| `OVERLEAF_MCP_WORKSPACE_DIR` | Overleaf 项目工作区 |
| `ANTIGRAVITY_STATE_DIR` | Antigravity 任务状态目录 |

`CONTROL_PLANE_*` 和 `TUNNEL_CLIENT_*` 前缀不能用于 MCP 服务的环境变量列表。Tunnel 凭据请在「账号配置」中填写。

</details>

<details>
<summary><strong>添加自己的 MCP 服务</strong></summary>

在 **「MCP 服务」** 页点击 **「添加 MCP 服务」**，根据服务类型填写：

| 字段 | 用法 |
| --- | --- |
| 服务名称 / 标签 | 用于识别服务 |
| 服务类型 | 本地进程选择 stdio；远程地址按服务选择 HTTP/SSE |
| 可执行文件 | 程序的完整路径或系统命令，例如 `C:\Program Files\nodejs\node.exe` |
| Arguments | 逐项添加启动参数 |
| cwd | 可选，指定工作目录 |
| HTTP URL / Headers | HTTP/SSE 服务使用 |
| 环境变量列表 | 该 MCP 进程需要的变量 |

也可以使用 **「发现本机配置」**，查看并导入已有配置的预览。

</details>

<a id="faq"></a>

## 常见问题

| 问题 | 处理方式 |
| --- | --- |
| Node.js 版本过低 / 找不到 Python | 按[运行环境](#quick-start)安装或升级，重开终端后重新运行安装脚本 |
| 安装中途失败，是否需要从头清理？ | 先看 `[FAIL]` 行，修复问题后重跑；已完成的同版本组件会自动跳过 |
| 隧道提示 MCP 命令不可用 | 重跑对应组件安装脚本；检查修复后的 YAML 或生成的 `*.yaml.suggested` |
| 控制台端口被占用 | 用 `PORT` 更换端口，或正常停止已确认的旧实例 |
| 页面提示「恢复闸门已触发 (NEEDS_ATTENTION)」 | 先核对报错里的失败码与服务状态，再执行 `node scripts/dev-reset-recovery-gate.mjs --apply`（默认 `<仓库>/data`；生产数据目录会被拒绝） |
| 隧道连接失败，是否与代理有关？ | 核对代理是否可用；未配置三个代理变量时，当前默认地址是 `http://127.0.0.1:7897` |
| 中文用户名或路径包含空格 | 安装器处理了 Windows 参数引号，Antigravity `.pth` 使用 ASCII 相对路径；仍失败时请提交脱敏后的完整错误 |
| 已安装 Antigravity MCP，却无法使用原生 Agent 协作 | 确认 Antigravity IDE 已安装、已登录并正在运行；REST fallback 不提供该能力 |
| 忘记管理员密码 | 先完整备份控制台数据与密钥；删除数据目录重新初始化会清空原账号库，需要重新配置 |
| 怎样备份或迁移？ | 备份上表中的控制台数据、隧道 YAML 和需要保留的业务目录；新电脑独立初始化，并为同时在线的实例分配不同的 Tunnel ID |

控制台只接受本机回环地址。停止隧道请使用页面操作；排查进程时应核对具体实例身份，避免按进程名或端口批量终止其他程序。

<a id="validation"></a>

## 已做过哪些验证

以下为 **2026-11-13 发布基线 [`f129c32`](https://github.com/zwsxzy/mcp-tunnel-account-manager/commit/f129c32e0a46e7c81de744977cd8ebb0e7fca76a)** 的实际验证记录，后续修改 README 不改变这份记录的对应版本。

| 验证范围 | 结果 |
| --- | --- |
| 完整默认 unit | **62 / 62 个测试文件通过**，退出码 0，约 201 秒 |
| 安装脚本验证 | **48 / 48 项通过** |
| Antigravity MCP 握手 | 成功，返回 **8 个工具** |
| Overleaf MCP 握手 | 成功，返回 **18 个工具** |
| 控制台启动 | 使用隔离数据目录和随机本地端口，首页返回 **HTTP 200** 与 HTML |
| 发布文件 | 测试快照与待发布副本的 **356 个文件**一致，关键文件经 GitHub 回读核验 |

完整 unit 保留原有测试集合与超时限制。握手和页面启动验证的范围不包含真实 Overleaf 项目同步 / 编译，或 Antigravity IDE 的实际业务任务。

### 本地开发与验证

在项目根目录执行：

```powershell
npm.cmd start          # 前台启动控制台
npm.cmd run test:unit  # 默认单元测试
npm.cmd run test:all   # 含集成测试
npm.cmd run check      # 静态检查
```

若某个数据目录遗留了 `NEEDS_ATTENTION` 恢复闸门（例如历史上的 `EXECUTABLE_NOT_FOUND`），页面上的「确认恢复」只接受零副作用错误码，需要显式工具解除：

```powershell
node scripts/dev-reset-recovery-gate.mjs           # 只看现状：默认目标 <仓库>/data，不写盘
node scripts/dev-reset-recovery-gate.mjs --apply   # 先备份再清闸门
```

该工具只操作一个数据目录，拒绝生产目录 `%LOCALAPPDATA%\McpTunnelAccountManager`，在控制台仍占用该目录时也会拒绝执行（`--force` 可显式越过）。

相关文档：[构建说明](docs/BUILD-RELEASE.md) · [切换修复记录](docs/SAFE-SWITCH-FIX.zh-CN.md) · [部署与验证边界](docs/NEW-BRANCH-DEPLOY.zh-CN.md)。

<a id="contributing"></a>

## 让这个项目变得更好

如果它帮你少做了一次重复配置，欢迎点亮 **⭐ Star**。

- **遇到问题：** [提交 Issue](https://github.com/zwsxzy/mcp-tunnel-account-manager/issues)，附上 Windows / Node.js / Python 版本、复现步骤和脱敏日志。
- **有使用建议：** 分享你正在使用的 MCP 组合，以及希望简化的操作。
- **愿意贡献：** 欢迎通过 Pull Request 改善文档、修复问题或补充可复现的测试。

请在提交截图、日志或配置前移除 API Key、初始化码、Cookie 和其他个人凭据。

<a id="history"></a>

## 历史版本与第三方说明

<details>
<summary>查阅旧发行包与迁移工具</summary>

`v1.2.0-preview.2` 至 `v1.2.0-preview.5` 的 ZIP 发行包、`deployment/windows/` 迁移工具源码及 `packaging/windows/templates/` 外壳模板属于历史发布物。

旧包包含当时的运行依赖与组件版本，请勿覆盖到当前源码目录。当前 `final` 分支以本文的安装方式及 Node.js **22.14.0+** 要求为准。

- [v1.2.0-preview.5 发布说明](docs/releases/v1.2.0-preview.5/RELEASE_NOTES.zh-CN.md)
- [v1.2.0-preview.5 中文部署说明](docs/releases/v1.2.0-preview.5/README-Release.zh-CN.md)
- [v1.2.0-preview.5 隔离验证报告](docs/releases/v1.2.0-preview.5/VALIDATION.zh-CN.md)

</details>

感谢 [openai/tunnel-client](https://github.com/openai/tunnel-client)、[yangzichao/mcp-server-overleaf](https://github.com/yangzichao/mcp-server-overleaf) 与 [zwsxzy/antigravity-mcp-fork](https://github.com/zwsxzy/antigravity-mcp-fork) 提供组件能力。

项目当前尚未指定整体许可证。第三方组件各自的许可证、NOTICE、SPDX 与来源信息保留在相应源码、发行包或安装目录中。


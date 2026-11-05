# MCP Windows 部署与迁移工具包

本包提供三项 MCP 的程序代码、配置模板、启动器、OpenAI tunnel-client 和独立管理控制台压缩包。Python、Antigravity IDE、DSH 主程序，以及新电脑上的登录和账号配置需要另行准备。

| 服务 | 传输方式 | 启动条件 |
| --- | --- | --- |
| Overleaf | stdio | 包内 Node 或 Node 18+；包含服务依赖；重新设置新机的浏览器、登录和项目授权 |
| Antigravity | stdio | Python 3.9+；已安装并打开 Antigravity IDE；按 Python 模块启动 |
| DSH 桥接 | HTTP：127.0.0.1:3456/mcp | Node 22+、匹配版本的 DSH，并在同一 Web profile 内加载桥接插件；DSH 和插件依赖不在本包中 |

## 在新 Windows 上操作

1. 解压到固定目录，例如 `C:\MCP-Deployment`。PowerShell 5.1 脚本使用 UTF-8 BOM；从 PowerShell 运行下面的命令。
2. 为各服务准备不同的 OpenAI Tunnel ID。两台电脑同时运行时，各自使用独立 ID，避免多个 stdio 客户端争用同一隧道。
3. 安装 Python 3.9+，打开新机 Antigravity IDE；Overleaf 的登录和项目授权也在新机重新设置。
4. 在解压目录运行配置向导：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-And-Setup.ps1
```

暂时只使用 Overleaf 和 Antigravity，可选择这两项：

```powershell
.\Install-And-Setup.ps1 -Services overleaf,antigravity
```

生成的配置位于 `generated-profiles\`，只包含新 Tunnel ID 和环境变量引用。已有配置默认保留；需要覆盖时明确加 `-Force`。空 ID、重复 ID、缺少运行环境或残留模板字段会返回失败，不应当成配置成功。

5. 分别启动需要的隧道，每项保持一个终端窗口：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\launchers\Start-Overleaf-Tunnel.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\launchers\Start-Antigravity-Tunnel.ps1
```

启动器会通过隐藏输入询问对应 Tunnel 的 Runtime API Key，只用于本次子进程，不写入配置或 Git。Antigravity 使用 `python -m antigravity_mcp` 并切换至包目录；不直接运行 `__main__.py` 文件。

6. 在 ChatGPT 中分别连接对应隧道并刷新工具。实际外网连接、账号授权和第二台实体机运行结果需在目标机确认。

## DSH 桥接的额外准备

本包的桥接代码保留版本号 `0.6.0`，其 `package.json` 的 DSH peer dependencies 指向 `0.2.0-rc.2`。上游 README 也说明，同名已发布的 `0.6.0` 曾面向较旧 DSH；不要用版本号相同就假定两份代码兼容。

本包携带编译后代码、`package.json` 及插件所需的 `cordis.patch.yml`。在目标机使用与这些 peer dependencies 匹配的 DSH，按其插件安装流程将 `servers\deepseek-mcp` 作为本地插件加入 **web profile**，安装声明的依赖并启动 DSH Web。仅 `node lib/index.js` 或单独 `npm install` 不会完成 DSH 插件挂载。

上游文档给出的本地插件方式如下，命令需要在目标机安装、联网，并且尚未在第二台实体机验收：

```powershell
$bridgeFolder = (Resolve-Path .\servers\deepseek-mcp).Path
npx --yes @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add ("file:" + $bridgeFolder)
npx --yes @deepseek-ai/dsh@0.2.0-rc.2 web
```

确认桥接已在 `127.0.0.1:3456/mcp` 监听，再运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\launchers\Start-DeepSeek-Bridge-Tunnel.ps1
```

启动器询问的是 **新电脑活动 DSH profile 的桥接令牌**，还会另外询问 OpenAI Tunnel Runtime API Key，两者不同。桥接令牌通过隐藏输入提供；也可使用你在当前终端自行设置的 `DSH_CHATGPT_BRIDGE_TOKEN`。不要把令牌放进公开文件或聊天。启动器为客户端构造完整的 Bearer 环境变量引用，结束时恢复原环境。

本次打包和验证不运行 DeepSeek 模型、任务或工具。DSH 的真实连通性仍由目标机安装和配置决定。

## 文件位置和控制台

服务代码位于 `servers\`；隧道程序位于 `tunnel-client\`；配置模板位于 `templates\`；启动器位于 `launchers\`；向导生成的配置位于 `generated-profiles\`。包内 Node 位于 `runtime\node\`，保留对应许可证。

`manager\` 内为独立账号控制台压缩包，按其中说明解压启动。控制台地址 `http://127.0.0.1:17642` 用来管理账号和服务，不是 ChatGPT 要连接的 MCP 地址。新电脑使用自己的账号库、初始化密码和配置；本包不迁移旧电脑的这些数据。

新电脑若需代理，在本机按 tunnel-client 的官方配置设置；不要假定旧电脑的代理端口可直接使用。本包不改动旧电脑运行中的控制台、隧道、IDE 或账号。

## 验证范围

本轮只验证部署脚本、模拟凭据的环境恢复、命令和路径、配置模板，以及压缩包和上传文件的一致性。完整业务回归、真实账号切换、外网隧道连通和第二台实体机验收不在本轮通过范围内。

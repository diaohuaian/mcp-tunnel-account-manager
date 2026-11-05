# MCP Tunnel Account Manager

Windows 本地 MCP 隧道与账号管理控制台，通过浏览器管理多个账号、MCP 配置及安装位置。

**当前为公开预览版。** Windows 本机控制台已能运行；完整功能回归和第二台实体电脑验证尚未完成。

## Windows 快速使用

1. 从 [预览版 Release](https://github.com/zwsxzy/mcp-tunnel-account-manager/releases/tag/v1.0.0-preview.1) 下载 Windows x64 便携 ZIP。
2. 将整个压缩包解压到固定文件夹。
3. 双击 `安装桌面图标.cmd`，创建桌面 **MCP 隧道账号控制台** 并打开网页。
4. 按页面提示初始化密码，添加该电脑自己的账号和 MCP 安装路径。

以后点击桌面图标即可启动。安装文件夹移动后，重新运行图标安装程序。

便携包自带 Node.js 运行环境，无需另外安装 Node.js。源码压缩包与 Windows 便携 ZIP 是不同的下载项。

网页入口：<http://127.0.0.1:17642>。

## 功能范围

- 多账号 tunnel ID/API 配置与本地加密存储。
- 账号切换、执行状态与失败处理。
- MCP 配置查看、增删改及已有配置发现。
- 显示配置文件、安装目录、可执行文件和工作目录位置。
- Windows 桌面启动与便携分发。

这些是当前程序提供的功能范围，预览版的全部流程尚未完成最终验收。

## 每台电脑的数据

控制台仅监听本机 `127.0.0.1`。每台电脑独立初始化，数据保存在该用户的：

```text
%LOCALAPPDATA%\McpTunnelAccountManager
```

发布内容不包含维护者的真实账号库、密钥、初始化码或 MCP 配置。第二台电脑需配置自己的账号和本机 MCP 路径；本项目不自动同步两台电脑的数据。

Overleaf/Antigravity MCP 和 tunnel 客户端需要在使用电脑上另行安装或选择已有安装位置。

## 源码运行

`package.json` 声明 Node.js 22+。已运行的 Windows 便携版内置 Node.js v25.9.0；其他 Node.js 小版本未逐一验证。

```powershell
git clone https://github.com/zwsxzy/mcp-tunnel-account-manager.git
cd mcp-tunnel-account-manager
npm start
```

浏览器打开 <http://127.0.0.1:17642>。

## 制作 Windows 便携包

在 Windows 上使用可运行本项目的 Node.js，输出目录放在源码目录之外：

```powershell
node packaging/windows/build-portable.mjs . ..\mcp-console-build
powershell -NoProfile -ExecutionPolicy Bypass -File packaging/windows/create-portable-zip.ps1 -PackageRoot ..\mcp-console-build\MCP-Tunnel-Console -Architecture x64
```

构建会包含当前 Node.js 可执行文件及其许可证，只拷贝程序文件，不拷贝用户数据。ZIP 输出到当前用户桌面。

## 项目状态与许可

完整功能回归暂缓。此预览版未声明全部测试通过，也未声明已在另一台实体电脑安装验证。

项目许可证尚未指定。便携包中的 Node.js 运行时许可证随包附带。

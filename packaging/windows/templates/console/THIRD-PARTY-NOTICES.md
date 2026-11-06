# 第三方组件与分发边界

本文件是组件索引，不替代各组件完整的 LICENSE / NOTICE / 传递依赖许可证。

| 组件 | 本次版本 | 来源及授权说明 |
| --- | --- | --- |
| Node.js（便携包） | v25.9.0 Windows x64 | 从已有部署运行环境复制；保留 [runtime/LICENSE](<runtime/LICENSE>)，包含 Node 及其内嵌第三方声明。构建时验证版本与 SHA256；未声称重新下载或完成官方签名核验。源码包不含该二进制。 |
| OpenAI tunnel-client（完整包） | 0.0.19，提交 01d67bb4da0d8359b808b4761f8db171ab682cd7 | 完整包保留原 LICENSE、NOTICE、许可证汇总和 SPDX 清单。 |
| Cloudflared（完整包） | 2026.10.2 | 完整包保留原组件许可证汇总及 cloudflared-manifest.json；与 tunnel-client 配套。 |
| mcp-server-overleaf（完整包） | 0.3.9 | MIT；携带 npm package-lock.json 与现有生产依赖，原依赖许可证随树保留。实际 Node 要求 >=22.14.0，而不是旧说明里的 Node 18+。 |
| antigravity-mcp（完整包） | 1.1.0 | MIT；Python 标准库代码；Python 运行时与 Antigravity IDE 不在包中。 |
| dsh-chatgpt-bridge（完整包、可选） | 0.6.0，本地 RC.2 兼容变体 | MIT；携带编译后插件及 cordis patch；DSH 主程序和插件依赖未包含，不按版本号相同推定与所有 DSH 兼容。 |

以上运行组件取自现成部署工具包，不会把用户的已登录数据目录、npm 缓存、IDE 安装目录或 DSH 活动 profile 打包进去。保留的锁文件和 SPDX 是来源证据，不是本轮联网漏洞扫描或远端真实性验证的结论。

控制台业务代码自身：原快照没有附带项目许可证。本次不擅自选定 MIT / Apache 等授权；请仓库作者在公开发布前确认项目许可。

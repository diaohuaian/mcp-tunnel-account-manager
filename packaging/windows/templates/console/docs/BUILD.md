# 离线重建与发布边界

## 输入

- 当前源码快照的整个目录，包含 [构建器](<../packaging/windows/build-release.mjs>) 及其 templates 子目录；不要拿仅有 src 的零散目录构建。
- Windows x64 的 Node.js **22.14.0+** 可执行文件及其对应的完整 LICENSE。源代码版本用 22.14+，本次发出的便携包实际为 v25.9.0；不能只因文件名叫 node.exe 就替换为任意程序。
- 可选：完整部署工具包目录，作为 Overleaf/Antigravity/DSH 及隧道程序的依赖输入。必须先验证其 FILES.sha256，且绝不传入你自己的账号数据目录。

不需要 npm install，不下载组件，也不执行第三方安装脚本。构建输出目录必须是新目录并且位于源码目录之外，工具拒绝覆盖既有输出。

## 构建

在源码目录，替换下面示例路径：

```powershell
node packaging\windows\build-release.mjs `
  --source . `
  --output C:\MCP-Release-Build-New `
  --runtime C:\VerifiedRuntime\node.exe `
  --node-license C:\VerifiedRuntime\LICENSE
```

若用已核验的完整部署工具包提供服务依赖，可加：

```powershell
node packaging\windows\build-release.mjs `
  --source . `
  --output C:\MCP-Release-Build-New `
  --runtime C:\VerifiedKit\console\runtime\node.exe `
  --node-license C:\VerifiedKit\console\runtime\LICENSE `
  --dependency-kit C:\VerifiedKit
```

构建器生成三个独立目录（没有 --dependency-kit 时不生成完整包）。源码目录不含二进制；控制台目录含 Node；完整包共用 console/runtime，不重复塞入两份 Node。

打包前先检查和测试：

```powershell
node scripts\check.mjs
node --test tests\release-deployment.test.mjs
node packaging\windows\audit-release.mjs C:\MCP-Release-Build-New\MCP-Tunnel-Console
```

压缩指定的生成目录：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File packaging\windows\create-zip.ps1 `
  -SourceDirectory C:\MCP-Release-Build-New\MCP-Tunnel-Console `
  -DestinationZip C:\MCP-Tunnel-Console-Windows-x64.zip
Get-FileHash C:\MCP-Tunnel-Console-Windows-x64.zip -Algorithm SHA256
```

ZIP 工具包含顶层目录，遍历隐藏文件，拒绝 reparse points，不覆盖已有 ZIP，固定 ZIP 元数据时间以减少无关差异。Windows .NET 压缩实现/版本的变化可能影响压缩字节；本项目不承诺跨工具链字节级可复现。

## 源码保持与补丁

- [src](<../src/>) 与 [public](<../public/>) 以合并后的源码重新计算哈希并记录在 [source-core-hashes.json](<../source-core-hashes.json>)；旧 RC19/RC20 基线已不再适用。来源、合并血缘与已验证特性记录在 [source-provenance.json](<../source-provenance.json>)，不冒充旧清单完全匹配，也不回滚实际文件。
- 仅发布外壳变化：优先包内 Node、准确处理 PORT、拒绝外网 HOST、完整包指定 tunnel-client 路径、PID 所有权校验、首次启动不向日志输出 bootstrap code、临时目录测试、文档与许可索引。
- [package.json](<../package.json>) 的测试入口改为随附的 release-deployment 测试，Node 要求提高到与完整包依赖一致的 22.14.0；app version 仍为 1.0.0，private 仍为 true。
- 原上游完整测试没有包含在输入快照。新增测试不能当作完整业务回归。
- 构建器只选取固定程序目录和根文件，不复制 data、用户配置、.git、.env、账号库、密钥、日志、缓存和旧 ZIP；发现异常凭据路径或高风险内容会拒绝。
- 校验/扫描只是公开包发布前的防线，不是自动证明绝无任何敏感信息，更不是安全审计认证。

不要上传构建时的用户数据、测试日志、隔离测试目录或生成后的本机配置。发布工具不替你上传 GitHub、创建 tag、改远端或调整任何现有服务。

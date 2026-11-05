import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const source = path.resolve(process.argv[2] ?? '');
const parent = path.resolve(process.argv[3] ?? '');
const own = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(parent, 'MCP-Tunnel-Console');
const extensions = {
  src: new Set(['.mjs','.js','.cjs','.ps1']),
  scripts: new Set(['.mjs','.js','.cjs','.ps1','.cmd']),
  public: new Set(['.mjs','.js','.css','.html','.svg','.png','.ico','.jpg','.jpeg','.webp','.woff','.woff2','.ttf'])
};
const records = [];
function write(relative, bytes) {
  const destination = path.join(target, relative);
  fs.mkdirSync(path.dirname(destination), {recursive:true});
  fs.writeFileSync(destination, bytes, {flag:'wx'});
}
function copyCode(relative, group) {
  const input = path.join(source, relative), stat = fs.lstatSync(input);
  if (stat.isSymbolicLink()) throw new Error('SOURCE_SYMLINK_REJECTED');
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(input).sort()) {
      if (['node_modules','.git','reports','.task-work','.gpt-work','.cache','data','logs','tmp','temp'].includes(entry)) continue;
      copyCode(path.join(relative,entry),group);
    }
  } else if (stat.isFile() && extensions[group].has(path.extname(relative).toLowerCase())) {
    const bytes = fs.readFileSync(input);
    records.push({input,hash:sha(bytes)});
    const isPowerShell=path.extname(relative).toLowerCase()==='.ps1';
    const hasBom=(bytes[0]===0xef&&bytes[1]===0xbb&&bytes[2]===0xbf)||(bytes[0]===0xff&&bytes[1]===0xfe)||(bytes[0]===0xfe&&bytes[1]===0xff);
    if(isPowerShell&&!hasBom)new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    write(relative,isPowerShell&&!hasBom?Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),bytes]):bytes);
  }
}
async function nodeLicense() {
  const local = path.join(path.dirname(process.execPath),'LICENSE');
  if (fs.existsSync(local)) {
    const text = fs.readFileSync(local,'utf8');
    if (/Node\.js/i.test(text) && /Copyright/i.test(text)) return text;
  }
  if (!/^v\d+\.\d+\.\d+$/.test(process.version)) throw new Error('NODE_LICENSE_VERSION_UNKNOWN');
  const response = await fetch('https://raw.githubusercontent.com/nodejs/node/'+process.version+'/LICENSE', {redirect:'error',signal:AbortSignal.timeout(20000)});
  if (!response.ok) throw new Error('NODE_LICENSE_DOWNLOAD_FAILED');
  const text = await response.text();
  if (text.length>1048576 || !/Node\.js/i.test(text) || !/Copyright/i.test(text)) throw new Error('NODE_LICENSE_INVALID');
  return text;
}
try {
  if (process.platform!=='win32' || Number(process.versions.node.split('.')[0])<22) throw new Error('WORKING_WINDOWS_NODE22_REQUIRED');
  if (!source || source===parent || target.startsWith(source+path.sep)) throw new Error('INVALID_PACKAGE_PATH');
  if (fs.existsSync(target)) throw new Error('PACKAGE_TARGET_ALREADY_EXISTS');
  const packageFile = path.join(source,'package.json');
  const packageBytes = fs.readFileSync(packageFile);
  const packageJson = JSON.parse(packageBytes.toString('utf8'));
  if (Object.keys(packageJson.dependencies??{}).length || Object.keys(packageJson.optionalDependencies??{}).length) throw new Error('EXTERNAL_RUNTIME_DEPENDENCIES_REQUIRE_EXPLICIT_BUNDLE');
  records.push({input:packageFile,hash:sha(packageBytes)});
  fs.mkdirSync(target,{recursive:true});
  for (const group of ['src','public','scripts']) copyCode(group,group);
  write('package.json',packageBytes);
  for(const relative of ['src/main.mjs','public/app.js','scripts/start-manager.ps1','scripts/open-mcp-tunnel-console.ps1']) {
    if(!fs.existsSync(path.join(target,relative))) throw new Error('PACKAGE_RUNTIME_ENTRY_MISSING');
  }
  for (const name of ['open-portable-console.ps1','install-portable-console.ps1']) {
    const text = fs.readFileSync(path.join(own,name),'utf8').replace(/^\uFEFF/,'');
    write('scripts/'+name, '\uFEFF'+text);
  }
  write('启动控制台.cmd',fs.readFileSync(path.join(own,'portable-start.cmd'),'utf8').replace(/\r?\n/g,'\r\n'));
  write('安装桌面图标.cmd',fs.readFileSync(path.join(own,'portable-install.cmd'),'utf8').replace(/\r?\n/g,'\r\n'));
  write('start-manager.cmd',fs.readFileSync(path.join(own,'portable-start.cmd'),'utf8').replace(/\r?\n/g,'\r\n'));
  const nodeBytes = fs.readFileSync(process.execPath), nodeHash = sha(nodeBytes);
  write('runtime/node.exe',nodeBytes);
  write('runtime/LICENSE',await nodeLicense());
  const instructions = [
    'MCP 隧道账号控制台 — Windows 便携版',
    '',
    '运行环境：Windows '+process.arch+'；已内置当前可用的 Node.js '+process.version+'，无需另装 Node.js。',
    '',
    '1. 将整个压缩包复制到第二台电脑，解压到固定文件夹（不要在压缩包内直接启动）。',
    '2. 双击“安装桌面图标.cmd”，会创建桌面“MCP 隧道账号控制台”并打开网页。',
    '3. 以后双击桌面图标即可启动。移动安装文件夹后，重新运行“安装桌面图标.cmd”。',
    '4. 网页入口：http://127.0.0.1:17642。每台电脑使用自己的本地控制台。',
    '5. 首次使用按页面提示初始化控制台密码。若需要初始化码，请仅在该电脑本地查看提示的初始化文件；无需发送给任何人。',
    '6. 在第二台电脑上添加账号和 MCP，并选择那台电脑实际的安装目录、配置文件和可执行文件。',
    '',
    '本包只包含程序、启动器和运行环境，不包含原电脑的账号库、API 密钥、初始化码或真实 MCP 配置。',
    '第二台电脑的账号和设置存于该用户的 %LOCALAPPDATA%\\McpTunnelAccountManager。',
    'Overleaf/Antigravity MCP 及 tunnel 客户端需在第二台电脑自行安装或选择已有安装位置。',
    '本包不自动同步两台电脑的账号和配置，不开放局域网访问。',
    '完整功能回归依用户要求暂缓；打包仅做必要的文件完整性和启动脚本检查。',
    ''
  ].join('\r\n');
  write('使用说明.txt','\uFEFF'+instructions);
  const unchanged=records.every(record=>sha(fs.readFileSync(record.input))===record.hash);
  if(!unchanged || sha(fs.readFileSync(process.execPath))!==nodeHash) throw new Error('SOURCE_CHANGED_DURING_PACKAGING');
  console.log('MCP_PORTABLE_BUILD_RESULT='+JSON.stringify({success:true,packageRoot:target,nodeVersion:process.version,architecture:process.arch,nodeSha256:nodeHash,sourceFileCount:records.length,sourceUnchanged:true,realAccountDataIncluded:false}));
} catch(error) {
  console.log('MCP_PORTABLE_BUILD_RESULT='+JSON.stringify({success:false,errorCode:/^[A-Z0-9_]+$/.test(error.message)?error.message:'PORTABLE_BUILD_FAILED'}));
  process.exitCode=1;
}

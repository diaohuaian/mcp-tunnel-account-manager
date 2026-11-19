import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function getLaunchOptions(env = process.env, root = projectRoot) {
  if (env.HOST && env.HOST !== '127.0.0.1') {
    throw new Error('HOST must be 127.0.0.1; this console must not be exposed to the network.');
  }
  const rawPort = env.PORT || '17643';
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  const options = { host: '127.0.0.1', port: Number(rawPort) };
  if (env.DATA_DIR) options.dataDir = path.resolve(env.DATA_DIR);

  // The complete release keeps service dependencies beside the console, not in user state.
  // A marker prevents a portable console from silently adopting an unrelated parent directory.
  const bundleRoot = path.dirname(root);
  const marker = path.join(bundleRoot, 'package-manifest.json');
  if (fs.existsSync(marker)) {
    const manifest = JSON.parse(fs.readFileSync(marker, 'utf8').replace(/^\uFEFF/, ''));
    if (manifest.bundleKind === 'mcp-windows-deployment-kit' && manifest.consoleRelativePath === path.basename(root)) {
      const client = path.join(bundleRoot, 'tunnel-client', 'tunnel-client.exe');
      if (!fs.existsSync(client)) throw new Error('Bundled tunnel-client is missing; extract the complete ZIP first.');
      options.adapterOptions = { paths: { tunnelClientBin: client } };
    }
  }

  // A source checkout has no bundle manifest, so the instance layer would fall back to
  // %USERPROFILE%\.openai-tunnel\tunnel-client.exe and every start failed with
  // EXECUTABLE_NOT_FOUND. TUNNEL_CLIENT_BIN lets such a checkout point at its own copy.
  // An explicit path always wins over the bundled one, and a wrong path fails loudly
  // here instead of surfacing later as "executable not found" on every service.
  if (env.TUNNEL_CLIENT_BIN) {
    const explicit = path.resolve(env.TUNNEL_CLIENT_BIN);
    if (!fs.existsSync(explicit)) {
      throw new Error(`TUNNEL_CLIENT_BIN does not exist: ${explicit}`);
    }
    options.adapterOptions = {
      ...(options.adapterOptions || {}),
      paths: { ...((options.adapterOptions && options.adapterOptions.paths) || {}), tunnelClientBin: explicit }
    };
  }

  // When running directly from a source checkout without environment overrides,
  // default to the checkout's self-contained data directory and tunnel client.
  if (env === process.env && root === projectRoot) {
    if (!options.dataDir && !env.DATA_DIR) {
      const devData = path.join(root, 'data');
      if (fs.existsSync(devData)) options.dataDir = devData;
    }
    if (!options.adapterOptions?.paths?.tunnelClientBin && !env.TUNNEL_CLIENT_BIN) {
      const devClient = path.join(root, 'tools', 'tunnel-client', 'tunnel-client.exe');
      if (fs.existsSync(devClient)) {
        options.adapterOptions = {
          ...(options.adapterOptions || {}),
          paths: { ...((options.adapterOptions && options.adapterOptions.paths) || {}), tunnelClientBin: devClient }
        };
      }
    }
  }

  return options;
}

export async function run() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 14)) {
    throw new Error('Node.js >= 22.14.0 is required. Use the included Windows x64 runtime.');
  }
  const devAppData = path.join(projectRoot, 'data', 'appdata');
  if (!process.env.APPDATA && fs.existsSync(path.join(devAppData, 'tunnel-client'))) {
    process.env.APPDATA = devAppData;
  }
  const { startManager } = await import('../src/main.mjs');
  const manager = await startManager(getLaunchOptions());
  // Never echo the bootstrap code into background-process logs.
  console.log(`MCP Tunnel Account Manager listening on ${manager.url}`);
  console.log(`Local data directory: ${manager.dataDir}`);
  console.log('First run: read bootstrap-code.txt in the local data directory; do not share it.');
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 5000);
    deadline.unref();
    try {
      await manager.close();
      clearTimeout(deadline);
      process.exitCode = 0;
    } catch (error) {
      console.error('Shutdown failed:', error.message);
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return manager;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(error => {
    console.error('Console startup failed:', error.message);
    process.exitCode = 1;
  });
}

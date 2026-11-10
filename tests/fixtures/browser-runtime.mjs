import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Searches for supported installed Chrome or Edge browser executables on Windows.
 * Prioritizes standard installation directories.
 */
export function findBrowserExecutable() {
  const candidates = process.platform === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        path.join(os.homedir(), 'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
        '/Applications/Chromium.app/Contents/MacOS/Chromium'
      ]
    : [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
      ];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const stat = fs.statSync(p);
        if (stat.isFile() && stat.size > 0) {
          return { executable: p, size: stat.size };
        }
      }
    } catch (_) {}
  }
  return null;
}

/**
 * Inspects and constructs a safe, isolated OS environment for browser execution.
 * - Preserves required Windows variables case-insensitively (SystemRoot, PATH, etc.)
 * - Strips host CP/OPENAI/TUNNEL/MCP credentials and proxies.
 * - Forces fresh synthetic USERPROFILE/APPDATA/LOCALAPPDATA/TEMP roots.
 */
export function buildSafeBrowserEnv(syntheticRootDir) {
  const preservedNames = new Set([
    'systemroot',
    'systemdrive',
    'path',
    'windir',
    'comspec',
    'pathext',
    'number_of_processors',
    'processor_architecture',
    'processor_identifier',
    'processor_level',
    'processor_revision',
    'os',
    'homedrive',
    'programdata',
    'programfiles',
    'programfiles(x86)',
    'programw6432',
    'commonprogramfiles',
    'commonprogramfiles(x86)',
    'commonprogramw6432',
    'home',
    'user',
    'logname',
    'shell',
    'tmpdir',
    'lang',
    'lc_all',
    'term'
  ]);

  const sensitiveKeywords = [
    'openai',
    'tunnel',
    'mcp',
    'control_plane',
    'cp_',
    'proxy',
    'token',
    'secret',
    'key',
    'credential',
    'auth',
    'password'
  ];

  const safeEnv = {};

  for (const [key, val] of Object.entries(process.env)) {
    const lowerKey = key.toLowerCase();
    const isSensitive = sensitiveKeywords.some(kw => lowerKey.includes(kw));
    if (isSensitive) {
      continue;
    }
    if (preservedNames.has(lowerKey)) {
      safeEnv[key] = val;
    }
  }

  // Create isolated synthetic profile dirs
  const profileDir = path.join(syntheticRootDir, 'p');
  const appDataDir = path.join(profileDir, 'AppData', 'Roaming');
  const localAppDataDir = path.join(profileDir, 'AppData', 'Local');
  const localLowDir = path.join(profileDir, 'AppData', 'LocalLow');
  const tempDir = path.join(syntheticRootDir, 't');

  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(appDataDir, { recursive: true });
  fs.mkdirSync(localAppDataDir, { recursive: true });
  fs.mkdirSync(localLowDir, { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });

  // Immunize synthetic profile dirs against host background IME/telemetry daemons holding open file locks
  for (const name of ['SogouPY', 'SogouPy', 'Tencent', 'ichat']) {
    try { fs.writeFileSync(path.join(localLowDir, name), ''); } catch (_) {}
    try { fs.writeFileSync(path.join(appDataDir, name), ''); } catch (_) {}
  }

  // Force fresh synthetic roots (never real host user profiles)
  safeEnv.USERPROFILE = profileDir;
  safeEnv.APPDATA = appDataDir;
  safeEnv.LOCALAPPDATA = localAppDataDir;
  safeEnv.TEMP = tempDir;
  safeEnv.TMP = tempDir;
  if (process.platform === 'darwin') {
    safeEnv.HOME = profileDir;
    safeEnv.TMPDIR = tempDir;
  }

  return {
    env: safeEnv,
    profileDir,
    appDataDir,
    localAppDataDir,
    tempDir
  };
}

/**
 * Spawns an installed Chrome/Edge browser in headless mode with dedicated CDP debugging port.
 * Safely manages child process handles, enforces isolated environments, and listens for errors/exits
 * before readiness polling.
 */
export async function launchHeadlessBrowser(options = {}) {
  const browserMeta = options.executable ? { executable: options.executable } : findBrowserExecutable();
  if (!browserMeta || !browserMeta.executable) {
    throw new Error('No supported Chrome or Edge browser executable found on host');
  }
  const executable = browserMeta.executable;

  let ownedSyntheticRoot = false;
  let syntheticRootDir = options.syntheticRootDir;
  if (!syntheticRootDir) {
    syntheticRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synth-br-root-'));
    ownedSyntheticRoot = true;
  }

  const { env: safeEnv } = buildSafeBrowserEnv(syntheticRootDir);

  let userDataDir = options.userDataDir;
  if (!userDataDir) {
    userDataDir = path.join(syntheticRootDir, 'u');
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  // Raw arguments - keep sandbox and security active, no shell or extra quotes
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-gpu',
    '--disable-features=TranslateUI',
    '--disable-ime',
    '--disable-extensions',
    'about:blank'
  ];

  const child = spawn(executable, args, {
    cwd: syntheticRootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    env: safeEnv,
    windowsHide: true
  });

  // Listen to error and exit BEFORE readiness polling begins
  let stderrBuffer = '';
  const maxStderrLen = 64 * 1024;
  let childExited = false;
  let exitCode = null;
  let exitSignal = null;
  let exitError = null;

  child.stderr.on('data', (chunk) => {
    stderrBuffer += chunk.toString('utf8');
    if (stderrBuffer.length > maxStderrLen) {
      stderrBuffer = stderrBuffer.slice(-maxStderrLen);
    }
  });

  child.once('error', (err) => {
    exitError = err;
    childExited = true;
  });

  child.once('exit', (code, signal) => {
    childExited = true;
    exitCode = code;
    exitSignal = signal;
  });

  const activePortFile = path.join(userDataDir, 'DevToolsActivePort');
  const timeoutMs = options.timeoutMs || 25000;
  const startTime = Date.now();
  let port = null;

  // Poll for port and early child exit
  while (Date.now() - startTime < timeoutMs) {
    if (childExited) {
      throw new Error(
        `Browser process terminated prematurely before readiness. Code: ${exitCode}, Signal: ${exitSignal}, Error: ${exitError?.message || 'none'}. Diagnostic stderr:\n${stderrBuffer}`
      );
    }

    // 1. Check DevToolsActivePort file (primary reliable indicator)
    if (fs.existsSync(activePortFile)) {
      try {
        const rawContent = fs.readFileSync(activePortFile, 'utf8').trim();
        const lines = rawContent.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        if (lines.length > 0) {
          const parsed = parseInt(lines[0], 10);
          if (Number.isSafeInteger(parsed) && parsed > 0) {
            port = parsed;
            break;
          }
        }
      } catch (_) {}
    }

    // 2. Fallback check: parse fragmented or chunked stderr for DevTools listening message
    if (stderrBuffer) {
      const match = stderrBuffer.match(/DevTools listening on ws:\/\/(?:127\.0\.0\.1|localhost):(\d+)\/([^\s\r\n]+)/);
      if (match) {
        const parsed = parseInt(match[1], 10);
        if (Number.isSafeInteger(parsed) && parsed > 0) {
          port = parsed;
          break;
        }
      }
    }

    await new Promise((r) => setTimeout(r, 50));
  }

  if (!port) {
    try { child.kill('SIGTERM'); } catch (_) {}
    throw new Error(
      `Failed to obtain valid DevTools port from browser within ${timeoutMs}ms. Stderr diagnostics:\n${stderrBuffer}`
    );
  }

  // 3. Verify HTTP CDP endpoint readiness and retrieve page target
  let pageTarget = null;
  const httpDeadline = Date.now() + 10000;
  while (Date.now() < httpDeadline) {
    if (childExited) {
      throw new Error(`Browser child exited during HTTP CDP readiness check. Stderr:\n${stderrBuffer}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(1500)
      });
      if (res.ok) {
        const list = await res.json();
        pageTarget = list.find((t) => t.type === 'page');
        if (!pageTarget) {
          // Attempt to create a new page target if none open
          try {
            const newRes = await fetch(`http://127.0.0.1:${port}/json/new`, {
              method: 'PUT',
              signal: AbortSignal.timeout(1500)
            });
            if (newRes.ok) {
              pageTarget = await newRes.json();
            }
          } catch (_) {}
        }
        if (pageTarget && pageTarget.webSocketDebuggerUrl) {
          break;
        }
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }

  if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
    try { child.kill('SIGTERM'); } catch (_) {}
    throw new Error(`Failed to obtain a valid WebSocket debugger target for browser on port ${port}`);
  }

  // 4. Connect native WebSocket
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const wsTimeout = setTimeout(() => {
      try { ws.close(); } catch (_) {}
      reject(new Error(`WebSocket connection timeout to ${pageTarget.webSocketDebuggerUrl}`));
    }, 10000);

    ws.onopen = () => {
      clearTimeout(wsTimeout);
      resolve();
    };
    ws.onerror = (err) => {
      clearTimeout(wsTimeout);
      reject(err);
    };
  });

  let messageId = 1;
  const pending = new Map();

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) {
          reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          resolve(msg.result);
        }
      }
    } catch (_) {}
  };

  function sendCommand(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) {
        return reject(new Error(`WebSocket connection is not open (readyState: ${ws.readyState})`));
      }
      const id = messageId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evalJs(expr) {
    const res = await sendCommand('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true
    });
    if (res?.exceptionDetails) {
      const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'Eval error';
      throw new Error(`Browser Eval Error: ${desc}`);
    }
    return res?.result?.value;
  }

  async function screenshot(outPath) {
    const res = await sendCommand('Page.captureScreenshot', { format: 'png' });
    const dir = path.dirname(outPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outPath, Buffer.from(res.data, 'base64'));
    return outPath;
  }

  async function close() {
    // 1. Send Browser.close to the browser target via CDP for graceful full-tree termination
    try {
      const vRes = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1000)
      });
      if (vRes.ok) {
        const v = await vRes.json();
        if (v.webSocketDebuggerUrl) {
          const bWs = new WebSocket(v.webSocketDebuggerUrl);
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 2000);
            bWs.onopen = () => {
              try {
                bWs.send(JSON.stringify({ id: 99999, method: 'Browser.close' }));
              } catch (_) {}
              setTimeout(resolve, 500);
            };
            bWs.onerror = resolve;
            bWs.onclose = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          try { bWs.close(); } catch (_) {}
        }
      }
    } catch (_) {}

    try {
      ws.close();
    } catch (_) {}

    // 2. Wait for child to exit cleanly
    if (child && child.exitCode === null) {
      await new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        const t = setTimeout(resolve, 2500);
        child.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }

    // 3. Fallback kill if still running
    if (child && child.exitCode === null && !child.killed) {
      try {
        child.kill('SIGTERM');
      } catch (_) {}

      await new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        const t = setTimeout(resolve, 1500);
        child.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });

      if (child.exitCode === null) {
        try {
          child.kill('SIGKILL');
        } catch (_) {}
      }
    }

    try { child.stdout?.destroy(); } catch (_) {}
    try { child.stderr?.destroy(); } catch (_) {}

    // Give child processes time to finish exiting and releasing handles
    await new Promise(r => setTimeout(r, 1000));

    // Clean up temporary synthetic dirs if owned
    if (ownedSyntheticRoot && fs.existsSync(syntheticRootDir)) {
      const rm = () => {
        try {
          fs.rmSync(syntheticRootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
          return true;
        } catch (_) {
          try {
            const clearRo = (p) => {
              try { fs.chmodSync(p, 0o666); } catch (_) {}
              try {
                const stat = fs.lstatSync(p);
                if (stat.isDirectory()) {
                  for (const c of fs.readdirSync(p)) clearRo(path.join(p, c));
                }
              } catch (_) {}
            };
            clearRo(syntheticRootDir);
            fs.rmSync(syntheticRootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
            return true;
          } catch (_) {
            return false;
          }
        }
      };
      for (let attempt = 0; attempt < 15; attempt++) {
        if (rm()) break;
        await new Promise(r => setTimeout(r, 300));
      }
    }
  }

  return {
    port,
    childPid: child.pid,
    child,
    userDataDir,
    syntheticRootDir,
    pageTarget,
    wsUrl: pageTarget.webSocketDebuggerUrl,
    readyPromise: Promise.resolve(),
    sendCommand,
    send: sendCommand,
    evalJs,
    screenshot,
    close
  };
}

export const createBrowserRuntime = launchHeadlessBrowser;

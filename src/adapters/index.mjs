import { persistHttpState, loadHttpState, getHttpStatePath } from './http-state-store.mjs';
import { userProfilePath } from '../core/user-profile-path.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SwitchFault } from '../core/switch-core.mjs';
import { assertStoppedConnectionReceipt, isMcpServiceId } from '../core/mcp-registry-policy.mjs';
import { createTunnelProbe, tunnelProbe as defaultTunnelProbe } from './tunnel-probe.mjs';
import { bindingToTunnelCommand, formatWindowsCommandLine } from './mcp-binding.mjs';
import {
  sealHttpTransport,
  openHttpTransport,
  compileHttpTransport,
  clearInheritedMcpOverrides,
  mergeHttpLaunchEnvironment,
  fingerprintHttpConfiguration,
  HttpTransportFault
} from './http-transport.mjs';
import { buildTunnelLaunchEnvironment, TunnelLaunchEnvironmentFault } from './tunnel-launch-environment.mjs';
import {
  getHttpTransportPacketPath,
  persistHttpTransportPacket,
  loadHttpTransportPacket,
  plansEqual
} from './http-state-store.mjs';

export { SwitchFault, HttpTransportFault, TunnelLaunchEnvironmentFault, buildTunnelLaunchEnvironment, createTunnelProbe, defaultTunnelProbe, ServiceAdapter };

export const DEFAULT_PROXY = 'http://127.0.0.1:7897';

export const SAFE_INHERITED_KEYS = [
  'SystemRoot', 'SYSTEMROOT',
  'SystemDrive', 'SYSTEMDRIVE',
  'windir', 'WINDIR',
  'PATH', 'Path', 'path',
  'PATHEXT', 'Pathext',
  'TEMP', 'TMP',
  'LOCALAPPDATA', 'APPDATA',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'COMSPEC', 'ComSpec',
  'PROGRAMFILES', 'ProgramFiles',
  'PROGRAMFILES(X86)', 'ProgramFiles(x86)',
  'PROGRAMDATA', 'ProgramData',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'OS', 'NODE_ENV'
];

/**
 * Constructs a safe pinned child process environment.
 * Pins only allowlisted system variables from parent process.env, preventing
 * arbitrary host secrets from leaking to child processes.
 */
export function buildSafePinnedEnv(explicit = {}) {
  const pinned = {};
  for (const key of SAFE_INHERITED_KEYS) {
    if (process.env[key] !== undefined) {
      pinned[key] = process.env[key];
    }
  }
  return {
    ...pinned,
    ...explicit
  };
}

function sha256(data) {
  const content = typeof data === 'string' ? data : JSON.stringify(data);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function normalizeCredential(cred = {}) {
  return {
    tunnelId: cred?.tunnelId ?? cred?.tunnel_id ?? '',
    apiKey: cred?.apiKey ?? cred?.api_key ?? '',
    organizationId: cred?.organizationId ?? cred?.organization_id ?? null,
  };
}

function maskTunnelId(tunnelId) {
  if (!tunnelId || typeof tunnelId !== 'string') return '';
  if (tunnelId.length <= 8) return '****';
  return `${tunnelId.slice(0, 7)}...${tunnelId.slice(-5)}`;
}

/**
 * Bounded path-aware YAML updater for tunnel-client YAML configurations.
 * Updates control_plane block (tunnel_id, api_key, organization_id)
 * while strictly preserving all comments, indentation, health/mcp blocks, and proxy settings.
 */
function updateYamlControlPlane(rawYaml, { tunnelId, organizationId, apiKey = 'env:CONTROL_PLANE_API_KEY' }, service, definition) {
  if (!rawYaml || rawYaml.trim() === '') {
    // Generate default canonical yaml
    const lines = [
      'config_version: 1',
      'control_plane:',
      '  base_url: "https://api.openai.com"',
    ];
    if (organizationId) {
      lines.push(`  organization_id: "${organizationId}"`);
    }
    lines.push(`  tunnel_id: "${tunnelId}"`);
    lines.push(`  api_key: "${apiKey}"`);
    lines.push('health:');
    lines.push('  listen_addr: "127.0.0.1:0"');
    lines.push('admin_ui:');
    lines.push('  open_browser: false');
    lines.push('log:');
    lines.push('  level: info');
    lines.push('  format: json');
    lines.push('mcp:');
    lines.push('  commands:');
    if (service === 'overleaf-mcp') {
      lines.push('    - channel: main');
      lines.push(`      command: "node ${userProfilePath('.overleaf-mcp', 'runtime', 'node_modules', 'mcp-server-overleaf', 'dist', 'index.js').replaceAll('\\\\', '/')} --stdio"`);
    } else if (service === 'antigravity-mcp') {
      lines.push('    - channel: main');
      lines.push('      command: "antigravity-mcp"');
    } else if (definition?.binding && definition.binding.type === 'stdio') {
      const tunnelCmd = bindingToTunnelCommand(definition.binding);
      lines.push('    - channel: main');
      lines.push(`      command: ${JSON.stringify(tunnelCmd.command)}`);
    } else if (definition?.command) {
      lines.push('    - channel: main');
      lines.push(`      command: ${JSON.stringify(definition.command)}`);
    } else {
      lines.push('    - channel: main');
      lines.push(`      command: "${service}"`);
    }
    return lines.join('\n') + '\n';
  }

  const lines = rawYaml.split(/\r?\n/);
  const eol = rawYaml.includes('\r\n') ? '\r\n' : '\n';
  const result = [];
  let inControlPlane = false;
  let seenTunnelId = false;
  let seenApiKey = false;
  let seenOrgId = false;
  let controlPlaneIndent = '  ';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^[a-zA-Z0-9_-]+:/.test(line)) {
      if (/^control_plane:\s*(#.*)?$/.test(line)) {
        inControlPlane = true;
        result.push(line);
        continue;
      } else if (inControlPlane) {
        // Leaving control_plane block, append any missing fields before next block
        if (!seenTunnelId && tunnelId) {
          result.push(`${controlPlaneIndent}tunnel_id: "${tunnelId}"`);
        }
        if (!seenApiKey) {
          result.push(`${controlPlaneIndent}api_key: "${apiKey}"`);
        }
        if (!seenOrgId && organizationId) {
          result.push(`${controlPlaneIndent}organization_id: "${organizationId}"`);
        }
        inControlPlane = false;
        result.push(line);
        continue;
      }
    }

    if (inControlPlane) {
      const indentMatch = line.match(/^(\s+)/);
      if (indentMatch && indentMatch[1].length > 0) {
        controlPlaneIndent = indentMatch[1];
      }

      if (/^\s*tunnel_id:\s*.*$/.test(line)) {
        seenTunnelId = true;
        result.push(`${controlPlaneIndent}tunnel_id: "${tunnelId}"`);
        continue;
      }

      if (/^\s*api_key:\s*.*$/.test(line)) {
        seenApiKey = true;
        result.push(`${controlPlaneIndent}api_key: "${apiKey}"`);
        continue;
      }

      if (/^\s*organization_id:\s*.*$/.test(line)) {
        seenOrgId = true;
        if (organizationId) {
          result.push(`${controlPlaneIndent}organization_id: "${organizationId}"`);
        }
        continue;
      }

      result.push(line);
    } else {
      result.push(line);
    }
  }

  if (inControlPlane) {
    if (!seenTunnelId && tunnelId) {
      result.push(`${controlPlaneIndent}tunnel_id: "${tunnelId}"`);
    }
    if (!seenApiKey) {
      result.push(`${controlPlaneIndent}api_key: "${apiKey}"`);
    }
    if (!seenOrgId && organizationId) {
      result.push(`${controlPlaneIndent}organization_id: "${organizationId}"`);
    }
  }

  return result.join(eol);
}

function updateYamlControlPlaneForHttp(rawYaml, { tunnelId, organizationId, apiKey = 'env:CONTROL_PLANE_API_KEY' }, service) {
  if (!rawYaml || rawYaml.trim() === '') {
    const lines = [
      'config_version: 1',
      'control_plane:',
      '  base_url: "https://api.openai.com"',
    ];
    if (organizationId) {
      lines.push(`  organization_id: "${organizationId}"`);
    }
    lines.push(`  tunnel_id: "${tunnelId}"`);
    lines.push(`  api_key: "${apiKey}"`);
    lines.push('health:');
    lines.push('  listen_addr: "127.0.0.1:0"');
    lines.push('admin_ui:');
    lines.push('  open_browser: false');
    lines.push('log:');
    lines.push('  level: info');
    lines.push('  format: json');
    return lines.join('\n') + '\n';
  }

  const lines = rawYaml.split(/\r?\n/);
  let inMcp = false;
  for (const line of lines) {
    if (/^[a-zA-Z0-9_-]+:/.test(line)) {
      if (/^mcp:\s*(#.*)?$/.test(line)) {
        inMcp = true;
        continue;
      } else {
        inMcp = false;
      }
    }
    if (inMcp) {
      const channelMatch = line.match(/^\s*-\s*channel:\s*["']?([^"'\r\n]+)["']?/);
      if (channelMatch) {
        const channel = channelMatch[1].trim();
        if (channel !== 'main') {
          throw new SwitchFault('AMBIGUOUS_CONFIG');
        }
      }
    }
  }

  // Strip mcp: block from existing YAML so generated HTTP profile has NO main stdio fallback or stale mcp headers
  const strippedLines = [];
  let skippingMcp = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^[a-zA-Z0-9_-]+:/.test(line)) {
      if (/^mcp:\s*(#.*)?$/.test(line)) {
        skippingMcp = true;
        continue;
      } else {
        skippingMcp = false;
      }
    }
    if (!skippingMcp) {
      strippedLines.push(line);
    }
  }

  return updateYamlControlPlane(strippedLines.join('\n'), { tunnelId, organizationId, apiKey }, service);
}

function parseYamlControlPlane(rawYaml) {
  if (!rawYaml) return {};
  const lines = rawYaml.split(/\r?\n/);
  let inControlPlane = false;
  let tunnelId = null;
  let organizationId = null;
  let apiKey = null;
  let baseUrl = null;

  for (const line of lines) {
    if (/^[a-zA-Z0-9_-]+:/.test(line)) {
      if (/^control_plane:\s*(#.*)?$/.test(line)) {
        inControlPlane = true;
        continue;
      } else if (inControlPlane) {
        break;
      }
    }
    if (inControlPlane) {
      const bMatch = line.match(/^\s*base_url:\s*["']?([^"'\r\n]+)["']?\s*(#.*)?$/);
      if (bMatch) baseUrl = bMatch[1].trim();

      const tMatch = line.match(/^\s*tunnel_id:\s*["']?([^"'\r\n]+)["']?\s*(#.*)?$/);
      if (tMatch) tunnelId = tMatch[1].trim();

      const oMatch = line.match(/^\s*organization_id:\s*["']?([^"'\r\n]+)["']?\s*(#.*)?$/);
      if (oMatch) organizationId = oMatch[1].trim();

      const kMatch = line.match(/^\s*api_key:\s*["']?([^"'\r\n]+)["']?\s*(#.*)?$/);
      if (kMatch) apiKey = kMatch[1].trim();
    }
  }

  return { tunnelId, organizationId, apiKey, baseUrl };
}

/**
 * Controller wrapper for fixed helper actions: Inspect, Verify, Stop, Launch.
 * Supports safe intent/tag recovery and runtimeCommand test hook for raw JSON fakes.
 */
let sharedPsWorker = null;
let sharedPsReqCounter = 0;

function getOrStartPsWorker() {
  if (sharedPsWorker && !sharedPsWorker.dead) {
    return sharedPsWorker;
  }

  const workerScript = [
    'Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force',
    '$ErrorActionPreference = "Continue"',
    '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'while ($null -ne ($line = [Console]::In.ReadLine())) {',
    '  if ([string]::IsNullOrWhiteSpace($line)) { continue }',
    '  $reqId = ""',
    '  try {',
    '    $req = $line | ConvertFrom-Json -ErrorAction Stop',
    '    $reqId = [string]$req.id',
    '    $sp = [string]$req.scriptPath',
    '    $splat = @{}',
    '    if ($null -ne $req.params) {',
    '      foreach ($p in $req.params.PSObject.Properties) {',
    '        if ($null -ne $p.Value) { $splat[$p.Name] = $p.Value }',
    '      }',
    '    }',
    '    $global:LASTEXITCODE = 0',
    '    $outLines = & $sp @splat 2>&1',
    '    $code = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }',
    '    $stdoutStr = ($outLines | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] } | ForEach-Object { $_.ToString() }) -join "`n"',
    '    $stderrStr = ($outLines | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } | ForEach-Object { $_.ToString() }) -join "`n"',
    '    $resp = @{ id = $reqId; code = $code; stdout = $stdoutStr; stderr = $stderrStr } | ConvertTo-Json -Compress',
    '    [Console]::Out.WriteLine("__MCP_PS_RESP__" + $resp)',
    '    [Console]::Out.Flush()',
    '  } catch {',
    '    $errResp = @{ id = $reqId; code = 1; stdout = ""; stderr = $_.Exception.Message } | ConvertTo-Json -Compress',
    '    [Console]::Out.WriteLine("__MCP_PS_RESP__" + $errResp)',
    '    [Console]::Out.Flush()',
    '  }',
    '}'
  ].join('\n');

  const encodedCommand = Buffer.from(workerScript, 'utf16le').toString('base64');

  const child = spawn('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encodedCommand
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });

  child.unref();
  if (typeof child.stdin?.unref === 'function') child.stdin.unref();
  if (typeof child.stdout?.unref === 'function') child.stdout.unref();
  if (typeof child.stderr?.unref === 'function') child.stderr.unref();

  const pending = new Map();
  let keepAliveTimer = null;
  let buffer = '';

  function updateRef() {
    if (pending.size > 0 && !keepAliveTimer) {
      keepAliveTimer = setInterval(() => {}, 30000);
    } else if (pending.size === 0 && keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  }

  const state = {
    child,
    dead: false,
    send(scriptPath, splatParams) {
      return new Promise((resolve, reject) => {
        if (state.dead) {
          return reject(new Error('PS worker closed'));
        }
        const id = `req_${++sharedPsReqCounter}`;
        const timer = setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            updateRef();
            reject(new Error('PS worker timeout'));
          }
        }, 12000);
        if (typeof timer.unref === 'function') timer.unref();

        pending.set(id, { resolve, reject, timer });
        updateRef();

        try {
          const line = JSON.stringify({ id, scriptPath, params: splatParams }) + '\n';
          child.stdin.write(line, 'utf8');
        } catch (err) {
          clearTimeout(timer);
          pending.delete(id);
          updateRef();
          reject(err);
        }
      });
    }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      const markerIdx = line.indexOf('__MCP_PS_RESP__');
      if (markerIdx !== -1) {
        const jsonPart = line.slice(markerIdx + '__MCP_PS_RESP__'.length);
        try {
          const msg = JSON.parse(jsonPart);
          const entry = pending.get(msg.id);
          if (entry) {
            clearTimeout(entry.timer);
            pending.delete(msg.id);
            updateRef();
            let parsed = null;
            try {
              if (msg.stdout && msg.stdout.trim()) {
                parsed = JSON.parse(msg.stdout.trim());
              }
            } catch (_) {}
            entry.resolve({
              code: msg.code ?? 0,
              stdout: msg.stdout || '',
              stderr: msg.stderr || '',
              data: parsed,
              ...(parsed || {})
            });
          }
        } catch (_) {}
      }
    }
  });

  const markDead = (err) => {
    state.dead = true;
    for (const [id, entry] of pending.entries()) {
      clearTimeout(entry.timer);
      entry.reject(err || new Error('PS worker exited'));
    }
    pending.clear();
    updateRef();
  };

  child.on('error', markDead);
  child.on('close', () => markDead(new Error('PS worker closed')));

  sharedPsWorker = state;
  return state;
}

export function createDefaultProcessController({ dataDir, scriptPath, runtimeCommand, paths }) {
  const runtimeDir = path.join(dataDir, 'runtime');

  function getProcessFile(service) {
    return path.join(runtimeDir, `${service}-process.json`);
  }

  function getIntentFile(service) {
    return path.join(runtimeDir, `${service}-intent.json`);
  }

  if (typeof runtimeCommand !== 'function' && scriptPath && fs.existsSync(scriptPath) && !process.env.NODE_TEST_CONTEXT) {
    try {
      const w = getOrStartPsWorker();
      w.send(scriptPath, { Action: 'Inspect', ProcessId: 0 }).catch(() => {});
    } catch (_) {}
  }

  async function executeHelper(action, params = {}) {
    if (typeof runtimeCommand === 'function') {
      const res = await runtimeCommand(action, params);
      if (typeof res === 'string') {
        try { return JSON.parse(res); } catch (_) { return { stdout: res }; }
      }
      if (res && typeof res === 'object') {
        if (typeof res.stdout === 'string') {
          try {
            const parsed = JSON.parse(res.stdout.trim());
            return { ...res, ...parsed };
          } catch (_) {
            return res;
          }
        }
        return res;
      }
      return res;
    }

    if (!scriptPath || !fs.existsSync(scriptPath)) {
      throw new SwitchFault('PROCESS_CONTROL_SCRIPT_UNAVAILABLE');
    }

    const splatParams = { Action: action };
    if (params.ProcessId) splatParams.ProcessId = Number(params.ProcessId);
    if (params.ExpectedExecutablePath) splatParams.ExpectedExecutablePath = String(params.ExpectedExecutablePath);
    if (params.ExpectedStartTime) splatParams.ExpectedStartTime = String(params.ExpectedStartTime);
    if (params.ExpectedCreationTimeFileTime) splatParams.ExpectedCreationTimeFileTime = String(params.ExpectedCreationTimeFileTime);
    if (params.ExecutablePath) splatParams.ExecutablePath = String(params.ExecutablePath);
    if (params.Arguments && Array.isArray(params.Arguments)) splatParams.Arguments = [params.Arguments.join(' ')];
    if (params.WorkingDirectory) splatParams.WorkingDirectory = String(params.WorkingDirectory);
    if (params.Tag) splatParams.Tag = String(params.Tag);
    if (params.CommandLine) splatParams.CommandLine = String(params.CommandLine);
    if (params.Port) splatParams.Port = Number(params.Port);
    if (params.LaunchPayload) splatParams.LaunchPayload = params.LaunchPayload;

    try {
      const worker = getOrStartPsWorker();
      return await worker.send(scriptPath, splatParams);
    } catch (error) {
      // A Launch may have succeeded before an acknowledgement was lost. Never
      // replay it (or silently fall back to Node's console-less spawn): that can
      // create a second untracked tunnel and visible backend terminals.
      if (action === 'Launch') {
        throw new SwitchFault('PROCESS_LAUNCH_UNCONFIRMED', 'Native launch acknowledgement was not confirmed');
      }
      // Read-only/idempotent helper actions may use standalone PowerShell.
    }

    return new Promise((resolve, reject) => {
      const args = [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
        '-Action', action
      ];

      if (params.ProcessId) {
        args.push('-ProcessId', String(params.ProcessId));
      }
      if (params.ExpectedExecutablePath) {
        args.push('-ExpectedExecutablePath', params.ExpectedExecutablePath);
      }
      if (params.ExpectedStartTime) {
        args.push('-ExpectedStartTime', params.ExpectedStartTime);
      }
      if (params.ExpectedCreationTimeFileTime) {
        args.push('-ExpectedCreationTimeFileTime', String(params.ExpectedCreationTimeFileTime));
      }
      if (params.ExecutablePath) {
        args.push('-ExecutablePath', params.ExecutablePath);
      }
      if (params.Arguments && Array.isArray(params.Arguments)) {
        args.push('-Arguments', params.Arguments.join(' '));
      }
      if (params.WorkingDirectory) {
        args.push('-WorkingDirectory', params.WorkingDirectory);
      }
      if (params.Tag) {
        args.push('-Tag', String(params.Tag));
      }
      if (params.CommandLine) {
        args.push('-CommandLine', String(params.CommandLine));
      }
      if (params.Port) {
        args.push('-Port', String(params.Port));
      }

      const child = spawn('powershell', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      child.on('close', code => {
        let parsed = null;
        try {
          if (stdout.trim()) {
            parsed = JSON.parse(stdout.trim());
          }
        } catch (_) {}
        resolve({ code, stdout, stderr, data: parsed, ...(parsed || {}) });
      });
      child.on('error', err => reject(err));
    });
  }

  return {
    runtimeCommand,

    getIntent(service) {
      const file = getIntentFile(service);
      if (!fs.existsSync(file)) return null;
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return null;
      }
    },

    clearIntent(service, expectedOperationId) {
      const file = getIntentFile(service);
      if (!fs.existsSync(file)) return false;
      try {
        if (expectedOperationId) {
          const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (stored?.operationId !== expectedOperationId) return false;
        }
        fs.unlinkSync(file);
        return true;
      } catch {
        return false;
      }
    },

    async inspect(service, options = {}) {
      const file = getProcessFile(service);
      let stored = null;
      if (fs.existsSync(file)) {
        try {
          stored = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (_) {}
      }

      if (stored?.pid) {
        try {
          const res = await executeHelper('Inspect', { ProcessId: stored.pid });
          const parsed = res.data || res;

          if (parsed?.running) {
            return {
              running: true,
              pid: parsed.processId || stored.pid,
              executablePath: parsed.executablePath || stored.executablePath || stored.executable,
              executable: parsed.executablePath || stored.executablePath || stored.executable,
              startTime: parsed.creationDate || stored.startTime || stored.startedAt,
              startedAt: parsed.creationDate || stored.startedAt || stored.startTime,
              creationTimeFileTime: parsed.creationTimeFileTime || stored.creationTimeFileTime,
              localPort: parsed.localPort || stored.localPort || null,
              healthURL: parsed.healthURL || stored.healthURL || null,
              operationId: stored.operationId,
              managed: true,
              service
            };
          }
        } catch (err) {
          if (err instanceof SwitchFault) throw err;
        }
      }

      // Check for matched external process by known exact executable path AND service-specific profile/config identity
      const candidateExe = options?.executablePath || paths?.tunnelClientBin || (process.platform === 'win32' ? path.join(process.env.USERPROFILE || '', '.openai-tunnel', 'tunnel-client.exe') : null);
      const expectedProfile = options?.profileName || (service === 'overleaf-mcp' ? 'overleaf' : (service === 'antigravity-mcp' ? 'antigravity-local' : (service === 'mcp_dsh_chatgpt_bridge' ? 'dsh-bridge' : (options?.definition?.profileName || service || null))));
      const expectedConfig = options?.configPath || (service === 'overleaf-mcp' ? 'overleaf.yaml' : (service === 'antigravity-mcp' ? 'antigravity-local.yaml' : (service === 'mcp_dsh_chatgpt_bridge' ? 'dsh-bridge.yaml' : (options?.definition?.locations?.effectiveConfigPath ? path.basename(options.definition.locations.effectiveConfigPath) : (service ? `${service}.yaml` : null)))));

      if (candidateExe && (fs.existsSync(candidateExe) || typeof runtimeCommand === 'function')) {
        if (!expectedProfile && !expectedConfig) {
          // If only same exe is known without service identity, do not attach an unrelated process
          return {
            running: false,
            absenceVerified: false,
            pid: stored?.pid || null,
            reasonCode: 'external_process_unobserved',
            service
          };
        }
        try {
          const findParams = { ExpectedExecutablePath: candidateExe };
          if (expectedProfile) {
            findParams.Tag = expectedProfile;
          } else if (expectedConfig) {
            findParams.Tag = expectedConfig;
          }
          const findRes = await executeHelper('FindOwned', findParams);
          const parsed = findRes.data || findRes;
          if (parsed?.running && parsed.pid > 0) {
            return {
              running: true,
              pid: parsed.pid || parsed.processId,
              executablePath: parsed.executablePath || candidateExe,
              executable: parsed.executable || candidateExe,
              startTime: parsed.creationDate || parsed.startTime || parsed.startedAt,
              startedAt: parsed.creationDate || parsed.startedAt || parsed.startTime,
              creationTimeFileTime: parsed.creationTimeFileTime,
              localPort: parsed.localPort || null,
              healthURL: parsed.healthURL || null,
              managed: false,
              external: true,
              service
            };
          }
        } catch (_) {}
      }

      return {
        running: false,
        absenceVerified: true,
        pid: stored?.pid || null,
        operationId: stored?.operationId || null,
        service
      };
    },

    async verify(identity) {
      if (!identity || !identity.pid) {
        return { valid: false, reason: 'INVALID_PROCESS_ID' };
      }
      const expectedExe = identity.executablePath || identity.executable;
      const expectedStart = identity.startTime || identity.startedAt;
      const expectedFt = identity.creationTimeFileTime;

      if (!expectedExe || (!expectedStart && !expectedFt)) {
        return { valid: false, reason: 'MISSING_EXPECTED_IDENTITY' };
      }

      const res = await executeHelper('Verify', {
        ProcessId: identity.pid,
        ExpectedExecutablePath: expectedExe,
        ExpectedStartTime: expectedStart,
        ExpectedCreationTimeFileTime: expectedFt
      });

      const parsed = res.data || res;
      return {
        valid: Boolean(parsed?.valid || (parsed?.success && res.code === 0)),
        reason: parsed?.reason || (res.code === 0 ? 'VALID' : 'VERIFICATION_FAILED'),
        processId: parsed?.processId || identity.pid,
        executablePath: parsed?.executablePath || expectedExe,
        creationDate: parsed?.creationDate || expectedStart,
        creationTimeFileTime: parsed?.creationTimeFileTime || expectedFt
      };
    },

    async stop(identity) {
      if (!identity || !identity.pid || !identity.running) {
        return { stopped: true };
      }

      // Strict process identity check: require executablePath and startTime/startedAt/creationTimeFileTime
      const startTime = identity.startTime || identity.startedAt;
      const executablePath = identity.executablePath || identity.executable;
      const creationTimeFileTime = identity.creationTimeFileTime;

      if (!executablePath || (!startTime && !creationTimeFileTime)) {
        throw new SwitchFault('PROCESS_IDENTITY_MISMATCH');
      }

      const res = await executeHelper('Stop', {
        ProcessId: identity.pid,
        ExpectedExecutablePath: executablePath,
        ExpectedStartTime: startTime,
        ExpectedCreationTimeFileTime: creationTimeFileTime
      });

      if (res.code === 2 || res.error === 'PROCESS_IDENTITY_MISMATCH' || (res.data && res.data.error === 'PROCESS_IDENTITY_MISMATCH')) {
        throw new SwitchFault('PROCESS_IDENTITY_MISMATCH');
      }

      if (res.code !== undefined && res.code !== 0 && !res.stopped) {
        throw new Error(`Process stop failed (code ${res.code}): ${res.stderr || res.stdout || ''}`);
      }

      return { stopped: true };
    },

    async launch({ service, command, args, env, cwd, operationId, replaceEnvironment = true }) {
      fs.mkdirSync(runtimeDir, { recursive: true });

      // The process controller MUST use buildTunnelLaunchEnvironment result verbatim:
      // Complete explicit env must reach controller verbatim whether frozen OR unfrozen;
      // distinguish omitted legacy env from explicit full env, never remerge host/rescrub.
      const safeEnv = (env !== undefined && env !== null)
        ? env
        : buildTunnelLaunchEnvironment({ inheritedEnvironment: buildSafePinnedEnv({}) });

      // Diagnose only safe booleans for actual executable exists/cwd exists/safe OS env presence;
      // distinguish missingcwd vs executable vs env, preserve real transient directory lifetime.
      const cwdExists = Boolean(cwd ? fs.existsSync(cwd) : true);
      const safeOsEnvPresent = Boolean(
        safeEnv && (
          safeEnv.SystemRoot !== undefined ||
          safeEnv.SYSTEMROOT !== undefined ||
          safeEnv.windir !== undefined ||
          safeEnv.WINDIR !== undefined ||
          safeEnv.PATH !== undefined ||
          safeEnv.Path !== undefined
        )
      );

      // Preserve real transient directory lifetime: ensure cwd exists if specified
      if (cwd && !fs.existsSync(cwd)) {
        try {
          fs.mkdirSync(cwd, { recursive: true });
        } catch (_) {}
      }

      let executableExists = false;
      if (typeof command === 'string' && command.trim() !== '') {
        if (path.isAbsolute(command)) {
          executableExists = fs.existsSync(command);
        } else if (cwd && fs.existsSync(path.join(cwd, command))) {
          executableExists = true;
        } else {
          const pathVal = safeEnv.PATH || safeEnv.Path || process.env.PATH || '';
          const pathDirs = pathVal.split(path.delimiter);
          const exts = (process.platform === 'win32')
            ? (safeEnv.PATHEXT || safeEnv.Pathext || process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
            : [''];
          for (const dir of pathDirs) {
            if (!dir) continue;
            for (const ext of exts) {
              const candidate = path.join(dir, command.endsWith(ext) ? command : command + ext);
              if (fs.existsSync(candidate)) {
                executableExists = true;
                break;
              }
            }
            if (executableExists) break;
          }
        }
      }

      if (!executableExists && typeof runtimeCommand !== 'function') {
        const diag = { cwdExists, executableExists: false, safeOsEnvPresent, command, cwd };
        const err = new SwitchFault('EXECUTABLE_NOT_FOUND', `Executable does not exist: ${command}`);
        err.diagnostics = diag;
        throw err;
      }

      // If runtimeCommand is provided, allow test fake hook to handle Launch directly
      if (typeof runtimeCommand === 'function') {
        const fakeLaunch = await executeHelper('Launch', {
          service,
          command,
          args,
          env: safeEnv,
          cwd,
          operationId,
          ExecutablePath: command,
          Arguments: args,
          WorkingDirectory: cwd
        });
        const parsed = fakeLaunch.data || fakeLaunch;
        const identity = {
          running: true,
          pid: parsed.processId || Math.floor(Math.random() * 90000) + 10000,
          executablePath: parsed.executablePath || command,
          executable: parsed.executablePath || command,
          startTime: parsed.creationDate || new Date().toISOString(),
          startedAt: parsed.creationDate || new Date().toISOString(),
          creationDate: parsed.creationDate || new Date().toISOString(),
          creationTimeFileTime: parsed.creationTimeFileTime || '0',
          service,
          command,
          args,
          operationId
        };
        fs.writeFileSync(getProcessFile(service), JSON.stringify(identity, null, 2), 'utf8');
        return identity;
      }

      if (process.platform === 'win32') {
        const payload = {
          executablePath: command,
          arguments: args || [],
          workingDirectory: cwd || null,
          environment: safeEnv,
          hiddenConsole: true
        };
        const envNames = Object.keys(safeEnv);
        if (!Array.isArray(payload.arguments) || payload.arguments.some(value => typeof value !== 'string') ||
            Object.values(safeEnv).some(value => typeof value !== 'string') ||
            new Set(envNames.map(name => name.toUpperCase())).size !== envNames.length ||
            Buffer.byteLength(JSON.stringify(payload), 'utf8') > 262144) {
          throw new SwitchFault('INVALID_LAUNCH_PAYLOAD', 'Native launch requires bounded string arguments and environment');
        }
        // Only the fixed native helper can create a hidden console that stdio
        // backend descendants inherit. windowsHide + detached/NO_WINDOW hides
        // the parent only and lets Go/Python/Node children open new terminals.
        const result = await executeHelper('Launch', { LaunchPayload: payload });
        const launched = result.data || result;
        if (result.code !== 0 || launched.success !== true ||
            !Number.isSafeInteger(launched.processId) || launched.processId <= 0 ||
            typeof launched.executablePath !== 'string' || !launched.executablePath ||
            !Number.isFinite(Date.parse(launched.creationDate)) ||
            !/^[1-9][0-9]*$/.test(String(launched.creationTimeFileTime || ''))) {
          throw new SwitchFault('PROCESS_LAUNCH_UNCONFIRMED', 'Native handle-bound process identity was not confirmed');
        }
        const identity = {
          running: true,
          pid: launched.processId,
          processId: launched.processId,
          executablePath: launched.executablePath,
          executable: launched.executablePath,
          startTime: launched.creationDate,
          startedAt: launched.creationDate,
          creationDate: launched.creationDate,
          creationTimeFileTime: launched.creationTimeFileTime,
          consoleMode: 'hidden-inherited',
          service, command, args, operationId
        };
        fs.writeFileSync(getProcessFile(service), JSON.stringify(identity, null, 2), 'utf8');
        return identity;
      }

      const spawnStartedIso = new Date().toISOString();
      let spawnError = null;
      const child = spawn(command, args || [], {
        cwd: cwd || undefined,
        env: safeEnv,
        detached: true,
        windowsHide: true,
        stdio: 'ignore'
      });
      child.on('error', (err) => {
        spawnError = err;
      });
      child.unref();

      // Bounded wait to catch immediate spawn failure
      await new Promise(r => setTimeout(r, 60));
      if (spawnError) {
        const diag = {
          cwdExists: cwd ? fs.existsSync(cwd) : true,
          executableExists,
          safeOsEnvPresent,
          error: spawnError.message
        };
        const err = new SwitchFault('SPAWN_FAILED', `Process spawn failed: ${spawnError.message}`);
        err.cause = spawnError;
        err.diagnostics = diag;
        throw err;
      }

      // Inspect newly launched process using audited helper if available
      let verifiedExe = command;
      let verifiedStart = spawnStartedIso;
      let verifiedFt = '0';
      let verifiedLocalPort = null;
      let verifiedHealthURL = null;

      if (scriptPath && fs.existsSync(scriptPath)) {
        for (let attempt = 0; attempt < 10; attempt++) {
          try {
            const inspected = await executeHelper('Inspect', { ProcessId: child.pid });
            const p = inspected.data || inspected;
            if (p?.running) {
              verifiedExe = p.executablePath || verifiedExe;
              verifiedStart = p.creationDate || verifiedStart;
              verifiedFt = p.creationTimeFileTime || verifiedFt;
              if (p.localPort) verifiedLocalPort = p.localPort;
              if (p.healthURL) verifiedHealthURL = p.healthURL;
              break;
            }
          } catch (_) {}
          await new Promise(r => setTimeout(r, 30));
        }
      }

      const identity = {
        running: true,
        pid: child.pid,
        processId: child.pid,
        executablePath: verifiedExe,
        executable: verifiedExe,
        startTime: verifiedStart,
        startedAt: verifiedStart,
        creationDate: verifiedStart,
        creationTimeFileTime: verifiedFt,
        ...(verifiedLocalPort ? { localPort: verifiedLocalPort } : {}),
        ...(verifiedHealthURL ? { healthURL: verifiedHealthURL } : {}),
        service,
        command,
        args,
        operationId
      };

      fs.writeFileSync(getProcessFile(service), JSON.stringify(identity, null, 2), 'utf8');
      return identity;
    }
  };
}

class ServiceAdapter {
  constructor({ service, dataDir, processController, probe, paths, healthURL, definition, vault }) {
    this.service = service;
    this.definition = definition || null;
    this.vault = vault || null;
    this.dataDir = dataDir;
    this.processController = processController;
    this.probe = probe;
    this.paths = paths;
    this.healthURL = healthURL || null;

    this.configPath = service === 'overleaf-mcp'
      ? paths.overleafConfigPath
      : service === 'antigravity-mcp'
        ? paths.antigravityConfigPath
        : (paths?.[`${service}ConfigPath`] || definition?.locations?.effectiveConfigPath || (paths?.appData ? path.join(paths.appData, 'tunnel-client', `${service}.yaml`) : path.join(dataDir, 'tunnel-client', `${service}.yaml`)));

    this.envPath = service === 'overleaf-mcp'
      ? paths.overleafEnvPath
      : (paths?.[`${service}EnvPath`] || null);

    this.runtimeDir = path.join(dataDir, 'runtime');
    this.intentPath = path.join(this.runtimeDir, `${this.service}-intent.json`);
    this.processPath = path.join(this.runtimeDir, `${this.service}-process.json`);
  }

  _readCurrentConfigRecord() {
    let yamlContent = '';
    let envContent = '';

    if (fs.existsSync(this.configPath)) {
      yamlContent = fs.readFileSync(this.configPath, 'utf8');
    }
    if (this.envPath && fs.existsSync(this.envPath)) {
      envContent = fs.readFileSync(this.envPath, 'utf8');
    }

    return {
      yaml: yamlContent,
      env: envContent
    };
  }

  _computeFingerprint(record, sealedPacketBytes = null) {
    if (this.definition?.binding?.type === 'http' && sealedPacketBytes) {
      return fingerprintHttpConfiguration(record, sealedPacketBytes);
    }
    return sha256(record);
  }

  _buildLaunchTemplate(credential) {
    const cred = normalizeCredential(credential);
    const command = this.paths?.tunnelClientBin || (process.platform === 'win32' ? 'tunnel-client.exe' : 'tunnel-client');
    let args = [];

    const binaryPrefix = Array.isArray(this.paths?.binaryPrefix)
      ? this.paths.binaryPrefix
      : (this.paths?.binaryPrefix ? [this.paths.binaryPrefix] : []);

    const listenAddr = this.paths?.listenAddr || '127.0.0.1:0';

    if (this.service === 'overleaf-mcp') {
      args = [
        'run',
        '--profile', 'overleaf',
        '--health.listen-addr', listenAddr,
        '--http-proxy', DEFAULT_PROXY,
        '--control-plane.poll-timeout', '10s',
        '--control-plane.initial-poll-timeout', '100ms'
      ];
    } else if (this.service === 'antigravity-mcp') {
      args = [
        'run',
        '--profile', 'antigravity-local',
        '--health.listen-addr', listenAddr,
        '--http-proxy', DEFAULT_PROXY,
        '--control-plane.poll-timeout', '10s',
        '--control-plane.initial-poll-timeout', '100ms'
      ];
      if (cred.organizationId) {
        args.push('--control-plane.organization-id', cred.organizationId);
      }
    } else {
      const profileName = this.definition?.profileName || this.service;
      args = [
        'run',
        '--profile', profileName,
        '--health.listen-addr', listenAddr,
        '--http-proxy', DEFAULT_PROXY,
        '--control-plane.poll-timeout', '10s',
        '--control-plane.initial-poll-timeout', '100ms'
      ];
      if (cred.organizationId) {
        args.push('--control-plane.organization-id', cred.organizationId);
      }
    }

    const customEnv = {};
    if (this.definition?.environment) {
      for (const [name, entry] of Object.entries(this.definition.environment)) {
        if (entry && typeof entry.value === 'string') {
          const upper = name.toUpperCase();
          if (!upper.startsWith('CONTROL_PLANE_')) {
            customEnv[name] = entry.value;
          }
        }
      }
    }

    if (this.paths?.controlPlaneBaseUrl || this.paths?.controlPlaneBaseURL) {
      args.push('--control-plane.base-url', this.paths.controlPlaneBaseUrl || this.paths.controlPlaneBaseURL);
    }
    if (this.paths?.healthUrlFile || this.paths?.healthURLFile) {
      args.push('--health.url-file', this.paths.healthUrlFile || this.paths.healthURLFile);
    }
    if (Array.isArray(this.paths?.extraArgs)) {
      args.push(...this.paths.extraArgs);
    }

    if (binaryPrefix.length > 0) {
      args = [...binaryPrefix, ...args];
    }

    return {
      command,
      args,
      cwd: this.paths?.cwd || this.paths?.tunnelHome || this.paths?.userProfile || process.cwd(),
      proxy: DEFAULT_PROXY,
      serviceMcpEnv: {
        ...customEnv,
        HTTP_PROXY: DEFAULT_PROXY,
        HTTPS_PROXY: DEFAULT_PROXY,
        ALL_PROXY: DEFAULT_PROXY
      },
      healthURL: this.healthURL
    };
  }

  /**
   * Reads current config/runtime (no mutation), computes current fingerprint,
   * stages desired config in memory, validates via static preflight, and returns immutable snapshot.
   */
  async prepare({ operationId, credential, profileId = null }) {
    const cred = normalizeCredential(credential);

    // Strict credential validation: tunnelId and apiKey are required non-empty strings without control characters
    if (!cred.tunnelId || !cred.apiKey || typeof cred.tunnelId !== 'string' || typeof cred.apiKey !== 'string' ||
        /[\x00-\x1f]/.test(cred.tunnelId) || /[\x00-\x1f]/.test(cred.apiKey)) {
      throw new SwitchFault('TARGET_VERIFICATION_UNAVAILABLE');
    }
    if (cred.organizationId && (typeof cred.organizationId !== 'string' || /[\x00-\x1f]/.test(cred.organizationId))) {
      throw new SwitchFault('TARGET_VERIFICATION_UNAVAILABLE');
    }

    const isHttp = this.definition?.binding?.type === 'http';

    // HTTP secret persistence without vault fails BEFORE effects with safe HTTP_VAULT_REQUIRED
    if (isHttp && (!this.vault || typeof this.vault.seal !== 'function' || typeof this.vault.unseal !== 'function')) {
      throw new HttpTransportFault('HTTP_VAULT_REQUIRED');
    }

    // Static preflight check via probe before any filesystem mutations
    if (this.probe) {
      if (typeof this.probe.checkReady === 'function') {
        const ready = await this.probe.checkReady({ service: this.service, credential: cred, operationId,
          binding: this.definition?.binding });
        if (!ready) {
          throw new SwitchFault('TARGET_VERIFICATION_UNAVAILABLE');
        }
      }
    } else {
      throw new SwitchFault('TARGET_VERIFICATION_UNAVAILABLE');
    }

    // Determine current/original runtime state and kind
    let originalRuntime = null;
    if (fs.existsSync(this.processPath)) {
      try {
        originalRuntime = JSON.parse(fs.readFileSync(this.processPath, 'utf8'));
      } catch (_) {}
    }

    let originalKind = 'stdio';
    let originalPacketBytes = null;
    let originalPacket = null;
    let originalPacketPath = null;
    let originalOperationId = originalRuntime?.operationId || null;

    if (originalRuntime?.transportKind === 'http' || originalRuntime?.kind === 'http' || originalRuntime?.packetPath) {
      originalKind = 'http';
      originalPacketPath = originalRuntime.packetPath || (originalOperationId ? getHttpTransportPacketPath(this.dataDir, this.service, originalOperationId) : null);
    } else if (originalOperationId) {
      try {
        const potentialPath = getHttpTransportPacketPath(this.dataDir, this.service, originalOperationId);
        if (fs.existsSync(potentialPath)) {
          originalKind = 'http';
          originalPacketPath = potentialPath;
        }
      } catch (_) {}
    }

    let originalFingerprint;
    const originalConfig = this._readCurrentConfigRecord();

    if (originalKind === 'http') {
      if (!originalPacketPath || !fs.existsSync(originalPacketPath)) {
        throw new HttpTransportFault('HTTP_STATE_UNREADABLE');
      }
      if (!this.vault || typeof this.vault.unseal !== 'function') {
        throw new HttpTransportFault('HTTP_VAULT_REQUIRED');
      }
      try {
        originalPacketBytes = fs.readFileSync(originalPacketPath);
        originalPacket = JSON.parse(originalPacketBytes.toString('utf8'));
        await openHttpTransport(this.vault, originalPacket, { serviceId: this.service, operationId: originalOperationId });
      } catch (err) {
        if (err instanceof HttpTransportFault) throw err;
        throw new HttpTransportFault('HTTP_STATE_UNREADABLE');
      }
      const originalProfileBytes = fs.existsSync(this.configPath) ? fs.readFileSync(this.configPath) : Buffer.from('');
      originalFingerprint = fingerprintHttpConfiguration(originalProfileBytes, originalPacketBytes);
    } else {
      originalFingerprint = this._computeFingerprint(originalConfig);
    }

    // Inspect current process identity
    const originalProcessIdentity = await this.processController.inspect(this.service);
    const launchTemplate = this._buildLaunchTemplate(cred);

    if (isHttp) {
      const desiredPlan = compileHttpTransport(this.definition.binding, { serviceId: this.service, operationId });
      const stored = await persistHttpTransportPacket({
        dataDir: this.dataDir,
        vault: this.vault,
        binding: this.definition.binding,
        context: { serviceId: this.service, operationId },
        desiredPlan
      });
      const desiredPacket = stored.packet;
      const desiredPacketBytes = stored.packetBytes;
      const desiredPacketPath = stored.path;

      const desiredYaml = updateYamlControlPlaneForHttp(
        originalConfig.yaml,
        {
          tunnelId: cred.tunnelId,
          organizationId: cred.organizationId,
          apiKey: 'env:CONTROL_PLANE_API_KEY'
        },
        this.service
      );

      const desiredProfileBytes = Buffer.from(desiredYaml, 'utf8');
      const desiredFingerprint = fingerprintHttpConfiguration(desiredProfileBytes, desiredPacketBytes);

      launchTemplate.isHttp = true;
      launchTemplate.httpPlan = desiredPlan;
      launchTemplate.serviceMcpEnv = { ...desiredPlan.privateEnvironment };

      return {
        operationId,
        service: this.service,
        desiredKind: 'http',
        originalKind,
        originalFingerprint,
        desiredFingerprint,
        originalConfig,
        desiredConfig: {
          yaml: desiredYaml,
          env: ''
        },
        originalProcessIdentity: originalProcessIdentity?.running ? originalProcessIdentity : { running: false },
        launchTemplate,
        credential: {
          tunnelId: cred.tunnelId,
          apiKey: cred.apiKey,
          organizationId: cred.organizationId
        },
        desiredPlan,
        desiredPacket,
        desiredPacketBytes,
        desiredPacketPath,
        originalPacket,
        originalPacketBytes,
        originalPacketPath,
        originalOperationId,
        profileId: profileId || credential?.profileId || originalRuntime?.profileId || null,
        healthURL: this.healthURL
      };
    }

    // Stdio desired configuration
    const desiredYaml = updateYamlControlPlane(
      originalConfig.yaml,
      {
        tunnelId: cred.tunnelId,
        organizationId: cred.organizationId,
        apiKey: 'env:CONTROL_PLANE_API_KEY'
      },
      this.service,
      this.definition
    );

    let desiredEnv = '';
    if (this.envPath) {
      desiredEnv = `TUNNEL_ID=${cred.tunnelId}\nCONTROL_PLANE_API_KEY=${cred.apiKey}\n`;
    }

    const desiredConfig = {
      yaml: desiredYaml,
      env: desiredEnv
    };
    const desiredFingerprint = this._computeFingerprint(desiredConfig);

    return {
      operationId,
      service: this.service,
      desiredKind: 'stdio',
      originalKind,
      originalFingerprint,
      desiredFingerprint,
      originalConfig,
      desiredConfig,
      originalProcessIdentity: originalProcessIdentity?.running ? originalProcessIdentity : { running: false },
      launchTemplate,
      credential: {
        tunnelId: cred.tunnelId,
        apiKey: cred.apiKey,
        organizationId: cred.organizationId
      },
      originalPacket,
      originalPacketBytes,
      originalPacketPath,
      originalOperationId,
      profileId: profileId || credential?.profileId || originalRuntime?.profileId || null,
      healthURL: this.healthURL
    };
  }

  /**
   * CAS check - current config fingerprint must match snapshot.originalFingerprint.
   * If matched, writes desired config, stops old owned process, launches new owned process
   * with safe inherited env pinning and intent write-ahead tagging.
   */
  async applyIfUnchanged({ operationId, snapshot }) {
    if (snapshot.service !== this.service) {
      throw new SwitchFault('SERVICE_MISMATCH');
    }

    // CAS check on current config
    let currentFingerprint;
    if (snapshot.originalKind === 'http') {
      if (!fs.existsSync(this.configPath) || !snapshot.originalPacketPath || !fs.existsSync(snapshot.originalPacketPath)) {
        throw new SwitchFault('CONFIG_DRIFT');
      }
      const curProfileBytes = fs.readFileSync(this.configPath);
      const curPacketBytes = fs.readFileSync(snapshot.originalPacketPath);
      currentFingerprint = fingerprintHttpConfiguration(curProfileBytes, curPacketBytes);
    } else {
      const currentConfig = this._readCurrentConfigRecord();
      currentFingerprint = this._computeFingerprint(currentConfig);
    }

    if (currentFingerprint !== snapshot.originalFingerprint) {
      throw new SwitchFault('CONFIG_DRIFT');
    }

    // Write desired configuration to disk
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, snapshot.desiredConfig.yaml, 'utf8');

    if (this.envPath) {
      if (snapshot.desiredConfig.env) {
        fs.mkdirSync(path.dirname(this.envPath), { recursive: true });
        fs.writeFileSync(this.envPath, snapshot.desiredConfig.env, 'utf8');
      } else if (fs.existsSync(this.envPath)) {
        try { fs.unlinkSync(this.envPath); } catch (_) {}
      }
    }

    // Stop old owned process if one was running
    if (snapshot.originalProcessIdentity?.running) {
      await this.processController.stop(snapshot.originalProcessIdentity);
    }

    // Record launch intent to disk before starting new process
    fs.mkdirSync(this.runtimeDir, { recursive: true });
    const intent = {
      operationId,
      service: this.service,
      state: 'INTENT_LAUNCH',
      createdAt: new Date().toISOString()
    };
    fs.writeFileSync(this.intentPath, JSON.stringify(intent, null, 2), 'utf8');

    // Launch new owned process
    const template = snapshot.launchTemplate || this._buildLaunchTemplate(snapshot.credential);
    let explicitEnv;
    let launchArgs;

    if (snapshot.desiredKind === 'http') {
      const customEnv = {};
      if (this.definition?.environment) {
        for (const [name, entry] of Object.entries(this.definition.environment)) {
          if (entry && typeof entry.value === 'string') {
            const upper = name.toUpperCase();
            if (!upper.startsWith('CONTROL_PLANE_')) {
              customEnv[name] = entry.value;
            }
          }
        }
      }
      const serviceEnv = {
        HTTP_PROXY: DEFAULT_PROXY,
        HTTPS_PROXY: DEFAULT_PROXY,
        ALL_PROXY: DEFAULT_PROXY,
        ...customEnv
      };
      // Build complete child env using GPT-approved buildTunnelLaunchEnvironment:
      // inherited base (safe pinned), service env, CP credentials LAST, httpPlan for MCP vars.
      explicitEnv = buildTunnelLaunchEnvironment({
        inheritedEnvironment: buildSafePinnedEnv({
          ...(this.paths?.appData ? { APPDATA: this.paths.appData } : {}),
          ...(this.paths?.userProfile ? { USERPROFILE: this.paths.userProfile } : {})
        }),
        serviceEnvironment: serviceEnv,
        controlPlaneEnvironment: { CONTROL_PLANE_API_KEY: snapshot.credential.apiKey },
        httpPlan: snapshot.desiredPlan
      });
      launchArgs = [...template.args, ...snapshot.desiredPlan.args];
    } else {
      const customEnv = {};
      if (this.definition?.environment) {
        for (const [name, entry] of Object.entries(this.definition.environment)) {
          if (entry && typeof entry.value === 'string') {
            const upper = name.toUpperCase();
            if (!upper.startsWith('CONTROL_PLANE_')) {
              customEnv[name] = entry.value;
            }
          }
        }
      }
      const serviceEnv = {
        ...customEnv,
        HTTP_PROXY: DEFAULT_PROXY,
        HTTPS_PROXY: DEFAULT_PROXY,
        ALL_PROXY: DEFAULT_PROXY
      };
      // Build complete child env using buildTunnelLaunchEnvironment (stdio path, no httpPlan).
      explicitEnv = buildTunnelLaunchEnvironment({
        inheritedEnvironment: buildSafePinnedEnv({
          ...(this.paths?.appData ? { APPDATA: this.paths.appData } : {}),
          ...(this.paths?.userProfile ? { USERPROFILE: this.paths.userProfile } : {})
        }),
        serviceEnvironment: serviceEnv,
        controlPlaneEnvironment: { CONTROL_PLANE_API_KEY: snapshot.credential.apiKey }
      });
      launchArgs = template.args;
    }

    const newIdentity = await this.processController.launch({
      service: this.service,
      command: template.command,
      args: launchArgs,
      env: explicitEnv,
      cwd: template.cwd,
      operationId
    });

    const nowIso = new Date().toISOString();
    snapshot.launchedAt = newIdentity.startedAt || newIdentity.startTime || nowIso;
    snapshot.identity = newIdentity;

    const record = {
      operationId,
      service: this.service,
      profileId: snapshot.profileId || null,
      transportKind: snapshot.desiredKind,
      ...newIdentity,
      running: true,
      launchedAt: nowIso,
      updatedAt: nowIso
    };
    if (snapshot.desiredKind === 'http') {
      record.packetPath = snapshot.desiredPacketPath;
    }
    fs.writeFileSync(this.processPath, JSON.stringify(record, null, 2), 'utf8');

    // Safe intent cleanup: only delete intent if matching operationId
    try {
      if (fs.existsSync(this.intentPath)) {
        const storedIntent = JSON.parse(fs.readFileSync(this.intentPath, 'utf8'));
        if (storedIntent?.operationId === operationId) {
          fs.unlinkSync(this.intentPath);
        }
      }
    } catch (_) {}

    return record;
  }

  /**
   * Verifies target authenticated tunnel session using real bounded verification
   * through probe wired to the GPT evidence gate.
   * Returns strict verified receipt conforming to switch-core.mjs assertVerifiedReceipt.
   */
  async verifyDesired({ operationId, snapshot }) {
    if (!this.probe) {
      return {
        status: 'TARGET_VERIFICATION_UNAVAILABLE',
        service: this.service,
        verified: false
      };
    }

    const inspected = await this.processController.inspect(this.service);
    const pid = inspected?.pid;
    const startedAt = inspected?.startTime || inspected?.startedAt;
    const executable = inspected?.executablePath || inspected?.executable;
    if (inspected?.running !== true || !Number.isSafeInteger(pid) || pid <= 0 ||
        typeof startedAt !== 'string' || !startedAt ||
        typeof executable !== 'string' || !executable) {
      // Do not invent a PID/start time for an absent or unidentifiable process.
      throw new SwitchFault('VERIFY_FAILED', {reason: 'PROCESS_IDENTITY_UNCONFIRMED'});
    }

    const identity = { pid, startedAt, executable };
    const listenerIdentity = { ...identity };

    let currentConfigFingerprint;
    if (snapshot.desiredKind === 'http') {
      if (!fs.existsSync(this.configPath) || !snapshot.desiredPacketPath || !fs.existsSync(snapshot.desiredPacketPath)) {
        throw new SwitchFault('VERIFY_FAILED', {reason: 'TARGET_CONFIG_UNCONFIRMED'});
      }
      const curProfileBytes = fs.readFileSync(this.configPath);
      const curPacketBytes = fs.readFileSync(snapshot.desiredPacketPath);
      currentConfigFingerprint = fingerprintHttpConfiguration(curProfileBytes, curPacketBytes);
    } else {
      const currentConfig = this._readCurrentConfigRecord();
      currentConfigFingerprint = this._computeFingerprint(currentConfig);
    }

    let probeResult;
    try {
      const explicitHealthURL = this.healthURL || snapshot?.healthURL || null;
      const canPollEphemeral = !explicitHealthURL && Boolean(this.probe?.isDefault) && typeof this.processController?.runtimeCommand !== 'function';
      const maxAttempts = canPollEphemeral ? 120 : 1;
      let curInspected = inspected;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) {
          await new Promise(r => setTimeout(r, 150));
          if (!explicitHealthURL && !curInspected?.healthURL) {
            try {
              curInspected = await this.processController.inspect(this.service);
              if (curInspected?.running && curInspected.pid) {
                identity.pid = curInspected.pid;
                identity.startedAt = curInspected.startTime || curInspected.startedAt || identity.startedAt;
                identity.executable = curInspected.executablePath || curInspected.executable || identity.executable;
                listenerIdentity.pid = identity.pid;
                listenerIdentity.startedAt = identity.startedAt;
                listenerIdentity.executable = identity.executable;
              }
            } catch (_) {}
          }
        }
        const curHealthURL = explicitHealthURL || curInspected?.healthURL || null;
        if (curInspected?.healthURL && this.processPath && fs.existsSync(this.processPath)) {
          try {
            const rec = JSON.parse(fs.readFileSync(this.processPath, 'utf8'));
            if (rec && rec.pid === curInspected.pid && (!rec.healthURL || !rec.localPort)) {
              rec.localPort = curInspected.localPort || rec.localPort || null;
              rec.healthURL = curInspected.healthURL;
              fs.writeFileSync(this.processPath, JSON.stringify(rec, null, 2), 'utf8');
            }
          } catch (_) {}
        }
        if (canPollEphemeral && !curHealthURL && attempt < maxAttempts - 1) {
          continue;
        }
        probeResult = await this.probe.verify({
          operationId,
          service: this.service,
          snapshot,
          identity,
          listenerIdentity,
          currentConfigFingerprint,
          healthURL: curHealthURL,
          controlPlaneBaseURL: snapshot?.controlPlaneBaseURL || this.paths?.controlPlaneBaseURL || this.paths?.controlPlaneBaseUrl || null
        });
        if (probeResult && probeResult.ok !== false && probeResult.verified !== false) {
          break;
        }
      }
      if (!probeResult || probeResult.ok === false || probeResult.verified !== true) {
        throw new SwitchFault('VERIFY_FAILED', {reason: probeResult?.code || probeResult?.error});
      }
    } catch (err) {
      if (err instanceof SwitchFault) throw err;
      throw new SwitchFault('VERIFY_FAILED');
    }

    return {
      verified: true,
      operationId,
      service: this.service,
      configFingerprint: snapshot.desiredFingerprint,
      identity: probeResult.identity || identity,
      proof: probeResult.proof || { kind: 'authenticated-control-plane' }
    };
  }

  /**
   * Idempotent restoration with safe intent and tag recovery.
   * Returns strict restored receipt conforming to switch-core.mjs assertRestoredReceipt.
   */
  async restoreIfOwned({ operationId, snapshot, step }) {
    if (snapshot.service !== this.service) {
      throw new SwitchFault('SERVICE_MISMATCH');
    }

    let currentFingerprint;
    if (snapshot.desiredKind === 'http' && fs.existsSync(this.configPath) && snapshot.desiredPacketPath && fs.existsSync(snapshot.desiredPacketPath)) {
      const curProfileBytes = fs.readFileSync(this.configPath);
      const curPacketBytes = fs.readFileSync(snapshot.desiredPacketPath);
      const fp = fingerprintHttpConfiguration(curProfileBytes, curPacketBytes);
      if (fp === snapshot.desiredFingerprint) {
        currentFingerprint = fp;
      }
    }

    if (!currentFingerprint && snapshot.originalKind === 'http' && fs.existsSync(this.configPath) && snapshot.originalPacketPath && fs.existsSync(snapshot.originalPacketPath)) {
      const curProfileBytes = fs.readFileSync(this.configPath);
      const curPacketBytes = fs.readFileSync(snapshot.originalPacketPath);
      const fp = fingerprintHttpConfiguration(curProfileBytes, curPacketBytes);
      if (fp === snapshot.originalFingerprint) {
        currentFingerprint = fp;
      }
    }

    if (!currentFingerprint) {
      const currentConfig = this._readCurrentConfigRecord();
      currentFingerprint = this._computeFingerprint(currentConfig);
    }

    // Drift check: current must match either desiredFingerprint or originalFingerprint
    if (currentFingerprint !== snapshot.desiredFingerprint && currentFingerprint !== snapshot.originalFingerprint) {
      throw new SwitchFault('CONFIG_DRIFT');
    }

    // Restore original configuration if desired config was applied
    if (currentFingerprint === snapshot.desiredFingerprint) {
      if (snapshot.originalConfig?.yaml) {
        fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
        fs.writeFileSync(this.configPath, snapshot.originalConfig.yaml, 'utf8');
      } else if (fs.existsSync(this.configPath)) {
        fs.unlinkSync(this.configPath);
      }

      if (this.envPath) {
        if (snapshot.originalConfig?.env) {
          fs.writeFileSync(this.envPath, snapshot.originalConfig.env, 'utf8');
        } else if (fs.existsSync(this.envPath)) {
          fs.unlinkSync(this.envPath);
        }
      }
    }

    // Safe process restoration & tag recovery:
    // 1. If a process was launched and tagged with operationId, stop it
    if (fs.existsSync(this.processPath)) {
      try {
        const currentProc = JSON.parse(fs.readFileSync(this.processPath, 'utf8'));
        if (currentProc?.operationId === operationId && currentProc.running) {
          await this.processController.stop(currentProc);
          fs.unlinkSync(this.processPath);
        }
      } catch (_) {}
    }

    // 2. Safe intent recovery: if intent exists matching operationId, clean it up
    if (fs.existsSync(this.intentPath)) {
      try {
        const storedIntent = JSON.parse(fs.readFileSync(this.intentPath, 'utf8'));
        if (storedIntent?.operationId === operationId) {
          fs.unlinkSync(this.intentPath);
        }
      } catch (_) {}
    }

    // 3. If original process was running prior to this operation, restart it
    if (snapshot.originalProcessIdentity?.running) {
      const active = await this.processController.inspect(this.service);
      if (!active?.running) {
        const template = snapshot.launchTemplate || this._buildLaunchTemplate(snapshot.credential);
        let restoredEnv;
        let restoredArgs;

        if (snapshot.originalKind === 'http') {
          if (!snapshot.originalPacket || !this.vault) {
            throw new HttpTransportFault('HTTP_STATE_UNREADABLE');
          }
          const origPlan = await openHttpTransport(this.vault, snapshot.originalPacket, {
            serviceId: this.service,
            operationId: snapshot.originalOperationId
          });

          // Build complete restored env using buildTunnelLaunchEnvironment (HTTP path).
          const cpEnv = {};
          if (snapshot.credential?.apiKey) cpEnv.CONTROL_PLANE_API_KEY = snapshot.credential.apiKey;
          restoredEnv = buildTunnelLaunchEnvironment({
            inheritedEnvironment: buildSafePinnedEnv({
              ...(this.paths?.appData ? { APPDATA: this.paths.appData } : {}),
              ...(this.paths?.userProfile ? { USERPROFILE: this.paths.userProfile } : {})
            }),
            serviceEnvironment: {
              HTTP_PROXY: DEFAULT_PROXY,
              HTTPS_PROXY: DEFAULT_PROXY,
              ALL_PROXY: DEFAULT_PROXY
            },
            controlPlaneEnvironment: cpEnv,
            httpPlan: origPlan
          });
          restoredArgs = [...template.args.filter(a => !a.startsWith('--mcp.extra-headers')), ...origPlan.args];
        } else {
          // Build complete restored env using buildTunnelLaunchEnvironment (stdio path).
          const restoredServiceEnv = {
            ...template.serviceMcpEnv,
            HTTP_PROXY: DEFAULT_PROXY,
            HTTPS_PROXY: DEFAULT_PROXY,
            ALL_PROXY: DEFAULT_PROXY
          };
          const cpEnv = {};
          if (snapshot.credential?.apiKey) cpEnv.CONTROL_PLANE_API_KEY = snapshot.credential.apiKey;
          restoredEnv = buildTunnelLaunchEnvironment({
            inheritedEnvironment: buildSafePinnedEnv({
              ...(this.paths?.appData ? { APPDATA: this.paths.appData } : {}),
              ...(this.paths?.userProfile ? { USERPROFILE: this.paths.userProfile } : {})
            }),
            serviceEnvironment: restoredServiceEnv,
            controlPlaneEnvironment: cpEnv
          });
          restoredArgs = template.args;
        }

        const restarted = await this.processController.launch({
          service: this.service,
          command: template.command,
          args: restoredArgs,
          env: restoredEnv,
          cwd: template.cwd,
          operationId: `${operationId}-restored`
        });

        const record = {
          operationId: `${operationId}-restored`,
          service: this.service,
          transportKind: snapshot.originalKind,
          ...restarted,
          running: true,
          restoredAt: new Date().toISOString()
        };
        if (snapshot.originalKind === 'http') {
          record.packetPath = snapshot.originalPacketPath;
        }
        fs.writeFileSync(this.processPath, JSON.stringify(record, null, 2), 'utf8');
      }
    }

    return {
      restored: true,
      runtimeRestored: true,
      operationId,
      service: this.service,
      configFingerprint: snapshot.originalFingerprint
    };
  }

  /**
   * Returns safe public status object without secrets or private configuration.
   */
  async describe() {
    const configExists = fs.existsSync(this.configPath);
    let parsed = {};
    if (configExists) {
      try {
        const raw = fs.readFileSync(this.configPath, 'utf8');
        parsed = parseYamlControlPlane(raw);
      } catch (_) {}
    }

    let processInfo = null;
    try {
      const inspected = await this.processController.inspect(this.service);
      if (inspected?.running) {
        processInfo = {
          pid: inspected.pid,
          executablePath: inspected.executablePath || inspected.executable,
          startTime: inspected.startTime || inspected.startedAt
        };
      }
    } catch (_) {}

    return {
      service: this.service,
      configured: configExists && Boolean(parsed.tunnelId),
      running: Boolean(processInfo),
      process: processInfo,
      config: {
        tunnelId: maskTunnelId(parsed.tunnelId),
        hasApiKey: Boolean(parsed.apiKey),
        organizationId: parsed.organizationId || null,
        proxy: DEFAULT_PROXY,
        configPath: this.configPath
      }
    };
  }

  /**
   * Stops only console-owned process matching exact handle identity.
   * Rejects unmanaged/unknown processes without killing.
   * Returns receipt conforming to assertStoppedConnectionReceipt from ../core/mcp-registry-policy.mjs:
   * proof: { kind: 'verified-owned-process-exit' } or proof: { kind: 'verified-already-stopped' }.
   * Cleans up recorded process file upon successful stop.
   */
  async stopConnection({ operationId, serviceId, originalRuntime } = {}) {
    const targetService = serviceId || this.service;
    if (targetService !== this.service) {
      throw new SwitchFault('SERVICE_MISMATCH');
    }
    if (!isMcpServiceId(this.service)) {
      throw new SwitchFault('INVALID_TARGETS');
    }
    if (!operationId || typeof operationId !== 'string') {
      throw new SwitchFault('INVALID_TARGETS');
    }

    // 1. Read recorded process file if it exists
    let recordedProc = null;
    if (fs.existsSync(this.processPath)) {
      try {
        recordedProc = JSON.parse(fs.readFileSync(this.processPath, 'utf8'));
      } catch (_) {
        recordedProc = null;
      }
    }

    // 2. Inspect active process via process controller
    const inspected = await this.processController.inspect(this.service);

    // Case A: Process is already stopped (not running)
    if (!inspected?.running) {
      // Clean up stale process file if one exists
      if (fs.existsSync(this.processPath)) {
        try { fs.unlinkSync(this.processPath); } catch (_) {}
      }
      if (fs.existsSync(this.intentPath)) {
        try {
          const intent = JSON.parse(fs.readFileSync(this.intentPath, 'utf8'));
          if (intent?.operationId === operationId) fs.unlinkSync(this.intentPath);
        } catch (_) {}
      }

      const receipt = {
        stopped: true,
        operationId,
        service: this.service,
        proof: {
          kind: 'verified-already-stopped'
        }
      };
      assertStoppedConnectionReceipt(receipt, operationId, this.service);
      return receipt;
    }

    // Case B: Process IS running.
    // Console must own this process. If there is no valid console process record,
    // or if PIDs do not match, it is an unmanaged/foreign process: reject without killing!
    if (!recordedProc || !Number.isSafeInteger(recordedProc.pid) || recordedProc.pid <= 0) {
      throw new SwitchFault('PROCESS_IDENTITY_MISMATCH');
    }

    if (inspected.pid !== recordedProc.pid) {
      throw new SwitchFault('PROCESS_IDENTITY_MISMATCH');
    }

    // If originalRuntime identity is specified, ensure it matches console record
    const origPid = originalRuntime?.identity?.pid || originalRuntime?.pid;
    if (origPid && origPid !== recordedProc.pid) {
      throw new SwitchFault('PROCESS_IDENTITY_MISMATCH');
    }

    // Verify handle identity using process controller
    if (typeof this.processController.verify === 'function') {
      const verifyRes = await this.processController.verify(recordedProc);
      if (!verifyRes?.valid) {
        throw new SwitchFault('PROCESS_IDENTITY_MISMATCH');
      }
    }

    // Stop verified owned process
    await this.processController.stop(recordedProc);

    // Confirm process is no longer running
    const postInspect = await this.processController.inspect(this.service);
    if (postInspect?.running) {
      throw new SwitchFault('STOP_UNCONFIRMED');
    }

    // Clean up recorded process file upon successful stop
    if (fs.existsSync(this.processPath)) {
      try { fs.unlinkSync(this.processPath); } catch (_) {}
    }
    if (fs.existsSync(this.intentPath)) {
      try {
        const intent = JSON.parse(fs.readFileSync(this.intentPath, 'utf8'));
        if (intent?.operationId === operationId) fs.unlinkSync(this.intentPath);
      } catch (_) {}
    }

    const receipt = {
      stopped: true,
      operationId,
      service: this.service,
      proof: {
        kind: 'verified-owned-process-exit'
      },
      identity: {
        pid: recordedProc.pid,
        startedAt: recordedProc.startedAt || recordedProc.startTime || inspected.startedAt || inspected.startTime,
        executable: recordedProc.executablePath || recordedProc.executable || inspected.executablePath || inspected.executable
      }
    };

    assertStoppedConnectionReceipt(receipt, operationId, this.service);
    return receipt;
  }
}

/**
 * Factory for service adapters.
 * Exports createAdapters({definitions?, dataDir, processController?, probe?, paths?, healthURL?, healthURLs?, runtimeCommand?})
 * -> {'overleaf-mcp': adapter, 'antigravity-mcp': adapter} or custom definitions
 */
export function createAdapters(options = {}) {
  const dataDir = options.dataDir || path.join(process.env.LOCALAPPDATA || userProfilePath('AppData', 'Local'), 'McpTunnelAccountManager');
  const userProfile = options.paths?.userProfile || process.env.USERPROFILE || userProfilePath();
  const appData = options.paths?.appData || process.env.APPDATA || path.join(userProfile, 'AppData', 'Roaming');
  const tunnelHome = options.paths?.tunnelHome || path.join(userProfile, '.openai-tunnel');

  const resolvedPaths = {
    userProfile,
    appData,
    tunnelHome,
    tunnelClientBin: path.join(tunnelHome, 'tunnel-client.exe'),
    overleafConfigPath: path.join(appData, 'tunnel-client', 'overleaf.yaml'),
    antigravityConfigPath: path.join(appData, 'tunnel-client', 'antigravity-local.yaml'),
    overleafEnvPath: path.join(tunnelHome, 'tunnel.env'),
    overleafHealthURL: options.paths?.overleafHealthURL || options.healthURLs?.['overleaf-mcp'] || options.healthURL || null,
    antigravityHealthURL: options.paths?.antigravityHealthURL || options.healthURLs?.['antigravity-mcp'] || options.healthURL || null,
    ...options.paths
  };

  const scriptPath = options.scriptPath || fileURLToPath(new URL('../../scripts/process-control.ps1', import.meta.url));
  const processController = options.processController || createDefaultProcessController({
    dataDir,
    scriptPath,
    runtimeCommand: options.runtimeCommand,
    paths: resolvedPaths
  });

  const probe = options.probe !== undefined ? options.probe : defaultTunnelProbe;

  if (Array.isArray(options.definitions)) {
    const adapters = {};
    for (const def of options.definitions) {
      if (!def?.id) continue;
      const serviceId = def.id;
      const healthURL = options.healthURLs?.[serviceId] ||
        options.paths?.[`${serviceId}HealthURL`] ||
        (serviceId === 'overleaf-mcp' ? resolvedPaths.overleafHealthURL :
         serviceId === 'antigravity-mcp' ? resolvedPaths.antigravityHealthURL :
         options.healthURL || null);

      adapters[serviceId] = new ServiceAdapter({
        service: serviceId,
        definition: def,
        vault: options?.vault || null,
        dataDir,
        processController,
        probe,
        paths: resolvedPaths,
        healthURL
      });
    }
    return adapters;
  }

  const overleaf = new ServiceAdapter({
    service: 'overleaf-mcp',
    vault: options?.vault || null,
    dataDir,
    processController,
    probe,
    paths: resolvedPaths,
    healthURL: resolvedPaths.overleafHealthURL
  });

  const antigravity = new ServiceAdapter({
    service: 'antigravity-mcp',
    vault: options?.vault || null,
    dataDir,
    processController,
    probe,
    paths: resolvedPaths,
    healthURL: resolvedPaths.antigravityHealthURL
  });

  return {
    'overleaf-mcp': overleaf,
    'antigravity-mcp': antigravity
  };
}

export { createRegisteredAdapterProvider } from './registry-provider.mjs';

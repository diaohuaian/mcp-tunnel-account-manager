#!/usr/bin/env node
/**
 * Exact protocol fake daemon simulating `tunnel-client.exe` (version 0.0.19, schema_version 1).
 *
 * Implements the full contract required by evaluateTunnelEvidence in tunnel-health-evidence.mjs:
 * - /health?details=true: returns schema_version 1, live: true, ready: true,
 *   runtime (version: 0.0.19, instance_id, started_at, lifecycle: 'running'),
 *   control-plane component (status, state, details with consecutive_failures, http_status, last_success).
 * - /api/status: returns version 0.0.19, client_instance_id, control_plane_tunnel_id,
 *   control_plane_base_url, started_at.
 *
 * Simulates:
 * - Accepted key & target: polls mock control plane -> 200 OK -> healthy evidence
 * - Wrong key: polls mock control plane -> 401 Unauthorized -> degraded status, consecutive_failures >= 1, http_status=401
 * - Wrong target: reports mismatched control_plane_tunnel_id
 * - Wrong status instance: reports mismatched client_instance_id between /health and /api/status
 * - Graceful shutdown and process identity compatibility with Win32 helper.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const SUPPORTED_TUNNEL_VERSION = '0.0.19';

export function parseDaemonArgs(argv) {
  const args = {
    profile: 'overleaf',
    listenAddr: '127.0.0.1:0',
    proxy: null,
    pollTimeout: '10s',
    initialPollTimeout: '10s',
    orgId: null,
    baseUrl: process.env.CONTROL_PLANE_BASE_URL || process.env.MOCK_CONTROL_PLANE_URL || null,
    tunnelId: process.env.MOCK_TUNNEL_TUNNEL_ID || null,
    mode: process.env.MOCK_TUNNEL_MODE || 'normal',
    instanceId: process.env.MOCK_TUNNEL_INSTANCE_ID || null,
    portFile: process.env.MOCK_PORT_FILE || null,
    status: false,
    exitAfter: null,
    extraHeaders: [],
    mcpServerUrl: process.env.MCP_SERVER_URL || null
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'run') {
      // Subcommand passed by ServiceAdapter._buildLaunchTemplate
      continue;
    } else if (a === '--status') {
      args.status = true;
    } else if (a === '--profile' && i + 1 < argv.length) {
      args.profile = argv[++i];
    } else if (a === '--health.listen-addr' && i + 1 < argv.length) {
      args.listenAddr = argv[++i];
    } else if (a === '--http-proxy' && i + 1 < argv.length) {
      args.proxy = argv[++i];
    } else if (a === '--control-plane.poll-timeout' && i + 1 < argv.length) {
      args.pollTimeout = argv[++i];
    } else if (a === '--control-plane.initial-poll-timeout' && i + 1 < argv.length) {
      args.initialPollTimeout = argv[++i];
    } else if (a === '--control-plane.organization-id' && i + 1 < argv.length) {
      args.orgId = argv[++i];
    } else if (a === '--control-plane.base-url' && i + 1 < argv.length) {
      args.baseUrl = argv[++i];
    } else if (a === '--mode' && i + 1 < argv.length) {
      args.mode = argv[++i];
    } else if (a === '--instance-id' && i + 1 < argv.length) {
      args.instanceId = argv[++i];
    } else if (a === '--tunnel-id' && i + 1 < argv.length) {
      args.tunnelId = argv[++i];
    } else if (a === '--port-file' && i + 1 < argv.length) {
      args.portFile = argv[++i];
    } else if (a === '--exit-after' && i + 1 < argv.length) {
      args.exitAfter = parseInt(argv[++i], 10);
    } else if (a === '--mcp.server-url' && i + 1 < argv.length) {
      args.mcpServerUrl = argv[++i];
    } else if (a.startsWith('--mcp.server-url=')) {
      args.mcpServerUrl = a.slice(17);
    } else if (a === '--mcp.extra-headers' && i + 1 < argv.length) {
      args.extraHeaders.push(argv[++i]);
    } else if (a.startsWith('--mcp.extra-headers=')) {
      args.extraHeaders.push(a.slice(20));
    }
  }

  return args;
}

function readConfigYaml(profile) {
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:/Users/fixture-user', 'AppData', 'Roaming');
  const yamlPath = path.join(appData, 'tunnel-client', `${profile}.yaml`);
  if (!fs.existsSync(yamlPath)) return {};
  try {
    const content = fs.readFileSync(yamlPath, 'utf8');
    const tMatch = content.match(/^\s*tunnel_id:\s*["']?([^"'\r\n]+)["']?\s*(#.*)?$/m);
    const bMatch = content.match(/^\s*base_url:\s*["']?([^"'\r\n]+)["']?\s*(#.*)?$/m);
    const oMatch = content.match(/^\s*organization_id:\s*["']?([^"'\r\n]+)["']?\s*(#.*)?$/m);
    return {
      tunnelId: tMatch ? tMatch[1].trim() : null,
      baseUrl: bMatch ? bMatch[1].trim() : null,
      organizationId: oMatch ? oMatch[1].trim() : null
    };
  } catch (_) {
    return {};
  }
}

export function startFakeTunnelDaemon(config = {}) {
  const startedAt = config.startedAt || new Date().toISOString();
  const instanceId = config.instanceId || `tunnel-inst-${process.pid}-${Date.now()}`;
  const profile = config.profile || 'overleaf';

  const cfg = readConfigYaml(profile);
  const tunnelId = config.tunnelId || cfg.tunnelId || 'synthetic-tunnel';
  const controlPlaneBaseUrl = config.baseUrl || cfg.baseUrl || 'https://api.openai.com';
  const apiKey = config.apiKey || process.env.CONTROL_PLANE_API_KEY || '';
  const mode = config.mode || 'normal';
  const mcpServerUrl = config.mcpServerUrl || config.serverUrl || process.env.MCP_SERVER_URL || null;
  const extraHeaders = [
    ...(Array.isArray(config.extraHeaders) ? config.extraHeaders : []),
    ...(Array.isArray(config.args?.extraHeaders) ? config.args.extraHeaders : [])
  ];
  if (process.env.MCP_EXTRA_HEADERS) {
    extraHeaders.push(process.env.MCP_EXTRA_HEADERS);
  }

  let lastMcpResponse = null;
  let mcpHealthy = true;

  function resolveHeaderReference(entry, env = process.env) {
    if (!entry || typeof entry !== 'string') return null;
    const colonIdx = entry.indexOf(':');
    if (colonIdx === -1) return null;
    const name = entry.slice(0, colonIdx).trim();
    const rawValue = entry.slice(colonIdx + 1).trim();
    let value = rawValue;
    if (rawValue.startsWith('env:')) {
      const envVar = rawValue.slice(4).trim();
      value = (config.env && config.env[envVar] !== undefined)
        ? config.env[envVar]
        : (env[envVar] ?? '');
    } else if (rawValue.startsWith('file:')) {
      const filePath = rawValue.slice(5).trim();
      try {
        value = fs.readFileSync(filePath, 'utf8').trim();
      } catch (_) {
        value = '';
      }
    }
    return { name, value };
  }

  async function forwardToHttpMcp() {
    if (!mcpServerUrl) return null;
    const resolvedHeaders = {};
    for (const entry of extraHeaders) {
      const resolved = resolveHeaderReference(entry, config.env || process.env);
      if (resolved && resolved.name) {
        resolvedHeaders[resolved.name] = resolved.value;
      }
    }

    if (config.headers && typeof config.headers === 'object') {
      for (const [k, v] of Object.entries(config.headers)) {
        resolvedHeaders[k] = typeof v === 'string' ? v : (v?.value ?? '');
      }
    }

    try {
      const parsedUrl = new URL(mcpServerUrl);
      return await new Promise((resolve) => {
        const req = http.request({
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || 80,
          path: parsedUrl.pathname + parsedUrl.search,
          method: config.httpMethod || 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': `tunnel-client/${SUPPORTED_TUNNEL_VERSION}`,
            ...resolvedHeaders
          },
          timeout: 2000
        }, (res) => {
          let body = '';
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => {
            mcpHealthy = res.statusCode < 400;
            lastMcpResponse = {
              statusCode: res.statusCode,
              headers: res.headers,
              body,
              forwardedUrl: mcpServerUrl,
              forwardedHeaders: resolvedHeaders,
              timestamp: new Date().toISOString()
            };
            resolve(lastMcpResponse);
          });
        });

        req.on('error', (err) => {
          mcpHealthy = false;
          lastMcpResponse = {
            error: err.message,
            forwardedUrl: mcpServerUrl,
            forwardedHeaders: resolvedHeaders,
            timestamp: new Date().toISOString()
          };
          resolve(lastMcpResponse);
        });

        req.on('timeout', () => {
          req.destroy();
          mcpHealthy = false;
          lastMcpResponse = {
            error: 'TIMEOUT',
            forwardedUrl: mcpServerUrl,
            forwardedHeaders: resolvedHeaders,
            timestamp: new Date().toISOString()
          };
          resolve(lastMcpResponse);
        });

        req.write(JSON.stringify({
          jsonrpc: '2.0',
          method: 'initialize',
          params: { client: 'tunnel-client', version: SUPPORTED_TUNNEL_VERSION },
          id: 1
        }));
        req.end();
      });
    } catch (err) {
      mcpHealthy = false;
      lastMcpResponse = {
        error: err.message,
        forwardedUrl: mcpServerUrl,
        forwardedHeaders: resolvedHeaders,
        timestamp: new Date().toISOString()
      };
      return lastMcpResponse;
    }
  }

  let isHealthy = (mode !== 'wrong_key' && mode !== 'unhealthy' && !apiKey.includes('wrong') && !apiKey.includes('invalid'));
  let consecutiveFailures = isHealthy ? 0 : 1;
  let httpStatus = isHealthy ? 0 : 401;
  let failureCategory = isHealthy ? '' : 'unauthorized';
  let lastSuccess = isHealthy ? new Date().toISOString() : null;
  let lastError = isHealthy ? null : new Date().toISOString();
  let server = null;
  let pollInterval = null;

  async function pollControlPlane() {
    if (!controlPlaneBaseUrl || controlPlaneBaseUrl.includes('api.openai.com')) {
      // Offline / synthetic default mode
      if (mode === 'wrong_key' || apiKey.includes('wrong') || apiKey.includes('invalid')) {
        isHealthy = false;
        consecutiveFailures = 1;
        httpStatus = 401;
        failureCategory = 'unauthorized';
        lastError = new Date().toISOString();
      } else {
        isHealthy = true;
        consecutiveFailures = 0;
        httpStatus = 0;
        failureCategory = '';
        lastSuccess = new Date().toISOString();
      }
      return { isHealthy, httpStatus };
    }

    // Active HTTP poll to mock control plane
    try {
      const parsedUrl = new URL(controlPlaneBaseUrl);
      const pollUrl = new URL('/v1/tunnel', controlPlaneBaseUrl);
      pollUrl.searchParams.set('tunnel_id', tunnelId);

      const status = await new Promise((resolve) => {
        const req = http.request({
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || 80,
          path: pollUrl.pathname + pollUrl.search,
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'X-Tunnel-Id': tunnelId,
            'Accept': 'application/json'
          },
          timeout: 2000
        }, (res) => {
          res.resume();
          resolve(res.statusCode);
        });

        req.on('error', () => resolve(503));
        req.on('timeout', () => { req.destroy(); resolve(504); });
        req.end();
      });

      if (status >= 200 && status < 300) {
        isHealthy = true;
        consecutiveFailures = 0;
        httpStatus = 0;
        failureCategory = '';
        lastSuccess = new Date().toISOString();
      } else {
        isHealthy = false;
        consecutiveFailures = 1;
        httpStatus = status;
        failureCategory = (status === 401) ? 'unauthorized' : 'poll_failed';
        lastError = new Date().toISOString();
      }
    } catch (_) {
      isHealthy = false;
      consecutiveFailures = 1;
      httpStatus = 503;
      failureCategory = 'unreachable';
      lastError = new Date().toISOString();
    }

    return { isHealthy, httpStatus };
  }

  function handleRequest(req, res) {
    const parsed = new URL(req.url, 'http://127.0.0.1');

    if (parsed.pathname === '/health') {
      const now = new Date().toISOString();
      const payload = {
        schema_version: 1,
        live: true,
        ready: true,
        truncated: false,
        snapshot_at: now,
        runtime: {
          limited: false,
          lifecycle: 'running',
          version: SUPPORTED_TUNNEL_VERSION,
          instance_id: instanceId,
          started_at: startedAt
        },
        components: {
          'control-plane': {
            status: isHealthy ? 'ok' : 'degraded',
            limited: false,
            state: isHealthy ? 'polling' : 'backoff',
            observed_at: now,
            details: {
              consecutive_failures: consecutiveFailures,
              http_status: httpStatus,
              failure_category: failureCategory,
              deadline_seconds: 15,
              last_success: lastSuccess || startedAt,
              last_error: lastError || undefined,
              current_poll_age_seconds: 1
            }
          }
        }
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
      return;
    }

    if (parsed.pathname === '/api/status') {
      const clientInstanceId = (mode === 'wrong_instance')
        ? `mismatched-inst-${Date.now()}`
        : instanceId;
      const reportedTunnelId = (mode === 'wrong_target')
        ? 'wrong-target-tunnel-mismatch'
        : tunnelId;

      const payload = {
        version: SUPPORTED_TUNNEL_VERSION,
        client_instance_id: clientInstanceId,
        control_plane_tunnel_id: reportedTunnelId,
        control_plane_base_url: controlPlaneBaseUrl,
        started_at: startedAt
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
      return;
    }

    if (parsed.pathname === '/mcp-forwarded' || parsed.pathname === '/api/mcp-status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(lastMcpResponse || { forwarded: false }));
      return;
    }

    if (parsed.pathname === '/health-port' || parsed.pathname === '/port') {
      const addr = server.address();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ port: addr.port }));
      return;
    }

    if (parsed.pathname === '/quit' || parsed.pathname === '/kill') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, stopping: true }));
      setImmediate(() => {
        close();
        process.exit(0);
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  }

  function close() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
    if (server) {
      return new Promise((resolve) => {
        server.close(() => {
          server = null;
          resolve();
        });
      });
    }
    return Promise.resolve();
  }

  return {
    async start(host = '127.0.0.1', port = 0) {
      // Initial control plane poll before opening listen port
      await pollControlPlane();

      // Forward to synthetic HTTP MCP endpoint if in HTTP mode
      if (mcpServerUrl) {
        await forwardToHttpMcp();
      }

      return new Promise((resolve, reject) => {
        server = http.createServer(handleRequest);
        server.listen(port, host, () => {
          const addr = server.address();
          const actualPort = addr.port;
          const url = `http://${host}:${actualPort}`;

          // Periodic background poll every 1s
          pollInterval = setInterval(() => {
            pollControlPlane().catch(() => {});
          }, 1000);
          pollInterval.unref();

          resolve({
            port: actualPort,
            url,
            instanceId,
            tunnelId,
            controlPlaneBaseUrl,
            startedAt,
            close,
            pollControlPlane
          });
        });
        server.on('error', reject);
      });
    },

    pollControlPlane,
    forwardToHttpMcp,
    getLastMcpResponse: () => lastMcpResponse,
    getForwardedMcp: () => lastMcpResponse,
    setHealthy(healthy) {
      isHealthy = Boolean(healthy);
      if (isHealthy) {
        consecutiveFailures = 0;
        httpStatus = 0;
        failureCategory = '';
        lastSuccess = new Date().toISOString();
      } else {
        consecutiveFailures = 1;
        httpStatus = 401;
        failureCategory = 'unauthorized';
        lastError = new Date().toISOString();
      }
    },
    close
  };
}

export async function runDaemonCli(argv = process.argv) {
  const args = parseDaemonArgs(argv);

  if (args.status) {
    const statusOutput = {
      client: 'fake-tunnel-health',
      version: SUPPORTED_TUNNEL_VERSION,
      pid: process.pid,
      status: 'ONLINE',
      profile: args.profile,
      timestamp: new Date().toISOString()
    };
    process.stdout.write(JSON.stringify(statusOutput, null, 2) + '\n');
    process.exit(0);
  }

  let host = '127.0.0.1';
  let port = 0;
  if (args.listenAddr) {
    const parts = args.listenAddr.split(':');
    if (parts.length === 2) {
      host = parts[0] || '127.0.0.1';
      port = parseInt(parts[1], 10) || 0;
    }
  }

  const daemon = startFakeTunnelDaemon({
    profile: args.profile,
    baseUrl: args.baseUrl,
    tunnelId: args.tunnelId,
    mode: args.mode,
    instanceId: args.instanceId,
    mcpServerUrl: args.mcpServerUrl,
    extraHeaders: args.extraHeaders
  });

  const running = await daemon.start(host, port);
  console.log(`[fake-tunnel-health] Listening on ${running.url} (pid: ${process.pid})`);
  console.log(`FAKE_TUNNEL_PORT=${running.port}`);

  if (args.portFile) {
    try {
      fs.mkdirSync(path.dirname(args.portFile), { recursive: true });
      fs.writeFileSync(args.portFile, String(running.port), 'utf8');
    } catch (_) {}
  }

  const cleanup = async () => {
    console.log('[fake-tunnel-health] Stopping daemon...');
    await daemon.close();
    if (args.portFile && fs.existsSync(args.portFile)) {
      try { fs.unlinkSync(args.portFile); } catch (_) {}
    }
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  if (args.exitAfter && args.exitAfter > 0) {
    setTimeout(cleanup, args.exitAfter).unref();
  }

  return running;
}

// Standalone CLI execution
if (process.argv[1] && (
  import.meta.url === pathToFileURL(process.argv[1]).href ||
  process.argv[1].endsWith('run') ||
  process.argv[1].endsWith('run.js') ||
  process.argv.includes('run')
)) {
  await runDaemonCli(process.argv);
}

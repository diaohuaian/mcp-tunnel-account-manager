#!/usr/bin/env node
/**
 * Fixture: Default Manager Registered HTTP Tunnel Daemon Simulator
 *
 * Implements the protocol contract for Default Manager registered HTTP tunnels:
 * 1. Windows Launch Protocol (-LaunchPayloadFromStdin):
 *    - Reads bounded raw UTF-8 JSON on standard input (limit: 262144 bytes).
 *    - Validates payload structure: { executablePath, arguments, workingDirectory, environment }.
 * 2. CLI Arguments & Environment handling:
 *    - run, --profile, --tunnel-id, --control-plane.base-url, --health.listen-addr, --port-file,
 *      --mcp.server-url, --mcp.extra-headers, --status, --exit-after.
 *    - Environment: MCP_SERVER_URL, MCP_HEADER_*, CONTROL_PLANE_BASE_URL, CONTROL_PLANE_API_KEY.
 * 3. Health & Status endpoints:
 *    - /health?details=true (schema_version: 1, runtime, control-plane component)
 *    - /api/status (client_instance_id, control_plane_tunnel_id, control_plane_base_url, version: 0.0.19)
 *    - /inspect (debug inspection of payload, headers, environment, and forward history)
 * 4. Upstream HTTP MCP communication:
 *    - Forwards requests to MCP_SERVER_URL with resolved headers (handling env: references).
 *    - Records forwarded requests and responses for assertions.
 * 5. Lifecycle & Process Control:
 *    - Supports --status inspection returning verified metadata.
 *    - Clean shutdown via SIGINT, SIGTERM, stdin command, or close().
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const SUPPORTED_TUNNEL_VERSION = '0.0.19';
export const MAX_PAYLOAD_BYTES = 262144;

/**
 * Bounded UTF-8 standard input reader for Windows launch protocol (-LaunchPayloadFromStdin).
 */
export async function readStdinLaunchPayload(limitBytes = MAX_PAYLOAD_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let exceeded = false;

    function onData(chunk) {
      totalBytes += chunk.length;
      if (totalBytes > limitBytes) {
        exceeded = true;
        cleanup();
        reject(new Error(`Launch payload exceeded max size limit of ${limitBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    }

    function onEnd() {
      if (exceeded) return;
      cleanup();
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) {
          throw new TypeError('Launch payload must be a JSON object');
        }
        resolve(parsed);
      } catch (err) {
        reject(new Error(`Failed to parse stdin launch payload: ${err.message}`));
      }
    }

    function onError(err) {
      cleanup();
      reject(err);
    }

    function cleanup() {
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('error', onError);
    }

    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onError);

    if (process.stdin.readableEnded) {
      onEnd();
    }
  });
}

/**
 * Parses daemon command line arguments and environment overrides.
 */
export function parseDaemonArgs(argv = process.argv) {
  const args = {
    action: 'run',
    profile: 'mcp-default-http',
    listenAddr: '127.0.0.1:0',
    proxy: null,
    pollTimeout: '10s',
    initialPollTimeout: '10s',
    orgId: null,
    baseUrl: process.env.CONTROL_PLANE_BASE_URL || process.env.MOCK_CONTROL_PLANE_URL || null,
    tunnelId: process.env.MOCK_TUNNEL_TUNNEL_ID || null,
    mode: process.env.MOCK_TUNNEL_MODE || 'normal',
    instanceId: process.env.MOCK_TUNNEL_INSTANCE_ID || null,
    portFile: process.env.MOCK_PORT_FILE || process.env.PORT_FILE || null,
    status: false,
    exitAfter: null,
    extraHeaders: [],
    mcpServerUrl: process.env.MCP_SERVER_URL || null,
    useStdinPayload: false
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'run') {
      args.action = 'run';
    } else if (a === '--status') {
      args.status = true;
    } else if (a === '-LaunchPayloadFromStdin' || a === '--launch-payload-from-stdin') {
      args.useStdinPayload = true;
    } else if (a === '--profile' && i + 1 < argv.length) {
      args.profile = argv[++i];
    } else if (a.startsWith('--profile=')) {
      args.profile = a.slice(10);
    } else if (a === '--health.listen-addr' && i + 1 < argv.length) {
      args.listenAddr = argv[++i];
    } else if (a.startsWith('--health.listen-addr=')) {
      args.listenAddr = a.slice(21);
    } else if (a === '--http-proxy' && i + 1 < argv.length) {
      args.proxy = argv[++i];
    } else if (a === '--control-plane.organization-id' && i + 1 < argv.length) {
      args.orgId = argv[++i];
    } else if (a === '--control-plane.base-url' && i + 1 < argv.length) {
      args.baseUrl = argv[++i];
    } else if (a.startsWith('--control-plane.base-url=')) {
      args.baseUrl = a.slice(25);
    } else if (a === '--mode' && i + 1 < argv.length) {
      args.mode = argv[++i];
    } else if (a === '--instance-id' && i + 1 < argv.length) {
      args.instanceId = argv[++i];
    } else if (a === '--tunnel-id' && i + 1 < argv.length) {
      args.tunnelId = argv[++i];
    } else if (a.startsWith('--tunnel-id=')) {
      args.tunnelId = a.slice(12);
    } else if (a === '--port-file' && i + 1 < argv.length) {
      args.portFile = argv[++i];
    } else if (a.startsWith('--port-file=')) {
      args.portFile = a.slice(12);
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

  if ((!args.tunnelId || !args.baseUrl) && args.profile && process.env.APPDATA) {
    const yamlPath = path.join(process.env.APPDATA, 'tunnel-client', `${args.profile}.yaml`);
    if (fs.existsSync(yamlPath)) {
      try {
        const content = fs.readFileSync(yamlPath, 'utf8');
        if (!args.tunnelId) {
          const m = content.match(/tunnel[_-]id\s*:\s*["']?([^"'\r\n]+)/i);
          if (m) args.tunnelId = m[1].trim();
        }
        if (!args.baseUrl) {
          const m = content.match(/base[_-]url\s*:\s*["']?([^"'\r\n]+)/i);
          if (m) args.baseUrl = m[1].trim();
        }
      } catch (_) {}
    }
  }

  return args;
}

/**
 * Resolves header strings that may contain `env:VAR_NAME` references against an environment map.
 */
export function resolveHeaderDirectives(headerDirectives = [], env = process.env) {
  const headers = {};
  for (const item of headerDirectives) {
    if (!item) continue;
    const colonIdx = item.indexOf(':');
    const eqIdx = item.indexOf('=');
    let sepIdx = -1;
    if (colonIdx !== -1 && eqIdx !== -1) {
      sepIdx = Math.min(colonIdx, eqIdx);
    } else if (colonIdx !== -1) {
      sepIdx = colonIdx;
    } else {
      sepIdx = eqIdx;
    }
    if (sepIdx === -1) continue;
    const name = item.slice(0, sepIdx).trim();
    let val = item.slice(sepIdx + 1).trim();
    if (val.startsWith('env:')) {
      const envKey = val.slice(4).trim();
      val = env[envKey] !== undefined ? env[envKey] : '';
    }
    headers[name.toLowerCase()] = val;
  }
  return headers;
}

/**
 * Creates and starts a fake HTTP tunnel daemon suitable for Default Manager registered HTTP testing.
 */
export function startDefaultManagerHttpDaemon(options = {}) {
  const instanceId = options.instanceId || `inst-${crypto.randomBytes(6).toString('hex')}`;
  const profile = options.profile || 'mcp-default-http';
  let baseUrl = options.baseUrl || 'https://api.openai.com';
  let tunnelId = options.tunnelId || 'tunnel-default-001';
  let mcpServerUrl = options.mcpServerUrl || null;
  const extraHeaders = [...(options.extraHeaders || [])];
  const activeEnv = { ...process.env, ...(options.env || {}) };

  // Read MCP_SERVER_URL from env if not explicitly provided
  if (!mcpServerUrl && activeEnv.MCP_SERVER_URL) {
    mcpServerUrl = activeEnv.MCP_SERVER_URL;
  }

  // Read MCP_HEADER_* from env
  for (const [key, val] of Object.entries(activeEnv)) {
    if (key.startsWith('MCP_HEADER_')) {
      const headerName = key.slice(11).replace(/_/g, '-').toLowerCase();
      extraHeaders.push(`${headerName}=${val}`);
    }
  }

  const startedAt = new Date().toISOString();
  let isHealthy = options.mode !== 'unauthorized' && options.mode !== 'auth_error';
  let consecutiveFailures = isHealthy ? 0 : 1;
  let httpStatus = isHealthy ? 0 : 401;
  let failureCategory = isHealthy ? '' : 'unauthorized';
  let lastSuccess = isHealthy ? startedAt : null;
  let lastError = isHealthy ? null : startedAt;
  const forwardedRequests = [];
  let server = null;
  let pollInterval = null;
  const openSockets = new Set();

  async function forwardToHttpMcp(payload = { method: 'POST', path: '', body: '' }) {
    if (!mcpServerUrl) return null;
    return new Promise((resolve) => {
      try {
        const target = new URL(payload.path || '', mcpServerUrl);
        const resolved = resolveHeaderDirectives(extraHeaders, activeEnv);
        const reqHeaders = {
          'Content-Type': 'application/json',
          'User-Agent': `default-manager-http-tunnel/${SUPPORTED_TUNNEL_VERSION}`,
          ...resolved
        };

        const postBody = typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body || {});
        reqHeaders['Content-Length'] = Buffer.byteLength(postBody);

        const req = http.request(
          target,
          {
            method: payload.method || 'POST',
            headers: reqHeaders,
            timeout: 5000
          },
          (res) => {
            let resData = '';
            res.on('data', c => { resData += c; });
            res.on('end', () => {
              const record = {
                timestamp: new Date().toISOString(),
                status: res.statusCode,
                url: target.href,
                sentHeaders: reqHeaders,
                responseBody: resData
              };
              forwardedRequests.push(record);
              resolve(record);
            });
          }
        );

        req.on('error', (err) => {
          const errRecord = {
            timestamp: new Date().toISOString(),
            status: 0,
            url: target.href,
            sentHeaders: reqHeaders,
            error: err.message
          };
          forwardedRequests.push(errRecord);
          resolve(errRecord);
        });

        if (postBody) req.write(postBody);
        req.end();
      } catch (err) {
        resolve({ error: err.message });
      }
    });
  }

  async function pollControlPlane() {
    if (!baseUrl || baseUrl.startsWith('mock:')) return;
    try {
      const parsedUrl = new URL(baseUrl);
      const pollUrl = new URL('/v1/tunnel', baseUrl);
      if (tunnelId) pollUrl.searchParams.set('tunnel_id', tunnelId);

      const status = await new Promise((resolve) => {
        const req = http.request(
          {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || 80,
            path: pollUrl.pathname + pollUrl.search,
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${activeEnv.CONTROL_PLANE_API_KEY || ''}`,
              'X-Tunnel-Id': tunnelId || '',
              'Accept': 'application/json'
            },
            timeout: 2000
          },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          }
        );
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
        failureCategory = status === 401 ? 'unauthorized' : 'poll_failed';
        lastError = new Date().toISOString();
      }
    } catch (_) {
      isHealthy = false;
      consecutiveFailures = 1;
      httpStatus = 503;
      failureCategory = 'unreachable';
      lastError = new Date().toISOString();
    }
  }

  function handleHttpRequest(req, res) {
    const parsed = new URL(req.url, 'http://127.0.0.1');

    if (parsed.pathname === '/health') {
      const details = parsed.searchParams.get('details') === 'true';
      const now = new Date().toISOString();
      const body = {
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
              http_status: isHealthy ? 0 : httpStatus,
              failure_category: failureCategory,
              deadline_seconds: 15,
              last_success: isHealthy ? now : (lastSuccess || startedAt),
              last_error: lastError || undefined,
              current_poll_age_seconds: 1
            }
          }
        }
      };
      res.writeHead(isHealthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body, null, 2));
      return;
    }

    if (parsed.pathname === '/api/status') {
      const body = {
        version: SUPPORTED_TUNNEL_VERSION,
        client_instance_id: instanceId,
        control_plane_tunnel_id: tunnelId,
        control_plane_base_url: baseUrl,
        started_at: startedAt
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body, null, 2));
      return;
    }

    if (parsed.pathname === '/inspect') {
      const body = {
        instanceId,
        tunnelId,
        baseUrl,
        mcpServerUrl,
        extraHeaders,
        resolvedHeaders: resolveHeaderDirectives(extraHeaders, activeEnv),
        chosenControlPlaneApiKey: activeEnv.CONTROL_PLANE_API_KEY || null,
        controlPlaneApiKey: activeEnv.CONTROL_PLANE_API_KEY || null,
        forwardedRequests,
        options: {
          profile,
          mode: options.mode
        }
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body, null, 2));
      return;
    }

    if (parsed.pathname === '/forward' && req.method === 'POST') {
      let reqBody = '';
      req.on('data', c => { reqBody += c; });
      req.on('end', async () => {
        try {
          const payload = reqBody ? JSON.parse(reqBody) : {};
          const forwardRes = await forwardToHttpMcp(payload);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(forwardRes || {}));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    if (parsed.pathname === '/stop' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ stopped: true }));
      setImmediate(() => close());
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'NOT_FOUND' }));
  }

  async function close() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
    for (const s of openSockets) {
      try { s.destroy(); } catch (_) {}
    }
    openSockets.clear();

    if (server) {
      return new Promise((resolve) => {
        server.close(() => {
          server = null;
          resolve();
        });
      });
    }
  }

  return {
    instanceId,
    profile,
    get tunnelId() { return tunnelId; },
    set tunnelId(v) { tunnelId = v; },
    get baseUrl() { return baseUrl; },
    set baseUrl(v) { baseUrl = v; },
    get mcpServerUrl() { return mcpServerUrl; },
    set mcpServerUrl(v) { mcpServerUrl = v; },
    extraHeaders,
    activeEnv,
    forwardedRequests,
    forwardToHttpMcp,
    pollControlPlane,
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
    close,
    async start(host = '127.0.0.1', port = 0) {
      return new Promise((resolve, reject) => {
        server = http.createServer(handleHttpRequest);
        server.on('connection', s => {
          openSockets.add(s);
          s.on('close', () => openSockets.delete(s));
        });

        server.listen(port, host, async () => {
          const addr = server.address();
          const actualPort = typeof addr === 'object' && addr ? addr.port : port;
          const url = `http://${host}:${actualPort}`;

          // Perform initial poll if mock control plane URL provided
          await pollControlPlane();

          // If MCP server URL is configured, trigger initial synthetic query
          if (mcpServerUrl) {
            await forwardToHttpMcp({ method: 'POST', body: { jsonrpc: '2.0', method: 'initialize', id: 1 } });
          }

          resolve({
            port: actualPort,
            url,
            instanceId,
            tunnelId,
            startedAt,
            close,
            forwardToHttpMcp,
            pollControlPlane
          });
        });

        server.on('error', reject);
      });
    }
  };
}

/**
 * CLI execution handler for standalone process execution.
 */
export async function runDaemonCli(argv = process.argv) {
  const args = parseDaemonArgs(argv);

  // Status check short-circuit
  if (args.status) {
    const statusOutput = {
      client: 'default-manager-http-tunnel',
      version: SUPPORTED_TUNNEL_VERSION,
      pid: process.pid,
      status: 'ONLINE',
      profile: args.profile,
      timestamp: new Date().toISOString()
    };
    process.stdout.write(JSON.stringify(statusOutput, null, 2) + '\n');
    process.exit(0);
  }

  let launchPayload = null;
  if (args.useStdinPayload) {
    try {
      launchPayload = await readStdinLaunchPayload();
      if (launchPayload?.environment) {
        Object.assign(process.env, launchPayload.environment);
      }
      if (launchPayload?.arguments && Array.isArray(launchPayload.arguments)) {
        const subArgs = parseDaemonArgs(['node', 'default-manager-http-tunnel.mjs', ...launchPayload.arguments]);
        Object.assign(args, subArgs);
      }
    } catch (err) {
      console.error(`[default-manager-http-tunnel] Stdin payload error: ${err.message}`);
      process.exit(1);
    }
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

  const daemon = startDefaultManagerHttpDaemon({
    profile: args.profile,
    baseUrl: args.baseUrl,
    tunnelId: args.tunnelId,
    mode: args.mode,
    instanceId: args.instanceId,
    mcpServerUrl: args.mcpServerUrl,
    extraHeaders: args.extraHeaders,
    env: launchPayload?.environment || {}
  });

  const running = await daemon.start(host, port);
  console.log(`[default-manager-http-tunnel] Listening on ${running.url} (pid: ${process.pid})`);
  console.log(`FAKE_TUNNEL_PORT=${running.port}`);

  if (args.portFile) {
    try {
      fs.mkdirSync(path.dirname(args.portFile), { recursive: true });
      fs.writeFileSync(args.portFile, String(running.port), 'utf8');
    } catch (_) {}
  }

  const cleanup = async () => {
    console.log('[default-manager-http-tunnel] Stopping daemon cleanly...');
    await daemon.close();
    if (args.portFile && fs.existsSync(args.portFile)) {
      try { fs.unlinkSync(args.portFile); } catch (_) {}
    }
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  if (process.stdin.isTTY === false && !args.useStdinPayload) {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      const text = chunk.trim().toLowerCase();
      if (text === 'quit' || text === 'exit' || text === 'stop') {
        cleanup();
      }
    });
  }

  if (args.exitAfter && args.exitAfter > 0) {
    setTimeout(cleanup, args.exitAfter).unref();
  }

  return running;
}

// Standalone execution trigger
if (process.argv[1] && (
  import.meta.url === pathToFileURL(process.argv[1]).href ||
  process.argv[1].endsWith('default-manager-http-tunnel.mjs')
)) {
  await runDaemonCli(process.argv);
}

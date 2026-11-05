#!/usr/bin/env node
/**
 * Standalone mock script simulating `tunnel-client.exe` behaviors for integration tests.
 *
 * Supports:
 * - Arguments: --account <id>, --port <p>, --server <s>, --token <t>, --status, --exit-after <ms>, --delay <ms>, --fail <reason>
 * - Environment variables: MOCK_TUNNEL_MODE, MOCK_TUNNEL_ACCOUNT, MOCK_TUNNEL_PORT, MOCK_TUNNEL_TOKEN
 * - Signals: SIGINT, SIGTERM graceful cleanup
 * - Status reports and heartbeat logging
 */

import process from 'node:process';

function parseArgs(argv) {
  const args = {
    account: process.env.MOCK_TUNNEL_ACCOUNT || 'mock-account',
    port: process.env.MOCK_TUNNEL_PORT || '8080',
    server: process.env.MOCK_TUNNEL_SERVER || 'wss://tunnel.mock.local',
    token: process.env.MOCK_TUNNEL_TOKEN || 'mock-token',
    mode: process.env.MOCK_TUNNEL_MODE || 'normal',
    status: false,
    delay: 50,
    exitAfter: null,
    fail: null
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--status') {
      args.status = true;
    } else if (arg === '--account' || arg === '-a') {
      args.account = argv[++i];
    } else if (arg === '--port' || arg === '-p') {
      args.port = argv[++i];
    } else if (arg === '--server' || arg === '-s') {
      args.server = argv[++i];
    } else if (arg === '--token' || arg === '-t') {
      args.token = argv[++i];
    } else if (arg === '--mode') {
      args.mode = argv[++i];
    } else if (arg === '--delay') {
      args.delay = parseInt(argv[++i], 10);
    } else if (arg === '--exit-after') {
      args.exitAfter = parseInt(argv[++i], 10);
    } else if (arg === '--fail') {
      args.fail = argv[++i];
    }
  }

  return args;
}

const args = parseArgs(process.argv);

// Handle --status request
if (args.status) {
  const statusOutput = {
    client: 'fake-tunnel',
    pid: process.pid,
    status: 'ONLINE',
    account: args.account,
    port: Number(args.port),
    server: args.server,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  };
  process.stdout.write(JSON.stringify(statusOutput, null, 2) + '\n');
  process.exit(0);
}

// Log startup information
console.log(`[fake-tunnel] Initializing mock tunnel client (pid: ${process.pid})...`);
console.log(`[fake-tunnel] Server endpoint : ${args.server}`);
console.log(`[fake-tunnel] Account identity: ${args.account}`);
console.log(`[fake-tunnel] Local port     : ${args.port}`);

// Simulate failure modes
if (args.fail || args.mode === 'auth_error' || args.token === 'invalid') {
  console.error(`[fake-tunnel] [ERROR] Tunnel authorization rejected: ${args.fail || 'invalid or expired token'}`);
  process.exit(1);
}

if (args.mode === 'port_in_use') {
  console.error(`[fake-tunnel] [ERROR] Bind failed: port ${args.port} is already in use`);
  process.exit(1);
}

if (args.mode === 'crash') {
  console.log('[fake-tunnel] Mode is crash; crashing in 200ms...');
  setTimeout(() => {
    console.error('[fake-tunnel] FATAL: Unexpected panic in native tunnel worker thread');
    process.exit(2);
  }, 200);
}

let heartbeatTimer = null;
let seq = 0;

function cleanup(signal = 'EXIT') {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  console.log(`[fake-tunnel] Received signal ${signal}. Closing tunnel connections...`);
  console.log('[fake-tunnel] Tunnel closed. Exiting cleanly.');
  process.exit(0);
}

process.on('SIGINT', () => cleanup('SIGINT'));
process.on('SIGTERM', () => cleanup('SIGTERM'));

// Listen for stdin commands if connected to a pipe
if (process.stdin.isTTY === false) {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    const text = chunk.trim().toLowerCase();
    if (text === 'quit' || text === 'exit' || text === 'stop') {
      cleanup('STDIN_COMMAND');
    }
  });
}

// Startup connection sequence
setTimeout(() => {
  console.log('[fake-tunnel] Handshake completed with tunnel server.');
  console.log(`[fake-tunnel] Tunnel ready and listening on port ${args.port}.`);
  console.log('[fake-tunnel] STATUS: CONNECTED');

  // Start periodic heartbeat
  heartbeatTimer = setInterval(() => {
    seq++;
    console.log(`[fake-tunnel] [HEARTBEAT] ping ok (seq: ${seq}, account: ${args.account})`);
  }, 1000);
  heartbeatTimer.unref();

  if (args.exitAfter && args.exitAfter > 0) {
    setTimeout(() => {
      console.log(`[fake-tunnel] Auto-exit timer expired (${args.exitAfter}ms).`);
      cleanup('TIMER');
    }, args.exitAfter);
  }
}, args.delay);

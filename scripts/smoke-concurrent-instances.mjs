#!/usr/bin/env node
/**
 * Isolated demo: TWO concurrent accounts for ONE MCP service, on port 17644.
 *
 * Contract: docs/analysis/concurrent-instances-contract.md §6
 *
 * What this proves
 *   1. Two different profiles of the SAME service can run at the same time,
 *      each with its own tunnel process, its own ephemeral loopback port and its
 *      own composite instanceId.
 *   2. Stopping ONE account leaves the sibling running with the same pid.
 *   3. Production is untouched: the `(pid, CreationTimeFileTime)` list of every
 *      pre-existing `tunnel-client.exe` and the pid listening on 17642 are
 *      snapshotted before and after the run, and the run FAILS LOUDLY if they
 *      differ.
 *
 * Isolation rules enforced here
 *   - console port 17644 (never 17642/17643, which are the release and dev console ports);
 *   - data dir  %LOCALAPPDATA%\McpTunnelAccountManager-dev\...  (never the
 *     production ...\McpTunnelAccountManager) or a --data-dir override;
 *   - profile base %TEMP%\mcp-dev-profiles;
 *   - APPDATA for every spawned child is redirected inside the temp tree, so the
 *     fixture never reads %APPDATA%\tunnel-client\*.yaml;
 *   - tunnel processes are the FAKE daemon in tests/fixtures/fake-tunnel-health.mjs.
 *     The real tunnel-client.exe is never executed.
 *
 * Process safety
 *   - Every tunnel process is a child handle this script spawned itself, and is
 *     stopped with `child.kill()` on that exact handle (never by process name).
 *   - The production snapshot is READ-ONLY: Get-CimInstance + Get-NetTCPConnection.
 *   - A post-run check asserts none of the spawned pids survive.
 *
 * Output: human-readable log on stderr, and exactly one machine-readable JSON
 * object as the LAST line on stdout.
 *
 *   {"port":17644,"dataDir":"...","instances":[{"instanceId":"...","pid":N,
 *     "state":"running","localPort":N},...],"bothRunning":true,
 *     "stopIsolated":true,"prodUntouched":true}
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { startManager } from '../src/main.mjs';
import { openStore } from '../src/store.mjs';
import { createVault } from '../src/vault.mjs';
import {
  createInstanceAdapterProvider,
  instanceProfileDirPath
} from '../src/adapters/instance-adapter.mjs';
import { buildInstanceId } from '../src/core/concurrent-instances.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_DAEMON = path.join(PROJECT_ROOT, 'tests', 'fixtures', 'fake-tunnel-health.mjs');
const PROCESS_CONTROL = path.join(PROJECT_ROOT, 'scripts', 'process-control.ps1');

const CONSOLE_PORT = 17644;
const PRODUCTION_CONSOLE_PORT = 17642;

/**
 * Default demo port. Overridable with `--port <n>` because 17644 is a shared dev port:
 * on a machine where another console already holds it, the run would abort at the
 * fail-fast probe and this acceptance command could not be executed at all. The
 * production port is still refused in every case (see below).
 */
function resolveConsolePort(options) {
  const raw = options?.port;
  if (raw === undefined || raw === null) return CONSOLE_PORT;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`--port must be a valid TCP port, got '${raw}'`);
  }
  if (parsed === PRODUCTION_CONSOLE_PORT) {
    throw new Error(`--port ${parsed} is the production console port; the demo must never use it`);
  }
  return parsed;
}

const SERVICE_ID = 'mcp_instancesvc';
const PROFILE_A = 'userA';
const PROFILE_B = 'userB';
const POWERSHELL = 'powershell';

const log = (...args) => console.error('[smoke]', ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Production snapshot (READ-ONLY)
// ---------------------------------------------------------------------------

const SNAPSHOT_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$procs = @(
  Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" |
    ForEach-Object {
      [pscustomobject]@{
        pid = [int]$_.ProcessId
        creationTimeFileTime = ([datetime]$_.CreationDate).ToFileTimeUtc().ToString()
      }
    } |
    Sort-Object pid
)
$listeners = @(
  Get-NetTCPConnection -LocalPort ${PRODUCTION_CONSOLE_PORT} -State Listen |
    ForEach-Object { [int]$_.OwningProcess } |
    Sort-Object -Unique
)
[pscustomobject]@{ tunnelClients = @($procs); portListeners = @($listeners) } |
  ConvertTo-Json -Compress -Depth 6
`;

/**
 * Reads production state without mutating anything.
 * @returns {{tunnelClients: Array<{pid:number, creationTimeFileTime:string}>, portListeners: number[]}}
 */
function snapshotProduction(label) {
  const result = spawnSync(
    POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SNAPSHOT_SCRIPT],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000 }
  );
  if (result.error) throw new Error(`production snapshot failed (${label}): ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`production snapshot failed (${label}): exit ${result.status} ${String(result.stderr || '').slice(0, 400)}`);
  }
  const raw = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
  if (!raw) throw new Error(`production snapshot returned no data (${label})`);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`production snapshot was not JSON (${label}): ${raw.slice(0, 200)}`);
  }
  const asArray = (value) => (Array.isArray(value) ? value : (value === null || value === undefined ? [] : [value]));
  return {
    tunnelClients: asArray(parsed.tunnelClients)
      .filter((entry) => entry && Number.isSafeInteger(entry.pid) && entry.pid > 0)
      .map((entry) => ({ pid: entry.pid, creationTimeFileTime: String(entry.creationTimeFileTime ?? '') }))
      .sort((a, b) => a.pid - b.pid),
    portListeners: asArray(parsed.portListeners)
      .map(Number)
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
      .sort((a, b) => a - b)
  };
}

function snapshotSignature(snapshot) {
  return JSON.stringify({
    tunnelClients: snapshot.tunnelClients.map((entry) => `${entry.pid}:${entry.creationTimeFileTime}`),
    portListeners: snapshot.portListeners
  });
}

// ---------------------------------------------------------------------------
// Fake tunnel runtime (per-instance child processes we own)
// ---------------------------------------------------------------------------

/**
 * Backs `createInstanceAdapterProvider({runtimeCommand})`: every audited helper
 * action is answered from processes THIS script spawned, so no real tunnel binary
 * and no by-name process control is ever involved.
 */
function createFakeRuntime({ scratchDir, childEnv }) {
  const tracked = new Map(); // instanceId -> { pid, child, executablePath, creationTimeFileTime, portFile, healthUrlFile, localPort }
  const allChildren = new Set();

  function readPortFile(file, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const raw = fs.readFileSync(file, 'utf8').trim();
        const port = Number.parseInt(raw, 10);
        if (Number.isSafeInteger(port) && port > 0 && port <= 65535) return port;
      } catch (_) { /* not written yet */ }
      if (Date.now() >= deadline) return null;
      spawnSync(POWERSHELL, ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 60'], { windowsHide: true });
    }
  }

  /** Reads the REAL handle-bound identity of a pid we just spawned. */
  function auditedIdentity(pid) {
    const result = spawnSync(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PROCESS_CONTROL,
        '-Action', 'Inspect', '-ProcessId', String(pid)],
      { encoding: 'utf8', windowsHide: true, timeout: 60_000 }
    );
    if (result.status !== 0) return null;
    try {
      const parsed = JSON.parse(String(result.stdout || '').trim());
      if (!parsed || parsed.running !== true) return null;
      return {
        executablePath: parsed.executablePath || null,
        creationTimeFileTime: String(parsed.creationTimeFileTime || '')
      };
    } catch (_) {
      return null;
    }
  }

  function findInstanceId(args) {
    const profileArgIndex = args.indexOf('--profile');
    const profileName = profileArgIndex >= 0 ? String(args[profileArgIndex + 1] || '') : '';
    for (const [instanceId, record] of tracked) {
      if (record.profileName && record.profileName === profileName) return instanceId;
      if (instanceId.endsWith(`__${profileName.replace(/^.*_profile_/, '')}`)) return instanceId;
    }
    return null;
  }

  function isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (_) {
      return false;
    }
  }

  async function runtimeCommand(action, params = {}) {
    if (action === 'Launch') {
      const args = (Array.isArray(params.args) ? params.args : []).map(String);
      const readArg = (flag) => {
        const index = args.indexOf(flag);
        return index >= 0 ? args[index + 1] : null;
      };
      const profileName = readArg('--profile');
      const healthUrlFile = readArg('--health.url-file');
      const profileDir = readArg('--profile-dir');

      const instanceKey = `${String(profileName)}`;
      const portFile = path.join(scratchDir, 'ports', `${instanceKey}.port`);
      fs.mkdirSync(path.dirname(portFile), { recursive: true });
      try { fs.rmSync(portFile, { force: true }); } catch (_) {}

      const child = spawn(process.execPath, [
        FAKE_DAEMON,
        'run',
        '--profile', profileName,
        // Explicit --tunnel-id/--port-file/--instance-id: the fixture must never
        // depend on %APPDATA%\tunnel-client profiles.
        '--tunnel-id', `smoke-tunnel-${profileName}`,
        '--health.listen-addr', '127.0.0.1:0',
        '--port-file', portFile,
        '--instance-id', `fake-${profileName}-${process.pid}`,
        '--mode', 'normal'
      ], {
        cwd: scratchDir,
        // APPDATA/USERPROFILE/LOCALAPPDATA redirect the fixture away from any
        // production profile or data directory.
        env: childEnv,
        stdio: 'ignore',
        windowsHide: true
      });
      allChildren.add(child);
      child.on('exit', () => { allChildren.delete(child); });

      const localPort = readPortFile(portFile);
      if (!localPort) {
        try { child.kill(); } catch (_) {}
        throw new Error(`fake tunnel daemon for ${profileName} never reported a port`);
      }

      // The instance adapter records this handshake as the account's own port.
      if (healthUrlFile) {
        fs.mkdirSync(path.dirname(healthUrlFile), { recursive: true });
        fs.writeFileSync(healthUrlFile, `http://127.0.0.1:${localPort}\n`, 'utf8');
      }

      const identity = auditedIdentity(child.pid);
      if (!identity?.executablePath || !identity?.creationTimeFileTime) {
        try { child.kill(); } catch (_) {}
        throw new Error(`could not audit the spawned fake daemon pid ${child.pid}`);
      }

      const record = {
        pid: child.pid,
        child,
        instanceId: null,
        profileName,
        profileDir,
        healthUrlFile,
        portFile,
        localPort,
        executablePath: identity.executablePath,
        creationTimeFileTime: identity.creationTimeFileTime
      };
      tracked.set(`pid:${child.pid}`, record);

      log(`launched fake tunnel for profile '${profileName}': pid=${child.pid} port=${localPort}`);
      return {
        code: 0,
        success: true,
        processId: child.pid,
        executablePath: identity.executablePath,
        creationDate: new Date().toISOString(),
        creationTimeFileTime: identity.creationTimeFileTime,
        localPort
      };
    }

    if (action === 'Inspect') {
      const pid = Number(params.ProcessId);
      const record = tracked.get(`pid:${pid}`);
      if (!record || !isAlive(record.pid)) return { code: 0, running: false };
      return {
        code: 0,
        running: true,
        processId: record.pid,
        executablePath: record.executablePath,
        creationDate: new Date(1_700_000_000_000).toISOString(),
        creationTimeFileTime: record.creationTimeFileTime,
        localPort: record.localPort,
        healthURL: `http://127.0.0.1:${record.localPort}`
      };
    }

    if (action === 'Verify') {
      const pid = Number(params.ProcessId);
      const record = tracked.get(`pid:${pid}`);
      const valid = Boolean(record)
        && isAlive(record.pid)
        && String(params.ExpectedExecutablePath || '') === String(record.executablePath)
        && String(params.ExpectedCreationTimeFileTime || '') === String(record.creationTimeFileTime);
      return { code: 0, valid, reason: valid ? 'VALID' : 'PROCESS_IDENTITY_MISMATCH' };
    }

    if (action === 'Stop') {
      const pid = Number(params.ProcessId);
      const record = tracked.get(`pid:${pid}`);
      if (!record) return { code: 0, stopped: true };
      // Audited identity precondition before touching the handle.
      if (String(params.ExpectedExecutablePath || '') !== String(record.executablePath)
        || String(params.ExpectedCreationTimeFileTime || '') !== String(record.creationTimeFileTime)) {
        return { code: 2, error: 'PROCESS_IDENTITY_MISMATCH' };
      }
      return await stopRecord(record);
    }

    // `FindOwned` must never adopt a foreign process for an instance scope.
    if (action === 'FindOwned') return { code: 0, running: false };

    return { code: 0 };
  }

  async function stopRecord(record) {
    const { child, pid } = record;
    tracked.delete(`pid:${pid}`);
    allChildren.delete(child);
    if (isAlive(pid)) {
      // ONLY the exact child handle this script spawned.
      try { child.kill(); } catch (_) {}
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && isAlive(pid)) await sleep(50);
    }
    try { fs.rmSync(record.portFile, { force: true }); } catch (_) {}
    log(`stopped fake tunnel pid=${pid} (alive=${isAlive(pid)})`);
    return { code: 0, stopped: !isAlive(pid) };
  }

  return {
    runtimeCommand,
    tracked,
    allChildren,
    alivePids: () => Array.from(tracked.values()).map((record) => record.pid).filter(isAlive),
    recordForPid: (pid) => tracked.get(`pid:${pid}`) || null,
    async stopAll() {
      const results = [];
      for (const record of Array.from(tracked.values())) {
        results.push(await stopRecord(record));
      }
      return results;
    }
  };
}

/** Deterministic probe stub: transport evidence is out of scope, receipt shape is not. */
function createStubProbe() {
  return {
    isDefault: false,
    healthURL: null,
    async checkReady() { return true; },
    async probe() { return null; },
    async verify(params = {}) {
      return {
        ok: true,
        verified: true,
        identity: params.identity,
        proof: { kind: 'authenticated-control-plane' }
      };
    }
  };
}

/** Minimal authenticated security for a loopback-only demo console. */
function createLocalSecurity() {
  return {
    async guard(_req, _res, _options = {}) {
      return { authenticated: true, sessionId: 'smoke-session', csrfToken: 'smoke-csrf' };
    },
    async state() { return { configured: true, authenticated: true, csrfToken: 'smoke-csrf' }; },
    async setup() { return { ok: true }; },
    async login() { return { ok: true }; },
    async logout() { return { ok: true }; },
    async close() {}
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers against the demo console
// ---------------------------------------------------------------------------

const AUTH_HEADERS = {
  'Content-Type': 'application/json',
  Cookie: 'sid=smoke-session',
  'X-CSRF-Token': 'smoke-csrf'
};

async function apiJson(baseUrl, pathname, { method = 'GET', body, idempotencyKey } = {}) {
  const headers = { ...AUTH_HEADERS };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_) { parsed = { raw: text }; }
  return { status: res.status, body: parsed };
}

async function waitFor(predicate, { timeoutMs = 90_000, intervalMs = 200, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await predicate();
      if (last && last.ok) return last;
    } catch (err) {
      last = { ok: false, error: err.message };
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

function instanceRow(listBody, instanceId) {
  const rows = Array.isArray(listBody?.instances) ? listBody.instances : [];
  return rows.find((row) => row?.instanceId === instanceId) || null;
}

/** Real loopback HTTP probe proving the fake daemon actually listens on its port. */
async function assertDaemonListening(localPort) {
  return await new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: localPort, path: '/health', timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (_) {}
        resolve({ ok: res.statusCode === 200 && Boolean(parsed?.live), status: res.statusCode });
      });
    });
    req.on('error', () => resolve({ ok: false, status: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0 }); });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { dataDir: null, keepDataDir: false, port: null };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--data-dir' && i + 1 < argv.length) {
      options.dataDir = argv[i += 1];
    } else if (argv[i] === '--keep-data-dir') {
      options.keepDataDir = true;
    } else if (argv[i] === '--port' && i + 1 < argv.length) {
      options.port = argv[i += 1];
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv);
  const consolePort = resolveConsolePort(options);
  const startedAt = new Date().toISOString();
  const cleanups = [];

  // -- 0. Fail fast if the demo port is already taken -------------------------
  // (read-only probe; bound to the loopback interface only, never 17642)
  const portTaken = await new Promise((resolve) => {
    const probe = http.createServer();
    probe.once('error', () => resolve(true));
    probe.once('listening', () => probe.close(() => resolve(false)));
    probe.listen(consolePort, '127.0.0.1');
  });
  if (portTaken) throw new Error(`port ${consolePort} is already in use; refusing to start the demo console (pass --port <n> to use a free one)`);
  if (consolePort === PRODUCTION_CONSOLE_PORT) throw new Error('the demo console must never use the production port');

  // -- 1. Production snapshot BEFORE -----------------------------------------
  const before = snapshotProduction('before');
  log(`production BEFORE: ${snapshotSignature(before)}`);

  // -- 2. Isolated directories ------------------------------------------------
  // Paths are COMPUTED first and validated BEFORE anything is created, so a
  // rejected `--data-dir` can never leave a directory behind inside production.
  const devBase = options.dataDir
    ? path.resolve(options.dataDir)
    : path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'McpTunnelAccountManager-dev', `smoke-${process.pid}`);
  const dataDir = path.join(devBase, 'data');
  const scratchDir = path.join(devBase, 'scratch');
  const profileBase = path.join(os.tmpdir(), 'mcp-dev-profiles');
  const profileHome = path.join(profileBase, `smoke-${process.pid}`);
  const appDataDir = path.join(profileHome, 'app-data');
  const tunnelHome = path.join(profileHome, 'tunnel-home');

  /**
   * Resolves a path to its real on-disk form, tolerating not-yet-existing tails
   * (Windows short 8.3 names, `\\?\` prefixes and junctions all normalise here).
   * Falls back to a plain resolve only when no ancestor can be resolved at all.
   */
  function realResolve(target) {
    let current = path.resolve(target);
    const tail = [];
    for (let depth = 0; depth < 64; depth += 1) {
      try {
        const real = fs.realpathSync.native(current).replace(/[\\/]+$/, '');
        return tail.length ? path.join(real, ...tail.reverse()) : real;
      } catch (_) {
        const parent = path.dirname(current);
        if (parent === current) return path.resolve(target);
        tail.push(path.basename(current));
        current = parent;
      }
    }
    return path.resolve(target);
  }

  /**
   * SYMMETRIC overlap test. `fs.rmSync(recursive: true)` destroys everything
   * BENEATH its target, so a target that is an ANCESTOR of a protected directory
   * is exactly as fatal as one inside it. A one-directional "is candidate inside
   * forbidden" check wrongly accepts `%LOCALAPPDATA%` itself.
   *
   * Returns true when the two paths are equal, or either contains the other.
   * Fails CLOSED (returns true) whenever a path cannot be resolved.
   */
  function overlapsProtected(candidate, forbidden) {
    if (!forbidden) return false;
    const left = realResolve(candidate).toLowerCase().replace(/[\\/]+$/, '');
    const right = realResolve(forbidden).toLowerCase().replace(/[\\/]+$/, '');
    if (!left || !right) return true;
    if (left === right) return true;
    return left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`);
  }

  /**
   * Backwards-compatible alias retaining the old one-directional meaning for
   * call sites that genuinely only ask "is candidate inside forbidden".
   */
  function isInside(candidate, forbidden) {
    if (!forbidden) return false;
    const child = realResolve(candidate).toLowerCase().replace(/[\\/]+$/, '');
    const parent = realResolve(forbidden).toLowerCase().replace(/[\\/]+$/, '');
    return child === parent || child.startsWith(`${parent}${path.sep}`);
  }

  const productionDataDir = process.env.LOCALAPPDATA
    ? path.resolve(process.env.LOCALAPPDATA, 'McpTunnelAccountManager')
    : null;
  const productionProfileDir = process.env.APPDATA
    ? path.resolve(process.env.APPDATA, 'tunnel-client')
    : null;

  /**
   * ALLOWLIST, not denylist. Anything this demo creates or recursively deletes
   * must live under one of these roots; everything else is refused outright.
   * This is what stops `--data-dir %LOCALAPPDATA%` (an ANCESTOR of production)
   * and `--data-dir \\?\<arbitrary user dir>` from ever being swept.
   */
  const allowedRoots = [
    path.resolve(os.tmpdir()),
    process.env.LOCALAPPDATA
      ? path.resolve(process.env.LOCALAPPDATA, 'McpTunnelAccountManager-dev')
      : null
  ].filter(Boolean);

  function assertIsolated(label, candidate) {
    const resolved = realResolve(candidate).toLowerCase().replace(/[\\/]+$/, '');
    if (!resolved) {
      throw new Error(`refusing to run: ${label} could not be resolved`);
    }
    // 1. Never equal to, inside, or an ANCESTOR of a production directory.
    if (overlapsProtected(candidate, productionDataDir)) {
      throw new Error(
        `refusing to run: ${label} '${candidate}' overlaps the production data directory '${productionDataDir}'`
      );
    }
    if (overlapsProtected(candidate, productionProfileDir)) {
      throw new Error(
        `refusing to run: ${label} '${candidate}' overlaps the production tunnel-client profile directory '${productionProfileDir}'`
      );
    }
    // 2. Must be inside an explicitly allowed root.
    const permitted = allowedRoots.some((root) => {
      const normalised = realResolve(root).toLowerCase().replace(/[\\/]+$/, '');
      return resolved === normalised || resolved.startsWith(`${normalised}${path.sep}`);
    });
    if (!permitted) {
      throw new Error(
        `refusing to run: ${label} '${candidate}' is outside the permitted demo roots (${allowedRoots.join(', ')})`
      );
    }
  }

  // EVERY path this run may create or delete must pass the isolation guards.
  // `devBase`/`dataDir`/`scratchDir` are deleted in the `finally` below, so they
  // are the dangerous ones: they may never alias or contain production.
  const guardedPaths = [
    ['devBase', devBase],
    ['dataDir', dataDir],
    ['scratchDir', scratchDir],
    ['profileHome', profileHome],
    ['appDataDir', appDataDir],
    ['tunnelHome', tunnelHome]
  ];
  for (const [label, candidate] of guardedPaths) {
    assertIsolated(label, candidate);
  }

  // The demo must never be pointed at a directory that already holds production
  // state (a manager.db / master.key pair belongs to a real install), and it must
  // start from a CLEAN dev base: deleting a pre-existing user directory is never
  // acceptable, so an existing devBase is refused rather than adopted.
  if (fs.existsSync(path.join(realResolve(devBase), 'manager.db'))
    || fs.existsSync(path.join(realResolve(devBase), 'master.key'))) {
    throw new Error(`refusing to run: '${devBase}' already contains a manager database`);
  }
  if (fs.existsSync(realResolve(devBase))) {
    throw new Error(
      `refusing to run: '${devBase}' already exists; pass a fresh --data-dir (this demo never deletes a pre-existing directory)`
    );
  }
  if (fs.existsSync(realResolve(profileHome))) {
    throw new Error(`refusing to run: '${profileHome}' already exists; the demo profile home must be new`);
  }

  let vault = null;
  let store = null;
  let manager = null;
  let fakeRuntime = null;
  // Ownership is asserted ONLY after the mkdir actually succeeded, so a failed or
  // rejected run can never delete a directory this script did not create.
  let createdDevBase = false;
  let createdProfileHome = false;

  // Everything below is inside try/finally so that even a mid-run failure cannot
  // leave processes or a half-created dev directory behind.
  try {
    for (const dir of [dataDir, scratchDir, appDataDir, path.join(appDataDir, 'tunnel-client'), tunnelHome]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    createdDevBase = true;
    createdProfileHome = true;

    const fakeBinary = path.join(tunnelHome, 'tunnel-client.exe');
    fs.writeFileSync(fakeBinary, 'fake-tunnel-client-placeholder', 'utf8');

    const paths = {
      userProfile: profileHome,
      appData: appDataDir,
      tunnelHome,
      tunnelClientBin: fakeBinary
    };

    // Child env redirects APPDATA/USERPROFILE/LOCALAPPDATA into the temp tree, so the
    // fixture never reads %APPDATA%\tunnel-client and never writes production state.
    const childEnv = {
      SystemRoot: process.env.SystemRoot,
      windir: process.env.windir,
      PATH: process.env.PATH,
      Path: process.env.Path,
      PATHEXT: process.env.PATHEXT,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      COMSPEC: process.env.COMSPEC,
      NUMBER_OF_PROCESSORS: process.env.NUMBER_OF_PROCESSORS,
      PROCESSOR_ARCHITECTURE: process.env.PROCESSOR_ARCHITECTURE,
      OS: process.env.OS,
      APPDATA: appDataDir,
      USERPROFILE: profileHome,
      LOCALAPPDATA: path.join(profileHome, 'local-app-data')
    };

    fakeRuntime = createFakeRuntime({ scratchDir, childEnv });
    cleanups.push(async () => { await fakeRuntime.stopAll(); });

    // -- 3. Boot the isolated console on 17644 -------------------------------
    vault = createVault({ dataDir });
    store = openStore({ dataDir, vault });

    const stubProbe = createStubProbe();
    const instanceAdapterProvider = createInstanceAdapterProvider({
      dataDir,
      vault,
      probe: stubProbe,
      paths,
      runtimeCommand: fakeRuntime.runtimeCommand
    });

    manager = await startManager({
      dataDir,
      port: consolePort,
      security: createLocalSecurity(),
      vault,
      store,
      instanceAdapterProvider,
      adapterOptions: {
        vault,
        probe: stubProbe,
        paths,
        runtimeCommand: fakeRuntime.runtimeCommand
      }
    });
    cleanups.push(async () => { await manager?.close?.(); });

    const baseUrl = manager.url || `http://127.0.0.1:${consolePort}`;
    log(`demo console listening on ${baseUrl} (dataDir=${dataDir})`);

    // -- 4. One service, two accounts ---------------------------------------
    await store.registry.create({
      id: SERVICE_ID,
      label: 'Smoke test service (isolated)',
      enabled: true,
      binding: { type: 'stdio', executable: 'node', args: [] }
    });
    for (const [profileId, label, tunnelId] of [
      [PROFILE_A, 'Smoke Account A', 'smoke-tunnel-aaaa1111'],
      [PROFILE_B, 'Smoke Account B', 'smoke-tunnel-bbbb2222']
    ]) {
      await store.createProfile({
        id: profileId,
        label,
        services: { [SERVICE_ID]: { tunnelId, apiKey: `smoke-key-${profileId}` } }
      });
    }

    const instanceA = buildInstanceId(SERVICE_ID, PROFILE_A);
    const instanceB = buildInstanceId(SERVICE_ID, PROFILE_B);
    const basePath = `/api/mcps/${SERVICE_ID}/instances`;

    async function startInstance(profileId, instanceId) {
      const response = await apiJson(baseUrl, `${basePath}/${encodeURIComponent(profileId)}/start`, {
        method: 'POST',
        body: {},
        idempotencyKey: `smoke-start-${profileId}-${Date.now()}`
      });
      if (response.status !== 202 && response.status !== 200) {
        throw new Error(`start ${profileId} returned ${response.status}: ${JSON.stringify(response.body)}`);
      }
      await waitFor(async () => {
        const list = await apiJson(baseUrl, basePath);
        const row = instanceRow(list.body, instanceId);
        return {
          ok: Boolean(row && row.state === 'running' && Number.isSafeInteger(row.pid) && row.pid > 0
            && Number.isSafeInteger(row.localPort) && row.localPort > 0),
          row
        };
      }, { label: `${profileId} to reach state=running` });
      const list = await apiJson(baseUrl, basePath);
      return instanceRow(list.body, instanceId);
    }

    async function stopInstance(profileId, instanceId) {
      const response = await apiJson(baseUrl, `${basePath}/${encodeURIComponent(profileId)}/stop`, {
        method: 'POST',
        body: {},
        idempotencyKey: `smoke-stop-${profileId}-${Date.now()}`
      });
      if (response.status !== 202 && response.status !== 200) {
        throw new Error(`stop ${profileId} returned ${response.status}: ${JSON.stringify(response.body)}`);
      }
      await waitFor(async () => {
        const list = await apiJson(baseUrl, basePath);
        const row = instanceRow(list.body, instanceId);
        return { ok: Boolean(row && row.state === 'stopped' && row.pid === null), row };
      }, { label: `${profileId} to reach state=stopped` });
    }

    // -- 5. Concurrent start: A, then B for the SAME service ----------------
    const rowA1 = await startInstance(PROFILE_A, instanceA);
    log(`instance A running: ${JSON.stringify(rowA1)}`);

    const rowB1 = await startInstance(PROFILE_B, instanceB);
    log(`instance B running (sibling A was already running): ${JSON.stringify(rowB1)}`);

    if (rowA1.pid === rowB1.pid) throw new Error('both accounts report the SAME pid');
    if (rowA1.localPort === rowB1.localPort) throw new Error('both accounts report the SAME local port');
    if (rowA1.instanceId === rowB1.instanceId) throw new Error('both accounts report the SAME instanceId');
    if (rowB1.localPort === PRODUCTION_CONSOLE_PORT || rowA1.localPort === PRODUCTION_CONSOLE_PORT) {
      throw new Error('an instance bound the production console port');
    }

    // Both fake daemons must genuinely listen on their reported loopback ports.
    for (const row of [rowA1, rowB1]) {
      const health = await assertDaemonListening(row.localPort);
      if (!health.ok) throw new Error(`fake daemon for ${row.instanceId} is not listening on ${row.localPort}`);
    }
    if (fakeRuntime.alivePids().length !== 2) {
      throw new Error(`expected 2 live fake tunnel processes, saw ${fakeRuntime.alivePids().length}`);
    }

    // -- 6. Stop A only; B must be untouched --------------------------------
    await stopInstance(PROFILE_A, instanceA);
    const afterStopB = instanceRow((await apiJson(baseUrl, basePath)).body, instanceB);
    if (!afterStopB || afterStopB.state !== 'running' || afterStopB.pid !== rowB1.pid) {
      throw new Error(`stopping A disturbed sibling B: ${JSON.stringify(afterStopB)}`);
    }
    if (fakeRuntime.alivePids().length !== 1) {
      throw new Error('stopping A must leave exactly one fake tunnel process');
    }
    log(`stop isolated: A stopped, B still running with pid=${afterStopB.pid}`);
    const stopIsolated = true;

    // -- 7. Bring A back so the final summary shows both running ------------
    const rowA2 = await startInstance(PROFILE_A, instanceA);
    const rowB2 = instanceRow((await apiJson(baseUrl, basePath)).body, instanceB);
    if (!rowB2 || rowB2.state !== 'running' || rowB2.pid !== rowB1.pid) {
      throw new Error('restarting A disturbed sibling B');
    }
    if (rowA2.pid === rowB2.pid) throw new Error('the restarted account reused the sibling pid');
    log(`both running again: A pid=${rowA2.pid} port=${rowA2.localPort}, B pid=${rowB2.pid} port=${rowB2.localPort}`);

    const summary = {
      port: consolePort,
      dataDir,
      instances: [rowA2, rowB2].map((row) => ({
        instanceId: row.instanceId,
        pid: row.pid,
        state: row.state,
        localPort: row.localPort
      })),
      bothRunning: [rowA2, rowB2].every((row) => row.state === 'running' && Number.isSafeInteger(row.pid) && row.pid > 0),
      stopIsolated,
      prodUntouched: false // set after the AFTER snapshot below
    };
    if (!summary.bothRunning) throw new Error('both instances are not running at summary time');

    // -- 8. Tear the demo down gracefully (HTTP stop) ------------------------
    for (const [profileId, instanceId] of [[PROFILE_A, instanceA], [PROFILE_B, instanceB]]) {
      try {
        await stopInstance(profileId, instanceId);
      } catch (err) {
        log(`graceful stop of ${profileId} failed (will force-stop the handle): ${err.message}`);
      }
    }

    // -- 9. Final cleanup + stray-process check -----------------------------
    await manager?.close?.();
    manager = null;
    await fakeRuntime.stopAll();

    const strayPids = fakeRuntime.alivePids();
    if (strayPids.length > 0) throw new Error(`stray fake tunnel processes left behind: ${strayPids.join(', ')}`);
    for (const child of fakeRuntime.allChildren) {
      try { child.kill(); } catch (_) {}
    }

    // -- 10. Production snapshot AFTER + comparison -------------------------
    const after = snapshotProduction('after');
    log(`production AFTER:  ${snapshotSignature(after)}`);

    const prodUntouched = snapshotSignature(before) === snapshotSignature(after);
    if (!prodUntouched) {
      // Loud, unmissable failure.
      console.error('=====================================================================');
      console.error('  PRODUCTION UNTOUCHED CHECK FAILED');
      console.error(`  BEFORE: ${snapshotSignature(before)}`);
      console.error(`  AFTER:  ${snapshotSignature(after)}`);
      console.error('  A production tunnel-client pid or the 17642 listener changed.');
      console.error('=====================================================================');
      throw new Error('production state changed during the smoke run');
    }
    summary.prodUntouched = true;

    // -- 11. Machine-readable result (LAST stdout line) ---------------------
    log(`done in ${Date.now() - Date.parse(startedAt)}ms`);
    console.log(JSON.stringify(summary));
    return summary;
  } finally {
    // Cleanup runs on success and failure alike; each step is best-effort.
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); } catch (_) {}
    }
    try { store?.close?.(); } catch (_) {}
    try { await vault?.close?.(); } catch (_) {}

    // Last-resort sweep: kill any child handle this script still owns. These are
    // OUR spawn handles only — never a by-name/by-broad-pattern process kill.
    for (const child of fakeRuntime?.allChildren ?? []) {
      try { child.kill(); } catch (_) {}
    }

    // Deleting directories is the one irreversible action here, so re-assert the
    // isolation guards immediately before it. `createdDevBase`/`createdProfileHome`
    // are only set AFTER a successful mkdir, and the guards are re-evaluated from
    // the CURRENT resolved paths, so a rejected/aborted run never deletes anything.
    // The check is SYMMETRIC: a target that CONTAINS a protected directory is
    // refused just as firmly as one that lives inside it.
    if (!options.keepDataDir) {
      const removable = [];
      const safeToRemove = (target) => {
        if (!target) return false;
        try {
          assertIsolated('cleanup target', target);
          return true;
        } catch (_) {
          return false;
        }
      };
      if (createdDevBase && safeToRemove(devBase)) removable.push(devBase);
      if (createdProfileHome && safeToRemove(profileHome)) removable.push(profileHome);
      for (const target of removable) {
        try { fs.rmSync(target, { recursive: true, force: true }); } catch (_) {}
      }
      if (removable.length !== [createdDevBase, createdProfileHome].filter(Boolean).length) {
        console.error('[smoke] refusing to delete a directory that is not provably isolated; left in place');
      }
    }
  }
}

main().then(
  () => { process.exitCode = 0; },
  (err) => {
    console.error('[smoke] FAILED:', err?.message || err);
    if (err?.stack) console.error(err.stack);
    console.error('[smoke] production snapshot was NOT re-verified after this failure;');
    console.error('[smoke] the failure happened before or outside the verified window.');
    process.exitCode = 1;
  }
);

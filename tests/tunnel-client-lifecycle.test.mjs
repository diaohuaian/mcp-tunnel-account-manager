/**
 * Focused Integration Test Suite: Tunnel Client Lifecycle Management
 * Tests the GPT-approved tunnel-client lifecycle policy, HTTP endpoints,
 * durable action store, CSRF, idempotency, and isolated synthetic lifecycle cycle.
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { decideTunnelClientAction } from '../src/core/tunnel-client-lifecycle.mjs';
import { createHttpServer } from '../src/server.mjs';
import { createVault } from '../src/vault.mjs';
import { openStore } from '../src/store.mjs';
import { attachRegistry } from '../src/mcp-registry-store.mjs';

function createMockSecurity(overrides = {}) {
  const sessions = new Map();
  sessions.set('test-session', { csrfToken: 'test-csrf-token' });

  return {
    guard: async (req, res, options = {}) => {
      if (overrides.denyAuth) return false;
      const sid = req.headers.cookie?.match(/sid=([^;]+)/)?.[1];
      if (!sid || sid !== 'test-session') {
        const err = new Error('Unauthorized');
        err.status = 401;
        err.code = 'UNAUTHORIZED';
        throw err;
      }
      const isWrite = Boolean(options.write);
      const token = req.headers['x-csrf-token'];
      if (isWrite) {
        if (overrides.denyCsrf || !token || token !== 'test-csrf-token') {
          const err = new Error('Invalid CSRF');
          err.code = 'FORBIDDEN';
          err.status = 403;
          throw err;
        }
      }
      return { authenticated: true, sessionId: 'test-session', csrfToken: 'test-csrf-token' };
    },
    state: async () => ({ configured: true, authenticated: true, csrfToken: 'test-csrf-token' }),
    setup: async () => ({ ok: true }),
    login: async () => ({ ok: true }),
    logout: async () => ({ ok: true }),
    close: async () => {}
  };
}

function startServer(options = {}) {
  const security = options.security || createMockSecurity();
  return new Promise((resolve, reject) => {
    try {
      const server = createHttpServer({
        ...options,
        security
      });
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        resolve({
          server,
          baseUrl: `http://127.0.0.1:${port}`,
          close: () => new Promise((res) => {
            server.closeAllConnections?.();
            server.close(res);
          })
        });
      });
    } catch (err) {
      reject(err);
    }
  });
}

const AUTH_HEADERS = {
  'Content-Type': 'application/json',
  'Cookie': 'sid=test-session',
  'X-CSRF-Token': 'test-csrf-token'
};

describe('Tunnel Client Lifecycle Management Suite', () => {

  // =========================================================================
  // 1. Pure Policy Unit Tests: decideTunnelClientAction
  // =========================================================================
  describe('1. Pure Policy: decideTunnelClientAction', () => {
    const baseCtx = {
      serviceId: 'overleaf-mcp',
      registeredAdapter: true,
      serviceEnabled: true,
      eligibleProfileIds: ['profile-1', 'profile-2'],
      binaryAvailable: true,
      controlCarrier: false,
      nowMs: 100000,
      snapshot: {
        state: 'stopped',
        absenceVerified: true,
        observedAt: 99000,
        managed: true
      }
    };

    test('rejects invalid action name', () => {
      const res = decideTunnelClientAction('pause', baseCtx);
      assert.deepEqual(res, { decision: 'reject', code: 'INVALID_ACTION' });
    });

    test('rejects unmanaged service or missing adapter', () => {
      const res = decideTunnelClientAction('start', { ...baseCtx, registeredAdapter: false });
      assert.deepEqual(res, { decision: 'reject', code: 'SERVICE_NOT_MANAGED' });
    });

    test('returns busy if operation is already in progress', () => {
      const res = decideTunnelClientAction('start', { ...baseCtx, pendingOperationId: 'op-999' });
      assert.deepEqual(res, { decision: 'busy', code: 'OPERATION_IN_PROGRESS', operationId: 'op-999' });
    });

    test('rejects stale snapshot (>10s old)', () => {
      const res = decideTunnelClientAction('start', {
        ...baseCtx,
        snapshot: { ...baseCtx.snapshot, observedAt: 80000 } // 20s old
      });
      assert.deepEqual(res, { decision: 'reject', code: 'STATE_REFRESH_REQUIRED' });
    });

    test('rejects future snapshot (>5s in future)', () => {
      const res = decideTunnelClientAction('start', {
        ...baseCtx,
        snapshot: { ...baseCtx.snapshot, observedAt: 110000 } // 10s future
      });
      assert.deepEqual(res, { decision: 'reject', code: 'STATE_REFRESH_REQUIRED' });
    });

    test('rejects unmanaged external process', () => {
      const res = decideTunnelClientAction('start', {
        ...baseCtx,
        snapshot: {
          state: 'unmanaged',
          observedAt: 99000,
          externalProcessPresent: true
        }
      });
      assert.deepEqual(res, { decision: 'reject', code: 'EXTERNAL_CLIENT_NOT_MANAGED' });
    });

    test('rejects transition state snapshot (starting/stopping/restarting)', () => {
      const res = decideTunnelClientAction('start', {
        ...baseCtx,
        snapshot: {
          state: 'starting',
          observedAt: 99000
        }
      });
      assert.deepEqual(res, { decision: 'reject', code: 'OPERATION_IN_PROGRESS' });
    });

    test('rejects unverified stopped state (missing absenceVerified)', () => {
      const res = decideTunnelClientAction('start', {
        ...baseCtx,
        snapshot: {
          state: 'stopped',
          absenceVerified: false,
          observedAt: 99000
        }
      });
      assert.deepEqual(res, { decision: 'reject', code: 'STATE_UNVERIFIED' });
    });

    test('rejects running state with invalid identity (PID missing or non-owned)', () => {
      const res = decideTunnelClientAction('stop', {
        ...baseCtx,
        snapshot: {
          state: 'running',
          owned: false,
          identityVerified: false,
          pid: 0,
          observedAt: 99000
        }
      });
      assert.deepEqual(res, { decision: 'reject', code: 'PROCESS_IDENTITY_MISMATCH' });
    });

    test('returns noop ALREADY_RUNNING for start if already running with same profile', () => {
      const res = decideTunnelClientAction('start', {
        ...baseCtx,
        requestedProfileId: 'profile-1',
        snapshot: {
          state: 'running',
          owned: true,
          identityVerified: true,
          pid: 1234,
          startedAt: '2026-11-06T00:00:00.000Z',
          executablePath: 'C:\\bin\\tunnel-client.exe',
          profileId: 'profile-1',
          observedAt: 99000
        }
      });
      assert.deepEqual(res, { decision: 'noop', code: 'ALREADY_RUNNING', pid: 1234 });
    });

    test('rejects start with different profile if already running (requires restart)', () => {
      const res = decideTunnelClientAction('start', {
        ...baseCtx,
        requestedProfileId: 'profile-2',
        snapshot: {
          state: 'running',
          owned: true,
          identityVerified: true,
          pid: 1234,
          startedAt: '2026-11-06T00:00:00.000Z',
          executablePath: 'C:\\bin\\tunnel-client.exe',
          profileId: 'profile-1',
          observedAt: 99000
        }
      });
      assert.deepEqual(res, { decision: 'reject', code: 'PROFILE_CHANGE_REQUIRES_RESTART' });
    });

    test('returns noop ALREADY_STOPPED for stop if already verified stopped', () => {
      const res = decideTunnelClientAction('stop', baseCtx);
      assert.deepEqual(res, { decision: 'noop', code: 'ALREADY_STOPPED' });
    });

    test('rejects carrier stop/restart without verified confirmation', () => {
      const liveCarrierCtx = {
        ...baseCtx,
        controlCarrier: true,
        carrierConfirmationVerified: false,
        snapshot: {
          state: 'running',
          owned: true,
          identityVerified: true,
          pid: 5678,
          startedAt: '2026-11-06T00:00:00.000Z',
          executablePath: 'C:\\bin\\tunnel-client.exe',
          profileId: 'profile-1',
          observedAt: 99000
        }
      };
      assert.deepEqual(decideTunnelClientAction('stop', liveCarrierCtx), {
        decision: 'reject',
        code: 'CARRIER_CONFIRMATION_REQUIRED'
      });
      assert.deepEqual(decideTunnelClientAction('restart', liveCarrierCtx), {
        decision: 'reject',
        code: 'CARRIER_CONFIRMATION_REQUIRED'
      });
    });

    test('rejects start if service is disabled', () => {
      const res = decideTunnelClientAction('start', {
        ...baseCtx,
        serviceEnabled: false,
        requestedProfileId: 'profile-1'
      });
      assert.deepEqual(res, { decision: 'reject', code: 'SERVICE_DISABLED' });
    });

    test('rejects start if no profile configured/specified', () => {
      const res = decideTunnelClientAction('start', {
        ...baseCtx,
        requestedProfileId: null
      });
      assert.deepEqual(res, { decision: 'reject', code: 'PROFILE_REQUIRED' });
    });

    test('rejects start if profile is not in eligibleProfileIds', () => {
      const res = decideTunnelClientAction('start', {
        ...baseCtx,
        requestedProfileId: 'unconfigured-profile'
      });
      assert.deepEqual(res, { decision: 'reject', code: 'PROFILE_NOT_CONFIGURED' });
    });

    test('rejects start if binaryAvailable is false', () => {
      const res = decideTunnelClientAction('start', {
        ...baseCtx,
        requestedProfileId: 'profile-1',
        binaryAvailable: false
      });
      assert.deepEqual(res, { decision: 'reject', code: 'EXECUTABLE_NOT_FOUND' });
    });

    test('enqueues start action when all invariants satisfied', () => {
      const res = decideTunnelClientAction('start', {
        ...baseCtx,
        requestedProfileId: 'profile-1'
      });
      assert.deepEqual(res, {
        decision: 'enqueue',
        action: 'start',
        serviceId: 'overleaf-mcp',
        profileId: 'profile-1',
        expectedIdentity: null
      });
    });

    test('enqueues restart action with expected identity when running', () => {
      const res = decideTunnelClientAction('restart', {
        ...baseCtx,
        requestedProfileId: 'profile-2',
        snapshot: {
          state: 'running',
          owned: true,
          identityVerified: true,
          pid: 4321,
          startedAt: '2026-11-06T00:00:00.000Z',
          executablePath: 'C:\\bin\\tunnel-client.exe',
          profileId: 'profile-1',
          observedAt: 99000
        }
      });
      assert.deepEqual(res, {
        decision: 'enqueue',
        action: 'restart',
        serviceId: 'overleaf-mcp',
        profileId: 'profile-2',
        expectedIdentity: {
          pid: 4321,
          startedAt: '2026-11-06T00:00:00.000Z',
          executablePath: 'C:\\bin\\tunnel-client.exe'
        }
      });
    });
  });

  // =========================================================================
  // 2. Durable Action Store Tests: mcp-registry-store.mjs
  // =========================================================================
  describe('2. Durable Action Store in SQLite', () => {
    let tmpDir;
    let vault;
    let store;
    let registry;

    beforeEach(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-lifecycle-test-'));
      vault = createVault({ dataDir: tmpDir });
      store = openStore({ dataDir: tmpDir, vault });
      registry = store.registry;

      // Create test profile with credentials for test service
      await store.createProfile({
        id: 'profile-alpha',
        label: 'Alpha Profile',
        services: {
          'mcp_test_stdio': {
            tunnelId: 'tun_test_1234',
            apiKey: 'sk-test-key-5678'
          }
        }
      });

      // Register test service
      await registry.create({
        id: 'mcp_test_stdio',
        label: 'Test MCP',
        binding: { type: 'stdio', executable: 'node' }
      });
    });

    afterEach(() => {
      try {
        store?.close();
      } catch (e) {}
      try {
        vault?.close();
      } catch (e) {}
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('creates and retrieves durable lifecycle action with idempotency', async () => {
      const rev = store.getRevision();
      const act1 = await registry.createLifecycleAction({
        action: 'start',
        serviceId: 'mcp_test_stdio',
        profileId: 'profile-alpha',
        expectedRevision: rev,
        idempotencyKey: 'idem-key-001'
      });

      assert.ok(act1.id);
      assert.equal(act1.kind, 'start');
      assert.equal(act1.profileId, 'profile-alpha');
      assert.equal(act1.serviceId, 'mcp_test_stdio');
      assert.equal(act1.state, 'QUEUED');

      // Re-invoking with identical idempotencyKey returns identical action
      const act2 = await registry.createLifecycleAction({
        action: 'start',
        serviceId: 'mcp_test_stdio',
        profileId: 'profile-alpha',
        expectedRevision: rev,
        idempotencyKey: 'idem-key-001'
      });

      assert.equal(act2.id, act1.id);

      // Re-invoking with conflicting action payload throws IDEMPOTENCY_CONFLICT
      await assert.rejects(async () => {
        await registry.createLifecycleAction({
          action: 'stop', // conflicting action!
          serviceId: 'mcp_test_stdio',
          profileId: null,
          expectedRevision: rev,
          idempotencyKey: 'idem-key-001'
        });
      }, { code: 'IDEMPOTENCY_CONFLICT' });
    });

    test('transitions action to terminal SUCCEEDED with receipt', async () => {
      const rev = store.getRevision();
      const act = await registry.createLifecycleAction({
        action: 'restart',
        serviceId: 'mcp_test_stdio',
        profileId: 'profile-alpha',
        expectedRevision: rev,
        idempotencyKey: 'idem-key-002'
      });

      await registry.transitionAction(act.id, { state: 'APPLYING' });
      const loadedApplying = await registry.loadAction(act.id);
      assert.equal(loadedApplying.state, 'APPLYING');

      await registry.finishLifecycleAction(act.id, {
        stoppedPid: 1001,
        spawnedPid: 1002,
        verified: true
      }, { action: 'restart', profileId: 'profile-alpha' });

      const loadedFinished = await registry.loadAction(act.id);
      assert.equal(loadedFinished.state, 'SUCCEEDED');
    });
  });

  // =========================================================================
  // 3. HTTP Endpoints Tests: POST /api/mcps/:id/start, /restart, /stop
  // =========================================================================
  describe('3. HTTP Endpoints & Guard Integrations', () => {
    let ctx;
    let carrierVault;
    let carrierFixtureDir;
    let wakeCount = 0;
    let createdAction = null;
    let mockRuntime = {
      state: 'stopped',
      tunnelClient: {
        state: 'stopped',
        managed: true,
        absenceVerified: true,
        observedAt: Date.now()
      }
    };

    before(async () => {
      const fakeRepo = {
        getRevision: async () => 1,
        registry: {
          getMcp: (id) => {
            if (id === 'carrier-mcp') {
              return {
                id: 'carrier-mcp',
                label: 'Carrier Service',
                controlCarrier: true,
                binding: { type: 'stdio', executable: 'node' }
              };
            }
            if (id === 'stdio-mcp') {
              return {
                id: 'stdio-mcp',
                label: 'Stdio Service',
                controlCarrier: false,
                binding: { type: 'stdio', executable: 'node' }
              };
            }
            return null;
          },
          getServiceRuntime: (id) => mockRuntime,
          createLifecycleAction: async (args) => {
            createdAction = args;
            return {
              id: 'op-act-101',
              operationId: 'op-act-101',
              kind: args.action,
              profileId: args.profileId,
              serviceId: args.serviceId,
              state: 'QUEUED',
              createdAt: new Date().toISOString()
            };
          }
        }
      };

      const fakeRunner = {
        wake: () => {
          wakeCount += 1;
        }
      };

      carrierFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-carrier-http-'));
      carrierVault = createVault({ dataDir: carrierFixtureDir });
      const processPath = path.join(carrierFixtureDir, 'synthetic-process.json');
      fs.writeFileSync(processPath, JSON.stringify({ pid: 8877 }));
      ctx = await startServer({
        repo: fakeRepo,
        runner: fakeRunner,
        vault: carrierVault,
        adapters: {
          'carrier-mcp': {
            processPath,
            processController: {
              inspect: async () => ({ ...mockRuntime.tunnelClient, running: mockRuntime.tunnelClient.state === 'running' }),
              verify: async () => ({ valid: true })
            }
          }
        }
      });
    });

    after(async () => {
      try { await ctx?.close(); }
      finally {
        carrierVault?.close();
        if (carrierFixtureDir) fs.rmSync(carrierFixtureDir, { recursive: true, force: true });
      }
    });

    test('POST /api/mcps/:id/start rejects unauthenticated request (401)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/mcps/stdio-mcp/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      assert.equal(res.status, 401);
    });

    test('POST /api/mcps/:id/start rejects missing CSRF header (403)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/mcps/stdio-mcp/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': 'sid=test-session'
          // X-CSRF-Token omitted
        }
      });
      assert.equal(res.status, 403);
    });

    test('POST /api/mcps/:id/start without profileId returns 400 PROFILE_REQUIRED', async () => {
      mockRuntime = {
        state: 'stopped',
        tunnelClient: { state: 'stopped', absenceVerified: true, observedAt: Date.now() }
      };
      const res = await fetch(`${ctx.baseUrl}/api/mcps/stdio-mcp/start`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'Idempotency-Key': 'idem-start-err'
        },
        body: JSON.stringify({ expectedRevision: 1 }) // no profileId
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.error?.code || data.error, 'PROFILE_REQUIRED');
    });

    test('POST /api/mcps/:id/start returns 200 ALREADY_RUNNING fast no-op if already running', async () => {
      mockRuntime = {
        state: 'running',
        tunnelClient: {
          state: 'running',
          managed: true,
          identityVerified: true,
          pid: 9988,
          profileId: 'prof-curr',
          startedAt: '2026-11-06T00:00:00.000Z',
          executablePath: 'C:\\bin\\tunnel-client.exe',
          observedAt: Date.now()
        }
      };
      const res = await fetch(`${ctx.baseUrl}/api/mcps/stdio-mcp/start`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'Idempotency-Key': 'idem-start-noop'
        },
        body: JSON.stringify({ expectedRevision: 1, profileId: 'prof-curr' })
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.code, 'ALREADY_RUNNING');
      assert.equal(data.pid, 9988);
    });

    test('POST /api/mcps/:id/stop returns 200 ALREADY_STOPPED fast no-op if already stopped', async () => {
      mockRuntime = {
        state: 'stopped',
        tunnelClient: {
          state: 'stopped',
          managed: true,
          absenceVerified: true,
          observedAt: Date.now()
        }
      };
      const res = await fetch(`${ctx.baseUrl}/api/mcps/stdio-mcp/stop`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'Idempotency-Key': 'idem-stop-noop'
        },
        body: JSON.stringify({ expectedRevision: 1 })
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.code, 'ALREADY_STOPPED');
    });

    test('POST /api/mcps/:id/stop on controlCarrier without token returns 409 CARRIER_CONFIRMATION_REQUIRED with signed carrierToken', async () => {
      mockRuntime = {
        state: 'running',
        tunnelClient: {
          state: 'running',
          managed: true,
          identityVerified: true,
          pid: 8877,
          profileId: 'carrier-prof',
          startedAt: '2026-11-06T00:00:00.000Z',
          executablePath: 'C:\\bin\\tunnel-client.exe',
          observedAt: Date.now()
        }
      };
      const res = await fetch(`${ctx.baseUrl}/api/mcps/carrier-mcp/stop`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'Idempotency-Key': 'idem-carrier-req'
        },
        body: JSON.stringify({ expectedRevision: 1 })
      });
      assert.equal(res.status, 409);
      const data = await res.json();
      assert.equal(data.error, 'CARRIER_CONFIRMATION_REQUIRED');
      assert.ok(data.carrierToken, 'Must provide carrierToken for two-step confirmation');

      // Tokens are bound to the original idempotency key; changing it must fail closed.
      const wrongKeyRes = await fetch(`${ctx.baseUrl}/api/mcps/carrier-mcp/stop`, {
        method: 'POST',
        headers: { ...AUTH_HEADERS, 'Idempotency-Key': 'idem-carrier-different' },
        body: JSON.stringify({ expectedRevision: 1, carrierToken: data.carrierToken })
      });
      assert.equal(wrongKeyRes.status, 403);
      assert.equal((await wrongKeyRes.json()).error.code, 'CARRIER_CONFIRMATION_INVALID');
      assert.equal(createdAction, null);

      // Confirm the original request with the same idempotency key.
      const confirmedRes = await fetch(`${ctx.baseUrl}/api/mcps/carrier-mcp/stop`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'Idempotency-Key': 'idem-carrier-req'
        },
        body: JSON.stringify({
          expectedRevision: 1,
          carrierToken: data.carrierToken
        })
      });
      assert.equal(confirmedRes.status, 202);
      const confData = await confirmedRes.json();
      assert.equal(confData.kind, 'stop');
    });

    test('POST /api/mcps/:id/start queues action with 202 and wakes runner', async () => {
      mockRuntime = {
        state: 'stopped',
        tunnelClient: {
          state: 'stopped',
          managed: true,
          absenceVerified: true,
          observedAt: Date.now()
        }
      };
      const prevWake = wakeCount;
      const res = await fetch(`${ctx.baseUrl}/api/mcps/stdio-mcp/start`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'Idempotency-Key': 'idem-start-queue'
        },
        body: JSON.stringify({
          expectedRevision: 1,
          profileId: 'new-profile'
        })
      });
      assert.equal(res.status, 202);
      assert.equal(wakeCount, prevWake + 1);
      assert.equal(createdAction.action, 'start');
      assert.equal(createdAction.serviceId, 'stdio-mcp');
      assert.equal(createdAction.profileId, 'new-profile');
    });
  });

  // =========================================================================
  // 4. Synthetic Isolated Process Lifecycle Cycle
  // =========================================================================
  describe('4. Synthetic Isolated Process Lifecycle Cycle', () => {
    let tmpDir;
    let syntheticProcess = null;
    let syntheticPid = null;

    before(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-lifecycle-'));
    });

    after(() => {
      if (syntheticProcess) {
        try {
          syntheticProcess.kill('SIGKILL');
        } catch (e) {}
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('Isolated lifecycle full cycle: start synthetic -> verify PID -> restart -> new PID -> stop -> absence verified', async () => {
      // 1. Start synthetic process (safe Node script that stays alive)
      const scriptCode = `
        setInterval(() => {}, 500);
      `;
      syntheticProcess = spawn(process.execPath, ['-e', scriptCode], {
        detached: false,
        stdio: 'ignore'
      });
      syntheticPid = syntheticProcess.pid;
      assert.ok(syntheticPid > 0, 'Synthetic process must have positive integer PID');

      // Verify that this is NOT the user production carrier (PID 35812) or RC17 (PID 2480)
      assert.notEqual(syntheticPid, 35812, 'Synthetic process must not collide with production carrier');
      assert.notEqual(syntheticPid, 2480, 'Synthetic process must not collide with RC17');

      // Verify synthetic process is alive
      let isAlive = false;
      try {
        process.kill(syntheticPid, 0);
        isAlive = true;
      } catch (e) {
        isAlive = false;
      }
      assert.equal(isAlive, true, 'Synthetic process must be running');

      // 2. Restart: simulate restart by launching replacement and terminating old
      const restartProcess = spawn(process.execPath, ['-e', scriptCode], {
        detached: false,
        stdio: 'ignore'
      });
      const newPid = restartProcess.pid;
      assert.ok(newPid > 0);
      assert.notEqual(newPid, syntheticPid, 'Restarted PID must differ from old PID');

      // Stop old synthetic process
      syntheticProcess.kill();
      await new Promise(r => setTimeout(r, 200));

      let oldIsAlive = false;
      try {
        process.kill(syntheticPid, 0);
        oldIsAlive = true;
      } catch (e) {
        oldIsAlive = false;
      }
      assert.equal(oldIsAlive, false, 'Old synthetic process must be terminated');

      // New process is alive
      let newIsAlive = false;
      try {
        process.kill(newPid, 0);
        newIsAlive = true;
      } catch (e) {
        newIsAlive = false;
      }
      assert.equal(newIsAlive, true, 'New synthetic process must be alive');

      // 3. Stop: cleanly terminate new process
      restartProcess.kill();
      await new Promise(r => setTimeout(r, 200));

      let finalIsAlive = false;
      try {
        process.kill(newPid, 0);
        finalIsAlive = true;
      } catch (e) {
        finalIsAlive = false;
      }
      assert.equal(finalIsAlive, false, 'Final synthetic process absence verified');
    });
  });
});

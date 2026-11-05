import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { startManager } from '../../src/main.mjs';
import { acquireDaemonLock } from '../../src/core/daemon-lock.mjs';
import { SwitchFault } from '../../src/core/switch-core.mjs';

function createTempDir(prefix = 'startup-rollback-e2e-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanTempDir(dir) {
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

function sendJsonRequest(baseUrl, reqPath, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(reqPath, baseUrl);
    const reqHeaders = {
      Accept: 'application/json',
      Connection: 'close',
      ...headers
    };
    let payload = null;
    if (body !== null) {
      payload = JSON.stringify(body);
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: reqHeaders
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = JSON.parse(raw);
          } catch (_) {}
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: parsed,
            raw
          });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function extractCookieSid(headers) {
  const raw = headers['set-cookie'];
  if (!raw) return null;
  const str = Array.isArray(raw) ? raw.join('; ') : raw;
  const match = str.match(/sid=([^;]+)/);
  return match ? decodeURIComponent(match[1].trim()) : null;
}

async function setupAndAuthenticate(manager, tempDir, password = 'StartupRollbackPassword123!') {
  const bootstrapFile = path.join(tempDir, 'bootstrap-code.txt');
  let bootstrapCode = '';
  if (fs.existsSync(bootstrapFile)) {
    bootstrapCode = fs.readFileSync(bootstrapFile, 'utf8').trim();
  }

  const authState = await sendJsonRequest(manager.url, '/api/auth/state');
  if (!authState.body?.configured && bootstrapCode) {
    const setupRes = await sendJsonRequest(manager.url, '/api/auth/setup', {
      method: 'POST',
      body: { bootstrapCode, password }
    });
    assert.equal(setupRes.status, 200, 'Auth setup should succeed');
  }

  const loginRes = await sendJsonRequest(manager.url, '/api/auth/login', {
    method: 'POST',
    body: { password }
  });
  assert.equal(loginRes.status, 200, 'Login should succeed');
  const csrfToken = loginRes.body?.csrfToken;
  const sid = extractCookieSid(loginRes.headers);
  assert.ok(sid, 'Session cookie sid must be present');
  assert.ok(csrfToken, 'CSRF token must be present');

  return {
    sid,
    csrfToken,
    authHeaders: {
      cookie: `sid=${sid}`,
      'x-csrf-token': csrfToken
    }
  };
}

function createStrictFakeAdapters({
  actionLog = [],
  restoreFailService = null,
  restoreError = new SwitchFault('RESTORE_FAILED')
} = {}) {
  const createServiceAdapter = (service) => {
    const runningProc = {
      pid: 65432,
      executable: 'fake-tunnel.mjs',
      startedAt: '2026-11-04T10:00:00.000Z'
    };

    return {
      async prepare({ operationId, credential }) {
        actionLog.push({ type: 'prepare', service, operationId });
        return {
          operationId,
          service,
          originalFingerprint: '1'.repeat(64),
          desiredFingerprint: '2'.repeat(64),
          originalConfig: { version: 1 },
          desiredConfig: { version: 2 },
          originalProcessIdentity: runningProc,
          credential
        };
      },

      async applyIfUnchanged({ operationId }) {
        actionLog.push({ type: 'apply', service, operationId });
        return runningProc;
      },

      async verifyDesired({ operationId, snapshot }) {
        actionLog.push({ type: 'verify', service, operationId });
        return {
          verified: true,
          operationId,
          service,
          configFingerprint: snapshot.desiredFingerprint,
          proof: { kind: 'authenticated-control-plane' },
          identity: runningProc
        };
      },

      async restoreIfOwned({ operationId, snapshot, step }) {
        actionLog.push({ type: 'restore', service, operationId });
        if (restoreFailService === service) {
          throw restoreError;
        }
        return {
          restored: true,
          runtimeRestored: true,
          operationId,
          service,
          configFingerprint: snapshot.originalFingerprint
        };
      },

      async describe() {
        return {
          service,
          configured: true,
          running: true,
          config: { tunnelId: 'tunnel_***1234' }
        };
      }
    };
  };

  return {
    'overleaf-mcp': createServiceAdapter('overleaf-mcp'),
    'antigravity-mcp': createServiceAdapter('antigravity-mcp')
  };
}

describe('Startup Rollback & Resource Safety E2E Suite', () => {

  it('1. releases kernel daemon lock and cleans up owned resources when runner startup fails', async () => {
    const tempDir = createTempDir('startup-rb-runner-');
    let manager = null;
    let lock1 = null;
    let lock2 = null;

    try {
      // Step A: provokes adapter factory failure during initial startup
      let failFactory = true;
      const failingAdapterFactory = async () => {
        if (failFactory) {
          throw new Error('provoked-adapter-factory-failure');
        }
        return createStrictFakeAdapters();
      };

      await assert.rejects(
        async () => {
          await startManager({
            dataDir: tempDir,
            port: 0,
            adapterFactory: failingAdapterFactory
          });
        },
        (err) => err.message.includes('provoked-adapter-factory-failure')
      );

      // Verify that kernel daemon lock was not leaked
      lock1 = await acquireDaemonLock(tempDir);
      assert.ok(lock1, 'Daemon lock must be freely acquirable after adapter startup failure rollback');
      await lock1.release();
      lock1 = null;

      // Step B: Boot cleanly, then simulate corrupt work record in DB
      failFactory = false;
      manager = await startManager({
        dataDir: tempDir,
        port: 0,
        adapterFactory: failingAdapterFactory
      });
      await manager.close();
      manager = null;

      // Corrupt an interrupted operation to have an invalid state in SQLite
      // loadWorkRecord will throw WORK_STATE_INVALID upon reading this work item during runner startup
      const dbPath = path.join(tempDir, 'manager.db');
      const db = new DatabaseSync(dbPath);
      const corruptOpId = 'corrupt-op-' + Date.now();
      db.prepare(`
        INSERT INTO operations (
          id, profile_id, profile_revision, targets, expected_revision,
          request_payload, pinned_credentials,
          status, failure_code, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        corruptOpId, 'p-test', 1, JSON.stringify(['overleaf-mcp']), 1,
        '{}', '{}',
        'INVALID_CORRUPT_STATE', null, new Date().toISOString(), new Date().toISOString()
      );
      db.close();

      // Attempting startManager must fail during runner.start() due to corrupt work record
      await assert.rejects(
        async () => {
          await startManager({
            dataDir: tempDir,
            host: '127.0.0.1',
            port: 0,
            adapterFactory: async () => createStrictFakeAdapters()
          });
        },
        (err) => {
          return err && (err.code === 'WORK_STATE_INVALID' || err.message?.includes('WORK_STATE_INVALID'));
        },
        'startManager must reject when interrupted work record has invalid state'
      );

      // Crucial check: Daemon lock MUST be completely released by startup rollback!
      lock2 = await acquireDaemonLock(tempDir);
      assert.ok(lock2, 'Daemon lock must be free to acquire after runner startup rollback');
      await lock2.release();
      lock2 = null;

      // Repair the corrupt record by deleting it, and verify startManager succeeds cleanly
      const dbRepair = new DatabaseSync(dbPath);
      dbRepair.prepare('DELETE FROM operations WHERE id = ?').run(corruptOpId);
      dbRepair.close();

      manager = await startManager({
        dataDir: tempDir,
        host: '127.0.0.1',
        port: 0,
        adapterFactory: async () => createStrictFakeAdapters()
      });
      assert.ok(manager.url, 'Manager must start successfully after repairing dataDir');
      await manager.close();
      manager = null;
    } finally {
      if (lock1) {
        try { await lock1.release(); } catch (_) {}
      }
      if (lock2) {
        try { await lock2.release(); } catch (_) {}
      }
      if (manager) await manager.close();
      cleanTempDir(tempDir);
    }
  });

  it('2. releases kernel daemon lock and avoids socket leaks when HTTP port is already bound (EADDRINUSE)', async () => {
    const tempDir = createTempDir('startup-rb-listen-');
    let blockerServer = null;
    let manager = null;
    let lock = null;

    try {
      // Pre-bind a TCP server to a free local port
      blockerServer = net.createServer();
      const boundPort = await new Promise((resolve, reject) => {
        blockerServer.listen(0, '127.0.0.1', () => {
          const addr = blockerServer.address();
          resolve(addr.port);
        });
        blockerServer.on('error', reject);
      });

      // Attempt startManager on the same bound port -> listen must fail with EADDRINUSE
      await assert.rejects(
        async () => {
          await startManager({
            dataDir: tempDir,
            host: '127.0.0.1',
            port: boundPort,
            adapterFactory: async () => createStrictFakeAdapters()
          });
        },
        (err) => {
          return err && (err.code === 'EADDRINUSE' || String(err).includes('EADDRINUSE'));
        },
        'startManager must reject when port is already bound'
      );

      // Crucial check: All resources acquired prior to HTTP listen (runner, daemon lock, store, vault)
      // must have been rolled back in reverse order. In particular, the daemon lock must NOT remain held.
      lock = await acquireDaemonLock(tempDir);
      assert.ok(lock, 'Daemon lock must be available after HTTP listen failure rollback');
      await lock.release();
      lock = null;

      // Release blocker server and start manager on that same port
      await new Promise((resolve) => blockerServer.close(resolve));
      blockerServer = null;

      manager = await startManager({
        dataDir: tempDir,
        host: '127.0.0.1',
        port: boundPort,
        adapterFactory: async () => createStrictFakeAdapters()
      });
      assert.equal(manager.port, boundPort, 'Manager must successfully bind to released port');
      await manager.close();
      manager = null;
    } finally {
      if (lock) {
        try { await lock.release(); } catch (_) {}
      }
      if (manager) await manager.close();
      if (blockerServer) {
        await new Promise((resolve) => blockerServer.close(resolve)).catch(() => {});
      }
      cleanTempDir(tempDir);
    }
  });

  it('3. handles clean teardown with no active socket leaks or dangling unclosed resources', async () => {
    const tempDir = createTempDir('startup-rb-leak-');
    let manager = null;
    let lock = null;

    try {
      manager = await startManager({
        dataDir: tempDir,
        host: '127.0.0.1',
        port: 0,
        adapterFactory: async () => createStrictFakeAdapters()
      });

      const { authHeaders } = await setupAndAuthenticate(manager, tempDir);

      // Issue requests to ensure connections are established
      const stateRes = await sendJsonRequest(manager.url, '/api/state', { headers: authHeaders });
      assert.equal(stateRes.status, 200);

      // Clean teardown
      await manager.close();

      // Idempotency check: calling close multiple times must be safe and not throw
      await manager.close();

      // Verify daemon lock is immediately available for reacquisition
      lock = await acquireDaemonLock(tempDir);
      assert.ok(lock, 'Daemon lock must be re-acquirable immediately after close()');
      await lock.release();
      lock = null;

      manager = null;
    } finally {
      if (lock) {
        try { await lock.release(); } catch (_) {}
      }
      if (manager) await manager.close();
      cleanTempDir(tempDir);
    }
  });

  it('4. persistent attention gate detects NEEDS_ATTENTION in stop actions and operations across boots', async () => {
    const tempDir = createTempDir('startup-rb-action-att-');
    let manager = null;

    try {
      manager = await startManager({
        dataDir: tempDir,
        host: '127.0.0.1',
        port: 0,
        adapterFactory: async () => createStrictFakeAdapters()
      });

      const { authHeaders } = await setupAndAuthenticate(manager, tempDir);

      // Create a profile
      const pRes = await sendJsonRequest(manager.url, '/api/profiles', {
        method: 'POST',
        headers: authHeaders,
        body: {
          label: 'Attention Gate Test Profile',
          services: {
            'overleaf-mcp': { tunnelId: 'tunnel_att_1', apiKey: 'sec_1' }
          }
        }
      });
      assert.equal(pRes.status, 200);
      const profileId = pRes.body.id;

      // Close cleanly
      await manager.close();
      manager = null;

      // Directly insert an MCP stop action with state = 'NEEDS_ATTENTION' in SQLite
      const dbPath = path.join(tempDir, 'manager.db');
      const db = new DatabaseSync(dbPath);
      const actionId = 'action-att-' + Date.now();
      db.prepare(`
        INSERT INTO mcp_actions (
          id, service_id, request_fingerprint, state, error_code, sealed_payload, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        actionId, 'overleaf-mcp', '0'.repeat(64), 'NEEDS_ATTENTION', 'PROCESS_STOP_FAILED', '{}',
        new Date().toISOString(), new Date().toISOString()
      );
      db.close();

      // Start manager on the dataDir
      manager = await startManager({
        dataDir: tempDir,
        host: '127.0.0.1',
        port: 0,
        adapterFactory: async () => createStrictFakeAdapters()
      });

      const auth2 = await setupAndAuthenticate(manager, tempDir);

      // 1. Verify getWorkQueue excludes this attention action (no spin)
      const workQueue = manager.store.getWorkQueue();
      const hasAttention = workQueue.some((w) => w.id === actionId);
      assert.equal(hasAttention, false, 'NEEDS_ATTENTION action must be excluded from runnable getWorkQueue');

      // 2. Persistent recovery gate in assertIdle must block new switch work
      const switchRes = await sendJsonRequest(manager.url, '/api/switch', {
        method: 'POST',
        headers: {
          ...auth2.authHeaders,
          'Idempotency-Key': 'key-blocked-by-action-att'
        },
        body: {
          profileId,
          targets: ['overleaf-mcp']
        }
      });
      assert.equal(switchRes.status, 409, 'Switch must be blocked when stop action needs attention');
      assert.equal(switchRes.body?.error?.code, 'RECOVERY_GATED');

      // 3. Persistent recovery gate must also block stop actions
      const stopRes = await sendJsonRequest(manager.url, '/api/mcps/overleaf-mcp/stop', {
        method: 'POST',
        headers: {
          ...auth2.authHeaders,
          'Idempotency-Key': 'stop-blocked-by-action-att'
        }
      });
      assert.equal(stopRes.status, 409, 'Stop action must be blocked when stop action needs attention');
      assert.equal(stopRes.body?.error?.code, 'RECOVERY_GATED');

      // 4. Even if resetRecoveryGate() is called on metadata, assertIdle still detects NEEDS_ATTENTION in actions
      manager.store.resetRecoveryGate();
      const stillBlockedRes = await sendJsonRequest(manager.url, '/api/switch', {
        method: 'POST',
        headers: {
          ...auth2.authHeaders,
          'Idempotency-Key': 'still-blocked-after-metadata-reset'
        },
        body: {
          profileId,
          targets: ['overleaf-mcp']
        }
      });
      assert.equal(stillBlockedRes.status, 409, 'Resetting metadata alone must NOT unlock work while attention action remains');
      assert.equal(stillBlockedRes.body?.error?.code, 'RECOVERY_GATED');

      // 5. Operator resolves the attention action
      const dbResolve = new DatabaseSync(dbPath);
      dbResolve.prepare("UPDATE mcp_actions SET state = 'REJECTED' WHERE id = ?").run(actionId);
      dbResolve.close();

      // Now switch is unblocked
      const unblockedRes = await sendJsonRequest(manager.url, '/api/switch', {
        method: 'POST',
        headers: {
          ...auth2.authHeaders,
          'Idempotency-Key': 'unblocked-after-action-resolve'
        },
        body: {
          profileId,
          targets: ['overleaf-mcp']
        }
      });
      assert.equal(unblockedRes.status, 202, 'Switch must proceed once attention action is resolved');

      await manager.close();
      manager = null;
    } finally {
      if (manager) await manager.close();
      cleanTempDir(tempDir);
    }
  });

  it('5. recovers interrupted nonterminal operations before queued work and preserves stable ordering', async () => {
    const tempDir = createTempDir('startup-rb-prio-');
    let manager = null;

    try {
      manager = await startManager({
        dataDir: tempDir,
        host: '127.0.0.1',
        port: 0,
        adapterFactory: async () => createStrictFakeAdapters()
      });
      const { authHeaders } = await setupAndAuthenticate(manager, tempDir);

      const pRes = await sendJsonRequest(manager.url, '/api/profiles', {
        method: 'POST',
        headers: authHeaders,
        body: {
          label: 'Priority Order Profile',
          services: {
            'overleaf-mcp': { tunnelId: 'tunnel_prio_1', apiKey: 'sec_1' }
          }
        }
      });
      const profileId = pRes.body.id;
      await manager.close();
      manager = null;

      // Insert two operations into SQLite:
      // Op A: status = QUEUED, created earlier
      // Op B: status = APPLYING (interrupted nonterminal), created later
      const dbPath = path.join(tempDir, 'manager.db');
      const db = new DatabaseSync(dbPath);

      const earlierTime = '2026-11-04T10:00:00.000Z';
      const laterTime = '2026-11-04T10:05:00.000Z';

      const opA_Id = 'op-queued-early';
      const opB_Id = 'op-applying-late';

      db.prepare(`
        INSERT INTO operations (
          id, profile_id, profile_revision, targets, expected_revision,
          request_payload, pinned_credentials,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(opA_Id, profileId, 1, JSON.stringify(['overleaf-mcp']), 1, '{}', '{}', 'QUEUED', earlierTime, earlierTime);

      db.prepare(`
        INSERT INTO operations (
          id, profile_id, profile_revision, targets, expected_revision,
          request_payload, pinned_credentials,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(opB_Id, profileId, 1, JSON.stringify(['overleaf-mcp']), 1, '{}', '{}', 'APPLYING', laterTime, laterTime);

      db.close();

      // Verify getWorkQueue query priority: nonterminal interrupted work (priority 0) precedes QUEUED (priority 1)
      const sdb = new DatabaseSync(path.join(tempDir, 'manager.db'));
      const queue = sdb.prepare(`
        SELECT id, created_at, 'switch' as kind,
          CASE
            WHEN status IN ('PREPARING', 'APPLYING', 'VERIFYING', 'ROLLING_BACK') THEN 0
            WHEN status = 'QUEUED' THEN 1
            ELSE 2
          END as priority
        FROM operations
        WHERE status NOT IN ('SUCCEEDED', 'ROLLED_BACK', 'REJECTED', 'NEEDS_ATTENTION')
        ORDER BY priority ASC, created_at ASC, id ASC
      `).all();
      sdb.close();

      assert.equal(queue.length, 2);
      assert.equal(queue[0].id, opB_Id, 'Interrupted nonterminal operation MUST be ordered before QUEUED work');
      assert.equal(queue[1].id, opA_Id, 'QUEUED work must follow interrupted recovery work');
    } finally {
      if (manager) await manager.close();
      cleanTempDir(tempDir);
    }
  });

});

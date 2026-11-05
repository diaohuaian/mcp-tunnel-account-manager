import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { startManager } from '../../src/main.mjs';
import { SwitchFault } from '../../src/core/switch-core.mjs';

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

async function setupAndAuthenticate(manager, tempDir, password = 'RecoveryTestPassword123!') {
  const bootstrapFile = path.join(tempDir, 'bootstrap-code.txt');
  let bootstrapCode = '';
  if (fs.existsSync(bootstrapFile)) {
    bootstrapCode = fs.readFileSync(bootstrapFile, 'utf8').trim();
  }

  // Setup if not yet configured
  const authState = await sendJsonRequest(manager.url, '/api/auth/state');
  if (!authState.body?.configured && bootstrapCode) {
    const setupRes = await sendJsonRequest(manager.url, '/api/auth/setup', {
      method: 'POST',
      body: {
        bootstrapCode,
        password
      }
    });
    assert.equal(setupRes.status, 200, 'Auth setup should succeed');
  }

  // Login
  const loginRes = await sendJsonRequest(manager.url, '/api/auth/login', {
    method: 'POST',
    body: { password }
  });
  assert.equal(loginRes.status, 200, 'Login should succeed');
  const csrfToken = loginRes.body.csrfToken;
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

async function waitForOperationTerminal(managerUrl, opId, authHeaders, maxAttempts = 50, intervalMs = 50) {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await sendJsonRequest(managerUrl, `/api/operations/${opId}`, {
      headers: authHeaders
    });
    if (res.body && ['SUCCEEDED', 'ROLLED_BACK', 'REJECTED', 'NEEDS_ATTENTION'].includes(res.body.status)) {
      return res.body;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timeout waiting for operation ${opId} to reach terminal state`);
}

function createStrictFakeAdapters({
  actionLog = [],
  applyFailService = null,
  applyError = new SwitchFault('APPLY_FAILED'),
  verifyFailService = null,
  verifyReceiptOverride = null,
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

      async applyIfUnchanged({ operationId, snapshot }) {
        actionLog.push({ type: 'apply', service, operationId });
        if (applyFailService === service) {
          throw applyError;
        }
        return runningProc;
      },

      async verifyDesired({ operationId, snapshot }) {
        actionLog.push({ type: 'verify', service, operationId });
        if (verifyFailService === service) {
          if (verifyReceiptOverride) {
            return verifyReceiptOverride(service, operationId, snapshot);
          }
          return {
            verified: false,
            operationId,
            service,
            configFingerprint: snapshot.desiredFingerprint,
            proof: { kind: 'none' },
            identity: runningProc
          };
        }
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

describe('Service Integration Recovery & Robustness E2E Suite', () => {

  it('handles two-service second-apply failure with exact reverse rollback order', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'service-rec-apply-'));
    let manager = null;

    try {
      const actionLog = [];
      const fakeAdapterFactory = async () => createStrictFakeAdapters({
        actionLog,
        applyFailService: 'antigravity-mcp', // Second target fails during apply
        applyError: new SwitchFault('APPLY_FAILED')
      });

      manager = await startManager({
        dataDir: tempDir,
        host: '127.0.0.1',
        port: 0,
        adapterFactory: fakeAdapterFactory
      });

      const { authHeaders } = await setupAndAuthenticate(manager, tempDir);

      // Create a profile with both services
      const createRes = await sendJsonRequest(manager.url, '/api/profiles', {
        method: 'POST',
        headers: authHeaders,
        body: {
          label: 'Two Service Rollback Test Profile',
          services: {
            'overleaf-mcp': { tunnelId: 'tunnel_overleaf_1', apiKey: 'sec_key_1' },
            'antigravity-mcp': { tunnelId: 'tunnel_antigravity_1', apiKey: 'sec_key_2' }
          }
        }
      });
      assert.equal(createRes.status, 200);
      const profileId = createRes.body.id;

      // Trigger switch with both services
      const switchRes = await sendJsonRequest(manager.url, '/api/switch', {
        method: 'POST',
        headers: {
          ...authHeaders,
          'Idempotency-Key': 'second-apply-fail-key'
        },
        body: {
          profileId,
          targets: ['overleaf-mcp', 'antigravity-mcp']
        }
      });
      assert.equal(switchRes.status, 202);
      const opId = switchRes.body.operation.id;

      // Wait for terminal state
      const terminalOp = await waitForOperationTerminal(manager.url, opId, authHeaders);
      assert.equal(terminalOp.status, 'ROLLED_BACK', 'Operation must transition to ROLLED_BACK');
      assert.equal(terminalOp.failureCode, 'APPLY_FAILED', 'Failure code must reflect the apply fault');

      // Verify reverse rollback order in actionLog
      const restoreEvents = actionLog.filter((e) => e.type === 'restore').map((e) => e.service);
      assert.deepEqual(
        restoreEvents,
        ['antigravity-mcp', 'overleaf-mcp'],
        'Rollback must execute in reverse order of orderedTargets'
      );

      // Verify active profiles did not commit the failed profile
      const stateRes = await sendJsonRequest(manager.url, '/api/state', {
        headers: authHeaders
      });
      assert.equal(stateRes.status, 200);
      const activeOverleaf = stateRes.body.services.find((s) => s.service === 'overleaf-mcp')?.activeProfileId;
      const activeAntigravity = stateRes.body.services.find((s) => s.service === 'antigravity-mcp')?.activeProfileId;
      assert.notEqual(activeOverleaf, profileId, 'overleaf-mcp must not be activated with failed profile');
      assert.notEqual(activeAntigravity, profileId, 'antigravity-mcp must not be activated with failed profile');
    } finally {
      if (manager) await manager.close();
      try {
        if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  it('handles negative verification receipt and executes full rollback', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'service-rec-verify-'));
    let manager = null;

    try {
      const actionLog = [];
      const fakeAdapterFactory = async () => createStrictFakeAdapters({
        actionLog,
        verifyFailService: 'overleaf-mcp', // Target fails verification check
        verifyReceiptOverride: (service, operationId, snapshot) => ({
          verified: false,
          operationId,
          service,
          configFingerprint: snapshot.desiredFingerprint,
          proof: { kind: 'unauthenticated' },
          identity: { pid: -1 }
        })
      });

      manager = await startManager({
        dataDir: tempDir,
        host: '127.0.0.1',
        port: 0,
        adapterFactory: fakeAdapterFactory
      });

      const { authHeaders } = await setupAndAuthenticate(manager, tempDir);

      const createRes = await sendJsonRequest(manager.url, '/api/profiles', {
        method: 'POST',
        headers: authHeaders,
        body: {
          label: 'Negative Verify Profile',
          services: {
            'overleaf-mcp': { tunnelId: 'tunnel_o2', apiKey: 'sec_key_o2' },
            'antigravity-mcp': { tunnelId: 'tunnel_a2', apiKey: 'sec_key_a2' }
          }
        }
      });
      assert.equal(createRes.status, 200);
      const profileId = createRes.body.id;

      const switchRes = await sendJsonRequest(manager.url, '/api/switch', {
        method: 'POST',
        headers: {
          ...authHeaders,
          'Idempotency-Key': 'negative-verify-key'
        },
        body: {
          profileId,
          targets: ['overleaf-mcp', 'antigravity-mcp']
        }
      });
      assert.equal(switchRes.status, 202);
      const opId = switchRes.body.operation.id;

      const terminalOp = await waitForOperationTerminal(manager.url, opId, authHeaders);
      assert.equal(terminalOp.status, 'ROLLED_BACK', 'Operation must roll back on unconfirmed verification');
      assert.equal(terminalOp.failureCode, 'TARGET_VERIFICATION_UNCONFIRMED');

      const restoreEvents = actionLog.filter((e) => e.type === 'restore').map((e) => e.service);
      assert.deepEqual(
        restoreEvents,
        ['antigravity-mcp', 'overleaf-mcp'],
        'Rollback must restore both mutated targets in reverse order'
      );
    } finally {
      if (manager) await manager.close();
      try {
        if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  it('rejects duplicate idempotency key when request body conflicts, accepts identical replay', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'service-rec-idem-'));
    let manager = null;

    try {
      const fakeAdapterFactory = async () => createStrictFakeAdapters();
      manager = await startManager({
        dataDir: tempDir,
        host: '127.0.0.1',
        port: 0,
        adapterFactory: fakeAdapterFactory
      });

      const { authHeaders } = await setupAndAuthenticate(manager, tempDir);

      const p1Res = await sendJsonRequest(manager.url, '/api/profiles', {
        method: 'POST',
        headers: authHeaders,
        body: {
          label: 'Idempotency Profile 1',
          services: {
            'overleaf-mcp': { tunnelId: 'tunnel_idem_1', apiKey: 'key_1' }
          }
        }
      });
      const profileId1 = p1Res.body.id;

      const p2Res = await sendJsonRequest(manager.url, '/api/profiles', {
        method: 'POST',
        headers: authHeaders,
        body: {
          label: 'Idempotency Profile 2',
          services: {
            'overleaf-mcp': { tunnelId: 'tunnel_idem_2', apiKey: 'key_2' }
          }
        }
      });
      const profileId2 = p2Res.body.id;

      const testIdemKey = 'unique-client-idempotency-key-42';

      // 1. Initial request with key and body A
      const req1 = await sendJsonRequest(manager.url, '/api/switch', {
        method: 'POST',
        headers: {
          ...authHeaders,
          'Idempotency-Key': testIdemKey
        },
        body: {
          profileId: profileId1,
          targets: ['overleaf-mcp']
        }
      });
      assert.equal(req1.status, 202, 'First request should be accepted');
      const op1Id = req1.body.operation.id;

      // 2. Conflicting request with SAME key but different profileId
      const reqConflict = await sendJsonRequest(manager.url, '/api/switch', {
        method: 'POST',
        headers: {
          ...authHeaders,
          'Idempotency-Key': testIdemKey
        },
        body: {
          profileId: profileId2, // Conflicting profileId
          targets: ['overleaf-mcp']
        }
      });
      assert.equal(reqConflict.status, 409, 'Conflicting request must be rejected with 409 Conflict');
      assert.equal(
        reqConflict.body?.error?.code,
        'IDEMPOTENCY_CONFLICT',
        'Error code must indicate idempotency conflict'
      );

      // 3. Conflicting request with SAME key but different targets
      const reqConflictTargets = await sendJsonRequest(manager.url, '/api/switch', {
        method: 'POST',
        headers: {
          ...authHeaders,
          'Idempotency-Key': testIdemKey
        },
        body: {
          profileId: profileId1,
          targets: ['overleaf-mcp', 'antigravity-mcp'] // Conflicting targets
        }
      });
      assert.equal(reqConflictTargets.status, 409);
      assert.equal(reqConflictTargets.body?.error?.code, 'IDEMPOTENCY_CONFLICT');

      // 4. Identical request with SAME key and SAME body
      const reqReplay = await sendJsonRequest(manager.url, '/api/switch', {
        method: 'POST',
        headers: {
          ...authHeaders,
          'Idempotency-Key': testIdemKey
        },
        body: {
          profileId: profileId1,
          targets: ['overleaf-mcp']
        }
      });
      assert.equal(reqReplay.status, 202, 'Identical replay must return accepted operation');
      assert.equal(reqReplay.body.operation.id, op1Id, 'Replay must return original operation instance');
    } finally {
      if (manager) await manager.close();
      try {
        if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  it('rejects switch requests with stale expected global revision or profile revision', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'service-rec-rev-'));
    let manager = null;

    try {
      const fakeAdapterFactory = async () => createStrictFakeAdapters();
      manager = await startManager({
        dataDir: tempDir,
        host: '127.0.0.1',
        port: 0,
        adapterFactory: fakeAdapterFactory
      });

      const { authHeaders } = await setupAndAuthenticate(manager, tempDir);

      const pRes = await sendJsonRequest(manager.url, '/api/profiles', {
        method: 'POST',
        headers: authHeaders,
        body: {
          label: 'Revision Test Profile',
          services: {
            'overleaf-mcp': { tunnelId: 'tunnel_rev_test', apiKey: 'sec_key' }
          }
        }
      });
      const profileId = pRes.body.id;

      // Check current global revision
      const stateRes = await sendJsonRequest(manager.url, '/api/state', {
        headers: authHeaders
      });
      const currentRev = stateRes.body.revision;
      assert.ok(typeof currentRev === 'number');

      // Attempt switch with mismatched expectedRevision
      const staleGlobalRes = await sendJsonRequest(manager.url, '/api/switch', {
        method: 'POST',
        headers: {
          ...authHeaders,
          'Idempotency-Key': 'stale-global-rev-key'
        },
        body: {
          profileId,
          expectedRevision: currentRev + 100 // Stale revision
        }
      });
      assert.equal(staleGlobalRes.status, 409, 'Mismatched expectedRevision must be rejected with 409');
      assert.equal(staleGlobalRes.body?.error?.code, 'CONFLICT');

      // Attempt switch with mismatched profileRevision
      const staleProfileRevRes = await sendJsonRequest(manager.url, '/api/switch', {
        method: 'POST',
        headers: {
          ...authHeaders,
          'Idempotency-Key': 'stale-profile-rev-key'
        },
        body: {
          profileId,
          profileRevision: 999 // Non-existent profile revision
        }
      });
      assert.equal(staleProfileRevRes.status, 409, 'Mismatched profileRevision must be rejected with 409');
      assert.equal(staleProfileRevRes.body?.error?.code, 'CONFLICT');
    } finally {
      if (manager) await manager.close();
      try {
        if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  it('recovers interrupted operations on startup, enforces recovery gate on failure and allows recovery gate reset', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'service-rec-interrupted-'));
    let manager1 = null;
    let manager2 = null;
    let manager3 = null;

    try {
      // Phase 1: Set up manager1, configure auth and profile
      const actionLog1 = [];
      manager1 = await startManager({
        dataDir: tempDir,
        host: '127.0.0.1',
        port: 0,
        adapterFactory: async () => createStrictFakeAdapters({ actionLog: actionLog1 })
      });

      const { authHeaders } = await setupAndAuthenticate(manager1, tempDir);

      const pRes = await sendJsonRequest(manager1.url, '/api/profiles', {
        method: 'POST',
        headers: authHeaders,
        body: {
          label: 'Interrupted Test Profile',
          services: {
            'overleaf-mcp': { tunnelId: 'tunnel_inter_1', apiKey: 'sec_1' },
            'antigravity-mcp': { tunnelId: 'tunnel_inter_2', apiKey: 'sec_2' }
          }
        }
      });
      assert.equal(pRes.status, 200);
      const profileId = pRes.body.id;

      // Create operation 1 with prepared snapshots
      const store1 = manager1.store;
      const op1 = store1.createOperation({
        profileId,
        targets: ['overleaf-mcp', 'antigravity-mcp']
      });
      const op1Id = op1.id;

      store1.begin(op1Id);
      const fakeSnapshot1 = {
        operationId: op1Id,
        service: 'overleaf-mcp',
        originalFingerprint: '3'.repeat(64),
        desiredFingerprint: '4'.repeat(64)
      };
      const fakeSnapshot2 = {
        operationId: op1Id,
        service: 'antigravity-mcp',
        originalFingerprint: '5'.repeat(64),
        desiredFingerprint: '6'.repeat(64)
      };
      await store1.prepared(op1Id, 'overleaf-mcp', fakeSnapshot1);
      await store1.prepared(op1Id, 'antigravity-mcp', fakeSnapshot2);
      store1.markMayMutate(op1Id, 'overleaf-mcp');
      store1.markMayMutate(op1Id, 'antigravity-mcp');

      // Close manager1 cleanly
      await manager1.close();
      manager1 = null;

      // Simulate a crashed/interrupted state by directly setting status to APPLYING in SQLite
      const dbPath = path.join(tempDir, 'manager.db');
      const directDb1 = new DatabaseSync(dbPath);
      directDb1.prepare("UPDATE operations SET status = 'APPLYING', failure_code = NULL WHERE id = ?").run(op1Id);
      directDb1.close();

      // Phase 2: Start manager2 on the same dataDir with a clean restoring adapter
      const actionLog2 = [];
      manager2 = await startManager({
        dataDir: tempDir,
        host: '127.0.0.1',
        port: 0,
        adapterFactory: async () => createStrictFakeAdapters({ actionLog: actionLog2 })
      });

      const auth2 = await setupAndAuthenticate(manager2, tempDir);

      // Verify startup recovery automatically rolled back op1 during runner.start()
      const op1Recovered = await manager2.store.load(op1Id);
      assert.equal(op1Recovered.status, 'ROLLED_BACK', 'Interrupted operation must be ROLLED_BACK upon startup');
      assert.equal(op1Recovered.failureCode, 'INTERRUPTED', 'Failure code must be INTERRUPTED');

      // Verify restore order during interrupted startup recovery
      const restoreEvents = actionLog2.filter((e) => e.type === 'restore').map((e) => e.service);
      assert.deepEqual(
        restoreEvents,
        ['antigravity-mcp', 'overleaf-mcp'],
        'Startup recovery must roll back mutated steps in reverse order'
      );

      // Verify recovery gate is NOT active
      const state2 = await sendJsonRequest(manager2.url, '/api/state', {
        headers: auth2.authHeaders
      });
      assert.equal(state2.status, 200);
      assert.equal(state2.body.recovery?.gated, false, 'Recovery gate must not be active when restore succeeded');

      // Phase 3: Now simulate an interrupted operation where restore fails, triggering the RECOVERY GATE
      const op2 = manager2.store.createOperation({
        profileId,
        targets: ['overleaf-mcp', 'antigravity-mcp']
      });
      const op2Id = op2.id;
      manager2.store.begin(op2Id);
      const fakeSnapshot3 = {
        operationId: op2Id,
        service: 'overleaf-mcp',
        originalFingerprint: '7'.repeat(64),
        desiredFingerprint: '8'.repeat(64)
      };
      const fakeSnapshot4 = {
        operationId: op2Id,
        service: 'antigravity-mcp',
        originalFingerprint: '9'.repeat(64),
        desiredFingerprint: 'a'.repeat(64)
      };
      await manager2.store.prepared(op2Id, 'overleaf-mcp', fakeSnapshot3);
      await manager2.store.prepared(op2Id, 'antigravity-mcp', fakeSnapshot4);
      manager2.store.markMayMutate(op2Id, 'overleaf-mcp');
      manager2.store.markMayMutate(op2Id, 'antigravity-mcp');

      await manager2.close();
      manager2 = null;

      // Mark op2 as interrupted in SQLite
      const directDb2 = new DatabaseSync(dbPath);
      directDb2.prepare("UPDATE operations SET status = 'APPLYING', failure_code = NULL WHERE id = ?").run(op2Id);
      directDb2.close();

      // Start manager3 with an adapter whose restore fails
      const actionLog3 = [];
      manager3 = await startManager({
        dataDir: tempDir,
        host: '127.0.0.1',
        port: 0,
        adapterFactory: async () => createStrictFakeAdapters({
          actionLog: actionLog3,
          restoreFailService: 'antigravity-mcp',
          restoreError: new SwitchFault('HARDWARE_DISCONNECTED')
        })
      });

      const auth3 = await setupAndAuthenticate(manager3, tempDir);

      // Op2 must end in NEEDS_ATTENTION
      const op2Recovered = await manager3.store.load(op2Id);
      assert.equal(op2Recovered.status, 'NEEDS_ATTENTION', 'Failed restore must transition op to NEEDS_ATTENTION');

      // Recovery gate must now be ACTIVE
      const gatedStateRes = await sendJsonRequest(manager3.url, '/api/state', {
        headers: auth3.authHeaders
      });
      assert.equal(gatedStateRes.status, 200);
      assert.equal(gatedStateRes.body.recovery?.gated, true, 'Recovery gate must be active');
      assert.ok(
        gatedStateRes.body.recovery?.reason?.includes('NEEDS_ATTENTION'),
        'Recovery reason must explain NEEDS_ATTENTION'
      );

      // Attempt switch while recovery gate is active -> MUST be rejected with 409 RECOVERY_GATED
      const blockedSwitchRes = await sendJsonRequest(manager3.url, '/api/switch', {
        method: 'POST',
        headers: {
          ...auth3.authHeaders,
          'Idempotency-Key': 'blocked-by-recovery-gate-key'
        },
        body: {
          profileId,
          targets: ['overleaf-mcp']
        }
      });
      assert.equal(blockedSwitchRes.status, 409, 'Switch must be blocked when recovery gate is active');
      assert.equal(
        blockedSwitchRes.body?.error?.code,
        'RECOVERY_GATED',
        'Error code must be RECOVERY_GATED'
      );

      // Phase 4: Reset recovery gate and verify persistent gate behavior
      manager3.store.resetRecoveryGate();

      const clearedStateRes = await sendJsonRequest(manager3.url, '/api/state', {
        headers: auth3.authHeaders
      });
      assert.equal(clearedStateRes.status, 200);
      assert.equal(clearedStateRes.body.recovery?.gated, false, 'Recovery metadata gate must be cleared');

      // The persistent recovery gate in assertIdle must still detect the NEEDS_ATTENTION operation
      // in the database and reject new switch work with 409 RECOVERY_GATED.
      const stillBlockedSwitchRes = await sendJsonRequest(manager3.url, '/api/switch', {
        method: 'POST',
        headers: {
          ...auth3.authHeaders,
          'Idempotency-Key': 'still-blocked-switch-key'
        },
        body: {
          profileId,
          targets: ['overleaf-mcp']
        }
      });
      assert.equal(stillBlockedSwitchRes.status, 409, 'Switch must still be blocked while NEEDS_ATTENTION operation exists');
      assert.equal(
        stillBlockedSwitchRes.body?.error?.code,
        'RECOVERY_GATED',
        'Error code must remain RECOVERY_GATED'
      );

      // Once the attention item is resolved by an operator (updating terminal state to ROLLED_BACK),
      // assertIdle allows new work to proceed.
      const directDb3 = new DatabaseSync(dbPath);
      directDb3.prepare("UPDATE operations SET status = 'ROLLED_BACK' WHERE id = ?").run(op2Id);
      directDb3.close();

      // Now switch can be queued without 409 RECOVERY_GATED
      const unblockedSwitchRes = await sendJsonRequest(manager3.url, '/api/switch', {
        method: 'POST',
        headers: {
          ...auth3.authHeaders,
          'Idempotency-Key': 'unblocked-switch-key'
        },
        body: {
          profileId,
          targets: ['overleaf-mcp']
        }
      });
      assert.equal(unblockedSwitchRes.status, 202, 'Switch should be accepted once recovery gate is cleared and attention resolved');
    } finally {
      if (manager1) await manager1.close();
      if (manager2) await manager2.close();
      if (manager3) await manager3.close();
      try {
        if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

});

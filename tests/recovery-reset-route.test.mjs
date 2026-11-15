/**
 * POST /api/recovery/reset is the console's "close the gate, touch nothing else" path.
 * It exists because the zero-effect acknowledge route refuses real effect failures
 * (EXECUTABLE_NOT_FOUND et al.), and the only other reset — /api/tunnel-clients/stop-all
 * — kills every tunnel-client first.
 *
 * These cases pin the properties that make it safe: authentication + CSRF, an explicit
 * confirm flag, a 409 when nothing is gated, and a SQLite backup before the write.
 * Everything runs on ephemeral ports under os.tmpdir(); no real tunnel is touched.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { startManager } from '../src/main.mjs';
import { backupSqliteFiles } from '../src/core/sqlite-backup.mjs';

const tempParent = fs.realpathSync(os.tmpdir());
const temporary = fs.mkdtempSync(path.join(tempParent, 'mcp-recovery-reset-test-'));

after(() => {
  const resolved = fs.realpathSync(temporary);
  assert.equal(path.dirname(resolved).toLowerCase(), tempParent.toLowerCase());
  assert.ok(path.basename(resolved).startsWith('mcp-recovery-reset-test-'));
  fs.rmSync(resolved, { recursive: true, force: true });
});

test('backupSqliteFiles copies the database triple and skips missing files', () => {
  const dir = path.join(temporary, 'backup-src');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manager.db'), 'db');
  fs.writeFileSync(path.join(dir, 'manager.db-wal'), 'wal');

  const written = backupSqliteFiles(dir, { stamp: '20260101-000000' });

  assert.equal(written.length, 2, 'only files that exist are copied');
  for (const file of written) {
    assert.ok(fs.existsSync(file), file);
    assert.match(path.basename(file), /^manager\.db(-wal)?\.20260101-000000\.bak$/);
  }
  assert.deepEqual(backupSqliteFiles('', {}), [], 'no data dir means nothing to copy');
});

test('POST /api/recovery/reset requires auth, CSRF and an explicit confirm', { timeout: 60000 }, async t => {
  const dataDir = path.join(temporary, 'console-data');
  const manager = await startManager({ port: 0, dataDir });
  t.after(async () => { await manager.close(); });

  const request = async (route, { method = 'GET', body, cookie, csrf } = {}) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    if (csrf) headers['x-csrf-token'] = csrf;
    return fetch(manager.url + route, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    });
  };

  const password = crypto.randomBytes(24).toString('hex');
  const setup = await request('/api/auth/setup', {
    method: 'POST',
    body: { bootstrapCode: manager.security.getBootstrapSecret(), password }
  });
  assert.equal(setup.status, 200);
  const login = await request('/api/auth/login', { method: 'POST', body: { password } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const csrf = (await login.json()).csrfToken;
  assert.ok(csrf);

  // Nothing gated yet: an explicit reset is refused instead of silently "succeeding".
  const clean = await request('/api/recovery/reset', { method: 'POST', cookie, csrf, body: { confirm: true } });
  assert.equal(clean.status, 409);
  assert.equal((await clean.json()).code, 'ACTION_NOT_AWAITING_RECOVERY');

  // Reproduce the shape of a real effect failure gate.
  manager.repo.setRecoveryGate(
    'Operation cb83d98a-e938-4f9e-aedf-f980df4201a8 ended in NEEDS_ATTENTION: EXECUTABLE_NOT_FOUND'
  );
  assert.equal(manager.repo.getRecoveryState().gated, true);

  const noCsrf = await request('/api/recovery/reset', { method: 'POST', cookie, body: { confirm: true } });
  assert.equal(noCsrf.status, 403, 'CSRF must be enforced');

  const noConfirm = await request('/api/recovery/reset', { method: 'POST', cookie, csrf, body: {} });
  assert.equal(noConfirm.status, 400);
  assert.equal((await noConfirm.json()).code, 'CONFIRMATION_REQUIRED');
  assert.equal(manager.repo.getRecoveryState().gated, true, 'a refused call must not clear the gate');

  const reset = await request('/api/recovery/reset', { method: 'POST', cookie, csrf, body: { confirm: true } });
  assert.equal(reset.status, 200);
  const payload = await reset.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.code, 'RECOVERY_GATE_RESET');
  assert.equal(payload.gate.gated, false);
  assert.equal(manager.repo.getRecoveryState().gated, false);
  assert.ok(payload.backedUpFiles.length > 0, 'the database must be backed up before the write');
  for (const file of payload.backedUpFiles) {
    assert.ok(fs.existsSync(file), file);
    assert.ok(file.includes(path.join('backup', 'manager.db')), file);
  }
});

import httpMod from 'node:http';
import fsMod from 'node:fs';
import osMod from 'node:os';
import pathMod from 'node:path';
import nodeTest from 'node:test';
import nodeAssert from 'node:assert/strict';
import { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';

import { createHttpServer as createRecoveryTestHttpServer } from '../src/server.mjs';
import { openStore as openRecoveryTestStore } from '../src/store.mjs';
import { createVault as createRecoveryTestVault } from '../src/vault.mjs';
import { buildInstanceId as buildRecoveryTestInstanceId } from '../src/core/concurrent-instances.mjs';

function createResetMockSecurity() {
  return {
    guard: async () => true,
    state: async () => ({ configured: true, authenticated: true, csrfToken: 'mock-csrf' }),
    setup: async () => ({ ok: true }),
    login: async () => ({ ok: true }),
    logout: async () => ({ ok: true }),
    close: async () => {}
  };
}

function sendJsonPost(baseUrl, reqPath, payload) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl);
    const bodyText = JSON.stringify(payload);
    const req = httpMod.request({
      hostname: u.hostname,
      port: u.port,
      path: reqPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyText),
        'X-CSRF-Token': 'mock-csrf'
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch {}
        resolve({ statusCode: res.statusCode, body: parsed, rawBody: raw });
      });
    });
    req.on('error', reject);
    req.write(bodyText);
    req.end();
  });
}

async function listenHttpTestServer(options) {
  const server = createRecoveryTestHttpServer({
    security: createResetMockSecurity(),
    ...options
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    })
  };
}

nodeTest('POST /api/recovery/reset clears legacy operations and instance gates without calling taskkill/listPids or touching running runtime/active_profiles', async (t) => {
  const root = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'recovery-reset-route-'));
  const dataDir = pathMod.join(root, 'data');
  fsMod.mkdirSync(dataDir, { recursive: true });
  const vault = createRecoveryTestVault({ dataDir });
  const store = openRecoveryTestStore({ dataDir, vault });

  t.after(() => {
    try { store.close(); } catch {}
    try { vault.close(); } catch {}
    try { fsMod.rmSync(root, { recursive: true, force: true }); } catch {}
  });

  const serviceId = 'mcp_reset_svc';
  const profileId = 'acct-reset';
  const instanceId = buildRecoveryTestInstanceId(serviceId, profileId);
  await store.registry.create({
    id: serviceId,
    label: 'Reset Test MCP',
    enabled: true,
    binding: { type: 'stdio', executable: 'node', args: [] }
  });
  await store.createProfile({
    id: profileId,
    label: 'Account Reset',
    services: { [serviceId]: { tunnelId: 't_reset', apiKey: 'k_reset' } }
  });

  const act = await store.registry.createLifecycleAction({
    action: 'start',
    serviceId,
    profileId,
    instanceId
  });
  await store.registry.markActionAttention(act.id, 'INTERRUPTED');
  store.upsertInstanceRuntime(instanceId, {
    serviceId,
    profileId,
    state: 'running',
    pid: 424242,
    owned: true,
    identityVerified: true
  });

  const nowIso = new Date().toISOString();
  const seedDb = new NodeDatabaseSync(pathMod.join(dataDir, 'manager.db'));
  try {
    seedDb.prepare(`
      INSERT INTO operations (
        id, profile_id, profile_revision, targets, expected_revision,
        idempotency_key, request_payload, pinned_credentials,
        sealed_registry_snapshot, status, failure_code, failure_service, failure_reason,
        created_at, updated_at
      ) VALUES (?, ?, 1, ?, 1, NULL, '{}', '{}', NULL, 'NEEDS_ATTENTION', 'INTERRUPTED', ?, 'manual interrupt', ?, ?)
    `).run('op_reset_legacy_1', profileId, JSON.stringify([serviceId]), serviceId, nowIso, nowIso);

    const activeCols = seedDb.prepare("PRAGMA table_info('active_profiles')").all().map((c) => c.name);
    const activeValues = {
      service_id: serviceId,
      profile_id: profileId,
      profile_revision: 1,
      service_revision: 1,
      updated_at: nowIso,
      switched_at: nowIso,
      activated_at: nowIso
    };
    const colsToInsert = activeCols.filter((c) => Object.prototype.hasOwnProperty.call(activeValues, c));
    seedDb.prepare(
      `INSERT OR REPLACE INTO active_profiles (${colsToInsert.join(', ')}) VALUES (${colsToInsert.map(() => '?').join(', ')})`
    ).run(...colsToInsert.map((c) => activeValues[c]));
  } finally {
    seedDb.close();
  }

  let lockCalls = 0;
  let taskkillCalls = 0;
  let listPidsCalls = 0;
  const runner = {
    deps: {
      withExclusiveLock: async (fn) => {
        lockCalls += 1;
        return fn();
      }
    },
    getRecoveryState: () => ({ phase: 'idle' })
  };

  const srv = await listenHttpTestServer({
    repo: store,
    runner,
    dataDir,
    tunnelClientOps: {
      taskkill: async () => { taskkillCalls += 1; },
      listPids: async () => { listPidsCalls += 1; return []; }
    }
  });
  t.after(() => srv.close());

  // Missing confirm: true must fail and leave gate intact
  const rejectedRes = await sendJsonPost(srv.baseUrl, '/api/recovery/reset', { confirm: false });
  nodeAssert.equal(rejectedRes.statusCode, 400);
  nodeAssert.equal(rejectedRes.body?.ok, false);
  nodeAssert.equal(store.getRecoveryState().gated, true);

  // Confirm reset succeeds under lock with automatic backup and zero process kills/probes
  const resetRes = await sendJsonPost(srv.baseUrl, '/api/recovery/reset', { confirm: true });
  nodeAssert.equal(resetRes.statusCode, 200);
  nodeAssert.equal(resetRes.body?.ok, true);
  nodeAssert.equal(resetRes.body?.code, 'RECOVERY_GATE_RESET');
  nodeAssert.equal(resetRes.body?.clearedActions, 1);
  nodeAssert.equal(resetRes.body?.clearedOperations, 1);
  nodeAssert.equal(resetRes.body?.gate?.gated, false);
  nodeAssert.ok(Array.isArray(resetRes.body?.backedUpFiles) && resetRes.body.backedUpFiles.length >= 1);
  for (const backedUpFile of resetRes.body.backedUpFiles) {
    const candidate = pathMod.isAbsolute(backedUpFile)
      ? backedUpFile
      : pathMod.join(dataDir, 'backup', pathMod.basename(backedUpFile));
    nodeAssert.equal(fsMod.existsSync(candidate), true, `backup file should exist: ${candidate}`);
  }

  nodeAssert.equal(lockCalls, 1);
  nodeAssert.equal(taskkillCalls, 0);
  nodeAssert.equal(listPidsCalls, 0);
  nodeAssert.equal(store.getRecoveryState().gated, false);

  const rtAfter = store.getInstanceRuntime(instanceId);
  nodeAssert.equal(rtAfter?.state, 'running');
  nodeAssert.equal(rtAfter?.pid, 424242);

  const verifyDb = new NodeDatabaseSync(pathMod.join(dataDir, 'manager.db'));
  try {
    const opRow = verifyDb.prepare('SELECT status FROM operations WHERE id = ?').get('op_reset_legacy_1');
    const actRow = verifyDb.prepare('SELECT state FROM mcp_actions WHERE id = ?').get(act.id);
    const gateCount = verifyDb.prepare('SELECT COUNT(*) AS cnt FROM recovery_gates').get();
    const activeRow = verifyDb.prepare('SELECT profile_id FROM active_profiles WHERE service_id = ?').get(serviceId);
    nodeAssert.equal(opRow?.status, 'REJECTED');
    nodeAssert.equal(actRow?.state, 'REJECTED');
    nodeAssert.equal(gateCount?.cnt, 0);
    nodeAssert.equal(activeRow?.profile_id, profileId);
  } finally {
    verifyDb.close();
  }
});

nodeTest('POST /api/recovery/reset fails closed with HTTP 500 RECOVERY_BACKUP_UNAVAILABLE when dataDir is missing', async (t) => {
  const root = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'recovery-reset-nodatadir-'));
  const dataDir = pathMod.join(root, 'data');
  fsMod.mkdirSync(dataDir, { recursive: true });
  const vault = createRecoveryTestVault({ dataDir });
  const store = openRecoveryTestStore({ dataDir, vault });

  t.after(() => {
    try { store.close(); } catch {}
    try { vault.close(); } catch {}
    try { fsMod.rmSync(root, { recursive: true, force: true }); } catch {}
  });

  const serviceId = 'mcp_nodir_svc';
  const profileId = 'acct-nodir';
  await store.registry.create({
    id: serviceId,
    label: 'NoDataDir MCP',
    enabled: true,
    binding: { type: 'stdio', executable: 'node', args: [] }
  });
  await store.createProfile({
    id: profileId,
    label: 'Account NoDir',
    services: { [serviceId]: { tunnelId: 't_nodir', apiKey: 'k_nodir' } }
  });
  const act = await store.registry.createLifecycleAction({
    action: 'start',
    serviceId,
    profileId,
    instanceId: buildRecoveryTestInstanceId(serviceId, profileId)
  });
  await store.registry.markActionAttention(act.id, 'INTERRUPTED');

  let taskkillCalls = 0;
  let listPidsCalls = 0;
  const srv = await listenHttpTestServer({
    repo: store,
    runner: {
      deps: { withExclusiveLock: async (fn) => fn() },
      getRecoveryState: () => ({ phase: 'idle' })
    },
    tunnelClientOps: {
      taskkill: async () => { taskkillCalls += 1; },
      listPids: async () => { listPidsCalls += 1; return []; }
    }
  });
  t.after(() => srv.close());

  const res = await sendJsonPost(srv.baseUrl, '/api/recovery/reset', { confirm: true });
  nodeAssert.equal(res.statusCode, 500);
  nodeAssert.equal(res.body?.ok, false);
  nodeAssert.equal(res.body?.code, 'RECOVERY_BACKUP_UNAVAILABLE');
  nodeAssert.equal(store.getRecoveryState().gated, true);
  nodeAssert.equal(taskkillCalls, 0);
  nodeAssert.equal(listPidsCalls, 0);
});

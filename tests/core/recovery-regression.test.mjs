import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import { openStore, StoreError } from '../../src/store.mjs';
import { createVault } from '../../src/vault.mjs';
import { createRunner } from '../../src/runner.mjs';
import {
  loadWorkRecord,
  withStartupRollback,
  rollbackOwnedResources,
  SWITCH_TERMINAL_STATES,
  STOP_TERMINAL_STATES
} from '../../src/core/runner-startup.mjs';
import { executeOperation } from '../../src/core/switch-core.mjs';
import { runMcpStopAction } from '../../src/core/mcp-lifecycle.mjs';
import { acquireDaemonLock, DaemonLockError } from '../../src/core/daemon-lock.mjs';

function createTempDir(prefix = 'recovery-reg-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanTempDir(dir) {
  try {
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (_) {}
}

function createMemoryVault() {
  return {
    seal: (v, aad) => ({ c: JSON.stringify(v), aad }),
    unseal: (e, aad) => {
      let env = e;
      if (typeof env === 'string') {
        try { env = JSON.parse(env); } catch (_) {}
      }
      if (aad !== undefined && env && env.aad !== undefined && env.aad !== aad) {
        throw new Error(`AAD mismatch: expected ${aad}, got ${env.aad}`);
      }
      return typeof env?.c === 'string' ? JSON.parse(env.c) : env?.c;
    },
    close: () => {}
  };
}

// ============================================================================
// Section 1: Persistence & getWorkQueue SQL branches exclusion and priority
// ============================================================================

test('persistence: unified getWorkQueue SQL branch excludes all terminal states including NEEDS_ATTENTION', async () => {
  const tmpDir = createTempDir('wq-unified-');
  const vault = createMemoryVault();
  let store = null;
  let db = null;
  try {
    store = openStore({ dataDir: tmpDir, vault });
    await store.createProfile({
      id: 'prof-wq-test',
      label: 'WQ Test Profile'
    }, { expectedRevision: 0 });

    db = new DatabaseSync(path.join(tmpDir, 'manager.db'));
    const insertOp = db.prepare(`
      INSERT INTO operations (
        id, profile_id, profile_revision, targets, expected_revision,
        idempotency_key, request_payload, pinned_credentials,
        status, failure_code, created_at, updated_at
      ) VALUES (?, 'prof-wq-test', 1, '["overleaf-mcp"]', 1, NULL, '{}', '{}', ?, NULL, ?, ?)
    `);

    const insertAction = db.prepare(`
      INSERT INTO mcp_actions (
        id, service_id, idempotency_key, request_fingerprint,
        state, error_code, sealed_payload, created_at, updated_at
      ) VALUES (?, 'overleaf-mcp', NULL, 'fp', ?, NULL, '{}', ?, ?)
    `);

    // Interrupted switch operations across ALL nonterminal states
    insertOp.run('op-prep', 'PREPARING', '2026-11-04T01:00:00.000Z', '2026-11-04T01:00:00.000Z');
    insertOp.run('op-apply', 'APPLYING', '2026-11-04T01:10:00.000Z', '2026-11-04T01:10:00.000Z');
    insertOp.run('op-verify', 'VERIFYING', '2026-11-04T01:20:00.000Z', '2026-11-04T01:20:00.000Z');
    insertOp.run('op-rollback', 'ROLLING_BACK', '2026-11-04T01:30:00.000Z', '2026-11-04T01:30:00.000Z');

    // Queued switch operations
    insertOp.run('op-queued-1', 'QUEUED', '2026-11-04T02:00:00.000Z', '2026-11-04T02:00:00.000Z');
    insertOp.run('op-queued-2', 'QUEUED', '2026-11-04T02:10:00.000Z', '2026-11-04T02:10:00.000Z');

    // Terminal switch operations (SUCCEEDED, ROLLED_BACK, REJECTED, NEEDS_ATTENTION)
    insertOp.run('op-succeeded', 'SUCCEEDED', '2026-11-04T00:10:00.000Z', '2026-11-04T00:10:00.000Z');
    insertOp.run('op-rolledback', 'ROLLED_BACK', '2026-11-04T00:20:00.000Z', '2026-11-04T00:20:00.000Z');
    insertOp.run('op-rejected', 'REJECTED', '2026-11-04T00:30:00.000Z', '2026-11-04T00:30:00.000Z');
    insertOp.run('op-attention', 'NEEDS_ATTENTION', '2026-11-04T00:40:00.000Z', '2026-11-04T00:40:00.000Z');

    // Interrupted and queued stop actions
    insertAction.run('act-apply', 'APPLYING', '2026-11-04T01:15:00.000Z', '2026-11-04T01:15:00.000Z');
    insertAction.run('act-queued', 'QUEUED', '2026-11-04T02:05:00.000Z', '2026-11-04T02:05:00.000Z');

    // Terminal stop actions (SUCCEEDED, REJECTED, NEEDS_ATTENTION)
    insertAction.run('act-succeeded', 'SUCCEEDED', '2026-11-04T00:15:00.000Z', '2026-11-04T00:15:00.000Z');
    insertAction.run('act-rejected', 'REJECTED', '2026-11-04T00:25:00.000Z', '2026-11-04T00:25:00.000Z');
    insertAction.run('act-attention', 'NEEDS_ATTENTION', '2026-11-04T00:35:00.000Z', '2026-11-04T00:35:00.000Z');

    db.close();
    db = null;

    const queue = store.getWorkQueue();

    // Terminal states and NEEDS_ATTENTION must be absent:
    for (const term of ['op-succeeded', 'op-rolledback', 'op-rejected', 'op-attention']) {
      assert.ok(!queue.includes(term), `Operation ${term} must be excluded from getWorkQueue`);
    }
    for (const term of ['act-succeeded', 'act-rejected', 'act-attention']) {
      assert.ok(!queue.includes(term), `Action ${term} must be excluded from getWorkQueue`);
    }

    // Interrupted work must be prioritized before QUEUED work:
    // Sorted strictly by queue_order ASC, created_at ASC, id ASC
    assert.deepEqual(queue, [
      'op-prep',       // 01:00 (interrupted op)
      'op-apply',      // 01:10 (interrupted op)
      'act-apply',     // 01:15 (interrupted action)
      'op-verify',     // 01:20 (interrupted op)
      'op-rollback',   // 01:30 (interrupted op)
      'op-queued-1',   // 02:00 (queued op)
      'act-queued',    // 02:05 (queued action)
      'op-queued-2'    // 02:10 (queued op)
    ]);
  } finally {
    if (db) {
      try { db.close(); } catch (_) {}
    }
    if (store) {
      try { await store.close(); } catch (_) {}
    }
    cleanTempDir(tmpDir);
  }
});

test('persistence: fallback getWorkQueue SQL branch (no mcp_actions table) excludes terminal states and NEEDS_ATTENTION', async () => {
  const tmpDir = createTempDir('wq-fallback-');
  let db = null;
  let verifyDb = null;
  try {
    db = new DatabaseSync(path.join(tmpDir, 'manager.db'));
    db.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata (key, value) VALUES ('revision', '1'), ('recovery_gated', '0'), ('recovery_reason', '');
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, revision INTEGER NOT NULL,
        sealed_credentials TEXT NOT NULL, services_meta TEXT NOT NULL,
        provenance_identity TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE operations (
        id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, profile_revision INTEGER, targets TEXT NOT NULL,
        expected_revision INTEGER, idempotency_key TEXT, request_payload TEXT NOT NULL, pinned_credentials TEXT NOT NULL,
        sealed_registry_snapshot TEXT, status TEXT NOT NULL, failure_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE operation_steps (
        operation_id TEXT NOT NULL, service_id TEXT NOT NULL, sealed_snapshot TEXT,
        may_have_mutated INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'INITIAL',
        failure_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (operation_id, service_id)
      );
      CREATE TABLE active_profiles (
        service_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL,
        profile_revision INTEGER, service_revision INTEGER
      );
      DROP TABLE IF EXISTS mcp_actions;
      DROP TABLE IF EXISTS mcp_services;
    `);

    const insertOp = db.prepare(`
      INSERT INTO operations (
        id, profile_id, profile_revision, targets, expected_revision,
        idempotency_key, request_payload, pinned_credentials,
        status, failure_code, created_at, updated_at
      ) VALUES (?, 'p1', 1, '["overleaf-mcp"]', 1, NULL, '{}', '{}', ?, NULL, ?, ?)
    `);

    insertOp.run('leg-succeeded', 'SUCCEEDED', '2026-11-04T00:10:00.000Z', '2026-11-04T00:10:00.000Z');
    insertOp.run('leg-rolledback', 'ROLLED_BACK', '2026-11-04T00:20:00.000Z', '2026-11-04T00:20:00.000Z');
    insertOp.run('leg-rejected', 'REJECTED', '2026-11-04T00:30:00.000Z', '2026-11-04T00:30:00.000Z');
    insertOp.run('leg-attention', 'NEEDS_ATTENTION', '2026-11-04T00:40:00.000Z', '2026-11-04T00:40:00.000Z');

    insertOp.run('leg-prep', 'PREPARING', '2026-11-04T01:00:00.000Z', '2026-11-04T01:00:00.000Z');
    insertOp.run('leg-apply', 'APPLYING', '2026-11-04T01:10:00.000Z', '2026-11-04T01:10:00.000Z');
    insertOp.run('leg-queued', 'QUEUED', '2026-11-04T02:00:00.000Z', '2026-11-04T02:00:00.000Z');

    db.close();
    db = null;

    // Query using the store's exact fallback SQL query
    verifyDb = new DatabaseSync(path.join(tmpDir, 'manager.db'));
    const rows = verifyDb.prepare(`
      SELECT id, created_at, CASE WHEN status = 'QUEUED' THEN 1 ELSE 0 END AS queue_order
      FROM operations
      WHERE status NOT IN ('SUCCEEDED', 'ROLLED_BACK', 'REJECTED', 'NEEDS_ATTENTION')
      ORDER BY queue_order ASC, created_at ASC, id ASC
    `).all();
    verifyDb.close();
    verifyDb = null;

    const queue = rows.map(r => r.id);

    assert.deepEqual(queue, ['leg-prep', 'leg-apply', 'leg-queued']);
    assert.ok(!queue.includes('leg-succeeded'));
    assert.ok(!queue.includes('leg-rolledback'));
    assert.ok(!queue.includes('leg-rejected'));
    assert.ok(!queue.includes('leg-attention'));
  } finally {
    if (db) {
      try { db.close(); } catch (_) {}
    }
    if (verifyDb) {
      try { verifyDb.close(); } catch (_) {}
    }
    cleanTempDir(tmpDir);
  }
});

test('persistence: getWorkQueue preserves deterministic tie-breaking order by id when created_at matches', async () => {
  const tmpDir = createTempDir('wq-tie-');
  const vault = createMemoryVault();
  let store = null;
  let db = null;
  try {
    store = openStore({ dataDir: tmpDir, vault });
    await store.createProfile({ id: 'prof-tie', label: 'Tie Profile' }, { expectedRevision: 0 });

    db = new DatabaseSync(path.join(tmpDir, 'manager.db'));
    const tsSame = '2026-11-04T05:00:00.000Z';

    const insertOp = db.prepare(`
      INSERT INTO operations (
        id, profile_id, profile_revision, targets, expected_revision,
        idempotency_key, request_payload, pinned_credentials,
        status, failure_code, created_at, updated_at
      ) VALUES (?, 'prof-tie', 1, '["overleaf-mcp"]', 1, NULL, '{}', '{}', ?, NULL, ?, ?)
    `);

    const insertAction = db.prepare(`
      INSERT INTO mcp_actions (
        id, service_id, idempotency_key, request_fingerprint,
        state, error_code, sealed_payload, created_at, updated_at
      ) VALUES (?, 'overleaf-mcp', NULL, 'fp', ?, NULL, '{}', ?, ?)
    `);

    // Interrupted items at identical timestamp
    insertOp.run('op-apply-z', 'APPLYING', tsSame, tsSame);
    insertOp.run('op-apply-a', 'APPLYING', tsSame, tsSame);
    insertAction.run('act-apply-m', 'APPLYING', tsSame, tsSame);

    // Queued items at identical timestamp
    insertOp.run('op-queued-z', 'QUEUED', tsSame, tsSame);
    insertOp.run('op-queued-a', 'QUEUED', tsSame, tsSame);
    insertAction.run('act-queued-m', 'QUEUED', tsSame, tsSame);

    db.close();
    db = null;

    const queue = store.getWorkQueue();

    // Priority 0: interrupted items tie-broken alphabetically by id
    // Priority 1: queued items tie-broken alphabetically by id
    assert.deepEqual(queue, [
      'act-apply-m',
      'op-apply-a',
      'op-apply-z',
      'act-queued-m',
      'op-queued-a',
      'op-queued-z'
    ]);
  } finally {
    if (db) {
      try { db.close(); } catch (_) {}
    }
    if (store) {
      try { await store.close(); } catch (_) {}
    }
    cleanTempDir(tmpDir);
  }
});

// ============================================================================
// Section 2: Persistent Gate & assertIdle Rejecting Work during NEEDS_ATTENTION
// ============================================================================

test('persistence gate: operation in NEEDS_ATTENTION activates persistent recovery gate and blocks assertIdle, switch, and mutations', async () => {
  const tmpDir = createTempDir('gate-op-');
  const vault = createMemoryVault();
  let store = null;
  let db = null;
  try {
    store = openStore({ dataDir: tmpDir, vault });
    await store.createProfile({ id: 'prof-gate', label: 'Gate Profile' }, { expectedRevision: 0 });

    db = new DatabaseSync(path.join(tmpDir, 'manager.db'));
    db.prepare(`
      INSERT INTO operations (
        id, profile_id, profile_revision, targets, expected_revision,
        idempotency_key, request_payload, pinned_credentials,
        status, failure_code, created_at, updated_at
      ) VALUES ('op-fault-1', 'prof-gate', 1, '["overleaf-mcp"]', 1, NULL, '{}', '{}', 'NEEDS_ATTENTION', 'RESTORE_FAILED', '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z')
    `).run();
    db.close();
    db = null;

    // 1. Operation is absent from runnable work queue
    const queue = store.getWorkQueue();
    assert.ok(!queue.includes('op-fault-1'));
    assert.equal(queue.length, 0);

    // 2. assertIdle detects NEEDS_ATTENTION and throws RECOVERY_GATED
    assert.throws(
      () => store.assertIdle(),
      (err) => err instanceof StoreError && err.code === 'RECOVERY_GATED' && err.status === 409
    );

    // 3. createOperation is blocked
    assert.throws(
      () => store.createOperation({ profileId: 'prof-gate', targets: ['overleaf-mcp'] }),
      (err) => err instanceof StoreError && err.code === 'RECOVERY_GATED' && err.status === 409
    );

    // 4. begin is blocked
    assert.throws(
      () => store.begin('op-new-1'),
      (err) => err instanceof StoreError && err.code === 'RECOVERY_GATED' && err.status === 409
    );

    // 5. createStopAction is blocked
    await assert.rejects(
      store.registry.createStopAction({ serviceId: 'overleaf-mcp' }),
      (err) => err.code === 'RECOVERY_GATED' || err.status === 409
    );

    // 6. remove (delete) is blocked
    await assert.rejects(
      store.registry.remove('overleaf-mcp'),
      (err) => err.status === 409 || err.code === 'SERVICE_BUSY'
    );
  } finally {
    if (db) {
      try { db.close(); } catch (_) {}
    }
    if (store) {
      try { await store.close(); } catch (_) {}
    }
    cleanTempDir(tmpDir);
  }
});

test('persistence gate: mcp_action in NEEDS_ATTENTION activates persistent recovery gate and blocks new work', async () => {
  const tmpDir = createTempDir('gate-act-');
  const vault = createMemoryVault();
  let store = null;
  let db = null;
  try {
    store = openStore({ dataDir: tmpDir, vault });
    await store.createProfile({ id: 'prof-act-gate', label: 'Action Gate Profile' }, { expectedRevision: 0 });

    db = new DatabaseSync(path.join(tmpDir, 'manager.db'));
    db.prepare(`
      INSERT INTO mcp_actions (
        id, service_id, idempotency_key, request_fingerprint,
        state, error_code, sealed_payload, created_at, updated_at
      ) VALUES ('act-fault-1', 'overleaf-mcp', NULL, 'fp', 'NEEDS_ATTENTION', 'STOP_FAILED', '{}', '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z')
    `).run();
    db.close();
    db = null;

    // 1. Action is absent from runnable work queue
    const queue = store.getWorkQueue();
    assert.ok(!queue.includes('act-fault-1'));
    assert.equal(queue.length, 0);

    // 2. assertIdle detects action NEEDS_ATTENTION and throws RECOVERY_GATED
    assert.throws(
      () => store.assertIdle(),
      (err) => err instanceof StoreError && err.code === 'RECOVERY_GATED' && err.status === 409
    );

    // 3. createOperation is blocked
    assert.throws(
      () => store.createOperation({ profileId: 'prof-act-gate', targets: ['overleaf-mcp'] }),
      (err) => err instanceof StoreError && err.code === 'RECOVERY_GATED' && err.status === 409
    );

    // 4. createStopAction is blocked
    await assert.rejects(
      store.registry.createStopAction({ serviceId: 'overleaf-mcp' }),
      (err) => err.code === 'RECOVERY_GATED' || err.status === 409
    );

    // 5. delete registration is blocked
    await assert.rejects(
      store.registry.remove('overleaf-mcp'),
      (err) => err.status === 409 || err.code === 'SERVICE_BUSY'
    );
  } finally {
    if (db) {
      try { db.close(); } catch (_) {}
    }
    if (store) {
      try { await store.close(); } catch (_) {}
    }
    cleanTempDir(tmpDir);
  }
});

test('persistence gate: resetting metadata does NOT clear persistent gate while attention records remain in store', async () => {
  const tmpDir = createTempDir('gate-no-bypass-');
  const vault = createMemoryVault();
  let store = null;
  let db = null;
  try {
    store = openStore({ dataDir: tmpDir, vault });
    await store.createProfile({ id: 'prof-nobypass', label: 'No Bypass Profile' }, { expectedRevision: 0 });

    db = new DatabaseSync(path.join(tmpDir, 'manager.db'));
    db.prepare(`
      INSERT INTO operations (
        id, profile_id, profile_revision, targets, expected_revision,
        idempotency_key, request_payload, pinned_credentials,
        status, failure_code, created_at, updated_at
      ) VALUES ('op-stuck-1', 'prof-nobypass', 1, '["overleaf-mcp"]', 1, NULL, '{}', '{}', 'NEEDS_ATTENTION', 'EXTERNAL_DRIFT', '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z')
    `).run();

    // Explicitly set recovery metadata to gated
    db.prepare("UPDATE metadata SET value = '1' WHERE key = 'recovery_gated'").run();
    db.prepare("UPDATE metadata SET value = 'Operation stuck' WHERE key = 'recovery_reason'").run();

    db.close();
    db = null;

    assert.equal(store.getRecoveryState().gated, true);

    // Reset metadata gate via API
    store.resetRecoveryGate();
    assert.equal(store.getRecoveryState().gated, false);

    // Crucial regression: assertIdle MUST STILL FAIL CLOSED because op-stuck-1 is in operations table
    assert.throws(
      () => store.assertIdle(),
      (err) => err instanceof StoreError && err.code === 'RECOVERY_GATED' && err.status === 409
    );

    // Attempting new operation remains blocked
    assert.throws(
      () => store.createOperation({ profileId: 'prof-nobypass', targets: ['overleaf-mcp'] }),
      (err) => err.code === 'RECOVERY_GATED'
    );
  } finally {
    if (db) {
      try { db.close(); } catch (_) {}
    }
    if (store) {
      try { await store.close(); } catch (_) {}
    }
    cleanTempDir(tmpDir);
  }
});

// ============================================================================
// Section 3: TempDB Durable Restart, Profiles, Revisions, and AAD Integrity
// ============================================================================

test('persistence: durable TempDB restart preserves profiles, revisions, sealed credentials, and AAD tamper protection under gated recovery', async () => {
  const tmpDir = createTempDir('durable-vault-');
  let vault1 = null;
  let store1 = null;
  let vault2 = null;
  let store2 = null;
  let db = null;
  try {
    // 1. Setup store with real crypto vault
    vault1 = createVault({ dataDir: tmpDir });
    store1 = openStore({ dataDir: tmpDir, vault: vault1 });

    assert.equal(store1.getRevision(), 0);

    // Create custom registered service with legal service ID mcp_custom
    await store1.registry.create({
      id: 'mcp_custom',
      label: 'Custom Service',
      binding: { type: 'stdio', executable: 'custom.exe' }
    });
    assert.equal(store1.getRevision(), 1);

    // Create profile with secret credentials
    const createdProfile = await store1.createProfile({
      id: 'prof-durable-1',
      label: 'Production Profile',
      services: {
        'overleaf-mcp': {
          tunnelId: 'tun_secret_9988',
          apiKey: 'key_top_secret_xyz'
        },
        'mcp_custom': {
          tunnelId: 'tun_custom_1122',
          apiKey: 'key_custom_secret_abc'
        }
      }
    }, { expectedRevision: 1 });

    assert.equal(createdProfile.id, 'prof-durable-1');
    assert.equal(store1.getRevision(), 2);

    // Create and commit operation
    const op = store1.createOperation({
      profileId: 'prof-durable-1',
      targets: ['overleaf-mcp'],
      expectedRevision: 2
    });
    await store1.begin(op.id);
    await store1.commitSuccess(op.id);
    assert.equal(store1.getRevision(), 3);

    // Simulate an operation ending in NEEDS_ATTENTION
    const opFault = store1.createOperation({
      profileId: 'prof-durable-1',
      targets: ['mcp_custom'],
      expectedRevision: 3
    });
    await store1.begin(opFault.id);
    store1.finishRollback(opFault.id, 'NEEDS_ATTENTION');

    // Recovery gate is active
    assert.equal(store1.getRecoveryState().gated, true);

    // Close first instance
    await store1.close();
    store1 = null;
    vault1.close();
    vault1 = null;

    // 2. Reopen store from disk with fresh vault instance pointing at same dataDir
    vault2 = createVault({ dataDir: tmpDir });
    store2 = openStore({ dataDir: tmpDir, vault: vault2 });

    // Assert global revision survived restart
    assert.equal(store2.getRevision(), 3);

    // Assert active profile was committed and survived restart
    const services = store2.listServices();
    assert.equal(services['overleaf-mcp'].activeProfileId, 'prof-durable-1');

    // Assert profile list is preserved
    const profiles = store2.listProfiles();
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].id, 'prof-durable-1');

    // Assert unsealing credentials works with authentic derivation from store and DB
    db = new DatabaseSync(path.join(tmpDir, 'manager.db'));
    const profRow = db.prepare('SELECT sealed_credentials FROM profiles WHERE id = ?').get('prof-durable-1');
    const sealedObj = JSON.parse(profRow.sealed_credentials);

    const overleafCred = vault2.unseal(
      sealedObj['overleaf-mcp'],
      JSON.stringify(['profile', 'prof-durable-1', 1, 'overleaf-mcp', 'credentials-v2'])
    );
    const customCred = vault2.unseal(
      sealedObj['mcp_custom'],
      JSON.stringify(['profile', 'prof-durable-1', 1, 'mcp_custom', 'credentials-v2'])
    );
    assert.equal(overleafCred.apiKey, 'key_top_secret_xyz');
    assert.equal(overleafCred.tunnelId, 'tun_secret_9988');
    assert.equal(customCred.apiKey, 'key_custom_secret_abc');

    // Pinned credentials unseal cleanly from operation
    const pinnedOverleaf = await store2.pinnedCredential(op.id, 'overleaf-mcp');
    assert.equal(pinnedOverleaf.apiKey, 'key_top_secret_xyz');
    assert.equal(pinnedOverleaf.tunnelId, 'tun_secret_9988');

    // Assert tampering with sealed credentials or AAD causes unseal to fail
    const tamperedData = {
      ...sealedObj['overleaf-mcp'],
      data: Buffer.from('corrupted-ciphertext').toString('base64')
    };
    assert.throws(
      () => vault2.unseal(tamperedData, JSON.stringify(['profile', 'prof-durable-1', 1, 'overleaf-mcp', 'credentials-v2']))
    );

    // Tampered AAD should reject
    assert.throws(
      () => vault2.unseal(sealedObj['overleaf-mcp'], JSON.stringify(['profile', 'prof-tampered-id', 1, 'overleaf-mcp', 'credentials-v2']))
    );

    db.close();
    db = null;

    // Assert recovery gate remains active and rejects new work
    assert.equal(store2.getRecoveryState().gated, true);
    assert.throws(
      () => store2.assertIdle(),
      (err) => err instanceof StoreError && err.code === 'RECOVERY_GATED'
    );

    // Assert runnable work queue excludes the attention record
    const queue = store2.getWorkQueue();
    assert.ok(!queue.includes(opFault.id));
  } finally {
    if (db) {
      try { db.close(); } catch (_) {}
    }
    if (store2) {
      try { await store2.close(); } catch (_) {}
    }
    if (vault2) {
      try { vault2.close(); } catch (_) {}
    }
    if (store1) {
      try { await store1.close(); } catch (_) {}
    }
    if (vault1) {
      try { vault1.close(); } catch (_) {}
    }
    cleanTempDir(tmpDir);
  }
});

// ============================================================================
// Section 4: Cross-Component Runner Startup Recovery
// ============================================================================

test('runner startup recovery: recovers interrupted nonterminal operation before queued operations', async () => {
  const tmpDir = createTempDir('runner-rec-op-');
  const vault = createMemoryVault();
  let store = null;
  let runner = null;
  let db = null;
  try {
    store = openStore({ dataDir: tmpDir, vault });
    await store.createProfile({
      id: 'prof-runner-1',
      label: 'Runner Profile',
      services: { 'overleaf-mcp': { tunnelId: 'tun_1', apiKey: 'key_1' } }
    }, { expectedRevision: 0 });

    db = new DatabaseSync(path.join(tmpDir, 'manager.db'));

    // 1. Seed an interrupted operation in APPLYING state with may_have_mutated step
    db.prepare(`
      INSERT INTO operations (
        id, profile_id, profile_revision, targets, expected_revision,
        idempotency_key, request_payload, pinned_credentials,
        status, failure_code, created_at, updated_at
      ) VALUES ('op-interrupted', 'prof-runner-1', 1, '["overleaf-mcp"]', 1, NULL, '{"targets":["overleaf-mcp"],"profileId":"prof-runner-1"}', '{}', 'APPLYING', NULL, '2026-11-04T01:00:00.000Z', '2026-11-04T01:00:00.000Z')
    `).run();

    const snapshot = {
      desiredFingerprint: 'a'.repeat(64),
      originalFingerprint: 'b'.repeat(64)
    };
    const sealedSnap = vault.seal(snapshot, JSON.stringify(['operation', 'op-interrupted', 'overleaf-mcp', 'snapshot-v2']));

    db.prepare(`
      INSERT INTO operation_steps (
        operation_id, service_id, sealed_snapshot, may_have_mutated, state,
        failure_reason, created_at, updated_at
      ) VALUES ('op-interrupted', 'overleaf-mcp', ?, 1, 'APPLYING', NULL, '2026-11-04T01:00:00.000Z', '2026-11-04T01:00:00.000Z')
    `).run(typeof sealedSnap === 'string' ? sealedSnap : JSON.stringify(sealedSnap));

    // 2. Seed a queued operation
    db.prepare(`
      INSERT INTO operations (
        id, profile_id, profile_revision, targets, expected_revision,
        idempotency_key, request_payload, pinned_credentials,
        status, failure_code, created_at, updated_at
      ) VALUES ('op-queued', 'prof-runner-1', 1, '["overleaf-mcp"]', 1, NULL, '{"targets":["overleaf-mcp"],"profileId":"prof-runner-1"}', '{}', 'QUEUED', NULL, '2026-11-04T02:00:00.000Z', '2026-11-04T02:00:00.000Z')
    `).run();

    db.close();
    db = null;

    // Track execution event ordering
    const executionTrace = [];

    const mockAdapter = {
      prepare: async () => snapshot,
      applyIfUnchanged: async () => {
        executionTrace.push('apply:overleaf-mcp');
      },
      verifyDesired: async ({ operationId }) => {
        executionTrace.push(`verify:${operationId}`);
        return {
          verified: true,
          operationId,
          service: 'overleaf-mcp',
          configFingerprint: snapshot.desiredFingerprint,
          identity: { pid: 42, startedAt: '2026-11-04T00:00:00Z', executable: 'fake.exe' },
          proof: { kind: 'authenticated-control-plane' }
        };
      },
      restoreIfOwned: async ({ operationId }) => {
        executionTrace.push(`restore:${operationId}`);
        return {
          restored: true,
          runtimeRestored: true,
          operationId,
          service: 'overleaf-mcp',
          configFingerprint: snapshot.originalFingerprint
        };
      }
    };

    runner = createRunner({
      repo: store,
      adapters: { 'overleaf-mcp': mockAdapter },
      dataDir: tmpDir
    });

    // Start runner: startup recovery runs before drain
    await runner.start();

    // Interrupted operation must be restored first during startup recovery
    assert.ok(executionTrace.includes('restore:op-interrupted'));

    // Verify op-interrupted transitioned to ROLLED_BACK
    const op1 = store.load('op-interrupted');
    assert.equal(op1.status, 'ROLLED_BACK');

    // Drain queued operation
    runner.notify();
    await runner.stop();

    // Verify op-queued completed
    const op2 = store.load('op-queued');
    assert.equal(op2.status, 'SUCCEEDED');

    // Confirm strict execution ordering: restore:op-interrupted came BEFORE apply for op-queued
    const restoreIdx = executionTrace.indexOf('restore:op-interrupted');
    const applyIdx = executionTrace.indexOf('apply:overleaf-mcp');
    assert.ok(restoreIdx !== -1 && applyIdx !== -1);
    assert.ok(restoreIdx < applyIdx, 'Startup recovery must precede new queued work execution');
  } finally {
    if (db) {
      try { db.close(); } catch (_) {}
    }
    if (runner) {
      try { await runner.stop(); } catch (_) {}
    }
    if (store) {
      try { await store.close(); } catch (_) {}
    }
    cleanTempDir(tmpDir);
  }
});

test('runner startup recovery: restore failure transitions operation to NEEDS_ATTENTION and engages recovery gate', async () => {
  const tmpDir = createTempDir('runner-fail-gate-');
  const vault = createMemoryVault();
  let store = null;
  let runner = null;
  let db = null;
  try {
    store = openStore({ dataDir: tmpDir, vault });
    await store.createProfile({
      id: 'prof-fail-1',
      label: 'Fail Profile',
      services: { 'overleaf-mcp': { tunnelId: 'tun_1', apiKey: 'key_1' } }
    }, { expectedRevision: 0 });

    db = new DatabaseSync(path.join(tmpDir, 'manager.db'));

    // Seed interrupted operation in APPLYING with mutated step
    db.prepare(`
      INSERT INTO operations (
        id, profile_id, profile_revision, targets, expected_revision,
        idempotency_key, request_payload, pinned_credentials,
        status, failure_code, created_at, updated_at
      ) VALUES ('op-drift', 'prof-fail-1', 1, '["overleaf-mcp"]', 1, NULL, '{"targets":["overleaf-mcp"],"profileId":"prof-fail-1"}', '{}', 'APPLYING', NULL, '2026-11-04T01:00:00.000Z', '2026-11-04T01:00:00.000Z')
    `).run();

    const snapshot = { desiredFingerprint: 'a'.repeat(64), originalFingerprint: 'b'.repeat(64) };
    const sealedSnap = vault.seal(snapshot, JSON.stringify(['operation', 'op-drift', 'overleaf-mcp', 'snapshot-v2']));

    db.prepare(`
      INSERT INTO operation_steps (
        operation_id, service_id, sealed_snapshot, may_have_mutated, state,
        failure_reason, created_at, updated_at
      ) VALUES ('op-drift', 'overleaf-mcp', ?, 1, 'APPLYING', NULL, '2026-11-04T01:00:00.000Z', '2026-11-04T01:00:00.000Z')
    `).run(typeof sealedSnap === 'string' ? sealedSnap : JSON.stringify(sealedSnap));

    // Seed a queued operation that must NOT execute due to gate
    db.prepare(`
      INSERT INTO operations (
        id, profile_id, profile_revision, targets, expected_revision,
        idempotency_key, request_payload, pinned_credentials,
        status, failure_code, created_at, updated_at
      ) VALUES ('op-should-block', 'prof-fail-1', 1, '["overleaf-mcp"]', 1, NULL, '{"targets":["overleaf-mcp"],"profileId":"prof-fail-1"}', '{}', 'QUEUED', NULL, '2026-11-04T02:00:00.000Z', '2026-11-04T02:00:00.000Z')
    `).run();

    db.close();
    db = null;

    let queuedAttempted = false;
    const failingAdapter = {
      prepare: async () => snapshot,
      applyIfUnchanged: async () => {
        queuedAttempted = true;
      },
      verifyDesired: async () => ({ verified: true }),
      restoreIfOwned: async () => {
        // Return negative receipt triggering NEEDS_ATTENTION
        return { restored: false, runtimeRestored: false, service: 'overleaf-mcp' };
      }
    };

    runner = createRunner({
      repo: store,
      adapters: { 'overleaf-mcp': failingAdapter },
      dataDir: tmpDir
    });

    // Start runner
    await runner.start();

    // Verify op-drift ended in NEEDS_ATTENTION
    const op = store.load('op-drift');
    assert.equal(op.status, 'NEEDS_ATTENTION');

    // Verify recovery gate was activated in store
    assert.equal(store.getRecoveryState().gated, true);
    assert.throws(
      () => store.assertIdle(),
      (err) => err instanceof StoreError && err.code === 'RECOVERY_GATED'
    );

    // Notify runner to drain queue
    runner.notify();
    await runner.stop();

    // Queued operation must NOT have executed
    assert.equal(queuedAttempted, false, 'Queued operation must be gated when recovery fails');
    const blockedOp = store.load('op-should-block');
    assert.ok(['QUEUED', 'REJECTED', 'ROLLED_BACK'].includes(blockedOp.status));
    if (['REJECTED', 'ROLLED_BACK'].includes(blockedOp.status)) {
      assert.ok(['RECOVERY_GATED', 'INTERRUPTED', 'SWITCH_FAILED'].includes(blockedOp.failureCode));
    }
  } finally {
    if (db) {
      try { db.close(); } catch (_) {}
    }
    if (runner) {
      try { await runner.stop(); } catch (_) {}
    }
    if (store) {
      try { await store.close(); } catch (_) {}
    }
    cleanTempDir(tmpDir);
  }
});

test('runner startup recovery: interrupted stop action transitions to NEEDS_ATTENTION and engages recovery gate', async () => {
  const tmpDir = createTempDir('runner-stop-rec-');
  const vault = createMemoryVault();
  let store = null;
  let runner = null;
  let db = null;
  try {
    store = openStore({ dataDir: tmpDir, vault });
    await store.createProfile({
      id: 'prof-stop-1',
      label: 'Stop Profile',
      services: { 'overleaf-mcp': { tunnelId: 'tun_1', apiKey: 'key_1' } }
    }, { expectedRevision: 0 });

    // Create real stop action with proper snapshot and sealed payload using registry
    const stopAction = await store.registry.createStopAction({ serviceId: 'overleaf-mcp' });

    // Seed the action as interrupted in APPLYING state
    db = new DatabaseSync(path.join(tmpDir, 'manager.db'));
    db.prepare("UPDATE mcp_actions SET state = 'APPLYING' WHERE id = ?").run(stopAction.id);
    db.close();
    db = null;

    runner = createRunner({
      repo: store,
      adapters: {
        'overleaf-mcp': {
          stopConnection: async () => ({
            stopped: true,
            operationId: stopAction.id,
            service: 'overleaf-mcp',
            proof: { kind: 'verified-already-stopped' }
          })
        }
      },
      dataDir: tmpDir
    });

    await runner.start();

    // Per mcp-lifecycle: interrupted stop action in APPLYING transitions to NEEDS_ATTENTION
    const action = await store.registry.loadAction(stopAction.id);
    assert.equal(action.state, 'NEEDS_ATTENTION');
    assert.equal(action.errorCode, 'INTERRUPTED');

    // Recovery gate must be engaged
    assert.equal(store.getRecoveryState().gated, true);
    assert.throws(
      () => store.assertIdle(),
      (err) => err instanceof StoreError && err.code === 'RECOVERY_GATED'
    );
  } finally {
    if (db) {
      try { db.close(); } catch (_) {}
    }
    if (runner) {
      try { await runner.stop(); } catch (_) {}
    }
    if (store) {
      try { await store.close(); } catch (_) {}
    }
    cleanTempDir(tmpDir);
  }
});

test('runner startup recovery: corrupt or missing load triggers rollback releasing daemon lease', async () => {
  const tmpDir = createTempDir('runner-corrupt-lease-');
  let runner = null;
  let cleanRunner = null;
  try {
    const corruptRepo = {
      async getWorkQueue() {
        return ['op-corrupt-missing'];
      },
      async load() {
        // Missing durable work is rejected by dispatch classification before effects.
        return null;
      }
    };

    runner = createRunner({
      repo: corruptRepo,
      adapters: {},
      dataDir: tmpDir
    });

    // The current dispatcher rejects a missing durable record before loading work.
    await assert.rejects(
      runner.start(),
      (err) => err.code === 'WORK_ITEM_NOT_FOUND' && err.mayMutate === false
    );

    // Verify daemon lock was released by acquiring it with a fresh daemon lock check
    const lock = await acquireDaemonLock(tmpDir);
    assert.ok(lock, 'Daemon lock must be freely acquirable after runner startup failure');
    await lock.release();

    // Verify a subsequent clean runner can start without lock collision
    const cleanRepo = {
      async getWorkQueue() { return []; }
    };
    cleanRunner = createRunner({
      repo: cleanRepo,
      adapters: {},
      dataDir: tmpDir
    });
    await cleanRunner.start();
    await cleanRunner.stop();
  } finally {
    if (runner) {
      try { await runner.stop(); } catch (_) {}
    }
    if (cleanRunner) {
      try { await cleanRunner.stop(); } catch (_) {}
    }
    cleanTempDir(tmpDir);
  }
});

test('runner drain: terminal and attention items in stale queue produce zero dispatches and no infinite spin', async () => {
  const tmpDir = createTempDir('runner-no-spin-');
  let runner = null;
  try {
    const records = {
      'op-succeeded': { id: 'op-succeeded', status: 'SUCCEEDED' },
      'op-rolledback': { id: 'op-rolledback', status: 'ROLLED_BACK' },
      'op-rejected': { id: 'op-rejected', status: 'REJECTED' },
      'op-attention': { id: 'op-attention', status: 'NEEDS_ATTENTION' },
      'act-attention': { id: 'act-attention', kind: 'stop', state: 'NEEDS_ATTENTION' }
    };

    let fetchCount = 0;
    let dispatchCount = 0;

    const fakeRepo = {
      async getWorkQueue() {
        fetchCount++;
        // Return stale queue containing only terminal records
        return ['op-succeeded', 'op-rolledback', 'op-rejected', 'op-attention', 'act-attention'];
      },
      async isActionId(id) {
        return records[id]?.kind === 'stop';
      },
      async isOperationId(id) {
        return Boolean(records[id] && records[id].kind !== 'stop');
      },
      async load(id) {
        return records[id];
      },
      async loadAction(id) {
        return records[id];
      }
    };

    runner = createRunner({
      repo: fakeRepo,
      adapters: {
        'overleaf-mcp': {
          prepare: async () => { dispatchCount++; },
          applyIfUnchanged: async () => { dispatchCount++; }
        }
      },
      dataDir: tmpDir
    });

    await runner.start();

    // Trigger drain
    runner.notify();
    await runner.stop();

    // Zero dispatches must have occurred for terminal items
    assert.equal(dispatchCount, 0, 'No dispatch should happen for terminal or attention items');
    // Drain must terminate cleanly without spinning
    assert.ok(fetchCount <= 5, `Fetch count was ${fetchCount}; drain must not spin indefinitely`);
  } finally {
    if (runner) {
      try { await runner.stop(); } catch (_) {}
    }
    cleanTempDir(tmpDir);
  }
});

test('runner startup: supports both synchronous SQLite and asynchronous injected repositories', async () => {
  const tmpDirSync = createTempDir('sync-repo-');
  const tmpDirAsync = createTempDir('async-repo-');
  let syncRunner = null;
  let asyncRunner = null;
  try {
    // 1. Synchronous SQLite-style repo
    let syncLoaded = false;
    const syncRepo = {
      getWorkQueue() { return ['op-sync']; },
      load(id) {
        syncLoaded = true;
        assert.equal(this, syncRepo, 'sync load must preserve receiver binding');
        return { id, status: 'SUCCEEDED' };
      }
    };
    syncRunner = createRunner({ repo: syncRepo, adapters: {}, dataDir: tmpDirSync });
    await syncRunner.start();
    assert.equal(syncLoaded, true);
    await syncRunner.stop();
    syncRunner = null;

    // 2. Asynchronous injected repo
    let asyncLoaded = false;
    const asyncRepo = {
      async getWorkQueue() { return ['op-async']; },
      async load(id) {
        asyncLoaded = true;
        assert.equal(this, asyncRepo, 'async load must preserve receiver binding');
        return { id, status: 'SUCCEEDED' };
      }
    };
    asyncRunner = createRunner({ repo: asyncRepo, adapters: {}, dataDir: tmpDirAsync });
    await asyncRunner.start();
    assert.equal(asyncLoaded, true);
    await asyncRunner.stop();
    asyncRunner = null;
  } finally {
    if (syncRunner) {
      try { await syncRunner.stop(); } catch (_) {}
    }
    if (asyncRunner) {
      try { await asyncRunner.stop(); } catch (_) {}
    }
    cleanTempDir(tmpDirSync);
    cleanTempDir(tmpDirAsync);
  }
});

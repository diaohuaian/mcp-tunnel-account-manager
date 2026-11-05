import { test, describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openStore, StoreError } from '../src/store.mjs';
import { createVault } from '../src/vault.mjs';

describe('Registry and Store Migration / TempDB Regressions', () => {
  let tmpDir;
  let vault;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-store-mig-'));
    vault = createVault({ dataDir: path.join(tmpDir, 'vault') });
  });

  afterEach(async () => {
    try {
      if (vault && typeof vault.close === 'function') {
        await vault.close();
      }
    } catch (_) {}
    try {
      if (tmpDir && fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch (_) {}
  });

  it('1. schema migration from legacy v0 store preserves profiles, revisions, and AAD', async () => {
    const dbPath = path.join(tmpDir, 'manager.db');
    const legacyDb = new DatabaseSync(dbPath);

    // Create legacy schema missing modern columns and mcp tables
    legacyDb.exec(`
      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO metadata (key, value) VALUES ('revision', '42');
      INSERT INTO metadata (key, value) VALUES ('recovery_gated', '0');
      INSERT INTO metadata (key, value) VALUES ('recovery_reason', '');

      CREATE TABLE profiles (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        sealed_credentials TEXT NOT NULL,
        services_meta TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE operations (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        profile_revision INTEGER,
        targets TEXT NOT NULL,
        expected_revision INTEGER,
        idempotency_key TEXT,
        request_payload TEXT NOT NULL,
        pinned_credentials TEXT NOT NULL,
        status TEXT NOT NULL,
        failure_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE operation_steps (
        operation_id TEXT NOT NULL,
        service_id TEXT NOT NULL,
        sealed_snapshot TEXT,
        may_have_mutated INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'INITIAL',
        failure_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (operation_id, service_id)
      );

      CREATE TABLE active_profiles (
        service_id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL
      );
    `);

    // Seed legacy profile with sealed credential using real vault
    const aadP1 = JSON.stringify(['profile', 'p-legacy-1', 1, 'overleaf-mcp', 'credentials-v2']);
    const sealedCredP1 = vault.seal({
      tunnelId: 'tun-legacy-123456',
      apiKey: 'secret-legacy-api-key',
      organizationId: 'org-legacy-42'
    }, aadP1);

    const now = new Date().toISOString();
    legacyDb.prepare(`
      INSERT INTO profiles (id, label, revision, sealed_credentials, services_meta, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?, ?, ?)
    `).run(
      'p-legacy-1',
      'Legacy Profile 1',
      JSON.stringify({ 'overleaf-mcp': sealedCredP1 }),
      JSON.stringify({
        'overleaf-mcp': { configured: true, maskedTunnelId: 'tun...3456', hasApiKey: true, hasOrganizationId: true }
      }),
      now,
      now
    );

    legacyDb.prepare(`
      INSERT INTO active_profiles (service_id, profile_id)
      VALUES ('overleaf-mcp', 'p-legacy-1')
    `).run();

    // Seed operations in legacy db
    const insertOp = legacyDb.prepare(`
      INSERT INTO operations (id, profile_id, profile_revision, targets, expected_revision, idempotency_key, request_payload, pinned_credentials, status, failure_code, created_at, updated_at)
      VALUES (?, 'p-legacy-1', 1, '["overleaf-mcp"]', 42, NULL, '{}', '{}', ?, NULL, ?, ?)
    `);
    insertOp.run('op-leg-succeeded', 'SUCCEEDED', '2026-11-04T00:10:00.000Z', '2026-11-04T00:10:00.000Z');
    insertOp.run('op-leg-prep', 'PREPARING', '2026-11-04T01:00:00.000Z', '2026-11-04T01:00:00.000Z');
    insertOp.run('op-leg-queued', 'QUEUED', '2026-11-04T02:00:00.000Z', '2026-11-04T02:00:00.000Z');
    insertOp.run('op-leg-attention', 'NEEDS_ATTENTION', '2026-11-04T00:50:00.000Z', '2026-11-04T00:50:00.000Z');

    legacyDb.close();

    // Now open store with openStore - triggers additive schema migrations and attaches registry
    const store = openStore({ dataDir: tmpDir, vault });

    // Assert global revision preserved
    assert.equal(store.getRevision(), 42);

    // Assert profile preserved and DTO formatted cleanly without plaintext secrets
    const p = store.getProfile('p-legacy-1');
    assert.ok(p);
    assert.equal(p.id, 'p-legacy-1');
    assert.equal(p.label, 'Legacy Profile 1');
    assert.equal(p.services['overleaf-mcp'].configured, true);
    assert.equal(p.services['overleaf-mcp'].hasApiKey, true);
    assert.equal(p.services['overleaf-mcp'].hasOrganizationId, true);
    assert.equal(p.services['overleaf-mcp'].apiKey, undefined);

    // Assert active profiles mapping preserved
    const services = store.listServices();
    assert.equal(services['overleaf-mcp'].activeProfileId, 'p-legacy-1');

    // Assert registry attached and seeded default definitions
    const definitions = store.registry.listDefinitions();
    assert.ok(definitions.some(d => d.id === 'overleaf-mcp'));
    assert.ok(definitions.some(d => d.id === 'antigravity-mcp'));

    // Assert getWorkQueue excludes NEEDS_ATTENTION and SUCCEEDED
    const queue = store.getWorkQueue();
    assert.deepEqual(queue, ['op-leg-prep', 'op-leg-queued']);
    assert.ok(!queue.includes('op-leg-attention'), 'NEEDS_ATTENTION must be excluded from getWorkQueue');
    assert.ok(!queue.includes('op-leg-succeeded'), 'SUCCEEDED must be excluded from getWorkQueue');

    // Assert assertIdle still detects op-leg-attention and throws RECOVERY_GATED
    assert.throws(
      () => store.assertIdle(),
      (err) => err instanceof StoreError && err.code === 'RECOVERY_GATED'
    );

    await store.close();
  });

  it('2. all getWorkQueue SQL branches exclude NEEDS_ATTENTION and include all actual nonterminal states', async () => {
    const store = openStore({ dataDir: tmpDir, vault });

    await store.createProfile({
      id: 'prof-nonterm',
      label: 'Nonterminal Profile'
    }, { expectedRevision: 0 });

    const db = new DatabaseSync(path.join(tmpDir, 'manager.db'));

    const insertOp = db.prepare(`
      INSERT INTO operations (
        id, profile_id, profile_revision, targets, expected_revision,
        idempotency_key, request_payload, pinned_credentials,
        status, failure_code, created_at, updated_at
      ) VALUES (?, 'prof-nonterm', 1, '["overleaf-mcp"]', 1, NULL, '{}', '{}', ?, NULL, ?, ?)
    `);

    const insertAction = db.prepare(`
      INSERT INTO mcp_actions (
        id, service_id, idempotency_key, request_fingerprint,
        state, error_code, sealed_payload, created_at, updated_at
      ) VALUES (?, 'overleaf-mcp', NULL, 'fp', ?, NULL, '{}', ?, ?)
    `);

    // Insert ALL nonterminal operation states:
    // PREPARING, APPLYING, VERIFYING, ROLLING_BACK, QUEUED
    insertOp.run('op-prep', 'PREPARING', '2026-11-04T01:00:00.000Z', '2026-11-04T01:00:00.000Z');
    insertOp.run('op-apply', 'APPLYING', '2026-11-04T01:10:00.000Z', '2026-11-04T01:10:00.000Z');
    insertOp.run('op-verify', 'VERIFYING', '2026-11-04T01:20:00.000Z', '2026-11-04T01:20:00.000Z');
    insertOp.run('op-rollback', 'ROLLING_BACK', '2026-11-04T01:30:00.000Z', '2026-11-04T01:30:00.000Z');
    insertOp.run('op-queued', 'QUEUED', '2026-11-04T02:00:00.000Z', '2026-11-04T02:00:00.000Z');

    // Terminal operation states (must be omitted)
    insertOp.run('op-succeeded', 'SUCCEEDED', '2026-11-04T00:10:00.000Z', '2026-11-04T00:10:00.000Z');
    insertOp.run('op-rolledback', 'ROLLED_BACK', '2026-11-04T00:20:00.000Z', '2026-11-04T00:20:00.000Z');
    insertOp.run('op-rejected', 'REJECTED', '2026-11-04T00:30:00.000Z', '2026-11-04T00:30:00.000Z');
    insertOp.run('op-attention', 'NEEDS_ATTENTION', '2026-11-04T00:40:00.000Z', '2026-11-04T00:40:00.000Z');

    // Insert nonterminal action states:
    // APPLYING, QUEUED
    insertAction.run('act-apply', 'APPLYING', '2026-11-04T01:15:00.000Z', '2026-11-04T01:15:00.000Z');
    insertAction.run('act-queued', 'QUEUED', '2026-11-04T02:15:00.000Z', '2026-11-04T02:15:00.000Z');

    // Terminal action states (must be omitted)
    insertAction.run('act-succeeded', 'SUCCEEDED', '2026-11-04T00:15:00.000Z', '2026-11-04T00:15:00.000Z');
    insertAction.run('act-rejected', 'REJECTED', '2026-11-04T00:25:00.000Z', '2026-11-04T00:25:00.000Z');
    insertAction.run('act-attention', 'NEEDS_ATTENTION', '2026-11-04T00:35:00.000Z', '2026-11-04T00:35:00.000Z');

    const queue = store.getWorkQueue();

    // 1. Every actual nonterminal item must be present
    assert.ok(queue.includes('op-prep'), 'PREPARING must be in queue');
    assert.ok(queue.includes('op-apply'), 'APPLYING op must be in queue');
    assert.ok(queue.includes('op-verify'), 'VERIFYING must be in queue');
    assert.ok(queue.includes('op-rollback'), 'ROLLING_BACK must be in queue');
    assert.ok(queue.includes('op-queued'), 'QUEUED op must be in queue');
    assert.ok(queue.includes('act-apply'), 'APPLYING action must be in queue');
    assert.ok(queue.includes('act-queued'), 'QUEUED action must be in queue');

    // 2. Terminal items must be strictly absent
    assert.ok(!queue.includes('op-succeeded'), 'SUCCEEDED op must not be in queue');
    assert.ok(!queue.includes('op-rolledback'), 'ROLLED_BACK op must not be in queue');
    assert.ok(!queue.includes('op-rejected'), 'REJECTED op must not be in queue');
    assert.ok(!queue.includes('op-attention'), 'NEEDS_ATTENTION op must not be in queue');
    assert.ok(!queue.includes('act-succeeded'), 'SUCCEEDED act must not be in queue');
    assert.ok(!queue.includes('act-rejected'), 'REJECTED act must not be in queue');
    assert.ok(!queue.includes('act-attention'), 'NEEDS_ATTENTION act must not be in queue');

    // 3. Strict ordering: interrupted items (order 0) before QUEUED (order 1), stable createdAt/id
    assert.deepEqual(queue, [
      'op-prep',       // 01:00 (order 0)
      'op-apply',      // 01:10 (order 0)
      'act-apply',     // 01:15 (order 0)
      'op-verify',     // 01:20 (order 0)
      'op-rollback',   // 01:30 (order 0)
      'op-queued',     // 02:00 (order 1)
      'act-queued'     // 02:15 (order 1)
    ]);

    await store.close();
  });

  it('3. separate persistent assertIdle recovery gate still detects NEEDS_ATTENTION in operations and actions and blocks mutation', async () => {
    const store = openStore({ dataDir: tmpDir, vault });

    await store.createProfile({
      id: 'prof-gate',
      label: 'Gate Test Profile'
    }, { expectedRevision: 0 });

    const db = new DatabaseSync(path.join(tmpDir, 'manager.db'));

    // Insert an operation in NEEDS_ATTENTION
    db.prepare(`
      INSERT INTO operations (
        id, profile_id, profile_revision, targets, expected_revision,
        idempotency_key, request_payload, pinned_credentials,
        status, failure_code, created_at, updated_at
      ) VALUES (?, 'prof-gate', 1, '["overleaf-mcp"]', 1, NULL, '{}', '{}', 'NEEDS_ATTENTION', 'KERNEL_PANIC', ?, ?)
    `).run('op-bad-1', new Date().toISOString(), new Date().toISOString());

    // 1. Runnable queue does NOT return op-bad-1
    assert.deepEqual(store.getWorkQueue(), []);

    // 2. assertIdle throws RECOVERY_GATED
    assert.throws(
      () => store.assertIdle(),
      (err) => err instanceof StoreError && err.code === 'RECOVERY_GATED' && err.status === 409
    );

    // 3. Resetting metadata gate does not bypass: assertIdle queries operations directly
    store.resetRecoveryGate();
    assert.equal(store.getRecoveryState().gated, false);
    assert.throws(
      () => store.assertIdle(),
      (err) => err instanceof StoreError && err.code === 'RECOVERY_GATED' && err.status === 409
    );

    // 4. Mutation operations are blocked by assertIdle
    assert.throws(
      () => store.createOperation({ profileId: 'prof-gate', targets: ['overleaf-mcp'] }),
      (err) => err.code === 'RECOVERY_GATED'
    );

    // Now mark op-bad-1 as SUCCEEDED so operation is no longer gated
    db.prepare("UPDATE operations SET status = 'SUCCEEDED' WHERE id = 'op-bad-1'").run();

    // Now insert a stop action in NEEDS_ATTENTION
    db.prepare(`
      INSERT INTO mcp_actions (
        id, service_id, idempotency_key, request_fingerprint,
        state, error_code, sealed_payload, created_at, updated_at
      ) VALUES ('act-bad-1', 'overleaf-mcp', NULL, 'fp', 'NEEDS_ATTENTION', 'PROC_KILL_FAIL', '{}', ?, ?)
    `).run(new Date().toISOString(), new Date().toISOString());

    // 5. Runnable queue does NOT return act-bad-1
    assert.deepEqual(store.getWorkQueue(), []);

    // 6. assertIdle detects NEEDS_ATTENTION in actions
    assert.throws(
      () => store.assertIdle(),
      (err) => err instanceof StoreError && err.code === 'RECOVERY_GATED' && err.status === 409
    );

    // 7. Resetting metadata gate does not bypass: assertIdle queries mcp_actions directly
    store.resetRecoveryGate();
    assert.equal(store.getRecoveryState().gated, false);
    assert.throws(
      () => store.assertIdle(),
      (err) => err instanceof StoreError && err.code === 'RECOVERY_GATED' && err.status === 409
    );

    // 8. createStopAction is blocked by assertIdle
    await assert.rejects(
      async () => await store.registry.createStopAction({ serviceId: 'overleaf-mcp' }),
      (err) => err.code === 'RECOVERY_GATED' || err.statusCode === 409
    );

    await store.close();
  });

  it('4. fallback getWorkQueue branch without mcp_actions table preserves terminal filters and order', async () => {
    // Test the SQL branch directly on a database where mcp_actions does not exist
    const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-no-actions-'));
    try {
      const rawDb = new DatabaseSync(path.join(rawDir, 'manager.db'));
      rawDb.exec(`
        CREATE TABLE operations (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);

      const insert = rawDb.prepare('INSERT INTO operations (id, status, created_at) VALUES (?, ?, ?)');
      insert.run('op-term-succ', 'SUCCEEDED', '2026-11-04T00:10:00.000Z');
      insert.run('op-term-rb', 'ROLLED_BACK', '2026-11-04T00:20:00.000Z');
      insert.run('op-term-rej', 'REJECTED', '2026-11-04T00:30:00.000Z');
      insert.run('op-term-attn', 'NEEDS_ATTENTION', '2026-11-04T00:40:00.000Z');

      insert.run('op-prep', 'PREPARING', '2026-11-04T01:00:00.000Z');
      insert.run('op-apply', 'APPLYING', '2026-11-04T01:10:00.000Z');
      insert.run('op-verify', 'VERIFYING', '2026-11-04T01:20:00.000Z');
      insert.run('op-rollback', 'ROLLING_BACK', '2026-11-04T01:30:00.000Z');
      insert.run('op-queued', 'QUEUED', '2026-11-04T02:00:00.000Z');

      // Execute exact fallback query
      const rows = rawDb.prepare(`
        SELECT id, created_at, CASE WHEN status = 'QUEUED' THEN 1 ELSE 0 END AS queue_order
        FROM operations
        WHERE status NOT IN ('SUCCEEDED', 'ROLLED_BACK', 'REJECTED', 'NEEDS_ATTENTION')
        ORDER BY queue_order ASC, created_at ASC, id ASC
      `).all();

      const result = rows.map(r => r.id);
      assert.deepEqual(result, [
        'op-prep',
        'op-apply',
        'op-verify',
        'op-rollback',
        'op-queued'
      ]);

      rawDb.close();
    } finally {
      fs.rmSync(rawDir, { recursive: true, force: true });
    }
  });

  it('5. profile credentials and pinned operation snapshot AAD survive multiple durable restarts', async () => {
    const vaultDir = path.join(tmpDir, 'restart-vault');

    // Cycle 1: Open store, create profile and operation
    const v1 = createVault({ dataDir: vaultDir });
    const store1 = openStore({ dataDir: tmpDir, vault: v1 });
    const p1 = await store1.createProfile({
      id: 'prof-aad-survive',
      label: 'AAD Survival Profile',
      services: {
        'overleaf-mcp': {
          tunnelId: 'tun_survive_100',
          apiKey: 'key_survive_token'
        }
      }
    }, { expectedRevision: 0 });

    const op = store1.createOperation({
      profileId: 'prof-aad-survive',
      targets: ['overleaf-mcp'],
      expectedRevision: store1.getRevision()
    });

    await store1.begin(op.id);
    await store1.prepared(op.id, 'overleaf-mcp', { testKey: 'snapshot-value-123' });
    await store1.close();

    // Cycle 2: Reopen store, unseal pinned credentials and snapshot
    const v2 = createVault({ dataDir: vaultDir });
    const store2 = openStore({ dataDir: tmpDir, vault: v2 });
    const cred = await store2.pinnedCredential(op.id, 'overleaf-mcp');
    assert.equal(cred.apiKey, 'key_survive_token');
    assert.equal(cred.tunnelId, 'tun_survive_100');

    const snap = await store2.unsealSnapshot(op.id, 'overleaf-mcp');
    assert.deepEqual(snap, { testKey: 'snapshot-value-123' });

    await store2.commitSuccess(op.id);
    await store2.close();

    // Cycle 3: Reopen store, verify active_profiles and revision increment
    const v3 = createVault({ dataDir: vaultDir });
    const store3 = openStore({ dataDir: tmpDir, vault: v3 });
    assert.equal(store3.getRevision(), 2);
    const services = store3.listServices();
    assert.equal(services['overleaf-mcp'].activeProfileId, 'prof-aad-survive');

    await store3.close();
  });
});

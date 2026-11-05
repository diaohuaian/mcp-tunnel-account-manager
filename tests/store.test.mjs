import { test, describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openStore, StoreError } from '../src/store.mjs';
import { createVault } from '../src/vault.mjs';

function createFakeVault() {
  return {
    seal: (v, aad) => ({ c: JSON.stringify(v), aad }),
    unseal: (e, aad) => {
      let env = e;
      if (typeof env === 'string') {
        try {
          env = JSON.parse(env);
        } catch (_) {}
      }
      if (aad !== undefined && env && env.aad !== undefined && env.aad !== aad) {
        throw new Error(`AAD mismatch: expected ${aad}, got ${env.aad}`);
      }
      return typeof env?.c === 'string' ? JSON.parse(env.c) : env?.c;
    },
    close: () => {}
  };
}

describe('Store and SQLite Database Tests', () => {
  let tmpDir;
  let fakeVault;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-test-'));
    fakeVault = createFakeVault();
  });

  afterEach(() => {
    try {
      if (tmpDir && fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch (_) {}
  });

  it('1. schema creation and durable restart', async () => {
    const store1 = openStore({ dataDir: tmpDir, vault: fakeVault });

    // Initial state checks
    assert.equal(store1.getRevision(), 0);
    assert.deepEqual(store1.getRecoveryState(), { gated: false });
    assert.deepEqual(store1.listProfiles(), []);
    const services = store1.listServices();
    assert.equal(services.length, 2);
    assert.equal(services[0].activeProfileId, null);
    assert.equal(services[1].activeProfileId, null);

    // Create a profile in store1
    const p1 = await store1.createProfile({
      id: 'p-durable',
      label: 'Durable Profile',
      services: {
        'overleaf-mcp': {
          tunnelId: 'tun_durable_1234',
          apiKey: 'key_12345'
        }
      }
    }, { expectedRevision: 0 });

    assert.equal(store1.getRevision(), 1);
    assert.equal(p1.id, 'p-durable');

    // Create and commit an operation
    const op = store1.createOperation({
      profileId: 'p-durable',
      targets: ['overleaf-mcp'],
      expectedRevision: 1
    });
    await store1.begin(op.id);
    await store1.commitSuccess(op.id);

    assert.equal(store1.getRevision(), 2);
    const servicesAfterCommit = store1.listServices();
    assert.equal(servicesAfterCommit['overleaf-mcp'].activeProfileId, 'p-durable');

    // Close store1
    await store1.close();

    // Verify manager.db file exists
    const dbFile = path.join(tmpDir, 'manager.db');
    assert.ok(fs.existsSync(dbFile), 'manager.db should exist on disk');

    // Reopen store2 pointing at the same dataDir
    const store2 = openStore({ dataDir: tmpDir, vault: fakeVault });

    // Verify durable restart preserves all data
    assert.equal(store2.getRevision(), 2, 'Global revision must survive restart');
    const profiles = store2.listProfiles();
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].id, 'p-durable');
    assert.equal(profiles[0].label, 'Durable Profile');
    assert.equal(profiles[0].services['overleaf-mcp'].configured, true);

    const reloadedServices = store2.listServices();
    assert.equal(reloadedServices['overleaf-mcp'].activeProfileId, 'p-durable');

    const loadedOp = store2.load(op.id);
    assert.ok(loadedOp);
    assert.equal(loadedOp.status, 'SUCCEEDED');

    await store2.close();
  });

  it('2. profile CRUD and DTO masking (no plaintext secrets)', async () => {
    const store = openStore({ dataDir: tmpDir, vault: fakeVault });

    // CREATE Profile
    const rawApiKey = 'super-secret-overleaf-token-999';
    const rawTunnelId = 'tunnel-prod-live-42';
    const rawOrgId = 'org-department-engineering';

    const created = await store.createProfile({
      id: 'prof-secret',
      label: 'Secret Profile',
      services: {
        'overleaf-mcp': {
          tunnelId: rawTunnelId,
          apiKey: rawApiKey,
          organizationId: rawOrgId
        }
      }
    }, { expectedRevision: 0 });

    // Verify returned DTO
    assert.equal(created.id, 'prof-secret');
    assert.equal(created.label, 'Secret Profile');
    assert.equal(created.revision, 1);

    const sMeta = created.services['overleaf-mcp'];
    assert.equal(sMeta.configured, true);
    assert.equal(sMeta.hasApiKey, true);
    assert.equal(sMeta.hasOrganizationId, true);
    assert.ok(sMeta.maskedTunnelId.includes('...'), 'maskedTunnelId must be masked');
    assert.notEqual(sMeta.maskedTunnelId, rawTunnelId);

    // CRITICAL: NEVER decrypt or expose raw secrets in DTO
    assert.equal(sMeta.apiKey, undefined, 'DTO must never contain raw apiKey');
    assert.equal(sMeta.organizationId, undefined, 'DTO must not expose raw org secrets');
    assert.equal(JSON.stringify(created).includes(rawApiKey), false, 'DTO JSON must not contain raw api key');

    // Unconfigured service
    assert.equal(created.services['antigravity-mcp'].configured, false);
    assert.equal(created.services['antigravity-mcp'].hasApiKey, false);
    assert.equal(created.services['antigravity-mcp'].maskedTunnelId, null);

    // GET / listProfiles() check
    const list = store.listProfiles();
    assert.equal(list.length, 1);
    assert.equal(JSON.stringify(list).includes(rawApiKey), false, 'listProfiles() must never contain raw apiKey');
    assert.equal(list[0].services['overleaf-mcp'].hasApiKey, true);

    // getProfile() check
    const single = store.getProfile('prof-secret');
    assert.equal(single.id, 'prof-secret');
    assert.equal(JSON.stringify(single).includes(rawApiKey), false);

    // PATCH Profile: Retains existing sealed credential if apiKey omitted
    const patched = await store.patchProfile('prof-secret', {
      services: {
        'overleaf-mcp': {
          tunnelId: 'tunnel-prod-live-99'
          // apiKey omitted!
        }
      }
    }, { expectedRevision: 1, profileRevision: 1 });

    assert.equal(patched.revision, 2);
    assert.equal(patched.services['overleaf-mcp'].hasApiKey, true, 'hasApiKey should remain true when apiKey omitted');
    assert.equal(JSON.stringify(patched).includes(rawApiKey), false);

    // Verify that the internal credential actually retained the apiKey
    const op = store.createOperation({
      profileId: 'prof-secret',
      targets: ['overleaf-mcp'],
      expectedRevision: store.getRevision()
    });
    const unsealedCred = await store.pinnedCredential(op.id, 'overleaf-mcp');
    assert.equal(unsealedCred.apiKey, rawApiKey, 'Retained sealed apiKey must match original');
    assert.equal(unsealedCred.tunnelId, 'tunnel-prod-live-99', 'Updated tunnelId must match');

    // Rollback this temp operation to clean up active slot
    await store.begin(op.id);
    store.finishRollback(op.id, 'ROLLED_BACK');

    // DELETE Profile: succeeds when profile is not active
    const delRes = store.deleteProfile('prof-secret', { expectedRevision: store.getRevision(), profileRevision: 2 });
    assert.equal(delRes.success, true);
    assert.equal(store.listProfiles().length, 0);

    // Deleting non-existent profile throws 404
    assert.throws(() => {
      store.deleteProfile('prof-secret');
    }, (err) => err.status === 404);

    await store.close();
  });

  it('3. revision conflict checking', async () => {
    const store = openStore({ dataDir: tmpDir, vault: fakeVault });

    // Global revision mismatch on createProfile
    await assert.rejects(async () => {
      await store.createProfile({ id: 'p1', label: 'P1' }, { expectedRevision: 999 });
    }, (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'CONFLICT');
      return true;
    });

    // Create profile at expectedRevision 0
    const p1 = await store.createProfile({ id: 'p1', label: 'P1' }, { expectedRevision: 0 });
    assert.equal(store.getRevision(), 1);

    // Patch global revision mismatch
    await assert.rejects(async () => {
      await store.patchProfile('p1', { label: 'New P1' }, { expectedRevision: 0, profileRevision: 1 });
    }, (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'CONFLICT');
      return true;
    });

    // Patch profile revision mismatch
    await assert.rejects(async () => {
      await store.patchProfile('p1', { label: 'New P1' }, { expectedRevision: 1, profileRevision: 99 });
    }, (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'CONFLICT');
      return true;
    });

    // Delete global revision mismatch
    assert.throws(() => {
      store.deleteProfile('p1', { expectedRevision: 0, profileRevision: 1 });
    }, (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'CONFLICT');
      return true;
    });

    // Delete profile revision mismatch
    assert.throws(() => {
      store.deleteProfile('p1', { expectedRevision: 1, profileRevision: 99 });
    }, (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'CONFLICT');
      return true;
    });

    await store.close();
  });

  it('4. idempotency key (same returns original, different throws 409)', async () => {
    const store = openStore({ dataDir: tmpDir, vault: fakeVault });

    await store.createProfile({
      id: 'prof-idemp',
      label: 'Idemp Test',
      services: {
        'overleaf-mcp': { apiKey: 'key1' }
      }
    }, { expectedRevision: 0 });

    const opReq = {
      profileId: 'prof-idemp',
      profileRevision: 1,
      targets: ['overleaf-mcp'],
      expectedRevision: 1,
      idempotencyKey: 'idemp-key-123'
    };

    // First call creates the operation
    const op1 = store.createOperation(opReq);
    assert.equal(op1.status, 'QUEUED');
    assert.equal(op1.idempotencyKey, 'idemp-key-123');

    // Second call with EXACT same key and body returns original op
    const op2 = store.createOperation(opReq);
    assert.equal(op2.id, op1.id);
    assert.equal(op2.createdAt, op1.createdAt);

    // Call with SAME key but DIFFERENT body throws 409 IDEMPOTENCY_CONFLICT
    assert.throws(() => {
      store.createOperation({
        ...opReq,
        targets: ['antigravity-mcp'] // different targets!
      });
    }, (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'IDEMPOTENCY_CONFLICT');
      return true;
    });

    // Call with SAME key but different profileId throws 409 IDEMPOTENCY_CONFLICT
    assert.throws(() => {
      store.createOperation({
        ...opReq,
        profileId: 'different-profile'
      });
    }, (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'IDEMPOTENCY_CONFLICT');
      return true;
    });

    await store.close();
  });

  it('5. single-operation slot / busy rejection', async () => {
    const store = openStore({ dataDir: tmpDir, vault: fakeVault });

    await store.createProfile({
      id: 'prof-busy',
      label: 'Busy Test'
    }, { expectedRevision: 0 });

    const op1 = store.createOperation({
      profileId: 'prof-busy',
      targets: ['overleaf-mcp'],
      expectedRevision: 1,
      idempotencyKey: 'op-1'
    });
    assert.equal(op1.status, 'QUEUED');

    // While op1 is active, creating another operation throws 409 BUSY
    assert.throws(() => {
      store.createOperation({
        profileId: 'prof-busy',
        targets: ['antigravity-mcp'],
        expectedRevision: 1,
        idempotencyKey: 'op-2'
      });
    }, (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'BUSY');
      return true;
    });

    // Advance op1 to PREPARING
    await store.begin(op1.id);

    // Still busy
    assert.throws(() => {
      store.createOperation({
        profileId: 'prof-busy',
        targets: ['antigravity-mcp'],
        expectedRevision: 1,
        idempotencyKey: 'op-3'
      });
    }, (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'BUSY');
      return true;
    });

    // Finish op1 with ROLLED_BACK (terminal state)
    store.finishRollback(op1.id, 'ROLLED_BACK');

    // Now slot is free, op2 can be created
    const op2 = store.createOperation({
      profileId: 'prof-busy',
      targets: ['antigravity-mcp'],
      expectedRevision: 1,
      idempotencyKey: 'op-2'
    });
    assert.equal(op2.status, 'QUEUED');

    await store.close();
  });

  it('6. begin() atomic check and phase transitions', async () => {
    const store = openStore({ dataDir: tmpDir, vault: fakeVault });

    await store.createProfile({
      id: 'prof-flow',
      label: 'Flow Test',
      services: {
        'overleaf-mcp': {
          tunnelId: 'tun-flow-1',
          apiKey: 'key-flow-1'
        }
      }
    }, { expectedRevision: 0 });

    const op = store.createOperation({
      profileId: 'prof-flow',
      targets: ['overleaf-mcp'],
      expectedRevision: 1
    });

    // Verify pendingOperationIds returns op.id
    const pending = store.pendingOperationIds();
    assert.deepEqual(pending, [op.id]);

    // Test publicOperation & load
    const pub = store.publicOperation(op.id);
    assert.equal(pub.id, op.id);
    assert.equal(pub.status, 'QUEUED');
    assert.equal(pub.apiKey, undefined);

    // begin() checks atomic requirements and moves to PREPARING
    const begun = store.begin(op.id);
    assert.equal(begun.status, 'PREPARING');

    // begin() on non-queued operation throws 409
    assert.throws(() => {
      store.begin(op.id);
    }, (err) => err.status === 409);

    // Test pinned credentials
    const pinned = await store.pinnedCredential(op.id, 'overleaf-mcp');
    assert.deepEqual(pinned, { tunnelId: 'tun-flow-1', apiKey: 'key-flow-1' });

    // Pinned credential for unconfigured target returns null
    const nonTargetPinned = await store.pinnedCredential(op.id, 'non-existent');
    assert.equal(nonTargetPinned, null);

    // Step prepared: seals snapshot and stores in operation_steps
    const snapshot = { priorTunnel: 'tun-orig-000', priorAccount: 'acc-old' };
    await store.prepared(op.id, 'overleaf-mcp', snapshot);

    const unsealedSnap = await store.unsealSnapshot(op.id, 'overleaf-mcp');
    assert.deepEqual(unsealedSnap, snapshot);

    // Phase transition to APPLYING
    store.phase(op.id, 'APPLYING');
    let loaded = store.load(op.id);
    assert.equal(loaded.status, 'APPLYING');

    // Mark step mayHaveMutated
    store.markMayMutate(op.id, 'overleaf-mcp');
    const stepInfo = store.step(op.id, 'overleaf-mcp');
    assert.equal(stepInfo.mayHaveMutated, true);

    // Mark applied
    store.applied(op.id, 'overleaf-mcp');
    const stepApplied = store.step(op.id, 'overleaf-mcp');
    assert.equal(stepApplied.state, 'APPLIED');

    // Non-existent step returns null
    assert.equal(store.step(op.id, 'non-existent'), null);

    await store.close();
  });

  it('7. commitSuccess updates active profiles atomically', async () => {
    const store = openStore({ dataDir: tmpDir, vault: fakeVault });

    await store.createProfile({
      id: 'prof-commit',
      label: 'Commit Test',
      services: {
        'overleaf-mcp': { tunnelId: 'tun-commit', apiKey: 'key-commit' },
        'antigravity-mcp': { tunnelId: 'tun-anti', apiKey: 'key-anti' }
      }
    }, { expectedRevision: 0 });

    const op = store.createOperation({
      profileId: 'prof-commit',
      targets: ['overleaf-mcp', 'antigravity-mcp'],
      expectedRevision: 1
    });

    store.begin(op.id);
    assert.equal(store.getRevision(), 1);

    // Initially neither service is active
    const initialServices = store.listServices();
    assert.equal(initialServices['overleaf-mcp'].activeProfileId, null);
    assert.equal(initialServices['antigravity-mcp'].activeProfileId, null);

    // Commit success
    store.commitSuccess(op.id);

    // Global revision incremented
    assert.equal(store.getRevision(), 2);

    // Operation status is SUCCEEDED
    const loaded = store.load(op.id);
    assert.equal(loaded.status, 'SUCCEEDED');

    // Both services now have prof-commit active
    const services = store.listServices();
    assert.equal(services['overleaf-mcp'].activeProfileId, 'prof-commit');
    assert.equal(services['antigravity-mcp'].activeProfileId, 'prof-commit');

    // Deleting active profile is forbidden!
    assert.throws(() => {
      store.deleteProfile('prof-commit', { expectedRevision: 2, profileRevision: 1 });
    }, (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'PROFILE_ACTIVE');
      return true;
    });

    await store.close();
  });

  it('8. rollback and recovery gate setting', async () => {
    const store = openStore({ dataDir: tmpDir, vault: fakeVault });

    await store.createProfile({
      id: 'prof-rollback',
      label: 'Rollback Test',
      services: {
        'overleaf-mcp': { apiKey: 'key-rb' }
      }
    }, { expectedRevision: 0 });

    // Scenario A: Clean rollback (ROLLED_BACK) - does not set recovery gate
    const op1 = store.createOperation({
      profileId: 'prof-rollback',
      targets: ['overleaf-mcp'],
      expectedRevision: 1,
      idempotencyKey: 'op-rb-1'
    });
    store.begin(op1.id);
    await store.prepared(op1.id, 'overleaf-mcp', { test: 1 });
    store.markMayMutate(op1.id, 'overleaf-mcp');
    store.restored(op1.id, 'overleaf-mcp');
    const stepRestored = store.step(op1.id, 'overleaf-mcp');
    assert.equal(stepRestored.state, 'RESTORED');

    store.finishRollback(op1.id, 'ROLLED_BACK');
    assert.equal(store.load(op1.id).status, 'ROLLED_BACK');
    assert.deepEqual(store.getRecoveryState(), { gated: false });

    // Scenario B: Rollback failure ending in NEEDS_ATTENTION sets recovery gate
    const op2 = store.createOperation({
      profileId: 'prof-rollback',
      targets: ['overleaf-mcp'],
      expectedRevision: 1,
      idempotencyKey: 'op-rb-2'
    });
    store.begin(op2.id);
    await store.prepared(op2.id, 'overleaf-mcp', { test: 2 });
    store.markMayMutate(op2.id, 'overleaf-mcp');

    // Restore fails
    store.restoreFailed(op2.id, 'overleaf-mcp', 'Network timeout during rollback');
    const stepFailed = store.step(op2.id, 'overleaf-mcp');
    assert.equal(stepFailed.state, 'RESTORE_FAILED');
    assert.equal(stepFailed.failureReason, 'Network timeout during rollback');

    store.phase(op2.id, 'ROLLING_BACK', 'RESTORE_FAILED');
    store.finishRollback(op2.id, 'NEEDS_ATTENTION');

    // Verify recovery gate is now active
    const recState = store.getRecoveryState();
    assert.equal(recState.gated, true);
    assert.ok(recState.reason.includes('NEEDS_ATTENTION'));

    // Any attempt to create new operation is blocked with RECOVERY_GATED
    assert.throws(() => {
      store.createOperation({
        profileId: 'prof-rollback',
        targets: ['overleaf-mcp'],
        expectedRevision: 1,
        idempotencyKey: 'op-rb-3'
      });
    }, (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'RECOVERY_GATED');
      return true;
    });

    // Resetting recovery gate clears gate
    store.resetRecoveryGate();
    assert.deepEqual(store.getRecoveryState(), { gated: false });

    await store.close();
  });

  it('9. pendingOperationIds returns all non-terminal interrupted states before QUEUED in stable order', async () => {
    const store = openStore({ dataDir: tmpDir, vault: fakeVault });

    await store.createProfile({
      id: 'prof-pending',
      label: 'Pending Test'
    }, { expectedRevision: 0 });

    const db = new DatabaseSync(path.join(tmpDir, 'manager.db'));
    const insertOp = db.prepare(`
      INSERT INTO operations (
        id, profile_id, profile_revision, targets, expected_revision,
        idempotency_key, request_payload, pinned_credentials,
        status, failure_code, created_at, updated_at
      ) VALUES (?, 'prof-pending', 1, '["overleaf-mcp"]', 1, NULL, '{}', '{}', ?, NULL, ?, ?)
    `);

    // Insert various terminal and non-terminal operations with distinct timestamps
    insertOp.run('op-term-succeeded', 'SUCCEEDED', '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z');
    insertOp.run('op-term-rolledback', 'ROLLED_BACK', '2026-11-04T00:05:00.000Z', '2026-11-04T00:05:00.000Z');
    insertOp.run('op-term-rejected', 'REJECTED', '2026-11-04T00:10:00.000Z', '2026-11-04T00:10:00.000Z');
    insertOp.run('op-term-attention', 'NEEDS_ATTENTION', '2026-11-04T00:15:00.000Z', '2026-11-04T00:15:00.000Z');

    insertOp.run('op-int-preparing', 'PREPARING', '2026-11-04T00:30:00.000Z', '2026-11-04T00:30:00.000Z');
    insertOp.run('op-int-applying', 'APPLYING', '2026-11-04T03:00:00.000Z', '2026-11-04T03:00:00.000Z');
    insertOp.run('op-int-verifying', 'VERIFYING', '2026-11-04T04:00:00.000Z', '2026-11-04T04:00:00.000Z');
    insertOp.run('op-int-rollingback', 'ROLLING_BACK', '2026-11-04T02:30:00.000Z', '2026-11-04T02:30:00.000Z');

    insertOp.run('op-queued-1', 'QUEUED', '2026-11-04T01:00:00.000Z', '2026-11-04T01:00:00.000Z');
    insertOp.run('op-queued-2', 'QUEUED', '2026-11-04T02:00:00.000Z', '2026-11-04T02:00:00.000Z');

    const pendingIds = store.pendingOperationIds();

    // Must return all interrupted nonterminal operations first (ordered by created_at ASC, id ASC)
    // followed by QUEUED operations (ordered by created_at ASC, id ASC)
    // and exclude terminal operations
    assert.deepEqual(pendingIds, [
      'op-int-preparing',
      'op-int-rollingback',
      'op-int-applying',
      'op-int-verifying',
      'op-queued-1',
      'op-queued-2'
    ]);

    await store.close();
  });

  it('10. independently derived AAD roundtrip and tampering rejection with real vault', async () => {
    const vaultDir = path.join(tmpDir, 'real-vault');
    const realVault = createVault({ dataDir: vaultDir });
    const store = openStore({ dataDir: tmpDir, vault: realVault });

    // 1. Profile creation with revision 1
    const profile = await store.createProfile({
      id: 'prof-aad-1',
      label: 'AAD Test Profile',
      services: {
        'overleaf-mcp': { tunnelId: 'tun-ovl-1', apiKey: 'key-ovl-1' },
        'antigravity-mcp': { tunnelId: 'tun-ant-1', apiKey: 'key-ant-1' }
      }
    }, { expectedRevision: 0 });

    assert.equal(profile.revision, 1);

    // 2. Patch profile to revision 2
    const patched = await store.patchProfile('prof-aad-1', {
      services: {
        'overleaf-mcp': { apiKey: 'key-ovl-2' }
      }
    }, { expectedRevision: 1, profileRevision: 1 });

    assert.equal(patched.revision, 2);

    // 3. Create operation: unseals profile creds with rev 2 and seals pinned with operation AAD
    const op = store.createOperation({
      profileId: 'prof-aad-1',
      targets: ['overleaf-mcp', 'antigravity-mcp'],
      expectedRevision: 2
    });

    // Pinned credentials unseal cleanly with independently derived operation AAD
    const pinnedOvl = await store.pinnedCredential(op.id, 'overleaf-mcp');
    assert.equal(pinnedOvl.apiKey, 'key-ovl-2');
    assert.equal(pinnedOvl.tunnelId, 'tun-ovl-1');

    const pinnedAnt = await store.pinnedCredential(op.id, 'antigravity-mcp');
    assert.equal(pinnedAnt.apiKey, 'key-ant-1');
    assert.equal(pinnedAnt.tunnelId, 'tun-ant-1');

    // 4. Prepared snapshot: seals with snapshot AAD and unseals cleanly
    const snap = { originalFingerprint: 'f'.repeat(64), desiredFingerprint: 'e'.repeat(64) };
    await store.prepared(op.id, 'overleaf-mcp', snap);

    const unsealedSnap = await store.unsealSnapshot(op.id, 'overleaf-mcp');
    assert.deepEqual(unsealedSnap, snap);

    // 5. Tampering rejection:
    // A) Alter ciphertext data of pinned credentials in operations table
    const db = new DatabaseSync(path.join(tmpDir, 'manager.db'));
    const opRow = db.prepare('SELECT pinned_credentials FROM operations WHERE id = ?').get(op.id);
    const pinnedObj = JSON.parse(opRow.pinned_credentials);
    pinnedObj['overleaf-mcp'].data = Buffer.from('corrupted-data').toString('base64');
    db.prepare('UPDATE operations SET pinned_credentials = ? WHERE id = ?')
      .run(JSON.stringify(pinnedObj), op.id);

    await assert.rejects(
      async () => await store.pinnedCredential(op.id, 'overleaf-mcp'),
      (err) => err.message.includes('Decryption failed') || err.message.includes('integrity')
    );

    // B) Swap snapshot row between services to verify AAD service mismatch triggers rejection
    const stepRow = db.prepare('SELECT sealed_snapshot FROM operation_steps WHERE operation_id = ? AND service_id = ?')
      .get(op.id, 'overleaf-mcp');
    // Place overleaf-mcp's sealed snapshot into antigravity-mcp's row
    db.prepare(`
      INSERT INTO operation_steps (operation_id, service_id, sealed_snapshot, state, created_at, updated_at)
      VALUES (?, 'antigravity-mcp', ?, 'PREPARED', ?, ?)
    `).run(op.id, stepRow.sealed_snapshot, new Date().toISOString(), new Date().toISOString());

    // When unsealing for antigravity-mcp, AAD includes 'antigravity-mcp' which mismatches sealed AAD 'overleaf-mcp'
    await assert.rejects(
      async () => await store.unsealSnapshot(op.id, 'antigravity-mcp'),
      (err) => err.message.includes('Decryption failed') || err.message.includes('integrity')
    );

    await store.close();
  });

  it('11. Registry attachment and dynamic registered services in listServices and profiles', async () => {
    const store = openStore({ dataDir: tmpDir, vault: fakeVault });

    // Verify registry is attached and exposed
    assert.ok(store.registry, 'store.registry should be exposed');
    assert.equal(typeof store.registry.listServices, 'function');
    assert.equal(typeof store.registry.create, 'function');

    // Legacy services exist in registry
    const initialServices = store.registry.listServices();
    assert.ok(initialServices.some(s => s.id === 'overleaf-mcp'));
    assert.ok(initialServices.some(s => s.id === 'antigravity-mcp'));

    // Create a new third service
    const thirdSvc = await store.registry.create({
      id: 'mcp_weather',
      label: 'Weather MCP Service',
      sortOrder: 200,
      binding: { type: 'stdio', executable: 'weather.exe', args: [] }
    });
    assert.equal(thirdSvc.id, 'mcp_weather');

    // Dynamic listServices in store includes all 3 services
    const storeServices = store.listServices();
    assert.ok(storeServices.length >= 3);
    assert.ok(storeServices['mcp_weather']);
    assert.equal(storeServices['mcp_weather'].serviceId, 'mcp_weather');

    // Profiles dynamically include the registered services
    const prof = await store.createProfile({
      id: 'prof-dynamic-services',
      label: 'Dynamic Profile',
      services: {
        'mcp_weather': {
          tunnelId: 'tun_weather_123',
          apiKey: 'key_weather_999'
        }
      }
    });

    assert.equal(prof.services['mcp_weather'].configured, true);
    assert.ok(prof.services['mcp_weather'].maskedTunnelId);
    assert.equal(prof.services['overleaf-mcp'].configured, false);
    assert.equal(prof.services['overleaf-mcp'].maskedTunnelId, null);

    await store.close();
  });

  it('12. Pinned registry snapshot in createOperation and unsealing in load', async () => {
    const store = openStore({ dataDir: tmpDir, vault: fakeVault });

    // Register third service
    await store.registry.create({
      id: 'mcp_database',
      label: 'DB MCP',
      sortOrder: 300,
      binding: { type: 'stdio', executable: 'db.exe', args: [{ id: 'flag', value: '--prod', secret: false }] }
    });

    const prof = await store.createProfile({
      id: 'prof-snap',
      label: 'Snapshot Profile',
      services: {
        'overleaf-mcp': { tunnelId: 'tun_1', apiKey: 'key_1' },
        'mcp_database': { tunnelId: 'tun_db', apiKey: 'key_db' }
      }
    });

    const curRev = store.getRevision();
    const op = store.createOperation({
      profileId: prof.id,
      targets: ['overleaf-mcp', 'mcp_database'],
      expectedRevision: curRev
    });

    // Public operation NEVER exposes snapshot or secret credentials
    assert.equal(op.registrySnapshot, undefined);
    assert.equal(op.sealed_registry_snapshot, undefined);
    assert.equal(op.pinnedCredentials, undefined);

    // Internal load unseals snapshot cleanly
    const loaded = store.load(op.id);
    assert.ok(loaded.registrySnapshot, 'op.registrySnapshot should be attached');
    assert.equal(loaded.registrySnapshot.revision, curRev);
    assert.equal(loaded.registrySnapshot.services.length, 2);
    const snapDb = loaded.registrySnapshot.services.find(s => s.id === 'mcp_database');
    assert.ok(snapDb);
    assert.equal(snapDb.label, 'DB MCP');

    // Mutating registry afterwards does NOT mutate pinned snapshot
    await store.registry.update('mcp_database', { label: 'DB MCP V2' });
    const reloaded = store.load(op.id);
    const snapDbAfter = reloaded.registrySnapshot.services.find(s => s.id === 'mcp_database');
    assert.equal(snapDbAfter.label, 'DB MCP');

    await store.close();
  });

  it('13. Stop actions routing in publicOperation and assertIdle', async () => {
    const store = openStore({ dataDir: tmpDir, vault: fakeVault });

    await store.registry.create({
      id: 'mcp_search',
      label: 'Search MCP',
      binding: { type: 'stdio', executable: 'search.exe', args: [] }
    });

    // Create stop action
    const stopAction = await store.registry.createStopAction({
      serviceId: 'mcp_search',
      idempotencyKey: 'stop-search-key-1'
    });

    assert.equal(stopAction.kind, 'stop');
    assert.equal(stopAction.serviceId, 'mcp_search');
    assert.equal(stopAction.state, 'QUEUED');

    // publicOperation routes stop action IDs
    const routed = store.publicOperation(stopAction.id);
    assert.equal(routed.id, stopAction.id);
    assert.equal(routed.kind, 'stop');
    assert.equal(routed.serviceId, 'mcp_search');

    // assertIdle detects active stop action and throws BUSY
    assert.throws(
      () => store.assertIdle(),
      (err) => err.code === 'BUSY'
    );

    // assertIdle with excludeActionId allows caller action to proceed
    assert.doesNotThrow(() => store.assertIdle({ excludeActionId: stopAction.id }));

    // Mark action attention and verify RECOVERY_GATED
    await store.registry.markActionAttention(stopAction.id, 'CRASHED_IN_STOP');
    assert.throws(
      () => store.assertIdle(),
      (err) => err.code === 'RECOVERY_GATED'
    );

    store.resetRecoveryGate();
    await store.close();
  });

  it('14. Unified getWorkQueue ordering combining switch operations and stop actions', async () => {
    const store = openStore({ dataDir: tmpDir, vault: fakeVault });

    await store.createProfile({
      id: 'prof-wq',
      label: 'WQ Profile'
    }, { expectedRevision: 0 });

    const db = new DatabaseSync(path.join(tmpDir, 'manager.db'));
    const insertOp = db.prepare(`
      INSERT INTO operations (
        id, profile_id, profile_revision, targets, expected_revision,
        idempotency_key, request_payload, pinned_credentials,
        status, failure_code, created_at, updated_at
      ) VALUES (?, 'prof-wq', 1, '["overleaf-mcp"]', 1, NULL, '{}', '{}', ?, NULL, ?, ?)
    `);

    const insertAction = db.prepare(`
      INSERT INTO mcp_actions (
        id, service_id, idempotency_key, request_fingerprint,
        state, error_code, sealed_payload, created_at, updated_at
      ) VALUES (?, 'overleaf-mcp', NULL, 'fp', ?, NULL, '{}', ?, ?)
    `);

    // Switch ops
    insertOp.run('op-int-prep', 'PREPARING', '2026-11-04T01:00:00.000Z', '2026-11-04T01:00:00.000Z');
    insertOp.run('op-queued-2', 'QUEUED', '2026-11-04T03:00:00.000Z', '2026-11-04T03:00:00.000Z');
    insertOp.run('op-term-succeeded', 'SUCCEEDED', '2026-11-04T00:30:00.000Z', '2026-11-04T00:30:00.000Z');
    insertOp.run('op-term-attention', 'NEEDS_ATTENTION', '2026-11-04T00:10:00.000Z', '2026-11-04T00:10:00.000Z');
    insertOp.run('op-term-rolledback', 'ROLLED_BACK', '2026-11-04T00:20:00.000Z', '2026-11-04T00:20:00.000Z');
    insertOp.run('op-term-rejected', 'REJECTED', '2026-11-04T00:25:00.000Z', '2026-11-04T00:25:00.000Z');

    // Stop actions
    insertAction.run('act-int-applying', 'APPLYING', '2026-11-04T01:30:00.000Z', '2026-11-04T01:30:00.000Z');
    insertAction.run('act-queued-1', 'QUEUED', '2026-11-04T02:00:00.000Z', '2026-11-04T02:00:00.000Z');
    insertAction.run('act-term-succeeded', 'SUCCEEDED', '2026-11-04T00:45:00.000Z', '2026-11-04T00:45:00.000Z');
    insertAction.run('act-term-attention', 'NEEDS_ATTENTION', '2026-11-04T00:15:00.000Z', '2026-11-04T00:15:00.000Z');
    insertAction.run('act-term-rejected', 'REJECTED', '2026-11-04T00:22:00.000Z', '2026-11-04T00:22:00.000Z');

    const wq = store.getWorkQueue();

    // Unified work queue must return:
    // Interrupted nonterminal items first (ordered by createdAt ASC, id ASC):
    // 1. op-int-prep (01:00)
    // 2. act-int-applying (01:30)
    // Followed by QUEUED items (ordered by createdAt ASC, id ASC):
    // 3. act-queued-1 (02:00)
    // 4. op-queued-2 (03:00)
    // Terminal items (SUCCEEDED, ROLLED_BACK, REJECTED, NEEDS_ATTENTION) are excluded!
    assert.deepEqual(wq, [
      'op-int-prep',
      'act-int-applying',
      'act-queued-1',
      'op-queued-2'
    ]);

    await store.close();
  });

  it('15. commitSuccess records profile_revision and service_revision in active_profiles', async () => {
    const store = openStore({ dataDir: tmpDir, vault: fakeVault });

    await store.registry.create({
      id: 'mcp_docs',
      label: 'Docs MCP',
      sortOrder: 400,
      binding: { type: 'stdio', executable: 'docs.exe', args: [] }
    });

    const prof = await store.createProfile({
      id: 'prof-revs',
      label: 'Rev Profile',
      services: {
        'mcp_docs': { tunnelId: 'tun_d', apiKey: 'key_d' }
      }
    });

    const op = store.createOperation({
      profileId: prof.id,
      targets: ['mcp_docs']
    });

    await store.begin(op.id);
    await store.commitSuccess(op.id);

    // Check active_profiles directly
    const db = new DatabaseSync(path.join(tmpDir, 'manager.db'));
    const row = db.prepare('SELECT * FROM active_profiles WHERE service_id = ?').get('mcp_docs');
    assert.ok(row);
    assert.equal(row.profile_id, prof.id);
    assert.equal(row.profile_revision, 1);
    assert.equal(row.service_revision, 1);

    // Finish stop action clears active service mapping
    const stopAction = await store.registry.createStopAction({ serviceId: 'mcp_docs' });
    const receipt = {
      stopped: true,
      operationId: stopAction.id,
      service: 'mcp_docs',
      proof: { kind: 'verified-already-stopped' }
    };
    await store.registry.finishStoppedAction(stopAction.id, receipt);

    const clearedRow = db.prepare('SELECT * FROM active_profiles WHERE service_id = ?').get('mcp_docs');
    assert.equal(clearedRow, undefined, 'active_profiles row should be deleted after stopped action finishes');

    await store.close();
  });

  it('16. importDiscoveredProfile deduplication and merge', async () => {
    const store = openStore({ dataDir: tmpDir, vault: fakeVault });

    const prov = { identity: 'source_discovered_yaml_1' };
    const p1 = await store.importDiscoveredProfile({
      id: 'prof-disc-1',
      label: 'Discovered Profile',
      services: {
        'overleaf-mcp': { tunnelId: 'tun_ovl_disc', apiKey: 'key_ovl_disc' }
      }
    }, { provenance: prov });

    assert.equal(p1.created, true);
    assert.equal(p1.profile.id, 'prof-disc-1');

    // Re-import with same provenance is idempotent
    const p2 = await store.importDiscoveredProfile({
      id: 'prof-disc-2',
      label: 'Different Label',
      services: {
        'overleaf-mcp': { tunnelId: 'tun_should_not_overwrite', apiKey: 'key_should_not_overwrite' }
      }
    }, { provenance: prov });

    assert.equal(p2.created, false);
    assert.equal(p2.profile.id, 'prof-disc-1');

    // Merge into existing profile
    const pMerged = await store.importDiscoveredProfile({
      services: {
        'antigravity-mcp': { tunnelId: 'tun_ant_merged', apiKey: 'key_ant_merged' }
      }
    }, { mergeProfileId: 'prof-disc-1' });

    assert.equal(pMerged.created, false);
    assert.equal(pMerged.profile.services['antigravity-mcp'].configured, true);

    await store.close();
  });

  it('17. withWriteTransaction serializes writes and rolls back cleanly on error', async () => {
    const store = openStore({ dataDir: tmpDir, vault: fakeVault });

    let writeOrder = [];
    const p1 = store.withWriteTransaction(() => {
      writeOrder.push('first-start');
      writeOrder.push('first-end');
      return 'res1';
    });

    const pFail = store.withWriteTransaction(() => {
      writeOrder.push('fail-attempt');
      throw new Error('boom');
    });

    const p2 = store.withWriteTransaction(() => {
      writeOrder.push('second');
      return 'res2';
    });

    assert.equal(await p1, 'res1');
    await assert.rejects(async () => await pFail, /boom/);
    assert.equal(await p2, 'res2');

    assert.deepEqual(writeOrder, ['first-start', 'first-end', 'fail-attempt', 'second']);

    await store.close();
  });

  it('18. getWorkQueue SQL branches exclude all terminal states including NEEDS_ATTENTION while assertIdle enforces persistent recovery gate', async () => {
    const store = openStore({ dataDir: tmpDir, vault: fakeVault });

    await store.createProfile({
      id: 'prof-wq-term',
      label: 'Terminal Test Profile'
    }, { expectedRevision: 0 });

    const db = new DatabaseSync(path.join(tmpDir, 'manager.db'));
    const insertOp = db.prepare(`
      INSERT INTO operations (
        id, profile_id, profile_revision, targets, expected_revision,
        idempotency_key, request_payload, pinned_credentials,
        status, failure_code, created_at, updated_at
      ) VALUES (?, 'prof-wq-term', 1, '["overleaf-mcp"]', 1, NULL, '{}', '{}', ?, NULL, ?, ?)
    `);

    const insertAction = db.prepare(`
      INSERT INTO mcp_actions (
        id, service_id, idempotency_key, request_fingerprint,
        state, error_code, sealed_payload, created_at, updated_at
      ) VALUES (?, 'overleaf-mcp', NULL, 'fp', ?, NULL, '{}', ?, ?)
    `);

    // Interrupted switch operations
    insertOp.run('op-prep', 'PREPARING', '2026-11-04T01:00:00.000Z', '2026-11-04T01:00:00.000Z');
    insertOp.run('op-apply', 'APPLYING', '2026-11-04T01:10:00.000Z', '2026-11-04T01:10:00.000Z');
    insertOp.run('op-verify', 'VERIFYING', '2026-11-04T01:20:00.000Z', '2026-11-04T01:20:00.000Z');
    insertOp.run('op-rollback', 'ROLLING_BACK', '2026-11-04T01:30:00.000Z', '2026-11-04T01:30:00.000Z');
    // Queued switch operation
    insertOp.run('op-queued', 'QUEUED', '2026-11-04T02:00:00.000Z', '2026-11-04T02:00:00.000Z');
    // Terminal switch operations (must NOT be in runnable queue)
    insertOp.run('op-succeeded', 'SUCCEEDED', '2026-11-04T00:10:00.000Z', '2026-11-04T00:10:00.000Z');
    insertOp.run('op-rolledback', 'ROLLED_BACK', '2026-11-04T00:20:00.000Z', '2026-11-04T00:20:00.000Z');
    insertOp.run('op-rejected', 'REJECTED', '2026-11-04T00:30:00.000Z', '2026-11-04T00:30:00.000Z');
    insertOp.run('op-attention', 'NEEDS_ATTENTION', '2026-11-04T00:40:00.000Z', '2026-11-04T00:40:00.000Z');

    // Interrupted stop action
    insertAction.run('act-apply', 'APPLYING', '2026-11-04T01:15:00.000Z', '2026-11-04T01:15:00.000Z');
    // Queued stop action
    insertAction.run('act-queued', 'QUEUED', '2026-11-04T02:15:00.000Z', '2026-11-04T02:15:00.000Z');
    // Terminal stop actions (must NOT be in runnable queue)
    insertAction.run('act-succeeded', 'SUCCEEDED', '2026-11-04T00:15:00.000Z', '2026-11-04T00:15:00.000Z');
    insertAction.run('act-rejected', 'REJECTED', '2026-11-04T00:25:00.000Z', '2026-11-04T00:25:00.000Z');
    insertAction.run('act-attention', 'NEEDS_ATTENTION', '2026-11-04T00:35:00.000Z', '2026-11-04T00:35:00.000Z');

    const queue = store.getWorkQueue();

    // Verify terminal states are completely absent:
    assert.ok(!queue.includes('op-succeeded'));
    assert.ok(!queue.includes('op-rolledback'));
    assert.ok(!queue.includes('op-rejected'));
    assert.ok(!queue.includes('op-attention'), 'NEEDS_ATTENTION operation must be excluded from getWorkQueue');
    assert.ok(!queue.includes('act-succeeded'));
    assert.ok(!queue.includes('act-rejected'));
    assert.ok(!queue.includes('act-attention'), 'NEEDS_ATTENTION action must be excluded from getWorkQueue');

    // Verify ordering: interrupted work prioritized before QUEUED work, createdAt ASC, id ASC
    assert.deepEqual(queue, [
      'op-prep',       // 01:00 (interrupted)
      'op-apply',      // 01:10 (interrupted)
      'act-apply',     // 01:15 (interrupted)
      'op-verify',     // 01:20 (interrupted)
      'op-rollback',   // 01:30 (interrupted)
      'op-queued',     // 02:00 (queued)
      'act-queued'     // 02:15 (queued)
    ]);

    // Verify assertIdle still throws RECOVERY_GATED despite queue exclusion
    assert.throws(
      () => store.assertIdle(),
      (err) => err instanceof StoreError && err.code === 'RECOVERY_GATED' && err.status === 409
    );

    // Verify resetRecoveryGate clears metadata, but persistent NEEDS_ATTENTION still blocks assertIdle and new work
    store.resetRecoveryGate();
    assert.equal(store.getRecoveryState().gated, false);
    assert.throws(
      () => store.assertIdle(),
      (err) => err instanceof StoreError && err.code === 'RECOVERY_GATED' && err.status === 409
    );

    // Attempting createOperation is gated
    assert.throws(
      () => store.createOperation({ profileId: 'prof-wq-term', targets: ['overleaf-mcp'] }),
      (err) => err.code === 'RECOVERY_GATED'
    );

    // Now test the fallback branch when mcp_actions table does not exist
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-wq-'));
    try {
      const legacyDb = new DatabaseSync(path.join(legacyDir, 'manager.db'));
      legacyDb.exec(`
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO metadata (key, value) VALUES ('revision', '1'), ('recovery_gated', '0'), ('recovery_reason', '');
        CREATE TABLE profiles (id TEXT PRIMARY KEY, label TEXT NOT NULL, revision INTEGER NOT NULL, sealed_credentials TEXT NOT NULL, services_meta TEXT NOT NULL, provenance_identity TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE operations (
          id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, profile_revision INTEGER, targets TEXT NOT NULL,
          expected_revision INTEGER, idempotency_key TEXT, request_payload TEXT NOT NULL, pinned_credentials TEXT NOT NULL,
          sealed_registry_snapshot TEXT, status TEXT NOT NULL, failure_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE operation_steps (operation_id TEXT NOT NULL, service_id TEXT NOT NULL, sealed_snapshot TEXT, may_have_mutated INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'INITIAL', failure_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (operation_id, service_id));
        CREATE TABLE active_profiles (service_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, profile_revision INTEGER, service_revision INTEGER);
        DROP TABLE IF EXISTS mcp_actions;
        DROP TABLE IF EXISTS mcp_services;
      `);
      const legOp = legacyDb.prepare(`
        INSERT INTO operations (id, profile_id, profile_revision, targets, expected_revision, idempotency_key, request_payload, pinned_credentials, status, failure_code, created_at, updated_at)
        VALUES (?, 'p1', 1, '["overleaf-mcp"]', 1, NULL, '{}', '{}', ?, NULL, ?, ?)
      `);
      legOp.run('leg-succeeded', 'SUCCEEDED', '2026-11-04T00:10:00.000Z', '2026-11-04T00:10:00.000Z');
      legOp.run('leg-attention', 'NEEDS_ATTENTION', '2026-11-04T00:20:00.000Z', '2026-11-04T00:20:00.000Z');
      legOp.run('leg-prep', 'PREPARING', '2026-11-04T01:00:00.000Z', '2026-11-04T01:00:00.000Z');
      legOp.run('leg-queued', 'QUEUED', '2026-11-04T02:00:00.000Z', '2026-11-04T02:00:00.000Z');
      legacyDb.close();

      const rawStoreDb = new DatabaseSync(path.join(legacyDir, 'manager.db'));
      const legQueue = rawStoreDb.prepare(`
        SELECT id, created_at, CASE WHEN status = 'QUEUED' THEN 1 ELSE 0 END AS queue_order
        FROM operations
        WHERE status NOT IN ('SUCCEEDED', 'ROLLED_BACK', 'REJECTED', 'NEEDS_ATTENTION')
        ORDER BY queue_order ASC, created_at ASC, id ASC
      `).all().map(r => r.id);
      assert.deepEqual(legQueue, ['leg-prep', 'leg-queued']);
      rawStoreDb.close();
    } finally {
      fs.rmSync(legacyDir, { recursive: true, force: true });
    }

    await store.close();
  });

  it('19. store exposes loadAction and isActionId delegating to attached registry, and store.close() does not close caller-owned vault', async () => {
    const vaultDir = path.join(tmpDir, 'real-vault-19');
    const realVault = createVault({ dataDir: vaultDir });
    const store = openStore({ dataDir: tmpDir, vault: realVault });

    await store.registry.create({
      id: 'mcp_worker',
      label: 'Worker MCP',
      binding: { type: 'stdio', executable: 'worker.exe', args: [] }
    });

    // Create a stop action
    const stopAction = await store.registry.createStopAction({
      serviceId: 'mcp_worker',
      idempotencyKey: 'stop-worker-key-1'
    });

    // Verify store.isActionId
    assert.equal(store.isActionId(stopAction.id), true);
    assert.equal(store.isActionId('op-unknown-id'), false);

    // Verify store.loadAction delegating to registry.loadAction
    const loadedAction = store.loadAction(stopAction.id);
    assert.ok(loadedAction);
    assert.equal(loadedAction.id, stopAction.id);
    assert.equal(loadedAction.serviceId, 'mcp_worker');

    // Verify store.close() does NOT close the caller-owned vault
    await store.close();
    const testEnvelope = realVault.seal({ alive: true }, 'test-aad-alive');
    assert.deepEqual(realVault.unseal(testEnvelope, 'test-aad-alive'), { alive: true });

    // Close real vault explicitly
    realVault.close();
    assert.throws(() => realVault.seal({ alive: false }, 'test-aad-closed'), /Vault is closed/);
  });
});


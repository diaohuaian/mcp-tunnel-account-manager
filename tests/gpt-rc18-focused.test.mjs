import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createVault } from '../src/vault.mjs';
import { issueCarrierConfirmation, verifyCarrierConfirmation } from '../src/core/carrier-confirmation.mjs';
import { attachRegistry, formatTunnelClientDto } from '../src/mcp-registry-store.mjs';
import { runMcpLifecycleAction } from '../src/core/mcp-lifecycle.mjs';
import { classifyQueuedWork, missingReferenceDisposition } from '../src/core/work-item-routing.mjs';
import { isConventionalDocumentationFile } from '../src/config/mcp-discovery.mjs';
import { formatCredentialBadge } from '../public/app.js';

describe('RC18 Focused GPT Verification Scenario', () => {
  let tmpDir;
  let db;
  let vault;
  let registry;
  let nowMs;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc18-focused-'));
    vault = createVault({ dataDir: tmpDir });
    nowMs = Date.now();

    const dbPath = path.join(tmpDir, 'test.db');
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO metadata (key, value) VALUES ('revision', '1');
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        sealed_credentials TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS active_profiles (
        service_id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        profile_revision INTEGER NOT NULL DEFAULT 1,
        service_revision INTEGER NOT NULL DEFAULT 1
      );
    `);

    registry = attachRegistry({
      db,
      vault,
      getGlobalRevision: () => {
        const row = db.prepare("SELECT value FROM metadata WHERE key = 'revision'").get();
        return row ? Number(row.value) : 1;
      },
      bumpGlobalRevision: () => {
        const row = db.prepare("SELECT value FROM metadata WHERE key = 'revision'").get();
        const next = (row ? Number(row.value) : 1) + 1;
        db.prepare("UPDATE metadata SET value = ? WHERE key = 'revision'").run(String(next));
        return next;
      }
    });
  });

  afterEach(() => {
    if (db) {
      try { db.close(); } catch {}
    }
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Proof 1: Reorder identity properties and verify still valid
  it('1. Reordered identity properties remain valid under field-based equality', async () => {
    const origCtx = {
      action: 'restart',
      serviceId: 'antigravity-mcp',
      serviceRevision: 1,
      profileId: 'prof_test',
      sessionBinding: 'sess_valid_123',
      idempotencyKey: 'idemp_key_1',
      identity: {
        pid: 2480,
        startedAt: new Date(nowMs - 30000).toISOString(),
        executablePath: 'C:\\Program Files\\Node\\node.exe',
        verified: true
      },
      absenceVerified: false
    };

    const token = await issueCarrierConfirmation(vault, origCtx, nowMs);
    assert.ok(token);

    // Verify with completely reordered identity keys
    const reorderedCtx = {
      ...origCtx,
      identity: {
        executablePath: 'c:\\program files\\node\\node.exe',
        verified: true,
        startedAt: origCtx.identity.startedAt,
        pid: 2480
      }
    };

    const verified = await verifyCarrierConfirmation(vault, token, reorderedCtx, nowMs);
    assert.equal(verified, true, 'Reordered identity properties must verify successfully');
  });

  // Proof 2: Create action and unseal its ACTUAL persisted payload
  it('2. createLifecycleAction awaits seal and unseals ACTUAL durable payload (not {} or Promise)', async () => {
    const action = await registry.createLifecycleAction({
      action: 'stop',
      serviceId: 'antigravity-mcp',
      idempotencyKey: 'idemp_payload_check'
    });

    assert.ok(action);
    assert.equal(action.action, 'stop');
    assert.equal(action.serviceId, 'antigravity-mcp');

    // Inspect the durable SQLite row directly
    const row = db.prepare('SELECT * FROM mcp_actions WHERE id = ?').get(action.id);
    assert.ok(row, 'Row must exist in mcp_actions table');
    assert.notEqual(row.sealed_payload, '{}', 'Durable payload must not be empty {}');
    assert.notEqual(row.sealed_payload, '[object Promise]', 'Durable payload must not be [object Promise]');

    // Unseal raw sealed_payload directly via real vault
    const aad = JSON.stringify(['mcp-action', action.id, 'antigravity-mcp', 'action-v1']);
    const unsealed = await vault.unseal(row.sealed_payload, aad);
    assert.ok(unsealed, 'Unsealed payload must be a valid object');
    assert.equal(unsealed.action, 'stop');
    assert.equal(unsealed.serviceId, 'antigravity-mcp');
    assert.equal(unsealed.operationId, action.id);
    assert.ok(unsealed.registrySnapshot, 'Registry snapshot must be present in sealed payload');

    // Also verify loadAction unseals valid action object
    const loaded = await registry.loadAction(action.id);
    assert.equal(loaded.id, action.id);
    assert.equal(loaded.kind, 'stop');
    assert.equal(loaded.serviceId, 'antigravity-mcp');
  });

  // Proof 3: Two queued actions don't reject the first solely for future queue
  it('3. Two queued actions for same service do not reject first action solely for future queue', async () => {
    const act1 = await registry.createLifecycleAction({
      action: 'stop',
      serviceId: 'antigravity-mcp',
      idempotencyKey: 'queue_check_1'
    });
    const act2 = await registry.createLifecycleAction({
      action: 'stop',
      serviceId: 'antigravity-mcp',
      idempotencyKey: 'queue_check_2'
    });

    assert.equal(act1.state, 'QUEUED');
    assert.equal(act2.state, 'QUEUED');

    const repo = {
      registry,
      loadAction: (id) => registry.loadAction(id),
      transitionAction: (id, patch) => registry.transitionAction(id, patch),
      listProfiles: async () => []
    };

    // Synthetic adapter observing authoritative absence
    const adapter = {
      processController: {
        async inspect() {
          return { running: false, pid: 0 };
        }
      },
      async stopConnection() {
        return {
          status: 'stopped',
          serviceId: 'antigravity-mcp',
          operationId: act1.id,
          timestamp: new Date().toISOString()
        };
      }
    };

    // Run first action: it must NOT be rejected with OPERATION_IN_PROGRESS due to act2!
    const result = await runMcpLifecycleAction({
      repo,
      adapterProvider: () => adapter,
      actionId: act1.id,
      vault
    });

    assert.equal(result.state, 'SUCCEEDED', 'First queued action must succeed, not reject because second is queued');
  });

  // Proof 4: Failed inspector does not authorize absence
  it('4. Failed inspector does not authorize absence or stamp fresh absence', async () => {
    const act = await registry.createLifecycleAction({
      action: 'stop',
      serviceId: 'antigravity-mcp',
      idempotencyKey: 'failed_inspect_check'
    });

    const repo = {
      registry,
      loadAction: (id) => registry.loadAction(id),
      transitionAction: (id, patch) => registry.transitionAction(id, patch),
      listProfiles: async () => []
    };

    // Adapter where OS inspector fails with error
    const adapter = {
      processController: {
        async inspect() {
          throw new Error('OS inspect failed: RPC timeout');
        }
      },
      async stopConnection() {
        return { status: 'stopped', serviceId: 'antigravity-mcp', operationId: act.id };
      }
    };

    const result = await runMcpLifecycleAction({
      repo,
      adapterProvider: () => adapter,
      actionId: act.id,
      vault
    });

    // Failed inspection cannot authorize absence: action must be rejected!
    assert.equal(result.state, 'REJECTED', 'Action must be rejected when inspector fails');
    assert.ok(
      ['STATE_REFRESH_REQUIRED', 'EXTERNAL_CLIENT_NOT_MANAGED', 'STATE_UNVERIFIED'].includes(result.errorCode),
      `Error code should indicate unobserved/unmanaged/unverified state, got: ${result.errorCode}`
    );
  });

  // Proof 5: Work-item routing accurately routes lifecycle without wrong-table NOT_FOUND, and disposes pre-effect lookups
  it('5. Work-item routing correctly separates lifecycle vs switch and disposes harmless pre-effect errors', async () => {
    // 5a. classifyQueuedWork correctly classifies by raw durable row existence
    assert.equal(classifyQueuedWork({ queueKind: 'lifecycle', lifecycleExists: true, switchExists: false }), 'lifecycle');
    assert.equal(classifyQueuedWork({ queueKind: 'switch', lifecycleExists: false, switchExists: true }), 'switch');
    assert.equal(classifyQueuedWork({ queueKind: null, lifecycleExists: true, switchExists: false }), 'lifecycle');
    assert.equal(classifyQueuedWork({ queueKind: null, lifecycleExists: false, switchExists: true }), 'switch');

    assert.throws(
      () => classifyQueuedWork({ queueKind: null, lifecycleExists: false, switchExists: false }),
      /WORK_ITEM_NOT_FOUND/
    );
    assert.throws(
      () => classifyQueuedWork({ queueKind: null, lifecycleExists: true, switchExists: true }),
      /WORK_ITEM_KIND_CONFLICT/
    );

    // 5b. Pre-effect lookup error with zero side effects is marked REJECTED, never NEEDS_ATTENTION
    const safeEvidence = {
      phase: 'PRE_EFFECT_DISPATCH',
      mayMutate: false,
      intentWritten: false,
      processEffectObserved: false,
      configChanged: false,
      rollbackUncertain: false
    };
    assert.equal(missingReferenceDisposition(safeEvidence), 'REJECTED');

    // Any uncertain effect or post-effect failure escalates to NEEDS_ATTENTION
    const unsafeEvidence = {
      ...safeEvidence,
      mayMutate: true
    };
    assert.equal(missingReferenceDisposition(unsafeEvidence), 'NEEDS_ATTENTION');
  });

  // Proof 6: Tunnel-client DTO formatting: missing record is unobserved, external process is unmanaged
  it('6. formatTunnelClientDto maps missing records to unobserved (not stopped) and external PID to unmanaged', async () => {
    // Missing manager record => unobserved, NOT process_stopped
    const missingDto = formatTunnelClientDto(null);
    assert.equal(missingDto.state, 'unobserved');
    assert.equal(missingDto.managed, false);
    assert.equal(missingDto.reasonCode, 'external_process_unobserved');

    // External process with safe PID => unmanaged with PID preserved
    const externalDto = formatTunnelClientDto({
      state: 'unmanaged',
      pid: 35812,
      startedAt: '2026-11-05T14:23:24.5313905Z'
    });
    assert.equal(externalDto.state, 'unmanaged');
    assert.equal(externalDto.managed, false);
    assert.equal(externalDto.pid, 35812);
    assert.equal(externalDto.startedAt, '2026-11-05T14:23:24.5313905Z');
  });

  // Proof 7: License documents filtered from discovery and ignored on scan
  it('7. Conventional documentation and -licenses.txt are excluded from default config discovery', async () => {
    assert.equal(isConventionalDocumentationFile('tunnel-client-v0.0.19-windows-amd64-licenses.txt'), true);
    assert.equal(isConventionalDocumentationFile('LICENSE.txt'), true);
    assert.equal(isConventionalDocumentationFile('README.md'), true);
    assert.equal(isConventionalDocumentationFile('notice.txt'), true);

    // Does not globally filter filenames merely containing the substring "license"
    assert.equal(isConventionalDocumentationFile('license-custom-account.yaml'), false);
    assert.equal(isConventionalDocumentationFile('overleaf-service.txt'), false);
  });

  // Proof 8: Shared formatCredentialBadge maintains parity between candidate and inventory cards
  it('8. Shared formatCredentialBadge maintains consistency across inventory and candidate views', async () => {
    // BAT files that load env show external reference badge consistently
    const candBatBadge = formatCredentialBadge({ configured: false, hasApiKey: false }, { sourceKind: 'bat' });
    const invBatBadge = formatCredentialBadge({ configured: false, hasApiKey: false }, { type: 'bat' });
    assert.equal(candBatBadge, '<span class="badge badge-info">凭据: 外部引用</span>');
    assert.equal(invBatBadge, '<span class="badge badge-info">凭据: 外部引用</span>');

    // Service definition shows not-applicable badge consistently
    const candDefBadge = formatCredentialBadge({ notApplicable: true }, { isServiceDefinition: true });
    const invDefBadge = formatCredentialBadge({ notApplicable: true }, { kind: 'service_definition' });
    assert.equal(candDefBadge, '<span class="badge badge-subtle">凭据: 不适用</span>');
    assert.equal(invDefBadge, '<span class="badge badge-subtle">凭据: 不适用</span>');

    // Configured accounts show success badge
    const configuredBadge = formatCredentialBadge({ configured: true }, { sourceKind: 'yaml' });
    assert.equal(configuredBadge, '<span class="badge badge-success">凭据: 已配置</span>');
  });
});

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createVault } from '../src/vault.mjs';
import { attachRegistry, RegistryStoreError } from '../src/mcp-registry-store.mjs';
import { LEGACY_SERVICES, discoveryIdentity } from '../src/core/mcp-registry-policy.mjs';

describe('mcp-registry-store unit tests', () => {
  let tmpDir;
  let vault;
  let db;
  let storeEvents;

  function setupHarness({ runtimeState = 'stopped', busy = false } = {}) {
    storeEvents = {
      globalRevision: 10,
      clearedServices: [],
      assertIdleCalled: 0
    };

    const getGlobalRevision = () => storeEvents.globalRevision;
    const bumpGlobalRevision = () => {
      storeEvents.globalRevision += 1;
      return storeEvents.globalRevision;
    };
    const assertIdle = () => {
      storeEvents.assertIdleCalled += 1;
      if (busy) {
        throw new Error('SYSTEM_BUSY');
      }
    };
    const getServiceRuntime = (id) => {
      return {
        state: typeof runtimeState === 'function' ? runtimeState(id) : runtimeState,
        activeProfileRevision: 1,
        activeServiceRevision: 1,
        pendingApply: false
      };
    };
    const clearActiveService = (id) => {
      storeEvents.clearedServices.push(id);
    };

    const withWriteTransaction = async (fn) => {
      db.exec('BEGIN IMMEDIATE;');
      try {
        const res = fn();
        db.exec('COMMIT;');
        return res;
      } catch (err) {
        try { db.exec('ROLLBACK;'); } catch {}
        throw err;
      }
    };

    const registry = attachRegistry({
      db,
      vault,
      withWriteTransaction,
      getGlobalRevision,
      bumpGlobalRevision,
      assertIdle,
      getServiceRuntime,
      clearActiveService
    });

    return { registry, storeEvents };
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-test-'));
    vault = createVault({ dataDir: tmpDir });
    db = new DatabaseSync(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    try {
      if (db) db.close();
      if (vault) vault.close();
      if (tmpDir && fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch (_) {}
  });

  describe('1. Schema Creation and Initial Seeding', () => {
    it('seeds legacy services overleaf-mcp and antigravity-mcp with correct metadata', () => {
      const { registry } = setupHarness();
      const services = registry.listServices();
      assert.equal(services.length, 2);

      const overleaf = services.find(s => s.id === 'overleaf-mcp');
      assert.ok(overleaf);
      assert.equal(overleaf.label, 'Overleaf MCP');
      assert.equal(overleaf.sortOrder, 100);
      assert.equal(overleaf.controlCarrier, false);
      assert.equal(overleaf.enabled, true);
      assert.equal(overleaf.revision, 1);

      const antigravity = services.find(s => s.id === 'antigravity-mcp');
      assert.ok(antigravity);
      assert.equal(antigravity.label, 'Antigravity MCP');
      assert.equal(antigravity.sortOrder, 1000);
      assert.equal(antigravity.controlCarrier, true);
      assert.equal(antigravity.enabled, true);
      assert.equal(antigravity.revision, 1);
    });

    it('attaching registry multiple times is idempotent and does not duplicate seeds', () => {
      const { registry: reg1 } = setupHarness();
      assert.equal(reg1.listServices().length, 2);

      // Attach again to same db
      const { registry: reg2 } = setupHarness();
      assert.equal(reg2.listServices().length, 2);
    });

    it('never resurrects tombstoned legacy services on re-attach', async () => {
      const { registry } = setupHarness();
      await registry.remove('overleaf-mcp');

      // Verify it is tombstoned
      assert.equal(registry.listServices({ includeDeleted: false }).length, 1);
      assert.equal(registry.listServices({ includeDeleted: true }).length, 2);

      // Re-attach registry on the same database
      const { registry: reg2 } = setupHarness();
      assert.equal(reg2.listServices({ includeDeleted: false }).length, 1);
      const tombstoned = reg2.getDefinition('overleaf-mcp', { includeDeleted: true });
      assert.ok(tombstoned.deletedAt);
    });
  });

  describe('2. Definitions and Service Queries', () => {
    it('listDefinitions returns full unmasked internal definitions', () => {
      const { registry } = setupHarness();
      const defs = registry.listDefinitions();
      assert.equal(defs.length, 2);
      assert.ok(defs.every(d => d.id && d.binding && d.environment));
    });

    it('getDefinition returns null for unknown ID or tombstoned unless includeDeleted=true', async () => {
      const { registry } = setupHarness();
      assert.equal(registry.getDefinition('mcp_nonexistent'), null);

      await registry.remove('overleaf-mcp');
      assert.equal(registry.getDefinition('overleaf-mcp'), null);
      assert.ok(registry.getDefinition('overleaf-mcp', { includeDeleted: true }));
    });
  });

  describe('3. Service Creation and Masking', () => {
    it('creates stdio MCP service with secret and public arguments', async () => {
      const { registry, storeEvents } = setupHarness();
      const created = await registry.create({
        id: 'mcp_custom_stdio',
        label: 'Custom Stdio Service',
        enabled: true,
        binding: {
          type: 'stdio',
          executable: 'node',
          args: [
            { id: '--port', value: '8080', secret: false },
            { id: '--api-key', value: 'secret-key-123', secret: true },
            { id: '--sensitive_token', value: 'token-456', secret: false } // sensitive name forced secret
          ],
          cwd: 'C:/tools'
        },
        environmentPatch: [
          { name: 'LOG_LEVEL', op: 'set', value: 'info', secret: false },
          { name: 'API_SECRET', op: 'set', value: 'super-secret', secret: false } // forced secret
        ]
      }, { expectedRevision: 10 });

      assert.equal(created.id, 'mcp_custom_stdio');
      assert.equal(created.label, 'Custom Stdio Service');
      assert.equal(storeEvents.globalRevision, 11);

      // Check public DTO masking
      const publicArgs = created.binding.args;
      assert.equal(publicArgs.length, 3);
      assert.deepEqual(publicArgs[0], { id: '--port', secret: false, configured: true, value: '8080' });
      assert.deepEqual(publicArgs[1], { id: '--api-key', secret: true, configured: true });
      assert.deepEqual(publicArgs[2], { id: '--sensitive_token', secret: true, configured: true }); // forced

      // Check environment masking
      const env = created.environment;
      const logEnv = env.find(e => e.name === 'LOG_LEVEL');
      assert.deepEqual(logEnv, { name: 'LOG_LEVEL', secret: false, configured: true, value: 'info' });
      const secEnv = env.find(e => e.name === 'API_SECRET');
      assert.deepEqual(secEnv, { name: 'API_SECRET', secret: true, configured: true });

      // Check internal definition has plaintext
      const def = registry.getDefinition('mcp_custom_stdio');
      assert.equal(def.binding.args[1].value, 'secret-key-123');
      assert.equal(def.environment.API_SECRET.value, 'super-secret');
    });

    it('creates http MCP service with encrypted headers and masks sensitive URL query', async () => {
      const { registry } = setupHarness();
      const created = await registry.create({
        id: 'mcp_custom_http',
        label: 'HTTP Service',
        binding: {
          type: 'http',
          url: 'https://example.com/api?token=secret123&publicParam=hello',
          headers: {
            'X-Public': { value: 'public-data', secret: false },
            'Authorization': { value: 'Bearer token', secret: false } // sensitive name forced secret
          }
        }
      });

      assert.equal(created.id, 'mcp_custom_http');
      // Public DTO omits raw url when query contains secrets, providing urlDisplay and flags
      assert.equal(created.binding.urlConfigured, true);
      assert.equal(created.binding.hasPrivateQuery, true);
      assert.equal(created.binding.urlDisplay, 'https://example.com/api');
      assert.equal(created.binding.url, undefined);

      // Public headers masked
      assert.deepEqual(created.binding.headers['X-Public'], { secret: false, configured: true, value: 'public-data' });
      assert.deepEqual(created.binding.headers['Authorization'], { secret: true, configured: true });

      // listServices returns matching public DTO
      const services = await registry.listServices();
      const fetched = services.find(s => s.id === 'mcp_custom_http');
      assert.ok(fetched);
      assert.equal(fetched.binding.url, undefined);
      assert.equal(fetched.binding.urlDisplay, 'https://example.com/api');
      assert.equal(fetched.binding.urlConfigured, true);
      assert.equal(fetched.binding.hasPrivateQuery, true);

      // Updating service without url retains existing URL with private query (no-placeholder writeback)
      const updated = await registry.update('mcp_custom_http', {
        label: 'HTTP Service Updated',
        expectedServiceRevision: 1
      });
      assert.equal(updated.label, 'HTTP Service Updated');
      assert.equal(updated.binding.url, undefined);
      assert.equal(updated.binding.urlDisplay, 'https://example.com/api');
      assert.equal(updated.binding.urlConfigured, true);
      assert.equal(updated.binding.hasPrivateQuery, true);

      // Unmasked definition still retains raw URL in store
      const def = await registry.getDefinition('mcp_custom_http');
      assert.equal(def.binding.url, 'https://example.com/api?token=secret123&publicParam=hello');
    });

    it('rejects HTTP URL with userinfo', async () => {
      const { registry } = setupHarness();
      await assert.rejects(
        () => registry.create({
          id: 'mcp_bad_url',
          binding: {
            type: 'http',
            url: 'https://user:password@example.com/api'
          }
        }),
        (err) => err.code === 'USERINFO_NOT_ALLOWED' && err.status === 400
      );
    });

    it('rejects invalid service ID', async () => {
      const { registry } = setupHarness();
      for (const badId of ['../invalid', 'constructor', 'mcp_', 'invalid/path']) {
        await assert.rejects(
          () => registry.create({ id: badId, binding: { type: 'stdio', executable: 'node' } }),
          (err) => err.code === 'INVALID_MCP_ID'
        );
      }
    });

    it('rejects duplicate service ID', async () => {
      const { registry } = setupHarness();
      await assert.rejects(
        () => registry.create({ id: 'overleaf-mcp', binding: { type: 'stdio', executable: 'node' } }),
        (err) => err.code === 'MCP_ALREADY_EXISTS' && err.status === 409
      );
    });

    it('rejects creation on global revision conflict', async () => {
      const { registry } = setupHarness();
      await assert.rejects(
        () => registry.create(
          { id: 'mcp_rev_test', binding: { type: 'stdio', executable: 'node' } },
          { expectedRevision: 999 }
        ),
        (err) => err.code === 'REVISION_CONFLICT' && err.status === 409
      );
    });

    it('generates random mcp_<uuid> when ID is omitted', async () => {
      const { registry } = setupHarness();
      const created = await registry.create({
        label: 'Auto Generated ID',
        binding: { type: 'stdio', executable: 'node' }
      });
      assert.ok(/^mcp_[a-z0-9]{32}$/.test(created.id));
    });
  });

  describe('4. Service Update and Patches', () => {
    it('updates label and toggles enabled state', async () => {
      const { registry, storeEvents } = setupHarness();
      const updated = await registry.update('overleaf-mcp', {
        label: 'Overleaf Updated',
        enabled: false
      }, { expectedRevision: 10 });

      assert.equal(updated.label, 'Overleaf Updated');
      assert.equal(updated.enabled, false);
      assert.equal(updated.revision, 2);
      assert.equal(storeEvents.globalRevision, 11);
    });

    it('rejects update with empty label', async () => {
      const { registry } = setupHarness();
      await assert.rejects(
        () => registry.update('overleaf-mcp', { label: '   ' }),
        (err) => err.code === 'INVALID_LABEL' && err.status === 400
      );
    });

    it('updates binding args: matches by id, retains omitted value, removes unlisted, requires value for new', async () => {
      const { registry } = setupHarness();
      await registry.create({
        id: 'mcp_arg_test',
        binding: {
          type: 'stdio',
          executable: 'node',
          args: [
            { id: '--p1', value: 'v1', secret: false },
            { id: '--p2', value: 'secret-val-2', secret: true },
            { id: '--p3', value: 'v3', secret: false }
          ]
        }
      });

      // Update args:
      // --p1 value changed
      // --p2 value omitted (must retain 'secret-val-2')
      // --p3 omitted entirely (must be removed)
      // --p4 added with value
      const updated = await registry.update('mcp_arg_test', {
        binding: {
          args: [
            { id: '--p1', value: 'v1-updated', secret: false },
            { id: '--p2' }, // retain value & secret
            { id: '--p4', value: 'v4-new', secret: false }
          ]
        }
      });

      const publicArgs = updated.binding.args;
      assert.equal(publicArgs.length, 3);
      assert.deepEqual(publicArgs[0], { id: '--p1', secret: false, configured: true, value: 'v1-updated' });
      assert.deepEqual(publicArgs[1], { id: '--p2', secret: true, configured: true });
      assert.deepEqual(publicArgs[2], { id: '--p4', secret: false, configured: true, value: 'v4-new' });

      // Verify internal definition retained secret-val-2
      const internalDef = registry.getDefinition('mcp_arg_test');
      assert.equal(internalDef.binding.args[1].value, 'secret-val-2');
    });

    it('rejects adding new arg without value', async () => {
      const { registry } = setupHarness();
      await registry.create({
        id: 'mcp_new_arg_test',
        binding: { type: 'stdio', executable: 'node', args: [] }
      });

      await assert.rejects(
        () => registry.update('mcp_new_arg_test', {
          binding: { args: [{ id: '--new-arg' }] }
        }),
        (err) => err.code === 'ARG_VALUE_REQUIRED' && err.status === 400
      );
    });

    it('updates environment with patch: set, remove, and reserved name checks', async () => {
      const { registry } = setupHarness();
      await registry.create({
        id: 'mcp_env_test',
        binding: { type: 'stdio', executable: 'node' },
        environmentPatch: [
          { name: 'VAR_A', op: 'set', value: 'alpha', secret: false },
          { name: 'VAR_B', op: 'set', value: 'beta', secret: false }
        ]
      });

      // Set VAR_A to empty string, remove VAR_B, set VAR_C
      const updated = await registry.update('mcp_env_test', {
        environmentPatch: [
          { name: 'VAR_A', op: 'set', value: '', secret: false },
          { name: 'VAR_B', op: 'remove' },
          { name: 'VAR_C', op: 'set', value: 'gamma', secret: false }
        ]
      });

      const envMap = Object.fromEntries(updated.environment.map(e => [e.name, e]));
      assert.deepEqual(envMap['VAR_A'], { name: 'VAR_A', secret: false, configured: true, value: '' });
      assert.equal(envMap['VAR_B'], undefined);
      assert.deepEqual(envMap['VAR_C'], { name: 'VAR_C', secret: false, configured: true, value: 'gamma' });

      // Reserved env names rejected
      await assert.rejects(
        () => registry.update('mcp_env_test', {
          environmentPatch: [{ name: 'TUNNEL_ID', op: 'set', value: 'evil' }]
        }),
        (err) => err.code === 'RESERVED_ENV_NAME'
      );
    });

    it('rejects update with conflicting expectedServiceRevision', async () => {
      const { registry } = setupHarness();
      await assert.rejects(
        () => registry.update('overleaf-mcp', { label: 'New' }, { expectedServiceRevision: 99 }),
        (err) => err.code === 'REVISION_CONFLICT' && err.status === 409
      );
    });

    it('rejects updating non-existent or tombstoned service', async () => {
      const { registry } = setupHarness();
      await assert.rejects(
        () => registry.update('mcp_unknown', { label: 'New' }),
        (err) => err.code === 'MCP_NOT_FOUND' && err.status === 404
      );

      await registry.remove('overleaf-mcp');
      await assert.rejects(
        () => registry.update('overleaf-mcp', { label: 'New' }),
        (err) => err.code === 'MCP_NOT_FOUND' && err.status === 404
      );
    });
  });

  describe('5. Removal and Removal Decisions', () => {
    it('blocks removal if service runtime is running (409 MCP_RUNNING)', async () => {
      const { registry } = setupHarness({ runtimeState: 'running' });
      await assert.rejects(
        () => registry.remove('overleaf-mcp'),
        (err) => err.code === 'MCP_RUNNING' && err.status === 409
      );
    });

    it('blocks removal if service runtime is unknown (409 RUNTIME_STATE_UNKNOWN)', async () => {
      const { registry } = setupHarness({ runtimeState: 'unknown' });
      await assert.rejects(
        () => registry.remove('overleaf-mcp'),
        (err) => err.code === 'RUNTIME_STATE_UNKNOWN' && err.status === 409
      );
    });

    it('blocks removal if store is busy (409 MCP_BUSY)', async () => {
      const { registry } = setupHarness({ runtimeState: 'stopped', busy: true });
      await assert.rejects(
        () => registry.remove('overleaf-mcp'),
        (err) => err.code === 'MCP_BUSY' && err.status === 409
      );
    });

    it('allows removal when stopped: sets tombstone deleted_at, bumps revisions, clears active mapping', async () => {
      const { registry, storeEvents } = setupHarness({ runtimeState: 'stopped' });
      const res = await registry.remove('overleaf-mcp', { expectedRevision: 10 });
      assert.deepEqual(res, { success: true, id: 'overleaf-mcp' });
      assert.equal(storeEvents.globalRevision, 11);
      assert.ok(storeEvents.clearedServices.includes('overleaf-mcp'));

      // Check database row
      const def = registry.getDefinition('overleaf-mcp', { includeDeleted: true });
      assert.ok(def.deletedAt);
      assert.equal(def.revision, 2);

      // Excluded from standard list
      assert.equal(registry.listServices().length, 1);
      assert.equal(registry.listServices({ includeDeleted: true }).length, 2);
    });

    it('rejects removing already tombstoned service with 404 MCP_NOT_FOUND', async () => {
      const { registry } = setupHarness({ runtimeState: 'stopped' });
      await registry.remove('overleaf-mcp');

      await assert.rejects(
        () => registry.remove('overleaf-mcp'),
        (err) => err.code === 'MCP_NOT_FOUND' && err.status === 404
      );
    });
  });

  describe('6. Registry Snapshots', () => {
    it('creates pinned snapshot ordered by controlCarrier last, sortOrder, and id', async () => {
      const { registry } = setupHarness();
      await registry.create({
        id: 'mcp_alpha',
        sortOrder: 50,
        binding: { type: 'stdio', executable: 'node' }
      });

      // Target order: mcp_alpha (sortOrder 50), overleaf-mcp (sortOrder 100), antigravity-mcp (carrier last)
      const snap = registry.snapshot(['antigravity-mcp', 'mcp_alpha', 'overleaf-mcp'], 11);
      assert.equal(snap.revision, 11);
      assert.deepEqual(snap.services.map(s => s.id), ['mcp_alpha', 'overleaf-mcp', 'antigravity-mcp']);
    });

    it('rejects snapshot on revision conflict', () => {
      const { registry } = setupHarness();
      assert.throws(
        () => registry.snapshot(['overleaf-mcp'], 999),
        { code: 'REVISION_CONFLICT' }
      );
    });

    it('snapshot clone is independent of subsequent store updates', async () => {
      const { registry } = setupHarness();
      const snap = registry.snapshot(['overleaf-mcp'], 10);
      assert.equal(snap.services[0].label, 'Overleaf MCP');

      await registry.update('overleaf-mcp', { label: 'Mutated Label' });
      assert.equal(snap.services[0].label, 'Overleaf MCP');
    });
  });

  describe('7. Provenance Identity and Definition Import', () => {
    it('imports new definition with provenance identity', async () => {
      const { registry, storeEvents } = setupHarness();
      const provIdentity = discoveryIdentity({
        serviceId: 'overleaf-mcp',
        canonicalPath: 'C:\\configs\\mcp.yaml',
        selector: 'main'
      });

      const res = await registry.importDefinition({
        id: 'mcp_imported_1',
        label: 'Imported MCP',
        binding: { type: 'stdio', executable: 'node' }
      }, {
        expectedRevision: 10,
        provenance: { identity: provIdentity, sourcePath: 'C:/configs/mcp.yaml' }
      });

      assert.equal(res.created, true);
      assert.equal(res.service.id, 'mcp_imported_1');
      assert.equal(storeEvents.globalRevision, 11);
    });

    it('repeated import with same provenance identity is idempotent and does not overwrite', async () => {
      const { registry, storeEvents } = setupHarness();
      const provIdentity = 'source_test_identity_unique';

      const first = await registry.importDefinition({
        id: 'mcp_imported_first',
        label: 'Original Label',
        binding: { type: 'stdio', executable: 'node' }
      }, {
        provenance: { identity: provIdentity }
      });
      assert.equal(first.created, true);

      // Now update the service label manually
      await registry.update('mcp_imported_first', { label: 'User Edited Label' });

      // Repeat import with different label input
      const second = await registry.importDefinition({
        id: 'mcp_imported_first',
        label: 'Attempted Overwrite Label',
        binding: { type: 'stdio', executable: 'node' }
      }, {
        provenance: { identity: provIdentity }
      });

      assert.equal(second.created, false);
      assert.equal(second.service.label, 'User Edited Label'); // NOT overwritten!
    });

    it('rejects import if service ID conflicts with an existing managed definition', async () => {
      const { registry } = setupHarness();
      await assert.rejects(
        () => registry.importDefinition({
          id: 'overleaf-mcp',
          label: 'Attempt Overwrite Overleaf',
          binding: { type: 'stdio', executable: 'node' }
        }, {
          provenance: { identity: 'source_new_distinct_id' }
        }),
        (err) => err.code === 'CONFLICT' && err.status === 409
      );
    });
  });

  describe('8. Stop Action Lifecycle and Verification', () => {
    it('creates stop action with idempotencyKey, pins snapshot, and seals originalRuntime', async () => {
      const { registry, storeEvents } = setupHarness({ runtimeState: 'running' });
      const action = await registry.createStopAction({
        serviceId: 'overleaf-mcp',
        expectedRevision: 10,
        idempotencyKey: 'stop-key-1'
      });

      assert.ok(action.id.startsWith('act_'));
      assert.equal(action.kind, 'stop');
      assert.equal(action.serviceId, 'overleaf-mcp');
      assert.equal(action.state, 'QUEUED');
      assert.equal(action.errorCode, null);
      assert.equal(storeEvents.assertIdleCalled, 1);

      // Verify pending action list
      assert.deepEqual(registry.listPendingActionIds(), [action.id]);
      assert.equal(registry.isActionId(action.id), true);

      // Verify internal loadAction unseals registry snapshot and runtime
      const loaded = registry.loadAction(action.id);
      assert.equal(loaded.operationId, action.id);
      assert.equal(loaded.registrySnapshot.revision, 10);
      assert.equal(loaded.registrySnapshot.services[0].id, 'overleaf-mcp');
      assert.equal(loaded.originalRuntime.state, 'running');

      // Verify publicAction does not leak snapshot or secrets
      const pub = registry.publicAction(action.id);
      assert.equal(pub.registrySnapshot, undefined);
      assert.equal(pub.originalRuntime, undefined);
    });

    it('idempotencyKey replay returns identical cached stop action', async () => {
      const { registry } = setupHarness();
      const first = await registry.createStopAction({
        serviceId: 'overleaf-mcp',
        expectedRevision: 10,
        idempotencyKey: 'idemp-key-repeat'
      });

      const second = await registry.createStopAction({
        serviceId: 'overleaf-mcp',
        expectedRevision: 10,
        idempotencyKey: 'idemp-key-repeat'
      });

      assert.equal(first.id, second.id);
      assert.equal(second.state, 'QUEUED');
    });

    it('rejects same idempotencyKey with different payload (409 IDEMPOTENCY_CONFLICT)', async () => {
      const { registry } = setupHarness();
      await registry.createStopAction({
        serviceId: 'overleaf-mcp',
        expectedRevision: 10,
        idempotencyKey: 'collision-key'
      });

      await assert.rejects(
        () => registry.createStopAction({
          serviceId: 'antigravity-mcp', // different service!
          expectedRevision: 10,
          idempotencyKey: 'collision-key'
        }),
        (err) => err.code === 'IDEMPOTENCY_CONFLICT' && err.status === 409
      );
    });

    it('transitions action state to APPLYING and validates allowed states', async () => {
      const { registry } = setupHarness();
      const action = await registry.createStopAction({ serviceId: 'overleaf-mcp' });

      const transitioned = await registry.transitionAction(action.id, { state: 'APPLYING' });
      assert.equal(transitioned.state, 'APPLYING');

      await assert.rejects(
        () => registry.transitionAction(action.id, { state: 'INVALID_STATE' }),
        (err) => err.code === 'INVALID_ACTION_STATE' && err.status === 400
      );
    });

    it('finishing stop action verifies proof receipt; rejects unconfirmed receipt', async () => {
      const { registry } = setupHarness();
      const action = await registry.createStopAction({ serviceId: 'overleaf-mcp' });

      // Unconfirmed receipt rejected
      await assert.rejects(
        () => registry.finishStoppedAction(action.id, { stopped: false }),
        (err) => err.code === 'STOP_UNCONFIRMED' && err.status === 409
      );

      // Wrong operationId rejected
      await assert.rejects(
        () => registry.finishStoppedAction(action.id, {
          stopped: true,
          operationId: 'other-op',
          service: 'overleaf-mcp',
          proof: { kind: 'verified-already-stopped' }
        }),
        (err) => err.code === 'STOP_UNCONFIRMED' && err.status === 409
      );
    });

    it('finishing stop action with verified receipt sets SUCCEEDED, bumps revision, and clears active service', async () => {
      const { registry, storeEvents } = setupHarness();
      const action = await registry.createStopAction({ serviceId: 'overleaf-mcp' });

      const receipt = {
        stopped: true,
        operationId: action.id,
        service: 'overleaf-mcp',
        proof: { kind: 'verified-owned-process-exit' },
        identity: {
          pid: 1234,
          startedAt: '2026-11-04T00:00:00Z',
          executable: 'node.exe'
        }
      };

      const finished = await registry.finishStoppedAction(action.id, receipt);
      assert.equal(finished.state, 'SUCCEEDED');
      assert.equal(storeEvents.globalRevision, 11);
      assert.ok(storeEvents.clearedServices.includes('overleaf-mcp'));

      // Pending action list is now empty
      assert.deepEqual(registry.listPendingActionIds(), []);
    });

    it('markActionAttention sets NEEDS_ATTENTION and sets recovery gate in metadata', async () => {
      const { registry } = setupHarness();
      const action = await registry.createStopAction({ serviceId: 'overleaf-mcp' });

      const attended = await registry.markActionAttention(action.id, 'PROCESS_KILL_FAILED');
      assert.equal(attended.state, 'NEEDS_ATTENTION');
      assert.equal(attended.errorCode, 'PROCESS_KILL_FAILED');

      // Verify metadata table was updated with recovery gate
      const row = db.prepare("SELECT value FROM metadata WHERE key = 'recovery_gated'").get();
      assert.equal(row.value, '1');
      const reasonRow = db.prepare("SELECT value FROM metadata WHERE key = 'recovery_reason'").get();
      assert.ok(reasonRow.value.includes('PROCESS_KILL_FAILED'));
    });
  });
});

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createVault } from '../src/vault.mjs';
import { attachRegistry } from '../src/mcp-registry-store.mjs';
import { sanitizeMcpDto } from '../src/http/mcp-routes.mjs';
import { normalizeObservation } from '../src/adapters/runtime-observer.mjs';

describe('GPT Runtime State Contract & Regression Suite', () => {
  let tmpDir;
  let vault;
  let db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-runtime-state-test-'));
    vault = createVault({ dataDir: tmpDir });
    db = new DatabaseSync(':memory:');
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

  function createHarness({ getServiceRuntime, runtimeState, busy = false } = {}) {
    let globalRev = 10;
    const storeEvents = {
      clearedServices: [],
      assertIdleCalled: 0
    };

    const getGlobalRevision = () => globalRev;
    const bumpGlobalRevision = () => {
      globalRev += 1;
      return globalRev;
    };
    const assertIdle = () => {
      storeEvents.assertIdleCalled += 1;
      if (busy) {
        throw new Error('SYSTEM_BUSY');
      }
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

    const runtimeFn = typeof getServiceRuntime === 'function'
      ? getServiceRuntime
      : (getServiceRuntime !== undefined
        ? () => getServiceRuntime
        : (runtimeState !== undefined
          ? (typeof runtimeState === 'function' ? runtimeState : () => runtimeState)
          : undefined));

    const registryOptions = {
      db,
      vault,
      withWriteTransaction,
      getGlobalRevision,
      bumpGlobalRevision,
      assertIdle,
      clearActiveService
    };

    if (runtimeFn !== undefined) {
      registryOptions.getServiceRuntime = runtimeFn;
    }

    const registry = attachRegistry(registryOptions);

    return { registry, storeEvents, getGlobalRevision: () => globalRev };
  }

  // ==========================================================================
  // 1. runtimeState running / stopped fallback (when runtime.state is not set)
  // ==========================================================================
  describe('1. runtimeState fallback when runtime.state is omitted', () => {
    it('maps runtimeState: "running" to state: "running" when state is undefined', () => {
      const { registry } = createHarness({
        getServiceRuntime: (id) => ({
          runtimeState: 'running',
          activeProfileRevision: 1,
          activeServiceRevision: 1,
          pendingApply: false
        })
      });

      const services = registry.listServices();
      assert.ok(services.length >= 2, 'Expected seeded services');

      for (const service of services) {
        assert.equal(service.runtime.state, 'running');
      }
    });

    it('maps runtimeState: "stopped" to state: "stopped" when state is undefined', () => {
      const { registry } = createHarness({
        getServiceRuntime: (id) => ({
          runtimeState: 'stopped',
          activeProfileRevision: 1,
          activeServiceRevision: 1,
          pendingApply: false
        })
      });

      const services = registry.listServices();
      for (const service of services) {
        assert.equal(service.runtime.state, 'stopped');
      }
    });

    it('applies runtimeState fallback when creating and returning a new service DTO', async () => {
      const { registry } = createHarness({
        getServiceRuntime: (id) => {
          if (id === 'mcp_custom_service') {
            return {
              runtimeState: 'running',
              activeProfileRevision: 2,
              activeServiceRevision: 1,
              pendingApply: false
            };
          }
          return { runtimeState: 'stopped' };
        }
      });

      const created = await registry.create({
        id: 'mcp_custom_service',
        label: 'Custom Service',
        binding: {
          type: 'stdio',
          executable: 'node',
          args: [{ id: 'server.js', value: 'server.js' }]
        }
      });

      assert.equal(created.id, 'mcp_custom_service');
      assert.equal(created.runtime.state, 'running');
      assert.equal(created.runtime.activeProfileRevision, 2);
      assert.equal(created.runtime.activeServiceRevision, 1);
    });

    it('applies runtimeState fallback when updating a service DTO', async () => {
      let isRunning = false;
      const { registry } = createHarness({
        getServiceRuntime: (id) => ({
          runtimeState: isRunning ? 'running' : 'stopped'
        })
      });

      const initial = registry.listServices().find(s => s.id === 'overleaf-mcp');
      assert.equal(initial.runtime.state, 'stopped');

      isRunning = true;
      const updated = await registry.update('overleaf-mcp', {
        label: 'Overleaf MCP Updated',
        expectedServiceRevision: initial.revision
      });

      assert.equal(updated.runtime.state, 'running');
    });
  });

  // ==========================================================================
  // 2. Canonical state including conflict precedence (state wins over runtimeState)
  // ==========================================================================
  describe('2. Canonical state and conflict precedence (runtime.state wins)', () => {
    it('prefers runtime.state: "running" over runtime.runtimeState: "stopped"', () => {
      const { registry } = createHarness({
        getServiceRuntime: () => ({
          state: 'running',
          runtimeState: 'stopped',
          activeProfileRevision: 1,
          activeServiceRevision: 1
        })
      });

      const services = registry.listServices();
      for (const service of services) {
        assert.equal(service.runtime.state, 'running', 'Canonical state "running" must take precedence');
      }
    });

    it('prefers runtime.state: "stopped" over runtime.runtimeState: "running"', () => {
      const { registry } = createHarness({
        getServiceRuntime: () => ({
          state: 'stopped',
          runtimeState: 'running',
          activeProfileRevision: 1,
          activeServiceRevision: 1
        })
      });

      const services = registry.listServices();
      for (const service of services) {
        assert.equal(service.runtime.state, 'stopped', 'Canonical state "stopped" must take precedence');
      }
    });

    it('resolves consistent values when both state and runtimeState match', () => {
      const { registry: runningRegistry } = createHarness({
        getServiceRuntime: () => ({ state: 'running', runtimeState: 'running' })
      });
      assert.equal(runningRegistry.listServices()[0].runtime.state, 'running');

      const { registry: stoppedRegistry } = createHarness({
        getServiceRuntime: () => ({ state: 'stopped', runtimeState: 'stopped' })
      });
      assert.equal(stoppedRegistry.listServices()[0].runtime.state, 'stopped');
    });

    it('prefers canonical state even when runtimeState provides legacy values', () => {
      const { registry: stoppedWins } = createHarness({
        getServiceRuntime: () => ({
          state: 'stopped',
          runtimeState: 'starting' // legacy running representation
        })
      });
      assert.equal(stoppedWins.listServices()[0].runtime.state, 'stopped');

      const { registry: runningWins } = createHarness({
        getServiceRuntime: () => ({
          state: 'running',
          runtimeState: 'not_running' // legacy stopped representation
        })
      });
      assert.equal(runningWins.listServices()[0].runtime.state, 'running');
    });
  });

  // ==========================================================================
  // 3. Legacy state mappings (starting -> running, not_running / never_started -> stopped)
  // ==========================================================================
  describe('3. Legacy state mappings', () => {
    it('maps canonical state: "starting" to "running"', () => {
      const { registry } = createHarness({
        getServiceRuntime: () => ({ state: 'starting' })
      });

      const services = registry.listServices();
      for (const service of services) {
        assert.equal(service.runtime.state, 'running');
      }
    });

    it('maps canonical state: "not_running" to "stopped"', () => {
      const { registry } = createHarness({
        getServiceRuntime: () => ({ state: 'not_running' })
      });

      const services = registry.listServices();
      for (const service of services) {
        assert.equal(service.runtime.state, 'stopped');
      }
    });

    it('maps canonical state: "never_started" to "stopped"', () => {
      const { registry } = createHarness({
        getServiceRuntime: () => ({ state: 'never_started' })
      });

      const services = registry.listServices();
      for (const service of services) {
        assert.equal(service.runtime.state, 'stopped');
      }
    });

    it('maps fallback runtimeState: "starting" to "running"', () => {
      const { registry } = createHarness({
        getServiceRuntime: () => ({ runtimeState: 'starting' })
      });

      const services = registry.listServices();
      for (const service of services) {
        assert.equal(service.runtime.state, 'running');
      }
    });

    it('maps fallback runtimeState: "not_running" to "stopped"', () => {
      const { registry } = createHarness({
        getServiceRuntime: () => ({ runtimeState: 'not_running' })
      });

      const services = registry.listServices();
      for (const service of services) {
        assert.equal(service.runtime.state, 'stopped');
      }
    });

    it('maps fallback runtimeState: "never_started" to "stopped"', () => {
      const { registry } = createHarness({
        getServiceRuntime: () => ({ runtimeState: 'never_started' })
      });

      const services = registry.listServices();
      for (const service of services) {
        assert.equal(service.runtime.state, 'stopped');
      }
    });

    it('passes through unrecognized non-standard status strings', () => {
      const { registry } = createHarness({
        getServiceRuntime: () => ({ state: 'degraded' })
      });

      const services = registry.listServices();
      assert.equal(services[0].runtime.state, 'degraded');
    });
  });

  // ==========================================================================
  // 4. Absent runtime returns "unknown"
  // ==========================================================================
  describe('4. Absent runtime handling (returns "unknown")', () => {
    it('returns state: "unknown" with null revisions and false pendingApply when runtime is null', () => {
      const { registry } = createHarness({
        getServiceRuntime: () => null
      });

      const services = registry.listServices();
      for (const service of services) {
        assert.deepEqual(service.runtime, {
          state: 'unknown',
          activeProfileRevision: null,
          activeServiceRevision: null,
          pendingApply: false,
          observation: normalizeObservation(null)
        });
      }
    });

    it('returns state: "unknown" with null revisions and false pendingApply when runtime is undefined', () => {
      const { registry } = createHarness({
        getServiceRuntime: () => undefined
      });

      const services = registry.listServices();
      for (const service of services) {
        assert.deepEqual(service.runtime, {
          state: 'unknown',
          activeProfileRevision: null,
          activeServiceRevision: null,
          pendingApply: false,
          observation: normalizeObservation(null)
        });
      }
    });

    it('returns state: "unknown" when getServiceRuntime callback is not configured in attachRegistry', () => {
      const { registry } = createHarness({
        getServiceRuntime: undefined // will not pass getServiceRuntime to attachRegistry
      });

      const services = registry.listServices();
      for (const service of services) {
        assert.equal(service.runtime.state, 'unknown');
        assert.equal(service.runtime.activeProfileRevision, null);
        assert.equal(service.runtime.activeServiceRevision, null);
        assert.equal(service.runtime.pendingApply, false);
      }
    });

    it('returns state: "unknown" when getServiceRuntime returns non-object primitives', () => {
      for (const primitive of ['', 0, 42, false, true, Symbol('test')]) {
        const { registry } = createHarness({
          getServiceRuntime: () => primitive
        });
        const service = registry.listServices()[0];
        assert.equal(service.runtime.state, 'unknown');
        assert.equal(service.runtime.activeProfileRevision, null);
        assert.equal(service.runtime.activeServiceRevision, null);
        assert.equal(service.runtime.pendingApply, false);
      }
    });

    it('returns state: "unknown" when runtime is an empty object without state or runtimeState', () => {
      const { registry } = createHarness({
        getServiceRuntime: () => ({})
      });

      const services = registry.listServices();
      for (const service of services) {
        assert.equal(service.runtime.state, 'unknown');
        assert.equal(service.runtime.activeProfileRevision, null);
        assert.equal(service.runtime.activeServiceRevision, null);
        assert.equal(service.runtime.pendingApply, false);
      }
    });
  });

  // ==========================================================================
  // 5. Revision and pendingApply preservation in serialized output
  // ==========================================================================
  describe('5. Revision and pendingApply preservation in serialized output', () => {
    it('preserves valid safe integers for activeProfileRevision and activeServiceRevision', () => {
      const { registry } = createHarness({
        getServiceRuntime: () => ({
          state: 'running',
          activeProfileRevision: 10,
          activeServiceRevision: 1, // matches service row.revision (1)
          pendingApply: false
        })
      });

      const service = registry.listServices().find(s => s.id === 'overleaf-mcp');
      assert.equal(service.runtime.activeProfileRevision, 10);
      assert.equal(service.runtime.activeServiceRevision, 1);
      assert.equal(service.runtime.pendingApply, false);
    });

    it('coerces non-safe-integer or invalid revision fields to null', () => {
      const { registry } = createHarness({
        getServiceRuntime: () => ({
          state: 'running',
          activeProfileRevision: '10', // string, not safe integer
          activeServiceRevision: 1.5,  // float, not safe integer
          pendingApply: false
        })
      });

      const service = registry.listServices()[0];
      assert.equal(service.runtime.activeProfileRevision, null);
      assert.equal(service.runtime.activeServiceRevision, null);
    });

    it('preserves explicit pendingApply: true when revisions match', () => {
      const { registry } = createHarness({
        getServiceRuntime: () => ({
          state: 'running',
          activeProfileRevision: 1,
          activeServiceRevision: 1, // matches service revision (1)
          pendingApply: true
        })
      });

      const service = registry.listServices().find(s => s.id === 'overleaf-mcp');
      assert.equal(service.runtime.pendingApply, true);
    });

    it('automatically sets pendingApply: true on revision mismatch (activeServiceRevision !== serviceRevision)', () => {
      const { registry } = createHarness({
        getServiceRuntime: () => ({
          state: 'running',
          activeProfileRevision: 1,
          activeServiceRevision: 99, // service row.revision is 1
          pendingApply: false // even if explicitly false in runtime input
        })
      });

      const service = registry.listServices().find(s => s.id === 'overleaf-mcp');
      assert.equal(service.revision, 1);
      assert.equal(service.runtime.activeServiceRevision, 99);
      assert.equal(service.runtime.pendingApply, true, 'Revision mismatch must force pendingApply: true');
    });

    it('preserves complete runtime contract through JSON serialization round-trip', () => {
      const { registry } = createHarness({
        getServiceRuntime: (id) => ({
          state: 'running',
          runtimeState: 'stopped', // ignored due to canonical state
          activeProfileRevision: 42,
          activeServiceRevision: 1,
          pendingApply: false
        })
      });

      const services = registry.listServices();
      const serialized = JSON.stringify(services);
      const parsed = JSON.parse(serialized);

      assert.equal(parsed.length, services.length);
      const overleaf = parsed.find(s => s.id === 'overleaf-mcp');
      assert.ok(overleaf);
      assert.equal(overleaf.id, 'overleaf-mcp');
      assert.equal(overleaf.revision, 1);
      assert.deepEqual(overleaf.runtime, {
        state: 'running',
        activeProfileRevision: 42,
        activeServiceRevision: 1,
        pendingApply: false,
        observation: normalizeObservation(null)
      });
    });

    it('preserves runtime contract through HTTP DTO sanitization (sanitizeMcpDto)', () => {
      const { registry } = createHarness({
        getServiceRuntime: (id) => ({
          state: 'starting', // should map to 'running'
          activeProfileRevision: 7,
          activeServiceRevision: 2, // mismatch with service row.revision 1 -> pendingApply true
          pendingApply: false
        })
      });

      const rawService = registry.listServices().find(s => s.id === 'overleaf-mcp');
      const sanitized = sanitizeMcpDto(rawService);

      assert.ok(sanitized);
      assert.equal(sanitized.id, 'overleaf-mcp');
      assert.equal(sanitized.revision, 1);
      assert.ok(sanitized.runtime);
      assert.equal(sanitized.runtime.state, 'running');
      assert.equal(sanitized.runtime.activeProfileRevision, 7);
      assert.equal(sanitized.runtime.activeServiceRevision, 2);
      assert.equal(sanitized.runtime.pendingApply, true);

      // Verify JSON round-trip of sanitized DTO
      const jsonRoundTrip = JSON.parse(JSON.stringify(sanitized));
      assert.deepEqual(jsonRoundTrip.runtime, {
        state: 'running',
        activeProfileRevision: 7,
        activeServiceRevision: 2,
        pendingApply: true,
        observation: normalizeObservation(null)
      });
    });

    it('maintains isolated runtime states per service across multiple registrations', async () => {
      const runtimeMap = {
        'overleaf-mcp': { runtimeState: 'running', activeProfileRevision: 5, activeServiceRevision: 1, pendingApply: false },
        'antigravity-mcp': { runtimeState: 'stopped', activeProfileRevision: 5, activeServiceRevision: 1, pendingApply: false },
        'mcp_custom_worker': { state: 'starting', activeProfileRevision: 6, activeServiceRevision: 10, pendingApply: false }
      };

      const { registry } = createHarness({
        getServiceRuntime: (id) => runtimeMap[id] || null
      });

      await registry.create({
        id: 'mcp_custom_worker',
        label: 'Custom Worker',
        binding: {
          type: 'stdio',
          executable: 'node',
          args: [{ id: 'worker.js', value: 'worker.js' }]
        }
      });

      const services = registry.listServices();
      const overleaf = services.find(s => s.id === 'overleaf-mcp');
      const antigravity = services.find(s => s.id === 'antigravity-mcp');
      const worker = services.find(s => s.id === 'mcp_custom_worker');

      assert.equal(overleaf.runtime.state, 'running');
      assert.equal(overleaf.runtime.pendingApply, false);

      assert.equal(antigravity.runtime.state, 'stopped');
      assert.equal(antigravity.runtime.pendingApply, false);

      assert.equal(worker.runtime.state, 'running');
      assert.equal(worker.runtime.activeServiceRevision, 10);
      assert.equal(worker.runtime.pendingApply, true); // 10 !== 1 (initial revision)
    });
  });
});

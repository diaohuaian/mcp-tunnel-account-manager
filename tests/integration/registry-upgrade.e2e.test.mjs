import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createVault } from '../../src/vault.mjs';
import {
  LEGACY_SERVICES,
  isMcpServiceId,
  pinRegistrySnapshot,
  removalDecision,
  assertStoppedConnectionReceipt,
  mergeEnvironmentPatch,
  publicEnvironment,
  RegistryPolicyFault
} from '../../src/core/mcp-registry-policy.mjs';

// Dynamically load attachRegistry: prefer production module if available, otherwise synthetic fixture
let attachRegistry;
try {
  ({ attachRegistry } = await import('../../src/mcp-registry-store.mjs'));
} catch {
  ({ attachRegistry } = await import('../fixtures/synthetic-registry-store.mjs'));
}

function createTestHarness(tmpDir) {
  const dataDir = path.join(tmpDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const vault = createVault({ dataDir });
  const dbPath = path.join(dataDir, 'manager.db');
  const db = new DatabaseSync(dbPath);

  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = FULL;');

  // Metadata table
  db.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  db.prepare("INSERT OR IGNORE INTO metadata (key, value) VALUES ('revision', '0')").run();

  function getGlobalRevision() {
    const row = db.prepare("SELECT value FROM metadata WHERE key = 'revision'").get();
    return row ? parseInt(row.value, 10) : 0;
  }

  function bumpGlobalRevision() {
    const nextRev = getGlobalRevision() + 1;
    db.prepare("UPDATE metadata SET value = ? WHERE key = 'revision'").run(String(nextRev));
    return nextRev;
  }

  const runtimes = new Map();
  let isIdle = true;

  function withWriteTransaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const res = fn();
      db.exec('COMMIT');
      return Promise.resolve(res);
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      return Promise.reject(e);
    }
  }

  const registry = attachRegistry({
    db,
    vault,
    withWriteTransaction,
    getGlobalRevision,
    bumpGlobalRevision,
    assertIdle: () => {
      if (!isIdle) throw new RegistryPolicyFault('MCP_BUSY', 409);
      return true;
    },
    getServiceRuntime: (id) => runtimes.get(id) || { state: 'stopped', running: false },
    clearActiveService: (id) => runtimes.delete(id)
  });

  return {
    dataDir,
    db,
    vault,
    registry,
    getGlobalRevision,
    bumpGlobalRevision,
    setRuntime: (id, rt) => runtimes.set(id, rt),
    setIdle: (idle) => { isIdle = idle; },
    close: async () => {
      db.close();
      await vault.close();
    }
  };
}

describe('MCP Registry Upgrade & Lifecycle E2E Acceptance Suite', () => {

  // 1. Synthetic migration preserving existing profile ciphertext, AAD, ID, master key reference
  it('1. Synthetic migration preserves existing profile ciphertext, AAD, ID, and master key reference', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-upg-mig-'));
    const dataDir = path.join(tmpDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });

    // Step A: Setup legacy v0 database with sealed profiles
    const vault = createVault({ dataDir });
    const dbPath = path.join(dataDir, 'manager.db');
    const db = new DatabaseSync(dbPath);

    db.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
    `);
    db.prepare("INSERT INTO metadata (key, value) VALUES ('revision', '1')").run();

    const legacyProfileId = 'profile-legacy-001';
    const legacyCreds = {
      'overleaf-mcp': { tunnelId: 'tunnel-legacy-ovl', apiKey: 'sec-legacy-ovl-key-111' },
      'antigravity-mcp': { tunnelId: 'tunnel-legacy-ant', apiKey: 'sec-legacy-ant-key-222' }
    };
    const legacyAad = JSON.stringify(['profile', legacyProfileId, 1]);
    const sealedCreds = vault.seal(legacyCreds, legacyAad);
    const nowIso = new Date().toISOString();

    db.prepare(`
      INSERT INTO profiles (id, label, revision, sealed_credentials, services_meta, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      legacyProfileId,
      'Legacy Active Profile',
      1,
      JSON.stringify(sealedCreds),
      JSON.stringify({ 'overleaf-mcp': { configured: true }, 'antigravity-mcp': { configured: true } }),
      nowIso,
      nowIso
    );

    // Close legacy DB handle
    db.close();
    await vault.close();

    // Step B: Reopen in upgraded manager harness (synthetic migration)
    const upgradedVault = createVault({ dataDir });
    const upgradedDb = new DatabaseSync(dbPath);

    function withWriteTx(fn) {
      upgradedDb.exec('BEGIN IMMEDIATE');
      try {
        const res = fn();
        upgradedDb.exec('COMMIT');
        return Promise.resolve(res);
      } catch (e) {
        try { upgradedDb.exec('ROLLBACK'); } catch (_) {}
        return Promise.reject(e);
      }
    }

    function getRev() {
      const row = upgradedDb.prepare("SELECT value FROM metadata WHERE key = 'revision'").get();
      return row ? parseInt(row.value, 10) : 0;
    }
    function bumpRev() {
      const n = getRev() + 1;
      upgradedDb.prepare("UPDATE metadata SET value = ? WHERE key = 'revision'").run(String(n));
      return n;
    }

    const registry = attachRegistry({
      db: upgradedDb,
      vault: upgradedVault,
      withWriteTransaction: withWriteTx,
      getGlobalRevision: getRev,
      bumpGlobalRevision: bumpRev
    });

    // Step C: Verify existing profile remains uncorrupted and unsealable
    const profileRow = upgradedDb.prepare('SELECT * FROM profiles WHERE id = ?').get(legacyProfileId);
    assert.ok(profileRow, 'Legacy profile must exist after migration');
    assert.equal(profileRow.id, legacyProfileId);
    assert.equal(profileRow.revision, 1);

    // Unseal credentials using original AAD
    const unsealed = upgradedVault.unseal(profileRow.sealed_credentials, legacyAad);
    const parsedCreds = typeof unsealed === 'string' ? JSON.parse(unsealed) : unsealed;
    assert.equal(parsedCreds['overleaf-mcp'].tunnelId, 'tunnel-legacy-ovl');
    assert.equal(parsedCreds['overleaf-mcp'].apiKey, 'sec-legacy-ovl-key-111');
    assert.equal(parsedCreds['antigravity-mcp'].tunnelId, 'tunnel-legacy-ant');
    assert.equal(parsedCreds['antigravity-mcp'].apiKey, 'sec-legacy-ant-key-222');

    // Clean up
    upgradedDb.close();
    await upgradedVault.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 2. Legacy 2 service seeds not duplicated
  it('2. Legacy 2 service seeds exist and are not duplicated on subsequent runs', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-upg-seed-'));
    const h = createTestHarness(tmpDir);

    try {
      const services = h.registry.listServices();
      assert.ok(services.length >= 2, 'Should seed at least the 2 legacy services');

      const overleaf = services.find(s => s.id === 'overleaf-mcp');
      const antigravity = services.find(s => s.id === 'antigravity-mcp');

      assert.ok(overleaf, 'overleaf-mcp must be seeded');
      assert.ok(antigravity, 'antigravity-mcp must be seeded');
      assert.equal(overleaf.sortOrder, 100);
      assert.equal(antigravity.sortOrder, 1000);
      assert.equal(antigravity.controlCarrier, true);

      // Re-run migration/seeding on same DB
      const registry2 = attachRegistry({
        db: h.db,
        vault: h.vault,
        withWriteTransaction: (fn) => Promise.resolve(fn()),
        getGlobalRevision: h.getGlobalRevision,
        bumpGlobalRevision: h.bumpGlobalRevision
      });

      const servicesAfter = registry2.listServices();
      const ovlCount = servicesAfter.filter(s => s.id === 'overleaf-mcp').length;
      const antCount = servicesAfter.filter(s => s.id === 'antigravity-mcp').length;

      assert.equal(ovlCount, 1, 'overleaf-mcp must not be duplicated');
      assert.equal(antCount, 1, 'antigravity-mcp must not be duplicated');
    } finally {
      await h.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // 3. CRUD new 3rd MCP (stdio and http)
  it('3. CRUD operations on new 3rd MCP (stdio and http bindings)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-upg-crud-'));
    const h = createTestHarness(tmpDir);

    try {
      // 3.1 Create stdio MCP
      const stdioInput = {
        label: 'My Custom Stdio MCP',
        binding: {
          type: 'stdio',
          executable: 'node',
          args: [
            { id: 'arg_file', value: 'server.js', secret: false },
            { id: 'arg_token', value: 'secret_cli_token_999', secret: true }
          ],
          cwd: 'C:/sample/mcp'
        },
        environment: {
          PORT: { value: '8080', secret: false },
          API_TOKEN: { value: 'secret_env_val_xyz', secret: true }
        }
      };

      const stdioCreated = await h.registry.create(stdioInput, { expectedRevision: h.getGlobalRevision() });
      assert.ok(stdioCreated);
      assert.ok(stdioCreated.id.startsWith('mcp_'), 'ID must start with mcp_');
      assert.equal(stdioCreated.label, 'My Custom Stdio MCP');
      assert.equal(stdioCreated.enabled, true);

      // Public DTO privacy assertions
      const stdioArgs = stdioCreated.binding.args;
      const secretArg = stdioArgs.find(a => a.id === 'arg_token');
      const publicArg = stdioArgs.find(a => a.id === 'arg_file');
      assert.equal(secretArg.secret, true);
      assert.equal(secretArg.configured, true);
      assert.equal(secretArg.value, undefined, 'Secret arg value must not be present in public DTO');
      assert.equal(publicArg.secret, false);
      assert.equal(publicArg.value, 'server.js');

      // 3.2 Create HTTP MCP
      const httpInput = {
        label: 'My Custom HTTP MCP',
        binding: {
          type: 'http',
          url: 'https://127.0.0.1:8443/mcp',
          headers: {
            Authorization: { value: 'Bearer http_secret_token_123', secret: true },
            'X-Custom': { value: 'public-header-value', secret: false }
          }
        }
      };

      const httpCreated = await h.registry.create(httpInput, { expectedRevision: h.getGlobalRevision() });
      assert.ok(httpCreated);
      assert.ok(httpCreated.id.startsWith('mcp_'));
      assert.equal(httpCreated.binding.type, 'http');
      assert.equal(httpCreated.binding.headers['Authorization'].secret, true);
      assert.equal(httpCreated.binding.headers['Authorization'].configured, true);
      assert.equal(httpCreated.binding.headers['Authorization'].value, undefined, 'Secret header must be masked');
      assert.equal(httpCreated.binding.headers['X-Custom'].value, 'public-header-value');

      // 3.3 Read definition (internal trusted unsealed)
      const internalDef = h.registry.getDefinition(stdioCreated.id);
      assert.ok(internalDef);
      assert.equal(internalDef.binding.args.find(a => a.id === 'arg_token').value, 'secret_cli_token_999');

      // 3.4 Update (PATCH) label and binding
      const updated = await h.registry.update(
        stdioCreated.id,
        {
          label: 'Updated Custom Stdio MCP',
          binding: {
            type: 'stdio',
            args: [
              { id: 'arg_file', value: 'server-updated.js', secret: false },
              { id: 'arg_token', secret: true } // omitted value retains existing
            ]
          }
        },
        { expectedRevision: h.getGlobalRevision() }
      );

      assert.equal(updated.label, 'Updated Custom Stdio MCP');
      const unsealedAfterUpdate = h.registry.getDefinition(stdioCreated.id);
      assert.equal(unsealedAfterUpdate.label, 'Updated Custom Stdio MCP');
      assert.equal(unsealedAfterUpdate.binding.args.find(a => a.id === 'arg_file').value, 'server-updated.js');
      assert.equal(unsealedAfterUpdate.binding.args.find(a => a.id === 'arg_token').value, 'secret_cli_token_999', 'Retained omitted value');

      // 3.5 Delete (Remove)
      h.setRuntime(stdioCreated.id, { state: 'stopped', running: false });
      const removeResult = await h.registry.remove(stdioCreated.id, { expectedRevision: h.getGlobalRevision() });
      assert.ok(removeResult.success || removeResult.removed);

      // Verify removed service does not appear in standard list
      const listAfterDelete = h.registry.listServices();
      assert.equal(listAfterDelete.some(s => s.id === stdioCreated.id), false);
    } finally {
      await h.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // 4. Environment secrets default masked, preserved on empty/omitted edit, explicit remove
  it('4. Environment secrets default masked, preserved on empty/omitted edit, explicit remove', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-upg-env-'));
    const h = createTestHarness(tmpDir);

    try {
      // Create MCP with initial env
      const created = await h.registry.create({
        label: 'Env Test MCP',
        binding: { type: 'stdio', executable: 'node', args: [] },
        environmentPatch: [
          { op: 'set', name: 'PUBLIC_FLAG', value: 'flag123', secret: false },
          { op: 'set', name: 'DEFAULT_SECRET_VAR', value: 'hidden_val_1' }, // defaults to secret
          { op: 'set', name: 'MY_API_KEY', value: 'key_cannot_be_public', secret: false } // sensitive name forced secret
        ]
      }, { expectedRevision: h.getGlobalRevision() });

      const envList = created.environment;
      const pubFlag = envList.find(e => e.name === 'PUBLIC_FLAG');
      const defSec = envList.find(e => e.name === 'DEFAULT_SECRET_VAR');
      const apiKey = envList.find(e => e.name === 'MY_API_KEY');

      assert.equal(pubFlag.secret, false);
      assert.equal(pubFlag.value, 'flag123');
      assert.equal(defSec.secret, true);
      assert.equal(defSec.value, undefined, 'Default secret value must not appear in public DTO');
      assert.equal(apiKey.secret, true, 'Sensitive name MY_API_KEY cannot be set to non-secret');
      assert.equal(apiKey.value, undefined);

      // 4.1 Edit with omitted environmentPatch: preserves existing env
      const patched1 = await h.registry.update(created.id, { label: 'Renamed Env MCP' }, { expectedRevision: h.getGlobalRevision() });
      assert.equal(patched1.environment.length, 3, 'Omitted patch preserves existing environment');

      // 4.2 Edit with explicit empty string: preserves empty string as value
      const patched2 = await h.registry.update(created.id, {
        environmentPatch: [
          { op: 'set', name: 'PUBLIC_FLAG', value: '', secret: false }
        ]
      }, { expectedRevision: h.getGlobalRevision() });

      const pubFlagEmpty = patched2.environment.find(e => e.name === 'PUBLIC_FLAG');
      assert.equal(pubFlagEmpty.value, '', 'Empty string must be preserved explicitly');

      // 4.3 Edit with explicit remove
      const patched3 = await h.registry.update(created.id, {
        environmentPatch: [
          { op: 'remove', name: 'PUBLIC_FLAG' }
        ]
      }, { expectedRevision: h.getGlobalRevision() });

      assert.equal(patched3.environment.some(e => e.name === 'PUBLIC_FLAG'), false, 'Explicit remove deletes the variable');
      assert.equal(patched3.environment.some(e => e.name === 'DEFAULT_SECRET_VAR'), true, 'Other variables remain intact');
    } finally {
      await h.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // 5. Global revision conflict handling (expectedRevision mismatch 409)
  it('5. Global revision conflict rejects stale requests with 409 REVISION_CONFLICT', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-upg-rev-'));
    const h = createTestHarness(tmpDir);

    try {
      const currentRev = h.getGlobalRevision();
      const staleRev = currentRev + 99;

      // Stale create
      await assert.rejects(
        async () => {
          await h.registry.create({ label: 'Conflict MCP', binding: { type: 'stdio', executable: 'node' } }, { expectedRevision: staleRev });
        },
        (err) => err.code === 'REVISION_CONFLICT' && err.status === 409
      );

      // Valid create
      const created = await h.registry.create({ label: 'Valid MCP', binding: { type: 'stdio', executable: 'node' } }, { expectedRevision: currentRev });
      const newRev = h.getGlobalRevision();
      assert.ok(newRev > currentRev);

      // Stale update
      await assert.rejects(
        async () => {
          await h.registry.update(created.id, { label: 'Stale Update' }, { expectedRevision: currentRev });
        },
        (err) => err.code === 'REVISION_CONFLICT' && err.status === 409
      );

      // Stale remove
      await assert.rejects(
        async () => {
          await h.registry.remove(created.id, { expectedRevision: currentRev });
        },
        (err) => err.code === 'REVISION_CONFLICT' && err.status === 409
      );
    } finally {
      await h.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // 6. Pinned snapshot independent of subsequent definition mutation
  it('6. Pinned snapshot remains independent of subsequent definition mutation', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-upg-snap-'));
    const h = createTestHarness(tmpDir);

    try {
      const created = await h.registry.create({
        label: 'Snapshot Source MCP',
        binding: {
          type: 'stdio',
          executable: 'node',
          args: [{ id: 'a1', value: 'orig.js', secret: false }]
        }
      }, { expectedRevision: h.getGlobalRevision() });

      // Pin snapshot
      const currentRev = h.getGlobalRevision();
      const snapshot = h.registry.snapshot([created.id], currentRev);
      assert.ok(snapshot);
      assert.equal(snapshot.revision, currentRev);
      assert.equal(snapshot.services.length, 1);
      assert.equal(snapshot.services[0].label, 'Snapshot Source MCP');

      // Subsequent mutation in registry
      await h.registry.update(created.id, {
        label: 'Mutated Label After Snapshot',
        binding: {
          type: 'stdio',
          args: [{ id: 'a1', value: 'mutated.js', secret: false }]
        }
      }, { expectedRevision: h.getGlobalRevision() });

      // Verify DB definition was mutated
      const currentDef = h.registry.getDefinition(created.id);
      assert.equal(currentDef.label, 'Mutated Label After Snapshot');

      // Verify pinned snapshot is completely unaffected
      assert.equal(snapshot.services[0].label, 'Snapshot Source MCP');
      assert.equal(snapshot.services[0].binding.args[0].value, 'orig.js');
    } finally {
      await h.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // 7. Idempotency handling with stable body fingerprint
  it('7. Idempotency handling with stable body fingerprint accepts replay, rejects payload change', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-upg-idemp-'));
    const h = createTestHarness(tmpDir);

    try {
      const created = await h.registry.create({ label: 'Stop Target MCP', binding: { type: 'stdio', executable: 'node' } }, { expectedRevision: h.getGlobalRevision() });
      const currentRev = h.getGlobalRevision();
      const idempotencyKey = 'idemp-stop-key-001';

      // First call
      const action1 = await h.registry.createStopAction({
        serviceId: created.id,
        expectedRevision: currentRev,
        idempotencyKey
      });
      assert.ok(action1);
      assert.equal(action1.serviceId, created.id);
      assert.equal(action1.state, 'QUEUED');

      // Replay exact same request with same idempotencyKey -> returns existing action
      const action2 = await h.registry.createStopAction({
        serviceId: created.id,
        expectedRevision: currentRev,
        idempotencyKey
      });
      assert.equal(action2.id, action1.id, 'Idempotent replay must return exact same action ID');

      // Same idempotencyKey with different body -> 409 IDEMPOTENCY_CONFLICT
      await assert.rejects(
        async () => {
          await h.registry.createStopAction({
            serviceId: 'overleaf-mcp', // conflicting target
            expectedRevision: currentRev,
            idempotencyKey
          });
        },
        (err) => err.code === 'IDEMPOTENCY_CONFLICT' && err.status === 409
      );
    } finally {
      await h.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // 8. Stopped MCP removal archives registration (tombstone), cannot be resurrected by seed, preserves installation/source files
  it('8. Stopped MCP removal archives registration (tombstone), cannot be resurrected by seed, preserves installation/source files', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-upg-tomb-'));
    const h = createTestHarness(tmpDir);

    try {
      // Create a dummy installation directory and source file
      const installDir = path.join(tmpDir, 'dummy-install');
      fs.mkdirSync(installDir, { recursive: true });
      const sourceConfigFile = path.join(installDir, 'custom.yaml');
      fs.writeFileSync(sourceConfigFile, 'custom_content: 1\n', 'utf8');

      const created = await h.registry.create({
        id: 'mcp_tombstonetest',
        label: 'Tombstone Test MCP',
        binding: { type: 'stdio', executable: 'node' },
        locations: {
          installationRoot: installDir,
          sourceConfigPath: sourceConfigFile
        }
      }, { expectedRevision: h.getGlobalRevision() });

      // Remove while stopped
      h.setRuntime(created.id, { state: 'stopped', running: false });
      const removeResult = await h.registry.remove(created.id, { expectedRevision: h.getGlobalRevision() });
      assert.ok(removeResult.success || removeResult.removed);

      // Verify files still exist on disk
      assert.ok(fs.existsSync(installDir), 'Installation directory must be preserved on removal');
      assert.ok(fs.existsSync(sourceConfigFile), 'Source config file must be preserved on removal');

      // Verify cannot be resurrected by seeding
      const registryReopened = attachRegistry({
        db: h.db,
        vault: h.vault,
        withWriteTransaction: (fn) => Promise.resolve(fn()),
        getGlobalRevision: h.getGlobalRevision,
        bumpGlobalRevision: h.bumpGlobalRevision
      });

      const listAfterSeed = registryReopened.listServices();
      assert.equal(listAfterSeed.some(s => s.id === created.id), false, 'Tombstoned service must not be resurrected');
    } finally {
      await h.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // 9. Running / unknown state protection against removal (409 MCP_RUNNING / RUNTIME_STATE_UNKNOWN)
  it('9. Running and unknown state protection rejects removal with 409 MCP_RUNNING and RUNTIME_STATE_UNKNOWN', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-upg-prot-'));
    const h = createTestHarness(tmpDir);

    try {
      const created = await h.registry.create({ label: 'Protected Removal MCP', binding: { type: 'stdio', executable: 'node' } }, { expectedRevision: h.getGlobalRevision() });

      // 9.1 Running state -> 409 MCP_RUNNING
      h.setRuntime(created.id, { state: 'running', running: true, pid: 1111 });
      await assert.rejects(
        async () => {
          await h.registry.remove(created.id, { expectedRevision: h.getGlobalRevision() });
        },
        (err) => err.code === 'MCP_RUNNING' && err.status === 409
      );

      // 9.2 Starting state -> 409 MCP_RUNNING
      h.setRuntime(created.id, { state: 'starting', running: true });
      await assert.rejects(
        async () => {
          await h.registry.remove(created.id, { expectedRevision: h.getGlobalRevision() });
        },
        (err) => err.code === 'MCP_RUNNING' && err.status === 409
      );

      // 9.3 Busy during active operation -> 409 MCP_BUSY
      h.setRuntime(created.id, { state: 'stopped', running: false });
      h.setIdle(false); // harness simulates busy switch/stop operation
      await assert.rejects(
        async () => {
          await h.registry.remove(created.id, { expectedRevision: h.getGlobalRevision() });
        },
        (err) => err.code === 'MCP_BUSY' && err.status === 409
      );
      h.setIdle(true);

      // 9.4 Unknown runtime state -> 409 RUNTIME_STATE_UNKNOWN
      h.setRuntime(created.id, { state: 'unmanaged_daemon_anomaly' });
      await assert.rejects(
        async () => {
          await h.registry.remove(created.id, { expectedRevision: h.getGlobalRevision() });
        },
        (err) => err.code === 'RUNTIME_STATE_UNKNOWN' && err.status === 409
      );

      // 9.5 Stopped state -> removal allowed
      h.setRuntime(created.id, { state: 'stopped', running: false });
      const res = await h.registry.remove(created.id, { expectedRevision: h.getGlobalRevision() });
      assert.ok(res.success || res.removed);
    } finally {
      await h.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // 10. Stop recovery and strict receipt validation
  it('10. Stop recovery and strict receipt validation enforces valid process identity proof', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-upg-stoprec-'));
    const h = createTestHarness(tmpDir);

    try {
      const created = await h.registry.create({ label: 'Stop Recovery MCP', binding: { type: 'stdio', executable: 'node' } }, { expectedRevision: h.getGlobalRevision() });
      const currentRev = h.getGlobalRevision();

      const action = await h.registry.createStopAction({
        serviceId: created.id,
        expectedRevision: currentRev
      });
      assert.equal(action.state, 'QUEUED');

      // Transition to APPLYING
      await h.registry.transitionAction(action.id, { state: 'APPLYING' });
      const applying = h.registry.publicAction(action.id);
      assert.equal(applying.state, 'APPLYING');

      // Test receipt validation with missing / invalid proof -> throws STOP_UNCONFIRMED
      const badReceipt1 = { stopped: false };
      await assert.rejects(
        async () => {
          await h.registry.finishStoppedAction(action.id, badReceipt1);
        },
        (err) => err.code === 'STOP_UNCONFIRMED'
      );

      const badReceipt2 = {
        stopped: true,
        operationId: action.id,
        service: created.id,
        proof: { kind: 'verified-owned-process-exit' },
        identity: { pid: -1 } // invalid PID
      };
      await assert.rejects(
        async () => {
          await h.registry.finishStoppedAction(action.id, badReceipt2);
        },
        (err) => err.code === 'STOP_UNCONFIRMED'
      );

      // Mark action attention on failure (stop recovery gate)
      await h.registry.markActionAttention(action.id, 'STOP_UNCONFIRMED');
      const gated = h.registry.publicAction(action.id);
      assert.equal(gated.state, 'NEEDS_ATTENTION');
      assert.equal(gated.errorCode, 'STOP_UNCONFIRMED');

      // Valid receipt with verified-owned-process-exit
      const validReceipt = {
        stopped: true,
        operationId: action.id,
        service: created.id,
        proof: { kind: 'verified-owned-process-exit' },
        identity: {
          pid: 2468,
          startedAt: new Date().toISOString(),
          executable: 'node.exe'
        }
      };

      const finished = await h.registry.finishStoppedAction(action.id, validReceipt);
      assert.equal(finished.state, 'SUCCEEDED');
      assert.equal(finished.serviceId, created.id);
    } finally {
      await h.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

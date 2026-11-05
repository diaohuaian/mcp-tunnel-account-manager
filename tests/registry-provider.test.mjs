import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRegisteredAdapterProvider as createFromDirect } from '../src/adapters/registry-provider.mjs';
import { createRegisteredAdapterProvider as createFromIndex, ServiceAdapter } from '../src/adapters/index.mjs';

const createdTempDirs = [];
function createTempWorkspace() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-provider-test-'));
  createdTempDirs.push(tmpDir);
  const dataDir = path.join(tmpDir, 'data');
  const tunnelHome = path.join(tmpDir, 'tunnel-home');
  const appData = path.join(tmpDir, 'app-data');

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(tunnelHome, { recursive: true });
  fs.mkdirSync(path.join(appData, 'tunnel-client'), { recursive: true });

  const paths = {
    userProfile: tmpDir,
    appData,
    tunnelHome,
    tunnelClientBin: path.join(tunnelHome, 'tunnel-client.exe'),
    overleafConfigPath: path.join(appData, 'tunnel-client', 'overleaf.yaml'),
    antigravityConfigPath: path.join(appData, 'tunnel-client', 'antigravity-local.yaml'),
    overleafEnvPath: path.join(tunnelHome, 'tunnel.env')
  };

  return { tmpDir, dataDir, paths };
}

function createFakeProcessController() {
  const processes = new Map();
  return {
    processes,
    inspect: async (svc) => processes.get(svc) || { running: false },
    verify: async (identity) => ({ valid: true }),
    stop: async (identity) => ({ stopped: true }),
    launch: async (params) => ({
      running: true,
      pid: 20001,
      startedAt: new Date().toISOString(),
      executable: params.command,
      service: params.service
    })
  };
}

function createFakeProbe() {
  return {
    isDefault: false,
    checkReady: async () => true,
    verify: async () => ({ ok: true, verified: true, proof: { kind: 'authenticated-control-plane' } })
  };
}

test('1. Factory returns callable provider with release, clear, has methods and size property', () => {
  assert.equal(typeof createFromDirect, 'function');
  assert.equal(typeof createFromIndex, 'function');

  const provider = createFromDirect();
  assert.equal(typeof provider, 'function');
  assert.equal(typeof provider.release, 'function');
  assert.equal(typeof provider.clear, 'function');
  assert.equal(typeof provider.has, 'function');
  assert.equal(provider.size, 0);
});

test('2. Caching by op.id: multiple calls with same op.id return identical adapter instances', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const processController = createFakeProcessController();
  const probe = createFakeProbe();

  const provider = createFromDirect({ dataDir, paths, processController, probe });

  const op = {
    id: 'op-cache-test-1',
    registrySnapshot: {
      services: [
        { id: 'mcp_service_alpha', enabled: true },
        { id: 'mcp_service_beta', enabled: true }
      ]
    }
  };

  const a1 = await provider(op, 'mcp_service_alpha');
  const a2 = await provider(op, 'mcp_service_alpha');
  const b1 = await provider(op, 'mcp_service_beta');

  assert.ok(a1 instanceof ServiceAdapter);
  assert.ok(b1 instanceof ServiceAdapter);
  assert.equal(a1, a2);
  assert.notEqual(a1, b1);
  assert.equal(provider.has('op-cache-test-1'), true);
  assert.equal(provider.size, 1);
});

test('3. Caching by op.operationId: operates properly when op has operationId instead of id', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const provider = createFromIndex({ dataDir, paths });

  const op = {
    operationId: 'op-operation-id-test',
    registrySnapshot: {
      services: [
        { id: 'mcp_thirdparty01', enabled: true }
      ]
    }
  };

  const adapterFirst = await provider(op, 'mcp_thirdparty01');
  assert.ok(adapterFirst instanceof ServiceAdapter);
  assert.equal(provider.has('op-operation-id-test'), true);

  const adapterSecond = await provider(op, 'mcp_thirdparty01');
  assert.equal(adapterFirst, adapterSecond);
});

test('4. provider.release(operationId): evicts cached adapters for that operationId', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const provider = createFromDirect({ dataDir, paths });

  const op = {
    id: 'op-release-test',
    registrySnapshot: {
      services: [{ id: 'mcp_custom_target', enabled: true }]
    }
  };

  const a1 = await provider(op, 'mcp_custom_target');
  assert.equal(provider.size, 1);
  assert.equal(provider.has('op-release-test'), true);

  provider.release('op-release-test');
  assert.equal(provider.size, 0);
  assert.equal(provider.has('op-release-test'), false);

  const a2 = await provider(op, 'mcp_custom_target');
  assert.notEqual(a1, a2);
});

test('5. provider.clear(): evicts all cached adapters across all operations', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const provider = createFromDirect({ dataDir, paths });

  const op1 = { id: 'op-multi-1' };
  const op2 = { id: 'op-multi-2' };

  await provider(op1, 'overleaf-mcp');
  await provider(op2, 'overleaf-mcp');
  assert.equal(provider.size, 2);

  provider.clear();
  assert.equal(provider.size, 0);
  assert.equal(provider.has('op-multi-1'), false);
  assert.equal(provider.has('op-multi-2'), false);
});

test('6. Fallback to default legacy adapters when registrySnapshot is missing or not an array', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const provider = createFromDirect({ dataDir, paths });

  const legacyOp1 = { id: 'op-legacy-1' };
  const legacyOp2 = { id: 'op-legacy-2', registrySnapshot: null };
  const legacyOp3 = { id: 'op-legacy-3', registrySnapshot: { services: 'invalid' } };

  for (const op of [legacyOp1, legacyOp2, legacyOp3]) {
    const overleaf = await provider(op, 'overleaf-mcp');
    const antigravity = await provider(op, 'antigravity-mcp');
    const unknown = await provider(op, 'mcp_not_there');

    assert.ok(overleaf instanceof ServiceAdapter);
    assert.ok(antigravity instanceof ServiceAdapter);
    assert.equal(overleaf.service, 'overleaf-mcp');
    assert.equal(antigravity.service, 'antigravity-mcp');
    assert.equal(unknown, undefined);
  }
});

test('7. Registered services in op.registrySnapshot.services: builds adapters exclusively for registered services', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const provider = createFromDirect({ dataDir, paths });

  const dynamicOp = {
    id: 'op-registered-only',
    registrySnapshot: {
      services: [
        { id: 'mcp_weather', enabled: true },
        { id: 'mcp_tools', enabled: true }
      ]
    }
  };

  const weather = await provider(dynamicOp, 'mcp_weather');
  const tools = await provider(dynamicOp, 'mcp_tools');
  const overleaf = await provider(dynamicOp, 'overleaf-mcp');
  const antigravity = await provider(dynamicOp, 'antigravity-mcp');

  assert.ok(weather instanceof ServiceAdapter);
  assert.ok(tools instanceof ServiceAdapter);
  assert.equal(weather.service, 'mcp_weather');
  assert.equal(tools.service, 'mcp_tools');
  assert.equal(overleaf, undefined);
  assert.equal(antigravity, undefined);
});

test('8. Unregistered or unknown serviceId returns undefined', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const provider = createFromDirect({ dataDir, paths });

  const op = {
    id: 'op-unknown-test',
    registrySnapshot: {
      services: [{ id: 'mcp_service_1', enabled: true }]
    }
  };

  assert.equal(await provider(op, 'mcp_service_nonexistent'), undefined);
  assert.equal(await provider(op, null), undefined);
  assert.equal(await provider(op, ''), undefined);
});

test('9. Cache isolation: separate operations have independent adapter instances', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const provider = createFromDirect({ dataDir, paths });

  const opA = {
    id: 'op-isolation-A',
    registrySnapshot: { services: [{ id: 'mcp_isolated', enabled: true }] }
  };
  const opB = {
    id: 'op-isolation-B',
    registrySnapshot: { services: [{ id: 'mcp_isolated', enabled: true }] }
  };

  const adapterA = await provider(opA, 'mcp_isolated');
  const adapterB = await provider(opB, 'mcp_isolated');

  assert.notEqual(adapterA, adapterB);
  assert.equal(adapterA.service, adapterB.service);
});

test('10. Options forwarding: dataDir, paths, processController, probe, healthURLs are forwarded to adapters', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const processController = createFakeProcessController();
  const probe = createFakeProbe();

  const provider = createFromDirect({
    dataDir,
    paths,
    processController,
    probe,
    healthURLs: { 'mcp_forward_test': 'http://127.0.0.1:9099' }
  });

  const op = {
    id: 'op-forward-test',
    registrySnapshot: {
      services: [{ id: 'mcp_forward_test', enabled: true }]
    }
  };

  const adapter = await provider(op, 'mcp_forward_test');
  assert.equal(adapter.dataDir, dataDir);
  assert.equal(adapter.processController, processController);
  assert.equal(adapter.probe, probe);
  assert.equal(adapter.healthURL, 'http://127.0.0.1:9099');
});

test('11. Handles null or undefined op gracefully without crashing', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const provider = createFromDirect({ dataDir, paths });

  const resNull = await provider(null, 'overleaf-mcp');
  const resUndef = await provider(undefined, 'overleaf-mcp');

  assert.ok(resNull instanceof ServiceAdapter);
  assert.ok(resUndef instanceof ServiceAdapter);
  assert.equal(resNull.service, 'overleaf-mcp');
});

test('12. Vault forwarding: options.vault is forwarded to adapters and provider does not close vault', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const fakeVault = {
    closed: false,
    seal: () => ({ v: 2 }),
    unseal: () => ({}),
    close() { this.closed = true; }
  };

  const provider = createFromDirect({ dataDir, paths, vault: fakeVault });

  const op = {
    id: 'op-vault-fwd',
    registrySnapshot: {
      services: [{ id: 'mcp_vault_svc', enabled: true }]
    }
  };

  const adapter = await provider(op, 'mcp_vault_svc');
  assert.equal(adapter.vault, fakeVault);
  assert.equal(fakeVault.closed, false, 'Factory must not close caller-owned vault');
  provider.release('op-vault-fwd');
  assert.equal(fakeVault.closed, false, 'Release must not close caller-owned vault');
  provider.clear();
  assert.equal(fakeVault.closed, false, 'Clear must not close caller-owned vault');
});

test('13. Options forwarding: vault, store, dataDir, and security are forwarded and accessible on provider', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const fakeVault = { seal: () => {}, unseal: () => {} };
  const fakeStore = { getProfile: () => null, getStorePath: () => dataDir };
  const fakeSecurity = { guard: async () => true };

  const provider = createFromDirect({
    dataDir,
    paths,
    vault: fakeVault,
    store: fakeStore,
    security: fakeSecurity
  });

  assert.equal(provider.vault, fakeVault);
  assert.equal(provider.store, fakeStore);
  assert.equal(provider.dataDir, dataDir);
  assert.equal(provider.security, fakeSecurity);

  assert.equal(provider.options.vault, fakeVault);
  assert.equal(provider.options.store, fakeStore);
  assert.equal(provider.options.dataDir, dataDir);
  assert.equal(provider.options.security, fakeSecurity);
  assert.ok(Object.isFrozen(provider.options));
});

test('14. Operation snapshots are immutable and cannot be mutated by callers', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const provider = createFromDirect({ dataDir, paths });

  const op = {
    id: 'op-imm-test-1',
    registrySnapshot: {
      revision: 7,
      services: [
        {
          id: 'mcp_immutable_svc',
          label: 'Original Label',
          enabled: true,
          binding: {
            type: 'stdio',
            executable: 'node',
            args: ['server.js']
          }
        }
      ]
    }
  };

  const adapter = await provider(op, 'mcp_immutable_svc');
  assert.ok(adapter instanceof ServiceAdapter);
  assert.equal(adapter.service, 'mcp_immutable_svc');

  // Verify op and op.registrySnapshot have been deep frozen
  assert.ok(Object.isFrozen(op));
  assert.ok(Object.isFrozen(op.registrySnapshot));
  assert.ok(Object.isFrozen(op.registrySnapshot.services));
  assert.ok(Object.isFrozen(op.registrySnapshot.services[0]));
  assert.ok(Object.isFrozen(op.registrySnapshot.services[0].binding));
  assert.ok(Object.isFrozen(op.registrySnapshot.services[0].binding.args));

  // In strict mode, modifying frozen properties throws TypeError
  assert.throws(() => {
    op.registrySnapshot.revision = 999;
  }, TypeError);

  assert.throws(() => {
    op.registrySnapshot.services[0].label = 'Mutated Label';
  }, TypeError);

  assert.throws(() => {
    op.registrySnapshot.services[0].binding.executable = 'hacked';
  }, TypeError);

  assert.throws(() => {
    op.registrySnapshot.services.push({ id: 'injected_svc' });
  }, TypeError);

  assert.throws(() => {
    op.newProperty = 'disallowed';
  }, TypeError);

  // Cached adapter retains original definition properties intact
  assert.equal(adapter.definition.label, 'Original Label');
  assert.equal(adapter.definition.binding.executable, 'node');
});

test('15. Cache isolation: definitions defensive copy isolates cached adapters from external definitions mutation', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const provider = createFromDirect({ dataDir, paths });

  const rawServiceDef = {
    id: 'mcp_defensive_svc',
    label: 'Safe Label',
    enabled: true,
    binding: { type: 'stdio', executable: 'node' }
  };

  const op = {
    id: 'op-defensive-test',
    registrySnapshot: {
      revision: 1,
      services: [rawServiceDef]
    }
  };

  const adapter = await provider(op, 'mcp_defensive_svc');
  assert.ok(adapter);
  assert.equal(adapter.definition.label, 'Safe Label');

  // Provider's cached definition is frozen and isolated
  assert.ok(Object.isFrozen(adapter.definition));
  assert.throws(() => {
    adapter.definition.label = 'Tampered';
  }, TypeError);
});

after(() => {
  for (const d of createdTempDirs) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch (_) {}
  }
});


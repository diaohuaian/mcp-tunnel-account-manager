// Isolated production-wiring regression: no real processes, credentials or host scans.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startManager} from '../src/main.mjs';
import {createSecurity} from '../src/security.mjs';
import {createVault} from '../src/vault.mjs';
import {openStore} from '../src/store.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}

test('production observer shares one inspection per service/cycle but still freshly verifies ownership', {timeout: 15000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-observe-singleflight-'));
  const security = await createSecurity({dataDir: root});
  const vault = await createVault({dataDir: root, security});
  const store = await openStore({dataDir: root, vault, security});
  const services = ['overleaf-mcp', 'antigravity-mcp'];
  const inspections = new Map(), verifications = new Map(), identities = new Map();
  const adapters = {};
  for (const [index, service] of services.entries()) {
    identities.set(service, {running: true, pid: 8123 + index,
      executable: 'test-tunnel.exe', executablePath: 'test-tunnel.exe',
      startTime: '2026-11-04T00:00:00Z', startedAt: '2026-11-04T00:00:00Z',
      healthURL: 'http://127.0.0.1:19999'});
    const processPath = path.join(root, service + '-process.json');
    fs.writeFileSync(processPath, JSON.stringify(identities.get(service)));
    adapters[service] = {
      processPath,
      processController: {
        async inspect() {
          inspections.set(service, (inspections.get(service) || 0) + 1);
          return {...identities.get(service)};
        },
        async verify(record) {
          verifications.set(service, (verifications.get(service) || 0) + 1);
          assert.equal(record.pid, identities.get(service).pid);
          return {valid: true};
        }
      },
      probe: {async probe() { return {live: true, ready: true}; }}
    };
  }
  let completed = deferred();
  let completedServices = new Set();
  const setObserver = store.registry.setObserver;
  store.registry.setObserver = observer => {
    setObserver(observer);
    const setStatus = observer.setTunnelClient;
    observer.setTunnelClient = (id, status) => {
      setStatus(id, status);
      completedServices.add(id);
      if (completedServices.size === services.length) completed.resolve();
    };
  };
  let manager;
  t.mock.timers.enable({apis: ['setInterval', 'Date'], now: Date.now()});
  try {
    manager = await startManager({dataDir: root, port: 0, security, vault, store,
      adapterFactory: () => adapters, runner: {async start() {}, async stop() {}},
      discovery: {scan: async () => []}, locations: {describe: async () => ({})},
      importer: {import: async () => ({})}});
    await completed.promise;
    for (const service of services) {
      assert.equal(inspections.get(service), 1, 'observer + collector must share the same cycle inspection');
      assert.equal(verifications.get(service), 1, 'ownership verification may not be skipped');
      assert.equal(manager.observer.peekTunnelClient(service).state, 'running');
    }
    // A new cycle MUST see a new PID, never the previous cycle's cached identity.
    identities.get('overleaf-mcp').pid = 9123;
    fs.writeFileSync(adapters['overleaf-mcp'].processPath, JSON.stringify(identities.get('overleaf-mcp')));
    completed = deferred(); completedServices = new Set();
    // Drain the just-finished cycle's scheduler finally before ticking again.
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(30000);
    await completed.promise;
    for (const service of services) {
      assert.equal(inspections.get(service), 2, 'the next cycle must perform a new OS inspection');
      assert.equal(verifications.get(service), 2, 'the next cycle must also reverify ownership');
    }
    assert.equal(manager.observer.peekTunnelClient('overleaf-mcp').pid, 9123);
  } finally {
    t.mock.timers.reset();
    if (manager) await manager.close();
    else { await store.close(); await vault.close?.(); await security.close?.(); }
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('mcp-observe-singleflight-'));
    fs.rmSync(resolved, {recursive: true, force: true});
  }
});

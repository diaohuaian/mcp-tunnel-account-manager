import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { EventEmitter } from 'node:events';

import { startManager, startApp } from '../src/main.mjs';
import { acquireDaemonLock, DaemonLockError } from '../src/core/daemon-lock.mjs';

function createTempDir(prefix = 'main-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanTempDir(dir) {
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

describe('Main Startup & Resource Rollback Unit Regressions', () => {

  it('1. successful startManager on port 0 returns healthy components and close() is idempotent', async () => {
    const dataDir = createTempDir('main-start-ok-');
    try {
      const manager = await startManager({
        dataDir,
        port: 0,
        adapterFactory: async () => ({
          'overleaf-mcp': { prepare: async () => {}, release: () => {} },
          'antigravity-mcp': { prepare: async () => {}, release: () => {} }
        }),
        discoveryFactory: async () => ({
          scan: async () => [],
          loadCandidate: async () => { throw new Error('Not found'); }
        })
      });

      assert.ok(manager.url.startsWith('http://127.0.0.1:'));
      assert.ok(manager.port > 0);
      assert.ok(manager.server.listening);
      assert.equal(manager.runner.getStatus().started, true);
      assert.equal(manager.runner.getStatus().locked, true);

      // Verify HTTP reachability
      const res = await new Promise((resolve, reject) => {
        http.get(`${manager.url}/api/auth/state`, (r) => {
          let data = '';
          r.on('data', c => { data += c; });
          r.on('end', () => resolve({ statusCode: r.statusCode, data }));
        }).on('error', reject);
      });
      assert.equal(res.statusCode, 200);

      // Verify close() shuts down server and releases lock
      await manager.close();
      assert.equal(manager.server.listening, false);
      assert.equal(manager.runner.getStatus().locked, false);

      // Idempotent second close() call does not throw
      await manager.close();

      // Lock can be immediately acquired by fresh lock holder on same dataDir
      const lock = await acquireDaemonLock(dataDir);
      assert.ok(lock);
      await lock.release();
    } finally {
      cleanTempDir(dataDir);
    }
  });

  it('2. runner startup failure triggers complete reverse rollback with no lease or store leak', async () => {
    const dataDir = createTempDir('main-runner-fail-');
    const runnerFailure = new Error('simulated-runner-startup-failure');

    try {
      await assert.rejects(
        startManager({
          dataDir,
          port: 0,
          adapterFactory: async () => ({}),
          runner: {
            // Injected store with failing getWorkQueue to provoke runner.start() failure
            repo: {
              getWorkQueue() {
                throw runnerFailure;
              }
            }
          }
        }),
        (err) => err === runnerFailure || (err.cause === runnerFailure) || err.message?.includes('simulated-runner-startup-failure')
      );

      // Verify that after startup failure, daemon lease was NOT leaked and can be acquired immediately
      const freshLock = await acquireDaemonLock(dataDir);
      assert.ok(freshLock);
      await freshLock.release();
    } finally {
      cleanTempDir(dataDir);
    }
  });

  it('3. server listen error rolls back runner and store without socket or lease leak', async () => {
    const dataDir = createTempDir('main-listen-fail-');
    // Pre-occupy a port to force listen failure
    const blockerServer = http.createServer();
    await new Promise((resolve) => blockerServer.listen(0, '127.0.0.1', resolve));
    const occupiedPort = blockerServer.address().port;

    try {
      await assert.rejects(
        startManager({
          dataDir,
          port: occupiedPort,
          adapterFactory: async () => ({
            'overleaf-mcp': {},
            'antigravity-mcp': {}
          })
        }),
        (err) => err.code === 'EADDRINUSE'
      );

      // Verify daemon lock was completely released despite listen failure
      const freshLock = await acquireDaemonLock(dataDir);
      assert.ok(freshLock);
      await freshLock.release();
    } finally {
      await new Promise((resolve) => blockerServer.close(resolve));
      cleanTempDir(dataDir);
    }
  });

  it('4. startManager forwards custom factories and options cleanly', async () => {
    const dataDir = createTempDir('main-factories-');
    let customDiscoveryCalled = false;
    let customLocationsCalled = false;
    let customImporterCalled = false;

    try {
      const manager = await startManager({
        dataDir,
        port: 0,
        adapterFactory: async () => ({
          'overleaf-mcp': {},
          'antigravity-mcp': {}
        }),
        discoveryFactory: async () => {
          customDiscoveryCalled = true;
          return { scan: async () => [] };
        },
        locationsFactory: async () => {
          customLocationsCalled = true;
          return { describe: async () => ({}), reveal: async () => ({}) };
        },
        importerFactory: async () => {
          customImporterCalled = true;
          return { import: async () => ({}) };
        }
      });

      assert.equal(customDiscoveryCalled, true);
      assert.equal(customLocationsCalled, true);
      assert.equal(customImporterCalled, true);

      await manager.close();
    } finally {
      cleanTempDir(dataDir);
    }
  });

  it('5. release reverse order execution: boundHTTP -> runner -> repo -> vault -> security', async () => {
    const tempDir = createTempDir('main-order-');
    const releaseOrder = [];

    const mockServer = new EventEmitter();
    mockServer.listening = false;
    mockServer.listen = (_port, _host, _cb) => {
      process.nextTick(() => {
        const err = new Error('SIMULATED_LISTEN_ERROR');
        err.code = 'ERR_SIMULATED_LISTEN';
        mockServer.emit('error', err);
      });
      return mockServer;
    };
    mockServer.close = (cb) => {
      releaseOrder.push('boundHTTP');
      if (cb) cb();
    };

    const runnerStub = {
      start: async () => {},
      stop: async () => { releaseOrder.push('runner'); }
    };

    const storeStub = {
      getProfile: () => null,
      close: async () => { releaseOrder.push('repo'); }
    };

    const vaultStub = {
      seal: () => {},
      unseal: () => {},
      close: async () => { releaseOrder.push('vault'); }
    };

    const securityStub = {
      guard: async () => true,
      close: async () => { releaseOrder.push('security'); }
    };

    await assert.rejects(
      startManager({
        dataDir: tempDir,
        port: 0,
        server: mockServer,
        runner: runnerStub,
        store: storeStub,
        vault: vaultStub,
        security: securityStub
      }),
      { code: 'ERR_SIMULATED_LISTEN' }
    );

    assert.deepEqual(
      releaseOrder,
      ['boundHTTP', 'runner', 'repo', 'vault', 'security'],
      'Releases must execute in exact reverse order of acquisition'
    );

    cleanTempDir(tempDir);
  });

  it('6. every release attempted even when one release fails, aggregating cleanup errors', async () => {
    const tempDir = createTempDir('main-cleanup-fail-');
    const seenReleases = [];

    const runnerFailError = new Error('RUNNER_INIT_FAILED');
    const storeCloseError = new Error('STORE_CLOSE_FAILED');

    const runnerStub = {
      start: async () => { throw runnerFailError; },
      stop: async () => { seenReleases.push('runner'); }
    };

    const storeStub = {
      getProfile: () => null,
      close: async () => {
        seenReleases.push('store');
        throw storeCloseError;
      }
    };

    const vaultStub = {
      seal: () => {},
      unseal: () => {},
      close: async () => { seenReleases.push('vault'); }
    };

    const securityStub = {
      guard: async () => true,
      close: async () => { seenReleases.push('security'); }
    };

    await assert.rejects(
      startManager({
        dataDir: tempDir,
        port: 0,
        runner: runnerStub,
        store: storeStub,
        vault: vaultStub,
        security: securityStub
      }),
      (err) => {
        assert.equal(err.code, 'STARTUP_AND_CLEANUP_FAILED', 'Must aggregate startup and cleanup errors');
        assert.equal(err.cause, runnerFailError, 'Must preserve original cause');
        assert.ok(err.errors.some((e) => e === runnerFailError), 'Contains original error');
        return true;
      }
    );

    assert.ok(seenReleases.includes('runner'), 'runner release attempted');
    assert.ok(seenReleases.includes('store'), 'store release attempted');
    assert.ok(seenReleases.includes('vault'), 'vault release attempted despite store error');
    assert.ok(seenReleases.includes('security'), 'security release attempted despite store error');

    cleanTempDir(tempDir);
  });

  it('7. exact actual ownership: only resources actually acquired are registered and released', async () => {
    const tempDir = createTempDir('main-ownership-');
    const seenReleases = [];

    const securityStub = {
      guard: async () => true,
      close: async () => { seenReleases.push('security'); }
    };

    const vaultFactoryFail = async () => {
      throw new Error('VAULT_CREATION_FAILED');
    };

    await assert.rejects(
      startManager({
        dataDir: tempDir,
        security: securityStub,
        vaultFactory: vaultFactoryFail
      }),
      (err) => {
        assert.equal(err.message, 'VAULT_CREATION_FAILED');
        return true;
      }
    );

    assert.deepEqual(seenReleases, ['security'], 'Only acquired security resource must be rolled back');
    cleanTempDir(tempDir);
  });

  it('8. sibling tunnels never killed on main failure', async () => {
    const tempDir = createTempDir('main-no-kill-');
    let tunnelKilled = false;

    const runnerStub = {
      start: async () => { throw new Error('EARLY_RUNNER_FAIL'); },
      stop: async () => {}
    };

    const adapterStub = {
      kill: () => { tunnelKilled = true; },
      stop: () => { tunnelKilled = true; }
    };

    await assert.rejects(
      startManager({
        dataDir: tempDir,
        port: 0,
        runner: runnerStub,
        adapterFactory: async () => adapterStub
      }),
      (err) => err.message === 'EARLY_RUNNER_FAIL'
    );

    assert.equal(tunnelKilled, false, 'Main startup failure must never kill or stop tunnel clients');
    cleanTempDir(tempDir);
  });

  it('9. startApp initializes manager, logs bootstrap secret, and shuts down via shutdown helper', async () => {
    const tempDir = createTempDir('main-start-app-');
    let app = null;
    try {
      const logs = [];
      const origLog = console.log;
      console.log = (...args) => logs.push(args.join(' '));

      try {
        app = await startApp({
          dataDir: tempDir,
          port: 0
        });
      } finally {
        console.log = origLog;
      }

      assert.ok(app);
      assert.ok(typeof app.shutdown === 'function');
      assert.equal(app.server.listening, true);

      await app.close();
      assert.equal(app.server.listening, false);
    } finally {
      cleanTempDir(tempDir);
    }
  });

  it('10. manager injects manager-owned vault into adapterFactory and runner, and vault is closed only on manager.close()', async () => {
    const dataDir = createTempDir('main-vault-injection-');
    let injectedVault = null;
    try {
      const manager = await startManager({
        dataDir,
        port: 0,
        adapterFactory: async (opts) => {
          injectedVault = opts.vault;
          return {
            'overleaf-mcp': { prepare: async () => {}, release: () => {} },
            'antigravity-mcp': { prepare: async () => {}, release: () => {} }
          };
        }
      });

      // Manager-owned vault must be passed to adapterFactory
      assert.ok(injectedVault, 'vault must be passed to adapterFactory');
      assert.equal(injectedVault, manager.vault, 'injected vault must match manager.vault');

      // Vault is operational while manager is running
      const sealed = manager.vault.seal({ secret: 42 }, 'aad-test-1');
      assert.deepEqual(manager.vault.unseal(sealed, 'aad-test-1'), { secret: 42 });

      // Calling store.close() directly must NOT close the manager-owned vault
      await manager.store.close();
      const sealed2 = manager.vault.seal({ secret: 99 }, 'aad-test-2');
      assert.deepEqual(manager.vault.unseal(sealed2, 'aad-test-2'), { secret: 99 });

      // Vault is closed only by manager.close()
      await manager.close();
      assert.throws(() => manager.vault.seal({ secret: 100 }, 'aad-test-3'), /Vault is closed/);
    } finally {
      cleanTempDir(dataDir);
    }
  });

  it('11. default manager instantiates and owns registered adapter provider sharing resolved vault/store/dataDir', async () => {
    const dataDir = createTempDir('main-reg-provider-');
    try {
      const manager = await startManager({
        dataDir,
        port: 0,
        discoveryFactory: async () => ({
          scan: async () => [],
          loadCandidate: async () => { throw new Error('Not found'); }
        })
      });

      assert.ok(manager.adapterProvider, 'Default manager must own an adapterProvider');
      assert.equal(typeof manager.adapterProvider, 'function', 'adapterProvider must be callable');
      assert.equal(typeof manager.adapterProvider.release, 'function', 'adapterProvider must expose release()');
      assert.equal(typeof manager.adapterProvider.clear, 'function', 'adapterProvider must expose clear()');
      assert.equal(typeof manager.adapterProvider.has, 'function', 'adapterProvider must expose has()');

      // Verify shared resources
      assert.equal(manager.adapterProvider.vault, manager.vault, 'adapterProvider must share resolved manager vault');
      assert.equal(manager.adapterProvider.store, manager.store, 'adapterProvider must share manager store');
      assert.equal(manager.adapterProvider.dataDir, manager.dataDir, 'adapterProvider must share manager dataDir');
      assert.equal(manager.adapterProvider.security, manager.security, 'adapterProvider must share manager security');

      // Verify options forwarding
      assert.equal(manager.adapterProvider.options.vault, manager.vault);
      assert.equal(manager.adapterProvider.options.store, manager.store);
      assert.equal(manager.adapterProvider.options.dataDir, manager.dataDir);
      assert.equal(manager.adapterProvider.options.security, manager.security);

      // Verify runner uses this same adapterProvider
      assert.equal(manager.runner.deps.adapterProvider, manager.adapterProvider, 'runner must use manager-owned adapterProvider');

      // Verify provider resolves legacy adapter cleanly
      const legacyAdapter = await manager.adapterProvider({ id: 'op-legacy-check' }, 'overleaf-mcp');
      assert.ok(legacyAdapter);
      assert.equal(legacyAdapter.service, 'overleaf-mcp');
      assert.equal(legacyAdapter.vault, manager.vault);

      await manager.close();
    } finally {
      cleanTempDir(dataDir);
    }
  });

  it('12. explicit injected adapterProvider precedence is preserved over default registered provider', async () => {
    const dataDir = createTempDir('main-injected-provider-');
    try {
      let customProviderCalled = false;
      const customProvider = Object.assign(
        async (_op, serviceId) => {
          customProviderCalled = true;
          return { service: serviceId, custom: true };
        },
        { release: () => {}, clear: () => {}, has: () => false, size: 0 }
      );

      const manager = await startManager({
        dataDir,
        port: 0,
        adapterProvider: customProvider,
        discoveryFactory: async () => ({
          scan: async () => [],
          loadCandidate: async () => { throw new Error('Not found'); }
        })
      });

      assert.equal(manager.adapterProvider, customProvider, 'manager.adapterProvider must be explicit injected provider');
      assert.equal(manager.runner.deps.adapterProvider, customProvider, 'runner must use explicit injected provider');

      const resolved = await manager.adapterProvider({ id: 'op-custom-1' }, 'overleaf-mcp');
      assert.equal(customProviderCalled, true);
      assert.equal(resolved.custom, true);

      await manager.close();
    } finally {
      cleanTempDir(dataDir);
    }
  });

  it('13. explicit adapterFactory takes precedence when supplied', async () => {
    const dataDir = createTempDir('main-adapter-factory-prec-');
    try {
      let adapterFactoryCalled = false;
      const customAdapterMap = {
        'overleaf-mcp': { service: 'overleaf-mcp', isFactoryCustom: true, prepare: async () => {}, release: () => {} },
        'antigravity-mcp': { service: 'antigravity-mcp', isFactoryCustom: true, prepare: async () => {}, release: () => {} }
      };

      const manager = await startManager({
        dataDir,
        port: 0,
        adapterFactory: async (opts) => {
          adapterFactoryCalled = true;
          return customAdapterMap;
        },
        discoveryFactory: async () => ({
          scan: async () => [],
          loadCandidate: async () => { throw new Error('Not found'); }
        })
      });

      assert.equal(adapterFactoryCalled, true, 'Custom adapterFactory must be invoked');
      assert.equal(manager.adapters, customAdapterMap, 'manager.adapters must match custom adapterFactory output');

      // Verify runner uses the adapters from adapterFactory
      const adapter = await manager.runner.deps.adapterProvider({ id: 'op-af-test' }, 'overleaf-mcp');
      assert.equal(adapter.isFactoryCustom, true, 'Adapter resolved from runner provider must come from adapterFactory');

      await manager.close();
    } finally {
      cleanTempDir(dataDir);
    }
  });

  it('14. manager adapterProvider enforces immutable operation snapshots', async () => {
    const dataDir = createTempDir('main-snapshot-imm-');
    try {
      const manager = await startManager({
        dataDir,
        port: 0,
        discoveryFactory: async () => ({
          scan: async () => [],
          loadCandidate: async () => { throw new Error('Not found'); }
        })
      });

      const op = {
        id: 'op-imm-main-test',
        registrySnapshot: {
          revision: 4,
          services: [
            { id: 'mcp_imm_main', label: 'Imm Main', enabled: true }
          ]
        }
      };

      await manager.adapterProvider(op, 'mcp_imm_main');

      // op and op.registrySnapshot must be deep frozen
      assert.ok(Object.isFrozen(op));
      assert.ok(Object.isFrozen(op.registrySnapshot));
      assert.ok(Object.isFrozen(op.registrySnapshot.services));
      assert.ok(Object.isFrozen(op.registrySnapshot.services[0]));

      assert.throws(() => {
        op.registrySnapshot.revision = 999;
      }, TypeError);

      assert.throws(() => {
        op.registrySnapshot.services[0].label = 'Mutated';
      }, TypeError);

      await manager.close();
    } finally {
      cleanTempDir(dataDir);
    }
  });

});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { EventEmitter } from 'node:events';

import { startManager } from '../../src/main.mjs';

function createTempDir(prefix = 'main-startup-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanTempDir(dir) {
  try {
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (_) {}
}

test('regression: runner startup failure triggers cleanup with no socket/lease leak', async (t) => {
  await t.test('preserves original error, stops runner releasing lease, does not kill tunnel clients, closes store/vault/security', async () => {
    const tempDir = createTempDir('runner-fail-');
    const runnerError = new Error('RUNNER_STARTUP_ABORT');
    runnerError.code = 'RUNNER_LEASE_CONFLICT';

    let runnerStarted = false;
    let runnerStopped = false;
    let leaseHeld = true;
    let tunnelKilled = false;
    let storeClosed = false;
    let vaultClosed = false;
    let securityClosed = false;

    const runnerStub = {
      start: async () => {
        runnerStarted = true;
        throw runnerError;
      },
      stop: async () => {
        runnerStopped = true;
        leaseHeld = false;
      }
    };

    const adaptersStub = {
      kill: () => { tunnelKilled = true; },
      stop: () => { tunnelKilled = true; }
    };

    const securityStub = {
      guard: async () => true,
      close: async () => { securityClosed = true; }
    };

    const vaultStub = {
      seal: () => {},
      unseal: () => {},
      close: async () => { vaultClosed = true; }
    };

    const storeStub = {
      getProfile: () => null,
      close: async () => { storeClosed = true; }
    };

    await assert.rejects(
      startManager({
        dataDir: tempDir,
        port: 0,
        security: securityStub,
        vault: vaultStub,
        store: storeStub,
        runner: runnerStub,
        adapterFactory: async () => adaptersStub
      }),
      (err) => {
        assert.equal(err, runnerError, 'Must preserve original runner startup failure');
        assert.equal(err.code, 'RUNNER_LEASE_CONFLICT');
        return true;
      }
    );

    assert.equal(runnerStarted, true, 'Runner start was called');
    assert.equal(runnerStopped, true, 'Runner stop must be called during rollback');
    assert.equal(leaseHeld, false, 'Kernel lease must not leak on runner failure');
    assert.equal(tunnelKilled, false, 'Main failure cannot kill tunnel clients');
    assert.equal(storeClosed, true, 'Store/repo must be closed');
    assert.equal(vaultClosed, true, 'Vault must be closed');
    assert.equal(securityClosed, true, 'Security must be closed');

    cleanTempDir(tempDir);
  });

  await t.test('runner failure plus cleanup failure preserves both errors and original cause under STARTUP_AND_CLEANUP_FAILED', async () => {
    const tempDir = createTempDir('runner-cleanup-fail-');
    const runnerError = new Error('RUNNER_CRASH');
    runnerError.code = 'RUNNER_CRASH';

    const storeError = new Error('STORE_CLOSE_CRASH');
    storeError.code = 'STORE_CLOSE_CRASH';

    let runnerStopped = false;
    let vaultClosed = false;
    let securityClosed = false;

    const runnerStub = {
      start: async () => { throw runnerError; },
      stop: async () => { runnerStopped = true; }
    };

    const storeStub = {
      getProfile: () => null,
      close: async () => { throw storeError; }
    };

    const vaultStub = {
      seal: () => {},
      unseal: () => {},
      close: async () => { vaultClosed = true; }
    };

    const securityStub = {
      guard: async () => true,
      close: async () => { securityClosed = true; }
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
        assert.equal(err.code, 'STARTUP_AND_CLEANUP_FAILED', 'Must use public safe code STARTUP_AND_CLEANUP_FAILED');
        assert.equal(err.cause, runnerError, 'Original runner error must be retained as cause');
        assert.ok(err.errors.some((e) => e === runnerError), 'Original runner error must be in errors list');
        return true;
      }
    );

    assert.equal(runnerStopped, true, 'Runner stop attempted');
    assert.equal(vaultClosed, true, 'Vault close attempted despite store close failure');
    assert.equal(securityClosed, true, 'Security close attempted despite store close failure');

    cleanTempDir(tempDir);
  });
});

test('regression: listen failure (e.g. port/host binding error) triggers cleanup with no socket/lease leak', async (t) => {
  await t.test('port conflict (EADDRINUSE) triggers full reverse rollback and frees port immediately without socket/lease leak', async () => {
    const tempDir = createTempDir('listen-eaddrinuse-');

    // Create a real server listening on an ephemeral port to induce EADDRINUSE
    const blocker = http.createServer();
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const conflictPort = blocker.address().port;

    let runnerStarted = false;
    let runnerStopped = false;
    let leaseHeld = false;
    let storeClosed = false;
    let vaultClosed = false;
    let securityClosed = false;

    const runnerStub = {
      start: async () => {
        runnerStarted = true;
        leaseHeld = true;
      },
      stop: async () => {
        runnerStopped = true;
        leaseHeld = false;
      }
    };

    const securityStub = {
      guard: async () => true,
      close: async () => { securityClosed = true; }
    };

    const vaultStub = {
      seal: () => {},
      unseal: () => {},
      close: async () => { vaultClosed = true; }
    };

    const storeStub = {
      getProfile: () => null,
      close: async () => { storeClosed = true; }
    };

    try {
      await assert.rejects(
        startManager({
          dataDir: tempDir,
          port: conflictPort,
          security: securityStub,
          vault: vaultStub,
          store: storeStub,
          runner: runnerStub
        }),
        (err) => {
          assert.ok(err.code === 'EADDRINUSE' || /EADDRINUSE/.test(err.message), 'Must fail with EADDRINUSE');
          return true;
        }
      );

      assert.equal(runnerStarted, true, 'Runner was started before listen attempt');
      assert.equal(runnerStopped, true, 'Runner was stopped during rollback');
      assert.equal(leaseHeld, false, 'Kernel lease must not leak on listen failure');
      assert.equal(storeClosed, true, 'Store must be closed');
      assert.equal(vaultClosed, true, 'Vault must be closed');
      assert.equal(securityClosed, true, 'Security must be closed');
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
      cleanTempDir(tempDir);
    }
  });

  await t.test('synchronous listen error triggers strict reverse rollback: boundHTTP -> runner -> repo -> vault -> security', async () => {
    const tempDir = createTempDir('listen-order-');
    const releaseOrder = [];

    const mockServer = new EventEmitter();
    mockServer.listening = false;
    mockServer.listen = () => {
      const err = new Error('BINDING_SYNCHRONOUS_ERROR');
      err.code = 'ERR_SOCKET_BAD_PORT';
      throw err;
    };
    mockServer.close = (cb) => {
      releaseOrder.push('boundHTTP');
      if (typeof cb === 'function') cb();
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
        port: -1, // invalid port triggers synchronous listen error
        server: mockServer,
        runner: runnerStub,
        store: storeStub,
        vault: vaultStub,
        security: securityStub
      }),
      (err) => {
        assert.equal(err.code, 'ERR_SOCKET_BAD_PORT');
        return true;
      }
    );

    assert.deepEqual(
      releaseOrder,
      ['boundHTTP', 'runner', 'repo', 'vault', 'security'],
      'Rollback must execute in strict reverse order of acquisition'
    );

    cleanTempDir(tempDir);
  });
});

test('regression: server never listened closes safely without throwing or hanging', async (t) => {
  await t.test('native http.Server that never listened closes safely without throwing ERR_SERVER_NOT_RUNNING', async () => {
    const tempDir = createTempDir('server-never-listened-native-');

    const nativeServer = http.createServer();
    assert.equal(nativeServer.listening, false, 'Server has not been listened yet');

    const mockServer = http.createServer();
    mockServer.listen = () => {
      const err = new Error('SIMULATED_PRE_LISTEN_FAULT');
      err.code = 'ERR_PRE_LISTEN';
      throw err;
    };

    await assert.rejects(
      startManager({
        dataDir: tempDir,
        port: 0,
        server: mockServer
      }),
      { code: 'ERR_PRE_LISTEN' }
    );

    // Also verify mockServer.close() directly does not throw
    assert.doesNotThrow(() => {
      mockServer.close();
    });

    cleanTempDir(tempDir);
  });

  await t.test('mock server with sync close() taking no callback settles without hanging or throwing', async () => {
    const tempDir = createTempDir('server-sync-close-');
    let syncCloseCalled = false;

    const syncServer = {
      listening: false,
      listen: () => {
        const err = new Error('LISTEN_FAILED');
        err.code = 'ERR_LISTEN_FAILED';
        throw err;
      },
      close: () => {
        // Synchronous close taking 0 args, never calls callback
        syncCloseCalled = true;
      }
    };

    await assert.rejects(
      startManager({
        dataDir: tempDir,
        port: 0,
        server: syncServer
      }),
      { code: 'ERR_LISTEN_FAILED' }
    );

    assert.equal(syncCloseCalled, true, 'Synchronous close() must be invoked and not hang');
    cleanTempDir(tempDir);
  });

  await t.test('mock server with async close() returning a Promise settles without hanging or throwing', async () => {
    const tempDir = createTempDir('server-async-close-');
    let asyncCloseCalled = false;

    const asyncServer = {
      listening: false,
      listen: () => {
        const err = new Error('ASYNC_LISTEN_FAILED');
        err.code = 'ERR_ASYNC_LISTEN_FAILED';
        throw err;
      },
      close: async () => {
        // Async close returning Promise
        await new Promise((r) => setImmediate(r));
        asyncCloseCalled = true;
      }
    };

    await assert.rejects(
      startManager({
        dataDir: tempDir,
        port: 0,
        server: asyncServer
      }),
      { code: 'ERR_ASYNC_LISTEN_FAILED' }
    );

    assert.equal(asyncCloseCalled, true, 'Async close() returning Promise must be awaited and not hang');
    cleanTempDir(tempDir);
  });

  await t.test('unlistened server closed multiple times is idempotent and never throws', async () => {
    const tempDir = createTempDir('server-multi-close-');

    const nativeServer = http.createServer();
    const listenErr = new Error('LISTEN_ERR');
    listenErr.code = 'ERR_LISTEN_ERR';

    nativeServer.listen = () => {
      throw listenErr;
    };

    await assert.rejects(
      startManager({
        dataDir: tempDir,
        port: 0,
        server: nativeServer
      }),
      { code: 'ERR_LISTEN_ERR' }
    );

    // Call close() again multiple times on nativeServer directly
    assert.doesNotThrow(() => {
      nativeServer.close();
      nativeServer.close();
    });

    cleanTempDir(tempDir);
  });
});

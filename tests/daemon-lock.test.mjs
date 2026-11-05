import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquireDaemonLock, DaemonLockError } from '../src/core/daemon-lock.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const daemonLockFileUrl = pathToFileURL(path.resolve(__dirname, '../src/core/daemon-lock.mjs')).href;

async function createTempDir(prefix = 'daemon-lock-test-') {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('1. cross-process contention: second acquireDaemonLock on same directory throws LOCK_HELD', async () => {
  const dataDir = await createTempDir('contention-');
  try {
    // Spawn child process to hold the daemon lock
    const childScript = `
      import { acquireDaemonLock } from '${daemonLockFileUrl}';
      const lock = await acquireDaemonLock(${JSON.stringify(dataDir)});
      process.stdout.write('ACQUIRED\\n');
      process.stdin.once('data', async () => {
        await lock.release();
        process.stdout.write('RELEASED\\n');
        process.exit(0);
      });
    `;

    const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
      stdio: ['pipe', 'pipe', 'inherit']
    });

    await new Promise((resolve, reject) => {
      child.stdout.on('data', (data) => {
        if (data.toString().includes('ACQUIRED')) {
          resolve();
        }
      });
      child.once('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`Child exited prematurely with code ${code}`));
        }
      });
      child.once('error', reject);
    });

    // Parent attempts to acquire lock on the same dataDir held by child
    await assert.rejects(
      async () => await acquireDaemonLock(dataDir),
      (err) => {
        assert.ok(err instanceof DaemonLockError);
        assert.equal(err.code, 'LOCK_HELD');
        return true;
      }
    );

    // Tell child to release the lock
    const childExitPromise = new Promise((resolve) => child.once('exit', resolve));
    child.stdin.write('RELEASE\n');
    await childExitPromise;

    // After child process has released lock, parent can now acquire it successfully
    const parentLock = await acquireDaemonLock(dataDir);
    assert.equal(parentLock.held, true);
    await parentLock.release();
    assert.equal(parentLock.held, false);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('2. release / reacquire: after release(), subsequent acquire succeeds', async () => {
  const dataDir = await createTempDir('reacquire-');
  try {
    const lock1 = await acquireDaemonLock(dataDir);
    assert.equal(lock1.held, true);

    // Second acquire without release must throw LOCK_HELD
    await assert.rejects(
      async () => await acquireDaemonLock(dataDir),
      (err) => err instanceof DaemonLockError && err.code === 'LOCK_HELD'
    );

    // Release lock1
    await lock1.release();
    assert.equal(lock1.held, false);

    // Multiple release calls are safe and idempotent
    await lock1.release();
    assert.equal(lock1.held, false);

    // Reacquire lock on same dataDir must succeed
    const lock2 = await acquireDaemonLock(dataDir);
    assert.equal(lock2.held, true);
    await lock2.release();
    assert.equal(lock2.held, false);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('3. path canonical equivalence: different representations of the same path map to same lock/port and contend', async () => {
  const dataDir = await createTempDir('canonical-');
  try {
    const dirCanonical = dataDir;
    const dirWithTrailingSlash = dataDir.endsWith(path.sep) ? dataDir : dataDir + path.sep;
    const dirUpperCased = dataDir.toUpperCase();
    const dirRedundantDot = path.join(dataDir, '.', '..', path.basename(dataDir));

    const lock = await acquireDaemonLock(dirCanonical);
    assert.equal(lock.held, true);

    // All alternative path representations must contend on the same deterministic lease
    await assert.rejects(
      async () => await acquireDaemonLock(dirWithTrailingSlash),
      (err) => err instanceof DaemonLockError && err.code === 'LOCK_HELD'
    );

    if (process.platform === 'win32') {
      await assert.rejects(
        async () => await acquireDaemonLock(dirUpperCased),
        (err) => err instanceof DaemonLockError && err.code === 'LOCK_HELD'
      );
    }

    await assert.rejects(
      async () => await acquireDaemonLock(dirRedundantDot),
      (err) => err instanceof DaemonLockError && err.code === 'LOCK_HELD'
    );

    await lock.release();

    // After release, acquiring via alternative representation succeeds
    const lockAlt = await acquireDaemonLock(dirWithTrailingSlash);
    assert.equal(lockAlt.held, true);
    await lockAlt.release();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

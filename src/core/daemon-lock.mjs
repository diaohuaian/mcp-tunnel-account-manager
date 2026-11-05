import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';

export class DaemonLockError extends Error {
  constructor(message, code = 'LOCK_FAILED') {
    super(message);
    this.name = 'DaemonLockError';
    this.code = code;
  }
}

export function isProcessDead(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  if (pid === process.pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    if (err.code === 'ESRCH') {
      return true;
    }
    return false;
  }
}

export async function acquireDaemonLock(dataDir) {
  if (!dataDir || typeof dataDir !== 'string') {
    throw new DaemonLockError('Invalid dataDir provided for daemon lock', 'INVALID_DATADIR');
  }

  fs.mkdirSync(dataDir, { recursive: true });

  let canonicalRealDataDir = fs.realpathSync(dataDir);
  if (process.platform === 'win32') {
    canonicalRealDataDir = canonicalRealDataDir.toLowerCase();
  }

  const digest = crypto.createHash('sha256').update('mcp-tunnel-manager-lock-v2:' + canonicalRealDataDir).digest();
  const first32bits = digest.readUInt32BE(0);
  const port = 20000 + (first32bits % 25000);

  const server = net.createServer((socket) => {
    socket.destroy();
  });

  await new Promise((resolve, reject) => {
    let settled = false;
    function onError(err) {
      if (settled) return;
      settled = true;
      server.removeListener('listening', onListening);
      if (err.code === 'EADDRINUSE') {
        reject(new DaemonLockError('Lock already held', 'LOCK_HELD'));
      } else {
        reject(new DaemonLockError(`Failed to bind daemon lock server: ${err.message}`, err.code || 'LOCK_FAILED'));
      }
    }

    function onListening() {
      if (settled) return;
      settled = true;
      server.removeListener('error', onError);
      server.on('error', () => {});
      resolve();
    }

    server.once('error', onError);
    server.once('listening', onListening);

    server.listen({
      port,
      host: '127.0.0.1',
      exclusive: true
    });
  });

  const lockPath = path.join(canonicalRealDataDir, 'daemon.lock');
  const nonce = crypto.randomUUID();

  try {
    const metadata = JSON.stringify({
      nonce,
      pid: process.pid,
      port,
      acquiredAt: new Date().toISOString()
    });
    await fsp.writeFile(lockPath, metadata, 'utf8');
  } catch (writeErr) {
    await new Promise((resolve) => server.close(() => resolve()));
    throw new DaemonLockError(`Failed to write lock metadata: ${writeErr.message}`, 'LOCK_IO_ERROR');
  }

  let released = false;

  const lock = {
    dataDir: canonicalRealDataDir,
    lockPath,
    pid: process.pid,
    port,
    nonce,
    server,
    get held() {
      return !released;
    },
    release: async () => {
      if (released) return;
      released = true;
      await new Promise((resolve) => {
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
      });
      try {
        await fsp.unlink(lockPath);
      } catch (err) {
        if (err && err.code !== 'ENOENT') {
          // Ignore ENOENT
        }
      }
    }
  };

  return lock;
}

export async function withDaemonLock(dataDir, fn) {
  const lock = await acquireDaemonLock(dataDir);
  try {
    return await fn(lock);
  } finally {
    await lock.release();
  }
}

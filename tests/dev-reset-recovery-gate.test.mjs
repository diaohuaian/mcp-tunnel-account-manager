/**
 * scripts/dev-reset-recovery-gate.mjs closes a NEEDS_ATTENTION recovery gate on ONE
 * data directory. These cases pin the properties that make it safe to ship:
 *   - dry run never writes;
 *   - --apply clears the gate exactly like store.clearRecoveryState and backs up first;
 *   - it refuses the deployed console's data directory;
 *   - it refuses while a console still owns the directory (unless --force).
 * Everything happens under os.tmpdir(); no real profile, credential or port is used.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const SCRIPT = fileURLToPath(new URL('../scripts/dev-reset-recovery-gate.mjs', import.meta.url));
const TMP_ROOT = fs.realpathSync(os.tmpdir());
const created = [];

after(() => {
  for (const dir of created) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

/** Builds a temp data directory with the product's real schema and one open gate. */
async function makeDataDir({ withManagerDb = true } = {}) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'mcp-gate-test-'));
  created.push(dir);
  if (!withManagerDb) return dir;

  const { openStore } = await import('../src/store.mjs');
  const { createVault } = await import('../src/vault.mjs');
  const vault = createVault({ dataDir: dir });
  const store = openStore({ dataDir: dir, vault });
  await store.close();
  try { vault.close(); } catch (_) {}

  const now = new Date().toISOString();
  const db = new DatabaseSync(path.join(dir, 'manager.db'));
  try {
    db.prepare(`
      INSERT INTO mcp_actions
        (id, service_id, request_fingerprint, state, error_code, sealed_payload, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('act_test_0001', 'overleaf-mcp', 'fingerprint', 'NEEDS_ATTENTION',
      'EXECUTABLE_NOT_FOUND', 'sealed', now, now);
    db.prepare("UPDATE metadata SET value = '1' WHERE key = 'recovery_gated'").run();
    db.prepare("UPDATE metadata SET value = ? WHERE key = 'recovery_reason'").run(
      'Action act_test_0001 ended in NEEDS_ATTENTION: EXECUTABLE_NOT_FOUND'
    );
  } finally {
    db.close();
  }
  return dir;
}

function run(args, env = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
    env: { ...process.env, ...env }
  });
  return { status: result.status, out: `${result.stdout || ''}${result.stderr || ''}` };
}

function readGate(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'manager.db'), { readOnly: true });
  try {
    const gated = db.prepare("SELECT value FROM metadata WHERE key = 'recovery_gated'").get()?.value;
    const state = db.prepare('SELECT state FROM mcp_actions WHERE id = ?').get('act_test_0001')?.state;
    return { gated, state };
  } finally {
    db.close();
  }
}

test('dry run reports the open gate and writes nothing', async () => {
  const dir = await makeDataDir();

  const result = run(['--data-dir', dir]);

  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /gate before: OPEN/);
  assert.match(result.out, /act_test_0001/);
  assert.match(result.out, /dry run/i);
  assert.deepEqual(readGate(dir), { gated: '1', state: 'NEEDS_ATTENTION' });
  // A read-only SQLite open may still create the -wal/-shm side files; what matters is
  // that the dry run writes no backup and mutates no state.
  assert.equal(fs.existsSync(path.join(dir, 'backup')), false, 'dry run must not back up (it writes nothing)');
});

test('--apply clears the gate, rejects the parked action and backs the database up', async () => {
  const dir = await makeDataDir();

  const result = run(['--data-dir', dir, '--apply', '--json']);

  assert.equal(result.status, 0, result.out);
  const report = JSON.parse(result.out);
  assert.equal(report.changed, true);
  assert.equal(report.before.recoveryGated, true);
  assert.equal(report.after.recoveryGated, false);
  assert.equal(report.cleared.clearedActions, 1);
  assert.ok(report.backupFiles.some(f => f.endsWith('.bak')), 'a backup must be written');
  assert.deepEqual(readGate(dir), { gated: '0', state: 'REJECTED' });
});

test('the deployed console data directory is refused', async () => {
  const fakeLocalAppData = fs.mkdtempSync(path.join(TMP_ROOT, 'mcp-gate-localappdata-'));
  created.push(fakeLocalAppData);
  const production = path.join(fakeLocalAppData, 'McpTunnelAccountManager');
  fs.mkdirSync(production, { recursive: true });
  fs.writeFileSync(path.join(production, 'manager.db'), '');

  const result = run(['--data-dir', production, '--apply'], { LOCALAPPDATA: fakeLocalAppData });

  assert.equal(result.status, 2, result.out);
  assert.match(result.out, /production console data directory/i);
});

test('a directory with no manager.db is refused', async () => {
  const dir = await makeDataDir({ withManagerDb: false });

  const result = run(['--data-dir', dir, '--apply']);

  assert.equal(result.status, 2, result.out);
  assert.match(result.out, /no manager\.db/i);
});

test('a console that still owns the directory blocks the repair, --force overrides it', async () => {
  const dir = await makeDataDir();
  fs.writeFileSync(
    path.join(dir, 'daemon.lock'),
    JSON.stringify({ nonce: 'test', pid: process.pid, port: 1, acquiredAt: new Date().toISOString() })
  );

  const refused = run(['--data-dir', dir, '--apply']);
  assert.equal(refused.status, 2, refused.out);
  assert.match(refused.out, /console still owns/i);
  assert.deepEqual(readGate(dir), { gated: '1', state: 'NEEDS_ATTENTION' });

  const forced = run(['--data-dir', dir, '--apply', '--force']);
  assert.equal(forced.status, 0, forced.out);
  assert.deepEqual(readGate(dir), { gated: '0', state: 'REJECTED' });
});

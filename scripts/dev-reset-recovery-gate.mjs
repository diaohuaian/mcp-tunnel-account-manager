#!/usr/bin/env node
/**
 * Closes a safety recovery gate (NEEDS_ATTENTION) on ONE local console data directory.
 *
 * Why this exists: the UI's 「确认恢复」 button only accepts zero-effect fault codes
 * (see decideRecoveryAcknowledgement: NOT_FOUND / *_NOT_FOUND family). A gate opened by
 * a real effect failure — e.g. failure_code EXECUTABLE_NOT_FOUND — is refused with
 * RECOVERY_REQUIRES_REVIEW and stays open forever, blocking every automatic start on
 * that data directory. The operator needs an explicit, auditable path; this is it.
 *
 * It mutates ONLY the SQLite state of one data directory, through the product's own
 * escape hatch (store.clearRecoveryState), so behaviour matches the app:
 *   mcp_actions.state  = 'REJECTED'          (was NEEDS_ATTENTION)
 *   operations.status  = 'REJECTED'          (was NEEDS_ATTENTION)
 *   metadata.recovery_gated = '0', recovery_reason = ''
 *   recovery_gates     = emptied
 *
 * Usage:
 *   node scripts/dev-reset-recovery-gate.mjs                     # dry run on <repo>/data
 *   node scripts/dev-reset-recovery-gate.mjs --apply             # actually clear it
 *   node scripts/dev-reset-recovery-gate.mjs --apply --data-dir D:\path\to\data
 *   node scripts/dev-reset-recovery-gate.mjs --json              # machine-readable
 *
 * Safety:
 *   - default target is THIS checkout's own data/ directory;
 *   - refuses the production data directory (%LOCALAPPDATA%\McpTunnelAccountManager) and
 *     anything under %APPDATA%\tunnel-client;
 *   - refuses while a console still owns that directory (two writers corrupt WAL state);
 *   - backs the SQLite files up before writing;
 *   - dry run by default: nothing is written without --apply;
 *   - never kills a process, never touches tunnel YAML, credentials or keys.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_REFUSED = 2;

const HELP = `Clear a console safety recovery gate (NEEDS_ATTENTION) on one data directory.

  node scripts/dev-reset-recovery-gate.mjs [options]

Options:
  --apply             Write the change. Without it the command only reports.
  --data-dir <path>   Target data directory (default: <repo>/data).
  --force             Proceed even though a console still owns that directory.
  --json              Print one JSON object instead of human-readable lines.
  --help              Show this help.

Exit codes: 0 = done (or nothing to do), 2 = refused by a safety check, 1 = error.`;

function parseArgs(argv) {
  const options = { apply: false, force: false, json: false, help: false, dataDir: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--data-dir') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new UsageError('--data-dir requires a path');
      options.dataDir = value;
      i += 1;
    } else if (arg.startsWith('--data-dir=')) {
      options.dataDir = arg.slice('--data-dir='.length);
    } else {
      throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  return options;
}

class UsageError extends Error {}

/** Refuses the directories that belong to the deployed console, not to a dev copy. */
function assertNotProductionDataDir(dataDir) {
  const normalized = path.resolve(dataDir).replace(/[\\/]+$/, '').toLowerCase();
  const forbidden = [];
  if (process.env.LOCALAPPDATA) {
    forbidden.push({
      what: 'production console data directory',
      dir: path.resolve(process.env.LOCALAPPDATA, 'McpTunnelAccountManager')
    });
  }
  if (process.env.APPDATA) {
    forbidden.push({ what: 'tunnel-client profile directory', dir: path.resolve(process.env.APPDATA, 'tunnel-client') });
  }
  for (const entry of forbidden) {
    const target = entry.dir.replace(/[\\/]+$/, '').toLowerCase();
    if (normalized === target || normalized.startsWith(`${target}${path.sep}`) || normalized.startsWith(`${target}/`)) {
      throw new RefusalError(
        `refusing to touch ${entry.what}: ${path.resolve(dataDir)}. `
        + 'This tool only repairs a self-contained dev copy; the deployed console must be handled by hand.'
      );
    }
  }
}

class RefusalError extends Error {}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/** A console that still holds the directory owns the WAL; writing now would race it. */
function findLiveConsoleOwners(dataDir) {
  const owners = [];
  const lockPath = path.join(dataDir, 'daemon.lock');
  if (fs.existsSync(lockPath)) {
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (isProcessAlive(Number(lock?.pid))) owners.push({ source: 'daemon.lock', pid: Number(lock.pid) });
    } catch (_) { /* an unreadable lock is treated as stale */ }
  }
  let entries = [];
  try { entries = fs.readdirSync(dataDir); } catch (_) { return owners; }
  for (const name of entries) {
    if (!/^console-\d+\.pid\.json$/.test(name)) continue;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
      const pid = Number(record?.processId);
      if (isProcessAlive(pid)) owners.push({ source: name, pid });
    } catch (_) { /* stale pid file */ }
  }
  return owners;
}

function readGateState(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'manager.db'), { readOnly: true });
  try {
    const metadata = (key) => db.prepare('SELECT value FROM metadata WHERE key = ?').get(key)?.value ?? null;
    const tableExists = (name) => Boolean(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
    );
    const actions = tableExists('mcp_actions')
      ? db.prepare("SELECT id, service_id, instance_id, error_code FROM mcp_actions WHERE state = 'NEEDS_ATTENTION'").all()
      : [];
    const operations = tableExists('operations')
      ? db.prepare("SELECT id, status, failure_code, failure_service FROM operations WHERE status = 'NEEDS_ATTENTION'").all()
      : [];
    const instanceGates = tableExists('recovery_gates')
      ? db.prepare('SELECT scope, reason FROM recovery_gates ORDER BY scope').all()
      : [];
    return {
      recoveryGated: metadata('recovery_gated') === '1',
      recoveryReason: metadata('recovery_reason') || '',
      attentionActions: actions,
      attentionOperations: operations,
      instanceGates
    };
  } finally {
    db.close();
  }
}

/** Copies the SQLite files aside before mutating, matching the app's own *.bak habit. */
function backupSqliteFiles(dataDir) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const backupDir = path.join(dataDir, 'backup');
  fs.mkdirSync(backupDir, { recursive: true });
  const written = [];
  for (const suffix of ['manager.db', 'manager.db-wal', 'manager.db-shm']) {
    const source = path.join(dataDir, suffix);
    if (!fs.existsSync(source)) continue;
    const target = path.join(backupDir, `${suffix}.${stamp}.bak`);
    fs.copyFileSync(source, target);
    written.push(target);
  }
  return written;
}

async function clearGate(dataDir) {
  // The product's own store, so the mutation is exactly the one the app would perform.
  const { openStore } = await import('../src/store.mjs');
  const { createVault } = await import('../src/vault.mjs');
  const vault = createVault({ dataDir });
  const store = openStore({ dataDir, vault });
  try {
    const cleared = await store.clearRecoveryState();
    return {
      clearedActions: cleared?.clearedActions ?? 0,
      clearedOperations: cleared?.clearedOperations ?? 0
    };
  } finally {
    try { await store.close(); } catch (_) {}
    try { vault.close(); } catch (_) {}
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${HELP}\n`);
    return EXIT_OK;
  }

  const dataDir = path.resolve(options.dataDir || path.join(PROJECT_ROOT, 'data'));
  const report = { dataDir, apply: options.apply, changed: false };

  assertNotProductionDataDir(dataDir);
  if (!fs.existsSync(path.join(dataDir, 'manager.db'))) {
    throw new RefusalError(`no manager.db in ${dataDir}; nothing to repair`);
  }

  const owners = findLiveConsoleOwners(dataDir);
  if (owners.length > 0) {
    const pids = owners.map(o => `${o.pid} (${o.source})`).join(', ');
    if (!options.force) {
      throw new RefusalError(
        `a console still owns ${dataDir}: ${pids}. Close it first (scripts\\start-manager.ps1 -Stop), `
        + 'then rerun; two writers must not touch the same WAL.'
      );
    }
    report.forcedPastOwners = owners;
  }

  report.before = readGateState(dataDir);
  const gateOpen = report.before.recoveryGated
    || report.before.attentionActions.length > 0
    || report.before.attentionOperations.length > 0
    || report.before.instanceGates.length > 0;
  if (!gateOpen) {
    report.after = report.before;
    report.note = 'no recovery gate is open; nothing to do';
    emit(report, options);
    return EXIT_OK;
  }

  if (!options.apply) {
    report.note = 'dry run: rerun with --apply to clear this gate';
    emit(report, options);
    return EXIT_OK;
  }

  report.backupFiles = backupSqliteFiles(dataDir);
  report.cleared = await clearGate(dataDir);
  report.after = readGateState(dataDir);
  report.changed = true;
  emit(report, options);
  return EXIT_OK;
}

function emit(report, options) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const { dataDir, before, after, cleared, backupFiles, note, forcedPastOwners } = report;
  process.stdout.write(`data directory: ${dataDir}\n`);
  if (forcedPastOwners) {
    process.stdout.write(`WARNING: forced while a console still owned it: ${forcedPastOwners.map(o => o.pid).join(', ')}\n`);
  }
  process.stdout.write(`gate before: ${before.recoveryGated ? 'OPEN' : 'closed'}`
    + `${before.recoveryReason ? ` — ${before.recoveryReason}` : ''}\n`);
  if (before.attentionActions.length) {
    process.stdout.write(`  needs-attention actions: ${before.attentionActions.map(a => a.id).join(', ')}\n`);
  }
  if (before.attentionOperations.length) {
    process.stdout.write(`  needs-attention operations: ${before.attentionOperations.map(o => o.id).join(', ')}\n`);
  }
  if (before.instanceGates.length) {
    process.stdout.write(`  instance gates: ${before.instanceGates.map(g => g.scope).join(', ')}\n`);
  }
  if (note) process.stdout.write(`${note}\n`);
  if (backupFiles?.length) {
    process.stdout.write(`backup written: ${backupFiles.join(', ')}\n`);
  }
  if (cleared) {
    process.stdout.write(`cleared: ${cleared.clearedActions} action(s), ${cleared.clearedOperations} operation(s)\n`);
    process.stdout.write(`gate after: ${after.recoveryGated ? 'OPEN' : 'closed'}\n`);
  }
}

try {
  process.exitCode = await main();
} catch (err) {
  if (err instanceof RefusalError) {
    process.stderr.write(`refused: ${err.message}\n`);
    process.exitCode = EXIT_REFUSED;
  } else if (err instanceof UsageError) {
    process.stderr.write(`${err.message}\n\n${HELP}\n`);
    process.exitCode = EXIT_ERROR;
  } else {
    process.stderr.write(`error: ${err?.stack || err}\n`);
    process.exitCode = EXIT_ERROR;
  }
}

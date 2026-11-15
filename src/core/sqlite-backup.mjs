import fs from 'node:fs';
import path from 'node:path';

/**
 * Copies the SQLite triple (database, WAL, SHM) aside before a state-changing repair.
 *
 * Both the operator CLI (scripts/dev-reset-recovery-gate.mjs) and the guarded
 * POST /api/recovery/reset route write here, so an operator can always step back one
 * step after clearing failure records. The `*.bak` name follows the layout this project
 * already uses under `<dataDir>/backup`.
 *
 * @param {string} dataDir Directory that holds manager.db
 * @param {{ prefix?: string, stamp?: string }} [options]
 * @returns {string[]} absolute paths written (empty when there is no database)
 */
export function backupSqliteFiles(dataDir, options = {}) {
  if (!dataDir || typeof dataDir !== 'string') return [];
  const prefix = options.prefix || 'manager.db';
  const stamp = options.stamp
    || new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const backupDir = path.join(dataDir, 'backup');
  fs.mkdirSync(backupDir, { recursive: true });

  const written = [];
  for (const suffix of [prefix, `${prefix}-wal`, `${prefix}-shm`]) {
    const source = path.join(dataDir, suffix);
    if (!fs.existsSync(source)) continue;
    const target = path.join(backupDir, `${suffix}.${stamp}.bak`);
    fs.copyFileSync(source, target);
    written.push(target);
  }
  return written;
}

export default { backupSqliteFiles };

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { attachRegistry } from './mcp-registry-store.mjs';

export class StoreError extends Error {
  constructor(message, status = 500, code = 'STORE_ERROR') {
    super(message);
    this.name = 'StoreError';
    this.status = status;
    this.statusCode = status;
    this.code = code;
  }
}

export function maskTunnelId(id) {
  if (id === null || id === undefined || id === '') return null;
  const str = String(id);
  if (str.length <= 6) {
    if (str.length <= 2) return '***';
    return `${str[0]}***${str[str.length - 1]}`;
  }
  return `${str.slice(0, 3)}...${str.slice(-4)}`;
}

const DEFAULT_SERVICES = ['overleaf-mcp', 'antigravity-mcp'];

export function openStore(options = {}) {
  const { dataDir, vault } = options;
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const dbPath = path.join(dataDir, 'manager.db');
  const db = new DatabaseSync(dbPath);

  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = FULL;');

  // Schema creation
  db.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      sealed_credentials TEXT NOT NULL,
      services_meta TEXT NOT NULL,
      provenance_identity TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      profile_revision INTEGER,
      targets TEXT NOT NULL,
      expected_revision INTEGER,
      idempotency_key TEXT,
      request_payload TEXT NOT NULL,
      pinned_credentials TEXT NOT NULL,
      sealed_registry_snapshot TEXT,
      status TEXT NOT NULL,
      failure_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_operations_idempotency
      ON operations (idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS operation_steps (
      operation_id TEXT NOT NULL REFERENCES operations(id),
      service_id TEXT NOT NULL,
      sealed_snapshot TEXT,
      may_have_mutated INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'INITIAL',
      failure_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (operation_id, service_id)
    );

    CREATE TABLE IF NOT EXISTS active_profiles (
      service_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id),
      profile_revision INTEGER,
      service_revision INTEGER
    );
  `);

  // Ensure additive column migrations for existing databases
  try {
    db.exec('ALTER TABLE operations ADD COLUMN sealed_registry_snapshot TEXT;');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE active_profiles ADD COLUMN profile_revision INTEGER;');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE active_profiles ADD COLUMN service_revision INTEGER;');
  } catch (_) {}
  try {
    db.exec('ALTER TABLE profiles ADD COLUMN provenance_identity TEXT;');
  } catch (_) {}
  try {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_provenance
        ON profiles (provenance_identity)
        WHERE provenance_identity IS NOT NULL;
    `);
  } catch (_) {}

  // Initialize metadata keys if absent
  db.prepare("INSERT OR IGNORE INTO metadata (key, value) VALUES ('revision', '0')").run();
  db.prepare("INSERT OR IGNORE INTO metadata (key, value) VALUES ('recovery_gated', '0')").run();
  db.prepare("INSERT OR IGNORE INTO metadata (key, value) VALUES ('recovery_reason', '')").run();

  // Write mutex queue serialization
  let writeQueue = Promise.resolve();

  function withWriteTransaction(fn) {
    if (typeof fn !== 'function') {
      return Promise.reject(new TypeError('withWriteTransaction requires a function'));
    }
    const runTx = () => {
      db.exec('BEGIN IMMEDIATE;');
      try {
        const res = fn();
        db.exec('COMMIT;');
        return res;
      } catch (err) {
        try {
          db.exec('ROLLBACK;');
        } catch (_) {}
        throw err;
      }
    };
    const task = writeQueue.then(runTx, runTx);
    writeQueue = task.catch(() => {});
    return task;
  }

  function getRevision() {
    const row = db.prepare("SELECT value FROM metadata WHERE key = 'revision'").get();
    return row ? parseInt(row.value, 10) : 0;
  }

  function getRecoveryState() {
    const row = db.prepare("SELECT value FROM metadata WHERE key = 'recovery_gated'").get();
    const gated = row ? row.value === '1' : false;
    if (!gated) {
      return { gated: false };
    }
    const reasonRow = db.prepare("SELECT value FROM metadata WHERE key = 'recovery_reason'").get();
    return {
      gated: true,
      reason: reasonRow?.value || 'Manual recovery required'
    };
  }

  function resetRecoveryGate() {
    db.prepare("UPDATE metadata SET value = '0' WHERE key = 'recovery_gated'").run();
    db.prepare("UPDATE metadata SET value = '' WHERE key = 'recovery_reason'").run();
  }

  function assertIdle({ excludeActionId, excludeOperationId } = {}) {
    const recovery = getRecoveryState();
    if (recovery.gated) {
      throw new StoreError(`Recovery gate is active: ${recovery.reason}`, 409, 'RECOVERY_GATED');
    }

    let opQuery = `
      SELECT id, status FROM operations
      WHERE status NOT IN ('SUCCEEDED', 'ROLLED_BACK', 'REJECTED')
    `;
    const opParams = [];
    if (excludeOperationId) {
      opQuery += ' AND id != ?';
      opParams.push(excludeOperationId);
    }
    opQuery += " ORDER BY CASE WHEN status = 'NEEDS_ATTENTION' THEN 0 ELSE 1 END ASC LIMIT 1";
    const activeOp = db.prepare(opQuery).get(...opParams);
    if (activeOp) {
      if (activeOp.status === 'NEEDS_ATTENTION') {
        throw new StoreError(`Recovery gate is active: operation ${activeOp.id} needs attention`, 409, 'RECOVERY_GATED');
      }
      throw new StoreError(`Store busy: operation ${activeOp.id} is active (${activeOp.status})`, 409, 'BUSY');
    }

    const hasActionsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mcp_actions'").get();
    if (hasActionsTable) {
      let query = `
        SELECT id, state FROM mcp_actions
        WHERE state NOT IN ('SUCCEEDED', 'REJECTED')
      `;
      const params = [];
      if (excludeActionId) {
        query += ' AND id != ?';
        params.push(excludeActionId);
      }
      query += " ORDER BY CASE WHEN state = 'NEEDS_ATTENTION' THEN 0 ELSE 1 END ASC LIMIT 1";
      const activeAction = db.prepare(query).get(...params);
      if (activeAction) {
        if (activeAction.state === 'NEEDS_ATTENTION') {
          throw new StoreError(`Recovery gate is active: action ${activeAction.id} needs attention`, 409, 'RECOVERY_GATED');
        }
        throw new StoreError(`Store busy: action ${activeAction.id} is active (${activeAction.state})`, 409, 'BUSY');
      }
    }
  }

  // Attach MCP registry
  const registry = attachRegistry({
    db,
    vault,
    withWriteTransaction,
    getGlobalRevision: () => getRevision(),
    bumpGlobalRevision: () => {
      const nextRev = getRevision() + 1;
      db.prepare("UPDATE metadata SET value = ? WHERE key = 'revision'").run(String(nextRev));
      return nextRev;
    },
    assertIdle: ({ excludeActionId } = {}) => assertIdle({ excludeActionId }),
    getServiceRuntime: (serviceId) => {
      if (options?.getServiceRuntime && typeof options.getServiceRuntime === 'function') {
        const rt = options.getServiceRuntime(serviceId);
        if (rt) return rt;
      }
      const row = db.prepare('SELECT profile_id, profile_revision, service_revision FROM active_profiles WHERE service_id = ?').get(serviceId);
      if (!row) {
        return { runtimeState: 'stopped', activeProfileId: null };
      }
      return {
        runtimeState: 'running',
        activeProfileId: row.profile_id,
        activeProfileRevision: row.profile_revision ?? null,
        activeServiceRevision: row.service_revision ?? null
      };
    },
    clearActiveService: (serviceId) => {
      db.prepare('DELETE FROM active_profiles WHERE service_id = ?').run(serviceId);
    }
  });

  function getRegisteredServiceIds() {
    const fromRegistry = registry ? registry.listDefinitions({ includeDeleted: false }).map(d => d.id) : [];
    return Array.from(new Set([...DEFAULT_SERVICES, ...fromRegistry]));
  }

  function formatProfileDTO(row) {
    const meta = JSON.parse(row.services_meta || '{}');
    const services = {};
    const baseServices = getRegisteredServiceIds();

    for (const s of baseServices) {
      if (meta[s]) {
        services[s] = {
          configured: Boolean(meta[s].configured),
          maskedTunnelId: meta[s].maskedTunnelId ?? null,
          hasApiKey: Boolean(meta[s].hasApiKey),
          hasOrganizationId: Boolean(meta[s].hasOrganizationId)
        };
      } else {
        services[s] = {
          configured: false,
          maskedTunnelId: null,
          hasApiKey: false,
          hasOrganizationId: false
        };
      }
    }
    for (const [k, v] of Object.entries(meta)) {
      if (!services[k]) {
        services[k] = {
          configured: Boolean(v.configured),
          maskedTunnelId: v.maskedTunnelId ?? null,
          hasApiKey: Boolean(v.hasApiKey),
          hasOrganizationId: Boolean(v.hasOrganizationId)
        };
      }
    }
    return {
      id: row.id,
      label: row.label,
      revision: row.revision,
      services
    };
  }

  function listProfiles() {
    const rows = db.prepare('SELECT id, label, revision, services_meta FROM profiles ORDER BY id ASC').all();
    return rows.map(formatProfileDTO);
  }

  function getProfile(id) {
    const row = db.prepare('SELECT id, label, revision, services_meta FROM profiles WHERE id = ?').get(id);
    if (!row) return null;
    return formatProfileDTO(row);
  }

  async function createProfile(input, options = {}) {
    const expectedRevision = options.expectedRevision ?? input.expectedRevision;
    const currentRev = getRevision();
    if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== currentRev) {
      throw new StoreError(`Revision conflict: expected ${expectedRevision}, store revision is ${currentRev}`, 409, 'CONFLICT');
    }

    const id = input.id || crypto.randomUUID();
    const existing = db.prepare('SELECT id FROM profiles WHERE id = ?').get(id);
    if (existing) {
      throw new StoreError(`Profile with ID '${id}' already exists`, 409, 'CONFLICT');
    }

    const label = input.label || input.name || id;
    const servicesInput = input.services || input.credentials || {};

    const sealedCreds = {};
    const servicesMeta = {};
    const allServices = new Set([...getRegisteredServiceIds(), ...Object.keys(servicesInput)]);

    for (const s of allServices) {
      const sData = servicesInput[s];
      if (sData && typeof sData === 'object' && Object.keys(sData).length > 0) {
        const tunnelId = sData.tunnelId ?? sData.tunnel_id ?? null;
        const apiKey = sData.apiKey ?? sData.api_key ?? null;
        const organizationId = sData.organizationId ?? sData.organization_id ?? sData.orgId ?? sData.org_id ?? null;
        const hasApiKey = Boolean(apiKey && String(apiKey).trim().length > 0);
        const hasOrganizationId = Boolean(organizationId && String(organizationId).trim().length > 0);
        const configured = true;
        const maskedTunnelId = maskTunnelId(tunnelId);

        const aad = JSON.stringify(['profile', id, 1, s, 'credentials-v2']);
        const sealed = await vault.seal(sData, aad);
        sealedCreds[s] = sealed;
        servicesMeta[s] = {
          configured,
          maskedTunnelId,
          hasApiKey,
          hasOrganizationId
        };
      } else {
        sealedCreds[s] = null;
        servicesMeta[s] = {
          configured: false,
          maskedTunnelId: null,
          hasApiKey: false,
          hasOrganizationId: false
        };
      }
    }

    const now = new Date().toISOString();
    const nextRev = currentRev + 1;

    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare(`
        INSERT INTO profiles (id, label, revision, sealed_credentials, services_meta, created_at, updated_at)
        VALUES (?, ?, 1, ?, ?, ?, ?)
      `).run(id, label, JSON.stringify(sealedCreds), JSON.stringify(servicesMeta), now, now);

      db.prepare("UPDATE metadata SET value = ? WHERE key = 'revision'").run(String(nextRev));
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }

    return formatProfileDTO({
      id,
      label,
      revision: 1,
      services_meta: JSON.stringify(servicesMeta)
    });
  }

  async function patchProfile(id, input, options = {}) {
    const expectedRevision = options.expectedRevision ?? input.expectedRevision;
    const profileRevision = options.profileRevision ?? input.profileRevision;

    const currentGlobalRev = getRevision();
    if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== currentGlobalRev) {
      throw new StoreError(`Revision conflict: expected global revision ${expectedRevision}, store revision is ${currentGlobalRev}`, 409, 'CONFLICT');
    }

    const row = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id);
    if (!row) {
      throw new StoreError(`Profile ${id} not found`, 404, 'NOT_FOUND');
    }

    if (profileRevision !== undefined && profileRevision !== null && profileRevision !== row.revision) {
      throw new StoreError(`Profile revision conflict: expected profile revision ${profileRevision}, profile revision is ${row.revision}`, 409, 'CONFLICT');
    }

    const sealedCreds = JSON.parse(row.sealed_credentials || '{}');
    const servicesMeta = JSON.parse(row.services_meta || '{}');

    let label = row.label;
    if (input.label !== undefined && input.label !== null) {
      label = input.label;
    }

    const nextProfileRev = row.revision + 1;
    const patchServices = input.services || input.credentials;
    if (patchServices && typeof patchServices === 'object') {
      for (const [serviceId, patchData] of Object.entries(patchServices)) {
        if (patchData === null) {
          sealedCreds[serviceId] = null;
          servicesMeta[serviceId] = {
            configured: false,
            maskedTunnelId: null,
            hasApiKey: false,
            hasOrganizationId: false
          };
          continue;
        }

        if (typeof patchData === 'object') {
          let existingCreds = {};
          if (sealedCreds[serviceId]) {
            const currentAad = JSON.stringify(['profile', id, row.revision, serviceId, 'credentials-v2']);
            existingCreds = await vault.unseal(sealedCreds[serviceId], currentAad);
          }

          const hasPatchApiKey = (patchData.apiKey !== undefined || patchData.api_key !== undefined);
          const apiKey = hasPatchApiKey
            ? (patchData.apiKey ?? patchData.api_key)
            : (existingCreds.apiKey ?? existingCreds.api_key ?? null);

          const hasPatchTunnelId = (patchData.tunnelId !== undefined || patchData.tunnel_id !== undefined);
          const tunnelId = hasPatchTunnelId
            ? (patchData.tunnelId ?? patchData.tunnel_id)
            : (existingCreds.tunnelId ?? existingCreds.tunnel_id ?? null);

          const hasPatchOrgId = (patchData.organizationId !== undefined || patchData.organization_id !== undefined || patchData.orgId !== undefined || patchData.org_id !== undefined);
          const organizationId = hasPatchOrgId
            ? (patchData.organizationId ?? patchData.organization_id ?? patchData.orgId ?? patchData.org_id)
            : (existingCreds.organizationId ?? existingCreds.organization_id ?? existingCreds.orgId ?? existingCreds.org_id ?? null);

          const mergedCreds = {
            ...existingCreds,
            ...patchData
          };
          if (apiKey !== undefined && apiKey !== null) mergedCreds.apiKey = apiKey;
          if (tunnelId !== undefined && tunnelId !== null) mergedCreds.tunnelId = tunnelId;
          if (organizationId !== undefined && organizationId !== null) mergedCreds.organizationId = organizationId;

          const nextAad = JSON.stringify(['profile', id, nextProfileRev, serviceId, 'credentials-v2']);
          const sealed = await vault.seal(mergedCreds, nextAad);
          sealedCreds[serviceId] = sealed;

          const hasApiKey = Boolean(apiKey && String(apiKey).trim().length > 0);
          const hasOrganizationId = Boolean(organizationId && String(organizationId).trim().length > 0);

          servicesMeta[serviceId] = {
            configured: true,
            maskedTunnelId: maskTunnelId(tunnelId),
            hasApiKey,
            hasOrganizationId
          };
        }
      }
    }

    // Re-seal all untouched configured services with nextProfileRev
    for (const [serviceId, sealed] of Object.entries(sealedCreds)) {
      if (sealed && (!patchServices || patchServices[serviceId] === undefined)) {
        const oldAad = JSON.stringify(['profile', id, row.revision, serviceId, 'credentials-v2']);
        const creds = await vault.unseal(sealed, oldAad);
        const newAad = JSON.stringify(['profile', id, nextProfileRev, serviceId, 'credentials-v2']);
        sealedCreds[serviceId] = await vault.seal(creds, newAad);
      }
    }

    const nextGlobalRev = currentGlobalRev + 1;
    const now = new Date().toISOString();

    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare(`
        UPDATE profiles
        SET label = ?, revision = ?, sealed_credentials = ?, services_meta = ?, updated_at = ?
        WHERE id = ?
      `).run(label, nextProfileRev, JSON.stringify(sealedCreds), JSON.stringify(servicesMeta), now, id);

      db.prepare("UPDATE metadata SET value = ? WHERE key = 'revision'").run(String(nextGlobalRev));
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }

    return formatProfileDTO({
      id,
      label,
      revision: nextProfileRev,
      services_meta: JSON.stringify(servicesMeta)
    });
  }

  function deleteProfile(id, options = {}) {
    const expectedRevision = options.expectedRevision;
    const profileRevision = options.profileRevision;

    const currentGlobalRev = getRevision();
    if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== currentGlobalRev) {
      throw new StoreError(`Revision conflict: expected global revision ${expectedRevision}, store revision is ${currentGlobalRev}`, 409, 'CONFLICT');
    }

    const row = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id);
    if (!row) {
      throw new StoreError(`Profile ${id} not found`, 404, 'NOT_FOUND');
    }

    if (profileRevision !== undefined && profileRevision !== null && profileRevision !== row.revision) {
      throw new StoreError(`Profile revision conflict: expected profile revision ${profileRevision}, profile revision is ${row.revision}`, 409, 'CONFLICT');
    }

    const activeRows = db.prepare('SELECT service_id FROM active_profiles WHERE profile_id = ?').all(id);
    if (activeRows.length > 0) {
      const services = activeRows.map(r => r.service_id).join(', ');
      throw new StoreError(`Forbidden: profile ${id} is currently active for ${services}`, 409, 'PROFILE_ACTIVE');
    }

    const nextGlobalRev = currentGlobalRev + 1;

    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
      db.prepare("UPDATE metadata SET value = ? WHERE key = 'revision'").run(String(nextGlobalRev));
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }

    return { success: true, id };
  }

  async function importDiscoveredProfile(profileInput, { provenance, mergeProfileId, expectedRevision } = {}) {
    const currentGlobalRev = getRevision();
    if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== currentGlobalRev) {
      throw new StoreError(`Revision conflict: expected global revision ${expectedRevision}, store revision is ${currentGlobalRev}`, 409, 'CONFLICT');
    }

    const provenanceIdentity = provenance?.identity || (typeof provenance === 'string' ? provenance : null);

    if (mergeProfileId) {
      const existing = getProfile(mergeProfileId);
      if (!existing) {
        throw new StoreError(`Merge profile '${mergeProfileId}' not found`, 404, 'NOT_FOUND');
      }
      const updated = await patchProfile(mergeProfileId, profileInput, { expectedRevision });
      return { profile: updated, created: false };
    }

    if (provenanceIdentity) {
      const existingRow = db.prepare('SELECT id FROM profiles WHERE provenance_identity = ?').get(provenanceIdentity);
      if (existingRow) {
        return { profile: getProfile(existingRow.id), created: false };
      }
    }

    const createdProfile = await createProfile(profileInput, { expectedRevision });
    if (provenanceIdentity) {
      db.prepare('UPDATE profiles SET provenance_identity = ? WHERE id = ?').run(provenanceIdentity, createdProfile.id);
    }

    return { profile: getProfile(createdProfile.id), created: true };
  }

  function listServices() {
    const activeRows = db.prepare('SELECT service_id, profile_id FROM active_profiles').all();
    const activeMap = new Map();
    for (const r of activeRows) {
      activeMap.set(r.service_id, r.profile_id);
    }

    const regDefs = registry ? registry.listDefinitions({ includeDeleted: false }) : [];
    const registeredIds = regDefs.map(d => d.id);
    const allServices = Array.from(new Set([...registeredIds, ...DEFAULT_SERVICES, ...activeMap.keys()]));

    const list = [];
    for (const s of allServices) {
      const pid = activeMap.get(s) ?? null;
      const state = {
        service: s,
        serviceId: s,
        activeProfileId: pid,
        profileId: pid
      };
      list.push(state);
      list[s] = state;
    }
    return list;
  }

  function load(operationId) {
    const row = db.prepare('SELECT * FROM operations WHERE id = ?').get(operationId);
    if (!row) return null;

    let registrySnapshot = null;
    if (row.sealed_registry_snapshot) {
      try {
        const sealed = typeof row.sealed_registry_snapshot === 'string'
          ? JSON.parse(row.sealed_registry_snapshot)
          : row.sealed_registry_snapshot;
        const aad = JSON.stringify(['operation', row.id, 'registry-snapshot-v1']);
        registrySnapshot = vault.unseal(sealed, aad);
      } catch (_) {
        registrySnapshot = null;
      }
    }

    return {
      id: row.id,
      profileId: row.profile_id,
      profile_id: row.profile_id,
      profileRevision: row.profile_revision,
      profile_revision: row.profile_revision,
      targets: JSON.parse(row.targets || '[]'),
      expectedRevision: row.expected_revision,
      expected_revision: row.expected_revision,
      status: row.status,
      failureCode: row.failure_code,
      failure_code: row.failure_code,
      idempotencyKey: row.idempotency_key,
      idempotency_key: row.idempotency_key,
      requestPayload: JSON.parse(row.request_payload || '{}'),
      pinnedCredentials: JSON.parse(row.pinned_credentials || '{}'),
      registrySnapshot,
      createdAt: row.created_at,
      created_at: row.created_at,
      updatedAt: row.updated_at,
      updated_at: row.updated_at
    };
  }

  function publicOperation(id) {
    if (registry && typeof registry.isActionId === 'function' && registry.isActionId(id)) {
      return registry.publicAction(id);
    }

    const op = load(id);
    if (!op) {
      throw new StoreError(`Operation ${id} not found`, 404, 'NOT_FOUND');
    }
    return {
      id: op.id,
      profileId: op.profileId,
      profileRevision: op.profileRevision,
      targets: op.targets,
      expectedRevision: op.expectedRevision,
      status: op.status,
      failureCode: op.failureCode || null,
      idempotencyKey: op.idempotencyKey || null,
      createdAt: op.createdAt,
      updatedAt: op.updatedAt
    };
  }

  function createOperation({ profileId, profileRevision, targets, expectedRevision, idempotencyKey }) {
    if (idempotencyKey) {
      const existingOpRow = db.prepare('SELECT * FROM operations WHERE idempotency_key = ?').get(idempotencyKey);
      if (existingOpRow) {
        const existingPayload = JSON.parse(existingOpRow.request_payload);
        const incomingTargets = (Array.isArray(targets) && targets.length > 0 ? [...targets] : ['overleaf-mcp', 'antigravity-mcp']).sort();
        const existingTargets = (Array.isArray(existingPayload.targets) ? [...existingPayload.targets] : []).sort();

        const isSame = (
          existingPayload.profileId === profileId &&
          (profileRevision === undefined || existingPayload.profileRevision === profileRevision) &&
          (expectedRevision === undefined || existingPayload.expectedRevision === expectedRevision) &&
          JSON.stringify(existingTargets) === JSON.stringify(incomingTargets)
        );

        if (isSame) {
          return publicOperation(existingOpRow.id);
        } else {
          throw new StoreError(`Idempotency key '${idempotencyKey}' reused with different request body`, 409, 'IDEMPOTENCY_CONFLICT');
        }
      }
    }

    assertIdle();

    const profileRow = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);
    if (!profileRow) {
      throw new StoreError(`Profile ${profileId} not found`, 404, 'NOT_FOUND');
    }

    if (profileRevision !== undefined && profileRevision !== null && profileRevision !== profileRow.revision) {
      throw new StoreError(`Profile revision conflict: expected ${profileRevision}, profile revision is ${profileRow.revision}`, 409, 'CONFLICT');
    }

    const currentGlobalRev = getRevision();
    if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== currentGlobalRev) {
      throw new StoreError(`Revision conflict: expected ${expectedRevision}, store revision is ${currentGlobalRev}`, 409, 'CONFLICT');
    }

    const finalTargets = Array.isArray(targets) && targets.length > 0 ? targets : ['overleaf-mcp', 'antigravity-mcp'];
    const profileSealed = JSON.parse(profileRow.sealed_credentials || '{}');
    const opId = crypto.randomUUID();
    const pinned = {};

    for (const t of finalTargets) {
      if (profileSealed[t]) {
        const profileAad = JSON.stringify(['profile', profileId, profileRow.revision, t, 'credentials-v2']);
        const unsealed = vault.unseal(profileSealed[t], profileAad);
        const opAad = JSON.stringify(['operation', opId, t, 'credential-v2']);
        pinned[t] = vault.seal(unsealed, opAad);
      } else {
        pinned[t] = null;
      }
    }

    // Pin registry snapshot
    let sealedRegistrySnapshot = null;
    if (registry && typeof registry.snapshot === 'function') {
      const snap = registry.snapshot(finalTargets, currentGlobalRev);
      const snapAad = JSON.stringify(['operation', opId, 'registry-snapshot-v1']);
      sealedRegistrySnapshot = vault.seal(snap, snapAad);
    }

    const now = new Date().toISOString();
    const payloadToStore = {
      profileId,
      profileRevision: profileRevision ?? profileRow.revision,
      targets: finalTargets,
      expectedRevision: expectedRevision ?? currentGlobalRev
    };

    db.prepare(`
      INSERT INTO operations (
        id, profile_id, profile_revision, targets, expected_revision,
        idempotency_key, request_payload, pinned_credentials, sealed_registry_snapshot,
        status, failure_code, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', NULL, ?, ?)
    `).run(
      opId,
      profileId,
      payloadToStore.profileRevision,
      JSON.stringify(finalTargets),
      payloadToStore.expectedRevision,
      idempotencyKey || null,
      JSON.stringify(payloadToStore),
      JSON.stringify(pinned),
      sealedRegistrySnapshot ? JSON.stringify(sealedRegistrySnapshot) : null,
      now,
      now
    );

    return publicOperation(opId);
  }

  function pendingOperationIds() {
    const rows = db.prepare(`
      SELECT id FROM operations
      WHERE status NOT IN ('SUCCEEDED', 'ROLLED_BACK', 'REJECTED', 'NEEDS_ATTENTION')
      ORDER BY CASE WHEN status = 'QUEUED' THEN 1 ELSE 0 END ASC, created_at ASC, id ASC
    `).all();
    return rows.map(r => r.id);
  }

  function loadAction(id) {
    return registry.loadAction(id);
  }

  function isActionId(id) {
    return registry.isActionId(id);
  }

  function transitionAction(id, patch) {
    return registry.transitionAction(id, patch);
  }

  function markActionAttention(id, code) {
    return registry.markActionAttention(id, code);
  }

  function rawCredentials(profileId) {
    const row = db.prepare('SELECT sealed_credentials, revision FROM profiles WHERE id = ?').get(profileId);
    if (!row) return null;
    const sealed = JSON.parse(row.sealed_credentials || '{}');
    const result = {};
    for (const [service, cred] of Object.entries(sealed)) {
      if (!cred) continue;
      const aad = JSON.stringify(['profile', profileId, row.revision, service, 'credentials-v2']);
      result[service] = vault.unseal(cred, aad);
    }
    return result;
  }

  function getWorkQueue() {
    const hasActionsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mcp_actions'").get();
    let rows;
    if (hasActionsTable) {
      rows = db.prepare(`
        SELECT id, created_at, CASE WHEN status = 'QUEUED' THEN 1 ELSE 0 END AS queue_order
        FROM operations
        WHERE status NOT IN ('SUCCEEDED', 'ROLLED_BACK', 'REJECTED', 'NEEDS_ATTENTION')
        UNION ALL
        SELECT id, created_at, CASE WHEN state = 'QUEUED' THEN 1 ELSE 0 END AS queue_order
        FROM mcp_actions
        WHERE state NOT IN ('SUCCEEDED', 'REJECTED', 'NEEDS_ATTENTION')
        ORDER BY queue_order ASC, created_at ASC, id ASC
      `).all();
    } else {
      rows = db.prepare(`
        SELECT id, created_at, CASE WHEN status = 'QUEUED' THEN 1 ELSE 0 END AS queue_order
        FROM operations
        WHERE status NOT IN ('SUCCEEDED', 'ROLLED_BACK', 'REJECTED', 'NEEDS_ATTENTION')
        ORDER BY queue_order ASC, created_at ASC, id ASC
      `).all();
    }
    return rows.map(r => r.id);
  }

  function begin(operationId) {
    db.exec('BEGIN IMMEDIATE;');
    try {
      assertIdle({ excludeOperationId: operationId });

      const opRow = db.prepare('SELECT * FROM operations WHERE id = ?').get(operationId);
      if (!opRow) {
        throw new StoreError(`Operation ${operationId} not found`, 404, 'NOT_FOUND');
      }

      if (opRow.status !== 'QUEUED') {
        throw new StoreError(`Operation ${operationId} cannot begin: current status is ${opRow.status}`, 409, 'INVALID_STATE');
      }

      const otherActive = db.prepare(`
        SELECT id, status FROM operations
        WHERE id != ? AND status NOT IN ('SUCCEEDED', 'ROLLED_BACK', 'REJECTED', 'NEEDS_ATTENTION')
        LIMIT 1
      `).get(operationId);
      if (otherActive) {
        throw new StoreError(`Another operation (${otherActive.id}) is active`, 409, 'BUSY');
      }

      const revRow = db.prepare("SELECT value FROM metadata WHERE key = 'revision'").get();
      const currentGlobalRev = revRow ? parseInt(revRow.value, 10) : 0;
      if (opRow.expected_revision !== null && opRow.expected_revision !== undefined) {
        if (opRow.expected_revision !== currentGlobalRev) {
          throw new StoreError(`Revision conflict: expected global revision ${opRow.expected_revision}, current is ${currentGlobalRev}`, 409, 'CONFLICT');
        }
      }

      const profileRow = db.prepare('SELECT revision FROM profiles WHERE id = ?').get(opRow.profile_id);
      if (!profileRow) {
        throw new StoreError(`Profile ${opRow.profile_id} not found`, 404, 'NOT_FOUND');
      }
      if (opRow.profile_revision !== null && opRow.profile_revision !== undefined) {
        if (opRow.profile_revision !== profileRow.revision) {
          throw new StoreError(`Profile revision conflict: pinned ${opRow.profile_revision}, current is ${profileRow.revision}`, 409, 'CONFLICT');
        }
      }

      const now = new Date().toISOString();
      db.prepare("UPDATE operations SET status = 'PREPARING', updated_at = ? WHERE id = ?")
        .run(now, operationId);

      db.exec('COMMIT;');
      return load(operationId);
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  }

  async function pinnedCredential(operationId, service) {
    const opRow = db.prepare('SELECT pinned_credentials FROM operations WHERE id = ?').get(operationId);
    if (!opRow) {
      throw new StoreError(`Operation ${operationId} not found`, 404, 'NOT_FOUND');
    }
    const pinned = JSON.parse(opRow.pinned_credentials || '{}');
    const sealed = pinned[service];
    if (!sealed) return null;
    const aad = JSON.stringify(['operation', operationId, service, 'credential-v2']);
    return await vault.unseal(sealed, aad);
  }

  async function prepared(operationId, service, snapshot) {
    const aad = JSON.stringify(['operation', operationId, service, 'snapshot-v2']);
    const sealed = await vault.seal(snapshot ?? {}, aad);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO operation_steps (operation_id, service_id, sealed_snapshot, may_have_mutated, state, created_at, updated_at)
      VALUES (?, ?, ?, 0, 'PREPARED', ?, ?)
      ON CONFLICT(operation_id, service_id) DO UPDATE SET
        sealed_snapshot = excluded.sealed_snapshot,
        state = 'PREPARED',
        updated_at = excluded.updated_at
    `).run(operationId, service, JSON.stringify(sealed), now, now);
  }

  function phase(operationId, status, failureCode = null) {
    const now = new Date().toISOString();
    if (failureCode !== null && failureCode !== undefined) {
      db.prepare('UPDATE operations SET status = ?, failure_code = ?, updated_at = ? WHERE id = ?')
        .run(status, failureCode, now, operationId);
    } else {
      db.prepare('UPDATE operations SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, now, operationId);
    }
  }

  function markMayMutate(operationId, service) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO operation_steps (operation_id, service_id, may_have_mutated, state, created_at, updated_at)
      VALUES (?, ?, 1, 'MUTATING', ?, ?)
      ON CONFLICT(operation_id, service_id) DO UPDATE SET
        may_have_mutated = 1,
        updated_at = excluded.updated_at
    `).run(operationId, service, now, now);
  }

  async function unsealSnapshot(operationId, service) {
    const row = db.prepare('SELECT sealed_snapshot FROM operation_steps WHERE operation_id = ? AND service_id = ?')
      .get(operationId, service);
    if (!row || !row.sealed_snapshot) return null;
    const sealed = JSON.parse(row.sealed_snapshot);
    const aad = JSON.stringify(['operation', operationId, service, 'snapshot-v2']);
    return await vault.unseal(sealed, aad);
  }

  function applied(operationId, service) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO operation_steps (operation_id, service_id, state, created_at, updated_at)
      VALUES (?, ?, 'APPLIED', ?, ?)
      ON CONFLICT(operation_id, service_id) DO UPDATE SET
        state = 'APPLIED',
        updated_at = excluded.updated_at
    `).run(operationId, service, now, now);
  }

  function step(operationId, service) {
    const row = db.prepare('SELECT * FROM operation_steps WHERE operation_id = ? AND service_id = ?')
      .get(operationId, service);
    if (!row) return null;
    return {
      operationId: row.operation_id,
      service: row.service_id,
      serviceId: row.service_id,
      mayHaveMutated: Boolean(row.may_have_mutated),
      may_have_mutated: Boolean(row.may_have_mutated),
      state: row.state,
      failureReason: row.failure_reason,
      failure_reason: row.failure_reason,
      hasSnapshot: Boolean(row.sealed_snapshot),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  function restored(operationId, service) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO operation_steps (operation_id, service_id, state, created_at, updated_at)
      VALUES (?, ?, 'RESTORED', ?, ?)
      ON CONFLICT(operation_id, service_id) DO UPDATE SET
        state = 'RESTORED',
        updated_at = excluded.updated_at
    `).run(operationId, service, now, now);
  }

  function restoreFailed(operationId, service, reason) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO operation_steps (operation_id, service_id, state, failure_reason, created_at, updated_at)
      VALUES (?, ?, 'RESTORE_FAILED', ?, ?, ?)
      ON CONFLICT(operation_id, service_id) DO UPDATE SET
        state = 'RESTORE_FAILED',
        failure_reason = excluded.failure_reason,
        updated_at = excluded.updated_at
    `).run(operationId, service, reason, now, now);
  }

  function finishRollback(operationId, terminalStatus) {
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare('UPDATE operations SET status = ?, updated_at = ? WHERE id = ?')
        .run(terminalStatus, now, operationId);

      if (terminalStatus === 'NEEDS_ATTENTION') {
        const op = db.prepare('SELECT failure_code FROM operations WHERE id = ?').get(operationId);
        const reason = `Operation ${operationId} ended in NEEDS_ATTENTION` + (op && op.failure_code ? `: ${op.failure_code}` : '');
        db.prepare("UPDATE metadata SET value = '1' WHERE key = 'recovery_gated'").run();
        db.prepare("UPDATE metadata SET value = ? WHERE key = 'recovery_reason'").run(reason);
      }
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  }

  function commitSuccess(operationId) {
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE;');
    try {
      const op = load(operationId);
      if (!op) {
        throw new StoreError(`Operation ${operationId} not found`, 404, 'NOT_FOUND');
      }

      const targets = op.targets || [];
      const upsertActive = db.prepare(`
        INSERT INTO active_profiles (service_id, profile_id, profile_revision, service_revision)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(service_id) DO UPDATE SET
          profile_id = excluded.profile_id,
          profile_revision = excluded.profile_revision,
          service_revision = excluded.service_revision
      `);

      for (const service of targets) {
        let serviceRev = 1;
        if (op.registrySnapshot && Array.isArray(op.registrySnapshot.services)) {
          const sDef = op.registrySnapshot.services.find(s => s.id === service);
          if (sDef && typeof sDef.revision === 'number') {
            serviceRev = sDef.revision;
          }
        } else if (registry && typeof registry.getDefinition === 'function') {
          const sDef = registry.getDefinition(service);
          if (sDef && typeof sDef.revision === 'number') {
            serviceRev = sDef.revision;
          }
        }
        upsertActive.run(service, op.profileId, op.profileRevision ?? null, serviceRev);
      }

      db.prepare("UPDATE metadata SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'revision'").run();
      db.prepare("UPDATE operations SET status = 'SUCCEEDED', updated_at = ? WHERE id = ?").run(now, operationId);
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  }

  function isActionId(id) {
    if (registry && typeof registry.isActionId === 'function') {
      return registry.isActionId(id);
    }
    return false;
  }

  function loadAction(id) {
    if (registry && typeof registry.loadAction === 'function') {
      return registry.loadAction(id);
    }
    return null;
  }

  async function close() {
    db.close();
  }

  return {
    getRevision,
    listProfiles,
    getProfile,
    createProfile,
    patchProfile,
    deleteProfile,
    importDiscoveredProfile,
    listServices,
    createOperation,
    pendingOperationIds,
    getWorkQueue,
    publicOperation,
    isActionId,
    loadAction,
    getRecoveryState,
    resetRecoveryGate,
    assertIdle,
    withWriteTransaction,
    registry,
    load,
    begin,
    pinnedCredential,
    prepared,
    phase,
    markMayMutate,
    unsealSnapshot,
    applied,
    step,
    restored,
    restoreFailed,
    finishRollback,
    commitSuccess,
    rawCredentials,
    loadAction,
    isActionId,
    transitionAction,
    markActionAttention,
    close
  };
}

export default openStore;

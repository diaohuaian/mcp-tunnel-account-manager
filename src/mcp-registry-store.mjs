import { createHash, randomUUID } from 'node:crypto';
import {
  isMcpServiceId,
  LEGACY_SERVICES,
  orderRegisteredTargets,
  pinRegistrySnapshot,
  removalDecision,
  assertStoppedConnectionReceipt,
  mergeEnvironmentPatch,
  publicEnvironment,
  discoveryIdentity
} from './core/mcp-registry-policy.mjs';
import {
  publicBinding,
  publicUrl,
  isSensitiveName,
  isReservedServiceEnvName,
  isRecord
} from './adapters/mcp-binding.mjs';

export class RegistryStoreError extends Error {
  constructor(message, status = 400, code = 'REGISTRY_ERROR') {
    super(message);
    this.name = 'RegistryStoreError';
    this.status = status;
    this.statusCode = status;
    this.code = code;
  }
}

const sensitiveName = (name) => isSensitiveName(name);

export function maskUrl(rawUrl) {
  try {
    return publicUrl(rawUrl);
  } catch {
    return rawUrl;
  }
}

function validateHttpUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new RegistryStoreError('HTTP URL is required', 400, 'INVALID_URL');
  }
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new RegistryStoreError('Invalid HTTP URL format', 400, 'INVALID_URL');
  }
  if (!['http:', 'https:'].includes(u.protocol)) {
    throw new RegistryStoreError('URL protocol must be http or https', 400, 'INVALID_URL_PROTOCOL');
  }
  if (u.username || u.password) {
    throw new RegistryStoreError('URL userinfo not allowed, use encrypted headers', 400, 'USERINFO_NOT_ALLOWED');
  }
}

function validateExecutable(exe) {
  if (typeof exe !== 'string' || !exe.trim() || exe.includes('\0')) {
    throw new RegistryStoreError('Executable must be a non-empty string', 400, 'INVALID_EXECUTABLE');
  }
}

function validateAndParseArgs(rawArgs) {
  if (rawArgs === undefined || rawArgs === null) return [];
  if (!Array.isArray(rawArgs)) {
    throw new RegistryStoreError('Args must be an array', 400, 'INVALID_ARGS');
  }
  return rawArgs.map(item => {
    if (!item || typeof item.id !== 'string' || !item.id.trim() || item.id.includes('\0')) {
      throw new RegistryStoreError('Arg id must be a non-empty string', 400, 'INVALID_ARG_ID');
    }
    if (typeof item.value !== 'string' || item.value.includes('\0')) {
      throw new RegistryStoreError(`Arg '${item.id}' must have a string value`, 400, 'INVALID_ARG_VALUE');
    }
    const isSecret = sensitiveName(item.id) || item.secret !== false;
    return {
      id: item.id.trim(),
      value: item.value,
      secret: isSecret
    };
  });
}

function validateAndParseHeaders(rawHeaders) {
  if (rawHeaders === undefined || rawHeaders === null) return {};
  if (!isRecord(rawHeaders)) {
    throw new RegistryStoreError('Headers must be a record object', 400, 'INVALID_HTTP_HEADERS');
  }
  const result = {};
  for (const [name, entry] of Object.entries(rawHeaders)) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(name)) {
      throw new RegistryStoreError(`Invalid header name: ${name}`, 400, 'INVALID_HEADER_NAME');
    }
    let value = '';
    let secret = true;
    if (typeof entry === 'object' && entry !== null) {
      if (typeof entry.value !== 'string' || entry.value.includes('\0')) {
        throw new RegistryStoreError(`Header '${name}' must have a string value`, 400, 'INVALID_HEADER_VALUE');
      }
      value = entry.value;
      secret = sensitiveName(name) || entry.secret !== false;
    } else if (typeof entry === 'string') {
      if (entry.includes('\0')) {
        throw new RegistryStoreError(`Header '${name}' contains null byte`, 400, 'INVALID_HEADER_VALUE');
      }
      value = entry;
      secret = sensitiveName(name) || true;
    } else {
      throw new RegistryStoreError(`Header '${name}' has invalid value`, 400, 'INVALID_HEADER_VALUE');
    }
    result[name] = { value, secret };
  }
  return result;
}

function mergeHeadersPatch(previous = {}, patch = []) {
  if (!Array.isArray(patch)) {
    throw new RegistryStoreError('Invalid headers patch', 400, 'INVALID_HEADERS_PATCH');
  }
  const result = structuredClone(previous);
  for (const item of patch) {
    if (!item || typeof item.name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(item.name)) {
      throw new RegistryStoreError('Invalid header name', 400, 'INVALID_HEADER_NAME');
    }
    const name = item.name;
    if (item.op === 'remove') {
      delete result[name];
      continue;
    }
    if (item.value !== undefined) {
      if (typeof item.value !== 'string' || item.value.includes('\0')) {
        throw new RegistryStoreError('Invalid header value', 400, 'INVALID_HEADER_VALUE');
      }
      result[name] = {
        value: item.value,
        secret: sensitiveName(name) || item.secret !== false
      };
    } else if (result[name]) {
      if (item.secret !== undefined) {
        result[name].secret = sensitiveName(name) || item.secret !== false;
      }
    } else {
      throw new RegistryStoreError(`New header '${name}' must have a value`, 400, 'HEADER_VALUE_REQUIRED');
    }
  }
  return result;
}

function mergeHeadersObject(previous = {}, headersObj = {}) {
  if (!isRecord(headersObj)) {
    throw new RegistryStoreError('Headers must be a record object', 400, 'INVALID_HTTP_HEADERS');
  }
  const result = structuredClone(previous);
  for (const [name, entry] of Object.entries(headersObj)) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(name)) {
      throw new RegistryStoreError(`Invalid header name: ${name}`, 400, 'INVALID_HEADER_NAME');
    }
    if (entry === null || entry?.op === 'remove') {
      delete result[name];
      continue;
    }
    if (typeof entry === 'object' && entry !== null) {
      if (entry.value !== undefined) {
        result[name] = {
          value: String(entry.value),
          secret: sensitiveName(name) || entry.secret !== false
        };
      } else if (result[name]) {
        if (entry.secret !== undefined) {
          result[name].secret = sensitiveName(name) || entry.secret !== false;
        }
      } else {
        throw new RegistryStoreError(`New header '${name}' must have a value`, 400, 'HEADER_VALUE_REQUIRED');
      }
    } else {
      result[name] = {
        value: String(entry),
        secret: sensitiveName(name) || true
      };
    }
  }
  return result;
}

function formatPublicBinding(binding) {
  if (!binding || typeof binding !== 'object') return null;
  const pub = publicBinding(binding);
  return pub || { type: String(binding.type) };
}

function formatPublicEnvironment(environment) {
  if (!environment || typeof environment !== 'object') return [];
  if (Array.isArray(environment)) {
    return environment.map(entry => {
      if (!entry || typeof entry !== 'object') return entry;
      const name = entry.name;
      const secret = sensitiveName(name) || entry.secret !== false;
      if (secret) {
        return { name, secret: true, configured: Boolean(entry.configured ?? true) };
      }
      return {
        name,
        secret: false,
        configured: Boolean(entry.configured ?? true),
        ...(entry.value !== undefined ? { value: entry.value } : {})
      };
    });
  }
  return publicEnvironment(environment);
}

function formatPublicLocations(locations) {
  if (!locations || typeof locations !== 'object') return {};
  const safe = {};
  if (locations.sourceConfigPath) safe.sourceConfigPath = String(locations.sourceConfigPath);
  if (locations.effectiveConfigPath !== undefined) safe.effectiveConfigPath = locations.effectiveConfigPath;
  if (locations.installationRoot !== undefined) safe.installationRoot = locations.installationRoot;
  if (locations.executable) safe.executable = String(locations.executable);
  if (locations.cwd) safe.cwd = String(locations.cwd);
  if (locations.managerStorePath) safe.managerStorePath = String(locations.managerStorePath);
  return safe;
}

function formatRuntime(serviceId, serviceRevision, runtime) {
  if (!runtime || typeof runtime !== 'object') {
    return {
      state: 'unknown',
      activeProfileRevision: null,
      activeServiceRevision: null,
      pendingApply: false
    };
  }
  const state = ['running', 'stopped', 'starting', 'not_running', 'never_started'].includes(runtime.state)
    ? (runtime.state === 'starting' || runtime.state === 'running' ? 'running' : 'stopped')
    : (runtime.state || 'unknown');
  const activeProfileRevision = Number.isSafeInteger(runtime.activeProfileRevision)
    ? runtime.activeProfileRevision
    : null;
  const activeServiceRevision = Number.isSafeInteger(runtime.activeServiceRevision)
    ? runtime.activeServiceRevision
    : null;
  const pendingApply = Boolean(
    runtime.pendingApply ||
    (activeServiceRevision !== null && activeServiceRevision !== serviceRevision)
  );
  return {
    state,
    activeProfileRevision,
    activeServiceRevision,
    pendingApply
  };
}

function formatPublicService(row, def, runtime) {
  const isDeleted = Boolean(row.deleted_at);
  const dto = {
    id: row.id,
    label: row.label,
    enabled: Boolean(row.enabled),
    revision: row.revision,
    sortOrder: row.sort_order,
    controlCarrier: Boolean(row.control_carrier),
    binding: formatPublicBinding(def.binding),
    environment: formatPublicEnvironment(def.environment || {}),
    locations: formatPublicLocations(def.locations),
    runtime: formatRuntime(row.id, row.revision, runtime),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
  if (isDeleted) {
    dto.deletedAt = row.deleted_at;
  }
  return dto;
}

function formatPublicAction(row) {
  if (!row) return null;
  return {
    operationId: row.id,
    id: row.id,
    kind: 'stop',
    profileId: null,
    serviceId: row.service_id,
    state: row.state,
    errorCode: row.error_code || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function computeStopFingerprint(serviceId, expectedRevision) {
  const norm = JSON.stringify({
    serviceId: String(serviceId),
    expectedRevision: expectedRevision !== undefined && expectedRevision !== null ? Number(expectedRevision) : null
  });
  return createHash('sha256').update(norm).digest('hex');
}

export function attachRegistry({
  db,
  vault,
  withWriteTransaction,
  getGlobalRevision,
  bumpGlobalRevision,
  assertIdle,
  getServiceRuntime,
  clearActiveService
}) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') {
    throw new TypeError('attachRegistry requires a synchronous SQLite db (node:sqlite DatabaseSync)');
  }
  if (!vault || typeof vault.seal !== 'function' || typeof vault.unseal !== 'function') {
    throw new TypeError('attachRegistry requires a vault instance with seal and unseal methods');
  }

  // Schema creation
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_services (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      revision INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 500,
      control_carrier INTEGER NOT NULL DEFAULT 0,
      sealed_definition TEXT NOT NULL,
      provenance_identity TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_services_provenance
      ON mcp_services(provenance_identity)
      WHERE provenance_identity IS NOT NULL;

    CREATE TABLE IF NOT EXISTS mcp_actions (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL,
      idempotency_key TEXT,
      request_fingerprint TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'QUEUED',
      error_code TEXT,
      sealed_payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_actions_idempotency
      ON mcp_actions(idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR IGNORE INTO metadata (key, value) VALUES ('revision', '0');
    INSERT OR IGNORE INTO metadata (key, value) VALUES ('recovery_gated', '0');
    INSERT OR IGNORE INTO metadata (key, value) VALUES ('recovery_reason', '');
  `);

  // Initial legacy seeding: only seed if absent and never tombstoned
  const now = new Date().toISOString();
  for (const legacy of LEGACY_SERVICES) {
    const existing = db.prepare('SELECT id FROM mcp_services WHERE id = ?').get(legacy.id);
    if (!existing) {
      const def = {
        id: legacy.id,
        label: legacy.id === 'overleaf-mcp' ? 'Overleaf MCP' : 'Antigravity MCP',
        enabled: legacy.enabled !== false,
        revision: 1,
        sortOrder: legacy.sortOrder ?? 500,
        controlCarrier: Boolean(legacy.controlCarrier),
        binding: {
          type: 'stdio',
          executable: legacy.id === 'overleaf-mcp' ? 'node' : 'antigravity-mcp',
          args: []
        },
        environment: {},
        locations: {
          installationRoot: null
        },
        deletedAt: null
      };
      const sealed = vault.seal(def, JSON.stringify(['mcp-service', legacy.id, 1, 'definition-v1']));
      const sealedText = typeof sealed === 'string' ? sealed : JSON.stringify(sealed);
      db.prepare(`
        INSERT INTO mcp_services (
          id, label, enabled, revision, sort_order, control_carrier,
          sealed_definition, provenance_identity, deleted_at, created_at, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?, NULL, NULL, ?, ?)
      `).run(
        def.id,
        def.label,
        def.enabled ? 1 : 0,
        def.sortOrder,
        def.controlCarrier ? 1 : 0,
        sealedText,
        now,
        now
      );
    }
  }

  // Fallbacks for optional callbacks
  const runWriteTransaction = withWriteTransaction || (fn => {
    db.exec('BEGIN IMMEDIATE;');
    try {
      const res = fn();
      db.exec('COMMIT;');
      return Promise.resolve(res);
    } catch (err) {
      try { db.exec('ROLLBACK;'); } catch {}
      return Promise.reject(err);
    }
  });

  const readGlobalRevision = typeof getGlobalRevision === 'function'
    ? getGlobalRevision
    : () => {
        const row = db.prepare("SELECT value FROM metadata WHERE key = 'revision'").get();
        return row ? parseInt(row.value, 10) : 0;
      };

  const incrementGlobalRevision = typeof bumpGlobalRevision === 'function'
    ? bumpGlobalRevision
    : () => {
        const current = readGlobalRevision();
        const next = current + 1;
        db.prepare("UPDATE metadata SET value = ? WHERE key = 'revision'").run(String(next));
        return next;
      };

  const fetchServiceRuntime = typeof getServiceRuntime === 'function'
    ? getServiceRuntime
    : () => null;

  const handleClearActiveService = (serviceId) => {
    if (typeof clearActiveService === 'function') {
      clearActiveService(serviceId);
    }
    try {
      db.prepare('DELETE FROM active_profiles WHERE service_id = ?').run(serviceId);
    } catch {}
  };

  // Synchronous read helpers
  function getDefinition(id, { includeDeleted = false } = {}) {
    if (typeof id !== 'string' || !id) return null;
    const row = db.prepare('SELECT * FROM mcp_services WHERE id = ?').get(id);
    if (!row) return null;
    if (row.deleted_at && !includeDeleted) return null;
    const def = vault.unseal(
      row.sealed_definition,
      JSON.stringify(['mcp-service', row.id, row.revision, 'definition-v1'])
    );
    def.id = row.id;
    def.label = row.label;
    def.enabled = Boolean(row.enabled);
    def.revision = row.revision;
    def.sortOrder = row.sort_order;
    def.controlCarrier = Boolean(row.control_carrier);
    def.deletedAt = row.deleted_at || null;
    return def;
  }

  function listDefinitions({ includeDeleted = false } = {}) {
    const query = includeDeleted
      ? 'SELECT * FROM mcp_services ORDER BY control_carrier ASC, sort_order ASC, id ASC'
      : 'SELECT * FROM mcp_services WHERE deleted_at IS NULL ORDER BY control_carrier ASC, sort_order ASC, id ASC';
    const rows = db.prepare(query).all();
    return rows.map(row => {
      const def = vault.unseal(
        row.sealed_definition,
        JSON.stringify(['mcp-service', row.id, row.revision, 'definition-v1'])
      );
      def.id = row.id;
      def.label = row.label;
      def.enabled = Boolean(row.enabled);
      def.revision = row.revision;
      def.sortOrder = row.sort_order;
      def.controlCarrier = Boolean(row.control_carrier);
      def.deletedAt = row.deleted_at || null;
      return def;
    });
  }

  function listServices({ includeDeleted = false } = {}) {
    const query = includeDeleted
      ? 'SELECT * FROM mcp_services ORDER BY control_carrier ASC, sort_order ASC, id ASC'
      : 'SELECT * FROM mcp_services WHERE deleted_at IS NULL ORDER BY control_carrier ASC, sort_order ASC, id ASC';
    const rows = db.prepare(query).all();
    return rows.map(row => {
      const def = vault.unseal(
        row.sealed_definition,
        JSON.stringify(['mcp-service', row.id, row.revision, 'definition-v1'])
      );
      const rt = fetchServiceRuntime(row.id);
      return formatPublicService(row, def, rt);
    });
  }

  function snapshot(targetIds, expectedRevision) {
    const currentGlobalRev = readGlobalRevision();
    const services = listDefinitions({ includeDeleted: false });
    return pinRegistrySnapshot(targetIds, { services, revision: currentGlobalRev }, expectedRevision);
  }

  // Internal helper to validate and insert a service record (used by create and importDefinition)
  function insertServiceRecord(input, { provenance } = {}) {
    if (!input || typeof input !== 'object') {
      throw new RegistryStoreError('Service input must be an object', 400, 'INVALID_INPUT');
    }

    let id;
    if (input.id) {
      if (!isMcpServiceId(input.id)) {
        throw new RegistryStoreError(`Invalid MCP service ID '${input.id}'`, 400, 'INVALID_MCP_ID');
      }
      const existing = db.prepare('SELECT id FROM mcp_services WHERE id = ?').get(input.id);
      if (existing) {
        throw new RegistryStoreError(`MCP '${input.id}' already exists`, 409, 'MCP_ALREADY_EXISTS');
      }
      id = input.id;
    } else {
      id = 'mcp_' + randomUUID().replace(/-/g, '');
      if (!isMcpServiceId(id)) {
        throw new RegistryStoreError('Failed to generate valid service ID', 500, 'ID_GENERATION_FAILED');
      }
    }

    const label = (input.label && String(input.label).trim()) || id;
    const enabled = input.enabled !== undefined ? Boolean(input.enabled) : true;
    const sortOrder = Number.isSafeInteger(input.sortOrder) ? input.sortOrder : 500;
    const controlCarrier = Boolean(input.controlCarrier);

    // Binding validation
    const rawBinding = input.binding || { type: 'stdio', executable: 'node', args: [] };
    if (typeof rawBinding !== 'object') {
      throw new RegistryStoreError('Binding is required and must be an object', 400, 'INVALID_BINDING');
    }

    let binding;
    if (rawBinding.type === 'stdio') {
      validateExecutable(rawBinding.executable);
      const args = validateAndParseArgs(rawBinding.args);
      binding = {
        type: 'stdio',
        executable: rawBinding.executable.trim(),
        args
      };
      if (rawBinding.cwd && typeof rawBinding.cwd === 'string' && !rawBinding.cwd.includes('\0')) {
        binding.cwd = rawBinding.cwd;
      }
    } else if (rawBinding.type === 'http') {
      validateHttpUrl(rawBinding.url);
      const headers = validateAndParseHeaders(rawBinding.headers);
      binding = {
        type: 'http',
        url: rawBinding.url,
        headers
      };
    } else {
      throw new RegistryStoreError(`Unsupported binding type: ${rawBinding.type}`, 400, 'UNSUPPORTED_BINDING_TYPE');
    }

    // Environment handling
    let environment = {};
    if (Array.isArray(input.environmentPatch)) {
      for (const item of input.environmentPatch) {
        if (item && isReservedServiceEnvName(item.name)) {
          throw new RegistryStoreError(`Reserved environment name: ${item.name}`, 400, 'RESERVED_ENV_NAME');
        }
      }
      environment = mergeEnvironmentPatch({}, input.environmentPatch);
    } else if (Array.isArray(input.environment)) {
      for (const item of input.environment) {
        if (item && isReservedServiceEnvName(item.name)) {
          throw new RegistryStoreError(`Reserved environment name: ${item.name}`, 400, 'RESERVED_ENV_NAME');
        }
      }
      environment = mergeEnvironmentPatch({}, input.environment);
    } else if (input.environment && typeof input.environment === 'object') {
      const patch = Object.entries(input.environment).map(([name, v]) => {
        if (isReservedServiceEnvName(name)) {
          throw new RegistryStoreError(`Reserved environment name: ${name}`, 400, 'RESERVED_ENV_NAME');
        }
        if (typeof v === 'object' && v !== null) {
          return { name, op: 'set', value: v.value ?? '', secret: v.secret };
        }
        return { name, op: 'set', value: String(v) };
      });
      environment = mergeEnvironmentPatch({}, patch);
    }

    const locations = (input.locations && typeof input.locations === 'object')
      ? structuredClone(input.locations)
      : {};

    const prov = provenance || input.provenance || null;
    let provIdentity = null;
    if (prov && prov.identity) {
      if (typeof prov.identity !== 'string' || !prov.identity.trim()) {
        throw new RegistryStoreError('Provenance identity must be a non-empty string', 400, 'INVALID_PROVENANCE');
      }
      const existingProv = db.prepare('SELECT id FROM mcp_services WHERE provenance_identity = ?').get(prov.identity);
      if (existingProv) {
        throw new RegistryStoreError(`Provenance identity '${prov.identity}' already exists`, 409, 'PROVENANCE_CONFLICT');
      }
      provIdentity = prov.identity;
    }

    const def = {
      id,
      label,
      enabled,
      revision: 1,
      sortOrder,
      controlCarrier,
      binding,
      environment,
      locations,
      ...(prov ? { provenance: prov } : {}),
      deletedAt: null
    };

    const sealed = vault.seal(def, JSON.stringify(['mcp-service', id, 1, 'definition-v1']));
    const sealedText = typeof sealed === 'string' ? sealed : JSON.stringify(sealed);
    const createdAt = new Date().toISOString();

    db.prepare(`
      INSERT INTO mcp_services (
        id, label, enabled, revision, sort_order, control_carrier,
        sealed_definition, provenance_identity, deleted_at, created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      id,
      label,
      enabled ? 1 : 0,
      sortOrder,
      controlCarrier ? 1 : 0,
      sealedText,
      provIdentity,
      createdAt,
      createdAt
    );

    const row = {
      id,
      label,
      enabled: enabled ? 1 : 0,
      revision: 1,
      sort_order: sortOrder,
      control_carrier: controlCarrier ? 1 : 0,
      created_at: createdAt,
      updated_at: createdAt,
      deleted_at: null
    };

    return formatPublicService(row, def, fetchServiceRuntime(id));
  }

  // Mutating Registry Methods (Promise-returning via runWriteTransaction)
  async function create(input, options = {}) {
    const expRev = options.expectedRevision ?? input?.expectedRevision;
    const prov = options.provenance ?? input?.provenance;

    return await runWriteTransaction(() => {
      if (expRev !== undefined && expRev !== null) {
        const currentRev = readGlobalRevision();
        if (expRev !== currentRev) {
          throw new RegistryStoreError(`Revision conflict: expected ${expRev}, global revision is ${currentRev}`, 409, 'REVISION_CONFLICT');
        }
      }

      const serviceDTO = insertServiceRecord(input, { provenance: prov });
      incrementGlobalRevision();
      return serviceDTO;
    });
  }

  async function update(id, patch = {}, options = {}) {
    const expRev = options.expectedRevision ?? patch?.expectedRevision;

    return await runWriteTransaction(() => {
      if (expRev !== undefined && expRev !== null) {
        const currentRev = readGlobalRevision();
        if (expRev !== currentRev) {
          throw new RegistryStoreError(`Revision conflict: expected ${expRev}, global revision is ${currentRev}`, 409, 'REVISION_CONFLICT');
        }
      }

      const row = db.prepare('SELECT * FROM mcp_services WHERE id = ?').get(id);
      if (!row || row.deleted_at) {
        throw new RegistryStoreError(`MCP '${id}' not found`, 404, 'MCP_NOT_FOUND');
      }

      const expServiceRev = options.expectedServiceRevision ?? options.serviceRevision ?? patch.expectedServiceRevision ?? patch.serviceRevision;
      if (expServiceRev !== undefined && expServiceRev !== null && expServiceRev !== row.revision) {
        throw new RegistryStoreError(`Service revision conflict: expected ${expServiceRev}, service revision is ${row.revision}`, 409, 'REVISION_CONFLICT');
      }

      const def = vault.unseal(
        row.sealed_definition,
        JSON.stringify(['mcp-service', id, row.revision, 'definition-v1'])
      );

      // Label update
      if (patch.label !== undefined) {
        const l = String(patch.label).trim();
        if (!l) {
          throw new RegistryStoreError('Label cannot be empty', 400, 'INVALID_LABEL');
        }
        def.label = l;
      }

      // Enabled update
      if (patch.enabled !== undefined) {
        def.enabled = Boolean(patch.enabled);
      }

      // Binding update
      if (patch.binding !== undefined) {
        const pb = patch.binding;
        if (!pb || typeof pb !== 'object') {
          throw new RegistryStoreError('Binding must be an object', 400, 'INVALID_BINDING');
        }

        if (def.binding.type === 'stdio') {
          if (pb.type && pb.type !== 'stdio') {
            throw new RegistryStoreError('Cannot change binding type on update', 400, 'INVALID_BINDING_TYPE');
          }
          if (pb.executable !== undefined) {
            validateExecutable(pb.executable);
            def.binding.executable = pb.executable.trim();
          }
          if (pb.cwd !== undefined) {
            if (pb.cwd === null || pb.cwd === '') {
              delete def.binding.cwd;
            } else if (typeof pb.cwd === 'string' && !pb.cwd.includes('\0')) {
              def.binding.cwd = pb.cwd;
            }
          }
          if (pb.args !== undefined) {
            if (!Array.isArray(pb.args)) {
              throw new RegistryStoreError('Args must be an array', 400, 'INVALID_ARGS');
            }
            const existingArgs = Array.isArray(def.binding.args) ? def.binding.args : [];
            const existingMap = new Map(existingArgs.map(a => [a.id, a]));
            const nextArgs = [];
            for (const item of pb.args) {
              if (!item || typeof item.id !== 'string' || !item.id.trim() || item.id.includes('\0')) {
                throw new RegistryStoreError('Arg id must be a non-empty string', 400, 'INVALID_ARG_ID');
              }
              const argId = item.id.trim();
              const match = existingMap.get(argId);
              let value;
              if (item.value !== undefined) {
                if (typeof item.value !== 'string' || item.value.includes('\0')) {
                  throw new RegistryStoreError(`Arg '${argId}' value must be a string`, 400, 'INVALID_ARG_VALUE');
                }
                value = item.value;
              } else if (match) {
                value = match.value;
              } else {
                throw new RegistryStoreError(`New arg '${argId}' must provide a value`, 400, 'ARG_VALUE_REQUIRED');
              }
              const isSecret = sensitiveName(argId) || (item.secret !== undefined ? item.secret !== false : (match ? match.secret !== false : true));
              nextArgs.push({ id: argId, value, secret: isSecret });
            }
            def.binding.args = nextArgs;
          }
        } else if (def.binding.type === 'http') {
          if (pb.type && pb.type !== 'http') {
            throw new RegistryStoreError('Cannot change binding type on update', 400, 'INVALID_BINDING_TYPE');
          }
          if (pb.url !== undefined) {
            validateHttpUrl(pb.url);
            def.binding.url = pb.url;
          }
          if (pb.headersPatch !== undefined) {
            def.binding.headers = mergeHeadersPatch(def.binding.headers || {}, pb.headersPatch);
          } else if (pb.headers !== undefined) {
            if (Array.isArray(pb.headers)) {
              def.binding.headers = mergeHeadersPatch(def.binding.headers || {}, pb.headers);
            } else if (isRecord(pb.headers)) {
              def.binding.headers = mergeHeadersObject(def.binding.headers || {}, pb.headers);
            } else {
              throw new RegistryStoreError('Headers must be a record object', 400, 'INVALID_HTTP_HEADERS');
            }
          }
        }
      }

      // Environment update
      if (patch.environmentPatch !== undefined) {
        if (Array.isArray(patch.environmentPatch)) {
          for (const item of patch.environmentPatch) {
            if (item && isReservedServiceEnvName(item.name)) {
              throw new RegistryStoreError(`Reserved environment name: ${item.name}`, 400, 'RESERVED_ENV_NAME');
            }
          }
        }
        def.environment = mergeEnvironmentPatch(def.environment || {}, patch.environmentPatch);
      } else if (patch.environment !== undefined) {
        if (Array.isArray(patch.environment)) {
          for (const item of patch.environment) {
            if (item && isReservedServiceEnvName(item.name)) {
              throw new RegistryStoreError(`Reserved environment name: ${item.name}`, 400, 'RESERVED_ENV_NAME');
            }
          }
          def.environment = mergeEnvironmentPatch(def.environment || {}, patch.environment);
        } else if (typeof patch.environment === 'object') {
          const p = Object.entries(patch.environment).map(([name, v]) => {
            if (isReservedServiceEnvName(name)) {
              throw new RegistryStoreError(`Reserved environment name: ${name}`, 400, 'RESERVED_ENV_NAME');
            }
            if (v === null || (typeof v === 'object' && v.op === 'remove')) {
              return { name, op: 'remove' };
            }
            if (typeof v === 'object' && v !== null) {
              return { name, op: 'set', value: v.value ?? '', secret: v.secret };
            }
            return { name, op: 'set', value: String(v) };
          });
          def.environment = mergeEnvironmentPatch(def.environment || {}, p);
        }
      }

      // Locations update
      if (patch.locations !== undefined && typeof patch.locations === 'object') {
        def.locations = { ...(def.locations || {}), ...patch.locations };
      }

      const nextRevision = row.revision + 1;
      def.revision = nextRevision;

      const sealed = vault.seal(def, JSON.stringify(['mcp-service', id, nextRevision, 'definition-v1']));
      const sealedText = typeof sealed === 'string' ? sealed : JSON.stringify(sealed);
      const updatedAt = new Date().toISOString();

      db.prepare(`
        UPDATE mcp_services
        SET label = ?, enabled = ?, revision = ?, sealed_definition = ?, updated_at = ?
        WHERE id = ?
      `).run(
        def.label,
        def.enabled ? 1 : 0,
        nextRevision,
        sealedText,
        updatedAt,
        id
      );

      incrementGlobalRevision();

      const updatedRow = {
        ...row,
        label: def.label,
        enabled: def.enabled ? 1 : 0,
        revision: nextRevision,
        updated_at: updatedAt
      };

      return formatPublicService(updatedRow, def, fetchServiceRuntime(id));
    });
  }

  async function remove(id, options = {}) {
    const expRev = options.expectedRevision;

    return await runWriteTransaction(() => {
      if (expRev !== undefined && expRev !== null) {
        const currentRev = readGlobalRevision();
        if (expRev !== currentRev) {
          throw new RegistryStoreError(`Revision conflict: expected ${expRev}, global revision is ${currentRev}`, 409, 'REVISION_CONFLICT');
        }
      }

      const row = db.prepare('SELECT * FROM mcp_services WHERE id = ?').get(id);
      if (!row || row.deleted_at) {
        throw new RegistryStoreError(`MCP '${id}' not found`, 404, 'MCP_NOT_FOUND');
      }

      const def = vault.unseal(
        row.sealed_definition,
        JSON.stringify(['mcp-service', id, row.revision, 'definition-v1'])
      );

      const rt = fetchServiceRuntime(id);
      const runtimeState = rt?.state || 'unknown';

      let busy = false;
      if (typeof assertIdle === 'function') {
        try {
          assertIdle();
        } catch {
          busy = true;
        }
      }
      const activeAction = db.prepare(
        "SELECT 1 FROM mcp_actions WHERE service_id = ? AND state IN ('QUEUED', 'APPLYING')"
      ).get(id);
      if (activeAction) {
        busy = true;
      }

      const decision = removalDecision({ service: def, runtimeState, busy });
      if (!decision.allowed) {
        const status = decision.code === 'MCP_NOT_FOUND' ? 404 : 409;
        throw new RegistryStoreError(decision.code, status, decision.code);
      }

      const now = new Date().toISOString();
      const nextRevision = row.revision + 1;
      def.deletedAt = now;
      def.revision = nextRevision;

      const sealed = vault.seal(def, JSON.stringify(['mcp-service', id, nextRevision, 'definition-v1']));
      const sealedText = typeof sealed === 'string' ? sealed : JSON.stringify(sealed);

      db.prepare(`
        UPDATE mcp_services
        SET deleted_at = ?, revision = ?, sealed_definition = ?, updated_at = ?
        WHERE id = ?
      `).run(now, nextRevision, sealedText, now, id);

      handleClearActiveService(id);
      incrementGlobalRevision();

      return {
        success: true,
        id
      };
    });
  }

  async function importDefinition(input, options = {}) {
    const prov = options.provenance || input?.provenance;
    if (!prov || typeof prov.identity !== 'string' || !prov.identity.trim()) {
      throw new RegistryStoreError('Provenance with non-empty identity required', 400, 'INVALID_PROVENANCE');
    }

    return await runWriteTransaction(() => {
      const existing = db.prepare('SELECT * FROM mcp_services WHERE provenance_identity = ?').get(prov.identity);
      if (existing) {
        const def = vault.unseal(
          existing.sealed_definition,
          JSON.stringify(['mcp-service', existing.id, existing.revision, 'definition-v1'])
        );
        const rt = fetchServiceRuntime(existing.id);
        return {
          service: formatPublicService(existing, def, rt),
          created: false
        };
      }

      const expRev = options.expectedRevision ?? input?.expectedRevision;
      if (expRev !== undefined && expRev !== null) {
        const currentRev = readGlobalRevision();
        if (expRev !== currentRev) {
          throw new RegistryStoreError(`Revision conflict: expected ${expRev}, global revision is ${currentRev}`, 409, 'REVISION_CONFLICT');
        }
      }

      if (input.id) {
        const existingById = db.prepare('SELECT id FROM mcp_services WHERE id = ?').get(input.id);
        if (existingById) {
          throw new RegistryStoreError(`Service '${input.id}' already exists and cannot be overwritten by import`, 409, 'CONFLICT');
        }
      }

      const serviceDTO = insertServiceRecord(input, { provenance: prov });
      incrementGlobalRevision();

      return {
        service: serviceDTO,
        created: true
      };
    });
  }

  // Stop Actions
  async function createStopAction({ serviceId, expectedRevision, idempotencyKey } = {}) {
    if (!isMcpServiceId(serviceId)) {
      throw new RegistryStoreError(`Invalid service ID '${serviceId}'`, 400, 'INVALID_MCP_ID');
    }

    const fingerprint = computeStopFingerprint(serviceId, expectedRevision);

    return await runWriteTransaction(() => {
      // 1. Idempotency check before busy/revision
      if (idempotencyKey) {
        const existing = db.prepare('SELECT * FROM mcp_actions WHERE idempotency_key = ?').get(idempotencyKey);
        if (existing) {
          if (existing.request_fingerprint !== fingerprint) {
            throw new RegistryStoreError('Idempotency key collision with different request payload', 409, 'IDEMPOTENCY_CONFLICT');
          }
          return formatPublicAction(existing);
        }
      }

      // 2. Busy check
      if (typeof assertIdle === 'function') {
        assertIdle();
      }

      // 3. Revision check
      const currentGlobalRev = readGlobalRevision();
      if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== currentGlobalRev) {
        throw new RegistryStoreError(`Revision conflict: expected ${expectedRevision}, global revision is ${currentGlobalRev}`, 409, 'REVISION_CONFLICT');
      }

      // 4. Verify service exists and is not deleted
      const serviceRow = db.prepare('SELECT * FROM mcp_services WHERE id = ?').get(serviceId);
      if (!serviceRow || serviceRow.deleted_at) {
        throw new RegistryStoreError(`Service '${serviceId}' not found`, 404, 'MCP_NOT_FOUND');
      }

      const serviceDef = vault.unseal(
        serviceRow.sealed_definition,
        JSON.stringify(['mcp-service', serviceId, serviceRow.revision, 'definition-v1'])
      );

      // Verify target valid for stop
      orderRegisteredTargets([serviceId], [serviceDef], { mode: 'stop' });

      const registrySnapshot = {
        revision: currentGlobalRev,
        services: [structuredClone(serviceDef)]
      };

      const originalRuntime = fetchServiceRuntime(serviceId) || null;
      const actionId = 'act_' + randomUUID().replace(/-/g, '');

      const sealedPayload = vault.seal(
        { registrySnapshot, originalRuntime, operationId: actionId, serviceId },
        JSON.stringify(['mcp-action', actionId, serviceId, 'stop-v1'])
      );
      const sealedPayloadText = typeof sealedPayload === 'string' ? sealedPayload : JSON.stringify(sealedPayload);

      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO mcp_actions (
          id, service_id, idempotency_key, request_fingerprint,
          state, error_code, sealed_payload, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'QUEUED', NULL, ?, ?, ?)
      `).run(
        actionId,
        serviceId,
        idempotencyKey || null,
        fingerprint,
        sealedPayloadText,
        now,
        now
      );

      return {
        operationId: actionId,
        id: actionId,
        kind: 'stop',
        profileId: null,
        serviceId,
        state: 'QUEUED',
        errorCode: null,
        createdAt: now,
        updatedAt: now
      };
    });
  }

  function listPendingActionIds() {
    const rows = db.prepare(
      "SELECT id FROM mcp_actions WHERE state IN ('QUEUED', 'APPLYING') ORDER BY created_at ASC, id ASC"
    ).all();
    return rows.map(r => r.id);
  }

  function isActionId(id) {
    if (typeof id !== 'string' || !id) return false;
    if (/^act_[a-z0-9_-]{1,64}$/i.test(id)) return true;
    const row = db.prepare('SELECT 1 FROM mcp_actions WHERE id = ?').get(id);
    return Boolean(row);
  }

  function loadAction(id) {
    if (typeof id !== 'string' || !id) return null;
    const row = db.prepare('SELECT * FROM mcp_actions WHERE id = ?').get(id);
    if (!row) return null;
    const payload = vault.unseal(
      row.sealed_payload,
      JSON.stringify(['mcp-action', id, row.service_id, 'stop-v1'])
    );
    return {
      operationId: row.id,
      id: row.id,
      kind: 'stop',
      profileId: null,
      serviceId: row.service_id,
      state: row.state,
      errorCode: row.error_code || null,
      registrySnapshot: payload.registrySnapshot,
      originalRuntime: payload.originalRuntime,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  function publicAction(id) {
    if (typeof id !== 'string' || !id) return null;
    const row = db.prepare('SELECT * FROM mcp_actions WHERE id = ?').get(id);
    if (!row) return null;
    return formatPublicAction(row);
  }

  async function transitionAction(id, patch = {}) {
    return await runWriteTransaction(() => {
      const row = db.prepare('SELECT * FROM mcp_actions WHERE id = ?').get(id);
      if (!row) {
        throw new RegistryStoreError(`Action '${id}' not found`, 404, 'ACTION_NOT_FOUND');
      }
      const VALID_STATES = new Set(['QUEUED', 'APPLYING', 'SUCCEEDED', 'REJECTED', 'NEEDS_ATTENTION']);
      if (patch.state && !VALID_STATES.has(patch.state)) {
        throw new RegistryStoreError(`Invalid action state: ${patch.state}`, 400, 'INVALID_ACTION_STATE');
      }
      const nextState = patch.state || row.state;
      let nextErrorCode = row.error_code;
      if (patch.errorCode !== undefined) {
        nextErrorCode = patch.errorCode ? String(patch.errorCode) : null;
      }
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE mcp_actions
        SET state = ?, error_code = ?, updated_at = ?
        WHERE id = ?
      `).run(nextState, nextErrorCode, now, id);

      return {
        operationId: row.id,
        id: row.id,
        kind: 'stop',
        profileId: null,
        serviceId: row.service_id,
        state: nextState,
        errorCode: nextErrorCode,
        createdAt: row.created_at,
        updatedAt: now
      };
    });
  }

  async function finishStoppedAction(id, receipt) {
    return await runWriteTransaction(() => {
      const row = db.prepare('SELECT * FROM mcp_actions WHERE id = ?').get(id);
      if (!row) {
        throw new RegistryStoreError(`Action '${id}' not found`, 404, 'ACTION_NOT_FOUND');
      }
      assertStoppedConnectionReceipt(receipt, id, row.service_id);
      handleClearActiveService(row.service_id);

      const now = new Date().toISOString();
      db.prepare(`
        UPDATE mcp_actions
        SET state = 'SUCCEEDED', error_code = NULL, updated_at = ?
        WHERE id = ?
      `).run(now, id);

      incrementGlobalRevision();

      return {
        operationId: row.id,
        id: row.id,
        kind: 'stop',
        profileId: null,
        serviceId: row.service_id,
        state: 'SUCCEEDED',
        errorCode: null,
        createdAt: row.created_at,
        updatedAt: now
      };
    });
  }

  async function markActionAttention(id, safeCode) {
    return await runWriteTransaction(() => {
      const row = db.prepare('SELECT * FROM mcp_actions WHERE id = ?').get(id);
      if (!row) {
        throw new RegistryStoreError(`Action '${id}' not found`, 404, 'ACTION_NOT_FOUND');
      }
      const code = String(safeCode || 'STOP_ACTION_FAILED');
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE mcp_actions
        SET state = 'NEEDS_ATTENTION', error_code = ?, updated_at = ?
        WHERE id = ?
      `).run(code, now, id);

      const reason = `Action ${id} ended in NEEDS_ATTENTION: ${code}`;
      try {
        db.prepare("UPDATE metadata SET value = '1' WHERE key = 'recovery_gated'").run();
        db.prepare("UPDATE metadata SET value = ? WHERE key = 'recovery_reason'").run(reason);
      } catch {}

      return {
        operationId: row.id,
        id: row.id,
        kind: 'stop',
        profileId: null,
        serviceId: row.service_id,
        state: 'NEEDS_ATTENTION',
        errorCode: code,
        createdAt: row.created_at,
        updatedAt: now
      };
    });
  }

  return {
    listServices,
    listDefinitions,
    getDefinition,
    create,
    update,
    remove,
    snapshot,
    importDefinition,
    createStopAction,
    listPendingActionIds,
    isActionId,
    loadAction,
    publicAction,
    transitionAction,
    finishStoppedAction,
    markActionAttention
  };
}

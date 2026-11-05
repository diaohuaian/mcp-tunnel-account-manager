import crypto from 'node:crypto';
import {
  LEGACY_SERVICES,
  isMcpServiceId,
  pinRegistrySnapshot,
  removalDecision,
  assertStoppedConnectionReceipt,
  mergeEnvironmentPatch,
  publicEnvironment,
  RegistryPolicyFault
} from '../../src/core/mcp-registry-policy.mjs';

function sha256(data) {
  const content = typeof data === 'string' ? data : JSON.stringify(data);
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function formatPublicServiceDTO(def) {
  if (!def) return null;

  // Mask binding secrets
  let publicBinding = null;
  if (def.binding) {
    if (def.binding.type === 'stdio') {
      publicBinding = {
        type: 'stdio',
        executable: def.binding.executable,
        cwd: def.binding.cwd || null,
        args: Array.isArray(def.binding.args)
          ? def.binding.args.map((a, i) => {
              const argId = a.id || `arg_${i}`;
              const secret = a.secret !== false;
              if (secret) {
                return { id: argId, secret: true, configured: true };
              }
              return { id: argId, secret: false, configured: true, value: a.value };
            })
          : []
      };
    } else if (def.binding.type === 'http') {
      const publicHeaders = {};
      if (def.binding.headers) {
        for (const [k, v] of Object.entries(def.binding.headers)) {
          const secret = v?.secret !== false;
          if (secret) {
            publicHeaders[k] = { secret: true, configured: true };
          } else {
            publicHeaders[k] = { secret: false, configured: true, value: v?.value };
          }
        }
      }
      publicBinding = {
        type: 'http',
        url: def.binding.url,
        headers: publicHeaders
      };
    }
  }

  return {
    id: def.id,
    label: def.label,
    enabled: def.enabled !== false,
    revision: def.revision || 1,
    sortOrder: def.sortOrder ?? 500,
    controlCarrier: Boolean(def.controlCarrier),
    binding: publicBinding,
    environment: publicEnvironment(def.environment || {}),
    locations: def.locations || null,
    provenance: def.provenance || null,
    deletedAt: def.deletedAt || null
  };
}

export function attachRegistry({
  db,
  vault,
  withWriteTransaction,
  getGlobalRevision,
  bumpGlobalRevision,
  assertIdle = () => true,
  getServiceRuntime = () => ({ state: 'stopped' }),
  clearActiveService = () => {}
}) {
  // Ensure table mcp_definitions exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_definitions (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      revision INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 500,
      control_carrier INTEGER NOT NULL DEFAULT 0,
      sealed_definition TEXT NOT NULL,
      provenance_identity TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_definitions_provenance
      ON mcp_definitions(provenance_identity)
      WHERE provenance_identity IS NOT NULL AND deleted_at IS NULL;

    CREATE TABLE IF NOT EXISTS mcp_actions (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'QUEUED',
      idempotency_key TEXT,
      request_fingerprint TEXT NOT NULL,
      sealed_payload TEXT NOT NULL,
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_actions_idempotency
      ON mcp_actions(idempotency_key)
      WHERE idempotency_key IS NOT NULL;
  `);

  try {
    db.exec("ALTER TABLE mcp_actions ADD COLUMN sealed_payload TEXT;");
  } catch (_) {}

  function unsealDefinition(row) {
    if (!row) return null;
    const aad = JSON.stringify(['mcp-service', row.id, row.revision, 'definition-v1']);
    try {
      let envelope = row.sealed_definition;
      try {
        envelope = JSON.parse(row.sealed_definition);
      } catch (_) {}
      const def = vault.unseal(envelope, aad);
      if (typeof def === 'string') return JSON.parse(def);
      return def;
    } catch {
      return null;
    }
  }

  function sealDefinition(def) {
    const aad = JSON.stringify(['mcp-service', def.id, def.revision, 'definition-v1']);
    const sealed = vault.seal(def, aad);
    return typeof sealed === 'string' ? sealed : JSON.stringify(sealed);
  }

  // Seed legacy 2 services if not existing and never deleted
  function seedLegacyServices() {
    const nowIso = new Date().toISOString();
    for (const legacy of LEGACY_SERVICES) {
      const existing = db.prepare('SELECT id, deleted_at FROM mcp_definitions WHERE id = ?').get(legacy.id);
      if (!existing) {
        const def = {
          id: legacy.id,
          label: legacy.id === 'overleaf-mcp' ? 'Overleaf MCP' : 'Antigravity MCP',
          enabled: true,
          revision: 1,
          sortOrder: legacy.sortOrder,
          controlCarrier: Boolean(legacy.controlCarrier),
          binding: {
            type: 'stdio',
            executable: 'node',
            args: legacy.id === 'overleaf-mcp'
              ? [{ id: 'a1', value: 'server.js', secret: false }]
              : [{ id: 'a1', value: 'antigravity-mcp', secret: false }],
            cwd: null
          },
          environment: {},
          locations: null,
          deletedAt: null
        };
        const sealed = sealDefinition(def);
        db.prepare(`
          INSERT INTO mcp_definitions (id, label, enabled, revision, sort_order, control_carrier, sealed_definition, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          def.id,
          def.label,
          def.enabled ? 1 : 0,
          def.revision,
          def.sortOrder,
          def.controlCarrier ? 1 : 0,
          sealed,
          nowIso,
          nowIso
        );
      }
    }
  }

  seedLegacyServices();

  function listDefinitions({ includeDeleted = false } = {}) {
    const query = includeDeleted
      ? 'SELECT * FROM mcp_definitions ORDER BY control_carrier DESC, sort_order ASC, id ASC'
      : 'SELECT * FROM mcp_definitions WHERE deleted_at IS NULL ORDER BY control_carrier DESC, sort_order ASC, id ASC';
    const rows = db.prepare(query).all();
    return rows.map(r => unsealDefinition(r)).filter(Boolean);
  }

  function listServices({ includeDeleted = false } = {}) {
    const defs = listDefinitions({ includeDeleted });
    return defs.map(formatPublicServiceDTO);
  }

  function getDefinition(id, { includeDeleted = false } = {}) {
    const query = includeDeleted
      ? 'SELECT * FROM mcp_definitions WHERE id = ?'
      : 'SELECT * FROM mcp_definitions WHERE id = ? AND deleted_at IS NULL';
    const row = db.prepare(query).get(id);
    return row ? unsealDefinition(row) : null;
  }

  async function create(input, { expectedRevision, provenance } = {}) {
    return withWriteTransaction(() => {
      const currentGlobalRev = getGlobalRevision();
      if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== currentGlobalRev) {
        throw new RegistryPolicyFault('REVISION_CONFLICT', 409);
      }

      const id = input.id || `mcp_${crypto.randomUUID().replace(/-/g, '')}`;
      if (!isMcpServiceId(id)) {
        throw new RegistryPolicyFault('INVALID_TARGETS', 400);
      }

      const existing = db.prepare('SELECT id, deleted_at FROM mcp_definitions WHERE id = ?').get(id);
      if (existing) {
        throw new RegistryPolicyFault('MCP_ALREADY_EXISTS', 409);
      }

      let env = {};
      if (Array.isArray(input.environmentPatch)) {
        env = mergeEnvironmentPatch({}, input.environmentPatch);
      } else if (input.environment && typeof input.environment === 'object') {
        const patch = Object.entries(input.environment).map(([k, v]) => ({
          op: 'set',
          name: k,
          value: typeof v === 'object' ? v.value : String(v),
          secret: typeof v === 'object' ? v.secret : true
        }));
        env = mergeEnvironmentPatch({}, patch);
      }

      const def = {
        id,
        label: input.label || id,
        enabled: input.enabled !== false,
        revision: 1,
        sortOrder: Number.isSafeInteger(input.sortOrder) ? input.sortOrder : 500,
        controlCarrier: false, // browser cannot set controlCarrier
        binding: input.binding || { type: 'stdio', executable: 'node', args: [] },
        environment: env,
        locations: input.locations || null,
        provenance: provenance || null,
        deletedAt: null
      };

      const sealed = sealDefinition(def);
      const nowIso = new Date().toISOString();
      const provIdentity = provenance?.identity || null;

      db.prepare(`
        INSERT INTO mcp_definitions (id, label, enabled, revision, sort_order, control_carrier, sealed_definition, provenance_identity, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        def.id,
        def.label,
        def.enabled ? 1 : 0,
        def.revision,
        def.sortOrder,
        0,
        sealed,
        provIdentity,
        nowIso,
        nowIso
      );

      bumpGlobalRevision();
      return formatPublicServiceDTO(def);
    });
  }

  async function update(id, patch = {}, { expectedRevision } = {}) {
    return withWriteTransaction(() => {
      const currentGlobalRev = getGlobalRevision();
      if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== currentGlobalRev) {
        throw new RegistryPolicyFault('REVISION_CONFLICT', 409);
      }

      const def = getDefinition(id);
      if (!def || def.deletedAt) {
        throw new RegistryPolicyFault('MCP_NOT_FOUND', 404);
      }

      if (patch.label !== undefined) def.label = String(patch.label);
      if (patch.enabled !== undefined) def.enabled = Boolean(patch.enabled);

      if (Array.isArray(patch.environmentPatch)) {
        def.environment = mergeEnvironmentPatch(def.environment || {}, patch.environmentPatch);
      }

      if (patch.binding && typeof patch.binding === 'object') {
        if (patch.binding.type === 'stdio') {
          const oldArgs = def.binding?.args || [];
          let newArgs = oldArgs;
          if (Array.isArray(patch.binding.args)) {
            newArgs = patch.binding.args.map((arg, idx) => {
              const argId = arg.id || `arg_${idx}`;
              const old = oldArgs.find(a => a.id === argId);
              const val = arg.value !== undefined ? arg.value : old?.value;
              if (val === undefined) {
                throw new RegistryPolicyFault('INVALID_ARG_VALUE', 400);
              }
              return {
                id: argId,
                value: val,
                secret: arg.secret !== false
              };
            });
          }
          def.binding = {
            type: 'stdio',
            executable: patch.binding.executable || def.binding?.executable || 'node',
            args: newArgs,
            cwd: patch.binding.cwd !== undefined ? patch.binding.cwd : def.binding?.cwd
          };
        } else if (patch.binding.type === 'http') {
          def.binding = {
            type: 'http',
            url: patch.binding.url || def.binding?.url,
            headers: patch.binding.headers || def.binding?.headers || {}
          };
        }
      }

      def.revision = (def.revision || 1) + 1;
      const sealed = sealDefinition(def);
      const nowIso = new Date().toISOString();

      db.prepare(`
        UPDATE mcp_definitions
        SET label = ?, enabled = ?, revision = ?, sealed_definition = ?, updated_at = ?
        WHERE id = ?
      `).run(
        def.label,
        def.enabled ? 1 : 0,
        def.revision,
        sealed,
        nowIso,
        id
      );

      bumpGlobalRevision();
      return formatPublicServiceDTO(def);
    });
  }

  async function remove(id, { expectedRevision } = {}) {
    return withWriteTransaction(() => {
      const currentGlobalRev = getGlobalRevision();
      if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== currentGlobalRev) {
        throw new RegistryPolicyFault('REVISION_CONFLICT', 409);
      }

      const def = getDefinition(id);
      if (!def || def.deletedAt) {
        throw new RegistryPolicyFault('MCP_NOT_FOUND', 404);
      }

      const runtime = getServiceRuntime(id);
      const runtimeState = runtime?.state || (runtime?.running ? 'running' : 'stopped');
      let busy = false;
      try {
        assertIdle();
      } catch {
        busy = true;
      }

      const decision = removalDecision({ service: def, runtimeState, busy });
      if (!decision.allowed) {
        throw new RegistryPolicyFault(decision.code, 409);
      }

      const nowIso = new Date().toISOString();
      db.prepare('UPDATE mcp_definitions SET deleted_at = ?, updated_at = ? WHERE id = ?').run(nowIso, nowIso, id);
      bumpGlobalRevision();

      return {
        removed: true,
        id,
        tombstone: true,
        preservedInstallation: decision.preserveInstallation,
        preservedSourceFiles: decision.preserveSourceFiles
      };
    });
  }

  function snapshot(targetIds, expectedRevision) {
    const services = listDefinitions();
    const globalRev = getGlobalRevision();
    return pinRegistrySnapshot(targetIds, { services, revision: globalRev }, expectedRevision);
  }

  async function importDefinition(input, { expectedRevision, provenance }) {
    return withWriteTransaction(() => {
      const currentGlobalRev = getGlobalRevision();
      if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== currentGlobalRev) {
        throw new RegistryPolicyFault('REVISION_CONFLICT', 409);
      }

      const provIdentity = provenance?.identity;
      if (!provIdentity) {
        throw new RegistryPolicyFault('MISSING_PROVENANCE_IDENTITY', 400);
      }

      // Check existing by provenance identity OR by service id
      const existing = db.prepare('SELECT * FROM mcp_definitions WHERE (provenance_identity = ? OR id = ?) AND deleted_at IS NULL').get(provIdentity, input.id || '');
      if (existing) {
        if (!existing.provenance_identity && provIdentity) {
          db.prepare('UPDATE mcp_definitions SET provenance_identity = ? WHERE id = ?').run(provIdentity, existing.id);
        }
        const def = unsealDefinition(existing);
        return {
          service: formatPublicServiceDTO(def),
          created: false
        };
      }

      const id = input.id || `mcp_${crypto.randomUUID().replace(/-/g, '')}`;
      const def = {
        id,
        label: input.label || id,
        enabled: true,
        revision: 1,
        sortOrder: 500,
        controlCarrier: false,
        binding: input.binding || { type: 'stdio', executable: 'node', args: [] },
        environment: input.environment || {},
        locations: input.locations || null,
        provenance,
        deletedAt: null
      };

      const sealed = sealDefinition(def);
      const nowIso = new Date().toISOString();

      db.prepare(`
        INSERT INTO mcp_definitions (id, label, enabled, revision, sort_order, control_carrier, sealed_definition, provenance_identity, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        def.id,
        def.label,
        1,
        def.revision,
        500,
        0,
        sealed,
        provIdentity,
        nowIso,
        nowIso
      );

      bumpGlobalRevision();
      return {
        service: formatPublicServiceDTO(def),
        created: true
      };
    });
  }

  // MCP Stop Actions
  async function createStopAction({ serviceId, expectedRevision, idempotencyKey }) {
    return withWriteTransaction(() => {
      const bodyFingerprint = sha256(JSON.stringify({ serviceId, expectedRevision }));

      if (idempotencyKey) {
        const existingRow = db.prepare('SELECT * FROM mcp_actions WHERE idempotency_key = ?').get(idempotencyKey);
        if (existingRow) {
          if (existingRow.request_fingerprint !== bodyFingerprint) {
            throw new RegistryPolicyFault('IDEMPOTENCY_CONFLICT', 409);
          }
          return publicAction(existingRow.id);
        }
      }

      const currentGlobalRev = getGlobalRevision();
      if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== currentGlobalRev) {
        throw new RegistryPolicyFault('REVISION_CONFLICT', 409);
      }

      assertIdle();

      const def = getDefinition(serviceId);
      if (!def || def.deletedAt) {
        throw new RegistryPolicyFault('MCP_NOT_FOUND', 404);
      }

      const actionId = `act_stop_${crypto.randomUUID().replace(/-/g, '')}`;
      const originalRuntime = getServiceRuntime(serviceId);
      const registrySnapshot = {
        revision: currentGlobalRev,
        services: [def]
      };

      const internalAction = {
        operationId: actionId,
        id: actionId,
        kind: 'stop',
        serviceId,
        state: 'QUEUED',
        originalRuntime,
        registrySnapshot,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      const aad = JSON.stringify(['action', actionId, 'stop-v1']);
      const sealed = vault.seal(internalAction, aad);
      const sealedStr = typeof sealed === 'string' ? sealed : JSON.stringify(sealed);
      const nowIso = new Date().toISOString();

      db.prepare(`
        INSERT INTO mcp_actions (id, service_id, state, idempotency_key, request_fingerprint, sealed_payload, created_at, updated_at)
        VALUES (?, ?, 'QUEUED', ?, ?, ?, ?, ?)
      `).run(
        actionId,
        serviceId,
        idempotencyKey || null,
        bodyFingerprint,
        sealedStr,
        nowIso,
        nowIso
      );

      return publicAction(actionId);
    });
  }

  function isActionId(id) {
    if (typeof id !== 'string') return false;
    const row = db.prepare('SELECT id FROM mcp_actions WHERE id = ?').get(id);
    return Boolean(row);
  }

  function listPendingActionIds() {
    const rows = db.prepare("SELECT id FROM mcp_actions WHERE state IN ('QUEUED', 'APPLYING', 'NEEDS_ATTENTION') ORDER BY created_at ASC").all();
    return rows.map(r => r.id);
  }

  function loadAction(id) {
    const row = db.prepare('SELECT * FROM mcp_actions WHERE id = ?').get(id);
    if (!row) return null;
    const aad = JSON.stringify(['action', id, 'stop-v1']);
    let envelope = row.sealed_payload || row.sealed_action;
    try {
      envelope = JSON.parse(envelope);
    } catch (_) {}
    return vault.unseal(envelope, aad);
  }

  function publicAction(id) {
    const row = db.prepare('SELECT id, service_id, state, error_code, created_at, updated_at FROM mcp_actions WHERE id = ?').get(id);
    if (!row) return null;
    return {
      operationId: row.id,
      id: row.id,
      kind: 'stop',
      profileId: null,
      serviceId: row.service_id,
      state: row.state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      errorCode: row.error_code || null
    };
  }

  async function transitionAction(id, patch = {}) {
    return withWriteTransaction(() => {
      const action = loadAction(id);
      if (!action) throw new RegistryPolicyFault('ACTION_NOT_FOUND', 404);

      if (patch.state) action.state = patch.state;
      if (patch.errorCode) action.errorCode = patch.errorCode;
      action.updatedAt = new Date().toISOString();

      const aad = JSON.stringify(['action', id, 'stop-v1']);
      const sealed = vault.seal(action, aad);
      const sealedStr = typeof sealed === 'string' ? sealed : JSON.stringify(sealed);

      db.prepare(`
        UPDATE mcp_actions
        SET state = ?, error_code = ?, sealed_payload = ?, updated_at = ?
        WHERE id = ?
      `).run(
        action.state,
        action.errorCode || null,
        sealedStr,
        action.updatedAt,
        id
      );

      return publicAction(id);
    });
  }

  async function finishStoppedAction(id, receipt) {
    return withWriteTransaction(() => {
      const action = loadAction(id);
      if (!action) throw new RegistryPolicyFault('ACTION_NOT_FOUND', 404);

      assertStoppedConnectionReceipt(receipt, id, action.serviceId);

      clearActiveService(action.serviceId);
      bumpGlobalRevision();

      action.state = 'SUCCEEDED';
      action.receipt = receipt;
      action.updatedAt = new Date().toISOString();

      const aad = JSON.stringify(['action', id, 'stop-v1']);
      const sealed = vault.seal(action, aad);
      const sealedStr = typeof sealed === 'string' ? sealed : JSON.stringify(sealed);

      db.prepare(`
        UPDATE mcp_actions
        SET state = 'SUCCEEDED', sealed_action = ?, updated_at = ?
        WHERE id = ?
      `).run(sealedStr, action.updatedAt, id);

      return publicAction(id);
    });
  }

  async function markActionAttention(id, safeCode) {
    return withWriteTransaction(() => {
      const action = loadAction(id);
      if (!action) throw new RegistryPolicyFault('ACTION_NOT_FOUND', 404);

      action.state = 'NEEDS_ATTENTION';
      action.errorCode = safeCode;
      action.updatedAt = new Date().toISOString();

      const aad = JSON.stringify(['action', id, 'stop-v1']);
      const sealed = vault.seal(action, aad);
      const sealedStr = typeof sealed === 'string' ? sealed : JSON.stringify(sealed);

      db.prepare(`
        UPDATE mcp_actions
        SET state = 'NEEDS_ATTENTION', error_code = ?, sealed_action = ?, updated_at = ?
        WHERE id = ?
      `).run(safeCode, sealedStr, action.updatedAt, id);

      return publicAction(id);
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
    isActionId,
    listPendingActionIds,
    loadAction,
    publicAction,
    transitionAction,
    finishStoppedAction,
    markActionAttention
  };
}

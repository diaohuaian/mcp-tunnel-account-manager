import { publicEnvironment } from '../core/mcp-registry-policy.mjs';
import { publicBinding, isSensitiveName } from '../adapters/mcp-binding.mjs';

const VALID_REVEAL_ROLES = new Set([
  'sourceConfig',
  'effectiveConfig',
  'installation',
  'executable',
  'workingDirectory',
  'managerStore'
]);

function sendJson(res, status, data) {
  if (res.writableEnded) return;
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function sendError(res, status, code) {
  if (res.writableEnded) return;
  const statusCode = typeof status === 'number' && status >= 400 && status < 600 ? status : 500;
  let errorCode = code;
  if (typeof errorCode !== 'string' || !errorCode) {
    if (statusCode === 400) errorCode = 'BAD_REQUEST';
    else if (statusCode === 401) errorCode = 'UNAUTHORIZED';
    else if (statusCode === 403) errorCode = 'FORBIDDEN';
    else if (statusCode === 404) errorCode = 'NOT_FOUND';
    else if (statusCode === 409) errorCode = 'CONFLICT';
    else errorCode = 'INTERNAL_ERROR';
  }
  const payload = JSON.stringify({
    error: {
      code: errorCode,
      status: statusCode
    }
  });
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let exceeded = false;

    req.on('data', (chunk) => {
      if (exceeded) return;
      size += chunk.length;
      if (size > limit) {
        exceeded = true;
        req.pause();
        req.resume();
        const err = new Error('Payload Too Large');
        err.status = 413;
        err.code = 'JSON_LIMIT_EXCEEDED';
        return reject(err);
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (exceeded) return;
      if (chunks.length === 0) return resolve({});
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        const err = new Error('Invalid JSON');
        err.status = 400;
        err.code = 'INVALID_JSON';
        reject(err);
      }
    });

    req.on('error', reject);
  });
}

/**
 * Sanitizes an MCP definition to a safe public DTO.
 * Guarantees no raw secrets, plain credentials, or full unmasked sensitive values.
 */
export function sanitizeMcpDto(def) {
  if (!def || typeof def !== 'object') return null;

  const result = {
    id: def.id,
    label: def.label || def.id,
    enabled: def.enabled !== false,
    revision: Number.isSafeInteger(def.revision) ? def.revision : 1
  };

  if (Number.isSafeInteger(def.sortOrder)) {
    result.sortOrder = def.sortOrder;
  }
  if (def.controlCarrier !== undefined) {
    result.controlCarrier = Boolean(def.controlCarrier);
  }
  if (def.deletedAt !== undefined) {
    result.deletedAt = def.deletedAt;
  }
  if (def.runtimeState !== undefined) {
    result.runtimeState = def.runtimeState;
  }
  if (def.activeProfileRevision !== undefined) {
    result.activeProfileRevision = def.activeProfileRevision;
  }
  if (def.activeServiceRevision !== undefined) {
    result.activeServiceRevision = def.activeServiceRevision;
  }
  if (def.pendingApply !== undefined) {
    result.pendingApply = Boolean(def.pendingApply);
  }

  // Binding sanitization
  if (def.binding && typeof def.binding === 'object') {
    result.binding = publicBinding(def.binding) || { type: def.binding.type };
  }

  // Environment sanitization
  if (def.environment && typeof def.environment === 'object') {
    if (Array.isArray(def.environment)) {
      result.environment = def.environment.map(entry => {
        if (!entry || typeof entry !== 'object') return entry;
        const name = entry.name;
        const isSecret = isSensitiveName(name) || entry.secret !== false;
        if (isSecret) {
          return { name, secret: true, configured: Boolean(entry.configured ?? true) };
        }
        return { name, secret: false, configured: Boolean(entry.configured ?? true), value: entry.value };
      });
    } else {
      result.environment = publicEnvironment(def.environment);
    }
  }

  // Locations metadata (safe path descriptors only)
  if (def.locations && typeof def.locations === 'object') {
    result.locations = {
      sourceConfigPath: def.locations.sourceConfigPath ?? null,
      effectiveConfigPath: def.locations.effectiveConfigPath ?? null,
      installationRoot: def.locations.installationRoot ?? null,
      executable: def.locations.executable ?? null,
      cwd: def.locations.cwd ?? null
    };
  }

  if (def.runtime && typeof def.runtime === 'object') {
    result.runtime = def.runtime;
  }
  if (def.createdAt !== undefined) {
    result.createdAt = def.createdAt;
  }
  if (def.updatedAt !== undefined) {
    result.updatedAt = def.updatedAt;
  }

  return result;
}

/**
 * Pure route matcher function.
 *
 * @param {string} pathname
 * @param {string} method
 * @returns {{ route: string, params: object } | null}
 */
export function matchMcpRoute(pathname, method = 'GET') {
  const normPath = (pathname || '').replace(/\/+$/, '') || '/';
  const m = method.toUpperCase();

  if (normPath === '/api/mcps') {
    if (m === 'GET') return { route: 'listMcps', params: {} };
    if (m === 'POST') return { route: 'createMcp', params: {} };
    return { route: 'methodNotAllowed', params: {} };
  }

  if (normPath === '/api/discovery') {
    if (m === 'GET') return { route: 'discoveryScan', params: {} };
    return { route: 'methodNotAllowed', params: {} };
  }

  const importMatch = normPath.match(/^\/api\/discovery\/([^/]+)\/import$/);
  if (importMatch) {
    if (m === 'POST') return { route: 'discoveryImport', params: { id: decodeURIComponent(importMatch[1]) } };
    return { route: 'methodNotAllowed', params: {} };
  }

  const locationsMatch = normPath.match(/^\/api\/mcps\/([^/]+)\/locations$/);
  if (locationsMatch) {
    if (m === 'GET') return { route: 'getMcpLocations', params: { id: decodeURIComponent(locationsMatch[1]) } };
    return { route: 'methodNotAllowed', params: {} };
  }

  const revealMatch = normPath.match(/^\/api\/mcps\/([^/]+)\/reveal$/);
  if (revealMatch) {
    if (m === 'POST') return { route: 'mcpReveal', params: { id: decodeURIComponent(revealMatch[1]) } };
    return { route: 'methodNotAllowed', params: {} };
  }

  const stopMatch = normPath.match(/^\/api\/mcps\/([^/]+)\/stop$/);
  if (stopMatch) {
    if (m === 'POST') return { route: 'mcpStop', params: { id: decodeURIComponent(stopMatch[1]) } };
    return { route: 'methodNotAllowed', params: {} };
  }

  const singleMcpMatch = normPath.match(/^\/api\/mcps\/([^/]+)$/);
  if (singleMcpMatch) {
    const id = decodeURIComponent(singleMcpMatch[1]);
    if (m === 'GET') return { route: 'getMcp', params: { id } };
    if (m === 'PATCH') return { route: 'updateMcp', params: { id } };
    if (m === 'DELETE') return { route: 'deleteMcp', params: { id } };
    return { route: 'methodNotAllowed', params: {} };
  }

  return null;
}

/**
 * Creates MCP routes handler.
 *
 * @param {object} params
 * @param {object} params.repo - Store repository
 * @param {object} [params.runner] - Execution runner
 * @param {object} [params.discovery] - MCP discovery service
 * @param {object} [params.importer] - Config importer service
 * @param {object} [params.locations] - Location resolver service
 * @returns {{ handle: ({ req, res, url, body, auth }) => Promise<boolean> }}
 */
export function createMcpRoutes({ repo, runner, discovery, importer, locations } = {}) {
  async function handle({ req, res, url, body, auth }) {
    const parsedUrl = typeof url === 'string'
      ? new URL(url, 'http://localhost')
      : (url || new URL(req.url, 'http://localhost'));

    const pathname = parsedUrl.pathname.replace(/\/+$/, '') || '/';
    const method = (req.method || 'GET').toUpperCase();

    const matched = matchMcpRoute(pathname, method);
    if (!matched) {
      return false;
    }

    if (matched.route === 'methodNotAllowed') {
      sendError(res, 405, 'METHOD_NOT_ALLOWED');
      return true;
    }

    // Enforce authentication context: auth is required and must not be false
    if (!auth || auth.authenticated === false) {
      sendError(res, 401, 'UNAUTHORIZED');
      return true;
    }

    let payload = body;
    if (payload && typeof payload.then === 'function') {
      payload = await payload;
    }
    if (payload === undefined && (method === 'POST' || method === 'PATCH' || method === 'DELETE')) {
      try {
        payload = await readJsonBody(req);
      } catch (err) {
        sendError(res, err.status || 400, err.code || 'INVALID_JSON');
        return true;
      }
    }

    try {
      const getRev = async () => (typeof repo?.getRevision === 'function' ? await repo.getRevision() : 0);

      switch (matched.route) {
        // 1. GET /api/mcps -> { mcps, revision }
        case 'listMcps': {
          let mcps = [];
          if (repo?.registry && typeof repo.registry.listServices === 'function') {
            mcps = await repo.registry.listServices();
          } else if (typeof repo?.listServices === 'function') {
            mcps = await repo.listServices();
          }
          const safeMcps = Array.isArray(mcps) ? mcps.map(sanitizeMcpDto) : [];
          const revision = await getRev();
          sendJson(res, 200, { mcps: safeMcps, revision });
          return true;
        }

        // 2. POST /api/mcps -> 201 { mcp, revision }
        case 'createMcp': {
          const expectedRevision = payload?.expectedRevision;
          if (!repo?.registry || typeof repo.registry.create !== 'function') {
            sendError(res, 500, 'REGISTRY_NOT_INITIALIZED');
            return true;
          }
          const created = await repo.registry.create(payload, { expectedRevision });
          const safeMcp = sanitizeMcpDto(created);
          const revision = await getRev();
          sendJson(res, 201, { mcp: safeMcp, revision });
          return true;
        }

        // 3. GET /api/mcps/:id -> { mcp, revision }
        case 'getMcp': {
          const { id } = matched.params;
          let mcp = null;

          if (repo?.registry && typeof repo.registry.getService === 'function') {
            mcp = await repo.registry.getService(id);
          } else if (repo?.registry && typeof repo.registry.getDefinition === 'function') {
            const def = await repo.registry.getDefinition(id);
            if (def && !def.deletedAt) {
              mcp = def;
            }
          } else if (repo?.registry && typeof repo.registry.listServices === 'function') {
            const list = await repo.registry.listServices();
            mcp = list.find((s) => s.id === id && !s.deletedAt) || null;
          } else if (typeof repo?.listServices === 'function') {
            const list = await repo.listServices();
            mcp = list.find((s) => s.id === id || s.serviceId === id) || null;
          }

          if (!mcp) {
            sendError(res, 404, 'MCP_NOT_FOUND');
            return true;
          }

          const safeMcp = sanitizeMcpDto(mcp);
          const revision = await getRev();
          sendJson(res, 200, { mcp: safeMcp, revision });
          return true;
        }

        // 4. PATCH /api/mcps/:id -> { mcp, revision }
        case 'updateMcp': {
          const { id } = matched.params;
          const expectedRevision = payload?.expectedRevision;
          if (!repo?.registry || typeof repo.registry.update !== 'function') {
            sendError(res, 500, 'REGISTRY_NOT_INITIALIZED');
            return true;
          }
          const updated = await repo.registry.update(id, payload, { expectedRevision });
          const safeMcp = sanitizeMcpDto(updated);
          const revision = await getRev();
          sendJson(res, 200, { mcp: safeMcp, revision });
          return true;
        }

        // 5. DELETE /api/mcps/:id -> safe delete result
        case 'deleteMcp': {
          const { id } = matched.params;
          let expectedRevision = payload?.expectedRevision;
          if (expectedRevision === undefined && parsedUrl.searchParams.has('expectedRevision')) {
            const parsed = parseInt(parsedUrl.searchParams.get('expectedRevision'), 10);
            if (Number.isSafeInteger(parsed)) expectedRevision = parsed;
          }

          if (!repo?.registry || typeof repo.registry.remove !== 'function') {
            sendError(res, 500, 'REGISTRY_NOT_INITIALIZED');
            return true;
          }
          const result = await repo.registry.remove(id, { expectedRevision });
          sendJson(res, 200, result ?? { ok: true, id, effect: 'archive_registration' });
          return true;
        }

        // 6. GET /api/mcps/:id/locations -> location DTO
        case 'getMcpLocations': {
          const { id } = matched.params;
          if (!locations || typeof locations.describe !== 'function') {
            sendError(res, 500, 'LOCATIONS_NOT_CONFIGURED');
            return true;
          }

          let def = null;
          if (repo?.registry && typeof repo.registry.getDefinition === 'function') {
            def = await repo.registry.getDefinition(id);
          }
          if (!def || def.deletedAt) {
            sendError(res, 404, 'MCP_NOT_FOUND');
            return true;
          }

          const runtime = repo?.registry && typeof repo.registry.getServiceRuntime === 'function'
            ? await repo.registry.getServiceRuntime(id)
            : null;

          const locationDto = await locations.describe(def, runtime);
          sendJson(res, 200, locationDto);
          return true;
        }

        // 7. POST /api/mcps/:id/reveal -> safe opened result
        case 'mcpReveal': {
          const { id } = matched.params;
          const role = payload?.role;
          if (!role || typeof role !== 'string' || !VALID_REVEAL_ROLES.has(role)) {
            sendError(res, 400, 'INVALID_REVEAL_ROLE');
            return true;
          }

          if (!locations || typeof locations.reveal !== 'function') {
            sendError(res, 500, 'LOCATIONS_NOT_CONFIGURED');
            return true;
          }

          let def = null;
          if (repo?.registry && typeof repo.registry.getDefinition === 'function') {
            def = await repo.registry.getDefinition(id);
          }
          if (!def || def.deletedAt) {
            sendError(res, 404, 'MCP_NOT_FOUND');
            return true;
          }

          const runtime = repo?.registry && typeof repo.registry.getServiceRuntime === 'function'
            ? await repo.registry.getServiceRuntime(id)
            : null;

          const revealResult = await locations.reveal(def, role, runtime);
          const responsePayload = {
            opened: true,
            message: '已请求打开所在目录',
            ...(revealResult || {})
          };
          responsePayload.opened = true;
          if (!responsePayload.message) {
            responsePayload.message = '已请求打开所在目录';
          }
          sendJson(res, 200, responsePayload);
          return true;
        }

        // 8. POST /api/mcps/:id/stop -> 202 public stop DTO
        case 'mcpStop': {
          const { id } = matched.params;
          let expectedRevision = payload?.expectedRevision;
          if (expectedRevision === undefined && parsedUrl.searchParams.has('expectedRevision')) {
            const parsed = parseInt(parsedUrl.searchParams.get('expectedRevision'), 10);
            if (Number.isSafeInteger(parsed)) expectedRevision = parsed;
          }

          const rawIdempotencyKey = req.headers['idempotency-key'] || req.headers['idempotencykey'];
          const idempotencyKey = typeof rawIdempotencyKey === 'string'
            ? rawIdempotencyKey.trim() || undefined
            : undefined;

          if (!repo?.registry || typeof repo.registry.createStopAction !== 'function') {
            sendError(res, 500, 'REGISTRY_NOT_INITIALIZED');
            return true;
          }

          const action = await repo.registry.createStopAction({
            serviceId: id,
            expectedRevision,
            idempotencyKey
          });

          // Wake runner after successful action persistence
          if (runner) {
            if (typeof runner.wake === 'function') {
              try { runner.wake(); } catch {}
            } else if (typeof runner.notify === 'function') {
              try { runner.notify(); } catch {}
            }
          }

          sendJson(res, 202, action);
          return true;
        }

        // 9. GET /api/discovery -> { candidates }
        case 'discoveryScan': {
          let candidates = [];
          if (discovery && typeof discovery.scan === 'function') {
            candidates = await discovery.scan();
          }
          sendJson(res, 200, { candidates: candidates || [] });
          return true;
        }

        // 10. POST /api/discovery/:id/import -> 201/200 safe import result
        case 'discoveryImport': {
          const { id } = matched.params;
          if (!importer || typeof importer.importCandidate !== 'function') {
            sendError(res, 500, 'IMPORTER_NOT_CONFIGURED');
            return true;
          }

          const expectedFingerprint = payload?.expectedFingerprint;
          const expectedRevision = payload?.expectedRevision;
          const mergeProfileId = payload?.mergeProfileId;

          const result = await importer.importCandidate(id, {
            expectedFingerprint,
            expectedRevision,
            mergeProfileId
          });

          const status = result?.created ? 201 : 200;
          sendJson(res, status, result);
          return true;
        }

        default:
          return false;
      }
    } catch (err) {
      let status = err.status || err.statusCode;
      let code = err.code;

      if (!status) {
        if (err.name === 'RegistryPolicyFault') {
          status = err.status || 400;
          code = err.code || 'BAD_REQUEST';
        } else if (err.code === 'REVISION_CONFLICT' || err.code === 'CONFLICT' || err.name === 'ConflictError') {
          status = 409;
          code = err.code || 'REVISION_CONFLICT';
        } else if (err.code === 'SOURCE_CHANGED' || err.code === 'MCP_RUNNING' || err.code === 'MCP_BUSY' || err.code === 'RUNTIME_STATE_UNKNOWN' || err.code === 'IDEMPOTENCY_CONFLICT' || err.code === 'STOP_UNCONFIRMED' || err.code === 'MCP_DISABLED') {
          status = 409;
          code = err.code;
        } else if (err.code === 'MCP_NOT_FOUND' || err.code === 'NOT_FOUND' || err.code === 'CANDIDATE_NOT_FOUND' || err.name === 'NotFoundError') {
          status = 404;
          code = err.code || 'NOT_FOUND';
        } else if (err.code === 'INVALID_REVEAL_ROLE' || err.code === 'INVALID_TARGETS' || err.code === 'INVALID_ENV_NAME' || err.code === 'INVALID_ENV_PATCH' || err.code === 'RESERVED_ENV_NAME' || err.code === 'DUPLICATE_ENV_NAME') {
          status = 400;
          code = err.code;
        } else {
          console.error('[MCP-ROUTES CAUGHT ERROR]:', err.message, err.stack);
          status = 500;
          code = err.code || 'INTERNAL_ERROR';
        }
      }

      sendError(res, status, code);
      return true;
    }
  }

  return {
    handle
  };
}

export default createMcpRoutes;

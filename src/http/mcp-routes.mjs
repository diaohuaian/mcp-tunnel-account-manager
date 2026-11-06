import fs from 'node:fs';
import { publicEnvironment } from '../core/mcp-registry-policy.mjs';
import { publicBinding, isSensitiveName } from '../adapters/mcp-binding.mjs';
import { normalizeObservation } from '../adapters/runtime-observer.mjs';
import { issueCarrierConfirmation, verifyCarrierConfirmation } from '../core/carrier-confirmation.mjs';

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
    const rawState = def.runtime.state || def.runtime.runtimeState || 'unknown';
    const state = ['running', 'stopped', 'starting', 'not_running', 'never_started'].includes(rawState)
      ? (rawState === 'starting' || rawState === 'running' ? 'running' : 'stopped')
      : (rawState || 'unknown');
    result.runtime = {
      state,
      activeProfileRevision: Number.isSafeInteger(def.runtime.activeProfileRevision)
        ? def.runtime.activeProfileRevision
        : null,
      activeServiceRevision: Number.isSafeInteger(def.runtime.activeServiceRevision)
        ? def.runtime.activeServiceRevision
        : null,
      pendingApply: Boolean(def.runtime.pendingApply),
      observation: normalizeObservation(def.runtime.observation)
    };
  } else {
    result.runtime = {
      state: 'unknown',
      activeProfileRevision: null,
      activeServiceRevision: null,
      pendingApply: false,
      observation: normalizeObservation(null)
    };
  }

  const rawTc = def.runtime?.tunnelClient;
  if (rawTc && typeof rawTc === 'object') {
    const VALID_TC_STATES = new Set(['running', 'stopped', 'starting', 'stopping', 'restarting', 'failed', 'unmanaged', 'unobserved']);
    const tcState = VALID_TC_STATES.has(rawTc.state) ? rawTc.state : 'unobserved';
    result.runtime.tunnelClient = {
      state: tcState,
      managed: Boolean(rawTc.managed ?? (tcState !== 'unmanaged')),
      pid: Number.isSafeInteger(rawTc.pid) && rawTc.pid > 0 ? rawTc.pid : null,
      startedAt: typeof rawTc.startedAt === 'string' ? rawTc.startedAt : null,
      profileId: typeof rawTc.profileId === 'string' ? rawTc.profileId : null,
      operationId: typeof rawTc.operationId === 'string' ? rawTc.operationId : null,
      observedAt: typeof rawTc.observedAt === 'string' ? rawTc.observedAt : (typeof rawTc.observedAt === 'number' ? new Date(rawTc.observedAt).toISOString() : null),
      expiresAt: typeof rawTc.expiresAt === 'string' ? rawTc.expiresAt : (typeof rawTc.expiresAt === 'number' ? new Date(rawTc.expiresAt).toISOString() : null),
      reasonCode: typeof rawTc.reasonCode === 'string' ? rawTc.reasonCode : 'not_observed',
      lastExitCode: Number.isInteger(rawTc.lastExitCode) ? rawTc.lastExitCode : null
    };
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

  const startMatch = normPath.match(/^\/api\/mcps\/([^/]+)\/start$/);
  if (startMatch) {
    if (m === 'POST') return { route: 'mcpStart', params: { id: decodeURIComponent(startMatch[1]) } };
    return { route: 'methodNotAllowed', params: {} };
  }

  const restartMatch = normPath.match(/^\/api\/mcps\/([^/]+)\/restart$/);
  if (restartMatch) {
    if (m === 'POST') return { route: 'mcpRestart', params: { id: decodeURIComponent(restartMatch[1]) } };
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
export function createMcpRoutes({ repo, runner, discovery, importer, locations, vault, adapters, adapterProvider } = {}) {
  async function getProcessIdentity(serviceId) {
    let adapter = null;
    const prov = adapterProvider || runner?.deps?.adapterProvider || (adapters ? (op, id) => adapters[id] : null);
    if (typeof prov === 'function') {
      try { adapter = await prov({}, serviceId); } catch {}
    } else if (prov && typeof prov.getAdapter === 'function') {
      try { adapter = await prov.getAdapter({}, serviceId); } catch {}
    } else if (adapters && adapters[serviceId]) {
      adapter = adapters[serviceId];
    }

    let inspected = null;
    if (adapter?.processController && typeof adapter.processController.inspect === 'function') {
      try { inspected = await adapter.processController.inspect(serviceId); } catch {}
    }

    let recordedProc = null;
    if (adapter?.processPath && fs.existsSync(adapter.processPath)) {
      try { recordedProc = JSON.parse(fs.readFileSync(adapter.processPath, 'utf8')); } catch {}
    }

    const live = Boolean(inspected?.running && inspected.pid > 0);
    const owned = Boolean(live && recordedProc && recordedProc.pid === inspected?.pid);

    if (live) {
      if (!owned) {
        return { unverified: true };
      }
      let verified = false;
      if (typeof adapter?.processController?.verify === 'function') {
        try {
          const v = await adapter.processController.verify(recordedProc);
          verified = Boolean(v?.valid);
        } catch {
          verified = false;
        }
      } else {
        verified = true;
      }
      const executablePath = inspected?.executablePath || inspected?.executable || recordedProc?.executablePath || recordedProc?.executable;
      const startedAt = inspected?.startedAt || inspected?.startTime || recordedProc?.startedAt;

      if (!verified || !executablePath || !startedAt) {
        return { unverified: true };
      }

      return {
        identity: {
          pid: inspected.pid,
          startedAt,
          executablePath,
          verified: true
        },
        absenceVerified: false
      };
    } else {
      const absenceVerified = Boolean(inspected && inspected.running === false) || (!live && !recordedProc);
      return {
        identity: null,
        absenceVerified
      };
    }
  }

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

        // 8a. POST /api/mcps/:id/start -> 202 public action DTO (or 200 noop)
        case 'mcpStart': {
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

          // Check if already running with same profile (fast noop check)
          const obs = repo?.registry?.getObserver ? repo.registry.getObserver() : repo?.getObserver?.();
          const currentTc = obs?.peekTunnelClient
            ? obs.peekTunnelClient(id)
            : (repo?.registry?.getServiceRuntime?.(id)?.tunnelClient || repo?.getServiceRuntime?.(id)?.tunnelClient || null);
          if (currentTc?.state === 'running' && (!payload?.profileId || payload.profileId === currentTc.profileId)) {
            sendJson(res, 200, { decision: 'noop', code: 'ALREADY_RUNNING', pid: currentTc.pid, serviceId: id });
            return true;
          }

          if (!payload?.profileId || typeof payload.profileId !== 'string' || !payload.profileId.trim()) {
            sendError(res, 400, 'PROFILE_REQUIRED', '必须指定适用的运行账号 / Profile。');
            return true;
          }

          if (!repo?.registry || (typeof repo.registry.createLifecycleAction !== 'function' && typeof repo.registry.createStopAction !== 'function')) {
            sendError(res, 500, 'REGISTRY_NOT_INITIALIZED');
            return true;
          }

          const createFn = typeof repo.registry.createLifecycleAction === 'function'
            ? repo.registry.createLifecycleAction
            : repo.registry.createStopAction;

          const action = await createFn({
            action: 'start',
            serviceId: id,
            profileId: payload?.profileId,
            expectedRevision,
            idempotencyKey
          });

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

        // 8b. POST /api/mcps/:id/restart -> 202 public action DTO
        case 'mcpRestart': {
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

          // Carrier confirmation check
          let def = null;
          if (repo?.registry && typeof repo.registry.getDefinition === 'function') {
            try { def = await repo.registry.getDefinition(id); } catch {}
          } else if (repo?.registry && typeof repo.registry.getMcp === 'function') {
            try { def = await repo.registry.getMcp(id); } catch {}
          } else if (typeof repo?.getDefinition === 'function') {
            try { def = await repo.getDefinition(id); } catch {}
          }

          if (def?.controlCarrier) {
            if (!vault || typeof vault.seal !== 'function' || typeof vault.unseal !== 'function') {
              sendError(res, 500, 'CARRIER_CONFIRMATION_UNAVAILABLE');
              return true;
            }

            const sessionBinding = typeof auth?.sessionBinding === 'string' && auth.sessionBinding
              ? auth.sessionBinding
              : (typeof auth?.sessionId === 'string' && auth.sessionId ? auth.sessionId : null);
            if (!sessionBinding) {
              sendError(res, 401, 'UNAUTHORIZED');
              return true;
            }

            if (!idempotencyKey) {
              sendError(res, 400, 'IDEMPOTENCY_KEY_REQUIRED');
              return true;
            }

            const effectiveProfileId = payload?.profileId ? String(payload.profileId).trim() : null;
            if (!effectiveProfileId) {
              sendError(res, 400, 'PROFILE_REQUIRED', '必须指定适用的运行账号 / Profile。');
              return true;
            }

            if (typeof repo?.hasServiceCredential === 'function') {
              const hasCred = await repo.hasServiceCredential(effectiveProfileId, id);
              if (!hasCred) {
                sendError(res, 409, 'PROFILE_NOT_CONFIGURED');
                return true;
              }
            }

            const serviceRevision = Number.isSafeInteger(def.revision) && def.revision >= 1 ? def.revision : 1;
            const procInfo = await getProcessIdentity(id);
            if (procInfo.unverified) {
              sendError(res, 409, 'PROCESS_IDENTITY_UNVERIFIED');
              return true;
            }

            const confirmCtx = {
              action: 'restart',
              serviceId: id,
              serviceRevision,
              profileId: effectiveProfileId,
              sessionBinding,
              idempotencyKey,
              identity: procInfo.identity,
              absenceVerified: procInfo.absenceVerified
            };

            const carrierToken = payload?.carrierToken;
            if (!carrierToken) {
              let previewToken;
              try {
                previewToken = await issueCarrierConfirmation(vault, confirmCtx);
              } catch (err) {
                if (err.code === 'PROCESS_IDENTITY_UNVERIFIED' || err.code === 'INVALID_CARRIER_CONFIRMATION_CONTEXT' || err.code === 'INVALID_CARRIER_ACTION') {
                  sendError(res, 409, err.code);
                  return true;
                }
                if (err.code === 'CARRIER_CONFIRMATION_UNAVAILABLE') {
                  sendError(res, 500, err.code);
                  return true;
                }
                throw err;
              }
              sendJson(res, 409, {
                error: 'CARRIER_CONFIRMATION_REQUIRED',
                code: 'CARRIER_CONFIRMATION_REQUIRED',
                status: 409,
                confirmationRequired: true,
                carrierToken: previewToken,
                message: '此服务承载控制平面连接，重启将断开当前 ChatGPT 连接。若确认操作，请在确认对话框中继续。'
              });
              return true;
            }

            // carrierToken IS supplied: validate before persisting
            const isValid = await verifyCarrierConfirmation(vault, carrierToken, confirmCtx);
            if (!isValid) {
              sendError(res, 403, 'CARRIER_CONFIRMATION_INVALID');
              return true;
            }
          }

          if (!repo?.registry || (typeof repo.registry.createLifecycleAction !== 'function' && typeof repo.registry.createStopAction !== 'function')) {
            sendError(res, 500, 'REGISTRY_NOT_INITIALIZED');
            return true;
          }

          const createFn = typeof repo.registry.createLifecycleAction === 'function'
            ? repo.registry.createLifecycleAction
            : repo.registry.createStopAction;

          const action = await createFn({
            action: 'restart',
            serviceId: id,
            profileId: payload?.profileId,
            carrierToken: payload?.carrierToken,
            expectedRevision,
            idempotencyKey,
            sessionBinding: auth?.sessionBinding || auth?.sessionId || null
          });

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

        // 8c. POST /api/mcps/:id/stop -> 202 public stop DTO (or 200 noop)
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

          // Carrier confirmation check
          let def = null;
          if (repo?.registry && typeof repo.registry.getDefinition === 'function') {
            try { def = await repo.registry.getDefinition(id); } catch {}
          } else if (repo?.registry && typeof repo.registry.getMcp === 'function') {
            try { def = await repo.registry.getMcp(id); } catch {}
          } else if (typeof repo?.getDefinition === 'function') {
            try { def = await repo.getDefinition(id); } catch {}
          }

          if (def?.controlCarrier) {
            if (!vault || typeof vault.seal !== 'function' || typeof vault.unseal !== 'function') {
              sendError(res, 500, 'CARRIER_CONFIRMATION_UNAVAILABLE');
              return true;
            }

            const sessionBinding = typeof auth?.sessionBinding === 'string' && auth.sessionBinding
              ? auth.sessionBinding
              : (typeof auth?.sessionId === 'string' && auth.sessionId ? auth.sessionId : null);
            if (!sessionBinding) {
              sendError(res, 401, 'UNAUTHORIZED');
              return true;
            }

            if (!idempotencyKey) {
              sendError(res, 400, 'IDEMPOTENCY_KEY_REQUIRED');
              return true;
            }

            const serviceRevision = Number.isSafeInteger(def.revision) && def.revision >= 1 ? def.revision : 1;
            const procInfo = await getProcessIdentity(id);
            if (procInfo.unverified) {
              sendError(res, 409, 'PROCESS_IDENTITY_UNVERIFIED');
              return true;
            }

            const confirmCtx = {
              action: 'stop',
              serviceId: id,
              serviceRevision,
              profileId: null,
              sessionBinding,
              idempotencyKey,
              identity: procInfo.identity,
              absenceVerified: procInfo.absenceVerified
            };

            const carrierToken = payload?.carrierToken;
            if (!carrierToken) {
              let previewToken;
              try {
                previewToken = await issueCarrierConfirmation(vault, confirmCtx);
              } catch (err) {
                if (err.code === 'PROCESS_IDENTITY_UNVERIFIED' || err.code === 'INVALID_CARRIER_CONFIRMATION_CONTEXT' || err.code === 'INVALID_CARRIER_ACTION') {
                  sendError(res, 409, err.code);
                  return true;
                }
                if (err.code === 'CARRIER_CONFIRMATION_UNAVAILABLE') {
                  sendError(res, 500, err.code);
                  return true;
                }
                throw err;
              }
              sendJson(res, 409, {
                error: 'CARRIER_CONFIRMATION_REQUIRED',
                code: 'CARRIER_CONFIRMATION_REQUIRED',
                status: 409,
                confirmationRequired: true,
                carrierToken: previewToken,
                message: '此服务承载控制平面连接，停止将断开当前 ChatGPT 连接。若确认操作，请在确认对话框中继续。'
              });
              return true;
            }

            // carrierToken IS supplied: validate before persisting
            const isValid = await verifyCarrierConfirmation(vault, carrierToken, confirmCtx);
            if (!isValid) {
              sendError(res, 403, 'CARRIER_CONFIRMATION_INVALID');
              return true;
            }
          }

          // Check if already stopped (fast noop check)
          const obs = repo?.registry?.getObserver ? repo.registry.getObserver() : repo?.getObserver?.();
          const currentTc = obs?.peekTunnelClient
            ? obs.peekTunnelClient(id)
            : (repo?.registry?.getServiceRuntime?.(id)?.tunnelClient || repo?.getServiceRuntime?.(id)?.tunnelClient || null);
          if (currentTc?.state === 'stopped' && currentTc?.absenceVerified) {
            sendJson(res, 200, { decision: 'noop', code: 'ALREADY_STOPPED', serviceId: id });
            return true;
          }

          if (!repo?.registry || (typeof repo.registry.createLifecycleAction !== 'function' && typeof repo.registry.createStopAction !== 'function')) {
            sendError(res, 500, 'REGISTRY_NOT_INITIALIZED');
            return true;
          }

          const createFn = typeof repo.registry.createLifecycleAction === 'function'
            ? (args) => repo.registry.createLifecycleAction({ ...args, action: 'stop' })
            : repo.registry.createStopAction;

          const action = await createFn({
            serviceId: id,
            expectedRevision,
            idempotencyKey,
            carrierToken: payload?.carrierToken,
            sessionBinding: auth?.sessionBinding || auth?.sessionId || null
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

        // 9. GET /api/discovery -> { candidates, inventory }
        case 'discoveryScan': {
          let candidates = [];
          if (discovery && typeof discovery.scan === 'function') {
            candidates = await discovery.scan();
          }
          let inventory = [];
          if (discovery && typeof discovery.getInventory === 'function') {
            inventory = await discovery.getInventory();
          }
          sendJson(res, 200, { candidates: candidates || [], inventory: inventory || [] });
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
          const mode = payload?.mode;

          const result = await importer.importCandidate(id, {
            expectedFingerprint,
            expectedRevision,
            mergeProfileId,
            mode
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
        } else if (err.code === 'SOURCE_CHANGED' || err.code === 'MCP_RUNNING' || err.code === 'MCP_BUSY' || err.code === 'RUNTIME_STATE_UNKNOWN' || err.code === 'IDEMPOTENCY_CONFLICT' || err.code === 'STOP_UNCONFIRMED' || err.code === 'MCP_DISABLED' || err.code === 'SERVICE_DISABLED' || err.code === 'PROFILE_NOT_CONFIGURED' || err.code === 'PROFILE_CHANGE_REQUIRES_RESTART' || err.code === 'CARRIER_CONFIRMATION_REQUIRED' || err.code === 'EXTERNAL_CLIENT_NOT_MANAGED' || err.code === 'OPERATION_IN_PROGRESS' || err.code === 'STATE_REFRESH_REQUIRED' || err.code === 'STATE_UNVERIFIED' || err.code === 'PROCESS_IDENTITY_MISMATCH' || err.code === 'PROCESS_IDENTITY_UNVERIFIED' || err.code === 'INVALID_CARRIER_CONFIRMATION_CONTEXT' || err.code === 'INVALID_CARRIER_ACTION') {
          status = 409;
          code = err.code;
        } else if (err.code === 'MCP_NOT_FOUND' || err.code === 'NOT_FOUND' || err.code === 'CANDIDATE_NOT_FOUND' || err.code === 'PROFILE_NOT_FOUND' || err.name === 'NotFoundError') {
          status = 404;
          code = err.code || 'NOT_FOUND';
        } else if (err.code === 'CARRIER_CONFIRMATION_INVALID') {
          status = 403;
          code = err.code;
        } else if (err.code === 'CARRIER_CONFIRMATION_UNAVAILABLE') {
          status = 500;
          code = err.code;
        } else if (err.code === 'PROFILE_REQUIRED' || err.code === 'IDEMPOTENCY_KEY_REQUIRED' || err.code === 'EXECUTABLE_NOT_FOUND' || err.code === 'INVALID_ACTION' || err.code === 'INVALID_REVEAL_ROLE' || err.code === 'INVALID_TARGETS' || err.code === 'INVALID_ENV_NAME' || err.code === 'INVALID_ENV_PATCH' || err.code === 'RESERVED_ENV_NAME' || err.code === 'DUPLICATE_ENV_NAME') {
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

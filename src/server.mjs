import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpRoutes } from './http/mcp-routes.mjs';
import { decideRecoveryAcknowledgement } from './core/recovery-acknowledgement.mjs';

const MAX_BODY_SIZE = 1024 * 1024; // 1MB

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

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
    else if (statusCode === 413) errorCode = 'JSON_LIMIT_EXCEEDED';
    else errorCode = 'INTERNAL_ERROR';
  }
  const payload = JSON.stringify({
    error: {
      code: errorCode,
      status: statusCode
    }
  });
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  };
  if (statusCode === 413) {
    headers['Connection'] = 'close';
  }
  res.writeHead(statusCode, headers);
  res.end(payload);
}

function readJsonBody(req, limit = MAX_BODY_SIZE) {
  return new Promise((resolve, reject) => {
    const contentLength = req.headers['content-length'];
    if (contentLength && parseInt(contentLength, 10) > limit) {
      const err = new Error('Payload Too Large');
      err.status = 413;
      err.code = 'JSON_LIMIT_EXCEEDED';
      req.resume(); // drain
      return reject(err);
    }

    let size = 0;
    const chunks = [];
    let exceeded = false;

    req.on('data', chunk => {
      if (exceeded) return;
      size += chunk.length;
      if (size > limit) {
        exceeded = true;
        req.pause();
        req.resume(); // drain incoming
        const err = new Error('Payload Too Large');
        err.status = 413;
        err.code = 'JSON_LIMIT_EXCEEDED';
        reject(err);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (exceeded) return;
      if (chunks.length === 0) {
        return resolve({});
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        return resolve({});
      }
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed);
      } catch {
        const err = new Error('Invalid JSON');
        err.status = 400;
        err.code = 'INVALID_JSON';
        reject(err);
      }
    });

    req.on('error', err => {
      reject(err);
    });
  });
}

async function runGuard(security, req, res, options = {}) {
  if (!security || typeof security.guard !== 'function') {
    sendError(res, 401, 'UNAUTHORIZED');
    return false;
  }
  req.guardOptions = options;
  const fn = security.guard;
  const fnStr = fn.toString();
  const hasResParam = /\(\s*req\s*,\s*res\b/.test(fnStr) || /\bfunction\s*\w*\s*\(\s*req\s*,\s*res\b/.test(fnStr);

  let result;
  if (fn.length >= 3 || hasResParam) {
    result = await fn.call(security, req, res, options);
  } else if (fn.length === 2 && !hasResParam) {
    result = await fn.call(security, req, options);
  } else if (fn.length === 1) {
    result = await fn.call(security, req, options);
  } else {
    result = await fn.call(security, req, res, options);
  }

  if (res.writableEnded) {
    return false;
  }
  if (result === false) {
    sendError(res, 401, 'UNAUTHORIZED');
    return false;
  }
  if (result && typeof result === 'object' && result.ok === false) {
    sendError(res, result.status || 401, result.code || 'UNAUTHORIZED');
    return false;
  }
  req.authSession = result && typeof result === 'object' ? result : { authenticated: true };
  return true;
}

async function serveStaticFile(publicDir, req, res, urlPath) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendError(res, 405, 'METHOD_NOT_ALLOWED');
  }
  const rawPublicDir = publicDir instanceof URL ? fileURLToPath(publicDir) : publicDir;
  if (!rawPublicDir) {
    return sendError(res, 404, 'NOT_FOUND');
  }

  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return sendError(res, 400, 'BAD_REQUEST');
  }

  if (decoded.includes('\0')) {
    return sendError(res, 403, 'FORBIDDEN');
  }

  // Normalize separators
  const normalized = decoded.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);

  // Strict path traversal defense
  if (segments.some(s => s === '..' || s === '.' || /^[a-zA-Z]:$/.test(s))) {
    return sendError(res, 403, 'FORBIDDEN');
  }

  const resolvedPublicDir = path.resolve(rawPublicDir);
  let safeRelPath = segments.join(path.sep);
  if (!safeRelPath || safeRelPath === 'index.html') {
    safeRelPath = 'index.html';
  }

  const targetPath = path.resolve(resolvedPublicDir, safeRelPath);
  const rel = path.relative(resolvedPublicDir, targetPath);

  if (rel.startsWith('..') || path.isAbsolute(rel) || rel.includes('..')) {
    return sendError(res, 403, 'FORBIDDEN');
  }

  let stat;
  try {
    stat = await fs.promises.stat(targetPath);
  } catch {
    return sendError(res, 404, 'NOT_FOUND');
  }

  if (!stat.isFile()) {
    return sendError(res, 404, 'NOT_FOUND');
  }

  const ext = path.extname(targetPath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  if (req.method === 'HEAD') {
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size
    });
    return res.end();
  }

  try {
    const content = await fs.promises.readFile(targetPath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': content.length
    });
    res.end(content);
  } catch {
    sendError(res, 500, 'INTERNAL_ERROR');
  }
}

export function createHttpServer({
  repo,
  security,
  runner,
  adapters,
  adapterProvider,
  publicDir,
  discovery,
  importer,
  locations,
  vault
} = {}) {
  if (!security || typeof security !== 'object' || typeof security.guard !== 'function') {
    throw new TypeError('SECURITY_REQUIRED: createHttpServer requires a valid security instance with guard function');
  }

  const mcpRoutes = createMcpRoutes({
    repo,
    runner,
    discovery,
    importer,
    locations,
    vault: vault || repo?.vault,
    adapters,
    adapterProvider
  });

  const server = http.createServer(async (req, res) => {
    try {
      // Early strict path traversal check on raw request URL
      const rawPath = (req.url || '/').split('?')[0];
      let decodedRaw;
      try {
        decodedRaw = decodeURIComponent(rawPath);
      } catch {
        return sendError(res, 400, 'BAD_REQUEST');
      }

      if (decodedRaw.includes('\0')) {
        return sendError(res, 403, 'FORBIDDEN');
      }

      const normalizedRaw = decodedRaw.replace(/\\/g, '/');
      if (/(?:^|\/)\.\.(?:$|\/)/.test(normalizedRaw) || /(?:^|\/)[a-zA-Z]:(?:$|\/)/.test(normalizedRaw)) {
        return sendError(res, 403, 'FORBIDDEN');
      }

      const parsedUrl = new URL(req.url, 'http://localhost');
      const pathname = parsedUrl.pathname;
      const method = req.method ? req.method.toUpperCase() : 'GET';

      // 1. Static file handling: non-API paths
      if (!pathname.startsWith('/api/')) {
        await serveStaticFile(publicDir, req, res, pathname);
        return;
      }

      // 2. Auth Routes
      if (pathname === '/api/auth/state') {
        if (method !== 'GET') return sendError(res, 405, 'METHOD_NOT_ALLOWED');
        if (!security) return sendJson(res, 200, { authenticated: false });
        const state = await security.state(req);
        if (!res.writableEnded) {
          sendJson(res, 200, state ?? {});
        }
        return;
      }

      if (pathname === '/api/auth/setup') {
        if (method !== 'POST') return sendError(res, 405, 'METHOD_NOT_ALLOWED');
        if (!security) return sendError(res, 500, 'SECURITY_NOT_CONFIGURED');
        const body = await readJsonBody(req);
        const result = await security.setup(req, res, body);
        if (!res.writableEnded) {
          sendJson(res, 200, result ?? { ok: true });
        }
        return;
      }

      if (pathname === '/api/auth/login') {
        if (method !== 'POST') return sendError(res, 405, 'METHOD_NOT_ALLOWED');
        if (!security) return sendError(res, 500, 'SECURITY_NOT_CONFIGURED');
        const body = await readJsonBody(req);
        const result = await security.login(req, res, body);
        if (!res.writableEnded) {
          sendJson(res, 200, result ?? { ok: true });
        }
        return;
      }

      if (pathname === '/api/auth/logout') {
        if (method !== 'POST') return sendError(res, 405, 'METHOD_NOT_ALLOWED');
        if (!security) return sendError(res, 500, 'SECURITY_NOT_CONFIGURED');
        const result = await security.logout(req, res);
        if (!res.writableEnded) {
          sendJson(res, 200, result ?? { ok: true });
        }
        return;
      }

      // 3. State Route: GET /api/state (guarded)
      if (pathname === '/api/state') {
        if (method !== 'GET') return sendError(res, 405, 'METHOD_NOT_ALLOWED');
        const ok = await runGuard(security, req, res, { write: false });
        if (!ok) return;

        const [revision, profiles, services, recovery] = await Promise.all([
          repo?.getRevision ? repo.getRevision() : 0,
          repo?.listProfiles ? repo.listProfiles() : [],
          repo?.listServices ? repo.listServices() : [],
          repo?.getRecoveryState ? repo.getRecoveryState() : null
        ]);

        const statePayload = { revision, profiles, services, recovery };
        if (repo?.registry || discovery || importer || locations) {
          const mcps = repo?.registry?.listServices ? await repo.registry.listServices() : [];
          const registryRevision = repo?.registry?.getRevision ? await repo.registry.getRevision() : revision;
          statePayload.mcps = mcps;
          statePayload.registryRevision = registryRevision;
        }

        sendJson(res, 200, statePayload);
        return;
      }

      // 4. Profiles Collection: GET /api/profiles, POST /api/profiles
      if (pathname === '/api/profiles') {
        if (method === 'GET') {
          const ok = await runGuard(security, req, res, { write: false });
          if (!ok) return;
          const profiles = repo?.listProfiles ? await repo.listProfiles() : [];
          sendJson(res, 200, profiles);
          return;
        }

        if (method === 'POST') {
          const ok = await runGuard(security, req, res, { write: true });
          if (!ok) return;
          const body = await readJsonBody(req);
          const result = await repo.createProfile(body, { expectedRevision: body?.expectedRevision });
          sendJson(res, 200, result);
          return;
        }

        return sendError(res, 405, 'METHOD_NOT_ALLOWED');
      }

      // 5. Individual Profile: PATCH /api/profiles/:id, DELETE /api/profiles/:id
      const profileMatch = pathname.match(/^\/api\/profiles\/([^/]+)$/);
      if (profileMatch) {
        const id = decodeURIComponent(profileMatch[1]);

        if (method === 'PATCH') {
          const ok = await runGuard(security, req, res, { write: true });
          if (!ok) return;
          const body = await readJsonBody(req);
          const result = await repo.patchProfile(id, body, {
            expectedRevision: body?.expectedRevision,
            profileRevision: body?.profileRevision
          });
          sendJson(res, 200, result);
          return;
        }

        if (method === 'DELETE') {
          const ok = await runGuard(security, req, res, { write: true });
          if (!ok) return;
          const body = await readJsonBody(req);
          const result = await repo.deleteProfile(id, {
            expectedRevision: body?.expectedRevision,
            profileRevision: body?.profileRevision
          });
          sendJson(res, 200, result ?? { ok: true });
          return;
        }

        if (method === 'GET' && typeof repo?.getProfile === 'function') {
          const ok = await runGuard(security, req, res, { write: false });
          if (!ok) return;
          const profile = await repo.getProfile(id);
          if (!profile) return sendError(res, 404, 'NOT_FOUND');
          sendJson(res, 200, profile);
          return;
        }

        return sendError(res, 405, 'METHOD_NOT_ALLOWED');
      }

      // 6. Switch Route: POST /api/switch (guarded, write: true)
      if (pathname === '/api/switch') {
        if (method !== 'POST') return sendError(res, 405, 'METHOD_NOT_ALLOWED');
        const ok = await runGuard(security, req, res, { write: true });
        if (!ok) return;

        const body = await readJsonBody(req);
        const rawIdempotencyKey = req.headers['idempotency-key'] || req.headers['idempotencykey'];
        const idempotencyKey = typeof rawIdempotencyKey === 'string' ? rawIdempotencyKey.trim() || undefined : undefined;

        const op = await repo.createOperation({
          profileId: body?.profileId,
          profileRevision: body?.profileRevision,
          targets: body?.targets,
          expectedRevision: body?.expectedRevision,
          idempotencyKey
        });

        // Return 202 {operation: op}
        const payload = JSON.stringify({ operation: op });
        res.writeHead(202, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        });
        res.end(payload);

        // Then call runner.notify()
        if (runner && typeof runner.notify === 'function') {
          try {
            runner.notify();
          } catch {
            // runner.notify errors must not affect the 202 response
          }
        }
        return;
      }

      // 7. Operation Route: GET /api/operations/:id (guarded)
      const opMatch = pathname.match(/^\/api\/operations\/([^/]+)$/);
      if (opMatch) {
        if (method !== 'GET') return sendError(res, 405, 'METHOD_NOT_ALLOWED');
        const ok = await runGuard(security, req, res, { write: false });
        if (!ok) return;
        const id = decodeURIComponent(opMatch[1]);
        const op = await repo.publicOperation(id);
        if (!op) {
          return sendError(res, 404, 'NOT_FOUND');
        }
        sendJson(res, 200, op);
        return;
      }

      // 7b. Recovery Route: POST /api/recovery/acknowledge (guarded)
      if (pathname === '/api/recovery/acknowledge') {
        if (method !== 'POST') return sendError(res, 405, 'METHOD_NOT_ALLOWED');
        const ok = await runGuard(security, req, res, { write: true });
        if (!ok) return;

        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          return sendError(res, 400, 'BAD_REQUEST');
        }

        const gate = repo?.getRecoveryState ? repo.getRecoveryState() : { gated: false };
        if (!gate.gated) {
          return sendError(res, 409, 'ACTION_NOT_AWAITING_RECOVERY');
        }

        const otherAttentionIds = (typeof repo?.listNeedsAttentionIds === 'function')
          ? repo.listNeedsAttentionIds()
          : [];

        const match = gate.reason?.match(/\b(act_[a-z0-9_-]+|op_[a-z0-9_-]+)\b/i);
        const gateActionId = match ? match[1] : (otherAttentionIds[0] || null);

        const targetActionId = body?.actionId || gateActionId;
        if (!targetActionId) {
          return sendError(res, 400, 'RECOVERY_SCOPE_MISMATCH');
        }

        const action = typeof repo?.loadAction === 'function'
          ? await repo.loadAction(targetActionId)
          : (typeof repo?.registry?.loadAction === 'function' ? await repo.registry.loadAction(targetActionId) : null);

        if (!action) {
          return sendError(res, 404, 'NOT_FOUND');
        }

        // Server-derived evidence: check server truth, never body booleans
        let intentWritten = false;
        let processEffectObserved = false;
        let configChanged = false;

        if (action.serviceId && adapters?.[action.serviceId]) {
          const adapter = adapters[action.serviceId];
          if (adapter.intentPath && fs.existsSync(adapter.intentPath)) {
            intentWritten = true;
          }
          if (adapter.processController && typeof adapter.processController.inspect === 'function') {
            try {
              const insp = await adapter.processController.inspect(action.serviceId);
              if (insp?.running && insp?.managed) {
                processEffectObserved = true;
              }
            } catch (_) {}
          }
        }

        const evidence = {
          phase: 'VALIDATING',
          mayMutate: false,
          intentWritten,
          processEffectObserved,
          configChanged,
          rollbackUncertain: false
        };

        const decision = decideRecoveryAcknowledgement({
          action: {
            id: action.id,
            state: action.state || action.status,
            errorCode: action.errorCode || action.error_code
          },
          gateActionId,
          evidence,
          otherAttentionIds
        });

        if (!decision.allowed) {
          return sendJson(res, 409, {
            ok: false,
            code: decision.code,
            allowed: false
          });
        }

        const withLock = (runner && typeof runner.withExclusiveLock === 'function')
          ? (fn) => runner.withExclusiveLock(fn)
          : (fn) => fn();

        await withLock(async () => {
          if (typeof repo?.acknowledgeRecoveryAction === 'function') {
            return await repo.acknowledgeRecoveryAction({
              actionId: action.id,
              clearGate: decision.clearGate
            });
          } else {
            if (typeof repo?.registry?.transitionAction === 'function') {
              await repo.registry.transitionAction(action.id, {
                state: 'REJECTED'
              });
            }
            if (decision.clearGate && typeof repo?.resetRecoveryGate === 'function') {
              repo.resetRecoveryGate();
            }
            return { ok: true, actionId: action.id, clearGate: decision.clearGate };
          }
        });

        sendJson(res, 200, {
          ok: true,
          code: decision.code,
          clearGate: decision.clearGate,
          remainingAttentionIds: decision.remainingAttentionIds,
          actionId: action.id
        });
        return;
      }

      // 8. MCP Registry & Discovery Routes: /api/mcps, /api/discovery
      if (pathname.startsWith('/api/mcps') || pathname.startsWith('/api/discovery')) {
        const isWrite = method === 'POST' || method === 'PATCH' || method === 'DELETE' || method === 'PUT';
        const ok = await runGuard(security, req, res, { write: isWrite });
        if (!ok) return;

        const auth = req.authSession || { authenticated: true };
        const body = isWrite ? await readJsonBody(req) : {};
        const handled = await mcpRoutes.handle({
          req,
          res,
          url: parsedUrl,
          body,
          auth
        });
        if (handled) return;

        return sendError(res, 404, 'NOT_FOUND');
      }

      // 9. Unknown API Route
      sendError(res, 404, 'NOT_FOUND');

    } catch (err) {
      if (!res.writableEnded) {
        let status = err.status || err.statusCode;
        let code = err.code;

        if (!status) {
          if (err.name === 'ConflictError' || code === 'CONFLICT' || /conflict/i.test(err.message || '')) {
            status = 409;
            code = code || 'CONFLICT';
          } else if (err.name === 'NotFoundError' || code === 'NOT_FOUND') {
            status = 404;
            code = code || 'NOT_FOUND';
          } else if (err.name === 'UnauthorizedError' || code === 'UNAUTHORIZED') {
            status = 401;
            code = code || 'UNAUTHORIZED';
          } else if (err.name === 'ForbiddenError' || code === 'FORBIDDEN') {
            status = 403;
            code = code || 'FORBIDDEN';
          } else {
            status = 500;
            code = code || 'INTERNAL_ERROR';
          }
        }
        sendError(res, status, code);
      }
    }
  });

  return server;
}

export default createHttpServer;

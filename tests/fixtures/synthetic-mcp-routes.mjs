import { RegistryPolicyFault } from '../../src/core/mcp-registry-policy.mjs';

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
  const payload = JSON.stringify({
    error: {
      code: code || 'ERROR',
      status: statusCode
    }
  });
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

export function createMcpRoutes({ repo, runner, discovery, importer, locations }) {
  async function handle({ req, res, url, body, auth }) {
    if (!auth) {
      sendError(res, 401, 'UNAUTHORIZED');
      return true;
    }

    const pathname = url.pathname;
    const method = req.method.toUpperCase();

    try {
      // 1. Discovery
      if (pathname === '/api/discovery' && method === 'GET') {
        const candidates = discovery ? await discovery.scan() : [];
        sendJson(res, 200, { candidates });
        return true;
      }

      const importMatch = pathname.match(/^\/api\/discovery\/([^/]+)\/import$/);
      if (importMatch && method === 'POST') {
        const candidateId = importMatch[1];
        if (!importer) {
          sendError(res, 501, 'NOT_IMPLEMENTED');
          return true;
        }
        const result = await importer.importCandidate(candidateId, {
          expectedFingerprint: body?.expectedFingerprint,
          expectedRevision: body?.expectedRevision,
          mergeProfileId: body?.mergeProfileId
        });
        sendJson(res, result.created ? 201 : 200, result);
        return true;
      }

      // 2. MCPs CRUD
      if (pathname === '/api/mcps' && method === 'GET') {
        const services = repo.registry ? repo.registry.listServices() : [];
        const rev = repo.getRevision ? repo.getRevision() : 0;
        sendJson(res, 200, { mcps: services, revision: rev });
        return true;
      }

      if (pathname === '/api/mcps' && method === 'POST') {
        if (!repo.registry) {
          sendError(res, 501, 'NOT_IMPLEMENTED');
          return true;
        }
        const created = await repo.registry.create(body, { expectedRevision: body?.expectedRevision });
        const rev = repo.getRevision ? repo.getRevision() : 0;
        sendJson(res, 201, { mcp: created, revision: rev });
        return true;
      }

      const mcpStopMatch = pathname.match(/^\/api\/mcps\/([^/]+)\/stop$/);
      if (mcpStopMatch && method === 'POST') {
        const serviceId = mcpStopMatch[1];
        const idempotencyKey = req.headers['idempotency-key'] || req.headers['x-idempotency-key'];
        const action = await repo.registry.createStopAction({
          serviceId,
          expectedRevision: body?.expectedRevision,
          idempotencyKey
        });
        if (runner && typeof runner.wake === 'function') {
          runner.wake();
        }
        sendJson(res, 202, action);
        return true;
      }

      const mcpLocationsMatch = pathname.match(/^\/api\/mcps\/([^/]+)\/locations$/);
      if (mcpLocationsMatch && method === 'GET') {
        const serviceId = mcpLocationsMatch[1];
        const def = repo.registry ? repo.registry.getDefinition(serviceId) : null;
        if (!def) {
          sendError(res, 404, 'MCP_NOT_FOUND');
          return true;
        }
        const locs = locations ? await locations.describe(def) : {};
        sendJson(res, 200, locs);
        return true;
      }

      const mcpRevealMatch = pathname.match(/^\/api\/mcps\/([^/]+)\/reveal$/);
      if (mcpRevealMatch && method === 'POST') {
        const serviceId = mcpRevealMatch[1];
        const def = repo.registry ? repo.registry.getDefinition(serviceId) : null;
        if (!def) {
          sendError(res, 404, 'MCP_NOT_FOUND');
          return true;
        }
        const result = locations ? await locations.reveal(def, body?.role) : { revealed: false };
        sendJson(res, 200, result);
        return true;
      }

      const mcpIdMatch = pathname.match(/^\/api\/mcps\/([^/]+)$/);
      if (mcpIdMatch) {
        const serviceId = mcpIdMatch[1];
        if (method === 'GET') {
          const list = repo.registry ? repo.registry.listServices() : [];
          const found = list.find(s => s.id === serviceId);
          if (!found) {
            sendError(res, 404, 'MCP_NOT_FOUND');
            return true;
          }
          sendJson(res, 200, { mcp: found, revision: repo.getRevision ? repo.getRevision() : 0 });
          return true;
        } else if (method === 'PATCH') {
          const updated = await repo.registry.update(serviceId, body, { expectedRevision: body?.expectedRevision });
          sendJson(res, 200, { mcp: updated, revision: repo.getRevision ? repo.getRevision() : 0 });
          return true;
        } else if (method === 'DELETE') {
          const result = await repo.registry.remove(serviceId, { expectedRevision: body?.expectedRevision });
          sendJson(res, 200, result);
          return true;
        }
      }

      return false;
    } catch (err) {
      const status = err.status || (err instanceof RegistryPolicyFault ? err.status : 500);
      const code = err.code || 'INTERNAL_ERROR';
      sendError(res, status, code);
      return true;
    }
  }

  return {
    handle
  };
}

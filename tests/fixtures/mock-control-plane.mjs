import http from 'node:http';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/**
 * Mock Control Plane server simulating the OpenAI / MCP tunnel control plane service.
 * Supports:
 * - Bearer token & API key authentication
 * - Configurable accepted tunnel ID and API key pairs
 * - 401 Unauthorized for invalid keys
 * - 404 / 403 for mismatched tunnel targets
 * - Inspection of received polling requests
 * - Standalone CLI execution or programmatic lifecycle
 */
export function createMockControlPlane(options = {}) {
  let server = null;
  const requests = [];
  const accepted = new Map(); // tunnelId -> apiKey
  let rejectAll = Boolean(options.rejectAll);
  let defaultStatusCode = options.defaultStatusCode || 200;

  if (options.accepted) {
    if (options.accepted instanceof Map) {
      for (const [t, k] of options.accepted.entries()) {
        accepted.set(String(t), String(k));
      }
    } else {
      for (const [t, k] of Object.entries(options.accepted)) {
        accepted.set(String(t), String(k));
      }
    }
  }

  function parseAuthorization(req) {
    const authHeader = req.headers['authorization'] || '';
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    if (bearerMatch) {
      return bearerMatch[1].trim();
    }
    const xApiKey = req.headers['x-api-key'] || req.headers['api-key'];
    if (xApiKey && typeof xApiKey === 'string') {
      return xApiKey.trim();
    }
    return '';
  }

  function parseTunnelId(req, parsedUrl) {
    const headerTid = req.headers['x-tunnel-id'] || req.headers['tunnel-id'];
    if (headerTid && typeof headerTid === 'string') {
      return headerTid.trim();
    }
    const queryTid = parsedUrl.searchParams.get('tunnel_id') || parsedUrl.searchParams.get('tunnelId');
    if (queryTid) {
      return queryTid.trim();
    }
    const pathMatch = parsedUrl.pathname.match(/\/tunnels?\/([a-zA-Z0-9_\-]+)/);
    if (pathMatch) {
      return pathMatch[1];
    }
    return '';
  }

  function handleRequest(req, res) {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });

    req.on('end', () => {
      const parsedUrl = new URL(req.url, 'http://127.0.0.1');
      const providedKey = parseAuthorization(req);
      const tunnelId = parseTunnelId(req, parsedUrl);

      const record = {
        method: req.method,
        url: req.url,
        pathname: parsedUrl.pathname,
        headers: req.headers,
        body,
        providedKey,
        tunnelId,
        timestamp: new Date().toISOString()
      };
      requests.push(record);

      if (typeof options.onRequest === 'function') {
        const customRes = options.onRequest(req, res, record);
        if (customRes) return;
      }

      // Root/health endpoint
      if (parsedUrl.pathname === '/health' || parsedUrl.pathname === '/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          status: 'healthy',
          service: 'mock-control-plane',
          timestamp: new Date().toISOString()
        }));
        return;
      }

      if (rejectAll) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'unauthorized',
          status: 401,
          message: 'All requests rejected by control plane configuration'
        }));
        return;
      }

      if (accepted.size > 0) {
        if (!providedKey) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'unauthorized',
            status: 401,
            message: 'Missing required API key in Authorization header or x-api-key'
          }));
          return;
        }

        // If a specific tunnelId is targeted, verify both tunnelId and matching key
        if (tunnelId && accepted.has(tunnelId)) {
          const expectedKey = accepted.get(tunnelId);
          if (expectedKey !== providedKey) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: 'unauthorized',
              status: 401,
              message: 'Invalid API key for the requested tunnel'
            }));
            return;
          }
        } else if (tunnelId && !accepted.has(tunnelId)) {
          // Tunnel target unknown to control plane
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'not_found',
            status: 404,
            message: `Target tunnel '${tunnelId}' not registered on control plane`
          }));
          return;
        } else {
          // No tunnelId specified, check if providedKey matches ANY accepted tunnel
          const validKeys = Array.from(accepted.values());
          if (!validKeys.includes(providedKey)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: 'unauthorized',
              status: 401,
              message: 'Unrecognized API key'
            }));
            return;
          }
        }
      }

      // Default success
      res.writeHead(defaultStatusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        status: 'ok',
        authenticated: true,
        tunnel_id: tunnelId || 'default-tunnel',
        server: 'mock-control-plane',
        timestamp: new Date().toISOString()
      }));
    });
  }

  return {
    async start(port = 0, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server = http.createServer(handleRequest);
        server.listen(port, host, () => {
          const addr = server.address();
          const url = `http://${host}:${addr.port}`;
          resolve({
            port: addr.port,
            host,
            url,
            baseUrl: url,
            close: () => this.close()
          });
        });
        server.on('error', reject);
      });
    },

    async close() {
      if (!server) return;
      return new Promise((resolve) => {
        server.close(() => {
          server = null;
          resolve();
        });
      });
    },

    setAcceptedCredential(tunnelId, apiKey) {
      accepted.set(String(tunnelId), String(apiKey));
    },

    removeAcceptedCredential(tunnelId) {
      accepted.delete(String(tunnelId));
    },

    clearAcceptedCredentials() {
      accepted.clear();
    },

    setRejectAll(value) {
      rejectAll = Boolean(value);
    },

    setStatusCode(code) {
      defaultStatusCode = Number(code) || 200;
    },

    getRequests() {
      return [...requests];
    },

    getLastRequest() {
      return requests.length > 0 ? requests[requests.length - 1] : null;
    },

    clearRequests() {
      requests.length = 0;
    }
  };
}

// Standalone execution support
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let port = 0;
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--port' || process.argv[i] === '-p') {
      port = parseInt(process.argv[++i], 10);
    }
  }

  const cp = createMockControlPlane({
    accepted: {
      'test-tunnel': 'test-secret-key'
    }
  });

  const running = await cp.start(port);
  console.log(`[mock-control-plane] Listening on ${running.url}`);
  console.log(`MOCK_CONTROL_PLANE_URL=${running.url}`);

  const shutdown = async () => {
    console.log('[mock-control-plane] Shutting down...');
    await cp.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

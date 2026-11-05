import http from 'node:http';
import { pathToFileURL } from 'node:url';

/**
 * Loopback synthetic HTTP MCP server tracking incoming URL, query, and headers.
 * Used to verify that tunnel-client / fake daemon consumers forward the exact
 * requested MCP_SERVER_URL and header environment references.
 */
export function createSyntheticHttpMcp(options = {}) {
  const recordedRequests = [];
  const openSockets = new Set();
  let server = null;

  function handleRequest(req, res) {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });

    req.on('end', () => {
      const parsed = new URL(req.url, 'http://127.0.0.1');
      const record = {
        method: req.method,
        url: req.url,
        pathname: parsed.pathname,
        search: parsed.search,
        searchParams: Object.fromEntries(parsed.searchParams.entries()),
        headers: { ...req.headers },
        rawHeaders: req.rawHeaders ? [...req.rawHeaders] : [],
        body,
        timestamp: new Date().toISOString()
      };

      recordedRequests.push(record);

      if (typeof options.onRequest === 'function') {
        const handled = options.onRequest(req, res, record);
        if (handled) return;
      }

      const statusCode = options.statusCode || 200;
      const responsePayload = options.response || {
        jsonrpc: '2.0',
        result: {
          status: 'ok',
          server: 'synthetic-http-mcp',
          receivedUrl: req.url,
          receivedHeaders: req.headers
        },
        id: 1
      };

      res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'X-Synthetic-Mcp': '1.0'
      });
      res.end(typeof responsePayload === 'string' ? responsePayload : JSON.stringify(responsePayload));
    });
  }

  function close() {
    for (const socket of openSockets) {
      try {
        socket.destroy();
      } catch (_) {}
    }
    openSockets.clear();

    if (server) {
      return new Promise((resolve) => {
        server.close(() => {
          server = null;
          resolve();
        });
      });
    }
    return Promise.resolve();
  }

  const instance = {
    recordedRequests,
    requests: recordedRequests,

    getRequests() {
      return [...recordedRequests];
    },

    getLastRequest() {
      return recordedRequests.length > 0 ? recordedRequests[recordedRequests.length - 1] : null;
    },

    clearRequests() {
      recordedRequests.length = 0;
    },

    async start(port = 0, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server = http.createServer(handleRequest);

        server.on('connection', socket => {
          openSockets.add(socket);
          socket.on('close', () => openSockets.delete(socket));
        });

        server.listen(port, host, () => {
          const addr = server.address();
          const actualPort = addr.port;
          const baseUrl = `http://${host}:${actualPort}`;

          resolve({
            port: actualPort,
            host,
            url: baseUrl,
            endpoint: `${baseUrl}/mcp`,
            server,
            close,
            stop: close,
            getRequests: () => instance.getRequests(),
            getLastRequest: () => instance.getLastRequest(),
            clearRequests: () => instance.clearRequests()
          });
        });

        server.on('error', reject);
      });
    },

    close,
    stop: close
  };

  return instance;
}

export const createSyntheticHttpMcpServer = createSyntheticHttpMcp;

if (process.argv[1] && (
  import.meta.url === pathToFileURL(process.argv[1]).href ||
  process.argv[1].endsWith('synthetic-http-mcp.mjs')
)) {
  const port = parseInt(process.env.PORT || '0', 10);
  const mcp = createSyntheticHttpMcp();
  const info = await mcp.start(port);
  console.log(`[synthetic-http-mcp] Listening on ${info.url}`);
}

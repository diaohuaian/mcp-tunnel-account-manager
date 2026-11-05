import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHttpServer } from '../src/server.mjs';
import { matchMcpRoute, sanitizeMcpDto } from '../src/http/mcp-routes.mjs';

function createMockSecurity(overrides = {}) {
  let authenticated = true;
  const sessions = new Map();
  sessions.set('test-session', { csrfToken: 'test-csrf-token' });

  return {
    guard: async (req, res, options = {}) => {
      if (overrides.denyAuth) return false;
      const sid = req.headers.cookie?.match(/sid=([^;]+)/)?.[1];
      if (!sid || sid !== 'test-session') {
        const err = new Error('Unauthorized');
        err.status = 401;
        err.code = 'UNAUTHORIZED';
        throw err;
      }
      const isWrite = Boolean(options.write);
      const token = req.headers['x-csrf-token'];
      if (isWrite) {
        if (overrides.denyCsrf || !token || token !== 'test-csrf-token') {
          const err = new Error('Invalid CSRF');
          err.code = 'FORBIDDEN';
          err.status = 403;
          throw err;
        }
      }
      return { authenticated: true, sessionId: 'test-session', csrfToken: 'test-csrf-token' };
    },
    state: async () => ({ configured: true, authenticated, csrfToken: 'test-csrf-token' }),
    setup: async () => ({ ok: true }),
    login: async () => ({ ok: true }),
    logout: async () => ({ ok: true }),
    close: async () => {}
  };
}

function startServer(options = {}) {
  const security = options.security || createMockSecurity();
  return new Promise((resolve, reject) => {
    try {
      const server = createHttpServer({
        ...options,
        security
      });
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        resolve({
          server,
          baseUrl: `http://127.0.0.1:${port}`,
          close: () => new Promise((res) => {
            server.closeAllConnections?.();
            server.close(res);
          })
        });
      });
    } catch (err) {
      reject(err);
    }
  });
}

const AUTH_HEADERS = {
  'Content-Type': 'application/json',
  'Cookie': 'sid=test-session',
  'X-CSRF-Token': 'test-csrf-token'
};

describe('MCP Routes & HTTP Endpoints Tests', () => {
  // =========================================================================
  // 1. matchMcpRoute pure matcher tests
  // =========================================================================
  describe('1. matchMcpRoute matcher', () => {
    test('matches GET and POST /api/mcps', () => {
      assert.deepEqual(matchMcpRoute('/api/mcps', 'GET'), { route: 'listMcps', params: {} });
      assert.deepEqual(matchMcpRoute('/api/mcps', 'POST'), { route: 'createMcp', params: {} });
      assert.deepEqual(matchMcpRoute('/api/mcps', 'DELETE'), { route: 'methodNotAllowed', params: {} });
    });

    test('matches /api/mcps/:id parameterized routes', () => {
      assert.deepEqual(matchMcpRoute('/api/mcps/mcp_test', 'GET'), { route: 'getMcp', params: { id: 'mcp_test' } });
      assert.deepEqual(matchMcpRoute('/api/mcps/mcp_test', 'PATCH'), { route: 'updateMcp', params: { id: 'mcp_test' } });
      assert.deepEqual(matchMcpRoute('/api/mcps/mcp_test', 'DELETE'), { route: 'deleteMcp', params: { id: 'mcp_test' } });
    });

    test('matches locations, reveal, and stop routes', () => {
      assert.deepEqual(matchMcpRoute('/api/mcps/mcp_test/locations', 'GET'), { route: 'getMcpLocations', params: { id: 'mcp_test' } });
      assert.deepEqual(matchMcpRoute('/api/mcps/mcp_test/reveal', 'POST'), { route: 'mcpReveal', params: { id: 'mcp_test' } });
      assert.deepEqual(matchMcpRoute('/api/mcps/mcp_test/stop', 'POST'), { route: 'mcpStop', params: { id: 'mcp_test' } });
    });

    test('matches discovery routes', () => {
      assert.deepEqual(matchMcpRoute('/api/discovery', 'GET'), { route: 'discoveryScan', params: {} });
      assert.deepEqual(matchMcpRoute('/api/discovery/cand_123/import', 'POST'), { route: 'discoveryImport', params: { id: 'cand_123' } });
    });

    test('returns null for unrelated paths', () => {
      assert.equal(matchMcpRoute('/api/other'), null);
      assert.equal(matchMcpRoute('/api/profiles'), null);
    });
  });

  // =========================================================================
  // 2. sanitizeMcpDto helper tests
  // =========================================================================
  describe('2. sanitizeMcpDto helper', () => {
    test('masks secret binding arguments and environment variables', () => {
      const raw = {
        id: 'mcp_sample',
        label: 'Sample',
        revision: 2,
        binding: {
          type: 'stdio',
          executable: 'node.exe',
          args: [
            { id: 'arg_pub', value: '--verbose', secret: false },
            { id: 'arg_sec', value: 'secret_token_123', secret: true }
          ]
        },
        environment: {
          API_KEY: { value: 'api_secret_456', secret: true },
          LOG_LEVEL: { value: 'info', secret: false }
        }
      };

      const sanitized = sanitizeMcpDto(raw);
      assert.equal(sanitized.id, 'mcp_sample');
      assert.equal(sanitized.binding.args[0].value, '--verbose');
      assert.equal(sanitized.binding.args[1].value, undefined);
      assert.equal(sanitized.binding.args[1].secret, true);

      const apiKeyEnv = sanitized.environment.find((e) => e.name === 'API_KEY');
      assert.equal(apiKeyEnv.value, undefined);
      assert.equal(apiKeyEnv.secret, true);

      const logLevelEnv = sanitized.environment.find((e) => e.name === 'LOG_LEVEL');
      assert.equal(logLevelEnv.value, 'info');
      assert.equal(logLevelEnv.secret, false);

      assert.equal(JSON.stringify(sanitized).includes('secret_token_123'), false);
      assert.equal(JSON.stringify(sanitized).includes('api_secret_456'), false);
    });

    test('sanitizes HTTP binding: private query raw URL absent, safe urlDisplay/urlConfigured/hasPrivateQuery retained', () => {
      const raw = {
        id: 'mcp_http_service',
        label: 'HTTP Service',
        revision: 1,
        binding: {
          type: 'http',
          url: 'https://example.com/api/v1?token=supersecret123&publicParam=42',
          headers: {
            'Authorization': { value: 'Bearer topsecret', secret: true },
            'X-Public-Header': { value: 'normal-value', secret: false }
          }
        }
      };

      const sanitized = sanitizeMcpDto(raw);
      assert.equal(sanitized.id, 'mcp_http_service');
      assert.equal(sanitized.binding.type, 'http');
      assert.equal(sanitized.binding.url, undefined, 'Raw URL with private query must be absent');
      assert.equal(sanitized.binding.urlDisplay, 'https://example.com/api/v1', 'Safe urlDisplay without private query');
      assert.equal(sanitized.binding.urlConfigured, true);
      assert.equal(sanitized.binding.hasPrivateQuery, true);

      // Secret headers masked without placeholder writeback
      assert.deepEqual(sanitized.binding.headers['Authorization'], { secret: true, configured: true });
      assert.deepEqual(sanitized.binding.headers['X-Public-Header'], { secret: false, configured: true, value: 'normal-value' });

      // Entire serialized JSON must not contain secret token or auth value
      const jsonStr = JSON.stringify(sanitized);
      assert.equal(jsonStr.includes('supersecret123'), false);
      assert.equal(jsonStr.includes('topsecret'), false);

      // Safe urlDisplay, urlConfigured, hasPrivateQuery retained through public input
      const reprocessed = sanitizeMcpDto(sanitized);
      assert.equal(reprocessed.binding.url, undefined);
      assert.equal(reprocessed.binding.urlDisplay, 'https://example.com/api/v1');
      assert.equal(reprocessed.binding.urlConfigured, true);
      assert.equal(reprocessed.binding.hasPrivateQuery, true);
      assert.deepEqual(reprocessed.binding.headers['Authorization'], { secret: true, configured: true });
    });

    test('sanitizes HTTP binding: public query retains url and urlDisplay without hasPrivateQuery flag', () => {
      const raw = {
        id: 'mcp_public_http',
        label: 'Public HTTP Service',
        revision: 1,
        binding: {
          type: 'http',
          url: 'https://example.com/api?version=2&format=json',
          headers: {
            'Accept': { value: 'application/json', secret: false }
          }
        }
      };

      const sanitized = sanitizeMcpDto(raw);
      assert.equal(sanitized.binding.url, 'https://example.com/api?version=2&format=json');
      assert.equal(sanitized.binding.urlDisplay, 'https://example.com/api?version=2&format=json');
      assert.equal(sanitized.binding.urlConfigured, true);
      assert.equal(sanitized.binding.hasPrivateQuery, undefined);
    });
  });

  // =========================================================================
  // 3. Authenticated CRUD Endpoints: GET, POST, PATCH, DELETE /api/mcps
  // =========================================================================
  describe('3. MCP CRUD HTTP Endpoints', () => {
    let ctx;
    let globalRev = 10;
    const services = new Map();

    before(async () => {
      services.set('overleaf-mcp', {
        id: 'overleaf-mcp',
        label: 'Overleaf MCP',
        enabled: true,
        revision: 1,
        sortOrder: 100
      });
      services.set('antigravity-mcp', {
        id: 'antigravity-mcp',
        label: 'Antigravity MCP',
        enabled: true,
        revision: 1,
        controlCarrier: true,
        sortOrder: 1000
      });

      const fakeRepo = {
        getRevision: async () => globalRev,
        registry: {
          listServices: async () => Array.from(services.values()),
          getService: async (id) => services.get(id) || null,
          getDefinition: async (id) => services.get(id) || null,
          create: async (input, { expectedRevision }) => {
            if (expectedRevision !== undefined && expectedRevision !== globalRev) {
              const err = new Error('Revision conflict');
              err.code = 'REVISION_CONFLICT';
              err.status = 409;
              throw err;
            }
            const id = input.id || `mcp_${Date.now()}`;
            const newSvc = {
              id,
              label: input.label || id,
              enabled: input.enabled !== false,
              revision: 1,
              binding: input.binding,
              environment: input.environment
            };
            services.set(id, newSvc);
            globalRev++;
            return newSvc;
          },
          update: async (id, patch, { expectedRevision }) => {
            if (expectedRevision !== undefined && expectedRevision !== globalRev) {
              const err = new Error('Revision conflict');
              err.code = 'REVISION_CONFLICT';
              err.status = 409;
              throw err;
            }
            const existing = services.get(id);
            if (!existing) {
              const err = new Error('Not found');
              err.code = 'MCP_NOT_FOUND';
              err.status = 404;
              throw err;
            }
            const updated = {
              ...existing,
              ...patch,
              revision: existing.revision + 1
            };
            services.set(id, updated);
            globalRev++;
            return updated;
          },
          remove: async (id, { expectedRevision }) => {
            if (expectedRevision !== undefined && expectedRevision !== globalRev) {
              const err = new Error('Revision conflict');
              err.code = 'REVISION_CONFLICT';
              err.status = 409;
              throw err;
            }
            const existing = services.get(id);
            if (!existing) {
              const err = new Error('Not found');
              err.code = 'MCP_NOT_FOUND';
              err.status = 404;
              throw err;
            }
            if (existing.runtimeState === 'running') {
              const err = new Error('MCP is currently running');
              err.code = 'MCP_RUNNING';
              err.status = 409;
              throw err;
            }
            services.delete(id);
            globalRev++;
            return { ok: true, deleted: true, id, effect: 'archive_registration' };
          }
        }
      };

      ctx = await startServer({ repo: fakeRepo });
    });

    after(async () => {
      await ctx.close();
    });

    test('GET /api/mcps requires auth and returns { mcps, revision }', async () => {
      // Unauthenticated request fails with 401
      const unauthRes = await fetch(`${ctx.baseUrl}/api/mcps`);
      assert.equal(unauthRes.status, 401);

      // Authenticated request succeeds
      const res = await fetch(`${ctx.baseUrl}/api/mcps`, { headers: AUTH_HEADERS });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data.mcps));
      assert.equal(data.mcps.length, 2);
      assert.equal(data.revision, 10);
      assert.equal(data.mcps[0].id, 'overleaf-mcp');
    });

    test('POST /api/mcps creates a new MCP with 201 status and increments revision', async () => {
      const payload = {
        id: 'mcp_custom_git',
        label: 'Custom Git MCP',
        expectedRevision: 10,
        binding: {
          type: 'stdio',
          executable: 'git.exe',
          args: [{ id: 'a1', value: '--version', secret: false }]
        }
      };

      // Missing CSRF fails
      const noCsrfRes = await fetch(`${ctx.baseUrl}/api/mcps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Cookie': 'sid=test-session' },
        body: JSON.stringify(payload)
      });
      assert.equal(noCsrfRes.status, 403);

      // Valid request succeeds
      const res = await fetch(`${ctx.baseUrl}/api/mcps`, {
        method: 'POST',
        headers: AUTH_HEADERS,
        body: JSON.stringify(payload)
      });
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.mcp.id, 'mcp_custom_git');
      assert.equal(data.mcp.label, 'Custom Git MCP');
      assert.equal(data.revision, 11);
    });

    test('POST /api/mcps returns 409 on revision conflict', async () => {
      const payload = {
        id: 'mcp_conflict',
        expectedRevision: 999 // stale revision
      };
      const res = await fetch(`${ctx.baseUrl}/api/mcps`, {
        method: 'POST',
        headers: AUTH_HEADERS,
        body: JSON.stringify(payload)
      });
      assert.equal(res.status, 409);
      const data = await res.json();
      assert.equal(data.error.code, 'REVISION_CONFLICT');
    });

    test('GET /api/mcps/:id returns single MCP or 404', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/mcps/mcp_custom_git`, { headers: AUTH_HEADERS });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.mcp.id, 'mcp_custom_git');
      assert.equal(data.revision, 11);

      const notFoundRes = await fetch(`${ctx.baseUrl}/api/mcps/mcp_nonexistent`, { headers: AUTH_HEADERS });
      assert.equal(notFoundRes.status, 404);
      const notFoundData = await notFoundRes.json();
      assert.equal(notFoundData.error.code, 'MCP_NOT_FOUND');
    });

    test('PATCH /api/mcps/:id updates MCP attributes', async () => {
      const patch = {
        label: 'Updated Git Server',
        expectedRevision: 11
      };
      const res = await fetch(`${ctx.baseUrl}/api/mcps/mcp_custom_git`, {
        method: 'PATCH',
        headers: AUTH_HEADERS,
        body: JSON.stringify(patch)
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.mcp.label, 'Updated Git Server');
      assert.equal(data.revision, 12);
    });

    test('DELETE /api/mcps/:id removes registration', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/mcps/mcp_custom_git`, {
        method: 'DELETE',
        headers: AUTH_HEADERS,
        body: JSON.stringify({ expectedRevision: 12 })
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.deleted, true);
      assert.equal(data.id, 'mcp_custom_git');

      // Verify it is gone
      const verifyRes = await fetch(`${ctx.baseUrl}/api/mcps/mcp_custom_git`, { headers: AUTH_HEADERS });
      assert.equal(verifyRes.status, 404);
    });

    test('DELETE /api/mcps/:id returns 409 if service is running', async () => {
      services.set('mcp_running', {
        id: 'mcp_running',
        label: 'Running Svc',
        runtimeState: 'running'
      });

      const res = await fetch(`${ctx.baseUrl}/api/mcps/mcp_running`, {
        method: 'DELETE',
        headers: AUTH_HEADERS,
        body: JSON.stringify({ expectedRevision: 13 })
      });
      assert.equal(res.status, 409);
      const data = await res.json();
      assert.equal(data.error.code, 'MCP_RUNNING');
    });

    test('POST /api/mcps creates HTTP MCP with private query and returns sanitized public DTO', async () => {
      const payload = {
        id: 'mcp_secure_remote',
        label: 'Secure Remote MCP',
        expectedRevision: 13,
        binding: {
          type: 'http',
          url: 'https://remote.internal/mcp?sig=private_sig_abc&param=1',
          headers: {
            'Authorization': { value: 'Bearer secret_bearer_token', secret: true }
          }
        }
      };

      const res = await fetch(`${ctx.baseUrl}/api/mcps`, {
        method: 'POST',
        headers: AUTH_HEADERS,
        body: JSON.stringify(payload)
      });
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.mcp.id, 'mcp_secure_remote');
      assert.equal(data.mcp.binding.type, 'http');
      assert.equal(data.mcp.binding.url, undefined, 'Raw private query url absent in POST response');
      assert.equal(data.mcp.binding.urlDisplay, 'https://remote.internal/mcp');
      assert.equal(data.mcp.binding.urlConfigured, true);
      assert.equal(data.mcp.binding.hasPrivateQuery, true);
      assert.deepEqual(data.mcp.binding.headers.Authorization, { secret: true, configured: true });
      assert.equal(data.revision, 14);

      // Verify GET /api/mcps/:id returns matching sanitized DTO
      const getRes = await fetch(`${ctx.baseUrl}/api/mcps/mcp_secure_remote`, { headers: AUTH_HEADERS });
      assert.equal(getRes.status, 200);
      const getData = await getRes.json();
      assert.equal(getData.mcp.binding.url, undefined);
      assert.equal(getData.mcp.binding.urlDisplay, 'https://remote.internal/mcp');
      assert.equal(getData.mcp.binding.hasPrivateQuery, true);

      // Cleanup
      services.delete('mcp_secure_remote');
    });
  });

  // =========================================================================
  // 4. Locations & Reveal Endpoints: GET locations, POST reveal
  // =========================================================================
  describe('4. Locations & Reveal Endpoints', () => {
    let ctx;
    let revealedRole = null;

    before(async () => {
      const fakeRepo = {
        getRevision: async () => 1,
        registry: {
          getDefinition: async (id) => {
            if (id === 'mcp_loc_test') {
              return {
                id: 'mcp_loc_test',
                label: 'Location Test Service',
                binding: { executable: 'C:\\tools\\loc.exe', cwd: 'C:\\tools' }
              };
            }
            return null;
          },
          getServiceRuntime: async (id) => ({ state: 'stopped', pid: null })
        }
      };

      const fakeLocations = {
        describe: async (def, runtime) => ({
          sourceConfigPath: 'C:\\config\\loc.yaml',
          effectiveConfigPath: null,
          managerStorePath: 'C:\\data\\manager.db',
          installationRoot: 'C:\\tools',
          executable: 'C:\\tools\\loc.exe',
          cwd: 'C:\\tools'
        }),
        reveal: async (def, role, runtime) => {
          revealedRole = role;
          return { ok: true, opened: true, role };
        }
      };

      ctx = await startServer({ repo: fakeRepo, locations: fakeLocations });
    });

    after(async () => {
      await ctx.close();
    });

    test('GET /api/mcps/:id/locations returns path descriptors', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/mcps/mcp_loc_test/locations`, { headers: AUTH_HEADERS });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.executable, 'C:\\tools\\loc.exe');
      assert.equal(data.installationRoot, 'C:\\tools');
      assert.equal(data.managerStorePath, 'C:\\data\\manager.db');

      // 404 for missing service
      const missingRes = await fetch(`${ctx.baseUrl}/api/mcps/mcp_unknown/locations`, { headers: AUTH_HEADERS });
      assert.equal(missingRes.status, 404);
    });

    test('POST /api/mcps/:id/reveal validates role', async () => {
      // Invalid role rejected with 400
      const badRoleRes = await fetch(`${ctx.baseUrl}/api/mcps/mcp_loc_test/reveal`, {
        method: 'POST',
        headers: AUTH_HEADERS,
        body: JSON.stringify({ role: 'arbitraryCommandExecution' })
      });
      assert.equal(badRoleRes.status, 400);
      const badData = await badRoleRes.json();
      assert.equal(badData.error.code, 'INVALID_REVEAL_ROLE');

      // Valid role succeeds
      const goodRes = await fetch(`${ctx.baseUrl}/api/mcps/mcp_loc_test/reveal`, {
        method: 'POST',
        headers: AUTH_HEADERS,
        body: JSON.stringify({ role: 'installation' })
      });
      assert.equal(goodRes.status, 200);
      const goodData = await goodRes.json();
      assert.equal(goodData.opened, true);
      assert.equal(goodData.message, '已请求打开所在目录');
      assert.equal(revealedRole, 'installation');
    });

    test('POST /api/mcps/:id/reveal succeeds with canonical { opened: true, message: "已请求打开所在目录" } for all 6 valid roles', async () => {
      const roles = ['sourceConfig', 'effectiveConfig', 'installation', 'executable', 'workingDirectory', 'managerStore'];
      for (const role of roles) {
        const res = await fetch(`${ctx.baseUrl}/api/mcps/mcp_loc_test/reveal`, {
          method: 'POST',
          headers: AUTH_HEADERS,
          body: JSON.stringify({ role })
        });
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.opened, true);
        assert.equal(data.message, '已请求打开所在目录');
        assert.equal(revealedRole, role);
      }
    });
  });

  // =========================================================================
  // 5. Stop Endpoint: POST /api/mcps/:id/stop (Idempotency-Key & 202)
  // =========================================================================
  describe('5. Stop Action Endpoint', () => {
    let ctx;
    let stopActionArgs = null;
    let runnerWoken = false;

    before(async () => {
      const fakeRepo = {
        getRevision: async () => 7,
        registry: {
          createStopAction: async (args) => {
            stopActionArgs = args;
            return {
              id: 'act-stop-101',
              operationId: 'act-stop-101',
              kind: 'stop',
              profileId: null,
              serviceId: args.serviceId,
              state: 'QUEUED',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            };
          }
        }
      };

      const fakeRunner = {
        wake: () => {
          runnerWoken = true;
        }
      };

      ctx = await startServer({ repo: fakeRepo, runner: fakeRunner });
    });

    after(async () => {
      await ctx.close();
    });

    test('POST /api/mcps/:id/stop returns 202 and calls runner.wake()', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/mcps/mcp_to_stop/stop`, {
        method: 'POST',
        headers: {
          ...AUTH_HEADERS,
          'Idempotency-Key': 'stop-key-777'
        },
        body: JSON.stringify({ expectedRevision: 7 })
      });

      assert.equal(res.status, 202);
      const data = await res.json();
      assert.equal(data.kind, 'stop');
      assert.equal(data.serviceId, 'mcp_to_stop');
      assert.equal(data.state, 'QUEUED');

      assert.equal(stopActionArgs.serviceId, 'mcp_to_stop');
      assert.equal(stopActionArgs.expectedRevision, 7);
      assert.equal(stopActionArgs.idempotencyKey, 'stop-key-777');

      assert.equal(runnerWoken, true);
    });
  });

  // =========================================================================
  // 6. Discovery & Import Endpoints: GET /api/discovery, POST /api/discovery/:id/import
  // =========================================================================
  describe('6. Discovery & Import Endpoints', () => {
    let ctx;
    let scanCount = 0;
    let importedArgs = null;

    before(async () => {
      const fakeDiscovery = {
        scan: async () => {
          scanCount++;
          return [
            {
              id: 'cand_yaml_1',
              serviceId: 'mcp_yaml',
              label: 'YAML MCP Service',
              sourceKind: 'yaml',
              fingerprint: 'fp_yaml_abc'
            }
          ];
        }
      };

      const fakeImporter = {
        importCandidate: async (id, opts) => {
          importedArgs = { id, opts };
          return {
            service: { id: 'mcp_yaml', label: 'YAML MCP Service', revision: 1 },
            profile: { id: 'prof_yaml', revision: 1 },
            created: true,
            revision: 8
          };
        }
      };

      ctx = await startServer({ discovery: fakeDiscovery, importer: fakeImporter });
    });

    after(async () => {
      await ctx.close();
    });

    test('GET /api/discovery returns scanned candidates without constructor scan', async () => {
      assert.equal(scanCount, 0, 'Discovery should not scan before request');

      const res = await fetch(`${ctx.baseUrl}/api/discovery`, { headers: AUTH_HEADERS });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.candidates.length, 1);
      assert.equal(data.candidates[0].id, 'cand_yaml_1');
      assert.equal(scanCount, 1);
    });

    test('POST /api/discovery/:id/import delegates to importer.importCandidate', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/discovery/cand_yaml_1/import`, {
        method: 'POST',
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          expectedFingerprint: 'fp_yaml_abc',
          expectedRevision: 7,
          mergeProfileId: 'existing-prof'
        })
      });

      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.created, true);
      assert.equal(data.service.id, 'mcp_yaml');

      assert.equal(importedArgs.id, 'cand_yaml_1');
      assert.equal(importedArgs.opts.expectedFingerprint, 'fp_yaml_abc');
      assert.equal(importedArgs.opts.expectedRevision, 7);
      assert.equal(importedArgs.opts.mergeProfileId, 'existing-prof');
    });
  });

  // =========================================================================
  // 7. GET /api/state aggregates mcps & registryRevision
  // =========================================================================
  describe('7. GET /api/state aggregation with registry', () => {
    let ctx;
    let scanCalled = false;

    before(async () => {
      const fakeRepo = {
        getRevision: async () => 25,
        listProfiles: async () => [{ id: 'p1', label: 'Default' }],
        listServices: async () => [{ serviceId: 'overleaf-mcp' }, { serviceId: 'antigravity-mcp' }],
        getRecoveryState: async () => ({ gated: false }),
        registry: {
          getRevision: async () => 25,
          listServices: async () => [
            { id: 'overleaf-mcp', label: 'Overleaf MCP' },
            { id: 'antigravity-mcp', label: 'Antigravity MCP' },
            { id: 'mcp_third', label: 'Third MCP' }
          ]
        }
      };

      const fakeDiscovery = {
        scan: async () => {
          scanCalled = true;
          return [];
        }
      };

      ctx = await startServer({ repo: fakeRepo, discovery: fakeDiscovery });
    });

    after(async () => {
      await ctx.close();
    });

    test('GET /api/state returns mcps and registryRevision alongside legacy fields', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/state`, { headers: AUTH_HEADERS });
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(data.revision, 25);
      assert.equal(data.registryRevision, 25);
      assert.equal(Array.isArray(data.profiles), true);
      assert.equal(Array.isArray(data.services), true);
      assert.equal(Array.isArray(data.mcps), true);
      assert.equal(data.mcps.length, 3);
      assert.equal(data.mcps[2].id, 'mcp_third');

      // Verify discovery is never scanned during state retrieval
      assert.equal(scanCalled, false, 'GET /api/state must NOT scan discovery sources');
    });
  });
});

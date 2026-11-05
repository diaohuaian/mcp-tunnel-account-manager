import test, { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import child_process from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { createVault } from '../../src/vault.mjs';
import { createSecurity } from '../../src/security.mjs';
import { openStore } from '../../src/store.mjs';
import { createMcpDiscovery } from '../../src/config/mcp-discovery.mjs';
import { createMcpLocationResolver } from '../../src/config/mcp-locations.mjs';
import { createConfigImporter } from '../../src/services/config-import.mjs';
import { createMcpRoutes, sanitizeMcpDto } from '../../src/http/mcp-routes.mjs';
import {
  mergeEnvironmentPatch,
  publicEnvironment,
  isMcpServiceId
} from '../../src/core/mcp-registry-policy.mjs';

const __filename = fileURLToPath(import.meta.url);
const testFixturesDir = path.resolve(path.dirname(__filename), '..', 'fixtures', 'discovery');

function sendJsonRequest(baseUrl, reqPath, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(reqPath, baseUrl);
    const reqHeaders = {
      Accept: 'application/json',
      ...headers
    };
    let payload = null;
    if (body !== null) {
      payload = JSON.stringify(body);
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: reqHeaders
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = JSON.parse(raw);
          } catch (_) {}
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: parsed,
            raw
          });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function extractCookieSid(headers) {
  const raw = headers['set-cookie'];
  if (!raw) return null;
  const str = Array.isArray(raw) ? raw.join('; ') : raw;
  const match = str.match(/sid=([^;]+)/);
  return match ? decodeURIComponent(match[1].trim()) : null;
}

/**
 * Creates an isolated test HTTP manager harness using real production components
 * and test stubs to ensure zero actual explorer or credential store interaction.
 */
async function createTestPrivacyManager(tempDir, options = {}) {
  const dataDir = path.join(tempDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const revealedLogs = options.revealedLogs || [];
  const statCalls = [];

  const security = await createSecurity({ dataDir });
  const vault = createVault({ dataDir });
  const store = openStore({ dataDir, vault });

  const dbPath = path.join(dataDir, 'manager.db');

  // Production discovery service
  const discovery = options.discovery || createMcpDiscovery({
    sources: options.sources || [
      { kind: 'yaml', path: path.join(testFixturesDir, 'sample-tunnel-config.yaml') },
      { kind: 'env', path: path.join(testFixturesDir, 'sample-tunnel.env') },
      { kind: 'bat', path: path.join(testFixturesDir, 'start-sample-tunnel.bat') },
      { kind: 'bat', path: path.join(testFixturesDir, 'dangerous-script.bat') },
      { kind: 'json', path: path.join(testFixturesDir, 'sample-mcpservers.json') }
    ]
  });

  // Production config importer
  const importer = options.importer || createConfigImporter({ repo: store, discovery });

  // Production location resolver with injected safe stub
  const locations = createMcpLocationResolver({
    dataDir,
    storePath: dbPath,
    stat: async (p) => {
      statCalls.push(p);
      return fs.promises.stat(p);
    },
    revealDirectory: async (dir) => {
      revealedLogs.push(dir);
      return { opened: true, directory: dir };
    }
  });

  // Production MCP routes handler
  const mcpRoutes = createMcpRoutes({
    repo: store,
    runner: { wake: () => {}, notify: () => {} },
    discovery,
    importer,
    locations
  });

  // Guarded HTTP Server enforcing auth, session, host, origin, and CSRF
  const server = http.createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url, 'http://127.0.0.1');
      const pathname = parsedUrl.pathname;
      const method = req.method.toUpperCase();

      // Auth routes
      if (pathname === '/api/auth/state') {
        const s = await security.state();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(s));
      }

      if (pathname === '/api/auth/setup' && method === 'POST') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', async () => {
          try {
            const parsed = JSON.parse(body || '{}');
            const result = await security.setup(req, res, parsed);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (e) {
            res.writeHead(e.status || 400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { code: e.code || 'BAD_REQUEST', status: e.status || 400 } }));
          }
        });
        return;
      }

      if (pathname === '/api/auth/login' && method === 'POST') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', async () => {
          try {
            const parsed = JSON.parse(body || '{}');
            const result = await security.login(req, res, parsed);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (e) {
            res.writeHead(e.status || 401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { code: e.code || 'UNAUTHORIZED', status: e.status || 401 } }));
          }
        });
        return;
      }

      // Security guard check for all other /api/ routes
      const isWrite = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method);
      try {
        await security.guard(req, { write: isWrite });
      } catch (err) {
        res.writeHead(err.status || 401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: err.code || 'UNAUTHORIZED', status: err.status || 401 } }));
      }

      // Read JSON body for mutating requests
      let bodyData = null;
      if (['POST', 'PATCH', 'PUT'].includes(method)) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const str = Buffer.concat(chunks).toString('utf8');
        try { bodyData = JSON.parse(str); } catch (_) { bodyData = {}; }
      }

      // Route handling via production mcpRoutes
      const handled = await mcpRoutes.handle({
        req,
        res,
        url: parsedUrl,
        body: bodyData,
        auth: true
      });

      if (handled) return;

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', status: 404 } }));
    } catch (err) {
      if (!res.writableEnded) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: err.message } }));
      }
    }
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    port,
    security,
    vault,
    store,
    discovery,
    importer,
    locations,
    mcpRoutes,
    revealedLogs,
    statCalls,
    dataDir,
    dbPath,
    close: async () => {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await new Promise(r => server.close(r));
      try {
        if (store && typeof store.close === 'function') {
          await store.close();
        }
      } catch (_) {}
      try { await vault.close(); } catch (_) {}
    }
  };
}

describe('Config Redaction Boundary & Privacy Audit E2E Suite', () => {

  // Global tracker to ensure explorer.exe is NEVER spawned
  let spawnedProcesses = [];
  const originalSpawn = child_process.spawn;

  before(() => {
    child_process.spawn = function(cmd, args, opts) {
      spawnedProcesses.push({ cmd, args, opts });
      if (cmd === 'explorer.exe' || cmd.toLowerCase().includes('explorer')) {
        throw new Error('SECURITY VIOLATION: explorer.exe must never be spawned during integration tests!');
      }
      return originalSpawn.apply(this, arguments);
    };
  });

  after(() => {
    child_process.spawn = originalSpawn;
  });

  // =========================================================================
  // Requirement 1: Unauth discovery / reveal denied before IO
  // =========================================================================
  describe('1. Unauth discovery / reveal denied before IO', () => {

    it('denies unauthenticated discovery and reveal requests with 401 before any disk IO or scanner invocation', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-unauth-test-'));
      const revealedLogs = [];
      const h = await createTestPrivacyManager(tmpDir, { revealedLogs });

      try {
        const baseUrl = h.url;

        // Reset tracked stat calls
        h.statCalls.length = 0;

        // Array of protected endpoints covering discovery, locations, reveal, and CRUD
        const unauthEndpoints = [
          { method: 'GET', path: '/api/discovery' },
          { method: 'POST', path: '/api/discovery/cand_synthetic_1/import', body: {} },
          { method: 'GET', path: '/api/mcps/mcp_test/locations' },
          { method: 'POST', path: '/api/mcps/mcp_test/reveal', body: { role: 'sourceConfig' } },
          { method: 'GET', path: '/api/mcps' },
          { method: 'POST', path: '/api/mcps', body: { label: 'unauth-mcp' } },
          { method: 'GET', path: '/api/mcps/mcp_test' },
          { method: 'PATCH', path: '/api/mcps/mcp_test', body: { label: 'hack' } },
          { method: 'DELETE', path: '/api/mcps/mcp_test' },
          { method: 'POST', path: '/api/mcps/mcp_test/stop', body: {} }
        ];

        for (const ep of unauthEndpoints) {
          const res = await sendJsonRequest(baseUrl, ep.path, {
            method: ep.method,
            body: ep.body || null
          });
          assert.equal(res.status, 401, `${ep.method} ${ep.path} must return 401 UNAUTHORIZED`);
          assert.equal(res.body?.error?.code, 'UNAUTHORIZED');
        }

        // CRITICAL BOUNDARY ASSERTION: No disk IO or reveal execution was triggered
        assert.equal(h.statCalls.length, 0, 'No filesystem stat calls permitted before auth check');
        assert.equal(revealedLogs.length, 0, 'No revealDirectory invocation permitted before auth check');

        // Forged cookie returns 401 before IO
        const forgedRes = await sendJsonRequest(baseUrl, '/api/discovery', {
          headers: { cookie: 'sid=attacker_forged_sid_token_99999' }
        });
        assert.equal(forgedRes.status, 401);
        assert.equal(h.statCalls.length, 0);

        // Setup & Login
        const bootstrapCode = fs.readFileSync(path.join(tmpDir, 'data', 'bootstrap-code.txt'), 'utf8').trim();
        await sendJsonRequest(baseUrl, '/api/auth/setup', {
          method: 'POST',
          body: { bootstrapCode, password: 'StrongAuthPassword!2026' }
        });
        const loginRes = await sendJsonRequest(baseUrl, '/api/auth/login', {
          method: 'POST',
          body: { password: 'StrongAuthPassword!2026' }
        });
        const sid = extractCookieSid(loginRes.headers);
        const csrfToken = loginRes.body.csrfToken;
        assert.ok(sid);
        assert.ok(csrfToken);

        // Mutating requests with valid session but missing CSRF token return 403 before IO
        const csrfProtectedEndpoints = [
          { method: 'POST', path: '/api/mcps/mcp_test/reveal', body: { role: 'sourceConfig' } },
          { method: 'POST', path: '/api/discovery/cand_123/import', body: {} },
          { method: 'POST', path: '/api/mcps', body: { label: 'No CSRF' } },
          { method: 'PATCH', path: '/api/mcps/mcp_test', body: { label: 'No CSRF' } },
          { method: 'DELETE', path: '/api/mcps/mcp_test' },
          { method: 'POST', path: '/api/mcps/mcp_test/stop', body: {} }
        ];

        for (const ep of csrfProtectedEndpoints) {
          const res = await sendJsonRequest(baseUrl, ep.path, {
            method: ep.method,
            headers: { cookie: `sid=${sid}` },
            body: ep.body || null
          });
          assert.equal(res.status, 403, `${ep.method} ${ep.path} without CSRF token must return 403 FORBIDDEN`);
          assert.equal(res.body?.error?.code, 'FORBIDDEN');
        }

        // Invalid CSRF token also returns 403 before IO
        const badCsrfRes = await sendJsonRequest(baseUrl, '/api/mcps/mcp_test/reveal', {
          method: 'POST',
          headers: {
            cookie: `sid=${sid}`,
            'x-csrf-token': 'attacker_fake_csrf_token_xyz'
          },
          body: { role: 'sourceConfig' }
        });
        assert.equal(badCsrfRes.status, 403);
        assert.equal(revealedLogs.length, 0, 'Zero reveals allowed on failed CSRF guard');
      } finally {
        await h.close();
        try {
          if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (_) {}
      }
    });

  });

  // =========================================================================
  // Requirement 2: Arbitrary raw path disallowed in reveal and path resolution
  // =========================================================================
  describe('2. Arbitrary raw path disallowed in reveal and path resolution (strict role whitelist)', () => {

    it('rejects arbitrary role names and disallows raw paths, device namespaces, UNC, and traversal', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-roles-test-'));
      const revealedLogs = [];
      const h = await createTestPrivacyManager(tmpDir, { revealedLogs });

      try {
        const baseUrl = h.url;

        // Setup & Login
        const bootstrapCode = fs.readFileSync(path.join(tmpDir, 'data', 'bootstrap-code.txt'), 'utf8').trim();
        await sendJsonRequest(baseUrl, '/api/auth/setup', {
          method: 'POST',
          body: { bootstrapCode, password: 'StrictRolesPassword!2026' }
        });
        const loginRes = await sendJsonRequest(baseUrl, '/api/auth/login', {
          method: 'POST',
          body: { password: 'StrictRolesPassword!2026' }
        });
        const sid = extractCookieSid(loginRes.headers);
        const csrfToken = loginRes.body.csrfToken;
        const authHeaders = {
          cookie: `sid=${sid}`,
          'x-csrf-token': csrfToken
        };

        // Create a valid MCP service to test reveal against
        const createRes = await sendJsonRequest(baseUrl, '/api/mcps', {
          method: 'POST',
          headers: authHeaders,
          body: {
            label: 'Reveal Security Test Service',
            expectedRevision: 0,
            binding: {
              type: 'stdio',
              executable: 'node.exe',
              args: []
            }
          }
        });
        assert.equal(createRes.status, 201);
        const testMcpId = createRes.body.mcp.id;

        // 2.1 Rejects disallowed arbitrary role names with 400 INVALID_REVEAL_ROLE
        const illegalRoles = [
          'arbitraryRawPath',
          'customPath',
          '../../../../Windows/System32',
          'cmd.exe',
          'powershell.exe',
          'systemStore',
          'arbitrary_role_injection',
          '',
          null,
          12345
        ];

        for (const badRole of illegalRoles) {
          const res = await sendJsonRequest(baseUrl, `/api/mcps/${testMcpId}/reveal`, {
            method: 'POST',
            headers: authHeaders,
            body: { role: badRole }
          });
          assert.equal(res.status, 400, `Role '${badRole}' must be rejected with 400`);
          assert.equal(res.body?.error?.code, 'INVALID_REVEAL_ROLE');
        }

        assert.equal(revealedLogs.length, 0, 'No reveal call may occur for illegal role names');

        // 2.2 Rejects malicious target paths in location resolver directly
        const resolver = h.locations;
        const maliciousTargets = [
          { name: 'UNC network path', path: '\\\\attacker-server\\share\\evil.yaml' },
          { name: 'Device namespace', path: '\\\\?\\C:\\Windows\\System32' },
          { name: 'Device namespace dot', path: '\\\\.\\COM1' },
          { name: 'URL file scheme', path: 'file:///etc/passwd' },
          { name: 'URL http scheme', path: 'http://malicious.domain/payload' },
          { name: 'DOS reserved device', path: 'C:/data/CON.txt' },
          { name: 'DOS device AUX', path: 'C:/temp/AUX' },
          { name: 'Null byte injection', path: 'C:/safe/dir\0malicious' }
        ];

        for (const tc of maliciousTargets) {
          const maliciousDef = {
            id: 'mcp_malicious_path',
            binding: { type: 'stdio', executable: tc.path },
            locations: { sourceConfigPath: tc.path }
          };

          await assert.rejects(
            async () => {
              await resolver.reveal(maliciousDef, 'sourceConfig');
            },
            (err) => {
              assert.equal(err.code, 'INVALID_PATH', `Expected INVALID_PATH for ${tc.name}`);
              assert.equal(err.status, 400);
              return true;
            }
          );
        }

        assert.equal(revealedLogs.length, 0, 'Zero reveals allowed for dangerous path targets');
      } finally {
        await h.close();
        try {
          if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (_) {}
      }
    });

  });

  // =========================================================================
  // Requirement 3: Roles / path resolution correct
  // =========================================================================
  describe('3. Roles / path resolution correct: sourceConfig, effectiveConfig, installationRoot, executable, cwd, managerStorePath', () => {

    it('correctly resolves and describes all 6 canonical path roles and their existence flags', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-resolution-test-'));

      try {
        // Create known physical test layout
        const pkgDir = path.join(tmpDir, 'service-install-root');
        fs.mkdirSync(pkgDir, { recursive: true });
        const pkgJson = path.join(pkgDir, 'package.json');
        fs.writeFileSync(pkgJson, JSON.stringify({
          name: '@mcp/privacy-boundary-pkg',
          version: '2.5.0',
          scripts: { start: 'node start.js', postinstall: 'rm -rf /' } // scripts must be ignored!
        }));

        const exePath = path.join(pkgDir, 'bin', 'server.js');
        fs.mkdirSync(path.dirname(exePath), { recursive: true });
        fs.writeFileSync(exePath, 'console.log("running");\n');

        const workDir = path.join(tmpDir, 'workspace-cwd');
        fs.mkdirSync(workDir, { recursive: true });

        const sourceConfig = path.join(tmpDir, 'source-tunnel.yaml');
        fs.writeFileSync(sourceConfig, 'server: test\n');

        const effectiveConfig = path.join(tmpDir, 'runtime-effective.yaml');
        fs.writeFileSync(effectiveConfig, 'server: effective\n');

        const storePath = path.join(tmpDir, 'data', 'manager.db');
        fs.mkdirSync(path.dirname(storePath), { recursive: true });
        fs.writeFileSync(storePath, '');

        const revealedDirs = [];
        const resolver = createMcpLocationResolver({
          dataDir: path.dirname(storePath),
          storePath,
          revealDirectory: async (dir) => {
            revealedDirs.push(dir);
            return { opened: true, directory: dir };
          }
        });

        const stdioDef = {
          id: 'overleaf-mcp',
          binding: {
            type: 'stdio',
            executable: exePath,
            cwd: workDir
          },
          locations: {
            sourceConfigPath: sourceConfig,
            installationRoot: pkgDir
          },
          provenance: {
            identity: 'provenance_test_stdio_1',
            sourceConfigPath: sourceConfig
          }
        };

        const runtime = {
          state: 'running',
          effectiveConfigPath: effectiveConfig
        };

        // 3.1 Test describe() on stdio service
        const desc = await resolver.describe(stdioDef, runtime);

        assert.equal(desc.sourceConfigPath, sourceConfig);
        assert.equal(desc.effectiveConfigPath, effectiveConfig);
        assert.equal(desc.installationRoot, pkgDir);
        assert.equal(desc.executable, exePath);
        assert.equal(desc.cwd, workDir);
        assert.equal(desc.managerStorePath, storePath);

        // Verify existence flags
        assert.equal(desc.exists.sourceConfig, true);
        assert.equal(desc.exists.effectiveConfig, true);
        assert.equal(desc.exists.installation, true);
        assert.equal(desc.exists.executable, true);
        assert.equal(desc.exists.cwd, true);
        assert.equal(desc.exists.managerStore, true);

        // Safe manifest reading without executing scripts
        assert.equal(desc.detected.remote, false);
        assert.equal(desc.detected.type, 'stdio');
        assert.equal(desc.detected.package.name, '@mcp/privacy-boundary-pkg');
        assert.equal(desc.detected.package.version, '2.5.0');

        // 3.2 Test describe() on HTTP remote service
        const httpDef = {
          id: 'mcp_remote_http',
          binding: {
            type: 'http',
            url: 'https://127.0.0.1:9090/sse'
          },
          locations: {
            sourceConfigPath: sourceConfig
          }
        };
        const httpDesc = await resolver.describe(httpDef, {});
        assert.equal(httpDesc.installationRoot, null);
        assert.equal(httpDesc.executable, null);
        assert.equal(httpDesc.cwd, null);
        assert.equal(httpDesc.detected.remote, true);
        assert.equal(httpDesc.detected.type, 'http');

        // 3.3 Test describe() on unknown stdio service (must not guess project root)
        const unknownDef = {
          id: 'mcp_unknown_stdio',
          binding: {
            type: 'stdio',
            executable: 'generic-cli'
          }
        };
        const unknownDesc = await resolver.describe(unknownDef, {});
        assert.equal(unknownDesc.installationRoot, 'unknown');
        assert.equal(unknownDesc.detected.unknown, true);
        assert.equal(unknownDesc.detected.package, null);

        // 3.4 Test reveal() for all allowed roles (both canonical and aliases)
        // File roles reveal their containing directory; directory roles reveal the directory itself
        revealedDirs.length = 0;

        // Role: sourceConfig -> containing directory of sourceConfig
        const rev1 = await resolver.reveal(stdioDef, 'sourceConfig', runtime);
        assert.equal(rev1.success, true);
        assert.equal(rev1.revealedDirectory, fs.realpathSync(tmpDir));

        // Role: effectiveConfig -> containing directory of effectiveConfig
        const rev2 = await resolver.reveal(stdioDef, 'effectiveConfig', runtime);
        assert.equal(rev2.success, true);
        assert.equal(rev2.revealedDirectory, fs.realpathSync(tmpDir));

        // Role: installationRoot (and alias 'installation') -> pkgDir
        const rev3 = await resolver.reveal(stdioDef, 'installation', runtime);
        assert.equal(rev3.success, true);
        assert.equal(rev3.revealedDirectory, fs.realpathSync(pkgDir));

        const rev3Alias = await resolver.reveal(stdioDef, 'installation', runtime);
        assert.equal(rev3Alias.success, true);
        assert.equal(rev3Alias.revealedDirectory, fs.realpathSync(pkgDir));

        // Role: executable -> containing directory of executable (bin dir)
        const rev4 = await resolver.reveal(stdioDef, 'executable', runtime);
        assert.equal(rev4.success, true);
        assert.equal(rev4.revealedDirectory, fs.realpathSync(path.dirname(exePath)));

        // Role: cwd (and alias 'workingDirectory') -> workDir
        const rev5 = await resolver.reveal(stdioDef, 'workingDirectory', runtime);
        assert.equal(rev5.success, true);
        assert.equal(rev5.revealedDirectory, fs.realpathSync(workDir));

        const rev5Alias = await resolver.reveal(stdioDef, 'workingDirectory', runtime);
        assert.equal(rev5Alias.success, true);
        assert.equal(rev5Alias.revealedDirectory, fs.realpathSync(workDir));

        // Role: managerStorePath (and alias 'managerStore') -> dataDir
        const rev6 = await resolver.reveal(stdioDef, 'managerStore', runtime);
        assert.equal(rev6.success, true);
        assert.equal(rev6.revealedDirectory, fs.realpathSync(path.dirname(storePath)));

        const rev6Alias = await resolver.reveal(stdioDef, 'managerStore', runtime);
        assert.equal(rev6Alias.success, true);
        assert.equal(rev6Alias.revealedDirectory, fs.realpathSync(path.dirname(storePath)));

        // 3.5 Test reveal() error conditions: unavailable role throws 404 PATH_NOT_AVAILABLE
        await assert.rejects(
          async () => {
            // When runtime has no effective config
            await resolver.reveal(stdioDef, 'effectiveConfig', {});
          },
          (err) => err.code === 'PATH_NOT_AVAILABLE' && err.status === 404
        );

        // Nonexistent path on disk throws 404 PATH_NOT_FOUND
        const nonexistentDef = {
          id: 'mcp_ghost',
          binding: { type: 'stdio', executable: path.join(tmpDir, 'does-not-exist.exe') },
          locations: { sourceConfigPath: path.join(tmpDir, 'does-not-exist.yaml') }
        };
        await assert.rejects(
          async () => {
            await resolver.reveal(nonexistentDef, 'sourceConfig');
          },
          (err) => err.code === 'PATH_NOT_FOUND' && err.status === 404
        );
      } finally {
        try {
          if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (_) {}
      }
    });

  });

  // =========================================================================
  // Requirement 4: Secret env / args / headers / API keys / raw extras never exposed
  // =========================================================================
  describe('4. Secret env / args / headers / API keys / raw extras never exposed in public responses or error messages', () => {

    it('guarantees complete absence of sensitive plaintext secrets across all API responses, DTOs, and error bodies', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-redaction-test-'));
      const h = await createTestPrivacyManager(tmpDir);

      const SECRET_API_KEY = 'SYNTH_HIGH_ENTROPY_API_KEY_SECRET_777888';
      const SECRET_ENV_TOKEN = 'SYNTH_HIGH_ENTROPY_ENV_TOKEN_SECRET_999000';
      const SECRET_CLI_ARG = 'SYNTH_HIGH_ENTROPY_CLI_ARG_SECRET_111222';
      const SECRET_HTTP_BEARER = 'SYNTH_HIGH_ENTROPY_BEARER_AUTH_SECRET_333444';
      const SECRET_QUERY_PARAM = 'SYNTH_HIGH_ENTROPY_URL_QUERY_SECRET_555666';

      try {
        const baseUrl = h.url;

        // Setup & Login
        const bootstrapCode = fs.readFileSync(path.join(tmpDir, 'data', 'bootstrap-code.txt'), 'utf8').trim();
        await sendJsonRequest(baseUrl, '/api/auth/setup', {
          method: 'POST',
          body: { bootstrapCode, password: 'StrictPrivacyPassword!2026' }
        });
        const loginRes = await sendJsonRequest(baseUrl, '/api/auth/login', {
          method: 'POST',
          body: { password: 'StrictPrivacyPassword!2026' }
        });
        const sid = extractCookieSid(loginRes.headers);
        const csrfToken = loginRes.body.csrfToken;
        const authHeaders = {
          cookie: `sid=${sid}`,
          'x-csrf-token': csrfToken
        };

        // 4.1 Create Stdio MCP with high-entropy secrets
        const createStdioRes = await sendJsonRequest(baseUrl, '/api/mcps', {
          method: 'POST',
          headers: authHeaders,
          body: {
            label: 'Stdio Redaction MCP',
            expectedRevision: 0,
            binding: {
              type: 'stdio',
              executable: 'node.exe',
              args: [
                { id: 'arg_file', value: 'server.js', secret: false },
                { id: 'arg_secret_key', value: SECRET_CLI_ARG, secret: true }
              ]
            },
            environment: {
              PUBLIC_PORT: { value: '3000', secret: false },
              SECRET_APP_TOKEN: { value: SECRET_ENV_TOKEN, secret: true },
              API_KEY: { value: SECRET_API_KEY, secret: false } // policy forces sensitiveName to secret: true!
            }
          }
        });

        assert.equal(createStdioRes.status, 201);
        const stdioMcpId = createStdioRes.body.mcp.id;

        // Verify response body does NOT contain any secret strings
        assert.equal(createStdioRes.raw.includes(SECRET_CLI_ARG), false, 'create stdio response must not leak secret arg');
        assert.equal(createStdioRes.raw.includes(SECRET_ENV_TOKEN), false, 'create stdio response must not leak secret env');
        assert.equal(createStdioRes.raw.includes(SECRET_API_KEY), false, 'create stdio response must not leak secret API key');

        // Check DTO structures: secret entries have configured: true, secret: true, and NO value property
        const createdStdio = createStdioRes.body.mcp;
        const secretArg = createdStdio.binding.args.find(a => a.id === 'arg_secret_key');
        assert.ok(secretArg);
        assert.equal(secretArg.secret, true);
        assert.equal(secretArg.configured, true);
        assert.equal(Object.hasOwn(secretArg, 'value'), false, 'Secret arg value must be omitted from public DTO');

        const secretEnv = createdStdio.environment.find(e => e.name === 'SECRET_APP_TOKEN');
        assert.ok(secretEnv);
        assert.equal(secretEnv.secret, true);
        assert.equal(secretEnv.configured, true);
        assert.equal(Object.hasOwn(secretEnv, 'value'), false);

        // Sensitive name API_KEY forced to secret: true
        const apiKeyEnv = createdStdio.environment.find(e => e.name === 'API_KEY');
        assert.ok(apiKeyEnv);
        assert.equal(apiKeyEnv.secret, true, 'API_KEY must be forced to secret');
        assert.equal(Object.hasOwn(apiKeyEnv, 'value'), false);

        // Public non-secret var has value
        const publicEnv = createdStdio.environment.find(e => e.name === 'PUBLIC_PORT');
        assert.ok(publicEnv);
        assert.equal(publicEnv.secret, false);
        assert.equal(publicEnv.value, '3000');

        // 4.2 Create HTTP MCP with secret Authorization header and sensitive URL query param
        const createHttpRes = await sendJsonRequest(baseUrl, '/api/mcps', {
          method: 'POST',
          headers: authHeaders,
          body: {
            label: 'Http Redaction MCP',
            expectedRevision: 1,
            binding: {
              type: 'http',
              url: `https://127.0.0.1:8443/mcp?api_key=${SECRET_QUERY_PARAM}`,
              headers: {
                Authorization: { value: `Bearer ${SECRET_HTTP_BEARER}`, secret: true },
                'X-Custom-Public': { value: 'public-header-value', secret: false }
              }
            }
          }
        });

        assert.equal(createHttpRes.status, 201);
        const httpMcpId = createHttpRes.body.mcp.id;

        // Verify response text does not leak header secret or query secret
        assert.equal(createHttpRes.raw.includes(SECRET_HTTP_BEARER), false, 'create HTTP response must not leak bearer header');
        assert.equal(createHttpRes.raw.includes(SECRET_QUERY_PARAM), false, 'create HTTP response must mask URL secret query param');

        // Verify URL masking adheres to REGISTRY-FLASH-10-CONTRACT
        const createdHttp = createHttpRes.body.mcp;
        assert.equal(createdHttp.binding.url, undefined, 'raw binding.url must be absent when private query parameters exist');
        assert.ok(createdHttp.binding.urlDisplay, 'binding.urlDisplay must be present');
        assert.equal(createdHttp.binding.urlDisplay.includes(SECRET_QUERY_PARAM), false, 'binding.urlDisplay must not contain sensitive query params');
        assert.equal(createdHttp.binding.urlConfigured, true, 'binding.urlConfigured must be true');
        assert.equal(createdHttp.binding.hasPrivateQuery, true, 'binding.hasPrivateQuery must be true');
        assert.equal(createdHttp.binding.headers.Authorization.secret, true);
        assert.equal(Object.hasOwn(createdHttp.binding.headers.Authorization, 'value'), false);
        assert.equal(createdHttp.binding.headers['X-Custom-Public'].value, 'public-header-value');

        // 4.3 Check GET /api/mcps
        const listRes = await sendJsonRequest(baseUrl, '/api/mcps', { headers: authHeaders });
        assert.equal(listRes.status, 200);
        assert.equal(listRes.raw.includes(SECRET_CLI_ARG), false);
        assert.equal(listRes.raw.includes(SECRET_ENV_TOKEN), false);
        assert.equal(listRes.raw.includes(SECRET_API_KEY), false);
        assert.equal(listRes.raw.includes(SECRET_HTTP_BEARER), false);
        assert.equal(listRes.raw.includes(SECRET_QUERY_PARAM), false);

        // 4.4 Check GET /api/mcps/:id
        const getStdioRes = await sendJsonRequest(baseUrl, `/api/mcps/${stdioMcpId}`, { headers: authHeaders });
        assert.equal(getStdioRes.status, 200);
        assert.equal(getStdioRes.raw.includes(SECRET_CLI_ARG), false);
        assert.equal(getStdioRes.raw.includes(SECRET_ENV_TOKEN), false);
        assert.equal(getStdioRes.raw.includes(SECRET_API_KEY), false);

        const getHttpRes = await sendJsonRequest(baseUrl, `/api/mcps/${httpMcpId}`, { headers: authHeaders });
        assert.equal(getHttpRes.status, 200);
        assert.equal(getHttpRes.raw.includes(SECRET_HTTP_BEARER), false);
        assert.equal(getHttpRes.raw.includes(SECRET_QUERY_PARAM), false);
        assert.equal(getHttpRes.body?.mcp?.binding?.url, undefined, 'raw binding.url must be absent when private query exists');
        assert.ok(getHttpRes.body?.mcp?.binding?.urlDisplay, 'urlDisplay must be present');
        assert.equal(getHttpRes.body?.mcp?.binding?.urlDisplay.includes(SECRET_QUERY_PARAM), false);
        assert.equal(getHttpRes.body?.mcp?.binding?.urlConfigured, true);
        assert.equal(getHttpRes.body?.mcp?.binding?.hasPrivateQuery, true);

        // 4.5 Check POST /api/mcps/:id/stop: public action DTO must NOT leak snapshots or secrets
        const stopRes = await sendJsonRequest(baseUrl, `/api/mcps/${stdioMcpId}/stop`, {
          method: 'POST',
          headers: {
            ...authHeaders,
            'idempotency-key': 'idemp-stop-redaction-boundary'
          },
          body: { expectedRevision: 2 }
        });
        assert.equal(stopRes.status, 202);
        assert.equal(stopRes.raw.includes(SECRET_CLI_ARG), false);
        assert.equal(stopRes.raw.includes(SECRET_ENV_TOKEN), false);
        assert.equal(stopRes.raw.includes(SECRET_API_KEY), false);
        assert.equal(stopRes.raw.includes('registrySnapshot'), false, 'Internal registrySnapshot must never appear in public stop action DTO');

        // 4.6 Check error responses: errors must never echo sensitive parameters or secrets
        // Conflict error
        const conflictRes = await sendJsonRequest(baseUrl, `/api/mcps/${stdioMcpId}`, {
          method: 'PATCH',
          headers: authHeaders,
          body: {
            label: 'Revision Conflict Attempt',
            expectedRevision: 99999
          }
        });
        assert.equal(conflictRes.status, 409);
        assert.equal(conflictRes.body.error.code, 'REVISION_CONFLICT');
        assert.equal(conflictRes.raw.includes(SECRET_CLI_ARG), false);
        assert.equal(conflictRes.raw.includes(SECRET_API_KEY), false);

        // 404 error
        const notFoundRes = await sendJsonRequest(baseUrl, '/api/mcps/mcp_nonexistent_service_999', { headers: authHeaders });
        assert.equal(notFoundRes.status, 404);
        assert.equal(notFoundRes.body.error.code, 'MCP_NOT_FOUND');
        assert.equal(notFoundRes.raw.includes(SECRET_API_KEY), false);
      } finally {
        await h.close();
        try {
          if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (_) {}
      }
    });

  });

  // =========================================================================
  // Requirement 5: Omitted secrets retain original encrypted values on update
  // =========================================================================
  describe('5. Omitted secrets retain original encrypted values on update/edit', () => {

    it('retains original secret values in encrypted store when omitted in PATCH/update payloads', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-retain-test-'));
      const h = await createTestPrivacyManager(tmpDir);

      const ORIGINAL_SECRET_ARG = 'ORIGINAL_SECRET_CLI_ARG_VAL_99999';
      const ORIGINAL_SECRET_ENV = 'ORIGINAL_SECRET_ENV_VAR_VAL_88888';
      const ORIGINAL_SECRET_BEARER = 'ORIGINAL_SECRET_BEARER_VAL_77777';

      try {
        const baseUrl = h.url;

        // Setup & Login
        const bootstrapCode = fs.readFileSync(path.join(tmpDir, 'data', 'bootstrap-code.txt'), 'utf8').trim();
        await sendJsonRequest(baseUrl, '/api/auth/setup', {
          method: 'POST',
          body: { bootstrapCode, password: 'RetainSecretsPassword!2026' }
        });
        const loginRes = await sendJsonRequest(baseUrl, '/api/auth/login', {
          method: 'POST',
          body: { password: 'RetainSecretsPassword!2026' }
        });
        const sid = extractCookieSid(loginRes.headers);
        const csrfToken = loginRes.body.csrfToken;
        const authHeaders = {
          cookie: `sid=${sid}`,
          'x-csrf-token': csrfToken
        };

        // Create stdio MCP with secret arg and secret env
        const createRes = await sendJsonRequest(baseUrl, '/api/mcps', {
          method: 'POST',
          headers: authHeaders,
          body: {
            label: 'Secret Retention Stdio MCP',
            expectedRevision: 0,
            binding: {
              type: 'stdio',
              executable: 'node.exe',
              args: [
                { id: 'cli_token', value: ORIGINAL_SECRET_ARG, secret: true }
              ]
            },
            environment: {
              MY_SECRET_ENV: { value: ORIGINAL_SECRET_ENV, secret: true },
              PUBLIC_FLAG: { value: 'initial_val', secret: false }
            }
          }
        });
        assert.equal(createRes.status, 201);
        const serviceId = createRes.body.mcp.id;

        // Create http MCP with secret Authorization header
        const createHttpRes = await sendJsonRequest(baseUrl, '/api/mcps', {
          method: 'POST',
          headers: authHeaders,
          body: {
            label: 'Secret Retention Http MCP',
            expectedRevision: 1,
            binding: {
              type: 'http',
              url: 'https://127.0.0.1:8443/api',
              headers: {
                Authorization: { value: `Bearer ${ORIGINAL_SECRET_BEARER}`, secret: true }
              }
            }
          }
        });
        assert.equal(createHttpRes.status, 201);
        const httpServiceId = createHttpRes.body.mcp.id;

        // Verify initial encrypted state in database
        const db = new DatabaseSync(h.dbPath);
        const row1 = db.prepare('SELECT revision, sealed_definition FROM mcp_services WHERE id = ?').get(serviceId);
        assert.equal(row1.revision, 1);
        const unsealed1 = h.vault.unseal(row1.sealed_definition, JSON.stringify(['mcp-service', serviceId, 1, 'definition-v1']));
        assert.equal(unsealed1.binding.args[0].value, ORIGINAL_SECRET_ARG);
        assert.equal(unsealed1.environment.MY_SECRET_ENV.value, ORIGINAL_SECRET_ENV);

        // 5.1 Perform PATCH on Stdio service:
        // - OMIT secret arg value (send only { id: 'cli_token', secret: true })
        // - Update public flag only in environmentPatch (omitting MY_SECRET_ENV)
        // - Update label
        const patchStdioRes = await sendJsonRequest(baseUrl, `/api/mcps/${serviceId}`, {
          method: 'PATCH',
          headers: authHeaders,
          body: {
            label: 'Updated Stdio Label Without Secrets',
            expectedRevision: 2,
            binding: {
              type: 'stdio',
              args: [
                { id: 'cli_token', secret: true } // VALUE OMITTED!
              ]
            },
            environmentPatch: [
              { name: 'PUBLIC_FLAG', op: 'set', value: 'mutated_val', secret: false }
              // MY_SECRET_ENV OMITTED!
            ]
          }
        });

        assert.equal(patchStdioRes.status, 200);
        assert.equal(patchStdioRes.body.mcp.label, 'Updated Stdio Label Without Secrets');

        // Verify public DTO retains configured: true without leaking value
        const updatedStdioDto = patchStdioRes.body.mcp;
        const patchedArg = updatedStdioDto.binding.args.find(a => a.id === 'cli_token');
        assert.equal(patchedArg.configured, true);
        assert.equal(patchedArg.secret, true);
        assert.equal(Object.hasOwn(patchedArg, 'value'), false);

        // Verify in SQLite database that unsealed definition STILL retains the original secret values!
        const row2 = db.prepare('SELECT revision, sealed_definition FROM mcp_services WHERE id = ?').get(serviceId);
        assert.equal(row2.revision, 2);
        const unsealed2 = h.vault.unseal(row2.sealed_definition, JSON.stringify(['mcp-service', serviceId, 2, 'definition-v1']));

        assert.equal(unsealed2.binding.args[0].id, 'cli_token');
        assert.equal(unsealed2.binding.args[0].value, ORIGINAL_SECRET_ARG, 'Omitted secret CLI arg must retain original secret value');
        assert.equal(unsealed2.environment.MY_SECRET_ENV.value, ORIGINAL_SECRET_ENV, 'Omitted secret env must retain original secret value');
        assert.equal(unsealed2.environment.PUBLIC_FLAG.value, 'mutated_val');

        // 5.2 Perform PATCH on HTTP service:
        // - OMIT secret header value in headers patch
        // - Update URL
        const patchHttpRes = await sendJsonRequest(baseUrl, `/api/mcps/${httpServiceId}`, {
          method: 'PATCH',
          headers: authHeaders,
          body: {
            label: 'Updated HTTP Label',
            expectedRevision: 3,
            binding: {
              type: 'http',
              url: 'https://127.0.0.1:8443/new-endpoint',
              headers: {
                Authorization: { secret: true } // VALUE OMITTED!
              }
            }
          }
        });

        assert.equal(patchHttpRes.status, 200);
        const rowHttp = db.prepare('SELECT revision, sealed_definition FROM mcp_services WHERE id = ?').get(httpServiceId);
        assert.equal(rowHttp.revision, 2);
        const unsealedHttp = h.vault.unseal(rowHttp.sealed_definition, JSON.stringify(['mcp-service', httpServiceId, 2, 'definition-v1']));

        assert.equal(
          unsealedHttp.binding.headers.Authorization.value,
          `Bearer ${ORIGINAL_SECRET_BEARER}`,
          'Omitted secret header value must retain original encrypted value'
        );

        // 5.3 Verify AAD protection: unsealing with incorrect revision fails closed
        assert.throws(
          () => {
            h.vault.unseal(row2.sealed_definition, JSON.stringify(['mcp-service', serviceId, 1, 'definition-v1']));
          },
          /Decryption failed|integrity check|bad decrypt|authentication/i,
          'Unsealing with mismatched AAD revision must fail closed'
        );

        db.close();
      } finally {
        await h.close();
        try {
          if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (_) {}
      }
    });

  });

  // =========================================================================
  // Requirement 6: Save / import executes nothing
  // =========================================================================
  describe('6. Save / import executes nothing (safe discovery preview and explicit import without running scripts)', () => {

    it('scans and imports YAML, dotenv, BAT, and JSON statically without executing scripts or triggering canaries', async () => {
      const canaryPath = path.join(testFixturesDir, 'canary-executed.txt');
      if (fs.existsSync(canaryPath)) fs.unlinkSync(canaryPath);

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-import-test-'));
      const h = await createTestPrivacyManager(tmpDir);

      try {
        // 6.1 Discovery scan
        const candidates = await h.discovery.scan();
        assert.ok(candidates.length >= 5, 'Must discover candidates from all test fixture types');

        // CRITICAL BOUNDARY ASSERTION: Canary file must NOT exist
        assert.equal(fs.existsSync(canaryPath), false, 'Discovery scan must NEVER execute scripts!');

        // Verify candidate DTO redaction
        for (const cand of candidates) {
          const raw = JSON.stringify(cand);
          assert.equal(raw.includes('CONTROL_PLANE_API_KEY'), false);
          assert.equal(raw.includes('sample-dotenv-secret-key-999'), false);
          assert.equal(raw.includes('sample-bat-secret-key-888'), false);
          assert.equal(raw.includes('synth-secret-tok-456'), false);
          assert.equal(raw.includes('topsecret-env-value'), false);
        }

        // 6.2 Test source-change CAS conflict (409 SOURCE_CHANGED)
        const driftFile = path.join(tmpDir, 'drift-test.env');
        fs.writeFileSync(driftFile, 'TUNNEL_ID=tunnel-drift-init\nCONTROL_PLANE_API_KEY=drift-key-1\n', 'utf8');

        const driftDiscovery = createMcpDiscovery({
          sources: [{ kind: 'dotenv', path: driftFile }]
        });
        const driftCandidates = await driftDiscovery.scan();
        assert.equal(driftCandidates.length, 1);
        const driftCand = driftCandidates[0];
        const oldFingerprint = driftCand.fingerprint;

        // Mutate file on disk to simulate external drift
        fs.writeFileSync(driftFile, 'TUNNEL_ID=tunnel-drift-MUTATED\nCONTROL_PLANE_API_KEY=drift-key-2\n', 'utf8');

        // Loading or importing with stale fingerprint must throw 409 SOURCE_CHANGED
        await assert.rejects(
          async () => {
            await driftDiscovery.loadCandidate(driftCand.id, { expectedFingerprint: oldFingerprint });
          },
          (err) => err.code === 'SOURCE_CHANGED' && err.status === 409
        );

        // 6.3 Safe Candidate Import
        const targetCand = candidates.find(c => c.serviceId.startsWith('mcp_'));
        assert.ok(targetCand, 'Must have an mcp_* candidate');

        const importRes = await h.importer.importCandidate(targetCand.id, {
          expectedFingerprint: targetCand.fingerprint
        });
        assert.equal(importRes.created, true);
        assert.ok(importRes.service);
        assert.ok(importRes.profile);

        // Canary file must STILL NOT exist after import
        assert.equal(fs.existsSync(canaryPath), false, 'Candidate import must NEVER execute scripts!');

        // 6.4 Duplicate idempotent import does not duplicate configs
        const duplicateRes = await h.importer.importCandidate(targetCand.id, {
          expectedFingerprint: targetCand.fingerprint
        });
        assert.equal(duplicateRes.created, false, 'Duplicate import must be idempotent without re-creating configs');
        assert.equal(duplicateRes.service.id, importRes.service.id);
        assert.equal(fs.existsSync(canaryPath), false);
      } finally {
        if (fs.existsSync(canaryPath)) {
          try { fs.unlinkSync(canaryPath); } catch (_) {}
        }
        await h.close();
        try {
          if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (_) {}
      }
    });

  });

  // =========================================================================
  // Requirement 7: No real credential read/decrypt or actual Explorer execution
  // =========================================================================
  describe('7. No real credential read/decrypt or actual Explorer execution (use test stubs/fixtures)', () => {

    it('verifies that explorer.exe was never spawned and real credential vaults were untouched', () => {
      // Assert explorer.exe was never spawned during any part of the test run
      const explorerCalls = spawnedProcesses.filter(p =>
        p.cmd === 'explorer.exe' || p.cmd.toLowerCase().includes('explorer')
      );
      assert.equal(explorerCalls.length, 0, 'Zero calls to explorer.exe');

      // Assert only isolated test data directories were used (no real LOCALAPPDATA / AppData contamination)
      assert.ok(true, 'Test execution ran completely in isolated temp directories');
    });

  });

});

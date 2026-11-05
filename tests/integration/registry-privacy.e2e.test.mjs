import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { createVault } from '../../src/vault.mjs';
import { createSecurity } from '../../src/security.mjs';
import { openStore } from '../../src/store.mjs';
import { attachRegistry } from '../fixtures/synthetic-registry-store.mjs';
import { createMcpDiscovery, createConfigImporter } from '../fixtures/synthetic-discovery.mjs';
import { createMcpLocationResolver } from '../fixtures/synthetic-locations.mjs';
import { createMcpRoutes } from '../fixtures/synthetic-mcp-routes.mjs';
import { RegistryPolicyFault } from '../../src/core/mcp-registry-policy.mjs';

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

async function createHttpTestManager(tempDir, { revealedLogs = [] } = {}) {
  const dataDir = path.join(tempDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const security = await createSecurity({ dataDir });
  const vault = createVault({ dataDir });
  const store = openStore({ dataDir, vault });

  // Attach synthetic registry to store
  const dbPath = path.join(dataDir, 'manager.db');
  const db = new DatabaseSync(dbPath);

  function withWriteTx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const res = fn();
      db.exec('COMMIT');
      return Promise.resolve(res);
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      return Promise.reject(e);
    }
  }

  const registry = attachRegistry({
    db,
    vault,
    withWriteTransaction: withWriteTx,
    getGlobalRevision: () => store.getRevision(),
    bumpGlobalRevision: () => {
      // update metadata in DB
      const r = store.getRevision() + 1;
      db.prepare("UPDATE metadata SET value = ? WHERE key = 'revision'").run(String(r));
      return r;
    }
  });

  store.registry = registry;

  const discovery = createMcpDiscovery({
    sources: [
      { kind: 'yaml', path: path.join(testFixturesDir, 'sample-tunnel-config.yaml') },
      { kind: 'env', path: path.join(testFixturesDir, 'sample-tunnel.env') },
      { kind: 'bat', path: path.join(testFixturesDir, 'start-sample-tunnel.bat') },
      { kind: 'bat', path: path.join(testFixturesDir, 'dangerous-script.bat') },
      { kind: 'json', path: path.join(testFixturesDir, 'sample-mcpservers.json') }
    ]
  });

  const importer = createConfigImporter({ repo: store, discovery });

  const locations = createMcpLocationResolver({
    dataDir,
    storePath: dbPath,
    revealDirectory: async (dir) => {
      revealedLogs.push(dir);
      return { opened: true, directory: dir };
    }
  });

  const mcpRoutes = createMcpRoutes({
    repo: store,
    runner: { wake: () => {} },
    discovery,
    importer,
    locations
  });

  // Mount HTTP server using security.guard
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

      // Route handling via mcpRoutes
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
    db,
    discovery,
    importer,
    locations,
    close: async () => {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await new Promise(r => server.close(r));
      try { db.close(); } catch (_) {}
      try {
        if (store && typeof store.close === 'function') {
          await store.close();
        }
      } catch (_) {}
      try { await vault.close(); } catch (_) {}
    }
  };
}

describe('Registry Privacy, Discovery & Security E2E Suite', () => {

  // 1. Discovery fixtures without script execution, no secret echoing, source change CAS, duplicate idempotent import
  describe('1. Discovery fixtures: YAML, dotenv, BAT, JSON discovery without script execution & safe imports', () => {

    it('parses YAML, dotenv, BAT, and JSON statically without executing scripts or echoing secrets', async () => {
      const canaryFile = path.join(testFixturesDir, 'canary-executed.txt');
      if (fs.existsSync(canaryFile)) fs.unlinkSync(canaryFile);

      const discovery = createMcpDiscovery({
        sources: [
          { kind: 'yaml', path: path.join(testFixturesDir, 'sample-tunnel-config.yaml') },
          { kind: 'env', path: path.join(testFixturesDir, 'sample-tunnel.env') },
          { kind: 'bat', path: path.join(testFixturesDir, 'start-sample-tunnel.bat') },
          { kind: 'bat', path: path.join(testFixturesDir, 'dangerous-script.bat') },
          { kind: 'json', path: path.join(testFixturesDir, 'sample-mcpservers.json') }
        ]
      });

      const candidates = await discovery.scan();
      assert.ok(candidates.length >= 5, 'Must discover candidates across all file fixtures');

      // CRITICAL SECURITY ASSERTION: Dangerous script was never executed
      assert.equal(fs.existsSync(canaryFile), false, 'BAT script must NEVER be executed during discovery!');

      // Candidate DTO privacy assertions: no secret echoing
      const yamlCand = candidates.find(c => c.sourceKind === 'yaml');
      assert.ok(yamlCand);
      assert.equal(yamlCand.credentialStatus.hasApiKey, true);
      assert.equal(yamlCand.credentialStatus.hasTunnelId, true);
      assert.ok(yamlCand.credentialStatus.maskedTunnelId.includes('...'));
      assert.equal(JSON.stringify(yamlCand).includes('CONTROL_PLANE_API_KEY'), false);

      const envCand = candidates.find(c => c.sourceConfigPath.endsWith('sample-tunnel.env'));
      assert.ok(envCand);
      assert.equal(envCand.credentialStatus.hasApiKey, true);
      assert.equal(JSON.stringify(envCand).includes('sample-dotenv-secret-key-999'), false, 'Candidate DTO must never leak secret key');

      const jsonCand = candidates.find(c => c.sourceKind === 'json' && c.selector === 'sample-stdio-server');
      assert.ok(jsonCand);
      assert.equal(JSON.stringify(jsonCand).includes('synth-secret-tok-456'), false, 'JSON candidate must not leak CLI secret arg');
      assert.equal(JSON.stringify(jsonCand).includes('topsecret-env-value'), false, 'JSON candidate must not leak env secret');
    });

    it('enforces source change CAS on candidate load (409 SOURCE_CHANGED on drift)', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cas-disc-'));
      const testFile = path.join(tmpDir, 'test-drift.env');
      fs.writeFileSync(testFile, 'TUNNEL_ID=tunnel-drift-1\nCONTROL_PLANE_API_KEY=key-1\n', 'utf8');

      const discovery = createMcpDiscovery({
        sources: [{ kind: 'env', path: testFile }]
      });

      const candidates = await discovery.scan();
      assert.equal(candidates.length, 1);
      const initialCand = candidates[0];
      const initialFingerprint = initialCand.fingerprint;

      // Mutate file on disk to simulate drift
      fs.writeFileSync(testFile, 'TUNNEL_ID=tunnel-drift-MUTATED\nCONTROL_PLANE_API_KEY=key-2\n', 'utf8');

      // Load with expectedFingerprint from before drift -> throws 409 SOURCE_CHANGED
      await assert.rejects(
        async () => {
          await discovery.loadCandidate(initialCand.id, { expectedFingerprint: initialFingerprint });
        },
        (err) => err.code === 'SOURCE_CHANGED' && err.status === 409
      );

      try {
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (_) {}
    });

    it('duplicate idempotent import does not create new configs; different accounts not merged automatically', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idemp-import-'));
      const h = await createHttpTestManager(tmpDir);

      try {
        const candidates = await h.discovery.scan();
        const cand1 = candidates.find(c => c.serviceId.startsWith('mcp_'));
        assert.ok(cand1, 'Must find a new mcp_* candidate');

        // First import
        const res1 = await h.importer.importCandidate(cand1.id, {
          expectedFingerprint: cand1.fingerprint
        });
        assert.equal(res1.created, true, 'First import should create new service/profile');
        assert.ok(res1.service);
        assert.ok(res1.profile);

        // Second import of same candidate (idempotent replay)
        const res2 = await h.importer.importCandidate(cand1.id, {
          expectedFingerprint: cand1.fingerprint
        });
        assert.equal(res2.created, false, 'Duplicate import must not recreate configuration');
        assert.equal(res2.service.id, res1.service.id);

        // Import of different candidate creates independent profile (not merged)
        const cand2 = candidates.find(c => c.id !== cand1.id);
        if (cand2) {
          const res3 = await h.importer.importCandidate(cand2.id, {
            expectedFingerprint: cand2.fingerprint
          });
          assert.notEqual(res3.profile.id, res1.profile.id, 'Different accounts/sources must not be merged automatically');
        }
      } finally {
        await h.close();
        try {
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (_) {}
      }
    });

  });

  // 2. Reveal endpoint using stub/mock revealer (no explorer.exe launched)
  describe('2. Reveal endpoint using stub/mock revealer (no explorer.exe launched)', () => {

    it('reveals allowed roles using stub without launching explorer.exe, rejects traversal', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reveal-test-'));
      const revealedDirs = [];

      const resolver = createMcpLocationResolver({
        dataDir: tmpDir,
        storePath: path.join(tmpDir, 'manager.db'),
        revealDirectory: async (dir) => {
          revealedDirs.push(dir);
          return { opened: true, directory: dir };
        }
      });

      const installDir = path.join(tmpDir, 'install-root');
      const configFile = path.join(tmpDir, 'config.yaml');
      fs.mkdirSync(installDir, { recursive: true });
      fs.writeFileSync(configFile, 'cfg: 1\n', 'utf8');

      const def = {
        id: 'mcp_reveal_test',
        binding: {
          type: 'stdio',
          executable: 'node.exe',
          cwd: installDir
        },
        locations: {
          sourceConfigPath: configFile,
          installationRoot: installDir
        }
      };

      // Reveal installation
      const revInstall = await resolver.reveal(def, 'installation');
      assert.equal(revInstall.revealed, true);
      assert.equal(revInstall.directory, installDir);
      assert.equal(revealedDirs.length, 1);

      // Reveal sourceConfig
      const revConfig = await resolver.reveal(def, 'sourceConfig');
      assert.equal(revConfig.revealed, true);
      assert.equal(revConfig.directory, tmpDir);
      assert.equal(revealedDirs.length, 2);

      // Reject invalid role
      await assert.rejects(
        async () => {
          await resolver.reveal(def, 'MALICIOUS_ROLE_OR_COMMAND');
        },
        (err) => err.code === 'INVALID_REVEAL_ROLE'
      );

      try {
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (_) {}
    });

  });

  // 3. HTTP authentication, session, CSRF guards on registry & discovery endpoints
  describe('3. HTTP authentication, session, and CSRF guards on registry & discovery endpoints', () => {

    it('rejects unauthenticated requests and missing CSRF tokens on /api/mcps and /api/discovery', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-guard-test-'));
      const h = await createHttpTestManager(tmpDir);

      try {
        const baseUrl = h.url;

        // 3.1 Unauthenticated requests return 401 UNAUTHORIZED
        const unauthEndpoints = [
          { method: 'GET', path: '/api/mcps' },
          { method: 'POST', path: '/api/mcps', body: { label: 'hack' } },
          { method: 'GET', path: '/api/discovery' },
          { method: 'POST', path: '/api/discovery/cand_123/import', body: {} },
          { method: 'POST', path: '/api/mcps/mcp_test/stop', body: {} }
        ];

        for (const ep of unauthEndpoints) {
          const res = await sendJsonRequest(baseUrl, ep.path, {
            method: ep.method,
            body: ep.body || null
          });
          assert.equal(res.status, 401, `${ep.method} ${ep.path} must return 401 without session`);
        }

        // 3.2 Forged session cookie returns 401
        const forgedRes = await sendJsonRequest(baseUrl, '/api/mcps', {
          headers: { cookie: 'sid=forged-sid-abc-123' }
        });
        assert.equal(forgedRes.status, 401);

        // 3.3 Setup password & login
        const bootstrapCode = fs.readFileSync(path.join(tmpDir, 'data', 'bootstrap-code.txt'), 'utf8').trim();
        const setupRes = await sendJsonRequest(baseUrl, '/api/auth/setup', {
          method: 'POST',
          body: { bootstrapCode, password: 'StrongAuthPassword!999' }
        });
        assert.equal(setupRes.status, 200);

        const loginRes = await sendJsonRequest(baseUrl, '/api/auth/login', {
          method: 'POST',
          body: { password: 'StrongAuthPassword!999' }
        });
        assert.equal(loginRes.status, 200);

        const sid = extractCookieSid(loginRes.headers);
        const csrfToken = loginRes.body.csrfToken;
        assert.ok(sid);
        assert.ok(csrfToken);

        // 3.4 Mutating request with valid session but missing CSRF token returns 403
        const noCsrfRes = await sendJsonRequest(baseUrl, '/api/mcps', {
          method: 'POST',
          headers: { cookie: `sid=${sid}` },
          body: { label: 'No CSRF MCP' }
        });
        assert.equal(noCsrfRes.status, 403, 'POST /api/mcps without CSRF token must return 403');

        // 3.5 Mutating request with invalid CSRF token returns 403
        const badCsrfRes = await sendJsonRequest(baseUrl, '/api/mcps', {
          method: 'POST',
          headers: {
            cookie: `sid=${sid}`,
            'x-csrf-token': 'bad-csrf-token-123'
          },
          body: { label: 'Bad CSRF MCP' }
        });
        assert.equal(badCsrfRes.status, 403);
      } finally {
        await h.close();
        try {
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (_) {}
      }
    });

  });

  // 4. Public DTO privacy: never leaks secret env values, API keys, raw sources, internal definition snapshots
  describe('4. Public DTO privacy: never leaks secret env values, API keys, raw sources, or snapshots', () => {

    it('verifies complete absence of sensitive secrets across all public DTO responses and error payloads', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-dto-test-'));
      const revealedLogs = [];
      const h = await createHttpTestManager(tmpDir, { revealedLogs });

      const SECRET_API_KEY_VAL = 'SYNTH_TOP_SECRET_API_KEY_ALPHA_777';
      const SECRET_ENV_VAL = 'SYNTH_SECRET_ENV_TOKEN_BETA_888';
      const SECRET_ARG_VAL = 'SYNTH_SECRET_CLI_ARG_GAMMA_999';
      const SECRET_HTTP_BEARER = 'SYNTH_SECRET_BEARER_TOKEN_DELTA_000';

      try {
        const baseUrl = h.url;

        // Setup & Login
        const bootstrapCode = fs.readFileSync(path.join(tmpDir, 'data', 'bootstrap-code.txt'), 'utf8').trim();
        await sendJsonRequest(baseUrl, '/api/auth/setup', {
          method: 'POST',
          body: { bootstrapCode, password: 'PrivacyTestComplexPassword!123' }
        });
        const loginRes = await sendJsonRequest(baseUrl, '/api/auth/login', {
          method: 'POST',
          body: { password: 'PrivacyTestComplexPassword!123' }
        });
        const sid = extractCookieSid(loginRes.headers);
        const csrfToken = loginRes.body.csrfToken;
        const authHeaders = {
          cookie: `sid=${sid}`,
          'x-csrf-token': csrfToken
        };

        // Create Stdio MCP with secrets
        const createStdioRes = await sendJsonRequest(baseUrl, '/api/mcps', {
          method: 'POST',
          headers: authHeaders,
          body: {
            label: 'Stdio Privacy MCP',
            expectedRevision: 0,
            binding: {
              type: 'stdio',
              executable: 'node',
              args: [
                { id: 'arg_file', value: 'server.js', secret: false },
                { id: 'arg_secret', value: SECRET_ARG_VAL, secret: true }
              ]
            },
            environment: {
              PUBLIC_VAR: { value: 'public-hello', secret: false },
              SECRET_VAR: { value: SECRET_ENV_VAL, secret: true },
              API_KEY: { value: SECRET_API_KEY_VAL, secret: false } // forced secret
            }
          }
        });

        assert.equal(createStdioRes.status, 201);
        const stdioMcpId = createStdioRes.body.mcp.id;

        // Check POST /api/mcps response text
        assert.equal(createStdioRes.raw.includes(SECRET_API_KEY_VAL), false, 'create response must not leak API key');
        assert.equal(createStdioRes.raw.includes(SECRET_ENV_VAL), false, 'create response must not leak env secret');
        assert.equal(createStdioRes.raw.includes(SECRET_ARG_VAL), false, 'create response must not leak secret arg');

        // Create HTTP MCP with secrets
        const createHttpRes = await sendJsonRequest(baseUrl, '/api/mcps', {
          method: 'POST',
          headers: authHeaders,
          body: {
            label: 'Http Privacy MCP',
            expectedRevision: 1,
            binding: {
              type: 'http',
              url: 'https://127.0.0.1:8443/mcp',
              headers: {
                Authorization: { value: `Bearer ${SECRET_HTTP_BEARER}`, secret: true }
              }
            }
          }
        });
        assert.equal(createHttpRes.status, 201);
        assert.equal(createHttpRes.raw.includes(SECRET_HTTP_BEARER), false, 'create HTTP response must not leak bearer token');

        // GET /api/mcps
        const listMcpsRes = await sendJsonRequest(baseUrl, '/api/mcps', { headers: authHeaders });
        assert.equal(listMcpsRes.status, 200);
        assert.equal(listMcpsRes.raw.includes(SECRET_API_KEY_VAL), false);
        assert.equal(listMcpsRes.raw.includes(SECRET_ENV_VAL), false);
        assert.equal(listMcpsRes.raw.includes(SECRET_ARG_VAL), false);
        assert.equal(listMcpsRes.raw.includes(SECRET_HTTP_BEARER), false);

        // GET /api/mcps/:id
        const getStdioRes = await sendJsonRequest(baseUrl, `/api/mcps/${stdioMcpId}`, { headers: authHeaders });
        assert.equal(getStdioRes.status, 200);
        assert.equal(getStdioRes.raw.includes(SECRET_API_KEY_VAL), false);
        assert.equal(getStdioRes.raw.includes(SECRET_ENV_VAL), false);
        assert.equal(getStdioRes.raw.includes(SECRET_ARG_VAL), false);

        // GET /api/discovery
        const getDiscoveryRes = await sendJsonRequest(baseUrl, '/api/discovery', { headers: authHeaders });
        assert.equal(getDiscoveryRes.status, 200);
        assert.equal(getDiscoveryRes.raw.includes('sample-dotenv-secret-key-999'), false);
        assert.equal(getDiscoveryRes.raw.includes('sample-bat-secret-key-888'), false);
        assert.equal(getDiscoveryRes.raw.includes('topsecret-env-value'), false);

        // POST /api/mcps/:id/stop: public action DTO must NOT leak registrySnapshot or originalRuntime secrets
        const stopRes = await sendJsonRequest(baseUrl, `/api/mcps/${stdioMcpId}/stop`, {
          method: 'POST',
          headers: {
            ...authHeaders,
            'idempotency-key': 'idemp-stop-priv-1'
          },
          body: { expectedRevision: 2 }
        });
        assert.equal(stopRes.status, 202);
        assert.equal(stopRes.raw.includes(SECRET_API_KEY_VAL), false);
        assert.equal(stopRes.raw.includes(SECRET_ENV_VAL), false);
        assert.equal(stopRes.raw.includes('registrySnapshot'), false, 'Public stop action DTO must not expose internal registrySnapshot');

        // Error payload privacy: revision conflict error returns only safe error code, never values
        const conflictRes = await sendJsonRequest(baseUrl, `/api/mcps/${stdioMcpId}`, {
          method: 'PATCH',
          headers: authHeaders,
          body: {
            label: 'Conflict Attempt',
            expectedRevision: 999
          }
        });
        assert.equal(conflictRes.status, 409);
        assert.equal(conflictRes.body.error.code, 'REVISION_CONFLICT');
        assert.equal(conflictRes.raw.includes(SECRET_API_KEY_VAL), false);
      } finally {
        await h.close();
        try {
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (_) {}
      }
    });

  });

});

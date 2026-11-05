import test, { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';

import { createVault } from '../../src/vault.mjs';
import { createSecurity } from '../../src/security.mjs';
import { openStore } from '../../src/store.mjs';
import { createHttpServer } from '../../src/server.mjs';
import { createMcpDiscovery } from '../../src/config/mcp-discovery.mjs';
import { createMcpLocationResolver } from '../../src/config/mcp-locations.mjs';
import { createConfigImporter } from '../../src/services/config-import.mjs';

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

describe('Route Private URL End-to-End Suite', () => {
  let tmpDir;
  let dataDir;
  let vault;
  let store;
  let security;
  let server;
  let baseUrl;
  let authHeaders;
  const capturedResponses = [];

  // High-entropy synthetic secret tokens to verify non-leakage
  const SECRET_QUERY_TOKEN_ALPHA = 'SYNTH_ALPHA_QUERY_SECRET_TOKEN_9988776655_XYZ';
  const SECRET_KEY_BETA = 'SYNTH_BETA_APIKEY_SECRET_5544332211_QWE';
  const SECRET_BEARER_GAMMA = 'SYNTH_GAMMA_BEARER_AUTH_4433221100_RST';
  const SECRET_SIG_DELTA = 'SYNTH_DELTA_CUSTOM_SIG_0011223344_JKL';
  const SECRET_NEW_QUERY_EPSILON = 'SYNTH_EPSILON_UPDATED_QUERY_SECRET_7766554433_MNO';
  const SECRET_USERINFO_PASS = 'SYNTH_ZETA_USERINFO_PASS_1122334455_VBN';

  const ALL_SECRETS = [
    SECRET_QUERY_TOKEN_ALPHA,
    SECRET_KEY_BETA,
    SECRET_BEARER_GAMMA,
    SECRET_SIG_DELTA,
    SECRET_NEW_QUERY_EPSILON,
    SECRET_USERINFO_PASS
  ];

  async function loggedRequest(reqPath, options = {}) {
    const res = await sendJsonRequest(baseUrl, reqPath, options);
    capturedResponses.push({ path: reqPath, ...res });
    return res;
  }

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-private-url-test-'));
    dataDir = path.join(tmpDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });

    vault = createVault({ dataDir });
    security = await createSecurity({ dataDir });
    store = openStore({ dataDir, vault });

    const discovery = createMcpDiscovery({ sources: [] });
    const importer = createConfigImporter({ repo: store, discovery });
    const locations = createMcpLocationResolver({
      dataDir,
      storePath: path.join(dataDir, 'manager.db'),
      stat: async (p) => fs.promises.stat(p),
      revealDirectory: async (dir) => ({ opened: true, directory: dir })
    });

    server = createHttpServer({
      repo: store,
      security,
      runner: { wake: () => {}, notify: () => {} },
      discovery,
      importer,
      locations
    });

    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    // Read bootstrap code, setup password and log in
    const bootstrapCode = fs.readFileSync(path.join(dataDir, 'bootstrap-code.txt'), 'utf8').trim();
    const setupRes = await sendJsonRequest(baseUrl, '/api/auth/setup', {
      method: 'POST',
      body: { bootstrapCode, password: 'StrictRoutePassword!2026' }
    });
    assert.equal(setupRes.status, 200, 'Setup must succeed');

    const loginRes = await sendJsonRequest(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { password: 'StrictRoutePassword!2026' }
    });
    assert.equal(loginRes.status, 200, 'Login must succeed');

    const sid = extractCookieSid(loginRes.headers);
    const csrfToken = loginRes.body?.csrfToken;
    assert.ok(sid, 'Session ID must be present');
    assert.ok(csrfToken, 'CSRF token must be present');

    authHeaders = {
      Cookie: `sid=${sid}`,
      'X-CSRF-Token': csrfToken
    };
  });

  after(async () => {
    if (server) {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await new Promise((r) => server.close(r));
    }
    if (store && typeof store.close === 'function') {
      try { store.close(); } catch (_) {}
    }
    if (security && typeof security.close === 'function') {
      try { await security.close(); } catch (_) {}
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });

  // =========================================================================
  // 1. Security Boundaries: Unauthenticated & Unauthorized Requests Rejected
  // =========================================================================
  describe('1. Security Boundaries: Unauthenticated & Unauthorized Requests', () => {
    it('rejects unauthenticated GET /api/mcps with 401 before reading store', async () => {
      const res = await loggedRequest('/api/mcps');
      assert.equal(res.status, 401);
      assert.equal(res.body?.error?.code, 'UNAUTHORIZED');
    });

    it('rejects unauthenticated GET /api/mcps/:id with 401', async () => {
      const res = await loggedRequest('/api/mcps/some_mcp_id');
      assert.equal(res.status, 401);
      assert.equal(res.body?.error?.code, 'UNAUTHORIZED');
    });

    it('rejects unauthenticated GET /api/state with 401', async () => {
      const res = await loggedRequest('/api/state');
      assert.equal(res.status, 401);
      assert.equal(res.body?.error?.code, 'UNAUTHORIZED');
    });

    it('rejects unauthenticated POST /api/mcps with 401', async () => {
      const res = await loggedRequest('/api/mcps', {
        method: 'POST',
        body: {
          label: 'Unauth MCP',
          binding: { type: 'http', url: 'https://example.com/api' }
        }
      });
      assert.equal(res.status, 401);
      assert.equal(res.body?.error?.code, 'UNAUTHORIZED');
    });

    it('rejects unauthenticated PATCH /api/mcps/:id with 401', async () => {
      const res = await loggedRequest('/api/mcps/some_mcp_id', {
        method: 'PATCH',
        body: { label: 'Patched Label' }
      });
      assert.equal(res.status, 401);
      assert.equal(res.body?.error?.code, 'UNAUTHORIZED');
    });

    it('rejects unauthenticated requests with invalid session cookie with 401', async () => {
      const badHeaders = {
        Cookie: 'sid=invalid-nonexistent-session-id',
        'X-CSRF-Token': 'test-csrf-token'
      };
      const res = await loggedRequest('/api/mcps', {
        method: 'POST',
        headers: badHeaders,
        body: {
          label: 'Bad Session MCP',
          binding: { type: 'http', url: 'https://example.com/api' }
        }
      });
      assert.equal(res.status, 401);
      assert.equal(res.body?.error?.code, 'UNAUTHORIZED');
    });

    it('rejects requests with invalid CSRF token on mutating requests with 403', async () => {
      const badHeaders = {
        ...authHeaders,
        'X-CSRF-Token': 'bogus-csrf-token-xyz'
      };
      const res = await loggedRequest('/api/mcps', {
        method: 'POST',
        headers: badHeaders,
        body: {
          label: 'Bad CSRF MCP',
          binding: { type: 'http', url: 'https://example.com/api' }
        }
      });
      assert.equal(res.status, 403);
      assert.equal(res.body?.error?.code, 'FORBIDDEN');
    });
  });

  // =========================================================================
  // 2. HTTP MCP Creation with Private Query URL & Secret Headers
  // =========================================================================
  describe('2. HTTP MCP Creation with Sensitive Query Parameters & Secret Headers', () => {
    let createdMcpId;

    it('creates HTTP MCP and returns safe public DTO omitting raw URL', async () => {
      const res = await loggedRequest('/api/mcps', {
        method: 'POST',
        headers: authHeaders,
        body: {
          id: 'mcp_http_sensitive',
          label: 'Sensitive HTTP MCP',
          expectedRevision: 0,
          binding: {
            type: 'http',
            url: `https://vault.internal.corp:8443/mcp/stream?token=${SECRET_QUERY_TOKEN_ALPHA}&apiKey=${SECRET_KEY_BETA}&region=us-east`,
            headers: {
              Authorization: { value: `Bearer ${SECRET_BEARER_GAMMA}`, secret: true },
              'X-Signature': { value: SECRET_SIG_DELTA, secret: true },
              'X-Public-App': { value: 'TestApp-v1', secret: false }
            }
          }
        }
      });

      assert.equal(res.status, 201, 'HTTP MCP creation should return 201');
      assert.ok(res.body?.mcp, 'Response must contain mcp');
      createdMcpId = res.body.mcp.id;
      assert.equal(createdMcpId, 'mcp_http_sensitive');

      const b = res.body.mcp.binding;
      assert.ok(b, 'Binding must be present in response');
      assert.equal(b.type, 'http');

      // Adherence to REGISTRY-FLASH-10-CONTRACT:
      // Private HTTP query raw url absent; safe urlDisplay/urlConfigured/hasPrivateQuery retained
      assert.equal(b.url, undefined, 'Raw binding.url must be undefined when private query params exist');
      assert.equal(b.urlDisplay, 'https://vault.internal.corp:8443/mcp/stream', 'urlDisplay must contain safe origin and pathname');
      assert.equal(b.urlConfigured, true, 'urlConfigured must be true');
      assert.equal(b.hasPrivateQuery, true, 'hasPrivateQuery must be true');

      // Secret headers masked
      assert.equal(b.headers.Authorization.secret, true);
      assert.equal(b.headers.Authorization.configured, true);
      assert.equal(Object.hasOwn(b.headers.Authorization, 'value'), false, 'Secret header Authorization value must be omitted');

      assert.equal(b.headers['X-Signature'].secret, true);
      assert.equal(b.headers['X-Signature'].configured, true);
      assert.equal(Object.hasOwn(b.headers['X-Signature'], 'value'), false, 'Secret header X-Signature value must be omitted');

      // Public header retained
      assert.equal(b.headers['X-Public-App'].secret, false);
      assert.equal(b.headers['X-Public-App'].value, 'TestApp-v1');

      // Zero leakage in raw response
      assert.equal(res.raw.includes(SECRET_QUERY_TOKEN_ALPHA), false, 'Response must not contain query token');
      assert.equal(res.raw.includes(SECRET_KEY_BETA), false, 'Response must not contain api key');
      assert.equal(res.raw.includes(SECRET_BEARER_GAMMA), false, 'Response must not contain bearer token');
      assert.equal(res.raw.includes(SECRET_SIG_DELTA), false, 'Response must not contain signature');
    });

    it('verifies GET /api/mcps omits raw url and includes urlDisplay/urlConfigured/hasPrivateQuery', async () => {
      const res = await loggedRequest('/api/mcps', { headers: authHeaders });
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body?.mcps));

      const found = res.body.mcps.find((m) => m.id === 'mcp_http_sensitive');
      assert.ok(found, 'Created MCP must appear in list');

      const b = found.binding;
      assert.equal(b.url, undefined, 'GET /api/mcps raw url must be absent');
      assert.equal(b.urlDisplay, 'https://vault.internal.corp:8443/mcp/stream');
      assert.equal(b.urlConfigured, true);
      assert.equal(b.hasPrivateQuery, true);

      assert.equal(b.headers.Authorization.secret, true);
      assert.equal(Object.hasOwn(b.headers.Authorization, 'value'), false);

      assert.equal(res.raw.includes(SECRET_QUERY_TOKEN_ALPHA), false);
      assert.equal(res.raw.includes(SECRET_KEY_BETA), false);
      assert.equal(res.raw.includes(SECRET_BEARER_GAMMA), false);
      assert.equal(res.raw.includes(SECRET_SIG_DELTA), false);
    });

    it('verifies GET /api/mcps/:id omits raw url and includes urlDisplay/urlConfigured/hasPrivateQuery', async () => {
      const res = await loggedRequest('/api/mcps/mcp_http_sensitive', { headers: authHeaders });
      assert.equal(res.status, 200);
      assert.ok(res.body?.mcp);

      const b = res.body.mcp.binding;
      assert.equal(b.url, undefined, 'GET /api/mcps/:id raw url must be absent');
      assert.equal(b.urlDisplay, 'https://vault.internal.corp:8443/mcp/stream');
      assert.equal(b.urlConfigured, true);
      assert.equal(b.hasPrivateQuery, true);

      assert.equal(b.headers.Authorization.secret, true);
      assert.equal(Object.hasOwn(b.headers.Authorization, 'value'), false);
      assert.equal(b.headers['X-Public-App'].value, 'TestApp-v1');

      assert.equal(res.raw.includes(SECRET_QUERY_TOKEN_ALPHA), false);
      assert.equal(res.raw.includes(SECRET_KEY_BETA), false);
      assert.equal(res.raw.includes(SECRET_BEARER_GAMMA), false);
      assert.equal(res.raw.includes(SECRET_SIG_DELTA), false);
    });

    it('verifies GET /api/state omits raw url and includes urlDisplay/urlConfigured/hasPrivateQuery', async () => {
      const res = await loggedRequest('/api/state', { headers: authHeaders });
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body?.mcps));

      const found = res.body.mcps.find((m) => m.id === 'mcp_http_sensitive');
      assert.ok(found, 'Created MCP must appear in /api/state mcps');

      const b = found.binding;
      assert.equal(b.url, undefined, 'GET /api/state raw url must be absent');
      assert.equal(b.urlDisplay, 'https://vault.internal.corp:8443/mcp/stream');
      assert.equal(b.urlConfigured, true);
      assert.equal(b.hasPrivateQuery, true);

      assert.equal(res.raw.includes(SECRET_QUERY_TOKEN_ALPHA), false);
      assert.equal(res.raw.includes(SECRET_KEY_BETA), false);
      assert.equal(res.raw.includes(SECRET_BEARER_GAMMA), false);
      assert.equal(res.raw.includes(SECRET_SIG_DELTA), false);
    });
  });

  // =========================================================================
  // 3. Non-private / Public Query & No-Query HTTP URLs
  // =========================================================================
  describe('3. Public Query & No-Query HTTP URLs', () => {
    it('creates HTTP MCP with public-only query and retains public url and urlDisplay', async () => {
      const publicUrl = 'https://public.example.com/api?format=json&version=2';
      const res = await loggedRequest('/api/mcps', {
        method: 'POST',
        headers: authHeaders,
        body: {
          id: 'mcp_http_public_query',
          label: 'Public Query MCP',
          binding: {
            type: 'http',
            url: publicUrl,
            headers: {}
          }
        }
      });

      assert.equal(res.status, 201);
      const b = res.body.mcp.binding;
      assert.equal(b.url, publicUrl, 'Public query URL should be retained in binding.url');
      assert.equal(b.urlDisplay, publicUrl, 'urlDisplay should equal url for public query');
      assert.equal(b.urlConfigured, true);
      assert.equal(Boolean(b.hasPrivateQuery), false, 'hasPrivateQuery should be falsey');
    });

    it('creates HTTP MCP with no query parameters and retains public url and urlDisplay', async () => {
      const noQueryUrl = 'https://no-query.example.com/mcp';
      const res = await loggedRequest('/api/mcps', {
        method: 'POST',
        headers: authHeaders,
        body: {
          id: 'mcp_http_no_query',
          label: 'No Query MCP',
          binding: {
            type: 'http',
            url: noQueryUrl,
            headers: {}
          }
        }
      });

      assert.equal(res.status, 201);
      const b = res.body.mcp.binding;
      assert.equal(b.url, noQueryUrl, 'No-query URL should be retained in binding.url');
      assert.equal(b.urlDisplay, noQueryUrl, 'urlDisplay should equal url for no-query');
      assert.equal(b.urlConfigured, true);
      assert.equal(Boolean(b.hasPrivateQuery), false, 'hasPrivateQuery should be falsey');
    });
  });

  // =========================================================================
  // 4. PATCH Updates: Omitting URL Retains Original Sensitive URL
  // =========================================================================
  describe('4. PATCH Updates: Retaining Original Sensitive URL When Omitted', () => {
    it('retains original private URL in store when PATCH payload omits url', async () => {
      const patchRes = await loggedRequest('/api/mcps/mcp_http_sensitive', {
        method: 'PATCH',
        headers: authHeaders,
        body: {
          label: 'Updated Sensitive HTTP MCP Label',
          binding: {
            type: 'http',
            headersPatch: [
              { op: 'set', name: 'X-New-Header', value: 'new-header-value', secret: false }
            ]
          }
        }
      });

      assert.equal(patchRes.status, 200);
      assert.equal(patchRes.body.mcp.label, 'Updated Sensitive HTTP MCP Label');

      const b = patchRes.body.mcp.binding;
      assert.equal(b.url, undefined, 'Raw url must still be omitted in PATCH response');
      assert.equal(b.urlDisplay, 'https://vault.internal.corp:8443/mcp/stream');
      assert.equal(b.urlConfigured, true);
      assert.equal(b.hasPrivateQuery, true);
      assert.equal(b.headers['X-New-Header'].value, 'new-header-value');

      // Verify the underlying unsealed definition in the store retained the full original URL
      const def = await store.registry.getDefinition('mcp_http_sensitive');
      assert.ok(def, 'Definition must exist');
      assert.equal(
        def.binding.url,
        `https://vault.internal.corp:8443/mcp/stream?token=${SECRET_QUERY_TOKEN_ALPHA}&apiKey=${SECRET_KEY_BETA}&region=us-east`,
        'Store definition must retain the exact original private URL with sensitive tokens'
      );

      // Verify response does not leak secrets
      assert.equal(patchRes.raw.includes(SECRET_QUERY_TOKEN_ALPHA), false);
      assert.equal(patchRes.raw.includes(SECRET_KEY_BETA), false);
    });
  });

  // =========================================================================
  // 5. PATCH Updates: Placeholder String Protection (No-Placeholder Writeback)
  // =========================================================================
  describe('5. PATCH Updates: Placeholder String Protection', () => {
    it('rejects placeholder string *** as URL and prevents placeholder writeback', async () => {
      const res = await loggedRequest('/api/mcps/mcp_http_sensitive', {
        method: 'PATCH',
        headers: authHeaders,
        body: {
          binding: {
            type: 'http',
            url: '***'
          }
        }
      });

      assert.equal(res.status, 400, 'Placeholder *** must be rejected as an invalid URL');
      assert.equal(res.body?.error?.code, 'INVALID_URL');

      // Verify definition still has original private URL and was not overwritten by ***
      const def = await store.registry.getDefinition('mcp_http_sensitive');
      assert.ok(def.binding.url.includes(SECRET_QUERY_TOKEN_ALPHA));
      assert.equal(def.binding.url.includes('***'), false, 'Literal placeholder must never be written into store');
    });

    it('rejects partial / malformed placeholder strings as URL', async () => {
      const invalidUrls = [
        '   ',
        'http://',
        '*',
        '**',
        'not_a_valid_url',
        'ftp://example.com/api',
        'javascript:alert(1)',
        'file:///etc/passwd'
      ];

      for (const invalidUrl of invalidUrls) {
        const res = await loggedRequest('/api/mcps/mcp_http_sensitive', {
          method: 'PATCH',
          headers: authHeaders,
          body: {
            binding: {
              type: 'http',
              url: invalidUrl
            }
          }
        });

        assert.equal(res.status, 400, `Invalid URL '${invalidUrl}' must be rejected with 400`);
      }

      // Verify definition remains intact
      const def = await store.registry.getDefinition('mcp_http_sensitive');
      assert.ok(def.binding.url.includes(SECRET_QUERY_TOKEN_ALPHA));
    });
  });

  // =========================================================================
  // 6. PATCH Updates: Passing New Valid URL Updates Correctly
  // =========================================================================
  describe('6. PATCH Updates: Updating with New Private URL', () => {
    it('updates HTTP MCP with new URL containing sensitive query parameters', async () => {
      const newUrl = `https://new-vault.internal.corp:9443/mcp/v2?session=${SECRET_NEW_QUERY_EPSILON}&cluster=eu-central`;

      const res = await loggedRequest('/api/mcps/mcp_http_sensitive', {
        method: 'PATCH',
        headers: authHeaders,
        body: {
          binding: {
            type: 'http',
            url: newUrl
          }
        }
      });

      assert.equal(res.status, 200);
      const b = res.body.mcp.binding;
      assert.equal(b.url, undefined, 'Updated raw url must be absent in public DTO');
      assert.equal(b.urlDisplay, 'https://new-vault.internal.corp:9443/mcp/v2', 'urlDisplay must reflect new origin and pathname');
      assert.equal(b.urlConfigured, true);
      assert.equal(b.hasPrivateQuery, true);

      // Verify in store definition
      const def = await store.registry.getDefinition('mcp_http_sensitive');
      assert.equal(def.binding.url, newUrl, 'Store definition must reflect updated URL');

      // Verify zero leakage of new secret token
      assert.equal(res.raw.includes(SECRET_NEW_QUERY_EPSILON), false, 'Response must not leak new secret query token');
    });
  });

  // =========================================================================
  // 7. Security Boundaries: Userinfo in URL Strictly Rejected (400)
  // =========================================================================
  describe('7. Security Boundaries: Userinfo in URL Rejection', () => {
    it('rejects POST /api/mcps with userinfo in URL and avoids credential leakage', async () => {
      const res = await loggedRequest('/api/mcps', {
        method: 'POST',
        headers: authHeaders,
        body: {
          id: 'mcp_http_userinfo_test',
          label: 'Userinfo MCP',
          binding: {
            type: 'http',
            url: `https://admin:${SECRET_USERINFO_PASS}@example.com/api`
          }
        }
      });

      assert.equal(res.status, 400, 'Userinfo URL must be rejected with 400');
      assert.equal(res.body?.error?.code, 'USERINFO_NOT_ALLOWED');
      assert.equal(res.raw.includes(SECRET_USERINFO_PASS), false, 'Error body must not leak userinfo password');
    });

    it('rejects PATCH /api/mcps/:id with userinfo in URL', async () => {
      const res = await loggedRequest('/api/mcps/mcp_http_sensitive', {
        method: 'PATCH',
        headers: authHeaders,
        body: {
          binding: {
            type: 'http',
            url: `https://user:${SECRET_USERINFO_PASS}@new-host.com/endpoint`
          }
        }
      });

      assert.equal(res.status, 400, 'Userinfo URL in PATCH must be rejected with 400');
      assert.equal(res.body?.error?.code, 'USERINFO_NOT_ALLOWED');
      assert.equal(res.raw.includes(SECRET_USERINFO_PASS), false, 'Error body must not leak userinfo password');
    });
  });

  // =========================================================================
  // 8. Global Plaintext Secret Leakage Audit
  // =========================================================================
  describe('8. Zero Plaintext Secret Leakage Audit', () => {
    it('verifies that zero plaintext secrets were leaked across all HTTP responses and errors', () => {
      assert.ok(capturedResponses.length >= 10, 'Must have recorded multiple HTTP interactions');

      for (const entry of capturedResponses) {
        for (const secret of ALL_SECRETS) {
          assert.equal(
            entry.raw.includes(secret),
            false,
            `Secret '${secret}' leaked in HTTP response for ${entry.path} (status: ${entry.status})`
          );
        }
      }
    });
  });
});

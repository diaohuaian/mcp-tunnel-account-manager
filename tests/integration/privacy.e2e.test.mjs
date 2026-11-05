import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { startManager } from '../../src/main.mjs';

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

function sendRawRequest(port, rawHttpString) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.write(rawHttpString);
    });
    const chunks = [];
    socket.on('data', (c) => chunks.push(c));
    socket.on('end', () => {
      const responseText = Buffer.concat(chunks).toString('utf8');
      const statusLine = responseText.split('\r\n')[0] || '';
      const match = statusLine.match(/HTTP\/1\.[01]\s+(\d+)/);
      const statusCode = match ? parseInt(match[1], 10) : null;
      resolve({ statusCode, raw: responseText });
    });
    socket.on('error', reject);
  });
}

function extractCookieSid(headers) {
  const raw = headers['set-cookie'];
  if (!raw) return null;
  const str = Array.isArray(raw) ? raw.join('; ') : raw;
  const match = str.match(/sid=([^;]+)/);
  return match ? decodeURIComponent(match[1].trim()) : null;
}

function createSyntheticAdapterFactory(capturedCalls = []) {
  return async () => {
    const createServiceAdapter = (service) => {
      const runningProc = {
        running: true,
        pid: 24680,
        executable: 'fake-synth-tunnel.mjs',
        startedAt: new Date().toISOString()
      };
      return {
        async prepare({ operationId, credential }) {
          capturedCalls.push({ action: 'prepare', service, operationId, credential });
          return {
            operationId,
            service,
            originalFingerprint: '0'.repeat(64),
            desiredFingerprint: '1'.repeat(64),
            originalConfig: { yaml: 'synth: 1' },
            desiredConfig: { yaml: 'synth: 2' },
            originalProcessIdentity: runningProc,
            credential
          };
        },
        async applyIfUnchanged() {
          capturedCalls.push({ action: 'applyIfUnchanged', service });
          return runningProc;
        },
        async verifyDesired({ operationId, snapshot }) {
          capturedCalls.push({ action: 'verifyDesired', service, operationId });
          return {
            verified: true,
            operationId,
            service,
            configFingerprint: snapshot.desiredFingerprint,
            proof: { kind: 'authenticated-control-plane' },
            identity: runningProc
          };
        },
        async restoreIfOwned({ operationId, snapshot }) {
          capturedCalls.push({ action: 'restoreIfOwned', service, operationId });
          return {
            restored: true,
            runtimeRestored: true,
            operationId,
            service,
            configFingerprint: snapshot.originalFingerprint
          };
        },
        async describe() {
          return {
            service,
            configured: true,
            running: true,
            config: { tunnelId: 'tunnel_***synth' }
          };
        }
      };
    };
    return {
      'overleaf-mcp': createServiceAdapter('overleaf-mcp'),
      'antigravity-mcp': createServiceAdapter('antigravity-mcp')
    };
  };
}

describe('Synthetic Privacy & Auth Persistence E2E Test Suite', () => {
  // 1. Protected routes, Host, Origin, and CSRF Rejection
  describe('1. Protected routes, Host, Origin, and CSRF rejection', () => {
    it('rejects unauthenticated requests, bad Host/Origin headers, and missing/invalid CSRF tokens', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-auth-test-'));
      let manager = null;

      try {
        manager = await startManager({
          dataDir: tempDir,
          host: '127.0.0.1',
          port: 0,
          adapterFactory: createSyntheticAdapterFactory()
        });

        const port = manager.port;
        const baseUrl = manager.url;

        // 1.1 Unauthenticated requests to protected endpoints return 401 UNAUTHORIZED
        const protectedGets = [
          '/api/state',
          '/api/profiles',
          '/api/profiles/non-existent-id',
          '/api/operations/non-existent-op'
        ];
        for (const reqPath of protectedGets) {
          const res = await sendJsonRequest(baseUrl, reqPath, { method: 'GET' });
          assert.equal(res.status, 401, `GET ${reqPath} must be 401 without auth`);
          assert.equal(res.body?.error?.code, 'UNAUTHORIZED');
        }

        const protectedWrites = [
          { path: '/api/profiles', method: 'POST', body: { label: 'hack' } },
          { path: '/api/profiles/hack-id', method: 'PATCH', body: { label: 'hack' } },
          { path: '/api/profiles/hack-id', method: 'DELETE', body: {} },
          { path: '/api/switch', method: 'POST', body: { profileId: 'hack-id' } }
        ];
        for (const reqInfo of protectedWrites) {
          const res = await sendJsonRequest(baseUrl, reqInfo.path, {
            method: reqInfo.method,
            body: reqInfo.body
          });
          assert.equal(res.status, 401, `${reqInfo.method} ${reqInfo.path} must be 401 without auth`);
          assert.equal(res.body?.error?.code, 'UNAUTHORIZED');
        }

        // 1.2 Invalid or forged session cookie returns 401 UNAUTHORIZED
        const forgedRes = await sendJsonRequest(baseUrl, '/api/state', {
          headers: { cookie: 'sid=forged-session-token-9999' }
        });
        assert.equal(forgedRes.status, 401);
        assert.equal(forgedRes.body?.error?.code, 'UNAUTHORIZED');

        // 1.3 Missing Host header on guarded routes or setup/login returns 403 (HTTP/1.0) or 400 (HTTP/1.1 RFC 7230)
        const noHost10Res = await sendRawRequest(port, 'GET /api/state HTTP/1.0\r\nConnection: close\r\n\r\n');
        assert.equal(noHost10Res.statusCode, 403, 'Missing Host header on guarded route in HTTP/1.0 must yield 403');

        const noHostSetup10Res = await sendRawRequest(port, 'POST /api/auth/setup HTTP/1.0\r\nContent-Length: 2\r\n\r\n{}');
        assert.equal(noHostSetup10Res.statusCode, 403, 'Missing Host header on setup in HTTP/1.0 must yield 403');

        const noHost11Res = await sendRawRequest(port, 'GET /api/state HTTP/1.1\r\nConnection: close\r\n\r\n');
        assert.equal(noHost11Res.statusCode, 400, 'Missing Host header in HTTP/1.1 must yield 400 RFC 7230 reject');

        // 1.4 Non-loopback Host header returns 403 FORBIDDEN on guarded and auth routes
        const hostileHostRes = await sendJsonRequest(baseUrl, '/api/auth/login', {
          method: 'POST',
          headers: { Host: 'evil.attacker.com' },
          body: { password: 'any' }
        });
        assert.equal(hostileHostRes.status, 403, 'Hostile Host header must yield 403');

        const lanHostRes = await sendJsonRequest(baseUrl, '/api/auth/login', {
          method: 'POST',
          headers: { Host: `192.168.1.100:${port}` },
          body: { password: 'any' }
        });
        assert.equal(lanHostRes.status, 403, 'LAN Host header must yield 403');

        // 1.5 Hostile / Mismatched Origin returns 403 FORBIDDEN on guarded and auth routes
        const hostileOriginRes = await sendJsonRequest(baseUrl, '/api/auth/login', {
          method: 'POST',
          headers: { Origin: 'http://evil.attacker.com' },
          body: { password: 'any' }
        });
        assert.equal(hostileOriginRes.status, 403, 'Hostile Origin must yield 403');

        const nullOriginRes = await sendJsonRequest(baseUrl, '/api/auth/login', {
          method: 'POST',
          headers: { Origin: 'null' },
          body: { password: 'any' }
        });
        assert.equal(nullOriginRes.status, 403, 'Origin null must yield 403');

        const mismatchedPortOriginRes = await sendJsonRequest(baseUrl, '/api/auth/login', {
          method: 'POST',
          headers: { Origin: 'http://127.0.0.1:9999' },
          body: { password: 'any' }
        });
        assert.equal(mismatchedPortOriginRes.status, 403, 'Mismatched Origin port must yield 403');

        // 1.6 Blocked by Sec-Fetch-Site cross-site
        const crossSiteRes = await sendJsonRequest(baseUrl, '/api/auth/login', {
          method: 'POST',
          headers: { 'Sec-Fetch-Site': 'cross-site' },
          body: { password: 'any' }
        });
        assert.equal(crossSiteRes.status, 403, 'Sec-Fetch-Site cross-site must yield 403');

        // Setup & Login to test CSRF token requirements on authenticated sessions
        const bootstrapCode = fs.readFileSync(path.join(tempDir, 'bootstrap-code.txt'), 'utf8').trim();
        const setupRes = await sendJsonRequest(baseUrl, '/api/auth/setup', {
          method: 'POST',
          body: { bootstrapCode, password: 'SynthAdminPassword!123' }
        });
        assert.equal(setupRes.status, 200);

        const loginRes = await sendJsonRequest(baseUrl, '/api/auth/login', {
          method: 'POST',
          body: { password: 'SynthAdminPassword!123' }
        });
        assert.equal(loginRes.status, 200);
        const sid = extractCookieSid(loginRes.headers);
        const csrfToken = loginRes.body.csrfToken;
        assert.ok(sid);
        assert.ok(csrfToken);

        // 1.7 Mutating requests without CSRF token header return 403 FORBIDDEN
        const authCookieHeader = { cookie: `sid=${sid}` };
        for (const reqInfo of protectedWrites) {
          const res = await sendJsonRequest(baseUrl, reqInfo.path, {
            method: reqInfo.method,
            headers: authCookieHeader, // No x-csrf-token
            body: reqInfo.body
          });
          assert.equal(res.status, 403, `${reqInfo.method} ${reqInfo.path} without CSRF token must return 403`);
          assert.equal(res.body?.error?.code, 'FORBIDDEN');
        }

        // 1.8 Mutating requests with invalid/mismatched CSRF token header return 403 FORBIDDEN
        const badCsrfHeader = { cookie: `sid=${sid}`, 'x-csrf-token': 'wrong-csrf-token-12345' };
        for (const reqInfo of protectedWrites) {
          const res = await sendJsonRequest(baseUrl, reqInfo.path, {
            method: reqInfo.method,
            headers: badCsrfHeader,
            body: reqInfo.body
          });
          assert.equal(res.status, 403, `${reqInfo.method} ${reqInfo.path} with wrong CSRF token must return 403`);
          assert.equal(res.body?.error?.code, 'FORBIDDEN');
        }

        // 1.9 Logout terminates session and subsequent requests fail
        const logoutRes = await sendJsonRequest(baseUrl, '/api/auth/logout', {
          method: 'POST',
          headers: { cookie: `sid=${sid}`, 'x-csrf-token': csrfToken }
        });
        assert.equal(logoutRes.status, 200);

        const afterLogoutRes = await sendJsonRequest(baseUrl, '/api/state', {
          headers: authCookieHeader
        });
        assert.equal(afterLogoutRes.status, 401, 'Request with logged out session must return 401');
      } finally {
        if (manager && typeof manager.close === 'function') {
          await manager.close();
        }
        try {
          if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
          }
        } catch (_) {}
      }
    });
  });

  // 2. API, List, Errors Never Expose Synthetic Key, Bootstrap, or Password
  describe('2. API, list, and errors never expose synthetic secrets', () => {
    it('verifies that synthetic API keys, bootstrap codes, and admin passwords are never exposed in API responses or errors', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-secrets-test-'));
      let manager = null;

      const SYNTH_SECRET_OVL_KEY = 'SYNTH_PRIV_OVL_KEY_001_SECRET_ALPHA';
      const SYNTH_SECRET_ANT_KEY = 'SYNTH_PRIV_ANT_KEY_002_SECRET_BETA';
      const SYNTH_ADMIN_PASSWORD = 'SynthAdminComplexPassword!#999';

      try {
        manager = await startManager({
          dataDir: tempDir,
          host: '127.0.0.1',
          port: 0,
          adapterFactory: createSyntheticAdapterFactory()
        });
        const baseUrl = manager.url;

        // Verify initial state response does not expose bootstrap code
        const stateRes0 = await sendJsonRequest(baseUrl, '/api/auth/state');
        assert.equal(stateRes0.status, 200);
        assert.equal(stateRes0.body.configured, false);
        const bootstrapCode = fs.readFileSync(path.join(tempDir, 'bootstrap-code.txt'), 'utf8').trim();
        assert.equal(stateRes0.raw.includes(bootstrapCode), false, 'Bootstrap code must not leak in state');

        // Setup admin password
        const setupRes = await sendJsonRequest(baseUrl, '/api/auth/setup', {
          method: 'POST',
          body: { bootstrapCode, password: SYNTH_ADMIN_PASSWORD }
        });
        assert.equal(setupRes.status, 200);
        assert.equal(setupRes.raw.includes(SYNTH_ADMIN_PASSWORD), false, 'Password must not leak in setup response');
        assert.equal(setupRes.raw.includes(bootstrapCode), false, 'Bootstrap code must not leak in setup response');

        // Login
        const loginRes = await sendJsonRequest(baseUrl, '/api/auth/login', {
          method: 'POST',
          body: { password: SYNTH_ADMIN_PASSWORD }
        });
        assert.equal(loginRes.status, 200);
        assert.equal(loginRes.raw.includes(SYNTH_ADMIN_PASSWORD), false, 'Password must not leak in login response');
        const sid = extractCookieSid(loginRes.headers);
        const csrfToken = loginRes.body.csrfToken;
        const authHeaders = {
          cookie: `sid=${sid}`,
          'x-csrf-token': csrfToken
        };

        // Create profile with synthetic secrets
        const createProfileRes = await sendJsonRequest(baseUrl, '/api/profiles', {
          method: 'POST',
          headers: authHeaders,
          body: {
            label: 'Synthetic Privacy Profile',
            services: {
              'overleaf-mcp': { tunnelId: 'tunnel_overleaf_synth_11', apiKey: SYNTH_SECRET_OVL_KEY },
              'antigravity-mcp': { tunnelId: 'tunnel_antigravity_synth_22', apiKey: SYNTH_SECRET_ANT_KEY }
            }
          }
        });
        assert.equal(createProfileRes.status, 200);
        const profileId = createProfileRes.body.id;

        // Assert response DTO never contains raw API keys
        assert.equal(createProfileRes.raw.includes(SYNTH_SECRET_OVL_KEY), false, 'createProfile response must not leak overleaf apiKey');
        assert.equal(createProfileRes.raw.includes(SYNTH_SECRET_ANT_KEY), false, 'createProfile response must not leak antigravity apiKey');
        assert.equal(createProfileRes.body.services['overleaf-mcp'].hasApiKey, true);
        assert.equal(createProfileRes.body.services['antigravity-mcp'].hasApiKey, true);

        // GET /api/profiles
        const listRes = await sendJsonRequest(baseUrl, '/api/profiles', { headers: authHeaders });
        assert.equal(listRes.status, 200);
        assert.equal(listRes.raw.includes(SYNTH_SECRET_OVL_KEY), false, 'GET /api/profiles must not contain overleaf apiKey');
        assert.equal(listRes.raw.includes(SYNTH_SECRET_ANT_KEY), false, 'GET /api/profiles must not contain antigravity apiKey');

        // GET /api/profiles/:id
        const singleRes = await sendJsonRequest(baseUrl, `/api/profiles/${profileId}`, { headers: authHeaders });
        assert.equal(singleRes.status, 200);
        assert.equal(singleRes.raw.includes(SYNTH_SECRET_OVL_KEY), false, 'GET /api/profiles/:id must not contain overleaf apiKey');
        assert.equal(singleRes.raw.includes(SYNTH_SECRET_ANT_KEY), false, 'GET /api/profiles/:id must not contain antigravity apiKey');

        // GET /api/state
        const stateRes = await sendJsonRequest(baseUrl, '/api/state', { headers: authHeaders });
        assert.equal(stateRes.status, 200);
        assert.equal(stateRes.raw.includes(SYNTH_SECRET_OVL_KEY), false, 'GET /api/state must not contain overleaf apiKey');
        assert.equal(stateRes.raw.includes(SYNTH_SECRET_ANT_KEY), false, 'GET /api/state must not contain antigravity apiKey');

        // POST /api/switch & GET /api/operations/:id
        const switchRes = await sendJsonRequest(baseUrl, '/api/switch', {
          method: 'POST',
          headers: authHeaders,
          body: { profileId, targets: ['overleaf-mcp'] }
        });
        assert.equal(switchRes.status, 202);
        assert.equal(switchRes.raw.includes(SYNTH_SECRET_OVL_KEY), false, 'POST /api/switch response must not contain apiKey');
        const opId = switchRes.body.operation.id;

        const opRes = await sendJsonRequest(baseUrl, `/api/operations/${opId}`, { headers: authHeaders });
        assert.equal(opRes.status, 200);
        assert.equal(opRes.raw.includes(SYNTH_SECRET_OVL_KEY), false, 'GET /api/operations/:id must not contain apiKey');
        assert.equal(opRes.body.pinnedCredentials, undefined, 'pinnedCredentials must not be exposed in public operation');

        // Error responses never leak secrets
        // 1. Conflict error
        const conflictRes = await sendJsonRequest(baseUrl, '/api/profiles', {
          method: 'POST',
          headers: authHeaders,
          body: { id: profileId, label: 'Duplicate Profile' }
        });
        assert.equal(conflictRes.status, 409);
        assert.equal(conflictRes.raw.includes(SYNTH_SECRET_OVL_KEY), false);
        assert.deepEqual(conflictRes.body, { error: { code: 'CONFLICT', status: 409 } });

        // 2. Failed login attempt
        const failedLoginRes = await sendJsonRequest(baseUrl, '/api/auth/login', {
          method: 'POST',
          body: { password: 'WrongPasswordGuess!' }
        });
        assert.equal(failedLoginRes.status, 401);
        assert.equal(failedLoginRes.raw.includes(SYNTH_ADMIN_PASSWORD), false);
        assert.equal(failedLoginRes.body?.error?.code, 'UNAUTHORIZED');

        // 3. Repeated setup attempt when already configured
        const repeatedSetupRes = await sendJsonRequest(baseUrl, '/api/auth/setup', {
          method: 'POST',
          body: { bootstrapCode, password: 'AnotherPassword!' }
        });
        assert.equal(repeatedSetupRes.status, 400);
        assert.equal(repeatedSetupRes.raw.includes(SYNTH_ADMIN_PASSWORD), false);
        assert.equal(repeatedSetupRes.raw.includes(bootstrapCode), false);
      } finally {
        if (manager && typeof manager.close === 'function') {
          await manager.close();
        }
        try {
          if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
          }
        } catch (_) {}
      }
    });
  });

  // 3. Saved Profiles Survive Manager Restart
  describe('3. Saved profiles survive manager restart', () => {
    it('persists encrypted profiles across clean manager shutdown and reboot, maintaining unseal capability', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-restart-test-'));
      let manager1 = null;
      let manager2 = null;

      const capturedCalls1 = [];
      const capturedCalls2 = [];

      const SYNTH_OVL_KEY = 'synth_key_survives_restart_ovl_99';
      const SYNTH_ANT_KEY = 'synth_key_survives_restart_ant_88';
      const ADMIN_PW = 'RestartPassword!2026';
      let profileId = null;

      try {
        // --- Instance 1 ---
        manager1 = await startManager({
          dataDir: tempDir,
          host: '127.0.0.1',
          port: 0,
          adapterFactory: createSyntheticAdapterFactory(capturedCalls1)
        });

        const bootstrapCode = fs.readFileSync(path.join(tempDir, 'bootstrap-code.txt'), 'utf8').trim();
        await sendJsonRequest(manager1.url, '/api/auth/setup', {
          method: 'POST',
          body: { bootstrapCode, password: ADMIN_PW }
        });

        const loginRes1 = await sendJsonRequest(manager1.url, '/api/auth/login', {
          method: 'POST',
          body: { password: ADMIN_PW }
        });
        const sid1 = extractCookieSid(loginRes1.headers);
        const csrf1 = loginRes1.body.csrfToken;
        const authHeaders1 = { cookie: `sid=${sid1}`, 'x-csrf-token': csrf1 };

        const createRes = await sendJsonRequest(manager1.url, '/api/profiles', {
          method: 'POST',
          headers: authHeaders1,
          body: {
            label: 'Persistent Profile Alpha',
            services: {
              'overleaf-mcp': { tunnelId: 'tunnel_ovl_restart_01', apiKey: SYNTH_OVL_KEY },
              'antigravity-mcp': { tunnelId: 'tunnel_ant_restart_02', apiKey: SYNTH_ANT_KEY }
            }
          }
        });
        assert.equal(createRes.status, 200);
        profileId = createRes.body.id;

        // Clean shutdown of Instance 1
        await manager1.close();
        manager1 = null;

        // --- Instance 2 (Reboot from same dataDir) ---
        manager2 = await startManager({
          dataDir: tempDir,
          host: '127.0.0.1',
          port: 0,
          adapterFactory: createSyntheticAdapterFactory(capturedCalls2)
        });

        // 3.1 Auth state indicates configured
        const stateRes2 = await sendJsonRequest(manager2.url, '/api/auth/state');
        assert.equal(stateRes2.status, 200);
        assert.equal(stateRes2.body.configured, true);

        // 3.2 Login with established password
        const loginRes2 = await sendJsonRequest(manager2.url, '/api/auth/login', {
          method: 'POST',
          body: { password: ADMIN_PW }
        });
        assert.equal(loginRes2.status, 200);
        const sid2 = extractCookieSid(loginRes2.headers);
        const csrf2 = loginRes2.body.csrfToken;
        const authHeaders2 = { cookie: `sid=${sid2}`, 'x-csrf-token': csrf2 };

        // 3.3 Verify profile survived restart
        const profileRes2 = await sendJsonRequest(manager2.url, `/api/profiles/${profileId}`, {
          headers: authHeaders2
        });
        assert.equal(profileRes2.status, 200);
        assert.equal(profileRes2.body.id, profileId);
        assert.equal(profileRes2.body.label, 'Persistent Profile Alpha');
        assert.equal(profileRes2.body.revision, 1);
        assert.equal(profileRes2.body.services['overleaf-mcp'].hasApiKey, true);
        assert.equal(profileRes2.body.services['antigravity-mcp'].hasApiKey, true);

        // 3.4 Verify credentials can be unsealed and applied by runner in instance 2
        const switchRes2 = await sendJsonRequest(manager2.url, '/api/switch', {
          method: 'POST',
          headers: authHeaders2,
          body: { profileId, targets: ['overleaf-mcp', 'antigravity-mcp'] }
        });
        assert.equal(switchRes2.status, 202);
        const opId = switchRes2.body.operation.id;

        // Wait for switch to finish
        let succeeded = false;
        for (let i = 0; i < 30; i++) {
          const pollRes = await sendJsonRequest(manager2.url, `/api/operations/${opId}`, {
            headers: authHeaders2
          });
          if (pollRes.body?.status === 'SUCCEEDED') {
            succeeded = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(succeeded, 'Switch operation on instance 2 must succeed');

        // Check captured calls: adapter received correctly unsealed credentials
        const ovlPrepare = capturedCalls2.find((c) => c.action === 'prepare' && c.service === 'overleaf-mcp');
        assert.ok(ovlPrepare, 'Adapter prepare must have been invoked');
        assert.equal(ovlPrepare.credential.apiKey, SYNTH_OVL_KEY, 'Unsealed apiKey must match pre-restart key');
        assert.equal(ovlPrepare.credential.tunnelId, 'tunnel_ovl_restart_01');
      } finally {
        if (manager1 && typeof manager1.close === 'function') await manager1.close();
        if (manager2 && typeof manager2.close === 'function') await manager2.close();
        try {
          if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
          }
        } catch (_) {}
      }
    });
  });

  // 4. Blank Key Patch Retention
  describe('4. Blank key patch retention', () => {
    it('retains existing sealed apiKey when PATCH modifies tunnelId or orgId without providing a new apiKey', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-blank-key-test-'));
      let manager = null;
      const capturedCalls = [];

      const SYNTH_ORIGINAL_KEY = 'SYNTH_ORIGINAL_RETAINED_KEY_12345';
      const ADMIN_PW = 'BlankKeyAdminPassword!1';

      try {
        manager = await startManager({
          dataDir: tempDir,
          host: '127.0.0.1',
          port: 0,
          adapterFactory: createSyntheticAdapterFactory(capturedCalls)
        });

        const bootstrapCode = fs.readFileSync(path.join(tempDir, 'bootstrap-code.txt'), 'utf8').trim();
        await sendJsonRequest(manager.url, '/api/auth/setup', {
          method: 'POST',
          body: { bootstrapCode, password: ADMIN_PW }
        });

        const loginRes = await sendJsonRequest(manager.url, '/api/auth/login', {
          method: 'POST',
          body: { password: ADMIN_PW }
        });
        const sid = extractCookieSid(loginRes.headers);
        const csrfToken = loginRes.body.csrfToken;
        const authHeaders = { cookie: `sid=${sid}`, 'x-csrf-token': csrfToken };

        // 4.1 Create initial profile with API Key
        const createRes = await sendJsonRequest(manager.url, '/api/profiles', {
          method: 'POST',
          headers: authHeaders,
          body: {
            label: 'Blank Key Retention Profile',
            services: {
              'overleaf-mcp': {
                tunnelId: 'tunnel_ovl_original_v1',
                apiKey: SYNTH_ORIGINAL_KEY
              }
            }
          }
        });
        assert.equal(createRes.status, 200);
        const profileId = createRes.body.id;
        assert.equal(createRes.body.services['overleaf-mcp'].hasApiKey, true);

        // 4.2 PATCH profile: user modifies tunnelId and leaves apiKey blank (omitted from payload as done by UI)
        const patchRes = await sendJsonRequest(manager.url, `/api/profiles/${profileId}`, {
          method: 'PATCH',
          headers: authHeaders,
          body: {
            services: {
              'overleaf-mcp': {
                tunnelId: 'tunnel_ovl_updated_v2'
                // apiKey is intentionally omitted (blank retention)
              }
            }
          }
        });
        assert.equal(patchRes.status, 200);
        assert.equal(patchRes.body.revision, 2);
        assert.equal(patchRes.body.services['overleaf-mcp'].hasApiKey, true, 'hasApiKey must remain true after blank key PATCH');
        assert.equal(patchRes.raw.includes(SYNTH_ORIGINAL_KEY), false, 'Raw key must not leak in PATCH response');

        // 4.3 Trigger switch to verify the unsealed credential retained the original apiKey
        const switchRes = await sendJsonRequest(manager.url, '/api/switch', {
          method: 'POST',
          headers: authHeaders,
          body: { profileId, targets: ['overleaf-mcp'] }
        });
        assert.equal(switchRes.status, 202);
        const opId = switchRes.body.operation.id;

        let finished = false;
        for (let i = 0; i < 30; i++) {
          const pollRes = await sendJsonRequest(manager.url, `/api/operations/${opId}`, {
            headers: authHeaders
          });
          if (pollRes.body?.status === 'SUCCEEDED') {
            finished = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(finished);

        // Inspect captured credential passed to adapter prepare
        const prepareCall = capturedCalls.find(
          (c) => c.action === 'prepare' && c.service === 'overleaf-mcp' && c.operationId === opId
        );
        assert.ok(prepareCall, 'Adapter prepare must have been executed');
        assert.equal(prepareCall.credential.tunnelId, 'tunnel_ovl_updated_v2', 'tunnelId must be updated');
        assert.equal(prepareCall.credential.apiKey, SYNTH_ORIGINAL_KEY, 'Original apiKey must be preserved');
      } finally {
        if (manager && typeof manager.close === 'function') await manager.close();
        try {
          if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
          }
        } catch (_) {}
      }
    });
  });

  // 5. AEAD Tamper and Record-Swap Detection
  describe('5. AEAD tamper and record-swap fails', () => {
    it('detects and rejects ciphertext/tag tampering, profile-swap attacks, and service-swap attacks due to AAD mismatch', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-aead-test-'));
      let manager = null;
      const ADMIN_PW = 'AeadTestAdminPassword!1';

      try {
        manager = await startManager({
          dataDir: tempDir,
          host: '127.0.0.1',
          port: 0,
          adapterFactory: createSyntheticAdapterFactory()
        });

        const bootstrapCode = fs.readFileSync(path.join(tempDir, 'bootstrap-code.txt'), 'utf8').trim();
        await sendJsonRequest(manager.url, '/api/auth/setup', {
          method: 'POST',
          body: { bootstrapCode, password: ADMIN_PW }
        });

        const loginRes = await sendJsonRequest(manager.url, '/api/auth/login', {
          method: 'POST',
          body: { password: ADMIN_PW }
        });
        const sid = extractCookieSid(loginRes.headers);
        const csrfToken = loginRes.body.csrfToken;
        const authHeaders = { cookie: `sid=${sid}`, 'x-csrf-token': csrfToken };

        // Create Profile A
        const profileARes = await sendJsonRequest(manager.url, '/api/profiles', {
          method: 'POST',
          headers: authHeaders,
          body: {
            label: 'Profile A',
            services: {
              'overleaf-mcp': { tunnelId: 'tunnel_a_ovl', apiKey: 'key_a_ovl' },
              'antigravity-mcp': { tunnelId: 'tunnel_a_ant', apiKey: 'key_a_ant' }
            }
          }
        });
        const profileAId = profileARes.body.id;

        // Create Profile B
        const profileBRes = await sendJsonRequest(manager.url, '/api/profiles', {
          method: 'POST',
          headers: authHeaders,
          body: {
            label: 'Profile B',
            services: {
              'overleaf-mcp': { tunnelId: 'tunnel_b_ovl', apiKey: 'key_b_ovl' },
              'antigravity-mcp': { tunnelId: 'tunnel_b_ant', apiKey: 'key_b_ant' }
            }
          }
        });
        const profileBId = profileBRes.body.id;

        // Close manager to tamper directly with underlying SQLite database safely
        await manager.close();
        manager = null;

        const dbPath = path.join(tempDir, 'manager.db');
        const db = new DatabaseSync(dbPath);

        // 5.1 Test Ciphertext Tampering: Flip bytes in Profile A's sealed ciphertext
        const rowA = db.prepare('SELECT sealed_credentials FROM profiles WHERE id = ?').get(profileAId);
        const credsA = JSON.parse(rowA.sealed_credentials);
        const originalEnv = credsA['overleaf-mcp'];

        // Corrupt ciphertext data
        const dataBuf = Buffer.from(originalEnv.data, 'base64');
        dataBuf[0] ^= 0xff; // Flip first byte
        const tamperedEnv = {
          ...originalEnv,
          data: dataBuf.toString('base64')
        };
        const tamperedCredsA = {
          ...credsA,
          'overleaf-mcp': tamperedEnv
        };

        db.prepare('UPDATE profiles SET sealed_credentials = ? WHERE id = ?').run(
          JSON.stringify(tamperedCredsA),
          profileAId
        );
        db.close();

        // Restart manager and verify unseal / switch rejects tampered profile
        manager = await startManager({
          dataDir: tempDir,
          host: '127.0.0.1',
          port: 0,
          adapterFactory: createSyntheticAdapterFactory()
        });

        const loginRes2 = await sendJsonRequest(manager.url, '/api/auth/login', {
          method: 'POST',
          body: { password: ADMIN_PW }
        });
        const sid2 = extractCookieSid(loginRes2.headers);
        const csrfToken2 = loginRes2.body.csrfToken;
        const authHeaders2 = { cookie: `sid=${sid2}`, 'x-csrf-token': csrfToken2 };

        // Attempt switch with tampered Profile A: store.createOperation attempts to unseal Profile A credentials
        const tamperedSwitchRes = await sendJsonRequest(manager.url, '/api/switch', {
          method: 'POST',
          headers: authHeaders2,
          body: { profileId: profileAId, targets: ['overleaf-mcp'] }
        });
        // createOperation throws when unsealing tampered ciphertext, returning 500
        assert.equal(tamperedSwitchRes.status, 500, 'Switch with tampered ciphertext must fail');
        assert.equal(tamperedSwitchRes.body?.error?.code, 'INTERNAL_ERROR');

        await manager.close();
        manager = null;

        // 5.2 Test Record-Swap: Swap Profile A sealed envelope into Profile B
        const db2 = new DatabaseSync(dbPath);
        // Put valid uncorrupted envelope from Profile B into Profile A's slot
        const rowB = db2.prepare('SELECT sealed_credentials FROM profiles WHERE id = ?').get(profileBId);
        const credsB = JSON.parse(rowB.sealed_credentials);

        // Put Profile B's sealed envelope into Profile A's row
        db2.prepare('UPDATE profiles SET sealed_credentials = ? WHERE id = ?').run(
          JSON.stringify(credsB),
          profileAId
        );
        db2.close();

        manager = await startManager({
          dataDir: tempDir,
          host: '127.0.0.1',
          port: 0,
          adapterFactory: createSyntheticAdapterFactory()
        });

        const loginRes3 = await sendJsonRequest(manager.url, '/api/auth/login', {
          method: 'POST',
          body: { password: ADMIN_PW }
        });
        const sid3 = extractCookieSid(loginRes3.headers);
        const csrfToken3 = loginRes3.body.csrfToken;
        const authHeaders3 = { cookie: `sid=${sid3}`, 'x-csrf-token': csrfToken3 };

        // Attempt switch on Profile A with Profile B's credentials:
        // AAD mismatch (Profile A AAD vs Profile B sealed AAD) causes unseal failure
        const swapSwitchRes = await sendJsonRequest(manager.url, '/api/switch', {
          method: 'POST',
          headers: authHeaders3,
          body: { profileId: profileAId, targets: ['overleaf-mcp'] }
        });
        assert.equal(swapSwitchRes.status, 500, 'Cross-profile swapped record must fail due to AAD mismatch');
        assert.equal(swapSwitchRes.body?.error?.code, 'INTERNAL_ERROR');

        await manager.close();
        manager = null;

        // 5.3 Test Service-Swap: Swap overleaf-mcp and antigravity-mcp envelopes within Profile B
        const db3 = new DatabaseSync(dbPath);
        const rowB3 = db3.prepare('SELECT sealed_credentials FROM profiles WHERE id = ?').get(profileBId);
        const credsB3 = JSON.parse(rowB3.sealed_credentials);
        const swappedServiceCreds = {
          'overleaf-mcp': credsB3['antigravity-mcp'],
          'antigravity-mcp': credsB3['overleaf-mcp']
        };
        db3.prepare('UPDATE profiles SET sealed_credentials = ? WHERE id = ?').run(
          JSON.stringify(swappedServiceCreds),
          profileBId
        );
        db3.close();

        manager = await startManager({
          dataDir: tempDir,
          host: '127.0.0.1',
          port: 0,
          adapterFactory: createSyntheticAdapterFactory()
        });

        const loginRes4 = await sendJsonRequest(manager.url, '/api/auth/login', {
          method: 'POST',
          body: { password: ADMIN_PW }
        });
        const sid4 = extractCookieSid(loginRes4.headers);
        const csrfToken4 = loginRes4.body.csrfToken;
        const authHeaders4 = { cookie: `sid=${sid4}`, 'x-csrf-token': csrfToken4 };

        const serviceSwapRes = await sendJsonRequest(manager.url, '/api/switch', {
          method: 'POST',
          headers: authHeaders4,
          body: { profileId: profileBId, targets: ['overleaf-mcp'] }
        });
        assert.equal(serviceSwapRes.status, 500, 'Cross-service swapped envelope must fail due to AAD mismatch');
        assert.equal(serviceSwapRes.body?.error?.code, 'INTERNAL_ERROR');
      } finally {
        if (manager && typeof manager.close === 'function') await manager.close();
        try {
          if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
          }
        } catch (_) {}
      }
    });
  });

  // 6. No Plaintext Credential in Synthetic DB / WAL
  describe('6. No plaintext credential in synthetic DB and WAL', () => {
    it('ensures synthetic API keys, admin passwords, and bootstrap codes never appear in SQLite DB, WAL, or SHM files', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-disk-scan-test-'));
      let manager = null;

      const SYNTH_SECRET_1 = 'SYNTH_SUPER_SECRET_KEY_OVL_DBWAL_CHECK_99999999';
      const SYNTH_SECRET_2 = 'SYNTH_SUPER_SECRET_KEY_ANT_DBWAL_CHECK_88888888';
      const SYNTH_PASSWORD = 'Synth_UltraSecret_Password_2026!#$';

      try {
        manager = await startManager({
          dataDir: tempDir,
          host: '127.0.0.1',
          port: 0,
          adapterFactory: createSyntheticAdapterFactory()
        });

        const bootstrapCode = fs.readFileSync(path.join(tempDir, 'bootstrap-code.txt'), 'utf8').trim();

        await sendJsonRequest(manager.url, '/api/auth/setup', {
          method: 'POST',
          body: { bootstrapCode, password: SYNTH_PASSWORD }
        });

        const loginRes = await sendJsonRequest(manager.url, '/api/auth/login', {
          method: 'POST',
          body: { password: SYNTH_PASSWORD }
        });
        const sid = extractCookieSid(loginRes.headers);
        const csrfToken = loginRes.body.csrfToken;
        const authHeaders = { cookie: `sid=${sid}`, 'x-csrf-token': csrfToken };

        // Create profile
        const createRes = await sendJsonRequest(manager.url, '/api/profiles', {
          method: 'POST',
          headers: authHeaders,
          body: {
            label: 'DB WAL Check Profile',
            services: {
              'overleaf-mcp': { tunnelId: 'tunnel_dbwal_ovl', apiKey: SYNTH_SECRET_1 },
              'antigravity-mcp': { tunnelId: 'tunnel_dbwal_ant', apiKey: SYNTH_SECRET_2 }
            }
          }
        });
        assert.equal(createRes.status, 200);
        const profileId = createRes.body.id;

        // Perform switch operation
        const switchRes = await sendJsonRequest(manager.url, '/api/switch', {
          method: 'POST',
          headers: authHeaders,
          body: { profileId, targets: ['overleaf-mcp', 'antigravity-mcp'] }
        });
        assert.equal(switchRes.status, 202);
        const opId = switchRes.body.operation.id;

        for (let i = 0; i < 30; i++) {
          const pollRes = await sendJsonRequest(manager.url, `/api/operations/${opId}`, {
            headers: authHeaders
          });
          if (pollRes.body?.status === 'SUCCEEDED') break;
          await new Promise((r) => setTimeout(r, 100));
        }

        // Close manager cleanly to flush sqlite WAL
        await manager.close();
        manager = null;

        // Inspect database and WAL files directly on disk
        const dbPath = path.join(tempDir, 'manager.db');
        const walPath = path.join(tempDir, 'manager.db-wal');
        const shmPath = path.join(tempDir, 'manager.db-shm');

        const dbBuffer = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : Buffer.alloc(0);
        const walBuffer = fs.existsSync(walPath) ? fs.readFileSync(walPath) : Buffer.alloc(0);
        const shmBuffer = fs.existsSync(shmPath) ? fs.readFileSync(shmPath) : Buffer.alloc(0);

        const secretsToCheck = [
          SYNTH_SECRET_1,
          SYNTH_SECRET_2,
          SYNTH_PASSWORD,
          bootstrapCode
        ];

        for (const secret of secretsToCheck) {
          const secretBuf = Buffer.from(secret, 'utf8');
          assert.equal(
            dbBuffer.includes(secretBuf),
            false,
            `manager.db must not contain plaintext secret: ${secret.slice(0, 8)}...`
          );
          assert.equal(
            walBuffer.includes(secretBuf),
            false,
            `manager.db-wal must not contain plaintext secret: ${secret.slice(0, 8)}...`
          );
          assert.equal(
            shmBuffer.includes(secretBuf),
            false,
            `manager.db-shm must not contain plaintext secret: ${secret.slice(0, 8)}...`
          );
        }

        // Check auth.json specifically
        const authPath = path.join(tempDir, 'auth.json');
        if (fs.existsSync(authPath)) {
          const authContent = fs.readFileSync(authPath, 'utf8');
          assert.equal(
            authContent.includes(SYNTH_PASSWORD),
            false,
            'auth.json must never contain the plaintext password'
          );
        }
      } finally {
        if (manager && typeof manager.close === 'function') await manager.close();
        try {
          if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
          }
        } catch (_) {}
      }
    });
  });
});

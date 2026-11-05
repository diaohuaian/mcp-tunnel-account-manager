import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
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

function extractCookieSid(headers) {
  const raw = headers['set-cookie'];
  if (!raw) return null;
  const str = Array.isArray(raw) ? raw.join('; ') : raw;
  const match = str.match(/sid=([^;]+)/);
  return match ? decodeURIComponent(match[1].trim()) : null;
}

describe('Manager E2E Integration Suite', () => {
  it('initializes startManager, performs authenticated profile switch lifecycle and shuts down cleanly', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-e2e-'));
    let manager = null;

    try {
      // Synthetic adapter factory for isolated in-process integration testing
      const fakeAdapterFactory = async () => {
        const createFakeAdapter = (service) => {
          const runningProc = {
            running: true,
            pid: 12345,
            executable: 'fake-tunnel.mjs',
            startedAt: new Date().toISOString()
          };
          return {
            async prepare({ operationId, credential }) {
              return {
                operationId,
                service,
                originalFingerprint: 'f'.repeat(64),
                desiredFingerprint: 'd'.repeat(64),
                originalConfig: { yaml: 'v: 1' },
                desiredConfig: { yaml: 'v: 2' },
                originalProcessIdentity: runningProc,
                credential
              };
            },
            async applyIfUnchanged() {
              return runningProc;
            },
            async verifyDesired({ operationId, snapshot }) {
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
                config: { tunnelId: 'tunnel_***1234' }
              };
            }
          };
        };
        return {
          'overleaf-mcp': createFakeAdapter('overleaf-mcp'),
          'antigravity-mcp': createFakeAdapter('antigravity-mcp')
        };
      };

      manager = await startManager({
        dataDir: tempDir,
        host: '127.0.0.1',
        port: 0,
        adapterFactory: fakeAdapterFactory
      });

      assert.ok(manager.url);
      assert.ok(manager.close);
      assert.equal(typeof manager.close, 'function');

      // 1. Initial auth state
      const state1 = await sendJsonRequest(manager.url, '/api/auth/state');
      assert.equal(state1.status, 200);
      assert.equal(state1.body.configured, false);

      // Read bootstrap code from bootstrap-code.txt
      const bootstrapCode = fs.readFileSync(path.join(tempDir, 'bootstrap-code.txt'), 'utf8').trim();

      // 2. Setup admin password
      const setupRes = await sendJsonRequest(manager.url, '/api/auth/setup', {
        method: 'POST',
        body: {
          bootstrapCode,
          password: 'IntegrationTestPassword123!'
        }
      });
      assert.equal(setupRes.status, 200);

      // 3. Login
      const loginRes = await sendJsonRequest(manager.url, '/api/auth/login', {
        method: 'POST',
        body: { password: 'IntegrationTestPassword123!' }
      });
      assert.equal(loginRes.status, 200);
      assert.ok(loginRes.body.csrfToken);
      const csrfToken = loginRes.body.csrfToken;
      const sid = extractCookieSid(loginRes.headers);
      assert.ok(sid);

      const authHeaders = {
        cookie: `sid=${sid}`,
        'x-csrf-token': csrfToken
      };

      // 4. Create profile
      const createProfileRes = await sendJsonRequest(manager.url, '/api/profiles', {
        method: 'POST',
        headers: authHeaders,
        body: {
          label: 'E2E Profile',
          services: {
            'overleaf-mcp': { tunnelId: 'tunnel_overleaf_test', apiKey: 'sec_key_1' },
            'antigravity-mcp': { tunnelId: 'tunnel_antigravity_test', apiKey: 'sec_key_2' }
          }
        }
      });
      assert.equal(createProfileRes.status, 200);
      const profileId = createProfileRes.body.id;

      // 5. Trigger switch
      const switchRes = await sendJsonRequest(manager.url, '/api/switch', {
        method: 'POST',
        headers: {
          ...authHeaders,
          'Idempotency-Key': 'e2e-idem-key-1'
        },
        body: {
          profileId,
          targets: ['overleaf-mcp', 'antigravity-mcp']
        }
      });
      assert.equal(switchRes.status, 202);
      assert.ok(switchRes.body.operation);
      const opId = switchRes.body.operation.id;

      // 6. Poll operation
      let finished = false;
      for (let i = 0; i < 30; i++) {
        const opRes = await sendJsonRequest(manager.url, `/api/operations/${opId}`, {
          headers: authHeaders
        });
        if (opRes.body && ['SUCCEEDED', 'ROLLED_BACK', 'NEEDS_ATTENTION'].includes(opRes.body.status)) {
          assert.equal(opRes.body.status, 'SUCCEEDED');
          finished = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(finished, 'Switch operation should reach SUCCEEDED');

      // 7. Verify final state
      const finalState = await sendJsonRequest(manager.url, '/api/state', {
        headers: authHeaders
      });
      assert.equal(finalState.status, 200);
      assert.ok(finalState.body.revision > 0);
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

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHttpServer } from '../src/server.mjs';

function createDefaultMockSecurity() {
  return {
    guard: async () => true,
    state: async () => ({ configured: true, authenticated: true, csrfToken: 'mock-csrf' }),
    setup: async () => ({ ok: true }),
    login: async () => ({ ok: true }),
    logout: async () => ({ ok: true }),
    close: async () => {}
  };
}

function startServer(options = {}) {
  const effectiveSecurity = options.security !== undefined ? options.security : createDefaultMockSecurity();
  return new Promise((resolve, reject) => {
    try {
      const server = createHttpServer({
        ...options,
        security: effectiveSecurity
      });
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        resolve({
          server,
          baseUrl: `http://127.0.0.1:${port}`,
          close: () => new Promise(res => {
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

function sendRawHttpRequest(baseUrl, rawPath, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: rawPath,
      method,
      headers
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: parsed,
          rawBody: raw
        });
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

describe('MCP Tunnel Account Manager - HTTP Server Tests', () => {

  // =========================================================================
  // Test 1: static file serving and path traversal prevention
  // =========================================================================
  describe('1. Static file serving and path traversal prevention', () => {
    let tmpDir;
    let serverContext;

    before(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-http-test-'));
      fs.writeFileSync(path.join(tmpDir, 'index.html'), '<!DOCTYPE html><html><body>Index File</body></html>');
      fs.writeFileSync(path.join(tmpDir, 'app.css'), 'body { color: #333; }');
      fs.writeFileSync(path.join(tmpDir, 'app.js'), 'console.log("App loaded");');

      // Create an outside secret file
      const outsideDir = path.dirname(tmpDir);
      fs.writeFileSync(path.join(outsideDir, 'secret_traversal.txt'), 'RAW_SECRET_DATA');

      serverContext = await startServer({ publicDir: tmpDir });
    });

    after(async () => {
      await serverContext.close();
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        const outsideDir = path.dirname(tmpDir);
        fs.unlinkSync(path.join(outsideDir, 'secret_traversal.txt'));
      } catch {}
    });

    test('serves index.html for root path /', async () => {
      const res = await fetch(`${serverContext.baseUrl}/`);
      assert.strictEqual(res.status, 200);
      assert.ok(res.headers.get('content-type')?.includes('text/html'));
      const text = await res.text();
      assert.strictEqual(text, '<!DOCTYPE html><html><body>Index File</body></html>');
    });

    test('serves index.html for /index.html', async () => {
      const res = await fetch(`${serverContext.baseUrl}/index.html`);
      assert.strictEqual(res.status, 200);
      assert.ok(res.headers.get('content-type')?.includes('text/html'));
      const text = await res.text();
      assert.strictEqual(text, '<!DOCTYPE html><html><body>Index File</body></html>');
    });

    test('serves app.css with text/css content-type', async () => {
      const res = await fetch(`${serverContext.baseUrl}/app.css`);
      assert.strictEqual(res.status, 200);
      assert.ok(res.headers.get('content-type')?.includes('text/css'));
      const text = await res.text();
      assert.strictEqual(text, 'body { color: #333; }');
    });

    test('serves app.js with javascript content-type', async () => {
      const res = await fetch(`${serverContext.baseUrl}/app.js`);
      assert.strictEqual(res.status, 200);
      assert.ok(res.headers.get('content-type')?.includes('javascript'));
      const text = await res.text();
      assert.strictEqual(text, 'console.log("App loaded");');
    });

    test('supports HEAD method for static files', async () => {
      const res = await fetch(`${serverContext.baseUrl}/app.js`, { method: 'HEAD' });
      assert.strictEqual(res.status, 200);
      assert.ok(res.headers.get('content-type')?.includes('javascript'));
      const text = await res.text();
      assert.strictEqual(text, '');
    });

    test('returns 404 for missing static file', async () => {
      const res = await fetch(`${serverContext.baseUrl}/nonexistent.js`);
      assert.strictEqual(res.status, 404);
      const json = await res.json();
      assert.deepStrictEqual(json, { error: { code: 'NOT_FOUND', status: 404 } });
    });

    test('blocks path traversal via /../secret_traversal.txt', async () => {
      const res = await sendRawHttpRequest(serverContext.baseUrl, '/../secret_traversal.txt');
      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res.body?.error?.code, 'FORBIDDEN');
    });

    test('blocks path traversal via URL-encoded /%2e%2e/secret_traversal.txt', async () => {
      const res = await sendRawHttpRequest(serverContext.baseUrl, '/%2e%2e/secret_traversal.txt');
      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res.body?.error?.code, 'FORBIDDEN');
    });

    test('blocks path traversal via /..%2fsecret_traversal.txt', async () => {
      const res = await sendRawHttpRequest(serverContext.baseUrl, '/..%2fsecret_traversal.txt');
      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res.body?.error?.code, 'FORBIDDEN');
    });

    test('blocks null-byte path traversal /index.html%00.txt', async () => {
      const res = await sendRawHttpRequest(serverContext.baseUrl, '/index.html%00.txt');
      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res.body?.error?.code, 'FORBIDDEN');
    });

    test('blocks nested path traversal /app.js/../../secret_traversal.txt', async () => {
      const res = await sendRawHttpRequest(serverContext.baseUrl, '/app.js/../../secret_traversal.txt');
      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res.body?.error?.code, 'FORBIDDEN');
    });
  });

  // =========================================================================
  // Test 2: payload size limit (413)
  // =========================================================================
  describe('2. Payload size limit (413)', () => {
    let serverContext;

    before(async () => {
      const fakeRepo = {
        createProfile: async (body) => ({ id: 'p1', ...body })
      };
      serverContext = await startServer({ repo: fakeRepo });
    });

    after(async () => {
      await serverContext.close();
    });

    test('rejects payload exceeding 1MB with safe 413 JSON_LIMIT_EXCEEDED', async () => {
      // 1MB is 1,048,576 bytes. Create a string larger than 1MB
      const largeData = 'x'.repeat(1024 * 1024 + 1024); // 1MB + 1KB
      const body = JSON.stringify({ data: largeData });

      const res = await sendRawHttpRequest(serverContext.baseUrl, '/api/profiles', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        body
      });

      assert.strictEqual(res.statusCode, 413);
      assert.deepStrictEqual(res.body, {
        error: {
          code: 'JSON_LIMIT_EXCEEDED',
          status: 413
        }
      });
    });

    test('rejects streamed payload exceeding 1MB without content-length header', async () => {
      const u = new URL(serverContext.baseUrl);
      const res = await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: u.hostname,
          port: u.port,
          path: '/api/profiles',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Transfer-Encoding': 'chunked'
          }
        }, (res) => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let parsed = null;
            try { parsed = JSON.parse(raw); } catch {}
            resolve({ statusCode: res.statusCode, body: parsed });
          });
        });

        req.on('error', reject);

        // Send opening json
        req.write('{"data":"');
        const chunk = 'a'.repeat(64 * 1024); // 64KB per chunk
        // Send 17 chunks = 1088 KB > 1MB
        for (let i = 0; i < 17; i++) {
          req.write(chunk);
        }
        req.write('"}');
        req.end();
      });

      assert.strictEqual(res.statusCode, 413);
      assert.deepStrictEqual(res.body, {
        error: {
          code: 'JSON_LIMIT_EXCEEDED',
          status: 413
        }
      });
    });

    test('accepts valid payload under 1MB limit', async () => {
      const smallData = 'x'.repeat(5000); // 5KB
      const body = JSON.stringify({ name: 'ValidProfile', data: smallData });

      const res = await fetch(`${serverContext.baseUrl}/api/profiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.name, 'ValidProfile');
    });
  });

  // =========================================================================
  // Test 3: auth routing delegates to security
  // =========================================================================
  describe('3. Auth routing delegates to security', () => {
    let serverContext;
    const calls = {
      state: 0,
      setup: null,
      login: null,
      logout: 0
    };

    const fakeSecurity = {
      guard: async () => true,
      state: async (req) => {
        calls.state++;
        assert.ok(req);
        return { setupNeeded: false, authenticated: true, user: 'admin' };
      },
      setup: async (req, res, body) => {
        calls.setup = body;
        assert.ok(req);
        assert.ok(res);
        return { success: true, message: 'Setup completed' };
      },
      login: async (req, res, body) => {
        calls.login = body;
        assert.ok(req);
        assert.ok(res);
        return { token: 'jwt-mock-token-123' };
      },
      logout: async (req, res) => {
        calls.logout++;
        assert.ok(req);
        assert.ok(res);
        return { loggedOut: true };
      }
    };

    before(async () => {
      serverContext = await startServer({ security: fakeSecurity });
    });

    after(async () => {
      await serverContext.close();
    });

    test('GET /api/auth/state delegates to security.state(req)', async () => {
      const res = await fetch(`${serverContext.baseUrl}/api/auth/state`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.deepStrictEqual(data, {
        setupNeeded: false,
        authenticated: true,
        user: 'admin'
      });
      assert.strictEqual(calls.state, 1);
    });

    test('POST /api/auth/setup delegates to security.setup(req, res, body)', async () => {
      const payload = { password: 'InitialSecurePassword123!' };
      const res = await fetch(`${serverContext.baseUrl}/api/auth/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.deepStrictEqual(data, { success: true, message: 'Setup completed' });
      assert.deepStrictEqual(calls.setup, payload);
    });

    test('POST /api/auth/login delegates to security.login(req, res, body)', async () => {
      const payload = { password: 'InitialSecurePassword123!' };
      const res = await fetch(`${serverContext.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.deepStrictEqual(data, { token: 'jwt-mock-token-123' });
      assert.deepStrictEqual(calls.login, payload);
    });

    test('POST /api/auth/logout delegates to security.logout(req, res)', async () => {
      const res = await fetch(`${serverContext.baseUrl}/api/auth/logout`, {
        method: 'POST'
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.deepStrictEqual(data, { loggedOut: true });
      assert.strictEqual(calls.logout, 1);
    });
  });

  // =========================================================================
  // Test 4: GET /api/state aggregates repo DTOs without raw secrets
  // =========================================================================
  describe('4. GET /api/state aggregates repo DTOs without raw secrets', () => {
    let serverContext;
    let guardWriteOption = null;

    const fakeSecurity = {
      guard: async (req, res, options) => {
        guardWriteOption = options?.write;
        return true;
      }
    };

    const fakeRepo = {
      getRevision: async () => 42,
      listProfiles: async () => [
        {
          id: 'prof-dev',
          name: 'Development',
          active: true,
          profileRevision: 5,
          services: ['ngrok', 'localtunnel']
        },
        {
          id: 'prof-prod',
          name: 'Production',
          active: false,
          profileRevision: 3,
          services: ['cloudflare']
        }
      ],
      listServices: async () => [
        { id: 'ngrok', name: 'Ngrok Service', status: 'connected' },
        { id: 'localtunnel', name: 'LocalTunnel Service', status: 'idle' },
        { id: 'cloudflare', name: 'Cloudflare Tunnel', status: 'idle' }
      ],
      getRecoveryState: async () => ({
        pendingRecovery: false,
        lastError: null
      })
    };

    before(async () => {
      serverContext = await startServer({ repo: fakeRepo, security: fakeSecurity });
    });

    after(async () => {
      await serverContext.close();
    });

    test('GET /api/state returns aggregated DTOs and passes guard with write: false', async () => {
      const res = await fetch(`${serverContext.baseUrl}/api/state`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();

      // Check guard was called with write: false
      assert.strictEqual(guardWriteOption, false);

      // Verify exact aggregation keys
      assert.deepStrictEqual(Object.keys(body).sort(), ['profiles', 'recovery', 'revision', 'services']);
      assert.strictEqual(body.revision, 42);
      assert.strictEqual(body.profiles.length, 2);
      assert.strictEqual(body.services.length, 3);
      assert.strictEqual(body.recovery.pendingRecovery, false);

      // Verify that no raw secrets or unexpected fields exist in output
      const jsonString = JSON.stringify(body);
      assert.strictEqual(jsonString.includes('rawSecret'), false);
      assert.strictEqual(jsonString.includes('passwordHash'), false);
      assert.strictEqual(jsonString.includes('tunnelAuthToken'), false);
    });

    test('GET /api/profiles delegates to repo.listProfiles()', async () => {
      const res = await fetch(`${serverContext.baseUrl}/api/profiles`);
      assert.strictEqual(res.status, 200);
      const profiles = await res.json();
      assert.strictEqual(Array.isArray(profiles), true);
      assert.strictEqual(profiles.length, 2);
      assert.strictEqual(profiles[0].id, 'prof-dev');
    });
  });

  // =========================================================================
  // Test 5: POST /api/switch returns 202 before runner.notify is called
  // =========================================================================
  describe('5. POST /api/switch returns 202 before runner.notify is called', () => {
    let serverContext;
    const executionOrder = [];
    let notifyCalled = false;
    let createdOpArgs = null;

    const fakeRepo = {
      createOperation: async (args) => {
        createdOpArgs = args;
        executionOrder.push('repo.createOperation');
        return {
          id: 'op-switch-456',
          type: 'SWITCH',
          status: 'queued',
          ...args
        };
      }
    };

    const fakeRunner = {
      notify: () => {
        notifyCalled = true;
        executionOrder.push('runner.notify');
      }
    };

    before(async () => {
      serverContext = await startServer({ repo: fakeRepo, runner: fakeRunner });
    });

    after(async () => {
      await serverContext.close();
    });

    test('POST /api/switch extracts Idempotency-Key, returns 202, then calls runner.notify()', async () => {
      const switchBody = {
        profileId: 'prof-dev',
        profileRevision: 5,
        targets: ['ngrok'],
        expectedRevision: 42
      };

      const res = await fetch(`${serverContext.baseUrl}/api/switch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'client-idem-key-999'
        },
        body: JSON.stringify(switchBody)
      });

      // Assert 202 status received
      assert.strictEqual(res.status, 202);
      const json = await res.json();
      assert.ok(json.operation);
      assert.strictEqual(json.operation.id, 'op-switch-456');
      assert.strictEqual(json.operation.idempotencyKey, 'client-idem-key-999');

      // Assert repo.createOperation received the expected arguments
      assert.deepStrictEqual(createdOpArgs, {
        profileId: 'prof-dev',
        profileRevision: 5,
        targets: ['ngrok'],
        expectedRevision: 42,
        idempotencyKey: 'client-idem-key-999'
      });

      // Assert runner.notify was called
      assert.strictEqual(notifyCalled, true);

      // Assert repo.createOperation occurred before runner.notify
      assert.deepStrictEqual(executionOrder, ['repo.createOperation', 'runner.notify']);
    });

    test('runner.notify error does not fail or alter 202 response', async () => {
      const explodingRunner = {
        notify: () => {
          throw new Error('Exploding background worker');
        }
      };

      const localContext = await startServer({ repo: fakeRepo, runner: explodingRunner });
      try {
        const res = await fetch(`${localContext.baseUrl}/api/switch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profileId: 'prof-dev' })
        });
        assert.strictEqual(res.status, 202);
        const data = await res.json();
        assert.ok(data.operation);
      } finally {
        await localContext.close();
      }
    });
  });

  // =========================================================================
  // Test 6: safe error response format on error or conflict
  // =========================================================================
  describe('6. Safe error response format on error or conflict', () => {
    test('safe uniform 409 error on revision conflict during profile creation', async () => {
      const fakeRepo = {
        createProfile: async () => {
          const err = new Error('Profile revision conflict: expected 2 but found 3');
          err.status = 409;
          err.code = 'REVISION_CONFLICT';
          throw err;
        }
      };

      const localContext = await startServer({ repo: fakeRepo });
      try {
        const res = await fetch(`${localContext.baseUrl}/api/profiles`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Conflicting Profile', expectedRevision: 2 })
        });

        assert.strictEqual(res.status, 409);
        const data = await res.json();
        assert.deepStrictEqual(data, {
          error: {
            code: 'REVISION_CONFLICT',
            status: 409
          }
        });
        // Ensure no internal message or stack trace is exposed
        assert.strictEqual(data.error.message, undefined);
        assert.strictEqual(data.error.stack, undefined);
      } finally {
        await localContext.close();
      }
    });

    test('safe uniform 401 error when security.guard rejects', async () => {
      const fakeSecurity = {
        guard: async () => false
      };

      const localContext = await startServer({ security: fakeSecurity });
      try {
        const res = await fetch(`${localContext.baseUrl}/api/profiles`);
        assert.strictEqual(res.status, 401);
        const data = await res.json();
        assert.deepStrictEqual(data, {
          error: {
            code: 'UNAUTHORIZED',
            status: 401
          }
        });
      } finally {
        await localContext.close();
      }
    });

    test('safe uniform 403 error when security.guard denies write access', async () => {
      const fakeSecurity = {
        guard: async (req, res, { write } = {}) => {
          if (write) {
            const err = new Error('Write access denied');
            err.status = 403;
            err.code = 'READ_ONLY_ACCESS';
            throw err;
          }
          return true;
        }
      };

      const fakeRepo = {
        patchProfile: async () => ({ id: 'p1', patched: true })
      };

      const localContext = await startServer({ repo: fakeRepo, security: fakeSecurity });
      try {
        const res = await fetch(`${localContext.baseUrl}/api/profiles/p1`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Renamed' })
        });
        assert.strictEqual(res.status, 403);
        const data = await res.json();
        assert.deepStrictEqual(data, {
          error: {
            code: 'READ_ONLY_ACCESS',
            status: 403
          }
        });
      } finally {
        await localContext.close();
      }
    });

    test('safe uniform 400 error on malformed JSON body', async () => {
      const localContext = await startServer({});
      try {
        const res = await sendRawHttpRequest(localContext.baseUrl, '/api/profiles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{ invalid_json: '
        });
        assert.strictEqual(res.statusCode, 400);
        assert.deepStrictEqual(res.body, {
          error: {
            code: 'INVALID_JSON',
            status: 400
          }
        });
      } finally {
        await localContext.close();
      }
    });

    test('safe uniform 404 error when GET /api/operations/:id is not found', async () => {
      const fakeRepo = {
        publicOperation: async (id) => {
          assert.strictEqual(id, 'op-not-found');
          return null;
        }
      };

      const localContext = await startServer({ repo: fakeRepo });
      try {
        const res = await fetch(`${localContext.baseUrl}/api/operations/op-not-found`);
        assert.strictEqual(res.status, 404);
        const data = await res.json();
        assert.deepStrictEqual(data, {
          error: {
            code: 'NOT_FOUND',
            status: 404
          }
        });
      } finally {
        await localContext.close();
      }
    });

    test('safe uniform 404 error on unknown API route', async () => {
      const localContext = await startServer({});
      try {
        const res = await fetch(`${localContext.baseUrl}/api/completely/unknown/endpoint`);
        assert.strictEqual(res.status, 404);
        const data = await res.json();
        assert.deepStrictEqual(data, {
          error: {
            code: 'NOT_FOUND',
            status: 404
          }
        });
      } finally {
        await localContext.close();
      }
    });

    test('safe uniform 500 error on unhandled internal repo exception', async () => {
      const fakeRepo = {
        listProfiles: async () => {
          throw new Error('Database disk I/O failure: path /var/lib/secret');
        }
      };

      const localContext = await startServer({ repo: fakeRepo });
      try {
        const res = await fetch(`${localContext.baseUrl}/api/profiles`);
        assert.strictEqual(res.status, 500);
        const data = await res.json();
        assert.deepStrictEqual(data, {
          error: {
            code: 'INTERNAL_ERROR',
            status: 500
          }
        });
        // Ensure database path or internal message is not leaked
        assert.strictEqual(JSON.stringify(data).includes('/var/lib/secret'), false);
      } finally {
        await localContext.close();
      }
    });
  });

  // =========================================================================
  // Profile CRUD operations (PATCH, DELETE)
  // =========================================================================
  describe('Profile PATCH and DELETE routes', () => {
    let serverContext;
    let patchedArgs = null;
    let deletedArgs = null;

    const fakeRepo = {
      patchProfile: async (id, body, options) => {
        patchedArgs = { id, body, options };
        return { id, ...body, version: 2 };
      },
      deleteProfile: async (id, options) => {
        deletedArgs = { id, options };
        return { ok: true, deletedId: id };
      }
    };

    before(async () => {
      serverContext = await startServer({ repo: fakeRepo });
    });

    after(async () => {
      await serverContext.close();
    });

    test('PATCH /api/profiles/:id passes expectedRevision and profileRevision', async () => {
      const payload = {
        name: 'Updated Name',
        expectedRevision: 10,
        profileRevision: 2
      };

      const res = await fetch(`${serverContext.baseUrl}/api/profiles/prof-123`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.id, 'prof-123');
      assert.strictEqual(data.name, 'Updated Name');

      assert.strictEqual(patchedArgs.id, 'prof-123');
      assert.deepStrictEqual(patchedArgs.body, payload);
      assert.deepStrictEqual(patchedArgs.options, {
        expectedRevision: 10,
        profileRevision: 2
      });
    });

    test('DELETE /api/profiles/:id passes expectedRevision and profileRevision from body', async () => {
      const payload = {
        expectedRevision: 11,
        profileRevision: 3
      };

      const res = await fetch(`${serverContext.baseUrl}/api/profiles/prof-123`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.ok, true);

      assert.strictEqual(deletedArgs.id, 'prof-123');
      assert.deepStrictEqual(deletedArgs.options, {
        expectedRevision: 11,
        profileRevision: 3
      });
    });
  });

  // =========================================================================
  // Security Fail-Closed Contract Tests
  // =========================================================================
  describe('Fail-closed security contract', () => {
    test('createHttpServer throws TypeError when security is missing or invalid', () => {
      assert.throws(
        () => createHttpServer({}),
        /SECURITY_REQUIRED/
      );
      assert.throws(
        () => createHttpServer({ security: null }),
        /SECURITY_REQUIRED/
      );
      assert.throws(
        () => createHttpServer({ security: {} }),
        /SECURITY_REQUIRED/
      );
      assert.throws(
        () => createHttpServer({ security: { guard: 'not-a-function' } }),
        /SECURITY_REQUIRED/
      );
    });
  });
});

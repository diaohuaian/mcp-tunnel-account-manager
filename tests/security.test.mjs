import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createSecurity } from '../src/security.mjs';

function createMockRes() {
  const headers = {};
  return {
    headers,
    setHeader(key, val) {
      headers[key.toLowerCase()] = val;
    },
    getHeader(key) {
      return headers[key.toLowerCase()];
    },
    removeHeader(key) {
      delete headers[key.toLowerCase()];
    }
  };
}

function extractSid(res) {
  const raw = res.getHeader('set-cookie');
  if (!raw) return null;
  const str = Array.isArray(raw) ? raw.join('; ') : raw;
  const match = str.match(/sid=([^;]+)/);
  return match ? decodeURIComponent(match[1].trim()) : null;
}

test('1. initial state (not configured)', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-test-1-'));
  t.after(async () => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const security = createSecurity({ dataDir });
  t.after(async () => {
    await security.close();
  });

  const req = { headers: { host: 'localhost:3000' } };
  const st = await security.state(req);
  assert.strictEqual(st.configured, false);
  assert.strictEqual(st.authenticated, false);
  assert.strictEqual(st.csrfToken, '');

  const bootstrapFile = path.join(dataDir, 'bootstrap-code.txt');
  assert.strictEqual(fs.existsSync(bootstrapFile), true);
  const secretContent = fs.readFileSync(bootstrapFile, 'utf8').trim();
  assert.ok(secretContent.length >= 32);
  assert.match(secretContent, /^[0-9a-f]+$/i);
  assert.strictEqual(fs.existsSync(path.join(dataDir, 'bootstrap.secret')), true);
});

test('2. setup with valid bootstrap code sets password; invalid bootstrap code rejected', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-test-2-'));
  t.after(async () => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const security = createSecurity({ dataDir });
  t.after(async () => {
    await security.close();
  });

  const req = { headers: { host: 'localhost:3000' } };
  const res = createMockRes();

  // Invalid bootstrap code rejected
  await assert.rejects(
    async () => {
      await security.setup(req, res, {
        bootstrapCode: '00000000000000000000000000000000',
        password: 'secure-password-123'
      });
    },
    (err) => {
      assert.strictEqual(err.code, 'FORBIDDEN');
      assert.strictEqual(err.status, 403);
      return true;
    }
  );

  // Still not configured
  assert.strictEqual((await security.state(req)).configured, false);

  // Valid bootstrap code sets password
  const validBootstrapCode = fs.readFileSync(path.join(dataDir, 'bootstrap-code.txt'), 'utf8').trim();
  const setupRes = await security.setup(req, res, {
    bootstrapCode: validBootstrapCode,
    password: 'secure-password-123'
  });
  assert.strictEqual(setupRes.ok, true);

  // Now configured
  const st = await security.state(req);
  assert.strictEqual(st.configured, true);
  assert.strictEqual(st.authenticated, false);

  // auth.json exists and does NOT contain plaintext password
  const authFile = path.join(dataDir, 'auth.json');
  assert.strictEqual(fs.existsSync(authFile), true);
  const rawAuth = fs.readFileSync(authFile, 'utf8');
  assert.strictEqual(rawAuth.includes('secure-password-123'), false);
  const authData = JSON.parse(rawAuth);
  assert.ok(authData.salt);
  assert.ok(authData.hash);

  // Calling setup again when already configured is rejected
  await assert.rejects(
    async () => {
      await security.setup(req, res, {
        bootstrapCode: validBootstrapCode,
        password: 'another-password'
      });
    },
    (err) => {
      assert.strictEqual(err.code, 'BAD_REQUEST');
      assert.strictEqual(err.status, 400);
      return true;
    }
  );
});

test('3. login with correct password sets HttpOnly cookie; incorrect password throttled', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-test-3-'));
  t.after(async () => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const security = createSecurity({ dataDir });
  t.after(async () => {
    await security.close();
  });

  const req = { headers: { host: 'localhost:3000' } };
  const bootstrapCode = fs.readFileSync(path.join(dataDir, 'bootstrap-code.txt'), 'utf8').trim();
  await security.setup(req, createMockRes(), {
    bootstrapCode,
    password: 'test-correct-password'
  });

  // Login with correct password sets HttpOnly cookie
  const res1 = createMockRes();
  const loginRes = await security.login(req, res1, { password: 'test-correct-password' });
  assert.strictEqual(loginRes.ok, true);
  assert.ok(loginRes.csrfToken);

  const cookieHeader = res1.getHeader('Set-Cookie');
  assert.ok(cookieHeader);
  assert.match(cookieHeader, /sid=[0-9a-f]{64}/i);
  assert.match(cookieHeader, /HttpOnly/i);
  assert.match(cookieHeader, /SameSite=Strict/i);

  // Test incorrect password throttling: 5 consecutive failures
  for (let i = 1; i <= 5; i++) {
    const resFail = createMockRes();
    await assert.rejects(
      async () => {
        await security.login(req, resFail, { password: 'wrong-password' });
      },
      (err) => {
        assert.strictEqual(err.code, 'UNAUTHORIZED');
        assert.strictEqual(err.status, 401);
        return true;
      }
    );
  }

  // 6th attempt: locked out after 5 consecutive failures
  const resLocked = createMockRes();
  await assert.rejects(
    async () => {
      await security.login(req, resLocked, { password: 'wrong-password' });
    },
    (err) => {
      assert.strictEqual(err.code, 'FORBIDDEN');
      assert.strictEqual(err.status, 403);
      return true;
    }
  );

  // Even the correct password must be rejected during lockout
  await assert.rejects(
    async () => {
      await security.login(req, resLocked, { password: 'test-correct-password' });
    },
    (err) => {
      assert.strictEqual(err.code, 'FORBIDDEN');
      assert.strictEqual(err.status, 403);
      return true;
    }
  );
});

test('4. guard allows valid session, rejects unauthenticated', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-test-4-'));
  t.after(async () => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const security = createSecurity({ dataDir });
  t.after(async () => {
    await security.close();
  });

  const req = { headers: { host: 'localhost:3000' } };
  const bootstrapCode = fs.readFileSync(path.join(dataDir, 'bootstrap-code.txt'), 'utf8').trim();
  await security.setup(req, createMockRes(), {
    bootstrapCode,
    password: 'password-for-guard'
  });

  const resLogin = createMockRes();
  await security.login(req, resLogin, { password: 'password-for-guard' });
  const sid = extractSid(resLogin);
  assert.ok(sid);

  // Guard allows valid session
  const authReq = {
    headers: {
      host: 'localhost:3000',
      cookie: `sid=${sid}`
    }
  };
  const session = await security.guard(authReq, { write: false });
  assert.ok(session);
  assert.strictEqual(session.sessionId, sid);

  // Guard rejects unauthenticated (no cookie)
  const noCookieReq = {
    headers: {
      host: 'localhost:3000'
    }
  };
  await assert.rejects(
    async () => {
      await security.guard(noCookieReq, { write: false });
    },
    (err) => {
      assert.strictEqual(err.code, 'UNAUTHORIZED');
      assert.strictEqual(err.status, 401);
      return true;
    }
  );

  // Guard rejects invalid session ID
  const badCookieReq = {
    headers: {
      host: 'localhost:3000',
      cookie: 'sid=00000000000000000000000000000000'
    }
  };
  await assert.rejects(
    async () => {
      await security.guard(badCookieReq, { write: false });
    },
    (err) => {
      assert.strictEqual(err.code, 'UNAUTHORIZED');
      assert.strictEqual(err.status, 401);
      return true;
    }
  );
});

test('5. guard enforces CSRF on write requests', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-test-5-'));
  t.after(async () => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const security = createSecurity({ dataDir });
  t.after(async () => {
    await security.close();
  });

  const req = { headers: { host: 'localhost:3000' } };
  const bootstrapCode = fs.readFileSync(path.join(dataDir, 'bootstrap-code.txt'), 'utf8').trim();
  await security.setup(req, createMockRes(), {
    bootstrapCode,
    password: 'csrf-test-password'
  });

  const resLogin = createMockRes();
  const { csrfToken } = await security.login(req, resLogin, { password: 'csrf-test-password' });
  const sid = extractSid(resLogin);

  // Read request (write: false) passes without CSRF token
  const readReq = {
    headers: {
      host: 'localhost:3000',
      cookie: `sid=${sid}`
    }
  };
  const readSession = await security.guard(readReq, { write: false });
  assert.ok(readSession);

  // Write request without CSRF token is rejected
  const writeReqNoCsrf = {
    headers: {
      host: 'localhost:3000',
      cookie: `sid=${sid}`
    }
  };
  await assert.rejects(
    async () => {
      await security.guard(writeReqNoCsrf, { write: true });
    },
    (err) => {
      assert.strictEqual(err.code, 'FORBIDDEN');
      assert.strictEqual(err.status, 403);
      return true;
    }
  );

  // Write request with invalid CSRF token is rejected
  const writeReqBadCsrf = {
    headers: {
      host: 'localhost:3000',
      cookie: `sid=${sid}`,
      'x-csrf-token': 'invalid-csrf-token-12345'
    }
  };
  await assert.rejects(
    async () => {
      await security.guard(writeReqBadCsrf, { write: true });
    },
    (err) => {
      assert.strictEqual(err.code, 'FORBIDDEN');
      assert.strictEqual(err.status, 403);
      return true;
    }
  );

  // Write request with valid CSRF token is accepted
  const writeReqValidCsrf = {
    headers: {
      host: 'localhost:3000',
      cookie: `sid=${sid}`,
      'x-csrf-token': csrfToken
    }
  };
  const writeSession = await security.guard(writeReqValidCsrf, { write: true });
  assert.ok(writeSession);
  assert.strictEqual(writeSession.sessionId, sid);
});

test('6. hostile Host or Origin rejected', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-test-6-'));
  t.after(async () => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const security = createSecurity({ dataDir });
  t.after(async () => {
    await security.close();
  });

  const bootstrapCode = fs.readFileSync(path.join(dataDir, 'bootstrap-code.txt'), 'utf8').trim();
  await security.setup({ headers: { host: 'localhost:3000' } }, createMockRes(), {
    bootstrapCode,
    password: 'origin-host-test-password'
  });

  const resLogin = createMockRes();
  await security.login({ headers: { host: 'localhost:3000' } }, resLogin, { password: 'origin-host-test-password' });
  const sid = extractSid(resLogin);

  // 1. Hostile Host header rejected
  await assert.rejects(
    async () => {
      await security.guard({
        headers: {
          host: 'attacker.com',
          cookie: `sid=${sid}`
        }
      });
    },
    (err) => {
      assert.strictEqual(err.code, 'FORBIDDEN');
      assert.strictEqual(err.status, 403);
      return true;
    }
  );

  // 2. Hostile Host subdomain / DNS rebind attempt rejected
  await assert.rejects(
    async () => {
      await security.guard({
        headers: {
          host: 'localhost.attacker.com',
          cookie: `sid=${sid}`
        }
      });
    },
    (err) => {
      assert.strictEqual(err.code, 'FORBIDDEN');
      assert.strictEqual(err.status, 403);
      return true;
    }
  );

  // 3. Hostile Origin rejected
  await assert.rejects(
    async () => {
      await security.guard({
        headers: {
          host: 'localhost:3000',
          origin: 'http://attacker.com',
          cookie: `sid=${sid}`
        }
      });
    },
    (err) => {
      assert.strictEqual(err.code, 'FORBIDDEN');
      assert.strictEqual(err.status, 403);
      return true;
    }
  );

  // 4. Null Origin rejected
  await assert.rejects(
    async () => {
      await security.guard({
        headers: {
          host: 'localhost:3000',
          origin: 'null',
          cookie: `sid=${sid}`
        }
      });
    },
    (err) => {
      assert.strictEqual(err.code, 'FORBIDDEN');
      assert.strictEqual(err.status, 403);
      return true;
    }
  );

  // 5. Cross-site Sec-Fetch-Site rejected
  await assert.rejects(
    async () => {
      await security.guard({
        headers: {
          host: 'localhost:3000',
          'sec-fetch-site': 'cross-site',
          cookie: `sid=${sid}`
        }
      });
    },
    (err) => {
      assert.strictEqual(err.code, 'FORBIDDEN');
      assert.strictEqual(err.status, 403);
      return true;
    }
  );

  // 6. Valid loopback Host and same Origin accepted
  const validReq = {
    headers: {
      host: 'localhost:3000',
      origin: 'http://localhost:3000',
      'sec-fetch-site': 'same-origin',
      cookie: `sid=${sid}`
    }
  };
  const session = await security.guard(validReq);
  assert.ok(session);

  // 7. 127.0.0.1 loopback Host and Origin accepted
  const validReqIp = {
    headers: {
      host: '127.0.0.1:3000',
      origin: 'http://127.0.0.1:3000',
      'sec-fetch-site': 'same-origin',
      cookie: `sid=${sid}`
    }
  };
  const sessionIp = await security.guard(validReqIp);
  assert.ok(sessionIp);

  // 8. IPv6 loopback [::1]:3000 accepted
  const validReqIpv6 = {
    headers: {
      host: '[::1]:3000',
      origin: 'http://[::1]:3000',
      'sec-fetch-site': 'same-origin',
      cookie: `sid=${sid}`
    }
  };
  const sessionIpv6 = await security.guard(validReqIpv6);
  assert.ok(sessionIpv6);

  // 9. Custom allowedOrigin accepted
  const customOriginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-test-custom-origin-'));
  t.after(async () => {
    fs.rmSync(customOriginDir, { recursive: true, force: true });
  });
  const customSec = createSecurity({
    dataDir: customOriginDir,
    allowedOrigin: 'http://localhost:5173'
  });
  t.after(async () => {
    await customSec.close();
  });
  const customBootstrap = fs.readFileSync(path.join(customOriginDir, 'bootstrap-code.txt'), 'utf8').trim();
  await customSec.setup(
    { headers: { host: 'localhost:3000', origin: 'http://localhost:5173' } },
    createMockRes(),
    { bootstrapCode: customBootstrap, password: 'password123' }
  );
  const customResLogin = createMockRes();
  await customSec.login(
    { headers: { host: 'localhost:3000', origin: 'http://localhost:5173' } },
    customResLogin,
    { password: 'password123' }
  );
  const customSid = extractSid(customResLogin);
  const customGuard = await customSec.guard({
    headers: {
      host: 'localhost:3000',
      origin: 'http://localhost:5173',
      cookie: `sid=${customSid}`
    }
  });
  assert.ok(customGuard);
});

test('7. logout terminates session', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-test-7-'));
  t.after(async () => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const security = createSecurity({ dataDir });
  t.after(async () => {
    await security.close();
  });

  const req = { headers: { host: 'localhost:3000' } };
  const bootstrapCode = fs.readFileSync(path.join(dataDir, 'bootstrap-code.txt'), 'utf8').trim();
  await security.setup(req, createMockRes(), {
    bootstrapCode,
    password: 'logout-test-password'
  });

  const resLogin = createMockRes();
  await security.login(req, resLogin, { password: 'logout-test-password' });
  const sid = extractSid(resLogin);
  assert.ok(sid);

  const authReq = {
    headers: {
      host: 'localhost:3000',
      cookie: `sid=${sid}`
    }
  };

  // Authenticated before logout
  const stBefore = await security.state(authReq);
  assert.strictEqual(stBefore.authenticated, true);
  assert.ok(stBefore.csrfToken);
  const session = await security.guard(authReq, { write: false });
  assert.ok(session);

  // Perform logout
  const resLogout = createMockRes();
  const logoutRes = await security.logout(authReq, resLogout);
  assert.strictEqual(logoutRes.ok, true);

  // Cookie cleared with Max-Age=0
  const clearedCookie = resLogout.getHeader('Set-Cookie');
  assert.ok(clearedCookie);
  assert.match(clearedCookie, /sid=;/);
  assert.match(clearedCookie, /Max-Age=0/i);

  // Unauthenticated after logout
  const stAfter = await security.state(authReq);
  assert.strictEqual(stAfter.authenticated, false);
  assert.strictEqual(stAfter.csrfToken, '');

  // Guard rejects now-terminated session
  await assert.rejects(
    async () => {
      await security.guard(authReq, { write: false });
    },
    (err) => {
      assert.strictEqual(err.code, 'UNAUTHORIZED');
      assert.strictEqual(err.status, 401);
      return true;
    }
  );
});

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class SecurityError extends Error {
  constructor(code, status, message) {
    super(message || code);
    this.name = 'SecurityError';
    this.code = code;
    this.status = status;
  }
}

function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    const dummy = Buffer.alloc(bufA.length);
    crypto.timingSafeEqual(bufA, dummy);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function isLoopbackHost(hostHeader) {
  if (!hostHeader || typeof hostHeader !== 'string') return false;
  let host = hostHeader.trim().toLowerCase();

  // IPv6 bracket format: [::1]:port or [::1]
  if (host.startsWith('[')) {
    const closeBracket = host.indexOf(']');
    if (closeBracket === -1) return false;
    const ip = host.substring(1, closeBracket);
    const rest = host.substring(closeBracket + 1);
    if (rest && !/^:\d+$/.test(rest)) return false;
    return ip === '::1';
  }

  // IPv4 or hostname: strip port if present
  const colonIdx = host.lastIndexOf(':');
  if (colonIdx !== -1) {
    const portStr = host.substring(colonIdx + 1);
    if (/^\d+$/.test(portStr)) {
      host = host.substring(0, colonIdx);
    } else {
      return false;
    }
  }

  return host === 'localhost' || host === '127.0.0.1';
}

function getHeader(req, name) {
  if (!req || !req.headers) return undefined;
  const target = name.toLowerCase();
  for (const key of Object.keys(req.headers)) {
    if (key.toLowerCase() === target) {
      return req.headers[key];
    }
  }
  return undefined;
}

function validateHostAndOrigin(req, allowedOrigin) {
  const host = getHeader(req, 'host');
  if (!host) {
    throw new SecurityError('FORBIDDEN', 403, 'Host header is required');
  }
  if (!isLoopbackHost(host)) {
    throw new SecurityError('FORBIDDEN', 403, 'Untrusted Host header');
  }

  const secFetchSite = getHeader(req, 'sec-fetch-site');
  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    throw new SecurityError('FORBIDDEN', 403, 'Cross-origin request blocked by Sec-Fetch-Site');
  }

  const origin = getHeader(req, 'origin');
  if (origin !== undefined) {
    if (origin === 'null' || typeof origin !== 'string') {
      throw new SecurityError('FORBIDDEN', 403, 'Untrusted Origin');
    }
    let originUrl;
    try {
      originUrl = new URL(origin);
    } catch {
      throw new SecurityError('FORBIDDEN', 403, 'Invalid Origin');
    }

    if (allowedOrigin) {
      const allowed = Array.isArray(allowedOrigin) ? allowedOrigin : [allowedOrigin];
      if (allowed.includes(origin)) {
        return;
      }
    }

    if (!isLoopbackHost(originUrl.host)) {
      throw new SecurityError('FORBIDDEN', 403, 'Hostile Origin');
    }

    if (originUrl.host.toLowerCase() !== host.toLowerCase()) {
      const defaultPort = originUrl.protocol === 'http:' ? '80' : '443';
      const hostHasPort = host.includes(':');
      const normalizedHost = hostHasPort ? host : `${host}:${defaultPort}`;
      const normalizedOriginHost = originUrl.port ? originUrl.host : `${originUrl.hostname}:${defaultPort}`;
      if (normalizedHost.toLowerCase() !== normalizedOriginHost.toLowerCase()) {
        throw new SecurityError('FORBIDDEN', 403, 'Origin does not match Host');
      }
    }
  }
}

function getSessionId(req) {
  if (req?.cookies?.sid) return req.cookies.sid;
  const raw = getHeader(req, 'cookie');
  if (!raw || typeof raw !== 'string') return null;
  const match = raw.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? decodeURIComponent(match[1].trim()) : null;
}

function serializeCookie(name, val, options = {}) {
  let cookie = `${name}=${encodeURIComponent(val)}`;
  if (options.path) cookie += `; Path=${options.path}`;
  if (options.httpOnly) cookie += `; HttpOnly`;
  if (options.sameSite) {
    const s = options.sameSite.toLowerCase();
    cookie += `; SameSite=${s === 'strict' ? 'Strict' : s === 'lax' ? 'Lax' : 'None'}`;
  }
  if (options.secure) cookie += `; Secure`;
  if (options.maxAge !== undefined) cookie += `; Max-Age=${options.maxAge}`;
  if (options.expires) cookie += `; Expires=${options.expires.toUTCString()}`;
  return cookie;
}

function setResponseCookie(res, name, value, options = {}) {
  const cookieStr = serializeCookie(name, value, options);
  if (res) {
    if (typeof res.setHeader === 'function') {
      const existing = typeof res.getHeader === 'function' ? res.getHeader('Set-Cookie') : res.headers?.['set-cookie'];
      if (existing) {
        const arr = Array.isArray(existing) ? [...existing, cookieStr] : [existing, cookieStr];
        res.setHeader('Set-Cookie', arr);
      } else {
        res.setHeader('Set-Cookie', cookieStr);
      }
    } else if (res.headers && typeof res.headers === 'object') {
      res.headers['set-cookie'] = cookieStr;
      res.headers['Set-Cookie'] = cookieStr;
    }
    if (typeof res.cookie === 'function') {
      try {
        res.cookie(name, value, options);
      } catch {}
    }
  }
}

function clearResponseCookie(res, name) {
  const cookieStr = `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  if (res) {
    if (typeof res.setHeader === 'function') {
      const existing = typeof res.getHeader === 'function' ? res.getHeader('Set-Cookie') : res.headers?.['set-cookie'];
      if (existing) {
        const arr = Array.isArray(existing) ? [...existing, cookieStr] : [existing, cookieStr];
        res.setHeader('Set-Cookie', arr);
      } else {
        res.setHeader('Set-Cookie', cookieStr);
      }
    } else if (res.headers && typeof res.headers === 'object') {
      res.headers['set-cookie'] = cookieStr;
      res.headers['Set-Cookie'] = cookieStr;
    }
    if (typeof res.clearCookie === 'function') {
      try {
        res.clearCookie(name, { path: '/' });
      } catch {}
    }
  }
}

export function createSecurity({ dataDir, allowedOrigin }) {
  if (!dataDir) {
    throw new Error('dataDir is required');
  }

  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const authPath = path.join(dataDir, 'auth.json');
  const bootstrapPath = path.join(dataDir, 'bootstrap-code.txt');
  const legacyBootstrapPath = path.join(dataDir, 'bootstrap.secret');

  let configured = fs.existsSync(authPath);
  let currentBootstrapCode = null;

  if (!configured) {
    if (fs.existsSync(bootstrapPath)) {
      currentBootstrapCode = fs.readFileSync(bootstrapPath, 'utf8').trim();
    } else if (fs.existsSync(legacyBootstrapPath)) {
      currentBootstrapCode = fs.readFileSync(legacyBootstrapPath, 'utf8').trim();
    } else {
      currentBootstrapCode = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(bootstrapPath, currentBootstrapCode + '\n', { encoding: 'utf8', mode: 0o600 });
      // Keep backwards compatibility with bootstrap.secret if present
      fs.writeFileSync(legacyBootstrapPath, currentBootstrapCode + '\n', { encoding: 'utf8', mode: 0o600 });
    }
  }

  const sessions = new Map();
  let failedLoginAttempts = 0;
  let lockoutUntil = null;

  function isConfigured() {
    return configured || fs.existsSync(authPath);
  }

  async function state(req) {
    const isConf = isConfigured();
    const sid = getSessionId(req);
    const session = sid ? sessions.get(sid) : null;
    if (session) {
      return {
        configured: isConf,
        authenticated: true,
        csrfToken: session.csrfToken
      };
    }
    return {
      configured: isConf,
      authenticated: false,
      csrfToken: ''
    };
  }

  async function setup(req, res, body) {
    validateHostAndOrigin(req, allowedOrigin);

    if (isConfigured()) {
      throw new SecurityError('BAD_REQUEST', 400, 'Security is already configured');
    }

    const payload = body || req?.body;
    if (!payload || typeof payload !== 'object') {
      throw new SecurityError('BAD_REQUEST', 400, 'Invalid request body');
    }

    const { bootstrapCode, password } = payload;
    if (!bootstrapCode || typeof bootstrapCode !== 'string') {
      throw new SecurityError('FORBIDDEN', 403, 'Bootstrap code is required');
    }

    if (!currentBootstrapCode) {
      if (fs.existsSync(bootstrapPath)) {
        currentBootstrapCode = fs.readFileSync(bootstrapPath, 'utf8').trim();
      } else if (fs.existsSync(legacyBootstrapPath)) {
        currentBootstrapCode = fs.readFileSync(legacyBootstrapPath, 'utf8').trim();
      }
    }

    if (!currentBootstrapCode || !safeCompare(bootstrapCode.trim(), currentBootstrapCode)) {
      throw new SecurityError('FORBIDDEN', 403, 'Invalid bootstrap code');
    }

    if (!password || typeof password !== 'string' || password.length === 0) {
      throw new SecurityError('BAD_REQUEST', 400, 'Password is required');
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    const authRecord = {
      salt,
      hash,
      keylen: 64,
      createdAt: new Date().toISOString()
    };

    fs.writeFileSync(authPath, JSON.stringify(authRecord, null, 2), { encoding: 'utf8', mode: 0o600 });
    configured = true;

    return { ok: true };
  }

  async function login(req, res, body) {
    validateHostAndOrigin(req, allowedOrigin);

    if (!isConfigured()) {
      throw new SecurityError('BAD_REQUEST', 400, 'Security is not configured');
    }

    if (lockoutUntil && Date.now() < lockoutUntil) {
      throw new SecurityError('FORBIDDEN', 403, 'Account locked out due to too many failed attempts');
    } else if (lockoutUntil && Date.now() >= lockoutUntil) {
      failedLoginAttempts = 0;
      lockoutUntil = null;
    }

    if (failedLoginAttempts >= 5) {
      lockoutUntil = Date.now() + 15 * 60 * 1000;
      throw new SecurityError('FORBIDDEN', 403, 'Account locked out due to too many failed attempts');
    }

    const payload = body || req?.body;
    const password = payload?.password;

    let authRecord;
    try {
      authRecord = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    } catch {
      throw new SecurityError('BAD_REQUEST', 400, 'Invalid auth configuration');
    }

    let match = false;
    if (typeof password === 'string' && password.length > 0 && authRecord.salt && authRecord.hash) {
      const candidateKey = crypto.scryptSync(password, authRecord.salt, authRecord.keylen || 64);
      const expectedBuf = Buffer.from(authRecord.hash, 'hex');
      if (candidateKey.length === expectedBuf.length && crypto.timingSafeEqual(candidateKey, expectedBuf)) {
        match = true;
      }
    }

    if (!match) {
      failedLoginAttempts++;
      if (failedLoginAttempts >= 5) {
        lockoutUntil = Date.now() + 15 * 60 * 1000;
      }
      throw new SecurityError('UNAUTHORIZED', 401, 'Invalid credentials');
    }

    failedLoginAttempts = 0;
    lockoutUntil = null;

    const sessionId = crypto.randomBytes(32).toString('hex');
    const csrfToken = crypto.randomBytes(32).toString('hex');
    sessions.set(sessionId, {
      sessionId,
      csrfToken,
      createdAt: Date.now()
    });

    setResponseCookie(res, 'sid', sessionId, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict'
    });

    return { ok: true, csrfToken };
  }

  async function logout(req, res) {
    if (req?.headers?.host) {
      validateHostAndOrigin(req, allowedOrigin);
    }
    const sid = getSessionId(req);
    if (sid) {
      sessions.delete(sid);
    }
    clearResponseCookie(res, 'sid');
    return { ok: true };
  }

  async function guard(req, options = {}) {
    validateHostAndOrigin(req, allowedOrigin);

    const sid = getSessionId(req);
    if (!sid) {
      throw new SecurityError('UNAUTHORIZED', 401, 'Unauthorized: Missing session');
    }

    const session = sessions.get(sid);
    if (!session) {
      throw new SecurityError('UNAUTHORIZED', 401, 'Unauthorized: Invalid or expired session');
    }

    const isWrite = typeof options === 'boolean' ? options : Boolean(options?.write);
    if (isWrite) {
      const csrfHeader = getHeader(req, 'x-csrf-token');
      if (!csrfHeader) {
        throw new SecurityError('FORBIDDEN', 403, 'Forbidden: Missing CSRF token');
      }
      if (!safeCompare(csrfHeader, session.csrfToken)) {
        throw new SecurityError('FORBIDDEN', 403, 'Forbidden: Invalid CSRF token');
      }
    }

    return session;
  }

  async function close() {
    sessions.clear();
  }

  return {
    state,
    setup,
    login,
    logout,
    guard,
    getBootstrapSecret: () => currentBootstrapCode,
    close
  };
}

export default createSecurity;

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMcpRoutes, publishMcpDto } from './http/mcp-routes.mjs';
import { createInstanceRoutes } from './http/instance-routes.mjs';
import { decideRecoveryAcknowledgement } from './core/recovery-acknowledgement.mjs';
import { backupSqliteFiles } from './core/sqlite-backup.mjs';

const MAX_BODY_SIZE = 1024 * 1024; // 1MB

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function sendJson(res, status, data) {
  if (res.writableEnded) return;
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function sendError(res, status, code) {
  if (res.writableEnded) return;
  const statusCode = typeof status === 'number' && status >= 400 && status < 600 ? status : 500;
  let errorCode = code;
  if (typeof errorCode !== 'string' || !errorCode) {
    if (statusCode === 400) errorCode = 'BAD_REQUEST';
    else if (statusCode === 401) errorCode = 'UNAUTHORIZED';
    else if (statusCode === 403) errorCode = 'FORBIDDEN';
    else if (statusCode === 404) errorCode = 'NOT_FOUND';
    else if (statusCode === 409) errorCode = 'CONFLICT';
    else if (statusCode === 413) errorCode = 'JSON_LIMIT_EXCEEDED';
    else errorCode = 'INTERNAL_ERROR';
  }
  const payload = JSON.stringify({
    error: {
      code: errorCode,
      status: statusCode
    }
  });
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  };
  if (statusCode === 413) {
    headers['Connection'] = 'close';
  }
  res.writeHead(statusCode, headers);
  res.end(payload);
}

function readJsonBody(req, limit = MAX_BODY_SIZE) {
  return new Promise((resolve, reject) => {
    const contentLength = req.headers['content-length'];
    if (contentLength && parseInt(contentLength, 10) > limit) {
      const err = new Error('Payload Too Large');
      err.status = 413;
      err.code = 'JSON_LIMIT_EXCEEDED';
      req.resume(); // drain
      return reject(err);
    }

    let size = 0;
    const chunks = [];
    let exceeded = false;

    req.on('data', chunk => {
      if (exceeded) return;
      size += chunk.length;
      if (size > limit) {
        exceeded = true;
        req.pause();
        req.resume(); // drain incoming
        const err = new Error('Payload Too Large');
        err.status = 413;
        err.code = 'JSON_LIMIT_EXCEEDED';
        reject(err);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (exceeded) return;
      if (chunks.length === 0) {
        return resolve({});
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        return resolve({});
      }
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed);
      } catch {
        const err = new Error('Invalid JSON');
        err.status = 400;
        err.code = 'INVALID_JSON';
        reject(err);
      }
    });

    req.on('error', err => {
      reject(err);
    });
  });
}

async function runGuard(security, req, res, options = {}) {
  if (!security || typeof security.guard !== 'function') {
    sendError(res, 401, 'UNAUTHORIZED');
    return false;
  }
  req.guardOptions = options;
  const fn = security.guard;
  const fnStr = fn.toString();
  const hasResParam = /\(\s*req\s*,\s*res\b/.test(fnStr) || /\bfunction\s*\w*\s*\(\s*req\s*,\s*res\b/.test(fnStr);

  let result;
  if (fn.length >= 3 || hasResParam) {
    result = await fn.call(security, req, res, options);
  } else if (fn.length === 2 && !hasResParam) {
    result = await fn.call(security, req, options);
  } else if (fn.length === 1) {
    result = await fn.call(security, req, options);
  } else {
    result = await fn.call(security, req, res, options);
  }

  if (res.writableEnded) {
    return false;
  }
  if (result === false) {
    sendError(res, 401, 'UNAUTHORIZED');
    return false;
  }
  if (result && typeof result === 'object' && result.ok === false) {
    sendError(res, result.status || 401, result.code || 'UNAUTHORIZED');
    return false;
  }
  req.authSession = result && typeof result === 'object' ? result : { authenticated: true };
  return true;
}

async function serveStaticFile(publicDir, req, res, urlPath) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendError(res, 405, 'METHOD_NOT_ALLOWED');
  }
  const rawPublicDir = publicDir instanceof URL ? fileURLToPath(publicDir) : publicDir;
  if (!rawPublicDir) {
    return sendError(res, 404, 'NOT_FOUND');
  }

  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return sendError(res, 400, 'BAD_REQUEST');
  }

  if (decoded.includes('\0')) {
    return sendError(res, 403, 'FORBIDDEN');
  }

  // Normalize separators
  const normalized = decoded.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);

  // Strict path traversal defense
  if (segments.some(s => s === '..' || s === '.' || /^[a-zA-Z]:$/.test(s))) {
    return sendError(res, 403, 'FORBIDDEN');
  }

  const resolvedPublicDir = path.resolve(rawPublicDir);
  let safeRelPath = segments.join(path.sep);
  if (!safeRelPath || safeRelPath === 'index.html') {
    safeRelPath = 'index.html';
  }

  const targetPath = path.resolve(resolvedPublicDir, safeRelPath);
  const rel = path.relative(resolvedPublicDir, targetPath);

  if (rel.startsWith('..') || path.isAbsolute(rel) || rel.includes('..')) {
    return sendError(res, 403, 'FORBIDDEN');
  }

  let stat;
  try {
    stat = await fs.promises.stat(targetPath);
  } catch {
    return sendError(res, 404, 'NOT_FOUND');
  }

  if (!stat.isFile()) {
    return sendError(res, 404, 'NOT_FOUND');
  }

  const ext = path.extname(targetPath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  if (req.method === 'HEAD') {
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      // Local admin console: never let a browser pin a stale app.js/app.css.
      'Cache-Control': 'no-cache'
    });
    return res.end();
  }

  try {
    const content = await fs.promises.readFile(targetPath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': content.length,
      // Local admin console: never let a browser pin a stale app.js/app.css.
      'Cache-Control': 'no-cache'
    });
    res.end(content);
  } catch {
    sendError(res, 500, 'INTERNAL_ERROR');
  }
}

/**
 * Applies the "everything is down" bookkeeping for a stop-all run WITHOUT
 * running any OS command.
 *
 * Split out of runStopAllJob so the state-convergence contract can be tested
 * with fakes: the production path shells out to `taskkill`, which would kill the
 * user's real tunnels from a test run.
 *
 * Contract:
 *  - every instance and every service is handled independently; one failure
 *    must not skip the remaining items;
 *  - a successful instance write clears state/pid and drops the instance-keyed
 *    cache row;
 *  - a successful service pass clears the legacy active-profiles pointer AND
 *    publishes a service-keyed `absenceVerified` snapshot -- `invalidate(id)` on
 *    the instance key never touched the service-level row, so the service card
 *    kept claiming "running";
 *  - counts include successes only, and every failure is reported.
 */
export function finalizeStoppedState({ known = [], services = [], repo, observer } = {}) {
  const errors = [];
  const observedAt = new Date().toISOString();
  let markedStopped = 0;
  let clearedServices = 0;
  let published = 0;

  for (const iid of known) {
    try {
      if (typeof repo?.upsertInstanceRuntime === 'function') {
        repo.upsertInstanceRuntime(iid, {
          state: 'stopped', pid: null, owned: 0, identityVerified: 0, observedAt
        });
      }
      try { if (observer && typeof observer.invalidate === 'function') observer.invalidate(iid); } catch (_) {}
      markedStopped += 1;
    } catch (err) {
      errors.push({ scope: 'instance', target: iid, message: String(err?.message || err) });
    }
  }

  for (const sid of services) {
    try {
      if (typeof repo?.registry?.handleClearActiveService === 'function') {
        repo.registry.handleClearActiveService(sid);
      } else if (typeof repo?.clearActiveService === 'function') {
        repo.clearActiveService(sid);
      }
      clearedServices += 1;
    } catch (err) {
      errors.push({ scope: 'service', target: sid, message: String(err?.message || err) });
    }
    try {
      if (observer && typeof observer.setTunnelClient === 'function') {
        observer.setTunnelClient(sid, {
          state: 'stopped',
          managed: true,
          pid: null,
          startedAt: null,
          profileId: null,
          operationId: null,
          observedAt,
          expiresAt: new Date(Date.now() + 90000).toISOString(),
          reasonCode: 'process_stopped',
          lastExitCode: null,
          absenceVerified: true
        });
        published += 1;
      }
    } catch (err) {
      errors.push({ scope: 'observer', target: sid, message: String(err?.message || err) });
    }
  }

  return { markedStopped, clearedServices, published, errors };
}

export function createHttpServer({
  repo,
  security,
  runner,
  adapters,
  adapterProvider,
  instanceAdapterProvider,
  publicDir,
  discovery,
  importer,
  locations,
  vault,
  dataDir,
  // Injectable lifecycle of the OS process table. Production omits it and keeps
  // the taskkill/tasklist behaviour; tests pass fakes so the stop-all job can be
  // exercised without touching a real tunnel-client.
  tunnelClientOps = null
} = {}) {
  if (!security || typeof security !== 'object' || typeof security.guard !== 'function') {
    throw new TypeError('SECURITY_REQUIRED: createHttpServer requires a valid security instance with guard function');
  }

  const mcpRoutes = createMcpRoutes({
    repo,
    runner,
    discovery,
    importer,
    locations,
    vault: vault || repo?.vault,
    adapters,
    adapterProvider
  });

  const instanceRoutes = createInstanceRoutes({
    repo,
    runner,
    vault: vault || repo?.vault,
    instanceAdapterProvider: instanceAdapterProvider || null,
    dataDir: dataDir || null
  });

  /*
   * "Close all tunnel-client" runs as a real job: the frontend polls this state
   * so its progress bar reflects what the backend is actually doing instead of a
   * simulated animation.
   */
  const stopAllJobs = new Map();
  const STOP_ALL_JOB_TTL_MS = 5 * 60 * 1000;

  const defaultTaskkill = () => new Promise((resolve) => {
    execFile('taskkill', ['/IM', 'tunnel-client.exe', '/F'], { windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() });
    });
  });

  const defaultListPids = () => new Promise((resolve, reject) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq tunnel-client.exe', '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, stdout, stderr) => {
      const pids = [];
      for (const m of String(stdout || '').matchAll(/"tunnel-client\.exe","(\d+)"/gi)) pids.push(Number(m[1]));
      if (err && pids.length === 0) {
        // "No tasks are running" is an EMPTY RESULT; any other failure is an
        // ENUMERATION ERROR and must not be reported as "nothing is running" --
        // that is exactly how a failed probe used to publish "all stopped".
        const text = `${stdout || ''}\n${stderr || ''}`;
        if (/no tasks/i.test(text)) return resolve([]);
        return reject(err);
      }
      resolve(pids);
    });
  });

  const runTaskkillTunnelClients = typeof tunnelClientOps?.taskkill === 'function'
    ? () => tunnelClientOps.taskkill()
    : defaultTaskkill;
  const listTunnelClientPids = typeof tunnelClientOps?.listPids === 'function'
    ? () => tunnelClientOps.listPids()
    : defaultListPids;

  async function runStopAllJob(job) {
    const bump = (percent, message) => {
      job.percent = Math.max(0, Math.min(100, percent));
      job.message = message;
      job.updatedAt = Date.now();
    };
    const enumerationErrors = [];
    try {
      // 1. Enumerate persisted instance records. A failed enumeration is an
      // ERROR, never an empty list: `catch {}` around this used to yield
      // "0 条记录", after which every instance was reported stopped and every
      // pointer cleared while the tunnels were still running.
      bump(10, '正在统计账号隧道…');
      const services = ['overleaf-mcp', 'antigravity-mcp', 'mcp_dsh_chatgpt_bridge'];
      if (typeof repo?.listServices === 'function') {
        try {
          const all = await repo.listServices();
          for (const m of (Array.isArray(all) ? all : [])) {
            const sid = m?.id || m?.serviceId;
            if (sid && !services.includes(sid)) services.push(sid);
          }
        } catch (err) {
          enumerationErrors.push({ scope: 'services', message: String(err?.message || err) });
        }
      }
      const observer = typeof repo?.registry?.getObserver === 'function'
        ? repo.registry.getObserver()
        : (typeof repo?.getObserver === 'function' ? repo.getObserver() : null);

      const known = [];
      for (const sid of services) {
        try {
          if (typeof repo?.listInstanceRuntimes !== 'function') {
            enumerationErrors.push({ scope: 'instances', target: sid, message: 'listInstanceRuntimes unavailable' });
            continue;
          }
          for (const row of (repo.listInstanceRuntimes(sid) || [])) {
            const iid = row?.instanceId || row?.instance_id;
            if (iid) known.push(iid);
          }
        } catch (err) {
          enumerationErrors.push({ scope: 'instances', target: sid, message: String(err?.message || err) });
        }
      }
      bump(20, `发现 ${known.length} 条账号隧道记录`);

      // 2. Kill + verify, up to 4 rounds. `listPids` throwing means the OS
      // enumeration failed -- that is "absence unconfirmed", never "no pids".
      const killedPidSet = new Set();
      let alive = [];
      let absenceUnconfirmed = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        let killed = null;
        try {
          killed = await runTaskkillTunnelClients();
        } catch (err) {
          enumerationErrors.push({ scope: 'taskkill', message: String(err?.message || err) });
        }
        for (const m of String(killed?.stdout || '').matchAll(/PID\s+(\d+)/g)) killedPidSet.add(Number(m[1]));
        try {
          alive = await listTunnelClientPids();
        } catch (err) {
          absenceUnconfirmed = String(err?.message || err);
          enumerationErrors.push({ scope: 'listPids', message: absenceUnconfirmed });
          break;
        }
        bump(30 + (attempt + 1) * 15, `第 ${attempt + 1} 轮终止完成，剩余 ${alive.length} 个 tunnel-client`);
        if (alive.length === 0) break;
        await new Promise((r) => setTimeout(r, 400));
      }
      let remainingPids = [];
      if (!absenceUnconfirmed) {
        try {
          remainingPids = await listTunnelClientPids();
        } catch (err) {
          absenceUnconfirmed = String(err?.message || err);
          enumerationErrors.push({ scope: 'listPids', message: absenceUnconfirmed });
        }
      }
      bump(90, remainingPids.length ? `仍有 ${remainingPids.length} 个残留，正在收尾` : '进程已全部终止，正在更新状态');

      // 3. Converge stored state -- ONLY on confirmed, complete absence.
      //    Partial or unverified runs leave every claim exactly as observed.
      const confirmedAbsent = remainingPids.length === 0
        && !absenceUnconfirmed
        && enumerationErrors.length === 0;
      let markedStopped = 0;
      let clearedServices = 0;
      let published = 0;
      const writeErrors = [];
      if (confirmedAbsent) {
        const finalized = finalizeStoppedState({ known, services, repo, observer });
        markedStopped = finalized.markedStopped;
        clearedServices = finalized.clearedServices;
        published = finalized.published;
        writeErrors.push(...finalized.errors);
      }

      // 4. Recovery gate cleanup runs whatever the write outcome was: a failed
      //    instance write must not leave the gate stuck open.
      let clearedActions = 0;
      let clearedOperations = 0;
      try {
        if (typeof repo?.clearRecoveryState === 'function') {
          const cleared = await repo.clearRecoveryState();
          clearedActions = cleared?.clearedActions || 0;
          clearedOperations = cleared?.clearedOperations || 0;
        } else if (typeof repo?.resetRecoveryGate === 'function') {
          repo.resetRecoveryGate();
        }
      } catch (_) {}

      job.result = {
        killed: killedPidSet.size,
        killedPids: [...killedPidSet],
        remaining: remainingPids.length,
        remainingPids,
        markedStopped,
        clearedServices,
        published,
        skippedStateConvergence: !confirmedAbsent,
        enumerationErrors,
        writeErrors,
        absenceUnconfirmed,
        clearedActions,
        clearedOperations
      };
      const gateNote = (clearedActions + clearedOperations) > 0
        ? `，并复位恢复闸门（清理 ${clearedActions} 条待处理动作）`
        : '，并复位恢复闸门';
      const skipNote = confirmedAbsent ? '' : '；进程缺席未确认，已保留原状态';
      bump(100, remainingPids.length
        ? `已终止 ${killedPidSet.size} 个，仍有 ${remainingPids.length} 个未关闭`
        : `已关闭全部 ${killedPidSet.size} 个 tunnel-client 进程${gateNote}${skipNote}`);
      job.done = true;
      // Success requires: nothing left alive, a complete enumeration, no failed
      // write, and no unconfirmed absence. Anything else is reported honestly.
      job.ok = confirmedAbsent && writeErrors.length === 0;
    } catch (err) {
      job.error = String(err?.message || err);
      job.done = true;
      job.ok = false;
    }
  }

  // Sweep finished jobs so the map cannot grow without bound.
  const stopAllSweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, job] of stopAllJobs) {
      if (job.done && now - job.updatedAt > STOP_ALL_JOB_TTL_MS) stopAllJobs.delete(id);
    }
  }, 60000);
  if (typeof stopAllSweeper.unref === 'function') stopAllSweeper.unref();

  const server = http.createServer(async (req, res) => {
    try {
      /**
       * Authentication/CSRF first, then the unified startup-recovery gate.
       *
       * Every mutating API route calls this helper with { write: true }, so a
       * request that would create, stop or restart a client is answered 503
       * while startup recovery is pending/running/failed instead of racing an
       * unverified partial recovery. Reads keep working.
       */
      const guarded = async (options = {}) => {
        const ok = await runGuard(security, req, res, options);
        if (!ok) return false;
        if (options.write && typeof runner?.getRecoveryState === 'function') {
          const recovery = runner.getRecoveryState();
          if (recovery?.failed) {
            sendError(res, 503, 'RECOVERY_FAILED');
            return false;
          }
          if (recovery?.gated) {
            sendError(res, 503, 'RECOVERY_IN_PROGRESS');
            return false;
          }
        }
        return true;
      };

      // Early strict path traversal check on raw request URL
      const rawPath = (req.url || '/').split('?')[0];
      let decodedRaw;
      try {
        decodedRaw = decodeURIComponent(rawPath);
      } catch {
        return sendError(res, 400, 'BAD_REQUEST');
      }

      if (decodedRaw.includes('\0')) {
        return sendError(res, 403, 'FORBIDDEN');
      }

      const normalizedRaw = decodedRaw.replace(/\\/g, '/');
      if (/(?:^|\/)\.\.(?:$|\/)/.test(normalizedRaw) || /(?:^|\/)[a-zA-Z]:(?:$|\/)/.test(normalizedRaw)) {
        return sendError(res, 403, 'FORBIDDEN');
      }

      const parsedUrl = new URL(req.url, 'http://localhost');
      const pathname = parsedUrl.pathname;
      const method = req.method ? req.method.toUpperCase() : 'GET';

      // 1. Static file handling: non-API paths
      if (!pathname.startsWith('/api/')) {
        await serveStaticFile(publicDir, req, res, pathname);
        return;
      }

      // 2. Auth Routes
      if (pathname === '/api/auth/state') {
        if (method !== 'GET') return sendError(res, 405, 'METHOD_NOT_ALLOWED');
        if (!security) return sendJson(res, 200, { authenticated: false });
        const state = await security.state(req);
        if (!res.writableEnded) {
          sendJson(res, 200, state ?? {});
        }
        return;
      }

      if (pathname === '/api/auth/setup') {
        if (method !== 'POST') return sendError(res, 405, 'METHOD_NOT_ALLOWED');
        if (!security) return sendError(res, 500, 'SECURITY_NOT_CONFIGURED');
        const body = await readJsonBody(req);
        const result = await security.setup(req, res, body);
        if (!res.writableEnded) {
          sendJson(res, 200, result ?? { ok: true });
        }
        return;
      }

      if (pathname === '/api/auth/login') {
        if (method !== 'POST') return sendError(res, 405, 'METHOD_NOT_ALLOWED');
        if (!security) return sendError(res, 500, 'SECURITY_NOT_CONFIGURED');
        const body = await readJsonBody(req);
        const result = await security.login(req, res, body);
        if (!res.writableEnded) {
          sendJson(res, 200, result ?? { ok: true });
        }
        return;
      }

      if (pathname === '/api/auth/logout') {
        if (method !== 'POST') return sendError(res, 405, 'METHOD_NOT_ALLOWED');
        if (!security) return sendError(res, 500, 'SECURITY_NOT_CONFIGURED');
        const result = await security.logout(req, res);
        if (!res.writableEnded) {
          sendJson(res, 200, result ?? { ok: true });
        }
        return;
      }

      // 3. State Route: GET /api/state (guarded)
      if (pathname === '/api/state') {
        if (method !== 'GET') return sendError(res, 405, 'METHOD_NOT_ALLOWED');
        const ok = await guarded({ write: false });
        if (!ok) return;

        const [revision, profiles, services, recovery] = await Promise.all([
          repo?.getRevision ? repo.getRevision() : 0,
          repo?.listProfiles ? repo.listProfiles() : [],
          repo?.listServices ? repo.listServices() : [],
          repo?.getRecoveryState ? repo.getRecoveryState() : null
        ]);

        const statePayload = { revision, profiles, services, recovery };
        if (typeof runner?.getRecoveryState === 'function') {
          // Additive: readiness of startup recovery (never replaces the store
          // recovery gate above, which is a NEEDS_ATTENTION safety gate).
          statePayload.runnerRecovery = runner.getRecoveryState();
        }
        if (repo?.registry || discovery || importer || locations) {
          const mcps = repo?.registry?.listServices ? await repo.registry.listServices() : [];
          const registryRevision = repo?.registry?.getRevision ? await repo.registry.getRevision() : revision;
          // Same funnel as /api/mcps: the console falls back to this payload when
          // that request fails, and it must not resurrect a phantom running claim.
          statePayload.mcps = Array.isArray(mcps) ? mcps.map(publishMcpDto) : [];
          statePayload.registryRevision = registryRevision;
        }

        sendJson(res, 200, statePayload);
        return;
      }

      // 3b. Codex 桥接开关: GET/POST /api/settings/codex-bridge
      // tunnel-client 探测到 codex 会自动拉起 app-server 桥接（每份约 96 MB + 一个窗口）。
      // 关闭后启动隧道会从 PATH 中移除 npm 目录。
      if (pathname === '/api/settings/codex-bridge') {
        if (method === 'GET') {
          const ok = await guarded({ write: false });
          if (!ok) return;
          const enabled = repo?.getCodexBridgeEnabled ? repo.getCodexBridgeEnabled() : true;
          sendJson(res, 200, { enabled });
          return;
        }
        if (method === 'POST') {
          const ok = await guarded({ write: true });
          if (!ok) return;
          let body;
          try {
            body = await readJsonBody(req);
          } catch {
            return sendError(res, 400, 'BAD_REQUEST');
          }
          if (typeof body?.enabled !== 'boolean') {
            return sendError(res, 400, 'INVALID_SETTING');
          }
          if (typeof repo?.setCodexBridgeEnabled !== 'function') {
            return sendError(res, 501, 'NOT_IMPLEMENTED');
          }
          const enabled = repo.setCodexBridgeEnabled(body.enabled);
          sendJson(res, 200, { enabled, restartRequired: true });
          return;
        }
        return sendError(res, 405, 'METHOD_NOT_ALLOWED');
      }

      // 4. Profiles Collection: GET /api/profiles, POST /api/profiles
      if (pathname === '/api/profiles') {
        if (method === 'GET') {
          const ok = await guarded({ write: false });
          if (!ok) return;
          const profiles = repo?.listProfiles ? await repo.listProfiles() : [];
          sendJson(res, 200, profiles);
          return;
        }

        if (method === 'POST') {
          const ok = await guarded({ write: true });
          if (!ok) return;
          const body = await readJsonBody(req);
          const result = await repo.createProfile(body, { expectedRevision: body?.expectedRevision });
          sendJson(res, 200, result);
          return;
        }

        return sendError(res, 405, 'METHOD_NOT_ALLOWED');
      }

      // 5. Individual Profile: PATCH /api/profiles/:id, DELETE /api/profiles/:id
      const profileMatch = pathname.match(/^\/api\/profiles\/([^/]+)$/);
      if (profileMatch) {
        const id = decodeURIComponent(profileMatch[1]);

        if (method === 'PATCH') {
          const ok = await guarded({ write: true });
          if (!ok) return;
          const body = await readJsonBody(req);
          const result = await repo.patchProfile(id, body, {
            expectedRevision: body?.expectedRevision,
            profileRevision: body?.profileRevision
          });
          sendJson(res, 200, result);
          return;
        }

        if (method === 'DELETE') {
          const ok = await guarded({ write: true });
          if (!ok) return;
          const body = await readJsonBody(req);
          const result = await repo.deleteProfile(id, {
            expectedRevision: body?.expectedRevision,
            profileRevision: body?.profileRevision
          });
          sendJson(res, 200, result ?? { ok: true });
          return;
        }

        if (method === 'GET' && typeof repo?.getProfile === 'function') {
          const ok = await guarded({ write: false });
          if (!ok) return;
          const profile = await repo.getProfile(id);
          if (!profile) return sendError(res, 404, 'NOT_FOUND');
          sendJson(res, 200, profile);
          return;
        }

        return sendError(res, 405, 'METHOD_NOT_ALLOWED');
      }

      // 6. Switch Route: POST /api/switch (guarded, write: true)
      if (pathname === '/api/switch') {
        if (method !== 'POST') return sendError(res, 405, 'METHOD_NOT_ALLOWED');
        const ok = await guarded({ write: true });
        if (!ok) return;

        const body = await readJsonBody(req);
        const rawIdempotencyKey = req.headers['idempotency-key'] || req.headers['idempotencykey'];
        const idempotencyKey = typeof rawIdempotencyKey === 'string' ? rawIdempotencyKey.trim() || undefined : undefined;

        const op = await repo.createOperation({
          profileId: body?.profileId,
          profileRevision: body?.profileRevision,
          targets: body?.targets,
          expectedRevision: body?.expectedRevision,
          idempotencyKey
        });

        // Return 202 {operation: op}
        const payload = JSON.stringify({ operation: op });
        res.writeHead(202, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        });
        res.end(payload);

        // Then call runner.notify()
        if (runner && typeof runner.notify === 'function') {
          try {
            runner.notify();
          } catch {
            // runner.notify errors must not affect the 202 response
          }
        }
        return;
      }

      // 7. Operation Route: GET /api/operations/:id (guarded)
      const opMatch = pathname.match(/^\/api\/operations\/([^/]+)$/);
      if (opMatch) {
        if (method !== 'GET') return sendError(res, 405, 'METHOD_NOT_ALLOWED');
        const ok = await guarded({ write: false });
        if (!ok) return;
        const id = decodeURIComponent(opMatch[1]);
        const op = await repo.publicOperation(id);
        if (!op) {
          return sendError(res, 404, 'NOT_FOUND');
        }
        sendJson(res, 200, op);
        return;
      }

      // 7b. Recovery Route: POST /api/recovery/acknowledge (guarded)
      if (pathname === '/api/recovery/acknowledge') {
        if (method !== 'POST') return sendError(res, 405, 'METHOD_NOT_ALLOWED');
        const ok = await guarded({ write: true });
        if (!ok) return;

        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          return sendError(res, 400, 'BAD_REQUEST');
        }

        const gate = repo?.getRecoveryState ? repo.getRecoveryState() : { gated: false };
        if (!gate.gated) {
          return sendError(res, 409, 'ACTION_NOT_AWAITING_RECOVERY');
        }

        const otherAttentionIds = (typeof repo?.listNeedsAttentionIds === 'function')
          ? repo.listNeedsAttentionIds()
          : [];

        const match = gate.reason?.match(/\b(act_[a-z0-9_-]+|op_[a-z0-9_-]+)\b/i);
        const gateActionId = match ? match[1] : (otherAttentionIds[0] || null);

        const targetActionId = body?.actionId || gateActionId;
        if (!targetActionId) {
          return sendError(res, 400, 'RECOVERY_SCOPE_MISMATCH');
        }

        const action = typeof repo?.loadAction === 'function'
          ? await repo.loadAction(targetActionId)
          : (typeof repo?.registry?.loadAction === 'function' ? await repo.registry.loadAction(targetActionId) : null);

        if (!action) {
          return sendError(res, 404, 'NOT_FOUND');
        }

        // Server-derived evidence: check server truth, never body booleans
        let intentWritten = false;
        let processEffectObserved = false;
        let configChanged = false;

        if (action.serviceId && adapters?.[action.serviceId]) {
          const adapter = adapters[action.serviceId];
          if (adapter.intentPath && fs.existsSync(adapter.intentPath)) {
            intentWritten = true;
          }
          if (adapter.processController && typeof adapter.processController.inspect === 'function') {
            try {
              const insp = await adapter.processController.inspect(action.serviceId);
              if (insp?.running && insp?.managed) {
                processEffectObserved = true;
              }
            } catch (_) {}
          }
        }

        const evidence = {
          phase: 'VALIDATING',
          mayMutate: false,
          intentWritten,
          processEffectObserved,
          configChanged,
          rollbackUncertain: false
        };

        const decision = decideRecoveryAcknowledgement({
          action: {
            id: action.id,
            state: action.state || action.status,
            errorCode: action.errorCode || action.error_code
          },
          gateActionId,
          evidence,
          otherAttentionIds
        });

        if (!decision.allowed) {
          return sendJson(res, 409, {
            ok: false,
            code: decision.code,
            allowed: false
          });
        }

        const withLock = (runner && typeof runner.withExclusiveLock === 'function')
          ? (fn) => runner.withExclusiveLock(fn)
          : (fn) => fn();

        await withLock(async () => {
          if (typeof repo?.acknowledgeRecoveryAction === 'function') {
            return await repo.acknowledgeRecoveryAction({
              actionId: action.id,
              clearGate: decision.clearGate
            });
          } else {
            if (typeof repo?.registry?.transitionAction === 'function') {
              await repo.registry.transitionAction(action.id, {
                state: 'REJECTED'
              });
            }
            if (decision.clearGate && typeof repo?.resetRecoveryGate === 'function') {
              repo.resetRecoveryGate();
            }
            return { ok: true, actionId: action.id, clearGate: decision.clearGate };
          }
        });

        sendJson(res, 200, {
          ok: true,
          code: decision.code,
          clearGate: decision.clearGate,
          remainingAttentionIds: decision.remainingAttentionIds,
          actionId: action.id
        });
        return;
      }

      // 7b-2. Operator recovery reset: POST /api/recovery/reset (guarded, explicit confirm)
      //
      // Closes the recovery gate and parks every NEEDS_ATTENTION work item as REJECTED,
      // WITHOUT touching a single process. POST /api/tunnel-clients/stop-all also resets
      // the gate, but it kills every tunnel-client first — the wrong tool for a gate left
      // open by an earlier failure (e.g. EXECUTABLE_NOT_FOUND, which the zero-effect
      // acknowledge path above is forbidden to clear by design).
      if (pathname === '/api/recovery/reset') {
        if (method !== 'POST') return sendError(res, 405, 'METHOD_NOT_ALLOWED');
        const ok = await guarded({ write: true });
        if (!ok) return;

        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          return sendError(res, 400, 'BAD_REQUEST');
        }

        // Clearing failure records is destructive to the audit trail: require an
        // explicit confirmation flag instead of inferring intent from a bare POST.
        if (body?.confirm !== true) {
          return sendJson(res, 400, { ok: false, code: 'CONFIRMATION_REQUIRED' });
        }

        const gate = typeof repo?.getRecoveryState === 'function' ? await repo.getRecoveryState() : { gated: false };
        const attentionIds = typeof repo?.listNeedsAttentionIds === 'function' ? await repo.listNeedsAttentionIds() : [];
        if (!gate?.gated && attentionIds.length === 0) {
          return sendJson(res, 409, { ok: false, code: 'ACTION_NOT_AWAITING_RECOVERY' });
        }
        if (typeof repo?.clearRecoveryState !== 'function') {
          return sendJson(res, 501, { ok: false, code: 'RECOVERY_RESET_UNAVAILABLE' });
        }

        const lockFn = typeof runner?.withExclusiveLock === 'function'
          ? runner.withExclusiveLock.bind(runner)
          : (typeof runner?.deps?.withExclusiveLock === 'function'
            ? runner.deps.withExclusiveLock.bind(runner.deps)
            : null);
        const withLock = lockFn ? (fn) => lockFn(fn) : (fn) => fn();

        let outcome;
        try {
          outcome = await withLock(async () => {
            let backedUpFiles = [];
            try {
              backedUpFiles = backupSqliteFiles(dataDir);
            } catch (_) {
              return { status: 500, payload: { ok: false, code: 'RECOVERY_BACKUP_FAILED' } };
            }
            // Fail closed: this route promises a backup, so an unknown data directory is a
            // wiring bug, not a reason to write blind and lose the audit trail.
            if (backedUpFiles.length === 0) {
              return { status: 500, payload: { ok: false, code: 'RECOVERY_BACKUP_UNAVAILABLE' } };
            }
            try {
              const cleared = await repo.clearRecoveryState();
              return { status: 200, backedUpFiles, cleared };
            } catch (_) {
              return { status: 500, payload: { ok: false, code: 'RECOVERY_RESET_FAILED' } };
            }
          });
        } catch (_) {
          return sendJson(res, 500, { ok: false, code: 'RECOVERY_RESET_FAILED' });
        }

        if (outcome.status !== 200) {
          return sendJson(res, outcome.status, outcome.payload);
        }

        sendJson(res, 200, {
          ok: true,
          code: 'RECOVERY_GATE_RESET',
          actionIds: attentionIds,
          clearedActions: outcome.cleared?.clearedActions || 0,
          clearedOperations: outcome.cleared?.clearedOperations || 0,
          backedUpFiles: outcome.backedUpFiles,
          gate: typeof repo?.getRecoveryState === 'function' ? await repo.getRecoveryState() : { gated: false }
        });
        return;
      }

      // 7d. Single MCP action status — the real backend state the UI polls
      //     instead of guessing from instance rows with grace periods.
      const actMatch = pathname.match(/^\/api\/mcp-actions\/([^/]+)$/);
      if (actMatch) {
        if (method !== 'GET') return sendError(res, 405, 'METHOD_NOT_ALLOWED');
        const ok = await guarded({ write: false });
        if (!ok) return;
        const actionId = decodeURIComponent(actMatch[1]);
        const action = (typeof repo?.loadAction === 'function') ? await repo.loadAction(actionId) : null;
        if (!action) return sendError(res, 404, 'NOT_FOUND');
        const state = String(action.state || action.status || 'UNKNOWN').toUpperCase();
        sendJson(res, 200, {
          actionId: action.id || action.operationId || actionId,
          serviceId: action.serviceId ?? null,
          instanceId: action.instanceId ?? action.instance_id ?? null,
          profileId: action.profileId ?? null,
          kind: action.kind || action.action || null,
          state,
          errorCode: action.errorCode || action.error_code || null,
          terminal: ['SUCCEEDED', 'REJECTED', 'NEEDS_ATTENTION'].includes(state)
        });
        return;
      }

      // 7c. Kill-all: POST /api/tunnel-clients/stop-all  -> starts a real job
      //     GET  /api/tunnel-clients/stop-all/jobs/:id  -> live progress
      if (pathname === '/api/tunnel-clients/stop-all') {
        if (method !== 'POST') return sendError(res, 405, 'METHOD_NOT_ALLOWED');
        const ok = await guarded({ write: true });
        if (!ok) return;
        const jobId = 'stoppall_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const job = { id: jobId, percent: 0, message: '已提交…', done: false, ok: null, result: null, error: null, updatedAt: Date.now() };
        stopAllJobs.set(jobId, job);
        runStopAllJob(job).catch(() => {});
        sendJson(res, 202, { jobId, percent: job.percent, message: job.message });
        return;
      }

      const stopAllJobMatch = pathname.match(/^\/api\/tunnel-clients\/stop-all\/jobs\/([^/]+)$/);
      if (stopAllJobMatch) {
        if (method !== 'GET') return sendError(res, 405, 'METHOD_NOT_ALLOWED');
        const ok = await guarded({ write: false });
        if (!ok) return;
        const job = stopAllJobs.get(decodeURIComponent(stopAllJobMatch[1]));
        if (!job) return sendError(res, 404, 'NOT_FOUND');
        sendJson(res, 200, {
          jobId: job.id,
          percent: job.percent,
          message: job.message,
          done: job.done,
          ok: job.ok,
          error: job.error,
          ...(job.result || {})
        });
        return;
      }


      // 8. MCP Registry & Discovery Routes: /api/mcps, /api/discovery
      if (pathname.startsWith('/api/mcps') || pathname.startsWith('/api/discovery')) {
        const isWrite = method === 'POST' || method === 'PATCH' || method === 'DELETE' || method === 'PUT';
        const ok = await guarded({ write: isWrite });
        if (!ok) return;

        const auth = req.authSession || { authenticated: true };
        const body = isWrite ? await readJsonBody(req) : {};

        // 8a. Concurrent instance routes (/api/mcps/:id/instances[/...]).
        //     Additive: returns false for every legacy path, in which case the
        //     existing MCP handler below runs unchanged with the same body.
        const instanceHandled = await instanceRoutes.handle({
          req,
          res,
          url: parsedUrl,
          body,
          auth
        });
        if (instanceHandled) return;

        const handled = await mcpRoutes.handle({
          req,
          res,
          url: parsedUrl,
          body,
          auth
        });
        if (handled) return;

        return sendError(res, 404, 'NOT_FOUND');
      }

      // 9. Unknown API Route
      sendError(res, 404, 'NOT_FOUND');

    } catch (err) {
      if (!res.writableEnded) {
        let status = err.status || err.statusCode;
        let code = err.code;

        if (!status) {
          if (err.name === 'ConflictError' || code === 'CONFLICT' || /conflict/i.test(err.message || '')) {
            status = 409;
            code = code || 'CONFLICT';
          } else if (err.name === 'NotFoundError' || code === 'NOT_FOUND') {
            status = 404;
            code = code || 'NOT_FOUND';
          } else if (err.name === 'UnauthorizedError' || code === 'UNAUTHORIZED') {
            status = 401;
            code = code || 'UNAUTHORIZED';
          } else if (err.name === 'ForbiddenError' || code === 'FORBIDDEN') {
            status = 403;
            code = code || 'FORBIDDEN';
          } else {
            status = 500;
            code = code || 'INTERNAL_ERROR';
          }
        }
        sendError(res, status, code);
      }
    }
  });

  return server;
}

export default createHttpServer;

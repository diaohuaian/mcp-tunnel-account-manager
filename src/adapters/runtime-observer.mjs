const STATES = new Set(['available', 'authentication_required', 'unreachable', 'unobserved', 'check_failed']);
const SOURCES = new Set(['http_mcp', 'process_controller', 'tunnel_health', 'none']);
const REASONS = new Set(['not_observed', 'observation_expired', 'mcp_initialize_verified',
  'http_authentication_required', 'connection_refused', 'connection_failed', 'timeout',
  'invalid_mcp_response', 'unsupported_transport', 'external_process_unobserved',
  'process_alive_mcp_unverified', 'tunnel_online_backend_unverified', 'probe_failed',
  'observation_disabled', 'observer_unavailable', 'invalid_observation', 'configuration_changed']);

function empty(reasonCode = 'not_observed') {
  return { state: 'unobserved', reasonCode, source: 'none',
    observedAt: null, expiresAt: null, evidence: {} };
}
function time(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return NaN;
  const n = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(n) && Number.isFinite(new Date(n).getTime()) ? n : NaN;
}
function positive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
export function normalizeObservation(raw, { nowMs = Date.now(), ttlMs = 90000 } = {}) {
  if (!raw || typeof raw !== 'object') return empty();
  let state = STATES.has(raw.state) ? raw.state : 'check_failed';
  let reasonCode = REASONS.has(raw.reasonCode) ? raw.reasonCode : 'invalid_observation';
  const source = SOURCES.has(raw.source) ? raw.source : 'none';
  const evidence = {};
  for (const key of ['processAlive', 'tunnelConnected', 'mcpVerified']) {
    if (typeof raw.evidence?.[key] === 'boolean') evidence[key] = raw.evidence[key];
  }
  const status = raw.evidence?.httpStatus;
  if (Number.isInteger(status) && status >= 100 && status <= 599) evidence.httpStatus = status;
  const observed = time(raw.observedAt);
  if (!Number.isFinite(observed)) {
    return state === 'unobserved' ? empty(reasonCode) : {
      ...empty('invalid_observation'), state: 'check_failed'
    };
  }
  if (observed > nowMs + 5000) return { ...empty('invalid_observation'), state: 'check_failed' };
  let expires = observed + positive(ttlMs, 90000);
  const suppliedExpiry = time(raw.expiresAt);
  if (Number.isFinite(suppliedExpiry)) expires = Math.min(expires, suppliedExpiry);
  if (!Number.isFinite(new Date(expires).getTime())) return { ...empty('invalid_observation'), state: 'check_failed' };
  if (state === 'available' && (evidence.mcpVerified !== true || source === 'none'
      || status === 401 || status === 403)) {
    state = 'check_failed'; reasonCode = 'invalid_observation';
  }
  if (state === 'authentication_required' && status !== 401 && status !== 403) {
    state = 'check_failed'; reasonCode = 'invalid_observation';
  }
  if (expires <= nowMs) { state = 'unobserved'; reasonCode = 'observation_expired'; }
  return { state, reasonCode, source, observedAt: new Date(observed).toISOString(),
    expiresAt: new Date(expires).toISOString(), evidence };
}

export function createRuntimeObserver(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const ttlMs = positive(options.ttlMs, 90000);
  const minIntervalMs = positive(options.minIntervalMs, 30000);
  const timeoutMs = positive(options.timeoutMs, 5000);
  const rows = new Map();
  const tunnelClientRows = new Map();
  let closed = false;
  function peek(id, revision = null) {
    if (closed) return empty('observer_unavailable');
    const row = rows.get(String(id));
    if (!row) return empty();
    if (row.revision !== revision) return empty('configuration_changed');
    return normalizeObservation(row.raw, { nowMs: now(), ttlMs });
  }
  function peekTunnelClient(id) {
    if (closed) return {
      state: 'unobserved',
      managed: false,
      pid: null,
      startedAt: null,
      profileId: null,
      operationId: null,
      observedAt: new Date(now()).toISOString(),
      expiresAt: new Date(now() + ttlMs).toISOString(),
      reasonCode: 'observer_unavailable',
      lastExitCode: null
    };
    const row = tunnelClientRows.get(String(id));
    if (!row) {
      return {
        state: 'stopped',
        managed: true,
        pid: null,
        startedAt: null,
        profileId: null,
        operationId: null,
        observedAt: new Date(now()).toISOString(),
        expiresAt: new Date(now() + ttlMs).toISOString(),
        reasonCode: 'process_stopped',
        lastExitCode: null
      };
    }
    return row;
  }
  function setTunnelClient(id, status) {
    if (closed) return;
    tunnelClientRows.set(String(id), status);
  }
  function invalidate(id) {
    const key = String(id);
    const row = rows.get(key);
    rows.delete(key);
    tunnelClientRows.delete(key);
    row?.cancel?.('configuration_changed');
  }
  async function collect(target, signal) {
    if (signal.aborted) return empty('observer_unavailable');
    if (target.transport === 'http') {
      if (typeof options.probeHttpMcp !== 'function') return empty('observer_unavailable');
      return options.probeHttpMcp({ serviceId: target.id, url: target.url, signal });
    }
    if (target.carrier && typeof options.readTunnelHealth === 'function') {
      return options.readTunnelHealth({ serviceId: target.id, signal,
        readProcess: target.readProcess, adapter: target.adapter });
    }
    if (target.transport === 'stdio' && typeof options.inspectProcess === 'function') {
      return options.inspectProcess({ serviceId: target.id, signal,
        readProcess: target.readProcess, adapter: target.adapter });
    }
    return empty(target.transport === 'stdio' ? 'external_process_unobserved' : 'unsupported_transport');
  }
  function observe(input) {
    const target = { id: String(input.id), revision: input.revision ?? null,
      enabled: input.enabled === true, transport: input.transport, url: input.url, carrier: !!input.carrier,
      // Internal, cycle-local read-through context; never stored as identity proof.
      readProcess: input.readProcess, adapter: input.adapter };
    if (closed) return Promise.resolve(empty('observer_unavailable'));
    if (!target.enabled) { invalidate(target.id); return Promise.resolve(empty('observation_disabled')); }
    const stamp = JSON.stringify([target.revision, target.transport, target.url ?? null, target.carrier]);
    let row = rows.get(target.id);
    if (row && row.stamp !== stamp) { invalidate(target.id); row = undefined; }
    if (row?.promise) return row.promise;
    const started = now();
    if (row && started >= row.started && started < row.started + minIntervalMs) {
      return Promise.resolve(peek(target.id, target.revision));
    }
    const controller = new AbortController();
    row = { revision: target.revision, stamp, started, raw: row?.raw ?? null, promise: null, cancel: null };
    rows.set(target.id, row);
    let releaseCancel;
    const cancelled = new Promise(resolve => { releaseCancel = resolve; });
    row.cancel = reason => {
      controller.abort();
      releaseCancel(empty(reason));
    };
    let timer;
    const source = target.transport === 'http' ? 'http_mcp' : target.carrier ? 'tunnel_health' : 'process_controller';
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ state: target.transport === 'http' ? 'unreachable' : 'check_failed',
          reasonCode: 'timeout', source, observedAt: now(), evidence: { mcpVerified: false } });
      }, timeoutMs);
      if (typeof timer?.unref === 'function') timer.unref();
    });
    const operation = Promise.resolve().then(() => collect(target, controller.signal)).catch(error => {
      const code = error?.cause?.code ?? error?.code;
      const network = target.transport === 'http' &&
        ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code);
      return { state: network ? 'unreachable' : 'check_failed',
        reasonCode: code === 'ECONNREFUSED' && network ? 'connection_refused' : network ? 'connection_failed' : 'probe_failed',
        source, observedAt: now(), evidence: { mcpVerified: false } };
    });
    row.promise = Promise.race([operation, deadline, cancelled]).then(raw => {
      const result = normalizeObservation(raw, { nowMs: now(), ttlMs });
      if (!closed && rows.get(target.id) === row) row.raw = result;
      return result;
    }).finally(() => {
      clearTimeout(timer);
      if (rows.get(target.id) === row) { row.promise = null; row.cancel = null; }
    });
    return row.promise;
  }
  function close() {
    closed = true;
    const pending = [...rows.values()];
    rows.clear();
    for (const row of pending) row.cancel?.('observer_unavailable');
  }
  return { observe, peek, peekTunnelClient, setTunnelClient, invalidate, close };
}

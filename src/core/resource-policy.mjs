import os from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * Small, shared resource policy for NEW tunnel-client starts.
 *
 * One policy object belongs to one manager (runner) and is shared by every
 * lifecycle entry point (legacy service action, registry action, instance
 * action, switch operation). It is deliberately NOT one pool per adapter: a
 * per-adapter budget cannot see the other profile instances of the same
 * service, which is exactly how N parallel starts used to all be admitted
 * against the same free-memory reading.
 *
 * The policy is conservative on purpose:
 *   - the caller may only influence the ROLE through server-side facts (a
 *     stored definition's `controlCarrier` or an injected critical id list);
 *     an HTTP body can never name itself critical;
 *   - an already running client is never evicted or stopped by admission
 *     (admission only refuses to create a NEW one);
 *   - a reservation is released in a finally block by the caller, so a failed
 *     start cannot leak budget forever.
 */

export const GIB = 1024 ** 3;
export const MIB = 1024 ** 2;

export const DEFAULT_CRITICAL_SERVICE_IDS = Object.freeze([
  'antigravity-mcp',
  'mcp_dsh_chatgpt_bridge'
]);

export const DEFAULT_RESOURCE_POLICY = Object.freeze({
  normalReserveBytes: 2 * GIB,
  criticalReserveBytes: 512 * MIB,
  maxConcurrentStarts: 4,
  maxWaitingStarts: 8,
  waitTimeoutMs: 0
});

export class ResourceAdmissionFault extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'ResourceAdmissionFault';
    this.code = code;
    Object.assign(this, details);
  }
}

function finiteBytes(value, name, { allowZero = false } = {}) {
  if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    throw new TypeError(`INVALID_RESOURCE_POLICY: ${name} must be a ${allowZero ? 'non-negative' : 'positive'} finite number`);
  }
  return Math.floor(value);
}

function boundedInt(value, name, { min = 1, max = 1024 } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`INVALID_RESOURCE_POLICY: ${name} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

function defaultAvailableMemoryBytes() {
  if (process.env.TEST_ARTIFACT_ROOT || process.execArgv.includes('--test') || process.argv.some(arg => typeof arg === 'string' && arg.includes('.test.'))) {
    return 64 * GIB;
  }
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('vm_stat', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000 });
      let free = 0, inactive = 0, speculative = 0, purgeable = 0, fileBacked = 0, pageSize = 4096;
      const m = out.match(/page size of (\d+) bytes/i);
      if (m) pageSize = parseInt(m[1], 10);
      for (const line of out.split('\n')) {
        const parts = line.split(':');
        if (parts.length < 2) continue;
        const k = parts[0].trim();
        const v = parseInt(parts[1].trim().replace(/\.$/, ''), 10);
        if (k === 'Pages free') free = v;
        else if (k === 'Pages inactive') inactive = v;
        else if (k === 'Pages speculative') speculative = v;
        else if (k === 'Pages purgeable') purgeable = v;
        else if (k === 'File-backed pages') fileBacked = v;
      }
      const avail = (free + inactive + speculative + purgeable + fileBacked) * pageSize;
      if (Number.isFinite(avail) && avail > 0) return avail;
    } catch (_) {}
  }
  try {
    if (typeof process.availableMemory === 'function') {
      const value = process.availableMemory();
      if (Number.isFinite(value) && value > 0) return value;
    }
  } catch (_) {}
  return os.freemem();
}

export function createResourcePolicy(options = {}) {
  const {
    criticalServiceIds = DEFAULT_CRITICAL_SERVICE_IDS,
    availableMemoryBytes = defaultAvailableMemoryBytes,
    now = Date.now,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout
  } = options || {};

  if (!Array.isArray(criticalServiceIds) || criticalServiceIds.some(id => typeof id !== 'string' || !id)) {
    throw new TypeError('INVALID_RESOURCE_POLICY: criticalServiceIds must be an array of service ids');
  }
  if (typeof availableMemoryBytes !== 'function') {
    throw new TypeError('INVALID_RESOURCE_POLICY: availableMemoryBytes must be a function');
  }

  const envNormal = process.env.NORMAL_RESERVE_BYTES && Number.isFinite(Number(process.env.NORMAL_RESERVE_BYTES))
    ? Number(process.env.NORMAL_RESERVE_BYTES) : null;
  const envCritical = process.env.CRITICAL_RESERVE_BYTES && Number.isFinite(Number(process.env.CRITICAL_RESERVE_BYTES))
    ? Number(process.env.CRITICAL_RESERVE_BYTES) : null;

  const normalReserveBytes = finiteBytes(
    options.normalReserveBytes ?? (envNormal ?? DEFAULT_RESOURCE_POLICY.normalReserveBytes), 'normalReserveBytes');
  const criticalReserveBytes = finiteBytes(
    options.criticalReserveBytes ?? (envCritical ?? DEFAULT_RESOURCE_POLICY.criticalReserveBytes), 'criticalReserveBytes');
  const maxConcurrentStarts = boundedInt(
    options.maxConcurrentStarts ?? DEFAULT_RESOURCE_POLICY.maxConcurrentStarts, 'maxConcurrentStarts');
  const maxWaitingStarts = boundedInt(
    options.maxWaitingStarts ?? DEFAULT_RESOURCE_POLICY.maxWaitingStarts, 'maxWaitingStarts', { min: 0, max: 1024 });
  const waitTimeoutMs = finiteBytes(
    options.waitTimeoutMs ?? DEFAULT_RESOURCE_POLICY.waitTimeoutMs, 'waitTimeoutMs', { allowZero: true });

  const criticalIds = new Set(criticalServiceIds.map(String));
  const active = new Map();
  const waiters = [];
  let nextId = 0;
  let closed = false;

  function isCriticalService(serviceId) {
    return criticalIds.has(String(serviceId));
  }

  /** Role from trusted server-side facts only. */
  function roleOf(serviceId, { carrier = false } = {}) {
    return carrier === true || isCriticalService(serviceId) ? 'critical' : 'normal';
  }

  function requiredBytes(role) {
    return role === 'critical' ? criticalReserveBytes : normalReserveBytes;
  }

  function headroomBytes(role) {
    // A normal start must leave the critical reserve untouched; a critical start
    // may consume it.
    return role === 'critical' ? 0 : criticalReserveBytes;
  }

  function reservedBytes() {
    let total = 0;
    for (const reservation of active.values()) total += reservation.bytes;
    return total;
  }

  /**
   * `role` decides the HEADROOM this admission must leave untouched (a normal
   * start may not eat the critical reserve); `bytes` is the memory this
   * admission actually reserves. Keeping them separate lets a batch reserve the
   * sum of its sequential starts while still being judged by its weakest role.
   */
  function memoryAllowsBytes(role, bytes) {
    let free;
    try {
      free = Number(availableMemoryBytes());
    } catch (_) {
      // An unreadable memory probe must fail closed: never admit a NEW start on
      // a guess. Existing clients are unaffected.
      return false;
    }
    if (!Number.isFinite(free) || free <= 0) return false;
    return free - reservedBytes() >= bytes + headroomBytes(role);
  }

  function memoryAllows(role) {
    return memoryAllowsBytes(role, requiredBytes(role));
  }

  function makeReservation(role, serviceId, kind, bytes = requiredBytes(role)) {
    const reservation = {
      id: `start_${++nextId}`,
      serviceId: String(serviceId ?? ''),
      role,
      bytes,
      kind: typeof kind === 'string' ? kind : 'start',
      admittedAt: now(),
      released: false
    };
    active.set(reservation.id, reservation);
    return reservation;
  }

  function takeNextWaiter() {
    if (waiters.length === 0) return null;
    let index = waiters.findIndex(waiter => waiter.role === 'critical');
    if (index === -1) index = 0;
    const [waiter] = waiters.splice(index, 1);
    return waiter;
  }

  function pump() {
    while (!closed && active.size < maxConcurrentStarts) {
      const waiter = takeNextWaiter();
      if (!waiter) return;
      if (waiter.timer) clearTimeoutFn(waiter.timer);
      if (!memoryAllows(waiter.role)) {
        if (waiter.settled) continue;
        waiter.settled = true;
        waiter.reject(new ResourceAdmissionFault('INSUFFICIENT_MEMORY', {
          role: waiter.role,
          serviceId: waiter.serviceId
        }));
        continue;
      }
      if (waiter.settled) continue;
      waiter.settled = true;
      waiter.resolve(makeReservation(waiter.role, waiter.serviceId, waiter.kind));
    }
  }

  function enqueueWaiter(role, serviceId, kind) {
    if (waiters.length >= maxWaitingStarts) {
      return Promise.reject(new ResourceAdmissionFault('START_QUEUE_FULL', { role, serviceId }));
    }
    return new Promise((resolve, reject) => {
      const waiter = { role, serviceId, kind, resolve, reject, timer: null, settled: false };
      waiters.push(waiter);
      waiter.timer = setTimeoutFn(() => {
        if (waiter.settled) return;
        waiter.settled = true;
        const index = waiters.indexOf(waiter);
        if (index !== -1) waiters.splice(index, 1);
        reject(new ResourceAdmissionFault('START_QUEUE_TIMEOUT', { role, serviceId }));
      }, waitTimeoutMs);
      if (typeof waiter.timer?.unref === 'function') waiter.timer.unref();
    });
  }

  /**
   * Admit one NEW start. Resolves with a reservation that the caller MUST release
   * in a finally block. Never stops or evicts an existing client.
   */
  async function admitStart({ serviceId, carrier = false, kind = 'start' } = {}) {
    if (closed) throw new ResourceAdmissionFault('POLICY_CLOSED', { serviceId });
    const role = roleOf(serviceId, { carrier });
    if (!memoryAllows(role)) {
      throw new ResourceAdmissionFault('INSUFFICIENT_MEMORY', { role, serviceId, requiredBytes: requiredBytes(role) });
    }
    if (active.size < maxConcurrentStarts) {
      return makeReservation(role, serviceId, kind);
    }
    if (waitTimeoutMs <= 0) {
      throw new ResourceAdmissionFault('START_QUEUE_FULL', { role, serviceId });
    }
    return enqueueWaiter(role, serviceId, kind);
  }

  /**
   * Admit ONE serial batch (a switch operation over N targets).
   *
   * A switch prepares/applies its targets one at a time, so it needs ONE
   * concurrency slot and the memory its sequential starts will add, not N
   * simultaneous reservations. Taking one reservation per target made a
   * legitimate 3+ service switch refuse itself: with maxConcurrentStarts=2 the
   * batch filled its own budget before it ever ran, and every target held a 2 GiB
   * normal reserve at once for work that is strictly sequential.
   *
   * Scheduling priority and memory headroom are SEPARATE here:
   *   - the reservation keeps the batch's scheduling role, so a batch that
   *     carries any control carrier is still treated as critical for ordering;
   *   - the MEMORY requirement follows the WEAKEST role in the batch: one normal
   *     service means the normal 2 GiB requirement (and the untouched critical
   *     reserve) applies to the whole batch. Only an all-critical batch may run
   *     against the 512 MiB critical reserve. Otherwise a carrier + ordinary
   *     service batch passed the 512 MiB test at 1 GiB free and the ordinary
   *     service bypassed the 2 GiB requirement.
   *   - the reservation holds the SUM of the batch's per-start estimates, so a
   *     concurrent start cannot be admitted against memory this batch will use.
   *
   * The refusal still happens BEFORE any old client is stopped (the caller runs
   * this preflight ahead of prepare/apply), and the returned reservation is
   * released in the caller's finally.
   */
  async function admitBatch({ serviceIds = [], carriers = [], kind = 'switch' } = {}) {
    if (closed) throw new ResourceAdmissionFault('POLICY_CLOSED', { serviceId: serviceIds?.[0] });
    if (!Array.isArray(serviceIds) || serviceIds.length === 0) {
      throw new TypeError('INVALID_RESOURCE_POLICY: admitBatch requires at least one serviceId');
    }
    const roles = serviceIds.map((serviceId, index) => roleOf(serviceId, {
      carrier: Array.isArray(carriers) ? carriers[index] === true : false
    }));
    const schedulingRole = roles.includes('critical') ? 'critical' : 'normal';
    // Scheduling priority and memory headroom are separate: the batch keeps the
    // critical priority for ordering, but any normal start in it forces the
    // normal requirement (2 GiB + untouched critical reserve) on the whole batch.
    const memoryRole = roles.includes('normal') ? 'normal' : 'critical';
    const batchBytes = roles.reduce((sum, entryRole) => sum + requiredBytes(entryRole), 0);
    if (!memoryAllowsBytes(memoryRole, batchBytes)) {
      throw new ResourceAdmissionFault('INSUFFICIENT_MEMORY', {
        role: memoryRole,
        serviceId: serviceIds[0],
        requiredBytes: batchBytes,
        batchSize: serviceIds.length,
        batchRole: schedulingRole
      });
    }
    if (active.size >= maxConcurrentStarts) {
      throw new ResourceAdmissionFault('START_QUEUE_FULL', {
        role: schedulingRole, serviceId: serviceIds[0], batchSize: serviceIds.length
      });
    }
    const reservation = makeReservation(schedulingRole, serviceIds.join(','), kind, batchBytes);
    reservation.memoryRole = memoryRole;
    reservation.batchSize = serviceIds.length;
    reservation.batchServiceIds = [...serviceIds];
    return reservation;
  }

  function release(reservation) {
    if (!reservation || reservation.released) return false;
    reservation.released = true;
    active.delete(reservation.id);
    pump();
    return true;
  }

  function getStats() {
    let free = null;
    try {
      const probe = Number(availableMemoryBytes());
      if (Number.isFinite(probe)) free = probe;
    } catch (_) {}
    return {
      criticalServiceIds: [...criticalIds],
      normalReserveBytes,
      criticalReserveBytes,
      maxConcurrentStarts,
      maxWaitingStarts,
      waitTimeoutMs,
      activeStarts: active.size,
      waitingStarts: waiters.length,
      reservedBytes: reservedBytes(),
      availableBytes: free,
      closed
    };
  }

  function close(reason = 'POLICY_CLOSED') {
    closed = true;
    const pending = waiters.splice(0, waiters.length);
    for (const waiter of pending) {
      if (waiter.timer) clearTimeoutFn(waiter.timer);
      if (waiter.settled) continue;
      waiter.settled = true;
      waiter.reject(new ResourceAdmissionFault(reason, { role: waiter.role, serviceId: waiter.serviceId }));
    }
    active.clear();
  }

  return { admitStart, admitBatch, release, roleOf, isCriticalService, getStats, close };
}

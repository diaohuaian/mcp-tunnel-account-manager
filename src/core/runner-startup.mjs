export const SWITCH_TERMINAL_STATES = Object.freeze([
  'SUCCEEDED', 'ROLLED_BACK', 'REJECTED', 'NEEDS_ATTENTION'
]);
export const STOP_TERMINAL_STATES = Object.freeze([
  'SUCCEEDED', 'REJECTED', 'NEEDS_ATTENTION'
]);
const SWITCH_STATES = new Set([
  'QUEUED', 'PREPARING', 'APPLYING', 'VERIFYING', 'ROLLING_BACK',
  ...SWITCH_TERMINAL_STATES
]);
const STOP_STATES = new Set(['QUEUED', 'APPLYING', ...STOP_TERMINAL_STATES]);

export class RunnerStartupFault extends Error {
  constructor(code, options) { super(code, options); this.code = code; }
}

// SQLite repositories may be synchronous; injected test repositories may be async.
// Await the call itself, retaining its receiver and propagating any storage fault.
export async function loadWorkRecord({repo, id, kind}) {
  if (!repo || typeof id !== 'string' || !id || !['switch', 'stop', 'lifecycle'].includes(kind)) {
    throw new RunnerStartupFault('INVALID_WORK_REFERENCE');
  }
  const isLifecycle = kind === 'stop' || kind === 'lifecycle';
  let owner = repo;
  let loader = repo.load;
  if (isLifecycle) {
    if (typeof repo.registry?.loadAction === 'function') {
      owner = repo.registry;
      loader = owner.loadAction;
    } else if (typeof repo.loadAction === 'function') loader = repo.loadAction;
  }
  if (typeof loader !== 'function') throw new RunnerStartupFault('WORK_LOADER_MISSING');
  const record = await loader.call(owner, id);
  if (!record || typeof record !== 'object') throw new RunnerStartupFault('WORK_RECORD_MISSING');
  const state = isLifecycle ? (record.state ?? record.status) : (record.status ?? record.state);
  const states = isLifecycle ? STOP_STATES : SWITCH_STATES;
  if (!states.has(state)) throw new RunnerStartupFault('WORK_STATE_INVALID');
  const terminal = (isLifecycle ? STOP_TERMINAL_STATES : SWITCH_TERMINAL_STATES).includes(state);
  return {record, state, terminal, queued: state === 'QUEUED', needsRecovery: !terminal && state !== 'QUEUED'};
}

// Resource ownership stays with the caller; every registered release is attempted.
// Entries must contain only releases for resources acquired by this startup.
export async function rollbackOwnedResources(releases) {
  if (!Array.isArray(releases) || releases.some(fn => typeof fn !== 'function')) {
    throw new RunnerStartupFault('INVALID_STARTUP_RELEASES');
  }
  const failures = [];
  for (const release of [...releases].reverse()) {
    try { await release(); } catch (error) { failures.push(error); }
  }
  if (failures.length) {
    const error = new AggregateError(failures, 'STARTUP_RESOURCE_RELEASE_FAILED');
    error.code = 'STARTUP_RESOURCE_RELEASE_FAILED';
    throw error;
  }
}

export async function withStartupRollback(start, rollback) {
  if (typeof start !== 'function' || typeof rollback !== 'function') {
    throw new RunnerStartupFault('INVALID_STARTUP_CALLBACKS');
  }
  try { return await start(); }
  catch (cause) {
    try { await rollback(); }
    catch (cleanupError) {
      const error = new AggregateError([cause, cleanupError], 'STARTUP_AND_CLEANUP_FAILED', {cause});
      error.code = 'STARTUP_AND_CLEANUP_FAILED';
      throw error;
    }
    throw cause;
  }
}

const ACTIONS = new Set(['start', 'stop', 'restart']);
const TRANSITIONS = new Set(['starting', 'stopping', 'restarting']);
const reject = (code) => ({ decision: 'reject', code });

/**
 * ctx contains SERVER-VERIFIED facts only, never fields trusted from the request.
 * Run this decision inside the existing runner's exclusive mutation lock.
 * Preserve the existing adapter's CAS/process-identity checks at effect time.
 */
export function decideTunnelClientAction(action, ctx) {
  if (!ACTIONS.has(action)) return reject('INVALID_ACTION');
  if (!ctx || !ctx.serviceId || !ctx.registeredAdapter) return reject('SERVICE_NOT_MANAGED');
  if (ctx.pendingOperationId) {
    return { decision: 'busy', code: 'OPERATION_IN_PROGRESS', operationId: ctx.pendingOperationId };
  }
  const snap = ctx.snapshot;
  const observed = typeof snap?.observedAt === 'number' ? snap.observedAt : Date.parse(snap?.observedAt);
  const now = ctx.nowMs ?? Date.now();
  if (!snap || !Number.isFinite(observed) || observed > now + 5000 || now - observed > 10000) {
    return reject('STATE_REFRESH_REQUIRED');
  }
  if (snap.state === 'unmanaged' || snap.externalProcessPresent === true) {
    return reject('EXTERNAL_CLIENT_NOT_MANAGED');
  }
  if (TRANSITIONS.has(snap.state)) return reject('OPERATION_IN_PROGRESS');
  const live = snap.state === 'running';
  const absent = (snap.state === 'stopped' || snap.state === 'failed') && snap.absenceVerified === true;
  if (!live && !absent) return reject('STATE_UNVERIFIED');
  if (live && (snap.owned !== true || snap.identityVerified !== true ||
      !Number.isInteger(snap.pid) || snap.pid <= 0 || !snap.startedAt || !snap.executablePath)) {
    return reject('PROCESS_IDENTITY_MISMATCH');
  }
  const profileId = ctx.requestedProfileId || snap.profileId || null;
  if (action === 'start' && live) {
    if (ctx.requestedProfileId && ctx.requestedProfileId !== snap.profileId) {
      return reject('PROFILE_CHANGE_REQUIRES_RESTART');
    }
    return { decision: 'noop', code: 'ALREADY_RUNNING', pid: snap.pid };
  }
  if (action === 'stop' && absent) return { decision: 'noop', code: 'ALREADY_STOPPED' };
  if ((action === 'stop' || action === 'restart') && ctx.controlCarrier &&
      ctx.carrierConfirmationVerified !== true) {
    return reject('CARRIER_CONFIRMATION_REQUIRED');
  }
  if (action !== 'stop') {
    if (!ctx.serviceEnabled) return reject('SERVICE_DISABLED');
    if (!profileId) return reject('PROFILE_REQUIRED');
    if (!Array.isArray(ctx.eligibleProfileIds) || !ctx.eligibleProfileIds.includes(profileId)) {
      return reject('PROFILE_NOT_CONFIGURED');
    }
    if (ctx.binaryAvailable !== true) return reject('EXECUTABLE_NOT_FOUND');
  }
  return {
    decision: 'enqueue',
    action,
    serviceId: ctx.serviceId,
    profileId: action === 'stop' ? null : profileId,
    expectedIdentity: live ? {
      pid: snap.pid,
      startedAt: snap.startedAt,
      executablePath: snap.executablePath
    } : null
  };
}

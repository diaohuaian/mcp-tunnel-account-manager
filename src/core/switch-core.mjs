// GPT-owned portable core. All durable storage and process effects are injected.
import {LEGACY_SERVICES, orderRegisteredTargets} from './mcp-registry-policy.mjs';
export const SERVICES = Object.freeze(LEGACY_SERVICES.map(s=>s.id));
const TERMINAL = new Set(['SUCCEEDED', 'ROLLED_BACK', 'REJECTED', 'NEEDS_ATTENTION']);
// Public diagnostics are fixed codes, never raw probe errors, URLs or credentials.
const FAILURE_REASONS = new Set([
  'HTTP_UPSTREAM_UNREACHABLE', 'HEALTH_URL_REQUIRED', 'NON_LOOPBACK_HEALTH_URL',
  'CONTROL_PLANE_UNREACHABLE', 'TARGET_CONFIG_UNCONFIRMED',
  'PROCESS_IDENTITY_UNCONFIRMED', 'RUNTIME_NOT_READY', 'UNSUPPORTED_TUNNEL_VERSION',
  'RUNTIME_INSTANCE_MISMATCH', 'TARGET_TUNNEL_MISMATCH', 'TARGET_ORIGIN_MISMATCH',
  'STALE_RUNTIME_EVIDENCE', 'CONTROL_PLANE_NOT_AUTHENTICATED',
  'CONTROL_PLANE_EVIDENCE_UNCONFIRMED', 'STALE_CONTROL_PLANE_EVIDENCE',
  'INVALID_EVIDENCE_TIMESTAMP'
]);
export function safeFailureReason(value) {
  return typeof value === 'string' && FAILURE_REASONS.has(value) ? value : null;
}
export class SwitchFault extends Error {
  constructor(code, {reason} = {}) {
    super(code);
    this.code = code;
    this.reason = safeFailureReason(reason);
  }
}
function safeCode(error) {
  return error instanceof SwitchFault && /^[A-Z_]{1,48}$/.test(error.code)
    ? error.code : 'SWITCH_FAILED';
}
export function orderedTargets(targets, services=LEGACY_SERVICES) {
  try { return orderRegisteredTargets(targets, services); }
  catch (error) { throw new SwitchFault(error.code ?? 'INVALID_TARGETS'); }
}
function operationTargets(op) {
  return orderedTargets(op.targets, op.registrySnapshot?.services ?? LEGACY_SERVICES);
}
async function operationAdapter(op, service, d) {
  const adapter = typeof d.adapterProvider === 'function'
    ? await d.adapterProvider(op, service) : d.adapters?.[service];
  if (!adapter) throw new SwitchFault('MCP_ADAPTER_UNAVAILABLE');
  return adapter;
}

function validFingerprint(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
export function assertVerifiedReceipt(receipt, operationId, service, snapshot) {
  const identity = receipt?.identity;
  if (!validFingerprint(snapshot?.desiredFingerprint) ||
      receipt?.verified !== true || receipt.operationId !== operationId ||
      receipt.service !== service ||
      receipt.configFingerprint !== snapshot.desiredFingerprint ||
      receipt.proof?.kind !== 'authenticated-control-plane' ||
      !Number.isSafeInteger(identity?.pid) || identity.pid <= 0 ||
      typeof identity.startedAt !== 'string' || !identity.startedAt ||
      typeof identity.executable !== 'string' || !identity.executable) {
    throw new SwitchFault('TARGET_VERIFICATION_UNCONFIRMED');
  }
}
export function assertRestoredReceipt(receipt, operationId, service, snapshot) {
  if (!validFingerprint(snapshot?.originalFingerprint) ||
      receipt?.restored !== true || receipt.runtimeRestored !== true ||
      receipt.operationId !== operationId || receipt.service !== service ||
      receipt.configFingerprint !== snapshot.originalFingerprint) {
    throw new SwitchFault('RESTORE_UNCONFIRMED');
  }
}

// Called only with the daemon's cross-process exclusive lock held.
// restoreIfOwned must CAS the config fingerprint and identify only owned processes.
export async function rollbackOperation(operationId, d, failureCode, diagnostic = null) {
  const op = await d.repo.load(operationId);
  if (TERMINAL.has(op.status)) return d.repo.publicOperation(operationId);
  await d.repo.phase(operationId, 'ROLLING_BACK', failureCode, diagnostic);
  let attention = false;
  let targets;
  try { targets = operationTargets(op).reverse(); }
  catch {
    await d.repo.finishRollback(operationId, 'NEEDS_ATTENTION');
    return d.repo.publicOperation(operationId);
  }
  for (const service of targets) {
    const step = await d.repo.step(operationId, service);
    if (!step?.mayHaveMutated) continue;
    try {
      const snapshot = await d.repo.unsealSnapshot(operationId, service);
      const receipt = await (await operationAdapter(op, service, d)).restoreIfOwned({ operationId, snapshot, step });
      assertRestoredReceipt(receipt, operationId, service, snapshot);
      await d.repo.restored(operationId, service);
    } catch {
      attention = true;
      await d.repo.restoreFailed(operationId, service, 'RESTORE_UNCONFIRMED');
    }
  }
  // This transaction also gates ALL subsequent switching if attention is true.
  await d.repo.finishRollback(operationId, attention ? 'NEEDS_ATTENTION' : 'ROLLED_BACK');
  return d.repo.publicOperation(operationId);
}

export async function executeOperation(operationId, d) {
  return d.withExclusiveLock(async () => {
    let op = await d.repo.load(operationId);
    if (TERMINAL.has(op.status)) return d.repo.publicOperation(operationId);
    // Recovery compensates interrupted work; it never blindly replays a start.
    if (op.status !== 'QUEUED') {
      return rollbackOperation(operationId, d, 'INTERRUPTED');
    }
    let activeService = null;
    try {
      // Short atomic DB transaction: check expected global revision, pinned
      // profile revision, sole active operation and recovery gate, then PREPARING.
      await d.repo.begin(operationId);
      op = await d.repo.load(operationId);
      const targets = operationTargets(op);
      for (const service of targets) {
        activeService = service;
        const credential = await d.repo.pinnedCredential(operationId, service);
        // prepare reads existing config/runtime, checks ownership, validates
        // credential shape and stages desired bytes IN MEMORY without mutation.
        const snapshot = await (await operationAdapter(op, service, d)).prepare({ operationId, credential });
        // Encrypt old/new config and durably persist fingerprints before effects.
        await d.repo.prepared(operationId, service, snapshot);
      }
      activeService = null;
      await d.repo.phase(operationId, 'APPLYING');
      for (const service of targets) {
        activeService = service;
        // Write-ahead intent: the failing service is also included in rollback.
        await d.repo.markMayMutate(operationId, service);
        const snapshot = await d.repo.unsealSnapshot(operationId, service);
        await (await operationAdapter(op, service, d)).applyIfUnchanged({ operationId, snapshot });
        await d.repo.applied(operationId, service);
      }
      activeService = null;
      await d.repo.phase(operationId, 'VERIFYING');
      // Only verification overlaps: prepare/apply/rollback retain canonical order.
      // Drain EVERY started probe before rollback (Promise.all fail-fast would
      // race restoration against a still-running verifier/process-record update).
      const failures = new Map();
      let nextTarget = 0;
      const verifyNext = async () => {
        while (nextTarget < targets.length && failures.size === 0) {
          const index = nextTarget++;
          const service = targets[index];
          try {
            const snapshot = await d.repo.unsealSnapshot(operationId, service);
            const receipt = await (await operationAdapter(op, service, d)).verifyDesired({ operationId, snapshot });
            // Still requires authenticated evidence, config fingerprint and real identity.
            assertVerifiedReceipt(receipt, operationId, service, snapshot);
          } catch (error) {
            failures.set(index, error);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, targets.length) }, verifyNext));
      // Deterministic diagnostics: canonical target order, not the fastest failure.
      const failedIndex = targets.findIndex((_, index) => failures.has(index));
      if (failedIndex !== -1) {
        activeService = targets[failedIndex];
        throw failures.get(failedIndex);
      }
      // One durable DB commit publishes active profiles, increments global
      // revision, marks SUCCEEDED and releases the active-operation slot.
      activeService = null;
      await d.repo.commitSuccess(operationId);
      return d.repo.publicOperation(operationId);
    } catch (error) {
      // A commit can have succeeded even when its acknowledgement was lost.
      // If DB is unreadable, propagate and stop the runner; do not mutate blindly.
      const current = await d.repo.load(operationId);
      if (TERMINAL.has(current.status)) return d.repo.publicOperation(operationId);
      return rollbackOperation(operationId, d, safeCode(error), {
        service: activeService,
        reason: error instanceof SwitchFault ? safeFailureReason(error.reason) : null
      });
    }
  });
}

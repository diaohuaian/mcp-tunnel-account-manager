import { missingReferenceDisposition } from './work-item-routing.mjs';

/** Trusted server journal/proof only. Never pass client-supplied effect flags. */
export function decideRecoveryAcknowledgement({
  action, gateActionId, evidence, otherAttentionIds
}) {
  const deny = code => ({ allowed: false, code, clearGate: false });
  if (!action || typeof action.id !== 'string' || action.id !== gateActionId) {
    return deny('RECOVERY_SCOPE_MISMATCH');
  }
  if (action.state !== 'NEEDS_ATTENTION') return deny('ACTION_NOT_AWAITING_RECOVERY');
  if (!['NOT_FOUND', 'LIFECYCLE_ACTION_NOT_FOUND', 'SWITCH_OPERATION_NOT_FOUND',
        'WORK_ITEM_NOT_FOUND', 'PROFILE_NOT_FOUND', 'SERVICE_NOT_FOUND'].includes(action.errorCode)) {
    return deny('RECOVERY_REQUIRES_REVIEW');
  }
  if (missingReferenceDisposition(evidence) !== 'REJECTED') {
    return deny('RECOVERY_EFFECTS_UNVERIFIED');
  }
  if (!Array.isArray(otherAttentionIds) || otherAttentionIds.some(x => typeof x !== 'string')) {
    return deny('RECOVERY_GATE_SET_UNVERIFIED');
  }
  const remaining = otherAttentionIds.filter(id => id !== action.id);
  return {
    allowed: true,
    code: remaining.length ? 'ACTION_ACKNOWLEDGED_GATE_RETAINED' : 'ZERO_EFFECT_ACTION_ACKNOWLEDGED',
    nextState: 'REJECTED',
    clearGate: remaining.length === 0,
    remainingAttentionIds: remaining
  };
}

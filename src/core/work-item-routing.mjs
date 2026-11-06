/**
 * All fields are supplied by trusted queue/storage adapters before effects.
 * Durable-record existence must not be inferred from IDs or action names.
 */
export function classifyQueuedWork({ queueKind = null, lifecycleExists, switchExists }) {
  const error = code => {
    const e = new Error(code);
    e.code = code;
    e.stage = 'PRE_EFFECT_DISPATCH';
    e.mayMutate = false;
    throw e;
  };
  if (typeof lifecycleExists !== 'boolean' || typeof switchExists !== 'boolean') {
    return error('WORK_ITEM_LOOKUP_UNVERIFIED');
  }
  if (queueKind !== null && !['lifecycle', 'switch'].includes(queueKind)) {
    return error('INVALID_WORK_KIND');
  }
  if (lifecycleExists && switchExists) return error('WORK_ITEM_KIND_CONFLICT');
  if (queueKind === 'lifecycle') {
    if (!lifecycleExists) return error('LIFECYCLE_ACTION_NOT_FOUND');
    return 'lifecycle';
  }
  if (queueKind === 'switch') {
    if (!switchExists) return error('SWITCH_OPERATION_NOT_FOUND');
    return 'switch';
  }
  if (lifecycleExists) return 'lifecycle';
  if (switchExists) return 'switch';
  return error('WORK_ITEM_NOT_FOUND');
}

/** A missing-reference error is harmless ONLY with explicit pre-effect evidence. */
export function missingReferenceDisposition(evidence) {
  const preEffect = new Set(['QUEUED', 'PREPARING', 'VALIDATING', 'PRE_EFFECT_DISPATCH']);
  if (!evidence || !preEffect.has(evidence.phase)) return 'NEEDS_ATTENTION';
  for (const k of ['mayMutate', 'intentWritten', 'processEffectObserved',
    'configChanged', 'rollbackUncertain']) {
    if (evidence[k] !== false) return 'NEEDS_ATTENTION';
  }
  return 'REJECTED';
}

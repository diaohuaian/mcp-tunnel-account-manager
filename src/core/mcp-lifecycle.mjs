import { assertStoppedConnectionReceipt } from './mcp-registry-policy.mjs';

export const TERMINAL_STOP_STATES = new Set(['SUCCEEDED', 'REJECTED', 'NEEDS_ATTENTION']);

function safeCode(err, defaultCode = 'STOP_FAILED') {
  if (err && typeof err.code === 'string' && /^[A-Z_]{1,48}$/.test(err.code)) {
    return err.code;
  }
  return defaultCode;
}

async function getPublicAction(repo, actionId) {
  if (typeof repo.publicAction === 'function') {
    return await repo.publicAction(actionId);
  }
  if (typeof repo.publicOperation === 'function') {
    return await repo.publicOperation(actionId);
  }
  if (typeof repo.loadAction === 'function') {
    return await repo.loadAction(actionId);
  }
  return await repo.load(actionId);
}

async function markAttention(repo, actionId, code) {
  if (typeof repo.markActionAttention === 'function') {
    return await repo.markActionAttention(actionId, code);
  }
  if (typeof repo.transitionAction === 'function') {
    return await repo.transitionAction(actionId, { state: 'NEEDS_ATTENTION', errorCode: code });
  }
  if (typeof repo.finishRollback === 'function') {
    return await repo.finishRollback(actionId, 'NEEDS_ATTENTION');
  }
  if (typeof repo.phase === 'function') {
    return await repo.phase(actionId, 'NEEDS_ATTENTION', code);
  }
}

async function markRejected(repo, actionId, code) {
  if (typeof repo.transitionAction === 'function') {
    return await repo.transitionAction(actionId, { state: 'REJECTED', errorCode: code });
  }
  if (typeof repo.phase === 'function') {
    return await repo.phase(actionId, 'REJECTED', code);
  }
}

async function finishSuccess(repo, actionId, receipt) {
  if (typeof repo.finishStoppedAction === 'function') {
    return await repo.finishStoppedAction(actionId, receipt);
  }
  if (typeof repo.transitionAction === 'function') {
    return await repo.transitionAction(actionId, { state: 'SUCCEEDED', receipt });
  }
  if (typeof repo.commitSuccess === 'function') {
    return await repo.commitSuccess(actionId);
  }
}

/**
 * Runs a single stop connection action for an MCP service.
 * Follows strict state machine transitions and audit receipts:
 * QUEUED -> APPLYING -> adapter.stopConnection -> receipt verification -> SUCCEEDED.
 *
 * @param {object} params
 * @param {object} params.repo - Store repository
 * @param {Function|object} params.adapterProvider - Provider returning adapter for (opLike, serviceId)
 * @param {string} params.actionId - Identifier of the stop action
 * @returns {Promise<object>} Public action DTO
 */
export async function runMcpStopAction({ repo, adapterProvider, actionId }) {
  if (!repo || typeof repo !== 'object') {
    throw new TypeError('A valid repo object is required to run stop action');
  }
  if (!actionId || typeof actionId !== 'string') {
    throw new TypeError('A valid actionId is required to run stop action');
  }

  const action = typeof repo.loadAction === 'function'
    ? await repo.loadAction(actionId)
    : await repo.load(actionId);

  if (!action) {
    throw new Error(`Stop action ${actionId} not found`);
  }

  const opId = action.operationId || action.id || actionId;
  const state = action.state || action.status;

  // 1. Checks if action is already in terminal state (SUCCEEDED, REJECTED, NEEDS_ATTENTION), returning public action
  if (TERMINAL_STOP_STATES.has(state)) {
    return await getPublicAction(repo, actionId);
  }

  // 2. Interrupted crash recovery: if action is already non-QUEUED (e.g. APPLYING), side-effects are uncertain -> NEEDS_ATTENTION
  if (state !== 'QUEUED') {
    await markAttention(repo, actionId, 'INTERRUPTED');
    return await getPublicAction(repo, actionId);
  }

  let sideEffectsInitiated = false;
  try {
    // 3. Persist APPLYING intent state
    if (typeof repo.transitionAction === 'function') {
      await repo.transitionAction(actionId, { state: 'APPLYING' });
    } else if (typeof repo.phase === 'function') {
      await repo.phase(actionId, 'APPLYING');
    }

    if (!action.serviceId) {
      const err = new Error('Missing serviceId');
      err.code = 'INVALID_TARGETS';
      throw err;
    }

    const opLike = {
      operationId: opId,
      id: opId,
      ...action
    };

    // 4. Resolve adapter from adapterProvider(opLike, action.serviceId)
    let adapter = null;
    if (typeof adapterProvider === 'function') {
      adapter = await adapterProvider(opLike, action.serviceId);
    } else if (adapterProvider && typeof adapterProvider === 'object') {
      if (typeof adapterProvider.getAdapter === 'function') {
        adapter = await adapterProvider.getAdapter(opLike, action.serviceId);
      } else {
        adapter = adapterProvider[action.serviceId];
      }
    }

    if (!adapter || typeof adapter.stopConnection !== 'function') {
      const err = new Error(`Adapter for ${action.serviceId} is unavailable`);
      err.code = 'MCP_ADAPTER_UNAVAILABLE';
      throw err;
    }

    // 5. Calls adapter.stopConnection
    sideEffectsInitiated = true;
    const receipt = await adapter.stopConnection({
      operationId: opId,
      serviceId: action.serviceId,
      originalRuntime: action.originalRuntime
    });

    // 6. Verifies receipt with assertStoppedConnectionReceipt
    assertStoppedConnectionReceipt(receipt, opId, action.serviceId);

    // 7. Finishes stop action via repo.finishStoppedAction
    await finishSuccess(repo, actionId, receipt);

    return await getPublicAction(repo, actionId);
  } catch (err) {
    const code = safeCode(err, sideEffectsInitiated ? 'STOP_FAILED' : 'STOP_REJECTED');
    if (sideEffectsInitiated) {
      // Interrupted, uncertain, or unconfirmed receipt -> NEEDS_ATTENTION
      await markAttention(repo, actionId, code);
    } else {
      // Failure occurred cleanly before side-effects -> REJECTED
      await markRejected(repo, actionId, code);
    }
    return await getPublicAction(repo, actionId);
  }
}

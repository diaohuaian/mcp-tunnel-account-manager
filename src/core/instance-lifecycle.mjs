/**
 * Instance-scoped tunnel-client lifecycle (start / stop / restart for ONE account).
 *
 * Mirrors `runMcpLifecycleAction` in `./mcp-lifecycle.mjs` (same phases, same
 * rejection/attention/success bookkeeping, same adapter surface) but is keyed by
 * the composite `instanceId` instead of a whole MCP service, so several profiles
 * of one service can run concurrently.
 *
 * Hard invariants:
 *  - NEVER mutates the legacy `active_profiles` pointer. That pointer belongs to
 *    the single-active hot-switch path (`switch-core.mjs` / `commitSuccess`).
 *  - A running SIBLING profile never blocks this instance's action. Siblings are
 *    fed to `decideInstanceAction` as informational context only.
 *  - All store/adapters dependencies are feature-detected: a store that has not
 *    been migrated yet degrades to no-op persistence instead of throwing.
 */

import fs from 'node:fs';
import { assertStoppedConnectionReceipt } from './mcp-registry-policy.mjs';
import { assertVerifiedReceipt } from './switch-core.mjs';
import { verifyCarrierConfirmation } from './carrier-confirmation.mjs';
import { missingReferenceDisposition } from './work-item-routing.mjs';
import { isProcessAlive } from './process-liveness.mjs';
import {
  decideInstanceAction,
  publicInstanceDTO,
  buildInstanceId,
  InstanceFault
} from './concurrent-instances.mjs';

export const TERMINAL_INSTANCE_STATES = new Set(['SUCCEEDED', 'REJECTED', 'NEEDS_ATTENTION']);
export const TERMINAL_ACTION_STATES = TERMINAL_INSTANCE_STATES;

function safeCode(err, defaultCode = 'ACTION_FAILED') {
  if (err && typeof err.code === 'string' && /^[A-Z_]{1,48}$/.test(err.code)) {
    return err.code;
  }
  if (err instanceof InstanceFault) return err.code;
  return defaultCode;
}

/** Extra codes produced only by the instance layer; always allowed through. */
export const INSTANCE_LIFECYCLE_CODES = Object.freeze([
  'INSTANCE_ADAPTER_UNAVAILABLE',
  'INSTANCE_ISOLATION_UNVERIFIED'
]);

/**
 * PRODUCTION RED LINE: an instance action may ONLY drive a genuinely
 * instance-scoped adapter. A legacy whole-service `ServiceAdapter` has no
 * `instanceId` and its `configPath` is the production
 * `%APPDATA%\tunnel-client\<service>.yaml`; driving it from here would rewrite
 * production YAML and could disturb live tunnels.
 */
function isInstanceScopedAdapter(adapter, instanceId) {
  return Boolean(adapter) &&
    typeof adapter.instanceId === 'string' && adapter.instanceId === instanceId &&
    typeof adapter.prepare === 'function' &&
    typeof adapter.applyIfUnchanged === 'function';
}

function normalizeForCompare(value) {
  return String(value || '').replace(/[\\/]+/g, '/').toLowerCase().replace(/\/+$/, '');
}

/**
 * Verifies the adapter writes ONLY inside the isolated instance profile dir.
 * Accepted evidence, in order:
 *   - adapter.profileDir (InstanceAdapter exposes it directly);
 *   - adapter.dataDir  -> `<dataDir>/instances/profiles`;
 *   - adapter.configPath inside `<...>/instances/profiles`.
 * A configPath outside any isolated profile dir is refused.
 */
function assertInstanceIsolation(adapter) {
  const configPath = normalizeForCompare(adapter?.configPath);
  if (!configPath) return true; // no config file surface => nothing to isolate

  const candidates = [];
  if (typeof adapter?.profileDir === 'string' && adapter.profileDir) {
    candidates.push(adapter.profileDir);
  }
  if (typeof adapter?.dataDir === 'string' && adapter.dataDir) {
    candidates.push(`${adapter.dataDir.replace(/[\\/]+$/, '')}/instances/profiles`);
  }
  if (candidates.length === 0) return false;

  for (const dir of candidates) {
    const base = normalizeForCompare(dir);
    if (!base) continue;
    if (configPath === base || configPath.startsWith(`${base}/`)) return true;
  }
  return false;
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

async function finishSuccess(repo, actionId, receipt, meta = {}) {
  if (typeof repo.finishLifecycleAction === 'function') {
    return await repo.finishLifecycleAction(actionId, receipt, meta);
  }
  if (typeof repo.registry?.finishLifecycleAction === 'function') {
    return await repo.registry.finishLifecycleAction(actionId, receipt, meta);
  }
  if (typeof repo.finishStoppedAction === 'function') {
    return await repo.finishStoppedAction(actionId, receipt);
  }
  if (typeof repo.registry?.finishStoppedAction === 'function') {
    return await repo.registry.finishStoppedAction(actionId, receipt);
  }
  if (typeof repo.transitionAction === 'function') {
    return await repo.transitionAction(actionId, { state: 'SUCCEEDED', receipt });
  }
  if (typeof repo.commitSuccess === 'function') {
    return await repo.commitSuccess(actionId);
  }
}

async function loadActionRecord(repo, actionId) {
  if (typeof repo.loadAction === 'function') return await repo.loadAction(actionId);
  if (typeof repo.registry?.loadAction === 'function') return await repo.registry.loadAction(actionId);
  return await repo.load(actionId);
}

/** Best-effort instance runtime persistence; never fails the action. */
async function persistInstanceRuntime(repo, instanceId, patch) {
  if (!instanceId) return null;
  try {
    if (typeof repo.upsertInstanceRuntime === 'function') {
      return await repo.upsertInstanceRuntime(instanceId, patch);
    }
    if (typeof repo.registry?.upsertInstanceRuntime === 'function') {
      return await repo.registry.upsertInstanceRuntime(instanceId, patch);
    }
    if (typeof repo.clearInstanceRuntime === 'function' && patch?.state === 'stopped') {
      return await repo.clearInstanceRuntime(instanceId);
    }
  } catch (_) {
    // Persistence of the instance mirror must never break the lifecycle result.
  }
  return null;
}

/** Reads the persisted instance runtime record, feature-detected. */
async function loadInstanceRuntimeRecord(repo, instanceId) {
  try {
    if (typeof repo.getInstanceRuntime === 'function') {
      return await repo.getInstanceRuntime(instanceId);
    }
    if (typeof repo.registry?.getInstanceRuntime === 'function') {
      return await repo.registry.getInstanceRuntime(instanceId);
    }
  } catch (_) {}
  return null;
}

async function listSiblingRunningProfileIds(repo, serviceId, profileId) {
  const self = profileId == null ? null : String(profileId);
  let ids = [];
  try {
    if (typeof repo.listRunningInstanceProfileIds === 'function') {
      ids = await repo.listRunningInstanceProfileIds(serviceId);
    } else if (typeof repo.registry?.listRunningInstanceProfileIds === 'function') {
      ids = await repo.registry.listRunningInstanceProfileIds(serviceId);
    }
  } catch (_) {
    ids = [];
  }
  if (!Array.isArray(ids)) return [];
  return ids.filter(id => typeof id === 'string' && id !== self);
}

/**
 * Pending operation lookup restricted to the SAME instance.
 * A legacy whole-service action (no instanceId) still conflicts, exactly like the
 * registry's own `getActiveActionForService` instance-awareness rule.
 */
async function findPendingOperationId(repo, serviceId, instanceId, opId, actionId) {
  const isSameTarget = (candidate) => {
    if (!candidate) return false;
    const candidateInstance = candidate.instanceId || candidate.instance_id || null;
    if (!candidateInstance) return true; // legacy whole-service action
    return candidateInstance === instanceId;
  };

  const registry = repo?.registry;
  for (const source of [registry, repo]) {
    if (!source || typeof source !== 'object') continue;
    if (typeof source.getActiveActionForInstance === 'function') {
      try {
        const found = await source.getActiveActionForInstance(serviceId, instanceId, opId);
        if (found) return found;
      } catch (_) {}
    }
  }

  // Generic fallbacks: collect pending ids, load each, filter to the same instance.
  const listers = [
    () => repo?.registry?.listPendingActionIds?.(),
    () => repo?.listPendingActionIds?.(),
    () => repo?.registry?.getWorkQueue?.(),
    () => repo?.getWorkQueue?.()
  ];
  const loaders = [
    (id) => repo?.registry?.loadAction?.(id),
    (id) => repo?.loadAction?.(id)
  ];

  for (const list of listers) {
    let pendingIds;
    try {
      pendingIds = await list();
    } catch (_) {
      continue;
    }
    if (!Array.isArray(pendingIds)) continue;
    for (const raw of pendingIds) {
      const id = typeof raw === 'string' ? raw : (raw?.id || raw?.operationId);
      if (!id || id === opId || id === actionId) continue;
      for (const load of loaders) {
        let pendingAct = null;
        try {
          pendingAct = await load(id);
        } catch (_) {
          continue;
        }
        if (!pendingAct) continue;
        const pendingState = pendingAct.state || pendingAct.status;
        const executing = pendingState === 'APPLYING';
        if (!executing) continue;
        if (pendingAct.serviceId && pendingAct.serviceId !== serviceId) continue;
        // Same instance (or legacy action with no instance scope) => genuine conflict.
        if (isSameTarget(pendingAct) && pendingAct.id !== opId) {
          return pendingAct.id || id;
        }
      }
    }
  }
  return null;
}

async function resolveAdapter(adapterProvider, opLike, serviceId, profileId) {
  if (typeof adapterProvider === 'function') {
    try {
      // Instance provider signature: (op, serviceId, profileId)
      return await adapterProvider(opLike, serviceId, profileId);
    } catch (_) {
      return null;
    }
  }
  if (adapterProvider && typeof adapterProvider === 'object') {
    if (typeof adapterProvider.getAdapter === 'function') {
      try {
        return await adapterProvider.getAdapter(opLike, serviceId, profileId);
      } catch (_) {
        return null;
      }
    }
    if (adapterProvider[serviceId]) return adapterProvider[serviceId];
  }
  return null;
}

function readJsonFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function positiveIntOrNull(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Derives a bounded local port from a health URL, without leaking the URL path.
 * Returns null when it cannot be determined safely.
 */
function portFromHealthURL(healthURL) {
  if (typeof healthURL !== 'string' || !healthURL) return null;
  try {
    const parsed = new URL(healthURL);
    const port = Number.parseInt(parsed.port, 10);
    return Number.isSafeInteger(port) && port > 0 && port <= 65535 ? port : null;
  } catch (_) {
    return null;
  }
}

/**
 * Runs one instance-scoped tunnel-client lifecycle action.
 *
 * @param {object} params
 * @param {object} params.repo - Store repository (instance methods feature-detected)
 * @param {Function|object} params.adapterProvider - `(opLike, serviceId, profileId) => InstanceAdapter`
 * @param {string} params.actionId - Queued action id (`act_...`)
 * @param {object} [params.vault] - Vault for carrier confirmation tokens
 * @returns {Promise<object>} Public action DTO
 */
export async function runInstanceLifecycleAction({ repo, adapterProvider, actionId, vault, resourcePolicy = null } = {}) {
  if (!repo || typeof repo !== 'object') {
    throw new TypeError('A valid repo object is required to run instance lifecycle action');
  }
  if (!actionId || typeof actionId !== 'string') {
    throw new TypeError('A valid actionId is required to run instance lifecycle action');
  }

  const action = await loadActionRecord(repo, actionId);
  if (!action) {
    throw new Error(`Instance lifecycle action ${actionId} not found`);
  }

  const opId = action.operationId || action.id || actionId;
  const state = action.state || action.status;
  const actionKind = action.kind || action.action || 'stop';

  // 1. Terminal actions are immutable.
  if (TERMINAL_ACTION_STATES.has(state)) {
    return await getPublicAction(repo, actionId);
  }

  // 2. Crash recovery: non-QUEUED state means side effects are uncertain.
  if (state !== 'QUEUED') {
    await markAttention(repo, actionId, 'INTERRUPTED');
    return await getPublicAction(repo, actionId);
  }

  // 3. An instance action MUST carry an instance id.
  const rawInstanceId = action.instanceId || action.instance_id || action.carrierContext?.instanceId || null;
  if (!rawInstanceId || typeof rawInstanceId !== 'string') {
    await markRejected(repo, actionId, 'INVALID_INSTANCE');
    return await getPublicAction(repo, actionId);
  }
  if (!action.serviceId) {
    await markRejected(repo, actionId, 'INVALID_SERVICE');
    return await getPublicAction(repo, actionId);
  }
  const profileId = action.profileId == null ? null : String(action.profileId);
  if (!profileId) {
    await markRejected(repo, actionId, 'INVALID_PROFILE');
    return await getPublicAction(repo, actionId);
  }

  let instanceId = rawInstanceId;
  try {
    const expected = buildInstanceId(action.serviceId, profileId);
    if (expected !== rawInstanceId) {
      await markRejected(repo, actionId, 'INVALID_INSTANCE');
      return await getPublicAction(repo, actionId);
    }
    instanceId = expected;
  } catch (_) {
    await markRejected(repo, actionId, 'INVALID_INSTANCE');
    return await getPublicAction(repo, actionId);
  }

  /*
   * IDENTITY-ALIASING GUARD (proactive, before any effect).
   *
   * `sanitizeProfileSegment` caps the segment at 64 chars while discovery identities
   * can be 71, so two genuinely DIFFERENT accounts can fold onto the same instanceId.
   * The store refuses to rebind such a row, but `persistInstanceRuntime()` is
   * best-effort and swallows that refusal. The visible symptom was worse than a
   * missing write: the second account's start inspected the SHARED instanceId, saw
   * the first account's verified process, concluded ALREADY_RUNNING, and reported
   * SUCCEEDED while launching nothing — a silent false success for a tunnel that
   * never existed.
   *
   * Refuse loudly instead: if the existing row for this instanceId belongs to a
   * DIFFERENT raw profile id, the caller is addressing an account this id cannot
   * represent. Nothing has mutated at this point, so this is a clean rejection.
   */
  {
    const existing = await loadInstanceRuntimeRecord(repo, instanceId);
    const storedProfileId = existing && existing.profileId != null ? String(existing.profileId) : null;
    if (storedProfileId && storedProfileId !== profileId) {
      await markRejected(repo, actionId, 'INVALID_INSTANCE');
      return await getPublicAction(repo, actionId);
    }
  }

  let sideEffectsInitiated = false;
  let admission = null;
  try {
    const opLike = {
      operationId: opId,
      id: opId,
      instanceId,
      profileId,
      ...action
    };

    const adapter = await resolveAdapter(adapterProvider, opLike, action.serviceId, profileId);

    // PRODUCTION RED LINE: refuse anything that is not this exact instance.
    // A legacy ServiceAdapter (production YAML, no instanceId) must never be
    // driven by an instance action.
    if (!isInstanceScopedAdapter(adapter, instanceId)) {
      await markRejected(repo, actionId, 'INSTANCE_ADAPTER_UNAVAILABLE');
      return await getPublicAction(repo, actionId);
    }

    // The instance adapter must be isolated from the production profile dir.
    if (!assertInstanceIsolation(adapter)) {
      await markRejected(repo, actionId, 'INSTANCE_ISOLATION_UNVERIFIED');
      return await getPublicAction(repo, actionId);
    }

    // --- Server-verified process facts (instance-scoped inspection only) ---
    let inspected = null;
    let inspectError = false;
    if (adapter.processController && typeof adapter.processController.inspect === 'function') {
      try {
        // Instance controllers are already keyed to this instance id.
        inspected = await adapter.processController.inspect(instanceId);
      } catch (_) {
        inspectError = true;
      }
    } else if (typeof adapter.inspect === 'function') {
      try {
        const viaAdapter = await adapter.inspect();
        inspected = viaAdapter && typeof viaAdapter === 'object'
          ? (viaAdapter.process && typeof viaAdapter.process === 'object' ? viaAdapter.process : viaAdapter)
          : null;
      } catch (_) {
        inspectError = true;
      }
    }

    const recordedProc = readJsonFile(adapter.processPath);

    const hasInspectionChannel = Boolean(
      (adapter.processController && typeof adapter.processController.inspect === 'function')
      || typeof adapter.inspect === 'function'
    );

    let inspectionSuccessful = !inspectError && inspected != null && typeof inspected === 'object';

    // Degradation: no observation channel at all (store-only provider). The
    // persisted record is a CLAIM, never an observation, so it may only CONFIRM a
    // live process -- it must never invent one and never assert absence.
    //
    // The previous version trusted `state === 'running'` outright (a dead pid
    // came back as an authoritative `running` observation) and turned
    // `state === 'stopped'` into `running: false`, which the code below reads as
    // `absenceVerified` -- the very proof that unlocks stop/restart without the
    // carrier guard. Both directions are unsafe; an unusable channel now leaves
    // the snapshot unverified.
    if (!inspectionSuccessful && !inspectError && !hasInspectionChannel) {
      const record = await loadInstanceRuntimeRecord(repo, instanceId);
      const recordPid = positiveIntOrNull(record?.pid);
      if (record && record.state === 'running' && recordPid && isProcessAlive(recordPid)
          && typeof adapter.processController?.verify === 'function') {
        let confirmed = false;
        try {
          const verdict = await adapter.processController.verify(record);
          confirmed = verdict?.valid === true;
        } catch (_) {
          confirmed = false;
        }
        if (confirmed) {
          inspected = {
            running: true,
            pid: recordPid,
            startedAt: record.startedAt || null,
            executablePath: record.executablePath || null
          };
          inspectionSuccessful = true;
        }
      }
    }

    const live = Boolean(inspectionSuccessful && inspected.running && positiveIntOrNull(inspected.pid));
    // Ownership requires the persisted runtime record to match the inspected pid.
    const owned = Boolean(live && recordedProc && recordedProc.pid === inspected?.pid);
    let identityVerified = false;
    if (live && owned) {
      if (typeof adapter.processController?.verify === 'function') {
        try {
          const v = await adapter.processController.verify(recordedProc);
          identityVerified = Boolean(v?.valid);
        } catch (_) {
          identityVerified = false;
        }
      } else {
        // No verifier: ownership of the pid is unproven, so the instance must not
        // be treated as a verified `running` target.
        identityVerified = false;
      }
    }

    const recycledPid = Boolean(live && owned && !identityVerified);
    if (recycledPid && typeof adapter._clearProcessRecord === 'function') {
      try { adapter._clearProcessRecord(); } catch (_) {}
    } else if (recycledPid && adapter?.processPath && fs.existsSync(adapter.processPath)) {
      try { fs.unlinkSync(adapter.processPath); } catch (_) {}
    }

    const instanceLive = live && !recycledPid;
    const absenceVerified = Boolean(inspectionSuccessful && (inspected.running === false || recycledPid));

    let snapState = 'unmanaged';
    if (instanceLive) {
      snapState = (owned && identityVerified) ? 'running' : 'unmanaged';
    } else if (absenceVerified) {
      snapState = 'stopped';
    }

    const snapshot = {
      state: snapState,
      owned: instanceLive && owned,
      identityVerified: instanceLive && identityVerified,
      pid: instanceLive ? inspected.pid : null,
      startedAt: instanceLive ? (inspected.startedAt || inspected.startTime || null) : null,
      executablePath: instanceLive ? (inspected.executablePath || inspected.executable || null) : null,
      profileId: recordedProc?.profileId || profileId,
      observedAt: inspectionSuccessful ? Date.now() : 0,
      absenceVerified,
      externalProcessPresent: Boolean(instanceLive && !owned)
    };

    // --- Service definition facts ---
    let serviceDef = null;
    if (repo?.registry && typeof repo.registry.getDefinition === 'function') {
      try { serviceDef = await repo.registry.getDefinition(action.serviceId); } catch (_) {}
    }
    const serviceEnabled = serviceDef ? (serviceDef.enabled !== false) : (action.serviceEnabled ?? true);
    const controlCarrier = serviceDef ? Boolean(serviceDef.controlCarrier) : Boolean(action.controlCarrier);

    // --- Eligible profiles for this service ---
    let eligibleProfileIds = [];
    if (Array.isArray(action.eligibleProfileIds) && action.eligibleProfileIds.length > 0) {
      eligibleProfileIds = action.eligibleProfileIds;
    } else if (typeof repo.listProfiles === 'function') {
      let profiles = [];
      try {
        const got = await repo.listProfiles();
        profiles = Array.isArray(got) ? got : [];
      } catch (_) {
        profiles = [];
      }
      if (typeof repo.hasServiceCredential === 'function') {
        for (const p of profiles) {
          if (p?.id == null) continue;
          let ok = false;
          try {
            ok = Boolean(await repo.hasServiceCredential(p.id, action.serviceId));
          } catch (_) {
            ok = false;
          }
          if (ok) eligibleProfileIds.push(p.id);
        }
      }
      // Fallback: no credential API (or it reported nothing) -> every profile is
      // eligible. The store already rejects unknown profiles at enqueue time.
      if (eligibleProfileIds.length === 0) {
        eligibleProfileIds = profiles.map(p => p?.id).filter(id => id != null);
      }
    }
    // Last resort so a synthetic/legacy repo cannot hard-fail every start:
    // the action itself already names the profile the store validated.
    if (eligibleProfileIds.length === 0) {
      eligibleProfileIds = [profileId];
    }

    // Unknown adapter path (no `paths` on the adapter) must NOT be treated as
    // "binary missing": mirror mcp-lifecycle and only fail on a positive miss.
    const binaryAvailable = adapter?.paths?.tunnelClientBin
      ? fs.existsSync(adapter.paths.tunnelClientBin)
      : true;

    // --- Busy state: SAME instance only (siblings must never block) ---
    const pendingOperationId = await findPendingOperationId(
      repo, action.serviceId, instanceId, opId, actionId
    );

    const siblingRunningProfileIds = await listSiblingRunningProfileIds(
      repo, action.serviceId, profileId
    );

    // --- Carrier confirmation (identical semantics to legacy restart/stop) ---
    let carrierConfirmationVerified = false;
    if (controlCarrier) {
      if (vault && typeof vault.unseal === 'function' && action.carrierToken) {
        const freshProcIdentity = live ? {
          pid: inspected.pid,
          startedAt: inspected.startedAt || inspected.startTime || recordedProc?.startedAt,
          executablePath: inspected.executablePath || inspected.executable || recordedProc?.executablePath || recordedProc?.executable,
          verified: identityVerified
        } : null;

        const sessionBinding = action.carrierContext?.sessionBinding || action.sessionBinding;
        const idempotencyKey = action.carrierContext?.idempotencyKey || action.idempotencyKey;
        const serviceRevision = serviceDef?.revision
          || action.carrierContext?.serviceRevision
          || 1;

        const verifyCtx = {
          action: actionKind,
          serviceId: action.serviceId,
          serviceRevision,
          profileId,
          sessionBinding,
          idempotencyKey,
          identity: freshProcIdentity,
          absenceVerified
        };

        try {
          carrierConfirmationVerified = await verifyCarrierConfirmation(vault, action.carrierToken, verifyCtx);
        } catch (_) {
          carrierConfirmationVerified = false;
        }
      }
    }

    const ctx = {
      serviceId: action.serviceId,
      profileId,
      instanceId,
      registeredAdapter: Boolean(adapter),
      pendingOperationId,
      snapshot,
      serviceEnabled,
      controlCarrier,
      carrierConfirmationVerified,
      eligibleProfileIds,
      binaryAvailable,
      siblingRunningProfileIds,
      nowMs: Date.now()
    };

    const decision = decideInstanceAction(actionKind, ctx);

    if (decision.decision === 'reject') {
      await markRejected(repo, actionId, decision.code);
      return await getPublicAction(repo, actionId);
    }

    if (decision.decision === 'busy') {
      // Leave QUEUED so the runner retries after the conflicting action settles.
      return await getPublicAction(repo, actionId);
    }

    if (decision.decision === 'noop') {
      // Converge the instance mirror with the observed truth, then succeed.
      if (decision.code === 'ALREADY_RUNNING') {
        await persistInstanceRuntime(repo, instanceId, {
          serviceId: action.serviceId,
          profileId,
          state: 'running',
          pid: positiveIntOrNull(decision.pid) || snapshot.pid,
          startedAt: snapshot.startedAt,
          executablePath: snapshot.executablePath,
          operationId: null,
          reasonCode: 'process_verified_running',
          // A noop start only happens for a live process whose recorded identity was
          // just verified (decideInstanceAction requires owned+identityVerified).
          owned: true,
          identityVerified: true,
          observedAt: new Date().toISOString()
        });
      } else if (decision.code === 'ALREADY_STOPPED') {
        await persistInstanceRuntime(repo, instanceId, {
          serviceId: action.serviceId,
          profileId,
          state: 'stopped',
          pid: null,
          startedAt: null,
          executablePath: null,
          operationId: null,
          reasonCode: 'process_stopped',
          owned: false,
          identityVerified: false,
          observedAt: new Date().toISOString()
        });
        // Mirror the service-level fix: decideInstanceAction only reaches
        // ALREADY_STOPPED when the snapshot was a TERMINAL_ABSENT state carrying
        // absenceVerified === true, i.e. absence was already proven. Publishing the
        // proof here is what lets the same-tick removal/stop guards and the service
        // observer agree that this instance is genuinely gone instead of keeping a
        // stale `running` cache row alive.
        const noopObs = typeof repo.getObserver === 'function'
          ? repo.getObserver()
          : (typeof repo.registry?.getObserver === 'function' ? repo.registry.getObserver() : null);
        try {
          if (noopObs && typeof noopObs.setTunnelClient === 'function') {
            noopObs.setTunnelClient(instanceId, {
              state: 'stopped',
              managed: true,
              pid: null,
              startedAt: null,
              profileId,
              operationId: null,
              observedAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 90000).toISOString(),
              reasonCode: 'process_stopped',
              lastExitCode: null,
              absenceVerified: true
            });
          }
        } catch (_) {}
      }
      if (typeof repo.transitionAction === 'function') {
        await repo.transitionAction(actionId, { state: 'SUCCEEDED' });
      } else if (typeof repo.phase === 'function') {
        await repo.phase(actionId, 'SUCCEEDED');
      }
      return await getPublicAction(repo, actionId);
    }

    // --- decision === 'enqueue' => execute ---
    //
    // Shared admission before any effect: a restart must be refused BEFORE its
    // old instance is stopped, and a start must be refused before config/intent
    // is written. The reservation is released in the outer finally.
    if ((actionKind === 'start' || actionKind === 'restart') && typeof resourcePolicy?.admitStart === 'function') {
      try {
        admission = await resourcePolicy.admitStart({
          serviceId: action.serviceId,
          carrier: controlCarrier === true,
          kind: actionKind
        });
      } catch (admissionError) {
        await markRejected(repo, actionId, admissionError?.code || 'RESOURCE_ADMISSION_FAILED');
        return await getPublicAction(repo, actionId);
      }
    }

    if (typeof repo.transitionAction === 'function') {
      await repo.transitionAction(actionId, { state: 'APPLYING' });
    } else if (typeof repo.phase === 'function') {
      await repo.phase(actionId, 'APPLYING');
    }

    const obs = typeof repo.getObserver === 'function'
      ? repo.getObserver()
      : (typeof repo.registry?.getObserver === 'function' ? repo.registry.getObserver() : null);

    const nowIso = () => new Date().toISOString();
    const expiresIso = () => new Date(Date.now() + 90000).toISOString();

    if (actionKind === 'stop') {
      // PRODUCTION RED LINE (same guard as the start path): a stop may only ever
      // target a genuinely instance-scoped adapter.
      if (!isInstanceScopedAdapter(adapter, instanceId)
        || typeof adapter.stopConnection !== 'function') {
        const err = new Error(`Instance adapter for ${instanceId} is unavailable`);
        err.code = 'INSTANCE_ADAPTER_UNAVAILABLE';
        throw err;
      }
      sideEffectsInitiated = true;
      const receipt = await adapter.stopConnection({
        operationId: opId,
        serviceId: action.serviceId,
        instanceId,
        profileId,
        originalRuntime: action.originalRuntime
      });
      assertStoppedConnectionReceipt(receipt, opId, action.serviceId);

      if (obs && typeof obs.invalidate === 'function') {
        try { obs.invalidate(instanceId); } catch (_) {}
      }
      if (obs && typeof obs.setTunnelClient === 'function') {
        try {
          obs.setTunnelClient(instanceId, {
            state: 'stopped',
            managed: true,
            pid: null,
            startedAt: null,
            profileId,
            operationId: null,
            observedAt: nowIso(),
            expiresAt: expiresIso(),
            reasonCode: 'process_stopped',
            lastExitCode: null,
            // The receipt was asserted above (assertStoppedConnectionReceipt), so
            // this is a proven absence. Without the flag the ALREADY_STOPPED guard
            // and the removal guard had no production writer to consume.
            absenceVerified: true
          });
        } catch (_) {}
      }

      await persistInstanceRuntime(repo, instanceId, {
        serviceId: action.serviceId,
        profileId,
        state: 'stopped',
        pid: null,
        startedAt: null,
        executablePath: null,
        healthURL: null,
        localPort: null,
        operationId: null,
        reasonCode: 'process_stopped',
        owned: false,
        identityVerified: false,
        observedAt: nowIso()
      });

      await finishSuccess(repo, actionId, receipt, { action: 'stop', instanceId, profileId });
      return await getPublicAction(repo, actionId);
    }

    // start | restart
    if (!isInstanceScopedAdapter(adapter, instanceId)) {
      const err = new Error(`Instance adapter for ${instanceId} is unavailable`);
      err.code = 'INSTANCE_ADAPTER_UNAVAILABLE';
      throw err;
    }
    if (!assertInstanceIsolation(adapter)) {
      const err = new Error(`Instance adapter for ${instanceId} is not isolated`);
      err.code = 'INSTANCE_ISOLATION_UNVERIFIED';
      throw err;
    }

    let credential = null;
    if (typeof repo.getProfileCredentials === 'function') {
      credential = await repo.getProfileCredentials(profileId, action.serviceId);
    } else if (typeof repo.rawCredentials === 'function') {
      const raw = await repo.rawCredentials(profileId);
      credential = raw?.[action.serviceId] || null;
    }
    if (!credential && action.credential) {
      credential = action.credential;
    }

    const preparedSnap = await adapter.prepare({
      operationId: opId,
      credential,
      profileId,
      instanceId
    });

    // Restart of a live, verified owned process: stop ONLY this instance first.
    if (actionKind === 'restart' && live && recordedProc) {
      if (!adapter?.processController || typeof adapter.processController.stop !== 'function') {
        const err = new Error(`Process controller for ${instanceId} is unavailable`);
        err.code = 'MCP_PROCESS_CONTROLLER_UNAVAILABLE';
        throw err;
      }
      sideEffectsInitiated = true;
      await adapter.processController.stop(recordedProc);
    }

    sideEffectsInitiated = true;
    await adapter.applyIfUnchanged({ operationId: opId, snapshot: preparedSnap });

    let receipt = { started: true, operationId: opId, service: action.serviceId, instanceId };
    if (typeof adapter.verifyDesired === 'function') {
      receipt = await adapter.verifyDesired({ operationId: opId, snapshot: preparedSnap });
      assertVerifiedReceipt(receipt, opId, action.serviceId, preparedSnap);
    }

    const identity = receipt?.identity || preparedSnap?.identity || {};
    const observedPid = positiveIntOrNull(identity.pid) || positiveIntOrNull(receipt?.pid) || null;
    const observedStartedAt = identity.startedAt || identity.startTime || null;
    const observedExecutablePath = identity.executablePath || identity.executable || null;
    const healthURL = typeof preparedSnap?.healthURL === 'string'
      ? preparedSnap.healthURL
      : (typeof receipt?.healthURL === 'string' ? receipt.healthURL : null);
    const localPort = positiveIntOrNull(receipt?.localPort)
      || positiveIntOrNull(preparedSnap?.localPort)
      || portFromHealthURL(healthURL);

    if (obs && typeof obs.invalidate === 'function') {
      try { obs.invalidate(instanceId); } catch (_) {}
    }
    if (obs && typeof obs.setTunnelClient === 'function') {
      try {
        obs.setTunnelClient(instanceId, {
          state: 'running',
          managed: true,
          // Mirrors the persisted instance_runtime evidence so the HTTP overlay and
          // the store agree about whether this process may be stopped/restarted.
          owned: true,
          identityVerified: true,
          pid: observedPid,
          startedAt: observedStartedAt || nowIso(),
          profileId,
          operationId: opId,
          observedAt: nowIso(),
          expiresAt: expiresIso(),
          reasonCode: 'process_verified_running',
          lastExitCode: null,
          // A verified-running client is the opposite of absence.
          absenceVerified: false
        });
      } catch (_) {}
    }

    await persistInstanceRuntime(repo, instanceId, {
      serviceId: action.serviceId,
      profileId,
      state: 'running',
      pid: observedPid,
      startedAt: observedStartedAt,
      executablePath: observedExecutablePath,
      healthURL,
      localPort,
      // The per-instance profile YAML this instance actually binds. Recorded only
      // from a genuinely isolated adapter (already asserted above), so the UI can
      // show which isolated profile file backs each account without ever exposing
      // the production %APPDATA% profile.
      profileYamlPath: typeof adapter.configPath === 'string' ? adapter.configPath : null,
      operationId: opId,
      reasonCode: 'process_verified_running',
      // We launched this process and its receipt passed assertVerifiedReceipt above,
      // so ownership and identity are established facts, not guesses. Persisting them
      // is what lets the UI offer stop/restart for this row.
      owned: true,
      identityVerified: true,
      observedAt: nowIso()
    });

    await finishSuccess(repo, actionId, receipt, { action: actionKind, instanceId, profileId });
    return await getPublicAction(repo, actionId);
  } catch (err) {
    const code = safeCode(err, sideEffectsInitiated ? 'ACTION_FAILED' : 'ACTION_REJECTED');

    // Isolation faults are ALWAYS hard rejections: nothing was allowed to mutate,
    // and they must surface verbatim in the public DTO.
    if (INSTANCE_LIFECYCLE_CODES.includes(code)) {
      await markRejected(repo, actionId, code);
      return await getPublicAction(repo, actionId);
    }

    const evidence = {
      phase: sideEffectsInitiated ? 'APPLYING' : 'PREPARING',
      mayMutate: sideEffectsInitiated,
      intentWritten: false,
      processEffectObserved: false,
      configChanged: false,
      rollbackUncertain: sideEffectsInitiated
    };
    const disposition = missingReferenceDisposition(evidence);
    if (disposition === 'REJECTED') {
      await markRejected(repo, actionId, code);
    } else {
      await markAttention(repo, actionId, code);
    }
    return await getPublicAction(repo, actionId);
  } finally {
    if (admission && typeof resourcePolicy?.release === 'function') {
      try { resourcePolicy.release(admission); } catch (_) {}
    }
  }
}

/**
 * Public DTO for one instance, derived from a stored runtime record.
 * Never returns raw tunnel ids; `maskedTunnelId` must be pre-masked by the store.
 */
export function instanceRuntimeDto(record = {}) {
  return publicInstanceDTO(record);
}

export default runInstanceLifecycleAction;

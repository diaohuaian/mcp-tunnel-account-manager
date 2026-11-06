import test from 'node:test';
import assert from 'node:assert/strict';
import { executeOperation, orderedTargets, SwitchFault, safeFailureReason } from '../../src/core/switch-core.mjs';

function fixture({failApply, failVerify, drift, crashStatus, lostCommitAck, verification, restoration} = {}) {
  const effects = [], steps = new Map();
  const snapshot = {desiredFingerprint:'a'.repeat(64), originalFingerprint:'b'.repeat(64)};
  const op = {status: crashStatus ?? 'QUEUED', targets: ['antigravity-mcp', 'overleaf-mcp']};
  if (crashStatus) steps.set('overleaf-mcp', {mayHaveMutated:true});
  const repo = {
    load: async () => ({...op}),
    publicOperation: async () => ({...op}),
    phase: async (_, status, failureCode, diagnostic) => {
      op.status = status;
      if (failureCode) op.failureCode = failureCode;
      if (diagnostic) {
        op.failureService = diagnostic.service;
        op.failureReason = diagnostic.reason;
      }
    },
    begin: async () => {op.status = 'PREPARING';},
    pinnedCredential: async () => ({}),
    prepared: async (_, s) => {steps.set(s, {});},
    markMayMutate: async (_, s) => {steps.get(s).mayHaveMutated = true;},
    unsealSnapshot: async () => snapshot,
    applied: async () => {},
    commitSuccess: async () => {op.status = 'SUCCEEDED'; if (lostCommitAck) throw Error('ack');},
    step: async (_, s) => steps.get(s),
    restored: async () => {},
    restoreFailed: async () => {},
    finishRollback: async (_, status) => {op.status = status;}
  };
  const adapters = Object.fromEntries(['overleaf-mcp', 'antigravity-mcp'].map(s => [s, {
    prepare: async () => snapshot,
    applyIfUnchanged: async () => {effects.push('apply:' + s); if (failApply === s) throw Error('private-key-in-error');},
    verifyDesired: async ({operationId}) => {
      if (failVerify === s) throw Error('verify');
      const receipt = {verified:true, operationId, service:s, configFingerprint:snapshot.desiredFingerprint,
        identity:{pid:42,startedAt:'2026-11-04T00:00:00Z',executable:'fake-tunnel.exe'},
        proof:{kind:'authenticated-control-plane'}};
      return verification ? verification(receipt) : receipt;
    },
    restoreIfOwned: async ({operationId}) => {
      effects.push('restore:' + s);
      if (drift === s) throw Error('drift');
      const receipt = {restored:true,runtimeRestored:true,operationId,service:s,
        configFingerprint:snapshot.originalFingerprint};
      return restoration ? restoration(receipt) : receipt;
    }
  }]));
  return {effects, op, deps:{repo, adapters, withExclusiveLock: f => f()}};
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}

test('independent strict verifications overlap only after every apply finishes', {timeout: 5000}, async () => {
  const f = fixture();
  const bothStarted = deferred();
  const release = deferred();
  let active = 0;
  for (const adapter of Object.values(f.deps.adapters)) {
    const verify = adapter.verifyDesired;
    adapter.verifyDesired = async args => {
      assert.deepEqual(f.effects, ['apply:overleaf-mcp', 'apply:antigravity-mcp']);
      if (++active === 2) bothStarted.resolve();
      await release.promise;
      const receipt = await verify(args);
      active--;
      return receipt;
    };
  }
  const operation = executeOperation('x', f.deps);
  try {
    await bothStarted.promise;
    assert.equal(f.op.status, 'VERIFYING');
    assert.equal(active, 2);
  } finally { release.resolve(); }
  assert.equal((await operation).status, 'SUCCEEDED');
});

test('strict verification fan-out is bounded at three for a larger registry', {timeout: 5000}, async () => {
  const f = fixture();
  const base = f.deps.adapters['overleaf-mcp'];
  const baseVerify = base.verifyDesired;
  const extra = ['mcp_speed_a', 'mcp_speed_b', 'mcp_speed_c', 'mcp_speed_d'];
  f.op.targets.push(...extra);
  f.op.registrySnapshot = {revision: 1, services: f.op.targets.map(id => ({
    id, enabled: true, controlCarrier: id === 'antigravity-mcp'
  }))};
  for (const service of extra) f.deps.adapters[service] = {
    ...base,
    applyIfUnchanged: async () => { f.effects.push('apply:' + service); },
    verifyDesired: async args => ({...await baseVerify(args), service})
  };
  const firstWave = deferred(), release = deferred();
  let active = 0, peak = 0, started = 0;
  for (const adapter of Object.values(f.deps.adapters)) {
    const verify = adapter.verifyDesired;
    adapter.verifyDesired = async args => {
      active++; started++; peak = Math.max(peak, active);
      if (active === 3) firstWave.resolve();
      await release.promise;
      try { return await verify(args); } finally { active--; }
    };
  }
  const operation = executeOperation('x', f.deps);
  try {
    await firstWave.promise;
    assert.equal(started, 3, 'remaining targets must wait for a free worker');
    assert.equal(active, 3);
    assert.equal(f.effects.length, 6, 'all apply mutations remain sequential and complete');
    assert.equal(f.effects.at(-1), 'apply:antigravity-mcp');
  } finally { release.resolve(); }
  assert.equal((await operation).status, 'SUCCEEDED');
  assert.equal(started, 6);
  assert.equal(peak, 3);
});

test('failure drains in-flight verification before rollback and chooses canonical diagnostics', {timeout: 5000}, async () => {
  const f = fixture();
  const firstStarted = deferred(), failed = deferred(), release = deferred();
  let active = 0;
  f.deps.adapters['overleaf-mcp'].verifyDesired = async () => {
    active++;
    firstStarted.resolve();
    await release.promise;
    active--;
    throw new SwitchFault('VERIFY_FAILED', {reason: 'STALE_RUNTIME_EVIDENCE'});
  };
  f.deps.adapters['antigravity-mcp'].verifyDesired = async () => {
    await firstStarted.promise;
    failed.resolve();
    throw new SwitchFault('VERIFY_FAILED', {reason: 'CONTROL_PLANE_NOT_AUTHENTICATED'});
  };
  for (const adapter of Object.values(f.deps.adapters)) {
    const restore = adapter.restoreIfOwned;
    adapter.restoreIfOwned = async args => {
      assert.equal(active, 0, 'restoration must never race a live verifier');
      return restore(args);
    };
  }
  const operation = executeOperation('x', f.deps);
  try {
    await failed.promise;
    await Promise.resolve();
    assert.equal(f.op.status, 'VERIFYING');
    assert.equal(f.effects.some(effect => effect.startsWith('restore:')), false);
  } finally { release.resolve(); }
  const result = await operation;
  assert.equal(result.status, 'ROLLED_BACK');
  assert.equal(result.failureService, 'overleaf-mcp');
  assert.equal(result.failureReason, 'STALE_RUNTIME_EVIDENCE');
  assert.deepEqual(f.effects.slice(2), ['restore:antigravity-mcp', 'restore:overleaf-mcp']);
});

test('canonical order switches the connection-carrying service last', async () => {
  const f=fixture();
  assert.equal((await executeOperation('x', f.deps)).status, 'SUCCEEDED');
  assert.deepEqual(f.effects, ['apply:overleaf-mcp','apply:antigravity-mcp']);
});
test('partially failing service is restored too, in reverse order', async () => {
  const f=fixture({failApply:'antigravity-mcp'});
  assert.equal((await executeOperation('x', f.deps)).status, 'ROLLED_BACK');
  assert.deepEqual(f.effects.slice(2), ['restore:antigravity-mcp','restore:overleaf-mcp']);
});
test('authentication verification failure rolls back both targets', async () => {
  const f=fixture({failVerify:'antigravity-mcp'});
  assert.equal((await executeOperation('x', f.deps)).status, 'ROLLED_BACK');
  assert.equal(f.effects.filter(x=>x.startsWith('restore:')).length,2);
});
test('external drift requires attention and still compensates other service', async () => {
  const f=fixture({failApply:'antigravity-mcp',drift:'antigravity-mcp'});
  assert.equal((await executeOperation('x', f.deps)).status, 'NEEDS_ATTENTION');
  assert.ok(f.effects.includes('restore:overleaf-mcp'));
});
test('startup recovery compensates touched targets without a replay', async () => {
  const f=fixture({crashStatus:'APPLYING'});
  assert.equal((await executeOperation('x', f.deps)).status, 'ROLLED_BACK');
  assert.deepEqual(f.effects, ['restore:overleaf-mcp']);
});
test('lost commit acknowledgement never rolls back durable success', async () => {
  const f=fixture({lostCommitAck:true});
  assert.equal((await executeOperation('x', f.deps)).status, 'SUCCEEDED');
  assert.equal(f.effects.length,2);
});
test('completed operation is safe to invoke again', async () => {
  const f=fixture();
  await executeOperation('x', f.deps); await executeOperation('x', f.deps);
  assert.equal(f.effects.length,2);
});
test('unknown or repeated targets are rejected', () => {
  for(const t of [[], ['other'], ['overleaf-mcp','overleaf-mcp']]) {
    assert.throws(()=>orderedTargets(t));
  }
});

test('undefined verification return can never commit success', async () => {
  const f=fixture({verification:()=>undefined});
  assert.equal((await executeOperation('x',f.deps)).status,'ROLLED_BACK');
});
test('verified false is a failure even if adapter does not throw', async () => {
  const f=fixture({verification:r=>({...r,verified:false})});
  assert.equal((await executeOperation('x',f.deps)).status,'ROLLED_BACK');
});
test('receipt must bind operation, service and desired config fingerprint', async () => {
  for(const change of [{operationId:'other'},{service:'other'},{configFingerprint:'c'.repeat(64)}]) {
    const f=fixture({verification:r=>({...r,...change})});
    assert.equal((await executeOperation('x',f.deps)).status,'ROLLED_BACK');
  }
});
test('PID or TCP-only evidence cannot satisfy authenticated target proof', async () => {
  const f=fixture({verification:r=>({...r,proof:{kind:'tcp-listening'}})});
  assert.equal((await executeOperation('x',f.deps)).status,'ROLLED_BACK');
});
test('verification requires an exact process identity beyond PID', async () => {
  const f=fixture({verification:r=>({...r,identity:{pid:42}})});
  assert.equal((await executeOperation('x',f.deps)).status,'ROLLED_BACK');
});
test('negative or missing restoration receipt blocks future switching', async () => {
  for(const transform of [()=>undefined, r=>({...r,restored:false}),r=>({...r,runtimeRestored:false})]) {
    const f=fixture({failVerify:'antigravity-mcp',restoration:transform});
    assert.equal((await executeOperation('x',f.deps)).status,'NEEDS_ATTENTION');
    assert.equal(f.effects.filter(x=>x.startsWith('restore:')).length,2);
  }
});
test('restoration receipt must match operation, service and original fingerprint', async () => {
  for(const change of [{operationId:'other'},{service:'other'},{configFingerprint:'c'.repeat(64)}]) {
    const f=fixture({failVerify:'antigravity-mcp',restoration:r=>({...r,...change})});
    assert.equal((await executeOperation('x',f.deps)).status,'NEEDS_ATTENTION');
  }
});


test('registered third MCP executes through pinned operation adapter provider', async () => {
  const f=fixture();
  f.op.targets=['mcp_weather'];
  f.op.registrySnapshot={revision:1,services:[{id:'mcp_weather',enabled:true}]};
  const original=f.deps.adapters['overleaf-mcp'];
  f.deps.adapterProvider=async(op,service)=>({
    prepare:args=>original.prepare(args),
    applyIfUnchanged:async()=>{f.effects.push('apply:'+service);},
    verifyDesired:async(args)=>({...await original.verifyDesired(args),service}),
    restoreIfOwned:async(args)=>({...await original.restoreIfOwned(args),service})
  });
  assert.equal((await executeOperation('x',f.deps)).status,'SUCCEEDED');
  assert.deepEqual(f.effects,['apply:mcp_weather']);
});
test('unregistered target cannot become runnable by ID format alone', async () => {
  const f=fixture();f.op.targets=['mcp_unknown'];
  assert.equal((await executeOperation('x',f.deps)).status,'NEEDS_ATTENTION');
  assert.deepEqual(f.effects,[]);
});
test('adapter resolution failure before mutation releases operation safely', async () => {
  const f=fixture();f.deps.adapterProvider=async()=>{throw Error('unavailable');};
  assert.equal((await executeOperation('x',f.deps)).status,'ROLLED_BACK');
  assert.deepEqual(f.effects,[]);
});

test('unavailable local HTTP dependency fails preparation before any service mutates', async () => {
  const f = fixture();
  f.op.targets = ['antigravity-mcp', 'overleaf-mcp', 'mcp_bridge'];
  f.op.registrySnapshot = {revision: 1, services: f.op.targets.map(id => ({id, enabled: true}))};
  f.deps.adapters.mcp_bridge = {
    prepare: async () => { throw new SwitchFault('TARGET_VERIFICATION_UNAVAILABLE', {reason: 'HTTP_UPSTREAM_UNREACHABLE'}); }
  };
  const result = await executeOperation('x', f.deps);
  assert.equal(result.status, 'ROLLED_BACK');
  assert.equal(result.failureCode, 'TARGET_VERIFICATION_UNAVAILABLE');
  assert.equal(result.failureService, 'mcp_bridge');
  assert.equal(result.failureReason, 'HTTP_UPSTREAM_UNREACHABLE');
  assert.deepEqual(f.effects, []);
});

test('typed verification cause identifies the failed service and preserves reverse compensation', async () => {
  const f = fixture();
  f.deps.adapters['antigravity-mcp'].verifyDesired = async () => {
    throw new SwitchFault('VERIFY_FAILED', {reason: 'CONTROL_PLANE_NOT_AUTHENTICATED'});
  };
  const result = await executeOperation('x', f.deps);
  assert.equal(result.status, 'ROLLED_BACK');
  assert.equal(result.failureCode, 'VERIFY_FAILED');
  assert.equal(result.failureService, 'antigravity-mcp');
  assert.equal(result.failureReason, 'CONTROL_PLANE_NOT_AUTHENTICATED');
  assert.deepEqual(f.effects.slice(2), ['restore:antigravity-mcp', 'restore:overleaf-mcp']);
});

test('untyped errors and arbitrary reason strings never become public diagnostics', async () => {
  for (const error of [new Error('Authorization: Bearer private-token'),
    new SwitchFault('VERIFY_FAILED', {reason: 'PRIVATE_TOKEN'}),
    Object.assign(new Error('private-token'), {code: 'VERIFY_FAILED', reason: 'RUNTIME_NOT_READY'})]) {
    const f = fixture();
    f.deps.adapters['overleaf-mcp'].verifyDesired = async () => { throw error; };
    const result = await executeOperation('x', f.deps);
    assert.equal(result.status, 'ROLLED_BACK');
    assert.equal(result.failureService, 'overleaf-mcp');
    assert.equal(result.failureReason, null);
    assert.doesNotMatch(JSON.stringify(result), /private-token|PRIVATE_TOKEN|Authorization/);
  }
  assert.equal(safeFailureReason('runtime_not_ready'), null);
  assert.equal(safeFailureReason({code: 'RUNTIME_NOT_READY'}), null);
});

test('global phase and commit failures are not attributed to the last target', async () => {
  for (const when of ['APPLYING', 'VERIFYING', 'COMMIT']) {
    const f = fixture();
    const phase = f.deps.repo.phase;
    f.deps.repo.phase = async (...args) => {
      if (args[1] === when) throw new SwitchFault('SWITCH_FAILED');
      return phase(...args);
    };
    if (when === 'COMMIT') f.deps.repo.commitSuccess = async () => { throw new SwitchFault('SWITCH_FAILED'); };
    const result = await executeOperation('x', f.deps);
    assert.equal(result.status, 'ROLLED_BACK');
    assert.equal(result.failureService, null);
    assert.equal(result.failureReason, null);
  }
});

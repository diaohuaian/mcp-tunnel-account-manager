import test from 'node:test';
import assert from 'node:assert/strict';
import { executeOperation, orderedTargets } from '../../src/core/switch-core.mjs';

function fixture({failApply, failVerify, drift, crashStatus, lostCommitAck, verification, restoration} = {}) {
  const effects = [], steps = new Map();
  const snapshot = {desiredFingerprint:'a'.repeat(64), originalFingerprint:'b'.repeat(64)};
  const op = {status: crashStatus ?? 'QUEUED', targets: ['antigravity-mcp', 'overleaf-mcp']};
  if (crashStatus) steps.set('overleaf-mcp', {mayHaveMutated:true});
  const repo = {
    load: async () => ({...op}),
    publicOperation: async () => ({...op}),
    phase: async (_, status) => {op.status = status;},
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

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadWorkRecord, withStartupRollback, rollbackOwnedResources,
  SWITCH_TERMINAL_STATES, STOP_TERMINAL_STATES
} from '../../src/core/runner-startup.mjs';

test('synchronous SQLite load retains receiver and returns recoverable operation', async () => {
  const repo = {op: {status:'APPLYING'}, load(id) { assert.equal(this, repo); assert.equal(id, 'op1'); return this.op; }};
  const result = await loadWorkRecord({repo, id:'op1', kind:'switch'});
  assert.equal(result.record, repo.op);
  assert.equal(result.needsRecovery, true);
});
test('asynchronous repository has identical load semantics', async () => {
  const result = await loadWorkRecord({repo:{load:async()=>({status:'QUEUED'})}, id:'op1', kind:'switch'});
  assert.equal(result.queued, true);
  assert.equal(result.needsRecovery, false);
});
test('synchronous storage errors propagate without silently skipping recovery', async () => {
  const failure = new Error('storage-fault');
  await assert.rejects(loadWorkRecord({repo:{load(){throw failure;}},id:'op1',kind:'switch'}), e=>e===failure);
});
test('asynchronous storage errors propagate', async () => {
  const failure = new Error('storage-fault');
  await assert.rejects(loadWorkRecord({repo:{load:async()=>{throw failure;}},id:'op1',kind:'switch'}),e=>e===failure);
});
test('stop loader uses registry receiver rather than switch loader', async () => {
  const registry={loadAction(){assert.equal(this,registry);return {state:'APPLYING'};}};
  const result=await loadWorkRecord({repo:{registry,load(){throw Error('wrong-loader');}},id:'stop1',kind:'stop'});
  assert.equal(result.needsRecovery,true);
});
test('legacy stop loaders on repo and generic load remain supported', async () => {
  for(const repo of [{loadAction:()=>({state:'QUEUED'})},{load:()=>({state:'QUEUED'})}]) {
    assert.equal((await loadWorkRecord({repo,id:'stop1',kind:'stop'})).queued,true);
  }
});
test('terminal and attention records never qualify for re-execution', async () => {
  for(const kind of ['switch','stop']) {
    for(const state of kind==='switch'?SWITCH_TERMINAL_STATES:STOP_TERMINAL_STATES) {
      const result=await loadWorkRecord({repo:{load:()=>({state,status:state})},id:'op1',kind});
      assert.equal(result.terminal,true);assert.equal(result.needsRecovery,false);assert.equal(result.queued,false);
    }
  }
});
test('missing queued record and invalid state fail closed',async()=>{
  for(const [record,code] of [[null,'WORK_RECORD_MISSING'],[{status:'UNKNOWN'},'WORK_STATE_INVALID']]) {
    await assert.rejects(loadWorkRecord({repo:{load:()=>record},id:'op1',kind:'switch'}),{code});
  }
});
test('invalid references and absent loader reject before work',async()=>{
  await assert.rejects(loadWorkRecord({repo:{},id:'op1',kind:'invalid'}),{code:'INVALID_WORK_REFERENCE'});
  await assert.rejects(loadWorkRecord({repo:{},id:'op1',kind:'switch'}),{code:'WORK_LOADER_MISSING'});
});
test('successful startup returns result and retains owned resources',async()=>{
  let releases=0;
  assert.equal(await withStartupRollback(()=>42,()=>{releases++;}),42);
  assert.equal(releases,0);
});
test('both synchronous and asynchronous startup failure await rollback and preserve cause',async()=>{
  for(const asyncStart of [false,true]) {
    const order=[],cause=new Error('startup');
    const start=asyncStart?async()=>{throw cause;}:()=>{throw cause;};
    await assert.rejects(withStartupRollback(start,async()=>{await Promise.resolve();order.push('released');}),e=>e===cause);
    assert.deepEqual(order,['released']);
  }
});
test('resource rollback releases in reverse order despite a failed release',async()=>{
  const seen=[],failure=new Error('release');
  await assert.rejects(rollbackOwnedResources([
    ()=>seen.push('vault'),()=>{seen.push('store');throw failure;},async()=>seen.push('runner')
  ]),e=>e.code==='STARTUP_RESOURCE_RELEASE_FAILED'&&e.errors[0]===failure);
  assert.deepEqual(seen,['runner','store','vault']);
});
test('startup plus cleanup failure preserve both errors and original cause',async()=>{
  const cause=new Error('startup'),cleanupError=new Error('cleanup');
  await assert.rejects(withStartupRollback(()=>{throw cause;},()=>{throw cleanupError;}),e=>
    e.code==='STARTUP_AND_CLEANUP_FAILED'&&e.cause===cause&&e.errors[0]===cause&&e.errors[1]===cleanupError);
});
test('invalid cleanup callbacks cannot start acquiring resources',async()=>{
  let started=false;
  await assert.rejects(withStartupRollback(()=>{started=true;},null),{code:'INVALID_STARTUP_CALLBACKS'});
  assert.equal(started,false);
  await assert.rejects(rollbackOwnedResources([null]),{code:'INVALID_STARTUP_RELEASES'});
});

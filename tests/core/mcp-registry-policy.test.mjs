import test from 'node:test';
import assert from 'node:assert/strict';
import {LEGACY_SERVICES,isMcpServiceId,orderRegisteredTargets,pinRegistrySnapshot,
  removalDecision,assertStoppedConnectionReceipt,mergeEnvironmentPatch,publicEnvironment,discoveryIdentity} from '../../src/core/mcp-registry-policy.mjs';
const third={id:'mcp_weather',enabled:true,sortOrder:200,command:'fake.exe',args:['--stdio']};
const services=[...LEGACY_SERVICES,third];
test('new registered MCP participates and current carrier switches last',()=>{
  assert.deepEqual(orderRegisteredTargets(['antigravity-mcp',third.id,'overleaf-mcp'],services),
    ['overleaf-mcp',third.id,'antigravity-mcp']);
});
test('unknown and deleted registrations cannot be execution targets',()=>{
  assert.throws(()=>orderRegisteredTargets(['mcp_absent'],services),{code:'MCP_NOT_FOUND'});
  assert.throws(()=>orderRegisteredTargets([third.id],[{...third,deletedAt:'now'}]));
});
test('disabled MCP cannot start but can be selected for a stop',()=>{
  const s=[{...third,enabled:false}];
  assert.throws(()=>orderRegisteredTargets([third.id],s),{code:'MCP_DISABLED'});
  assert.deepEqual(orderRegisteredTargets([third.id],s,{mode:'stop'}),[third.id]);
});
test('duplicate requests and ambiguous registry IDs are rejected',()=>{
  assert.throws(()=>orderRegisteredTargets([third.id,third.id],services));
  assert.throws(()=>orderRegisteredTargets([third.id],[third,third]));
});
test('pinned operation snapshot is independent of later definition mutation',()=>{
  const input=structuredClone(services),snap=pinRegistrySnapshot([third.id],{services:input,revision:7},7);
  input[2].args[0]='modified';assert.equal(snap.services[0].args[0],'--stdio');
});
test('stale revision cannot pin new runtime configuration',()=>{
  assert.throws(()=>pinRegistrySnapshot([third.id],{services,revision:8},7),{code:'REVISION_CONFLICT'});
});
test('running, busy or unknown runtime must be resolved before removal',()=>{
  assert.equal(removalDecision({service:third,runtimeState:'running'}).requiredAction,'stop');
  assert.equal(removalDecision({service:third,runtimeState:'stopped',busy:true}).allowed,false);
  assert.equal(removalDecision({service:third,runtimeState:'unknown'}).allowed,false);
});
test('removal archives management record and preserves installation/source files',()=>{
  const d=removalDecision({service:third,runtimeState:'stopped'});
  assert.equal(d.allowed,true);assert.equal(d.preserveInstallation,true);assert.equal(d.preserveSourceFiles,true);
});
test('omitted env patch retains encrypted-store input rather than clearing it',()=>{
  const prev={TOKEN:{value:'synthetic-test-key',secret:true}};
  const next=mergeEnvironmentPatch(prev);
  assert.equal(next.TOKEN.value,prev.TOKEN.value);assert.notEqual(next.TOKEN,prev.TOKEN);
});
test('explicit removal and empty-string value have different meanings',()=>{
  const p={A:{value:'x',secret:false}};
  assert.equal(mergeEnvironmentPatch(p,[{name:'A',op:'set',value:'',secret:false}]).A.value,'');
  assert.equal(mergeEnvironmentPatch(p,[{name:'A',op:'remove'}]).A,undefined);
});
test('new env values default secret; sensitive names cannot be forced public',()=>{
  const e=mergeEnvironmentPatch({},[{name:'CUSTOM',op:'set',value:'private'},
    {name:'API_TOKEN',op:'set',value:'synthetic',secret:false}]);
  assert.ok(publicEnvironment(e).every(v=>v.secret && !Object.hasOwn(v,'value')));
});
test('explicitly public nonsecret environment metadata can be edited/displayed',()=>{
  const e=mergeEnvironmentPatch({},[{name:'PROJECT_DIR',op:'set',value:'C:/example',secret:false}]);
  assert.equal(publicEnvironment(e)[0].value,'C:/example');
});
test('MCP env cannot replace account credentials, health or binding',()=>{
  for(const name of ['CONTROL_PLANE_API_KEY','health_url_file','TUNNEL_ID','MCP_COMMAND'])
    assert.throws(()=>mergeEnvironmentPatch({},[{name,op:'set',value:'x'}]),{code:'RESERVED_ENV_NAME'});
});
test('Windows env case collisions are rejected and prototype names blocked',()=>{
  assert.throws(()=>mergeEnvironmentPatch({},[{name:'FOO',op:'set',value:'x'},{name:'foo',op:'remove'}]));
  assert.throws(()=>mergeEnvironmentPatch({},[{name:'__proto__',op:'set',value:'x'}]));
});
test('discovery identity is stable across Windows path case/separator changes',()=>{
  const a=discoveryIdentity({serviceId:third.id,canonicalPath:'C:\\Users\\Test\\mcp.yaml'});
  const b=discoveryIdentity({serviceId:third.id,canonicalPath:'c:/users/test/mcp.yaml'});
  assert.equal(a,b);
  assert.notEqual(a,discoveryIdentity({serviceId:third.id,canonicalPath:'C:/Users/Test/other.yaml'}));
});
test('service IDs remain path-safe while preserving the two existing IDs',()=>{
  for(const id of ['overleaf-mcp','antigravity-mcp','mcp_abc-123'])assert.equal(isMcpServiceId(id),true);
  for(const id of ['../x','constructor','__proto__','mcp_a/b','mcp_a\\b','mcp_'])assert.equal(isMcpServiceId(id),false);
});
test('stop confirmation binds operation, service and verified owned identity',()=>{
  const r={stopped:true,operationId:'op',service:third.id,proof:{kind:'verified-owned-process-exit'},
    identity:{pid:42,startedAt:'synthetic-start',executable:'fake.exe'}};
  assert.equal(assertStoppedConnectionReceipt(r,'op',third.id),true);
  assert.throws(()=>assertStoppedConnectionReceipt({...r,operationId:'other'},'op',third.id));
  assert.throws(()=>assertStoppedConnectionReceipt({...r,identity:{pid:42}},'op',third.id));
});
test('resolved false, undefined or unproved stop cannot authorize removal',()=>{
  for(const r of [undefined,{stopped:false},{stopped:true,operationId:'op',service:third.id},
    {stopped:true,operationId:'op',service:third.id,proof:{kind:'pid-not-found'}}])
    assert.throws(()=>assertStoppedConnectionReceipt(r,'op',third.id));
});

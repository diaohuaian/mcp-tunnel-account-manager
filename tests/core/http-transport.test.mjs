import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {compileHttpTransport,mergeHttpLaunchEnvironment,clearInheritedMcpOverrides,sealHttpTransport,openHttpTransport,fingerprintHttpConfiguration,HTTP_HEADER_ENV_PREFIX} from '../../src/adapters/http-transport.mjs';
const context={serviceId:'mcp_test',operationId:'op-one'};
const binding={type:'http',url:'https://mcp.example.test/mcp?token=private-url-token&a=b,c',headers:{Authorization:{value:'Bearer private-header'},'X-Test':{value:'env:NOT_A_HOST_LOOKUP'}}};
function syntheticVault(){
  const key=randomBytes(32);
  return {
    seal(value,aad){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(aad));return {iv:iv.toString('hex'),data:Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]).toString('hex'),tag:cipher.getAuthTag().toString('hex')};},
    unseal(packet,aad){const cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(packet.iv,'hex'));cipher.setAAD(Buffer.from(aad));cipher.setAuthTag(Buffer.from(packet.tag,'hex'));return JSON.parse(Buffer.concat([cipher.update(Buffer.from(packet.data,'hex')),cipher.final()]).toString('utf8'));}
  };
}
test('main HTTP endpoint including comma/query uses supported raw env form, never argv',()=>{
  const plan=compileHttpTransport(binding,context);
  assert.equal(plan.privateEnvironment.MCP_SERVER_URL,binding.url);
  assert.doesNotMatch(JSON.stringify(plan.args),/private-url-token|private-header|mcp\.example/);
  assert.equal(plan.channel,'main');
});
test('every header argv is an env reference and all values stay private',()=>{
  const plan=compileHttpTransport(binding,context);
  for(let i=0;i<plan.args.length;i+=2){assert.equal(plan.args[i],'--mcp.extra-headers');assert.match(plan.args[i+1],new RegExp(': env:'+HTTP_HEADER_ENV_PREFIX+'[A-F0-9]{24}$'));}
  assert.deepEqual(Object.values(plan.privateEnvironment).slice(1),['Bearer private-header','env:NOT_A_HOST_LOOKUP']);
});
test('private header references stable for case-equivalent names, isolated per service and operation',()=>{
  const a=compileHttpTransport({type:'http',url:binding.url,headers:{Authorization:'one'}},context);
  const b=compileHttpTransport({type:'http',url:binding.url,headers:{authorization:'two'}},context);
  assert.equal(Object.keys(a.privateEnvironment)[1],Object.keys(b.privateEnvironment)[1]);
  for(const change of [{...context,operationId:'op-two'},{...context,serviceId:'mcp_other'}]) assert.notEqual(Object.keys(a.privateEnvironment)[1],Object.keys(compileHttpTransport({type:'http',url:binding.url,headers:{Authorization:'one'}},change).privateEnvironment)[1]);
});
test('no-header remote MCP is valid',()=>{
  const plan=compileHttpTransport({type:'http',url:'http://127.0.0.1:1234/mcp'},context);
  assert.deepEqual(plan.args,[]);assert.deepEqual(plan.headerNames,[]);
});
test('invalid URL/transport/context rejected without echoing credential values',()=>{
  for(const url of ['', 'file:///secret','https://user:pass@example.test/mcp','https://example.test/#fragment','https://example.test/\r\nx']) assert.throws(()=>compileHttpTransport({type:'http',url},context),{code:'INVALID_HTTP_URL'});
  assert.throws(()=>compileHttpTransport({type:'stdio'},context),{code:'HTTP_BINDING_REQUIRED'});
  assert.throws(()=>compileHttpTransport(binding,{...context,serviceId:'../service'}),{code:'INVALID_HTTP_CONTEXT'});
});
test('duplicate header names and invalid names rejected',()=>{
  for(const headers of [{Authorization:'a',authorization:'b'},{'Bad Header':'a'},{'X\r\nHeader':'b'}]) assert.throws(()=>compileHttpTransport({...binding,headers},context));
});
test('CRLF/NUL/control/empty header values rejected, whitespace normalized like upstream',()=>{
  for(const value of ['','  ','a\r\nb','a\0b','a\x01b']) assert.throws(()=>compileHttpTransport({...binding,headers:{'X-Test':value}},context),{code:'INVALID_HTTP_HEADER_VALUE'});
  const p=compileHttpTransport({...binding,headers:{'X-Test':'  hello\tthere  '}},context);
  assert.equal(Object.values(p.privateEnvironment)[1],'hello\tthere');
});
test('private environment and header count bounded',()=>{
  assert.throws(()=>compileHttpTransport({...binding,headers:Object.fromEntries(Array.from({length:65},(_,i)=>['X-'+i,'a']))},context),{code:'TOO_MANY_HTTP_HEADERS'});
  assert.throws(()=>compileHttpTransport({...binding,headers:{'X-Test':'a'.repeat(17000)}},context),{code:'HTTP_ENV_TOO_LARGE'});
});
test('host transport overrides and stale private headers removed case-insensitively',()=>{
  const p=compileHttpTransport(binding,context);
  const env=mergeHttpLaunchEnvironment({mcp_command:'old',Mcp_Server_Url:'old',MCP_EXTRA_HEADERS:'old',MCP_DISCOVERY_EXTRA_HEADERS:'old',[HTTP_HEADER_ENV_PREFIX.toLowerCase()+'OLD']:'old',PATH:'parent',KEEP:'yes'},{Path:'service'},p);
  assert.equal(env.MCP_SERVER_URL,binding.url);assert.equal(env.mcp_command,undefined);assert.equal(env.MCP_EXTRA_HEADERS,undefined);assert.equal(env.MCP_DISCOVERY_EXTRA_HEADERS,undefined);assert.equal(env.Path,'service');assert.equal(env.PATH,undefined);assert.equal(env.KEEP,'yes');
  assert.equal(Object.keys(env).filter(k=>k.toLowerCase().endsWith('old')).length,0);
});
test('untrusted service env cannot override private transport namespace',()=>{
  const p=compileHttpTransport(binding,context);
  for(const name of ['MCP_SERVER_URL','mcp_command','MCP_EXTRA_HEADERS','MCP_DISCOVERY_EXTRA_HEADERS',HTTP_HEADER_ENV_PREFIX+'X']) assert.throws(()=>mergeHttpLaunchEnvironment({}, {[name]:'override'},p),{code:'RESERVED_HTTP_ENV'});
});
test('sealed transport snapshot persists no plaintext URL or header values and survives JSON/restart',async()=>{
  const vault=syntheticVault(),packet=await sealHttpTransport(vault,binding,context);
  assert.doesNotMatch(JSON.stringify(packet),/private-url-token|private-header|NOT_A_HOST_LOOKUP|mcp\.example/);
  const restored=await openHttpTransport(vault,JSON.parse(JSON.stringify(packet)),context);
  assert.deepEqual(restored,compileHttpTransport(binding,context));
});
test('wrong operation/service and changed envelope cannot restore',async()=>{
  const vault=syntheticVault(),packet=await sealHttpTransport(vault,binding,context);
  for(const other of [{...context,operationId:'op-other'},{...context,serviceId:'mcp_other'}]) await assert.rejects(openHttpTransport(vault,packet,other),{code:'INVALID_HTTP_STATE'});
  const changed=structuredClone(packet),bytes=Buffer.from(changed.environmentEnvelope.data,'hex');bytes[0]^=1;changed.environmentEnvelope.data=bytes.toString('hex');
  await assert.rejects(openHttpTransport(vault,changed,context),{code:'HTTP_STATE_UNREADABLE'});
});
test('header list tampering and injected environment names are rejected',async()=>{
  const vault=syntheticVault(),packet=await sealHttpTransport(vault,binding,context);
  await assert.rejects(openHttpTransport(vault,{...packet,headerNames:[]},context),{code:'INVALID_HTTP_STATE'});
  await assert.rejects(openHttpTransport(vault,{...packet,headerNames:['Authorization','authorization']},context));
  const bad={...packet,environmentEnvelope:vault.seal({MCP_SERVER_URL:binding.url,CONTROL_PLANE_API_KEY:'bad'},JSON.stringify(['mcp-http-transport-v1',context.serviceId,context.operationId]))};
  await assert.rejects(openHttpTransport(vault,bad,context),{code:'INVALID_HTTP_STATE'});
});
test('sync and async vault implementations both supported, missing vault fails closed',async()=>{
  const v=syntheticVault(),asyncVault={seal:async(...args)=>v.seal(...args),unseal:async(...args)=>v.unseal(...args)};
  const packet=await sealHttpTransport(asyncVault,binding,context);
  assert.equal((await openHttpTransport(asyncVault,packet,context)).kind,'http');
  await assert.rejects(sealHttpTransport(null,binding,context),{code:'HTTP_VAULT_REQUIRED'});
});
test('clearing HTTP leftovers for a subsequent stdio launch does not mutate parent env',()=>{
  const parent={MCP_SERVER_URL:binding.url,MCP_COMMAND:'old',OTHER:'keep',[HTTP_HEADER_ENV_PREFIX+'OLD']:'secret'};
  assert.deepEqual({...clearInheritedMcpOverrides(parent)},{OTHER:'keep'});
  assert.equal(parent.MCP_COMMAND,'old');
});
test('URL validation preserves signed path/query spelling instead of WHATWG normalization',()=>{
  const url='https://mcp.example.test:443/a/../mcp?sig=中&escaped=%2f%2F';
  assert.equal(compileHttpTransport({...binding,url},context).privateEnvironment.MCP_SERVER_URL,url);
});
test('non-record header containers are rejected rather than silently dropping auth',()=>{
  for(const headers of [new Map([['Authorization','secret']]),new Set(),new Headers({Authorization:'secret'})]) assert.throws(()=>compileHttpTransport({...binding,headers},context),{code:'INVALID_HTTP_HEADERS'});
  const headers=Object.create(null);headers.Authorization='secret';
  assert.equal(compileHttpTransport({...binding,headers},context).headerNames[0],'Authorization');
});
test('invalid environment containers fail with a stable safe fault',()=>{
  const plan=compileHttpTransport(binding,context);
  assert.throws(()=>clearInheritedMcpOverrides(null),{code:'INVALID_HTTP_ENV'});
  for(const env of [null,[],new Map()]) assert.throws(()=>mergeHttpLaunchEnvironment({},env,plan),{code:'INVALID_HTTP_ENV'});
});
test('even exact duplicate sealed header metadata is rejected',async()=>{
  const vault=syntheticVault(),packet=await sealHttpTransport(vault,{...binding,headers:{Authorization:'one'}},context);
  for(const headerNames of [['Authorization','Authorization'],['Authorization','authorization']]) await assert.rejects(openHttpTransport(vault,{...packet,headerNames},context),{code:'INVALID_HTTP_STATE'});
});
test('opening state without a vault uses the same required-vault fault',async()=>{
  await assert.rejects(openHttpTransport(null,{},context),{code:'HTTP_VAULT_REQUIRED'});
});
test('HTTP fingerprint binds changes to both profile and sealed packet bytes',()=>{
  const one=fingerprintHttpConfiguration('profile','cipher-one');
  assert.match(one,/^[a-f0-9]{64}$/);
  assert.notEqual(one,fingerprintHttpConfiguration('profile-changed','cipher-one'));
  assert.notEqual(one,fingerprintHttpConfiguration('profile','cipher-two'));
  assert.equal(one,fingerprintHttpConfiguration(Buffer.from('profile'),new Uint8Array(Buffer.from('cipher-one'))));
});
test('HTTP fingerprint length framing rejects ambiguous concatenation collisions',()=>{
  assert.notEqual(fingerprintHttpConfiguration('ab','c'),fingerprintHttpConfiguration('a','bc'));
});
test('HTTP fingerprint requires bounded actual file bytes',()=>{
  for(const [profile,packet] of [[null,'x'],['x',''],['','x'],[{},'x'],['x','a'.repeat(262145)]]) assert.throws(()=>fingerprintHttpConfiguration(profile,packet),{code:'INVALID_HTTP_CONFIG_BYTES'});
});

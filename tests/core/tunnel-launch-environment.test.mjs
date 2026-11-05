import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {compileHttpTransport, HTTP_HEADER_ENV_PREFIX} from '../../src/adapters/http-transport.mjs';
import {buildTunnelLaunchEnvironment} from '../../src/adapters/tunnel-launch-environment.mjs';

const context = {serviceId:'mcp_environment_test', operationId:'op-selected'};
const binding = {type:'http', url:'https://synthetic.example.test:443/a/../mcp?sig=%2f&a=b,c', headers:{Authorization:'Bearer synthetic-header'}};
const plan = compileHttpTransport(binding, context);
const headerVariable = Object.keys(plan.privateEnvironment).find(name => name.startsWith(HTTP_HEADER_ENV_PREFIX));

test('a real child receives the selected HTTP endpoint, secret header and account key', () => {
  const env = buildTunnelLaunchEnvironment({
    // PATH locates the current test toolchain if this runtime reports execPath
    // as "node". No inherited credential/transport variables are copied.
    inheritedEnvironment:{PATH:process.env.PATH ?? '',Mcp_Server_Url:'old-url',mcp_command:'old-command',MCP_EXTRA_HEADERS:'old-header',[HTTP_HEADER_ENV_PREFIX.toLowerCase()+'OLD']:'stale-header',control_plane_api_key:'wrong-account',KEEP:'retained'},
    serviceEnvironment:{SERVICE_MODE:'synthetic'},
    controlPlaneEnvironment:{CONTROL_PLANE_API_KEY:'selected-account'},
    httpPlan:plan
  });
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], {env, encoding:'utf8', timeout:2000});
  assert.equal(child.status, 0, child.error?.code ?? child.stderr);
  const received = JSON.parse(child.stdout);
  assert.equal(received.MCP_SERVER_URL, binding.url);
  assert.equal(received[headerVariable], 'Bearer synthetic-header');
  assert.equal(received.CONTROL_PLANE_API_KEY, 'selected-account');
  assert.equal(received.KEEP, 'retained');
  assert.equal(received.SERVICE_MODE, 'synthetic');
  for (const removed of ['Mcp_Server_Url','mcp_command','MCP_EXTRA_HEADERS',HTTP_HEADER_ENV_PREFIX.toLowerCase()+'OLD','control_plane_api_key']) assert.equal(received[removed], undefined);
});

test('a following stdio launch removes all HTTP leftovers and inherited account aliases', () => {
  const env = buildTunnelLaunchEnvironment({
    inheritedEnvironment:{...plan.privateEnvironment,MCP_COMMAND:'old',MCP_DISCOVERY_EXTRA_HEADERS:'old',control_plane_api_key:'wrong',CONTROL_PLANE_URL:'old-control-plane',Path:'parent', 'ProgramFiles(x86)':'synthetic-programs'},
    serviceEnvironment:{PATH:'service-path'},
    controlPlaneEnvironment:{control_plane_api_key:'new-account'}
  });
  assert.equal(env.PATH, 'service-path');
  assert.equal(env.Path, undefined);
  assert.equal(env['ProgramFiles(x86)'], 'synthetic-programs');
  assert.equal(env.CONTROL_PLANE_API_KEY, 'new-account');
  assert.equal(env.CONTROL_PLANE_URL, undefined);
  assert.equal(Object.keys(env).some(name => name.toUpperCase().startsWith('MCP_') || name.startsWith(HTTP_HEADER_ENV_PREFIX)), false);
});

test('service definitions cannot supply account credentials or transport overrides in any casing', () => {
  for (const name of ['CONTROL_PLANE_API_KEY','control_plane_url','Control_Plane_Tunnel_Id','MCP_SERVER_URL','mcp_command','Mcp_Extra_Headers','mcp_discovery_extra_headers',HTTP_HEADER_ENV_PREFIX.toLowerCase()+'ABCD']) {
    assert.throws(() => buildTunnelLaunchEnvironment({serviceEnvironment:{[name]:'synthetic-private-value'},httpPlan:plan}), error => error.code === 'RESERVED_LAUNCH_ENV' && !String(error).includes('synthetic-private-value'));
  }
});

test('case aliases never survive and inherited insertion order cannot change the result', () => {
  const inherited = [['PATH','one'],['Path','two'],['Keep','retained']];
  const first = buildTunnelLaunchEnvironment({inheritedEnvironment:Object.fromEntries(inherited)});
  const second = buildTunnelLaunchEnvironment({inheritedEnvironment:Object.fromEntries(inherited.toReversed())});
  assert.deepEqual(first, second);
  assert.equal(Object.keys(first).filter(name => name.toUpperCase() === 'PATH').length, 1);
  const overridden = buildTunnelLaunchEnvironment({inheritedEnvironment:Object.fromEntries(inherited),serviceEnvironment:{path:'selected'},httpPlan:plan});
  assert.equal(Object.getPrototypeOf(overridden), null);
  assert.equal(overridden.path, 'selected');
  assert.equal(Object.keys(overridden).filter(name => name.toUpperCase() === 'PATH').length, 1);
});

test('ambiguous service and trusted account maps reject duplicate case aliases', () => {
  assert.throws(() => buildTunnelLaunchEnvironment({serviceEnvironment:{Path:'a',PATH:'b'}}), {code:'DUPLICATE_LAUNCH_ENV'});
  assert.throws(() => buildTunnelLaunchEnvironment({controlPlaneEnvironment:{CONTROL_PLANE_API_KEY:'a',control_plane_api_key:'b'}}), {code:'DUPLICATE_LAUNCH_ENV'});
});

test('only the trusted control-plane namespace can be pinned at the final stage', () => {
  for (const name of ['PATH','MCP_SERVER_URL',HTTP_HEADER_ENV_PREFIX+'A'.repeat(24),'CONTROL_PLANE_','CONTROL_PLANE_BAD-NAME']) {
    assert.throws(() => buildTunnelLaunchEnvironment({controlPlaneEnvironment:{[name]:'synthetic'}}), {code:'INVALID_CONTROL_PLANE_ENV'});
  }
});

test('inputs remain unchanged and the complete child environment is immutable', () => {
  const inherited = Object.freeze({MCP_SERVER_URL:'old',control_plane_api_key:'old',Path:'parent'});
  const service = Object.freeze({PATH:'service'});
  const trusted = Object.freeze({control_plane_api_key:'selected'});
  const env = buildTunnelLaunchEnvironment({inheritedEnvironment:inherited,serviceEnvironment:service,controlPlaneEnvironment:trusted,httpPlan:plan});
  assert.equal(inherited.MCP_SERVER_URL, 'old');
  assert.equal(inherited.control_plane_api_key, 'old');
  assert.equal(service.PATH, 'service');
  assert.equal(trusted.control_plane_api_key, 'selected');
  assert.ok(Object.isFrozen(env));
  assert.throws(() => {env.CONTROL_PLANE_API_KEY='override';}, TypeError);
});

test('non-record maps, invalid names and values fail without coercing or exposing data', () => {
  for (const field of ['inheritedEnvironment','serviceEnvironment','controlPlaneEnvironment']) {
    for (const invalid of [null,[],new Map(),new Date(),'synthetic']) assert.throws(() => buildTunnelLaunchEnvironment({[field]:invalid}), {code:'INVALID_LAUNCH_ENV'});
    for (const invalid of [null,undefined,1,{},'bad\0value']) assert.throws(() => buildTunnelLaunchEnvironment({[field]:{TEST:invalid}}), {code:'INVALID_LAUNCH_ENV_VALUE'});
    assert.throws(() => buildTunnelLaunchEnvironment({[field]:{'BAD=NAME':'value'}}), {code:'INVALID_LAUNCH_ENV_NAME'});
  }
  const safe = Object.create(null); safe.OK='value';
  assert.equal(buildTunnelLaunchEnvironment({serviceEnvironment:safe}).OK, 'value');
});

test('accessors and symbols cannot execute while composing environment maps or options', () => {
  let invoked = false;
  const getter = {get SECRET(){invoked=true; throw new Error('synthetic-secret');}};
  assert.throws(() => buildTunnelLaunchEnvironment({serviceEnvironment:getter}), {code:'INVALID_LAUNCH_ENV'});
  assert.throws(() => buildTunnelLaunchEnvironment({get inheritedEnvironment(){invoked=true; throw new Error('synthetic-secret');}}), {code:'INVALID_LAUNCH_OPTIONS'});
  assert.throws(() => buildTunnelLaunchEnvironment({serviceEnvironment:{[Symbol('private')]:'synthetic'}}), {code:'INVALID_LAUNCH_ENV'});
  assert.equal(invoked, false);
});

test('invalid options and uncompiled HTTP plans fail closed', () => {
  for (const options of [null,[],new Map()]) assert.throws(() => buildTunnelLaunchEnvironment(options), {code:'INVALID_LAUNCH_OPTIONS'});
  for (const badPlan of [{},{kind:'stdio'},{kind:'http',privateEnvironment:{}},{kind:'http',privateEnvironment:{MCP_SERVER_URL:'synthetic',CONTROL_PLANE_API_KEY:'bad'}},{kind:'http',privateEnvironment:{MCP_SERVER_URL:'synthetic',[HTTP_HEADER_ENV_PREFIX+'BAD']:'bad'}}]) {
    assert.throws(() => buildTunnelLaunchEnvironment({httpPlan:badPlan}), {code:'INVALID_LAUNCH_HTTP_PLAN'});
  }
});

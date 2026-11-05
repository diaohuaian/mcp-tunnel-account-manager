import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateTunnelEvidence} from '../../src/adapters/tunnel-health-evidence.mjs';

function fixture() {
  const identity={pid:42,startedAt:'2026-11-04T00:00:00.0000000Z',executable:'C:\\Tools\\tunnel-client.exe'};
  return {
    expected:{operationId:'op-test',service:'overleaf-mcp',tunnelId:'synthetic-tunnel',
      configFingerprint:'a'.repeat(64),identity:{...identity},
      launchedAt:'2026-11-04T00:00:00Z',controlPlaneBaseURL:'https://api.openai.com'},
    identity:{...identity},listenerIdentity:{...identity},currentConfigFingerprint:'a'.repeat(64),
    fetchedAtMs:Date.parse('2026-11-04T00:00:10Z'),
    health:{schema_version:1,live:true,ready:true,snapshot_at:'2026-11-04T00:00:10Z',
      runtime:{instance_id:'synthetic-instance',version:'0.0.19',started_at:'2026-11-04T00:00:01Z',lifecycle:'running'},
      components:{'control-plane':{status:'ok',state:'polling',limited:false,observed_at:'2026-11-04T00:00:09Z',
        details:{last_success:'2026-11-04T00:00:08Z',consecutive_failures:0,current_poll_age_seconds:1,deadline_seconds:15}}}},
    adminStatus:{version:'0.0.19',client_instance_id:'synthetic-instance',started_at:'2026-11-04T00:00:01Z',
      control_plane_tunnel_id:'synthetic-tunnel',control_plane_base_url:'https://api.openai.com'}
  };
}
test('same owned runtime, target and successful poll produce strict core receipt',()=>{
  const r=evaluateTunnelEvidence(fixture());
  assert.equal(r.verified,true);assert.equal(r.proof.kind,'authenticated-control-plane');
  assert.equal(r.proof.successfulPollAt,'2026-11-04T00:00:08Z');
});
test('HTTP success/liveness without typed polling evidence cannot pass',()=>{
  const f=fixture();f.health={live:true,ready:true};assert.throws(()=>evaluateTunnelEvidence(f));
});
test('no completed successful poll cannot be authenticated',()=>{
  const f=fixture();delete f.health.components['control-plane'].details.last_success;
  assert.throws(()=>evaluateTunnelEvidence(f));
});
test('authentication failure after success is rejected',()=>{
  const f=fixture(),p=f.health.components['control-plane'];
  p.status='degraded';p.state='backoff';p.details.consecutive_failures=1;p.details.http_status=401;
  assert.throws(()=>evaluateTunnelEvidence(f));
});
test('wrong tunnel or wrong control-plane origin cannot pass',()=>{
  for(const change of [{control_plane_tunnel_id:'wrong'},{control_plane_base_url:'https://other.example'}]){
    const f=fixture();Object.assign(f.adminStatus,change);assert.throws(()=>evaluateTunnelEvidence(f));
  }
});
test('mixed runtime instance snapshots cannot pass',()=>{
  const f=fixture();f.adminStatus.client_instance_id='other';assert.throws(()=>evaluateTunnelEvidence(f));
});
test('PID, exact creation identity, executable and listener ownership all bind',()=>{
  for(const change of [{pid:43},{startedAt:'2026-11-04T00:00:00.0000001Z'},{executable:'C:\\other.exe'}]){
    const f=fixture();Object.assign(f.listenerIdentity,change);assert.throws(()=>evaluateTunnelEvidence(f));
  }
});
test('evidence from before this runtime launch is rejected',()=>{
  const f=fixture();f.health.components['control-plane'].details.last_success='2026-11-03T23:59:59Z';
  assert.throws(()=>evaluateTunnelEvidence(f));
});
test('stale aggregate snapshot or stale successful poll is rejected',()=>{
  const f=fixture();f.fetchedAtMs+=6000;assert.throws(()=>evaluateTunnelEvidence(f));
  const g=fixture();g.health.snapshot_at='2026-11-04T00:01:00Z';g.fetchedAtMs=Date.parse(g.health.snapshot_at);
  assert.throws(()=>evaluateTunnelEvidence(g));
});
test('old failures recovered by a later successful poll are accepted',()=>{
  const f=fixture();f.health.components['control-plane'].details.last_error='2026-11-04T00:00:02Z';
  assert.equal(evaluateTunnelEvidence(f).verified,true);
});
test('healthy long poll and backpressure are not treated as outages',()=>{
  const f=fixture();f.health.components['control-plane'].state='backpressured';
  assert.equal(evaluateTunnelEvidence(f).verified,true);
});
test('schema/version mismatch, partial metadata or stopped runtime is rejected',()=>{
  for(const mutate of [f=>f.health.schema_version=2,f=>f.health.runtime.version='0.0.20',
    f=>f.health.truncated=true,f=>f.health.runtime.lifecycle='draining',
    f=>f.health.components['control-plane'].state='stopped']){
    const f=fixture();mutate(f);assert.throws(()=>evaluateTunnelEvidence(f));
  }
});
test('changed desired config cannot reuse otherwise valid runtime evidence',()=>{
  const f=fixture();f.currentConfigFingerprint='b'.repeat(64);assert.throws(()=>evaluateTunnelEvidence(f));
});
test('unobserved stdio MCP discovery does not invalidate an authenticated tunnel',()=>{
  const f=fixture();f.health.components.mcp={status:'unknown',state:'not_observed'};
  assert.equal(evaluateTunnelEvidence(f).verified,true);
});


test('registered-ID grammar supports additional MCP without weakening evidence',()=>{
  const f=fixture();f.expected.service='mcp_weather';
  assert.equal(evaluateTunnelEvidence(f).service,'mcp_weather');
  delete f.health.components['control-plane'].details.last_success;
  assert.throws(()=>evaluateTunnelEvidence(f));
});
test('path-like service identifier cannot satisfy target evidence',()=>{
  const f=fixture();f.expected.service='../outside';
  assert.throws(()=>evaluateTunnelEvidence(f));
});

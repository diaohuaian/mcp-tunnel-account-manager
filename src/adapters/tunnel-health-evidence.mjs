import {isMcpServiceId} from '../core/mcp-registry-policy.mjs';
// GPT-owned evidence gate for tunnel-client 0.0.19, schema_version 1.
// Field semantics verified against openai/tunnel-client commit
// 01d67bb4da0d8359b808b4761f8db171ab682cd7:
// pkg/healthstate/{health,operations}.go, pkg/controlplane/{health.go,
// internal/poller.go}, pkg/adminui/fxmodule.go. No network or secret reads here.
export const SUPPORTED_TUNNEL_VERSION = '0.0.19';
export class TargetEvidenceFault extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new TargetEvidenceFault(code); };
const boundedString = (v, max = 256) => typeof v === 'string' && v.length > 0 &&
  v.length <= max && !/[\x00-\x1f]/.test(v);
function timestamp(value) {
  if (!boundedString(value, 64) ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    fail('INVALID_EVIDENCE_TIMESTAMP');
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) fail('INVALID_EVIDENCE_TIMESTAMP');
  return ms;
}
function executable(value) {
  if (!boundedString(value, 32768)) fail('PROCESS_IDENTITY_UNCONFIRMED');
  return value.replaceAll('\\', '/').toLowerCase();
}
function assertIdentity(actual, expected) {
  if (!Number.isSafeInteger(expected?.pid) || expected.pid <= 0 ||
      !actual || actual.pid !== expected.pid ||
      actual.startedAt !== expected.startedAt ||
      executable(actual.executable) !== executable(expected.executable)) {
    fail('PROCESS_IDENTITY_UNCONFIRMED');
  }
  timestamp(expected.startedAt);
}
function origin(value) {
  let u;
  try { u = new URL(value); } catch { fail('TARGET_ORIGIN_MISMATCH'); }
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/' ||
      !['http:', 'https:'].includes(u.protocol)) fail('TARGET_ORIGIN_MISMATCH');
  return u.origin;
}

// Caller must obtain identity AND listenerIdentity from the audited OS helper
// before/after bounded loopback-only, no-redirect GETs of /health?details=true
// and /api/status. It must recompute currentConfigFingerprint from owned config.
// Neither an HTTP status nor a caller-synthesized `authenticated:true` is proof.
export function evaluateTunnelEvidence({ health, adminStatus, identity,
  listenerIdentity, currentConfigFingerprint, expected, fetchedAtMs = Date.now() }) {
  if (!expected || !isMcpServiceId(expected.service) ||
      !boundedString(expected.operationId, 128) || !boundedString(expected.tunnelId, 128) ||
      !/^[a-f0-9]{64}$/.test(expected.configFingerprint ?? '') ||
      currentConfigFingerprint !== expected.configFingerprint || !Number.isFinite(fetchedAtMs)) {
    fail('TARGET_CONFIG_UNCONFIRMED');
  }
  assertIdentity(identity, expected.identity);
  assertIdentity(listenerIdentity, expected.identity);
  if (health?.schema_version !== 1 || health.live !== true || health.ready !== true ||
      health.truncated === true || health.runtime?.limited === true ||
      health.runtime?.lifecycle !== 'running') fail('RUNTIME_NOT_READY');
  const runtime = health.runtime;
  if (runtime.version !== SUPPORTED_TUNNEL_VERSION ||
      adminStatus?.version !== SUPPORTED_TUNNEL_VERSION) fail('UNSUPPORTED_TUNNEL_VERSION');
  if (!boundedString(runtime.instance_id, 128) ||
      runtime.instance_id !== adminStatus.client_instance_id ||
      (expected.instanceId !== undefined && expected.instanceId !== runtime.instance_id)) {
    fail('RUNTIME_INSTANCE_MISMATCH');
  }
  if (adminStatus.control_plane_tunnel_id !== expected.tunnelId ||
      origin(adminStatus.control_plane_base_url) !== origin(expected.controlPlaneBaseURL)) {
    fail('TARGET_TUNNEL_MISMATCH');
  }
  const launched = timestamp(expected.launchedAt);
  const processStarted = timestamp(expected.identity.startedAt);
  const started = timestamp(runtime.started_at);
  const adminStarted = timestamp(adminStatus.started_at);
  const snapshotAt = timestamp(health.snapshot_at);
  if (started < launched - 1 || started < processStarted - 1 ||
      adminStarted < processStarted - 1 || started > fetchedAtMs + 1000 ||
      adminStarted > fetchedAtMs + 1000 || snapshotAt < started ||
      snapshotAt > fetchedAtMs + 1000 || fetchedAtMs - snapshotAt > 5000) {
    fail('STALE_RUNTIME_EVIDENCE');
  }
  const component = health.components?.['control-plane'];
  const details = component?.details;
  if (component?.status !== 'ok' || component.limited === true ||
      !['idle', 'polling', 'backpressured'].includes(component.state) ||
      details?.consecutive_failures !== 0 ||
      (details.http_status !== undefined && details.http_status !== 0) ||
      (component.reason_code !== undefined && component.reason_code !== '') ||
      (details.failure_category !== undefined && details.failure_category !== '')) {
    fail('CONTROL_PLANE_NOT_AUTHENTICATED');
  }
  const succeeded = timestamp(details.last_success);
  const observed = timestamp(component.observed_at);
  const deadline = details.deadline_seconds;
  if (!Number.isFinite(deadline) || deadline <= 0 || deadline > 600) {
    fail('CONTROL_PLANE_EVIDENCE_UNCONFIRMED');
  }
  const freshnessMs = Math.max(15000, deadline * 1000 + 5000);
  if (succeeded < Math.max(started, launched) || succeeded > snapshotAt + 1000 ||
      snapshotAt - succeeded > freshnessMs || observed < succeeded ||
      observed > snapshotAt + 1000 ||
      (details.last_error && timestamp(details.last_error) > succeeded) ||
      (component.state === 'polling' &&
        (!Number.isFinite(details.current_poll_age_seconds) ||
         details.current_poll_age_seconds < 0 ||
         details.current_poll_age_seconds > deadline + 5))) {
    fail('STALE_CONTROL_PLANE_EVIDENCE');
  }
  return {
    verified: true,
    operationId: expected.operationId,
    service: expected.service,
    configFingerprint: expected.configFingerprint,
    identity: {pid: identity.pid, startedAt: identity.startedAt, executable: identity.executable},
    proof: {
      kind: 'authenticated-control-plane',
      source: 'tunnel-client-0.0.19-health-schema-1',
      clientInstanceId: runtime.instance_id,
      successfulPollAt: details.last_success,
      observedAt: health.snapshot_at
    }
  };
}

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateTunnelEvidence,
  TargetEvidenceFault,
  SUPPORTED_TUNNEL_VERSION
} from '../src/adapters/tunnel-health-evidence.mjs';

/**
 * Creates a pristine, fully-verified base evidence fixture conforming to
 * tunnel-client 0.0.19 schema_version 1 requirements.
 */
function makeBaseEvidence() {
  const pid = 3456;
  const startedAt = '2026-11-04T12:00:00.0000000Z';
  const executable = 'C:\\Program Files\\OpenAI\\tunnel-client.exe';
  const launchedAt = '2026-11-04T12:00:00.000Z';
  const started_at = '2026-11-04T12:00:00.200Z';
  const last_success = '2026-11-04T12:00:03.000Z';
  const observed_at = '2026-11-04T12:00:03.500Z';
  const snapshot_at = '2026-11-04T12:00:04.000Z';
  const fetchedAtMs = Date.parse('2026-11-04T12:00:05.000Z');
  const fingerprint = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  const identity = { pid, startedAt, executable };

  return {
    expected: {
      operationId: 'op-adv-test-01',
      service: 'overleaf-mcp',
      tunnelId: 'tun-secure-42',
      configFingerprint: fingerprint,
      identity: { ...identity },
      launchedAt,
      controlPlaneBaseURL: 'https://api.openai.com',
      instanceId: 'inst-prod-999'
    },
    identity: { ...identity },
    listenerIdentity: { ...identity },
    currentConfigFingerprint: fingerprint,
    fetchedAtMs,
    health: {
      schema_version: 1,
      live: true,
      ready: true,
      snapshot_at,
      truncated: false,
      runtime: {
        instance_id: 'inst-prod-999',
        version: SUPPORTED_TUNNEL_VERSION,
        started_at,
        lifecycle: 'running',
        limited: false
      },
      components: {
        'control-plane': {
          status: 'ok',
          state: 'polling',
          limited: false,
          observed_at,
          reason_code: '',
          details: {
            last_success,
            consecutive_failures: 0,
            http_status: 0,
            failure_category: '',
            deadline_seconds: 30,
            current_poll_age_seconds: 0.8
          }
        }
      }
    },
    adminStatus: {
      version: SUPPORTED_TUNNEL_VERSION,
      client_instance_id: 'inst-prod-999',
      started_at,
      control_plane_tunnel_id: 'tun-secure-42',
      control_plane_base_url: 'https://api.openai.com'
    }
  };
}

function assertFault(evidence, expectedCode, msg) {
  assert.throws(
    () => evaluateTunnelEvidence(evidence),
    (err) => {
      assert(err instanceof TargetEvidenceFault, `Expected TargetEvidenceFault but got ${err?.constructor?.name || typeof err}: ${err?.message}`);
      assert.strictEqual(err.code, expectedCode, msg || `Expected fault code ${expectedCode} but got ${err.code}`);
      return true;
    }
  );
}

describe('1. Adversarial HTTP and Liveness Probing (Missing Typed Component Proof)', () => {
  test('bare HTTP liveness payload without readiness or schema is rejected', () => {
    const ev = makeBaseEvidence();
    ev.health = { live: true };
    assertFault(ev, 'RUNTIME_NOT_READY', 'Bare live:true response must not pass');
  });

  test('synthetic live and ready flags without schema_version or runtime are rejected', () => {
    const ev = makeBaseEvidence();
    ev.health = { live: true, ready: true };
    assertFault(ev, 'RUNTIME_NOT_READY', 'Lacks schema_version and runtime structure');
  });

  test('valid liveness and readiness with missing control-plane component is rejected', () => {
    const ev = makeBaseEvidence();
    ev.health.components = {};
    assertFault(ev, 'CONTROL_PLANE_NOT_AUTHENTICATED', 'Missing control-plane component');
  });

  test('truthy string coercion attacks on liveness and readiness flags are rejected', () => {
    for (const [key, badVal] of [['live', 'true'], ['ready', 'true'], ['live', 1], ['ready', 1]]) {
      const ev = makeBaseEvidence();
      ev.health[key] = badVal;
      assertFault(ev, 'RUNTIME_NOT_READY', `Boolean coercion attack on ${key}=${JSON.stringify(badVal)}`);
    }
  });

  test('partially ready states (live without ready, or ready without live) are rejected', () => {
    const ev1 = makeBaseEvidence();
    ev1.health.ready = false;
    assertFault(ev1, 'RUNTIME_NOT_READY', 'live=true, ready=false must fail');

    const ev2 = makeBaseEvidence();
    ev2.health.live = false;
    assertFault(ev2, 'RUNTIME_NOT_READY', 'live=false, ready=true must fail');
  });

  test('empty or non-object health responses are rejected', () => {
    for (const badHealth of [null, undefined, {}, false, 'OK']) {
      const ev = makeBaseEvidence();
      ev.health = badHealth;
      assertFault(ev, 'RUNTIME_NOT_READY', `Invalid health payload: ${JSON.stringify(badHealth)}`);
    }
  });
});

describe('2. Missing Success & Incomplete Negotiation Evidence', () => {
  test('missing last_success in control-plane details is rejected', () => {
    const ev = makeBaseEvidence();
    delete ev.health.components['control-plane'].details.last_success;
    assertFault(ev, 'INVALID_EVIDENCE_TIMESTAMP', 'Omitted last_success must be rejected');
  });

  test('null or empty string last_success is rejected', () => {
    for (const badVal of [null, '']) {
      const ev = makeBaseEvidence();
      ev.health.components['control-plane'].details.last_success = badVal;
      assertFault(ev, 'INVALID_EVIDENCE_TIMESTAMP', `last_success=${JSON.stringify(badVal)} must be rejected`);
    }
  });

  test('sentinel or non-ISO strings in last_success are rejected', () => {
    const nonIsoValues = [
      'never',
      'pending',
      '0',
      'null',
      '2026/11/04 12:00:00',
      'Wed, 04 Nov 2026 12:00:00 GMT',
      '1730721603000',
      '2026-11-04T12:00:00', // missing timezone specifier
      '2026-11-04'
    ];
    for (const badVal of nonIsoValues) {
      const ev = makeBaseEvidence();
      ev.health.components['control-plane'].details.last_success = badVal;
      assertFault(ev, 'INVALID_EVIDENCE_TIMESTAMP', `Non-ISO timestamp: ${badVal}`);
    }
  });

  test('semantically invalid date values with valid regex structure are rejected', () => {
    const ev = makeBaseEvidence();
    ev.health.components['control-plane'].details.last_success = '2026-99-99T99:99:99Z';
    assertFault(ev, 'INVALID_EVIDENCE_TIMESTAMP', 'Unparseable date must fail');
  });

  test('omitted or null details object in control-plane component is rejected', () => {
    const ev1 = makeBaseEvidence();
    delete ev1.health.components['control-plane'].details;
    assertFault(ev1, 'CONTROL_PLANE_NOT_AUTHENTICATED', 'Missing details object');

    const ev2 = makeBaseEvidence();
    ev2.health.components['control-plane'].details = null;
    assertFault(ev2, 'CONTROL_PLANE_NOT_AUTHENTICATED', 'Null details object');
  });
});

describe('3. Current Auth Errors & Degraded Upstream States', () => {
  test('positive consecutive_failures is rejected even with recent last_success', () => {
    for (const failures of [1, 2, 10]) {
      const ev = makeBaseEvidence();
      ev.health.components['control-plane'].details.consecutive_failures = failures;
      assertFault(ev, 'CONTROL_PLANE_NOT_AUTHENTICATED', `consecutive_failures=${failures} must fail`);
    }
  });

  test('non-zero upstream HTTP status codes (401, 403, 500, 502) are rejected', () => {
    for (const code of [401, 403, 500, 502]) {
      const ev = makeBaseEvidence();
      ev.health.components['control-plane'].details.http_status = code;
      assertFault(ev, 'CONTROL_PLANE_NOT_AUTHENTICATED', `http_status=${code} must fail`);
    }
  });

  test('non-empty failure_category is rejected', () => {
    for (const cat of ['authentication', 'authorization', 'network', 'protocol']) {
      const ev = makeBaseEvidence();
      ev.health.components['control-plane'].details.failure_category = cat;
      assertFault(ev, 'CONTROL_PLANE_NOT_AUTHENTICATED', `failure_category=${cat} must fail`);
    }
  });

  test('non-empty reason_code on control-plane component is rejected', () => {
    for (const reason of ['TOKEN_EXPIRED', 'CREDENTIAL_REVOKED', 'TUNNEL_NOT_FOUND']) {
      const ev = makeBaseEvidence();
      ev.health.components['control-plane'].reason_code = reason;
      assertFault(ev, 'CONTROL_PLANE_NOT_AUTHENTICATED', `reason_code=${reason} must fail`);
    }
  });

  test('non-ok component status (degraded, error, unhealthy) is rejected', () => {
    for (const status of ['degraded', 'error', 'unhealthy', 'warn', '']) {
      const ev = makeBaseEvidence();
      ev.health.components['control-plane'].status = status;
      assertFault(ev, 'CONTROL_PLANE_NOT_AUTHENTICATED', `status=${status} must fail`);
    }
  });

  test('rate-limited or resource-limited control plane component is rejected', () => {
    const ev = makeBaseEvidence();
    ev.health.components['control-plane'].limited = true;
    assertFault(ev, 'CONTROL_PLANE_NOT_AUTHENTICATED', 'limited=true must fail');
  });

  test('disallowed poller states (failed, stopped, disconnected, backoff) are rejected', () => {
    for (const badState of ['failed', 'stopped', 'disconnected', 'backoff', 'unknown']) {
      const ev = makeBaseEvidence();
      ev.health.components['control-plane'].state = badState;
      assertFault(ev, 'CONTROL_PLANE_NOT_AUTHENTICATED', `state=${badState} must fail`);
    }
  });

  test('unrecovered error occurring after last_success is rejected', () => {
    const ev = makeBaseEvidence();
    ev.health.components['control-plane'].details.last_error = '2026-11-04T12:00:03.500Z'; // after last_success 12:00:03.000Z
    assertFault(ev, 'STALE_CONTROL_PLANE_EVIDENCE', 'last_error after last_success must fail');
  });
});

describe('4. Stale, Hijacked, or Diverged Process and Runtime Instances', () => {
  test('listener port hijacked by different PID is rejected', () => {
    const ev = makeBaseEvidence();
    ev.listenerIdentity.pid = 9999;
    assertFault(ev, 'PROCESS_IDENTITY_UNCONFIRMED', 'Hijacked listener PID must fail');
  });

  test('listener recycled on same PID with newer startedAt is rejected', () => {
    const ev = makeBaseEvidence();
    ev.listenerIdentity.startedAt = '2026-11-04T12:00:01.0000000Z';
    assertFault(ev, 'PROCESS_IDENTITY_UNCONFIRMED', 'Recycled process with mismatched startedAt');
  });

  test('listener executable path pointing to unexpected binary is rejected', () => {
    const ev = makeBaseEvidence();
    ev.listenerIdentity.executable = 'C:\\Program Files\\Attacker\\rogue.exe';
    assertFault(ev, 'PROCESS_IDENTITY_UNCONFIRMED', 'Substituted binary executable');
  });

  test('case-insensitivity and backslash/forward-slash normalization are preserved', () => {
    const ev = makeBaseEvidence();
    ev.listenerIdentity.executable = 'c:/program files/openai/tunnel-client.exe';
    ev.expected.identity.executable = 'C:\\Program Files\\OpenAI\\tunnel-client.exe';
    const result = evaluateTunnelEvidence(ev);
    assert.strictEqual(result.verified, true);
  });

  test('control characters in executable path are rejected', () => {
    const ev = makeBaseEvidence();
    ev.expected.identity.executable = 'C:\\Program Files\\OpenAI\\tunnel-client\n.exe';
    ev.identity.executable = ev.expected.identity.executable;
    ev.listenerIdentity.executable = ev.expected.identity.executable;
    assertFault(ev, 'PROCESS_IDENTITY_UNCONFIRMED', 'Control characters in executable path');
  });

  test('non-safe-integer or non-positive PID values are rejected', () => {
    for (const badPid of [0, -1, 3.14, NaN, Infinity, '3456']) {
      const ev = makeBaseEvidence();
      ev.expected.identity.pid = badPid;
      assertFault(ev, 'PROCESS_IDENTITY_UNCONFIRMED', `Invalid PID=${badPid}`);
    }
  });

  test('split-brain instance IDs between health runtime and adminStatus are rejected', () => {
    const ev = makeBaseEvidence();
    ev.adminStatus.client_instance_id = 'inst-different-404';
    assertFault(ev, 'RUNTIME_INSTANCE_MISMATCH', 'Instance ID divergence');
  });

  test('divergence between expected instanceId and reported instance is rejected', () => {
    const ev = makeBaseEvidence();
    ev.expected.instanceId = 'inst-prior-session';
    assertFault(ev, 'RUNTIME_INSTANCE_MISMATCH', 'Prior session instanceId reuse');
  });

  test('matching expected instanceId produces valid receipt', () => {
    const ev = makeBaseEvidence();
    ev.expected.instanceId = 'inst-prod-999';
    const res = evaluateTunnelEvidence(ev);
    assert.strictEqual(res.verified, true);
    assert.strictEqual(res.proof.clientInstanceId, 'inst-prod-999');
  });

  test('bounded string violations on instance_id (control chars, empty, >128 chars) are rejected', () => {
    for (const badId of ['', 'inst\x00bad', 'inst\nbad', 'x'.repeat(129)]) {
      const ev = makeBaseEvidence();
      ev.health.runtime.instance_id = badId;
      ev.adminStatus.client_instance_id = badId;
      assertFault(ev, 'RUNTIME_INSTANCE_MISMATCH', `Adversarial instance_id: ${badId.slice(0, 10)}`);
    }
  });
});

describe('5. Target Mismatch, Base URL Spoofing, and SSRF Injection Vectors', () => {
  test('cross-tunnel mismatch between expected and actual tunnelId is rejected', () => {
    const ev = makeBaseEvidence();
    ev.adminStatus.control_plane_tunnel_id = 'tun-adversarial-666';
    assertFault(ev, 'TARGET_TUNNEL_MISMATCH', 'Tunnel ID mismatch');
  });

  test('control plane base URL origin spoofing (attacker domain) is rejected', () => {
    const ev = makeBaseEvidence();
    ev.adminStatus.control_plane_base_url = 'https://api.openai.com.attacker.com';
    assertFault(ev, 'TARGET_TUNNEL_MISMATCH', 'Attacker domain base URL');
  });

  test('non-TLS HTTP base URL is rejected when HTTPS expected', () => {
    const ev = makeBaseEvidence();
    ev.adminStatus.control_plane_base_url = 'http://api.openai.com';
    assertFault(ev, 'TARGET_TUNNEL_MISMATCH', 'Insecure HTTP origin mismatch');
  });

  test('non-HTTP protocol schemes (javascript:, file:, ws:, ftp:) are rejected', () => {
    for (const scheme of ['javascript:alert(1)', 'file:///etc/passwd', 'ws://api.openai.com', 'ftp://api.openai.com']) {
      const ev = makeBaseEvidence();
      ev.adminStatus.control_plane_base_url = scheme;
      assertFault(ev, 'TARGET_ORIGIN_MISMATCH', `Disallowed protocol scheme: ${scheme}`);
    }
  });

  test('userinfo credential injection in base URL is rejected', () => {
    const ev = makeBaseEvidence();
    ev.adminStatus.control_plane_base_url = 'https://admin:secret@api.openai.com/';
    assertFault(ev, 'TARGET_ORIGIN_MISMATCH', 'URL with userinfo credentials');
  });

  test('path traversal and subpaths in base URL are rejected (strict pathname === /)', () => {
    for (const url of ['https://api.openai.com/v1', 'https://api.openai.com/tunnel', 'https://api.openai.com//', 'https://api.openai.com/v1/../v2']) {
      const ev = makeBaseEvidence();
      ev.adminStatus.control_plane_base_url = url;
      assertFault(ev, 'TARGET_ORIGIN_MISMATCH', `Base URL with non-root path: ${url}`);
    }
  });

  test('query string or hash fragment injections in base URL are rejected', () => {
    const ev1 = makeBaseEvidence();
    ev1.adminStatus.control_plane_base_url = 'https://api.openai.com/?proxy=injected';
    assertFault(ev1, 'TARGET_ORIGIN_MISMATCH', 'Query parameter injection');

    const ev2 = makeBaseEvidence();
    ev2.adminStatus.control_plane_base_url = 'https://api.openai.com/#injected_fragment';
    assertFault(ev2, 'TARGET_ORIGIN_MISMATCH', 'Hash fragment injection');
  });

  test('unparseable base URL string is rejected', () => {
    const ev = makeBaseEvidence();
    ev.adminStatus.control_plane_base_url = 'not-a-valid-url';
    assertFault(ev, 'TARGET_ORIGIN_MISMATCH', 'Malformed URL string');
  });
});

describe('6. Partial, Truncated Fields, Schema Boundaries, and Config Mismatch', () => {
  test('upstream payload with truncated: true is rejected', () => {
    const ev = makeBaseEvidence();
    ev.health.truncated = true;
    assertFault(ev, 'RUNTIME_NOT_READY', 'Truncated health payload');
  });

  test('upstream runtime marked limited: true is rejected', () => {
    const ev = makeBaseEvidence();
    ev.health.runtime.limited = true;
    assertFault(ev, 'RUNTIME_NOT_READY', 'Limited runtime state');
  });

  test('transient runtime lifecycle states (starting, draining, stopping, terminated) are rejected', () => {
    for (const state of ['starting', 'draining', 'stopping', 'terminated', 'restarting']) {
      const ev = makeBaseEvidence();
      ev.health.runtime.lifecycle = state;
      assertFault(ev, 'RUNTIME_NOT_READY', `Disallowed lifecycle: ${state}`);
    }
  });

  test('schema_version mismatch (0, 2, string "1", null) is rejected', () => {
    for (const version of [0, 2, '1', null, undefined]) {
      const ev = makeBaseEvidence();
      ev.health.schema_version = version;
      assertFault(ev, 'RUNTIME_NOT_READY', `Invalid schema_version=${version}`);
    }
  });

  test('unsupported tunnel-client version in health runtime or adminStatus is rejected', () => {
    const ev1 = makeBaseEvidence();
    ev1.health.runtime.version = '0.0.18';
    assertFault(ev1, 'UNSUPPORTED_TUNNEL_VERSION', 'Outdated health runtime version');

    const ev2 = makeBaseEvidence();
    ev2.health.runtime.version = '0.0.20';
    assertFault(ev2, 'UNSUPPORTED_TUNNEL_VERSION', 'Future health runtime version');

    const ev3 = makeBaseEvidence();
    ev3.adminStatus.version = '0.0.18';
    assertFault(ev3, 'UNSUPPORTED_TUNNEL_VERSION', 'Outdated adminStatus version');
  });

  test('unsupported target service is rejected', () => {
    for (const badService of ['unknown-mcp', 'gemini-tunnel', '', 'root']) {
      const ev = makeBaseEvidence();
      ev.expected.service = badService;
      assertFault(ev, 'TARGET_CONFIG_UNCONFIRMED', `Unsupported service: ${badService}`);
    }
  });

  test('both supported services (overleaf-mcp and antigravity-mcp) succeed', () => {
    for (const validService of ['overleaf-mcp', 'antigravity-mcp']) {
      const ev = makeBaseEvidence();
      ev.expected.service = validService;
      const res = evaluateTunnelEvidence(ev);
      assert.strictEqual(res.verified, true);
      assert.strictEqual(res.service, validService);
    }
  });

  test('config fingerprint drift or tampering is rejected', () => {
    const ev = makeBaseEvidence();
    ev.currentConfigFingerprint = 'f'.repeat(64);
    assertFault(ev, 'TARGET_CONFIG_UNCONFIRMED', 'Fingerprint mismatch between expected and current');
  });

  test('malformed config fingerprint (non-hex, wrong length, uppercase) is rejected', () => {
    for (const badFp of ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), '']) {
      const ev = makeBaseEvidence();
      ev.expected.configFingerprint = badFp;
      ev.currentConfigFingerprint = badFp;
      assertFault(ev, 'TARGET_CONFIG_UNCONFIRMED', `Invalid fingerprint: ${badFp.slice(0, 10)}`);
    }
  });

  test('bounded string checks on operationId and tunnelId (empty, control chars, >128 chars) are rejected', () => {
    for (const badOp of ['', 'op\x001', 'op\r\n1', 'x'.repeat(129)]) {
      const ev = makeBaseEvidence();
      ev.expected.operationId = badOp;
      assertFault(ev, 'TARGET_CONFIG_UNCONFIRMED', 'Adversarial operationId');
    }

    for (const badTun of ['', 'tun\x001', 'tun\t1', 'y'.repeat(129)]) {
      const ev = makeBaseEvidence();
      ev.expected.tunnelId = badTun;
      ev.adminStatus.control_plane_tunnel_id = badTun;
      assertFault(ev, 'TARGET_CONFIG_UNCONFIRMED', 'Adversarial tunnelId');
    }
  });
});

describe('7. Temporal Attacks: Future Timestamps, Clock Skew, and Stale Caches', () => {
  test('future runtime start timestamp (> fetchedAtMs + 1000) is rejected', () => {
    const ev = makeBaseEvidence();
    ev.health.runtime.started_at = '2026-11-04T12:00:07.000Z'; // fetchedAt is 12:00:05.000Z
    assertFault(ev, 'STALE_RUNTIME_EVIDENCE', 'Future runtime started_at');
  });

  test('future adminStatus start timestamp (> fetchedAtMs + 1000) is rejected', () => {
    const ev = makeBaseEvidence();
    ev.adminStatus.started_at = '2026-11-04T12:00:07.000Z';
    assertFault(ev, 'STALE_RUNTIME_EVIDENCE', 'Future adminStatus started_at');
  });

  test('future health snapshot timestamp (> fetchedAtMs + 1000) is rejected', () => {
    const ev = makeBaseEvidence();
    ev.health.snapshot_at = '2026-11-04T12:00:07.000Z';
    assertFault(ev, 'STALE_RUNTIME_EVIDENCE', 'Future snapshot_at');
  });

  test('stale snapshot timestamp older than 5000ms is rejected', () => {
    const ev = makeBaseEvidence();
    ev.fetchedAtMs = Date.parse('2026-11-04T12:00:10.000Z'); // snapshot was 12:00:04.000Z (6000ms old)
    assertFault(ev, 'STALE_RUNTIME_EVIDENCE', 'Stale snapshot exceeding 5000ms freshness window');
  });

  test('chronological inversion: snapshot taken before runtime started is rejected', () => {
    const ev = makeBaseEvidence();
    ev.health.snapshot_at = '2026-11-04T12:00:00.100Z'; // started_at was 12:00:00.200Z
    assertFault(ev, 'STALE_RUNTIME_EVIDENCE', 'Snapshot predating runtime started_at');
  });

  test('runtime starting before manager launch is rejected (stale daemon reuse)', () => {
    const ev = makeBaseEvidence();
    ev.health.runtime.started_at = '2026-11-04T11:59:59.000Z'; // launchedAt was 12:00:00.000Z
    assertFault(ev, 'STALE_RUNTIME_EVIDENCE', 'Runtime start predating launch time');
  });

  test('runtime starting before OS process creation is rejected', () => {
    const ev = makeBaseEvidence();
    ev.health.runtime.started_at = '2026-11-04T11:59:59.000Z'; // process startedAt was 12:00:00.0000000Z
    ev.expected.launchedAt = '2026-11-04T11:59:58.000Z';
    assertFault(ev, 'STALE_RUNTIME_EVIDENCE', 'Runtime start predating OS process startedAt');
  });

  test('future last_success timestamp (> snapshot_at + 1000) is rejected', () => {
    const ev = makeBaseEvidence();
    ev.health.components['control-plane'].details.last_success = '2026-11-04T12:00:05.500Z'; // snapshot was 12:00:04.000Z
    assertFault(ev, 'STALE_CONTROL_PLANE_EVIDENCE', 'Future last_success timestamp');
  });

  test('last_success predating manager launch or runtime start is rejected', () => {
    const ev1 = makeBaseEvidence();
    ev1.health.components['control-plane'].details.last_success = '2026-11-04T11:59:59.000Z';
    assertFault(ev1, 'STALE_CONTROL_PLANE_EVIDENCE', 'last_success predating launch');

    const ev2 = makeBaseEvidence();
    ev2.health.components['control-plane'].details.last_success = '2026-11-04T12:00:00.100Z'; // started_at was 12:00:00.200Z
    assertFault(ev2, 'STALE_CONTROL_PLANE_EVIDENCE', 'last_success predating runtime start');
  });

  test('last_success exceeding dynamic freshness window is rejected', () => {
    const ev = makeBaseEvidence();
    // deadline = 30s -> freshnessMs = max(15000, 30000 + 5000) = 35000ms
    ev.health.components['control-plane'].details.deadline_seconds = 30;
    ev.health.components['control-plane'].details.last_success = '2026-11-04T12:00:00.500Z';
    ev.health.snapshot_at = '2026-11-04T12:00:36.000Z'; // 35.5s after last_success
    ev.fetchedAtMs = Date.parse('2026-11-04T12:00:37.000Z');
    assertFault(ev, 'STALE_CONTROL_PLANE_EVIDENCE', 'last_success expired beyond dynamic freshness window');
  });

  test('chronological inversion: observed_at earlier than last_success is rejected', () => {
    const ev = makeBaseEvidence();
    ev.health.components['control-plane'].observed_at = '2026-11-04T12:00:02.500Z'; // last_success was 12:00:03.000Z
    assertFault(ev, 'STALE_CONTROL_PLANE_EVIDENCE', 'Observation predates successful poll');
  });

  test('future observed_at (> snapshot_at + 1000) is rejected', () => {
    const ev = makeBaseEvidence();
    ev.health.components['control-plane'].observed_at = '2026-11-04T12:00:05.500Z'; // snapshot was 12:00:04.000Z
    assertFault(ev, 'STALE_CONTROL_PLANE_EVIDENCE', 'Future observation timestamp');
  });

  test('high precision timestamps with nanoseconds (Go RFC 3339 Nano) are accepted', () => {
    const ev = makeBaseEvidence();
    ev.health.snapshot_at = '2026-11-04T12:00:04.123456789Z';
    ev.health.components['control-plane'].observed_at = '2026-11-04T12:00:03.987654321Z';
    ev.health.components['control-plane'].details.last_success = '2026-11-04T12:00:03.111222333Z';
    const res = evaluateTunnelEvidence(ev);
    assert.strictEqual(res.verified, true);
    assert.strictEqual(res.proof.successfulPollAt, '2026-11-04T12:00:03.111222333Z');
  });
});

describe('8. Key Field Types, Long-Poll and Backpressure Recovery', () => {
  test('deadline_seconds boundary and type validation', () => {
    for (const badDeadline of [0, -1, -30, 601, 1000, NaN, Infinity, '30', null, false]) {
      const ev = makeBaseEvidence();
      ev.health.components['control-plane'].details.deadline_seconds = badDeadline;
      assertFault(ev, 'CONTROL_PLANE_EVIDENCE_UNCONFIRMED', `Invalid deadline_seconds=${badDeadline}`);
    }

    for (const validDeadline of [1, 15, 60, 600]) {
      const ev = makeBaseEvidence();
      ev.health.components['control-plane'].details.deadline_seconds = validDeadline;
      const res = evaluateTunnelEvidence(ev);
      assert.strictEqual(res.verified, true);
    }
  });

  test('polling state: current_poll_age_seconds bounds and type validation', () => {
    // Negative age is rejected
    const ev1 = makeBaseEvidence();
    ev1.health.components['control-plane'].details.current_poll_age_seconds = -0.5;
    assertFault(ev1, 'STALE_CONTROL_PLANE_EVIDENCE', 'Negative poll age');

    // Hung poll exceeding deadline + 5s grace is rejected
    const ev2 = makeBaseEvidence();
    ev2.health.components['control-plane'].details.deadline_seconds = 30;
    ev2.health.components['control-plane'].details.current_poll_age_seconds = 35.1;
    assertFault(ev2, 'STALE_CONTROL_PLANE_EVIDENCE', 'Poll age exceeded deadline + 5');

    // Missing, NaN, or non-finite poll age while polling is rejected
    for (const badAge of [NaN, Infinity, '1.5', null, undefined]) {
      const ev = makeBaseEvidence();
      ev.health.components['control-plane'].details.current_poll_age_seconds = badAge;
      assertFault(ev, 'STALE_CONTROL_PLANE_EVIDENCE', `Invalid current_poll_age_seconds=${badAge} during polling`);
    }

    // Valid poll age within deadline + 5 produces verified receipt
    const ev3 = makeBaseEvidence();
    ev3.health.components['control-plane'].details.deadline_seconds = 30;
    ev3.health.components['control-plane'].details.current_poll_age_seconds = 34.9;
    const res = evaluateTunnelEvidence(ev3);
    assert.strictEqual(res.verified, true);
  });

  test('strict numeric zero assertions (no string or truthy coercion)', () => {
    // consecutive_failures must be exact numeric 0
    for (const badVal of ['0', false, null, undefined]) {
      const ev = makeBaseEvidence();
      ev.health.components['control-plane'].details.consecutive_failures = badVal;
      assertFault(ev, 'CONTROL_PLANE_NOT_AUTHENTICATED', `consecutive_failures coerced ${typeof badVal}`);
    }

    // http_status must be 0 or undefined
    for (const badVal of ['0', 200, 400]) {
      const ev = makeBaseEvidence();
      ev.health.components['control-plane'].details.http_status = badVal;
      assertFault(ev, 'CONTROL_PLANE_NOT_AUTHENTICATED', `http_status=${badVal}`);
    }

    // http_status undefined (omitted in Go json) is valid
    const evOmitted = makeBaseEvidence();
    delete evOmitted.health.components['control-plane'].details.http_status;
    assert.strictEqual(evaluateTunnelEvidence(evOmitted).verified, true);
  });

  test('long-poll backpressure recovery: state="backpressured" is accepted', () => {
    const ev = makeBaseEvidence();
    ev.health.components['control-plane'].state = 'backpressured';
    // During backpressure, current_poll_age_seconds may be omitted or zero
    delete ev.health.components['control-plane'].details.current_poll_age_seconds;
    const res = evaluateTunnelEvidence(ev);
    assert.strictEqual(res.verified, true);
    assert.strictEqual(res.proof.kind, 'authenticated-control-plane');
  });

  test('long-poll idle state: state="idle" between poll rounds is accepted', () => {
    const ev = makeBaseEvidence();
    ev.health.components['control-plane'].state = 'idle';
    delete ev.health.components['control-plane'].details.current_poll_age_seconds;
    const res = evaluateTunnelEvidence(ev);
    assert.strictEqual(res.verified, true);
  });

  test('recovery from previous transient error is accepted when currently healthy', () => {
    const ev = makeBaseEvidence();
    // Recorded an error at 12:00:01.000Z, but subsequent poll succeeded at 12:00:03.000Z
    ev.health.components['control-plane'].details.last_error = '2026-11-04T12:00:01.000Z';
    ev.health.components['control-plane'].details.consecutive_failures = 0;
    ev.health.components['control-plane'].details.failure_category = '';
    const res = evaluateTunnelEvidence(ev);
    assert.strictEqual(res.verified, true);
    assert.strictEqual(res.proof.successfulPollAt, '2026-11-04T12:00:03.000Z');
  });

  test('strict verified receipt conforms to immutable core contract', () => {
    const ev = makeBaseEvidence();
    const res = evaluateTunnelEvidence(ev);
    assert.deepStrictEqual(res, {
      verified: true,
      operationId: 'op-adv-test-01',
      service: 'overleaf-mcp',
      configFingerprint: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      identity: {
        pid: 3456,
        startedAt: '2026-11-04T12:00:00.0000000Z',
        executable: 'C:\\Program Files\\OpenAI\\tunnel-client.exe'
      },
      proof: {
        kind: 'authenticated-control-plane',
        source: 'tunnel-client-0.0.19-health-schema-1',
        clientInstanceId: 'inst-prod-999',
        successfulPollAt: '2026-11-04T12:00:03.000Z',
        observedAt: '2026-11-04T12:00:04.000Z'
      }
    });
  });
});

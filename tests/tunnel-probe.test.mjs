import test from 'node:test';
import assert from 'node:assert/strict';
import { createTunnelProbe, tunnelProbe } from '../src/adapters/tunnel-probe.mjs';
import { SwitchFault } from '../src/core/switch-core.mjs';

function createValid019EvidenceFixture() {
  const identity = {
    pid: 42,
    startedAt: '2026-11-04T00:00:00.0000000Z',
    executable: 'C:\\Tools\\tunnel-client.exe'
  };
  const testTime = '2026-11-04T00:00:10Z';
  const fetchedAtMs = Date.parse(testTime);

  const health = {
    schema_version: 1,
    live: true,
    ready: true,
    snapshot_at: testTime,
    runtime: {
      instance_id: 'synthetic-instance',
      version: '0.0.19',
      started_at: '2026-11-04T00:00:01Z',
      lifecycle: 'running'
    },
    components: {
      'control-plane': {
        status: 'ok',
        state: 'polling',
        limited: false,
        observed_at: '2026-11-04T00:00:09Z',
        details: {
          last_success: '2026-11-04T00:00:08Z',
          consecutive_failures: 0,
          current_poll_age_seconds: 1,
          deadline_seconds: 15
        }
      }
    }
  };

  const adminStatus = {
    version: '0.0.19',
    client_instance_id: 'synthetic-instance',
    started_at: '2026-11-04T00:00:01Z',
    control_plane_tunnel_id: 'tunnel-auth-123',
    control_plane_base_url: 'https://api.openai.com'
  };

  return { identity, testTime, fetchedAtMs, health, adminStatus };
}

test('1. createTunnelProbe creates probe with default configuration', () => {
  const probe = createTunnelProbe();
  assert.equal(probe.isDefault, true);
  assert.equal(typeof probe.checkReady, 'function');
  assert.equal(typeof probe.verify, 'function');
});

test('2. default tunnelProbe reports isDefault: true', () => {
  assert.equal(tunnelProbe.isDefault, true);
});

test('3. checkReady returns false for invalid credentials', async () => {
  const probe = createTunnelProbe();
  assert.equal(await probe.checkReady({ credential: null }), false);
  assert.equal(await probe.checkReady({ credential: {} }), false);
  assert.equal(await probe.checkReady({ credential: { tunnelId: '' } }), false);
  assert.equal(await probe.checkReady({ credential: { apiKey: '' } }), false);
  assert.equal(await probe.checkReady({ credential: { tunnelId: 'tid\x00evil', apiKey: 'key' } }), false);
  assert.equal(await probe.checkReady({ credential: { tunnelId: 'tid', apiKey: 'key\x1fbad' } }), false);
});

test('4. checkReady succeeds static preflight on valid credentials and supported service', async () => {
  const probe = createTunnelProbe();
  const readyOverleaf = await probe.checkReady({
    service: 'overleaf-mcp',
    credential: { tunnelId: 'tunnel-123', apiKey: 'sk-123' },
    operationId: 'op-1'
  });
  assert.equal(readyOverleaf, true);

  const readyAntigravity = await probe.checkReady({
    service: 'antigravity-mcp',
    credential: { tunnelId: 'tunnel-456', apiKey: 'sk-456', organizationId: 'org-abc' },
    operationId: 'op-2'
  });
  assert.equal(readyAntigravity, true);
});

test('5. checkReady rejects unsupported service or invalid operationId', async () => {
  const probe = createTunnelProbe();
  const badService = await probe.checkReady({
    service: 'unsupported-service',
    credential: { tunnelId: 'tunnel-123', apiKey: 'sk-123' },
    operationId: 'op-bad'
  });
  assert.equal(badService, false);

  const badOp = await probe.checkReady({
    service: 'overleaf-mcp',
    credential: { tunnelId: 'tunnel-123', apiKey: 'sk-123' },
    operationId: 'op\x00nullbyte'
  });
  assert.equal(badOp, false);
});

test('6. verify fails when healthURL is missing and no endpoint provided', async () => {
  const probe = createTunnelProbe();
  const snapshot = {
    desiredFingerprint: 'f'.repeat(64),
    credential: {
      tunnelId: 'tunnel-auth-123',
      apiKey: 'sk-auth-secret'
    }
  };

  const res = await probe.verify({
    operationId: 'op-no-url',
    service: 'overleaf-mcp',
    snapshot
  });

  assert.equal(res.ok, false);
  assert.equal(res.verified, false);
  assert.equal(res.error, 'HEALTH_URL_REQUIRED');
});

test('7. verify rejects non-loopback healthURL', async () => {
  const probe = createTunnelProbe({ healthURL: 'http://example.com:8080' });
  const snapshot = {
    desiredFingerprint: 'f'.repeat(64),
    credential: {
      tunnelId: 'tunnel-auth-123',
      apiKey: 'sk-auth-secret'
    }
  };

  const res = await probe.verify({
    operationId: 'op-remote-url',
    service: 'overleaf-mcp',
    snapshot
  });

  assert.equal(res.ok, false);
  assert.equal(res.verified, false);
  assert.equal(res.error, 'NON_LOOPBACK_HEALTH_URL');
});

test('8. verify with injected raw JSON fakes produces strict authenticated-control-plane proof via GPT evidence gate', async () => {
  const fixture = createValid019EvidenceFixture();

  const fakeFetch = async (url) => {
    if (url.includes('/health')) {
      return { status: 200, json: async () => fixture.health };
    }
    if (url.includes('/api/status')) {
      return { status: 200, json: async () => fixture.adminStatus };
    }
    throw new Error('Not found: ' + url);
  };

  const probe = createTunnelProbe({
    healthURL: 'http://127.0.0.1:18080',
    fetch: fakeFetch,
    fetchedAtMs: fixture.fetchedAtMs
  });

  const snapshot = {
    desiredFingerprint: 'a'.repeat(64),
    credential: {
      tunnelId: 'tunnel-auth-123',
      apiKey: 'sk-auth-secret'
    },
    controlPlaneBaseURL: 'https://api.openai.com',
    launchedAt: '2026-11-04T00:00:00Z'
  };

  const receipt = await probe.verify({
    operationId: 'op-verify-1',
    service: 'overleaf-mcp',
    snapshot,
    identity: { ...fixture.identity },
    listenerIdentity: { ...fixture.identity },
    currentConfigFingerprint: 'a'.repeat(64)
  });

  assert.equal(receipt.ok, true);
  assert.equal(receipt.verified, true);
  assert.equal(receipt.service, 'overleaf-mcp');
  assert.equal(receipt.configFingerprint, 'a'.repeat(64));
  assert.equal(receipt.proof.kind, 'authenticated-control-plane');
  assert.equal(receipt.proof.source, 'tunnel-client-0.0.19-health-schema-1');
  assert.equal(receipt.proof.clientInstanceId, 'synthetic-instance');
  assert.equal(receipt.proof.successfulPollAt, '2026-11-04T00:00:08Z');
});

test('9. verify rejects unauthenticated control plane (consecutive failures / 401)', async () => {
  const fixture = createValid019EvidenceFixture();
  // Tamper control-plane component details to simulate unauthenticated state
  fixture.health.components['control-plane'].status = 'degraded';
  fixture.health.components['control-plane'].state = 'backoff';
  fixture.health.components['control-plane'].details.consecutive_failures = 1;
  fixture.health.components['control-plane'].details.http_status = 401;

  const fakeFetch = async (url) => {
    if (url.includes('/health')) return { status: 200, json: async () => fixture.health };
    if (url.includes('/api/status')) return { status: 200, json: async () => fixture.adminStatus };
    throw new Error('Not found');
  };

  const probe = createTunnelProbe({
    healthURL: 'http://127.0.0.1:18080',
    fetch: fakeFetch,
    fetchedAtMs: fixture.fetchedAtMs
  });

  const snapshot = {
    desiredFingerprint: 'a'.repeat(64),
    credential: { tunnelId: 'tunnel-auth-123', apiKey: 'sk-key' },
    controlPlaneBaseURL: 'https://api.openai.com',
    launchedAt: '2026-11-04T00:00:00Z'
  };

  const res = await probe.verify({
    operationId: 'op-unauth',
    service: 'overleaf-mcp',
    snapshot,
    identity: { ...fixture.identity },
    listenerIdentity: { ...fixture.identity },
    currentConfigFingerprint: 'a'.repeat(64)
  });

  assert.equal(res.ok, false);
  assert.equal(res.verified, false);
  assert.equal(res.error, 'CONTROL_PLANE_NOT_AUTHENTICATED');
});

test('10. verify rejects stale runtime snapshot via GPT evidence gate', async () => {
  const fixture = createValid019EvidenceFixture();
  const fakeFetch = async (url) => {
    if (url.includes('/health')) return { status: 200, json: async () => fixture.health };
    if (url.includes('/api/status')) return { status: 200, json: async () => fixture.adminStatus };
    throw new Error('Not found');
  };

  const probe = createTunnelProbe({
    healthURL: 'http://127.0.0.1:18080',
    fetch: fakeFetch,
    fetchedAtMs: fixture.fetchedAtMs + 6000 // 6 seconds later (> 5000ms threshold)
  });

  const snapshot = {
    desiredFingerprint: 'a'.repeat(64),
    credential: { tunnelId: 'tunnel-auth-123', apiKey: 'sk-key' },
    controlPlaneBaseURL: 'https://api.openai.com',
    launchedAt: '2026-11-04T00:00:00Z'
  };

  const res = await probe.verify({
    operationId: 'op-stale',
    service: 'overleaf-mcp',
    snapshot,
    identity: { ...fixture.identity },
    listenerIdentity: { ...fixture.identity },
    currentConfigFingerprint: 'a'.repeat(64)
  });

  assert.equal(res.ok, false);
  assert.equal(res.verified, false);
  assert.equal(res.error, 'STALE_RUNTIME_EVIDENCE');
});

test('11. verify rejects version mismatch', async () => {
  const fixture = createValid019EvidenceFixture();
  fixture.health.runtime.version = '0.0.20'; // Mismatched version

  const fakeFetch = async (url) => {
    if (url.includes('/health')) return { status: 200, json: async () => fixture.health };
    if (url.includes('/api/status')) return { status: 200, json: async () => fixture.adminStatus };
    throw new Error('Not found');
  };

  const probe = createTunnelProbe({
    healthURL: 'http://127.0.0.1:18080',
    fetch: fakeFetch,
    fetchedAtMs: fixture.fetchedAtMs
  });

  const snapshot = {
    desiredFingerprint: 'a'.repeat(64),
    credential: { tunnelId: 'tunnel-auth-123', apiKey: 'sk-key' },
    controlPlaneBaseURL: 'https://api.openai.com',
    launchedAt: '2026-11-04T00:00:00Z'
  };

  const res = await probe.verify({
    operationId: 'op-bad-version',
    service: 'overleaf-mcp',
    snapshot,
    identity: { ...fixture.identity },
    listenerIdentity: { ...fixture.identity },
    currentConfigFingerprint: 'a'.repeat(64)
  });

  assert.equal(res.ok, false);
  assert.equal(res.verified, false);
  assert.equal(res.error, 'UNSUPPORTED_TUNNEL_VERSION');
});

test('12. verify returns error on invalid credential or probe failure', async () => {
  const probe = createTunnelProbe({ shouldFail: true });
  const res = await probe.verify({
    operationId: 'op-fail',
    service: 'antigravity-mcp',
    snapshot: { credential: { tunnelId: 't', apiKey: 'k' } }
  });
  assert.equal(res.ok, false);
  assert.equal(res.verified, false);
});

test('13. verify throws SwitchFault when shouldThrow is configured', async () => {
  const probe = createTunnelProbe({ shouldThrow: true });
  await assert.rejects(
    async () => {
      await probe.verify({
        operationId: 'op-throw',
        service: 'antigravity-mcp',
        snapshot: { credential: { tunnelId: 't', apiKey: 'k' } }
      });
    },
    (err) => {
      assert.ok(err instanceof SwitchFault);
      assert.equal(err.code, 'VERIFY_FAILED');
      return true;
    }
  );
});

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  createAdapters,
  createRegisteredAdapterProvider,
  createDefaultProcessController,
  ServiceAdapter,
  SwitchFault,
  DEFAULT_PROXY
} from '../src/adapters/index.mjs';
import {
  validateHttpUrl,
  publicUrl,
  mergeHeadersPatch,
  publicHeaders,
  mergeBinding,
  publicBinding,
  bindingToTunnelCommand,
  BindingFault,
  isSensitiveName
} from '../src/adapters/mcp-binding.mjs';
import { assertStoppedConnectionReceipt, isMcpServiceId } from '../src/core/mcp-registry-policy.mjs';
import { createVault } from '../src/vault.mjs';
import {
  compileHttpTransport,
  sealHttpTransport,
  openHttpTransport,
  HTTP_HEADER_ENV_PREFIX
} from '../src/adapters/http-transport.mjs';
import { createSyntheticHttpMcp } from './fixtures/synthetic-http-mcp.mjs';
import { startFakeTunnelDaemon } from './fixtures/fake-tunnel-health.mjs';

const createdTempDirs = [];
function createTempWorkspace() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transport-test-'));
  createdTempDirs.push(tmpDir);
  const dataDir = path.join(tmpDir, 'data');
  const tunnelHome = path.join(tmpDir, 'tunnel-home');
  const appData = path.join(tmpDir, 'app-data');

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(tunnelHome, { recursive: true });
  fs.mkdirSync(path.join(appData, 'tunnel-client'), { recursive: true });

  const paths = {
    userProfile: tmpDir,
    appData,
    tunnelHome,
    tunnelClientBin: path.join(tunnelHome, 'tunnel-client.exe'),
    overleafConfigPath: path.join(appData, 'tunnel-client', 'overleaf.yaml'),
    antigravityConfigPath: path.join(appData, 'tunnel-client', 'antigravity-local.yaml'),
    overleafEnvPath: path.join(tunnelHome, 'tunnel.env')
  };

  return { tmpDir, dataDir, paths };
}

function createFakeProcessController() {
  const processes = new Map();
  const launchHistory = [];
  const stopHistory = [];

  return {
    processes,
    launchHistory,
    stopHistory,
    shouldFailVerify: false,

    async inspect(service) {
      return processes.get(service) || { running: false };
    },

    async verify(identity) {
      if (this.shouldFailVerify) {
        return { valid: false, reason: 'VERIFY_FAILED' };
      }
      return { valid: true, processId: identity?.pid };
    },

    async stop(identity) {
      this.stopHistory.push({ ...identity });
      for (const [svc, proc] of processes.entries()) {
        if (proc.pid === identity.pid) {
          processes.delete(svc);
        }
      }
      return { stopped: true };
    },

    async launch({ service, command, args, env, cwd, operationId }) {
      const identity = {
        pid: Math.floor(Math.random() * 90000) + 10000,
        executablePath: command,
        executable: command,
        startTime: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        creationTimeFileTime: '133000000000000000',
        running: true,
        service,
        command,
        args,
        env,
        cwd,
        operationId
      };
      launchHistory.push(identity);
      processes.set(service, identity);
      return identity;
    }
  };
}

function createFakeProbe({ shouldVerifySucceed = true } = {}) {
  return {
    async checkReady({ service, credential, operationId }) {
      return Boolean(credential?.tunnelId && credential?.apiKey);
    },
    async verify({ operationId, service, snapshot, identity, listenerIdentity }) {
      if (!shouldVerifySucceed) {
        return { ok: false, verified: false };
      }
      return {
        ok: true,
        verified: true,
        identity,
        proof: { kind: 'authenticated-control-plane' }
      };
    }
  };
}

// ============================================================================
// Group 1: HTTP URL Validation, Serialization, and Redaction
// ============================================================================

test('1.1 validateHttpUrl accepts valid http and https URLs', () => {
  assert.equal(validateHttpUrl('http://127.0.0.1:8080/mcp'), 'http://127.0.0.1:8080/mcp');
  assert.equal(validateHttpUrl('https://mcp.internal.example.com/api'), 'https://mcp.internal.example.com/api');
  assert.equal(validateHttpUrl('http://localhost:3000/'), 'http://localhost:3000/');
});

test('1.2 validateHttpUrl strictly rejects embedded userinfo (credentials in URL)', () => {
  assert.throws(
    () => validateHttpUrl('http://admin:secret123@127.0.0.1:8080/mcp'),
    (err) => err instanceof BindingFault && err.code === 'URL_USERINFO_FORBIDDEN'
  );
  assert.throws(
    () => validateHttpUrl('https://user@example.com/mcp'),
    (err) => err instanceof BindingFault && err.code === 'URL_USERINFO_FORBIDDEN'
  );
});

test('1.3 validateHttpUrl rejects non-HTTP/HTTPS protocols and malformed URLs', () => {
  for (const invalid of [
    'ftp://files.example.com/mcp',
    'file:///C:/Users/test/mcp',
    'ws://127.0.0.1:8080/mcp',
    'javascript:alert(1)',
    'not a url',
    '',
    null,
    undefined
  ]) {
    assert.throws(
      () => validateHttpUrl(invalid),
      (err) => err instanceof BindingFault && err.code === 'INVALID_URL',
      `Expected INVALID_URL for: ${invalid}`
    );
  }
});

test('1.4 publicUrl redacts sensitive query parameters while preserving non-sensitive parameters', () => {
  const urlWithSecrets = 'https://mcp.example.com/endpoint?apiKey=sec-999&token=abc&normal=hello&orgId=org-1';
  const sanitized = publicUrl(urlWithSecrets);

  assert.ok(!sanitized.includes('apiKey='), 'apiKey query parameter must be removed');
  assert.ok(!sanitized.includes('token='), 'token query parameter must be removed');
  assert.ok(sanitized.includes('normal=hello'), 'non-sensitive query parameter must be preserved');
  assert.ok(sanitized.includes('orgId=org-1'), 'orgId parameter must be preserved');
});

test('1.5 publicUrl rejects userinfo URLs with URL_USERINFO_FORBIDDEN', () => {
  assert.throws(
    () => publicUrl('http://user:pass@127.0.0.1:8080/mcp'),
    (err) => err instanceof BindingFault && err.code === 'URL_USERINFO_FORBIDDEN'
  );
});

// ============================================================================
// Group 2: Secret HTTP Headers Handling, Retention, and Masking
// ============================================================================

test('2.1 mergeHeadersPatch sets and removes headers with default secret: true', () => {
  const previous = {
    'X-Custom': { value: 'custom-v1', secret: false }
  };

  const patch = [
    { op: 'set', name: 'Authorization', value: 'Bearer token-123' },
    { op: 'set', name: 'X-New-Public', value: 'public-data', secret: false },
    { op: 'remove', name: 'X-Custom' }
  ];

  const merged = mergeHeadersPatch(previous, patch);

  // Authorization must be present and automatically marked secret
  assert.ok(merged.Authorization);
  assert.equal(merged.Authorization.value, 'Bearer token-123');
  assert.equal(merged.Authorization.secret, true);

  // X-New-Public is explicitly set to secret: false
  assert.ok(merged['X-New-Public']);
  assert.equal(merged['X-New-Public'].value, 'public-data');
  assert.equal(merged['X-New-Public'].secret, false);

  // X-Custom was removed
  assert.equal(merged['X-Custom'], undefined);
});

test('2.2 mergeHeadersPatch prevents unmasking sensitive header names even if secret: false is passed', () => {
  const patch = [
    { op: 'set', name: 'Authorization', value: 'Bearer sec', secret: false },
    { op: 'set', name: 'X-API-KEY', value: 'key-val', secret: false },
    { op: 'set', name: 'Cookie', value: 'sess=abc', secret: false }
  ];

  const merged = mergeHeadersPatch({}, patch);

  assert.equal(merged.Authorization.secret, true, 'Authorization must remain secret');
  assert.equal(merged['X-API-KEY'].secret, true, 'X-API-KEY must remain secret');
  assert.equal(merged.Cookie.secret, true, 'Cookie must remain secret');
});

test('2.3 mergeHeadersPatch rejects invalid header names or values', () => {
  // Invalid header name with spaces or colon
  assert.throws(
    () => mergeHeadersPatch({}, [{ op: 'set', name: 'Bad Name:', value: 'val' }]),
    (err) => err instanceof BindingFault && err.code === 'INVALID_HEADER_NAME'
  );

  // Null byte in header value
  assert.throws(
    () => mergeHeadersPatch({}, [{ op: 'set', name: 'X-Test', value: 'val\0poison' }]),
    (err) => err instanceof BindingFault && err.code === 'INVALID_HEADER_VALUE'
  );
});

test('2.4 publicHeaders masks secret header values and exposes only non-secret values', () => {
  const headers = {
    Authorization: { value: 'Bearer secret-token', secret: true },
    'X-API-Key': { value: 'secret-key-123', secret: true },
    'X-App-Name': { value: 'my-mcp-client', secret: false }
  };

  const pub = publicHeaders(headers);

  // Secret headers must have secret: true, configured: true, and NO value property
  assert.deepEqual(pub.Authorization, { secret: true, configured: true });
  assert.equal('value' in pub.Authorization, false);

  assert.deepEqual(pub['X-API-Key'], { secret: true, configured: true });
  assert.equal('value' in pub['X-API-Key'], false);

  // Non-secret header includes configured: true, secret: false, and plaintext value
  assert.deepEqual(pub['X-App-Name'], {
    secret: false,
    configured: true,
    value: 'my-mcp-client'
  });
});

// ============================================================================
// Group 3: HTTP Binding Merging and Public Representation
// ============================================================================

test('3.1 mergeBinding merges HTTP binding retaining unchanged fields across patches', () => {
  const initial = mergeBinding({}, {
    type: 'http',
    url: 'https://mcp.initial.example.com/api',
    headers: [
      { op: 'set', name: 'Authorization', value: 'Bearer tok-1' }
    ]
  });

  assert.equal(initial.type, 'http');
  assert.equal(initial.url, 'https://mcp.initial.example.com/api');
  assert.equal(initial.headers.Authorization.value, 'Bearer tok-1');

  // Patch updating only URL must retain existing headers
  const patchedUrl = mergeBinding(initial, {
    url: 'https://mcp.updated.example.com/api'
  });
  assert.equal(patchedUrl.url, 'https://mcp.updated.example.com/api');
  assert.equal(patchedUrl.headers.Authorization.value, 'Bearer tok-1');

  // Patch updating only headers must retain existing URL
  const patchedHeaders = mergeBinding(initial, {
    headers: [
      { op: 'set', name: 'X-Extra', value: 'extra-val', secret: false }
    ]
  });
  assert.equal(patchedHeaders.url, 'https://mcp.initial.example.com/api');
  assert.ok(patchedHeaders.headers['X-Extra']);
  assert.ok(patchedHeaders.headers.Authorization);
});

test('3.2 publicBinding redacts HTTP binding secrets in public representation', () => {
  const binding = {
    type: 'http',
    url: 'https://mcp.example.com/mcp?apiKey=secret-key&channel=main',
    headers: {
      Authorization: { value: 'Bearer secret-token', secret: true },
      'X-Client': { value: 'client-1', secret: false }
    }
  };

  const pub = publicBinding(binding);

  assert.equal(pub.type, 'http');
  assert.equal(pub.hasPrivateQuery, true, 'hasPrivateQuery must be true for private query params');
  assert.equal(pub.urlConfigured, true);
  assert.equal(pub.url, undefined, 'raw url must be omitted when query contains private params');
  assert.equal(pub.urlDisplay, 'https://mcp.example.com/mcp');
  assert.doesNotMatch(pub.urlDisplay, /apiKey=/);
  assert.equal(pub.headers.Authorization.value, undefined, 'Secret header value must not be present');
  assert.equal(pub.headers.Authorization.secret, true);
  assert.equal(pub.headers['X-Client'].value, 'client-1');
  assert.equal(pub.headers['X-Client'].secret, false);

  // For public URL without private query, url is retained for compatibility
  const publicNoQuery = publicBinding({
    type: 'http',
    url: 'https://mcp.example.com/api',
    headers: {}
  });
  assert.equal(publicNoQuery.url, 'https://mcp.example.com/api');
  assert.equal(publicNoQuery.urlDisplay, 'https://mcp.example.com/api');
  assert.equal(Boolean(publicNoQuery.hasPrivateQuery), false);
});

// ============================================================================
// Group 4: Registered Provider Pinning and Per-Operation Snapshot Isolation
// ============================================================================

test('4.1 createRegisteredAdapterProvider pins definitions strictly to op.registrySnapshot', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const processController = createFakeProcessController();
  const probe = createFakeProbe();

  const provider = createRegisteredAdapterProvider({ dataDir, paths, processController, probe });

  const op1 = {
    id: 'op-pin-1',
    registrySnapshot: {
      revision: 1,
      services: [
        {
          id: 'mcp_http_service',
          label: 'HTTP MCP Service V1',
          binding: {
            type: 'http',
            url: 'https://mcp-v1.example.com/mcp',
            headers: { Authorization: { value: 'Bearer v1', secret: true } }
          }
        }
      ]
    }
  };

  const adapter1 = await provider(op1, 'mcp_http_service');
  assert.ok(adapter1, 'Adapter must be returned for registered service in snapshot');
  assert.equal(adapter1.definition.binding.url, 'https://mcp-v1.example.com/mcp');

  // Operation 2 with different definition revision for same service ID
  const op2 = {
    id: 'op-pin-2',
    registrySnapshot: {
      revision: 2,
      services: [
        {
          id: 'mcp_http_service',
          label: 'HTTP MCP Service V2',
          binding: {
            type: 'http',
            url: 'https://mcp-v2.example.com/mcp',
            headers: { Authorization: { value: 'Bearer v2', secret: true } }
          }
        }
      ]
    }
  };

  const adapter2 = await provider(op2, 'mcp_http_service');
  assert.notEqual(adapter1, adapter2, 'Different operations must receive independent adapter instances');
  assert.equal(adapter2.definition.binding.url, 'https://mcp-v2.example.com/mcp');

  // Re-requesting adapter for op1 must still yield original pinned V1 definition
  const adapter1Recheck = await provider(op1, 'mcp_http_service');
  assert.equal(adapter1Recheck, adapter1, 'Cached instance for op1 must be retained');
  assert.equal(adapter1Recheck.definition.binding.url, 'https://mcp-v1.example.com/mcp');
});

test('4.2 provider.release(opId) evicts operation cache and isolates unlisted services', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const processController = createFakeProcessController();
  const probe = createFakeProbe();

  const provider = createRegisteredAdapterProvider({ dataDir, paths, processController, probe });

  const op = {
    id: 'op-evict-test',
    registrySnapshot: {
      services: [
        { id: 'mcp_registered_only' }
      ]
    }
  };

  const firstInstance = await provider(op, 'mcp_registered_only');
  assert.ok(firstInstance);

  // Unlisted service returns undefined
  const unlisted = await provider(op, 'mcp_unlisted');
  assert.equal(unlisted, undefined, 'Unlisted service in snapshot must return undefined');

  // Evict cache
  provider.release('op-evict-test');

  // Subsequent call creates a new instance
  const secondInstance = await provider(op, 'mcp_registered_only');
  assert.notEqual(firstInstance, secondInstance, 'Provider must re-instantiate adapter after release');
});

test('4.3 Legacy operation without registrySnapshot falls back to legacy two adapters', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const processController = createFakeProcessController();
  const probe = createFakeProbe();

  const provider = createRegisteredAdapterProvider({ dataDir, paths, processController, probe });

  const legacyOp = { id: 'op-legacy-call' }; // no registrySnapshot

  const overleaf = await provider(legacyOp, 'overleaf-mcp');
  const antigravity = await provider(legacyOp, 'antigravity-mcp');
  const custom = await provider(legacyOp, 'mcp_custom');

  assert.ok(overleaf, 'Legacy operation must resolve overleaf-mcp');
  assert.ok(antigravity, 'Legacy operation must resolve antigravity-mcp');
  assert.equal(custom, undefined, 'Legacy operation must not resolve unregistered services');
});

// ============================================================================
// Group 5: Wrong Target, 401 Rejection, and Process Identity Protection
// ============================================================================

test('5.1 ServiceAdapter rejects wrong target or mismatched serviceId', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const processController = createFakeProcessController();
  const probe = createFakeProbe();

  const adapter = new ServiceAdapter({
    service: 'mcp_target_a',
    dataDir,
    processController,
    probe,
    paths
  });

  // applyIfUnchanged with mismatched snapshot service
  await assert.rejects(
    async () => {
      await adapter.applyIfUnchanged({
        operationId: 'op-mismatch-1',
        snapshot: { service: 'mcp_target_b', originalFingerprint: 'xxx' }
      });
    },
    (err) => err instanceof SwitchFault && err.code === 'SERVICE_MISMATCH'
  );

  // stopConnection with mismatched serviceId
  await assert.rejects(
    async () => {
      await adapter.stopConnection({
        operationId: 'op-mismatch-2',
        serviceId: 'mcp_target_b'
      });
    },
    (err) => err instanceof SwitchFault && err.code === 'SERVICE_MISMATCH'
  );

  // stopConnection with invalid target format
  await assert.rejects(
    async () => {
      await adapter.stopConnection({
        operationId: 'op-invalid',
        serviceId: 'bad service name!!'
      });
    },
    (err) => err instanceof SwitchFault && (err.code === 'SERVICE_MISMATCH' || err.code === 'INVALID_TARGETS')
  );
});

test('5.2 Authentication failure (401 / unauthenticated) rejects during probe verification', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const processController = createFakeProcessController();
  // Probe that simulates 401 unauthenticated response
  const failingProbe = createFakeProbe({ shouldVerifySucceed: false });

  const adapter = new ServiceAdapter({
    service: 'mcp_auth_fail',
    dataDir,
    processController,
    probe: failingProbe,
    paths
  });

  const snapshot = {
    service: 'mcp_auth_fail',
    desiredFingerprint: 'fprint-1',
    credential: { tunnelId: 'tunnel_bad', apiKey: 'bad_key' }
  };

  await assert.rejects(
    async () => {
      await adapter.verifyDesired({
        operationId: 'op-verify-fail',
        snapshot
      });
    },
    (err) => err instanceof SwitchFault && err.code === 'VERIFY_FAILED'
  );
});

test('5.3 stopConnection rejects unmanaged process without killing it', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const processController = createFakeProcessController();
  const probe = createFakeProbe();

  const adapter = new ServiceAdapter({
    service: 'mcp_unmanaged_test',
    dataDir,
    processController,
    probe,
    paths
  });

  // Simulate an active process on the system that is NOT recorded in the manager's process file
  processController.processes.set('mcp_unmanaged_test', {
    pid: 99999,
    executable: 'foreign-process.exe',
    running: true,
    startTime: new Date().toISOString()
  });

  await assert.rejects(
    async () => {
      await adapter.stopConnection({
        operationId: 'op-foreign-stop',
        serviceId: 'mcp_unmanaged_test'
      });
    },
    (err) => err instanceof SwitchFault && err.code === 'PROCESS_IDENTITY_MISMATCH'
  );

  // Ensure foreign process was NOT terminated
  assert.equal(processController.stopHistory.length, 0, 'Unmanaged process must not be stopped');
  assert.equal(processController.processes.has('mcp_unmanaged_test'), true, 'Foreign process must remain untouched');
});

test('5.4 stopConnection returns verified-already-stopped when process is not running', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const processController = createFakeProcessController();
  const probe = createFakeProbe();

  const adapter = new ServiceAdapter({
    service: 'mcp_stopped_test',
    dataDir,
    processController,
    probe,
    paths
  });

  const receipt = await adapter.stopConnection({
    operationId: 'op-already-stopped',
    serviceId: 'mcp_stopped_test'
  });

  assert.equal(receipt.stopped, true);
  assert.equal(receipt.proof.kind, 'verified-already-stopped');
  assertStoppedConnectionReceipt(receipt, 'op-already-stopped', 'mcp_stopped_test');
});

// ============================================================================
// Group 6: Exact Actual Protocol Blocker for Advertised HTTP Binding in 0.0.19
// ============================================================================

test('6.1 bindingToTunnelCommand explicitly blocks HTTP bindings with UNSUPPORTED_BINDING_FOR_COMMAND', () => {
  const httpBinding = {
    type: 'http',
    url: 'https://mcp.openai.com/api',
    headers: {
      Authorization: { value: 'Bearer test-token', secret: true }
    }
  };

  assert.throws(
    () => bindingToTunnelCommand(httpBinding),
    (err) => err instanceof BindingFault && err.code === 'UNSUPPORTED_BINDING_FOR_COMMAND',
    'bindingToTunnelCommand must throw UNSUPPORTED_BINDING_FOR_COMMAND for HTTP bindings'
  );
});

test('6.2 Registered provider pins HTTP definition snapshot and compiles secure transport plan with vault', async (t) => {
  const { dataDir, paths, tmpDir } = createTempWorkspace();
  const processController = createFakeProcessController();
  const probe = createFakeProbe();
  const vault = createVault({ dataDir });

  t.after(() => {
    try { vault.close(); } catch (_) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  const httpDefinition = {
    id: 'mcp_http_sample',
    label: 'Remote HTTP MCP',
    binding: {
      type: 'http',
      url: 'https://mcp.remote.example.com/mcp?token=private-url-token&channel=main,secondary',
      headers: {
        Authorization: { value: 'Bearer secret_api_token', secret: true },
        'X-Tenant': { value: 'tenant-42', secret: false }
      }
    }
  };

  const op = {
    id: 'op-http-factory-test',
    registrySnapshot: {
      revision: 1,
      services: [httpDefinition]
    }
  };

  const provider = createRegisteredAdapterProvider({
    dataDir,
    paths,
    processController,
    probe,
    vault
  });

  const adapter = await provider(op, 'mcp_http_sample');
  assert.ok(adapter, 'Provider must construct adapter for registered HTTP service');
  assert.equal(adapter.service, 'mcp_http_sample');
  assert.equal(adapter.definition.binding.type, 'http');
  assert.equal(adapter.definition.binding.url, httpDefinition.binding.url);

  // Compile transport plan with strict privacy enforcement
  const context = { serviceId: adapter.service, operationId: op.id };
  const plan = compileHttpTransport(adapter.definition.binding, context);

  // 1. Raw MCP_SERVER_URL preserves query parameters and commas in environment
  assert.equal(plan.privateEnvironment.MCP_SERVER_URL, httpDefinition.binding.url);
  assert.equal(plan.channel, 'main');

  // 2. Secret query and header values NEVER appear on CLI arguments
  const argsString = JSON.stringify(plan.args);
  assert.doesNotMatch(argsString, /private-url-token/);
  assert.doesNotMatch(argsString, /secret_api_token/);

  // 3. Header CLI args strictly reference environment variables with TUNNEL_CLIENT_MCP_HEADER_ prefix
  assert.equal(plan.headerNames.length, 2);
  for (let i = 0; i < plan.args.length; i += 2) {
    assert.equal(plan.args[i], '--mcp.extra-headers');
    assert.match(plan.args[i + 1], new RegExp(`: env:${HTTP_HEADER_ENV_PREFIX}[A-F0-9]{24}$`));
  }

  // 4. Sealed HTTP transport packet encrypts private environment with AES-256-GCM and restores cleanly
  const packet = await sealHttpTransport(vault, adapter.definition.binding, context);
  assert.doesNotMatch(JSON.stringify(packet), /private-url-token/);
  assert.doesNotMatch(JSON.stringify(packet), /secret_api_token/);

  const restored = await openHttpTransport(vault, packet, context);
  assert.deepEqual(restored, plan);
});

test('6.3 Independent strict fake-daemon consumer uses MCP_SERVER_URL and header env refs to forward to synthetic MCP endpoint', async (t) => {
  const syntheticMcp = createSyntheticHttpMcp();
  const mcpInfo = await syntheticMcp.start();

  let daemon = null;
  t.after(async () => {
    if (daemon) {
      try { await daemon.close(); } catch (_) {}
    }
    try { await syntheticMcp.close(); } catch (_) {}
  });

  const targetUrl = `${mcpInfo.endpoint}?sig=signed-query-token&parts=a,b,c`;
  const context = { serviceId: 'mcp_consumer_target', operationId: 'op-consumer-test' };
  const binding = {
    type: 'http',
    url: targetUrl,
    headers: {
      Authorization: { value: 'Bearer synthetic-secret-bearer-999', secret: true },
      'X-Tracking-Id': { value: 'trk-uuid-12345', secret: false }
    }
  };

  const plan = compileHttpTransport(binding, context);

  // Extract extra-headers CLI arguments
  const extraHeaders = [];
  for (let i = 0; i < plan.args.length; i += 2) {
    if (plan.args[i] === '--mcp.extra-headers') {
      extraHeaders.push(plan.args[i + 1]);
    }
  }

  // Consumer starts in HTTP mode with MCP_SERVER_URL and child private environment
  daemon = startFakeTunnelDaemon({
    mcpServerUrl: plan.privateEnvironment.MCP_SERVER_URL,
    extraHeaders,
    env: plan.privateEnvironment
  });

  const daemonInfo = await daemon.start('127.0.0.1', 0);
  assert.ok(daemonInfo.port > 0);

  // Verify that the synthetic MCP server received the exact URL and resolved headers
  const requests = syntheticMcp.getRequests();
  assert.equal(requests.length >= 1, true, 'Synthetic MCP server must receive forwarded request');

  const received = requests[0];
  assert.equal(
    received.url,
    `/mcp?sig=signed-query-token&parts=a,b,c`,
    'Synthetic MCP must receive exact signed URL path and query with commas preserved'
  );
  assert.equal(
    received.headers['authorization'],
    'Bearer synthetic-secret-bearer-999',
    'Synthetic MCP must receive exact resolved Authorization secret'
  );
  assert.equal(
    received.headers['x-tracking-id'],
    'trk-uuid-12345',
    'Synthetic MCP must receive exact resolved tracking header'
  );
  assert.doesNotMatch(
    received.headers['authorization'],
    /env:/,
    'Synthetic MCP must not receive unresolved env: reference'
  );
});

after(() => {
  for (const d of createdTempDirs) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch (_) {}
  }
});

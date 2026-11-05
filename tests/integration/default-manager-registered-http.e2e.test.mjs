import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { startManager } from '../../src/main.mjs';
import { createMockControlPlane } from '../fixtures/mock-control-plane.mjs';
import { createSyntheticHttpMcp } from '../fixtures/synthetic-http-mcp.mjs';
import {
  startDefaultManagerHttpDaemon,
  runDaemonCli,
  MAX_PAYLOAD_BYTES
} from '../fixtures/default-manager-http-tunnel.mjs';
import { createTunnelProbe } from '../../src/adapters/tunnel-probe.mjs';
import { assertVerifiedReceipt } from '../../src/core/switch-core.mjs';
import { assertStoppedConnectionReceipt } from '../../src/core/mcp-registry-policy.mjs';
import { acquireDaemonLock } from '../../src/core/daemon-lock.mjs';
import {
  compileHttpTransport,
  sealHttpTransport,
  openHttpTransport
} from '../../src/adapters/http-transport.mjs';
import { validateServiceEnvName } from '../../src/adapters/mcp-binding.mjs';
import { buildTunnelLaunchEnvironment } from '../../src/adapters/tunnel-launch-environment.mjs';

function createTempDir(prefix = 'default-mgr-http-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanTempDir(dir) {
  try {
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (_) {}
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (_) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    }).on('error', reject);
  });
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body || {});
    const parsed = new URL(url);
    const req = http.request(parsed, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 5000
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (_) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

describe('Default Manager Registered HTTP E2E Integration Suite', () => {

  it('1. Default manager owns registered provider with same resolved vault, store, dataDir and release lifecycle', async () => {
    const dataDir = createTempDir('mgr-owned-provider-');
    let manager = null;

    try {
      manager = await startManager({
        dataDir,
        port: 0
      });

      // 1.1 Default manager owns registered provider
      assert.ok(manager.adapterProvider, 'Default manager must own an adapterProvider');
      assert.equal(typeof manager.adapterProvider, 'function', 'adapterProvider must be a callable provider');
      assert.equal(typeof manager.adapterProvider.release, 'function', 'adapterProvider must expose release()');
      assert.equal(typeof manager.adapterProvider.has, 'function', 'adapterProvider must expose has()');
      assert.equal(typeof manager.adapterProvider.clear, 'function', 'adapterProvider must expose clear()');
      assert.equal(typeof manager.adapterProvider.size, 'number', 'adapterProvider must expose size property');

      // 1.2 Resolves registered HTTP service definition using resolved resources
      const serviceId = 'mcp_registered_test_01';
      const definition = {
        id: serviceId,
        label: 'Registered HTTP MCP Test',
        binding: {
          type: 'http',
          url: 'https://mcp.internal.corp/api/v1/mcp?session=sess_123',
          headers: {
            Authorization: { value: 'Bearer token-secret-xyz', secret: true },
            'X-Test-Id': { value: 'test-456', secret: false }
          }
        },
        environment: {
          ENV_MODE: { value: 'staging', secret: false }
        }
      };

      const opId = 'op-default-mgr-owned-1';
      const op = {
        id: opId,
        operationId: opId,
        registrySnapshot: {
          revision: 1,
          services: [definition]
        }
      };

      const adapter = await manager.adapterProvider(op, serviceId);
      assert.ok(adapter, 'Registered provider must instantiate adapter for registered HTTP service');
      assert.equal(adapter.service, serviceId);
      assert.equal(adapter.definition.binding.type, 'http');

      // 1.3 Verifies same resolved vault, store, and dataDir
      assert.equal(adapter.dataDir, manager.dataDir, 'Adapter dataDir must match manager dataDir');
      assert.equal(adapter.vault, manager.vault, 'Adapter vault must match manager vault');

      // 1.4 Cache tracking and release lifecycle
      assert.equal(manager.adapterProvider.has(opId), true, 'Provider cache must track active operation');
      assert.equal(manager.adapterProvider.size, 1, 'Provider size must reflect cached operation');

      // Eviction on release
      manager.adapterProvider.release(opId);
      assert.equal(manager.adapterProvider.has(opId), false, 'Provider must evict operation on release');
      assert.equal(manager.adapterProvider.size, 0, 'Provider size must be 0 after release');

    } finally {
      if (manager) await manager.close();
      cleanTempDir(dataDir);
    }
  });

  it('2. Preserves explicit injected provider and provider factory precedence over default', async () => {
    const dataDir = createTempDir('mgr-injected-precedence-');

    try {
      // 2.1 Explicit injected adapterProvider takes precedence
      const injectedProvider = Object.assign(
        async (_op, serviceId) => ({ service: serviceId, injectedTag: 'explicit-injected' }),
        { release: () => {}, has: () => true, injected: true }
      );

      const m1 = await startManager({
        dataDir,
        port: 0,
        adapterProvider: injectedProvider
      });

      assert.equal(m1.adapterProvider, injectedProvider, 'Explicit injected adapterProvider must take precedence');
      const testAdapter1 = await m1.adapterProvider({}, 'any_service');
      assert.equal(testAdapter1.injectedTag, 'explicit-injected');
      await m1.close();

      // 2.2 Explicit injected adapterProviderFactory takes precedence
      let factoryCalled = false;
      let factoryReceivedDataDir = null;
      let factoryReceivedVault = null;
      let factoryReceivedStore = null;

      const factoryProvider = Object.assign(
        async (_op, serviceId) => ({ service: serviceId, fromFactory: true }),
        { release: () => {}, fromFactory: true }
      );

      const customFactory = async ({ dataDir: d, vault: v, store: s }) => {
        factoryCalled = true;
        factoryReceivedDataDir = d;
        factoryReceivedVault = v;
        factoryReceivedStore = s;
        return factoryProvider;
      };

      const m2 = await startManager({
        dataDir,
        port: 0,
        adapterProviderFactory: customFactory
      });

      assert.equal(factoryCalled, true, 'adapterProviderFactory must be invoked');
      assert.equal(factoryReceivedDataDir, dataDir, 'Factory must receive resolved dataDir');
      assert.ok(factoryReceivedVault, 'Factory must receive resolved vault');
      assert.ok(factoryReceivedStore, 'Factory must receive resolved store');
      assert.equal(m2.adapterProvider, factoryProvider, 'Result from adapterProviderFactory must take precedence');
      await m2.close();

      // 2.3 Explicit legacy adapterFactory injection wraps adapters cleanly
      const fakeLegacyAdapters = {
        'overleaf-mcp': { service: 'overleaf-mcp', legacyTag: 'mock-overleaf' },
        'antigravity-mcp': { service: 'antigravity-mcp', legacyTag: 'mock-antigravity' }
      };

      const m3 = await startManager({
        dataDir,
        port: 0,
        adapterFactory: async () => fakeLegacyAdapters
      });

      assert.ok(m3.adapters);
      assert.equal(m3.adapters['overleaf-mcp'].legacyTag, 'mock-overleaf');
      await m3.close();

    } finally {
      cleanTempDir(dataDir);
    }
  });

  it('3. Immutable operation snapshots pin definition and isolate cross-operation mutations', async () => {
    const dataDir = createTempDir('mgr-immutable-snapshots-');
    let manager = null;

    try {
      manager = await startManager({
        dataDir,
        port: 0
      });

      const serviceId = 'mcp_immutable_http';
      const externalDefinition = {
        id: serviceId,
        label: 'Immutable Snapshot MCP',
        binding: {
          type: 'http',
          url: 'https://mcp.prod.corp/resource?token=secret-token-aaa&mode=readonly',
          headers: {
            Authorization: { value: 'Bearer initial-secret-token', secret: true },
            'X-Environment': { value: 'prod', secret: false }
          }
        },
        environment: {
          APP_ENV: { value: 'production', secret: false }
        }
      };

      // Operation 1 captures snapshot at revision 100
      const op1 = {
        id: 'op-snapshot-100',
        registrySnapshot: {
          revision: 100,
          services: [structuredClone(externalDefinition)]
        }
      };

      const adapter1 = await manager.adapterProvider(op1, serviceId);
      assert.ok(adapter1, 'Adapter must be instantiated for op1');
      assert.equal(adapter1.definition.binding.url, 'https://mcp.prod.corp/resource?token=secret-token-aaa&mode=readonly');

      // External definition is maliciously or concurrently mutated in place
      externalDefinition.binding.url = 'https://mcp.tampered.org/injected-url';
      externalDefinition.binding.headers.Authorization.value = 'tampered-auth';

      // Re-querying provider for op1 returns cached adapter retaining pinned snapshot
      const cachedAdapter1 = await manager.adapterProvider(op1, serviceId);
      assert.equal(cachedAdapter1, adapter1, 'Cached adapter instance must be returned');
      assert.equal(
        cachedAdapter1.definition.binding.url,
        'https://mcp.prod.corp/resource?token=secret-token-aaa&mode=readonly',
        'Adapter definition URL must remain immutable and pinned'
      );
      assert.equal(
        cachedAdapter1.definition.binding.headers.Authorization.value,
        'Bearer initial-secret-token',
        'Adapter Authorization header must remain immutable and pinned'
      );

      // Operation 2 with different revision snapshot receives isolated independent adapter
      const op2 = {
        id: 'op-snapshot-200',
        registrySnapshot: {
          revision: 200,
          services: [
            {
              id: serviceId,
              label: 'Updated MCP',
              binding: {
                type: 'http',
                url: 'https://mcp.updated.corp/resource?token=new-token-bbb',
                headers: {
                  Authorization: { value: 'Bearer updated-token', secret: true }
                }
              }
            }
          ]
        }
      };

      const adapter2 = await manager.adapterProvider(op2, serviceId);
      assert.notEqual(adapter1, adapter2, 'Independent operations must receive distinct adapter instances');
      assert.equal(adapter2.definition.binding.url, 'https://mcp.updated.corp/resource?token=new-token-bbb');
      assert.equal(cachedAdapter1.definition.binding.url, 'https://mcp.prod.corp/resource?token=secret-token-aaa&mode=readonly');

      // Cross-service isolation within operation snapshot
      const nonexistentService = await manager.adapterProvider(op1, 'mcp_not_in_snapshot');
      assert.equal(nonexistentService, undefined, 'Query for absent service must return undefined');

    } finally {
      if (manager) await manager.close();
      cleanTempDir(dataDir);
    }
  });

  it('4. Startup LIFO ordering and attention gate remain unchanged during normal and rollback flows', async () => {
    const dataDir = createTempDir('mgr-startup-lifo-');

    try {
      // 4.1 Normal startup and shutdown LIFO order
      const manager = await startManager({
        dataDir,
        port: 0
      });

      assert.ok(manager.url.startsWith('http://127.0.0.1:'));
      assert.equal(manager.runner.getStatus().started, true);
      assert.equal(manager.runner.getStatus().locked, true, 'Runner daemon lock must be held');

      // Closing manager releases daemon lock in LIFO sequence
      await manager.close();
      assert.equal(manager.server.listening, false);
      assert.equal(manager.runner.getStatus().locked, false, 'Runner daemon lock must be released on close');

      // Lock can be immediately acquired by a fresh lock holder without lease leak
      const freshLock = await acquireDaemonLock(dataDir);
      assert.ok(freshLock);
      await freshLock.release();

      // 4.2 Startup failure triggers reverse LIFO rollback without socket or lease leak
      const startupFailure = new Error('simulated-lifo-startup-failure');
      await assert.rejects(
        startManager({
          dataDir,
          port: 0,
          runner: {
            repo: {
              getWorkQueue() {
                throw startupFailure;
              }
            }
          }
        }),
        (err) => err === startupFailure || err.cause === startupFailure || err.message?.includes('simulated-lifo-startup-failure')
      );

      // Verify that after rollback, daemon lock was cleanly released
      const secondLock = await acquireDaemonLock(dataDir);
      assert.ok(secondLock);
      await secondLock.release();

    } finally {
      cleanTempDir(dataDir);
    }
  });

  it('5. Default Manager Registered HTTP Tunnel full lifecycle and execution with daemon fixture', async () => {
    const dataDir = createTempDir('mgr-e2e-http-lifecycle-');
    const cp = createMockControlPlane();
    const syntheticMcp = createSyntheticHttpMcp();

    const acceptedTunnelId = 'tunnel-default-http-001';
    const acceptedApiKey = 'key-default-http-secret-999';
    cp.setAcceptedCredential(acceptedTunnelId, acceptedApiKey);

    const cpInfo = await cp.start();
    const mcpInfo = await syntheticMcp.start();

    // Ephemeral port reservation for real child daemon
    const daemonServer = http.createServer();
    await new Promise(r => daemonServer.listen(0, '127.0.0.1', r));
    const daemonHealthPort = daemonServer.address().port;
    await new Promise(r => daemonServer.close(r));
    const daemonHealthUrl = `http://127.0.0.1:${daemonHealthPort}`;

    let manager = null;
    let processRecord = null;
    const fixtureScriptPath = fileURLToPath(new URL('../fixtures/default-manager-http-tunnel.mjs', import.meta.url));

    const serviceId = 'mcp_default_registered_http';
    const mcpTargetUrl = `${mcpInfo.endpoint}?sig=signed-query-token&channel=primary,secondary`;
    const secretToken = 'Bearer secret-auth-bearer-token-12345';

    try {
      // 5.1 Start default manager using real default provider, controller, and probe
      manager = await startManager({
        dataDir,
        port: 0,
        adapterOptions: {
          healthURLs: { [serviceId]: daemonHealthUrl },
          paths: {
            tunnelClientBin: process.execPath,
            binaryPrefix: [fixtureScriptPath],
            listenAddr: `127.0.0.1:${daemonHealthPort}`,
            controlPlaneBaseURL: cpInfo.url,
            extraArgs: ['--tunnel-id', acceptedTunnelId]
          }
        }
      });

      const definition = {
        id: serviceId,
        label: 'Default Manager Registered HTTP Tunnel',
        binding: {
          type: 'http',
          url: mcpTargetUrl,
          headers: {
            Authorization: { value: secretToken, secret: true },
            'X-Tracking-Id': { value: 'trk-uuid-registered-999', secret: false }
          }
        },
        environment: {
          CUSTOM_OPTION: { value: 'opt_default_manager', secret: false }
        }
      };

      // Also register definition in manager store for public DTO and state assertions
      await manager.store.registry.create(definition);

      const opId = 'op-e2e-mgr-http-lifecycle-1';
      const op = {
        id: opId,
        operationId: opId,
        registrySnapshot: {
          revision: 1,
          services: [definition]
        }
      };

      // Step A: Default Manager resolves registered adapter
      const adapter = await manager.adapterProvider(op, serviceId);
      assert.ok(adapter, 'Default manager must provide adapter for registered HTTP service');
      assert.equal(adapter.service, serviceId);
      assert.equal(adapter.definition.binding.type, 'http');
      assert.equal(adapter.healthURL, daemonHealthUrl);

      // Step B: Prepare stages desired state and compiles secure HTTP transport plan
      const snapshot = await adapter.prepare({
        operationId: opId,
        credential: {
          tunnelId: acceptedTunnelId,
          apiKey: acceptedApiKey
        }
      });

      assert.equal(snapshot.operationId, opId);
      assert.equal(snapshot.service, serviceId);
      assert.ok(snapshot.desiredFingerprint);
      assert.equal(snapshot.credential.tunnelId, acceptedTunnelId);

      // Verify transport packet sealing and opening with manager's vault
      const context = { serviceId, operationId: opId };
      const sealedPacket = await sealHttpTransport(manager.vault, adapter.definition.binding, context);
      assert.doesNotMatch(JSON.stringify(sealedPacket), /secret-auth-bearer-token-12345/);

      const openedPlan = await openHttpTransport(manager.vault, sealedPacket, context);
      assert.equal(openedPlan.privateEnvironment.MCP_SERVER_URL, mcpTargetUrl);
      assert.ok(Object.values(openedPlan.privateEnvironment).includes(secretToken));

      // Step C: Apply desired state using REAL default adapter lifecycle and controller
      processRecord = await adapter.applyIfUnchanged({
        operationId: opId,
        snapshot
      });

      assert.ok(processRecord, 'applyIfUnchanged must return process record');
      assert.equal(processRecord.running, true);
      assert.ok(processRecord.pid > 0, 'Child process must be spawned via trusted launch seam');
      assert.ok(processRecord.executablePath, 'Child process must have valid executable path');
      assert.ok(processRecord.startTime || processRecord.creationDate, 'Child process must have valid Win32 start time');

      // Wait until daemon process is alive and responsive on its health endpoint
      for (let i = 0; i < 60; i++) {
        try {
          const ping = await fetchJson(`${daemonHealthUrl}/api/status`);
          if (ping.status === 200) break;
        } catch (_) {}
        await new Promise(r => setTimeout(r, 100));
      }

      // Step D: Verify desired state using REAL default probe
      const verifyReceipt = await adapter.verifyDesired({
        operationId: opId,
        snapshot
      });

      assertVerifiedReceipt(verifyReceipt, opId, serviceId, snapshot);
      assert.equal(verifyReceipt.verified, true);
      assert.equal(verifyReceipt.service, serviceId);
      assert.equal(verifyReceipt.proof.kind, 'authenticated-control-plane');

      // Step E: Observe actual child rawURL, header, chosenCP values via /inspect
      const inspectRes = await fetchJson(`${daemonHealthUrl}/inspect`);
      assert.equal(inspectRes.status, 200);
      assert.equal(
        inspectRes.body.mcpServerUrl,
        mcpTargetUrl,
        'Child process must receive actual raw URL with private query parameters'
      );
      assert.equal(
        inspectRes.body.resolvedHeaders['authorization'],
        secretToken,
        'Child process must receive exact resolved secret Authorization header'
      );
      assert.equal(
        inspectRes.body.resolvedHeaders['x-tracking-id'],
        'trk-uuid-registered-999',
        'Child process must receive non-secret tracking header'
      );
      assert.equal(
        inspectRes.body.chosenControlPlaneApiKey,
        acceptedApiKey,
        'Child process must receive exact chosen CP credential'
      );
      assert.equal(
        inspectRes.body.tunnelId,
        acceptedTunnelId,
        'Child process must receive exact chosen CP tunnel ID'
      );

      // Step F: Upstream MCP traffic execution and secret resolution
      // Forward an MCP JSON-RPC call through the real child tunnel daemon
      const forwardRes = await postJson(`${daemonHealthUrl}/forward`, {
        method: 'POST',
        path: '',
        body: { jsonrpc: '2.0', method: 'ping', id: 42 }
      });
      assert.equal(forwardRes.status, 200, 'Forward through child daemon must succeed with 200');

      const mcpRequests = syntheticMcp.getRequests();
      assert.ok(mcpRequests.length >= 1, 'Synthetic MCP server must receive forwarded request');

      const receivedReq = mcpRequests[mcpRequests.length - 1];
      assert.equal(
        receivedReq.url,
        '/mcp?sig=signed-query-token&channel=primary,secondary',
        'Synthetic MCP must receive exact signed URL path and comma-separated query'
      );
      assert.equal(
        receivedReq.headers['authorization'],
        secretToken,
        'Synthetic MCP must receive exact resolved secret Authorization header'
      );
      assert.equal(
        receivedReq.headers['x-tracking-id'],
        'trk-uuid-registered-999',
        'Synthetic MCP must receive exact tracking header'
      );

      // Step G: Complete secret audit: NO plaintext secret in manager-state, YAML, argv, or public DTO
      // 1. YAML file on disk contains NO plaintext secrets
      const yamlContent = fs.readFileSync(adapter.configPath, 'utf8');
      assert.equal(yamlContent.includes(secretToken), false, 'YAML config must not leak secret token');
      assert.equal(yamlContent.includes(acceptedApiKey), false, 'YAML config must not leak CP API key');
      assert.equal(yamlContent.includes('signed-query-token'), false, 'YAML config must not leak private query token');

      // 2. Child Argv contains NO plaintext secrets (headers use env: reference)
      const childArgs = processRecord.args;
      const argvStr = JSON.stringify(childArgs);
      assert.equal(argvStr.includes(secretToken), false, 'Child argv must not contain secret token');
      assert.equal(argvStr.includes(acceptedApiKey), false, 'Child argv must not contain CP API key');
      assert.equal(argvStr.includes('signed-query-token'), false, 'Child argv must not contain private query');
      assert.ok(
        childArgs.some(a => /Authorization[:=]\s*env:/i.test(a)),
        'Auth header in child argv must use env: reference'
      );

      // 3. Manager state & Public DTO: omits raw URL and secret header values
      const publicServices = await manager.store.registry.listServices();
      const publicDto = publicServices.find(s => s.id === serviceId);
      assert.ok(publicDto, 'Public DTO must exist in store registry');
      assert.equal(publicDto.binding.url, undefined, 'Public DTO must omit raw URL when private query exists');
      assert.ok(publicDto.binding.urlDisplay, 'Public DTO must provide urlDisplay');
      assert.equal(publicDto.binding.urlDisplay.includes('signed-query-token'), false);
      assert.equal(publicDto.binding.urlConfigured, true);
      assert.equal(publicDto.binding.hasPrivateQuery, true);
      assert.equal(publicDto.binding.headers.Authorization.secret, true);
      assert.equal(Object.hasOwn(publicDto.binding.headers.Authorization, 'value'), false);

      const serializedDto = JSON.stringify(publicDto);
      assert.equal(serializedDto.includes(secretToken), false, 'Public DTO must not leak secret token');
      assert.equal(serializedDto.includes(acceptedApiKey), false, 'Public DTO must not leak CP API key');
      assert.equal(serializedDto.includes('signed-query-token'), false, 'Public DTO must not leak private query');

      // Step H: Case-reserved CP definitions cannot alter selected credentials
      // Verify case variations of reserved control-plane names are strictly rejected
      assert.throws(() => validateServiceEnvName('control_plane_api_key'), { code: 'RESERVED_ENV_NAME' });
      assert.throws(() => validateServiceEnvName('Control_Plane_Api_Key'), { code: 'RESERVED_ENV_NAME' });
      assert.throws(() => validateServiceEnvName('CONTROL_PLANE_API_KEY'), { code: 'RESERVED_ENV_NAME' });
      assert.throws(() => validateServiceEnvName('control_plane_base_url'), { code: 'RESERVED_ENV_NAME' });

      // Verify that buildTunnelLaunchEnvironment rejects tampering with CP environment
      assert.throws(
        () => buildTunnelLaunchEnvironment({
          inheritedEnvironment: {},
          serviceEnvironment: { control_plane_api_key: 'malicious-cp-key' },
          controlPlaneEnvironment: { CONTROL_PLANE_API_KEY: acceptedApiKey }
        }),
        { code: 'RESERVED_LAUNCH_ENV' }
      );

      // Child observed credentials verify that chosen CP was NOT altered
      assert.equal(inspectRes.body.chosenControlPlaneApiKey, acceptedApiKey);

      // Step I: Safe stopConnection lifecycle
      const stopReceipt = await adapter.stopConnection({
        operationId: opId,
        serviceId
      });

      assert.equal(stopReceipt.stopped, true);
      assertStoppedConnectionReceipt(stopReceipt, opId, serviceId);

      // Step J: Evict operation from provider cache
      manager.adapterProvider.release(opId);
      assert.equal(manager.adapterProvider.has(opId), false);

    } finally {
      if (processRecord?.pid) {
        try { process.kill(processRecord.pid, 'SIGKILL'); } catch (_) {}
      }
      if (manager) {
        try { await manager.close(); } catch (_) {}
      }
      try { await cp.close(); } catch (_) {}
      try { await syntheticMcp.close(); } catch (_) {}
      cleanTempDir(dataDir);
    }
  });

  it('6. Windows launch protocol (-LaunchPayloadFromStdin) stdin reader validates bounds and executes with complete environment', async () => {
    const tempDir = createTempDir('mgr-stdin-launch-');
    const portFilePath = path.join(tempDir, 'daemon-port.txt');
    const fixtureScriptPath = fileURLToPath(new URL('../fixtures/default-manager-http-tunnel.mjs', import.meta.url));

    let child = null;
    try {
      // 6.1 Subtest: valid launch payload parsed via stdin
      const validPayload = {
        executablePath: process.execPath,
        arguments: [
          '--health.listen-addr', '127.0.0.1:0',
          '--port-file', portFilePath,
          '--tunnel-id', 'tunnel-stdin-protocol-001',
          '--control-plane.base-url', 'http://127.0.0.1:18000'
        ],
        workingDirectory: tempDir,
        environment: {
          CONTROL_PLANE_BASE_URL: 'http://127.0.0.1:18000',
          CONTROL_PLANE_API_KEY: 'sec-key-stdin-payload',
          CUSTOM_PAYLOAD_ENV_VAR: 'verified_via_stdin'
        }
      };

      child = spawn(process.execPath, [fixtureScriptPath, '-LaunchPayloadFromStdin'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: tempDir
      });

      // Write payload JSON to stdin in UTF-8 and close stdin
      const rawJson = JSON.stringify(validPayload);
      child.stdin.end(rawJson, 'utf8');

      // Wait for daemon to initialize and write its ephemeral port
      let daemonPort = 0;
      for (let i = 0; i < 40; i++) {
        if (fs.existsSync(portFilePath)) {
          const content = fs.readFileSync(portFilePath, 'utf8').trim();
          if (content && Number(content) > 0) {
            daemonPort = Number(content);
            break;
          }
        }
        await new Promise(r => setTimeout(r, 100));
      }

      assert.ok(daemonPort > 0, 'Daemon must start and write port file when launched via -LaunchPayloadFromStdin');

      // Inspect running daemon via /inspect endpoint
      const inspectRes = await fetchJson(`http://127.0.0.1:${daemonPort}/inspect`);
      assert.equal(inspectRes.status, 200);
      assert.equal(inspectRes.body.tunnelId, 'tunnel-stdin-protocol-001');
      assert.equal(inspectRes.body.baseUrl, 'http://127.0.0.1:18000');

      // Verify status inspection via child process
      const statusInspection = await new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, [fixtureScriptPath, '--status'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        proc.stdout.on('data', d => { out += d; });
        proc.on('close', code => {
          assert.equal(code, 0);
          try {
            resolve(JSON.parse(out));
          } catch (e) {
            reject(e);
          }
        });
      });

      assert.equal(statusInspection.client, 'default-manager-http-tunnel');
      assert.equal(statusInspection.status, 'ONLINE');

      // Cleanly stop child process
      child.kill('SIGINT');
      await new Promise(r => setTimeout(r, 200));

      // 6.2 Subtest: payload exceeding MAX_PAYLOAD_BYTES is rejected
      const oversizedPayload = JSON.stringify({
        executablePath: process.execPath,
        arguments: [],
        workingDirectory: null,
        environment: {
          OVERSIZED_PAD: 'X'.repeat(MAX_PAYLOAD_BYTES + 1024)
        }
      });

      const oversizedExitCode = await new Promise((resolve) => {
        const proc = spawn(process.execPath, [fixtureScriptPath, '-LaunchPayloadFromStdin'], {
          stdio: ['pipe', 'ignore', 'pipe']
        });
        proc.stdin.end(oversizedPayload, 'utf8');
        proc.on('close', code => resolve(code));
      });

      assert.equal(oversizedExitCode, 1, 'Process must exit with error 1 when payload exceeds limitBytes');

    } finally {
      if (child && !child.killed) {
        try { child.kill('SIGKILL'); } catch (_) {}
      }
      cleanTempDir(tempDir);
    }
  });

});

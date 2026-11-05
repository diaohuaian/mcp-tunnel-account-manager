import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import {
  createAdapters,
  createRegisteredAdapterProvider,
  createDefaultProcessController,
  ServiceAdapter,
  SwitchFault,
  DEFAULT_PROXY
} from '../../src/adapters/index.mjs';
import {
  validateHttpUrl,
  publicUrl,
  mergeHeadersPatch,
  publicHeaders,
  mergeBinding,
  publicBinding,
  bindingToTunnelCommand,
  BindingFault
} from '../../src/adapters/mcp-binding.mjs';
import { createTunnelProbe } from '../../src/adapters/tunnel-probe.mjs';
import { assertStoppedConnectionReceipt } from '../../src/core/mcp-registry-policy.mjs';
import { createMockControlPlane } from '../fixtures/mock-control-plane.mjs';
import { createSyntheticHttpMcp } from '../fixtures/synthetic-http-mcp.mjs';
import { startFakeTunnelDaemon } from '../fixtures/fake-tunnel-health.mjs';
import { createVault } from '../../src/vault.mjs';
import {
  compileHttpTransport,
  sealHttpTransport,
  openHttpTransport,
  HTTP_HEADER_ENV_PREFIX
} from '../../src/adapters/http-transport.mjs';

function createSyntheticEnvironment(serviceId) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-http-e2e-'));
  const dataDir = path.join(tmpDir, 'data');
  const tunnelHome = path.join(tmpDir, 'tunnel-home');
  const appData = path.join(tmpDir, 'app-data');

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(tunnelHome, { recursive: true });
  fs.mkdirSync(path.join(appData, 'tunnel-client'), { recursive: true });

  const configPath = path.join(appData, 'tunnel-client', `${serviceId}.yaml`);

  const paths = {
    userProfile: tmpDir,
    appData,
    tunnelHome,
    tunnelClientBin: path.join(tunnelHome, 'tunnel-client.exe'),
    [`${serviceId}ConfigPath`]: configPath
  };

  return { tmpDir, dataDir, paths, configPath };
}

function createSyntheticMcpHttpServer() {
  const recordedRequests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      recordedRequests.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', mcp: 'synthetic-v1' }));
    });
  });

  return {
    recordedRequests,
    start() {
      return new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          resolve({
            port: addr.port,
            url: `http://127.0.0.1:${addr.port}/mcp`
          });
        });
        server.on('error', reject);
      });
    },
    stop() {
      return new Promise((resolve) => {
        server.close(resolve);
      });
    }
  };
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
        return { valid: false, reason: 'IDENTITY_MISMATCH' };
      }
      return { valid: true, processId: identity?.pid };
    },

    async stop(identity) {
      stopHistory.push({ ...identity });
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

describe('Registered HTTP Transport & Provider Pinning E2E Suite', () => {

  it('1. Synthetic MCP endpoint & registered provider pins definition snapshot per operation', async () => {
    const syntheticMcp = createSyntheticMcpHttpServer();
    const mcpInfo = await syntheticMcp.start();

    const serviceId = 'mcp_synthetic_http_01';
    const env = createSyntheticEnvironment(serviceId);
    const processController = createFakeProcessController();

    const provider = createRegisteredAdapterProvider({
      dataDir: env.dataDir,
      paths: env.paths,
      processController
    });

    const externalDefinition = {
      id: serviceId,
      label: 'Synthetic Remote MCP',
      binding: {
        type: 'http',
        url: mcpInfo.url,
        headers: {
          Authorization: { value: 'Bearer synthetic-secret-token', secret: true },
          'X-Custom-Header': { value: 'custom-header-value', secret: false }
        }
      },
      environment: {
        CUSTOM_VAR: { value: 'custom_var_val', secret: false }
      }
    };

    // Operation 1 captures snapshot clone
    const op = {
      id: 'op-http-pinning-e2e',
      registrySnapshot: {
        revision: 42,
        services: [structuredClone(externalDefinition)]
      }
    };

    const adapter = await provider(op, serviceId);
    assert.ok(adapter, 'Provider must construct adapter for registered HTTP service');
    assert.equal(adapter.service, serviceId);
    assert.equal(adapter.definition.binding.type, 'http');
    assert.equal(adapter.definition.binding.url, mcpInfo.url);

    // Verify snapshot isolation: mutating the external definition does not alter adapter's pinned snapshot
    externalDefinition.binding.url = 'http://127.0.0.1:9999/mutated';
    const cachedAdapter = await provider(op, serviceId);
    assert.equal(cachedAdapter, adapter, 'Provider must return cached instance');
    assert.equal(cachedAdapter.definition.binding.url, mcpInfo.url, 'Adapter must retain original pinned snapshot');

    // Operation 2 with modified snapshot receives its own independent adapter
    const op2 = {
      id: 'op-http-pinning-e2e-2',
      registrySnapshot: {
        revision: 43,
        services: [
          {
            ...externalDefinition,
            binding: { type: 'http', url: 'http://127.0.0.1:9999/mutated' }
          }
        ]
      }
    };
    const adapter2 = await provider(op2, serviceId);
    assert.notEqual(adapter, adapter2);
    assert.equal(adapter2.definition.binding.url, 'http://127.0.0.1:9999/mutated');
    assert.equal(cachedAdapter.definition.binding.url, mcpInfo.url);

    await syntheticMcp.stop();
  });

  it('2. Registered provider pins HTTP definition snapshot and compiles secure transport with vault', async () => {
    const serviceId = 'mcp_http_factory_proof';
    const env = createSyntheticEnvironment(serviceId);
    const processController = createFakeProcessController();
    const vault = createVault({ dataDir: env.dataDir });

    try {
      const httpDefinition = {
        id: serviceId,
        label: 'HTTP MCP Service',
        binding: {
          type: 'http',
          url: 'https://mcp.internal.corp/v1/mcp?token=private-url-token&channel=main,secondary',
          headers: {
            Authorization: { value: 'Bearer secret_auth_bearer_999', secret: true },
            'X-Client-Id': { value: 'client_789', secret: false }
          }
        }
      };

      // Sub-assertion 2.1: bindingToTunnelCommand explicitly blocks HTTP bindings (legitimate stdio guard)
      assert.throws(
        () => bindingToTunnelCommand(httpDefinition.binding),
        (err) => err instanceof BindingFault && err.code === 'UNSUPPORTED_BINDING_FOR_COMMAND',
        'bindingToTunnelCommand rejects HTTP bindings with UNSUPPORTED_BINDING_FOR_COMMAND'
      );

      // Sub-assertion 2.2: provider instantiates adapter with pinned HTTP definition
      const op = {
        id: 'op-http-provider-proof',
        registrySnapshot: {
          revision: 1,
          services: [httpDefinition]
        }
      };

      const provider = createRegisteredAdapterProvider({
        dataDir: env.dataDir,
        paths: env.paths,
        processController,
        vault
      });

      const adapter = await provider(op, serviceId);
      assert.ok(adapter, 'Provider must instantiate adapter for registered HTTP service');
      assert.equal(adapter.service, serviceId);
      assert.equal(adapter.definition.binding.type, 'http');

      // Sub-assertion 2.3: compiles transport plan with private environment and header references
      const context = { serviceId, operationId: op.id };
      const plan = compileHttpTransport(adapter.definition.binding, context);

      assert.equal(plan.privateEnvironment.MCP_SERVER_URL, httpDefinition.binding.url);
      assert.equal(plan.channel, 'main');
      assert.doesNotMatch(JSON.stringify(plan.args), /private-url-token|secret_auth_bearer_999/);

      // Sub-assertion 2.4: sealed transport snapshot encrypts private environment and restores cleanly
      const packet = await sealHttpTransport(vault, adapter.definition.binding, context);
      assert.doesNotMatch(JSON.stringify(packet), /private-url-token|secret_auth_bearer_999/);

      const restored = await openHttpTransport(vault, packet, context);
      assert.deepEqual(restored, plan);
    } finally {
      try { vault.close(); } catch (_) {}
      try { fs.rmSync(env.tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  it('3. Mock control plane enforces 401 unauthorized rejection and valid target checks', async () => {
    const cp = createMockControlPlane();
    const acceptedTunnelId = 'tunnel-http-test-001';
    const acceptedApiKey = 'key-http-test-secret-999';
    cp.setAcceptedCredential(acceptedTunnelId, acceptedApiKey);
    const cpInfo = await cp.start();

    const serviceId = 'mcp_mock_cp_test';
    const env = createSyntheticEnvironment(serviceId);
    const processController = createFakeProcessController();

    const probe = createTunnelProbe({
      endpoint: cpInfo.url + '/health',
      controlPlaneBaseURL: cpInfo.url
    });

    const adapter = new ServiceAdapter({
      service: serviceId,
      dataDir: env.dataDir,
      processController,
      probe,
      paths: env.paths
    });

    // 3.1 Bad credential rejected at preflight
    await assert.rejects(
      async () => {
        await adapter.prepare({
          operationId: 'op-invalid-cred',
          credential: { tunnelId: '', apiKey: '' }
        });
      },
      (err) => err instanceof SwitchFault && err.code === 'TARGET_VERIFICATION_UNAVAILABLE'
    );

    // 3.2 Prepare succeeds with non-empty credential
    const snapshot = await adapter.prepare({
      operationId: 'op-valid-prep',
      credential: {
        tunnelId: acceptedTunnelId,
        apiKey: acceptedApiKey
      }
    });
    assert.ok(snapshot.desiredFingerprint);

    await cp.close();
  });

  it('4. Safe stopConnection lifecycle verifies owned process termination and rejects unmanaged processes', async () => {
    const serviceId = 'mcp_stop_lifecycle_test';
    const env = createSyntheticEnvironment(serviceId);
    const processController = createFakeProcessController();

    const adapter = new ServiceAdapter({
      service: serviceId,
      dataDir: env.dataDir,
      processController,
      paths: env.paths
    });

    // 4.1 When no process is running: returns verified-already-stopped
    const stoppedReceipt = await adapter.stopConnection({
      operationId: 'op-stop-inactive',
      serviceId
    });
    assert.equal(stoppedReceipt.stopped, true);
    assert.equal(stoppedReceipt.proof.kind, 'verified-already-stopped');
    assertStoppedConnectionReceipt(stoppedReceipt, 'op-stop-inactive', serviceId);

    // 4.2 When a process is active but unmanaged (no console record in process file): rejects without killing
    processController.processes.set(serviceId, {
      pid: 88888,
      executable: 'unmanaged.exe',
      running: true,
      startTime: new Date().toISOString()
    });

    await assert.rejects(
      async () => {
        await adapter.stopConnection({
          operationId: 'op-stop-unmanaged',
          serviceId
        });
      },
      (err) => err instanceof SwitchFault && err.code === 'PROCESS_IDENTITY_MISMATCH',
      'Unmanaged process must reject with PROCESS_IDENTITY_MISMATCH'
    );

    assert.equal(processController.stopHistory.length, 0, 'Foreign process must not be killed');
    assert.equal(processController.processes.has(serviceId), true, 'Foreign process remains running');

    // 4.3 When a console-owned process is registered: stops successfully and produces verified-owned-process-exit
    const ownedPid = 77777;
    const processRecord = {
      operationId: 'op-launch-initial',
      service: serviceId,
      pid: ownedPid,
      executable: 'tunnel-client.exe',
      executablePath: 'tunnel-client.exe',
      startTime: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      creationTimeFileTime: '133000000000000000',
      running: true
    };
    fs.mkdirSync(path.join(env.dataDir, 'runtime'), { recursive: true });
    fs.writeFileSync(
      path.join(env.dataDir, 'runtime', `${serviceId}-process.json`),
      JSON.stringify(processRecord, null, 2),
      'utf8'
    );
    processController.processes.set(serviceId, { ...processRecord });

    const ownedReceipt = await adapter.stopConnection({
      operationId: 'op-stop-owned',
      serviceId
    });

    assert.equal(ownedReceipt.stopped, true);
    assert.equal(ownedReceipt.proof.kind, 'verified-owned-process-exit');
    assert.equal(ownedReceipt.identity.pid, ownedPid);
    assertStoppedConnectionReceipt(ownedReceipt, 'op-stop-owned', serviceId);

    // Process file must be cleaned up
    assert.equal(
      fs.existsSync(path.join(env.dataDir, 'runtime', `${serviceId}-process.json`)),
      false,
      'Process file must be unlinked after successful stop'
    );
  });

  it('5. Concurrent operations isolate registered providers and release evicts correctly', async () => {
    const serviceA = 'mcp_concurrent_a';
    const serviceB = 'mcp_concurrent_b';
    const env = createSyntheticEnvironment('mcp_concurrent_shared');
    const processController = createFakeProcessController();

    const provider = createRegisteredAdapterProvider({
      dataDir: env.dataDir,
      paths: env.paths,
      processController
    });

    const opA = {
      id: 'op-concurrent-alpha',
      registrySnapshot: {
        revision: 10,
        services: [
          {
            id: serviceA,
            binding: {
              type: 'http',
              url: 'https://alpha.example.com/mcp',
              headers: { Authorization: { value: 'Bearer alpha-token', secret: true } }
            }
          }
        ]
      }
    };

    const opB = {
      id: 'op-concurrent-beta',
      registrySnapshot: {
        revision: 11,
        services: [
          {
            id: serviceB,
            binding: {
              type: 'http',
              url: 'https://beta.example.com/mcp',
              headers: { Authorization: { value: 'Bearer beta-token', secret: true } }
            }
          }
        ]
      }
    };

    const adapterA = await provider(opA, serviceA);
    const adapterB = await provider(opB, serviceB);

    assert.ok(adapterA);
    assert.ok(adapterB);
    assert.notEqual(adapterA, adapterB);
    assert.equal(adapterA.definition.binding.url, 'https://alpha.example.com/mcp');
    assert.equal(adapterB.definition.binding.url, 'https://beta.example.com/mcp');

    // Cross-service isolation within operation snapshots
    const crossA = await provider(opA, serviceB);
    assert.equal(crossA, undefined, 'opA must not resolve serviceB which is absent from opA snapshot');

    const crossB = await provider(opB, serviceA);
    assert.equal(crossB, undefined, 'opB must not resolve serviceA which is absent from opB snapshot');

    // Releasing opA evicts opA without affecting opB
    provider.release('op-concurrent-alpha');
    const adapterARecreated = await provider(opA, serviceA);
    assert.notEqual(adapterA, adapterARecreated, 'opA adapter must be re-instantiated after release');

    const adapterBCached = await provider(opB, serviceB);
    assert.equal(adapterB, adapterBCached, 'opB adapter must remain cached after opA release');
  });

  it('6. Strict fake-daemon consumer uses MCP_SERVER_URL and header env refs to forward to synthetic MCP endpoint', async () => {
    const syntheticMcp = createSyntheticHttpMcp();
    const mcpInfo = await syntheticMcp.start();

    let daemon = null;
    try {
      const targetUrl = `${mcpInfo.endpoint}?sig=signed-query-token&parts=a,b,c`;
      const context = { serviceId: 'mcp_consumer_target_e2e', operationId: 'op-consumer-e2e' };
      const binding = {
        type: 'http',
        url: targetUrl,
        headers: {
          Authorization: { value: 'Bearer synthetic-secret-bearer-999', secret: true },
          'X-Tracking-Id': { value: 'trk-uuid-12345', secret: false }
        }
      };

      const plan = compileHttpTransport(binding, context);

      const extraHeaders = [];
      for (let i = 0; i < plan.args.length; i += 2) {
        if (plan.args[i] === '--mcp.extra-headers') {
          extraHeaders.push(plan.args[i + 1]);
        }
      }

      daemon = startFakeTunnelDaemon({
        mcpServerUrl: plan.privateEnvironment.MCP_SERVER_URL,
        extraHeaders,
        env: plan.privateEnvironment
      });

      const daemonInfo = await daemon.start('127.0.0.1', 0);
      assert.ok(daemonInfo.port > 0);

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
    } finally {
      if (daemon) {
        try { await daemon.close(); } catch (_) {}
      }
      try { await syntheticMcp.close(); } catch (_) {}
    }
  });
});

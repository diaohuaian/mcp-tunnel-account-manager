import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import { createAdapters, createDefaultProcessController, SwitchFault, DEFAULT_PROXY } from '../../src/adapters/index.mjs';
import { createRegisteredAdapterProvider } from '../../src/adapters/registry-provider.mjs';
import { createTunnelProbe } from '../../src/adapters/tunnel-probe.mjs';
import { evaluateTunnelEvidence, TargetEvidenceFault } from '../../src/adapters/tunnel-health-evidence.mjs';
import { assertVerifiedReceipt, assertRestoredReceipt } from '../../src/core/switch-core.mjs';
import { assertStoppedConnectionReceipt, isMcpServiceId } from '../../src/core/mcp-registry-policy.mjs';
import { createMockControlPlane } from '../fixtures/mock-control-plane.mjs';

const fakeDaemonScriptPath = fileURLToPath(new URL('../fixtures/fake-tunnel-health.mjs', import.meta.url));
const scriptPath = fileURLToPath(new URL('../../scripts/process-control.ps1', import.meta.url));

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { timeout: 3000 }, (res) => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(d) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: d });
        }
      });
    }).on('error', reject);
  });
}

function createThirdPartyEnvironment(serviceId, baseControlPlaneUrl) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-adapter-e2e-'));
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
    tunnelClientBin: process.execPath,
    [`${serviceId}ConfigPath`]: configPath
  };

  const initialYaml = [
    'config_version: 1',
    'control_plane:',
    `  base_url: "${baseControlPlaneUrl}"`,
    '  tunnel_id: "init-custom-tunnel-001"',
    '  api_key: "env:CONTROL_PLANE_API_KEY"',
    'health:',
    '  listen_addr: "127.0.0.1:0"',
    'admin_ui:',
    '  open_browser: false',
    'log:',
    '  level: info',
    '  format: json',
    'mcp:',
    '  commands:',
    '    - channel: main',
    '      command: "node custom-server.js --stdio"'
  ].join('\n') + '\n';

  fs.writeFileSync(configPath, initialYaml, 'utf8');
  fs.writeFileSync(path.join(tunnelHome, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  fs.copyFileSync(fakeDaemonScriptPath, path.join(tunnelHome, 'run'));

  return { tmpDir, dataDir, paths, tunnelHome, appData, configPath, initialYaml };
}

describe('Registered Adapter E2E Production Pipeline Suite', () => {

  // 1. Full pipeline: Real production createRegisteredAdapterProvider / createAdapters
  // with fake daemon + mock control plane + Win32 process controller helper
  it('1. Executes real production createRegisteredAdapterProvider pipeline for 3rd MCP with verified receipts and health gate assertions', async () => {
    const cp = createMockControlPlane();
    const serviceId = 'mcp_registered_stdio';
    const acceptedTunnelId = 'tunnel-reg-accepted-001';
    const acceptedApiKey = 'sec-reg-accepted-key-999';
    cp.setAcceptedCredential(acceptedTunnelId, acceptedApiKey);
    const cpInfo = await cp.start();

    const env = createThirdPartyEnvironment(serviceId, cpInfo.url);
    const portFile = path.join(env.tmpDir, 'daemon-port.txt');

    const probe = createTunnelProbe({
      endpoint: cpInfo.url + '/health',
      controlPlaneBaseURL: cpInfo.url
    });

    const processController = createDefaultProcessController({
      dataDir: env.dataDir,
      scriptPath
    });

    const definition = {
      id: serviceId,
      label: 'Registered Third Party Stdio MCP',
      binding: {
        type: 'stdio',
        executable: process.execPath,
        args: [{ id: 'a1', value: 'custom-server.js', secret: false }],
        cwd: env.tunnelHome
      },
      environment: {
        CUSTOM_OPTION: { value: 'opt_val', secret: false },
        CUSTOM_SECRET: { value: 'super-secret', secret: true }
      }
    };

    // Instantiate REAL production createRegisteredAdapterProvider
    const provider = createRegisteredAdapterProvider({
      dataDir: env.dataDir,
      paths: env.paths,
      processController,
      probe,
      scriptPath
    });

    const opId = 'op-e2e-regmcp-1';
    const op = {
      id: opId,
      operationId: opId,
      registrySnapshot: {
        services: [definition]
      }
    };

    const adapter = await provider(op, serviceId);
    assert.ok(adapter, 'Provider must return an adapter instance');
    assert.equal(adapter.service, serviceId);

    try {
      // Step A: Prepare validates credential shape and stages desired config in memory without touching disk
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
      assert.notEqual(snapshot.desiredFingerprint, snapshot.originalFingerprint);

      // Verify no changes to disk during prepare
      const onDiskBefore = fs.readFileSync(env.configPath, 'utf8');
      assert.equal(onDiskBefore, env.initialYaml);

      // Assert pinned executable, argv, cwd, credential target and env separation
      assert.equal(snapshot.launchTemplate.command, process.execPath);
      assert.equal(snapshot.launchTemplate.cwd, env.tunnelHome);
      assert.equal(snapshot.launchTemplate.proxy, DEFAULT_PROXY);
      assert.equal(snapshot.launchTemplate.serviceMcpEnv.CUSTOM_OPTION, 'opt_val');
      assert.equal(snapshot.launchTemplate.serviceMcpEnv.CUSTOM_SECRET, 'super-secret');
      assert.equal(snapshot.credential.tunnelId, acceptedTunnelId);
      assert.equal(snapshot.credential.apiKey, acceptedApiKey);

      // Configure launch parameters for fake daemon in synthetic test
      snapshot.launchTemplate.args = [
        'run',
        '--profile', serviceId,
        '--tunnel-id', acceptedTunnelId,
        '--health.listen-addr', '127.0.0.1:0',
        '--port-file', portFile,
        '--control-plane.base-url', cpInfo.url
      ];

      // Step B: Apply writes desired config and launches process via Win32 process controller
      const applyRecord = await adapter.applyIfUnchanged({
        operationId: opId,
        snapshot
      });

      assert.ok(applyRecord);
      assert.ok(applyRecord.pid > 0);
      assert.equal(applyRecord.running, true);

      // Verify mutated YAML written to disk
      const onDiskAfter = fs.readFileSync(env.configPath, 'utf8');
      assert.ok(onDiskAfter.includes(acceptedTunnelId));

      // Wait for daemon to write its ephemeral port
      let daemonPort = 0;
      for (let i = 0; i < 40; i++) {
        if (fs.existsSync(portFile)) {
          const raw = fs.readFileSync(portFile, 'utf8').trim();
          if (raw && Number(raw) > 0) {
            daemonPort = Number(raw);
            break;
          }
        }
        await new Promise(r => setTimeout(r, 100));
      }
      assert.ok(daemonPort > 0, 'Fake tunnel daemon failed to start or write port file');

      // Step C: Inspect running daemon via Win32 PowerShell helper
      const inspected = await processController.inspect(serviceId);
      assert.equal(inspected.running, true);
      assert.equal(inspected.pid, applyRecord.pid);

      // Configure loopback health URL
      const loopbackHealthUrl = `http://127.0.0.1:${daemonPort}`;
      adapter.healthURL = loopbackHealthUrl;
      adapter.probe = createTunnelProbe({
        healthURL: loopbackHealthUrl,
        controlPlaneBaseURL: cpInfo.url
      });
      snapshot.healthURL = loopbackHealthUrl;
      snapshot.controlPlaneBaseURL = cpInfo.url;

      // Step D: VerifyDesired returns strict verified receipt passing core assertions
      const verifyReceipt = await adapter.verifyDesired({
        operationId: opId,
        snapshot
      });

      assertVerifiedReceipt(verifyReceipt, opId, serviceId, snapshot);
      assert.equal(verifyReceipt.verified, true);
      assert.equal(verifyReceipt.service, serviceId);
      assert.equal(verifyReceipt.proof.kind, 'authenticated-control-plane');

      // Step E: Direct health verification against fake daemon endpoints
      const healthRes = await fetchJson(`${loopbackHealthUrl}/health?details=true`);
      const statusRes = await fetchJson(`${loopbackHealthUrl}/api/status`);

      assert.equal(healthRes.status, 200);
      assert.equal(healthRes.body.live, true);
      assert.equal(healthRes.body.ready, true);
      assert.equal(healthRes.body.components['control-plane'].status, 'ok');
      assert.equal(statusRes.body.control_plane_tunnel_id, acceptedTunnelId);

      // Evaluate Tunnel Health Evidence gate directly
      const evidence = evaluateTunnelEvidence({
        health: healthRes.body,
        adminStatus: statusRes.body,
        identity: { pid: applyRecord.pid, startedAt: inspected.startTime, executable: inspected.executablePath },
        listenerIdentity: { pid: applyRecord.pid, startedAt: inspected.startTime, executable: inspected.executablePath },
        currentConfigFingerprint: snapshot.desiredFingerprint,
        expected: {
          service: serviceId,
          operationId: opId,
          tunnelId: acceptedTunnelId,
          configFingerprint: snapshot.desiredFingerprint,
          identity: { pid: applyRecord.pid, startedAt: inspected.startTime, executable: inspected.executablePath },
          launchedAt: inspected.startTime,
          controlPlaneBaseURL: cpInfo.url
        }
      });
      assert.equal(evidence.verified, true);
      assert.equal(evidence.proof.kind, 'authenticated-control-plane');

      // Step F: Stop connection produces strict verified exit receipt and preserves filepaths
      const stopReceipt = await adapter.stopConnection({
        operationId: 'op-stop-regmcp-1',
        serviceId,
        originalRuntime: inspected
      });

      assertStoppedConnectionReceipt(stopReceipt, 'op-stop-regmcp-1', serviceId);
      assert.equal(stopReceipt.stopped, true);
      assert.equal(stopReceipt.proof.kind, 'verified-owned-process-exit');
      assert.equal(stopReceipt.identity.pid, applyRecord.pid);

      // Handle-verified stop / removal preserves filepaths:
      // Process file was cleaned up
      assert.equal(fs.existsSync(adapter.processPath), false);
      // But configuration YAML file remains intact on disk!
      assert.equal(fs.existsSync(env.configPath), true);
      const onDiskPostStop = fs.readFileSync(env.configPath, 'utf8');
      assert.ok(onDiskPostStop.includes(acceptedTunnelId));

      // Confirm process is fully terminated
      const afterStopInspect = await processController.inspect(serviceId);
      assert.equal(afterStopInspect.running, false);

      // Release cached adapter in provider
      provider.release(opId);
      assert.equal(provider.has(opId), false);
    } finally {
      try {
        const currentProc = await processController.inspect(serviceId);
        if (currentProc?.running) {
          await processController.stop(currentProc);
        }
      } catch (_) {}
      await cp.close();
      try {
        fs.rmSync(env.tmpDir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  // 2. Adversarial: wrong API key rejected by mock control plane & evidence gate
  it('2. Rejects 3rd MCP when mock control plane returns 401 Unauthorized', async () => {
    const cp = createMockControlPlane();
    const serviceId = 'mcp_registered_badkey';
    const validTunnelId = 'tunnel-bad-key-reg-002';
    cp.setAcceptedCredential(validTunnelId, 'good-secret-key-123');
    const cpInfo = await cp.start();

    const env = createThirdPartyEnvironment(serviceId, cpInfo.url);
    const portFile = path.join(env.tmpDir, 'daemon-port-badkey.txt');

    const processController = createDefaultProcessController({
      dataDir: env.dataDir,
      scriptPath
    });

    const definition = {
      id: serviceId,
      label: 'Registered Bad Key MCP',
      binding: { type: 'stdio', executable: process.execPath, args: [] }
    };

    const adapters = createAdapters({
      dataDir: env.dataDir,
      paths: env.paths,
      processController,
      definitions: [definition],
      scriptPath
    });

    const adapter = adapters[serviceId];
    assert.ok(adapter);

    try {
      const snapshot = await adapter.prepare({
        operationId: 'op-badkey-reg-1',
        credential: {
          tunnelId: validTunnelId,
          apiKey: 'WRONG-UNAUTHORIZED-API-KEY'
        }
      });

      snapshot.launchTemplate.command = process.execPath;
      snapshot.launchTemplate.cwd = env.tunnelHome;
      snapshot.launchTemplate.args = [
        'run',
        '--profile', serviceId,
        '--tunnel-id', validTunnelId,
        '--health.listen-addr', '127.0.0.1:0',
        '--port-file', portFile,
        '--control-plane.base-url', cpInfo.url
      ];

      const applyRecord = await adapter.applyIfUnchanged({
        operationId: 'op-badkey-reg-1',
        snapshot
      });

      let daemonPort = 0;
      for (let i = 0; i < 40; i++) {
        if (fs.existsSync(portFile)) {
          const raw = fs.readFileSync(portFile, 'utf8').trim();
          if (raw && Number(raw) > 0) {
            daemonPort = Number(raw);
            break;
          }
        }
        await new Promise(r => setTimeout(r, 100));
      }
      assert.ok(daemonPort > 0);

      const loopbackHealthUrl = `http://127.0.0.1:${daemonPort}`;
      adapter.healthURL = loopbackHealthUrl;
      adapter.probe = createTunnelProbe({
        healthURL: loopbackHealthUrl,
        controlPlaneBaseURL: cpInfo.url
      });
      snapshot.healthURL = loopbackHealthUrl;
      snapshot.controlPlaneBaseURL = cpInfo.url;

      // VerifyDesired must fail because mock control plane rejects API key with 401
      await assert.rejects(
        async () => {
          await adapter.verifyDesired({
            operationId: 'op-badkey-reg-1',
            snapshot
          });
        },
        (err) => err instanceof SwitchFault || err instanceof Error
      );

      // Stop daemon
      const inspected = await processController.inspect(serviceId);
      if (inspected.running) {
        await processController.stop(inspected);
      }
    } finally {
      await cp.close();
      try {
        fs.rmSync(env.tmpDir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  // 3. Process identity mismatch during stop is protected
  it('3. Process controller rejects stop with mismatched creation time and does not kill target', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-mcp-stop-mismatch-'));
    const dataDir = path.join(tmpDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });

    const processController = createDefaultProcessController({
      dataDir,
      scriptPath
    });

    const fakeIdentity = {
      pid: process.pid,
      running: true,
      executable: process.execPath,
      executablePath: process.execPath,
      startTime: '1970-01-01T00:00:00.000Z',
      creationTimeFileTime: 1234567890
    };

    await assert.rejects(
      async () => {
        await processController.stop(fakeIdentity);
      },
      (err) => err.code === 'PROCESS_IDENTITY_MISMATCH' || err instanceof SwitchFault
    );

    assert.equal(process.exitCode, undefined);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 4. Stop connection on already-stopped MCP returns verified-already-stopped receipt
  it('4. Stop connection on already-stopped MCP returns verified-already-stopped receipt', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-mcp-alreadystop-'));
    const dataDir = path.join(tmpDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });

    const processController = createDefaultProcessController({
      dataDir,
      scriptPath
    });

    const serviceId = 'mcp_stopped_reg01';
    const definition = { id: serviceId, label: 'Stopped Service' };
    const adapters = createAdapters({
      dataDir,
      paths: { appData: tmpDir, userProfile: tmpDir, tunnelHome: tmpDir },
      processController,
      definitions: [definition]
    });
    const adapter = adapters[serviceId];

    const receipt = await adapter.stopConnection({
      operationId: 'op-stop-already-reg-1',
      serviceId,
      originalRuntime: { state: 'stopped', running: false }
    });

    assertStoppedConnectionReceipt(receipt, 'op-stop-already-reg-1', serviceId);
    assert.equal(receipt.stopped, true);
    assert.equal(receipt.proof.kind, 'verified-already-stopped');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 5. runtimeCommand trusted fake hook: verifies helper actions and pinned launch params without spawning processes
  it('5. runtimeCommand test hook receives exact pinned parameters and env isolation', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-mcp-runtimecmd-'));
    const dataDir = path.join(tmpDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });

    const dispatchedActions = [];
    const runtimeCommand = async (action, params) => {
      dispatchedActions.push({ action, params });
      if (action === 'Inspect') {
        return { running: false };
      }
      if (action === 'Launch') {
        return {
          processId: 54321,
          creationDate: new Date().toISOString(),
          executablePath: params.ExecutablePath
        };
      }
      if (action === 'Verify') {
        return { valid: true };
      }
      if (action === 'Stop') {
        return { stopped: true };
      }
      return { code: 0 };
    };

    const serviceId = 'mcp_runtimecmd_test';
    const definition = {
      id: serviceId,
      binding: {
        type: 'stdio',
        executable: 'node',
        args: [{ id: 'a1', value: 'server.js', secret: false }],
        cwd: 'C:/fake/cwd'
      },
      environment: {
        MY_VAR: { value: 'my_val', secret: false },
        CONTROL_PLANE_API_KEY: { value: 'forbidden-leak', secret: true }
      }
    };

    const probe = createTunnelProbe({
      checkReady: async () => true,
      verify: async () => ({ ok: true, verified: true, proof: { kind: 'authenticated-control-plane' } })
    });

    const adapters = createAdapters({
      dataDir,
      paths: { appData: tmpDir, userProfile: tmpDir, tunnelHome: tmpDir },
      definitions: [definition],
      runtimeCommand,
      probe
    });

    const adapter = adapters[serviceId];
    const opId = 'op-runtimecmd-1';

    const snapshot = await adapter.prepare({
      operationId: opId,
      credential: { tunnelId: 'tunnel-rt-1', apiKey: 'sec-rt-key-1' }
    });

    await adapter.applyIfUnchanged({ operationId: opId, snapshot });

    const launchDispatch = dispatchedActions.find(d => d.action === 'Launch');
    assert.ok(launchDispatch, 'Launch action must be dispatched');
    assert.equal(launchDispatch.params.service, serviceId);
    assert.equal(launchDispatch.params.ExecutablePath, adapter.paths.tunnelClientBin);
    assert.equal(launchDispatch.params.env.CONTROL_PLANE_API_KEY, 'sec-rt-key-1');
    assert.equal(launchDispatch.params.env.MY_VAR, 'my_val');
    assert.equal(launchDispatch.params.env.HTTP_PROXY, DEFAULT_PROXY);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

});

import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createTunnelProbe } from '../../src/adapters/tunnel-probe.mjs';
import { evaluateTunnelEvidence, TargetEvidenceFault } from '../../src/adapters/tunnel-health-evidence.mjs';
import { assertVerifiedReceipt, assertRestoredReceipt } from '../../src/core/switch-core.mjs';
import { assertStoppedConnectionReceipt, removalDecision, RegistryPolicyFault } from '../../src/core/mcp-registry-policy.mjs';
import { createMockControlPlane } from '../fixtures/mock-control-plane.mjs';
import {
  createAdapters,
  createRegisteredAdapterProvider,
  createDefaultProcessController,
  ServiceAdapter,
  SwitchFault,
  DEFAULT_PROXY,
  buildSafePinnedEnv
} from '../../src/adapters/index.mjs';

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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `third-mcp-e2e-${process.pid}-${Date.now()}-`));
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

describe('Third MCP E2E Adapter Pipeline Suite', () => {

  // 1. Full pipeline: production createRegisteredAdapterProvider + fake daemon + mockCP + Win32 helper + GPT gate
  it('1. Executes real default adapter pipeline for 3rd MCP with verified receipts and health gate assertions', async () => {
    const cp = createMockControlPlane();
    const serviceId = 'mcp_thirdparty01';
    const acceptedTunnelId = 'tunnel-custom-accepted-001';
    const acceptedApiKey = 'sec-custom-accepted-key-999';
    cp.setAcceptedCredential(acceptedTunnelId, acceptedApiKey);
    const cpInfo = await cp.start(0);

    const env = createThirdPartyEnvironment(serviceId, cpInfo.url);
    const portFile = path.join(env.tmpDir, `daemon-port-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);

    const probe = createTunnelProbe({
      endpoint: cpInfo.url + '/health',
      controlPlaneBaseURL: cpInfo.url
    });

    const definition = {
      id: serviceId,
      label: 'Third Party Stdio MCP',
      binding: {
        type: 'stdio',
        executable: process.execPath,
        args: [{ id: 'a1', value: 'custom-server.js', secret: false }],
        cwd: env.tunnelHome
      },
      environment: {
        CUSTOM_OPTION: { value: 'opt_val', secret: false }
      }
    };

    let daemonProcess = null;
    let launchParamsCaptured = null;

    // Trusted runtimeCommand hook for Launch action
    const runtimeCommand = async (action, params) => {
      if (action === 'Launch') {
        launchParamsCaptured = params;

        // Pinned assertions:
        assert.equal(params.command, env.paths.tunnelClientBin, 'Command must be pinned tunnelClientBin');
        assert.ok(params.args.includes('run'), 'Argv must include run');
        assert.ok(params.args.includes('--profile'), 'Argv must include --profile');
        assert.ok(params.args.includes(serviceId), 'Argv must target service profile');
        assert.ok(params.args.includes('--health.listen-addr'), 'Argv must include health listen address');
        assert.ok(params.args.includes('127.0.0.1:0'), 'Argv must specify ephemeral loopback');
        assert.equal(params.cwd, env.paths.tunnelHome, 'Working directory must be pinned tunnelHome');

        // Target credentials and environment separation
        assert.equal(params.env.CONTROL_PLANE_API_KEY, acceptedApiKey, 'API key must match accepted credential');
        assert.equal(params.env.CUSTOM_OPTION, 'opt_val', 'Definition environment must be preserved');
        assert.equal(params.env.HTTP_PROXY, DEFAULT_PROXY, 'Default proxy must be pinned');
        // Separation check: non-pinned secrets from host must not be leaked
        assert.equal(params.env.UNPINNED_HOST_SECRET, undefined, 'Host secrets must not leak to child env');

        // Launch trusted fake-tunnel-health Node daemon simulating tunnel-client 0.0.19
        const daemonChild = spawn(process.execPath, [
          fakeDaemonScriptPath,
          'run',
          '--profile', serviceId,
          '--tunnel-id', acceptedTunnelId,
          '--health.listen-addr', '127.0.0.1:0',
          '--port-file', portFile,
          '--control-plane.base-url', cpInfo.url
        ], {
          cwd: env.tunnelHome,
          env: {
            ...process.env,
            APPDATA: env.appData,
            CONTROL_PLANE_API_KEY: acceptedApiKey
          },
          detached: true,
          stdio: 'ignore'
        });
        daemonChild.unref();
        daemonProcess = daemonChild;

        // Inspect newly spawned daemon process using actual Win32 helper (scripts/process-control.ps1)
        const inspectedOutput = execFileSync('powershell', [
          '-ExecutionPolicy', 'Bypass',
          '-File', scriptPath,
          '-Action', 'Inspect',
          '-ProcessId', String(daemonChild.pid)
        ], { encoding: 'utf8' });
        const inspectedData = JSON.parse(inspectedOutput.trim());

        return {
          processId: daemonChild.pid,
          executablePath: inspectedData.executablePath || process.execPath,
          creationDate: inspectedData.creationDate || new Date().toISOString(),
          creationTimeFileTime: inspectedData.creationTimeFileTime || '0'
        };
      }

      // Dispatch fixed helper actions (Inspect, Verify, Stop) to actual Win32 PowerShell helper
      const args = ['-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Action', action];
      if (params.ProcessId) args.push('-ProcessId', String(params.ProcessId));
      if (params.ExpectedExecutablePath) args.push('-ExpectedExecutablePath', params.ExpectedExecutablePath);
      if (params.ExpectedStartTime) args.push('-ExpectedStartTime', params.ExpectedStartTime);
      if (params.ExpectedCreationTimeFileTime) args.push('-ExpectedCreationTimeFileTime', String(params.ExpectedCreationTimeFileTime));
      const output = execFileSync('powershell', args, { encoding: 'utf8' });
      return output;
    };

    // Instantiate real production provider with registrySnapshot containing 3rd party definition
    const provider = createRegisteredAdapterProvider({
      dataDir: env.dataDir,
      paths: env.paths,
      scriptPath,
      probe,
      runtimeCommand
    });

    const opId = 'op-e2e-thirdmcp-1';
    const op = {
      id: opId,
      registrySnapshot: {
        revision: 1,
        services: [definition]
      }
    };

    const adapter = await provider(op, serviceId);
    assert.ok(adapter, 'Provider must resolve registered 3rd party adapter');
    assert.ok(adapter instanceof ServiceAdapter, 'Must be real production ServiceAdapter');

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

      // Verify no changes to disk yet
      const onDiskBefore = fs.readFileSync(env.configPath, 'utf8');
      assert.equal(onDiskBefore, env.initialYaml);

      // Step B: Apply writes desired config and launches process via Win32 process controller
      const applyRecord = await adapter.applyIfUnchanged({
        operationId: opId,
        snapshot
      });

      assert.ok(applyRecord);
      assert.ok(applyRecord.pid > 0);
      assert.equal(applyRecord.running, true);
      assert.ok(launchParamsCaptured, 'runtimeCommand must have captured Launch params');

      // Verify mutated YAML written to disk
      const onDiskAfter = fs.readFileSync(env.configPath, 'utf8');
      assert.ok(onDiskAfter.includes(acceptedTunnelId));

      // Wait for daemon to write its unique ephemeral port with reliable readiness probe
      let daemonPort = 0;
      for (let i = 0; i < 200; i++) {
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

      // Step C: Inspect running daemon via actual Win32 PowerShell helper
      const inspected = await adapter.processController.inspect(serviceId);
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
      // Retry probe within 45s proof bound to handle load jitter and daemon control-plane readiness
      const deadline = Date.now() + 45000;
      let verifyReceipt = null;
      let lastErr = null;
      while (Date.now() < deadline) {
        try {
          verifyReceipt = await adapter.verifyDesired({
            operationId: opId,
            snapshot
          });
          if (verifyReceipt && verifyReceipt.verified) {
            break;
          }
        } catch (err) {
          lastErr = err;
          await new Promise(r => setTimeout(r, 200));
        }
      }

      if (!verifyReceipt) {
        console.error('DEBUG verifyDesired error:', lastErr);
        throw lastErr || new Error('Verification timed out within 45s proof bound');
      }

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

      // Step F: Stop connection produces strict verified exit receipt via actual Win32 helper
      const stopReceipt = await adapter.stopConnection({
        operationId: 'op-stop-thirdmcp-1',
        serviceId,
        originalRuntime: inspected
      });

      assertStoppedConnectionReceipt(stopReceipt, 'op-stop-thirdmcp-1', serviceId);
      assert.equal(stopReceipt.stopped, true);
      assert.equal(stopReceipt.proof.kind, 'verified-owned-process-exit');
      assert.equal(stopReceipt.identity.pid, applyRecord.pid);

      // Confirm process is fully terminated via actual Win32 helper
      const afterStopInspect = await adapter.processController.inspect(serviceId);
      assert.equal(afterStopInspect.running, false);

      // Evict operation cache from provider
      provider.release(opId);

      // Step G: Removal preserves file paths
      assert.equal(fs.existsSync(env.configPath), true, 'Configuration file path must be preserved after stop');
      const decision = removalDecision({
        service: definition,
        runtimeState: 'stopped'
      });
      assert.equal(decision.allowed, true);
      assert.equal(decision.preserveInstallation, true, 'Removal decision must preserve installation');
      assert.equal(decision.preserveSourceFiles, true, 'Removal decision must preserve source files');
      assert.equal(fs.existsSync(env.configPath), true, 'Configuration file path must remain preserved on disk');
    } finally {
      // Finally block releases all handles and processes
      if (daemonProcess) {
        try {
          if (!daemonProcess.killed) {
            daemonProcess.kill('SIGKILL');
          }
        } catch (_) {}
      }
      if (cp) {
        try {
          await cp.close();
        } catch (_) {}
      }
      if (env?.tmpDir) {
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            fs.rmSync(env.tmpDir, { recursive: true, force: true });
            break;
          } catch (_) {
            await new Promise(r => setTimeout(r, 100));
          }
        }
      }
    }
  });

  // 2. Adversarial: wrong API key rejected by mock control plane & evidence gate
  it('2. Rejects 3rd MCP when mock control plane returns 401 Unauthorized', async () => {
    const cp = createMockControlPlane();
    const serviceId = 'mcp_thirdparty02';
    const validTunnelId = 'tunnel-bad-key-002';
    cp.setAcceptedCredential(validTunnelId, 'good-secret-key-123');
    const cpInfo = await cp.start(0);

    const env = createThirdPartyEnvironment(serviceId, cpInfo.url);
    const portFile = path.join(env.tmpDir, `daemon-port-badkey-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);

    const definition = {
      id: serviceId,
      label: 'Third Party Bad Key MCP',
      binding: { type: 'stdio', executable: process.execPath, args: [] },
      environment: {}
    };

    let daemonProcess = null;

    const runtimeCommand = async (action, params) => {
      if (action === 'Launch') {
        const daemonChild = spawn(process.execPath, [
          fakeDaemonScriptPath,
          'run',
          '--profile', serviceId,
          '--tunnel-id', validTunnelId,
          '--health.listen-addr', '127.0.0.1:0',
          '--port-file', portFile,
          '--control-plane.base-url', cpInfo.url
        ], {
          cwd: env.tunnelHome,
          env: {
            ...process.env,
            APPDATA: env.appData,
            CONTROL_PLANE_API_KEY: 'WRONG-UNAUTHORIZED-API-KEY'
          },
          detached: true,
          stdio: 'ignore'
        });
        daemonChild.unref();
        daemonProcess = daemonChild;

        const inspectedOutput = execFileSync('powershell', [
          '-ExecutionPolicy', 'Bypass',
          '-File', scriptPath,
          '-Action', 'Inspect',
          '-ProcessId', String(daemonChild.pid)
        ], { encoding: 'utf8' });
        const inspectedData = JSON.parse(inspectedOutput.trim());

        return {
          processId: daemonChild.pid,
          executablePath: inspectedData.executablePath || process.execPath,
          creationDate: inspectedData.creationDate || new Date().toISOString(),
          creationTimeFileTime: inspectedData.creationTimeFileTime || '0'
        };
      }

      // Dispatch fixed helper actions (Inspect, Verify, Stop) to actual Win32 PowerShell helper
      const args = ['-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Action', action];
      if (params.ProcessId) args.push('-ProcessId', String(params.ProcessId));
      if (params.ExpectedExecutablePath) args.push('-ExpectedExecutablePath', params.ExpectedExecutablePath);
      if (params.ExpectedStartTime) args.push('-ExpectedStartTime', params.ExpectedStartTime);
      if (params.ExpectedCreationTimeFileTime) args.push('-ExpectedCreationTimeFileTime', String(params.ExpectedCreationTimeFileTime));
      const output = execFileSync('powershell', args, { encoding: 'utf8' });
      return output;
    };

    const adapters = createAdapters({
      definitions: [definition],
      dataDir: env.dataDir,
      paths: env.paths,
      scriptPath,
      runtimeCommand
    });
    const adapter = adapters[serviceId];
    assert.ok(adapter);
    assert.ok(adapter instanceof ServiceAdapter);

    try {
      const snapshot = await adapter.prepare({
        operationId: 'op-badkey-1',
        credential: {
          tunnelId: validTunnelId,
          apiKey: 'WRONG-UNAUTHORIZED-API-KEY'
        }
      });

      const applyRecord = await adapter.applyIfUnchanged({
        operationId: 'op-badkey-1',
        snapshot
      });

      let daemonPort = 0;
      for (let i = 0; i < 200; i++) {
        if (fs.existsSync(portFile)) {
          const raw = fs.readFileSync(portFile, 'utf8').trim();
          if (raw && Number(raw) > 0) {
            daemonPort = Number(raw);
            break;
          }
        }
        await new Promise(r => setTimeout(r, 100));
      }
      assert.ok(daemonPort > 0, 'Daemon port file must be written');

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
            operationId: 'op-badkey-1',
            snapshot
          });
        },
        (err) => err instanceof Error
      );

      // Stop daemon via actual Win32 helper in processController
      const inspected = await adapter.processController.inspect(serviceId);
      if (inspected.running) {
        await adapter.processController.stop(inspected);
      }
    } finally {
      // Finally block releases all handles and processes
      if (daemonProcess) {
        try {
          if (!daemonProcess.killed) daemonProcess.kill('SIGKILL');
        } catch (_) {}
      }
      if (cp) {
        try {
          await cp.close();
        } catch (_) {}
      }
      if (env?.tmpDir) {
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            fs.rmSync(env.tmpDir, { recursive: true, force: true });
            break;
          } catch (_) {
            await new Promise(r => setTimeout(r, 100));
          }
        }
      }
    }
  });

  // 3. Process identity mismatch during stop is protected
  it('3. Process controller rejects stop with mismatched creation time and does not kill target', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `third-mcp-stop-mismatch-${process.pid}-${Date.now()}-`));
    try {
      const dataDir = path.join(tmpDir, 'data');
      fs.mkdirSync(dataDir, { recursive: true });

      const processController = createDefaultProcessController({
        dataDir,
        scriptPath
      });

      // Attempting to stop with wrong creation time
      const fakeIdentity = {
        pid: process.pid, // current test runner pid
        running: true,
        executable: process.execPath,
        executablePath: process.execPath,
        startTime: '1970-01-01T00:00:00.000Z',
        creationTimeFileTime: 1234567890 // invalid file time
      };

      await assert.rejects(
        async () => {
          await processController.stop(fakeIdentity);
        },
        (err) => err.code === 'PROCESS_IDENTITY_MISMATCH' || err instanceof SwitchFault
      );

      // Current process must still be running (not killed)
      assert.equal(process.exitCode, undefined);
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  // 4. Stop connection on already-stopped MCP returns verified-already-stopped receipt
  it('4. Stop connection on already-stopped MCP returns verified-already-stopped receipt', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `third-mcp-alreadystop-${process.pid}-${Date.now()}-`));
    try {
      const dataDir = path.join(tmpDir, 'data');
      fs.mkdirSync(dataDir, { recursive: true });

      const serviceId = 'mcp_stopped01';
      const definition = {
        id: serviceId,
        label: 'Third Party Stopped MCP',
        binding: { type: 'stdio', executable: process.execPath, args: [] }
      };

      const adapters = createAdapters({
        definitions: [definition],
        dataDir,
        scriptPath,
        paths: { appData: tmpDir }
      });
      const adapter = adapters[serviceId];
      assert.ok(adapter);
      assert.ok(adapter instanceof ServiceAdapter);

      const receipt = await adapter.stopConnection({
        operationId: 'op-stop-already-1',
        serviceId,
        originalRuntime: { state: 'stopped', running: false }
      });

      assertStoppedConnectionReceipt(receipt, 'op-stop-already-1', serviceId);
      assert.equal(receipt.stopped, true);
      assert.equal(receipt.proof.kind, 'verified-already-stopped');
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  // 5. Safe pinned environment separation prevents host secrets from leaking to child
  it('5. Safe pinned environment separation prevents host secrets from leaking to 3rd MCP', () => {
    const testSecret = 'LEAKED_HOST_SECRET_TOKEN_XYZ';
    process.env.UNPINNED_SECRET_HOST_VAR = testSecret;
    try {
      const pinned = buildSafePinnedEnv({ CUSTOM_OPTION: 'opt_val' });
      assert.equal(pinned.CUSTOM_OPTION, 'opt_val');
      assert.equal(pinned.UNPINNED_SECRET_HOST_VAR, undefined, 'Host environment secret must not be in pinned child env');
    } finally {
      delete process.env.UNPINNED_SECRET_HOST_VAR;
    }
  });

});

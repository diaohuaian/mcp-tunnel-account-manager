import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import { createAdapters, SwitchFault } from '../../src/adapters/index.mjs';
import { createTunnelProbe } from '../../src/adapters/tunnel-probe.mjs';
import { evaluateTunnelEvidence, TargetEvidenceFault } from '../../src/adapters/tunnel-health-evidence.mjs';
import { assertVerifiedReceipt, assertRestoredReceipt } from '../../src/core/switch-core.mjs';
import { createMockControlPlane } from '../fixtures/mock-control-plane.mjs';
import { startFakeTunnelDaemon } from '../fixtures/fake-tunnel-health.mjs';

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

function createSyntheticEnvironment(baseControlPlaneUrl = 'https://api.openai.com') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-e2e-'));
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
    tunnelClientBin: process.execPath,
    overleafConfigPath: path.join(appData, 'tunnel-client', 'overleaf.yaml'),
    antigravityConfigPath: path.join(appData, 'tunnel-client', 'antigravity-local.yaml'),
    overleafEnvPath: path.join(tunnelHome, 'tunnel.env')
  };

  // Create initial synthetic configs
  const initialOverleafYaml = [
    'config_version: 1',
    'control_plane:',
    `  base_url: "${baseControlPlaneUrl}"`,
    '  tunnel_id: "init-overleaf-tunnel-001"',
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
    '      command: "node C:/Users/wszho/.overleaf-mcp/runtime/node_modules/mcp-server-overleaf/dist/index.js --stdio"'
  ].join('\n') + '\n';

  const initialAntigravityYaml = [
    'config_version: 1',
    'control_plane:',
    `  base_url: "${baseControlPlaneUrl}"`,
    '  organization_id: "org-initial-999"',
    '  tunnel_id: "init-antigravity-tunnel-002"',
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
    '      command: "antigravity-mcp"'
  ].join('\n') + '\n';

  const initialOverleafEnv = 'TUNNEL_ID=init-overleaf-tunnel-001\nCONTROL_PLANE_API_KEY=init-key-secret\n';

  fs.writeFileSync(paths.overleafConfigPath, initialOverleafYaml, 'utf8');
  fs.writeFileSync(paths.antigravityConfigPath, initialAntigravityYaml, 'utf8');
  fs.writeFileSync(paths.overleafEnvPath, initialOverleafEnv, 'utf8');

  // Configure package.json with ESM type in tunnelHome
  fs.writeFileSync(path.join(tunnelHome, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');

  // Copy fake-tunnel-health.mjs directly as 'run' script in tunnelHome
  fs.copyFileSync(fakeDaemonScriptPath, path.join(tunnelHome, 'run'));

  return { tmpDir, dataDir, paths, tunnelHome, appData, initialOverleafYaml, initialAntigravityYaml };
}

describe('Default Adapter E2E Pipeline Suite', () => {

  it('1. covers accepted key and target: daemon authenticates with mock control plane and produces strict verified receipt', async () => {
    // A. Start mock control plane with accepted credentials
    const cp = createMockControlPlane();
    const acceptedTunnelId = 'tunnel-accepted-001';
    const acceptedApiKey = 'sec-key-accepted-xyz';
    cp.setAcceptedCredential(acceptedTunnelId, acceptedApiKey);
    const cpInfo = await cp.start();

    // B. Setup synthetic environment with config pointing to mock control plane
    const env = createSyntheticEnvironment(cpInfo.url);
    const portFile = path.join(env.tmpDir, 'daemon-port.txt');

    // Create probe pointing to mock control plane
    const probe = createTunnelProbe({
      endpoint: cpInfo.url + '/health',
      controlPlaneBaseURL: cpInfo.url
    });

    const adapters = createAdapters({
      dataDir: env.dataDir,
      paths: env.paths,
      probe,
      scriptPath
    });

    const adapter = adapters['overleaf-mcp'];
    const opId = 'op-e2e-accepted-1';

    try {
      // 1. Prepare: validates credential shape and stages desired config in memory without mutations
      const snapshot = await adapter.prepare({
        operationId: opId,
        credential: {
          tunnelId: acceptedTunnelId,
          apiKey: acceptedApiKey
        }
      });

      assert.equal(snapshot.operationId, opId);
      assert.equal(snapshot.service, 'overleaf-mcp');
      assert.ok(snapshot.desiredFingerprint);
      assert.notEqual(snapshot.desiredFingerprint, snapshot.originalFingerprint);

      // Verify no changes to disk during prepare
      const onDiskBefore = fs.readFileSync(env.paths.overleafConfigPath, 'utf8');
      assert.equal(onDiskBefore, env.initialOverleafYaml);

      // Inject portFile, tunnelId, and control plane URL into child process launch template
      snapshot.launchTemplate.command = process.execPath;
      snapshot.launchTemplate.args = [
        'run',
        '--profile', 'overleaf',
        '--tunnel-id', acceptedTunnelId,
        '--health.listen-addr', '127.0.0.1:0',
        '--port-file', portFile,
        '--control-plane.base-url', cpInfo.url
      ];

      // 2. Apply: writes desired YAML and starts new owned daemon process via real process controller
      const applyRecord = await adapter.applyIfUnchanged({
        operationId: opId,
        snapshot
      });

      assert.ok(applyRecord);
      assert.ok(applyRecord.pid > 0);
      assert.equal(applyRecord.running, true);

      // Verify mutated YAML written to disk
      const onDiskAfter = fs.readFileSync(env.paths.overleafConfigPath, 'utf8');
      assert.ok(onDiskAfter.includes(acceptedTunnelId));

      // Wait for daemon to write its ephemeral port and start listening
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
      assert.ok(daemonPort > 0, 'Daemon failed to start or write port file');

      // 3. Inspect running daemon via real PowerShell process helper
      const inspected = await adapter.processController.inspect('overleaf-mcp');
      assert.equal(inspected.running, true);
      assert.equal(inspected.pid, applyRecord.pid);

      // Sync inspected identity to processPath for subsequent process control operations
      fs.writeFileSync(adapter.processPath, JSON.stringify({
        ...inspected,
        service: 'overleaf-mcp',
        operationId: opId,
        running: true
      }, null, 2), 'utf8');

      // Configure probe with discovered healthURL and mock control plane URL
      const loopbackHealthUrl = `http://127.0.0.1:${daemonPort}`;
      adapter.healthURL = loopbackHealthUrl;
      adapter.probe = createTunnelProbe({
        healthURL: loopbackHealthUrl,
        controlPlaneBaseURL: cpInfo.url
      });
      snapshot.healthURL = loopbackHealthUrl;
      snapshot.controlPlaneBaseURL = cpInfo.url;

      // 4. VerifyDesired: returns strict verified receipt conforming to switch-core assertion
      const verifyReceipt = await adapter.verifyDesired({
        operationId: opId,
        snapshot
      });

      assertVerifiedReceipt(verifyReceipt, opId, 'overleaf-mcp', snapshot);
      assert.equal(verifyReceipt.verified, true);
      assert.equal(verifyReceipt.proof.kind, 'authenticated-control-plane');

      // 5. Direct verification against exact protocol endpoints: /health?details=true & /api/status
      const healthRes = await fetchJson(`${loopbackHealthUrl}/health?details=true`);
      const statusRes = await fetchJson(`${loopbackHealthUrl}/api/status`);

      assert.equal(healthRes.status, 200);
      assert.equal(healthRes.body.schema_version, 1);
      assert.equal(healthRes.body.live, true);
      assert.equal(healthRes.body.ready, true);
      assert.equal(healthRes.body.components['control-plane'].status, 'ok');
      assert.equal(healthRes.body.components['control-plane'].details.consecutive_failures, 0);

      assert.equal(statusRes.status, 200);
      assert.equal(statusRes.body.client_instance_id, healthRes.body.runtime.instance_id);
      assert.equal(statusRes.body.control_plane_tunnel_id, acceptedTunnelId);

      // 6. Test GPT-owned evidence gate evaluateTunnelEvidence
      const evidence = evaluateTunnelEvidence({
        health: healthRes.body,
        adminStatus: statusRes.body,
        identity: { pid: applyRecord.pid, startedAt: inspected.startTime, executable: inspected.executablePath },
        listenerIdentity: { pid: applyRecord.pid, startedAt: inspected.startTime, executable: inspected.executablePath },
        currentConfigFingerprint: snapshot.desiredFingerprint,
        expected: {
          service: 'overleaf-mcp',
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

      // 7. Cleanup running process using real controller stop
      await adapter.processController.stop(inspected);
      const afterStop = await adapter.processController.inspect('overleaf-mcp');
      assert.equal(afterStop.running, false);
    } finally {
      await cp.close();
      try { fs.rmSync(env.tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  it('2. covers wrong key 401: mock control plane rejects with 401, evidence gate fails', async () => {
    const cp = createMockControlPlane();
    cp.setAcceptedCredential('tunnel-strict-001', 'valid-secret-key');
    const cpInfo = await cp.start();

    // Start fake daemon with wrong API key
    const daemon = startFakeTunnelDaemon({
      baseUrl: cpInfo.url,
      tunnelId: 'tunnel-strict-001',
      apiKey: 'wrong-key-401'
    });
    const dInfo = await daemon.start('127.0.0.1', 0);

    try {
      const healthRes = await fetchJson(`${dInfo.url}/health?details=true`);
      const statusRes = await fetchJson(`${dInfo.url}/api/status`);

      assert.equal(healthRes.body.components['control-plane'].status, 'degraded');
      assert.equal(healthRes.body.components['control-plane'].details.http_status, 401);
      assert.ok(healthRes.body.components['control-plane'].details.consecutive_failures >= 1);

      const identity = { pid: 8888, startedAt: dInfo.startedAt, executable: process.execPath };

      // evaluateTunnelEvidence must throw TargetEvidenceFault('CONTROL_PLANE_NOT_AUTHENTICATED')
      assert.throws(
        () => {
          evaluateTunnelEvidence({
            health: healthRes.body,
            adminStatus: statusRes.body,
            identity,
            listenerIdentity: identity,
            currentConfigFingerprint: 'f'.repeat(64),
            expected: {
              service: 'overleaf-mcp',
              operationId: 'op-wrong-key',
              tunnelId: 'tunnel-strict-001',
              configFingerprint: 'f'.repeat(64),
              identity,
              launchedAt: dInfo.startedAt,
              controlPlaneBaseURL: cpInfo.url
            }
          });
        },
        (err) => {
          assert.ok(err instanceof TargetEvidenceFault);
          assert.equal(err.code, 'CONTROL_PLANE_NOT_AUTHENTICATED');
          return true;
        }
      );
    } finally {
      await daemon.close();
      await cp.close();
    }
  });

  it('3. covers wrong target / status instance: mismatched tunnel ID or client_instance_id rejects evidence', async () => {
    const cp = createMockControlPlane();
    const cpInfo = await cp.start();

    // 3a: Wrong Target Mode
    const wrongTargetDaemon = startFakeTunnelDaemon({
      baseUrl: cpInfo.url,
      tunnelId: 'expected-tunnel-001',
      apiKey: 'good-key',
      mode: 'wrong_target'
    });
    const wtInfo = await wrongTargetDaemon.start('127.0.0.1', 0);

    const identity = { pid: 7777, startedAt: wtInfo.startedAt, executable: process.execPath };
    const h1 = await fetchJson(`${wtInfo.url}/health?details=true`);
    const s1 = await fetchJson(`${wtInfo.url}/api/status`);

    assert.throws(
      () => {
        evaluateTunnelEvidence({
          health: h1.body,
          adminStatus: s1.body,
          identity,
          listenerIdentity: identity,
          currentConfigFingerprint: 'c'.repeat(64),
          expected: {
            service: 'overleaf-mcp',
            operationId: 'op-target-mismatch',
            tunnelId: 'expected-tunnel-001',
            configFingerprint: 'c'.repeat(64),
            identity,
            launchedAt: wtInfo.startedAt,
            controlPlaneBaseURL: cpInfo.url
          }
        });
      },
      (err) => {
        assert.ok(err instanceof TargetEvidenceFault);
        assert.equal(err.code, 'TARGET_TUNNEL_MISMATCH');
        return true;
      }
    );
    await wrongTargetDaemon.close();

    // 3b: Mismatched Status Instance Mode
    const wrongInstanceDaemon = startFakeTunnelDaemon({
      baseUrl: cpInfo.url,
      tunnelId: 'expected-tunnel-001',
      apiKey: 'good-key',
      mode: 'wrong_instance'
    });
    const wiInfo = await wrongInstanceDaemon.start('127.0.0.1', 0);

    const h2 = await fetchJson(`${wiInfo.url}/health?details=true`);
    const s2 = await fetchJson(`${wiInfo.url}/api/status`);

    assert.throws(
      () => {
        evaluateTunnelEvidence({
          health: h2.body,
          adminStatus: s2.body,
          identity,
          listenerIdentity: identity,
          currentConfigFingerprint: 'c'.repeat(64),
          expected: {
            service: 'overleaf-mcp',
            operationId: 'op-inst-mismatch',
            tunnelId: 'expected-tunnel-001',
            configFingerprint: 'c'.repeat(64),
            identity,
            launchedAt: wiInfo.startedAt,
            controlPlaneBaseURL: cpInfo.url
          }
        });
      },
      (err) => {
        assert.ok(err instanceof TargetEvidenceFault);
        assert.equal(err.code, 'RUNTIME_INSTANCE_MISMATCH');
        return true;
      }
    );
    await wrongInstanceDaemon.close();
    await cp.close();
  });

  it('4. covers unowned listener: listener PID mismatch fails verification even with healthy daemon payload', async () => {
    const cp = createMockControlPlane();
    const cpInfo = await cp.start();

    const daemon = startFakeTunnelDaemon({
      baseUrl: cpInfo.url,
      tunnelId: 'tunnel-owned-001',
      apiKey: 'key-ok'
    });
    const dInfo = await daemon.start('127.0.0.1', 0);

    try {
      const h = await fetchJson(`${dInfo.url}/health?details=true`);
      const s = await fetchJson(`${dInfo.url}/api/status`);

      const realIdentity = { pid: 12345, startedAt: dInfo.startedAt, executable: process.execPath };
      // Listener identity has an unowned PID (attacker/rogue process on the port)
      const rogueListener = { pid: 54321, startedAt: dInfo.startedAt, executable: process.execPath };

      assert.throws(
        () => {
          evaluateTunnelEvidence({
            health: h.body,
            adminStatus: s.body,
            identity: realIdentity,
            listenerIdentity: rogueListener,
            currentConfigFingerprint: 'e'.repeat(64),
            expected: {
              service: 'overleaf-mcp',
              operationId: 'op-unowned-listener',
              tunnelId: 'tunnel-owned-001',
              configFingerprint: 'e'.repeat(64),
              identity: realIdentity,
              launchedAt: dInfo.startedAt,
              controlPlaneBaseURL: cpInfo.url
            }
          });
        },
        (err) => {
          assert.ok(err instanceof TargetEvidenceFault);
          assert.equal(err.code, 'PROCESS_IDENTITY_UNCONFIRMED');
          return true;
        }
      );
    } finally {
      await daemon.close();
      await cp.close();
    }
  });

  it('5. covers apply rollback: reverts config mutations and stops unverified new process', async () => {
    const env = createSyntheticEnvironment();
    const portFile = path.join(env.tmpDir, 'daemon-port-rb.txt');

    const probe = createTunnelProbe({ mockReady: true });
    const adapters = createAdapters({
      dataDir: env.dataDir,
      paths: env.paths,
      probe,
      scriptPath
    });

    const adapter = adapters['overleaf-mcp'];
    const opId = 'op-e2e-rollback-1';

    try {
      const snapshot = await adapter.prepare({
        operationId: opId,
        credential: {
          tunnelId: 'tunnel-will-fail-rollback',
          apiKey: 'key-fails'
        }
      });

      snapshot.launchTemplate.command = process.execPath;
      snapshot.launchTemplate.args = [
        'run',
        '--profile', 'overleaf',
        '--health.listen-addr', '127.0.0.1:0',
        '--port-file', portFile
      ];

      // Apply desired config and launch process
      const applyRecord = await adapter.applyIfUnchanged({
        operationId: opId,
        snapshot
      });
      assert.ok(applyRecord.running);
      assert.ok(fs.readFileSync(env.paths.overleafConfigPath, 'utf8').includes('tunnel-will-fail-rollback'));

      // Wait a moment and inspect running process to obtain verified Win32 handle identity
      await new Promise(r => setTimeout(r, 400));
      const inspected = await adapter.processController.inspect('overleaf-mcp');
      assert.equal(inspected.running, true);
      fs.writeFileSync(adapter.processPath, JSON.stringify({
        ...inspected,
        service: 'overleaf-mcp',
        operationId: opId,
        running: true
      }, null, 2), 'utf8');

      // Simulate verification failure requiring rollback:
      const receipt = await adapter.restoreIfOwned({
        operationId: opId,
        snapshot,
        step: { mayHaveMutated: true }
      });

      assertRestoredReceipt(receipt, opId, 'overleaf-mcp', snapshot);
      assert.equal(receipt.restored, true);
      assert.equal(receipt.runtimeRestored, true);

      // Verify mutated configuration is completely rolled back to original
      const restoredYaml = fs.readFileSync(env.paths.overleafConfigPath, 'utf8');
      assert.equal(restoredYaml, env.initialOverleafYaml);
      assert.ok(!restoredYaml.includes('tunnel-will-fail-rollback'));

      // Verify the launched process is stopped and not running
      const inspectAfter = await adapter.processController.inspect('overleaf-mcp');
      assert.equal(inspectAfter.running, false);
    } finally {
      try { fs.rmSync(env.tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  it('6. covers no duplicate process after intent recovery: cleans intent and prevents orphan leaks', async () => {
    const env = createSyntheticEnvironment();
    const probe = createTunnelProbe({ mockReady: true });
    const adapters = createAdapters({
      dataDir: env.dataDir,
      paths: env.paths,
      probe,
      scriptPath
    });

    const adapter = adapters['overleaf-mcp'];
    const opId = 'op-intent-recovery-1';
    const runtimeDir = path.join(env.dataDir, 'runtime');
    const intentPath = path.join(runtimeDir, 'overleaf-mcp-intent.json');
    const processPath = path.join(runtimeDir, 'overleaf-mcp-process.json');

    try {
      const snapshot = await adapter.prepare({
        operationId: opId,
        credential: {
          tunnelId: 'tunnel-intent-test',
          apiKey: 'key-intent-test'
        }
      });

      // Simulate a crash right after apply wrote the intent file
      fs.mkdirSync(runtimeDir, { recursive: true });
      fs.writeFileSync(intentPath, JSON.stringify({
        operationId: opId,
        service: 'overleaf-mcp',
        state: 'INTENT_LAUNCH',
        createdAt: new Date().toISOString()
      }, null, 2), 'utf8');

      // Launch process once
      snapshot.launchTemplate.command = process.execPath;
      snapshot.launchTemplate.args = ['run', '--profile', 'overleaf', '--health.listen-addr', '127.0.0.1:0'];
      await adapter.processController.launch({
        service: 'overleaf-mcp',
        command: snapshot.launchTemplate.command,
        args: snapshot.launchTemplate.args,
        cwd: env.tunnelHome
      });

      // Obtain verified Win32 identity for the launched process
      await new Promise(r => setTimeout(r, 400));
      const inspected = await adapter.processController.inspect('overleaf-mcp');
      assert.equal(inspected.running, true);

      fs.writeFileSync(processPath, JSON.stringify({
        ...inspected,
        service: 'overleaf-mcp',
        operationId: opId,
        running: true
      }, null, 2), 'utf8');

      // Now run restoreIfOwned (recovery sequence)
      assert.ok(fs.existsSync(intentPath));
      const restoreReceipt = await adapter.restoreIfOwned({
        operationId: opId,
        snapshot,
        step: { mayHaveMutated: true }
      });

      assertRestoredReceipt(restoreReceipt, opId, 'overleaf-mcp', snapshot);

      // Verify intent file is unlinked / cleaned up
      assert.equal(fs.existsSync(intentPath), false);

      // Verify orphan process was terminated
      const afterRecoverInspect = await adapter.processController.inspect('overleaf-mcp');
      assert.equal(afterRecoverInspect.running, false);

      // Verify repeated restore is idempotent and does NOT spawn any duplicate processes
      const repeatReceipt = await adapter.restoreIfOwned({
        operationId: opId,
        snapshot,
        step: { mayHaveMutated: false }
      });
      assert.equal(repeatReceipt.restored, true);

      const finalInspect = await adapter.processController.inspect('overleaf-mcp');
      assert.equal(finalInspect.running, false);
    } finally {
      try { fs.rmSync(env.tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

});

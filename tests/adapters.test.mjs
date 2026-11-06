import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createTunnelProbe } from '../src/adapters/tunnel-probe.mjs';
import { fileURLToPath } from 'node:url';
import { createAdapters, createDefaultProcessController, createRegisteredAdapterProvider, ServiceAdapter, SwitchFault, HttpTransportFault, TunnelLaunchEnvironmentFault, DEFAULT_PROXY, buildSafePinnedEnv } from '../src/adapters/index.mjs';
import { createVault } from '../src/vault.mjs';
import { fingerprintHttpConfiguration } from '../src/adapters/http-transport.mjs';
import {
  quoteWindowsArg,
  parseWindowsCommandLine,
  formatWindowsCommandLine,
  resolveExecutable,
  mergeBindingArgs,
  publicBindingArgs,
  validateHttpUrl,
  publicUrl,
  mergeHeadersPatch,
  publicHeaders,
  mergeBinding,
  publicBinding,
  bindingToTunnelCommand,
  BindingFault
} from '../src/adapters/mcp-binding.mjs';
import { assertStoppedConnectionReceipt, isMcpServiceId } from '../src/core/mcp-registry-policy.mjs';

const createdTempDirs = [];
function createTempWorkspace() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-test-'));
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

  const initialOverleafYaml = [
    'config_version: 1',
    'control_plane:',
    '  base_url: "https://api.openai.com"',
    '  tunnel_id: "tunnel_initial_overleaf_12345"',
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
    '      command: "node C:/Users/fixture-user/.overleaf-mcp/runtime/node_modules/mcp-server-overleaf/dist/index.js --stdio"'
  ].join('\n') + '\n';

  const initialAntigravityYaml = [
    'config_version: 1',
    'control_plane:',
    '  base_url: "https://api.openai.com"',
    '  organization_id: "org-initial-antigravity-999"',
    '  tunnel_id: "tunnel_initial_antigravity_67890"',
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

  const initialOverleafEnv = 'TUNNEL_ID=tunnel_initial_overleaf_12345\nCONTROL_PLANE_API_KEY=initial-overleaf-key\n';

  fs.writeFileSync(paths.overleafConfigPath, initialOverleafYaml, 'utf8');
  fs.writeFileSync(paths.antigravityConfigPath, initialAntigravityYaml, 'utf8');
  fs.writeFileSync(paths.overleafEnvPath, initialOverleafEnv, 'utf8');

  return { tmpDir, dataDir, paths, initialOverleafYaml, initialAntigravityYaml };
}

function createFakeProcessController() {
  const processes = new Map();
  const launchHistory = [];
  const stopHistory = [];

  return {
    processes,
    launchHistory,
    stopHistory,
    shouldFailStop: false,
    shouldFailLaunch: false,

    async inspect(service) {
      return processes.get(service) || { running: false };
    },

    async verify(identity) {
      return { valid: !this.shouldFailVerify, processId: identity?.pid };
    },

    async stop(identity) {
      this.stopHistory.push({ ...identity });
      if (this.shouldFailStop) {
        throw new Error('Fake stop failure');
      }
      for (const [svc, proc] of this.processes.entries()) {
        if (proc.pid === identity.pid) {
          this.processes.delete(svc);
        }
      }
      return { stopped: true };
    },

    async launch({ service, command, args, env, cwd, operationId }) {
      if (this.shouldFailLaunch) {
        throw new Error('Fake launch failure');
      }
      const identity = {
        pid: Math.floor(Math.random() * 90000) + 10000,
        executablePath: command,
        executable: command,
        startTime: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        running: true,
        service,
        command,
        args,
        env,
        cwd,
        operationId
      };
      this.launchHistory.push(identity);
      this.processes.set(service, identity);
      return identity;
    }
  };
}

function createFakeProbe() {
  const calls = [];
  return {
    calls,
    shouldFail: false,
    shouldThrow: false,
    async checkReady() {
      return true;
    },
    async verify(params) {
      calls.push(params);
      if (this.shouldThrow) {
        throw new Error('Probe connection refused');
      }
      if (this.shouldFail) {
        return { ok: false, error: 'Session handshake invalid' };
      }
      return {
        ok: true,
        verified: true,
        service: params.service,
        operationId: params.operationId,
        proof: { kind: 'authenticated-control-plane' },
        identity: params.identity
      };
    }
  };
}

test('1. prepare produces snapshot without filesystem mutations', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const processController = createFakeProcessController();
  const probe = createFakeProbe();

  const adapters = createAdapters({ dataDir, processController, probe, paths });

  // Read stats and content before prepare
  const beforeOverleafYaml = fs.readFileSync(paths.overleafConfigPath, 'utf8');
  const beforeOverleafEnv = fs.readFileSync(paths.overleafEnvPath, 'utf8');
  const beforeAntigravityYaml = fs.readFileSync(paths.antigravityConfigPath, 'utf8');
  const beforeOverleafMtime = fs.statSync(paths.overleafConfigPath).mtimeMs;
  const beforeAntigravityMtime = fs.statSync(paths.antigravityConfigPath).mtimeMs;

  const credOverleaf = {
    tunnelId: 'tunnel_new_overleaf_aaa',
    apiKey: 'sk-new-overleaf-key-secret'
  };

  const credAntigravity = {
    tunnelId: 'tunnel_new_antigravity_bbb',
    apiKey: 'sk-new-antigravity-key-secret',
    organizationId: 'org-new-antigravity'
  };

  const snapOverleaf = await adapters['overleaf-mcp'].prepare({
    operationId: 'op-prepare-1',
    credential: credOverleaf
  });

  const snapAntigravity = await adapters['antigravity-mcp'].prepare({
    operationId: 'op-prepare-2',
    credential: credAntigravity
  });

  // Snapshot contract validation
  for (const snap of [snapOverleaf, snapAntigravity]) {
    assert.ok(snap.operationId);
    assert.ok(snap.service);
    assert.ok(typeof snap.originalFingerprint === 'string' && snap.originalFingerprint.length === 64);
    assert.ok(typeof snap.desiredFingerprint === 'string' && snap.desiredFingerprint.length === 64);
    assert.notEqual(snap.originalFingerprint, snap.desiredFingerprint);
    assert.ok(snap.originalConfig);
    assert.ok(snap.desiredConfig);
    assert.ok(snap.originalProcessIdentity);
    assert.ok(snap.launchTemplate);
    assert.ok(snap.credential);
  }

  // Ensure staged desiredConfig contains desired values
  assert.ok(snapOverleaf.desiredConfig.yaml.includes('tunnel_new_overleaf_aaa'));
  assert.ok(snapOverleaf.desiredConfig.env.includes('tunnel_new_overleaf_aaa'));
  assert.ok(snapAntigravity.desiredConfig.yaml.includes('tunnel_new_antigravity_bbb'));
  assert.ok(snapAntigravity.desiredConfig.yaml.includes('org-new-antigravity'));

  // Ensure NO filesystem mutations occurred during prepare
  const afterOverleafYaml = fs.readFileSync(paths.overleafConfigPath, 'utf8');
  const afterOverleafEnv = fs.readFileSync(paths.overleafEnvPath, 'utf8');
  const afterAntigravityYaml = fs.readFileSync(paths.antigravityConfigPath, 'utf8');
  const afterOverleafMtime = fs.statSync(paths.overleafConfigPath).mtimeMs;
  const afterAntigravityMtime = fs.statSync(paths.antigravityConfigPath).mtimeMs;

  assert.equal(afterOverleafYaml, beforeOverleafYaml);
  assert.equal(afterOverleafEnv, beforeOverleafEnv);
  assert.equal(afterAntigravityYaml, beforeAntigravityYaml);
  assert.equal(afterOverleafMtime, beforeOverleafMtime);
  assert.equal(afterAntigravityMtime, beforeAntigravityMtime);
  assert.equal(processController.launchHistory.length, 0);
});

test('2. applyIfUnchanged CAS succeeds on match, throws on drift', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const processController = createFakeProcessController();
  const probe = createFakeProbe();

  // Seed an existing running process
  processController.processes.set('overleaf-mcp', {
    pid: 12345,
    executablePath: paths.tunnelClientBin,
    startTime: new Date().toISOString(),
    running: true
  });

  const adapters = createAdapters({ dataDir, processController, probe, paths });

  // 2A: CAS succeeds on match
  const snapshot = await adapters['overleaf-mcp'].prepare({
    operationId: 'op-cas-success',
    credential: {
      tunnelId: 'tunnel_applied_111',
      apiKey: 'sk-applied-key-111'
    }
  });

  await adapters['overleaf-mcp'].applyIfUnchanged({
    operationId: 'op-cas-success',
    snapshot
  });

  // Verify desired config is now written to disk
  const appliedYaml = fs.readFileSync(paths.overleafConfigPath, 'utf8');
  assert.ok(appliedYaml.includes('tunnel_applied_111'));
  const appliedEnv = fs.readFileSync(paths.overleafEnvPath, 'utf8');
  assert.ok(appliedEnv.includes('tunnel_applied_111'));

  // Verify old process stopped, new process launched
  assert.equal(processController.stopHistory.length, 1);
  assert.equal(processController.stopHistory[0].pid, 12345);
  assert.equal(processController.launchHistory.length, 1);
  assert.equal(processController.launchHistory[0].service, 'overleaf-mcp');

  // 2B: CAS throws on drift
  const snapshot2 = await adapters['overleaf-mcp'].prepare({
    operationId: 'op-cas-drift',
    credential: {
      tunnelId: 'tunnel_next_222',
      apiKey: 'sk-next-key-222'
    }
  });

  // Simulate external configuration drift behind adapter's back
  fs.writeFileSync(paths.overleafConfigPath, '# external drift was injected\nconfig_version: 1\n', 'utf8');

  await assert.rejects(
    async () => {
      await adapters['overleaf-mcp'].applyIfUnchanged({
        operationId: 'op-cas-drift',
        snapshot: snapshot2
      });
    },
    (err) => {
      assert.ok(err instanceof SwitchFault);
      assert.equal(err.code, 'CONFIG_DRIFT');
      return true;
    }
  );

  assert.equal(processController.launchHistory.length, 1);
});

test('3. verifyDesired succeeds on valid session, fails on verify failure', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const processController = createFakeProcessController();
  const probe = createFakeProbe();

  const adapters = createAdapters({ dataDir, processController, probe, paths });

  const snapshot = await adapters['antigravity-mcp'].prepare({
    operationId: 'op-verify-test',
    credential: {
      tunnelId: 'tunnel_verify_test',
      apiKey: 'sk-verify-test',
      organizationId: 'org-verify'
    }
  });

  // A valid receipt must describe a process actually launched for this snapshot.
  await adapters['antigravity-mcp'].applyIfUnchanged({ operationId: 'op-verify-test', snapshot });

  // 3A: Probe reports success
  probe.shouldFail = false;
  probe.shouldThrow = false;
  const verified = await adapters['antigravity-mcp'].verifyDesired({
    operationId: 'op-verify-test',
    snapshot
  });
  assert.ok(verified);
  assert.equal(verified.verified, true);
  assert.equal(verified.operationId, 'op-verify-test');
  assert.equal(verified.service, 'antigravity-mcp');
  assert.equal(verified.configFingerprint, snapshot.desiredFingerprint);
  assert.equal(verified.proof?.kind, 'authenticated-control-plane');
  assert.ok(Number.isSafeInteger(verified.identity?.pid));
  assert.ok(verified.identity?.startedAt);
  assert.ok(verified.identity?.executable);
  assert.equal(probe.calls.length, 1);

  // 3B: Probe reports ok: false
  probe.shouldFail = true;
  await assert.rejects(
    async () => {
      await adapters['antigravity-mcp'].verifyDesired({
        operationId: 'op-verify-test',
        snapshot
      });
    },
    (err) => {
      assert.ok(err instanceof SwitchFault);
      assert.equal(err.code, 'VERIFY_FAILED');
      return true;
    }
  );

  // 3C: Probe throws network/session error
  probe.shouldFail = false;
  probe.shouldThrow = true;
  await assert.rejects(
    async () => {
      await adapters['antigravity-mcp'].verifyDesired({
        operationId: 'op-verify-test',
        snapshot
      });
    },
    (err) => {
      assert.ok(err instanceof SwitchFault);
      assert.equal(err.code, 'VERIFY_FAILED');
      return true;
    }
  );

  // 3D: No probe provided reports TARGET_VERIFICATION_UNAVAILABLE
  const adaptersNoProbe = createAdapters({ dataDir, processController, probe: null, paths });
  const unavailableRes = await adaptersNoProbe['antigravity-mcp'].verifyDesired({
    operationId: 'op-verify-test',
    snapshot
  });
  assert.equal(unavailableRes.status, 'TARGET_VERIFICATION_UNAVAILABLE');
});

test('4. restoreIfOwned restores original config and process', async () => {
  const { dataDir, paths, initialAntigravityYaml } = createTempWorkspace();
  const processController = createFakeProcessController();
  const probe = createFakeProbe();

  // Set original process running
  processController.processes.set('antigravity-mcp', {
    pid: 54321,
    executablePath: paths.tunnelClientBin,
    startTime: new Date().toISOString(),
    running: true
  });

  const adapters = createAdapters({ dataDir, processController, probe, paths });

  const snapshot = await adapters['antigravity-mcp'].prepare({
    operationId: 'op-restore-test',
    credential: {
      tunnelId: 'tunnel_target_to_restore',
      apiKey: 'sk-key-to-restore',
      organizationId: 'org-target'
    }
  });

  // Apply desired config
  await adapters['antigravity-mcp'].applyIfUnchanged({
    operationId: 'op-restore-test',
    snapshot
  });

  assert.ok(fs.readFileSync(paths.antigravityConfigPath, 'utf8').includes('tunnel_target_to_restore'));
  assert.equal(processController.launchHistory.length, 1);
  const newPid = processController.launchHistory[0].pid;

  // Restore step
  const restoreRes = await adapters['antigravity-mcp'].restoreIfOwned({
    operationId: 'op-restore-test',
    snapshot,
    step: { mayHaveMutated: true }
  });
  assert.equal(restoreRes.restored, true);
  assert.equal(restoreRes.runtimeRestored, true);
  assert.equal(restoreRes.operationId, 'op-restore-test');
  assert.equal(restoreRes.service, 'antigravity-mcp');
  assert.equal(restoreRes.configFingerprint, snapshot.originalFingerprint);

  // 1. Config on disk is restored to original
  const restoredYaml = fs.readFileSync(paths.antigravityConfigPath, 'utf8');
  assert.equal(restoredYaml, initialAntigravityYaml);

  // 2. New process was stopped
  const stoppedPids = processController.stopHistory.map(p => p.pid);
  assert.ok(stoppedPids.includes(newPid));

  // 3. Original process was restarted
  assert.equal(processController.launchHistory.length, 2);
  const restartLaunch = processController.launchHistory[1];
  assert.equal(restartLaunch.service, 'antigravity-mcp');

  // Idempotency: Calling restoreIfOwned a second time succeeds without side-effects
  const restoreAgain = await adapters['antigravity-mcp'].restoreIfOwned({
    operationId: 'op-restore-test',
    snapshot,
    step: { mayHaveMutated: true }
  });
  assert.equal(restoreAgain.restored, true);
  assert.equal(processController.launchHistory.length, 2);
});

test('5. drift during restore throws to trigger NEEDS_ATTENTION', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const processController = createFakeProcessController();
  const probe = createFakeProbe();

  const adapters = createAdapters({ dataDir, processController, probe, paths });

  const snapshot = await adapters['overleaf-mcp'].prepare({
    operationId: 'op-restore-drift',
    credential: {
      tunnelId: 'tunnel_apply_before_drift',
      apiKey: 'sk-apply-before-drift'
    }
  });

  await adapters['overleaf-mcp'].applyIfUnchanged({
    operationId: 'op-restore-drift',
    snapshot
  });

  // Third party externally mutates config file while operation is rolling back
  const externalModifiedYaml = '# Externally modified config by sysadmin\nconfig_version: 2\n';
  fs.writeFileSync(paths.overleafConfigPath, externalModifiedYaml, 'utf8');

  // restoreIfOwned MUST detect drift and throw
  await assert.rejects(
    async () => {
      await adapters['overleaf-mcp'].restoreIfOwned({
        operationId: 'op-restore-drift',
        snapshot,
        step: { mayHaveMutated: true }
      });
    },
    (err) => {
      assert.ok(err instanceof SwitchFault || err instanceof Error);
      assert.equal(err.code, 'CONFIG_DRIFT');
      return true;
    }
  );

  const currentOnDisk = fs.readFileSync(paths.overleafConfigPath, 'utf8');
  assert.equal(currentOnDisk, externalModifiedYaml);
});

test('6. proxy, child env pinning and MCP environment preservation', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const processController = createFakeProcessController();
  const probe = createFakeProbe();

  const adapters = createAdapters({ dataDir, processController, probe, paths });

  const testApiKey = 'sk-super-secret-control-plane-api-key-999';
  const testTunnelId = 'tunnel_proxy_and_mcp_test_888';

  const snapshot = await adapters['overleaf-mcp'].prepare({
    operationId: 'op-proxy-test',
    credential: {
      tunnelId: testTunnelId,
      apiKey: testApiKey
    }
  });

  await adapters['overleaf-mcp'].applyIfUnchanged({
    operationId: 'op-proxy-test',
    snapshot
  });

  assert.equal(processController.launchHistory.length, 1);
  const launched = processController.launchHistory[0];

  // 1. Child environment has CONTROL_PLANE_API_KEY
  assert.equal(launched.env.CONTROL_PLANE_API_KEY, testApiKey);

  // 2. Proxy preservation in child environment
  assert.equal(launched.env.HTTP_PROXY, DEFAULT_PROXY);
  assert.equal(launched.env.HTTPS_PROXY, DEFAULT_PROXY);
  assert.equal(launched.env.ALL_PROXY, DEFAULT_PROXY);

  // 3. Command arguments contain proxy flag and NO plaintext api key
  assert.ok(launched.args.includes('--http-proxy'));
  assert.ok(launched.args.includes(DEFAULT_PROXY));
  for (const arg of launched.args) {
    assert.ok(!arg.includes(testApiKey), 'API key must never be exposed in command line arguments');
  }

  // 4. MCP commands and structure in YAML preserved
  const yamlContent = fs.readFileSync(paths.overleafConfigPath, 'utf8');
  assert.ok(yamlContent.includes('mcp:'));
  assert.ok(yamlContent.includes('mcp-server-overleaf/dist/index.js --stdio'));
  assert.ok(yamlContent.includes('api_key: "env:CONTROL_PLANE_API_KEY"'));
  assert.ok(yamlContent.includes(`tunnel_id: "${testTunnelId}"`));
});

test('7. describe returns sanitized public status without secrets', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const processController = createFakeProcessController();
  const probe = createFakeProbe();

  processController.processes.set('overleaf-mcp', {
    pid: 77777,
    executablePath: paths.tunnelClientBin,
    startTime: new Date().toISOString(),
    running: true
  });

  const adapters = createAdapters({
    dataDir,
    processController,
    probe,
    paths,
    healthURL: 'http://127.0.0.1:18080' // Private healthURL
  });

  const descOverleaf = await adapters['overleaf-mcp'].describe();
  const descAntigravity = await adapters['antigravity-mcp'].describe();

  // Overleaf describe check
  assert.equal(descOverleaf.service, 'overleaf-mcp');
  assert.equal(descOverleaf.configured, true);
  assert.equal(descOverleaf.running, true);
  assert.equal(descOverleaf.process.pid, 77777);
  assert.equal(descOverleaf.config.proxy, DEFAULT_PROXY);
  assert.ok(descOverleaf.config.hasApiKey);
  assert.ok(descOverleaf.config.tunnelId.includes('...')); // Masked

  // Antigravity describe check
  assert.equal(descAntigravity.service, 'antigravity-mcp');
  assert.equal(descAntigravity.configured, true);
  assert.equal(descAntigravity.running, false);
  assert.equal(descAntigravity.config.organizationId, 'org-initial-antigravity-999');
  assert.ok(descAntigravity.config.tunnelId.includes('...')); // Masked

  // Verify private healthURL is NOT exposed in public status
  assert.equal(descOverleaf.config.healthURL, undefined);
  assert.equal(descAntigravity.config.healthURL, undefined);

  // Verify no plaintext full tunnel IDs or api keys leaked
  const serialized = JSON.stringify({ descOverleaf, descAntigravity });
  assert.ok(!serialized.includes('tunnel_initial_overleaf_12345'));
  assert.ok(!serialized.includes('tunnel_initial_antigravity_67890'));
  assert.ok(!serialized.includes('18080'));
});

test('8. prepare succeeds static preflight with default probe on valid credentials', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const processController = createFakeProcessController();
  // Default target probe with real static preflight
  const adapters = createAdapters({ dataDir, processController, paths });

  const snap = await adapters['overleaf-mcp'].prepare({
    operationId: 'op-default-probe-preflight',
    credential: {
      tunnelId: 'tunnel_test_123',
      apiKey: 'sk-test-key'
    }
  });

  assert.ok(snap);
  assert.equal(snap.service, 'overleaf-mcp');
  assert.equal(snap.credential.tunnelId, 'tunnel_test_123');
});

test('9. prepare throws TARGET_VERIFICATION_UNAVAILABLE when credential is invalid', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const processController = createFakeProcessController();
  const probe = createFakeProbe();
  const adapters = createAdapters({ dataDir, processController, probe, paths });

  for (const badCred of [
    null,
    {},
    { tunnelId: '' },
    { tunnelId: 't', apiKey: '' },
    { tunnelId: 't\x00bad', apiKey: 'k' },
    { tunnelId: 't', apiKey: 'k\x1fbad' }
  ]) {
    await assert.rejects(
      async () => {
        await adapters['overleaf-mcp'].prepare({
          operationId: 'op-invalid-cred',
          credential: badCred
        });
      },
      (err) => {
        assert.ok(err instanceof SwitchFault);
        assert.equal(err.code, 'TARGET_VERIFICATION_UNAVAILABLE');
        return true;
      }
    );
  }
});

test('10. processController stop rejects when process identity is missing', async () => {
  const { dataDir } = createTempWorkspace();
  const adapters = createAdapters({ dataDir });
  await assert.rejects(
    async () => {
      await adapters['overleaf-mcp'].processController.stop({ pid: 1234, running: true });
    },
    (err) => {
      assert.ok(err instanceof SwitchFault);
      assert.equal(err.code, 'PROCESS_IDENTITY_MISMATCH');
      return true;
    }
  );
});

test('11. Path anchoring resolves scripts/process-control.ps1 via import.meta.url', () => {
  const expectedScriptPath = fileURLToPath(new URL('../scripts/process-control.ps1', import.meta.url));
  assert.ok(fs.existsSync(expectedScriptPath), 'Anchored script path must exist');
});

test('12. safe inherited env pinning prevents host environment secrets from leaking to child', () => {
  // Inject mock sensitive secrets into host process.env
  process.env.HOST_DATABASE_PASSWORD = 'super-secret-db-pass';
  process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret-key-123';
  process.env.GITHUB_TOKEN = 'ghp_fake_token_456';

  try {
    const pinned = buildSafePinnedEnv({
      CONTROL_PLANE_API_KEY: 'sk-pinned-test',
      HTTP_PROXY: DEFAULT_PROXY
    });

    // Pinned explicit keys are present
    assert.equal(pinned.CONTROL_PLANE_API_KEY, 'sk-pinned-test');
    assert.equal(pinned.HTTP_PROXY, DEFAULT_PROXY);

    // Host sensitive variables are strictly excluded
    assert.equal(pinned.HOST_DATABASE_PASSWORD, undefined);
    assert.equal(pinned.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(pinned.GITHUB_TOKEN, undefined);

    // Safe system keys are preserved if present in process.env
    if (process.env.SystemRoot) {
      assert.equal(pinned.SystemRoot, process.env.SystemRoot);
    }
  } finally {
    delete process.env.HOST_DATABASE_PASSWORD;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.GITHUB_TOKEN;
  }
});

test('13. runtimeCommand test hook dispatches fixed helper actions (Inspect, Verify, Stop, Launch) with raw JSON fakes', async () => {
  const { dataDir } = createTempWorkspace();
  const actionLog = [];

  const rawJsonFakeHelper = async (action, params) => {
    actionLog.push({ action, params });
    if (action === 'Inspect') {
      return JSON.stringify({
        success: true,
        running: true,
        processId: 44444,
        executablePath: 'C:\\Tools\\tunnel-client.exe',
        creationDate: '2026-11-04T00:00:00.0000000Z',
        creationTimeFileTime: '133123456789012345'
      });
    }
    if (action === 'Verify') {
      return JSON.stringify({
        success: true,
        valid: true,
        reason: 'VALID',
        processId: params.ProcessId,
        executablePath: params.ExpectedExecutablePath,
        creationDate: params.ExpectedStartTime,
        creationTimeFileTime: params.ExpectedCreationTimeFileTime
      });
    }
    if (action === 'Stop') {
      return JSON.stringify({
        success: true,
        stopped: true,
        processId: params.ProcessId
      });
    }
    if (action === 'Launch') {
      return JSON.stringify({
        success: true,
        running: true,
        processId: 55555,
        executablePath: params.ExecutablePath || params.command,
        creationDate: '2026-11-04T00:00:01.0000000Z',
        creationTimeFileTime: '133123456789099999'
      });
    }
    throw new Error(`Unhandled fake action: ${action}`);
  };

  const controller = createDefaultProcessController({
    dataDir,
    runtimeCommand: rawJsonFakeHelper
  });

  // Test Launch via runtimeCommand hook
  const launched = await controller.launch({
    service: 'overleaf-mcp',
    command: 'C:\\Tools\\tunnel-client.exe',
    args: ['run'],
    env: { HTTP_PROXY: DEFAULT_PROXY },
    operationId: 'op-hook-test'
  });
  assert.equal(launched.running, true);
  assert.equal(launched.pid, 55555);
  assert.equal(launched.executablePath, 'C:\\Tools\\tunnel-client.exe');

  // Test Inspect via runtimeCommand hook
  const inspected = await controller.inspect('overleaf-mcp');
  assert.equal(inspected.running, true);
  assert.equal(inspected.pid, 44444);
  assert.equal(inspected.executable, 'C:\\Tools\\tunnel-client.exe');

  // Test Verify via runtimeCommand hook
  const verified = await controller.verify({
    pid: 44444,
    executable: 'C:\\Tools\\tunnel-client.exe',
    startTime: '2026-11-04T00:00:00.0000000Z'
  });
  assert.equal(verified.valid, true);
  assert.equal(verified.reason, 'VALID');

  // Test Stop via runtimeCommand hook
  const stopped = await controller.stop({
    pid: 44444,
    executable: 'C:\\Tools\\tunnel-client.exe',
    startTime: '2026-11-04T00:00:00.0000000Z',
    running: true
  });
  assert.equal(stopped.stopped, true);

  // Check actions were logged
  const actions = actionLog.map(a => a.action);
  assert.deepEqual(actions, ['Launch', 'Inspect', 'Verify', 'Stop']);
});

test('14. safe intent and tag recovery during restoreIfOwned', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const processController = createFakeProcessController();
  const probe = createFakeProbe();

  const adapters = createAdapters({ dataDir, processController, probe, paths });
  const adapter = adapters['overleaf-mcp'];

  // 14A: Staged launch intent file with matching operationId is cleaned up on restore
  fs.mkdirSync(path.join(dataDir, 'runtime'), { recursive: true });
  const intentFile = path.join(dataDir, 'runtime', 'overleaf-mcp-intent.json');
  fs.writeFileSync(intentFile, JSON.stringify({
    operationId: 'op-matching-intent',
    service: 'overleaf-mcp',
    state: 'INTENT_LAUNCH',
    createdAt: new Date().toISOString()
  }), 'utf8');

  // Seed process record matching the operationId
  const processFile = path.join(dataDir, 'runtime', 'overleaf-mcp-process.json');
  fs.writeFileSync(processFile, JSON.stringify({
    operationId: 'op-matching-intent',
    service: 'overleaf-mcp',
    pid: 88888,
    executablePath: paths.tunnelClientBin,
    startTime: new Date().toISOString(),
    running: true
  }), 'utf8');

  const snapshot = {
    service: 'overleaf-mcp',
    operationId: 'op-matching-intent',
    originalFingerprint: adapter._computeFingerprint(adapter._readCurrentConfigRecord()),
    desiredFingerprint: 'd'.repeat(64),
    originalConfig: adapter._readCurrentConfigRecord(),
    originalProcessIdentity: { running: false }
  };

  const receipt = await adapter.restoreIfOwned({
    operationId: 'op-matching-intent',
    snapshot,
    step: { mayHaveMutated: true }
  });

  assert.equal(receipt.restored, true);
  // Matching intent file and process file must be cleaned up
  assert.equal(fs.existsSync(intentFile), false);
  assert.equal(fs.existsSync(processFile), false);

  // 14B: Intent belonging to a foreign operationId is NOT touched
  fs.writeFileSync(intentFile, JSON.stringify({
    operationId: 'op-foreign-intent',
    service: 'overleaf-mcp',
    state: 'INTENT_LAUNCH',
    createdAt: new Date().toISOString()
  }), 'utf8');

  await adapter.restoreIfOwned({
    operationId: 'op-matching-intent',
    snapshot,
    step: { mayHaveMutated: true }
  });

  // Foreign intent file must be safely preserved
  assert.equal(fs.existsSync(intentFile), true);
  const preservedIntent = JSON.parse(fs.readFileSync(intentFile, 'utf8'));
  assert.equal(preservedIntent.operationId, 'op-foreign-intent');
});

test('15. private healthURL configuration is passed to probe and preserved in snapshot', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const processController = createFakeProcessController();
  const probe = createFakeProbe();

  const privateHealthUrl = 'http://127.0.0.1:19555';
  const adapters = createAdapters({
    dataDir,
    processController,
    probe,
    paths,
    healthURL: privateHealthUrl
  });

  const snapshot = await adapters['overleaf-mcp'].prepare({
    operationId: 'op-health-config',
    credential: { tunnelId: 'tunnel-priv', apiKey: 'sk-priv' }
  });

  // Snapshot contains private healthURL
  assert.equal(snapshot.healthURL, privateHealthUrl);

  await adapters['overleaf-mcp'].applyIfUnchanged({ operationId: 'op-health-config', snapshot });
  // Verify call passes healthURL
  await adapters['overleaf-mcp'].verifyDesired({
    operationId: 'op-health-config',
    snapshot
  });

  assert.equal(probe.calls.length, 1);
  assert.equal(probe.calls[0].healthURL, privateHealthUrl);
});

// --- Tests for mcp-binding.mjs ---

test('16. Windows command line formatting and parsing round-trip across complex arguments', () => {
  const cases = [
    ['cmd.exe', 'arg1', 'arg2', 'arg3'],
    ['app.exe', 'with space', 'with\ttab', 'multiple   spaces'],
    ['prog.exe', '"quoted"', 'part"quote', 'multi"""quotes"""'],
    ['tool.exe', 'C:\\Program Files\\App', 'trailing\\', 'double_trailing\\\\'],
    ['tool.exe', 'arg\\"with\\"quotes', 'slashes\\\\\\"and\\"quotes'],
    ['empty.exe', '', 'non-empty', ''],
    ['node.exe', '-e', 'console.log("hello \\"world\\"", 123);', 'C:\\path with space\\dir\\', 'simple']
  ];

  for (const c of cases) {
    const exe = c[0];
    const args = c.slice(1);
    const cmdLine = formatWindowsCommandLine(exe, args);
    const parsed = parseWindowsCommandLine(cmdLine);
    assert.deepEqual(parsed, c, `Failed round-trip for: ${JSON.stringify(c)}`);
  }

  // Direct quoteWindowsArg check
  assert.equal(quoteWindowsArg(''), '""');
  assert.equal(quoteWindowsArg('simple'), 'simple');
  assert.equal(quoteWindowsArg('has space'), '"has space"');
  assert.equal(quoteWindowsArg('has"quote'), '"has\\"quote"');
  assert.equal(quoteWindowsArg('C:\\dir with space\\'), '"C:\\dir with space\\\\"');
});

test('17. Executable resolution: map npx and npx.cmd via known Node + npx-cli.js safely', () => {
  const fakeFs = {
    existsSync(p) {
      return p.includes('npx-cli.js');
    }
  };

  const res1 = resolveExecutable('npx.cmd', {
    nodePath: 'C:\\Node\\node.exe',
    npxCliPath: 'C:\\Node\\node_modules\\npm\\bin\\npx-cli.js'
  });
  assert.equal(res1.isMapped, true);
  assert.equal(res1.executable, 'C:\\Node\\node.exe');
  assert.deepEqual(res1.prependArgs, ['C:\\Node\\node_modules\\npm\\bin\\npx-cli.js']);

  const res2 = resolveExecutable('npx', {
    nodePath: 'C:\\Node\\node.exe',
    fs: fakeFs
  });
  assert.equal(res2.isMapped, true);
  assert.equal(res2.executable, 'C:\\Node\\node.exe');
  assert.ok(res2.prependArgs[0].endsWith('npx-cli.js'));

  // Normal executable resolution
  const res3 = resolveExecutable('node.exe');
  assert.equal(res3.isMapped, false);
  assert.equal(res3.executable, 'node.exe');
  assert.deepEqual(res3.prependArgs, []);
});

test('18. Executable resolution: unknown .cmd and .bat rejected without arbitrary cmd /c fallback', () => {
  for (const badExe of ['run.bat', 'start.cmd', 'C:\\tools\\custom.bat', 'foo.BAT', 'bar.CMD']) {
    assert.throws(
      () => resolveExecutable(badExe),
      (err) => {
        assert.ok(err instanceof BindingFault);
        assert.equal(err.code, 'UNSUPPORTED_EXECUTABLE');
        assert.equal(err.status, 400);
        return true;
      }
    );
  }

  for (const invalid of ['', '   ', 'a\x00b', 'a\x1fb']) {
    assert.throws(
      () => resolveExecutable(invalid),
      (err) => {
        assert.ok(err instanceof BindingFault);
        assert.equal(err.code, 'INVALID_EXECUTABLE');
        return true;
      }
    );
  }
});

test('19. Stdio arguments merge, patch, secret masking and default secret: true', () => {
  // New args default to secret: true
  const initial = mergeBindingArgs([], [
    { id: 'flag', value: '--verbose' },
    { id: 'token', value: 'secret-token-123' },
    { id: 'port', value: '8080', secret: false }
  ]);
  assert.equal(initial.length, 3);
  assert.equal(initial[0].secret, true); // defaulted to true
  assert.equal(initial[1].secret, true); // defaulted to true & sensitive name
  assert.equal(initial[2].secret, false); // explicitly non-sensitive false

  // Sensitive names cannot be unmasked even with secret: false
  const sensitiveAttempt = mergeBindingArgs([], [
    { id: 'API_KEY', value: 'key-123', secret: false }
  ]);
  assert.equal(sensitiveAttempt[0].secret, true);

  // Patch matches by id; omitting value preserves existing value; omitting arg removes it
  const patched = mergeBindingArgs(initial, [
    { id: 'flag' }, // omitted value preserves '--verbose'
    { id: 'port', value: '9090' } // updated value, omitted token is removed
  ]);
  assert.equal(patched.length, 2);
  assert.equal(patched[0].id, 'flag');
  assert.equal(patched[0].value, '--verbose');
  assert.equal(patched[0].secret, true);
  assert.equal(patched[1].id, 'port');
  assert.equal(patched[1].value, '9090');
  assert.equal(patched[1].secret, false);

  // New argument without value throws ARG_VALUE_REQUIRED
  assert.throws(
    () => mergeBindingArgs([], [{ id: 'missing_val' }]),
    (err) => {
      assert.ok(err instanceof BindingFault);
      assert.equal(err.code, 'ARG_VALUE_REQUIRED');
      return true;
    }
  );

  // Duplicate IDs rejected
  assert.throws(
    () => mergeBindingArgs([], [{ id: 'dup', value: '1' }, { id: 'dup', value: '2' }]),
    (err) => {
      assert.ok(err instanceof BindingFault);
      assert.equal(err.code, 'DUPLICATE_ARG_ID');
      return true;
    }
  );

  // Public DTO omits secret values
  const pub = publicBindingArgs(initial);
  assert.deepEqual(pub, [
    { id: 'flag', secret: true, configured: true },
    { id: 'token', secret: true, configured: true },
    { id: 'port', secret: false, configured: true, value: '8080' }
  ]);
});

test('20. HTTP endpoint binding: URL validation, userinfo rejection, and query redacting', () => {
  // Valid URLs
  assert.equal(validateHttpUrl('http://127.0.0.1:8080/mcp'), 'http://127.0.0.1:8080/mcp');
  assert.equal(validateHttpUrl('https://example.com/api'), 'https://example.com/api');

  // Reject URL userinfo
  for (const bad of [
    'http://user:pass@example.com/mcp',
    'http://user@example.com/mcp',
    'https://admin:secret123@127.0.0.1:3000/'
  ]) {
    assert.throws(
      () => validateHttpUrl(bad),
      (err) => {
        assert.ok(err instanceof BindingFault);
        assert.equal(err.code, 'URL_USERINFO_FORBIDDEN');
        return true;
      }
    );
  }

  // Reject invalid protocols
  assert.throws(() => validateHttpUrl('ftp://example.com/'), { code: 'INVALID_URL' });
  assert.throws(() => validateHttpUrl('not-a-url'), { code: 'INVALID_URL' });

  // publicUrl removes sensitive query parameters
  const publicClean = publicUrl('https://example.com/mcp?session_token=secret123&client=antigravity');
  assert.ok(!publicClean.includes('secret123'));
  assert.ok(!publicClean.includes('session_token'));
  assert.ok(publicClean.includes('client=antigravity'));
});

test('21. HTTP headers patch: set/remove, default secret: true, and sensitive header protection', () => {
  const initial = mergeHeadersPatch({}, [
    { name: 'X-Custom-Env', op: 'set', value: 'staging', secret: false },
    { name: 'Authorization', op: 'set', value: 'Bearer 12345', secret: false }, // sensitive!
    { name: 'X-Service-Id', op: 'set', value: 'test-service' } // defaults to secret: true
  ]);

  assert.equal(initial['X-Custom-Env'].secret, false);
  assert.equal(initial['X-Custom-Env'].value, 'staging');
  assert.equal(initial['Authorization'].secret, true); // forced secret
  assert.equal(initial['X-Service-Id'].secret, true); // defaulted secret

  // Patch with set and remove
  const patched = mergeHeadersPatch(initial, [
    { name: 'x-service-id', op: 'remove' },
    { name: 'X-Custom-Env', op: 'set', value: 'production', secret: false }
  ]);
  assert.equal(patched['X-Service-Id'], undefined);
  assert.equal(patched['X-Custom-Env'].value, 'production');
  assert.equal(patched['Authorization'].value, 'Bearer 12345');

  // Duplicate header names in patch rejected
  assert.throws(
    () => mergeHeadersPatch({}, [
      { name: 'Accept', op: 'set', value: 'text/html' },
      { name: 'accept', op: 'set', value: 'application/json' }
    ]),
    (err) => {
      assert.ok(err instanceof BindingFault);
      assert.equal(err.code, 'DUPLICATE_HEADER_NAME');
      return true;
    }
  );

  // Public headers omits secret values
  const pub = publicHeaders(initial);
  assert.deepEqual(pub['X-Custom-Env'], { secret: false, configured: true, value: 'staging' });
  assert.deepEqual(pub['Authorization'], { secret: true, configured: true });
  assert.deepEqual(pub['X-Service-Id'], { secret: true, configured: true });
});

test('22. Upstream tunnel-client 0.0.19 bindingToTunnelCommand formatting', () => {
  const binding = {
    type: 'stdio',
    executable: 'node',
    args: [
      { id: 'script', value: 'C:\\Users\\fixture-user\\server.js' },
      { id: 'flag', value: '--port=8080' },
      { id: 'msg', value: 'hello "world"' }
    ]
  };

  const cmd = bindingToTunnelCommand(binding);
  assert.equal(cmd.executable, 'node');
  assert.equal(cmd.args.length, 3);
  // Parsing command line reproduces args
  const parsed = parseWindowsCommandLine(cmd.command);
  assert.deepEqual(parsed, ['node', 'C:\\Users\\fixture-user\\server.js', '--port=8080', 'hello "world"']);
});

// --- Tests for createRegisteredAdapterProvider ---

test('23. createRegisteredAdapterProvider caches adapters by operation ID', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const processController = createFakeProcessController();
  const probe = createFakeProbe();

  const provider = createRegisteredAdapterProvider({ dataDir, paths, processController, probe });

  const op1 = {
    id: 'op-cache-1',
    registrySnapshot: {
      revision: 1,
      services: [
        { id: 'overleaf-mcp', enabled: true },
        { id: 'mcp_weather', enabled: true }
      ]
    }
  };

  const adapterA = await provider(op1, 'mcp_weather');
  const adapterB = await provider(op1, 'mcp_weather');
  assert.ok(adapterA);
  assert.equal(adapterA, adapterB, 'Subsequent calls for same operationId must reuse cached adapter instance');

  const op2 = {
    id: 'op-cache-2',
    registrySnapshot: {
      revision: 1,
      services: [
        { id: 'mcp_weather', enabled: true }
      ]
    }
  };
  const adapterC = await provider(op2, 'mcp_weather');
  assert.notEqual(adapterA, adapterC, 'Different operationId must have distinct adapter instance');
});

test('24. provider.release(operationId) evicts adapters from cache', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const processController = createFakeProcessController();
  const probe = createFakeProbe();

  const provider = createRegisteredAdapterProvider({ dataDir, paths, processController, probe });

  const op = {
    id: 'op-release-test',
    registrySnapshot: {
      services: [{ id: 'overleaf-mcp' }]
    }
  };

  const first = await provider(op, 'overleaf-mcp');
  provider.release('op-release-test');
  const second = await provider(op, 'overleaf-mcp');
  assert.notEqual(first, second, 'After release, provider must re-instantiate adapter');
});

test('25. provider fallbacks to legacy 2 adapters when op has no registrySnapshot', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const processController = createFakeProcessController();
  const probe = createFakeProbe();

  const provider = createRegisteredAdapterProvider({ dataDir, paths, processController, probe });

  const legacyOp = { id: 'op-legacy-fallback' };
  const overleaf = await provider(legacyOp, 'overleaf-mcp');
  const antigravity = await provider(legacyOp, 'antigravity-mcp');
  const missing = await provider(legacyOp, 'mcp_nonexistent');

  assert.ok(overleaf);
  assert.ok(antigravity);
  assert.equal(missing, undefined);
});

// --- Tests for dynamic createAdapters ---

test('26. createAdapters constructs adapters ONLY for specified definitions when provided', () => {
  const { dataDir, paths } = createTempWorkspace();
  const processController = createFakeProcessController();
  const probe = createFakeProbe();

  const customDefs = [
    { id: 'mcp_weather', enabled: true },
    { id: 'mcp_notes', enabled: true }
  ];

  const adapters = createAdapters({
    dataDir,
    paths,
    processController,
    probe,
    definitions: customDefs
  });

  assert.deepEqual(Object.keys(adapters).sort(), ['mcp_notes', 'mcp_weather']);
  assert.equal(adapters['overleaf-mcp'], undefined);
  assert.equal(adapters['antigravity-mcp'], undefined);
});

test('27. dynamic createAdapters lifecycle with stdio binding and env preservation', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const processController = createFakeProcessController();
  const probe = createFakeProbe();

  const dynamicDef = {
    id: 'mcp_custom_svc',
    enabled: true,
    binding: {
      type: 'stdio',
      executable: 'node',
      args: [
        { id: 'script', value: 'server.js', secret: false }
      ]
    },
    environment: {
      PORT: { value: '9999', secret: false },
      CUSTOM_KEY: { value: 'secret-val', secret: true },
      CONTROL_PLANE_API_KEY: { value: 'forbidden-override', secret: true }
    }
  };

  const adapters = createAdapters({
    dataDir,
    paths,
    processController,
    probe,
    definitions: [dynamicDef]
  });

  const adapter = adapters['mcp_custom_svc'];
  assert.ok(adapter);

  const snapshot = await adapter.prepare({
    operationId: 'op-dynamic-test',
    credential: {
      tunnelId: 'tunnel-dynamic-123',
      apiKey: 'sk-real-control-plane-key'
    }
  });

  assert.equal(snapshot.service, 'mcp_custom_svc');
  assert.ok(snapshot.desiredConfig.yaml.includes('tunnel-dynamic-123'));
  assert.ok(snapshot.desiredConfig.yaml.includes('server.js'));

  await adapter.applyIfUnchanged({
    operationId: 'op-dynamic-test',
    snapshot
  });

  // Verify launch arguments and env
  assert.equal(processController.launchHistory.length, 1);
  const launched = processController.launchHistory[0];
  assert.equal(launched.service, 'mcp_custom_svc');

  // Control plane credentials strictly overwrite service environment!
  assert.equal(launched.env.CONTROL_PLANE_API_KEY, 'sk-real-control-plane-key');
  assert.equal(launched.env.PORT, '9999');
  assert.equal(launched.env.CUSTOM_KEY, 'secret-val');
  assert.equal(launched.env.HTTP_PROXY, DEFAULT_PROXY);
});

// --- Tests for adapter.stopConnection ---

test('28. adapter.stopConnection stops console-owned process and cleans up process file', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const processController = createFakeProcessController();
  const probe = createFakeProbe();

  const adapters = createAdapters({ dataDir, paths, processController, probe });
  const adapter = adapters['overleaf-mcp'];

  // Seed running process record
  const procFile = path.join(dataDir, 'runtime', 'overleaf-mcp-process.json');
  fs.mkdirSync(path.join(dataDir, 'runtime'), { recursive: true });
  const procIdentity = {
    service: 'overleaf-mcp',
    pid: 65432,
    executable: paths.tunnelClientBin,
    startedAt: '2026-11-04T12:00:00.000Z',
    running: true
  };
  fs.writeFileSync(procFile, JSON.stringify(procIdentity, null, 2), 'utf8');
  processController.processes.set('overleaf-mcp', procIdentity);

  const receipt = await adapter.stopConnection({
    operationId: 'op-stop-owned',
    serviceId: 'overleaf-mcp',
    originalRuntime: { identity: { pid: 65432 } }
  });

  assert.equal(receipt.stopped, true);
  assert.equal(receipt.operationId, 'op-stop-owned');
  assert.equal(receipt.service, 'overleaf-mcp');
  assert.equal(receipt.proof.kind, 'verified-owned-process-exit');
  assert.equal(receipt.identity.pid, 65432);
  assert.ok(receipt.identity.startedAt);
  assert.ok(receipt.identity.executable);

  // Validates with strict policy receipt assertion
  assert.equal(assertStoppedConnectionReceipt(receipt, 'op-stop-owned', 'overleaf-mcp'), true);

  // Process was stopped in processController
  assert.equal(processController.stopHistory.length, 1);
  assert.equal(processController.stopHistory[0].pid, 65432);

  // Process file on disk was cleaned up
  assert.equal(fs.existsSync(procFile), false);
});

test('29. adapter.stopConnection returns verified-already-stopped when process is not running', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const processController = createFakeProcessController();
  const probe = createFakeProbe();

  const adapters = createAdapters({ dataDir, paths, processController, probe });
  const adapter = adapters['antigravity-mcp'];

  // Process controller has no running process
  const receipt = await adapter.stopConnection({
    operationId: 'op-stop-already',
    serviceId: 'antigravity-mcp'
  });

  assert.equal(receipt.stopped, true);
  assert.equal(receipt.operationId, 'op-stop-already');
  assert.equal(receipt.service, 'antigravity-mcp');
  assert.equal(receipt.proof.kind, 'verified-already-stopped');

  // Validates with strict policy receipt assertion
  assert.equal(assertStoppedConnectionReceipt(receipt, 'op-stop-already', 'antigravity-mcp'), true);
  assert.equal(processController.stopHistory.length, 0);
});

test('30. adapter.stopConnection rejects unmanaged / foreign processes without killing', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const processController = createFakeProcessController();
  const probe = createFakeProbe();

  const adapters = createAdapters({ dataDir, paths, processController, probe });
  const adapter = adapters['overleaf-mcp'];

  // A foreign process is running on the system, but NO process file was created by console!
  processController.processes.set('overleaf-mcp', {
    pid: 99999, // Unmanaged PID
    executable: 'C:\\Other\\program.exe',
    startedAt: '2026-11-04T10:00:00.000Z',
    running: true
  });

  await assert.rejects(
    async () => {
      await adapter.stopConnection({
        operationId: 'op-stop-unmanaged',
        serviceId: 'overleaf-mcp'
      });
    },
    (err) => {
      assert.ok(err instanceof SwitchFault);
      assert.equal(err.code, 'PROCESS_IDENTITY_MISMATCH');
      return true;
    }
  );

  // Unmanaged process was NOT killed!
  assert.equal(processController.stopHistory.length, 0);

  // Service mismatch rejects
  await assert.rejects(
    async () => {
      await adapter.stopConnection({
        operationId: 'op-stop-mismatch',
        serviceId: 'antigravity-mcp'
      });
    },
    (err) => {
      assert.ok(err instanceof SwitchFault);
      assert.equal(err.code, 'SERVICE_MISMATCH');
      return true;
    }
  );
});

test('31. ServiceAdapter _buildLaunchTemplate supports official healthUrlFile and controlPlaneBaseUrl, excludes portFile and launchArgs', () => {
  const { dataDir, paths } = createTempWorkspace();
  const processController = createFakeProcessController();
  const probe = createFakeProbe();

  const customPaths = {
    ...paths,
    controlPlaneBaseUrl: 'http://127.0.0.1:54321',
    healthUrlFile: 'C:/temp/health-url.txt',
    extraArgs: ['--debug-mode']
  };

  const adapters = createAdapters({
    dataDir,
    paths: customPaths,
    processController,
    probe,
    definitions: [{
      id: 'mcp_extra_args',
      launchArgs: ['--custom-flag']
    }]
  });

  const adapter = adapters['mcp_extra_args'];
  const template = adapter._buildLaunchTemplate({ tunnelId: 'tid-1', apiKey: 'key-1' });

  assert.ok(template.args.includes('--control-plane.base-url'));
  assert.ok(template.args.includes('http://127.0.0.1:54321'));
  assert.ok(template.args.includes('--health.url-file'));
  assert.ok(template.args.includes('C:/temp/health-url.txt'));
  assert.ok(template.args.includes('--debug-mode'));
  // Unsupported port-file and launchArgs escape are removed from production launch
  assert.ok(!template.args.includes('--port-file'));
  assert.ok(!template.args.includes('--custom-flag'));
});

test('32. ServiceAdapter applyIfUnchanged populates snapshot.launchedAt and snapshot.identity', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const processController = createFakeProcessController();
  const probe = createFakeProbe();

  const adapters = createAdapters({
    dataDir,
    paths,
    processController,
    probe,
    definitions: [{ id: 'mcp_snapshot_meta' }]
  });

  const adapter = adapters['mcp_snapshot_meta'];
  const snapshot = await adapter.prepare({
    operationId: 'op-meta-1',
    credential: { tunnelId: 'tunnel-meta', apiKey: 'key-meta' }
  });

  assert.equal(snapshot.launchedAt, undefined);
  assert.equal(snapshot.identity, undefined);

  await adapter.applyIfUnchanged({
    operationId: 'op-meta-1',
    snapshot
  });

  assert.ok(snapshot.launchedAt);
  assert.ok(snapshot.identity);
  assert.ok(snapshot.identity.pid > 0);
});

test('33. Stdio without vault remains compatible; HTTP persistence without vault throws safe HTTP_VAULT_REQUIRED before effects', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const processController = createFakeProcessController();
  const probe = createFakeProbe();

  // Stdio without vault works
  const stdioAdapters = createAdapters({
    dataDir,
    paths,
    processController,
    probe,
    definitions: [{ id: 'mcp_stdio_novault', binding: { type: 'stdio', executable: 'node' } }]
  });
  const stdioAdapter = stdioAdapters['mcp_stdio_novault'];
  const stdioSnapshot = await stdioAdapter.prepare({
    operationId: 'op-stdio-novault',
    credential: { tunnelId: 'tunnel-s1', apiKey: 'key-s1' }
  });
  assert.equal(stdioSnapshot.desiredKind, 'stdio');

  // HTTP without vault throws HTTP_VAULT_REQUIRED before any effects
  const httpAdapters = createAdapters({
    dataDir,
    paths,
    processController,
    probe,
    definitions: [{
      id: 'mcp_http_novault',
      binding: { type: 'http', url: 'https://example.com/api' }
    }]
  });
  const httpAdapter = httpAdapters['mcp_http_novault'];
  await assert.rejects(
    async () => {
      await httpAdapter.prepare({
        operationId: 'op-http-novault',
        credential: { tunnelId: 'tunnel-h1', apiKey: 'key-h1' }
      });
    },
    (err) => err instanceof HttpTransportFault && err.code === 'HTTP_VAULT_REQUIRED'
  );
});

test('34. HTTP adapter prepare compiles HTTP transport, creates encrypted packet, and uses fingerprintHttpConfiguration for desiredFingerprint', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const vault = createVault({ dataDir });
  const processController = createFakeProcessController();
  const probe = createFakeProbe();

  try {
    const serviceId = 'mcp_http_prep';
    const opId = 'op-http-prep-01';
    const httpUrl = 'https://api.openai-mcp.org/v1/tools?sig=signed-query-param';
    const headers = {
      'Authorization': { value: 'Bearer secret-mcp-token' },
      'X-Tenant': { value: 'tenant-42' }
    };

    const adapters = createAdapters({
      dataDir,
      paths,
      processController,
      probe,
      vault,
      definitions: [{
        id: serviceId,
        binding: { type: 'http', url: httpUrl, headers }
      }]
    });

    const adapter = adapters[serviceId];
    const snapshot = await adapter.prepare({
      operationId: opId,
      credential: { tunnelId: 'tunnel-http-01', apiKey: 'key-http-01' }
    });

    assert.equal(snapshot.desiredKind, 'http');
    assert.ok(snapshot.desiredPacket);
    assert.ok(snapshot.desiredPacketPath);
    assert.ok(fs.existsSync(snapshot.desiredPacketPath));

    // Verify desired fingerprint is 64 hex characters from fingerprintHttpConfiguration
    assert.ok(/^[a-f0-9]{64}$/.test(snapshot.desiredFingerprint));
    const expectedFp = fingerprintHttpConfiguration(snapshot.desiredConfig.yaml, snapshot.desiredPacketBytes);
    assert.equal(snapshot.desiredFingerprint, expectedFp);

    // Verify generated YAML profile does not contain main stdio command or secrets
    assert.ok(!snapshot.desiredConfig.yaml.includes('commands:'));
    assert.ok(!snapshot.desiredConfig.yaml.includes('secret-mcp-token'));
    assert.ok(!snapshot.desiredConfig.yaml.includes(httpUrl));
  } finally {
    vault.close();
  }
});

test('35. HTTP adapter apply connects compileHttpTransport: raw MCP_SERVER_URL in child env, header references in args, private env merged last', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const vault = createVault({ dataDir });
  const processController = createFakeProcessController();
  const probe = createFakeProbe();

  try {
    const serviceId = 'mcp_http_launch';
    const opId = 'op-http-launch-01';
    const httpUrl = 'https://custom.mcp.host/tools';
    const headers = { 'X-Auth': { value: 'my-token-abc' } };

    const adapters = createAdapters({
      dataDir,
      paths,
      processController,
      probe,
      vault,
      definitions: [{
        id: serviceId,
        binding: { type: 'http', url: httpUrl, headers },
        environment: {
          SAFE_ENV_VAR: { value: 'safe_val' },
          // Untrusted attempt to override MCP_SERVER_URL must be rejected
          MCP_SERVER_URL: { value: 'http://malicious-override.com' }
        }
      }]
    });

    const adapter = adapters[serviceId];

    // Prepare with malicious override in definition.environment fails in compile/merge
    await assert.rejects(
      async () => {
        const snap = await adapter.prepare({
          operationId: opId,
          credential: { tunnelId: 'tunnel-h2', apiKey: 'key-h2' }
        });
        await adapter.applyIfUnchanged({ operationId: opId, snapshot: snap });
      },
      (err) => (err instanceof HttpTransportFault && err.code === 'RESERVED_HTTP_ENV') ||
               (err instanceof TunnelLaunchEnvironmentFault && err.code === 'RESERVED_LAUNCH_ENV')
    );

    // Now with valid non-conflicting environment
    adapter.definition.environment = {
      APP_CUSTOM_SETTING: { value: 'setting_123' }
    };

    const snapshot = await adapter.prepare({
      operationId: opId,
      credential: { tunnelId: 'tunnel-h2', apiKey: 'key-h2' }
    });

    await adapter.applyIfUnchanged({ operationId: opId, snapshot });

    const launched = processController.launchHistory.find(p => p.service === serviceId);
    assert.ok(launched);
    // Raw MCP_SERVER_URL in child env
    assert.equal(launched.env.MCP_SERVER_URL, httpUrl);
    // Header references in args
    const headerArgIdx = launched.args.indexOf('--mcp.extra-headers');
    assert.ok(headerArgIdx >= 0);
    assert.ok(launched.args[headerArgIdx + 1].startsWith('X-Auth: env:TUNNEL_CLIENT_MCP_HEADER_'));
    // Private env header variable exists in env with secret value
    const varName = launched.args[headerArgIdx + 1].split('env:')[1];
    assert.equal(launched.env[varName], 'my-token-abc');
    // Non-conflicting service env preserved
    assert.equal(launched.env.APP_CUSTOM_SETTING, 'setting_123');
    // Control plane API key pinned
    assert.equal(launched.env.CONTROL_PLANE_API_KEY, 'key-h2');
  } finally {
    vault.close();
  }
});

test('36. Default controller does not remerge process.env; parent stale MCP_* variables are cleanly scrubbed', async () => {
  const { dataDir, paths } = createTempWorkspace();

  // Deliberately seed parent process.env with stale MCP_* values
  const originalEnvUrl = process.env.MCP_SERVER_URL;
  const originalEnvHeader = process.env.TUNNEL_CLIENT_MCP_HEADER_OLD;
  process.env.MCP_SERVER_URL = 'http://stale.parent.host.leak';
  process.env.TUNNEL_CLIENT_MCP_HEADER_OLD = 'stale-token-leak';

  const dispatchedEnvs = [];
  const runtimeCommand = async (action, params) => {
    if (action === 'Inspect') return { running: false };
    if (action === 'Launch') {
      dispatchedEnvs.push(params.env);
      return { processId: 9988, creationDate: new Date().toISOString() };
    }
    return { code: 0 };
  };

  const controller = createDefaultProcessController({
    dataDir,
    runtimeCommand
  });

  try {
    await controller.launch({
      service: 'mcp_clean_env_test',
      command: 'test-exe',
      args: ['run'],
      env: { CUSTOM_VAR: 'hello' },
      operationId: 'op-clean-1'
    });

    assert.equal(dispatchedEnvs.length, 1);
    const childEnv = dispatchedEnvs[0];
    assert.equal(childEnv.CUSTOM_VAR, 'hello');
    // Parent stale MCP values must NOT be present
    assert.equal(childEnv.MCP_SERVER_URL, undefined);
    assert.equal(childEnv.TUNNEL_CLIENT_MCP_HEADER_OLD, undefined);
  } finally {
    if (originalEnvUrl !== undefined) process.env.MCP_SERVER_URL = originalEnvUrl;
    else delete process.env.MCP_SERVER_URL;
    if (originalEnvHeader !== undefined) process.env.TUNNEL_CLIENT_MCP_HEADER_OLD = originalEnvHeader;
    else delete process.env.TUNNEL_CLIENT_MCP_HEADER_OLD;
  }
});

test('37. Stdio after HTTP scrubs stale HTTP environment', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const vault = createVault({ dataDir });
  const processController = createFakeProcessController();
  const probe = createFakeProbe();

  try {
    const serviceId = 'mcp_http_to_stdio';
    const op1 = 'op-phase1-http';
    const httpDefinition = {
      id: serviceId,
      binding: {
        type: 'http',
        url: 'https://phase1.mcp.host/tools',
        headers: { 'X-Secret': { value: 'phase1-secret' } }
      }
    };

    const adapters1 = createAdapters({
      dataDir,
      paths,
      processController,
      probe,
      vault,
      definitions: [httpDefinition]
    });

    const adapter1 = adapters1[serviceId];
    const snap1 = await adapter1.prepare({
      operationId: op1,
      credential: { tunnelId: 'tunnel-p1', apiKey: 'key-p1' }
    });
    await adapter1.applyIfUnchanged({ operationId: op1, snapshot: snap1 });

    // Now switch service to stdio
    const op2 = 'op-phase2-stdio';
    const stdioDefinition = {
      id: serviceId,
      binding: {
        type: 'stdio',
        executable: 'node',
        args: [{ id: 'a1', value: 'server.js', secret: false }]
      }
    };

    const adapters2 = createAdapters({
      dataDir,
      paths,
      processController,
      probe,
      vault,
      definitions: [stdioDefinition]
    });

    const adapter2 = adapters2[serviceId];
    const snap2 = await adapter2.prepare({
      operationId: op2,
      credential: { tunnelId: 'tunnel-p2', apiKey: 'key-p2' }
    });
    assert.equal(snap2.originalKind, 'http');
    assert.equal(snap2.desiredKind, 'stdio');

    await adapter2.applyIfUnchanged({ operationId: op2, snapshot: snap2 });

    const lastLaunch = processController.launchHistory[processController.launchHistory.length - 1];
    assert.equal(lastLaunch.service, serviceId);
    assert.equal(lastLaunch.env.MCP_SERVER_URL, undefined);
    // All TUNNEL_CLIENT_MCP_HEADER_* must be scrubbed
    for (const key of Object.keys(lastLaunch.env)) {
      assert.ok(!key.startsWith('TUNNEL_CLIENT_MCP_HEADER_'));
    }
  } finally {
    vault.close();
  }
});

test('38. HTTP <-> Stdio rollback recovers original kind and old packet without recomputing from new definition', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const vault = createVault({ dataDir });
  const processController = createFakeProcessController();
  const probe = createFakeProbe();

  try {
    const serviceId = 'mcp_rollback_test';
    const opHttp = 'op-rb-http';
    const originalUrl = 'https://original.mcp.host/api';
    const originalHeaders = { 'X-Original-Auth': { value: 'orig-secret' } };

    // Initial deployment: HTTP
    const adaptersHttp = createAdapters({
      dataDir,
      paths,
      processController,
      probe,
      vault,
      definitions: [{
        id: serviceId,
        binding: { type: 'http', url: originalUrl, headers: originalHeaders }
      }]
    });

    const adapterHttp = adaptersHttp[serviceId];
    const snapHttp = await adapterHttp.prepare({
      operationId: opHttp,
      credential: { tunnelId: 'tunnel-orig', apiKey: 'key-orig' }
    });
    await adapterHttp.applyIfUnchanged({ operationId: opHttp, snapshot: snapHttp });

    // Next mutation to stdio fails during verifyDesired, triggering restoreIfOwned
    const opStdio = 'op-rb-stdio';
    const adaptersStdio = createAdapters({
      dataDir,
      paths,
      processController,
      probe,
      vault,
      definitions: [{
        id: serviceId,
        binding: { type: 'stdio', executable: 'node' }
      }]
    });

    const adapterStdio = adaptersStdio[serviceId];
    const snapStdio = await adapterStdio.prepare({
      operationId: opStdio,
      credential: { tunnelId: 'tunnel-new', apiKey: 'key-new' }
    });
    assert.equal(snapStdio.originalKind, 'http');
    assert.equal(snapStdio.desiredKind, 'stdio');

    await adapterStdio.applyIfUnchanged({ operationId: opStdio, snapshot: snapStdio });

    // Restore to original state
    const restoreReceipt = await adapterStdio.restoreIfOwned({
      operationId: opStdio,
      snapshot: snapStdio
    });

    assert.equal(restoreReceipt.restored, true);
    assert.equal(restoreReceipt.configFingerprint, snapStdio.originalFingerprint);

    // Verify restored process has recovered original HTTP environment and args
    const restoredProc = processController.launchHistory.find(p => p.operationId === `${opStdio}-restored`);
    assert.ok(restoredProc);
    assert.equal(restoredProc.env.MCP_SERVER_URL, originalUrl);
    const headerVar = Object.keys(restoredProc.env).find(k => k.startsWith('TUNNEL_CLIENT_MCP_HEADER_'));
    assert.ok(headerVar);
    assert.equal(restoredProc.env[headerVar], 'orig-secret');
  } finally {
    vault.close();
  }
});

test('39. Ambiguous multichannel YAML config fails clearly BEFORE effects', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const vault = createVault({ dataDir });
  const processController = createFakeProcessController();
  const probe = createFakeProbe();

  try {
    const serviceId = 'mcp_multichannel_test';
    const configPath = path.join(paths.appData, 'tunnel-client', `${serviceId}.yaml`);

    // Write existing YAML with secondary channel
    const multiChannelYaml = [
      'config_version: 1',
      'control_plane:',
      '  base_url: "https://api.openai.com"',
      '  tunnel_id: "tid-1"',
      '  api_key: "env:CONTROL_PLANE_API_KEY"',
      'mcp:',
      '  commands:',
      '    - channel: secondary',
      '      command: "node secondary.js"'
    ].join('\n') + '\n';
    fs.writeFileSync(configPath, multiChannelYaml, 'utf8');

    const adapters = createAdapters({
      dataDir,
      paths: { ...paths, [`${serviceId}ConfigPath`]: configPath },
      processController,
      probe,
      vault,
      definitions: [{
        id: serviceId,
        binding: { type: 'http', url: 'https://example.com' }
      }]
    });

    const adapter = adapters[serviceId];

    await assert.rejects(
      async () => {
        await adapter.prepare({
          operationId: 'op-multi-fail',
          credential: { tunnelId: 'tid-1', apiKey: 'key-1' }
        });
      },
      (err) => err instanceof SwitchFault && err.code === 'AMBIGUOUS_CONFIG'
    );
  } finally {
    vault.close();
  }
});

test('40. buildTunnelLaunchEnvironment produces frozen complete null-prototype childenv in adapter lifecycle without controller re-merging', async () => {
  const { dataDir, paths } = createTempWorkspace();
  const vault = createVault({ dataDir });
  const launchedEnvs = [];
  const runtimeCommand = async (action, params) => {
    if (action === 'Inspect') return { running: false };
    if (action === 'Launch') {
      launchedEnvs.push(params.env);
      return { processId: 10444, creationDate: new Date().toISOString() };
    }
    return { code: 0 };
  };
  const processController = createDefaultProcessController({ dataDir, runtimeCommand });
  const probe = createFakeProbe();

  try {
    const serviceId = 'mcp_frozen_env_test';
    const opId = 'op-frozen-01';
    const httpUrl = 'https://frozen.mcp.host/tools';
    const headers = { 'X-Secret': { value: 'top-secret-val' } };

    const adapters = createAdapters({
      dataDir,
      paths,
      processController,
      probe,
      vault,
      definitions: [{
        id: serviceId,
        binding: { type: 'http', url: httpUrl, headers },
        environment: {
          CUSTOM_APP_FLAG: { value: 'custom-enabled' }
        }
      }]
    });

    const adapter = adapters[serviceId];
    const snapshot = await adapter.prepare({
      operationId: opId,
      credential: { tunnelId: 'tunnel-f1', apiKey: 'key-f1' }
    });

    await adapter.applyIfUnchanged({ operationId: opId, snapshot });

    assert.equal(launchedEnvs.length, 1);
    const childEnv = launchedEnvs[0];

    // Child env must be frozen and have null prototype
    assert.ok(Object.isFrozen(childEnv));
    assert.equal(Object.getPrototypeOf(childEnv), null);

    // Correct variables present
    assert.equal(childEnv.MCP_SERVER_URL, httpUrl);
    assert.equal(childEnv.CONTROL_PLANE_API_KEY, 'key-f1');
    assert.equal(childEnv.CUSTOM_APP_FLAG, 'custom-enabled');
    assert.equal(childEnv.HTTP_PROXY, DEFAULT_PROXY);

    // Verify secret header exists
    const headerVarKey = Object.keys(childEnv).find(k => k.startsWith('TUNNEL_CLIENT_MCP_HEADER_'));
    assert.ok(headerVarKey);
    assert.equal(childEnv[headerVarKey], 'top-secret-val');
  } finally {
    vault.close();
  }
});

test('41. process controller uses explicit env verbatim whether frozen or unfrozen without host remerge or rescrub', async () => {
  const { dataDir } = createTempWorkspace();
  const dispatched = [];
  const runtimeCommand = async (action, params) => {
    if (action === 'Inspect') return { running: false };
    if (action === 'Launch') {
      dispatched.push(params.env);
      return { processId: 12345, creationDate: new Date().toISOString() };
    }
    return { code: 0 };
  };

  const controller = createDefaultProcessController({ dataDir, runtimeCommand });

  // 1. Explicit unfrozen env with custom vars is used verbatim
  const explicitUnfrozen = {
    CUSTOM_KEY: 'custom_val',
    EXPLICIT_TEST_VAR: '123'
  };
  assert.equal(Object.isFrozen(explicitUnfrozen), false);

  await controller.launch({
    service: 'unfrozen_test',
    command: 'test_cmd',
    args: [],
    env: explicitUnfrozen,
    operationId: 'op_unfrozen'
  });

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0], explicitUnfrozen);
  assert.equal(dispatched[0].CUSTOM_KEY, 'custom_val');
  assert.equal(dispatched[0].EXPLICIT_TEST_VAR, '123');

  // 2. Omitted env (undefined) falls back to clearInheritedMcpOverrides(buildSafePinnedEnv({}))
  await controller.launch({
    service: 'omitted_test',
    command: 'test_cmd',
    args: [],
    operationId: 'op_omitted'
  });

  assert.equal(dispatched.length, 2);
  const fallbackEnv = dispatched[1];
  assert.ok(fallbackEnv);
  assert.equal(fallbackEnv.CUSTOM_KEY, undefined);
  if (process.env.SystemRoot) {
    assert.equal(fallbackEnv.SystemRoot, process.env.SystemRoot);
  }
});

test('default HTTP adapter preflight rejects missing local upstream without touching vault, files or processes', async () => {
  const {dataDir, paths, initialOverleafYaml} = createTempWorkspace();
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/mcp?token=private-token`;
  await new Promise(resolve => server.close(resolve));
  const processController = createFakeProcessController();
  let inspected = false;
  processController.inspect = async () => { inspected = true; throw Error('must not inspect'); };
  const vault = {seal() { throw Error('must not seal'); }, unseal() { throw Error('must not unseal'); }};
  const adapters = createAdapters({dataDir, paths, processController, vault,
    probe: createTunnelProbe(), definitions: [{id: 'mcp_bridge', binding: {type: 'http', url}}]});
  await assert.rejects(adapters.mcp_bridge.prepare({operationId: 'op-local-preflight',
    credential: {tunnelId: 'tunnel-local', apiKey: 'private-api-key'}}), error => {
    assert.ok(error instanceof SwitchFault);
    assert.equal(error.code, 'TARGET_VERIFICATION_UNAVAILABLE');
    assert.equal(error.reason, 'HTTP_UPSTREAM_UNREACHABLE');
    assert.doesNotMatch(JSON.stringify(error), /private-token|private-api-key/);
    return true;
  });
  assert.equal(inspected, false);
  assert.equal(processController.launchHistory.length, 0);
  assert.equal(processController.stopHistory.length, 0);
  assert.deepEqual(fs.readdirSync(dataDir), []);
  assert.equal(fs.readFileSync(paths.overleafConfigPath, 'utf8'), initialOverleafYaml);
});

test('strict verification never fabricates process identity or uses a saved PID without a live process', async () => {
  const {dataDir, paths} = createTempWorkspace();
  const controller = createFakeProcessController();
  const probe = createFakeProbe();
  const adapter = createAdapters({dataDir, paths, probe, processController: controller})['antigravity-mcp'];
  const operationId = 'op-real-identity';
  const snapshot = await adapter.prepare({operationId, credential: {tunnelId: 'identity-test', apiKey: 'private-key'}});
  for (const process of [
    {running: false, pid: 8123},
    {running: true, pid: 0, startTime: '2026-11-04T00:00:00Z', executable: 'tunnel.exe'},
    {running: true, pid: '8123', startTime: '2026-11-04T00:00:00Z', executable: 'tunnel.exe'},
    {running: true, pid: 8123, executable: 'tunnel.exe'},
    {running: true, pid: 8123, startTime: '2026-11-04T00:00:00Z'}
  ]) {
    controller.processes.set('antigravity-mcp', process);
    await assert.rejects(adapter.verifyDesired({operationId, snapshot}), error => {
      assert.equal(error.code, 'VERIFY_FAILED');
      assert.equal(error.reason, 'PROCESS_IDENTITY_UNCONFIRMED');
      return true;
    });
  }
  assert.equal(probe.calls.length, 0, 'HTTP success must not compensate for a missing real process');
});

test('production Windows launch uses an inheritable hidden native console and never replays an unacknowledged launch', () => {
  const source = fs.readFileSync(new URL('../src/adapters/index.mjs', import.meta.url), 'utf8');
  const native = fs.readFileSync(new URL('../scripts/process-control.ps1', import.meta.url), 'utf8');
  assert.match(source, /spawn\('powershell', args,\s*\{\s*stdio:[^}]+windowsHide:\s*true/s);
  assert.match(source, /if \(process.platform === 'win32'\) \{\s*const payload = \{[^}]+hiddenConsole: true/s);
  assert.match(source, /executeHelper\('Launch', \{ LaunchPayload: payload \}\)/);
  assert.match(source, /if \(action === 'Launch'\) \{\s*throw new SwitchFault\('PROCESS_LAUNCH_UNCONFIRMED'/);
  assert.match(native, /uint flags = hiddenConsole \? CREATE_NEW_CONSOLE : CREATE_NO_WINDOW/);
  assert.match(native, /si\.wShowWindow = 0/);
});

test('adapter exposes only allowlisted probe failure reasons and still requires verified evidence', async () => {
  const {dataDir, paths} = createTempWorkspace();
  const probe = createFakeProbe();
  const adapters = createAdapters({dataDir, paths, probe, processController: createFakeProcessController()});
  const adapter = adapters['antigravity-mcp'];
  const operationId = 'op-safe-diagnostic';
  const snapshot = await adapter.prepare({operationId, credential: {tunnelId: 'tunnel-safe', apiKey: 'private-api-key'}});
  await adapter.applyIfUnchanged({operationId, snapshot});
  for (const [result, reason] of [
    [{ok: false, verified: false, code: 'RUNTIME_NOT_READY'}, 'RUNTIME_NOT_READY'],
    [{ok: false, verified: false, error: 'CONTROL_PLANE_NOT_AUTHENTICATED'}, 'CONTROL_PLANE_NOT_AUTHENTICATED'],
    [{ok: false, error: 'Authorization: Bearer private-api-key'}, null],
    [{ok: false, code: 'PRIVATE_API_KEY'}, null],
    [{ok: true}, null], [undefined, null]
  ]) {
    probe.verify = async () => result;
    await assert.rejects(adapter.verifyDesired({operationId, snapshot}), error => {
      assert.ok(error instanceof SwitchFault);
      assert.equal(error.code, 'VERIFY_FAILED');
      assert.equal(error.reason, reason);
      assert.doesNotMatch(JSON.stringify(error), /private-api-key|PRIVATE_API_KEY|Authorization/);
      return true;
    });
  }
});

after(() => {
  for (const d of createdTempDirs) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch (_) {}
  }
});






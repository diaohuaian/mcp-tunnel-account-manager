/**
 * E2E: concurrent multi-account tunnel instances for ONE MCP service.
 *
 * Contract: docs/analysis/concurrent-instances-contract.md §6
 *
 * Real code exercised (no stubs of the feature itself):
 *   - REAL store (node:sqlite) in a temp dir: profiles, registry, instance_runtime
 *   - REAL `createInstanceAdapterProvider` / `InstanceAdapter` (isolated profile YAML,
 *     per-instance runtime records, ephemeral loopback health handshake)
 *   - REAL `runInstanceLifecycleAction` (instance-scoped policy + persistence)
 *
 * Stubbed only at the OS boundary: the audited process controller is replaced by an
 * injected `runtimeCommand` fake (no PowerShell, no real tunnel binary), and the
 * health probe is replaced by a deterministic stub. Every subprocess is fake and
 * every path is inside a `mkdtemp()` directory, so production is never touched.
 *
 * Assertions:
 *   1. start userA, then start userB for the SAME service => BOTH running,
 *      distinct pids, distinct localPorts, distinct instanceIds.
 *   2. stop userA only => userB still running with the SAME pid.
 *   3. every adapter path resolves inside the temp dir (no %APPDATA% writes).
 *   4. legacy `decideTunnelClientAction` behaviour is unchanged (regression).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { openStore } from '../../src/store.mjs';
import { createVault } from '../../src/vault.mjs';
import { runInstanceLifecycleAction } from '../../src/core/instance-lifecycle.mjs';
import {
  createInstanceAdapterProvider,
  instanceProfileDirPath
} from '../../src/adapters/instance-adapter.mjs';
import { decideTunnelClientAction } from '../../src/core/tunnel-client-lifecycle.mjs';
import { buildInstanceId, profileYamlFileName } from '../../src/core/concurrent-instances.mjs';

const SERVICE_ID = 'mcp_instancesvc';
const PROFILE_A = 'userA';
const PROFILE_B = 'userB';
const INSTANCE_A = `${SERVICE_ID}__${PROFILE_A}`;
const INSTANCE_B = `${SERVICE_ID}__${PROFILE_B}`;

/**
 * Fake audited process controller back end. Mixture of "OS" behaviours the real
 * scripts/process-control.ps1 provides (Inspect / Verify / Stop / Launch), with
 * deterministic identities. Only fake processes: nothing is spawned.
 */
function createFakeRuntime({ firstPort = 41100 } = {}) {
  const alive = new Map(); // pid -> identity
  let nextPid = 900_000;
  let nextPort = firstPort;
  const calls = [];

  const runtimeCommand = async (action, params = {}) => {
    calls.push({ action, params });

    if (action === 'Launch') {
      const pid = ++nextPid;
      const port = ++nextPort;
      const args = Array.isArray(params.args) ? params.args : [];
      const healthUrlFileIndex = args.indexOf('--health.url-file');
      const healthUrlFile = healthUrlFileIndex >= 0 ? args[healthUrlFileIndex + 1] : null;
      const identity = {
        running: true,
        processId: pid,
        executablePath: params.ExecutablePath || (args.length ? 'fake-tunnel-client' : 'fake-tunnel-client'),
        creationDate: new Date(1_760_000_000_000 + pid).toISOString(),
        creationTimeFileTime: String(133_000_000_000_000_000n + BigInt(pid)),
        localPort: port,
        healthURL: `http://127.0.0.1:${port}`
      };
      alive.set(pid, identity);
      // Emulate tunnel-client's `--health.url-file` handshake so the instance
      // adapter can observe this account's OWN ephemeral port.
      if (healthUrlFile) {
        fs.mkdirSync(path.dirname(healthUrlFile), { recursive: true });
        fs.writeFileSync(healthUrlFile, `${identity.healthURL}\n`, 'utf8');
      }
      return {
        code: 0,
        success: true,
        processId: pid,
        executablePath: identity.executablePath,
        creationDate: identity.creationDate,
        creationTimeFileTime: identity.creationTimeFileTime
      };
    }

    if (action === 'Inspect') {
      const pid = Number(params.ProcessId);
      const identity = alive.get(pid);
      if (!identity) return { code: 0, running: false };
      return {
        code: 0,
        running: true,
        processId: pid,
        executablePath: identity.executablePath,
        creationDate: identity.creationDate,
        creationTimeFileTime: identity.creationTimeFileTime,
        localPort: identity.localPort,
        healthURL: identity.healthURL
      };
    }

    if (action === 'Verify') {
      const pid = Number(params.ProcessId);
      const identity = alive.get(pid);
      const valid = Boolean(identity)
        && String(params.ExpectedExecutablePath) === String(identity.executablePath)
        && String(params.ExpectedCreationTimeFileTime) === String(identity.creationTimeFileTime);
      return { code: 0, valid, reason: valid ? 'VALID' : 'PROCESS_IDENTITY_MISMATCH' };
    }

    if (action === 'Stop') {
      const pid = Number(params.ProcessId);
      const identity = alive.get(pid);
      if (!identity) return { code: 0, stopped: true };
      if (String(params.ExpectedExecutablePath) !== String(identity.executablePath)
        || String(params.ExpectedCreationTimeFileTime) !== String(identity.creationTimeFileTime)) {
        return { code: 2, error: 'PROCESS_IDENTITY_MISMATCH' };
      }
      alive.delete(pid);
      return { code: 0, stopped: true };
    }

    if (action === 'FindOwned') {
      // Instance scopes must never fall back to tag scanning.
      calls.push({ action: 'FindOwned-DENIED', params });
      return { code: 0, running: false };
    }

    return { code: 0 };
  };

  return {
    runtimeCommand,
    calls,
    isAlive: (pid) => alive.has(Number(pid)),
    aliveCount: () => alive.size,
    portFor(pid) {
      const identity = alive.get(pid);
      return identity ? identity.localPort : null;
    }
  };
}

/** Deterministic probe stub: real verification is out of scope, evidence shape is not. */
function createStubProbe() {
  return {
    isDefault: false,
    healthURL: null,
    async checkReady() { return true; },
    async probe() { return null; },
    async verify(params = {}) {
      return {
        ok: true,
        verified: true,
        identity: params.identity,
        proof: { kind: 'authenticated-control-plane' }
      };
    }
  };
}

/**
 * Wraps the real store so instance-scoped actions remain addressable even if the
 * registry slice that persists `mcp_actions.instance_id` is not present in this
 * build. It is a FEATURE-DETECTED fallback only:
 *
 *  - when the loaded record already exposes `instanceId`, it is passed through
 *    untouched (that is the production path, asserted separately in `runAction`);
 *  - otherwise the id is derived from the record's own (serviceId, profileId)
 *    through the frozen namespace, so the lifecycle sees exactly the value
 *    production would have written.
 */
function createInstanceScopedRepo(store) {
  const derive = (action) => {
    if (!action || typeof action !== 'object') return action;
    const existing = action.instanceId || action.instance_id || null;
    if (existing) return action;
    let instanceId = null;
    try {
      instanceId = buildInstanceId(action.serviceId, action.profileId);
    } catch {
      instanceId = null; // legacy whole-service action (e.g. stop without a profile)
    }
    return instanceId ? { ...action, instanceId } : action;
  };

  return {
    ...store,
    async loadAction(id) {
      return derive(await store.loadAction(id));
    }
  };
}

function listFilesRecursive(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

describe('Concurrent multi-account tunnel instances (e2e)', () => {
  let tmpDir;
  let dataDir;
  let vault;
  let store;
  let repo;
  let provider;
  let fakeRuntime;
  let stubProbe;
  let createdPids;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'concurrent-instances-e2e-'));
    dataDir = path.join(tmpDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });

    // Isolated paths: nothing here may resolve to %APPDATA%\tunnel-client.
    const tunnelHome = path.join(tmpDir, 'tunnel-home');
    fs.mkdirSync(tunnelHome, { recursive: true });
    const fakeBin = path.join(tunnelHome, 'tunnel-client.exe');
    fs.writeFileSync(fakeBin, 'fake-binary', 'utf8');

    const paths = {
      userProfile: tmpDir,
      appData: path.join(tmpDir, 'app-data'),
      tunnelHome,
      tunnelClientBin: fakeBin
    };
    fs.mkdirSync(paths.appData, { recursive: true });

    vault = createVault({ dataDir });
    fakeRuntime = createFakeRuntime();
    store = openStore({
      dataDir,
      vault,
      isProcessAlive: (pid) => fakeRuntime.isAlive(pid)
    });

    // A registered, non-carrier service with a regular stdio binding.
    await store.registry.create({
      id: SERVICE_ID,
      label: 'Concurrent Instances Test Service',
      enabled: true,
      binding: { type: 'stdio', executable: 'node', args: [] }
    });

    // Two accounts, both configured for the same service.
    await store.createProfile({
      id: PROFILE_A,
      label: 'Account A',
      services: { [SERVICE_ID]: { tunnelId: 'tunnel-aaaa-1111', apiKey: 'key-aaaa' } }
    });
    await store.createProfile({
      id: PROFILE_B,
      label: 'Account B',
      services: { [SERVICE_ID]: { tunnelId: 'tunnel-bbbb-2222', apiKey: 'key-bbbb' } }
    });

    stubProbe = createStubProbe();
    provider = createInstanceAdapterProvider({
      dataDir,
      vault,
      probe: stubProbe,
      paths,
      runtimeCommand: fakeRuntime.runtimeCommand
    });

    repo = createInstanceScopedRepo(store);
    createdPids = [];
  });

  after(async () => {
    try { store?.close?.(); } catch (_) {}
    try { await vault?.close?.(); } catch (_) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  /** Creates a QUEUED lifecycle action and runs it through the instance lifecycle. */
  async function runAction(action, profileId) {
    const instanceId = buildInstanceId(SERVICE_ID, profileId);
    const created = await store.registry.createLifecycleAction({
      action,
      serviceId: SERVICE_ID,
      profileId,
      instanceId
    });
    const actionId = created.id || created.operationId;

    // The store must persist the instance scope itself: `loadAction` on the RAW
    // store (not the derivation shim below) has to expose it, or the runner would
    // route this action to the legacy whole-service path.
    const preRun = await store.loadAction(actionId);
    assert.equal(
      preRun.instanceId,
      instanceId,
      `registry must persist the instance scope for ${action}/${profileId}`
    );
    assert.equal(preRun.state, 'QUEUED');

    const result = await runInstanceLifecycleAction({
      repo,
      adapterProvider: provider,
      actionId,
      vault
    });
    // Terminal state is read back AFTER the lifecycle ran.
    const loaded = await store.loadAction(actionId);
    return { actionId, result, preRun, loaded };
  }

  // -------------------------------------------------------------------------
  // 1. Two accounts of ONE service run CONCURRENTLY
  // -------------------------------------------------------------------------
  test('1. start userA then userB for the SAME service: both running with distinct pid/port/instanceId', async () => {
    const startA = await runAction('start', PROFILE_A);
    assert.equal(startA.loaded.state, 'SUCCEEDED', `start A must succeed (got ${startA.loaded.state} / ${startA.loaded.errorCode})`);

    // --- KEY INVARIANT: a running sibling must not block a different profile ---
    assert.deepEqual(
      store.listRunningInstanceProfileIds(SERVICE_ID),
      [PROFILE_A],
      'only userA is running before userB starts'
    );

    const siblingBefore = store.listRunningInstanceProfileIds(SERVICE_ID);
    assert.equal(siblingBefore.length, 1);

    const startB = await runAction('start', PROFILE_B);
    assert.equal(startB.loaded.state, 'SUCCEEDED', `start B must succeed (got ${startB.loaded.state} / ${startB.loaded.errorCode})`);

    const running = store.listRunningInstanceProfileIds(SERVICE_ID);
    assert.deepEqual(running, [PROFILE_A, PROFILE_B], 'both accounts must be running concurrently');

    const instanceA = store.getInstanceRuntime(INSTANCE_A);
    const instanceB = store.getInstanceRuntime(INSTANCE_B);

    assert.ok(instanceA, 'userA instance runtime record must exist');
    assert.ok(instanceB, 'userB instance runtime record must exist');

    // Distinct composite ids for the same service.
    assert.notEqual(instanceA.instanceId, instanceB.instanceId);
    assert.equal(instanceA.instanceId, INSTANCE_A);
    assert.equal(instanceB.instanceId, INSTANCE_B);
    assert.equal(instanceA.serviceId, SERVICE_ID);
    assert.equal(instanceB.serviceId, SERVICE_ID);
    assert.equal(instanceA.profileId, PROFILE_A);
    assert.equal(instanceB.profileId, PROFILE_B);

    // Distinct real-ish pids and distinct ephemeral local ports.
    assert.ok(Number.isSafeInteger(instanceA.pid) && instanceA.pid > 0, 'A must have a positive pid');
    assert.ok(Number.isSafeInteger(instanceB.pid) && instanceB.pid > 0, 'B must have a positive pid');
    assert.notEqual(instanceA.pid, instanceB.pid, 'the two accounts must be separate processes');

    assert.ok(Number.isSafeInteger(instanceA.localPort) && instanceA.localPort > 0, 'A must have a local port');
    assert.ok(Number.isSafeInteger(instanceB.localPort) && instanceB.localPort > 0, 'B must have a local port');
    assert.notEqual(instanceA.localPort, instanceB.localPort, 'each account binds its own health port');
    assert.notEqual(instanceA.localPort, 17642, 'must never bind the production console port');
    assert.notEqual(instanceB.localPort, 17642, 'must never bind the production console port');

    // Health URLs are loopback + per instance.
    assert.match(instanceA.healthURL, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(instanceB.healthURL, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.notEqual(instanceA.healthURL, instanceB.healthURL);

    assert.equal(instanceA.state, 'running');
    assert.equal(instanceB.state, 'running');

    assert.equal(fakeRuntime.aliveCount(), 2, 'exactly two fake tunnel processes must be alive');

    startA.originalInstance = instanceA;
    startB.originalInstance = instanceB;
  });

  // -------------------------------------------------------------------------
  // 2. Stop ONE account only -> the sibling keeps running, same pid
  // -------------------------------------------------------------------------
  test('2. stop userA only: userB stays running with the SAME pid', async () => {
    const beforeB = store.getInstanceRuntime(INSTANCE_B);
    assert.ok(beforeB, 'userB record must exist before stopping A');
    const pidBefore = beforeB.pid;
    assert.equal(beforeB.state, 'running');

    const stopA = await runAction('stop', PROFILE_A);
    assert.equal(stopA.loaded.state, 'SUCCEEDED', `stop A must succeed (got ${stopA.loaded.state} / ${stopA.loaded.errorCode})`);

    const instanceA = store.getInstanceRuntime(INSTANCE_A);
    assert.equal(instanceA.state, 'stopped', 'A must be recorded as stopped');
    assert.equal(instanceA.pid, null, 'A must not keep a pid after stopping');

    const instanceB = store.getInstanceRuntime(INSTANCE_B);
    assert.equal(instanceB.state, 'running', 'stopping A must never stop the sibling B');
    assert.equal(instanceB.pid, pidBefore, 'B must keep the exact same pid');
    assert.ok(Number.isSafeInteger(instanceB.localPort) && instanceB.localPort > 0);

    assert.deepEqual(store.listRunningInstanceProfileIds(SERVICE_ID), [PROFILE_B]);
    assert.equal(fakeRuntime.aliveCount(), 1, 'exactly one fake tunnel process remains');
  });

  // -------------------------------------------------------------------------
  // 3. Isolation: every adapter path lives inside the temp dir
  // -------------------------------------------------------------------------
  test('3. all instance adapter paths are isolated inside the temp data dir (no %APPDATA%)', async () => {
    const adapterA = await provider({}, SERVICE_ID, PROFILE_A);
    const adapterB = await provider({}, SERVICE_ID, PROFILE_B);

    const profileDir = instanceProfileDirPath(dataDir);
    assert.equal(profileDir, path.join(dataDir, 'instances', 'profiles'));
    assert.ok(profileDir.startsWith(tmpDir), 'profile dir must live under the temp dir');

    for (const [profileId, adapter] of [[PROFILE_A, adapterA], [PROFILE_B, adapterB]]) {
      const instanceId = `${SERVICE_ID}__${profileId}`;
      assert.equal(adapter.instanceId, instanceId);
      assert.equal(adapter.profileId, profileId);

      // Profile YAML is the documented per-account file, inside the temp dir.
      assert.equal(adapter.configPath, path.join(profileDir, profileYamlFileName(SERVICE_ID, profileId)));
      assert.ok(adapter.configPath.startsWith(tmpDir), 'profile YAML must be inside the temp dir');

      // Runtime record/intent/health handshake are per instance.
      assert.equal(adapter.processPath, path.join(dataDir, 'runtime', `${instanceId}-process.json`));
      assert.equal(adapter.intentPath, path.join(dataDir, 'runtime', `${instanceId}-intent.json`));
      assert.ok(adapter.healthUrlFile.startsWith(tmpDir));

      // Never the PRODUCTION profile directory / data directory. Compared against
      // the real roots rather than the substring "appdata", because os.tmpdir()
      // itself normally lives under %LOCALAPPDATA%\Temp on Windows.
      const productionProfileDir = process.env.APPDATA
        ? path.resolve(process.env.APPDATA, 'tunnel-client').toLowerCase()
        : null;
      const productionDataDir = process.env.LOCALAPPDATA
        ? path.resolve(process.env.LOCALAPPDATA, 'McpTunnelAccountManager').toLowerCase()
        : null;

      const lowerPaths = [adapter.configPath, adapter.processPath, adapter.intentPath, adapter.healthUrlFile]
        .map(p => path.resolve(p).toLowerCase());
      for (const candidate of lowerPaths) {
        if (productionProfileDir) {
          assert.ok(
            candidate !== productionProfileDir && !candidate.startsWith(`${productionProfileDir}${path.sep}`),
            `path must never resolve into %APPDATA%\\tunnel-client: ${candidate}`
          );
        }
        if (productionDataDir) {
          assert.ok(
            candidate !== productionDataDir && !candidate.startsWith(`${productionDataDir}${path.sep}`),
            `path must never resolve into the production data dir: ${candidate}`
          );
        }
        assert.ok(candidate.startsWith(tmpDir.toLowerCase()), `path must stay inside the temp dir: ${candidate}`);
      }
    }

    // A and B never share a profile YAML, a runtime record or a health handshake.
    assert.notEqual(adapterA.configPath, adapterB.configPath);
    assert.notEqual(adapterA.processPath, adapterB.processPath);
    assert.notEqual(adapterA.healthUrlFile, adapterB.healthUrlFile);

    // Everything the run touched exists only under the temp dir.
    for (const file of listFilesRecursive(dataDir)) {
      assert.ok(file.startsWith(dataDir), `unexpected file outside the data dir: ${file}`);
    }

    // The generated profile YAML carries the account's own tunnel id, in the
    // ISOLATED directory (never %APPDATA%\tunnel-client).
    for (const [profileId, adapter] of [[PROFILE_A, adapterA], [PROFILE_B, adapterB]]) {
      if (!fs.existsSync(adapter.configPath)) continue; // A was stopped -> config restored/removed
      const yaml = fs.readFileSync(adapter.configPath, 'utf8');
      assert.ok(!yaml.includes('tunnel-aaaa-1111') || profileId === PROFILE_A);
      assert.ok(!yaml.includes('tunnel-bbbb-2222') || profileId === PROFILE_B);
    }
  });

  // -------------------------------------------------------------------------
  // 4. Legacy single-active-profile policy is unchanged
  // -------------------------------------------------------------------------
  test('4. legacy decideTunnelClientAction behaviour is unchanged (regression)', () => {
    const legacyCtx = {
      serviceId: 'overleaf-mcp',
      registeredAdapter: true,
      serviceEnabled: true,
      eligibleProfileIds: ['profile-1'],
      binaryAvailable: true,
      controlCarrier: false,
      nowMs: 100_000,
      snapshot: { state: 'stopped', absenceVerified: true, observedAt: 99_000, managed: true }
    };

    assert.deepEqual(decideTunnelClientAction('pause', legacyCtx), { decision: 'reject', code: 'INVALID_ACTION' });
    assert.deepEqual(
      decideTunnelClientAction('start', { ...legacyCtx, registeredAdapter: false }),
      { decision: 'reject', code: 'SERVICE_NOT_MANAGED' }
    );

    const start = decideTunnelClientAction('start', { ...legacyCtx, requestedProfileId: 'profile-1' });
    assert.equal(start.decision, 'enqueue');
    assert.equal(start.serviceId, 'overleaf-mcp');
    assert.equal(start.profileId, 'profile-1');

    // A legacy `stop` without an instance still resolves to profileId: null and
    // therefore targets the whole service — instance scoping must not leak here.
    const stop = decideTunnelClientAction('stop', {
      ...legacyCtx,
      snapshot: {
        state: 'running',
        owned: true,
        identityVerified: true,
        pid: 4242,
        startedAt: '2026-11-09T00:00:00.000Z',
        executablePath: 'C:\\fake\\tunnel-client.exe',
        observedAt: 99_000
      }
    });
    assert.equal(stop.decision, 'enqueue');
    assert.equal(stop.profileId, null, 'legacy stop must stay whole-service (profileId: null)');
    assert.equal(stop.expectedIdentity.pid, 4242);
    assert.equal(stop.instanceId, undefined, 'legacy decisions must not invent an instanceId');

    // Unmanaged external client still rejected.
    assert.deepEqual(
      decideTunnelClientAction('start', { ...legacyCtx, snapshot: { state: 'unmanaged', observedAt: 99_000 } }),
      { decision: 'reject', code: 'EXTERNAL_CLIENT_NOT_MANAGED' }
    );
  });

  // -------------------------------------------------------------------------
  // 5. Instance actions must NEVER move the legacy single-active pointer
  // -------------------------------------------------------------------------
  test('5. instance start/stop leave active_profiles untouched while the legacy pointer still advances', async () => {
    // Seed the legacy pointer with a DIFFERENT owner. This is the condition that
    // exposes the bug: with an empty pointer (null -> null) a broken
    // finishLifecycleAction looks harmless, which is exactly how it shipped green.
    const pointerOwner = PROFILE_B;
    store.registry.handleSetActiveService(SERVICE_ID, pointerOwner, 1, 1);

    const readPointer = () => store.getServiceRuntime(SERVICE_ID).activeProfileId;
    const readState = () => store.getServiceRuntime(SERVICE_ID).runtimeState;

    assert.equal(readPointer(), pointerOwner, 'seed failed: legacy pointer must be pre-set');

    // Start BOTH instances for the same service. Neither may touch the pointer.
    const startA = await runAction('start', PROFILE_A);
    assert.equal(startA.loaded.state, 'SUCCEEDED');
    assert.equal(readPointer(), pointerOwner, 'instance start A must not move the legacy pointer');

    const startB = await runAction('start', PROFILE_B);
    assert.equal(startB.loaded.state, 'SUCCEEDED');
    assert.equal(readPointer(), pointerOwner, 'instance start B must not move the legacy pointer');

    // Both instances really are running...
    assert.equal(store.getInstanceRuntime(INSTANCE_A).state, 'running');
    assert.equal(store.getInstanceRuntime(INSTANCE_B).state, 'running');
    assert.equal(readState(), 'running', 'a service with a live instance must read as running');

    // ...and stopping one must not clear the pointer either (this was the worst
    // symptom: the console reported the service as stopped while a tunnel lived).
    const stopA = await runAction('stop', PROFILE_A);
    assert.equal(stopA.loaded.state, 'SUCCEEDED');
    assert.equal(readPointer(), pointerOwner, 'instance stop A must not clear the legacy pointer');
    assert.equal(readState(), 'running', 'sibling B still running => service still running');

    // A legacy WHOLE-SERVICE action must still advance/clear the pointer exactly
    // as before: instance scoping must not disable the legacy hot-switch model.
    const legacyStart = await store.registry.createLifecycleAction({
      action: 'start',
      serviceId: SERVICE_ID,
      profileId: PROFILE_A
    });
    await store.registry.finishLifecycleAction(
      legacyStart.id,
      { started: true, operationId: legacyStart.id, service: SERVICE_ID },
      { action: 'start', profileId: PROFILE_A }
    );
    assert.equal(readPointer(), PROFILE_A, 'legacy whole-service start must still set the pointer');

    const legacyStop = await store.registry.createLifecycleAction({
      action: 'stop',
      serviceId: SERVICE_ID,
      profileId: PROFILE_A
    });
    await store.registry.finishLifecycleAction(
      legacyStop.id,
      { stopped: true, operationId: legacyStop.id, service: SERVICE_ID, proof: { kind: 'verified-already-stopped' } },
      { action: 'stop' }
    );
    assert.equal(readPointer(), null, 'legacy whole-service stop must still clear the pointer');

    // The legacy instance-less wrapper keeps its original behaviour too.
    store.registry.handleSetActiveService(SERVICE_ID, pointerOwner, 1, 1);
    const legacyStop2 = await store.registry.createLifecycleAction({
      action: 'stop',
      serviceId: SERVICE_ID,
      profileId: PROFILE_A
    });
    await store.registry.finishStoppedAction(legacyStop2.id, {
      stopped: true, operationId: legacyStop2.id, service: SERVICE_ID, proof: { kind: 'verified-already-stopped' }
    });
    assert.equal(readPointer(), null, 'finishStoppedAction must still clear the pointer');

    // Clean up so later assertions/state stay predictable.
    await runAction('stop', PROFILE_B);
  });

  // -------------------------------------------------------------------------
  // 6. Stale process record with recycled PID: treated as stopped, starts cleanly
  // -------------------------------------------------------------------------
  test('6. a recycled PID that fails verification is treated as stopped and starts cleanly', async () => {
    const adapter = await provider({ serviceId: SERVICE_ID, profileId: PROFILE_A }, SERVICE_ID, PROFILE_A);
    // Write a stale process record pointing to a live fake PID whose identity does not match
    const launched = await fakeRuntime.runtimeCommand('Launch', { ExecutablePath: 'unrelated-process.exe' });
    const livePid = launched.processId;
    fs.mkdirSync(path.dirname(adapter.processPath), { recursive: true });
    fs.writeFileSync(adapter.processPath, JSON.stringify({
      pid: livePid,
      executablePath: 'original-tunnel-client.exe',
      creationTimeFileTime: '11111111111111111'
    }), 'utf8');

    const startResult = await runAction('start', PROFILE_A);
    assert.equal(startResult.loaded.state, 'SUCCEEDED', `recycled pid must not reject as EXTERNAL_CLIENT_NOT_MANAGED (got ${startResult.loaded.state} / ${startResult.loaded.errorCode})`);
    await runAction('stop', PROFILE_A);
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRunner } from '../src/runner.mjs';
import { DaemonLockError } from '../src/core/daemon-lock.mjs';
import { runMcpStopAction } from '../src/core/mcp-lifecycle.mjs';

function createFakeRepo(initialOps = [], initialActions = []) {
  const operations = new Map();
  const actions = new Map();
  const steps = new Map();

  for (const op of initialOps) {
    operations.set(op.id, { ...op });
    if (op.steps) {
      for (const [service, step] of Object.entries(op.steps)) {
        steps.set(`${op.id}:${service}`, { ...step });
      }
    }
  }

  for (const act of initialActions) {
    const id = act.id || act.operationId;
    actions.set(id, { ...act, id, operationId: id });
  }

  return {
    operations,
    actions,
    steps,
    addOperation(op) {
      operations.set(op.id, { ...op });
    },
    addStopAction(act) {
      const id = act.id || act.operationId;
      actions.set(id, { ...act, id, operationId: id });
    },
    async isActionId(id) {
      return actions.has(id);
    },
    async isOperationId(id) {
      return operations.has(id);
    },
    async pendingOperationIds() {
      const TERMINAL = new Set(['SUCCEEDED', 'ROLLED_BACK', 'REJECTED', 'NEEDS_ATTENTION']);
      const interrupted = [];
      const queued = [];
      for (const [id, op] of operations.entries()) {
        if (!TERMINAL.has(op.status)) {
          if (op.status === 'QUEUED') {
            queued.push(id);
          } else {
            interrupted.push(id);
          }
        }
      }
      return [...interrupted, ...queued];
    },
    async getWorkQueue() {
      const TERMINAL_OP = new Set(['SUCCEEDED', 'ROLLED_BACK', 'REJECTED', 'NEEDS_ATTENTION']);
      const TERMINAL_ACT = new Set(['SUCCEEDED', 'REJECTED', 'NEEDS_ATTENTION']);
      const interrupted = [];
      const queued = [];

      for (const [id, op] of operations.entries()) {
        if (!TERMINAL_OP.has(op.status)) {
          if (op.status === 'QUEUED') {
            queued.push({ id, createdAt: op.createdAt || 0 });
          } else {
            interrupted.push({ id, createdAt: op.createdAt || 0 });
          }
        }
      }

      for (const [id, act] of actions.entries()) {
        const st = act.state || act.status;
        if (!TERMINAL_ACT.has(st)) {
          if (st === 'QUEUED') {
            queued.push({ id, createdAt: act.createdAt || 0 });
          } else {
            interrupted.push({ id, createdAt: act.createdAt || 0 });
          }
        }
      }

      interrupted.sort((a, b) => a.createdAt - b.createdAt);
      queued.sort((a, b) => a.createdAt - b.createdAt);

      return [...interrupted.map(x => x.id), ...queued.map(x => x.id)];
    },
    async load(id) {
      if (actions.has(id)) {
        return { ...actions.get(id) };
      }
      const op = operations.get(id);
      if (!op) throw new Error(`Operation ${id} not found`);
      return { ...op };
    },
    async loadAction(id) {
      const act = actions.get(id);
      if (!act) throw new Error(`Action ${id} not found`);
      return { ...act };
    },
    async publicOperation(id) {
      if (actions.has(id)) {
        return this.publicAction(id);
      }
      const op = operations.get(id);
      if (!op) throw new Error(`Operation ${id} not found`);
      return { ...op };
    },
    async publicAction(id) {
      const act = actions.get(id);
      if (!act) throw new Error(`Action ${id} not found`);
      return {
        operationId: act.operationId || act.id || id,
        id: act.id || act.operationId || id,
        kind: 'stop',
        profileId: null,
        serviceId: act.serviceId,
        state: act.state || act.status,
        createdAt: act.createdAt,
        updatedAt: act.updatedAt || act.createdAt,
        errorCode: act.errorCode
      };
    },
    async transitionAction(id, patch) {
      const act = actions.get(id);
      if (!act) throw new Error(`Action ${id} not found`);
      Object.assign(act, patch);
      if (patch.state) act.status = patch.state;
    },
    async finishStoppedAction(id, receipt) {
      const act = actions.get(id);
      if (!act) throw new Error(`Action ${id} not found`);
      act.state = 'SUCCEEDED';
      act.status = 'SUCCEEDED';
      act.receipt = receipt;
    },
    async markActionAttention(id, safeCode) {
      const act = actions.get(id);
      if (!act) throw new Error(`Action ${id} not found`);
      act.state = 'NEEDS_ATTENTION';
      act.status = 'NEEDS_ATTENTION';
      act.errorCode = safeCode;
    },
    async phase(id, phase, failureCode) {
      const op = operations.get(id);
      if (op) {
        op.status = phase;
        op.failureCode = failureCode;
      }
    },
    async begin(id) {
      const op = operations.get(id);
      if (op) op.status = 'PREPARING';
    },
    async pinnedCredential() {
      return { token: 'secret-auth-token-never-leak' };
    },
    async prepared(id, service, snapshot) {
      steps.set(`${id}:${service}`, { snapshot, prepared: true });
    },
    async markMayMutate(id, service) {
      const key = `${id}:${service}`;
      const s = steps.get(key) || {};
      s.mayHaveMutated = true;
      steps.set(key, s);
    },
    async unsealSnapshot(id, service) {
      const key = `${id}:${service}`;
      return steps.get(key)?.snapshot || {};
    },
    async applied(id, service) {
      const key = `${id}:${service}`;
      const s = steps.get(key) || {};
      s.applied = true;
      steps.set(key, s);
    },
    async commitSuccess(id) {
      const op = operations.get(id);
      if (op) op.status = 'SUCCEEDED';
    },
    async step(id, service) {
      return steps.get(`${id}:${service}`);
    },
    async restored(id, service) {
      const key = `${id}:${service}`;
      const s = steps.get(key) || {};
      s.restored = true;
      steps.set(key, s);
    },
    async restoreFailed(id, service, reason) {
      const key = `${id}:${service}`;
      const s = steps.get(key) || {};
      s.restoreFailed = reason;
      steps.set(key, s);
    },
    async finishRollback(id, status) {
      const op = operations.get(id);
      if (op) op.status = status;
    }
  };
}

function createFakeAdapters(tracker = [], options = {}) {
  const makeService = (service) => ({
    // Synthetic owned identity only: no OS process is inspected or stopped here.
    processPath: fileURLToPath(new URL('./fixtures/owned-runner-process.json', import.meta.url)),
    processController: {
      async inspect() {
        return { running: true, pid: 42, startedAt: '2026-11-04T00:00:00.000Z', executablePath: 'C:\\bin\\fake-tunnel.exe' };
      },
      async verify() { return { valid: true }; }
    },
    async prepare({ operationId, credential }) {
      tracker.push(`prepare:${service}:${operationId}`);
      return {
        service,
        credentialRef: credential ? 'present' : 'none',
        desiredFingerprint: 'a'.repeat(64),
        originalFingerprint: 'b'.repeat(64)
      };
    },
    async applyIfUnchanged({ operationId }) {
      tracker.push(`apply:${service}:${operationId}`);
    },
    async verifyDesired({ operationId, snapshot }) {
      tracker.push(`verify:${service}:${operationId}`);
      return {
        verified: true,
        operationId,
        service,
        configFingerprint: snapshot.desiredFingerprint,
        identity: {
          pid: 42,
          startedAt: '2026-11-04T00:00:00.000Z',
          executable: 'fake-tunnel.exe'
        },
        proof: { kind: 'authenticated-control-plane' }
      };
    },
    async restoreIfOwned({ operationId, snapshot }) {
      tracker.push(`restore:${service}:${operationId}`);
      return {
        restored: true,
        runtimeRestored: true,
        operationId,
        service,
        configFingerprint: snapshot.originalFingerprint
      };
    },
    async stopConnection({ operationId, serviceId = service, originalRuntime }) {
      tracker.push(`stop:${serviceId}:${operationId}`);
      if (options.failStop?.[serviceId]) {
        const err = new Error('Stop failed');
        err.code = 'PROCESS_CONTROL_FAILED';
        throw err;
      }
      if (options.invalidReceipt?.[serviceId]) {
        return {
          stopped: false,
          operationId,
          service: serviceId,
          proof: { kind: 'unverified' }
        };
      }
      return {
        stopped: true,
        operationId,
        service: serviceId,
        identity: {
          pid: 42,
          startedAt: '2026-11-04T00:00:00.000Z',
          executable: 'fake-tunnel.exe'
        },
        proof: { kind: 'verified-owned-process-exit' }
      };
    }
  });

  return {
    'overleaf-mcp': makeService('overleaf-mcp'),
    'antigravity-mcp': makeService('antigravity-mcp')
  };
}

async function createTempDir(prefix = 'runner-test-') {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('1. daemon lock exclusivity', async () => {
  const dataDir = await createTempDir('daemon-lock-');
  try {
    const repo = createFakeRepo();
    const adapters = createFakeAdapters();

    const runner1 = createRunner({ repo, adapters, dataDir });
    await runner1.start();

    const status1 = runner1.getStatus();
    assert.equal(status1.running, true);
    assert.equal(status1.locked, true);

    // Second runner attempting the same dataDir must be rejected
    const runner2 = createRunner({ repo, adapters, dataDir });
    await assert.rejects(
      async () => await runner2.start(),
      (err) => err instanceof DaemonLockError && err.code === 'LOCK_HELD'
    );

    // Stop runner1, releasing lock
    await runner1.stop();
    assert.equal(runner1.getStatus().running, false);
    assert.equal(runner1.getStatus().locked, false);

    // Runner 2 can now acquire lock and start
    await runner2.start();
    assert.equal(runner2.getStatus().running, true);
    assert.equal(runner2.getStatus().locked, true);

    // Concurrent runner while runner2 is active must be rejected
    const runnerConcurrent = createRunner({ repo, adapters, dataDir });
    await assert.rejects(
      async () => await runnerConcurrent.start(),
      (err) => err instanceof DaemonLockError && err.code === 'LOCK_HELD'
    );

    await runner2.stop();

    // Verify stale metadata lock file does not prevent acquiring a free TCP lease
    const lockFile = path.join(dataDir, 'daemon.lock');
    await fs.writeFile(lockFile, JSON.stringify({ pid: 99999999, nonce: 'stale-test', acquiredAt: '1970-01-01T00:00:00.000Z' }), 'utf8');

    const runner3 = createRunner({ repo, adapters, dataDir });
    await runner3.start();
    assert.equal(runner3.getStatus().running, true);
    assert.equal(runner3.getStatus().locked, true);
    await runner3.stop();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('2. crash recovery on runner start', async () => {
  const dataDir = await createTempDir('crash-recovery-');
  try {
    const tracker = [];
    const adapters = createFakeAdapters(tracker);

    // Operation was interrupted in APPLYING status with overleaf-mcp marked as mutated
    const crashedOp = {
      id: 'op-crash-101',
      status: 'APPLYING',
      targets: ['overleaf-mcp', 'antigravity-mcp'],
      steps: {
        'overleaf-mcp': {
          mayHaveMutated: true,
          snapshot: {
            desiredFingerprint: 'a'.repeat(64),
            originalFingerprint: 'b'.repeat(64)
          }
        }
      }
    };

    const repo = createFakeRepo([crashedOp]);
    const runner = createRunner({ repo, adapters, dataDir });

    // Runner start executes crash recovery before accepting new tasks
    await runner.start();

    const recoveredOp = await repo.load('op-crash-101');
    assert.equal(recoveredOp.status, 'ROLLED_BACK');
    assert.equal(recoveredOp.failureCode, 'INTERRUPTED');

    // overleaf-mcp was restored because it may have mutated
    assert.ok(tracker.includes('restore:overleaf-mcp:op-crash-101'));
    // antigravity-mcp had not mutated, so not restored
    assert.ok(!tracker.includes('restore:antigravity-mcp:op-crash-101'));

    const pending = await repo.pendingOperationIds();
    assert.equal(pending.length, 0);

    await runner.stop();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('3. notify executes queued operation', async () => {
  const dataDir = await createTempDir('notify-exec-');
  try {
    const tracker = [];
    const adapters = createFakeAdapters(tracker);
    const repo = createFakeRepo();

    const runner = createRunner({ repo, adapters, dataDir });
    await runner.start();

    // Enqueue an operation in QUEUED status
    repo.addOperation({
      id: 'op-queued-202',
      status: 'QUEUED',
      targets: ['antigravity-mcp', 'overleaf-mcp']
    });

    runner.notify();

    // Draining finishes when stop is called (or while waiting)
    await runner.stop();

    const op = await repo.load('op-queued-202');
    assert.equal(op.status, 'SUCCEEDED');

    // Targets must be applied in canonical order: overleaf-mcp first, connection-carrying antigravity-mcp last
    assert.deepEqual(tracker, [
      'prepare:overleaf-mcp:op-queued-202',
      'prepare:antigravity-mcp:op-queued-202',
      'apply:overleaf-mcp:op-queued-202',
      'apply:antigravity-mcp:op-queued-202',
      'verify:overleaf-mcp:op-queued-202',
      'verify:antigravity-mcp:op-queued-202'
    ]);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('4. stop drains cleanly', async () => {
  const dataDir = await createTempDir('stop-drain-');
  try {
    const tracker = [];
    const adapters = createFakeAdapters(tracker);
    const repo = createFakeRepo([
      {
        id: 'op-batch-1',
        status: 'QUEUED',
        targets: ['overleaf-mcp', 'antigravity-mcp']
      },
      {
        id: 'op-batch-2',
        status: 'QUEUED',
        targets: ['overleaf-mcp', 'antigravity-mcp']
      }
    ]);

    const runner = createRunner({ repo, adapters, dataDir });
    await runner.start();

    runner.notify();

    // Stop drains all in-flight and pending operations cleanly
    await runner.stop();

    assert.equal(runner.getStatus().running, false);
    assert.equal(runner.getStatus().status, 'STOPPED');
    assert.equal(runner.getStatus().locked, false);

    const op1 = await repo.load('op-batch-1');
    const op2 = await repo.load('op-batch-2');
    assert.equal(op1.status, 'SUCCEEDED');
    assert.equal(op2.status, 'SUCCEEDED');

    const pending = await repo.pendingOperationIds();
    assert.equal(pending.length, 0);

    // Verify lock was released and another runner can start cleanly
    const runnerNext = createRunner({ repo, adapters, dataDir });
    await runnerNext.start();
    assert.equal(runnerNext.getStatus().running, true);
    await runnerNext.stop();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('5. stop action draining (QUEUED -> APPLYING -> SUCCEEDED)', async () => {
  const dataDir = await createTempDir('stop-draining-');
  try {
    const tracker = [];
    const adapters = createFakeAdapters(tracker);
    const repo = createFakeRepo([], [
      {
        id: 'stop-action-1',
        operationId: 'stop-action-1',
        kind: 'stop',
        serviceId: 'overleaf-mcp',
        state: 'QUEUED',
        createdAt: 100
      }
    ]);

    const runner = createRunner({ repo, adapters, dataDir });
    await runner.start();

    // Verify initially QUEUED
    const initialAction = await repo.loadAction('stop-action-1');
    assert.equal(initialAction.state, 'QUEUED');

    runner.notify();
    await runner.stop();

    // Verify reached SUCCEEDED
    const finishedAction = await repo.loadAction('stop-action-1');
    assert.equal(finishedAction.state, 'SUCCEEDED');
    assert.ok(finishedAction.receipt);
    assert.equal(finishedAction.receipt.stopped, true);
    assert.equal(finishedAction.receipt.service, 'overleaf-mcp');

    // Verify stopConnection was called with the correct actionId
    assert.ok(tracker.includes('stop:overleaf-mcp:stop-action-1'));

    // Verify queue is now empty
    const queue = await repo.getWorkQueue();
    assert.equal(queue.length, 0);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('6. stop action failure recovery / NEEDS_ATTENTION gate', async () => {
  const dataDir = await createTempDir('stop-recovery-attention-');
  try {
    const tracker = [];
    // Adapter where antigravity-mcp returns an unconfirmed receipt
    const adapters = createFakeAdapters(tracker, {
      invalidReceipt: { 'antigravity-mcp': true }
    });

    // Case A: Action was interrupted in APPLYING before runner started
    const interruptedAction = {
      id: 'stop-interrupted-1',
      operationId: 'stop-interrupted-1',
      kind: 'stop',
      serviceId: 'overleaf-mcp',
      state: 'APPLYING',
      createdAt: 50
    };

    // Case B: Action in QUEUED that will fail receipt verification
    const failingAction = {
      id: 'stop-failing-2',
      operationId: 'stop-failing-2',
      kind: 'stop',
      serviceId: 'antigravity-mcp',
      state: 'QUEUED',
      createdAt: 100
    };

    const repo = createFakeRepo([], [interruptedAction, failingAction]);
    const runner = createRunner({ repo, adapters, dataDir });

    // 1. Startup recovery runs: recovers the interrupted action into NEEDS_ATTENTION gate
    await runner.start();

    const recoveredAction = await repo.loadAction('stop-interrupted-1');
    assert.equal(recoveredAction.state, 'NEEDS_ATTENTION');
    assert.equal(recoveredAction.errorCode, 'INTERRUPTED');

    // 2. Draining executes the failing action
    runner.notify();
    await runner.stop();

    const attentionAction = await repo.loadAction('stop-failing-2');
    assert.equal(attentionAction.state, 'NEEDS_ATTENTION');
    assert.equal(attentionAction.errorCode, 'STOP_UNCONFIRMED');

    // Both actions are now in terminal NEEDS_ATTENTION state
    const queue = await repo.getWorkQueue();
    assert.equal(queue.length, 0);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('7. unified work queue interleaving switch and stop operations', async () => {
  const dataDir = await createTempDir('interleaved-queue-');
  try {
    const tracker = [];
    const adapters = createFakeAdapters(tracker);

    const initialOps = [
      {
        id: 'op-switch-1',
        status: 'QUEUED',
        targets: ['overleaf-mcp'],
        createdAt: 100
      },
      {
        id: 'op-switch-2',
        status: 'QUEUED',
        targets: ['antigravity-mcp'],
        createdAt: 300
      }
    ];

    const initialActions = [
      {
        id: 'act-stop-1',
        operationId: 'act-stop-1',
        kind: 'stop',
        serviceId: 'overleaf-mcp',
        state: 'QUEUED',
        createdAt: 200
      },
      {
        id: 'act-stop-2',
        operationId: 'act-stop-2',
        kind: 'stop',
        serviceId: 'antigravity-mcp',
        state: 'QUEUED',
        createdAt: 400
      }
    ];

    const repo = createFakeRepo(initialOps, initialActions);
    const runner = createRunner({ repo, adapters, dataDir });

    await runner.start();
    runner.notify();
    await runner.stop();

    // Verify all 4 reached terminal SUCCEEDED
    assert.equal((await repo.load('op-switch-1')).status, 'SUCCEEDED');
    assert.equal((await repo.loadAction('act-stop-1')).state, 'SUCCEEDED');
    assert.equal((await repo.load('op-switch-2')).status, 'SUCCEEDED');
    assert.equal((await repo.loadAction('act-stop-2')).state, 'SUCCEEDED');

    // Verify executions happened strictly in interleaved chronological order:
    // 1. switch-1: prepare -> apply -> verify
    // 2. stop-1: stop
    // 3. switch-2: prepare -> apply -> verify
    // 4. stop-2: stop
    assert.deepEqual(tracker, [
      'prepare:overleaf-mcp:op-switch-1',
      'apply:overleaf-mcp:op-switch-1',
      'verify:overleaf-mcp:op-switch-1',
      'stop:overleaf-mcp:act-stop-1',
      'prepare:antigravity-mcp:op-switch-2',
      'apply:antigravity-mcp:op-switch-2',
      'verify:antigravity-mcp:op-switch-2',
      'stop:antigravity-mcp:act-stop-2'
    ]);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('8. provider release on operation completion', async () => {
  const dataDir = await createTempDir('provider-release-');
  try {
    const tracker = [];
    const released = [];
    const fakeAdapters = createFakeAdapters(tracker);

    // Custom adapterProvider tracking release calls
    const adapterProvider = Object.assign(
      async (op, serviceId) => fakeAdapters[serviceId],
      {
        release(id) {
          released.push(id);
        }
      }
    );

    const initialOps = [
      {
        id: 'op-release-switch',
        status: 'QUEUED',
        targets: ['overleaf-mcp'],
        createdAt: 100
      }
    ];
    const initialActions = [
      {
        id: 'act-release-stop',
        operationId: 'act-release-stop',
        kind: 'stop',
        serviceId: 'overleaf-mcp',
        state: 'QUEUED',
        createdAt: 200
      }
    ];

    const repo = createFakeRepo(initialOps, initialActions);
    const runner = createRunner({ repo, adapterProvider, dataDir });

    await runner.start();
    runner.notify();
    await runner.stop();

    // Verify both operations reached terminal state
    assert.equal((await repo.load('op-release-switch')).status, 'SUCCEEDED');
    assert.equal((await repo.loadAction('act-release-stop')).state, 'SUCCEEDED');

    // Verify adapterProvider.release was called for both operation IDs
    assert.deepEqual(released, ['op-release-switch', 'act-release-stop']);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('9. runMcpStopAction standalone lifecycle states', async () => {
  const tracker = [];
  const adapters = createFakeAdapters(tracker);
  const repo = createFakeRepo([], [
    {
      id: 'act-already-terminal',
      state: 'SUCCEEDED',
      serviceId: 'overleaf-mcp',
      createdAt: 10
    },
    {
      id: 'act-no-adapter',
      state: 'QUEUED',
      serviceId: 'unknown-service-mcp',
      createdAt: 20
    }
  ]);

  // Case 1: Already terminal returns immediately without effects
  const terminalRes = await runMcpStopAction({ repo, adapterProvider: adapters, actionId: 'act-already-terminal' });
  assert.equal(terminalRes.state, 'SUCCEEDED');
  assert.equal(tracker.length, 0);

  // Case 2: Adapter unavailable fails cleanly before side-effects -> REJECTED
  const rejectedRes = await runMcpStopAction({ repo, adapterProvider: adapters, actionId: 'act-no-adapter' });
  assert.equal(rejectedRes.state, 'REJECTED');
  assert.equal(rejectedRes.errorCode, 'SERVICE_NOT_MANAGED');
  assert.equal(tracker.length, 0);
});


test('10. runner startup handles synchronous SQLite repo load without Promise .catch fault', async () => {
  const dataDir = await createTempDir('runner-sync-load-');
  try {
    const tracker = [];
    const adapters = createFakeAdapters(tracker);
    const initialOps = [
      {
        id: 'op-sync-1',
        status: 'APPLYING',
        targets: ['overleaf-mcp'],
        createdAt: 100,
        steps: {
          'overleaf-mcp': {
            mayHaveMutated: true,
            snapshot: {
              desiredFingerprint: 'a'.repeat(64),
              originalFingerprint: 'b'.repeat(64)
            }
          }
        }
      }
    ];
    const repo = createFakeRepo(initialOps);
    // Make load synchronous returning record immediately (like DatabaseSync)
    repo.load = function(id) {
      const op = repo.operations.get(id);
      if (!op) throw new Error(`Operation ${id} not found`);
      return { ...op };
    };

    const runner = createRunner({ repo, adapters, dataDir });
    await runner.start();
    const op = repo.operations.get('op-sync-1');
    assert.equal(op.status, 'ROLLED_BACK');
    assert.deepEqual(tracker, ['restore:overleaf-mcp:op-sync-1']);
    await runner.stop();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('11. runner startup handles asynchronous injected repo load', async () => {
  const dataDir = await createTempDir('runner-async-load-');
  try {
    const tracker = [];
    const adapters = createFakeAdapters(tracker);
    const initialOps = [
      {
        id: 'op-async-1',
        status: 'APPLYING',
        targets: ['overleaf-mcp'],
        createdAt: 100,
        steps: {
          'overleaf-mcp': {
            mayHaveMutated: true,
            snapshot: {
              desiredFingerprint: 'a'.repeat(64),
              originalFingerprint: 'b'.repeat(64)
            }
          }
        }
      }
    ];
    const repo = createFakeRepo(initialOps);
    const runner = createRunner({ repo, adapters, dataDir });
    await runner.start();
    const op = repo.operations.get('op-async-1');
    assert.equal(op.status, 'ROLLED_BACK');
    assert.deepEqual(tracker, ['restore:overleaf-mcp:op-async-1']);
    await runner.stop();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('12. stop-loader this binding preserved during runner startup recovery', async () => {
  const dataDir = await createTempDir('runner-stop-this-');
  try {
    const tracker = [];
    const adapters = createFakeAdapters(tracker);
    const initialActions = [
      {
        id: 'act-stop-sync-1',
        operationId: 'act-stop-sync-1',
        kind: 'stop',
        serviceId: 'overleaf-mcp',
        state: 'APPLYING',
        createdAt: 100
      }
    ];
    const repo = createFakeRepo([], initialActions);
    const registry = {
      marker: 'REGISTRY_RECEIVER',
      loadAction(id) {
        assert.equal(this.marker, 'REGISTRY_RECEIVER');
        const act = repo.actions.get(id);
        if (!act) throw new Error(`Action ${id} not found`);
        return { ...act };
      }
    };
    repo.registry = registry;

    const runner = createRunner({ repo, adapters, dataDir });
    await runner.start();
    const act = repo.actions.get('act-stop-sync-1');
    assert.equal(act.state, 'NEEDS_ATTENTION');
    assert.equal(act.errorCode, 'INTERRUPTED');
    await runner.stop();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('13. failed startup rolls back and releases kernel daemon lock', async () => {
  const dataDir = await createTempDir('runner-fail-rollback-');
  try {
    const failure = new Error('simulated-storage-fault');
    const repo = {
      getWorkQueue() {
        throw failure;
      }
    };
    const runner = createRunner({ repo, adapters: {}, dataDir });
    await assert.rejects(runner.start(), (err) => err === failure);
    assert.equal(runner.getStatus().started, false);
    assert.equal(runner.getStatus().locked, false);

    // Another runner on same dataDir should now be able to acquire lock immediately
    const goodRepo = { getWorkQueue: () => [] };
    const runner2 = createRunner({ repo: goodRepo, adapters: {}, dataDir });
    await runner2.start();
    assert.equal(runner2.getStatus().locked, true);
    await runner2.stop();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('14. successful startup retains daemon lease until stop', async () => {
  const dataDir = await createTempDir('runner-retain-lease-');
  try {
    const repo = { getWorkQueue: () => [] };
    const runner = createRunner({ repo, adapters: {}, dataDir });
    await runner.start();
    assert.equal(runner.getStatus().locked, true);

    // Second runner must fail with DaemonLockError while first is active
    const runner2 = createRunner({ repo, adapters: {}, dataDir });
    await assert.rejects(runner2.start(), (err) => err instanceof DaemonLockError || err.name === 'DaemonLockError');

    await runner.stop();
    assert.equal(runner.getStatus().locked, false);

    // Now runner2 can acquire
    await runner2.start();
    assert.equal(runner2.getStatus().locked, true);
    await runner2.stop();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('15. terminal and attention records produce no dispatch and no spin', async () => {
  const dataDir = await createTempDir('runner-terminal-nospin-');
  try {
    const dispatches = [];
    const repo = {
      getWorkQueue() {
        return ['op-attention', 'op-succeeded'];
      },
      isActionId() {
        return false;
      },
      load(id) {
        if (id === 'op-attention') return { id, status: 'NEEDS_ATTENTION' };
        if (id === 'op-succeeded') return { id, status: 'SUCCEEDED' };
        throw new Error('not found');
      }
    };
    const runner = createRunner({ repo, adapters: {}, dataDir });
    await runner.start();
    runner.notify();
    await runner.stop();
    assert.equal(dispatches.length, 0);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('16. corrupt/missing load fails closed during startup', async () => {
  const dataDir = await createTempDir('runner-corrupt-failclose-');
  try {
    const repo = {
      getWorkQueue() {
        return ['op-corrupt'];
      },
      isActionId() {
        return false;
      },
      load() {
        return null; // missing record
      }
    };
    const runner = createRunner({ repo, adapters: {}, dataDir });
    await assert.rejects(runner.start(), (err) => err.code === 'WORK_ITEM_NOT_FOUND' && err.mayMutate === false);
    assert.equal(runner.getStatus().locked, false);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('17. lease reacquisition works after failed start', async () => {
  const dataDir = await createTempDir('runner-reacquire-');
  try {
    let failFirst = true;
    const repo = {
      getWorkQueue() {
        if (failFirst) {
          failFirst = false;
          throw new Error('transient-failure');
        }
        return [];
      }
    };
    const runner = createRunner({ repo, adapters: {}, dataDir });
    await assert.rejects(runner.start());
    assert.equal(runner.getStatus().locked, false);

    // Reacquire on same runner instance
    await runner.start();
    assert.equal(runner.getStatus().locked, true);
    await runner.stop();
    assert.equal(runner.getStatus().locked, false);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('18. runner accepts vault and passes it to createRegisteredAdapterProvider', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-vault-test-'));
  try {
    const fakeVault = { seal: () => {}, unseal: () => {}, close: () => {} };
    const repo = {
      getWorkQueue: async () => [],
      loadAction: async (id) => ({ id, kind: 'stop', serviceId: 'overleaf-mcp' }),
      isActionId: async (id) => id === 'act_test_1'
    };

    let providerOpts = null;
    const customProvider = (opts) => {
      providerOpts = opts;
      return async () => ({});
    };

    const runner = createRunner({
      repo,
      adapterProvider: customProvider({ dataDir, vault: fakeVault }),
      vault: fakeVault,
      dataDir
    });

    assert.ok(runner);
    assert.equal(runner.deps.vault, fakeVault);
    assert.equal(providerOpts.vault, fakeVault);

    await runner.start();
    assert.equal(runner.getStatus().running, true);
    await runner.stop();
    assert.equal(runner.getStatus().running, false);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

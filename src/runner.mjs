import path from 'node:path';
import { executeOperation } from './core/switch-core.mjs';
import { acquireDaemonLock } from './core/daemon-lock.mjs';
import { runMcpLifecycleAction, runMcpStopAction } from './core/mcp-lifecycle.mjs';
import {
  loadWorkRecord,
  withStartupRollback,
  rollbackOwnedResources
} from './core/runner-startup.mjs';
import { classifyQueuedWork, missingReferenceDisposition } from './core/work-item-routing.mjs';
import * as adaptersModule from './adapters/index.mjs';

export function createRunner({ repo, adapters, adapterProvider, dataDir, vault }) {
  if (!repo || typeof repo !== 'object') {
    throw new TypeError('A valid repo object is required to create a runner');
  }

  const resolvedDataDir = dataDir
    ?? (process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'McpTunnelAccountManager')
      : path.resolve('.data'));

  let resolvedAdapterProvider = adapterProvider;
  if (!resolvedAdapterProvider && adapters) {
    resolvedAdapterProvider = typeof adapters === 'function'
      ? adapters
      : Object.assign(
          async (_op, serviceId) => adapters[serviceId],
          { release: () => {} }
        );
  }

  if (!resolvedAdapterProvider) {
    if (typeof adaptersModule.createRegisteredAdapterProvider === 'function') {
      try {
        resolvedAdapterProvider = adaptersModule.createRegisteredAdapterProvider({
          dataDir: resolvedDataDir,
          vault
        });
      } catch (_) {}
    }
  }

  if (!resolvedAdapterProvider) {
    throw new TypeError('A valid adapters map or adapterProvider is required to create a runner');
  }

  if (typeof resolvedAdapterProvider !== 'function') {
    if (typeof resolvedAdapterProvider.getAdapter === 'function') {
      const orig = resolvedAdapterProvider;
      resolvedAdapterProvider = Object.assign(
        (op, serviceId) => orig.getAdapter(op, serviceId),
        { release: (id) => orig.release?.(id) }
      );
    } else {
      const map = resolvedAdapterProvider;
      resolvedAdapterProvider = Object.assign(
        async (_op, serviceId) => map[serviceId],
        { release: (id) => map.release?.(id) }
      );
    }
  }

  let started = false;
  let stopping = false;
  let startPromise = null;
  let daemonLock = null;
  let currentOperationId = null;
  let drainPromise = null;
  let pendingNotify = false;
  let lastError = null;

  // Mutual exclusion chain for switch-core executeOperation and stop actions
  let exclusiveLockChain = Promise.resolve();
  function withExclusiveLock(fn) {
    const next = exclusiveLockChain.then(async () => {
      return await fn();
    });
    exclusiveLockChain = next.catch(() => {});
    return next;
  }

  const deps = {
    repo,
    adapters: adapters || {},
    adapterProvider: resolvedAdapterProvider,
    withExclusiveLock,
    vault
  };

  async function fetchWorkQueue() {
    if (typeof repo.getWorkQueue === 'function') {
      return await repo.getWorkQueue();
    }
    if (typeof repo.pendingOperationIds === 'function') {
      return await repo.pendingOperationIds();
    }
    return [];
  }

  async function checkLifecycleExists(id) {
    if (typeof repo.registry?.isActionId === 'function') {
      try {
        const res = await repo.registry.isActionId.call(repo.registry, id);
        if (typeof res === 'boolean') return res;
      } catch (err) {
        if (err && err.code !== 'NOT_FOUND' && err.code !== 'ACTION_NOT_FOUND') throw err;
      }
    }
    if (typeof repo.isActionId === 'function') {
      try {
        const res = await repo.isActionId.call(repo, id);
        if (typeof res === 'boolean') return res;
      } catch (err) {
        if (err && err.code !== 'NOT_FOUND' && err.code !== 'ACTION_NOT_FOUND') throw err;
      }
    }
    return false;
  }

  async function checkSwitchExists(id) {
    if (typeof repo.isOperationId === 'function') {
      try {
        const res = await repo.isOperationId.call(repo, id);
        if (typeof res === 'boolean') return res;
      } catch (err) {
        if (err && err.code !== 'NOT_FOUND') throw err;
      }
    }
    if (typeof repo.load === 'function') {
      try {
        const item = await repo.load.call(repo, id);
        return Boolean(item);
      } catch (err) {
        if (err && err.code !== 'NOT_FOUND') throw err;
        return false;
      }
    }
    return false;
  }

  async function classifyWork(id, rawItem = null) {
    let queueKind = null;
    if (rawItem && typeof rawItem === 'object') {
      if (rawItem.queueKind === 'lifecycle' || rawItem.queueKind === 'switch') {
        queueKind = rawItem.queueKind;
      } else if (rawItem.kind === 'lifecycle' || rawItem.kind === 'switch') {
        queueKind = rawItem.kind;
      } else if (rawItem.kind === 'stop' || rawItem.kind === 'start' || rawItem.kind === 'restart' || rawItem.action) {
        queueKind = 'lifecycle';
      } else if (rawItem.targets) {
        queueKind = 'switch';
      }
    }

    const [lifecycleExists, switchExists] = await Promise.all([
      checkLifecycleExists(id),
      checkSwitchExists(id)
    ]);

    return classifyQueuedWork({ queueKind, lifecycleExists, switchExists });
  }

  async function dispatchTask(id, rawItem = null) {
    const workKind = await classifyWork(id, rawItem);
    currentOperationId = id;
    try {
      if (workKind === 'lifecycle') {
        await withExclusiveLock(async () => {
          await runMcpLifecycleAction({
            repo,
            adapterProvider: resolvedAdapterProvider,
            actionId: id,
            vault
          });
        });
      } else if (workKind === 'switch') {
        await executeOperation(id, deps);
      }
    } finally {
      currentOperationId = null;
      if (typeof resolvedAdapterProvider?.release === 'function') {
        try {
          resolvedAdapterProvider.release(id);
        } catch (_) {}
      }
    }
  }

  async function drainQueue() {
    if (drainPromise) return drainPromise;

    drainPromise = (async () => {
      try {
        while (started) {
          pendingNotify = false;
          let items;
          try {
            items = await fetchWorkQueue();
          } catch (err) {
            lastError = err;
            break;
          }

          if (!Array.isArray(items) || items.length === 0) {
            if (pendingNotify) continue;
            break;
          }

          let progressMade = false;

          for (const rawItem of items) {
            if (!started) break;
            const id = typeof rawItem === 'string' ? rawItem : (rawItem?.id || rawItem?.operationId);
            if (!id) continue;

            let workKind;
            try {
              workKind = await classifyWork(id, rawItem);
            } catch (err) {
              lastError = err;
              progressMade = false;
              return;
            }

            let work;
            try {
              work = await loadWorkRecord({ repo, id, kind: workKind });
            } catch (err) {
              // Storage or unknown-state failure stops draining / gates; no spin
              lastError = err;
              progressMade = false;
              return;
            }

            if (work.terminal) {
              // Terminal items (including NEEDS_ATTENTION) never execute again; ignore
              continue;
            }

            try {
              await dispatchTask(id, rawItem);
              progressMade = true;
            } catch (err) {
              // Contain execution error without writing or logging sensitive data
              lastError = err;
              progressMade = false;
              break;
            }
          }

          // Break when none runnable or no progress made, even with stale injected queue
          if (!progressMade) {
            break;
          }

          if (!pendingNotify) {
            let checkAgain;
            try {
              checkAgain = await fetchWorkQueue();
            } catch (err) {
              lastError = err;
              break;
            }
            if (!Array.isArray(checkAgain) || checkAgain.length === 0) {
              break;
            }
          }
        }
      } finally {
        drainPromise = null;
      }
    })();

    return drainPromise;
  }

  async function start() {
    if (started) return;
    if (startPromise) return await startPromise;

    const runStartup = async () => {
      const releases = [];
      await withStartupRollback(async () => {
        // 1. Obtain cross-process daemon lock tied to dataDir
        daemonLock = await acquireDaemonLock(resolvedDataDir);
        releases.push(async () => {
          if (daemonLock) {
            try {
              await daemonLock.release();
            } finally {
              daemonLock = null;
            }
          }
        });

        started = true;
        stopping = false;
        lastError = null;

        // 2. Startup recovery: recover non-terminal switch ops and non-terminal stop actions before draining new queue
        const pendingItems = await fetchWorkQueue();
        if (Array.isArray(pendingItems)) {
          for (const rawItem of pendingItems) {
            const id = typeof rawItem === 'string' ? rawItem : (rawItem?.id || rawItem?.operationId);
            if (!id) continue;

            const workKind = await classifyWork(id, rawItem);

            // loadWorkRecord validates state, awaits sync/async loader, and propagates storage errors
            const work = await loadWorkRecord({ repo, id, kind: workKind });

            // Recover nonQUEUED nonterminal before queued new work
            if (work.needsRecovery) {
              await dispatchTask(id, rawItem);
            }
          }
        }
      }, async () => {
        // Direct, idempotent rollback: reset started/drain flags and release acquired kernel lease
        started = false;
        drainPromise = null;
        pendingNotify = false;
        currentOperationId = null;
        await rollbackOwnedResources(releases);
      });
    };

    startPromise = runStartup();
    try {
      await startPromise;
    } finally {
      startPromise = null;
    }
  }

  function notify() {
    if (!started || stopping) return;
    if (drainPromise) {
      pendingNotify = true;
      return;
    }
    // Launch tracked drain queue
    drainQueue().catch(() => {});
  }

  async function stop() {
    if (!started) {
      if (daemonLock) {
        try {
          await daemonLock.release();
        } finally {
          daemonLock = null;
        }
      }
      return;
    }
    stopping = true;

    // Drain existing queued operations cleanly (do not await startPromise)
    if (drainPromise) {
      try {
        await drainPromise;
      } catch (_) {}
    } else {
      try {
        await drainQueue();
      } catch (_) {}
    }

    started = false;
    stopping = false;

    // Release daemon lock
    if (daemonLock) {
      try {
        await daemonLock.release();
      } finally {
        daemonLock = null;
      }
    }
  }

  function getStatus() {
    return {
      status: started ? (stopping ? 'STOPPING' : 'RUNNING') : 'STOPPED',
      running: started && !stopping,
      started,
      stopping,
      locked: Boolean(daemonLock),
      currentOperationId,
      dataDir: resolvedDataDir,
      lastError: lastError ? lastError.message : null
    };
  }

  return {
    start,
    notify,
    stop,
    getStatus,
    deps
  };
}

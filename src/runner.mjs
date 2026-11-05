import path from 'node:path';
import { executeOperation } from './core/switch-core.mjs';
import { acquireDaemonLock } from './core/daemon-lock.mjs';
import { runMcpStopAction } from './core/mcp-lifecycle.mjs';
import {
  loadWorkRecord,
  withStartupRollback,
  rollbackOwnedResources
} from './core/runner-startup.mjs';
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

  async function isStopAction(id, rawItem = null) {
    if (rawItem && typeof rawItem === 'object') {
      if (rawItem.kind === 'stop' || rawItem.type === 'stop') return true;
      if (rawItem.serviceId !== undefined && rawItem.targets === undefined) return true;
    }
    if (typeof repo.isActionId === 'function') {
      try {
        const res = await repo.isActionId.call(repo, id);
        if (typeof res === 'boolean') return res;
      } catch (_) {}
    }
    if (typeof repo.registry?.isActionId === 'function') {
      try {
        const res = await repo.registry.isActionId.call(repo.registry, id);
        if (typeof res === 'boolean') return res;
      } catch (_) {}
    }
    if (typeof id === 'string' && /^act_[a-z0-9_-]{1,64}$/i.test(id)) {
      return true;
    }
    if (typeof repo.registry?.loadAction === 'function') {
      try {
        const action = await repo.registry.loadAction.call(repo.registry, id);
        if (action && typeof action === 'object') {
          return true;
        }
      } catch (_) {}
    }
    if (typeof repo.loadAction === 'function') {
      try {
        const action = await repo.loadAction.call(repo, id);
        if (action && typeof action === 'object') {
          return true;
        }
      } catch (_) {}
    }
    if (typeof repo.load === 'function') {
      try {
        const item = await repo.load.call(repo, id);
        if (item && (item.kind === 'stop' || (item.serviceId !== undefined && item.targets === undefined))) {
          return true;
        }
      } catch (_) {}
    }
    return false;
  }

  async function dispatchTask(id) {
    const isStop = await isStopAction(id);
    currentOperationId = id;
    try {
      if (isStop) {
        await withExclusiveLock(async () => {
          await runMcpStopAction({
            repo,
            adapterProvider: resolvedAdapterProvider,
            actionId: id
          });
        });
      } else {
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

            const isStop = await isStopAction(id, rawItem);
            const kind = isStop ? 'stop' : 'switch';

            let work;
            try {
              work = await loadWorkRecord({ repo, id, kind });
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
              await dispatchTask(id);
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

            const isStop = await isStopAction(id, rawItem);
            const kind = isStop ? 'stop' : 'switch';

            // loadWorkRecord validates state, awaits sync/async loader, and propagates storage errors
            const work = await loadWorkRecord({ repo, id, kind });

            // Recover nonQUEUED nonterminal before queued new work
            if (work.needsRecovery) {
              await dispatchTask(id);
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

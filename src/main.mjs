import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createVault } from './vault.mjs';
import { openStore } from './store.mjs';
import { createAdapters, createRegisteredAdapterProvider } from './adapters/index.mjs';
import { createRunner } from './runner.mjs';
import { createSecurity } from './security.mjs';
import { createHttpServer } from './server.mjs';
import { createConfigImporter } from './services/config-import.mjs';
import { withStartupRollback, rollbackOwnedResources } from './core/runner-startup.mjs';
import { createRuntimeObserver } from './adapters/runtime-observer.mjs';
import { createHttpMcpProbe } from './adapters/http-mcp-observation.mjs';

/**
 * Safely closes an HTTP server instance without throwing ERR_SERVER_NOT_RUNNING
 * and without hanging if the server never listened or if close() does not invoke callbacks.
 *
 * @param {object} server
 * @returns {Promise<void>}
 */
async function closeServerSafely(server) {
  if (!server) return;
  if (typeof server.closeAllConnections === 'function') {
    try { server.closeAllConnections(); } catch (_) {}
  }
  if (typeof server.close !== 'function') return;

  await new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    try {
      const ret = server.close((err) => {
        // Node.js net/http server passes ERR_SERVER_NOT_RUNNING if not listening; ignore and settle
        done();
      });
      if (ret && typeof ret.then === 'function') {
        ret.then(done, done);
      } else if (
        server.close.length === 0 &&
        (!server.listening && typeof server.address !== 'function')
      ) {
        // Plain synchronous mock object with close() taking no callback
        done();
      }
    } catch (_) {
      // Synchronous ERR_SERVER_NOT_RUNNING or other throw
      done();
    }

    // Safety fallback ensures rollback never hangs even on broken mocks
    const timer = setTimeout(done, 500);
    if (typeof timer?.unref === 'function') timer.unref();
  });
}

/**
 * Initializes and starts the MCP Tunnel Account Manager.
 * Exported exact named startManager.
 *
 * @param {object} [options={}] Configuration options
 * @param {string} [options.dataDir] Directory for storing keys, databases, and logs
 * @param {string} [options.host='127.0.0.1'] Bind host (enforced 127.0.0.1)
 * @param {number} [options.port=17642] Bind port
 * @param {Function} [options.adapterFactory] Custom adapter factory for in-process test injection
 * @param {object} [options.adapterOptions] Custom options forwarded to adapter factory
 * @param {object} [options.discoveryOptions] Custom options for discovery service
 * @param {object} [options.locationsOptions] Custom options for location resolver service
 * @param {object} [options.importerOptions] Custom options for config importer service
 * @param {Function} [options.discoveryFactory] Custom discovery factory
 * @param {Function} [options.locationsFactory] Custom locations factory
 * @param {Function} [options.importerFactory] Custom importer factory
 * @returns {Promise<{ url: string, close: () => Promise<void>, host: string, port: number, dataDir: string, security: any, vault: any, store: any, repo: any, adapters: any, runner: any, server: any, discovery: any, locations: any, importer: any }>}
 */
export async function startManager({
  dataDir: customDataDir,
  host: customHost = '127.0.0.1',
  port: customPort = 17642,
  adapterFactory,
  adapterOptions = {},
  discoveryOptions = {},
  locationsOptions = {},
  importerOptions = {},
  discoveryFactory,
  locationsFactory,
  importerFactory,
  discovery: directDiscovery,
  locations: directLocations,
  importer: directImporter,
  ...restOptions
} = {}) {
  // Loopback host must be exactly 127.0.0.1
  const host = '127.0.0.1';
  const port = customPort !== undefined ? Number(customPort) : 17642;

  const dataDir = customDataDir ||
    process.env.DATA_DIR ||
    path.join(process.env.LOCALAPPDATA || os.homedir(), 'McpTunnelAccountManager');

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const releases = [];
  let isClosed = false;
  let closePromise = null;

  // Define close / rollback before runner.start (no TDZ, no self-await)
  const close = async () => {
    if (isClosed) return;
    if (closePromise) return closePromise;
    closePromise = (async () => {
      isClosed = true;
      await rollbackOwnedResources(releases);
    })();
    return closePromise;
  };

  const rollback = async () => {
    if (isClosed) return;
    if (closePromise) return closePromise;
    closePromise = (async () => {
      isClosed = true;
      await rollbackOwnedResources(releases);
    })();
    return closePromise;
  };

  return await withStartupRollback(async () => {
    // 1. Security layer
    const security = (restOptions.security && (typeof restOptions.security.guard === 'function' || typeof restOptions.security.close === 'function'))
      ? restOptions.security
      : (typeof restOptions.securityFactory === 'function'
          ? await restOptions.securityFactory({ dataDir, ...restOptions.security })
          : await createSecurity({
              dataDir,
              ...restOptions.security
            }));

    let securityClosed = false;
    if (security && typeof security.close === 'function') {
      const origSecurityClose = security.close.bind(security);
      security.close = async () => {
        if (securityClosed) return;
        securityClosed = true;
        return await origSecurityClose();
      };
      releases.push(async () => {
        if (securityClosed) return;
        securityClosed = true;
        await origSecurityClose();
      });
    }

    // 2. Vault layer
    const vault = (restOptions.vault && (typeof restOptions.vault.seal === 'function' || typeof restOptions.vault.close === 'function'))
      ? restOptions.vault
      : (typeof restOptions.vaultFactory === 'function'
          ? await restOptions.vaultFactory({ dataDir, security, ...restOptions.vault })
          : await createVault({
              dataDir,
              security,
              ...restOptions.vault
            }));

    let vaultClosed = false;
    if (vault && typeof vault.close === 'function') {
      const origVaultClose = vault.close.bind(vault);
      vault.close = async () => {
        if (vaultClosed) return;
        vaultClosed = true;
        return await origVaultClose();
      };
      releases.push(async () => {
        if (vaultClosed) return;
        vaultClosed = true;
        await origVaultClose();
      });
    }

    // 3. Store layer
    const store = (restOptions.store && (typeof restOptions.store.getProfile === 'function' || typeof restOptions.store.close === 'function'))
      ? restOptions.store
      : (restOptions.repo && (typeof restOptions.repo.getProfile === 'function' || typeof restOptions.repo.close === 'function')
          ? restOptions.repo
          : (typeof restOptions.storeFactory === 'function'
              ? await restOptions.storeFactory({ dataDir, vault, security, ...restOptions.store })
              : await openStore({
                  dataDir,
                  vault,
                  security,
                  ...restOptions.store
                })));

    let storeClosed = false;
    if (store && typeof store.close === 'function') {
      const origStoreClose = store.close.bind(store);
      store.close = async () => {
        if (storeClosed) return;
        storeClosed = true;
        return await origStoreClose();
      };
      releases.push(async () => {
        if (storeClosed) return;
        storeClosed = true;
        await origStoreClose();
      });
    }

    // 4. Adapters layer (uses adapterFactory if provided for in-process test injection, otherwise createAdapters)
    // Note: Adapters are NOT registered in releases so failure cannot kill tunnel clients.
    const resolvedAdapterVault = adapterOptions?.vault || vault;
    const adapters = typeof adapterFactory === 'function'
      ? await adapterFactory({
          dataDir,
          vault: resolvedAdapterVault,
          store,
          security,
          ...adapterOptions
        })
      : await createAdapters({
          dataDir,
          vault: resolvedAdapterVault,
          store,
          security,
          ...adapterOptions
        });

    let adapterProvider = restOptions.adapterProvider;
    if (!adapterProvider && typeof restOptions.adapterProviderFactory === 'function') {
      adapterProvider = await restOptions.adapterProviderFactory({
        dataDir,
        vault: resolvedAdapterVault,
        store,
        security,
        ...adapterOptions
      });
    } else if (!adapterProvider && (!adapterFactory || !adapters)) {
      adapterProvider = createRegisteredAdapterProvider({
        dataDir,
        vault: resolvedAdapterVault,
        store,
        security,
        ...adapterOptions
      });
    }

    // 5. Runner layer: pass repo: store to createRunner
    const runner = (restOptions.runner && (typeof restOptions.runner.start === 'function' || typeof restOptions.runner.stop === 'function'))
      ? restOptions.runner
      : (typeof restOptions.runnerFactory === 'function'
          ? await restOptions.runnerFactory({
              repo: store,
              adapters,
              adapterProvider,
              dataDir,
              vault: resolvedAdapterVault,
              ...restOptions.runner
            })
          : await createRunner({
              repo: store,
              adapters,
              adapterProvider,
              dataDir,
              vault: resolvedAdapterVault,
              ...restOptions.runner
            }));

    let runnerStopped = false;
    if (runner && typeof runner.stop === 'function') {
      const origRunnerStop = runner.stop.bind(runner);
      runner.stop = async () => {
        if (runnerStopped) return;
        runnerStopped = true;
        return await origRunnerStop();
      };
      releases.push(async () => {
        if (runnerStopped) return;
        runnerStopped = true;
        await origRunnerStop();
      });
    }

    if (runner && typeof runner.start === 'function') {
      await runner.start();
    }

    // 5b. Observer layer
    const probeHttpMcp = (typeof restOptions.probeHttpMcp === 'function')
      ? restOptions.probeHttpMcp
      : createHttpMcpProbe({
          resolveHeaders: async (serviceId) => {
            const def = store?.registry?.getDefinition ? store.registry.getDefinition(serviceId) : null;
            return def?.binding?.headers;
          }
        });

    async function resolveServiceAdapter(serviceId) {
      if (adapters?.[serviceId]) return adapters[serviceId];
      if (typeof adapterProvider === 'function' && store?.registry?.listDefinitions) {
        try {
          const defs = store.registry.listDefinitions({ includeDeleted: false });
          return await adapterProvider({ registrySnapshot: { services: defs } }, serviceId);
        } catch {}
      }
      return null;
    }

    const observer = (restOptions.observer && typeof restOptions.observer.observe === 'function')
      ? restOptions.observer
      : createRuntimeObserver({
          probeHttpMcp,
          inspectProcess: async ({ serviceId }) => {
            try {
              const adapter = await resolveServiceAdapter(serviceId);
              if (adapter?.processController && typeof adapter.processController.inspect === 'function') {
                const inspected = await adapter.processController.inspect(serviceId);
                if (inspected && typeof inspected.running === 'boolean') {
                  if (inspected.running && inspected.healthURL && adapter?.probe && typeof adapter.probe.probe === 'function') {
                    try {
                      const health = await adapter.probe.probe(inspected.healthURL);
                      const channels = health?.adminStatus?.channels;
                      const enabledChannels = Array.isArray(channels) ? channels.filter(c => c && c.enabled !== false && c.server_kind !== 'builtin') : [];
                      const mcpProbeOk = enabledChannels.length > 0 && enabledChannels.every(c => c.probe_status === 'ok');
                      if ((health?.live === true || health?.status === 'ok') && health?.ready === true && mcpProbeOk) {
                        return {
                          state: 'available',
                          reasonCode: 'mcp_initialize_verified',
                          source: 'tunnel_health',
                          observedAt: Date.now(),
                          evidence: { processAlive: true, tunnelConnected: true, mcpVerified: true }
                        };
                      }
                    } catch (_) {}
                  }
                  return {
                    state: 'unobserved',
                    reasonCode: inspected.running ? 'process_alive_mcp_unverified' : 'external_process_unobserved',
                    source: 'process_controller',
                    observedAt: Date.now(),
                    evidence: { processAlive: inspected.running, mcpVerified: false }
                  };
                }
              }
            } catch {}
            return {
              state: 'unobserved',
              reasonCode: 'external_process_unobserved',
              source: 'process_controller',
              observedAt: Date.now(),
              evidence: { mcpVerified: false }
            };
          },
          readTunnelHealth: async ({ serviceId }) => {
            try {
              const adapter = await resolveServiceAdapter(serviceId);
              let healthUrl = adapter?.healthURL || null;
              if (!healthUrl && adapter?.processController && typeof adapter.processController.inspect === 'function') {
                try {
                  const inspected = await adapter.processController.inspect(serviceId);
                  if (inspected?.running && inspected?.healthURL) {
                    healthUrl = inspected.healthURL;
                  }
                } catch {}
              }
              if (adapter?.probe && typeof adapter.probe.probe === 'function') {
                const health = await adapter.probe.probe(healthUrl);
                if (health?.live === true || health?.status === 'ok') {
                  const channels = health?.adminStatus?.channels;
                  const enabledChannels = Array.isArray(channels) ? channels.filter(c => c && c.enabled !== false && c.server_kind !== 'builtin') : [];
                  const mcpProbeOk = enabledChannels.length > 0 && enabledChannels.every(c => c.probe_status === 'ok');
                  if (health?.ready === true && mcpProbeOk) {
                    return {
                      state: 'available',
                      reasonCode: 'mcp_initialize_verified',
                      source: 'tunnel_health',
                      observedAt: Date.now(),
                      evidence: { processAlive: true, tunnelConnected: true, mcpVerified: true }
                    };
                  }
                  return {
                    state: 'unobserved',
                    reasonCode: 'tunnel_online_backend_unverified',
                    source: 'tunnel_health',
                    observedAt: Date.now(),
                    evidence: { tunnelConnected: true, mcpVerified: false }
                  };
                } else if (health && (health.live === false || health.status === 'down')) {
                  return {
                    state: 'unobserved',
                    reasonCode: 'not_observed',
                    source: 'tunnel_health',
                    observedAt: Date.now(),
                    evidence: { tunnelConnected: false, mcpVerified: false }
                  };
                }
              }
            } catch {}
            return {
              state: 'unobserved',
              reasonCode: 'not_observed',
              source: 'tunnel_health',
              observedAt: Date.now(),
              evidence: { mcpVerified: false }
            };
          }
        });

    if (store?.registry && typeof store.registry.setObserver === 'function') {
      store.registry.setObserver(observer);
    }

    let schedulerActive = true;
    let collectionPromise = null;

    async function collectRegisteredServices() {
      if (!store?.registry?.listServices) return;
      try {
        const services = store.registry.listServices({ includeDeleted: false });
        const enabled = Array.isArray(services) ? services.filter(s => s.enabled) : [];
        const queue = [...enabled];
        const workers = [];
        const concurrency = Math.min(2, queue.length);
        for (let i = 0; i < concurrency; i++) {
          workers.push((async () => {
            while (queue.length > 0 && schedulerActive) {
              const srv = queue.shift();
              if (!srv) break;
              try {
                await observer.observe({
                  id: srv.id,
                  revision: srv.revision,
                  enabled: srv.enabled,
                  transport: srv.binding?.type,
                  url: srv.binding?.url,
                  carrier: srv.controlCarrier
                });

                // Collect and update tunnel-client process status
                let tcStatus;
                const adapter = await resolveServiceAdapter(srv.id);
                let inspected = null;
                let recorded = null;
                if (adapter?.processController && typeof adapter.processController.inspect === 'function') {
                  try {
                    inspected = await adapter.processController.inspect(srv.id, {
                      executablePath: adapter.paths?.tunnelClientBin || (process.platform === 'win32' ? path.join(process.env.USERPROFILE || '', '.openai-tunnel', 'tunnel-client.exe') : null)
                    });
                  } catch (_) {}
                }
                if (adapter?.processPath && fs.existsSync(adapter.processPath)) {
                  try {
                    recorded = JSON.parse(fs.readFileSync(adapter.processPath, 'utf8'));
                  } catch (_) {}
                }

                const isLive = Boolean(inspected?.running && inspected.pid > 0);
                let isOwned = Boolean(isLive && recorded && recorded.pid === inspected.pid);
                let idVerified = false;

                // Safe auto-adoption of verified running tunnel-client process when its loopback
                // status endpoint matches a configured profile in store for this service
                if (isLive && !isOwned && inspected?.healthURL && adapter?.processPath && typeof adapter?.probe?.probe === 'function') {
                  try {
                    const liveHealth = await adapter.probe.probe(inspected.healthURL);
                    const liveTunnelId = liveHealth?.adminStatus?.control_plane_tunnel_id;
                    if (liveHealth?.live === true && liveTunnelId && typeof store?.listProfiles === 'function') {
                      const profs = await store.listProfiles();
                      let matchedProfile = null;
                      for (const p of profs) {
                        if (typeof store.rawCredentials === 'function') {
                          const raw = await store.rawCredentials(p.id);
                          const svcCred = raw?.[srv.id];
                          const tid = svcCred?.tunnelId || svcCred?.tunnel_id;
                          if (tid && tid === liveTunnelId) {
                            matchedProfile = p;
                            break;
                          }
                        }
                      }
                      if (matchedProfile && typeof adapter?.processController?.verify === 'function') {
                        const v = await adapter.processController.verify(inspected);
                        if (v?.valid) {
                          const nowIso = new Date().toISOString();
                          recorded = {
                            operationId: `adopted-${srv.id}-${inspected.pid}`,
                            service: srv.id,
                            profileId: matchedProfile.id,
                            transportKind: srv.binding?.type || 'stdio',
                            running: true,
                            pid: inspected.pid,
                            processId: inspected.pid,
                            executablePath: inspected.executablePath || inspected.executable,
                            executable: inspected.executable || inspected.executablePath,
                            startTime: inspected.startTime || inspected.startedAt,
                            startedAt: inspected.startedAt || inspected.startTime,
                            creationDate: inspected.startedAt || inspected.startTime,
                            creationTimeFileTime: inspected.creationTimeFileTime || null,
                            localPort: inspected.localPort || null,
                            healthURL: inspected.healthURL || null,
                            launchedAt: inspected.startedAt || inspected.startTime || nowIso,
                            updatedAt: nowIso
                          };
                          fs.mkdirSync(path.dirname(adapter.processPath), { recursive: true });
                          fs.writeFileSync(adapter.processPath, JSON.stringify(recorded, null, 2), 'utf8');
                          if (typeof store?.registry?.handleSetActiveService === 'function') {
                            store.registry.handleSetActiveService(srv.id, matchedProfile.id, matchedProfile.revision || 1, srv.revision || 1);
                          }
                          isOwned = true;
                          idVerified = true;
                        }
                      }
                    }
                  } catch (_) {}
                }

                if (isLive && isOwned && !idVerified) {
                  if (typeof adapter?.processController?.verify === 'function') {
                    try {
                      const v = await adapter.processController.verify(recorded);
                      idVerified = Boolean(v?.valid);
                    } catch (_) {
                      idVerified = false;
                    }
                  } else {
                    idVerified = true;
                  }
                }

                if (isLive && isOwned && idVerified) {
                  tcStatus = {
                    state: 'running',
                    managed: true,
                    pid: inspected.pid,
                    startedAt: inspected.startedAt || inspected.startTime || null,
                    profileId: recorded?.profileId || null,
                    operationId: recorded?.operationId || null,
                    observedAt: new Date().toISOString(),
                    expiresAt: new Date(Date.now() + 90000).toISOString(),
                    reasonCode: 'process_verified_running',
                    lastExitCode: null
                  };
                } else if (isLive && !isOwned) {
                  tcStatus = {
                    state: 'unmanaged',
                    managed: false,
                    pid: inspected.pid,
                    startedAt: inspected.startedAt || inspected.startTime || null,
                    profileId: null,
                    operationId: null,
                    observedAt: new Date().toISOString(),
                    expiresAt: new Date(Date.now() + 90000).toISOString(),
                    reasonCode: 'external_process_unmanaged',
                    lastExitCode: null
                  };
                } else if (inspected?.absenceVerified) {
                  tcStatus = {
                    state: 'stopped',
                    managed: true,
                    pid: null,
                    startedAt: null,
                    profileId: recorded?.profileId || null,
                    operationId: null,
                    observedAt: new Date().toISOString(),
                    expiresAt: new Date(Date.now() + 90000).toISOString(),
                    reasonCode: 'process_stopped',
                    lastExitCode: null
                  };
                } else {
                  // A missing manager identity record or unobserved process is NOT process_stopped!
                  tcStatus = {
                    state: 'unobserved',
                    managed: false,
                    pid: null,
                    startedAt: null,
                    profileId: recorded?.profileId || null,
                    operationId: null,
                    observedAt: new Date().toISOString(),
                    expiresAt: new Date(Date.now() + 90000).toISOString(),
                    reasonCode: srv.binding?.type === 'http' ? 'external_http_unmanaged' : 'external_process_unobserved',
                    lastExitCode: null
                  };
                }
                if (typeof observer.setTunnelClient === 'function') {
                  observer.setTunnelClient(srv.id, tcStatus);
                }
              } catch {}
            }
          })());
        }
        await Promise.all(workers);
      } catch {}
    }

    function runCollectionCycle() {
      if (!schedulerActive) return Promise.resolve();
      if (collectionPromise) return collectionPromise;
      collectionPromise = collectRegisteredServices().finally(() => { collectionPromise = null; });
      return collectionPromise;
    }

    runCollectionCycle().catch(() => {});

    const schedulerTimer = setInterval(() => {
      runCollectionCycle().catch(() => {});
    }, 30000);
    if (typeof schedulerTimer.unref === 'function') {
      schedulerTimer.unref();
    }

    releases.push(async () => {
      schedulerActive = false;
      clearInterval(schedulerTimer);
      if (typeof observer?.close === 'function') {
        try {
          await observer.close();
        } catch (_) {}
      }
      if (collectionPromise) {
        try {
          await collectionPromise;
        } catch (_) {}
      }
    });

    // 6. Discovery layer: constructor IO forbidden, no scan on boot
    const discovery = directDiscovery || (typeof discoveryFactory === 'function'
      ? await discoveryFactory({ dataDir, vault, repo: store, ...discoveryOptions })
      : await (async () => {
          try {
            const mod = await import('./config/mcp-discovery.mjs');
            if (typeof mod.createMcpDiscovery === 'function') {
              return mod.createMcpDiscovery({ dataDir, vault, repo: store, ...discoveryOptions });
            }
          } catch {
            // Module not present in isolated unit test environment
          }
          return {
            scan: async () => [],
            loadCandidate: async (id) => {
              const err = new Error(`Candidate '${id}' not found`);
              err.code = 'CANDIDATE_NOT_FOUND';
              err.status = 404;
              throw err;
            }
          };
        })());

    // 7. Locations resolver layer
    const storePath = typeof store?.getStorePath === 'function'
      ? store.getStorePath()
      : (store?.storePath || path.join(dataDir, 'manager.db'));

    const locations = directLocations || (typeof locationsFactory === 'function'
      ? await locationsFactory({ dataDir, storePath, ...locationsOptions })
      : await (async () => {
          try {
            const mod = await import('./config/mcp-locations.mjs');
            if (typeof mod.createMcpLocationResolver === 'function') {
              return mod.createMcpLocationResolver({ dataDir, storePath, ...locationsOptions });
            }
          } catch {
            // Module not present in isolated unit test environment
          }
          return {
            describe: async () => ({
              sourceConfigPath: null,
              effectiveConfigPath: null,
              managerStorePath: storePath,
              installationRoot: null,
              executable: null,
              cwd: null
            }),
            reveal: async () => ({ ok: true, opened: true, message: '已请求打开所在目录' })
          };
        })());

    // 8. Importer layer
    const importer = directImporter || (typeof importerFactory === 'function'
      ? await importerFactory({ repo: store, discovery, vault, ...importerOptions })
      : createConfigImporter({ repo: store, discovery, vault, ...importerOptions }));

    // 9. Anchor public directory using URL
    const publicDir = fileURLToPath(new URL('../public', import.meta.url));

    // 10. HTTP Server: pass repo: store, security, runner, adapters, publicDir, discovery, importer, locations
    const server = (restOptions.server && (typeof restOptions.server.listen === 'function' || typeof restOptions.server.close === 'function'))
      ? restOptions.server
      : (typeof restOptions.serverFactory === 'function'
          ? await restOptions.serverFactory({
              repo: store,
              security,
              runner,
              adapters,
              publicDir,
              discovery,
              importer,
              locations,
              vault,
              ...restOptions.server
            })
          : createHttpServer({
              repo: store,
              security,
              runner,
              adapters,
              publicDir,
              discovery,
              importer,
              locations,
              vault,
              ...restOptions.server
            }));

    let serverClosed = false;
    if (server && typeof server.close === 'function') {
      const origServerClose = server.close.bind(server);
      server.close = function (callback) {
        if (serverClosed) {
          if (typeof callback === 'function') process.nextTick(callback);
          return this;
        }
        try {
          const ret = origServerClose((err) => {
            serverClosed = true;
            if (typeof callback === 'function') callback();
          });
          if (ret && typeof ret.then === 'function') {
            ret.then(
              () => { serverClosed = true; if (typeof callback === 'function') callback(); },
              () => { serverClosed = true; if (typeof callback === 'function') callback(); }
            );
          }
          return ret ?? this;
        } catch (err) {
          // If server was not running, Node throws ERR_SERVER_NOT_RUNNING synchronously
          serverClosed = true;
          if (typeof callback === 'function') process.nextTick(callback);
          return this;
        }
      };
    }

    releases.push(async () => {
      if (serverClosed) return;
      await closeServerSafely(server);
      serverClosed = true;
    });

    await new Promise((resolve, reject) => {
      let settled = false;
      const onError = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      const onListening = (err) => {
        if (settled) return;
        if (err) {
          settled = true;
          cleanup();
          reject(err);
          return;
        }
        settled = true;
        cleanup();
        resolve();
      };
      function cleanup() {
        if (typeof server.off === 'function') {
          server.off('error', onError);
          server.off('listening', onListening);
        } else if (typeof server.removeListener === 'function') {
          server.removeListener('error', onError);
          server.removeListener('listening', onListening);
        }
      }

      if (typeof server.once === 'function') {
        server.once('error', onError);
      } else if (typeof server.on === 'function') {
        server.on('error', onError);
      }

      try {
        server.listen(port, host, onListening);
      } catch (err) {
        if (!settled) {
          settled = true;
          cleanup();
          reject(err);
        }
      }
    });

    const address = typeof server?.address === 'function' ? server.address() : null;
    const actualPort = typeof address === 'object' && address ? address.port : port;
    const url = `http://${host}:${actualPort}`;

    // Auto-import coordinator: deduplicated, no overlapping cycles, handles startup + authorized source changes
    let autoImportRunning = null;
    async function runAutoImportCoordinator() {
      if (autoImportRunning) return autoImportRunning;
      autoImportRunning = (async () => {
        try {
          if (discovery && typeof discovery.scan === 'function' && importer && typeof importer.importCandidate === 'function') {
            const candidates = await discovery.scan();
            for (const cand of candidates) {
              if (cand.autoEligible && !cand.duplicateOf && (!cand.warnings || cand.warnings.length === 0)) {
                try {
                  await importer.importCandidate(cand.id, {
                    mode: 'auto',
                    expectedFingerprint: cand.fingerprint
                  });
                } catch (_) {}
              }
            }
          }
        } catch (_) {
        } finally {
          autoImportRunning = null;
        }
      })();
      return autoImportRunning;
    }

    runAutoImportCoordinator().catch(() => {});

    // Periodic coordinator for authorized source changes (bounded, unref'ed, no overlapping cycles)
    const autoImportTimer = setInterval(() => {
      runAutoImportCoordinator().catch(() => {});
    }, 30000);
    if (typeof autoImportTimer.unref === 'function') {
      autoImportTimer.unref();
    }

    // Source-change hook registration
    if (typeof discovery?.onSourceChange === 'function') {
      try {
        discovery.onSourceChange(() => {
          runAutoImportCoordinator().catch(() => {});
        });
      } catch (_) {}
    }

    releases.push(async () => {
      clearInterval(autoImportTimer);
    });

    return {
      url,
      close,
      host,
      port: actualPort,
      dataDir,
      security,
      vault,
      store,
      repo: store,
      adapters,
      adapterProvider: runner?.deps?.adapterProvider || adapterProvider,
      runner,
      server,
      discovery,
      locations,
      importer,
      observer,
      autoImportCoordinator: runAutoImportCoordinator
    };
  }, rollback);
}

/**
 * CLI wrapper entry point that handles console output and OS exit signals.
 */
export async function startApp(options = {}) {
  const manager = await startManager(options);

  // First-run bootstrap secret on console only
  let bootstrapSecret = null;
  if (typeof manager.security?.getBootstrapSecret === 'function') {
    bootstrapSecret = await manager.security.getBootstrapSecret();
  } else if (manager.security?.bootstrapSecret) {
    bootstrapSecret = manager.security.bootstrapSecret;
  } else if (manager.security?.bootstrapToken) {
    bootstrapSecret = manager.security.bootstrapToken;
  } else if (manager.security?.firstRunSecret) {
    bootstrapSecret = manager.security.firstRunSecret;
  }

  if (bootstrapSecret) {
    console.log('================================================================');
    console.log('       MCP TUNNEL ACCOUNT MANAGER - FIRST RUN BOOTSTRAP         ');
    console.log('================================================================');
    console.log(`Bootstrap Secret: ${bootstrapSecret}`);
    console.log('Keep this secret safe. It is displayed ONCE on the local console.');
    console.log('Use it to authorize your initial browser session or API client.');
    console.log('================================================================');
  }

  console.log(`MCP Tunnel Account Manager listening on ${manager.url}`);
  console.log(`Local data directory: ${manager.dataDir}`);

  let isShuttingDown = false;
  const shutdown = async (signal = 'SIGINT') => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\nReceived ${signal}. Gracefully stopping MCP Tunnel Account Manager...`);

    const timeout = setTimeout(() => {
      console.error('Graceful shutdown timed out after 5000ms. Forcing process exit.');
      process.exit(1);
    }, 5000);
    timeout.unref();

    try {
      await manager.close();
      console.log('Shutdown completed.');
      process.exit(0);
    } catch (err) {
      console.error('Error during shutdown:', err);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return {
    ...manager,
    shutdown
  };
}

// Auto-start when executed directly from CLI
const isMainModule = Boolean(
  process.argv[1] && (
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
    pathToFileURL(process.argv[1]).href === import.meta.url
  )
);

if (isMainModule) {
  startApp().catch((err) => {
    console.error('Fatal initialization error:', err);
    process.exit(1);
  });
}

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

    // 6. Discovery layer: constructor IO forbidden, no scan on boot
    const discovery = directDiscovery || (typeof discoveryFactory === 'function'
      ? await discoveryFactory({ dataDir, ...discoveryOptions })
      : await (async () => {
          try {
            const mod = await import('./config/mcp-discovery.mjs');
            if (typeof mod.createMcpDiscovery === 'function') {
              return mod.createMcpDiscovery({ dataDir, ...discoveryOptions });
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
      ? await importerFactory({ repo: store, discovery, ...importerOptions })
      : createConfigImporter({ repo: store, discovery, ...importerOptions }));

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
      importer
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

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SwitchFault } from '../../src/core/switch-core.mjs';
import { createTunnelProbe, tunnelProbe as defaultTunnelProbe } from '../../src/adapters/tunnel-probe.mjs';
import { assertStoppedConnectionReceipt, isMcpServiceId, RegistryPolicyFault } from '../../src/core/mcp-registry-policy.mjs';

export const DEFAULT_PROXY = 'http://127.0.0.1:7897';

function sha256(data) {
  const content = typeof data === 'string' ? data : JSON.stringify(data);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Creates a reliable synthetic HTTP server simulating the tunnel daemon health & admin endpoints.
 * Tracks all active client sockets so shutdown terminates all open connections and releases port handles cleanly.
 */
export function createSyntheticThirdServer(options = {}) {
  let server = null;
  const sockets = new Set();
  const host = options.host || '127.0.0.1';
  let port = options.port || 0;
  let running = false;
  let isHealthy = options.isHealthy !== false;
  const service = options.service || 'synthetic-mcp';
  const instanceId = options.instanceId || `synth-inst-${process.pid}-${Date.now()}`;
  const startedAt = options.startedAt || new Date().toISOString();
  const tunnelId = options.tunnelId || 'synthetic-tunnel';
  const controlPlaneBaseUrl = options.controlPlaneBaseUrl || 'https://api.openai.com';

  function handleRequest(req, res) {
    const parsed = new URL(req.url, `http://${host}:${port || 80}`);

    if (parsed.pathname === '/health') {
      const now = new Date().toISOString();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        schema_version: 1,
        live: true,
        ready: true,
        truncated: false,
        snapshot_at: now,
        runtime: {
          limited: false,
          lifecycle: 'running',
          version: '0.0.19',
          instance_id: instanceId,
          started_at: startedAt
        },
        components: {
          'control-plane': {
            status: isHealthy ? 'ok' : 'degraded',
            limited: false,
            state: isHealthy ? 'polling' : 'backoff',
            observed_at: now,
            details: {
              consecutive_failures: isHealthy ? 0 : 1,
              http_status: isHealthy ? 0 : 401,
              failure_category: isHealthy ? '' : 'unauthorized',
              deadline_seconds: 15,
              last_success: isHealthy ? (options.lastSuccess || now) : null,
              last_error: isHealthy ? null : now,
              current_poll_age_seconds: 1
            }
          }
        }
      }));
      return;
    }

    if (parsed.pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        version: '0.0.19',
        client_instance_id: instanceId,
        control_plane_tunnel_id: tunnelId,
        control_plane_base_url: controlPlaneBaseUrl,
        started_at: startedAt
      }));
      return;
    }

    if (parsed.pathname === '/quit' || parsed.pathname === '/close') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, stopping: true }));
      setImmediate(() => close());
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  }

  async function start(listenPort = 0) {
    if (running && server) {
      return { port, url: `http://${host}:${port}`, server, close };
    }
    return new Promise((resolve, reject) => {
      server = http.createServer(handleRequest);
      server.on('connection', (sock) => {
        sockets.add(sock);
        sock.on('close', () => sockets.delete(sock));
      });
      server.listen(listenPort || port, host, () => {
        const addr = server.address();
        port = addr.port;
        running = true;
        resolve({
          port,
          url: `http://${host}:${port}`,
          server,
          close
        });
      });
      server.on('error', reject);
    });
  }

  async function close() {
    running = false;
    for (const s of sockets) {
      try { s.destroy(); } catch (_) {}
    }
    sockets.clear();
    if (server) {
      return new Promise((resolve) => {
        server.close(() => {
          server = null;
          resolve();
        });
      });
    }
  }

  return {
    start,
    close,
    getPort: () => port,
    getUrl: () => `http://${host}:${port}`,
    setHealthy: (h) => { isHealthy = Boolean(h); },
    isRunning: () => running
  };
}

export async function startSyntheticThirdServer(options = {}) {
  const synth = createSyntheticThirdServer(options);
  const info = await synth.start(options.port || 0);
  return {
    ...info,
    synth,
    setHealthy: synth.setHealthy,
    close: synth.close
  };
}

export class ThirdPartyMcpAdapter {
  constructor({ service, definition, dataDir, processController, probe, paths = {}, healthURL = null, syntheticServer = null }) {
    this.service = service;
    this.definition = definition || { id: service, label: service, binding: { type: 'stdio', executable: 'node', args: [] } };
    this.dataDir = dataDir;
    this.processController = processController;
    this.probe = probe;
    this.paths = paths;
    this.healthURL = healthURL;
    this.syntheticServer = syntheticServer;

    this.runtimeDir = path.join(dataDir, 'runtime', service);
    this.configPath = paths[`${service}ConfigPath`] || path.join(paths.appData || dataDir, 'tunnel-client', `${service}.yaml`);
    this.processPath = path.join(this.runtimeDir, 'process.json');
    this.intentPath = path.join(this.runtimeDir, 'intent.json');
  }

  async startSyntheticServer(port = 0) {
    if (!this.syntheticServer) {
      this.syntheticServer = createSyntheticThirdServer({
        service: this.service,
        tunnelId: this.definition.id
      });
    }
    const info = await this.syntheticServer.start(port);
    this.healthURL = info.url;
    return info;
  }

  async stopSyntheticServer() {
    if (this.syntheticServer) {
      await this.syntheticServer.close();
      this.syntheticServer = null;
    }
  }

  _readCurrentConfigRecord() {
    if (!fs.existsSync(this.configPath)) {
      return { yaml: '' };
    }
    return { yaml: fs.readFileSync(this.configPath, 'utf8') };
  }

  _computeFingerprint(record) {
    return sha256(record.yaml || '');
  }

  _buildLaunchTemplate(cred) {
    const isWindows = process.platform === 'win32';
    const bin = this.paths.tunnelClientBin || (isWindows ? 'tunnel-client.exe' : 'tunnel-client');
    const bindingArgs = this.definition.binding?.args || [];
    const commandArgs = bindingArgs.map(a => a.value || '');

    return {
      command: bin,
      args: ['run', '--profile', this.service, ...commandArgs],
      cwd: this.definition.binding?.cwd || this.dataDir,
      serviceMcpEnv: this.definition.environment
        ? Object.fromEntries(Object.entries(this.definition.environment).map(([k, v]) => [k, typeof v === 'object' ? v.value : v]))
        : {}
    };
  }

  async prepare({ operationId, credential }) {
    const cred = {
      tunnelId: credential?.tunnelId ?? credential?.tunnel_id ?? '',
      apiKey: credential?.apiKey ?? credential?.api_key ?? '',
      organizationId: credential?.organizationId ?? credential?.organization_id ?? null
    };

    if (!cred.tunnelId || !cred.apiKey) {
      throw new SwitchFault('TARGET_VERIFICATION_UNAVAILABLE');
    }

    if (this.probe && typeof this.probe.checkReady === 'function') {
      let ready = false;
      try {
        ready = await this.probe.checkReady({ service: this.service, credential: cred, operationId });
      } catch (_) {}
      if (!ready && isMcpServiceId(this.service)) {
        ready = Boolean(cred.tunnelId && cred.apiKey && !/[\x00-\x1f]/.test(cred.tunnelId) && !/[\x00-\x1f]/.test(cred.apiKey));
      }
      if (!ready) {
        throw new SwitchFault('TARGET_VERIFICATION_UNAVAILABLE');
      }
    }

    const originalConfig = this._readCurrentConfigRecord();
    const originalFingerprint = this._computeFingerprint(originalConfig);

    const desiredYaml = [
      'config_version: 1',
      'control_plane:',
      `  tunnel_id: "${cred.tunnelId}"`,
      `  api_key: "env:CONTROL_PLANE_API_KEY"`,
      cred.organizationId ? `  organization_id: "${cred.organizationId}"` : null,
      'health:',
      '  listen_addr: "127.0.0.1:0"',
      'admin_ui:',
      '  open_browser: false',
      'mcp:',
      '  commands:',
      '    - channel: main',
      `      command: "${this.definition.binding?.executable || 'node'}"`
    ].filter(Boolean).join('\n') + '\n';

    const desiredConfig = { yaml: desiredYaml };
    const desiredFingerprint = this._computeFingerprint(desiredConfig);

    const originalProcessIdentity = await this.processController.inspect(this.service);
    const launchTemplate = this._buildLaunchTemplate(cred);

    return {
      operationId,
      service: this.service,
      originalFingerprint,
      desiredFingerprint,
      originalConfig,
      desiredConfig,
      originalProcessIdentity: originalProcessIdentity?.running ? originalProcessIdentity : { running: false },
      launchTemplate,
      credential: cred,
      healthURL: this.healthURL
    };
  }

  async applyIfUnchanged({ operationId, snapshot }) {
    if (snapshot.service !== this.service) {
      throw new SwitchFault('SERVICE_MISMATCH');
    }

    const currentConfig = this._readCurrentConfigRecord();
    const currentFingerprint = this._computeFingerprint(currentConfig);
    if (currentFingerprint !== snapshot.originalFingerprint) {
      throw new SwitchFault('CONFIG_DRIFT');
    }

    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, snapshot.desiredConfig.yaml, 'utf8');

    if (snapshot.originalProcessIdentity?.running) {
      await this.processController.stop(snapshot.originalProcessIdentity);
    }

    fs.mkdirSync(this.runtimeDir, { recursive: true });
    const intent = {
      operationId,
      service: this.service,
      state: 'INTENT_LAUNCH',
      createdAt: new Date().toISOString()
    };
    fs.writeFileSync(this.intentPath, JSON.stringify(intent, null, 2), 'utf8');

    const template = snapshot.launchTemplate || this._buildLaunchTemplate(snapshot.credential);
    const explicitEnv = {
      ...template.serviceMcpEnv,
      HTTP_PROXY: DEFAULT_PROXY,
      HTTPS_PROXY: DEFAULT_PROXY,
      ALL_PROXY: DEFAULT_PROXY,
      CONTROL_PLANE_API_KEY: snapshot.credential.apiKey
    };

    const newIdentity = await this.processController.launch({
      service: this.service,
      command: template.command,
      args: template.args,
      env: explicitEnv,
      cwd: template.cwd,
      operationId
    });

    const nowIso = new Date().toISOString();
    const record = {
      operationId,
      service: this.service,
      ...newIdentity,
      running: true,
      launchedAt: nowIso,
      updatedAt: nowIso
    };
    fs.writeFileSync(this.processPath, JSON.stringify(record, null, 2), 'utf8');

    try {
      if (fs.existsSync(this.intentPath)) {
        const storedIntent = JSON.parse(fs.readFileSync(this.intentPath, 'utf8'));
        if (storedIntent?.operationId === operationId) {
          fs.unlinkSync(this.intentPath);
        }
      }
    } catch (_) {}

    return record;
  }

  async verifyDesired({ operationId, snapshot }) {
    if (snapshot.service !== this.service) {
      throw new SwitchFault('SERVICE_MISMATCH');
    }

    const inspected = await this.processController.inspect(this.service);
    if (!inspected?.running) {
      throw new SwitchFault('PROCESS_NOT_RUNNING');
    }

    let storedRecord = null;
    if (fs.existsSync(this.processPath)) {
      try {
        storedRecord = JSON.parse(fs.readFileSync(this.processPath, 'utf8'));
      } catch (_) {}
    }

    const boundIdentity = {
      pid: inspected.pid,
      executable: inspected.executablePath || inspected.executable || storedRecord?.executable || storedRecord?.executablePath,
      startedAt: inspected.startTime || inspected.startedAt || storedRecord?.startedAt || storedRecord?.startTime,
      creationTimeFileTime: inspected.creationTimeFileTime || storedRecord?.creationTimeFileTime
    };

    const probeToUse = this.probe || defaultTunnelProbe;
    const probeVerification = await probeToUse.verify({
      service: this.service,
      operationId,
      snapshot,
      credential: snapshot.credential,
      healthURL: snapshot.healthURL || this.healthURL,
      identity: boundIdentity,
      processController: this.processController
    });

    if (!probeVerification?.verified) {
      throw new SwitchFault(probeVerification?.reason || 'TARGET_VERIFICATION_UNCONFIRMED');
    }

    return {
      verified: true,
      operationId,
      service: this.service,
      configFingerprint: snapshot.desiredFingerprint,
      proof: {
        kind: 'authenticated-control-plane',
        details: probeVerification.details || {}
      },
      identity: boundIdentity
    };
  }

  async stopConnection({ operationId, serviceId, originalRuntime }) {
    if (serviceId !== this.service) {
      throw new RegistryPolicyFault('SERVICE_MISMATCH', 400);
    }

    // Shut down attached synthetic server if one was started
    if (this.syntheticServer) {
      try {
        await this.syntheticServer.close();
      } catch (_) {}
      this.syntheticServer = null;
    }

    const inspected = await this.processController.inspect(this.service);
    if (!inspected || !inspected.running) {
      const receipt = {
        stopped: true,
        operationId,
        service: this.service,
        proof: { kind: 'verified-already-stopped' }
      };
      assertStoppedConnectionReceipt(receipt, operationId, this.service);
      return receipt;
    }

    // Process is running: match handle identity
    const expectedPid = originalRuntime?.pid || inspected.pid;
    if (inspected.pid !== expectedPid) {
      throw new SwitchFault('PROCESS_IDENTITY_MISMATCH');
    }

    const identityToStop = {
      pid: inspected.pid,
      running: true,
      executable: inspected.executablePath || inspected.executable,
      executablePath: inspected.executablePath || inspected.executable,
      startTime: inspected.startTime || inspected.startedAt,
      startedAt: inspected.startTime || inspected.startedAt,
      creationTimeFileTime: inspected.creationTimeFileTime
    };

    await this.processController.stop(identityToStop);

    // Verify it is stopped
    const afterStop = await this.processController.inspect(this.service);
    if (afterStop?.running) {
      throw new SwitchFault('PROCESS_STOP_FAILED');
    }

    // Clean process record
    try {
      if (fs.existsSync(this.processPath)) {
        fs.unlinkSync(this.processPath);
      }
    } catch (_) {}

    const receipt = {
      stopped: true,
      operationId,
      service: this.service,
      proof: { kind: 'verified-owned-process-exit' },
      identity: {
        pid: identityToStop.pid,
        startedAt: identityToStop.startedAt,
        executable: identityToStop.executable
      }
    };

    assertStoppedConnectionReceipt(receipt, operationId, this.service);
    return receipt;
  }

  async restoreIfOwned({ operationId, snapshot, step }) {
    if (snapshot.service !== this.service) {
      throw new SwitchFault('SERVICE_MISMATCH');
    }

    if (this.syntheticServer) {
      try {
        await this.syntheticServer.close();
      } catch (_) {}
      this.syntheticServer = null;
    }

    if (fs.existsSync(this.configPath)) {
      fs.writeFileSync(this.configPath, snapshot.originalConfig.yaml, 'utf8');
    }

    const inspected = await this.processController.inspect(this.service);
    if (inspected?.running) {
      await this.processController.stop(inspected);
    }

    try {
      if (fs.existsSync(this.intentPath)) fs.unlinkSync(this.intentPath);
      if (fs.existsSync(this.processPath)) fs.unlinkSync(this.processPath);
    } catch (_) {}

    return {
      restored: true,
      runtimeRestored: true,
      operationId,
      service: this.service,
      configFingerprint: snapshot.originalFingerprint
    };
  }

  async describe() {
    const configExists = fs.existsSync(this.configPath);
    const inspected = await this.processController.inspect(this.service);
    return {
      service: this.service,
      configured: configExists,
      running: Boolean(inspected?.running),
      process: inspected?.running ? inspected : null
    };
  }
}

export function createRegisteredAdapterProvider(options = {}) {
  const cache = new Map(); // operationId -> adapters map

  return async function provider(op, serviceId) {
    const opId = op.operationId || op.id;
    let adapters = cache.get(opId);
    if (!adapters) {
      adapters = {};
      const defs = op.registrySnapshot?.services || [];
      for (const def of defs) {
        adapters[def.id] = new ThirdPartyMcpAdapter({
          service: def.id,
          definition: def,
          dataDir: options.dataDir,
          processController: options.processController,
          probe: options.probe,
          paths: options.paths,
          healthURL: options.healthURLs?.[def.id] || options.healthURL,
          syntheticServer: options.syntheticServers?.[def.id] || null
        });
      }
      cache.set(opId, adapters);
    }
    return adapters[serviceId] || null;
  };
}

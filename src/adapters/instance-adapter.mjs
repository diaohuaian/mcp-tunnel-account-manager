/**
 * Per-instance tunnel-client adapter (concurrent multi-profile instances).
 *
 * ONE MCP service may run SEVERAL tunnel-client processes at the same time, each
 * bound to a different account/profile. This module gives every such instance its
 * own isolated identity so that no two instances can ever share state:
 *
 *   configPath     <dataDir>/instances/profiles/<stem>_profile_<segment>.yaml
 *   runtimeRecord  <dataDir>/runtime/<instanceId>-process.json
 *   intent         <dataDir>/runtime/<instanceId>-intent.json
 *   healthURL file <dataDir>/runtime/<instanceId>-health.url
 *
 * `--profile-dir <dataDir>/instances/profiles --profile <stem>_profile_<segment>`
 * makes tunnel-client read ONLY that instance's YAML (never `%APPDATA%\tunnel-client`),
 * `--health.listen-addr 127.0.0.1:0` gives every instance its own ephemeral loopback
 * port, and `--health.url-file` records the resolved URL where we read it back from.
 *
 * Safety invariant: `stopConnection()` can only ever stop the process recorded for
 * THIS instance, verified by exact pid + executable path + creation time through the
 * audited process controller. A sibling instance of the same service is unreachable
 * from here: the record file is instance-scoped, the controller is re-keyed to the
 * instance id, and inspection runs with `allowExternalScan: false` so a same-binary
 * FindOwned-by-tag scan can never adopt a foreign pid.
 *
 * Legacy `ServiceAdapter` / `createAdapters()` behaviour is untouched: this module
 * composes a `ServiceAdapter` delegate instead of modifying it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ServiceAdapter, createDefaultProcessController } from './index.mjs';
import { tunnelProbe as defaultTunnelProbe } from './tunnel-probe.mjs';
import { SwitchFault } from '../core/switch-core.mjs';
import { userProfilePath } from '../core/user-profile-path.mjs';
import { isMcpServiceId } from '../core/mcp-registry-policy.mjs';
import {
  InstanceFault,
  assertInstanceTarget,
  instanceRecordFileName,
  profileYamlFileName
} from '../core/concurrent-instances.mjs';

/** Every instance binds an ephemeral loopback port; never a fixed one. */
export const INSTANCE_LISTEN_ADDR = '127.0.0.1:0';

/** Production console port. An instance health listener must never be recorded there. */
const FORBIDDEN_HEALTH_PORT = 17642;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const HEALTH_URL_POLL_INTERVAL_MS = 100;
const HEALTH_URL_TIMEOUT_REAL_MS = 10000;
const HEALTH_URL_TIMEOUT_FAKE_MS = 750;

const PROCESS_CONTROL_SCRIPT = fileURLToPath(new URL('../../scripts/process-control.ps1', import.meta.url));

/** `<dataDir>/instances/profiles` — isolated profile base, never `%APPDATA%\tunnel-client`. */
export function instanceProfileDirPath(dataDir) {
  if (typeof dataDir !== 'string' || dataDir.trim() === '' || dataDir.includes('\0')) {
    throw new InstanceFault('INVALID_INSTANCE', 'dataDir is required for instance adapters');
  }
  return path.join(dataDir, 'instances', 'profiles');
}

/** Health URL handshake filename written by `--health.url-file`. */
export function instanceHealthUrlFileName(instanceId) {
  if (typeof instanceId !== 'string' || instanceId === '' || instanceId.includes('\0')) {
    throw new InstanceFault('INVALID_INSTANCE');
  }
  return `${instanceId}-health.url`;
}

/**
 * Resolves a path to its real on-disk form, tolerating not-yet-existing tails.
 *
 * `path.resolve()` is purely LEXICAL: it normalises case, separators and `..`,
 * but it never consults the filesystem. Windows therefore offers several ways to
 * name one directory without spelling it out, and every one of them defeats a
 * plain string comparison:
 *
 *   - 8.3 short names   `MCPTUN~1`  -> `McpTunnelAccountManager`
 *   - junctions/symlinks `link -> ...\McpTunnelAccountManager`
 *
 * So any path taking part in the production check is first resolved against the
 * filesystem. Not-yet-existing tails are preserved by resolving the nearest
 * existing ancestor and re-appending the remainder, which is the normal case
 * here because an instance data directory is usually created on demand.
 *
 * Falls back to a plain resolve only when no ancestor can be resolved at all.
 */
export function realResolve(target) {
  let original;
  try {
    const norm = path.sep === '/' ? String(target).replace(/\\/g, '/') : String(target);
    original = path.resolve(norm);
  } catch {
    return String(target);
  }

  let current = original;
  const tail = [];
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const real = fs.realpathSync.native(current).replace(/[\\/]+$/, '');
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return original;
      tail.push(path.basename(current));
      current = parent;
    }
  }
  return original;
}

/**
 * True when `candidate` IS `root` or lives anywhere BENEATH it.
 *
 * Both sides go through `realResolve()` so short names and reparse points are
 * compared as the directories they actually are. The trailing separator in the
 * prefix test is what stops `...\McpTunnelAccountManager-dev` from being
 * mistaken for a child of `...\McpTunnelAccountManager`.
 */
function isSameOrDescendant(candidate, root) {
  const normCandidate = path.sep === '/' ? String(candidate).replace(/\\/g, '/') : candidate;
  const normRoot = path.sep === '/' ? String(root).replace(/\\/g, '/') : root;
  const left = realResolve(normCandidate).toLowerCase().replace(/[\\/]+$/, '');
  const right = realResolve(normRoot).toLowerCase().replace(/[\\/]+$/, '');
  if (!left || !right) return false;
  return left === right || left.startsWith(`${right}${path.sep}`) || left.startsWith(`${right}/`);
}

/**
 * Refuses data directories that belong to the live production installation.
 * Concurrent instances must never be written next to the production database,
 * and never inside the production tunnel-client profile directory.
 *
 * Both protected roots use the SAME test (equal-or-descendant). An earlier
 * revision checked only equality against the data directory, which accepted
 * `...\McpTunnelAccountManager\sub` and would have written instance profiles
 * inside the production data directory.
 */
export function assertIsolatedInstanceDataDir(dataDir) {
  if (typeof dataDir !== 'string' || dataDir.trim() === '' || dataDir.includes('\0')) {
    throw new InstanceFault('INVALID_INSTANCE', 'dataDir is required for instance adapters');
  }
  const normDataDir = path.sep === '/' ? dataDir.replace(/\\/g, '/') : dataDir;
  const resolved = path.resolve(normDataDir);

  const localAppData = process.env.LOCALAPPDATA || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : null);
  if (localAppData) {
    const productionDataDir = path.resolve(localAppData, 'McpTunnelAccountManager');
    if (isSameOrDescendant(resolved, productionDataDir)) {
      throw new InstanceFault('INVALID_INSTANCE', 'production data directory is not allowed for concurrent instances');
    }
  }

  const appData = process.env.APPDATA || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : null);
  if (appData) {
    const productionProfiles = path.resolve(appData, 'tunnel-client');
    if (isSameOrDescendant(resolved, productionProfiles)) {
      throw new InstanceFault('INVALID_INSTANCE', 'production tunnel-client profile directory is not allowed for concurrent instances');
    }
  }

  return resolved;
}

/**
 * Normalizes a health endpoint (URL, `host:port`, or a small JSON blob) into a
 * loopback-only `{healthURL, localPort}` record. Returns null when unusable, so the
 * caller keeps polling instead of recording a bogus port.
 */
export function normalizeHealthEndpoint(raw) {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  if (!text || text.length > 2048) return null;

  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      text = String(parsed?.url ?? parsed?.healthURL ?? parsed?.health_url ?? parsed?.listen_addr ?? '').trim();
    } catch {
      return null;
    }
  }
  text = text.replace(/^["']/, '').replace(/["']$/, '').trim();
  if (!text) return null;

  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text)) text = `http://${text}`;

  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) return null;

  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) return null;
  if (port === FORBIDDEN_HEALTH_PORT) return null;

  return { healthURL: `http://127.0.0.1:${port}`, localPort: port, host: '127.0.0.1' };
}

/**
 * Health evidence observed by the audited process controller: the helper reports the
 * loopback listener OWNED BY THE INSPECTED PID, so it stays instance-scoped.
 */
export function healthEvidenceFromInspection(inspected) {
  if (!inspected || typeof inspected !== 'object') return null;
  if (typeof inspected.healthURL === 'string' && inspected.healthURL) {
    const evidence = normalizeHealthEndpoint(inspected.healthURL);
    if (evidence) return { ...evidence, source: 'audited-process-inspection' };
  }
  const port = inspected.localPort;
  if (Number.isSafeInteger(port) && port > 0 && port <= 65535 && port !== FORBIDDEN_HEALTH_PORT) {
    return {
      healthURL: `http://127.0.0.1:${port}`,
      localPort: port,
      host: '127.0.0.1',
      source: 'audited-process-inspection'
    };
  }
  return null;
}

/**
 * Rewrites a launch argument vector so the instance owns its profile and port:
 * drops any inherited `--profile` / `--profile-dir` / health arguments, then inserts
 * the instance-scoped ones directly after the `run` subcommand (keeping any binary
 * prefix, proxy, poll-timeout and HTTP transport arguments intact).
 */
export function rewriteInstanceLaunchArgs(args, {
  profileDir,
  profileName,
  healthUrlFile,
  listenAddr = INSTANCE_LISTEN_ADDR
}) {
  const source = Array.isArray(args) ? args : [];
  const valueFlags = new Set(['--profile', '--profile-dir', '--health.listen-addr', '--health.url-file']);
  const kept = [];

  for (let i = 0; i < source.length; i++) {
    const arg = source[i];
    if (typeof arg !== 'string') {
      kept.push(arg);
      continue;
    }
    if (valueFlags.has(arg)) {
      i += 1;
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > 0 && valueFlags.has(arg.slice(0, eq))) continue;
    kept.push(arg);
  }

  const instanceArgs = [
    '--profile-dir', profileDir,
    '--profile', profileName,
    '--health.listen-addr', listenAddr,
    '--health.url-file', healthUrlFile
  ];

  const runIndex = kept.indexOf('run');
  if (runIndex >= 0) {
    kept.splice(runIndex + 1, 0, ...instanceArgs);
  } else {
    kept.unshift(...instanceArgs);
  }
  return kept;
}

/**
 * Wraps a process controller so every audited action is keyed to the INSTANCE id
 * instead of the service id, and so inspection can never adopt a same-binary
 * process by tag scan (that would let instance A stop instance B's pid).
 */
export function createInstanceProcessController(processController, { instanceId, serviceId = null } = {}) {
  if (!processController || typeof processController.inspect !== 'function') {
    throw new InstanceFault('INVALID_INSTANCE', 'a process controller with inspect() is required');
  }
  if (typeof instanceId !== 'string' || instanceId === '') {
    throw new InstanceFault('INVALID_INSTANCE');
  }

  const scoped = {
    runtimeCommand: processController.runtimeCommand,
    instanceId,
    serviceId,

    async inspect(_serviceIgnored, options = {}) {
      // The audited helper is asked for a pid, then identity-checked against the
      // instance record. External tag scanning is disabled for instance scopes.
      return processController.inspect(instanceId, { ...(options || {}), allowExternalScan: false });
    },

    async launch(params = {}) {
      if (typeof processController.launch !== 'function') {
        throw new InstanceFault('INVALID_INSTANCE', 'process controller cannot launch');
      }
      // `service` selects the runtime record filename inside the controller;
      // the instance id is what makes it unique per account.
      return processController.launch({ ...params, service: instanceId });
    }
  };

  if (typeof processController.verify === 'function') {
    scoped.verify = (identity) => processController.verify(identity);
  }
  if (typeof processController.stop === 'function') {
    scoped.stop = (identity) => processController.stop(identity);
  }
  if (typeof processController.getIntent === 'function') {
    scoped.getIntent = () => processController.getIntent(instanceId);
  }
  if (typeof processController.clearIntent === 'function') {
    scoped.clearIntent = (expectedOperationId) => processController.clearIntent(instanceId, expectedOperationId);
  }

  return scoped;
}

function resolveInstancePaths({ paths = {} } = {}) {
  const userProfile = paths.userProfile || process.env.USERPROFILE || userProfilePath();
  const appData = paths.appData || process.env.APPDATA || path.join(userProfile, 'AppData', 'Roaming');
  const tunnelHome = paths.tunnelHome || path.join(userProfile, '.openai-tunnel');
  return {
    userProfile,
    appData,
    tunnelHome,
    tunnelClientBin: path.join(tunnelHome, 'tunnel-client.exe'),
    ...paths
  };
}

/**
 * One instance of one service. Composes a `ServiceAdapter` delegate (so YAML
 * rewriting, CAS, fingerprinting, intent write-ahead and rollback logic stay
 * single-source) and overrides only what must differ per instance: profile YAML,
 * launch arguments, runtime record/intent paths, health handshake and stop guard.
 */
export class InstanceAdapter {
  constructor({
    serviceId,
    profileId,
    definition = null,
    dataDir,
    paths = {},
    probe = null,
    vault = null,
    processController = null,
    healthURL = null,
    healthTimeoutMs = null
  } = {}) {
    const target = assertInstanceTarget({ serviceId, profileId });

    this.service = target.serviceId;
    this.serviceId = target.serviceId;
    this.profileId = target.profileId;
    this.instanceId = target.instanceId;
    this.profileSegment = target.profileSegment;
    this.definition = definition || null;
    this.vault = vault || null;
    this.dataDir = assertIsolatedInstanceDataDir(dataDir);
    this.probe = probe || null;

    this.profileYaml = profileYamlFileName(this.service, this.profileId);
    this.profileName = this.profileYaml.replace(/\.yaml$/i, '');
    this.profileDir = instanceProfileDirPath(this.dataDir);
    this.configPath = path.join(this.profileDir, this.profileYaml);

    this.runtimeDir = path.join(this.dataDir, 'runtime');
    this.processPath = path.join(this.runtimeDir, instanceRecordFileName(this.service, this.profileId, 'process'));
    this.intentPath = path.join(this.runtimeDir, instanceRecordFileName(this.service, this.profileId, 'intent'));
    this.healthUrlFile = path.join(this.runtimeDir, instanceHealthUrlFileName(this.instanceId));

    this.localPort = null;
    this.healthURL = null;
    if (healthURL) {
      const evidence = normalizeHealthEndpoint(healthURL);
      if (evidence) {
        this.healthURL = evidence.healthURL;
        this.localPort = evidence.localPort;
      }
    }

    this._baseProcessController = processController || null;
    this.processController = processController
      ? createInstanceProcessController(processController, { instanceId: this.instanceId, serviceId: this.service })
      : null;
    this._requireProcessController();

    // A real audited helper needs a long bounded wait for the ephemeral listener to
    // appear. A fake runtimeCommand, or an injected test double that is not an
    // audited controller, answers immediately.
    const base = this._baseProcessController;
    const usesRealAuditedHelper = base
      ? ('runtimeCommand' in base ? typeof base.runtimeCommand !== 'function' : false)
      : true;
    this.healthTimeoutMs = Number.isFinite(healthTimeoutMs)
      ? Math.max(0, healthTimeoutMs)
      : (usesRealAuditedHelper ? HEALTH_URL_TIMEOUT_REAL_MS : HEALTH_URL_TIMEOUT_FAKE_MS);

    const basePaths = resolveInstancePaths({ paths });
    const delegatePaths = {
      ...basePaths,
      listenAddr: INSTANCE_LISTEN_ADDR,
      healthUrlFile: this.healthUrlFile,
      overleafEnvPath: null,
      overleafConfigPath: this.configPath,
      antigravityConfigPath: this.configPath,
      [`${this.service}ConfigPath`]: this.configPath,
      [`${this.service}EnvPath`]: null
    };
    this.paths = delegatePaths;

    // The delegate is built with the instance controller/paths, then its file
    // identities are forced to the instance ones so no code path can fall back to
    // `%APPDATA%\tunnel-client` or to a shared `<service>-process.json`.
    const delegate = new ServiceAdapter({
      service: this.service,
      definition: this.definition,
      vault: this.vault,
      dataDir: this.dataDir,
      processController: this.processController,
      probe: this.probe,
      paths: delegatePaths,
      healthURL: this.healthURL
    });
    delegate.configPath = this.configPath;
    delegate.envPath = null;
    delegate.processPath = this.processPath;
    delegate.intentPath = this.intentPath;
    delegate.runtimeDir = this.runtimeDir;

    // `ServiceAdapter.restoreIfOwned()` rebuilds a template when the snapshot has
    // none, so the instance rewrite must also live behind the delegate's builder.
    const legacyTemplateBuilder = delegate._buildLaunchTemplate.bind(delegate);
    delegate._buildLaunchTemplate = (credential) =>
      this._buildInstanceTemplate(legacyTemplateBuilder(credential), credential);

    this._delegate = delegate;
  }

  _requireProcessController() {
    if (!this.processController) {
      throw new InstanceFault('INVALID_INSTANCE', 'a process controller is required for instance adapters');
    }
    return this.processController;
  }

  _readProcessRecord() {
    if (!fs.existsSync(this.processPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.processPath, 'utf8'));
    } catch {
      return null;
    }
  }

  _writeProcessRecord(record) {
    fs.mkdirSync(path.dirname(this.processPath), { recursive: true });
    fs.writeFileSync(this.processPath, JSON.stringify(record, null, 2), 'utf8');
    return record;
  }

  /**
   * Reads the `--health.url-file` handshake this instance's own tunnel wrote.
   * tunnel-client resolves `127.0.0.1:0` to a real port and writes the URL here,
   * which is how a per-instance ephemeral port becomes observable.
   */
  readHealthUrlFile() {
    if (!fs.existsSync(this.healthUrlFile)) return null;
    let raw;
    try {
      raw = fs.readFileSync(this.healthUrlFile, 'utf8');
    } catch {
      return null;
    }
    const evidence = normalizeHealthEndpoint(raw);
    return evidence
      ? { ...evidence, source: 'health-url-file', healthUrlFile: this.healthUrlFile }
      : null;
  }

  _clearStaleHealthUrlFile() {
    try {
      if (fs.existsSync(this.healthUrlFile)) fs.unlinkSync(this.healthUrlFile);
    } catch {
      /* best effort: a stale file is simply overwritten by the next daemon start */
    }
  }

  /**
   * Bounded wait for this instance's health handshake. Order of authority:
   *   1. `<runtime>/<instanceId>-health.url` written by the daemon itself
   *   2. the loopback listener owned by the inspected (and identity-verified) pid
   * Returns `{healthURL, localPort, source}` or null. Never invents a port.
   */
  async captureHealthEvidence({ timeoutMs = null, inspected = null } = {}) {
    const budget = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : this.healthTimeoutMs;
    const deadline = Date.now() + budget;

    for (;;) {
      const fromFile = this.readHealthUrlFile();
      if (fromFile) {
        this.healthURL = fromFile.healthURL;
        this.localPort = fromFile.localPort;
        this._syncDelegateHealth();
        return fromFile;
      }
      if (Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, HEALTH_URL_POLL_INTERVAL_MS));
    }

    const fromInspection = healthEvidenceFromInspection(inspected);
    if (fromInspection) {
      this.healthURL = fromInspection.healthURL;
      this.localPort = fromInspection.localPort;
      this._syncDelegateHealth();
      return { ...fromInspection, healthUrlFile: this.healthUrlFile };
    }
    return null;
  }

  _healthFromRecord(record) {
    if (!record || typeof record !== 'object') return null;
    const evidence = normalizeHealthEndpoint(record.healthURL);
    if (evidence) return { ...evidence, source: 'instance-runtime-record' };
    return healthEvidenceFromInspection(record);
  }

  _syncDelegateHealth() {
    if (!this._delegate) return;
    this._delegate.healthURL = this.healthURL || null;
    this._delegate.probe = this.probe || null;
  }

  /** Adds the instance identity to a delegate process record and stores health evidence. */
  _mergeInstanceRecord(record, evidence, { operationId = null } = {}) {
    const nowIso = new Date().toISOString();
    const merged = {
      ...(record || {}),
      instanceId: this.instanceId,
      serviceId: this.service,
      service: this.service,
      profileId: this.profileId,
      profileName: this.profileName,
      profileYamlPath: this.configPath,
      healthUrlFile: this.healthUrlFile,
      updatedAt: nowIso
    };
    if (operationId) merged.operationId = operationId;
    if (evidence) {
      merged.healthURL = evidence.healthURL;
      merged.localPort = evidence.localPort;
      merged.healthSource = evidence.source || null;
      merged.healthCapturedAt = nowIso;
      this.healthURL = evidence.healthURL;
      this.localPort = evidence.localPort;
    } else if (merged.healthURL && !merged.localPort) {
      const existing = normalizeHealthEndpoint(merged.healthURL);
      merged.localPort = existing ? existing.localPort : null;
    }
    this._writeProcessRecord(merged);
    this._syncDelegateHealth();
    return merged;
  }

  /**
   * Instance launch template: own profile directory + own profile + ephemeral
   * loopback health listener + own health URL handshake file.
   */
  _buildInstanceTemplate(legacyTemplate, credential) {
    const base = legacyTemplate || {};
    const args = rewriteInstanceLaunchArgs(base.args, {
      profileDir: this.profileDir,
      profileName: this.profileName,
      healthUrlFile: this.healthUrlFile,
      listenAddr: INSTANCE_LISTEN_ADDR
    });

    // `...base` first: HTTP-transport fields (isHttp, httpPlan, serviceMcpEnv) and
    // any future legacy template field must survive the instance rewrite untouched.
    return {
      ...base,
      args,
      healthURL: this.healthURL || null,
      instanceId: this.instanceId,
      profileId: this.profileId,
      profileName: this.profileName,
      profileDir: this.profileDir,
      profileYamlPath: this.configPath,
      healthUrlFile: this.healthUrlFile,
      listenAddr: INSTANCE_LISTEN_ADDR,
      isolatedProfile: true
    };
  }

  _buildLaunchTemplate(credential) {
    const delegateBuilder = this._delegate._buildLaunchTemplate;
    const legacy = typeof delegateBuilder === 'function'
      ? delegateBuilder.call(this._delegate, credential)
      : { command: this.paths?.tunnelClientBin, args: ['run'] };
    return this._buildInstanceTemplate(legacy, credential);
  }

  _readCurrentConfigRecord() {
    return this._delegate._readCurrentConfigRecord();
  }

  _computeFingerprint(record, sealedPacketBytes = null) {
    return this._delegate._computeFingerprint(record, sealedPacketBytes);
  }

  /**
   * Same snapshot contract as `ServiceAdapter.prepare` (so switch-core
   * `assertVerifiedReceipt` / `assertRestoredReceipt` keep accepting it unchanged),
   * plus the additive instance fields the instance lifecycle/store records.
   */
  /**
   * Seeds this instance's profile YAML from the SERVICE's real (production) YAML.
   *
   * An instance owns its own profile file, so on a first start that file does not
   * exist yet. Generating it from scratch loses the service's `mcp.commands`
   * (e.g. antigravity needs its real python command, the DSH bridge its own
   * command) and the tunnel-client then fails to start the MCP subprocess, which
   * surfaces as VERIFY_FAILED. Copying the production YAML first keeps every
   * command/proxy setting intact; only control_plane is rewritten afterwards.
   */
  _sourceServiceConfigPath() {
    const stemByService = { 'overleaf-mcp': 'overleaf', 'antigravity-mcp': 'antigravity-local' };
    const stem = stemByService[this.service] || this.service;
    const appData = this.paths?.appData
      || process.env.APPDATA
      || path.join(this.paths?.userProfile || process.env.USERPROFILE || '', 'AppData', 'Roaming');
    const candidates = [
      path.join(appData, 'tunnel-client', `${stem}.yaml`),
      this.definition?.locations?.effectiveConfigPath || null
    ].filter(Boolean);
    for (const candidate of candidates) {
      try { if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate; } catch (_) {}
    }
    return null;
  }

  _ensureSeedConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const current = fs.readFileSync(this.configPath, 'utf8');
        // Already seeded (has an mcp block) — leave it alone.
        if (current.trim() && /(^|\r?\n)mcp:\s*(\r?\n|$)/.test(current)) return;
      }
      const source = this._sourceServiceConfigPath();
      if (!source) return;
      const raw = fs.readFileSync(source, 'utf8');
      if (!raw.trim()) return;
      fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
      fs.writeFileSync(this.configPath, raw, 'utf8');
    } catch (_) {
      // Seeding is best-effort: a failure here falls back to the generated default.
    }
  }

  async prepare({ operationId, credential, profileId = null, instanceId = null } = {}) {
    if (profileId !== null && profileId !== undefined && String(profileId) !== this.profileId) {
      throw new InstanceFault('INVALID_INSTANCE', 'prepare() was called for a different profile');
    }
    if (instanceId !== null && instanceId !== undefined && instanceId !== this.instanceId) {
      throw new InstanceFault('INVALID_INSTANCE', 'prepare() was called for a different instance');
    }
    this._syncDelegateHealth();
    this._ensureSeedConfig();
    const snapshot = await this._delegate.prepare({ operationId, credential, profileId: this.profileId });

    snapshot.profileId = this.profileId;
    snapshot.instanceId = this.instanceId;
    snapshot.serviceId = this.service;
    snapshot.healthUrlFile = this.healthUrlFile;
    snapshot.profileYamlPath = this.configPath;
    if (!snapshot.healthURL) snapshot.healthURL = this.healthURL || null;
    // The delegate's builder is already instance-rewritten (see constructor); only
    // rewrite again when it was supplied by something else entirely.
    if (snapshot.launchTemplate?.instanceId !== this.instanceId) {
      snapshot.launchTemplate = this._buildInstanceTemplate(snapshot.launchTemplate, snapshot.credential);
    }
    return snapshot;
  }

  /**
   * Writes this instance's own profile YAML (CAS-checked), stops only this
   * instance's previously owned process, launches, then reads the health handshake
   * back and records it on the instance runtime record.
   */
  async applyIfUnchanged({ operationId, snapshot } = {}) {
    this._syncDelegateHealth();
    this._clearStaleHealthUrlFile();

    const record = await this._delegate.applyIfUnchanged({ operationId, snapshot });
    const evidence = await this.captureHealthEvidence({ inspected: record });
    const merged = this._mergeInstanceRecord(record, evidence, { operationId });

    if (snapshot && typeof snapshot === 'object') {
      snapshot.identity = merged;
      snapshot.launchedAt = merged.launchedAt || merged.startedAt || new Date().toISOString();
      if (this.healthURL) snapshot.healthURL = this.healthURL;
      snapshot.localPort = this.localPort || null;
    }
    return merged;
  }

  async verifyDesired({ operationId, snapshot } = {}) {
    if (!this.healthURL) {
      const evidence = this.readHealthUrlFile() || this._healthFromRecord(this._readProcessRecord());
      if (evidence) {
        this.healthURL = evidence.healthURL;
        this.localPort = evidence.localPort;
      }
    }
    this._syncDelegateHealth();
    if (snapshot && typeof snapshot === 'object' && !snapshot.healthURL && this.healthURL) {
      snapshot.healthURL = this.healthURL;
    }
    const receipt = await this._delegate.verifyDesired({ operationId, snapshot });
    // The instance lifecycle persists healthURL/localPort from the receipt when the
    // snapshot does not carry them, so surface the per-instance values here.
    return {
      ...receipt,
      service: this.service,
      instanceId: this.instanceId,
      profileId: this.profileId,
      ...(this.healthURL ? { healthURL: this.healthURL } : {}),
      ...(this.localPort ? { localPort: this.localPort } : {})
    };
  }

  async restoreIfOwned({ operationId, snapshot, step } = {}) {
    this._syncDelegateHealth();
    const receipt = await this._delegate.restoreIfOwned({ operationId, snapshot, step });
    this.healthURL = null;
    this.localPort = null;
    this._syncDelegateHealth();
    return { ...receipt, service: this.service, instanceId: this.instanceId, profileId: this.profileId };
  }

  /**
   * Instance-scoped status. Reads ONLY this instance's runtime record and the
   * audited inspection of this instance's pid; never scans for foreign processes.
   */
  async inspect() {
    const recorded = this._readProcessRecord();

    let inspected = null;
    let inspectError = false;
    try {
      inspected = await this._requireProcessController().inspect(this.instanceId, { allowExternalScan: false });
    } catch {
      inspectError = true;
    }

    const live = Boolean(!inspectError && inspected && inspected.running === true &&
      Number.isSafeInteger(inspected.pid) && inspected.pid > 0);
    const owned = Boolean(live && recorded && recorded.pid === inspected.pid);

    let identityVerified = false;
    if (live && owned) {
      if (typeof this.processController.verify === 'function') {
        try {
          identityVerified = Boolean((await this.processController.verify(recorded))?.valid);
        } catch {
          identityVerified = false;
        }
      } else {
        // Same degradation rule as the legacy lifecycle: an ownership match on the
        // persisted record is the strongest evidence a verify-less controller gives.
        identityVerified = true;
      }
    }

    const recycledPid = Boolean(live && owned && !identityVerified);
    if (recycledPid) {
      this._clearProcessRecord();
      this._clearStaleHealthUrlFile();
    }

    const instanceLive = live && !recycledPid;
    const absenceVerified = Boolean(!inspectError && (inspected?.running === false || recycledPid));
    const externalProcessPresent = Boolean(instanceLive && !owned);

    let state = 'unobserved';
    if (instanceLive) state = (owned && identityVerified) ? 'running' : 'unmanaged';
    else if (absenceVerified) state = 'stopped';

    const health = this.readHealthUrlFile() ||
      healthEvidenceFromInspection(inspected) ||
      this._healthFromRecord(recorded);

    if (state === 'running' && health) {
      this.healthURL = health.healthURL;
      this.localPort = health.localPort;
      this._syncDelegateHealth();
    }

    return {
      instanceId: this.instanceId,
      serviceId: this.service,
      service: this.service,
      profileId: this.profileId,
      state,
      running: instanceLive,
      owned: instanceLive && owned,
      identityVerified: instanceLive && identityVerified,
      pid: instanceLive ? inspected.pid : null,
      startedAt: instanceLive ? (inspected.startedAt || inspected.startTime || recorded?.startedAt || null) : null,
      executablePath: instanceLive ? (inspected.executablePath || inspected.executable || recorded?.executablePath || null) : null,
      absenceVerified,
      externalProcessPresent,
      observedAt: inspectError ? 0 : Date.now(),
      healthURL: instanceLive && health ? health.healthURL : null,
      localPort: instanceLive && health ? health.localPort : null,
      healthUrlFile: this.healthUrlFile,
      profileYamlPath: this.configPath,
      processPath: this.processPath,
      operationId: recorded?.operationId || null
    };
  }

  /**
   * Stops ONLY this instance's verified owned process. `instanceId` (when given)
   * must be this instance — a sibling instance can never be targeted from here.
   */
  async stopConnection({ operationId, serviceId, instanceId, originalRuntime } = {}) {
    if (instanceId !== undefined && instanceId !== null && instanceId !== this.instanceId) {
      throw new InstanceFault('INVALID_INSTANCE', 'stopConnection() was called for a different instance');
    }
    if (serviceId !== undefined && serviceId !== null && serviceId !== this.service) {
      throw new SwitchFault('SERVICE_MISMATCH');
    }

    const recorded = this._readProcessRecord();
    if (recorded?.instanceId && recorded.instanceId !== this.instanceId) {
      // Never stop a record that belongs to another instance, even if it landed here.
      throw new SwitchFault('PROCESS_IDENTITY_MISMATCH');
    }

    const receipt = await this._delegate.stopConnection({
      operationId,
      serviceId: this.service,
      originalRuntime
    });

    this._clearStaleHealthUrlFile();
    this.healthURL = null;
    this.localPort = null;
    this._syncDelegateHealth();

    return {
      ...receipt,
      service: this.service,
      profileId: this.profileId,
      instanceId: this.instanceId
    };
  }

  async describe() {
    const described = await this._delegate.describe();
    return {
      ...described,
      service: this.service,
      instanceId: this.instanceId,
      profileId: this.profileId,
      instanceScoped: true,
      profileYamlPath: this.configPath,
      localPort: this.localPort || null
    };
  }
}

/**
 * Factory: one isolated tunnel-client adapter per (service, profile) instance.
 *
 * @param {object} options
 * @param {string} options.serviceId
 * @param {string} options.profileId
 * @param {object|null} [options.definition]
 * @param {string} options.dataDir            isolated data dir (never the production one)
 * @param {object} [options.paths]
 * @param {object} [options.probe]
 * @param {object|null} [options.vault]
 * @param {object} [options.processController]
 * @param {string|null} [options.healthURL]
 * @param {number} [options.healthTimeoutMs]
 * @param {Function} [options.runtimeCommand] test hook for a fake process runtime
 * @param {string} [options.scriptPath]       audited helper override
 */
export function createInstanceAdapter(options = {}) {
  const {
    serviceId,
    profileId,
    definition = null,
    dataDir,
    paths = {},
    probe,
    vault = null,
    processController = null,
    healthURL = null,
    healthTimeoutMs = null,
    runtimeCommand,
    scriptPath = null
  } = options || {};

  const target = assertInstanceTarget({ serviceId, profileId });
  const resolvedDataDir = assertIsolatedInstanceDataDir(dataDir);
  const resolvedPaths = resolveInstancePaths({ paths });

  const baseController = processController || createDefaultProcessController({
    dataDir: resolvedDataDir,
    scriptPath: scriptPath || PROCESS_CONTROL_SCRIPT,
    runtimeCommand,
    paths: resolvedPaths
  });

  return new InstanceAdapter({
    serviceId: target.serviceId,
    profileId: target.profileId,
    definition,
    dataDir: resolvedDataDir,
    paths: resolvedPaths,
    probe: probe !== undefined ? probe : defaultTunnelProbe,
    vault,
    processController: baseController,
    healthURL,
    healthTimeoutMs
  });
}

function resolveDefinition(definitions, serviceId, op) {
  if (Array.isArray(definitions)) {
    const hit = definitions.find(entry => entry && entry.id === serviceId);
    if (hit) return hit;
  } else if (definitions && typeof definitions === 'object') {
    const hit = definitions[serviceId];
    if (hit) return hit;
  }
  const fromSnapshot = op?.registrySnapshot?.services;
  if (Array.isArray(fromSnapshot)) {
    const hit = fromSnapshot.find(entry => entry && entry.id === serviceId);
    if (hit) return hit;
  }
  return null;
}

/**
 * Adapter provider for concurrent instances.
 *
 *   const provider = createInstanceAdapterProvider({ dataDir, vault, definitions });
 *   const adapter = await provider(op, serviceId, profileId);   // cached by instanceId
 *   provider.release(instanceId);
 *   provider.clear();
 */
export function createInstanceAdapterProvider(options = {}) {
  const {
    dataDir,
    vault = null,
    definitions = null,
    processController = null,
    probe,
    paths = {},
    healthURLs = null,
    healthURL = null,
    runtimeCommand,
    scriptPath = null,
    resolveDefinition: resolveDefinitionFn = null
  } = options || {};

  const resolvedDataDir = assertIsolatedInstanceDataDir(dataDir);
  const resolvedPaths = resolveInstancePaths({ paths });
  const resolvedProbe = probe !== undefined ? probe : defaultTunnelProbe;

  const baseController = processController || createDefaultProcessController({
    dataDir: resolvedDataDir,
    scriptPath: scriptPath || PROCESS_CONTROL_SCRIPT,
    runtimeCommand,
    paths: resolvedPaths
  });

  const cache = new Map();
  const maxEntries = Number.isSafeInteger(options.maxEntries) && options.maxEntries > 0
    ? options.maxEntries : 64;
  const cacheStats = { hits: 0, misses: 0, evictions: 0, releases: 0 };

  const provider = async (op, serviceId, profileId) => {
    if (!isMcpServiceId(serviceId)) throw new InstanceFault('INVALID_SERVICE');
    const target = assertInstanceTarget({ serviceId, profileId });

    const cached = cache.get(target.instanceId);
    if (cached) { cacheStats.hits += 1; return cached; }
    cacheStats.misses += 1;

    // Definition resolution order: the async resolver (live store) first, then the
    // static map / operation snapshot. Without a definition an HTTP service looks
    // like stdio, which made tunnel-client refuse to start (missing --mcp.server-url).
    let definition = resolveDefinition(definitions, target.serviceId, op);
    if (!definition && typeof resolveDefinitionFn === 'function') {
      try { definition = await resolveDefinitionFn(target.serviceId); } catch (_) { definition = null; }
    }

    const adapter = createInstanceAdapter({
      serviceId: target.serviceId,
      profileId: target.profileId,
      definition,
      dataDir: resolvedDataDir,
      paths: resolvedPaths,
      probe: resolvedProbe,
      vault,
      processController: baseController,
      healthURL: (healthURLs && healthURLs[target.instanceId]) || healthURL || null
    });

    // Bounded cache for non-runner entry points: an unbounded map of instance
    // adapters is a slow leak for long-lived consoles. Eviction drops a cached
    // OBJECT only; it never stops a process and never rewrites runtime state.
    while (cache.size >= maxEntries) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
      cacheStats.evictions += 1;
    }
    cache.set(target.instanceId, adapter);
    return adapter;
  };

  provider.release = (instanceId) => {
    if (!instanceId) return;
    if (cache.delete(instanceId)) cacheStats.releases += 1;
  };

  provider.clear = () => {
    cache.clear();
  };

  provider.has = (instanceId) => cache.has(instanceId);

  provider.stats = () => ({ ...cacheStats, size: cache.size, maxEntries });

  Object.defineProperty(provider, 'size', {
    get: () => cache.size,
    enumerable: true
  });

  provider.options = Object.freeze({ ...options });
  provider.dataDir = resolvedDataDir;
  provider.paths = resolvedPaths;
  provider.vault = vault;
  provider.processController = baseController;
  provider.instanceProfileDir = instanceProfileDirPath(resolvedDataDir);

  return provider;
}

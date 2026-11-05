import { ConfigStore } from './config-store.js';
import { SecretStore } from './secret-store.js';
import { ProfileGenerator } from './profile-generator.js';
import { type TunnelRuntime } from './tunnel-runtime.js';
import { type ControlLogger } from './process-tunnel-runtime.js';
import { type ExistingRuntimeDiscovery } from './discover.js';
import type { DoctorStep, RuntimeConfig, RuntimeSnapshot, TunnelRuntimeStatus } from './types.js';
export interface RuntimeManagerOptions {
    dshHome: string;
    bridge: {
        url: string;
        token: string;
        authMode: 'token' | 'none';
    };
    logger?: ControlLogger;
    /** Injectable runtime backend (tests inject FakeTunnelRuntime). */
    createRuntime?: () => TunnelRuntime;
    pollIntervalMs?: number;
    /** How long start() waits for tunnel ready before failing. */
    readyTimeoutMs?: number;
    now?: () => number;
    /** Injectable existing-install discovery (tests isolate APPDATA / PATH). */
    discover?: () => ExistingRuntimeDiscovery;
}
export interface OverallDerivationInput {
    bridge: RuntimeSnapshot['bridge'];
    tunnel: RuntimeSnapshot['tunnel'];
    openai: RuntimeSnapshot['openai']['status'];
}
/**
 * Composite overall state machine. Rules (documented + matrix-tested):
 *  - tunnel error             -> overall error
 *  - tunnel not installed     -> overall degraded
 *  - tunnel starting/stoping  -> overall degraded
 *  - tunnel ready + bridge running:
 *      openai connected     -> overall ready   (the ONLY ready path)
 *      openai unauthorized  -> overall degraded
 *      openai unreachable   -> overall degraded
 *      openai unknown       -> overall degraded
 *      openai error         -> overall error
 *  - tunnel process running  -> overall degraded
 *  - otherwise               -> overall stopped
 */
export declare function deriveOverallStatus(input: OverallDerivationInput): {
    status: RuntimeSnapshot['overall']['status'];
    lastError?: RuntimeSnapshot['lastError'];
};
/**
 * Lifecycle/ownership error codes that must stay latched. While such an
 * error is pending AND the manager still holds an owned runtime handle it
 * could not safely converge, ordinary refresh()/polling — which only proves
 * the runtime is alive/ready — must never restore overall to ready. Only an
 * explicit resolution (confirmed stop, confirmed cleanup, successful fresh
 * start) clears the latch. These are the real RuntimeError codes emitted by
 * ProcessTunnelRuntime / ProcessIdentity; no synthetic codes are introduced.
 */
export declare const LATCHED_LIFECYCLE_ERROR_CODES: readonly ["stale-process-identity", "start-time-mismatch", "unknown-start-time", "tunnel-stop-timeout"];
/** True when the given error is one of the latched lifecycle/ownership codes. */
export declare function isLatchedLifecycleError(error: {
    code: string;
} | undefined): boolean;
/**
 * Trustworthy "the owned runtime is confirmed gone" evidence, from a status
 * probe that SUCCEEDED. A thrown probe is NOT evidence — callers must never
 * pass a synthetic/unknown status here. `processRunning=true` always means
 * the runtime is (or may be) alive, so confirmed-gone requires
 * `processRunning=false` PLUS an explicit stopped/exited marker from the
 * backend: `status=stopped` or `lastError.code=unexpected-exit` (the real
 * codes emitted by ProcessTunnelRuntime.status()). Anything else — including
 * a bare `status=error` without exit evidence — is "unknown", not "gone".
 */
export declare function confirmsRuntimeGone(status: TunnelRuntimeStatus): boolean;
export declare class RuntimeManager {
    readonly configStore: ConfigStore;
    readonly secretStore: SecretStore;
    readonly profileGenerator: ProfileGenerator;
    private readonly dshHome;
    private readonly bridgeUrl;
    private readonly bridgeToken;
    private readonly logger;
    private readonly runtime;
    private readonly pollIntervalMs;
    private readonly readyTimeoutMs;
    private readonly now;
    private snapshot;
    private handle;
    private pendingError;
    private tail;
    private pollTimer;
    private autoStartTimer;
    private started;
    private cachedDetection;
    private cachedControlPlane;
    private cachedDiscovery;
    private readonly discoverFn?;
    constructor(options: RuntimeManagerOptions);
    /** Begin the poller and (when configured) schedule auto-start. */
    activate(): void;
    /** The current composite snapshot (the single status authority's view). */
    getSnapshot(): RuntimeSnapshot;
    getConfig(): RuntimeConfig;
    /**
     * Non-secret hints from an already-installed tunnel-client / official
     * profile / env proxy. Never reads secret values onto the result.
     */
    getDiscovery(): ExistingRuntimeDiscovery;
    /** Cached tunnel-client detection (for the config/status surfaces). */
    getDetection(): Promise<Awaited<ReturnType<TunnelRuntime['detect']>>>;
    /** Persist non-secret config; serialized with mutations. */
    saveConfig(patch: Partial<RuntimeConfig>): Promise<RuntimeConfig>;
    start(): Promise<RuntimeSnapshot>;
    stop(): Promise<RuntimeSnapshot>;
    restart(): Promise<RuntimeSnapshot>;
    /** Run layered diagnostics against current state. */
    diagnostics(): Promise<{
        ok: boolean;
        steps: DoctorStep[];
    }>;
    /** Stop the owned runtime and release the poller. Called on DSH unload. */
    dispose(): Promise<void>;
    private startInternal;
    private stopInternal;
    /**
     * Stop the owned runtime and release ownership ONLY after shutdown is
     * confirmed. This is the single ownership gate for failed-start cleanup.
     * If stop() throws, the process may still be alive: the handle is retained
     * and the error propagates (fail closed) so callers surface it and never
     * pretend the runtime is gone.
     */
    private safeStopHandle;
    private waitForReady;
    private detectWithCache;
    /**
     * True while an unresolved lifecycle/ownership error is latched: the
     * manager still holds a handle whose shutdown/identity was never confirmed.
     * Health/readiness probing can never resolve this — see refresh().
     */
    private hasUnresolvedLifecycleError;
    /** Refresh the composite snapshot from real probes. */
    refresh(): Promise<void>;
    /**
     * The single Control Plane probe shared by the status refresh and
     * diagnostics (force=true bypasses the TTL cache). Proxy settings come ONLY
     * from user config (cfg.tunnel.proxy): an enabled proxy is authoritative
     * (fail closed — never a silent fallback to direct). The result carries only
     * redacted host:port provenance; secrets never enter it or the logs.
     */
    private controlPlaneStatus;
    private setTunnel;
    private recordError;
    /**
     * Drop the last error once a mutation explicitly resolves the previous
     * failure: confirmed stop, confirmed cleanup, or a successful fresh start.
     * Never invoked from refresh()/polling — health/readiness cannot clear a
     * latched lifecycle/ownership error.
     */
    private clearError;
    private effectiveEndpoint;
    /**
     * Read-only observation of a tunnel-client this plugin did not start.
     * Never takes ownership: Stop will not kill the process.
     */
    private observeExternalTunnel;
    private resolveProxy;
    /**
     * Build the fully-expanded launch config shared by start and doctor. Throws
     * a RuntimeError when required runtime prerequisites are missing (key,
     * tunnel id, proxy validity), so callers can map the failure instead of
     * passing a half-built config to the backend.
     */
    private buildLaunchConfig;
    private initialSnapshot;
    private enqueue;
}

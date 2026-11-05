/**
 * FakeTunnelRuntime: a scriptable stand-in for tunnel-client.
 *
 * Used to develop and test the entire control plane (ConfigStore, SecretStore,
 * RuntimeManager, routes, UI, concurrency, state machine, error surfaces)
 * without a real tunnel-client binary or OpenAI credentials. It is NOT a
 * stand-in for real acceptance: the final report keeps "Phase 0" results
 * separate from fake-based tests.
 */
import { randomUUID } from 'node:crypto';
import { RuntimeError } from './tunnel-runtime.js';
const DEFAULT_SCRIPT = {
    installed: true,
    version: '0.0.11-fake',
    startResult: 'success',
    healthOk: true,
    readyOk: true,
    doctorOk: true,
};
export class FakeTunnelRuntime {
    script;
    now;
    handle;
    disposed = false;
    startedAtMs;
    startCount = 0;
    stopCount = 0;
    statusCount = 0;
    statusError;
    constructor(options = {}) {
        this.script = { ...DEFAULT_SCRIPT, ...(options.script ?? {}) };
        this.now = options.now ?? (() => Date.now());
    }
    /** Replace the script at runtime (test hook). */
    setScript(script) {
        this.script = { ...this.script, ...script };
    }
    /**
     * Make status() throw the given error until cleared with `undefined`.
     * A failed probe must NOT stop the fake runtime: query failure is "unknown",
     * never "exited" (the same contract ProcessTunnelRuntime follows).
     */
    setStatusError(error) {
        this.statusError = error;
    }
    get activeHandle() {
        return this.handle;
    }
    ownedHandle() {
        return this.handle;
    }
    /** Whether the fake believes it currently owns a live runtime. */
    get active() {
        return this.handle !== undefined;
    }
    /** Number of times start() was requested (restart/auto-start assertions). */
    get startCalls() {
        return this.startCount;
    }
    /** Number of times stop() was attempted, including failed attempts. */
    get stopCalls() {
        return this.stopCount;
    }
    /** Number of times status() was called (probe-failure tests). */
    get statusCalls() {
        return this.statusCount;
    }
    async detect() {
        if (this.script.detectError !== undefined) {
            return { installed: false, error: this.script.detectError };
        }
        return {
            installed: this.script.installed === true,
            ...(this.script.installed === true
                ? { executablePath: 'fake-tunnel-client', version: this.script.version ?? '0.0.11-fake' }
                : {}),
        };
    }
    async start(config) {
        this.startCount += 1;
        if (this.script.startResult === 'failure') {
            if (this.script.retainHandleOnStartFailure === true) {
                this.startedAtMs = this.now();
                this.handle = new FakeHandle({
                    pid: 41000 + Math.floor(Math.random() * 1000),
                    startedAt: new Date(this.startedAtMs).toISOString(),
                    executablePath: 'fake-tunnel-client',
                    runtimeInstanceId: randomUUID(),
                    profileName: config.profileName,
                    tunnelId: config.tunnelId,
                }, this);
            }
            const err = this.script.startError ?? { code: 'fake-start-failed', message: 'fake start failure' };
            throw new RuntimeError(err.code, err.message, 'tunnel');
        }
        this.startedAtMs = this.now();
        const handle = new FakeHandle({
            pid: 41000 + Math.floor(Math.random() * 1000),
            startedAt: new Date(this.startedAtMs).toISOString(),
            executablePath: 'fake-tunnel-client',
            runtimeInstanceId: randomUUID(),
            profileName: config.profileName,
            tunnelId: config.tunnelId,
        }, this);
        this.handle = handle;
        return handle;
    }
    async stop(handle) {
        this.stopCount += 1;
        if (this.script.staleIdentity === true) {
            throw new RuntimeError('stale-process-identity', 'process identity no longer matches recorded identity', 'tunnel');
        }
        const stopError = this.script.stopError;
        if (stopError !== undefined) {
            throw new RuntimeError(stopError.code, stopError.message, 'tunnel');
        }
        const hang = this.script.stopHangMs ?? 0;
        if (hang > 0) {
            await new Promise((resolve) => setTimeout(resolve, hang));
        }
        if (this.handle === handle) {
            this.handle = undefined;
            this.startedAtMs = undefined;
        }
    }
    async status(handle) {
        this.statusCount += 1;
        if (this.statusError !== undefined) {
            // Query failure is "unknown", never "exited": the owned runtime stays
            // active until a later successful probe says otherwise.
            throw this.statusError;
        }
        const active = handle ?? this.handle;
        if (active === undefined) {
            return {
                status: 'stopped',
                processRunning: false,
                healthy: false,
                ready: false,
            };
        }
        const exited = this.script.exitAfterMs !== undefined && this.startedAtMs !== undefined
            && this.now() - this.startedAtMs >= this.script.exitAfterMs;
        if (exited) {
            this.handle = undefined;
            return {
                status: 'error',
                processRunning: false,
                healthy: false,
                ready: false,
                lastError: { code: 'unexpected-exit', message: 'tunnel-client exited unexpectedly' },
            };
        }
        if (this.script.stopped === true) {
            // Confirmed stopped: the backend no longer owns a runtime.
            this.handle = undefined;
            this.startedAtMs = undefined;
            return {
                status: 'stopped',
                processRunning: false,
                healthy: false,
                ready: false,
            };
        }
        return {
            status: 'running',
            processRunning: true,
            healthy: this.script.healthOk === true,
            ready: this.script.readyOk === true,
            pid: active.identity.pid,
            healthUrl: 'http://127.0.0.1:0',
            ...(this.script.healthOk === true ? {} : { lastError: { code: 'health-failed', message: 'fake health failed' } }),
        };
    }
    async doctor(config) {
        const steps = this.script.doctorSteps ?? [
            { id: 'binary', ok: true, detail: 'fake-tunnel-client' },
            { id: 'bridge', ok: true, detail: config.bridgeUrl },
            { id: 'profile', ok: true },
            { id: 'key', ok: this.script.doctorOk === true },
        ];
        return { ok: this.script.doctorOk !== false, steps };
    }
    async dispose() {
        this.disposed = true;
        this.handle = undefined;
        this.startedAtMs = undefined;
    }
}
/** Handle returned by FakeTunnelRuntime. */
class FakeHandle {
    kind = 'fake';
    identity;
    owner;
    constructor(identity, owner) {
        this.identity = identity;
        this.owner = owner;
    }
}

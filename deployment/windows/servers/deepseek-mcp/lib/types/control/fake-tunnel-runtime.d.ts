import type { TunnelDetectionResult, TunnelDoctorResult, TunnelLaunchConfig, TunnelRuntimeHandle, TunnelRuntimeStatus } from './types.js';
import type { TunnelRuntime } from './tunnel-runtime.js';
/** Scriptable behaviors a test can configure. */
export interface FakeTunnelScript {
    installed?: boolean;
    version?: string;
    detectError?: string;
    /** start() outcome. */
    startResult?: 'success' | 'failure';
    /** start() failure code/message. */
    startError?: {
        code: string;
        message: string;
    };
    /** When start() fails, still retain an owned handle (spawn-then-fail). */
    retainHandleOnStartFailure?: boolean;
    /** health probe result after start. */
    healthOk?: boolean;
    /** ready probe result after start. */
    readyOk?: boolean;
    /** Simulate an unexpected exit this many ms after start (0 = immediate). */
    exitAfterMs?: number;
    /** status() reports a confirmed stopped runtime (process confirmed gone). */
    stopped?: boolean;
    /** stop() hangs for this many ms (simulates stop timeout). */
    stopHangMs?: number;
    /** stop() reports a stale identity (refuses to stop). */
    staleIdentity?: boolean;
    /** stop() throws a structured RuntimeError with this code/message. */
    stopError?: {
        code: string;
        message: string;
    };
    /** doctor steps. */
    doctorOk?: boolean;
    doctorSteps?: {
        id: string;
        ok: boolean;
        detail?: string;
        code?: string;
    }[];
}
export declare class FakeTunnelRuntime implements TunnelRuntime {
    private script;
    private readonly now;
    private handle;
    private disposed;
    private startedAtMs;
    private startCount;
    private stopCount;
    private statusCount;
    private statusError;
    constructor(options?: {
        script?: FakeTunnelScript;
        now?: () => number;
    });
    /** Replace the script at runtime (test hook). */
    setScript(script: Partial<FakeTunnelScript>): void;
    /**
     * Make status() throw the given error until cleared with `undefined`.
     * A failed probe must NOT stop the fake runtime: query failure is "unknown",
     * never "exited" (the same contract ProcessTunnelRuntime follows).
     */
    setStatusError(error: Error | undefined): void;
    get activeHandle(): FakeHandle | undefined;
    ownedHandle(): TunnelRuntimeHandle | undefined;
    /** Whether the fake believes it currently owns a live runtime. */
    get active(): boolean;
    /** Number of times start() was requested (restart/auto-start assertions). */
    get startCalls(): number;
    /** Number of times stop() was attempted, including failed attempts. */
    get stopCalls(): number;
    /** Number of times status() was called (probe-failure tests). */
    get statusCalls(): number;
    detect(): Promise<TunnelDetectionResult>;
    start(config: TunnelLaunchConfig): Promise<TunnelRuntimeHandle>;
    stop(handle: TunnelRuntimeHandle): Promise<void>;
    status(handle?: TunnelRuntimeHandle): Promise<TunnelRuntimeStatus>;
    doctor(config: TunnelLaunchConfig): Promise<TunnelDoctorResult>;
    dispose(): Promise<void>;
}
/** Handle returned by FakeTunnelRuntime. */
declare class FakeHandle implements TunnelRuntimeHandle {
    readonly kind: "fake";
    readonly identity: import('./types.js').ProcessIdentity;
    private readonly owner;
    constructor(identity: import('./types.js').ProcessIdentity, owner: FakeTunnelRuntime);
}
export {};

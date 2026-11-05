import type { ProcessIdentity } from './types.js';
/**
 * Tolerance when comparing the recorded start time (set at launch) against the
 * live process start time. Covers clock/precision skew between the plugin's
 * clock and the OS-reported process start time without weakening PID-reuse
 * detection (a re-used PID starts seconds/minutes later).
 */
export declare const START_TIME_TOLERANCE_MS = 2000;
/** Probe whether a pid currently exists (signal 0 does not deliver a signal). */
export declare function isProcessAlive(pid: number): boolean;
/**
 * Best-effort read of another process's executable path. Returns undefined when
 * the process does not exist or the path cannot be determined. Structured
 * spawn only; the pid is validated numeric, so no shell is ever involved.
 */
export declare function processExecutablePath(pid: number): string | undefined;
/**
 * Best-effort read of another process's actual start time (epoch ms).
 * Windows queries `Get-Process ... StartTime` via PowerShell (structured
 * spawn, pid validated numeric, no shell). POSIX reads the `starttime` field
 * from /proc plus the boot time. Returns undefined when the process does not
 * exist or the start time cannot be determined.
 */
export declare function processStartTimeMs(pid: number): number | undefined;
/** Create a fresh identity for a process the plugin just launched. */
export declare function createProcessIdentity(options: {
    pid: number;
    executablePath: string;
    /** Optional recorded start time (ISO); defaults to the current time. */
    startedAt?: string;
    profileName?: string;
    tunnelId?: string;
}): ProcessIdentity;
/** Injectable probes so verification can be tested without real processes. */
export interface ProcessIdentityProbes {
    isAlive?: (pid: number) => boolean;
    executablePath?: (pid: number) => string | undefined;
    startTimeMs?: (pid: number) => number | undefined;
}
export interface IdentityVerification {
    ok: boolean;
    code: 'verified' | 'not-alive' | 'executable-mismatch' | 'start-time-mismatch' | 'unknown-executable' | 'unknown-start-time';
}
/**
 * Verify a live process still matches the identity the plugin recorded at
 * launch. A mismatch — path, start time, or an unreadable probe — is treated
 * as "not ours": callers must refuse to terminate in that case
 * (stale-process-identity). An unknown start time also fails closed: the
 * plugin cannot confirm the process is the one it launched.
 */
export declare function verifyProcessIdentity(identity: ProcessIdentity, probes?: ProcessIdentityProbes): IdentityVerification;

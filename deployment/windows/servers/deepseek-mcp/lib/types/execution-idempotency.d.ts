export interface ExecutionEvidence {
    evidenceId: string;
    fingerprint: string;
    kind: string;
    timestamp: number;
    status: 'passed' | 'applied' | 'verified';
    summary?: string;
    details?: Record<string, unknown>;
    sessionIds?: string[];
    workspacePath?: string;
}
export interface IdempotencyCheckResult {
    isIdempotent: boolean;
    code: 'SKIPPED_ALREADY_VERIFIED' | 'SKIPPED_ALREADY_APPLIED';
    evidenceId: string;
    message: string;
    details?: Record<string, unknown>;
}
/** High-cost / side-effecting step kind used as the idempotency cache key. */
export declare function idempotencyKindFor(toolName: string, command?: string): string | undefined;
export declare function isVerifiedKind(kind: string): boolean;
export declare const DEFAULT_EVIDENCE_CACHE_CAP = 1024;
export declare class ExecutionIdempotencyManager {
    private readonly evidenceCache;
    private readonly cap;
    constructor(cap?: number);
    /**
     * Generate a stable execution fingerprint for an operation.
     */
    computeFingerprint(input: {
        kind: string;
        command?: string;
        workspacePath: string;
        headSha?: string;
        extra?: Record<string, unknown>;
    }): string;
    /**
     * Record a verified successful execution into the idempotency cache.
     */
    recordSuccess(fingerprint: string, input: {
        kind: string;
        status?: 'passed' | 'applied' | 'verified';
        summary?: string;
        details?: Record<string, unknown>;
        sessionId?: string;
        workspacePath?: string;
    }): ExecutionEvidence;
    /**
     * Check if an identical operation has already succeeded with valid evidence.
     */
    check(fingerprint: string, scope?: {
        sessionId?: string;
        workspacePath?: string;
    }): IdempotencyCheckResult | null;
    /** Drop cached evidence for a kind so an explicit rerun can execute again. */
    invalidateKind(kind: string): number;
    listEvidence(filter?: {
        sessionId?: string;
        workspacePath?: string;
    }): ExecutionEvidence[];
    clear(): void;
}

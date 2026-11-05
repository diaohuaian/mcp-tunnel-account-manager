import type { GoalRecord } from './goal-control.js';
import type { BridgeStatus } from './status.js';
import { type LooseEvent, type ToolFact } from './goal-facts.js';
export interface ResultSchema {
    status: BridgeStatus;
    goal: {
        goal_id: string;
        revision: number;
        workspace: string;
        started_at?: string;
        finished_at?: string;
        card: string;
        revision_history_folded: boolean;
        revision_history: Array<{
            revision: number;
            previous_revision?: number;
            revision_reason: string;
            created_at: string;
        }>;
    };
    tests: {
        total: number;
        pass: number;
        fail: number;
        skip: number;
        suites: string[];
        evidence_ids: string[];
    };
    changes: {
        changed_files: string[];
        commits: string[];
        tags: string[];
        working_tree?: string;
    };
    artifacts: Array<{
        path: string;
        name?: string;
        hash?: string;
        size?: number;
    }>;
    remote: {
        push_verified?: boolean;
        npm_verified?: boolean;
        github_verified?: boolean;
        details?: string;
    };
    security: {
        secret_leak_check: boolean;
        credential_refs: string[];
        approval_summary?: Record<string, unknown>;
    };
    warnings: string[];
    provenance: {
        session_id: string;
        goal_id: string;
        originating_step?: string;
    };
}
export interface CredentialStatus {
    credentialAvailable: boolean;
    credentialRef: string;
    credentialSource: 'env' | 'credentials_store' | 'runtime' | 'none';
}
export declare function extractCommitShas(text: string): string[];
export declare function extractTagNames(command?: string, resultText?: string): string[];
export declare function extractArtifacts(tools: readonly ToolFact[]): ResultSchema['artifacts'];
/** Inspect availability of provider credentials without returning secret values. */
export declare function inspectCredentials(input: {
    env?: Record<string, string | undefined>;
    dshHome?: string;
    runtimeKeyConfigured?: boolean;
}): CredentialStatus[];
/** Construct standardized ResultSchema from goal record and session events. */
export declare function buildResultSchema(input: {
    sessionId: string;
    record?: GoalRecord;
    events?: readonly LooseEvent[];
    status: BridgeStatus;
    workspace: string;
    evidenceIds?: string[];
    warnings?: string[];
    credentialRefs?: string[];
    originatingStep?: string;
    approvalSummary?: Record<string, unknown>;
}): ResultSchema;

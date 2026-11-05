/**
 * Approval Policy v2: Risk-tiered auto-approval, capability grants,
 * and guaranteed reachable terminal states.
 */
import { type ActionClass } from './goal-constraints.js';
export type RiskLevel = 'L0' | 'L1' | 'L2' | 'L3';
export type ApprovalDecision = 'auto_approve' | 'require_human' | 'deny';
export interface UserApprovalPolicy {
    read?: 'auto' | 'ask';
    test?: 'auto' | 'ask';
    build?: 'auto' | 'ask';
    workspaceWrite?: 'auto' | 'ask';
    localCommit?: 'auto' | 'ask';
    externalWrite?: 'auto' | 'ask';
    gitPush?: 'auto' | 'ask';
    npmPublish?: 'auto' | 'ask';
    githubRelease?: 'auto' | 'ask';
    secrets?: 'deny' | 'ask';
    dangerFullAccess?: 'deny' | 'ask';
}
export declare const DEFAULT_APPROVAL_POLICY: UserApprovalPolicy;
export interface ApprovalEvaluation {
    level: RiskLevel;
    capability: ActionClass | 'danger-full-access' | 'system.destructive';
    decision: ApprovalDecision;
    reason: string;
}
export declare function evaluateApproval(toolName: string, command?: string, policy?: UserApprovalPolicy, context?: {
    externalWrite?: boolean;
}): ApprovalEvaluation;

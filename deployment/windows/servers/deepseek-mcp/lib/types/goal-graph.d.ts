/**
 * Lightweight, release-shaped dependency model. Not a general workflow engine.
 */
import type { BridgeStatus } from './status.js';
import { type ActionKind, type GoalFacts } from './goal-facts.js';
import { type ReconcileTodo } from './goal-reconcile.js';
export type StepStatus = 'pending' | 'ready' | 'in_progress' | 'waiting_for_user' | 'waiting_for_approval' | 'blocked' | 'deferred' | 'skipped' | 'completed' | 'failed' | 'cancelled';
export interface GoalStep {
    id: string;
    content: string;
    kind?: ActionKind;
    status: StepStatus;
    dependsOn: string[];
}
export interface GoalGraph {
    steps: GoalStep[];
    blocked_steps: string[];
    deferred_steps: string[];
    remaining_runnable_steps: string[];
}
export interface BlockedInfo {
    step: string;
    reason: string;
    resume_condition: string;
    scope: 'step' | 'goal';
    independent_steps_available: boolean;
}
export declare function parsePlanLines(plan: string): string[];
/** Kinds the user asked to defer when re-arming start_goal. */
export declare function detectDeferredKinds(goal: string, plan?: string): ActionKind[];
export interface GraphInput {
    todos?: ReconcileTodo[];
    plan?: string;
    facts: GoalFacts;
    deferredKinds?: ActionKind[];
    deferredStepIds?: string[];
    blockedKind?: ActionKind;
    blockedContent?: string;
    waitingStatus?: Extract<BridgeStatus, 'waiting_for_user' | 'waiting_for_approval'>;
}
export declare function inferBlockedKind(facts: GoalFacts, status: BridgeStatus): ActionKind | undefined;
export declare function slugStepId(content: string): string;
export declare function assignStableStepIds(items: {
    content: string;
    kind?: ActionKind;
}[]): string[];
/** Match a user-supplied step ref against id, kind, or content. */
export declare function resolveStepRefs(refs: readonly string[], steps: readonly GoalStep[]): {
    ids: string[];
    kinds: ActionKind[];
    contents: string[];
};
export declare function buildGoalGraph(input: GraphInput): GoalGraph;
export interface BlockedDescribeInput {
    status: BridgeStatus;
    facts: GoalFacts;
    graph: GoalGraph;
    approval?: {
        tool_name?: string;
        reason?: string;
    };
    question?: {
        question_id?: string;
    };
}
export declare function describeBlocked(input: BlockedDescribeInput): BlockedInfo | undefined;
export declare const KNOWN_ACTION_KINDS: Set<string>;
export declare function deferredKindsOf(deferredStepIds?: readonly string[]): ActionKind[];

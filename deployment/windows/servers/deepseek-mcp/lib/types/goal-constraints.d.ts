/**
 * Goal execution modes and structured constraints.
 * Constraints can only tighten DSH sandbox / approval, never raise them.
 */
import { type ActionKind, type GoalFacts, type ToolFact } from './goal-facts.js';
export type ExecutionMode = 'standard' | 'minimal' | 'strict';
export type ActionClass = 'filesystem.read' | 'filesystem.write' | 'filesystem.scan' | 'process.exec' | 'process.spawn' | 'git.read' | 'git.mutate' | 'npm.publish' | 'github.release' | 'network' | 'credentials.metadata' | 'workspace.read' | 'workspace.write' | 'temp.read' | 'temp.write' | 'external_path.read' | 'external_path.write';
export declare const ACTION_CLASSES: readonly ActionClass[];
export interface GoalConstraints {
    read_only?: boolean;
    allow_workspace_scan?: boolean;
    max_changed_files?: number;
    allowed_actions?: ActionClass[];
    forbidden_actions?: ActionClass[];
}
export interface ConstraintDecision {
    allow: boolean;
    reason?: string;
    action_class?: ActionClass;
    kind?: ActionKind;
}
export declare function hasShellControlOperator(command: string): boolean;
/** True only when the complete shell payload is one recognized test command. */
export declare function isCompleteTestCommand(command: string): boolean;
/** True only when the complete shell payload is one recognized build command. */
export declare function isCompleteBuildCommand(command: string): boolean;
export declare function parseExecutionMode(value: unknown): ExecutionMode;
export declare function defaultConstraintsForMode(mode: ExecutionMode): GoalConstraints;
/** Later values may only tighten. An omitted field does not relax an earlier one. */
export declare function mergeConstraints(base: GoalConstraints, extra?: GoalConstraints): GoalConstraints;
export declare function isWorkspaceScanCommand(command: string): boolean;
export declare function isWriteCommand(command: string): boolean;
export declare function classesForTool(toolName: string, command?: string): ActionClass[];
export declare function kindForTool(command?: string): ActionKind | undefined;
export interface EvaluateInput {
    constraints: GoalConstraints;
    completedKinds?: Iterable<ActionKind>;
    changedFileCount?: number;
    toolName: string;
    command?: string;
}
/**
 * Decide whether a tool call is allowed under Goal constraints.
 * Fail closed on violation. Missing constraints allow (DSH policy still applies).
 */
export declare function evaluateConstraint(input: EvaluateInput): ConstraintDecision;
export declare function countWorkspaceScans(facts: GoalFacts): number;
export declare function findConstraintViolation(facts: GoalFacts, constraints: GoalConstraints, completedBefore?: Iterable<ActionKind>, changedFileCount?: number): {
    fact: ToolFact;
    decision: ConstraintDecision;
} | undefined;
export declare function parseConstraints(value: unknown): GoalConstraints;
export declare function findPostHocViolation(facts: GoalFacts, constraints: GoalConstraints): {
    step: string;
    reason: string;
} | undefined;

import { type GoalFacts, type LooseEvent } from './goal-facts.js';
export type TempKind = 'worktree' | 'directory' | 'file';
export interface TempResource {
    path: string;
    kind: TempKind;
    session_id: string;
    goal_id: string;
    created_by_goal: true;
    temporary: true;
    seq: number;
}
export interface CleanupResult {
    removed: string[];
    warnings: string[];
}
export interface CleanupIo {
    exists(path: string): boolean;
    remove(path: string): void;
    removeWorktree?(path: string, workspacePath: string): void;
}
export declare function normalizeWorkspacePath(path: string): string;
/** Absolute path if `path` is inside `workspace` and is not the workspace root. */
export declare function resolveInsideWorkspace(path: string, workspace: string): string | undefined;
export declare function isTempPattern(path: string): boolean;
export declare function isSafeToDelete(resource: TempResource, workspace: string): boolean;
/** Reconstruct goal-owned temps from structured tool facts / write paths. */
export declare function discoverTempResources(input: {
    facts: GoalFacts;
    events?: readonly LooseEvent[];
    sessionId: string;
    goalId: string;
    workspacePath: string;
}): TempResource[];
/**
 * Delete only resources that pass the fail-safe checks.
 * Cleanup errors become warnings; they do not throw.
 */
export declare function cleanupTempResources(resources: readonly TempResource[], workspacePath: string, io?: CleanupIo): CleanupResult;

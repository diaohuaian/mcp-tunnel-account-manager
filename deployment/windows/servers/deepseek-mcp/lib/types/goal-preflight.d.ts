/**
 * Goal, Plan, and Constraints Preflight Validator.
 * Performs static checks before agent startup to detect contradictory goals
 * (e.g., Goal requires editing files, but constraints specify read_only).
 */
import type { ExecutionMode, GoalConstraints } from './goal-constraints.js';
export interface PreflightResult {
    valid: boolean;
    conflicts: string[];
    suggested_constraint_delta?: string[];
}
export declare function validateGoalPreflight(input: {
    goal: string;
    plan?: string;
    constraints?: GoalConstraints;
    mode?: ExecutionMode;
}): PreflightResult;

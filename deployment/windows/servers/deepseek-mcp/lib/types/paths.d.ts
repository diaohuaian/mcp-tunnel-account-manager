/**
 * Shared path comparison for workspace matching and containment checks.
 * Identity only — does not resolve relative segments.
 */
export declare function normalizePath(path: string): string;
export declare function pathsEqual(left: string, right: string): boolean;
/** Resolve a tool path against a workspace and prove it does not escape it. */
export declare function isPathInsideWorkspace(path: string, workspace: string): boolean;

/**
 * Fold a session event log into structured Goal facts.
 * Success is taken from tool/call arguments + tool/result, never from
 * assistant summary text.
 */
export type ActionKind = 'git_push' | 'git_tag' | 'npm_publish' | 'github_release' | 'git_worktree_add' | 'npm_pack' | 'unknown';
/** Minimal event shape so this module stays unit-testable without DSH types. */
export interface LooseEvent {
    type: string;
    seq: number;
    time?: number;
    data?: unknown;
}
export interface ToolFact {
    seq: number;
    callId: string;
    name: string;
    kinds: ActionKind[];
    ok: boolean;
    errorCode?: string;
    resultText?: string;
    command?: string;
    filePath?: string;
}
export interface GoalFacts {
    lastSeq?: number;
    todos?: {
        content: string;
        status: string;
    }[];
    tools: ToolFact[];
    lastTurnReason?: string;
}
export declare function parseArgsJson(raw: string): Record<string, unknown> | undefined;
export declare function extractCommand(args: Record<string, unknown>): string | undefined;
export declare function extractFilePath(args: Record<string, unknown>): string | undefined;
export declare function extractFilePaths(args: Record<string, unknown>): string[];
export declare function classifyCommand(command: string): ActionKind[];
export declare function tokenize(text: string): string[];
export declare function parseWorktreeAddPath(command: string): string | undefined;
export declare function parseMkdirPaths(command: string): string[];
/** Fold tool/call + tool/result + todo/write + turn/end into facts. */
export declare function foldGoalFacts(events: readonly LooseEvent[]): GoalFacts;
export declare function lastEventSeq(events: readonly LooseEvent[]): number | undefined;
/** True when a failed npm publish fact looks like a 2FA / OTP gate. */
export declare function factLooksLikeNpm2fa(fact: ToolFact): boolean;
export declare function successfulKinds(facts: GoalFacts): Set<ActionKind>;
export declare function commandForCall(events: readonly {
    type: string;
    data?: unknown;
}[] | undefined, callId?: string): string | undefined;
export declare function filePathsForCall(events: readonly {
    type: string;
    data?: unknown;
}[] | undefined, callId?: string): string[];
export declare function changedFileCountOf(events: readonly {
    type: string;
    data?: unknown;
}[] | undefined): number;

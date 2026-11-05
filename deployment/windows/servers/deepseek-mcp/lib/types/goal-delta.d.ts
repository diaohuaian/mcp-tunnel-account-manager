/**
 * Bounded polling delta over a session event sequence.
 * Stores only a cursor, never unbounded history.
 */
import type { ActionKind, GoalFacts, LooseEvent } from './goal-facts.js';
export declare const DELTA_EVENTS_MAX = 40;
export declare const POLL_CURSOR_CAP = 256;
export interface TodoChange {
    content: string;
    from: string;
    to: string;
}
export interface DeltaEvent {
    seq: number;
    type: string;
    name?: string;
    kind?: ActionKind;
    ok?: boolean;
}
export interface ProgressDelta {
    since_seq?: number;
    until_seq?: number;
    current_step?: string;
    status_changed: boolean;
    todos_changed: TodoChange[];
    new_events: DeltaEvent[];
    new_approvals: string[];
    new_questions: string[];
    new_changed_files: string[];
    agent_status_changed: boolean;
}
export interface PollCursor {
    seq: number;
    status: string;
    todos: {
        content: string;
        status: string;
    }[];
    files: string[];
    agentStatus?: string;
    approvalIds: string[];
    questionIds: string[];
}
export interface DeltaInput {
    events: readonly LooseEvent[];
    facts: GoalFacts;
    todos?: {
        content: string;
        status: string;
    }[];
    status: string;
    changedFiles: string[];
    agentStatus?: string;
    approvalIds: string[];
    questionIds: string[];
    previous?: PollCursor;
    currentStep?: string;
}
export declare function computeProgressDelta(input: DeltaInput): ProgressDelta;
export declare function nextPollCursor(input: DeltaInput): PollCursor;
/** FIFO-capped per-session poll cursors. */
export declare class PollCursorMap {
    private readonly items;
    private readonly cap;
    constructor(cap?: number);
    get(sessionId: string): PollCursor | undefined;
    set(sessionId: string, cursor: PollCursor): void;
}

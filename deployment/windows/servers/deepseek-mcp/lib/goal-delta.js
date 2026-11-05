import { classifyCommand, lastEventSeq, parseArgsJson, extractCommand } from './goal-facts.js';
export const DELTA_EVENTS_MAX = 40;
export const POLL_CURSOR_CAP = 256;
function asRecord(value) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        return value;
    }
    return undefined;
}
function summarizeEvent(event) {
    const data = asRecord(event.data);
    const out = { seq: event.seq, type: event.type };
    if (event.type === 'tool/call' && data !== undefined) {
        if (typeof data.name === 'string')
            out.name = data.name;
        const raw = typeof data.arguments === 'string' ? data.arguments : '';
        const args = raw === '' ? undefined : parseArgsJson(raw);
        const command = args === undefined ? undefined : extractCommand(args);
        const kinds = command === undefined ? [] : classifyCommand(command);
        const kind = kinds.find((item) => item !== 'unknown');
        if (kind !== undefined)
            out.kind = kind;
    }
    else if (event.type === 'tool/result' && data !== undefined) {
        const message = asRecord(data.message);
        const source = message === undefined ? undefined : asRecord(message.source);
        if (typeof source?.callId === 'string')
            out.name = source.callId;
        const isError = data.error !== undefined
            || (Array.isArray(message?.content) && message.content[0]?.isError === true);
        out.ok = !isError;
    }
    else if (event.type === 'todo/write') {
        out.name = 'todo';
    }
    return out;
}
function todoChanges(previous, current) {
    const prev = new Map((previous ?? []).map((todo) => [todo.content, todo.status]));
    const changes = [];
    for (const todo of current ?? []) {
        const from = prev.get(todo.content);
        if (from === undefined) {
            changes.push({ content: todo.content, from: '(none)', to: todo.status });
        }
        else if (from !== todo.status) {
            changes.push({ content: todo.content, from, to: todo.status });
        }
    }
    return changes;
}
export function computeProgressDelta(input) {
    const until = lastEventSeq(input.events);
    const since = input.previous?.seq;
    const newEvents = input.events
        .filter((event) => since === undefined || event.seq > since)
        .map(summarizeEvent);
    const capped = newEvents.length <= DELTA_EVENTS_MAX
        ? newEvents
        : newEvents.slice(newEvents.length - DELTA_EVENTS_MAX);
    const prevApprovals = new Set(input.previous?.approvalIds ?? []);
    const prevQuestions = new Set(input.previous?.questionIds ?? []);
    const prevFiles = new Set(input.previous?.files ?? []);
    return {
        ...(since === undefined ? {} : { since_seq: since }),
        ...(until === undefined ? {} : { until_seq: until }),
        ...(input.currentStep === undefined || input.currentStep === '' ? {} : { current_step: input.currentStep }),
        status_changed: input.previous !== undefined && input.previous.status !== input.status,
        todos_changed: todoChanges(input.previous?.todos, input.todos),
        new_events: capped,
        new_approvals: input.approvalIds.filter((id) => !prevApprovals.has(id)),
        new_questions: input.questionIds.filter((id) => !prevQuestions.has(id)),
        new_changed_files: input.changedFiles.filter((file) => !prevFiles.has(file)),
        agent_status_changed: input.previous !== undefined && input.previous.agentStatus !== input.agentStatus,
    };
}
export function nextPollCursor(input) {
    return {
        seq: lastEventSeq(input.events) ?? input.previous?.seq ?? -1,
        status: input.status,
        todos: (input.todos ?? []).map((todo) => ({ content: todo.content, status: todo.status })),
        files: [...input.changedFiles],
        ...(input.agentStatus === undefined ? {} : { agentStatus: input.agentStatus }),
        approvalIds: [...input.approvalIds],
        questionIds: [...input.questionIds],
    };
}
/** FIFO-capped per-session poll cursors. */
export class PollCursorMap {
    items = new Map();
    cap;
    constructor(cap = POLL_CURSOR_CAP) {
        this.cap = cap;
    }
    get(sessionId) {
        return this.items.get(sessionId);
    }
    set(sessionId, cursor) {
        if (this.items.has(sessionId))
            this.items.delete(sessionId);
        this.items.set(sessionId, cursor);
        while (this.items.size > this.cap) {
            const first = this.items.keys().next().value;
            if (first === undefined)
                break;
            this.items.delete(first);
        }
    }
}

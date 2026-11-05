/** The last turn that ended (or is still open), scanning from the tail. */
export function lastTurnSpan(events) {
    let open;
    let lastEnd;
    for (const event of events) {
        if (event.type === 'turn/start') {
            open = { turn: event.data.turn, startSeq: event.seq, endSeq: event.seq };
        }
        else if (event.type === 'turn/end' && open !== undefined && open.turn === event.data.turn) {
            open = { ...open, endSeq: event.seq, reason: event.data.reason };
            lastEnd = open;
            open = undefined;
        }
    }
    // An open turn is the most recent activity and must win: a consumer
    // polling a running task needs the in-flight turn, not the last completed
    // one. Only when no turn is open does the last ended turn count.
    return open ?? lastEnd;
}
/** Concatenated text content of assistant messages inside one turn. */
export function assistantTextForTurn(events, turn) {
    const parts = [];
    for (const event of events) {
        if (event.type !== 'assistant/message' || event.data.turn !== turn)
            continue;
        const text = event.data.message.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('');
        if (text !== '')
            parts.push(text);
    }
    return parts.join('\n');
}
/** Tool calls of one turn in call order, paired with their results. */
export function toolCallsForTurn(events, turn, maxItems) {
    const calls = new Map();
    const order = [];
    for (const event of events) {
        if (event.data === undefined)
            continue;
        const data = event.data;
        if (event.type === 'tool/call' && data.turn === turn) {
            const callId = data.callId;
            calls.set(callId, { callId, name: data.name, arguments: data.arguments });
            order.push(callId);
        }
        else if (event.type === 'tool/result' && data.turn === turn) {
            const callId = data.message?.source?.callId;
            if (callId !== undefined) {
                const call = calls.get(callId);
                if (call !== undefined) {
                    call.isError = data.message?.content?.[0]?.isError ?? false;
                    if (data.error !== undefined)
                        call.error = data.error;
                }
            }
        }
    }
    return order.slice(-maxItems).map((callId) => calls.get(callId));
}
/** Tool names whose arguments carry a file path and that mutate files. */
const EDIT_TOOL_NAMES = new Set([
    'write', 'edit', 'str_replace', 'insert', 'replace', 'apply_patch', 'str-replace-editor',
    'rename', 'move', 'delete', 'rm', 'cp', 'mv',
]);
const PATH_ARG_KEYS = ['file_path', 'path', 'filepath', 'old_path', 'new_path', 'src', 'dest', 'old_file', 'new_file'];
/** Files the turn's edit tools named, in first-seen order (data-driven from the log). */
export function changedFilesForTurn(events, turn) {
    const seen = new Set();
    const paths = [];
    for (const event of events) {
        if (event.type !== 'tool/call' || event.data.turn !== turn)
            continue;
        if (!EDIT_TOOL_NAMES.has(event.data.name))
            continue;
        let args;
        try {
            args = JSON.parse(event.data.arguments);
        }
        catch {
            continue;
        }
        if (args === null || typeof args !== 'object')
            continue;
        for (const key of PATH_ARG_KEYS) {
            const value = args[key];
            if (typeof value === 'string' && value !== '' && !seen.has(value)) {
                seen.add(value);
                paths.push(value);
            }
        }
    }
    return paths;
}
function truncate(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    return text.slice(0, maxChars) + '…[truncated]';
}
/** Recent user/assistant message rows, newest first, bounded by item/char budgets. */
export function summarizeMessages(events, maxItems, maxChars) {
    const rows = [];
    for (const event of events) {
        if (event.type === 'user/message') {
            const text = event.data.content
                .filter((block) => block.type === 'text')
                .map((block) => block.text)
                .join('');
            if (text !== '')
                rows.push({ seq: event.seq, time: new Date(event.time).toISOString(), role: 'user', text: truncate(text, maxChars) });
        }
        else if (event.type === 'assistant/message') {
            const text = event.data.message.content
                .filter((block) => block.type === 'text')
                .map((block) => block.text)
                .join('');
            if (text !== '')
                rows.push({ seq: event.seq, time: new Date(event.time).toISOString(), role: 'assistant', text: truncate(text, maxChars) });
        }
    }
    return rows.slice(-maxItems).reverse();
}
/** Last event timestamp (ms) or undefined for an empty log. */
export function lastEventTime(events) {
    const last = events[events.length - 1];
    return last === undefined ? undefined : new Date(last.time).toISOString();
}
/** The last todo/write snapshot, if any. */
export function lastTodos(events) {
    for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        if (event.type === 'todo/write')
            return event.data.todos.map((todo) => ({ content: todo.content, status: todo.status }));
    }
    return undefined;
}

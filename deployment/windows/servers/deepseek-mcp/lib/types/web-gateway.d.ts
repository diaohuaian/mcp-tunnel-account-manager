export interface MuxApproval {
    rpcId: string;
    sessionId: string;
    approvalId: string;
    toolName: string;
    callId?: string;
    reason?: string;
}
export interface MuxQuestion {
    rpcId: string;
    sessionId: string;
    questions: unknown[];
}
export interface MuxHandlers {
    onApprovalRequested(pending: MuxApproval): void;
    onApprovalResolved(sessionId: string, approvalId: string): void;
    onQuestionRequested(pending: MuxQuestion): void;
    onQuestionResolved(sessionId: string, questionRpcId: string): void;
}
interface MuxFrame {
    type?: string;
    sessionId?: string;
    approvalId?: string;
    toolName?: string;
    callId?: string;
    reason?: string;
    questions?: unknown[];
    questionRpcId?: string;
}
interface MuxEnvelope {
    rpcId?: string;
    payload?: MuxFrame;
}
export interface ApiProxyLike {
    events: {
        mux(request: {
            rpcId: string;
            payload: Record<string, unknown>;
        }, signal: AbortSignal): AsyncIterable<MuxEnvelope>;
    };
    respond(message: {
        type: 'client-response';
        rpcId: string;
        result: {
            ok: true;
            value: unknown;
        } | {
            ok: false;
            error: {
                code: string;
                message: string;
                details: Record<string, unknown>;
            };
        };
    }): Promise<{
        accepted: boolean;
        reason?: string;
    }>;
}
/**
 * True when this process's loader already lists the Web api-gateway row,
 * even if that plugin has not started yet. Used so we do not steal the
 * single userQuestions slot during boot and crash api-proxy.
 */
export declare function compositionHasWebGateway(ctx: {
    get(name: string): unknown;
}): boolean;
export declare function asApiProxy(value: unknown): ApiProxyLike | undefined;
export declare function startMuxMirror(api: ApiProxyLike, handlers: MuxHandlers, signal: AbortSignal, onError?: (message: string) => void): void;
export declare function respondApproval(api: ApiProxyLike, rpcId: string, sessionId: string, approvalId: string, outcome: 'allowed-once' | 'rejected'): Promise<{
    accepted: boolean;
    reason?: string;
}>;
export declare function respondQuestion(api: ApiProxyLike, rpcId: string, sessionId: string, answer: {
    answers: {
        id: string;
        selected: string[];
        custom?: string;
    }[];
}): Promise<{
    accepted: boolean;
    reason?: string;
}>;
export declare function cancelQuestion(api: ApiProxyLike, rpcId: string): Promise<{
    accepted: boolean;
    reason?: string;
}>;
export {};

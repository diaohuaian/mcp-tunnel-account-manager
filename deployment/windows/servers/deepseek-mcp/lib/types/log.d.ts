export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
/**
 * Bridge logger. Writes redacted lines to an optional file under DSH_HOME and
 * NEVER to stdout (stdout must stay clean for the stdio MCP transport). In
 * HTTP mode the same lines are forwarded to the cordis logger, which the
 * harness already routes.
 */
export interface BridgeLogger {
    debug(message: string, payload?: unknown): void;
    info(message: string, payload?: unknown): void;
    warn(message: string, payload?: unknown): void;
    error(message: string, payload?: unknown): void;
}
export declare function createBridgeLogger(options: {
    level: LogLevel;
    dshHome: string;
    stdioSafe: boolean;
    cordis?: {
        info(m: string): void;
        warn(m: string): void;
        error(m: string): void;
        debug?(m: string): void;
    };
}): BridgeLogger;
/** Control-plane logger: writes redacted NDJSON under DSH_HOME/chatgpt-bridge/logs, forwarded to cordis. */
export declare function createControlLogger(dshHome: string, cordis?: {
    info(m: string): void;
    warn(m: string): void;
    error(m: string): void;
}): {
    info(m: string): void;
    warn(m: string): void;
    error(m: string): void;
};

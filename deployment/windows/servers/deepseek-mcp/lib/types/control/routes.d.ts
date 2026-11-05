/**
 * Host management API for the ChatGPT Bridge runtime.
 *
 * Mounted on the DSH web server under /_dsh/chatgpt-bridge. Loopback-only,
 * with Host + Origin + Content-Type + custom-header checks on every mutation
 * (CSRF defense). No CORS wildcard: the management API is same-origin with
 * the DSH web UI and must never be reachable from third-party pages. GET
 * endpoints never mutate. Secrets are never returned (only configured flags).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RuntimeManager } from './runtime-manager.js';
export declare const ROUTE_BASE = "/_dsh/chatgpt-bridge";
export declare const MUTATION_HEADER = "x-dsh-chatgpt-bridge";
interface WebServerLike {
    register(route: {
        kind: 'exact' | 'prefix';
        path: string;
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
    }): () => void;
}
export interface ManagementApiOptions {
    dshHome: string;
}
export declare function createManagementApi(manager: RuntimeManager, options: ManagementApiOptions): {
    register(webServer: WebServerLike): () => void;
};
export {};

/** Return the `file:` reference form used by tunnel-client config files. */
export declare function fileRef(absPath: string): string;
export declare class SecretStore {
    private readonly secretsDir;
    private readonly dshHome;
    constructor(dshHome: string);
    get directory(): string;
    get runtimeApiKeyPath(): string;
    get mcpAuthorizationPath(): string;
    /** file: reference for the runtime API key secret (never the value). */
    get runtimeApiKeyRef(): string;
    /** file: reference for the MCP authorization header secret. */
    get mcpAuthorizationRef(): string;
    /** Whether a runtime API key is currently configured (value never returned). */
    runtimeApiKeyConfigured(): boolean;
    /** Write/replace the runtime API key secret file. Returns its file: ref. */
    writeRuntimeApiKey(value: string): string;
    /** Delete the runtime API key secret file. */
    clearRuntimeApiKey(): void;
    /**
     * Transient read used ONLY for an outbound control-plane probe. The value is
     * never returned by the API, never persisted to config/log, and must not be
     * retained by callers.
     */
    readRuntimeApiKey(): string | undefined;
    /**
     * Ensure the MCP authorization secret file exists for the given bridge
     * token. The file content is the full header value (`Bearer <token>`), so
     * tunnel-client can inject it directly via a file: reference. The raw token
     * never enters the profile, config JSON, argv, or any log line.
     */
    ensureMcpAuthorization(bridgeToken: string): string;
}

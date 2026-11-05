/**
 * Secret store for the tunnel runtime manager.
 *
 * Secrets live in their own directory under `<dshHome>/chatgpt-bridge/secrets/`
 * and are referenced from config/profile only as `file:` references. The
 * store never returns secret values to callers and never logs them; the
 * management API only ever reports `configured: true/false`.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
/** Return the `file:` reference form used by tunnel-client config files. */
export function fileRef(absPath) {
    return 'file:' + absPath;
}
function applyRestrictedPermissions(path) {
    // POSIX: 0600. Windows has no meaningful chmod; best-effort skip.
    if (process.platform !== 'win32') {
        try {
            chmodSync(path, 0o600);
        }
        catch {
            // best-effort
        }
    }
}
export class SecretStore {
    secretsDir;
    dshHome;
    constructor(dshHome) {
        this.dshHome = dshHome;
        this.secretsDir = join(dshHome, 'chatgpt-bridge', 'secrets');
    }
    get directory() {
        return this.secretsDir;
    }
    get runtimeApiKeyPath() {
        return join(this.secretsDir, 'runtime-api-key');
    }
    get mcpAuthorizationPath() {
        return join(this.secretsDir, 'mcp-authorization');
    }
    /** file: reference for the runtime API key secret (never the value). */
    get runtimeApiKeyRef() {
        return fileRef(this.runtimeApiKeyPath);
    }
    /** file: reference for the MCP authorization header secret. */
    get mcpAuthorizationRef() {
        return fileRef(this.mcpAuthorizationPath);
    }
    /** Whether a runtime API key is currently configured (value never returned). */
    runtimeApiKeyConfigured() {
        return existsSync(this.runtimeApiKeyPath);
    }
    /** Write/replace the runtime API key secret file. Returns its file: ref. */
    writeRuntimeApiKey(value) {
        if (typeof value !== 'string' || value.trim() === '') {
            throw new Error('runtime-api-key-empty');
        }
        mkdirSync(this.secretsDir, { recursive: true });
        writeFileSync(this.runtimeApiKeyPath, value + '\n', 'utf8');
        applyRestrictedPermissions(this.runtimeApiKeyPath);
        return this.runtimeApiKeyRef;
    }
    /** Delete the runtime API key secret file. */
    clearRuntimeApiKey() {
        rmSync(this.runtimeApiKeyPath, { force: true });
    }
    /**
     * Transient read used ONLY for an outbound control-plane probe. The value is
     * never returned by the API, never persisted to config/log, and must not be
     * retained by callers.
     */
    readRuntimeApiKey() {
        if (!this.runtimeApiKeyConfigured())
            return undefined;
        try {
            const raw = readFileSync(this.runtimeApiKeyPath, 'utf8').trim();
            return raw === '' ? undefined : raw;
        }
        catch {
            return undefined;
        }
    }
    /**
     * Ensure the MCP authorization secret file exists for the given bridge
     * token. The file content is the full header value (`Bearer <token>`), so
     * tunnel-client can inject it directly via a file: reference. The raw token
     * never enters the profile, config JSON, argv, or any log line.
     */
    ensureMcpAuthorization(bridgeToken) {
        mkdirSync(this.secretsDir, { recursive: true });
        const content = `Bearer ${bridgeToken}\n`;
        if (readFileSafe(this.mcpAuthorizationPath) === content)
            return this.mcpAuthorizationRef;
        writeFileSync(this.mcpAuthorizationPath, content, 'utf8');
        applyRestrictedPermissions(this.mcpAuthorizationPath);
        return this.mcpAuthorizationRef;
    }
}
function readFileSafe(path) {
    try {
        return readFileSync(path, 'utf8');
    }
    catch {
        return undefined;
    }
}

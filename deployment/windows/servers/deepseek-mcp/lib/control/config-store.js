/**
 * Runtime-config store for the tunnel runtime manager.
 *
 * Persists `runtime-config.json` under `<dshHome>/chatgpt-bridge/`, kept
 * deliberately separate from the Bridge ConfigSchema (runtime fields change
 * without restarting the Bridge). Writes are atomic (temp file + rename) and
 * the file is schema-versioned so future migrations can run without crashing.
 * This file never holds secrets: only file: references.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
export const CONFIG_SCHEMA_VERSION = 1;
/** The error raised when a stored config carries an unsupported schemaVersion. */
export class UnknownSchemaVersionError extends Error {
    version;
    constructor(version) {
        super(`runtime-config.json has unsupported schemaVersion: ${JSON.stringify(version)}`);
        this.name = 'UnknownSchemaVersionError';
        this.version = version;
    }
}
export function defaultRuntimeConfig() {
    return {
        schemaVersion: CONFIG_SCHEMA_VERSION,
        tunnel: {
            proxy: { enabled: false },
            autoStart: false,
        },
        openai: {},
        bridge: {},
    };
}
/** Merge a partial config over the defaults (deep for the known sections). */
export function mergeRuntimeConfig(base, patch) {
    const tunnelPatch = patch.tunnel ?? {};
    const openaiPatch = patch.openai ?? {};
    const bridgePatch = patch.bridge ?? {};
    const mergedTunnel = {
        ...base.tunnel,
        ...tunnelPatch,
        proxy: { ...(base.tunnel.proxy ?? { enabled: false }), ...(tunnelPatch.proxy ?? {}) },
    };
    if ('executable' in tunnelPatch && (tunnelPatch.executable === '' || tunnelPatch.executable === undefined)) {
        delete mergedTunnel.executable;
    }
    const mergedOpenai = {
        ...base.openai,
        ...openaiPatch,
    };
    if ('controlPlaneBaseUrl' in openaiPatch && (openaiPatch.controlPlaneBaseUrl === '' || openaiPatch.controlPlaneBaseUrl === undefined)) {
        delete mergedOpenai.controlPlaneBaseUrl;
    }
    return {
        schemaVersion: CONFIG_SCHEMA_VERSION,
        tunnel: mergedTunnel,
        openai: mergedOpenai,
        bridge: { ...base.bridge, ...bridgePatch },
    };
}
export class ConfigStore {
    file;
    dshHome;
    constructor(dshHome) {
        this.dshHome = dshHome;
        this.file = join(dshHome, 'chatgpt-bridge', 'runtime-config.json');
    }
    get filePath() {
        return this.file;
    }
    /** Read the stored config; missing or empty file yields defaults. */
    load() {
        let raw;
        try {
            raw = readFileSync(this.file, 'utf8');
        }
        catch {
            return defaultRuntimeConfig();
        }
        if (raw.trim() === '')
            return defaultRuntimeConfig();
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            throw new Error('runtime-config.json is not valid JSON');
        }
        return this.validate(parsed);
    }
    /** Validate/normalize a parsed value into a RuntimeConfig (migration-ready). */
    validate(parsed) {
        if (typeof parsed !== 'object' || parsed === null) {
            throw new Error('runtime-config.json must be a JSON object');
        }
        const raw = parsed;
        const version = raw.schemaVersion;
        if (version !== CONFIG_SCHEMA_VERSION) {
            if (typeof version === 'number' && version < CONFIG_SCHEMA_VERSION) {
                // Future migration hook: migrate(version) would run here.
                return this.migrate(raw, version);
            }
            throw new UnknownSchemaVersionError(version);
        }
        return mergeRuntimeConfig(defaultRuntimeConfig(), parsed);
    }
    /** Migration seam. schemaVersion 1 is the only known version today. */
    migrate(raw, version) {
        if (version !== 1)
            throw new UnknownSchemaVersionError(version);
        return mergeRuntimeConfig(defaultRuntimeConfig(), raw);
    }
    /** Atomic write: temp file in the same directory, then rename over the target. */
    save(config) {
        const dir = dirname(this.file);
        mkdirSync(dir, { recursive: true });
        const tmp = join(dir, `runtime-config.${process.pid}.${randomUUID()}.tmp`);
        try {
            writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
            renameSync(tmp, this.file);
        }
        catch (error) {
            try {
                rmSync(tmp, { force: true });
            }
            catch {
                // best-effort cleanup
            }
            throw error;
        }
    }
    /** Read-modify-write with a single atomic save at the end. */
    update(mutate) {
        const next = mutate(this.load());
        this.save(next);
        return next;
    }
}

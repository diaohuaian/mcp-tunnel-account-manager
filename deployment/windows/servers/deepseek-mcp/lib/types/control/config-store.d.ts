import type { RuntimeConfig } from './types.js';
export declare const CONFIG_SCHEMA_VERSION: 1;
/** The error raised when a stored config carries an unsupported schemaVersion. */
export declare class UnknownSchemaVersionError extends Error {
    readonly version: unknown;
    constructor(version: unknown);
}
export declare function defaultRuntimeConfig(): RuntimeConfig;
/** Merge a partial config over the defaults (deep for the known sections). */
export declare function mergeRuntimeConfig(base: RuntimeConfig, patch: Partial<RuntimeConfig>): RuntimeConfig;
export declare class ConfigStore {
    private readonly file;
    private readonly dshHome;
    constructor(dshHome: string);
    get filePath(): string;
    /** Read the stored config; missing or empty file yields defaults. */
    load(): RuntimeConfig;
    /** Validate/normalize a parsed value into a RuntimeConfig (migration-ready). */
    validate(parsed: unknown): RuntimeConfig;
    /** Migration seam. schemaVersion 1 is the only known version today. */
    private migrate;
    /** Atomic write: temp file in the same directory, then rename over the target. */
    save(config: RuntimeConfig): void;
    /** Read-modify-write with a single atomic save at the end. */
    update(mutate: (config: RuntimeConfig) => RuntimeConfig): RuntimeConfig;
}

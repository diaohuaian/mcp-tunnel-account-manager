export interface ProfileInput {
    controlPlaneBaseUrl: string;
    tunnelId: string;
    runtimeApiKeyRef: string;
    mcpAuthorizationRef: string;
    bridgeUrl: string;
    /** e.g. 127.0.0.1:0 (ephemeral loopback port). */
    healthListenAddr: string;
    healthUrlFile: string;
    logFile: string;
    logLevel: string;
}
/** Build the profile YAML text for a validated input. */
export declare function buildProfileYaml(input: ProfileInput): string;
export declare class ProfileGenerator {
    private readonly profilesDir;
    constructor(profilesDir: string);
    get directory(): string;
    profilePath(profileName: string): string;
    /** Write the profile atomically (temp + rename) and return its path. */
    write(profileName: string, input: ProfileInput): string;
}

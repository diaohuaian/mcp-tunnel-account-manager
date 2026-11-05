export type DiscoverySource = 'configured' | 'path' | 'well-known' | 'running-process';
export interface DiscoveredExecutable {
    path: string;
    source: DiscoverySource;
}
export interface DiscoveredProxyHint {
    host: string;
    port: number;
    source: 'env';
}
/** Observed `tunnel-client` process this plugin did not start. Never adopted. */
export interface DiscoveredRunningProcess {
    pid: number;
    executablePath: string;
    profileName?: string;
    proxyFlag?: boolean;
}
export interface ExistingRuntimeDiscovery {
    executable?: DiscoveredExecutable;
    /** Official tunnel-client profile path that supplied the hints. */
    profilePath?: string;
    profileName?: string;
    tunnelId?: string;
    controlPlaneBaseUrl?: string;
    /** True when a referenced env/file runtime key exists, or a non-empty literal is present. Never the secret. */
    runtimeApiKeyAvailable?: boolean;
    proxy?: DiscoveredProxyHint;
    /** True when a running tunnel-client was launched with an explicit proxy flag. */
    proxyInUse?: boolean;
    /** Loopback health base derived from profile `listen_addr` (never a public bind). */
    healthBaseUrl?: string;
    /** Observed process. Hint + status only; the plugin does not take ownership. */
    runningProcess?: DiscoveredRunningProcess;
}
export interface DiscoverHooks {
    configuredExecutable?: string;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    existsSync?: (path: string) => boolean;
    listRunningProcesses?: () => DiscoveredRunningProcess[];
    readFileSync?: (path: string, encoding: 'utf8') => string;
    readdirSync?: (path: string) => string[];
    listRunningExecutables?: () => string[];
    profileDirs?: string[];
    wellKnownPaths?: string[];
}
/** Well-known install locations. Bounded list — never a recursive disk walk. */
export declare function wellKnownExecutableCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[];
export declare function defaultProfileDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[];
/** Pull profile name and proxy-flag presence off a command line. Never returns secret values. */
export declare function parseTunnelCommandLine(commandLine: string): {
    profileName?: string;
    proxyFlag: boolean;
};
/** Loopback-only health base from profile `listen_addr`. Ephemeral `:0` is skipped. */
export declare function healthBaseFromListenAddr(addr: string): string | undefined;
/** Resolve the tunnel-client binary. Configured path wins when it exists. */
export declare function discoverExecutable(hooks?: DiscoverHooks): DiscoveredExecutable | undefined;
export declare function resolveTunnelClientExecutable(configured?: string): string | undefined;
/** Collect non-secret hints from an already-configured tunnel-client install. */
export declare function discoverExistingRuntime(hooks?: DiscoverHooks): ExistingRuntimeDiscovery;

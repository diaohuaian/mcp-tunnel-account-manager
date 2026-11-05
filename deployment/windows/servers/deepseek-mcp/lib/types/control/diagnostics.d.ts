import type { DoctorStep, TunnelDetectionResult } from './types.js';
export interface BridgeProbeResult {
    listening: boolean;
    reachable: boolean;
    authenticated: boolean;
    status: 'running' | 'offline' | 'error';
    error?: string;
}
export interface BridgeProbeOptions {
    url: string;
    token: string;
    timeoutMs?: number;
}
/** Cheap TCP reachability check for a host:port. */
export declare function tcpReachable(host: string, port: number, timeoutMs?: number): Promise<boolean>;
/** Probe the bridge endpoint without creating an MCP session. */
export declare function probeBridge(options: BridgeProbeOptions): Promise<BridgeProbeResult>;
/** Loopback GET status helper. node:http does not honor HTTP_PROXY, which is
 * what we want for 127.0.0.1 health endpoints (a user proxy must not 502 them). */
export declare function httpGetStatus(url: string, timeoutMs?: number): Promise<number | undefined>;
/** Probe a tunnel-client health base (`/healthz` + `/readyz`). */
export declare function probeTunnelHealth(baseUrl: string, timeoutMs?: number): Promise<{
    healthy: boolean;
    ready: boolean;
}>;
export type ControlPlaneProbeStatus = 'connected' | 'unreachable' | 'unauthorized' | 'unknown';
export type ControlPlaneProbeError = 'proxy-invalid' | 'proxy-connect-failed' | 'proxy-connect-timeout' | 'tls-failed' | 'dns-failed' | 'control-plane-timeout' | 'http-error' | 'authentication-failed';
export type ControlPlaneProbeStage = 'connect' | 'proxy-connect' | 'tls' | 'request';
export interface ControlPlaneProbeOptions {
    baseUrl: string;
    apiKey?: string;
    /** Overall per-probe timeout in milliseconds. */
    timeoutMs?: number;
    /** Configured HTTP proxy to route the probe through; undefined = direct. */
    proxy?: {
        host: string;
        port: number;
    };
    /** Test-only escape hatch for self-signed TLS origins; production stays true. */
    rejectUnauthorized?: boolean;
}
export interface ControlPlaneProbeResult {
    status: ControlPlaneProbeStatus;
    /** Granular failure classification (stable step code is preserved upstream). */
    error?: ControlPlaneProbeError;
    /** Which stage failed/responded, for diagnostics provenance. */
    stage?: ControlPlaneProbeStage;
    statusCode?: number;
    /** Redacted proxy reference (host:port) when the probe used one. Never credentials. */
    proxy?: string;
}
interface ControlPlaneRawOutcome {
    statusCode?: number;
    error?: ControlPlaneProbeError;
    stage?: ControlPlaneProbeStage;
    proxy?: string;
}
/**
 * HTTPS target through an HTTP proxy: CONNECT + TLS + plain GET over the
 * tunneled socket. A non-200 CONNECT, TLS handshake failure or any proxy
 * failure is reported as a probe failure — never a silent fallback to direct.
 * (Exported for hermetic CONNECT-path tests.)
 */
export declare function probeHttpsViaProxy(u: URL, headers: Record<string, string>, timeoutMs: number, proxy: {
    host: string;
    port: number;
}, rejectUnauthorized: boolean): Promise<ControlPlaneRawOutcome>;
/**
 * Plain-HTTP target through an HTTP proxy: absolute-form GET (RFC 7230).
 * (Exported for hermetic proxy-path tests.)
 */
export declare function probeHttpViaProxy(u: URL, headers: Record<string, string>, timeoutMs: number, proxy: {
    host: string;
    port: number;
}): Promise<ControlPlaneRawOutcome>;
/**
 * Best-effort control-plane reachability probe (short read-only GET).
 *
 * Network semantics follow the user proxy configuration exactly like
 * tunnel-client: when proxy.enabled=true the probe MUST route through that
 * proxy (HTTPS targets via HTTP CONNECT, plain-HTTP targets via absolute-form
 * GET). Proxy failures fail closed — there is NO silent fallback to a direct
 * request. Loopback targets bypass the proxy (mirror of tunnel-client's
 * NO_PROXY for local endpoints). Secrets are never returned or logged: the
 * result carries only a redacted host:port proxy reference.
 */
export declare function probeControlPlane(options: ControlPlaneProbeOptions | string, apiKey?: string, timeoutMs?: number): Promise<ControlPlaneProbeResult>;
export interface DiagnosticsContext {
    detection: TunnelDetectionResult;
    bridgeProbe: BridgeProbeResult;
    tunnelRunning: boolean;
    tunnelHealthy: boolean;
    tunnelReady: boolean;
    /** Thrown runtime.status() probe: unknown, never "stopped". */
    statusProbeFailed?: boolean;
    runtimeApiKeyConfigured: boolean;
    controlPlaneBaseUrl: string;
    controlPlaneStatus: 'connected' | 'unreachable' | 'unauthorized' | 'unknown';
    /** Granular, redacted probe failure info (code/stage/proxy) for diagnostics. */
    controlPlaneError?: {
        code?: string;
        stage?: string;
        proxy?: string;
    };
    proxyConfigured: boolean;
    proxyValid: boolean;
}
/** Build the ordered layered diagnostics steps. */
export declare function buildDiagnosticSteps(ctx: DiagnosticsContext): DoctorStep[];
export {};

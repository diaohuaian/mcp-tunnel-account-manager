/**
 * Bridge probe and layered diagnostics for the ChatGPT Bridge runtime.
 *
 * The bridge probe is protocol-safe: it never opens an MCP session. A GET to
 * /mcp without an mcp-session-id is spec-legal and yields 400 (auth accepted,
 * no session) or 401 (auth failed) or connection-refused (offline). This is
 * exactly the read-only probe the runtime manager needs.
 */
import { connect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { get as httpGet, request as httpRequest } from 'node:http';
import { get as httpsGet } from 'node:https';
import { normalizeSocketHostname } from '../config.js';
function parseUrl(url) {
    const u = new URL(url);
    return {
        host: normalizeSocketHostname(u.hostname),
        port: u.port === '' ? (u.protocol === 'https:' ? 443 : 80) : Number(u.port),
        path: u.pathname + u.search,
    };
}
/** Cheap TCP reachability check for a host:port. */
export async function tcpReachable(host, port, timeoutMs = 2000) {
    return new Promise((resolve) => {
        const socket = connect({ host: normalizeSocketHostname(host), port });
        const timer = setTimeout(() => {
            socket.destroy();
            resolve(false);
        }, timeoutMs);
        socket.once('connect', () => {
            clearTimeout(timer);
            socket.destroy();
            resolve(true);
        });
        socket.once('error', () => {
            clearTimeout(timer);
            resolve(false);
        });
    });
}
/** Probe the bridge endpoint without creating an MCP session. */
export async function probeBridge(options) {
    const { host, port, path } = parseUrl(options.url);
    const timeoutMs = options.timeoutMs ?? 3000;
    const listening = await tcpReachable(host, port, timeoutMs);
    if (!listening) {
        return { listening: false, reachable: false, authenticated: false, status: 'offline' };
    }
    try {
        const status = await new Promise((resolve) => {
            const req = (options.url.startsWith('https') ? httpsGet : httpGet)({ host, port, path, headers: { Authorization: 'Bearer ' + options.token }, timeout: timeoutMs }, (res) => {
                res.resume();
                resolve(res.statusCode);
            });
            req.once('timeout', () => req.destroy());
            req.once('error', () => resolve(undefined));
        });
        if (status === undefined) {
            return { listening: true, reachable: false, authenticated: false, status: 'error', error: 'bridge-probe-failed' };
        }
        if (status === 401) {
            return { listening: true, reachable: true, authenticated: false, status: 'error', error: 'bridge-auth-failed' };
        }
        return { listening: true, reachable: true, authenticated: true, status: 'running' };
    }
    catch {
        return { listening: true, reachable: false, authenticated: false, status: 'error', error: 'bridge-probe-failed' };
    }
}
/** Loopback GET status helper. node:http does not honor HTTP_PROXY, which is
 * what we want for 127.0.0.1 health endpoints (a user proxy must not 502 them). */
export async function httpGetStatus(url, timeoutMs = 2000) {
    return new Promise((resolve) => {
        try {
            const u = new URL(url);
            const getter = u.protocol === 'https:' ? httpsGet : httpGet;
            const req = getter({ host: normalizeSocketHostname(u.hostname), port: u.port === '' ? undefined : Number(u.port), path: u.pathname + u.search, timeout: timeoutMs }, (res) => {
                res.resume();
                resolve(res.statusCode);
            });
            req.once('timeout', () => {
                req.destroy();
                resolve(undefined);
            });
            req.once('error', () => resolve(undefined));
        }
        catch {
            resolve(undefined);
        }
    });
}
/** Probe a tunnel-client health base (`/healthz` + `/readyz`). */
export async function probeTunnelHealth(baseUrl, timeoutMs = 2000) {
    const base = baseUrl.replace(/\/$/, '');
    const [healthStatus, readyStatus] = await Promise.all([
        httpGetStatus(base + '/healthz', timeoutMs),
        httpGetStatus(base + '/readyz', timeoutMs),
    ]);
    const ok = (status) => status !== undefined && status >= 200 && status < 300;
    return { healthy: ok(healthStatus), ready: ok(readyStatus) };
}
/** Redacted, single-line provenance appended to the stable step detail. */
function controlPlaneErrorDetail(err) {
    if (err === undefined)
        return '';
    const parts = [];
    if (err.code !== undefined && err.code !== '')
        parts.push('code=' + err.code);
    if (err.stage !== undefined && err.stage !== '')
        parts.push('stage=' + err.stage);
    if (err.proxy !== undefined && err.proxy !== '')
        parts.push('proxy=' + err.proxy);
    return parts.length === 0 ? '' : ' (' + parts.join(' ') + ')';
}
/** Loopback targets bypass the proxy, mirroring tunnel-client's NO_PROXY. */
function isLoopbackHost(hostname) {
    const host = normalizeSocketHostname(hostname).toLowerCase();
    return (host === 'localhost' ||
        host.endsWith('.localhost') ||
        host === '::1' ||
        host === '127.0.0.1' ||
        /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host));
}
/** IPv4 literal or bare IPv6 (no brackets): never used as TLS SNI. */
function isIpLiteral(hostname) {
    const host = normalizeSocketHostname(hostname);
    return host.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}
/** Direct (proxy disabled / loopback) probe: current semantics preserved. */
function probeDirect(u, headers, timeoutMs) {
    return new Promise((resolve) => {
        let settled = false;
        const done = (r) => {
            if (!settled) {
                settled = true;
                resolve(r);
            }
        };
        const req = (u.protocol === 'https:' ? httpsGet : httpGet)({ host: normalizeSocketHostname(u.hostname), port: u.port === '' ? undefined : Number(u.port), path: u.pathname + u.search, headers, timeout: timeoutMs }, (res) => {
            res.resume();
            done({ statusCode: res.statusCode, stage: 'request' });
        });
        req.once('timeout', () => {
            req.destroy();
            done({ error: 'control-plane-timeout', stage: 'request' });
        });
        req.once('error', (error) => {
            const code = error.code ?? '';
            if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /getaddrinfo/i.test(error.message)) {
                done({ error: 'dns-failed', stage: 'connect' });
            }
            else if (code === 'ETIMEDOUT' || /timed out/i.test(error.message)) {
                done({ error: 'control-plane-timeout', stage: 'connect' });
            }
            else if (/self[- ]signed|certificate|CERT_/.test(error.message + ' ' + code)) {
                done({ error: 'tls-failed', stage: 'tls' });
            }
            else {
                // Connection refused / unreachable: unreachable, no finer class needed.
                done({ stage: 'connect' });
            }
        });
    });
}
/**
 * HTTPS target through an HTTP proxy: CONNECT + TLS + plain GET over the
 * tunneled socket. A non-200 CONNECT, TLS handshake failure or any proxy
 * failure is reported as a probe failure — never a silent fallback to direct.
 * (Exported for hermetic CONNECT-path tests.)
 */
export function probeHttpsViaProxy(u, headers, timeoutMs, proxy, rejectUnauthorized) {
    return new Promise((resolve) => {
        let settled = false;
        const done = (r) => {
            if (!settled) {
                settled = true;
                resolve(r);
            }
        };
        const hostPort = u.port !== '' ? u.host : `${u.host}:${u.protocol === 'https:' ? 443 : 80}`;
        let socket;
        try {
            socket = connect({ host: normalizeSocketHostname(proxy.host), port: proxy.port });
        }
        catch {
            done({ error: 'proxy-connect-failed', stage: 'proxy-connect' });
            return;
        }
        const deadline = setTimeout(() => {
            socket.destroy();
            done({ error: 'proxy-connect-timeout', stage: 'proxy-connect' });
        }, timeoutMs);
        socket.once('error', () => {
            clearTimeout(deadline);
            done({ error: 'proxy-connect-failed', stage: 'proxy-connect' });
        });
        socket.once('connect', () => {
            socket.write('CONNECT ' + hostPort + ' HTTP/1.1\r\nHost: ' + hostPort + '\r\nProxy-Connection: keep-alive\r\n\r\n');
            let headBuf = '';
            const onHead = (chunk) => {
                headBuf += chunk.toString('latin1');
                const idx = headBuf.indexOf('\r\n\r\n');
                if (idx === -1)
                    return;
                socket.removeListener('data', onHead);
                const statusLine = /^HTTP\/1\.[01]\s+(\d{3})/.exec(headBuf.slice(0, idx));
                if (statusLine === null || Number(statusLine[1]) !== 200) {
                    clearTimeout(deadline);
                    socket.destroy();
                    done({ error: 'proxy-connect-failed', stage: 'proxy-connect' });
                    return;
                }
                clearTimeout(deadline);
                const tlsSocket = tlsConnect({
                    socket,
                    // RFC 6066 forbids IP-literal SNI (Node DEP0123); skip servername
                    // for IP hosts and only set it for DNS names.
                    servername: isIpLiteral(u.hostname) ? undefined : normalizeSocketHostname(u.hostname),
                    rejectUnauthorized,
                });
                tlsSocket.setTimeout(timeoutMs, () => {
                    tlsSocket.destroy();
                    done({ error: 'control-plane-timeout', stage: 'tls' });
                });
                tlsSocket.once('error', () => {
                    done({ error: 'tls-failed', stage: 'tls' });
                });
                tlsSocket.once('secureConnect', () => {
                    tlsSocket.setTimeout(0);
                    const req = httpRequest({
                        createConnection: () => tlsSocket,
                        host: normalizeSocketHostname(u.hostname),
                        port: u.port === '' ? 443 : Number(u.port),
                        method: 'GET',
                        path: u.pathname + u.search,
                        headers: { ...headers, Host: u.host },
                        timeout: timeoutMs,
                    }, (res) => {
                        res.resume();
                        done({ statusCode: res.statusCode, stage: 'request' });
                        // One-shot probe: the tunneled socket is NOT agent-managed, so it
                        // must be torn down when the response ends — otherwise an idle
                        // CONNECT tunnel stays open through the user's proxy and pins the
                        // event loop.
                        const closeTunnel = () => {
                            try {
                                tlsSocket.destroy();
                            }
                            catch {
                                /* already closed */
                            }
                        };
                        res.once('end', closeTunnel);
                        res.once('close', closeTunnel);
                    });
                    req.once('timeout', () => {
                        req.destroy();
                        done({ error: 'control-plane-timeout', stage: 'request' });
                    });
                    req.once('error', () => {
                        done({ error: 'http-error', stage: 'request' });
                    });
                    req.end();
                });
            };
            socket.on('data', onHead);
        });
    });
}
/**
 * Plain-HTTP target through an HTTP proxy: absolute-form GET (RFC 7230).
 * (Exported for hermetic proxy-path tests.)
 */
export function probeHttpViaProxy(u, headers, timeoutMs, proxy) {
    return new Promise((resolve) => {
        let settled = false;
        const done = (r) => {
            if (!settled) {
                settled = true;
                resolve(r);
            }
        };
        const req = httpRequest({
            host: normalizeSocketHostname(proxy.host),
            port: proxy.port,
            method: 'GET',
            path: u.href,
            headers: { Host: u.host, ...headers },
            timeout: timeoutMs,
        }, (res) => {
            res.resume();
            done({ statusCode: res.statusCode, stage: 'request' });
        });
        req.once('timeout', () => {
            req.destroy();
            done({ error: 'proxy-connect-timeout', stage: 'proxy-connect' });
        });
        req.once('error', (error) => {
            const code = error.code ?? '';
            if (code === 'ETIMEDOUT' || /timed out/i.test(error.message)) {
                done({ error: 'proxy-connect-timeout', stage: 'proxy-connect' });
            }
            else {
                done({ error: 'proxy-connect-failed', stage: 'proxy-connect' });
            }
        });
        req.end();
    });
}
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
export async function probeControlPlane(options, apiKey, timeoutMs) {
    const normalized = typeof options === 'string'
        ? { baseUrl: options, apiKey, timeoutMs }
        : options;
    const t = normalized.timeoutMs ?? 5000;
    const rejectUnauthorized = normalized.rejectUnauthorized ?? true;
    let u;
    try {
        u = new URL(normalized.baseUrl);
    }
    catch {
        return { status: 'unreachable', error: 'http-error', stage: 'connect' };
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return { status: 'unreachable', error: 'http-error', stage: 'connect' };
    }
    const headers = {};
    if (normalized.apiKey !== undefined && normalized.apiKey !== '')
        headers.Authorization = 'Bearer ' + normalized.apiKey;
    const proxy = normalized.proxy;
    let outcome;
    if (proxy !== undefined && !isLoopbackHost(u.hostname)) {
        const proxyLabel = proxy.host + ':' + proxy.port;
        if (proxy.host === '' || !Number.isInteger(proxy.port) || proxy.port < 1 || proxy.port > 65535) {
            return { status: 'unreachable', error: 'proxy-invalid', stage: 'proxy-connect', proxy: proxyLabel };
        }
        outcome =
            u.protocol === 'https:'
                ? await probeHttpsViaProxy(u, headers, t, proxy, rejectUnauthorized)
                : await probeHttpViaProxy(u, headers, t, proxy);
        outcome = { ...outcome, proxy: proxyLabel };
    }
    else {
        outcome = await probeDirect(u, headers, t);
    }
    if (outcome.statusCode === 401 || outcome.statusCode === 403) {
        return { status: 'unauthorized', error: 'authentication-failed', stage: outcome.stage, statusCode: outcome.statusCode, proxy: outcome.proxy };
    }
    if (outcome.statusCode === undefined) {
        return { status: 'unreachable', error: outcome.error, stage: outcome.stage, statusCode: outcome.statusCode, proxy: outcome.proxy };
    }
    return {
        status: 'connected',
        ...(outcome.statusCode >= 400 ? { error: 'http-error' } : {}),
        stage: outcome.stage,
        statusCode: outcome.statusCode,
        proxy: outcome.proxy,
    };
}
/** Build the ordered layered diagnostics steps. */
export function buildDiagnosticSteps(ctx) {
    const steps = [];
    steps.push({
        id: 'tunnel-binary',
        ok: ctx.detection.installed,
        ...(ctx.detection.installed
            ? { detail: ctx.detection.version !== undefined ? ctx.detection.version : ctx.detection.executablePath }
            : { detail: 'tunnel-client not found', code: 'tunnel-client-not-installed' }),
    });
    steps.push({
        id: 'bridge-endpoint',
        ok: ctx.bridgeProbe.listening,
        ...(ctx.bridgeProbe.listening ? {} : { detail: 'bridge not listening', code: 'bridge-unavailable' }),
    });
    steps.push({
        id: 'bridge-auth',
        ok: ctx.bridgeProbe.authenticated,
        ...(ctx.bridgeProbe.authenticated ? {} : { detail: 'bridge auth failed', code: 'bridge-auth-failed' }),
    });
    if (ctx.statusProbeFailed === true) {
        steps.push({
            id: 'status',
            ok: false,
            code: 'status-failed',
            detail: 'runtime status unavailable',
        });
    }
    steps.push({
        id: 'tunnel-process',
        ok: ctx.statusProbeFailed !== true && ctx.tunnelRunning,
        ...(ctx.statusProbeFailed === true
            ? { detail: 'runtime status unavailable', code: 'status-failed' }
            : ctx.tunnelRunning
                ? {}
                : { detail: 'tunnel process not running', code: 'tunnel-not-running' }),
    });
    steps.push({
        id: 'tunnel-health',
        ok: ctx.statusProbeFailed !== true && ctx.tunnelHealthy,
        ...(ctx.statusProbeFailed === true
            ? { detail: 'runtime status unavailable', code: 'status-failed' }
            : ctx.tunnelHealthy
                ? {}
                : { detail: 'tunnel not healthy', code: 'tunnel-not-healthy' }),
    });
    steps.push({
        id: 'tunnel-ready',
        ok: ctx.statusProbeFailed !== true && ctx.tunnelReady,
        ...(ctx.statusProbeFailed === true
            ? { detail: 'runtime status unavailable', code: 'status-failed' }
            : ctx.tunnelReady
                ? {}
                : { detail: 'tunnel not ready', code: 'tunnel-not-ready' }),
    });
    steps.push({
        id: 'runtime-api-key',
        ok: ctx.runtimeApiKeyConfigured,
        ...(ctx.runtimeApiKeyConfigured ? {} : { detail: 'runtime API key not configured', code: 'runtime-api-key-missing' }),
    });
    steps.push({
        id: 'openai-control-plane',
        ok: ctx.controlPlaneStatus === 'connected' || ctx.controlPlaneStatus === 'unknown',
        ...(ctx.controlPlaneStatus === 'unauthorized'
            ? { detail: 'control plane returned 401/403', code: 'runtime-api-unauthorized' }
            : ctx.controlPlaneStatus === 'unreachable'
                ? {
                    detail: 'control plane unreachable' + controlPlaneErrorDetail(ctx.controlPlaneError),
                    code: 'control-plane-unreachable',
                }
                : {}),
    });
    steps.push({
        id: 'proxy',
        ok: !ctx.proxyConfigured || ctx.proxyValid,
        ...(ctx.proxyConfigured && !ctx.proxyValid ? { detail: 'proxy config invalid', code: 'proxy-invalid' } : {}),
    });
    return steps;
}

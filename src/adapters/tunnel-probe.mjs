import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { SwitchFault } from '../core/switch-core.mjs';
import { isMcpServiceId } from '../core/mcp-registry-policy.mjs';
import { evaluateTunnelEvidence, TargetEvidenceFault, SUPPORTED_TUNNEL_VERSION } from './tunnel-health-evidence.mjs';

export { TargetEvidenceFault, SUPPORTED_TUNNEL_VERSION };

/**
 * Loopback-only URL validation. Enforces http: or https: protocol and loopback host.
 */
function isLoopbackUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const u = new URL(urlStr);
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    const host = u.hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

/**
 * Bounded loopback HTTP GET request that returns parsed JSON.
 * Enforces timeout, rejects redirects, and bounds max response size to 1MB.
 */
function boundedHttpGetJson(urlStr, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (err) {
      return reject(new Error(`Invalid URL: ${err.message}`));
    }
    const client = u.protocol === 'https:' ? https : http;
    const req = client.get(urlStr, {
      timeout: timeoutMs,
      headers: { 'Accept': 'application/json' },
      agent: false
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        req.destroy();
        return reject(new Error(`Redirect rejected: ${res.statusCode}`));
      }
      if (res.statusCode !== 200) {
        req.destroy();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      let bytes = 0;
      const MAX_BYTES = 1024 * 1024; // 1MB limit
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_BYTES) {
          req.destroy();
          return reject(new Error('Response size limit exceeded'));
        }
        data += chunk;
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch (e) {
          reject(new Error(`Invalid JSON: ${e.message}`));
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Tunnel probe module for MCP tunnel account manager.
 * Verifies authenticated tunnel sessions against control plane and health endpoints
 * using frozen actual 0.0.19 protocol and GPT evidence gate.
 */
export function createTunnelProbe(options = {}) {
  const isDefault = options.isDefault ?? (
    options.fetch === undefined &&
    options.healthURL === undefined &&
    options.verify === undefined
  );

  return {
    isDefault,
    healthURL: options.healthURL || null,

    /**
     * Checks if target credential and configuration are ready during prepare.
     * Performs static preflight validation against schema and protocol constraints.
     */
    async checkReady({ service, credential, operationId } = {}) {
      if (options.shouldThrowReady) {
        throw new SwitchFault('TARGET_VERIFICATION_UNAVAILABLE');
      }
      if (options.failPreflight) {
        return false;
      }
      if (!credential || typeof credential !== 'object') {
        return false;
      }

      const tunnelId = credential.tunnelId ?? credential.tunnel_id;
      const apiKey = credential.apiKey ?? credential.api_key;
      if (!tunnelId || typeof tunnelId !== 'string' || tunnelId.trim() === '') {
        return false;
      }
      if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
        return false;
      }
      if (tunnelId.length > 128 || apiKey.length > 256) {
        return false;
      }
      // Strictly reject control characters in credentials
      if (/[\x00-\x1f]/.test(tunnelId) || /[\x00-\x1f]/.test(apiKey)) {
        return false;
      }
      if (credential.organizationId && (
        typeof credential.organizationId !== 'string' ||
        credential.organizationId.length > 128 ||
        /[\x00-\x1f]/.test(credential.organizationId)
      )) {
        return false;
      }
      if (service && !isMcpServiceId(service)) {
        return false;
      }
      if (operationId && (
        typeof operationId !== 'string' ||
        operationId.length === 0 ||
        operationId.length > 128 ||
        /[\x00-\x1f]/.test(operationId)
      )) {
        return false;
      }

      return true;
    },

    /**
     * Probes target authenticated tunnel session using real bounded verification
     * against /health?details=true and /api/status via GPT evidence gate.
     */
    async verify(params = {}) {
      if (options.shouldThrow) {
        throw new SwitchFault('VERIFY_FAILED');
      }
      if (options.shouldFail) {
        return { ok: false, verified: false, error: 'Session handshake invalid' };
      }
      if (typeof options.verify === 'function') {
        return await options.verify(params);
      }

      const operationId = params.operationId || params.snapshot?.operationId;
      const service = params.service || params.snapshot?.service;
      const snapshot = params.snapshot;
      const cred = snapshot?.credential;

      if (!cred || !cred.tunnelId || !cred.apiKey) {
        return { ok: false, verified: false, error: 'INVALID_CREDENTIAL' };
      }

      const targetHealthUrl = params.healthURL || snapshot?.healthURL || options.healthURL;
      if (!targetHealthUrl) {
        return { ok: false, verified: false, error: 'HEALTH_URL_REQUIRED' };
      }

      if (!isLoopbackUrl(targetHealthUrl)) {
        return { ok: false, verified: false, error: 'NON_LOOPBACK_HEALTH_URL' };
      }

      const timeoutMs = options.timeoutMs || 3000;
      async function fetchEndpoint(endpointPath) {
        const fullUrl = new URL(endpointPath, targetHealthUrl).href;
        if (typeof options.fetch === 'function') {
          const res = await options.fetch(fullUrl);
          if (!res) throw new Error('Fetch returned no response');
          if (res.status && (res.status < 200 || res.status >= 300)) {
            throw new Error(`HTTP ${res.status}`);
          }
          if (typeof res.json === 'function') return await res.json();
          if (typeof res === 'string') return JSON.parse(res);
          return res;
        }
        return await boundedHttpGetJson(fullUrl, timeoutMs);
      }

      let health, adminStatus;
      try {
        [health, adminStatus] = await Promise.all([
          fetchEndpoint('/health?details=true'),
          fetchEndpoint('/api/status')
        ]);
      } catch (err) {
        return { ok: false, verified: false, error: 'CONTROL_PLANE_UNREACHABLE', cause: err.message };
      }

      const identity = params.identity || snapshot?.identity || snapshot?.originalProcessIdentity;
      const listenerIdentity = params.listenerIdentity || identity;
      const currentConfigFingerprint = params.currentConfigFingerprint || snapshot?.desiredFingerprint;

      const expected = {
        operationId,
        service,
        tunnelId: cred.tunnelId,
        configFingerprint: snapshot?.desiredFingerprint,
        identity: identity ? {
          pid: identity.pid,
          startedAt: identity.startedAt || identity.startTime,
          executable: identity.executable || identity.executablePath
        } : undefined,
        launchedAt: params.launchedAt || snapshot?.launchedAt || identity?.startedAt || identity?.startTime || new Date().toISOString(),
        controlPlaneBaseURL: params.controlPlaneBaseURL || snapshot?.controlPlaneBaseURL || options.controlPlaneBaseURL || 'https://api.openai.com'
      };

      const fetchedAtMs = params.fetchedAtMs ?? options.fetchedAtMs ?? Date.now();

      try {
        const receipt = evaluateTunnelEvidence({
          health,
          adminStatus,
          identity: expected.identity,
          listenerIdentity: listenerIdentity ? {
            pid: listenerIdentity.pid,
            startedAt: listenerIdentity.startedAt || listenerIdentity.startTime,
            executable: listenerIdentity.executable || listenerIdentity.executablePath
          } : undefined,
          currentConfigFingerprint,
          expected,
          fetchedAtMs
        });

        return {
          ok: true,
          ...receipt
        };
      } catch (err) {
        if (err instanceof TargetEvidenceFault) {
          return { ok: false, verified: false, error: err.code, code: err.code };
        }
        return { ok: false, verified: false, error: err.message };
      }
    }
  };
}

export const tunnelProbe = createTunnelProbe({ isDefault: true });

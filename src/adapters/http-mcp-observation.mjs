const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const MAX_RESPONSE_BYTES = 65536; // 64 KiB

async function readBoundedText(res, maxBytes = MAX_RESPONSE_BYTES) {
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    let receivedBytes = 0;
    const chunks = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        receivedBytes += value.byteLength;
        if (receivedBytes > maxBytes) {
          try { await reader.cancel(); } catch {}
          throw new Error('RESPONSE_TOO_LARGE');
        }
        chunks.push(value);
      }
    } finally {
      try { await reader.cancel(); } catch {}
    }
    const concatenated = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      concatenated.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(concatenated);
  } else if (typeof res.text === 'function') {
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error('RESPONSE_TOO_LARGE');
    }
    return text;
  }
  return '';
}

function parseMcpPayload(rawText, contentType = '') {
  const trimmed = rawText.trim();
  if (contentType.includes('text/event-stream') || trimmed.startsWith('data:') || trimmed.startsWith('event:')) {
    const lines = trimmed.split(/\r?\n/);
    let dataBuffer = '';
    for (const line of lines) {
      if (line.startsWith('data:')) {
        dataBuffer += line.slice(5).trim();
      }
    }
    return JSON.parse(dataBuffer);
  }
  return JSON.parse(trimmed);
}

export function createHttpMcpProbe({ resolveHeaders, fetchImpl = fetch, now = Date.now } = {}) {
  return async function probeHttpMcp({ serviceId, url, signal }) {
    const currentNow = () => new Date(now()).toISOString();

    if (signal?.aborted) {
      return {
        state: 'unreachable',
        reasonCode: 'timeout',
        source: 'http_mcp',
        observedAt: currentNow(),
        evidence: { mcpVerified: false }
      };
    }

    if (!url || typeof url !== 'string') {
      return {
        state: 'check_failed',
        reasonCode: 'invalid_observation',
        source: 'http_mcp',
        observedAt: currentNow(),
        evidence: { mcpVerified: false }
      };
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      return {
        state: 'check_failed',
        reasonCode: 'invalid_mcp_response',
        source: 'http_mcp',
        observedAt: currentNow(),
        evidence: { mcpVerified: false }
      };
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return {
        state: 'check_failed',
        reasonCode: 'unsupported_transport',
        source: 'http_mcp',
        observedAt: currentNow(),
        evidence: { mcpVerified: false }
      };
    }

    // Resolve configured private headers, strictly excluding protocol/session bookkeeping
    const cleanConfiguredHeaders = {};
    if (typeof resolveHeaders === 'function') {
      try {
        const resolved = await resolveHeaders(serviceId);
        if (resolved && typeof resolved === 'object') {
          for (const [k, v] of Object.entries(resolved)) {
            const val = typeof v === 'string' ? v : v?.value;
            if (typeof val === 'string') {
              const lowerKey = k.toLowerCase();
              if (lowerKey !== 'mcp-session-id' && lowerKey !== 'mcp-protocol-version') {
                cleanConfiguredHeaders[k] = val;
              }
            }
          }
        }
      } catch {
        // If resolver cannot be connected, allow unauthenticated attempt
      }
    }

    const reqId = 1;
    const initBody = JSON.stringify({
      jsonrpc: '2.0',
      id: reqId,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: {
          name: 'mcp-runtime-observer',
          version: '1.0.0'
        }
      }
    });

    const initHeaders = {
      ...cleanConfiguredHeaders,
      'Accept': 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2025-11-25'
    };

    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: initHeaders,
        body: initBody,
        redirect: 'manual',
        signal
      });
    } catch (error) {
      const code = error?.cause?.code ?? error?.code;
      const isConnRefused = code === 'ECONNREFUSED';
      const isNetwork = isConnRefused || ['ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code);
      const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError' || code === 'ABORT_ERR' || code === 'ETIMEDOUT' || signal?.aborted;
      return {
        state: (isNetwork || isTimeout) ? 'unreachable' : 'check_failed',
        reasonCode: isConnRefused ? 'connection_refused' : isNetwork ? 'connection_failed' : isTimeout ? 'timeout' : 'probe_failed',
        source: 'http_mcp',
        observedAt: currentNow(),
        evidence: { mcpVerified: false }
      };
    }

    const status = res.status;
    if (status === 401 || status === 403) {
      if (res.body?.cancel) try { await res.body.cancel(); } catch {}
      return {
        state: 'authentication_required',
        reasonCode: 'http_authentication_required',
        source: 'http_mcp',
        observedAt: currentNow(),
        evidence: { mcpVerified: false, httpStatus: status }
      };
    }

    if (status < 200 || status >= 300) {
      if (res.body?.cancel) try { await res.body.cancel(); } catch {}
      return {
        state: 'check_failed',
        reasonCode: 'invalid_mcp_response',
        source: 'http_mcp',
        observedAt: currentNow(),
        evidence: { mcpVerified: false, httpStatus: status }
      };
    }

    let bodyText;
    try {
      bodyText = await readBoundedText(res, MAX_RESPONSE_BYTES);
    } catch {
      return {
        state: 'check_failed',
        reasonCode: 'invalid_mcp_response',
        source: 'http_mcp',
        observedAt: currentNow(),
        evidence: { mcpVerified: false, httpStatus: status }
      };
    }

    let data;
    try {
      const contentType = res.headers?.get?.('content-type') || '';
      data = parseMcpPayload(bodyText, contentType);
    } catch {
      return {
        state: 'check_failed',
        reasonCode: 'invalid_mcp_response',
        source: 'http_mcp',
        observedAt: currentNow(),
        evidence: { mcpVerified: false, httpStatus: status }
      };
    }

    if (!data || typeof data !== 'object' || data.jsonrpc !== '2.0' || data.id !== reqId || data.error) {
      return {
        state: 'check_failed',
        reasonCode: 'invalid_mcp_response',
        source: 'http_mcp',
        observedAt: currentNow(),
        evidence: { mcpVerified: false, httpStatus: status }
      };
    }

    const result = data.result;
    if (!result || typeof result !== 'object') {
      return {
        state: 'check_failed',
        reasonCode: 'invalid_mcp_response',
        source: 'http_mcp',
        observedAt: currentNow(),
        evidence: { mcpVerified: false, httpStatus: status }
      };
    }

    const serverVersion = result.protocolVersion;
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(serverVersion)) {
      return {
        state: 'check_failed',
        reasonCode: 'unsupported_transport',
        source: 'http_mcp',
        observedAt: currentNow(),
        evidence: { mcpVerified: false, httpStatus: status }
      };
    }

    if (!result.capabilities || typeof result.capabilities !== 'object' || Array.isArray(result.capabilities)) {
      return {
        state: 'check_failed',
        reasonCode: 'invalid_mcp_response',
        source: 'http_mcp',
        observedAt: currentNow(),
        evidence: { mcpVerified: false, httpStatus: status }
      };
    }

    if (!result.serverInfo || typeof result.serverInfo !== 'object' ||
        typeof result.serverInfo.name !== 'string' || !result.serverInfo.name ||
        typeof result.serverInfo.version !== 'string' || !result.serverInfo.version) {
      return {
        state: 'check_failed',
        reasonCode: 'invalid_mcp_response',
        source: 'http_mcp',
        observedAt: currentNow(),
        evidence: { mcpVerified: false, httpStatus: status }
      };
    }

    const ownSessionId = res.headers?.get?.('mcp-session-id') || null;

    try {
      const notifHeaders = {
        ...cleanConfiguredHeaders,
        'Accept': 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': serverVersion
      };
      if (ownSessionId) {
        notifHeaders['MCP-Session-Id'] = ownSessionId;
      }

      const notifBody = JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized'
      });

      let notifRes;
      try {
        notifRes = await fetchImpl(url, {
          method: 'POST',
          headers: notifHeaders,
          body: notifBody,
          redirect: 'manual',
          signal
        });
      } catch (error) {
        const code = error?.cause?.code ?? error?.code;
        const isConnRefused = code === 'ECONNREFUSED';
        const isNetwork = isConnRefused || ['ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code);
        const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError' || code === 'ABORT_ERR' || code === 'ETIMEDOUT' || signal?.aborted;
        return {
          state: (isNetwork || isTimeout) ? 'unreachable' : 'check_failed',
          reasonCode: isConnRefused ? 'connection_refused' : isNetwork ? 'connection_failed' : isTimeout ? 'timeout' : 'probe_failed',
          source: 'http_mcp',
          observedAt: currentNow(),
          evidence: { mcpVerified: false }
        };
      }

      const notifStatus = notifRes.status;
      if (notifRes.body?.cancel) try { await notifRes.body.cancel(); } catch {}

      if (notifStatus === 401 || notifStatus === 403) {
        return {
          state: 'authentication_required',
          reasonCode: 'http_authentication_required',
          source: 'http_mcp',
          observedAt: currentNow(),
          evidence: { mcpVerified: false, httpStatus: notifStatus }
        };
      }

      if (notifStatus < 200 || notifStatus >= 300) {
        return {
          state: 'check_failed',
          reasonCode: 'invalid_mcp_response',
          source: 'http_mcp',
          observedAt: currentNow(),
          evidence: { mcpVerified: false, httpStatus: notifStatus }
        };
      }

      return {
        state: 'available',
        reasonCode: 'mcp_initialize_verified',
        source: 'http_mcp',
        observedAt: currentNow(),
        evidence: {
          mcpVerified: true,
          httpStatus: status
        }
      };
    } finally {
      // Attempt bounded DELETE of this OWN session in a finally path even when initialized notification fails
      if (ownSessionId) {
        if (!signal?.aborted) {
          try {
            const deleteHeaders = {
              ...cleanConfiguredHeaders,
              'MCP-Protocol-Version': serverVersion,
              'MCP-Session-Id': ownSessionId
            };
            let deleteSignal = signal;
            if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
              const timeoutSignal = AbortSignal.timeout(1000);
              deleteSignal = (typeof AbortSignal.any === 'function' && signal)
                ? AbortSignal.any([signal, timeoutSignal])
                : timeoutSignal;
            }
            const deleteRes = await fetchImpl(url, {
              method: 'DELETE',
              headers: deleteHeaders,
              redirect: 'manual',
              signal: deleteSignal
            });
            if (deleteRes?.body?.cancel) try { await deleteRes.body.cancel(); } catch {}
          } catch {
            // Disclose cleanup limitations safely without exposing secrets
          }
        }
      }
    }
  };
}

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createVault } from '../src/vault.mjs';
import { openStore } from '../src/store.mjs';
import { createSecurity } from '../src/security.mjs';
import { startManager } from '../src/main.mjs';
import { attachRegistry } from '../src/mcp-registry-store.mjs';
import { sanitizeMcpDto } from '../src/http/mcp-routes.mjs';
import { createRuntimeObserver, normalizeObservation } from '../src/adapters/runtime-observer.mjs';
import { createHttpMcpProbe } from '../src/adapters/http-mcp-observation.mjs';

describe('Runtime Observer Recovery & Contract Suite', () => {

  describe('1. Verified MCP vs Mere 2xx Response', () => {
    it('marks valid MCP initialize + initialized notification as available with mcpVerified true', async () => {
      let callCount = 0;
      let deleteCalled = false;
      const fetchStub = async (url, options) => {
        callCount++;
        if (options.method === 'POST') {
          const body = JSON.parse(options.body);
          if (body.method === 'initialize') {
            assert.equal(options.headers['MCP-Protocol-Version'], '2025-11-25');
            return new Response(JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              result: {
                protocolVersion: '2025-11-25',
                capabilities: { logging: {} },
                serverInfo: { name: 'test-mcp-server', version: '1.2.3' }
              }
            }), {
              status: 200,
              headers: {
                'content-type': 'application/json',
                'mcp-session-id': 'session-xyz-123'
              }
            });
          }
          if (body.method === 'notifications/initialized') {
            assert.equal(options.headers['MCP-Protocol-Version'], '2025-11-25');
            assert.equal(options.headers['MCP-Session-Id'], 'session-xyz-123');
            return new Response(null, { status: 200 });
          }
        }
        if (options.method === 'DELETE') {
          deleteCalled = true;
          assert.equal(options.headers['MCP-Session-Id'], 'session-xyz-123');
          return new Response(null, { status: 200 });
        }
        throw new Error('Unexpected request');
      };

      const probe = createHttpMcpProbe({ fetchImpl: fetchStub });
      const result = await probe({
        serviceId: 'srv-1',
        url: 'http://127.0.0.1:9999/mcp',
        signal: new AbortController().signal
      });

      assert.equal(result.state, 'available');
      assert.equal(result.reasonCode, 'mcp_initialize_verified');
      assert.equal(result.source, 'http_mcp');
      assert.equal(result.evidence.mcpVerified, true);
      assert.equal(result.evidence.httpStatus, 200);
      assert.ok(result.observedAt);
      assert.equal(deleteCalled, true);
    });

    it('rejects mere 2xx non-MCP response (e.g. status ok or HTML) as check_failed / invalid_mcp_response', async () => {
      const fetchStub = async () => {
        return new Response(JSON.stringify({ status: 'ok', message: 'alive' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      };

      const probe = createHttpMcpProbe({ fetchImpl: fetchStub });
      const result = await probe({
        serviceId: 'srv-2',
        url: 'http://127.0.0.1:9999/mcp',
        signal: new AbortController().signal
      });

      assert.equal(result.state, 'check_failed');
      assert.equal(result.reasonCode, 'invalid_mcp_response');
      assert.equal(result.evidence.mcpVerified, false);
      assert.equal(result.evidence.httpStatus, 200);
    });

    it('MCP notification failure and owned session cleanup', async () => {
      let initCalled = false;
      let notifCalled = false;
      let deleteCalled = false;
      let deleteSessionHeader = null;
      let initSessionHeader = null;

      const SECRET = 'private-vault-token-super-secret-xyz';

      const fetchStub = async (url, options) => {
        if (options.method === 'POST') {
          const body = JSON.parse(options.body);
          if (body.method === 'initialize') {
            initCalled = true;
            initSessionHeader = options.headers?.['MCP-Session-Id'] || options.headers?.['mcp-session-id'];
            return new Response(JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              result: {
                protocolVersion: '2025-11-25',
                capabilities: {},
                serverInfo: { name: 'failing-notif-server', version: '1.0.0' }
              }
            }), {
              status: 200,
              headers: {
                'content-type': 'application/json',
                'mcp-session-id': 'own-new-session-789'
              }
            });
          }
          if (body.method === 'notifications/initialized') {
            notifCalled = true;
            return new Response(JSON.stringify({ error: 'Internal Error' }), { status: 500 });
          }
        }
        if (options.method === 'DELETE') {
          deleteCalled = true;
          deleteSessionHeader = options.headers?.['MCP-Session-Id'];
          return new Response(null, { status: 200 });
        }
        throw new Error('Unexpected request');
      };

      const resolveHeaders = async () => ({
        'Authorization': `Bearer ${SECRET}`,
        'mcp-session-id': 'stale-config-session-123',
        'MCP-Protocol-Version': '9999-01-01'
      });

      const probe = createHttpMcpProbe({ resolveHeaders, fetchImpl: fetchStub });
      const result = await probe({
        serviceId: 'srv-fail-notif',
        url: 'http://127.0.0.1:9999/mcp',
        signal: new AbortController().signal
      });

      // 1. Notification 500 does NOT report available; reports check_failed / invalid_mcp_response
      assert.notEqual(result.state, 'available');
      assert.equal(result.state, 'check_failed');
      assert.equal(result.reasonCode, 'invalid_mcp_response');
      assert.equal(result.evidence.mcpVerified, false);

      // 2. Initial request excluded configured session header
      assert.equal(initSessionHeader, undefined);

      // 3. Cleanup DELETE was called in finally path even though notification returned 500
      assert.equal(deleteCalled, true);
      // 4. Cleanup used ONLY the new initialize session ('own-new-session-789'), NOT configured session ('stale-config-session-123')
      assert.equal(deleteSessionHeader, 'own-new-session-789');

      // 5. Secrets don't enter observation DTO
      const resultStr = JSON.stringify(result);
      assert.equal(resultStr.includes(SECRET), false);

      // 6. Test cancellation limits cleanup: if signal is already aborted, DELETE is not performed
      let deleteCalledWhenAborted = false;
      const fetchStubAborted = async (url, options) => {
        if (options?.signal?.aborted) {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          throw err;
        }
        if (options.method === 'POST') {
          return new Response(JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              protocolVersion: '2025-11-25',
              capabilities: {},
              serverInfo: { name: 'failing-notif-server', version: '1.0.0' }
            }
          }), {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'mcp-session-id': 'abort-session-456'
            }
          });
        }
        if (options.method === 'DELETE') {
          deleteCalledWhenAborted = true;
          return new Response(null, { status: 200 });
        }
      };
      const controller = new AbortController();
      controller.abort();
      const probeAborted = createHttpMcpProbe({ fetchImpl: fetchStubAborted });
      const abortedResult = await probeAborted({
        serviceId: 'srv-abort',
        url: 'http://127.0.0.1:9999/mcp',
        signal: controller.signal
      });
      assert.equal(deleteCalledWhenAborted, false);
      assert.equal(abortedResult.state, 'unreachable');
    });
  });

  describe('2. HTTP 401 Auth-Required (no configured-credential assumption)', () => {
    it('reports authentication_required with 401 status when resolver fails or is unauthenticated', async () => {
      const fetchStub = async () => {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'content-type': 'application/json' }
        });
      };

      const failingResolver = async () => {
        throw new Error('Resolver vault locked');
      };

      const probe = createHttpMcpProbe({
        resolveHeaders: failingResolver,
        fetchImpl: fetchStub
      });

      const result = await probe({
        serviceId: 'srv-auth',
        url: 'http://127.0.0.1:9999/mcp',
        signal: new AbortController().signal
      });

      assert.equal(result.state, 'authentication_required');
      assert.equal(result.reasonCode, 'http_authentication_required');
      assert.equal(result.source, 'http_mcp');
      assert.equal(result.evidence.mcpVerified, false);
      assert.equal(result.evidence.httpStatus, 401);
    });
  });

  describe('3. Invalid Reply Handling', () => {
    it('marks broken JSON or error JSON-RPC as check_failed', async () => {
      const fetchStub = async () => {
        return new Response('{ invalid json ...', {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      };

      const probe = createHttpMcpProbe({ fetchImpl: fetchStub });
      const result = await probe({
        serviceId: 'srv-broken',
        url: 'http://127.0.0.1:9999/mcp',
        signal: new AbortController().signal
      });

      assert.equal(result.state, 'check_failed');
      assert.equal(result.reasonCode, 'invalid_mcp_response');
      assert.equal(result.evidence.mcpVerified, false);
    });

    it('marks unsupported protocol version as check_failed / unsupported_transport', async () => {
      const fetchStub = async () => {
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            protocolVersion: '2024-01-01',
            capabilities: {},
            serverInfo: { name: 'legacy', version: '0.1' }
          }
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      };

      const probe = createHttpMcpProbe({ fetchImpl: fetchStub });
      const result = await probe({
        serviceId: 'srv-legacy',
        url: 'http://127.0.0.1:9999/mcp',
        signal: new AbortController().signal
      });

      assert.equal(result.state, 'check_failed');
      assert.equal(result.reasonCode, 'unsupported_transport');
      assert.equal(result.evidence.mcpVerified, false);
    });
  });

  describe('4. Probe Timeout and Network Failures', () => {
    it('returns timeout and unreachable when probe exceeds timeoutMs', async () => {
      let nowTime = 1000;
      const observer = createRuntimeObserver({
        now: () => nowTime,
        timeoutMs: 50,
        probeHttpMcp: async ({ signal }) => {
          return new Promise(resolve => {
            const timer = setTimeout(() => {
              resolve({
                state: 'available',
                reasonCode: 'mcp_initialize_verified',
                source: 'http_mcp',
                observedAt: nowTime,
                evidence: { mcpVerified: true }
              });
            }, 500);
            signal.addEventListener('abort', () => clearTimeout(timer));
          });
        }
      });

      const obs = await observer.observe({
        id: 'srv-timeout',
        revision: 1,
        enabled: true,
        transport: 'http',
        url: 'http://127.0.0.1:9999/mcp'
      });

      assert.equal(obs.state, 'unreachable');
      assert.equal(obs.reasonCode, 'timeout');
      assert.equal(obs.evidence.mcpVerified, false);
      observer.close();
    });
  });

  describe('5. Missing stdio Inspector Handling', () => {
    it('returns external_process_unobserved when transport is stdio and no inspector configured', async () => {
      const observer = createRuntimeObserver({});
      const obs = await observer.observe({
        id: 'stdio-srv',
        revision: 1,
        enabled: true,
        transport: 'stdio'
      });

      assert.equal(obs.state, 'unobserved');
      assert.equal(obs.reasonCode, 'external_process_unobserved');
      assert.equal(obs.source, 'none');
      observer.close();
    });
  });

  describe('6. TTL Expiry Handling', () => {
    it('marks observation as observation_expired when current clock exceeds TTL', () => {
      let nowTime = 100000;
      const raw = {
        state: 'available',
        reasonCode: 'mcp_initialize_verified',
        source: 'http_mcp',
        observedAt: nowTime,
        evidence: { mcpVerified: true }
      };

      const valid = normalizeObservation(raw, { nowMs: nowTime, ttlMs: 90000 });
      assert.equal(valid.state, 'available');
      assert.equal(valid.reasonCode, 'mcp_initialize_verified');

      const expired = normalizeObservation(raw, { nowMs: nowTime + 90001, ttlMs: 90000 });
      assert.equal(expired.state, 'unobserved');
      assert.equal(expired.reasonCode, 'observation_expired');
    });
  });

  describe('7. Request Coalescing and Minimum Interval', () => {
    it('coalesces concurrent observe calls and suppresses probes within minIntervalMs', async () => {
      let probeCalls = 0;
      let nowTime = 50000;

      const observer = createRuntimeObserver({
        now: () => nowTime,
        minIntervalMs: 30000,
        probeHttpMcp: async () => {
          probeCalls++;
          await new Promise(r => setTimeout(r, 10));
          return {
            state: 'available',
            reasonCode: 'mcp_initialize_verified',
            source: 'http_mcp',
            observedAt: nowTime,
            evidence: { mcpVerified: true }
          };
        }
      });

      // Two concurrent calls
      const [r1, r2] = await Promise.all([
        observer.observe({ id: 'coalesce-srv', revision: 1, enabled: true, transport: 'http', url: 'http://test' }),
        observer.observe({ id: 'coalesce-srv', revision: 1, enabled: true, transport: 'http', url: 'http://test' })
      ]);

      assert.equal(probeCalls, 1);
      assert.equal(r1.state, 'available');
      assert.equal(r2.state, 'available');

      // Subsequent call within minIntervalMs (nowTime + 10000)
      nowTime += 10000;
      const r3 = await observer.observe({ id: 'coalesce-srv', revision: 1, enabled: true, transport: 'http', url: 'http://test' });
      assert.equal(probeCalls, 1);
      assert.equal(r3.state, 'available');

      observer.close();
    });
  });

  describe('8. Stale Revision Rejection', () => {
    it('returns configuration_changed when peeking with a stale revision', async () => {
      let nowTime = 10000;
      const observer = createRuntimeObserver({
        now: () => nowTime,
        probeHttpMcp: async () => ({
          state: 'available',
          reasonCode: 'mcp_initialize_verified',
          source: 'http_mcp',
          observedAt: nowTime,
          evidence: { mcpVerified: true }
        })
      });

      await observer.observe({ id: 'rev-srv', revision: 1, enabled: true, transport: 'http', url: 'http://test' });

      // Match revision 1
      const peekCurrent = observer.peek('rev-srv', 1);
      assert.equal(peekCurrent.state, 'available');

      // Mismatch revision 2
      const peekStale = observer.peek('rev-srv', 2);
      assert.equal(peekStale.state, 'unobserved');
      assert.equal(peekStale.reasonCode, 'configuration_changed');

      observer.close();
    });
  });

  describe('9. Observer Close Lifecycle', () => {
    it('cancels pending work and marks subsequent peek/observe as observer_unavailable', async () => {
      const observer = createRuntimeObserver({
        probeHttpMcp: async ({ signal }) => {
          return new Promise(resolve => {
            signal.addEventListener('abort', () => {
              resolve({ state: 'check_failed', reasonCode: 'observer_unavailable', source: 'none', observedAt: null, evidence: {} });
            });
          });
        }
      });

      const pending = observer.observe({ id: 'close-srv', revision: 1, enabled: true, transport: 'http', url: 'http://test' });
      observer.close();

      const result = await pending;
      assert.equal(result.state, 'unobserved');
      assert.equal(result.reasonCode, 'observer_unavailable');

      const afterClose = await observer.observe({ id: 'close-srv', revision: 1, enabled: true, transport: 'http', url: 'http://test' });
      assert.equal(afterClose.state, 'unobserved');
      assert.equal(afterClose.reasonCode, 'observer_unavailable');
    });
  });

  describe('10. Safe DTO Whitelist & Boundary Sanitization', () => {
    it('strictly whitelists observation DTO fields and strips leaked internal props', () => {
      const nowMs = Date.now();
      const dirtyRaw = {
        state: 'available',
        reasonCode: 'mcp_initialize_verified',
        source: 'http_mcp',
        observedAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + 90000).toISOString(),
        evidence: {
          mcpVerified: true,
          httpStatus: 200,
          secretToken: 'SUPER_SECRET',
          internalPid: 1234
        },
        leakedPrivateHeaders: { 'Authorization': 'Bearer secret' }
      };

      const normalized = normalizeObservation(dirtyRaw, { nowMs });
      assert.equal(normalized.state, 'available');
      assert.equal(normalized.evidence.mcpVerified, true);
      assert.equal(normalized.evidence.httpStatus, 200);
      assert.equal(normalized.evidence.secretToken, undefined);
      assert.equal(normalized.evidence.internalPid, undefined);
      assert.equal(normalized.leakedPrivateHeaders, undefined);

      const mcpDto = {
        id: 'test-mcp',
        label: 'Test MCP',
        enabled: true,
        revision: 1,
        runtime: {
          state: 'running',
          observation: normalized
        }
      };

      const sanitized = sanitizeMcpDto(mcpDto);
      assert.ok(sanitized.runtime.observation);
      assert.equal(sanitized.runtime.observation.state, 'available');
      assert.equal(sanitized.runtime.observation.evidence.secretToken, undefined);
    });

    it('exercises real formatter and registry integration with observer attached', () => {
      const db = new DatabaseSync(':memory:');
      const vault = createVault({ dataDir: process.cwd() });

      let nowTime = 1000000;
      const observer = createRuntimeObserver({
        now: () => nowTime,
        probeHttpMcp: async () => ({
          state: 'available',
          reasonCode: 'mcp_initialize_verified',
          source: 'http_mcp',
          observedAt: nowTime,
          evidence: { mcpVerified: true, httpStatus: 200 }
        })
      });

      const registry = attachRegistry({
        db,
        vault,
        observer
      });

      // Initial listServices has normalizeObservation(null)
      const listBefore = registry.listServices();
      assert.ok(listBefore.length > 0);
      assert.equal(listBefore[0].runtime.observation.state, 'unobserved');
      assert.equal(listBefore[0].runtime.observation.reasonCode, 'not_observed');

      // Now observe overleaf-mcp with fake observation in observer
      observer.observe({
        id: 'overleaf-mcp',
        revision: 1,
        enabled: true,
        transport: 'http',
        url: 'http://127.0.0.1:8080/mcp'
      }).then(() => {});

      // Verify through sanitizeMcpDto boundary
      const sanitized = sanitizeMcpDto(listBefore[0]);
      assert.ok(sanitized.runtime);
      assert.equal(sanitized.runtime.state, 'unknown');
      assert.equal(sanitized.runtime.observation.state, 'unobserved');

      observer.close();
      db.close();
    });
  });

  describe('8. Production Observation Wiring & Single-Flight Regression', () => {
    it('production observation wiring and single-flight', async () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-wiring-'));
      const security = await createSecurity({ dataDir });
      const vault = await createVault({ dataDir, security });
      const store = await openStore({ dataDir, vault, security });

      // Register an HTTP service with synthetic private header and safe header
      await store.registry.create({
        id: 'mcp_http_wiring_test',
        label: 'HTTP Wiring Test Service',
        enabled: true,
        binding: {
          type: 'http',
          url: 'http://127.0.0.1:19999/mcp-test-probe',
          headers: {
            'Authorization': { value: 'Bearer SYNTHETIC_SECRET_TOKEN_999', secret: true },
            'X-Synthetic-Agent': { value: 'agent-stub-123', secret: false }
          }
        }
      });

      // Assert definition contains synthetic secret, but public DTO omits it
      const def = store.registry.getDefinition('mcp_http_wiring_test');
      assert.equal(def.binding.headers['Authorization'].value, 'Bearer SYNTHETIC_SECRET_TOKEN_999');

      const publicList = store.registry.listServices();
      const pubService = publicList.find(s => s.id === 'mcp_http_wiring_test');
      assert.ok(pubService, 'registered HTTP service must be in public service list');
      assert.equal(pubService.binding.type, 'http');
      assert.equal(pubService.binding.headers['Authorization'].secret, true);
      assert.equal(pubService.binding.headers['Authorization'].value, undefined, 'public DTO must redact secret header value');
      assert.equal(pubService.binding.headers['X-Synthetic-Agent'].value, 'agent-stub-123');

      // Assert private header resolution via probe stub
      let dispatchedAuthHeader = null;
      const probeStub = createHttpMcpProbe({
        resolveHeaders: async (id) => store.registry.getDefinition(id)?.binding?.headers,
        fetchImpl: async (url, opts) => {
          dispatchedAuthHeader = opts.headers?.['Authorization'];
          return new Response(JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              protocolVersion: '2025-11-25',
              capabilities: {},
              serverInfo: { name: 'synthetic-server', version: '1.0.0' }
            }
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
      });
      await probeStub({ serviceId: 'mcp_http_wiring_test', url: 'http://127.0.0.1:19999/mcp-test-probe' });
      assert.equal(dispatchedAuthHeader, 'Bearer SYNTHETIC_SECRET_TOKEN_999', 'probe must resolve and forward private header');

      // Test single-flight scheduler and max 2 concurrency
      let inFlight = 0;
      let maxActive = 0;
      const observedTargets = [];
      let releaseHold;
      const hold = new Promise(r => { releaseHold = r; });

      const fakeObserver = {
        async observe(target) {
          observedTargets.push({ ...target });
          inFlight++;
          maxActive = Math.max(maxActive, inFlight);
          await hold;
          inFlight--;
          return {
            state: 'available',
            reasonCode: 'mcp_initialize_verified',
            source: 'http_mcp',
            observedAt: new Date().toISOString(),
            evidence: { mcpVerified: true }
          };
        },
        peek() {
          return { state: 'unobserved', reasonCode: 'not_observed', source: 'none' };
        }
        // Deliberately omit observer.close() to verify shutdown handles injected observer without TypeError
      };

      const manager = await startManager({
        dataDir,
        port: 0,
        security,
        vault,
        store,
        observer: fakeObserver
      });

      // Trigger second collection cycle via 30s timer while first cycle is in flight
      mock.timers.enable({ apis: ['setInterval'] });
      mock.timers.tick(30000);
      mock.timers.reset();

      // Release in-flight observation hold and allow workers to finish
      releaseHold();

      // Close manager safely (verifies optional close hook and awaiting in-flight collection)
      await manager.close();

      // Assert concurrency never exceeded 2 across overlapping cycles
      assert.ok(maxActive <= 2, `max concurrent observations must not exceed 2 (was ${maxActive})`);

      // Verify real initial collection received registered HTTP service's actual id/revision/url/type
      const httpTarget = observedTargets.find(t => t.id === 'mcp_http_wiring_test');
      assert.ok(httpTarget, 'initial collection cycle must have observed the registered HTTP service');
      assert.equal(httpTarget.id, 'mcp_http_wiring_test');
      assert.equal(httpTarget.revision, 1);
      assert.equal(httpTarget.transport, 'http');
      assert.equal(httpTarget.url, 'http://127.0.0.1:19999/mcp-test-probe');
      assert.equal(httpTarget.enabled, true);

      // Clean up temp dir
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
    });
  });

});

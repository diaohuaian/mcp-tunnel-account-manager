import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { issueCarrierConfirmation, verifyCarrierConfirmation } from '../../src/core/carrier-confirmation.mjs';
import { openStore } from '../../src/store.mjs';
import { createMcpDiscovery } from '../../src/config/mcp-discovery.mjs';

function createAsyncSyntheticVault() {
  const table = new Map();
  return {
    async seal(val, aad) {
      // Intentionally async to verify caller truly awaits
      await new Promise(resolve => setTimeout(resolve, 5));
      const id = 'tok_' + Math.random().toString(36).slice(2);
      table.set(id, { val: structuredClone(val), aad });
      return { token: id, aad };
    },
    async unseal(env, expectedAad) {
      await new Promise(resolve => setTimeout(resolve, 5));
      if (!env || typeof env !== 'object' || !env.token) {
        throw new Error('INVALID_TOKEN_FORMAT');
      }
      const record = table.get(env.token);
      if (!record) {
        throw new Error('TOKEN_NOT_FOUND');
      }
      if (expectedAad && record.aad !== expectedAad) {
        throw new Error('AAD_MISMATCH');
      }
      return structuredClone(record.val);
    }
  };
}

describe('Carrier Confirmation & Privacy Boundary Regression Suite', () => {
  let tmpDir;
  let vault;
  let nowMs;
  let validCtx;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carrier-privacy-test-'));
    vault = createAsyncSyntheticVault();
    nowMs = Date.now();
    validCtx = {
      action: 'restart',
      serviceId: 'antigravity-mcp',
      serviceRevision: 2,
      profileId: 'prof_default',
      sessionBinding: 'sess_user_alpha_12345',
      idempotencyKey: 'idemp_op_987654321',
      identity: {
        pid: 1234,
        startedAt: new Date(nowMs - 60000).toISOString(),
        executablePath: 'C:\\Program Files\\Node\\node.exe',
        verified: true
      },
      absenceVerified: false
    };
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('1. issueCarrierConfirmation & verifyCarrierConfirmation Core', () => {
    it('truly awaits async seal and produces a valid unsealable confirmation token', async () => {
      const token = await issueCarrierConfirmation(vault, validCtx, nowMs);
      assert.ok(token);
      assert.equal(typeof token, 'object');
      assert.ok(token.token);

      const verified = await verifyCarrierConfirmation(vault, token, validCtx, nowMs);
      assert.equal(verified, true);
    });

    it('rejects verification if process PID changed', async () => {
      const token = await issueCarrierConfirmation(vault, validCtx, nowMs);
      const mutatedCtx = {
        ...validCtx,
        identity: { ...validCtx.identity, pid: 9999 }
      };
      const verified = await verifyCarrierConfirmation(vault, token, mutatedCtx, nowMs);
      assert.equal(verified, false);
    });

    it('rejects verification if process start-time changed', async () => {
      const token = await issueCarrierConfirmation(vault, validCtx, nowMs);
      const mutatedCtx = {
        ...validCtx,
        identity: { ...validCtx.identity, startedAt: new Date(nowMs - 5000).toISOString() }
      };
      const verified = await verifyCarrierConfirmation(vault, token, mutatedCtx, nowMs);
      assert.equal(verified, false);
    });

    it('rejects verification if service revision changed', async () => {
      const token = await issueCarrierConfirmation(vault, validCtx, nowMs);
      const mutatedCtx = {
        ...validCtx,
        serviceRevision: 3
      };
      const verified = await verifyCarrierConfirmation(vault, token, mutatedCtx, nowMs);
      assert.equal(verified, false);
    });

    it('rejects verification if action changed (e.g. issued for restart, attempted for stop)', async () => {
      const token = await issueCarrierConfirmation(vault, validCtx, nowMs);
      const mutatedCtx = {
        ...validCtx,
        action: 'stop',
        profileId: null
      };
      const verified = await verifyCarrierConfirmation(vault, token, mutatedCtx, nowMs);
      assert.equal(verified, false);
    });

    it('rejects verification if profileId changed', async () => {
      const token = await issueCarrierConfirmation(vault, validCtx, nowMs);
      const mutatedCtx = {
        ...validCtx,
        profileId: 'prof_different'
      };
      const verified = await verifyCarrierConfirmation(vault, token, mutatedCtx, nowMs);
      assert.equal(verified, false);
    });

    it('rejects verification if sessionBinding changed', async () => {
      const token = await issueCarrierConfirmation(vault, validCtx, nowMs);
      const mutatedCtx = {
        ...validCtx,
        sessionBinding: 'sess_attacker_hijack'
      };
      const verified = await verifyCarrierConfirmation(vault, token, mutatedCtx, nowMs);
      assert.equal(verified, false);
    });

    it('rejects verification if idempotencyKey changed', async () => {
      const token = await issueCarrierConfirmation(vault, validCtx, nowMs);
      const mutatedCtx = {
        ...validCtx,
        idempotencyKey: 'idemp_different_subsequent_call'
      };
      const verified = await verifyCarrierConfirmation(vault, token, mutatedCtx, nowMs);
      assert.equal(verified, false);
    });

    it('rejects verification when token is expired (> 120s)', async () => {
      const token = await issueCarrierConfirmation(vault, validCtx, nowMs);
      const expiredMs = nowMs + 125000;
      const verified = await verifyCarrierConfirmation(vault, token, validCtx, expiredMs);
      assert.equal(verified, false);
    });

    it('rejects static, unsealed, or forgeable fallback tokens', async () => {
      const fakeStatic = 'carrier-preview-antigravity-mcp';
      const verifiedStatic = await verifyCarrierConfirmation(vault, fakeStatic, validCtx, nowMs);
      assert.equal(verifiedStatic, false);

      const fakeObject = { token: 'nonexistent-token', aad: 'mcp-tunnel-carrier-confirmation-v2' };
      const verifiedObject = await verifyCarrierConfirmation(vault, fakeObject, validCtx, nowMs);
      assert.equal(verifiedObject, false);
    });
  });

  describe('2. Idempotency Deduplication Persistence', () => {
    it('duplicate submission with identical idempotencyKey returns existing action and does not create second operation', async () => {
      const storeVault = {
        seal: (v, aad) => JSON.stringify({ c: v, aad }),
        unseal: (e) => {
          const parsed = typeof e === 'string' ? JSON.parse(e) : e;
          return parsed.c;
        }
      };

      const store = openStore({ dataDir: tmpDir, vault: storeVault });
      const reg = store.registry;

      // Seed service and profile
      await reg.create({
        id: 'mcp_carrier_test_svc',
        label: 'Carrier Test Service',
        controlCarrier: true,
        binding: { type: 'stdio', executable: 'node.exe', args: [] }
      });

      await store.createProfile({
        id: 'prof_test_idemp',
        label: 'Idemp Test Profile',
        services: {
          'mcp_carrier_test_svc': { apiKey: 'key-123', tunnelId: 'tun-123' }
        }
      });

      const key = 'test-idemp-dedup-key-001';
      const act1 = await reg.createLifecycleAction({
        action: 'restart',
        serviceId: 'mcp_carrier_test_svc',
        profileId: 'prof_test_idemp',
        idempotencyKey: key
      });

      assert.ok(act1);
      assert.ok(act1.id);

      // Re-submit with same idempotency key
      const act2 = await reg.createLifecycleAction({
        action: 'restart',
        serviceId: 'mcp_carrier_test_svc',
        profileId: 'prof_test_idemp',
        idempotencyKey: key
      });

      assert.equal(act2.id, act1.id);

      // Verify DB count
      const allPending = reg.listPendingActionIds();
      const matching = allPending.filter(id => id === act1.id);
      assert.equal(matching.length, 1);

      store.close();
    });
  });

  describe('3. Public DTO Privacy Boundary & Fingerprint Protection', () => {
    it('formatProfileDTO and listProfiles omit provenance_identity and private credential derived identities', async () => {
      const storeVault = {
        seal: (v) => JSON.stringify(v),
        unseal: (e) => (typeof e === 'string' ? JSON.parse(e) : e)
      };

      const store = openStore({ dataDir: tmpDir, vault: storeVault });
      const created = await store.createProfile({
        id: 'prof_privacy_check',
        label: 'Privacy Check Profile',
        provenanceIdentity: 'private-secret-hmac-derived-identity-123',
        services: {
          'test-svc': { apiKey: 'sk-test-secret-key-456', tunnelId: 'tun-secret-789' }
        }
      });

      // Direct created profile DTO check
      assert.equal(created.provenance_identity, undefined);
      assert.equal(created.provenanceIdentity, undefined);

      // listProfiles DTO check
      const profiles = await store.listProfiles();
      const found = profiles.find(p => p.id === 'prof_privacy_check');
      assert.ok(found);
      assert.equal(found.provenance_identity, undefined);
      assert.equal(found.provenanceIdentity, undefined);

      // Store internal provenance check must work via private method
      assert.equal(store.hasProfileProvenance('private-secret-hmac-derived-identity-123'), false); // was not saved under provenance_identity column without explicit provenance identity

      store.close();
    });

    it('discovery candidates and inventory do not leak canonicalFingerprint, privateHmacKey, or internal HMAC', async () => {
      const discoveryVault = {
        seal: (v) => JSON.stringify(v),
        unseal: (e) => (typeof e === 'string' ? JSON.parse(e) : e)
      };

      const configPath = path.join(tmpDir, 'test-mcp-source.yaml');
      fs.writeFileSync(configPath, 'mcpServers:\n  myserver:\n    command: node\n    args: ["index.js"]\n', 'utf8');

      const discovery = createMcpDiscovery({
        dataDir: tmpDir,
        vault: discoveryVault,
        sources: [{ path: configPath, kind: 'yaml', label: 'Test YAML' }]
      });

      const candidates = await discovery.scan();
      assert.equal(candidates.length, 1);
      const cand = candidates[0];

      // Public candidate must omit canonicalFingerprint and private HMAC keys
      assert.equal(cand.canonicalFingerprint, undefined);
      assert.equal(cand.privateHmacKey, undefined);
      assert.equal(cand.hmacKey, undefined);
      assert.ok(cand.fingerprint, 'Public candidate must retain standard sha256 fingerprint');

      // Check inventory
      const inventory = await discovery.getInventory();
      assert.ok(Array.isArray(inventory));
      assert.equal(inventory.length, 1);
      const inv = inventory[0];
      assert.equal(inv.canonicalFingerprint, undefined);
      assert.equal(inv.privateHmacKey, undefined);
    });
  });
});

import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createVault } from '../../src/vault.mjs';
import {
  compileHttpTransport,
  sealHttpTransport,
  openHttpTransport,
  clearInheritedMcpOverrides,
  mergeHttpLaunchEnvironment,
  fingerprintHttpConfiguration,
  HTTP_HEADER_ENV_PREFIX
} from '../../src/adapters/http-transport.mjs';
import {
  publicBinding,
  mergeHeadersPatch,
  mergeBinding
} from '../../src/adapters/mcp-binding.mjs';

function createTempDir(prefix = 'http-state-e2e-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('HTTP Private State & Cipher Packet E2E Suite', () => {

  it('1. Private env cipher packet persistence across restart with master.key on disk', async () => {
    const tmpDir = createTempDir('http-persist-');
    const dataDir = path.join(tmpDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });

    const context = { serviceId: 'mcp_stateful_http', operationId: 'op-persist-101' };
    const binding = {
      type: 'http',
      url: 'https://mcp.vault-test.local:8443/mcp?apiKey=secret-key-xyz&batch=1,2,3&token=tok_live_456',
      headers: {
        Authorization: { value: 'Bearer sec_token_secret_999', secret: true },
        'X-Private-Key': { value: 'priv_val_abcdef', secret: true },
        'X-Client-Id': { value: 'client_visible_123', secret: false }
      }
    };

    // Step 1: Initialize first vault session backed by master.key
    const vault1 = createVault({ dataDir });
    const plan1 = compileHttpTransport(binding, context);

    // Step 2: Seal HTTP transport into ciphertext envelope
    const sealedPacket = await sealHttpTransport(vault1, binding, context);

    // Step 3: Verify ciphertext packet structure and privacy (no secrets in plaintext)
    assert.equal(sealedPacket.version, 1);
    assert.equal(sealedPacket.serviceId, context.serviceId);
    assert.equal(sealedPacket.operationId, context.operationId);
    assert.deepEqual(sealedPacket.headerNames, ['Authorization', 'X-Client-Id', 'X-Private-Key']);

    const serialized = JSON.stringify(sealedPacket);
    assert.doesNotMatch(serialized, /secret-key-xyz/);
    assert.doesNotMatch(serialized, /sec_token_secret_999/);
    assert.doesNotMatch(serialized, /priv_val_abcdef/);
    assert.doesNotMatch(serialized, /mcp\.vault-test\.local/);

    // Step 4: Persist packet to protected runtime storage path
    const packetDir = path.join(dataDir, 'runtime', context.serviceId, context.operationId);
    fs.mkdirSync(packetDir, { recursive: true });
    const packetPath = path.join(packetDir, 'http-transport-packet.json');
    fs.writeFileSync(packetPath, serialized, 'utf8');

    // Step 5: Simulate process crash / manager shutdown by closing vault
    vault1.close();
    assert.throws(() => vault1.seal({ a: 1 }, 'aad'), /Vault is closed/);

    // Step 6: Simulate restart: reopen vault from disk master.key in dataDir
    const vault2 = createVault({ dataDir });
    const loadedPacket = JSON.parse(fs.readFileSync(packetPath, 'utf8'));

    // Step 7: Decrypt and restore exact transport plan
    const restoredPlan = await openHttpTransport(vault2, loadedPacket, context);

    assert.equal(restoredPlan.kind, 'http');
    assert.equal(restoredPlan.channel, 'main');
    assert.equal(restoredPlan.privateEnvironment.MCP_SERVER_URL, binding.url);
    assert.equal(
      restoredPlan.privateEnvironment.MCP_SERVER_URL,
      'https://mcp.vault-test.local:8443/mcp?apiKey=secret-key-xyz&batch=1,2,3&token=tok_live_456',
      'Preserves signed URL query parameters and commas across restart'
    );
    assert.deepEqual(restoredPlan.headerNames, plan1.headerNames);
    assert.deepEqual(restoredPlan.args, plan1.args);

    // Header values restored accurately
    assert.equal(
      Object.values(restoredPlan.privateEnvironment).find(v => v === 'Bearer sec_token_secret_999'),
      'Bearer sec_token_secret_999'
    );
    assert.equal(
      Object.values(restoredPlan.privateEnvironment).find(v => v === 'priv_val_abcdef'),
      'priv_val_abcdef'
    );

    vault2.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('2. Wrong AAD, cross-service replay, and payload tampering rejected before effects', async () => {
    const tmpDir = createTempDir('http-tamper-');
    const dataDir = path.join(tmpDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const vault = createVault({ dataDir });

    try {
      const context = { serviceId: 'mcp_tamper_svc', operationId: 'op-tamper-valid' };
      const binding = {
        type: 'http',
        url: 'https://mcp.example.com/api',
        headers: { Authorization: { value: 'Bearer secret-auth', secret: true } }
      };

      const packet = await sealHttpTransport(vault, binding, context);

      // 2.1 Replay across mismatched serviceId rejected with INVALID_HTTP_STATE
      const wrongService = { serviceId: 'mcp_other_svc', operationId: 'op-tamper-valid' };
      await assert.rejects(
        openHttpTransport(vault, packet, wrongService),
        { code: 'INVALID_HTTP_STATE' },
        'Cross-service replay must fail before decryption'
      );

      // 2.2 Replay across mismatched operationId rejected with INVALID_HTTP_STATE
      const wrongOp = { serviceId: 'mcp_tamper_svc', operationId: 'op-tamper-other' };
      await assert.rejects(
        openHttpTransport(vault, packet, wrongOp),
        { code: 'INVALID_HTTP_STATE' },
        'Cross-operation replay must fail before decryption'
      );

      // 2.3 Ciphertext bit-flip tampering rejected with HTTP_STATE_UNREADABLE
      const tamperedPacket = JSON.parse(JSON.stringify(packet));
      const cipherBytes = Buffer.from(tamperedPacket.environmentEnvelope.data, 'hex');
      cipherBytes[0] ^= 0xff;
      tamperedPacket.environmentEnvelope.data = cipherBytes.toString('hex');

      await assert.rejects(
        openHttpTransport(vault, tamperedPacket, context),
        { code: 'HTTP_STATE_UNREADABLE' },
        'Tampered ciphertext must be rejected by AES-GCM tag verification'
      );

      // 2.4 Header names tampering rejected
      const tamperedHeaderNames = { ...packet, headerNames: ['Authorization', 'Injected-Header'] };
      await assert.rejects(
        openHttpTransport(vault, tamperedHeaderNames, context),
        { code: 'INVALID_HTTP_STATE' },
        'Injected header names must be rejected'
      );

      // 2.5 Null vault rejects with HTTP_VAULT_REQUIRED
      await assert.rejects(
        sealHttpTransport(null, binding, context),
        { code: 'HTTP_VAULT_REQUIRED' }
      );
      await assert.rejects(
        openHttpTransport(null, packet, context),
        { code: 'HTTP_VAULT_REQUIRED' }
      );
    } finally {
      try { vault.close(); } catch (_) {}
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  it('3. Rollback between HTTP and stdio scrubs stale transport host variables without leaking secrets', async () => {
    const tmpDir = createTempDir('http-rollback-');
    const dataDir = path.join(tmpDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const vault = createVault({ dataDir });

    try {
      const context = { serviceId: 'mcp_switchable_service', operationId: 'op-switch-1' };
      const httpBinding = {
        type: 'http',
        url: 'https://mcp.live.internal/mcp?sig=token999&commas=x,y,z',
        headers: {
          Authorization: { value: 'Bearer auth-token-secret-123', secret: true },
          'X-Client': { value: 'client-active', secret: false }
        }
      };

      // 1. Compile and seal HTTP transport
      const httpPlan = compileHttpTransport(httpBinding, context);
      const httpPacket = await sealHttpTransport(vault, httpBinding, context);

      // 2. Simulate launch environment merge
      const inheritedHostEnv = {
        PATH: 'C:\\Windows\\system32;C:\\Program Files\\nodejs',
        SYSTEMROOT: 'C:\\Windows',
        USERPROFILE: 'C:\\Users\\fixture-user',
        UNRELATED_HOST_VAR: 'keep-me-safe',
        mcp_command: 'stale-leftover-command'
      };

      const serviceEnv = {
        APP_ENV: 'production',
        LOG_LEVEL: 'info'
      };

      const httpMergedEnv = mergeHttpLaunchEnvironment(inheritedHostEnv, serviceEnv, httpPlan);

      // Verify HTTP launch environment properties
      assert.equal(httpMergedEnv.MCP_SERVER_URL, httpBinding.url);
      assert.equal(httpMergedEnv.mcp_command, undefined, 'Stale inherited transport commands scrubbed');
      assert.equal(httpMergedEnv.PATH, inheritedHostEnv.PATH);
      assert.equal(httpMergedEnv.APP_ENV, 'production');

      // 3. Rollback from HTTP to stdio transport:
      // clearInheritedMcpOverrides must scrub all MCP transport variables case-insensitively
      const stdioLaunchEnv = clearInheritedMcpOverrides(httpMergedEnv);

      assert.equal(stdioLaunchEnv.MCP_SERVER_URL, undefined, 'MCP_SERVER_URL scrubbed upon stdio rollback');
      assert.equal(stdioLaunchEnv.MCP_COMMAND, undefined);
      assert.equal(stdioLaunchEnv.MCP_EXTRA_HEADERS, undefined);
      assert.equal(stdioLaunchEnv.MCP_DISCOVERY_EXTRA_HEADERS, undefined);

      // All TUNNEL_CLIENT_MCP_HEADER_* variables scrubbed
      const remainingHeaderKeys = Object.keys(stdioLaunchEnv).filter(k =>
        k.toUpperCase().startsWith(HTTP_HEADER_ENV_PREFIX)
      );
      assert.equal(remainingHeaderKeys.length, 0, 'All private header variables scrubbed from stdio environment');

      // Safe non-transport variables preserved
      assert.equal(stdioLaunchEnv.PATH, inheritedHostEnv.PATH);
      assert.equal(stdioLaunchEnv.UNRELATED_HOST_VAR, 'keep-me-safe');
      assert.equal(stdioLaunchEnv.APP_ENV, 'production');

      // 4. Rollback back to HTTP transport:
      // Restoring the original sealed packet cleanly recovers original HTTP endpoint and headers
      const restoredHttpPlan = await openHttpTransport(vault, httpPacket, context);
      assert.equal(restoredHttpPlan.privateEnvironment.MCP_SERVER_URL, httpBinding.url);
      assert.deepEqual(restoredHttpPlan.args, httpPlan.args);
    } finally {
      try { vault.close(); } catch (_) {}
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  it('4. Immutable per-operation capsule survives definition edits and enforces generation binding', async () => {
    const tmpDir = createTempDir('http-gen-');
    const dataDir = path.join(tmpDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const vault = createVault({ dataDir });

    try {
      const serviceId = 'mcp_mutable_service';

      // Operation 1 captures initial definition
      const defV1 = {
        id: serviceId,
        binding: {
          type: 'http',
          url: 'https://mcp.endpoint.v1/api?token=v1-secret-key',
          headers: { Authorization: { value: 'Bearer token-v1', secret: true } }
        }
      };
      const contextOp1 = { serviceId, operationId: 'op-generation-1' };
      const packetOp1 = await sealHttpTransport(vault, defV1.binding, contextOp1);

      // Service definition in registry is subsequently mutated to V2
      const defV2 = {
        id: serviceId,
        binding: {
          type: 'http',
          url: 'https://mcp.endpoint.v2/api?token=v2-secret-key',
          headers: { Authorization: { value: 'Bearer token-v2', secret: true } }
        }
      };
      const contextOp2 = { serviceId, operationId: 'op-generation-2' };
      const packetOp2 = await sealHttpTransport(vault, defV2.binding, contextOp2);

      // Op 1 capsule remains strictly bound to Op 1 definition
      const restoredOp1 = await openHttpTransport(vault, packetOp1, contextOp1);
      assert.equal(restoredOp1.privateEnvironment.MCP_SERVER_URL, defV1.binding.url);
      assert.equal(Object.values(restoredOp1.privateEnvironment)[1], 'Bearer token-v1');

      // Op 2 capsule reflects V2
      const restoredOp2 = await openHttpTransport(vault, packetOp2, contextOp2);
      assert.equal(restoredOp2.privateEnvironment.MCP_SERVER_URL, defV2.binding.url);
      assert.equal(Object.values(restoredOp2.privateEnvironment)[1], 'Bearer token-v2');

      // Cross-context verification fails
      await assert.rejects(
        openHttpTransport(vault, packetOp1, contextOp2),
        { code: 'INVALID_HTTP_STATE' }
      );
    } finally {
      try { vault.close(); } catch (_) {}
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  it('5. Fingerprint binds profile and encrypted packet bytes without leaking plaintext secrets', async () => {
    const tmpDir = createTempDir('http-fp-');
    const dataDir = path.join(tmpDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const vault = createVault({ dataDir });

    try {
      const context = { serviceId: 'mcp_fp_test', operationId: 'op-fp-10' };
      const binding = {
        type: 'http',
        url: 'https://mcp.fp.local/mcp?secretToken=xyz999',
        headers: { Authorization: { value: 'Bearer top-secret', secret: true } }
      };

      const profileYaml = 'config_version: 1\ncontrol_plane:\n  tunnel_id: "tunnel_123"\n';
      const sealedPacket = await sealHttpTransport(vault, binding, context);
      const packetBytes = Buffer.from(JSON.stringify(sealedPacket), 'utf8');

      // Compute canonical fingerprint
      const fp1 = fingerprintHttpConfiguration(profileYaml, packetBytes);
      assert.match(fp1, /^[0-9a-f]{64}$/);

      // Deterministic: same inputs yield same fingerprint
      const fp2 = fingerprintHttpConfiguration(profileYaml, packetBytes);
      assert.equal(fp1, fp2);

      // Modifying profile bytes alters fingerprint
      const modifiedYaml = profileYaml + '# comment\n';
      const fpModifiedProfile = fingerprintHttpConfiguration(modifiedYaml, packetBytes);
      assert.notEqual(fp1, fpModifiedProfile);

      // Modifying packet alters fingerprint
      const tamperedPacketBytes = Buffer.from(packetBytes);
      tamperedPacketBytes[tamperedPacketBytes.length - 1] ^= 0x01;
      const fpModifiedPacket = fingerprintHttpConfiguration(profileYaml, tamperedPacketBytes);
      assert.notEqual(fp1, fpModifiedPacket);

      // Public binding DTO omits raw URL with sensitive query
      const pub = publicBinding(binding);
      assert.equal(pub.hasPrivateQuery, true);
      assert.equal(pub.url, undefined, 'Raw secret URL omitted from public representation');
      assert.equal(pub.urlDisplay, 'https://mcp.fp.local/mcp');
      assert.doesNotMatch(pub.urlDisplay, /secretToken/);
    } finally {
      try { vault.close(); } catch (_) {}
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  it('6. Header retention, explicit removal, and patch semantics with secret protection', () => {
    const previousHeaders = {
      Authorization: { value: 'Bearer retained-secret', secret: true },
      'X-Tenant-Key': { value: 'tenant-secret-123', secret: true },
      'X-Public-Tag': { value: 'tag-one', secret: false }
    };

    // Patch: remove X-Tenant-Key, set X-Public-Tag, add X-New-Secret, omit Authorization
    const patch = [
      { name: 'X-Tenant-Key', op: 'remove' },
      { name: 'X-Public-Tag', op: 'set', value: 'tag-updated', secret: false },
      { name: 'X-New-Secret', op: 'set', value: 'new-secret-val' }
    ];

    const merged = mergeHeadersPatch(previousHeaders, patch);

    // Authorization retained with secret preserved
    assert.equal(merged.Authorization.value, 'Bearer retained-secret');
    assert.equal(merged.Authorization.secret, true);

    // X-Tenant-Key removed
    assert.equal(merged['X-Tenant-Key'], undefined);

    // X-Public-Tag updated
    assert.equal(merged['X-Public-Tag'].value, 'tag-updated');
    assert.equal(merged['X-Public-Tag'].secret, false);

    // X-New-Secret defaults to secret: true
    assert.equal(merged['X-New-Secret'].value, 'new-secret-val');
    assert.equal(merged['X-New-Secret'].secret, true);

    // Sensitive names cannot have secret: false
    const sensitivePatch = [
      { name: 'API-KEY', op: 'set', value: 'secret-key-1', secret: false }
    ];
    const sensitiveMerged = mergeHeadersPatch({}, sensitivePatch);
    assert.equal(sensitiveMerged['API-KEY'].secret, true, 'Sensitive header name must remain secret');
  });

});

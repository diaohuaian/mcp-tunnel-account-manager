import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMaskedTunnelId, maskTunnelId, resolveKnownRealTunnelId, openStore } from '../src/store.mjs';
import { createVault } from '../src/vault.mjs';
import { buildProfileServicesPayload } from '../public/app.js';
import { createAdapters } from '../src/adapters/index.mjs';

const tempParent = fs.realpathSync(os.tmpdir());
const tempDir = fs.mkdtempSync(path.join(tempParent, 'mcp-tunnel-mask-test-'));
const openStores = [];

after(async () => {
  for (const s of openStores) {
    try { await s.close(); } catch (_) {}
  }
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {}
});

test('isMaskedTunnelId identifies masked and unmasked tunnel IDs', () => {
  assert.equal(isMaskedTunnelId('tun...41a5'), true);
  assert.equal(isMaskedTunnelId('tunnel_...41a5'), true);
  assert.equal(isMaskedTunnelId('***'), true);
  assert.equal(isMaskedTunnelId('t***5'), true);
  assert.equal(isMaskedTunnelId(''), false);
  assert.equal(isMaskedTunnelId(null), false);
  assert.equal(isMaskedTunnelId('tunnel_mock_overleaf_00000000000041a5'), false);
  assert.equal(isMaskedTunnelId('tunnel_mock_antigrav_000000000000ce17'), false);
});

test('buildProfileServicesPayload omits masked or unchanged tunnel IDs on edit', () => {
  const registered = [{ id: 'overleaf-mcp' }, { id: 'antigravity-mcp' }];
  
  // Case 1: Editing, user kept the masked tunnel ID as-is (should be omitted from patch)
  const inputsUnchanged = {
    'overleaf-mcp': {
      tunnelId: 'tun...41a5',
      initialTunnelId: 'tun...41a5',
      apiKey: '',
      orgId: ''
    },
    'antigravity-mcp': {
      tunnelId: 'tun...ce17',
      initialTunnelId: 'tun...ce17',
      apiKey: '',
      orgId: ''
    }
  };
  const payload1 = buildProfileServicesPayload(registered, inputsUnchanged, true);
  assert.equal(payload1['overleaf-mcp'], undefined);
  assert.equal(payload1['antigravity-mcp'], undefined);

  // Case 2: Editing, user cleared tunnel ID to leave it blank (preserve existing)
  const inputsBlank = {
    'overleaf-mcp': {
      tunnelId: '',
      initialTunnelId: 'tun...41a5',
      apiKey: '',
      orgId: ''
    }
  };
  const payload2 = buildProfileServicesPayload(registered, inputsBlank, true);
  assert.equal(payload2['overleaf-mcp'], undefined);

  // Case 3: Editing, user entered a new real tunnel ID
  const inputsNewTunnel = {
    'overleaf-mcp': {
      tunnelId: 'tunnel_new_overleaf_1234567890abcdef',
      initialTunnelId: 'tun...41a5',
      apiKey: '',
      orgId: ''
    }
  };
  const payload3 = buildProfileServicesPayload(registered, inputsNewTunnel, true);
  assert.equal(payload3['overleaf-mcp'].tunnelId, 'tunnel_new_overleaf_1234567890abcdef');
});

test('store.patchProfile preserves existing real credentials when given masked tunnel ID', async () => {
  const dataDir = path.join(tempDir, 'data-patch-test');
  const vault = createVault({ dataDir });
  const store = openStore({ dataDir, vault });
  openStores.push(store);

  const mockTunnelId = 'tunnel_mock_overleaf_00000000000041a5';
  const profile = await store.createProfile({
    label: 'Test Profile',
    services: {
      'overleaf-mcp': {
        tunnelId: mockTunnelId,
        apiKey: 'test-api-key-1'
      }
    }
  });

  // Now simulate frontend sending masked tunnel ID in PATCH
  const patched = await store.patchProfile(profile.id, {
    label: 'Updated Test Profile',
    services: {
      'overleaf-mcp': {
        tunnelId: 'tun...41a5' // masked!
      }
    }
  });

  // Verify the unsealed credential still has the REAL unmasked tunnel ID
  const creds = await store.getProfileCredentials(profile.id, 'overleaf-mcp');
  assert.equal(creds.tunnelId, mockTunnelId);
  assert.equal(creds.apiKey, 'test-api-key-1');
  assert.equal(patched.services['overleaf-mcp'].maskedTunnelId, 'tun...41a5');
});

test('resolveKnownRealTunnelId finds real tunnel ID by suffix and service alias', () => {
  const configDir = path.join(tempDir, 'yaml-configs');
  fs.mkdirSync(configDir, { recursive: true });
  const mockTunnelId = 'tunnel_mock_overleaf_00000000000041a5';
  fs.writeFileSync(path.join(configDir, 'overleaf-local.yaml'), `
config_version: 1
control_plane:
  tunnel_id: "${mockTunnelId}"
`);

  const resolved = resolveKnownRealTunnelId('overleaf-mcp', 'tun...41a5', [configDir]);
  assert.equal(resolved, mockTunnelId);
});

test('adapter.prepare rejects masked tunnel ID with TARGET_VERIFICATION_UNAVAILABLE', async () => {
  const dataDir = path.join(tempDir, 'adapter-test');
  const vault = createVault({ dataDir });
  const store = openStore({ dataDir, vault });
  openStores.push(store);

  const adapters = createAdapters({
    dataDir,
    vault,
    store,
    definitions: [{ id: 'overleaf-mcp', binding: { type: 'stdio', executable: 'node' } }]
  });

  const adapter = adapters['overleaf-mcp'];
  await assert.rejects(async () => {
    await adapter.prepare({
      operationId: 'op-mask-test',
      credential: {
        tunnelId: 'tun...41a5', // masked
        apiKey: 'test-key'
      }
    });
  }, (err) => {
    assert.equal(err.code, 'TARGET_VERIFICATION_UNAVAILABLE');
    return true;
  });
});

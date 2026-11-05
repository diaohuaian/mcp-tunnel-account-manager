import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import {
  persistHttpState,
  loadHttpState,
  getHttpStatePath,
  plansEqual,
  fingerprintHttpConfiguration,
  compileHttpTransport,
  HttpStateStoreFault,
  HttpTransportFault
} from '../src/adapters/http-state-store.mjs';

function syntheticVault() {
  const key = randomBytes(32);
  return {
    seal(value, aad) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(aad));
      return {
        iv: iv.toString('hex'),
        data: Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]).toString('hex'),
        tag: cipher.getAuthTag().toString('hex')
      };
    },
    unseal(packet, aad) {
      const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(packet.iv, 'hex'));
      cipher.setAAD(Buffer.from(aad));
      cipher.setAuthTag(Buffer.from(packet.tag, 'hex'));
      return JSON.parse(Buffer.concat([cipher.update(Buffer.from(packet.data, 'hex')), cipher.final()]).toString('utf8'));
    }
  };
}

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('HTTP state store persists and restores encrypted capsule', async () => {
  const tmpDir = createTempDir('http-state-');
  const vault = syntheticVault();
  const context = { serviceId: 'mcp_custom', operationId: 'op-alpha-1' };
  const binding = {
    type: 'http',
    url: 'https://api.example.com/mcp?sig=private-token',
    headers: { Authorization: { value: 'Bearer secret-jwt' } }
  };

  try {
    const { packet, plan, reused } = await persistHttpState(vault, tmpDir, binding, context);
    assert.equal(reused, false);
    assert.equal(plan.kind, 'http');
    assert.equal(plan.privateEnvironment.MCP_SERVER_URL, binding.url);

    // State on disk does not leak plaintext secrets
    const p = getHttpStatePath(tmpDir, context.serviceId, context.operationId);
    assert.ok(fs.existsSync(p));
    const rawOnDisk = fs.readFileSync(p, 'utf8');
    assert.doesNotMatch(rawOnDisk, /private-token/);
    assert.doesNotMatch(rawOnDisk, /secret-jwt/);

    // Loading restores identical plan
    const loaded = await loadHttpState(vault, tmpDir, context);
    assert.deepEqual(loaded.plan, plan);

    // Idempotent retry with exact same plan reuses capsule
    const retry = await persistHttpState(vault, tmpDir, binding, context);
    assert.equal(retry.reused, true);

    // Conflict detection: different plan for same op throws HTTP_STATE_CONFLICT
    const conflictingBinding = { ...binding, url: 'https://api.example.com/mcp?sig=different-token' };
    await assert.rejects(
      () => persistHttpState(vault, tmpDir, conflictingBinding, context),
      { code: 'HTTP_STATE_CONFLICT' }
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('HTTP state store enforces context validation and vault requirement', async () => {
  const tmpDir = createTempDir('http-state-err-');
  const vault = syntheticVault();
  const binding = { type: 'http', url: 'https://example.com/mcp' };

  try {
    // Missing vault fails with HTTP_VAULT_REQUIRED
    await assert.rejects(
      () => persistHttpState(null, tmpDir, binding, { serviceId: 'mcp_valid', operationId: 'op1' }),
      { code: 'HTTP_VAULT_REQUIRED' }
    );

    // Invalid serviceId rejected
    await assert.rejects(
      () => persistHttpState(vault, tmpDir, binding, { serviceId: 'invalid-id', operationId: 'op1' }),
      { code: 'INVALID_HTTP_CONTEXT' }
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('HTTP state store detects corrupted or tampered state', async () => {
  const tmpDir = createTempDir('http-state-tamper-');
  const vault = syntheticVault();
  const foreignVault = syntheticVault();
  const context = { serviceId: 'mcp_tamper', operationId: 'op-tamper-1' };
  const binding = { type: 'http', url: 'https://example.com/api' };

  try {
    const { path: p } = await persistHttpState({ vault, dataDir: tmpDir, binding, context });

    // Wrong vault cannot decrypt state
    await assert.rejects(
      () => loadHttpState({ vault: foreignVault, dataDir: tmpDir, context }),
      (err) => err.code === 'HTTP_STATE_UNREADABLE' || err.code === 'INVALID_HTTP_STATE'
    );

    // Corrupted file on disk
    fs.writeFileSync(p, 'NOT VALID JSON', 'utf8');
    await assert.rejects(
      () => loadHttpState({ vault, dataDir: tmpDir, context }),
      (err) => err.code === 'INVALID_HTTP_STATE' || err.code === 'HTTP_STATE_CORRUPT' || err.code === 'HTTP_STATE_UNREADABLE'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('HTTP state store supports createHttpStateStore wrapper', async () => {
  const tmpDir = createTempDir('http-state-store-wrapper-');
  const vault = syntheticVault();
  const { createHttpStateStore } = await import('../src/adapters/http-state-store.mjs');
  const store = createHttpStateStore({ dataDir: tmpDir, vault });

  const context = { serviceId: 'mcp_wrap', operationId: 'op-wrap-1' };
  const binding = { type: 'http', url: 'https://api.wrap.com/endpoint', headers: { 'X-Key': { value: 'secret' } } };

  try {
    const saved = await store.savePacket(binding, context);
    assert.equal(saved.reused, false);
    assert.ok(saved.plan);

    const loaded = await store.loadPacket(context);
    assert.equal(loaded.plan.privateEnvironment.MCP_SERVER_URL, binding.url);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('fresh state without binding throws HTTP_BINDING_REQUIRED', async () => {
  const tmpDir = createTempDir('http-state-fresh-nobind-');
  const vault = syntheticVault();
  const context = { serviceId: 'mcp_fresh', operationId: 'op-fresh-1' };

  try {
    // 1. Fresh state with binding null/undefined throws HttpStateStoreFault('HTTP_BINDING_REQUIRED')
    await assert.rejects(
      () => persistHttpState({ vault, dataDir: tmpDir, binding: null, context }),
      (err) => {
        assert.equal(err.code, 'HTTP_BINDING_REQUIRED');
        assert.ok(err instanceof HttpStateStoreFault);
        return true;
      }
    );

    // 2. Fresh state with desiredPlan but no binding also throws HTTP_BINDING_REQUIRED
    const desiredPlan = {
      kind: 'http',
      channel: 'main',
      args: [],
      headerNames: [],
      privateEnvironment: { MCP_SERVER_URL: 'https://example.com/fresh' }
    };
    await assert.rejects(
      () => persistHttpState({ vault, dataDir: tmpDir, binding: null, context, desiredPlan }),
      (err) => {
        assert.equal(err.code, 'HTTP_BINDING_REQUIRED');
        assert.ok(err instanceof HttpStateStoreFault);
        return true;
      }
    );

    // 3. No file exists on disk
    const targetPath = getHttpStatePath(tmpDir, context.serviceId, context.operationId);
    assert.equal(fs.existsSync(targetPath), false);

    // 4. If file exists on disk, but neither binding nor desiredPlan is provided, throws HTTP_BINDING_REQUIRED
    const validBinding = { type: 'http', url: 'https://example.com/fresh' };
    await persistHttpState({ vault, dataDir: tmpDir, binding: validBinding, context });
    assert.equal(fs.existsSync(targetPath), true);

    await assert.rejects(
      () => persistHttpState({ vault, dataDir: tmpDir, binding: null, context }),
      (err) => {
        assert.equal(err.code, 'HTTP_BINDING_REQUIRED');
        assert.ok(err instanceof HttpStateStoreFault);
        return true;
      }
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('supplied plan + binding equality check: conflict throws HTTP_STATE_CONFLICT', async () => {
  const tmpDir = createTempDir('http-state-plan-conflict-');
  const vault = syntheticVault();
  const context = { serviceId: 'mcp_check', operationId: 'op-check-1' };
  const binding = {
    type: 'http',
    url: 'https://api.example.com/mcp?sig=token-1',
    headers: { Authorization: { value: 'Bearer secret-jwt-1' } }
  };
  const authoritativePlan = compileHttpTransport(binding, context);

  const conflictingPlan = {
    ...authoritativePlan,
    privateEnvironment: {
      ...authoritativePlan.privateEnvironment,
      MCP_SERVER_URL: 'https://api.example.com/mcp?sig=mismatched-token'
    }
  };

  try {
    // 1. Conflicting desiredPlan + binding throws HTTP_STATE_CONFLICT before write
    await assert.rejects(
      () => persistHttpState({ vault, dataDir: tmpDir, binding, context, desiredPlan: conflictingPlan }),
      (err) => {
        assert.equal(err.code, 'HTTP_STATE_CONFLICT');
        assert.ok(err instanceof HttpTransportFault);
        return true;
      }
    );

    const targetPath = getHttpStatePath(tmpDir, context.serviceId, context.operationId);
    assert.equal(fs.existsSync(targetPath), false, 'No file should be written on conflict');

    // 2. Agreeing desiredPlan + binding succeeds cleanly
    const res = await persistHttpState({ vault, dataDir: tmpDir, binding, context, desiredPlan: authoritativePlan });
    assert.equal(res.reused, false);
    assert.ok(plansEqual(res.plan, authoritativePlan));
    assert.equal(fs.existsSync(targetPath), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('atomic publication / linkSync race handling: existing packet reused with exact bytes and no replacement', async () => {
  const tmpDir = createTempDir('http-state-race-');
  const vault = syntheticVault();
  const context = { serviceId: 'mcp_race', operationId: 'op-race-1' };
  const binding = {
    type: 'http',
    url: 'https://api.example.com/mcp?sig=race-token',
    headers: { 'X-Race-Token': { value: 'secret-val-999' } }
  };

  try {
    // 1. Concurrent persistHttpState calls reuse capsule and keep bytes unchanged
    const [res1, res2] = await Promise.all([
      persistHttpState(vault, tmpDir, binding, context),
      persistHttpState(vault, tmpDir, binding, context)
    ]);

    assert.ok(plansEqual(res1.plan, res2.plan));
    const diskBytes = fs.readFileSync(res1.path);
    assert.deepEqual(res1.bytes, diskBytes);
    assert.deepEqual(res2.bytes, diskBytes);

    // 2. Simulate direct linkSync EEXIST race where concurrent process creates target file right before linkSync
    const raceContext = { serviceId: 'mcp_race', operationId: 'op-race-eexist' };
    const authoritativePlan = compileHttpTransport(binding, raceContext);
    const targetPath = getHttpStatePath(tmpDir, raceContext.serviceId, raceContext.operationId);

    const origLinkSync = fs.linkSync;
    let linkSyncInvocationCount = 0;
    let tmpPathObserved = null;

    fs.linkSync = (src, dst) => {
      linkSyncInvocationCount++;
      tmpPathObserved = src;
      assert.ok(fs.existsSync(src), 'Temporary file must exist when linkSync is called');

      // Simulate concurrent worker creating dst atomically right now
      fs.copyFileSync(src, dst);

      // Now linkSync fails with EEXIST because dst already exists
      const err = new Error('EEXIST: file already exists, link');
      err.code = 'EEXIST';
      throw err;
    };

    try {
      const raceResult = await persistHttpState({ vault, dataDir: tmpDir, binding, context: raceContext });
      assert.equal(linkSyncInvocationCount, 1);
      assert.equal(raceResult.reused, true, 'Must reuse existing packet when linkSync encounters EEXIST');
      assert.ok(plansEqual(raceResult.plan, authoritativePlan));

      // Existing bytes match disk bytes exactly
      const finalDiskBytes = fs.readFileSync(targetPath);
      assert.deepEqual(raceResult.bytes, finalDiskBytes);
      assert.deepEqual(raceResult.packetBytes, finalDiskBytes);

      // Temporary file was cleaned up in finally block
      assert.ok(tmpPathObserved);
      assert.equal(fs.existsSync(tmpPathObserved), false, 'Temporary file must always be cleaned up');
    } finally {
      fs.linkSync = origLinkSync;
    }

    // 3. EEXIST race with conflicting plan throws HTTP_STATE_CONFLICT and cleans up tmp
    const conflictContext = { serviceId: 'mcp_race', operationId: 'op-race-conflict' };
    const conflictTargetPath = getHttpStatePath(tmpDir, conflictContext.serviceId, conflictContext.operationId);

    const conflictingBinding = {
      type: 'http',
      url: 'https://api.example.com/mcp?sig=other-token',
      headers: { 'X-Race-Token': { value: 'different-val' } }
    };
    // Pre-create conflicting state at targetPath
    await persistHttpState({ vault, dataDir: tmpDir, binding: conflictingBinding, context: conflictContext });
    const preConflictBytes = fs.readFileSync(conflictTargetPath);

    let conflictTmpObserved = null;
    fs.linkSync = (src, dst) => {
      conflictTmpObserved = src;
      const err = new Error('EEXIST: file already exists, link');
      err.code = 'EEXIST';
      throw err;
    };

    try {
      // Trying to persist original binding: linkSync triggers EEXIST and sees conflicting plan on disk
      await assert.rejects(
        () => persistHttpState({ vault, dataDir: tmpDir, binding, context: conflictContext }),
        { code: 'HTTP_STATE_CONFLICT' }
      );

      // Pre-existing file was NOT replaced or modified
      const postConflictBytes = fs.readFileSync(conflictTargetPath);
      assert.deepEqual(postConflictBytes, preConflictBytes);
    } finally {
      fs.linkSync = origLinkSync;
      if (conflictTmpObserved && fs.existsSync(conflictTmpObserved)) {
        fs.unlinkSync(conflictTmpObserved);
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('exact cipher bytes and bundle fingerprint preservation', async () => {
  const tmpDir = createTempDir('http-state-fp-');
  const vault = syntheticVault();
  const context = { serviceId: 'mcp_fp', operationId: 'op-fp-1' };
  const binding = {
    type: 'http',
    url: 'https://api.example.com/mcp?sig=signed-query-bytes&batch=1,2,3',
    headers: { Authorization: { value: 'Bearer secret-jwt-abc' } }
  };
  const profileBytes = Buffer.from('config_version: 1\ncontrol_plane:\n  tunnel_id: "test"\n', 'utf8');

  try {
    // 1. Persist state and capture exact cipher bytes and fingerprint
    const persisted = await persistHttpState(vault, tmpDir, binding, context);
    assert.equal(persisted.reused, false);
    assert.ok(Buffer.isBuffer(persisted.bytes));
    assert.ok(Buffer.isBuffer(persisted.packetBytes));
    assert.deepEqual(persisted.bytes, persisted.packetBytes);

    const diskBytes = fs.readFileSync(persisted.path);
    assert.deepEqual(persisted.bytes, diskBytes);

    // Compute canonical configuration fingerprint
    const initialFingerprint = fingerprintHttpConfiguration(profileBytes, persisted.packetBytes);
    assert.match(initialFingerprint, /^[0-9a-f]{64}$/);

    // 2. Load state and verify exact cipher bytes and fingerprint preservation
    const loaded = await loadHttpState(vault, tmpDir, context);
    assert.ok(Buffer.isBuffer(loaded.bytes));
    assert.ok(Buffer.isBuffer(loaded.packetBytes));
    assert.deepEqual(loaded.bytes, diskBytes);
    assert.deepEqual(loaded.packetBytes, diskBytes);

    const loadedFingerprint = fingerprintHttpConfiguration(profileBytes, loaded.packetBytes);
    assert.equal(loadedFingerprint, initialFingerprint);

    // 3. Idempotent re-persist reuses exact bytes without re-encryption drift
    const reused = await persistHttpState(vault, tmpDir, binding, context);
    assert.equal(reused.reused, true);
    assert.deepEqual(reused.bytes, diskBytes);
    assert.deepEqual(reused.packetBytes, diskBytes);

    const reusedFingerprint = fingerprintHttpConfiguration(profileBytes, reused.packetBytes);
    assert.equal(reusedFingerprint, initialFingerprint);

    // 4. Modifying any bit in the cipher packet alters the fingerprint
    const tamperedBytes = Buffer.from(diskBytes);
    tamperedBytes[tamperedBytes.length - 1] ^= 0x01;
    const tamperedFingerprint = fingerprintHttpConfiguration(profileBytes, tamperedBytes);
    assert.notEqual(tamperedFingerprint, initialFingerprint);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

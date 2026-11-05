import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import child_process from 'node:child_process';
import { createVault } from '../src/vault.mjs';

describe('Vault Security & Encryption', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('1. seal and unseal roundtrip with object and canonical AAD', () => {
    it('successfully seals and unseals complex JSON objects with canonical AAD', () => {
      const vault = createVault({ dataDir: tempDir });
      try {
        const payload = {
          accountId: 'acc_01J8F9',
          username: 'alice_admin',
          metadata: {
            roles: ['admin', 'operator'],
            enabled: true,
            quota: 1000,
            ratio: 3.14159,
            emptyObj: {},
            emptyArr: []
          }
        };
        const aad = 'canonical:v1:account:acc_01J8F9';

        const envelope = vault.seal(payload, aad);

        // Verify envelope structure
        assert.equal(envelope.v, 2);
        assert.equal(typeof envelope.iv, 'string');
        assert.equal(typeof envelope.tag, 'string');
        assert.equal(typeof envelope.data, 'string');

        // Check buffer dimensions
        assert.equal(Buffer.from(envelope.iv, 'base64').length, 12);
        assert.equal(Buffer.from(envelope.tag, 'base64').length, 16);

        // Roundtrip unseal
        const recovered = vault.unseal(envelope, aad);
        assert.deepEqual(recovered, payload);
      } finally {
        vault.close();
      }
    });

    it('successfully seals and unseals string values with canonical AAD', () => {
      const vault = createVault({ dataDir: tempDir });
      try {
        const payload = 'sk_live_tunnel_access_token_super_secret_9988';
        const aad = 'canonical:v1:token:sk_live';

        const envelope = vault.seal(payload, aad);
        const recovered = vault.unseal(envelope, aad);

        assert.equal(recovered, payload);
        assert.equal(typeof recovered, 'string');
      } finally {
        vault.close();
      }
    });

    it('successfully unseals when envelope is passed as a JSON string', () => {
      const vault = createVault({ dataDir: tempDir });
      try {
        const payload = { secretKey: 'top_secret' };
        const aad = 'canonical:v1:resource:secret';

        const envelope = vault.seal(payload, aad);
        const jsonString = JSON.stringify(envelope);

        const recovered = vault.unseal(jsonString, aad);
        assert.deepEqual(recovered, payload);
      } finally {
        vault.close();
      }
    });
  });

  describe('2. fresh nonce each seal (different IV)', () => {
    it('generates a fresh 12-byte nonce on every seal invocation', () => {
      const vault = createVault({ dataDir: tempDir });
      try {
        const payload = { counter: 42, label: 'fixed_payload' };
        const aad = 'canonical:v1:fixed_aad';
        const iterations = 30;
        const envelopes = [];

        for (let i = 0; i < iterations; i++) {
          envelopes.push(vault.seal(payload, aad));
        }

        // Verify each IV is distinct
        const ivs = envelopes.map(e => e.iv);
        const uniqueIvs = new Set(ivs);
        assert.equal(uniqueIvs.size, iterations, 'All IV nonces must be unique');

        // Verify all IVs are exactly 12 bytes
        for (const iv of ivs) {
          const ivBuffer = Buffer.from(iv, 'base64');
          assert.equal(ivBuffer.length, 12, 'IV must be 12 bytes');
        }

        // Fresh IVs guarantee distinct ciphertexts even for identical plaintexts
        const ciphertexts = envelopes.map(e => e.data);
        const uniqueCiphertexts = new Set(ciphertexts);
        assert.equal(
          uniqueCiphertexts.size,
          iterations,
          'All ciphertexts must be distinct due to fresh nonces'
        );

        // Verify each unseals back to the original payload
        for (const env of envelopes) {
          assert.deepEqual(vault.unseal(env, aad), payload);
        }
      } finally {
        vault.close();
      }
    });
  });

  describe('3. tamper detection (corrupted ciphertext or tag throws)', () => {
    it('throws safe error when ciphertext data is corrupted', () => {
      const vault = createVault({ dataDir: tempDir });
      try {
        const payload = { sensitive: 'critical_data' };
        const aad = 'canonical:v1:tamper_test';
        const envelope = vault.seal(payload, aad);

        // Corrupt ciphertext buffer
        const dataBuf = Buffer.from(envelope.data, 'base64');
        dataBuf[0] ^= 0x01; // flip one bit
        const tamperedEnvelope = {
          ...envelope,
          data: dataBuf.toString('base64')
        };

        assert.throws(
          () => vault.unseal(tamperedEnvelope, aad),
          /Decryption failed|integrity check failed/i
        );
      } finally {
        vault.close();
      }
    });

    it('throws safe error when authentication tag is corrupted', () => {
      const vault = createVault({ dataDir: tempDir });
      try {
        const payload = { sensitive: 'critical_data' };
        const aad = 'canonical:v1:tamper_test';
        const envelope = vault.seal(payload, aad);

        // Corrupt auth tag buffer
        const tagBuf = Buffer.from(envelope.tag, 'base64');
        tagBuf[0] ^= 0x01; // flip one bit
        const tamperedEnvelope = {
          ...envelope,
          tag: tagBuf.toString('base64')
        };

        assert.throws(
          () => vault.unseal(tamperedEnvelope, aad),
          /Decryption failed|integrity check failed/i
        );
      } finally {
        vault.close();
      }
    });

    it('throws safe error when IV nonce is modified', () => {
      const vault = createVault({ dataDir: tempDir });
      try {
        const payload = { sensitive: 'critical_data' };
        const aad = 'canonical:v1:tamper_test';
        const envelope = vault.seal(payload, aad);

        // Corrupt IV buffer
        const ivBuf = Buffer.from(envelope.iv, 'base64');
        ivBuf[0] ^= 0x01;
        const tamperedEnvelope = {
          ...envelope,
          iv: ivBuf.toString('base64')
        };

        assert.throws(
          () => vault.unseal(tamperedEnvelope, aad),
          /Decryption failed|integrity check failed/i
        );
      } finally {
        vault.close();
      }
    });

    it('throws when tag or IV lengths are invalid', () => {
      const vault = createVault({ dataDir: tempDir });
      try {
        const envelope = vault.seal('some_value', 'aad');

        assert.throws(
          () => vault.unseal({ ...envelope, tag: Buffer.from('short').toString('base64') }, 'aad'),
          /Invalid auth tag length/i
        );

        assert.throws(
          () => vault.unseal({ ...envelope, iv: Buffer.from('short').toString('base64') }, 'aad'),
          /Invalid IV length/i
        );
      } finally {
        vault.close();
      }
    });
  });

  describe('4. wrong AAD throws', () => {
    it('throws safe error when unsealing with different AAD', () => {
      const vault = createVault({ dataDir: tempDir });
      try {
        const payload = { account: 'alice', role: 'admin' };
        const correctAad = 'canonical:v1:tenant:alpha:user:alice';
        const envelope = vault.seal(payload, correctAad);

        const wrongAad = 'canonical:v1:tenant:beta:user:alice';
        assert.throws(
          () => vault.unseal(envelope, wrongAad),
          /Decryption failed|integrity check failed/i
        );
      } finally {
        vault.close();
      }
    });

    it('throws safe error when AAD is omitted or empty when sealed with AAD', () => {
      const vault = createVault({ dataDir: tempDir });
      try {
        const envelope = vault.seal({ token: 'abc' }, 'canonical:required_aad');

        // Missing AAD
        assert.throws(
          () => vault.unseal(envelope),
          /Mandatory caller-derived nonempty canonical AAD required|Decryption failed|integrity check failed/i
        );

        // Empty string AAD
        assert.throws(
          () => vault.unseal(envelope, ''),
          /Mandatory caller-derived nonempty canonical AAD required|Decryption failed|integrity check failed/i
        );
      } finally {
        vault.close();
      }
    });

    it('requires mandatory caller-derived non-empty AAD on seal', () => {
      const vault = createVault({ dataDir: tempDir });
      try {
        assert.throws(() => vault.seal('val'), /Mandatory caller-derived nonempty canonical AAD required/i);
        assert.throws(() => vault.seal('val', ''), /Mandatory caller-derived nonempty canonical AAD required/i);
        assert.throws(() => vault.seal('val', '   '), /Mandatory caller-derived nonempty canonical AAD required/i);
        assert.throws(() => vault.seal('val', null), /Mandatory caller-derived nonempty canonical AAD required/i);
      } finally {
        vault.close();
      }
    });

    it('safely unseals legacy envelope version v: 1', () => {
      const vault = createVault({ dataDir: tempDir });
      try {
        const aad = 'canonical:v1:legacy';
        const env2 = vault.seal('legacy-payload', aad);
        const legacyEnv = { ...env2, v: 1 };
        const recovered = vault.unseal(legacyEnv, aad);
        assert.equal(recovered, 'legacy-payload');
      } finally {
        vault.close();
      }
    });
  });

  describe('5. durable restart (reopening vault with same dataDir can unseal)', () => {
    it('successfully persists master key across restarts and unseals prior data', () => {
      const payload1 = { message: 'first session payload', seq: 1 };
      const payload2 = { message: 'second session payload', seq: 2 };
      const aad = 'canonical:v1:durable_test';

      let env1;
      let env2;

      // 1. First session
      {
        const vault1 = createVault({ dataDir: tempDir });
        env1 = vault1.seal(payload1, aad);
        assert.deepEqual(vault1.unseal(env1, aad), payload1);
        vault1.close();
      }

      // 2. Second session reopening same dataDir
      {
        const vault2 = createVault({ dataDir: tempDir });
        // Can unseal data from session 1
        assert.deepEqual(vault2.unseal(env1, aad), payload1);

        // Can seal new data
        env2 = vault2.seal(payload2, aad);
        assert.deepEqual(vault2.unseal(env2, aad), payload2);
        vault2.close();
      }

      // 3. Third session reopening same dataDir
      {
        const vault3 = createVault({ dataDir: tempDir });
        // Can unseal data from both previous sessions
        assert.deepEqual(vault3.unseal(env1, aad), payload1);
        assert.deepEqual(vault3.unseal(env2, aad), payload2);
        vault3.close();
      }
    });

    it('re-reads existing 32-byte master.key without rewriting it', () => {
      const keyPath = path.join(tempDir, 'master.key');

      const vault1 = createVault({ dataDir: tempDir });
      const initialKey = fs.readFileSync(keyPath);
      assert.equal(initialKey.length, 32);
      vault1.close();

      const vault2 = createVault({ dataDir: tempDir });
      const secondKey = fs.readFileSync(keyPath);
      vault2.close();

      assert.deepEqual(initialKey, secondKey, 'Master key file content must remain unchanged');
    });
  });

  describe('6. missing or invalid key handling', () => {
    it('throws TypeError when dataDir is omitted or invalid', () => {
      assert.throws(() => createVault(), /createVault requires a non-empty string dataDir/i);
      assert.throws(() => createVault({}), /createVault requires a non-empty string dataDir/i);
      assert.throws(() => createVault({ dataDir: '' }), /createVault requires a non-empty string dataDir/i);
      assert.throws(() => createVault({ dataDir: '   ' }), /createVault requires a non-empty string dataDir/i);
      assert.throws(() => createVault({ dataDir: 123 }), /createVault requires a non-empty string dataDir/i);
    });

    it('throws Error when existing master.key is invalid length', () => {
      const keyPath = path.join(tempDir, 'master.key');

      // Test truncated key (16 bytes)
      fs.writeFileSync(keyPath, crypto.randomBytes(16));
      assert.throws(
        () => createVault({ dataDir: tempDir }),
        /Invalid master key in .* expected 32 bytes, got 16/i
      );

      // Test empty key (0 bytes)
      fs.writeFileSync(keyPath, Buffer.alloc(0));
      assert.throws(
        () => createVault({ dataDir: tempDir }),
        /Invalid master key in .* expected 32 bytes, got 0/i
      );

      // Test oversized key (64 bytes)
      fs.writeFileSync(keyPath, crypto.randomBytes(64));
      assert.throws(
        () => createVault({ dataDir: tempDir }),
        /Invalid master key in .* expected 32 bytes, got 64/i
      );
    });

    it('throws safe error when unsealing with a different vault master key', () => {
      const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-other-'));
      const vaultA = createVault({ dataDir: tempDir });
      const vaultB = createVault({ dataDir: otherDir });

      try {
        const payload = { secret: 'cross-vault-test' };
        const aad = 'canonical:v1:cross';

        const envelopeA = vaultA.seal(payload, aad);

        // Vault B must fail to decrypt envelope from Vault A
        assert.throws(
          () => vaultB.unseal(envelopeA, aad),
          /Decryption failed|integrity check failed/i
        );
      } finally {
        vaultA.close();
        vaultB.close();
        fs.rmSync(otherDir, { recursive: true, force: true });
      }
    });

    it('throws error when envelope structure is invalid', () => {
      const vault = createVault({ dataDir: tempDir });
      try {
        assert.throws(() => vault.unseal(null), /Invalid envelope/i);
        assert.throws(() => vault.unseal(undefined), /Invalid envelope/i);
        assert.throws(() => vault.unseal('not json'), /Invalid envelope: failed to parse JSON/i);
        assert.throws(() => vault.unseal({ v: 3, iv: 'a', tag: 'b', data: 'c' }, 'aad'), /Unsupported envelope version/i);
        assert.throws(() => vault.unseal({ v: 2, iv: 123, tag: 'b', data: 'c' }, 'aad'), /Invalid envelope/i);
      } finally {
        vault.close();
      }
    });

    it('enforces Windows NTFS ACLs on master.key if on win32', () => {
      const vault = createVault({ dataDir: tempDir });
      vault.close();
      const keyPath = path.join(tempDir, 'master.key');
      assert.ok(fs.existsSync(keyPath));
      if (process.platform === 'win32') {
        const output = child_process.execFileSync('icacls.exe', [keyPath], { encoding: 'utf8' });
        assert.ok(output.includes(process.env.USERNAME) || output.includes(process.env.USER));
      }
    });

    it('disallows seal and unseal after vault is closed', () => {
      const vault = createVault({ dataDir: tempDir });
      const envelope = vault.seal('active_vault', 'aad');
      vault.close();

      assert.throws(() => vault.seal('closed_vault', 'aad'), /Vault is closed/i);
      assert.throws(() => vault.unseal(envelope, 'aad'), /Vault is closed/i);

      // close() is idempotent
      assert.doesNotThrow(() => vault.close());
    });
  });
});

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import child_process from 'node:child_process';

/**
 * Enforces Windows NTFS ACL restrictions on target file or directory.
 * Disables inheritance and grants FullControl exclusively to the current user and SYSTEM (*S-1-5-18).
 * Failure is fatal.
 *
 * @param {string} targetPath - Path to secure
 */
export function enforceWindowsAcls(targetPath) {
  if (process.platform !== 'win32') return;
  const username = process.env.USERNAME || process.env.USER;
  if (!username) {
    throw new Error('ACL_RESTRICTION_FAILED: USERNAME environment variable is not defined');
  }
  try {
    child_process.execFileSync(
      'icacls.exe',
      [targetPath, '/inheritance:r', '/grant:r', `${username}:(F)`, '*S-1-5-18:(F)'],
      { stdio: 'pipe' }
    );
  } catch (err) {
    throw new Error(`ACL_RESTRICTION_FAILED: Failed to enforce Windows NTFS ACLs on ${targetPath}: ${err.message}`);
  }
}

/**
 * Creates and initializes an encrypted vault backed by a persistent AES-256-GCM master key.
 *
 * @param {Object} options
 * @param {string} options.dataDir - Directory to store or load master.key
 * @returns {{
 *   seal: (value: any, aad: string) => { v: number, iv: string, tag: string, data: string },
 *   unseal: (envelope: Object|string, aad?: string) => any,
 *   close: () => void
 * }}
 */
export function createVault({ dataDir } = {}) {
  if (!dataDir || typeof dataDir !== 'string' || dataDir.trim() === '') {
    throw new TypeError('createVault requires a non-empty string dataDir');
  }

  const resolvedDir = path.resolve(dataDir);
  fs.mkdirSync(resolvedDir, { recursive: true, mode: 0o700 });

  const keyPath = path.join(resolvedDir, 'master.key');
  let masterKey;

  try {
    const freshKey = crypto.randomBytes(32);
    // Atomic/exclusive master.key creation with flag 'wx'
    fs.writeFileSync(keyPath, freshKey, { flag: 'wx', mode: 0o600 });
    masterKey = freshKey;
    // Enforce Windows ACL restriction on master.key (failure is fatal)
    enforceWindowsAcls(keyPath);
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      const existingKey = fs.readFileSync(keyPath);
      if (existingKey.length !== 32) {
        throw new Error(
          `Invalid master key in ${keyPath}: expected 32 bytes, got ${existingKey.length}`
        );
      }
      masterKey = Buffer.from(existingKey);
      enforceWindowsAcls(keyPath);
    } else {
      throw err;
    }
  }

  let isClosed = false;

  function assertNotClosed() {
    if (isClosed) {
      throw new Error('Vault is closed');
    }
  }

  /**
   * Encrypts and authenticates a JSON-serializable value or string using AES-256-GCM.
   * Envelope version v: 2.
   * Requires mandatory caller-derived nonempty canonical AAD.
   *
   * @param {any} value - String or JSON object to encrypt.
   * @param {string} aad - Canonical Additional Authenticated Data string (mandatory, nonempty).
   * @returns {{ v: number, iv: string, tag: string, data: string }}
   */
  function seal(value, aad) {
    assertNotClosed();

    if (!aad || typeof aad !== 'string' || aad.trim() === '') {
      throw new TypeError('Mandatory caller-derived nonempty canonical AAD required');
    }

    if (value === undefined) {
      throw new TypeError('Value to seal cannot be undefined');
    }

    const plaintext =
      typeof value === 'object' && value !== null
        ? JSON.stringify(value)
        : String(value);

    // Fresh 12-byte random nonce for AES-GCM
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);

    const aadBuffer = Buffer.isBuffer(aad)
      ? aad
      : Buffer.from(String(aad), 'utf8');
    cipher.setAAD(aadBuffer);

    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final()
    ]);
    const tag = cipher.getAuthTag();

    return {
      v: 2,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: ciphertext.toString('base64')
    };
  }

  /**
   * Authenticates and decrypts an envelope using AES-256-GCM.
   * Supports envelope version v: 2 and legacy v: 1.
   *
   * @param {Object|string} envelope - Envelope object or JSON string.
   * @param {string} [aad] - Expected Additional Authenticated Data string.
   * @returns {any} Decrypted object or string.
   */
  function unseal(envelope, aad) {
    assertNotClosed();

    let env = envelope;
    if (typeof env === 'string') {
      try {
        env = JSON.parse(env);
      } catch {
        throw new Error('Invalid envelope: failed to parse JSON string');
      }
    }

    if (!env || typeof env !== 'object') {
      throw new Error('Invalid envelope: envelope must be an object');
    }

    if (env.v !== 1 && env.v !== 2) {
      throw new Error(`Unsupported envelope version: ${env.v}`);
    }

    if (env.v === 2 && (!aad || typeof aad !== 'string' || aad.trim() === '')) {
      throw new TypeError('Mandatory caller-derived nonempty canonical AAD required');
    }

    if (
      typeof env.iv !== 'string' ||
      typeof env.tag !== 'string' ||
      typeof env.data !== 'string'
    ) {
      throw new Error(
        'Invalid envelope: iv, tag, and data must be base64 strings'
      );
    }

    let iv, tag, ciphertext;
    try {
      iv = Buffer.from(env.iv, 'base64');
      tag = Buffer.from(env.tag, 'base64');
      ciphertext = Buffer.from(env.data, 'base64');
    } catch {
      throw new Error('Invalid envelope: malformed base64 encoding');
    }

    if (iv.length !== 12) {
      throw new Error(`Invalid IV length: expected 12 bytes, got ${iv.length}`);
    }
    if (tag.length !== 16) {
      throw new Error(
        `Invalid auth tag length: expected 16 bytes, got ${tag.length}`
      );
    }

    let decryptedStr;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
      decipher.setAuthTag(tag);

      if (aad !== undefined && aad !== null && String(aad).length > 0) {
        const aadBuffer = Buffer.isBuffer(aad)
          ? aad
          : Buffer.from(String(aad), 'utf8');
        decipher.setAAD(aadBuffer);
      }

      decryptedStr = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final()
      ]).toString('utf8');
    } catch (err) {
      throw new Error(
        'Decryption failed: integrity check failed or invalid key/AAD'
      );
    }

    try {
      const parsed = JSON.parse(decryptedStr);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed;
      }
    } catch {
      // Return raw string if not a JSON object
    }

    return decryptedStr;
  }

  /**
   * Synchronously wipes in-memory master key and marks vault closed.
   */
  function close() {
    if (isClosed) return;
    isClosed = true;
    if (masterKey && Buffer.isBuffer(masterKey)) {
      masterKey.fill(0);
    }
  }

  return {
    seal,
    unseal,
    close
  };
}

export default {
  createVault,
  enforceWindowsAcls
};

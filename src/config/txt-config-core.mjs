import fs from 'node:fs';
import path from 'node:path';
import crypto, { createHmac } from 'node:crypto';

const MAX_TEXT = 1024 * 1024;
const MAX_LINES = 4000;
const MAX_BLOCKS = 100;
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const ALIASES = new Map();
function keyId(s) { return String(s).normalize('NFKC').replace(/[\s_-]+/gu, '').toLowerCase(); }
function alias(field, names) { for (const name of names) ALIASES.set(keyId(name), field); }
alias('serviceId', ['SERVICE_ID', 'MCP_SERVICE_ID', '服务ID', '服务标识']);
alias('serviceName', ['SERVICE_NAME', 'MCP_SERVICE_NAME', '服务名称', '服务名']);
alias('profileName', ['PROFILE_NAME', 'PROFILE', '账号名称', '账户名称', '账号名', '配置名称']);
alias('tunnelId', ['TUNNEL_ID', '隧道ID', '隧道标识']);
alias('apiKey', ['CONTROL_PLANE_KEY', 'CONTROL_PLANE_API_KEY', 'TUNNEL_API_KEY', 'API_KEY', 'API密钥', '控制密钥']);
alias('organizationId', ['ORGANIZATION_ID', 'ORG_ID', '组织ID']);
alias('transport', ['TRANSPORT', 'MCP_TRANSPORT', '传输类型']);
alias('url', ['MCP_SERVER_URL', 'SERVER_URL', 'SERVICE_URL', 'URL', '服务URL', '服务地址']);
alias('command', ['MCP_SERVER_COMMAND', 'SERVER_COMMAND', '可执行程序']);
alias('args', ['MCP_SERVER_ARGS', '启动参数']);
alias('cwd', ['MCP_SERVER_CWD', '工作目录']);

function fault(code) { const e = new Error(code); e.code = code; return e; }
function issue(code, line = null, field = null) { return { code, line, field }; }

export function decodeTextContent(input, maxBytes = MAX_TEXT) {
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > maxBytes) throw fault('FILE_TOO_LARGE');
    return { text: input.replace(/^\uFEFF/u, ''), encoding: 'utf-8' };
  }
  if (!Buffer.isBuffer(input)) throw fault('INVALID_BUFFER_OR_STRING');
  if (input.length > maxBytes) throw fault('FILE_TOO_LARGE');

  if (input.length >= 3 && input[0] === 0xEF && input[1] === 0xBB && input[2] === 0xBF) {
    return { text: input.subarray(3).toString('utf8'), encoding: 'utf-8-bom' };
  }
  if (input.length >= 2 && input[0] === 0xFF && input[1] === 0xFE) {
    return { text: input.subarray(2).toString('utf16le'), encoding: 'utf-16le' };
  }
  if (input.length >= 2 && input[0] === 0xFE && input[1] === 0xFF) {
    const swapped = Buffer.from(input.subarray(2));
    swapped.swap16();
    return { text: swapped.toString('utf16le'), encoding: 'utf-16be' };
  }

  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    return { text: decoder.decode(input), encoding: 'utf-8' };
  } catch (_) {
    try {
      const decoder = new TextDecoder('utf-16le', { fatal: true });
      return { text: decoder.decode(input), encoding: 'utf-16le' };
    } catch (_) {
      return { text: null, encoding: 'unsupported', error: 'UNSUPPORTED_ENCODING' };
    }
  }
}

function normalizedText(input) {
  if (typeof input !== 'string') throw fault('TEXT_REQUIRED');
  if (Buffer.byteLength(input, 'utf8') > MAX_TEXT) throw fault('FILE_TOO_LARGE');
  const text = input.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(text)) throw fault('BINARY_OR_CONTROL_CONTENT');
  if (text.split('\n').length > MAX_LINES) throw fault('TOO_MANY_LINES');
  return text;
}
export function classifyTxtConfig(input) {
  const text = normalizedText(input);
  const t = text.trim();
  if (!t) return { format: 'empty', text, issues: [issue('EMPTY_FILE')] };
  if (/^\s*(?:`{3}|~{3})/mu.test(text)) {
    return { format: 'review', text, issues: [issue('CODE_FENCE_REQUIRES_REVIEW')] };
  }
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      JSON.parse(t);
      return { format: 'json', text, issues: [] };
    } catch {
      if (t.startsWith('[')) {
        const firstLine = t.split('\n')[0].trim();
        const isIniSection = /^\[[A-Za-z0-9_\p{Script=Han} ./-]{1,80}\]$/u.test(firstLine);
        if (isIniSection) {
          // fall through to literal below
        } else {
          return { format: 'review', text, issues: [issue('INVALID_JSON_STRUCTURE')] };
        }
      } else {
        return { format: 'review', text, issues: [issue('INVALID_JSON_STRUCTURE')] };
      }
    }
  }
  if (/^(?:mcpServers|mcp_servers|servers|tunnels|profiles|accounts)\s*:/mu.test(text)) {
    return { format: 'yaml', text, issues: [] };
  }
  return { format: 'literal', text, issues: [] };
}
function literalValue(raw) {
  let value = raw.trim();
  if (value.length > 8192) throw fault('VALUE_TOO_LONG');
  const a = value[0], b = value.at(-1);
  if (a === '"' || a === "'") {
    if (value.length < 2 || a !== b) throw fault('UNBALANCED_QUOTES');
    value = value.slice(1, -1);
  } else if (b === '"' || b === "'") throw fault('UNBALANCED_QUOTES');
  if (/\$\(|\$\{|\$[A-Za-z_]|`|%[^%\n]+%|%%|![A-Za-z_][A-Za-z0-9_]*!/u.test(value)) {
    throw fault('DYNAMIC_VALUE_REQUIRES_REVIEW');
  }
  if (/^(?:<[^>]+>|x{3,}|(?:your|example|replace|change)[-_ ].*|示例.*|请填写.*|待填写.*)$/iu.test(value)) {
    throw fault('PLACEHOLDER_VALUE');
  }
  return value;
}

/**
 * INTERNAL ONLY: blocks contain private literal values. Never serialize this result
 * to a browser/log/model. Structured JSON/YAML is delegated to existing safe parsers.
 */
export function parseLiteralTxtConfig(input) {
  const classified = classifyTxtConfig(input);
  if (classified.format !== 'literal') {
    return { format: classified.format, delegate: ['json', 'yaml'].includes(classified.format),
      blocks: [], issues: classified.issues };
  }
  const blocks = [];
  let block;
  function next(section) {
    if (blocks.length >= MAX_BLOCKS) throw fault('TOO_MANY_BLOCKS');
    block = { section, values: Object.create(null), issues: [], syntaxReady: false, kind: 'unknown' };
    blocks.push(block);
  }
  next(null);
  for (const [index, rawLine] of classified.text.split('\n').entries()) {
    const line = rawLine.trim();
    const n = index + 1;
    if (!line || /^(?:#|;|\/\/|@?rem(?:\s|$))/iu.test(line)) continue;
    const section = line.match(/^\[([^\[\]]{1,80})\]$/u);
    if (section) { next(section[1].trim()); continue; }
    if (/^@?set\s+\/[pa](?:\s|$)/iu.test(line)) {
      block.issues.push(issue('NON_LITERAL_ASSIGNMENT', n)); continue;
    }
    let key, raw;
    const bat = line.match(/^@?set\s+(?:"([^=]+)=(.*)"|([^=]+)=(.*))$/iu);
    if (bat) { key = (bat[1] || bat[3]).trim(); raw = bat[2] ?? bat[4] ?? ''; }
    else {
      const pair = line.match(/^(?:export\s+)?([A-Za-z_\p{Script=Han}][A-Za-z0-9_\s\p{Script=Han}-]{0,79})\s*[=:\uFF1A]\s*(.*)$/iu);
      if (!pair) { block.issues.push(issue('UNRECOGNIZED_LINE', n)); continue; }
      key = pair[1].trim(); raw = pair[2];
    }
    const field = ALIASES.get(keyId(key));
    if (!field) { block.issues.push(issue('UNKNOWN_FIELD', n)); continue; }
    let value;
    try { value = literalValue(raw); }
    catch (e) { block.issues.push(issue(e.code || 'INVALID_LITERAL', n, field)); continue; }
    if (!value) { block.issues.push(issue('MISSING_VALUE', n, field)); continue; }
    if (field === 'args') {
      try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed) || parsed.length > 128 ||
            parsed.some(x => typeof x !== 'string' || /[\u0000-\u001F]/u.test(x))) throw fault('INVALID_ARGS');
        value = parsed;
      } catch { block.issues.push(issue('ARGS_REQUIRE_JSON_ARRAY', n, field)); continue; }
    }
    if (field === 'url') {
      try {
        const u = new URL(value);
        if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw fault('INVALID_URL');
      } catch { block.issues.push(issue('INVALID_HTTP_URL', n, field)); continue; }
    }
    if (Object.hasOwn(block.values, field)) {
      if (JSON.stringify(block.values[field]) !== JSON.stringify(value)) {
        block.issues.push(issue('DUPLICATE_KEY_CONFLICT', n, field));
      }
      continue;
    }
    block.values[field] = value;
  }
  const kept = blocks.filter(x => Object.keys(x.values).length || x.issues.length || x.section);
  for (const x of kept) {
    const hasAccountFields = Boolean(x.values.tunnelId || x.values.apiKey);
    const hasUrl = Boolean(x.values.url);
    const hasCommand = Boolean(x.values.command);

    if (hasAccountFields) {
      x.kind = 'tunnel_account';
      if (!x.values.tunnelId) x.issues.push(issue('TUNNEL_ID_REQUIRED'));
      if (!x.values.apiKey) x.issues.push(issue('CONTROL_PLANE_KEY_REQUIRED'));
    } else if (hasUrl && hasCommand) {
      x.kind = 'service_definition';
      x.issues.push(issue('AMBIGUOUS_BINDING'));
    } else if (hasUrl || hasCommand) {
      x.kind = 'service_definition';
    } else {
      x.kind = 'unknown';
      x.issues.push(issue('UNKNOWN_CONFIG_KIND'));
    }
    x.syntaxReady = x.issues.length === 0;
  }
  return { format: 'literal', delegate: false, blocks: kept,
    issues: kept.length ? [] : [issue('NO_CONFIG_BLOCKS')] };
}

function fileComponent(value, fallback) {
  let s = String(value || fallback).normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069<>:"/\\|?*]/gu, '-')
    .replace(/\s+/gu, ' ').replace(/^[ .]+|[ .]+$/gu, '');
  s = [...s].slice(0, 40).join('');
  if (!s) s = fallback;
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(s)) s = '配置-' + s;
  return s;
}
export function readableConfigFilename({ serviceName, profileName, extension = 'yaml', collisionId = null } = {}) {
  if (!['yaml', 'yml', 'json', 'txt', 'env'].includes(extension)) throw fault('UNSUPPORTED_EXTENSION');
  const parts = [fileComponent(serviceName, 'MCP'), fileComponent(profileName, '未命名账号'), 'tunnel-client'];
  if (collisionId !== null) {
    const suffix = String(collisionId);
    if (!/^[A-Za-z0-9_-]{4,16}$/u.test(suffix)) throw fault('INVALID_COLLISION_ID');
    parts.push(suffix);
  }
  return parts.join('__') + '.' + extension;
}
function stable(value, depth = 0) {
  if (depth > 6) throw fault('IDENTITY_TOO_DEEP');
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 256) throw fault('IDENTITY_TOO_LARGE');
    return value.map(x => stable(x, depth + 1));
  }
  if (!value || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw fault('INVALID_IDENTITY_VALUE');
  }
  const keys = Object.keys(value).sort();
  if (keys.length > 256 || keys.some(k => BAD_KEYS.has(k))) throw fault('INVALID_IDENTITY_KEYS');
  const out = Object.create(null);
  for (const k of keys) out[k] = stable(value[k], depth + 1);
  return out;
}
/** Private deduplication key; never expose its credential-derived digest in public DTOs. */
export function privateConfigFingerprint(normalizedCandidate, hmacKey) {
  if (!Buffer.isBuffer(hmacKey) || hmacKey.length < 32) throw fault('PRIVATE_FINGERPRINT_KEY_REQUIRED');
  const allowed = ['serviceId', 'tunnelId', 'apiKey', 'organizationId', 'org',
    'transport', 'binding', 'url', 'command', 'args', 'cwd', 'headers'];
  const record = Object.create(null);
  for (const k of allowed) if (normalizedCandidate[k] !== undefined) record[k] = normalizedCandidate[k];
  return createHmac('sha256', hmacKey).update('mcp-config-import-v1\u0000')
    .update(JSON.stringify(stable(record))).digest('hex');
}

/**
 * Returns a stable 32-byte private HMAC key.
 * If vault and dataDir are provided, uses AES-256-GCM ciphertext persisted on disk.
 * Never stores plaintext key; handles concurrent file creation safely.
 */
export function getOrCreateFingerprintKey(vault, dataDir) {
  if (!vault || !dataDir) {
    return crypto.randomBytes(32);
  }
  const keyFilePath = path.join(dataDir, 'config-fingerprint.sealed');
  const aad = 'mcp-config-fingerprint-key-v1';
  if (fs.existsSync(keyFilePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(keyFilePath, 'utf8'));
      const unsealed = vault.unseal(raw, aad);
      if (typeof unsealed === 'string') {
        const buf = Buffer.from(unsealed, 'hex');
        if (buf.length === 32) return buf;
      }
    } catch (_) {}
  }
  const newRawKey = crypto.randomBytes(32);
  const sealed = vault.seal(newRawKey.toString('hex'), aad);
  const tmpPath = `${keyFilePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(sealed), { flag: 'wx', mode: 0o600 });
    try {
      fs.renameSync(tmpPath, keyFilePath);
      return newRawKey;
    } catch (_) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      const raw = JSON.parse(fs.readFileSync(keyFilePath, 'utf8'));
      const unsealed = vault.unseal(raw, aad);
      return Buffer.from(unsealed, 'hex');
    }
  } catch (_) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    if (fs.existsSync(keyFilePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(keyFilePath, 'utf8'));
        const unsealed = vault.unseal(raw, aad);
        return Buffer.from(unsealed, 'hex');
      } catch (_) {}
    }
    return newRawKey;
  }
}

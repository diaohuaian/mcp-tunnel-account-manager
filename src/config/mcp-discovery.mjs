import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { discoveryIdentity, isMcpServiceId, LEGACY_SERVICES } from '../core/mcp-registry-policy.mjs';
import { publicBinding as formatPublicBinding } from '../adapters/mcp-binding.mjs';
import {
  classifyTxtConfig,
  parseLiteralTxtConfig,
  decodeTextContent,
  privateConfigFingerprint,
  getOrCreateFingerprintKey,
  readableConfigFilename
} from './txt-config-core.mjs';

/**
 * Masks a tunnel ID for safe public display.
 * Never leaks the full ID value.
 */
export function maskTunnelId(id) {
  if (id === null || id === undefined || id === '') return null;
  const str = String(id);
  if (str.length <= 6) return '****';
  if (str.length <= 12) return `${str.slice(0, 3)}...${str.slice(-3)}`;
  return `${str.slice(0, 7)}...${str.slice(-5)}`;
}

export function isConventionalDocumentationFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const base = path.basename(filePath).toLowerCase();
  if (base.endsWith('-licenses.txt')) return true;
  const docNames = new Set([
    'license', 'license.txt', 'licenses', 'licenses.txt',
    'notice', 'notice.txt',
    'readme', 'readme.txt', 'readme.md',
    'copying', 'copying.txt'
  ]);
  return docNames.has(base);
}

export function isSensitiveName(name) {
  if (typeof name !== 'string') return false;
  return /KEY|TOKEN|SECRET|PASS|AUTH|COOKIE|CREDENTIAL/i.test(name);
}

export function isSensitiveValue(val) {
  if (typeof val !== 'string') return false;
  return /key|token|secret|pass|auth|credential|bearer/i.test(val) || /^sk-[a-zA-Z0-9]+$/.test(val);
}

/**
 * Tokenizes a command line string into [executable, ...args]
 * respecting double and single quotes without shell execution.
 */
export function tokenizeCommandLine(str) {
  if (!str || typeof str !== 'string') return [];
  const tokens = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';

  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if ((char === '"' || char === "'") && (!inQuotes || quoteChar === char)) {
      if (inQuotes) {
        inQuotes = false;
        quoteChar = '';
      } else {
        inQuotes = true;
        quoteChar = char;
      }
    } else if (char === ' ' && !inQuotes) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * Restricted Dotenv Parser.
 * Strictly ignores non-literal commands, variable expansions, and prototype properties.
 * Never echoes secret values in warnings.
 */
export function parseRestrictedDotenv(content) {
  const env = Object.create(null);
  const warnings = [];
  if (typeof content !== 'string') return { env, warnings };

  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith('#')) continue;

    const line = raw.startsWith('export ') ? raw.slice(7).trim() : raw;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) {
      warnings.push(`Line ${i + 1}: Ignored non key=value line`);
      continue;
    }

    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      warnings.push(`Line ${i + 1}: Ignored invalid variable name`);
      continue;
    }

    const upper = key.toUpperCase();
    if (upper === '__PROTO__' || upper === 'CONSTRUCTOR' || upper === 'PROTOTYPE') {
      warnings.push(`Line ${i + 1}: Ignored reserved property name: ${key}`);
      continue;
    }

    // Detect command interpolation or variable expansion
    if (/\$\(.*\)|\`.*\`|\$\{.*\}|%.*%/.test(val)) {
      warnings.push(`Line ${i + 1}: Ignored unsupported command interpolation/variable expansion in ${key}`);
      continue;
    }

    // Strip surrounding matching quotes
    if ((val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
        (val.startsWith("'") && val.endsWith("'") && val.length >= 2)) {
      val = val.slice(1, -1);
    } else {
      // Strip unquoted inline comments
      const commentIdx = val.indexOf(' #');
      if (commentIdx !== -1) {
        val = val.slice(0, commentIdx).trim();
      }
    }

    env[key] = val;
  }

  return { env, warnings };
}

/**
 * Restricted BAT Parser.
 * Strictly parses literal `set KEY=VALUE` without executing scripts or variable expansion.
 * Never echoes secret values in warnings.
 */
export function parseRestrictedBat(content) {
  const env = Object.create(null);
  const warnings = [];
  let command = null;
  if (typeof content !== 'string') return { env, command, warnings };

  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || /^rem\b/i.test(line) || /^@rem\b/i.test(line) || /^::/.test(line) || /^@echo\b/i.test(line)) {
      continue;
    }

    if (/^@?set\s+\/[pa]\b/i.test(line)) {
      continue;
    }

    const setMatch = line.match(/^@?set\s+(?:"([^=]+)=(.*)"|([^=]+)=(.*))$/i);
    if (setMatch) {
      const key = (setMatch[1] || setMatch[3]).trim();
      let val = (setMatch[2] !== undefined ? setMatch[2] : setMatch[4] || '').trim();

      if (/%/.test(key)) {
        continue;
      }

      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        warnings.push(`Line ${i + 1}: Ignored invalid variable name`);
        continue;
      }

      const upper = key.toUpperCase();
      if (upper === '__PROTO__' || upper === 'CONSTRUCTOR' || upper === 'PROTOTYPE') {
        warnings.push(`Line ${i + 1}: Ignored reserved property name: ${key}`);
        continue;
      }

      if (/[%&|;<>]/.test(val)) {
        warnings.push(`Line ${i + 1}: Unsupported batch variable expansion or command chaining in ${key}`);
        continue;
      }

      env[key] = val;
      if (key.toUpperCase() === 'MCP_COMMAND') {
        command = val;
      }
      continue;
    }
  }

  return { env, command, warnings };
}

export const parseBatVariables = parseRestrictedBat;

/**
 * Restricted YAML Parser.
 * Supports mappings, sequences, numbers, booleans, null, strings.
 * Disallows custom tags, YAML anchors/aliases, and prototype pollution.
 */
export function parseRestrictedYaml(content) {
  const warnings = [];
  if (typeof content !== 'string' || !content.trim()) {
    return { data: Object.create(null), warnings };
  }

  // Pre-check for anchors, aliases, custom tags
  if (/[&*][a-zA-Z0-9_-]+/.test(content)) {
    warnings.push('YAML anchors and aliases are not supported');
  }
  if (/!\w+/.test(content)) {
    warnings.push('YAML custom tags are not supported');
  }

  const lines = content.split(/\r?\n/);
  const root = Object.create(null);
  const stack = [{ indent: -1, container: root, isArray: false }];

  function parseScalar(val) {
    if (val === 'true') return true;
    if (val === 'false') return false;
    if (val === 'null' || val === '~' || val === '') return null;
    if (/^-?\d+$/.test(val)) {
      const n = parseInt(val, 10);
      if (Number.isSafeInteger(n)) return n;
    }
    if (/^-?\d+\.\d+$/.test(val)) {
      const n = parseFloat(val);
      if (Number.isFinite(n)) return n;
    }
    if ((val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
        (val.startsWith("'") && val.endsWith("'") && val.length >= 2)) {
      return val.slice(1, -1);
    }
    return val;
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    // Ignore pure comment or blank lines
    if (/^\s*(?:#.*)?$/.test(rawLine)) continue;

    const indentMatch = rawLine.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1].length : 0;
    let trimmed = rawLine.slice(indent);

    // Strip comments not inside quotes
    const hashIdx = trimmed.indexOf('#');
    if (hashIdx !== -1) {
      const beforeHash = trimmed.slice(0, hashIdx);
      const quoteCount = (beforeHash.match(/["']/g) || []).length;
      if (quoteCount % 2 === 0) {
        trimmed = beforeHash.trimEnd();
      }
    }
    if (!trimmed) continue;

    // Pop stack frames that are at or deeper than current indentation
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const currentFrame = stack[stack.length - 1];

    if (trimmed.startsWith('- ')) {
      // List item
      const itemText = trimmed.slice(2).trim();
      const parentArray = currentFrame.container;

      if (!currentFrame.isArray || !Array.isArray(parentArray)) {
        continue;
      }

      // Check if list item starts an object: e.g. "- channel: main"
      if (!itemText.startsWith('"') && !itemText.startsWith("'") && /^[a-zA-Z0-9_-]+\s*:/.test(itemText)) {
        const itemObj = Object.create(null);
        parentArray.push(itemObj);

        const colonIdx = itemText.indexOf(':');
        const k = itemText.slice(0, colonIdx).trim();
        const v = itemText.slice(colonIdx + 1).trim();

        if (k && !['__proto__', 'constructor', 'prototype'].includes(k)) {
          if (v) {
            itemObj[k] = parseScalar(v);
          } else {
            const nested = Object.create(null);
            itemObj[k] = nested;
            stack.push({ indent: indent + 2, container: nested, isArray: false });
          }
        }
        // Set indent of itemObj frame to the dash indent so following lines belong to itemObj
        stack.push({ indent, container: itemObj, isArray: false });
      } else {
        // Scalar list item
        parentArray.push(parseScalar(itemText));
      }
      continue;
    }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx !== -1) {
      const k = trimmed.slice(0, colonIdx).trim();
      const v = trimmed.slice(colonIdx + 1).trim();

      if (['__proto__', 'constructor', 'prototype'].includes(k)) {
        warnings.push(`Line ${i + 1}: Ignored forbidden property: ${k}`);
        continue;
      }

      if (v) {
        currentFrame.container[k] = parseScalar(v);
      } else {
        // Peek next line to see if it's an array or object
        let nextIsArray = false;
        for (let j = i + 1; j < lines.length; j++) {
          const nextRaw = lines[j];
          if (/^\s*(?:#.*)?$/.test(nextRaw)) continue;
          if (/^\s*-\s/.test(nextRaw)) {
            nextIsArray = true;
          }
          break;
        }

        const child = nextIsArray ? [] : Object.create(null);
        currentFrame.container[k] = child;
        stack.push({ indent, container: child, isArray: nextIsArray });
      }
    }
  }

  return { data: root, warnings };
}

/**
 * Restricted JSON Parser.
 */
export function parseRestrictedJson(content) {
  const warnings = [];
  if (typeof content !== 'string') {
    return { data: null, warnings: ['Content must be a string'] };
  }
  try {
    const data = JSON.parse(content);
    if (!data || typeof data !== 'object') {
      return { data: null, warnings: ['JSON root must be an object'] };
    }
    return { data, warnings };
  } catch (err) {
    return { data: null, warnings: [`Invalid JSON: ${err.message}`] };
  }
}

/**
 * Factory for MCP Discovery.
 * No constructor I/O.
 */
export function createMcpDiscovery(options = {}) {
  const {
    sources: configuredSources,
    readFile: customReadFile,
    realpath: customRealpath,
    stat: customStat,
    maxBytes = 512 * 1024, // 512 KB
    dataDir,
    vault,
    repo
  } = options;

  const readFileFn = customReadFile || (async (p) => fs.promises.readFile(p, 'utf8'));
  const realpathFn = customRealpath || (async (p) => fs.promises.realpath(p));
  const statFn = customStat || (async (p) => fs.promises.stat(p));

  // Lazy stable HMAC key (NO constructor I/O)
  let hmacKey = null;
  function getHmacKey() {
    if (!hmacKey) {
      if (vault && dataDir) {
        hmacKey = getOrCreateFingerprintKey(vault, dataDir);
      } else {
        hmacKey = crypto.randomBytes(32);
      }
    }
    return hmacKey;
  }

  // In-memory internal candidate cache mapping id -> candidate bundle
  const candidateCache = new Map();
  let inventoryList = [];

  async function getDefaultSources() {
    const appData = process.env.APPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming') : '');
    const userProfile = process.env.USERPROFILE || '';
    const defs = [];
    const seenPaths = new Set();

    function addDef(item) {
      const norm = path.resolve(item.path).toLowerCase();
      if (!seenPaths.has(norm)) {
        seenPaths.add(norm);
        defs.push(item);
      }
    }

    // 1. Fixed authorized legacy sources
    if (appData) {
      addDef({ path: path.join(appData, 'tunnel-client', 'antigravity-local.yaml'), kind: 'yaml', serviceId: 'antigravity-mcp', label: 'Antigravity MCP' });
      addDef({ path: path.join(appData, 'tunnel-client', 'overleaf.yaml'), kind: 'yaml', serviceId: 'overleaf-mcp', label: 'Overleaf MCP' });
    }
    if (userProfile) {
      addDef({ path: path.join(userProfile, '.openai-tunnel', 'tunnel.env'), kind: 'dotenv' });
      addDef({ path: path.join(userProfile, '.openai-tunnel', 'start-overleaf-tunnel.bat'), kind: 'bat', serviceId: 'overleaf-mcp', label: 'Overleaf MCP' });
      addDef({ path: path.join(userProfile, '.openai-tunnel', 'start-antigravity-tunnel.bat'), kind: 'bat', serviceId: 'antigravity-mcp', label: 'Antigravity MCP' });
    }

    // 2. Expand ONLY authorized roots (%APPDATA%/tunnel-client and %USERPROFILE%/.openai-tunnel) for top-level config files
    const authorizedRoots = [];
    if (appData) authorizedRoots.push(path.join(appData, 'tunnel-client'));
    if (userProfile) authorizedRoots.push(path.join(userProfile, '.openai-tunnel'));

    const ALLOWED_EXTS = new Set(['.txt', '.json', '.yaml', '.yml', '.env', '.bat', '.cmd']);
    const EXCLUDED_NAMES = /^(?:tests|fixtures|\.git|node_modules|\.gpt.*|reports|build)$/i;

    for (const root of authorizedRoots) {
      try {
        if (!fs.existsSync(root)) continue;
        const entries = await fs.promises.readdir(root, { withFileTypes: true });
        let count = 0;
        for (const entry of entries) {
          if (count >= 100) break;
          if (entry.isDirectory() || EXCLUDED_NAMES.test(entry.name) || isConventionalDocumentationFile(entry.name)) continue;
          if (entry.isSymbolicLink()) {
            try {
              const real = await realpathFn(path.join(root, entry.name));
              if (!real.toLowerCase().startsWith(path.resolve(root).toLowerCase())) {
                continue;
              }
            } catch {
              continue;
            }
          }
          const ext = path.extname(entry.name).toLowerCase();
          if (ALLOWED_EXTS.has(ext)) {
            const fullPath = path.join(root, entry.name);
            const kind = ext === '.txt' ? 'txt' : resolveKind(fullPath);
            addDef({ path: fullPath, kind });
            count++;
          }
        }
      } catch (_) {}
    }

    return defs;
  }

  function resolveKind(sourcePath, kindHint) {
    if (kindHint) return kindHint;
    const ext = path.extname(sourcePath).toLowerCase();
    if (ext === '.txt') return 'txt';
    if (ext === '.yaml' || ext === '.yml') return 'yaml';
    if (ext === '.json') return 'json';
    if (ext === '.env') return 'dotenv';
    if (ext === '.bat' || ext === '.cmd') return 'bat';
    return 'yaml';
  }

  function computeFingerprint(rawBufferOrString) {
    return crypto.createHash('sha256').update(rawBufferOrString).digest('hex');
  }

  /**
   * Scans configured sources and returns safe candidate DTO array.
   */
  async function scan() {
    const sourcesToScan = configuredSources !== undefined ? configuredSources : await getDefaultSources();
    candidateCache.clear();
    inventoryList = [];

    const normalizedSources = [];
    for (const src of sourcesToScan) {
      if (typeof src === 'string') {
        normalizedSources.push({ path: src, kind: resolveKind(src) });
      } else if (src && typeof src === 'object' && src.path) {
        normalizedSources.push({ ...src, kind: resolveKind(src.path, src.kind) });
      }
    }

    // Step 1: Pass over dotenv / bat sources to collect companion environment variables
    const companionEnv = Object.create(null);
    for (const src of normalizedSources) {
      if (src.kind === 'dotenv' || src.kind === 'bat') {
        try {
          const st = await statFn(src.path);
          if (!st.isFile() || st.size > maxBytes) continue;
          const content = await readFileFn(src.path);
          const decoded = decodeTextContent(content, maxBytes);
          const text = decoded.text || (typeof content === 'string' ? content : content.toString('utf8'));
          if (src.kind === 'dotenv') {
            const parsed = parseRestrictedDotenv(text);
            Object.assign(companionEnv, parsed.env);
          } else if (src.kind === 'bat') {
            const parsed = parseRestrictedBat(text);
            Object.assign(companionEnv, parsed.env);
          }
        } catch (_) {
          // Missing or unreadable companion file ignored
        }
      }
    }

    // Step 2: Parse each source and build candidates
    for (const src of normalizedSources) {
      let canonicalPath;
      let st;
      try {
        st = await statFn(src.path);
        if (!st.isFile()) {
          inventoryList.push({
            filename: path.basename(src.path),
            type: src.kind || resolveKind(src.path),
            path: src.path,
            mtime: null,
            displayName: src.label || path.basename(src.path),
            credentials: { configured: false, hasApiKey: false, hasTunnelId: false, maskedTunnelId: null, hasOrganizationId: false },
            status: 'error',
            reason: '目标不是常规文件'
          });
          continue;
        }
        if (st.size > maxBytes) {
          inventoryList.push({
            filename: path.basename(src.path),
            type: src.kind || resolveKind(src.path),
            path: src.path,
            mtime: st.mtime?.toISOString() || null,
            displayName: src.label || path.basename(src.path),
            credentials: { configured: false, hasApiKey: false, hasTunnelId: false, maskedTunnelId: null, hasOrganizationId: false },
            status: 'error',
            reason: '文件大小超过限制 (512KB)'
          });
          continue;
        }
        canonicalPath = await realpathFn(src.path);
      } catch (_) {
        inventoryList.push({
          filename: path.basename(src.path),
          type: src.kind || resolveKind(src.path),
          path: src.path,
          mtime: null,
          displayName: src.label || path.basename(src.path),
          credentials: { configured: false, hasApiKey: false, hasTunnelId: false, maskedTunnelId: null, hasOrganizationId: false },
          status: 'error',
          reason: '预期源配置文件未找到'
        });
        continue;
      }

      let content;
      try {
        content = await readFileFn(canonicalPath);
      } catch (readErr) {
        inventoryList.push({
          filename: path.basename(canonicalPath),
          type: src.kind || resolveKind(canonicalPath),
          path: canonicalPath,
          mtime: st?.mtime?.toISOString() || null,
          displayName: src.label || path.basename(canonicalPath),
          credentials: { configured: false, hasApiKey: false, hasTunnelId: false, maskedTunnelId: null, hasOrganizationId: false },
          status: 'error',
          reason: '读取配置文件失败'
        });
        continue;
      }

      const decoded = decodeTextContent(content, maxBytes);
      const text = decoded.text || (typeof content === 'string' ? content : content.toString('utf8'));
      const fingerprint = computeFingerprint(text);

      if (src.kind === 'txt') {
        await processTxtSource(src, canonicalPath, content, fingerprint, companionEnv, inventoryList);
      } else if (src.kind === 'yaml') {
        await processYamlSource(src, canonicalPath, text, fingerprint, companionEnv, inventoryList);
      } else if (src.kind === 'json') {
        await processJsonSource(src, canonicalPath, text, fingerprint, inventoryList);
      } else if (src.kind === 'dotenv') {
        await processDotenvSource(src, canonicalPath, text, fingerprint, inventoryList);
      } else if (src.kind === 'bat') {
        await processBatSource(src, canonicalPath, text, fingerprint, inventoryList);
      }
    }

    // Deduplicate candidates by canonicalFingerprint
    const seenFingerprints = new Map();
    for (const [id, bundle] of candidateCache.entries()) {
      if (bundle.canonicalFingerprint) {
        if (seenFingerprints.has(bundle.canonicalFingerprint)) {
          const firstId = seenFingerprints.get(bundle.canonicalFingerprint);
          bundle.candidate.duplicateOf = firstId;
          const invItem = inventoryList.find(item => item.candidateId === id);
          if (invItem) {
            invItem.status = 'duplicate';
            invItem.reason = '与已有配置语义重复';
          }
        } else {
          seenFingerprints.set(bundle.canonicalFingerprint, id);
        }
      }
    }

    // Check if any candidates are already imported in repo
    if (repo) {
      try {
        const importedIds = new Set();
        if (typeof repo.hasProfileProvenance === 'function') {
          for (const [id, bundle] of candidateCache.entries()) {
            if (repo.hasProfileProvenance(id) ||
                (bundle.provenance?.identity && repo.hasProfileProvenance(bundle.provenance.identity)) ||
                (bundle.canonicalFingerprint && repo.hasProfileProvenance(bundle.canonicalFingerprint))) {
              importedIds.add(id);
            }
          }
        }

        const defGetter = typeof repo.getDefinition === 'function' ? repo.getDefinition.bind(repo)
          : (repo.registry && typeof repo.registry.getDefinition === 'function' ? repo.registry.getDefinition.bind(repo.registry) : null);
        if (defGetter) {
          for (const [id, bundle] of candidateCache.entries()) {
            if (bundle.definition?.id && !bundle.profileInput) {
              try {
                const def = await defGetter(bundle.definition.id);
                if (def) {
                  importedIds.add(id);
                }
              } catch (_) {}
            }
          }
        }

        for (const id of importedIds) {
          const invItem = inventoryList.find(item => item.candidateId === id);
          if (invItem && invItem.status === 'found') {
            invItem.status = 'imported';
            invItem.reason = '已导入为本地配置';
          }
        }
      } catch (_) {}
    }

    return Array.from(candidateCache.values()).map(bundle => structuredClone(bundle.candidate));
  }

  async function processYamlSource(src, canonicalPath, text, fingerprint, companionEnv, inv = []) {
    const { data: parsed, warnings } = parseRestrictedYaml(text);
    if (!parsed || typeof parsed !== 'object') return;

    // Determine serviceId
    let serviceId = src.serviceId;
    if (!serviceId) {
      const lower = canonicalPath.toLowerCase();
      if (lower.includes('overleaf')) serviceId = 'overleaf-mcp';
      else if (lower.includes('antigravity')) serviceId = 'antigravity-mcp';
      else if (parsed.serviceId && isMcpServiceId(parsed.serviceId)) serviceId = parsed.serviceId;
      else {
        const hash = crypto.createHash('sha256').update(canonicalPath + ':main').digest('hex').slice(0, 16);
        serviceId = `mcp_${hash}`;
      }
    }

    const selector = src.selector || 'main';
    const id = discoveryIdentity({ serviceId, canonicalPath, selector });

    let label = src.label;
    if (!label) {
      if (serviceId === 'overleaf-mcp') label = 'Overleaf MCP';
      else if (serviceId === 'antigravity-mcp') label = 'Antigravity MCP';
      else label = parsed.label || selector;
    }

    // Credentials extraction
    const rawTunnelId = parsed.control_plane?.tunnel_id || null;
    let rawApiKey = parsed.control_plane?.api_key || null;
    const rawOrgId = parsed.control_plane?.organization_id || null;

    if (rawApiKey && typeof rawApiKey === 'string' && rawApiKey.startsWith('env:')) {
      const envVar = rawApiKey.slice(4).trim();
      if (companionEnv[envVar]) {
        rawApiKey = companionEnv[envVar];
      } else {
        warnings.push(`Unresolved environment reference: ${envVar}`);
        rawApiKey = null;
      }
    }

    const hasTunnelId = Boolean(rawTunnelId);
    const hasApiKey = Boolean(rawApiKey);
    const hasOrganizationId = Boolean(rawOrgId);
    const masked = maskTunnelId(rawTunnelId);

    // Binding extraction
    let internalBinding = null;
    let publicBinding = null;
    let executable = null;
    let cwd = parsed.mcp?.cwd || parsed.server?.cwd || null;

    const cmdStr = parsed.mcp?.commands?.[0]?.command || parsed.server?.command || null;
    if (cmdStr && typeof cmdStr === 'string') {
      const tokens = tokenizeCommandLine(cmdStr);
      if (tokens.length > 0) {
        executable = tokens[0];
        const rawArgs = tokens.slice(1);
        const internalArgs = rawArgs.map((arg, idx) => ({
          id: `arg_${idx}`,
          value: arg,
          secret: isSensitiveValue(arg)
        }));
        internalBinding = {
          type: 'stdio',
          executable,
          args: internalArgs,
          cwd
        };
        publicBinding = {
          type: 'stdio',
          executable,
          args: internalArgs.map(a => a.secret
            ? { id: a.id, secret: true, configured: true }
            : { id: a.id, secret: false, configured: true, value: a.value }),
          cwd
        };
      }
    } else if (parsed.server?.url) {
      const rawHeaders = parsed.server.headers || {};
      const internalHeaders = Object.create(null);
      const publicHeaders = Object.create(null);
      for (const [hk, hv] of Object.entries(rawHeaders)) {
        const valStr = String(hv);
        const secret = isSensitiveName(hk) || isSensitiveValue(valStr);
        internalHeaders[hk] = { value: valStr, secret };
        publicHeaders[hk] = secret
          ? { secret: true, configured: true }
          : { secret: false, configured: true, value: valStr };
      }
      internalBinding = {
        type: 'http',
        url: parsed.server.url,
        headers: internalHeaders
      };
      publicBinding = formatPublicBinding(internalBinding);
    }

    const locations = {
      sourceConfigPath: canonicalPath,
      executable,
      cwd
    };

    const candidateDto = {
      id,
      serviceId,
      label,
      sourceConfigPath: canonicalPath,
      sourceKind: 'yaml',
      selector,
      fingerprint,
      credentialStatus: {
        configured: Boolean(hasTunnelId && hasApiKey),
        hasApiKey,
        hasTunnelId,
        maskedTunnelId: masked,
        hasOrganizationId
      },
      warnings,
      binding: publicBinding,
      locations
    };

    const definition = {
      id: serviceId,
      label,
      enabled: true,
      revision: 1,
      sortOrder: serviceId === 'antigravity-mcp' ? 1000 : 500,
      controlCarrier: serviceId === 'antigravity-mcp',
      binding: internalBinding,
      environment: Object.create(null),
      locations,
      provenance: {
        identity: id,
        sourceConfigPath: canonicalPath,
        sourceKind: 'yaml',
        selector
      }
    };

    const profileInput = {
      label,
      services: {
        [serviceId]: {
          tunnelId: rawTunnelId || '',
          apiKey: rawApiKey || '',
          organizationId: rawOrgId || null
        }
      }
    };

    const canonicalFingerprint = privateConfigFingerprint({
      serviceId,
      tunnelId: rawTunnelId,
      apiKey: rawApiKey,
      organizationId: rawOrgId,
      transport: internalBinding?.type,
      url: internalBinding?.url,
      command: internalBinding?.executable,
      args: internalBinding?.args?.map(a => a.value),
      cwd: internalBinding?.cwd
    }, getHmacKey());

    candidateCache.set(id, {
      candidate: candidateDto,
      definition,
      profileInput,
      provenance: definition.provenance,
      canonicalPath,
      fingerprint,
      canonicalFingerprint
    });

    inv.push({
      filename: path.basename(canonicalPath),
      type: 'yaml',
      path: canonicalPath,
      mtime: (await statFn(canonicalPath).catch(() => null))?.mtime?.toISOString() || null,
      displayName: label,
      credentials: candidateDto.credentialStatus,
      status: 'found',
      reason: '有效 YAML 配置文件，可导入',
      candidateId: id,
      serviceId
    });
  }

  async function processJsonSource(src, canonicalPath, text, fingerprint, inv = []) {
    const { data: parsed, warnings } = parseRestrictedJson(text);
    if (!parsed || typeof parsed !== 'object') return;

    const servers = parsed.mcpServers && typeof parsed.mcpServers === 'object'
      ? parsed.mcpServers
      : (parsed.command || parsed.url ? { default: parsed } : {});

    for (const [selector, srv] of Object.entries(servers)) {
      if (!srv || typeof srv !== 'object') continue;
      if (['__proto__', 'constructor', 'prototype'].includes(selector)) continue;

      let serviceId;
      if (selector === 'overleaf-mcp' || selector === 'overleaf') {
        serviceId = 'overleaf-mcp';
      } else if (selector === 'antigravity-mcp' || selector === 'antigravity') {
        serviceId = 'antigravity-mcp';
      } else if (srv.serviceId && isMcpServiceId(srv.serviceId)) {
        serviceId = srv.serviceId;
      } else {
        const hash = crypto.createHash('sha256').update(`${canonicalPath}:${selector}`).digest('hex').slice(0, 16);
        serviceId = `mcp_${hash}`;
      }

      const id = discoveryIdentity({ serviceId, canonicalPath, selector });
      const label = srv.label || srv.name || selector;

      let internalBinding = null;
      let publicBinding = null;
      let executable = null;
      const cwd = srv.cwd || null;

      if (srv.command) {
        executable = String(srv.command);
        const argsArray = Array.isArray(srv.args) ? srv.args : [];
        const internalArgs = argsArray.map((arg, idx) => {
          const str = String(arg);
          return {
            id: `arg_${idx}`,
            value: str,
            secret: isSensitiveValue(str)
          };
        });
        internalBinding = {
          type: 'stdio',
          executable,
          args: internalArgs,
          cwd
        };
        publicBinding = {
          type: 'stdio',
          executable,
          args: internalArgs.map(a => a.secret
            ? { id: a.id, secret: true, configured: true }
            : { id: a.id, secret: false, configured: true, value: a.value }),
          cwd
        };
      } else if (srv.url) {
        const rawHeaders = srv.headers || {};
        const internalHeaders = Object.create(null);
        const publicHeaders = Object.create(null);
        for (const [hk, hv] of Object.entries(rawHeaders)) {
          const str = String(hv);
          const secret = isSensitiveName(hk) || isSensitiveValue(str);
          internalHeaders[hk] = { value: str, secret };
          publicHeaders[hk] = secret
            ? { secret: true, configured: true }
            : { secret: false, configured: true, value: str };
        }
        internalBinding = {
          type: 'http',
          url: srv.url,
          headers: internalHeaders
        };
        publicBinding = formatPublicBinding(internalBinding);
      }

      // Internal environment
      const internalEnv = Object.create(null);
      if (srv.env && typeof srv.env === 'object') {
        for (const [ek, ev] of Object.entries(srv.env)) {
          if (['__proto__', 'constructor', 'prototype'].includes(ek)) continue;
          const valStr = String(ev);
          internalEnv[ek] = {
            value: valStr,
            secret: isSensitiveName(ek) || isSensitiveValue(valStr)
          };
        }
      }

      const locations = {
        sourceConfigPath: canonicalPath,
        executable,
        cwd
      };

      const candidateDto = {
        id,
        serviceId,
        label,
        sourceConfigPath: canonicalPath,
        sourceKind: 'json',
        selector,
        fingerprint,
        credentialStatus: {
          configured: true,
          hasApiKey: false,
          hasTunnelId: false,
          maskedTunnelId: null,
          hasOrganizationId: false
        },
        warnings: [...warnings],
        binding: publicBinding,
        locations
      };

      const definition = {
        id: serviceId,
        label,
        enabled: true,
        revision: 1,
        sortOrder: 500,
        controlCarrier: false,
        binding: internalBinding,
        environment: internalEnv,
        locations,
        provenance: {
          identity: id,
          sourceConfigPath: canonicalPath,
          sourceKind: 'json',
          selector
        }
      };

      const profileInput = {
        label,
        services: {
          [serviceId]: {
            tunnelId: '',
            apiKey: '',
            organizationId: null
          }
        }
      };

      const canonicalFingerprint = privateConfigFingerprint({
        serviceId,
        transport: internalBinding?.type,
        url: internalBinding?.url,
        command: internalBinding?.executable,
        args: internalBinding?.args?.map(a => a.value),
        cwd: internalBinding?.cwd
      }, getHmacKey());

      candidateCache.set(id, {
        candidate: candidateDto,
        definition,
        profileInput,
        provenance: definition.provenance,
        canonicalPath,
        fingerprint,
        canonicalFingerprint
      });

      inv.push({
        filename: path.basename(canonicalPath),
        type: 'json',
        path: canonicalPath,
        mtime: (await statFn(canonicalPath).catch(() => null))?.mtime?.toISOString() || null,
        displayName: label,
        credentials: candidateDto.credentialStatus,
        status: 'found',
        reason: '有效 JSON 配置文件，可导入',
        candidateId: id,
        serviceId
      });
    }
  }

  async function processDotenvSource(src, canonicalPath, text, fingerprint, inv = []) {
    const { env, warnings } = parseRestrictedDotenv(text);
    const rawTunnelId = env.TUNNEL_ID || env.OVERLEAF_TUNNEL_ID || null;
    const rawApiKey = env.CONTROL_PLANE_API_KEY || env.OVERLEAF_API_KEY || null;
    const rawOrgId = env.ORGANIZATION_ID || null;

    let serviceId = src.serviceId;
    if (!serviceId) {
      const lower = canonicalPath.toLowerCase();
      if (lower.includes('overleaf')) serviceId = 'overleaf-mcp';
      else if (lower.includes('antigravity')) serviceId = 'antigravity-mcp';
      else {
        const hash = crypto.createHash('sha256').update(canonicalPath + ':env').digest('hex').slice(0, 16);
        serviceId = `mcp_${hash}`;
      }
    }

    const selector = src.selector || 'env';
    const id = discoveryIdentity({ serviceId, canonicalPath, selector });
    const label = src.label || (serviceId === 'overleaf-mcp' ? 'Overleaf MCP' : (serviceId === 'antigravity-mcp' ? 'Antigravity MCP' : 'Environment Tunnel'));

    const hasTunnelId = Boolean(rawTunnelId);
    const hasApiKey = Boolean(rawApiKey);

    const candidateDto = {
      id,
      serviceId,
      label,
      sourceConfigPath: canonicalPath,
      sourceKind: 'dotenv',
      selector,
      fingerprint,
      credentialStatus: {
        configured: Boolean(hasTunnelId && hasApiKey),
        hasApiKey,
        hasTunnelId,
        maskedTunnelId: maskTunnelId(rawTunnelId),
        hasOrganizationId: Boolean(rawOrgId)
      },
      warnings,
      binding: null,
      locations: {
        sourceConfigPath: canonicalPath,
        executable: null,
        cwd: null
      }
    };

    const definition = {
      id: serviceId,
      label,
      enabled: true,
      revision: 1,
      sortOrder: 500,
      controlCarrier: false,
      binding: null,
      environment: Object.create(null),
      locations: candidateDto.locations,
      provenance: {
        identity: id,
        sourceConfigPath: canonicalPath,
        sourceKind: 'dotenv',
        selector
      }
    };

    const profileInput = {
      label,
      services: {
        [serviceId]: {
          tunnelId: rawTunnelId || '',
          apiKey: rawApiKey || '',
          organizationId: rawOrgId || null
        }
      }
    };

    const canonicalFingerprint = privateConfigFingerprint({
      serviceId,
      tunnelId: rawTunnelId,
      apiKey: rawApiKey,
      organizationId: rawOrgId
    }, getHmacKey());

    candidateCache.set(id, {
      candidate: candidateDto,
      definition,
      profileInput,
      provenance: definition.provenance,
      canonicalPath,
      fingerprint,
      canonicalFingerprint
    });

    inv.push({
      filename: path.basename(canonicalPath),
      type: 'dotenv',
      path: canonicalPath,
      mtime: (await statFn(canonicalPath).catch(() => null))?.mtime?.toISOString() || null,
      displayName: label,
      credentials: candidateDto.credentialStatus,
      status: 'found',
      reason: '有效环境变量配置文件，可导入',
      candidateId: id,
      serviceId
    });
  }

  async function processBatSource(src, canonicalPath, text, fingerprint, inv = []) {
    const { env, command, warnings } = parseRestrictedBat(text);
    const rawTunnelId = env.TUNNEL_ID || null;
    const rawApiKey = env.CONTROL_PLANE_API_KEY || null;
    const rawOrgId = env.ORGANIZATION_ID || null;

    let serviceId = src.serviceId;
    if (!serviceId) {
      const lower = canonicalPath.toLowerCase();
      if (lower.includes('overleaf')) serviceId = 'overleaf-mcp';
      else if (lower.includes('antigravity')) serviceId = 'antigravity-mcp';
      else {
        const hash = crypto.createHash('sha256').update(canonicalPath + ':bat').digest('hex').slice(0, 16);
        serviceId = `mcp_${hash}`;
      }
    }

    const selector = src.selector || 'bat';
    const id = discoveryIdentity({ serviceId, canonicalPath, selector });
    const label = src.label || (serviceId === 'overleaf-mcp' ? 'Overleaf MCP' : (serviceId === 'antigravity-mcp' ? 'Antigravity MCP' : 'Batch Tunnel'));

    let internalBinding = null;
    let publicBinding = null;
    let executable = null;

    if (command) {
      const tokens = tokenizeCommandLine(command);
      if (tokens.length > 0) {
        executable = tokens[0];
        const internalArgs = tokens.slice(1).map((arg, idx) => ({
          id: `arg_${idx}`,
          value: arg,
          secret: isSensitiveValue(arg)
        }));
        internalBinding = {
          type: 'stdio',
          executable,
          args: internalArgs,
          cwd: null
        };
        publicBinding = {
          type: 'stdio',
          executable,
          args: internalArgs.map(a => a.secret
            ? { id: a.id, secret: true, configured: true }
            : { id: a.id, secret: false, configured: true, value: a.value }),
          cwd: null
        };
      }
    }

    const candidateDto = {
      id,
      serviceId,
      label,
      sourceConfigPath: canonicalPath,
      sourceKind: 'bat',
      selector,
      fingerprint,
      credentialStatus: {
        configured: Boolean(rawTunnelId && rawApiKey),
        hasApiKey: Boolean(rawApiKey),
        hasTunnelId: Boolean(rawTunnelId),
        maskedTunnelId: maskTunnelId(rawTunnelId),
        hasOrganizationId: Boolean(rawOrgId)
      },
      warnings,
      binding: publicBinding,
      locations: {
        sourceConfigPath: canonicalPath,
        executable,
        cwd: null
      }
    };

    const definition = {
      id: serviceId,
      label,
      enabled: true,
      revision: 1,
      sortOrder: 500,
      controlCarrier: false,
      binding: internalBinding,
      environment: Object.create(null),
      locations: candidateDto.locations,
      provenance: {
        identity: id,
        sourceConfigPath: canonicalPath,
        sourceKind: 'bat',
        selector
      }
    };

    const profileInput = {
      label,
      services: {
        [serviceId]: {
          tunnelId: rawTunnelId || '',
          apiKey: rawApiKey || '',
          organizationId: rawOrgId || null
        }
      }
    };

    const canonicalFingerprint = privateConfigFingerprint({
      serviceId,
      tunnelId: rawTunnelId,
      apiKey: rawApiKey,
      organizationId: rawOrgId,
      transport: internalBinding?.type,
      command: internalBinding?.executable,
      args: internalBinding?.args?.map(a => a.value)
    }, getHmacKey());

    candidateCache.set(id, {
      candidate: candidateDto,
      definition,
      profileInput,
      provenance: definition.provenance,
      canonicalPath,
      fingerprint,
      canonicalFingerprint
    });

    inv.push({
      filename: path.basename(canonicalPath),
      type: 'bat',
      path: canonicalPath,
      mtime: (await statFn(canonicalPath).catch(() => null))?.mtime?.toISOString() || null,
      displayName: label,
      credentials: candidateDto.credentialStatus,
      status: 'found',
      reason: '有效批处理脚本配置，可导入',
      candidateId: id,
      serviceId
    });
  }

  async function processTxtSource(src, canonicalPath, rawContent, fingerprint, companionEnv, inv) {
    if (isConventionalDocumentationFile(canonicalPath)) {
      inv.push({
        filename: path.basename(canonicalPath),
        type: 'txt',
        path: canonicalPath,
        mtime: (await statFn(canonicalPath).catch(() => null))?.mtime?.toISOString() || null,
        displayName: path.basename(canonicalPath),
        credentials: { configured: false, hasApiKey: false, hasTunnelId: false, maskedTunnelId: null, hasOrganizationId: false },
        status: 'ignored',
        reason: '非配置文档/已忽略'
      });
      return;
    }
    let decoded;
    try {
      decoded = decodeTextContent(rawContent, maxBytes);
    } catch (_) {
      inv.push({
        filename: path.basename(canonicalPath),
        type: 'txt',
        path: canonicalPath,
        mtime: (await statFn(canonicalPath).catch(() => null))?.mtime?.toISOString() || null,
        displayName: path.basename(canonicalPath),
        credentials: { configured: false, hasApiKey: false, hasTunnelId: false, maskedTunnelId: null, hasOrganizationId: false },
        status: 'error',
        reason: '文件过大或读取错误'
      });
      return;
    }

    if (!decoded || !decoded.text) {
      inv.push({
        filename: path.basename(canonicalPath),
        type: 'txt',
        path: canonicalPath,
        mtime: (await statFn(canonicalPath).catch(() => null))?.mtime?.toISOString() || null,
        displayName: path.basename(canonicalPath),
        credentials: { configured: false, hasApiKey: false, hasTunnelId: false, maskedTunnelId: null, hasOrganizationId: false },
        status: 'error',
        reason: '文件编码不支持'
      });
      return;
    }

    const text = decoded.text;
    const classified = classifyTxtConfig(text);

    if (classified.format === 'empty') {
      inv.push({
        filename: path.basename(canonicalPath),
        type: 'txt',
        path: canonicalPath,
        mtime: (await statFn(canonicalPath).catch(() => null))?.mtime?.toISOString() || null,
        displayName: path.basename(canonicalPath),
        credentials: { configured: false, hasApiKey: false, hasTunnelId: false, maskedTunnelId: null, hasOrganizationId: false },
        status: 'review',
        reason: '文件内容为空'
      });
      return;
    }

    if (classified.format === 'review') {
      const isCodeFence = classified.issues?.some(i => i.code === 'CODE_FENCE_REQUIRES_REVIEW');
      inv.push({
        filename: path.basename(canonicalPath),
        type: 'txt',
        path: canonicalPath,
        mtime: (await statFn(canonicalPath).catch(() => null))?.mtime?.toISOString() || null,
        displayName: path.basename(canonicalPath),
        credentials: { configured: false, hasApiKey: false, hasTunnelId: false, maskedTunnelId: null, hasOrganizationId: false },
        status: 'review',
        reason: isCodeFence ? '包含代码块围栏，需人工审核' : '无效的JSON结构或需人工审核'
      });
      return;
    }

    if (classified.format === 'json') {
      return await processJsonSource(src, canonicalPath, text, fingerprint, inv);
    }

    if (classified.format === 'yaml') {
      return await processYamlSource(src, canonicalPath, text, fingerprint, companionEnv, inv);
    }

    // Literal format
    const parsed = parseLiteralTxtConfig(text);
    if (!parsed.blocks || parsed.blocks.length === 0) {
      inv.push({
        filename: path.basename(canonicalPath),
        type: 'txt',
        path: canonicalPath,
        mtime: (await statFn(canonicalPath).catch(() => null))?.mtime?.toISOString() || null,
        displayName: path.basename(canonicalPath),
        credentials: { configured: false, hasApiKey: false, hasTunnelId: false, maskedTunnelId: null, hasOrganizationId: false },
        status: 'review',
        reason: '未解析到有效配置块'
      });
      return;
    }

    for (const [bIndex, block] of parsed.blocks.entries()) {
      const blockIdSuffix = block.section ? `:${block.section}` : (parsed.blocks.length > 1 ? `:${bIndex}` : '');
      const blockLabel = block.values.profileName || block.values.serviceName || block.section || path.basename(canonicalPath, path.extname(canonicalPath));

      let serviceId = block.values.serviceId || src.serviceId;
      if (!serviceId) {
        const lower = canonicalPath.toLowerCase();
        if (lower.includes('overleaf')) serviceId = 'overleaf-mcp';
        else if (lower.includes('antigravity')) serviceId = 'antigravity-mcp';
        else {
          const h = crypto.createHash('sha256').update(canonicalPath + blockIdSuffix).digest('hex').slice(0, 16);
          serviceId = `mcp_${h}`;
        }
      }

      const selector = block.section || (parsed.blocks.length > 1 ? `block_${bIndex}` : 'txt');
      const id = discoveryIdentity({ serviceId, canonicalPath, selector });

      if (block.kind === 'tunnel_account') {
        const hasTunnel = Boolean(block.values.tunnelId);
        const hasKey = Boolean(block.values.apiKey);
        const hasOrg = Boolean(block.values.organizationId);
        const masked = maskTunnelId(block.values.tunnelId);

        if (!block.syntaxReady) {
          inv.push({
            filename: path.basename(canonicalPath),
            type: 'txt',
            path: canonicalPath,
            mtime: (await statFn(canonicalPath).catch(() => null))?.mtime?.toISOString() || null,
            displayName: `${serviceId} (${blockLabel})`,
            credentials: { configured: false, hasApiKey: hasKey, hasTunnelId: hasTunnel, maskedTunnelId: masked, hasOrganizationId: hasOrg },
            status: 'review',
            reason: block.issues.map(i => i.code).join(', ') || '缺少必要凭据字段',
            serviceId
          });
          continue;
        }

        const candidateDto = {
          id,
          serviceId,
          label: block.values.serviceName || blockLabel || serviceId,
          sourceConfigPath: canonicalPath,
          sourceKind: 'txt',
          selector,
          fingerprint,
          credentialStatus: {
            configured: true,
            hasApiKey: true,
            hasTunnelId: true,
            maskedTunnelId: masked,
            hasOrganizationId: hasOrg
          },
          warnings: block.issues.map(i => i.code),
          binding: null,
          locations: { sourceConfigPath: canonicalPath, executable: null, cwd: null },
          autoEligible: true
        };

        const definition = {
          id: serviceId,
          label: candidateDto.label,
          enabled: false,
          revision: 1,
          sortOrder: 500,
          controlCarrier: false,
          binding: null,
          environment: Object.create(null),
          locations: candidateDto.locations,
          provenance: { identity: id, sourceConfigPath: canonicalPath, sourceKind: 'txt', selector }
        };

        const profileInput = {
          label: block.values.profileName || blockLabel || '未命名账号',
          services: {
            [serviceId]: {
              tunnelId: block.values.tunnelId,
              apiKey: block.values.apiKey,
              organizationId: block.values.organizationId || null
            }
          }
        };

        const canonicalFingerprint = privateConfigFingerprint({
          serviceId,
          tunnelId: block.values.tunnelId,
          apiKey: block.values.apiKey,
          organizationId: block.values.organizationId || null
        }, getHmacKey());

        candidateCache.set(id, {
          candidate: candidateDto,
          definition,
          profileInput,
          provenance: definition.provenance,
          canonicalPath,
          fingerprint,
          canonicalFingerprint
        });

        inv.push({
          filename: path.basename(canonicalPath),
          type: 'txt',
          path: canonicalPath,
          mtime: (await statFn(canonicalPath).catch(() => null))?.mtime?.toISOString() || null,
          displayName: `${serviceId} (${profileInput.label})`,
          credentials: candidateDto.credentialStatus,
          status: 'found',
          reason: '有效隧道账号配置，可自动/手动导入',
          candidateId: id,
          serviceId
        });
      } else if (block.kind === 'service_definition') {
        if (!block.syntaxReady || block.issues.some(i => i.code === 'AMBIGUOUS_BINDING')) {
          inv.push({
            filename: path.basename(canonicalPath),
            type: 'txt',
            path: canonicalPath,
            mtime: (await statFn(canonicalPath).catch(() => null))?.mtime?.toISOString() || null,
            displayName: blockLabel,
            credentials: { configured: false, hasApiKey: false, hasTunnelId: false, maskedTunnelId: null, hasOrganizationId: false },
            status: 'review',
            reason: block.issues.some(i => i.code === 'AMBIGUOUS_BINDING') ? '同时指定URL与可执行程序，存在歧义' : '服务定义语法错误需人工复核',
            serviceId
          });
          continue;
        }

        let internalBinding = null;
        let pubBinding = null;
        if (block.values.url) {
          internalBinding = { type: 'http', url: block.values.url, headers: {} };
          pubBinding = { type: 'http', url: block.values.url, headers: {} };
        } else if (block.values.command) {
          internalBinding = {
            type: 'stdio',
            executable: block.values.command,
            args: Array.isArray(block.values.args) ? block.values.args.map((a, i) => ({ id: `arg_${i}`, value: a, secret: isSensitiveValue(a) })) : [],
            cwd: block.values.cwd || null
          };
          pubBinding = formatPublicBinding(internalBinding);
        }

        const candidateDto = {
          id,
          serviceId,
          label: block.values.serviceName || blockLabel || serviceId,
          sourceConfigPath: canonicalPath,
          sourceKind: 'txt',
          selector,
          fingerprint,
          credentialStatus: { configured: false, hasApiKey: false, hasTunnelId: false, maskedTunnelId: null, hasOrganizationId: false },
          warnings: [],
          binding: pubBinding,
          locations: { sourceConfigPath: canonicalPath, executable: block.values.command || null, cwd: block.values.cwd || null },
          autoEligible: true
        };

        const definition = {
          id: serviceId,
          label: candidateDto.label,
          enabled: false,
          revision: 1,
          sortOrder: 500,
          controlCarrier: false,
          binding: internalBinding,
          environment: Object.create(null),
          locations: candidateDto.locations,
          provenance: { identity: id, sourceConfigPath: canonicalPath, sourceKind: 'txt', selector }
        };

        const canonicalFingerprint = privateConfigFingerprint({
          serviceId,
          transport: internalBinding?.type,
          url: block.values.url,
          command: block.values.command,
          args: block.values.args,
          cwd: block.values.cwd
        }, getHmacKey());

        candidateCache.set(id, {
          candidate: candidateDto,
          definition,
          profileInput: null,
          provenance: definition.provenance,
          canonicalPath,
          fingerprint,
          canonicalFingerprint
        });

        inv.push({
          filename: path.basename(canonicalPath),
          type: 'txt',
          path: canonicalPath,
          mtime: (await statFn(canonicalPath).catch(() => null))?.mtime?.toISOString() || null,
          displayName: candidateDto.label,
          credentials: candidateDto.credentialStatus,
          status: 'found',
          reason: '有效服务定义配置（无需凭据），可导入',
          candidateId: id,
          serviceId
        });
      } else {
        inv.push({
          filename: path.basename(canonicalPath),
          type: 'txt',
          path: canonicalPath,
          mtime: (await statFn(canonicalPath).catch(() => null))?.mtime?.toISOString() || null,
          displayName: blockLabel,
          credentials: { configured: false, hasApiKey: false, hasTunnelId: false, maskedTunnelId: null, hasOrganizationId: false },
          status: 'review',
          reason: '未知配置格式或缺少有效字段'
        });
      }
    }
  }

  /**
   * Loads candidate by ID, reverifying file fingerprint (throws 409 SOURCE_CHANGED if drifted).
   * Returns internal object { candidate, definition, profileInput, provenance }.
   */
  async function loadCandidate(id, { expectedFingerprint } = {}) {
    if (typeof id !== 'string') {
      const err = new Error('Candidate ID must be a string');
      err.code = 'INVALID_CANDIDATE_ID';
      err.status = 400;
      err.statusCode = 400;
      throw err;
    }

    // If cache is empty, populate by scanning
    if (candidateCache.size === 0) {
      await scan();
    }

    let bundle = candidateCache.get(id);
    if (!bundle) {
      // Re-scan once to check if source newly appeared
      await scan();
      bundle = candidateCache.get(id);
      if (!bundle) {
        const err = new Error(`Candidate not found: ${id}`);
        err.code = 'CANDIDATE_NOT_FOUND';
        err.status = 404;
        err.statusCode = 404;
        throw err;
      }
    }

    // Re-read file and re-verify fingerprint
    let currentContent;
    try {
      currentContent = await readFileFn(bundle.canonicalPath);
    } catch (readErr) {
      const err = new Error(`Failed to read candidate source file: ${readErr.message}`);
      err.code = 'SOURCE_UNAVAILABLE';
      err.status = 404;
      err.statusCode = 404;
      throw err;
    }

    const decoded = decodeTextContent(currentContent, maxBytes);
    const currentText = decoded.text || (typeof currentContent === 'string' ? currentContent : currentContent.toString('utf8'));
    const currentFingerprint = computeFingerprint(currentText);

    if (expectedFingerprint && currentFingerprint !== expectedFingerprint) {
      const err = new Error('Candidate source file changed since discovery');
      err.code = 'SOURCE_CHANGED';
      err.status = 409;
      err.statusCode = 409;
      throw err;
    }

    return {
      candidate: structuredClone(bundle.candidate),
      definition: structuredClone(bundle.definition),
      profileInput: bundle.profileInput ? structuredClone(bundle.profileInput) : null,
      provenance: structuredClone(bundle.provenance)
    };
  }

  return {
    scan,
    loadCandidate,
    getInventory: async () => structuredClone(inventoryList)
  };
}

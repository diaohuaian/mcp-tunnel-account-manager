import path from 'node:path';
import fs from 'node:fs';
import { compileHttpTransport, HttpTransportFault } from './http-transport.mjs';

export { compileHttpTransport, HttpTransportFault };

export class BindingFault extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const reject = (code, status = 400) => {
  throw new BindingFault(code, status);
};

export const SENSITIVE_NAME_REGEX = /KEY|TOKEN|SECRET|PASS|AUTH|COOKIE|CREDENTIAL|SIG|BEARER/i;

export function isSensitiveName(name) {
  return typeof name === 'string' && SENSITIVE_NAME_REGEX.test(name);
}

export function isSensitiveValue(val) {
  if (typeof val !== 'string') return false;
  return /key|token|secret|pass|auth|credential|bearer/i.test(val) || /^sk-[a-zA-Z0-9]+$/.test(val);
}

export const RESERVED_SERVICE_ENV_NAMES = new Set([
  'MCP_SERVER_URL',
  'MCP_COMMAND',
  'MCP_EXTRA_HEADERS',
  'MCP_DISCOVERY_EXTRA_HEADERS'
]);

export function isReservedServiceEnvName(name) {
  if (typeof name !== 'string') return false;
  const upper = name.toUpperCase();
  return RESERVED_SERVICE_ENV_NAMES.has(upper) ||
    upper.startsWith('TUNNEL_CLIENT_MCP_HEADER_') ||
    upper.startsWith('TUNNEL_CLIENT_') ||
    upper.startsWith('CONTROL_PLANE_') ||
    upper.startsWith('HEALTH_') ||
    upper === 'TUNNEL_ID';
}

export function validateServiceEnvName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) {
    reject('INVALID_ENV_NAME');
  }
  if (isReservedServiceEnvName(name)) {
    reject('RESERVED_ENV_NAME');
  }
}

export const isRecord = value => value !== null && typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

/**
 * Escapes a single argument according to Microsoft Windows CommandLineToArgvW rules.
 */
export function quoteWindowsArg(arg) {
  if (typeof arg !== 'string') arg = String(arg ?? '');
  if (arg.length === 0) return '""';
  if (!/[ \t\n\v"]/.test(arg)) {
    return arg;
  }
  let res = '"';
  let backslashes = 0;
  for (let i = 0; i < arg.length; i++) {
    const c = arg[i];
    if (c === '\\') {
      backslashes++;
    } else if (c === '"') {
      res += '\\'.repeat(backslashes * 2 + 1);
      res += '"';
      backslashes = 0;
    } else {
      if (backslashes > 0) {
        res += '\\'.repeat(backslashes);
        backslashes = 0;
      }
      res += c;
    }
  }
  if (backslashes > 0) {
    res += '\\'.repeat(backslashes * 2);
  }
  res += '"';
  return res;
}

/**
 * Formats executable and arguments into a single Windows command-line string
 * using CommandLineToArgvW-compatible quoting.
 */
export function formatWindowsCommandLine(executable, args = []) {
  if (typeof executable !== 'string' || executable.length === 0) {
    reject('INVALID_EXECUTABLE');
  }
  const parts = [quoteWindowsArg(executable)];
  if (Array.isArray(args)) {
    for (const a of args) {
      const val = (a !== null && typeof a === 'object') ? a.value : a;
      parts.push(quoteWindowsArg(val));
    }
  }
  return parts.join(' ');
}

/**
 * Parses a Windows command line string into an array of string tokens
 * following CommandLineToArgvW rules.
 */
export function parseWindowsCommandLine(cmdLine) {
  if (typeof cmdLine !== 'string') return [];
  const args = [];
  let current = '';
  let inQuotes = false;
  let i = 0;
  const len = cmdLine.length;

  while (i < len) {
    while (i < len && /[ \t]/.test(cmdLine[i]) && !inQuotes) {
      i++;
    }
    if (i >= len) break;

    current = '';
    let hasToken = false;

    while (i < len) {
      const c = cmdLine[i];
      if (!inQuotes && /[ \t]/.test(c)) {
        break;
      }
      hasToken = true;

      if (c === '\\') {
        let count = 0;
        while (i < len && cmdLine[i] === '\\') {
          count++;
          i++;
        }
        if (i < len && cmdLine[i] === '"') {
          current += '\\'.repeat(Math.floor(count / 2));
          if (count % 2 === 1) {
            current += '"';
            i++;
          } else {
            inQuotes = !inQuotes;
            i++;
          }
        } else {
          current += '\\'.repeat(count);
        }
      } else if (c === '"') {
        inQuotes = !inQuotes;
        i++;
      } else {
        current += c;
        i++;
      }
    }

    if (hasToken) {
      args.push(current);
    }
  }

  return args;
}

/**
 * Resolves an executable safely:
 * - Maps npx / npx.cmd to known Node + npx-cli.js.
 * - Strictly rejects unknown .cmd and .bat files (no arbitrary cmd /c fallback).
 * - Never executes or downloads software during resolution.
 */
export function resolveExecutable(executable, options = {}) {
  if (typeof executable !== 'string' || executable.trim().length === 0 ||
      executable.length > 32768 || /[\x00-\x1f]/.test(executable)) {
    reject('INVALID_EXECUTABLE');
  }

  const normalized = executable.replaceAll('\\', '/');
  const basename = path.basename(normalized).toLowerCase();

  const isCmdOrBat = basename.endsWith('.cmd') || basename.endsWith('.bat');
  const isNpx = basename === 'npx' || basename === 'npx.cmd' || basename === 'npx.bat';

  if (isCmdOrBat && !isNpx) {
    reject('UNSUPPORTED_EXECUTABLE');
  }

  if (isNpx) {
    const nodeBin = options.nodePath || process.execPath;
    let npxCliPath = options.npxCliPath || null;
    const fsModule = options.fs || fs;

    if (!npxCliPath) {
      const candidates = [
        path.join(path.dirname(nodeBin), 'node_modules', 'npm', 'bin', 'npx-cli.js'),
        path.join(path.dirname(nodeBin), '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
        path.join(path.dirname(nodeBin), 'node_modules', 'npx', 'index.js')
      ];
      for (const candidate of candidates) {
        try {
          if (fsModule.existsSync(candidate)) {
            npxCliPath = candidate;
            break;
          }
        } catch (_) {}
      }
    }

    if (!npxCliPath && options.fallbackNpxPath) {
      npxCliPath = options.fallbackNpxPath;
    }

    if (!npxCliPath && options.allowUnresolved !== true) {
      reject('NPX_CLI_NOT_FOUND', 500);
    }

    return {
      executable: nodeBin,
      prependArgs: npxCliPath ? [npxCliPath] : [],
      isMapped: true
    };
  }

  return {
    executable,
    prependArgs: [],
    isMapped: false
  };
}

/**
 * Merges stdio binding arguments.
 * - Patch matches items by id.
 * - Omitting value preserves existing value.
 * - When full array provided, omitted items are removed.
 * - New args must have a value.
 * - New args default to secret: true.
 * - Sensitive names cannot have secret set to false.
 */
export function mergeBindingArgs(previousArgs = [], patchArgs) {
  if (patchArgs === undefined) {
    return (previousArgs || []).map(a => ({ ...a }));
  }
  if (!Array.isArray(patchArgs) || patchArgs.length > 256) {
    reject('INVALID_BINDING_ARGS');
  }

  const seen = new Set();
  const result = [];

  for (const patchItem of patchArgs) {
    const id = patchItem?.id;
    if (typeof id !== 'string' || id.length === 0 || id.length > 128 || /[\x00-\x1f]/.test(id)) {
      reject('INVALID_ARG_ID');
    }
    if (seen.has(id)) {
      reject('DUPLICATE_ARG_ID');
    }
    seen.add(id);

    const existing = (previousArgs || []).find(a => a.id === id);
    if (existing) {
      let value = existing.value;
      if (patchItem.value !== undefined) {
        if (typeof patchItem.value !== 'string' || patchItem.value.length > 32768 || patchItem.value.includes('\0')) {
          reject('INVALID_ARG_VALUE');
        }
        value = patchItem.value;
      }
      let secret;
      if (isSensitiveName(id)) {
        secret = true;
      } else if (patchItem.secret !== undefined) {
        secret = patchItem.secret !== false;
      } else {
        secret = existing.secret !== false;
      }
      result.push({ id, value, secret });
    } else {
      if (patchItem.value === undefined || typeof patchItem.value !== 'string' ||
          patchItem.value.length > 32768 || patchItem.value.includes('\0')) {
        reject('ARG_VALUE_REQUIRED');
      }
      const secret = isSensitiveName(id) || patchItem.secret !== false;
      result.push({ id, value: patchItem.value, secret });
    }
  }

  return result;
}

/**
 * Returns safe public DTO for stdio binding args.
 * Omits value for secret items; sets secret: true, configured: true.
 */
export function publicBindingArgs(args = []) {
  if (!Array.isArray(args)) return [];
  return args.map(arg => {
    const secret = isSensitiveName(arg.id) || arg.secret !== false;
    if (secret) {
      return { id: arg.id, secret: true, configured: true };
    }
    return { id: arg.id, secret: false, configured: true, value: arg.value };
  });
}

/**
 * Validates HTTP/HTTPS URL and strictly rejects userinfo (username / password).
 * Preserves validated original endpoint string (including signed path/query spelling,
 * percent-escapes, default port); does not replace with url.href.
 */
export function validateHttpUrl(urlStr) {
  if (typeof urlStr !== 'string' || !urlStr.trim() || /[\x00-\x20\x7f]/.test(urlStr) || urlStr.length > 8192) {
    reject('INVALID_URL');
  }
  if (urlStr.includes('***') || urlStr.includes('...')) {
    reject('INVALID_URL');
  }
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    reject('INVALID_URL');
  }
  if (!['http:', 'https:'].includes(u.protocol)) {
    reject('INVALID_URL');
  }
  if (u.username || u.password) {
    reject('URL_USERINFO_FORBIDDEN');
  }
  if (u.hash) {
    reject('INVALID_URL');
  }
  if (!u.hostname) {
    reject('INVALID_URL');
  }
  return urlStr;
}

/**
 * Checks if a URL contains sensitive / private query parameters.
 */
export function hasPrivateQuery(urlStr) {
  if (typeof urlStr !== 'string' || !urlStr) return false;
  try {
    const u = new URL(urlStr);
    if (!u.search || u.search === '?') return false;
    for (const [key, val] of u.searchParams.entries()) {
      if (isSensitiveName(key) || isSensitiveValue(val)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Formats safe public URL by redacting/removing sensitive query parameters.
 */
export function publicUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.username || u.password) {
      reject('URL_USERINFO_FORBIDDEN');
    }
    const keysToDelete = [];
    for (const [key, val] of u.searchParams.entries()) {
      if (isSensitiveName(key) || isSensitiveValue(val)) {
        keysToDelete.push(key);
      }
    }
    for (const k of keysToDelete) {
      u.searchParams.delete(k);
    }
    return u.href;
  } catch (err) {
    if (err instanceof BindingFault) throw err;
    reject('INVALID_URL');
  }
}

/**
 * Merges HTTP headers patch.
 * Supports set and remove ops, default secret: true, sensitive names cannot be unmasked.
 * Non-record header containers fail with INVALID_HTTP_HEADERS.
 */
export function mergeHeadersPatch(previousHeaders = {}, patch = []) {
  if (previousHeaders !== undefined && previousHeaders !== null && !isRecord(previousHeaders)) {
    reject('INVALID_HTTP_HEADERS');
  }
  if (patch === undefined) {
    const copy = Object.create(null);
    for (const [k, v] of Object.entries(previousHeaders || {})) copy[k] = { ...v };
    return copy;
  }

  const result = Object.create(null);
  for (const [k, v] of Object.entries(previousHeaders || {})) {
    result[k] = { ...v };
  }

  if (Array.isArray(patch)) {
    if (patch.length > 128) reject('INVALID_HEADERS_PATCH');
    const seen = new Set();
    for (const item of patch) {
      const name = item?.name;
      if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(name)) {
        reject('INVALID_HEADER_NAME');
      }
      const upper = name.toUpperCase();
      if (seen.has(upper)) reject('DUPLICATE_HEADER_NAME');
      seen.add(upper);

      const oldName = Object.keys(result).find(k => k.toUpperCase() === upper);
      if (item.op === 'remove') {
        if (oldName) delete result[oldName];
        continue;
      }
      if (item.value !== undefined) {
        if (typeof item.value !== 'string' || item.value.length > 32768 || item.value.includes('\0')) {
          reject('INVALID_HEADER_VALUE');
        }
        if (oldName && oldName !== name) delete result[oldName];
        const secret = isSensitiveName(name) || item.secret !== false;
        result[name] = { value: item.value, secret };
      } else if (oldName && result[oldName]) {
        // Omitting value preserves existing value; secret can be updated if not sensitive name
        const existingVal = result[oldName].value;
        const secret = isSensitiveName(name) || (item.secret !== undefined ? item.secret !== false : result[oldName].secret !== false);
        if (oldName !== name) delete result[oldName];
        result[name] = { value: existingVal, secret };
      } else {
        reject('INVALID_HEADER_VALUE');
      }
    }
  } else if (isRecord(patch)) {
    for (const [name, entry] of Object.entries(patch)) {
      if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(name)) {
        reject('INVALID_HEADER_NAME');
      }
      if (entry === null || entry === undefined || entry.op === 'remove') {
        delete result[name];
        continue;
      }
      const isEntryObj = typeof entry === 'object' && entry !== null;
      const hasValue = typeof entry === 'string' || (isEntryObj && entry.value !== undefined);
      if (hasValue) {
        const val = typeof entry === 'string' ? entry : entry.value;
        if (typeof val !== 'string' || val.length > 32768 || val.includes('\0')) {
          reject('INVALID_HEADER_VALUE');
        }
        const secret = isSensitiveName(name) || (isEntryObj && entry.secret !== false);
        result[name] = { value: val, secret };
      } else if (result[name]) {
        // Omitting value preserves existing value
        const existingVal = result[name].value;
        const secret = isSensitiveName(name) || (isEntryObj && entry.secret !== undefined ? entry.secret !== false : result[name].secret !== false);
        result[name] = { value: existingVal, secret };
      } else {
        reject('INVALID_HEADER_VALUE');
      }
    }
  } else {
    reject('INVALID_HTTP_HEADERS');
  }

  return result;
}

/**
 * Returns safe public headers DTO.
 */
export function publicHeaders(headers = {}) {
  const result = Object.create(null);
  if (Array.isArray(headers)) {
    const sorted = [...headers].sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || '')));
    for (const item of sorted) {
      const name = item?.name;
      if (!name || typeof name !== 'string') continue;
      const secret = isSensitiveName(name) || item?.secret !== false;
      if (secret) {
        result[name] = { secret: true, configured: Boolean(item?.configured ?? true) };
      } else {
        result[name] = {
          secret: false,
          configured: Boolean(item?.configured ?? true),
          ...(item?.value !== undefined ? { value: item.value } : {})
        };
      }
    }
    return result;
  }
  const sortedKeys = Object.keys(headers || {}).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  for (const name of sortedKeys) {
    const entry = headers[name];
    const isObj = entry && typeof entry === 'object';
    const secret = isSensitiveName(name) || (isObj ? entry.secret !== false : true);
    if (secret) {
      result[name] = { secret: true, configured: Boolean(isObj ? (entry.configured ?? true) : true) };
    } else {
      result[name] = {
        secret: false,
        configured: Boolean(isObj ? (entry.configured ?? true) : true),
        ...(isObj && entry.value !== undefined ? { value: entry.value } : (typeof entry === 'string' ? { value: entry } : {}))
      };
    }
  }
  return result;
}

/**
 * Merges a binding patch with existing binding.
 * If patch.url is omitted (undefined), retain previousBinding.url.
 * Non-record header containers fail with INVALID_HTTP_HEADERS.
 */
export function mergeBinding(previousBinding = {}, patch = {}) {
  const type = patch.type || previousBinding.type || 'stdio';
  if (!['stdio', 'http'].includes(type)) {
    reject('INVALID_BINDING_TYPE');
  }

  if (type === 'stdio') {
    const executable = patch.executable !== undefined ? patch.executable : previousBinding.executable;
    if (typeof executable !== 'string' || executable.length === 0) {
      reject('INVALID_EXECUTABLE');
    }
    // Verify executable is not rejected (.cmd / .bat without npx)
    resolveExecutable(executable, { allowUnresolved: true });

    const prevArgs = previousBinding.type === 'stdio' ? previousBinding.args : [];
    const args = mergeBindingArgs(prevArgs, patch.args);

    const cwd = patch.cwd !== undefined ? patch.cwd : previousBinding.cwd;
    if (cwd !== undefined && cwd !== null && (typeof cwd !== 'string' || cwd.includes('\0'))) {
      reject('INVALID_CWD');
    }

    const res = { type: 'stdio', executable, args };
    if (cwd) res.cwd = cwd;
    return res;
  }

  // type === 'http'
  const prevHeaders = previousBinding.type === 'http' ? previousBinding.headers : {};
  if (prevHeaders !== undefined && prevHeaders !== null && !isRecord(prevHeaders)) {
    reject('INVALID_HTTP_HEADERS');
  }

  const patchHeaders = patch.headers !== undefined ? patch.headers : patch.headersPatch;
  if (patchHeaders !== undefined && patchHeaders !== null && !Array.isArray(patchHeaders) && !isRecord(patchHeaders)) {
    reject('INVALID_HTTP_HEADERS');
  }

  let url;
  const isBlankEdit = patch.url === undefined || (typeof patch.url === 'string' && patch.url.trim() === '');
  const isMaskedPlaceholder = typeof patch.url === 'string' && (patch.url.includes('***') || patch.url.includes('...'));
  const isResubmittedMaskedDisplay = Boolean(
    previousBinding.url &&
    previousBinding.hasPrivateQuery &&
    previousBinding.urlDisplay &&
    typeof patch.url === 'string' &&
    patch.url === previousBinding.urlDisplay
  );

  if (isMaskedPlaceholder) {
    reject('INVALID_URL');
  } else if (isBlankEdit) {
    if (previousBinding.url !== undefined) {
      url = previousBinding.url;
    } else {
      reject('INVALID_URL');
    }
  } else if (patch.url === null) {
    reject('INVALID_URL');
  } else if (isResubmittedMaskedDisplay) {
    url = previousBinding.url;
  } else {
    url = validateHttpUrl(patch.url);
  }

  const headers = mergeHeadersPatch(prevHeaders, patchHeaders);

  return {
    type: 'http',
    url,
    headers
  };
}

/**
 * Produces safe public binding representation without secrets.
 * For HTTP:
 * - If url contains private query: return { type: "http", urlDisplay: origin + pathname, urlConfigured: true, hasPrivateQuery: true, headers: publicHeaders(binding.headers) } and omit raw url.
 * - For public/no-query: return { type: "http", url, urlDisplay: url, urlConfigured: true, headers: publicHeaders(binding.headers) }.
 * - Retains safe urlDisplay, urlConfigured, and hasPrivateQuery through both raw and public input.
 */
export function publicBinding(binding = {}) {
  if (!binding || !binding.type) return null;
  if (binding.type === 'stdio') {
    const res = {
      type: 'stdio',
      executable: binding.executable || '',
      args: publicBindingArgs(binding.args || [])
    };
    if (binding.cwd) res.cwd = binding.cwd;
    return res;
  }
  if (binding.type === 'http') {
    const pubHeaders = publicHeaders(binding.headers || {});
    const isPrivate = Boolean(
      (binding.url && hasPrivateQuery(binding.url)) ||
      binding.hasPrivateQuery === true ||
      (binding.urlDisplay && hasPrivateQuery(binding.urlDisplay))
    );

    if (isPrivate) {
      let urlDisplay = binding.urlDisplay || '';
      const sourceUrl = (binding.url && hasPrivateQuery(binding.url))
        ? binding.url
        : (binding.urlDisplay || binding.url || '');
      if (sourceUrl) {
        try {
          const u = new URL(sourceUrl);
          urlDisplay = u.origin + u.pathname;
        } catch {
          urlDisplay = binding.urlDisplay || '';
        }
      }
      return {
        type: 'http',
        urlDisplay,
        urlConfigured: Boolean(binding.urlConfigured ?? true),
        hasPrivateQuery: true,
        headers: pubHeaders
      };
    }

    const rawUrl = binding.url || (binding.urlConfigured && binding.urlDisplay ? binding.urlDisplay : '');
    if (!rawUrl) {
      return {
        type: 'http',
        url: '',
        urlDisplay: '',
        urlConfigured: false,
        headers: pubHeaders
      };
    }

    return {
      type: 'http',
      url: rawUrl,
      urlDisplay: binding.urlDisplay || rawUrl,
      urlConfigured: Boolean(binding.urlConfigured ?? true),
      headers: pubHeaders
    };
  }
  return null;
}

/**
 * Converts a binding to upstream tunnel-client 0.0.19 format.
 */
export function bindingToTunnelCommand(binding, options = {}) {
  if (!binding || binding.type !== 'stdio') {
    reject('UNSUPPORTED_BINDING_FOR_COMMAND');
  }
  const resolved = resolveExecutable(binding.executable, options);
  const argValues = (binding.args || []).map(a => (a !== null && typeof a === 'object') ? a.value : String(a));
  const allArgs = [...resolved.prependArgs, ...argValues];
  return {
    command: formatWindowsCommandLine(resolved.executable, allArgs),
    executable: resolved.executable,
    args: allArgs,
    cwd: binding.cwd || null
  };
}

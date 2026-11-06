import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const forbiddenDirectories = new Set(['.git', '.svn', '__pycache__', '.pytest_cache', '.venv', 'venv', 'generated-profiles', 'user-data', 'local-config']);
export function forbiddenPayload(relative) {
  const parts = relative.replaceAll('\\', '/').split('/');
  const base = parts.at(-1).toLowerCase();
  if (parts.some(part => forbiddenDirectories.has(part.toLowerCase()))) return true;
  if (/^\.env(?:\..*)?$/i.test(base) && base !== '.env.example') return true;
  return /^(?:auth\.json|master\.key|bootstrap-code\.txt|bootstrap\.secret|cookies\.json|login data|web data)$/i.test(base)
    || /\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$/i.test(base)
    || /\.(?:key|pem|pfx|p12|log|pyc|zip|7z|lnk)$/i.test(base)
    || /\.pid(?:\.json)?$/i.test(base);
}

export function auditTree(directory) {
  const root = path.resolve(directory);
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('Root links are not allowed.');
  const findings = [];
  const privateUsername = process.env.RELEASE_PRIVATE_USERNAME || '';
  const usernamePattern = privateUsername ? new RegExp('\\b' + privateUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i') : null;
  let files = 0;
  let bytes = 0;
  const executables = [];
  const record = (relative, rule, line) => findings.push({ file: relative, rule, ...(line ? { line } : {}) });
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      const relative = path.relative(root, file).replaceAll('\\', '/');
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) { record(relative, 'REPARSE_POINT'); continue; }
      if (forbiddenPayload(relative)) { record(relative, 'FORBIDDEN_PRIVATE_OR_GENERATED_PATH'); continue; }
      if (entry.isDirectory()) { walk(file); continue; }
      if (!entry.isFile()) { record(relative, 'NON_REGULAR_FILE'); continue; }
      files += 1;
      bytes += stat.size;
      if (/\.(?:exe|dll|com|scr|pyd)$/i.test(relative)) {
        executables.push(relative);
        if (!/(?:^|\/)(?:runtime\/node\.exe|tunnel-client\/(?:tunnel-client|cloudflared)\.exe)$/.test(relative)) record(relative, 'UNEXPECTED_EXECUTABLE');
        continue;
      }
      const data = fs.readFileSync(file);
      if (data.subarray(0, 2048).includes(0)) continue;
      const text = data.toString('utf8');
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const rules = [
          ['PRIVATE_KEY_MATERIAL', /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
          ['OPENAI_KEY_SHAPE', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}\b/],
          ['GITHUB_TOKEN_SHAPE', /\b(?:gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{30,})\b/],
          ['JWT_SHAPE_REVIEW', /\beyJ[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{20,}\b/],
        ];
        if (usernamePattern && usernamePattern.test(line)) record(relative, 'PRIVATE_LOCAL_USERNAME', index + 1);
        for (const [name, pattern] of rules) if (pattern.test(line)) record(relative, name, index + 1);
        const assignment = /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|runtime[_-]?api[_-]?key|password|client[_-]?secret)\s*[:=]\s*(['"])([^'"\r\n]{24,})\1/gi;
        for (const match of line.matchAll(assignment)) {
          const value = match[2];
          if (/env:|TEST_ONLY_|YOUR_|example|dummy|placeholder|redact|\$\{|[<>\s]/i.test(value)) continue;
          const frequencies = new Map();
          for (const char of value) frequencies.set(char, (frequencies.get(char) || 0) + 1);
          let entropy = 0;
          for (const count of frequencies.values()) { const p = count / value.length; entropy -= p * Math.log2(p); }
          if (entropy > 4.2) record(relative, 'HIGH_ENTROPY_LITERAL_CREDENTIAL_REVIEW', index + 1);
        }
      }
    }
  };
  walk(root);
  return { scope: path.basename(root), files, bytes, executables, additionalPrivateUsernameCheck: Boolean(privateUsername), findingCount: findings.length, findings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node audit-release.mjs DIRECTORY [REPORT.json]');
  const report = auditTree(process.argv[2]);
  const output = JSON.stringify(report, null, 2) + '\n';
  if (process.argv[3]) fs.writeFileSync(process.argv[3], output, { flag: 'wx' });
  console.log(output);
  process.exitCode = report.findingCount === 0 ? 0 : 1;
}

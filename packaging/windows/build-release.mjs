import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { auditTree, forbiddenPayload } from './audit-release.mjs';

const toolsRoot = path.dirname(fileURLToPath(import.meta.url));
const releaseId = '20261109-rc21-r1';
const sourceSnapshot = 'release-candidate-21-20261109';
const allowedArguments = new Set(['--source', '--output', '--runtime', '--node-license', '--dependency-kit']);
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!allowedArguments.has(key) || !value || value.startsWith('--') || args.has(key)) throw new Error('Invalid or duplicate argument: ' + key);
  args.set(key, path.resolve(value));
}
for (const key of ['--source', '--output', '--runtime', '--node-license']) if (!args.has(key)) throw new Error('Required: ' + key);
const source = fs.realpathSync(args.get('--source'));
const output = args.get('--output');
const runtime = fs.realpathSync(args.get('--runtime'));
const nodeLicense = fs.realpathSync(args.get('--node-license'));
const dependencyKit = args.has('--dependency-kit') ? fs.realpathSync(args.get('--dependency-kit')) : null;
const isWithin = (parent, child) => child.toLowerCase() === parent.toLowerCase() || child.toLowerCase().startsWith(parent.toLowerCase() + path.sep);
if (fs.existsSync(output)) throw new Error('Output already exists. No existing tree was overwritten.');
if (isWithin(source, output) || isWithin(toolsRoot, output) || (dependencyKit && isWithin(dependencyKit, output))) throw new Error('Output must be outside all input trees.');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build on Windows x64 with the intended runtime.');

function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function filesUnder(root, prefix = '') {
  const result = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    const file = path.join(root, relative);
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Links are forbidden: ' + relative);
    if (entry.isDirectory()) result.push(...filesUnder(root, relative));
    else if (entry.isFile()) result.push(relative.replaceAll('\\', '/'));
    else throw new Error('Non-regular input: ' + relative);
  }
  return result.sort();
}
function put(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { flag: 'wx' });
}
function copyFile(from, to) {
  if (fs.lstatSync(from).isSymbolicLink()) throw new Error('Links are forbidden: ' + path.basename(from));
  const data = fs.readFileSync(from);
  if (/\.ps1$/i.test(to)) {
    const text = data.toString('utf8').replace(/^\uFEFF/, '');
    put(to, '\uFEFF' + text);
  } else put(to, data);
}
function copyTree(from, to, { skip = new Set(), skipCaches = false } = {}) {
  for (const relative of filesUnder(from)) {
    if (skip.has(relative)) continue;
    if (skipCaches && /(?:^|\/)(?:__pycache__|\.pytest_cache)(?:\/|$)|\.pyc$/i.test(relative)) continue;
    if (forbiddenPayload(relative)) throw new Error('Private/generated input is forbidden: ' + relative);
    copyFile(path.join(from, relative), path.join(to, relative));
  }
}
function overlayTree(from, to, skip = new Set()) {
  copyTree(from, to, { skip });
}
// Templates carry release identity placeholders so no stale build id can leak into a
// shipped package. Substitution is applied to the instantiated files only; the copied
// packaging/windows/templates tree keeps its placeholders because it is itself a template.
const identityTokens = {
  '{{RELEASE_ID}}': releaseId,
  '{{SOURCE_SNAPSHOT}}': sourceSnapshot,
};
function applyIdentityTokens(root) {
  const touched = [];
  for (const relative of filesUnder(root)) {
    const normalized = relative.split(path.sep).join('/');
    if (normalized.startsWith('packaging/')) continue;
    if (!/\.(md|txt|json|ps1|cmd)$/i.test(normalized)) continue;
    const file = path.join(root, relative);
    const original = fs.readFileSync(file, 'utf8');
    const hadBom = original.charCodeAt(0) === 0xFEFF;
    let text = hadBom ? original.slice(1) : original;
    let changed = false;
    for (const [token, value] of Object.entries(identityTokens)) {
      if (text.includes(token)) { text = text.split(token).join(value); changed = true; }
    }
    if (!changed) continue;
    const wantsBom = hadBom || /\.ps1$/i.test(normalized);
    fs.writeFileSync(file, (wantsBom ? '\uFEFF' : '') + text, 'utf8');
    touched.push(normalized);
  }
  return touched;
}
function writeJson(file, value) { put(file, JSON.stringify(value, null, 2) + '\n'); }
function sealTree(root) {
  const map = {};
  for (const relative of filesUnder(root)) {
    if (relative === 'manifest.json' || relative === 'FILES.sha256') continue;
    map[relative] = hash(path.join(root, relative));
  }
  writeJson(path.join(root, 'manifest.json'), map);
  const checksums = filesUnder(root).map(relative => `${hash(path.join(root, relative))}  ${relative}`).join('\n') + '\n';
  put(path.join(root, 'FILES.sha256'), checksums);
}
function ensureSafe(root) {
  const audit = auditTree(root);
  if (audit.findingCount) {
    console.error(JSON.stringify(audit, null, 2));
    throw new Error('Release content audit failed. Findings are redacted above.');
  }
  return audit;
}

const originalPackage = readJson(path.join(source, 'package.json'));
if (Object.keys(originalPackage.dependencies || {}).length) throw new Error('Console runtime dependencies must be explicitly packaged, not silently omitted.');
if (!fs.existsSync(path.join(source, 'src/main.mjs'))) throw new Error('Source root has no console entry.');
const sourceCoreHashes = {};
for (const directory of ['src', 'public']) {
  for (const relative of filesUnder(path.join(source, directory))) sourceCoreHashes[`${directory}/${relative}`] = hash(path.join(source, directory, relative));
}
// A source re-build retains the initial baseline instead of treating new packaging files as upstream code.
const existingCoreMap = path.join(source, 'source-core-hashes.json');
if (fs.existsSync(existingCoreMap)) {
  const baseline = readJson(existingCoreMap);
  if (JSON.stringify(baseline) !== JSON.stringify(sourceCoreHashes)) throw new Error('Core source differs from recorded baseline. Review and create a new release identity.');
}
const originalManifest = path.join(source, 'manifest.json');
let sourceProvenance = { inputManifestStatus: 'not-present', mismatches: [] };
const priorProvenance = path.join(source, 'source-provenance.json');
if (fs.existsSync(priorProvenance)) {
  sourceProvenance = readJson(priorProvenance);
} else if (fs.existsSync(originalManifest) && !fs.existsSync(existingCoreMap)) {
  const map = readJson(originalManifest);
  const mismatches = [];
  for (const [relative, expected] of Object.entries(map)) {
    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Unexpected original manifest format.');
    const resolved = path.resolve(source, relative);
    if (!isWithin(source, resolved) || !fs.existsSync(resolved)) throw new Error('Missing or unsafe original manifest path: ' + relative);
    const actual = hash(resolved);
    if (actual !== expected) mismatches.push({ file: relative, recordedSha256: expected, currentSha256: actual });
  }
  sourceProvenance = { inputManifestStatus: mismatches.length ? 'stale-against-current-shortcut-target' : 'matches', inputManifestSha256: hash(originalManifest), checkedFiles: Object.keys(map).length, mismatches, policy: 'Package the actual shortcut target without reverting its files to an older manifest. Record current source hashes separately.' };
  if (mismatches.length) console.warn('Input manifest is stale for ' + mismatches.length + ' files; current files are preserved and the discrepancy is recorded.');
}
const runtimeProbe = spawnSync(runtime, ['-p', 'JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
if (runtimeProbe.error || runtimeProbe.status !== 0) throw new Error('Runtime probe failed.');
const runtimeInfo = JSON.parse(runtimeProbe.stdout.trim());
const [nodeMajor, nodeMinor] = runtimeInfo.version.slice(1).split('.').map(Number);
if (runtimeInfo.platform !== 'win32' || runtimeInfo.arch !== 'x64' || nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 14)) throw new Error('Runtime must be Windows x64 Node.js >=22.14.0.');
const licenseText = fs.readFileSync(nodeLicense, 'utf8');
if (!/Node\.js/.test(licenseText) || !/Permission is hereby granted/.test(licenseText) || licenseText.length < 10000) throw new Error('Provide the matching complete Node.js LICENSE, including third-party notices.');

fs.mkdirSync(output);
const sourceTree = path.join(output, 'MCP-Tunnel-Console-Source');
const consoleTree = path.join(output, 'MCP-Tunnel-Console');
const kitTree = dependencyKit ? path.join(output, 'MCP-Windows-Deployment-Kit') : null;
fs.mkdirSync(sourceTree);
const consoleTemplates = path.join(toolsRoot, 'templates/console');
const overlayFiles = new Set(filesUnder(consoleTemplates));
for (const directory of ['src', 'public', 'scripts']) {
  const origin = path.join(source, directory);
  const skip = new Set([...overlayFiles].filter(relative => relative.startsWith(directory + '/')).map(relative => relative.slice(directory.length + 1)));
  copyTree(origin, path.join(sourceTree, directory), { skip });
}
// Optional original tests are not silently merged with this bounded deployment suite.
// The RC19 input did not contain its full upstream tests; only the explicitly shipped suite is the default.
overlayTree(consoleTemplates, sourceTree);
overlayTree(path.join(toolsRoot, 'templates/common'), sourceTree);
const packageMetadata = {
  ...originalPackage,
  scripts: {
    start: 'node scripts/launch-manager.mjs',
    test: 'node --test tests/release-deployment.test.mjs',
    'test:release': 'node --test tests/release-deployment.test.mjs',
    check: 'node scripts/check.mjs',
    'validate-all': 'node scripts/check.mjs && node --test tests/release-deployment.test.mjs',
  },
  engines: { ...originalPackage.engines, node: '>=22.14.0' },
};
writeJson(path.join(sourceTree, 'package.json'), packageMetadata);
writeJson(path.join(sourceTree, 'source-core-hashes.json'), sourceCoreHashes);
writeJson(path.join(sourceTree, 'source-provenance.json'), sourceProvenance);
const upstreamLicense = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'].find(name => fs.existsSync(path.join(source, name)));
if (upstreamLicense) copyFile(path.join(source, upstreamLicense), path.join(sourceTree, upstreamLicense));
const provenance = {
  releaseId,
  applicationVersion: originalPackage.version,
  sourceSnapshot,
  coreSourceUnchanged: true,
  coreSourceFiles: Object.keys(sourceCoreHashes).length,
  coreHashManifest: 'source-core-hashes.json',
  appLicense: upstreamLicense || 'not-specified-in-input',
  upstreamFullRegressionSuiteIncluded: false,
  includedRuntime: null,
  externalRequirements: ['Windows x64', 'Python 3.9+ for Antigravity', 'Antigravity IDE and login', 'DSH host and bridge dependencies if enabled', 'Network and service authorization'],
};
writeJson(path.join(sourceTree, 'build-info.json'), provenance);
const packagedTools = path.join(sourceTree, 'packaging/windows');
for (const relative of ['build-release.mjs', 'audit-release.mjs', 'create-zip.ps1']) copyFile(path.join(toolsRoot, relative), path.join(packagedTools, relative));
copyTree(path.join(toolsRoot, 'templates'), path.join(packagedTools, 'templates'));
const substitutedInSource = applyIdentityTokens(sourceTree);
if (substitutedInSource.length === 0) throw new Error('No release identity placeholder was substituted; templates are out of sync.');
sealTree(sourceTree);
const sourceAudit = ensureSafe(sourceTree);

copyTree(sourceTree, consoleTree, { skip: new Set(['manifest.json', 'FILES.sha256', 'build-info.json']) });
copyFile(runtime, path.join(consoleTree, 'runtime/node.exe'));
copyFile(nodeLicense, path.join(consoleTree, 'runtime/LICENSE'));
writeJson(path.join(consoleTree, 'build-info.json'), { ...provenance, includedRuntime: { ...runtimeInfo, sha256: hash(runtime), licenseSha256: hash(nodeLicense), origin: 'supplied-verified-local-runtime' } });
sealTree(consoleTree);
const consoleAudit = ensureSafe(consoleTree);

let kitAudit = null;
if (dependencyKit) {
  fs.mkdirSync(kitTree);
  copyTree(consoleTree, path.join(kitTree, 'console'));
  const kitTemplates = path.join(toolsRoot, 'templates/kit');
  for (const service of ['overleaf-mcp', 'antigravity-mcp', 'deepseek-mcp']) {
    const serviceRoot = path.join(dependencyKit, 'servers', service);
    if (!fs.existsSync(serviceRoot)) throw new Error('Missing service input: ' + service);
    copyTree(serviceRoot, path.join(kitTree, 'servers', service), { skipCaches: true });
  }
  for (const name of ['tunnel-client.exe', 'cloudflared.exe', 'cloudflared-manifest.json', 'LICENSE', 'NOTICE', 'tunnel-client-v0.0.19-windows-amd64-licenses.txt', 'tunnel-client-v0.0.19-windows-amd64.spdx.json']) {
    copyFile(path.join(dependencyKit, 'tunnel-client', name), path.join(kitTree, 'tunnel-client', name));
  }
  const knownLaunchers = ['Start-Mcp-Tunnel.ps1', 'Start-Overleaf-Tunnel.ps1', 'Start-Antigravity-Tunnel.ps1', 'Start-DeepSeek-Bridge-Tunnel.ps1'];
  for (const name of knownLaunchers) {
    const text = fs.readFileSync(path.join(dependencyKit, 'launchers', name), 'utf8').replace(/^\uFEFF/, '').replaceAll('-MinimumMajor 18', '-MinimumMajor 22');
    put(path.join(kitTree, 'launchers', name), '\uFEFF' + text);
  }
  for (const name of ['overleaf-tunnel.yaml.template', 'antigravity-tunnel.yaml.template', 'deepseek-bridge-tunnel.yaml.template']) copyFile(path.join(dependencyKit, 'templates', name), path.join(kitTree, 'templates', name));
  overlayTree(kitTemplates, kitTree);
  overlayTree(path.join(toolsRoot, 'templates/common'), kitTree);
  applyIdentityTokens(kitTree);
  const overleafPackage = readJson(path.join(kitTree, 'servers/overleaf-mcp/node_modules/mcp-server-overleaf/package.json'));
  const bridgePackage = readJson(path.join(kitTree, 'servers/deepseek-mcp/package.json'));
  const getVersion = (binary, flags) => {
    const probe = spawnSync(binary, flags, { encoding: 'utf8', timeout: 15000, windowsHide: true });
    if (probe.error || probe.status !== 0) throw new Error('Binary version probe failed: ' + path.basename(binary));
    return probe.stdout.trim();
  };
  writeJson(path.join(kitTree, 'package-manifest.json'), {
    bundleKind: 'mcp-windows-deployment-kit',
    bundleVersion: releaseId,
    consoleRelativePath: 'console',
    sourceCoreHashManifest: 'console/source-core-hashes.json',
    platform: 'win32-x64',
    accountDataIncluded: false,
    credentialsIncluded: false,
    components: {
      console: { version: originalPackage.version, sourceSnapshot: provenance.sourceSnapshot },
      node: { ...runtimeInfo, path: 'console/runtime/node.exe', sha256: hash(runtime), licensePath: 'console/runtime/LICENSE' },
      tunnelClient: { versionOutput: getVersion(path.join(kitTree, 'tunnel-client/tunnel-client.exe'), ['--version']), sha256: hash(path.join(kitTree, 'tunnel-client/tunnel-client.exe')) },
      cloudflared: { versionOutput: getVersion(path.join(kitTree, 'tunnel-client/cloudflared.exe'), ['--version']), sha256: hash(path.join(kitTree, 'tunnel-client/cloudflared.exe')) },
      overleaf: { version: overleafPackage.version, nodeRequirement: overleafPackage.engines.node, runtimeDependenciesIncluded: true, lockfile: 'servers/overleaf-mcp/package-lock.json' },
      antigravity: { version: '1.1.0', pythonRequirement: '>=3.9', pythonRuntimeIncluded: false, dependencies: 'Python standard library' },
      deepseekBridge: { version: bridgePackage.version, hostPeerRequirement: bridgePackage.peerDependencies['@deepseek-ai/dsh'], runtimeDependenciesIncluded: false, dshHostIncluded: false, optional: true },
    },
    thirdPartyProvenance: 'Copied from a supplied local deployment kit with existing license and component metadata; no upstream downloads or online authenticity checks were performed.',
    realServiceEndToEndVerified: false,
  });
  // Keep the root notice links valid without copying a second Node binary or license tree.
  const rootNotices = fs.readFileSync(path.join(consoleTemplates, 'THIRD-PARTY-NOTICES.md'), 'utf8').replaceAll('(<runtime/LICENSE>)', '(<console/runtime/LICENSE>)');
  put(path.join(kitTree, 'THIRD-PARTY-NOTICES.md'), rootNotices);
  sealTree(kitTree);
  kitAudit = ensureSafe(kitTree);
}
for (const [relative, expected] of Object.entries(sourceCoreHashes)) {
  if (hash(path.join(source, relative)) !== expected || hash(path.join(consoleTree, relative)) !== expected) throw new Error('Core source changed during build: ' + relative);
}
console.log(JSON.stringify({ releaseId, sourceTree, consoleTree, kitTree, audits: { source: sourceAudit, console: consoleAudit, kit: kitAudit } }, null, 2));

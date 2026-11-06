import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { getLaunchOptions, projectRoot } from '../scripts/launch-manager.mjs';

// No real profile, tunnel configuration, account, browser, or desktop is used by these tests.
const tempParent = fs.realpathSync(os.tmpdir());
const temporary = fs.mkdtempSync(path.join(tempParent, 'mcp-release-test-'));
const saved = new Map();
const replacements = {
  USERPROFILE: path.join(temporary, 'profile'),
  HOME: path.join(temporary, 'profile'),
  LOCALAPPDATA: path.join(temporary, 'local'),
  APPDATA: path.join(temporary, 'roaming'),
  DATA_DIR: path.join(temporary, 'data'),
};
for (const key of Object.keys(process.env)) {
  if (/(?:API_KEY|TOKEN|SECRET|CONTROL_PLANE_|MCP_(?:COMMAND|SERVER_URL|EXTRA_HEADERS)|TUNNEL_CLIENT_)/i.test(key)) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
}
for (const [key, value] of Object.entries(replacements)) {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  process.env[key] = value;
  fs.mkdirSync(value, { recursive: true });
}
after(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // Verify the resolved deletion target before removing only this test-owned directory.
  const resolved = fs.realpathSync(temporary);
  assert.equal(path.dirname(resolved).toLowerCase(), tempParent.toLowerCase());
  assert.ok(path.basename(resolved).startsWith('mcp-release-test-'));
  fs.rmSync(resolved, { recursive: true, force: true });
});

const { startManager } = await import('../src/main.mjs');

function listFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const child = path.join(root, entry.name);
    return entry.isDirectory() ? listFiles(child) : [child];
  });
}

test('release launcher validates ports and forbids non-loopback exposure', () => {
  assert.deepEqual(getLaunchOptions({}, path.join(temporary, 'standalone')), { host: '127.0.0.1', port: 17642 });
  assert.equal(getLaunchOptions({ PORT: '17643' }, path.join(temporary, 'standalone')).port, 17643);
  for (const port of ['0', '-1', '65536', '17642x', '1.5', ' ']) {
    assert.throws(() => getLaunchOptions({ PORT: port }, path.join(temporary, 'standalone')), /PORT/);
  }
  assert.throws(() => getLaunchOptions({ HOST: '0.0.0.0' }, path.join(temporary, 'standalone')), /HOST/);
});

test('complete kit selects its bundled client; standalone keeps per-user defaults', () => {
  const kit = path.join(temporary, 'kit');
  const root = path.join(kit, 'console');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(kit, 'tunnel-client'));
  fs.writeFileSync(path.join(kit, 'package-manifest.json'), JSON.stringify({ bundleKind: 'mcp-windows-deployment-kit', consoleRelativePath: 'console' }));
  assert.throws(() => getLaunchOptions({}, root), /missing/);
  const client = path.join(kit, 'tunnel-client', 'tunnel-client.exe');
  fs.writeFileSync(client, 'TEST_ONLY_NOT_EXECUTABLE');
  assert.equal(getLaunchOptions({}, root).adapterOptions.paths.tunnelClientBin, client);
});

test('distribution contains the web UI, runtime entry and deployment scripts', () => {
  for (const relative of ['src/main.mjs', 'public/index.html', 'public/app.js', 'public/app.css', 'scripts/launch-manager.mjs', 'scripts/start-manager.ps1', 'scripts/install-portable-console.ps1', 'Start-Console.cmd', 'README.md']) {
    assert.ok(fs.statSync(path.join(projectRoot, relative)).isFile(), relative);
  }
  const metadata = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  assert.equal(Object.keys(metadata.dependencies || {}).length, 0);
});

test('fresh console: UI, bootstrap, login, CSRF, encrypted account persistence and restart', { timeout: 60000 }, async t => {
  const dataDir = path.join(temporary, 'console-data');
  let manager;
  t.after(async () => { if (manager) await manager.close(); });
  manager = await startManager({ port: 0, dataDir });
  assert.equal(manager.host, '127.0.0.1');
  const request = async (route, { method = 'GET', body, cookie, csrf, origin } = {}) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    if (csrf) headers['x-csrf-token'] = csrf;
    if (origin) headers.origin = origin;
    return fetch(manager.url + route, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  };
  const page = await request('/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/i);
  for (const asset of ['/app.js', '/app.css']) assert.equal((await request(asset)).status, 200);
  const initial = await (await request('/api/auth/state')).json();
  assert.equal(initial.configured, false);
  assert.equal(initial.authenticated, false);
  assert.equal((await request('/api/state')).status, 401);
  const password = crypto.randomBytes(24).toString('hex');
  const bootstrapCode = manager.security.getBootstrapSecret();
  assert.ok(bootstrapCode);
  assert.equal((await request('/api/auth/setup', { method: 'POST', body: { bootstrapCode, password } })).status, 200);
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { password }, origin: 'https://example.invalid' })).status, 403);
  const login = await request('/api/auth/login', { method: 'POST', body: { password } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const csrf = (await login.json()).csrfToken;
  assert.ok(csrf);
  const state = await (await request('/api/state', { cookie })).json();
  assert.deepEqual(state.profiles, []);
  assert.equal((await request('/api/profiles', { method: 'POST', cookie, body: { label: 'TEST_ONLY_RELEASE' } })).status, 403);
  const syntheticKey = 'TEST_ONLY_' + crypto.randomBytes(24).toString('hex');
  const createdResponse = await request('/api/profiles', {
    method: 'POST', cookie, csrf,
    body: { label: 'TEST_ONLY_RELEASE', expectedRevision: state.revision, services: { 'overleaf-mcp': { tunnelId: 'TEST_ONLY_RELEASE_TUNNEL', apiKey: syntheticKey } } },
  });
  assert.equal(createdResponse.status, 200);
  assert.ok(!(await createdResponse.text()).includes(syntheticKey));
  for (const file of listFiles(dataDir)) {
    assert.ok(!fs.readFileSync(file).includes(Buffer.from(syntheticKey)), 'Synthetic credential must not be stored in plaintext.');
  }
  await manager.close();
  manager = null;
  manager = await startManager({ port: 0, dataDir });
  const restarted = await (await request('/api/auth/state')).json();
  assert.equal(restarted.configured, true);
  assert.equal(restarted.authenticated, false);
  assert.equal((await request('/api/state', { cookie })).status, 401);
  const secondLogin = await request('/api/auth/login', { method: 'POST', body: { password } });
  assert.equal(secondLogin.status, 200);
  const secondCookie = secondLogin.headers.get('set-cookie').split(';')[0];
  const profiles = await (await request('/api/profiles', { cookie: secondCookie })).json();
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].label, 'TEST_ONLY_RELEASE');
  assert.ok(!JSON.stringify(profiles).includes(syntheticKey));
});

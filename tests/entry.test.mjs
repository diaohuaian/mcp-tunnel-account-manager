import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

test('package.json validity', () => {
  const pkgPath = path.join(projectRoot, 'package.json');
  assert.ok(fs.existsSync(pkgPath), 'package.json must exist');

  const raw = fs.readFileSync(pkgPath, 'utf8');
  let pkg;
  assert.doesNotThrow(() => {
    pkg = JSON.parse(raw);
  }, 'package.json must be valid JSON');

  assert.equal(pkg.name, 'mcp-tunnel-account-manager', 'name must match');
  assert.equal(pkg.version, '1.0.0', 'version must be 1.0.0');
  assert.equal(pkg.type, 'module', 'type must be module');
  assert.ok(pkg.scripts, 'scripts object must be defined');
  assert.equal(pkg.scripts.start, 'node scripts/launch-manager.mjs', 'start script must use the guarded release launcher');
  assert.equal(pkg.engines.node, '>=22.14.0', 'node:sqlite requires the supported minimum runtime');
  assert.equal(pkg.scripts.test, 'node scripts/run-tests.mjs', 'test script must run node scripts/run-tests.mjs');
  assert.equal(pkg.scripts.check, 'node scripts/check.mjs', 'check script must match contract');
});

test('start script existence and Node.js >= 22 checks', () => {
  const cmdPath = path.join(projectRoot, 'start-manager.cmd');
  const ps1Path = path.join(projectRoot, 'scripts', 'start-manager.ps1');

  assert.ok(fs.existsSync(cmdPath), 'start-manager.cmd must exist');
  assert.ok(fs.existsSync(ps1Path), 'scripts/start-manager.ps1 must exist');

  const cmdContent = fs.readFileSync(cmdPath, 'utf8');
  assert.match(cmdContent, /scripts\\start-manager\.ps1/, 'CMD delegates runtime, ownership and port checks to PowerShell');
  assert.match(cmdContent, /-Foreground/, 'CMD preserves the foreground console contract');

  const ps1Content = fs.readFileSync(ps1Path, 'utf8');
  assert.match(ps1Content, /17642/, 'scripts/start-manager.ps1 should reference port 17642');
  assert.match(ps1Content, /node/i, 'scripts/start-manager.ps1 should verify node');
  assert.match(ps1Content, /22\.14\.0/, 'PowerShell checks the minimum supported Node runtime');
  assert.match(ps1Content, /launch-manager\.mjs/, 'PowerShell must call the guarded release launcher');
  const launcherPath = path.join(projectRoot, 'scripts', 'launch-manager.mjs');
  assert.ok(fs.existsSync(launcherPath), 'guarded Node launcher must exist');
  const launcher = fs.readFileSync(launcherPath, 'utf8');
  assert.match(launcher, /startManager\(getLaunchOptions\(\)\)/, 'launcher must validate options before starting the manager');
});

test('syntax check on src/main.mjs', async () => {
  const mainPath = path.join(projectRoot, 'src', 'main.mjs');
  assert.ok(fs.existsSync(mainPath), 'src/main.mjs must exist');

  await new Promise((resolve, reject) => {
    execFile(process.execPath, ['--check', mainPath], (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(`node --check failed: ${stderr || err.message}`));
      }
      resolve();
    });
  });
});

test('fake-tunnel fixture status query', async () => {
  const fixturePath = path.join(projectRoot, 'tests', 'fixtures', 'fake-tunnel.mjs');
  assert.ok(fs.existsSync(fixturePath), 'fake-tunnel.mjs fixture must exist');

  const result = await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [fixturePath, '--status', '--account', 'mock-overleaf-1', '--port', '8080'],
      (err, stdout, stderr) => {
        if (err) return reject(err);
        resolve({ stdout, stderr });
      }
    );
  });

  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(parsed.client, 'fake-tunnel');
  assert.equal(parsed.status, 'ONLINE');
  assert.equal(parsed.account, 'mock-overleaf-1');
  assert.equal(parsed.port, 8080);
});

test('fake-tunnel fixture successful execution with --exit-after', async () => {
  const fixturePath = path.join(projectRoot, 'tests', 'fixtures', 'fake-tunnel.mjs');

  const result = await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [fixturePath, '--account', 'user-alpha', '--port', '9999', '--exit-after', '150'],
      (err, stdout, stderr) => {
        if (err) return reject(err);
        resolve({ stdout, stderr });
      }
    );
  });

  assert.match(result.stdout, /Initializing mock tunnel client/);
  assert.match(result.stdout, /STATUS: CONNECTED/);
  assert.match(result.stdout, /Auto-exit timer expired/);
});

test('fake-tunnel fixture failure mode simulation', async () => {
  const fixturePath = path.join(projectRoot, 'tests', 'fixtures', 'fake-tunnel.mjs');

  await new Promise((resolve) => {
    execFile(
      process.execPath,
      [fixturePath, '--fail', 'test token invalid'],
      (err, stdout, stderr) => {
        assert.ok(err, 'Process should fail with exit code 1');
        assert.equal(err.code, 1);
        assert.match(stderr, /Tunnel authorization rejected: test token invalid/);
        resolve();
      }
    );
  });
});

test('fake-tunnel fixture signal termination', async () => {
  const fixturePath = path.join(projectRoot, 'tests', 'fixtures', 'fake-tunnel.mjs');

  const child = spawn(process.execPath, [fixturePath, '--account', 'sig-test', '--port', '7777']);
  let stdoutData = '';

  const exitPromise = new Promise((resolve, reject) => {
    child.on('exit', (code, signal) => {
      resolve({ code, signal });
    });
    child.on('error', reject);
  });

  await new Promise((resolve) => {
    child.stdout.on('data', (chunk) => {
      stdoutData += chunk.toString();
      if (stdoutData.includes('STATUS: CONNECTED')) {
        resolve();
      }
    });
  });

  // Send termination signal
  child.kill('SIGTERM');

  const { code, signal } = await exitPromise;
  assert.ok(code === 0 || signal === 'SIGTERM');
  assert.match(stdoutData, /STATUS: CONNECTED/);
});

test('src/main.mjs exports startManager and startApp', async () => {
  const mainModule = await import('../src/main.mjs');
  assert.equal(typeof mainModule.startManager, 'function', 'startManager must be a function');
  assert.equal(typeof mainModule.startApp, 'function', 'startApp must be a function');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createDefaultProcessController } from '../../src/adapters/index.mjs';

const nativeScript = fileURLToPath(new URL('../../scripts/process-control.ps1', import.meta.url));
const consoleSource = fileURLToPath(new URL('../fixtures/windows-console-inheritance.cs', import.meta.url));
const relay = fileURLToPath(new URL('../fixtures/windows-console-relay.mjs', import.meta.url));
const windowsOnly = { skip: process.platform !== 'win32' };
function workspace() { return fs.mkdtempSync(path.join(os.tmpdir(), 'hidden-console-e2e-')); }
function cleanup(directory) {
  assert.equal(path.dirname(path.resolve(directory)).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(directory).startsWith('hidden-console-e2e-'));
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
}
async function readReport(file) {
  for (let n = 0; n < 150; n++) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
      if (!['ENOENT', undefined].includes(error.code)) throw error;
    }
    await delay(20);
  }
  throw new Error('Isolated console fixture did not become ready');
}

test('Windows native launch: Node backend and grandchild inherit one hidden real console, stdio and exact env survive', windowsOnly, async () => {
  const directory = workspace();
  const executable = path.join(directory, 'isolated-console-fixture.exe');
  const controller = createDefaultProcessController({ dataDir: directory, scriptPath: nativeScript });
  let identity;
  try {
    const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    execFileSync(compiler, ['/nologo', '/target:exe', `/out:${executable}`, consoleSource], { windowsHide: true });
    const privateValue = 'synthetic-private-value-"with spaces"';
    identity = await controller.launch({
      service: 'isolated-console-fixture', command: executable,
      args: ['parent', directory, process.execPath, relay], cwd: directory,
      env: { SystemRoot: process.env.SystemRoot || 'C:\\Windows', Path: process.env.PATH || '', TEMP: directory, CONSOLE_FIXTURE_PRIVATE: privateValue },
      operationId: 'isolated-hidden-console'
    });
    assert.equal(identity.consoleMode, 'hidden-inherited');
    assert.match(identity.creationTimeFileTime, /^[1-9][0-9]*$/);
    const parent = await readReport(path.join(directory, 'parent.json'));
    const child = await readReport(path.join(directory, 'child.json'));
    const node = await readReport(path.join(directory, 'relay.json'));
    assert.equal(parent.pid, identity.pid);
    assert.equal(node.parentPid, identity.pid);
    assert.ok(parent.window > 0, 'Parent needs a real hidden console, not CREATE_NO_WINDOW');
    assert.equal(child.window, parent.window, 'Even an unmodified descendant must inherit the hidden console');
    for (const info of [parent, child]) {
      assert.equal(info.windowClass, 'ConsoleWindowClass', 'A PseudoConsoleWindow cannot prove its Terminal frontend is hidden');
      assert.equal(info.visible, false);
    }
    assert.equal(node.privateValue, privateValue);
    assert.equal(node.inheritedUserProfile, false, 'Pinned env must not be merged with the worker environment');
    assert.equal(fs.readFileSync(path.join(directory, 'stdio.txt'), 'utf8').trim(), 'stdio-roundtrip-ok');
    assert.equal((await controller.verify(identity)).valid, true);
    const wrongIdentity = { ...identity, creationTimeFileTime: String(BigInt(identity.creationTimeFileTime) + 1n) };
    assert.equal((await controller.verify(wrongIdentity)).valid, false, 'Hidden launching must retain exact handle-bound identity verification');
    await assert.rejects(controller.stop(wrongIdentity), error => error.code === 'PROCESS_IDENTITY_MISMATCH');
    assert.equal((await controller.verify(identity)).valid, true, 'A conflicting FILETIME must never stop the process');
    await controller.stop(identity);
    identity = null;
  } finally {
    fs.writeFileSync(path.join(directory, 'exit-now'), '');
    if (identity) await controller.stop(identity);
    cleanup(directory);
  }
});

for (const failure of [
  { name: 'native error', response: "@{success=$false; error='synthetic-private-key-do-not-expose'}", code: 1 },
  { name: 'missing genuine filetime', response: "@{success=$true;processId=12345;executablePath='fixture.exe';creationDate='2026-11-06T00:00:00Z';creationTimeFileTime='0'}", code: 0 }
]) {
  test(`Windows native launch fails closed on ${failure.name}, with no Node fallback or fabricated PID`, windowsOnly, async () => {
    const directory = workspace();
    const helper = path.join(directory, 'reject-launch.ps1');
    const unexpected = path.join(directory, 'unexpected-spawn');
    fs.writeFileSync(helper, `param($Action, $LaunchPayload)\n${failure.response} | ConvertTo-Json -Compress\nexit ${failure.code}\n`);
    try {
      const controller = createDefaultProcessController({ dataDir: directory, scriptPath: helper });
      await assert.rejects(controller.launch({
        service: 'reject-fixture', command: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(unexpected)},'bad')`],
        env: { SystemRoot: process.env.SystemRoot || 'C:\\Windows' }, cwd: directory
      }), error => {
        assert.equal(error.code, 'PROCESS_LAUNCH_UNCONFIRMED');
        assert.ok(!error.message.includes('synthetic-private-key-do-not-expose'));
        return true;
      });
      await delay(100);
      assert.equal(fs.existsSync(unexpected), false);
      assert.equal(fs.existsSync(path.join(directory, 'runtime/reject-fixture-process.json')), false);
    } finally { cleanup(directory); }
  });
}

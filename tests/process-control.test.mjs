import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const scriptPath = fileURLToPath(new URL('../scripts/process-control.ps1', import.meta.url));
const keepAliveFixture = fileURLToPath(new URL('./fixtures/keep-alive.cjs', import.meta.url));
const childFixture = fileURLToPath(new URL('./fixtures/powershell-launch-env-child.mjs', import.meta.url));

function runProcessControl(args, stdinPayload = null) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell', [
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      ...args
    ], { stdio: [stdinPayload !== null ? 'pipe' : 'ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => {
      let parsed = null;
      try {
        if (stdout.trim()) {
          parsed = JSON.parse(stdout.trim());
        }
      } catch (_) {}
      resolve({ code, stdout, stderr, data: parsed });
    });
    child.on('error', reject);
    if (stdinPayload !== null) {
      child.stdin.end(stdinPayload);
    }
  });
}

function spawnFakeListener(tag = 'fake-node-listener') {
  return new Promise((resolve, reject) => {
    const childCode = `
      const net = require('node:net');
      const server = net.createServer(s => s.end());
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        process.stdout.write(JSON.stringify({ port, pid: process.pid }) + '\\n');
      });
      setInterval(() => {}, 60000);
    `;
    const child = spawn(process.execPath, ['-e', childCode, '--', `--tag=${tag}`], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let buffer = '';
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    const onData = chunk => {
      buffer += chunk.toString();
      const idx = buffer.indexOf('\n');
      if (idx !== -1) {
        child.stdout.off('data', onData);
        try {
          const info = JSON.parse(buffer.slice(0, idx).trim());
          resolve({ child, port: info.port, pid: child.pid });
        } catch (err) {
          reject(err);
        }
      }
    };

    child.stdout.on('data', onData);
    child.on('error', reject);
    child.on('exit', code => {
      reject(new Error(`Fake listener child exited prematurely with code ${code}: ${stderr}`));
    });
  });
}

test('1. Inspect returns running=false for non-existent PID', async () => {
  const res = await runProcessControl(['-Action', 'Inspect', '-ProcessId', '999999']);
  assert.equal(res.code, 0);
  assert.ok(res.data);
  assert.equal(res.data.success, true);
  assert.equal(res.data.running, false);
});

test('2. Launch starts a child process and returns verified handle-bound info', async () => {
  const launchRes = await runProcessControl([
    '-Action', 'Launch',
    '-ExecutablePath', process.execPath,
    '-Arguments', `"${keepAliveFixture}"`
  ]);

  assert.equal(launchRes.code, 0, `Launch failed: ${launchRes.stderr || launchRes.stdout}`);
  assert.ok(launchRes.data);
  assert.equal(launchRes.data.success, true);
  assert.equal(launchRes.data.running, true);
  assert.ok(Number.isSafeInteger(launchRes.data.processId) && launchRes.data.processId > 0);
  assert.ok(typeof launchRes.data.executablePath === 'string' && launchRes.data.executablePath.length > 0);
  assert.ok(typeof launchRes.data.creationDate === 'string' && launchRes.data.creationDate.length > 0);
  assert.ok(launchRes.data.creationTimeFileTime);

  const pid = launchRes.data.processId;
  const exePath = launchRes.data.executablePath;
  const creationDate = launchRes.data.creationDate;
  const fileTime = launchRes.data.creationTimeFileTime;

  try {
    // 3. Inspect running process
    const inspectRes = await runProcessControl(['-Action', 'Inspect', '-ProcessId', String(pid)]);
    assert.equal(inspectRes.code, 0);
    assert.equal(inspectRes.data.running, true);
    assert.equal(inspectRes.data.processId, pid);
    assert.equal(inspectRes.data.creationDate, creationDate);
    assert.equal(inspectRes.data.creationTimeFileTime, fileTime);

    // 4. Stop rejected when executable path does not match (exit code 2)
    const badPathRes = await runProcessControl([
      '-Action', 'Stop',
      '-ProcessId', String(pid),
      '-ExpectedExecutablePath', 'C:\\nonexistent\\evil.exe',
      '-ExpectedStartTime', creationDate
    ]);
    assert.equal(badPathRes.code, 2);
    assert.equal(badPathRes.data.error, 'PROCESS_IDENTITY_MISMATCH');
    assert.equal(badPathRes.data.reason, 'PATH_MISMATCH');

    // Still running after rejected stop
    const stillRunning1 = await runProcessControl(['-Action', 'Inspect', '-ProcessId', String(pid)]);
    assert.equal(stillRunning1.data.running, true);

    // 5. Stop rejected when creation time does not match (exit code 2)
    const badTimeRes = await runProcessControl([
      '-Action', 'Stop',
      '-ProcessId', String(pid),
      '-ExpectedExecutablePath', exePath,
      '-ExpectedStartTime', '2020-01-01T00:00:00.0000000Z'
    ]);
    assert.equal(badTimeRes.code, 2);
    assert.equal(badTimeRes.data.error, 'PROCESS_IDENTITY_MISMATCH');
    assert.equal(badTimeRes.data.reason, 'CREATION_TIME_MISMATCH');

    // Still running after rejected stop
    const stillRunning2 = await runProcessControl(['-Action', 'Inspect', '-ProcessId', String(pid)]);
    assert.equal(stillRunning2.data.running, true);

    // 6. Stop rejected when identity is missing (zero bare PID fallback)
    const barePidRes = await runProcessControl([
      '-Action', 'Stop',
      '-ProcessId', String(pid)
    ]);
    assert.equal(barePidRes.code, 2);
    assert.equal(barePidRes.data.error, 'PROCESS_IDENTITY_MISMATCH');

    // 7. Stop with verified matching identity succeeds and waits for exit
    const stopRes = await runProcessControl([
      '-Action', 'Stop',
      '-ProcessId', String(pid),
      '-ExpectedExecutablePath', exePath,
      '-ExpectedStartTime', creationDate
    ]);
    assert.equal(stopRes.code, 0);
    assert.equal(stopRes.data.success, true);
    assert.equal(stopRes.data.stopped, true);

    // 8. Inspect after stop confirms process has exited
    const afterStopRes = await runProcessControl(['-Action', 'Inspect', '-ProcessId', String(pid)]);
    assert.equal(afterStopRes.code, 0);
    assert.equal(afterStopRes.data.running, false);

    // 9. Stop on already stopped process is idempotent and returns stopped=true
    const stopAgain = await runProcessControl([
      '-Action', 'Stop',
      '-ProcessId', String(pid),
      '-ExpectedExecutablePath', exePath,
      '-ExpectedStartTime', creationDate
    ]);
    assert.equal(stopAgain.code, 0);
    assert.equal(stopAgain.data.stopped, true);
  } finally {
    // Cleanup guard if anything failed
    try {
      process.kill(pid);
    } catch (_) {}
  }
});

test('3. Stop using ExpectedCreationTimeFileTime matches exact FileTime', async () => {
  const launchRes = await runProcessControl([
    '-Action', 'Launch',
    '-ExecutablePath', process.execPath,
    '-Arguments', `"${keepAliveFixture}"`
  ]);
  assert.equal(launchRes.code, 0);
  const pid = launchRes.data.processId;
  const exePath = launchRes.data.executablePath;
  const fileTime = launchRes.data.creationTimeFileTime;

  try {
    const stopRes = await runProcessControl([
      '-Action', 'Stop',
      '-ProcessId', String(pid),
      '-ExpectedExecutablePath', exePath,
      '-ExpectedCreationTimeFileTime', String(fileTime)
    ]);
    assert.equal(stopRes.code, 0);
    assert.equal(stopRes.data.stopped, true);
  } finally {
    try { process.kill(pid); } catch (_) {}
  }
});

test('4. InspectListener and FindOwned: own port valid, wrong port/PID/time/path denied without killing child, crash/exit safe', async () => {
  const tag = `test-tag-${Date.now()}`;
  const { child, port, pid } = await spawnFakeListener(tag);

  try {
    // 4.1 Inspect initial child to get handle-verified executablePath and creationDate
    const inspectRes = await runProcessControl(['-Action', 'Inspect', '-ProcessId', String(pid)]);
    assert.equal(inspectRes.code, 0);
    assert.equal(inspectRes.data.running, true);
    assert.equal(inspectRes.data.processId, pid);
    const exePath = inspectRes.data.executablePath;
    const creationDate = inspectRes.data.creationDate;
    assert.ok(exePath, 'Executable path should be present');
    assert.ok(creationDate, 'Creation date should be present');

    // 4.2 Own port valid: InspectListener succeeds with code 0 and verified info
    const ownRes = await runProcessControl([
      '-Action', 'InspectListener',
      '-Port', String(port),
      '-ProcessId', String(pid),
      '-ExpectedExecutablePath', exePath,
      '-ExpectedStartTime', creationDate
    ]);
    assert.equal(ownRes.code, 0, `Own port inspection failed: ${ownRes.stderr || ownRes.stdout}`);
    assert.ok(ownRes.data);
    assert.equal(ownRes.data.success, true);
    assert.equal(ownRes.data.valid, true);
    assert.equal(ownRes.data.running, true);
    assert.equal(ownRes.data.processId, pid);
    assert.equal(ownRes.data.pid, pid);
    assert.equal(ownRes.data.port, port);
    assert.equal(ownRes.data.executablePath.toLowerCase(), exePath.toLowerCase());
    assert.equal(ownRes.data.executable.toLowerCase(), exePath.toLowerCase());
    assert.equal(ownRes.data.startedAt, creationDate);

    // 4.3 FindOwned by Port succeeds with code 0
    const findPortRes = await runProcessControl([
      '-Action', 'FindOwned',
      '-Port', String(port),
      '-ExpectedExecutablePath', exePath
    ]);
    assert.equal(findPortRes.code, 0, `FindOwned by port failed: ${findPortRes.stderr || findPortRes.stdout}`);
    assert.equal(findPortRes.data.success, true);
    assert.equal(findPortRes.data.found, true);
    assert.equal(findPortRes.data.processId, pid);

    // 4.4 FindOwned by Tag succeeds with code 0
    const findTagRes = await runProcessControl([
      '-Action', 'FindOwned',
      '-Tag', tag,
      '-ExpectedExecutablePath', exePath
    ]);
    assert.equal(findTagRes.code, 0, `FindOwned by tag failed: ${findTagRes.stderr || findTagRes.stdout}`);
    assert.equal(findTagRes.data.success, true);
    assert.equal(findTagRes.data.found, true);
    assert.equal(findTagRes.data.processId, pid);

    // 4.5 Wrong port denied (exit 2) without killing child
    const wrongPortRes = await runProcessControl([
      '-Action', 'InspectListener',
      '-Port', '59991',
      '-ProcessId', String(pid),
      '-ExpectedExecutablePath', exePath
    ]);
    assert.equal(wrongPortRes.code, 2);
    assert.equal(wrongPortRes.data.valid, false);
    // Verify child is still alive
    const stillAlive1 = await runProcessControl(['-Action', 'Inspect', '-ProcessId', String(pid)]);
    assert.equal(stillAlive1.data.running, true, 'Child should NOT be killed on wrong port denial');

    // 4.6 Wrong PID denied (exit 2) without killing child
    const wrongPidRes = await runProcessControl([
      '-Action', 'InspectListener',
      '-Port', String(port),
      '-ProcessId', String(pid + 8888),
      '-ExpectedExecutablePath', exePath,
      '-ExpectedStartTime', creationDate
    ]);
    assert.equal(wrongPidRes.code, 2);
    assert.equal(wrongPidRes.data.valid, false);
    assert.equal(wrongPidRes.data.reason, 'PID_MISMATCH');
    // Verify child is still alive
    const stillAlive2 = await runProcessControl(['-Action', 'Inspect', '-ProcessId', String(pid)]);
    assert.equal(stillAlive2.data.running, true, 'Child should NOT be killed on wrong PID denial');

    // 4.7 Wrong time denied (exit 2) without killing child
    const wrongTimeRes = await runProcessControl([
      '-Action', 'InspectListener',
      '-Port', String(port),
      '-ProcessId', String(pid),
      '-ExpectedExecutablePath', exePath,
      '-ExpectedStartTime', '2020-01-01T00:00:00.0000000Z'
    ]);
    assert.equal(wrongTimeRes.code, 2);
    assert.equal(wrongTimeRes.data.valid, false);
    assert.equal(wrongTimeRes.data.reason, 'CREATION_TIME_MISMATCH');
    // Verify child is still alive
    const stillAlive3 = await runProcessControl(['-Action', 'Inspect', '-ProcessId', String(pid)]);
    assert.equal(stillAlive3.data.running, true, 'Child should NOT be killed on wrong time denial');

    // 4.8 Wrong path denied (exit 2) without killing child
    const wrongPathRes = await runProcessControl([
      '-Action', 'InspectListener',
      '-Port', String(port),
      '-ProcessId', String(pid),
      '-ExpectedExecutablePath', 'C:\\nonexistent\\evil.exe',
      '-ExpectedStartTime', creationDate
    ]);
    assert.equal(wrongPathRes.code, 2);
    assert.equal(wrongPathRes.data.valid, false);
    assert.equal(wrongPathRes.data.reason, 'PATH_MISMATCH');
    // Verify child is still alive
    const stillAlive4 = await runProcessControl(['-Action', 'Inspect', '-ProcessId', String(pid)]);
    assert.equal(stillAlive4.data.running, true, 'Child should NOT be killed on wrong path denial');

    // 4.9 Crash/exit safe: Kill child and verify InspectListener and FindOwned handle exit gracefully
    child.kill('SIGTERM');
    await new Promise(r => child.on('close', r));

    // Confirm process is dead
    const afterExitInspect = await runProcessControl(['-Action', 'Inspect', '-ProcessId', String(pid)]);
    assert.equal(afterExitInspect.data.running, false);

    // InspectListener on dead child port is safe
    const deadInspect = await runProcessControl([
      '-Action', 'InspectListener',
      '-Port', String(port),
      '-ProcessId', String(pid),
      '-ExpectedExecutablePath', exePath
    ]);
    assert.equal(deadInspect.code, 2);
    assert.equal(deadInspect.data.valid, false);

    // FindOwned on dead child port is safe
    const deadFind = await runProcessControl([
      '-Action', 'FindOwned',
      '-Port', String(port)
    ]);
    assert.equal(deadFind.code, 2);
    assert.equal(deadFind.data.found, false);
  } finally {
    try { child.kill('SIGKILL'); } catch (_) {}
  }
});

test('5. Launch with -LaunchPayloadFromStdin passes complete environment and returns verified handle-bound metadata', async () => {
  const secretKey = `sec-${Date.now()}`;
  const payload = {
    executablePath: process.execPath,
    arguments: [keepAliveFixture],
    workingDirectory: null,
    environment: {
      TEST_SECRET: secretKey,
      SystemRoot: process.env.SystemRoot || 'C:\\Windows'
    }
  };

  const launchRes = await runProcessControl(
    ['-Action', 'Launch', '-LaunchPayloadFromStdin'],
    JSON.stringify(payload)
  );

  assert.equal(launchRes.code, 0, `Launch failed: ${launchRes.stderr || launchRes.stdout}`);
  assert.ok(launchRes.data);
  assert.equal(launchRes.data.success, true);
  assert.equal(launchRes.data.running, true);
  assert.ok(Number.isSafeInteger(launchRes.data.processId) && launchRes.data.processId > 0);
  assert.ok(typeof launchRes.data.executablePath === 'string' && launchRes.data.executablePath.length > 0);
  assert.ok(typeof launchRes.data.creationDate === 'string' && launchRes.data.creationDate.length > 0);
  assert.ok(launchRes.data.creationTimeFileTime);
  assert.ok(!launchRes.stdout.includes(secretKey), 'Secret token must NOT be leaked into stdout');

  const pid = launchRes.data.processId;
  const exePath = launchRes.data.executablePath;
  const creationDate = launchRes.data.creationDate;

  try {
    const inspectRes = await runProcessControl(['-Action', 'Inspect', '-ProcessId', String(pid)]);
    assert.equal(inspectRes.code, 0);
    assert.equal(inspectRes.data.running, true);
    assert.equal(inspectRes.data.processId, pid);

    const stopRes = await runProcessControl([
      '-Action', 'Stop',
      '-ProcessId', String(pid),
      '-ExpectedExecutablePath', exePath,
      '-ExpectedStartTime', creationDate
    ]);
    assert.equal(stopRes.code, 0);
    assert.equal(stopRes.data.success, true);
    assert.equal(stopRes.data.stopped, true);

    const afterStopRes = await runProcessControl(['-Action', 'Inspect', '-ProcessId', String(pid)]);
    assert.equal(afterStopRes.code, 0);
    assert.equal(afterStopRes.data.running, false);
  } finally {
    try { process.kill(pid); } catch (_) {}
  }
});

test('6. Launch with -LaunchPayloadFromStdin rejects payload exceeding limitBytes (256KB)', async () => {
  const padding = 'X'.repeat(262145);
  const oversizedPayload = {
    executablePath: process.execPath,
    arguments: [keepAliveFixture],
    workingDirectory: null,
    environment: { PADDING: padding }
  };

  const res = await runProcessControl(
    ['-Action', 'Launch', '-LaunchPayloadFromStdin'],
    JSON.stringify(oversizedPayload)
  );

  assert.equal(res.code, 1);
  assert.ok(res.data);
  assert.equal(res.data.success, false);
  assert.equal(res.data.error, 'PAYLOAD_TOO_LARGE');
  assert.equal(res.data.limitBytes, 262144);
});

test('7. Standard Launch with -EnvironmentVariables applies full environment to child process', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-env-test-'));
  const reportPath = path.join(tempDir, 'report.json');
  const customSecret = `custom-sec-${Date.now()}`;
  const customVal = `val-${Date.now()}`;

  const envObj = {
    CUSTOM_SECRET: customSecret,
    CUSTOM_VAL: customVal,
    SystemRoot: process.env.SystemRoot || 'C:\\Windows'
  };

  const launchRes = await runProcessControl([
    '-Action', 'Launch',
    '-ExecutablePath', process.execPath,
    '-CommandLine', `"${childFixture}" --report-file "${reportPath}"`,
    '-EnvironmentVariables', JSON.stringify(envObj)
  ]);

  assert.equal(launchRes.code, 0, `Launch failed: ${launchRes.stderr || launchRes.stdout}`);
  assert.ok(launchRes.data);
  assert.equal(launchRes.data.success, true);
  assert.equal(launchRes.data.running, true);
  assert.ok(launchRes.data.processId > 0);
  assert.ok(launchRes.data.creationTimeFileTime);
  assert.ok(launchRes.data.creationDate);

  const pid = launchRes.data.processId;
  const exePath = launchRes.data.executablePath;
  const creationDate = launchRes.data.creationDate;

  try {
    // Wait for report file
    let report = null;
    const start = Date.now();
    while (Date.now() - start < 5000) {
      if (fs.existsSync(reportPath)) {
        try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); break; } catch (_) {}
      }
      await new Promise(r => setTimeout(r, 50));
    }

    assert.ok(report, 'Child process must write report file');
    assert.equal(report.pid, pid);
    assert.equal(report.env.CUSTOM_SECRET, customSecret);
    assert.equal(report.env.CUSTOM_VAL, customVal);

    // Stop process cleanly
    const stopRes = await runProcessControl([
      '-Action', 'Stop',
      '-ProcessId', String(pid),
      '-ExpectedExecutablePath', exePath,
      '-ExpectedStartTime', creationDate
    ]);
    assert.equal(stopRes.code, 0);
    assert.equal(stopRes.data.stopped, true);
  } finally {
    try { process.kill(pid); } catch (_) {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
});

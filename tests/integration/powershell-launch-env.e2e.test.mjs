import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const scriptPath = fileURLToPath(new URL('../../scripts/process-control.ps1', import.meta.url));
const childFixture = fileURLToPath(new URL('../fixtures/powershell-launch-env-child.mjs', import.meta.url));

function runProcessControl(args, stdinPayload = null) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell', [
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      ...args
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

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
    } else {
      child.stdin.end();
    }
  });
}

function waitForFile(filePath, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(filePath)) {
      try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (_) {}
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return null;
}

test('E2E: Launch child via -LaunchPayloadFromStdin with exact env, args, cwd and verified metadata', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-e2e-valid-'));
  const reportPath = path.join(tempDir, 'report.json');
  const secretKey = `sec-tok-${Date.now()}-abc987`;
  const customVal = `cust-val-${Date.now()}`;

  const payload = {
    executablePath: process.execPath,
    arguments: [
      childFixture,
      '--report-file',
      reportPath,
      '--test-flag',
      'arg with space and "quotes"'
    ],
    workingDirectory: tempDir,
    environment: {
      API_SECRET_KEY: secretKey,
      CUSTOM_VARIABLE: customVal,
      SystemRoot: process.env.SystemRoot || 'C:\\Windows',
      PATH: process.env.PATH || ''
    }
  };

  const res = await runProcessControl(
    ['-Action', 'Launch', '-LaunchPayloadFromStdin'],
    JSON.stringify(payload)
  );

  assert.equal(res.code, 0, `Launch failed: ${res.stderr || res.stdout}`);
  assert.ok(res.data);
  assert.equal(res.data.success, true);
  assert.equal(res.data.running, true);
  assert.ok(Number.isSafeInteger(res.data.processId) && res.data.processId > 0);
  assert.ok(typeof res.data.executablePath === 'string' && res.data.executablePath.length > 0);
  assert.ok(typeof res.data.creationDate === 'string' && res.data.creationDate.length > 0);
  assert.ok(res.data.creationTimeFileTime);

  const pid = res.data.processId;
  const exePath = res.data.executablePath;
  const creationDate = res.data.creationDate;

  // Verify secret is NOT leaked in stdout or stderr
  assert.ok(!res.stdout.includes(secretKey), 'Secret token must NOT be leaked into stdout');
  assert.ok(!res.stderr.includes(secretKey), 'Secret token must NOT be leaked into stderr');

  try {
    // Verify report written by child process
    const report = waitForFile(reportPath, 5000);
    assert.ok(report, 'Child process must write report file');
    assert.equal(report.pid, pid, 'Child reported PID must match launch PID');
    assert.equal(report.cwd.toLowerCase(), tempDir.toLowerCase(), 'Child cwd must match specified workingDirectory');
    assert.equal(report.env.API_SECRET_KEY, secretKey, 'Child must receive exact secret env var');
    assert.equal(report.env.CUSTOM_VARIABLE, customVal, 'Child must receive exact custom env var');
    assert.deepEqual(report.argv, [
      '--report-file',
      reportPath,
      '--test-flag',
      'arg with space and "quotes"'
    ], 'Child must receive exact argv items');

    // Inspect confirms running
    const inspect = await runProcessControl(['-Action', 'Inspect', '-ProcessId', String(pid)]);
    assert.equal(inspect.code, 0);
    assert.equal(inspect.data.running, true);
    assert.equal(inspect.data.processId, pid);
    assert.equal(inspect.data.creationDate, creationDate);

    // Stop process safely with matching identity
    const stopRes = await runProcessControl([
      '-Action', 'Stop',
      '-ProcessId', String(pid),
      '-ExpectedExecutablePath', exePath,
      '-ExpectedStartTime', creationDate
    ]);
    assert.equal(stopRes.code, 0);
    assert.equal(stopRes.data.success, true);
    assert.equal(stopRes.data.stopped, true);

    // Inspect after stop confirms dead
    const afterStop = await runProcessControl(['-Action', 'Inspect', '-ProcessId', String(pid)]);
    assert.equal(afterStop.code, 0);
    assert.equal(afterStop.data.running, false);
  } finally {
    try { process.kill(pid); } catch (_) {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('E2E: Payload size limit: rejects payload exceeding 262144 bytes (256 KB)', async () => {
  // Construct payload with >256KB of data
  const padding = 'X'.repeat(262145);
  const oversizedPayload = {
    executablePath: process.execPath,
    arguments: [childFixture],
    workingDirectory: null,
    environment: { PADDING: padding }
  };

  const jsonStr = JSON.stringify(oversizedPayload);
  assert.ok(Buffer.byteLength(jsonStr, 'utf8') > 262144, 'Payload must exceed 256KB');

  const res = await runProcessControl(
    ['-Action', 'Launch', '-LaunchPayloadFromStdin'],
    jsonStr
  );

  assert.equal(res.code, 1, 'Must exit with code 1 when payload exceeds 256KB');
  assert.ok(res.data, 'Must return JSON error');
  assert.equal(res.data.success, false);
  assert.equal(res.data.error, 'PAYLOAD_TOO_LARGE');
  assert.equal(res.data.limitBytes, 262144);
});

test('E2E: Payload size within limit: payload close to 200KB is accepted and launched', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-e2e-large-'));
  const reportPath = path.join(tempDir, 'report.json');
  // 150KB padding is comfortably within 256KB limit
  const padding = 'A'.repeat(150000);

  const payload = {
    executablePath: process.execPath,
    arguments: [childFixture, '--report-file', reportPath],
    workingDirectory: tempDir,
    environment: {
      LARGE_DATA: padding,
      SystemRoot: process.env.SystemRoot || 'C:\\Windows'
    }
  };

  const jsonStr = JSON.stringify(payload);
  const byteLen = Buffer.byteLength(jsonStr, 'utf8');
  assert.ok(byteLen > 150000 && byteLen < 262144, 'Payload must be within limit');

  const res = await runProcessControl(
    ['-Action', 'Launch', '-LaunchPayloadFromStdin'],
    jsonStr
  );

  assert.equal(res.code, 0, `Large payload within limit should succeed: ${res.stderr || res.stdout}`);
  assert.equal(res.data.success, true);
  const pid = res.data.processId;

  try {
    const report = waitForFile(reportPath, 5000);
    assert.ok(report);
    assert.equal(report.env.LARGE_DATA.length, 150000);
  } finally {
    try { process.kill(pid); } catch (_) {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('E2E: Rejection of invalid payloads: empty stdin, invalid JSON, invalid UTF-8', async () => {
  // 1. Empty stdin
  const emptyRes = await runProcessControl(
    ['-Action', 'Launch', '-LaunchPayloadFromStdin'],
    ''
  );
  assert.equal(emptyRes.code, 1);
  assert.equal(emptyRes.data.success, false);
  assert.equal(emptyRes.data.error, 'INVALID_PAYLOAD');

  // 2. Invalid JSON
  const invalidJsonRes = await runProcessControl(
    ['-Action', 'Launch', '-LaunchPayloadFromStdin'],
    '{ "unclosed": "brace"'
  );
  assert.equal(invalidJsonRes.code, 1);
  assert.equal(invalidJsonRes.data.success, false);
  assert.equal(invalidJsonRes.data.error, 'INVALID_JSON');

  // 3. Invalid UTF-8
  const invalidUtf8Res = await runProcessControl(
    ['-Action', 'Launch', '-LaunchPayloadFromStdin'],
    Buffer.from([0xff, 0xfe, 0xfd])
  );
  assert.equal(invalidUtf8Res.code, 1);
  assert.equal(invalidUtf8Res.data.success, false);
  assert.equal(invalidUtf8Res.data.error, 'INVALID_ENCODING');
});

test('E2E: Validation of payload schema fields', async () => {
  // 1. Missing executablePath
  const noExeRes = await runProcessControl(
    ['-Action', 'Launch', '-LaunchPayloadFromStdin'],
    JSON.stringify({ arguments: [], workingDirectory: null, environment: {} })
  );
  assert.equal(noExeRes.code, 1);
  assert.equal(noExeRes.data.error, 'INVALID_EXECUTABLE_PATH');

  // 2. Non-existent executablePath
  const nonExistExeRes = await runProcessControl(
    ['-Action', 'Launch', '-LaunchPayloadFromStdin'],
    JSON.stringify({ executablePath: 'C:\\nonexistent\\binary.exe', arguments: [], workingDirectory: null, environment: {} })
  );
  assert.equal(nonExistExeRes.code, 1);
  assert.equal(nonExistExeRes.data.error, 'EXECUTABLE_NOT_FOUND');

  // 3. Missing arguments
  const noArgsRes = await runProcessControl(
    ['-Action', 'Launch', '-LaunchPayloadFromStdin'],
    JSON.stringify({ executablePath: process.execPath, workingDirectory: null, environment: {} })
  );
  assert.equal(noArgsRes.code, 1);
  assert.equal(noArgsRes.data.error, 'INVALID_ARGUMENTS');

  // 4. Arguments not array
  const badArgsRes = await runProcessControl(
    ['-Action', 'Launch', '-LaunchPayloadFromStdin'],
    JSON.stringify({ executablePath: process.execPath, arguments: 'not-array', workingDirectory: null, environment: {} })
  );
  assert.equal(badArgsRes.code, 1);
  assert.equal(badArgsRes.data.error, 'INVALID_ARGUMENTS');

  // 5. Arguments containing non-string
  const badArgTypesRes = await runProcessControl(
    ['-Action', 'Launch', '-LaunchPayloadFromStdin'],
    JSON.stringify({ executablePath: process.execPath, arguments: ['ok', 12345], workingDirectory: null, environment: {} })
  );
  assert.equal(badArgTypesRes.code, 1);
  assert.equal(badArgTypesRes.data.error, 'INVALID_ARGUMENTS');

  // 6. Non-existent workingDirectory
  const badWdRes = await runProcessControl(
    ['-Action', 'Launch', '-LaunchPayloadFromStdin'],
    JSON.stringify({ executablePath: process.execPath, arguments: [], workingDirectory: 'C:\\nonexistent\\dir123', environment: {} })
  );
  assert.equal(badWdRes.code, 1);
  assert.equal(badWdRes.data.error, 'WORKING_DIRECTORY_NOT_FOUND');

  // 7. Missing environment
  const noEnvRes = await runProcessControl(
    ['-Action', 'Launch', '-LaunchPayloadFromStdin'],
    JSON.stringify({ executablePath: process.execPath, arguments: [], workingDirectory: null })
  );
  assert.equal(noEnvRes.code, 1);
  assert.equal(noEnvRes.data.error, 'INVALID_ENVIRONMENT');

  // 8. Environment not dictionary
  const badEnvRes = await runProcessControl(
    ['-Action', 'Launch', '-LaunchPayloadFromStdin'],
    JSON.stringify({ executablePath: process.execPath, arguments: [], workingDirectory: null, environment: 'not-dict' })
  );
  assert.equal(badEnvRes.code, 1);
  assert.equal(badEnvRes.data.error, 'INVALID_ENVIRONMENT');

  // 9. Environment with non-string values
  const badEnvValsRes = await runProcessControl(
    ['-Action', 'Launch', '-LaunchPayloadFromStdin'],
    JSON.stringify({ executablePath: process.execPath, arguments: [], workingDirectory: null, environment: { NUM_KEY: 42 } })
  );
  assert.equal(badEnvValsRes.code, 1);
  assert.equal(badEnvValsRes.data.error, 'INVALID_ENVIRONMENT');
});

test('E2E: -LaunchPayloadFromStdin flag rejected on non-Launch action', async () => {
  const res = await runProcessControl(['-Action', 'Inspect', '-LaunchPayloadFromStdin', '-ProcessId', '1234']);
  assert.equal(res.code, 1);
  assert.equal(res.data.success, false);
  assert.equal(res.data.error, 'INVALID_ACTION_FOR_FLAG');
});

test('E2E: Identity mismatch rejection without killing child process', async () => {
  const payload = {
    executablePath: process.execPath,
    arguments: [childFixture],
    workingDirectory: null,
    environment: { SystemRoot: process.env.SystemRoot || 'C:\\Windows' }
  };

  const launchRes = await runProcessControl(
    ['-Action', 'Launch', '-LaunchPayloadFromStdin'],
    JSON.stringify(payload)
  );

  assert.equal(launchRes.code, 0);
  const pid = launchRes.data.processId;
  const exePath = launchRes.data.executablePath;
  const creationDate = launchRes.data.creationDate;

  try {
    // 1. Wrong path rejected with code 2
    const wrongPathRes = await runProcessControl([
      '-Action', 'Stop',
      '-ProcessId', String(pid),
      '-ExpectedExecutablePath', 'C:\\wrong\\binary.exe',
      '-ExpectedStartTime', creationDate
    ]);
    assert.equal(wrongPathRes.code, 2);
    assert.equal(wrongPathRes.data.error, 'PROCESS_IDENTITY_MISMATCH');
    assert.equal(wrongPathRes.data.reason, 'PATH_MISMATCH');

    // Child must still be alive
    const aliveCheck1 = await runProcessControl(['-Action', 'Inspect', '-ProcessId', String(pid)]);
    assert.equal(aliveCheck1.data.running, true);

    // 2. Wrong time rejected with code 2
    const wrongTimeRes = await runProcessControl([
      '-Action', 'Stop',
      '-ProcessId', String(pid),
      '-ExpectedExecutablePath', exePath,
      '-ExpectedStartTime', '2019-01-01T00:00:00.0000000Z'
    ]);
    assert.equal(wrongTimeRes.code, 2);
    assert.equal(wrongTimeRes.data.error, 'PROCESS_IDENTITY_MISMATCH');
    assert.equal(wrongTimeRes.data.reason, 'CREATION_TIME_MISMATCH');

    // Child must still be alive
    const aliveCheck2 = await runProcessControl(['-Action', 'Inspect', '-ProcessId', String(pid)]);
    assert.equal(aliveCheck2.data.running, true);

    // 3. Stop with matching identity succeeds
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
  }
});

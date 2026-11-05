import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  ProcessHandleWatcher,
  globalWatcher,
  isHeavyTest,
  partitionTestFiles,
  enumerateTestFiles,
  setupTestEnvironment,
  runAllTests
} from '../scripts/run-tests.mjs';

import {
  createSyntheticThirdServer,
  startSyntheticThirdServer,
  ThirdPartyMcpAdapter
} from './fixtures/synthetic-third-adapter.mjs';

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), '..');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { timeout: 3000 }, (res) => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(d) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: d });
        }
      });
    }).on('error', reject);
  });
}

describe('Test Harness & Concurrency Control Suite', () => {

  describe('1. ProcessHandleWatcher unit tests', () => {
    it('tracks spawned process handle and decrements count on clean exit', async () => {
      const watcher = new ProcessHandleWatcher();
      assert.equal(watcher.getTrackedCount(), 0);

      const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
        stdio: 'ignore'
      });

      watcher.track(child, { label: 'quick-exit' });
      assert.equal(watcher.getTrackedCount(), 1);

      await new Promise((resolve) => {
        child.on('close', resolve);
      });

      // After close, count must be 0
      assert.equal(watcher.getTrackedCount(), 0);
    });

    it('rejects invalid or missing process handle', () => {
      const watcher = new ProcessHandleWatcher();
      assert.throws(() => {
        watcher.track(null);
      }, /Invalid child process handle/);

      assert.throws(() => {
        watcher.track({});
      }, /Invalid child process handle/);
    });

    it('stops tracked process and releases handle', async () => {
      const watcher = new ProcessHandleWatcher();
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore'
      });

      watcher.track(child, { label: 'infinite-loop' });
      assert.equal(watcher.getTrackedCount(), 1);

      const stopped = await watcher.stopProcess(child, 1000);
      assert.equal(stopped, true);
      assert.equal(watcher.getTrackedCount(), 0);
      assert.ok(child.killed || child.exitCode !== null);
    });

    it('enforces deadline timeout and safely terminates process on expiry', async () => {
      const watcher = new ProcessHandleWatcher();
      let timedOutNotified = false;

      watcher.onTimeout((entry) => {
        timedOutNotified = true;
        assert.equal(entry.label, 'timeout-test');
      });

      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore'
      });

      watcher.track(child, { timeoutMs: 300, label: 'timeout-test' });
      assert.equal(watcher.getTrackedCount(), 1);

      // Wait for timeout to fire (300ms + margin)
      await new Promise(r => setTimeout(r, 800));

      assert.equal(timedOutNotified, true);
      assert.equal(watcher.getTrackedCount(), 0);
      assert.ok(child.killed || child.exitCode !== null);
    });

    it('cleanupAll terminates all registered process handles', async () => {
      const watcher = new ProcessHandleWatcher();
      const child1 = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      const child2 = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });

      watcher.track(child1, { label: 'multi-1' });
      watcher.track(child2, { label: 'multi-2' });
      assert.equal(watcher.getTrackedCount(), 2);

      await watcher.cleanupAll(1000);

      assert.equal(watcher.getTrackedCount(), 0);
      assert.ok(child1.killed || child1.exitCode !== null);
      assert.ok(child2.killed || child2.exitCode !== null);
    });
  });

  describe('2. Heavy vs Light test partitioning & Concurrency bounding', () => {
    it('correctly classifies heavy vs light test paths', () => {
      // Heavy tests
      assert.equal(isHeavyTest('tests/integration/third-mcp.e2e.test.mjs'), true);
      assert.equal(isHeavyTest('tests\\integration\\registered-adapter.e2e.test.mjs'), true);
      assert.equal(isHeavyTest('tests/integration/browser-flow.e2e.test.mjs'), true);
      assert.equal(isHeavyTest('tests/process-control.test.mjs'), true);
      assert.equal(isHeavyTest('tests/ui-registry.test.mjs'), true);

      // Light tests
      assert.equal(isHeavyTest('tests/core/http-transport.test.mjs'), false);
      assert.equal(isHeavyTest('tests/core/switch-core.test.mjs'), false);
      assert.equal(isHeavyTest('tests/vault.test.mjs'), false);
      assert.equal(isHeavyTest('tests/security.test.mjs'), false);
      assert.equal(isHeavyTest('tests/core/mcp-registry-policy.test.mjs'), false);
    });

    it('partitions a mixed list of tests into light and heavy sets', () => {
      const mixed = [
        path.join(projectRoot, 'tests', 'vault.test.mjs'),
        path.join(projectRoot, 'tests', 'core', 'http-transport.test.mjs'),
        path.join(projectRoot, 'tests', 'integration', 'third-mcp.e2e.test.mjs'),
        path.join(projectRoot, 'tests', 'process-control.test.mjs')
      ];

      const { light, heavy } = partitionTestFiles(mixed);
      assert.equal(light.length, 2);
      assert.equal(heavy.length, 2);

      assert.ok(light.some(f => f.includes('vault.test.mjs')));
      assert.ok(light.some(f => f.includes('http-transport.test.mjs')));
      assert.ok(heavy.some(f => f.includes('third-mcp.e2e.test.mjs')));
      assert.ok(heavy.some(f => f.includes('process-control.test.mjs')));
    });

    it('enumerates test files without shell wildcards', () => {
      const testsDir = path.join(projectRoot, 'tests');
      const files = enumerateTestFiles(testsDir, [], { allowIntegration: false });
      assert.ok(files.length > 0);

      // None of the enumerated files should contain unexpanded glob wildcards
      for (const file of files) {
        assert.ok(!file.includes('*'), `File path must not contain '*': ${file}`);
        assert.ok(!file.includes('?'), `File path must not contain '?': ${file}`);
        assert.ok(path.isAbsolute(file), `File path must be explicit absolute: ${file}`);
        assert.ok(fs.existsSync(file), `Enumerated file must exist on disk: ${file}`);
      }
    });
  });

  describe('3. Harness exit counts and truthful status reporting', () => {
    it('accurately reports truthful pass exit code (0) and file counts', async () => {
      const watcher = new ProcessHandleWatcher();
      const testFiles = [
        path.join(projectRoot, 'tests', 'core', 'http-transport.test.mjs')
      ];

      const summary = await runAllTests(testFiles, {
        watcher,
        lightTimeoutMs: 30000
      });

      assert.equal(summary.totalFiles, 1);
      assert.equal(summary.passedFiles, 1);
      assert.equal(summary.failedFiles, 0);
      assert.equal(summary.exitCode, 0);
    });

    it('accurately reports truthful failure exit code when a test fails', async () => {
      const watcher = new ProcessHandleWatcher();

      // Create a temporary failing test file
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-fail-test-'));
      const failingTestPath = path.join(tmpDir, 'failing.test.mjs');
      fs.writeFileSync(failingTestPath, `
import test from 'node:test';
import assert from 'node:assert/strict';
test('deliberate failure', () => {
  assert.equal(1, 2, 'Expected failure');
});
`, 'utf8');

      try {
        const summary = await runAllTests([failingTestPath], {
          watcher,
          lightTimeoutMs: 30000
        });

        assert.equal(summary.totalFiles, 1);
        assert.equal(summary.passedFiles, 0);
        assert.equal(summary.failedFiles, 1);
        assert.notEqual(summary.exitCode, 0, 'Exit code must be non-zero for test failure');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('accurately counts individual file pass/fail in light suite without overcounting bundle failures', async () => {
      const watcher = new ProcessHandleWatcher();
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-bundle-test-'));
      const passPath = path.join(tmpDir, 'bundle-pass.test.mjs');
      const failPath = path.join(tmpDir, 'bundle-fail.test.mjs');

      fs.writeFileSync(passPath, `
import test from 'node:test';
import assert from 'node:assert/strict';
test('deliberate pass', () => { assert.equal(1, 1); });
`, 'utf8');

      fs.writeFileSync(failPath, `
import test from 'node:test';
import assert from 'node:assert/strict';
test('deliberate fail', () => { assert.equal(1, 2); });
`, 'utf8');

      try {
        const summary = await runAllTests([passPath, failPath], {
          watcher,
          lightTimeoutMs: 30000
        });

        assert.equal(summary.totalFiles, 2);
        assert.equal(summary.passedFiles, 1);
        assert.equal(summary.failedFiles, 1);
        assert.notEqual(summary.exitCode, 0);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('returns 0 when no test files match', async () => {
      const watcher = new ProcessHandleWatcher();
      const summary = await runAllTests([], { watcher });
      assert.equal(summary.totalFiles, 0);
      assert.equal(summary.passedFiles, 0);
      assert.equal(summary.failedFiles, 0);
      assert.equal(summary.exitCode, 0);
    });
  });

  describe('4. Per-run evidence root preservation', () => {
    it('sets up per-run evidence root without overwriting existing runs', () => {
      const originalArtifactRoot = process.env.TEST_ARTIFACT_ROOT;
      const originalBrowserReport = process.env.BROWSER_REPORT_DIR;

      try {
        delete process.env.TEST_ARTIFACT_ROOT;
        delete process.env.BROWSER_REPORT_DIR;

        const env1 = setupTestEnvironment(projectRoot);
        assert.ok(env1.artifactRoot.includes('reports'));
        assert.ok(env1.browserReportDir.includes('browser'));
        assert.ok(fs.existsSync(env1.browserReportDir));

        // Create a dummy evidence file in run 1
        const evidenceFile1 = path.join(env1.artifactRoot, 'evidence-1.json');
        fs.writeFileSync(evidenceFile1, JSON.stringify({ run: 1 }), 'utf8');

        // Setup run 2 with a new timestamp
        delete process.env.TEST_ARTIFACT_ROOT;
        delete process.env.BROWSER_REPORT_DIR;

        const env2 = setupTestEnvironment(projectRoot);
        assert.ok(fs.existsSync(env2.browserReportDir));

        // Run 1 evidence must still exist untouched
        assert.ok(fs.existsSync(evidenceFile1), 'Previous evidence must be preserved');
      } finally {
        if (originalArtifactRoot) process.env.TEST_ARTIFACT_ROOT = originalArtifactRoot;
        if (originalBrowserReport) process.env.BROWSER_REPORT_DIR = originalBrowserReport;
      }
    });
  });

  describe('5. Synthetic Third Adapter reliable server startup and port binding', () => {
    it('starts synthetic server on ephemeral port 0 and cleanly shuts down', async () => {
      const synth = createSyntheticThirdServer({
        service: 'test-synthetic',
        tunnelId: 'tunnel-test-synth'
      });

      assert.equal(synth.isRunning(), false);

      const info = await synth.start(0);
      assert.ok(info.port > 0, 'Port must be a positive integer assigned by OS');
      assert.ok(info.url.includes(`:${info.port}`));
      assert.equal(synth.isRunning(), true);

      // Verify /health endpoint responds
      const health = await fetchJson(`${info.url}/health`);
      assert.equal(health.status, 200);
      assert.equal(health.body.schema_version, 1);
      assert.equal(health.body.live, true);
      assert.equal(health.body.ready, true);
      assert.equal(health.body.components['control-plane'].status, 'ok');

      // Verify /api/status endpoint responds
      const status = await fetchJson(`${info.url}/api/status`);
      assert.equal(status.status, 200);
      assert.equal(status.body.version, '0.0.19');
      assert.equal(status.body.control_plane_tunnel_id, 'tunnel-test-synth');

      // Cleanly close server and verify handle release
      await synth.close();
      assert.equal(synth.isRunning(), false);

      // Port must no longer be reachable
      await assert.rejects(
        () => fetchJson(`${info.url}/health`),
        /ECONNREFUSED|ECONNRESET|Fetch returned no response|socket hang up/
      );
    });

    it('startSyntheticThirdServer helper manages startup and health toggling', async () => {
      const server = await startSyntheticThirdServer({
        service: 'test-toggle',
        tunnelId: 'tunnel-toggle'
      });

      assert.ok(server.port > 0);

      // Verify initial healthy status
      const h1 = await fetchJson(`${server.url}/health`);
      assert.equal(h1.body.components['control-plane'].status, 'ok');

      // Toggle degraded status
      server.setHealthy(false);
      const h2 = await fetchJson(`${server.url}/health`);
      assert.equal(h2.body.components['control-plane'].status, 'degraded');
      assert.equal(h2.body.components['control-plane'].details.http_status, 401);

      await server.close();
    });
  });

});

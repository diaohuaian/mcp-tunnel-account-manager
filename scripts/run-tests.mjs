import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), '..');
const testsDir = path.join(projectRoot, 'tests');

/**
 * ProcessHandleWatcher tracks OWN spawned child process handles.
 * Enforces bounded process deadlines safely without broad taskkill or PID collisions.
 * In finally / cleanup blocks, ensures all owned handles are released and terminated.
 */
export class ProcessHandleWatcher {
  constructor(options = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs || 120000;
    this.ownedProcesses = new Map(); // childProcess -> { child, pid, label, startTime, timer }
    this.timeoutCallbacks = [];
  }

  track(child, { timeoutMs = this.defaultTimeoutMs, label = '' } = {}) {
    if (!child || typeof child.kill !== 'function') {
      throw new Error('Invalid child process handle');
    }
    const pid = child.pid;
    const entry = {
      child,
      pid,
      label,
      startTime: Date.now(),
      timer: null,
      timedOut: false
    };

    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      entry.timer = setTimeout(() => {
        this._handleTimeout(entry, timeoutMs);
      }, timeoutMs);
      entry.timer.unref?.();
    }

    this.ownedProcesses.set(child, entry);

    const onExit = () => {
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      this.ownedProcesses.delete(child);
    };

    child.once('exit', onExit);
    child.once('close', onExit);

    return child;
  }

  _handleTimeout(entry, timeoutMs) {
    const { child, label, pid } = entry;
    console.error(`\n[ProcessHandleWatcher] Process timed out after ${timeoutMs}ms: pid=${pid} (${label || 'unknown'})`);
    entry.timedOut = true;
    for (const cb of this.timeoutCallbacks) {
      try { cb(entry); } catch (_) {}
    }
    this.stopProcess(child, 3000);
  }

  onTimeout(cb) {
    if (typeof cb === 'function') {
      this.timeoutCallbacks.push(cb);
    }
  }

  async stopProcess(child, graceMs = 3000) {
    const entry = this.ownedProcesses.get(child);
    if (!child) return false;
    if (entry?.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }

    if (child.exitCode !== null || child.killed) {
      this.ownedProcesses.delete(child);
      return true;
    }

    return new Promise((resolve) => {
      let resolved = false;
      const finish = () => {
        if (!resolved) {
          resolved = true;
          this.ownedProcesses.delete(child);
          resolve(true);
        }
      };

      child.once('exit', finish);
      child.once('close', finish);

      // Attempt polite SIGTERM / standard kill on OWN handle
      try {
        child.kill('SIGTERM');
      } catch (_) {}

      // Force kill on OWN handle after grace period
      const forceTimer = setTimeout(() => {
        if (!resolved && child.exitCode === null) {
          try {
            child.kill('SIGKILL');
          } catch (_) {}
        }
        finish();
      }, graceMs);
      forceTimer.unref?.();
    });
  }

  async cleanupAll(graceMs = 3000) {
    const promises = [];
    for (const [child] of this.ownedProcesses) {
      promises.push(this.stopProcess(child, graceMs));
    }
    await Promise.all(promises);
    this.ownedProcesses.clear();
  }

  getTrackedCount() {
    return this.ownedProcesses.size;
  }

  getTrackedEntries() {
    return Array.from(this.ownedProcesses.values());
  }
}

/**
 * Global shared watcher for harness execution.
 */
export const globalWatcher = new ProcessHandleWatcher();

/**
 * Determines if a given test file is resource-heavy (browser, integration, subprocesses).
 */
export function isHeavyTest(filePath) {
  const norm = filePath.replaceAll('\\', '/').toLowerCase();
  const baseName = path.basename(norm);
  const isIntegrationDir = norm.includes('/integration/') || norm.includes('\\integration\\');
  return (
    isIntegrationDir ||
    baseName.includes('.e2e.') ||
    baseName.includes('browser') ||
    baseName.includes('process-control') ||
    baseName.includes('ui-registry')
  );
}

/**
 * Partitions explicit test files into light and heavy sets.
 */
export function partitionTestFiles(files) {
  const light = [];
  const heavy = [];
  for (const f of files) {
    if (isHeavyTest(f)) {
      heavy.push(f);
    } else {
      light.push(f);
    }
  }
  return { light, heavy };
}

/**
 * Discovers test files recursively with explicit path resolution (no shell globs).
 */
export function enumerateTestFiles(dir, files = [], { allowIntegration = false } = {}) {
  if (!fs.existsSync(dir)) return files;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name.startsWith('.gpt') ||
        entry.name.startsWith('.')
      ) {
        continue;
      }
      if (entry.name === 'integration' && !allowIntegration) {
        continue;
      }
      enumerateTestFiles(fullPath, files, { allowIntegration });
    } else if (entry.isFile() && (entry.name.endsWith('.test.mjs') || entry.name.endsWith('.test.js'))) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Initializes per-run evidence root and report directories without overwriting previous evidence.
 */
export function setupTestEnvironment(root = projectRoot) {
  if (!process.env.TEST_ARTIFACT_ROOT) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    process.env.TEST_ARTIFACT_ROOT = path.join(root, 'reports', 'runs', `run-${timestamp}-${process.pid}`);
  }
  if (!process.env.BROWSER_REPORT_DIR) {
    process.env.BROWSER_REPORT_DIR = path.join(process.env.TEST_ARTIFACT_ROOT, 'browser');
  }
  try {
    fs.mkdirSync(process.env.BROWSER_REPORT_DIR, { recursive: true });
  } catch (_) {}
  return {
    artifactRoot: process.env.TEST_ARTIFACT_ROOT,
    browserReportDir: process.env.BROWSER_REPORT_DIR
  };
}

/**
 * Runs a single node test runner child process tracked by the handle watcher.
 */
function spawnTrackedNodeTest(args, { cwd = projectRoot, timeoutMs = 120000, label = '', watcher = globalWatcher } = {}) {
  return new Promise((resolve) => {
    const cleanEnv = { ...process.env };
    delete cleanEnv.NODE_TEST_CONTEXT;

    const child = spawn(process.execPath, ['--test', ...args], {
      cwd,
      stdio: 'inherit',
      shell: false,
      env: cleanEnv
    });

    watcher.track(child, { timeoutMs, label });

    child.on('close', (code, signal) => {
      resolve({
        code: code ?? (signal ? 1 : 0),
        signal,
        label
      });
    });

    child.on('error', (err) => {
      console.error(`[run-tests] Process spawn error (${label}):`, err);
      resolve({ code: 1, error: err, label });
    });
  });
}

/**
 * Executes a full test suite with bounded concurrency:
 * - Heavy tests: exactly 1 at a time on Windows (sequential).
 * - Light tests: up to 4 concurrent runners.
 * - Explicit file lists (Windows node --test portability).
 * - Truthful exit code and file counts.
 */
export async function runAllTests(testFiles, options = {}) {
  const startTime = Date.now();
  const watcher = options.watcher || globalWatcher;
  setupTestEnvironment(projectRoot);

  const isWindows = process.platform === 'win32';
  const maxLightConcurrency = options.lightConcurrency ?? (isWindows ? 4 : Math.min(4, os.availableParallelism?.() || 4));
  const heavyConcurrency = options.heavyConcurrency ?? (isWindows ? 1 : 1);
  const nodeTestOptions = options.nodeTestOptions || [];

  const { light, heavy } = partitionTestFiles(testFiles);

  const results = {
    totalFiles: testFiles.length,
    lightFiles: light.length,
    heavyFiles: heavy.length,
    passedFiles: 0,
    failedFiles: 0,
    exitCode: 0,
    runs: []
  };

  if (testFiles.length === 0) {
    console.log('No test files found to execute.');
    results.durationMs = Date.now() - startTime;
    results.timestamp = new Date().toISOString();
    return results;
  }

  // 1. Run Light Tests with bounded concurrency up to 4 (precise per-file execution)
  if (light.length > 0) {
    console.log(`\n=== Running Light Test Suite (${light.length} file(s), concurrency: ${maxLightConcurrency}) ===`);
    let currentIndex = 0;
    const workerCount = Math.min(maxLightConcurrency, light.length);

    const runWorker = async () => {
      while (currentIndex < light.length) {
        const fileIdx = currentIndex++;
        const lightFile = light[fileIdx];
        const relName = path.relative(projectRoot, lightFile);
        const lightArgs = [
          ...nodeTestOptions,
          lightFile
        ];
        const runRes = await spawnTrackedNodeTest(lightArgs, {
          cwd: projectRoot,
          timeoutMs: options.lightTimeoutMs || 60000,
          label: relName,
          watcher
        });
        results.runs.push({ ...runRes, file: relName });
        if (runRes.code === 0) {
          results.passedFiles++;
        } else {
          results.failedFiles++;
          if (results.exitCode === 0) {
            results.exitCode = runRes.code || 1;
          }
        }
      }
    };

    const workers = Array.from({ length: workerCount }, () => runWorker());
    await Promise.all(workers);
  }

  // 2. Run Heavy Tests with bounded concurrency of 1 (one heavy test at a time on Windows)
  if (heavy.length > 0) {
    console.log(`\n=== Running Heavy Test Suite (${heavy.length} file(s), concurrency: ${heavyConcurrency} sequentially) ===`);
    for (const heavyFile of heavy) {
      const relName = path.relative(projectRoot, heavyFile);
      console.log(`\n[Heavy Test] >>> ${relName}`);
      const heavyArgs = [
        ...nodeTestOptions,
        heavyFile
      ];
      const heavyRun = await spawnTrackedNodeTest(heavyArgs, {
        cwd: projectRoot,
        timeoutMs: options.heavyTimeoutMs || 90000,
        label: relName,
        watcher
      });

      results.runs.push({ ...heavyRun, file: relName });
      if (heavyRun.code === 0) {
        results.passedFiles++;
      } else {
        results.failedFiles++;
        if (results.exitCode === 0) {
          results.exitCode = heavyRun.code || 1;
        }
      }
    }
  }

  results.durationMs = Date.now() - startTime;
  results.timestamp = new Date().toISOString();

  // Print execution summary
  console.log('\n================================================================');
  console.log(`Test Execution Summary:`);
  console.log(`  Total Files:  ${results.totalFiles}`);
  console.log(`  Passed Files: ${results.passedFiles}`);
  console.log(`  Failed Files: ${results.failedFiles}`);
  console.log(`  Duration:     ${results.durationMs}ms`);
  console.log(`  Exit Code:    ${results.exitCode}`);
  console.log('================================================================\n');

  const reportPath = options.reportPath || process.env.TEST_REPORT_PATH;
  if (reportPath) {
    try {
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, JSON.stringify(results, null, 2), 'utf8');
      console.log(`[run-tests] Test report written to: ${reportPath}`);
    } catch (e) {
      console.warn(`[run-tests] Failed to write report: ${e.message}`);
    }
  }

  return results;
}

// CLI Execution entrypoint
const isMainScript = process.argv[1] && (
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) ||
  process.argv[1].endsWith('run-tests.mjs')
);

if (isMainScript) {
  const rawArgs = process.argv.slice(2);
  const isIntegrationOnly = rawArgs.includes('--integration') || rawArgs.includes('--integration-only');
  const isUnitOnly = rawArgs.includes('--unit') || rawArgs.includes('--unit-only');
  const gptBarrierEnv = String(process.env.GPT_BARRIER || '').toLowerCase().trim();
  const isAfterBarrier =
    rawArgs.includes('--after-barrier') ||
    rawArgs.includes('--include-integration') ||
    rawArgs.includes('--all') ||
    ['1', 'true', 'passed', 'yes'].includes(gptBarrierEnv);

  const customFlags = new Set([
    '--integration',
    '--integration-only',
    '--unit',
    '--unit-only',
    '--after-barrier',
    '--include-integration',
    '--all',
    '--json'
  ]);

  const explicitTargets = [];
  const nodeTestOptions = [];
  let cliReportPath = null;

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--report' && i + 1 < rawArgs.length) {
      cliReportPath = rawArgs[++i];
      continue;
    }
    if (arg.startsWith('--report=')) {
      cliReportPath = arg.slice(9);
      continue;
    }
    if (customFlags.has(arg)) {
      continue;
    }
    if (arg.startsWith('-')) {
      nodeTestOptions.push(arg);
    } else {
      explicitTargets.push(path.isAbsolute(arg) ? arg : path.resolve(projectRoot, arg));
    }
  }

  let selectedFiles = [];
  if (explicitTargets.length > 0) {
    for (const target of explicitTargets) {
      if (fs.existsSync(target)) {
        const stat = fs.statSync(target);
        if (stat.isDirectory()) {
          enumerateTestFiles(target, selectedFiles, { allowIntegration: true });
        } else if (stat.isFile()) {
          selectedFiles.push(target);
        }
      }
    }
  } else if (isIntegrationOnly) {
    const integrationDir = path.join(testsDir, 'integration');
    selectedFiles = enumerateTestFiles(integrationDir, [], { allowIntegration: true });
  } else if (isUnitOnly) {
    selectedFiles = enumerateTestFiles(testsDir, [], { allowIntegration: false });
  } else {
    selectedFiles = enumerateTestFiles(testsDir, [], { allowIntegration: isAfterBarrier });
  }

  selectedFiles.sort();

  // Handle process shutdown signals cleanly
  const onSignal = async () => {
    console.log('\n[run-tests] Termination signal received; releasing tracked processes and handles...');
    await globalWatcher.cleanupAll();
    process.exit(1);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    const res = await runAllTests(selectedFiles, {
      nodeTestOptions,
      reportPath: cliReportPath || process.env.TEST_REPORT_PATH
    });
    await globalWatcher.cleanupAll();
    process.exit(res.exitCode);
  } catch (err) {
    console.error('[run-tests] Fatal harness error:', err);
    await globalWatcher.cleanupAll();
    process.exit(1);
  }
}

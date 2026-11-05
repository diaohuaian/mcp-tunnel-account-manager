import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), '..');

const args = process.argv.slice(2);
const syntaxOnly = args.includes('--syntax-only');
const isIntegration = args.includes('--integration') || args.includes('--integration-only');
const isUnitOnly = args.includes('--unit') || args.includes('--unit-only');
const gptBarrierEnv = String(process.env.GPT_BARRIER || '').toLowerCase().trim();
const isAfterBarrier =
  args.includes('--after-barrier') ||
  args.includes('--include-integration') ||
  args.includes('--all') ||
  ['1', 'true', 'passed', 'yes'].includes(gptBarrierEnv);

let reportPath = process.env.VALIDATION_REPORT_PATH || null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--report' && i + 1 < args.length) {
    reportPath = args[++i];
  } else if (args[i].startsWith('--report=')) {
    reportPath = args[i].slice(9);
  }
}

// Ensure per-run evidence root is preserved across test runs
if (!process.env.TEST_ARTIFACT_ROOT) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  process.env.TEST_ARTIFACT_ROOT = path.join(projectRoot, 'reports', 'runs', `run-${timestamp}-${process.pid}`);
}
if (!process.env.BROWSER_REPORT_DIR) {
  process.env.BROWSER_REPORT_DIR = path.join(process.env.TEST_ARTIFACT_ROOT, 'browser');
}
try {
  fs.mkdirSync(process.env.BROWSER_REPORT_DIR, { recursive: true });
} catch (_) {}

console.log('================================================================');
console.log('    MCP Tunnel Account Manager - Full Quality Validation Gate   ');
console.log('================================================================\n');

let allPassed = true;

// Step 1: Validate package.json
console.log('[1/3] Validating package.json schema and required scripts...');
const pkgPath = path.join(projectRoot, 'package.json');
try {
  if (!fs.existsSync(pkgPath)) {
    throw new Error('package.json not found at project root');
  }
  const rawPkg = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(rawPkg);

  const requiredFields = ['name', 'version', 'type', 'scripts', 'engines'];
  for (const field of requiredFields) {
    if (!pkg[field]) {
      throw new Error(`Missing required field in package.json: ${field}`);
    }
  }

  if (pkg.type !== 'module') {
    throw new Error(`Expected package.json type to be 'module', got: ${pkg.type}`);
  }

  const requiredScripts = ['start', 'test', 'test:integration', 'check', 'validate-all'];
  for (const scriptName of requiredScripts) {
    if (!pkg.scripts[scriptName]) {
      throw new Error(`Missing required script in package.json: ${scriptName}`);
    }
  }

  if (!pkg.engines.node || !pkg.engines.node.includes('>=22')) {
    throw new Error(`package.json engines.node must require Node.js >= 22.0.0, got: ${pkg.engines.node}`);
  }

  console.log('  [PASS] package.json syntax, scripts, and Node engine specifications valid.\n');
} catch (err) {
  allPassed = false;
  console.error(`  [FAIL] package.json validation failed: ${err.message}\n`);
}

// Step 2: Syntax Check across all source and test files
console.log('[2/3] Validating syntax across project source and test files...');
const scanDirs = ['src', 'public', 'scripts', 'tests'];
const excludeDirs = new Set(['node_modules', '.git', '.gpt-work', '.gpt-baseline', '.gpt-inputs']);

function enumerateSourceFiles(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (excludeDirs.has(entry.name) || entry.name.startsWith('.gpt') || entry.name.startsWith('.')) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      enumerateSourceFiles(fullPath, files);
    } else if (entry.isFile() && (entry.name.endsWith('.mjs') || entry.name.endsWith('.js'))) {
      files.push(fullPath);
    }
  }
  return files;
}

const allSourceFiles = [];
for (const sub of scanDirs) {
  enumerateSourceFiles(path.join(projectRoot, sub), allSourceFiles);
}
allSourceFiles.sort();

let syntaxErrors = 0;
for (const file of allSourceFiles) {
  const relPath = path.relative(projectRoot, file);
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: projectRoot,
    stdio: 'pipe',
    shell: false
  });
  if (result.status !== 0) {
    syntaxErrors++;
    allPassed = false;
    console.error(`  [FAIL] Syntax error in ${relPath}`);
    if (result.stderr && result.stderr.length > 0) {
      console.error(result.stderr.toString('utf8'));
    }
  }
}

if (syntaxErrors === 0) {
  console.log(`  [PASS] All ${allSourceFiles.length} source and test files passed syntax verification.\n`);
} else {
  console.error(`  [FAIL] ${syntaxErrors} file(s) failed syntax verification.\n`);
}

// Step 3: Test Suite Execution with Bounded Concurrency
console.log('[3/3] Native test execution via bounded harness...');
if (syntaxOnly) {
  console.log('  [SKIPPED] Test execution skipped because --syntax-only was requested.\n');
} else {
  const testArgs = ['scripts/run-tests.mjs'];
  if (args.includes('--all')) {
    testArgs.push('--all');
  } else if (isIntegration) {
    testArgs.push('--integration');
  } else if (isUnitOnly) {
    testArgs.push('--unit');
  } else if (isAfterBarrier) {
    testArgs.push('--after-barrier');
  }
  if (reportPath) {
    testArgs.push('--report', reportPath);
  }

  const testRun = spawnSync(process.execPath, testArgs, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: false,
    env: {
      ...process.env
    }
  });

  if (testRun.status !== 0) {
    allPassed = false;
    console.error(`\n  [FAIL] Test suite failed with exit code ${testRun.status}.\n`);
  } else {
    console.log('\n  [PASS] Test suite passed cleanly.\n');
  }
}

// Final Summary
console.log('================================================================');
if (allPassed) {
  console.log('  Validation Gate: ALL CHECKS PASSED');
  console.log('================================================================');
  process.exit(0);
} else {
  console.error('  Validation Gate: VALIDATION FAILED');
  console.log('================================================================');
  process.exit(1);
}

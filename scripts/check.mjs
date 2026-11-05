import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), '..');

const scanDirs = ['src', 'public', 'scripts', 'tests'];
const excludeDirs = new Set(['node_modules', '.git', '.gpt-work', '.gpt-baseline', '.gpt-inputs']);

export function enumerateSourceFiles(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (excludeDirs.has(entry.name) || entry.name.startsWith('.gpt') || entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      enumerateSourceFiles(fullPath, files);
    } else if (entry.isFile() && (entry.name.endsWith('.mjs') || entry.name.endsWith('.js'))) {
      files.push(fullPath);
    }
  }
  return files;
}

export function checkAllFiles(root = projectRoot) {
  const allFiles = [];
  for (const sub of scanDirs) {
    enumerateSourceFiles(path.join(root, sub), allFiles);
  }
  allFiles.sort();

  const results = {
    total: allFiles.length,
    passed: 0,
    failed: 0,
    failures: []
  };

  for (const file of allFiles) {
    const relPath = path.relative(root, file);
    const result = spawnSync(process.execPath, ['--check', file], {
      cwd: root,
      stdio: 'pipe',
      shell: false
    });
    if (result.status !== 0) {
      results.failed++;
      const stderr = result.stderr ? result.stderr.toString('utf8') : '';
      results.failures.push({ file: relPath, stderr });
    } else {
      results.passed++;
    }
  }

  return results;
}

const isMainScript = process.argv[1] && (
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) ||
  process.argv[1].endsWith('check.mjs')
);

if (isMainScript) {
  const results = checkAllFiles(projectRoot);

  for (const failure of results.failures) {
    console.error(`Syntax check FAILED for: ${failure.file}`);
    if (failure.stderr) console.error(failure.stderr);
  }

  if (results.failed === 0) {
    console.log(`\nSyntax check passed for all ${results.total} files.`);
    process.exit(0);
  } else {
    console.error(`\nCheck completed with ${results.failed} failure(s).`);
    process.exit(1);
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createMcpLocationResolver } from '../src/config/mcp-locations.mjs';

test('describe resolves stdio paths, existence flags, and package manifest', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-loc-test-'));

  try {
    const pkgDir = path.join(tempDir, 'my-mcp-pkg');
    fs.mkdirSync(pkgDir, { recursive: true });
    const pkgJsonPath = path.join(pkgDir, 'package.json');
    fs.writeFileSync(pkgJsonPath, JSON.stringify({
      name: '@example/mcp-pkg',
      version: '1.2.3',
      scripts: { test: 'node test.js' } // scripts must be ignored, never executed
    }));

    const exePath = path.join(pkgDir, 'index.js');
    fs.writeFileSync(exePath, 'console.log("mcp");\n');

    const sourceConfig = path.join(tempDir, 'overleaf.yaml');
    fs.writeFileSync(sourceConfig, 'dummy: config\n');

    const effectiveConfig = path.join(tempDir, 'active-overleaf.yaml');
    fs.writeFileSync(effectiveConfig, 'effective: config\n');

    const dataDir = path.join(tempDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const storePath = path.join(dataDir, 'manager.db');
    fs.writeFileSync(storePath, '');

    const resolver = createMcpLocationResolver({
      dataDir,
      storePath
    });

    const def = {
      id: 'overleaf-mcp',
      binding: {
        type: 'stdio',
        executable: exePath,
        cwd: pkgDir
      },
      locations: {
        sourceConfigPath: sourceConfig
      },
      provenance: {
        identity: 'source_test_123',
        sourceConfigPath: sourceConfig
      }
    };

    const runtime = {
      state: 'running',
      effectiveConfigPath: effectiveConfig
    };

    const desc = await resolver.describe(def, runtime);

    assert.equal(desc.sourceConfigPath, sourceConfig);
    assert.equal(desc.effectiveConfigPath, effectiveConfig);
    assert.equal(desc.managerStorePath, storePath);
    assert.equal(desc.installationRoot, pkgDir);
    assert.equal(desc.executable, exePath);
    assert.equal(desc.cwd, pkgDir);

    // Verify existence checks
    assert.equal(desc.exists.sourceConfig, true);
    assert.equal(desc.exists.effectiveConfig, true);
    assert.equal(desc.exists.managerStore, true);
    assert.equal(desc.exists.installation, true);
    assert.equal(desc.exists.executable, true);
    assert.equal(desc.exists.cwd, true);

    // Verify manifest detection (reads name/version, never runs npm/python)
    assert.equal(desc.detected.remote, false);
    assert.equal(desc.detected.type, 'stdio');
    assert.equal(desc.detected.package.name, '@example/mcp-pkg');
    assert.equal(desc.detected.package.version, '1.2.3');

    // Provenance preserved
    assert.equal(desc.provenance.identity, 'source_test_123');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('describe handles HTTP remote services and marks installationRoot null', async () => {
  const resolver = createMcpLocationResolver({
    dataDir: 'C:/fake/data',
    storePath: 'C:/fake/data/manager.db'
  });

  const httpDef = {
    id: 'mcp_remote_api',
    binding: {
      type: 'http',
      url: 'https://example.com/sse',
      headers: { Authorization: { value: 'Bearer token', secret: true } }
    },
    locations: {
      sourceConfigPath: 'C:/fake/config.json'
    }
  };

  const desc = await resolver.describe(httpDef, {});
  assert.equal(desc.installationRoot, null);
  assert.equal(desc.executable, null);
  assert.equal(desc.cwd, null);
  assert.equal(desc.detected.remote, true);
  assert.equal(desc.detected.type, 'http');
  assert.equal(desc.exists.installation, false);
});

test('describe marks unknown paths without guessing project root as installation directory', async () => {
  const resolver = createMcpLocationResolver({
    dataDir: 'C:/fake/data'
  });

  const def = {
    id: 'mcp_custom',
    binding: {
      type: 'stdio',
      executable: 'unknown-tool',
      args: []
    }
  };

  const desc = await resolver.describe(def, {});
  assert.equal(desc.installationRoot, 'unknown');
  assert.equal(desc.detected.unknown, true);
  assert.equal(desc.detected.package, null);
});

test('reveal validates roles and rejects invalid role', async () => {
  const resolver = createMcpLocationResolver({});
  const def = { id: 'test', binding: { type: 'http', url: 'http://localhost' } };

  await assert.rejects(
    async () => {
      await resolver.reveal(def, 'arbitraryCommand');
    },
    (err) => {
      assert.equal(err.code, 'INVALID_REVEAL_ROLE');
      assert.equal(err.status, 400);
      return true;
    }
  );
});

test('reveal safely resolves containing directory and calls revealer without executing target file', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-reveal-test-'));

  try {
    const configFile = path.join(tempDir, 'service.yaml');
    fs.writeFileSync(configFile, 'test: true\n');

    let revealedTarget = null;
    const fakeRevealer = async (dirPath) => {
      revealedTarget = dirPath;
    };

    const resolver = createMcpLocationResolver({
      dataDir: tempDir,
      storePath: path.join(tempDir, 'manager.db'),
      revealDirectory: fakeRevealer
    });

    const def = {
      id: 'mcp_test',
      binding: { type: 'stdio', executable: configFile },
      locations: { sourceConfigPath: configFile }
    };

    // Revealing sourceConfig (which is a file) should reveal its CONTAINING DIRECTORY
    const res = await resolver.reveal(def, 'sourceConfig');
    assert.equal(res.success, true);
    assert.equal(res.opened, true);
    assert.equal(res.message, '已请求打开所在目录');
    assert.equal(res.role, 'sourceConfig');
    assert.equal(revealedTarget, fs.realpathSync(tempDir));
    // Must NOT reveal the file directly as a command
    assert.notEqual(revealedTarget, configFile);

    // Revealing unavailable role (e.g. effectiveConfig when not active) throws 404
    await assert.rejects(
      async () => {
        await resolver.reveal(def, 'effectiveConfig', {});
      },
      (err) => {
        assert.equal(err.code, 'PATH_NOT_AVAILABLE');
        assert.equal(err.status, 404);
        return true;
      }
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('reveal rejects dangerous paths: UNC, URLs, device namespaces, and null bytes', async () => {
  const resolver = createMcpLocationResolver({});

  const dangerousCases = [
    { name: 'null byte', path: 'C:/legit/path\0something' },
    { name: 'UNC path', path: '\\\\attacker-server\\share' },
    { name: 'device namespace', path: '\\\\?\\C:\\Windows' },
    { name: 'URL scheme', path: 'file:///etc/passwd' },
    { name: 'HTTP URL', path: 'http://malicious.com' },
    { name: 'DOS device', path: 'C:/data/CON' }
  ];

  for (const { name, path: badPath } of dangerousCases) {
    const def = {
      id: 'mcp_test',
      binding: { type: 'stdio', executable: badPath },
      locations: { sourceConfigPath: badPath }
    };

    await assert.rejects(
      async () => {
        await resolver.reveal(def, 'sourceConfig');
      },
      (err) => {
        assert.equal(err.code, 'INVALID_PATH', `Expected INVALID_PATH for ${name}`);
        assert.equal(err.status, 400);
        return true;
      }
    );
  }
});

test('describe rejects invalid definition input', async () => {
  const resolver = createMcpLocationResolver({});
  await assert.rejects(
    async () => {
      await resolver.describe(null);
    },
    (err) => {
      assert.equal(err.code, 'INVALID_DEFINITION');
      assert.equal(err.status, 400);
      return true;
    }
  );
});

test('reveal handles nonexistent path on disk with 404 PATH_NOT_FOUND', async () => {
  const resolver = createMcpLocationResolver({
    revealDirectory: async () => {}
  });

  const def = {
    id: 'mcp_nonexistent',
    binding: { type: 'stdio', executable: 'C:/totally/missing/tool.exe' },
    locations: { sourceConfigPath: 'C:/totally/missing/config.yaml' }
  };

  await assert.rejects(
    async () => {
      await resolver.reveal(def, 'sourceConfig');
    },
    (err) => {
      assert.equal(err.code, 'PATH_NOT_FOUND');
      assert.equal(err.status, 404);
      return true;
    }
  );
});

test('reveal succeeds with canonical { opened: true, message: "已请求打开所在目录" } across all 6 roles', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-reveal-roles-'));
  try {
    const srcConfig = path.join(tempDir, 'source.yaml');
    fs.writeFileSync(srcConfig, 'k: v\n');

    const effConfig = path.join(tempDir, 'effective.yaml');
    fs.writeFileSync(effConfig, 'k: v\n');

    const installDir = path.join(tempDir, 'install');
    fs.mkdirSync(installDir);

    const exeFile = path.join(tempDir, 'tool.exe');
    fs.writeFileSync(exeFile, 'fake exe\n');

    const workDir = path.join(tempDir, 'work');
    fs.mkdirSync(workDir);

    const storeDb = path.join(tempDir, 'manager.db');
    fs.writeFileSync(storeDb, 'fake db\n');

    let revealed = null;
    const resolver = createMcpLocationResolver({
      dataDir: tempDir,
      storePath: storeDb,
      revealDirectory: async (dir) => { revealed = dir; }
    });

    const def = {
      id: 'mcp_full',
      binding: { type: 'stdio', executable: exeFile, cwd: workDir },
      locations: {
        sourceConfigPath: srcConfig,
        installationRoot: installDir,
        executable: exeFile,
        cwd: workDir
      }
    };
    const runtime = { effectiveConfigPath: effConfig };

    const roles = ['sourceConfig', 'effectiveConfig', 'installation', 'executable', 'workingDirectory', 'managerStore'];
    for (const role of roles) {
      const res = await resolver.reveal(def, role, runtime);
      assert.equal(res.success, true);
      assert.equal(res.opened, true);
      assert.equal(res.message, '已请求打开所在目录');
      assert.equal(res.role, role);
      assert.ok(revealed);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});


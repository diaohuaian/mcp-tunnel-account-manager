import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createMcpDiscovery,
  maskTunnelId,
  isSensitiveName,
  isSensitiveValue,
  tokenizeCommandLine,
  parseRestrictedYaml,
  parseRestrictedDotenv,
  parseRestrictedBat,
  parseRestrictedJson
} from '../src/config/mcp-discovery.mjs';
import { discoveryIdentity } from '../src/core/mcp-registry-policy.mjs';

test('maskTunnelId masks properly without leaking full ID', () => {
  assert.equal(maskTunnelId(null), null);
  assert.equal(maskTunnelId(''), null);
  assert.equal(maskTunnelId('1234'), '****');
  assert.equal(maskTunnelId('123456'), '****');
  assert.equal(maskTunnelId('tunnel-12345'), 'tun...345');
  assert.equal(maskTunnelId('tunnel-super-long-identifier-12345'), 'tunnel-...12345');
});

test('sensitive name and value checkers identify secret patterns', () => {
  assert.equal(isSensitiveName('API_KEY'), true);
  assert.equal(isSensitiveName('AUTH_TOKEN'), true);
  assert.equal(isSensitiveName('USER_PASSWORD'), true);
  assert.equal(isSensitiveName('PORT'), false);
  assert.equal(isSensitiveName('BASE_URL'), false);

  assert.equal(isSensitiveValue('sk-abcdef1234567890'), true);
  assert.equal(isSensitiveValue('--token=mysecret'), true);
  assert.equal(isSensitiveValue('Bearer secret-token'), true);
  assert.equal(isSensitiveValue('--stdio'), false);
  assert.equal(isSensitiveValue('server.js'), false);
});

test('tokenizeCommandLine parses arguments and paths with spaces safely', () => {
  const cmd = 'node "C:/Program Files/My App/index.js" --stdio --port 3000';
  const tokens = tokenizeCommandLine(cmd);
  assert.deepEqual(tokens, [
    'node',
    'C:/Program Files/My App/index.js',
    '--stdio',
    '--port',
    '3000'
  ]);

  assert.deepEqual(tokenizeCommandLine(''), []);
  assert.deepEqual(tokenizeCommandLine('single-command'), ['single-command']);
});

test('parseRestrictedYaml handles valid YAML mappings, sequences, and comments', () => {
  const yaml = `
config_version: 1
control_plane:
  base_url: "https://api.openai.com"
  organization_id: "org-123"
  tunnel_id: "tunnel-test-abc"
  api_key: "env:CONTROL_PLANE_API_KEY"
health:
  listen_addr: "127.0.0.1:0"
mcp:
  commands:
    - channel: main
      command: "node server.js --stdio"
`;
  const { data, warnings } = parseRestrictedYaml(yaml);
  assert.equal(data.config_version, 1);
  assert.equal(data.control_plane.tunnel_id, 'tunnel-test-abc');
  assert.equal(data.control_plane.api_key, 'env:CONTROL_PLANE_API_KEY');
  assert.equal(data.mcp.commands[0].channel, 'main');
  assert.equal(data.mcp.commands[0].command, 'node server.js --stdio');
  assert.equal(warnings.length, 0);
});

test('parseRestrictedYaml rejects prototype pollution, anchors and custom tags', () => {
  const yaml = `
__proto__:
  polluted: true
normal: value
*aliasReference
!customTag
`;
  const { data, warnings } = parseRestrictedYaml(yaml);
  assert.equal(data.normal, 'value');
  assert.equal(Object.prototype.polluted, undefined);
  assert.ok(warnings.some(w => w.includes('anchors') || w.includes('tags') || w.includes('forbidden')));
});

test('parseRestrictedDotenv safely parses key-values and rejects command interpolation', () => {
  const dotenv = `
# Comment
TUNNEL_ID=tunnel-dotenv-123
CONTROL_PLANE_API_KEY="sk-dotenv-secret"
SAFE_PORT=8080 # inline comment
DANGEROUS=$(whoami)
BACKTICK=\`id\`
__proto__=polluted
`;
  const { env, warnings } = parseRestrictedDotenv(dotenv);
  assert.equal(env.TUNNEL_ID, 'tunnel-dotenv-123');
  assert.equal(env.CONTROL_PLANE_API_KEY, 'sk-dotenv-secret');
  assert.equal(env.SAFE_PORT, '8080');
  assert.equal(env.DANGEROUS, undefined);
  assert.equal(env.BACKTICK, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.ok(warnings.some(w => w.includes('interpolation') || w.includes('reserved')));
  // Verify secret values are not echoed in warnings
  for (const w of warnings) {
    assert.equal(w.includes('sk-dotenv-secret'), false);
    assert.equal(w.includes('whoami'), false);
  }
});

test('parseRestrictedBat parses set commands without script execution or command chaining', () => {
  const bat = `
@echo off
rem Setup tunnel
set TUNNEL_ID=tunnel-bat-456
set "CONTROL_PLANE_API_KEY=sk-bat-secret"
set MCP_COMMAND=node C:/path/server.js --stdio
set UNSAFE=val & calc.exe
set WITH_EXPANSION=%USERPROFILE%\\test
`;
  const { env, command, warnings } = parseRestrictedBat(bat);
  assert.equal(env.TUNNEL_ID, 'tunnel-bat-456');
  assert.equal(env.CONTROL_PLANE_API_KEY, 'sk-bat-secret');
  assert.equal(command, 'node C:/path/server.js --stdio');
  assert.equal(env.UNSAFE, undefined);
  assert.equal(env.WITH_EXPANSION, undefined);
  assert.ok(warnings.some(w => w.includes('chaining') || w.includes('variable expansion')));
  // Secrets must never be echoed in warnings
  for (const w of warnings) {
    assert.equal(w.includes('sk-bat-secret'), false);
  }
});

test('parseRestrictedJson parses mcpServers and handles malformed input cleanly', () => {
  const jsonStr = JSON.stringify({
    mcpServers: {
      sqlite: {
        command: 'uvx',
        args: ['mcp-server-sqlite', '--db-path', 'test.db'],
        env: { SQLITE_PATH: 'test.db' }
      },
      remote: {
        url: 'http://127.0.0.1:8080/sse',
        headers: { Authorization: 'Bearer test-token' }
      }
    }
  });

  const { data, warnings } = parseRestrictedJson(jsonStr);
  assert.ok(data.mcpServers.sqlite);
  assert.ok(data.mcpServers.remote);
  assert.equal(warnings.length, 0);

  const invalid = parseRestrictedJson('{ invalid json: true');
  assert.equal(invalid.data, null);
  assert.ok(invalid.warnings.length > 0);
});

test('createMcpDiscovery performs no constructor I/O', () => {
  let ioTriggered = false;
  createMcpDiscovery({
    sources: ['dummy-path.yaml'],
    readFile: async () => { ioTriggered = true; return ''; },
    stat: async () => { ioTriggered = true; return {}; }
  });
  assert.equal(ioTriggered, false);
});

test('scan with synthetic fixtures returns safe candidate DTOs without leaking secrets', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-disc-test-'));

  try {
    const yamlPath = path.join(tempDir, 'overleaf.yaml');
    const envPath = path.join(tempDir, 'tunnel.env');
    const jsonPath = path.join(tempDir, 'claude_config.json');

    // Companion dotenv file
    fs.writeFileSync(envPath, 'CONTROL_PLANE_API_KEY=sk-super-secret-key-12345\n');

    // Overleaf YAML referencing companion dotenv
    fs.writeFileSync(yamlPath, `
config_version: 1
control_plane:
  tunnel_id: "tun-synthetic-123456789"
  api_key: "env:CONTROL_PLANE_API_KEY"
mcp:
  commands:
    - channel: main
      command: "node C:/server/index.js --stdio --secret-arg=sk-inline-secret"
`);

    // MCP JSON config
    fs.writeFileSync(jsonPath, JSON.stringify({
      mcpServers: {
        sqlite: {
          command: 'uvx',
          args: ['mcp-server-sqlite', '--db', 'test.db'],
          env: { DB_SECRET_KEY: 'topsecret' }
        },
        cloud: {
          url: 'http://127.0.0.1:3000/sse',
          headers: { 'X-Api-Key': 'secret-cloud-key' }
        }
      }
    }));

    const discovery = createMcpDiscovery({
      sources: [
        { path: envPath, kind: 'dotenv' },
        { path: yamlPath, kind: 'yaml', serviceId: 'overleaf-mcp' },
        { path: jsonPath, kind: 'json' }
      ]
    });

    const candidates = await discovery.scan();
    assert.ok(Array.isArray(candidates));
    assert.ok(candidates.length >= 3);

    // Verify Overleaf candidate
    const overleaf = candidates.find(c => c.serviceId === 'overleaf-mcp');
    assert.ok(overleaf);
    assert.equal(overleaf.label, 'Overleaf MCP');
    assert.equal(overleaf.sourceKind, 'yaml');
    assert.ok(overleaf.fingerprint);
    assert.equal(overleaf.credentialStatus.hasApiKey, true);
    assert.equal(overleaf.credentialStatus.hasTunnelId, true);
    assert.equal(overleaf.credentialStatus.configured, true);
    // FULL tunnelId and raw apiKey must NOT be in public DTO
    assert.equal(overleaf.credentialStatus.maskedTunnelId.includes('tun-synthetic-123456789'), false);
    assert.equal(JSON.stringify(overleaf).includes('sk-super-secret-key-12345'), false);
    assert.equal(JSON.stringify(overleaf).includes('sk-inline-secret'), false);

    // Verify args in public binding: sensitive arg masked
    const secretArg = overleaf.binding.args.find(a => a.secret);
    assert.ok(secretArg);
    assert.equal(secretArg.configured, true);
    assert.equal(secretArg.value, undefined);

    const normalArg = overleaf.binding.args.find(a => a.value === '--stdio');
    assert.ok(normalArg);
    assert.equal(normalArg.secret, false);

    // Verify JSON candidates
    const sqlite = candidates.find(c => c.selector === 'sqlite');
    assert.ok(sqlite);
    assert.match(sqlite.serviceId, /^mcp_[a-z0-9]+/);
    assert.equal(sqlite.binding.type, 'stdio');
    assert.equal(sqlite.binding.executable, 'uvx');
    // Environment secret not exposed in candidate DTO
    assert.equal(JSON.stringify(sqlite).includes('topsecret'), false);

    const cloud = candidates.find(c => c.selector === 'cloud');
    assert.ok(cloud);
    assert.equal(cloud.binding.type, 'http');
    assert.equal(cloud.binding.url, 'http://127.0.0.1:3000/sse');
    assert.equal(cloud.binding.headers['X-Api-Key'].secret, true);
    assert.equal(cloud.binding.headers['X-Api-Key'].value, undefined);

    // Verify stable discoveryIdentity
    const expectedId = discoveryIdentity({
      serviceId: overleaf.serviceId,
      canonicalPath: fs.realpathSync(yamlPath),
      selector: 'main'
    });
    assert.equal(overleaf.id, expectedId);

  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('loadCandidate returns internal definition with credentials and reverifies CAS fingerprint', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cas-test-'));

  try {
    const yamlPath = path.join(tempDir, 'overleaf.yaml');
    const envPath = path.join(tempDir, 'tunnel.env');

    fs.writeFileSync(envPath, 'CONTROL_PLANE_API_KEY=sk-actual-secret\n');
    fs.writeFileSync(yamlPath, `
config_version: 1
control_plane:
  tunnel_id: "tun-actual-id-999"
  api_key: "env:CONTROL_PLANE_API_KEY"
mcp:
  commands:
    - channel: main
      command: "node index.js --stdio --api-key=sk-inner-secret"
`);

    const discovery = createMcpDiscovery({
      sources: [
        { path: envPath, kind: 'dotenv' },
        { path: yamlPath, kind: 'yaml', serviceId: 'overleaf-mcp' }
      ]
    });

    const candidates = await discovery.scan();
    const overleaf = candidates.find(c => c.serviceId === 'overleaf-mcp');
    assert.ok(overleaf);

    // Load with matching expectedFingerprint
    const loaded = await discovery.loadCandidate(overleaf.id, {
      expectedFingerprint: overleaf.fingerprint
    });

    assert.ok(loaded.candidate);
    assert.ok(loaded.definition);
    assert.ok(loaded.profileInput);
    assert.ok(loaded.provenance);

    // Internal definition has real args and values
    assert.equal(loaded.definition.id, 'overleaf-mcp');
    const secretArg = loaded.definition.binding.args.find(a => a.secret);
    assert.ok(secretArg);
    assert.equal(secretArg.value, '--api-key=sk-inner-secret');

    // Profile input has resolved credentials for store use
    assert.equal(loaded.profileInput.services['overleaf-mcp'].tunnelId, 'tun-actual-id-999');
    assert.equal(loaded.profileInput.services['overleaf-mcp'].apiKey, 'sk-actual-secret');

    // Provenance is recorded
    assert.equal(loaded.provenance.identity, overleaf.id);
    assert.equal(loaded.provenance.sourceKind, 'yaml');

    // CAS DRIFT TEST: Modify file on disk and verify 409 SOURCE_CHANGED
    fs.writeFileSync(yamlPath, `
config_version: 1
control_plane:
  tunnel_id: "tun-MODIFIED-id-888"
  api_key: "env:CONTROL_PLANE_API_KEY"
mcp:
  commands:
    - channel: main
      command: "node index.js --stdio"
`);

    await assert.rejects(
      async () => {
        await discovery.loadCandidate(overleaf.id, {
          expectedFingerprint: overleaf.fingerprint // stale fingerprint
        });
      },
      (err) => {
        assert.equal(err.code, 'SOURCE_CHANGED');
        assert.equal(err.status, 409);
        return true;
      }
    );

    // Nonexistent candidate ID throws 404
    await assert.rejects(
      async () => {
        await discovery.loadCandidate('source_nonexistent_id');
      },
      (err) => {
        assert.equal(err.code, 'CANDIDATE_NOT_FOUND');
        assert.equal(err.status, 404);
        return true;
      }
    );

  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('duplicate sources do not create duplicate candidates or overwrite identities', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-dedup-test-'));

  try {
    const yamlPath = path.join(tempDir, 'test.yaml');
    fs.writeFileSync(yamlPath, `
config_version: 1
control_plane:
  tunnel_id: "tun-dedup"
  api_key: "test-key"
mcp:
  commands:
    - channel: main
      command: "node server.js"
`);

    const discovery = createMcpDiscovery({
      sources: [
        { path: yamlPath, kind: 'yaml', serviceId: 'antigravity-mcp' },
        { path: yamlPath, kind: 'yaml', serviceId: 'antigravity-mcp' }
      ]
    });

    const candidates = await discovery.scan();
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].serviceId, 'antigravity-mcp');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('BAT file source is safely scanned and produces valid candidate', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bat-test-'));

  try {
    const batPath = path.join(tempDir, 'start-overleaf-tunnel.bat');
    fs.writeFileSync(batPath, `
@echo off
set TUNNEL_ID=tunnel-bat-789
set CONTROL_PLANE_API_KEY=sk-bat-secret-key
set MCP_COMMAND=node C:/Users/test/server.js --stdio
start-tunnel.exe
`);

    const discovery = createMcpDiscovery({
      sources: [
        { path: batPath, kind: 'bat', serviceId: 'overleaf-mcp' }
      ]
    });

    const candidates = await discovery.scan();
    assert.equal(candidates.length, 1);
    const c = candidates[0];
    assert.equal(c.serviceId, 'overleaf-mcp');
    assert.equal(c.sourceKind, 'bat');
    assert.equal(c.credentialStatus.hasTunnelId, true);
    assert.equal(c.credentialStatus.hasApiKey, true);
    assert.equal(c.credentialStatus.maskedTunnelId.includes('tunnel-bat-789'), false);
    assert.equal(c.binding.type, 'stdio');
    assert.equal(c.binding.executable, 'node');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('sources exceeding maxBytes or missing on disk are gracefully handled', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-maxbytes-test-'));

  try {
    const largeYaml = path.join(tempDir, 'large.yaml');
    // Write 5KB file with maxBytes set to 1KB
    fs.writeFileSync(largeYaml, 'config_version: 1\n# ' + 'x'.repeat(5000) + '\n');

    const missingPath = path.join(tempDir, 'does-not-exist.yaml');

    const discovery = createMcpDiscovery({
      sources: [
        { path: largeYaml, kind: 'yaml' },
        { path: missingPath, kind: 'yaml' }
      ],
      maxBytes: 1024 // 1 KB
    });

    const candidates = await discovery.scan();
    assert.equal(candidates.length, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('HTTP candidate with private query redacts raw URL in preview DTO and preserves in loaded definition', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-http-discovery-test-'));

  try {
    const jsonPath = path.join(tempDir, 'mcp.json');
    fs.writeFileSync(jsonPath, JSON.stringify({
      mcpServers: {
        secureRemote: {
          url: 'https://remote.example.com/api/v1?token=super-secret-token&region=us-east',
          headers: {
            'Authorization': 'Bearer test-bearer-key',
            'X-Public-Flag': 'enabled'
          }
        }
      }
    }));

    const discovery = createMcpDiscovery({
      sources: [{ path: jsonPath, kind: 'json' }]
    });

    const candidates = await discovery.scan();
    assert.equal(candidates.length, 1);
    const candidate = candidates[0];

    // Candidate public DTO redacts private query and masks secrets
    assert.equal(candidate.binding.type, 'http');
    assert.equal(candidate.binding.url, undefined); // raw url omitted
    assert.equal(candidate.binding.urlDisplay, 'https://remote.example.com/api/v1');
    assert.equal(candidate.binding.urlConfigured, true);
    assert.equal(candidate.binding.hasPrivateQuery, true);

    // Public headers: Authorization masked, X-Public-Flag visible
    assert.deepEqual(candidate.binding.headers['Authorization'], { secret: true, configured: true });
    assert.deepEqual(candidate.binding.headers['X-Public-Flag'], { secret: false, configured: true, value: 'enabled' });

    // loadCandidate recovers internal definition with original private URL
    const loaded = await discovery.loadCandidate(candidate.id, {
      expectedFingerprint: candidate.fingerprint
    });
    assert.equal(loaded.definition.binding.type, 'http');
    assert.equal(loaded.definition.binding.url, 'https://remote.example.com/api/v1?token=super-secret-token&region=us-east');
    assert.equal(loaded.definition.binding.headers['Authorization'].value, 'Bearer test-bearer-key');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});


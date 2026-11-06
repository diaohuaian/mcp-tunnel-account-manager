import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  classifyTxtConfig,
  parseLiteralTxtConfig,
  readableConfigFilename,
  privateConfigFingerprint
} from '../src/config/txt-config-core.mjs';

test('strict literal KV and Chinese labels parse correctly', () => {
  const content = [
    '服务名称=测试服务',
    '服务标识=svc-synthetic-1',
    '账号名=测试账号',
    '隧道ID=tun-synthetic-100',
    'API密钥=key-synthetic-sec-1',
    '组织ID=org-synthetic-200',
    '传输类型=sse',
    '服务地址=http://127.0.0.1:8080/sse',
    '可执行程序=node',
    '工作目录=C:\\MCP',
    '启动参数=["--port", "8080"]'
  ].join('\n');

  const res = parseLiteralTxtConfig(content);
  assert.equal(res.format, 'literal');
  assert.equal(res.delegate, false);
  assert.equal(res.blocks.length, 1);
  const block = res.blocks[0];
  assert.equal(block.syntaxReady, true);
  assert.equal(block.values.serviceName, '测试服务');
  assert.equal(block.values.serviceId, 'svc-synthetic-1');
  assert.equal(block.values.profileName, '测试账号');
  assert.equal(block.values.tunnelId, 'tun-synthetic-100');
  assert.equal(block.values.apiKey, 'key-synthetic-sec-1');
  assert.equal(block.values.organizationId, 'org-synthetic-200');
  assert.equal(block.values.transport, 'sse');
  assert.equal(block.values.url, 'http://127.0.0.1:8080/sse');
  assert.equal(block.values.command, 'node');
  assert.equal(block.values.cwd, 'C:\\MCP');
  assert.deepEqual(block.values.args, ['--port', '8080']);
  assert.equal(block.issues.length, 0);
});

test('CRLF and UTF-8 BOM are stripped and normalized', () => {
  const bomCrlf = '\uFEFFTUNNEL_ID=tun-bom-1\r\nAPI_KEY=key-bom-1\r\n';
  const res = parseLiteralTxtConfig(bomCrlf);
  assert.equal(res.format, 'literal');
  assert.equal(res.blocks.length, 1);
  assert.equal(res.blocks[0].syntaxReady, true);
  assert.equal(res.blocks[0].values.tunnelId, 'tun-bom-1');
  assert.equal(res.blocks[0].values.apiKey, 'key-bom-1');
});

test('sections separate two profiles and validate required keys independently', () => {
  const iniContent = [
    '# Profile 1',
    '[profile-primary]',
    'SERVICE_ID=svc-1',
    'TUNNEL_ID=tun-1',
    'API_KEY=key-1',
    '',
    '; Profile 2',
    '[profile-secondary]',
    'SERVICE_ID=svc-2',
    'TUNNEL_ID=tun-2',
    'API_KEY=key-2'
  ].join('\n');

  const res = parseLiteralTxtConfig(iniContent);
  assert.equal(res.blocks.length, 2);
  assert.equal(res.blocks[0].section, 'profile-primary');
  assert.equal(res.blocks[0].values.tunnelId, 'tun-1');
  assert.equal(res.blocks[0].syntaxReady, true);

  assert.equal(res.blocks[1].section, 'profile-secondary');
  assert.equal(res.blocks[1].values.tunnelId, 'tun-2');
  assert.equal(res.blocks[1].syntaxReady, true);
});

test('duplicate keys with identical value are ignored, conflicting values push DUPLICATE_KEY_CONFLICT', () => {
  const content = [
    'TUNNEL_ID=tun-dup-1',
    'API_KEY=key-dup-1',
    'TUNNEL_ID=tun-dup-1',
    'API_KEY=key-dup-CONFLICT'
  ].join('\n');

  const res = parseLiteralTxtConfig(content);
  assert.equal(res.blocks.length, 1);
  const block = res.blocks[0];
  assert.equal(block.values.tunnelId, 'tun-dup-1');
  assert.equal(block.values.apiKey, 'key-dup-1');
  assert.equal(block.syntaxReady, false);
  assert.ok(block.issues.some(i => i.code === 'DUPLICATE_KEY_CONFLICT' && i.field === 'apiKey'));
});

test('dynamic and interactive inputs are flagged and require review', () => {
  const dynamicValues = [
    'TUNNEL_ID=tun-dyn-1\nAPI_KEY=$(cat /etc/secret)',
    'TUNNEL_ID=tun-dyn-2\nAPI_KEY=${SECRET_KEY}',
    'TUNNEL_ID=tun-dyn-3\nAPI_KEY=%SECRET_KEY%',
    'TUNNEL_ID=tun-dyn-4\nAPI_KEY=!SECRET_KEY!',
    'TUNNEL_ID=tun-dyn-5\nAPI_KEY=`cat secret`',
    'TUNNEL_ID=tun-dyn-6\nAPI_KEY=$SECRET_KEY'
  ];

  for (const text of dynamicValues) {
    const res = parseLiteralTxtConfig(text);
    assert.ok(res.blocks[0].issues.some(i => i.code === 'DYNAMIC_VALUE_REQUIRES_REVIEW'), `Failed for ${text}`);
  }

  const batInteractive = '@set /p TUNNEL_ID=Enter Tunnel ID\nset API_KEY=key-1';
  const resBat = parseLiteralTxtConfig(batInteractive);
  assert.ok(resBat.blocks[0].issues.some(i => i.code === 'NON_LITERAL_ASSIGNMENT'));
});

test('placeholder values trigger PLACEHOLDER_VALUE issue', () => {
  const placeholders = [
    'TUNNEL_ID=<your-tunnel-id>\nAPI_KEY=key-1',
    'TUNNEL_ID=tun-1\nAPI_KEY=xxxxxx',
    'TUNNEL_ID=tun-1\nAPI_KEY=your-api-key-here',
    'TUNNEL_ID=tun-1\nAPI_KEY=example_key',
    'TUNNEL_ID=tun-1\nAPI_KEY=示例密钥',
    'TUNNEL_ID=tun-1\nAPI_KEY=请填写控制密钥',
    'TUNNEL_ID=tun-1\nAPI_KEY=待填写'
  ];

  for (const text of placeholders) {
    const res = parseLiteralTxtConfig(text);
    assert.ok(res.blocks[0].issues.some(i => i.code === 'PLACEHOLDER_VALUE'), `Failed for ${text}`);
  }
});

test('unknown fields and malformed unrecognized lines are tracked as issues', () => {
  const content = [
    'TUNNEL_ID=tun-1',
    'API_KEY=key-1',
    'UNKNOWN_CONFIG_VARIABLE=hello',
    'NOT A VALID KEY VALUE LINE AT ALL !!!'
  ].join('\n');

  const res = parseLiteralTxtConfig(content);
  assert.equal(res.blocks.length, 1);
  const issues = res.blocks[0].issues;
  assert.ok(issues.some(i => i.code === 'UNKNOWN_FIELD' && i.line === 3));
  assert.ok(issues.some(i => i.code === 'UNRECOGNIZED_LINE' && i.line === 4));
});

test('JSON, YAML, code fences, and empty files are correctly classified and delegated', () => {
  const jsonText = '{\n  "mcpServers": { "srv": { "command": "npx" } }\n}';
  const jsonRes = parseLiteralTxtConfig(jsonText);
  assert.equal(jsonRes.format, 'json');
  assert.equal(jsonRes.delegate, true);
  assert.equal(jsonRes.blocks.length, 0);

  const yamlText = 'mcpServers:\n  srv:\n    command: npx\n';
  const yamlRes = parseLiteralTxtConfig(yamlText);
  assert.equal(yamlRes.format, 'yaml');
  assert.equal(yamlRes.delegate, true);
  assert.equal(yamlRes.blocks.length, 0);

  const fenceText = '```bash\nexport TUNNEL_ID=tun-1\n```';
  const fenceRes = parseLiteralTxtConfig(fenceText);
  assert.equal(fenceRes.format, 'review');
  assert.equal(fenceRes.delegate, false);
  assert.ok(fenceRes.issues.some(i => i.code === 'CODE_FENCE_REQUIRES_REVIEW'));

  const emptyRes = parseLiteralTxtConfig('   \n  \r\n  ');
  assert.equal(emptyRes.format, 'empty');
  assert.ok(emptyRes.issues.some(i => i.code === 'EMPTY_FILE'));
});

test('safe URL and args are validated and invalid protocols/formats rejected', () => {
  const valid = 'TUNNEL_ID=t1\nAPI_KEY=k1\nMCP_SERVER_URL=https://mcp.internal:8443/sse\nMCP_SERVER_ARGS=["--verbose", "--port", "3000"]';
  const rValid = parseLiteralTxtConfig(valid);
  assert.equal(rValid.blocks[0].syntaxReady, true);
  assert.equal(rValid.blocks[0].values.url, 'https://mcp.internal:8443/sse');
  assert.deepEqual(rValid.blocks[0].values.args, ['--verbose', '--port', '3000']);

  const invalidUrl1 = 'TUNNEL_ID=t1\nAPI_KEY=k1\nMCP_SERVER_URL=ftp://evil.com/mcp';
  const rUrl1 = parseLiteralTxtConfig(invalidUrl1);
  assert.ok(rUrl1.blocks[0].issues.some(i => i.code === 'INVALID_HTTP_URL'));

  const invalidUrl2 = 'TUNNEL_ID=t1\nAPI_KEY=k1\nMCP_SERVER_URL=http://user:pass@evil.com/mcp';
  const rUrl2 = parseLiteralTxtConfig(invalidUrl2);
  assert.ok(rUrl2.blocks[0].issues.some(i => i.code === 'INVALID_HTTP_URL'));

  const invalidArgs1 = 'TUNNEL_ID=t1\nAPI_KEY=k1\nMCP_SERVER_ARGS=--raw-argument-string';
  const rArgs1 = parseLiteralTxtConfig(invalidArgs1);
  assert.ok(rArgs1.blocks[0].issues.some(i => i.code === 'ARGS_REQUIRE_JSON_ARRAY'));

  const invalidArgs2 = 'TUNNEL_ID=t1\nAPI_KEY=k1\nMCP_SERVER_ARGS=[1, 2, 3]';
  const rArgs2 = parseLiteralTxtConfig(invalidArgs2);
  assert.ok(rArgs2.blocks[0].issues.some(i => i.code === 'ARGS_REQUIRE_JSON_ARRAY'));
});

test('readableConfigFilename sanitizes Windows traversals, escapes reserved device names, and validates collisions', () => {
  const name1 = readableConfigFilename({ serviceName: 'Overleaf', profileName: '个人账号' });
  assert.equal(name1, 'Overleaf__个人账号__tunnel-client.yaml');

  const name2 = readableConfigFilename({ serviceName: 'CON', profileName: 'AUX' });
  assert.equal(name2, '配置-CON__配置-AUX__tunnel-client.yaml');

  const nameNul = readableConfigFilename({ serviceName: 'nul', profileName: 'prn.txt' });
  assert.equal(nameNul, '配置-nul__配置-prn.txt__tunnel-client.yaml');

  const nameTraversal = readableConfigFilename({
    serviceName: '../../evil/path/../<script>',
    profileName: 'bad:name|with?*stars'
  });
  assert.ok(!nameTraversal.includes('/'));
  assert.ok(!nameTraversal.includes('\\'));
  assert.ok(!nameTraversal.includes('<'));
  assert.ok(!nameTraversal.includes('>'));
  assert.ok(!nameTraversal.includes(':'));
  assert.ok(!nameTraversal.includes('*'));
  assert.ok(!nameTraversal.includes('?'));

  const nameCollision = readableConfigFilename({
    serviceName: 'Antigravity',
    profileName: 'Work',
    collisionId: 'ab12-cd34'
  });
  assert.equal(nameCollision, 'Antigravity__Work__tunnel-client__ab12-cd34.yaml');

  assert.throws(() => {
    readableConfigFilename({ serviceName: 'A', profileName: 'B', collisionId: 'bad!@#' });
  }, { code: 'INVALID_COLLISION_ID' });

  assert.throws(() => {
    readableConfigFilename({ serviceName: 'A', profileName: 'B', extension: 'sh' });
  }, { code: 'UNSUPPORTED_EXTENSION' });
});

test('privateConfigFingerprint is stable regardless of candidate property insertion order', () => {
  const hmacKey = crypto.randomBytes(32);
  const candA = {
    serviceId: 'svc-alpha',
    profileName: 'prof-one',
    tunnelId: 'tun-1234',
    apiKey: 'sec-secret-token-1',
    organizationId: 'org-42',
    transport: 'sse',
    url: 'https://mcp.internal:8000/sse',
    args: ['--debug', '--verbose']
  };

  const candB = {
    args: ['--debug', '--verbose'],
    url: 'https://mcp.internal:8000/sse',
    transport: 'sse',
    organizationId: 'org-42',
    apiKey: 'sec-secret-token-1',
    tunnelId: 'tun-1234',
    profileName: 'prof-one',
    serviceId: 'svc-alpha'
  };

  const fpA = privateConfigFingerprint(candA, hmacKey);
  const fpB = privateConfigFingerprint(candB, hmacKey);
  assert.equal(typeof fpA, 'string');
  assert.equal(fpA.length, 64);
  assert.equal(fpA, fpB);
});

test('changed secret produces distinct private identity and HMAC key requirement is strictly enforced', () => {
  const hmacKey = crypto.randomBytes(32);
  const candA = { tunnelId: 'tun-1', apiKey: 'secret-key-A' };
  const candB = { tunnelId: 'tun-1', apiKey: 'secret-key-B' };

  const fpA = privateConfigFingerprint(candA, hmacKey);
  const fpB = privateConfigFingerprint(candB, hmacKey);
  assert.notEqual(fpA, fpB);

  assert.throws(() => {
    privateConfigFingerprint(candA, crypto.randomBytes(16));
  }, { code: 'PRIVATE_FINGERPRINT_KEY_REQUIRED' });

  assert.throws(() => {
    privateConfigFingerprint(candA, 'not-a-buffer-key');
  }, { code: 'PRIVATE_FINGERPRINT_KEY_REQUIRED' });
});

test('forbidden prototype keys and non-plain prototype objects are rejected', () => {
  const hmacKey = crypto.randomBytes(32);

  const candWithProto = {
    tunnelId: 'tun-1',
    apiKey: 'sec-1',
    headers: JSON.parse('{"__proto__": "polluted", "x-token": "123"}')
  };
  assert.throws(() => {
    privateConfigFingerprint(candWithProto, hmacKey);
  }, { code: 'INVALID_IDENTITY_KEYS' });

  const candWithConstructor = {
    tunnelId: 'tun-1',
    apiKey: 'sec-1',
    headers: { constructor: 'polluted' }
  };
  assert.throws(() => {
    privateConfigFingerprint(candWithConstructor, hmacKey);
  }, { code: 'INVALID_IDENTITY_KEYS' });

  const candWithClass = {
    tunnelId: 'tun-1',
    apiKey: 'sec-1',
    headers: new Date()
  };
  assert.throws(() => {
    privateConfigFingerprint(candWithClass, hmacKey);
  }, { code: 'INVALID_IDENTITY_VALUE' });
});

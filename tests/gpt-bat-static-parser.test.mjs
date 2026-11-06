import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  parseRestrictedBat,
  parseBatVariables,
  createMcpDiscovery,
  maskTunnelId
} from '../src/config/mcp-discovery.mjs';

test('parseRestrictedBat handles quoted and unquoted literal static set with CRLF and case/@ variants', () => {
  // Uses synthetic literals, CRLF line endings, and optional @ / case variants
  const batScript = [
    '@echo off\r\n',
    'rem Synthetic BAT parser test fixture\r\n',
    ':: Another comment syntax\r\n',
    '@rem Another rem syntax\r\n',
    '@set "TUNNEL_ID=tun-synth-literal-12345"\r\n',
    'set "CONTROL_PLANE_API_KEY=sk-synthetic-bat-secret-abc"\r\n',
    'SET "ORGANIZATION_ID=org-synth-unit-001"\r\n',
    'Set "QUOTED_EMPTY="\r\n',
    'sEt "QUOTED_SPACES=value with spaces preserved"\r\n',
    '@SET UNQUOTED_KEY=literal_unquoted_val\r\n',
    'set UNQUOTED_SIMPLE=simple123\r\n',
    'SEt UNQUOTED_CASE=case_variant_val\r\n',
    'set MCP_COMMAND=node C:/path/to/server.js --stdio\r\n'
  ].join('');

  const { env, command, warnings } = parseRestrictedBat(batScript);

  assert.equal(env.TUNNEL_ID, 'tun-synth-literal-12345');
  assert.equal(env.CONTROL_PLANE_API_KEY, 'sk-synthetic-bat-secret-abc');
  assert.equal(env.ORGANIZATION_ID, 'org-synth-unit-001');
  assert.equal(env.QUOTED_EMPTY, '');
  assert.equal(env.QUOTED_SPACES, 'value with spaces preserved');
  assert.equal(env.UNQUOTED_KEY, 'literal_unquoted_val');
  assert.equal(env.UNQUOTED_SIMPLE, 'simple123');
  assert.equal(env.UNQUOTED_CASE, 'case_variant_val');
  assert.equal(command, 'node C:/path/to/server.js --stdio');
  assert.deepEqual(warnings, []);

  // Also verify alias export parseBatVariables behaves identically
  const aliasResult = parseBatVariables(batScript);
  assert.deepEqual(aliasResult.env, env);
  assert.equal(aliasResult.command, command);
  assert.deepEqual(aliasResult.warnings, warnings);
});

test('interactive set /p "TUNNEL_ID=Enter tunnel:" safely skips without credential extraction or invalid-name warning', () => {
  const batScript = [
    '@echo off',
    'set /p "TUNNEL_ID=Enter tunnel ID:"',
    '@set /p "CONTROL_PLANE_API_KEY=Enter API Key:"',
    'SET /P PROMPT_NAME=Please enter your name:',
    '@SET /p "SECRET_TOKEN=Input token:"',
    'set /p PLAIN_PROMPT=Enter value: ',
    'set SAFE_STATIC=static_extracted_val'
  ].join('\r\n');

  const { env, warnings } = parseRestrictedBat(batScript);

  // Credential and interactive prompt variables must NOT be extracted
  assert.equal(env.TUNNEL_ID, undefined);
  assert.equal(env.CONTROL_PLANE_API_KEY, undefined);
  assert.equal(env.PROMPT_NAME, undefined);
  assert.equal(env.SECRET_TOKEN, undefined);
  assert.equal(env.PLAIN_PROMPT, undefined);

  // Normal static variable should still be extracted
  assert.equal(env.SAFE_STATIC, 'static_extracted_val');

  // No warnings generated for set /p (no invalid-name warning)
  assert.deepEqual(warnings, []);
});

test('set /a COUNT=1+2 is safely skipped without invalid-name warning', () => {
  const batScript = [
    '@echo off',
    'set /a COUNT=1+2',
    '@set /a TOTAL=10*5',
    'SET /A INDEX=0',
    '@SET /a OFFSET=COUNT+1',
    'set /A "EXPR=1 + 2"',
    'set STATIC_FLAG=true'
  ].join('\r\n');

  const { env, warnings } = parseRestrictedBat(batScript);

  // Mathematical arithmetic variables must NOT be extracted
  assert.equal(env.COUNT, undefined);
  assert.equal(env.TOTAL, undefined);
  assert.equal(env.INDEX, undefined);
  assert.equal(env.OFFSET, undefined);
  assert.equal(env.EXPR, undefined);

  // Normal static variable should be extracted
  assert.equal(env.STATIC_FLAG, 'true');

  // No warnings generated for set /a (no invalid-name warning)
  assert.deepEqual(warnings, []);
});

test('%%A key safely skipped without warning', () => {
  const batScript = [
    '@echo off',
    'set %%A=skipped_loop_val',
    '@set %%i=index_val',
    'set "%%B=quoted_loop_val"',
    'SET %%var=something',
    '@SET "%%x=test"',
    'set VALID_VAR=valid_val'
  ].join('\r\n');

  const { env, warnings } = parseRestrictedBat(batScript);

  // Loop variable references must be safely skipped
  assert.equal(env['%%A'], undefined);
  assert.equal(env['%%i'], undefined);
  assert.equal(env['%%B'], undefined);
  assert.equal(env['%%var'], undefined);
  assert.equal(env['%%x'], undefined);

  // Legitimate variable is still extracted
  assert.equal(env.VALID_VAR, 'valid_val');

  // Loop variable %% keys must not trigger invalid-name warning
  assert.deepEqual(warnings, []);
});

test('dynamic values remain unresolved and generate warnings without leaking secrets', () => {
  const batScript = [
    '@echo off',
    'set DYNAMIC_USER=%USERPROFILE%\\app',
    'set DYNAMIC_SECRET=%SECRET_API_KEY%_token',
    'set CHAINED_CMD=initial_val & calc.exe',
    'set PIPED_VAL=stream_val | more',
    'set REDIRECT_VAL=data > out.txt',
    'set INPUT_VAL=input < in.txt',
    'set SEMICOLON_VAL=item1;item2',
    'set STATIC_CLEAN=clean_literal'
  ].join('\r\n');

  const { env, warnings } = parseRestrictedBat(batScript);

  // Dynamic / chained values must remain unresolved
  assert.equal(env.DYNAMIC_USER, undefined);
  assert.equal(env.DYNAMIC_SECRET, undefined);
  assert.equal(env.CHAINED_CMD, undefined);
  assert.equal(env.PIPED_VAL, undefined);
  assert.equal(env.REDIRECT_VAL, undefined);
  assert.equal(env.INPUT_VAL, undefined);
  assert.equal(env.SEMICOLON_VAL, undefined);

  // Clean static variable must be parsed
  assert.equal(env.STATIC_CLEAN, 'clean_literal');

  // Warnings must be emitted for each skipped dynamic line
  assert.ok(warnings.length >= 7);
  assert.ok(warnings.some(w => w.includes('DYNAMIC_USER')));
  assert.ok(warnings.some(w => w.includes('DYNAMIC_SECRET')));
  assert.ok(warnings.some(w => w.includes('CHAINED_CMD')));
  assert.ok(warnings.some(w => w.includes('PIPED_VAL')));
  assert.ok(warnings.some(w => w.includes('REDIRECT_VAL')));
  assert.ok(warnings.some(w => w.includes('INPUT_VAL')));
  assert.ok(warnings.some(w => w.includes('SEMICOLON_VAL')));

  // Crucially, secrets and sensitive payloads must NEVER leak into warnings
  for (const w of warnings) {
    assert.equal(w.includes('SECRET_API_KEY'), false);
    assert.equal(w.includes('calc.exe'), false);
    assert.equal(w.includes('USERPROFILE'), false);
  }
});

test('malformed static BAD-NAME and reserved property names still warn', () => {
  const batScript = [
    '@echo off',
    'set BAD-NAME=hyphenated_value',
    'set 123NUMBER=starting_with_digit',
    'set BAD.NAME=dotted_value',
    'set "BAD NAME=spaced_value"',
    'set __proto__=poison_proto',
    'set CONSTRUCTOR=poison_constructor',
    'set PROTOTYPE=poison_prototype',
    'set VALID_NAME=good_value'
  ].join('\r\n');

  const { env, warnings } = parseRestrictedBat(batScript);

  // Malformed and reserved names must not be assigned
  assert.equal(env['BAD-NAME'], undefined);
  assert.equal(env['123NUMBER'], undefined);
  assert.equal(env['BAD.NAME'], undefined);
  assert.equal(env['BAD NAME'], undefined);
  assert.equal(env.__proto__, undefined);
  assert.equal(env.CONSTRUCTOR, undefined);
  assert.equal(env.PROTOTYPE, undefined);
  assert.equal(Object.getPrototypeOf(env), null);
  assert.equal(env.VALID_NAME, 'good_value');

  // Verify invalid-name warnings
  assert.ok(warnings.some(w => w.includes('Ignored invalid variable name')));
  assert.ok(warnings.some(w => w.includes('Ignored reserved property name: __proto__')));
  assert.ok(warnings.some(w => w.includes('Ignored reserved property name: CONSTRUCTOR')));
  assert.ok(warnings.some(w => w.includes('Ignored reserved property name: PROTOTYPE')));
});

test('static credentials produce only masked DTO fields in isolated fixture without executing BAT', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-bat-parser-test-'));

  try {
    const batPath = path.join(tempDir, 'start-synthetic-tunnel.bat');
    const canaryPath = path.join(tempDir, 'canary-executed.txt');

    // Synthetic BAT fixture with canary command that MUST NOT be executed
    const syntheticBatContent = [
      '@echo off',
      'rem Isolated synthetic test fixture - static analysis only',
      `echo CANARY_EXECUTED > "${canaryPath}"`,
      'set TUNNEL_ID=tun-synth-live-9876543210',
      'set CONTROL_PLANE_API_KEY=sk-synthetic-live-secret-99999',
      'set ORGANIZATION_ID=org-synth-enterprise-1234',
      'set MCP_COMMAND=node C:/synthetic/server.js --token sk-synthetic-live-secret-99999 --port 8080'
    ].join('\r\n');

    fs.writeFileSync(batPath, syntheticBatContent, 'utf8');

    const discovery = createMcpDiscovery({
      sources: [
        {
          path: batPath,
          kind: 'bat',
          serviceId: 'mcp_synthetic_bat',
          label: 'Synthetic BAT MCP Service'
        }
      ]
    });

    const candidates = await discovery.scan();

    // Verify BAT script was NEVER executed (canary file does not exist)
    assert.equal(fs.existsSync(canaryPath), false, 'BAT script must never be executed');

    assert.equal(candidates.length, 1);
    const candidate = candidates[0];

    assert.equal(candidate.serviceId, 'mcp_synthetic_bat');
    assert.equal(candidate.sourceKind, 'bat');
    assert.equal(candidate.label, 'Synthetic BAT MCP Service');

    // Credential contract verification
    assert.equal(candidate.credentialStatus.configured, true);
    assert.equal(candidate.credentialStatus.hasApiKey, true);
    assert.equal(candidate.credentialStatus.hasTunnelId, true);
    assert.equal(candidate.credentialStatus.hasOrganizationId, true);

    // maskedTunnelId must be safe masked preview, never full raw ID
    const maskedId = candidate.credentialStatus.maskedTunnelId;
    assert.ok(maskedId, 'maskedTunnelId must be non-null');
    assert.equal(maskedId.includes('tun-synth-live-9876543210'), false, 'Full tunnel ID must not be leaked');
    assert.ok(maskedId.includes('...'), 'maskedTunnelId should have ellipsis masking');

    // Verify serialized DTO does not leak any plaintext secrets
    const serializedCandidate = JSON.stringify(candidate);
    assert.equal(serializedCandidate.includes('sk-synthetic-live-secret-99999'), false, 'API key must not leak in candidate DTO');
    assert.equal(serializedCandidate.includes('tun-synth-live-9876543210'), false, 'Full tunnel ID must not leak in candidate DTO');

    // Binding args masking verification
    assert.equal(candidate.binding.type, 'stdio');
    assert.equal(candidate.binding.executable, 'node');
    const secretArg = candidate.binding.args.find(a => a.secret === true);
    assert.ok(secretArg, 'Sensitive command argument must be flagged as secret');
    assert.equal(secretArg.configured, true);
    assert.equal(secretArg.value, undefined, 'Secret arg value must not be present in public candidate DTO');

    // Verify internal definition load retains credentials securely
    const loaded = await discovery.loadCandidate(candidate.id);
    assert.ok(loaded);
    assert.equal(loaded.candidate.id, candidate.id);
    assert.equal(loaded.profileInput.services['mcp_synthetic_bat'].tunnelId, 'tun-synth-live-9876543210');
    assert.equal(loaded.profileInput.services['mcp_synthetic_bat'].apiKey, 'sk-synthetic-live-secret-99999');
    assert.equal(loaded.profileInput.services['mcp_synthetic_bat'].organizationId, 'org-synth-enterprise-1234');

    // Public candidate inside loaded record must still remain masked
    assert.equal(JSON.stringify(loaded.candidate).includes('sk-synthetic-live-secret-99999'), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('parseRestrictedBat handles non-string input safely', () => {
  assert.deepEqual(parseRestrictedBat(null), { env: Object.create(null), command: null, warnings: [] });
  assert.deepEqual(parseRestrictedBat(undefined), { env: Object.create(null), command: null, warnings: [] });
  assert.deepEqual(parseRestrictedBat(123), { env: Object.create(null), command: null, warnings: [] });
});

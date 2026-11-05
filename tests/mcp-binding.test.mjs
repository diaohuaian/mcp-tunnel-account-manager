import test from 'node:test';
import assert from 'node:assert/strict';
import {
  quoteWindowsArg,
  parseWindowsCommandLine,
  formatWindowsCommandLine,
  resolveExecutable,
  mergeBindingArgs,
  publicBindingArgs,
  validateHttpUrl,
  publicUrl,
  mergeHeadersPatch,
  publicHeaders,
  mergeBinding,
  publicBinding,
  bindingToTunnelCommand,
  BindingFault,
  isSensitiveName,
  SENSITIVE_NAME_REGEX,
  compileHttpTransport,
  validateServiceEnvName,
  isReservedServiceEnvName,
  hasPrivateQuery
} from '../src/adapters/mcp-binding.mjs';

test('1. quoteWindowsArg escapes arguments according to CommandLineToArgvW rules', () => {
  // Empty string
  assert.equal(quoteWindowsArg(''), '""');
  assert.equal(quoteWindowsArg(null), '""');
  assert.equal(quoteWindowsArg(undefined), '""');

  // Simple token without whitespace or quotes
  assert.equal(quoteWindowsArg('node'), 'node');
  assert.equal(quoteWindowsArg('C:\\Users\\bin\\test.exe'), 'C:\\Users\\bin\\test.exe');

  // Spaces and tabs
  assert.equal(quoteWindowsArg('hello world'), '"hello world"');
  assert.equal(quoteWindowsArg('foo\tbar'), '"foo\tbar"');

  // Embedded quotes
  assert.equal(quoteWindowsArg('a"b'), '"a\\"b"');
  assert.equal(quoteWindowsArg('a\\"b'), '"a\\\\\\"b"');

  // Trailing backslashes when quotes are needed
  assert.equal(quoteWindowsArg('path with space\\'), '"path with space\\\\"');
  assert.equal(quoteWindowsArg('path with space\\\\'), '"path with space\\\\\\\\"');
  // Without whitespace or quotes, backslashes are preserved as-is
  assert.equal(quoteWindowsArg('path\\'), 'path\\');

  // Non-string arguments coerced
  assert.equal(quoteWindowsArg(123), '123');
  assert.equal(quoteWindowsArg(true), 'true');
});

test('2. formatWindowsCommandLine and parseWindowsCommandLine round-trip correctly', () => {
  const exe = 'C:\\Program Files\\Node\\node.exe';
  const args = [
    '--config',
    'C:\\My Documents\\config.json',
    'hello "world"',
    'trailing\\',
    'empty=""',
    'flag'
  ];

  const formatted = formatWindowsCommandLine(exe, args);
  assert.ok(formatted.startsWith('"C:\\Program Files\\Node\\node.exe"'));

  const parsed = parseWindowsCommandLine(formatted);
  assert.equal(parsed[0], exe);
  assert.deepEqual(parsed.slice(1), args);

  // Rejects invalid executable
  assert.throws(() => formatWindowsCommandLine(''), { code: 'INVALID_EXECUTABLE' });
  assert.throws(() => formatWindowsCommandLine(null), { code: 'INVALID_EXECUTABLE' });

  // Parsing empty or whitespace command line
  assert.deepEqual(parseWindowsCommandLine(''), []);
  assert.deepEqual(parseWindowsCommandLine('   '), []);
});

test('3. resolveExecutable maps npx safely and rejects unsupported .cmd/.bat files', () => {
  // Standard executable
  const std = resolveExecutable('node');
  assert.equal(std.executable, 'node');
  assert.deepEqual(std.prependArgs, []);
  assert.equal(std.isMapped, false);

  // NPX mapped to node with prependArgs
  const npx = resolveExecutable('npx', {
    nodePath: 'C:\\Node\\node.exe',
    npxCliPath: 'C:\\Node\\node_modules\\npm\\bin\\npx-cli.js'
  });
  assert.equal(npx.executable, 'C:\\Node\\node.exe');
  assert.deepEqual(npx.prependArgs, ['C:\\Node\\node_modules\\npm\\bin\\npx-cli.js']);
  assert.equal(npx.isMapped, true);

  // npx.cmd and npx.bat mapped
  const npxCmd = resolveExecutable('C:\\Tools\\npx.cmd', {
    nodePath: 'C:\\Node\\node.exe',
    npxCliPath: 'C:\\Node\\npx-cli.js'
  });
  assert.equal(npxCmd.isMapped, true);

  // Unknown .bat and .cmd files strictly rejected without cmd /c fallback
  for (const bad of ['install.bat', 'run.cmd', 'C:\\malicious\\script.BAT', 'setup.CMD']) {
    assert.throws(
      () => resolveExecutable(bad),
      (err) => {
        assert.ok(err instanceof BindingFault);
        assert.equal(err.code, 'UNSUPPORTED_EXECUTABLE');
        return true;
      }
    );
  }

  // Invalid executables rejected
  for (const bad of ['', '   ', 'bad\0exe', 'a'.repeat(40000)]) {
    assert.throws(
      () => resolveExecutable(bad),
      (err) => err.code === 'INVALID_EXECUTABLE'
    );
  }
});

test('4. mergeBindingArgs enforces rules: patch by id, preserve value, forced secret on sensitive names', () => {
  const initial = [
    { id: 'arg_flag', value: '--verbose', secret: false },
    { id: 'AUTH_TOKEN', value: 'secret-token-123', secret: true },
    { id: 'port', value: '8080', secret: false }
  ];

  // Sensitive names cannot be unmasked
  const sensitiveMerged = mergeBindingArgs([], [
    { id: 'API_KEY', value: 'secret-key', secret: false },
    { id: 'user_password', value: 'pass123', secret: false }
  ]);
  assert.equal(sensitiveMerged[0].secret, true);
  assert.equal(sensitiveMerged[1].secret, true);

  // Patch matches by id; omitting value preserves existing; omitting item removes it
  const patched = mergeBindingArgs(initial, [
    { id: 'arg_flag' }, // preserves '--verbose', retains secret: false
    { id: 'port', value: '9000' } // updates port, omitted token removed
  ]);
  assert.equal(patched.length, 2);
  assert.equal(patched[0].id, 'arg_flag');
  assert.equal(patched[0].value, '--verbose');
  assert.equal(patched[0].secret, false);
  assert.equal(patched[1].id, 'port');
  assert.equal(patched[1].value, '9000');

  // New argument without value throws ARG_VALUE_REQUIRED
  assert.throws(
    () => mergeBindingArgs([], [{ id: 'new_arg' }]),
    { code: 'ARG_VALUE_REQUIRED' }
  );

  // Duplicate IDs rejected
  assert.throws(
    () => mergeBindingArgs([], [{ id: 'dup', value: '1' }, { id: 'dup', value: '2' }]),
    { code: 'DUPLICATE_ARG_ID' }
  );

  // Invalid argument ID
  assert.throws(
    () => mergeBindingArgs([], [{ id: '', value: 'val' }]),
    { code: 'INVALID_ARG_ID' }
  );
});

test('5. publicBindingArgs produces safe public DTO omitting secrets', () => {
  const args = [
    { id: 'host', value: '127.0.0.1', secret: false },
    { id: 'API_TOKEN', value: 'secret-key-xyz', secret: true },
    { id: 'custom_secret', value: 'super-secret', secret: true }
  ];

  const pub = publicBindingArgs(args);
  assert.deepEqual(pub, [
    { id: 'host', secret: false, configured: true, value: '127.0.0.1' },
    { id: 'API_TOKEN', secret: true, configured: true },
    { id: 'custom_secret', secret: true, configured: true }
  ]);
});

test('6. validateHttpUrl and publicUrl enforce loopback/HTTP protocols and strip userinfo/sensitive query params', () => {
  // Valid URLs
  assert.equal(validateHttpUrl('http://127.0.0.1:8080/mcp'), 'http://127.0.0.1:8080/mcp');
  assert.equal(validateHttpUrl('https://example.com/api/v1'), 'https://example.com/api/v1');

  // Reject URL userinfo
  for (const bad of [
    'http://user:pass@127.0.0.1:8080/',
    'https://admin:token@example.com/api'
  ]) {
    assert.throws(
      () => validateHttpUrl(bad),
      (err) => err instanceof BindingFault && err.code === 'URL_USERINFO_FORBIDDEN'
    );
  }

  // Reject unsupported protocols
  for (const bad of ['ftp://files.com', 'file:///C:/path', 'javascript:alert(1)', 'not a url']) {
    assert.throws(
      () => validateHttpUrl(bad),
      { code: 'INVALID_URL' }
    );
  }

  // publicUrl removes sensitive query parameters
  const sanitized = publicUrl('https://example.com/service?auth_token=supersecret&api_key=12345&region=us-east');
  assert.ok(!sanitized.includes('supersecret'));
  assert.ok(!sanitized.includes('12345'));
  assert.ok(sanitized.includes('region=us-east'));
});

test('7. mergeHeadersPatch and publicHeaders manage HTTP headers with strict secret protection', () => {
  const initial = mergeHeadersPatch({}, [
    { name: 'X-App-Env', op: 'set', value: 'test', secret: false },
    { name: 'Authorization', op: 'set', value: 'Bearer token-123', secret: false }, // sensitive!
    { name: 'X-Secret-Tag', op: 'set', value: 'confidential' } // default secret: true
  ]);

  assert.equal(initial['X-App-Env'].secret, false);
  assert.equal(initial['Authorization'].secret, true); // forced secret
  assert.equal(initial['X-Secret-Tag'].secret, true);

  // Patch with set and remove
  const updated = mergeHeadersPatch(initial, [
    { name: 'x-secret-tag', op: 'remove' },
    { name: 'X-App-Env', op: 'set', value: 'production', secret: false }
  ]);

  assert.equal(updated['X-Secret-Tag'], undefined);
  assert.equal(updated['X-App-Env'].value, 'production');
  assert.equal(updated['Authorization'].value, 'Bearer token-123');

  // Duplicate header name in patch rejected
  assert.throws(
    () => mergeHeadersPatch({}, [
      { name: 'Content-Type', op: 'set', value: 'application/json' },
      { name: 'content-type', op: 'set', value: 'text/plain' }
    ]),
    { code: 'DUPLICATE_HEADER_NAME' }
  );

  // publicHeaders masks secret values
  const pub = publicHeaders(initial);
  assert.deepEqual(pub['X-App-Env'], { secret: false, configured: true, value: 'test' });
  assert.deepEqual(pub['Authorization'], { secret: true, configured: true });
  assert.deepEqual(pub['X-Secret-Tag'], { secret: true, configured: true });

  // publicHeaders accepts raw array descriptors and safely omits secret values
  const arrayHeaders = [
    { name: 'Authorization', value: 'Bearer topsecret', secret: true },
    { name: 'X-Public-Flag', value: 'enabled', secret: false }
  ];
  const pubFromArray = publicHeaders(arrayHeaders);
  assert.deepEqual(pubFromArray['Authorization'], { secret: true, configured: true });
  assert.deepEqual(pubFromArray['X-Public-Flag'], { secret: false, configured: true, value: 'enabled' });

  // No-placeholder writeback for headers: omitting value preserves existing secret value
  const headerPreserve = mergeHeadersPatch(
    { Authorization: { value: 'Bearer token-123', secret: true } },
    [{ name: 'Authorization', secret: true }]
  );
  assert.equal(headerPreserve.Authorization.value, 'Bearer token-123');
  assert.equal(headerPreserve.Authorization.secret, true);

  // Record-style patch with omitted value also preserves existing value
  const headerRecordPreserve = mergeHeadersPatch(
    { Authorization: { value: 'Bearer token-123', secret: true } },
    { Authorization: { secret: true, configured: true } }
  );
  assert.equal(headerRecordPreserve.Authorization.value, 'Bearer token-123');
  assert.equal(headerRecordPreserve.Authorization.secret, true);

  // New header with omitted value rejects
  assert.throws(
    () => mergeHeadersPatch({}, [{ name: 'New-Header', secret: true }]),
    { code: 'INVALID_HEADER_VALUE' }
  );
});

test('8. mergeBinding and publicBinding support stdio and http bindings', () => {
  // Stdio binding
  const stdioPrev = {
    type: 'stdio',
    executable: 'node',
    args: [{ id: 'a1', value: 'server.js', secret: false }]
  };
  const stdioPatched = mergeBinding(stdioPrev, {
    cwd: 'C:\\Projects\\mcp'
  });
  assert.equal(stdioPatched.type, 'stdio');
  assert.equal(stdioPatched.executable, 'node');
  assert.equal(stdioPatched.cwd, 'C:\\Projects\\mcp');
  assert.equal(stdioPatched.args.length, 1);

  const pubStdio = publicBinding(stdioPatched);
  assert.equal(pubStdio.type, 'stdio');
  assert.equal(pubStdio.executable, 'node');
  assert.equal(pubStdio.cwd, 'C:\\Projects\\mcp');

  // HTTP binding
  const httpPrev = {
    type: 'http',
    url: 'https://example.com/mcp',
    headers: { 'Authorization': { value: 'Bearer secret', secret: true } }
  };
  const pubHttp = publicBinding(httpPrev);
  assert.equal(pubHttp.type, 'http');
  assert.equal(pubHttp.url, 'https://example.com/mcp');
  assert.deepEqual(pubHttp.headers['Authorization'], { secret: true, configured: true });

  // Invalid binding type rejected
  assert.throws(
    () => mergeBinding({}, { type: 'websocket' }),
    { code: 'INVALID_BINDING_TYPE' }
  );
});

test('9. bindingToTunnelCommand formats upstream tunnel-client 0.0.19 command', () => {
  const binding = {
    type: 'stdio',
    executable: 'python',
    args: [
      { id: 'script', value: 'server.py' },
      { id: 'arg_with_spaces', value: 'value with spaces' }
    ],
    cwd: 'C:\\mcp'
  };

  const cmd = bindingToTunnelCommand(binding);
  assert.equal(cmd.executable, 'python');
  assert.equal(cmd.cwd, 'C:\\mcp');
  assert.deepEqual(cmd.args, ['server.py', 'value with spaces']);
  assert.ok(cmd.command.includes('"value with spaces"'));

  // Rejects non-stdio binding
  assert.throws(
    () => bindingToTunnelCommand({ type: 'http', url: 'https://example.com' }),
    { code: 'UNSUPPORTED_BINDING_FOR_COMMAND' }
  );
});

test('10. validateHttpUrl preserves validated original endpoint string, signed path/query spelling, percent-escapes, default port', () => {
  const signedUrl = 'https://mcp.example.test:443/a/../mcp?sig=中&escaped=%2f%2F';
  const validated = validateHttpUrl(signedUrl);
  // Preserves exact string, does not normalize WHATWG url.href
  assert.equal(validated, signedUrl);
  assert.ok(validated.includes(':443'));
  assert.ok(validated.includes('/a/../mcp'));
  assert.ok(validated.includes('sig=中'));
  assert.ok(validated.includes('%2f%2F'));
});

test('11. publicBinding for HTTP differentiates private query vs public or no-query', () => {
  // Private query URL: omits raw url, provides urlDisplay, urlConfigured, hasPrivateQuery
  const privateBinding = {
    type: 'http',
    url: 'https://mcp.example.test:443/a/../mcp?sig=中&escaped=%2f%2F',
    headers: { Authorization: { value: 'Bearer token', secret: true } }
  };
  const pubPrivate = publicBinding(privateBinding);
  assert.equal(pubPrivate.type, 'http');
  assert.equal(pubPrivate.url, undefined);
  assert.equal(pubPrivate.urlDisplay, 'https://mcp.example.test/mcp');
  assert.equal(pubPrivate.urlConfigured, true);
  assert.equal(pubPrivate.hasPrivateQuery, true);
  assert.deepEqual(pubPrivate.headers.Authorization, { secret: true, configured: true });

  // Retention through public input: passing pubPrivate back to publicBinding preserves safe fields
  const pubReprocessed = publicBinding(pubPrivate);
  assert.equal(pubReprocessed.type, 'http');
  assert.equal(pubReprocessed.url, undefined);
  assert.equal(pubReprocessed.urlDisplay, 'https://mcp.example.test/mcp');
  assert.equal(pubReprocessed.urlConfigured, true);
  assert.equal(pubReprocessed.hasPrivateQuery, true);
  assert.deepEqual(pubReprocessed.headers.Authorization, { secret: true, configured: true });

  // Public query URL: retains url and urlDisplay, urlConfigured
  const publicQueryBinding = {
    type: 'http',
    url: 'https://example.com/api?format=json&version=2',
    headers: { 'X-Custom': { value: 'test', secret: false } }
  };
  const pubPublic = publicBinding(publicQueryBinding);
  assert.equal(pubPublic.type, 'http');
  assert.equal(pubPublic.url, 'https://example.com/api?format=json&version=2');
  assert.equal(pubPublic.urlDisplay, 'https://example.com/api?format=json&version=2');
  assert.equal(pubPublic.urlConfigured, true);
  assert.equal(pubPublic.hasPrivateQuery, undefined);
  assert.deepEqual(pubPublic.headers['X-Custom'], { secret: false, configured: true, value: 'test' });

  // No-query URL: retains url and urlDisplay, urlConfigured
  const noQueryBinding = {
    type: 'http',
    url: 'https://example.com/mcp',
    headers: {}
  };
  const pubNoQuery = publicBinding(noQueryBinding);
  assert.equal(pubNoQuery.type, 'http');
  assert.equal(pubNoQuery.url, 'https://example.com/mcp');
  assert.equal(pubNoQuery.urlDisplay, 'https://example.com/mcp');
  assert.equal(pubNoQuery.urlConfigured, true);
  assert.equal(pubNoQuery.hasPrivateQuery, undefined);
});

test('12. mergeBinding for HTTP retains previousBinding.url when patch.url is omitted', () => {
  const prev = {
    type: 'http',
    url: 'https://mcp.example.test:443/a/../mcp?sig=中',
    urlDisplay: 'https://mcp.example.test/mcp',
    hasPrivateQuery: true,
    headers: { 'X-Old': { value: 'old', secret: false } }
  };
  // Patch without url
  const merged = mergeBinding(prev, {
    headersPatch: [{ name: 'X-New', op: 'set', value: 'new' }]
  });
  assert.equal(merged.type, 'http');
  assert.equal(merged.url, 'https://mcp.example.test:443/a/../mcp?sig=中');
  assert.equal(merged.headers['X-Old'].value, 'old');
  assert.equal(merged.headers['X-New'].value, 'new');

  // Blank string edit retains actual saved private endpoint
  const blankEditMerged = mergeBinding(prev, {
    url: '   '
  });
  assert.equal(blankEditMerged.url, 'https://mcp.example.test:443/a/../mcp?sig=中');

  // Explicit clear (null) is distinct and rejected
  assert.throws(
    () => mergeBinding(prev, { url: null }),
    { code: 'INVALID_URL' }
  );

  // Masked placeholder *** or ... is rejected
  assert.throws(
    () => mergeBinding(prev, { url: '***' }),
    { code: 'INVALID_URL' }
  );
  assert.throws(
    () => mergeBinding(prev, { url: 'https://example.com/api?...' }),
    { code: 'INVALID_URL' }
  );

  // Re-submitting the safe urlDisplay retains the actual saved private endpoint
  const reSubmittedDisplay = mergeBinding(prev, {
    url: 'https://mcp.example.test/mcp'
  });
  assert.equal(reSubmittedDisplay.url, 'https://mcp.example.test:443/a/../mcp?sig=中');

  // Patch with explicit new URL
  const updatedUrl = mergeBinding(prev, {
    url: 'https://updated.example.com/api'
  });
  assert.equal(updatedUrl.url, 'https://updated.example.com/api');
});

test('13. mergeBinding and mergeHeadersPatch reject non-record header containers with INVALID_HTTP_HEADERS', () => {
  // Non-record Map
  assert.throws(
    () => mergeBinding({}, { type: 'http', url: 'https://example.com', headers: new Map([['Authorization', 'secret']]) }),
    { code: 'INVALID_HTTP_HEADERS' }
  );

  // Non-record Set
  assert.throws(
    () => mergeBinding({}, { type: 'http', url: 'https://example.com', headers: new Set() }),
    { code: 'INVALID_HTTP_HEADERS' }
  );

  // mergeHeadersPatch rejects non-record non-array
  assert.throws(
    () => mergeHeadersPatch({}, new Map()),
    { code: 'INVALID_HTTP_HEADERS' }
  );
  assert.throws(
    () => mergeHeadersPatch(new Map(), {}),
    { code: 'INVALID_HTTP_HEADERS' }
  );
});

test('14. validateServiceEnvName rejects reserved service environment names case-insensitively', () => {
  const reservedNames = [
    'MCP_SERVER_URL',
    'MCP_COMMAND',
    'MCP_EXTRA_HEADERS',
    'MCP_DISCOVERY_EXTRA_HEADERS',
    'mcp_server_url',
    'mcp_command',
    'mcp_extra_headers',
    'mcp_discovery_extra_headers',
    'TUNNEL_CLIENT_MCP_HEADER_FOO',
    'tunnel_client_mcp_header_bar',
    'TUNNEL_CLIENT_SOME_VAR',
    'CONTROL_PLANE_KEY',
    'TUNNEL_ID'
  ];

  for (const name of reservedNames) {
    assert.equal(isReservedServiceEnvName(name), true);
    assert.throws(
      () => validateServiceEnvName(name),
      { code: 'RESERVED_ENV_NAME' }
    );
  }

  // Allowed valid name
  assert.equal(isReservedServiceEnvName('MY_CUSTOM_VAR'), false);
  assert.doesNotThrow(() => validateServiceEnvName('MY_CUSTOM_VAR'));

  // Invalid variable name
  assert.throws(
    () => validateServiceEnvName('123_INVALID'),
    { code: 'INVALID_ENV_NAME' }
  );
});

test('15. compileHttpTransport integration from http-transport.mjs', () => {
  const context = { serviceId: 'mcp_test', operationId: 'op-123' };
  const binding = {
    type: 'http',
    url: 'https://example.com/mcp?sig=test',
    headers: {
      Authorization: { value: 'Bearer token-xyz' }
    }
  };

  const plan = compileHttpTransport(binding, context);
  assert.equal(plan.kind, 'http');
  assert.equal(plan.channel, 'main');
  assert.equal(plan.privateEnvironment.MCP_SERVER_URL, 'https://example.com/mcp?sig=test');
  assert.ok(plan.args.includes('--mcp.extra-headers'));
  assert.equal(plan.headerNames[0], 'Authorization');
});

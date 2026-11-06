/**
 * Component Test Suite: UI MCP Registry & Lifecycle
 * Uses Node.js native test runner (node:test, node:assert)
 * Does NOT scan real host configs or execute explorer.exe.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  maskTunnelId,
  parseSafeErrorCode,
  formatSafeError,
  formatOperationFailure,
  updateProgressView,
  generateIdempotencyKey,
  isProfileActive,
  isSensitiveEnvName,
  isSensitiveHeaderName,
  canDeleteMcp,
  buildEnvironmentPatch,
  buildBindingArgs,
  buildBindingPayload,
  buildProfileServicesPayload,
  getHttpDisplayUrl,
  updateLocationsFeedback,
  clearLocationsFeedback,
  revealLocationPath,
  openEditMcpModal,
  openAddMcpModal,
  handleMcpFormSubmit,
  appState,
  dom,
  SAFE_ERROR_MESSAGES
} from '../public/app.js';

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), '..');

// Read public files
const indexHtmlPath = path.join(projectRoot, 'public', 'index.html');
const appJsPath = path.join(projectRoot, 'public', 'app.js');
const appCssPath = path.join(projectRoot, 'public', 'app.css');

const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
const appJs = fs.readFileSync(appJsPath, 'utf8');
const appCss = fs.readFileSync(appCssPath, 'utf8');

// ============================================================================
// 1. UI Markup & Zero External Dependency Validation
// ============================================================================

test('switch failure formatter names the failed MCP and provides actionable allowlisted reasons', () => {
  const operation = {failureCode: 'TARGET_VERIFICATION_UNAVAILABLE',
    failureService: 'mcp_bridge', failureReason: 'HTTP_UPSTREAM_UNREACHABLE',
    targets: ['overleaf-mcp', 'mcp_bridge']};
  const text = formatOperationFailure(operation, [{id: 'mcp_bridge', label: 'DSH ChatGPT Bridge'}]);
  assert.match(text, /DSH ChatGPT Bridge/);
  assert.match(text, /本机 HTTP MCP 上游未监听或不可达/);
  assert.match(text, /配置和密钥会保留/);
  assert.match(text, /TARGET_VERIFICATION_UNAVAILABLE \/ HTTP_UPSTREAM_UNREACHABLE/);
  assert.match(formatOperationFailure({failureCode: 'VERIFY_FAILED'}, []), /严格健康与认证校验/);
  const redacted = formatOperationFailure({failureCode: 'Bearer private-token',
    failureReason: 'Authorization: Bearer private-token', failureService: 'mcp_unselected',
    targets: ['overleaf-mcp'], error: 'private-token', message: 'private-token'}, []);
  assert.doesNotMatch(redacted, /private-token|Authorization|mcp_unselected/);
  assert.match(redacted, /SWITCH_FAILED/);
});

test('terminal switch progress uses the safe structured diagnostic, not a raw operation message', () => {
  const previousCard = dom.operationProgressCard;
  const previousMessage = dom.opStatusMessage;
  dom.operationProgressCard = {querySelectorAll: () => []};
  dom.opStatusMessage = {textContent: ''};
  try {
    updateProgressView({id: 'op-safe', status: 'ROLLED_BACK', failureCode: 'VERIFY_FAILED',
      failureReason: 'RUNTIME_NOT_READY', failureService: 'overleaf-mcp', targets: ['overleaf-mcp'],
      message: 'Authorization: Bearer private-token'});
    assert.match(dom.opStatusMessage.textContent, /overleaf-mcp/);
    assert.match(dom.opStatusMessage.textContent, /RUNTIME_NOT_READY/);
    assert.doesNotMatch(dom.opStatusMessage.textContent, /Authorization|private-token/);
  } finally {
    dom.operationProgressCard = previousCard;
    dom.opStatusMessage = previousMessage;
  }
});

test('1.1 Zero external dependencies and offline self-contained markup', () => {
  // Must not reference any remote scripts or CDN stylesheets
  assert.doesNotMatch(indexHtml, /<script[^>]+src=["']https?:\/\//i, 'No external script tags allowed');
  assert.doesNotMatch(indexHtml, /<link[^>]+href=["']https?:\/\//i, 'No external link tags allowed');
  assert.doesNotMatch(indexHtml, /fonts\.googleapis\.com/i, 'No external Google fonts allowed');
  assert.doesNotMatch(appCss, /@import\s+url\(["']https?:\/\//i, 'No remote CSS imports allowed');

  // Must reference local stylesheet and app.js
  assert.match(indexHtml, /<link rel="stylesheet" href="\.\/app\.css">/);
  assert.match(indexHtml, /<script src="\.\/app\.js" type="module"><\/script>/);
});

test('1.2 Two clear major regions: 账号配置 (Account Config) and MCP服务 (MCP Services)', () => {
  // Navigation tabs
  assert.match(indexHtml, /id="tab-nav-accounts"/, 'Accounts tab button must exist');
  assert.match(indexHtml, /id="tab-nav-mcps"/, 'MCP services tab button must exist');
  assert.match(indexHtml, /id="badge-mcps-count"/, 'MCP services count badge must exist');

  // Clear major content sections
  assert.match(indexHtml, /id="section-accounts"/, 'Accounts configuration section must exist');
  assert.match(indexHtml, /id="section-mcps"/, 'MCP services registry section must exist');

  // Section titles & descriptions
  assert.match(indexHtml, /账号配置列表/, 'Chinese section heading for accounts');
  assert.match(indexHtml, /MCP 服务管理/, 'Chinese section heading for MCP registry');
  assert.match(indexHtml, /隧道切换控制/, 'Switch control section must be present');
});

test('1.3 Switch control targets container is dynamic (not hardcoded to overleaf & antigravity only)', () => {
  assert.match(indexHtml, /id="switch-targets-container"/, 'Dynamic switch targets container must exist');
  assert.match(indexHtml, /id="switch-profile-select"/, 'Profile select dropdown must exist');
  assert.match(indexHtml, /id="btn-execute-switch"/, 'Execute switch button must exist');
  assert.match(indexHtml, /id="operation-progress-card"/, 'Progress card must exist');
});

test('1.4 Dynamic profile modal supports multi-MCP services configuration', () => {
  assert.match(indexHtml, /id="profile-modal"/, 'Profile modal must exist');
  assert.match(indexHtml, /id="profile-services-container"/, 'Dynamic profile services container must exist');
  assert.match(indexHtml, /id="form-profile-label"/, 'Profile label input must exist');
  assert.match(indexHtml, /id="btn-modal-save"/, 'Profile save button must exist');
});

test('1.5 MCP Services registry has Add, Discovery, Pending banner, and list container', () => {
  assert.match(indexHtml, /id="btn-open-add-mcp"/, 'Add MCP button must exist');
  assert.match(indexHtml, /id="btn-scan-discovery"/, 'Scan discovery button must exist');
  assert.match(indexHtml, /id="mcps-pending-banner"/, 'Pending apply banner must exist');
  assert.match(indexHtml, /id="mcps-container"/, 'MCP services container must exist');
});

test('1.6 MCP Add/Edit Form contains both Stdio and HTTP parameters with secret flags', () => {
  assert.match(indexHtml, /id="mcp-modal"/, 'MCP Add/Edit modal must exist');
  assert.match(indexHtml, /id="mcp-form-label"/, 'MCP label input must exist');
  assert.match(indexHtml, /id="mcp-form-type"/, 'MCP type select (stdio vs http) must exist');
  assert.match(indexHtml, /id="mcp-form-enabled"/, 'MCP enabled checkbox must exist');

  // Stdio fields
  assert.match(indexHtml, /id="mcp-stdio-fields"/, 'Stdio fields group must exist');
  assert.match(indexHtml, /id="mcp-form-executable"/, 'Executable path input must exist');
  assert.match(indexHtml, /id="mcp-form-cwd"/, 'Cwd input must exist');
  assert.match(indexHtml, /id="mcp-args-container"/, 'Dynamic args container must exist');
  assert.match(indexHtml, /id="btn-add-arg"/, 'Add argument button must exist');

  // HTTP fields
  assert.match(indexHtml, /id="mcp-http-fields"/, 'HTTP fields group must exist');
  assert.match(indexHtml, /id="mcp-form-url"/, 'URL input must exist');
  assert.match(indexHtml, /id="mcp-headers-container"/, 'Dynamic headers container must exist');
  assert.match(indexHtml, /id="btn-add-header"/, 'Add header button must exist');

  // Environment variables
  assert.match(indexHtml, /id="mcp-env-section"/, 'Environment variables section must exist');
  assert.match(indexHtml, /id="mcp-env-container"/, 'Dynamic environment variables container must exist');
  assert.match(indexHtml, /id="btn-add-env"/, 'Add environment variable button must exist');
});

test('1.7 MCP Locations & Details modal contains all 6 roles with copy and reveal buttons', () => {
  assert.match(indexHtml, /id="mcp-locations-modal"/, 'Locations modal must exist');
  assert.match(indexHtml, /id="locations-modal-title"/, 'Locations modal title must exist');

  const requiredRoles = [
    'sourceConfig',
    'effectiveConfig',
    'installation',
    'executable',
    'workingDirectory',
    'managerStore'
  ];

  for (const role of requiredRoles) {
    // Path element
    assert.match(indexHtml, new RegExp(`id="path-${role}"`), `Path element for ${role} must exist`);
    // Status element
    assert.match(indexHtml, new RegExp(`id="status-${role}"`), `Status element for ${role} must exist`);
    // Copy button
    assert.match(indexHtml, new RegExp(`data-target="path-${role}"`), `Copy button for ${role} must exist`);
    // Reveal button calling POST /api/mcps/:id/reveal {role}
    assert.match(indexHtml, new RegExp(`data-role="${role}"`), `Reveal button for ${role} must exist`);
  }

  // Locations feedback elements must have role="status" and dual ID compatibility
  assert.match(indexHtml, /id="locations-action-feedback"[^>]*role="status"/, 'locations-action-feedback must have role="status"');
  assert.match(indexHtml, /id="locations-feedback"[^>]*role="status"/, 'locations-feedback must have role="status"');
  assert.match(appCss, /#locations-action-feedback/, 'CSS must style #locations-action-feedback');
  assert.match(appCss, /#locations-feedback/, 'CSS must style #locations-feedback');
});

test('1.8 Stop & Delete lifecycle modal explicitly clarifies console-only removal and preserves local files', () => {
  assert.match(indexHtml, /id="mcp-lifecycle-modal"/, 'Lifecycle modal must exist');
  assert.match(indexHtml, /id="lifecycle-body-running"/, 'Running state section must exist');
  assert.match(indexHtml, /id="btn-lifecycle-stop"/, 'Stop button must exist');
  assert.match(indexHtml, /id="lifecycle-body-unknown"/, 'Unknown state section must exist');
  assert.match(indexHtml, /id="lifecycle-body-stopped"/, 'Stopped state section must exist');
  assert.match(indexHtml, /id="btn-lifecycle-delete"/, 'Delete confirmation button must exist');

  // Critical requirement: Explicit notice that removal is from console only, retaining local files
  assert.match(indexHtml, /仅从控制台注销/, 'Must clarify removal is from console registration only');
  assert.match(indexHtml, /绝对不会删除或卸载本机上的程序文件/, 'Must explicitly guarantee local files are preserved');
});

test('1.9 Discovery preview and import modal exist without raw secret display', () => {
  assert.match(indexHtml, /id="discovery-section"/, 'Discovery section must exist');
  assert.match(indexHtml, /id="discovery-candidates-container"/, 'Discovery candidates container must exist');
  assert.match(indexHtml, /id="discovery-import-modal"/, 'Discovery import modal must exist');
  assert.match(indexHtml, /id="import-merge-profile-select"/, 'Profile merge select must exist');
  assert.match(indexHtml, /id="btn-confirm-import"/, 'Confirm import button must exist');
});

// ============================================================================
// 2. Helper Functions & Domain Logic Tests
// ============================================================================

test('2.1 maskTunnelId correctly masks tunnel IDs and handles edge cases', () => {
  assert.strictEqual(maskTunnelId('tunnel_ovl_9a8b7c6d'), 'tunnel_***7c6d');
  assert.strictEqual(maskTunnelId('tun_12345678'), 'tun_***5678');
  assert.strictEqual(maskTunnelId('abc1234567xyz'), 'abc1***7xyz');
  assert.strictEqual(maskTunnelId('short'), 'tunnel_***');
  assert.strictEqual(maskTunnelId(''), '-');
  assert.strictEqual(maskTunnelId(null), '-');
  assert.strictEqual(maskTunnelId(undefined), '-');
});

test('2.2 parseSafeErrorCode and formatSafeError return localized explanations for registry codes', () => {
  assert.strictEqual(parseSafeErrorCode({ code: 'MCP_RUNNING' }), 'MCP_RUNNING');
  assert.strictEqual(parseSafeErrorCode({ error: { code: 'MCP_NOT_FOUND' } }), 'MCP_NOT_FOUND');
  assert.strictEqual(parseSafeErrorCode({ errorCode: 'RUNTIME_STATE_UNKNOWN' }), 'RUNTIME_STATE_UNKNOWN');

  const errRunning = formatSafeError({ data: { code: 'MCP_RUNNING' } });
  assert.strictEqual(errRunning.code, 'MCP_RUNNING');
  assert.match(errRunning.displayText, /MCP_RUNNING/);
  assert.match(errRunning.message, /正在运行中/);

  const errUnknown = formatSafeError({ data: { code: 'RUNTIME_STATE_UNKNOWN' } });
  assert.strictEqual(errUnknown.code, 'RUNTIME_STATE_UNKNOWN');
  assert.match(errUnknown.message, /未知运行状态/);

  const errRevision = formatSafeError({ data: { code: 'REVISION_CONFLICT' } });
  assert.strictEqual(errRevision.code, 'REVISION_CONFLICT');
  assert.match(errRevision.message, /数据版本冲突/);
});

test('2.3 isSensitiveEnvName identifies sensitive environment variable names', () => {
  assert.strictEqual(isSensitiveEnvName('API_KEY'), true);
  assert.strictEqual(isSensitiveEnvName('GITHUB_TOKEN'), true);
  assert.strictEqual(isSensitiveEnvName('CLIENT_SECRET'), true);
  assert.strictEqual(isSensitiveEnvName('DB_PASSWORD'), true);
  assert.strictEqual(isSensitiveEnvName('AUTH_HEADER'), true);
  assert.strictEqual(isSensitiveEnvName('SESSION_COOKIE'), true);
  assert.strictEqual(isSensitiveEnvName('AWS_CREDENTIALS'), true);

  assert.strictEqual(isSensitiveEnvName('PORT'), false);
  assert.strictEqual(isSensitiveEnvName('HOST'), false);
  assert.strictEqual(isSensitiveEnvName('DATA_DIR'), false);
  assert.strictEqual(isSensitiveEnvName('NODE_ENV'), false);
  assert.strictEqual(isSensitiveEnvName(''), false);
});

test('2.4 canDeleteMcp enforces running state protection and unknown state recovery', () => {
  // Running or starting MCP cannot be deleted immediately; requires stop
  const runningMcp = { id: 'mcp-1', runtime: { tunnelClient: { state: 'running' } } };
  const checkRunning = canDeleteMcp(runningMcp);
  assert.strictEqual(checkRunning.allowed, false);
  assert.strictEqual(checkRunning.reason, 'MCP_RUNNING');
  assert.strictEqual(checkRunning.requiredAction, 'stop');

  const startingMcp = { id: 'mcp-2', runtime: { tunnelClient: { state: 'starting' } } };
  const checkStarting = canDeleteMcp(startingMcp);
  assert.strictEqual(checkStarting.allowed, false);
  assert.strictEqual(checkStarting.reason, 'MCP_RUNNING');

  // Unknown runtime state requires refresh/investigation
  const unknownMcp = { id: 'mcp-3', runtime: { tunnelClient: { state: 'unknown' } } };
  const checkUnknown = canDeleteMcp(unknownMcp);
  assert.strictEqual(checkUnknown.allowed, false);
  assert.strictEqual(checkUnknown.reason, 'RUNTIME_STATE_UNKNOWN');
  assert.strictEqual(checkUnknown.requiredAction, 'refresh');

  const unmanagedMcp = { id: 'mcp-unmanaged', runtime: { tunnelClient: { state: 'unmanaged' } } };
  assert.strictEqual(canDeleteMcp(unmanagedMcp).allowed, false);
  assert.strictEqual(canDeleteMcp(unmanagedMcp).reason, 'RUNTIME_STATE_UNMANAGED');

  // Stopped, not_running, or never_started can be deleted
  const stoppedMcp = { id: 'mcp-4', runtime: { tunnelClient: { state: 'stopped' } } };
  const checkStopped = canDeleteMcp(stoppedMcp);
  assert.strictEqual(checkStopped.allowed, true);
  assert.strictEqual(checkStopped.requiredAction, 'delete');

  const neverStartedMcp = { id: 'mcp-5', runtime: { tunnelClient: { state: 'never_started' } } };
  assert.strictEqual(canDeleteMcp(neverStartedMcp).allowed, true);
});

test('2.5 buildEnvironmentPatch supports set/remove, sensitive defaults, and preserves blank secrets', () => {
  const previousEnv = [
    { name: 'PORT', configured: true },
    { name: 'API_KEY', configured: true },
    { name: 'OLD_VAR', configured: true }
  ];

  // User changed PORT to 9000, left API_KEY blank (retain), removed OLD_VAR, added NEW_VAR
  const rows = [
    { name: 'PORT', value: '9000', secret: false, configured: true },
    { name: 'API_KEY', value: '', configured: true }, // blank on configured -> omit
    { name: 'NEW_VAR', value: 'hello', secret: true, configured: false }
  ];

  const patch = buildEnvironmentPatch(previousEnv, rows);

  // OLD_VAR was in previous but not in rows -> op: 'remove'
  const removeOld = patch.find(p => p.name === 'OLD_VAR');
  assert.ok(removeOld, 'OLD_VAR should have a remove patch');
  assert.strictEqual(removeOld.op, 'remove');

  // PORT updated to 9000
  const setPort = patch.find(p => p.name === 'PORT');
  assert.ok(setPort);
  assert.strictEqual(setPort.op, 'set');
  assert.strictEqual(setPort.value, '9000');
  assert.strictEqual(setPort.secret, false);

  // API_KEY was left blank with configured=true -> should NOT be set with empty string
  const setKey = patch.find(p => p.name === 'API_KEY');
  assert.strictEqual(setKey, undefined, 'Blank configured API_KEY must be omitted to retain existing secret');

  // NEW_VAR added
  const setNew = patch.find(p => p.name === 'NEW_VAR');
  assert.ok(setNew);
  assert.strictEqual(setNew.op, 'set');
  assert.strictEqual(setNew.value, 'hello');
  assert.strictEqual(setNew.secret, true);
});

test('2.6 buildBindingArgs handles new args default secret and retains omitted values', () => {
  const rows = [
    { id: 'arg_0', value: '', secret: true, configured: true }, // Existing configured, blank value -> omit value
    { id: 'arg_1', value: '--port=8080', secret: false, configured: false } // New arg
  ];

  const args = buildBindingArgs([], rows);
  assert.strictEqual(args.length, 2);

  // arg_0 should preserve existing value (value property omitted)
  assert.strictEqual(args[0].id, 'arg_0');
  assert.strictEqual(args[0].secret, true);
  assert.strictEqual(args[0].value, undefined, 'Value should be omitted to preserve secret on backend');

  // arg_1 is new and specified
  assert.strictEqual(args[1].id, 'arg_1');
  assert.strictEqual(args[1].value, '--port=8080');
  assert.strictEqual(args[1].secret, false);
});

test('2.7 buildBindingPayload builds stdio and http bindings correctly, supporting URL secret retention, masked ellipsis avoidance, and header lifecycle', () => {
  // Stdio
  const stdioPayload = buildBindingPayload('stdio', {
    executable: 'C:\\node.exe',
    cwd: 'C:\\app',
    argsRows: [{ id: 'arg_0', value: 'index.js', secret: false, configured: false }]
  });
  assert.strictEqual(stdioPayload.type, 'stdio');
  assert.strictEqual(stdioPayload.executable, 'C:\\node.exe');
  assert.strictEqual(stdioPayload.cwd, 'C:\\app');
  assert.strictEqual(stdioPayload.args.length, 1);
  assert.strictEqual(stdioPayload.args[0].value, 'index.js');

  // HTTP - Create mode (new service requires URL)
  const httpCreatePayload = buildBindingPayload('http', {
    url: 'https://mcp.example.com/sse',
    headersRows: [{ name: 'Authorization', value: 'Bearer xyz', secret: true, configured: false }],
    isEditing: false
  });
  assert.strictEqual(httpCreatePayload.type, 'http');
  assert.strictEqual(httpCreatePayload.url, 'https://mcp.example.com/sse');
  assert.ok(httpCreatePayload.headers['Authorization']);
  assert.strictEqual(httpCreatePayload.headers['Authorization'].value, 'Bearer xyz');
  assert.strictEqual(httpCreatePayload.headers['Authorization'].secret, true);

  // HTTP - Edit mode with blank URL: must omit url property so backend retains secret URL
  const httpBlankUrlEdit = buildBindingPayload('http', {
    url: '',
    headersRows: [],
    isEditing: true,
    initialUrl: 'https://mcp.internal.example/sse?token=supersecret'
  });
  assert.strictEqual('url' in httpBlankUrlEdit, false, 'Blank URL on edit must be omitted to retain existing secret');

  // HTTP - Edit mode with unchanged URL: must omit url property
  const httpUnchangedUrlEdit = buildBindingPayload('http', {
    url: 'https://mcp.internal.example/sse',
    headersRows: [],
    isEditing: true,
    initialUrl: 'https://mcp.internal.example/sse'
  });
  assert.strictEqual('url' in httpUnchangedUrlEdit, false, 'Unchanged URL on edit must be omitted');

  // HTTP - Edit mode with masked ellipsis URL: must omit url property so masked value is never sent
  const httpMaskedUrlEdit = buildBindingPayload('http', {
    url: 'https://mcp.internal.example/sse?...',
    headersRows: [],
    isEditing: true,
    initialUrl: ''
  });
  assert.strictEqual('url' in httpMaskedUrlEdit, false, 'Masked ellipsis URL must never be sent as payload value');

  // HTTP - Edit mode with new explicit URL: must include updated url
  const httpNewUrlEdit = buildBindingPayload('http', {
    url: 'https://new-endpoint.example.com/sse',
    headersRows: [],
    isEditing: true,
    initialUrl: 'https://old-endpoint.example.com/sse'
  });
  assert.strictEqual(httpNewUrlEdit.url, 'https://new-endpoint.example.com/sse');

  // HTTP - Headers lifecycle: retain blank configured, replace explicit, and mark removed headers with op: 'remove'
  const previousHeaders = {
    'Authorization': { secret: true, value: 'old_secret' },
    'X-Custom-Old': { secret: false, value: 'old_val' }
  };
  const headersRows = [
    { name: 'Authorization', value: '', secret: true, configured: true }, // configured blank -> retain (value omitted)
    { name: 'X-New-Header', value: 'new_val', secret: false, configured: false } // new header
    // X-Custom-Old omitted -> remove
  ];
  const httpHeadersPayload = buildBindingPayload('http', {
    url: '',
    headersRows,
    isEditing: true,
    previousHeaders
  });
  assert.strictEqual(httpHeadersPayload.headers['Authorization'].secret, true);
  assert.strictEqual('value' in httpHeadersPayload.headers['Authorization'], false, 'Configured blank header value must be omitted to retain backend secret');
  assert.strictEqual(httpHeadersPayload.headers['X-New-Header'].value, 'new_val');
  assert.deepStrictEqual(httpHeadersPayload.headers['X-Custom-Old'], { op: 'remove' }, 'Removed header must have op: remove');
});

test('2.9 getHttpDisplayUrl formats HTTP MCP display without exposing private query parameters', () => {
  // Case A: Has urlDisplay set explicitly
  const mcpWithDisplay = {
    binding: {
      type: 'http',
      urlDisplay: 'https://mcp.internal.example/sse',
      hasPrivateQuery: true,
      url: 'https://mcp.internal.example/sse?token=secret123'
    }
  };
  assert.strictEqual(getHttpDisplayUrl(mcpWithDisplay), 'https://mcp.internal.example/sse');

  // Case B: hasPrivateQuery true without urlDisplay
  const mcpPrivateQueryOnly = {
    binding: {
      type: 'http',
      hasPrivateQuery: true
    }
  };
  assert.strictEqual(getHttpDisplayUrl(mcpPrivateQueryOnly), '配置已保存');

  // Case C: urlConfigured true with raw url omitted
  const mcpConfiguredOnly = {
    binding: {
      type: 'http',
      urlConfigured: true
    }
  };
  assert.strictEqual(getHttpDisplayUrl(mcpConfiguredOnly), '配置已保存');

  // Case D: Clean public URL without private query
  const mcpPublic = {
    binding: {
      type: 'http',
      url: 'https://mcp.public.example/sse'
    }
  };
  assert.strictEqual(getHttpDisplayUrl(mcpPublic), 'https://mcp.public.example/sse');

  // Case E: Null/missing
  assert.strictEqual(getHttpDisplayUrl(null), '-');
  assert.strictEqual(getHttpDisplayUrl({}), '-');
});

test('2.8 buildProfileServicesPayload supports arbitrary registered MCPs and retains blank apiKey on edit', () => {
  const registeredMcps = [
    { id: 'overleaf-mcp', label: 'Overleaf' },
    { id: 'antigravity-mcp', label: 'Antigravity' },
    { id: 'mcp_custom_1', label: 'Custom Tool' }
  ];

  // Case A: Create mode - all specified fields sent
  const createInputs = {
    'overleaf-mcp': { tunnelId: 'tun_ovl_1', apiKey: 'key_1', orgId: 'org_1' },
    'antigravity-mcp': { tunnelId: 'tun_anti_2', apiKey: 'key_2' },
    'mcp_custom_1': { tunnelId: 'tun_cust_3', apiKey: 'key_3' }
  };
  const createPayload = buildProfileServicesPayload(registeredMcps, createInputs, false);
  assert.strictEqual(createPayload['overleaf-mcp'].tunnelId, 'tun_ovl_1');
  assert.strictEqual(createPayload['overleaf-mcp'].apiKey, 'key_1');
  assert.strictEqual(createPayload['mcp_custom_1'].tunnelId, 'tun_cust_3');
  assert.strictEqual(createPayload['mcp_custom_1'].apiKey, 'key_3');

  // Case B: Edit mode - blank apiKey is omitted to retain existing secret
  const editInputs = {
    'overleaf-mcp': { tunnelId: 'tun_ovl_new', apiKey: '', initialTunnelId: 'tun_ovl_1' }, // apiKey left blank
    'antigravity-mcp': { tunnelId: 'tun_anti_2', apiKey: 'new_secret_key', initialTunnelId: 'tun_anti_2' }, // new key
    'mcp_custom_1': { tunnelId: 'tun_cust_3', apiKey: '***', initialTunnelId: 'tun_cust_3' } // placeholder
  };
  const editPayload = buildProfileServicesPayload(registeredMcps, editInputs, true);

  // overleaf-mcp apiKey must NOT be present
  assert.strictEqual(editPayload['overleaf-mcp'].tunnelId, 'tun_ovl_new');
  assert.strictEqual('apiKey' in editPayload['overleaf-mcp'], false, 'Blank apiKey must be omitted on PATCH');

  // antigravity-mcp apiKey was updated
  assert.strictEqual(editPayload['antigravity-mcp'].apiKey, 'new_secret_key');

  // mcp_custom_1 masked placeholder must NOT be sent
  assert.strictEqual('apiKey' in editPayload['mcp_custom_1'], false, 'Masked placeholder *** must never be sent as real key');
});

// ============================================================================
// 3. Mock API Interaction Workflows
// ============================================================================

test('3.1 Stop and Poll lifecycle flow sends Idempotency-Key and polls until SUCCEEDED', async () => {
  const requestsMade = [];
  let pollCount = 0;

  // Mock fetch/API
  const mockApi = async (path, options = {}) => {
    requestsMade.push({ path, method: options.method || 'GET', headers: options.headers, body: options.body });

    if (path.includes('/stop') && options.method === 'POST') {
      assert.ok(options.headers?.['Idempotency-Key'], 'Stop request must include Idempotency-Key header');
      return { operation: { id: 'op_stop_123', status: 'QUEUED' } };
    }

    if (path.includes('/api/operations/op_stop_123')) {
      pollCount++;
      if (pollCount === 1) return { id: 'op_stop_123', status: 'APPLYING' };
      return { id: 'op_stop_123', status: 'SUCCEEDED', revision: 42 };
    }

    if (path.includes('/api/mcps/mcp_test') && options.method === 'DELETE') {
      return { ok: true, deleted: true, revision: 43 };
    }

    throw new Error(`Unhandled mock path: ${path}`);
  };

  // Step 1: Request stop
  const stopRes = await mockApi('/api/mcps/mcp_test/stop', {
    method: 'POST',
    headers: { 'Idempotency-Key': 'key_uuid_test' },
    body: { expectedRevision: 10 }
  });
  assert.strictEqual(stopRes.operation.status, 'QUEUED');

  // Step 2: Poll operation
  const poll1 = await mockApi('/api/operations/op_stop_123');
  assert.strictEqual(poll1.status, 'APPLYING');

  const poll2 = await mockApi('/api/operations/op_stop_123');
  assert.strictEqual(poll2.status, 'SUCCEEDED');
  assert.strictEqual(poll2.revision, 42);

  // Step 3: Now stopped, perform DELETE with new revision
  const delRes = await mockApi('/api/mcps/mcp_test', {
    method: 'DELETE',
    body: { expectedRevision: poll2.revision }
  });
  assert.strictEqual(delRes.ok, true);

  assert.strictEqual(requestsMade.length, 4);
});

test('3.2 Reveal endpoint flow dispatches correct role to POST /api/mcps/:id/reveal without host exec', async () => {
  const dispatched = [];
  const mockRevealApi = async (path, options) => {
    dispatched.push({ path, body: JSON.parse(options.body) });
    return { ok: true, revealed: true };
  };

  const rolesToTest = ['installation', 'executable', 'workingDirectory', 'managerStore', 'sourceConfig', 'effectiveConfig'];

  for (const role of rolesToTest) {
    await mockRevealApi('/api/mcps/mcp_demo/reveal', {
      method: 'POST',
      body: JSON.stringify({ role })
    });
  }

  assert.strictEqual(dispatched.length, 6);
  rolesToTest.forEach((role, idx) => {
    assert.strictEqual(dispatched[idx].path, '/api/mcps/mcp_demo/reveal');
    assert.strictEqual(dispatched[idx].body.role, role);
  });
});

test('3.3 Discovery import flow sends expectedFingerprint and expectedRevision without leaking raw secrets', async () => {
  const importRequests = [];
  const mockImportApi = async (path, options) => {
    importRequests.push({ path, body: JSON.parse(options.body) });
    return { created: true, revision: 15, service: { id: 'mcp_discovered_1', label: 'Discovered Service' } };
  };

  const candidate = {
    id: 'cand_yaml_1',
    serviceId: 'mcp_discovered_1',
    fingerprint: 'hmac_sha256_candidate_fp_value',
    sourceConfigPath: 'C:\\Users\\test\\.config\\mcp.yaml'
  };

  await mockImportApi(`/api/discovery/${candidate.id}/import`, {
    method: 'POST',
    body: JSON.stringify({
      expectedFingerprint: candidate.fingerprint,
      expectedRevision: 14,
      mergeProfileId: 'profile_prod'
    })
  });

  assert.strictEqual(importRequests.length, 1);
  assert.strictEqual(importRequests[0].path, '/api/discovery/cand_yaml_1/import');
  assert.strictEqual(importRequests[0].body.expectedFingerprint, 'hmac_sha256_candidate_fp_value');
  assert.strictEqual(importRequests[0].body.expectedRevision, 14);
  assert.strictEqual(importRequests[0].body.mergeProfileId, 'profile_prod');
  // Raw content or secrets must not be in the body
  assert.strictEqual('apiKey' in importRequests[0].body, false);
  assert.strictEqual('raw' in importRequests[0].body, false);
});

test('3.4 revealLocationPath awaits reply and shows canonical success message "已请求打开所在目录" on opened: true, and safe failure on opened: false or error', async (t) => {
  const origFetch = globalThis.fetch;
  const origDocument = globalThis.document;

  const mockActionFeedback = {
    id: 'locations-action-feedback',
    role: 'status',
    textContent: '',
    className: 'locations-feedback-msg hidden',
    classList: {
      add: (c) => { mockActionFeedback.className += ` ${c}`; },
      remove: (c) => { mockActionFeedback.className = mockActionFeedback.className.replace(c, '').trim(); },
      contains: (c) => mockActionFeedback.className.includes(c)
    }
  };

  const mockFeedback = {
    id: 'locations-feedback',
    role: 'status',
    textContent: '',
    className: 'locations-feedback-msg hidden',
    classList: {
      add: (c) => { mockFeedback.className += ` ${c}`; },
      remove: (c) => { mockFeedback.className = mockFeedback.className.replace(c, '').trim(); },
      contains: (c) => mockFeedback.className.includes(c)
    }
  };

  const elements = {
    'locations-action-feedback': mockActionFeedback,
    'locations-feedback': mockFeedback
  };

  globalThis.document = {
    getElementById: (id) => elements[id] || null
  };
  dom.locationsFeedback = mockActionFeedback;

  t.after(() => {
    globalThis.fetch = origFetch;
    globalThis.document = origDocument;
  });

  // Scenario A: API responds with { opened: true } -> MUST show exact canonical message "已请求打开所在目录"
  globalThis.fetch = async (url, options) => {
    assert.match(url, /\/api\/mcps\/mcp_test_srv\/reveal/);
    assert.strictEqual(options.method, 'POST');
    return {
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ ok: true, opened: true, role: 'sourceConfig' })
    };
  };

  await revealLocationPath('mcp_test_srv', 'sourceConfig');
  assert.strictEqual(mockActionFeedback.textContent, '已请求打开所在目录', 'Must show exact canonical Chinese success message');
  assert.strictEqual(mockActionFeedback.role, 'status', 'Must have role=status for accessibility');
  assert.strictEqual(mockFeedback.textContent, '已请求打开所在目录', 'Dual ID compatibility: secondary element must also be updated');
  assert.strictEqual(mockFeedback.role, 'status', 'Must have role=status on secondary element');
  assert.match(mockActionFeedback.className, /alert-success/);

  // Scenario B: API responds with { opened: false } -> MUST show safe failure message, never success
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: () => 'application/json' },
    json: async () => ({ ok: false, opened: false, message: 'Directory does not exist' })
  });

  await revealLocationPath('mcp_test_srv', 'installation');
  assert.notStrictEqual(mockActionFeedback.textContent, '已请求打开所在目录', 'Must not show success message on opened: false');
  assert.match(mockActionFeedback.textContent, /未能打开|Directory does not exist/);
  assert.match(mockActionFeedback.className, /alert-error/);

  // Scenario C: API throws HTTP error (e.g. 404 MCP_NOT_FOUND) -> MUST show safe failure
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    statusText: 'Not Found',
    headers: { get: () => 'application/json' },
    json: async () => ({ error: { code: 'MCP_NOT_FOUND', message: 'MCP service not found' } })
  });

  await revealLocationPath('mcp_missing', 'executable');
  assert.notStrictEqual(mockActionFeedback.textContent, '已请求打开所在目录');
  assert.match(mockActionFeedback.textContent, /无法打开目录/);
  assert.match(mockActionFeedback.className, /alert-error/);
});

test('3.5 HTTP URL edit modal keeps input blank by default with placeholder when urlConfigured is true', (t) => {
  const origDocument = globalThis.document;

  function makeMockElement(id = '') {
    const classes = new Set();
    const children = [];
    return {
      id,
      textContent: '',
      value: '',
      placeholder: '',
      className: '',
      disabled: false,
      checked: false,
      dataset: {},
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c)
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
      appendChild: (child) => children.push(child),
      removeChild: (child) => {
        const idx = children.indexOf(child);
        if (idx !== -1) children.splice(idx, 1);
      },
      reset: function() { this.value = ''; }
    };
  }

  // Setup mock DOM elements for MCP modal
  dom.mcpModal = makeMockElement('mcp-modal');
  dom.mcpModalTitle = makeMockElement('mcp-modal-title');
  dom.mcpModalBadge = makeMockElement('mcp-modal-badge');
  dom.mcpForm = makeMockElement('mcp-form');
  dom.mcpFormId = makeMockElement('mcp-form-id');
  dom.mcpFormLabel = makeMockElement('mcp-form-label');
  dom.mcpFormEnabled = makeMockElement('mcp-form-enabled');
  dom.mcpFormType = makeMockElement('mcp-form-type');
  dom.mcpFormUrl = makeMockElement('mcp-form-url');
  dom.mcpFormExecutable = makeMockElement('mcp-form-executable');
  dom.mcpFormCwd = makeMockElement('mcp-form-cwd');
  dom.mcpArgsContainer = makeMockElement('mcp-args-container');
  dom.mcpHeadersContainer = makeMockElement('mcp-headers-container');
  dom.mcpEnvContainer = makeMockElement('mcp-env-container');
  dom.mcpModalError = makeMockElement('mcp-modal-error');
  dom.mcpStdioFields = makeMockElement('mcp-stdio-fields');
  dom.mcpHttpFields = makeMockElement('mcp-http-fields');

  t.after(() => {
    globalThis.document = origDocument;
  });

  globalThis.document = {
    createElement: (tag) => makeMockElement(tag),
    getElementById: (id) => dom[id] || null
  };

  // Case A: Existing HTTP MCP with urlConfigured: true and secret query
  const existingConfiguredMcp = {
    id: 'mcp-http-sec',
    label: 'Secret HTTP MCP',
    enabled: true,
    binding: {
      type: 'http',
      urlConfigured: true,
      hasPrivateQuery: true,
      urlDisplay: 'https://api.internal.corp/sse',
      headers: {
        'Authorization': { secret: true, configured: true }
      }
    }
  };

  openEditMcpModal(existingConfiguredMcp);

  // Edit URL input must remain blank by default
  assert.strictEqual(dom.mcpFormUrl.value, '', 'Edit URL input must remain blank by default');
  assert.strictEqual(dom.mcpFormUrl.placeholder, '[已配置 - 留空保留]', 'Placeholder must indicate configured secret retention');

  // Case B: Open Add MCP modal - placeholder must be standard example and value blank
  openAddMcpModal();
  assert.strictEqual(dom.mcpFormUrl.value, '');
  assert.match(dom.mcpFormUrl.placeholder, /例如：http/);
});

test('3.6 handleMcpFormSubmit enforces required URL on create, and safely omits URL on blank/unchanged edit', async (t) => {
  const origFetch = globalThis.fetch;
  const origDocument = globalThis.document;

  function makeMockElement(id = '') {
    const classes = new Set();
    const children = [];
    return {
      id,
      textContent: '',
      value: '',
      placeholder: '',
      className: '',
      disabled: false,
      checked: true,
      dataset: {},
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c)
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
      appendChild: (child) => children.push(child),
      removeChild: (child) => {
        const idx = children.indexOf(child);
        if (idx !== -1) children.splice(idx, 1);
      },
      reset: function() { this.value = ''; }
    };
  }

  dom.mcpModal = makeMockElement('mcp-modal');
  dom.mcpModalTitle = makeMockElement('mcp-modal-title');
  dom.mcpModalBadge = makeMockElement('mcp-modal-badge');
  dom.mcpForm = makeMockElement('mcp-form');
  dom.mcpFormId = makeMockElement('mcp-form-id');
  dom.mcpFormLabel = makeMockElement('mcp-form-label');
  dom.mcpFormEnabled = makeMockElement('mcp-form-enabled');
  dom.mcpFormType = makeMockElement('mcp-form-type');
  dom.mcpFormUrl = makeMockElement('mcp-form-url');
  dom.mcpFormExecutable = makeMockElement('mcp-form-executable');
  dom.mcpFormCwd = makeMockElement('mcp-form-cwd');
  dom.mcpArgsContainer = makeMockElement('mcp-args-container');
  dom.mcpHeadersContainer = makeMockElement('mcp-headers-container');
  dom.mcpEnvContainer = makeMockElement('mcp-env-container');
  dom.mcpModalError = makeMockElement('mcp-modal-error');
  dom.mcpStdioFields = makeMockElement('mcp-stdio-fields');
  dom.mcpHttpFields = makeMockElement('mcp-http-fields');

  globalThis.document = {
    createElement: (tag) => makeMockElement(tag),
    getElementById: (id) => dom[id] || null
  };

  t.after(() => {
    globalThis.fetch = origFetch;
    globalThis.document = origDocument;
  });

  const fakeEvent = { preventDefault: () => {} };

  // Scenario 1: Create mode with blank URL -> MUST reject with validation error
  dom.mcpFormId.value = '';
  dom.mcpFormLabel.value = 'New HTTP Service';
  dom.mcpFormType.value = 'http';
  dom.mcpFormUrl.value = '';
  dom.mcpModalError.textContent = '';

  await handleMcpFormSubmit(fakeEvent);
  assert.match(dom.mcpModalError.textContent, /\[VALIDATION_ERROR\] 请填写远程 HTTP \/ SSE 服务地址/);

  // Scenario 2: Create mode with masked ellipsis URL -> MUST reject
  dom.mcpFormUrl.value = 'https://api.example.com/sse?...';
  await handleMcpFormSubmit(fakeEvent);
  assert.match(dom.mcpModalError.textContent, /不能包含掩码/);

  // Scenario 3: Edit mode with blank URL -> MUST succeed and omit url in PATCH payload
  appState.mcps = [{
    id: 'mcp_existing_http',
    label: 'Existing HTTP',
    binding: { type: 'http', url: 'https://secret.internal/sse?token=xyz' },
    environment: []
  }];
  appState.revision = 7;

  let patchSentBody = null;
  globalThis.fetch = async (url, options) => {
    if (options.method === 'PATCH') {
      patchSentBody = JSON.parse(options.body);
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ ok: true, revision: 8 })
      };
    }
    // reload dashboard data
    return {
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ mcps: [], profiles: [], operations: [], revision: 8 })
    };
  };

  dom.mcpFormId.value = 'mcp_existing_http';
  dom.mcpFormLabel.value = 'Updated Label';
  dom.mcpFormType.value = 'http';
  dom.mcpFormUrl.value = ''; // Blank edit
  dom.mcpModalError.textContent = '';

  await handleMcpFormSubmit(fakeEvent);
  assert.ok(patchSentBody, 'PATCH request must be dispatched');
  assert.strictEqual(patchSentBody.label, 'Updated Label');
  assert.strictEqual('url' in patchSentBody.binding, false, 'Blank URL on edit MUST be omitted in PATCH payload');
});

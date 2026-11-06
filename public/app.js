/**
 * MCP Tunnel 账户管理器 - Frontend Application
 * Vanilla ES Module / JavaScript, Zero External Dependencies
 */

// Safe uppercase error code dictionary for localized friendly explanations
export const SAFE_ERROR_MESSAGES = {
  AUTH_REQUIRED: '需要管理员身份认证，请登录后继续。',
  UNAUTHORIZED: '管理员密码或凭据不正确，或者会话已失效。',
  INVALID_CREDENTIALS: '管理员密码或凭据不正确。',
  INITIALIZATION_REQUIRED: '系统尚未初始化，请先设置主管理员密码。',
  ALREADY_CONFIGURED: '系统已完成初始化，不能重复配置密码。',
  CSRF_TOKEN_INVALID: 'CSRF 安全令牌验证失败或已失效，请重试。',
  IDEMPOTENCY_CONFLICT: '操作正在处理中或幂等键冲突，请勿重复提交。',
  PROFILE_NOT_FOUND: '请求的配置文件不存在或已被移除。',
  ACTIVE_PROFILE_CANNOT_BE_DELETED: '当前处于活跃状态的配置不允许删除。',
  OPERATION_FAILED: '操作执行失败，请检查服务状态。',
  OPERATION_IN_PROGRESS: '已有操作任务正在进行中，请等待其执行完成。',
  NEEDS_ATTENTION: '操作在校验阶段异常，已触发安全恢复闸门，需人工介入排查。',
  VALIDATION_ERROR: '提交的表单数据格式校验不通过。',
  SERVICE_UNAVAILABLE: '目标 MCP 隧道服务当前无法连通。',
  INTERNAL_SERVER_ERROR: '服务器内部遇到未知异常。',
  INTERNAL_ERROR: '服务器内部遇到未知异常。',
  FORBIDDEN: '请求被拒绝或权限不足。',
  NOT_FOUND: '请求的配置文件或资源不存在。',
  BAD_REQUEST: '请求参数或格式不正确。',
  CONFLICT: '数据版本冲突或状态冲突，请刷新后重试。',
  // Registry & MCP Lifecycle Error Codes
  MCP_NOT_FOUND: '请求的 MCP 服务不存在或已被删除。',
  MCP_RUNNING: '目标 MCP 服务正在运行中，必须先停止服务后方可移除。',
  MCP_BUSY: '目标 MCP 服务正在执行其他操作，请稍候再试。',
  MCP_DISABLED: '目标 MCP 服务已禁用，不可启动或执行切换。',
  RUNTIME_STATE_UNKNOWN: '服务处于未知运行状态，请先刷新或排查，避免产生孤儿进程。',
  REVISION_CONFLICT: '数据版本冲突，配置可能已被其他并发操作修改，请刷新后重试。',
  INVALID_TARGETS: '目标服务列表不合法或包含未注册/已禁用的服务。',
  INVALID_REGISTRY: '注册表配置异常，请刷新重试。',
  STOP_UNCONFIRMED: '服务停止未能确认已安全退出，请检查进程状态。',
  SOURCE_CHANGED: '来源配置文件在导入前已被外部修改，请重新扫描。',
  DISCOVERY_FAILED: '配置扫描发现失败。',
  IMPORT_FAILED: '配置导入失败。',
  REVEAL_FAILED: '打开目录失败，请检查路径是否存在或具有相应系统权限。',
  INVALID_ENV_PATCH: '环境变量补丁格式不正确。',
  INVALID_ENV_NAME: '环境变量名称不合法。',
  RESERVED_ENV_NAME: '环境变量名称为系统保留，不可占用。',
  INVALID_ENV_VALUE: '环境变量值包含不合法字符或超出长度限制。',
  // Lifecycle & Tunnel Client Error Codes
  STATE_REFRESH_REQUIRED: '状态需要刷新，请重新获取最新服务状态。',
  EXTERNAL_CLIENT_NOT_MANAGED: '检测到外部运行的隧道客户端（未接管），不可通过控制台操作。',
  STATE_UNVERIFIED: '服务进程状态未验证，无法执行操作。',
  PROCESS_IDENTITY_MISMATCH: '进程标识与受管记录不匹配，安全拒绝操作。',
  PROFILE_CHANGE_REQUIRES_RESTART: '当前服务正在运行，变更运行账号必须先停止或重启。',
  CARRIER_CONFIRMATION_REQUIRED: '当前服务承载控制平面连接，需要确认方可停止或重启。',
  SERVICE_DISABLED: '服务已禁用，无法启动隧道。',
  PROFILE_REQUIRED: '必须指定适用的运行账号 / Profile。',
  PROFILE_NOT_CONFIGURED: '选定账号未配置该服务的凭证或配置不存在。',
  EXECUTABLE_NOT_FOUND: '未找到隧道客户端可执行文件。',
  SERVICE_NOT_MANAGED: '目标服务非受管隧道服务。',
  INVALID_ACTION: '不受支持的操作动作。',
  ALREADY_RUNNING: '隧道客户端已在运行中。',
  ALREADY_STOPPED: '隧道客户端已处于停止状态。',
  SWITCH_FAILED: '切换未完成，请检查目标服务及配置。',
  VERIFY_FAILED: '目标隧道未通过严格健康与认证校验。',
  TARGET_VERIFICATION_UNAVAILABLE: '目标服务的切换前置检查未通过。',
  TARGET_VERIFICATION_UNCONFIRMED: '未取得目标隧道的有效认证凭据证明。',
  HTTP_UPSTREAM_UNREACHABLE: '本机 HTTP MCP 上游未监听或不可达。请先启动兼容的服务；暂不使用时可禁用该 MCP，配置和密钥会保留。',
  HEALTH_URL_REQUIRED: '未取得隧道的本机健康检查地址。',
  NON_LOOPBACK_HEALTH_URL: '健康检查地址不是本机回环地址，已安全拒绝。',
  CONTROL_PLANE_UNREACHABLE: '隧道健康或状态接口不可达，请检查进程及本机网络。',
  RUNTIME_NOT_READY: '隧道尚未就绪，请检查 MCP 上游、代理和隧道日志。',
  CONTROL_PLANE_NOT_AUTHENTICATED: '控制平面尚未完成有效认证，请检查凭据、授权和网络。',
  CONTROL_PLANE_EVIDENCE_UNCONFIRMED: '控制平面认证证据不完整。',
  STALE_CONTROL_PLANE_EVIDENCE: '控制平面认证轮询证据已过期。',
  TARGET_CONFIG_UNCONFIRMED: '当前配置与本次切换目标不一致。',
  PROCESS_IDENTITY_UNCONFIRMED: '无法确认健康接口对应的进程身份。',
  UNSUPPORTED_TUNNEL_VERSION: '隧道客户端版本不受支持。',
  RUNTIME_INSTANCE_MISMATCH: '健康与状态接口来自不同的隧道实例。',
  TARGET_TUNNEL_MISMATCH: '隧道账号或控制平面地址与目标不一致。',
  TARGET_ORIGIN_MISMATCH: '控制平面地址校验未通过。',
  STALE_RUNTIME_EVIDENCE: '隧道运行证据已过期。',
  INVALID_EVIDENCE_TIMESTAMP: '隧道证据的时间戳不合法。',
  INTERRUPTED: '上次切换被中断，已执行恢复流程。'
};

// Application reactive state
export const appState = {
  configured: false,
  authenticated: false,
  csrfToken: null,
  revision: null,
  systemStatus: 'HEALTHY',
  profiles: [],
  activeProfileId: null,
  activeProfileIds: new Set(),
  mcps: [],
  mcpLocations: new Map(),
  discoveryCandidates: [],
  activeTab: 'accounts', // 'accounts' | 'mcps'
  currentOperation: null,
  operationPollingTimer: null,
  lifecycleStopTimer: null,
  selectedLifecycleMcp: null,
  selectedCandidate: null,
  selectedTunnelActionMcp: null,
  selectedTunnelActionKind: null,
  tunnelActionCarrierToken: null,
  tunnelActionIdempotencyKey: null,
  tunnelActionTimer: null
};

// ==========================================================================
// Pure Utilities & Domain Helpers
// ==========================================================================

// Do not echo raw operation messages or probe errors (they may contain secrets).
export function formatOperationFailure(op = {}, mcps = appState.mcps) {
  const code = typeof op.failureCode === 'string' && Object.hasOwn(SAFE_ERROR_MESSAGES, op.failureCode)
    ? op.failureCode : 'SWITCH_FAILED';
  const reason = typeof op.failureReason === 'string' &&
    Object.hasOwn(SAFE_ERROR_MESSAGES, op.failureReason) ? op.failureReason : null;
  const service = typeof op.failureService === 'string' &&
    /^(?:overleaf-mcp|antigravity-mcp|mcp_[a-z0-9][a-z0-9_-]{0,63})$/.test(op.failureService) &&
    Array.isArray(op.targets) && op.targets.includes(op.failureService) ? op.failureService : null;
  const label = service ? (mcps.find(mcp => mcp.id === service)?.label || service) : null;
  const explanation = SAFE_ERROR_MESSAGES[reason || code] || SAFE_ERROR_MESSAGES.SWITCH_FAILED;
  return `${label ? `服务「${label}」：` : ''}${explanation} [${code}${reason ? ` / ${reason}` : ''}]`;
}

export function maskTunnelId(id) {
  if (!id || typeof id !== 'string') return '-';
  const trimmed = id.trim();
  if (!trimmed) return '-';
  if (trimmed.length <= 8) return 'tunnel_***';
  if (trimmed.startsWith('tunnel_') || trimmed.startsWith('tun_')) {
    const prefix = trimmed.slice(0, trimmed.indexOf('_') + 1);
    const suffix = trimmed.slice(-4);
    return `${prefix}***${suffix}`;
  }
  return `${trimmed.slice(0, 4)}***${trimmed.slice(-4)}`;
}

export function generateIdempotencyKey() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'key_' + Date.now() + '_' + Math.random().toString(36).substring(2, 10);
}

export function parseSafeErrorCode(errorResponse) {
  if (!errorResponse) return 'UNKNOWN_ERROR';
  if (typeof errorResponse === 'string') return errorResponse.toUpperCase();
  if (errorResponse.error && typeof errorResponse.error === 'object') {
    return parseSafeErrorCode(errorResponse.error);
  }
  return (
    errorResponse.code ||
    errorResponse.errorCode ||
    (typeof errorResponse.error === 'string' ? errorResponse.error : null) ||
    'OPERATION_FAILED'
  ).toString().toUpperCase();
}

export function formatSafeError(errorObj) {
  const errData = errorObj?.data || {};
  const innerError = errData.error && typeof errData.error === 'object' ? errData.error : errData;
  const code = parseSafeErrorCode(errData || errorObj?.message);
  const localized = SAFE_ERROR_MESSAGES[code] || innerError.message || errData.message || errorObj?.message || '发生未知异常';
  return {
    code,
    message: localized,
    displayText: `[${code}] ${localized}`
  };
}

export function isProfileActive(profileId) {
  if (!profileId) return false;
  return appState.activeProfileIds?.has(profileId) || profileId === appState.activeProfileId;
}

export function isSensitiveEnvName(name) {
  if (!name || typeof name !== 'string') return false;
  return /KEY|TOKEN|SECRET|PASS|AUTH|COOKIE|CREDENTIAL/i.test(name);
}

export function canDeleteMcp(mcp) {
  const tcState = (mcp?.runtime?.tunnelClient?.state || '').toLowerCase();

  if (tcState === 'running' || tcState === 'starting' || tcState === 'restarting') {
    return { allowed: false, reason: 'MCP_RUNNING', requiredAction: 'stop' };
  }
  if (tcState === 'unmanaged') {
    return { allowed: false, reason: 'RUNTIME_STATE_UNMANAGED', requiredAction: 'unmanaged' };
  }
  if (tcState === 'unknown' || !['stopped', 'failed', 'unobserved', 'not_running', 'never_started', ''].includes(tcState)) {
    return { allowed: false, reason: 'RUNTIME_STATE_UNKNOWN', requiredAction: 'refresh' };
  }
  return { allowed: true, requiredAction: 'delete' };
}

export function buildEnvironmentPatch(previous = [], rows = []) {
  const patch = [];
  const currentMap = new Map();
  for (const r of rows) {
    const name = (r.name || '').trim();
    if (!name) continue;
    currentMap.set(name.toUpperCase(), r);
  }

  // Check for removals of previously configured env vars
  for (const prev of previous) {
    const prevName = typeof prev === 'string' ? prev : prev.name;
    if (!prevName) continue;
    if (!currentMap.has(prevName.toUpperCase())) {
      patch.push({ op: 'remove', name: prevName });
    }
  }

  // Check for new or updated variables
  for (const [upper, r] of currentMap.entries()) {
    const name = r.name.trim();
    const val = r.value !== undefined ? String(r.value) : '';
    const isSensitive = isSensitiveEnvName(name);
    const secret = isSensitive || r.secret !== false;

    // If editing existing configured env and value left blank or masked, omit to retain
    if (r.configured && (val === '' || val === '***' || val === '[已配置 - 留空保留]')) {
      continue;
    }

    patch.push({
      op: 'set',
      name,
      value: val,
      secret
    });
  }

  return patch;
}

export function buildBindingArgs(previousArgs = [], rows = []) {
  const args = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const val = r.value !== undefined ? String(r.value) : '';
    const id = r.id || `arg_${i}`;
    const secret = r.secret !== false;

    // If existing and value left blank/masked, omit value to preserve existing secret
    if (r.configured && (val === '' || val === '***' || val === '[已配置 - 留空保留]')) {
      args.push({ id, secret });
    } else {
      args.push({ id, value: val, secret });
    }
  }
  return args;
}

export function isSensitiveHeaderName(name) {
  if (!name || typeof name !== 'string') return false;
  const upper = name.toUpperCase();
  return /^(AUTHORIZATION|PROXY-AUTHORIZATION|X-API-KEY|API-KEY|TOKEN|COOKIE|SET-COOKIE|SECRET|PASSWORD|CREDENTIALS)/.test(upper) ||
         upper.includes('KEY') || upper.includes('TOKEN') || upper.includes('SECRET') || upper.includes('AUTH');
}

export function buildBindingPayload(type, {
  executable,
  cwd,
  argsRows = [],
  url,
  headersRows = [],
  isEditing = false,
  initialUrl = '',
  previousHeaders = {}
} = {}) {
  if (type === 'stdio') {
    const payload = {
      type: 'stdio',
      executable: (executable || '').trim()
    };
    if (cwd && cwd.trim()) {
      payload.cwd = cwd.trim();
    }
    payload.args = buildBindingArgs([], argsRows);
    return payload;
  }

  if (type === 'http') {
    const headers = {};
    const presentHeaderNames = new Set();

    for (const h of headersRows) {
      const name = (h.name || '').trim();
      if (!name) continue;
      presentHeaderNames.add(name);

      const val = h.value !== undefined ? String(h.value).trim() : '';
      const secret = h.secret !== false;
      const isConfigured = Boolean(h.configured);

      // If configured and left blank (or placeholder), omit value to retain existing secret on backend
      if (isConfigured && (!val || val === '[已配置 - 留空保留]' || val.includes('***') || val.includes('...'))) {
        headers[name] = { secret };
      } else if (val) {
        headers[name] = { value: val, secret };
      } else if (!isConfigured) {
        continue;
      }
    }

    // Explicit remove for headers that were in previousHeaders but omitted from headersRows
    if (previousHeaders && typeof previousHeaders === 'object') {
      const prevKeys = Array.isArray(previousHeaders)
        ? previousHeaders.map(item => item?.name).filter(Boolean)
        : Object.keys(previousHeaders);
      for (const prevName of prevKeys) {
        if (!presentHeaderNames.has(prevName)) {
          headers[prevName] = { op: 'remove' };
        }
      }
    }

    const payload = {
      type: 'http',
      headers
    };

    const trimmedUrl = (url || '').trim();
    const isMaskedUrl = trimmedUrl.includes('...') || trimmedUrl.includes('***');

    if (isEditing) {
      // In edit mode: if URL is blank, unchanged, or masked ellipsis, omit url to retain existing secret URL on backend
      if (trimmedUrl && !isMaskedUrl && trimmedUrl !== (initialUrl || '').trim()) {
        payload.url = trimmedUrl;
      }
      // If omitted, backend retains existing secret URL
    } else {
      // New service requires URL
      payload.url = trimmedUrl;
    }

    return payload;
  }

  throw new Error(`Unsupported binding type: ${type}`);
}

export function buildProfileServicesPayload(registeredMcps, inputsByServiceId, isEditing = false) {
  const servicesPayload = {};
  for (const mcp of registeredMcps) {
    const input = inputsByServiceId[mcp.id];
    if (!input) continue;

    const tunnelId = (input.tunnelId || '').trim();
    const apiKey = input.apiKey !== undefined ? String(input.apiKey).trim() : '';
    const orgId = (input.orgId || '').trim();

    const svcConfig = {};

    if (isEditing) {
      const initialTunnel = input.initialTunnelId || '';
      if (tunnelId && tunnelId !== initialTunnel && !tunnelId.includes('***')) {
        svcConfig.tunnelId = tunnelId;
      } else if (tunnelId && !tunnelId.includes('***')) {
        svcConfig.tunnelId = tunnelId;
      }
      if (orgId && orgId !== '已配置') {
        svcConfig.orgId = orgId;
      }
      // Blank apiKey on PATCH is omitted so the existing key is preserved
      if (apiKey && apiKey !== '***' && apiKey !== '[已配置 - 留空保留]') {
        svcConfig.apiKey = apiKey;
      }
    } else {
      if (tunnelId) svcConfig.tunnelId = tunnelId;
      if (orgId) svcConfig.orgId = orgId;
      if (apiKey) svcConfig.apiKey = apiKey;
    }

    if (Object.keys(svcConfig).length > 0 || !isEditing) {
      servicesPayload[mcp.id] = svcConfig;
    }
  }
  return servicesPayload;
}

export function escapeHtml(str) {
  if (str === undefined || str === null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ==========================================================================
// DOM Elements Cache
// ==========================================================================

export const dom = {};

export function initDomReferences() {
  if (typeof document === 'undefined') return;

  // Header & Status
  dom.revisionValue = document.getElementById('revision-value');
  dom.statusValue = document.getElementById('status-value');
  dom.headerStatusBadge = document.getElementById('header-status-badge');
  dom.btnRefreshState = document.getElementById('btn-refresh-state');
  dom.btnLogout = document.getElementById('btn-logout');

  // Notifications
  dom.globalAlert = document.getElementById('global-alert');
  dom.globalAlertIcon = document.getElementById('global-alert-icon');
  dom.globalAlertTitle = document.getElementById('global-alert-title');
  dom.globalAlertMessage = document.getElementById('global-alert-message');
  dom.btnCloseAlert = document.getElementById('btn-close-alert');

  dom.needsAttentionBanner = document.getElementById('needs-attention-banner');
  dom.needsAttentionMessage = document.getElementById('needs-attention-message');
  dom.needsAttentionDetails = document.getElementById('needs-attention-details');
  dom.btnConfirmRecovery = document.getElementById('btn-confirm-recovery');
  dom.btnDismissNeedsAttention = document.getElementById('btn-dismiss-needs-attention');

  // Auth Containers
  dom.authContainer = document.getElementById('auth-container');
  dom.setupCard = document.getElementById('setup-card');
  dom.loginCard = document.getElementById('login-card');
  dom.dashboardView = document.getElementById('dashboard-view');

  // Setup Form
  dom.setupForm = document.getElementById('setup-form');
  dom.setupBootstrapCode = document.getElementById('setup-bootstrap-code');
  dom.setupPassword = document.getElementById('setup-password');
  dom.setupConfirmPassword = document.getElementById('setup-confirm-password');
  dom.setupError = document.getElementById('setup-error');

  // Login Form
  dom.loginForm = document.getElementById('login-form');
  dom.loginPassword = document.getElementById('login-password');
  dom.loginError = document.getElementById('login-error');

  // Nav Tabs & Sections
  dom.tabNavAccounts = document.getElementById('tab-nav-accounts');
  dom.tabNavMcps = document.getElementById('tab-nav-mcps');
  dom.badgeMcpsCount = document.getElementById('badge-mcps-count');
  dom.sectionAccounts = document.getElementById('section-accounts');
  dom.sectionMcps = document.getElementById('section-mcps');

  // Switch Control
  dom.switchTargetsContainer = document.getElementById('switch-targets-container');
  dom.switchProfileSelect = document.getElementById('switch-profile-select');
  dom.switchSelectedProfileInfo = document.getElementById('switch-selected-profile-info');
  dom.btnExecuteSwitch = document.getElementById('btn-execute-switch');

  // Operation Progress Card
  dom.operationProgressCard = document.getElementById('operation-progress-card');
  dom.opPhaseBadge = document.getElementById('op-phase-badge');
  dom.opIdDisplay = document.getElementById('op-id-display');
  dom.opIdempotencyDisplay = document.getElementById('op-idempotency-display');
  dom.opStatusMessage = document.getElementById('op-status-message');
  dom.opTimestamp = document.getElementById('op-timestamp');
  dom.stepTerminalLabel = document.getElementById('step-terminal-label');

  // Profiles
  dom.btnOpenCreateModal = document.getElementById('btn-open-create-modal');
  dom.profilesContainer = document.getElementById('profiles-container');

  // Profile Modal
  dom.profileModal = document.getElementById('profile-modal');
  dom.modalTitle = document.getElementById('modal-title');
  dom.modalBadge = document.getElementById('modal-badge');
  dom.btnCloseModal = document.getElementById('btn-close-modal');
  dom.profileForm = document.getElementById('profile-form');
  dom.formProfileId = document.getElementById('form-profile-id');
  dom.formProfileLabel = document.getElementById('form-profile-label');
  dom.profileServicesContainer = document.getElementById('profile-services-container');
  dom.modalFormError = document.getElementById('modal-form-error');
  dom.btnModalDeleteProfile = document.getElementById('btn-modal-delete-profile');
  dom.btnModalCancel = document.getElementById('btn-modal-cancel');
  dom.btnModalSave = document.getElementById('btn-modal-save');

  // MCP Services Section
  dom.btnScanDiscovery = document.getElementById('btn-scan-discovery');
  dom.btnOpenAddMcp = document.getElementById('btn-open-add-mcp');
  dom.mcpsPendingBanner = document.getElementById('mcps-pending-banner');
  dom.mcpsContainer = document.getElementById('mcps-container');

  // Discovery Preview Section
  dom.discoverySection = document.getElementById('discovery-section');
  dom.btnRescanDiscovery = document.getElementById('btn-rescan-discovery');
  dom.btnCloseDiscovery = document.getElementById('btn-close-discovery');
  dom.discoveryCandidatesContainer = document.getElementById('discovery-candidates-container');
  dom.discoveryInventoryContainer = document.getElementById('discovery-inventory-container');

  // MCP Add/Edit Modal
  dom.mcpModal = document.getElementById('mcp-modal');
  dom.mcpModalTitle = document.getElementById('mcp-modal-title');
  dom.mcpModalBadge = document.getElementById('mcp-modal-badge');
  dom.btnCloseMcpModal = document.getElementById('btn-close-mcp-modal');
  dom.mcpForm = document.getElementById('mcp-form');
  dom.mcpFormId = document.getElementById('mcp-form-id');
  dom.mcpFormLabel = document.getElementById('mcp-form-label');
  dom.mcpFormType = document.getElementById('mcp-form-type');
  dom.mcpFormEnabled = document.getElementById('mcp-form-enabled');
  dom.mcpStdioFields = document.getElementById('mcp-stdio-fields');
  dom.mcpFormExecutable = document.getElementById('mcp-form-executable');
  dom.mcpFormCwd = document.getElementById('mcp-form-cwd');
  dom.mcpArgsContainer = document.getElementById('mcp-args-container');
  dom.btnAddArg = document.getElementById('btn-add-arg');
  dom.mcpHttpFields = document.getElementById('mcp-http-fields');
  dom.mcpFormUrl = document.getElementById('mcp-form-url');
  dom.mcpHeadersContainer = document.getElementById('mcp-headers-container');
  dom.btnAddHeader = document.getElementById('btn-add-header');
  dom.mcpEnvContainer = document.getElementById('mcp-env-container');
  dom.btnAddEnv = document.getElementById('btn-add-env');
  dom.mcpModalError = document.getElementById('mcp-modal-error');
  dom.btnMcpCancel = document.getElementById('btn-mcp-cancel');
  dom.btnMcpSave = document.getElementById('btn-mcp-save');

  // MCP Locations Modal
  dom.mcpLocationsModal = document.getElementById('mcp-locations-modal');
  dom.locationsModalTitle = document.getElementById('locations-modal-title');
  dom.btnCloseLocationsModal = document.getElementById('btn-close-locations-modal');
  dom.btnCloseLocationsFooter = document.getElementById('btn-close-locations-footer');
  dom.locationsServiceSummary = document.getElementById('locations-service-summary');
  dom.locationsFeedback = document.getElementById('locations-action-feedback') || document.getElementById('locations-feedback');

  // MCP Stop/Delete Lifecycle Modal
  dom.mcpLifecycleModal = document.getElementById('mcp-lifecycle-modal');
  dom.lifecycleModalTitle = document.getElementById('lifecycle-modal-title');
  dom.lifecycleModalBadge = document.getElementById('lifecycle-modal-badge');
  dom.btnCloseLifecycleModal = document.getElementById('btn-close-lifecycle-modal');
  dom.lifecycleBodyRunning = document.getElementById('lifecycle-body-running');
  dom.btnLifecycleStop = document.getElementById('btn-lifecycle-stop');
  dom.lifecycleStopProgress = document.getElementById('lifecycle-stop-progress');
  dom.lifecycleStopMsg = document.getElementById('lifecycle-stop-msg');
  dom.lifecycleBodyUnknown = document.getElementById('lifecycle-body-unknown');
  dom.lifecycleBodyStopped = document.getElementById('lifecycle-body-stopped');
  dom.btnLifecycleDelete = document.getElementById('btn-lifecycle-delete');
  dom.btnLifecycleCancel = document.getElementById('btn-lifecycle-cancel');
  dom.lifecycleError = document.getElementById('lifecycle-error');

  // Tunnel Lifecycle Action Modal (Start / Stop / Restart)
  dom.tunnelActionModal = document.getElementById('tunnel-action-modal');
  dom.tunnelActionModalBadge = document.getElementById('tunnel-action-modal-badge');
  dom.tunnelActionModalTitle = document.getElementById('tunnel-action-modal-title');
  dom.btnCloseTunnelActionModal = document.getElementById('btn-close-tunnel-action-modal');
  dom.tunnelActionServiceDesc = document.getElementById('tunnel-action-service-desc');
  dom.tunnelActionProfileGroup = document.getElementById('tunnel-action-profile-group');
  dom.tunnelActionProfileSelect = document.getElementById('tunnel-action-profile-select');
  dom.tunnelActionCarrierWarning = document.getElementById('tunnel-action-carrier-warning');
  dom.tunnelActionPrompt = document.getElementById('tunnel-action-prompt');
  dom.tunnelActionProgress = document.getElementById('tunnel-action-progress');
  dom.tunnelActionMsg = document.getElementById('tunnel-action-msg');
  dom.tunnelActionError = document.getElementById('tunnel-action-error');
  dom.btnTunnelActionCancel = document.getElementById('btn-tunnel-action-cancel');
  dom.btnTunnelActionConfirm = document.getElementById('btn-tunnel-action-confirm');

  // Discovery Import Modal
  dom.discoveryImportModal = document.getElementById('discovery-import-modal');
  dom.importModalTitle = document.getElementById('import-modal-title');
  dom.btnCloseImportModal = document.getElementById('btn-close-import-modal');
  dom.importCandidateInfo = document.getElementById('import-candidate-info');
  dom.importMergeProfileSelect = document.getElementById('import-merge-profile-select');
  dom.btnCancelImport = document.getElementById('btn-cancel-import');
  dom.btnConfirmImport = document.getElementById('btn-confirm-import');
  dom.importModalError = document.getElementById('import-modal-error');
}

// ==========================================================================
// HTTP Client Wrapper (with CSRF handling)
// ==========================================================================

export async function apiRequest(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = {
    'Accept': 'application/json',
    ...(options.headers || {})
  };

  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }

  // Include X-CSRF-Token on mutative requests
  if (appState.csrfToken && ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) {
    headers['X-CSRF-Token'] = appState.csrfToken;
  }

  let response;
  try {
    response = await fetch(path, {
      ...options,
      method,
      headers
    });
  } catch (networkErr) {
    const err = new Error('无法连接到管理后台服务，请检查网络或后端状态。');
    err.data = { code: 'SERVICE_UNAVAILABLE', message: networkErr.message };
    throw err;
  }

  // Update CSRF token if returned in header
  const headerCsrf = response.headers?.get?.('x-csrf-token') || response.headers?.get?.('X-CSRF-Token');
  if (headerCsrf) {
    appState.csrfToken = headerCsrf;
  }

  let data = null;
  const contentType = response.headers?.get?.('content-type') || '';
  if (contentType.includes('application/json')) {
    data = await response.json().catch(() => null);
  }

  if (data && data.csrfToken) {
    appState.csrfToken = data.csrfToken;
  }

  if (!response.ok) {
    const error = new Error(data?.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.data = data || { code: `HTTP_${response.status}`, message: response.statusText };
    throw error;
  }

  return data;
}

// ==========================================================================
// UI Notifications
// ==========================================================================

export function showAlert(type, title, message) {
  if (!dom.globalAlert) return;
  dom.globalAlert.className = `alert alert-${type}`;
  dom.globalAlertTitle.textContent = title;
  dom.globalAlertMessage.textContent = message;

  let iconSvg = '';
  if (type === 'success') {
    iconSvg = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  } else if (type === 'warning') {
    iconSvg = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>';
  } else {
    iconSvg = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>';
  }
  dom.globalAlertIcon.innerHTML = iconSvg;
  dom.globalAlert.classList.remove('alert-hidden');

  if (type === 'success') {
    setTimeout(() => {
      dom.globalAlert?.classList.add('alert-hidden');
    }, 5000);
  }
}

export function updateLocationsFeedback(message, className = 'locations-feedback-msg') {
  const targets = [];
  if (typeof document !== 'undefined') {
    const el1 = document.getElementById('locations-action-feedback');
    const el2 = document.getElementById('locations-feedback');
    if (el1) targets.push(el1);
    if (el2 && el2 !== el1) targets.push(el2);
  }
  if (targets.length === 0 && dom.locationsFeedback) {
    targets.push(dom.locationsFeedback);
  }

  for (const el of targets) {
    el.textContent = message;
    el.className = className;
    el.role = 'status';
    if (typeof el.setAttribute === 'function') {
      el.setAttribute('role', 'status');
    }
    if (el.classList && el.classList.remove) {
      el.classList.remove('hidden');
    }
  }
}

export function clearLocationsFeedback() {
  const targets = [];
  if (typeof document !== 'undefined') {
    const el1 = document.getElementById('locations-action-feedback');
    const el2 = document.getElementById('locations-feedback');
    if (el1) targets.push(el1);
    if (el2 && el2 !== el1) targets.push(el2);
  }
  if (targets.length === 0 && dom.locationsFeedback) {
    targets.push(dom.locationsFeedback);
  }

  for (const el of targets) {
    el.textContent = '';
    el.className = 'locations-feedback-msg hidden';
    if (el.classList && el.classList.add) {
      el.classList.add('hidden');
    }
  }
}

export function hideAlert() {
  dom.globalAlert?.classList.add('alert-hidden');
}

export function showNeedsAttentionBanner(details) {
  if (!dom.needsAttentionBanner) return;
  dom.needsAttentionBanner.classList.remove('alert-hidden');

  const reasonStr = typeof details === 'object' ? (details.reason || JSON.stringify(details)) : String(details);
  if (dom.needsAttentionDetails) {
    dom.needsAttentionDetails.textContent = typeof details === 'object'
      ? JSON.stringify(details, null, 2)
      : String(details);
  }

  const match = reasonStr.match(/\b(act_[a-z0-9_-]+|op_[a-z0-9_-]+)\b/i);
  const actionId = details?.actionId || (match ? match[1] : null);

  const isEligibleZeroEffect = Boolean(
    actionId && (
      reasonStr.includes('NOT_FOUND') ||
      reasonStr.includes('LIFECYCLE_ACTION_NOT_FOUND') ||
      reasonStr.includes('WORK_ITEM_NOT_FOUND') ||
      reasonStr.includes('SWITCH_OPERATION_NOT_FOUND') ||
      reasonStr.includes('PROFILE_NOT_FOUND') ||
      reasonStr.includes('SERVICE_NOT_FOUND')
    )
  );

  if (dom.needsAttentionMessage) {
    if (isEligibleZeroEffect) {
      dom.needsAttentionMessage.textContent = '启动请求在进程与配置变更前失败，修复更新已应用。请核对并确认解除该操作的恢复闸门。';
    } else {
      dom.needsAttentionMessage.textContent = '操作在执行阶段遇到异常，安全恢复闸门已锁定自动流程。请人工排查目标服务隧道连通性及凭证。';
    }
  }

  if (dom.btnConfirmRecovery) {
    if (isEligibleZeroEffect) {
      dom.btnConfirmRecovery.style.display = 'inline-block';
      dom.btnConfirmRecovery.disabled = false;
      dom.btnConfirmRecovery.dataset.actionId = actionId;
      dom.btnConfirmRecovery.textContent = '确认恢复';
    } else {
      dom.btnConfirmRecovery.style.display = 'none';
      dom.btnConfirmRecovery.disabled = true;
    }
  }
}

export function hideNeedsAttentionBanner() {
  dom.needsAttentionBanner?.classList.add('alert-hidden');
}

// ==========================================================================
// Auth & State Management
// ==========================================================================

export async function fetchAuthState() {
  try {
    const data = await apiRequest('/api/auth/state');
    appState.configured = !!(data.configured ?? data.isConfigured ?? data.initialized);
    appState.authenticated = !!(data.authenticated ?? data.isAuthenticated ?? data.loggedIn);
    if (data.csrfToken) {
      appState.csrfToken = data.csrfToken;
    }
    if (data.revision !== undefined && data.revision !== null) {
      appState.revision = data.revision;
    }
    if (data.status) {
      appState.systemStatus = data.status;
    }
    renderAuthViews();
    if (appState.authenticated) {
      await loadDashboardData();
    }
  } catch (err) {
    console.error('Failed to fetch auth state:', err);
    const parsed = formatSafeError(err);
    showAlert('error', '状态获取失败', parsed.displayText);
  }
}

export function renderAuthViews() {
  if (dom.revisionValue) {
    dom.revisionValue.textContent = appState.revision !== null ? `rev ${appState.revision}` : 'rev -';
  }

  if (!appState.configured) {
    dom.authContainer?.classList.remove('hidden');
    dom.setupCard?.classList.remove('hidden');
    dom.loginCard?.classList.add('hidden');
    dom.dashboardView?.classList.add('hidden');
    dom.btnLogout?.classList.add('hidden');
    if (dom.statusValue) dom.statusValue.textContent = '待初始化';
    if (dom.headerStatusBadge) dom.headerStatusBadge.className = 'badge badge-warning';
  } else if (!appState.authenticated) {
    dom.authContainer?.classList.remove('hidden');
    dom.setupCard?.classList.add('hidden');
    dom.loginCard?.classList.remove('hidden');
    dom.dashboardView?.classList.add('hidden');
    dom.btnLogout?.classList.add('hidden');
    if (dom.statusValue) dom.statusValue.textContent = '待认证';
    if (dom.headerStatusBadge) dom.headerStatusBadge.className = 'badge badge-warning';
  } else {
    dom.authContainer?.classList.add('hidden');
    dom.setupCard?.classList.add('hidden');
    dom.loginCard?.classList.add('hidden');
    dom.dashboardView?.classList.remove('hidden');
    dom.btnLogout?.classList.remove('hidden');
    if (dom.statusValue) dom.statusValue.textContent = '运行正常';
    if (dom.headerStatusBadge) dom.headerStatusBadge.className = 'badge badge-success';
  }
}

export async function handleSetupSubmit(e) {
  e.preventDefault();
  dom.setupError?.classList.add('hidden');
  const bootstrapCode = dom.setupBootstrapCode ? dom.setupBootstrapCode.value.trim() : '';
  const password = dom.setupPassword?.value || '';
  const confirmPassword = dom.setupConfirmPassword?.value || '';

  if (!bootstrapCode) {
    dom.setupError.textContent = '[VALIDATION_ERROR] 请输入从控制台或 bootstrap-code.txt 获取的引导秘钥。';
    dom.setupError.classList.remove('hidden');
    return;
  }

  if (password.length < 8) {
    dom.setupError.textContent = '[VALIDATION_ERROR] 管理员密码长度至少需要 8 位字符。';
    dom.setupError.classList.remove('hidden');
    return;
  }

  if (password !== confirmPassword) {
    dom.setupError.textContent = '[VALIDATION_ERROR] 两次输入的管理员密码不一致。';
    dom.setupError.classList.remove('hidden');
    return;
  }

  try {
    await apiRequest('/api/auth/setup', {
      method: 'POST',
      body: { bootstrapCode, password }
    });
    showAlert('success', '初始化成功', '系统管理员凭证已设置，欢迎使用。');
    dom.setupForm?.reset();
    await fetchAuthState();
  } catch (err) {
    const parsed = formatSafeError(err);
    if (dom.setupError) {
      dom.setupError.textContent = parsed.displayText;
      dom.setupError.classList.remove('hidden');
    }
  }
}

export async function handleLoginSubmit(e) {
  e.preventDefault();
  dom.loginError?.classList.add('hidden');
  const password = dom.loginPassword?.value || '';

  try {
    await apiRequest('/api/auth/login', {
      method: 'POST',
      body: { password }
    });
    showAlert('success', '登录成功', '已验证管理员身份。');
    dom.loginForm?.reset();
    await fetchAuthState();
  } catch (err) {
    const parsed = formatSafeError(err);
    if (dom.loginError) {
      dom.loginError.textContent = parsed.displayText;
      dom.loginError.classList.remove('hidden');
    }
  }
}

export async function handleLogout() {
  try {
    await apiRequest('/api/auth/logout', { method: 'POST' });
  } catch (err) {
    console.warn('Logout request warning:', err);
  } finally {
    appState.authenticated = false;
    appState.profiles = [];
    appState.mcps = [];
    appState.activeProfileId = null;
    if (appState.operationPollingTimer) {
      clearInterval(appState.operationPollingTimer);
      appState.operationPollingTimer = null;
    }
    showAlert('success', '已登出', '您已安全退出控制台。');
    await fetchAuthState();
  }
}

// ==========================================================================
// Dashboard Data & Multi-MCP Registry Loading
// ==========================================================================

export async function loadDashboardData() {
  try {
    const [stateData, profilesData, mcpsData] = await Promise.all([
      apiRequest('/api/state').catch(() => null),
      apiRequest('/api/profiles').catch(() => []),
      apiRequest('/api/mcps').catch(() => null)
    ]);

    if (stateData) {
      if (stateData.revision !== undefined && stateData.revision !== null) {
        appState.revision = stateData.revision;
        if (dom.revisionValue) dom.revisionValue.textContent = `rev ${stateData.revision}`;
      }
      if (stateData.recovery) {
        if (stateData.recovery.gated || stateData.recovery.pendingRecovery) {
          showNeedsAttentionBanner(stateData.recovery);
          if (dom.statusValue) dom.statusValue.textContent = '需关注 (闸门已触发)';
          if (dom.headerStatusBadge) dom.headerStatusBadge.className = 'badge badge-danger';
        } else {
          hideNeedsAttentionBanner();
          if (dom.statusValue) dom.statusValue.textContent = '运行正常';
          if (dom.headerStatusBadge) dom.headerStatusBadge.className = 'badge badge-success';
        }
      }
    }

    // Process MCP services
    let servicesList = [];
    if (mcpsData && Array.isArray(mcpsData.mcps)) {
      servicesList = mcpsData.mcps;
      if (mcpsData.revision !== undefined) {
        appState.revision = mcpsData.revision;
      }
    } else if (stateData && Array.isArray(stateData.mcps)) {
      servicesList = stateData.mcps;
    } else if (stateData && stateData.services) {
      // Fallback for legacy state services
      if (Array.isArray(stateData.services)) {
        servicesList = stateData.services;
      } else if (typeof stateData.services === 'object') {
        servicesList = Object.entries(stateData.services).map(([id, s]) => ({ id, label: s.label || id, ...s }));
      }
    }

    appState.mcps = servicesList;
    if (dom.badgeMcpsCount) {
      dom.badgeMcpsCount.textContent = servicesList.length;
    }

    // Process Profiles
    const profileList = Array.isArray(profilesData) ? profilesData : (stateData?.profiles || []);
    appState.profiles = profileList;

    const activeProfileIds = new Set();
    if (stateData?.services) {
      if (Array.isArray(stateData.services)) {
        stateData.services.forEach(s => {
          if (s?.activeProfileId) activeProfileIds.add(s.activeProfileId);
        });
      } else if (typeof stateData.services === 'object') {
        Object.values(stateData.services).forEach(s => {
          if (s?.activeProfileId) activeProfileIds.add(s.activeProfileId);
        });
      }
    }
    profileList.forEach(p => {
      if (p.isActive === true || p.active === true) {
        activeProfileIds.add(p.id);
      }
    });

    appState.activeProfileIds = activeProfileIds;
    appState.activeProfileId = [...activeProfileIds][0] || null;

    // Check for pendingApply status across MCP services
    const hasPendingApply = servicesList.some(s => s.runtime?.pendingApply === true);
    if (dom.mcpsPendingBanner) {
      if (hasPendingApply) {
        dom.mcpsPendingBanner.classList.remove('alert-hidden');
      } else {
        dom.mcpsPendingBanner.classList.add('alert-hidden');
      }
    }

    // Render Components
    renderSwitchTargets();
    renderProfilesGrid();
    renderSwitchProfileDropdown();
    renderMcpsRegistryGrid();
  } catch (err) {
    console.error('Failed to load dashboard:', err);
    const parsed = formatSafeError(err);
    showAlert('error', '配置加载失败', parsed.displayText);
  }
}

// ==========================================================================
// Switch Control View (Dynamic MCP Checkboxes)
// ==========================================================================

export function renderSwitchTargets() {
  if (!dom.switchTargetsContainer) return;
  dom.switchTargetsContainer.innerHTML = '';

  if (appState.mcps.length === 0) {
    dom.switchTargetsContainer.innerHTML = `
      <div class="empty-hint">暂无已注册的 MCP 服务。请前往【MCP服务】添加或导入。</div>
    `;
    return;
  }

  appState.mcps.forEach(mcp => {
    const isRunning = mcp.runtime?.state === 'running';
    const isEnabled = mcp.enabled !== false;
    const isCarrier = mcp.controlCarrier === true;

    const label = document.createElement('label');
    label.className = `checkbox-label ${!isEnabled ? 'disabled' : ''}`;
    label.htmlFor = `target-${mcp.id}`;
    if (!isEnabled) {
      label.title = '该服务已禁用，不可启动或执行切换';
    }

    label.innerHTML = `
      <input type="checkbox" id="target-${escapeHtml(mcp.id)}" value="${escapeHtml(mcp.id)}" ${isEnabled ? 'checked' : 'disabled'}>
      <span class="checkbox-custom"></span>
      <span class="service-name">${escapeHtml(mcp.label || mcp.id)}</span>
      <span class="service-slug">${escapeHtml(mcp.id)}</span>
      ${isCarrier ? '<span class="badge badge-subtle" title="控制平面承载服务">Carrier</span>' : ''}
      ${!isEnabled ? '<span class="badge badge-warning">已禁用</span>' : ''}
      ${isRunning ? '<span class="status-dot" title="运行中"></span>' : ''}
    `;

    dom.switchTargetsContainer.appendChild(label);
  });
}

export function renderSwitchProfileDropdown() {
  if (!dom.switchProfileSelect) return;
  const currentSelected = dom.switchProfileSelect.value;
  dom.switchProfileSelect.innerHTML = '<option value="">-- 请选择要切换的目标配置 --</option>';

  appState.profiles.forEach(profile => {
    const isActive = isProfileActive(profile.id) || profile.isActive === true;
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent = `${profile.label || '未命名'} ${isActive ? '(当前生效)' : ''}`;
    dom.switchProfileSelect.appendChild(option);
  });

  if (currentSelected && appState.profiles.some(p => p.id === currentSelected)) {
    dom.switchProfileSelect.value = currentSelected;
  }
  updateSelectedProfilePreview();
}

export function updateSelectedProfilePreview() {
  if (!dom.switchSelectedProfileInfo) return;
  const selectedId = dom.switchProfileSelect.value;
  if (!selectedId) {
    dom.switchSelectedProfileInfo.textContent = '';
    return;
  }
  const profile = appState.profiles.find(p => p.id === selectedId);
  if (!profile) return;

  const servicesInfo = appState.mcps.map(mcp => {
    const svc = profile.services?.[mcp.id] || {};
    const hasTid = Boolean(svc.tunnelId || svc.maskedTunnelId);
    return `${escapeHtml(mcp.label || mcp.id)}: ${hasTid ? maskTunnelId(svc.tunnelId || svc.maskedTunnelId) : '未配置'}`;
  }).join(' | ');

  dom.switchSelectedProfileInfo.innerHTML = `
    目标概要: <strong>${escapeHtml(profile.label)}</strong> (Rev: ${profile.revision ?? '-'})
    <div style="margin-top:2px; font-size:11px; color:var(--text-muted);">${servicesInfo || '无已配置服务'}</div>
  `;
}

export async function handleExecuteSwitch() {
  const selectedServices = [];
  const checkboxes = dom.switchTargetsContainer?.querySelectorAll('input[type="checkbox"]:checked') || [];
  checkboxes.forEach(cb => {
    if (cb.value) selectedServices.push(cb.value);
  });

  if (selectedServices.length === 0) {
    showAlert('warning', '校验提示', '[VALIDATION_ERROR] 请至少勾选一个启用的目标 MCP 服务。');
    return;
  }

  const selectedProfileId = dom.switchProfileSelect?.value;
  if (!selectedProfileId) {
    showAlert('warning', '校验提示', '[VALIDATION_ERROR] 请选择要切换的目标配置文件。');
    return;
  }

  const profile = appState.profiles.find(p => p.id === selectedProfileId);
  const profileLabel = profile ? profile.label : selectedProfileId;

  // Verify that the chosen profile configures credentials for all selected services
  for (const sId of selectedServices) {
    const svc = profile?.services?.[sId];
    if (!svc || (!svc.tunnelId && !svc.maskedTunnelId)) {
      showAlert('warning', '凭据缺失', `[VALIDATION_ERROR] 目标配置 "${profileLabel}" 未配置服务 [${sId}] 的 Tunnel ID，无法启动切换。`);
      return;
    }
  }

  const idempotencyKey = generateIdempotencyKey();

  if (dom.btnExecuteSwitch) dom.btnExecuteSwitch.disabled = true;
  dom.operationProgressCard?.classList.remove('hidden');
  updateProgressView({
    id: '初始化中...',
    phase: 'QUEUED',
    idempotencyKey,
    message: `准备向配置 [${profileLabel}] 切换目标服务: ${selectedServices.join(', ')}...`
  });

  try {
    const response = await apiRequest('/api/switch', {
      method: 'POST',
      headers: {
        'Idempotency-Key': idempotencyKey
      },
      body: {
        profileId: selectedProfileId,
        targets: selectedServices
      }
    });

    const operation = response.operation || response;
    const operationId = operation.id || operation.operationId;
    if (!operationId) {
      throw new Error('未返回有效的 operationId');
    }

    updateProgressView({
      id: operationId,
      status: operation.status || 'QUEUED',
      phase: operation.status || 'QUEUED',
      idempotencyKey,
      message: `切换请求已受理 (HTTP 202 ACCEPTED)，正在执行准备与健康校验...`
    });

    startOperationPolling(operationId, idempotencyKey);
  } catch (err) {
    if (dom.btnExecuteSwitch) dom.btnExecuteSwitch.disabled = false;
    const parsed = formatSafeError(err);
    updateProgressView({
      id: 'FAILED',
      phase: 'TERMINAL',
      status: 'TERMINAL',
      idempotencyKey,
      message: `切换发起失败: ${parsed.displayText}`
    });
    showAlert('error', '切换失败', parsed.displayText);
  }
}

export function startOperationPolling(operationId, idempotencyKey) {
  if (appState.operationPollingTimer) {
    clearInterval(appState.operationPollingTimer);
  }

  const poll = async () => {
    try {
      const op = await apiRequest(`/api/operations/${encodeURIComponent(operationId)}`);
      op.idempotencyKey = idempotencyKey;
      updateProgressView(op);

      const status = (op.status || op.phase || '').toUpperCase();

      if (['SUCCEEDED', 'ROLLED_BACK', 'NEEDS_ATTENTION', 'REJECTED'].includes(status)) {
        clearInterval(appState.operationPollingTimer);
        appState.operationPollingTimer = null;
        if (dom.btnExecuteSwitch) dom.btnExecuteSwitch.disabled = false;

        if (status === 'SUCCEEDED') {
          showAlert('success', '切换完成 (SUCCEEDED)', `配置已平滑切换，服务已生效。当前版本: rev ${op.revision ?? appState.revision}`);
          await loadDashboardData();
        } else if (status === 'ROLLED_BACK') {
          showAlert('warning', '操作已回滚 (ROLLED_BACK)', `切换未完成，已完成安全回滚。${formatOperationFailure(op)}`);
          await loadDashboardData();
        } else if (status === 'NEEDS_ATTENTION') {
          showNeedsAttentionBanner(op);
          showAlert('error', '恢复闸门触发 (NEEDS_ATTENTION)', `[NEEDS_ATTENTION] 回滚未能确认恢复原状，系统已触发安全恢复闸门并阻止后续切换，请人工排查。${formatOperationFailure(op)}`);
          await loadDashboardData();
        } else if (status === 'REJECTED') {
          showAlert('error', '操作被拒绝 (REJECTED)', `切换操作已被拒绝: ${formatOperationFailure(op)}`);
        }
      }
    } catch (pollErr) {
      console.warn('Operation polling warning:', pollErr);
    }
  };

  poll();
  appState.operationPollingTimer = setInterval(poll, 800);
}

export function updateProgressView(op) {
  if (!dom.operationProgressCard) return;
  const phase = (op.phase || op.status || 'QUEUED').toUpperCase();

  if (dom.opIdDisplay) dom.opIdDisplay.textContent = `ID: ${op.id || '-'}`;
  if (dom.opIdempotencyDisplay) dom.opIdempotencyDisplay.textContent = `Idempotency-Key: ${op.idempotencyKey || '-'}`;
  if (dom.opStatusMessage) dom.opStatusMessage.textContent = ['ROLLED_BACK', 'NEEDS_ATTENTION', 'REJECTED'].includes(phase)
    ? formatOperationFailure(op) : op.message || `当前处理阶段: ${phase}`;
  if (dom.opTimestamp) dom.opTimestamp.textContent = new Date().toLocaleTimeString();

  if (dom.opPhaseBadge) {
    dom.opPhaseBadge.textContent = phase;
    dom.opPhaseBadge.className = `badge badge-op badge-op-${phase.toLowerCase()}`;
  }

  const phaseOrder = ['QUEUED', 'PREPARING', 'APPLYING', 'VERIFYING'];
  const currentIdx = phaseOrder.indexOf(phase);

  const steps = dom.operationProgressCard.querySelectorAll('.stepper-step');
  const lines = dom.operationProgressCard.querySelectorAll('.step-line');

  steps.forEach(step => {
    const stepPhase = step.dataset.phase;
    step.classList.remove('active', 'completed', 'failed');

    if (stepPhase === 'TERMINAL') {
      if (phase === 'SUCCEEDED') {
        step.classList.add('completed');
        if (dom.stepTerminalLabel) dom.stepTerminalLabel.textContent = '成功 (SUCCEEDED)';
      } else if (phase === 'ROLLED_BACK') {
        step.classList.add('failed');
        if (dom.stepTerminalLabel) dom.stepTerminalLabel.textContent = '已回滚 (ROLLED_BACK)';
      } else if (phase === 'NEEDS_ATTENTION') {
        step.classList.add('failed');
        if (dom.stepTerminalLabel) dom.stepTerminalLabel.textContent = '需关注 (NEEDS_ATTENTION)';
      } else if (phase === 'REJECTED') {
        step.classList.add('failed');
        if (dom.stepTerminalLabel) dom.stepTerminalLabel.textContent = '已拒绝 (REJECTED)';
      } else if (phase === 'ROLLING_BACK') {
        step.classList.add('active');
        if (dom.stepTerminalLabel) dom.stepTerminalLabel.textContent = '回滚中 (ROLLING_BACK)';
      } else {
        if (dom.stepTerminalLabel) dom.stepTerminalLabel.textContent = '完成';
      }
    } else {
      const stepIdx = phaseOrder.indexOf(stepPhase);
      if (stepIdx < currentIdx || ['SUCCEEDED', 'ROLLED_BACK', 'NEEDS_ATTENTION'].includes(phase)) {
        step.classList.add('completed');
      } else if (stepIdx === currentIdx) {
        step.classList.add('active');
      }
    }
  });

  lines.forEach((line, idx) => {
    line.classList.remove('completed');
    if (idx < currentIdx || ['SUCCEEDED', 'ROLLED_BACK', 'NEEDS_ATTENTION'].includes(phase)) {
      line.classList.add('completed');
    }
  });
}

// ==========================================================================
// Account Profiles View
// ==========================================================================

export function renderProfilesGrid() {
  if (!dom.profilesContainer) return;
  dom.profilesContainer.innerHTML = '';

  if (appState.profiles.length === 0) {
    dom.profilesContainer.innerHTML = `
      <div class="empty-state">
        <p>暂无任何配置文件。点击上方“添加新配置”开始创建。</p>
      </div>
    `;
    return;
  }

  appState.profiles.forEach(profile => {
    const isActive = isProfileActive(profile.id) || profile.isActive === true || profile.active === true;
    const card = document.createElement('div');
    card.className = `profile-card ${isActive ? 'active-profile' : ''}`;
    card.dataset.profileId = profile.id;

    // Render services configured in this profile
    let servicesHtml = '';
    const registered = appState.mcps.length > 0 ? appState.mcps : [{ id: 'overleaf-mcp', label: 'Overleaf MCP' }, { id: 'antigravity-mcp', label: 'Antigravity MCP' }];

    registered.forEach(mcp => {
      const svc = profile.services?.[mcp.id] || (mcp.id === 'overleaf-mcp' ? {
        tunnelId: profile.overleafTunnelId || profile.overleafMaskedTunnelId,
        hasApiKey: profile.overleafHasApiKey ?? (profile.overleafApiKey && profile.overleafApiKey.length > 0),
        orgId: profile.overleafOrgId
      } : mcp.id === 'antigravity-mcp' ? {
        tunnelId: profile.antigravityTunnelId || profile.antigravityMaskedTunnelId,
        hasApiKey: profile.antigravityHasApiKey ?? (profile.antigravityApiKey && profile.antigravityApiKey.length > 0),
        orgId: profile.antigravityOrgId
      } : {});

      const tid = svc.tunnelId || svc.maskedTunnelId || '';
      const hasApiKey = Boolean(svc.hasApiKey ?? (svc.apiKey && svc.apiKey.length > 0));
      const orgId = svc.orgId || svc.organizationId || '';

      servicesHtml += `
        <div class="profile-service-item">
          <div class="profile-service-head">
            <span class="service-tag">${escapeHtml(mcp.label || mcp.id)}</span>
            ${hasApiKey
              ? '<span class="badge badge-success">API Key: 已配置</span>'
              : '<span class="badge badge-neutral">API Key: 未配置</span>'}
          </div>
          <div class="profile-service-meta">
            <div class="meta-row">
              <span class="meta-key">Tunnel ID:</span>
              <span class="meta-val-tunnel" title="${escapeHtml(tid)}">${escapeHtml(maskTunnelId(tid))}</span>
            </div>
            <div class="meta-row">
              <span class="meta-key">Org ID:</span>
              <span class="meta-val">${orgId ? escapeHtml(orgId) : '<span class="text-dim">无</span>'}</span>
            </div>
          </div>
        </div>
      `;
    });

    card.innerHTML = `
      <div class="profile-card-header">
        <div class="profile-card-title">
          <span>${escapeHtml(profile.label || '未命名配置')}</span>
        </div>
        <div class="profile-badge-row">
          ${isActive ? '<span class="badge badge-active">● 当前生效</span>' : ''}
          <span class="badge badge-subtle">Rev: ${profile.revision ?? '-'}</span>
        </div>
      </div>

      <div class="profile-services-list">
        ${servicesHtml || '<div class="text-dim" style="padding:4px;">未配置任何服务凭证</div>'}
      </div>

      <div class="profile-card-footer">
        <button class="btn btn-secondary btn-sm btn-edit" data-id="${escapeHtml(profile.id)}">编辑配置</button>
        <button class="btn btn-danger btn-sm btn-delete" data-id="${escapeHtml(profile.id)}" ${isActive ? 'disabled title="当前生效的配置不允许删除"' : ''}>
          删除
        </button>
      </div>
    `;

    card.querySelector('.btn-edit')?.addEventListener('click', () => openEditProfileModal(profile));
    const btnDelete = card.querySelector('.btn-delete');
    if (!isActive && btnDelete) {
      btnDelete.addEventListener('click', () => handleDeleteProfile(profile.id, profile.label));
    }

    dom.profilesContainer.appendChild(card);
  });
}

export function openCreateProfileModal() {
  if (!dom.profileModal) return;
  dom.modalTitle.textContent = '新建配置文件';
  dom.modalBadge.textContent = '新增配置';
  dom.modalBadge.className = 'badge badge-primary';
  dom.profileForm?.reset();
  dom.formProfileId.value = '';
  dom.modalFormError?.classList.add('hidden');
  dom.btnModalDeleteProfile?.classList.add('hidden');

  renderProfileFormServices(null);
  dom.profileModal.classList.remove('hidden');
}

export function openEditProfileModal(profile) {
  if (!dom.profileModal) return;
  dom.modalTitle.textContent = `编辑配置: ${profile.label || ''}`;
  dom.modalBadge.textContent = '修改配置';
  dom.modalBadge.className = 'badge badge-warning';
  dom.profileForm?.reset();
  dom.modalFormError?.classList.add('hidden');

  dom.formProfileId.value = profile.id;
  dom.formProfileLabel.value = profile.label || '';

  renderProfileFormServices(profile);

  const isActive = isProfileActive(profile.id) || profile.isActive === true;
  if (!isActive && dom.btnModalDeleteProfile) {
    dom.btnModalDeleteProfile.classList.remove('hidden');
    dom.btnModalDeleteProfile.onclick = () => {
      closeProfileModal();
      handleDeleteProfile(profile.id, profile.label);
    };
  } else if (dom.btnModalDeleteProfile) {
    dom.btnModalDeleteProfile.classList.add('hidden');
  }

  dom.profileModal.classList.remove('hidden');
}

export function renderProfileFormServices(profile) {
  if (!dom.profileServicesContainer) return;
  dom.profileServicesContainer.innerHTML = '';

  const registered = appState.mcps.length > 0 ? appState.mcps : [{ id: 'overleaf-mcp', label: 'Overleaf MCP' }, { id: 'antigravity-mcp', label: 'Antigravity MCP' }];

  registered.forEach(mcp => {
    const svc = profile?.services?.[mcp.id] || (mcp.id === 'overleaf-mcp' ? {
      tunnelId: profile?.overleafTunnelId || profile?.overleafMaskedTunnelId,
      hasApiKey: profile?.overleafHasApiKey ?? (profile?.overleafApiKey && profile.overleafApiKey.length > 0),
      orgId: profile?.overleafOrgId
    } : mcp.id === 'antigravity-mcp' ? {
      tunnelId: profile?.antigravityTunnelId || profile?.antigravityMaskedTunnelId,
      hasApiKey: profile?.antigravityHasApiKey ?? (profile?.antigravityApiKey && profile.antigravityApiKey.length > 0),
      orgId: profile?.antigravityOrgId
    } : {});

    const tid = svc.tunnelId || svc.maskedTunnelId || '';
    const hasApiKey = Boolean(svc.hasApiKey ?? (svc.apiKey && svc.apiKey.length > 0));
    const orgId = (svc.orgId && svc.orgId !== '已配置') ? svc.orgId : '';

    const panel = document.createElement('div');
    panel.className = 'service-config-panel';
    panel.dataset.serviceId = mcp.id;

    panel.innerHTML = `
      <div class="panel-header">
        <span class="panel-title">${escapeHtml(mcp.label || mcp.id)}</span>
        <span class="panel-slug">${escapeHtml(mcp.id)}</span>
      </div>

      <div class="form-group">
        <label for="form-${escapeHtml(mcp.id)}-tunnel-id" class="form-label required">Tunnel ID</label>
        <input type="text" id="form-${escapeHtml(mcp.id)}-tunnel-id" class="form-input font-mono form-service-tunnel" data-service-id="${escapeHtml(mcp.id)}" data-initial="${escapeHtml(tid)}" value="${escapeHtml(tid)}" placeholder="例如：tunnel_${escapeHtml(mcp.id.slice(0, 4))}_1a2b3c" required>
      </div>

      <div class="form-group">
        <label for="form-${escapeHtml(mcp.id)}-api-key" class="form-label">
          API Key
          <span class="label-hint">（留空则保留原有 API Key）</span>
        </label>
        <div class="input-with-button">
          <input type="password" id="form-${escapeHtml(mcp.id)}-api-key" class="form-input font-mono form-service-key" data-service-id="${escapeHtml(mcp.id)}" placeholder="${profile ? '留空则保留原有 API Key (PATCH 时生效)' : '输入 API Key'}" autocomplete="new-password">
          <button type="button" class="btn-toggle-mask" data-target="form-${escapeHtml(mcp.id)}-api-key" title="显示/隐藏明文">👁</button>
        </div>
        <div class="input-annotation">${hasApiKey ? '当前状态：已配置（留空将安全保留）' : '当前状态：未设置'}</div>
      </div>

      <div class="form-group">
        <label for="form-${escapeHtml(mcp.id)}-org-id" class="form-label">Organization ID <span class="label-hint">（选填）</span></label>
        <input type="text" id="form-${escapeHtml(mcp.id)}-org-id" class="form-input font-mono form-service-org" data-service-id="${escapeHtml(mcp.id)}" value="${escapeHtml(orgId)}" placeholder="例如：org_${escapeHtml(mcp.id.slice(0, 4))}">
      </div>
    `;

    panel.querySelector('.btn-toggle-mask')?.addEventListener('click', (e) => {
      const btn = e.currentTarget;
      const targetId = btn.dataset.target;
      const input = document.getElementById(targetId);
      if (input) {
        input.type = input.type === 'password' ? 'text' : 'password';
      }
    });

    dom.profileServicesContainer.appendChild(panel);
  });
}

export function closeProfileModal() {
  dom.profileModal?.classList.add('hidden');
  dom.profileForm?.reset();
  dom.modalFormError?.classList.add('hidden');
}

export async function handleProfileFormSubmit(e) {
  e.preventDefault();
  dom.modalFormError?.classList.add('hidden');

  const profileId = dom.formProfileId?.value;
  const isEditing = Boolean(profileId);
  const label = (dom.formProfileLabel?.value || '').trim();

  if (!label) {
    dom.modalFormError.textContent = '[VALIDATION_ERROR] 请填写完整的配置名称。';
    dom.modalFormError.classList.remove('hidden');
    return;
  }

  // Collect inputs from dynamic service panels
  const inputsByService = {};
  const servicePanels = dom.profileServicesContainer?.querySelectorAll('.service-config-panel') || [];

  for (const panel of servicePanels) {
    const sId = panel.dataset.serviceId;
    const tunnelInput = panel.querySelector('.form-service-tunnel');
    const keyInput = panel.querySelector('.form-service-key');
    const orgInput = panel.querySelector('.form-service-org');

    inputsByService[sId] = {
      tunnelId: tunnelInput?.value || '',
      initialTunnelId: tunnelInput?.dataset.initial || '',
      apiKey: keyInput?.value || '',
      orgId: orgInput?.value || ''
    };
  }

  const registered = appState.mcps.length > 0 ? appState.mcps : [{ id: 'overleaf-mcp' }, { id: 'antigravity-mcp' }];
  const servicesPayload = buildProfileServicesPayload(registered, inputsByService, isEditing);

  const payload = {
    label,
    services: servicesPayload
  };

  try {
    if (isEditing) {
      await apiRequest(`/api/profiles/${encodeURIComponent(profileId)}`, {
        method: 'PATCH',
        body: payload
      });
      showAlert('success', '保存成功', `配置 "${label}" 已成功更新。`);
    } else {
      await apiRequest('/api/profiles', {
        method: 'POST',
        body: payload
      });
      showAlert('success', '创建成功', `配置 "${label}" 已成功创建。`);
    }

    closeProfileModal();
    await loadDashboardData();
  } catch (err) {
    const parsed = formatSafeError(err);
    if (dom.modalFormError) {
      dom.modalFormError.textContent = parsed.displayText;
      dom.modalFormError.classList.remove('hidden');
    }
  }
}

export async function handleDeleteProfile(profileId, label) {
  if (isProfileActive(profileId)) {
    showAlert('error', '禁止操作', '[ACTIVE_PROFILE_CANNOT_BE_DELETED] 当前处于活跃状态的配置不允许删除。');
    return;
  }

  const confirmed = typeof window !== 'undefined' ? window.confirm(`确定要删除配置文件 "${label || profileId}" 吗？此操作无法撤销。`) : true;
  if (!confirmed) return;

  try {
    await apiRequest(`/api/profiles/${encodeURIComponent(profileId)}`, {
      method: 'DELETE'
    });
    showAlert('success', '删除成功', `配置文件 "${label || profileId}" 已删除。`);
    await loadDashboardData();
  } catch (err) {
    const parsed = formatSafeError(err);
    showAlert('error', '删除失败', parsed.displayText);
  }
}

// ==========================================================================
// MCP Services Registry Section & Modals
// ==========================================================================

export function getHttpDisplayUrl(mcp) {
  if (!mcp) return '-';
  const binding = mcp.binding || {};
  const hasPrivateQuery = Boolean(binding.hasPrivateQuery || mcp.hasPrivateQuery);
  const urlConfigured = Boolean(binding.urlConfigured || mcp.urlConfigured);
  const urlDisplay = binding.urlDisplay || mcp.urlDisplay;

  if (hasPrivateQuery || urlDisplay || urlConfigured) {
    return urlDisplay || '配置已保存';
  }
  if (binding.url) {
    return binding.url;
  }
  return '-';
}

const OBSERVATION_REASON_LABELS = {
  observation_expired: '观测已过期',
  not_observed: '等待观测',
  http_authentication_required: '需要服务认证',
  connection_refused: '连接被拒绝',
  connection_failed: '连接失败',
  timeout: '连接超时',
  process_alive_mcp_unverified: '进程运行但MCP尚未验证',
  tunnel_online_backend_unverified: '隧道在线但后端MCP尚未验证',
  external_process_unobserved: '未托管或未接入观测',
  invalid_mcp_response: 'MCP响应或版本不受支持',
  unsupported_transport: 'MCP响应或版本不受支持',
  probe_failed: '探测失败',
  observation_disabled: '观测已禁用',
  observer_unavailable: '观测服务不可用',
  invalid_observation: '观测数据无效',
  configuration_changed: '配置已变更',
  mcp_initialize_verified: 'MCP初始化已验证'
};

export function formatObservationBadge(observation) {
  const obs = observation && typeof observation === 'object' ? observation : null;
  const nowMs = Date.now();
  let state = obs?.state;
  let reasonCode = obs?.reasonCode || 'not_observed';
  let observedAt = obs?.observedAt || null;
  const expiresAtMs = obs?.expiresAt ? Date.parse(obs.expiresAt) : NaN;

  if (!obs || !state || (Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs) || state === 'unobserved') {
    state = 'unobserved';
    if (obs && Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs) {
      reasonCode = 'observation_expired';
    }
  }

  let label = '尚未观测';
  let badgeClass = 'badge badge-unknown';

  switch (state) {
    case 'available':
      label = '可用';
      badgeClass = 'badge badge-running';
      break;
    case 'authentication_required':
      label = '需要认证';
      badgeClass = 'badge badge-warning';
      break;
    case 'unreachable':
      label = '不可达';
      badgeClass = 'badge badge-danger';
      break;
    case 'check_failed':
      label = '检查失败';
      badgeClass = 'badge badge-danger';
      break;
    case 'unobserved':
    default:
      label = '尚未观测';
      badgeClass = 'badge badge-unknown';
      break;
  }

  const titleParts = [];
  if (reasonCode) {
    const textDesc = OBSERVATION_REASON_LABELS[reasonCode];
    if (textDesc) {
      titleParts.push(`原因: ${textDesc} (${reasonCode})`);
    } else {
      titleParts.push(`原因: ${reasonCode}`);
    }
  }
  if (observedAt) titleParts.push(`观测时间: ${observedAt}`);
  const titleAttr = titleParts.length > 0 ? ` title="${escapeHtml(titleParts.join(' | '))}"` : '';

  return `<span class="${badgeClass}"${titleAttr}>${escapeHtml(label)}</span>`;
}

export function getEligibleProfilesForService(serviceId) {
  if (!serviceId || !Array.isArray(appState.profiles)) return [];
  return appState.profiles.filter(p => {
    const svc = p.services?.[serviceId] || (serviceId === 'overleaf-mcp' ? {
      tunnelId: p.overleafTunnelId || p.overleafMaskedTunnelId,
      hasApiKey: p.overleafHasApiKey ?? Boolean(p.overleafApiKey && p.overleafApiKey.length > 0)
    } : serviceId === 'antigravity-mcp' ? {
      tunnelId: p.antigravityTunnelId || p.antigravityMaskedTunnelId,
      hasApiKey: p.antigravityHasApiKey ?? Boolean(p.antigravityApiKey && p.antigravityApiKey.length > 0)
    } : null);
    if (!svc) return false;
    return Boolean(svc.tunnelId || svc.maskedTunnelId || svc.hasApiKey || svc.hasKey || svc.apiKey);
  });
}

export const TUNNEL_CLIENT_REASON_LABELS = {
  external_process_unmanaged: '外部运行（未接管）',
  external_http_unmanaged: '外部 HTTP 服务（未配置本地隧道客户端）',
  process_not_running: '进程未运行',
  process_exited: '进程已退出',
  process_spawn_failed: '进程启动失败',
  process_identity_mismatch: '进程标识不匹配',
  state_unverified: '状态未验证',
  state_refresh_required: '状态需要刷新',
  profile_required: '需要运行账号',
  profile_not_configured: '未配置适用账号',
  service_disabled: '服务已禁用',
  service_not_managed: '非受管服务',
  executable_not_found: '未找到可执行文件',
  carrier_confirmation_required: '需要承载确认',
  already_running: '已在运行',
  already_stopped: '已停止'
};

export function formatCredentialBadge(credObj, itemOrCand = null) {
  const type = (itemOrCand?.type || itemOrCand?.sourceKind || '').toLowerCase();
  const isBat = type === 'bat';
  const isServiceDef = itemOrCand?.kind === 'service_definition' || itemOrCand?.isServiceDefinition === true || itemOrCand?.credentialsNotApplicable === true;

  const configured = credObj === 'configured' || credObj?.configured === true;
  const hasPart = credObj?.hasApiKey || credObj?.hasTunnelId || credObj?.hasKey || false;
  const isExternalRef = isBat || credObj?.externalReference === true || credObj?.status === 'external_ref' ||
    (typeof itemOrCand?.reason === 'string' && itemOrCand.reason.includes('外部引用'));

  if (configured) {
    return '<span class="badge badge-success">凭据: 已配置</span>';
  }
  if (isBat || isExternalRef) {
    return '<span class="badge badge-info">凭据: 外部引用</span>';
  }
  if (isServiceDef || credObj?.notApplicable) {
    return '<span class="badge badge-subtle">凭据: 不适用</span>';
  }
  if (hasPart) {
    return '<span class="badge badge-warning">凭据: 部分配置</span>';
  }
  return '<span class="badge badge-warning">凭据: 缺失</span>';
}

export function formatTunnelClientBadge(tunnelClient) {
  const tc = tunnelClient && typeof tunnelClient === 'object' ? tunnelClient : null;
  const state = tc?.state || 'unobserved';
  let label = '进程未观测';
  let badgeClass = 'badge badge-unknown';

  switch (state) {
    case 'running':
      label = tc.managed ? '隧道运行中' : '运行中(未接管)';
      badgeClass = 'badge badge-running';
      break;
    case 'stopped':
      label = '隧道已停止';
      badgeClass = 'badge badge-stopped';
      break;
    case 'starting':
      label = '隧道启动中';
      badgeClass = 'badge badge-warning';
      break;
    case 'stopping':
      label = '隧道停止中';
      badgeClass = 'badge badge-warning';
      break;
    case 'restarting':
      label = '隧道重启中';
      badgeClass = 'badge badge-warning';
      break;
    case 'failed':
      label = '隧道启动失败';
      badgeClass = 'badge badge-danger';
      break;
    case 'unmanaged':
      label = '隧道未接管';
      badgeClass = 'badge badge-warning';
      break;
    case 'unobserved':
    default:
      label = '进程未观测';
      badgeClass = 'badge badge-unknown';
      break;
  }

  const titleParts = [];
  if (tc?.reasonCode) {
    const desc = TUNNEL_CLIENT_REASON_LABELS[tc.reasonCode] || tc.reasonCode;
    titleParts.push(`原因: ${desc}`);
  }
  if (tc?.pid) titleParts.push(`PID: ${tc.pid}`);
  if (tc?.startedAt) titleParts.push(`启动时间: ${tc.startedAt}`);
  if (tc?.profileId) titleParts.push(`账号: ${tc.profileId}`);
  if (tc?.lastExitCode !== null && tc?.lastExitCode !== undefined) titleParts.push(`退出码: ${tc.lastExitCode}`);
  const titleAttr = titleParts.length > 0 ? ` title="${escapeHtml(titleParts.join(' | '))}"` : '';

  return `<span class="${badgeClass}"${titleAttr}>${escapeHtml(label)}</span>`;
}

export function getTunnelStatusDescription(tc, mcp) {
  const bindingType = mcp?.binding?.type || 'stdio';
  if (!tc || !tc.state || tc.state === 'unobserved') {
    if (bindingType === 'http' && !mcp?.controlCarrier && getEligibleProfilesForService(mcp?.id).length === 0) {
      return '外部 HTTP 服务（未配置隧道客户端）';
    }
    return '等待进程状态观测...';
  }
  if (tc.state === 'unmanaged') {
    if (tc.pid) {
      return `检测到外部运行的隧道客户端（PID: ${tc.pid}，未接管），不可通过控制台操作。`;
    }
    return '检测到外部运行的隧道客户端（未接管），不可通过控制台操作。';
  }
  if (tc.state === 'running') {
    let desc = `隧道客户端进程正常运行 (PID: ${tc.pid || '已验证'})`;
    if (tc.profileId) desc += `，运行账号: ${tc.profileId}`;
    if (tc.startedAt) desc += `，启动于: ${tc.startedAt}`;
    return desc;
  }
  if (tc.state === 'starting') {
    return `隧道客户端正在启动中${tc.operationId ? ` (操作: ${tc.operationId})` : ''}...`;
  }
  if (tc.state === 'stopping') {
    return `隧道客户端正在停止中${tc.operationId ? ` (操作: ${tc.operationId})` : ''}...`;
  }
  if (tc.state === 'restarting') {
    return `隧道客户端正在重启中${tc.operationId ? ` (操作: ${tc.operationId})` : ''}...`;
  }
  if (tc.state === 'failed') {
    let desc = '隧道客户端启动失败或异常退出';
    if (tc.lastExitCode !== null && tc.lastExitCode !== undefined) {
      desc += ` (退出代码: ${tc.lastExitCode})`;
    }
    if (tc.reasonCode) {
      desc += ` [${TUNNEL_CLIENT_REASON_LABELS[tc.reasonCode] || tc.reasonCode}]`;
    }
    return desc;
  }
  if (tc.state === 'stopped') {
    let desc = '隧道客户端进程已停止';
    if (tc.reasonCode && tc.reasonCode !== 'already_stopped') {
      desc += ` (${TUNNEL_CLIENT_REASON_LABELS[tc.reasonCode] || tc.reasonCode})`;
    }
    return desc;
  }
  return tc.reasonCode ? (TUNNEL_CLIENT_REASON_LABELS[tc.reasonCode] || tc.reasonCode) : '状态就绪';
}

export function renderMcpsRegistryGrid() {
  if (!dom.mcpsContainer) return;
  dom.mcpsContainer.innerHTML = '';

  if (appState.mcps.length === 0) {
    dom.mcpsContainer.innerHTML = `
      <div class="empty-state">
        <p>暂无任何注册的 MCP 服务。点击上方“添加 MCP 服务”或“发现本机配置”开始。</p>
      </div>
    `;
    return;
  }

  appState.mcps.forEach(mcp => {
    const tc = mcp.runtime?.tunnelClient || {};
    const tcState = tc.state || 'unobserved';
    const isOwned = tc.managed === true;
    const isRunning = tcState === 'running';
    const isEnabled = mcp.enabled !== false;
    const isPendingApply = mcp.runtime?.pendingApply === true;
    const bindingType = mcp.binding?.type || 'stdio';
    const isHttp = bindingType === 'http';
    const hasCarrier = Boolean(mcp.controlCarrier);
    const isInTransition = ['starting', 'stopping', 'restarting'].includes(tcState);
    const eligibleProfiles = getEligibleProfilesForService(mcp.id);
    const isExternalOnlyHttp = isHttp && !hasCarrier && eligibleProfiles.length === 0 && (tcState === 'unobserved' || !tcState);

    // Start button condition
    let startDisabled = false;
    let startDisabledTitle = '';
    if (isExternalOnlyHttp) {
      startDisabled = true;
      startDisabledTitle = '外部 HTTP 服务未配置隧道客户端承载';
    } else if (!isEnabled) {
      startDisabled = true;
      startDisabledTitle = '服务已禁用';
    } else if (isInTransition) {
      startDisabled = true;
      startDisabledTitle = `操作正在进行中 (${tcState})`;
    } else if (tcState === 'unmanaged') {
      startDisabled = true;
      startDisabledTitle = tc.pid ? `检测到外部运行的隧道客户端（PID: ${tc.pid}，未接管），不可通过控制台操作` : '检测到外部运行的隧道客户端（未接管），不可通过控制台操作';
    } else if (tcState === 'running') {
      startDisabled = true;
      startDisabledTitle = '隧道已在运行中（如需重载请使用重启）';
    } else if (eligibleProfiles.length === 0) {
      startDisabled = true;
      startDisabledTitle = '未找到包含该服务凭证的可用账号';
    }

    // Restart button condition
    let restartDisabled = false;
    let restartDisabledTitle = '';
    if (isExternalOnlyHttp) {
      restartDisabled = true;
      restartDisabledTitle = '外部 HTTP 服务未配置隧道客户端承载';
    } else if (!isEnabled) {
      restartDisabled = true;
      restartDisabledTitle = '服务已禁用';
    } else if (isInTransition) {
      restartDisabled = true;
      restartDisabledTitle = `操作正在进行中 (${tcState})`;
    } else if (tcState === 'unmanaged') {
      restartDisabled = true;
      restartDisabledTitle = tc.pid ? `检测到外部运行的隧道客户端（PID: ${tc.pid}，未接管），不可通过控制台操作` : '检测到外部运行的隧道客户端（未接管），不可通过控制台操作';
    } else if (tcState !== 'running' || !isOwned) {
      restartDisabled = true;
      restartDisabledTitle = '隧道未处于受管运行状态，请直接启动';
    } else if (eligibleProfiles.length === 0) {
      restartDisabled = true;
      restartDisabledTitle = '未找到包含该服务凭证的可用账号';
    }

    // Stop button condition
    let stopDisabled = false;
    let stopDisabledTitle = '';
    if (isExternalOnlyHttp) {
      stopDisabled = true;
      stopDisabledTitle = '外部 HTTP 服务无需停止隧道';
    } else if (isInTransition) {
      stopDisabled = true;
      stopDisabledTitle = `操作正在进行中 (${tcState})`;
    } else if (tcState === 'unmanaged') {
      stopDisabled = true;
      stopDisabledTitle = tc.pid ? `检测到外部运行的隧道客户端（PID: ${tc.pid}，未接管），不可通过控制台操作` : '检测到外部运行的隧道客户端（未接管），不可通过控制台操作';
    } else if (tcState === 'stopped') {
      stopDisabled = true;
      stopDisabledTitle = '隧道客户端已处于停止状态';
    } else if (tcState !== 'running' || !isOwned) {
      stopDisabled = true;
      stopDisabledTitle = '隧道未处于受管运行状态';
    }

    const card = document.createElement('div');
    card.className = `mcp-card ${isRunning ? 'running' : ''} ${!isEnabled ? 'disabled' : ''}`;
    card.dataset.mcpId = mcp.id;

    // Build binding summary text
    let bindingSummary = '';
    if (bindingType === 'stdio') {
      const exec = mcp.binding?.executable || '-';
      const argsCount = Array.isArray(mcp.binding?.args) ? mcp.binding.args.length : 0;
      bindingSummary = `
        <div class="binding-field-row">
          <span class="binding-field-label">可执行程序:</span>
          <span class="binding-field-value font-mono" title="${escapeHtml(exec)}">${escapeHtml(exec)}</span>
        </div>
        <div class="binding-field-row">
          <span class="binding-field-label">工作目录:</span>
          <span class="binding-field-value font-mono">${mcp.binding?.cwd ? escapeHtml(mcp.binding.cwd) : '<span class="text-dim">默认</span>'}</span>
        </div>
        <div class="binding-field-row">
          <span class="binding-field-label">启动参数:</span>
          <span class="binding-field-value">${argsCount > 0 ? `${argsCount} 项参数` : '<span class="text-dim">无</span>'}</span>
        </div>
      `;
    } else {
      const displayUrl = getHttpDisplayUrl(mcp);
      const headersCount = mcp.binding?.headers ? Object.keys(mcp.binding.headers).length : 0;
      bindingSummary = `
        <div class="binding-field-row">
          <span class="binding-field-label">服务 URL:</span>
          <span class="binding-field-value font-mono" title="${escapeHtml(displayUrl)}">${escapeHtml(displayUrl)}</span>
        </div>
        <div class="binding-field-row">
          <span class="binding-field-label">自定义请求头:</span>
          <span class="binding-field-value">${headersCount > 0 ? `${headersCount} 项 Headers` : '<span class="text-dim">无</span>'}</span>
        </div>
      `;
    }

    // Provenance badge
    let provBadge = '';
    if (mcp.provenance?.kind || mcp.provenance?.sourceKind) {
      provBadge = `<span class="badge badge-subtle">来源: ${escapeHtml(mcp.provenance.sourceKind || mcp.provenance.kind)}</span>`;
    }

    card.innerHTML = `
      <div class="mcp-card-header">
        <div class="mcp-card-title">
          <span class="mcp-title-text">${escapeHtml(mcp.label || mcp.id)}</span>
          <span class="mcp-id-slug">${escapeHtml(mcp.id)}</span>
        </div>
        <div class="mcp-badge-row">
          <span class="badge badge-type badge-subtle">${bindingType.toUpperCase()}</span>
          ${mcp.controlCarrier ? '<span class="badge badge-subtle" title="控制平面承载">Carrier</span>' : ''}
          ${isEnabled ? '<span class="badge badge-success">已启用</span>' : '<span class="badge badge-warning">已禁用</span>'}
          ${formatObservationBadge(mcp.runtime?.observation)}
          ${formatTunnelClientBadge(mcp.runtime?.tunnelClient)}
          ${isPendingApply ? '<span class="badge badge-pending-apply" title="配置已更新，需重新切换方可生效">待应用</span>' : ''}
          ${provBadge}
        </div>
      </div>

      <div class="mcp-binding-preview">
        ${bindingSummary}
        <div class="binding-field-row" style="margin-top: 6px; padding-top: 6px; border-top: 1px dashed rgba(255, 255, 255, 0.07);">
          <span class="binding-field-label">隧道进程:</span>
          <span class="binding-field-value font-mono" style="font-size: 12px;">${escapeHtml(getTunnelStatusDescription(mcp.runtime?.tunnelClient, mcp))}</span>
        </div>
      </div>

      <div class="mcp-card-footer">
        <button type="button" class="btn btn-secondary btn-sm btn-mcp-locations" data-id="${escapeHtml(mcp.id)}">
          查看路径与详情
        </button>
        <button type="button" class="btn btn-secondary btn-sm btn-mcp-edit" data-id="${escapeHtml(mcp.id)}">
          编辑服务
        </button>
        <button type="button" class="btn btn-primary btn-sm btn-mcp-start" data-id="${escapeHtml(mcp.id)}" ${startDisabled ? `disabled title="${escapeHtml(startDisabledTitle)}"` : ''}>
          启动隧道
        </button>
        <button type="button" class="btn btn-secondary btn-sm btn-mcp-restart" data-id="${escapeHtml(mcp.id)}" ${restartDisabled ? `disabled title="${escapeHtml(restartDisabledTitle)}"` : ''}>
          重启隧道
        </button>
        <button type="button" class="btn btn-warning btn-sm btn-mcp-stop" data-id="${escapeHtml(mcp.id)}" ${stopDisabled ? `disabled title="${escapeHtml(stopDisabledTitle)}"` : ''}>
          停止隧道
        </button>
        <button type="button" class="btn btn-danger btn-sm btn-mcp-delete" data-id="${escapeHtml(mcp.id)}">
          移除
        </button>
      </div>
    `;

    // Bind card actions
    card.querySelector('.btn-mcp-locations')?.addEventListener('click', () => openLocationsModal(mcp));
    card.querySelector('.btn-mcp-edit')?.addEventListener('click', () => openEditMcpModal(mcp));
    card.querySelector('.btn-mcp-start')?.addEventListener('click', () => openTunnelActionModal(mcp, 'start'));
    card.querySelector('.btn-mcp-restart')?.addEventListener('click', () => openTunnelActionModal(mcp, 'restart'));
    card.querySelector('.btn-mcp-stop')?.addEventListener('click', () => openTunnelActionModal(mcp, 'stop'));
    card.querySelector('.btn-mcp-delete')?.addEventListener('click', () => openLifecycleModal(mcp, 'delete'));

    dom.mcpsContainer.appendChild(card);
  });
}

// --------------------------------------------------------------------------
// Add / Edit MCP Modal
// --------------------------------------------------------------------------

export function openAddMcpModal() {
  if (!dom.mcpModal) return;
  dom.mcpModalTitle.textContent = '添加 MCP 服务';
  dom.mcpModalBadge.textContent = '新增服务';
  dom.mcpModalBadge.className = 'badge badge-primary';
  dom.mcpForm?.reset();
  dom.mcpFormId.value = '';
  dom.mcpFormEnabled.checked = true;
  dom.mcpFormType.value = 'stdio';
  dom.mcpFormType.disabled = false;
  dom.mcpModalError?.classList.add('hidden');

  updateBindingTypeFields('stdio');
  if (dom.mcpFormUrl) {
    dom.mcpFormUrl.value = '';
    dom.mcpFormUrl.placeholder = '例如：http://127.0.0.1:8000/sse 或 https://mcp.internal.example/sse';
  }
  dom.mcpArgsContainer.innerHTML = '';
  dom.mcpHeadersContainer.innerHTML = '';
  dom.mcpEnvContainer.innerHTML = '';

  dom.mcpModal.classList.remove('hidden');
}

export function openEditMcpModal(mcp) {
  if (!dom.mcpModal) return;
  dom.mcpModalTitle.textContent = `编辑服务: ${mcp.label || mcp.id}`;
  dom.mcpModalBadge.textContent = '修改服务';
  dom.mcpModalBadge.className = 'badge badge-warning';
  dom.mcpForm?.reset();
  dom.mcpModalError?.classList.add('hidden');

  dom.mcpFormId.value = mcp.id;
  dom.mcpFormLabel.value = mcp.label || '';
  dom.mcpFormEnabled.checked = mcp.enabled !== false;

  const type = mcp.binding?.type || 'stdio';
  dom.mcpFormType.value = type;
  dom.mcpFormType.disabled = true; // Binding type cannot be changed once created

  updateBindingTypeFields(type);

  // Populate Stdio / HTTP fields
  if (type === 'stdio') {
    dom.mcpFormExecutable.value = mcp.binding?.executable || '';
    dom.mcpFormCwd.value = mcp.binding?.cwd || '';
    dom.mcpArgsContainer.innerHTML = '';
    const args = Array.isArray(mcp.binding?.args) ? mcp.binding.args : [];
    args.forEach(arg => addArgRow(arg));
  } else {
    const binding = mcp.binding || {};
    const hasPrivateQuery = Boolean(binding.hasPrivateQuery || mcp.hasPrivateQuery);
    const urlConfigured = Boolean(binding.urlConfigured || mcp.urlConfigured || hasPrivateQuery);
    const rawUrl = binding.url || '';
    const isMaskedUrl = rawUrl.includes('...') || rawUrl.includes('***');

    if (urlConfigured || isMaskedUrl || hasPrivateQuery || !rawUrl) {
      dom.mcpFormUrl.value = '';
      dom.mcpFormUrl.placeholder = '[已配置 - 留空保留]';
    } else {
      dom.mcpFormUrl.value = rawUrl;
      dom.mcpFormUrl.placeholder = '[已配置 - 留空保留]';
    }

    dom.mcpHeadersContainer.innerHTML = '';
    const headers = binding.headers || {};
    Object.entries(headers).forEach(([name, entry]) => addHeaderRow({ name, ...entry }));
  }

  // Populate Environment variables
  dom.mcpEnvContainer.innerHTML = '';
  const envItems = Array.isArray(mcp.environment) ? mcp.environment : (typeof mcp.environment === 'object' && mcp.environment !== null ? Object.entries(mcp.environment).map(([name, entry]) => ({ name, ...entry })) : []);
  envItems.forEach(env => addEnvRow(env));

  dom.mcpModal.classList.remove('hidden');
}

export function updateBindingTypeFields(type) {
  if (type === 'stdio') {
    dom.mcpStdioFields?.classList.remove('hidden');
    dom.mcpHttpFields?.classList.add('hidden');
  } else {
    dom.mcpStdioFields?.classList.add('hidden');
    dom.mcpHttpFields?.classList.remove('hidden');
  }
}

export function addArgRow(initial = null) {
  if (!dom.mcpArgsContainer) return;
  const row = document.createElement('div');
  row.className = 'dynamic-row';

  const isConfigured = Boolean(initial?.configured);
  const secret = initial ? initial.secret !== false : true;
  const val = initial?.value !== undefined ? initial.value : (isConfigured ? '' : '');

  row.innerHTML = `
    <input type="text" class="form-input font-mono arg-val" placeholder="${isConfigured ? '[已配置 - 留空保留]' : '输入参数值'}" value="${escapeHtml(val)}">
    <label class="checkbox-secret-label">
      <input type="checkbox" class="arg-secret" ${secret ? 'checked' : ''}>
      <span>Secret</span>
    </label>
    <button type="button" class="btn-remove-row" title="删除参数">&times;</button>
  `;

  row.dataset.configured = isConfigured ? 'true' : 'false';
  if (initial?.id) row.dataset.argId = initial.id;

  row.querySelector('.btn-remove-row')?.addEventListener('click', () => row.remove());
  dom.mcpArgsContainer.appendChild(row);
}

export function addHeaderRow(initial = null) {
  if (!dom.mcpHeadersContainer) return;
  const row = document.createElement('div');
  row.className = 'dynamic-row';

  const name = initial?.name || '';
  const isConfigured = Boolean(initial?.configured);
  const secret = initial ? initial.secret !== false : true;
  const isSecret = isSensitiveHeaderName(name) || secret;

  // If configured and secret, never expose saved secret or masked placeholder in DOM input value
  let val = initial?.value !== undefined ? initial.value : '';
  if (isConfigured && (isSecret || val === '[已配置 - 留空保留]' || (typeof val === 'string' && (val.includes('***') || val.includes('...'))))) {
    val = '';
  }

  row.innerHTML = `
    <input type="text" class="form-input font-mono header-name" placeholder="Header 名称 (例如: Authorization)" value="${escapeHtml(name)}" style="flex:1;">
    <input type="text" class="form-input font-mono header-val" placeholder="${isConfigured ? '[已配置 - 留空保留]' : 'Header 值'}" value="${escapeHtml(val)}" style="flex:2;">
    <label class="checkbox-secret-label">
      <input type="checkbox" class="header-secret" ${secret ? 'checked' : ''}>
      <span>Secret</span>
    </label>
    <button type="button" class="btn-remove-row" title="删除请求头">&times;</button>
  `;

  row.dataset.configured = isConfigured ? 'true' : 'false';
  row.querySelector('.btn-remove-row')?.addEventListener('click', () => row.remove());
  dom.mcpHeadersContainer.appendChild(row);
}

export function addEnvRow(initial = null) {
  if (!dom.mcpEnvContainer) return;
  const row = document.createElement('div');
  row.className = 'dynamic-row';

  const name = initial?.name || '';
  const isConfigured = Boolean(initial?.configured);
  const isSensitive = isSensitiveEnvName(name);
  const secret = isSensitive || (initial ? initial.secret !== false : true);
  const val = initial?.value !== undefined ? initial.value : '';

  row.innerHTML = `
    <input type="text" class="form-input font-mono env-name" placeholder="变量名 (如: API_KEY, PORT)" value="${escapeHtml(name)}" style="flex:1;">
    <input type="text" class="form-input font-mono env-val" placeholder="${isConfigured ? '[已配置 - 留空保留]' : '变量值'}" value="${escapeHtml(val)}" style="flex:2;">
    <label class="checkbox-secret-label" title="${isSensitive ? '敏感变量强制加密' : ''}">
      <input type="checkbox" class="env-secret" ${secret ? 'checked' : ''} ${isSensitive ? 'disabled' : ''}>
      <span>Secret</span>
    </label>
    <button type="button" class="btn-remove-row" title="删除环境变量">&times;</button>
  `;

  row.dataset.configured = isConfigured ? 'true' : 'false';
  row.dataset.originalName = name;

  const nameInput = row.querySelector('.env-name');
  const secretInput = row.querySelector('.env-secret');
  nameInput?.addEventListener('input', () => {
    if (isSensitiveEnvName(nameInput.value)) {
      secretInput.checked = true;
      secretInput.disabled = true;
    } else {
      secretInput.disabled = false;
    }
  });

  row.querySelector('.btn-remove-row')?.addEventListener('click', () => row.remove());
  dom.mcpEnvContainer.appendChild(row);
}

export function closeMcpModal() {
  dom.mcpModal?.classList.add('hidden');
  dom.mcpForm?.reset();
  dom.mcpModalError?.classList.add('hidden');
}

export async function handleMcpFormSubmit(e) {
  e.preventDefault();
  dom.mcpModalError?.classList.add('hidden');

  const mcpId = dom.mcpFormId?.value;
  const isEditing = Boolean(mcpId);
  const label = (dom.mcpFormLabel?.value || '').trim();
  const enabled = dom.mcpFormEnabled?.checked !== false;
  const type = dom.mcpFormType?.value || 'stdio';

  if (!label) {
    dom.mcpModalError.textContent = '[VALIDATION_ERROR] 请填写服务名称。';
    dom.mcpModalError.classList.remove('hidden');
    return;
  }

  // Build Binding
  let bindingPayload;
  if (type === 'stdio') {
    const executable = (dom.mcpFormExecutable?.value || '').trim();
    if (!executable) {
      dom.mcpModalError.textContent = '[VALIDATION_ERROR] 请填写本机可执行文件绝对路径或系统命令。';
      dom.mcpModalError.classList.remove('hidden');
      return;
    }
    const cwd = (dom.mcpFormCwd?.value || '').trim();
    const argsRows = [];
    dom.mcpArgsContainer?.querySelectorAll('.dynamic-row').forEach(row => {
      argsRows.push({
        id: row.dataset.argId,
        value: row.querySelector('.arg-val')?.value,
        secret: row.querySelector('.arg-secret')?.checked !== false,
        configured: row.dataset.configured === 'true'
      });
    });
    bindingPayload = buildBindingPayload('stdio', { executable, cwd, argsRows });
  } else {
    const url = (dom.mcpFormUrl?.value || '').trim();
    if (!isEditing && !url) {
      dom.mcpModalError.textContent = '[VALIDATION_ERROR] 请填写远程 HTTP / SSE 服务地址。';
      dom.mcpModalError.classList.remove('hidden');
      return;
    }
    if (!isEditing && (url.includes('...') || url.includes('***'))) {
      dom.mcpModalError.textContent = '[VALIDATION_ERROR] 请填写有效的远程 HTTP / SSE 服务地址，不能包含掩码。';
      dom.mcpModalError.classList.remove('hidden');
      return;
    }

    const existingMcp = isEditing ? appState.mcps.find(m => m.id === mcpId) : null;
    const initialUrl = existingMcp?.binding?.url || '';
    const previousHeaders = existingMcp?.binding?.headers || {};

    const headersRows = [];
    dom.mcpHeadersContainer?.querySelectorAll('.dynamic-row').forEach(row => {
      headersRows.push({
        name: row.querySelector('.header-name')?.value,
        value: row.querySelector('.header-val')?.value,
        secret: row.querySelector('.header-secret')?.checked !== false,
        configured: row.dataset.configured === 'true'
      });
    });
    bindingPayload = buildBindingPayload('http', {
      url,
      headersRows,
      isEditing,
      initialUrl,
      previousHeaders
    });
  }

  // Build Environment Patch
  const envRows = [];
  dom.mcpEnvContainer?.querySelectorAll('.dynamic-row').forEach(row => {
    envRows.push({
      name: row.querySelector('.env-name')?.value,
      value: row.querySelector('.env-val')?.value,
      secret: row.querySelector('.env-secret')?.checked !== false,
      configured: row.dataset.configured === 'true'
    });
  });

  const existingMcp = isEditing ? appState.mcps.find(m => m.id === mcpId) : null;
  const previousEnv = existingMcp?.environment || [];
  const environmentPatch = buildEnvironmentPatch(previousEnv, envRows);

  const payload = {
    expectedRevision: appState.revision,
    label,
    enabled,
    binding: bindingPayload,
    environmentPatch
  };

  try {
    if (isEditing) {
      await apiRequest(`/api/mcps/${encodeURIComponent(mcpId)}`, {
        method: 'PATCH',
        body: payload
      });
      showAlert('success', '服务更新成功', `MCP 服务 "${label}" 配置已安全更新。`);
    } else {
      await apiRequest('/api/mcps', {
        method: 'POST',
        body: payload
      });
      showAlert('success', '服务添加成功', `MCP 服务 "${label}" 已成功创建注册。`);
    }

    closeMcpModal();
    await loadDashboardData();
  } catch (err) {
    const parsed = formatSafeError(err);
    if (dom.mcpModalError) {
      dom.mcpModalError.textContent = parsed.displayText;
      dom.mcpModalError.classList.remove('hidden');
    }
  }
}

// --------------------------------------------------------------------------
// MCP Locations & Details Modal
// --------------------------------------------------------------------------

export async function openLocationsModal(mcp) {
  if (!dom.mcpLocationsModal) return;
  dom.locationsModalTitle.textContent = `MCP 服务位置详情: ${mcp.label || mcp.id}`;
  clearLocationsFeedback();

  // Summary chips
  const bindingType = mcp.binding?.type || 'stdio';
  if (dom.locationsServiceSummary) {
    dom.locationsServiceSummary.innerHTML = `
      <div class="summary-chip"><strong>服务 ID:</strong> <span class="font-mono">${escapeHtml(mcp.id)}</span></div>
      <div class="summary-chip"><strong>类型:</strong> <span>${bindingType.toUpperCase()}</span></div>
      <div class="summary-chip"><strong>MCP 连接:</strong> <span>${formatObservationBadge(mcp.runtime?.observation)}</span></div>
      <div class="summary-chip"><strong>隧道进程:</strong> <span>${formatTunnelClientBadge(mcp.runtime?.tunnelClient)}</span></div>
      ${mcp.runtime?.pendingApply ? '<div class="summary-chip"><span class="badge badge-pending-apply">待应用</span></div>' : ''}
    `;
  }

  // Reset display
  const roles = ['sourceConfig', 'effectiveConfig', 'installation', 'executable', 'workingDirectory', 'managerStore'];
  roles.forEach(role => {
    const pathEl = document.getElementById(`path-${role}`);
    const statusEl = document.getElementById(`status-${role}`);
    if (pathEl) pathEl.textContent = '正在获取...';
    if (statusEl) {
      statusEl.textContent = '-';
      statusEl.className = 'badge badge-subtle';
    }
  });

  dom.mcpLocationsModal.classList.remove('hidden');

  try {
    const locations = await apiRequest(`/api/mcps/${encodeURIComponent(mcp.id)}/locations`);
    renderLocationsData(mcp, locations);
  } catch (err) {
    console.error('Failed to load locations:', err);
    roles.forEach(role => {
      const pathEl = document.getElementById(`path-${role}`);
      if (pathEl) pathEl.textContent = '获取失败';
    });
  }
}

export function renderLocationsData(mcp, locations = {}) {
  const roleMapping = {
    sourceConfig: {
      path: locations.sourceConfigPath,
      exists: locations.sourceConfigExists ?? locations.exists?.sourceConfig,
      defaultLabel: '未设置'
    },
    effectiveConfig: {
      path: locations.effectiveConfigPath,
      exists: locations.effectiveConfigExists ?? locations.exists?.effectiveConfig,
      defaultLabel: '尚未生成'
    },
    installation: {
      path: locations.installationRoot,
      exists: locations.installationExists ?? locations.exists?.installation,
      defaultLabel: mcp.binding?.type === 'http' ? '不适用' : '缺失'
    },
    executable: {
      path: locations.executable || mcp.binding?.executable,
      exists: locations.executableExists ?? locations.exists?.executable,
      defaultLabel: mcp.binding?.type === 'http' ? '不适用' : '未指定'
    },
    workingDirectory: {
      path: locations.cwd || mcp.binding?.cwd,
      exists: locations.cwdExists ?? locations.exists?.cwd,
      defaultLabel: '默认'
    },
    managerStore: {
      path: locations.managerStorePath,
      exists: locations.managerStoreExists ?? locations.exists?.managerStore ?? true,
      defaultLabel: '控制台 SQLite 数据库'
    }
  };

  Object.entries(roleMapping).forEach(([role, data]) => {
    const pathEl = document.getElementById(`path-${role}`);
    const statusEl = document.getElementById(`status-${role}`);
    const copyBtn = dom.mcpLocationsModal?.querySelector(`.btn-copy-path[data-target="path-${role}"]`);
    const revealBtn = dom.mcpLocationsModal?.querySelector(`.btn-reveal-path[data-role="${role}"]`);

    const pathText = data.path || data.defaultLabel;
    if (pathEl) pathEl.textContent = pathText;

    if (statusEl) {
      if (mcp.binding?.type === 'http' && (role === 'installation' || role === 'executable') && !data.path) {
        statusEl.textContent = '不适用';
        statusEl.className = 'badge badge-subtle';
      } else if (!data.path) {
        if (role === 'sourceConfig') {
          statusEl.textContent = '未设置';
          statusEl.className = 'badge badge-subtle';
        } else if (role === 'effectiveConfig') {
          statusEl.textContent = '尚未生成';
          statusEl.className = 'badge badge-subtle';
        } else if (role === 'workingDirectory') {
          statusEl.textContent = '默认';
          statusEl.className = 'badge badge-subtle';
        } else {
          statusEl.textContent = '未指定';
          statusEl.className = 'badge badge-subtle';
        }
      } else if (data.exists === true) {
        statusEl.textContent = '存在 (exists)';
        statusEl.className = 'badge badge-success';
      } else if (data.exists === false) {
        statusEl.textContent = '缺失 (missing)';
        statusEl.className = 'badge badge-warning';
      } else {
        statusEl.textContent = '未知 (unknown)';
        statusEl.className = 'badge badge-subtle';
      }
    }

    if (copyBtn) {
      copyBtn.onclick = () => copyLocationPath(data.path || '');
    }

    if (revealBtn) {
      revealBtn.onclick = () => revealLocationPath(mcp.id, role);
      if (!data.path || data.exists === false) {
        revealBtn.disabled = true;
      } else {
        revealBtn.disabled = false;
      }
    }
  });
}

export async function copyLocationPath(pathText) {
  if (!pathText) {
    showAlert('warning', '提示', '该位置路径为空，无法复制。');
    return;
  }

  let copied = false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(pathText);
      copied = true;
    }
  } catch (e) {
    copied = false;
  }

  const msg = copied ? `已成功复制路径到剪贴板: ${pathText}` : `请手动复制: ${pathText}`;
  updateLocationsFeedback(msg, copied ? 'locations-feedback-msg alert-success' : 'locations-feedback-msg alert-warning');
  setTimeout(() => {
    clearLocationsFeedback();
  }, 4000);
}

export async function revealLocationPath(serviceId, role) {
  try {
    updateLocationsFeedback(`正在请求打开 [${role}] 所在目录...`, 'locations-feedback-msg');

    const reply = await apiRequest(`/api/mcps/${encodeURIComponent(serviceId)}/reveal`, {
      method: 'POST',
      body: { role }
    });

    if (reply?.opened === true) {
      updateLocationsFeedback('已请求打开所在目录', 'locations-feedback-msg alert-success');
    } else {
      const msg = reply?.message || reply?.error?.message || '未能打开所在目录，请检查目标路径是否存在。';
      updateLocationsFeedback(msg, 'locations-feedback-msg alert-error');
    }
  } catch (err) {
    const parsed = formatSafeError(err);
    const msg = `无法打开目录: ${parsed.displayText || parsed.message || '未知错误'}`;
    updateLocationsFeedback(msg, 'locations-feedback-msg alert-error');
  }
}

// --------------------------------------------------------------------------
// Stop & Delete Lifecycle Modal
// --------------------------------------------------------------------------

export function openLifecycleModal(mcp, initialAction = 'delete') {
  if (!dom.mcpLifecycleModal) return;
  appState.selectedLifecycleMcp = mcp;

  dom.lifecycleModalTitle.textContent = `管理服务生命周期: ${mcp.label || mcp.id}`;
  dom.lifecycleError?.classList.add('hidden');
  dom.lifecycleBodyRunning?.classList.add('hidden');
  dom.lifecycleBodyUnknown?.classList.add('hidden');
  dom.lifecycleBodyStopped?.classList.add('hidden');
  dom.btnLifecycleDelete?.classList.add('hidden');
  dom.lifecycleStopProgress?.classList.add('hidden');

  const check = canDeleteMcp(mcp);

  if (!check.allowed && check.reason === 'MCP_RUNNING') {
    dom.lifecycleModalBadge.textContent = '运行中保护';
    dom.lifecycleModalBadge.className = 'badge badge-warning';
    dom.lifecycleBodyRunning?.classList.remove('hidden');
  } else if (!check.allowed && (check.reason === 'RUNTIME_STATE_UNKNOWN' || check.reason === 'RUNTIME_STATE_UNMANAGED')) {
    dom.lifecycleModalBadge.textContent = check.reason === 'RUNTIME_STATE_UNMANAGED' ? '外部进程保护' : '未知状态排查';
    dom.lifecycleModalBadge.className = 'badge badge-danger';
    dom.lifecycleBodyUnknown?.classList.remove('hidden');
  } else {
    dom.lifecycleModalBadge.textContent = '移除确认';
    dom.lifecycleModalBadge.className = 'badge badge-danger';
    dom.lifecycleBodyStopped?.classList.remove('hidden');
    dom.btnLifecycleDelete?.classList.remove('hidden');
  }

  dom.mcpLifecycleModal.classList.remove('hidden');
}

export function closeLifecycleModal() {
  if (appState.lifecycleStopTimer) {
    clearInterval(appState.lifecycleStopTimer);
    appState.lifecycleStopTimer = null;
  }
  appState.selectedLifecycleMcp = null;
  dom.mcpLifecycleModal?.classList.add('hidden');
}

export async function handleExecuteStopMcp() {
  const mcp = appState.selectedLifecycleMcp;
  if (!mcp) return;

  const idempotencyKey = generateIdempotencyKey();
  if (dom.btnLifecycleStop) dom.btnLifecycleStop.disabled = true;
  dom.lifecycleStopProgress?.classList.remove('hidden');
  if (dom.lifecycleStopMsg) dom.lifecycleStopMsg.textContent = '已提交停止连接请求，等待后端进程退出收据...';

  try {
    const response = await apiRequest(`/api/mcps/${encodeURIComponent(mcp.id)}/stop`, {
      method: 'POST',
      headers: {
        'Idempotency-Key': idempotencyKey
      },
      body: {
        expectedRevision: appState.revision
      }
    });

    const op = response.operation || response;
    const opId = op.id || op.operationId;
    if (!opId) {
      throw new Error('停止操作未返回有效的 operationId');
    }

    startStopPolling(opId, mcp);
  } catch (err) {
    if (dom.btnLifecycleStop) dom.btnLifecycleStop.disabled = false;
    dom.lifecycleStopProgress?.classList.add('hidden');
    const parsed = formatSafeError(err);
    if (dom.lifecycleError) {
      dom.lifecycleError.textContent = `停止失败: ${parsed.displayText}`;
      dom.lifecycleError.classList.remove('hidden');
    }
  }
}

export function startStopPolling(operationId, mcp) {
  if (appState.lifecycleStopTimer) {
    clearInterval(appState.lifecycleStopTimer);
  }

  const poll = async () => {
    try {
      const op = await apiRequest(`/api/operations/${encodeURIComponent(operationId)}`);
      const status = (op.status || op.phase || '').toUpperCase();

      if (dom.lifecycleStopMsg) {
        dom.lifecycleStopMsg.textContent = `当前状态: ${status} - ${op.message || '正在等待服务完全释放...'}`;
      }

      if (['SUCCEEDED', 'REJECTED', 'NEEDS_ATTENTION'].includes(status)) {
        clearInterval(appState.lifecycleStopTimer);
        appState.lifecycleStopTimer = null;

        if (status === 'SUCCEEDED') {
          if (dom.lifecycleStopMsg) {
            dom.lifecycleStopMsg.textContent = '服务已安全停止 (SUCCEEDED)！';
          }
          showAlert('success', '服务已停止', `服务 "${mcp.label || mcp.id}" 连接已平滑释放，进程已退出。`);
          await loadDashboardData();

          // Transition lifecycle modal to Stopped state
          dom.lifecycleBodyRunning?.classList.add('hidden');
          dom.lifecycleBodyStopped?.classList.remove('hidden');
          dom.btnLifecycleDelete?.classList.remove('hidden');
          dom.lifecycleModalBadge.textContent = '就绪可移除';
          dom.lifecycleModalBadge.className = 'badge badge-success';
        } else if (status === 'NEEDS_ATTENTION') {
          showNeedsAttentionBanner(op);
          if (dom.lifecycleError) {
            dom.lifecycleError.textContent = '[NEEDS_ATTENTION] 停止连接触发了恢复闸门，需人工介入排查。';
            dom.lifecycleError.classList.remove('hidden');
          }
        } else {
          if (dom.lifecycleError) {
            dom.lifecycleError.textContent = `[REJECTED] 停止操作被拒绝: ${op.failureCode || 'REJECTED'}`;
            dom.lifecycleError.classList.remove('hidden');
          }
        }
      }
    } catch (pollErr) {
      console.warn('Stop polling warning:', pollErr);
    }
  };

  poll();
  appState.lifecycleStopTimer = setInterval(poll, 800);
}

export async function handleExecuteDeleteMcp() {
  const mcp = appState.selectedLifecycleMcp;
  if (!mcp) return;

  if (dom.btnLifecycleDelete) dom.btnLifecycleDelete.disabled = true;

  try {
    await apiRequest(`/api/mcps/${encodeURIComponent(mcp.id)}`, {
      method: 'DELETE',
      body: {
        expectedRevision: appState.revision
      }
    });

    closeLifecycleModal();
    showAlert('success', '移除成功', `MCP 服务 "${mcp.label || mcp.id}" 已从控制台注销，本机文件已妥善保留。`);
    await loadDashboardData();
  } catch (err) {
    if (dom.btnLifecycleDelete) dom.btnLifecycleDelete.disabled = false;
    const parsed = formatSafeError(err);
    if (dom.lifecycleError) {
      dom.lifecycleError.textContent = `移除失败: ${parsed.displayText}`;
      dom.lifecycleError.classList.remove('hidden');
    }
  }
}

// --------------------------------------------------------------------------
// Tunnel Action Modal (Start / Stop / Restart)
// --------------------------------------------------------------------------

export function openTunnelActionModal(mcp, action = 'start') {
  if (!dom.tunnelActionModal || !mcp) return;
  appState.selectedTunnelActionMcp = mcp;
  appState.selectedTunnelActionKind = action;
  appState.tunnelActionCarrierToken = null;
  appState.tunnelActionIdempotencyKey = null;

  if (appState.tunnelActionTimer) {
    clearInterval(appState.tunnelActionTimer);
    appState.tunnelActionTimer = null;
  }

  dom.tunnelActionError?.classList.add('hidden');
  dom.tunnelActionProgress?.classList.add('hidden');
  if (dom.btnTunnelActionConfirm) dom.btnTunnelActionConfirm.disabled = false;
  if (dom.btnTunnelActionCancel) dom.btnTunnelActionCancel.disabled = false;

  const actionLabels = {
    start: { title: '启动隧道客户端', badge: '启动隧道', badgeClass: 'badge badge-primary', prompt: '即将启动该 MCP 服务的专属隧道客户端进程。' },
    restart: { title: '重启隧道客户端', badge: '重启隧道', badgeClass: 'badge badge-warning', prompt: '即将重启该 MCP 服务的专属隧道客户端进程。旧进程退出后将根据选定账号拉起新进程。' },
    stop: { title: '停止隧道客户端', badge: '停止隧道', badgeClass: 'badge badge-danger', prompt: '即将向该 MCP 服务的受管隧道客户端进程发送停止信号并等待完全退出。' }
  };
  const cfg = actionLabels[action] || actionLabels.start;

  if (dom.tunnelActionModalTitle) dom.tunnelActionModalTitle.textContent = cfg.title;
  if (dom.tunnelActionModalBadge) {
    dom.tunnelActionModalBadge.textContent = cfg.badge;
    dom.tunnelActionModalBadge.className = cfg.badgeClass;
  }
  if (dom.tunnelActionServiceDesc) {
    dom.tunnelActionServiceDesc.textContent = `${mcp.label || mcp.id} (${mcp.id})`;
  }
  if (dom.tunnelActionPrompt) {
    dom.tunnelActionPrompt.textContent = cfg.prompt;
  }

  // Carrier warning
  if (mcp.controlCarrier) {
    dom.tunnelActionCarrierWarning?.classList.remove('hidden');
  } else {
    dom.tunnelActionCarrierWarning?.classList.add('hidden');
  }

  // Profile select
  if (action === 'stop') {
    dom.tunnelActionProfileGroup?.classList.add('hidden');
  } else {
    dom.tunnelActionProfileGroup?.classList.remove('hidden');
    if (dom.tunnelActionProfileSelect) {
      dom.tunnelActionProfileSelect.innerHTML = '';
      const eligible = getEligibleProfilesForService(mcp.id);
      if (eligible.length === 0) {
        dom.tunnelActionProfileSelect.innerHTML = '<option value="">-- 无包含此服务凭证的账号 --</option>';
      } else {
        eligible.forEach(p => {
          const opt = document.createElement('option');
          opt.value = p.id;
          opt.textContent = `${p.label || p.id} (rev ${p.revision ?? '-'})`;
          dom.tunnelActionProfileSelect.appendChild(opt);
        });
        // Select preferred profile: active profile if eligible, or current profileId from tunnelClient
        const activeEligible = eligible.find(p => isProfileActive(p.id));
        const currentProfileId = mcp.runtime?.tunnelClient?.profileId;
        const currentEligible = eligible.find(p => p.id === currentProfileId);
        if (currentEligible) {
          dom.tunnelActionProfileSelect.value = currentEligible.id;
        } else if (activeEligible) {
          dom.tunnelActionProfileSelect.value = activeEligible.id;
        } else {
          dom.tunnelActionProfileSelect.value = eligible[0].id;
        }
      }
    }
  }

  dom.tunnelActionModal.classList.remove('hidden');
}

export function closeTunnelActionModal() {
  if (appState.tunnelActionTimer) {
    clearInterval(appState.tunnelActionTimer);
    appState.tunnelActionTimer = null;
  }
  appState.selectedTunnelActionMcp = null;
  appState.selectedTunnelActionKind = null;
  appState.tunnelActionCarrierToken = null;
  appState.tunnelActionIdempotencyKey = null;
  dom.tunnelActionModal?.classList.add('hidden');
}

export async function handleExecuteTunnelAction() {
  const mcp = appState.selectedTunnelActionMcp;
  const action = appState.selectedTunnelActionKind;
  if (!mcp || !action) return;

  let profileId = null;
  if (action !== 'stop') {
    profileId = dom.tunnelActionProfileSelect?.value?.trim() || null;
    if (!profileId) {
      if (dom.tunnelActionError) {
        dom.tunnelActionError.textContent = '请选择一个适用的运行账号 / Profile。';
        dom.tunnelActionError.classList.remove('hidden');
      }
      return;
    }
  }

  if (dom.btnTunnelActionConfirm) dom.btnTunnelActionConfirm.disabled = true;
  if (dom.btnTunnelActionCancel) dom.btnTunnelActionCancel.disabled = true;
  dom.tunnelActionError?.classList.add('hidden');
  dom.tunnelActionProgress?.classList.remove('hidden');
  if (dom.tunnelActionMsg) dom.tunnelActionMsg.textContent = '正在发送请求并等待状态确认...';

  if (!appState.tunnelActionIdempotencyKey) {
    appState.tunnelActionIdempotencyKey = generateIdempotencyKey();
  }
  const idempotencyKey = appState.tunnelActionIdempotencyKey;
  const body = {
    expectedRevision: appState.revision
  };
  if (profileId) body.profileId = profileId;
  if (appState.tunnelActionCarrierToken) {
    body.carrierToken = appState.tunnelActionCarrierToken;
  }

  try {
    const response = await apiRequest(`/api/mcps/${encodeURIComponent(mcp.id)}/${action}`, {
      method: 'POST',
      headers: {
        'Idempotency-Key': idempotencyKey
      },
      body
    });

    // Check fast no-op returns
    if (response?.code === 'ALREADY_RUNNING') {
      appState.tunnelActionCarrierToken = null;
      appState.tunnelActionIdempotencyKey = null;
      if (dom.tunnelActionMsg) {
        dom.tunnelActionMsg.textContent = `隧道已在运行中 (PID: ${response.pid})，无需重复启动。`;
      }
      showAlert('info', '已在运行', `服务 "${mcp.label || mcp.id}" 隧道客户端已在运行中 (PID: ${response.pid})。`);
      await loadDashboardData();
      setTimeout(() => closeTunnelActionModal(), 1000);
      return;
    }
    if (response?.code === 'ALREADY_STOPPED') {
      appState.tunnelActionCarrierToken = null;
      appState.tunnelActionIdempotencyKey = null;
      if (dom.tunnelActionMsg) {
        dom.tunnelActionMsg.textContent = '隧道客户端已处于停止状态。';
      }
      showAlert('info', '已停止', `服务 "${mcp.label || mcp.id}" 隧道客户端已处于停止状态。`);
      await loadDashboardData();
      setTimeout(() => closeTunnelActionModal(), 1000);
      return;
    }

    const op = response?.operation || response;
    const opId = op?.id || op?.operationId;
    if (!opId) {
      throw new Error('操作已提交但未返回有效 operationId');
    }

    startTunnelActionPolling(opId, mcp, action);
  } catch (err) {
    const isCarrierRequired = err.status === 409 && (
      err.data?.error === 'CARRIER_CONFIRMATION_REQUIRED' ||
      err.data?.code === 'CARRIER_CONFIRMATION_REQUIRED' ||
      (err.data?.decision === 'reject' && err.data?.code === 'CARRIER_CONFIRMATION_REQUIRED')
    );
    if (isCarrierRequired && err.data?.carrierToken) {
      appState.tunnelActionCarrierToken = err.data.carrierToken;
      dom.tunnelActionCarrierWarning?.classList.remove('hidden');
      if (dom.tunnelActionMsg) {
        dom.tunnelActionMsg.textContent = '检测到控制平面承载，请再次点击【确认执行】继续操作。';
      }
      dom.tunnelActionProgress?.classList.add('hidden');
      if (dom.btnTunnelActionConfirm) dom.btnTunnelActionConfirm.disabled = false;
      if (dom.btnTunnelActionCancel) dom.btnTunnelActionCancel.disabled = false;
      return;
    }

    appState.tunnelActionCarrierToken = null;
    appState.tunnelActionIdempotencyKey = null;
    if (dom.btnTunnelActionConfirm) dom.btnTunnelActionConfirm.disabled = false;
    if (dom.btnTunnelActionCancel) dom.btnTunnelActionCancel.disabled = false;
    dom.tunnelActionProgress?.classList.add('hidden');
    const parsed = formatSafeError(err);
    if (dom.tunnelActionError) {
      dom.tunnelActionError.textContent = parsed.displayText;
      dom.tunnelActionError.classList.remove('hidden');
    }
  }
}

export function startTunnelActionPolling(operationId, mcp, action) {
  if (appState.tunnelActionTimer) {
    clearInterval(appState.tunnelActionTimer);
  }

  const poll = async () => {
    try {
      const op = await apiRequest(`/api/operations/${encodeURIComponent(operationId)}`);
      const status = (op.status || op.phase || '').toUpperCase();

      if (dom.tunnelActionMsg) {
        dom.tunnelActionMsg.textContent = `当前状态: ${status} - ${op.message || '正在处理...'}`;
      }

      if (['SUCCEEDED', 'REJECTED', 'NEEDS_ATTENTION', 'ROLLED_BACK'].includes(status)) {
        clearInterval(appState.tunnelActionTimer);
        appState.tunnelActionTimer = null;

        if (status === 'SUCCEEDED') {
          const actionWord = action === 'start' ? '启动' : action === 'restart' ? '重启' : '停止';
          if (dom.tunnelActionMsg) {
            dom.tunnelActionMsg.textContent = `隧道${actionWord}成功 (SUCCEEDED)！`;
          }
          showAlert('success', '操作成功', `服务 "${mcp.label || mcp.id}" 隧道${actionWord}已完成。`);
          await loadDashboardData();
          setTimeout(() => closeTunnelActionModal(), 1000);
        } else if (status === 'NEEDS_ATTENTION') {
          showNeedsAttentionBanner(op);
          if (dom.tunnelActionError) {
            dom.tunnelActionError.textContent = '[NEEDS_ATTENTION] 操作触发了安全恢复闸门，请人工排查。';
            dom.tunnelActionError.classList.remove('hidden');
          }
          dom.tunnelActionProgress?.classList.add('hidden');
          if (dom.btnTunnelActionCancel) dom.btnTunnelActionCancel.disabled = false;
          await loadDashboardData();
        } else {
          if (dom.tunnelActionError) {
            dom.tunnelActionError.textContent = `[REJECTED] 操作被拒绝: ${op.failureCode || op.error || 'REJECTED'}`;
            dom.tunnelActionError.classList.remove('hidden');
          }
          dom.tunnelActionProgress?.classList.add('hidden');
          if (dom.btnTunnelActionCancel) dom.btnTunnelActionCancel.disabled = false;
          await loadDashboardData();
        }
      }
    } catch (pollErr) {
      console.warn('Tunnel action polling warning:', pollErr);
    }
  };

  poll();
  appState.tunnelActionTimer = setInterval(poll, 800);
}

// --------------------------------------------------------------------------
// Discovery Scan & Candidate Import
// --------------------------------------------------------------------------

export async function handleTriggerDiscovery() {
  if (dom.discoverySection) dom.discoverySection.classList.remove('hidden');
  if (dom.discoveryCandidatesContainer) {
    dom.discoveryCandidatesContainer.innerHTML = `
      <div class="loading-placeholder-sm">
        <div class="spinner"></div>
        <span>正在扫描本机已知配置来源...</span>
      </div>
    `;
  }

  try {
    const data = await apiRequest('/api/discovery');
    const candidates = Array.isArray(data.candidates) ? data.candidates : [];
    const inventory = Array.isArray(data.inventory) ? data.inventory : [];
    appState.discoveryCandidates = candidates;
    appState.discoveryInventory = inventory;
    renderDiscoveryCandidates(candidates);
    renderDiscoveryInventory(inventory);
  } catch (err) {
    const parsed = formatSafeError(err);
    if (dom.discoveryCandidatesContainer) {
      dom.discoveryCandidatesContainer.innerHTML = `
        <div class="form-error">扫描失败: ${escapeHtml(parsed.displayText)}</div>
      `;
    }
    if (dom.discoveryInventoryContainer) {
      dom.discoveryInventoryContainer.innerHTML = `
        <div class="form-error">清单获取失败: ${escapeHtml(parsed.displayText)}</div>
      `;
    }
  }
}

export function renderDiscoveryInventory(inventory) {
  if (!dom.discoveryInventoryContainer) return;
  dom.discoveryInventoryContainer.innerHTML = '';

  if (!inventory || inventory.length === 0) {
    dom.discoveryInventoryContainer.innerHTML = `
      <div class="empty-state">
        <p>暂无扫描到的源配置文件记录。</p>
      </div>
    `;
    return;
  }

  inventory.forEach(item => {
    const card = document.createElement('div');
    card.className = 'candidate-card inventory-card';

    let statusBadge = '<span class="badge badge-subtle">未知状态</span>';
    if (item.status === 'imported') {
      statusBadge = '<span class="badge badge-success">已导入 (imported)</span>';
    } else if (item.status === 'duplicate') {
      statusBadge = '<span class="badge badge-subtle">重复配置 (duplicate)</span>';
    } else if (item.status === 'found') {
      statusBadge = '<span class="badge badge-info">已发现 (found)</span>';
    } else if (item.status === 'ignored') {
      statusBadge = '<span class="badge badge-subtle">已忽略 (ignored)</span>';
    } else if (item.status === 'review') {
      statusBadge = '<span class="badge badge-warning">需复核 (review)</span>';
    } else if (item.status === 'error') {
      statusBadge = '<span class="badge badge-danger">错误/缺失 (error)</span>';
    }

    const credBadge = formatCredentialBadge(item.credentials, item);

    const typeStr = (item.type || 'TXT').toUpperCase();
    const canImport = item.status === 'found' && item.candidateId;

    card.innerHTML = `
      <div class="candidate-header">
        <div>
          <div class="candidate-title">${escapeHtml(item.displayName || item.filename)}</div>
          <div class="mcp-id-slug">${escapeHtml(item.filename)}</div>
        </div>
        <div class="mcp-badge-row">
          <span class="badge badge-subtle">${escapeHtml(typeStr)}</span>
          ${statusBadge}
          ${credBadge}
        </div>
      </div>

      <div class="candidate-meta">
        <div>路径: <span class="candidate-path">${escapeHtml(item.path || '未设置')}</span></div>
        ${item.reason ? `<div style="margin-top:4px; font-size:12px; color:var(--color-text-secondary,#555);">说明: ${escapeHtml(item.reason)}</div>` : ''}
      </div>

      ${canImport ? `
        <div class="candidate-actions">
          <button type="button" class="btn btn-primary btn-sm btn-import-inv" data-id="${escapeHtml(item.candidateId)}">
            导入到控制台
          </button>
        </div>
      ` : ''}
    `;

    if (canImport) {
      card.querySelector('.btn-import-inv')?.addEventListener('click', () => {
        const cand = appState.discoveryCandidates?.find(c => c.id === item.candidateId) || {
          id: item.candidateId,
          serviceId: item.serviceId,
          label: item.displayName,
          sourceConfigPath: item.path
        };
        openImportModal(cand);
      });
    }

    dom.discoveryInventoryContainer.appendChild(card);
  });
}

export function renderDiscoveryCandidates(candidates) {
  if (!dom.discoveryCandidatesContainer) return;
  dom.discoveryCandidatesContainer.innerHTML = '';

  if (candidates.length === 0) {
    dom.discoveryCandidatesContainer.innerHTML = `
      <div class="empty-state">
        <p>未在已知默认路径中发现新的未导入 MCP 配置文件。</p>
      </div>
    `;
    return;
  }

  candidates.forEach(cand => {
    const card = document.createElement('div');
    card.className = 'candidate-card';
    card.dataset.candidateId = cand.id;

    const credStatusBadge = formatCredentialBadge(cand.credentialStatus, cand);

    const sourceKind = (cand.sourceKind || 'config').toUpperCase();

    card.innerHTML = `
      <div class="candidate-header">
        <div>
          <div class="candidate-title">${escapeHtml(cand.label || cand.serviceId)}</div>
          <div class="mcp-id-slug">${escapeHtml(cand.serviceId || cand.id)}</div>
        </div>
        <div class="mcp-badge-row">
          <span class="badge badge-subtle">${escapeHtml(sourceKind)}</span>
          ${credStatusBadge}
        </div>
      </div>

      <div class="candidate-meta">
        <div>来源配置路径:</div>
        <div class="candidate-path">${escapeHtml(cand.sourceConfigPath || '-')}</div>
        ${cand.warnings?.length ? `<div class="form-error" style="padding:4px 8px; font-size:11px;">${cand.warnings.join('; ')}</div>` : ''}
      </div>

      <div class="candidate-actions">
        <button type="button" class="btn btn-primary btn-sm btn-import-candidate" data-id="${escapeHtml(cand.id)}">
          导入到控制台
        </button>
      </div>
    `;

    card.querySelector('.btn-import-candidate')?.addEventListener('click', () => openImportModal(cand));
    dom.discoveryCandidatesContainer.appendChild(card);
  });
}

export function openImportModal(candidate) {
  if (!dom.discoveryImportModal) return;
  appState.selectedCandidate = candidate;

  dom.importModalTitle.textContent = `导入服务: ${candidate.label || candidate.serviceId}`;
  dom.importModalError?.classList.add('hidden');

  if (dom.importCandidateInfo) {
    dom.importCandidateInfo.innerHTML = `
      <div><strong>服务名称:</strong> ${escapeHtml(candidate.label || candidate.serviceId)}</div>
      <div><strong>服务 ID:</strong> <span class="font-mono">${escapeHtml(candidate.serviceId)}</span></div>
      <div><strong>来源类型:</strong> ${escapeHtml(candidate.sourceKind || '-')}</div>
      <div><strong>来源文件:</strong> <span class="font-mono">${escapeHtml(candidate.sourceConfigPath || '-')}</span></div>
      <div><strong>文件指纹:</strong> <span class="font-mono">${escapeHtml(candidate.fingerprint ? candidate.fingerprint.slice(0, 16) + '...' : '-')}</span></div>
    `;
  }

  // Populate profiles merge dropdown
  if (dom.importMergeProfileSelect) {
    dom.importMergeProfileSelect.innerHTML = `
      <option value="">-- 生成独立本机配置账号 (默认) --</option>
    `;
    appState.profiles.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `合并到已有配置: ${p.label || p.id}`;
      dom.importMergeProfileSelect.appendChild(opt);
    });
  }

  dom.discoveryImportModal.classList.remove('hidden');
}

export function closeImportModal() {
  appState.selectedCandidate = null;
  dom.discoveryImportModal?.classList.add('hidden');
}

export async function handleConfirmImport() {
  const candidate = appState.selectedCandidate;
  if (!candidate) return;

  const mergeProfileId = dom.importMergeProfileSelect?.value || undefined;
  if (dom.btnConfirmImport) dom.btnConfirmImport.disabled = true;

  try {
    await apiRequest(`/api/discovery/${encodeURIComponent(candidate.id)}/import`, {
      method: 'POST',
      body: {
        expectedFingerprint: candidate.fingerprint,
        expectedRevision: appState.revision,
        mergeProfileId
      }
    });

    closeImportModal();
    showAlert('success', '导入成功', `配置 "${candidate.label || candidate.serviceId}" 已成功导入控制台。`);
    await loadDashboardData();
    await handleTriggerDiscovery(); // Refresh discovery list
  } catch (err) {
    if (dom.btnConfirmImport) dom.btnConfirmImport.disabled = false;
    const parsed = formatSafeError(err);
    if (dom.importModalError) {
      dom.importModalError.textContent = `导入失败: ${parsed.displayText}`;
      dom.importModalError.classList.remove('hidden');
    }
  }
}

// ==========================================================================
// Event Listeners & Tab Navigation
// ==========================================================================

export function switchDashboardTab(targetTab) {
  appState.activeTab = targetTab;

  if (targetTab === 'accounts') {
    dom.tabNavAccounts?.classList.add('active');
    dom.tabNavMcps?.classList.remove('active');
    dom.sectionAccounts?.classList.remove('hidden');
    dom.sectionAccounts?.classList.add('active');
    dom.sectionMcps?.classList.add('hidden');
    dom.sectionMcps?.classList.remove('active');
  } else {
    dom.tabNavAccounts?.classList.remove('active');
    dom.tabNavMcps?.classList.add('active');
    dom.sectionAccounts?.classList.add('hidden');
    dom.sectionAccounts?.classList.remove('active');
    dom.sectionMcps?.classList.remove('hidden');
    dom.sectionMcps?.classList.add('active');
  }
}

export function bindEventListeners() {
  if (typeof document === 'undefined') return;

  // Header & Status
  dom.btnRefreshState?.addEventListener('click', () => {
    fetchAuthState();
    showAlert('success', '已刷新', '系统状态与配置列表已同步最新。');
  });
  dom.btnLogout?.addEventListener('click', handleLogout);

  // Alerts
  dom.btnCloseAlert?.addEventListener('click', hideAlert);
  dom.btnDismissNeedsAttention?.addEventListener('click', hideNeedsAttentionBanner);
  dom.btnConfirmRecovery?.addEventListener('click', async () => {
    const actionId = dom.btnConfirmRecovery.dataset.actionId;
    if (!actionId) return;
    try {
      dom.btnConfirmRecovery.disabled = true;
      dom.btnConfirmRecovery.textContent = '正在确认...';
      const res = await apiRequest('/api/recovery/acknowledge', {
        method: 'POST',
        body: { actionId }
      });
      if (res && res.ok) {
        showAlert('success', '恢复闸门已解除', '已安全确认零副作用失败记录，恢复闸门已解除。');
        hideNeedsAttentionBanner();
        await loadDashboardData();
      } else {
        const errMsg = res?.code ? (SAFE_ERROR_MESSAGES[res.code] || res.code) : '确认恢复失败';
        showAlert('error', '解除闸门失败', errMsg);
        dom.btnConfirmRecovery.disabled = false;
        dom.btnConfirmRecovery.textContent = '确认恢复';
      }
    } catch (err) {
      showAlert('error', '解除闸门异常', err.message || '网络或权限请求异常');
      dom.btnConfirmRecovery.disabled = false;
      dom.btnConfirmRecovery.textContent = '确认恢复';
    }
  });

  // Setup & Login
  dom.setupForm?.addEventListener('submit', handleSetupSubmit);
  dom.loginForm?.addEventListener('submit', handleLoginSubmit);

  // Navigation Tabs
  dom.tabNavAccounts?.addEventListener('click', () => switchDashboardTab('accounts'));
  dom.tabNavMcps?.addEventListener('click', () => switchDashboardTab('mcps'));

  // Switch Control
  dom.switchProfileSelect?.addEventListener('change', updateSelectedProfilePreview);
  dom.btnExecuteSwitch?.addEventListener('click', handleExecuteSwitch);

  // Profile Modal
  dom.btnOpenCreateModal?.addEventListener('click', openCreateProfileModal);
  dom.btnCloseModal?.addEventListener('click', closeProfileModal);
  dom.btnModalCancel?.addEventListener('click', closeProfileModal);
  dom.profileForm?.addEventListener('submit', handleProfileFormSubmit);

  dom.profileModal?.addEventListener('click', (e) => {
    if (e.target === dom.profileModal) closeProfileModal();
  });

  // MCP Services Section Actions
  dom.btnOpenAddMcp?.addEventListener('click', openAddMcpModal);
  dom.btnScanDiscovery?.addEventListener('click', handleTriggerDiscovery);
  dom.btnRescanDiscovery?.addEventListener('click', handleTriggerDiscovery);
  dom.btnCloseDiscovery?.addEventListener('click', () => {
    dom.discoverySection?.classList.add('hidden');
  });

  // Add / Edit MCP Modal
  dom.btnCloseMcpModal?.addEventListener('click', closeMcpModal);
  dom.btnMcpCancel?.addEventListener('click', closeMcpModal);
  dom.mcpForm?.addEventListener('submit', handleMcpFormSubmit);
  dom.mcpFormType?.addEventListener('change', (e) => updateBindingTypeFields(e.target.value));

  dom.btnAddArg?.addEventListener('click', () => addArgRow());
  dom.btnAddHeader?.addEventListener('click', () => addHeaderRow());
  dom.btnAddEnv?.addEventListener('click', () => addEnvRow());

  dom.mcpModal?.addEventListener('click', (e) => {
    if (e.target === dom.mcpModal) closeMcpModal();
  });

  // Locations Modal
  dom.btnCloseLocationsModal?.addEventListener('click', () => {
    dom.mcpLocationsModal?.classList.add('hidden');
  });
  dom.btnCloseLocationsFooter?.addEventListener('click', () => {
    dom.mcpLocationsModal?.classList.add('hidden');
  });
  dom.mcpLocationsModal?.addEventListener('click', (e) => {
    if (e.target === dom.mcpLocationsModal) dom.mcpLocationsModal.classList.add('hidden');
  });

  // Lifecycle Modal
  dom.btnCloseLifecycleModal?.addEventListener('click', closeLifecycleModal);
  dom.btnLifecycleCancel?.addEventListener('click', closeLifecycleModal);
  dom.btnLifecycleStop?.addEventListener('click', handleExecuteStopMcp);
  dom.btnLifecycleDelete?.addEventListener('click', handleExecuteDeleteMcp);
  dom.mcpLifecycleModal?.addEventListener('click', (e) => {
    if (e.target === dom.mcpLifecycleModal) closeLifecycleModal();
  });

  // Tunnel Action Modal (Start / Stop / Restart)
  dom.btnCloseTunnelActionModal?.addEventListener('click', closeTunnelActionModal);
  dom.btnTunnelActionCancel?.addEventListener('click', closeTunnelActionModal);
  dom.btnTunnelActionConfirm?.addEventListener('click', handleExecuteTunnelAction);
  dom.tunnelActionProfileSelect?.addEventListener('change', () => {
    appState.tunnelActionCarrierToken = null;
    appState.tunnelActionIdempotencyKey = null;
  });
  dom.tunnelActionModal?.addEventListener('click', (e) => {
    if (e.target === dom.tunnelActionModal) closeTunnelActionModal();
  });

  // Discovery Import Modal
  dom.btnCloseImportModal?.addEventListener('click', closeImportModal);
  dom.btnCancelImport?.addEventListener('click', closeImportModal);
  dom.btnConfirmImport?.addEventListener('click', handleConfirmImport);
  dom.discoveryImportModal?.addEventListener('click', (e) => {
    if (e.target === dom.discoveryImportModal) closeImportModal();
  });
}

// ==========================================================================
// Initialization
// ==========================================================================

export function initApp() {
  initDomReferences();
  bindEventListeners();
  fetchAuthState();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
}

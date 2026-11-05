/**
 * Synthetic Chinese UI Smoke Test Script for MCP Tunnel Account Manager
 * Uses Node 25 native WebSocket & Chrome DevTools Protocol (CDP)
 * Zero npm dependencies, private synthetic server & temporary browser profile.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), '..');

// Import production startManager
const { startManager } = await import(pathToFileURL(path.join(projectRoot, 'src', 'main.mjs')).href);

// Detect installed browser executable (Chrome or Edge)
function findBrowserExecutable() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env.CHROME_BIN,
    process.env.EDGE_BIN
  ].filter(Boolean);

  for (const exe of candidates) {
    if (fs.existsSync(exe)) {
      return exe;
    }
  }
  return null;
}

export async function runRegistryUiSmoke({ reportDir } = {}) {
  const browserExe = findBrowserExecutable();
  if (!browserExe) {
    throw new Error('NO_BROWSER_FOUND: Neither Google Chrome nor Microsoft Edge executable was found.');
  }

  const reportsDirectory = reportDir || path.join(projectRoot, 'reports', 'registry-argon-5');
  const screenshotDirectory = path.join(reportsDirectory, 'screenshots');
  fs.mkdirSync(reportsDirectory, { recursive: true });
  fs.mkdirSync(screenshotDirectory, { recursive: true });

  const serverTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-smoke-server-'));
  const browserTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-smoke-browser-'));

  const testResults = {
    suite: 'smoke-registry-ui',
    timestamp: new Date().toISOString(),
    browser: {
      executable: browserExe,
      userDataDir: browserTempDir
    },
    server: {
      dataDir: serverTempDir,
      port: 0
    },
    steps: [],
    success: false
  };

  function logStep(name, details = {}) {
    console.log(`[SMOKE-STEP] ${name}`);
    testResults.steps.push({ name, timestamp: new Date().toISOString(), ...details });
  }

  let manager = null;
  let browserProcess = null;
  let ws = null;

  try {
    // ------------------------------------------------------------------------
    // 1. Start Synthetic Manager Server (Ephemeral Port 0, Temp Data, Isolated)
    // ------------------------------------------------------------------------
    logStep('1. START_SYNTHETIC_SERVER');
    manager = await startManager({
      dataDir: serverTempDir,
      port: 0,
      host: '127.0.0.1',
      discoveryOptions: { sources: [] },
      store: {
        getServiceRuntime: (serviceId) => ({ state: 'stopped', activeProfileId: null })
      },
      locations: {
        describe: async (def, runtime) => ({
          sourceConfigPath: 'C:\\Users\\Synthetic\\.config\\mcp-synthetic.json',
          effectiveConfigPath: 'C:\\Users\\Synthetic\\.config\\effective-mcp.json',
          installationRoot: 'C:\\Program Files\\SyntheticMcp',
          executable: 'C:\\Windows\\System32\\cmd.exe',
          cwd: 'C:\\Users\\Synthetic',
          managerStorePath: path.join(serverTempDir, 'manager.db'),
          sourceConfigExists: true,
          effectiveConfigExists: true,
          installationExists: true,
          executableExists: true,
          cwdExists: true,
          managerStoreExists: true
        }),
        reveal: async (def, role, runtime) => ({
          ok: true,
          opened: true,
          role,
          stub: true
        })
      }
    });

    testResults.server.url = manager.url;
    testResults.server.port = manager.port;

    // Read generated bootstrap code
    const bootstrapPath = path.join(serverTempDir, 'bootstrap-code.txt');
    const bootstrapCode = fs.readFileSync(bootstrapPath, 'utf8').trim();

    // Pre-seed an initial profile to test existing profile rendering
    await manager.store.createProfile({
      id: 'prof_initial_seed',
      label: '预设基准配置',
      services: {
        'overleaf-mcp': { tunnelId: 'tun_ovl_998877', apiKey: 'sec_key_ovl_1' },
        'antigravity-mcp': { tunnelId: 'tun_anti_665544', apiKey: 'sec_key_anti_2' }
      }
    });

    // ------------------------------------------------------------------------
    // 2. Launch Browser with Temporary Profile & Loopback CDP
    // ------------------------------------------------------------------------
    logStep('2. SPAWN_BROWSER_CDP');
    browserProcess = spawn(browserExe, [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${browserTempDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,960',
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      'about:blank'
    ], { stdio: 'pipe' });

    // Wait for DevToolsActivePort file
    let cdpPort = null;
    const activePortFile = path.join(browserTempDir, 'DevToolsActivePort');
    for (let i = 0; i < 40; i++) {
      if (fs.existsSync(activePortFile)) {
        const lines = fs.readFileSync(activePortFile, 'utf8').trim().split('\n');
        cdpPort = parseInt(lines[0], 10);
        break;
      }
      await new Promise(r => setTimeout(r, 100));
    }

    if (!cdpPort) {
      throw new Error('Failed to read DevToolsActivePort from temporary browser profile.');
    }
    testResults.browser.cdpPort = cdpPort;

    // Retrieve target page debugger URL
    const listRes = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
    const targets = await listRes.json();
    const pageTarget = targets.find(t => t.type === 'page') || targets[0];
    if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
      throw new Error('No page target found on CDP endpoint.');
    }

    // Connect via native WebSocket
    ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    let messageId = 1;
    const pendingRequests = new Map();
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id && pendingRequests.has(data.id)) {
        const { resolve, reject } = pendingRequests.get(data.id);
        pendingRequests.delete(data.id);
        if (data.error) {
          reject(new Error(`CDP Error [${data.error.code}]: ${data.error.message}`));
        } else {
          resolve(data.result);
        }
      }
    };

    function cdpCall(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = messageId++;
        pendingRequests.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    async function evalPage(expression) {
      let code = expression.trim();
      if (!code.startsWith('(() =>') && !code.startsWith('(function') && (code.includes('\n') || code.includes(';') || code.includes('return ') || code.startsWith('const ') || code.startsWith('let '))) {
        if (!code.includes('return ')) {
          code = `(() => {\n${code}\n})()`;
        } else {
          code = `(() => {\n${code}\n})()`;
        }
      }
      const res = await cdpCall('Runtime.evaluate', {
        expression: code,
        awaitPromise: true,
        returnByValue: true
      });
      if (res.exceptionDetails) {
        const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.exception?.value || res.exceptionDetails.text || JSON.stringify(res.exceptionDetails);
        throw new Error(`Page Eval Error: ${desc}\nExpression: ${code}`);
      }
      return res.result?.value;
    }

    async function waitForCondition(desc, fn, timeoutMs = 8000) {
      const start = Date.now();
      let lastErr = null;
      while (Date.now() - start < timeoutMs) {
        try {
          const ok = await fn();
          if (ok) return ok;
        } catch (err) {
          lastErr = err;
        }
        await new Promise(r => setTimeout(r, 150));
      }
      throw new Error(`Timeout waiting for condition: ${desc}${lastErr ? ` (last error: ${lastErr.message})` : ''}`);
    }

    await cdpCall('Page.enable');
    await cdpCall('Runtime.enable');
    await cdpCall('DOM.enable');

    // ------------------------------------------------------------------------
    // 3. Navigate to UI & Verify Initial Setup View
    // ------------------------------------------------------------------------
    logStep('3. NAVIGATE_AND_SETUP');
    await cdpCall('Page.navigate', { url: manager.url });

    await waitForCondition('Setup card displayed', async () => {
      return await evalPage(`
        const card = document.getElementById('setup-card');
        return card && !card.classList.contains('hidden');
      `);
    });

    // Check status badge
    const initialStatus = await evalPage(`document.getElementById('status-value')?.textContent`);
    if (initialStatus !== '待初始化') {
      throw new Error(`Expected initial status '待初始化', got '${initialStatus}'`);
    }

    // Submit setup form with bootstrapCode and admin password
    await evalPage(`
      document.getElementById('setup-bootstrap-code').value = ${JSON.stringify(bootstrapCode)};
      document.getElementById('setup-password').value = 'AdminPassword123!';
      document.getElementById('setup-confirm-password').value = 'AdminPassword123!';
      document.getElementById('setup-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    `);

    // ------------------------------------------------------------------------
    // 4. Admin Login Flow
    // ------------------------------------------------------------------------
    logStep('4. ADMIN_LOGIN');
    await waitForCondition('Login card displayed after setup', async () => {
      return await evalPage(`
        const card = document.getElementById('login-card');
        return card && !card.classList.contains('hidden');
      `);
    });

    const loginStatus = await evalPage(`document.getElementById('status-value')?.textContent`);
    if (loginStatus !== '待认证') {
      throw new Error(`Expected login status '待认证', got '${loginStatus}'`);
    }

    // Submit login form
    await evalPage(`
      document.getElementById('login-password').value = 'AdminPassword123!';
      document.getElementById('login-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    `);

    await waitForCondition('Dashboard view displayed after login', async () => {
      return await evalPage(`
        const dash = document.getElementById('dashboard-view');
        return dash && !dash.classList.contains('hidden');
      `);
    });

    const readyStatus = await evalPage(`document.getElementById('status-value')?.textContent`);
    if (readyStatus !== '运行正常') {
      throw new Error(`Expected dashboard status '运行正常', got '${readyStatus}'`);
    }

    // ------------------------------------------------------------------------
    // 5. Verify Existing Profiles & Dynamic Switch Targets
    // ------------------------------------------------------------------------
    logStep('5. VERIFY_EXISTING_PROFILES_AND_TARGETS');
    await waitForCondition('Profiles container rendered with seed profile', async () => {
      const count = await evalPage(`document.querySelectorAll('.profile-card').length`);
      return count >= 1;
    });

    const seedProfileLabel = await evalPage(`
      document.querySelector('.profile-card .profile-card-title span')?.textContent
    `);
    if (!seedProfileLabel?.includes('预设基准配置')) {
      throw new Error(`Expected seed profile '预设基准配置', got '${seedProfileLabel}'`);
    }

    // Verify switch target checkboxes contain registered services
    const targetsCount = await evalPage(`
      document.querySelectorAll('#switch-targets-container input[type="checkbox"]').length
    `);
    if (targetsCount < 2) {
      throw new Error(`Expected at least 2 switch targets, got ${targetsCount}`);
    }

    // ------------------------------------------------------------------------
    // 6. Switch Tab to MCP Services Registry & Verify Existing Services
    // ------------------------------------------------------------------------
    logStep('6. SWITCH_TAB_MCPS_REGISTRY');
    await evalPage(`document.getElementById('tab-nav-mcps').click()`);

    await waitForCondition('MCP section displayed and active', async () => {
      return await evalPage(`
        const sec = document.getElementById('section-mcps');
        return sec && !sec.classList.contains('hidden');
      `);
    });

    const initialMcpCardsCount = await evalPage(`
      document.querySelectorAll('#mcps-container .mcp-card').length
    `);
    if (initialMcpCardsCount < 2) {
      throw new Error(`Expected at least 2 MCP cards initially, got ${initialMcpCardsCount}`);
    }

    // ------------------------------------------------------------------------
    // 7. Add New Stdio MCP Service with Args & Secret Environment Variables
    // ------------------------------------------------------------------------
    logStep('7. ADD_NEW_MCP_SERVICE');
    await evalPage(`document.getElementById('btn-open-add-mcp').click()`);

    await waitForCondition('MCP modal opened', async () => {
      return await evalPage(`
        const m = document.getElementById('mcp-modal');
        return m && !m.classList.contains('hidden');
      `);
    });

    // Fill MCP form
    await evalPage(`
      document.getElementById('mcp-form-label').value = '数据分析管道服务 (Stdio)';
      document.getElementById('mcp-form-type').value = 'stdio';
      document.getElementById('mcp-form-executable').value = 'C:\\\\Windows\\\\System32\\\\cmd.exe';
      document.getElementById('mcp-form-cwd').value = 'C:\\\\Users\\\\Synthetic';
      
      // Add argument
      document.getElementById('btn-add-arg').click();
      const argRow = document.querySelector('#mcp-args-container .dynamic-row:last-child');
      if (argRow) {
        argRow.querySelector('.arg-val').value = '/c';
        argRow.querySelector('.arg-secret').checked = false;
      }

      // Add environment variable
      document.getElementById('btn-add-env').click();
      const envRow = document.querySelector('#mcp-env-container .dynamic-row:last-child');
      if (envRow) {
        envRow.querySelector('.env-name').value = 'ANALYTICS_SECRET_KEY';
        envRow.querySelector('.env-val').value = 'top-secret-token-12345';
        envRow.querySelector('.env-secret').checked = true;
      }

      document.getElementById('mcp-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    `);

    await waitForCondition('MCP modal closed and new card rendered', async () => {
      const modalHidden = await evalPage(`document.getElementById('mcp-modal').classList.contains('hidden')`);
      const count = await evalPage(`document.querySelectorAll('#mcps-container .mcp-card').length`);
      return modalHidden && count === initialMcpCardsCount + 1;
    });

    // ------------------------------------------------------------------------
    // 8. Edit MCP Service, Verify Secret Retention & Enabled / PendingApply
    // ------------------------------------------------------------------------
    logStep('8. EDIT_MCP_SECRET_RETAIN');
    // Open edit modal for the newly added card
    await evalPage(`
      const cards = Array.from(document.querySelectorAll('#mcps-container .mcp-card'));
      const targetCard = cards.find(c => c.textContent.includes('数据分析管道服务'));
      if (targetCard) {
        targetCard.querySelector('.btn-mcp-edit').click();
      }
    `);

    await waitForCondition('Edit MCP modal opened with populated data', async () => {
      return await evalPage(`
        const m = document.getElementById('mcp-modal');
        const val = document.getElementById('mcp-form-label')?.value;
        return m && !m.classList.contains('hidden') && val && val.includes('数据分析管道服务');
      `);
    });

    // Update label, leave secret environment variable blank (verifying secret retention)
    await evalPage(`
      document.getElementById('mcp-form-label').value = '数据分析管道服务 (已调优)';
      const envValInput = document.querySelector('#mcp-env-container .env-val');
      if (envValInput) {
        envValInput.value = ''; // Blank value must be retained on PATCH
      }
      document.getElementById('mcp-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    `);

    await waitForCondition('Edit MCP modal closed and label updated', async () => {
      const modalHidden = await evalPage(`document.getElementById('mcp-modal').classList.contains('hidden')`);
      const cardText = await evalPage(`document.getElementById('mcps-container').textContent`);
      return modalHidden && cardText.includes('数据分析管道服务 (已调优)');
    });

    // ------------------------------------------------------------------------
    // 9. Locations Modal: Check All 6 Roles, Copy Path, & Reveal Stub
    // ------------------------------------------------------------------------
    logStep('9. LOCATIONS_MODAL_6_ROLES_AND_REVEAL');
    await evalPage(`
      const cards = Array.from(document.querySelectorAll('#mcps-container .mcp-card'));
      const targetCard = cards.find(c => c.textContent.includes('数据分析管道服务'));
      if (targetCard) {
        targetCard.querySelector('.btn-mcp-locations').click();
      }
    `);

    await waitForCondition('Locations modal opened', async () => {
      const modal = await evalPage(`
        const m = document.getElementById('mcp-locations-modal');
        return m && !m.classList.contains('hidden');
      `);
      return modal;
    });

    // Verify all 6 roles
    const rolesCheck = await evalPage(`
      const roles = ['sourceConfig', 'effectiveConfig', 'installation', 'executable', 'workingDirectory', 'managerStore'];
      return roles.every(r => {
        const p = document.getElementById('path-' + r);
        const s = document.getElementById('status-' + r);
        return p && p.textContent && p.textContent !== '正在获取...' && s && s.textContent !== '-';
      });
    `);
    if (!rolesCheck) {
      throw new Error('One or more of the 6 location roles was not properly rendered in Locations modal.');
    }

    // Trigger copy path feedback
    await evalPage(`
      const copyBtn = document.querySelector('.btn-copy-path[data-target="path-executable"]');
      if (copyBtn) copyBtn.click();
    `);
    await waitForCondition('Copy path feedback shown', async () => {
      const text = await evalPage(`document.getElementById('locations-action-feedback')?.textContent`);
      return text && text.length > 0;
    });

    // Trigger reveal directory with stub
    await evalPage(`
      const revealBtn = document.querySelector('.btn-reveal-path[data-role="executable"]');
      if (revealBtn) revealBtn.click();
    `);
    await waitForCondition('Reveal feedback shown', async () => {
      const text = await evalPage(`
        (() => {
          const el = document.getElementById('locations-action-feedback') ||
                     document.getElementById('locations-feedback') ||
                     document.querySelector('[role="status"]');
          return el ? el.textContent.trim() : '';
        })()
      `);
      return text && (text.includes('已请求打开所在目录') || text.includes('已成功在文件资源管理器中打开包含目录'));
    });

    // Close locations modal
    await evalPage(`document.getElementById('btn-close-locations-modal').click()`);
    await waitForCondition('Locations modal closed', async () => {
      return await evalPage(`document.getElementById('mcp-locations-modal').classList.contains('hidden')`);
    });

    // ------------------------------------------------------------------------
    // 10. Profile Credential Edit & Retain on Accounts Tab
    // ------------------------------------------------------------------------
    logStep('10. PROFILE_CREDENTIAL_EDIT');
    await evalPage(`document.getElementById('tab-nav-accounts').click()`);
    await waitForCondition('Accounts tab active', async () => {
      return await evalPage(`
        const sec = document.getElementById('section-accounts');
        return sec && !sec.classList.contains('hidden');
      `);
    });

    // Click Add New Profile
    await evalPage(`document.getElementById('btn-open-create-modal').click()`);
    await waitForCondition('Profile modal opened', async () => {
      return await evalPage(`!document.getElementById('profile-modal').classList.contains('hidden')`);
    });

    // Fill profile form
    await evalPage(`
      document.getElementById('form-profile-label').value = '高可用生产账号配置';
      const tunnelInputs = document.querySelectorAll('#profile-services-container .form-service-tunnel');
      tunnelInputs.forEach(inp => { inp.value = 'tun_prod_8899'; });
      const keyInputs = document.querySelectorAll('#profile-services-container .form-service-key');
      keyInputs.forEach(inp => { inp.value = 'prod_api_key_initial'; });
      document.getElementById('profile-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    `);

    await waitForCondition('Profile modal closed and new profile card rendered', async () => {
      const hidden = await evalPage(`document.getElementById('profile-modal').classList.contains('hidden')`);
      const text = await evalPage(`document.getElementById('profiles-container').textContent`);
      return hidden && text.includes('高可用生产账号配置');
    });

    // Edit profile and leave API Key blank to verify retention
    await evalPage(`
      const cards = Array.from(document.querySelectorAll('.profile-card'));
      const targetCard = cards.find(c => c.textContent.includes('高可用生产账号配置'));
      if (targetCard) {
        targetCard.querySelector('.btn-edit').click();
      }
    `);

    await waitForCondition('Profile modal opened in edit mode', async () => {
      return await evalPage(`
        const m = document.getElementById('profile-modal');
        const val = document.getElementById('form-profile-label')?.value;
        return m && !m.classList.contains('hidden') && val && val.includes('高可用生产账号配置');
      `);
    });

    await evalPage(`
      document.getElementById('form-profile-label').value = '高可用生产账号配置 (已验证)';
      const apiKeyInputs = document.querySelectorAll('#profile-services-container .form-service-key');
      apiKeyInputs.forEach(inp => {
        inp.value = ''; // Blank must be omitted on PATCH
      });
      document.getElementById('profile-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    `);

    await waitForCondition('Profile modal closed and label updated', async () => {
      const hidden = await evalPage(`document.getElementById('profile-modal').classList.contains('hidden')`);
      const text = await evalPage(`document.getElementById('profiles-container').textContent`);
      return hidden && text.includes('高可用生产账号配置 (已验证)');
    });

    // ------------------------------------------------------------------------
    // 11. Delete Stopped Service with Explicit Console Preservation Notice
    // ------------------------------------------------------------------------
    logStep('11. DELETE_STOPPED_SERVICE_LIFECYCLE');
    await evalPage(`document.getElementById('tab-nav-mcps').click()`);
    await waitForCondition('MCP section displayed', async () => {
      return await evalPage(`
        const sec = document.getElementById('section-mcps');
        return sec && !sec.classList.contains('hidden');
      `);
    });

    // Click delete on our created custom MCP card
    await evalPage(`
      const cards = Array.from(document.querySelectorAll('#mcps-container .mcp-card'));
      const targetCard = cards.find(c => c.textContent.includes('数据分析管道服务'));
      if (targetCard) {
        targetCard.querySelector('.btn-mcp-delete').click();
      }
    `);

    await waitForCondition('Lifecycle modal opened', async () => {
      return await evalPage(`
        const m = document.getElementById('mcp-lifecycle-modal');
        return m && !m.classList.contains('hidden');
      `);
    });

    // Verify preservation notice is explicitly present
    const noticeVerified = await evalPage(`
      const stoppedBody = document.getElementById('lifecycle-body-stopped');
      const isVisible = stoppedBody && !stoppedBody.classList.contains('hidden');
      const text = stoppedBody ? stoppedBody.textContent : '';
      return isVisible && text.includes('仅从控制台注销') && text.includes('绝对不会删除或卸载本机上的程序文件');
    `);
    if (!noticeVerified) {
      throw new Error('Lifecycle modal missing required console-only removal and file preservation notice.');
    }

    // Confirm deletion
    await evalPage(`document.getElementById('btn-lifecycle-delete').click()`);

    await waitForCondition('Lifecycle modal closed and card removed', async () => {
      const modalHidden = await evalPage(`document.getElementById('mcp-lifecycle-modal').classList.contains('hidden')`);
      const count = await evalPage(`document.querySelectorAll('#mcps-container .mcp-card').length`);
      return modalHidden && count === initialMcpCardsCount;
    });

    // ------------------------------------------------------------------------
    // 12. Capture Safe Screenshot & Write Evidence Reports
    // ------------------------------------------------------------------------
    logStep('12. CAPTURE_SAFE_SCREENSHOT');
    // Switch to Accounts overview tab for a rich screenshot
    await evalPage(`document.getElementById('tab-nav-accounts').click()`);
    await new Promise(r => setTimeout(r, 600));

    const screenshotData = await cdpCall('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false
    });

    const screenshotPath = path.join(screenshotDirectory, 'ui-smoke.png');
    fs.writeFileSync(screenshotPath, Buffer.from(screenshotData.data, 'base64'));

    const fileStat = fs.statSync(screenshotPath);
    logStep('12.1 SCREENSHOT_SAVED', { path: screenshotPath, sizeBytes: fileStat.size });

    testResults.screenshot = {
      path: screenshotPath,
      sizeBytes: fileStat.size
    };
    testResults.success = true;

  } finally {
    // ------------------------------------------------------------------------
    // Clean Shutdown & Resource Cleanup (Exact Owned Handles Only)
    // ------------------------------------------------------------------------
    if (ws) {
      try { ws.close(); } catch (_) {}
    }
    if (browserProcess && !browserProcess.killed) {
      try { browserProcess.kill(); } catch (_) {}
    }
    if (manager && typeof manager.close === 'function') {
      try { await manager.close(); } catch (_) {}
    }

    // Wait briefly for process to exit before removing temp files
    await new Promise(r => setTimeout(r, 600));
    try { fs.rmSync(serverTempDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(browserTempDir, { recursive: true, force: true }); } catch (_) {}
  }

  const jsonReportPath = path.join(reportsDirectory, 'smoke-registry-ui.json');
  fs.writeFileSync(jsonReportPath, JSON.stringify(testResults, null, 2), 'utf8');
  console.log(`[SMOKE-COMPLETE] Report written to: ${jsonReportPath}`);

  return testResults;
}

// Allow direct CLI execution
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runRegistryUiSmoke()
    .then((res) => {
      console.log('Smoke test passed successfully! Steps count:', res.steps.length);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Smoke test failed:', err);
      process.exit(1);
    });
}

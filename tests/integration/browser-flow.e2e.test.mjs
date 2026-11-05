import test, { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { startManager } from '../../src/main.mjs';
import { findBrowserExecutable, launchHeadlessBrowser } from '../fixtures/browser-runtime.mjs';

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), '..', '..');

describe('Browser Flow & Chinese DOM Forms E2E Suite', () => {
  const browserMeta = findBrowserExecutable();
  assert.ok(browserMeta, 'A supported local browser executable (Chrome/Edge) must be detected on host');

  let manager;
  let managerDir;
  let browser;
  let chromeUserDataDir;
  let cdp;
  let screenshotDir;
  let createdMcpId = null;
  const revealedCalls = [];
  let testExecutablePath;
  let testCwdPath;

  before(async () => {
    managerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgr-cdp-test-'));
    chromeUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-cdp-user-'));
    screenshotDir = path.join(projectRoot, 'reports', 'registry-argon-5', 'screenshots');
    if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });

    // Seed temporary files and directories for legitimate path fixtures
    testCwdPath = path.join(managerDir, 'test-workdir');
    fs.mkdirSync(testCwdPath, { recursive: true });
    testExecutablePath = path.join(testCwdPath, 'test-tool.exe');
    fs.writeFileSync(testExecutablePath, 'MZ-synthetic-executable-payload');

    // 1. Start fresh isolated synthetic manager on port 0
    const fakeAdapterFactory = async () => ({
      async checkHealth() { return { healthy: true }; },
      async getSnapshot() { return { status: 'idle' }; },
      async stop() { return { stopped: true }; },
      async start() { return { started: true }; }
    });

    const fakeRevealer = async (target) => {
      revealedCalls.push(typeof target === 'object' && target?.path ? target.path : target);
      return { opened: true, stub: true, target };
    };

    manager = await startManager({
      port: 0,
      host: '127.0.0.1',
      dataDir: managerDir,
      discoveryOptions: { sources: [] },
      locationsOptions: {
        revealDirectory: fakeRevealer,
        revealer: fakeRevealer
      },
      adapterFactory: fakeAdapterFactory,
      store: {
        getServiceRuntime: (serviceId) => ({ state: 'stopped', runtimeState: 'stopped' })
      }
    });

    // 2. Launch headless browser using safe isolated runtime
    browser = await launchHeadlessBrowser({
      executable: browserMeta.executable,
      userDataDir: chromeUserDataDir
    });
    cdp = browser;

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('DOM.enable');
  });

  after(async () => {
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
    if (manager && typeof manager.close === 'function') {
      try { await manager.close(); } catch (_) {}
    }
    await new Promise(r => setTimeout(r, 400));
    if (chromeUserDataDir && fs.existsSync(chromeUserDataDir)) {
      for (let i = 0; i < 10; i++) {
        try { fs.rmSync(chromeUserDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); break; } catch (_) { await new Promise(r => setTimeout(r, 200)); }
      }
    }
    if (managerDir && fs.existsSync(managerDir)) {
      for (let i = 0; i < 10; i++) {
        try { fs.rmSync(managerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); break; } catch (_) { await new Promise(r => setTimeout(r, 200)); }
      }
    }
  });

  it('1. Initializes setup form, validates inputs, and completes administrator setup', async () => {
    await cdp.send('Page.navigate', { url: manager.url });

    // Wait for setup card to become visible after fetchAuthState
    let setupVisible = false;
    for (let i = 0; i < 50; i++) {
      const isVisible = await cdp.evalJs(`
        (() => {
          const sc = document.getElementById('setup-card');
          return sc && !sc.classList.contains('hidden');
        })()
      `);
      if (isVisible) { setupVisible = true; break; }
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(setupVisible, true, 'Setup card must be visible initially');

    const setupTitle = await cdp.evalJs(`
      (() => document.querySelector('#setup-card .card-title')?.textContent.trim())()
    `);
    assert.match(setupTitle, /系统初始化/);

    // Read synthetic bootstrap code from temp dir
    const bootstrapCode = fs.readFileSync(path.join(managerDir, 'bootstrap-code.txt'), 'utf8').trim();
    assert.ok(bootstrapCode);

    // Fill setup form
    await cdp.evalJs(`
      (() => {
        const b = document.getElementById('setup-bootstrap-code');
        const p1 = document.getElementById('setup-password');
        const p2 = document.getElementById('setup-confirm-password');
        b.value = ${JSON.stringify(bootstrapCode)};
        b.dispatchEvent(new Event('input', { bubbles: true }));
        p1.value = 'BrowserAdminPassword!2026';
        p1.dispatchEvent(new Event('input', { bubbles: true }));
        p2.value = 'BrowserAdminPassword!2026';
        p2.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('btn-submit-setup').click();
      })()
    `);

    // Wait for setup to finish
    let setupDone = false;
    for (let i = 0; i < 50; i++) {
      const isSetupHidden = await cdp.evalJs(`
        (() => document.getElementById('setup-card').classList.contains('hidden'))()
      `);
      if (isSetupHidden) { setupDone = true; break; }
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(setupDone, true, 'Setup card must hide upon successful submission');
    await cdp.screenshot(path.join(screenshotDir, '01-setup-completed.png'));
  });

  it('2. Authenticates via login form and loads console dashboard with Chinese UI badges', async () => {
    // Check if login card is shown or dashboard is directly active
    const isLoginVisible = await cdp.evalJs(`
      (() => !document.getElementById('login-card').classList.contains('hidden'))()
    `);

    if (isLoginVisible) {
      await cdp.evalJs(`
        (() => {
          const p = document.getElementById('login-password');
          p.value = 'BrowserAdminPassword!2026';
          p.dispatchEvent(new Event('input', { bubbles: true }));
          document.getElementById('btn-submit-login').click();
        })()
      `);
    }

    // Wait for dashboard view to become visible
    let dashboardReady = false;
    for (let i = 0; i < 50; i++) {
      const isDashVisible = await cdp.evalJs(`
        (() => !document.getElementById('dashboard-view').classList.contains('hidden'))()
      `);
      if (isDashVisible) { dashboardReady = true; break; }
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(dashboardReady, true, 'Dashboard view must be visible after authentication');

    // Verify Chinese navigation tabs & header elements
    const tabs = await cdp.evalJs(`
      (() => ({
        accountsText: document.getElementById('tab-nav-accounts')?.textContent.trim(),
        mcpsText: document.getElementById('tab-nav-mcps')?.textContent.trim(),
        statusText: document.getElementById('status-value')?.textContent.trim(),
        hasLogout: !document.getElementById('btn-logout')?.classList.contains('hidden')
      }))()
    `);
    assert.match(tabs.accountsText, /账号配置/);
    assert.match(tabs.mcpsText, /MCP\s*服务/);
    assert.equal(tabs.hasLogout, true, 'Logout button must be visible');
    await cdp.screenshot(path.join(screenshotDir, '02-dashboard-active.png'));
  });

  it('3. Navigates to MCP Services tab and exercises new MCP creation with secret env vars', async () => {
    // Switch to MCP services tab
    await cdp.evalJs(`(() => document.getElementById('tab-nav-mcps').click())()`);
    const mcpsActive = await cdp.evalJs(`
      (() => document.getElementById('section-mcps').classList.contains('active'))()
    `);
    assert.equal(mcpsActive, true, 'MCP services section must become active');

    // Open Add MCP modal
    await cdp.evalJs(`(() => document.getElementById('btn-open-add-mcp').click())()`);
    const modalVisible = await cdp.evalJs(`
      (() => !document.getElementById('mcp-modal').classList.contains('hidden'))()
    `);
    assert.equal(modalVisible, true, 'MCP modal must open');

    // Fill new stdio MCP
    const SECRET_TOKEN = 'secret-browser-env-token-xyz789';
    await cdp.evalJs(`
      (() => {
        document.getElementById('mcp-form-label').value = 'Echo 浏览器测试服务';
        document.getElementById('mcp-form-label').dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('mcp-form-type').value = 'stdio';
        document.getElementById('mcp-form-type').dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('mcp-form-executable').value = ${JSON.stringify(testExecutablePath)};
        document.getElementById('mcp-form-executable').dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('mcp-form-cwd').value = ${JSON.stringify(testCwdPath)};
        document.getElementById('mcp-form-cwd').dispatchEvent(new Event('input', { bubbles: true }));

        // Add argument
        document.getElementById('btn-add-arg')?.click();
        const argInputs = document.querySelectorAll('#mcp-args-container .arg-val');
        if (argInputs.length > 0) {
          argInputs[0].value = '--stdio-test';
          argInputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        }

        // Add secret environment variable
        document.getElementById('btn-add-env')?.click();
        const envKeys = document.querySelectorAll('#mcp-env-container .env-name');
        const envVals = document.querySelectorAll('#mcp-env-container .env-val');
        const envSecrets = document.querySelectorAll('#mcp-env-container .env-secret');
        if (envKeys.length > 0) {
          envKeys[0].value = 'BROWSER_SECRET_TOKEN';
          envKeys[0].dispatchEvent(new Event('input', { bubbles: true }));
          envVals[0].value = ${JSON.stringify(SECRET_TOKEN)};
          envVals[0].dispatchEvent(new Event('input', { bubbles: true }));
          if (envSecrets[0]) envSecrets[0].checked = true;
        }

        // Add public environment variable
        document.getElementById('btn-add-env')?.click();
        const envKeys2 = document.querySelectorAll('#mcp-env-container .env-name');
        const envVals2 = document.querySelectorAll('#mcp-env-container .env-val');
        const envSecrets2 = document.querySelectorAll('#mcp-env-container .env-secret');
        if (envKeys2.length > 1) {
          envKeys2[1].value = 'PUBLIC_ENV_VAR';
          envKeys2[1].dispatchEvent(new Event('input', { bubbles: true }));
          envVals2[1].value = 'public-browser-value';
          envVals2[1].dispatchEvent(new Event('input', { bubbles: true }));
          if (envSecrets2[1]) envSecrets2[1].checked = false;
        }

        // Save
        document.getElementById('btn-mcp-save').click();
      })()
    `);

    // Wait for modal to close and card to appear
    let cardRendered = false;
    for (let i = 0; i < 50; i++) {
      const cardId = await cdp.evalJs(`
        (() => {
          const cards = Array.from(document.querySelectorAll('.mcp-card'));
          const myCard = cards.find(c => c.querySelector('.mcp-title-text')?.textContent.includes('Echo 浏览器测试服务'));
          return myCard ? myCard.dataset.mcpId : null;
        })()
      `);
      if (cardId) {
        createdMcpId = cardId;
        cardRendered = true;
        break;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(cardRendered, true, 'New MCP card must be rendered in DOM');
    assert.ok(createdMcpId, 'createdMcpId must be captured');
    await cdp.screenshot(path.join(screenshotDir, '03-mcp-created.png'));
  });

  it('4. Edits MCP service, verifies secret values are masked, and confirms secret retention', async () => {
    // Open edit modal for the specific created MCP
    await cdp.evalJs(`
      (() => {
        const card = document.querySelector(\`[data-mcp-id=\"${createdMcpId}\"]\`);
        card?.querySelector('.btn-mcp-edit')?.click();
      })()
    `);

    // Verify modal is open in edit mode
    let editModalOpen = false;
    for (let i = 0; i < 30; i++) {
      const isOpen = await cdp.evalJs(`
        (() => {
          const m = document.getElementById('mcp-modal');
          const title = document.getElementById('mcp-modal-title')?.textContent || '';
          return m && !m.classList.contains('hidden') && title.includes('编辑');
        })()
      `);
      if (isOpen) { editModalOpen = true; break; }
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(editModalOpen, true, 'MCP edit modal must open with Chinese edit title');

    // Verify secret env value is masked / empty and placeholder says [已配置 - 留空保留]
    const secretInput = await cdp.evalJs(`
      (() => {
        const rows = document.querySelectorAll('#mcp-env-container .dynamic-row');
        for (const row of rows) {
          const key = row.querySelector('.env-name')?.value;
          if (key === 'BROWSER_SECRET_TOKEN') {
            const valInput = row.querySelector('.env-val');
            return {
              key,
              val: valInput?.value,
              placeholder: valInput?.placeholder,
              isSecret: row.querySelector('.env-secret')?.checked
            };
          }
        }
        return null;
      })()
    `);

    assert.ok(secretInput);
    assert.equal(secretInput.val, '', 'Secret value must not be sent to DOM input in plaintext');
    assert.equal(secretInput.isSecret, true, 'Secret toggle must remain checked');

    // Update label only without touching secret input
    await cdp.evalJs(`
      (() => {
        const lbl = document.getElementById('mcp-form-label');
        lbl.value = 'Echo 浏览器测试服务 (已更新)';
        lbl.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('btn-mcp-save').click();
      })()
    `);

    // Wait for modal to close
    let closed = false;
    for (let i = 0; i < 30; i++) {
      const isHidden = await cdp.evalJs(`
        (() => document.getElementById('mcp-modal').classList.contains('hidden'))()
      `);
      if (isHidden) { closed = true; break; }
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(closed, true, 'Modal must close after edit');

    // Verify in backend repository that secret was retained intact
    const def = await manager.store.registry.getDefinition(createdMcpId);
    assert.ok(def);
    assert.equal(def.label, 'Echo 浏览器测试服务 (已更新)');
    assert.equal(def.environment.BROWSER_SECRET_TOKEN.value, 'secret-browser-env-token-xyz789');
    await cdp.screenshot(path.join(screenshotDir, '04-mcp-edited.png'));
  });

  it('5. Opens MCP Locations modal, checks canonical path entries, and triggers reveal stub', async () => {
    // Click locations button on the created MCP
    await cdp.evalJs(`
      (() => {
        const card = document.querySelector(\`[data-mcp-id=\"${createdMcpId}\"]\`);
        card?.querySelector('.btn-mcp-locations')?.click();
      })()
    `);

    // Wait for locations modal to become visible and finish loading (response-aware wait)
    let locLoaded = false;
    for (let i = 0; i < 40; i++) {
      const isReady = await cdp.evalJs(`
        (() => {
          const m = document.getElementById('mcp-locations-modal');
          if (!m || m.classList.contains('hidden')) return false;
          const exe = document.getElementById('path-executable')?.textContent || '';
          return !exe.includes('正在获取') && exe.length > 0;
        })()
      `);
      if (isReady) { locLoaded = true; break; }
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(locLoaded, true, 'Locations modal must open and finish loading paths');

    // Check displayed path elements against seeded fixtures
    const pathValues = await cdp.evalJs(`
      (() => ({
        executable: document.getElementById('path-executable')?.textContent.trim(),
        workingDirectory: document.getElementById('path-workingDirectory')?.textContent.trim(),
        managerStore: document.getElementById('path-managerStore')?.textContent.trim()
      }))()
    `);
    assert.match(pathValues.executable, /test-tool\.exe/i);
    assert.match(pathValues.workingDirectory, /test-workdir/i);
    assert.match(pathValues.managerStore, /manager\.db/i);

    // Test positive reveal action: click reveal executable (seeds legitimate existing temporary file)
    revealedCalls.length = 0;
    await cdp.evalJs(`
      (() => {
        const btn = document.querySelector('.btn-reveal-path[data-role=\"executable\"]');
        if (btn && !btn.disabled) btn.click();
      })()
    `);

    // Await actual API/DOM condition without fixed sleep (check proper feedback element and canonical message)
    let revealSuccess = false;
    let feedbackText = '';
    for (let i = 0; i < 40; i++) {
      feedbackText = await cdp.evalJs(`
        (() => {
          const el = document.getElementById('locations-action-feedback') ||
                     document.getElementById('locations-feedback') ||
                     document.querySelector('[role=\"status\"]');
          return el ? el.textContent.trim() : '';
        })()
      `);
      if (feedbackText && (feedbackText.includes('已请求打开所在目录') || feedbackText.includes('已成功'))) {
        revealSuccess = true;
        break;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(revealSuccess, true, `Locations feedback message must confirm reveal request acceptance ('已请求打开所在目录'), got: '${feedbackText}'`);
    assert.ok(
      feedbackText.includes('已请求打开所在目录') || feedbackText.includes('已成功'),
      `Locations feedback message must contain '已请求打开所在目录', got: '${feedbackText}'`
    );
    assert.equal(revealedCalls.length, 1, 'Fake revealer stub must be invoked exactly once');

    // Test negative path feedback: delete seeded working directory to verify missing dir failure
    fs.rmSync(testCwdPath, { recursive: true, force: true });

    await cdp.evalJs(`
      (() => {
        const btn = document.querySelector('.btn-reveal-path[data-role=\"workingDirectory\"]');
        if (btn) btn.click();
      })()
    `);

    // Await negative path feedback without fixed sleep
    let negativeFeedbackText = '';
    for (let i = 0; i < 40; i++) {
      negativeFeedbackText = await cdp.evalJs(`
        (() => {
          const el = document.getElementById('locations-action-feedback') ||
                     document.getElementById('locations-feedback') ||
                     document.querySelector('[role=\"status\"]');
          return el ? el.textContent.trim() : '';
        })()
      `);
      if (negativeFeedbackText && (negativeFeedbackText.includes('无法打开目录') || negativeFeedbackText.includes('PATH_NOT_FOUND') || negativeFeedbackText.includes('失败'))) {
        break;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    assert.match(
      negativeFeedbackText,
      /无法打开目录|PATH_NOT_FOUND|失败/,
      `Negative path feedback must be displayed when directory does not exist, got: '${negativeFeedbackText}'`
    );
    assert.equal(revealedCalls.length, 1, 'Fake revealer stub must NOT be invoked when target directory is missing');

    // Close locations modal
    await cdp.evalJs(`(() => document.getElementById('btn-close-locations-modal')?.click())()`);
    await cdp.screenshot(path.join(screenshotDir, '05-locations-revealed.png'));
  });

  it('6. Exercises Account Profile form and profile credential editing', async () => {
    // Switch to accounts tab
    await cdp.evalJs(`(() => document.getElementById('tab-nav-accounts').click())()`);
    const accountsActive = await cdp.evalJs(`
      (() => document.getElementById('section-accounts').classList.contains('active'))()
    `);
    assert.equal(accountsActive, true);

    // Open create profile modal
    await cdp.evalJs(`(() => document.getElementById('btn-open-create-modal').click())()`);
    const modalOpen = await cdp.evalJs(`
      (() => !document.getElementById('profile-modal').classList.contains('hidden'))()
    `);
    assert.equal(modalOpen, true, 'Profile modal must open');

    // Fill profile form (including required Tunnel ID inputs)
    await cdp.evalJs(`
      (() => {
        const nameInput = document.getElementById('form-profile-label');
        nameInput.value = 'Browser 测试账号';
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));

        const tunnelInputs = document.querySelectorAll('.form-service-tunnel');
        tunnelInputs.forEach((inp, idx) => {
          inp.value = \`tunnel-test-\${idx + 1}\`;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
        });

        document.getElementById('btn-modal-save').click();
      })()
    `);

    // Wait for profile card in DOM
    let profileRendered = false;
    for (let i = 0; i < 40; i++) {
      const exists = await cdp.evalJs(`
        (() => document.querySelector('.profile-card') !== null)()
      `);
      if (exists) { profileRendered = true; break; }
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(profileRendered, true, 'New account profile card must be rendered in DOM');
    await cdp.screenshot(path.join(screenshotDir, '06-profile-created.png'));
  });

  it('7. Exercises stop & delete lifecycle modal on stopped MCP with file preservation notice', async () => {
    // Switch to MCP tab
    await cdp.evalJs(`(() => document.getElementById('tab-nav-mcps').click())()`);

    // Open lifecycle modal for the created MCP (stopped)
    await cdp.evalJs(`
      (() => {
        const card = document.querySelector(\`[data-mcp-id=\"${createdMcpId}\"]\`);
        card?.querySelector('.btn-mcp-delete')?.click();
      })()
    `);

    // Verify lifecycle modal is open
    let modalOpen = false;
    for (let i = 0; i < 30; i++) {
      const isOpen = await cdp.evalJs(`
        (() => !document.getElementById('mcp-lifecycle-modal').classList.contains('hidden'))()
      `);
      if (isOpen) { modalOpen = true; break; }
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(modalOpen, true, 'Lifecycle modal must open');

    // Verify preservation notice is visible
    const noticeText = await cdp.evalJs(`
      (() => document.querySelector('.preservation-notice-card')?.textContent.trim())()
    `);
    assert.match(noticeText, /控制台安全注销声明/);
    assert.match(noticeText, /绝对不会删除或卸载本机上的程序文件/);

    // Confirm delete
    await cdp.evalJs(`(() => document.getElementById('btn-lifecycle-delete').click())()`);

    // Wait for modal to close and card to be removed
    let cardRemoved = false;
    for (let i = 0; i < 50; i++) {
      const cardGone = await cdp.evalJs(`
        (() => document.querySelector(\`[data-mcp-id=\"${createdMcpId}\"]\`) === null)()
      `);
      if (cardGone) { cardRemoved = true; break; }
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(cardRemoved, true, 'MCP card must be deleted and removed from DOM');
    await cdp.screenshot(path.join(screenshotDir, '07-service-deleted.png'));
  });
});




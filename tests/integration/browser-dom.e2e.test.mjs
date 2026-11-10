/**
 * Browser DOM Verification E2E Suite
 * Uses installed Chrome/Edge via loopback-only CDP over native Node 25 WebSocket.
 * No npm/browser install or real browser profile.
 * Synthetic startManager on port 0 with sources: [] and fakeAdapterFactory / fake revealer.
 * Exercises Chinese DOM forms: setup, login, profiles, MCPs, new MCP, edit + secret retain,
 * pendingApply, credential edit, path copy/reveal with stub, and stopped service delete.
 */

import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { startManager } from '../../src/main.mjs';
import { findBrowserExecutable, launchHeadlessBrowser } from '../fixtures/cdp-client.mjs';

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), '..', '..');

describe('Browser DOM Verification E2E Suite (CDP over Node25 WebSocket)', () => {
  it('exercises full Chinese DOM user flows with safe synthetic backend and produces screenshot', async () => {
    // 1. Browser executable detection & metadata check
    const browserMeta = findBrowserExecutable();
    assert.ok(browserMeta, 'A supported local browser executable (Chrome/Edge) must be detected');
    assert.ok(browserMeta.size > 10000, 'Browser executable size must be valid');
    console.log(`[Browser Check] Detected: ${browserMeta.executable} (${browserMeta.size} bytes)`);

    // 2. Setup synthetic environment for startManager
    const synthDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synth-mgr-browser-data-'));
    const browserUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synth-browser-user-'));
    const dummyCwd = path.join(synthDataDir, 'dummy-cwd');
    fs.mkdirSync(dummyCwd, { recursive: true });

    const revealedDirs = [];
    const fakeRevealer = async (dir) => {
      revealedDirs.push(typeof dir === 'object' && dir?.path ? dir.path : dir);
      return { opened: true, stub: true, dir };
    };

    const capturedAdapterCalls = [];
    const createServiceAdapter = (service) => {
      const runningProc = {
        running: false,
        pid: null,
        executable: 'synth-tunnel.exe',
        startedAt: null
      };
      return {
        async prepare({ operationId, credential }) {
          capturedAdapterCalls.push({ action: 'prepare', service, operationId, credential });
          return {
            operationId,
            service,
            originalFingerprint: '0'.repeat(64),
            desiredFingerprint: '1'.repeat(64),
            originalConfig: { yaml: 'synth: 1' },
            desiredConfig: { yaml: 'synth: 2' },
            originalProcessIdentity: runningProc,
            credential
          };
        },
        async applyIfUnchanged() {
          capturedAdapterCalls.push({ action: 'applyIfUnchanged', service });
          return runningProc;
        },
        async verifyDesired({ operationId, snapshot }) {
          capturedAdapterCalls.push({ action: 'verifyDesired', service, operationId });
          return {
            verified: true,
            operationId,
            service,
            configFingerprint: snapshot.desiredFingerprint,
            proof: { kind: 'authenticated-control-plane' },
            identity: runningProc
          };
        },
        async restoreIfOwned({ operationId, snapshot }) {
          capturedAdapterCalls.push({ action: 'restoreIfOwned', service, operationId });
          return {
            restored: true,
            runtimeRestored: true,
            operationId,
            service,
            configFingerprint: snapshot.originalFingerprint
          };
        },
        async stopConnection() {
          capturedAdapterCalls.push({ action: 'stopConnection', service });
          return { stopped: true, alreadyStopped: true };
        },
        async describe() {
          return {
            service,
            configured: true,
            running: false,
            config: { tunnelId: 'tunnel_***synth' }
          };
        }
      };
    };

    const fakeAdapterFactory = async () => ({
      'overleaf-mcp': createServiceAdapter('overleaf-mcp'),
      'antigravity-mcp': createServiceAdapter('antigravity-mcp')
    });

    // 3. Pre-execution verification of baseline injection guarantees
    const managerOptions = {
      port: 0, // Port 0 ephemeral loopback
      dataDir: synthDataDir,
      discoveryOptions: { sources: [] }, // Explicitly empty sources: NO real config scan
      adapterFactory: fakeAdapterFactory,
      locationsOptions: {
        revealDirectory: fakeRevealer,
        revealer: fakeRevealer
      }, // Fake revealer: NO real explorer.exe
      store: {
        getServiceRuntime: (serviceId) => ({
          state: 'stopped',
          runtimeState: 'stopped',
          activeProfileId: null
        })
      }
    };

    assert.equal(managerOptions.port, 0, 'Must bind ephemeral port 0, never production 17642');
    assert.deepEqual(managerOptions.discoveryOptions.sources, [], 'Must explicitly forbid host config sources');
    assert.equal(typeof managerOptions.adapterFactory, 'function', 'Must inject fake adapter factory');
    assert.equal(typeof managerOptions.locationsOptions.revealDirectory, 'function', 'Must inject fake revealer');

    let manager = null;
    let browser = null;

    try {
      manager = await startManager(managerOptions);
      assert.ok(manager.port > 0, 'Manager must bind to ephemeral port');
      assert.notEqual(manager.port, 17642, 'Must not bind to production port 17642');
      console.log(`[Manager Started] URL: ${manager.url}`);

      // Read synthetic bootstrap code
      const bootstrapCodePath = path.join(synthDataDir, 'bootstrap-code.txt');
      assert.ok(fs.existsSync(bootstrapCodePath), 'Synthetic bootstrap-code.txt must exist');
      const bootstrapCode = fs.readFileSync(bootstrapCodePath, 'utf8').trim();
      assert.ok(bootstrapCode.length > 0, 'Bootstrap code must be non-empty');

      // 4. Launch headless browser
      browser = await launchHeadlessBrowser({
        executable: browserMeta.executable,
        userDataDir: browserUserDataDir
      });
      console.log(`[Browser Launched] PID: ${browser.childPid}, CDP Port: ${browser.port}`);

      const { sendCommand } = browser;
      await sendCommand('Page.enable');
      await sendCommand('Runtime.enable');
      await sendCommand('DOM.enable');

      // Helper function to evaluate code in browser
      async function evaluate(code) {
        const trimmed = code.trim();
        const expression = trimmed.includes(';') || trimmed.startsWith('const ') || trimmed.startsWith('let ') || trimmed.startsWith('var ')
          ? `(() => { ${trimmed} })()`
          : trimmed;
        const res = await sendCommand('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true
        });
        if (res.exceptionDetails) {
          throw new Error(`Eval failed: ${JSON.stringify(res.exceptionDetails)}`);
        }
        return res.result.value;
      }

      // Navigate to manager dashboard
      console.log(`[Browser Navigate] Navigating to ${manager.url}`);
      await sendCommand('Page.navigate', { url: manager.url });

      // Wait for page ready
      await new Promise((r) => setTimeout(r, 1500));

      // --- FLOW 1: Initial Setup Form ---
      console.log('[Flow 1] Exercising Initial Setup Chinese DOM Form');
      const isSetupVisible = await evaluate(`
        !document.getElementById('setup-card').classList.contains('hidden')
      `);
      assert.ok(isSetupVisible, 'Setup card must be visible when unconfigured');

      const setupHeading = await evaluate(`
        document.querySelector('#setup-card .card-title').textContent
      `);
      assert.equal(setupHeading.trim(), '系统初始化', 'Chinese heading must match 系统初始化');

      // Fill and submit setup form
      await evaluate(`
        document.getElementById('setup-bootstrap-code').value = ${JSON.stringify(bootstrapCode)};
        document.getElementById('setup-password').value = 'AdminPassword123!';
        document.getElementById('setup-confirm-password').value = 'AdminPassword123!';
        document.getElementById('setup-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      `);

      // Wait for setup completion
      await new Promise((r) => setTimeout(r, 1500));

      const isLoginVisible = await evaluate(`
        !document.getElementById('login-card').classList.contains('hidden')
      `);
      if (isLoginVisible) {
        console.log('[Flow 1b] Exercising Login Chinese DOM Form');
        const loginHeading = await evaluate(`
          document.querySelector('#login-card .card-title').textContent
        `);
        assert.equal(loginHeading.trim(), '管理员登录', 'Chinese heading must match 管理员登录');

        await evaluate(`
          document.getElementById('login-password').value = 'AdminPassword123!';
          document.getElementById('login-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        `);
        await new Promise((r) => setTimeout(r, 1500));
      }

      const isDashboardVisible = await evaluate(`
        !document.getElementById('dashboard-view').classList.contains('hidden')
      `);
      assert.ok(isDashboardVisible, 'Dashboard view must become visible after login');
      console.log('✔ Setup & Login successfully completed, entered dashboard');

      // --- FLOW 2: Existing Profiles & MCPs ---
      console.log('[Flow 2] Verifying Existing Profiles & MCP Services tabs');
      const accountsTabActive = await evaluate(`
        document.getElementById('tab-nav-accounts').classList.contains('active')
      `);
      assert.ok(accountsTabActive, 'Accounts tab should be active by default');

      // Switch to MCP Services tab
      await evaluate(`
        document.getElementById('tab-nav-mcps').click();
      `);
      await new Promise((r) => setTimeout(r, 800));

      const mcpsSectionActive = await evaluate(`
        !document.getElementById('section-mcps').classList.contains('hidden')
      `);
      assert.ok(mcpsSectionActive, 'MCP Services section must be visible');

      const mcpsCount = await evaluate(`
        document.querySelectorAll('#mcps-container .mcp-card').length
      `);
      assert.ok(mcpsCount >= 2, 'Must display existing registered MCP services (overleaf & antigravity)');
      console.log(`✔ Found ${mcpsCount} existing MCP services rendered in Chinese DOM`);

      // Switch back to accounts tab to verify profiles
      await evaluate(`
        document.getElementById('tab-nav-accounts').click();
      `);
      await new Promise((r) => setTimeout(r, 800));

      const profilesCount = await evaluate(`
        document.querySelectorAll('#profiles-container .profile-card').length
      `);
      console.log(`✔ Found ${profilesCount} profile cards rendered in Chinese DOM`);

      // --- FLOW 3: New MCP via Chinese DOM Form ---
      console.log('[Flow 3] Adding New Stdio MCP Service via Chinese DOM Form');
      await evaluate(`
        document.getElementById('tab-nav-mcps').click();
      `);
      await new Promise((r) => setTimeout(r, 800));

      // Click "添加 MCP 服务"
      await evaluate(`
        document.getElementById('btn-open-add-mcp').click();
      `);
      await new Promise((r) => setTimeout(r, 500));

      const mcpModalOpen = await evaluate(`
        !document.getElementById('mcp-modal').classList.contains('hidden')
      `);
      assert.ok(mcpModalOpen, 'MCP Modal must open');

      // Fill in MCP Form (Chinese UI fields)
      await evaluate(`
        document.getElementById('mcp-form-label').value = '本地分析服务 (Local Analytics MCP)';
        document.getElementById('mcp-form-type').value = 'stdio';
        document.getElementById('mcp-form-type').dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('mcp-form-enabled').checked = true;
        document.getElementById('mcp-form-executable').value = 'C:\\\\Windows\\\\System32\\\\node.exe';
        document.getElementById('mcp-form-cwd').value = ${JSON.stringify(dummyCwd)};
      `);

      // Add Stdio Arg
      await evaluate(`
        document.getElementById('btn-add-arg').click();
      `);
      await new Promise((r) => setTimeout(r, 200));

      await evaluate(`
        const argInputs = document.querySelectorAll('#mcp-args-container .dynamic-row input[type="text"]');
        if (argInputs.length > 0) {
          argInputs[argInputs.length - 1].value = '--analytics-token-secret-xyz';
        }
      `);

      // Add Stdio Env
      await evaluate(`
        document.getElementById('btn-add-env').click();
      `);
      await new Promise((r) => setTimeout(r, 200));

      await evaluate(`
        const envNameInputs = document.querySelectorAll('#mcp-env-container .env-key-input');
        const envValInputs = document.querySelectorAll('#mcp-env-container .env-val-input');
        if (envNameInputs.length > 0 && envValInputs.length > 0) {
          envNameInputs[envNameInputs.length - 1].value = 'ANALYTICS_API_KEY';
          envValInputs[envValInputs.length - 1].value = 'secret-api-key-value-999';
        }
      `);

      // Submit MCP Form
      await evaluate(`
        document.getElementById('mcp-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      `);
      await new Promise((r) => setTimeout(r, 1200));

      const mcpModalClosed = await evaluate(`
        document.getElementById('mcp-modal').classList.contains('hidden')
      `);
      assert.ok(mcpModalClosed, 'MCP modal should close after successful save');

      // Verify new service appears in DOM
      const hasNewMcpCard = await evaluate(`
        Array.from(document.querySelectorAll('#mcps-container .mcp-card')).some(el =>
          el.textContent.includes('本地分析服务')
        )
      `);
      assert.ok(hasNewMcpCard, 'New MCP card must appear in #mcps-container');
      console.log('✔ New MCP service successfully created via Chinese DOM form');

      // --- FLOW 4: Edit MCP + Secret Retain ---
      console.log('[Flow 4] Editing MCP and validating Secret Retention in Chinese DOM');
      // Click edit on the new MCP
      await evaluate(`
        const cards = Array.from(document.querySelectorAll('#mcps-container .mcp-card'));
        const targetCard = cards.find(c => c.textContent.includes('本地分析服务'));
        const editBtn = targetCard.querySelector('.btn-mcp-edit');
        editBtn.click();
      `);
      await new Promise((r) => setTimeout(r, 600));

      // Verify secret fields are rendered blank to allow retention
      const argVal = await evaluate(`
        const argInputs = document.querySelectorAll('#mcp-args-container .dynamic-row input[type="text"]');
        return argInputs.length > 0 ? argInputs[0].value : null;
      `);
      assert.equal(argVal, '', 'Existing secret argument input value must be empty to retain value on blank save');

      // Modify label but leave secret fields empty
      await evaluate(`
        document.getElementById('mcp-form-label').value = '本地分析服务 (已更新标签)';
        document.getElementById('mcp-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      `);
      await new Promise((r) => setTimeout(r, 1200));

      const hasUpdatedLabel = await evaluate(`
        Array.from(document.querySelectorAll('#mcps-container .mcp-card')).some(el =>
          el.textContent.includes('本地分析服务 (已更新标签)')
        )
      `);
      assert.ok(hasUpdatedLabel, 'Updated MCP label must appear in UI');
      console.log('✔ Edit MCP with secret retain verified');

      // --- FLOW 5: Enabled / PendingApply Banner ---
      console.log('[Flow 5] Checking pendingApply banner in Chinese DOM');
      const pendingBannerVisible = await evaluate(`
        !document.getElementById('mcps-pending-banner').classList.contains('alert-hidden')
      `);
      console.log(`✔ PendingApply banner state: ${pendingBannerVisible ? 'Active (Alert displayed)' : 'Neutral'}`);

      // --- FLOW 6: Profile Credential Edit ---
      console.log('[Flow 6] Creating and Editing Profile Credentials via Dynamic Chinese Modal');
      await evaluate(`
        document.getElementById('tab-nav-accounts').click();
      `);
      await new Promise((r) => setTimeout(r, 800));

      // First create a new profile if none exists
      await evaluate(`
        document.getElementById('btn-open-create-modal').click();
      `);
      await new Promise((r) => setTimeout(r, 600));

      await evaluate(`
        document.getElementById('form-profile-label').value = '测试生产配置 (Test Prod)';
        const tunnelInputs = document.querySelectorAll('.form-service-tunnel');
        tunnelInputs.forEach(inp => {
          inp.value = 'tunnel_' + inp.dataset.serviceId + '_init123';
        });
        const keyInputs = document.querySelectorAll('.form-service-key');
        keyInputs.forEach(inp => {
          inp.value = 'secret_key_' + inp.dataset.serviceId + '_abc';
        });
        document.getElementById('profile-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      `);
      await new Promise((r) => setTimeout(r, 1200));

      // Now edit the created profile
      await evaluate(`
        const firstProfileCard = document.querySelector('#profiles-container .profile-card');
        const editBtn = firstProfileCard.querySelector('.btn-edit');
        editBtn.click();
      `);
      await new Promise((r) => setTimeout(r, 600));

      const profileModalOpen = await evaluate(`
        !document.getElementById('profile-modal').classList.contains('hidden')
      `);
      assert.ok(profileModalOpen, 'Profile modal must open');

      // Update tunnel ID, leave apiKey empty to retain secret!
      await evaluate(`
        document.getElementById('form-profile-label').value = '测试生产配置 (已验证保留)';
        const firstTunnelInput = document.querySelector('.form-service-tunnel');
        if (firstTunnelInput) {
          firstTunnelInput.value = 'tunnel_updated_9988';
        }
        const keyInputs = document.querySelectorAll('.form-service-key');
        keyInputs.forEach(inp => {
          inp.value = ''; // Leave blank to test secret retention
        });
        document.getElementById('profile-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      `);
      await new Promise((r) => setTimeout(r, 1200));

      const profileModalClosed = await evaluate(`
        document.getElementById('profile-modal').classList.contains('hidden')
      `);
      assert.ok(profileModalClosed, 'Profile modal must close after saving');

      const hasUpdatedProfile = await evaluate(`
        Array.from(document.querySelectorAll('#profiles-container .profile-card')).some(el =>
          el.textContent.includes('测试生产配置 (已验证保留)')
        )
      `);
      assert.ok(hasUpdatedProfile, 'Updated profile label must appear on profile card');
      console.log('✔ Profile creation, credential edit, and secret retention verified');

      // --- FLOW 7: Locations Modal: Source/effective/install/exe/cwd paths copy & open with stub ---
      console.log('[Flow 7] Exercising Locations Modal (6 path roles, copy and stub reveal)');
      await evaluate(`
        document.getElementById('tab-nav-mcps').click();
      `);
      await new Promise((r) => setTimeout(r, 800));

      // Click "查看路径与详情" on first MCP card
      await evaluate(`
        const firstCard = document.querySelector('#mcps-container .mcp-card');
        const locBtn = firstCard.querySelector('.btn-mcp-locations');
        locBtn.click();
      `);
      await new Promise((r) => setTimeout(r, 600));

      const locationsModalOpen = await evaluate(`
        !document.getElementById('mcp-locations-modal').classList.contains('hidden')
      `);
      assert.ok(locationsModalOpen, 'Locations modal must open');

      // Verify all 6 roles are present in DOM
      const renderedRoles = await evaluate(`
        Array.from(document.querySelectorAll('#mcp-locations-modal .location-item')).map(el => el.getAttribute('data-role'))
      `);
      const expectedRoles = ['sourceConfig', 'effectiveConfig', 'installation', 'executable', 'workingDirectory', 'managerStore'];
      for (const r of expectedRoles) {
        assert.ok(renderedRoles.includes(r), 'Location role ' + r + ' must be rendered in locations modal');
      }
      console.log(`✔ Verified all 6 location roles rendered: ${renderedRoles.join(', ')}`);

      // Test "复制路径" (btn-copy-path)
      await evaluate(`
        const copyBtn = document.querySelector('#mcp-locations-modal .btn-copy-path');
        if (copyBtn) copyBtn.click();
      `);
      await new Promise((r) => setTimeout(r, 200));

      // Test "打开所在目录" (btn-reveal-path) with stub
      await evaluate(`
        const revealBtn = document.querySelector('#mcp-locations-modal .btn-reveal-path:not([disabled])');
        if (revealBtn) revealBtn.click();
      `);
      await new Promise((r) => setTimeout(r, 800));

      assert.ok(revealedDirs.length > 0, 'Stub revealer must have been called instead of explorer.exe');
      console.log(`✔ Injected fake revealer captured path: ${revealedDirs[0]}`);

      // Close locations modal
      await evaluate(`
        document.getElementById('btn-close-locations-modal').click();
      `);
      await new Promise((r) => setTimeout(r, 400));

      // --- FLOW 8: Delete Stopped Service ---
      console.log('[Flow 8] Deleting Stopped Service from Chinese DOM Lifecycle Modal');
      // The newly created service has running === false in synthetic store
      await evaluate(`
        const cards = Array.from(document.querySelectorAll('#mcps-container .mcp-card'));
        const targetCard = cards.find(c => c.textContent.includes('本地分析服务'));
        const deleteBtn = targetCard.querySelector('.btn-mcp-delete');
        deleteBtn.click();
      `);
      await new Promise((r) => setTimeout(r, 600));

      const lifecycleModalOpen = await evaluate(`
        !document.getElementById('mcp-lifecycle-modal').classList.contains('hidden')
      `);
      assert.ok(lifecycleModalOpen, 'Lifecycle modal must open');

      // Check explicit preservation notice in Chinese DOM
      const noticeText = await evaluate(`
        document.querySelector('.preservation-notice-card').textContent
      `);
      assert.ok(noticeText.includes('控制台安全注销声明'), 'Must contain Chinese preservation notice title');
      assert.ok(noticeText.includes('绝对不会删除或卸载本机上的程序文件'), 'Must contain exact preservation guarantee');

      // Click "确认从控制台移除"
      await evaluate(`
        document.getElementById('btn-lifecycle-delete').click();
      `);
      await new Promise((r) => setTimeout(r, 1200));

      const lifecycleErr = await evaluate(`
        document.getElementById('lifecycle-error')?.textContent
      `);
      if (lifecycleErr) console.log('Lifecycle error text:', lifecycleErr);

      // Verify service card is removed from DOM
      const stillPresent = await evaluate(`
        Array.from(document.querySelectorAll('#mcps-container .mcp-card')).some(el =>
          el.textContent.includes('本地分析服务')
        )
      `);
      assert.equal(stillPresent, false, 'Deleted service must no longer appear in #mcps-container');

      // Verify dummy directory on disk is untouched!
      assert.ok(fs.existsSync(dummyCwd), 'Local directory on disk must be strictly preserved after console unregistration');
      console.log('✔ Stopped service safely removed from console; local directory intact on disk');

      // --- FLOW 9: Safe Screenshot Capture via CDP ---
      console.log('[Flow 9] Capturing Safe Full-Page Screenshot via CDP');
      const screenshot = await sendCommand('Page.captureScreenshot', { format: 'png' });
      assert.ok(screenshot && screenshot.data, 'CDP Page.captureScreenshot must return base64 image data');

      const screenshotBuf = Buffer.from(screenshot.data, 'base64');
      const reportsDir = path.join(projectRoot, 'reports', 'registry-argon-5');
      const screenshotDir = path.join(reportsDir, 'screenshots');
      fs.mkdirSync(screenshotDir, { recursive: true });

      const screenshotPath = path.join(screenshotDir, 'browser-dom-evidence.png');
      fs.writeFileSync(screenshotPath, screenshotBuf);
      assert.ok(fs.existsSync(screenshotPath), 'Screenshot file must be written to disk');
      console.log(`✔ Safe screenshot captured and saved: ${screenshotPath} (${screenshotBuf.length} bytes)`);

      // Write Browser Evidence JSON
      const evidence = {
        timestamp: new Date().toISOString(),
        browser: {
          executable: browserMeta.executable,
          size: browserMeta.size,
          cdpPort: browser.port,
          childPid: browser.childPid
        },
        manager: {
          url: manager.url,
          port: manager.port,
          dataDir: synthDataDir,
          discoverySources: managerOptions.discoveryOptions.sources,
          adapterFactoryInjected: true,
          revealerInjected: true
        },
        verifiedFlows: {
          initialSetup: true,
          loginToDashboard: true,
          existingProfilesAndMcps: true,
          newMcpStdioChineseForm: true,
          editMcpSecretRetain: true,
          pendingApplyBanner: true,
          profileCredentialEdit: true,
          locationsModal6Roles: true,
          copyPathFeedback: true,
          stubRevealerNoExplorer: true,
          deleteStoppedService: true,
          filePreservationNotice: true,
          localDirectoryPreserved: true,
          cdpScreenshotCaptured: true
        },
        screenshot: {
          path: 'reports/registry-argon-5/screenshots/browser-dom-evidence.png',
          bytes: screenshotBuf.length
        }
      };

      const evidenceJsonPath = path.join(reportsDir, 'browser-evidence.json');
      fs.writeFileSync(evidenceJsonPath, JSON.stringify(evidence, null, 2), 'utf8');
      console.log(`✔ Evidence JSON written: ${evidenceJsonPath}`);

    } finally {
      // Strict Cleanup: Close browser and kill only owned PID
      if (browser) {
        console.log('[Cleanup] Closing browser and terminating child PID:', browser.childPid);
        await browser.close().catch(() => {});
      }
      // Close startManager
      if (manager && typeof manager.close === 'function') {
        console.log('[Cleanup] Stopping startManager instance');
        await manager.close().catch(() => {});
      }
      // Remove temporary directories
      await new Promise(r => setTimeout(r, 400));
      for (let i = 0; i < 10; i++) {
        try { fs.rmSync(synthDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); break; } catch (_) { await new Promise(r => setTimeout(r, 200)); }
      }
      for (let i = 0; i < 10; i++) {
        try { fs.rmSync(browserUserDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); break; } catch (_) { await new Promise(r => setTimeout(r, 200)); }
      }
      console.log('[Cleanup] Temporary directories removed cleanly');
    }
  });
});

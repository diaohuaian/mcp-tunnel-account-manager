import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  classifyTxtConfig,
  parseLiteralTxtConfig,
  privateConfigFingerprint,
  decodeTextContent
} from '../src/config/txt-config-core.mjs';
import { createMcpDiscovery } from '../src/config/mcp-discovery.mjs';
import { createConfigImporter } from '../src/services/config-import.mjs';
import { createVault } from '../src/vault.mjs';
import { openStore } from '../src/store.mjs';

// ----------------------------------------------------------------------------
// 1. Focused Core Corrections: JSON array & structure handling
// ----------------------------------------------------------------------------
test('classifyTxtConfig: short single-line JSON array is recognized as json, not INI section', () => {
  const jsonArr1 = '[{"serviceId": "svc1", "tunnelId": "tun1"}]';
  const res1 = classifyTxtConfig(jsonArr1);
  assert.equal(res1.format, 'json');
  assert.equal(res1.issues.length, 0);

  const jsonArr2 = '["item1", "item2"]';
  const res2 = classifyTxtConfig(jsonArr2);
  assert.equal(res2.format, 'json');

  const jsonArr3 = '[\n  {"tunnelId": "tun3"}\n]';
  const res3 = classifyTxtConfig(jsonArr3);
  assert.equal(res3.format, 'json');
});

test('classifyTxtConfig: invalid JSON-looking structure becomes review candidate, not account or literal', () => {
  const invalidJsonObj = '{\n  "serviceId": broken\n';
  const res1 = classifyTxtConfig(invalidJsonObj);
  assert.equal(res1.format, 'review');
  assert.ok(res1.issues.some(i => i.code === 'INVALID_JSON_STRUCTURE'));

  const invalidJsonArr = '[\n  {"serviceId": "missing-bracket"\n';
  const res2 = classifyTxtConfig(invalidJsonArr);
  assert.equal(res2.format, 'review');
  assert.ok(res2.issues.some(i => i.code === 'INVALID_JSON_STRUCTURE'));

  // Genuine INI section falls through to literal
  const genuineIni = '[my-service-section]\nSERVICE_ID=svc-1\n';
  const res3 = classifyTxtConfig(genuineIni);
  assert.equal(res3.format, 'literal');
});

// ----------------------------------------------------------------------------
// 2. Focused Core Corrections: Block classification kind & credential requirement
// ----------------------------------------------------------------------------
test('parseLiteralTxtConfig: classifies kind tunnel_account vs service_definition without tunnel credentials', () => {
  // Case A: tunnel_account requires both tunnelId and apiKey
  const accountContent = 'SERVICE_ID=svc-acc\nTUNNEL_ID=tun-100\nAPI_KEY=key-100\n';
  const accRes = parseLiteralTxtConfig(accountContent);
  assert.equal(accRes.blocks.length, 1);
  assert.equal(accRes.blocks[0].kind, 'tunnel_account');
  assert.equal(accRes.blocks[0].syntaxReady, true);

  // Case B: partial credentials fail syntaxReady
  const partialContent = 'SERVICE_ID=svc-acc\nTUNNEL_ID=tun-100\n';
  const partRes = parseLiteralTxtConfig(partialContent);
  assert.equal(partRes.blocks[0].kind, 'tunnel_account');
  assert.equal(partRes.blocks[0].syntaxReady, false);
  assert.ok(partRes.blocks[0].issues.some(i => i.code === 'CONTROL_PLANE_KEY_REQUIRED'));

  // Case C: service_definition with URL binding does NOT require tunnel credentials
  const urlServiceContent = 'SERVICE_ID=svc-http\nSERVICE_URL=http://127.0.0.1:8080/mcp\n';
  const urlRes = parseLiteralTxtConfig(urlServiceContent);
  assert.equal(urlRes.blocks.length, 1);
  assert.equal(urlRes.blocks[0].kind, 'service_definition');
  assert.equal(urlRes.blocks[0].syntaxReady, true);
  assert.equal(urlRes.blocks[0].values.tunnelId, undefined);

  // Case D: service_definition with Command binding does NOT require tunnel credentials
  const cmdServiceContent = 'SERVICE_ID=svc-cmd\n可执行程序=node\n启动参数=["server.js"]\n';
  const cmdRes = parseLiteralTxtConfig(cmdServiceContent);
  assert.equal(cmdRes.blocks.length, 1);
  assert.equal(cmdRes.blocks[0].kind, 'service_definition');
  assert.equal(cmdRes.blocks[0].syntaxReady, true);

  // Case E: ambiguous binding (both URL and command) flags AMBIGUOUS_BINDING
  const ambContent = 'SERVICE_ID=svc-amb\nSERVICE_URL=http://127.0.0.1:8080/mcp\nSERVER_COMMAND=node\n';
  const ambRes = parseLiteralTxtConfig(ambContent);
  assert.equal(ambRes.blocks[0].kind, 'service_definition');
  assert.equal(ambRes.blocks[0].syntaxReady, false);
  assert.ok(ambRes.blocks[0].issues.some(i => i.code === 'AMBIGUOUS_BINDING'));
});

// ----------------------------------------------------------------------------
// 3. Focused Core Corrections: Exclude profileName from private canonical fingerprint
// ----------------------------------------------------------------------------
test('privateConfigFingerprint: excludes display profileName so semantic accounts deduplicate', () => {
  const hmacKey = crypto.randomBytes(32);

  const candidateA = {
    serviceId: 'overleaf-mcp',
    profileName: '个人账号 (Overleaf)',
    tunnelId: 'tun-shared-1234',
    apiKey: 'sec-secret-shared-key',
    organizationId: 'org-test'
  };

  const candidateB = {
    serviceId: 'overleaf-mcp',
    profileName: '工作账户 (别名)',
    tunnelId: 'tun-shared-1234',
    apiKey: 'sec-secret-shared-key',
    organizationId: 'org-test'
  };

  const fpA = privateConfigFingerprint(candidateA, hmacKey);
  const fpB = privateConfigFingerprint(candidateB, hmacKey);
  assert.equal(typeof fpA, 'string');
  assert.equal(fpA.length, 64);
  assert.equal(fpA, fpB, 'Different display aliases must produce identical canonical fingerprint');

  // Changing secret produces distinct identity
  const candidateC = { ...candidateA, apiKey: 'sec-different-key' };
  const fpC = privateConfigFingerprint(candidateC, hmacKey);
  assert.notEqual(fpA, fpC);
});

// ----------------------------------------------------------------------------
// 4. ONE Isolated Flow: discovery -> auto-import -> inventory fixture flow
// ----------------------------------------------------------------------------
test('isolated discovery -> auto-import -> inventory fixture flow', async () => {
  const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-txt-test-')));

  try {
    const vault = createVault({ dataDir: tmpDir });
    const store = await openStore({ dataDir: tmpDir, vault });

    // 1. Create synthetic fixture files
    const txtAccountPath = path.join(tmpDir, 'account-overleaf.txt');
    fs.writeFileSync(txtAccountPath, [
      '服务标识=overleaf-mcp',
      '服务名=Overleaf MCP',
      '账号名=个人账号',
      '隧道ID=tun-syn-9999',
      'API密钥=key-syn-supersecret'
    ].join('\n'), 'utf8');

    const txtServiceDefPath = path.join(tmpDir, 'service-http.txt');
    fs.writeFileSync(txtServiceDefPath, [
      '服务标识=mcp_http_test',
      '服务名称=HTTP测试服务',
      '服务地址=http://127.0.0.1:4000/mcp'
    ].join('\n'), 'utf8');

    const txtDuplicateAliasPath = path.join(tmpDir, 'account-overleaf-alias.txt');
    fs.writeFileSync(txtDuplicateAliasPath, [
      '服务标识=overleaf-mcp',
      '服务名=Overleaf MCP',
      '账号名=工作账号别名',
      '隧道ID=tun-syn-9999',
      'API密钥=key-syn-supersecret'
    ].join('\n'), 'utf8');

    const txtInvalidJsonPath = path.join(tmpDir, 'invalid-json.txt');
    fs.writeFileSync(txtInvalidJsonPath, '{\n  "broken": json without closing\n', 'utf8');

    const missingFilePath = path.join(tmpDir, 'nonexistent-source.txt');

    // 2. Initialize discovery
    const discovery = createMcpDiscovery({
      sources: [
        txtAccountPath,
        txtServiceDefPath,
        txtDuplicateAliasPath,
        txtInvalidJsonPath,
        missingFilePath
      ],
      dataDir: tmpDir,
      vault,
      repo: store
    });

    const candidates = await discovery.scan();
    assert.ok(Array.isArray(candidates));
    assert.ok(candidates.length >= 2);

    // 3. Verify public secret redaction on candidate DTOs
    for (const cand of candidates) {
      assert.equal(cand.apiKey, undefined, 'API key must never appear in public candidate DTO');
      if (cand.credentialStatus?.maskedTunnelId) {
        assert.ok(
          !cand.credentialStatus.maskedTunnelId.includes('9999') || cand.credentialStatus.maskedTunnelId.includes('*'),
          'Tunnel ID must be masked'
        );
      }
    }

    // 4. Verify inventory contents
    const inventory = await discovery.getInventory();
    assert.ok(Array.isArray(inventory));
    assert.equal(inventory.length, 5);

    const missingItem = inventory.find(i => i.filename === 'nonexistent-source.txt');
    assert.ok(missingItem);
    assert.equal(missingItem.status, 'error');
    assert.ok(missingItem.reason.includes('未找到'));

    const invalidItem = inventory.find(i => i.filename === 'invalid-json.txt');
    assert.ok(invalidItem);
    assert.equal(invalidItem.status, 'review');
    assert.ok(invalidItem.reason.includes('审核') || invalidItem.reason.includes('JSON'));

    const dupItem = inventory.find(i => i.filename === 'account-overleaf-alias.txt');
    assert.ok(dupItem);
    assert.equal(dupItem.status, 'duplicate');
    assert.ok(dupItem.reason.includes('重复'));

    // 5. Test auto-import with existing importer
    const importer = createConfigImporter({ repo: store, discovery, vault });

    const accCandidate = candidates.find(c => c.sourceConfigPath === txtAccountPath);
    assert.ok(accCandidate);

    const importRes1 = await importer.importCandidate(accCandidate.id, { mode: 'auto' });
    assert.equal(importRes1.created, true);
    assert.ok(importRes1.service);
    assert.ok(importRes1.profile);

    // Verify profile is inactive (not in active_profiles)
    const activeProfiles = store.listServices ? store.listServices() : [];
    const overleafActive = activeProfiles.find(s => s.serviceId === 'overleaf-mcp');
    assert.equal(overleafActive?.activeProfileId, null, 'New profile must remain inactive');

    // 6. Test service-only definition auto-import without credentials requirement
    const srvCandidate = candidates.find(c => c.sourceConfigPath === txtServiceDefPath);
    assert.ok(srvCandidate);
    const importResSrv = await importer.importCandidate(srvCandidate.id, { mode: 'auto' });
    assert.equal(importResSrv.created, true);
    assert.equal(importResSrv.service.enabled, false);

    // 7. Repeat idempotency: re-running auto-import does not duplicate records
    const importRes2 = await importer.importCandidate(accCandidate.id, { mode: 'auto' });
    assert.equal(importRes2.created, false, 'Repeated import must be idempotent (created: false)');

    // Duplicate candidate in auto mode is rejected gracefully
    const dupCandidate = candidates.find(c => c.sourceConfigPath === txtDuplicateAliasPath);
    if (dupCandidate) {
      const dupImportRes = await importer.importCandidate(dupCandidate.id, { mode: 'auto' });
      assert.equal(dupImportRes.created, false);
      assert.equal(dupImportRes.duplicate, true);
    }

    // 8. Re-scan discovery: verify inventory now reflects 'imported' for imported account
    await discovery.scan();
    const updatedInventory = await discovery.getInventory();
    const importedInvItem = updatedInventory.find(i => i.filename === 'account-overleaf.txt');
    assert.ok(importedInvItem);
    assert.equal(importedInvItem.status, 'imported');

    // Clean up store & vault
    if (typeof store.close === 'function') await store.close();
    if (typeof vault.close === 'function') vault.close();
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  }
});

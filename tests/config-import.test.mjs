import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createConfigImporter } from '../src/services/config-import.mjs';

describe('Config Importer Unit Tests', () => {
  test('throws TypeError if repo or discovery is missing', () => {
    assert.throws(() => createConfigImporter(), /CONFIG_IMPORTER_REPO_REQUIRED/);
    assert.throws(() => createConfigImporter({ repo: {} }), /CONFIG_IMPORTER_DISCOVERY_REQUIRED/);
  });

  test('importCandidate validates candidateId', async () => {
    const importer = createConfigImporter({ repo: {}, discovery: {} });
    await assert.rejects(
      () => importer.importCandidate(''),
      (err) => err.code === 'INVALID_CANDIDATE_ID' && err.status === 400
    );
    await assert.rejects(
      () => importer.importCandidate(null),
      (err) => err.code === 'INVALID_CANDIDATE_ID' && err.status === 400
    );
  });

  test('propagates 404 when candidate is not found', async () => {
    const fakeDiscovery = {
      loadCandidate: async (id) => {
        const err = new Error(`Candidate ${id} not found`);
        err.code = 'CANDIDATE_NOT_FOUND';
        err.status = 404;
        throw err;
      }
    };
    const importer = createConfigImporter({ repo: {}, discovery: fakeDiscovery });

    await assert.rejects(
      () => importer.importCandidate('missing-candidate'),
      (err) => err.code === 'CANDIDATE_NOT_FOUND' && err.status === 404
    );
  });

  test('propagates 409 SOURCE_CHANGED when fingerprint mismatch occurs', async () => {
    const fakeDiscovery = {
      loadCandidate: async (id, { expectedFingerprint }) => {
        if (expectedFingerprint !== 'current_hash_123') {
          const err = new Error('Candidate source changed on disk');
          err.code = 'SOURCE_CHANGED';
          err.status = 409;
          throw err;
        }
      }
    };
    const importer = createConfigImporter({ repo: {}, discovery: fakeDiscovery });

    await assert.rejects(
      () => importer.importCandidate('cand-1', { expectedFingerprint: 'stale_hash' }),
      (err) => err.code === 'SOURCE_CHANGED' && err.status === 409
    );
  });

  test('successful import of definition and profile with sanitization of secrets', async () => {
    const rawCandidate = {
      id: 'cand-git-mcp',
      serviceId: 'mcp_git',
      label: 'Git MCP Server',
      sourceConfigPath: 'C:\\Users\\test\\.config\\git-mcp.yaml',
      sourceKind: 'yaml',
      fingerprint: 'fp-abc-123'
    };

    const rawDefinition = {
      id: 'mcp_git',
      label: 'Git MCP Server',
      enabled: true,
      revision: 1,
      binding: {
        type: 'stdio',
        executable: 'npx.cmd',
        args: [
          { id: 'arg_0', value: '-y', secret: false, configured: true },
          { id: 'arg_1', value: '@modelcontextprotocol/server-git', secret: false, configured: true },
          { id: 'arg_token', value: 'ghp_SECRET_TOKEN_DO_NOT_LEAK', secret: true, configured: true }
        ],
        cwd: 'C:\\projects'
      },
      environment: {
        GITHUB_TOKEN: { value: 'ghp_SECRET_TOKEN_DO_NOT_LEAK', secret: true },
        GIT_TRACE: { value: '1', secret: false }
      },
      locations: {
        sourceConfigPath: 'C:\\Users\\test\\.config\\git-mcp.yaml',
        effectiveConfigPath: null,
        installationRoot: null,
        executable: 'npx.cmd',
        cwd: 'C:\\projects'
      }
    };

    const rawProfileInput = {
      id: 'prof-git-auto',
      label: 'Imported Git Profile',
      services: {
        mcp_git: {
          tunnelId: 'tun_full_secret_id_12345678',
          apiKey: 'sec_key_DO_NOT_LEAK',
          organizationId: 'org_abc'
        }
      }
    };

    const fakeDiscovery = {
      loadCandidate: async (id, { expectedFingerprint }) => {
        assert.equal(id, 'cand-git-mcp');
        assert.equal(expectedFingerprint, 'fp-abc-123');
        return {
          candidate: rawCandidate,
          definition: rawDefinition,
          profileInput: rawProfileInput,
          provenance: {
            identity: 'source_git_canonical',
            sourceKind: 'yaml',
            sourceConfigPath: 'C:\\Users\\test\\.config\\git-mcp.yaml'
          }
        };
      }
    };

    let importedDefArgs = null;
    let importedProfileArgs = null;

    const fakeRepo = {
      getRevision: async () => 15,
      registry: {
        importDefinition: async (def, options) => {
          importedDefArgs = { def, options };
          return {
            service: {
              ...def,
              revision: 2
            },
            created: true
          };
        }
      },
      importDiscoveredProfile: async (input, options) => {
        importedProfileArgs = { input, options };
        return {
          profile: {
            id: input.id,
            label: input.label,
            revision: 1,
            services: {
              mcp_git: {
                configured: true,
                maskedTunnelId: 'tun...5678',
                hasApiKey: true,
                hasOrganizationId: true
              }
            }
          },
          created: true
        };
      }
    };

    const importer = createConfigImporter({ repo: fakeRepo, discovery: fakeDiscovery });
    const result = await importer.importCandidate('cand-git-mcp', {
      expectedFingerprint: 'fp-abc-123',
      expectedRevision: 14
    });

    // Check repo calls
    assert.deepEqual(importedDefArgs.options, {
      expectedRevision: 14,
      provenance: {
        identity: 'source_git_canonical',
        sourceKind: 'yaml',
        sourceConfigPath: 'C:\\Users\\test\\.config\\git-mcp.yaml'
      }
    });

    assert.deepEqual(importedProfileArgs.options, {
      provenance: {
        identity: 'source_git_canonical',
        sourceKind: 'yaml',
        sourceConfigPath: 'C:\\Users\\test\\.config\\git-mcp.yaml'
      },
      mergeProfileId: undefined,
      expectedRevision: 14
    });

    // Verify sanitized result
    assert.equal(result.created, true);
    assert.equal(result.revision, 15);
    assert.equal(result.service.id, 'mcp_git');
    assert.equal(result.service.label, 'Git MCP Server');

    // Verify binding secret is masked
    const tokenArg = result.service.binding.args.find((a) => a.id === 'arg_token');
    assert.ok(tokenArg);
    assert.equal(tokenArg.secret, true);
    assert.equal(tokenArg.configured, true);
    assert.equal(tokenArg.value, undefined, 'Secret arg value must not be exposed');

    // Verify environment secret is masked
    const ghTokenEnv = result.service.environment.find((e) => e.name === 'GITHUB_TOKEN');
    assert.ok(ghTokenEnv);
    assert.equal(ghTokenEnv.secret, true);
    assert.equal(ghTokenEnv.configured, true);
    assert.equal(ghTokenEnv.value, undefined, 'Secret env value must not be exposed');

    // Verify non-secret env retains value
    const gitTraceEnv = result.service.environment.find((e) => e.name === 'GIT_TRACE');
    assert.ok(gitTraceEnv);
    assert.equal(gitTraceEnv.secret, false);
    assert.equal(gitTraceEnv.value, '1');

    // Verify profile DTO does not leak raw apiKey or unmasked tunnelId
    assert.equal(result.profile.id, 'prof-git-auto');
    assert.equal(result.profile.services.mcp_git.maskedTunnelId, 'tun...5678');
    assert.equal(result.profile.services.mcp_git.hasApiKey, true);
    assert.equal(result.profile.services.mcp_git.apiKey, undefined);

    // Verify JSON string has zero leaked secrets
    const jsonStr = JSON.stringify(result);
    assert.equal(jsonStr.includes('ghp_SECRET_TOKEN_DO_NOT_LEAK'), false);
    assert.equal(jsonStr.includes('sec_key_DO_NOT_LEAK'), false);
    assert.equal(jsonStr.includes('tun_full_secret_id_12345678'), false);
  });

  test('idempotent import returns created: false when already present', async () => {
    const fakeDiscovery = {
      loadCandidate: async () => ({
        candidate: { id: 'cand-exist', serviceId: 'mcp_exist' },
        definition: { id: 'mcp_exist', label: 'Exist' },
        profileInput: { id: 'prof-exist' },
        provenance: { identity: 'prov-1' }
      })
    };

    const fakeRepo = {
      getRevision: async () => 20,
      registry: {
        importDefinition: async (def) => ({
          service: def,
          created: false
        })
      },
      importDiscoveredProfile: async (p) => ({
        profile: p,
        created: false
      })
    };

    const importer = createConfigImporter({ repo: fakeRepo, discovery: fakeDiscovery });
    const result = await importer.importCandidate('cand-exist');

    assert.equal(result.created, false);
    assert.equal(result.revision, 20);
    assert.equal(result.service.id, 'mcp_exist');
  });

  test('forwards mergeProfileId to repo.importDiscoveredProfile', async () => {
    let capturedMergeId = null;

    const fakeDiscovery = {
      loadCandidate: async () => ({
        candidate: { id: 'cand-merge' },
        definition: { id: 'mcp_merge' },
        profileInput: { id: 'prof-new' },
        provenance: { identity: 'prov-merge' }
      })
    };

    const fakeRepo = {
      getRevision: async () => 5,
      registry: {
        importDefinition: async (def) => ({ service: def, created: true })
      },
      importDiscoveredProfile: async (input, { mergeProfileId }) => {
        capturedMergeId = mergeProfileId;
        return { profile: { id: mergeProfileId }, created: false };
      }
    };

    const importer = createConfigImporter({ repo: fakeRepo, discovery: fakeDiscovery });
    const result = await importer.importCandidate('cand-merge', {
      mergeProfileId: 'target-profile-99'
    });

    assert.equal(capturedMergeId, 'target-profile-99');
    assert.equal(result.profile.id, 'target-profile-99');
  });

  test('propagates 409 REVISION_CONFLICT if registry throws conflict', async () => {
    const fakeDiscovery = {
      loadCandidate: async () => ({
        definition: { id: 'mcp_conf' },
        provenance: { identity: 'prov-conf' }
      })
    };

    const fakeRepo = {
      registry: {
        importDefinition: async () => {
          const err = new Error('Revision conflict');
          err.code = 'REVISION_CONFLICT';
          err.status = 409;
          throw err;
        }
      }
    };

    const importer = createConfigImporter({ repo: fakeRepo, discovery: fakeDiscovery });
    await assert.rejects(
      () => importer.importCandidate('cand-conf', { expectedRevision: 1 }),
      (err) => err.code === 'REVISION_CONFLICT' && err.status === 409
    );
  });
});

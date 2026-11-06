import { publicEnvironment } from '../core/mcp-registry-policy.mjs';

function maskTunnelId(id) {
  if (id === null || id === undefined || id === '') return null;
  const str = String(id);
  if (str.length <= 6) {
    if (str.length <= 2) return '***';
    return `${str[0]}***${str[str.length - 1]}`;
  }
  return `${str.slice(0, 3)}...${str.slice(-4)}`;
}

function sanitizeService(service) {
  if (!service || typeof service !== 'object') return null;
  const out = {
    id: service.id,
    label: service.label || service.id,
    enabled: service.enabled !== false,
    revision: Number.isSafeInteger(service.revision) ? service.revision : 1
  };
  if (Number.isSafeInteger(service.sortOrder)) out.sortOrder = service.sortOrder;
  if (service.controlCarrier !== undefined) out.controlCarrier = Boolean(service.controlCarrier);
  if (service.deletedAt !== undefined) out.deletedAt = service.deletedAt;
  if (service.runtimeState !== undefined) out.runtimeState = service.runtimeState;
  if (service.activeProfileRevision !== undefined) out.activeProfileRevision = service.activeProfileRevision;
  if (service.activeServiceRevision !== undefined) out.activeServiceRevision = service.activeServiceRevision;
  if (service.pendingApply !== undefined) out.pendingApply = Boolean(service.pendingApply);

  if (service.binding && typeof service.binding === 'object') {
    const b = service.binding;
    if (b.type === 'stdio') {
      out.binding = {
        type: 'stdio',
        executable: b.executable,
        args: Array.isArray(b.args)
          ? b.args.map((a, i) => {
              const sec = a?.secret !== false;
              return {
                id: a?.id || `arg_${i}`,
                secret: sec,
                configured: Boolean(a?.configured ?? true),
                ...(sec ? {} : { value: a?.value })
              };
            })
          : [],
        cwd: b.cwd || undefined
      };
    } else if (b.type === 'http') {
      const headers = {};
      if (b.headers && typeof b.headers === 'object') {
        for (const [k, v] of Object.entries(b.headers)) {
          const sec = v?.secret !== false;
          headers[k] = {
            secret: sec,
            configured: Boolean(v?.configured ?? true),
            ...(sec ? {} : { value: v?.value })
          };
        }
      }
      out.binding = {
        type: 'http',
        url: b.url,
        headers
      };
    } else {
      out.binding = { type: b.type };
    }
  }

  if (service.environment && typeof service.environment === 'object') {
    if (Array.isArray(service.environment)) {
      out.environment = service.environment;
    } else {
      out.environment = publicEnvironment(service.environment);
    }
  }

  if (service.locations && typeof service.locations === 'object') {
    out.locations = {
      sourceConfigPath: service.locations.sourceConfigPath ?? null,
      effectiveConfigPath: service.locations.effectiveConfigPath ?? null,
      installationRoot: service.locations.installationRoot ?? null,
      executable: service.locations.executable ?? null,
      cwd: service.locations.cwd ?? null
    };
  }

  return out;
}

function sanitizeProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  if (profile.id && profile.services && typeof profile.services === 'object') {
    const safeServices = {};
    for (const [sKey, sVal] of Object.entries(profile.services)) {
      if (sVal && typeof sVal === 'object') {
        safeServices[sKey] = {
          configured: Boolean(sVal.configured),
          maskedTunnelId: sVal.maskedTunnelId ?? maskTunnelId(sVal.tunnelId),
          hasApiKey: Boolean(sVal.hasApiKey ?? (sVal.apiKey && String(sVal.apiKey).trim().length > 0)),
          hasOrganizationId: Boolean(sVal.hasOrganizationId ?? (sVal.organizationId && String(sVal.organizationId).trim().length > 0))
        };
      } else {
        safeServices[sKey] = {
          configured: false,
          maskedTunnelId: null,
          hasApiKey: false,
          hasOrganizationId: false
        };
      }
    }
    return {
      id: profile.id,
      label: profile.label || profile.name || profile.id,
      revision: Number.isSafeInteger(profile.revision) ? profile.revision : 1,
      services: safeServices
    };
  }
  return profile;
}

/**
 * Creates a configuration importer service.
 *
 * @param {object} params
 * @param {object} params.repo - Store repository instance
 * @param {object} params.discovery - MCP discovery instance
 * @returns {{ importCandidate: (candidateId: string, options?: object) => Promise<object> }}
 */
export function createConfigImporter({ repo, discovery } = {}) {
  if (!repo) {
    throw new TypeError('CONFIG_IMPORTER_REPO_REQUIRED: repo is required');
  }
  if (!discovery) {
    throw new TypeError('CONFIG_IMPORTER_DISCOVERY_REQUIRED: discovery is required');
  }

  async function importCandidate(candidateId, options = {}) {
    if (!candidateId || typeof candidateId !== 'string') {
      const err = new Error('Candidate ID is required');
      err.code = 'INVALID_CANDIDATE_ID';
      err.status = 400;
      throw err;
    }

    const { expectedFingerprint, expectedRevision, mergeProfileId, mode, auto } = options;
    const isAuto = mode === 'auto' || auto === true;

    // 1. Call discovery.loadCandidate
    const loaded = await discovery.loadCandidate(candidateId, { expectedFingerprint });
    if (!loaded) {
      const err = new Error(`Candidate '${candidateId}' not found`);
      err.code = 'CANDIDATE_NOT_FOUND';
      err.status = 404;
      throw err;
    }

    const { candidate, definition, profileInput, provenance: candidateProvenance } = loaded;

    // Check duplicate in auto mode
    if (isAuto && candidate?.duplicateOf) {
      return {
        service: null,
        profile: null,
        created: false,
        duplicate: true,
        reason: 'DUPLICATE_ACCOUNT',
        revision: typeof repo.getRevision === 'function' ? await repo.getRevision() : 0
      };
    }

    // In auto mode, ensure new services are disabled and new profiles are inactive
    if (isAuto && definition) {
      definition.enabled = false;
    }

    const provenance = candidateProvenance || candidate?.provenance || {
      identity: candidate?.id || candidateId,
      sourceKind: candidate?.sourceKind,
      sourceConfigPath: candidate?.sourceConfigPath
    };

    // 2. Import definition via repo.registry.importDefinition (or fallback repo.importDefinition)
    let defResult = null;
    if (definition) {
      let existingService = null;
      if (repo?.registry && typeof repo.registry.getDefinition === 'function') {
        try { existingService = await repo.registry.getDefinition(definition.id); } catch (_) {}
      }
      if (existingService) {
        const nextLocations = {};
        if (!existingService.locations?.sourceConfigPath && definition.locations?.sourceConfigPath) {
          nextLocations.sourceConfigPath = definition.locations.sourceConfigPath;
        }
        if (!existingService.locations?.installationRoot && definition.locations?.installationRoot) {
          nextLocations.installationRoot = definition.locations.installationRoot;
        }
        if (!existingService.locations?.executable && definition.locations?.executable) {
          nextLocations.executable = definition.locations.executable;
        }
        if (!existingService.locations?.cwd && definition.locations?.cwd) {
          nextLocations.cwd = definition.locations.cwd;
        }
        if (Object.keys(nextLocations).length > 0 && typeof repo?.registry?.update === 'function') {
          try {
            const updatedService = await repo.registry.update(definition.id, { locations: nextLocations });
            defResult = { service: updatedService, created: false };
          } catch (_) {
            defResult = { service: existingService, created: false };
          }
        } else {
          defResult = { service: existingService, created: false };
        }
      } else {
        try {
          if (repo?.registry && typeof repo.registry.importDefinition === 'function') {
            defResult = await repo.registry.importDefinition(definition, {
              expectedRevision,
              provenance
            });
          } else if (typeof repo.importDefinition === 'function') {
            defResult = await repo.importDefinition(definition, {
              expectedRevision,
              provenance
            });
          } else {
            defResult = { service: definition, created: true };
          }
        } catch (err) {
          if (isAuto && (err.code === 'CONFLICT' || err.status === 409)) {
            return {
              service: null,
              profile: null,
              created: false,
              conflict: true,
              reason: 'SERVICE_CONFLICT_REQUIRES_REVIEW',
              revision: typeof repo.getRevision === 'function' ? await repo.getRevision() : 0
            };
          }
          throw err;
        }
      }
    }

    // 3. Import or merge discovered profile via repo.importDiscoveredProfile
    let profileResult = null;
    if (profileInput) {
      if (typeof repo.importDiscoveredProfile === 'function') {
        profileResult = await repo.importDiscoveredProfile(profileInput, {
          provenance,
          mergeProfileId,
          expectedRevision
        });
      } else if (typeof repo.createProfile === 'function') {
        try {
          const created = await repo.createProfile(profileInput, { expectedRevision });
          profileResult = { profile: created, created: true };
        } catch {
          profileResult = { profile: profileInput, created: false };
        }
      } else {
        profileResult = { profile: profileInput, created: true };
      }
    }

    // 4. Safe sanitized result
    const rawService = defResult?.service || (candidate ? { id: candidate.serviceId || candidateId, label: candidate.label } : null);
    const rawProfile = profileResult?.profile || profileResult || null;
    const created = Boolean(defResult?.created || profileResult?.created);

    let revision = 0;
    if (typeof repo.getRevision === 'function') {
      revision = await repo.getRevision();
    } else if (defResult && typeof defResult.revision === 'number') {
      revision = defResult.revision;
    }

    return {
      service: sanitizeService(rawService),
      profile: sanitizeProfile(rawProfile),
      created,
      revision
    };
  }

  return {
    importCandidate
  };
}

export default createConfigImporter;

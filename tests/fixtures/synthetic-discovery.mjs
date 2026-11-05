import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { discoveryIdentity, isMcpServiceId, RegistryPolicyFault } from '../../src/core/mcp-registry-policy.mjs';

function sha256(data) {
  const content = typeof data === 'string' ? data : JSON.stringify(data);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function maskTunnelId(id) {
  if (!id) return '';
  const s = String(id);
  if (s.length <= 6) return '***';
  return `${s.slice(0, 3)}...${s.slice(-4)}`;
}

export function createMcpDiscovery(options = {}) {
  const sources = options.sources || [];
  const readFile = options.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const realpath = options.realpath || ((p) => fs.realpathSync(p));
  const stat = options.stat || ((p) => fs.statSync(p));
  const maxBytes = options.maxBytes || 256 * 1024;

  // Local-only HMAC / salt for candidate fingerprinting to avoid leaking raw secret hashes
  const localSecretSalt = crypto.randomBytes(16).toString('hex');

  function computeFingerprint(rawContent) {
    return crypto.createHmac('sha256', localSecretSalt).update(rawContent).digest('hex');
  }

  function parseYamlSafe(content, filePath) {
    const lines = content.split(/\r?\n/);
    let tunnelId = null;
    let apiKey = null;
    let command = null;

    for (const line of lines) {
      const trimmed = line.trim();
      const tMatch = trimmed.match(/^tunnel_id:\s*["']?([^"'\r\n#]+)["']?/);
      if (tMatch) tunnelId = tMatch[1].trim();
      const aMatch = trimmed.match(/^api_key:\s*["']?([^"'\r\n#]+)["']?/);
      if (aMatch) apiKey = aMatch[1].trim();
      const cMatch = trimmed.match(/^command:\s*["']?([^"'\r\n#]+)["']?/);
      if (cMatch) command = cMatch[1].trim();
    }

    const serviceId = filePath.toLowerCase().includes('overleaf')
      ? 'overleaf-mcp'
      : filePath.toLowerCase().includes('antigravity')
      ? 'antigravity-mcp'
      : `mcp_${crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 16)}`;

    return {
      serviceId,
      tunnelId,
      apiKey,
      command: command || 'node C:/sample/index.js --stdio'
    };
  }

  function parseDotenvSafe(content, filePath) {
    const lines = content.split(/\r?\n/);
    let tunnelId = null;
    let apiKey = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (key === 'TUNNEL_ID') tunnelId = val;
      if (key === 'CONTROL_PLANE_API_KEY') apiKey = val;
    }

    const serviceId = `mcp_${crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 16)}`;
    return {
      serviceId,
      tunnelId,
      apiKey,
      command: 'tunnel-client.exe'
    };
  }

  function parseBatSafe(content, filePath) {
    const lines = content.split(/\r?\n/);
    let tunnelId = null;
    let apiKey = null;

    for (const line of lines) {
      const trimmed = line.trim();
      // Literal set ONLY. Never execute!
      const setMatch = trimmed.match(/^set\s+([A-Za-z0-9_]+)=(.+)$/i);
      if (setMatch) {
        const key = setMatch[1].trim();
        const val = setMatch[2].trim().replace(/^["']|["']$/g, '');
        if (key === 'TUNNEL_ID') tunnelId = val;
        if (key === 'CONTROL_PLANE_API_KEY') apiKey = val;
      }
    }

    const serviceId = `mcp_${crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 16)}`;
    return {
      serviceId,
      tunnelId,
      apiKey,
      command: 'tunnel-client.exe'
    };
  }

  function parseJsonSafe(content, filePath) {
    let parsed = {};
    try {
      parsed = JSON.parse(content);
    } catch {
      return [];
    }

    const results = [];
    const servers = parsed.mcpServers || {};
    for (const [serverKey, conf] of Object.entries(servers)) {
      const safeKey = serverKey.toLowerCase().replace(/[^a-z0-9]/g, '');
      const serviceId = `mcp_${crypto.createHash('sha256').update(`${filePath}#${serverKey}`).digest('hex').slice(0, 16)}`;
      results.push({
        serverKey,
        serviceId,
        conf
      });
    }
    return results;
  }

  async function scan() {
    const candidates = [];

    for (const src of sources) {
      if (!fs.existsSync(src.path)) continue;
      const fileStat = stat(src.path);
      if (fileStat.size > maxBytes) continue;

      const rawContent = readFile(src.path);
      const canonicalPath = realpath(src.path);
      const fingerprint = computeFingerprint(rawContent);

      if (src.kind === 'yaml' || src.path.endsWith('.yaml') || src.path.endsWith('.yml')) {
        const parsed = parseYamlSafe(rawContent, canonicalPath);
        const provId = discoveryIdentity({ serviceId: parsed.serviceId, canonicalPath, selector: '' });
        candidates.push({
          id: `cand_${provId}`,
          serviceId: parsed.serviceId,
          label: `Discovered YAML ${parsed.serviceId}`,
          sourceConfigPath: canonicalPath,
          sourceKind: 'yaml',
          selector: '',
          fingerprint,
          credentialStatus: {
            hasTunnelId: Boolean(parsed.tunnelId),
            maskedTunnelId: maskTunnelId(parsed.tunnelId),
            hasApiKey: Boolean(parsed.apiKey)
          },
          warnings: [],
          binding: {
            type: 'stdio',
            executable: 'node',
            args: [{ id: 'a1', value: parsed.command, secret: false }]
          },
          locations: {
            sourceConfigPath: canonicalPath
          }
        });
      } else if (src.kind === 'env' || src.path.endsWith('.env')) {
        const parsed = parseDotenvSafe(rawContent, canonicalPath);
        const provId = discoveryIdentity({ serviceId: parsed.serviceId, canonicalPath, selector: '' });
        candidates.push({
          id: `cand_${provId}`,
          serviceId: parsed.serviceId,
          label: `Discovered Dotenv ${parsed.serviceId}`,
          sourceConfigPath: canonicalPath,
          sourceKind: 'env',
          selector: '',
          fingerprint,
          credentialStatus: {
            hasTunnelId: Boolean(parsed.tunnelId),
            maskedTunnelId: maskTunnelId(parsed.tunnelId),
            hasApiKey: Boolean(parsed.apiKey)
          },
          warnings: [],
          binding: {
            type: 'stdio',
            executable: parsed.command,
            args: []
          },
          locations: {
            sourceConfigPath: canonicalPath
          }
        });
      } else if (src.kind === 'bat' || src.path.endsWith('.bat')) {
        const parsed = parseBatSafe(rawContent, canonicalPath);
        const provId = discoveryIdentity({ serviceId: parsed.serviceId, canonicalPath, selector: '' });
        candidates.push({
          id: `cand_${provId}`,
          serviceId: parsed.serviceId,
          label: `Discovered BAT ${parsed.serviceId}`,
          sourceConfigPath: canonicalPath,
          sourceKind: 'bat',
          selector: '',
          fingerprint,
          credentialStatus: {
            hasTunnelId: Boolean(parsed.tunnelId),
            maskedTunnelId: maskTunnelId(parsed.tunnelId),
            hasApiKey: Boolean(parsed.apiKey)
          },
          warnings: [],
          binding: {
            type: 'stdio',
            executable: parsed.command,
            args: []
          },
          locations: {
            sourceConfigPath: canonicalPath
          }
        });
      } else if (src.kind === 'json' || src.path.endsWith('.json')) {
        const parsedList = parseJsonSafe(rawContent, canonicalPath);
        for (const item of parsedList) {
          const provId = discoveryIdentity({ serviceId: item.serviceId, canonicalPath, selector: item.serverKey });
          const isHttp = Boolean(item.conf.url);
          candidates.push({
            id: `cand_${provId}`,
            serviceId: item.serviceId,
            label: `Discovered Server ${item.serverKey}`,
            sourceConfigPath: canonicalPath,
            sourceKind: 'json',
            selector: item.serverKey,
            fingerprint,
            credentialStatus: {
              hasTunnelId: false,
              maskedTunnelId: null,
              hasApiKey: isHttp ? Boolean(item.conf.headers?.Authorization) : false
            },
            warnings: [],
            binding: isHttp
              ? {
                  type: 'http',
                  url: item.conf.url,
                  headers: {
                    Authorization: { secret: true, configured: Boolean(item.conf.headers?.Authorization) }
                  }
                }
              : {
                  type: 'stdio',
                  executable: item.conf.command || 'node',
                  args: Array.isArray(item.conf.args)
                    ? item.conf.args.map((a, i) => ({ id: `arg_${i}`, secret: true, configured: true }))
                    : []
                },
            locations: {
              sourceConfigPath: canonicalPath
            }
          });
        }
      }
    }

    return candidates;
  }

  async function loadCandidate(candidateId, { expectedFingerprint } = {}) {
    const candidates = await scan();
    const match = candidates.find(c => c.id === candidateId);
    if (!match) {
      throw new RegistryPolicyFault('CANDIDATE_NOT_FOUND', 404);
    }

    const rawContent = readFile(match.sourceConfigPath);
    const currentFingerprint = computeFingerprint(rawContent);

    if (expectedFingerprint && currentFingerprint !== expectedFingerprint) {
      throw new RegistryPolicyFault('SOURCE_CHANGED', 409);
    }

    let definition = null;
    let profileInput = null;

    if (match.sourceKind === 'yaml') {
      const parsed = parseYamlSafe(rawContent, match.sourceConfigPath);
      definition = {
        id: match.serviceId,
        label: match.label,
        enabled: true,
        binding: {
          type: 'stdio',
          executable: 'node',
          args: [{ id: 'a1', value: parsed.command, secret: false }]
        },
        environment: {}
      };
      profileInput = {
        label: `Profile for ${match.serviceId}`,
        services: {
          [match.serviceId]: {
            tunnelId: parsed.tunnelId,
            apiKey: parsed.apiKey
          }
        }
      };
    } else if (match.sourceKind === 'env') {
      const parsed = parseDotenvSafe(rawContent, match.sourceConfigPath);
      definition = {
        id: match.serviceId,
        label: match.label,
        enabled: true,
        binding: {
          type: 'stdio',
          executable: parsed.command,
          args: []
        },
        environment: {}
      };
      profileInput = {
        label: `Profile for ${match.serviceId}`,
        services: {
          [match.serviceId]: {
            tunnelId: parsed.tunnelId,
            apiKey: parsed.apiKey
          }
        }
      };
    } else if (match.sourceKind === 'bat') {
      const parsed = parseBatSafe(rawContent, match.sourceConfigPath);
      definition = {
        id: match.serviceId,
        label: match.label,
        enabled: true,
        binding: {
          type: 'stdio',
          executable: parsed.command,
          args: []
        },
        environment: {}
      };
      profileInput = {
        label: `Profile for ${match.serviceId}`,
        services: {
          [match.serviceId]: {
            tunnelId: parsed.tunnelId,
            apiKey: parsed.apiKey
          }
        }
      };
    } else if (match.sourceKind === 'json') {
      const parsedList = parseJsonSafe(rawContent, match.sourceConfigPath);
      const item = parsedList.find(p => p.serverKey === match.selector);
      const conf = item?.conf || {};
      const isHttp = Boolean(conf.url);

      definition = {
        id: match.serviceId,
        label: match.label,
        enabled: true,
        binding: isHttp
          ? {
              type: 'http',
              url: conf.url,
              headers: conf.headers || {}
            }
          : {
              type: 'stdio',
              executable: conf.command || 'node',
              args: (conf.args || []).map((val, i) => ({ id: `arg_${i}`, value: val, secret: true }))
            },
        environment: conf.env || {}
      };

      profileInput = {
        label: `Profile for ${match.serviceId}`,
        services: {
          [match.serviceId]: {
            tunnelId: 'auto-json-tunnel',
            apiKey: 'auto-json-key'
          }
        }
      };
    }

    const provenance = {
      identity: discoveryIdentity({
        serviceId: match.serviceId,
        canonicalPath: match.sourceConfigPath,
        selector: match.selector || ''
      }),
      sourceKind: match.sourceKind,
      sourceConfigPath: match.sourceConfigPath,
      selector: match.selector || ''
    };

    return {
      candidate: match,
      definition,
      profileInput,
      provenance
    };
  }

  return {
    scan,
    loadCandidate
  };
}

export function createConfigImporter({ repo, discovery }) {
  async function importCandidate(candidateId, { expectedFingerprint, expectedRevision, mergeProfileId } = {}) {
    const loaded = await discovery.loadCandidate(candidateId, { expectedFingerprint });
    const { definition, profileInput, provenance } = loaded;

    // 1. Import definition into registry
    let serviceResult = null;
    if (repo.registry && typeof repo.registry.importDefinition === 'function') {
      serviceResult = await repo.registry.importDefinition(definition, {
        expectedRevision,
        provenance
      });
    } else {
      serviceResult = {
        service: definition,
        created: true
      };
    }

    // 2. Import or merge profile
    let profileResult = null;
    if (mergeProfileId) {
      const existingProfile = await repo.getProfile(mergeProfileId);
      if (!existingProfile) {
        throw new RegistryPolicyFault('PROFILE_NOT_FOUND', 404);
      }
      const updatedServices = {
        ...profileInput.services
      };
      profileResult = await repo.patchProfile(mergeProfileId, {
        services: updatedServices
      });
    } else {
      // Find if already imported with this provenance
      const allProfiles = await repo.listProfiles();
      const match = allProfiles.find(p => p.label === profileInput.label);
      if (match) {
        profileResult = match;
      } else {
        profileResult = await repo.createProfile(profileInput);
      }
    }

    const revision = repo.getRevision ? repo.getRevision() : 1;
    return {
      service: serviceResult.service,
      profile: profileResult,
      created: serviceResult.created,
      revision
    };
  }

  return {
    importCandidate
  };
}

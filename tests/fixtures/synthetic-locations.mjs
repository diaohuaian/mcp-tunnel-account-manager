import fs from 'node:fs';
import path from 'node:path';
import { RegistryPolicyFault } from '../../src/core/mcp-registry-policy.mjs';

const ALLOWED_ROLES = new Set([
  'sourceConfig',
  'effectiveConfig',
  'installation',
  'executable',
  'workingDirectory',
  'managerStore'
]);

export function createMcpLocationResolver(options = {}) {
  const dataDir = options.dataDir || path.join(process.env.LOCALAPPDATA || 'C:/Users/wszho/AppData/Local', 'McpTunnelAccountManager');
  const storePath = options.storePath || path.join(dataDir, 'manager.db');
  const revealDirectory = options.revealDirectory || (async (dir) => ({ opened: true, directory: dir }));
  const stat = options.stat || ((p) => (fs.existsSync(p) ? fs.statSync(p) : null));
  const realpath = options.realpath || ((p) => (fs.existsSync(p) ? fs.realpathSync(p) : p));

  async function describe(def, runtime = null) {
    if (!def) throw new RegistryPolicyFault('MCP_NOT_FOUND', 404);

    const isHttp = def.binding?.type === 'http';
    const sourceConfigPath = def.locations?.sourceConfigPath || null;
    const effectiveConfigPath = runtime?.effectiveConfigPath || null;
    const managerStorePath = storePath;
    const installationRoot = isHttp ? null : (def.locations?.installationRoot || (def.binding?.cwd || null));
    const executable = isHttp ? null : (def.binding?.executable || null);
    const cwd = isHttp ? null : (def.binding?.cwd || null);

    return {
      serviceId: def.id,
      isRemote: isHttp,
      sourceConfigPath,
      effectiveConfigPath,
      managerStorePath,
      installationRoot,
      executable,
      cwd,
      exists: {
        sourceConfigPath: sourceConfigPath ? fs.existsSync(sourceConfigPath) : false,
        effectiveConfigPath: effectiveConfigPath ? fs.existsSync(effectiveConfigPath) : false,
        managerStorePath: fs.existsSync(managerStorePath),
        installationRoot: installationRoot ? fs.existsSync(installationRoot) : false,
        executable: executable ? fs.existsSync(executable) : false,
        cwd: cwd ? fs.existsSync(cwd) : false
      }
    };
  }

  async function reveal(def, role, runtime = null) {
    if (!ALLOWED_ROLES.has(role)) {
      throw new RegistryPolicyFault('INVALID_REVEAL_ROLE', 400);
    }

    const locs = await describe(def, runtime);
    let targetDir = null;

    if (role === 'sourceConfig' && locs.sourceConfigPath) {
      targetDir = path.dirname(locs.sourceConfigPath);
    } else if (role === 'effectiveConfig' && locs.effectiveConfigPath) {
      targetDir = path.dirname(locs.effectiveConfigPath);
    } else if (role === 'managerStore') {
      targetDir = path.dirname(locs.managerStorePath);
    } else if (role === 'installation' && locs.installationRoot) {
      targetDir = locs.installationRoot;
    } else if (role === 'executable' && locs.executable) {
      targetDir = path.dirname(locs.executable);
    } else if (role === 'workingDirectory' && locs.cwd) {
      targetDir = locs.cwd;
    }

    if (!targetDir) {
      throw new RegistryPolicyFault('LOCATION_NOT_AVAILABLE', 404);
    }

    // Guard against path traversal / unsafe target
    const normalized = path.normalize(targetDir);
    if (normalized.startsWith('\\\\') || normalized.includes('..')) {
      throw new RegistryPolicyFault('UNSAFE_LOCATION_TARGET', 403);
    }

    const result = await revealDirectory(normalized);
    return {
      revealed: true,
      role,
      directory: normalized,
      result
    };
  }

  return {
    describe,
    reveal
  };
}

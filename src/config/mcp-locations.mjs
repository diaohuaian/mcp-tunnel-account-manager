import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ALLOWED_ROLES = Object.freeze([
  'sourceConfig',
  'effectiveConfig',
  'installation',
  'executable',
  'workingDirectory',
  'managerStore'
]);

/**
 * Creates an MCP location resolver for path resolution, metadata inspection, and controlled file manager reveal.
 * No constructor I/O.
 */
export function createMcpLocationResolver(options = {}) {
  const {
    dataDir,
    storePath,
    stat: customStat,
    realpath: customRealpath,
    revealDirectory: customRevealDirectory
  } = options;

  const statFn = customStat || (async (p) => fs.promises.stat(p));
  const realpathFn = customRealpath || (async (p) => fs.promises.realpath(p));
  const revealDirectoryFn = customRevealDirectory;

  async function checkExists(targetPath) {
    if (!targetPath || targetPath === 'unknown' || typeof targetPath !== 'string') return false;
    if (
      targetPath.includes('\0') ||
      targetPath.startsWith('\\\\') ||
      targetPath.startsWith('//') ||
      /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(targetPath) ||
      /(?:^|[\\/])(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(targetPath)
    ) {
      return false;
    }
    try {
      await statFn(targetPath);
      return true;
    } catch (_) {
      return false;
    }
  }

  async function resolveCommandInPath(cmd) {
    if (!cmd || typeof cmd !== 'string' || cmd.includes('\0') || cmd.includes(' ')) return null;
    if (cmd.includes('/') || cmd.includes('\\') || path.isAbsolute(cmd)) return null;
    if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(cmd)) return null;

    const pathEnv = process.env.PATH || process.env.Path || '';
    const dirs = pathEnv.split(path.delimiter).filter(Boolean);
    const hasExt = Boolean(path.extname(cmd));
    const exts = process.platform === 'win32' && !hasExt
      ? ['.exe', '.cmd', '.bat', '']
      : [''];

    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = path.join(dir, cmd + ext);
        try {
          const st = await statFn(candidate);
          if (st.isFile()) return candidate;
        } catch (_) {}
      }
    }
    return null;
  }

  /**
   * Returns safe path metadata, existence flags, and detected manifest data for a service definition.
   */
  async function describe(def, runtime = {}) {
    if (!def || typeof def !== 'object') {
      const err = new Error('Service definition must be an object');
      err.code = 'INVALID_DEFINITION';
      err.status = 400;
      err.statusCode = 400;
      throw err;
    }

    const isHttp = def.binding?.type === 'http';
    let sourceConfigPath = def.locations?.sourceConfigPath || def.provenance?.sourceConfigPath || null;
    if (!sourceConfigPath && def.locations?.sourceConfigPath !== null) {
      if (def.id === 'antigravity-mcp' && process.env.APPDATA) {
        const defaultYaml = path.join(process.env.APPDATA, 'tunnel-client', 'antigravity-local.yaml');
        if (await checkExists(defaultYaml)) sourceConfigPath = defaultYaml;
      } else if (def.id === 'overleaf-mcp' && process.env.APPDATA) {
        const defaultYaml = path.join(process.env.APPDATA, 'tunnel-client', 'overleaf.yaml');
        if (await checkExists(defaultYaml)) sourceConfigPath = defaultYaml;
      } else if (def.id === 'mcp_dsh_chatgpt_bridge' && process.env.USERPROFILE) {
        const defaultYaml = path.join(process.env.USERPROFILE, '.dsh', 'chatgpt-bridge', 'tunnel', 'dsh-bridge.yaml');
        if (await checkExists(defaultYaml)) sourceConfigPath = defaultYaml;
      }
    }
    const effectiveConfigPath = runtime?.effectiveConfigPath || null;
    const managerStorePath = storePath || (dataDir ? path.join(dataDir, 'manager.db') : null);

    let installationRoot = null;
    let executable = null;
    let cwd = null;
    let detected = null;

    if (isHttp) {
      installationRoot = def.locations?.installationRoot || null;
      executable = def.locations?.executable || null;
      cwd = def.locations?.cwd || def.binding?.cwd || null;
      detected = { remote: true, type: 'http' };
    } else {
      const locExe = def.locations?.executable || null;
      const bindExe = def.binding?.executable || null;
      executable = (locExe && await checkExists(locExe)) ? locExe : (bindExe || locExe || null);
      if (executable && !(await checkExists(executable))) {
        const resolvedInPath = await resolveCommandInPath(executable);
        if (resolvedInPath) {
          executable = resolvedInPath;
        }
      }
      cwd = def.binding?.cwd || def.locations?.cwd || null;
      installationRoot = def.locations?.installationRoot || null;

      let packageInfo = null;
      if (!installationRoot) {
        // Probe candidate directories for package.json without running any commands
        const candidatesToProbe = [];
        if (Array.isArray(def.binding?.args)) {
          for (const argItem of def.binding.args) {
            const argVal = typeof argItem === 'string' ? argItem : argItem?.value;
            if (typeof argVal === 'string' && !argVal.startsWith('-') && /\.(?:m?js|cjs|ts)$/i.test(argVal)) {
              const scriptDir = path.dirname(argVal);
              if (scriptDir && scriptDir !== '.') {
                candidatesToProbe.push(scriptDir);
                const parentScriptDir = path.dirname(scriptDir);
                if (parentScriptDir && parentScriptDir !== '.' && parentScriptDir !== scriptDir) {
                  candidatesToProbe.push(parentScriptDir);
                }
              }
            }
          }
        }
        if (cwd) candidatesToProbe.push(cwd);
        if (executable && !executable.includes(' ')) {
          const exeDir = path.dirname(executable);
          if (exeDir && exeDir !== '.') candidatesToProbe.push(exeDir);
        }

        for (const probeDir of candidatesToProbe) {
          const pkgPath = path.join(probeDir, 'package.json');
          try {
            const st = await statFn(pkgPath);
            if (st.isFile()) {
              installationRoot = probeDir;
              break;
            }
          } catch (_) {}
        }

        // Probe Python environment root if executable resides in Scripts/bin directory
        if (!installationRoot && executable && !executable.includes(' ')) {
          const exeDir = path.dirname(executable);
          const dirName = path.basename(exeDir).toLowerCase();
          if (dirName === 'scripts' || dirName === 'bin') {
            const parentDir = path.dirname(exeDir);
            if (parentDir && parentDir !== '.' && parentDir !== exeDir) {
              for (const marker of ['python.exe', 'pyvenv.cfg', 'python3', 'python']) {
                try {
                  const st = await statFn(path.join(parentDir, marker));
                  if (st.isFile()) {
                    installationRoot = parentDir;
                    break;
                  }
                } catch (_) {}
              }
            }
          }
        }

        if (!installationRoot) {
          installationRoot = 'unknown';
        }
      }

      // If installation root found, safely read package.json manifest name/version only
      if (installationRoot && installationRoot !== 'unknown') {
        const pkgPath = path.join(installationRoot, 'package.json');
        try {
          const raw = await fs.promises.readFile(pkgPath, 'utf8');
          const parsed = JSON.parse(raw);
          packageInfo = {
            name: typeof parsed.name === 'string' ? parsed.name : null,
            version: typeof parsed.version === 'string' ? parsed.version : null
          };
        } catch (_) {
          packageInfo = null;
        }
      }

      detected = {
        remote: false,
        type: 'stdio',
        unknown: installationRoot === 'unknown',
        package: packageInfo
      };
    }

    const exists = {
      sourceConfig: await checkExists(sourceConfigPath),
      effectiveConfig: await checkExists(effectiveConfigPath),
      managerStore: await checkExists(managerStorePath),
      installation: installationRoot && installationRoot !== 'unknown' ? await checkExists(installationRoot) : false,
      executable: await checkExists(executable),
      cwd: await checkExists(cwd)
    };

    return {
      sourceConfigPath,
      effectiveConfigPath,
      managerStorePath,
      installationRoot,
      executable,
      cwd,
      exists,
      detected,
      provenance: def.provenance || null
    };
  }

  /**
   * Safely opens the containing directory of a target path using system explorer or injected revealer.
   * Never executes or opens files directly.
   */
  async function reveal(def, role, runtime = {}) {
    if (!ALLOWED_ROLES.includes(role)) {
      const err = new Error(`Invalid reveal role: ${role}. Allowed roles: ${ALLOWED_ROLES.join(', ')}`);
      err.code = 'INVALID_REVEAL_ROLE';
      err.status = 400;
      err.statusCode = 400;
      throw err;
    }

    const desc = await describe(def, runtime);

    let targetPath = null;
    switch (role) {
      case 'sourceConfig':
        targetPath = desc.sourceConfigPath;
        break;
      case 'effectiveConfig':
        targetPath = desc.effectiveConfigPath;
        break;
      case 'installation':
        targetPath = desc.installationRoot;
        break;
      case 'executable':
        targetPath = desc.executable;
        break;
      case 'workingDirectory':
        targetPath = desc.cwd;
        break;
      case 'managerStore':
        targetPath = desc.managerStorePath;
        break;
    }

    if (!targetPath || targetPath === 'unknown') {
      const err = new Error(`Path for role '${role}' is not available or unknown`);
      err.code = 'PATH_NOT_AVAILABLE';
      err.status = 404;
      err.statusCode = 404;
      throw err;
    }

    // Security validation: forbid null bytes, UNC, device paths, URLs, DOS reserved devices
    if (typeof targetPath !== 'string' || targetPath.includes('\0')) {
      const err = new Error('Invalid path: contains forbidden null character');
      err.code = 'INVALID_PATH';
      err.status = 400;
      err.statusCode = 400;
      throw err;
    }

    if (targetPath.startsWith('\\\\') || targetPath.startsWith('//')) {
      const err = new Error('Invalid path: UNC network paths are forbidden');
      err.code = 'INVALID_PATH';
      err.status = 400;
      err.statusCode = 400;
      throw err;
    }

    if (targetPath.startsWith('\\\\?\\') || targetPath.startsWith('\\\\.\\')) {
      const err = new Error('Invalid path: Windows device namespaces are forbidden');
      err.code = 'INVALID_PATH';
      err.status = 400;
      err.statusCode = 400;
      throw err;
    }

    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(targetPath)) {
      const err = new Error('Invalid path: URL schemes are forbidden');
      err.code = 'INVALID_PATH';
      err.status = 400;
      err.statusCode = 400;
      throw err;
    }

    if (/(?:^|[\\/])(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(targetPath)) {
      const err = new Error('Invalid path: DOS device names are forbidden');
      err.code = 'INVALID_PATH';
      err.status = 400;
      err.statusCode = 400;
      throw err;
    }

    // Verify target path exists on disk
    let st;
    try {
      st = await statFn(targetPath);
    } catch (statErr) {
      const err = new Error(`Path for role '${role}' does not exist on disk`);
      err.code = 'PATH_NOT_FOUND';
      err.status = 404;
      err.statusCode = 404;
      throw err;
    }

    // Determine containing directory: if file, use parent directory; if directory, use target itself
    const resolvedPath = path.resolve(targetPath);
    const dirToReveal = st.isDirectory() ? resolvedPath : path.dirname(resolvedPath);

    // Canonicalize directory
    let canonicalDir = dirToReveal;
    if (realpathFn) {
      try {
        canonicalDir = await realpathFn(dirToReveal);
      } catch (_) {}
    }

    if (typeof revealDirectoryFn === 'function') {
      await revealDirectoryFn(canonicalDir);
    } else {
      if (process.platform === 'win32') {
        const child = spawn('explorer.exe', [canonicalDir], {
          detached: true,
          stdio: 'ignore'
        });
        child.unref();
      }
    }

    return {
      success: true,
      opened: true,
      message: '已请求打开所在目录',
      revealedDirectory: canonicalDir,
      role,
      targetPath
    };
  }

  return {
    describe,
    reveal
  };
}

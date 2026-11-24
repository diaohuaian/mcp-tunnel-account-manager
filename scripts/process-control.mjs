#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';

/**
 * Cross-platform / macOS implementation of process-control.ps1.
 * Provides handle-bound identity verification and safe process control for Unix/macOS.
 */

export function isPidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    return err.code === 'EPERM';
  }
  try {
    const stat = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (!stat || stat.includes('Z')) {
      return false;
    }
  } catch (_) {
    return false;
  }
  return true;
}

export function getProcessInfo(pid) {
  if (!isPidAlive(pid)) return null;
  try {
    const lstartRaw = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (!lstartRaw) return null;
    const date = new Date(lstartRaw);
    if (isNaN(date.getTime())) return null;
    const isoUtc = date.toISOString();
    const fileTime = ((BigInt(date.getTime()) + 11644473600000n) * 10000n).toString();

    let comm = '';
    try {
      comm = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
    } catch (_) {}

    let commandLine = '';
    try {
      commandLine = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
    } catch (_) {}

    return {
      pid,
      executablePath: comm || (commandLine ? commandLine.split(' ')[0] : ''),
      creationDate: isoUtc,
      creationTimeFileTime: fileTime,
      commandLine
    };
  } catch (_) {
    return null;
  }
}

export function testExecutablePathMatch(actualPath, expectedPath) {
  if (!actualPath || !expectedPath) return false;
  const normActual = path.resolve(actualPath).toLowerCase();
  const normExpected = path.resolve(expectedPath).toLowerCase();
  if (normActual === normExpected) return true;

  if (!expectedPath.includes('/') && !expectedPath.includes('\\')) {
    const actualName = path.basename(actualPath).toLowerCase();
    const expectedName = expectedPath.trim().toLowerCase();
    if (actualName === expectedName) return true;
    if (`${actualName}.exe` === expectedName) return true;
    if (actualName === `${expectedName}.exe`) return true;
  } else {
    try {
      const realActual = fs.realpathSync(actualPath).toLowerCase();
      const realExpected = fs.realpathSync(expectedPath).toLowerCase();
      if (realActual === realExpected) return true;
    } catch (_) {}

    const actualBase = path.basename(actualPath).toLowerCase().replace(/\.exe$/i, '');
    const expectedBase = path.basename(expectedPath).toLowerCase().replace(/\.exe$/i, '');
    if (actualBase === expectedBase) {
      const expectedDir = path.dirname(expectedPath);
      if (expectedDir && expectedDir !== '.' && expectedDir !== '/') {
        const actualDir = path.dirname(actualPath);
        if (actualDir.toLowerCase() !== expectedDir.toLowerCase()) {
          return false;
        }
      }
      return true;
    }
  }
  return false;
}

export function testCreationTimeMatch(actualFileTime, actualIsoUtc, expectedStart, expectedFileTime) {
  if (!actualFileTime) return false;
  if (expectedFileTime && String(expectedFileTime).trim()) {
    return String(expectedFileTime).trim() === String(actualFileTime).trim();
  }
  if (expectedStart && String(expectedStart).trim()) {
    const trimmed = String(expectedStart).trim();
    if (/^\d{15,20}$/.test(trimmed)) {
      if (trimmed === String(actualFileTime).trim()) return true;
    }
    if (actualIsoUtc === trimmed) return true;
    try {
      const expDt = new Date(trimmed).getTime();
      const actDt = new Date(actualIsoUtc).getTime();
      if (!isNaN(expDt) && !isNaN(actDt)) {
        if (expDt === actDt) return true;
        if (Math.abs(expDt - actDt) <= 2000) return true;
      }
    } catch (_) {}
  }
  return false;
}

export function getPortListeners(targetPort = 0) {
  const listeners = [];
  try {
    const args = targetPort > 0
      ? ['-nP', `-iTCP:${targetPort}`, '-sTCP:LISTEN']
      : ['-nP', '-iTCP', '-sTCP:LISTEN'];
    const out = execFileSync('lsof', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const lines = out.split('\n');
    for (const line of lines) {
      if (!line.trim() || line.startsWith('COMMAND')) continue;
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[1], 10);
      const addrPortMatch = line.match(/([^\s:]+):(\d+)\s+\(LISTEN\)/);
      if (addrPortMatch) {
        const localAddress = addrPortMatch[1];
        const localPort = parseInt(addrPortMatch[2], 10);
        const isLoopback = localAddress === '127.0.0.1' ||
          localAddress.startsWith('127.') ||
          localAddress === '::1' ||
          localAddress === '*' ||
          localAddress === 'localhost' ||
          localAddress === '0.0.0.0' ||
          localAddress === '::';
        listeners.push({
          localAddress,
          localPort,
          owningPid: pid,
          isLoopback
        });
      }
    }
  } catch (_) {}
  return listeners;
}

export async function runProcessControlAction(params = {}, stdinPayload = null) {
  const action = params.Action || params.action;
  const processId = params.ProcessId ? Number(params.ProcessId) : 0;
  const port = params.Port ? Number(params.Port) : (params.LocalPort ? Number(params.LocalPort) : 0);
  const expectedExecutablePath = params.ExpectedExecutablePath || null;
  const expectedStartTime = params.ExpectedStartTime || null;
  const expectedCreationTimeFileTime = params.ExpectedCreationTimeFileTime ? String(params.ExpectedCreationTimeFileTime) : null;
  const timeoutSeconds = params.TimeoutSeconds ? Number(params.TimeoutSeconds) : 10;
  const tag = params.Tag ? String(params.Tag) : null;
  const commandLine = params.CommandLine ? String(params.CommandLine) : null;

  if ((params.LaunchPayloadFromStdin || params.LaunchPayload) && action !== 'Launch') {
    return {
      code: 1,
      data: {
        success: false,
        error: 'INVALID_ACTION_FOR_FLAG',
        message: '-LaunchPayloadFromStdin is only supported with -Action Launch'
      }
    };
  }

  switch (action) {
    case 'Inspect': {
      if (processId <= 0 || !isPidAlive(processId)) {
        return {
          code: 0,
          data: {
            success: true,
            running: false,
            processId,
            pid: processId
          }
        };
      }

      const info = getProcessInfo(processId);
      if (!info) {
        return {
          code: 0,
          data: {
            success: true,
            running: false,
            processId,
            pid: processId
          }
        };
      }

      let lbPort = 0;
      try {
        const listeners = getPortListeners(0).filter(l => l.owningPid === processId && l.isLoopback);
        if (listeners.length > 0) {
          lbPort = listeners[0].localPort;
        }
      } catch (_) {}

      return {
        code: 0,
        data: {
          success: true,
          running: true,
          processId,
          pid: processId,
          executablePath: info.executablePath,
          executable: info.executablePath,
          creationDate: info.creationDate,
          startedAt: info.creationDate,
          startTime: info.creationDate,
          creationTimeFileTime: info.creationTimeFileTime,
          localPort: lbPort > 0 ? lbPort : null,
          healthURL: lbPort > 0 ? `http://127.0.0.1:${lbPort}` : null
        }
      };
    }

    case 'Verify': {
      if (processId <= 0) {
        return {
          code: 2,
          data: {
            success: false,
            valid: false,
            reason: 'INVALID_PROCESS_ID',
            processId,
            pid: processId
          }
        };
      }

      const info = getProcessInfo(processId);
      if (!info) {
        return {
          code: 2,
          data: {
            success: false,
            valid: false,
            reason: 'NOT_RUNNING',
            processId,
            pid: processId
          }
        };
      }

      const exeMatch = testExecutablePathMatch(info.executablePath, expectedExecutablePath);
      const timeMatch = testCreationTimeMatch(
        info.creationTimeFileTime,
        info.creationDate,
        expectedStartTime,
        expectedCreationTimeFileTime
      );

      const valid = exeMatch && timeMatch;
      const reason = !exeMatch ? 'PATH_MISMATCH' : (!timeMatch ? 'CREATION_TIME_MISMATCH' : 'VALID');

      return {
        code: valid ? 0 : 2,
        data: {
          success: valid,
          valid,
          reason,
          processId,
          pid: processId,
          executablePath: info.executablePath,
          executable: info.executablePath,
          creationDate: info.creationDate,
          startedAt: info.creationDate,
          startTime: info.creationDate,
          creationTimeFileTime: info.creationTimeFileTime
        }
      };
    }

    case 'Stop': {
      if (processId <= 0) {
        return {
          code: 0,
          data: {
            success: true,
            stopped: true,
            reason: 'INVALID_PID',
            processId,
            pid: processId
          }
        };
      }

      if (!expectedExecutablePath || (!expectedStartTime && !expectedCreationTimeFileTime)) {
        return {
          code: 2,
          data: {
            success: false,
            stopped: false,
            error: 'PROCESS_IDENTITY_MISMATCH',
            reason: 'MISSING_EXPECTED_IDENTITY',
            processId,
            pid: processId
          }
        };
      }

      if (!isPidAlive(processId)) {
        return {
          code: 0,
          data: {
            success: true,
            stopped: true,
            reason: 'ALREADY_STOPPED',
            processId,
            pid: processId
          }
        };
      }

      const info = getProcessInfo(processId);
      if (!info) {
        return {
          code: 0,
          data: {
            success: true,
            stopped: true,
            reason: 'ALREADY_STOPPED',
            processId,
            pid: processId
          }
        };
      }

      const exeMatch = testExecutablePathMatch(info.executablePath, expectedExecutablePath);
      if (!exeMatch) {
        return {
          code: 2,
          data: {
            success: false,
            stopped: false,
            error: 'PROCESS_IDENTITY_MISMATCH',
            reason: 'PATH_MISMATCH',
            expected: expectedExecutablePath,
            actual: info.executablePath,
            processId,
            pid: processId
          }
        };
      }

      const timeMatch = testCreationTimeMatch(
        info.creationTimeFileTime,
        info.creationDate,
        expectedStartTime,
        expectedCreationTimeFileTime
      );
      if (!timeMatch) {
        return {
          code: 2,
          data: {
            success: false,
            stopped: false,
            error: 'PROCESS_IDENTITY_MISMATCH',
            reason: 'CREATION_TIME_MISMATCH',
            expected: expectedStartTime || expectedCreationTimeFileTime,
            actual: info.creationDate,
            actualFileTime: info.creationTimeFileTime,
            processId,
            pid: processId
          }
        };
      }

      try {
        process.kill(processId, 'SIGTERM');
      } catch (err) {
        if (err.code === 'ESRCH') {
          return { code: 0, data: { success: true, stopped: true, processId, pid: processId } };
        }
      }

      // Allow up to 1 second for graceful SIGTERM shutdown
      const termDeadline = Date.now() + 1000;
      while (Date.now() < termDeadline) {
        if (!isPidAlive(processId)) {
          return { code: 0, data: { success: true, stopped: true, processId, pid: processId } };
        }
        await new Promise(r => setTimeout(r, 50));
      }

      // If still alive, escalate to SIGKILL
      try {
        process.kill(processId, 'SIGKILL');
      } catch (err) {
        if (err.code === 'ESRCH') {
          return { code: 0, data: { success: true, stopped: true, processId, pid: processId } };
        }
      }

      const killDeadline = Date.now() + Math.max(1000, timeoutSeconds * 1000 - 1000);
      while (Date.now() < killDeadline) {
        if (!isPidAlive(processId)) {
          return { code: 0, data: { success: true, stopped: true, processId, pid: processId } };
        }
        await new Promise(r => setTimeout(r, 50));
      }

      return {
        code: 3,
        data: {
          success: false,
          stopped: false,
          error: 'STOP_TIMEOUT',
          processId,
          pid: processId
        }
      };
    }

    case 'Launch': {
      let payload = null;
      if (params.LaunchPayloadFromStdin || stdinPayload !== null) {
        const rawBuf = Buffer.isBuffer(stdinPayload)
          ? stdinPayload
          : (typeof stdinPayload === 'string' ? Buffer.from(stdinPayload) : Buffer.alloc(0));

        if (rawBuf.length > 262144) {
          return {
            code: 1,
            data: {
              success: false,
              error: 'PAYLOAD_TOO_LARGE',
              message: 'Standard input payload exceeds maximum limit of 262144 bytes',
              limitBytes: 262144
            }
          };
        }
        if (rawBuf.length === 0) {
          return {
            code: 1,
            data: {
              success: false,
              error: 'INVALID_PAYLOAD',
              message: 'Standard input payload is empty'
            }
          };
        }

        let rawPayload = '';
        try {
          rawPayload = new TextDecoder('utf-8', { fatal: true }).decode(rawBuf);
        } catch (_) {
          return {
            code: 1,
            data: {
              success: false,
              error: 'INVALID_ENCODING',
              message: 'Standard input payload is not valid UTF-8'
            }
          };
        }

        try {
          payload = JSON.parse(rawPayload);
        } catch (_) {
          return {
            code: 1,
            data: {
              success: false,
              error: 'INVALID_JSON',
              message: 'Failed to parse JSON payload'
            }
          };
        }
      } else if (params.LaunchPayload) {
        payload = params.LaunchPayload;
        const payloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
        if (payloadBytes > 262144) {
          return {
            code: 1,
            data: {
              success: false,
              error: 'PAYLOAD_TOO_LARGE'
            }
          };
        }
      } else {
        let envParsed = {};
        if (params.EnvironmentVariables) {
          try {
            envParsed = typeof params.EnvironmentVariables === 'string'
              ? JSON.parse(params.EnvironmentVariables)
              : params.EnvironmentVariables;
          } catch (_) {}
        }
        let argsParsed = [];
        if (params.Arguments) {
          if (Array.isArray(params.Arguments)) {
            argsParsed = params.Arguments;
          } else if (typeof params.Arguments === 'string') {
            argsParsed = parseCommandLineArgs(params.Arguments);
          }
        } else if (params.CommandLine) {
          argsParsed = parseCommandLineArgs(params.CommandLine);
        }

        payload = {
          executablePath: params.ExecutablePath,
          arguments: argsParsed,
          workingDirectory: params.WorkingDirectory || null,
          environment: envParsed
        };
      }

      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return {
          code: 1,
          data: { success: false, error: 'INVALID_PAYLOAD', message: 'Payload must be a JSON object' }
        };
      }

      // 1. Validate executablePath
      const targetExeRaw = payload.executablePath;
      if (!targetExeRaw || typeof targetExeRaw !== 'string' || !targetExeRaw.trim()) {
        return {
          code: 1,
          data: { success: false, error: 'INVALID_EXECUTABLE_PATH', message: "'executablePath' must be a non-empty string" }
        };
      }

      let targetExe = targetExeRaw;
      if (!fs.existsSync(targetExe)) {
        const pathDirs = (process.env.PATH || '').split(path.delimiter);
        let found = null;
        for (const dir of pathDirs) {
          if (!dir) continue;
          const cand = path.join(dir, targetExe);
          if (fs.existsSync(cand)) {
            found = cand;
            break;
          }
        }
        if (found) {
          targetExe = found;
        } else {
          return {
            code: 1,
            data: { success: false, error: 'EXECUTABLE_NOT_FOUND', message: `Executable path does not exist: ${targetExe}` }
          };
        }
      }
      targetExe = path.resolve(targetExe);

      // 2. Validate arguments
      if (payload.arguments === undefined || payload.arguments === null) {
        return {
          code: 1,
          data: { success: false, error: 'INVALID_ARGUMENTS', message: "Missing 'arguments' field, expected array of strings" }
        };
      }
      if (!Array.isArray(payload.arguments)) {
        return {
          code: 1,
          data: { success: false, error: 'INVALID_ARGUMENTS', message: "'arguments' must be an array of strings" }
        };
      }
      for (const arg of payload.arguments) {
        if (typeof arg !== 'string') {
          return {
            code: 1,
            data: { success: false, error: 'INVALID_ARGUMENTS', message: "All elements in 'arguments' must be strings" }
          };
        }
      }
      const stringArgs = payload.arguments;

      // 3. Validate workingDirectory
      let targetWd = undefined;
      if (payload.workingDirectory !== null && payload.workingDirectory !== undefined) {
        if (typeof payload.workingDirectory !== 'string') {
          return {
            code: 1,
            data: { success: false, error: 'INVALID_WORKING_DIRECTORY', message: "'workingDirectory' must be null or a string" }
          };
        }
        if (payload.workingDirectory.trim()) {
          if (!fs.existsSync(payload.workingDirectory)) {
            return {
              code: 1,
              data: {
                success: false,
                error: 'WORKING_DIRECTORY_NOT_FOUND',
                message: `Working directory does not exist: ${payload.workingDirectory}`
              }
            };
          }
          targetWd = payload.workingDirectory;
        }
      }

      // 4. Validate environment
      if (payload.environment === undefined || payload.environment === null) {
        return {
          code: 1,
          data: { success: false, error: 'INVALID_ENVIRONMENT', message: "Missing 'environment' field" }
        };
      }
      if (typeof payload.environment !== 'object' || Array.isArray(payload.environment)) {
        return {
          code: 1,
          data: { success: false, error: 'INVALID_ENVIRONMENT', message: "'environment' must be a dictionary/object" }
        };
      }
      for (const [k, v] of Object.entries(payload.environment)) {
        if (typeof v !== 'string') {
          return {
            code: 1,
            data: { success: false, error: 'INVALID_ENVIRONMENT', message: `Environment value for '${k}' must be a string` }
          };
        }
      }

      // 5. Validate hiddenConsole if present
      if (payload.hiddenConsole !== undefined && typeof payload.hiddenConsole !== 'boolean') {
        return {
          code: 1,
          data: { success: false, error: 'INVALID_CONSOLE_MODE' }
        };
      }

      const safeEnv = { ...payload.environment };
      if (!safeEnv.HOME && (process.env.HOME || os.homedir())) {
        safeEnv.HOME = process.env.HOME || os.homedir();
      }
      if (!safeEnv.PATH && process.env.PATH) {
        safeEnv.PATH = process.env.PATH;
      }

      let child;
      try {
        child = spawn(targetExe, stringArgs, {
          cwd: targetWd,
          env: safeEnv,
          detached: true,
          stdio: 'ignore'
        });
      } catch (err) {
        return {
          code: 1,
          data: {
            success: false,
            error: 'SPAWN_FAILED',
            message: err.message
          }
        };
      }

      child.unref();

      let info = null;
      for (let i = 0; i < 20; i++) {
        info = getProcessInfo(child.pid);
        if (info && info.creationDate) break;
        await new Promise(r => setTimeout(r, 10));
      }

      const creationDate = info?.creationDate || new Date().toISOString();
      const creationTimeFileTime = info?.creationTimeFileTime || ((BigInt(Date.now()) + 11644473600000n) * 10000n).toString();

      return {
        code: 0,
        data: {
          success: true,
          running: true,
          processId: child.pid,
          pid: child.pid,
          executablePath: targetExe,
          executable: targetExe,
          creationDate,
          startedAt: creationDate,
          startTime: creationDate,
          creationTimeFileTime
        }
      };
    }

    case 'InspectListener': {
      if (port <= 0 || port > 65535) {
        return {
          code: 2,
          data: {
            success: false,
            valid: false,
            error: 'INVALID_PORT',
            reason: 'INVALID_PORT',
            port
          }
        };
      }

      const allListeners = getPortListeners(port);
      if (allListeners.length === 0) {
        return {
          code: 2,
          data: {
            success: false,
            valid: false,
            running: false,
            error: 'NO_LISTENER',
            reason: 'NO_LISTENER',
            port
          }
        };
      }

      const loopbackListeners = allListeners.filter(l => l.isLoopback);
      if (loopbackListeners.length === 0) {
        return {
          code: 2,
          data: {
            success: false,
            valid: false,
            error: 'NOT_LOOPBACK',
            reason: 'NOT_LOOPBACK',
            port
          }
        };
      }

      const distinctPids = Array.from(new Set(loopbackListeners.map(l => l.owningPid)));
      if (distinctPids.length > 1) {
        return {
          code: 2,
          data: {
            success: false,
            valid: false,
            error: 'AMBIGUOUS_LISTENER',
            reason: 'AMBIGUOUS_LISTENER',
            port,
            pids: distinctPids
          }
        };
      }

      const listenerPid = distinctPids[0];
      if (listenerPid <= 0) {
        return {
          code: 2,
          data: {
            success: false,
            valid: false,
            error: 'INVALID_OWNING_PID',
            reason: 'INVALID_OWNING_PID',
            port
          }
        };
      }

      if (processId > 0 && listenerPid !== processId) {
        return {
          code: 2,
          data: {
            success: false,
            valid: false,
            error: 'PROCESS_IDENTITY_MISMATCH',
            reason: 'PID_MISMATCH',
            port,
            expectedPid: processId,
            actualPid: listenerPid,
            processId: listenerPid,
            pid: listenerPid
          }
        };
      }

      const info = getProcessInfo(listenerPid);
      if (!info) {
        return {
          code: 2,
          data: {
            success: false,
            valid: false,
            running: false,
            error: 'NOT_RUNNING',
            reason: 'NOT_RUNNING',
            port,
            processId: listenerPid,
            pid: listenerPid
          }
        };
      }

      if (expectedExecutablePath) {
        if (!testExecutablePathMatch(info.executablePath, expectedExecutablePath)) {
          return {
            code: 2,
            data: {
              success: false,
              valid: false,
              error: 'PROCESS_IDENTITY_MISMATCH',
              reason: 'PATH_MISMATCH',
              expected: expectedExecutablePath,
              actual: info.executablePath,
              port,
              processId: listenerPid,
              pid: listenerPid
            }
          };
        }
      }

      if (expectedStartTime || expectedCreationTimeFileTime) {
        if (!testCreationTimeMatch(info.creationTimeFileTime, info.creationDate, expectedStartTime, expectedCreationTimeFileTime)) {
          return {
            code: 2,
            data: {
              success: false,
              valid: false,
              error: 'PROCESS_IDENTITY_MISMATCH',
              reason: 'CREATION_TIME_MISMATCH',
              expected: expectedStartTime || expectedCreationTimeFileTime,
              actual: info.creationDate,
              actualFileTime: info.creationTimeFileTime,
              port,
              processId: listenerPid,
              pid: listenerPid
            }
          };
        }
      }

      return {
        code: 0,
        data: {
          success: true,
          valid: true,
          running: true,
          reason: 'VALID',
          port,
          localPort: port,
          localAddress: loopbackListeners[0].localAddress || '127.0.0.1',
          processId: listenerPid,
          pid: listenerPid,
          executablePath: info.executablePath,
          executable: info.executablePath,
          creationDate: info.creationDate,
          startedAt: info.creationDate,
          startTime: info.creationDate,
          creationTimeFileTime: info.creationTimeFileTime
        }
      };
    }

    case 'FindOwned': {
      if (port > 0) {
        const allListeners = getPortListeners(port);
        if (allListeners.length === 0) {
          return {
            code: 2,
            data: { success: false, found: false, valid: false, error: 'NO_LISTENER', reason: 'NO_LISTENER', port }
          };
        }

        const loopbackListeners = allListeners.filter(l => l.isLoopback);
        if (loopbackListeners.length === 0) {
          return {
            code: 2,
            data: { success: false, found: false, valid: false, error: 'NOT_LOOPBACK', reason: 'NOT_LOOPBACK', port }
          };
        }

        const distinctPids = Array.from(new Set(loopbackListeners.map(l => l.owningPid)));
        if (distinctPids.length > 1) {
          return {
            code: 2,
            data: { success: false, found: false, valid: false, error: 'AMBIGUOUS_LISTENER', reason: 'AMBIGUOUS_LISTENER', port, pids: distinctPids }
          };
        }

        const candPid = distinctPids[0];
        if (processId > 0 && candPid !== processId) {
          return {
            code: 2,
            data: { success: false, found: false, valid: false, error: 'PROCESS_IDENTITY_MISMATCH', reason: 'PID_MISMATCH', port, processId: candPid, pid: candPid }
          };
        }

        const info = getProcessInfo(candPid);
        if (!info) {
          return {
            code: 2,
            data: { success: false, found: false, valid: false, error: 'NOT_RUNNING', reason: 'NOT_RUNNING', port, processId: candPid, pid: candPid }
          };
        }

        if (expectedExecutablePath && !testExecutablePathMatch(info.executablePath, expectedExecutablePath)) {
          return {
            code: 2,
            data: { success: false, found: false, valid: false, error: 'PROCESS_IDENTITY_MISMATCH', reason: 'PATH_MISMATCH', expected: expectedExecutablePath, actual: info.executablePath, port, processId: candPid, pid: candPid }
          };
        }

        return {
          code: 0,
          data: {
            success: true,
            found: true,
            valid: true,
            running: true,
            reason: 'VALID',
            port,
            localPort: port,
            processId: candPid,
            pid: candPid,
            executablePath: info.executablePath,
            executable: info.executablePath,
            creationDate: info.creationDate,
            startedAt: info.creationDate,
            startTime: info.creationDate,
            creationTimeFileTime: info.creationTimeFileTime
          }
        };
      }

      const candidates = [];
      if (processId > 0) {
        candidates.push(processId);
      } else {
        try {
          const out = execFileSync('ps', ['-eo', 'pid=,lstart=,command='], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
          });
          const lines = out.split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            const parts = line.trim().split(/\s+/);
            const pPid = parseInt(parts[0], 10);
            if (pPid <= 0 || pPid === process.pid) continue;
            const cmd = parts.slice(6).join(' ');

            let match = true;
            if (tag && !cmd.includes(tag)) match = false;
            if (match && commandLine && !cmd.includes(commandLine)) match = false;
            if (match && expectedExecutablePath) {
              const exeBase = path.basename(expectedExecutablePath);
              if (!cmd.includes(exeBase) && !cmd.includes(expectedExecutablePath)) {
                match = false;
              }
            }
            if (match) {
              candidates.push(pPid);
            }
          }
        } catch (_) {}
      }

      const verified = [];
      for (const cPid of candidates) {
        const info = getProcessInfo(cPid);
        if (info) verified.push(info);
      }

      if (verified.length > 1) {
        return {
          code: 2,
          data: {
            success: false,
            found: false,
            valid: false,
            error: 'AMBIGUOUS_MATCH',
            reason: 'AMBIGUOUS_MATCH',
            count: verified.length,
            pids: verified.map(v => v.pid)
          }
        };
      }

      if (verified.length === 0) {
        return {
          code: 2,
          data: {
            success: false,
            found: false,
            valid: false,
            error: 'NOT_FOUND',
            reason: 'NOT_FOUND'
          }
        };
      }

      const v = verified[0];
      let lbPort = 0;
      try {
        const listeners = getPortListeners(0).filter(l => l.owningPid === v.pid && l.isLoopback);
        if (listeners.length > 0) {
          lbPort = listeners[0].localPort;
        }
      } catch (_) {}

      return {
        code: 0,
        data: {
          success: true,
          found: true,
          valid: true,
          running: true,
          reason: 'VALID',
          processId: v.pid,
          pid: v.pid,
          executablePath: v.executablePath,
          executable: v.executablePath,
          creationDate: v.creationDate,
          startedAt: v.creationDate,
          startTime: v.creationDate,
          creationTimeFileTime: v.creationTimeFileTime,
          localPort: lbPort > 0 ? lbPort : null,
          healthURL: lbPort > 0 ? `http://127.0.0.1:${lbPort}` : null
        }
      };
    }

    default:
      return {
        code: 1,
        data: {
          success: false,
          error: 'UNKNOWN_ACTION',
          message: `Unknown action: ${action}`
        }
      };
  }
}

function parseCommandLineArgs(str) {
  const args = [];
  let cur = '';
  let inQuote = false;
  let quoteChar = '';
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (inQuote) {
      if (c === quoteChar) {
        inQuote = false;
      } else {
        cur += c;
      }
    } else if (c === '"' || c === "'") {
      inQuote = true;
      quoteChar = c;
    } else if (/\s/.test(c)) {
      if (cur) {
        args.push(cur);
        cur = '';
      }
    } else {
      cur += c;
    }
  }
  if (cur) args.push(cur);
  return args;
}

export async function main() {
  const rawArgs = process.argv.slice(2);
  const params = {};
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg.startsWith('-')) {
      const key = arg.slice(1);
      if (key === 'LaunchPayloadFromStdin') {
        params.LaunchPayloadFromStdin = true;
      } else if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith('-')) {
        params[key] = rawArgs[++i];
      } else {
        params[key] = true;
      }
    }
  }

  let stdinPayload = null;
  if (params.LaunchPayloadFromStdin || !process.stdin.isTTY) {
    try {
      const chunks = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      stdinPayload = Buffer.concat(chunks);
    } catch (_) {}
  }

  const res = await runProcessControlAction(params, stdinPayload);
  process.stdout.write(JSON.stringify(res.data) + '\n');
  process.exit(res.code || 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch(err => {
    process.stderr.write(err.message + '\n');
    process.exit(1);
  });
}

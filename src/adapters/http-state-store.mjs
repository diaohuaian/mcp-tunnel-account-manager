import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  sealHttpTransport,
  openHttpTransport,
  compileHttpTransport,
  clearInheritedMcpOverrides,
  mergeHttpLaunchEnvironment,
  fingerprintHttpConfiguration,
  HttpTransportFault
} from './http-transport.mjs';
import { isMcpServiceId } from '../core/mcp-registry-policy.mjs';
import { enforceWindowsAcls } from '../vault.mjs';

export {
  sealHttpTransport,
  openHttpTransport,
  compileHttpTransport,
  clearInheritedMcpOverrides,
  mergeHttpLaunchEnvironment,
  fingerprintHttpConfiguration,
  HttpTransportFault
};

export class HttpStateStoreFault extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.status = 400;
  }
}

const OP_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

function validateContext(context) {
  if (!context || typeof context !== 'object') {
    throw new HttpTransportFault('INVALID_HTTP_CONTEXT');
  }
  if (!isMcpServiceId(context.serviceId) ||
      typeof context.operationId !== 'string' ||
      !OP_ID_REGEX.test(context.operationId)) {
    throw new HttpTransportFault('INVALID_HTTP_CONTEXT');
  }
}

export function getHttpStatePath(dataDir, serviceId, operationId) {
  if (!dataDir || typeof dataDir !== 'string' || dataDir.trim() === '' || dataDir.includes('\0')) {
    throw new HttpTransportFault('INVALID_HTTP_DATA_DIR');
  }
  validateContext({ serviceId, operationId });
  return path.join(dataDir, 'runtime', serviceId, operationId, 'http-transport.json');
}

export const getHttpTransportPacketPath = getHttpStatePath;

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function plansEqual(a, b) {
  if (!a || !b) return false;
  if (a.kind !== b.kind || a.channel !== b.channel) return false;
  if (!arraysEqual(a.args, b.args)) return false;
  if (!arraysEqual(a.headerNames, b.headerNames)) return false;
  const aEnv = a.privateEnvironment || {};
  const bEnv = b.privateEnvironment || {};
  const aKeys = Object.keys(aEnv).sort();
  const bKeys = Object.keys(bEnv).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    const k = aKeys[i];
    if (k !== bKeys[i] || aEnv[k] !== bEnv[k]) return false;
  }
  return true;
}

async function readAndVerifyExisting(filePath, plan, vault, context) {
  let existingBytes;
  try {
    existingBytes = fs.readFileSync(filePath);
  } catch {
    throw new HttpTransportFault('HTTP_STATE_UNREADABLE');
  }

  let existingPacket;
  try {
    existingPacket = JSON.parse(existingBytes.toString('utf8'));
  } catch {
    throw new HttpTransportFault('INVALID_HTTP_STATE');
  }

  const existingPlan = await openHttpTransport(vault, existingPacket, context);

  if (plan && !plansEqual(existingPlan, plan)) {
    throw new HttpTransportFault('HTTP_STATE_CONFLICT');
  }

  return {
    packet: existingPacket,
    bytes: existingBytes,
    packetBytes: existingBytes,
    plan: existingPlan,
    reused: true,
    path: filePath
  };
}

/**
 * Persists an HTTP transport capsule atomically using vault encryption.
 * Supports both positional args: persistHttpState(vault, dataDir, binding, context)
 * and object options: persistHttpState({ vault, dataDir, binding, context, desiredPlan })
 */
export async function persistHttpState(arg1, arg2, arg3, arg4) {
  let vault, dataDir, binding, context, desiredPlan;
  if (arg1 && typeof arg1 === 'object' && ('dataDir' in arg1 || 'vault' in arg1 || 'context' in arg1)) {
    vault = arg1.vault;
    dataDir = arg1.dataDir;
    binding = arg1.binding;
    context = arg1.context;
    desiredPlan = arg1.desiredPlan;
  } else {
    vault = arg1;
    dataDir = arg2;
    binding = arg3;
    context = arg4;
  }

  if (!vault || typeof vault.seal !== 'function' || typeof vault.unseal !== 'function') {
    throw new HttpTransportFault('HTTP_VAULT_REQUIRED');
  }
  validateContext(context);
  const filePath = getHttpStatePath(dataDir, context.serviceId, context.operationId);

  if (!binding && !fs.existsSync(filePath)) {
    throw new HttpStateStoreFault('HTTP_BINDING_REQUIRED');
  }

  let plan;
  if (binding) {
    const authoritativePlan = compileHttpTransport(binding, context);
    if (desiredPlan && !plansEqual(authoritativePlan, desiredPlan)) {
      throw new HttpTransportFault('HTTP_STATE_CONFLICT');
    }
    plan = authoritativePlan;
  } else if (desiredPlan) {
    plan = desiredPlan;
  } else {
    throw new HttpStateStoreFault('HTTP_BINDING_REQUIRED');
  }

  if (fs.existsSync(filePath)) {
    return await readAndVerifyExisting(filePath, plan, vault, context);
  }

  const packet = await sealHttpTransport(vault, binding, context);
  const json = JSON.stringify(packet, null, 2) + '\n';
  const packetBytes = Buffer.from(json, 'utf8');

  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { enforceWindowsAcls(dir); } catch (_) {}

  const tmpPath = path.join(dir, `http-transport.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`);
  fs.writeFileSync(tmpPath, packetBytes, { mode: 0o600 });
  try { enforceWindowsAcls(tmpPath); } catch (_) {}

  try {
    fs.linkSync(tmpPath, filePath);
    try { enforceWindowsAcls(filePath); } catch (_) {}
  } catch (linkErr) {
    if (linkErr && linkErr.code === 'EEXIST') {
      return await readAndVerifyExisting(filePath, plan, vault, context);
    }
    throw linkErr;
  } finally {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch (_) {}
  }

  return {
    packet,
    bytes: packetBytes,
    packetBytes,
    plan,
    reused: false,
    path: filePath
  };
}

export const persistHttpTransportPacket = persistHttpState;

/**
 * Loads and authenticates a sealed HTTP transport capsule.
 * Supports both positional args: loadHttpState(vault, dataDir, context)
 * and object options: loadHttpState({ vault, dataDir, context })
 */
export async function loadHttpState(arg1, arg2, arg3) {
  let vault, dataDir, context;
  if (arg1 && typeof arg1 === 'object' && ('dataDir' in arg1 || 'context' in arg1 || 'vault' in arg1)) {
    vault = arg1.vault;
    dataDir = arg1.dataDir;
    context = arg1.context;
  } else {
    vault = arg1;
    dataDir = arg2;
    context = arg3;
  }

  if (!vault || typeof vault.unseal !== 'function') {
    throw new HttpTransportFault('HTTP_VAULT_REQUIRED');
  }
  validateContext(context);
  const filePath = getHttpStatePath(dataDir, context.serviceId, context.operationId);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  let bytes;
  try {
    bytes = fs.readFileSync(filePath);
  } catch {
    throw new HttpTransportFault('HTTP_STATE_UNREADABLE');
  }

  let packet;
  try {
    packet = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new HttpTransportFault('INVALID_HTTP_STATE');
  }

  const plan = await openHttpTransport(vault, packet, context);
  return { packet, bytes, packetBytes: bytes, plan, path: filePath };
}

export const loadHttpTransportPacket = loadHttpState;

export function createHttpStateStore({ dataDir, vault }) {
  if (!dataDir || typeof dataDir !== 'string') {
    throw new HttpTransportFault('INVALID_HTTP_DATA_DIR');
  }
  return {
    dataDir,
    vault,
    getPacketPath(serviceId, operationId) {
      return getHttpStatePath(dataDir, serviceId, operationId);
    },
    async savePacket(binding, context, desiredPlan) {
      return persistHttpState({ dataDir, vault, binding, context, desiredPlan });
    },
    async loadPacket(context) {
      return loadHttpState({ dataDir, vault, context });
    },
    async seal(binding, context) {
      return sealHttpTransport(vault, binding, context);
    },
    async open(packet, context) {
      return openHttpTransport(vault, packet, context);
    }
  };
}

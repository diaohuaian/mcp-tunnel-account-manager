import {clearInheritedMcpOverrides, mergeHttpLaunchEnvironment, HTTP_HEADER_ENV_PREFIX} from './http-transport.mjs';

const OWNED_MCP_NAMES = new Set(['MCP_SERVER_URL', 'MCP_COMMAND', 'MCP_EXTRA_HEADERS', 'MCP_DISCOVERY_EXTRA_HEADERS']);
const SERVICE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_ENV_NAME = new RegExp('^' + HTTP_HEADER_ENV_PREFIX + '[0-9A-F]{24}$');
const CONTROL_PLANE_PREFIX = 'CONTROL_PLANE_';
const dangerous = new Set(['__PROTO__', 'CONSTRUCTOR', 'PROTOTYPE']);

export class TunnelLaunchEnvironmentFault extends Error {
  constructor(code) { super(code); this.code = code; this.status = 400; }
}
const fail = code => { throw new TunnelLaunchEnvironmentFault(code); };
const upper = name => name.toUpperCase();
const isControlPlane = name => upper(name).startsWith(CONTROL_PLANE_PREFIX);
const isOwnedMcp = name => OWNED_MCP_NAMES.has(upper(name)) || upper(name).startsWith(HTTP_HEADER_ENV_PREFIX);

function descriptors(value, code) {
  try {
    if (value === null || typeof value !== 'object' ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
    return Object.getOwnPropertyDescriptors(value);
  } catch { fail(code); }
}

function entries(value, code = 'INVALID_LAUNCH_ENV') {
  const properties = descriptors(value, code), result = [];
  for (const key of Reflect.ownKeys(properties)) {
    const property = properties[key];
    if (typeof key !== 'string' || !property.enumerable || !Object.hasOwn(property, 'value')) fail(code);
    if (!key || /[=\0]/.test(key)) fail('INVALID_LAUNCH_ENV_NAME');
    if (typeof property.value !== 'string' || property.value.includes('\0')) fail('INVALID_LAUNCH_ENV_VALUE');
    result.push([key, property.value]);
  }
  return result;
}

function option(properties, name, fallback) {
  const property = properties[name];
  if (property === undefined) return fallback;
  if (!Object.hasOwn(property, 'value')) fail('INVALID_LAUNCH_OPTIONS');
  return property.value === undefined ? fallback : property.value;
}

function replace(environment, name, value) {
  const identity = upper(name);
  for (const previous of Object.keys(environment)) if (upper(previous) === identity) delete environment[previous];
  environment[name] = value;
}

function validateUnique(entriesToCheck) {
  const seen = new Set();
  for (const [name] of entriesToCheck) {
    const identity = upper(name);
    if (seen.has(identity)) fail('DUPLICATE_LAUNCH_ENV');
    seen.add(identity);
  }
}

function validateHttpPlan(plan) {
  const properties = descriptors(plan, 'INVALID_LAUNCH_HTTP_PLAN');
  const kind = properties.kind, privateEnvironment = properties.privateEnvironment;
  if (!kind || !Object.hasOwn(kind, 'value') || kind.value !== 'http' ||
      !privateEnvironment || !Object.hasOwn(privateEnvironment, 'value')) fail('INVALID_LAUNCH_HTTP_PLAN');
  const privateEntries = entries(privateEnvironment.value, 'INVALID_LAUNCH_HTTP_PLAN');
  if (!privateEntries.some(([name, value]) => name === 'MCP_SERVER_URL' && value)) fail('INVALID_LAUNCH_HTTP_PLAN');
  if (privateEntries.some(([name]) => name !== 'MCP_SERVER_URL' && !HEADER_ENV_NAME.test(name))) fail('INVALID_LAUNCH_HTTP_PLAN');
}

/**
 * Compose the COMPLETE environment for one tunnel-client child. httpPlan must
 * already come from compileHttpTransport/openHttpTransport in its pinned context;
 * this helper composes it, it does not authenticate an arbitrary transport plan.
 *
 * The process controller/PowerShell launcher MUST use this result verbatim:
 * no later process.env merge and no second clearInheritedMcpOverrides call.
 * Clearing is performed once on inherited values, before the selected plan is
 * installed. Trusted control-plane values are installed last. Empty CP maps are
 * allowed for test/transport-only consumers; credential requirements stay with
 * account validation. Inputs are never mutated.
 */
export function buildTunnelLaunchEnvironment(options = {}) {
  const properties = descriptors(options, 'INVALID_LAUNCH_OPTIONS');
  const inheritedEntries = entries(option(properties, 'inheritedEnvironment', {}));
  const serviceEntries = entries(option(properties, 'serviceEnvironment', {}));
  const controlPlaneEntries = entries(option(properties, 'controlPlaneEnvironment', {}));
  const httpPlan = option(properties, 'httpPlan', null);

  validateUnique(serviceEntries);
  validateUnique(controlPlaneEntries);
  for (const [name] of serviceEntries) {
    if (!SERVICE_NAME.test(name) || dangerous.has(upper(name)) || isControlPlane(name) || isOwnedMcp(name)) {
      fail('RESERVED_LAUNCH_ENV');
    }
  }
  for (const [name] of controlPlaneEntries) {
    if (!SERVICE_NAME.test(name) || !isControlPlane(name) || upper(name) === CONTROL_PLANE_PREFIX) {
      fail('INVALID_CONTROL_PLANE_ENV');
    }
  }

  // Sort inherited names so aliases have a stable winner even if a caller builds
  // the map in another insertion order. Service values replace all such aliases.
  const inherited = Object.create(null);
  inheritedEntries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  for (const [name, value] of inheritedEntries) if (!isControlPlane(name)) replace(inherited, name, value);
  const service = Object.fromEntries(serviceEntries);
  let result;
  if (httpPlan === null) {
    result = clearInheritedMcpOverrides(inherited);
    for (const [name, value] of serviceEntries) replace(result, name, value);
  } else {
    validateHttpPlan(httpPlan);
    // mergeHttpLaunchEnvironment performs the one inherited MCP scrub, installs
    // service values, and then restores only this selected HTTP plan's variables.
    result = mergeHttpLaunchEnvironment(inherited, service, httpPlan);
  }
  for (const [name, value] of controlPlaneEntries) replace(result, upper(name), value);
  return Object.freeze(result);
}

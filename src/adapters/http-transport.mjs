import {createHash} from 'node:crypto';
import {isMcpServiceId} from '../core/mcp-registry-policy.mjs';

export const HTTP_HEADER_ENV_PREFIX = 'TUNNEL_CLIENT_MCP_HEADER_';
const OWNED_ENV = new Set(['MCP_SERVER_URL', 'MCP_COMMAND', 'MCP_EXTRA_HEADERS', 'MCP_DISCOVERY_EXTRA_HEADERS']);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const record = value => value!==null && typeof value==='object' &&
  [Object.prototype,null].includes(Object.getPrototypeOf(value));
const fail = code => { throw new HttpTransportFault(code); };
export class HttpTransportFault extends Error {
  constructor(code) { super(code); this.code=code; this.status=400; }
}
function contextKey(context) {
  if (!isMcpServiceId(context?.serviceId) || typeof context.operationId!=='string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(context.operationId)) fail('INVALID_HTTP_CONTEXT');
  return [context.serviceId,context.operationId];
}
function endpoint(value) {
  if (typeof value!=='string' || !value.trim() || /[\x00-\x20\x7f]/.test(value)) fail('INVALID_HTTP_URL');
  let url;
  try { url=new URL(value); } catch { fail('INVALID_HTTP_URL'); }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.hash ||
      !url.hostname || url.href.length>8192) fail('INVALID_HTTP_URL');
  // Preserve signed path/query bytes; URL validation must not canonicalize them.
  return value;
}
function headerValue(entry) {
  const value = typeof entry==='string'?entry:entry?.value;
  if (typeof value!=='string' || /[\x00-\x08\x0a-\x1f\x7f]/.test(value) || !value.trim()) {
    fail('INVALID_HTTP_HEADER_VALUE');
  }
  return value.trim();
}
function envName(name,context) {
  return HTTP_HEADER_ENV_PREFIX+createHash('sha256').update(JSON.stringify([
    ...contextKey(context),name.toLowerCase()
  ])).digest('hex').slice(0,24).toUpperCase();
}
const controlled = name => OWNED_ENV.has(name.toUpperCase()) ||
  name.toUpperCase().startsWith(HTTP_HEADER_ENV_PREFIX);

// 0.0.19 accepts an unqualified HTTP URL in MCP_SERVER_URL, defaulting to main.
// This avoids qualified-entry comma splitting and keeps signed URL queries out
// of argv/YAML. Extra header CLI values contain references, never their values.
export function compileHttpTransport(binding,context) {
  contextKey(context);
  if (binding?.type!=='http') fail('HTTP_BINDING_REQUIRED');
  const headers=binding.headers??{};
  if (!record(headers)) fail('INVALID_HTTP_HEADERS');
  const entries=Object.entries(headers);
  if (entries.length>64) fail('TOO_MANY_HTTP_HEADERS');
  const seen=new Set();
  for (const [name] of entries) {
    if (!HEADER_NAME.test(name)) fail('INVALID_HTTP_HEADER_NAME');
    const key=name.toLowerCase();
    if (seen.has(key)) fail('DUPLICATE_HTTP_HEADER');
    seen.add(key);
  }
  entries.sort(([a],[b])=>a.toLowerCase()<b.toLowerCase()?-1:a.toLowerCase()>b.toLowerCase()?1:0);
  const environment=Object.create(null),args=[],headerNames=[];
  environment.MCP_SERVER_URL=endpoint(binding.url);
  for (const [name,entry] of entries) {
    const variable=envName(name,context);
    environment[variable]=headerValue(entry);
    args.push('--mcp.extra-headers',`${name}: env:${variable}`);
    headerNames.push(name);
  }
  if (Object.entries(environment).reduce((n,[k,v])=>n+k.length+v.length+2,1)>16384) fail('HTTP_ENV_TOO_LARGE');
  return Object.freeze({kind:'http',channel:'main',args:Object.freeze(args),
    headerNames:Object.freeze(headerNames),privateEnvironment:Object.freeze(environment)});
}

export function clearInheritedMcpOverrides(inherited={}) {
  if (!inherited || typeof inherited!=='object' || Array.isArray(inherited)) fail('INVALID_HTTP_ENV');
  const result=Object.create(null);
  for (const [name,value] of Object.entries(inherited)) {
    if (!controlled(name) && typeof value==='string') result[name]=value;
  }
  return result;
}
export function mergeHttpLaunchEnvironment(inherited={},serviceEnvironment={},plan) {
  if (plan?.kind!=='http' || !plan.privateEnvironment) fail('INVALID_HTTP_PLAN');
  if (!record(serviceEnvironment)) fail('INVALID_HTTP_ENV');
  const result=clearInheritedMcpOverrides(inherited);
  for (const [name,value] of Object.entries(serviceEnvironment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || controlled(name) ||
        ['__PROTO__','CONSTRUCTOR','PROTOTYPE'].includes(name.toUpperCase())) fail('RESERVED_HTTP_ENV');
    if (typeof value!=='string' || value.includes('\0')) fail('INVALID_HTTP_ENV_VALUE');
    for (const old of Object.keys(result)) if (old.toUpperCase()===name.toUpperCase()) delete result[old];
    result[name]=value;
  }
  for (const [name,value] of Object.entries(plan.privateEnvironment)) {
    if (name!=='MCP_SERVER_URL' && !name.startsWith(HTTP_HEADER_ENV_PREFIX)) fail('INVALID_HTTP_PLAN');
    result[name]=value;
  }
  return result;
}

const aad = context => JSON.stringify(['mcp-http-transport-v1',...contextKey(context)]);
export async function sealHttpTransport(vault,binding,context) {
  if (typeof vault?.seal!=='function') fail('HTTP_VAULT_REQUIRED');
  const plan=compileHttpTransport(binding,context);
  return {version:1,serviceId:context.serviceId,operationId:context.operationId,
    headerNames:[...plan.headerNames],
    environmentEnvelope:await vault.seal({...plan.privateEnvironment},aad(context))};
}
export async function openHttpTransport(vault,packet,context) {
  contextKey(context);
  if (typeof vault?.unseal!=='function') fail('HTTP_VAULT_REQUIRED');
  if (packet?.version!==1 ||
      packet.serviceId!==context.serviceId || packet.operationId!==context.operationId ||
      !Array.isArray(packet.headerNames) || packet.headerNames.length>64 ||
      packet.headerNames.some(name=>typeof name!=='string' || !HEADER_NAME.test(name))) fail('INVALID_HTTP_STATE');
  if (new Set(packet.headerNames.map(name=>name.toLowerCase())).size!==packet.headerNames.length) fail('INVALID_HTTP_STATE');
  let environment;
  try { environment=await vault.unseal(packet.environmentEnvelope,aad(context)); }
  catch { fail('HTTP_STATE_UNREADABLE'); }
  if (!environment || typeof environment!=='object' || Array.isArray(environment)) fail('INVALID_HTTP_STATE');
  const headers=Object.create(null),expected=new Set(['MCP_SERVER_URL']);
  for (const name of packet.headerNames) {
    const variable=envName(name,context);
    expected.add(variable);
    headers[name]={value:environment[variable]};
  }
  if (Object.keys(environment).length!==expected.size || Object.keys(environment).some(k=>!expected.has(k))) {
    fail('INVALID_HTTP_STATE');
  }
  const plan=compileHttpTransport({type:'http',url:environment.MCP_SERVER_URL,headers},context);
  if (Object.entries(plan.privateEnvironment).some(([k,v])=>v!==environment[k])) fail('INVALID_HTTP_STATE');
  return plan;
}

// Bind verification to both the public profile and the immutable ciphertext.
// Length framing prevents ambiguous concatenations; no secret values are hashed
// or exposed directly, because packetBytes must be the sealed packet on disk.
export function fingerprintHttpConfiguration(profileBytes,packetBytes) {
  const bytes=(value,limit)=>{
    if (typeof value!=='string' && !(value instanceof Uint8Array)) fail('INVALID_HTTP_CONFIG_BYTES');
    const data=Buffer.from(value);
    if (!data.length || data.length>limit) fail('INVALID_HTTP_CONFIG_BYTES');
    return data;
  };
  const profile=bytes(profileBytes,1048576),packet=bytes(packetBytes,262144);
  const hash=createHash('sha256').update('mcp-http-configuration-v1\0');
  for (const data of [profile,packet]) {
    const length=Buffer.alloc(8);length.writeBigUInt64BE(BigInt(data.length));
    hash.update(length).update(data);
  }
  return hash.digest('hex');
}

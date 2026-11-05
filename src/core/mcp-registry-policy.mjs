import {createHash} from 'node:crypto';

export const LEGACY_SERVICES = Object.freeze([
  Object.freeze({id:'overleaf-mcp', enabled:true, sortOrder:100}),
  Object.freeze({id:'antigravity-mcp', enabled:true, sortOrder:1000, controlCarrier:true})
]);
export class RegistryPolicyFault extends Error {
  constructor(code, status=400) { super(code); this.code=code; this.status=status; }
}
const reject=(code,status=400)=>{throw new RegistryPolicyFault(code,status);};
export function isMcpServiceId(id) {
  return typeof id==='string' && (LEGACY_SERVICES.some(s=>s.id===id) ||
    /^mcp_[a-z0-9][a-z0-9_-]{0,63}$/.test(id));
}
export function orderRegisteredTargets(ids, services=LEGACY_SERVICES, {mode='switch'}={}) {
  if (!Array.isArray(ids) || ids.length===0 || ids.length>128 ||
      new Set(ids).size!==ids.length || ids.some(id=>!isMcpServiceId(id))) reject('INVALID_TARGETS');
  if (!['switch','stop'].includes(mode) || !Array.isArray(services)) reject('INVALID_REGISTRY');
  const registered=new Map();
  for(const service of services) {
    if (!isMcpServiceId(service?.id) || registered.has(service.id)) reject('INVALID_REGISTRY');
    registered.set(service.id,service);
  }
  const selected=ids.map(id=>{
    const service=registered.get(id);
    if (!service || service.deletedAt || service.deleted===true) reject('MCP_NOT_FOUND',404);
    if (mode==='switch' && service.enabled!==true) reject('MCP_DISABLED',409);
    return service;
  });
  const carrier=s=>s.controlCarrier===true || s.id==='antigravity-mcp';
  const rank=s=>Number.isSafeInteger(s.sortOrder)?s.sortOrder:500;
  return selected.sort((a,b)=>Number(carrier(a))-Number(carrier(b)) || rank(a)-rank(b) ||
    (a.id<b.id?-1:a.id>b.id?1:0)).map(s=>s.id);
}
export function pinRegistrySnapshot(ids, {services,revision}, expectedRevision) {
  if (!Number.isSafeInteger(revision) || revision<0 || !Number.isSafeInteger(expectedRevision) ||
      expectedRevision<0) reject('INVALID_REVISION');
  if (revision!==expectedRevision) reject('REVISION_CONFLICT',409);
  const selected=orderRegisteredTargets(ids,services);
  return {revision,services:selected.map(id=>structuredClone(services.find(s=>s.id===id)))};
}
export function removalDecision({service,runtimeState,busy=false}) {
  if (!service || !isMcpServiceId(service.id) || service.deletedAt) reject('MCP_NOT_FOUND',404);
  if (busy) return {allowed:false,code:'MCP_BUSY',requiredAction:'wait'};
  if (runtimeState==='running' || runtimeState==='starting') {
    return {allowed:false,code:'MCP_RUNNING',requiredAction:'stop'};
  }
  if (!['stopped','not_running','never_started'].includes(runtimeState)) {
    return {allowed:false,code:'RUNTIME_STATE_UNKNOWN',requiredAction:'refresh'};
  }
  return {allowed:true,effect:'archive_registration',preserveInstallation:true,preserveSourceFiles:true};
}
export function assertStoppedConnectionReceipt(receipt, operationId, serviceId) {
  if (!isMcpServiceId(serviceId) || receipt?.stopped!==true ||
      receipt.operationId!==operationId || receipt.service!==serviceId ||
      !['verified-owned-process-exit','verified-already-stopped'].includes(receipt.proof?.kind)) {
    reject('STOP_UNCONFIRMED',409);
  }
  if (receipt.proof.kind==='verified-owned-process-exit' &&
      (!Number.isSafeInteger(receipt.identity?.pid) || receipt.identity.pid<=0 ||
       typeof receipt.identity.startedAt!=='string' || !receipt.identity.startedAt ||
       typeof receipt.identity.executable!=='string' || !receipt.identity.executable)) {
    reject('STOP_UNCONFIRMED',409);
  }
  return true;
}
const RESERVED_ENV=/^(?:CONTROL_PLANE_|TUNNEL_CLIENT_|HEALTH_)/i;
const RESERVED_EXACT=new Set(['TUNNEL_ID','MCP_COMMAND','MCP_SERVER_URL','__PROTO__','CONSTRUCTOR','PROTOTYPE']);
const sensitiveName=name=>/KEY|TOKEN|SECRET|PASS|AUTH|COOKIE|CREDENTIAL/i.test(name);
export function mergeEnvironmentPatch(previous={},patch=[]) {
  if (!Array.isArray(patch) || patch.length>128) reject('INVALID_ENV_PATCH');
  const result=Object.create(null),seen=new Set();
  for(const [name,entry] of Object.entries(previous)) result[name]={...entry};
  for(const item of patch) {
    const name=item?.name;
    if (typeof name!=='string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) reject('INVALID_ENV_NAME');
    const upper=name.toUpperCase();
    if (RESERVED_ENV.test(name) || RESERVED_EXACT.has(upper)) reject('RESERVED_ENV_NAME');
    if (seen.has(upper)) reject('DUPLICATE_ENV_NAME');
    seen.add(upper);
    const oldName=Object.keys(result).find(k=>k.toUpperCase()===upper);
    if (item.op==='remove') { if(oldName)delete result[oldName]; continue; }
    if (item.op!=='set' || typeof item.value!=='string' || item.value.length>32768 ||
        item.value.includes('\0')) reject('INVALID_ENV_VALUE');
    if (oldName && oldName!==name) delete result[oldName];
    // New env values default to secret; known sensitive names cannot be unmasked.
    result[name]={value:item.value,secret:sensitiveName(name) || item.secret!==false};
  }
  return result;
}
export function publicEnvironment(environment={}) {
  return Object.entries(environment).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([name,entry])=>{
    const secret=sensitiveName(name) || entry.secret!==false;
    return secret?{name,secret:true,configured:true}:{name,secret:false,configured:true,value:entry.value};
  });
}
export function discoveryIdentity({serviceId,canonicalPath,selector=''}) {
  if (!isMcpServiceId(serviceId) || typeof canonicalPath!=='string' || canonicalPath.length===0 ||
      canonicalPath.includes('\0') || typeof selector!=='string') reject('INVALID_SOURCE_DESCRIPTOR');
  // Caller resolves filesystem realpath first. Never hash API-key values into identity.
  const path=/^[a-z]:[\\/]/i.test(canonicalPath)
    ?canonicalPath.replaceAll('\\','/').toLowerCase():canonicalPath;
  return 'source_'+createHash('sha256').update(JSON.stringify([serviceId,path,selector])).digest('hex');
}

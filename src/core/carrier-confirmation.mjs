import path from 'node:path';
import { randomUUID } from 'node:crypto';

const AAD = 'mcp-tunnel-carrier-confirmation-v2';
const fail = code => { const e = new Error(code); e.code = code; throw e; };

function text(value) {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\u0000-\u001f]/u.test(value)) {
    fail('INVALID_CARRIER_CONFIRMATION_CONTEXT');
  }
  return value;
}

function identity(ctx) {
  if (ctx.identity == null) {
    if (ctx.absenceVerified !== true) fail('PROCESS_IDENTITY_UNVERIFIED');
    return null;
  }
  const i = ctx.identity;
  const pid = i.pid;
  const date = Date.parse(i.startedAt);
  if (i.verified !== true || !Number.isInteger(pid) || pid <= 0 ||
      !Number.isFinite(date) || typeof i.executablePath !== 'string' ||
      !path.win32.isAbsolute(i.executablePath)) fail('PROCESS_IDENTITY_UNVERIFIED');
  return { pid, startedAt: new Date(date).toISOString(),
    executablePath: path.win32.normalize(i.executablePath).toLowerCase() };
}

function claims(ctx) {
  if (!['stop', 'restart'].includes(ctx.action)) fail('INVALID_CARRIER_ACTION');
  if (!Number.isSafeInteger(ctx.serviceRevision) || ctx.serviceRevision < 1) {
    fail('INVALID_CARRIER_CONFIRMATION_CONTEXT');
  }
  return {
    serviceId: text(ctx.serviceId),
    action: ctx.action,
    serviceRevision: ctx.serviceRevision,
    profileId: ctx.profileId == null ? null : text(ctx.profileId),
    sessionBinding: text(ctx.sessionBinding),
    idempotencyKey: text(ctx.idempotencyKey),
    identity: identity(ctx)
  };
}

export async function issueCarrierConfirmation(vault, ctx, nowMs = Date.now()) {
  if (typeof vault?.seal !== 'function' || typeof vault?.unseal !== 'function') {
    fail('CARRIER_CONFIRMATION_UNAVAILABLE');
  }
  const bound = claims(ctx);
  return await vault.seal({ v: 2, ...bound, nonce: randomUUID(),
    issuedAt: nowMs, expiresAt: nowMs + 120000 }, AAD);
}

export async function verifyCarrierConfirmation(vault, token, ctx, nowMs = Date.now()) {
  if (typeof vault?.unseal !== 'function') return false;
  try {
    const expected = claims(ctx);
    const actual = await vault.unseal(token, AAD);
    if (!actual || actual.v !== 2 || typeof actual.nonce !== 'string' ||
        !Number.isFinite(actual.issuedAt) || !Number.isFinite(actual.expiresAt) ||
        actual.issuedAt > nowMs + 5000 || actual.expiresAt <= nowMs ||
        actual.expiresAt - actual.issuedAt > 120000 || actual.expiresAt < actual.issuedAt) return false;
    for (const k of ['serviceId', 'action', 'serviceRevision', 'profileId', 'sessionBinding', 'idempotencyKey']) {
      if (actual[k] !== expected[k]) return false;
    }
    const a = actual.identity;
    const b = expected.identity;
    if (a === null || b === null) return a === null && b === null;
    return !!a && !!b && !Array.isArray(a) && typeof a === 'object' &&
      a.pid === b.pid && a.startedAt === b.startedAt && a.executablePath === b.executablePath;
  } catch { return false; }
}

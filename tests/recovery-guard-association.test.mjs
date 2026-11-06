import assert from 'node:assert/strict';
import test from 'node:test';
import { decideRecoveryAcknowledgement } from '../src/core/recovery-acknowledgement.mjs';
import { createDefaultProcessController } from '../src/adapters/index.mjs';

test('recovery guard: mismatched gate action ID denies', () => {
  const result = decideRecoveryAcknowledgement({
    action: { id: 'act_1', state: 'NEEDS_ATTENTION', errorCode: 'NOT_FOUND' },
    gateActionId: 'act_2',
    evidence: { phase: 'VALIDATING', mayMutate: false, intentWritten: false, processEffectObserved: false, configChanged: false, rollbackUncertain: false },
    otherAttentionIds: ['act_2']
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'RECOVERY_SCOPE_MISMATCH');
});

test('recovery guard: unknown effects denies', () => {
  const result = decideRecoveryAcknowledgement({
    action: { id: 'act_1', state: 'NEEDS_ATTENTION', errorCode: 'NOT_FOUND' },
    gateActionId: 'act_1',
    evidence: { phase: 'VALIDATING', mayMutate: true, intentWritten: false, processEffectObserved: false, configChanged: false, rollbackUncertain: false },
    otherAttentionIds: ['act_1']
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'RECOVERY_EFFECTS_UNVERIFIED');
});

test('recovery guard: other blockers retain gate', () => {
  const result = decideRecoveryAcknowledgement({
    action: { id: 'act_1', state: 'NEEDS_ATTENTION', errorCode: 'NOT_FOUND' },
    gateActionId: 'act_1',
    evidence: { phase: 'VALIDATING', mayMutate: false, intentWritten: false, processEffectObserved: false, configChanged: false, rollbackUncertain: false },
    otherAttentionIds: ['act_1', 'act_other']
  });
  assert.equal(result.allowed, true);
  assert.equal(result.code, 'ACTION_ACKNOWLEDGED_GATE_RETAINED');
  assert.equal(result.clearGate, false);
  assert.deepEqual(result.remainingAttentionIds, ['act_other']);
});

test('recovery guard: zero-effect eligible acknowledges and clears gate', () => {
  const result = decideRecoveryAcknowledgement({
    action: { id: 'act_1', state: 'NEEDS_ATTENTION', errorCode: 'NOT_FOUND' },
    gateActionId: 'act_1',
    evidence: { phase: 'VALIDATING', mayMutate: false, intentWritten: false, processEffectObserved: false, configChanged: false, rollbackUncertain: false },
    otherAttentionIds: ['act_1']
  });
  assert.equal(result.allowed, true);
  assert.equal(result.code, 'ZERO_EFFECT_ACTION_ACKNOWLEDGED');
  assert.equal(result.clearGate, true);
  assert.deepEqual(result.remainingAttentionIds, []);
});

test('process controller: same-exe different-profile mapping isolates services', async () => {
  const executedCalls = [];
  const fakeController = createDefaultProcessController({
    dataDir: 'C:\\fake\\data',
    runtimeCommand: async (action, params) => {
      executedCalls.push({ action, params });
      if (action === 'FindOwned') {
        if (params.Tag === 'antigravity-local') {
          return { data: { running: true, pid: 35812, executablePath: params.ExpectedExecutablePath } };
        }
        return { data: { running: false, error: 'NOT_FOUND' } };
      }
      return { data: {} };
    },
    paths: { tunnelClientBin: 'C:\\fake\\tunnel-client.exe' }
  });

  // Antigravity inspect finds PID 35812
  const agRes = await fakeController.inspect('antigravity-mcp', { executablePath: 'C:\\fake\\tunnel-client.exe' });
  assert.equal(agRes.running, true);
  assert.equal(agRes.pid, 35812);

  // Overleaf inspect does NOT associate PID 35812
  const olRes = await fakeController.inspect('overleaf-mcp', { executablePath: 'C:\\fake\\tunnel-client.exe' });
  assert.equal(olRes.running, false);
  assert.notEqual(olRes.pid, 35812);

  // Unrelated service without identity does not associate
  const unkRes = await fakeController.inspect('unrelated-mcp', { executablePath: 'C:\\fake\\tunnel-client.exe' });
  assert.equal(unkRes.running, false);
  assert.notEqual(unkRes.pid, 35812);
});

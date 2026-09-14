import assert from 'node:assert/strict';
import test from 'node:test';
import { FEATURE_COUNT, NEURAL_WINDOW_MS } from './neural-adapter.ts';
import { calibrate, type Head } from './neural-calibration.ts';
import type { NeuralFrame, RuntimePort } from './neural-adapter.ts';

test('offline calibration copies measured rates, then validates after shuffled replay', async () => {
  let calls = 0;
  const runtime: RuntimePort = {
    advance(input, milliseconds) {
      calls++;
      assert.equal(milliseconds, NEURAL_WINDOW_MS);
      const rates = new Float32Array(FEATURE_COUNT).fill(12);
      rates[0] = input[0]; rates[1] = input[4];
      return { tick: calls, simulatedMs: milliseconds, spikes: Uint32Array.of(1), rates, levels: new Float32Array(1),
        totalSpikes: 1, silenced: false } satisfies NeuralFrame;
    },
    reset() {}, silence() {}, dispose() {},
  };
  const result = await calibrate(() => runtime, 7193, () => {}, () => false);
  assert.equal(result.report.trainingTrials, 192);
  assert.equal(result.report.validationTrials, 48);
  assert.equal(result.report.windowsMs, NEURAL_WINDOW_MS);
  assert.ok(calls >= 240);
  for (const head of ['movement', 'handling', 'swing', 'aim'] as Head[]) {
    assert.ok(result.report.heads[head].updates > 0, head);
    assert.ok(result.weights[head].updates > 192);
  }
  assert.ok(result.report.heads.movement.samples > 0);
});

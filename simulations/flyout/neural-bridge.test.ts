import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NeuralBridge } from './neural-bridge.ts';
import { ACTOR_COUNT, neutralCommand, type NeuralFrame } from './neural-adapter.ts';

test('bridge snapshots detach applied actions, decision traces, actor commands and calibration', () => {
  // Exercise the actual recording/snapshot methods without starting a browser worker.
  const bridge = Object.create(NeuralBridge.prototype) as NeuralBridge;
  const command = { ...neutralCommand('neural', 10), x: 1 };
  const frame: NeuralFrame = { tick: 10, simulatedMs: 2, spikes: Uint32Array.of(4),
    rates: Float32Array.from({ length: 128 }, (_, i) => i), levels: new Float32Array(139662), totalSpikes: 1, silenced: false };
  Object.assign(bridge, { state: 'ready', applied: Array(ACTOR_COUNT).fill(undefined), decisions: [], decisionCount: 0,
    frame: () => frame, command: () => command,
    calibration: { source: 'offline scripted observations / real neural responses', trainingTrials: 1, validationTrials: 1,
      windowsMs: 2, heads: { movement: { samples: 1, correct: 1, loss: 0, accuracy: 1, updates: 1 } } } });
  bridge.recordApplied(0, ['movement']);
  const expected = bridge.snapshot(), exposed = bridge.snapshot();
  exposed.decisions[0].heads.push('handling');
  exposed.decisions[0].rates[0] = 999;
  exposed.decisions[0].command.x = -99;
  exposed.decisions[0].sequence = 999;
  assert.deepEqual(exposed.applied, expected.applied, 'Separate snapshot branches do not alias each other');
  exposed.applied[0].heads.length = 0;
  exposed.applied[0].rates.fill(-1);
  exposed.applied[0].command.swing = true;
  exposed.actors[0].command.z = 999;
  exposed.calibration!.heads.movement.accuracy = -1;
  exposed.applied.length = 0; exposed.decisions.length = 0;
  assert.deepEqual(bridge.snapshot(), expected, 'Mutating telemetry cannot rewrite retained evidence');
  assert.equal(bridge.command(0).x, 1); assert.equal(bridge.command(0).swing, false);
  bridge.recordApplied(0, ['handling']);
  assert.deepEqual(expected.decisions[0].heads, ['movement'], 'Later internal updates cannot mutate prior snapshots');
  assert.deepEqual(bridge.snapshot().decisions[0].heads, ['movement', 'handling']);
});

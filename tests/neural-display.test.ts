import assert from "node:assert/strict";
import test from "node:test";
import { copyNeuralLevels, type NeuralDisplayFrame } from "../src/neural/display.ts";

const frame = (levels: number[]): NeuralDisplayFrame => ({ tick: 100, simulatedMs: 20, levels: Float32Array.from(levels), spikes: new Uint32Array([1]), rates: new Float32Array(128), totalSpikes: 1, silenced: false });

test("neural display copies actual state without invented drive, diffusion, or temporal smoothing", () => {
  const target = new Float32Array(4), input = frame([0, .2, .5, 1]);
  const metrics = copyNeuralLevels(target, input);
  assert.deepEqual(target, input.levels);
  assert.equal(metrics.active, 3);
  assert.ok(Math.abs(metrics.energy - .425) < 1e-7);
  input.levels.fill(0);
  assert.ok(target[3] === 1, "Display retains its own frame, not a borrowed mutable pointer");
  copyNeuralLevels(target, input);
  assert.deepEqual(target, new Float32Array(4));
});

test("invalid neural telemetry is rejected before changing displayed activity", () => {
  const target = Float32Array.from([.1, .2]);
  for (const input of [frame([1]), frame([0, NaN]), frame([1, 2]), frame([-2, 0]), { ...frame([0, 0]), tick: -1 }]) {
    assert.throws(() => copyNeuralLevels(target, input));
    assert.deepEqual(target, Float32Array.from([.1, .2]));
  }
});

test("inhibitory voltage is preserved, not replaced by invented positive activation", () => {
  const target = new Float32Array(2);
  const metrics = copyNeuralLevels(target, frame([-.5, .25]));
  assert.deepEqual(target, Float32Array.from([-.5, .25]));
  assert.equal(metrics.energy, .375); assert.equal(metrics.active, 2);
});

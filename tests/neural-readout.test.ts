import assert from "node:assert/strict";
import test from "node:test";
import { NeuralReadout, type ReadoutFrame } from "../src/neural/policy.ts";

const frame = (rates = [20, 0, 40, 3]): ReadoutFrame => ({ rates: Float32Array.from(rates), tick: 50, simulatedMs: 10, silenced: false });
const create = (seed = 17) => new NeuralReadout({ actions: ["Hit", "Stand", "Double", "Split"], modelId: "fixture-only", features: 4, seed });

test("silencing or zero recorded neural rates emits no autonomous action", () => {
  const readout = create();
  assert.equal(readout.decide(frame([0, 0, 0, 0])), null);
  assert.equal(readout.decide({ ...frame(), silenced: true }), null);
  assert.equal(readout.scores({ ...frame(), silenced: true }), null);
  assert.throws(() => readout.decide(frame([NaN, 0, 0, 0])));
  assert.throws(() => readout.decide(frame([20, -1, 0, 0])));
  assert.throws(() => readout.decide(frame([20])));
});

test("legal-action masks and seeded sampling constrain every selected command", () => {
  const first = create(), second = create();
  for (let index = 0; index < 100; index++) {
    const a = first.decide(frame(), [0, 1])!, b = second.decide(frame(), [0, 1])!;
    assert.equal(a.index, b.index);
    assert.ok(a.index === 0 || a.index === 1);
    assert.equal(a.probabilities[2], 0); assert.equal(a.probabilities[3], 0);
    assert.ok(Math.abs(a.probabilities.reduce((sum, value) => sum + value, 0) - 1) < 1e-6);
    assert.equal(a.tick, 50); assert.equal(a.simulatedMs, 10);
  }
  for (const allowed of [[], [-1], [4], [1, 1]]) assert.throws(() => first.decide(frame(), allowed));
});

test("reward changes the selected action's relative logit using an immutable recorded trace", () => {
  const readout = create();
  const input = frame(), decision = readout.decide(input)!;
  const before = readout.scores(frame())!;
  (input.rates as Float32Array).fill(0);
  decision.features.fill(0); decision.probabilities.fill(0);
  assert.equal(readout.reinforce([decision], 1), true);
  const after = readout.scores(frame())!;
  assert.ok(after[decision.index] > before[decision.index]);
  assert.equal(readout.episodes, 1); assert.equal(readout.totalReward, 1);
  assert.equal(readout.updates, 1);
  assert.throws(() => readout.reinforce([decision], 1));
  assert.throws(() => readout.reinforce([create().decide(frame())!], 1));
});

test("loss feedback lowers the chosen score; empty or deterministic episodes are not called learning", () => {
  const readout = create();
  const decision = readout.decide(frame())!, before = readout.scores(frame())!;
  readout.reinforce([decision], -1);
  assert.ok(readout.scores(frame())![decision.index] < before[decision.index]);
  const updates = readout.updates;
  assert.equal(readout.reinforce([], 1), false);
  assert.equal(readout.updates, updates);
  assert.throws(() => readout.reinforce([readout.decide(frame(), undefined, { sample: false })!], 1));
  assert.throws(() => readout.reinforce([readout.decide(frame())!], NaN));
});

test("calibration uses observed neural features and does not fabricate activity for a silent model", () => {
  const readout = create();
  const quiet = frame([0, 0, 0, 0]);
  assert.equal(readout.teach(quiet, 0), 0); assert.equal(readout.updates, 0);
  for (let step = 0; step < 400; step++) {
    readout.teach(frame([80, 0, 0, 0]), 0, .2);
    readout.teach(frame([0, 80, 0, 0]), 1, .2);
  }
  assert.equal(readout.decide(frame([60, 0, 0, 0]), undefined, { sample: false })!.index, 0);
  assert.equal(readout.decide(frame([0, 60, 0, 0]), undefined, { sample: false })!.index, 1);
  assert.equal(readout.decide(quiet), null);
});

test("saved readouts are bounded and tied to their graph, dimensions, and action ordering", () => {
  const trained = create();
  trained.reinforce([trained.decide(frame())!], 1.5);
  const saved = trained.export(), restored = create();
  assert.equal(restored.restore(JSON.parse(JSON.stringify(saved))), true);
  assert.deepEqual(restored.export(), saved);
  assert.deepEqual(restored.scores(frame()), trained.scores(frame()));
  assert.equal(restored.restore({ ...saved, modelId: "other-connectome" }), false);
  assert.equal(restored.restore({ ...saved, actions: [...saved.actions].reverse() }), false);
  assert.equal(restored.restore({ ...saved, weights: [Infinity, ...saved.weights.slice(1)] }), false);
  assert.equal(restored.restore({ ...saved, episodes: -1 }), false);
  assert.equal(restored.restore({ ...saved, unexpected: "not a readout field" }), false);
  assert.equal(restored.restore(null), false);
  assert.deepEqual(restored.export(), saved);
});

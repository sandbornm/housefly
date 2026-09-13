import test from "node:test";
import assert from "node:assert/strict";
import { PianoDualDecoder, dualTeacherTargets, DUAL_REPLAY_BYTES } from "./neural-dual.ts";
import { NeuralReadout } from "../../src/neural/policy.ts";
import { PianoNeuralDecoder } from "./neural-model.ts";
import { scoreTargets } from "./sensory.ts";

const frame = (tick = 100) => ({ rates: new Float32Array(128).fill(20), tick, simulatedMs: tick / 5, silenced: false });
test("separate neural strike edges permit repeated same pitches without clocks or score gates", () => {
  let gate = 0, pitch = "73";
  const decoder = new PianoDualDecoder(({ modelId }) => ({ updates: 0, teach() {}, decide: current => ({ index: /-strike-[LR][123]$/.test(modelId) ? gate : 0,
    action: /-strike-[LR][123]$/.test(modelId) ? gate ? "strike" : "hold" : pitch, tick: current.tick }) }), "test");
  assert.equal(decoder.predict(frame()).length, 0);
  gate = 1; assert.equal(decoder.predict(frame(200)).length, 6);
  pitch = "76"; assert.equal(decoder.predict(frame(100000)).length, 0, "A changing pitch is not itself a strike");
  gate = 0; assert.equal(decoder.predict(frame(100100)).length, 0);
  gate = 1; assert.ok(decoder.predict(frame(100200)).every(command => command.midi === 76 && command.requestedNoteIndex === null));
  assert.equal(decoder.predict({ ...frame(100300), silenced: true }).length, 0);
  assert.equal(decoder.predict({ ...frame(100400), rates: new Float32Array(128) }).length, 0);
});

test("teacher windows are feedback only; learning follows an actual prediction and replay is bounded", () => {
  const source = frame(); let copies = 0;
  const decoder = new PianoDualDecoder(({ actions }) => ({ updates: 0, decide: current => ({ index: 0, action: actions[0], tick: current.tick }), teach(current) {
    if (current !== source) { copies++; assert.deepEqual(Object.keys(current).sort(), ["rates", "silenced", "simulatedMs", "tick"]); assert.notEqual(current.rates, source.rates); }
  } }), "test");
  assert.throws(() => decoder.learn(source, new Array(12).fill(0)));
  for (let tick = 0; tick < 1200; tick++) {
    const beat = (tick * 0.02) % 12, labels = dualTeacherTargets(scoreTargets(beat, false), beat, 96);
    assert.ok(labels.every(label => label === null || Number.isInteger(label) && label >= 0 && label <= 7));
    assert.equal(decoder.predict(source).length, 0); decoder.learn(source, labels);
  }
  assert.ok(copies > 1000); assert.ok(decoder.snapshot().replayRateBytes <= DUAL_REPLAY_BYTES);
  assert.deepEqual(dualTeacherTargets(new Array(6).fill(null), 0, 96), [null, 0, null, 0, null, 0, null, 0, null, 0, null, 0]);
});

test("dual readouts cannot restore single-head or different-encoder memories", () => {
  const dual = new PianoDualDecoder(options => new NeuralReadout(options), "associated-test");
  const joint = new PianoNeuralDecoder(options => new NeuralReadout(options), "v2");
  assert.equal(dual.restore(joint.export()), false); const saved = dual.export();
  assert.equal(dual.restore({ ...saved, encoder: "different" }), false); assert.equal(dual.restore(saved), true);
});

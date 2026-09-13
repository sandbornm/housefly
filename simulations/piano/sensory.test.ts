import assert from "node:assert/strict";
import test from "node:test";
import { encodePianoV1, encodePianoV2, scoreTargets, projectPianoChannels } from "./sensory.ts";
import type { SensoryTarget } from "./sensory.ts";
import { LEGS } from "./performance.ts";
import { LEG_RANGES } from "./actuator.ts";
import { PianoNeuralDecoder } from "./neural-model.ts";
import { NeuralReadout } from "../../src/neural/policy.ts";

const proprio = LEGS.map(() => ({ contact: false, busy: false, press: 0 }));
const note = (midi: number): SensoryTarget => ({ midi, beat: 1, duration: 0.44, writtenDuration: 0.5, velocity: 0.5, hand: "left", noteIndex: 0 });
const frame = { rates: new Float32Array(128).fill(20), tick: 100, simulatedMs: 20, silenced: false,
  levels: new Float32Array(0), counts: new Uint16Array(0), spikes: new Uint32Array([1]), totalSpikes: 1 };

test("v2 distinguishes the F3/A2 versus A3/F2 octave and limb association collision in v1", () => {
  const a = [note(53), null, note(45), null, null, null], b = [note(57), null, note(41), null, null, null];
  assert.deepEqual(encodePianoV1(a, 1, proprio), encodePianoV1(b, 1, proprio));
  assert.notDeepEqual(encodePianoV2(a, 1, 96, proprio), encodePianoV2(b, 1, 96, proprio));
  const first = encodePianoV2(a, 1, 96, proprio), second = encodePianoV2(b, 1, 96, proprio);
  assert.notDeepEqual(first.slice(0, 2), second.slice(0, 2));
  assert.notDeepEqual(first.slice(8, 10), second.slice(8, 10));
});

test("each physical pitch and limb has a distinct tuple with an active gate; rests have no tuple drive", () => {
  const identities = new Set<string>();
  for (const [index, leg] of LEGS.entries()) {
    const [low, high] = LEG_RANGES[leg.id];
    for (let midi = low; midi <= high; midi++) {
      const targets = LEGS.map((_, i) => i === index ? note(midi) : null);
      const input = encodePianoV2(targets, 1, 96, proprio);
      assert.ok(Math.abs(input[index * 4] + input[index * 4 + 1] - 170) < 0.00002);
      identities.add(Array.from(input).join(","));
    }
  }
  assert.equal(identities.size, 37);
  assert.ok(encodePianoV2(LEGS.map(() => null), 0, 96, proprio).every(rate => rate === 0));
});

test("onset, release, tempo and each limb's actual proprioception remain separate and bounded", () => {
  const targets = [note(53), null, null, null, null, null];
  const before = encodePianoV2(targets, 0.9, 96, proprio), after = encodePianoV2(targets, 1.1, 96, proprio);
  assert.deepEqual(before.slice(0, 2), after.slice(0, 2));
  assert.ok(before[2] > after[2]); assert.ok(before[3] > after[3]);
  assert.notEqual(before[2], encodePianoV2(targets, 0.9, 60, proprio)[2]);
  const moving = proprio.map((limb, index) => ({ ...limb, busy: index === 1, contact: index === 2, press: index === 2 ? 0.5 : 0 }));
  assert.deepEqual(Array.from(encodePianoV2(targets, 1, 96, moving).slice(24, 30)), [0, 40, 115, 0, 0, 0]);
  for (const bpm of [40, 84, 96, 100]) for (let beat = 0; beat <= 12; beat += 0.01) {
    const input = encodePianoV2(scoreTargets(beat, false), beat, bpm, proprio);
    assert.equal(input.length, 32); assert.ok(input.every(rate => Number.isFinite(rate) && rate >= 0 && rate <= 150));
  }
  assert.throws(() => encodePianoV2(targets, NaN, 96, proprio));
  assert.throws(() => encodePianoV2([note(65), null, null, null, null, null], 0, 96, proprio));
});

test("v2 only strikes on decoded pitch/rest edges, not elapsed time or changing score targets", () => {
  let action = "76";
  const decoder = new PianoNeuralDecoder(({ modelId }) => ({ updates: 0, teach() {}, decide: current => modelId.includes("R1")
    ? { index: action === "rest" ? 0 : 4, action, tick: current.tick } : { index: 0, action: "rest", tick: current.tick } }), "v2");
  const first = decoder.predict(frame, scoreTargets(0, true), 0, false);
  assert.deepEqual(first.map(command => command.midi), [76]);
  for (let time = 50; time < 2000; time += 50) assert.equal(decoder.predict(frame, scoreTargets(time / 200, true), time, false).length, 0);
  action = "rest"; assert.equal(decoder.predict(frame, scoreTargets(0, true), 2050, false).length, 0);
  action = "76"; assert.equal(decoder.predict(frame, scoreTargets(6, true), 2100, false).length, 1);
  assert.equal(decoder.predict({ ...frame, silenced: true }, scoreTargets(0, true), 2500, true).length, 0);
  assert.equal(decoder.predict({ ...frame, rates: new Float32Array(128) }, scoreTargets(0, true), 2550, true).length, 0);
});

test("versioned readouts reject v1 weights and restore all six heads atomically", () => {
  const v1 = new PianoNeuralDecoder(options => new NeuralReadout(options), "v1");
  const v2 = new PianoNeuralDecoder(options => new NeuralReadout(options), "v2");
  assert.equal(v2.restore(v1.export()), false);
  const memory = v2.export(); assert.equal(v2.restore(memory), true);
  const damaged = structuredClone(memory); damaged.readouts[5] = v1.export().readouts[5];
  assert.equal(v2.restore(damaged), false); assert.deepEqual(v2.export(), memory);
});

test("input projections are bijective, attenuating and finite, never aliases or motor outputs", () => {
  const profile = { id: "test", channels: Array.from({ length: 32 }, (_, i) => 31 - i), gains: new Array(32).fill(0.5) };
  const logical = Float32Array.from({ length: 32 }, (_, i) => i * 4);
  const projected = projectPianoChannels(logical, profile);
  for (let i = 0; i < 32; i++) assert.equal(projected[31 - i], logical[i] * 0.5);
  assert.throws(() => projectPianoChannels(logical, { ...profile, channels: new Array(32).fill(0) }));
  assert.throws(() => projectPianoChannels(logical, { ...profile, gains: new Array(32).fill(2) }));
});

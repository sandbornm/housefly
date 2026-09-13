import assert from "node:assert/strict";
import test from "node:test";
import { PianoNeuralController, PianoNeuralDecoder, pianoSensory, requestedTargets } from "./neural-model.ts";
import type { PianoNeuralFrame, PianoReadout, ReadoutFactory } from "./neural-model.ts";
import { PianoActuator } from "./actuator.ts";
import { NeuralReadout } from "../../src/neural/policy.ts";

class RuntimeProbe {
  tick = 0; silenced = false; input = new Float32Array(32); enabled = true; feature: number | null = null;
  advance(input: Float32Array, ms: number): PianoNeuralFrame {
    this.input = input.slice(); this.tick += ms;
    const rates = new Float32Array(128).fill(this.enabled && !this.silenced && this.feature === null ? 0.5 : 0);
    if (this.feature !== null && this.enabled && !this.silenced) rates[this.feature] = 30;
    return { tick: this.tick, simulatedMs: this.tick, rates,
      levels: new Float32Array(139662), counts: new Uint16Array(139662), spikes: new Uint32Array(), totalSpikes: this.enabled && !this.silenced ? 1 : 0, silenced: this.silenced };
  }
  reset() { this.tick = 0; }
  silence(value: boolean) { this.silenced = value; }
  snapshot() { return { tick: this.tick, silenced: this.silenced }; }
  dispose() {}
}

test("compact sensory input uses bounded pitch class, octave, limb and proprioception channels", () => {
  const actuator = new PianoActuator(), first = pianoSensory(0, true, actuator), bass = pianoSensory(1.95, true, actuator);
  assert.equal(first.length, 32); assert.equal(first[4], 120); assert.equal(first[15], 110);
  assert.equal(bass[9], 120); assert.equal(bass[12], 110); assert.equal(bass[14], 110);
  for (let beat = 0; beat < 12; beat += 0.01) assert.ok(pianoSensory(beat, true, actuator).every(rate => Number.isFinite(rate) && rate >= 0 && rate <= 150));
});

test("zero neural state and silencing fail closed even if a readout incorrectly proposes a pitch", () => {
  const runtime = new RuntimeProbe(); runtime.enabled = false;
  const factory: ReadoutFactory = ({ actions }) => ({ updates: 0, decide: frame => ({ index: 1, action: actions[1], tick: frame.tick }), teach() { throw Error("Silence must not train"); } });
  const controller = new PianoNeuralController(runtime, factory);
  for (let tick = 0; tick < 100; tick++) controller.update(20, tick * 0.02, 72, true, true);
  assert.equal(controller.snapshot().acceptedCommands, 0); assert.equal(controller.takeContacts().length, 0);
  runtime.enabled = true; controller.silence(true);
  for (let tick = 0; tick < 100; tick++) controller.update(20, tick * 0.02, 72, true, true);
  assert.equal(controller.snapshot().acceptedCommands, 0); assert.equal(controller.takeContacts().length, 0);
});

test("inference sees neural features only, teacher feedback follows prediction, and wrong outputs stay wrong", () => {
  const calls: string[] = [], runtime = new RuntimeProbe();
  const factory: ReadoutFactory = ({ modelId }) => ({ updates: 0,
    decide(frame, allowed, options) {
      assert.equal(frame.rates.length, 128); assert.equal(allowed, undefined); assert.deepEqual(options, { sample: false });
      calls.push(`predict:${modelId}`);
      return { index: modelId.includes("R1") ? 1 : 0, action: modelId.includes("R1") ? "73" : "rest", tick: frame.tick };
    }, teach(_frame, target) { calls.push(`teach:${modelId}:${target}`); this.updates++; },
  } satisfies PianoReadout);
  const controller = new PianoNeuralController(runtime, factory);
  controller.update(20, 0, 72, true, true);
  assert.equal(calls.length, 12);
  for (let index = 0; index < calls.length; index += 2) {
    assert.ok(calls[index].startsWith("predict:")); assert.ok(calls[index + 1].startsWith("teach:"));
  }
  for (let tick = 0; tick < 10; tick++) controller.update(20, tick * 0.024, 72, true, false);
  const contacts = controller.takeContacts();
  assert.ok(contacts.length > 0); assert.ok(contacts.every(note => note.midi === 73));
  assert.ok(controller.snapshot().assessment.wrong > 0);
  assert.equal(calls.filter(call => call.startsWith("teach:")).length, 6, "Performance mode must not train");
});

test("the expected score cannot activate a readout that chooses rest", () => {
  const runtime = new RuntimeProbe();
  const controller = new PianoNeuralController(runtime, ({ actions }) => ({ updates: 0, decide: frame => ({ index: 0, action: actions[0], tick: frame.tick }), teach() {} }));
  for (let tick = 0; tick < 500; tick++) controller.update(20, tick * 12 / 500, 72, true, false);
  assert.ok(controller.snapshot().predictions > 0);
  assert.equal(controller.snapshot().acceptedCommands, 0); assert.equal(controller.actuator.snapshot().totalContacts, 0);
  assert.ok(controller.snapshot().assessment.missed > 40);
  const paused = controller.snapshot(); controller.update(0, 3, 72, true, false);
  assert.deepEqual(controller.snapshot(), paused);
});

test("the shared learned readout changes produced pitches when neural state changes with identical score targets", () => {
  const run = (feature: number) => {
    const runtime = new RuntimeProbe(); runtime.feature = feature;
    const controller = new PianoNeuralController(runtime, options => {
      const readout = new NeuralReadout(options), memory = readout.export(); memory.weights.fill(0);
      const first = options.modelId.includes("R1") ? 1 : 0, second = options.modelId.includes("R1") ? 4 : 0;
      memory.weights[first * 128] = 2; memory.weights[second * 128 + 1] = 2;
      assert.ok(readout.restore(memory)); return readout;
    });
    for (let tick = 0; tick < 12; tick++) controller.update(10, 0, 72, true, false);
    return controller.takeContacts().map(event => event.midi);
  };
  assert.deepEqual(run(0), [73]); assert.deepEqual(run(1), [76]);
});

test("calibration replay retains only bounded copies of the 128 rates and frame metadata", () => {
  const runtime = new RuntimeProbe(), source = runtime.advance(new Float32Array(32), 20);
  let replayed = 0;
  const decoder = new PianoNeuralDecoder(({ actions }) => ({ updates: 0,
    decide: frame => ({ index: 0, action: actions[0], tick: frame.tick }),
    teach(frame) {
      if (frame === source) return;
      replayed++;
      assert.deepEqual(Object.keys(frame).sort(), ["rates", "silenced", "simulatedMs", "tick"]);
      assert.equal(frame.rates.length, 128); assert.notEqual(frame.rates, source.rates);
      assert.equal(frame.rates[0], 0.5);
    },
  }));
  for (let tick = 0; tick < 2000; tick++) decoder.predict(source, requestedTargets(tick * 0.02, true), tick * 20, true);
  assert.ok(replayed > 1000);
  const retained = decoder.snapshot();
  assert.ok(retained.replayFrames <= (37 + 6) * 12);
  assert.equal(retained.replayRateBytes, retained.replayFrames * 128 * 4);
  assert.ok(retained.replayRateBytes <= 264192);
});

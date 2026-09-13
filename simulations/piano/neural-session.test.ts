import assert from "node:assert/strict";
import test from "node:test";
import { PianoNeuralSession } from "./neural-session.ts";
import type { PianoAsyncRuntime } from "./neural-session.ts";
import type { PianoNeuralFrame } from "./neural-model.ts";
import { PianoNeuralDecoder } from "./neural-model.ts";
import { NeuralReadout } from "../../src/neural/policy.ts";
import { PIANO_ENCODER } from "./sensory.ts";
import { validatePianoCalibration } from "./calibration-model.ts";

const flush = () => new Promise(resolve => setImmediate(resolve));
const frame = (tick = 0, active = false, silenced = false): PianoNeuralFrame => ({ tick, simulatedMs: tick * 0.2, silenced,
  rates: new Float32Array(128).fill(active ? 30 : 0), levels: new Float32Array(139662), counts: new Uint16Array(139662),
  spikes: active ? new Uint32Array([1]) : new Uint32Array(), totalSpikes: active ? 1 : 0 });

class DeferredRuntime implements PianoAsyncRuntime {
  graph = { nodeCount: 139662, edgeCount: 5536347, modelId: "test-only" };
  current = frame(); disposed = false;
  pending: { resolve: (frame: PianoNeuralFrame) => void; reject: (error: Error) => void }[] = [];
  async advance(rates: Float32Array, ms: number): Promise<PianoNeuralFrame> {
    assert.equal(rates.length, 32); assert.equal(ms, 20);
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }
  async snapshot() { return this.current; }
  async reset() { this.current = frame(); }
  async silence(enabled: boolean) { this.current = frame(this.current.tick, false, enabled); }
  async dispose() { this.disposed = true; }
}

function candidate() {
  const encoder = `${PIANO_ENCODER}-map-test`;
  const decoder = new PianoNeuralDecoder(options => {
    const head = new NeuralReadout(options), saved = head.export(); saved.weights.fill(0);
    if (options.modelId.includes("R1")) saved.weights[128] = 2;
    assert.ok(head.restore(saved)); return head;
  }, "v2", encoder);
  return { schema: 2, encoder, profile: { id: encoder, channels: Array.from({ length: 32 }, (_, i) => i), gains: new Array(32).fill(1) },
    modelId: "test-only", nodes: 139662, edges: 5536347, neuralStepMs: 20, wallStepMs: 50, weights: decoder.export(),
    provenance: { kind: "offline-balanced", trainingFrames: 638, epochs: 48, trainingSeeds: [931], heldoutSeeds: [8101], improved: false } };
}

test("experimental candidate load checks graph/version/timing and has no target-to-motor shortcut", async () => {
  const runtime = new DeferredRuntime(), data = candidate();
  assert.throws(() => validatePianoCalibration({ ...data, modelId: "wrong-model" }, runtime.graph));
  assert.throws(() => validatePianoCalibration({ ...data, nodes: 100 }, runtime.graph));
  assert.throws(() => validatePianoCalibration({ ...data, neuralStepMs: 100 }, runtime.graph));
  const session = new PianoNeuralSession(async () => runtime, error => { throw error; }, { calibration: async () => data });
  await session.ready;
  assert.equal(session.version, "v2"); assert.equal(session.isCalibrating, false);
  const weights = session.snapshot().updates;
  session.update(16, 0, 96, true, false);
  assert.equal(session.snapshot().acceptedCommands, 0);
  runtime.pending[0].resolve(frame(100, true)); await flush();
  session.update(100, 0.16, 96, true, false);
  assert.deepEqual(session.takeContacts().map(event => event.midi), [73], "Wrong decoded D-flat must not be replaced by requested E");
  assert.deepEqual(session.snapshot().updates, weights); assert.equal(session.snapshot().calibrationSource.kind, "offline-balanced");
  session.dispose();
});

test("incompatible candidate weights fail closed instead of silently reverting to v1 or cold v2", async () => {
  const runtime = new DeferredRuntime(), errors: Error[] = [], data = candidate();
  data.weights.readouts[0] = {};
  const session = new PianoNeuralSession(async () => runtime, error => errors.push(error), { calibration: async () => data });
  await assert.rejects(session.ready); assert.equal(errors.length, 1); assert.equal(runtime.disposed, true);
  assert.equal(session.snapshot().ready, false); assert.equal(session.snapshot().acceptedCommands, 0);
});

test("one async neural request at a time; physics continues while the model computes", async () => {
  const runtime = new DeferredRuntime(), session = new PianoNeuralSession(async () => runtime, error => { throw error; });
  await session.ready;
  session.update(16, 0, 96, true, false); session.update(16, 0.0256, 96, true, false);
  assert.equal(runtime.pending.length, 1); assert.equal(session.actuator.snapshot().timeMs, 32);
  runtime.pending[0].resolve(frame(100, true)); await flush();
  assert.ok(session.snapshot().acceptedCommands > 0);
  session.update(100, 0.1856, 96, true, false);
  assert.ok(session.takeContacts().length > 0); assert.equal(runtime.pending.length, 2);
  assert.equal(session.neuralFrame?.tick, 100);
  session.dispose(); assert.equal(runtime.disposed, true);
});

test("pause rejects a late neural result and freezes both displayed state and learning", async () => {
  const runtime = new DeferredRuntime(), session = new PianoNeuralSession(async () => runtime, error => { throw error; });
  await session.ready; session.update(16, 0, 96, true, true); session.setPlaying(false);
  const frozen = session.snapshot();
  runtime.pending[0].resolve(frame(100, true)); await flush();
  session.update(200, 1, 96, true, true);
  assert.deepEqual(session.snapshot(), frozen);
  assert.equal(runtime.pending.length, 1);
  session.setPlaying(true); session.update(16, 0.0256, 96, true, true);
  runtime.pending[1].resolve(frame(200, true)); await flush();
  assert.equal(session.neuralFrame?.tick, 200); assert.ok(session.snapshot().updates.some(readout => readout.updates > 0));
  session.dispose();
});

test("seek and silence invalidate in-flight actions instead of playing stale notes", async () => {
  const runtime = new DeferredRuntime(), session = new PianoNeuralSession(async () => runtime, error => { throw error; });
  await session.ready; session.update(16, 0, 96, true, true); session.reset(2); await flush();
  runtime.pending[0].resolve(frame(100, true)); await flush();
  assert.equal(session.snapshot().acceptedCommands, 0);
  session.update(16, 2, 96, true, true); await session.silence(true);
  runtime.pending[1].resolve(frame(200, true)); await flush();
  assert.equal(session.snapshot().acceptedCommands, 0); assert.equal(session.takeContacts().length, 0);
  assert.equal(session.neuralFrame?.silenced, true);
  assert.equal(session.neuralFrame?.rates.some(rate => rate > 0), false);
  session.dispose();
});

test("runtime failure fails closed without a prerecorded performance", async () => {
  const runtime = new DeferredRuntime(), failures: Error[] = [];
  const session = new PianoNeuralSession(async () => runtime, error => failures.push(error));
  await session.ready; session.update(16, 0, 96, true, true);
  runtime.pending[0].reject(new Error("test core failure")); await flush();
  assert.equal(session.snapshot().ready, false); assert.equal(failures.length, 1);
  session.update(1000, 4, 96, true, true); assert.equal(session.takeContacts().length, 0);
});

test("rapid seeks coalesce and a control-cancelled worker frame is not a model failure", async () => {
  const runtime = new DeferredRuntime(), failures: Error[] = [];
  let resets = 0;
  runtime.reset = async () => {
    resets++; const aborted = new Error("Frame superseded by reset"); aborted.name = "AbortError";
    runtime.pending[0].reject(aborted); runtime.current = frame();
  };
  const session = new PianoNeuralSession(async () => runtime, error => failures.push(error));
  await session.ready; session.update(16, 0, 96, true, true);
  for (let index = 0; index < 20; index++) session.reset(index / 10);
  await flush();
  assert.equal(resets, 1); assert.deepEqual(failures, []); assert.equal(session.snapshot().ready, true);
  assert.equal(session.neuralFrame?.tick, 0); assert.equal(session.snapshot().acceptedCommands, 0);
  session.dispose();
});

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NeuralReadout, NeuralRuntime, NeuralTaskController, integrateNeuralWindow } from "../src/neural/index.ts";
import type { NeuralFrame, NeuralTaskAdapter } from "../src/neural/index.ts";

function frame(tick = 100, active = true): NeuralFrame {
  const rates = new Float32Array(128); rates[0] = active ? 40 : 0;
  return { tick, simulatedMs: tick * .2, rates, silenced: false, totalSpikes: active ? 1 : 0,
    counts: new Uint16Array([active ? 1 : 0]), spikes: new Uint32Array(active ? [0] : []), levels: new Float32Array([.5]) };
}

type Action = "left" | "right" | "wait";
type Observation = { drive: number; legal: Action[] };
const adapter: NeuralTaskAdapter<Observation, Action> = {
  id: "test-task", encoderVersion: "test-32-v1", actions: ["left", "right", "wait"],
  encode: observation => Float32Array.from({ length: 32 }, () => observation.drive),
  legalActions: observation => observation.legal,
};
const observation: Observation = { drive: 100, legal: ["left", "wait"] };
const options = { durationMs: 120, stepMs: 20 };
function fixture(active = true) {
  let tick = 0;
  const calls: { input: Float32Array; ms: number }[] = [];
  const runtime = { silenced: false, async advance(input: Float32Array, ms: number) {
    calls.push({ input: input.slice(), ms }); tick += Math.round(ms / .2); return frame(tick, active);
  } };
  const readout = new NeuralReadout({ actions: adapter.actions, modelId: "fixture", seed: 17 });
  return { runtime, calls, readout, controller: new NeuralTaskController(runtime, readout, adapter) };
}

test("generic task preserves fixed timing, legal masks and matching trace provenance", async () => {
  const { controller, calls } = fixture();
  const shown: number[] = [];
  const choice = await controller.decide(observation, { ...options, onFrame: f => shown.push(f.tick) });
  assert(choice);
  assert(observation.legal.includes(choice.action));
  assert.equal(choice.decision.probabilities[1], 0);
  assert.equal(choice.taskId, adapter.id); assert.equal(choice.encoderVersion, adapter.encoderVersion);
  assert.equal(choice.frame.tick, choice.decision.tick); assert.equal(choice.frame.simulatedMs, 120);
  assert.deepEqual(shown, [100, 200, 300, 400, 500, 600]);
  assert.equal(calls.length, 6); assert(calls.every(call => call.ms === 20 && call.input[0] === 100));
});

test("observation cannot bypass rates; silent and zero-rate models cannot choose", async () => {
  const first = await fixture().controller.decide(observation, options);
  const second = await fixture().controller.decide({ ...observation, drive: 0 }, options);
  assert.deepEqual(first!.decision.probabilities, second!.decision.probabilities);
  assert.equal(await fixture(false).controller.decide(observation, options), null);
  const silent = fixture(); silent.runtime.silenced = true;
  assert.equal(await silent.controller.decide(observation, options), null);
  assert.equal(silent.calls.length, 0);
  assert.equal(await silent.controller.decide({ ...observation, legal: [] }, options), null);
});

test("generic adapter validates action identity, rule masks, encoding and integration bounds", async () => {
  const { controller, runtime, readout, calls } = fixture();
  assert.throws(() => new NeuralTaskController(runtime, readout, { ...adapter, actions: ["wait", "right", "left"] }));
  assert.equal(await controller.decide({ ...observation, legal: [] }, options), null);
  await assert.rejects(controller.decide({ ...observation, legal: ["left", "left"] }, options), /legal action/);
  await assert.rejects(controller.decide({ ...observation, legal: ["invalid" as Action] }, options), /legal action/);
  for (const drive of [NaN, Infinity, -1, 151]) {
    await assert.rejects(controller.decide({ ...observation, drive }, options), /32 finite rates/);
  }
  await assert.rejects(integrateNeuralWindow(runtime, new Float32Array(31), options), /32 finite rates/);
  for (const durationMs of [0, .1, 1001, NaN]) {
    await assert.rejects(controller.decide(observation, { ...options, durationMs }), /0.2 ms ticks/);
  }
  assert.equal(calls.length, 0);
  await controller.decide(observation, { durationMs: 45, stepMs: 20 });
  assert.deepEqual(calls.map(call => call.ms), [20, 20, 5]);
});

test("in-flight silence, cancellation and overlapping windows cannot issue stale actions", async () => {
  for (const cancel of [false, true]) {
    let release!: (f: NeuralFrame) => void;
    let valid = true;
    const runtime = { silenced: false, advance: () => new Promise<NeuralFrame>(resolve => { release = resolve; }) };
    const controller = new NeuralTaskController(runtime, fixture().readout, adapter);
    const pending = controller.decide(observation, { ...options, valid: () => valid,
      onFrame: () => { throw Error("Stale frame reached display"); } });
    await assert.rejects(controller.decide(observation, options), /in flight/);
    if (cancel) valid = false; else runtime.silenced = true;
    release(frame()); assert.equal(await pending, null);
  }
});

test("errors release the actor, and cancellation by the final display callback withholds action", async () => {
  let fail = true;
  const runtime = { silenced: false, async advance() { if (fail) throw Error("WASM failed"); return frame(); } };
  const controller = new NeuralTaskController(runtime, fixture().readout, adapter);
  await assert.rejects(controller.decide(observation, options), /WASM failed/);
  fail = false;
  assert(await controller.decide(observation, options));
  assert.equal(await controller.decide(observation, { durationMs: 20, stepMs: 20,
    onFrame: () => { runtime.silenced = true; } }), null);
});

test("input and final frame are owned snapshots, not display-mutable buffers", async () => {
  const input = new Float32Array(32).fill(100);
  const reused = frame();
  const seen: number[] = [];
  const runtime = { silenced: false, async advance(rates: Float32Array) {
    seen.push(rates[0]); input.fill(0); return reused;
  } };
  const result = await integrateNeuralWindow(runtime, input, { durationMs: 40, stepMs: 20,
    onFrame: f => { if (seen.length === 2) f.rates.fill(0); } });
  assert(result); assert.deepEqual(seen, [100, 100]); assert.equal(result.rates[0], 40);
  reused.levels.fill(0); assert.equal(result.levels[0], .5);
});

test("scaffold creates a credential-free core adapter and refuses overwrites", async () => {
  const directory = await mkdtemp(join(tmpdir(), "housefly-scaffold-"));
  const script = new URL("../scripts/scaffold_activity.py", import.meta.url);
  const args = [script.pathname, "--id", "Odor Trail", "--title", "A draft task"];
  try {
    execFileSync("python3", args, { cwd: directory });
    const source = await readFile(join(directory, "src/activities/odor-trail.ts"), "utf8");
    const spec = JSON.parse(await readFile(join(directory, "src/activities/odor-trail.json"), "utf8"));
    assert(source.includes('from "../neural/index.ts"'));
    assert(source.includes('encoderVersion: "odor-trail-32-v1"'));
    assert.equal(spec.controller, "connectome-readout"); assert.equal(spec.sensoryTrace, undefined);
    assert.throws(() => execFileSync("python3", args, { cwd: directory, stdio: "pipe" }));
    assert.equal(await readFile(join(directory, "src/activities/odor-trail.ts"), "utf8"), source);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("real WASM task window equals direct integration and silence withholds its action", { timeout: 30_000 }, async () => {
  const graph = await NeuralRuntime.load(new URL("../public/", import.meta.url), { read: async url => {
    const bytes = await readFile(url);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  } });
  const actual = new NeuralRuntime(graph, 42), reference = new NeuralRuntime(graph, 42);
  try {
    const readout = new NeuralReadout({ actions: adapter.actions, modelId: graph.modelId, seed: 17 });
    const controller = new NeuralTaskController(actual, readout, adapter);
    const choice = await controller.decide(observation, options);
    assert(choice); assert(choice.frame.totalSpikes > 0);
    for (let i = 0; i < 6; i++) reference.advance(adapter.encode(observation), 20);
    const expected = reference.snapshot();
    assert.deepEqual(choice.frame, expected);
    actual.silence(true);
    assert.equal(await controller.decide(observation, options), null);
    assert.equal(actual.snapshot().totalSpikes, choice.frame.totalSpikes);
  } finally { actual.dispose(); reference.dispose(); }
});

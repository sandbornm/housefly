import assert from "node:assert/strict";
import test from "node:test";
import { ConnectomeActivity, activityChannels, classChannel, type ActivitySignal } from "../src/connectomeActivity.ts";

const active: ActivitySignal = { sensory: 1, integration: 0, motor: 0, reward: 0, label: "Track ball" };
const model = () => new ConnectomeActivity(new Uint8Array([0, 1, 2]), ["ol_sensory", "cb_intrinsic", "cb_motor"], new Uint32Array([0, 1, 10, 1, 2, 5]));

test("channel inputs are finite and bounded", () => {
  assert.deepEqual(activityChannels({ ...active, sensory: 3, integration: -1, motor: NaN, reward: Infinity }), [1, 0, 0, 0]);
  assert.equal(classChannel("ol_intrinsic"), 0);
  assert.equal(classChannel("cb_intrinsic"), 1);
  assert.equal(classChannel("descending_neuron"), 2);
});
test("activity travels only over retained directed edges", () => {
  const network = model(); network.step(active, .05);
  assert.ok(network.levels[0] > 0); assert.equal(network.levels[1], 0); assert.equal(network.levels[2], 0);
  network.step(active, .05);
  assert.ok(network.levels[1] > 0); assert.equal(network.levels[2], 0);
  network.step(active, .05); assert.ok(network.levels[2] > 0);
});
test("pause freezes state, removed input decays, activity remains bounded", () => {
  const network = model();
  for (let i = 0; i < 100; i++) network.step(active, .05);
  const before = [...network.levels];
  network.step({ ...active, paused: true }, .1); assert.deepEqual([...network.levels], before);
  for (let i = 0; i < 300; i++) network.step({ ...active, sensory: 0 }, .05);
  assert.ok(network.levels.every(level => level >= 0 && level < .001));
  assert.ok(before.every(level => level >= 0 && level <= 1));
});
test("malformed connectivity fails explicitly", () => {
  assert.throws(() => new ConnectomeActivity(new Uint8Array([0]), ["visual"], new Uint32Array([0, 2, 1])), /outside/);
  assert.throws(() => new ConnectomeActivity(new Uint8Array([0]), ["visual"], new Uint32Array([0])), /Malformed/);
});

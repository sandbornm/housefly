import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NeuralReadout } from '../../src/neural/policy.ts';
import { calibrationObservation, teacherAction } from './calibration.ts';
import { decodeFlight, encodeFlight, featureHash, FLIGHT_ACTIONS, FlightGoals, type FlightNeuralFrame, type FlightReadout } from './neural.ts';
import { NeuralPilot, type FlightRuntime } from './pilot.ts';
import { ROUTE, SPAWN } from './flight.ts';

// Injectable fixtures verify adapter causality; real WASM coverage is in verify-neural.mjs.
const frame = (tick = 10): FlightNeuralFrame => ({ tick, simulatedMs: tick * .2, spikes: new Uint32Array([14, 29]), counts: new Uint16Array(139662),
  rates: Float32Array.from({ length: 128 }, (_, i) => i < 8 ? 4 + i : 0), levels: new Float32Array(139662), totalSpikes: 2, silenced: false });

test('sensory encoding uses body bearing, velocity and measured clearances within Hz bounds', () => {
  const observation = calibrationObservation(1), rates = encodeFlight(observation);
  assert.equal(rates.length, 32); assert.ok(rates.every(value => value >= 0 && value <= 150));
  const danger = encodeFlight({ ...observation, contact: true, clearances: new Float32Array(8), velocity: { x: 0, y: 4, z: -10 } });
  assert.equal(danger[18], 150); assert.equal(danger[26], 150); assert.equal(danger[14], 75);
  assert.notDeepEqual(rates, danger);
  assert.throws(() => encodeFlight({ ...observation, turnRate: NaN }), /Non-finite/);
});

test('motor command consumes the exact displayed frame and records its measured features', () => {
  const neuralFrame = frame(), learned = new NeuralReadout({ actions: FLIGHT_ACTIONS, modelId: 'adapter-test' });
  for (let i = 0; i < 20; i++) learned.teach(neuralFrame, 1, .5);
  let passed: unknown;
  const readout: FlightReadout = { decide(value, allowed, options) { passed = value; return learned.decide(value, allowed, options); } };
  const command = decodeFlight(neuralFrame, readout, 0, 7);
  assert.equal(passed, neuralFrame); assert.equal(command.frameTick, neuralFrame.tick);
  assert.equal(command.featureHash, featureHash(neuralFrame.rates)); assert.equal(command.action, 'forward');
  assert.equal(command.target?.z, -7); assert.equal(command.powered, true);
  const stale: FlightReadout = { decide(value) { const choice = learned.decide(value)!; return { ...choice, tick: choice.tick - 1 }; } };
  assert.throws(() => decodeFlight(neuralFrame, stale, 0, 7), /different neural frame/);
});

test('zero or silenced neural activity never invokes the learned motor decoder', () => {
  const readout: FlightReadout = { decide() { throw new Error('Decoder must not be called'); } };
  for (const neuralFrame of [{ ...frame(), silenced: true }, { ...frame(), rates: new Float32Array(128) }]) {
    const command = decodeFlight(neuralFrame, readout, 0, 7);
    assert.equal(command.powered, false); assert.equal(command.target, null); assert.equal(command.yawRate, 0);
    assert.deepEqual(command.input, { forward: 0, strafe: 0, lift: 0, yaw: 0 });
  }
});

test('goal tracking retains missed waypoints and contact history without recovery motion', () => {
  const goals = new FlightGoals(ROUTE);
  for (let i = 0; i < 3000; i++) goals.update(SPAWN, true);
  assert.equal(goals.index, 0); assert.equal(goals.reached, 0); assert.equal(goals.contacts, 1);
  assert.equal(goals.update(ROUTE[0], false), true); assert.equal(goals.index, 1);
  goals.update(SPAWN, true); assert.equal(goals.contacts, 2);
});

test('calibration labels cover all actions and inference does not call the teacher', async () => {
  assert.deepEqual(Array.from({ length: 7 }, (_, i) => teacherAction(calibrationObservation(i))), [0, 1, 2, 3, 4, 5, 6]);
  let tick = 0, silenced = false;
  const runtime: FlightRuntime = { advance() { return { ...frame(++tick), silenced }; }, reset() { tick = 0; }, silence(value) { silenced = value; }, snapshot() { return { ...frame(tick), silenced }; }, dispose() {} };
  const pilot = new NeuralPilot(runtime, { modelId: 'test-fixture', edgeCount: 0 });
  await pilot.infer(calibrationObservation(1), 7); pilot.commit(); assert.equal(pilot.command.powered, false);
  await pilot.beginCalibration(); pilot.commit();
  while (pilot.phase === 'calibration') { await pilot.calibrateStep(); pilot.commit(); }
  assert.equal(pilot.phase, 'inference'); assert.ok(pilot.readout.updates > 0);
  const updates = pilot.readout.updates;
  await pilot.infer(calibrationObservation(2), 7); pilot.commit(); assert.equal(pilot.readout.updates, updates); assert.equal(pilot.command.frameTick, pilot.frame?.tick);
  await pilot.silence(true); pilot.commit(); assert.equal(pilot.command.target, null); assert.equal(pilot.frame?.silenced, true);
  await pilot.infer(calibrationObservation(1), 7); pilot.commit(); assert.equal(pilot.command.powered, false); assert.equal(pilot.readout.updates, updates);
  await pilot.dispose();
});

test('runtime exceptions fail closed and cannot activate scripted fallback', async () => {
  const runtime: FlightRuntime = { advance() { throw new Error('Unavailable WASM'); }, reset() {}, silence() {}, snapshot: frame, dispose() {} };
  const pilot = new NeuralPilot(runtime, { modelId: 'test-fixture', edgeCount: 0 });
  await pilot.infer(calibrationObservation(1), 7); pilot.commit();
  assert.equal(pilot.phase, 'failed'); assert.match(pilot.failure, /Unavailable WASM/); assert.equal(pilot.command.target, null);
});

test('worker replies stay staged until a physical step accepts the exact frame', async () => {
  const actual = frame(), runtime: FlightRuntime = { async advance() { return actual; }, reset() {}, silence() {}, snapshot: frame, dispose() {} };
  const pilot = new NeuralPilot(runtime, { modelId: 'async-fixture', edgeCount: 0 });
  pilot.phase = 'inference';
  await pilot.infer(calibrationObservation(1), 7);
  assert.equal(pilot.frame, undefined, 'A paused render cannot acquire an asynchronous frame');
  assert.equal(pilot.command.target, null);
  pilot.commit();
  assert.equal(pilot.frame, actual); assert.equal(pilot.command.frameTick, actual.tick);
  assert.equal(pilot.command.featureHash, featureHash(actual.rates));
  pilot.snapshot().command.input.forward = 99;
  assert.notEqual(pilot.command.input.forward, 99, 'Snapshot is not a mutable actuator reference');
  await pilot.dispose();
});

test('silencing during the calibration reset cannot strand a finished readout', async () => {
  let silenced = false;
  const runtime: FlightRuntime = { async advance() { return frame(); }, async reset() {}, async silence(value) { silenced = value; },
    async snapshot() { return { ...frame(0), silenced }; }, dispose() {} };
  const pilot = new NeuralPilot(runtime, { modelId: 'async-fixture', edgeCount: 0 });
  await pilot.beginCalibration(); pilot.commit();
  while (pilot.samples < pilot.calibrationTrials) { await pilot.calibrateStep(); pilot.commit(); }
  await pilot.silence(true); pilot.commit();
  assert.equal(pilot.phase, 'inference'); assert.equal(pilot.frame?.silenced, true); assert.equal(pilot.command.powered, false);
  await pilot.dispose();
});

test('one advance is in flight and silencing invalidates late motor replies', async () => {
  let resolve!: (frame: FlightNeuralFrame) => void, active = 0, maximum = 0, silenced = false;
  const runtime: FlightRuntime = {
    async advance() { active++; maximum = Math.max(active, maximum); const result = await new Promise<FlightNeuralFrame>(done => { resolve = done; }); active--; return result; },
    reset() {}, silence(value) { assert.equal(active, 0, 'Intervention is serialized after the worker operation'); silenced = value; },
    snapshot() { return { ...frame(), silenced, rates: new Float32Array(128), spikes: new Uint32Array() }; }, dispose() {},
  };
  const pilot = new NeuralPilot(runtime, { modelId: 'async-fixture', edgeCount: 0 }); pilot.phase = 'inference';
  const pending = pilot.infer(calibrationObservation(1), 7);
  await Promise.resolve(); await pilot.infer(calibrationObservation(2), 7);
  assert.equal(maximum, 1); assert.equal(active, 1);
  const intervention = pilot.silence(true); assert.equal(pilot.command.target, null);
  resolve(frame()); await pending; await intervention; pilot.commit();
  assert.equal(pilot.frame?.silenced, true); assert.equal(pilot.command.powered, false);
  assert.equal(pilot.command.yawRate, 0); assert.equal(pilot.command.target, null);
  assert.equal(pilot.completedRequests, 0, 'Invalidated neural response was never accepted');
  await pilot.dispose();
});

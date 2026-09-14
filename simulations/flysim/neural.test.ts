import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NeuralReadout } from '../../src/neural/policy.ts';
import { calibrationObservation, teacherAction } from './calibration.ts';
import { autopilotDrive, decodeEscape, encodeFlysim, featureHash, FLYSIM_ACTIONS, NEURAL_WINDOW_MS, type FlysimNeuralFrame, type FlysimReadout } from './neural.ts';
import { NeuralPilot, type FlysimRuntime } from './pilot.ts';

// Injectable fixtures verify adapter causality; real WASM coverage is in a later verify script.
const frame = (tick = 10): FlysimNeuralFrame => ({ tick, simulatedMs: tick * .2, spikes: new Uint32Array([14, 29]), counts: new Uint16Array(139662),
  rates: Float32Array.from({ length: 128 }, (_, i) => i < 8 ? 4 + i : 0), levels: new Float32Array(139662), totalSpikes: 2, silenced: false });

test('sensory encoding stays within 0..150 Hz and excludes teacher actions', () => {
  const observation = calibrationObservation(1), rates = encodeFlysim(observation);
  assert.equal(rates.length, 32); assert.ok(rates.every(value => Number.isFinite(value) && value >= 0 && value <= 150));
  const high = encodeFlysim({ ...observation, altitude: 7, velocity: { x: 0, y: 0, z: -6 } });
  const danger = encodeFlysim({ ...observation, food: null, threats: [{ kind: 'bird', dx: 0, dy: 0, dz: -3, range: 3, closing: 4 }] });
  assert.ok(high[0] > rates[0]); assert.ok(high[1] > rates[1]);
  assert.notDeepEqual(rates, danger);
  assert.throws(() => encodeFlysim({ ...observation, heading: NaN }), /Non-finite/);
});

test('motor command consumes the exact displayed frame and records its measured features', () => {
  const neuralFrame = frame(), learned = new NeuralReadout({ actions: FLYSIM_ACTIONS, modelId: 'adapter-test' });
  for (let i = 0; i < 20; i++) learned.teach(neuralFrame, 1, .5);
  let passed: unknown;
  const readout: FlysimReadout = { decide(value, allowed, options) { passed = value; return learned.decide(value, allowed, options); } };
  const command = decodeEscape(neuralFrame, readout, calibrationObservation(1));
  assert.equal(passed, neuralFrame); assert.equal(command.frameTick, neuralFrame.tick);
  assert.equal(command.featureHash, featureHash(neuralFrame.rates)); assert.equal(command.action, 'forward');
  assert.equal(command.input.forward, 1); assert.equal(command.input.dash, false); assert.equal(command.powered, true);
  const stale: FlysimReadout = { decide(value) { const choice = learned.decide(value)!; return { ...choice, tick: choice.tick - 1 }; } };
  assert.throws(() => decodeEscape(neuralFrame, stale, calibrationObservation(1)), /different neural frame/);
});

test('zero or silenced neural activity never invokes the learned motor decoder', () => {
  const readout: FlysimReadout = { decide() { throw new Error('Decoder must not be called'); } };
  for (const neuralFrame of [{ ...frame(), silenced: true }, { ...frame(), rates: new Float32Array(128) }]) {
    const command = decodeEscape(neuralFrame, readout, calibrationObservation(1));
    assert.equal(command.powered, false); assert.equal(command.target, null); assert.equal(command.yawRate, 0);
    assert.deepEqual(command.input, { forward: 0, yaw: 0, lift: 0, dash: false });
  }
});

test('autopilot falls when inference has no powered readout and only holds during load or rehearsal', () => {
  assert.equal(autopilotDrive('uncalibrated', false, false), 'hold');
  assert.equal(autopilotDrive('calibration', false, false), 'hold');
  assert.equal(autopilotDrive('inference', false, true), 'neural');
  assert.equal(autopilotDrive('inference', false, false), 'fall');
  assert.equal(autopilotDrive('inference', true, true), 'fall');
  assert.equal(autopilotDrive('failed', false, true), 'fall');
});

test('calibration labels cover all actions and inference does not call the teacher', async () => {
  assert.deepEqual(Array.from({ length: 7 }, (_, i) => teacherAction(calibrationObservation(i))), [0, 1, 2, 3, 4, 5, 6]);
  assert.ok(Array.from({ length: 84 }, (_, i) => teacherAction(calibrationObservation(i))).every((action, i) => action === i % 7));
  let tick = 0, silenced = false;
  const windows: number[] = [];
  const runtime: FlysimRuntime = { advance(_input, milliseconds) { windows.push(milliseconds); return { ...frame(++tick), silenced }; }, reset() { tick = 0; }, silence(value) { silenced = value; }, snapshot() { return { ...frame(tick), silenced }; }, dispose() {} };
  const pilot = new NeuralPilot(runtime, { modelId: 'test-fixture', edgeCount: 0 });
  await pilot.infer(calibrationObservation(1)); pilot.commit(); assert.equal(pilot.command.powered, false);
  await pilot.beginCalibration(); pilot.commit();
  while (pilot.phase === 'calibration') { await pilot.calibrateStep(); pilot.commit(); }
  assert.equal(pilot.phase, 'inference'); assert.ok(pilot.readout.updates > 0);
  assert.ok(windows.length > 0); assert.ok(windows.every(milliseconds => milliseconds === NEURAL_WINDOW_MS));
  const updates = pilot.readout.updates;
  await pilot.infer(calibrationObservation(2)); pilot.commit(); assert.equal(pilot.readout.updates, updates); assert.equal(pilot.command.frameTick, pilot.frame?.tick);
  await pilot.silence(true); pilot.commit(); assert.equal(pilot.command.target, null); assert.equal(pilot.frame?.silenced, true);
  await pilot.infer(calibrationObservation(1)); pilot.commit(); assert.equal(pilot.command.powered, false); assert.equal(pilot.readout.updates, updates);
  await pilot.dispose();
});

test('restored readout weights skip live rehearsal and do not teach at inference', async () => {
  let tick = 0;
  const runtime: FlysimRuntime = { advance() { return frame(++tick); }, reset() { tick = 0; }, silence() {}, snapshot() { return frame(tick); }, dispose() {} };
  const trainer = new NeuralPilot(runtime, { modelId: 'test-fixture', edgeCount: 0 });
  await trainer.beginCalibration(); trainer.commit();
  while (trainer.phase === 'calibration') { await trainer.calibrateStep(); trainer.commit(); }
  const weights = trainer.export(); await trainer.dispose();
  const pilot = new NeuralPilot(runtime, { modelId: 'test-fixture', edgeCount: 0 });
  assert.equal(pilot.loadWeights({ ...weights, modelId: 'wrong' }), false);
  assert.equal(pilot.phase, 'uncalibrated');
  assert.equal(pilot.loadWeights(weights), true);
  assert.equal(pilot.phase, 'inference');
  const updates = pilot.readout.updates;
  await pilot.infer(calibrationObservation(2)); pilot.commit();
  assert.equal(pilot.readout.updates, updates);
  assert.equal(pilot.command.powered, true);
  await pilot.dispose();
});

test('runtime exceptions fail closed and cannot activate scripted fallback', async () => {
  const runtime: FlysimRuntime = { advance() { throw new Error('Unavailable WASM'); }, reset() {}, silence() {}, snapshot: frame, dispose() {} };
  const pilot = new NeuralPilot(runtime, { modelId: 'test-fixture', edgeCount: 0 });
  await pilot.infer(calibrationObservation(1)); pilot.commit();
  assert.equal(pilot.phase, 'failed'); assert.match(pilot.failure, /Unavailable WASM/); assert.equal(pilot.command.target, null);
});

test('worker replies stay staged until a physical step accepts the exact frame', async () => {
  const actual = frame(), runtime: FlysimRuntime = { async advance() { return actual; }, reset() {}, silence() {}, snapshot: frame, dispose() {} };
  const pilot = new NeuralPilot(runtime, { modelId: 'async-fixture', edgeCount: 0 });
  pilot.phase = 'inference';
  await pilot.infer(calibrationObservation(1));
  assert.equal(pilot.frame, undefined, 'A paused render cannot acquire an asynchronous frame');
  assert.equal(pilot.command.target, null);
  pilot.commit();
  assert.equal(pilot.frame, actual); assert.equal(pilot.command.frameTick, actual.tick);
  assert.equal(pilot.command.featureHash, featureHash(actual.rates));
  const audit = pilot.snapshot();
  assert.equal(audit.decisionCount, 1);
  assert.equal(audit.decisions[0].frameTick, actual.tick);
  assert.equal(audit.decisions[0].featureHash, featureHash(Float32Array.from(audit.decisions[0].rates)));
  assert.deepEqual(audit.decisions[0].rates, Array.from(actual.rates));
  audit.decisions[0].rates[0] = 999;
  assert.notEqual(pilot.snapshot().decisions[0].rates[0], 999);
  pilot.snapshot().command.input.forward = 99;
  assert.notEqual(pilot.command.input.forward, 99, 'Snapshot is not a mutable actuator reference');
  await pilot.dispose();
});

test('silencing during the calibration reset cannot strand a finished readout', async () => {
  let silenced = false;
  const runtime: FlysimRuntime = { async advance() { return frame(); }, async reset() {}, async silence(value) { silenced = value; },
    async snapshot() { return { ...frame(0), silenced }; }, dispose() {} };
  const pilot = new NeuralPilot(runtime, { modelId: 'async-fixture', edgeCount: 0 });
  await pilot.beginCalibration(); pilot.commit();
  while (pilot.samples < pilot.calibrationTrials) { await pilot.calibrateStep(); pilot.commit(); }
  await pilot.silence(true); pilot.commit();
  assert.equal(pilot.phase, 'inference'); assert.equal(pilot.frame?.silenced, true); assert.equal(pilot.command.powered, false);
  await pilot.dispose();
});

test('one advance is in flight and silencing invalidates late motor replies', async () => {
  let resolve!: (frame: FlysimNeuralFrame) => void, active = 0, maximum = 0, silenced = false;
  const runtime: FlysimRuntime = {
    async advance() { active++; maximum = Math.max(active, maximum); const result = await new Promise<FlysimNeuralFrame>(done => { resolve = done; }); active--; return result; },
    reset() {}, silence(value) { assert.equal(active, 0, 'Intervention is serialized after the worker operation'); silenced = value; },
    snapshot() { return { ...frame(), silenced, rates: new Float32Array(128), spikes: new Uint32Array() }; }, dispose() {},
  };
  const pilot = new NeuralPilot(runtime, { modelId: 'async-fixture', edgeCount: 0 }); pilot.phase = 'inference';
  const pending = pilot.infer(calibrationObservation(1));
  await Promise.resolve(); await pilot.infer(calibrationObservation(2));
  assert.equal(maximum, 1); assert.equal(active, 1);
  const intervention = pilot.silence(true); assert.equal(pilot.command.target, null);
  resolve(frame()); await pending; await intervention; pilot.commit();
  assert.equal(pilot.frame?.silenced, true); assert.equal(pilot.command.powered, false);
  assert.equal(pilot.command.yawRate, 0); assert.equal(pilot.command.target, null);
  assert.equal(pilot.completedRequests, 0, 'Invalidated neural response was never accepted');
  assert.equal(pilot.snapshot().decisionCount, 0, 'Invalidated replies cannot enter the decision evidence');
  await pilot.dispose();
});

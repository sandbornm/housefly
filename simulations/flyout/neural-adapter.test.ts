import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import RAPIER from '@dimforge/rapier3d-compat';
import { NeuralReadout } from '../../src/neural/policy.ts';
import { ACTOR_COUNT, BATTER_ACTOR, FEATURE_COUNT, NODE_COUNT, MOVE_ACTIONS, FlyoutNeuralController,
  decodeCommand, encodeObservation, type ActorReadouts, type NeuralDecision, type NeuralFrame,
  type Observation, type ReadoutPort, type RuntimePort } from './neural-adapter.ts';

function observation(batter = false): Observation {
  return { ball: { x: 3, y: 2, z: 8 }, velocity: { x: -1, y: -2, z: -3 },
    self: { x: 0, y: 0, z: 3 }, selfVelocity: { x: 0, y: 0, z: 0 }, home: { x: 0, y: 0, z: 3 },
    phase: 'live', hasBall: false, bounced: false, batter, runnerDistance: 10, strikes: 1, balls: 2 };
}

function observations(): Observation[] {
  return Array.from({ length: ACTOR_COUNT }, (_, actor) => observation(actor === BATTER_ACTOR));
}

// Contract fixture only. Scientific dynamics must be verified against the shared WASM runtime.
class RuntimeFixture implements RuntimePort {
  current: NeuralFrame = { tick: 0, simulatedMs: 0, spikes: Uint32Array.of(12), rates: new Float32Array(FEATURE_COUNT),
    levels: new Float32Array(NODE_COUNT), totalSpikes: 0, silenced: false };
  calls = 0;
  stopped = false;
  fail = false;
  seed = 0;
  input?: Float32Array;
  constructor() { this.current.rates[0] = 30; }
  advance(input: Float32Array, milliseconds: number): NeuralFrame {
    if (this.fail) throw new Error('WASM unavailable');
    this.calls++; this.input = input.slice(); this.current.tick++; this.current.simulatedMs += milliseconds;
    this.current.totalSpikes += this.current.silenced ? 0 : 1;
    return this.current;
  }
  reset(seed = 0): void { this.seed = seed; this.current.tick = 0; this.current.totalSpikes = 0; }
  silence(enabled: boolean): void { this.current.silenced = enabled; }
  dispose(): void { this.stopped = true; }
}

function eastReadout(): ReadoutPort & { calls: number } {
  return { calls: 0, decide(frame): NeuralDecision {
    this.calls++;
    return { action: 'east', index: 2, probabilities: Float32Array.of(0, 0, 1, 0, 0, 0, 0, 0, 0),
      features: frame.rates.slice(), tick: frame.tick, simulatedMs: frame.simulatedMs, temperature: .6 };
  }, reinforce() {} };
}

function controller(readouts?: (actor: number) => ActorReadouts) {
  const runtimes: RuntimeFixture[] = [];
  const brain = new FlyoutNeuralController(() => {
    const runtime = new RuntimeFixture(); runtimes.push(runtime); return runtime;
  }, readouts ?? (() => ({ ready: true, movement: eastReadout() })));
  return { brain, runtimes };
}

test('sensory encoding is bounded, actor-relative, and contains only current observations', () => {
  const seen = observation();
  const first = encodeObservation(seen);
  assert.equal(first.length, 32);
  assert.ok(first.every(rate => Number.isFinite(rate) && rate >= 0 && rate <= 150));
  const translated = { ...seen, ball: { ...seen.ball, x: 13 }, self: { ...seen.self, x: 10 }, home: { ...seen.home, x: 10 } };
  assert.deepEqual(encodeObservation(translated).slice(0, 16), first.slice(0, 16));
  assert.equal(first[22], 150); assert.equal(first[28], 0);
  assert.equal(encodeObservation({ ...seen, batter: true })[28], 150);
  assert.equal(encodeObservation({ ...seen, ball: { x: 1e8, y: 1e8, z: -1e8 } })[0], 150);
  assert.throws(() => encodeObservation({ ...seen, ball: { x: NaN, y: 0, z: 0 } }), /Non-finite/);
});

test('ten actors use independent runtimes, inputs, frame storage, and reset seeds', () => {
  const { brain, runtimes } = controller();
  const seen = observations(); seen[5].ball.x = -5;
  brain.advance(seen, 100);
  assert.equal(new Set(runtimes).size, ACTOR_COUNT);
  assert.equal(new Set(runtimes.map(runtime => runtime.current.levels)).size, ACTOR_COUNT);
  assert.notDeepEqual(runtimes[0].input, runtimes[5].input);
  assert.equal(brain.frame(5), runtimes[5].current);
  brain.reset(7);
  assert.equal(new Set(runtimes.map(runtime => runtime.seed)).size, ACTOR_COUNT);
  brain.dispose(); assert.ok(runtimes.every(runtime => runtime.stopped));
  const shared = new RuntimeFixture();
  assert.throws(() => new FlyoutNeuralController(() => shared, () => ({ ready: true })), /independent/);
});

test('missing calibration, silence, and zero spikes cannot invoke a motor readout', () => {
  const runtime = new RuntimeFixture(), readout = eastReadout();
  assert.equal(decodeCommand(runtime.current, { ready: false, movement: readout }).source, 'unready');
  runtime.current.silenced = true;
  assert.equal(decodeCommand(runtime.current, { ready: true, movement: readout }).x, 0);
  runtime.current.silenced = false; runtime.current.spikes = new Uint32Array();
  assert.equal(decodeCommand(runtime.current, { ready: true, movement: readout }).source, 'silent');
  assert.equal(readout.calls, 0);
  const { brain, runtimes } = controller(() => ({ ready: false, movement: readout }));
  brain.advance(observations(), 100); assert.ok(runtimes.every(runtime => runtime.calls === 0)); brain.dispose();
});

test('faults revoke a previously active command without taking over another actor', () => {
  const { brain, runtimes } = controller();
  brain.advance(observations(), 100); assert.equal(brain.command(0).x, 1);
  runtimes[0].fail = true;
  brain.advance(observations(), 100);
  assert.equal(brain.command(0).x, 0); assert.equal(brain.command(0).source, 'fault');
  assert.equal(brain.command(1).x, 1); assert.match(brain.snapshot().actors[0].error!, /WASM unavailable/);
  brain.dispose();
});

test('pause does not advance neural time or consume a new sampled decision', () => {
  const { brain, runtimes } = controller();
  brain.advance(observations(), 100);
  const before = brain.snapshot();
  brain.advance(observations(), 100, true);
  assert.deepEqual(brain.snapshot(), before); assert.ok(runtimes.every(runtime => runtime.calls === 1));
  brain.dispose();
});

test('readout learning sees only recorded sampled decisions after the action was selected', () => {
  const readout = new NeuralReadout({ actions: MOVE_ACTIONS, modelId: 'flyout-test', seed: 41 });
  const { brain } = controller(() => ({ ready: true, movement: readout }));
  brain.advance(observations(), 100);
  const performed = { ...brain.command(0) };
  brain.reward(0, 1); assert.equal(readout.episodes, 0, 'Unapplied decisions receive no reward update');
  brain.advance(observations(), 100);
  brain.recordApplied(0, ['movement']); brain.recordApplied(0, ['movement']);
  const applied = { ...brain.command(0) };
  brain.reward(0, 1);
  assert.equal(readout.episodes, 1); assert.ok(readout.updates > 0);
  assert.deepEqual(brain.command(0), applied, 'Training cannot replace the performed command');
  assert.equal(performed.source, 'neural');
  brain.reward(0, 1); assert.equal(readout.episodes, 1, 'Decision is consumed only once');
  brain.dispose();
});

test('silencing stops autonomous fielder displacement while real Rapier ball physics continues', async () => {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -13, z: 0 });
  const ball = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 8, 0).setLinvel(1, 0, 0));
  world.createCollider(RAPIER.ColliderDesc.ball(.23), ball);
  const fielder = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
  const { brain } = controller();
  const step = () => {
    brain.advance(observations(), 1000 / 60);
    const p = fielder.translation(), motor = brain.command(0);
    fielder.setNextKinematicTranslation({ x: p.x + motor.x * 5.8 / 60, y: 0, z: p.z + motor.z * 5.8 / 60 });
    world.step();
  };
  try {
    for (let i = 0; i < 10; i++) step();
    assert.ok(fielder.translation().x > .5);
    brain.silence(true); assert.equal(brain.command(0).x, 0, 'Held commands stop immediately');
    const before = { fielder: { ...fielder.translation() }, ball: { ...ball.translation() } };
    for (let i = 0; i < 10; i++) step();
    assert.deepEqual({ ...fielder.translation() }, before.fielder);
    assert.ok(ball.translation().y < before.ball.y && ball.translation().x > before.ball.x);
    assert.ok(brain.snapshot().actors.every(actor => actor.command.source === 'silent'));
  } finally { brain.dispose(); world.free(); }
});

test('real full-graph LIF ablation removes decoded movement while the physics clock advances', async () => {
  const { NeuralRuntime } = await import('../../src/neural/runtime.ts');
  const graph = await NeuralRuntime.load(new URL('../../public/', import.meta.url), {
    read: async url => { const bytes = await readFile(url); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
  });
  assert.equal(graph.nodeCount, NODE_COUNT); assert.equal(graph.edgeCount, 5536347);
  const runtime = new NeuralRuntime(graph, 1337);
  const policy = new NeuralReadout({ actions: MOVE_ACTIONS, modelId: 'flyout-ablation-test', seed: 1337 });
  const input = encodeObservation(observation());
  const measured = runtime.advance(input, 100);
  assert.ok(measured.spikes.length > 0 && measured.rates.some(rate => rate > 0));
  // Explicit test calibration establishes a motor output before intervening on the network.
  for (let pass = 0; pass < 120; pass++) policy.teach(measured, 2, .4);
  const readouts: ActorReadouts = { ready: true, movement: {
    decide: frame => policy.decide(frame, undefined, { sample: false }), reinforce() { throw new Error('Ablation freezes readout weights.'); },
  } };
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -13, z: 0 });
  const ball = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 5, 0));
  world.createCollider(RAPIER.ColliderDesc.ball(.23), ball);
  const fielder = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
  const step = () => {
    const frame = runtime.advance(input, 20), command = decodeCommand(frame, readouts), p = fielder.translation();
    fielder.setNextKinematicTranslation({ x: p.x + command.x * 5.8 / 60, y: 0, z: p.z + command.z * 5.8 / 60 });
    world.step(); return frame;
  };
  try {
    for (let i = 0; i < 3; i++) step();
    assert.ok(fielder.translation().x > 0, 'A decoded action from real measured neural features moves the fielder');
    runtime.silence(true);
    const before = { x: fielder.translation().x, y: ball.translation().y, tick: runtime.snapshot().tick };
    const frame = step();
    assert.equal(frame.silenced, true); assert.equal(frame.spikes.length, 0);
    assert.equal(fielder.translation().x, before.x);
    assert.ok(ball.translation().y < before.y && frame.tick > before.tick);
  } finally { runtime.dispose(); world.free(); }
});

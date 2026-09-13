import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { NeuralRuntime } from '../../src/neural/runtime.ts';
import { NeuralPilot } from './pilot.ts';
import { FlightGoals, featureHash } from './neural.ts';
import { FlightPhysics, initPhysics } from './physics.ts';
import { createVillage } from './world.ts';
import { FIXED_DT, ROUTE, manualVelocity, wrapAngle } from './flight.ts';

const graph = await NeuralRuntime.load(new URL('../../public/', import.meta.url), { read: async url => {
  const bytes = await readFile(url); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
} });
await initPhysics();
const pilot = new NeuralPilot(new NeuralRuntime(graph, 8731), graph);
const village = createVillage(), physics = new FlightPhysics(village.colliders), goals = new FlightGoals(ROUTE);
let heading = 0, turnRate = 0;
const observation = () => ({ position: physics.position(), velocity: physics.velocity(), heading, turnRate,
  goal: goals.current, contact: physics.contact, clearances: physics.clearances(heading) });
try {
  const started = performance.now();
  await pilot.beginCalibration(); pilot.commit();
  while (pilot.phase === 'calibration') { await pilot.calibrateStep(); pilot.commit(); }
  assert.equal(pilot.phase, 'inference', pilot.failure);
  assert.ok(pilot.readout.updates > 0);
  const trainingUpdates = pilot.readout.updates, trainingWallMs = performance.now() - started;
  physics.world.step();
  const hashes = new Set(), actions = {}, ticks = [];
  for (let step = 0; step < 600; step++) {
    if (step % 6 === 0) {
      await pilot.infer(observation(), 7); pilot.commit();
      assert.equal(pilot.phase, 'inference', pilot.failure);
      assert.equal(pilot.command.frameTick, pilot.frame.tick);
      assert.equal(pilot.command.featureHash, featureHash(pilot.frame.rates));
      if (pilot.command.readout) assert.equal(pilot.command.readout.tick, pilot.frame.tick);
      hashes.add(pilot.command.featureHash); ticks.push(pilot.frame.tick);
      actions[pilot.command.action] = (actions[pilot.command.action] ?? 0) + 1;
    }
    const previous = heading;
    heading = wrapAngle(heading + pilot.command.yawRate * FIXED_DT);
    physics.step(pilot.command.powered ? manualVelocity(pilot.command.input, heading, 7) : null, 1);
    turnRate = wrapAngle(heading - previous) / FIXED_DT;
    goals.update(physics.position(), physics.contact);
  }
  assert.ok(hashes.size > 1, 'Actual neural rates change during flight');
  assert.ok(ticks.every((tick, i) => i === 0 || tick > ticks[i - 1]), 'Every decision uses a newer runtime frame');
  assert.equal(pilot.readout.updates, trainingUpdates, 'Inference does not train against a hidden teacher');
  const flight = { position: physics.position(), reached: goals.reached, contacts: goals.contacts, actions, uniqueFeatureHashes: hashes.size };

  // Controlled intervention setup, separate from inference. There is no runtime recovery teleport.
  physics.reset({ x: 0, y: 18, z: 29 });
  await pilot.silence(true); pilot.commit(); await pilot.infer(observation(), 7); pilot.commit();
  assert.equal(pilot.frame.silenced, true); assert.equal(pilot.command.powered, false);
  assert.equal(pilot.command.target, null); assert.equal(pilot.command.yawRate, 0);
  assert.equal(pilot.frame.spikes.length, 0); assert.ok(pilot.frame.rates.every(value => value === 0));
  for (let i = 0; i < 120; i++) physics.step(pilot.command.target, 1);
  assert.ok(physics.position().y < 15, 'Physics continues falling with motor drive removed');
  const result = { passed: true, model: graph.modelId, nodes: graph.nodeCount, simulatedEdges: graph.edgeCount,
    training: { trials: pilot.samples, updates: trainingUpdates, finalTeacherLoss: pilot.lastLoss, wallMs: trainingWallMs },
    inference: flight, silencing: { motorTarget: pilot.command.target, yawRate: pilot.command.yawRate, spikes: pilot.frame.spikes.length, finalPosition: physics.position() },
    checks: ['actual verified WASM and full graph', 'explicit teacher calibration', 'same frame tick and rate hash as motor decisions', 'no inference-time teaching', 'silencing removes commands and neural spikes', 'Rapier continues unpowered'] };
  await mkdir(new URL('./verification/', import.meta.url), { recursive: true });
  await writeFile(new URL('./verification/neural-results.json', import.meta.url), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await pilot.dispose(); physics.dispose(); }

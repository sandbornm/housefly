import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { CRUISE_SPEED, DASH_MULTIPLIER, createFlyActor, type FlyActor } from './fly-actor.ts';
import { createPredators } from './predators.ts';
import { SPAWN, type FlysimInput } from './types.ts';
import { GardenWorld } from './world.ts';
import type { DrosophilaActor } from '../../src/flyModel.ts';

const hold: FlysimInput = { forward: 0, yaw: 0, lift: 0, dash: false };
const forward: FlysimInput = { forward: 1, yaw: 0, lift: 0, dash: false };

function stubFly(): FlyActor {
  const group = new THREE.Group(), body = new THREE.Group();
  group.add(body);
  const actor: DrosophilaActor = { group, body, jersey: new THREE.MeshStandardMaterial(), setTeam() {}, animate() {} };
  return createFlyActor(actor);
}

function world(seed = 1): GardenWorld {
  return new GardenWorld(new THREE.Scene(), { seed, fly: stubFly() });
}

function poseOf(predators: ReturnType<typeof createPredators>) {
  return predators.map(predator => ({
    kind: predator.kind,
    x: predator.group.position.x, y: predator.group.position.y, z: predator.group.position.z,
    striking: predator.striking,
  }));
}

test('seeded predator paths are deterministic', () => {
  const fly = { x: 16, y: 1, z: 16 };
  const a = createPredators(7), b = createPredators(7), c = createPredators(11);
  for (let i = 0; i < 180; i++) {
    for (const predator of a) predator.update(1 / 60, fly);
    for (const predator of b) predator.update(1 / 60, fly);
    for (const predator of c) predator.update(1 / 60, fly);
  }
  assert.deepEqual(poseOf(a), poseOf(b));
  const humanA = a.find(predator => predator.kind === 'human')!;
  const humanC = c.find(predator => predator.kind === 'human')!;
  assert.ok(Math.hypot(humanA.group.position.x - humanC.group.position.x, humanA.group.position.z - humanC.group.position.z) > 0.2);
  a.forEach(predator => predator.dispose());
  b.forEach(predator => predator.dispose());
  c.forEach(predator => predator.dispose());
});

test('a fly at the swat AABB during strike is hit', () => {
  const sim = world(3);
  try {
    const swat = sim.predators.find(predator => predator.kind === 'swat')!;
    let struck = false;
    for (let i = 0; i < 900; i++) {
      sim.update(1 / 60, hold);
      if (!swat.striking) continue;
      const box = swat.strikeAabb();
      assert.ok(box);
      sim.fly.position.x = (box.min.x + box.max.x) / 2;
      sim.fly.position.y = (box.min.y + box.max.y) / 2;
      sim.fly.position.z = (box.min.z + box.max.z) / 2;
      sim.fly.velocity.x = 0; sim.fly.velocity.y = 0; sim.fly.velocity.z = 0;
      const obs = sim.update(0, hold);
      assert.equal(obs.hit, true);
      struck = true;
      break;
    }
    assert.equal(struck, true);
  } finally { sim.dispose(); }
});

test('silence does not invent motion toward safety', () => {
  const sim = world(9);
  try {
    const start = sim.observation();
    for (let i = 0; i < 90; i++) sim.update(1 / 60, null);
    const fallen = sim.observation();
    assert.ok(fallen.position.y < start.position.y);
    assert.ok(Math.abs(fallen.position.x - start.position.x) < 0.04);
    assert.ok(Math.abs(fallen.position.z - start.position.z) < 0.04);
    assert.equal(fallen.heading, start.heading);
    sim.reset(9);
    for (let i = 0; i < 40; i++) sim.update(1 / 60, forward);
    const powered = sim.observation();
    assert.ok(powered.position.z < start.position.z - 0.4);
    const before = { ...powered.position, vx: powered.velocity.x, vz: powered.velocity.z, heading: powered.heading };
    for (let i = 0; i < 45; i++) sim.update(1 / 60, null);
    const coast = sim.observation();
    assert.equal(coast.heading, before.heading);
    assert.ok(coast.position.y < before.y);
    const travelX = coast.position.x - before.x, travelZ = coast.position.z - before.z;
    assert.ok(travelX * before.vx + travelZ * before.vz > 0);
  } finally { sim.dispose(); }
});

test('reset restores spawn', () => {
  const sim = world(5);
  try {
    for (let i = 0; i < 80; i++) sim.update(1 / 60, { forward: 1, yaw: 0.4, lift: 0.3, dash: true });
    const moved = sim.observation();
    assert.ok(Math.hypot(moved.position.x - SPAWN.x, moved.position.y - SPAWN.y, moved.position.z - SPAWN.z) > 0.5);
    sim.reset(5);
    const obs = sim.observation();
    assert.deepEqual(obs.position, SPAWN);
    assert.deepEqual(obs.velocity, { x: 0, y: 0, z: 0 });
    assert.equal(obs.heading, 0);
    assert.equal(obs.hit, false);
    assert.equal(obs.grounded, false);
    const fresh = world(5);
    try {
      const a = sim.predators.find(predator => predator.kind === 'human')!.group.position;
      const b = fresh.predators.find(predator => predator.kind === 'human')!.group.position;
      assert.ok(Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.z - b.z) < 1e-9);
    } finally { fresh.dispose(); }
  } finally { sim.dispose(); }
});

test('dash briefly triples cruise speed', () => {
  const fly = stubFly();
  fly.reset({ x: 0, y: 1.4, z: 0 });
  fly.applyInput(forward, 1, 0);
  const cruise = Math.hypot(fly.velocity.x, fly.velocity.z);
  fly.reset({ x: 0, y: 1.4, z: 0 });
  fly.applyInput({ forward: 1, yaw: 0, lift: 0, dash: true }, 1, 0);
  const dash = Math.hypot(fly.velocity.x, fly.velocity.z);
  assert.ok(Math.abs(cruise - CRUISE_SPEED) < 0.08);
  assert.ok(Math.abs(dash / cruise - DASH_MULTIPLIER) < 0.12);
});

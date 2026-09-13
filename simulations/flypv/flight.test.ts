import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { boundedVelocity, CEILING, DRONE_RADIUS, manualVelocity, SPAWN, terrainHeight, WORLD_LIMIT, wrapAngle } from './flight.ts';
import { FlightPhysics, initPhysics } from './physics.ts';
import { createVillage } from './world.ts';

before(initPhysics);
const floor = { kind: 'box' as const, x: 0, y: -1, z: 0, hx: 120, hy: 1, hz: 120 };

test('body-relative controls, normalized diagonals, heading wrap and bounds', () => {
  const forward = manualVelocity({ forward: 1, strafe: 0, lift: 0, yaw: 0 }, 0, 7);
  assert.equal(forward.z, -7);
  const turned = manualVelocity({ forward: 1, strafe: 0, lift: 0, yaw: 0 }, Math.PI / 2, 7);
  assert.ok(Math.abs(turned.x + 7) < 1e-9);
  const diagonal = manualVelocity({ forward: 1, strafe: 1, lift: 0, yaw: 0 }, .7, 7);
  assert.ok(Math.abs(Math.hypot(diagonal.x, diagonal.z) - 7) < 1e-9);
  assert.ok(Math.abs(wrapAngle(Math.PI * 2 + .2) - .2) < 1e-9);
  assert.equal(boundedVelocity({ x: WORLD_LIMIT - 1, y: CEILING, z: 0 }, { x: 7, y: 2, z: -3 }).x, 0);
  assert.equal(boundedVelocity({ x: WORLD_LIMIT - 1, y: CEILING, z: 0 }, { x: -7, y: 2, z: -3 }).x, -7);
  assert.equal(boundedVelocity({ x: 0, y: CEILING, z: 0 }, { x: 0, y: 2, z: 0 }).y, 0);
  assert.equal(terrainHeight(0, 0), 0);
  assert.ok(terrainHeight(80, 70) > 0);
});

test('Rapier stops full-speed motion at a solid building wall', () => {
  const physics = new FlightPhysics([floor, { kind: 'box', x: 0, y: 7, z: 0, hx: 7, hy: 7, hz: 1 }]);
  try {
    physics.reset({ x: 0, y: 6, z: 12 }); let touched = false;
    for (let i = 0; i < 360; i++) { physics.step({ x: 0, y: 0, z: -14 }, 2); touched ||= physics.contact; assert.ok(physics.position().z > 1 + DRONE_RADIUS - .12); }
    assert.ok(touched);
    physics.reset(); assert.deepEqual(physics.position(), SPAWN); assert.deepEqual(physics.velocity(), { x: 0, y: 0, z: 0 });
  } finally { physics.dispose(); }
});

test('ground, ceiling and world boundaries remain solid under sustained input', () => {
  const physics = new FlightPhysics([floor]);
  try {
    physics.reset({ x: 0, y: 7, z: 0 });
    for (let i = 0; i < 300; i++) physics.step({ x: 0, y: -14, z: 0 }, 2);
    assert.ok(physics.position().y >= DRONE_RADIUS - .1);
    physics.reset({ x: 94, y: 43, z: 94 });
    for (let i = 0; i < 300; i++) physics.step({ x: 14, y: 14, z: 14 }, 2);
    const p = physics.position(); assert.ok(p.x < WORLD_LIMIT && p.z < WORLD_LIMIT && p.y < CEILING);
  } finally { physics.dispose(); }
});

test('actual village terrain and convex roofs preserve contact reporting', () => {
  const village = createVillage(), physics = new FlightPhysics(village.colliders);
  try {
    for (const sensitivity of [1, 1.5, 2]) {
      physics.reset();
      for (let i = 0; i < 240; i++) physics.step({ x: 0, y: -7.2, z: 0 }, sensitivity);
      assert.ok(physics.contact, `CCD resting terrain contact at sensitivity ${sensitivity}`);
      assert.ok(physics.position().y >= DRONE_RADIUS - .1);
    }
    // This is the convex gable roof of the actual house at (14, 20).
    physics.reset({ x: 14, y: 25, z: 20 });
    for (let i = 0; i < 400; i++) physics.step({ x: 0, y: -10, z: 0 }, 1);
    assert.ok(physics.position().y > 11.9 + DRONE_RADIUS - .15, 'The gable roof supports the aircraft');
  } finally {
    physics.dispose();
    village.group.traverse(object => { const mesh = object as import('three').Mesh; mesh.geometry?.dispose(); if (mesh.material) (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(material => material.dispose()); });
  }
});

test('unpowered physics keeps momentum, gravity and collisions active', () => {
  const physics = new FlightPhysics([floor]);
  try {
    physics.reset({ x: 0, y: 15, z: 0 });
    physics.body.setLinvel({ x: 4, y: 0, z: 0 }, true);
    for (let i = 0; i < 30; i++) physics.step(null, 1);
    assert.ok(physics.position().x > 1.8); assert.ok(physics.position().y < 14);
    assert.ok(physics.velocity().x > 3.9); assert.ok(physics.velocity().y < -4);
    for (let i = 0; i < 180; i++) physics.step(null, 1);
    assert.ok(physics.position().y >= DRONE_RADIUS - .1); assert.equal(physics.contact, true);
  } finally { physics.dispose(); }
});

test('flight ray clearances measure geometry and exclude the aircraft', () => {
  const physics = new FlightPhysics([floor, { kind: 'box', x: 0, y: 8, z: -12, hx: 4, hy: 8, hz: 1 }]);
  try {
    physics.reset({ x: 0, y: 8, z: 0 }); physics.step({ x: 0, y: 0, z: 0 }, 1);
    const clearances = physics.clearances(0);
    assert.ok(Math.abs(clearances[0] - (11 - DRONE_RADIUS)) < .01);
    assert.ok(Math.abs(clearances[6] - (8 - DRONE_RADIUS)) < .01);
    assert.equal(clearances[5], 24);
  } finally { physics.dispose(); }
});

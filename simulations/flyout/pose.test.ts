import assert from 'node:assert/strict';
import test from 'node:test';
import { IDLE_MOTION, flyLegPoints } from './pose.ts';

test('idle feet stay planted; a walk cycle lifts and strides opposite legs', () => {
  const idle = flyLegPoints(0, 1, 0, IDLE_MOTION);
  assert.equal(idle.length, 3);
  assert.ok(idle[2][1] < .12);
  const planted = flyLegPoints(0, -1, 0, { ...IDLE_MOTION, moving: true });
  const lifted = flyLegPoints(Math.PI / (2 * 14), -1, 0, { ...IDLE_MOTION, moving: true });
  assert.ok(lifted[2][1] > planted[2][1] + .1);
  const left = flyLegPoints(0.2, -1, 0, { ...IDLE_MOTION, moving: true });
  const right = flyLegPoints(0.2, 1, 0, { ...IDLE_MOTION, moving: true });
  assert.ok(Math.abs(left[2][1] - right[2][1]) > .05, 'Tripod gait keeps opposite front feet out of phase');
});

test('reach and throw raise the front legs; a swing braces the hind pair', () => {
  const idle = flyLegPoints(0, 1, 0, IDLE_MOTION);
  const reach = flyLegPoints(0, 1, 0, { ...IDLE_MOTION, reaching: true });
  const throwPose = flyLegPoints(0, 1, 0, { ...IDLE_MOTION, throwing: true });
  const hind = flyLegPoints(0, 1, 2, { ...IDLE_MOTION, swinging: true });
  const idleHind = flyLegPoints(0, 1, 2, IDLE_MOTION);
  assert.ok(reach[2][2] > idle[2][2] + .3);
  assert.ok(throwPose[2][1] > idle[2][1] + .4);
  assert.ok(hind[2][2] < idleHind[2][2]);
  assert.ok(flyLegPoints(0, 1, 0, { ...IDLE_MOTION, moving: true })[2][1] >= .04);
});

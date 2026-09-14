import * as THREE from 'three';
import { createDrosophila, type DrosophilaActor } from '../../src/flyModel.ts';
import { CEILING, SPAWN, WORLD_LIMIT, type FlysimInput, type Vec3 } from './types.ts';

export const FLY_SCALE = 0.45;
export const FLY_COLOR = 0x8a6238;
export const CRUISE_SPEED = 2.35;
export const DASH_MULTIPLIER = 3;
export const YAW_SPEED = 2.85;
export const LIFT_SPEED = 1.9;
export const DASH_TIME = 0.24;
export const DASH_COOLDOWN = 0.62;
export const GROUND = 0;
export const FLY_RADIUS = 0.12;

export interface FlyActor {
  group: THREE.Group;
  position: Vec3;
  heading: number;
  velocity: Vec3;
  applyInput(input: FlysimInput, dt: number, heading: number): { velocity: Vec3; heading: number };
  animate(time: number, moving: boolean, hit: boolean): void;
  reset(position?: Vec3): void;
}

function wrap(value: number): number { return Math.atan2(Math.sin(value), Math.cos(value)); }
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }

export function createFlyActor(source?: DrosophilaActor): FlyActor {
  const actor = source ?? createDrosophila(FLY_COLOR, FLY_SCALE);
  if (!source) actor.body.rotation.y = Math.PI;
  const position = { ...SPAWN };
  const velocity = { x: 0, y: 0, z: 0 };
  let heading = 0;
  let dashTimer = 0;
  let dashCooldown = 0;
  const group = actor.group;
  group.position.set(position.x, position.y, position.z);

  const sync = () => {
    group.position.set(position.x, position.y, position.z);
    group.rotation.order = 'YXZ';
    group.rotation.y = heading;
    group.rotation.x = clamp(-velocity.y * 0.05, -0.32, 0.32);
    group.rotation.z = clamp(velocity.x * Math.cos(heading) * 0.03, -0.22, 0.22);
  };

  return {
    group,
    position,
    get heading() { return heading; },
    set heading(value) { heading = wrap(value); },
    velocity,
    applyInput(input: FlysimInput, dt: number, current: number) {
      const yaw = clamp(input.yaw, -1, 1);
      const lift = clamp(input.lift, -1, 1);
      let forward = clamp(input.forward, -1, 1);
      dashCooldown = Math.max(0, dashCooldown - dt);
      dashTimer = Math.max(0, dashTimer - dt);
      if (input.dash && dashTimer <= 0 && dashCooldown <= 0) {
        dashTimer = DASH_TIME;
        dashCooldown = DASH_COOLDOWN;
      }
      const dashing = dashTimer > 0;
      if (dashing) forward = Math.max(forward, 1);
      heading = wrap(current + yaw * YAW_SPEED * dt);
      const speed = CRUISE_SPEED * (dashing ? DASH_MULTIPLIER : 1);
      const desired = {
        x: -Math.sin(heading) * forward * speed,
        y: lift * LIFT_SPEED * (dashing ? DASH_MULTIPLIER : 1),
        z: -Math.cos(heading) * forward * speed,
      };
      const gain = 1 - Math.exp(-8.2 * Math.max(0, dt));
      velocity.x += (desired.x - velocity.x) * gain;
      velocity.y += (desired.y - velocity.y) * gain;
      velocity.z += (desired.z - velocity.z) * gain;
      return { velocity: { ...velocity }, heading };
    },
    animate(time: number, moving: boolean, hit: boolean) {
      actor.animate(time, { moving, swinging: hit }, false);
      if (hit) actor.setTeam(0xb03a32);
    },
    reset(origin: Vec3 = SPAWN) {
      position.x = origin.x; position.y = origin.y; position.z = origin.z;
      velocity.x = 0; velocity.y = 0; velocity.z = 0;
      heading = 0; dashTimer = 0; dashCooldown = 0;
      actor.setTeam(FLY_COLOR);
      group.rotation.set(0, 0, 0);
      sync();
    },
  };
}

export function coastFly(fly: FlyActor, dt: number): void {
  const drag = Math.exp(-1.35 * dt);
  fly.velocity.x *= drag;
  fly.velocity.z *= drag;
  fly.velocity.y = fly.velocity.y * Math.exp(-0.28 * dt) - 5.4 * dt;
}

export function integrateFly(fly: FlyActor, dt: number): void {
  const p = fly.position, v = fly.velocity;
  p.x += v.x * dt; p.y += v.y * dt; p.z += v.z * dt;
  if (Math.abs(p.x) > WORLD_LIMIT) { p.x = Math.sign(p.x) * WORLD_LIMIT; if (p.x * v.x > 0) v.x = 0; }
  if (Math.abs(p.z) > WORLD_LIMIT) { p.z = Math.sign(p.z) * WORLD_LIMIT; if (p.z * v.z > 0) v.z = 0; }
  if (p.y > CEILING) { p.y = CEILING; if (v.y > 0) v.y = 0; }
  if (p.y < GROUND) {
    p.y = GROUND;
    if (v.y < 0) v.y = 0;
    const grip = Math.exp(-4.5 * dt);
    v.x *= grip; v.z *= grip;
  }
  fly.group.position.set(p.x, p.y, p.z);
  fly.group.rotation.order = 'YXZ';
  fly.group.rotation.y = fly.heading;
  fly.group.rotation.x = clamp(-v.y * 0.05, -0.32, 0.32);
}

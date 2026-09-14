import * as THREE from 'three';
import type { ThreatKind, ThreatObservation, Vec3 } from './types.ts';

export const SENSOR_RANGE = 10;
export const POND = { x: -5.4, y: 0.02, z: -4.8 };
export const FLY_HIT_RADIUS = 0.12;

export interface StrikeAabb { min: Vec3; max: Vec3 }

export interface Predator {
  kind: ThreatKind;
  group: THREE.Group;
  striking: boolean;
  update(dt: number, flyPos: Vec3): void;
  threatObservation(flyPos: Vec3, flyVel: Vec3): ThreatObservation | null;
  hits(flyPos: Vec3, radius?: number): boolean;
  strikeAabb(): StrikeAabb | null;
  reset(seed: number): void;
  dispose(): void;
}

const boxGeo = new THREE.BoxGeometry(1, 1, 1);
const sphereGeo = new THREE.SphereGeometry(1, 10, 8);
const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 8);
const coneGeo = new THREE.ConeGeometry(1, 1, 8);

function rng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function wrap(value: number): number { return Math.atan2(Math.sin(value), Math.cos(value)); }

function observe(kind: ThreatKind, origin: Vec3, flyPos: Vec3, flyVel: Vec3, threatVel: Vec3): ThreatObservation | null {
  const dx = origin.x - flyPos.x, dy = origin.y - flyPos.y, dz = origin.z - flyPos.z;
  const range = Math.hypot(dx, dy, dz);
  if (range > SENSOR_RANGE) return null;
  const inv = range > 1e-6 ? 1 / range : 0;
  const closing = -((threatVel.x - flyVel.x) * dx + (threatVel.y - flyVel.y) * dy + (threatVel.z - flyVel.z) * dz) * inv;
  return { kind, dx, dy, dz, range, closing };
}

function inAabb(box: StrikeAabb, p: Vec3, r: number): boolean {
  return p.x + r >= box.min.x && p.x - r <= box.max.x
    && p.y + r >= box.min.y && p.y - r <= box.max.y
    && p.z + r >= box.min.z && p.z - r <= box.max.z;
}

function pointToSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const length = Math.hypot(abx, aby, abz) || 1e-6;
  const t = Math.min(1, Math.max(0, ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / (length * length)));
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t), p.z - (a.z + abz * t));
}

function mesh(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, sx: number, sy: number, sz: number): THREE.Mesh {
  const object = new THREE.Mesh(geo, mat);
  object.position.set(x, y, z); object.scale.set(sx, sy, sz);
  object.castShadow = true; object.receiveShadow = true; parent.add(object); return object;
}

const HUMAN_PATH: Array<[number, number]> = [
  [3.35, 3.7], [5.55, 1.35], [4.15, -1.7], [1.15, -2.25], [-0.55, 0.85], [1.35, 3.55],
];

function pathLength(points: Array<[number, number]>): number {
  let length = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    length += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return length;
}

function pathPoint(points: Array<[number, number]>, distance: number, offsetX: number, offsetZ: number): { x: number; z: number; yaw: number } {
  const total = pathLength(points);
  let remain = ((distance % total) + total) % total;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const span = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (remain <= span || i === points.length - 1) {
      const t = span > 1e-6 ? remain / span : 0;
      const x = a[0] + (b[0] - a[0]) * t + offsetX;
      const z = a[1] + (b[1] - a[1]) * t + offsetZ;
      return { x, z, yaw: Math.atan2(b[0] - a[0], b[1] - a[1]) };
    }
    remain -= span;
  }
  return { x: points[0][0] + offsetX, z: points[0][1] + offsetZ, yaw: 0 };
}

function createHuman(seed: number): { human: Predator; swat: Predator } {
  const group = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: 0x8a6a54, roughness: 0.78 });
  const shirt = new THREE.MeshStandardMaterial({ color: 0x3e4a44, roughness: 0.86 });
  const pants = new THREE.MeshStandardMaterial({ color: 0x2c2a28, roughness: 0.9 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x4a382c, roughness: 0.82 });
  const meshMat = new THREE.MeshStandardMaterial({ color: 0xb7a48c, roughness: 0.7 });
  const hair = new THREE.MeshStandardMaterial({ color: 0x241c18, roughness: 0.92 });
  const materials = [skin, shirt, pants, wood, meshMat, hair];
  const hips = new THREE.Group(); group.add(hips);
  mesh(hips, boxGeo, pants, -0.1, 0.42, 0, 0.14, 0.78, 0.14);
  mesh(hips, boxGeo, pants, 0.1, 0.42, 0, 0.14, 0.78, 0.14);
  mesh(group, boxGeo, shirt, 0, 1.08, 0, 0.42, 0.58, 0.26);
  mesh(group, sphereGeo, skin, 0, 1.52, 0.02, 0.15, 0.17, 0.16);
  mesh(group, sphereGeo, hair, 0, 1.62, -0.02, 0.16, 0.1, 0.15);
  const arm = new THREE.Group(); arm.position.set(0.3, 1.22, 0.02); group.add(arm);
  mesh(arm, boxGeo, shirt, 0, -0.16, 0, 0.1, 0.38, 0.1);
  const swatGroup = new THREE.Group(); arm.add(swatGroup);
  mesh(swatGroup, cylGeo, wood, 0, -0.5, 0, 0.018, 0.72, 0.018);
  const paddle = mesh(swatGroup, boxGeo, meshMat, 0, -0.9, 0, 0.38, 0.03, 0.24);
  const paddleWorld = new THREE.Vector3();
  const lastPos = { x: 0, y: 0, z: 0 };
  const vel = { x: 0, y: 0, z: 0 };
  const paddlePos = { x: 0, y: 1, z: 0 };
  let time = 0, phase = 0, offsetX = 0, offsetZ = 0, speed = 0.9, striking = false;

  const boot = (s: number) => {
    const random = rng(s ^ 0x51ed21a5);
    time = 0; phase = random() * Math.PI * 2;
    offsetX = (random() - 0.5) * 0.9; offsetZ = (random() - 0.5) * 0.9;
    speed = 0.82 + random() * 0.28;
    striking = false;
    const pose = pathPoint(HUMAN_PATH, 0, offsetX, offsetZ);
    group.position.set(pose.x, 0, pose.z); group.rotation.y = pose.yaw;
    lastPos.x = pose.x; lastPos.y = 0; lastPos.z = pose.z;
    vel.x = vel.y = vel.z = 0; arm.rotation.set(0.15, 0, 0.12);
  };
  boot(seed);

  const step = (dt: number) => {
    time += dt;
    const pose = pathPoint(HUMAN_PATH, time * speed, offsetX, offsetZ);
    const inv = dt > 1e-8 ? 1 / dt : 0;
    vel.x = (pose.x - lastPos.x) * inv; vel.y = 0; vel.z = (pose.z - lastPos.z) * inv;
    lastPos.x = pose.x; lastPos.z = pose.z;
    group.position.set(pose.x, Math.sin(time * 8.4) * 0.02, pose.z);
    group.rotation.y = pose.yaw;
    hips.children[0].rotation.x = Math.sin(time * 6.2) * 0.45;
    hips.children[1].rotation.x = Math.sin(time * 6.2 + Math.PI) * 0.45;
    const cycle = (time + phase) % 3.35;
    striking = cycle > 2.82 && cycle < 3.2;
    if (striking) {
      const u = (cycle - 2.82) / 0.38;
      arm.rotation.x = -1.05 + u * 2.15;
      arm.rotation.z = 0.05;
    } else {
      arm.rotation.x = 0.18 + Math.sin(time * 6.2) * 0.12;
      arm.rotation.z = 0.14;
    }
    group.updateMatrixWorld(true);
    paddle.getWorldPosition(paddleWorld);
    paddlePos.x = paddleWorld.x; paddlePos.y = paddleWorld.y; paddlePos.z = paddleWorld.z;
  };

  const aabb = (): StrikeAabb => ({
    min: { x: paddlePos.x - 0.22, y: paddlePos.y - 0.16, z: paddlePos.z - 0.2 },
    max: { x: paddlePos.x + 0.22, y: paddlePos.y + 0.16, z: paddlePos.z + 0.2 },
  });

  const human: Predator = {
    kind: 'human', group, get striking() { return false; },
    update: step,
    threatObservation: (flyPos, flyVel) => observe('human', { x: group.position.x, y: 1.2, z: group.position.z }, flyPos, flyVel, vel),
    hits: () => false,
    strikeAabb: () => null,
    reset: boot,
    dispose() { materials.forEach(material => material.dispose()); group.removeFromParent(); },
  };
  const swat: Predator = {
    kind: 'swat', group: swatGroup, get striking() { return striking; },
    update() {},
    threatObservation: (flyPos, flyVel) => observe('swat', paddlePos, flyPos, flyVel, vel),
    hits(flyPos, radius = FLY_HIT_RADIUS) { return striking && inAabb(aabb(), flyPos, radius); },
    strikeAabb: aabb,
    reset() {},
    dispose() {},
  };
  return { human, swat };
}

function createFrog(seed: number): Predator {
  const group = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: 0x3a5a3c, roughness: 0.74 });
  const belly = new THREE.MeshStandardMaterial({ color: 0x8a8458, roughness: 0.8 });
  const eye = new THREE.MeshStandardMaterial({ color: 0xc8c45c, roughness: 0.45 });
  const pupil = new THREE.MeshStandardMaterial({ color: 0x1a1814, roughness: 0.4 });
  const tongueMat = new THREE.MeshStandardMaterial({ color: 0xa45a58, roughness: 0.55 });
  const materials = [skin, belly, eye, pupil, tongueMat];
  mesh(group, sphereGeo, skin, 0, 0.16, 0, 0.28, 0.16, 0.34);
  mesh(group, sphereGeo, belly, 0, 0.1, 0.08, 0.2, 0.1, 0.22);
  for (const side of [-1, 1]) {
    mesh(group, sphereGeo, eye, side * 0.14, 0.28, 0.16, 0.07, 0.07, 0.07);
    mesh(group, sphereGeo, pupil, side * 0.14, 0.3, 0.21, 0.03, 0.03, 0.03);
    mesh(group, sphereGeo, skin, side * 0.18, 0.05, -0.16, 0.08, 0.05, 0.1);
  }
  const tongue = new THREE.Mesh(cylGeo, tongueMat);
  tongue.castShadow = true; group.add(tongue);
  const mouth = new THREE.Vector3();
  const tip = new THREE.Vector3();
  const vel = { x: 0, y: 0, z: 0 };
  let time = 0, cooldown = 0, lunge = 0, length = 0.08, striking = false;
  let originX = 0, originZ = 0, heading = 0;
  const lungeDir = { x: 0, y: 0, z: 1 };

  const boot = (s: number) => {
    const random = rng(s ^ 0xa341316c);
    time = 0; cooldown = 0.4 + random(); lunge = 0; length = 0.08; striking = false;
    originX = POND.x + 1.35 + (random() - 0.5) * 0.5;
    originZ = POND.z + 1.55 + (random() - 0.5) * 0.5;
    heading = Math.atan2(-originX, -originZ);
    group.position.set(originX, 0, originZ); group.rotation.y = heading;
  };
  boot(seed);

  const placeTongue = () => {
    const reach = Math.max(0.08, length);
    const pitch = Math.atan2(lungeDir.y, Math.hypot(lungeDir.x, lungeDir.z) || 1e-6);
    tongue.scale.set(0.035, reach, 0.035);
    tongue.rotation.set(Math.PI / 2 - pitch, 0, 0);
    tongue.position.set(0, 0.16 + lungeDir.y * reach / 2, 0.22 + Math.cos(pitch) * reach / 2);
    group.updateMatrixWorld(true);
    mouth.set(0, 0.16, 0.22).applyMatrix4(group.matrixWorld);
    tip.set(lungeDir.x, lungeDir.y, lungeDir.z).multiplyScalar(reach).add(mouth);
  };

  return {
    kind: 'frog', group, get striking() { return striking; },
    update(dt, flyPos) {
      time += dt;
      group.position.y = Math.sin(time * 2.1) * 0.012;
      cooldown = Math.max(0, cooldown - dt);
      const dx = flyPos.x - group.position.x, dy = flyPos.y - 0.18, dz = flyPos.z - group.position.z;
      const range = Math.hypot(dx, dy, dz);
      if (lunge <= 0 && cooldown <= 0 && range < 2.85 && flyPos.y < 1.65) {
        lunge = 0.55; cooldown = 1.55;
        const inv = range > 1e-6 ? 1 / range : 1;
        lungeDir.x = dx * inv; lungeDir.y = dy * inv; lungeDir.z = dz * inv;
        heading = wrap(Math.atan2(dx, dz));
        group.rotation.y = heading;
      }
      if (lunge > 0) {
        lunge = Math.max(0, lunge - dt);
        const u = 1 - lunge / 0.55;
        length = u < 0.28 ? (u / 0.28) * Math.min(2.35, range + 0.15) : u > 0.72 ? Math.min(2.35, range + 0.15) * (1 - (u - 0.72) / 0.28) : Math.min(2.35, range + 0.15);
        striking = u > 0.16 && u < 0.72 && length > 0.25;
      } else {
        length = 0.08; striking = false;
      }
      placeTongue();
    },
    threatObservation: (flyPos, flyVel) => observe('frog', { x: group.position.x, y: 0.2, z: group.position.z }, flyPos, flyVel, vel),
    hits(flyPos, radius = FLY_HIT_RADIUS) {
      if (!striking) return false;
      return pointToSegment(flyPos, { x: mouth.x, y: mouth.y, z: mouth.z }, { x: tip.x, y: tip.y, z: tip.z }) < 0.14 + radius;
    },
    strikeAabb() {
      if (!striking) return null;
      return {
        min: { x: Math.min(mouth.x, tip.x) - 0.12, y: Math.min(mouth.y, tip.y) - 0.1, z: Math.min(mouth.z, tip.z) - 0.12 },
        max: { x: Math.max(mouth.x, tip.x) + 0.12, y: Math.max(mouth.y, tip.y) + 0.1, z: Math.max(mouth.z, tip.z) + 0.12 },
      };
    },
    reset: boot,
    dispose() { materials.forEach(material => material.dispose()); group.removeFromParent(); },
  };
}

function createBird(seed: number): Predator {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x3a3532, roughness: 0.7 });
  const belly = new THREE.MeshStandardMaterial({ color: 0x6a5c4e, roughness: 0.78 });
  const beak = new THREE.MeshStandardMaterial({ color: 0xb47a3a, roughness: 0.5 });
  const wingMat = new THREE.MeshStandardMaterial({ color: 0x2c2a28, roughness: 0.76, side: THREE.DoubleSide });
  const materials = [bodyMat, belly, beak, wingMat];
  mesh(group, sphereGeo, bodyMat, 0, 0, 0, 0.18, 0.12, 0.28);
  mesh(group, sphereGeo, belly, 0, -0.04, 0.02, 0.12, 0.08, 0.2);
  mesh(group, coneGeo, beak, 0, -0.01, 0.32, 0.05, 0.16, 0.05).rotation.x = Math.PI / 2;
  const left = mesh(group, boxGeo, wingMat, -0.28, 0.02, 0, 0.42, 0.025, 0.18);
  const right = mesh(group, boxGeo, wingMat, 0.28, 0.02, 0, 0.42, 0.025, 0.18);
  const last = { x: 0, y: 0, z: 0 };
  const vel = { x: 0, y: 0, z: 0 };
  let time = 0, phase = 0, cx = 0, cz = 0, rx = 0, rz = 0, height = 0, rate = 0;
  let stoop = 0, recover = 0, striking = false;
  const stoopTarget = { x: 0, y: 0, z: 0 };

  const loop = (t: number) => {
    const a = t * rate + phase;
    return {
      x: cx + Math.cos(a) * rx,
      y: height + Math.sin(a * 2.2) * 0.35,
      z: cz + Math.sin(a * 2) * rz,
    };
  };

  const boot = (s: number) => {
    const random = rng(s ^ 0xc8013ea4);
    time = 0; phase = random() * Math.PI * 2;
    cx = (random() - 0.5) * 2.4; cz = -1.6 + (random() - 0.5) * 2;
    rx = 5.4 + random() * 1.4; rz = 3.8 + random() * 1.2;
    height = 5.15 + random() * 0.5; rate = 0.42 + random() * 0.12;
    stoop = 0; recover = 0; striking = false;
    const pose = loop(0);
    group.position.set(pose.x, pose.y, pose.z);
    last.x = pose.x; last.y = pose.y; last.z = pose.z;
    vel.x = vel.y = vel.z = 0;
  };
  boot(seed);

  return {
    kind: 'bird', group, get striking() { return striking; },
    update(dt, flyPos) {
      time += dt;
      const flap = Math.sin(time * 14) * 0.38;
      left.rotation.z = 0.22 + flap; right.rotation.z = -0.22 - flap;
      const cruise = loop(time);
      const dx = flyPos.x - group.position.x, dy = flyPos.y - group.position.y, dz = flyPos.z - group.position.z;
      const range = Math.hypot(dx, dy, dz);
      if (stoop <= 0 && recover <= 0 && range < 4.3 && flyPos.y > 0.7) {
        stoop = 0.72; stoopTarget.x = flyPos.x; stoopTarget.y = flyPos.y; stoopTarget.z = flyPos.z;
      }
      let pose = cruise;
      if (stoop > 0) {
        stoop = Math.max(0, stoop - dt);
        const u = 1 - stoop / 0.72;
        pose = {
          x: cruise.x + (stoopTarget.x - cruise.x) * u,
          y: cruise.y + (stoopTarget.y - cruise.y) * Math.min(1, u * 1.15),
          z: cruise.z + (stoopTarget.z - cruise.z) * u,
        };
        striking = u > 0.35 && u < 0.92;
        if (stoop <= 0) recover = 1.05;
      } else if (recover > 0) {
        recover = Math.max(0, recover - dt);
        const u = 1 - recover / 1.05;
        pose = {
          x: stoopTarget.x + (cruise.x - stoopTarget.x) * u,
          y: stoopTarget.y + (cruise.y - stoopTarget.y) * u,
          z: stoopTarget.z + (cruise.z - stoopTarget.z) * u,
        };
        striking = false;
      }
      const inv = dt > 1e-8 ? 1 / dt : 0;
      vel.x = (pose.x - last.x) * inv; vel.y = (pose.y - last.y) * inv; vel.z = (pose.z - last.z) * inv;
      last.x = pose.x; last.y = pose.y; last.z = pose.z;
      group.position.set(pose.x, pose.y, pose.z);
      if (Math.hypot(vel.x, vel.z) > 0.05) group.rotation.y = Math.atan2(vel.x, vel.z);
      group.rotation.x = THREE.MathUtils.clamp(-vel.y * 0.08, -0.45, 0.35);
    },
    threatObservation: (flyPos, flyVel) => observe('bird', { x: group.position.x, y: group.position.y, z: group.position.z }, flyPos, flyVel, vel),
    hits(flyPos, radius = FLY_HIT_RADIUS) {
      if (!striking) return false;
      return Math.hypot(flyPos.x - group.position.x, flyPos.y - group.position.y, flyPos.z - group.position.z) < 0.42 + radius;
    },
    strikeAabb() {
      if (!striking) return null;
      const p = group.position;
      return { min: { x: p.x - 0.4, y: p.y - 0.28, z: p.z - 0.4 }, max: { x: p.x + 0.4, y: p.y + 0.28, z: p.z + 0.4 } };
    },
    reset: boot,
    dispose() { materials.forEach(material => material.dispose()); group.removeFromParent(); },
  };
}

export function createPredators(seed: number): Predator[] {
  const pair = createHuman(seed);
  return [pair.human, pair.swat, createFrog(seed), createBird(seed)];
}

import * as THREE from 'three';
import { coastFly, createFlyActor, FLY_RADIUS, GROUND, integrateFly, type FlyActor } from './fly-actor.ts';
import { createPredators, POND, type Predator } from './predators.ts';
import { SPAWN, type FlysimInput, type FlysimObservation, type Vec3 } from './types.ts';

export interface Garden {
  group: THREE.Group;
  food: Vec3;
  pond: Vec3;
  dispose(): void;
}

const palette = {
  grass: 0x3a4a32, moss: 0x2c3828, soil: 0x3d3428, wood: 0x5c4638, timber: 0x3a2c24,
  water: 0x2a4548, stone: 0x6a6560, stoneDark: 0x4a4642, foliage: 0x2f4a34,
  leaf: 0x3d5a3c, canopy: 0x24382c, fruit: 0x8a4034, peach: 0xb56a3a, sky: 0x627078,
};

export function createGarden(scene: THREE.Scene): Garden {
  const group = new THREE.Group();
  const materials = new Map<number, THREE.MeshStandardMaterial>();
  const geometries: THREE.BufferGeometry[] = [];
  const extras: THREE.Material[] = [];
  const material = (color: number, roughness = 0.9) => {
    let m = materials.get(color);
    if (!m) { m = new THREE.MeshStandardMaterial({ color, roughness, flatShading: true }); materials.set(color, m); }
    return m;
  };
  const cube = new THREE.BoxGeometry(1, 1, 1);
  const cylinder = new THREE.CylinderGeometry(1, 1, 1, 8);
  const sphere = new THREE.IcosahedronGeometry(1, 0);
  const cone = new THREE.ConeGeometry(1, 1, 6);
  geometries.push(cube, cylinder, sphere, cone);
  const dummy = new THREE.Object3D();
  const batches = new Map<string, { geo: THREE.BufferGeometry; mat: THREE.Material; matrices: THREE.Matrix4[] }>();
  const instance = (geo: THREE.BufferGeometry, color: number, x: number, y: number, z: number, sx: number, sy: number, sz: number, yaw = 0) => {
    const key = `${geo.uuid}:${color}`;
    let batch = batches.get(key);
    if (!batch) { batch = { geo, mat: material(color), matrices: [] }; batches.set(key, batch); }
    dummy.position.set(x, y, z); dummy.rotation.set(0, yaw, 0); dummy.scale.set(sx, sy, sz); dummy.updateMatrix();
    batch.matrices.push(dummy.matrix.clone());
  };

  scene.background = new THREE.Color(palette.sky);
  scene.fog = new THREE.Fog(0x5c6560, 16, 46);
  const hemi = new THREE.HemisphereLight(0xb7c4c8, 0x3e4a38, 0.92);
  const sun = new THREE.DirectionalLight(0xf0d2a8, 1.55);
  sun.position.set(-14, 16, 9); sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -22; sun.shadow.camera.right = 22;
  sun.shadow.camera.top = 20; sun.shadow.camera.bottom = -20;
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 58;
  sun.shadow.normalBias = 0.04; sun.shadow.bias = -0.0002;
  group.add(hemi, sun);

  const groundGeo = new THREE.PlaneGeometry(42, 42, 20, 20);
  groundGeo.rotateX(-Math.PI / 2);
  const position = groundGeo.getAttribute('position');
  const colors = new Float32Array(position.count * 3);
  const color = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), z = position.getZ(i);
    const patch = Math.sin(x * 0.31 + z * 0.27) * Math.cos(z * 0.19 - x * 0.14);
    const dip = Math.hypot(x - POND.x, z - POND.z) < 2.1 ? -0.08 : 0;
    position.setY(i, dip + patch * 0.04);
    color.setHSL(0.22 + patch * 0.02, 0.26 + patch * 0.05, 0.26 + patch * 0.05, THREE.SRGBColorSpace);
    colors.set([color.r, color.g, color.b], i * 3);
  }
  groundGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  groundGeo.computeVertexNormals();
  geometries.push(groundGeo);
  const groundMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true });
  extras.push(groundMat);
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.receiveShadow = true; group.add(ground);

  const waterGeo = new THREE.CircleGeometry(1.85, 16);
  waterGeo.rotateX(-Math.PI / 2);
  geometries.push(waterGeo);
  const waterMat = new THREE.MeshStandardMaterial({ color: palette.water, roughness: 0.28, metalness: 0.22 });
  extras.push(waterMat);
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.position.set(POND.x, 0.03, POND.z); group.add(water);
  for (let i = 0; i < 10; i++) {
    const a = i / 10 * Math.PI * 2;
    instance(cube, palette.stone, POND.x + Math.cos(a) * 1.95, 0.07, POND.z + Math.sin(a) * 1.72, 0.42, 0.14, 0.28, a);
  }

  instance(cube, palette.soil, 2.2, 0.03, 0.95, 2.8, 0.06, 1.7);
  instance(cube, palette.wood, 2.2, 0.74, 0.95, 2.35, 0.08, 1.15);
  for (const [x, z] of [[1.25, 0.45], [3.15, 0.45], [1.25, 1.45], [3.15, 1.45]] as const) {
    instance(cube, palette.timber, x, 0.36, z, 0.1, 0.72, 0.1);
  }
  instance(cube, palette.timber, 2.2, 0.42, 0.18, 2.2, 0.06, 0.32);
  instance(cube, palette.timber, 2.2, 0.42, 1.72, 2.2, 0.06, 0.32);
  const food = { x: 2.05, y: 0.9, z: 0.82 };
  instance(sphere, palette.fruit, food.x, food.y, food.z, 0.09, 0.08, 0.09);
  instance(sphere, palette.peach, food.x + 0.16, food.y - 0.01, food.z + 0.1, 0.07, 0.06, 0.07);
  instance(sphere, 0x6a7a38, food.x - 0.12, food.y - 0.02, food.z - 0.08, 0.06, 0.05, 0.06);

  const trees: Array<[number, number, number]> = [
    [-11.5, 8.4, 3.6], [10.8, -7.2, 4.1], [-8.6, -11.2, 3.2], [12.2, 9.5, 3.8],
    [-13.2, -3.1, 4.4], [7.4, 12.6, 3.3], [-4.8, 12.1, 2.8],
  ];
  for (const [x, z, h] of trees) {
    instance(cylinder, palette.timber, x, h * 0.32, z, 0.16, h * 0.64, 0.16);
    instance(sphere, palette.canopy, x, h * 0.72, z, h * 0.38, h * 0.34, h * 0.36);
    instance(sphere, palette.foliage, x + 0.35, h * 0.78, z - 0.2, h * 0.28, h * 0.26, h * 0.27);
  }
  const bushes: Array<[number, number]> = [
    [-3.6, -3.1], [-6.8, -6.4], [-7.4, -3.2], [4.8, 4.2], [5.6, -3.4],
    [-2.2, 5.8], [8.2, 2.4], [-10.4, 2.6], [0.8, -8.5], [3.2, 8.4],
  ];
  for (const [x, z] of bushes) {
    instance(sphere, palette.leaf, x, 0.38, z, 0.55, 0.42, 0.5);
    instance(sphere, palette.foliage, x + 0.22, 0.32, z + 0.12, 0.38, 0.3, 0.34);
  }
  for (let i = -12; i <= 12; i += 2.4) instance(cube, palette.stoneDark, i, 0.38, -16.2, 0.18, 0.76, 0.16);
  for (let k = 0; k < 90; k++) {
    const a = (k * 2.39996) % (Math.PI * 2), r = 3.2 + (k % 7) * 1.55;
    const x = Math.cos(a) * r + (k % 3) * 0.4, z = Math.sin(a * 1.13) * r * 0.85;
    if (Math.hypot(x - POND.x, z - POND.z) < 2.3) continue;
    instance(cone, k % 3 ? palette.grass : palette.moss, x, 0.12, z, 0.07, 0.22 + (k % 5) * 0.03, 0.07, a);
  }

  for (const batch of batches.values()) {
    const mesh = new THREE.InstancedMesh(batch.geo, batch.mat, batch.matrices.length);
    batch.matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.computeBoundingSphere(); group.add(mesh);
  }

  scene.add(group);
  return {
    group, food, pond: { ...POND },
    dispose() {
      group.removeFromParent();
      group.traverse(object => {
        if (!(object instanceof THREE.Mesh) && !(object instanceof THREE.InstancedMesh)) return;
        if (object.geometry && !geometries.includes(object.geometry)) object.geometry.dispose();
      });
      geometries.forEach(geo => geo.dispose());
      extras.forEach(mat => mat.dispose());
      materials.forEach(mat => mat.dispose());
    },
  };
}

export class GardenWorld {
  readonly fly: FlyActor;
  readonly predators: Predator[];
  private readonly scene: THREE.Scene;
  private readonly garden: Garden;
  private readonly look = new THREE.Vector3();
  private elapsed = 0;
  private hitFlag = false;
  private seed: number;
  private disposed = false;

  constructor(scene: THREE.Scene, options: { seed?: number; fly?: FlyActor } = {}) {
    this.scene = scene;
    this.seed = options.seed ?? 1;
    this.garden = createGarden(scene);
    this.fly = options.fly ?? createFlyActor();
    if (!this.fly.group.parent) scene.add(this.fly.group);
    this.predators = createPredators(this.seed);
    this.mountPredators();
    this.reset(this.seed);
  }

  private mountPredators(): void {
    for (const predator of this.predators) {
      if (!predator.group.parent) this.scene.add(predator.group);
    }
  }

  update(dt: number, input: FlysimInput | null): FlysimObservation {
    const step = Math.max(0, dt);
    this.elapsed += step;
    if (input) this.fly.applyInput(input, step, this.fly.heading);
    else coastFly(this.fly, step);
    integrateFly(this.fly, step);
    const flyPos = this.fly.position;
    for (const predator of this.predators) predator.update(step, flyPos);
    if (this.predators.some(predator => predator.hits(flyPos, FLY_RADIUS))) this.hitFlag = true;
    const moving = Math.hypot(this.fly.velocity.x, this.fly.velocity.y, this.fly.velocity.z) > 0.18;
    this.fly.animate(this.elapsed, moving && !this.hitFlag, this.hitFlag);
    return this.observation();
  }

  observation(): FlysimObservation {
    const position = { ...this.fly.position }, velocity = { ...this.fly.velocity };
    const threats = [];
    for (const predator of this.predators) {
      const threat = predator.threatObservation(position, velocity);
      if (threat) threats.push(threat);
    }
    return {
      position, velocity, heading: this.fly.heading, altitude: position.y, threats,
      food: { ...this.garden.food }, grounded: position.y <= GROUND + 1e-3, hit: this.hitFlag,
    };
  }

  cameraTarget(): THREE.Vector3 {
    return this.look.set(this.fly.position.x, this.fly.position.y, this.fly.position.z);
  }

  reset(seed: number = this.seed): void {
    this.seed = seed; this.elapsed = 0; this.hitFlag = false;
    this.fly.reset(SPAWN);
    for (const predator of this.predators) predator.reset(seed);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.fly.group.removeFromParent();
    for (const predator of this.predators) predator.dispose();
    this.garden.dispose();
    this.scene.fog = null;
  }
}

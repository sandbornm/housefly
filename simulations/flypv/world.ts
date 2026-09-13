import * as THREE from 'three';
import { terrainHeight } from './flight.ts';
import type { ColliderSpec } from './physics.ts';
import { surfaceMaterial } from './surfaces.ts';

export interface House { x: number; z: number; w: number; d: number; h: number; yaw: number; roof: number }
export interface Village { group: THREE.Group; colliders: ColliderSpec[]; houses: House[]; flags: THREE.Mesh[]; water: THREE.Mesh; }
const palette = { stone: 0x9ca6a2, stoneLight: 0xc8cec3, timber: 0x493a2d, plaster: 0xe8e3cd, dark: 0x273d3a, path: 0xb9b18d, slate: 0x4d6674, red: 0xa55e46, flag: 0xc85545 };

export function createVillage(): Village {
  const group = new THREE.Group();
  const colliders: ColliderSpec[] = [];
  const flags: THREE.Mesh[] = [];
  const materials = new Map<number, THREE.MeshStandardMaterial>();
  const material = (color: number) => {
    let m = materials.get(color);
    if (!m) {
      const surface = color === palette.stone || color === palette.stoneLight ? 'stone'
        : color === palette.timber || color === 0x927858 ? 'timber'
        : color === palette.slate || color === palette.red ? 'roof'
        : color === palette.plaster ? 'plaster' : color === palette.path || color === 0xc6bea1 ? 'paving' : undefined;
      m = surfaceMaterial(color, surface); materials.set(color, m);
    }
    return m;
  };
  const cube = new THREE.BoxGeometry(1, 1, 1);
  const cylinder = new THREE.CylinderGeometry(1, 1, 1, 10);
  const batches = new Map<string, { geo: THREE.BufferGeometry; mat: THREE.Material; matrices: THREE.Matrix4[] }>();
  const dummy = new THREE.Object3D();
  const instance = (geo: THREE.BufferGeometry, color: number, x: number, y: number, z: number, sx: number, sy: number, sz: number, yaw = 0, rz = 0) => {
    const key = `${geo.uuid}:${color}`;
    let batch = batches.get(key);
    if (!batch) { batch = { geo, mat: material(color), matrices: [] }; batches.set(key, batch); }
    dummy.position.set(x, y, z); dummy.rotation.set(0, yaw, rz); dummy.scale.set(sx, sy, sz); dummy.updateMatrix(); batch.matrices.push(dummy.matrix.clone());
  };
  const box = (x: number, y: number, z: number, w: number, h: number, d: number, color: number, yaw = 0, solid = false) => {
    instance(cube, color, x, y, z, w, h, d, yaw);
    if (solid) colliders.push({ kind: 'box', x, y, z, hx: w / 2, hy: h / 2, hz: d / 2, yaw });
  };

  const segments = 96, size = 240;
  const groundGeo = new THREE.PlaneGeometry(size, size, segments, segments);
  groundGeo.rotateX(-Math.PI / 2);
  const position = groundGeo.getAttribute('position');
  const colors = new Float32Array(position.count * 3);
  const color = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), z = position.getZ(i);
    position.setY(i, terrainHeight(x, z));
    const patch = Math.sin(x * .09 + z * .12) * Math.cos(z * .13 - x * .04);
    color.setHSL(.245 + patch * .025, .39 + patch * .06, .38 + patch * .065, THREE.SRGBColorSpace);
    colors.set([color.r, color.g, color.b], i * 3);
  }
  groundGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3)); groundGeo.computeVertexNormals();
  const ground = new THREE.Mesh(groundGeo, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 }));
  ground.receiveShadow = true; group.add(ground);
  colliders.push({ kind: 'terrain', vertices: new Float32Array(position.array), indices: new Uint32Array(groundGeo.index!.array) });

  // Roads are deliberately broad enough for the little quadcopter to pass between houses.
  box(0, .04, 1, 8, .1, 92, palette.path);
  box(0, .045, 5, 80, .12, 7, palette.path);
  box(0, .03, -20, 70, .09, 5, palette.path);
  box(-26, .025, 2, 5, .09, 59, palette.path);
  box(26, .025, 2, 5, .09, 59, palette.path);
  const plaza = new THREE.Mesh(new THREE.CylinderGeometry(11, 11, .12, 12), material(0xc6bea1)); plaza.position.set(0, .055, 4); plaza.receiveShadow = true; group.add(plaza);
  for (let row = 0; row < 24; row++) for (let col = 0; col < 4; col++) {
    box(-2.7 + col * 1.8 + (row % 2) * .3, .105, -33 + row * 3, 1.35, .045, .9, row % 3 === 0 ? 0xa8a98f : 0xc6c0a5);
  }

  const houses: House[] = [
    { x: -13, z: 18, w: 9, d: 10, h: 6.8, yaw: -.06, roof: palette.red },
    { x: 14, z: 20, w: 11, d: 9, h: 7.5, yaw: .08, roof: palette.slate },
    { x: -15, z: -7, w: 10, d: 11, h: 8.5, yaw: 0, roof: palette.slate },
    { x: 14, z: -8, w: 10, d: 10, h: 6.5, yaw: -.05, roof: palette.red },
    { x: -33, z: 17, w: 8, d: 10, h: 5.6, yaw: .03, roof: palette.slate },
    { x: -35, z: -10, w: 7, d: 11, h: 6, yaw: -.06, roof: palette.red },
    { x: 34, z: 5, w: 8, d: 12, h: 6.3, yaw: .03, roof: palette.slate },
    { x: 33, z: 25, w: 7, d: 8, h: 5, yaw: -.12, roof: palette.red },
    { x: -16, z: -29, w: 10, d: 8, h: 6.8, yaw: .03, roof: palette.red },
    { x: 8, z: -29, w: 9, d: 8, h: 6, yaw: 0, roof: palette.slate },
  ];

  for (const house of houses) {
    const { x, z, w, d, h, yaw, roof } = house;
    const local = (lx: number, y: number, lz: number, width: number, height: number, depth: number, c: number) => box(x + lx * Math.cos(yaw) + lz * Math.sin(yaw), y, z - lx * Math.sin(yaw) + lz * Math.cos(yaw), width, height, depth, c, yaw);
    const brace = (ax: number, ay: number, bx: number, by: number, lz: number) => {
      const lx = (ax + bx) / 2;
      instance(cube, palette.timber, x + lx * Math.cos(yaw) + lz * Math.sin(yaw), (ay + by) / 2, z - lx * Math.sin(yaw) + lz * Math.cos(yaw), .19, Math.hypot(bx - ax, by - ay), .18, yaw, -Math.atan2(bx - ax, by - ay));
    };
    box(x, h / 2, z, w, h, d, palette.plaster, yaw, true);
    local(0, 1.15, 0, w + .12, 2.3, d + .12, palette.stone);
    for (const side of [-1, 1]) {
      for (const end of [-1, 0, 1]) local(side * (w / 2 + .03), h / 2, end * (d / 2 - .1), .28, h + .1, .28, palette.timber);
      for (const y of [2.7, h - .2]) local(side * (w / 2 + .08), y, 0, .2, .25, d, palette.timber);
      for (const end of [-1, 1]) {
        local(side * (w / 2 + .12), 4.4, end * d * .25, .16, 1.65, 1.25, palette.timber);
        local(side * (w / 2 + .23), 4.4, end * d * .25, .07, 1.3, .94, 0x496665);
        local(side * (w / 2 + .27), 4.4, end * d * .25, .04, 1.3, .08, palette.stoneLight);
      }
      for (let floor = 0; floor < 2; floor++) {
        local(0, 2.7 + floor * (h - 2.9), side * (d / 2 + .08), w, .28, .2, palette.timber);
        for (const part of [-1, 0, 1]) {
          if (floor === 0 && part === 0 && side === 1) continue;
          local(part * w * .3, 1.7 + floor * 3.2, side * (d / 2 + .15), 1.15, 1.45, .17, palette.timber);
          local(part * w * .3, 1.75 + floor * 3.2, side * (d / 2 + .25), .83, 1.09, .05, 0x496665);
          local(part * w * .3, 1.75 + floor * 3.2, side * (d / 2 + .3), .08, 1.1, .05, palette.stoneLight);
          local(part * w * .3, 1.75 + floor * 3.2, side * (d / 2 + .3), .85, .08, .05, palette.stoneLight);
        }
      }
      for (const part of [-1, 0, 1]) local(part * w * .29, h / 2, side * (d / 2 + .14), .23, h, .2, palette.timber);
      for (const part of [-1, 1]) {
        brace(part * w * .31, h - .35, part * w * .46, 3.05, side * (d / 2 + .16));
        local(part * w * .3, 4.16, side * (d / 2 + .4), 1.45, .15, .52, palette.timber);
        local(part * w * .3, 4.3, side * (d / 2 + .43), 1.12, .22, .3, 0x587e4a);
      }
      for (let k = 0; k < 5; k++) local(-w * .4 + k * w * .2, .6 + (k % 2) * .75, side * (d / 2 + .16), w * .16, .45, .13, palette.stoneLight);
    }
    local(0, 1.3, d / 2 + .25, 1.6, 2.6, .23, palette.timber);
    for (const y of [.65, 1.85]) local(0, y, d / 2 + .39, 1.35, .09, .04, palette.dark);
    local(.47, 1.25, d / 2 + .4, .12, .12, .12, 0xd9ba73);
    local(0, .17, d / 2 + .85, 2.4, .32, 1.3, palette.stoneLight);
    const rw = w / 2 + .6, rd = d / 2 + .65, rise = w * .4;
    const points = [[-rw, h, -rd], [rw, h, -rd], [0, h + rise, -rd], [-rw, h, rd], [rw, h, rd], [0, h + rise, rd]];
    const roofPoints = new Float32Array(points.flatMap(([px, py, pz]) => [x + px * Math.cos(yaw) + pz * Math.sin(yaw), py, z - px * Math.sin(yaw) + pz * Math.cos(yaw)]));
    const indexedRoof = new THREE.BufferGeometry(); indexedRoof.setAttribute('position', new THREE.BufferAttribute(roofPoints, 3));
    indexedRoof.setIndex([0, 2, 1, 3, 4, 5, 0, 3, 5, 0, 5, 2, 1, 2, 5, 1, 5, 4, 0, 1, 4, 0, 4, 3]);
    const roofGeo = indexedRoof.toNonIndexed(); indexedRoof.dispose(); roofGeo.computeVertexNormals();
    roofGeo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(roofGeo.getAttribute('position').count * 2), 2));
    roofGeo.addGroup(0, 6, 1); roofGeo.addGroup(6, roofGeo.getAttribute('position').count - 6, 0);
    const roofMesh = new THREE.Mesh(roofGeo, [material(roof), material(palette.plaster)]); roofMesh.castShadow = true; roofMesh.receiveShadow = true; group.add(roofMesh);
    colliders.push({ kind: 'hull', vertices: roofPoints });
    local(0, h + rise + .05, 0, .25, .22, d + 1.5, palette.timber);
    for (const side of [-1, 1]) {
      local(side * rw, h - .04, 0, .2, .25, d + 1.5, palette.timber);
      brace(-rw, h + .06, 0, h + rise + .06, side * (rd + .04));
      brace(rw, h + .06, 0, h + rise + .06, side * (rd + .04));
      local(0, h + rise / 2, side * (rd + .05), .22, rise, .2, palette.timber);
    }
    // Tile ridges give the roof a readable rhythm without texture downloads.
    for (let k = 1; k < 7; k++) {
      const frac = k / 7;
      for (const side of [-1, 1]) local(side * rw * frac, h + rise * (1 - frac) + .055, 0, .07, .09, d + 1.4, roof === palette.red ? 0xb97458 : 0x748b86);
    }
    local(w * .27, h + rise * .65, -d * .22, 1.2, 3.7, 1.15, palette.stone);
    const chimneyX = x + w * .27 * Math.cos(yaw) - d * .22 * Math.sin(yaw);
    const chimneyZ = z - w * .27 * Math.sin(yaw) - d * .22 * Math.cos(yaw);
    colliders.push({ kind: 'box', x: chimneyX, y: h + rise * .65, z: chimneyZ, hx: .6, hy: 1.85, hz: .575, yaw });
    local(w * .27, h + rise * .65 + 1.8, -d * .22, 1.42, .22, 1.36, palette.stoneLight);
  }

  const tower = (x: number, z: number, height: number, radius: number, spire: boolean) => {
    instance(cylinder, palette.stone, x, height / 2, z, radius, height, radius);
    colliders.push({ kind: 'cylinder', x, y: height / 2, z, radius, halfHeight: height / 2 });
    for (const y of [.4, height * .33, height * .66, height - .6]) instance(cylinder, palette.stoneLight, x, y, z, radius + .18, .32, radius + .18);
    for (let j = 0; j < 10; j++) {
      const a = j / 10 * Math.PI * 2;
      box(x + Math.sin(a) * radius, height + .4, z + Math.cos(a) * radius, 1, 1.5, 1, palette.stoneLight, a, true);
      if (j % 2 === 0) box(x + Math.sin(a) * (radius + .015), height * .68, z + Math.cos(a) * (radius + .015), .6, 1.8, .12, palette.dark, a);
    }
    if (spire) {
      const roof = new THREE.Mesh(new THREE.ConeGeometry(radius + .65, 7.6, 10), material(palette.slate)); roof.position.set(x, height + 4, z); roof.castShadow = true; group.add(roof);
      colliders.push({ kind: 'cylinder', x, y: height + 2, z, radius: radius + .6, halfHeight: 3.8 });
      instance(cylinder, palette.timber, x, height + 9.1, z, .08, 3, .08);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 1.4, 8, 2), new THREE.MeshStandardMaterial({ color: palette.flag, side: THREE.DoubleSide, roughness: .9 }));
      flag.position.set(x + 1.4, height + 9.5, z); group.add(flag); flags.push(flag);
    }
  };
  tower(27, -28, 19, 4.1, true);
  for (const x of [-42, 42]) for (const z of [-37, 37]) tower(x, z, 7, 2.7, false);
  for (const x of [-42, 42]) box(x, 2.4, 0, 1.8, 4.8, 74, palette.stone, 0, true);
  box(0, 2.4, -37, 84, 4.8, 1.8, palette.stone, 0, true);
  for (const x of [-24.5, 24.5]) box(x, 2.4, 37, 35, 4.8, 1.8, palette.stone, 0, true);
  for (let i = -39; i <= 39; i += 3) {
    for (const x of [-42, 42]) box(x, 5.3, i * .9, 2, 1, 1.4, palette.stoneLight, 0, true);
    box(i, 5.3, -37, 1.5, 1, 2, palette.stoneLight, 0, true);
    if (Math.abs(i) > 7) box(i, 5.3, 37, 1.5, 1, 2, palette.stoneLight, 0, true);
  }
  for (const x of [-7, 7]) tower(x, 37, 8.5, 1.9, false);

  // A covered market, well, barrels and an orchard occupy the courtyards.
  instance(cylinder, palette.stone, -6, .8, 5, 1.5, 1.6, 1.5);
  instance(cylinder, 0x477d88, -6, 1.63, 5, 1.14, .02, 1.14);
  colliders.push({ kind: 'cylinder', x: -6, y: .9, z: 5, radius: 1.55, halfHeight: .9 });
  for (const x of [-7.2, -4.8]) box(x, 2.2, 5, .18, 4.4, .18, palette.timber, 0, true);
  box(-6, 4.25, 5, 3.4, .25, 2.7, palette.slate, 0, true);
  const fruitGeo = new THREE.IcosahedronGeometry(.22, 0);
  for (let k = 0; k < 3; k++) {
    const x = 10 + k * 5.4;
    for (const dx of [-1.9, 1.9]) for (const dz of [-1.3, 1.3]) box(x + dx, 1.8, 8 + dz, .12, 3.6, .12, palette.timber, 0, true);
    box(x, 1, 8, 4, 1.8, 2.4, palette.timber, 0, true);
    for (let strip = 0; strip < 6; strip++) box(x - 2 + strip * .8, 3.6, 8, .8, .13, 3.1, strip % 2 ? 0xe5ddc0 : [palette.flag, 0x517b73, 0xd09b47][k]);
    colliders.push({ kind: 'box', x, y: 3.6, z: 8, hx: 2.4, hy: .1, hz: 1.55 });
    for (let fruit = 0; fruit < 8; fruit++) instance(fruitGeo, k === 0 ? 0xd76440 : 0xc0c957, x - 1.3 + (fruit % 4) * .7, 2.05, 7.55 + Math.floor(fruit / 4) * .65, 1, 1, 1);
  }
  for (let k = 0; k < 15; k++) {
    const x = (k % 2 ? -1 : 1) * (20 + (k % 3) * .95), z = -14 + Math.floor(k / 3) * .98;
    instance(cylinder, 0x927858, x, .6, z, .5, 1.2, .5);
    for (const y of [.22, .95]) instance(cylinder, 0x536562, x, y, z, .52, .12, .52);
    colliders.push({ kind: 'cylinder', x, y: .6, z, radius: .52, halfHeight: .6 });
  }

  let seed = 8731;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const foliage = new THREE.IcosahedronGeometry(1, 0);
  const pine = new THREE.ConeGeometry(1, 1, 7);
  for (let k = 0; k < 185; k++) {
    const a = random() * Math.PI * 2, radius = 51 + random() * 61;
    const x = Math.cos(a) * radius, z = Math.sin(a) * radius;
    if (Math.abs(x) < 6 || (x > -62 && x < -51)) continue;
    const y = terrainHeight(x, z), height = 4 + random() * 6;
    instance(cylinder, palette.timber, x, y + height * .34, z, .25, height * .68, .25);
    if (k % 3 === 0) {
      for (let layer = 0; layer < 3; layer++) instance(pine, [0x3c6852, 0x4d7957, 0x608751][layer], x, y + height * (.45 + layer * .2), z, height * (.36 - layer * .065), height * .66, height * (.36 - layer * .065));
    } else {
      instance(foliage, [0x719748, 0x89a254, 0x587e4a, 0x9aab5d][k % 4], x, y + height * .75, z, height * .37, height * .43, height * .36, a);
    }
    if (Math.abs(x) < 96 && Math.abs(z) < 96) colliders.push({ kind: 'cylinder', x, y: y + height / 2, z, radius: height * .32, halfHeight: height / 2 });
  }
  for (let k = 0; k < 9; k++) {
    const x = -32 + (k % 3) * 6, z = 46 + Math.floor(k / 3) * 5;
    const y = terrainHeight(x, z);
    instance(cylinder, palette.timber, x, y + 1.8, z, .22, 3.6, .22);
    instance(foliage, 0x89a757, x, y + 4.3, z, 2.1, 2.4, 2.1);
    colliders.push({ kind: 'cylinder', x, y: y + 2.7, z, radius: 2.1, halfHeight: 2.7 });
  }

  const riverGeo = new THREE.PlaneGeometry(8, 220, 1, 64); riverGeo.rotateX(-Math.PI / 2);
  const rp = riverGeo.getAttribute('position');
  for (let i = 0; i < rp.count; i++) { const z = rp.getZ(i); rp.setX(i, rp.getX(i) - 57 + Math.sin(z * .04) * 3); rp.setY(i, terrainHeight(rp.getX(i), z) + .09); }
  riverGeo.computeVertexNormals();
  const water = new THREE.Mesh(riverGeo, new THREE.MeshStandardMaterial({ color: 0x75adb7, roughness: .38, metalness: .24 })); group.add(water);
  for (let k = 0; k < 80; k++) {
    const x = -60 + Math.sin(k * .4) * 3 + (k % 2) * 8, z = -95 + k * 2.4;
    instance(foliage, 0x9fae9e, x, terrainHeight(x, z) + .3, z, .65 + random(), .55 + random() * .7, .8 + random());
  }

  // Distant low-poly peaks form the skyline outside the bounded flight area.
  const mountainVertices: number[] = [], mountainIndices: number[] = [];
  for (let ring = 0; ring < 4; ring++) for (let j = 0; j < 9; j++) {
    const angle = j / 9 * Math.PI * 2;
    const radius = [1, .64, .3, .025][ring] * (1 + Math.sin(j * 3.3 + ring) * .22);
    mountainVertices.push(Math.sin(angle) * radius + ring * .045, [-.5, -.12, .18, .5][ring] + (ring > 0 && ring < 3 ? Math.sin(j * 1.9) * .07 : 0), Math.cos(angle) * radius);
    if (ring < 3) { const a = ring * 9 + j, b = ring * 9 + (j + 1) % 9; mountainIndices.push(a, b + 9, b, a, a + 9, b + 9); }
  }
  const mountainGeo = new THREE.BufferGeometry(); mountainGeo.setAttribute('position', new THREE.Float32BufferAttribute(mountainVertices, 3)); mountainGeo.setIndex(mountainIndices); mountainGeo.computeVertexNormals();
  for (let k = 0; k < 23; k++) {
    const angle = k / 23 * Math.PI * 2;
    const distance = 190 + random() * 50, height = 42 + random() * 56;
    const x = Math.sin(angle) * distance, z = Math.cos(angle) * distance;
    instance(mountainGeo, [0x879f95, 0x92aaa1, 0xa4b8ad, 0x78958c][k % 4], x, height / 2 - 9, z, 40 + random() * 30, height, 38 + random() * 27, angle);
  }

  for (let k = 0; k < 480; k++) {
    const x = (random() - .5) * 188, z = (random() - .5) * 188;
    if (Math.abs(x) < 45 && Math.abs(z) < 41) continue;
    instance(foliage, k % 4 === 0 ? 0xe4ce74 : 0x809a5c, x, terrainHeight(x, z) + .12, z, .12, .2 + random() * .25, .12);
  }
  for (const batch of batches.values()) {
    const mesh = new THREE.InstancedMesh(batch.geo, batch.mat, batch.matrices.length);
    batch.matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix)); mesh.castShadow = true; mesh.receiveShadow = true; mesh.computeBoundingSphere(); group.add(mesh);
  }
  return { group, colliders, houses, flags, water };
}

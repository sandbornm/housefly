import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export interface Drone { group: THREE.Group; rotors: THREE.Group[]; wings: THREE.Group[]; pilot: THREE.Group; }

export function createDrone(): Drone {
  const group = new THREE.Group(), pilot = new THREE.Group();
  const rotors: THREE.Group[] = [], wings: THREE.Group[] = [];
  const mat = (color: number, roughness = .65, metalness = .05) => new THREE.MeshStandardMaterial({ color, roughness, metalness, flatShading: true });
  const carbon = mat(0x202b2d, .58, .25), coral = mat(0xe85e46, .43, .2), metal = mat(0xb9c7c4, .36, .65), marking = mat(0xe9eee2, .58, .1);
  const shell = mat(0xb39a60), dark = mat(0x514a39), eye = mat(0xb43030, .35), eyeFacet = mat(0xdf5843, .4);
  const leather = mat(0x405d5c, .8), lens = new THREE.MeshPhysicalMaterial({ color: 0x62e4e3, roughness: .16, metalness: .5, clearcoat: 1, emissive: 0x177b91, emissiveIntensity: .3 });
  const sphereGeo = new THREE.SphereGeometry(1, 16, 10), boxGeo = new THREE.BoxGeometry(1, 1, 1);
  const wingMembrane = new THREE.MeshPhysicalMaterial({ color: 0xe7f4ef, transparent: true, opacity: .48, side: THREE.DoubleSide, roughness: .32, metalness: .1, depthWrite: false });
  const wingVein = new THREE.MeshBasicMaterial({ color: 0x6c998d, transparent: true, opacity: .8 });
  const redLight = new THREE.MeshBasicMaterial({ color: 0xff573a }), greenLight = new THREE.MeshBasicMaterial({ color: 0x75ffd7 });
  const sphere = (parent: THREE.Object3D, m: THREE.Material, p: number[], s: number[]) => {
    const mesh = new THREE.Mesh(sphereGeo, m); mesh.position.fromArray(p); mesh.scale.fromArray(s); mesh.castShadow = true; parent.add(mesh); return mesh;
  };
  const box = (parent: THREE.Object3D, m: THREE.Material, p: number[], s: number[]) => {
    const mesh = new THREE.Mesh(boxGeo, m); mesh.position.fromArray(p); mesh.scale.fromArray(s); mesh.castShadow = true; parent.add(mesh); return mesh;
  };
  const rod = (parent: THREE.Object3D, m: THREE.Material, a: number[], b: number[], radius: number) => {
    const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b), delta = end.clone().sub(start);
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, delta.length(), 8), m); mesh.position.copy(start).add(end).multiplyScalar(.5); mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize()); mesh.castShadow = true; parent.add(mesh); return mesh;
  };
  box(group, coral, [0, 0, 0], [.82, .26, 1.25]);
  box(group, carbon, [0, .17, .12], [.61, .11, .86]);
  box(group, metal, [0, -.16, .14], [.44, .15, .65]);
  for (const side of [-1, 1]) {
    box(group, marking, [side * .3, .138, -.42], [.095, .012, .34]);
    for (const z of [-.48, .48]) sphere(group, metal, [side * .34, .145, z], [.035, .013, .035]);
    box(group, carbon, [side * .42, -.015, .12], [.018, .12, .67]);
    for (let vent = 0; vent < 5; vent++) box(group, metal, [side * .433, -.01, -.13 + vent * .11], [.009, .018, .055]);
  }
  for (const side of [-1, 1]) for (const end of [-1, 1]) {
    const x = side * 1.1, z = end * .95;
    rod(group, carbon, [side * .2, .03, end * .32], [x, .03, z], .115);
    rod(group, coral, [side * .42, .11, end * .51], [side * .88, .11, end * .8], .027);
    const motor = new THREE.Mesh(new THREE.CylinderGeometry(.17, .17, .27, 12), metal); motor.position.set(x, .12, z); group.add(motor);
    const hub = new THREE.Group(); hub.position.set(x, .29, z);
    for (let i = 0; i < 2; i++) {
      const blade = box(hub, end < 0 ? coral : carbon, [0, 0, 0], [1.02, .035, .12]); blade.rotation.y = i * Math.PI / 2;
      for (const tip of [-1, 1]) box(hub, marking, i ? [0, .021, tip * .44] : [tip * .44, .021, 0], i ? [.12, .012, .09] : [.09, .012, .12]);
    }
    sphere(hub, carbon, [0, .025, 0], [.11, .065, .11]); rotors.push(hub); group.add(hub);
    const guard = new THREE.Mesh(new THREE.TorusGeometry(.57, .025, 5, 28), carbon); guard.rotation.x = Math.PI / 2; guard.position.set(x, .21, z); group.add(guard);
    const light = new THREE.Mesh(new THREE.SphereGeometry(.075, 8, 6), end < 0 ? redLight : greenLight); light.position.set(x, .12, z + end * .19); group.add(light);
    for (const sign of [-1, 1]) rod(group, carbon, [x, .04, z], [x + sign * .48, .21, z + end * .3], .018);
    rod(group, metal, [side * .37, -.1, end * .46], [side * .53, -.47, end * .55], .045);
  }
  for (const side of [-1, 1]) rod(group, carbon, [side * .53, -.47, -.7], [side * .53, -.47, .7], .055);
  box(group, carbon, [0, -.05, -.69], [.32, .27, .25]);
  sphere(group, metal, [0, -.05, -.824], [.12, .12, .035]);
  sphere(group, lens, [0, -.05, -.858], [.085, .085, .022]);
  rod(group, carbon, [.18, .2, .5], [.28, .8, .64], .024); sphere(group, coral, [.28, .83, .65], [.06, .08, .06]);

  pilot.position.y = .21;
  sphere(pilot, shell, [0, .47, .38], [.26, .23, .49]);
  for (let i = 0; i < 5; i++) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(.205 - i * .02, .028, 5, 20), dark); ring.position.set(0, .47, .36 + i * .105); ring.scale.y = .85; pilot.add(ring);
  }
  sphere(pilot, shell, [0, .65, -.05], [.31, .32, .34]);
  sphere(pilot, shell, [0, .83, -.38], [.31, .27, .25]);
  for (const side of [-1, 1]) {
    sphere(pilot, eye, [side * .255, .86, -.43], [.16, .215, .17]);
    // Compound eyes remain exposed at the sides of the pilot's goggles.
    for (let i = 0; i < 22; i++) {
      const a = i * 2.39996, y = 1 - (i + .5) / 22 * 2, r = Math.sqrt(1 - y * y);
      sphere(pilot, i % 3 ? eye : eyeFacet, [side * .255 + Math.cos(a) * r * .164, .86 + y * .216, -.43 + Math.sin(a) * r * .171], [.017, .017, .012]);
    }
    const headphone = new THREE.Mesh(new THREE.CylinderGeometry(.15, .15, .105, 16), leather); headphone.rotation.z = Math.PI / 2; headphone.position.set(side * .365, .93, -.3); pilot.add(headphone);
    sphere(pilot, metal, [side * .425, .93, -.3], [.017, .06, .06]);
    box(pilot, leather, [side * .17, .9, -.62], [.36, .25, .16]);
    const glass = box(pilot, lens, [side * .17, .905, -.711], [.26, .16, .033]); glass.rotation.y = -side * .1;
    box(pilot, metal, [side * .18, 1.008, -.725], [.28, .019, .01]);
    const glint = box(pilot, marking, [side * .17 - .045, .929, -.734], [.029, .1, .008]); glint.rotation.z = -.28;
    rod(pilot, leather, [side * .29, .9, -.61], [side * .31, .91, -.18], .035);
    rod(pilot, leather, [side * .27, 1.03, -.33], [side * .18, 1.18, -.27], .048);
    rod(pilot, dark, [side * .1, 1.04, -.48], [side * .15, 1.28, -.56], .017);
    sphere(pilot, dark, [side * .15, 1.28, -.56], [.031, .023, .027]);
    const wing = new THREE.Group(); wing.position.set(side * .19, .81, .03); wing.rotation.y = -side * .45;
    sphere(wing, wingMembrane, [side * .2, 0, .44], [.29, .017, .62]);
    for (let vein = 0; vein < 4; vein++) rod(wing, wingVein, [0, .021, 0], [side * (.08 + vein * .105), .021, .86 - vein * .13], .006);
    rod(wing, wingVein, [side * .1, .022, .39], [side * .4, .022, .5], .006);
    wings.push(wing); pilot.add(wing);
    for (let row = 0; row < 3; row++) {
      const startZ = -.23 + row * .28, kneeZ = startZ - .13;
      rod(pilot, dark, [side * .2, .57, startZ], [side * .44, .3, kneeZ], .025);
      rod(pilot, dark, [side * .44, .3, kneeZ], [side * .34, .08, startZ - .25], .021);
      rod(pilot, dark, [side * .34, .08, startZ - .25], [side * .3, .045, startZ - .39], .017);
      sphere(pilot, shell, [side * .44, .3, kneeZ], [.034, .034, .034]);
      rod(pilot, dark, [side * .3, .66, startZ], [side * .4, .76, startZ + .03], .007);
    }
  }
  rod(pilot, leather, [-.18, 1.18, -.27], [.18, 1.18, -.27], .065);
  box(pilot, leather, [0, .91, -.65], [.085, .075, .16]);
  rod(pilot, carbon, [-.4, .89, -.29], [-.46, .66, -.5], .022);
  rod(pilot, carbon, [-.46, .66, -.5], [-.18, .66, -.69], .022);
  sphere(pilot, carbon, [-.18, .66, -.69], [.065, .034, .037]);
  group.add(pilot);

  // Bake rigid detail by material; keep only the rotors and wings articulated.
  group.updateMatrixWorld(true);
  const animated = new Set<THREE.Object3D>([...rotors, ...wings]);
  const batches = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const originals = new Set<THREE.BufferGeometry>();
  const removed: THREE.Mesh[] = [];
  const gather = (object: THREE.Object3D) => {
    if (animated.has(object)) return;
    if (object instanceof THREE.Mesh && !Array.isArray(object.material)) {
      const geometries = batches.get(object.material) ?? [];
      geometries.push(object.geometry.clone().applyMatrix4(object.matrixWorld));
      batches.set(object.material, geometries); originals.add(object.geometry); removed.push(object);
    }
    object.children.forEach(gather);
  };
  gather(group);
  removed.forEach(mesh => mesh.removeFromParent());
  for (const [material, geometries] of batches) {
    const geometry = mergeGeometries(geometries);
    if (geometry) { const mesh = new THREE.Mesh(geometry, material); mesh.castShadow = true; group.add(mesh); }
    geometries.forEach(part => part.dispose());
  }
  for (const rotor of rotors) {
    const parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
    for (const object of [...rotor.children]) {
      if (!(object instanceof THREE.Mesh) || Array.isArray(object.material)) continue;
      object.updateMatrix();
      const geometries = parts.get(object.material) ?? [];
      geometries.push(object.geometry.clone().applyMatrix4(object.matrix)); parts.set(object.material, geometries);
      originals.add(object.geometry); object.removeFromParent();
    }
    for (const [material, geometries] of parts) {
      const geometry = mergeGeometries(geometries);
      if (geometry) { const mesh = new THREE.Mesh(geometry, material); mesh.castShadow = true; rotor.add(mesh); }
      geometries.forEach(part => part.dispose());
    }
  }
  group.traverse(object => { if (object instanceof THREE.Mesh) originals.delete(object.geometry); });
  originals.forEach(geometry => geometry.dispose());
  return { group, pilot, rotors, wings };
}

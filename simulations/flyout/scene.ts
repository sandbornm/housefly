import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createDrosophila, type DrosophilaActor } from '../../src/flyModel.ts';
import type { FlyMotion } from './pose.ts';

export const POSITIONS = [
  { code: 'P', name: 'Pip', role: 'Pitcher', x: 0, z: 3 },
  { code: 'C', name: 'Dot', role: 'Catcher', x: 0, z: 14.2 },
  { code: '1B', name: 'Fig', role: 'First base', x: 10.5, z: 1.4 },
  { code: '2B', name: 'Dew', role: 'Second base', x: 5.5, z: -3 },
  { code: '3B', name: 'Bud', role: 'Third base', x: -10.5, z: 1.4 },
  { code: 'SS', name: 'Moss', role: 'Shortstop', x: -5, z: -3.2 },
  { code: 'LF', name: 'Fern', role: 'Left field', x: -12.5, z: -8 },
  { code: 'CF', name: 'Clover', role: 'Center field', x: 0, z: -15.5 },
  { code: 'RF', name: 'Basil', role: 'Right field', x: 12.5, z: -8 },
] as const;
export const BASES = [new THREE.Vector3(0, 0, 12), new THREE.Vector3(9, 0, 3),
  new THREE.Vector3(0, 0, -6), new THREE.Vector3(-9, 0, 3), new THREE.Vector3(0, 0, 12)];
export const TEAM_COLORS = [0xe55568, 0x248f7d];

const sphereGeometry = new THREE.SphereGeometry(1, 16, 12);
const legGeometry = new THREE.CylinderGeometry(.026, .041, 1, 5);
const up = new THREE.Vector3(0, 1, 0);
const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0xbb914b, roughness: .74 });
const darkMaterial = new THREE.MeshStandardMaterial({ color: 0x453a29, roughness: .83 });
const eyeMaterial = new THREE.MeshPhysicalMaterial({ color: 0xcc2638, roughness: .3, clearcoat: .7 });
const wingMaterial = new THREE.MeshPhysicalMaterial({ color: 0xe3f6f3, transparent: true, opacity: .54,
  roughness: .21, side: THREE.DoubleSide, depthWrite: false, metalness: .13 });

function batchMeshes(parent: THREE.Object3D): void {
  const groups = new Map<THREE.Material, THREE.Mesh[]>();
  for (const child of parent.children) {
    if (!(child instanceof THREE.Mesh) || child instanceof THREE.InstancedMesh || child.children.length || Array.isArray(child.material)) continue;
    const meshes = groups.get(child.material) ?? []; meshes.push(child); groups.set(child.material, meshes);
  }
  for (const [material, meshes] of groups) {
    if (meshes.length < 2) continue;
    const pieces = meshes.map(mesh => { mesh.updateMatrix(); return mesh.geometry.clone().applyMatrix4(mesh.matrix); });
    const geometry = mergeGeometries(pieces);
    pieces.forEach(piece => piece.dispose());
    if (!geometry) continue;
    const merged = new THREE.Mesh(geometry, material);
    merged.castShadow = meshes.some(mesh => mesh.castShadow); merged.receiveShadow = meshes.some(mesh => mesh.receiveShadow);
    meshes.forEach(mesh => parent.remove(mesh)); parent.add(merged);
  }
}

function ellipsoid(parent: THREE.Object3D, xyz: number[], scale: number[], material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(sphereGeometry, material);
  mesh.position.fromArray(xyz); mesh.scale.fromArray(scale); mesh.castShadow = true; parent.add(mesh); return mesh;
}

function rod(parent: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, material: THREE.Material, radius = 1): THREE.Mesh {
  const mesh = new THREE.Mesh(legGeometry, material);
  mesh.position.copy(a).add(b).multiplyScalar(.5);
  mesh.scale.set(radius, a.distanceTo(b), radius);
  mesh.quaternion.setFromUnitVectors(up, b.clone().sub(a).normalize());
  mesh.castShadow = true; parent.add(mesh); return mesh;
}

export class Fly {
  group: THREE.Group;
  body: THREE.Group;
  moving = false;
  reaching = false;
  throwing = false;
  swinging = false;
  private actor: DrosophilaActor;

  constructor(team: number, index: number, scale = 1.22) {
    this.actor = createDrosophila(TEAM_COLORS[team], scale);
    this.group = this.actor.group;
    this.body = this.actor.body;
    this.group.userData.fielder = index;
  }

  motion(): FlyMotion {
    return { moving: this.moving, reaching: this.reaching, throwing: this.throwing, swinging: this.swinging };
  }

  animate(time: number, selected: boolean): void {
    this.actor.animate(time, this.motion(), selected);
  }

  team(team: number): void { this.actor.setTeam(TEAM_COLORS[team]); }
}

export class FieldScene {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(38, 1, .12, 220);
  renderer: THREE.WebGLRenderer;
  fielders = POSITIONS.map((_, i) => new Fly(1, i, i === 0 ? 1.35 : 1.12));
  batter = new Fly(0, -1, 1.38);
  runners = Array.from({ length: 4 }, () => new Fly(0, -1));
  ball = new THREE.Group();
  bat = new THREE.Group();
  selected = 0;
  follow = false;
  ring: THREE.Mesh;
  landing: THREE.Group;
  throwTarget: THREE.Mesh;
  activityMount = new THREE.Group();
  activityActor: THREE.Object3D;
  private activityFrame = new THREE.Group();
  private activityRing: THREE.Mesh;
  private activityLeader: THREE.Line;
  private contactShadows: THREE.InstancedMesh;
  private shadowTransform = new THREE.Object3D();
  private surfaceTextures: THREE.Texture[] = [];
  private trail: THREE.Line;
  private trailPoints: THREE.Vector3[] = [];
  private trailPositions = new Float32Array(24 * 3);
  private shadow: THREE.Mesh;
  private observer: ResizeObserver;
  private target = new THREE.Vector3(0, 1.2, 8);
  private viewHeight = 12;
  private desired = new THREE.Vector3();
  private look = new THREE.Vector3();
  strikeZone: THREE.Group;
  private raycaster = new THREE.Raycaster();
  private width = 1;
  private height = 1;
  private playArea = { left: 0, top: 0, width: 1, height: 1 };
  private disposed = false;

  constructor(public canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0xa8d2bd);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.shadowMap.enabled = true;
    this.renderer.info.autoReset = false;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.add(new THREE.HemisphereLight(0xe3f5ff, 0x465b35, 1.85));
    const sun = new THREE.DirectionalLight(0xfff2dd, 3.1);
    sun.position.set(-18, 35, 16); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048); sun.shadow.camera.left = -38; sun.shadow.camera.right = 38;
    sun.shadow.camera.top = 38; sun.shadow.camera.bottom = -38; sun.shadow.camera.far = 100;
    sun.shadow.normalBias = .025; sun.shadow.bias = -.00012;
    this.scene.add(sun);
    this.buildPark();
    batchMeshes(this.scene);
    this.fielders.forEach((fly, i) => {
      fly.group.position.set(POSITIONS[i].x, 0, POSITIONS[i].z);
      fly.group.rotation.y = Math.atan2(-POSITIONS[i].x, 12 - POSITIONS[i].z);
      this.scene.add(fly.group);
    });
    this.fielders[0].group.rotation.y = 0;
    this.batter.group.position.set(-.55, 0, 12.15); this.batter.group.rotation.y = Math.PI; this.scene.add(this.batter.group);
    this.runners.forEach(fly => { fly.group.visible = false; this.scene.add(fly.group); });
    this.contactShadows = new THREE.InstancedMesh(new THREE.CircleGeometry(.72, 24),
      new THREE.MeshBasicMaterial({ color: 0x173c30, transparent: true, opacity: .22, depthWrite: false }), 14);
    this.contactShadows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.contactShadows.frustumCulled = false; this.scene.add(this.contactShadows);
    this.buildBat(); this.batter.body.add(this.bat);
    const leather = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .48, emissive: 0xfff0ca, emissiveIntensity: .2 });
    ellipsoid(this.ball, [0, 0, 0], [.28, .28, .28], leather);
    const seamMaterial = new THREE.MeshBasicMaterial({ color: 0xb52340 });
    for (const side of [-1, 1]) {
      const seam = new THREE.Mesh(new THREE.TorusGeometry(.23, .018, 5, 32), seamMaterial);
      seam.position.z = side * .15; seam.rotation.y = side * .25; this.ball.add(seam);
    }
    this.ball.position.set(0, 1.8, 3); this.scene.add(this.ball);
    this.ring = this.groundRing(1.35, 1.45, 0xfbea88); this.ring.position.y = .08;
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(.21, .48, 3), new THREE.MeshBasicMaterial({ color: 0xfbea88 }));
    arrow.rotation.x = -Math.PI / 2; arrow.position.set(0, 1.8, .05); this.ring.add(arrow);
    this.scene.add(this.ring);
    this.landing = new THREE.Group();
    const landingRing = this.groundRing(.7, .78, 0xf6e69a); this.landing.add(landingRing);
    const landingDot = this.groundRing(.12, .2, 0xffffff); this.landing.add(landingDot);
    this.landing.position.y = .07; this.landing.visible = false; this.scene.add(this.landing);
    this.throwTarget = this.groundRing(.8, 1, 0xfbea88); this.throwTarget.position.y = .09;
    this.throwTarget.visible = false; this.scene.add(this.throwTarget);
    this.shadow = new THREE.Mesh(new THREE.CircleGeometry(.28, 20), new THREE.MeshBasicMaterial({ color: 0x213d2b, transparent: true, opacity: .34, depthWrite: false }));
    this.shadow.rotation.x = -Math.PI / 2; this.scene.add(this.shadow);
    const trailGeometry = new THREE.BufferGeometry();
    trailGeometry.setAttribute('position', new THREE.BufferAttribute(this.trailPositions, 3).setUsage(THREE.DynamicDrawUsage));
    const trailColors = new Float32Array(24 * 3);
    for (let i = 0; i < 24; i++) new THREE.Color(0x559291).lerp(new THREE.Color(0xffffff), i / 23).toArray(trailColors, i * 3);
    trailGeometry.setAttribute('color', new THREE.BufferAttribute(trailColors, 3)); trailGeometry.setDrawRange(0, 0);
    this.trail = new THREE.Line(trailGeometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: .9, depthWrite: false }));
    this.trail.frustumCulled = false;
    this.scene.add(this.trail);
    this.activityActor = this.batter.group;
    this.activityRing = this.groundRing(1.55, 1.65, 0x8ff4e5); this.scene.add(this.activityRing);
    const frame = new THREE.Mesh(new THREE.PlaneGeometry(4.65, 4.15),
      new THREE.MeshBasicMaterial({ color: 0x87bdb4, depthWrite: false, depthTest: false, toneMapped: false }));
    frame.renderOrder = 7; this.activityFrame.add(frame);
    const backing = new THREE.Mesh(new THREE.PlaneGeometry(4.52, 4.02),
      new THREE.MeshBasicMaterial({ color: 0x0b1418, depthWrite: false, depthTest: false, toneMapped: false }));
    backing.position.z = .015; backing.renderOrder = 8; this.activityFrame.add(backing);
    this.activityMount.scale.setScalar(3.9); this.activityMount.position.z = .05;
    this.activityFrame.add(this.activityMount); this.scene.add(this.activityFrame);
    this.activityLeader = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: 0x366c64, transparent: true, opacity: .85, depthTest: false, depthWrite: false }));
    this.activityLeader.renderOrder = 6; this.activityLeader.frustumCulled = false; this.scene.add(this.activityLeader);
    this.strikeZone = new THREE.Group();
    const zone = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(.55, .85, .02)),
      new THREE.LineBasicMaterial({ color: 0xf4f1c8, transparent: true, opacity: .85 }));
    zone.position.set(-.2, .78, 11.72); this.strikeZone.add(zone);
    this.scene.add(this.strikeZone);
    this.camera.position.set(2.15, 1.72, 14.35);
    this.camera.lookAt(0, 1.12, 3.4);
    this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(canvas);
    this.resize();
  }

  private groundRing(inner: number, outer: number, color: number): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 48), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
    mesh.rotation.x = -Math.PI / 2; return mesh;
  }

  private sector(radius: number, inner: number, material: THREE.Material, y: number): void {
    const shape = new THREE.Shape();
    for (let i = 0; i <= 64; i++) {
      const a = -Math.PI / 4 + i / 64 * Math.PI / 2; const x = Math.sin(a) * radius; const z = 12 - Math.cos(a) * radius;
      if (!i) shape.moveTo(x, -z); else shape.lineTo(x, -z);
    }
    for (let i = 64; i >= 0; i--) {
      const a = -Math.PI / 4 + i / 64 * Math.PI / 2; shape.lineTo(Math.sin(a) * inner, -(12 - Math.cos(a) * inner));
    }
    shape.closePath();
    const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), material);
    mesh.rotation.x = -Math.PI / 2; mesh.position.y = y; this.surface(mesh);
  }

  private fieldTexture(grass: boolean): THREE.CanvasTexture {
    const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    let seed = grass ? 3107 : 9701;
    const random = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    ctx.fillStyle = '#dedede'; ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 11000; i++) {
      const tone = Math.floor(165 + random() * 90);
      ctx.fillStyle = `rgb(${tone},${tone},${tone})`;
      ctx.fillRect(random() * 256, random() * 256, grass ? 1 : 2, grass ? 2 + random() * 6 : 1.5);
    }
    if (!grass) {
      ctx.fillStyle = '#96969618';
      for (let i = 0; i < 256; i += 16) ctx.fillRect(0, i, 256, 1);
    }
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.surfaceTextures.push(texture); return texture;
  }

  private surface(mesh: THREE.Mesh): void {
    // World-aligned tiles keep turf and clay grain consistent across the park's shapes.
    mesh.updateMatrix();
    const positions = mesh.geometry.getAttribute('position'), uv = mesh.geometry.getAttribute('uv');
    const point = new THREE.Vector3();
    for (let i = 0; i < positions.count; i++) {
      point.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrix);
      uv.setXY(i, point.x * .7, point.z * .7);
    }
    mesh.receiveShadow = true; this.scene.add(mesh);
  }

  private text(text: string, width: number, height: number, color: string, background?: string): THREE.Mesh {
    const surface = document.createElement('canvas'); surface.width = 1024; surface.height = 256;
    const ctx = surface.getContext('2d')!;
    if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, 1024, 256); }
    ctx.font = '900 115px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = color; ctx.fillText(text, 512, 140);
    const texture = new THREE.CanvasTexture(surface); texture.colorSpace = THREE.SRGBColorSpace;
    return new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
  }

  private buildPark(): void {
    const turf = this.fieldTexture(true), clay = this.fieldTexture(false);
    const grass = (color: number): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({ color, map: turf, bumpMap: turf, bumpScale: .055, roughness: .94 });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), grass(0x9cbd8c));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -.16; this.surface(ground);
    const dirt = new THREE.MeshStandardMaterial({ color: 0xc58970, map: clay, bumpMap: clay, bumpScale: .035, roughness: 1 });
    const warning = new THREE.Mesh(new THREE.CircleGeometry(19, 80), dirt);
    warning.rotation.x = -Math.PI / 2; warning.position.set(0, -.09, 5); this.surface(warning);
    const lawn = new THREE.Mesh(new THREE.CircleGeometry(18.5, 80), grass(0x78a862));
    lawn.rotation.x = -Math.PI / 2; lawn.position.set(0, -.075, 5); this.surface(lawn);
    this.sector(33, 0, dirt, -.06);
    const stripes = [grass(0x80b565), grass(0x689f56)];
    for (let band = 0; band < 8; band++) this.sector(31.5 - band * 3.5, Math.max(0, 28 - band * 3.5), stripes[band % 2], -.04);
    const diamond = new THREE.Mesh(new THREE.BoxGeometry(15.15, .05, 15.15), dirt);
    diamond.rotation.y = Math.PI / 4; diamond.position.set(0, -.003, 3); this.surface(diamond);
    const infield = new THREE.Mesh(new THREE.BoxGeometry(10.4, .04, 10.4), grass(0x71a35b));
    infield.rotation.y = Math.PI / 4; infield.position.set(0, .02, 3); this.surface(infield);
    const mound = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.55, .21, 40), dirt); mound.position.set(0, .08, 3); this.surface(mound);
    const batterDirt = new THREE.Mesh(new THREE.CircleGeometry(2.45, 48), dirt); batterDirt.rotation.x = -Math.PI / 2; batterDirt.position.set(0, .035, 12); this.surface(batterDirt);
    const chalk = new THREE.MeshStandardMaterial({ color: 0xfaf9de, roughness: 1 });
    for (let i = 0; i < 4; i++) {
      const base = new THREE.Mesh(new THREE.BoxGeometry(i ? .8 : .7, .13, i ? .8 : .7), chalk);
      base.position.copy(BASES[i]); base.position.y = .12; base.rotation.y = Math.PI / 4; base.castShadow = true; this.scene.add(base);
      const plateLabel = this.text(i ? `${i}B` : 'HOME', i ? 1.6 : 2.4, .5, '#fff6d9');
      plateLabel.rotation.x = -Math.PI / 2; plateLabel.position.copy(BASES[i]); plateLabel.position.y = .04; plateLabel.position.z += i ? 1.1 : 2.6; this.scene.add(plateLabel);
    }
    const rubber = new THREE.Mesh(new THREE.BoxGeometry(.7, .06, .23), chalk); rubber.position.set(0, .22, 3.6); this.scene.add(rubber);
    for (const side of [-1, 1]) {
      const line = new THREE.Mesh(new THREE.BoxGeometry(.105, .02, 35), chalk);
      line.position.set(side * 12.37, .052, -.37); line.rotation.y = -side * Math.PI / 4; this.scene.add(line);
      for (const dx of [0, 1.1]) {
        const box = new THREE.Mesh(new THREE.BoxGeometry(.045, .02, 2.1), chalk); box.position.set(side * (.9 + dx), .06, 12.1); this.scene.add(box);
      }
      for (const z of [11.05, 13.15]) {
        const box = new THREE.Mesh(new THREE.BoxGeometry(1.1, .02, .045), chalk); box.position.set(side * 1.45, .06, z); this.scene.add(box);
      }
    }
    const fenceMat = new THREE.MeshStandardMaterial({ color: 0x29675b, roughness: .84 });
    const postMat = new THREE.MeshStandardMaterial({ color: 0xe9d775, roughness: .55 });
    const seatMaterials = [new THREE.MeshStandardMaterial({ color: 0xd0dccc }), new THREE.MeshStandardMaterial({ color: 0xefece2 })];
    for (let i = 0; i < 44; i++) {
      const a = -Math.PI / 4 + (i + .5) / 44 * Math.PI / 2;
      const panel = new THREE.Mesh(new THREE.BoxGeometry(1.17, 1.8, .22), fenceMat);
      panel.position.set(Math.sin(a) * 32.6, .9, 12 - Math.cos(a) * 32.6); panel.rotation.y = -a; panel.castShadow = true; this.scene.add(panel);
      const rail = new THREE.Mesh(new THREE.BoxGeometry(1.18, .12, .3), postMat);
      rail.position.copy(panel.position); rail.position.y = 1.84; rail.rotation.copy(panel.rotation); this.scene.add(rail);
      if (i % 4 === 0) {
        for (let row = 0; row < 3; row++) {
          const seat = new THREE.Mesh(new THREE.BoxGeometry(3.5, .35, .7), seatMaterials[row % 2]);
          seat.position.set(Math.sin(a) * (34.3 + row * 1.1), .3 + row * .5, 12 - Math.cos(a) * (34.3 + row * 1.1)); seat.rotation.y = -a; seat.castShadow = true; this.scene.add(seat);
        }
      }
    }
    for (const side of [-1, 1]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(.08, .08, 5.5, 8), postMat);
      pole.position.set(side * 23.05, 2.75, -11.05); this.scene.add(pole);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.5, .7), new THREE.MeshStandardMaterial({ color: side < 0 ? TEAM_COLORS[0] : TEAM_COLORS[1], side: THREE.DoubleSide }));
      flag.position.copy(pole.position).add(new THREE.Vector3(.76, 2, 0)); this.scene.add(flag);
    }
    const board = this.text('ORCHARD PARK', 12, 3, '#f1edce', '#1c4b3e'); board.position.set(0, 4, -22.8); this.scene.add(board);
    for (const x of [-4.8, 4.8]) {
      const support = new THREE.Mesh(new THREE.BoxGeometry(.2, 4, .2), fenceMat); support.position.set(x, 1.9, -23); this.scene.add(support);
    }
    const fieldPrint = this.text('FLYOUT', 9, 2.25, '#d8e2b7'); fieldPrint.rotation.x = -Math.PI / 2; fieldPrint.position.set(0, .005, -10.5); this.scene.add(fieldPrint);
    const distance = this.text('320', 2.6, .7, '#e4e8c8'); distance.position.set(0, 1.05, -20.4); this.scene.add(distance);
    this.buildFruit(-27, -9, .85); this.buildFruit(28, -6, 1.1);
    for (const side of [-1, 1]) {
      const bench = new THREE.Mesh(new THREE.BoxGeometry(7, .35, 1.3), new THREE.MeshStandardMaterial({ color: TEAM_COLORS[side < 0 ? 0 : 1] }));
      bench.position.set(side * 13, .6, 15); bench.rotation.y = side * .4; bench.castShadow = true; this.scene.add(bench);
      for (const x of [-2.5, 2.5]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(.25, .7, 1), fenceMat); leg.position.set(side * 13 + x, .1, 15); this.scene.add(leg);
      }
    }
  }

  private buildFruit(x: number, z: number, scale: number): void {
    const fruit = new THREE.Group(); fruit.position.set(x, 0, z); fruit.scale.setScalar(scale); this.scene.add(fruit);
    const profile = [new THREE.Vector2(.05, .1), new THREE.Vector2(.7, .6), new THREE.Vector2(1.5, 1.6), new THREE.Vector2(1.8, 2.7), new THREE.Vector2(1.6, 3.6), new THREE.Vector2(.8, 4), new THREE.Vector2(0, 4.1)];
    const berry = new THREE.Mesh(new THREE.LatheGeometry(profile, 24), new THREE.MeshStandardMaterial({ color: 0xd9515a, roughness: .82 }));
    berry.castShadow = true; fruit.add(berry);
    const seeds = new THREE.InstancedMesh(sphereGeometry, new THREE.MeshStandardMaterial({ color: 0xf3cd79, roughness: .6 }), 60);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < 60; i++) {
      const h = .6 + (i % 8) * .4; const a = i * 2.39996; const r = h < 2.7 ? .7 + (h - .6) * .54 : 1.8 - (h - 2.7) * .42;
      dummy.position.set(Math.sin(a) * (r + .03), h, Math.cos(a) * (r + .03)); dummy.scale.set(.055, .11, .055); dummy.updateMatrix(); seeds.setMatrixAt(i, dummy.matrix);
    }
    fruit.add(seeds);
    const leafMaterial = new THREE.MeshStandardMaterial({ color: 0x39764a, roughness: .9 });
    for (let i = 0; i < 6; i++) {
      const leaf = ellipsoid(fruit, [Math.sin(i) * .6, 4, Math.cos(i) * .6], [.24, .07, .9], leafMaterial);
      leaf.rotation.y = i; leaf.rotation.x = .25;
    }
  }

  private buildBat(): void {
    const wood = new THREE.MeshStandardMaterial({ color: 0xe8c890, roughness: .6 });
    const grip = new THREE.MeshStandardMaterial({ color: 0x443c30, roughness: .9 });
    rod(this.bat, new THREE.Vector3(0, .42, .05), new THREE.Vector3(.08, .62, .22), grip, 1.4);
    rod(this.bat, new THREE.Vector3(.08, .62, .22), new THREE.Vector3(.18, 1.05, .72), wood, 2.6);
    this.bat.position.set(.22, .02, .08);
    this.bat.rotation.z = -.55;
  }

  resetFielders(): void {
    this.fielders.forEach((fly, i) => {
      fly.group.position.set(POSITIONS[i].x, 0, POSITIONS[i].z);
      fly.group.rotation.y = i === 0 ? 0 : Math.atan2(-POSITIONS[i].x, 12 - POSITIONS[i].z);
      fly.moving = fly.reaching = fly.throwing = fly.swinging = false;
    });
    this.batter.group.position.set(-.55, 0, 12.15); this.batter.group.rotation.y = Math.PI;
  }

  setTeams(batting: number): void {
    this.fielders.forEach(fly => fly.team(1 - batting)); this.batter.team(batting); this.runners.forEach(fly => fly.team(batting));
  }

  pick(clientX: number, clientY: number): number | null {
    const rect = this.canvas.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2((clientX - rect.left) / rect.width * 2 - 1, -(clientY - rect.top) / rect.height * 2 + 1), this.camera);
    const hits = this.raycaster.intersectObjects(this.fielders.map(f => f.group), true);
    for (const hit of hits) {
      let object: THREE.Object3D | null = hit.object;
      while (object) {
        if (typeof object.userData.fielder === 'number') return object.userData.fielder;
        object = object.parent;
      }
    }
    // Give small fielders a practical screen-space picking radius on phones.
    let closest: number | null = null; let distance = 30;
    this.fielders.forEach((f, i) => {
      const p = this.project(f.group.position.clone().add(new THREE.Vector3(0, 1, 0)));
      const d = Math.hypot(p.x - clientX + rect.left, p.y - clientY + rect.top);
      if (d < distance) { distance = d; closest = i; }
    });
    return closest;
  }

  movementVector(x: number, y: number): THREE.Vector3 {
    const forward = new THREE.Vector3(); this.camera.getWorldDirection(forward); forward.y = 0; forward.normalize();
    return forward.clone().cross(up).multiplyScalar(x).addScaledVector(forward, -y).normalize();
  }

  project(point: THREE.Vector3): { x: number; y: number } {
    const p = point.clone().project(this.camera); return { x: (p.x + 1) / 2 * this.width, y: (1 - p.y) / 2 * this.height };
  }

  clearTrail(): void { this.trailPoints = []; this.trail.geometry.setDrawRange(0, 0); }

  activityPosition(): { x: number; y: number; width: number; height: number } {
    const center = this.project(this.activityFrame.position);
    const height = this.width <= 700 ? 64 : 108;
    return { ...center, width: height * 4.65 / 4.15, height };
  }

  setActivityVisible(visible: boolean): void {
    this.activityFrame.visible = visible; this.activityRing.visible = visible; this.activityLeader.visible = visible;
  }

  containsLabel(x: number, y: number, width: number, height: number): boolean {
    const area = this.playArea;
    return x - width / 2 > area.left && x + width / 2 < area.left + area.width
      && y - height > area.top && y < area.top + area.height;
  }

  resize(): void {
    this.width = this.canvas.clientWidth; this.height = this.canvas.clientHeight;
    this.renderer.setSize(this.width, this.height, false);
    const roster = document.querySelector('.roster')!.getBoundingClientRect();
    const status = document.querySelector('.play-status')!.getBoundingClientRect();
    const overlay = document.querySelector('.flyout-connectome')?.getBoundingClientRect();
    const topbar = document.querySelector('.topbar')!.getBoundingClientRect();
    const compact = this.width <= 700;
    const left = compact ? 10 : roster.right + 18;
    const right = compact ? this.width - 10 : (overlay?.left ?? this.width - 320) - 18;
    const top = compact ? Math.max(roster.bottom, overlay?.bottom ?? 0) + 10 : topbar.bottom + 24;
    const bottom = status.top - 16;
    this.playArea = { left, top, width: Math.max(100, right - left), height: Math.max(100, bottom - top) };
  }

  render(time: number, delta: number, movingBall: boolean, swing: number, phase = 'ready'): void {
    if (this.disposed) return;
    this.renderer.info.reset();
    const area = this.playArea;
    this.camera.aspect = Math.max(.5, this.width / Math.max(1, this.height));
    const atBat = phase === 'ready' || phase === 'pitch' || phase === 'result';
    this.strikeZone.visible = atBat;
    if (this.follow) {
      const fielder = this.fielders[this.selected].group.position;
      this.desired.set(fielder.x + 2.4, 3.1, fielder.z + 4.6);
      this.look.set(fielder.x, 1.1, fielder.z);
      this.camera.fov = 46;
    } else if (atBat) {
      const mound = this.fielders[0].group.position;
      this.desired.set(2.2, 1.7, 14.3);
      const ball = this.ball.position;
      if (phase === 'pitch') this.look.set(ball.x * .2, Math.max(.9, ball.y * .35 + .8), ball.z * .65 + mound.z * .35);
      else this.look.set(mound.x + .15, 1.14, mound.z + .15);
      this.camera.fov = this.width <= 700 ? 42 : 34;
    } else {
      const ball = this.ball.position;
      this.desired.set(ball.x - 2.2, Math.max(2.4, ball.y + 2.6), ball.z + 4.4);
      this.look.set(ball.x, Math.max(.6, ball.y), ball.z - 1.5);
      this.camera.fov = 50;
    }
    const blend = 1 - Math.exp(-3.2 * Math.max(.016, delta));
    this.camera.position.lerp(this.desired, blend);
    this.target.lerp(this.look, blend);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.target);
    this.camera.updateProjectionMatrix(); this.camera.updateMatrixWorld();
    const dist = this.camera.position.distanceTo(this.target);
    this.viewHeight = Math.max(6, dist * 1.1);
    const units = this.viewHeight / this.height;
    this.fielders.forEach((fly, i) => fly.animate(time + i * .3, i === this.selected));
    this.batter.animate(time, false); this.runners.forEach((fly, i) => fly.animate(time + i, false));
    [...this.fielders, this.batter, ...this.runners].forEach((fly, i) => {
      this.shadowTransform.position.copy(fly.group.position); this.shadowTransform.position.y = .072;
      this.shadowTransform.rotation.set(-Math.PI / 2, 0, -fly.group.rotation.y);
      this.shadowTransform.scale.set(fly.group.visible ? 1 : 0, fly.group.visible ? .65 : 0, 1);
      this.shadowTransform.updateMatrix(); this.contactShadows.setMatrixAt(i, this.shadowTransform.matrix);
    });
    this.contactShadows.instanceMatrix.needsUpdate = true;
    this.bat.rotation.z = -.7 + Math.sin(Math.min(1, swing) * Math.PI) * 2;
    this.bat.rotation.y = Math.sin(Math.min(1, swing) * Math.PI) * -2.5;
    const selected = this.fielders[this.selected].group.position;
    this.ring.position.set(selected.x, .08, selected.z);
    this.shadow.position.set(this.ball.position.x, .08, this.ball.position.z);
    this.shadow.visible = this.ball.visible;
    this.shadow.scale.setScalar(1 + Math.max(0, this.ball.position.y) * .06);
    this.ball.rotation.x += movingBall ? delta * 12 : 0;
    this.ball.scale.setScalar(Math.max(1, units * (this.width <= 700 ? 7 : 8) / .56));
    if (movingBall) {
      this.trailPoints.push(this.ball.position.clone());
      if (this.trailPoints.length > 24) this.trailPoints.shift();
      this.trailPoints.forEach((point, i) => point.toArray(this.trailPositions, i * 3));
      this.trail.geometry.getAttribute('position').needsUpdate = true;
      this.trail.geometry.setDrawRange(0, this.trailPoints.length);
    }
    this.trail.visible = movingBall;
    this.landing.rotation.y = time * .45;
    this.activityRing.position.copy(this.activityActor.position); this.activityRing.position.y = .085;
    const pixelHeight = this.width <= 700 ? 64 : 108;
    const halfWidth = pixelHeight * 4.65 / 4.15 / 2, halfHeight = pixelHeight / 2;
    const anchor = this.project(this.activityActor.position.clone().add(new THREE.Vector3(0, 1.9, 0)));
    const onScreen = Number.isFinite(anchor.x) && Number.isFinite(anchor.y)
      && anchor.x > area.left - 80 && anchor.x < area.left + area.width + 80
      && anchor.y > area.top - 80 && anchor.y < area.top + area.height + 80;
    const originX = onScreen
      ? THREE.MathUtils.clamp(anchor.x, area.left + halfWidth, area.left + area.width - halfWidth)
      : area.left + area.width - halfWidth - 12;
    const originY = onScreen
      ? THREE.MathUtils.clamp(anchor.y, area.top + halfHeight, area.top + area.height - halfHeight - 16)
      : area.top + halfHeight + 12;
    const players = [...this.fielders, this.batter, ...this.runners].filter(fly => fly.group.visible)
      .map(fly => this.project(fly.group.position.clone().add(new THREE.Vector3(0, 1, 0))));
    players.push(this.project(this.ball.position));
    // Keep the instrument on-screen. The 2K camera often puts the batter near or past the frustum edge.
    const offsets = [[halfWidth + 18, -halfHeight * .7], [-halfWidth - 18, -halfHeight * .7],
      [halfWidth + 18, halfHeight], [-halfWidth - 18, halfHeight], [0, -halfHeight - 30], [0, halfHeight + 30],
      [halfWidth + 50, -halfHeight * .7], [-halfWidth - 50, -halfHeight * .7],
      [halfWidth + 50, halfHeight], [-halfWidth - 50, halfHeight]];
    let best = Infinity, frameX = originX, frameY = originY;
    offsets.forEach(([dx, dy], index) => {
      const x = THREE.MathUtils.clamp(originX + dx, area.left + halfWidth, area.left + area.width - halfWidth);
      const y = THREE.MathUtils.clamp(originY + dy, area.top + halfHeight, area.top + area.height - halfHeight - 16);
      const cost = players.filter(p => Math.abs(p.x - x) < halfWidth + 12 && Math.abs(p.y - y) < halfHeight + 14).length * 100 + index;
      if (cost < best) { best = cost; frameX = x; frameY = y; }
    });
    const distance = 3.8;
    const direction = new THREE.Vector3(frameX / this.width * 2 - 1, -(frameY / this.height) * 2 + 1, .5)
      .unproject(this.camera).sub(this.camera.position).normalize();
    this.activityFrame.position.copy(this.camera.position).addScaledVector(direction, distance);
    this.activityFrame.quaternion.copy(this.camera.quaternion);
    const worldHeight = 2 * distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) * .5);
    this.activityFrame.scale.setScalar(pixelHeight / this.height * worldHeight / 4.15);
    const leader = this.activityLeader.geometry.getAttribute('position');
    leader.setXYZ(0, this.activityActor.position.x, this.activityActor.position.y + 1.9, this.activityActor.position.z);
    leader.setXYZ(1, this.activityFrame.position.x, this.activityFrame.position.y, this.activityFrame.position.z);
    leader.needsUpdate = true;
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    if (this.disposed) return; this.disposed = true; this.observer.disconnect();
    const geometries = new Set<THREE.BufferGeometry>(); const materials = new Set<THREE.Material>(); const textures = new Set<THREE.Texture>();
    this.scene.traverse(object => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
        geometries.add(object.geometry);
        (Array.isArray(object.material) ? object.material : [object.material]).forEach(material => materials.add(material));
      }
    });
    materials.forEach(material => {
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
      material.dispose();
    });
    this.surfaceTextures.forEach(texture => textures.add(texture));
    textures.forEach(texture => texture.dispose()); geometries.forEach(geometry => geometry.dispose());
    this.renderer.dispose();
  }
}

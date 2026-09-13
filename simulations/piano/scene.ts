import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { ActivityConnectome } from "../../src/activityConnectome";
import { KEYS, WHITE_WIDTH, isBlackKey, noteName } from "./score";
import { FOOT_RADIUS, KEY_TRAVEL, LEGS, LEG_ASSIGNMENTS, articulateLegs, keySurfacePoint } from "./performance";
import type { LegId } from "./performance";
import { PianoActuator } from "./actuator";
import type { PerformedNote } from "./actuator";
import type { PianoNeuralSession, PianoModelInfo } from "./neural-session";

interface PianoKey { midi: number; pivot: THREE.Group; mesh: THREE.Mesh; material: THREE.MeshPhysicalMaterial; pressed: number }
interface FlyLeg { id: LegId; side: number; row: number; segments: THREE.Mesh[]; joints: THREE.Mesh[]; foot: THREE.Mesh }

export class PianoScene {
  private renderer: THREE.WebGLRenderer;
  private world = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(36, 1, 0.1, 80);
  private orbit: OrbitControls;
  private resizeObserver: ResizeObserver;
  private environment: THREE.WebGLRenderTarget;
  private connectome: ActivityConnectome;
  private keys: PianoKey[] = [];
  private fly = new THREE.Group();
  private wings: THREE.Group[] = [];
  private legs: FlyLeg[] = [];
  private raycaster = new THREE.Raycaster();
  private pointerStart = new THREE.Vector2();
  private manual = new Map<number, number>();
  private disposed = false;
  private frame = 0;
  private lastBeat = 0;
  private reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  private onNote: (midi: number) => void;
  private onLost: () => void;
  private axis = new THREE.Vector3(0, 1, 0);
  private delta = new THREE.Vector3();
  private midpoint = new THREE.Vector3();
  private meshes = new Set<THREE.BufferGeometry>();
  private materials = new Set<THREE.Material>();
  private textures = new Set<THREE.Texture>();
  private sphereGeometry = new THREE.SphereGeometry(1, 28, 18);
  private activeManual: number[] = [];
  private idle = new PianoActuator();
  private performance = this.idle.pose(this.reducedMotion);
  private activity = { label: "Neural model loading", detail: "No autonomous notes until ready" };
  private performed: readonly PerformedNote[] = [];

  constructor(private canvas: HTMLCanvasElement, onNote: (midi: number) => void, onLost: () => void) {
    this.onNote = onNote;
    this.onLost = onLost;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.94;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.world.background = new THREE.Color(0xe6e9e8);
    this.world.fog = new THREE.Fog(0xe6e9e8, 24, 55);
    const generator = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.environment = generator.fromScene(room, 0.04);
    this.world.environment = this.environment.texture;
    this.world.environmentIntensity = 0.72;
    room.dispose(); generator.dispose();
    this.orbit = new OrbitControls(this.camera, canvas);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.075;
    this.orbit.enablePan = false;
    this.orbit.minPolarAngle = 0.36;
    this.orbit.maxPolarAngle = Math.PI / 2 - 0.05;
    this.orbit.minDistance = 5.8;
    this.orbit.maxDistance = 28;
    this.orbit.rotateSpeed = 0.5;
    this.orbit.zoomSpeed = 0.65;
    this.lighting();
    this.buildPiano();
    this.buildFly();
    this.connectome = new ActivityConnectome(this.renderer, { mount: canvas.parentElement!, className: "piano-connectome" });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement!);
    this.resize(); this.resetCamera();
    canvas.addEventListener("pointerdown", this.pointerDown);
    canvas.addEventListener("pointerup", this.pointerUp);
    canvas.addEventListener("webglcontextlost", this.contextLost);
    canvas.dataset.ready = "true";
  }

  private ownMaterial<T extends THREE.Material>(material: T): T { this.materials.add(material); return material; }

  private mesh(parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
    this.meshes.add(geometry); this.materials.add(material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
  }

  private box(parent: THREE.Object3D, size: number[], position: number[], material: THREE.Material, radius = 0.015): THREE.Mesh {
    const mesh = this.mesh(parent, new RoundedBoxGeometry(size[0], size[1], size[2], 2, radius), material);
    mesh.position.fromArray(position); return mesh;
  }

  private sphere(parent: THREE.Object3D, position: number[], scale: number[], material: THREE.Material): THREE.Mesh {
    const mesh = this.mesh(parent, this.sphereGeometry, material);
    mesh.position.fromArray(position); mesh.scale.fromArray(scale); return mesh;
  }

  private segment(parent: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, radius: number, material: THREE.Material): THREE.Mesh {
    const mesh = this.mesh(parent, new THREE.CylinderGeometry(radius * 0.7, radius, 1, 8), material);
    this.positionSegment(mesh, a, b); return mesh;
  }

  private positionSegment(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3): void {
    mesh.position.copy(this.midpoint.copy(a).add(b).multiplyScalar(0.5));
    mesh.scale.y = Math.max(0.001, a.distanceTo(b));
    mesh.quaternion.setFromUnitVectors(this.axis, this.delta.copy(b).sub(a).normalize());
  }

  private lighting(): void {
    this.world.add(new THREE.HemisphereLight(0xf4f7fa, 0x758780, 0.8));
    const key = new THREE.DirectionalLight(0xffefdc, 3.0);
    key.position.set(-3.5, 7, 4); key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024); key.shadow.bias = -0.00012; key.shadow.normalBias = 0.012;
    Object.assign(key.shadow.camera, { left: -6, right: 6, top: 5, bottom: -5, near: 0.5, far: 18 });
    key.shadow.radius = 4; this.world.add(key);
    const fill = new THREE.DirectionalLight(0xcbe8f4, 1.35); fill.position.set(4, 3, 1); this.world.add(fill);
    const rim = new THREE.DirectionalLight(0xffe0c4, 2.5); rim.position.set(-1, 5, -5); this.world.add(rim);
    const floor = this.mesh(this.world, new THREE.PlaneGeometry(180, 180), new THREE.MeshStandardMaterial({ color: 0xc9d1ce, roughness: 0.87 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -0.015; floor.castShadow = false;
  }

  private grainTexture(): THREE.CanvasTexture {
    const canvas = document.createElement("canvas"); canvas.width = 256; canvas.height = 256;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#bdbdbd"; ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 180; i++) {
      ctx.strokeStyle = `rgba(65,65,65,${0.04 + (i % 7) * 0.009})`;
      ctx.lineWidth = i % 5 === 0 ? 1.4 : 0.5;
      const y = (i * 47.31) % 256;
      ctx.beginPath(); ctx.moveTo(0, y);
      ctx.bezierCurveTo(80, y + Math.sin(i) * 3, 160, y - Math.cos(i) * 3, 256, y + Math.sin(i * 2) * 2);
      ctx.stroke();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(3, 2); texture.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
    this.textures.add(texture); return texture;
  }

  private pianoShape(scale = 1): THREE.Shape {
    const shape = new THREE.Shape();
    shape.moveTo(-2 * scale, 0.43 * scale);
    shape.lineTo(2 * scale, 0.43 * scale);
    shape.lineTo(2 * scale, -0.4 * scale);
    shape.bezierCurveTo(2 * scale, -1.12 * scale, 0.58 * scale, -0.78 * scale, 0.46 * scale, -1.96 * scale);
    shape.bezierCurveTo(0.42 * scale, -2.83 * scale, -1.6 * scale, -2.9 * scale, -2 * scale, -2.05 * scale);
    shape.lineTo(-2 * scale, 0.43 * scale); shape.closePath(); return shape;
  }

  private buildPiano(): void {
    const grain = this.grainTexture();
    const lacquer = this.ownMaterial(new THREE.MeshPhysicalMaterial({ color: 0x090e10, metalness: 0.22, roughness: 0.16, clearcoat: 1, clearcoatRoughness: 0.095 }));
    const edge = this.ownMaterial(new THREE.MeshPhysicalMaterial({ color: 0x1c2528, metalness: 0.6, roughness: 0.23, clearcoat: 0.7 }));
    const gold = this.ownMaterial(new THREE.MeshStandardMaterial({ color: 0xbc9654, metalness: 0.82, roughness: 0.29 }));
    const felt = this.ownMaterial(new THREE.MeshStandardMaterial({ color: 0x602d44, roughness: 0.98, bumpMap: grain, bumpScale: 0.009 }));
    const leather = this.ownMaterial(new THREE.MeshPhysicalMaterial({ color: 0x482c40, roughness: 0.59, clearcoat: 0.22, bumpMap: grain, bumpScale: 0.012 }));
    const piano = new THREE.Group(); this.world.add(piano);

    const outer = this.pianoShape();
    const hole = new THREE.Path(this.pianoShape(0.952).getPoints(70));
    outer.holes.push(hole);
    const rimGeometry = new THREE.ExtrudeGeometry(outer, { depth: 0.26, bevelEnabled: true, bevelSegments: 3, steps: 1, bevelSize: 0.023, bevelThickness: 0.025, curveSegments: 40 });
    rimGeometry.rotateX(Math.PI / 2);
    const rim = this.mesh(piano, rimGeometry, lacquer); rim.position.y = 1.81;

    const boardGeometry = new THREE.ExtrudeGeometry(this.pianoShape(0.953), { depth: 0.1, bevelEnabled: false, curveSegments: 40 });
    boardGeometry.rotateX(Math.PI / 2);
    const board = this.mesh(piano, boardGeometry, new THREE.MeshStandardMaterial({ color: 0x9b7643, roughness: 0.61, metalness: 0.16, bumpMap: grain, bumpScale: 0.028 }));
    board.position.y = 1.65;
    this.box(piano, [3.97, 0.19, 1.05], [0, 1.54, 0.94], lacquer);
    this.box(piano, [4.05, 0.1, 0.08], [0, 1.48, 1.48], edge);
    this.box(piano, [3.97, 0.013, 0.019], [0, 1.535, 1.53], gold, 0.003);
    this.box(piano, [3.9, 0.24, 0.13], [0, 1.79, 0.37], lacquer);
    this.box(piano, [3.7, 0.024, 0.047], [0, 1.77, 0.47], felt, 0.002);
    for (const side of [-1, 1]) this.box(piano, [0.16, 0.24, 1.03], [side * 1.94, 1.67, 0.96], lacquer, 0.025);

    const whiteGeometry = new RoundedBoxGeometry(WHITE_WIDTH - 0.009, 0.11, 0.93, 2, 0.008);
    const blackGeometry = new RoundedBoxGeometry(WHITE_WIDTH * 0.59, 0.12, 0.52, 2, 0.006);
    for (const key of KEYS) {
      const material = new THREE.MeshPhysicalMaterial({ color: key.black ? 0x111719 : 0xf2f0e7, roughness: key.black ? 0.29 : 0.24, metalness: 0.015, clearcoat: key.black ? 0.28 : 0.55, clearcoatRoughness: 0.2, emissive: 0xbe537c, emissiveIntensity: 0 });
      const pivot = new THREE.Group(); pivot.position.set(key.x, key.black ? 1.83 : 1.71, 0.48); piano.add(pivot);
      const keyMesh = this.mesh(pivot, key.black ? blackGeometry : whiteGeometry, material);
      keyMesh.position.set(0, 0, key.black ? 0.23 : 0.45);
      keyMesh.userData.midi = key.midi;
      this.keys.push({ midi: key.midi, pivot, mesh: keyMesh, material, pressed: 0 });
    }

    // Harp frame and strings remain visible beneath the half-raised lid.
    this.box(piano, [3.67, 0.055, 0.10], [0, 1.72, 0.14], gold);
    this.box(piano, [3.59, 0.015, 0.04], [0, 1.743, -0.025], felt, 0.003);
    const wire = this.ownMaterial(new THREE.MeshStandardMaterial({ color: 0xd5cab0, metalness: 0.85, roughness: 0.3 }));
    const wireGeometry = new THREE.CylinderGeometry(1, 1, 1, 6); this.meshes.add(wireGeometry);
    const strings = new THREE.InstancedMesh(wireGeometry, wire, 66);
    const pinGeometry = new THREE.CylinderGeometry(0.012, 0.012, 0.026, 8); this.meshes.add(pinGeometry);
    const pins = new THREE.InstancedMesh(pinGeometry, gold, 66);
    const dummy = new THREE.Object3D(); let stringIndex = 0;
    for (let index = 0; index < 33; index++) {
      const x = -1.79 + index * 0.101;
      const endZ = x < 0.2 ? -2.48 + 0.1 * (x + 0.7) ** 2 : -1.67 + (x - 0.2) * 0.68;
      for (const offset of [-0.008, 0.008]) {
        const a = new THREE.Vector3(x + offset, 1.71, 0.1), b = new THREE.Vector3(x + offset - 0.1, 1.71, endZ);
        dummy.position.copy(a).add(b).multiplyScalar(0.5);
        dummy.quaternion.setFromUnitVectors(this.axis, this.delta.copy(b).sub(a).normalize());
        const radius = index < 10 ? 0.0037 : 0.0021;
        dummy.scale.set(radius, a.distanceTo(b), radius); dummy.updateMatrix();
        strings.setMatrixAt(stringIndex, dummy.matrix);
        dummy.position.set(x + offset, 1.756, 0.15 + (stringIndex % 2) * 0.045);
        dummy.rotation.set(0, 0, 0); dummy.scale.setScalar(1); dummy.updateMatrix();
        pins.setMatrixAt(stringIndex++, dummy.matrix);
      }
    }
    piano.add(strings, pins);
    for (const x of [-1.15, -0.3, 0.55]) this.segment(piano, new THREE.Vector3(x, 1.745, 0.1), new THREE.Vector3(x - 0.37, 1.745, x > 0 ? -1.35 : -2.35), 0.027, gold);

    const lid = new THREE.Group(); lid.position.set(-2, 1.92, 0); lid.rotation.z = 0.34; piano.add(lid);
    const lidGeometry = new THREE.ExtrudeGeometry(this.pianoShape(1.01), { depth: 0.072, bevelEnabled: true, bevelSize: 0.018, bevelThickness: 0.012, bevelSegments: 3, curveSegments: 40 });
    lidGeometry.rotateX(Math.PI / 2); lidGeometry.translate(2, 0, 0);
    this.mesh(lid, lidGeometry, lacquer);
    const lidLine = new THREE.BufferGeometry().setFromPoints(this.pianoShape(0.991).getPoints(100).map(point => new THREE.Vector3(point.x + 2, 0.014, point.y)));
    this.meshes.add(lidLine);
    lid.add(new THREE.LineLoop(lidLine, this.ownMaterial(new THREE.LineBasicMaterial({ color: 0x757f7e, transparent: true, opacity: 0.55 }))));
    this.segment(piano, new THREE.Vector3(1.67, 1.82, -0.15), new THREE.Vector3(1.41, 3.12, -0.15), 0.025, lacquer);
    for (const z of [-1.8, -0.9, 0.05]) this.box(piano, [0.03, 0.07, 0.15], [-2.025, 1.9, z], gold, 0.003);

    for (const [x, z] of [[-1.72, 0.63], [1.72, 0.63], [-0.99, -2.16]]) {
      const leg = this.box(piano, [0.17, 1.43, 0.19], [x, 0.78, z], lacquer, 0.018);
      leg.rotation.z = -Math.sign(x) * 0.025;
      this.box(piano, [0.19, 0.1, 0.21], [x, 0.09, z], gold, 0.015);
      const wheel = this.mesh(piano, new THREE.CylinderGeometry(0.055, 0.055, 0.07, 16), edge); wheel.position.set(x, 0.053, z); wheel.rotation.z = Math.PI / 2;
    }
    this.box(piano, [0.35, 0.95, 0.13], [0, 0.94, 0.9], lacquer);
    this.box(piano, [0.72, 0.12, 0.35], [0, 0.44, 1.01], lacquer);
    for (const x of [-0.21, 0, 0.21]) this.box(piano, [0.11, 0.045, 0.33], [x, 0.44, 1.24], gold, 0.025);

    this.box(this.world, [2.92, 0.15, 0.68], [0, 1.1, 2.03], lacquer, 0.028);
    this.box(this.world, [2.86, 0.16, 0.65], [0, 1.22, 2.03], leather, 0.07);
    for (const x of [-1.28, 1.28]) for (const z of [1.82, 2.25]) this.box(this.world, [0.1, 1.05, 0.1], [x, 0.55, z], lacquer);
    for (const x of [-0.93, -0.31, 0.31, 0.93]) for (const z of [1.9, 2.13]) this.sphere(this.world, [x, 1.301, z], [0.026, 0.009, 0.026], leather);
    const stitchGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-1.32, 1.282, 1.77), new THREE.Vector3(1.32, 1.282, 1.77),
      new THREE.Vector3(1.35, 1.282, 1.80), new THREE.Vector3(1.35, 1.282, 2.26),
      new THREE.Vector3(1.32, 1.282, 2.29), new THREE.Vector3(-1.32, 1.282, 2.29),
      new THREE.Vector3(-1.35, 1.282, 2.26), new THREE.Vector3(-1.35, 1.282, 1.80), new THREE.Vector3(-1.32, 1.282, 1.77),
    ]); this.meshes.add(stitchGeometry);
    const stitching = new THREE.Line(stitchGeometry, this.ownMaterial(new THREE.LineDashedMaterial({ color: 0xb48597, dashSize: 0.012, gapSize: 0.012, transparent: true, opacity: 0.6 })));
    stitching.computeLineDistances(); this.world.add(stitching);

    const inscription = document.createElement("canvas"); inscription.width = 768; inscription.height = 96;
    const ctx = inscription.getContext("2d")!;
    ctx.fillStyle = "#c2b997"; ctx.font = "32px Georgia"; ctx.textAlign = "center"; ctx.fillText("H O U S E F L Y", 384, 56);
    const texture = new THREE.CanvasTexture(inscription); texture.colorSpace = THREE.SRGBColorSpace; this.textures.add(texture);
    const logo = this.mesh(piano, new THREE.PlaneGeometry(0.66, 0.083), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }));
    logo.position.set(0, 1.82, 0.442); logo.castShadow = false;
  }

  private buildFly(): void {
    const shell = this.ownMaterial(new THREE.MeshPhysicalMaterial({ color: 0x5b685c, roughness: 0.39, metalness: 0.25, clearcoat: 0.48, clearcoatRoughness: 0.26 }));
    const dark = this.ownMaterial(new THREE.MeshStandardMaterial({ color: 0x202e2a, roughness: 0.52, metalness: 0.12 }));
    const abdomen = this.ownMaterial(new THREE.MeshPhysicalMaterial({ color: 0x8b7954, roughness: 0.46, metalness: 0.18, clearcoat: 0.3 }));
    const eye = this.ownMaterial(new THREE.MeshPhysicalMaterial({ color: 0xb6253b, roughness: 0.25, clearcoat: 0.9, clearcoatRoughness: 0.19 }));
    const joint = this.ownMaterial(new THREE.MeshStandardMaterial({ color: 0x9b8c62, roughness: 0.45, metalness: 0.15 }));
    this.world.add(this.fly); this.fly.position.fromArray(this.performance.body.position);
    this.sphere(this.fly, [0, 0.35, 0], [0.23, 0.25, 0.31], shell);
    for (const x of [-0.087, 0, 0.087]) this.sphere(this.fly, [x, 0.578 - Math.abs(x) * 0.22, -0.015], [0.016, 0.018, 0.16], dark);
    this.sphere(this.fly, [0, 0.19, 0.41], [0.205, 0.19, 0.4], abdomen);
    this.sphere(this.fly, [0, 0.39, -0.29], [0.205, 0.195, 0.18], shell);
    for (let i = 0; i < 5; i++) {
      const z = 0.19 + i * 0.109;
      const radius = Math.sqrt(Math.max(0.1, 1 - ((z - 0.41) / 0.41) ** 2)) * 0.204;
      const band = this.mesh(this.fly, new THREE.TorusGeometry(radius, 0.011, 6, 32), dark); band.position.set(0, 0.19, z); band.scale.y = 0.94;
    }
    for (const side of [-1, 1]) {
      this.sphere(this.fly, [side * 0.158, 0.42, -0.37], [0.126, 0.151, 0.127], eye);
      const facetGeo = new THREE.IcosahedronGeometry(0.0075, 0); this.meshes.add(facetGeo);
      const facets = new THREE.InstancedMesh(facetGeo, eye, 220);
      const matrix = new THREE.Matrix4();
      for (let i = 0; i < 220; i++) {
        const y = 1 - (i + 0.5) / 220 * 2, phi = i * 2.39996, r = Math.sqrt(1 - y * y);
        matrix.makeTranslation(side * 0.158 + Math.cos(phi) * r * 0.126, 0.42 + y * 0.151, -0.37 + Math.sin(phi) * r * 0.127);
        facets.setMatrixAt(i, matrix);
        facets.setColorAt(i, new THREE.Color().setHSL(0.985, 0.47, 0.44 + (i % 6) * 0.025));
      }
      this.fly.add(facets);
      this.segment(this.fly, new THREE.Vector3(side * 0.064, 0.48, -0.43), new THREE.Vector3(side * 0.11, 0.58, -0.59), 0.014, dark);
      this.sphere(this.fly, [side * 0.11, 0.58, -0.59], [0.021, 0.026, 0.022], shell);
      this.segment(this.fly, new THREE.Vector3(side * 0.11, 0.59, -0.59), new THREE.Vector3(side * 0.15, 0.71, -0.63), 0.0035, dark);
      this.segment(this.fly, new THREE.Vector3(side * 0.19, 0.32, 0.24), new THREE.Vector3(side * 0.3, 0.38, 0.28), 0.007, dark);
      this.sphere(this.fly, [side * 0.3, 0.38, 0.28], [0.025, 0.031, 0.023], joint);

      const wing = new THREE.Group(); wing.position.set(side * 0.11, 0.53, 0.1); wing.rotation.y = side * 1.1; wing.rotation.z = side * 0.2;
      const wingShape = new THREE.Shape(); wingShape.moveTo(0, 0);
      wingShape.bezierCurveTo(side * 0.19, 0.04, side * 0.4, 0.49, side * 0.28, 0.88);
      wingShape.bezierCurveTo(side * 0.11, 1.04, -side * 0.07, 0.72, 0, 0); wingShape.closePath();
      const wingGeo = new THREE.ShapeGeometry(wingShape, 32); wingGeo.rotateX(Math.PI / 2);
      const wingMat = new THREE.MeshPhysicalMaterial({ color: 0xdaece8, roughness: 0.21, metalness: 0.08, clearcoat: 0.75, iridescence: 0.55, iridescenceIOR: 1.3, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false });
      const membrane = this.mesh(wing, wingGeo, wingMat); membrane.castShadow = false;
      const veins: THREE.Vector3[] = [];
      for (const [x, z, endX, endZ] of [
        [0.015, 0.025, 0.10, 0.39], [0.10, 0.39, 0.16, 0.91],
        [0.015, 0.025, 0.18, 0.34], [0.18, 0.34, 0.28, 0.83],
        [0.015, 0.025, 0.04, 0.40], [0.04, 0.40, 0.055, 0.74],
        [0.04, 0.40, 0.10, 0.39], [0.12, 0.59, 0.24, 0.61],
        [0.10, 0.39, 0.21, 0.44],
      ]) {
        veins.push(new THREE.Vector3(side * x, 0.006, z), new THREE.Vector3(side * endX, 0.006, endZ));
      }
      const veinGeo = new THREE.BufferGeometry().setFromPoints(veins); this.meshes.add(veinGeo);
      const veinMaterial = this.ownMaterial(new THREE.LineBasicMaterial({ color: 0x536c61, transparent: true, opacity: 0.62 }));
      wing.add(new THREE.LineSegments(veinGeo, veinMaterial));
      const outline = new THREE.BufferGeometry().setFromPoints(wingShape.getPoints(48).map(point => new THREE.Vector3(point.x, 0.006, point.y)));
      this.meshes.add(outline); wing.add(new THREE.LineLoop(outline, veinMaterial));
      this.fly.add(wing); this.wings.push(wing);

      for (let row = 0; row < 3; row++) {
        const definition = LEGS.find(leg => leg.side === side && leg.row === row)!;
        const segments = [0.025, 0.02, 0.012, 0.0065].map(radius => this.segment(this.world, new THREE.Vector3(), new THREE.Vector3(0, 0.1, 0), radius, dark));
        const joints = [0.028, 0.031, 0.016].map(radius => this.sphere(this.world, [0, 0, 0], [radius, radius, radius], joint));
        const foot = this.sphere(this.world, [0, 0, 0], [0.021, FOOT_RADIUS, 0.031], dark);
        this.legs.push({ id: definition.id, side, row, segments, joints, foot });
      }
    }
    const hairsGeo = new THREE.ConeGeometry(0.0025, 0.069, 3); this.meshes.add(hairsGeo);
    const hairs = new THREE.InstancedMesh(hairsGeo, dark, 100);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < 100; i++) {
      const y = 1 - (i + 0.5) / 100 * 2, phi = i * 2.39996, r = Math.sqrt(1 - y * y);
      const normal = new THREE.Vector3(Math.cos(phi) * r, y, Math.sin(phi) * r);
      dummy.position.set(normal.x * 0.235, 0.35 + normal.y * 0.25, normal.z * 0.31);
      dummy.quaternion.setFromUnitVectors(this.axis, normal); dummy.updateMatrix(); hairs.setMatrixAt(i, dummy.matrix);
    }
    this.fly.add(hairs);
    this.sphere(this.fly, [0, 0.3, -0.43], [0.055, 0.057, 0.066], dark);
  }

  update(beat: number, now: number, playing: boolean, controller?: PianoNeuralSession, modelStatus = "loading", model?: PianoModelInfo | null): void {
    if (this.disposed) return;
    this.lastBeat = beat;
    const actuator = controller?.actuator ?? this.idle;
    const notes = actuator.activeNotes();
    this.performed = [...notes];
    const sounding = new Set(notes.map(note => note.midi));
    for (const [midi, until] of this.manual) {
      if (now < until) sounding.add(midi); else this.manual.delete(midi);
    }
    this.activeManual = [...this.manual.keys()];
    const neural = controller?.neuralFrame;
    this.activity = { label: !controller ? `Neural model ${modelStatus}` : !playing ? "Paused / neural state" : controller.isCalibrating ? "Calibration / neural output" : "Neural performance",
      detail: this.activeManual.length ? `Manual: ${this.activeManual.map(noteName).join(" + ")}` : notes.length ? `Played: ${notes.map(note => `${note.legId} ${noteName(note.midi)}`).join(" + ")}` : "No key contact" };
    this.connectome.element.hidden = !neural;
    if (neural) this.connectome.updateNeural(neural, { ...this.activity, paused: !playing, modelId: model?.modelId, edgeCount: model?.edges });
    const pressures = new Map(actuator.pressures());
    for (const [midi, until] of this.manual) {
      const remaining = until - now;
      const press = Math.max(0, Math.min(1, (700 - remaining) / 45, remaining / 100));
      pressures.set(midi, Math.max(pressures.get(midi) ?? 0, press));
    }
    for (const key of this.keys) {
      key.pressed = pressures.get(key.midi) ?? 0;
      key.pivot.rotation.x = key.pressed * KEY_TRAVEL;
      key.material.emissiveIntensity = key.pressed * (isBlackKey(key.midi) ? 0.44 : 0.22);
    }
    this.performance = actuator.pose(this.reducedMotion);
    for (const pose of this.performance.legs) if (pose.contact && this.manual.has(pose.midi)) {
      // Manual pressure can deepen an already-contacting key; keep its foot on that surface.
      const press = pressures.get(pose.midi) ?? pose.press;
      if (press > pose.press) {
        const targets = this.performance.legs.map(leg => ({ ...leg }));
        const target = targets.find(leg => leg.id === pose.id)!;
        target.press = press; target.tip = keySurfacePoint(target.midi, press, target.row);
        this.performance = articulateLegs(this.performance.body, targets);
      }
    }
    const { body } = this.performance;
    this.fly.position.fromArray(body.position); this.fly.rotation.set(...body.rotation);
    this.wings.forEach((wing, index) => { wing.rotation.z = (index ? 1 : -1) * body.wingAngle; });
    this.fly.updateMatrixWorld(true);
    this.legs.forEach((leg, index) => {
      const pose = this.performance.legs[index], points = pose.joints.map(point => new THREE.Vector3(...point));
      leg.segments.forEach((segment, index) => this.positionSegment(segment, points[index], points[index + 1]));
      leg.joints.forEach((joint, index) => joint.position.copy(points[index + 1]));
      const angle = pose.press * KEY_TRAVEL;
      leg.foot.rotation.x = angle;
      leg.foot.position.copy(points[4]).add(new THREE.Vector3(0, FOOT_RADIUS * Math.cos(angle), FOOT_RADIUS * Math.sin(angle)));
    });
    this.orbit.update(); this.renderer.render(this.world, this.camera);
    this.connectome.render();
    this.frame++;
    this.canvas.dataset.frame = String(this.frame);
    this.canvas.dataset.beat = beat.toFixed(3);
    this.canvas.dataset.notes = [...sounding].join(",");
  }

  press(midi: number): void {
    this.manual.set(midi, performance.now() + 700);
  }

  resetCamera(): void {
    // Consume OrbitControls' residual motion before restoring the fixed view.
    this.orbit.enableDamping = false; this.orbit.update(); this.orbit.enableDamping = true;
    const { width, height } = this.canvas.getBoundingClientRect();
    const portrait = width <= 600;
    const short = height < 360 && !portrait;
    const right = portrait ? 16 : short ? 258 : width < 1100 ? 288 : 364;
    const top = portrait ? 92 : short ? 72 : 110;
    const bottom = portrait ? 168 : 42;
    const left = portrait ? 16 : 32;
    const availableWidth = Math.max(180, width - left - right);
    const availableHeight = Math.max(100, height - top - bottom);
    const centerX = left + availableWidth / 2, centerY = top + availableHeight / 2;
    this.camera.setViewOffset(width, height, width / 2 - centerX, height / 2 - centerY, width, height);
    this.orbit.target.set(-0.08, 1.52, -0.12);
    const direction = new THREE.Vector3(0.46, 0.45, 0.77).normalize();
    const horizontal = new THREE.Vector3().crossVectors(this.axis, direction).normalize();
    const vertical = new THREE.Vector3().crossVectors(direction, horizontal);
    const tangent = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    let distance = 7;
    // Fit the instrument to the clear portion of the canvas, including the raised lid.
    for (const x of [-2.18, 2.18]) for (const y of [0, 3.48]) for (const z of [-2.8, 2.4]) {
      const point = new THREE.Vector3(x, y, z).sub(this.orbit.target);
      const depth = point.dot(direction);
      distance = Math.max(distance,
        depth + Math.abs(point.dot(horizontal)) / (tangent * availableWidth / height),
        depth + Math.abs(point.dot(vertical)) / (tangent * availableHeight / height));
    }
    const framing = portrait ? height < 430 ? 1.04 : 0.89 : 0.84;
    this.camera.position.copy(direction).multiplyScalar(distance * framing).add(this.orbit.target);
    this.orbit.maxDistance = Math.max(28, distance * 1.8);
    this.camera.lookAt(this.orbit.target); this.orbit.update();
  }

  private resize(): void {
    const { width, height } = this.canvas.getBoundingClientRect();
    if (!width || !height) return;
    this.camera.aspect = width / height;
    this.camera.fov = 36;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.resetCamera();
  }

  private pointerDown = (event: PointerEvent): void => { this.pointerStart.set(event.clientX, event.clientY); };
  private pointerUp = (event: PointerEvent): void => {
    if (Math.hypot(event.clientX - this.pointerStart.x, event.clientY - this.pointerStart.y) > 5) return;
    const rect = this.canvas.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), this.camera);
    const hits = this.raycaster.intersectObjects(this.keys.map(key => key.mesh));
    if (hits[0]) this.onNote(hits[0].object.userData.midi as number);
  };
  private contextLost = (event: Event): void => { event.preventDefault(); this.onLost(); };

  getDebugState(): object {
    const rect = this.canvas.getBoundingClientRect();
    return {
      frame: this.frame, beat: this.lastBeat,
      connectome: this.connectome.snapshot(),
      activity: this.activity,
      performed: this.performed,
      fly: this.fly.position.toArray(),
      hover: { ...this.performance.body, wings: this.wings.map(wing => [wing.rotation.x, wing.rotation.y, wing.rotation.z]) },
      camera: this.camera.position.toArray(),
      assignments: LEG_ASSIGNMENTS,
      legs: this.legs.map((leg, index) => {
        const pose = this.performance.legs[index];
        const tip = leg.foot.localToWorld(new THREE.Vector3(0, -1, 0));
        const key = this.keys.find(key => key.midi === pose.midi)!;
        const black = isBlackKey(key.midi);
        const surface = key.mesh.localToWorld(new THREE.Vector3(0, black ? 0.06 : 0.055, (black ? 0.71 + leg.row * 0.075 : 1.065 + leg.row * 0.12) - 0.48 - key.mesh.position.z));
        const screen = tip.clone().project(this.camera);
        return { ...pose, tip: tip.toArray(), keySurface: surface.toArray(), contactError: pose.contact ? tip.distanceTo(surface) : null,
          screen: [rect.left + (screen.x + 1) / 2 * rect.width, rect.top + (1 - screen.y) / 2 * rect.height] };
      }),
      keys: this.keys.map(key => {
        const p = key.mesh.localToWorld(new THREE.Vector3(0, 0.08, isBlackKey(key.midi) ? 0 : 0.29)).project(this.camera);
        return { midi: key.midi, press: key.pressed, x: rect.left + (p.x + 1) / 2 * rect.width, y: rect.top + (1 - p.y) / 2 * rect.height };
      }),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.resizeObserver.disconnect(); this.orbit.dispose();
    this.connectome.dispose();
    this.canvas.removeEventListener("pointerdown", this.pointerDown);
    this.canvas.removeEventListener("pointerup", this.pointerUp);
    this.canvas.removeEventListener("webglcontextlost", this.contextLost);
    this.meshes.forEach(geometry => geometry.dispose());
    this.materials.forEach(material => material.dispose());
    this.textures.forEach(texture => texture.dispose());
    this.environment.dispose(); this.renderer.dispose(); this.world.clear();
  }
}

import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { Action, Card, GameState } from "./activities/blackjack";
import { createDrosophila, loadDrosophilaTemplate, type DrosophilaActor } from "./flyModel";

interface AnimatedCard { mesh: THREE.Mesh; target: THREE.Vector3; from: THREE.Vector3; started: number; angle: number }
interface ChipMove { from: THREE.Vector3; target: THREE.Vector3; delay: number; duration: number }
interface AnimatedChip { mesh: THREE.Mesh; hand: number; units: number; moves: ChipMove[] }

export class CasinoScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(38, 1, 0.1, 50);
  private fly = new THREE.Group();
  private head = new THREE.Group();
  private wings: THREE.Object3D[] = [];
  private actor?: DrosophilaActor;
  private legs: { meshes: THREE.Mesh[]; side: number; row: number }[] = [];
  private joints?: THREE.InstancedMesh;
  private cards = new Map<number, AnimatedCard>();
  private textures = new Map<string, THREE.CanvasTexture>();
  private signature = "";
  private smoke: THREE.Line;
  private action: Action | null = null;
  private gestureStarted = 0;
  private gestureDuration = 750;
  private celebrationStarted = -Infinity;
  private chipSignature = "";
  private chipStarted = -Infinity;
  private chipPhase = "idle";
  private chipRound = -1;
  private wagerChips: AnimatedChip[] = [];
  private chipGeometry = new THREE.CylinderGeometry(0.135, 0.135, 0.044, 40);
  private chipMaterials: THREE.Material[] = [];
  private halfChipMaterials: THREE.Material[] = [];
  private confetti!: THREE.InstancedMesh;
  private winLight = new THREE.PointLight(0xffd588, 0, 4, 2);
  private jointMatrix = new THREE.Matrix4();
  private segmentDirection = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  private legPoints = Array.from({ length: 4 }, () => new THREE.Vector3());
  private grain: THREE.CanvasTexture;
  private flyBase = new THREE.Vector3(1.62, 0.048, 0.55);

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x0d1112, 1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.18;
    this.camera.position.set(0, 5.7, 6.9);
    this.camera.lookAt(-0.05, 0.12, 0);
    this.scene.add(new THREE.HemisphereLight(0xe4eeed, 0x24231e, 1.25));
    const key = new THREE.SpotLight(0xffe8c5, 100, 20, 0.7, 0.75);
    key.position.set(-2, 7, 2); key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.00015; key.shadow.normalBias = 0.015; this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xb5e4ef, 1.65);
    rim.position.set(3, 3, -3); this.scene.add(rim);
    const fill = new THREE.DirectionalLight(0xffead7, 0.7);
    fill.position.set(-3, 2, 4); this.scene.add(fill);
    this.grain = this.grainTexture();
    this.chipMaterials = this.makeChipMaterials();
    this.halfChipMaterials = this.makeChipMaterials(true);
    const generator = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.scene.environment = generator.fromScene(room, 0.04).texture;
    this.scene.environmentIntensity = 0.38;
    room.dispose(); generator.dispose();
    this.table();
    this.fly.position.copy(this.flyBase);
    this.fly.rotation.y = -0.42;
    this.scene.add(this.fly);
    const smokeGeometry = new THREE.BufferGeometry();
    smokeGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(32*3), 3));
    this.smoke = new THREE.Line(smokeGeometry, new THREE.LineBasicMaterial({ color: 0xcbd2d4, transparent: true, opacity: 0.3, depthWrite: false }));
    this.head.add(this.smoke);
    void loadDrosophilaTemplate().then(() => this.mountFly()).catch(() => this.buildFly());
    this.winLight.position.set(1.3, 1.8, 0.7); this.scene.add(this.winLight);
    this.confetti = new THREE.InstancedMesh(new THREE.BoxGeometry(0.018, 0.055, 0.006),
      new THREE.MeshStandardMaterial({ color: 0xeace89, metalness: 0.65, roughness: 0.3 }), 24);
    this.confetti.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.confetti.frustumCulled = false; this.confetti.visible = false; this.scene.add(this.confetti);
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement!);
    this.resize();
    canvas.dataset.ready = "true";
  }

  private table(): void {
    const felt = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.12, 96), new THREE.MeshPhysicalMaterial({ color: 0x124b35, roughness: 0.94, bumpMap: this.grain, bumpScale: 0.012, sheen: 0.7, sheenColor: 0x438663, sheenRoughness: 0.85 }));
    felt.scale.set(3.15, 1, 1.85); felt.receiveShadow = true; this.scene.add(felt);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.2, 96), new THREE.MeshStandardMaterial({ color: 0x191a19, roughness: 0.5, bumpMap: this.grain, bumpScale: 0.008 }));
    base.scale.set(3.3, 1, 1.98); base.position.y = -0.1; this.scene.add(base);
    const leather = new THREE.Mesh(new THREE.TorusGeometry(1, 0.045, 12, 128), new THREE.MeshStandardMaterial({ color: 0x252322, roughness: 0.65, bumpMap: this.grain, bumpScale: 0.018 }));
    leather.rotation.x = Math.PI/2; leather.scale.set(3.16, 1.86, 1); leather.position.y = 0.055; leather.receiveShadow = true; this.scene.add(leather);
    const brass = new THREE.MeshStandardMaterial({ color: 0xc5b081, metalness: 0.72, roughness: 0.35 });
    const rail = new THREE.Mesh(new THREE.TorusGeometry(1, 0.004, 8, 128), brass);
    rail.rotation.x = Math.PI/2; rail.scale.set(3.00, 1.70, 1); rail.position.y = 0.07; this.scene.add(rail);
    const stitches = new THREE.InstancedMesh(new THREE.BoxGeometry(0.017, 0.002, 0.004), new THREE.MeshStandardMaterial({ color: 0x827769, roughness: 1 }), 180);
    const stitch = new THREE.Object3D();
    for (let i = 0; i < stitches.count; i++) {
      const angle = i/stitches.count*Math.PI*2;
      stitch.position.set(Math.cos(angle)*3.17, 0.101, Math.sin(angle)*1.87);
      stitch.rotation.y = -Math.atan2(Math.cos(angle)*1.87, -Math.sin(angle)*3.17);
      stitch.updateMatrix(); stitches.setMatrixAt(i, stitch.matrix);
    }
    this.scene.add(stitches);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(30,30), new THREE.MeshStandardMaterial({ color: 0x0e1213, roughness: 1 }));
    floor.rotation.x = -Math.PI/2; floor.position.y = -0.75; floor.receiveShadow = true; this.scene.add(floor);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.5, 0.7, 24), new THREE.MeshStandardMaterial({ color: 0x101315, metalness: 0.5, roughness: 0.6 }));
    stem.position.y = -0.4; this.scene.add(stem);
    for (let stack = 0; stack < 3; stack++) for (let chip = 0; chip < 4-stack; chip++) {
      const token = new THREE.Mesh(this.chipGeometry, this.chipMaterials);
      token.position.set(1.62 + stack*0.27, 0.087+chip*0.045, 1.28 - stack*0.16);
      token.rotation.y = stack*0.4+chip*0.18;
      token.castShadow = true; token.receiveShadow = true; this.scene.add(token);
    }
    const surface = document.createElement("canvas"); surface.width = 1024; surface.height = 256;
    const ctx = surface.getContext("2d")!;
    ctx.textAlign = "center"; ctx.fillStyle = "#bac8a7";
    ctx.font = "500 88px Georgia"; ctx.fillText("HOUSEFLY", 512, 104);
    ctx.font = "24px Arial"; ctx.fillText("BLACKJACK PAYS 3:2", 512, 161);
    ctx.strokeStyle = "#8d9d83"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(160,194); ctx.lineTo(864,194); ctx.stroke();
    const print = new THREE.CanvasTexture(surface); print.colorSpace = THREE.SRGBColorSpace;
    print.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const marking = new THREE.Mesh(new THREE.PlaneGeometry(2.3,0.575), new THREE.MeshBasicMaterial({map:print, transparent:true, depthWrite:false, opacity:0.8}));
    marking.rotation.x = -Math.PI/2; marking.position.set(-0.65,0.064,-0.06); this.scene.add(marking);
    const bettingRing = new THREE.Mesh(new THREE.RingGeometry(0.30,0.305,64),new THREE.MeshBasicMaterial({color:0xb1b08a,side:THREE.DoubleSide,transparent:true,opacity:0.65}));
    bettingRing.rotation.x = -Math.PI/2; bettingRing.scale.x = 1.55; bettingRing.position.set(0.64,0.066,1.32); this.scene.add(bettingRing);
    const dealerBox = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.428, 64, 1, 0.2, Math.PI-0.4),
      new THREE.MeshBasicMaterial({ color: 0xc5c4a4, side: THREE.DoubleSide, transparent: true, opacity: 0.55 }));
    dealerBox.rotation.x = -Math.PI/2; dealerBox.scale.set(1.7, 1, 1); dealerBox.position.set(-0.55, 0.066, -0.92); this.scene.add(dealerBox);
    const shoe = new THREE.Group();
    const shoeBody = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.22, 0.9), new THREE.MeshStandardMaterial({ color: 0x1d2426, roughness: 0.48, metalness: 0.18 }));
    shoeBody.position.set(2.05, 0.18, -1.05); shoeBody.rotation.y = -0.35; shoeBody.castShadow = true; shoe.add(shoeBody);
    const shoeLip = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.04, 0.18), brass);
    shoeLip.position.set(1.86, 0.16, -0.72); shoeLip.rotation.y = -0.35; shoe.add(shoeLip);
    this.scene.add(shoe);
    const lamp = new THREE.Group();
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 1.6, 10), brass);
    arm.position.set(-0.2, 2.55, -0.1); lamp.add(arm);
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.55, 0.38, 24, 1, true), new THREE.MeshPhysicalMaterial({ color: 0x6a2a2a, roughness: 0.55, side: THREE.DoubleSide, emissive: 0x3a1810, emissiveIntensity: 0.35 }));
    shade.position.set(-0.2, 1.78, -0.1); lamp.add(shade);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffe6b8 }));
    bulb.position.set(-0.2, 1.62, -0.1); lamp.add(bulb);
    this.scene.add(lamp);
  }

  private grainTexture(): THREE.CanvasTexture {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 512;
    const context = canvas.getContext("2d")!; const pixels = context.createImageData(512,512);
    let seed = 41;
    for (let i=0; i<512*512; i++) {
      seed = (Math.imul(seed,1664525)+1013904223) >>> 0;
      const weave = ((i%512)%3===0 ? 9 : 0) + (Math.floor(i/512)%3===0 ? -9 : 0);
      const value = 175 + (seed>>>27) + weave;
      pixels.data.set([value,value,value,255],i*4);
    }
    context.putImageData(pixels,0,0);
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.repeat.set(5,5);
    texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy(); return texture;
  }

  private makeChipMaterials(half = false): THREE.Material[] {
    const top = document.createElement("canvas"); top.width = top.height = 256;
    const ctx = top.getContext("2d")!;
    const color = half ? "#307d83" : "#8d2946";
    ctx.fillStyle=color;ctx.fillRect(0,0,256,256);
    ctx.strokeStyle="#f1ede2";ctx.lineWidth=5;
    for (const radius of [85,98]) {ctx.beginPath();ctx.arc(128,128,radius,0,Math.PI*2);ctx.stroke();}
    for(let i=0;i<8;i++) {ctx.save();ctx.translate(128,128);ctx.rotate(i*Math.PI/4);ctx.fillStyle="#f1ede2";ctx.fillRect(-12,105,24,25);ctx.restore();}
    ctx.fillStyle="#f1ede2";ctx.font=`bold ${half ? 48 : 70}px Georgia`;ctx.textAlign="center";ctx.fillText(half ? "1/2" : "1",128,149);
    ctx.font="17px Arial";ctx.fillText("HOUSEFLY",128,185);
    const face = new THREE.CanvasTexture(top);face.colorSpace=THREE.SRGBColorSpace;
    face.anisotropy=this.renderer.capabilities.getMaxAnisotropy();
    const side = document.createElement("canvas");side.width=256;side.height=32;
    const edge=side.getContext("2d")!;edge.fillStyle=color;edge.fillRect(0,0,256,32);
    edge.fillStyle="#f1ede2";for(let i=0;i<8;i++)edge.fillRect(i*32,0,12,32);
    const edgeTexture=new THREE.CanvasTexture(side);edgeTexture.colorSpace=THREE.SRGBColorSpace;
    const cap=new THREE.MeshStandardMaterial({map:face,roughness:0.48,bumpMap:this.grain,bumpScale:0.001});
    return [new THREE.MeshStandardMaterial({map:edgeTexture,roughness:0.52}),cap,cap];
  }

  private mountFly(): void {
    this.actor = createDrosophila(0x8c6844, 0.62);
    const inner = this.actor.body;
    inner.rotation.y = 2.45;
    this.fly.add(this.actor.group);
    const eyes = inner.getObjectByName("eyes");
    if (eyes instanceof THREE.Mesh) {
      const material = (eyes.material as THREE.MeshStandardMaterial).clone();
      material.color.setHex(0xb42838);
      material.emissive.setHex(0x4a0810);
      material.emissiveIntensity = 0.18;
      eyes.material = material;
    }
    const lWing = inner.getObjectByName("lWing");
    const rWing = inner.getObjectByName("rWing");
    if (lWing) this.wings.push(lWing);
    if (rWing) this.wings.push(rWing);
    this.head.position.set(0.28, 0.58, 0.32);
    this.fly.add(this.head);
    this.segment(this.head, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.16, 0.02, 0.12), 0.018, new THREE.MeshStandardMaterial({ color: 0xc18d4c }));
    this.segment(this.head, new THREE.Vector3(0.16, 0.02, 0.12), new THREE.Vector3(0.38, 0.04, 0.22), 0.02, new THREE.MeshStandardMaterial({ color: 0xf2efdf }));
    this.segment(this.head, new THREE.Vector3(0.38, 0.04, 0.22), new THREE.Vector3(0.42, 0.04, 0.24), 0.022, new THREE.MeshStandardMaterial({ color: 0x615652, roughness: 1 }));
    this.segment(this.head, new THREE.Vector3(0.415, 0.04, 0.237), new THREE.Vector3(0.43, 0.042, 0.245), 0.016, new THREE.MeshStandardMaterial({ color: 0xf76e37, emissive: 0xe6421e, emissiveIntensity: 1.5 }));
  }

  private sphere(parent: THREE.Object3D, position: number[], scale: number[], material: THREE.Material): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 20), material);
    mesh.position.fromArray(position); mesh.scale.fromArray(scale); mesh.castShadow = true; parent.add(mesh); return mesh;
  }

  private buildFly(): void {
    const shell = new THREE.MeshPhysicalMaterial({ color: 0x93754c, roughness: 0.48, metalness: 0.12, bumpMap: this.grain, bumpScale: 0.004, clearcoat:0.24, clearcoatRoughness:0.5 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x302820, roughness: 0.7 });
    const face = new THREE.Group(); face.position.set(0,-0.78,-0.4);
    this.head.position.set(0,0.78,0.4); this.head.add(face); this.fly.add(this.head);
    this.sphere(this.fly, [0,0.61,-0.32], [0.23,0.2,0.48], shell);
    for (let ring = 0; ring < 5; ring++) {
      const stripe = new THREE.Mesh(new THREE.TorusGeometry(0.19 - ring*0.016, 0.015, 6, 32), dark);
      stripe.position.set(0,0.61,-0.21-ring*0.1); stripe.scale.y = 0.82; this.fly.add(stripe);
    }
    this.sphere(this.fly, [0,0.69,0.09], [0.29,0.28,0.3], shell);
    this.sphere(face, [0,0.78,0.4], [0.24,0.23,0.18], shell);
    const eyeMaterial = new THREE.MeshPhysicalMaterial({ color: 0x95182b, roughness: 0.3, clearcoat:0.65 });
    for (const side of [-1,1]) {
      this.sphere(face, [side*0.2,0.81,0.47], [0.13,0.19,0.11], eyeMaterial);
      const facets = new THREE.InstancedMesh(new THREE.SphereGeometry(0.013, 6, 4), new THREE.MeshStandardMaterial({ color: 0xe6675b, roughness: 0.4, metalness: 0.15 }), 90);
      const matrix = new THREE.Matrix4();
      for (let i = 0; i < 90; i++) {
        const phi = i*2.39996, y = 1 - (i+0.5)/90*2, r = Math.sqrt(1-y*y);
        matrix.makeTranslation(side*0.2 + Math.cos(phi)*r*0.13, 0.81+y*0.19, 0.47+Math.sin(phi)*r*0.11);
        facets.setMatrixAt(i,matrix);
        facets.setColorAt(i,new THREE.Color().setHSL(0.015+(i%3)*0.006,0.56,0.31+(i%7)*0.025));
      }
      face.add(facets);
      this.segment(face, new THREE.Vector3(side*0.065,0.88,0.56), new THREE.Vector3(side*0.15,1.03,0.66), 0.014, dark);
      this.sphere(face, [side*0.15,1.03,0.66], [0.018,0.025,0.025], dark);
      const wing = new THREE.Group(); wing.position.set(side*0.16,0.86,-0.07); wing.rotation.y = side*0.47;
      const wingMaterial = new THREE.MeshPhysicalMaterial({ color: 0xc0d4cb, transparent: true, opacity: 0.43, roughness: 0.23, metalness: 0.25, side: THREE.DoubleSide, depthWrite: false });
      const outline = new THREE.Shape();
      outline.moveTo(0,0); outline.bezierCurveTo(-0.13,0.25,-0.13,0.86,0.08,1.08);
      outline.bezierCurveTo(0.3,1.2,0.44,0.87,0.36,0.58); outline.bezierCurveTo(0.29,0.25,0.14,0.05,0,0);
      const membrane = new THREE.Mesh(new THREE.ShapeGeometry(outline,32),wingMaterial);
      membrane.rotation.x = -Math.PI/2; membrane.scale.x = side; wing.add(membrane);
      wing.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(outline.getPoints(32).map(p=>new THREE.Vector3(side*p.x,0.005,-p.y))),
        new THREE.LineBasicMaterial({color:0x879e94,transparent:true,opacity:0.65})));
      const veins: THREE.Vector3[] = [];
      for (let v = 0; v < 5; v++) {
        const start = new THREE.Vector3(0,0.014,-0.02);
        const end = new THREE.Vector3(side*(0.02+v*0.075),0.014,-0.99+v*0.095);
        veins.push(start,end);
      }
      veins.push(new THREE.Vector3(side*0.04,0.014,-0.65),new THREE.Vector3(side*0.29,0.014,-0.56),new THREE.Vector3(side*0.01,0.014,-0.37),new THREE.Vector3(side*0.23,0.014,-0.42));
      const geometry = new THREE.BufferGeometry().setFromPoints(veins);
      wing.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0x8a9079, transparent: true, opacity: 0.7 })));
      this.fly.add(wing); this.wings.push(wing);
      for (let row = 0; row < 3; row++) {
        const meshes = Array.from({ length: 3 }, (_,i) => this.segment(this.fly, new THREE.Vector3(), new THREE.Vector3(0,1,0), 0.022-i*0.005, i===2 ? dark : shell));
        this.legs.push({ meshes, side, row });
      }
    }
    this.joints = new THREE.InstancedMesh(new THREE.SphereGeometry(0.026,8,6),dark,12);
    this.joints.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.joints.frustumCulled = false; this.fly.add(this.joints);
    const bristles = new THREE.InstancedMesh(new THREE.ConeGeometry(0.003,0.075,3), dark, 110);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < 110; i++) {
      const theta = i*2.39996, y = 1-(i+0.5)/110*2, r = Math.sqrt(1-y*y);
      dummy.position.set(Math.cos(theta)*r*0.29,0.69+y*0.28,0.09+Math.sin(theta)*r*0.3);
      dummy.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), new THREE.Vector3(Math.cos(theta)*r,y,Math.sin(theta)*r));
      dummy.updateMatrix(); bristles.setMatrixAt(i,dummy.matrix);
    }
    this.fly.add(bristles);
    this.sphere(face,[0,0.67,0.56],[0.07,0.07,0.08],shell);
    this.segment(face,new THREE.Vector3(0.03,0.66,0.59),new THREE.Vector3(0.15,0.67,0.66),0.023,new THREE.MeshStandardMaterial({color:0xc18d4c}));
    this.segment(face,new THREE.Vector3(0.15,0.67,0.66),new THREE.Vector3(0.47,0.7,0.83),0.023,new THREE.MeshStandardMaterial({color:0xf2efdf}));
    this.segment(face,new THREE.Vector3(0.47,0.7,0.83),new THREE.Vector3(0.51,0.7,0.85),0.025,new THREE.MeshStandardMaterial({color:0x615652,roughness:1}));
    this.segment(face,new THREE.Vector3(0.505,0.7,0.847),new THREE.Vector3(0.518,0.702,0.853),0.018,new THREE.MeshStandardMaterial({color:0xf76e37,emissive:0xe6421e,emissiveIntensity:1.5}));
  }

  private segment(parent: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, radius: number, material: THREE.Material): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius*0.72,radius,1,8),material);
    mesh.castShadow = true; this.placeSegment(mesh,a,b); parent.add(mesh); return mesh;
  }
  private placeSegment(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3): void {
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.scale.y = a.distanceTo(b);
    mesh.quaternion.setFromUnitVectors(this.up,this.segmentDirection.subVectors(b,a).normalize());
  }

  gesture(action: Action, duration = 750): void {
    this.action = action; this.gestureStarted = performance.now(); this.gestureDuration = duration;
    this.canvas.dataset.gesture = action;
  }

  celebrate(): void { this.celebrationStarted = performance.now(); }

  private syncChips(game: GameState, now: number): void {
    const signature = `${game.round}/${game.hands.map(hand=>`${hand.bet}:${hand.reward}`).join("/")}/${game.status}`;
    if (signature === this.chipSignature) return;
    this.chipSignature = signature; this.chipStarted = now;
    if (game.round !== this.chipRound || game.status === "ready") {
      for (const chip of this.wagerChips) this.scene.remove(chip.mesh);
      this.wagerChips = [];
      this.chipRound = game.round;
      if (game.status !== "resolved") this.celebrationStarted = -Infinity;
    }
    if (game.status === "ready") { this.chipPhase = "idle"; this.canvas.dataset.chips = "idle"; return; }
    const resolved = game.status === "resolved";
    const stake = game.hands.reduce((sum,hand)=>sum+hand.bet,0);
    const returns = stake + (game.reward ?? 0);
    this.chipPhase = resolved ? returns > 0 ? "collecting" : "lost" : "wagering";
    this.canvas.dataset.chips = this.chipPhase;
    this.canvas.dataset.settlement = resolved ? game.reward! > 0 ? "win" : game.reward! < 0 ? "loss" : "push" : "pending";
    this.canvas.dataset.stake = String(stake);
    this.canvas.dataset.returned = resolved ? String(returns) : "0";
    const previous = this.wagerChips;
    this.wagerChips = [];
    const add = (hand: number, units: number, from: THREE.Vector3, moves: ChipMove[], existing?: AnimatedChip) => {
      const mesh = existing?.mesh ?? new THREE.Mesh(this.chipGeometry,units < 1 ? this.halfChipMaterials : this.chipMaterials);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.position.copy(from); mesh.rotation.set(0,hand*0.35,0);
      this.scene.add(mesh); this.wagerChips.push({mesh,hand,units,moves});
    };
    game.hands.forEach((hand,h)=>{
      const x = game.hands.length === 1 ? 0.64 : 0.42+h*0.44;
      const old = previous.filter(chip=>chip.hand===h);
      const reward = hand.reward ?? 0;
      for (let i=0;i<hand.bet;i++) {
        const bet = new THREE.Vector3(x,0.092+i*0.047,1.32);
        const bank = new THREE.Vector3(1.62+h*0.27,0.27+i*0.047,1.28-h*0.16);
        const dealer = new THREE.Vector3(1.13+h*0.31,0.092+i*0.047,-1.16);
        const from = old[i]?.mesh.position.clone() ?? bank;
        const moves: ChipMove[] = [];
        if (!resolved || !old[i]) moves.push({from,target:bet,delay:i*70,duration:420});
        if (resolved) {
          // Settle each split hand separately, including a late double stake.
          const start = old[i] ? from : bet;
          moves.push({from:start,target:reward < 0 ? dealer : bank,delay:reward > 0 || !old[i] ? 620 : 120,duration:780});
        }
        add(h,1,from,moves,old[i]);
      }
      if (resolved && reward > 0) {
        for (let i=0;i<Math.ceil(reward);i++) {
          const units = Math.min(1,reward-i);
          const from = new THREE.Vector3(1.13+h*0.31,0.092+i*0.047,-1.16);
          const bet = new THREE.Vector3(x,0.092+(hand.bet+i)*0.047,1.32);
          const bank = new THREE.Vector3(1.62+h*0.27,0.27+(hand.bet+i)*0.047,1.28-h*0.16);
          add(h,units,from,[{from,target:bet,delay:i*65,duration:480},{from:bet,target:bank,delay:620,duration:780}]);
        }
      }
    });
    for (const chip of previous) if (!this.wagerChips.some(current=>current.mesh===chip.mesh)) this.scene.remove(chip.mesh);
  }

  private cardTexture(card: Card): THREE.CanvasTexture {
    const key = `${card.face}:${card.suit}`;
    if (this.textures.has(key)) return this.textures.get(key)!;
    const surface = document.createElement("canvas"); surface.width = 768; surface.height = 1088;
    const ctx = surface.getContext("2d")!;
    ctx.scale(2,2);
    ctx.fillStyle = "#fcfcf8"; ctx.fillRect(0,0,384,544);
    ctx.strokeStyle = "#dddcd5"; ctx.lineWidth = 3; ctx.strokeRect(5,5,374,534);
    const suit = {clubs:"\u2663",diamonds:"\u2666",hearts:"\u2665",spades:"\u2660"}[card.suit];
    ctx.fillStyle = ["hearts","diamonds"].includes(card.suit) ? "#ae1830" : "#102228";
    ctx.font = "bold 84px Arial"; ctx.fillText(card.face,22,92);
    ctx.font = "70px Arial"; ctx.fillText(suit,24,161);
    ctx.font = "bold 146px Arial"; ctx.textAlign = "center"; ctx.fillText(card.face,192,299);
    ctx.font = "100px Arial"; ctx.fillText(suit,192,404);
    ctx.save(); ctx.translate(384,544); ctx.rotate(Math.PI); ctx.textAlign = "left"; ctx.font = "bold 84px Arial"; ctx.fillText(card.face,22,92); ctx.restore();
    const texture = new THREE.CanvasTexture(surface); texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy(); this.textures.set(key,texture); return texture;
  }

  private syncCards(game: GameState, now: number): void {
    const signature = `${game.round}/${game.activeHand}/${game.hands.map(h=>h.cards.map(c=>c.id).join(",")).join("|")}/${game.dealer.map(c=>c.id).join(",")}`;
    if (signature === this.signature) return;
    this.signature = signature;
    const retained = new Set<number>();
    const place = (card: Card, x: number, z: number, i: number) => {
      retained.add(card.id);
      let record = this.cards.get(card.id);
      if (!record) {
        const edge = new THREE.MeshStandardMaterial({color:0xe7e6db,roughness:0.64});
        const face = new THREE.MeshBasicMaterial({map:this.cardTexture(card),toneMapped:false});
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.58,0.012,0.82),[edge,edge,face,edge,edge,edge]);
        mesh.castShadow = true; mesh.position.set(2.65,0.2,-1.1);
        record = {mesh, from:mesh.position.clone(), target:new THREE.Vector3(), started:now, angle:0};
        this.cards.set(card.id,record); this.scene.add(mesh);
      }
      record.from.copy(record.mesh.position); record.target.set(x,0.085+i*0.004,z); record.started = now;
      record.angle = z < 0 ? -0.015 : ((i%10)-0.5)*0.025;
    };
    game.dealer.forEach((card,i)=>place(card,-0.55+(i-(game.dealer.length-1)/2)*Math.min(0.64,2.8/Math.max(1,game.dealer.length-1)),-0.92,i));
    game.hands.forEach((hand,h)=>{
      const center = game.hands.length === 1 ? -0.85 : -1.73+h*1.63;
      const gap = Math.min(0.64,(game.hands.length===1?2.5:1.25)/Math.max(1,hand.cards.length-1));
      hand.cards.forEach((card,i)=>place(card,center+(i-(hand.cards.length-1)/2)*gap,0.76,h*10+i));
    });
    for (const [id,record] of this.cards) if (!retained.has(id)) {
      this.scene.remove(record.mesh); record.mesh.geometry.dispose();
      for (const material of new Set(Array.isArray(record.mesh.material) ? record.mesh.material : [record.mesh.material])) material.dispose();
      this.cards.delete(id);
    }
  }

  private resize(): void {
    const width = this.canvas.clientWidth, height = this.canvas.clientHeight;
    this.renderer.setSize(width,height,false); this.camera.aspect = width/Math.max(1,height);
    this.camera.position.set(0, this.camera.aspect < 1 ? 8.2 : 5.6, this.camera.aspect < 1 ? 7.9 : 5.4);
    this.camera.lookAt(-0.05,0.12,0); this.camera.updateProjectionMatrix();
  }

  render(game: GameState, now: number): void {
    this.syncCards(game,now);
    this.syncChips(game,now);
    const celebration = game.status === "resolved" && (game.reward ?? 0) > 0 ? Math.max(0,1-(now-this.celebrationStarted)/2600) : 0;
    this.canvas.dataset.celebrating = String(celebration > 0);
    const chipElapsed = now-this.chipStarted;
    let chipsMoving = false;
    for (const chip of this.wagerChips) {
      for (const move of chip.moves) {
        if (chipElapsed < move.delay) { chipsMoving = true; continue; }
        const p = THREE.MathUtils.clamp((chipElapsed-move.delay)/move.duration,0,1);
        chip.mesh.position.lerpVectors(move.from,move.target,p*p*(3-2*p));
        chip.mesh.position.y += Math.sin(p*Math.PI)*0.025;
        chip.mesh.rotation.y = chip.hand*0.35+Math.sin(p*Math.PI)*0.55;
        if (p < 1) chipsMoving = true;
      }
    }
    this.canvas.dataset.chipMotion = chipsMoving ? this.chipPhase === "collecting" && chipElapsed < 620 ? "settling" : this.chipPhase : "idle";
    const chipProgress = THREE.MathUtils.clamp((chipElapsed-(this.chipPhase === "collecting" ? 620 : 0))/(this.chipPhase === "collecting" ? 780 : 490),0,1);
    const chipReach = this.chipPhase !== "lost" ? Math.sin(chipProgress*Math.PI) : 0;
    const progress = Math.min(1,(now-this.gestureStarted)/this.gestureDuration);
    const gesture = this.action && progress<1 ? Math.sin(progress*Math.PI) : 0;
    if (progress >= 1) this.action = null;
    const tap = Math.sin(progress*Math.PI*(this.action === "Double" ? 4 : 2))**2;
    this.fly.position.x = this.flyBase.x - chipReach*0.1;
    const hop = celebration > 0 ? celebration*Math.sin((now-this.celebrationStarted)/170)**2*0.12 : 0;
    this.fly.position.y = this.flyBase.y + Math.sin(now/1200)*0.006 - gesture*0.025 + hop;
    this.fly.rotation.z = this.action === "Stand" ? Math.sin(progress*Math.PI*3)*gesture*0.1 : gesture*0.025;
    this.fly.rotation.x = -chipReach*0.035-celebration*0.06;
    this.head.rotation.x = gesture*(this.action === "Stand" ? -0.1 : 0.16)-celebration*0.18;
    this.head.rotation.y = this.action === "Stand" ? Math.sin(progress*Math.PI*3)*gesture*0.22 : -chipReach*0.12;
    if (this.actor) {
      const beat = 18 + gesture * 22 + celebration * 40;
      const amp = 0.08 + gesture * 0.22 + celebration * 0.28;
      this.wings.forEach((wing, i) => {
        wing.rotation.x = 0.5;
        wing.rotation.z = (i === 0 ? 1 : -1) * (0.06 + Math.sin(now / 1000 * beat) * amp);
      });
      this.actor.body.rotation.x = this.action === "Hit" || this.action === "Double" ? -gesture * 0.18 : this.action === "Stand" ? gesture * 0.12 : -chipReach * 0.08;
    } else {
      this.wings.forEach((wing,i)=>{wing.rotation.z = (i===0?-1:1)*(0.045+Math.sin(now/120)*0.015+gesture*0.18+celebration*(0.48+Math.sin(now/32)*0.24));});
    }
    this.fly.updateMatrixWorld(true);
    const touch = this.wagerChips[0]?.mesh.position.clone().add(new THREE.Vector3(0.13,0.015,0));
    if (touch) this.fly.worldToLocal(touch);
    for (const [index,leg] of this.legs.entries()) {
      const {side,row,meshes} = leg;
      const z = 0.27-row*0.29;
      const front = row===0;
      const spread = front && this.action === "Split" ? gesture*0.48 : 0;
      let lift = front && this.action === "Stand" ? gesture*0.55 : 0;
      const tapping = front && side===-1 && (this.action === "Hit" || this.action === "Double");
      const reach = tapping ? gesture*0.46 : 0;
      if (tapping) lift = (1-tap)*gesture*0.34;
      if (front) lift += celebration*(0.46+Math.sin(now/130+side)*0.08)*(1-chipReach*0.85);
      const wave = front && this.action === "Stand" ? Math.sin(progress*Math.PI*4)*gesture*0.2 : 0;
      const points = this.legPoints;
      points[0].set(side*0.18,0.65,z);
      points[1].set(side*(0.38+spread*0.3),0.4+lift*0.55,z+0.12);
      points[2].set(side*(0.56+spread)+wave,0.13+lift,z+0.29+reach*0.65);
      points[3].set(side*(0.69+spread)+wave,0.018+lift,z+0.37+reach);
      if (front && side===-1 && touch && chipReach > 0) {
        points[3].lerp(touch,Math.min(1,chipReach*1.6));
        points[2].lerp(this.segmentDirection.copy(touch).add(new THREE.Vector3(0.12,0.14,-0.08)),chipReach);
      }
      meshes.forEach((mesh,i)=>this.placeSegment(mesh,points[i],points[i+1]));
      if (this.joints) for (let joint=0;joint<2;joint++) {
        this.jointMatrix.makeTranslation(points[joint+1].x,points[joint+1].y,points[joint+1].z);
        this.joints.setMatrixAt(index*2+joint,this.jointMatrix);
      }
    }
    if (this.joints) this.joints.instanceMatrix.needsUpdate = true;
    const smoke = this.smoke.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i=0;i<32;i++) {const t=i/31; smoke.setXYZ(i,0.518+Math.sin(now/1200+t*7)*t*0.07,-0.078+t*0.82,0.453+Math.sin(now/900+t*5)*t*0.06);}
    smoke.needsUpdate=true;
    for(const record of this.cards.values()) {
      const p=Math.min(1,(now-record.started)/450), ease=1-(1-p)**3;
      record.mesh.position.lerpVectors(record.from,record.target,ease); record.mesh.position.y+=Math.sin(p*Math.PI)*0.12;
      record.mesh.rotation.y = record.angle+Math.sin(p*Math.PI)*0.08;
      record.mesh.rotation.z = Math.sin(p*Math.PI)*0.035;
    }
    this.winLight.intensity = celebration*2.8;
    this.confetti.visible = celebration > 0;
    if (celebration > 0) {
      const elapsed = (now-this.celebrationStarted)/1000;
      const dummy = new THREE.Object3D();
      for (let i=0;i<this.confetti.count;i++) {
        const t = Math.max(0,elapsed-(i%6)*0.045);
        const angle = i*2.39996;
        dummy.position.set(1.62+Math.cos(angle)*(0.22+t*0.33),Math.max(0.08,0.8+t*(1.8+(i%4)*0.15)-t*t*1.65),0.5+Math.sin(angle)*(0.25+t*0.28));
        dummy.rotation.set(t*3+i,t*4,t*2);
        dummy.scale.setScalar(Math.min(1,celebration*4)); dummy.updateMatrix(); this.confetti.setMatrixAt(i,dummy.matrix);
      }
      this.confetti.instanceMatrix.needsUpdate = true;
    }
    this.renderer.render(this.scene,this.camera);
    this.canvas.dataset.drawCalls = String(this.renderer.info.render.calls);
  }
}

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Action } from "./activities/blackjack";
import { copyNeuralLevels, type NeuralDisplayFrame, type NeuralDisplayOptions } from "./neural/display";

interface Manifest {
  nodeCount: number; edgeCount: number; classes: string[];
  artifacts: Record<string, { url: string; bytes: number }>;
}

export class ConnectomeView {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 0.01, 20);
  private controls: OrbitControls;
  private network = new THREE.Group();
  private material: THREE.ShaderMaterial;
  private points: THREE.Points | null = null;
  private lines: THREE.LineSegments | null = null;
  private levels = new Float32Array(0);
  private incoming = new Float32Array(0);
  private weights = new Float32Array(0);
  private edges = new Uint32Array(0);
  private ids = new Uint32Array(0);
  private classes = new Uint8Array(0);
  private classNames: string[] = [];
  private phase = -1;
  private lastUpdate = 0;
  private lastMetric = 0;
  private activityAttribute: THREE.BufferAttribute | null = null;
  private firingAttribute: THREE.BufferAttribute | null = null;
  private edgeLevels: THREE.BufferAttribute | null = null;
  private edgeFiring: THREE.BufferAttribute | null = null;
  private lineMaterial: THREE.ShaderMaterial | null = null;
  private paused = false;
  private showConnections = true;
  private externalActivity = false;
  readonly ready: Promise<void>;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x090e11, 1);
    this.camera.position.set(0.03, 0.01, 1.72);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 0.6;
    this.controls.maxDistance = 3;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.24;
    this.material = new THREE.ShaderMaterial({
      uniforms: { activeColor: { value: new THREE.Color("#62f2c4") }, mode: { value: 0 }, pixelRatio: { value: this.renderer.getPixelRatio() } },
      vertexShader: `attribute float activity; attribute float firing; attribute vec3 classColor;
        varying vec3 vColor; varying float vActivity; varying float vFiring;
        uniform vec3 activeColor; uniform float mode; uniform float pixelRatio;
        void main() {
          vActivity = activity;
          vFiring = firing;
          vec3 stateColor = activity < 0. ? vec3(.23,.51,.90) : activeColor;
          vColor = mix(mix(vec3(0.31,0.39,0.44), stateColor, min(abs(activity)*1.7,1.0)), classColor, mode);
          vec4 mv = modelViewMatrix * vec4(position,1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = pixelRatio * (1.0 + abs(activity)*1.5 + firing*.6) * clamp(1.5 / -mv.z,0.6,2.0);
        }`,
      fragmentShader: `varying vec3 vColor; varying float vActivity; varying float vFiring;
        void main() {
          float r = length(gl_PointCoord - vec2(0.5));
          if (r > 0.5) discard;
          gl_FragColor = vec4(mix(vColor,vec3(1.,.88,.60),vFiring), min(1.,0.34 + abs(vActivity)*0.55 + vFiring*.5) * (1.0-smoothstep(0.2,0.5,r)));
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, blending: THREE.NormalBlending, toneMapped: false
    });
    this.scene.add(this.network);
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement!);
    this.resize();
    canvas.addEventListener("dblclick", event => this.pick(event));
    this.ready = this.load().catch(error => {
      document.getElementById("brainStatus")!.textContent = `Anatomy unavailable: ${error.message}`;
      canvas.dataset.error = String(error.message);
    });
  }

  private async load(): Promise<void> {
    const response = await fetch(`${import.meta.env.BASE_URL}connectome/manifest.json`);
    if (!response.ok) throw new Error(`Manifest HTTP ${response.status}`);
    const manifest = await response.json() as Manifest;
    const [positions, ids, classes, edges] = await Promise.all(["positions", "ids", "classes", "edges"].map(async name => {
      const artifact = manifest.artifacts[name];
      const result = await fetch(`${import.meta.env.BASE_URL}${artifact.url.replace(/^\//, "")}`);
      if (!result.ok) throw new Error(`${name} HTTP ${result.status}`);
      const buffer = await result.arrayBuffer();
      if (buffer.byteLength !== artifact.bytes) throw new Error(`Incomplete ${name}`);
      return buffer;
    }));
    const xyz = new Float32Array(positions);
    this.ids = new Uint32Array(ids);
    this.classes = new Uint8Array(classes);
    this.edges = new Uint32Array(edges);
    this.classNames = manifest.classes;
    this.levels = new Float32Array(manifest.nodeCount);
    this.incoming = new Float32Array(manifest.nodeCount);
    this.weights = new Float32Array(manifest.edgeCount);
    const sums = new Float32Array(manifest.nodeCount);
    for (let i = 0; i < this.weights.length; i++) {
      const weight = Math.log1p(this.edges[i*3+2]);
      this.weights[i] = weight;
      sums[this.edges[i*3+1]] += weight;
    }
    for (let i = 0; i < this.weights.length; i++) this.weights[i] /= sums[this.edges[i*3+1]] || 1;
    const palette = ["#7abac9", "#d7a779", "#b8c8a0", "#e7b1c7", "#bbabda", "#6cadc3", "#ced4a5", "#87bdae"];
    const colors = new Float32Array(manifest.nodeCount * 3);
    for (let i = 0; i < manifest.nodeCount; i++) {
      new THREE.Color(palette[this.classes[i] % palette.length]).toArray(colors, i*3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(xyz, 3));
    geometry.setAttribute("classColor", new THREE.BufferAttribute(colors, 3));
    this.activityAttribute = new THREE.BufferAttribute(this.levels, 1).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("activity", this.activityAttribute);
    this.firingAttribute = new THREE.BufferAttribute(new Float32Array(manifest.nodeCount), 1).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("firing", this.firingAttribute);
    this.points = new THREE.Points(geometry, this.material);
    this.network.add(this.points);
    const linePositions = new Float32Array(manifest.edgeCount * 6);
    const lineColors = new Float32Array(manifest.edgeCount * 6);
    const phases = new Float32Array(manifest.edgeCount * 2);
    for (let i = 0; i < manifest.edgeCount; i++) {
      const source = this.edges[i*3], target = this.edges[i*3+1];
      for (let axis = 0; axis < 3; axis++) {
        linePositions[i*6+axis] = xyz[source*3+axis];
        linePositions[i*6+axis+3] = xyz[target*3+axis];
        lineColors[i*6+axis] = colors[source*3+axis];
        lineColors[i*6+axis+3] = colors[source*3+axis];
      }
      phases[i*2] = (i % 71) / 71; phases[i*2+1] = phases[i*2] + 1;
    }
    const lines = new THREE.BufferGeometry();
    lines.setAttribute("position", new THREE.BufferAttribute(linePositions, 3));
    lines.setAttribute("signalColor", new THREE.BufferAttribute(lineColors, 3));
    lines.setAttribute("phase", new THREE.BufferAttribute(phases, 1));
    this.edgeLevels = new THREE.BufferAttribute(new Float32Array(phases.length), 1).setUsage(THREE.DynamicDrawUsage);
    this.edgeFiring = new THREE.BufferAttribute(new Float32Array(phases.length), 1).setUsage(THREE.DynamicDrawUsage);
    lines.setAttribute("activity", this.edgeLevels);
    lines.setAttribute("firing", this.edgeFiring);
    this.lineMaterial = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, neuralMode: { value: 0 } },
      vertexShader: `attribute float activity; attribute float firing; attribute float phase; attribute vec3 signalColor;
        varying float vActivity; varying float vFiring; varying float vPhase; varying vec3 vColor;
        void main() { vActivity=activity; vFiring=firing; vPhase=phase; vColor=signalColor;
          gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
      fragmentShader: `uniform float time; uniform float neuralMode; varying float vActivity; varying float vFiring; varying float vPhase; varying vec3 vColor;
        void main() {
          float packet = mix(pow(max(0.,1.-abs(fract(vPhase-time*.28)-.5)*2.),14.), 1., neuralMode);
          vec3 color = mix(vColor, vec3(1.,.88,.60), vFiring);
          float alpha = .008 + abs(vActivity) * (.04 + packet * .16) + vFiring * .28;
          gl_FragColor = vec4(color, alpha);
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.NormalBlending, toneMapped: false,
    });
    this.lines = new THREE.LineSegments(lines, this.lineMaterial);
    this.lines.renderOrder = -1;
    this.lines.visible = this.showConnections;
    this.network.add(this.lines);
    document.getElementById("neuronCount")!.textContent = manifest.nodeCount.toLocaleString();
    document.getElementById("edgeCount")!.textContent = `${manifest.edgeCount.toLocaleString()} displayed / 5,536,347 simulated`;
    document.getElementById("brainStatus")!.textContent = "Measured soma positions / awaiting LIF frame";
    this.canvas.dataset.nodes = String(manifest.nodeCount);
    this.canvas.dataset.ready = "true";
    this.canvas.dataset.mode = "neural-pending";
  }

  setPhase(phase: number, action: Action = "Hit"): void {
    if (this.externalActivity) return;
    this.phase = phase;
    this.material.uniforms.activeColor.value.set({ Hit: "#67f4be", Stand: "#7ab9ff", Double: "#ffd077", Split: "#ff8eba" }[action]);
  }
  setMode(mode: string): void { this.material.uniforms.mode.value = mode === "classes" ? 1 : 0; }
  setEdges(visible: boolean): void { this.showConnections = visible; if (this.lines) this.lines.visible = visible; }
  setPaused(paused: boolean): void { this.paused = paused; }
  setNeuralActivity(frame: NeuralDisplayFrame, options: NeuralDisplayOptions): void {
    if (!this.levels.length) return;
    const { energy, active } = copyNeuralLevels(this.levels, frame);
    this.externalActivity = true;
    this.activityAttribute!.needsUpdate = true;
    const firing = this.firingAttribute!.array as Float32Array;
    firing.fill(0);
    for (const index of frame.spikes) if (index < firing.length) firing[index] = 1;
    this.firingAttribute!.needsUpdate = true;
    if (this.edgeLevels && this.edgeFiring) {
      const levels = this.edgeLevels.array as Float32Array;
      const sparks = this.edgeFiring.array as Float32Array;
      for (let i = 0; i < this.edges.length / 3; i++) {
        const source = this.edges[i * 3];
        const strength = Math.abs(this.levels[source]);
        levels[i * 2] = strength; levels[i * 2 + 1] = strength;
        const lit = source < firing.length ? firing[source] : 0;
        sparks[i * 2] = lit; sparks[i * 2 + 1] = lit;
      }
      this.edgeLevels.needsUpdate = true; this.edgeFiring.needsUpdate = true;
    }
    if (this.lineMaterial) this.lineMaterial.uniforms.neuralMode.value = 1;
    this.material.uniforms.activeColor.value.set("#67f4be");
    document.getElementById("activeNeurons")!.textContent = active.toLocaleString();
    document.getElementById("meanActivity")!.textContent = energy.toFixed(3);
    document.getElementById("brainStatus")!.textContent = `${options.label} / model step ${frame.tick} / ${frame.simulatedMs.toFixed(1)} ms`;
    this.canvas.setAttribute("aria-label", "MaleCNS anatomy showing recorded LIF voltages and spikes from the action-generating neural model");
    Object.assign(this.canvas.dataset, { mode: "neural", neuralReady: "true", tick: String(frame.tick), spikes: String(frame.totalSpikes), silenced: String(frame.silenced) });
  }
  setIllustrativeMode(): void {
    this.externalActivity = false;
    this.canvas.dataset.mode = "event-projection";
    delete this.canvas.dataset.neuralReady;
    document.getElementById("brainStatus")!.textContent = "Odds baseline / illustrative event projection";
    if (this.firingAttribute) { (this.firingAttribute.array as Float32Array).fill(0); this.firingAttribute.needsUpdate = true; }
    if (this.edgeFiring) { (this.edgeFiring.array as Float32Array).fill(0); this.edgeFiring.needsUpdate = true; }
    if (this.lineMaterial) this.lineMaterial.uniforms.neuralMode.value = 0;
  }
  setNeuralPending(message = "Loading the neural controller"): void {
    this.externalActivity = true;
    this.levels.fill(0);
    if (this.activityAttribute) this.activityAttribute.needsUpdate = true;
    if (this.firingAttribute) { (this.firingAttribute.array as Float32Array).fill(0); this.firingAttribute.needsUpdate = true; }
    if (this.edgeLevels) { (this.edgeLevels.array as Float32Array).fill(0); this.edgeLevels.needsUpdate = true; }
    if (this.edgeFiring) { (this.edgeFiring.array as Float32Array).fill(0); this.edgeFiring.needsUpdate = true; }
    if (this.lineMaterial) this.lineMaterial.uniforms.neuralMode.value = 1;
    this.canvas.dataset.mode = "neural-pending";
    delete this.canvas.dataset.neuralReady;
    delete this.canvas.dataset.tick;
    delete this.canvas.dataset.spikes;
    delete this.canvas.dataset.silenced;
    document.getElementById("activeNeurons")!.textContent = "--";
    document.getElementById("meanActivity")!.textContent = "--";
    document.getElementById("brainStatus")!.textContent = message;
  }
  reset(): void { this.controls.reset(); this.camera.position.set(0.03, 0.01, 1.72); this.controls.target.set(0,0,0); }

  private resize(): void {
    const width = this.canvas.clientWidth, height = this.canvas.clientHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  render(now: number): void {
    if (!this.externalActivity && !this.paused && this.levels.length && now - this.lastUpdate > 32) {
      this.lastUpdate = now;
      this.incoming.fill(0);
      for (let i = 0; i < this.weights.length; i++) this.incoming[this.edges[i*3+1]] += this.levels[this.edges[i*3]] * this.weights[i];
      const driven = this.classNames.map(name => this.phase === 0 ? /ol_intrinsic|visual/.test(name) : this.phase === 1 ? name === "cb_intrinsic"
        : this.phase === 2 ? /descending|ascending/.test(name) : this.phase === 3 ? /motor|vnc/.test(name) : false);
      let sum = 0, active = 0;
      for (let i = 0; i < this.levels.length; i++) {
        const code = ((Math.imul(this.ids[i], 2654435761) >>> 0) % 1000) / 1000;
        const drive = driven[this.classes[i]] ? 0.34 + code*0.45 : 0;
        const target = Math.min(1, drive + this.incoming[i]*0.68);
        this.levels[i] += (target - this.levels[i]) * 0.14;
        sum += this.levels[i];
        if (this.levels[i] > 0.15) active++;
      }
      this.activityAttribute!.needsUpdate = true;
      if (this.edgeLevels) {
        const edges = this.edgeLevels.array as Float32Array;
        for (let i = 0; i < this.edges.length / 3; i++) {
          const strength = this.levels[this.edges[i * 3]];
          edges[i * 2] = strength; edges[i * 2 + 1] = strength;
        }
        this.edgeLevels.needsUpdate = true;
      }
      if (now - this.lastMetric > 160) {
        this.lastMetric = now;
        document.getElementById("activeNeurons")!.textContent = active.toLocaleString();
        document.getElementById("meanActivity")!.textContent = (sum / this.levels.length).toFixed(3);
      }
    }
    if (this.lineMaterial) this.lineMaterial.uniforms.time.value = this.paused ? this.lineMaterial.uniforms.time.value : now * 0.001;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  private pick(event: MouseEvent): void {
    if (!this.points) return;
    const rect = this.canvas.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.params.Points.threshold = 0.004;
    ray.setFromCamera(new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1, -(event.clientY-rect.top)/rect.height*2+1), this.camera);
    const hit = ray.intersectObject(this.points)[0];
    if (hit?.index !== undefined) {
      const i = hit.index;
      const measurement = this.externalActivity ? "normalized modeled voltage" : "illustrative activity";
      document.getElementById("selectedNeuron")!.textContent = `Body ${this.ids[i]} / ${this.classNames[this.classes[i]].replaceAll("_", " ")} / ${measurement} ${this.levels[i].toFixed(3)}`;
    }
  }
}

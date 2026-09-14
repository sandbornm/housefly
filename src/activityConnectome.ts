import * as THREE from "three";
import { ACTIVITY_CHANNELS, ConnectomeActivity, activityChannels, type ActivitySignal } from "./connectomeActivity";
import { copyNeuralLevels, type NeuralDisplayFrame, type NeuralDisplayOptions } from "./neural/display";
import "./activityConnectome.css";
export type { ActivitySignal } from "./connectomeActivity";

interface Anatomy {
  positions: Float32Array;
  classes: Uint8Array;
  edges: Uint32Array;
  names: string[];
}
interface Manifest {
  nodeCount: number;
  edgeCount: number;
  classes: string[];
  artifacts: Record<string, { url: string; bytes: number }>;
}
let anatomy: Promise<Anatomy> | undefined;
async function loadAnatomy(): Promise<Anatomy> {
  const response = await fetch(`${import.meta.env.BASE_URL}connectome/manifest.json`);
  if (!response.ok) throw new Error("Anatomy manifest unavailable");
  const manifest = await response.json() as Manifest;
  const arrays = await Promise.all(["positions", "classes", "edges"].map(async key => {
    const artifact = manifest.artifacts[key];
    const response = await fetch(`${import.meta.env.BASE_URL}${artifact.url.replace(/^\//, "")}`);
    if (!response.ok) throw new Error(`Anatomy ${key} unavailable`);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength !== artifact.bytes) throw new Error(`Incomplete anatomy ${key}`);
    return buffer;
  }));
  const positions = new Float32Array(arrays[0]), classes = new Uint8Array(arrays[1]), edges = new Uint32Array(arrays[2]);
  if (positions.length !== manifest.nodeCount * 3 || classes.length !== manifest.nodeCount || edges.length !== manifest.edgeCount * 3) {
    throw new Error("Anatomy dimensions do not match manifest");
  }
  return { positions, classes, edges, names: manifest.classes };
}

const COLORS = ["#68dce8", "#f3aecc", "#97f2b0", "#f2cd7c"];
const empty: ActivitySignal = { sensory: 0, integration: 0, motor: 0, reward: 0, label: "Awaiting activity" };

export class ActivityConnectome {
  readonly element: HTMLElement;
  readonly ready: Promise<void>;
  private viewport: HTMLElement;
  private action: HTMLElement;
  private detail: HTMLElement;
  private bars: HTMLElement[] = [];
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(36, 1, .01, 20);
  private network = new THREE.Group();
  private miniature = new THREE.Group();
  private model?: ConnectomeActivity;
  private edges: Uint32Array = new Uint32Array(0);
  private activity?: THREE.BufferAttribute;
  private firing?: THREE.BufferAttribute;
  private edgeLevels?: THREE.BufferAttribute;
  private materials: THREE.ShaderMaterial[] = [];
  private geometry?: THREE.BufferGeometry;
  private lineGeometry?: THREE.BufferGeometry;
  private signal = empty;
  private mode: "event-projection" | "neural-pending" | "neural" = "event-projection";
  private neuralTick = 0;
  private neuralMilliseconds = 0;
  private neuralSpikes = 0;
  private silenced = false;
  private lastStep = 0;
  private lastText = 0;
  private clock = 0;
  private disposed = false;
  private previousViewport = new THREE.Vector4();
  private previousScissor = new THREE.Vector4();
  private previousColor = new THREE.Color();
  private reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  constructor(private renderer: THREE.WebGLRenderer, options: { mount?: HTMLElement; className?: string; title?: string; neural?: boolean } = {}) {
    this.element = document.createElement("aside");
    this.element.className = `activity-connectome ${options.className ?? ""}`;
    const neural = Boolean(options.neural);
    if (neural) this.mode = "neural-pending";
    this.element.setAttribute("aria-label", neural
      ? "Simulated connectome waiting for the neural controller"
      : "Connectome event activity, illustrative not biological simulation");
    if (neural) this.element.dataset.mode = "neural-pending";
    const header = document.createElement("div"); header.className = "connectome-heading";
    const title = document.createElement("strong"); title.textContent = options.title ?? "CONNECTOME";
    const tag = document.createElement("span"); tag.textContent = neural ? "AWAITING LIF" : "EVENT PROJECTION";
    header.append(title, tag);
    this.viewport = document.createElement("div"); this.viewport.className = "connectome-viewport";
    const loading = document.createElement("span"); loading.className = "connectome-loading"; loading.textContent = "Loading anatomy"; this.viewport.append(loading);
    const readout = document.createElement("div"); readout.className = "connectome-readout";
    this.action = document.createElement("strong"); this.action.className = "connectome-action";
    this.detail = document.createElement("span"); this.detail.className = "connectome-detail";
    const channels = document.createElement("div"); channels.className = "connectome-channels";
    for (const [index, name] of (neural ? ["Visual", "Central", "Motor", "Other"] : ["Input", "Process", "Motor", "Outcome"]).entries()) {
      const column = document.createElement("div"); column.className = "connectome-channel"; column.textContent = name;
      const track = document.createElement("span"); track.className = "connectome-track";
      const bar = document.createElement("span"); bar.className = "connectome-level"; bar.style.setProperty("--signal-color", COLORS[index]);
      track.append(bar); column.append(track); channels.append(column); this.bars.push(bar);
    }
    const provenance = document.createElement("span"); provenance.className = "connectome-provenance";
    provenance.textContent = neural ? "Waiting for measured voltages and spikes" : "MaleCNS v1.0 / illustrative activity";
    provenance.title = neural
      ? "The overlay stays dark until the task controller supplies a real LIF frame. No event-projected or invented excitation."
      : "Measured neuron positions and 60,000 anatomical edges. Synthetic event-driven diffusion, not measured neural excitation or the controller of this activity.";
    readout.append(this.action, this.detail, channels, provenance);
    this.element.append(header, this.viewport, readout);
    (options.mount ?? renderer.domElement.parentElement!).append(this.element);
    this.camera.position.set(.03, .01, 1.9);
    this.camera.lookAt(0, 0, 0);
    this.scene.add(this.network);
    this.ready = (anatomy ??= loadAnatomy().catch(error => { anatomy = undefined; throw error; }))
      .then(data => { if (!this.disposed) this.build(data); })
      .catch(() => { if (!this.disposed) { loading.textContent = "Anatomy unavailable"; this.element.dataset.error = "true"; } });
  }

  private build(data: Anatomy): void {
    this.model = new ConnectomeActivity(data.classes, data.names, data.edges);
    this.edges = data.edges;
    const colors = new Float32Array(data.classes.length * 3);
    const palette = COLORS.map(value => new THREE.Color(value));
    for (let i = 0; i < data.classes.length; i++) palette[this.model.channels[i]].toArray(colors, i * 3);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
    this.geometry.setAttribute("signalColor", new THREE.BufferAttribute(colors, 3));
    this.activity = new THREE.BufferAttribute(this.model.levels, 1).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("activity", this.activity);
    this.firing = new THREE.BufferAttribute(new Float32Array(data.classes.length), 1).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("firing", this.firing);
    const points = new THREE.ShaderMaterial({
      uniforms: { pointSize: { value: this.renderer.getPixelRatio() * .95 } },
      vertexShader: `attribute float activity; attribute float firing; attribute vec3 signalColor; uniform float pointSize;
        varying float vActivity; varying float vFiring; varying vec3 vColor;
        void main() { vActivity = activity; vColor = signalColor; vFiring = firing;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.);
          gl_PointSize = pointSize * (1. + abs(activity) * .8 + firing * .6); }`,
      fragmentShader: `varying float vActivity; varying float vFiring; varying vec3 vColor;
        void main() { float r = length(gl_PointCoord - .5); if(r>.5) discard;
          vec3 stateColor = vActivity < 0. ? vec3(.23,.51,.90) : vColor;
          vec3 color = mix(vec3(.09,.16,.19), stateColor, min(1.,abs(vActivity)*4.));
          color = mix(color, vec3(1.,.88,.60), vFiring);
          gl_FragColor = vec4(color, min(1.,.32 + abs(vActivity) * .65 + vFiring * .6) * (1.-smoothstep(.18,.5,r)));
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.NormalBlending, toneMapped: false,
    });
    this.materials.push(points);
    this.network.add(new THREE.Points(this.geometry, points));
    const miniatureMaterial = points.clone(); miniatureMaterial.uniforms.pointSize.value *= .67;
    this.materials.push(miniatureMaterial);
    // The compact view keeps actual positions, sampling uniformly by stable array index.
    const miniGeometry = this.geometry.clone();
    const indices = Uint32Array.from({ length: Math.ceil(data.classes.length / 6) }, (_, i) => i * 6);
    miniGeometry.setIndex(new THREE.BufferAttribute(indices, 1));
    miniGeometry.setAttribute("activity", this.activity);
    miniGeometry.setAttribute("firing", this.firing);
    const miniPoints = new THREE.Points(miniGeometry, miniatureMaterial); miniPoints.renderOrder = 10;
    this.miniature.add(miniPoints);
    const positions = new Float32Array(data.edges.length * 2), phases = new Float32Array(data.edges.length / 3 * 2);
    const lineColors = new Float32Array(positions.length);
    for (let i = 0; i < data.edges.length / 3; i++) {
      const source = data.edges[i * 3], target = data.edges[i * 3 + 1];
      for (let axis = 0; axis < 3; axis++) {
        positions[i * 6 + axis] = data.positions[source * 3 + axis];
        positions[i * 6 + axis + 3] = data.positions[target * 3 + axis];
        lineColors[i * 6 + axis] = colors[source * 3 + axis];
        lineColors[i * 6 + axis + 3] = colors[target * 3 + axis];
      }
      phases[i * 2] = (i % 71) / 71; phases[i * 2 + 1] = phases[i * 2] + 1;
    }
    this.lineGeometry = new THREE.BufferGeometry();
    this.lineGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.lineGeometry.setAttribute("signalColor", new THREE.BufferAttribute(lineColors, 3));
    this.lineGeometry.setAttribute("phase", new THREE.BufferAttribute(phases, 1));
    this.edgeLevels = new THREE.BufferAttribute(new Float32Array(phases.length), 1).setUsage(THREE.DynamicDrawUsage);
    this.lineGeometry.setAttribute("activity", this.edgeLevels);
    const lines = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, neuralMode: { value: 0 } },
      vertexShader: `attribute float activity; attribute float phase; attribute vec3 signalColor;
        varying float vActivity; varying float vPhase; varying vec3 vColor;
        void main() { vActivity=activity; vPhase=phase; vColor=signalColor; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
      fragmentShader: `uniform float time; uniform float neuralMode; varying float vActivity; varying float vPhase; varying vec3 vColor;
        void main() { float packet=mix(pow(max(0.,1.-abs(fract(vPhase-time*.35)-.5)*2.),16.),1.,neuralMode);
          gl_FragColor=vec4(vColor, .0002 + vActivity * (.001 + packet*.015));
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.NormalBlending, toneMapped: false,
    });
    this.materials.push(lines);
    const connections = new THREE.LineSegments(this.lineGeometry, lines);
    connections.renderOrder = -1;
    this.network.add(connections);
    this.element.dataset.ready = "true";
    this.element.dataset.nodes = String(data.classes.length);
    this.element.dataset.edges = String(data.edges.length / 3);
    this.viewport.setAttribute("aria-label", `${data.classes.length.toLocaleString()} measured neuron positions, illustrative event activity`);
  }

  createMiniature(): THREE.Group { return this.miniature; }

  update(now: number, signal: ActivitySignal): void {
    if (this.disposed) return;
    if (this.mode !== "event-projection") throw new Error("Event projection cannot replace simulated neural activity");
    this.signal = signal;
    if (!this.lastStep) this.lastStep = now;
    if (now - this.lastStep >= 50) {
      const seconds = Math.min(.1, (now - this.lastStep) / 1000);
      this.lastStep = now;
      if (!signal.paused) this.clock += seconds;
      this.model?.step(signal, seconds);
      if (this.model && this.activity && this.edgeLevels && !signal.paused) {
        this.activity.needsUpdate = true;
        for (let i = 0; i < this.edges.length / 3; i++) {
          const strength = this.model.levels[this.edges[i * 3]];
          this.edgeLevels.setX(i * 2, strength); this.edgeLevels.setX(i * 2 + 1, strength);
        }
        this.edgeLevels.needsUpdate = true;
      }
    }
    this.network.rotation.y = this.reducedMotion ? -.08 : Math.sin(this.clock * .12) * .18;
    for (const material of this.materials) if (material.uniforms.time) material.uniforms.time.value = this.reducedMotion ? 0 : this.clock;
    if (now - this.lastText >= 100) {
      this.lastText = now;
      if (this.action.textContent !== signal.label) this.action.textContent = signal.label;
      const detail = signal.detail ?? "";
      if (this.detail.textContent !== detail) this.detail.textContent = detail;
      const channels = activityChannels(signal);
      channels.forEach((value, index) => { this.bars[index].style.transform = `scaleX(${value.toFixed(3)})`; });
      this.element.dataset.energy = (this.model?.energy ?? 0).toFixed(4);
      this.element.dataset.active = String(this.model?.active ?? 0);
      this.element.dataset.paused = String(Boolean(signal.paused));
    }
  }

  updateNeural(frame: NeuralDisplayFrame, options: NeuralDisplayOptions): void {
    if (this.disposed || !this.model || !this.activity || !this.edgeLevels || !this.firing) return;
    const metrics = copyNeuralLevels(this.model.levels, frame);
    if (this.mode !== "neural") {
      this.mode = "neural";
      this.element.setAttribute("aria-label", "Simulated connectome state used by the neural controller");
      this.element.querySelector(".connectome-heading span")!.textContent = "SIMULATED LIF";
      const provenance = this.element.querySelector<HTMLElement>(".connectome-provenance")!;
      provenance.textContent = "Modeled voltage / recorded spikes";
      provenance.title = "Normalized model voltage: blue below resting potential; gold marks spike events in this model step. Anatomical MaleCNS wiring, assumed dynamics, engineered task interfaces. Not measured brain activity or validated fly cognition.";
      const names = ["Visual", "Central", "Motor", "Other"];
      this.element.querySelectorAll(".connectome-channel").forEach((column, index) => { column.firstChild!.textContent = names[index]; });
      this.viewport.setAttribute("aria-label", "Measured soma positions displaying the controller's simulated state");
    }
    this.neuralTick = frame.tick; this.neuralMilliseconds = frame.simulatedMs;
    this.neuralSpikes = frame.totalSpikes; this.silenced = frame.silenced;
    this.model.energy = metrics.energy; this.model.active = metrics.active;
    const sums = [0, 0, 0, 0], sizes = [0, 0, 0, 0];
    for (let index = 0; index < this.model.levels.length; index++) {
      const channel = this.model.channels[index];
      sums[channel] += Math.abs(this.model.levels[index]); sizes[channel]++;
    }
    const channels = sums.map((sum, index) => sizes[index] ? sum / sizes[index] : 0);
    this.signal = { sensory: channels[0], integration: channels[1], motor: channels[2], reward: channels[3], ...options };
    this.activity.needsUpdate = true;
    const firing = this.firing.array as Float32Array;
    firing.fill(0);
    for (const index of frame.spikes) if (index < firing.length) firing[index] = 1;
    this.firing.needsUpdate = true;
    for (let index = 0; index < this.edges.length / 3; index++) {
      const strength = Math.abs(this.model.levels[this.edges[index * 3]]);
      this.edgeLevels.setX(index * 2, strength); this.edgeLevels.setX(index * 2 + 1, strength);
    }
    this.edgeLevels.needsUpdate = true;
    for (const material of this.materials) if (material.uniforms.neuralMode) material.uniforms.neuralMode.value = 1;
    this.action.textContent = options.label;
    this.detail.textContent = options.detail ?? `Step ${frame.tick} / ${frame.simulatedMs.toFixed(1)} ms`;
    channels.forEach((value, index) => { this.bars[index].style.transform = `scaleX(${value})`; });
    Object.assign(this.element.dataset, {
      mode: "neural", neuralReady: "true", tick: String(frame.tick), simulatedMs: String(frame.simulatedMs),
      spikes: String(frame.totalSpikes), energy: metrics.energy.toFixed(6), active: String(metrics.active),
      paused: String(Boolean(options.paused)), silenced: String(frame.silenced),
    });
    if (options.edgeCount !== undefined) this.element.dataset.simulatedEdges = String(options.edgeCount);
    if (options.modelId !== undefined) this.element.dataset.modelId = options.modelId;
  }

  render(): void {
    if (this.disposed || !this.model || this.element.hidden) return;
    const rect = this.viewport.getBoundingClientRect(), canvas = this.renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height || rect.bottom < canvas.top || rect.top > canvas.bottom) return;
    const renderer = this.renderer, autoClear = renderer.autoClear, scissorTest = renderer.getScissorTest();
    renderer.getViewport(this.previousViewport); renderer.getScissor(this.previousScissor); renderer.getClearColor(this.previousColor);
    const alpha = renderer.getClearAlpha();
    renderer.autoClear = false;
    renderer.setScissorTest(true);
    renderer.setViewport(rect.left - canvas.left, canvas.bottom - rect.bottom, rect.width, rect.height);
    renderer.setScissor(rect.left - canvas.left, canvas.bottom - rect.bottom, rect.width, rect.height);
    renderer.setClearColor(0x0b1418, 1); renderer.clear(true, true, false);
    this.camera.aspect = rect.width / rect.height; this.camera.updateProjectionMatrix();
    renderer.render(this.scene, this.camera);
    renderer.setClearColor(this.previousColor, alpha);
    renderer.setViewport(this.previousViewport); renderer.setScissor(this.previousScissor); renderer.setScissorTest(scissorTest); renderer.autoClear = autoClear;
  }

  snapshot() {
    return { ready: Boolean(this.model), nodes: this.model?.levels.length ?? 0, edges: this.edges.length / 3,
      energy: this.model?.energy ?? 0, active: this.model?.active ?? 0, label: this.signal.label,
      channels: Object.fromEntries(ACTIVITY_CHANNELS.map((key, i) => [key, activityChannels(this.signal)[i]])), paused: Boolean(this.signal.paused),
      mode: this.mode, tick: this.neuralTick, simulatedMs: this.neuralMilliseconds, spikes: this.neuralSpikes, silenced: this.silenced };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.element.remove(); this.miniature.removeFromParent();
    this.miniature.traverse(object => { if (object instanceof THREE.Points) object.geometry.dispose(); });
    this.geometry?.dispose(); this.lineGeometry?.dispose(); this.materials.forEach(material => material.dispose());
  }
}

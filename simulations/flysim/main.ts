import * as THREE from 'three';
import { createIcons, ArrowLeft, Bug, Camera, FlaskConical, Gauge, MoveVertical, Orbit, Pause, Play, RotateCcw, Route, ScanSearch } from 'lucide';
import { ActivityConnectome } from '../../src/activityConnectome';
import { AsyncNeuralRuntime } from '../../src/neural/client.ts';
import { loadDrosophilaTemplate } from '../../src/flyModel.ts';
import { FLYSIM_ENCODER, type FlysimInput, type FlysimObservation, type Vec3 } from './types.ts';
import { GardenWorld } from './world.ts';
import { NeuralPilot } from './pilot.ts';
import { CONTROL_INTERVAL, NEURAL_WINDOW_MS, autopilotDrive, unpowered, type NeuralMotorDecision } from './neural.ts';
import './style.css';

type CameraMode = 'chase' | 'orbit';
type MotorSource = 'manual' | 'neural' | 'none';
interface Snapshot {
  ready: boolean;
  position: Vec3;
  velocity: Vec3;
  heading: number;
  altitude: number;
  grounded: boolean;
  hit: boolean;
  threats: number;
  autopilot: boolean;
  paused: boolean;
  camera: CameraMode;
  elapsed: number;
  frames: number;
  drawCalls: number;
  triangles: number;
  input: FlysimInput;
  neural: ReturnType<NeuralPilot['snapshot']> | null;
  motorSource: MotorSource;
  appliedFrameTick: number | null;
  appliedFeatureHash: number;
  appliedInput: FlysimInput | null;
  modelError: string;
  connectome: ReturnType<ActivityConnectome['snapshot']>;
}
declare global { interface Window { __flysim?: { snapshot: () => Snapshot; silence: (value: boolean) => void }; } }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const HOLD: FlysimInput = { forward: 0, yaw: 0, lift: 0, dash: false };
const FIXED_DT = 1 / 60;
const icons = { ArrowLeft, Bug, Camera, FlaskConical, Gauge, MoveVertical, Orbit, Pause, Play, RotateCcw, Route, ScanSearch };
const refreshIcons = () => createIcons({ icons, attrs: { 'aria-hidden': 'true' } });
const setIcon = (element: HTMLElement, icon: string) => {
  const placeholder = document.createElement('i');
  placeholder.setAttribute('data-lucide', icon);
  element.replaceChildren(placeholder);
  refreshIcons();
};
refreshIcons();
$<HTMLAnchorElement>('all-demos').href = import.meta.env.BASE_URL;
$('retry').addEventListener('click', () => location.reload());

function showError(message: string): void {
  $('loading').hidden = false;
  $('loading-message').textContent = message;
  $('retry').hidden = false;
  $('scene').dataset.ready = 'error';
}

function copyInput(input: FlysimInput): FlysimInput {
  return { forward: input.forward, yaw: input.yaw, lift: input.lift, dash: Boolean(input.dash) };
}

let disposeScene: (() => void) | undefined;
async function start(): Promise<void> {
  await loadDrosophilaTemplate();
  const canvas = $<HTMLCanvasElement>('scene');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.65));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.92;
  renderer.info.autoReset = false;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(58, 1, 0.05, 120);
  const world = new GardenWorld(scene);
  const connectome = new ActivityConnectome(renderer, { mount: $('app'), className: 'flysim-connectome', title: 'ESCAPE CONNECTOME', neural: true });
  connectome.element.hidden = true;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let observation: FlysimObservation = world.observation();
  let pilot: NeuralPilot | undefined, modelError = '', modelLoading = false, requestedSilence = false;
  let controlElapsed = CONTROL_INTERVAL;
  let motorSource: MotorSource = 'none', appliedFrameTick: number | null = null, appliedFeatureHash = 0, appliedInput: FlysimInput | null = HOLD;
  const events = new AbortController();
  const signal = events.signal;
  let mode: CameraMode = 'chase', autopilot = true, paused = false, hidden = document.hidden;
  let elapsed = 0, accumulator = 0, frame = 0, last = performance.now(), frames = 0, lastHud = -1;
  let disposed = false, orbitAngle = 0.4, noticeTimer = 0, cameraSnap = true;

  async function loadPilot(): Promise<void> {
    if (modelLoading || pilot) return;
    modelLoading = true; modelError = ''; $<HTMLButtonElement>('calibrate').disabled = true;
    let client: AsyncNeuralRuntime | undefined;
    try {
      client = await AsyncNeuralRuntime.create(8731);
      await connectome.ready;
      if (connectome.element.dataset.ready !== 'true') throw new Error('Measured anatomy is unavailable');
      if (!disposed) {
        pilot = new NeuralPilot(client, { modelId: client.graph.modelId, edgeCount: client.graph.edgeCount });
        await pilot.silence(requestedSilence);
        if (!disposed && !requestedSilence) {
          try {
            const response = await fetch(new URL('./calibration.json', import.meta.url));
            if (!response.ok) throw new Error(`Flysim calibration HTTP ${response.status}`);
            const artifact = await response.json() as { schema: number; encoder: string; modelId: string; nodeCount: number; edgeCount: number; neuralWindowMs?: number; weights: unknown };
            if (artifact.schema !== 1 || artifact.encoder !== FLYSIM_ENCODER
              || artifact.modelId !== client.graph.modelId || artifact.nodeCount !== client.graph.nodeCount
              || artifact.edgeCount !== client.graph.edgeCount || artifact.neuralWindowMs !== NEURAL_WINDOW_MS
              || !pilot.loadWeights(artifact.weights)) {
              throw new Error('Flysim calibration metadata is incompatible.');
            }
          } catch { if (!disposed && !requestedSilence) await pilot.beginCalibration(); }
        }
      } else void client.dispose().catch(() => {});
    } catch (error) {
      if (client && !pilot) void client.dispose().catch(() => {});
      modelError = error instanceof Error ? error.message : String(error);
    } finally {
      if (!disposed) { modelLoading = false; $<HTMLButtonElement>('calibrate').disabled = false; lastHud = -1; }
    }
  }

  function silence(value: boolean): void {
    requestedSilence = value; void pilot?.silence(value); $<HTMLInputElement>('neural-silenced').checked = value;
    if (autopilot) { motorSource = 'none'; appliedInput = null; appliedFrameTick = pilot?.frame?.tick ?? null; appliedFeatureHash = pilot?.command.featureHash ?? 0; }
    controlElapsed = CONTROL_INTERVAL; lastHud = -1;
  }

  const keyboard = new Set<string>();
  const moveKeys = new Set(['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight']);
  const controls = (): FlysimInput => ({
    forward: THREE.MathUtils.clamp(Number(keyboard.has('KeyW') || keyboard.has('ArrowUp')) - Number(keyboard.has('KeyS') || keyboard.has('ArrowDown')), -1, 1),
    yaw: THREE.MathUtils.clamp(Number(keyboard.has('KeyA') || keyboard.has('ArrowLeft')) - Number(keyboard.has('KeyD') || keyboard.has('ArrowRight')), -1, 1),
    lift: THREE.MathUtils.clamp(Number(keyboard.has('KeyQ')) - Number(keyboard.has('KeyE')), -1, 1),
    dash: keyboard.has('ShiftLeft') || keyboard.has('ShiftRight'),
  });
  const clearInput = () => keyboard.clear();
  const notify = (message: string) => {
    clearTimeout(noticeTimer); $('notice').textContent = message; $('notice').hidden = false;
    noticeTimer = window.setTimeout(() => { $('notice').hidden = true; }, 2600);
  };

  function setAutopilot(value: boolean): void {
    if (value === autopilot) return;
    autopilot = value; controlElapsed = CONTROL_INTERVAL;
    $('autopilot').setAttribute('aria-pressed', String(autopilot)); $('mode-label').textContent = autopilot ? 'Neural' : 'Manual';
    if (autopilot) clearInput();
    lastHud = -1;
  }
  function setCamera(value: CameraMode): void {
    mode = value; cameraSnap = true; orbitAngle = 0.65;
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-camera]')) {
      const selected = button.dataset.camera === mode;
      button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected));
    }
    camera.fov = innerWidth < 650 ? 66 : 58; camera.updateProjectionMatrix();
  }
  function togglePause(): void {
    paused = !paused; accumulator = 0; clearInput();
    $('pause').setAttribute('aria-pressed', String(paused));
    $('pause').setAttribute('aria-label', paused ? 'Resume escape' : 'Pause escape');
    $('pause').dataset.tip = paused ? 'Resume escape (P)' : 'Pause escape (P)';
    setIcon($('pause'), paused ? 'play' : 'pause'); lastHud = -1;
  }
  function reset(): void {
    world.reset(); observation = world.observation(); elapsed = 0; accumulator = 0; cameraSnap = true; clearInput();
    void pilot?.resetState(); controlElapsed = CONTROL_INTERVAL; appliedInput = HOLD; appliedFrameTick = null; appliedFeatureHash = 0; motorSource = 'none';
    if (paused) togglePause();
    notify('Garden reset');
  }

  $('autopilot').addEventListener('click', () => setAutopilot(!autopilot), { signal });
  $('calibrate').addEventListener('click', () => {
    if (!pilot) { void loadPilot(); return; }
    void pilot.beginCalibration(); controlElapsed = CONTROL_INTERVAL; lastHud = -1;
  }, { signal });
  $('neural-silenced').addEventListener('change', event => silence((event.target as HTMLInputElement).checked), { signal });
  $('pause').addEventListener('click', togglePause, { signal });
  $('reset').addEventListener('click', reset, { signal });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-camera]')) {
    button.addEventListener('click', () => setCamera(button.dataset.camera as CameraMode), { signal });
  }
  window.addEventListener('keydown', event => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if ((event.target as Element)?.closest('input, textarea, select, [contenteditable=true]')) return;
    if (moveKeys.has(event.code)) { event.preventDefault(); keyboard.add(event.code); setAutopilot(false); }
    else if (!event.repeat) {
      if (event.code === 'KeyG') setAutopilot(!autopilot);
      if (event.code === 'KeyV') setCamera(mode === 'chase' ? 'orbit' : 'chase');
      if (event.code === 'KeyP') togglePause();
      if (event.code === 'KeyR') reset();
    }
  }, { signal });
  window.addEventListener('keyup', event => keyboard.delete(event.code), { signal });
  window.addEventListener('blur', clearInput, { signal });
  document.addEventListener('visibilitychange', () => { hidden = document.hidden; clearInput(); accumulator = 0; last = performance.now(); }, { signal });
  canvas.addEventListener('pointerdown', () => canvas.focus({ preventScroll: true }), { signal });

  function driveInput(): FlysimInput | null {
    const command: NeuralMotorDecision = pilot?.command ?? unpowered();
    appliedFrameTick = command.frameTick;
    appliedFeatureHash = command.featureHash;
    if (!autopilot) { motorSource = 'manual'; return controls(); }
    if (modelError && !pilot) { motorSource = 'none'; return null; }
    const drive = autopilotDrive(pilot?.phase, Boolean(pilot?.silenced), command.powered);
    if (drive === 'fall') { motorSource = 'none'; return null; }
    if (drive === 'neural') { motorSource = 'neural'; return copyInput(command.input); }
    motorSource = 'none';
    return HOLD;
  }

  function fixedStep(): void {
    pilot?.commit();
    const input = driveInput();
    appliedInput = input ? copyInput(input) : null;
    controlElapsed += FIXED_DT;
    if (pilot && !pilot.busy && controlElapsed >= CONTROL_INTERVAL) {
      controlElapsed = 0;
      void pilot.infer(observation);
    }
    observation = world.update(FIXED_DT, input);
    elapsed += FIXED_DT;
    if (!Number.isFinite(observation.position.y)) throw new Error('Invalid physical state');
  }

  const aim = new THREE.Vector3(), desired = new THREE.Vector3(), offset = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  function updateCamera(dt: number): void {
    const target = world.cameraTarget();
    aim.set(target.x, target.y + 0.08, target.z);
    if (mode === 'orbit') {
      if (!paused && !hidden) orbitAngle += dt * (reducedMotion ? 0.05 : 0.16);
      offset.set(Math.sin(orbitAngle) * 3.1, reducedMotion ? 1.35 : 1.55, -Math.cos(orbitAngle) * 3.1);
    } else {
      const heading = observation.heading;
      offset.set(0.35, reducedMotion ? 0.48 : 0.62, 1.85).applyAxisAngle(up, heading);
      aim.add(new THREE.Vector3(0, 0.06, -0.35).applyAxisAngle(up, heading));
    }
    desired.set(target.x, target.y, target.z).add(offset);
    desired.y = Math.max(0.35, desired.y);
    if (cameraSnap || reducedMotion) camera.position.copy(desired);
    else camera.position.lerp(desired, 1 - Math.exp(-7 * dt));
    cameraSnap = false; camera.up.set(0, 1, 0); camera.lookAt(aim);
  }

  function updateHud(): void {
    const speed = Math.hypot(observation.velocity.x, observation.velocity.y, observation.velocity.z);
    $('altitude').textContent = Math.max(0, observation.altitude).toFixed(1);
    $('velocity').textContent = speed.toFixed(1);
    const nearest = observation.threats.reduce<FlysimObservation['threats'][number] | null>((best, threat) => !best || threat.range < best.range ? threat : best, null);
    $('threat-range').textContent = nearest ? nearest.range.toFixed(1) : '--';
    $('threat-kind').textContent = nearest ? nearest.kind : 'clear';
    $('flight-time').textContent = `${Math.floor(elapsed / 60).toString().padStart(2, '0')}:${Math.floor(elapsed % 60).toString().padStart(2, '0')}`;
    $('flight-status').textContent = paused ? 'ESCAPE PAUSED' : !autopilot ? 'MANUAL FLIGHT' : pilot?.silenced ? 'NEURONS SILENCED'
      : pilot?.phase === 'inference' ? 'NEURAL ESCAPE' : pilot?.phase === 'calibration' ? 'CALIBRATING' : modelError ? 'NEURAL DRIVE OFF' : 'NEURAL DRIVE OFF';
    $('status-dot').style.background = paused || motorSource === 'none' ? '#95a494' : autopilot ? '#8fba6a' : '#d4a574';
    $('neural-status').textContent = modelLoading ? 'Loading full neural model' : modelError ? 'Neural model unavailable' : pilot?.phase === 'failed' ? (pilot.failure || 'Neural model unavailable')
      : pilot?.phase === 'calibration' ? `Sensor rehearsal ${pilot.samples}/${pilot.calibrationTrials}` : pilot?.phase === 'inference' ? 'Experimental LIF / learned readout' : 'Uncalibrated / motor drive off';
    $('calibration-metric').textContent = pilot ? `${pilot.readout.updates} teacher updates / loss ${pilot.lastLoss.toFixed(3)}` : 'No substitute controller';
    $('neural-clock').textContent = pilot ? `${Math.round(pilot.latencyMs)} ms worker latency / ${observation.threats.length} threats` : '20 model ms per 100 world ms requested';
    $<HTMLButtonElement>('calibrate').disabled = modelLoading || pilot?.phase === 'calibration' || Boolean(pilot?.silenced) || pilot?.phase === 'failed';
    $('calibrate-label').textContent = modelError ? 'Retry model' : 'Calibrate';
  }

  function resize(): void {
    const width = canvas.clientWidth, height = canvas.clientHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(1, height);
    camera.fov = width < 650 ? 66 : 58;
    camera.updateProjectionMatrix(); cameraSnap = true;
  }
  const observer = new ResizeObserver(resize); observer.observe(canvas); resize();

  function animate(now: number): void {
    if (disposed) return;
    try {
      const dt = Math.min((now - last) / 1000, 0.1); last = now;
      const visualDt = paused || hidden ? 0 : dt;
      if (!paused && !hidden) {
        accumulator += dt;
        while (accumulator >= FIXED_DT) { fixedStep(); accumulator -= FIXED_DT; }
        void pilot?.calibrateStep();
      }
      updateCamera(visualDt);
      if (pilot?.frame) {
        connectome.element.hidden = false;
        connectome.updateNeural(pilot.frame, {
          label: paused ? 'Escape / paused' : pilot.phase === 'calibration' ? 'Calibration / sensor rehearsal' : !autopilot ? 'Manual / neural response'
            : pilot.silenced ? 'Escape / neurons silenced' : pilot.phase === 'uncalibrated' ? 'Escape / uncalibrated' : `Escape / ${pilot.command.action}`,
          detail: `${(pilot.frame.simulatedMs / 1000).toFixed(2)}s model / ${elapsed.toFixed(1)}s world`,
          paused: paused || hidden,
          edgeCount: pilot.model.edgeCount,
          modelId: pilot.model.modelId,
        });
      }
      renderer.info.reset(); renderer.render(scene, camera); connectome.render(); frames++;
      if (now - lastHud > 100) { lastHud = now; updateHud(); }
      frame = requestAnimationFrame(animate);
    } catch (error) {
      console.error('Fly Simulator rendering failed', error);
      dispose(); showError('Garden rendering stopped. Reload to try again.');
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true; cancelAnimationFrame(frame); clearTimeout(noticeTimer); clearInput(); events.abort(); observer.disconnect();
    connectome.dispose(); void pilot?.dispose(); world.dispose();
    renderer.dispose(); delete window.__flysim;
  }
  disposeScene = dispose;
  canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); dispose(); showError('The graphics context was interrupted. Reload to resume the garden.'); }, { signal });
  window.addEventListener('pagehide', dispose, { once: true, signal });
  window.__flysim = {
    silence,
    snapshot: () => ({
      ready: !disposed, position: { ...observation.position }, velocity: { ...observation.velocity }, heading: observation.heading,
      altitude: observation.altitude, grounded: observation.grounded, hit: observation.hit, threats: observation.threats.length,
      autopilot, paused, camera: mode, elapsed, frames, drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
      input: controls(), neural: pilot?.snapshot() ?? null, motorSource, appliedFrameTick, appliedFeatureHash, appliedInput: appliedInput ? copyInput(appliedInput) : null,
      modelError, connectome: connectome.snapshot(),
    }),
  };
  setCamera(mode); frame = requestAnimationFrame(animate); canvas.dataset.ready = 'true'; $('loading').hidden = true;
  void loadPilot();
}

void start().catch(error => {
  console.error('Fly Simulator initialization failed', error);
  disposeScene?.();
  showError('The garden could not load. Check WebGL support and reload.');
});
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
if (import.meta.hot) import.meta.hot.dispose(() => disposeScene?.());

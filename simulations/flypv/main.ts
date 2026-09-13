import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { createIcons, ArrowLeft, Camera, Drone, FlaskConical, Gauge, MoveVertical, Navigation, Orbit, Pause, Play, RotateCcw, Route, ScanEye, SlidersHorizontal, Sun, Volume2, VolumeX, X } from 'lucide';
import { createDrone } from './drone.ts';
import { FIXED_DT, manualVelocity, ROUTE, SPAWN, terrainHeight, wrapAngle, type FlightInput, type Point } from './flight.ts';
import { FlightPhysics, initPhysics } from './physics.ts';
import { createVillage } from './world.ts';
import { ActivityConnectome } from '../../src/activityConnectome';
import { AsyncNeuralRuntime } from '../../src/neural/client.ts';
import { NeuralPilot } from './pilot.ts';
import { CONTROL_INTERVAL, FlightGoals, unpowered } from './neural.ts';
import './style.css';

type CameraMode = 'chase' | 'fpv' | 'orbit';
interface Snapshot { ready: boolean; position: Point; velocity: Point; heading: number; autopilot: boolean; paused: boolean; camera: CameraMode; route: number; recoveries: number; contact: boolean; elapsed: number; frames: number; drawCalls: number; triangles: number; sound: boolean; audioState: string; input: FlightInput; activity: { speed: number; turnRate: number; contacts: number; waypoints: number }; neural: ReturnType<NeuralPilot['snapshot']> | null; motorSource: 'manual' | 'neural' | 'none'; appliedFrameTick: number | null; appliedFeatureHash: number; appliedTarget: Point | null; modelError: string; connectome: ReturnType<ActivityConnectome['snapshot']>; }
declare global { interface Window { __flypv?: { snapshot: () => Snapshot; silence: (value: boolean) => void }; } }
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const icons = { ArrowLeft, Camera, Drone, FlaskConical, Gauge, MoveVertical, Navigation, Orbit, Pause, Play, RotateCcw, Route, ScanEye, SlidersHorizontal, Sun, Volume2, VolumeX, X };
const refreshIcons = () => createIcons({ icons, attrs: { 'aria-hidden': 'true' } });
const setIcon = (element: HTMLElement, icon: string) => { const placeholder = document.createElement('i'); placeholder.setAttribute('data-lucide', icon); element.replaceChildren(placeholder); refreshIcons(); };
refreshIcons();
$<HTMLAnchorElement>('all-demos').href = import.meta.env.BASE_URL;
$('retry').addEventListener('click', () => location.reload());

function showError(message: string): void {
  $('loading').hidden = false;
  $('loading-message').textContent = message;
  $('retry').hidden = false;
  $('scene').dataset.ready = 'error';
}

class RotorAudio {
  context: AudioContext | undefined;
  private gain: GainNode | undefined;
  private oscillators: OscillatorNode[] = [];
  enabled = false;
  private disposed = false;

  async toggle(): Promise<void> {
    if (this.disposed) return;
    if (!this.context) {
      this.context = new AudioContext();
      this.gain = this.context.createGain(); this.gain.gain.value = 0;
      const filter = this.context.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 500;
      this.gain.connect(filter).connect(this.context.destination);
      for (let i = 0; i < 4; i++) { const oscillator = this.context.createOscillator(); oscillator.type = 'triangle'; oscillator.frequency.value = 83 + i * 2.3; oscillator.connect(this.gain); oscillator.start(); this.oscillators.push(oscillator); }
    }
    await this.context.resume();
    if (this.disposed) return;
    this.enabled = !this.enabled;
    if (!this.enabled) this.gain?.gain.setTargetAtTime(0, this.context.currentTime, .08);
  }
  update(speed: number, active: boolean): void {
    if (!this.context || !this.gain || this.disposed) return;
    const now = this.context.currentTime;
    this.gain.gain.setTargetAtTime(this.enabled && active ? .011 : 0, now, .12);
    this.oscillators.forEach((oscillator, i) => oscillator.frequency.setTargetAtTime(83 + speed * 3 + i * 2.3, now, .15));
  }
  dispose(): void { this.disposed = true; this.oscillators.forEach(oscillator => oscillator.stop()); void this.context?.close(); }
}

let disposeScene: (() => void) | undefined;
async function start(): Promise<void> {
  await initPhysics();
  const canvas = $<HTMLCanvasElement>('scene');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.65));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.08;
  renderer.info.autoReset = false;
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0xb5d9e8); scene.fog = new THREE.Fog(0xb5d9e8, 135, 345);
  const camera = new THREE.PerspectiveCamera(60, 1, .09, 480);
  scene.add(new THREE.HemisphereLight(0xe4f3ff, 0x687b4e, 1.6));
  const sun = new THREE.DirectionalLight(0xfff0d3, 3.25); sun.position.set(-48, 78, 36); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048); sun.shadow.camera.left = -74; sun.shadow.camera.right = 74; sun.shadow.camera.top = 69; sun.shadow.camera.bottom = -69; sun.shadow.camera.near = 1; sun.shadow.camera.far = 200; sun.shadow.normalBias = .065; sun.shadow.bias = -.0001; scene.add(sun);
  const village = createVillage(); scene.add(village.group);
  const drone = createDrone(); scene.add(drone.group);
  const physics = new FlightPhysics(village.colliders);
  const goals = new FlightGoals(ROUTE);
  const connectome = new ActivityConnectome(renderer, { mount: $('app'), className: 'flypv-connectome', title: 'PILOT CONNECTOME' });
  connectome.element.hidden = true;
  let pilot: NeuralPilot | undefined, modelError = '', modelLoading = false, requestedSilence = false;
  let controlElapsed = CONTROL_INTERVAL, measuredTurnRate = 0;
  let rotorPhase = 0;
  let motorSource: Snapshot['motorSource'] = 'none', appliedFrameTick: number | null = null, appliedFeatureHash = 0, appliedTarget: Point | null = null;
  const audio = new RotorAudio();
  const events = new AbortController();
  const signal = events.signal;
  let mode: CameraMode = 'chase', autopilot = true, paused = false, hidden = document.hidden;
  let speed = 7, sensitivity = 1, yaw = 0, elapsed = 0, accumulator = 0, frame = 0, last = performance.now();
  let previous = { ...SPAWN }, current = { ...SPAWN }, frames = 0, lastHud = -1, disposed = false, orbitAngle = 0;
  let noticeTimer = 0, cameraSnap = true, lastCollisionNotice = -100;
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
        void pilot.silence(requestedSilence);
      } else void client.dispose().catch(() => {});
    } catch (error) { if (client && !pilot) void client.dispose().catch(() => {}); modelError = error instanceof Error ? error.message : String(error); }
    finally { if (!disposed) { modelLoading = false; $<HTMLButtonElement>('calibrate').disabled = false; lastHud = -1; } }
  }
  function silence(value: boolean): void {
    requestedSilence = value; void pilot?.silence(value); $<HTMLInputElement>('neural-silenced').checked = value;
    if (autopilot) { motorSource = 'none'; appliedTarget = null; appliedFrameTick = pilot?.frame?.tick ?? null; appliedFeatureHash = pilot?.command.featureHash ?? 0; }
    controlElapsed = CONTROL_INTERVAL; lastHud = -1;
  }
  const keyboard = new Set<string>();
  const touch = { forward: 0, strafe: 0, lift: 0, yaw: 0 };
  const stickResets: (() => void)[] = [];
  const touchDevice = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  const moveKeys = new Set(['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyQ', 'KeyE', 'Space', 'ShiftLeft', 'ShiftRight', 'KeyC']);
  const controls = () => ({
    forward: THREE.MathUtils.clamp(Number(keyboard.has('KeyW') || keyboard.has('ArrowUp')) - Number(keyboard.has('KeyS') || keyboard.has('ArrowDown')) + touch.forward, -1, 1),
    strafe: THREE.MathUtils.clamp(Number(keyboard.has('KeyD')) - Number(keyboard.has('KeyA')) + touch.strafe, -1, 1),
    lift: THREE.MathUtils.clamp(Number(keyboard.has('Space')) - Number(keyboard.has('ShiftLeft') || keyboard.has('ShiftRight') || keyboard.has('KeyC')) + touch.lift, -1, 1),
    yaw: THREE.MathUtils.clamp(Number(keyboard.has('KeyQ') || keyboard.has('ArrowLeft')) - Number(keyboard.has('KeyE') || keyboard.has('ArrowRight')) + touch.yaw, -1, 1),
  });
  const clearInput = () => { keyboard.clear(); stickResets.forEach(reset => reset()); touch.forward = touch.strafe = touch.lift = touch.yaw = 0; };
  const notify = (message: string) => { clearTimeout(noticeTimer); $('notice').textContent = message; $('notice').hidden = false; noticeTimer = window.setTimeout(() => { $('notice').hidden = true; }, 2600); };

  function setAutopilot(value: boolean): void {
    if (value === autopilot) return;
    autopilot = value; controlElapsed = CONTROL_INTERVAL;
    $('autopilot').setAttribute('aria-pressed', String(autopilot)); $('mode-label').textContent = autopilot ? 'Neural' : 'Manual';
    document.body.classList.toggle('manual', !autopilot);
    $('touch-controls').hidden = autopilot || !touchDevice;
    if (autopilot) clearInput();
    lastHud = -1;
  }
  function setCamera(value: CameraMode): void {
    mode = value; cameraSnap = true; orbitAngle = .65;
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-camera]')) { const selected = button.dataset.camera === mode; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); }
    $('reticle').hidden = mode !== 'fpv';
    camera.fov = mode === 'fpv' ? 82 : innerWidth < 650 ? 69 : 60; camera.updateProjectionMatrix();
  }
  function togglePause(): void {
    paused = !paused; accumulator = 0; clearInput();
    $('pause').setAttribute('aria-pressed', String(paused)); $('pause').setAttribute('aria-label', paused ? 'Resume flight' : 'Pause flight'); $('pause').dataset.tip = paused ? 'Resume flight (P)' : 'Pause flight (P)'; setIcon($('pause'), paused ? 'play' : 'pause'); lastHud = -1;
    audio.update(0, false);
  }
  function reset(): void {
    physics.reset(); previous = { ...SPAWN }; current = { ...SPAWN }; goals.reset(); yaw = 0; elapsed = 0; accumulator = 0; cameraSnap = true; clearInput();
    void pilot?.resetState(); controlElapsed = CONTROL_INTERVAL; measuredTurnRate = 0; appliedTarget = null; appliedFrameTick = null; appliedFeatureHash = 0; motorSource = 'none';
    if (paused) togglePause();
    notify('Flight reset');
  }
  $('autopilot').addEventListener('click', () => setAutopilot(!autopilot), { signal });
  $('calibrate').addEventListener('click', () => { if (!pilot) { void loadPilot(); return; } void pilot.beginCalibration(); controlElapsed = CONTROL_INTERVAL; lastHud = -1; }, { signal });
  $('neural-silenced').addEventListener('change', event => silence((event.target as HTMLInputElement).checked), { signal });
  $('pause').addEventListener('click', togglePause, { signal }); $('reset').addEventListener('click', reset, { signal });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-camera]')) button.addEventListener('click', () => setCamera(button.dataset.camera as CameraMode), { signal });
  const settings = (open: boolean) => { $('settings').hidden = !open; if (open) $('settings').scrollTop = 0; $('settings-toggle').setAttribute('aria-expanded', String(open)); document.body.classList.toggle('settings-open', open); };
  $('settings-toggle').addEventListener('click', () => settings($('settings').hidden), { signal });
  $('settings-close').addEventListener('click', () => { settings(false); $('settings-toggle').focus(); }, { signal });
  document.addEventListener('pointerdown', event => { if (!(event.target as Element).closest('#settings, #settings-toggle')) settings(false); }, { signal });
  $<HTMLInputElement>('speed').addEventListener('input', event => { speed = Number((event.target as HTMLInputElement).value); $('speed-value').textContent = `${speed} m/s`; }, { signal });
  $<HTMLInputElement>('sensitivity').addEventListener('input', event => { sensitivity = Number((event.target as HTMLInputElement).value); $('sensitivity-value').textContent = sensitivity.toFixed(1); }, { signal });
  $<HTMLInputElement>('map-visible').addEventListener('change', event => { $('map-panel').hidden = !(event.target as HTMLInputElement).checked; }, { signal });
  $('sound').addEventListener('click', async () => {
    const button = $<HTMLButtonElement>('sound'); button.disabled = true;
    try { await audio.toggle(); if (disposed) return; button.setAttribute('aria-pressed', String(audio.enabled)); button.setAttribute('aria-label', audio.enabled ? 'Mute rotor sound' : 'Enable rotor sound'); setIcon(button, audio.enabled ? 'volume-2' : 'volume-x'); }
    catch { if (!disposed) notify('Audio is unavailable in this browser'); }
    finally { button.disabled = false; }
  }, { signal });
  window.addEventListener('keydown', event => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.code === 'Escape') { settings(false); canvas.focus({ preventScroll: true }); return; }
    if ((event.target as Element)?.closest('input, textarea, select, [contenteditable=true]')) return;
    if (moveKeys.has(event.code)) { if (event.code === 'Space' && (event.target as Element).closest('button')) return; event.preventDefault(); keyboard.add(event.code); setAutopilot(false); }
    else if (!event.repeat) {
      if (event.code === 'KeyG') setAutopilot(!autopilot);
      if (event.code === 'KeyV') setCamera(mode === 'chase' ? 'fpv' : mode === 'fpv' ? 'orbit' : 'chase');
      if (event.code === 'KeyP') togglePause();
      if (event.code === 'KeyR') reset();
    }
  }, { signal });
  window.addEventListener('keyup', event => keyboard.delete(event.code), { signal });
  window.addEventListener('blur', clearInput, { signal });
  document.addEventListener('visibilitychange', () => { hidden = document.hidden; clearInput(); accumulator = 0; previous = { ...current }; last = performance.now(); if (hidden) audio.update(0, false); }, { signal });
  canvas.addEventListener('pointerdown', () => canvas.focus({ preventScroll: true }), { signal });

  for (const name of ['look', 'move'] as const) {
    const stick = $(`${name}-stick`), knob = stick.querySelector<HTMLElement>('.stick-knob')!;
    let pointer: number | undefined;
    const update = (event: PointerEvent) => {
      const rect = stick.getBoundingClientRect(), radius = rect.width * .34;
      let x = (event.clientX - rect.left - rect.width / 2) / radius, y = (event.clientY - rect.top - rect.height / 2) / radius;
      const length = Math.max(1, Math.hypot(x, y)); x /= length; y /= length;
      knob.style.transform = `translate(${x * radius}px, ${y * radius}px)`;
      if (name === 'move') { touch.strafe = x; touch.forward = -y; } else { touch.yaw = -x; touch.lift = -y; }
    };
    const release = () => {
      const id = pointer; pointer = undefined; if (id !== undefined && stick.hasPointerCapture(id)) stick.releasePointerCapture(id);
      knob.style.transform = ''; if (name === 'move') touch.strafe = touch.forward = 0; else touch.yaw = touch.lift = 0;
    };
    stickResets.push(release);
    stick.addEventListener('pointerdown', event => { if (pointer !== undefined) return; event.preventDefault(); pointer = event.pointerId; stick.setPointerCapture(pointer); setAutopilot(false); update(event); }, { signal });
    stick.addEventListener('pointermove', event => { if (pointer === event.pointerId) update(event); }, { signal });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) stick.addEventListener(type, event => { if ((event as PointerEvent).pointerId === pointer) release(); }, { signal });
  }

  function fixedStep(): void {
    pilot?.commit();
    previous = { ...current };
    const previousHeading = yaw, input = controls();
    controlElapsed += FIXED_DT;
    if (pilot && !pilot.busy && controlElapsed >= CONTROL_INTERVAL) {
      controlElapsed = 0;
      void pilot.infer({ position: current, velocity: physics.velocity(), heading: yaw, turnRate: measuredTurnRate,
        goal: goals.current, contact: physics.contact, clearances: physics.clearances(yaw) }, speed);
    }
    let target: Point | null;
    appliedFrameTick = null; appliedFeatureHash = 0;
    if (autopilot) {
      const command = pilot?.command ?? unpowered();
      yaw = wrapAngle(yaw + command.yawRate * sensitivity * FIXED_DT);
      target = command.powered ? manualVelocity(command.input, yaw, speed) : null;
      motorSource = command.powered ? 'neural' : 'none';
      appliedFrameTick = command.frameTick; appliedFeatureHash = command.featureHash;
    } else {
      yaw = wrapAngle(yaw + input.yaw * 1.55 * sensitivity * FIXED_DT); target = manualVelocity(input, yaw, speed);
      motorSource = 'manual';
    }
    physics.step(target, sensitivity); current = physics.position(); elapsed += FIXED_DT;
    appliedTarget = target; measuredTurnRate = wrapAngle(yaw - previousHeading) / FIXED_DT;
    if (autopilot) goals.update(current, physics.contact);
    if (!Number.isFinite(current.y)) throw new Error('Invalid physical state');
    if (physics.contact && elapsed - lastCollisionNotice > 4) { notify('Contact'); lastCollisionNotice = elapsed; }
  }

  const offset = new THREE.Vector3(), aim = new THREE.Vector3(), desired = new THREE.Vector3(), rayDirection = new THREE.Vector3();
  const upAxis = new THREE.Vector3(0, 1, 0);
  const cameraRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  function updateCamera(dt: number): void {
    drone.group.visible = mode !== 'fpv';
    if (mode === 'fpv') {
      offset.set(0, 1.12, -.78).applyQuaternion(drone.group.quaternion); camera.position.copy(drone.group.position).add(offset);
      aim.set(0, 1.12, -30).applyQuaternion(drone.group.quaternion).add(drone.group.position);
      camera.up.set(0, 1, 0).applyQuaternion(drone.group.quaternion); camera.lookAt(aim); return;
    }
    if (mode === 'orbit' && !paused && !hidden) orbitAngle += dt * .15;
    offset.set(mode === 'orbit' ? Math.sin(orbitAngle) * 8.6 : 4.2, mode === 'orbit' ? 3.1 : 3.15, mode === 'orbit' ? -Math.cos(orbitAngle) * 8.6 : 8.2).applyAxisAngle(upAxis, yaw);
    desired.copy(drone.group.position).add(offset);
    desired.y = Math.max(desired.y, terrainHeight(desired.x, desired.z) + 1.1);
    aim.copy(drone.group.position).add(new THREE.Vector3(0, .8, mode === 'orbit' ? 0 : -1.7).applyAxisAngle(upAxis, yaw));
    rayDirection.subVectors(desired, aim); const distance = rayDirection.length(); rayDirection.normalize();
    cameraRay.origin = { x: aim.x, y: aim.y, z: aim.z }; cameraRay.dir = { x: rayDirection.x, y: rayDirection.y, z: rayDirection.z };
    const hit = physics.world.castRay(cameraRay, distance, true, undefined, undefined, physics.collider, physics.body);
    if (hit) desired.copy(aim).addScaledVector(rayDirection, Math.max(.35, hit.timeOfImpact - .4));
    if (cameraSnap || hit) camera.position.copy(desired); else camera.position.lerp(desired, 1 - Math.exp(-7 * dt));
    cameraSnap = false; camera.up.set(0, 1, 0); camera.lookAt(aim);
  }

  const map = $<HTMLCanvasElement>('map'), ctx = map.getContext('2d')!;
  function drawMap(): void {
    if ($('map-panel').hidden) return;
    const s = 1.93, mid = 128;
    ctx.fillStyle = '#c3cda8'; ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = '#8fb7b3'; ctx.lineWidth = 14; ctx.beginPath(); ctx.moveTo(18, 0); ctx.bezierCurveTo(4, 80, 27, 150, 12, 256); ctx.stroke();
    ctx.fillStyle = '#ded6b3'; ctx.fillRect(121, 29, 14, 215); ctx.fillRect(47, 130, 162, 12);
    ctx.strokeStyle = '#71877a'; ctx.lineWidth = 4; ctx.strokeRect(mid - 42 * s, mid - 37 * s, 84 * s, 74 * s);
    ctx.fillStyle = '#d0d4b4'; ctx.fillRect(116, 196, 24, 9);
    for (const house of village.houses) { ctx.save(); ctx.translate(mid + house.x * s, mid + house.z * s); ctx.rotate(-house.yaw); ctx.fillStyle = house.roof === 0xa55e46 ? '#ad7862' : '#6b8580'; ctx.fillRect(-house.w * s / 2, -house.d * s / 2, house.w * s, house.d * s); ctx.restore(); }
    ctx.fillStyle = '#6b8580'; ctx.beginPath(); ctx.arc(mid + 27 * s, mid - 28 * s, 9, 0, Math.PI * 2); ctx.fill();
    ctx.setLineDash([3, 5]); ctx.strokeStyle = '#f8f8e8b3'; ctx.lineWidth = 2; ctx.beginPath(); ROUTE.forEach((p, i) => { if (!i) ctx.moveTo(mid + p.x * s, mid + p.z * s); else ctx.lineTo(mid + p.x * s, mid + p.z * s); }); ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
    const target = goals.current;
    if (autopilot) { ctx.strokeStyle = '#faf9e8'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(mid + target.x * s, mid + target.z * s, 4, 0, Math.PI * 2); ctx.stroke(); }
    const inRange = Math.abs(current.x) < 61 && Math.abs(current.z) < 61;
    ctx.save(); ctx.translate(Math.max(8, Math.min(248, mid + current.x * s)), Math.max(8, Math.min(248, mid + current.z * s))); ctx.rotate(-yaw);
    ctx.shadowColor = '#354c4680'; ctx.shadowBlur = 4; ctx.fillStyle = inRange ? '#e46048' : '#ffffff'; ctx.strokeStyle = '#fff8ed'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(5, 6); ctx.lineTo(0, 3); ctx.lineTo(-5, 6); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
  }
  function updateHud(): void {
    const velocity = physics.velocity(), magnitude = Math.hypot(velocity.x, velocity.y, velocity.z);
    $('altitude').textContent = Math.max(0, current.y - terrainHeight(current.x, current.z)).toFixed(1); $('velocity').textContent = magnitude.toFixed(1);
    const heading = ((-yaw * 180 / Math.PI) % 360 + 360) % 360;
    $('heading').textContent = Math.round(heading).toString().padStart(3, '0'); $('heading-direction').textContent = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(heading / 45) % 8];
    $('flight-time').textContent = `${Math.floor(elapsed / 60).toString().padStart(2, '0')}:${Math.floor(elapsed % 60).toString().padStart(2, '0')}`;
    $('flight-status').textContent = paused ? 'FLIGHT PAUSED' : !autopilot ? 'MANUAL FLIGHT' : pilot?.silenced ? 'NEURONS SILENCED'
      : pilot?.phase === 'inference' ? 'NEURAL FLIGHT' : pilot?.phase === 'calibration' ? 'CALIBRATING' : 'NEURAL DRIVE OFF';
    $('status-dot').style.background = paused || motorSource === 'none' ? '#95a494' : autopilot ? '#4d8060' : '#de624f';
    $('neural-status').textContent = modelLoading ? 'Loading full neural model' : modelError ? 'Neural model unavailable' : pilot?.phase === 'failed' ? pilot.failure
      : pilot?.phase === 'calibration' ? `Sensor rehearsal ${pilot.samples}/${pilot.calibrationTrials}` : pilot?.phase === 'inference' ? 'Experimental LIF / learned readout' : 'Uncalibrated / motor drive off';
    $('calibration-metric').textContent = pilot ? `${pilot.readout.updates} teacher updates / loss ${pilot.lastLoss.toFixed(3)}` : 'No substitute controller';
    $('neural-clock').textContent = pilot ? `${Math.round(pilot.latencyMs)} ms worker latency / ${goals.reached} goals / ${goals.contacts} contacts` : '20 model ms per 100 world ms requested';
    $<HTMLButtonElement>('calibrate').disabled = modelLoading || pilot?.phase === 'calibration' || Boolean(pilot?.silenced) || pilot?.phase === 'failed';
    $('calibrate-label').textContent = modelError ? 'Retry model' : 'Calibrate';
    audio.update(magnitude, !paused && !hidden && motorSource !== 'none'); drawMap();
  }

  function resize(): void { const width = canvas.clientWidth, height = canvas.clientHeight; renderer.setSize(width, height, false); camera.aspect = width / Math.max(1, height); camera.fov = mode === 'fpv' ? 82 : width < 650 ? 69 : 60; camera.updateProjectionMatrix(); cameraSnap = true; }
  const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
  function animate(now: number): void {
    if (disposed) return;
    try {
      const dt = Math.min((now - last) / 1000, .1); last = now;
      const visualDt = paused || hidden ? 0 : dt;
      if (!paused && !hidden) {
        accumulator += dt;
        while (accumulator >= FIXED_DT) { fixedStep(); accumulator -= FIXED_DT; }
        void pilot?.calibrateStep();
      }
      const alpha = paused || hidden ? 1 : accumulator / FIXED_DT;
      drone.group.position.set(THREE.MathUtils.lerp(previous.x, current.x, alpha), THREE.MathUtils.lerp(previous.y, current.y, alpha), THREE.MathUtils.lerp(previous.z, current.z, alpha));
      const velocity = physics.velocity();
      const forwardSpeed = -Math.sin(yaw) * velocity.x - Math.cos(yaw) * velocity.z;
      const sideSpeed = Math.cos(yaw) * velocity.x - Math.sin(yaw) * velocity.z;
      drone.group.rotation.order = 'YXZ'; drone.group.rotation.y = yaw;
      drone.group.rotation.x = THREE.MathUtils.lerp(drone.group.rotation.x, -forwardSpeed * .016, 1 - Math.exp(-6 * visualDt));
      drone.group.rotation.z = THREE.MathUtils.lerp(drone.group.rotation.z, -sideSpeed * .022, 1 - Math.exp(-6 * visualDt));
      if (!paused && !hidden) {
        if (motorSource !== 'none') {
          rotorPhase += visualDt * (75 + Math.hypot(velocity.x, velocity.z) * 3);
          drone.rotors.forEach((rotor, i) => { rotor.rotation.y = rotorPhase * (i % 2 ? -1 : 1); });
          drone.wings.forEach((wing, i) => { wing.rotation.z = Math.sin(elapsed * 14) * .025 * (i ? -1 : 1); });
        }
        for (const flag of village.flags) {
          const positions = flag.geometry.getAttribute('position');
          for (let i = 0; i < positions.count; i++) { const x = positions.getX(i); positions.setZ(i, Math.sin(x * 3 - elapsed * 4) * .18 * (x + 1.4) / 2.8); }
          positions.needsUpdate = true;
        }
      }
      updateCamera(visualDt);
      if (pilot?.frame) { connectome.element.hidden = false; connectome.updateNeural(pilot.frame, {
        label: paused ? 'Pilot 01 / paused' : pilot.phase === 'calibration' ? 'Calibration / sensor rehearsal' : !autopilot ? 'Manual / neural response'
          : pilot.silenced ? 'Pilot 01 / neurons silenced' : pilot.phase === 'uncalibrated' ? 'Pilot 01 / uncalibrated' : `Pilot 01 / ${pilot.command.action}`,
        detail: `${(pilot.frame.simulatedMs / 1000).toFixed(2)}s model / ${elapsed.toFixed(1)}s world`, paused: paused || hidden,
        edgeCount: pilot.model.edgeCount, modelId: pilot.model.modelId,
      }); }
      renderer.info.reset(); renderer.render(scene, camera); connectome.render(); frames++;
      if (now - lastHud > 100) { lastHud = now; updateHud(); }
      frame = requestAnimationFrame(animate);
    } catch (error) { console.error('Flylot rendering failed', error); dispose(); showError('Flight rendering stopped. Reload to try again.'); }
  }

  function dispose(): void {
    if (disposed) return; disposed = true; cancelAnimationFrame(frame); clearTimeout(noticeTimer); clearInput(); events.abort(); observer.disconnect(); audio.dispose(); physics.dispose(); connectome.dispose(); void pilot?.dispose();
    const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
    scene.traverse(object => { const mesh = object as THREE.Mesh; if (mesh.geometry) geometries.add(mesh.geometry); if (mesh.material) (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(material => materials.add(material)); });
    geometries.forEach(geometry => geometry.dispose()); materials.forEach(material => { const map = (material as THREE.MeshStandardMaterial).map; if (map) textures.add(map); material.dispose(); }); textures.forEach(texture => texture.dispose()); sun.shadow.dispose(); renderer.dispose(); delete window.__flypv;
  }
  disposeScene = dispose;
  canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); dispose(); showError('The graphics context was interrupted. Reload to resume flight.'); }, { signal });
  window.addEventListener('pagehide', dispose, { once: true, signal });
  window.__flypv = { silence, snapshot: () => ({ ready: !disposed, position: physics.position(), velocity: physics.velocity(), heading: yaw, autopilot, paused, camera: mode, route: goals.index, recoveries: 0, contact: physics.contact, elapsed, frames, drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles, sound: audio.enabled, audioState: audio.context?.state ?? 'uninitialized', input: controls(), activity: { speed: Math.hypot(...Object.values(physics.velocity())), turnRate: measuredTurnRate, contacts: goals.contacts, waypoints: goals.reached }, neural: pilot?.snapshot() ?? null, motorSource, appliedFrameTick, appliedFeatureHash, appliedTarget, modelError, connectome: connectome.snapshot() }) };
  setCamera(mode); frame = requestAnimationFrame(animate); canvas.dataset.ready = 'true'; $('loading').hidden = true;
  void loadPilot();
}

void start().catch(error => { console.error('Flylot initialization failed', error); disposeScene?.(); showError('Alderwatch could not load. Check WebGL support and reload the flight.'); });
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
if (import.meta.hot) import.meta.hot.dispose(() => disposeScene?.());

import { ArrowUpLeft, Gauge, Pause, Play, Repeat2, RotateCcw, Scan, SkipBack, Volume2, VolumeX, createElement, createIcons } from "lucide";
import { PianoScene } from "./scene";
import { PianoAudio } from "./audio";
import { PianoNotation } from "./notation";
import { DEFAULT_BPM, MEASURES, TOTAL_BEATS, SilentTransport, clampTempo, measureAt, normalizeBeat } from "./score";
import { PianoNeuralSession } from "./neural-session";
import { pianoControllerOptions } from "./controller-options";
import { AsyncNeuralRuntime } from "../../src/neural/client";
import "./style.css";

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const canvas = element<HTMLCanvasElement>("scene");
const seek = element<HTMLInputElement>("seek");
const playButton = element<HTMLButtonElement>("play");
const muteButton = element<HTMLButtonElement>("mute");
const soundButton = element<HTMLButtonElement>("sound-enable");
const status = element("status-text");
const statusRoot = element("scene-status");
const loopButton = element<HTMLButtonElement>("loop");
const tempoInput = element<HTMLInputElement>("tempo");
const volumeInput = element<HTMLInputElement>("volume");
const calibrationInput = element<HTMLInputElement>("calibrate");
const controller = pianoControllerOptions(location.search);
const experimentalV2 = controller.version === "v2";
calibrationInput.checked = controller.calibrating;
const events = new AbortController();
const clock = new SilentTransport();
const audio = new PianoAudio();
let scene: PianoScene | undefined;
let notation: PianoNotation | undefined;
let neural: PianoNeuralSession | undefined;
let loadingNeural: PianoNeuralSession | undefined;
let neuralStatus = "loading";
let neuralModel: { modelId: string; nodes: number; edges: number } | null = null;
let previousNeuralBeat = 0;
let disposed = false;
let fatal = false;
let audioBusy = false;
let audioError = false;
let frameRequest = 0;
let previousTime = performance.now();
let wasPlaying = false;
let lastUiBeat = -1;
let lastFrameAudioBeat: number | null = null;
let frameSampleTime = performance.now();

createIcons({ icons: { ArrowUpLeft, Gauge, Pause, Play, Repeat2, RotateCcw, Scan, SkipBack, Volume2, VolumeX }, attrs: { "aria-hidden": "true" } });

function icon(button: HTMLButtonElement, node: typeof Play): void {
  button.replaceChildren(createElement(node, { "aria-hidden": "true" }));
}

function refreshControls(): void {
  icon(playButton, clock.playing ? Pause : Play);
  playButton.setAttribute("aria-label", clock.playing ? "Pause performance" : "Play performance");
  playButton.dataset.tooltip = clock.playing ? "Pause" : "Play";
  loopButton.setAttribute("aria-pressed", String(clock.loop));
  const silent = !audio.ready || audio.muted || audio.level === 0;
  icon(muteButton, silent ? VolumeX : Volume2);
  const label = audio.ready ? audio.muted ? "Unmute" : "Mute" : "Enable sound";
  muteButton.setAttribute("aria-label", label);
  muteButton.setAttribute("aria-pressed", String(silent));
  muteButton.dataset.tooltip = label;
  soundButton.replaceChildren(createElement(silent ? VolumeX : Volume2, { "aria-hidden": "true" }));
  const text = document.createElement("span");
  text.textContent = audioBusy ? "Preparing audio" : audioError ? "Retry sound" : !audio.ready ? "Enable sound" : silent ? "Sound off" : "Sound on";
  soundButton.append(text);
  soundButton.classList.toggle("enabled", !silent);
  soundButton.disabled = audioBusy || fatal;
  soundButton.setAttribute("aria-label", audioError ? "Retry sound" : label);
  muteButton.disabled = audioBusy || fatal;
  playButton.disabled = !neural || fatal;
  if (!fatal) status.textContent = !neural ? `Neural model ${neuralStatus}` : audioError ? "Audio unavailable" : !clock.playing ? clock.beat >= TOTAL_BEATS ? "Recital complete" : "Paused" : calibrationInput.checked ? "Calibrating" : "Neural performance";
  if (!fatal && neural && experimentalV2 && clock.playing && !calibrationInput.checked && !audioError) status.textContent = controller.cold ? "Cold readouts" : "Offline-calibrated";
  if (!fatal) status.textContent = `${experimentalV2 ? "V2 experimental" : "V1"} / ${status.textContent}`;
  statusRoot.classList.toggle("paused", !clock.playing);
}

function syncAudio(): void { audio.sync(clock.beat, clock.bpm, Boolean(neural) && clock.playing && !document.hidden, clock.loop); }

async function enableSound(): Promise<boolean> {
  if (audioBusy || fatal || disposed) return false;
  audioBusy = true; audioError = false; refreshControls();
  try {
    await audio.enable();
    if (disposed) return false;
    audio.setMuted(false); audio.setVolume(Number(volumeInput.value) / 100);
    syncAudio(); return true;
  } catch (error) {
    audioError = true;
    console.warn("Piano audio could not start", error);
    return false;
  } finally {
    audioBusy = false;
    if (!disposed) refreshControls();
  }
}

async function toggleSound(): Promise<void> {
  if (!audio.ready) { await enableSound(); return; }
  if (audio.muted) {
    try { await audio.enable(); audioError = false; audio.setMuted(false); }
    catch { audioError = true; }
  } else audio.setMuted(true);
  refreshControls();
}

function setPlaying(playing: boolean): void {
  if (fatal || !neural) return;
  if (playing && clock.beat >= TOTAL_BEATS) { clock.seek(0); neural.reset(); previousNeuralBeat = 0; }
  clock.playing = playing;
  neural.setPlaying(playing);
  syncAudio(); refreshControls();
}

function seekTo(beat: number): void {
  clock.seek(beat);
  if (clock.beat === TOTAL_BEATS && clock.loop) clock.seek(0);
  if (clock.beat === TOTAL_BEATS) clock.playing = false;
  neural?.setPlaying(clock.playing);
  neural?.reset(clock.beat); previousNeuralBeat = clock.beat;
  syncAudio(); lastUiBeat = -1; refreshControls(); notation?.update(clock.beat, clock.playing, 0); updateUi();
}

function showSceneError(message: string): void {
  fatal = true; clock.playing = false; syncAudio();
  element("error-text").textContent = message;
  element("scene-error").hidden = false;
  status.textContent = "Scene unavailable";
  element("app").querySelectorAll<HTMLButtonElement | HTMLInputElement>("button:not(#retry), input").forEach(control => { control.disabled = true; });
  refreshControls();
}

function timeString(beat: number): string {
  const seconds = Math.floor(beat * 60 / clock.bpm);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function updateUi(): void {
  seek.value = String(clock.beat);
  if (Math.abs(clock.beat - lastUiBeat) < 0.04) return;
  element("elapsed").textContent = timeString(clock.beat);
  element("duration").textContent = timeString(TOTAL_BEATS);
  const measure = measureAt(clock.beat);
  element("bar-count").innerHTML = `${measure.pickup ? "00" : String(measure.number).padStart(2, "0")} <span>/ ${MEASURES.length - 1}</span>`;
  seek.setAttribute("aria-valuetext", `${measure.pickup ? "Pickup" : `Measure ${measure.number} of ${MEASURES.length - 1}`}, ${timeString(clock.beat)}`);
  lastUiBeat = clock.beat;
}

function frame(now: number): void {
  if (disposed || fatal) return;
  const elapsedSeconds = Math.max(0, (now - previousTime) / 1000);
  const seconds = Math.min(0.1, elapsedSeconds);
  previousTime = now;
  if (!document.hidden) {
    frameSampleTime = performance.now();
    if (clock.playing && neural) {
      const audioBeat = audio.getBeat();
      lastFrameAudioBeat = audioBeat;
      if (audioBeat !== null) {
        clock.beat = normalizeBeat(audioBeat, clock.loop);
        if (!clock.loop && audioBeat >= TOTAL_BEATS) { clock.beat = TOTAL_BEATS; setPlaying(false); }
      } else {
        clock.advance(elapsedSeconds);
        if (!clock.playing) { neural.setPlaying(false); refreshControls(); }
      }
      if (clock.beat < previousNeuralBeat) neural.reset();
      if (clock.playing) neural.update(elapsedSeconds * 1000, clock.beat, clock.bpm, clock.loop, calibrationInput.checked);
      audio.perform(neural.takeContacts());
      previousNeuralBeat = clock.beat;
    }
    scene?.update(clock.beat, now, clock.playing, neural, neuralStatus, neuralModel);
    notation?.update(clock.beat, clock.playing, seconds);
    if (neural) {
      const assessment = neural.assessment.snapshot(); notation?.showPerformance(assessment);
      element("performance-text").textContent = `Played ${assessment.performed} / Missed ${assessment.missed} / Wrong ${assessment.wrong}`;
    }
    updateUi();
  }
  frameRequest = requestAnimationFrame(frame);
}

const listen = (id: string, event: string, listener: EventListener): void => element(id).addEventListener(event, listener, { signal: events.signal });
listen("play", "click", () => setPlaying(!clock.playing));
listen("calibrate", "change", () => { neural?.setCalibrating(calibrationInput.checked); refreshControls(); });
listen("restart", "click", () => seekTo(0));
listen("loop", "click", () => { clock.loop = !clock.loop; audio.setLoop(clock.loop); refreshControls(); });
listen("sound-enable", "click", () => { void toggleSound(); });
listen("mute", "click", () => { void toggleSound(); });
listen("tempo", "input", () => {
  clock.bpm = clampTempo(Number(tempoInput.value));
  element("tempo-value").textContent = String(clock.bpm);
  tempoInput.setAttribute("aria-valuetext", `${clock.bpm} beats per minute`);
  audio.setTempo(clock.bpm); lastUiBeat = -1; updateUi();
});
listen("volume", "input", () => {
  const level = Number(volumeInput.value) / 100;
  audio.setVolume(level);
  if (!audio.ready && level > 0) void enableSound();
  else if (level > 0) audio.setMuted(false);
  refreshControls();
});
listen("seek", "input", () => seekTo(Number(seek.value)));
listen("camera-reset", "click", () => scene?.resetCamera());
listen("retry", "click", () => location.reload());
canvas.addEventListener("keydown", event => {
  if (event.code === "Space") { event.preventDefault(); setPlaying(!clock.playing); }
  if (event.code === "Home") { event.preventDefault(); seekTo(0); }
}, { signal: events.signal });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { wasPlaying = clock.playing; setPlaying(false); }
  else { previousTime = performance.now(); if (wasPlaying) setPlaying(true); }
}, { signal: events.signal });

seek.max = String(TOTAL_BEATS);
element("app").querySelector<HTMLAnchorElement>(".home-link")!.href = import.meta.env.BASE_URL;
tempoInput.value = String(DEFAULT_BPM); element("tempo-value").textContent = String(DEFAULT_BPM);
notation = new PianoNotation(element("notation"), seekTo);
function neuralUnavailable(error: Error): void {
  if (disposed || neuralStatus === "unavailable") return;
  neural?.dispose(); neural = undefined;
  neuralStatus = "unavailable"; clock.playing = false; syncAudio(); refreshControls();
  console.warn("Piano neural model unavailable; autonomous notes disabled", error);
}
try {
  scene = new PianoScene(canvas, midi => {
    scene?.press(midi);
    if (audio.ready) {
      audio.audition(midi);
    } else void enableSound().then(enabled => { if (enabled) audio.audition(midi); });
  }, () => showSceneError("The graphics context was interrupted. Reload the recital to restore the stage."));
  refreshControls(); updateUi();
  previousTime = performance.now();
  frameRequest = requestAnimationFrame(frame);
  loadingNeural = new PianoNeuralSession(() => AsyncNeuralRuntime.create(931), neuralUnavailable, experimentalV2 ? {
    cold: controller.cold,
    calibration: async () => {
      const response = await fetch(new URL("./calibration-v2.json", import.meta.url));
      if (!response.ok) throw new Error(`Piano candidate calibration HTTP ${response.status}`);
      return response.json();
    },
  } : undefined);
  void loadingNeural.ready.then(model => {
    if (disposed) return;
    neuralModel = model; neural = loadingNeural!; neural.setPlaying(clock.playing); neural.setCalibrating(calibrationInput.checked);
    neuralStatus = "ready"; previousTime = performance.now(); syncAudio(); refreshControls();
  }).catch(neuralUnavailable);
} catch (error) {
  console.error("Piano scene could not start", error);
  showSceneError("This recital needs WebGL graphics. Check browser graphics support, then retry.");
}

function dispose(): void {
  if (disposed) return;
  disposed = true; cancelAnimationFrame(frameRequest); events.abort();
  notation?.dispose(); scene?.dispose(); audio.dispose(); loadingNeural?.dispose(); neural?.dispose();
  delete window.__flyPiano;
}

window.addEventListener("pagehide", event => { if (!event.persisted) dispose(); }, { signal: events.signal });
if (import.meta.hot) import.meta.hot.dispose(dispose);

// Read-only diagnostics are used by the local canvas/audio verification script.
window.__flyPiano = {
  snapshot: () => ({ playing: clock.playing, beat: clock.beat, bpm: clock.bpm, loop: clock.loop, totalBeats: TOTAL_BEATS, frameAudioBeat: lastFrameAudioBeat, frameAgeMs: performance.now() - frameSampleTime, audio: audio.getDebugState(), scene: scene?.getDebugState(), notation: notation?.snapshot(), neural: neural?.snapshot() ?? { ready: false, status: neuralStatus }, neuralModel }),
  silence: (enabled: boolean) => neural?.silence(enabled),
  captureAudio: () => audio.captureOutput(),
};
declare global { interface Window { __flyPiano?: { snapshot(): object; silence(enabled: boolean): Promise<void> | undefined; captureAudio(): ReturnType<PianoAudio["captureOutput"]> } } }

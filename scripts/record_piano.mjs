import assert from "node:assert/strict";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { DEFAULT_BPM, TOTAL_BEATS } from "../simulations/piano/score.ts";

let baseURL = process.env.PIANO_URL;
const raw = resolve("simulations/piano/verification/neural-recording");
const output = resolve("docs/media"), viewport = { width: 1920, height: 1080 };
const inferenceSeconds = 30, leadSeconds = 0.15, seconds = 31, posterSeconds = 10;
const source = resolve(raw, "capture.webm"), mp4 = resolve(raw, "flythoven-neural.mp4"), poster = resolve(raw, "flythoven-neural.png");
const files = { mp4: resolve(output, "flythoven-neural.mp4"), poster: resolve(output, "flythoven-neural.png") };
const legacy = { path: resolve(output, "flythoven.mp4"), role: "Old score-driven two-front-leg recording; preserved unchanged" };
let startedAt = new Date().toISOString();
const verifySaved = process.env.PIANO_VERIFY_CAPTURE === "1";
const sha256 = async path => createHash("sha256").update(await readFile(path)).digest("hex");
const appPaths = ["main.ts", "scene.ts", "audio.ts", "score.ts", "score-data.ts", "notation.ts", "performance.ts", "actuator.ts", "assessment.ts", "neural-model.ts", "neural-session.ts", "style.css"]
  .map(path => `simulations/piano/${path}`).concat(["src/activityConnectome.ts", "src/activityConnectome.css", "src/neural/client.ts", "src/neural/worker.ts", "src/neural/runtime.ts", "src/neural/policy.ts"]);
async function appHashes() { const hashes = {}; for (const path of appPaths) hashes[path] = await sha256(path); return hashes; }
function run(command, args, encoding = "utf8") {
  const result = spawnSync(command, args, { encoding, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${command} exited ${result.status}: ${result.stderr}`);
  return result;
}
const ffmpeg = (args, encoding = "utf8") => run("ffmpeg", ["-hide_banner", "-y", "-threads", "2", "-filter_threads", "2", "-filter_complex_threads", "2",
  ...args.slice(0, -1), "-threads", "2", args.at(-1)], encoding);
const snapshot = page => page.evaluate(() => window.__flyPiano.snapshot());
const waitNeural = page => page.locator('.activity-connectome[data-ready="true"][data-neural-ready="true"]').waitFor({ timeout: 120000 });

await mkdir(raw, { recursive: true }); await mkdir(output, { recursive: true });
// Finished v1 media and its raw report are historical evidence, not replaceable takes.
if (!verifySaved) {
  try { await stat(files.mp4); throw new Error("Existing neural recording is preserved; use a separately versioned recorder/output for a new experiment"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
legacy.sha256 = await sha256(legacy.path);
if (!verifySaved) await writeFile(resolve(raw, "report.json"), JSON.stringify({ passed: false, startedAt, files, legacy, selection: "Single fresh-session take; no musical-accuracy selection" }, null, 2) + "\n");
run("ffmpeg", ["-version"]); run("ffprobe", ["-version"]);
const server = baseURL || verifySaved ? null : await createServer({ configFile: false, root: resolve("."), cacheDir: resolve(raw, "vite-cache"),
  optimizeDeps: { entries: ["simulations/piano/index.html"] },
  server: { host: "127.0.0.1", port: 5188, strictPort: true, hmr: false, watch: null },
});
let browser;
let errors = [], warnings = [];
let recording, precheck, sourceHashes;

async function preparePage(context) {
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") errors.push(message.text());
    if (message.type() === "warning") warnings.push(message.text());
  });
  let toneURL;
  page.on("request", request => { if (new URL(request.url()).pathname.endsWith("/tone.js")) toneURL = request.url(); });
  await page.addInitScript(() => {
    // Use the ordinary pause control before the first model request. No hidden warmup.
    const observer = new MutationObserver(() => {
      if (!window.__flyPiano?.snapshot().neural.ready) return;
      const button = document.querySelector("#play");
      if (!button || button.disabled) return;
      observer.disconnect();
      if (window.__flyPiano.snapshot().playing) button.click();
    });
    observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
  });
  await page.goto(baseURL, { waitUntil: "networkidle" }); await waitNeural(page);
  await page.locator('#notation[data-ready="true"]').waitFor();
  await page.locator('.activity-connectome[data-paused="true"]').waitFor();
  const cold = await snapshot(page);
  assert.equal(cold.playing, false); assert.equal(cold.beat, 0); assert.equal(cold.bpm, DEFAULT_BPM);
  assert.equal(cold.neural.runtime.tick, 0); assert.equal(cold.neural.predictions, 0);
  assert.equal(cold.neural.acceptedCommands, 0); assert.equal(cold.neural.actuator.totalContacts, 0);
  assert.ok(cold.neural.updates.every(item => item.updates === 0));
  assert.equal(cold.neural.calibrating, true); assert.equal(await page.locator("#calibrate").isChecked(), true);
  await page.locator("#sound-enable").click();
  await page.waitForFunction(() => window.__flyPiano.snapshot().audio.ready);
  await page.mouse.move(0, 0); assert.ok(toneURL, "Shared Tone module unavailable");
  return { page, toneURL, cold };
}

async function startAudit(page) {
  await page.evaluate(() => {
    const audit = window.__pianoAudit = { started: performance.now(), events: {}, assessments: {}, samples: [], passes: {}, errors: [],
      contactCounts: { L1: 0, L2: 0, L3: 0, R1: 0, R2: 0, R3: 0 }, maxContactError: 0, maxSimultaneous: 0,
      frames: 0, lastSample: -1, pass: 0, previousBeat: 0, lastFrame: -1, running: true };
    const tick = () => {
      if (!audit.running || !window.__flyPiano) return;
      const s = window.__flyPiano.snapshot(), time = (performance.now() - audit.started) / 1000;
      if (s.scene.frame !== audit.lastFrame) {
        audit.lastFrame = s.scene.frame; audit.frames++;
        if (s.beat + 1 < audit.previousBeat) audit.pass++;
        audit.previousBeat = s.beat;
        const contacts = s.scene.legs.filter(leg => leg.contact);
        audit.maxSimultaneous = Math.max(audit.maxSimultaneous, contacts.length);
        for (const leg of contacts) {
          const event = s.scene.performed.find(event => event.eventId === leg.eventId);
          const sound = s.audio.performed.find(event => event.eventId === leg.eventId);
          if (!event || event.legId !== leg.id || event.midi !== leg.midi || event.source !== "neural" || !(event.neuralTick > 0)) audit.errors.push(`Uncaused contact ${leg.id}:${leg.eventId}`);
          if (!sound || sound.midi !== leg.midi) audit.errors.push(`Audio identity mismatch ${leg.eventId}`);
          if (!leg.reachable || !leg.joints.flat().every(Number.isFinite) || leg.contactError > 1e-7) audit.errors.push(`Invalid geometry ${leg.id}:${leg.contactError}`);
          audit.maxContactError = Math.max(audit.maxContactError, leg.contactError);
          if (event && !audit.events[event.eventId]) {
            audit.contactCounts[leg.id]++;
            audit.events[event.eventId] = { ...event, captureTime: time, pass: audit.pass, beat: s.beat, audioTime: sound?.time,
              tip: leg.tip, keySurface: leg.keySurface, contactError: leg.contactError, visibleKeyPress: s.scene.keys.find(key => key.midi === leg.midi).press };
          }
        }
        for (const result of s.neural.assessment.events) audit.assessments[result.eventId] = { ...result, pass: audit.pass };
        const assessment = s.neural.assessment;
        audit.passes[audit.pass] = { ...assessment, outcomes: undefined, events: undefined, lastBeat: s.beat };
        if (time - audit.lastSample >= 0.1) {
          audit.lastSample = time;
          audit.samples.push({ time, frame: s.scene.frame, beat: s.beat, playing: s.playing, bpm: s.bpm,
            frameAudioBeat: s.frameAudioBeat, frameAgeMs: s.frameAgeMs, audioBeat: s.audio.beat, rms: s.audio.rms, voices: s.audio.voices,
            notation: { beat: s.notation.beat, measure: s.notation.measure, scroll: s.notation.scroll, scoreRole: s.notation.scoreRole },
            connectome: s.scene.connectome, runtime: s.neural.runtime, calibrating: s.neural.calibrating,
            replayFrames: s.neural.replayFrames, replayRateBytes: s.neural.replayRateBytes, requestLatencyMs: s.neural.requestLatencyMs,
            updates: s.neural.updates, acceptedCommands: s.neural.acceptedCommands, totalContacts: s.neural.actuator.totalContacts });
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

if (verifySaved) {
  const saved = JSON.parse(await readFile(resolve(raw, "capture-report.json"), "utf8"));
  ({ recording, precheck, sourceHashes, errors, warnings, startedAt, baseURL } = saved);
} else try {
  if (server) { await server.listen(); baseURL = "http://127.0.0.1:5188/simulations/piano/"; }
  browser = await chromium.launch({ channel: "chromium", headless: true, args: [
    "--auto-select-tab-capture-source-by-title=Flythoven", "--enable-usermedia-screen-capturing", "--allow-http-screen-capture",
  ] });
  console.log("Precheck: real neural contacts/audio, zero-state silence, and recovery in a separate session.");
  const checking = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const { page: check } = await preparePage(checking); await startAudit(check);
  await check.locator("#play").click(); await check.waitForTimeout(3000);
  const active = await snapshot(check);
  assert.ok(active.neural.runtime.totalSpikes > 0 && active.neural.predictions > 0);
  assert.ok(active.neural.actuator.totalContacts > 0 && active.audio.performed.length > 0);
  assert.equal(active.scene.connectome.mode, "neural");
  await check.locator("#play").click();
  await check.evaluate(() => window.__flyPiano.silence(true));
  await check.locator('.activity-connectome[data-silenced="true"]').waitFor();
  await check.locator("#play").click(); await check.waitForTimeout(100);
  const silenceStart = await snapshot(check); await check.waitForTimeout(800);
  const silenceEnd = await snapshot(check);
  assert.equal(silenceEnd.neural.actuator.totalContacts, silenceStart.neural.actuator.totalContacts);
  assert.equal(silenceEnd.audio.performed.length, silenceStart.audio.performed.length);
  assert.equal(silenceEnd.neural.runtime.totalSpikes, silenceStart.neural.runtime.totalSpikes);
  assert.ok(silenceEnd.neural.runtime.poolRates.every(rate => rate === 0));
  assert.ok(silenceEnd.scene.legs.every(leg => !leg.contact));
  await check.evaluate(() => window.__flyPiano.silence(false));
  await check.waitForFunction(count => window.__flyPiano.snapshot().neural.actuator.totalContacts > count, silenceEnd.neural.actuator.totalContacts, { timeout: 10000 });
  const recovery = await snapshot(check), audit = await check.evaluate(() => window.__pianoAudit);
  assert.deepEqual(audit.errors, []);
  precheck = { passed: true, beforeSilenceContacts: active.neural.actuator.totalContacts, silenceStartContacts: silenceStart.neural.actuator.totalContacts,
    silenceEndContacts: silenceEnd.neural.actuator.totalContacts, recoveredContacts: recovery.neural.actuator.totalContacts,
    silenceStartSpikes: silenceStart.neural.runtime.totalSpikes, silenceEndSpikes: silenceEnd.neural.runtime.totalSpikes,
    audioIdsChecked: Object.keys(audit.events).length, maxContactError: audit.maxContactError };
  assert.ok(!warnings.some(message => message.includes("Note dropped")), "Audio voice pool dropped a performed note");
  await check.evaluate(() => { window.__pianoAudit.running = false; }); await checking.close();

  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, acceptDownloads: true });
  sourceHashes = await appHashes();
  const { page, toneURL, cold } = await preparePage(context);
  const bootTime = await page.evaluate(() => performance.timeOrigin);
  const scoreBounds = await page.locator("#notation").boundingBox();
  const capture = await page.evaluate(async url => {
    const Tone = await import(url), destination = Tone.getContext().createMediaStreamDestination();
    Tone.getDestination().connect(destination);
    const display = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "browser", frameRate: 30, width: 1920, height: 1080 }, audio: false, preferCurrentTab: true });
    const stream = new MediaStream([...display.getVideoTracks(), ...destination.stream.getAudioTracks()]);
    const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus"].find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error("No tab video/audio capture codec");
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 16000000, audioBitsPerSecond: 192000 }), chunks = [];
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    window.__pianoCapture = { Tone, destination, display, stream, recorder, chunks, mimeType };
    return display.getTracks().map(track => ({ kind: track.kind, settings: track.getSettings() }));
  }, toneURL);
  assert.equal(capture[0].settings.width, 1920); assert.equal(capture[0].settings.height, 1080); assert.equal(capture[0].settings.displaySurface, "browser");
  await startAudit(page);
  console.log(`Recording one continuous ${inferenceSeconds}s cold-session calibration take at ${DEFAULT_BPM} BPM target tempo. Errors are retained.`);
  await page.evaluate(({ inferenceSeconds, leadSeconds, seconds }) => {
    const state = window.__pianoCapture;
    state.finished = new Promise((resolve, reject) => {
      state.recorder.onerror = event => reject(new Error(event.error?.message ?? "MediaRecorder failed"));
      state.recorder.onstop = () => {
        window.__pianoAudit.running = false;
        state.blobURL = URL.createObjectURL(new Blob(state.chunks, { type: state.mimeType })); resolve();
      };
    });
    state.startedAudioSeconds = state.Tone.immediate();
    window.__pianoAudit.started = performance.now(); state.recorder.start(1000);
    setTimeout(() => document.querySelector("#play").click(), leadSeconds * 1000);
    setTimeout(() => document.querySelector("#play").click(), (leadSeconds + inferenceSeconds) * 1000);
    setTimeout(() => state.recorder.stop(), seconds * 1000);
  }, { inferenceSeconds, leadSeconds, seconds });
  await page.evaluate(() => window.__pianoCapture.finished);
  assert.equal(await page.evaluate(() => performance.timeOrigin), bootTime, "Vite reloaded the capture");
  assert.deepEqual(await appHashes(), sourceHashes, "App source changed during the take");
  const pending = page.waitForEvent("download");
  await page.evaluate(() => { const a = document.createElement("a"); a.href = window.__pianoCapture.blobURL; a.download = "capture.webm"; a.click(); });
  await (await pending).saveAs(source);
  recording = await page.evaluate(() => ({ audit: window.__pianoAudit, final: window.__flyPiano.snapshot(), mimeType: window.__pianoCapture.mimeType, startedAudioSeconds: window.__pianoCapture.startedAudioSeconds }));
  Object.assign(recording, { capture, scoreBounds, cold });
  await page.evaluate(() => {
    const s = window.__pianoCapture; s.Tone.getDestination().disconnect(s.destination);
    s.stream.getTracks().forEach(track => track.stop()); URL.revokeObjectURL(s.blobURL);
  });
  await context.close();
} finally { await browser?.close(); await server?.close(); }

if (!verifySaved) await writeFile(resolve(raw, "capture-report.json"), JSON.stringify({ recording, precheck, sourceHashes, errors, warnings, startedAt, baseURL }, null, 2) + "\n");
assert.deepEqual(errors, []); assert.deepEqual(recording.audit.errors, []);
assert.ok(!warnings.some(message => message.includes("Note dropped")), "Audio voice pool dropped a performed note");
const playing = recording.audit.samples.filter(s => s.playing), events = Object.values(recording.audit.events), assessments = Object.values(recording.audit.assessments);
assert.ok(playing.length > 200, "Missing actual inference telemetry");
assert.equal(recording.final.playing, false); assert.ok(playing.every(s => s.calibrating));
assert.ok(playing.some(s => s.rms > 0.001)); assert.ok(Object.values(recording.audit.contactCounts).every(count => count > 0), "A leg had no actual produced contact");
assert.ok(recording.audit.maxSimultaneous >= 2);
for (const s of playing) {
  assert.equal(s.connectome.mode, "neural"); assert.equal(s.notation.scoreRole, "requested");
  assert.ok(Math.abs(s.beat - s.frameAudioBeat) < 0.001); assert.ok(Math.abs(s.notation.beat - s.beat) < 0.001);
  const drift = Math.abs(s.beat - s.audioBeat);
  assert.ok(Math.min(drift, Math.abs(drift - TOTAL_BEATS)) < s.frameAgeMs / 1000 * DEFAULT_BPM / 60 + 0.12);
  assert.ok(s.replayRateBytes <= 264192, "Calibration replay exceeded its memory bound");
}
assert.ok(new Set(playing.map(s => s.notation.measure)).size >= 8 && Math.max(...playing.map(s => s.notation.scroll)) > 100);
assert.ok(new Set(playing.map(s => s.connectome.energy.toFixed(5))).size > 10, "Actual voltage state did not vary");
assert.ok(playing.some(s => s.runtime.spikeCount > 0));
const frameProbe = JSON.parse(run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", source]).stdout);
const timestamps = frameProbe.frames.map(f => Number(f.best_effort_timestamp_time));
const gaps = timestamps.slice(1).flatMap((time, i) => time > 0.5 && time < inferenceSeconds ? [time - timestamps[i]] : []);
assert.ok(gaps.length > (inferenceSeconds - 0.5) * 24); assert.ok(Math.max(...gaps) < 0.25, "Visible gap in source capture");

console.log("Capture complete. Encoding and verifying the same uninterrupted take.");
const loudness = ffmpeg(["-i", source, "-t", String(seconds), "-vn", "-af", "loudnorm=I=-18:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"]);
const match = loudness.stderr.match(/\{\s*"input_i"[\s\S]*?\}/); assert.ok(match);
const measured = JSON.parse(match[0]); assert.ok(Number.isFinite(Number(measured.input_i)));
const audioFilter = `loudnorm=I=-18:TP=-1.5:LRA=11:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true,afade=t=out:st=${seconds - 0.5}:d=0.5`;
ffmpeg(["-i", source, "-t", String(seconds), "-map", "0:v:0", "-map", "0:a:0", "-vf", "fps=30", "-c:v", "libx264", "-preset", "slow", "-crf", "17",
  "-profile:v", "high", "-level:v", "4.1", "-pix_fmt", "yuv420p", "-af", audioFilter, "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart",
  "-metadata", "title=Flythoven - experimental neural calibration",
  "-metadata", `comment=One continuous unselected cold-session capture: 30 seconds of actual neural inference with supervised calibration visible. ${DEFAULT_BPM} BPM requested Fur Elise excerpt, not a faithful rendition. Actual contact-driven synthesized audio and simulated LIF voltage/spikes. Errors retained; global loudness normalization only. Mutopia edition 931.`, mp4]);
// Fixed-in-advance poster time, not selected for a correct phrase or attractive model result.
ffmpeg(["-ss", String(posterSeconds), "-i", mp4, "-frames:v", "1", poster]);
ffmpeg(["-i", mp4, "-vf", "select=isnan(prev_selected_t)+gte(t-prev_selected_t\\,5),scale=640:-1,tile=3x2", "-frames:v", "1", resolve(raw, "contact-sheet.png")]);
const probe = JSON.parse(run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", mp4]).stdout);
const video = probe.streams.find(s => s.codec_type === "video"), audio = probe.streams.find(s => s.codec_type === "audio");
assert.equal(video.codec_name, "h264"); assert.equal(video.pix_fmt, "yuv420p"); assert.equal(video.width, 1920); assert.equal(video.height, 1080); assert.equal(video.avg_frame_rate, "30/1");
assert.equal(audio.codec_name, "aac"); assert.ok(Math.abs(Number(probe.format.duration) - seconds) < 0.15);
const bytes = await readFile(mp4), atoms = [];
for (let offset = 0; offset + 8 <= bytes.length;) {
  const shortSize = bytes.readUInt32BE(offset), type = bytes.toString("ascii", offset + 4, offset + 8);
  const size = shortSize === 1 ? Number(bytes.readBigUInt64BE(offset + 8)) : shortSize === 0 ? bytes.length - offset : shortSize;
  assert.ok(Number.isSafeInteger(size) && size >= 8 && offset + size <= bytes.length);
  atoms.push({ type, offset, size }); offset += size;
}
assert.ok(atoms.find(a => a.type === "moov").offset < atoms.find(a => a.type === "mdat").offset);
ffmpeg(["-v", "error", "-i", mp4, "-f", "null", "-"]);
const levels = ffmpeg(["-i", mp4, "-vn", "-af", "volumedetect", "-f", "null", "-"]).stderr;
const meanDb = Number(levels.match(/mean_volume: ([\d.-]+) dB/)?.[1]); assert.ok(Number.isFinite(meanDb) && meanDb > -35);
const pcm = ffmpeg(["-v", "error", "-i", mp4, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"], null).stdout;
const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4), firstSignal = samples.findIndex(value => Math.abs(value) > 0.001);
assert.ok(firstSignal >= 0); const onset = firstSignal / 48000 + Number(audio.start_time);
const firstScheduled = Math.min(...events.map(event => event.audioTime)) - recording.startedAudioSeconds;
assert.ok(Math.abs(onset - firstScheduled) < 0.15, "Delivered audio onset disagrees with actual event timing");
const b = recording.scoreBounds, crop = { width: Math.floor(b.width), height: Math.floor(b.height) - 4, x: Math.floor(b.x), y: Math.round(b.y) };
const encodedNotation = [1, 5, 10, 15, 20, 25, 29].map(time => {
  const pixels = ffmpeg(["-v", "error", "-ss", String(time), "-i", mp4, "-frames:v", "1", "-vf", `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`, "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], null).stdout;
  assert.equal(pixels.length, crop.width * crop.height * 3); let cursor = { x: -1, count: 0 };
  for (let x = 0; x < crop.width; x++) {
    let count = 0;
    // Chroma subsampling softens a one-pixel cursor. Test its narrow three-pixel band.
    for (let y = 20; y < Math.min(144, crop.height); y++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (x + dx < 0 || x + dx >= crop.width) continue;
        const i = (y * crop.width + x + dx) * 3;
        if (pixels[i] > pixels[i + 1] * 1.18 && pixels[i] > pixels[i + 2] * 1.08 && pixels[i] > 100) { count++; break; }
      }
    }
    if (count > cursor.count) cursor = { x, count };
  }
  assert.ok(cursor.count > crop.height * 0.55, "Encoded requested-score playhead missing");
  return { time, cursorX: cursor.x, cursorPixels: cursor.count };
});
assert.equal(await sha256(legacy.path), legacy.sha256, "Legacy recording was modified");
const outcomes = Object.fromEntries(["on-time", "early", "late", "wrong"].map(outcome => [outcome, assessments.filter(note => note.outcome === outcome).length]));
const report = { passed: true, startedAt, url: baseURL, selection: "Single cold-session continuous take; no selection based on musical accuracy; fixed 10s poster",
  technicalRetake: { reason: "Prior diagnostic take rejected for dropped note bodies at the old 32-voice limit; capacity corrected without policy changes", path: resolve("simulations/piano/verification/neural-recording-audio-capacity-failure") },
  inferenceSeconds, durationSeconds: seconds, targetBpm: DEFAULT_BPM, calibration: true, requestedScore: "Fur Elise, public-domain opening excerpt; target only",
  source: "https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=931", sourceHashes, legacy, precheck, files, bytes: (await stat(mp4)).size,
  model: recording.final.neuralModel, observedContactEvents: events.length, contactCounts: recording.audit.contactCounts, maxSimultaneous: recording.audit.maxSimultaneous,
  maxContactError: recording.audit.maxContactError, audioIdsMatched: events.length, outcomes, passes: recording.audit.passes,
  finalReadoutUpdates: recording.final.neural.updates, replayFrames: recording.final.neural.replayFrames, replayRateBytes: recording.final.neural.replayRateBytes,
  neuralSamples: playing.length, maxRequestLatencyMs: Math.max(...playing.map(s => s.requestLatencyMs)), maxCaptureGapMs: Math.max(...gaps) * 1000,
  renderFps: recording.audit.frames / seconds, maxBodyVoices: Math.max(...playing.map(s => s.voices.body)), audioCapacity: recording.final.audio.voices.capacity,
  originalLoudness: measured, meanDb, decodedAudioOnset: onset, firstScheduledAudioOnset: firstScheduled,
  encodedNotation, atoms, probe, errors, warnings, limitations: "Cold supervised calibration is musically inaccurate. The LIF core uses assumed dynamics and engineered interfaces, not measured brain activity or validated fly cognition. Model time is slower than the wall-clock score. All wrong/late/missed notes remain visible and audible." };
await rename(mp4, files.mp4); await rename(poster, files.poster); probe.format.filename = files.mp4;
await writeFile(resolve(raw, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ ...report, sourceHashes: undefined, probe: { video: video.codec_name, audio: audio.codec_name, width: video.width, height: video.height, duration: probe.format.duration, pixelFormat: video.pix_fmt } }, null, 2));

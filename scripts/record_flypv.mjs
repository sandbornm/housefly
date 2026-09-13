import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const output = resolve("docs/media"), verification = resolve("simulations/flypv/verification");
await mkdir(output, { recursive: true }); await mkdir(verification, { recursive: true });
const raw = await mkdtemp(resolve(verification, "neural-take-"));
const url = process.env.FLYPV_URL ?? "http://127.0.0.1:5173/simulations/flypv/";
const sha256 = async path => createHash("sha256").update(await readFile(path)).digest("hex");
const legacy = resolve(output, "flylot.mp4"), legacyHash = await sha256(legacy);
const duration = 30, posterSecond = 12;
function command(program, args) {
  const result = spawnSync(program, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr);
  return result.stdout;
}
command("ffmpeg", ["-version"]);
const errors = [], warnings = [], states = [], preparation = [];
let source, startOffset, finalState, initialState, startNavigation, navigations = 0;
const browser = await chromium.launch({ channel: "chromium", headless: true });
const snapshot = page => page.evaluate(() => window.__flypv.snapshot());
function linked(state) {
  assert.equal(state.autopilot, true); assert.equal(state.recoveries, 0);
  assert.equal(state.neural.phase, "inference", state.neural.failure);
  assert.equal(state.motorSource, "neural"); assert.equal(state.connectome.mode, "neural");
  assert.equal(state.neural.model.edgeCount, 5536347); assert.equal(state.connectome.nodes, 139662);
  assert.equal(state.neural.frameTick, state.connectome.tick);
  assert.equal(state.appliedFrameTick, state.neural.frameTick);
  assert.equal(state.appliedFeatureHash, state.neural.command.featureHash);
  assert.equal(state.neural.command.readout.tick, state.neural.frameTick);
  assert.equal(state.connectome.simulatedMs, state.neural.simulatedMs);
  assert.deepEqual(state.input, { forward: 0, strafe: 0, lift: 0, yaw: 0 });
}
try {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1,
    recordVideo: { dir: raw, size: { width: 1920, height: 1080 } } });
  const videoBegan = Date.now(), page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() !== "error") return;
    const entry = { message: message.text(), url: message.location().url };
    if (entry.url.endsWith('/favicon.ico') && entry.message.includes('404')) warnings.push(entry);
    else errors.push(JSON.stringify(entry));
  });
  page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations++; });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('#scene[data-ready="true"]').waitFor({ timeout: 90000 });
  await page.locator('.activity-connectome[data-ready="true"][data-mode="neural"]').waitFor({ timeout: 120000 });
  const untrained = await snapshot(page);
  assert.equal(untrained.neural.phase, "uncalibrated"); assert.equal(untrained.motorSource, "none");
  await page.getByRole("button", { name: "Flight settings", exact: true }).click();
  await page.locator("#calibrate").click();
  const deadline = Date.now() + 180000;
  while ((await snapshot(page)).neural.phase === "calibration") {
    const state = await snapshot(page);
    console.log(JSON.stringify({ preparation: "calibration", trials: state.neural.samples, updates: state.neural.updates, latencyMs: state.neural.latencyMs }));
    assert.ok(Date.now() < deadline, "Calibration exceeded preparation deadline");
    await page.waitForTimeout(5000);
  }
  assert.equal((await snapshot(page)).neural.phase, "inference");
  preparation.push({ stage: "calibrated", state: await snapshot(page) });

  // Explicit pre-capture intervention. No resets or motor interventions occur in the take.
  await page.getByRole("button", { name: "Reset flight", exact: true }).click();
  await page.waitForFunction(() => window.__flypv.snapshot().motorSource === "neural");
  linked(await snapshot(page));
  await page.evaluate(() => window.__flypv.silence(true));
  await page.waitForFunction(() => window.__flypv.snapshot().connectome.silenced);
  const silent = await snapshot(page);
  assert.equal(silent.appliedTarget, null); assert.equal(silent.motorSource, "none");
  assert.equal(silent.neural.command.yawRate, 0); assert.equal(silent.neural.spikeCount, 0);
  await page.waitForFunction(start => window.__flypv.snapshot().elapsed > start + .6, silent.elapsed);
  const falling = await snapshot(page);
  assert.equal(falling.appliedTarget, null); assert.equal(falling.neural.spikeCount, 0);
  assert.ok(falling.position.y < silent.position.y - .3, "Ablation must leave gravity active");
  preparation.push({ stage: "ablation", silent, falling });
  console.log(JSON.stringify({ preparation: "ablation passed", neuralSpikes: falling.neural.spikeCount, motorTarget: falling.appliedTarget, fallMeters: silent.position.y - falling.position.y }));
  await page.evaluate(() => window.__flypv.silence(false));
  await page.waitForFunction(() => !window.__flypv.snapshot().connectome.silenced);
  await page.getByRole("button", { name: "Reset flight", exact: true }).click();
  await page.waitForFunction(() => window.__flypv.snapshot().motorSource === "neural");
  await page.locator("#notice").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Follow camera", exact: true }).click();
  await page.getByRole("button", { name: "Flight settings", exact: true }).click();
  await page.mouse.move(1905, 630);
  initialState = await snapshot(page); linked(initialState);
  startNavigation = navigations;
  const began = Date.now(); startOffset = (began - videoBegan) / 1000;
  console.log("CAPTURE START: one continuous 30-second take; source must remain unchanged");
  // Fixed schedule, independent of collisions, actions or goal completion.
  const schedule = [
    { at: 5, run: () => page.getByRole("button", { name: "Close settings", exact: true }).click() },
    { at: 14, run: () => page.getByRole("button", { name: "First person camera", exact: true }).click() },
    { at: 20, run: () => page.getByRole("button", { name: "Orbit camera", exact: true }).click() },
    { at: 26, run: () => page.getByRole("button", { name: "Follow camera", exact: true }).click() },
  ];
  let next = 0, lastLog = -5;
  while (Date.now() - began < duration * 1000) {
    const at = (Date.now() - began) / 1000;
    if (next < schedule.length && at >= schedule[next].at) { await schedule[next++].run(); await page.mouse.move(1905, 630); }
    const state = await snapshot(page);
    linked(state); assert.equal(state.neural.updates, initialState.neural.updates, "No inference-time teacher");
    assert.equal(navigations, startNavigation, "Source reload during capture");
    states.push({ at, state });
    if (at - lastLog >= 5) {
      lastLog = at;
      console.log(JSON.stringify({ captureSeconds: at.toFixed(1), modelMs: state.neural.simulatedMs, worldSeconds: state.elapsed, action: state.neural.command.action, goals: state.activity.waypoints, contacts: state.activity.contacts }));
    }
    await page.waitForTimeout(180);
  }
  finalState = await snapshot(page); linked(finalState);
  // Encoding retains only the fixed take, excluding preparation and this trailing pad.
  await page.waitForTimeout(750);
  const video = page.video();
  await context.close(); source = await video.path();
  console.log("CAPTURE END");
} finally { await browser.close(); }
await writeFile(resolve(raw, "checkpoint.json"), JSON.stringify({ source, startOffset, duration, errors, warnings, preparation, initialState, finalState, states }, null, 2));
assert.deepEqual(errors, []);
assert.ok(finalState.neural.frameTick > initialState.neural.frameTick);
assert.ok(finalState.neural.totalSpikes > initialState.neural.totalSpikes);
assert.ok(finalState.frames > initialState.frames, "World rendering remained live");
assert.equal(await sha256(legacy), legacyHash, "Legacy flylot.mp4 must remain unchanged");
const file = resolve(output, "flylot-neural.mp4"), encoded = resolve(raw, "flylot-neural.mp4");
command("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(startOffset), "-threads", "2", "-i", source,
  "-t", String(duration), "-an", "-vf", "fps=30", "-c:v", "libx264", "-preset", "slow", "-crf", "18",
  "-threads", "2", "-pix_fmt", "yuv420p", "-movflags", "+faststart", encoded]);
command("ffmpeg", ["-v", "error", "-threads", "2", "-i", encoded, "-f", "null", "-"]);
const probe = JSON.parse(command("ffprobe", ["-v", "error", "-show_entries",
  "stream=codec_name,width,height,pix_fmt,r_frame_rate:format=duration,size", "-of", "json", encoded]));
assert.equal(probe.streams[0].codec_name, "h264"); assert.equal(probe.streams[0].width, 1920);
assert.equal(probe.streams[0].height, 1080); assert.equal(probe.streams[0].r_frame_rate, "30/1");
assert.ok(Math.abs(Number(probe.format.duration) - duration) < .1);
const bytes = await readFile(encoded), atoms = [];
for (let offset = 0; offset + 8 <= bytes.length;) {
  const size = bytes.readUInt32BE(offset); assert.ok(size >= 8, "Valid MP4 atom");
  atoms.push(bytes.toString("ascii", offset + 4, offset + 8)); offset += size;
}
assert.ok(atoms.indexOf("moov") >= 0 && atoms.indexOf("moov") < atoms.indexOf("mdat"), "Faststart metadata precedes media");
const poster = resolve(output, "flylot-neural.png");
command("ffmpeg", ["-v", "error", "-y", "-ss", String(posterSecond), "-threads", "2", "-i", encoded, "-frames:v", "1", "-threads", "2", poster]);
await rename(encoded, file);
const report = {
  file, poster, source, url, seed: 8731, duration, posterSecond, startOffset, probe, legacyHash, errors, warnings,
  capture: "One continuous first take after explicit calibration and ablation. Fixed camera schedule; no motor overrides, resets, collision edits, hidden expert or outcome selection during capture.",
  limitations: "Experimental engineered neural interface, not validated fly cognition or innate drone flight. Model and physical clocks differ; encoded 30 fps can duplicate rendered frames. Missed goals, hovering and contacts are retained.",
  preparation, initialState, finalState, states,
  outcome: { worldSeconds: finalState.elapsed - initialState.elapsed, modelMilliseconds: finalState.neural.simulatedMs - initialState.neural.simulatedMs,
    reached: finalState.activity.waypoints, contacts: finalState.activity.contacts, actions: [...new Set(states.map(sample => sample.state.neural.command.action))],
    displacementMeters: Math.hypot(finalState.position.x - initialState.position.x, finalState.position.y - initialState.position.y, finalState.position.z - initialState.position.z) },
};
await writeFile(resolve(verification, "neural-recording.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ file, poster, outcome: report.outcome, probe, legacyPreserved: true }, null, 2));

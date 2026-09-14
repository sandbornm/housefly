import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const output = resolve("docs/media"), verification = resolve("simulations/flysim/verification");
await mkdir(output, { recursive: true }); await mkdir(verification, { recursive: true });
const raw = await mkdtemp(resolve(verification, "neural-take-"));
const url = process.env.FLYSIM_URL ?? "http://127.0.0.1:5180/simulations/flysim/";
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
const snapshot = (page, audit = false) => page.evaluate(audit => {
  const state = window.__flysim.snapshot();
  if (!audit && state.neural) delete state.neural.decisions;
  return state;
}, audit);
function linked(state) {
  assert.equal(state.autopilot, true);
  assert.equal(state.neural.phase, "inference", state.neural.failure);
  assert.equal(state.motorSource, "neural"); assert.equal(state.connectome.mode, "neural");
  assert.equal(state.neural.frameTick, state.connectome.tick);
  assert.equal(state.appliedFrameTick, state.neural.frameTick);
  assert.equal(state.appliedFeatureHash, state.neural.command.featureHash);
  assert.equal(state.neural.command.readout.tick, state.neural.frameTick);
  assert.equal(state.connectome.simulatedMs, state.neural.simulatedMs);
  assert.deepEqual(state.input, { forward: 0, yaw: 0, lift: 0, dash: false });
}
try {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1,
    recordVideo: { dir: raw, size: { width: 1920, height: 1080 } } });
  const videoBegan = Date.now(), page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() !== "error") return;
    const entry = { message: message.text(), url: message.location().url };
    if (entry.url.endsWith("/favicon.ico") && entry.message.includes("404")) warnings.push(entry);
    else errors.push(JSON.stringify(entry));
  });
  page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations++; });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('#scene[data-ready="true"]').waitFor({ timeout: 90000 });
  await page.waitForFunction(() => window.__flysim, undefined, { timeout: 90000 });
  const deadline = Date.now() + 180000;
  while (!["inference", "failed"].includes((await snapshot(page)).neural?.phase)) {
    const state = await snapshot(page);
    console.log(JSON.stringify({ preparation: "load", phase: state.neural?.phase, samples: state.neural?.samples, updates: state.neural?.updates }));
    assert.ok(Date.now() < deadline, "Neural load exceeded preparation deadline");
    await page.waitForTimeout(1000);
  }
  const loaded = await snapshot(page);
  assert.equal(loaded.autopilot, true);
  assert.equal(loaded.neural.phase, "inference", loaded.neural.failure);
  assert.ok(loaded.neural.updates > 0, "Startup restores shipped readout weights");
  await page.locator('.activity-connectome[data-ready="true"][data-mode="neural"]').waitFor({ timeout: 120000 });
  preparation.push({ stage: "loaded", state: await snapshot(page) });

  await page.getByRole("button", { name: "Reset garden", exact: true }).click();
  await page.waitForFunction(() => window.__flysim.snapshot().motorSource === "neural");
  linked(await snapshot(page));
  await page.evaluate(() => window.__flysim.silence(true));
  await page.waitForFunction(() => window.__flysim.snapshot().connectome.silenced);
  const silent = await snapshot(page);
  assert.equal(silent.appliedInput, null); assert.equal(silent.motorSource, "none");
  assert.equal(silent.neural.spikeCount, 0);
  assert.equal(silent.connectome.energy, 0); assert.equal(silent.connectome.active, 0);
  await page.waitForFunction(start => window.__flysim.snapshot().elapsed > start + .6, silent.elapsed);
  const falling = await snapshot(page);
  assert.equal(falling.appliedInput, null); assert.equal(falling.neural.spikeCount, 0);
  preparation.push({ stage: "ablation", silent, falling });
  console.log(JSON.stringify({ preparation: "ablation passed", neuralSpikes: falling.neural.spikeCount, motorInput: falling.appliedInput }));
  await page.evaluate(() => window.__flysim.silence(false));
  await page.waitForFunction(() => !window.__flysim.snapshot().connectome.silenced);
  await page.getByRole("button", { name: "Reset garden", exact: true }).click();
  await page.waitForFunction(() => window.__flysim.snapshot().motorSource === "neural");
  await page.locator("#notice").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Chase camera", exact: true }).click();
  await page.mouse.move(1905, 630);
  initialState = await snapshot(page); linked(initialState);
  startNavigation = navigations;
  const began = Date.now(); startOffset = (began - videoBegan) / 1000;
  console.log("CAPTURE START: one continuous 30-second take; source must remain unchanged");
  const schedule = [
    { at: 12, run: () => page.getByRole("button", { name: "Orbit camera", exact: true }).click() },
    { at: 22, run: () => page.getByRole("button", { name: "Chase camera", exact: true }).click() },
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
      console.log(JSON.stringify({ captureSeconds: at.toFixed(1), modelMs: state.neural.simulatedMs, worldSeconds: state.elapsed, action: state.neural.command.action }));
    }
    await page.waitForTimeout(180);
  }
  finalState = await snapshot(page, true); linked(finalState);
  const decisions = (finalState.neural.decisions ?? []).filter(decision => decision.sequence > initialState.neural.decisionCount);
  if (finalState.neural.decisionCount != null) {
    assert.equal(decisions.length, finalState.neural.decisionCount - initialState.neural.decisionCount, "Complete per-decision evidence");
    assert.ok(decisions.length > 0);
    for (const decision of decisions) {
      let hash = 2166136261;
      const rates = Float32Array.from(decision.rates);
      assert.equal(rates.length, 128);
      for (const bits of new Uint32Array(rates.buffer)) hash = Math.imul(hash ^ bits, 16777619) >>> 0;
      assert.equal(hash, decision.featureHash);
      if (decision.powered) assert.equal(decision.readoutTick, decision.frameTick);
    }
  }
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
const file = resolve(output, "flysim-neural-current.mp4"), encoded = resolve(raw, "flysim-neural-current.mp4");
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
const poster = resolve(output, "flysim-neural-current.png");
command("ffmpeg", ["-v", "error", "-y", "-ss", String(posterSecond), "-threads", "2", "-i", encoded, "-frames:v", "1", "-threads", "2", poster]);
await rename(encoded, file);
const report = {
  file, poster, source, url, seed: 8731, duration, posterSecond, startOffset, probe, errors, warnings,
  capture: "One continuous first take after restoring shipped readout weights and an explicit pre-capture ablation/reset. Neural mode is the startup default. Fixed camera schedule; no motor overrides, resets, or outcome selection during capture.",
  limitations: "Experimental engineered neural interface, not validated fly cognition. Predators are game objects. Model and physical clocks differ; encoded 30 fps can duplicate rendered frames.",
  preparation, initialState, finalState, states,
  outcome: { worldSeconds: finalState.elapsed - initialState.elapsed, modelMilliseconds: finalState.neural.simulatedMs - initialState.neural.simulatedMs,
    actions: [...new Set(states.map(sample => sample.state.neural.command.action))],
    displacementMeters: Math.hypot(finalState.position.x - initialState.position.x, finalState.position.y - initialState.position.y, finalState.position.z - initialState.position.z) },
};
await writeFile(resolve(verification, "neural-recording-current.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ file, poster, outcome: report.outcome, probe }, null, 2));

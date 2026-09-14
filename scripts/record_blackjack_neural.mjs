import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { chromium } from "@playwright/test";

const raw = resolve("test-results/blackjack-neural-recording");
const output = resolve("docs/media");
const files = { video: resolve(output, "housefly-neural-current.mp4"), poster: resolve(output, "housefly-neural-current.png") };
let url;
const seconds = 40;
const viewport = { width: 1920, height: 1080 };
const report = { passed: false, startedAt: new Date().toISOString(), files, seconds,
  selection: "Fixed seed and duration, no outcome selection or manual game actions", audio: false, errors: [], samples: [] };

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${command}: ${result.stderr}`);
  return result.stdout;
}
async function saveReport() { await writeFile(resolve(raw, "report.json"), JSON.stringify(report, null, 2) + "\n"); }
await mkdir(raw, { recursive: true });
await mkdir(output, { recursive: true });
await saveReport();
run("ffmpeg", ["-version"]);
let browser, previewServer;
let source, trimStart, duration;
try {
  if (process.env.DEMO_URL) url = new URL(process.env.DEMO_URL);
  else {
    // Freeze assets for the whole run; concurrent edits must not trigger Vite HMR.
    const { build, preview } = await import("vite");
    const site = resolve(raw,"site");
    await build({configFile:false,base:"/",build:{outDir:site,emptyOutDir:true,rolldownOptions:{input:resolve("index.html")}}});
    previewServer = await preview({configFile:false,build:{outDir:site},preview:{host:"127.0.0.1",port:5178,strictPort:false}});
    url = new URL(previewServer.resolvedUrls.local[0]);
  }
  url.searchParams.set("autoplay", "0");
  url.searchParams.set("seed", "1977");
  report.source = process.env.DEMO_URL ? url.href : "Frozen local production build";
  browser = await chromium.launch({ headless: true });
  // Perform the ablation on a separate page so the recorded run starts fresh.
  const check = await browser.newPage({ viewport });
  check.on("pageerror", error => report.errors.push(error.message));
  await check.goto(url.href);
  await check.waitForFunction(() => window.__housefly?.snapshot().ready, null, { timeout: 120000 });
  assert.equal(await check.evaluate(() => window.__housefly.snapshot().mode), "neural");
  await check.locator("#autoplayButton").click();
  await check.waitForFunction(() => window.__housefly.snapshot().recentDecisions.some(decision => decision.executed), null, { timeout: 60000 });
  await check.evaluate(() => window.__housefly.silence(true));
  await check.waitForFunction(() => {
    const state = window.__housefly.snapshot();
    return state.silenced && state.neural?.spikeCount === 0;
  }, null, { timeout: 15000 });
  const before = await check.evaluate(() => window.__housefly.snapshot());
  await check.waitForTimeout(1000);
  const after = await check.evaluate(() => window.__housefly.snapshot());
  assert.deepEqual(after.recentDecisions, before.recentDecisions, "Silenced controller emitted an action");
  assert.deepEqual(after.game, before.game, "Silenced controller changed the round");
  assert.equal(after.neural.spikeCount, 0);
  report.silence = { passed: true, before, after };
  await check.close();

  const context = await browser.newContext({ viewport, deviceScaleFactor: 1,
    recordVideo: { dir: raw, size: viewport } });
  const page = await context.newPage();
  const oddsRequests = [];
  page.on("request", request => { if (request.url().includes("blackjack.worker")) oddsRequests.push(request.url()); });
  page.on("pageerror", error => report.errors.push(error.message));
  const opened = Date.now();
  await page.goto(url.href);
  await page.waitForFunction(() => window.__housefly?.snapshot().ready, null, { timeout: 120000 });
  await page.locator('#brainCanvas[data-ready="true"]').waitFor();
  assert.equal(await page.evaluate(() => window.__housefly.snapshot().mode), "neural");
  assert.equal(await page.evaluate(() => window.__housefly.snapshot().neural.episodes), 0, "Recorded run must start with an untrained readout");
  const origin = await page.evaluate(() => performance.timeOrigin);
  await page.mouse.move(1910, 1060);
  trimStart = (Date.now() - opened) / 1000;
  await page.locator("#autoplayButton").click();
  const start = Date.now();
  let posterTaken = false;
  while (Date.now() - start < seconds * 1000) {
    await page.waitForTimeout(250);
    const sample = await page.evaluate(() => window.__housefly.snapshot());
    report.samples.push({ elapsed: (Date.now() - start) / 1000, ...sample });
    if (!posterTaken && Date.now() - start >= 6000) {
      await page.screenshot({ path: resolve(raw, "poster.png") });
      posterTaken = true;
    }
  }
  duration = (Date.now() - start) / 1000;
  assert.deepEqual(oddsRequests, [], "Neural run requested an odds decision worker");
  report.layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth,
    traceBottom: document.querySelector("#brainTrace").getBoundingClientRect().bottom }));
  assert.equal(report.layout.overflow, false);
  assert.ok(report.layout.traceBottom < viewport.height, "Decision trace fell below the recorded viewport");
  assert.equal(await page.evaluate(() => performance.timeOrigin), origin, "Page reloaded during recording");
  const video = page.video();
  await context.close();
  source = await video.path();
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await browser?.close();
  if (previewServer) await new Promise(resolveClose => previewServer.httpServer.close(resolveClose));
  await saveReport();
}

assert.deepEqual(report.errors, []);
assert.ok(report.samples.length > 80, "Missing controller telemetry");
assert.ok(report.samples.every(sample => sample.mode === "neural" && sample.ready && !sample.silenced));
const decisions = [...new Map(report.samples.flatMap(sample => sample.recentDecisions)
  .filter(decision => decision.executed).map(decision => [decision.id, decision])).values()];
assert.ok(decisions.length >= 3, "Too few actual neural decisions; no representative recording");
assert.ok(decisions.every(decision => String(decision.source).toLowerCase().includes("neural")
  && decision.tick > 0 && decision.simulatedMs > 0), "Action lacks a completed neural frame");
assert.ok(report.samples.some(sample => sample.neural?.spikeCount > 0), "No recorded model spikes");
const encoded = resolve(raw, "housefly-neural.mp4");
run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-threads", "2", "-ss", String(trimStart), "-i", source,
  "-t", String(seconds), "-an", "-filter_threads", "2", "-vf", "fps=30", "-c:v", "libx264", "-threads", "2", "-preset", "slow",
  "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", encoded]);
run("ffmpeg", ["-v", "error", "-threads", "2", "-i", encoded, "-threads", "2", "-f", "null", "-"]);
const probe = JSON.parse(run("ffprobe", ["-v", "error", "-show_entries",
  "stream=codec_name,width,height,pix_fmt,r_frame_rate:format=duration,size", "-of", "json", encoded]));
assert.equal(probe.streams[0].codec_name, "h264");
assert.equal(probe.streams[0].width, viewport.width);
assert.equal(probe.streams[0].height, viewport.height);
assert.equal(probe.streams[0].pix_fmt, "yuv420p");
assert.equal(probe.streams[0].r_frame_rate, "30/1");
assert.ok(Math.abs(Number(probe.format.duration)-seconds)<0.1, "Recording duration differs from the fixed 40-second interval");
await rename(encoded, files.video);
await rename(resolve(raw, "poster.png"), files.poster);
report.passed = true;
report.probe = probe;
report.decisions = decisions;
report.capturedSeconds = duration;
report.sha256 = createHash("sha256").update(await readFile(files.video)).digest("hex");
await saveReport();
console.log(JSON.stringify({ ...files, decisions: decisions.length, ...probe }, null, 2));

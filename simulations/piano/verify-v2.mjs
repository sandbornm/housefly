import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { DEFAULT_BPM } from "./score.ts";
import { ASSOCIATED_PIANO_ENCODER } from "./sensory-associated.ts";
const output = new URL("./verification/current-browser/", import.meta.url);
await mkdir(output, { recursive: true });
const url = new URL(process.env.PIANO_URL ?? "http://127.0.0.1:5180/simulations/piano/");
assert.equal(url.search, "", "Verify the ordinary default route, not an encoder override");
const artifact = JSON.parse(await readFile(new URL("./calibration-v2.json", import.meta.url), "utf8"));
const browser = await chromium.launch({ channel: "chromium", headless: true }), report = [], errors = [];
const snapshot = page => page.evaluate(() => window.__flyPiano.snapshot());
const ready = page => page.locator('.activity-connectome[data-ready="true"][data-neural-ready="true"]').waitFor({ timeout: 120000 });
const disjoint = (a, b) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
try {
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    page.on("pageerror", error => errors.push(error.message));
    console.log(`Experimental v2 browser check ${viewport.width}x${viewport.height} at ${DEFAULT_BPM} BPM`);
    await page.goto(url.href, { waitUntil: "networkidle" }); await ready(page); await page.locator('#notation[data-ready="true"]').waitFor();
    const initial = await snapshot(page);
    assert.equal(initial.bpm, DEFAULT_BPM); assert.equal(initial.neural.version, "v2"); assert.equal(initial.neural.encoder, ASSOCIATED_PIANO_ENCODER);
    assert.equal(initial.neural.architecture, "pitch-strike-v1"); assert.equal(initial.neural.calibrating, false);
    assert.equal(initial.neural.calibrationSource.kind, "offline-balanced"); assert.equal(initial.neural.updates.length, 12);
    assert.deepEqual(initial.neural.calibrationSource, artifact.provenance);
    assert.match(await page.locator("#status-text").innerText(), /^V2 experimental/);
    await page.locator("#sound-enable").click(); await page.waitForFunction(() => window.__flyPiano.snapshot().audio.ready);
    await page.mouse.move(0, 0);
    await page.evaluate(() => {
      const audit = window.__v2Audit = { baseline: window.__flyPiano.snapshot().neural.actuator.totalContacts, running: true, ids: {}, errors: [], maxError: 0, maxRms: 0, neurons: 0, spikes: 0, frames: 0, first: performance.now() };
      const tick = () => {
        if (!audit.running || !window.__flyPiano) return;
        const s = window.__flyPiano.snapshot(); audit.frames++; audit.maxRms = Math.max(audit.maxRms, s.audio.rms); audit.neurons = s.neural.runtime.nodes; audit.spikes = Math.max(audit.spikes, s.neural.runtime.totalSpikes);
        for (const leg of s.scene.legs) {
          if (!leg.reachable || !leg.joints.flat().every(Number.isFinite)) audit.errors.push(`Invalid IK ${leg.id}`);
          if (!leg.contact || leg.eventId <= audit.baseline) continue;
          const event = s.scene.performed.find(event => event.eventId === leg.eventId), sound = s.audio.performed.find(event => event.eventId === leg.eventId);
          if (!event || event.midi !== leg.midi || event.legId !== leg.id || !(event.neuralTick > 0) || event.requestedNoteIndex !== null) audit.errors.push(`Uncaused contact ${leg.id}`);
          if (!sound || sound.midi !== leg.midi) audit.errors.push(`Audio ID mismatch ${leg.eventId}`);
          audit.maxError = Math.max(audit.maxError, leg.contactError); audit.ids[leg.eventId] = { legId: leg.id, midi: leg.midi };
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.waitForTimeout(11000);
    await page.locator("#play").click(); await page.mouse.move(0, 0); await page.waitForTimeout(120);
    const paused = await snapshot(page); await page.waitForTimeout(250); const frozen = await snapshot(page);
    assert.equal(frozen.beat, paused.beat); assert.equal(frozen.scene.connectome.energy, paused.scene.connectome.energy);
    assert.equal(frozen.scene.connectome.tick, paused.scene.connectome.tick); assert.deepEqual(frozen.scene.legs, paused.scene.legs);
    assert.deepEqual(frozen.neural.updates, initial.neural.updates); assert.equal(frozen.notation.scoreRole, "requested");
    const overlay = await page.locator(".piano-connectome").boundingBox();
    for (const selector of [".masthead", ".player", ".scene-status"]) assert.ok(disjoint(overlay, await page.locator(selector).boundingBox()), `Overlay overlap ${selector}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const colors = await page.locator("#scene").evaluate(canvas => {
      const gl = canvas.getContext("webgl2"), bytes = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4), unique = new Set();
      gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      for (let i = 0; i < bytes.length; i += 400) unique.add(`${bytes[i] >> 3},${bytes[i + 1] >> 3},${bytes[i + 2] >> 3}`); return unique.size;
    });
    assert.ok(colors > 70);
    const audit = await page.evaluate(() => { window.__v2Audit.running = false; return window.__v2Audit; });
    assert.deepEqual(audit.errors, []); assert.ok(audit.maxError < 1e-7); assert.ok(audit.maxRms > 0.001 && audit.spikes > 0 && Object.keys(audit.ids).length > 0);
    const screenshot = new URL(`${viewport.width}x${viewport.height}.png`, output); await page.screenshot({ path: screenshot.pathname, fullPage: true });
    await page.evaluate(() => window.__flyPiano.silence(true)); await page.locator('.activity-connectome[data-silenced="true"]').waitFor();
    await page.locator("#play").click(); const quietStart = await snapshot(page), quietSamples = [];
    for (let sample = 0; sample < 12; sample++) { await page.waitForTimeout(50); quietSamples.push(await snapshot(page)); }
    const quietEnd = quietSamples.at(-1);
    assert.equal(quietEnd.neural.actuator.totalContacts, quietStart.neural.actuator.totalContacts);
    assert.equal(quietEnd.audio.performed.length, quietStart.audio.performed.length);
    assert.equal(quietEnd.neural.acceptedCommands, quietStart.neural.acceptedCommands);
    let previousSpikes = quietStart.neural.runtime.totalSpikes;
    for (const sample of quietSamples) {
      // A score loop resets the cumulative counter, but cannot create a spike.
      assert.ok(sample.neural.runtime.totalSpikes <= previousSpikes); previousSpikes = sample.neural.runtime.totalSpikes;
      assert.equal(sample.neural.runtime.spikeCount, 0); assert.equal(sample.neural.runtime.silenced, true);
      assert.ok(sample.neural.runtime.poolRates.every(rate => rate === 0));
      assert.equal(sample.audio.performed.length, quietStart.audio.performed.length);
      assert.equal(sample.neural.actuator.totalContacts, quietStart.neural.actuator.totalContacts);
      assert.ok(sample.scene.legs.every(leg => !leg.contact));
    }
    report.push({ viewport, screenshot: screenshot.pathname, actualAudioContacts: Object.keys(audit.ids).length,
      legs: Object.fromEntries(["L1", "L2", "L3", "R1", "R2", "R3"].map(id => [id, Object.values(audit.ids).filter(event => event.legId === id).length])),
      maxContactError: audit.maxError, maxRms: audit.maxRms, colors, spikes: audit.spikes, assessment: { ...frozen.neural.assessment, outcomes: undefined, events: undefined },
      pauseFrozen: true, silenceQuiet: true, silenceSamples: quietSamples.map(sample => ({ tick: sample.neural.runtime.tick,
        totalSpikes: sample.neural.runtime.totalSpikes, spikeCount: sample.neural.runtime.spikeCount,
        contacts: sample.neural.actuator.totalContacts, audioEvents: sample.audio.performed.length })), trainingFrozen: true }); await page.close();
  }
  const cold = await browser.newPage(); const coldUrl = new URL(url); coldUrl.searchParams.set("weights", "cold");
  await cold.goto(coldUrl.href); await ready(cold);
  const untrained = await snapshot(cold); assert.equal(untrained.neural.calibrationSource.kind, "cold"); assert.ok(untrained.neural.updates.every(head => head.updates === 0)); await cold.close();
  const bad = await browser.newPage(); await bad.route("**/calibration-v2*.json", route => route.fulfill({ json: { ...artifact, modelId: "incorrect-model" } }));
  await bad.goto(url.href); await bad.waitForFunction(() => window.__flyPiano?.snapshot().neural.status === "unavailable", null, { timeout: 120000 });
  assert.equal((await snapshot(bad)).playing, false); assert.ok((await snapshot(bad)).scene.legs.every(leg => !leg.contact)); await bad.close();
  assert.deepEqual(errors, []);
  await writeFile(new URL("report.json", output), JSON.stringify({ passed: true, url: url.href, bpm: DEFAULT_BPM, defaultController: true,
    provenance: artifact.provenance, report, coldMode: true, incompatibleWeightsFailClosed: true, errors }, null, 2) + "\n");
  console.log(JSON.stringify({ passed: true, report }, null, 2));
} finally { await browser.close(); }

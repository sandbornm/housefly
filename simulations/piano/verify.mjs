import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { DEFAULT_BPM } from "./score.ts";

const output = new URL("./verification/", import.meta.url);
await mkdir(output, { recursive: true });
const baseURL = process.env.PIANO_URL || "http://127.0.0.1:5173/simulations/piano/";
const browser = await chromium.launch({ channel: "chromium", headless: true });
const report = [], errors = [];
const snapshot = page => page.evaluate(() => window.__flyPiano.snapshot());
const range = (page, id, value) => page.locator(`#${id}`).evaluate((input, value) => { input.value = String(value); input.dispatchEvent(new Event("input", { bubbles: true })); }, value);
const disjoint = (a, b) => a.x >= b.x + b.width || a.x + a.width <= b.x || a.y >= b.y + b.height || a.y + a.height <= b.y;

async function pixels(page) {
  return page.locator("#scene").evaluate(canvas => {
    const gl = canvas.getContext("webgl2"), bytes = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
    gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    const sample = [], unique = new Set(); let dark = 0;
    const stride = Math.max(1, Math.floor(bytes.length / 4 / 16000));
    for (let i = 0; i < bytes.length; i += stride * 4) {
      sample.push(bytes[i], bytes[i + 1], bytes[i + 2]);
      unique.add(`${bytes[i] >> 3},${bytes[i + 1] >> 3},${bytes[i + 2] >> 3}`);
      if (bytes[i] + bytes[i + 1] + bytes[i + 2] < 420) dark++;
    }
    return { sample, colors: unique.size, darkFraction: dark / (sample.length / 3) };
  });
}

async function observe(page) {
  await page.addInitScript(() => {
    const probe = window.__pianoProbe = { counts: { L1: 0, L2: 0, L3: 0, R1: 0, R2: 0, R3: 0 }, errors: [], maxContactError: 0, maxSimultaneous: 0,
      audioEvents: 0, frameCount: 0, started: 0, ended: 0 };
    const seen = new Set(); let lastFrame = -1;
    const check = () => {
      const state = window.__flyPiano?.snapshot();
      if (state?.neural.ready && state.scene.frame !== lastFrame) {
        lastFrame = state.scene.frame; probe.frameCount++; probe.started ||= performance.now(); probe.ended = performance.now();
        const contacts = state.scene.legs.filter(leg => leg.contact); probe.maxSimultaneous = Math.max(probe.maxSimultaneous, contacts.length);
        for (const leg of contacts) {
          const note = state.scene.performed.find(note => note.eventId === leg.eventId);
          if (!note || note.midi !== leg.midi || note.legId !== leg.id || note.source !== "neural" || !Number.isFinite(note.neuralTick)) probe.errors.push(`Uncaused contact ${leg.id}:${leg.eventId}`);
          if (!leg.reachable || !leg.joints.flat().every(Number.isFinite) || leg.contactError > 1e-7) probe.errors.push(`Invalid contact ${leg.id}:${leg.contactError}`);
          probe.maxContactError = Math.max(probe.maxContactError, leg.contactError);
          if (!seen.has(leg.eventId)) {
            seen.add(leg.eventId); probe.counts[leg.id]++;
            if (state.audio.ready) {
              const sound = state.audio.performed.find(event => event.eventId === leg.eventId);
              if (!sound || sound.midi !== leg.midi) probe.errors.push(`Audio mismatch ${leg.eventId}`);
              else probe.audioEvents++;
            }
          }
        }
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
}

try {
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 1440, height: 960 }, { width: 390, height: 844 }, { width: 320, height: 640 }, { width: 844, height: 390 }]) {
    console.log(`Checking ${viewport.width}x${viewport.height}`);
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await observe(page);
    await page.goto(baseURL, { waitUntil: "networkidle" });
    await page.locator('.activity-connectome[data-ready="true"][data-neural-ready="true"]').waitFor({ timeout: 120000 });
    await page.locator('#notation[data-ready="true"]').waitFor();
    const boot = await page.evaluate(() => performance.timeOrigin);
    const initial = await snapshot(page), before = await pixels(page);
    assert.equal(initial.bpm, DEFAULT_BPM); assert.equal(initial.totalBeats, 12); assert.equal(initial.audio.ready, false);
    assert.deepEqual([initial.neuralModel.nodes, initial.neuralModel.edges], [139662, 5536347]);
    assert.equal(initial.scene.connectome.mode, "neural"); assert.equal(initial.neural.worker, true);
    assert.ok(before.colors > 70 && before.darkFraction > 0.025, "Blank or poorly framed canvas");
    await page.waitForFunction(() => Object.values(window.__pianoProbe.counts).every(count => count > 0), null, { timeout: 25000 });
    await page.waitForFunction(() => { const s = window.__flyPiano.snapshot(); return s.beat > 3 && s.beat < 11; });
    const after = await pixels(page);
    const changed = after.sample.reduce((total, value, index) => total + (Math.abs(value - before.sample[index]) > 3 ? 1 : 0), 0);
    assert.ok(changed > 8, "The rendered performance is not moving");
    await page.locator("#play").click();
    await page.evaluate(() => scrollTo(0, 0));
    await page.locator('.activity-connectome[data-paused="true"]').waitFor();
    await page.waitForTimeout(80);
    const paused = await snapshot(page);
    await page.waitForTimeout(220);
    const frozen = await snapshot(page);
    assert.equal(frozen.beat, paused.beat); assert.equal(frozen.notation.scroll, paused.notation.scroll);
    assert.deepEqual(frozen.scene.legs, paused.scene.legs); assert.deepEqual(frozen.scene.hover, paused.scene.hover);
    assert.deepEqual(frozen.neural.updates, paused.neural.updates);
    assert.equal(frozen.scene.connectome.energy, paused.scene.connectome.energy);
    assert.equal(frozen.scene.connectome.tick, paused.scene.connectome.tick);
    assert.equal(frozen.scene.connectome.tick, frozen.neural.runtime.tick);
    assert.equal(frozen.notation.scoreRole, "requested"); assert.equal(frozen.notation.beat, frozen.beat);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "Horizontal overflow");
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    for (const id of ["play", "restart", "loop", "mute", "tempo", "volume", "camera-reset", "sound-enable", "calibrate"]) {
      const box = await page.locator(`#${id}`).boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= viewport.width + 1 && box.y >= 0 && box.y + box.height <= height + 1, `${id} is outside the page`);
    }
    const overlay = await page.locator(".piano-connectome").boundingBox();
    assert.ok(overlay.x >= 0 && overlay.y >= 0 && overlay.x + overlay.width <= viewport.width + 1 && overlay.y + overlay.height <= viewport.height + 1);
    for (const selector of [".masthead", ".player", ".scene-tools", ".scene-status"]) assert.ok(disjoint(overlay, await page.locator(selector).boundingBox()), `Overlay overlaps ${selector}`);
    const player = await page.locator(".player").boundingBox();
    for (const leg of frozen.scene.legs) {
      const [x, y] = leg.screen;
      assert.ok(x > 0 && x < viewport.width && y > 80 && y < player.y, `${leg.id} foot is outside the visible scene`);
      assert.ok(disjoint({ x, y, width: 1, height: 1 }, overlay), `${leg.id} foot is hidden by the overlay`);
    }
    const path = fileURLToPath(new URL(`${viewport.width}x${viewport.height}.png`, output));
    await page.screenshot({ path, fullPage: true });
    const probe = await page.evaluate(() => window.__pianoProbe);
    assert.deepEqual(probe.errors, []); assert.ok(probe.maxSimultaneous >= 2);
    report.push({ viewport, screenshot: path, colors: before.colors, changedPixelChannels: changed, contactCounts: probe.counts, maxContactError: probe.maxContactError,
      simultaneousLegs: probe.maxSimultaneous, renderFps: probe.frameCount * 1000 / (probe.ended - probe.started), model: frozen.neuralModel,
      neuralTick: frozen.neural.runtime.tick, requestLatencyMs: frozen.neural.requestLatencyMs, assessment: { ...frozen.neural.assessment, outcomes: undefined, events: undefined } });

    if (viewport.width === 1440) {
      await range(page, "seek", 2.1);
      await page.waitForFunction(() => window.__flyPiano.snapshot().scene.beat === 2.1 && window.__flyPiano.snapshot().neural.runtime.tick === 0);
      assert.equal((await snapshot(page)).notation.beat, 2.1);
      assert.ok((await snapshot(page)).scene.legs.every(leg => !leg.contact), "Seeking must not perform the requested score");
      await range(page, "tempo", 90); assert.equal((await snapshot(page)).bpm, 90);
      await page.locator("#sound-enable").click();
      await page.waitForFunction(() => window.__flyPiano.snapshot().audio.ready);
      assert.equal((await snapshot(page)).playing, false);
      const key = (await snapshot(page)).scene.keys.find(key => key.midi === 72);
      const energy = (await snapshot(page)).scene.connectome.energy;
      await page.mouse.click(key.x, key.y); await page.waitForTimeout(120);
      assert.ok((await snapshot(page)).scene.keys.find(key => key.midi === 72).press > 0.5);
      assert.equal((await snapshot(page)).scene.connectome.energy, energy, "Manual audition fabricated neural activity");
      assert.match((await snapshot(page)).scene.activity.detail, /^Manual: C5/);
      await page.waitForFunction(() => window.__flyPiano.snapshot().audio.rms > 0.00001);
      const audibleRms = (await snapshot(page)).audio.rms;
      await page.locator("#mute").click(); await page.waitForTimeout(150);
      assert.ok((await snapshot(page)).audio.rms < 0.00001);
      await page.locator("#mute").click(); await range(page, "volume", 30);
      await page.locator("#calibrate").uncheck();
      const updates = (await snapshot(page)).neural.updates;
      await page.locator("#play").click();
      await page.waitForFunction(() => window.__pianoProbe.audioEvents > 2, null, { timeout: 20000 });
      const playing = await snapshot(page);
      assert.deepEqual(playing.neural.updates, updates, "Performance mode trained the readout");
      assert.equal(playing.notation.beat, playing.beat); assert.ok(Math.abs(playing.beat - playing.frameAudioBeat) < 0.001);
      await page.locator("#play").click(); await range(page, "seek", 2.1);
      await page.waitForFunction(() => window.__flyPiano.snapshot().scene.beat === 2.1 && window.__flyPiano.snapshot().neural.runtime.tick === 0);
      await page.evaluate(() => window.__flyPiano.silence(true));
      await page.locator('.activity-connectome[data-silenced="true"]').waitFor();
      await page.locator("#play").click();
      const ablated = await snapshot(page); await page.waitForTimeout(500);
      const quiet = await snapshot(page);
      assert.equal(quiet.neural.actuator.totalContacts, ablated.neural.actuator.totalContacts, "Silenced brain produced new notes");
      assert.equal(quiet.neural.runtime.totalSpikes, ablated.neural.runtime.totalSpikes);
      assert.ok(quiet.neural.runtime.poolRates.every(rate => rate === 0));
      assert.ok(quiet.scene.legs.every(leg => !leg.contact));
      await page.evaluate(() => window.__flyPiano.silence(false));
      await page.locator("#loop").click(); await range(page, "seek", 11.9); await page.waitForTimeout(450);
      assert.equal((await snapshot(page)).playing, false); assert.equal((await snapshot(page)).beat, 12);
      await page.locator("#restart").click(); assert.equal((await snapshot(page)).beat, 0);
      await page.locator("#loop").click(); await range(page, "seek", 11.8); await page.locator("#play").click(); await page.waitForTimeout(500);
      assert.ok((await snapshot(page)).beat < 2 && (await snapshot(page)).playing);
      const camera = (await snapshot(page)).scene.camera;
      await page.mouse.move(700, 300); await page.mouse.down(); await page.mouse.move(790, 345, { steps: 5 }); await page.mouse.up();
      assert.ok(Math.hypot(...(await snapshot(page)).scene.camera.map((value, index) => value - camera[index])) > 0.05);
      await page.locator("#camera-reset").click(); await page.waitForTimeout(150);
      assert.ok(Math.hypot(...(await snapshot(page)).scene.camera.map((value, index) => value - camera[index])) < 0.001);
      assert.equal(await page.evaluate(() => performance.timeOrigin), boot, "Vite reloaded the page during verification");
      assert.deepEqual((await page.evaluate(() => window.__pianoProbe)).errors, []);
      report.push({ controls: "pause, seek without autoplay, tempo, manual audio, mute, volume, frozen calibration, neural audio contact, silencing, restart, loop/end, orbit/reset", audibleRms, checkedAudioEvents: (await page.evaluate(() => window.__pianoProbe)).audioEvents });
    }
    await page.close();
  }
  const failed = await browser.newContext();
  await failed.route("**/neural/manifest.json", route => route.fulfill({ status: 503, body: "unavailable" }));
  const page = await failed.newPage(); await page.goto(baseURL);
  await page.waitForFunction(() => window.__flyPiano?.snapshot().neural.status === "unavailable", null, { timeout: 30000 });
  assert.ok((await snapshot(page)).scene.legs.every(leg => !leg.contact));
  assert.equal((await snapshot(page)).audio.ready, false); assert.equal((await snapshot(page)).playing, false);
  report.push({ failedModel: "No autonomous keys, sound, or synthetic overlay fallback" }); await failed.close();
  assert.deepEqual(errors, []);
  await writeFile(new URL("report.json", output), JSON.stringify({ passed: true, report, errors }, null, 2) + "\n");
  console.log(JSON.stringify({ passed: true, report, errors }, null, 2));
} finally { await browser.close(); }

import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const output = fileURLToPath(new URL('./verification/', import.meta.url));
const base = process.env.FLYOUT_URL ?? 'http://127.0.0.1:5186/simulations/flyout/';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const report = { errors: [], layouts: [] };
page.on('pageerror', error => report.errors.push(error.message));
const state = () => page.evaluate(() => window.__flyout);

async function layout() {
  return page.evaluate(() => {
    const rect = selector => {
      const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
      return { x, y, width, height };
    };
    const canvas = document.querySelector('#field'), gl = canvas.getContext('webgl2');
    const ratio = gl.drawingBufferWidth / canvas.clientWidth;
    const pixels = box => {
      const width = Math.floor(box.width * ratio), height = Math.floor(box.height * ratio);
      const data = new Uint8Array(width * height * 4);
      gl.readPixels(Math.round(box.x * ratio), Math.round((canvas.clientHeight - box.y - box.height) * ratio),
        width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
      let lit = 0, dark = 0;
      for (let i = 0; i < data.length; i += 4) {
        const sum = data[i] + data[i + 1] + data[i + 2];
        if (sum > 150) lit++; if (sum < 100) dark++;
      }
      return { lit, dark, error: gl.getError() };
    };
    const mini = window.__flyout.activity.miniature;
    const miniature = { x: mini.x - mini.width / 2, y: mini.y - mini.height / 2, width: mini.width, height: mini.height };
    return { width: innerWidth, height: innerHeight,
      boxes: ['.roster', '.flyout-connectome', '.controls', '.play-status'].map(rect), miniature,
      fullPixels: pixels(rect('.connectome-viewport')), miniPixels: pixels(miniature),
      calls: window.__flyout.renderer.calls, overflow: document.documentElement.scrollWidth > innerWidth,
      channelsOverflow: [...document.querySelectorAll('.connectome-channel')].some(node => node.scrollWidth > node.clientWidth) };
  });
}

const overlap = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
function checkLayout(value) {
  assert.equal(value.overflow, false); assert.equal(value.channelsOverflow, false);
  for (const [i, box] of value.boxes.entries()) {
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= value.width + 1 && box.y + box.height <= value.height + 1);
    for (const other of value.boxes.slice(i + 1)) assert.equal(overlap(box, other), false, 'UI regions do not collide');
    assert.equal(overlap(box, value.miniature), false, 'Brain instrument clears UI');
  }
  assert.ok(value.fullPixels.lit > 100 && value.miniPixels.lit > 100, 'Both anatomy views render');
  assert.ok(value.miniPixels.dark > 100, 'Miniature has a dark backing');
  assert.equal(value.fullPixels.error, 0); assert.equal(value.miniPixels.error, 0);
  assert.ok(value.miniature.width >= (value.width <= 700 ? 63 : 107));
  assert.ok(value.calls < 450);
}

try {
  await page.goto(`${base}?seed=7193`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#field[data-ready="true"]');
  await page.waitForFunction(() => ['ready', 'error'].includes(window.__flyout?.neural?.state), undefined, { timeout: 120000 });
  assert.equal((await state()).neural.state, 'ready', (await state()).neural.label);
  await page.waitForSelector('.activity-connectome[data-neural-ready="true"]', { timeout: 30000 });
  report.workers = page.workers().map(worker => worker.url());
  assert.equal(report.workers.filter(url => url.includes('/src/neural/worker.ts')).length, 1, 'One common neural worker (Tone also has an audio clock)');
  assert.equal(await page.locator('canvas').count(), 1, 'One shared WebGL canvas');
  assert.equal(await page.locator('.activity-connectome').count(), 1);
  await page.waitForFunction(() => window.__flyout.neural.actors.every(actor => actor.totalSpikes > 0));
  const sampleStarted = performance.now(), start = await state();
  assert.equal(start.neural.actors.length, 10); assert.equal(start.neural.edgeCount, 5536347);
  assert.equal(start.activity.connectome.mode, 'neural'); assert.equal(start.activity.connectome.nodes, 139662);
  assert.equal(start.activity.connectome.tick, start.neural.actors[start.activity.neuralActor].tick);
  await page.waitForTimeout(1500);
  const moved = await state();
  assert.ok(moved.neural.actors.every(actor => actor.totalSpikes > 0));
  assert.ok(new Set(moved.neural.actors.map(actor => actor.totalSpikes)).size > 1, 'Independent neural states differ');
  assert.notDeepEqual(moved.fielders, start.fielders, 'Actual decoded outputs move fielders');
  report.clocks = { wallSampleMs: performance.now() - sampleStarted, worldDeltaMs: moved.neural.worldMs - start.neural.worldMs,
    actorDeltaMs: moved.neural.actors.map((actor, i) => actor.simulatedMs - start.neural.actors[i].simulatedMs),
    batchWallMs: moved.neural.wallMs, physicsSteps: moved.physicsSteps - start.physicsSteps,
    renderedFrames: moved.renderedFrames - start.renderedFrames };
  assert.ok(report.clocks.physicsSteps > 0 && report.clocks.renderedFrames >= 3, 'World continues advancing while the worker computes');
  report.calibration = moved.neural.calibration;
  console.log('Measured real neural frames and world clocks.');

  await page.locator('#pause').click();
  await page.waitForFunction(() => document.querySelector('.activity-connectome').dataset.paused === 'true');
  const paused = await state();
  await page.waitForTimeout(500);
  const frozen = await state();
  assert.equal(frozen.physicsSteps, paused.physicsSteps);
  assert.equal(frozen.activity.connectome.energy, paused.activity.connectome.energy);
  assert.equal(frozen.activity.connectome.tick, paused.activity.connectome.tick);
  assert.deepEqual(frozen.neural.actors, paused.neural.actors, 'Late worker results cannot alter paused display/commands');
  report.pause = { tick: paused.activity.connectome.tick, energy: paused.activity.connectome.energy, stable: true };
  await page.locator('#resume').click();

  // These are observed neural failures/successes, not a requirement for competent play.
  await page.locator('#autoplay').check();
  await page.waitForFunction(() => window.__flyout.phase === 'result', undefined, { timeout: 15000 });
  report.neuralPlay = await state();
  assert.equal(report.neuralPlay.activity.neuralActor, 9);
  assert.equal(report.neuralPlay.activity.connectome.tick, report.neuralPlay.neural.actors[9].tick);
  assert.ok(report.neuralPlay.neural.applied.some(action => action.actor === 9), 'Batter actually applied a neural decision');
  assert.ok(report.neuralPlay.neural.applied.every(action => action.tick === action.frameTick && action.command.tick === action.tick
    && action.spikes > 0 && action.command.source === 'neural'), 'Every applied action matches its measured source frame');
  report.actionFrameMatching = report.neuralPlay.neural.applied;
  await page.locator('#autoplay').uncheck();

  await page.locator('#silence-neural').check();
  await page.waitForFunction(() => window.__flyout.neural.actors.every(actor => actor.silenced), undefined, { timeout: 10000 });
  await page.locator('#action').click();
  await page.waitForFunction(() => window.__flyout.phase === 'pitch');
  const quiet = await state();
  await page.waitForTimeout(250);
  const physics = await state();
  assert.ok(physics.physicsSteps > quiet.physicsSteps); assert.notDeepEqual(physics.ball, quiet.ball);
  assert.deepEqual(physics.fielders, quiet.fielders, 'Silencing removes all autonomous fielder movement');
  assert.ok(physics.neural.actors.every(actor => actor.command.x === 0 && actor.command.z === 0
    && !actor.command.reach && !actor.command.swing && actor.command.throwBase === 0 && actor.spikes === 0));
  report.ablation = { physicsSteps: physics.physicsSteps - quiet.physicsSteps, ballMoved: true, fieldersFrozen: true };
  console.log('Pause, action-frame matching, and live silencing passed.');

  await page.locator('#silence-neural').uncheck();
  await page.locator('#reset').click();
  await page.waitForFunction(() => window.__flyout.neural.actors.every(actor => actor.totalSpikes > 0 && !actor.silenced));
  await page.locator('#auto-field').uncheck();
  for (const [width, height] of [[1920, 1080], [390, 844], [320, 640]]) {
    await page.setViewportSize({ width, height }); await page.waitForTimeout(600);
    const measured = await layout(); report.layouts.push(measured);
    await page.screenshot({ path: `${output}neural-${width}.png` }); checkLayout(measured);
  }

  const unavailable = await browser.newPage();
  unavailable.on('pageerror', error => report.errors.push(error.message));
  await unavailable.route('**/calibration.json', route => route.abort());
  await unavailable.goto(base, { waitUntil: 'domcontentloaded' });
  await unavailable.waitForFunction(() => window.__flyout?.neural?.state === 'error');
  assert.ok(await unavailable.locator('#autoplay').isDisabled());
  assert.ok(await unavailable.locator('#auto-field').isDisabled());
  await unavailable.locator('#action').click();
  await unavailable.waitForFunction(() => window.__flyout.phase === 'pitch' && window.__flyout.phaseTime > .15);
  report.failClosed = { disabledAutonomy: true, manualPhysics: true, error: await unavailable.locator('#neural-status').getAttribute('title') };
  await unavailable.close();
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify({ ...report, neuralPlay: { lastEvent: report.neuralPlay.lastEvent,
    activity: report.neuralPlay.activity.label, frame: report.neuralPlay.activity.connectome } }, null, 2));
} catch (error) {
  report.failure = String(error); report.state = await state().catch(() => null);
  await page.screenshot({ path: `${output}neural-failure.png` });
  throw error;
} finally {
  await writeFile(`${output}neural-report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}

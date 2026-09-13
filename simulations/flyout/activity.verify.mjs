import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const output = fileURLToPath(new URL('./verification/', import.meta.url));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
page.on('requestfailed', request => console.error(`${request.url()}: ${request.failure()?.errorText}`));
const base = process.env.FLYOUT_URL ?? 'http://127.0.0.1:5173/simulations/flyout/';
const report = { layouts: [], events: [], errors };

async function state() { return page.evaluate(() => window.__flyout); }

async function layout() {
  return page.evaluate(() => {
    const rect = selector => {
      const { x, y, width, height, right, bottom } = document.querySelector(selector).getBoundingClientRect();
      return { x, y, width, height, right, bottom };
    };
    const canvas = document.querySelector('#field');
    const gl = canvas.getContext('webgl2');
    const ratio = gl.drawingBufferWidth / canvas.clientWidth;
    const pixels = box => {
      const width = Math.floor(box.width * ratio), height = Math.floor(box.height * ratio);
      const data = new Uint8Array(width * height * 4);
      gl.readPixels(Math.round(box.x * ratio), Math.round((canvas.clientHeight - box.y - box.height) * ratio),
        width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
      let lit = 0, dark = 0, hash = 0;
      for (let i = 0; i < data.length; i += 4) {
        const [r, g, b] = data.subarray(i, i + 3);
        if (r + g + b > 150) lit++;
        if (r + g + b < 100) dark++;
        hash = (Math.imul(hash, 31) + r + g * 3 + b * 7) >>> 0;
      }
      return { lit, dark, hash, error: gl.getError() };
    };
    const mini = window.__flyout.activity.miniature;
    const miniature = { x: mini.x - mini.width / 2, y: mini.y - mini.height / 2, width: mini.width, height: mini.height };
    return { width: innerWidth, height: innerHeight, roster: rect('.roster'), panel: rect('.flyout-connectome'),
      controls: rect('.controls'), status: rect('.play-status'), miniature,
      fullPixels: pixels(rect('.connectome-viewport')), miniPixels: pixels(miniature),
      fieldPixels: window.__flyout.fieldPixels, calls: window.__flyout.renderer.calls,
      overflow: document.documentElement.scrollWidth > innerWidth,
      channelsOverflow: [...document.querySelectorAll('.connectome-channel')].some(node => node.scrollWidth > node.clientWidth),
    };
  });
}

function overlap(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function checkLayout(value) {
  assert.equal(value.overflow, false);
  assert.equal(value.channelsOverflow, false, 'All four channel names fit');
  const boxes = [value.roster, value.panel, value.controls, value.status];
  for (const [i, box] of boxes.entries()) {
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= value.width + 1 && box.y + box.height <= value.height + 1, 'UI stays in viewport');
    for (const other of boxes.slice(i + 1)) assert.equal(overlap(box, other), false, 'UI regions do not collide');
    for (const p of value.fieldPixels) assert.equal(overlap(box, { x: p.x - 7, y: p.y - 7, width: 14, height: 14 }), false, 'UI clears every fielder');
    assert.equal(overlap(box, value.miniature), false, 'Miniature clears the UI');
  }
  assert.ok(value.fullPixels.lit > 100 && value.miniPixels.lit > 100, 'Full and miniature anatomy produce visible pixels');
  assert.ok(value.miniPixels.dark > 100, 'Miniature has a dark backing');
  assert.equal(value.fullPixels.error, 0); assert.equal(value.miniPixels.error, 0);
  assert.ok(value.miniature.width >= (value.width <= 700 ? 63 : 107), 'Miniature stays readable at each viewport');
  assert.ok(value.calls < 450, `Draw calls remain bounded (${value.calls})`);
}

try {
  await page.goto(`${base}?seed=7193`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#field[data-ready="true"]', { timeout: 30000 });
  await page.waitForSelector('.flyout-connectome[data-ready="true"]', { timeout: 30000 });
  await page.waitForTimeout(900);
  const initial = await state();
  assert.equal(initial.activity.connectome.nodes, 139662); assert.equal(initial.activity.connectome.edges, 60000);
  assert.equal(await page.locator('.activity-connectome').count(), 1);
  assert.equal(await page.locator('canvas').count(), 1, 'One WebGL canvas');
  for (const [width, height] of [[1920, 1080], [1440, 1000], [1024, 768], [768, 1024], [390, 844], [375, 667], [320, 640]]) {
    await page.setViewportSize({ width, height }); await page.waitForTimeout(1000);
    const measured = await layout(); report.layouts.push(measured);
    await page.screenshot({ path: `${output}activity-${width}.png` });
    checkLayout(measured);
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.locator('#autoplay').check();
  await page.waitForFunction(() => window.__flyout.phase === 'pitch' && window.__flyout.phaseTime > .25);
  let current = await state(); report.events.push(current.activity);
  assert.equal(current.activity.actor, -1); assert.match(current.activity.signal.label, /Ruby.*Tracking pitch/);
  await page.waitForFunction(() => window.__flyout.phase === 'live' && window.__flyout.phaseTime < .4);
  current = await state(); report.events.push(current.activity);
  assert.equal(current.activity.actor, -1); assert.match(current.activity.signal.label, /Contact/);
  assert.ok(current.activity.signal.motor > .9);
  const chasing = await page.waitForFunction(() => {
    const current = window.__flyout;
    return current.phase === 'live' && current.phaseTime > .6 ? current : false;
  });
  current = await chasing.jsonValue(); report.events.push(current.activity);
  await page.locator('#autoplay').uncheck();
  assert.match(current.activity.signal.label, /Tracking fly ball|Fielding grounder/);
  assert.equal(current.activity.actor, current.activity.chaser);
  assert.deepEqual(current.activity.position, [current.fielders[current.activity.actor].x, 0, current.fielders[current.activity.actor].z]);
  await page.screenshot({ path: `${output}activity-fielding.png` });
  await page.locator('#pause').click();
  await page.waitForFunction(() => document.querySelector('.activity-connectome').dataset.paused === 'true');
  const stopped = await state(), frozenPixels = (await layout()).miniPixels.hash;
  await page.waitForTimeout(350);
  const frozen = await state();
  assert.equal(frozen.physicsSteps, stopped.physicsSteps);
  assert.equal(frozen.activity.connectome.energy, stopped.activity.connectome.energy, 'Pause freezes excitation');
  assert.deepEqual(frozen.activity.signal, stopped.activity.signal, 'Pause freezes event drive');
  assert.equal((await layout()).miniPixels.hash, frozenPixels, 'Pause freezes miniature pixels');
  await page.locator('#resume').click();
  await page.waitForFunction(() => !window.__flyout.activity.connectome.paused);
  await page.waitForFunction(() => window.__flyout.phase === 'result');
  current = await state(); report.events.push(current.activity);
  if (current.catches) {
    assert.ok(current.activity.actor >= 0); assert.match(current.activity.signal.label, /Catch/);
    assert.ok(current.activity.signal.reward > 0);
  }
  assert.deepEqual(errors, []);
  await writeFile(`${output}activity-report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ layouts: report.layouts.map(({ width, height, calls, miniPixels }) => ({ width, height, calls, miniPixels })),
    events: report.events.map(event => event.signal.label), errors }, null, 2));
} catch (error) {
  await page.screenshot({ path: `${output}activity-failure.png` });
  console.error(JSON.stringify({ ...report, loading: await page.locator('#loading').textContent() }, null, 2));
  throw error;
} finally { await browser.close(); }

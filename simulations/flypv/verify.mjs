import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const destination = fileURLToPath(new URL('./verification/', import.meta.url));
await mkdir(destination, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [];
const results = [];
const mobileOnly = process.env.FLYPV_VERIFY_ONLY === 'mobile';
const url = process.env.FLYPV_URL || 'http://127.0.0.1:5173/simulations/flypv/';
const snapshot = page => page.evaluate(() => window.__flypv.snapshot());
const connectomePixels = page => page.evaluate(() => {
  const canvas = document.querySelector('#scene'), rect = document.querySelector('.flypv-connectome .connectome-viewport').getBoundingClientRect();
  const gl = canvas.getContext('webgl2'), scale = gl.drawingBufferWidth / canvas.clientWidth;
  const width = Math.floor(rect.width * scale), height = Math.floor(rect.height * scale), data = new Uint8Array(width * height * 4);
  gl.readPixels(Math.floor(rect.left * scale), Math.floor((canvas.clientHeight - rect.bottom) * scale), width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
  let lit = 0, hash = 2166136261;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] + data[i + 1] + data[i + 2] > 150) lit++;
    hash = Math.imul(hash ^ (data[i] + data[i + 1] * 257 + data[i + 2] * 65537), 16777619) >>> 0;
  }
  return { lit, hash, width, height };
});
const overlayLayout = page => page.evaluate(() => {
  const panel = document.querySelector('.flypv-connectome').getBoundingClientRect();
  const overlaps = [...document.querySelectorAll('.tools, #settings, #map-panel, .flight-console, .stick')].filter(element => {
    const rect = element.getBoundingClientRect();
    return rect.width && rect.height && panel.left < rect.right && panel.right > rect.left && panel.top < rect.bottom && panel.bottom > rect.top;
  }).map(element => element.id || element.className);
  return { overlaps, box: { x: panel.x, y: panel.y, width: panel.width, height: panel.height }, fits: panel.left >= 0 && panel.top >= 0 && panel.right <= innerWidth && panel.bottom <= innerHeight };
});
const pixels = page => page.evaluate(() => {
  const canvas = document.querySelector('#scene');
  const gl = canvas.getContext('webgl2');
  const data = new Uint8Array(48 * 48 * 4);
  // Sample the center scene in a regular grid so both terrain and sky contribute.
  let hash = 2166136261, sum = 0, squared = 0, count = 0;
  const colors = new Set();
  for (let gy = 1; gy <= 4; gy++) for (let gx = 1; gx <= 4; gx++) {
    gl.readPixels(Math.floor(gl.drawingBufferWidth * gx / 5), Math.floor(gl.drawingBufferHeight * gy / 5), 48, 48, gl.RGBA, gl.UNSIGNED_BYTE, data);
    for (let i = 0; i < data.length; i += 16) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const brightness = (r + g + b) / 3; sum += brightness; squared += brightness * brightness; count++;
      colors.add(`${r >> 3},${g >> 3},${b >> 3}`);
      hash = Math.imul(hash ^ (r + g * 257 + b * 65537), 16777619) >>> 0;
    }
  }
  return { hash, unique: colors.size, mean: sum / count, variance: squared / count - (sum / count) ** 2, width: gl.drawingBufferWidth, height: gl.drawingBufferHeight };
});
const inspect = async (page, name) => {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const sample = await pixels(page);
  assert.ok(sample.unique > 45, `${name}: nonblank scene colors`);
  assert.ok(sample.variance > 140, `${name}: nonblank scene variance`);
  const brain = await connectomePixels(page), layout = await overlayLayout(page), state = await snapshot(page);
  await page.mouse.move(1, 1);
  await page.screenshot({ path: `${destination}${name}.png` });
  assert.ok(brain.lit > 150, `${name}: visible connectome pixels`);
  assert.equal(state.connectome.nodes, 139662); assert.equal(state.connectome.edges, 60000);
  assert.equal(state.connectome.mode, 'neural'); assert.equal(state.neural.model.edgeCount, 5536347);
  assert.equal(layout.fits, true, `${name}: overlay fits viewport`);
  assert.deepEqual(layout.overlaps, [], `${name}: overlay avoids controls ${JSON.stringify(layout.box)}`);
  results.push({ name, pixels: sample, connectomePixels: brain, layout, state });
  return sample;
};
const makePage = async options => {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#scene')?.dataset.ready === 'true', null, { timeout: 90000 });
  await page.locator('.activity-connectome[data-ready="true"][data-mode="neural"]').waitFor({ timeout: 120000 });
  assert.match(await page.title(), /^Flylot/);
  const basePath = new URL(url).pathname.split('/simulations/')[0];
  assert.equal(await page.locator('#all-demos').getAttribute('href'), `${basePath}/`);
  return { page, context };
};

const frameLink = state => {
  assert.equal(state.neural.phase, 'inference', state.neural.failure);
  assert.equal(state.motorSource, 'neural');
  assert.equal(state.appliedFrameTick, state.neural.frameTick);
  assert.equal(state.connectome.tick, state.neural.frameTick);
  assert.equal(state.connectome.simulatedMs, state.neural.simulatedMs);
  assert.equal(state.appliedFeatureHash, state.neural.command.featureHash);
  assert.equal(state.neural.command.readout.tick, state.neural.frameTick);
};
const calibrate = async page => {
  const before = await snapshot(page);
  assert.equal(before.neural.phase, 'uncalibrated'); assert.equal(before.motorSource, 'none');
  await page.getByRole('button', { name: 'Flight settings', exact: true }).click();
  await page.locator('#calibrate').click();
  const deadline = Date.now() + 120000;
  while (!['inference', 'failed'].includes((await snapshot(page)).neural?.phase)) {
    const progress = await snapshot(page);
    console.log(JSON.stringify({ progress: { phase: progress.neural.phase, samples: progress.neural.samples, busy: progress.neural.busy, latency: progress.neural.latencyMs, elapsed: progress.elapsed, frames: progress.frames, paused: progress.paused, hidden: await page.evaluate(() => document.hidden) } }));
    if (Date.now() > deadline) {
      await page.screenshot({ path: destination + 'calibration-timeout.png' });
      throw new Error('Worker calibration timed out: ' + JSON.stringify(progress.neural));
    }
    await page.waitForTimeout(10000);
  }
  const trained = await snapshot(page);
  assert.equal(trained.neural.phase, 'inference', trained.neural.failure);
  assert.equal(trained.neural.samples, 84); assert.ok(trained.neural.updates > 84);
  assert.ok(trained.elapsed > before.elapsed + 1, 'Physics progresses during worker calibration');
  assert.ok(trained.frames > before.frames + 20, 'Rendering progresses during worker calibration');
  console.log(JSON.stringify({ calibration: { loss: trained.neural.lastLoss, updates: trained.neural.updates, worldSeconds: trained.elapsed - before.elapsed, frames: trained.frames - before.frames } }));
  await page.getByRole('button', { name: 'Reset flight', exact: true }).click();
  await page.waitForFunction(() => window.__flypv.snapshot().motorSource === 'neural');
  frameLink(await snapshot(page));
  return trained.neural.updates;
};

try {
  if (!mobileOnly) {
    const { page, context } = await makePage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    assert.equal((await snapshot(page)).audioState, 'uninitialized');
    const updates = await calibrate(page);
    await inspect(page, 'desktop-neural-follow');
    const before = await snapshot(page); await page.waitForTimeout(1200);
    const after = await snapshot(page); frameLink(after);
    assert.ok(after.neural.frameTick > before.neural.frameTick);
    assert.ok(after.elapsed > before.elapsed + .5);
    assert.equal(after.neural.updates, updates, 'No inference-time teacher updates');
    assert.ok(after.neural.simulatedMs < after.elapsed * 1000, 'Model and world clocks are distinct');
    await page.getByRole('button', { name: 'First person camera', exact: true }).click();
    await inspect(page, 'desktop-neural-fpv');
    await page.getByRole('button', { name: 'Orbit camera', exact: true }).click();
    await inspect(page, 'desktop-neural-orbit');
    await page.getByRole('button', { name: 'Pause flight', exact: true }).click();
    await page.locator('.flypv-connectome[data-paused="true"]').waitFor();
    const stopped = await snapshot(page), brain = await connectomePixels(page);
    await page.waitForTimeout(400);
    const still = await snapshot(page);
    assert.deepEqual(still.position, stopped.position);
    assert.deepEqual(still.connectome, stopped.connectome, 'Paused accepted neural frame freezes');
    assert.deepEqual(still.neural.command, stopped.neural.command);
    assert.equal(still.neural.simulatedMs, stopped.neural.simulatedMs);
    assert.equal((await connectomePixels(page)).hash, brain.hash, 'Paused neural pixels freeze');
    await page.getByRole('button', { name: 'Resume flight', exact: true }).click();
    await page.getByRole('button', { name: 'Reset flight', exact: true }).click();
    await page.getByRole('button', { name: 'Flight settings', exact: true }).click();
    await page.locator('#neural-silenced').check();
    await page.waitForFunction(() => window.__flypv.snapshot().connectome.silenced);
    const silent = await snapshot(page);
    assert.equal(silent.motorSource, 'none'); assert.equal(silent.appliedTarget, null);
    assert.equal(silent.neural.command.yawRate, 0); assert.equal(silent.neural.spikeCount, 0);
    await page.waitForTimeout(450);
    const falling = await snapshot(page);
    assert.ok(falling.elapsed > silent.elapsed + .2);
    assert.ok(falling.position.y < silent.position.y - .2, 'Silenced physics falls instead of hovering or teleporting');
    assert.equal(falling.heading, silent.heading);
    await inspect(page, 'desktop-silenced-settings');
    await page.locator('#neural-silenced').uncheck();
    await page.getByRole('button', { name: 'Reset flight', exact: true }).click();
    await page.locator('#scene').focus(); await page.keyboard.down('w'); await page.waitForTimeout(850); await page.keyboard.up('w');
    const manual = await snapshot(page);
    assert.equal(manual.autopilot, false); assert.equal(manual.motorSource, 'manual'); assert.ok(manual.position.z < 28);
    await page.keyboard.down('Space'); await page.waitForTimeout(700); await page.keyboard.up('Space');
    assert.ok((await snapshot(page)).position.y > manual.position.y + .4);
    await page.keyboard.down('q'); await page.waitForTimeout(500); await page.keyboard.up('q');
    assert.ok((await snapshot(page)).heading > .3);
    await page.getByRole('button', { name: 'Flight settings', exact: true }).click();
    await page.locator('#speed').fill('12'); await page.locator('#sensitivity').fill('1.5');
    assert.equal(await page.locator('#speed-value').textContent(), '12 m/s');
    await page.locator('#map-visible').uncheck(); assert.equal(await page.locator('#map-panel').isVisible(), false);
    await page.locator('#map-visible').check();
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await page.getByRole('button', { name: 'Enable rotor sound', exact: true }).click();
    assert.equal((await snapshot(page)).sound, true);
    await page.getByRole('button', { name: 'Mute rotor sound', exact: true }).click();
    assert.equal((await snapshot(page)).neural.updates, updates);
    await context.close();
  }

  const mobile = await makePage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1.5, isMobile: true, hasTouch: true });
  await calibrate(mobile.page);
  await inspect(mobile.page, 'mobile-neural-follow');
  await mobile.page.getByRole('button', { name: 'Flight settings', exact: true }).click();
  await inspect(mobile.page, 'mobile-neural-settings');
  await mobile.page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await mobile.page.getByRole('button', { name: 'Reset flight', exact: true }).click();
  await mobile.page.locator('#autopilot').click();
  assert.equal(await mobile.page.locator('#touch-controls').isVisible(), true);
  const rect = await mobile.page.locator('#move-stick').boundingBox();
  const session = await mobile.context.newCDPSession(mobile.page);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: rect.x + rect.width / 2, y: rect.y + 16 }] });
  const before = await snapshot(mobile.page); await mobile.page.waitForTimeout(900);
  assert.ok((await snapshot(mobile.page)).position.z < before.position.z - 1);
  assert.equal((await snapshot(mobile.page)).motorSource, 'manual');
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await mobile.page.waitForTimeout(100); assert.equal((await snapshot(mobile.page)).input.forward, 0);
  const look = await mobile.page.locator('#look-stick').boundingBox(), beforeLook = await snapshot(mobile.page);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: look.x + look.width * .75, y: look.y + look.height * .25 }] });
  await mobile.page.waitForTimeout(750); const afterLook = await snapshot(mobile.page);
  assert.ok(afterLook.heading < beforeLook.heading - .2); assert.ok(afterLook.position.y > beforeLook.position.y + .3);
  await session.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await mobile.page.waitForTimeout(100);
  assert.equal((await snapshot(mobile.page)).input.yaw, 0); assert.equal((await snapshot(mobile.page)).input.lift, 0);
  await inspect(mobile.page, 'mobile-manual');
  await mobile.page.getByRole('button', { name: 'First person camera', exact: true }).click();
  await inspect(mobile.page, 'mobile-neural-response-fpv');
  assert.equal(await mobile.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await mobile.page.setViewportSize({ width: 844, height: 390 });
  await inspect(mobile.page, 'mobile-landscape');
  await mobile.page.getByRole('button', { name: 'Flight settings', exact: true }).click();
  await inspect(mobile.page, 'mobile-landscape-settings');
  await mobile.page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await mobile.page.setViewportSize({ width: 320, height: 568 });
  await mobile.page.locator('#autopilot').click();
  await inspect(mobile.page, 'mobile-small');
  await mobile.page.getByRole('button', { name: 'Flight settings', exact: true }).click();
  await inspect(mobile.page, 'mobile-small-settings');
  await mobile.page.evaluate(() => document.querySelector('#scene').getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
  await mobile.page.waitForFunction(() => document.querySelector('#scene').dataset.ready === 'error');
  assert.equal(await mobile.page.locator('#retry').isVisible(), true);
  assert.equal(await mobile.page.evaluate(() => window.__flypv), undefined, 'Context loss cleans up simulation');
  await mobile.context.close();
  assert.deepEqual(errors, [], 'No browser errors');
  const checks = ['actual worker calibration and inference', '139662 nodes / 5536347 simulated edges / 60000 displayed edges',
    'frame tick and features bound to applied motor decision', 'world rendering continues during calibration', 'manual touch controls',
    'follow and FPV anatomy visible and nonblank', 'portrait/landscape/small mobile HUD separation', 'settings', 'context loss cleanup'];
  if (!mobileOnly) checks.push('no inference teacher updates', 'distinct model and world clocks', 'pause freezes accepted neural state and pixels',
    'silencing removes motors while physics falls', 'manual keyboard controls', 'orbit anatomy visible and nonblank', 'gesture audio');
  await writeFile(destination + 'results.json', JSON.stringify({ url, scope: mobileOnly ? 'mobile' : 'desktop-and-mobile', errors, checks, results }, null, 2));
  console.log(JSON.stringify({ passed: true, screenshots: results.length, errors, output: destination }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ errors, completed: results.map(result => result.name) }, null, 2));
  throw error;
} finally { await browser.close(); }

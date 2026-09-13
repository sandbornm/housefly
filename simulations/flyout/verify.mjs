import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const output = fileURLToPath(new URL('./verification/', import.meta.url));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
page.on('pageerror', error => errors.push(error.message));
const base = process.env.FLYOUT_URL ?? 'http://127.0.0.1:5173/simulations/flyout/';

async function pixels() {
  return page.evaluate(() => {
    const canvas = document.querySelector('#field');
    const gl = canvas.getContext('webgl2');
    const sample = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
    gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, sample);
    let green = 0, colored = 0, bright = 0, hash = 0;
    for (let i = 0; i < sample.length; i += 164) {
      const [r, g, b] = sample.subarray(i, i + 3);
      if (g > r * 1.04 && g > b * 1.05) green++;
      if (Math.max(r, g, b) - Math.min(r, g, b) > 25) colored++;
      if (r + g + b > 500) bright++;
      hash = (Math.imul(hash, 31) + r + g * 3 + b * 7) >>> 0;
    }
    return { green, colored, bright, hash, width: gl.drawingBufferWidth, height: gl.drawingBufferHeight };
  });
}

try {
  await page.goto(`${base}?seed=7193`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#field[data-ready="true"]', { timeout: 30000 });
  await page.waitForTimeout(800);
  const initial = await pixels();
  assert.ok(initial.green > 500 && initial.colored > 1000 && initial.bright > 1000, 'Canvas has visible colored field pixels');
  await page.screenshot({ path: `${output}desktop.png` });
  if (process.argv.includes('--preview')) {
    console.log(JSON.stringify({ initial, state: await page.evaluate(() => window.__flyout), errors }, null, 2));
  } else {
    for (let i = 0; i < 9; i++) {
      await page.locator(`[data-fielder="${i}"]`).click();
      assert.equal(await page.evaluate(() => window.__flyout.selected), i);
    }
    await page.locator('#auto-field').uncheck();
    const before = await page.evaluate(() => window.__flyout.fielders[8]);
    await page.keyboard.press('Tab');
    await page.keyboard.down('ArrowRight'); await page.waitForTimeout(450); await page.keyboard.up('ArrowRight');
    const after = await page.evaluate(() => window.__flyout.fielders[8]);
    assert.ok(Math.hypot(after.x - before.x, after.z - before.z) > 1, 'Keyboard moves selected fielder');
    await page.locator('#follow').click(); await page.waitForTimeout(450);
    assert.equal(await page.locator('#follow').getAttribute('aria-pressed'), 'true');
    await page.screenshot({ path: `${output}follow.png` });
    await page.locator('#follow').click(); await page.locator('#auto-field').check();
    await page.locator('#reset').click();
    await page.locator('#action').click();
    await page.waitForFunction(() => {
      if (window.__flyout.phase !== 'pitch' || window.__flyout.phaseTime / window.__flyout.pitchDuration < .85) return false;
      document.querySelector('#action').click(); return true;
    });
    await page.waitForTimeout(400);
    const manual = await page.evaluate(() => window.__flyout);
    assert.ok(['live', 'holding', 'throw', 'result'].includes(manual.phase), `Timed swing resolves into play (${manual.phase})`);
    await page.locator('#autoplay').check();
    await page.waitForTimeout(28000);
    const active = await page.evaluate(() => window.__flyout);
    assert.ok(active.physicsSteps > 300 && active.maximumSteps <= 6, 'Bounded Rapier steps run');
    assert.ok(active.recentPlays.length >= 3, 'Autoplay advances real plays');
    const moving = await pixels(); assert.notEqual(initial.hash, moving.hash, 'Canvas changes across gameplay frames');
    await page.screenshot({ path: `${output}gameplay.png` });
    await page.locator('#pause').click();
    const stopped = await page.evaluate(() => window.__flyout.physicsSteps);
    await page.waitForTimeout(400); assert.equal(await page.evaluate(() => window.__flyout.physicsSteps), stopped);
    await page.locator('#resume').click();
    await page.locator('#reset').click(); await page.locator('#autoplay').uncheck();
    assert.deepEqual(await page.evaluate(() => window.__flyout.score.runs), [0, 0]);
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    mobile.on('pageerror', error => errors.push(error.message));
    await mobile.goto(base, { waitUntil: 'networkidle' });
    await mobile.waitForSelector('#field[data-ready="true"]'); await mobile.waitForTimeout(500);
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await mobile.screenshot({ path: `${output}mobile.png` });
    const button = mobile.locator('[data-move="right"]');
    const mobileBefore = await mobile.evaluate(() => window.__flyout.fielders[0]);
    const touch = await mobile.context().newCDPSession(mobile);
    const box = await button.boundingBox();
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
    await mobile.waitForTimeout(350);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const mobileAfter = await mobile.evaluate(() => window.__flyout.fielders[0]);
    assert.ok(Math.hypot(mobileAfter.x - mobileBefore.x, mobileAfter.z - mobileBefore.z) > .5, 'Touch controls move the selected fielder');
    await mobile.close();
    assert.deepEqual(errors, []);
    const report = { initial, moving, active, errors, checks: ['nine-player selection', 'keyboard movement', 'camera follow', 'timed swing', 'autoplay', 'physics cap', 'canvas pixels and changed frames', 'pause', 'reset', 'mobile layout', 'touch movement'] };
    await writeFile(`${output}report.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
} catch (error) {
  await page.screenshot({ path: `${output}failure.png` });
  console.error(JSON.stringify({ errors, loading: await page.locator('#loading').textContent(), url: page.url(),
    state: await page.evaluate(() => window.__flyout) }, null, 2));
  throw error;
} finally { await browser.close(); }

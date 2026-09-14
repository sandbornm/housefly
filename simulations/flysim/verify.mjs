import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const destination = fileURLToPath(new URL('./verification/', import.meta.url));
await mkdir(destination, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [];
const url = process.env.FLYSIM_URL || 'http://127.0.0.1:5180/simulations/flysim/';
const snapshot = page => page.evaluate(() => window.__flysim.snapshot());

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator('#scene[data-ready="true"]').waitFor({ timeout: 90000 });
  await page.waitForFunction(() => window.__flysim, undefined, { timeout: 90000 });
  assert.match(await page.title(), /^Fly Simulator/);
  const deadline = Date.now() + 180000;
  while (!['inference', 'failed'].includes((await snapshot(page)).neural?.phase)) {
    const progress = await snapshot(page);
    console.log(JSON.stringify({ progress: { phase: progress.neural?.phase, samples: progress.neural?.samples, elapsed: progress.elapsed } }));
    assert.ok(Date.now() < deadline, 'Neural load timed out: ' + JSON.stringify(progress.neural));
    await page.waitForTimeout(1000);
  }
  const trained = await snapshot(page);
  assert.equal(trained.neural.phase, 'inference', trained.neural.failure);
  await page.locator('.activity-connectome[data-ready="true"][data-mode="neural"]').waitFor({ timeout: 120000 });
  await page.waitForFunction(() => window.__flysim.snapshot().motorSource === 'neural');
  const linked = await snapshot(page);
  assert.equal(linked.connectome.mode, 'neural');
  assert.equal(linked.motorSource, 'neural');
  assert.equal(linked.appliedFrameTick, linked.neural.frameTick);
  assert.equal(linked.connectome.tick, linked.neural.frameTick);
  await page.screenshot({ path: `${destination}desktop-neural.png` });

  await page.locator('#neural-silenced').check();
  await page.waitForFunction(() => window.__flysim.snapshot().connectome.silenced);
  const silent = await snapshot(page);
  assert.equal(silent.motorSource, 'none');
  assert.equal(silent.appliedInput, null);
  assert.equal(silent.connectome.energy, 0, 'Silent anatomy has no fabricated excitation');
  assert.equal(silent.connectome.active, 0);
  assert.equal(silent.neural.spikeCount, 0);
  await page.screenshot({ path: `${destination}desktop-silenced.png` });

  await page.locator('#neural-silenced').uncheck();
  await page.getByRole('button', { name: 'Reset garden', exact: true }).click();
  await page.waitForFunction(() => window.__flysim.snapshot().motorSource === 'neural');
  assert.deepEqual(errors, [], 'No page errors');
  await writeFile(destination + 'results.json', JSON.stringify({ url, errors, connectome: (await snapshot(page)).connectome }, null, 2));
  console.log(JSON.stringify({ passed: true, errors, output: destination }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ errors }, null, 2));
  throw error;
} finally { await browser.close(); }

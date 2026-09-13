import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const output = fileURLToPath(new URL('./verification/', import.meta.url));
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(`${process.env.FLYOUT_URL ?? 'http://127.0.0.1:5173/simulations/flyout/'}?seed=7193`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#field[data-ready="true"]');
  await page.locator('#auto-field').uncheck();
  await page.locator('#autoplay').check();
  await page.waitForFunction(() => window.__flyout.phase === 'live');
  await page.locator('#autoplay').uncheck();
  await page.waitForFunction(() => window.__flyout.groundContacts > 0, { timeout: 15000 });
  await page.locator('#auto-field').check();
  await page.waitForFunction(() => {
    if (window.__flyout.phase !== 'holding') return false;
    document.querySelector('#auto-field').click(); return true;
  }, { timeout: 15000 });
  const possession = await page.evaluate(() => window.__flyout.activity);
  assert.equal(possession.actor, possession.possessor, 'Miniature follows the ball possessor');
  assert.match(possession.signal.label, /Ball secured/);
  await page.locator('[data-base="2"]').click();
  await page.waitForFunction(() => window.__flyout.activity.signal.label.includes('Throw to 2B'));
  const throwing = await page.evaluate(() => window.__flyout.activity);
  assert.equal(throwing.actor, possession.actor, 'Throw stays attached to the real thrower');
  assert.ok(throwing.signal.motor > .9);
  await page.waitForFunction(() => window.__flyout.phase === 'result');
  const fielding = await page.evaluate(() => window.__flyout);
  assert.ok(fielding.groundContacts > 0 && fielding.throws === 1);
  assert.ok(fielding.score.hits[0] === 1 && fielding.score.bases.some(Boolean), 'Ground pickup and throw produce a safe hit');
  assert.equal(fielding.activity.actor, possession.actor, 'Result retains the thrower after possession clears');
  await page.screenshot({ path: `${output}ground-throw.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#reset').click(); await page.waitForTimeout(600);
  await page.screenshot({ path: `${output}mobile.png` });
  const layout = await page.evaluate(() => {
    const roster = document.querySelector('.roster').getBoundingClientRect();
    return { rosterBottom: roster.bottom, leftFielder: window.__flyout.fieldPixels[6], overflow: document.documentElement.scrollWidth > innerWidth };
  });
  assert.equal(layout.overflow, false);
  assert.ok(layout.rosterBottom < layout.leftFielder.y - 15, 'Mobile roster clears the field');
  assert.deepEqual(errors, []);
  await writeFile(`${output}fielding.json`, JSON.stringify({ fielding, layout, errors }, null, 2));
  console.log(JSON.stringify({ groundContacts: fielding.groundContacts, throws: fielding.throws, result: fielding.score.last, layout, errors }, null, 2));
} finally { await browser.close(); }

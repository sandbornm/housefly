import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const media = join(root, 'docs/media');
const verification = join(root, 'simulations/flyout/verification');
await mkdir(media, { recursive: true }); await mkdir(verification, { recursive: true });
const qc = JSON.parse(await readFile(join(verification, 'neural-report.json'), 'utf8'));
assert.ok(!qc.failure && qc.ablation?.fieldersFrozen && qc.ablation?.ballMoved && qc.pause?.stable,
  'Run Flyout neural.verify.mjs successfully before recording.');
assert.ok(qc.actionFrameMatching?.length > 0 && qc.actionFrameMatching.every(action => action.tick === action.frameTick));
assert.deepEqual(qc.errors, []);
const temporary = await mkdtemp(join(tmpdir(), 'flyout-video-'));
const browser = await chromium.launch({ channel: 'chromium', headless: true });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1,
  recordVideo: { dir: temporary, size: { width: 1920, height: 1080 } } });
const videoStarted = Date.now();
const page = await context.newPage();
const errors = []; page.on('pageerror', error => errors.push(error.message));
const timeline = [];
const samples = [];
let offset, initial, final, poster = false;
let videoPath;
const posterPath = join(temporary, 'flyout-neural-current.png');
const captureURL = new URL(process.env.FLYOUT_URL ?? 'http://127.0.0.1:5180/simulations/flyout/');
captureURL.searchParams.set('seed', '7193');
const inspect = (audit = false) => page.evaluate(audit => {
  const state = window.__flyout;
  if (!audit) delete state.neural.decisions;
  return { origin: performance.timeOrigin, state };
}, audit);

try {
  await page.goto(captureURL.href, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#field[data-ready="true"]', { timeout: 30000 });
  await page.waitForFunction(() => ['ready', 'error'].includes(window.__flyout?.neural?.state), undefined, { timeout: 120000 });
  assert.equal((await inspect()).state.neural.state, 'ready');
  await page.locator('.activity-connectome[data-neural-ready="true"]').waitFor();
  await page.waitForFunction(() => window.__flyout.neural.actors.every(actor => actor.totalSpikes > 0));
  const loaded = await inspect(); initial = loaded.state;
  assert.equal(initial.neural.edgeCount, 5536347); assert.equal(initial.neural.actors.length, 10);
  assert.equal(initial.activity.connectome.mode, 'neural');
  assert.equal(initial.autoplay, true); assert.equal(initial.autoField, true);
  assert.equal(initial.controlProvenance.pitches, 'game engine');
  assert.match(await page.locator('#neural-status').textContent(), /calibrated/);
  await page.mouse.move(1910, 1060);
  offset = (Date.now() - videoStarted) / 1000;
  const start = Date.now();
  let lastEvent = '';
  while (Date.now() - start < 31000) {
    const current = await inspect(), state = current.state;
    assert.equal(current.origin, loaded.origin, 'Abort a capture invalidated by navigation/HMR');
    assert.ok(state && state.physicsSteps >= initial.physicsSteps, 'Abort a restarted simulation');
    assert.equal(state.neural.state, 'ready', state.neural.label);
    assert.equal(state.activity.connectome.mode, 'neural');
    assert.ok(state.neural.applied.every(action => action.tick === action.frameTick && action.tick === action.command.tick
      && action.spikes > 0 && action.command.source === 'neural'), 'Actions must match actual neural source frames');
    const at = Number(((Date.now() - start) / 1000).toFixed(2));
    samples.push({ at, worldMs: state.neural.worldMs, physicsSteps: state.physicsSteps, renderedFrames: state.renderedFrames,
      batchWallMs: state.neural.wallMs, actor: state.activity.neuralActor, display: state.activity.connectome,
      actors: state.neural.actors, applied: state.neural.applied });
    if (state.lastEvent !== lastEvent) {
      timeline.push({ at, event: state.lastEvent, runs: state.score.runs, phase: state.phase });
      lastEvent = state.lastEvent; console.log(JSON.stringify(timeline.at(-1)));
    }
    if (!poster && at >= 15) {
      await page.screenshot({ path: posterPath }); poster = true;
    }
    await page.waitForTimeout(200);
  }
  final = (await inspect(true)).state;
  const decisions = final.neural.decisions.filter(action => action.sequence > initial.neural.decisionCount);
  assert.equal(decisions.length, final.neural.decisionCount - initial.neural.decisionCount, 'Complete bounded per-decision evidence');
  assert.ok(decisions.length > 0);
  for (const action of decisions) {
    let hash = 2166136261;
    const rates = Float32Array.from(action.rates);
    assert.equal(rates.length, 128);
    for (const bits of new Uint32Array(rates.buffer)) hash = Math.imul(hash ^ bits, 16777619) >>> 0;
    assert.equal(hash, action.featureHash);
    assert.equal(action.tick, action.frameTick); assert.equal(action.command.tick, action.tick);
    assert.equal(action.command.source, 'neural'); assert.ok(action.spikes > 0);
  }
  assert.ok(poster && final.physicsSteps > initial.physicsSteps && final.renderedFrames > initial.renderedFrames);
  videoPath = await page.video().path();
} finally { await context.close(); await browser.close(); }

if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
const output = join(temporary, 'flyout-neural-current.mp4');
const encode = spawnSync('ffmpeg', ['-y', '-threads', '2', '-ss', String(offset), '-i', videoPath, '-t', '30', '-an',
  '-vf', 'fps=30', '-filter_threads', '2', '-c:v', 'libx264', '-preset', 'slow', '-threads', '2', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
if (encode.status) throw new Error(encode.stderr);
const decode = spawnSync('ffmpeg', ['-v', 'error', '-threads', '2', '-i', output, '-threads', '2', '-f', 'null', '-'], { encoding: 'utf8' });
if (decode.status) throw new Error(decode.stderr);
const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,pix_fmt,r_frame_rate,duration:format=duration,size', '-of', 'json', output], { encoding: 'utf8' });
if (probe.status) throw new Error(probe.stderr);
const metadata = JSON.parse(probe.stdout), stream = metadata.streams[0];
assert.equal(stream.codec_name, 'h264'); assert.equal(stream.width, 1920); assert.equal(stream.height, 1080);
assert.equal(stream.r_frame_rate, '30/1'); assert.equal(stream.pix_fmt, 'yuv420p');
assert.ok(Number(metadata.format.duration) >= 29.9 && Number(metadata.format.duration) <= 30.1);
const bytes = await readFile(output), boxes = [];
for (let position = 0; position + 8 <= bytes.length;) {
  const size = bytes.readUInt32BE(position), type = bytes.toString('ascii', position + 4, position + 8);
  boxes.push(type);
  if (!size) break;
  position += size === 1 ? Number(bytes.readBigUInt64BE(position + 8)) : size;
}
assert.ok(boxes.indexOf('moov') >= 0 && boxes.indexOf('moov') < boxes.indexOf('mdat'), 'Faststart metadata precedes video data');
await rename(output, join(media, 'flyout-neural-current.mp4'));
await rename(posterPath, join(media, 'flyout-neural-current.png'));
const report = { video: join(media, 'flyout-neural-current.mp4'), poster: join(media, 'flyout-neural-current.png'),
  url: captureURL.href,
  capture: 'One seed-7193 run, first 30 seconds after all ten default neural actors are ready; fixed midpoint poster. No manual motor actions, score edits, replay selection, or expert fallback. Pitches, turns and physics are game-engine operations. Silent capture.',
  caveat: 'Weak offline task readouts; not competent baseball or biologically validated cognition. 30 fps encoding does not imply 30 unique simulation frames per second.',
  calibration: initial.neural.calibration, qc: { ablation: qc.ablation, pause: qc.pause, actionFrameMatching: qc.actionFrameMatching },
  timeline, samples, errors, initial, final, ffprobe: metadata, faststart: true };
await writeFile(join(verification, 'recording-neural-current.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ video: report.video, poster: report.poster, timeline, ffprobe: metadata,
  worldElapsedMs: final.neural.worldMs - initial.neural.worldMs, actorElapsedMs: final.neural.actors.map((actor, i) => actor.simulatedMs - initial.neural.actors[i].simulatedMs),
  completedPlays: final.recentPlays, catches: final.catches, throws: final.throws, faststart: true }, null, 2));

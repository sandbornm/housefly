import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../', import.meta.url));
const reference = JSON.parse(await readFile(new URL('../fixtures/runtime-report.json', import.meta.url), 'utf8'));
const server = await createServer({ root, configFile: false, base: '/worker-check/',
  cacheDir: `${root}/neural/target/vite-worker-check`, optimizeDeps: { noDiscovery: true },
  server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  let workers = 0;
  let manifests = 0;
  const graphRequests = [];
  page.on('worker', () => { workers += 1; });
  context.on('request', request => {
    if (request.url().endsWith('/neural/manifest.json')) manifests += 1;
    if (/\/neural\/.*\.(bin|wasm)$/.test(request.url())) graphRequests.push(request.url());
  });
  await page.goto(`${origin}/worker-check/neural/fixtures/worker.html`);
  const result = await page.evaluate(async reference => {
    const { AsyncNeuralRuntime, terminateNeuralWorker } = await import('/worker-check/src/neural/client.ts');
    function check(value, description) { if (!value) throw new Error(description); }
    async function rejected(promise, name) {
      try { await promise; } catch (error) {
        check(!name || error.name === name, `Expected ${name}, got ${error.name}: ${error.message}`);
        return error.message;
      }
      throw new Error('Expected rejection');
    }
    const actors = await Promise.all(Array.from({ length: 12 }, (_, i) => AsyncNeuralRuntime.create(i + 42)));
    check(actors.every(actor => actor.graph === actors[0].graph), 'Metadata graph must be shared');
    check(actors[0].graph.nodeCount === 139662 && actors[0].graph.edgeCount === 5536347, 'Wrong graph');
    check(Object.isFrozen(actors[0].graph) && Object.isFrozen(actors[0].graph.metadata), 'Metadata must be readonly');
    check(actors[0].graph.displayIndices[139661] === 139661, 'Display mapping differs');
    const { neuralGraphInternals } = await import('/worker-check/src/neural/data.ts');
    let metadataOnly = false;
    try { neuralGraphInternals(actors[0].graph); } catch { metadataOnly = true; }
    check(metadataOnly, 'Main thread received executable graph internals');
    await rejected(AsyncNeuralRuntime.create(123), 'NeuralBusyError');
    const initialOther = await actors[1].snapshot();
    check(initialOther.totalSpikes === 0, 'Independent actor was modified');

    let heartbeats = 0;
    const timer = setInterval(() => { heartbeats += 1; }, 10);
    const input = new Float32Array(32).fill(150);
    const start = performance.now();
    const advancing = actors[0].advance(input, 1000);
    input.fill(0);
    await rejected(actors[0].advance(input, 20), 'NeuralBusyError');
    await rejected(actors[0].snapshot(), 'NeuralBusyError');
    const frame = await advancing;
    const elapsedMs = performance.now() - start;
    clearInterval(timer);
    check(heartbeats >= 20, `Renderer blocked: ${heartbeats} heartbeat callbacks`);
    check(input.byteLength === 128, 'Caller input buffer was detached');
    check(frame.totalSpikes === reference.totalSpikes, 'Worker/native event count differs');
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', frame.spikes)), x => x.toString(16).padStart(2, '0')).join('');
    check(hash === reference.spikeIndexSha256, 'Worker/native spike sequence differs');
    check(frame.rates.length === 128 && frame.rates.every(value => value > 0), 'Output pools must be actual nonzero rates');
    const oldRates = frame.rates.slice();
    const oldSpikeCount = frame.spikes.length;
    await actors[0].advance(new Float32Array(32), 20);
    check(frame.spikes.length === oldSpikeCount && frame.levels.byteLength === 139662 * 4, 'Historical frame was detached');
    check(frame.rates.every((value, i) => value === oldRates[i]), 'Historical frame mutated');
    check((await actors[1].snapshot()).totalSpikes === 0, 'Runtime states are not independent');

    const stale = rejected(actors[0].advance(new Float32Array(32).fill(150), 100), 'AbortError');
    const silencing = actors[0].silence(true);
    check(actors[0].silenced, 'Motor gate did not close immediately');
    await stale;
    await silencing;
    const silent = await actors[0].advance(new Float32Array(32).fill(150), 20);
    check(silent.silenced && silent.spikes.length === 0 && silent.rates.every(x => x === 0) && silent.levels.every(x => x === 0), 'Silenced response must be actual zero activity');
    await actors[0].reset(42);
    check((await actors[0].snapshot()).silenced, 'Reset must preserve silence');
    await actors[0].silence(false);
    check(!actors[0].silenced, 'Unmute did not wait for/acknowledge worker state');
    const resetting = rejected(actors[0].advance(new Float32Array(32).fill(150), 100), 'AbortError');
    await actors[0].reset(42);
    await resetting;
    check((await actors[0].snapshot()).tick === 0, 'Reset did not clear time');

    const invalid = new Float32Array(32).fill(NaN);
    await rejected(actors[0].advance(invalid, 20));
    await rejected(actors[0].advance(new Float32Array(31), 20));
    const batch = await Promise.all(actors.slice(0, 10).map(actor => actor.advance(new Float32Array(32).fill(50), 20)));
    check(batch.length === 10 && batch.every(frame => frame.tick > 0), 'Ten-actor queue failed');
    const disposingFrame = rejected(actors[11].advance(new Float32Array(32).fill(150), 100), 'AbortError');
    const disposing = actors[11].dispose();
    check(actors[11].silenced, 'Disposal did not close motor gate');
    await disposingFrame;
    await disposing;
    await actors[11].dispose();
    await rejected(actors[11].snapshot());
    const replacement = await AsyncNeuralRuntime.create(99);
    check(replacement.graph === actors[0].graph, 'Replacement reloaded graph');

    const pending = [
      rejected(actors[0].advance(new Float32Array(32).fill(150), 1000)),
      rejected(actors[1].dispose()),
      rejected(actors[2].advance(new Float32Array(32).fill(50), 20)),
    ];
    terminateNeuralWorker('Fixture requested termination');
    const terminationErrors = await Promise.all(pending);
    check(terminationErrors.every(message => message.includes('Fixture requested termination')), 'Termination left pending work or disposal unresolved');
    check(actors.every(actor => actor.silenced), 'Failure did not close all motor gates');
    await rejected(AsyncNeuralRuntime.create(42));
    return { elapsedMs, rendererHeartbeatCallbacks: heartbeats, totalSpikes: frame.totalSpikes, spikeIndexSha256: hash,
      metadataOnly, maximumActors: 12, queueLimitRejected: true, concurrentAdvanceRejected: true,
      ownedFrames: true, independentStates: true, pendingSilenceResetDisposeCancelled: true,
      silencedZero: true, terminationRejectedAllPending: true, terminalFailureNoRestart: true };
  }, reference);
  assert.equal(workers, 1, 'Exactly one worker per page');
  assert.equal(manifests, 1, 'Exactly one graph load per page');
  assert.ok(graphRequests.length > 0 && graphRequests.every(url => url.includes('/worker-check/neural/')), 'BASE_URL was not used in worker');
  await context.close();

  const corruptContext = await browser.newContext();
  await corruptContext.route('**/neural/male_cns_lif.wasm', async route => {
    const response = await route.fetch();
    const body = await response.body();
    body[0] ^= 1;
    await route.fulfill({ response, body });
  });
  const corruptPage = await corruptContext.newPage();
  await corruptPage.goto(`${origin}/worker-check/neural/fixtures/worker.html`);
  const corrupt = await corruptPage.evaluate(async () => {
    const { AsyncNeuralRuntime } = await import('/worker-check/src/neural/client.ts');
    const results = await Promise.allSettled([AsyncNeuralRuntime.create(42), AsyncNeuralRuntime.create(43)]);
    if (!results.every(result => result.status === 'rejected' && result.reason.message.includes('SHA-256 mismatch'))) throw new Error('Corrupt load did not reject all pending creates');
    try { await AsyncNeuralRuntime.create(44); } catch (error) { return error.message.includes('SHA-256 mismatch'); }
    return false;
  });
  assert.equal(corrupt, true, 'Corrupt assets must fail closed without restarting');
  await corruptContext.close();
  const report = { ...result, browser: browser.version(), singleWorker: workers === 1, singleGraphFetch: manifests === 1,
    baseUrlVerified: true, corruptAssetsFailClosed: corrupt };
  await writeFile(new URL('../fixtures/worker-report.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}

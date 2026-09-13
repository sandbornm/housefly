import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { NeuralRuntime } from '../../src/neural/runtime.ts';
import { loadNodeGraph } from './load_node.ts';

const started = performance.now();
const graph = await loadNodeGraph();
const loadMs = performance.now() - started;
const input = new Float32Array(32).fill(150);
const runtime = new NeuralRuntime(graph, 42);
let frame = runtime.advance(new Float32Array(32), 1000);
assert.equal(frame.totalSpikes, 0);
assert.ok(frame.rates.every(rate => rate === 0));
runtime.reset(42);
const begin = performance.now();
frame = runtime.advance(input, 1000);
const wasmMs = performance.now() - begin;
const stable = runtime.snapshot();
const inputNodes = new Set(graph.inputGroups.flat());
const downstream = frame.spikes.filter(node => !inputNodes.has(node));
assert.ok(downstream.length > 0, 'Real edges must cause spikes in undriven neurons');
assert.ok(frame.rates.some(rate => rate > 0), 'Output pools must register actual spikes');
assert.equal(frame.counts.reduce((a, b) => a + b, 0), frame.spikes.length);
assert.equal(frame.levels.length, graph.nodeCount);
assert.equal(frame.rates.length, 128);
const expected = frame.spikes.slice();
const expectedRates = frame.rates.slice();
runtime.reset(42);
frame = runtime.advance(input, 1000);
assert.deepEqual(frame.spikes, expected);
assert.deepEqual(frame.rates, expectedRates);
assert.deepEqual(stable.spikes, expected);
const chunked = new NeuralRuntime(graph, 42);
for (let i = 0; i < 100; i++) chunked.advance(input, 10);
assert.equal(chunked.snapshot().totalSpikes, frame.totalSpikes);
assert.deepEqual(chunked.snapshot().rates, frame.rates);
assert.deepEqual(chunked.snapshot().levels, frame.levels);
runtime.silence(true);
frame = runtime.advance(input, 1000);
assert.equal(frame.silenced, true);
assert.equal(frame.spikes.length, 0);
assert.ok(frame.counts.every(value => value === 0));
assert.ok(frame.rates.every(value => value === 0));
assert.ok(frame.levels.every(value => value === 0));
runtime.silence(false);
runtime.reset(42);
assert.equal(runtime.snapshot().totalSpikes, 0);
const neurons = Array.from({ length: 10 }, (_, i) => new NeuralRuntime(graph, i + 1));
const multiStart = performance.now();
for (let step = 0; step < 10; step++) for (const neuron of neurons) neuron.advance(input, 10);
const tenMs = performance.now() - multiStart;
assert.ok(new Set(neurons.map(neuron => neuron.snapshot().totalSpikes)).size > 1);
for (const neuron of neurons) neuron.dispose();
assert.throws(() => runtime.advance(new Float32Array(31), 10));
assert.throws(() => runtime.advance(new Float32Array(32).fill(NaN), 10));
assert.throws(() => runtime.advance(new Float32Array(32).fill(151), 10));
runtime.dispose(); runtime.dispose(); chunked.dispose();
assert.throws(() => runtime.snapshot());
const binary = new URL('../target/release/validate', import.meta.url);
const native = JSON.parse(execFileSync(binary.pathname, ['public/neural'], { encoding: 'utf8' }));
assert.equal(native.totalSpikes, stable.totalSpikes);
assert.deepEqual(new Float32Array(native.rates), stable.rates);
let fnv = 0xcbf29ce484222325n;
for (const byte of new Uint8Array(expected.buffer)) fnv = BigInt.asUintN(64, (fnv ^ BigInt(byte)) * 0x100000001b3n);
assert.equal(native.spikeFnv64, fnv.toString(16).padStart(16, '0'));
const disconnected = JSON.parse(execFileSync(binary.pathname, ['public/neural', 'zero-edges'], { encoding: 'utf8' }));
assert.equal(disconnected.downstreamSpikes, 0);
assert.ok(disconnected.rates.every((rate: number) => rate === 0));

// Integrity failures must stop loading; no synthetic or stale data fallback.
const { loadNeuralGraph } = await import('../../src/neural/data.ts');
await assert.rejects(loadNeuralGraph(new URL('../../public/', import.meta.url), { read: async url => {
  const data = await readFile(url);
  if (url.pathname.endsWith('.wasm')) data[0] ^= 1;
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
} }), /SHA-256 mismatch/);

const hash = createHash('sha256').update(new Uint8Array(expected.buffer)).digest('hex');
const report = { modelId: graph.modelId, wasmSha256: graph.metadata.wasm.sha256, nodeCount: graph.nodeCount, edgeCount: graph.edgeCount,
  loadMs, wasmOneSecondMs: wasmMs, nativeOneSecondMs: native.nativeElapsedMs, tenNetworks100MsEachWallMs: tenMs,
  totalSpikes: stable.totalSpikes, downstreamSpikes: downstream.length, nonzeroOutputPools: stable.rates.filter(rate => rate > 0).length,
  seed: 42, inputHz: 150, durationMs: 1000, spikeIndexSha256: hash, nativeWasmEqual: true,
  zeroInputQuiet: true, silencedQuiet: true, zeroEdgesDownstreamQuiet: true, chunkingEqual: true, corruptAssetRejected: true,
  environment: { node: process.version, platform: process.platform, arch: process.arch } };
await writeFile(new URL('../fixtures/runtime-report.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));

import { writeFile } from 'node:fs/promises';
import { loadNodeGraph } from './load_node.ts';
import { NeuralRuntime } from '../../src/neural/runtime.ts';
import { neuralGraphInternals } from '../../src/neural/data.ts';

const graph = await loadNodeGraph();
const { wasm } = neuralGraphInternals(graph);
const graphMemory = wasm.memory.buffer.byteLength;
const brains = Array.from({ length: 10 }, (_, i) => new NeuralRuntime(graph, i + 1));
const tenRestingMemory = wasm.memory.buffer.byteLength;
function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return { meanMs: samples.reduce((a, b) => a + b, 0) / samples.length, p50Ms: sorted[Math.floor(sorted.length * 0.5)],
    p95Ms: sorted[Math.floor(sorted.length * 0.95)], maximumMs: sorted.at(-1) };
}
const trials = [];
for (const hz of [0, 50, 150]) {
  const brain = brains[0]; brain.reset(42);
  const input = new Float32Array(32).fill(hz);
  const times: number[] = [];
  for (let step = 0; step < 50; step++) {
    const start = performance.now(); brain.advance(input, 20); times.push(performance.now() - start);
  }
  trials.push({ inputHz: hz, samples: times.length, simulatedChunkMs: 20, first100SimulatedMsWallMs: times.slice(0, 5).reduce((a, b) => a + b, 0), ...stats(times) });
}
for (let i = 0; i < brains.length; i++) brains[i].reset(i + 1);
const fielders: number[] = [];
const input = new Float32Array(32).fill(150);
for (let step = 0; step < 5; step++) {
  const start = performance.now();
  for (const brain of brains) brain.advance(input, 20);
  fielders.push(performance.now() - start);
}
const report = { modelId: graph.modelId, environment: { node: process.version, platform: process.platform, arch: process.arch },
  singleNetwork20Ms: trials, tenNetworks20MsEach: stats(fielders),
  memory: { graphWasmBytes: graphMemory, graphPlusTenRestingNetworksWasmBytes: tenRestingMemory,
    graphPlusTenActiveNetworksWasmBytes: wasm.memory.buffer.byteLength,
    tenNetworksMinimumJsMeasurementBytes: 10 * (graph.nodeCount * 6 + 128 * 4),
    note: 'WASM memory pages include allocator slack and scratch. JS measurement buffers exclude variable spike buffers, manifest, loaded graph display indices, and temporary fetch/hash buffers.' } };
for (const brain of brains) brain.dispose();
await writeFile(new URL('../fixtures/performance-report.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));

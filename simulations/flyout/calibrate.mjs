import { readFile, writeFile } from 'node:fs/promises';
import { NeuralRuntime } from '../../src/neural/runtime.ts';
import { calibrate } from './neural-calibration.ts';

const graph = await NeuralRuntime.load(new URL('../../public/', import.meta.url), {
  read: async url => { const bytes = await readFile(url); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
});
const started = performance.now(), seed = 7193;
const result = await calibrate(value => new NeuralRuntime(graph, value), seed,
  (done, total) => { if (done % 40 === 0) console.log(`Measured neural calibration ${done}/${total}`); }, () => false);
const artifact = { schema: 1, encoder: 'flyout-sensory-32-v1', modelId: graph.modelId, nodeCount: graph.nodeCount,
  edgeCount: graph.edgeCount, seed, elapsedMs: performance.now() - started, report: result.report, weights: result.weights };
await writeFile(new URL('./calibration.json', import.meta.url), `${JSON.stringify(artifact)}\n`);
console.log(JSON.stringify({ elapsedMs: artifact.elapsedMs, ...artifact.report }, null, 2));

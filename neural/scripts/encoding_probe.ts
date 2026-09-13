import { NeuralRuntime } from '../../src/neural/runtime.ts';
import { loadNodeGraph } from './load_node.ts';
import { writeFile } from 'node:fs/promises';

// Diagnostic only: no behavioral labels, fitted policy, or graph changes. Compare
// downstream responses to isolated input channels across independent Poisson seeds.
const graph = await loadNodeGraph();
const runtime = new NeuralRuntime(graph, 42);
const seeds = [42, 101, 999];
const channels = 32, features = 128;
const responses: number[][][] = [];
const checkpoints: { seed: number; channel: number; milliseconds: number; rates: number[]; transformed: number[] }[] = [];
const start = performance.now();
function normalized(rates: ArrayLike<number>): number[] {
  const values = Array.from(rates, rate => rate / (rate + 20));
  const norm = Math.hypot(...values);
  return values.map(value => norm ? value / norm : 0);
}
function cosine(a: number[], b: number[]): number {
  const norm = Math.hypot(...a) * Math.hypot(...b);
  return norm ? a.reduce((sum, value, index) => sum + value * b[index], 0) / norm : 0;
}
try {
  for (const seed of seeds) {
    const trial: number[][] = [];
    for (let channel = 0; channel < channels; channel++) {
      runtime.reset(seed);
      const input = new Float32Array(channels); input[channel] = 150;
      const mean = new Array<number>(features).fill(0);
      for (let step = 0; step < 12; step++) {
        const frame = runtime.advance(input, 20);
        if ([0, 4, 11].includes(step)) checkpoints.push({ seed, channel, milliseconds: (step + 1) * 20,
          rates: Array.from(frame.rates), transformed: normalized(frame.rates) });
        if (step >= 6) for (let pool = 0; pool < features; pool++) mean[pool] += frame.rates[pool] / 6;
      }
      trial.push(mean);
    }
    responses.push(trial);
  }
  const centroids = responses[0].map((rates, channel) => normalized(rates.map((rate, pool) => (rate + responses[1][channel][pool]) / 2)));
  const result = responses[2].map((rates, channel) => {
    const feature = normalized(rates), similarities = centroids.map(centroid => cosine(feature, centroid));
    const predicted = similarities.indexOf(Math.max(...similarities));
    const strongestOther = Math.max(...similarities.filter((_, index) => index !== channel));
    return { channel, meanHz: rates.reduce((sum, rate) => sum + rate, 0) / features,
      activePools: rates.filter(rate => rate > 0).length, predicted,
      ownSimilarity: similarities[channel], strongestOther, margin: similarities[channel] - strongestOther };
  });
  const report = { modelId: graph.modelId, wasmSha256: graph.metadata.wasm.sha256, seeds, inputHz: 150, durationMs: 240,
    averagingWindowMs: [120, 240], advanceMs: 20, heldoutSeed: seeds[2],
    note: 'Isolated-channel diagnostic, not chord discrimination or musical performance. Nearest-centroid classification uses the readout feature transform and no behavioral labels.',
    correct: result.filter(item => item.predicted === item.channel).length, total: channels,
    wallMs: performance.now() - start, channels: result, averagedRates: responses, checkpoints };
  await writeFile(new URL('../fixtures/encoding-probe-report.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ modelId: report.modelId, correct: report.correct, total: report.total,
    wallMs: report.wallMs, report: 'neural/fixtures/encoding-probe-report.json' }));
} finally { runtime.dispose(); }

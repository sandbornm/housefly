import { readFile, writeFile } from 'node:fs/promises';
import { NeuralRuntime } from '../../src/neural/runtime.ts';
import { NeuralPilot } from './pilot.ts';
import { FLYSIM_ENCODER, NEURAL_WINDOW_MS } from './neural.ts';

const graph = await NeuralRuntime.load(new URL('../../public/', import.meta.url), {
  read: async url => { const bytes = await readFile(url); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
});
const started = performance.now(), pilot = new NeuralPilot(new NeuralRuntime(graph, 8731), graph);
try {
  await pilot.beginCalibration(); pilot.commit();
  while (pilot.phase === 'calibration') { await pilot.calibrateStep(); pilot.commit(); }
  if (pilot.phase !== 'inference' || !pilot.readout.updates) throw new Error(pilot.failure || 'Calibration produced no usable neural responses.');
  const artifact = {
    schema: 1, encoder: FLYSIM_ENCODER, modelId: graph.modelId,
    nodeCount: graph.nodeCount, edgeCount: graph.edgeCount, neuralWindowMs: NEURAL_WINDOW_MS,
    elapsedMs: performance.now() - started,
    report: { trials: pilot.samples, updates: pilot.readout.updates, loss: pilot.lastLoss, windowsMs: NEURAL_WINDOW_MS },
    weights: pilot.readout.export(),
  };
  await writeFile(new URL('./calibration.json', import.meta.url), `${JSON.stringify(artifact)}\n`);
  console.log(JSON.stringify({ elapsedMs: artifact.elapsedMs, ...artifact.report }, null, 2));
} finally { await pilot.dispose(); }

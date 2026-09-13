import { NeuralReadout } from '../../src/neural/policy.ts';
import { AIM_ACTIONS, BATTER_ACTOR, FIELD_ACTIONS, MOVE_ACTIONS, SWING_ACTIONS, encodeObservation,
  type ActorReadouts, type NeuralFrame, type Observation, type RuntimePort } from './neural-adapter.ts';

export type Head = 'movement' | 'handling' | 'swing' | 'aim';
export type ReadoutWeights = Record<Head, ReturnType<NeuralReadout['export']>>;
export interface CalibrationMetric { samples: number; correct: number; loss: number; accuracy: number; updates: number }
export interface CalibrationReport {
  source: 'offline scripted observations / real neural responses';
  trainingTrials: number;
  validationTrials: number;
  windowsMs: number;
  heads: Record<Head, CalibrationMetric>;
}

const directions = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];
const bases = [{ x: 9, z: 3 }, { x: 0, z: -6 }, { x: -9, z: 3 }, { x: 0, z: 12 }];

function randomSequence(seed: number): () => number {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}

function offlineTrial(index: number, random: () => number): Observation {
  const batter = index % 2 === 1;
  const self = batter ? { x: -1.5, y: 0, z: 12 } : { x: random() * 38 - 19, y: 0, z: random() * 30 - 18 };
  const direction = directions[Math.floor(index / 2) % directions.length];
  const nearby = index % 7 === 0;
  const holding = !batter && index % 8 === 0;
  const home = { ...self };
  const ball = batter ? { x: self.x + random() * 3.6, y: .9 + random(), z: 7 + random() * 6 }
    : { x: self.x + direction[0] * (nearby ? .6 : 5 + random() * 12), y: nearby ? 1.2 : random() * 10,
      z: self.z + direction[1] * (nearby ? .6 : 5 + random() * 12) };
  if (batter && index % 4 === 1) { ball.x = -.15 + random() * .3; ball.z = 11.6 + random() * .8; ball.y = 1.3; }
  if (holding) { ball.x = self.x + .4; ball.y = 1.3; ball.z = self.z + .3; }
  return { ball, self, home, velocity: { x: batter ? 0 : (random() - .5) * 8, y: batter ? -.2 : -random() * 4,
    z: batter ? 7.2 : (random() - .5) * 8 }, selfVelocity: { x: 0, y: 0, z: 0 },
    phase: batter ? 'pitch' : holding ? 'holding' : 'live', hasBall: holding, bounced: nearby || index % 3 === 0,
    batter, runnerDistance: random() * 20, strikes: Math.floor(random() * 3), balls: Math.floor(random() * 4) };
}

// These teacher calculations are confined to offline calibration. Inference never calls them.
function teacher(observation: Observation): Partial<Record<Head, number>> {
  const { ball, self, velocity } = observation;
  if (observation.batter) {
    return { swing: Math.abs(ball.x) < 1.1 && Math.abs(ball.z - 12) < .65 && ball.y < 2 ? 1 : 0,
      aim: ball.x < -.1 ? 0 : ball.x > .1 ? 2 : 1 };
  }
  const flight = observation.bounced ? 0 : Math.max(0, (velocity.y + Math.sqrt(velocity.y ** 2 + 26 * Math.max(0, ball.y - 1.35))) / 13);
  const dx = ball.x + velocity.x * Math.min(1.8, flight) - self.x;
  const dz = ball.z + velocity.z * Math.min(1.8, flight) - self.z;
  const sx = Math.abs(dx) < .5 ? 0 : Math.sign(dx), sz = Math.abs(dz) < .5 ? 0 : Math.sign(dz);
  const movement = observation.hasBall ? 0 : directions.findIndex(([x, z]) => x === sx && z === sz);
  let handling = Math.hypot(ball.x - self.x, ball.z - self.z) < 2.1 && ball.y < 3.5 ? 1 : 0;
  if (observation.hasBall) {
    const distances = bases.map(base => Math.hypot(base.x - self.x, base.z - self.z));
    handling = distances.indexOf(Math.min(...distances)) + 2;
  }
  return { movement, handling };
}

function policies(seed: number): Record<Head, NeuralReadout> {
  return { movement: new NeuralReadout({ actions: MOVE_ACTIONS, modelId: 'flyout-movement-v1', seed }),
    handling: new NeuralReadout({ actions: FIELD_ACTIONS, modelId: 'flyout-handling-v1', seed: seed + 1 }),
    swing: new NeuralReadout({ actions: SWING_ACTIONS, modelId: 'flyout-swing-v1', seed: seed + 2 }),
    aim: new NeuralReadout({ actions: AIM_ACTIONS, modelId: 'flyout-aim-v1', seed: seed + 3 }) };
}

export async function calibrate(createRuntime: (seed: number) => RuntimePort, seed: number,
  progress: (completed: number, total: number) => void, cancelled: () => boolean): Promise<{
    report: CalibrationReport; weights: ReadoutWeights; createReadouts: (actor: number) => ActorReadouts;
  }> {
  const models = policies(seed), random = randomSequence(seed);
  const metric = (): CalibrationMetric => ({ samples: 0, correct: 0, loss: 0, accuracy: 0, updates: 0 });
  const report: CalibrationReport = { source: 'offline scripted observations / real neural responses',
    trainingTrials: 192, validationTrials: 48, windowsMs: 100,
    heads: { movement: metric(), handling: metric(), swing: metric(), aim: metric() } };
  const runtime = createRuntime(seed);
  const total = report.trainingTrials + report.validationTrials;
  let recordedSpikes = 0;
  try {
    for (let index = 0; index < total; index++) {
      if (cancelled()) throw new Error('Neural calibration cancelled.');
      runtime.reset((seed + index * 104729) >>> 0);
      const observation = offlineTrial(index, random), targets = teacher(observation);
      const frame = runtime.advance(encodeObservation(observation), report.windowsMs);
      recordedSpikes += frame.spikes.length;
      if (!frame.silenced && frame.spikes.length) {
        for (const head of Object.keys(targets) as Head[]) {
          const target = targets[head]!, model = models[head], metric = report.heads[head];
          if (index < report.trainingTrials) {
            // Multiple optimizer passes reuse a measured response, never a fabricated feature vector.
            for (let pass = 0; pass < 12; pass++) metric.loss += model.teach(frame, target, .12);
          } else {
            const prediction = model.decide(frame, undefined, { sample: false });
            metric.samples++; metric.correct += Number(prediction?.index === target);
          }
        }
      } else if (index >= report.trainingTrials) {
        for (const head of Object.keys(targets) as Head[]) report.heads[head].samples++;
      }
      progress(index + 1, total);
      if (index % 4 === 3) await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  } finally { runtime.dispose(); }
  if (!recordedSpikes || Object.values(models).some(model => !model.updates)) throw new Error('Calibration produced no usable neural responses.');
  for (const head of Object.keys(models) as Head[]) {
    const metric = report.heads[head];
    metric.accuracy = metric.samples ? metric.correct / metric.samples : 0;
    metric.updates = models[head].updates;
    metric.loss /= metric.updates;
  }
  const weights = Object.fromEntries(Object.entries(models).map(([head, model]) => [head, model.export()])) as Record<Head, ReturnType<NeuralReadout['export']>>;
  return { report, weights, createReadouts: actor => restoreReadouts(weights, seed, actor) };
}

export function restoreReadouts(weights: ReadoutWeights, seed: number, actor: number): ActorReadouts {
  const copies = policies((seed + actor * 104729) >>> 0);
  for (const head of Object.keys(copies) as Head[]) {
    if (!copies[head].restore({ ...weights[head], randomState: ((seed + actor * 104729 + head.length * 97) >>> 0) || 1 })) {
      throw new Error('Invalid calibrated readout weights.');
    }
  }
  return actor === BATTER_ACTOR ? { ready: true, swing: copies.swing, aim: copies.aim }
    : { ready: true, movement: copies.movement, handling: copies.handling };
}

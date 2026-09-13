import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { NeuralRuntime } from "../../src/neural/runtime.ts";
import { NeuralReadout } from "../../src/neural/policy.ts";
import { PianoNeuralDecoder } from "./neural-model.ts";
import { PianoActuator, LEG_RANGES } from "./actuator.ts";
import { LEGS, assignedLeg } from "./performance.ts";
import { SCORE, MEASURES } from "./score.ts";
import { encodePianoV1, encodePianoV2, scoreTargets, NEURAL_STEP_MS, PIANO_ENCODER } from "./sensory.ts";

const mapped = process.env.PIANO_EXPERIMENT === "mapped";
const output = new URL(mapped ? "./verification/v2-mapped/" : "./verification/v2/", import.meta.url);
await mkdir(output, { recursive: true });
const started = performance.now(), deadline = started + 240000;
const wallStepMs = 50, epochs = 48;
const read = async url => { const bytes = await readFile(url); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); };
const graph = await NeuralRuntime.load(new URL("../../public/", import.meta.url), { read });
let profile;
if (mapped && process.env.PIANO_REUSE_INPUT_PROBE === "1") {
  ({ profile } = JSON.parse(await readFile(new URL("input-probe.json", output), "utf8")));
  const hash = createHash("sha256").update(JSON.stringify({ ...profile, id: "" })).digest("hex").slice(0, 12);
  assert.equal(profile.id, `${PIANO_ENCODER}-map-${hash}`);
} else if (mapped) {
  console.log("Training-only input probe: seeds 42/101, no task evaluation seeds");
  const runtime = new NeuralRuntime(graph, 42), responses = [];
  try {
    for (let channel = 0; channel < 32; channel++) {
      const mean = new Float64Array(128);
      for (const seed of [42, 101]) {
        runtime.reset(seed); const input = new Float32Array(32); input[channel] = 150;
        for (let step = 0; step < 12; step++) {
          const frame = runtime.advance(input, NEURAL_STEP_MS);
          if (step >= 6) for (let index = 0; index < 128; index++) mean[index] += frame.rates[index] / 12;
        }
      }
      responses.push({ channel, meanHz: mean.reduce((a, b) => a + b, 0) / 128, rates: Array.from(mean) });
    }
  } finally { runtime.dispose(); }
  const cosine = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0) / (Math.hypot(...a) * Math.hypot(...b) || 1);
  const selected = [], remaining = [...responses];
  while (remaining.length) {
    const quality = item => Math.sqrt(item.meanHz) * (selected.length ? Math.max(0.03, 1 - Math.max(...selected.map(prior => cosine(prior.rates, item.rates)))) : 1);
    remaining.sort((a, b) => quality(b) - quality(a) || a.channel - b.channel); selected.push(remaining.shift());
  }
  const slots = [...LEGS.flatMap((_, i) => [i * 4, i * 4 + 1]), ...LEGS.flatMap((_, i) => [i * 4 + 2, i * 4 + 3]), 24, 25, 26, 27, 28, 29, 30, 31];
  const reference = [...selected.slice(0, 12)].sort((a, b) => a.meanHz - b.meanHz)[3].meanHz;
  profile = { id: "", channels: new Array(32), gains: new Array(32) };
  slots.forEach((logical, index) => {
    profile.channels[logical] = selected[index].channel;
    profile.gains[logical] = index < 12 ? Math.min(1, Math.max(0.25, Math.sqrt(reference / selected[index].meanHz))) : index < 24 ? 0.5 : index < 30 ? 0.3 : 0.25;
  });
  profile.id = `${PIANO_ENCODER}-map-${createHash("sha256").update(JSON.stringify(profile)).digest("hex").slice(0, 12)}`;
  await writeFile(new URL("input-probe.json", output), JSON.stringify({ seeds: [42, 101], inputHz: 150, durationMs: 240, profile, responses }, null, 2) + "\n");
}
const sha = async url => createHash("sha256").update(await readFile(url)).digest("hex");
const preserved = {};
for (const name of ["../../docs/media/flythoven-neural.mp4", "../../docs/media/flythoven-neural.png", "./verification/neural-recording/report.json"]) preserved[name] = await sha(new URL(name, import.meta.url));

function sequence(order) {
  let beat = 0;
  return order.flatMap(index => {
    const measure = MEASURES[index], start = beat; beat += measure.duration;
    return SCORE.filter(note => note.beat >= measure.beat && note.beat < measure.beat + measure.duration)
      .map(note => ({ ...note, beat: start + note.beat - measure.beat }));
  }).sort((a, b) => a.beat - b.beat);
}
const original = MEASURES.map((_, index) => index);
const training = [
  { name: "original-96-a", seed: 931, bpm: 96, order: original },
  { name: "original-88", seed: 947, bpm: 88, order: original },
  { name: "rotation-96", seed: 953, bpm: 96, order: [...original.slice(3), ...original.slice(0, 3)] },
  { name: "original-96-b", seed: 967, bpm: 96, order: original },
];
const heldout = mapped ? [
  { name: "reverse-rotation-four-82", seed: 8101, bpm: 82, order: [...original.slice(4), ...original.slice(0, 4)].reverse() },
  { name: "odd-even-measures-94", seed: 9109, bpm: 94, order: [...original.filter((_, i) => i % 2 === 1), ...original.filter((_, i) => i % 2 === 0)] },
] : [
  { name: "reversed-measures-84", seed: 1901, bpm: 84, order: [...original].reverse() },
  { name: "rotation-five-100", seed: 2903, bpm: 100, order: [...original.slice(5), ...original.slice(0, 5)] },
];
const targetClasses = targets => targets.map((note, index) => note ? note.midi - LEG_RANGES[LEGS[index].id][0] + 1 : 0);
function makeDecoder(version) {
  const heads = [];
  const decoder = new PianoNeuralDecoder(options => { const head = new NeuralReadout(options); heads.push(head); return head; }, version, profile?.id, mapped ? "edge" : version === "v1" ? "repeat" : "edge");
  return { decoder, heads };
}
function observedMetrics(notes, events, bpm) {
  const claimed = new Set(), timing = [];
  let wrong = 0, extra = 0, onTime = 0;
  for (const event of events) {
    const near = notes.map((note, index) => ({ note, index, error: event.wallMs - note.beat * 60000 / bpm }))
      .filter(({ note, error }) => assignedLeg(note) === event.legId && note.midi === event.midi && Math.abs(error) <= 250)
      .sort((a, b) => Math.abs(a.error) - Math.abs(b.error));
    const target = near.find(candidate => !claimed.has(candidate.index));
    if (target) { claimed.add(target.index); timing.push(Math.abs(target.error)); if (Math.abs(target.error) <= 75) onTime++; }
    else if (near.length) extra++; else wrong++;
  }
  return { requested: notes.length, performed: events.length, matched: claimed.size, onTime, wrong, extra, missed: notes.length - claimed.size,
    onsetMaeMs: timing.length ? timing.reduce((a, b) => a + b, 0) / timing.length : null };
}
function runCase(version, bundle, config, collect) {
  const runtime = new NeuralRuntime(graph, config.seed), actuator = new PianoActuator(), notes = sequence(config.order);
  bundle.decoder.reset();
  const samples = [], events = [], confusion = bundle.heads.map(head => head.actions.map(() => ({ correct: 0, count: 0 })));
  const durationMs = 12 * 60000 / config.bpm + 300;
  let totalSpikes = 0, neuralSamples = 0, maxLatencyMs = 0;
  try {
    for (let wallMs = 0; wallMs < durationMs; wallMs += wallStepMs) {
      if (performance.now() > deadline) throw new Error("Bounded calibration exceeded 240 seconds; no model promotion");
      const beat = wallMs * config.bpm / 60000, targets = scoreTargets(beat, false, notes), proprio = actuator.snapshot().legs;
      const input = version === "v1" ? encodePianoV1(targets, beat, proprio) : encodePianoV2(targets, beat, config.bpm, proprio, profile);
      const before = performance.now(), frame = runtime.advance(input, NEURAL_STEP_MS);
      maxLatencyMs = Math.max(maxLatencyMs, performance.now() - before); totalSpikes = frame.totalSpikes; neuralSamples++;
      // Physics continues while the same 20 ms recurrent request is outstanding.
      for (let elapsed = 0; elapsed < wallStepMs; elapsed += 10) {
        actuator.advance(10);
        for (const event of actuator.takeContacts()) events.push({ ...event, wallMs: wallMs + elapsed + 10 });
      }
      const labels = targetClasses(targets);
      for (const [index, head] of bundle.heads.entries()) {
        const decision = head.decide(frame, undefined, { sample: false }), bucket = confusion[index][labels[index]];
        bucket.count++; if (decision?.index === labels[index]) bucket.correct++;
      }
      for (const command of bundle.decoder.predict(frame, targets, wallMs, false)) actuator.command(command);
      if (collect) samples.push({ frame: { rates: frame.rates.slice(), tick: frame.tick, simulatedMs: frame.simulatedMs, silenced: frame.silenced }, labels });
    }
    assert.ok(totalSpikes > 0);
    return { samples, confusion, ...observedMetrics(notes, events, config.bpm), neuralSamples, simulatedMs: neuralSamples * NEURAL_STEP_MS, totalSpikes, maxLatencyMs };
  } finally { runtime.dispose(); }
}
function balancedFit(bundle, samples) {
  const updates = samples.length * epochs;
  for (const [index, head] of bundle.heads.entries()) {
    const buckets = head.actions.map((_, target) => samples.filter(sample => sample.labels[index] === target));
    const classes = buckets.flatMap((bucket, target) => bucket.length ? [target] : []);
    for (let step = 0; step < updates; step++) {
      const target = classes[step % classes.length], bucket = buckets[target];
      head.teach(bucket[Math.floor(step / classes.length) % bucket.length].frame, target, 0.2);
    }
  }
}
function aggregate(cases) {
  const metrics = {};
  for (const key of ["requested", "performed", "matched", "onTime", "wrong", "extra", "missed", "neuralSamples", "simulatedMs", "totalSpikes"]) metrics[key] = cases.reduce((sum, trial) => sum + trial[key], 0);
  metrics.onsetMaeMs = metrics.matched ? cases.reduce((sum, trial) => sum + (trial.onsetMaeMs ?? 0) * trial.matched, 0) / metrics.matched : null;
  const buckets = cases[0].confusion.map((head, leg) => head.map((_, target) => cases.reduce((sum, trial) => ({ count: sum.count + trial.confusion[leg][target].count, correct: sum.correct + trial.confusion[leg][target].correct }), { count: 0, correct: 0 })));
  const recalls = buckets.flatMap(head => head.filter(bucket => bucket.count).map(bucket => bucket.correct / bucket.count));
  metrics.balancedAccuracy = recalls.reduce((a, b) => a + b, 0) / recalls.length;
  const active = buckets.flatMap(head => head.slice(1)).reduce((sum, bucket) => ({ count: sum.count + bucket.count, correct: sum.correct + bucket.correct }), { count: 0, correct: 0 });
  metrics.activePitchAccuracy = active.correct / active.count;
  metrics.perLeg = buckets.map((head, index) => ({ legId: LEGS[index].id, classes: head }));
  return metrics;
}

const results = {}, weights = {};
for (const version of ["v1", "v2"]) {
  const bundle = makeDecoder(version), samples = [];
  for (const config of training) {
    console.log(`${version}: continuous training feature collection ${config.name}`);
    samples.push(...runCase(version, bundle, config, true).samples);
  }
  console.log(`${version}: balanced supervised fit, ${samples.length} actual frames x ${epochs} passes/head`);
  balancedFit(bundle, samples); weights[version] = bundle.decoder.export();
  const frozen = JSON.stringify(weights[version]), trials = [];
  for (const config of heldout) {
    console.log(`${version}: FROZEN held-out ${config.name}, seed ${config.seed}`);
    const { samples: _, ...trial } = runCase(version, bundle, config, false); trials.push({ ...config, ...trial });
  }
  assert.equal(JSON.stringify(bundle.decoder.export()), frozen, "Held-out evaluation modified weights");
  results[version] = { trainingFrames: samples.length, retainedRateBytes: samples.length * 128 * 4, updatesPerHead: bundle.heads.map(head => head.updates), trials, aggregate: aggregate(trials) };
  console.log(JSON.stringify({ version, ...results[version].aggregate, perLeg: undefined }));
}
const a = results.v1.aggregate, b = results.v2.aggregate;
const improved = b.balancedAccuracy > a.balancedAccuracy + 0.02 && b.wrong + b.extra + b.missed < a.wrong + a.extra + a.missed && b.matched >= a.matched;
for (const [name, hash] of Object.entries(preserved)) assert.equal(await sha(new URL(name, import.meta.url)), hash);
const report = { schema: 2, encoder: PIANO_ENCODER, modelId: graph.modelId, nodes: graph.nodeCount, edges: graph.edgeCount, elapsedMs: performance.now() - started,
  inputProfile: profile, previousExperiment: mapped ? "Unmapped v2 failed promotion; its completed test is now validation data, not reused here. A mapped baseline run was aborted to fix the decoder confound; no metrics inspected, and its seeds/orders were discarded." : undefined,
  protocol: { neuralStepMs: NEURAL_STEP_MS, wallStepMs, reset: "Once per complete phrase, matching playback loops; never per sample", training, heldout,
    epochs, rate: 0.2, decoderComparison: mapped ? "Both encoders use identical edge-trigger logic; no 150 ms repeat in either" : "v1 repeat versus v2 edge; architecture comparison, not isolated encoder effect",
    inputProbe: mapped ? "Shared graph diagnostic, 768 unlabeled 20 ms frames, seeds 42/101; v2 projection fitted before final test; not additional supervised examples" : undefined,
    teacher: "Offline balanced cross-entropy on actual rate frames; no target-generated motor commands; evaluation weights frozen",
    collection: "Untrained free-running decoder and real actuator proprioception; same 20 ms recurrent advances as browser, nominal 50 ms wall request cadence",
    promotionRule: "At least +2 percentage points balanced accuracy, fewer wrong+extra+missed, and no fewer matched notes, fixed before evaluation" },
  preserved, results, improved, limitations: "Small held-out set; assumed LIF dynamics and engineered interfaces, not measured fly cognition. Offline 50 ms wall cadence approximates variable browser latency. Training proprioception comes from the untrained controller; frozen policy changes that distribution." };
await writeFile(new URL("report.json", output), JSON.stringify(report, null, 2) + "\n");
await writeFile(new URL("candidate-weights.json", output), JSON.stringify({ schema: 2, encoder: profile?.id ?? PIANO_ENCODER, profile, modelId: graph.modelId, nodes: graph.nodeCount, edges: graph.edgeCount,
  neuralStepMs: NEURAL_STEP_MS, wallStepMs, weights: weights.v2, provenance: { kind: "offline-balanced", trainingFrames: results.v2.trainingFrames, epochs, trainingSeeds: training.map(trial => trial.seed), heldoutSeeds: heldout.map(trial => trial.seed), improved } }) + "\n");
console.log(JSON.stringify({ improved, elapsedSeconds: report.elapsedMs / 1000, v1: { ...a, perLeg: undefined }, v2: { ...b, perLeg: undefined } }, null, 2));

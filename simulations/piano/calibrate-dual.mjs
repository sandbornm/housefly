import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { NeuralRuntime } from "../../src/neural/runtime.ts";
import { NeuralReadout } from "../../src/neural/policy.ts";
import { PianoNeuralDecoder } from "./neural-model.ts";
import { PianoDualDecoder, dualTeacherTargets, PIANO_DUAL_DECODER } from "./neural-dual.ts";
import { encodePianoAssociated, ASSOCIATED_PIANO_ENCODER } from "./sensory-associated.ts";
import { encodePianoV1, scoreTargets, NEURAL_STEP_MS } from "./sensory.ts";
import { PianoActuator, LEG_RANGES } from "./actuator.ts";
import { LEGS, assignedLeg } from "./performance.ts";
import { SCORE, MEASURES } from "./score.ts";

const tempo72 = process.env.PIANO_TEMPO72 === "1";
const root = new URL("./", import.meta.url), output = new URL(tempo72 ? "verification/v2b-72/" : "verification/v2b/", root);
await mkdir(output, { recursive: true });
const original = MEASURES.map((_, i) => i), epochs = 48, wallStepMs = 50;
const training = tempo72 ? [
  { seed: 931, bpm: 96, order: original }, { seed: 947, bpm: 88, order: original },
  { seed: 1777, bpm: 72, order: original }, { seed: 1889, bpm: 72, order: [...original.slice(3), ...original.slice(0, 3)] },
] : [
  { seed: 931, bpm: 96, order: original }, { seed: 947, bpm: 88, order: original },
  { seed: 953, bpm: 96, order: [...original.slice(3), ...original.slice(0, 3)] }, { seed: 967, bpm: 96, order: original },
];
const validation = tempo72 ? [] : [{ seed: 1901, bpm: 84, order: [...original].reverse() }, { seed: 2903, bpm: 100, order: [...original.slice(5), ...original.slice(0, 5)] }];
const finalTest = tempo72 ? [
  { seed: 22003, bpm: 72, order: [1, 5, 8, 0, 6, 3, 7, 4, 2] },
  { seed: 24007, bpm: 72, order: [8, 3, 6, 4, 2, 7, 5, 0, 1] },
] : [
  { seed: 12007, bpm: 86, order: [4, 0, 7, 2, 8, 5, 1, 6, 3] },
  { seed: 16001, bpm: 98, order: [6, 2, 5, 8, 1, 4, 0, 3, 7] },
];
const variants = ["v1-edge", "v1-dual", "associated-dual"];
const protocol = { encoder: ASSOCIATED_PIANO_ENCODER, variants, training, validation, finalTest, epochs, learningRate: 0.2,
  tempoComparison: tempo72 ? "All controls and candidate evaluated at the same restored 72 BPM; no comparison of slow-candidate versus fast-baseline" : "Historical faster-tempo evaluation",
  neuralStepMs: NEURAL_STEP_MS, wallStepMs, teacherStrikeWindowMs: [20, 100],
  recurrence: "20 ms continuous neural advances with 50 ms nominal wall/actuator steps; reset only per full phrase, never per sample",
  comparisons: "v1-edge versus v1-dual isolates learned gating; v1-dual versus associated-dual uses identical pitch/strike heads and changes only sensory encoding",
  finalRule: "Associated dual must match at least as many targets as both controls; reduce wrong+extra+missed at least 10% versus v1-edge and not increase it versus v1-dual; no fewer on-time notes than v1-edge and no >2 percentage-point pitch accuracy loss versus either control",
  selection: "All three predefined variants evaluated; no tuning after validation or final test; no performance-based recording selection",
  previousTests: "1901/2903 are now validation. 8101/9109 and aborted 4909 are not reused as final tests." };
await writeFile(new URL("protocol.json", output), JSON.stringify(protocol, null, 2) + "\n");
assert.equal(MEASURES.length, 9); for (const trial of finalTest) assert.equal(new Set(trial.order).size, 9);
const sha = async path => createHash("sha256").update(await readFile(new URL(path, root))).digest("hex");
const preserved = {};
for (const path of ["../../docs/media/flythoven-neural.mp4", "../../docs/media/flythoven-neural.png", "verification/neural-recording/report.json", "verification/v2/report.json", "verification/v2-mapped/report.json", ...(tempo72 ? ["calibration-v2a-report.json", "calibration-v2b-report.json"] : [])]) preserved[path] = await sha(path);
if (!tempo72) await writeFile(new URL("calibration-v2a-report.json", root), JSON.stringify({
  note: "Preserved earlier v2a experiments; neither met its promotion criterion",
  unmapped: JSON.parse(await readFile(new URL("verification/v2/report.json", root), "utf8")),
  mapped: JSON.parse(await readFile(new URL("verification/v2-mapped/report.json", root), "utf8")),
}, null, 2) + "\n");
const started = performance.now(), deadline = started + 360000;
const graph = await NeuralRuntime.load(new URL("../../public/", root), { read: async url => { const b = await readFile(url); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } });

function sequence(order) {
  let beat = 0;
  return order.flatMap(index => {
    const measure = MEASURES[index], start = beat; beat += measure.duration;
    return SCORE.filter(note => note.beat >= measure.beat && note.beat < measure.beat + measure.duration)
      .map(note => ({ ...note, beat: start + note.beat - measure.beat }));
  }).sort((a, b) => a.beat - b.beat);
}
function bundle(variant) {
  const heads = [], factory = options => { const head = new NeuralReadout(options); heads.push(head); return head; };
  const dual = variant !== "v1-edge", encoder = variant === "associated-dual" ? ASSOCIATED_PIANO_ENCODER : "global-union-v1";
  return { heads, dual, decoder: dual ? new PianoDualDecoder(factory, encoder) : new PianoNeuralDecoder(factory, "v1", undefined, "edge") };
}
function scoreEvents(notes, events, bpm) {
  const claimed = new Set(), errors = []; let wrong = 0, extra = 0, onTime = 0;
  for (const event of events) {
    const candidates = notes.map((note, index) => ({ note, index, error: event.wallMs - note.beat * 60000 / bpm }))
      .filter(({ note, error }) => assignedLeg(note) === event.legId && note.midi === event.midi && Math.abs(error) <= 250).sort((a, b) => Math.abs(a.error) - Math.abs(b.error));
    const target = candidates.find(item => !claimed.has(item.index));
    if (target) { claimed.add(target.index); errors.push(Math.abs(target.error)); if (Math.abs(target.error) <= 75) onTime++; }
    else if (candidates.length) extra++; else wrong++;
  }
  return { requested: notes.length, performed: events.length, matched: claimed.size, wrong, extra, missed: notes.length - claimed.size, onTime,
    onsetAbsoluteErrorSum: errors.reduce((a, b) => a + b, 0) };
}
function trial(variant, fitted, config, collect) {
  const runtime = new NeuralRuntime(graph, config.seed), actuator = new PianoActuator(), notes = sequence(config.order), samples = [], events = [];
  const perLeg = LEGS.map(leg => ({ id: leg.id, pitchCorrect: 0, pitchCount: 0, gateTP: 0, gateFP: 0, gateFN: 0, gateTN: 0, contacts: 0 }));
  fitted.decoder.reset(); let frames = 0, totalSpikes = 0;
  try {
    for (let wallMs = 0; wallMs < 12 * 60000 / config.bpm + 300; wallMs += wallStepMs) {
      if (performance.now() > deadline) throw new Error("360-second bounded experiment exhausted; no promotion");
      const beat = wallMs * config.bpm / 60000, targets = scoreTargets(beat, false, notes), limbs = actuator.snapshot().legs;
      const input = variant === "associated-dual" ? encodePianoAssociated(targets, beat, config.bpm, limbs) : encodePianoV1(targets, beat, limbs);
      const frame = runtime.advance(input, NEURAL_STEP_MS); frames++; totalSpikes = frame.totalSpikes;
      for (let step = 0; step < wallStepMs; step += 10) {
        actuator.advance(10);
        for (const event of actuator.takeContacts()) { events.push({ ...event, wallMs: wallMs + step + 10 }); perLeg.find(leg => leg.id === event.legId).contacts++; }
      }
      const dualLabels = dualTeacherTargets(targets, beat, config.bpm);
      const labels = fitted.dual ? dualLabels : targets.map((note, index) => note ? note.midi - LEG_RANGES[LEGS[index].id][0] + 1 : 0);
      for (const [index, leg] of perLeg.entries()) {
        const pitch = fitted.heads[fitted.dual ? index * 2 : index].decide(frame, undefined, { sample: false });
        if (targets[index]) { leg.pitchCount++; if (Number(pitch?.action) === targets[index].midi) leg.pitchCorrect++; }
        if (fitted.dual) {
          const gate = fitted.heads[index * 2 + 1].decide(frame, undefined, { sample: false })?.index === 1, target = dualLabels[index * 2 + 1] === 1;
          leg[gate ? target ? "gateTP" : "gateFP" : target ? "gateFN" : "gateTN"]++;
        }
      }
      const commands = fitted.dual ? fitted.decoder.predict(frame) : fitted.decoder.predict(frame, targets, wallMs, false);
      for (const command of commands) actuator.command(command);
      if (collect) samples.push({ frame: { rates: frame.rates.slice(), tick: frame.tick, simulatedMs: frame.simulatedMs, silenced: frame.silenced }, labels });
    }
    assert.ok(totalSpikes > 0);
    return { samples, ...scoreEvents(notes, events, config.bpm), perLeg, frames, totalSpikes, simulatedMs: frames * NEURAL_STEP_MS };
  } finally { runtime.dispose(); }
}
function fit(fitted, samples) {
  for (const [index, head] of fitted.heads.entries()) {
    const buckets = head.actions.map((_, target) => samples.filter(sample => sample.labels[index] === target));
    const classes = buckets.flatMap((bucket, target) => bucket.length ? [target] : []);
    assert.ok(classes.length > 0);
    for (let step = 0; step < samples.length * epochs; step++) {
      const target = classes[step % classes.length], bucket = buckets[target];
      head.teach(bucket[Math.floor(step / classes.length) % bucket.length].frame, target, 0.2);
    }
  }
}
function summarize(trials) {
  const result = {};
  for (const key of ["requested", "performed", "matched", "wrong", "extra", "missed", "onTime", "onsetAbsoluteErrorSum", "frames", "simulatedMs", "totalSpikes"]) result[key] = trials.reduce((sum, current) => sum + current[key], 0);
  result.onsetMaeMs = result.matched ? result.onsetAbsoluteErrorSum / result.matched : null;
  result.perLeg = LEGS.map((leg, index) => {
    const counts = { id: leg.id };
    for (const key of ["pitchCorrect", "pitchCount", "gateTP", "gateFP", "gateFN", "gateTN", "contacts"]) counts[key] = trials.reduce((sum, current) => sum + current.perLeg[index][key], 0);
    return counts;
  });
  result.activePitchAccuracy = result.perLeg.reduce((sum, leg) => sum + leg.pitchCorrect, 0) / result.perLeg.reduce((sum, leg) => sum + leg.pitchCount, 0);
  return result;
}
const fitted = {}, results = {};
for (const variant of variants) {
  fitted[variant] = bundle(variant); const samples = [];
  for (const config of training) { console.log(`${variant}: train features seed ${config.seed}`); samples.push(...trial(variant, fitted[variant], config, true).samples); }
  fit(fitted[variant], samples);
  const validationTrials = [];
  for (const config of validation) { console.log(`${variant}: validation seed ${config.seed}`); const { samples: _, ...value } = trial(variant, fitted[variant], config, false); validationTrials.push({ ...config, ...value }); }
  results[variant] = { trainingFrames: samples.length, retainedRateBytes: samples.length * 128 * 4, updatesPerHead: fitted[variant].heads.map(head => head.updates),
    validationTrials, validation: validationTrials.length ? summarize(validationTrials) : null };
  console.log(JSON.stringify({ variant, validation: { ...results[variant].validation, perLeg: undefined } }));
}
// No parameter changes or teacher updates occur between validation and final test.
for (const variant of variants) {
  const frozen = JSON.stringify(fitted[variant].decoder.export()), finalTrials = [];
  for (const config of finalTest) { console.log(`${variant}: FINAL TEST seed ${config.seed}, BPM ${config.bpm}`); const { samples: _, ...value } = trial(variant, fitted[variant], config, false); finalTrials.push({ ...config, ...value }); }
  assert.equal(JSON.stringify(fitted[variant].decoder.export()), frozen);
  Object.assign(results[variant], { finalTrials, final: summarize(finalTrials) });
}
const edge = results["v1-edge"].final, control = results["v1-dual"].final, candidate = results["associated-dual"].final;
const errors = result => result.wrong + result.extra + result.missed;
const improved = candidate.matched >= Math.max(edge.matched, control.matched) && errors(candidate) <= errors(edge) * 0.9 && errors(candidate) <= errors(control)
  && candidate.onTime >= edge.onTime && candidate.activePitchAccuracy >= Math.max(edge.activePitchAccuracy, control.activePitchAccuracy) - 0.02;
for (const [path, hash] of Object.entries(preserved)) assert.equal(await sha(path), hash);
const report = { schema: 3, encoder: ASSOCIATED_PIANO_ENCODER, architecture: PIANO_DUAL_DECODER, modelId: graph.modelId, nodes: graph.nodeCount, edges: graph.edgeCount,
  protocol, results, improved, preserved, elapsedMs: performance.now() - started,
  limitations: "Small fixed test set, no biological-skill claim. LIF dynamics and task interfaces are engineered. 50 ms offline wall cadence approximates variable browser latency. Training proprioception was generated by untrained policies; learned policies shift that distribution. Pitch heads ignore rest labels; binary strike heads train both classes." };
const artifact = { schema: 3, encoder: ASSOCIATED_PIANO_ENCODER, architecture: PIANO_DUAL_DECODER, modelId: graph.modelId, nodes: graph.nodeCount, edges: graph.edgeCount,
  neuralStepMs: NEURAL_STEP_MS, wallStepMs, weights: fitted["associated-dual"].decoder.export(),
  provenance: { kind: "offline-balanced", trainingFrames: results["associated-dual"].trainingFrames, epochs, trainingSeeds: training.map(t => t.seed), validationSeeds: validation.map(t => t.seed), heldoutSeeds: finalTest.map(t => t.seed), improved } };
await writeFile(new URL("report.json", output), JSON.stringify(report, null, 2) + "\n");
await writeFile(new URL(tempo72 ? "calibration-v2b-72-report.json" : "calibration-v2b-report.json", root), JSON.stringify(report, null, 2) + "\n");
await writeFile(new URL("calibration-v2.json", root), JSON.stringify(artifact) + "\n");
console.log(JSON.stringify({ improved, elapsedSeconds: report.elapsedMs / 1000, final: Object.fromEntries(variants.map(variant => [variant, { ...results[variant].final, perLeg: undefined }])) }, null, 2));

import { LEG_RANGES } from "./actuator.ts";
import type { MotorCommand } from "./actuator.ts";
import { LEGS } from "./performance.ts";
import type { SensoryTarget } from "./sensory.ts";
import type { ReadoutFrame } from "../../src/neural/policy.ts";
import type { PianoReadout, ReadoutFactory } from "./neural-model.ts";

export const PIANO_DUAL_DECODER = "pitch-strike-v1";
export const DUAL_REPLAY_BYTES = (37 + 12) * 12 * 128 * 4;

// Teacher-only labels for an observed score window. Inference never calls this.
export function dualTeacherTargets(targets: readonly (SensoryTarget | null)[], beat: number, bpm: number): (number | null)[] {
  if (targets.length !== 6 || !Number.isFinite(beat) || !Number.isFinite(bpm) || bpm <= 0) throw new Error("Invalid piano teaching observation");
  return targets.flatMap((target, index) => {
    if (!target) return [null, 0];
    const pitch = target.midi - LEG_RANGES[LEGS[index].id][0], untilMs = (target.beat - beat) * 60000 / bpm;
    return [pitch, untilMs >= 20 && untilMs <= 100 ? 1 : 0];
  });
}

export class PianoDualDecoder {
  readonly version = "v2";
  readonly encoderId: string;
  private heads: PianoReadout[];
  private gates = LEGS.map(() => false);
  private predictions = 0;
  private predictedTick = -1;
  private examples: Map<number, ReadoutFrame[]>[];
  private cursors: number[];

  constructor(factory: ReadoutFactory, encoderId: string) {
    this.encoderId = encoderId;
    this.heads = LEGS.flatMap((leg, index) => {
      const [low, high] = LEG_RANGES[leg.id];
      return [
        factory({ actions: Array.from({ length: high - low + 1 }, (_, i) => String(low + i)), modelId: `${encoderId}-${PIANO_DUAL_DECODER}-pitch-${leg.id}`, seed: 931 + index }),
        factory({ actions: ["hold", "strike"], modelId: `${encoderId}-${PIANO_DUAL_DECODER}-strike-${leg.id}`, seed: 1931 + index }),
      ];
    });
    this.examples = this.heads.map(() => new Map()); this.cursors = this.heads.map(() => 0);
  }

  // Deliberately no score, beat, elapsed time, target identity or allowed-action mask.
  predict(frame: ReadoutFrame): MotorCommand[] {
    this.predictedTick = frame.tick;
    if (frame.silenced || !Array.from(frame.rates).some(rate => rate > 0)) { this.gates.fill(false); return []; }
    const commands: MotorCommand[] = [];
    for (const [index, leg] of LEGS.entries()) {
      const pitch = this.heads[index * 2].decide(frame, undefined, { sample: false });
      const strike = this.heads[index * 2 + 1].decide(frame, undefined, { sample: false });
      const gate = strike?.index === 1;
      this.predictions += 2;
      if (gate && !this.gates[index] && pitch) commands.push({ legId: leg.id, midi: Number(pitch.action), velocity: leg.side < 0 ? 0.45 : 0.62,
        holdMs: 85, requestedNoteIndex: null, neuralTick: frame.tick, neuralSimulatedMs: frame.simulatedMs });
      this.gates[index] = gate;
    }
    return commands;
  }

  learn(frame: ReadoutFrame, labels: readonly (number | null)[]): void {
    if (frame.tick !== this.predictedTick) throw new Error("Piano teacher must follow prediction");
    if (frame.silenced || !Array.from(frame.rates).some(rate => rate > 0)) return;
    if (labels.length !== this.heads.length) throw new Error("Invalid piano teacher labels");
    for (const [index, head] of this.heads.entries()) {
      const target = labels[index]; if (target === null) continue;
      head.teach(frame, target, 0.08);
      const bucket = this.examples[index].get(target) ?? [];
      bucket.push({ rates: Float32Array.from(frame.rates), tick: frame.tick, simulatedMs: frame.simulatedMs, silenced: frame.silenced });
      if (bucket.length > 12) bucket.shift(); this.examples[index].set(target, bucket);
      const classes = [...this.examples[index].keys()].sort((a, b) => a - b), cursor = this.cursors[index]++;
      const replayTarget = classes[cursor % classes.length], samples = this.examples[index].get(replayTarget)!;
      head.teach(samples[Math.floor(cursor / classes.length) % samples.length], replayTarget, 0.08);
    }
  }

  reset(): void { this.gates.fill(false); this.predictedTick = -1; }
  export() { return { schema: 3, architecture: PIANO_DUAL_DECODER, encoder: this.encoderId, readouts: this.heads.map(head => head.export?.()) }; }
  restore(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const saved = value as ReturnType<PianoDualDecoder["export"]>;
    if (saved.schema !== 3 || saved.architecture !== PIANO_DUAL_DECODER || saved.encoder !== this.encoderId || !Array.isArray(saved.readouts) || saved.readouts.length !== 12) return false;
    const previous = this.heads.map(head => head.export?.());
    if (this.heads.every((head, index) => head.restore?.(saved.readouts[index]))) return true;
    this.heads.forEach((head, index) => head.restore?.(previous[index])); return false;
  }
  snapshot() {
    const replayFrames = this.examples.reduce((sum, buckets) => sum + [...buckets.values()].reduce((total, frames) => total + frames.length, 0), 0);
    return { encoder: this.encoderId, architecture: PIANO_DUAL_DECODER, strikeMode: "learned-edge", predictions: this.predictions, replayFrames,
      replayRateBytes: replayFrames * 128 * 4, gates: LEGS.map((leg, index) => ({ legId: leg.id, strike: this.gates[index] })),
      updates: this.heads.map((head, index) => ({ legId: LEGS[Math.floor(index / 2)].id, head: index % 2 ? "strike" : "pitch", updates: head.updates })) };
  }
}

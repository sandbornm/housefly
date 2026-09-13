import { PianoActuator, LEG_RANGES } from "./actuator.ts";
import type { MotorCommand } from "./actuator.ts";
import { PianoAssessment } from "./assessment.ts";
import { LEGS } from "./performance.ts";
import { normalizeBeat } from "./score.ts";
import type { LegId } from "./performance.ts";
import type { NeuralFrame } from "../../src/neural/runtime.ts";
import type { ReadoutFrame } from "../../src/neural/policy.ts";
import { encodePianoV1, encodePianoV2, scoreTargets, PIANO_ENCODER } from "./sensory.ts";
import type { PianoInputProfile } from "./sensory.ts";

export type PianoNeuralFrame = NeuralFrame;
export interface PianoNeuralRuntime {
  advance(rates: Float32Array, milliseconds: number): PianoNeuralFrame;
  reset(): void; silence(enabled: boolean): void; snapshot(): unknown; dispose(): void;
}
export interface PianoReadout {
  decide(frame: ReadoutFrame, allowed?: number[], options?: { sample?: boolean }): { index: number; action: string; tick: number } | null;
  teach(frame: ReadoutFrame, target: number, rate?: number): void;
  updates: number;
  export?(): unknown;
  restore?(value: unknown): boolean;
}
export type ReadoutFactory = (options: { actions: string[]; modelId: string; seed: number }) => PianoReadout;

export function requestedTargets(beat: number, loop: boolean) {
  return scoreTargets(beat, loop);
}

// Compact sensory encoding, not a 37-way pitch identity or an inference shortcut.
// 0..11 pitch classes; 12..15 octaves; 16..21 target limbs; 22..27 proprioception;
// 28 beat phase; 29 measure phase; 30 tonic input; 31 requested polyphony.
export function pianoSensory(beat: number, loop: boolean, actuator: PianoActuator, bpm = 96, version: "v1" | "v2" = "v1", profile?: PianoInputProfile): Float32Array {
  const targets = requestedTargets(beat, loop), legs = actuator.snapshot().legs;
  return version === "v1" ? encodePianoV1(targets, beat, legs) : encodePianoV2(targets, normalizeBeat(beat, loop), bpm, legs, profile);
}

export class PianoNeuralDecoder {
  readonly version: "v1" | "v2";
  readonly encoderId: string;
  readonly strikeMode: "repeat" | "edge";
  private readouts: PianoReadout[];
  private commands = new Map<LegId, { index: number; time: number }>();
  private predictions = 0;
  private examples = LEGS.map(() => new Map<number, ReadoutFrame[]>());
  private replayCursor = LEGS.map(() => 0);

  constructor(factory: ReadoutFactory, version: "v1" | "v2" = "v1", encoderId = PIANO_ENCODER, strikeMode: "repeat" | "edge" = version === "v1" ? "repeat" : "edge") {
    this.version = version;
    this.encoderId = version === "v1" ? "global-union-v1" : encoderId;
    this.strikeMode = strikeMode;
    this.readouts = LEGS.map((leg, index) => {
      const [low, high] = LEG_RANGES[leg.id];
      return factory({ actions: ["rest", ...Array.from({ length: high - low + 1 }, (_, offset) => String(low + offset))], modelId: version === "v1" ? `flythoven-${leg.id}-v1` : `${encoderId}-${leg.id}-edge-v2`, seed: 931 + index });
    });
  }

  predict(frame: PianoNeuralFrame, targets: ReturnType<typeof requestedTargets>, time: number, calibrating: boolean): MotorCommand[] {
    const commands: MotorCommand[] = [];
    for (const [index, leg] of LEGS.entries()) {
      const readout = this.readouts[index];
      const decision = readout.decide(frame, undefined, { sample: false });
      if (!decision || frame.silenced || !frame.rates.some(rate => rate > 0)) continue;
      this.predictions++;
      const last = this.commands.get(leg.id);
      if (decision.index > 0 && (!last || decision.index !== last.index || (this.strikeMode === "repeat" && time - last.time >= 150))) {
        const midi = Number(decision.action);
        commands.push({ legId: leg.id, midi, velocity: leg.side < 0 ? 0.45 : 0.62, holdMs: 85, requestedNoteIndex: targets[index]?.noteIndex ?? null, neuralTick: frame.tick, neuralSimulatedMs: frame.simulatedMs });
        this.commands.set(leg.id, { index: decision.index, time });
      } else if (decision.index === 0) this.commands.delete(leg.id);
      // Teacher feedback follows the prediction; it is never used to choose this action.
      if (calibrating) {
        const target = targets[index] ? targets[index]!.midi - LEG_RANGES[leg.id][0] + 1 : 0;
        readout.teach(frame, target, target === 0 ? 0.004 : 0.08);
        const bucket = this.examples[index].get(target) ?? [];
        bucket.push({ rates: frame.rates.slice(), tick: frame.tick, simulatedMs: frame.simulatedMs, silenced: frame.silenced });
        if (bucket.length > 12) bucket.shift();
        this.examples[index].set(target, bucket);
        // Balanced replay of previously predicted neural observations prevents rare limbs
        // from learning only the much more frequent rest class. No motor action is replayed.
        const classes = [...this.examples[index].keys()].sort((a, b) => a - b);
        if (classes.length > 1) {
          const cursor = this.replayCursor[index]++, replayTarget = classes[cursor % classes.length];
          const samples = this.examples[index].get(replayTarget)!;
          readout.teach(samples[Math.floor(cursor / classes.length) % samples.length], replayTarget, 0.08);
        }
      }
    }
    return commands;
  }
  reset(): void { this.commands.clear(); }
  export() { return { version: this.version, encoder: this.encoderId, strikeMode: this.strikeMode, readouts: this.readouts.map(readout => readout.export?.()) }; }
  restore(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const saved = value as ReturnType<PianoNeuralDecoder["export"]>;
    if (saved.version !== this.version || saved.encoder !== this.encoderId || saved.strikeMode !== this.strikeMode || !Array.isArray(saved.readouts) || saved.readouts.length !== 6) return false;
    const previous = this.readouts.map(readout => readout.export?.());
    if (this.readouts.every((readout, index) => readout.restore?.(saved.readouts[index]))) return true;
    this.readouts.forEach((readout, index) => readout.restore?.(previous[index])); return false;
  }
  snapshot() {
    const replayFrames = this.examples.reduce((sum, classes) => sum + [...classes.values()].reduce((count, frames) => count + frames.length, 0), 0);
    return { encoder: this.encoderId, strikeMode: this.strikeMode, predictions: this.predictions, replayFrames, replayRateBytes: replayFrames * 128 * Float32Array.BYTES_PER_ELEMENT,
      updates: this.readouts.map((readout, index) => ({ legId: LEGS[index].id, updates: readout.updates })) };
  }
}

// Synchronous harness used by pure tests and offline model checks. The browser runs
// neural core in the shared worker; this decoder and its actuator stay on the main thread.
export class PianoNeuralController {
  readonly actuator = new PianoActuator();
  readonly assessment = new PianoAssessment();
  private decoder: PianoNeuralDecoder;
  private runtime: PianoNeuralRuntime;
  private frame: PianoNeuralFrame;
  private decisionMs = 50;
  private accepted = 0;
  private lastInput: Float32Array = new Float32Array(32);
  private silenced = false;
  private calibrating = true;

  constructor(runtime: PianoNeuralRuntime, factory: ReadoutFactory) {
    this.runtime = runtime; this.decoder = new PianoNeuralDecoder(factory);
    this.frame = runtime.advance(new Float32Array(32), 0);
  }

  update(milliseconds: number, beat: number, bpm: number, loop: boolean, calibrating: boolean): void {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return;
    this.calibrating = calibrating;
    this.lastInput = pianoSensory(beat, loop, this.actuator);
    this.frame = this.runtime.advance(this.lastInput, milliseconds);
    this.actuator.advance(milliseconds);
    const contacts = this.actuator.takeContacts();
    for (const event of contacts) this.assessment.record(event, beat, bpm);
    this.contacts.push(...contacts); this.assessment.update(beat, bpm);
    this.decisionMs += milliseconds;
    if (this.decisionMs < 50) return;
    this.decisionMs %= 50;
    for (const command of this.decoder.predict(this.frame, requestedTargets(beat, loop), this.actuator.snapshot().timeMs, calibrating)) {
      if (this.actuator.command(command)) this.accepted++;
    }
  }

  private contacts: ReturnType<PianoActuator["takeContacts"]> = [];
  takeContacts() { const contacts = this.contacts; this.contacts = []; return contacts; }
  get neuralFrame() { return this.frame; }
  get isCalibrating() { return this.calibrating; }
  reset(beat = 0): void {
    this.runtime.reset(); this.runtime.silence(this.silenced); this.actuator.reset(); this.assessment.reset(beat);
    this.frame = this.runtime.advance(new Float32Array(32), 0); this.contacts = []; this.decoder.reset(); this.decisionMs = 50;
  }
  silence(enabled: boolean): void { this.silenced = enabled; this.runtime.silence(enabled); this.actuator.reset(); this.contacts = []; this.decoder.reset(); }
  snapshot() { return { ready: true, mode: "neural", calibrating: this.calibrating, silenced: this.silenced, ...this.decoder.snapshot(), acceptedCommands: this.accepted,
    sensory: Array.from(this.lastInput),
    runtime: this.frame ? { tick: this.frame.tick, simulatedMs: this.frame.simulatedMs, totalSpikes: this.frame.totalSpikes, silenced: this.frame.silenced,
      spikeCount: this.frame.spikes.length, poolRates: Array.from(this.frame.rates), nodes: this.frame.levels.length } : null,
    actuator: this.actuator.snapshot(), assessment: this.assessment.snapshot() }; }
  dispose(): void { this.runtime.dispose(); }
}

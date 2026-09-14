import { PianoActuator } from "./actuator.ts";
import { PianoAssessment } from "./assessment.ts";
import { PianoNeuralDecoder, pianoSensory, requestedTargets } from "./neural-model.ts";
import { NeuralReadout } from "../../src/neural/policy.ts";
import type { PianoNeuralFrame } from "./neural-model.ts";
import { validatePianoCalibration } from "./calibration-model.ts";
import type { PianoCalibration } from "./calibration-model.ts";
import type { PianoInputProfile } from "./sensory.ts";
import { NEURAL_STEP_MS } from "./sensory.ts";
import { encodePianoAssociated } from "./sensory-associated.ts";
import { PianoDualDecoder, dualTeacherTargets } from "./neural-dual.ts";
import { normalizeBeat } from "./score.ts";

export interface PianoModelInfo { modelId: string; nodes: number; edges: number }
export interface PianoAsyncRuntime {
  graph: { nodeCount: number; edgeCount: number; modelId: string };
  advance(rates: Float32Array, milliseconds: number): Promise<PianoNeuralFrame>;
  snapshot(): Promise<PianoNeuralFrame>;
  reset(): Promise<unknown>; silence(enabled: boolean): Promise<unknown>; dispose(): Promise<unknown>;
}

export class PianoNeuralSession {
  readonly actuator = new PianoActuator();
  readonly assessment = new PianoAssessment();
  readonly ready: Promise<PianoModelInfo>;
  private client?: PianoAsyncRuntime;
  private frame: PianoNeuralFrame | null = null;
  private epoch = 0;
  private requestId = 0;
  private busy = false;
  private playing = true;
  private silenced = false;
  private calibrating = false;
  private disposed = false;
  private accepted = 0;
  private decoder: PianoNeuralDecoder | PianoDualDecoder = new PianoNeuralDecoder(options => new NeuralReadout(options));
  private inputProfile?: PianoInputProfile;
  private calibrationSource: PianoCalibration["provenance"] | { kind: "cold" } = { kind: "cold" };
  private sensory: Float32Array = new Float32Array(32);
  private contacts: ReturnType<PianoActuator["takeContacts"]> = [];
  private onError: (error: Error) => void;
  private lastLatencyMs = 0;
  private controlTail: Promise<void> = Promise.resolve();

  constructor(createClient: () => Promise<PianoAsyncRuntime>, onError: (error: Error) => void,
    options?: { calibration: () => Promise<unknown>; cold?: boolean }) {
    this.onError = onError;
    this.ready = createClient().then(async client => {
      this.client = client;
      if (this.disposed) { await client.dispose(); throw new Error("Piano closed during model load"); }
      if (options) {
        const calibration = validatePianoCalibration(await options.calibration(), client.graph);
        if (this.disposed) throw new Error("Piano closed during calibration load");
        this.decoder = calibration.schema === 3 ? new PianoDualDecoder(config => new NeuralReadout(config), calibration.encoder)
          : new PianoNeuralDecoder(config => new NeuralReadout(config), "v2", calibration.encoder);
        if (!options.cold && !this.decoder.restore(calibration.weights)) throw new Error("Piano calibrated readout weights are invalid");
        this.inputProfile = calibration.schema === 2 ? calibration.profile : undefined;
        this.calibrationSource = options.cold ? { kind: "cold" } : calibration.provenance;
        this.calibrating = false;
      }
      this.frame = await client.snapshot();
      return { modelId: client.graph.modelId, nodes: client.graph.nodeCount, edges: client.graph.edgeCount };
    }).catch(error => { this.fail(error); throw error; });
  }

  private fail(error: unknown): void {
    if (this.disposed) return;
    this.onError(error instanceof Error ? error : new Error(String(error))); this.dispose();
  }

  update(milliseconds: number, beat: number, bpm: number, loop: boolean, calibrating: boolean): void {
    if (this.disposed || !this.frame || !this.client || !this.playing) return;
    this.calibrating = calibrating;
    this.actuator.advance(milliseconds);
    const contacts = this.actuator.takeContacts();
    for (const event of contacts) this.assessment.record(event, beat, bpm);
    this.contacts.push(...contacts); this.assessment.update(beat, bpm);
    if (!this.busy) {
      this.busy = true;
      this.sensory = this.decoder instanceof PianoDualDecoder
        ? encodePianoAssociated(requestedTargets(beat, loop), normalizeBeat(beat, loop), bpm, this.actuator.snapshot().legs)
        : pianoSensory(beat, loop, this.actuator, bpm, this.decoder.version, this.inputProfile);
      const requestId = ++this.requestId, epoch = this.epoch, requested = requestedTargets(beat, loop);
      const time = this.actuator.snapshot().timeMs, started = performance.now();
      // Model time is explicit and independent of the score's wall clock. Only one
      // genuine 20 ms model request is in flight; no stale command queue is replayed.
      void this.client.advance(this.sensory, NEURAL_STEP_MS).then(frame => {
        if (this.disposed || epoch !== this.epoch || !this.playing) return;
        this.frame = frame; this.lastLatencyMs = performance.now() - started;
        const commands = this.decoder instanceof PianoDualDecoder ? this.decoder.predict(frame)
          : this.decoder.predict(frame, requested, time, calibrating && this.calibrating);
        if (!this.silenced) {
          for (const command of commands) if (this.actuator.command(command)) this.accepted++;
          if (this.decoder instanceof PianoDualDecoder && calibrating && this.calibrating) this.decoder.learn(frame, dualTeacherTargets(requested, normalizeBeat(beat, loop), bpm));
        }
      }).catch(error => { if (epoch === this.epoch) this.fail(error); }).finally(() => { if (requestId === this.requestId) this.busy = false; });
    }
  }
  takeContacts() { const contacts = this.contacts; this.contacts = []; return contacts; }
  get neuralFrame() { return this.frame; }
  get isCalibrating() { return this.calibrating; }
  get version() { return this.decoder.version; }
  setCalibrating(value: boolean): void { this.calibrating = value; }
  setPlaying(playing: boolean): void { if (this.playing && !playing) this.epoch++; this.playing = playing; }
  reset(beat = 0): void {
    this.actuator.reset(); this.assessment.reset(beat); this.contacts = []; this.decoder.reset();
    void this.changeState(true);
  }
  silence(enabled: boolean): Promise<void> {
    this.silenced = enabled; this.actuator.reset(); this.contacts = []; this.decoder.reset();
    return this.changeState(false);
  }
  private changeState(reset: boolean): Promise<void> {
    if (!this.client || this.disposed) return Promise.resolve();
    const epoch = ++this.epoch, requestId = ++this.requestId; this.busy = true;
    this.controlTail = this.controlTail.then(async () => {
      if (this.disposed || epoch !== this.epoch) return;
      if (reset) await this.client!.reset();
      if (this.disposed || epoch !== this.epoch) return;
      await this.client!.silence(this.silenced);
      if (this.disposed || epoch !== this.epoch) return;
      const frame = await this.client!.snapshot();
      if (!this.disposed && epoch === this.epoch) this.frame = frame;
    }).catch(error => { if (epoch === this.epoch) this.fail(error); })
      .finally(() => { if (requestId === this.requestId) this.busy = false; });
    return this.controlTail;
  }
  snapshot() { return { ready: Boolean(this.frame) && !this.disposed, mode: "neural", worker: true, version: this.version, calibrationSource: this.calibrationSource,
    calibrating: this.calibrating, silenced: this.silenced, ...this.decoder.snapshot(),
    acceptedCommands: this.accepted, requestLatencyMs: this.lastLatencyMs, sensory: Array.from(this.sensory), runtime: this.frame ? { tick: this.frame.tick, simulatedMs: this.frame.simulatedMs,
      totalSpikes: this.frame.totalSpikes, silenced: this.frame.silenced, spikeCount: this.frame.spikes.length, poolRates: Array.from(this.frame.rates), nodes: this.frame.levels.length } : null,
    actuator: this.actuator.snapshot(), assessment: this.assessment.snapshot() }; }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.epoch++; this.actuator.reset();
    void this.client?.dispose().catch(() => {});
  }
}

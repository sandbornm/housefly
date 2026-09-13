import { NeuralReadout, type ReadoutFrame } from '../../src/neural/policy.ts';
import { calibrationObservation, teacherAction } from './calibration.ts';
import { decodeFlight, encodeFlight, FLIGHT_ACTIONS, NEURAL_WINDOW_MS, unpowered, type FlightNeuralFrame, type FlightObservation } from './neural.ts';

export interface FlightRuntime {
  advance(inputs: Float32Array, milliseconds: number): FlightNeuralFrame | Promise<FlightNeuralFrame>;
  reset(): void | Promise<unknown>;
  silence(value: boolean): void | Promise<unknown>;
  snapshot(): FlightNeuralFrame | Promise<FlightNeuralFrame>;
  dispose(): void | Promise<unknown>;
}

export class NeuralPilot {
  readonly readout: NeuralReadout;
  readonly model: { modelId: string; edgeCount: number };
  private runtime: FlightRuntime;
  readonly calibrationTrials = 84;
  phase: 'uncalibrated' | 'calibration' | 'inference' | 'failed' = 'uncalibrated';
  frame: FlightNeuralFrame | undefined;
  command = unpowered();
  silenced = false;
  failure = '';
  samples = 0;
  lastLoss = 0;
  latencyMs = 0;
  completedRequests = 0;
  private lastTick = -1;
  private disposed = false;
  private revision = 0;
  private operations = 0;
  private work: Promise<void> = Promise.resolve();
  private pending: (() => void) | undefined;
  private rehearsal: { frame: ReadoutFrame; target: number }[] = [];

  constructor(runtime: FlightRuntime, model: { modelId: string; edgeCount: number }) {
    this.runtime = runtime; this.model = model;
    this.readout = new NeuralReadout({ actions: FLIGHT_ACTIONS, modelId: `${model.modelId}:flylot-sensory32-readout128-v1`, seed: 8731 });
  }

  get busy(): boolean { return this.operations > 0 || Boolean(this.pending); }

  // Worker replies become visible only at a physical step, never during pause.
  commit(): void {
    if (this.operations > 0) return;
    const pending = this.pending; this.pending = undefined;
    try { pending?.(); } catch (error) { this.fail(error); }
  }

  private run(operation: (revision: number) => Promise<void>): Promise<void> {
    const revision = this.revision;
    this.operations++;
    this.work = this.work.then(async () => { if (!this.disposed && this.phase !== 'failed') await operation(revision); })
      .catch(error => { if (!this.disposed) this.fail(error); }).finally(() => { this.operations--; });
    return this.work;
  }

  private stage(revision: number, commit: () => void): void {
    if (!this.disposed && revision === this.revision) this.pending = commit;
  }

  private async advance(inputs: Float32Array, milliseconds: number, reset = false): Promise<FlightNeuralFrame> {
    if (this.disposed || this.phase === 'failed') throw new Error('Neural pilot is unavailable');
    const frame = await this.runtime.advance(inputs, milliseconds);
    if ((!reset && frame.tick <= this.lastTick) || frame.rates.length !== 128 || frame.levels.length !== 139662) throw new Error('Missing or stale neural state');
    return frame;
  }

  async infer(observation: FlightObservation, speed: number): Promise<void> {
    if (this.busy || this.phase === 'calibration' || this.phase === 'failed' || this.disposed) return;
    const heading = observation.heading;
    await this.run(async revision => {
      const inputs = encodeFlight(observation);
      const started = performance.now(), frame = await this.advance(inputs, NEURAL_WINDOW_MS), latency = performance.now() - started;
      this.stage(revision, () => {
        this.frame = frame; this.lastTick = frame.tick; this.latencyMs = latency; this.completedRequests++;
        this.command = this.phase === 'inference' ? decodeFlight(frame, this.readout, heading, speed)
          : unpowered(frame.silenced ? 'silenced' : 'unavailable', frame);
      });
    });
  }

  async beginCalibration(): Promise<void> {
    if (this.disposed || this.phase === 'failed' || this.silenced) return;
    this.phase = 'calibration'; this.samples = 0; this.lastLoss = 0; this.rehearsal = []; await this.resetState();
  }

  async calibrateStep(): Promise<void> {
    if (this.busy || this.phase !== 'calibration' || this.disposed || this.silenced || this.samples >= this.calibrationTrials) return;
    await this.run(async revision => {
      // Rehearsal state never reaches the physical actuator path.
      await this.runtime.reset();
      const observation = calibrationObservation(this.samples), input = encodeFlight(observation);
      const started = performance.now(), frame = await this.advance(input, 60, true), latency = performance.now() - started;
      const target = teacherAction(observation);
      this.stage(revision, () => {
        this.frame = frame; this.lastTick = frame.tick; this.latencyMs = latency; this.completedRequests++;
        this.command = unpowered('calibration', frame);
        this.rehearsal.push({ frame: { rates: frame.rates.slice(), tick: frame.tick, simulatedMs: frame.simulatedMs, silenced: frame.silenced }, target });
        this.lastLoss = this.readout.teach(frame, target); this.samples++;
        if (this.samples === this.calibrationTrials) this.finishCalibration();
      });
    });
  }

  private finishCalibration(): void {
    const order = this.rehearsal.map((_, i) => i);
    let seed = 8731;
    for (let epoch = 0; epoch < 64; epoch++) {
      for (let i = order.length - 1; i > 0; i--) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const j = seed % (i + 1); [order[i], order[j]] = [order[j], order[i]];
      }
      let loss = 0;
      for (const index of order) { const trial = this.rehearsal[index]; loss += this.readout.teach(trial.frame, trial.target, .06); }
      this.lastLoss = loss / order.length;
    }
    if (!this.readout.updates) throw new Error('Calibration received no measurable neural activity');
    this.rehearsal = []; void this.resetState();
  }

  async silence(value: boolean): Promise<void> {
    if (this.disposed || this.phase === 'failed') return;
    this.revision++; this.pending = undefined; this.silenced = value;
    this.command = unpowered(value ? 'silenced' : 'unavailable', this.frame);
    await this.run(async revision => {
      await this.runtime.silence(value); const frame = await this.runtime.snapshot();
      this.stage(revision, () => {
        this.frame = frame; this.lastTick = frame.tick; this.command = unpowered(value ? 'silenced' : 'unavailable', frame);
        if (this.phase === 'calibration' && this.samples === this.calibrationTrials) this.phase = 'inference';
      });
    });
  }

  async resetState(): Promise<void> {
    if (this.phase === 'failed' || this.disposed) return;
    this.revision++; this.pending = undefined; this.command = unpowered(this.silenced ? 'silenced' : 'unavailable');
    await this.run(async revision => {
      await this.runtime.reset(); await this.runtime.silence(this.silenced); const frame = await this.runtime.snapshot();
      this.stage(revision, () => {
        this.lastTick = frame.tick; this.frame = frame; this.command = unpowered(this.silenced ? 'silenced' : 'unavailable', frame);
        if (this.phase === 'calibration' && this.samples === this.calibrationTrials) this.phase = 'inference';
      });
    });
  }

  fail(error: unknown): void { this.revision++; this.pending = undefined; this.failure = error instanceof Error ? error.message : String(error); this.phase = 'failed'; this.command = unpowered('unavailable', this.frame); }

  snapshot() {
    return { phase: this.phase, silenced: this.silenced, failure: this.failure, model: this.model, samples: this.samples, calibrationTrials: this.calibrationTrials,
      lastLoss: this.lastLoss, updates: this.readout.updates, busy: this.busy, latencyMs: this.latencyMs, completedRequests: this.completedRequests,
      frameTick: this.frame?.tick ?? null, simulatedMs: this.frame?.simulatedMs ?? 0,
      spikeCount: this.frame?.spikes.length ?? 0, totalSpikes: this.frame?.totalSpikes ?? 0, command: { ...this.command, input: { ...this.command.input },
        target: this.command.target ? { ...this.command.target } : null, readout: this.command.readout ? { index: this.command.readout.index, tick: this.command.readout.tick } : null } };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true; this.revision++; this.pending = undefined; this.command = unpowered();
    try { await this.work; await this.runtime.dispose(); }
    catch (error) { this.failure ||= error instanceof Error ? error.message : String(error); }
  }
}

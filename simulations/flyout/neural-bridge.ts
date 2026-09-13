import { AsyncNeuralRuntime } from '../../src/neural/client';
import { ACTOR_COUNT, NODE_COUNT, FlyoutNeuralDecoder, encodeObservation, neutralCommand,
  type NeuralCommand, type NeuralFrame, type Observation, type ReadoutHead } from './neural-adapter';
import { restoreReadouts, type CalibrationReport, type ReadoutWeights } from './neural-calibration';

interface CalibrationArtifact {
  schema: number; encoder: string; modelId: string; nodeCount: number; edgeCount: number;
  report: CalibrationReport; weights: ReadoutWeights;
}

interface AppliedAction {
  actor: number; heads: ReadoutHead[]; tick: number; frameTick: number; simulatedMs: number;
  spikes: number; command: NeuralCommand;
}

const actorSeed = (seed: number, actor: number): number => (seed + Math.imul(actor + 1, 104729)) >>> 0;

export class NeuralBridge {
  state: 'loading' | 'ready' | 'error' | 'disposed' = 'loading';
  label = 'Loading neural model';
  calibration?: CalibrationReport;
  edgeCount = 0;
  modelId = '';
  wallMs = 0;
  silenced = false;
  paused = false;
  private clients: AsyncNeuralRuntime[] = [];
  private decoder?: FlyoutNeuralDecoder;
  private batch?: Promise<void>;
  private controls = Promise.resolve();
  private controlCount = 0;
  private revision = 0;
  private batches = 0;
  private lastRequest = -Infinity;
  private applied: (AppliedAction | undefined)[] = Array(ACTOR_COUNT).fill(undefined);

  constructor(seed: number, private changed: () => void) { void this.initialize(seed); }

  private async initialize(seed: number): Promise<void> {
    try {
      const response = await fetch(new URL('./calibration.json', import.meta.url));
      if (!response.ok) throw new Error(`Flyout calibration unavailable (${response.status}).`);
      const artifact = await response.json() as CalibrationArtifact;
      if (artifact.schema !== 1 || artifact.encoder !== 'flyout-sensory-32-v1' || artifact.nodeCount !== NODE_COUNT
        || artifact.report?.source !== 'offline scripted observations / real neural responses') {
        throw new Error('Flyout calibration metadata is incompatible.');
      }
      for (let actor = 0; actor < ACTOR_COUNT; actor++) {
        if (this.state !== 'loading') return;
        const client = await AsyncNeuralRuntime.create(actorSeed(seed, actor));
        if (this.state !== 'loading') { await client.dispose(); return; }
        this.clients.push(client);
        if (client.graph.nodeCount !== artifact.nodeCount || client.graph.edgeCount !== artifact.edgeCount
          || client.graph.modelId !== artifact.modelId) throw new Error('Flyout calibration and neural graph do not match.');
        this.label = `Loading neural actors ${actor + 1}/${ACTOR_COUNT}`; this.changed();
      }
      this.decoder = new FlyoutNeuralDecoder(actor => restoreReadouts(artifact.weights, seed, actor));
      this.calibration = artifact.report; this.edgeCount = artifact.edgeCount; this.modelId = artifact.modelId;
      this.state = 'ready'; this.label = 'Offline-calibrated / experimental'; this.changed();
    } catch (error) { this.handleError(error); }
  }

  private handleError(error: unknown): void {
    if (this.state !== 'disposed' && this.state !== 'error') this.stop(error instanceof Error ? error.message : String(error));
  }

  stop(message: string): void {
    this.state = 'error'; this.label = message; this.revision++; this.decoder?.dispose();
    void Promise.allSettled(this.clients.map(client => client.dispose())); this.changed();
  }

  advance(observations: Observation[], activeActor = ACTOR_COUNT - 1): void {
    const now = performance.now();
    if (this.state !== 'ready' || this.batch || this.controlCount || this.paused || now - this.lastRequest < 100) return;
    if (observations.length !== ACTOR_COUNT) { this.stop('Expected one observation per neural actor.'); return; }
    this.lastRequest = now;
    const revision = this.revision;
    const order = Array.from({ length: ACTOR_COUNT }, (_, actor) => actor);
    if (order.includes(activeActor)) order.unshift(...order.splice(order.indexOf(activeActor), 1));
    // The shared worker serializes independent states; each returned frame takes effect immediately.
    this.batch = Promise.all(order.map(async actor => {
      const frame = await this.clients[actor].advance(encodeObservation(observations[actor]), 10);
      if (revision !== this.revision || this.paused || this.state !== 'ready') return;
      this.decoder!.accept(actor, frame);
      const fault = this.decoder!.snapshot().actors[actor].error;
      if (fault) throw new Error(`Actor ${actor}: ${fault}`);
    })).then(() => {
        if (revision !== this.revision || this.state !== 'ready') return;
        this.wallMs = performance.now() - now; this.batches++; this.changed();
      }).catch(error => this.handleError(error)).finally(() => { this.batch = undefined; });
  }

  command(actor: number): Readonly<NeuralCommand> {
    if (this.state !== 'ready') return neutralCommand(this.state === 'error' ? 'fault' : 'unready');
    if (this.silenced || this.paused || this.controlCount) return neutralCommand('silent');
    return this.decoder?.command(actor) ?? neutralCommand();
  }
  frame(actor: number): NeuralFrame | undefined { return this.decoder?.frame(actor); }

  recordApplied(actor: number, heads: ReadoutHead[]): void {
    const command = this.command(actor);
    if (command.source !== 'neural') return;
    const frame = this.frame(actor);
    if (!frame || command.tick !== frame.tick) { this.stop('Motor command does not match its neural frame.'); return; }
    this.applied[actor] = { actor, heads: [...heads], tick: command.tick, frameTick: frame.tick,
      simulatedMs: frame.simulatedMs, spikes: frame.spikes.length, command: { ...command } };
    this.decoder?.recordApplied(actor, heads, command.tick);
  }

  reward(actor: number, value: number): void {
    if (this.state === 'ready') this.decoder?.reward(actor, value);
  }

  private control(operation: () => Promise<void>): void {
    this.revision++; this.controlCount++;
    this.controls = this.controls.then(async () => {
      await this.batch;
      if (this.state === 'ready') await operation();
    }).catch(error => this.handleError(error)).finally(() => {
      this.controlCount--; if (this.state !== 'disposed') this.changed();
    });
  }

  silence(enabled: boolean): void {
    if (this.state !== 'ready') return;
    this.silenced = enabled; this.decoder?.silence(enabled);
    this.control(async () => {
      await Promise.all(this.clients.map(client => client.silence(enabled)));
      const frames = await Promise.all(this.clients.map(client => client.snapshot()));
      frames.forEach((frame, actor) => this.decoder!.accept(actor, frame));
    });
    this.changed();
  }

  pause(paused: boolean): void { this.paused = paused; this.revision++; }

  reset(seed: number): void {
    if (this.state !== 'ready') return;
    this.decoder?.reset(); this.applied.fill(undefined);
    this.control(async () => {
      await Promise.all(this.clients.map((client, actor) => client.reset(actorSeed(seed, actor))));
      await Promise.all(this.clients.map(client => client.silence(this.silenced)));
    });
  }

  resetActor(actor: number, seed: number): void {
    if (this.state !== 'ready') return;
    this.decoder?.resetActor(actor); this.applied[actor] = undefined;
    this.control(async () => {
      await this.clients[actor].reset(actorSeed(seed, actor));
      await this.clients[actor].silence(this.silenced);
    });
  }

  snapshot() {
    return { state: this.state, label: this.label, silenced: this.silenced, modelId: this.modelId,
      edgeCount: this.edgeCount, neuralWindowMs: 10, minimumWallIntervalMs: 100, wallMs: this.wallMs,
      batches: this.batches, pending: Boolean(this.batch) || this.controlCount > 0, calibration: this.calibration,
      applied: this.applied.filter((action): action is AppliedAction => Boolean(action)),
      actors: Array.from({ length: ACTOR_COUNT }, (_, actor) => {
        const frame = this.frame(actor);
        return { actor, tick: frame?.tick ?? 0, simulatedMs: frame?.simulatedMs ?? 0,
          spikes: frame?.spikes.length ?? 0, totalSpikes: frame?.totalSpikes ?? 0,
          silenced: frame?.silenced ?? false, command: { ...this.command(actor) } };
      }) };
  }

  dispose(): void {
    this.state = 'disposed'; this.revision++; this.decoder?.dispose();
    void Promise.allSettled(this.clients.map(client => client.dispose()));
  }
}

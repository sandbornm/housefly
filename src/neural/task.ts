import { NeuralReadout } from "./policy.ts";
import type { ReadoutDecision } from "./policy.ts";
import type { NeuralFrame } from "./runtime.ts";

export interface TaskNeuralRuntime {
  readonly silenced: boolean;
  advance(input: Float32Array, milliseconds: number): NeuralFrame | Promise<NeuralFrame>;
}

export interface NeuralWindowOptions {
  durationMs: number;
  stepMs: number;
  valid?: () => boolean;
  onFrame?: (frame: NeuralFrame) => void;
}

export function copyNeuralFrame(frame: NeuralFrame): NeuralFrame {
  return { ...frame, rates: frame.rates.slice(), levels: frame.levels.slice(),
    spikes: frame.spikes.slice(), counts: frame.counts.slice() };
}

const integrating = new WeakSet<TaskNeuralRuntime>();

/** Shared fixed-time integration for categorical or multi-head task controllers. */
export async function integrateNeuralWindow(runtime: TaskNeuralRuntime, input: Float32Array,
  options: NeuralWindowOptions): Promise<NeuralFrame | null> {
  const { durationMs, stepMs, valid = () => true, onFrame } = options;
  const ticks = (ms: number) => Math.round(ms / .2);
  if (![durationMs, stepMs].every(ms => Number.isFinite(ms) && ms >= .2 && ms <= 1000
    && Math.abs(ticks(ms) * .2 - ms) < 1e-8) || stepMs > durationMs) {
    throw new Error("Neural windows must use 0.2 ms ticks within 0.2..1000 ms");
  }
  if (!(input instanceof Float32Array) || input.length !== 32
    || input.some(rate => !Number.isFinite(rate) || rate < 0 || rate > 150)) {
    throw new Error("Neural task encoding must contain 32 finite rates in 0..150 Hz");
  }
  if (integrating.has(runtime)) throw new Error("A neural actor already has a decision in flight");
  if (runtime.silenced || !valid()) return null;
  const rates = input.slice();
  integrating.add(runtime);
  try {
    let frame: NeuralFrame | null = null;
    for (let elapsed = 0; elapsed < ticks(durationMs); elapsed += ticks(stepMs)) {
      if (runtime.silenced || !valid()) return null;
      const count = Math.min(ticks(stepMs), ticks(durationMs) - elapsed);
      const next = await runtime.advance(rates, count * .2);
      if (runtime.silenced || next.silenced || !valid()) return null;
      // Keep the final decision independent of reused runtime buffers or display callbacks.
      if (elapsed + count === ticks(durationMs)) frame = copyNeuralFrame(next);
      onFrame?.(next);
    }
    return runtime.silenced || !valid() ? null : frame;
  } finally {
    integrating.delete(runtime);
  }
}

export interface NeuralTaskAdapter<Observation, Action extends string> {
  readonly id: string;
  readonly encoderVersion: string;
  readonly actions: readonly Action[];
  encode(observation: Observation): Float32Array;
  /** Rule constraints only, never a mask of strategically preferred actions. */
  legalActions(observation: Observation): readonly Action[];
}

export interface NeuralTaskChoice<Action extends string> {
  readonly taskId: string;
  readonly encoderVersion: string;
  readonly action: Action;
  readonly frame: NeuralFrame;
  readonly decision: ReadoutDecision;
  readonly scores: Float32Array;
}

/** Observation -> sensory drive -> recurrent model -> rate-only action readout. */
export class NeuralTaskController<Observation, Action extends string> {
  readonly adapter: NeuralTaskAdapter<Observation, Action>;
  readonly runtime: TaskNeuralRuntime;
  readonly readout: NeuralReadout;

  constructor(runtime: TaskNeuralRuntime, readout: NeuralReadout,
    adapter: NeuralTaskAdapter<Observation, Action>) {
    if (!adapter.id || !adapter.encoderVersion || adapter.actions.length !== readout.actions.length
      || adapter.actions.some((action, index) => action !== readout.actions[index])) {
      throw new Error("Task identity and action order must match the neural readout");
    }
    this.runtime = runtime;
    this.readout = readout;
    this.adapter = Object.freeze({ id: adapter.id, encoderVersion: adapter.encoderVersion,
      actions: Object.freeze([...adapter.actions]), encode: adapter.encode.bind(adapter),
      legalActions: adapter.legalActions.bind(adapter) });
  }

  async decide(observation: Observation, options: NeuralWindowOptions & {
    sample?: boolean; temperature?: number;
  }): Promise<NeuralTaskChoice<Action> | null> {
    if (this.runtime.silenced || options.valid?.() === false) return null;
    const legal = this.adapter.legalActions(observation);
    if (!legal.length) return null;
    const allowed = legal.map(action => this.adapter.actions.indexOf(action));
    if (allowed.some(index => index < 0) || new Set(allowed).size !== allowed.length) {
      throw new Error("Task returned an invalid legal action set");
    }
    const frame = await integrateNeuralWindow(this.runtime, this.adapter.encode(observation), options);
    if (!frame || this.runtime.silenced || options.valid?.() === false) return null;
    const decision = this.readout.decide(frame, allowed, options);
    if (!decision) return null;
    return { taskId: this.adapter.id, encoderVersion: this.adapter.encoderVersion,
      action: this.adapter.actions[decision.index], frame, decision, scores: this.readout.scores(frame)! };
  }
}

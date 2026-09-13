export interface ReadoutFrame {
  rates: ArrayLike<number>;
  tick: number;
  simulatedMs: number;
  silenced: boolean;
}

export interface ReadoutDecision {
  readonly action: string;
  readonly index: number;
  readonly probabilities: Float32Array;
  readonly features: Float32Array;
  readonly tick: number;
  readonly simulatedMs: number;
  readonly temperature: number;
}

interface SavedReadout {
  version: 1;
  modelId: string;
  actions: string[];
  features: number;
  weights: number[];
  updates: number;
  episodes: number;
  totalReward: number;
  baseline: number;
  randomState: number;
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** A task-specific output layer. Its only inference inputs are recorded neural rates. */
export class NeuralReadout {
  readonly actions: readonly string[];
  readonly modelId: string;
  readonly features: number;
  readonly learningRate: number;
  private weights: Float32Array;
  private randomState: number;
  private baseline = 0;
  private issued = new WeakMap<ReadoutDecision, { features: Float32Array; probabilities: Float32Array; index: number; temperature: number }>();
  private consumed = new WeakSet<ReadoutDecision>();
  updates = 0;
  episodes = 0;
  totalReward = 0;

  constructor(options: { actions: readonly string[]; modelId: string; seed?: number; features?: number; learningRate?: number }) {
    this.features = options.features ?? 128;
    this.learningRate = options.learningRate ?? .03;
    if (!Number.isInteger(this.features) || this.features < 1 || this.features > 512
      || options.actions.length < 2 || options.actions.length > 96
      || new Set(options.actions).size !== options.actions.length
      || options.actions.some(action => typeof action !== "string" || !action.length || action.length > 64)
      || typeof options.modelId !== "string" || !options.modelId.length || options.modelId.length > 200
      || !Number.isFinite(this.learningRate) || this.learningRate <= 0 || this.learningRate > 1) {
      throw new Error("Invalid neural readout configuration");
    }
    this.actions = Object.freeze([...options.actions]);
    this.modelId = options.modelId;
    this.randomState = (options.seed ?? 1977) >>> 0 || 1;
    this.weights = Float32Array.from({ length: this.actions.length * this.features }, () => (this.random() - .5) * .04);
  }

  private random(): number {
    let value = this.randomState;
    value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
    this.randomState = value >>> 0;
    return this.randomState / 4294967296;
  }

  private encode(frame: ReadoutFrame): Float32Array | null {
    if (frame.silenced) return null;
    if (frame.rates.length !== this.features || !Number.isFinite(frame.tick) || !Number.isFinite(frame.simulatedMs)) {
      throw new Error("Neural readout frame does not match the model");
    }
    const features = new Float32Array(this.features);
    let energy = 0;
    for (let index = 0; index < features.length; index++) {
      const rate = frame.rates[index];
      if (!Number.isFinite(rate) || rate < 0) throw new Error("Invalid recorded neural rate");
      const feature = rate / (rate + 20);
      features[index] = feature; energy += feature * feature;
    }
    if (energy < 1e-12) return null;
    const norm = Math.sqrt(energy);
    for (let index = 0; index < features.length; index++) features[index] /= norm;
    return features;
  }

  private logits(features: Float32Array): Float32Array {
    const values = new Float32Array(this.actions.length);
    for (let action = 0; action < values.length; action++) {
      const offset = action * this.features;
      for (let index = 0; index < this.features; index++) values[action] += this.weights[offset + index] * features[index];
    }
    return values;
  }

  scores(frame: ReadoutFrame): Float32Array | null {
    const features = this.encode(frame);
    return features ? this.logits(features) : null;
  }

  private distribution(logits: Float32Array, allowed: readonly number[], temperature: number): Float32Array {
    if (!Number.isFinite(temperature) || temperature < .05 || temperature > 10
      || !allowed.length || new Set(allowed).size !== allowed.length
      || allowed.some(index => !Number.isInteger(index) || index < 0 || index >= this.actions.length)) {
      throw new Error("Invalid action mask or sampling temperature");
    }
    const probabilities = new Float32Array(this.actions.length);
    const max = Math.max(...allowed.map(index => logits[index]));
    let sum = 0;
    for (const index of allowed) { probabilities[index] = Math.exp((logits[index] - max) / temperature); sum += probabilities[index]; }
    for (const index of allowed) probabilities[index] /= sum;
    return probabilities;
  }

  decide(frame: ReadoutFrame, allowedIndices: readonly number[] = this.actions.map((_, index) => index),
    options: { temperature?: number; sample?: boolean } = {}): ReadoutDecision | null {
    const features = this.encode(frame);
    if (!features) return null;
    const temperature = options.temperature ?? .6;
    const probabilities = this.distribution(this.logits(features), allowedIndices, temperature);
    let index = allowedIndices[0];
    if (options.sample ?? true) {
      let sample = this.random();
      index = allowedIndices.at(-1)!;
      for (const candidate of allowedIndices) {
        sample -= probabilities[candidate];
        if (sample <= 0) { index = candidate; break; }
      }
    } else {
      for (const candidate of allowedIndices) if (probabilities[candidate] > probabilities[index]) index = candidate;
    }
    const decision: ReadoutDecision = {
      action: this.actions[index], index, features, probabilities,
      tick: frame.tick, simulatedMs: frame.simulatedMs, temperature,
    };
    // Keep the training trace separate from mutable WASM buffers and caller-owned telemetry.
    if (options.sample ?? true) this.issued.set(decision, { features: features.slice(), probabilities: probabilities.slice(), index, temperature });
    return decision;
  }

  private gradient(features: Float32Array, probabilities: Float32Array, target: number, gain: number): boolean {
    let changed = false;
    for (let action = 0; action < this.actions.length; action++) {
      const error = ((action === target ? 1 : 0) - probabilities[action]) * gain;
      const offset = action * this.features;
      for (let index = 0; index < this.features; index++) {
        const old = this.weights[offset + index];
        this.weights[offset + index] = clamp(old + clamp(error * features[index], -.25, .25), -12, 12);
        changed ||= this.weights[offset + index] !== old;
      }
    }
    if (changed) this.updates++;
    return changed;
  }

  /** Supervised calibration, separate from action selection; never replaces a performed action. */
  teach(frame: ReadoutFrame, targetIndex: number, rate = this.learningRate): number {
    if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= this.actions.length
      || !Number.isFinite(rate) || rate <= 0 || rate > 1) throw new Error("Invalid calibration target");
    const features = this.encode(frame);
    if (!features) return 0;
    const probabilities = this.distribution(this.logits(features), this.actions.map((_, index) => index), 1);
    const loss = -Math.log(Math.max(1e-12, probabilities[targetIndex]));
    this.gradient(features, probabilities, targetIndex, rate);
    return loss;
  }

  /** Monte Carlo policy-gradient updates from completed, genuinely sampled decisions. */
  reinforce(decisions: readonly ReadoutDecision[], reward: number): boolean {
    if (!Number.isFinite(reward) || Math.abs(reward) > 100 || decisions.length > 256) throw new Error("Invalid episode reward");
    if (new Set(decisions).size !== decisions.length) throw new Error("Duplicate decision in episode");
    const traces = decisions.map(decision => {
      const trace = this.issued.get(decision);
      if (!trace || this.consumed.has(decision)) throw new Error("Decision is not an unconsumed sampled policy action");
      return trace;
    });
    if (!traces.length) return false;
    const advantage = clamp(reward - this.baseline, -4, 4);
    let changed = false;
    for (let index = 0; index < traces.length; index++) {
      const trace = traces[index];
      changed = this.gradient(trace.features, trace.probabilities, trace.index, this.learningRate * advantage / trace.temperature) || changed;
      this.consumed.add(decisions[index]);
    }
    this.episodes++; this.totalReward += reward;
    this.baseline += .05 * (reward - this.baseline);
    return changed;
  }

  export(): SavedReadout {
    return {
      version: 1, modelId: this.modelId, actions: [...this.actions], features: this.features,
      weights: Array.from(this.weights), updates: this.updates, episodes: this.episodes,
      totalReward: this.totalReward, baseline: this.baseline, randomState: this.randomState,
    };
  }

  restore(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const data = value as SavedReadout;
    const keys = ["version", "modelId", "actions", "features", "weights", "updates", "episodes", "totalReward", "baseline", "randomState"];
    if (Object.keys(data).length !== keys.length || Object.keys(data).some(key => !keys.includes(key))
      || data.version !== 1 || data.modelId !== this.modelId || data.features !== this.features
      || !Array.isArray(data.actions) || JSON.stringify(data.actions) !== JSON.stringify(this.actions)
      || !Array.isArray(data.weights) || data.weights.length !== this.weights.length
      || data.weights.some(weight => !Number.isFinite(weight) || Math.abs(weight) > 12)
      || [data.updates, data.episodes].some(count => !Number.isSafeInteger(count) || count < 0 || count > 1e9)
      || !Number.isFinite(data.totalReward) || Math.abs(data.totalReward) > 1e11
      || !Number.isFinite(data.baseline) || Math.abs(data.baseline) > 100
      || !Number.isInteger(data.randomState) || data.randomState < 1 || data.randomState > 0xffffffff) return false;
    this.weights.set(data.weights); this.updates = data.updates; this.episodes = data.episodes;
    this.totalReward = data.totalReward; this.baseline = data.baseline; this.randomState = data.randomState;
    this.issued = new WeakMap(); this.consumed = new WeakSet();
    return true;
  }
}

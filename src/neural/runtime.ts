import { loadNeuralGraph, neuralGraphInternals } from './data.ts';
import type { NeuralGraph, NeuralLoadOptions, NeuralWasm } from './data.ts';
export { loadNeuralGraph } from './data.ts';
export type { NeuralGraph, NeuralMetadata, NeuralLoadOptions } from './data.ts';

export interface NeuralFrame {
  tick: number;
  simulatedMs: number;
  /** Node indices for all spike events in the most recent advance; may repeat. */
  spikes: Uint32Array;
  /** Full nodeCount per-advance counts, indexed identically to display somata. */
  counts: Uint16Array;
  /** 128 pool means of exponentially filtered spike trains, in Hz; tau=50 ms. */
  rates: Float32Array;
  /** Full nodeCount actual normalized voltage: clamp((v+52)/7, -1, 1). */
  levels: Float32Array;
  /** Cumulative event count since reset, including directly driven input neurons. */
  totalSpikes: number;
  silenced: boolean;
}

export class NeuralRuntime {
  static load(baseURL?: string | URL, options?: NeuralLoadOptions): Promise<NeuralGraph> {
    return loadNeuralGraph(baseURL, options);
  }
  readonly graph: NeuralGraph;
  private readonly wasm: NeuralWasm;
  private handle: number;
  private seed: number;
  private remainderMs = 0;
  private readonly counts: Uint16Array;
  private readonly levels: Float32Array;
  private readonly rates = new Float32Array(128);
  private spikeBuffer = new Uint32Array(0);

  constructor(graph: NeuralGraph, seed: number) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('Neural seed must be a uint32');
    const internal = neuralGraphInternals(graph);
    this.graph = graph;
    this.wasm = internal.wasm;
    this.seed = seed;
    this.handle = this.wasm.neural_new(internal.handle, seed);
    if (!this.handle) throw new Error('Neural runtime allocation failed');
    this.counts = new Uint16Array(graph.nodeCount);
    this.levels = new Float32Array(graph.nodeCount);
  }

  private requireLive(): number {
    if (!this.handle) throw new Error('Neural runtime has been disposed');
    return this.handle;
  }

  /** Returned arrays are reused by this runtime. snapshot() returns owned copies. */
  advance(rates: Float32Array, milliseconds: number): NeuralFrame {
    const handle = this.requireLive();
    if (!(rates instanceof Float32Array) || rates.length !== 32 || !rates.every(rate => Number.isFinite(rate) && rate >= 0 && rate <= 150)
      || !Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 1000) {
      throw new Error('Expected 32 sensory rates in Hz [0,150] and duration in ms [0,1000]');
    }
    const duration = this.remainderMs + milliseconds;
    const steps = Math.floor((duration + 1e-9) / 0.2);
    new Float32Array(this.wasm.memory.buffer, this.wasm.neural_buffer(handle, 0), 32).set(rates);
    if (this.wasm.neural_advance(handle, steps) !== 1) throw new Error('Neural advance rejected');
    this.remainderMs = Math.max(0, duration - steps * 0.2);
    return this.readFrame();
  }

  reset(seed: number = this.seed): void {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('Neural seed must be a uint32');
    this.wasm.neural_reset(this.requireLive(), seed);
    this.seed = seed;
    this.remainderMs = 0;
  }

  silence(enabled: boolean): void {
    if (typeof enabled !== 'boolean') throw new Error('Neural silence flag must be boolean');
    this.wasm.neural_silence(this.requireLive(), Number(enabled));
  }

  private readFrame(): NeuralFrame {
    const handle = this.requireLive();
    this.wasm.neural_snapshot(handle);
    const buffer = this.wasm.memory.buffer;
    const count = this.wasm.neural_stat(handle, 1);
    if (this.spikeBuffer.length < count) this.spikeBuffer = new Uint32Array(Math.max(count, this.spikeBuffer.length * 2, 256));
    this.spikeBuffer.set(new Uint32Array(buffer, this.wasm.neural_buffer(handle, 1), count));
    this.counts.set(new Uint16Array(buffer, this.wasm.neural_buffer(handle, 2), this.graph.nodeCount));
    this.rates.set(new Float32Array(buffer, this.wasm.neural_buffer(handle, 3), 128));
    this.levels.set(new Float32Array(buffer, this.wasm.neural_buffer(handle, 4), this.graph.nodeCount));
    const tick = this.wasm.neural_stat(handle, 0);
    return { tick, simulatedMs: tick * 0.2, spikes: this.spikeBuffer.subarray(0, count), counts: this.counts,
      rates: this.rates, levels: this.levels, totalSpikes: this.wasm.neural_stat(handle, 2), silenced: this.wasm.neural_stat(handle, 3) !== 0 };
  }

  snapshot(): NeuralFrame {
    const frame = this.readFrame();
    return { ...frame, spikes: frame.spikes.slice(), counts: frame.counts.slice(), rates: frame.rates.slice(), levels: frame.levels.slice() };
  }

  dispose(): void {
    if (this.handle) { this.wasm.neural_free(this.handle); this.handle = 0; }
  }
}

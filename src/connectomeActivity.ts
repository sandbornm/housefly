export interface ActivitySignal {
  sensory: number;
  integration: number;
  motor: number;
  reward: number;
  label: string;
  detail?: string;
  paused?: boolean;
}

export const ACTIVITY_CHANNELS = ["sensory", "integration", "motor", "reward"] as const;

export function activityChannels(signal: ActivitySignal): number[] {
  return ACTIVITY_CHANNELS.map(key => Number.isFinite(signal[key]) ? Math.max(0, Math.min(1, signal[key])) : 0);
}

// These are display assignments, not measured task tuning or a neural controller.
export function classChannel(name: string): number {
  if (/visual|ol_|sensory/.test(name)) return 0;
  if (/motor|descending|efferent/.test(name)) return 2;
  if (/endocrine|ENS/.test(name)) return 3;
  return 1;
}

export class ConnectomeActivity {
  readonly levels: Float32Array;
  readonly channels: Uint8Array;
  private incoming: Float32Array;
  private weights: Float32Array;
  private gain: Float32Array;
  private edges: Uint32Array;
  energy = 0;
  active = 0;

  constructor(classes: Uint8Array, names: string[], edges: Uint32Array) {
    this.edges = edges;
    if (edges.length % 3) throw new Error("Malformed connectome edges");
    const count = classes.length;
    this.levels = new Float32Array(count);
    this.incoming = new Float32Array(count);
    this.channels = Uint8Array.from(classes, value => classChannel(names[value] ?? ""));
    this.weights = new Float32Array(edges.length / 3);
    this.gain = Float32Array.from(classes, (_, index) => .55 + ((Math.imul(index + 1, 2654435761) >>> 0) % 1000) * .00045);
    const sums = new Float32Array(count);
    for (let i = 0; i < this.weights.length; i++) {
      const source = edges[i * 3], target = edges[i * 3 + 1];
      if (source >= count || target >= count) throw new Error("Connectome edge outside neuron array");
      this.weights[i] = Math.log1p(edges[i * 3 + 2]);
      sums[target] += this.weights[i];
    }
    for (let i = 0; i < this.weights.length; i++) this.weights[i] /= sums[edges[i * 3 + 1]] || 1;
  }

  step(signal: ActivitySignal, seconds: number): void {
    if (signal.paused || !Number.isFinite(seconds) || seconds <= 0) return;
    const drives = activityChannels(signal);
    const smoothing = 1 - Math.exp(-7 * Math.min(seconds, .1));
    this.incoming.fill(0);
    for (let i = 0; i < this.weights.length; i++) {
      this.incoming[this.edges[i * 3 + 1]] += this.levels[this.edges[i * 3]] * this.weights[i];
    }
    let sum = 0, active = 0;
    for (let i = 0; i < this.levels.length; i++) {
      const drive = drives[this.channels[i]] * this.gain[i] * .66;
      const target = Math.min(1, drive + this.incoming[i] * .48);
      this.levels[i] += (target - this.levels[i]) * smoothing;
      sum += this.levels[i];
      if (this.levels[i] > .15) active++;
    }
    this.energy = this.levels.length ? sum / this.levels.length : 0;
    this.active = active;
  }
}

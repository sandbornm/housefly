export interface NeuralDisplayFrame {
  tick: number;
  simulatedMs: number;
  levels: Float32Array;
  spikes: Uint32Array;
  rates: Float32Array;
  totalSpikes: number;
  silenced: boolean;
}

export interface NeuralDisplayOptions {
  label: string;
  detail?: string;
  paused?: boolean;
  edgeCount?: number;
  modelId?: string;
}

export function copyNeuralLevels(target: Float32Array, frame: NeuralDisplayFrame) {
  if (target.length !== frame.levels.length || !Number.isInteger(frame.tick) || frame.tick < 0
    || !Number.isFinite(frame.simulatedMs) || frame.simulatedMs < 0) throw new Error("Neural display frame mismatch");
  let sum = 0, active = 0;
  for (const value of frame.levels) {
    if (!Number.isFinite(value) || value < -1 || value > 1) throw new Error("Invalid normalized neural state");
    sum += Math.abs(value);
    if (Math.abs(value) > .15) active++;
  }
  target.set(frame.levels);
  return { energy: target.length ? sum / target.length : 0, active };
}

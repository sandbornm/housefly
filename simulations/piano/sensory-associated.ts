import { LEG_RANGES } from './actuator.ts';
import { LEGS } from './performance.ts';
import type { SensoryTarget, Proprioception } from './sensory.ts';

export const ASSOCIATED_PIANO_ENCODER = 'flythoven-associated-pitch-v2b';
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

// Retain categorical pitch evidence while preserving each leg's absolute target.
// Timing channels are sensory observations; they never issue or schedule strikes.
export function encodePianoAssociated(targets: readonly (SensoryTarget | null)[], beat: number,
  bpm: number, proprio: readonly Proprioception[]): Float32Array {
  if (targets.length !== 6 || proprio.length !== 6 || !Number.isFinite(beat)
    || !Number.isFinite(bpm) || bpm <= 0) throw new Error('Invalid piano sensory observation');
  const input = new Float32Array(32);
  for (let index = 0; index < LEGS.length; index++) {
    const target = targets[index], limb = proprio[index];
    if (!limb || typeof limb.busy !== 'boolean' || typeof limb.contact !== 'boolean'
      || !Number.isFinite(limb.press)) throw new Error('Invalid piano proprioception');
    if (target) {
      const [low, high] = LEG_RANGES[LEGS[index].id];
      if (!Number.isInteger(target.midi) || target.midi < low || target.midi > high
        || !Number.isFinite(target.beat) || !Number.isFinite(target.duration) || target.duration <= 0) {
        throw new Error('Requested note outside its physical limb range');
      }
      input[target.midi % 12] = 120;
      input[12 + index] = 25 + 125 * (target.midi - low) / (high - low);
      const elapsedMs = (beat - target.beat) * 60000 / bpm;
      input[18 + index] = 75 + 75 * clamp(elapsedMs / 160, -1, 1);
    }
    input[24 + index] = limb.contact ? 80 + 70 * clamp(limb.press, 0, 1) : limb.busy ? 40 : 0;
  }
  input[30] = ((beat % 0.5 + 0.5) % 0.5) / 0.5 * 100;
  input[31] = ((beat % 1.5 + 1.5) % 1.5) / 1.5 * 80;
  return input;
}

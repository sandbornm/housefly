import { LEG_RANGES } from "./actuator.ts";
import { LEGS, assignedLeg } from "./performance.ts";
import { SCORE, normalizeBeat } from "./score.ts";
import type { Note } from "./score.ts";

export const PIANO_ENCODER = "flythoven-leg-tuples-v2";
export const NEURAL_STEP_MS = 20;
export type SensoryTarget = Note & { noteIndex: number };
export type Proprioception = { contact: boolean; press: number; busy: boolean };
export interface PianoInputProfile { id: string; channels: number[]; gains: number[] }
const clamp = (value: number) => Math.max(0, Math.min(1, value));

export function scoreTargets(beat: number, loop: boolean, notes: readonly Note[] = SCORE): (SensoryTarget | null)[] {
  const time = normalizeBeat(beat, loop);
  return LEGS.map(leg => notes.map((note, noteIndex) => ({ ...note, noteIndex }))
    .find(note => assignedLeg(note) === leg.id && time + 0.16 >= note.beat && time + 0.16 < note.beat + note.duration) ?? null);
}

// Tuples retain limb identity. Pitch is absolute within each fixed physical range,
// not pitch class: F3/A2 and A3/F2 no longer alias. Pair sum 170 Hz is the active gate.
// Onset/release distances are observations, never motor command timestamps.
export function encodePianoV2(targets: readonly (SensoryTarget | null)[], beat: number, bpm: number, proprio: readonly Proprioception[], profile?: PianoInputProfile): Float32Array {
  if (targets.length !== 6 || proprio.length !== 6 || !Number.isFinite(beat) || !Number.isFinite(bpm) || bpm <= 0) throw new Error("Invalid piano sensory observation");
  const input = new Float32Array(32);
  for (let index = 0; index < 6; index++) {
    const note = targets[index], offset = index * 4;
    if (note) {
      const [low, high] = LEG_RANGES[LEGS[index].id];
      if (!Number.isInteger(note.midi) || note.midi < low || note.midi > high || !Number.isFinite(note.beat) || !Number.isFinite(note.duration) || note.duration <= 0) throw new Error("Requested note outside its physical limb range");
      const pitch = (note.midi - low) / (high - low);
      input[offset] = 20 + 130 * pitch;
      input[offset + 1] = 150 - 130 * pitch;
      const onsetMs = (note.beat - beat) * 60000 / bpm;
      const releaseMs = (note.beat + note.duration - beat) * 60000 / bpm;
      input[offset + 2] = 150 * clamp((onsetMs + 100) / 300);
      input[offset + 3] = 150 * clamp(releaseMs / 400);
    }
    const limb = proprio[index];
    if (!Number.isFinite(limb.press)) throw new Error("Invalid piano proprioception");
    input[24 + index] = limb.contact ? 80 + 70 * clamp(limb.press) : limb.busy ? 40 : 0;
  }
  input[30] = ((beat % 0.5 + 0.5) % 0.5) / 0.5 * 100;
  input[31] = ((beat % 1.5 + 1.5) % 1.5) / 1.5 * 80;
  return profile ? projectPianoChannels(input, profile) : input;
}

export function projectPianoChannels(logical: Float32Array, profile: PianoInputProfile): Float32Array {
  if (logical.length !== 32 || profile.channels.length !== 32 || profile.gains.length !== 32 || new Set(profile.channels).size !== 32
    || profile.channels.some(channel => !Number.isInteger(channel) || channel < 0 || channel >= 32)
    || profile.gains.some(gain => !Number.isFinite(gain) || gain <= 0 || gain > 1)) throw new Error("Invalid piano input projection");
  const physical = new Float32Array(32);
  for (let index = 0; index < 32; index++) physical[profile.channels[index]] = logical[index] * profile.gains[index];
  return physical;
}

// Preserved v1 mapping for matched-budget comparison, not a neural fallback.
export function encodePianoV1(targets: readonly (SensoryTarget | null)[], beat: number, proprio: readonly Proprioception[]): Float32Array {
  const input = new Float32Array(32);
  for (const [index, note] of targets.entries()) if (note) {
    input[note.midi % 12] = 120; input[12 + Math.floor(note.midi / 12) - 3] = 110; input[16 + index] = 130;
  }
  for (const [index, leg] of proprio.entries()) input[22 + index] = leg.contact ? 130 * leg.press : leg.busy ? 65 : 0;
  input[28] = (beat % 0.5) / 0.5 * 100; input[29] = (beat % 1.5) / 1.5 * 80;
  input[30] = 60; input[31] = Math.min(150, targets.filter(Boolean).length * 60);
  return input;
}

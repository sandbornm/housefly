import { EXCERPT } from "./score-data.ts";

export const TITLE = "Fur Elise";
export const TOTAL_BEATS = 12;
export const DEFAULT_BPM = 72;
export const LOWEST_KEY = 40;
export const HIGHEST_KEY = 76;
export const WHITE_WIDTH = 0.166;
export type Hand = "left" | "right";
export interface Note { beat: number; midi: number; duration: number; writtenDuration: number; velocity: number; hand: Hand }
export interface Measure { index: number; number: number; beat: number; duration: number; pickup: boolean }

export const MEASURES: readonly Measure[] = Object.freeze(EXCERPT.map((measure, index) => Object.freeze({
  index, number: index, beat: index === 0 ? 0 : 0.5 + (index - 1) * 1.5,
  duration: measure.right.reduce((sum, [, ticks]) => sum + ticks / 4, 0), pickup: index === 0,
})));

export function measureAt(beat: number): Measure {
  return MEASURES.find(measure => beat < measure.beat + measure.duration) ?? MEASURES[MEASURES.length - 1];
}

export const SCORE: readonly Note[] = Object.freeze(EXCERPT.flatMap((measure, index) => {
  return (["left", "right"] as const).flatMap(hand => {
    let beat = MEASURES[index].beat;
    return measure[hand].flatMap(([midi, ticks]) => {
      const writtenDuration = ticks / 4;
      const note = midi === null ? [] : [{ beat, midi, writtenDuration, duration: writtenDuration * 0.88, velocity: hand === "left" ? 0.42 : 0.59, hand }];
      beat += writtenDuration; return note;
    });
  });
}).sort((a, b) => a.beat - b.beat).map(note => Object.freeze(note)));

export function clampTempo(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(40, value)) : DEFAULT_BPM;
}

export function normalizeBeat(beat: number, loop: boolean): number {
  if (!Number.isFinite(beat)) return 0;
  if (beat >= 0 && beat < TOTAL_BEATS) return beat;
  return loop ? ((beat % TOTAL_BEATS) + TOTAL_BEATS) % TOTAL_BEATS : Math.min(TOTAL_BEATS, Math.max(0, beat));
}

export function noteName(midi: number): string {
  return ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][midi % 12] + (Math.floor(midi / 12) - 1);
}

export function isBlackKey(midi: number): boolean { return [1, 3, 6, 8, 10].includes(midi % 12); }

export function keyboardLayout(): { midi: number; x: number; black: boolean }[] {
  let whiteIndex = 0;
  const offset = 10.5 * WHITE_WIDTH;
  return Array.from({ length: HIGHEST_KEY - LOWEST_KEY + 1 }, (_, index) => {
    const midi = LOWEST_KEY + index;
    const black = isBlackKey(midi);
    const x = (black ? whiteIndex - 0.5 : whiteIndex++) * WHITE_WIDTH - offset;
    return { midi, x, black };
  });
}

export const KEYS = keyboardLayout();
export function keyX(midi: number): number { return KEYS.find(key => key.midi === midi)?.x ?? 0; }

export function activeNotes(beat: number): readonly Note[] {
  return SCORE.filter(note => beat >= note.beat && beat < note.beat + note.duration);
}

export class SilentTransport {
  beat = 0;
  bpm = DEFAULT_BPM;
  playing = true;
  loop = true;

  advance(seconds: number): void {
    if (!this.playing || !Number.isFinite(seconds) || seconds < 0) return;
    this.beat = normalizeBeat(this.beat + seconds * this.bpm / 60, this.loop);
    if (!this.loop && this.beat >= TOTAL_BEATS) this.playing = false;
  }

  seek(beat: number): void { this.beat = normalizeBeat(beat, false); }
}

import type { Hand, Measure, Note } from "./score.ts";

export interface NotationEvent {
  beat: number;
  duration: number;
  value: string;
  dotted: boolean;
  midis: number[];
  tied: number[];
}

const values = [
  { duration: 1.5, value: "4", dotted: true },
  { duration: 1, value: "4", dotted: false },
  { duration: 0.75, value: "8", dotted: true },
  { duration: 0.5, value: "8", dotted: false },
  { duration: 0.25, value: "16", dotted: false },
];

export function notationEvents(notes: readonly Note[], measure: Measure, hand: Hand): NotationEvent[] {
  const result: NotationEvent[] = [];
  const end = measure.beat + measure.duration;
  const voice = notes.filter(note => note.hand === hand && note.beat < end && note.beat + note.writtenDuration > measure.beat);
  let beat = measure.beat;
  while (beat < end - 1e-8) {
    const sounding = voice.filter(note => note.beat <= beat && note.beat + note.writtenDuration > beat + 1e-8);
    const boundary = Math.min(end, ...voice.flatMap(note => [note.beat, note.beat + note.writtenDuration]).filter(time => time > beat + 1e-8));
    const remaining = !sounding.length && (beat - measure.beat) % 0.5 > 0 ? Math.min(0.25, boundary - beat) : boundary - beat;
    const value = values.find(value => value.duration <= remaining + 1e-8);
    if (!value) throw new Error(`Unsupported notation duration at beat ${beat}`);
    result.push({ beat, ...value, midis: sounding.map(note => note.midi), tied: sounding.filter(note => note.beat < beat).map(note => note.midi) });
    beat += value.duration;
  }
  return result;
}

export function engravingKey(midi: number): { key: string; accidental?: string } {
  const pitches = ["c", "c#", "d", "d#", "e", "f", "f#", "g", "g#", "a", "a#", "b"];
  const pitch = pitches[midi % 12];
  return { key: `${pitch}/${Math.floor(midi / 12) - 1}`, accidental: pitch.endsWith("#") ? "#" : undefined };
}

export function interpolatePlayhead(beat: number, anchors: readonly { beat: number; x: number }[]): number {
  if (!anchors.length) return 0;
  const next = anchors.findIndex(anchor => anchor.beat > beat);
  if (next < 0) return anchors[anchors.length - 1].x;
  if (next === 0) return anchors[0].x;
  const a = anchors[next - 1], b = anchors[next];
  return a.x + (b.x - a.x) * Math.max(0, Math.min(1, (beat - a.beat) / (b.beat - a.beat)));
}

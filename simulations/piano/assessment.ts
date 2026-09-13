import { SCORE } from "./score.ts";
import type { PerformedNote } from "./actuator.ts";

export type NoteOutcome = "pending" | "on-time" | "early" | "late" | "missed";
export interface AssessedNote { eventId: number; midi: number; beat: number; noteIndex: number | null; timingMs: number | null; outcome: "wrong" | "on-time" | "early" | "late" }

// Observational only: this cannot emit motor commands or repair a performance.
export class PianoAssessment {
  private outcomes: NoteOutcome[] = SCORE.map(() => "pending");
  private events: AssessedNote[] = [];
  private startBeat = 0;

  reset(beat = 0): void { this.startBeat = beat; this.outcomes = SCORE.map(() => "pending"); this.events = []; }

  record(event: PerformedNote, beat: number, bpm: number): AssessedNote {
    const candidates = SCORE.map((note, index) => ({ note, index, timingMs: (beat - note.beat) * 60000 / bpm }))
      .filter(({ note, index, timingMs }) => note.beat >= this.startBeat && this.outcomes[index] === "pending" && note.midi === event.midi && Math.abs(timingMs) <= 250)
      .sort((a, b) => Math.abs(a.timingMs) - Math.abs(b.timingMs));
    const target = candidates[0];
    const outcome = !target ? "wrong" : Math.abs(target.timingMs) <= 75 ? "on-time" : target.timingMs < 0 ? "early" : "late";
    const result: AssessedNote = { eventId: event.eventId, midi: event.midi, beat, noteIndex: target?.index ?? null, timingMs: target?.timingMs ?? null, outcome };
    if (target) this.outcomes[target.index] = outcome as NoteOutcome;
    this.events.push(result);
    return result;
  }

  update(beat: number, bpm: number): void {
    SCORE.forEach((note, index) => {
      if (note.beat >= this.startBeat && this.outcomes[index] === "pending" && (beat - note.beat) * 60000 / bpm > 250) this.outcomes[index] = "missed";
    });
  }

  snapshot() {
    return { outcomes: [...this.outcomes], events: [...this.events], performed: this.events.length,
      onTime: this.events.filter(note => note.outcome === "on-time").length,
      early: this.events.filter(note => note.outcome === "early").length,
      late: this.events.filter(note => note.outcome === "late").length,
      wrong: this.events.filter(note => note.outcome === "wrong").length,
      missed: this.outcomes.filter(outcome => outcome === "missed").length };
  }
}

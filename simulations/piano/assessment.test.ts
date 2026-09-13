import assert from "node:assert/strict";
import test from "node:test";
import { PianoAssessment } from "./assessment.ts";
import { SCORE } from "./score.ts";
import type { PerformedNote } from "./actuator.ts";
const event = (midi: number, eventId = 1): PerformedNote => ({ eventId, midi, legId: "R1", velocity: 0.6, holdMs: 150, requestedNoteIndex: 0, startMs: 0, endMs: 150, source: "neural" });

test("silent motor output is scored as misses and never counted as a performance", () => {
  const assessment = new PianoAssessment(); assessment.update(12, 72);
  assert.equal(assessment.snapshot().missed, SCORE.length);
  assert.equal(assessment.snapshot().performed, 0);
});

test("correct, late and wrong played notes are recorded independently of requested note metadata", () => {
  const assessment = new PianoAssessment();
  assert.equal(assessment.record(event(76), 0.02, 72).outcome, "on-time");
  assert.equal(assessment.record(event(75, 2), 0.4, 72).outcome, "late");
  assert.equal(assessment.record(event(73, 3), 0.5, 72).outcome, "wrong");
  assert.deepEqual([assessment.snapshot().onTime, assessment.snapshot().late, assessment.snapshot().wrong], [1, 1, 1]);
  assert.equal(assessment.snapshot().events[2].midi, 73);
  assert.equal(assessment.snapshot().events[2].noteIndex, null);
});

test("seeking excludes skipped targets; a repeat cannot retroactively repair a claimed target", () => {
  const assessment = new PianoAssessment(); assessment.reset(2);
  assessment.update(2, 72); assert.equal(assessment.snapshot().missed, 0);
  const note = SCORE.find(note => note.beat === 2 && note.hand === "right")!;
  assert.notEqual(assessment.record(event(note.midi), 2, 72).outcome, "wrong");
  assert.equal(assessment.record(event(note.midi, 2), 2, 72).outcome, "wrong");
  assessment.reset(); assert.equal(assessment.snapshot().performed, 0);
});

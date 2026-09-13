import assert from "node:assert/strict";
import test from "node:test";
import { EXCERPT } from "./score-data.ts";
import { MEASURES, SCORE, TOTAL_BEATS, measureAt } from "./score.ts";
import { engravingKey, interpolatePlayhead, notationEvents } from "./notation-model.ts";

test("both engraved voices fill every source measure, including pickup and closing partial", () => {
  for (const measure of MEASURES) for (const hand of ["left", "right"] as const) {
    const notes = notationEvents(SCORE, measure, hand);
    assert.equal(notes.reduce((total, note) => total + note.duration, 0), measure.duration);
    assert.equal(EXCERPT[measure.index][hand].reduce((total, [, ticks]) => total + ticks / 4, 0), measure.duration);
    assert.equal(notes[0].beat, measure.beat);
    assert.equal(notes.at(-1)!.beat + notes.at(-1)!.duration, measure.beat + measure.duration);
  }
});

test("engraved pitches and onsets match the requested source, while articulation leaves release time", () => {
  for (const note of SCORE) {
    const engraved = notationEvents(SCORE, measureAt(note.beat), note.hand).filter(event => event.midis.includes(note.midi) && event.beat >= note.beat && event.beat < note.beat + note.writtenDuration);
    assert.equal(engraved[0].beat, note.beat);
    assert.equal(engraved.reduce((sum, event) => sum + event.duration, 0), note.writtenDuration);
    assert.ok(note.duration < note.writtenDuration);
  }
  assert.deepEqual(notationEvents(SCORE, MEASURES[0], "right").map(note => [note.midis[0], note.value]), [[76, "16"], [75, "16"]]);
  assert.deepEqual(engravingKey(75), { key: "d#/5", accidental: "#" });
  assert.deepEqual(engravingKey(40), { key: "e/2", accidental: undefined });
});

test("staff playhead uses engraved note positions and clamps at the excerpt bounds", () => {
  const anchors = [{ beat: 0, x: 80 }, { beat: 0.25, x: 120 }, { beat: 0.5, x: 170 }, { beat: TOTAL_BEATS, x: 2000 }];
  assert.equal(interpolatePlayhead(-1, anchors), 80);
  assert.equal(interpolatePlayhead(0.125, anchors), 100);
  assert.equal(interpolatePlayhead(0.25, anchors), 120);
  assert.equal(interpolatePlayhead(20, anchors), 2000);
  assert.equal(measureAt(0.49).pickup, true);
  assert.equal(measureAt(0.5).number, 1);
  assert.equal(measureAt(TOTAL_BEATS).number, 8);
});

import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_BPM, HIGHEST_KEY, KEYS, LOWEST_KEY, MEASURES, SCORE, TOTAL_BEATS, SilentTransport, clampTempo, normalizeBeat } from "./score.ts";

test("Fur Elise source pitches fit the piano and leave time for each leg to release", () => {
  assert.equal(SCORE.length, 53);
  assert.equal(KEYS.filter(key => !key.black).length, 22);
  for (const hand of ["left", "right"] as const) {
    const notes = SCORE.filter(note => note.hand === hand);
    notes.forEach((note, index) => {
      assert.ok(note.midi >= LOWEST_KEY && note.midi <= HIGHEST_KEY);
      assert.ok(note.beat >= 0 && note.beat + note.duration <= TOTAL_BEATS);
      assert.ok(note.velocity > 0 && note.velocity <= 1);
      assert.ok(note.duration > 0);
      if (notes[index + 1]) assert.ok(note.beat + note.duration < notes[index + 1].beat);
    });
  }
});

test("the sourced opening preserves E-D# pickup, 3/8 meter, bass arpeggios and first ending", () => {
  assert.equal(DEFAULT_BPM, 72);
  assert.equal(TOTAL_BEATS, 12);
  assert.equal(MEASURES.length, 9);
  assert.equal(MEASURES[0].duration, 0.5);
  assert.ok(MEASURES.slice(1, -1).every(measure => measure.duration === 1.5));
  assert.equal(MEASURES.at(-1)?.duration, 1);
  assert.deepEqual(SCORE.filter(note => note.hand === "right").slice(0, 9).map(note => note.midi), [76, 75, 76, 75, 76, 71, 74, 72, 69]);
  assert.deepEqual(SCORE.filter(note => note.hand === "left").slice(0, 6).map(note => note.midi), [45, 52, 57, 40, 52, 56]);
  assert.equal(SCORE.filter(note => note.hand === "right").at(-1)?.midi, 69);
});

test("silent transport pauses, seeks, wraps, and finishes once without a loop", () => {
  const transport = new SilentTransport();
  transport.advance(60 / DEFAULT_BPM);
  assert.ok(Math.abs(transport.beat - 1) < 1e-9);
  transport.playing = false; transport.advance(10); assert.equal(transport.beat, 1);
  transport.seek(11.9); transport.playing = true; transport.advance(1);
  assert.ok(transport.beat > 0 && transport.beat < 2);
  transport.loop = false; transport.seek(11.9); transport.advance(1);
  assert.equal(transport.beat, 12); assert.equal(transport.playing, false);
  transport.seek(-10); assert.equal(transport.beat, 0);
  transport.seek(Infinity); assert.equal(transport.beat, 0);
});

test("tempo limits and beat normalization reject invalid values", () => {
  assert.equal(clampTempo(NaN), DEFAULT_BPM);
  assert.equal(clampTempo(10), 40); assert.equal(clampTempo(120), 100);
  assert.equal(normalizeBeat(13, true), 1);
  assert.equal(normalizeBeat(13, false), 12);
  assert.equal(normalizeBeat(-1, true), 11);
});

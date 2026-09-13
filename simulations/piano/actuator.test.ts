import assert from "node:assert/strict";
import test from "node:test";
import { PianoActuator, LEG_RANGES } from "./actuator.ts";
import { LEGS, assignedLeg, keySurfacePoint } from "./performance.ts";
import { SCORE } from "./score.ts";

test("no motor command means no notes or contacts, regardless of elapsed time", () => {
  const actuator = new PianoActuator();
  for (let tick = 0; tick < 1000; tick++) actuator.advance(10);
  assert.equal(actuator.snapshot().totalContacts, 0);
  assert.equal(actuator.takeContacts().length, 0);
  assert.ok(actuator.pose().legs.every(leg => !leg.contact));
});

test("each accepted command emits exactly one event when its foot reaches the actual key", () => {
  for (const note of SCORE) {
    const actuator = new PianoActuator(), legId = assignedLeg(note);
    assert.ok(actuator.command({ legId, midi: note.midi, holdMs: 150, velocity: 0.7, requestedNoteIndex: SCORE.indexOf(note) }));
    assert.equal(actuator.takeContacts().length, 0);
    let contacts = 0;
    for (let tick = 0; tick < 100; tick++) {
      actuator.advance(10);
      const events = actuator.takeContacts(); contacts += events.length;
      const leg = actuator.pose().legs.find(leg => leg.id === legId)!;
      if (events.length) {
        assert.equal(events[0].midi, note.midi); assert.equal(events[0].source, "neural");
        assert.equal(leg.contact, true); assert.equal(leg.noteIndex, SCORE.indexOf(note));
      }
      if (leg.contact) assert.deepEqual(leg.tip, keySurfacePoint(note.midi, leg.press, leg.row));
      assert.ok(actuator.pose().legs.every(leg => leg.reachable && leg.joints.flat().every(Number.isFinite)));
    }
    assert.equal(contacts, 1); assert.equal(actuator.activeNotes().length, 0);
  }
});

test("all six independent motor slots can perform simultaneous commands without phantom notes", () => {
  const actuator = new PianoActuator();
  for (const leg of LEGS) {
    const midi = Math.round((LEG_RANGES[leg.id][0] + LEG_RANGES[leg.id][1]) / 2);
    assert.ok(actuator.command({ legId: leg.id, midi, velocity: 0.5, holdMs: 250, requestedNoteIndex: null }));
  }
  actuator.advance(50);
  assert.equal(actuator.takeContacts().length, 6);
  assert.equal(actuator.activeNotes().length, 6);
  assert.equal(new Set(actuator.pose().legs.filter(leg => leg.contact).map(leg => leg.id)).size, 6);
  actuator.advance(20);
  assert.equal(actuator.takeContacts().length, 0);
});

test("wrong pitches are retained; out-of-range, invalid and busy actions are rejected, not corrected", () => {
  const actuator = new PianoActuator();
  assert.equal(actuator.command({ legId: "R1", midi: 40, velocity: 0.5, holdMs: 100, requestedNoteIndex: 0 }), false);
  assert.equal(actuator.command({ legId: "R1", midi: NaN, velocity: 0.5, holdMs: 100, requestedNoteIndex: 0 }), false);
  assert.ok(actuator.command({ legId: "R1", midi: 73, velocity: 0.5, holdMs: 100, requestedNoteIndex: 0 }));
  assert.equal(actuator.command({ legId: "R1", midi: 76, velocity: 0.5, holdMs: 100, requestedNoteIndex: 0 }), false);
  actuator.advance(250);
  assert.equal(actuator.takeContacts()[0].midi, 73, "Must not substitute requested E5");
  const paused = actuator.snapshot(); actuator.advance(0);
  assert.deepEqual(actuator.snapshot(), paused);
  assert.equal(actuator.snapshot().rejected, 3);
  actuator.reset(); assert.equal(actuator.activeNotes().length, 0); assert.equal(actuator.snapshot().history.length, 0);
});

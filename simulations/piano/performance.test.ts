import assert from "node:assert/strict";
import test from "node:test";
import { Line3, Matrix4, Vector3 } from "three";
import { LEGS, LEG_ASSIGNMENTS, KEY_TRAVEL, articulateLegs, assignedLeg, hoverPose, keySurfacePoint, notePressure, sixLegPerformance } from "./performance.ts";
import { LEG_RANGES } from "./actuator.ts";
import type { Point3 } from "./performance.ts";
import { SCORE, TOTAL_BEATS, WHITE_WIDTH, activeNotes, isBlackKey, keyX } from "./score.ts";

const near = (a: number, b: number, tolerance = 1e-9) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

function segmentDistance(a: Point3, b: Point3, c: Point3, d: Point3): number {
  const p = new Vector3(...a), q = new Vector3(...c), u = new Vector3(...b).sub(p), v = new Vector3(...d).sub(q), w = p.clone().sub(q);
  const ab = new Line3(p, new Vector3(...b)), cd = new Line3(q, new Vector3(...d));
  let minimum = Math.min(...[p, ab.end].map(point => point.distanceTo(cd.closestPointToPoint(point, true, new Vector3()))),
    ...[q, cd.end].map(point => point.distanceTo(ab.closestPointToPoint(point, true, new Vector3()))));
  const uu = u.dot(u), uv = u.dot(v), vv = v.dot(v), uw = u.dot(w), vw = v.dot(w), denominator = uu * vv - uv * uv;
  if (denominator > 1e-12) {
    const s = (uv * vw - vv * uw) / denominator, t = (uu * vw - uv * uw) / denominator;
    if (s >= 0 && s <= 1 && t >= 0 && t <= 1) minimum = Math.min(minimum, p.addScaledVector(u, s).distanceTo(q.addScaledVector(v, t)));
  }
  return minimum;
}

test("every source note has one deterministic same-side assignment and all six legs contribute", () => {
  assert.equal(LEG_ASSIGNMENTS.length, SCORE.length);
  assert.deepEqual(LEGS.map(leg => LEG_ASSIGNMENTS.filter(note => note.legId === leg.id).length), [6, 6, 6, 12, 16, 7]);
  for (const leg of LEGS) {
    const notes = LEG_ASSIGNMENTS.filter(note => note.legId === leg.id);
    for (const [index, note] of notes.entries()) {
      assert.equal(assignedLeg(SCORE[note.noteIndex]), leg.id);
      assert.equal(note.hand, leg.hand);
      if (notes[index + 1]) assert.ok(note.beat + note.duration < notes[index + 1].beat);
    }
  }
});

test("assigned feet contact exactly the sounding key, including simultaneous notes", () => {
  let simultaneous = 0;
  for (const note of SCORE) for (const fraction of [0, 0.01, 0.5, 0.99]) {
    const beat = note.beat + note.duration * fraction;
    const contacts = sixLegPerformance(beat, true).legs.filter(leg => leg.contact);
    const active = activeNotes(beat);
    assert.deepEqual(contacts.map(leg => leg.noteIndex).sort((a, b) => a! - b!), active.map(note => SCORE.indexOf(note)).sort((a, b) => a - b));
    if (contacts.length > 1) simultaneous++;
    for (const leg of contacts) {
      const source = SCORE[leg.noteIndex!];
      assert.equal(leg.midi, source.midi); assert.equal(leg.lift, 0);
      near(leg.press, notePressure(beat, source));
      const black = isBlackKey(source.midi), z = (black ? 0.71 + leg.row * 0.075 : 1.065 + leg.row * 0.12) - 0.48;
      const expected = new Vector3(0, black ? 0.06 : 0.055, z).applyMatrix4(new Matrix4().makeRotationX(KEY_TRAVEL * leg.press)).add(new Vector3(keyX(source.midi), black ? 1.83 : 1.71, 0.48));
      near(expected.distanceTo(new Vector3(...leg.tip)), 0);
      assert.ok(z > 0 && z < (black ? 0.49 : 0.945));
      assert.ok((black ? WHITE_WIDTH * 0.6 : WHITE_WIDTH - 0.005) > 0.042);
      assert.ok(leg.tip[1] <= (black ? 1.89 : 1.765) + 1e-9, "A depressed key must move down");
    }
  }
  assert.ok(simultaneous > 0);
});

test("six fixed-length IK chains remain finite, reachable, and bounded across the excerpt", () => {
  for (const loop of [false, true]) for (let step = 0; step <= 2400; step++) {
    const beat = step / 200, performance = sixLegPerformance(beat, loop);
    assert.equal(performance.legs.length, 6);
    for (const leg of performance.legs) {
      const definition = LEGS.find(candidate => candidate.id === leg.id)!;
      assert.ok(leg.reachable, `${leg.id} cannot reach at ${beat}`);
      assert.ok(leg.reach / leg.reachLimit < 0.9);
      near(leg.lengths[1], definition.femur); near(leg.lengths[2], definition.tibia);
      near(leg.lengths[3], Math.hypot(0.165, 0.06));
      assert.ok(leg.joints.flat().every(Number.isFinite));
      for (const [x, y, z] of leg.joints) assert.ok(Math.abs(x) < 2.5 && y > 1.5 && y < 3.6 && z > -0.5 && z < 3.2, `${leg.id} outside the instrument at ${beat}: ${[x, y, z]}`);
      assert.ok(leg.press >= 0 && leg.press <= 1 && leg.lift >= 0 && leg.lift < 0.4);
      const relativeRoot = new Vector3(...leg.joints[0]).sub(new Vector3(...performance.body.position));
      assert.ok(relativeRoot.length() < 0.4, "All six roots must attach to the thorax");
    }
  }
});

test("articulated legs have clearance from the other leg chains", () => {
  for (let step = 0; step < 1200; step++) {
    const beat = step / 100, { legs } = sixLegPerformance(beat, true);
    for (let a = 0; a < legs.length; a++) for (let b = a + 1; b < legs.length; b++) {
      for (let i = 1; i < 4; i++) for (let j = 1; j < 4; j++) {
        const gap = segmentDistance(legs[a].joints[i], legs[a].joints[i + 1], legs[b].joints[j], legs[b].joints[j + 1]);
        assert.ok(gap > 0.025, `${legs[a].id}/${legs[b].id} segments ${i}/${j} intersect at ${beat}: ${gap}`);
      }
    }
  }
});

test("pause is deterministic; looping is continuous; reduced motion does not suppress strikes", () => {
  assert.deepEqual(sixLegPerformance(2.1, true), sixLegPerformance(2.1, true));
  assert.deepEqual(sixLegPerformance(0, true), sixLegPerformance(TOTAL_BEATS, true));
  assert.deepEqual(hoverPose(0, true), hoverPose(7.4, true));
  assert.ok(sixLegPerformance(2.1, true, true).legs.filter(leg => leg.contact).length === 2);
  assert.ok(sixLegPerformance(TOTAL_BEATS, false).legs.every(leg => !leg.contact));
  for (const beat of [NaN, Infinity, -Infinity]) assert.ok(sixLegPerformance(beat, true).legs.flatMap(leg => leg.joints.flat()).every(Number.isFinite));
  for (const leg of LEGS) {
    const before = sixLegPerformance(12 - 1e-7, true).legs.find(candidate => candidate.id === leg.id)!;
    const after = sixLegPerformance(0, true).legs.find(candidate => candidate.id === leg.id)!;
    assert.ok(new Vector3(...before.tip).distanceTo(new Vector3(...after.tip)) < 1e-5);
  }
  assert.ok(keySurfacePoint(76, 1, 0)[1] < keySurfacePoint(76, 0, 0)[1]);
});

test("valid wrong-note commands preserve reach and pairwise clearance across every motor range", () => {
  for (let a = 0; a < LEGS.length; a++) for (let b = a + 1; b < LEGS.length; b++) {
    for (let left = LEG_RANGES[LEGS[a].id][0]; left <= LEG_RANGES[LEGS[a].id][1]; left++) {
      for (let right = LEG_RANGES[LEGS[b].id][0]; right <= LEG_RANGES[LEGS[b].id][1]; right++) {
        const targets = sixLegPerformance(2.1, true).legs;
        for (const [index, midi] of [[a, left], [b, right]]) {
          targets[index].midi = midi; targets[index].tip = keySurfacePoint(midi, 1, targets[index].row); targets[index].press = 1;
        }
        const { legs } = articulateLegs(hoverPose(2.1), targets);
        assert.ok(legs[a].reachable && legs[b].reachable);
        for (let i = 1; i < 4; i++) for (let j = 1; j < 4; j++) {
          const gap = segmentDistance(legs[a].joints[i], legs[a].joints[i + 1], legs[b].joints[j], legs[b].joints[j + 1]);
          assert.ok(gap > 0.025, `${legs[a].id}:${left}/${legs[b].id}:${right} intersects: ${gap}`);
        }
      }
    }
  }
});

import { Euler, Quaternion, Vector3 } from "three";
import { SCORE, TOTAL_BEATS, isBlackKey, keyX, normalizeBeat } from "./score.ts";
import type { Hand, Note } from "./score.ts";

export type LegId = "L1" | "L2" | "L3" | "R1" | "R2" | "R3";
export type Point3 = [number, number, number];
export interface LegDefinition { id: LegId; hand: Hand; side: -1 | 1; row: 0 | 1 | 2; name: string; femur: number; tibia: number }
export const KEY_TRAVEL = 0.057;
export const FOOT_RADIUS = 0.008;
export const LEGS: readonly LegDefinition[] = Object.freeze(([-1, 1] as const).flatMap(side => ([0, 1, 2] as const).map(row => Object.freeze({
  id: `${side < 0 ? "L" : "R"}${row + 1}` as LegId, hand: side < 0 ? "left" as const : "right" as const,
  side, row, name: `${side < 0 ? "Left" : "Right"} ${["front", "middle", "hind"][row]}`,
  femur: [1.03, 1.03, 1.07][row], tibia: [1.12, 1.1, 1.15][row],
}))));

export function assignedLeg(note: Pick<Note, "hand" | "midi">): LegId {
  if (note.hand === "left") return note.midi <= 45 ? "L3" : note.midi <= 52 ? "L2" : "L1";
  return note.midi <= 64 ? "R3" : note.midi <= 72 ? "R2" : "R1";
}

export const LEG_ASSIGNMENTS = Object.freeze(SCORE.map((note, noteIndex) => Object.freeze({
  noteIndex, legId: assignedLeg(note), midi: note.midi, beat: note.beat, duration: note.duration, hand: note.hand,
})));
const parts = new Map(LEGS.map(leg => [leg.id, LEG_ASSIGNMENTS.filter(note => note.legId === leg.id)]));

export function notePressure(beat: number, note: Pick<Note, "beat" | "duration">): number {
  const age = beat - note.beat;
  if (age < 0 || age >= note.duration) return 0;
  return Math.max(0, Math.min(1, age / Math.min(0.035, note.duration * 0.18), (note.duration - age) / Math.min(0.1, note.duration * 0.22)));
}

// The top plane is transformed about the same hinge as the rendered piano key.
export function keySurfacePoint(midi: number, press: number, row: number): Point3 {
  const black = isBlackKey(midi), angle = press * KEY_TRAVEL;
  const z = (black ? 0.71 + row * 0.075 : 1.065 + row * 0.12) - 0.48;
  const y = black ? 0.06 : 0.055;
  return [keyX(midi), (black ? 1.83 : 1.71) + y * Math.cos(angle) - z * Math.sin(angle), 0.48 + y * Math.sin(angle) + z * Math.cos(angle)];
}

const smooth = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };
export interface LegTarget {
  id: LegId; side: number; row: number; name: string; midi: number; noteIndex: number | null;
  eventId: number | null;
  targetNoteIndex: number; contact: boolean; press: number; lift: number; phase: "strike" | "release" | "travel" | "ready";
  tip: Point3;
}

export function legTarget(beat: number, id: LegId, loop: boolean, keyPresses?: ReadonlyMap<number, number>): LegTarget {
  const time = normalizeBeat(beat, loop), leg = LEGS.find(leg => leg.id === id)!;
  const notes = parts.get(id)!;
  let previous = loop ? { ...notes[notes.length - 1], beat: notes[notes.length - 1].beat - TOTAL_BEATS } : undefined;
  let next = loop ? { ...notes[0], beat: notes[0].beat + TOTAL_BEATS } : undefined;
  for (const note of notes) {
    if (note.beat <= time) previous = note;
    else { next = note; break; }
  }
  const contact = Boolean(previous && time < previous.beat + previous.duration);
  const source = contact ? previous! : next ?? previous ?? notes[0];
  let press = contact ? keyPresses?.get(source.midi) ?? notePressure(time, source) : 0;
  press = Math.max(0, Math.min(1, press));
  let tip = new Vector3(...keySurfacePoint(source.midi, press, leg.row));
  let lift = 0;
  let phase: LegTarget["phase"] = "strike";
  if (!contact) {
    const release = previous ? previous.beat + previous.duration : -1;
    const travelStart = next ? Math.max(release + 0.10, next.beat - 0.72) : Infinity;
    if (next && time >= travelStart) {
      const t = Math.min(1, (time - travelStart) / Math.max(0.001, next.beat - travelStart));
      const from = keySurfacePoint(previous?.midi ?? next.midi, 0, leg.row);
      tip = new Vector3(...from).lerp(new Vector3(...keySurfacePoint(next.midi, 0, leg.row)), smooth(t));
      lift = 0.16 * (1 - smooth(t)) + Math.sin(t * Math.PI) ** 2 * 0.20;
      phase = "travel";
    } else {
      tip.set(...keySurfacePoint(previous?.midi ?? source.midi, 0, leg.row));
      lift = 0.16 * smooth((time - release) / 0.10);
      phase = lift < 0.16 ? "release" : "ready";
    }
    tip.y += lift;
  }
  return { id, side: leg.side, row: leg.row, name: leg.name, midi: source.midi, noteIndex: contact ? source.noteIndex : null, eventId: null,
    targetNoteIndex: source.noteIndex, contact, press, lift, phase, tip: tip.toArray() as Point3 };
}

export function hoverPose(beat: number, reducedMotion = false) {
  const phase = normalizeBeat(beat, true) * Math.PI * 2 / 1.5;
  return {
    position: [0, 2.35 + (reducedMotion ? 0 : Math.sin(phase) * 0.022), 1.66] as Point3,
    rotation: [reducedMotion ? 0 : Math.sin(phase) * 0.012, 0, reducedMotion ? 0 : Math.sin(phase / 4) * 0.016] as Point3,
    wingAngle: 0.18 + (reducedMotion ? 0 : Math.sin(phase * 20) * 0.28),
  };
}

export interface ArticulatedLeg extends LegTarget {
  joints: Point3[]; lengths: number[]; reach: number; reachLimit: number; reachable: boolean;
}

export function articulateLegs(body: ReturnType<typeof hoverPose>, targets: readonly LegTarget[]) {
  const rotation = new Quaternion().setFromEuler(new Euler(...body.rotation));
  const origin = new Vector3(...body.position);
  const legs: ArticulatedLeg[] = LEGS.map(leg => {
    const target = targets.find(target => target.id === leg.id)!;
    const root = new Vector3(leg.side * (leg.row === 1 ? 0.205 : 0.16), leg.row === 0 ? 0.30 : 0.25, -0.17 + leg.row * 0.17).applyQuaternion(rotation).add(origin);
    const hip = new Vector3(leg.side * 0.105, -0.055, (leg.row - 1) * 0.045).applyQuaternion(rotation).add(root);
    const tip = new Vector3(...target.tip);
    const ankle = new Vector3(0, 0.165, 0.06).applyAxisAngle(new Vector3(1, 0, 0), target.press * KEY_TRAVEL).add(tip);
    const direction = ankle.clone().sub(hip), reach = direction.length(); direction.normalize();
    const pole = new Vector3(leg.side * (leg.row === 1 ? 1.1 : 0.38), 0.1, [-1.1, 0.1, 1.1][leg.row]);
    const bend = pole.addScaledVector(direction, -pole.dot(direction)).normalize();
    const distance = Math.max(0.0001, Math.min(leg.femur + leg.tibia - 0.0001, reach));
    // A two-bone triangle fixes both bone lengths; each thoracic pair has its own bend plane.
    const along = (leg.femur ** 2 - leg.tibia ** 2 + distance ** 2) / (2 * distance);
    const height = Math.sqrt(Math.max(0, leg.femur ** 2 - along ** 2));
    const knee = hip.clone().addScaledVector(direction, along).addScaledVector(bend, height);
    const joints = [root, hip, knee, ankle, tip];
    return { ...target, joints: joints.map(point => point.toArray() as Point3), lengths: joints.slice(1).map((point, index) => point.distanceTo(joints[index])),
      reach, reachLimit: leg.femur + leg.tibia, reachable: reach < leg.femur + leg.tibia && reach > Math.abs(leg.femur - leg.tibia) };
  });
  return { body, legs };
}

export function sixLegPerformance(beat: number, loop: boolean, reducedMotion = false, keyPresses?: ReadonlyMap<number, number>) {
  return articulateLegs(hoverPose(beat, reducedMotion), LEGS.map(leg => legTarget(beat, leg.id, loop, keyPresses)));
}

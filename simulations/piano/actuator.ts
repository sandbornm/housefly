import { Vector3 } from "three";
import { LEGS, articulateLegs, hoverPose, keySurfacePoint } from "./performance.ts";
import type { LegId, LegTarget, Point3 } from "./performance.ts";

export const LEG_RANGES: Readonly<Record<LegId, readonly [number, number]>> = Object.freeze({
  L1: [53, 59], L2: [46, 52], L3: [40, 45], R1: [73, 76], R2: [65, 72], R3: [60, 64],
});
export interface MotorCommand {
  legId: LegId; midi: number; velocity: number; holdMs: number;
  requestedNoteIndex: number | null;
  neuralTick?: number; neuralSimulatedMs?: number;
}
export interface PerformedNote extends MotorCommand {
  eventId: number; startMs: number; endMs: number; source: "neural";
}
interface LegState {
  target: LegTarget; from: Point3; departureMs: number; arrivalMs: number; releaseMs: number;
  command: MotorCommand | null; event: PerformedNote | null;
}
const smooth = (t: number) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };

// This actuator knows the keyboard, not the score. Only accepted motor commands can strike.
export class PianoActuator {
  private timeMs = 0;
  private serial = 0;
  private states = new Map<LegId, LegState>();
  private history: PerformedNote[] = [];
  private pending: PerformedNote[] = [];
  rejected = 0;

  constructor() { this.reset(); }

  reset(): void {
    this.timeMs = 0; this.history = []; this.pending = []; this.rejected = 0;
    this.states.clear();
    for (const leg of LEGS) {
      const [low, high] = LEG_RANGES[leg.id], midi = Math.round((low + high) / 2);
      const tip = keySurfacePoint(midi, 0, leg.row); tip[1] += 0.16;
      this.states.set(leg.id, { target: { ...leg, midi, noteIndex: null, targetNoteIndex: -1, eventId: null, contact: false, press: 0, lift: 0.16, phase: "ready", tip },
        from: [...tip], departureMs: 0, arrivalMs: 0, releaseMs: 0, command: null, event: null });
    }
  }

  command(command: MotorCommand): boolean {
    const state = this.states.get(command.legId), range = LEG_RANGES[command.legId];
    if (!state || !range || !Number.isInteger(command.midi) || command.midi < range[0] || command.midi > range[1] ||
      !Number.isFinite(command.velocity) || command.velocity <= 0 || !Number.isFinite(command.holdMs) || command.holdMs <= 0 || state.command) {
      this.rejected++; return false;
    }
    const target = keySurfacePoint(command.midi, 0, state.target.row);
    const distance = new Vector3(...state.target.tip).distanceTo(new Vector3(...target));
    state.command = { ...command, velocity: Math.min(1, command.velocity), holdMs: Math.max(50, Math.min(750, command.holdMs)) };
    state.event = null; state.from = [...state.target.tip]; state.departureMs = this.timeMs;
    state.arrivalMs = this.timeMs + Math.max(25, distance / 6.5 * 1000);
    state.releaseMs = state.arrivalMs + state.command.holdMs;
    state.target.contact = false; state.target.press = 0; state.target.phase = "travel";
    state.target.noteIndex = null; state.target.eventId = null; state.target.targetNoteIndex = command.requestedNoteIndex ?? -1;
    return true;
  }

  advance(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    this.timeMs += milliseconds;
    for (const state of this.states.values()) {
      const command = state.command;
      if (!command) continue;
      const { target } = state;
      target.midi = command.midi;
      if (this.timeMs < state.arrivalMs) {
        const t = (this.timeMs - state.departureMs) / (state.arrivalMs - state.departureMs);
        const destination = keySurfacePoint(command.midi, 0, target.row);
        const tip = new Vector3(...state.from).lerp(new Vector3(...destination), smooth(t));
        const arc = 0.18 * Math.sin(Math.PI * t) ** 2;
        tip.y += arc; target.tip = tip.toArray() as Point3;
        target.lift = Math.max(0, tip.y - destination[1]); target.phase = "travel";
        continue;
      }
      if (!state.event) {
        // Contact is acknowledged on the actuator tick, never scheduled retroactively.
        state.arrivalMs = this.timeMs; state.releaseMs = this.timeMs + command.holdMs;
        state.event = { ...command, eventId: ++this.serial, startMs: this.timeMs, endMs: state.releaseMs, source: "neural" };
        this.pending.push(state.event); this.history.push(state.event);
        if (this.history.length > 256) this.history.shift();
      }
      if (this.timeMs < state.releaseMs) {
        target.contact = true; target.phase = "strike"; target.lift = 0;
        target.eventId = state.event.eventId;
        target.noteIndex = command.requestedNoteIndex;
        target.press = Math.min(1, (state.releaseMs - this.timeMs) / Math.min(18, command.holdMs * 0.22));
        target.tip = keySurfacePoint(command.midi, target.press, target.row);
      } else {
        target.contact = false; target.noteIndex = null; target.eventId = null; target.press = 0;
        target.lift = 0.16 * smooth((this.timeMs - state.releaseMs) / 30);
        target.phase = target.lift < 0.16 ? "release" : "ready";
        target.tip = keySurfacePoint(command.midi, 0, target.row); target.tip[1] += target.lift;
        if (target.phase === "ready") state.command = null;
      }
    }
  }

  takeContacts(): PerformedNote[] { const pending = this.pending; this.pending = []; return pending; }
  activeNotes(): readonly PerformedNote[] { return [...this.states.values()].flatMap(state => state.target.contact && state.event ? [state.event] : []); }
  pressures(): ReadonlyMap<number, number> { return new Map([...this.states.values()].filter(state => state.target.contact).map(state => [state.target.midi, state.target.press])); }
  pose(reducedMotion = false) { return articulateLegs(hoverPose(this.timeMs / 1000 * 1.2, reducedMotion), [...this.states.values()].map(state => state.target)); }
  snapshot() { return { timeMs: this.timeMs, totalContacts: this.serial, rejected: this.rejected, history: [...this.history], active: this.activeNotes(),
    legs: [...this.states.values()].map(state => ({ busy: Boolean(state.command), ...state.target })) }; }
}

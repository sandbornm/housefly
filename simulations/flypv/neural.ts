import { CEILING, DRONE_RADIUS, manualVelocity, terrainHeight, wrapAngle, type FlightInput, type Point } from './flight.ts';
import type { NeuralFrame } from '../../src/neural/runtime.ts';
import type { ReadoutDecision } from '../../src/neural/policy.ts';

export const FLIGHT_ACTIONS = ['hold', 'forward', 'yaw-left', 'yaw-right', 'ascend', 'descend', 'brake'] as const;
export type FlightAction = typeof FLIGHT_ACTIONS[number];
export const SENSOR_COUNT = 32;
export const NEURAL_WINDOW_MS = 20;
export const CONTROL_INTERVAL = .1;
export const CLEARANCE_RANGE = 24;
export const CLEARANCE_DIRECTIONS = [0, -.65, .65, -Math.PI / 2, Math.PI / 2, 'up', 'down', Math.PI] as const;

export interface FlightObservation {
  position: Point;
  velocity: Point;
  heading: number;
  turnRate: number;
  goal: Point;
  contact: boolean;
  clearances: Float32Array;
}

export type FlightNeuralFrame = NeuralFrame;

export interface FlightReadout {
  decide(frame: FlightNeuralFrame, allowedIndices?: number[], options?: { temperature?: number; sample?: boolean }): FlightReadoutDecision | null;
}

export type FlightReadoutDecision = ReadoutDecision;

const clamp = (value: number, high = 1) => Math.max(0, Math.min(high, value));

export function observeGoal(observation: FlightObservation) {
  const { position, velocity, heading, goal } = observation;
  const dx = goal.x - position.x, dy = goal.y - position.y, dz = goal.z - position.z;
  const distance = Math.hypot(dx, dy, dz);
  return { distance, bearing: wrapAngle(Math.atan2(-dx, -dz) - heading), altitudeError: dy,
    altitude: Math.max(0, position.y - terrainHeight(position.x, position.z) - DRONE_RADIUS),
    forward: -Math.sin(heading) * velocity.x - Math.cos(heading) * velocity.z,
    strafe: Math.cos(heading) * velocity.x - Math.sin(heading) * velocity.z,
    progressRate: distance ? (dx * velocity.x + dy * velocity.y + dz * velocity.z) / distance : 0 };
}

export function encodeFlight(observation: FlightObservation): Float32Array {
  if (observation.clearances.length !== 8) throw new Error('Flight needs eight measured clearances');
  const goal = observeGoal(observation), rates = new Float32Array(SENSOR_COUNT);
  const pair = (index: number, value: number, scale: number) => { rates[index] = clamp(value / scale) * 150; rates[index + 1] = clamp(-value / scale) * 150; };
  pair(0, Math.sin(goal.bearing), 1);
  rates[2] = clamp((Math.cos(goal.bearing) + 1) / 2) * 150;
  rates[3] = clamp(-Math.cos(goal.bearing)) * 150;
  rates[4] = clamp(1 - goal.distance / 50) * 150; rates[5] = clamp(goal.distance / 50) * 150;
  pair(6, goal.altitudeError, 12);
  rates[8] = clamp(1 - goal.altitude / 8) * 150; rates[9] = clamp(goal.altitude / CEILING) * 150;
  pair(10, goal.forward, 14); pair(12, goal.strafe, 14); pair(14, observation.velocity.y, 8); pair(16, observation.turnRate, 1.55);
  for (let i = 0; i < 8; i++) rates[18 + i] = clamp(1 - observation.clearances[i] / CLEARANCE_RANGE) * 150;
  rates[26] = observation.contact ? 150 : 0;
  pair(27, goal.progressRate, 14);
  rates[29] = goal.distance < 5 ? 150 : 0;
  rates[30] = clamp(Math.hypot(observation.velocity.x, observation.velocity.y, observation.velocity.z) / 18) * 150;
  rates[31] = 40;
  if (rates.some(value => !Number.isFinite(value))) throw new Error('Non-finite flight observation');
  return rates;
}

export interface NeuralMotorDecision {
  powered: boolean;
  action: FlightAction | 'unavailable' | 'silenced' | 'no-spikes' | 'calibration';
  frameTick: number | null;
  featureHash: number;
  spikeCount: number;
  input: FlightInput;
  target: Point | null;
  yawRate: number;
  readout: FlightReadoutDecision | null;
}

export function featureHash(rates: Float32Array): number {
  const bits = new Uint32Array(rates.buffer, rates.byteOffset, rates.length);
  let hash = 2166136261;
  for (const value of bits) hash = Math.imul(hash ^ value, 16777619) >>> 0;
  return hash;
}

export function unpowered(action: 'unavailable' | 'silenced' | 'no-spikes' | 'calibration' = 'unavailable', frame?: FlightNeuralFrame): NeuralMotorDecision {
  return { powered: false, action, frameTick: frame?.tick ?? null, featureHash: frame ? featureHash(frame.rates) : 0,
    spikeCount: frame?.spikes.length ?? 0, input: { forward: 0, strafe: 0, lift: 0, yaw: 0 }, target: null, yawRate: 0, readout: null };
}

export function decodeFlight(frame: FlightNeuralFrame, readout: FlightReadout, heading: number, speed: number): NeuralMotorDecision {
  if (frame.rates.length !== 128 || frame.levels.length !== 139662 || !Number.isFinite(frame.tick)
    || frame.rates.some(value => !Number.isFinite(value) || value < 0)) throw new Error('Invalid measured neural frame');
  if (frame.silenced) return unpowered('silenced', frame);
  if (!frame.rates.some(value => value > 0)) return unpowered('no-spikes', frame);
  const readoutDecision = readout.decide(frame, undefined, { sample: false, temperature: .6 });
  if (!readoutDecision) return unpowered('unavailable', frame);
  const { index } = readoutDecision;
  if (readoutDecision.tick !== frame.tick || readoutDecision.simulatedMs !== frame.simulatedMs) throw new Error('Readout returned a different neural frame');
  if (!Number.isInteger(index) || index < 0 || index >= FLIGHT_ACTIONS.length) throw new Error('Invalid learned flight action');
  const action = FLIGHT_ACTIONS[index];
  const input = { forward: Number(action === 'forward'), strafe: 0,
    lift: Number(action === 'ascend') - Number(action === 'descend'), yaw: Number(action === 'yaw-left') - Number(action === 'yaw-right') };
  return { powered: true, action, frameTick: frame.tick, featureHash: featureHash(frame.rates), spikeCount: frame.spikes.length,
    input, target: manualVelocity(input, heading, speed), yawRate: input.yaw * .8, readout: readoutDecision };
}

export class FlightGoals {
  index = 0;
  reached = 0;
  contacts = 0;
  private touching = false;
  readonly points: readonly Point[];
  constructor(points: readonly Point[]) { if (!points.length) throw new Error('Flight goals are empty'); this.points = points; }
  get current(): Point { return this.points[this.index]; }
  update(position: Point, contact: boolean): boolean {
    if (contact && !this.touching) this.contacts++;
    this.touching = contact;
    if (Math.hypot(position.x - this.current.x, position.y - this.current.y, position.z - this.current.z) >= 5) return false;
    this.index = (this.index + 1) % this.points.length; this.reached++; return true;
  }
  reset(): void { this.index = 0; this.reached = 0; this.contacts = 0; this.touching = false; }
}

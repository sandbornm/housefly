import type { NeuralFrame } from '../../src/neural/runtime.ts';
import type { ReadoutDecision } from '../../src/neural/policy.ts';
import {
  CEILING, CONTROL_INTERVAL, FLYSIM_ACTIONS, FLYSIM_ENCODER, NEURAL_WINDOW_MS, SENSOR_COUNT, WORLD_LIMIT,
  type FlysimAction, type FlysimInput, type FlysimObservation, type ThreatKind, type Vec3,
} from './types.ts';

export { CONTROL_INTERVAL, FLYSIM_ACTIONS, FLYSIM_ENCODER, NEURAL_WINDOW_MS, SENSOR_COUNT };
export type { FlysimAction, FlysimInput, FlysimObservation };

export type FlysimNeuralFrame = NeuralFrame;
export type FlysimPhase = 'uncalibrated' | 'calibration' | 'inference' | 'failed';
export interface FlysimReadout {
  decide(frame: FlysimNeuralFrame, allowedIndices?: number[], options?: { temperature?: number; sample?: boolean }): ReadoutDecision | null;
}

const KIND_RATE: Record<ThreatKind, number> = { human: 37.5, swat: 75, frog: 112.5, bird: 150 };
const HOLD_INPUT: FlysimInput = { forward: 0, yaw: 0, lift: 0, dash: false };
const clamp = (value: number, high = 1) => Math.max(0, Math.min(high, value));
const wrapAngle = (value: number) => Math.atan2(Math.sin(value), Math.cos(value));
const bearingOf = (dx: number, dz: number, heading: number) => wrapAngle(Math.atan2(-dx, -dz) - heading);

export interface NeuralMotorDecision {
  powered: boolean;
  action: FlysimAction | 'unavailable' | 'silenced' | 'no-spikes' | 'calibration';
  frameTick: number | null;
  featureHash: number;
  spikeCount: number;
  input: FlysimInput;
  target: Vec3 | null;
  yawRate: number;
  readout: ReadoutDecision | null;
}

export function featureHash(rates: Float32Array): number {
  const bits = new Uint32Array(rates.buffer, rates.byteOffset, rates.length);
  let hash = 2166136261;
  for (const value of bits) hash = Math.imul(hash ^ value, 16777619) >>> 0;
  return hash;
}

/** Station-keep only while loading or rehearsing. Inference without a powered readout falls. */
export function autopilotDrive(phase: FlysimPhase | undefined, silenced: boolean, powered: boolean): 'neural' | 'hold' | 'fall' {
  if (silenced || phase === 'failed' || (phase === 'inference' && !powered)) return 'fall';
  if (powered) return 'neural';
  return 'hold';
}

export function unpowered(action: 'unavailable' | 'silenced' | 'no-spikes' | 'calibration' = 'unavailable', frame?: FlysimNeuralFrame): NeuralMotorDecision {
  return { powered: false, action, frameTick: frame?.tick ?? null, featureHash: frame ? featureHash(frame.rates) : 0,
    spikeCount: frame?.spikes.length ?? 0, input: { ...HOLD_INPUT }, target: null, yawRate: 0, readout: null };
}

/** 32 Hz channels: altitude, speed, heading-relative food, then 4 threats as range/bearing/closing/kind. */
export function encodeFlysim(observation: FlysimObservation): Float32Array {
  const rates = new Float32Array(SENSOR_COUNT);
  const pair = (index: number, value: number, scale: number) => { rates[index] = clamp(value / scale) * 150; rates[index + 1] = clamp(-value / scale) * 150; };
  const speed = Math.hypot(observation.velocity.x, observation.velocity.y, observation.velocity.z);
  rates[0] = clamp(observation.altitude / CEILING) * 150;
  rates[1] = clamp(speed / 8) * 150;
  if (observation.food) {
    const dx = observation.food.x - observation.position.x, dy = observation.food.y - observation.position.y, dz = observation.food.z - observation.position.z;
    const bearing = bearingOf(dx, dz, observation.heading);
    rates[2] = clamp(1 - Math.hypot(dx, dy, dz) / WORLD_LIMIT) * 150;
    pair(3, Math.sin(bearing), 1);
    rates[5] = clamp(Math.cos(bearing)) * 150;
    pair(6, dy, 4);
  }
  const ranked = observation.threats.map((threat, index) => ({ threat, index }))
    .sort((a, b) => a.threat.range - b.threat.range || a.index - b.index).slice(0, 4);
  for (let slot = 0; slot < ranked.length; slot++) {
    const threat = ranked[slot].threat, base = 8 + slot * 6, bearing = bearingOf(threat.dx, threat.dz, observation.heading);
    rates[base] = clamp(1 - threat.range / WORLD_LIMIT) * 150;
    pair(base + 1, Math.sin(bearing), 1);
    pair(base + 3, threat.closing, 8);
    rates[base + 5] = KIND_RATE[threat.kind] ?? 0;
  }
  if (rates.some(value => !Number.isFinite(value))) throw new Error('Non-finite flysim observation');
  return rates;
}

function motorInput(action: FlysimAction): FlysimInput {
  return {
    forward: Number(action === 'forward' || action === 'dash'),
    yaw: Number(action === 'yaw-left') - Number(action === 'yaw-right'),
    lift: Number(action === 'climb') - Number(action === 'dive'),
    dash: action === 'dash',
  };
}

function motorTarget(input: FlysimInput, heading: number): Vec3 {
  const speed = input.dash ? 8 : 4;
  return { x: -Math.sin(heading) * input.forward * speed, y: input.lift * speed * .6, z: -Math.cos(heading) * input.forward * speed };
}

export function decodeEscape(frame: FlysimNeuralFrame, readout: FlysimReadout, observation: FlysimObservation): NeuralMotorDecision {
  if (frame.rates.length !== 128 || frame.levels.length !== 139662 || !Number.isFinite(frame.tick)
    || frame.rates.some(value => !Number.isFinite(value) || value < 0)) throw new Error('Invalid measured neural frame');
  if (frame.silenced) return unpowered('silenced', frame);
  if (!frame.rates.some(value => value > 0)) return unpowered('no-spikes', frame);
  const allowed = FLYSIM_ACTIONS.map((_, index) => index);
  const readoutDecision = readout.decide(frame, allowed, { sample: false });
  if (!readoutDecision) return unpowered('unavailable', frame);
  const { index } = readoutDecision;
  if (readoutDecision.tick !== frame.tick || readoutDecision.simulatedMs !== frame.simulatedMs) throw new Error('Readout returned a different neural frame');
  if (!Number.isInteger(index) || index < 0 || index >= FLYSIM_ACTIONS.length) throw new Error('Invalid learned escape action');
  const action = FLYSIM_ACTIONS[index], input = motorInput(action);
  return { powered: true, action, frameTick: frame.tick, featureHash: featureHash(frame.rates), spikeCount: frame.spikes.length,
    input, target: motorTarget(input, observation.heading), yawRate: input.yaw * .8, readout: readoutDecision };
}

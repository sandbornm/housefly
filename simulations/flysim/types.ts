/** Shared Fly Simulator contracts. World, neural, and shell import this file only. */

export const SENSOR_COUNT = 32;
export const NEURAL_WINDOW_MS = 20;
export const CONTROL_INTERVAL = 0.1;
export const FLYSIM_ENCODER = "flysim-escape-32-v1";
export const FLYSIM_ACTIONS = ["hold", "forward", "yaw-left", "yaw-right", "climb", "dive", "dash"] as const;
export type FlysimAction = typeof FLYSIM_ACTIONS[number];
export type ThreatKind = "human" | "swat" | "frog" | "bird";

export interface Vec3 { x: number; y: number; z: number }

export interface ThreatObservation {
  kind: ThreatKind;
  dx: number;
  dy: number;
  dz: number;
  range: number;
  closing: number;
}

export interface FlysimObservation {
  position: Vec3;
  velocity: Vec3;
  heading: number;
  altitude: number;
  threats: ThreatObservation[];
  food: Vec3 | null;
  grounded: boolean;
  hit: boolean;
}

export interface FlysimInput {
  forward: number;
  yaw: number;
  lift: number;
  dash: boolean;
}

export const SPAWN: Vec3 = { x: 0, y: 1.4, z: 2.2 };
export const WORLD_LIMIT = 18;
export const CEILING = 8;

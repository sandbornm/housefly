export interface Point { x: number; y: number; z: number }
export interface FlightInput { forward: number; strafe: number; lift: number; yaw: number }
export const FIXED_DT = 1 / 60;
export const WORLD_LIMIT = 98;
export const CEILING = 46;
export const DRONE_RADIUS = 2.05;
export const SPAWN: Point = { x: 0, y: 9, z: 29 };
export const ROUTE: Point[] = [
  { x: 0, y: 11, z: 2 }, { x: -3, y: 15, z: -26 },
  { x: -32, y: 17, z: -29 }, { x: -47, y: 18, z: -7 },
  { x: -43, y: 14, z: 31 }, { x: -14, y: 11, z: 44 },
  { x: 17, y: 12, z: 39 }, { x: 37, y: 16, z: 20 },
  { x: 31, y: 20, z: -21 }, { x: 10, y: 15, z: -28 },
  { x: 2, y: 10, z: -5 }, { x: 0, y: 9, z: 29 },
];

export function terrainHeight(x: number, z: number): number {
  const edge = Math.max(0, Math.min(1, (Math.max(Math.abs(x), Math.abs(z)) - 45) / 32));
  return edge * (2.6 + 1.7 * Math.sin(x * .071) * Math.cos(z * .059) + 1.5 * Math.sin(z * .04 + x * .037));
}

export function wrapAngle(value: number): number { return Math.atan2(Math.sin(value), Math.cos(value)); }

export function manualVelocity(input: FlightInput, heading: number, speed: number): Point {
  const length = Math.max(1, Math.hypot(input.forward, input.strafe));
  const forward = input.forward / length * speed, strafe = input.strafe / length * speed;
  return { x: -Math.sin(heading) * forward + Math.cos(heading) * strafe, y: input.lift * speed * .6, z: -Math.cos(heading) * forward - Math.sin(heading) * strafe };
}

export function boundedVelocity(position: Point, velocity: Point): Point {
  const result = { ...velocity };
  for (const axis of ['x', 'z'] as const) {
    if (Math.abs(position[axis]) > WORLD_LIMIT - 6 && position[axis] * result[axis] > 0) result[axis] *= Math.max(0, (WORLD_LIMIT - 2 - Math.abs(position[axis])) / 4);
  }
  if (position.y > CEILING - 3 && result.y > 0) result.y *= Math.max(0, (CEILING - 1 - position.y) / 2);
  return result;
}

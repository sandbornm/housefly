import { FLYSIM_ACTIONS, type FlysimAction, type FlysimObservation, type ThreatKind, type ThreatObservation } from './types.ts';

const wrapAngle = (value: number) => Math.atan2(Math.sin(value), Math.cos(value));

// Teacher labels are used exclusively in explicit sensor-rehearsal calibration.
export function teacherAction(observation: FlysimObservation): number {
  const closing = observation.threats.reduce<ThreatObservation | undefined>((best, threat) =>
    threat.closing > .2 && (!best || threat.range < best.range) ? threat : best, undefined);
  const action: FlysimAction = closing ? 'dash'
    : observation.threats.some(threat => threat.kind === 'frog') ? 'climb'
    : foodAction(observation);
  return FLYSIM_ACTIONS.indexOf(action);
}

function foodAction(observation: FlysimObservation): FlysimAction {
  if (!observation.food) return 'hold';
  const dx = observation.food.x - observation.position.x, dy = observation.food.y - observation.position.y, dz = observation.food.z - observation.position.z;
  const bearing = wrapAngle(Math.atan2(-dx, -dz) - observation.heading);
  if (bearing > .22) return 'yaw-left';
  if (bearing < -.22) return 'yaw-right';
  if (dy > 1.2) return 'climb';
  if (dy < -1.2) return 'dive';
  return Math.hypot(dx, dy, dz) > 2 ? 'forward' : 'hold';
}

export function calibrationObservation(index: number): FlysimObservation {
  const action = index % FLYSIM_ACTIONS.length, variation = Math.floor(index / FLYSIM_ACTIONS.length);
  const heading = (variation % 12) / 12 * Math.PI * 2;
  const position = { x: 0, y: 2 + variation % 5, z: 0 };
  const speed = (variation % 4) * .4;
  const velocity = { x: -Math.sin(heading) * speed, y: 0, z: -Math.cos(heading) * speed };
  const kinds: ThreatKind[] = ['human', 'swat', 'frog', 'bird'];
  const foodAt = (bearing: number, distance: number, dy: number) => ({
    x: position.x - Math.sin(heading + bearing) * distance, y: position.y + dy, z: position.z - Math.cos(heading + bearing) * distance,
  });
  const threatAt = (kind: ThreatKind, bearing: number, range: number, closing: number): ThreatObservation => {
    const dx = -Math.sin(heading + bearing) * range, dz = -Math.cos(heading + bearing) * range;
    return { kind, dx, dy: 0, dz, range: Math.hypot(dx, dz), closing };
  };
  const idle = { position, velocity, heading, altitude: position.y, grounded: false, hit: false };
  if (action === 0) return { ...idle, threats: [], food: null };
  if (action === 4) return { ...idle, threats: [threatAt('frog', .2 * (variation % 5 - 2), 6 + variation % 4, -.4)], food: null };
  if (action === 6) return { ...idle, threats: [threatAt(kinds[variation % 4], 0, 4 + variation % 5, 1.5 + variation % 3)], food: null };
  const bearing = action === 2 ? .35 + (variation % 6) * .2 : action === 3 ? -.35 - (variation % 6) * .2 : 0;
  const distance = action === 1 ? 8 + variation % 7 : 10;
  return { ...idle, threats: [], food: foodAt(bearing, distance, action === 5 ? -3 - variation % 3 : 0) };
}

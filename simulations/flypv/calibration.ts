import { CLEARANCE_RANGE, FLIGHT_ACTIONS, observeGoal, type FlightObservation } from './neural.ts';

// Teacher labels are used exclusively in explicit sensor-rehearsal calibration.
export function teacherAction(observation: FlightObservation): number {
  const goal = observeGoal(observation);
  const action = observation.contact || (observation.clearances[0] < 4 && goal.forward > .5) ? 'brake'
    : goal.altitudeError > 1.5 && observation.clearances[5] > 3 ? 'ascend'
    : goal.altitudeError < -1.5 && observation.clearances[6] > 3 ? 'descend'
    : goal.bearing > .22 ? 'yaw-left' : goal.bearing < -.22 ? 'yaw-right'
    : goal.distance < 5 ? 'hold' : 'forward';
  return FLIGHT_ACTIONS.indexOf(action);
}

export function calibrationObservation(index: number): FlightObservation {
  const action = index % FLIGHT_ACTIONS.length, variation = Math.floor(index / FLIGHT_ACTIONS.length);
  const heading = (variation % 12) / 12 * Math.PI * 2;
  const bearing = action === 2 ? .35 + (variation % 6) * .25 : action === 3 ? -.35 - (variation % 6) * .25 : 0;
  const distance = action === 0 ? 1 : 12 + (variation % 7) * 5;
  const position = { x: 0, y: 10 + variation % 10, z: 0 };
  const velocity = { x: -Math.sin(heading) * (action === 6 ? 5 : variation % 4), y: 0, z: -Math.cos(heading) * (action === 6 ? 5 : variation % 4) };
  const clearances = new Float32Array(8).fill(CLEARANCE_RANGE);
  clearances[6] = position.y - 2.05;
  if (action === 6) clearances[0] = 2;
  return { position, velocity, heading, turnRate: 0, contact: false, clearances,
    goal: { x: -Math.sin(heading + bearing) * distance, y: position.y + (action === 4 ? 4 : action === 5 ? -4 : 0), z: -Math.cos(heading + bearing) * distance } };
}

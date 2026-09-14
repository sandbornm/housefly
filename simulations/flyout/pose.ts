export interface FlyMotion {
  moving: boolean;
  reaching: boolean;
  throwing: boolean;
  swinging: boolean;
}

export const IDLE_MOTION: FlyMotion = { moving: false, reaching: false, throwing: false, swinging: false };

/** Three world-space joints for one thoracic leg: hip, knee, foot. */
export function flyLegPoints(time: number, side: number, row: number, motion: FlyMotion): [number, number, number][] {
  const hip: [number, number, number] = [side * .22, .65, .34 - row * .28];
  const knee: [number, number, number] = [side * (.65 + (row === 1 ? .08 : 0)), .39, .62 - row * .57];
  const foot: [number, number, number] = [side * .78, .07, .86 - row * .7];
  // Opposite sides and adjacent rows stay out of phase so a tripod gait plants three feet.
  const gait = time * 14 + row * 2.094 + (side > 0 ? Math.PI : 0);
  const lift = motion.moving ? Math.max(0, Math.sin(gait)) : 0;
  const stride = motion.moving ? Math.cos(gait) : 0;
  knee[1] += lift * .12; knee[2] += stride * .08;
  foot[1] += lift * .22; foot[2] += stride * .16;
  if (motion.reaching && row === 0) {
    knee[1] += .18; knee[2] += .22;
    foot[1] += .32; foot[2] += .42;
  }
  if (motion.throwing && row === 0) {
    knee[1] += .28; knee[2] -= .06;
    foot[1] += .52; foot[2] -= .12;
  }
  if (motion.swinging) {
    if (row === 0) { knee[1] += .14; foot[1] += .26; foot[2] += .18; }
    else { foot[2] -= .1; foot[1] += .04; }
  }
  foot[1] = Math.max(.04, foot[1]);
  return [hip, knee, foot];
}

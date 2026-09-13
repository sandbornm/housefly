export type Team = 0 | 1;
export type Bases = [boolean, boolean, boolean];
export type PlateResult = 'strike' | 'ball' | 'foul' | 'out' | 'single' | 'double' | 'triple' | 'homer';

export interface Score {
  inning: number;
  half: Team;
  outs: number;
  balls: number;
  strikes: number;
  bases: Bases;
  runs: [number, number];
  hits: [number, number];
  innings: [number[], number[]];
  complete: boolean;
  last: string;
}

export const INNINGS = 3;
export const BASE_SECONDS = 3.8;
export const STEP = 1 / 60;
export const MAX_STEPS = 6;

export function newGame(): Score {
  return { inning: 1, half: 0, outs: 0, balls: 0, strikes: 0,
    bases: [false, false, false], runs: [0, 0], hits: [0, 0],
    innings: [[0, 0, 0], [0, 0, 0]], complete: false, last: 'Play ball' };
}

function addRuns(score: Score, runs: number): void {
  score.runs[score.half] += runs;
  score.innings[score.half][score.inning - 1] += runs;
}

function advance(score: Score, steps: number): number {
  let runs = steps === 4 ? 1 : 0;
  const bases: Bases = [false, false, false];
  for (let i = 0; i < 3; i++) {
    if (!score.bases[i]) continue;
    if (i + steps >= 3) runs++;
    else bases[i + steps] = true;
  }
  if (steps < 4) bases[steps - 1] = true;
  score.bases = bases;
  addRuns(score, runs);
  return runs;
}

function recordOut(score: Score): void {
  score.outs++;
  if (score.outs < 3) return;
  score.outs = 0;
  score.bases = [false, false, false];
  if (score.half === 0) score.half = 1;
  else if (score.inning === INNINGS) { score.complete = true; score.outs = 3; }
  else { score.half = 0; score.inning++; }
}

/** Three full innings, ties allowed; runners hold on every out. */
export function applyResult(previous: Score, result: PlateResult): Score {
  if (previous.complete) return previous;
  const score: Score = { ...previous, bases: [...previous.bases], runs: [...previous.runs],
    hits: [...previous.hits], innings: [[...previous.innings[0]], [...previous.innings[1]]] };
  let ended = false;
  if (result === 'strike') {
    score.strikes++;
    score.last = score.strikes === 3 ? 'Strikeout' : 'Strike';
    if (score.strikes === 3) { recordOut(score); ended = true; }
  } else if (result === 'foul') {
    score.strikes = Math.min(2, score.strikes + 1);
    score.last = 'Foul ball';
  } else if (result === 'ball') {
    score.balls++;
    score.last = 'Ball';
    if (score.balls === 4) {
      if (score.bases[0]) {
        if (score.bases[1]) {
          if (score.bases[2]) addRuns(score, 1);
          score.bases[2] = true;
        }
        score.bases[1] = true;
      }
      score.bases[0] = true;
      score.last = 'Walk'; ended = true;
    }
  } else if (result === 'out') {
    recordOut(score); score.last = 'Out'; ended = true;
  } else {
    const steps = { single: 1, double: 2, triple: 3, homer: 4 }[result];
    const runs = advance(score, steps);
    score.hits[score.half]++;
    score.last = { single: 'Single', double: 'Double', triple: 'Triple', homer: 'Home run' }[result];
    if (runs) score.last += ` / ${runs} run${runs === 1 ? '' : 's'}`;
    ended = true;
  }
  if (ended) { score.balls = 0; score.strikes = 0; }
  return score;
}

export function isFair(x: number, z: number): boolean {
  return z <= 12 && Math.abs(x) <= 12 - z + 0.22;
}

export function resolveThrow(base: number, elapsed: number): PlateResult {
  if (base === 1 && elapsed < BASE_SECONDS) return 'out';
  const bases = Math.min(3, Math.max(1, Math.floor(elapsed / BASE_SECONDS)));
  return (['single', 'double', 'triple'] as const)[bases - 1];
}

/** Discard excess wall time after a stalled frame; never spiral through catch-up steps. */
export function fixedSteps(accumulator: number, delta: number): { steps: number; remainder: number } {
  const total = Math.max(0, accumulator) + Math.min(Math.max(0, delta), STEP * MAX_STEPS);
  const steps = Math.min(MAX_STEPS, Math.floor((total + 1e-10) / STEP));
  return { steps, remainder: Math.max(0, Math.min(STEP, total - steps * STEP)) };
}

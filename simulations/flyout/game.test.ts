import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyResult, BASE_SECONDS, fixedSteps, isFair, MAX_STEPS, newGame, resolveThrow, STEP, type PlateResult, type Score } from './game.ts';

function results(score: Score, ...outcomes: PlateResult[]): Score {
  return outcomes.reduce(applyResult, score);
}

test('three strikes record one out and reset the count; two-strike fouls stay alive', () => {
  const two = results(newGame(), 'strike', 'foul', 'foul', 'foul');
  assert.equal(two.strikes, 2); assert.equal(two.outs, 0);
  const out = applyResult(two, 'strike');
  assert.equal(out.outs, 1); assert.equal(out.strikes, 0); assert.equal(out.balls, 0);
});

test('third out switches halves and clears runners; third bottom finishes with no extra innings', () => {
  let game = results(newGame(), 'single', 'out', 'out', 'out');
  assert.equal(game.half, 1); assert.equal(game.inning, 1);
  assert.deepEqual(game.bases, [false, false, false]); assert.equal(game.outs, 0);
  game = results(game, ...Array<PlateResult>(15).fill('out'));
  assert.equal(game.complete, true); assert.equal(game.inning, 3); assert.equal(game.half, 1);
  assert.equal(game.outs, 3); assert.strictEqual(applyResult(game, 'homer'), game);
});

test('hits advance every existing runner by the awarded bases and keep inning totals', () => {
  const initial = newGame();
  const loaded = results(initial, 'single', 'single', 'single');
  assert.deepEqual(loaded.bases, [true, true, true]);
  const grandSlam = applyResult(loaded, 'homer');
  assert.deepEqual(grandSlam.runs, [4, 0]); assert.deepEqual(grandSlam.bases, [false, false, false]);
  assert.deepEqual(grandSlam.innings[0], [4, 0, 0]); assert.equal(grandSlam.hits[0], 4);
  assert.deepEqual(initial.runs, [0, 0]); assert.deepEqual(loaded.bases, [true, true, true]);
  const double = results(newGame(), 'single', 'double');
  assert.deepEqual(double.bases, [false, true, true]);
  const triple = applyResult(double, 'triple'); assert.equal(triple.runs[0], 2);
  assert.deepEqual(triple.bases, [false, false, true]);
});

test('walks force only connected runners and score one run with bases loaded', () => {
  const game = newGame(); game.bases = [false, false, true];
  const firstWalk = results(game, 'ball', 'ball', 'ball', 'ball');
  assert.deepEqual(firstWalk.bases, [true, false, true]); assert.equal(firstWalk.runs[0], 0);
  const loaded = results(firstWalk, 'ball', 'ball', 'ball', 'ball');
  const walkedIn = results(loaded, 'ball', 'ball', 'ball', 'ball');
  assert.equal(walkedIn.runs[0], 1); assert.equal(walkedIn.hits[0], 0); assert.equal(walkedIn.balls, 0);
});

test('outs hold runners and scores belong to the batting half', () => {
  let game = results(newGame(), 'triple', 'out');
  assert.deepEqual(game.bases, [false, false, true]);
  game = results(game, 'out', 'out', 'homer');
  assert.deepEqual(game.runs, [0, 1]); assert.deepEqual(game.innings[1], [1, 0, 0]);
});

test('first-base throws use arrival time; other bases stop the play with a safe award', () => {
  assert.equal(resolveThrow(1, BASE_SECONDS - .01), 'out');
  assert.equal(resolveThrow(1, BASE_SECONDS), 'single');
  assert.equal(resolveThrow(2, 1), 'single');
  assert.equal(resolveThrow(3, BASE_SECONDS * 2.2), 'double');
  assert.equal(resolveThrow(4, 100), 'triple');
});

test('fair territory includes the chalk and excludes the backstop and foul wings', () => {
  assert.equal(isFair(9, 3), true); assert.equal(isFair(-9, 3), true);
  assert.equal(isFair(0, 12), true); assert.equal(isFair(0, 13), false);
  assert.equal(isFair(12, 3), false); assert.equal(isFair(0, -22), true);
});

test('fixed clock bounds recovery work and preserves fractional time without negative steps', () => {
  assert.deepEqual(fixedSteps(0, 10), { steps: MAX_STEPS, remainder: 0 });
  assert.equal(fixedSteps(0, -1).steps, 0);
  const first = fixedSteps(0, STEP * .4); assert.equal(first.steps, 0);
  const second = fixedSteps(first.remainder, STEP * .8); assert.equal(second.steps, 1);
  assert.ok(Math.abs(second.remainder - STEP * .2) < 1e-10);
});

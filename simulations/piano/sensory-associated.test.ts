import assert from 'node:assert/strict';
import test from 'node:test';
import { encodePianoAssociated } from './sensory-associated.ts';
import { encodePianoV1, scoreTargets } from './sensory.ts';
import type { SensoryTarget } from './sensory.ts';
import { LEG_RANGES } from './actuator.ts';
import { LEGS } from './performance.ts';

const proprio = LEGS.map(() => ({ contact: false, busy: false, press: 0 }));
const note = (midi: number): SensoryTarget => ({ midi, beat: 1, duration: 0.44,
  writtenDuration: 0.5, velocity: 0.5, hand: 'left', noteIndex: 0 });

test('associated encoding retains pitch categories but resolves limb/octave chord collisions', () => {
  const a = [note(53), null, note(45), null, null, null];
  const b = [note(57), null, note(41), null, null, null];
  assert.deepEqual(encodePianoV1(a, 1, proprio), encodePianoV1(b, 1, proprio));
  const encodedA = encodePianoAssociated(a, 1, 96, proprio), encodedB = encodePianoAssociated(b, 1, 96, proprio);
  assert.deepEqual(encodedA.slice(0, 12), encodedB.slice(0, 12));
  assert.notDeepEqual(encodedA.slice(12, 18), encodedB.slice(12, 18));
  assert.deepEqual(Array.from(encodedA.slice(0, 12)), Array.from(encodePianoV1(a, 1, proprio).slice(0, 12)));
});

test('every physically reachable key has a distinct associated sensory code, separate from rest', () => {
  const identities = new Set<string>();
  for (const [index, leg] of LEGS.entries()) {
    const [low, high] = LEG_RANGES[leg.id];
    for (let midi = low; midi <= high; midi++) {
      const targets = LEGS.map((_, position) => position === index ? note(midi) : null);
      const input = encodePianoAssociated(targets, 1, 96, proprio);
      assert.ok(input[12 + index] > 0);
      assert.equal(input.slice(0, 12).filter(value => value > 0).length, 1);
      identities.add(Array.from(input).join(','));
    }
  }
  assert.equal(identities.size, 37);
  assert.ok(encodePianoAssociated(LEGS.map(() => null), 0, 96, proprio).every(value => value === 0));
});

test('timing changes leave pitch identity intact and use milliseconds at the requested tempo', () => {
  const targets = [note(53), null, null, null, null, null];
  const early = encodePianoAssociated(targets, 0.9, 96, proprio);
  const now = encodePianoAssociated(targets, 1, 96, proprio);
  const late = encodePianoAssociated(targets, 1.1, 96, proprio);
  assert.deepEqual(early.slice(0, 18), late.slice(0, 18));
  assert.ok(early[18] < now[18] && now[18] < late[18]);
  assert.equal(now[18], 75);
  assert.notEqual(early[18], encodePianoAssociated(targets, 0.9, 60, proprio)[18]);
  const metadataOnly = targets.map(target => target ? { ...target, noteIndex: 999, velocity: 0.9 } : null);
  assert.deepEqual(encodePianoAssociated(metadataOnly, 1, 96, proprio), now);
});

test('proprioception is per-leg and all channels stay within runtime Hz bounds', () => {
  const moving = proprio.map((limb, index) => ({ ...limb, busy: index === 1,
    contact: index === 2, press: index === 2 ? 0.5 : 0 }));
  const targets = [note(53), null, null, null, null, null];
  assert.deepEqual(Array.from(encodePianoAssociated(targets, 1, 96, moving).slice(24, 30)), [0, 40, 115, 0, 0, 0]);
  for (const bpm of [40, 84, 96, 120, 180]) for (let beat = -0.5; beat < 13; beat += 0.05) {
    const encoded = encodePianoAssociated(scoreTargets(beat, false), beat, bpm, moving);
    assert.equal(encoded.length, 32);
    assert.ok(encoded.every(rate => Number.isFinite(rate) && rate >= 0 && rate <= 150));
  }
});

test('malformed target, timing, or proprioception fails explicitly', () => {
  const targets = [note(53), null, null, null, null, null];
  assert.throws(() => encodePianoAssociated(targets, NaN, 96, proprio));
  assert.throws(() => encodePianoAssociated(targets, 0, 0, proprio));
  assert.throws(() => encodePianoAssociated(targets.slice(1), 0, 96, proprio));
  assert.throws(() => encodePianoAssociated([note(65), ...targets.slice(1)], 0, 96, proprio));
  assert.throws(() => encodePianoAssociated(targets, 0, 96, [{ ...proprio[0], press: NaN }, ...proprio.slice(1)]));
});

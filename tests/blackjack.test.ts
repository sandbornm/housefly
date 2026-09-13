import test from "node:test";
import assert from "node:assert/strict";
import { createGame, createShuffledShoe, countShoe, handValue, ranks, dealRound, step, settlement, chooseAction, needsShuffle, RANKS } from "../src/activities/blackjack.ts";
import { calculateOdds } from "../src/activities/blackjackOdds.ts";
import type { Rank } from "../src/activities/blackjack.ts";

function seeded(seed: number): () => number {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}
function close(actual: number, expected: number): void { assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`); }

test("one physical shuffled deck by default; configurable 1-8 decks", () => {
  assert.equal(createGame().shoe.length, 52);
  for (let decks = 1; decks <= 8; decks += 1) {
    const shoe = createShuffledShoe(decks, seeded(17));
    assert.equal(shoe.length, decks * 52);
    assert.equal(new Set(shoe.map(c => c.id)).size, decks * 52);
    assert.deepEqual(countShoe(shoe), [...Array(9).fill(4 * decks), 16 * decks]);
    assert.equal(shoe.filter(c => c.face === "K" && c.suit === "hearts").length, decks);
    assert.deepEqual(shoe, createShuffledShoe(decks, seeded(17)));
    assert.notDeepEqual(shoe, createShuffledShoe(decks, seeded(18)));
  }
  assert.throws(() => createShuffledShoe(1.5));
});

test("aces soften correctly, including multiple aces", () => {
  assert.deepEqual(handValue(["A", "6"]), { total: 17, soft: true, bust: false });
  assert.deepEqual(handValue(["A", "A", "9"]), { total: 21, soft: true, bust: false });
  assert.deepEqual(handValue(["A", "6", "10"]), { total: 17, soft: false, bust: false });
  assert.equal(handValue(["10", "8", "5"]).bust, true);
});

test("natural blackjack has priority over multi-card 21 and pays 3:2", () => {
  assert.equal(settlement(["A", "10"], ["10", "6", "5"]), 1.5);
  assert.equal(settlement(["10", "6", "5"], ["A", "10"]), -1);
  assert.equal(settlement(["A", "10"], ["10", "A"]), 0);
  assert.equal(settlement(["10", "8"], ["10", "8"]), 0);
  assert.equal(settlement(["10", "8", "5"], ["10", "8", "5"]), -1);
});

test("shoe persists across rounds, rejects redeal mid-hand, and resolves 21", () => {
  const game = createGame(1, seeded(5));
  dealRound(game);
  assert.equal(game.shoe.length, 49);
  assert.equal(game.dealer.length, 1);
  const first = [...game.player];
  dealRound(game);
  assert.deepEqual(game.player, first);
  step(game, "Stand");
  const left = game.shoe.length;
  dealRound(game);
  assert.equal(game.shoe.length, left - 3);
  assert.equal(game.shuffles, 1);
  const dealer = game.shoe.find(c => c.rank === "A")!;
  const six = game.shoe.find(c => c.rank === "6")!;
  game.dealer = [dealer, six];
  step(game, "Stand");
  assert.equal(game.dealer.length, 2, "dealer stands on soft 17");
});

test("thousands of seeded rounds conserve cards, never exhaust mid-hand, settle once", () => {
  for (const decks of [1, 2, 8]) {
    const random = seeded(decks);
    const game = createGame(decks, random);
    let rewards = 0;
    for (let round = 0; round < 700; round += 1) {
      const reshuffle = needsShuffle(game);
      const before = game.shoe.length;
      dealRound(game, random);
      const dealt = game.player.length + game.dealer.length;
      assert.equal(game.shoe.length + dealt, reshuffle ? decks * 52 : before);
      while (game.status === "playing") step(game, handValue(ranks(game.player)).total < 18 ? "Hit" : "Stand");
      assert.ok(game.shoe.length > 0);
      assert.ok(game.reward !== null);
      rewards += game.reward!;
      const unique = [...game.player, ...game.dealer, ...game.shoe].map(c => c.id);
      assert.equal(new Set(unique).size, unique.length);
      const left = game.shoe.length;
      step(game, "Hit");
      step(game, "Stand");
      assert.equal(game.shoe.length, left);
      close(game.bankroll, rewards);
    }
  }
});

// Independent physical-card enumeration for tiny shoes. No memoization or
// compressed dealer state: catches natural priority and probability errors.
function bruteStand(player: Rank[], dealer: Rank[], cards: Rank[]): number {
  if (handValue(player).bust || cards.length === 0 || (dealer.length >= 2 && handValue(dealer).total >= 17)) return settlement(player, dealer);
  return cards.reduce((sum, card, i) => sum + bruteStand(player, [...dealer, card], cards.filter((_, j) => i !== j)) / cards.length, 0);
}
function brute(player: Rank[], dealer: Rank, cards: Rank[]): { hit: number; stand: number; best: number } {
  const stand = bruteStand(player, [dealer], cards);
  const hit = handValue(player).total >= 21 || !cards.length ? -1 : cards.reduce((sum, card, i) => {
    const next = [...player, card];
    const value = handValue(next).bust ? -1 : brute(next, dealer, cards.filter((_, j) => i !== j)).best;
    return sum + value / cards.length;
  }, 0);
  return { stand, hit, best: Math.max(stand, hit) };
}

test("finite-shoe EV agrees with exhaustive enumeration, including dealer naturals", () => {
  const cards: Rank[] = ["A", "2", "5", "6", "10", "10"];
  const shoe = RANKS.map(rank => cards.filter(card => card === rank).length);
  for (const player of [["10", "6"], ["A", "7"], ["A", "10"], ["7", "7", "7"]] as Rank[][]) {
    for (const dealer of ["A", "6", "10"] as Rank[]) {
      const expected = brute(player, dealer, cards);
      const actual = calculateOdds(player, dealer, shoe);
      close(actual.hitEv, expected.hit);
      close(actual.standEv, expected.stand);
      close(actual.optimalEv, expected.best);
      for (const outcome of [actual.hit, actual.stand]) {
        close(outcome.win + outcome.push + outcome.lose, 1);
        close(outcome.ev, outcome.win * (player.length === 2 && handValue(player).total === 21 && outcome === actual.stand ? 1.5 : 1) - outcome.lose);
      }
      close(actual.win, actual[actual.recommendation === "Hit" ? "hit" : "stand"].win);
    }
  }
});

test("odds use the observed composition and leave it unchanged", () => {
  const shoe = [4, 4, 4, 4, 4, 3, 4, 4, 4, 14];
  const before = [...shoe];
  const actual = calculateOdds(["10", "6"], "10", shoe);
  assert.deepEqual(shoe, before);
  close(actual.bustProbability, (3 + 4 + 4 + 4 + 14) / 49);
  assert.equal(actual.recommendation, "Hit");
  close(actual.hitEv, actual.hit.win - actual.hit.lose);
  assert.throws(() => calculateOdds(["10", "6"], "10", [-1, ...shoe.slice(1)]));
});

test("noise only changes the sampled choice; zero noise follows the oracle", () => {
  assert.deepEqual(chooseAction(0.1, 0.2, 0, () => 0), { action: "Stand", jitter: -0, margin: -0.1 });
  assert.equal(chooseAction(0.2, 0.1, 0).action, "Hit");
  assert.equal(chooseAction(0.1, 0.1, 0).action, "Stand");
  assert.equal(chooseAction(0.1, 0.11, 1, () => 0.9).action, "Hit");
});

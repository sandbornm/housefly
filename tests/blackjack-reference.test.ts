import test from "node:test";
import assert from "node:assert/strict";
import { calculateOdds } from "../src/activities/blackjackOdds.ts";
import { estimateRound } from "../src/activities/blackjackRollout.ts";
import { chooseFromActions, countShoe, createGame, dealRound, legalActions, ranks, step } from "../src/activities/blackjack.ts";
import type { Action, Rank } from "../src/activities/blackjack.ts";
import { bookAction, freshCounts, observedRound, referenceEV, referenceFrozenPolicy, seeded, singleRound } from "../scripts/audit_blackjack.ts";

function close(actual: number, expected: number, tolerance = 1e-10) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}, tolerance ${tolerance}`);
}

test("published single-deck S17 EVs match without peek conditioning for upcards 2-9", () => {
  // Michael Shackleford, Appendix 9, 1ds17r4, non-pair rows.
  // Resplitting does not affect these unsplit H/S/D values. Six decimal source precision.
  const fixtures: [Rank[], Rank, number[]][] = [
    [["5", "6"], "6", [-0.138999, 0.380696, 0.761392]],
    [["6", "2"], "5", [-0.103819, 0.130630, 0.130583]],
    [["A", "7"], "2", [0.135802, 0.065248, 0.127578]],
    [["A", "6"], "2", [-0.131767, 0.007098, 0.013321]],
  ];
  for (const [cards, up, expected] of fixtures) {
    const shoe = freshCounts(cards, up);
    const actual = calculateOdds(cards, up, shoe, { allowDouble: true });
    const independent = referenceEV(singleRound(cards), up, shoe, ["Stand", "Hit", "Double"]);
    for (const [i, action] of (["Stand", "Hit", "Double"] as Action[]).entries()) {
      close(actual.values[action]!, expected[i], 0.00000051);
      close(independent.values[action]!, expected[i], 0.00000051);
    }
  }
});

test("6+2 against 5 is Hit by composition, despite the hard-8 Double chart cell", () => {
  const player: Rank[] = ["6", "2"];
  const odds = calculateOdds(player, "5", freshCounts(player, "5"), { allowDouble: true });
  assert.equal(bookAction(player, "5", ["Stand", "Hit", "Double"]), "Double");
  assert.equal(odds.recommendation, "Hit");
  close(odds.hitEv - odds.doubleEv!, 0.00004692533892472);
});

test("ENHC dealer blackjack costs both doubled units; do not use conditional peek EVs directly", () => {
  // Appendix 9: 5,6 vs 10 has conditional Stand=-.549500, Double=.170737.
  // For these fixed actions exchangeability permits unconditioning with p(BJ)=4/49.
  // This conversion is NOT generally valid for adaptive Hit or Split policies.
  const player: Rank[] = ["5", "6"];
  const odds = calculateOdds(player, "10", freshCounts(player, "10"), { allowDouble: true });
  close(odds.standEv, 45 / 49 * -0.549500 - 4 / 49, 0.00000051);
  close(odds.doubleEv!, 45 / 49 * 0.170737 - 2 * 4 / 49, 0.00000051);
  assert.equal(odds.recommendation, "Hit");
});

test("single-deck European chart-sensitive goldens include soft hands and pairs", () => {
  // Wizard strategy calculator: one deck, S17, DAS, no surrender, European.
  const fixtures: [Rank[], Rank, Action][] = [
    [["A", "8"], "6", "Double"], [["A", "7"], "A", "Stand"],
    [["5", "6"], "10", "Hit"], [["5", "6"], "A", "Hit"],
    [["8", "8"], "10", "Hit"], [["7", "7"], "10", "Stand"],
    [["A", "A"], "A", "Hit"],
  ];
  for (const [player, up, expected] of fixtures) {
    const pair = player[0] === player[1];
    const allowed: Action[] = pair ? ["Stand", "Hit", "Double", "Split"] : ["Stand", "Hit", "Double"];
    assert.equal(bookAction(player, up, allowed), expected);
    const odds = calculateOdds(player, up, freshCounts(player, up), { allowDouble: true, allowSplit: pair });
    assert.equal(odds.recommendation, expected, `${player} vs ${up}`);
    assert.equal(chooseFromActions(odds.values, 0, seeded(19)).action, expected);
  }
  assert.equal(bookAction(["A", "2", "5"], "4", ["Hit", "Stand"]), "Stand", "double/stand fallback after a hit");
  assert.equal(bookAction(["2", "3", "4"], "6", ["Hit", "Stand"]), "Hit", "double/hit fallback after a hit");
  assert.notEqual(bookAction(["8", "8"], "6", ["Hit", "Stand", "Double"]), "Split", "no resplit at two-hand cap");
});

test("independent round enumeration enforces one card to split aces and all-stakes dealer BJ", () => {
  const aces = singleRound(["A", "A"]);
  const tens = [0, 0, 0, 0, 0, 0, 0, 0, 0, 8];
  close(referenceEV(aces, "6", tens, ["Split"]).values.Split!, 2);
  close(estimateRound(aces, "6", tens, "Split", 100).ev, 2);
  const round = { hands: [
    { cards: ["8", "3", "10"] as Rank[], bet: 2, status: "stood", fromSplit: true, splitAces: false },
    { cards: ["8", "2"] as Rank[], bet: 1, status: "playing", fromSplit: true, splitAces: false },
  ], activeHand: 1 };
  const exact = referenceEV(round, "A", tens, ["Stand", "Double"]);
  close(exact.values.Stand!, -3);
  close(exact.values.Double!, -4);
  close(estimateRound(round, "A", tens, "Double", 100).ev, -4);
});

test("seed 5 reproduces the chart-different stand on hard 15 without future-card access", () => {
  const random = seeded(5), policyRandom = seeded(5 ^ 0xcafebabe);
  const game = createGame(1, random);
  let id = 0;
  while (id < 34) {
    if (game.status !== "playing") dealRound(game, random);
    if (game.status !== "playing") continue;
    const allowed = legalActions(game), player = ranks(game.player), up = game.dealer[0].rank;
    const shoe = countShoe(game.shoe);
    const options = { allowDouble: allowed.includes("Double"), allowSplit: allowed.includes("Split"), fromSplit: game.hands[game.activeHand].fromSplit, round: observedRound(game) };
    const odds = calculateOdds(player, up, shoe, options);
    const choice = chooseFromActions(odds.values, 0, policyRandom);
    id++;
    if (id === 34) {
      assert.equal(game.round, 25);
      assert.deepEqual(player, ["10", "3", "2"]);
      assert.equal(up, "7");
      assert.equal(bookAction(player, up, allowed), "Hit");
      assert.equal(choice.action, "Stand");
      const independent = referenceEV(options.round, up, shoe, allowed);
      close(independent.values.Stand!, -0.2902258150534012);
      close(independent.values.Hit!, -0.5424731590248832);
      game.shoe.reverse();
      const reordered = calculateOdds(player, up, countShoe(game.shoe), options);
      assert.deepEqual(reordered.values, odds.values);
    }
    step(game, choice.action);
  }
});

const missedSplitPlayer: Rank[] = ["3", "3"];
const missedSplitShoe = [2, 3, 1, 0, 2, 4, 2, 2, 2, 9];

test("seed 17 decision 30: independent optimal split exceeds Hit at the two-hand cap", () => {
  const round = singleRound(missedSplitPlayer);
  const exact = referenceEV(round, "9", missedSplitShoe, ["Hit", "Split"]);
  close(exact.values.Hit!, -0.3528329693726337);
  close(exact.values.Split!, -0.34062342696141107);
  const frozen = referenceEV(round, "9", missedSplitShoe, ["Split"], 2500, referenceFrozenPolicy("9", missedSplitShoe));
  assert.ok(frozen.values.Split! <= exact.values.Split!);
  assert.ok(frozen.values.Split! > exact.values.Hit!);
});

test("known audit finding: 16,000-rollout policy misses the seed 17 decision 30 split", {
  todo: "P2 audit finding: sampling can reverse a close Split/Hit ordering; production changes are outside this audit",
}, () => {
  const odds = calculateOdds(missedSplitPlayer, "9", missedSplitShoe, { allowDouble: true, allowSplit: true });
  assert.equal(odds.recommendation, "Split");
});

import { addRank, handValue, isNatural, RANKS, totalCards } from "./blackjack.ts";
import type { HandValue, Rank, Shoe, Action } from "./blackjack.ts";
import { estimateRound } from "./blackjackRollout.ts";
import type { RoundObservation } from "./blackjackRollout.ts";

export interface Outcome { ev: number; win: number; push: number; lose: number }
export interface NextCard { rank: Rank; probability: number; total: number; bust: boolean }
export interface Odds {
  hitEv: number;
  standEv: number;
  doubleEv: number | null;
  splitEv: number | null;
  values: Partial<Record<Action, number>>;
  errors: Partial<Record<Action, number>>;
  method: "exact" | "mixed" | "sampled";
  optimalEv: number;
  recommendation: Action;
  win: number;
  push: number;
  lose: number;
  hit: Outcome;
  stand: Outcome;
  bustProbability: number;
  nextCards: NextCard[];
  states: number;
  elapsedMs: number;
}

const loss = (): Outcome => ({ ev: -1, win: 0, push: 0, lose: 1 });

// European no-hole-card, S17, natural 3:2, Hit/Stand only. The observation
// contains unseen rank counts, never the shuffled order or a future card.
export function calculateOdds(playerCards: Rank[], dealerUpcard: Rank, inputShoe: Shoe, options: { allowDouble?: boolean; allowSplit?: boolean; fromSplit?: boolean; round?: RoundObservation } = {}): Odds {
  if (playerCards.length < 2 || !playerCards.every(card => RANKS.includes(card)) || !RANKS.includes(dealerUpcard)
      || inputShoe.length !== 10 || inputShoe.some((n, i) => !Number.isInteger(n) || n < 0 || n > (i === 9 ? 128 : 32))) {
    throw new Error("Invalid blackjack observation");
  }
  const started = performance.now();
  const shoe = [...inputShoe];
  // Mixed-radix composition keys remain exact integers through eight decks.
  const factors: number[] = [];
  let factor = 1;
  for (const count of shoe) { factors.push(factor); factor *= count + 1; }
  const initialCode = shoe.reduce((sum, count, i) => sum + count * factors[i], 0);
  const dealerMemo = Array.from({ length: 128 }, () => new Map<number, Float64Array>());
  const playerMemo = Array.from({ length: 64 }, () => new Map<number, Outcome>());
  const dealerStart = handValue([dealerUpcard]);
  const bustIndex = 22;
  const naturalIndex = 23;
  const terminalDistributions = Array.from({ length: 24 }, (_, outcome) => {
    const dist = new Float64Array(24);
    dist[outcome] = 1;
    return dist;
  });

  function dealerDistribution(hand: HandValue, code: number, left: number, first = false): Float64Array {
    if (hand.bust || (!first && hand.total >= 17) || left === 0) {
      return terminalDistributions[hand.bust ? bustIndex : hand.total];
    }
    const memo = dealerMemo[hand.total * 2 + Number(hand.soft) + Number(first) * 64];
    const cached = memo.get(code);
    if (cached) return cached;
    const dist = new Float64Array(24);
    for (let i = 0; i < 10; i += 1) {
      const count = shoe[i];
      if (!count) continue;
      const next = addRank(hand, RANKS[i]);
      const p = count / left;
      if (first && next.total === 21) { dist[naturalIndex] += p; continue; }
      shoe[i] -= 1;
      const branch = dealerDistribution(next, code - factors[i], left - 1);
      shoe[i] += 1;
      for (let j = 0; j < 24; j += 1) dist[j] += p * branch[j];
    }
    memo.set(code, dist);
    return dist;
  }

  function stand(hand: HandValue, code: number, left: number, natural = false): Outcome {
    if (hand.bust) return loss();
    const dist = dealerDistribution(dealerStart, code, left, true);
    const result: Outcome = { ev: 0, win: 0, push: 0, lose: 0 };
    for (let outcome = 0; outcome < 24; outcome += 1) {
      const reward = outcome === naturalIndex ? (natural ? 0 : -1) : natural ? 1.5
        : outcome === bustIndex ? 1 : Math.sign(hand.total - outcome);
      result.ev += reward * dist[outcome];
      result[reward > 0 ? "win" : reward < 0 ? "lose" : "push"] += dist[outcome];
    }
    return result;
  }

  function hit(hand: HandValue, code: number, left: number): Outcome {
    if (hand.total >= 21 || left === 0) return loss();
    const result: Outcome = { ev: 0, win: 0, push: 0, lose: 0 };
    for (let i = 0; i < 10; i += 1) {
      const count = shoe[i];
      if (!count) continue;
      shoe[i] -= 1;
      const next = addRank(hand, RANKS[i]);
      const branch = next.bust ? loss() : optimal(next, code - factors[i], left - 1);
      shoe[i] += 1;
      const p = count / left;
      result.ev += p * branch.ev;
      result.win += p * branch.win;
      result.push += p * branch.push;
      result.lose += p * branch.lose;
    }
    return result;
  }

  function optimal(hand: HandValue, code: number, left: number): Outcome {
    const memo = playerMemo[hand.total * 2 + Number(hand.soft)];
    const cached = memo.get(code);
    if (cached) return cached;
    const s = stand(hand, code, left);
    let best = s;
    if (hand.total < 21 && left) { const h = hit(hand, code, left); if (h.ev > s.ev) best = h; }
    memo.set(code, best);
    return best;
  }

  const hand = handValue(playerCards);
  const left = totalCards(shoe);
  const s = stand(hand, initialCode, left, !options.fromSplit && isNatural(playerCards));
  const h = hit(hand, initialCode, left);
  const outcomes: Partial<Record<Action, Outcome>> = { Stand: s, Hit: h };
  const errors: Partial<Record<Action, number>> = {};
  let method: Odds["method"] = "exact";
  if (options.allowDouble && playerCards.length === 2 && hand.total < 21) {
    const d: Outcome = { ev: 0, win: 0, push: 0, lose: 0 };
    for (let i = 0; i < 10; i++) {
      const count = shoe[i];
      if (!count) continue;
      shoe[i]--;
      const branch = stand(addRank(hand, RANKS[i]), initialCode - factors[i], left - 1);
      shoe[i]++;
      d.ev += count / left * branch.ev * 2;
      d.win += count / left * branch.win; d.push += count / left * branch.push; d.lose += count / left * branch.lose;
    }
    outcomes.Double = d;
  }
  const round = options.round ?? { hands: [{ cards: playerCards, bet: 1, status: "playing", fromSplit: false, splitAces: false }], activeHand: 0 };
  if (options.allowSplit && playerCards.length === 2 && playerCards[0] === playerCards[1] && round.hands.length === 1) {
    const split = estimateRound(round, dealerUpcard, inputShoe, "Split");
    outcomes.Split = split; errors.Split = split.error95; method = "mixed";
  }
  if (round.hands.length > 1) {
    method = "sampled";
    for (const action of Object.keys(outcomes) as Action[]) {
      const sampled = estimateRound(round, dealerUpcard, inputShoe, action);
      outcomes[action] = sampled; errors[action] = sampled.error95;
    }
  }
  const values = Object.fromEntries(Object.entries(outcomes).map(([action, result]) => [action, result!.ev]));
  const recommendation = (Object.keys(values) as Action[]).reduce((best, action) => values[action] > values[best] ? action : best, "Stand");
  const best = outcomes[recommendation]!;
  const nextCards = RANKS.map((rank, i) => {
    const next = addRank(hand, rank);
    return { rank, probability: left ? shoe[i] / left : 0, total: next.total, bust: next.bust };
  }).filter(card => card.probability > 0);
  return { hitEv: values.Hit, standEv: values.Stand, doubleEv: values.Double ?? null, splitEv: values.Split ?? null,
    values, errors, method, optimalEv: best.ev, recommendation,
    win: best.win, push: best.push, lose: best.lose, hit: outcomes.Hit!, stand: outcomes.Stand!,
    bustProbability: nextCards.reduce((sum, card) => sum + (card.bust ? card.probability : 0), 0),
    nextCards, states: [...dealerMemo, ...playerMemo].reduce((sum, memo) => sum + memo.size, 0), elapsedMs: performance.now() - started };
}

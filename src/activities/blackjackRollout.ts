import { addRank, handValue, RANKS, settlement, totalCards } from "./blackjack.ts";
import type { Action, HandValue, Rank, Shoe } from "./blackjack.ts";
import type { Outcome } from "./blackjackOdds.ts";

export interface ObservedHand { cards: Rank[]; bet: number; status: string; fromSplit: boolean; splitAces: boolean }
export interface RoundObservation { hands: ObservedHand[]; activeHand: number }
export interface Estimate extends Outcome { samples: number; error95: number }

// A frozen-composition continuation policy keeps rollouts bounded. Physical
// draws below remain without replacement and both hands share one dealer.
function continuation(shoe: Shoe, up: Rank): (cards: Rank[], double: boolean) => Action {
  const total = totalCards(shoe);
  const probabilities = shoe.map(count => count / total);
  const memo = new Map<number, number[]>();
  function dealer(hand: HandValue, first: boolean): number[] {
    const key = hand.total * 4 + Number(hand.soft) * 2 + Number(first);
    const cached = memo.get(key);
    if (cached) return cached;
    const result = Array<number>(24).fill(0);
    if (hand.bust || (!first && hand.total >= 17)) result[hand.bust ? 22 : hand.total] = 1;
    else for (let i = 0; i < 10; i++) {
      if (!probabilities[i]) continue;
      const next = addRank(hand, RANKS[i]);
      if (first && next.total === 21) result[23] += probabilities[i];
      else dealer(next, false).forEach((p, j) => { result[j] += probabilities[i] * p; });
    }
    memo.set(key, result);
    return result;
  }
  const dist = dealer(handValue([up]), true);
  const bestMemo = new Map<number, { ev: number; action: Action }>();
  function stand(hand: HandValue): number {
    if (hand.bust) return -1;
    return dist.reduce((sum, p, outcome) => sum + p * (outcome === 23 ? -1 : outcome === 22 ? 1 : Math.sign(hand.total - outcome)), 0);
  }
  function best(hand: HandValue, canDouble: boolean): { ev: number; action: Action } {
    const key = hand.total * 4 + Number(hand.soft) * 2 + Number(canDouble);
    const cached = bestMemo.get(key);
    if (cached) return cached;
    let result: { ev: number; action: Action } = { ev: stand(hand), action: "Stand" };
    if (hand.total < 21) {
      let hit = 0, double = 0;
      for (let i = 0; i < 10; i++) {
        if (!probabilities[i]) continue;
        const next = addRank(hand, RANKS[i]);
        hit += probabilities[i] * (next.bust ? -1 : best(next, false).ev);
        double += probabilities[i] * stand(next) * 2;
      }
      if (hit > result.ev) result = { ev: hit, action: "Hit" };
      if (canDouble && double > result.ev) result = { ev: double, action: "Double" };
    }
    bestMemo.set(key, result);
    return result;
  }
  return (cards, double) => best(handValue(cards), double).action;
}

export function estimateRound(observation: RoundObservation, up: Rank, shoe: Shoe, action: Action, samples = 16000): Estimate {
  const policy = continuation(shoe, up);
  let seed = 2166136261;
  for (const c of [...shoe, ...observation.hands.flatMap(h => h.cards.map(c => RANKS.indexOf(c))), RANKS.indexOf(up)]) seed = Math.imul(seed ^ c, 16777619) >>> 0;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  let sum = 0, squares = 0, wins = 0, pushes = 0;
  const leftInitial = totalCards(shoe);
  for (let sample = 0; sample < samples; sample++) {
    const remaining = [...shoe];
    let left = leftInitial;
    function draw(): Rank | null {
      if (!left) return null;
      let ticket = random() * left;
      for (let i = 0; i < 10; i++) {
        ticket -= remaining[i];
        if (ticket < 0) { remaining[i]--; left--; return RANKS[i]; }
      }
      throw new Error("Invalid sampled shoe");
    }
    const hands = observation.hands.map(hand => ({ ...hand, cards: [...hand.cards] }));
    let firstAction: Action | null = action;
    if (action === "Split") {
      const pair = hands[0].cards;
      hands.splice(0, 1, ...pair.map(card => ({ cards: [card], bet: 1, status: "waiting", fromSplit: true, splitAces: card === "A" })));
      firstAction = null;
    }
    for (let h = observation.activeHand; h < hands.length; h++) {
      const hand = hands[h];
      if (hand.cards.length === 1) { const card = draw(); if (card) hand.cards.push(card); }
      if (hand.splitAces) continue;
      while (handValue(hand.cards).total < 21 && left) {
        const move = firstAction ?? policy(hand.cards, hand.cards.length === 2);
        firstAction = null;
        if (move === "Stand") break;
        if (move === "Double") hand.bet *= 2;
        const card = draw();
        if (card) hand.cards.push(card);
        if (move === "Double") break;
      }
      firstAction = null;
    }
    const dealer: Rank[] = [up];
    if (hands.some(hand => !handValue(hand.cards).bust)) {
      while ((dealer.length < 2 || handValue(dealer).total < 17) && left) { const card = draw(); if (card) dealer.push(card); }
    }
    const reward = hands.reduce((sum, hand) => sum + hand.bet * settlement(hand.cards, dealer, hand.fromSplit), 0);
    sum += reward; squares += reward * reward;
    if (reward > 0) wins++;
    if (reward === 0) pushes++;
  }
  const ev = sum / samples;
  const variance = Math.max(0, (squares - samples * ev * ev) / (samples - 1));
  return { ev, win: wins / samples, push: pushes / samples, lose: (samples - wins - pushes) / samples,
    samples, error95: 1.96 * Math.sqrt(variance / samples) };
}

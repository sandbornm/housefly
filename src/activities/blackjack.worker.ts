import { calculateOdds } from "./blackjackOdds.ts";
import type { Rank, Shoe } from "./blackjack.ts";
import type { RoundObservation } from "./blackjackRollout.ts";

self.onmessage = (event: MessageEvent<{ id: number; player: Rank[]; dealer: Rank; shoe: Shoe; options?: { allowDouble: boolean; allowSplit: boolean; fromSplit: boolean; round: RoundObservation } }>) => {
  const { id, player, dealer, shoe, options } = event.data;
  try { self.postMessage({ id, odds: calculateOdds(player, dealer, shoe, options) }); }
  catch (error) { self.postMessage({ id, error: error instanceof Error ? error.message : "Odds calculation failed" }); }
};

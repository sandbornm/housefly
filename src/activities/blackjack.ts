export const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10"] as const;
export type Rank = (typeof RANKS)[number];
export type Action = "Hit" | "Stand" | "Double" | "Split";
export type Shoe = number[];
export interface Card {
  id: number;
  rank: Rank;
  face: string;
  suit: "clubs" | "diamonds" | "hearts" | "spades";
}
export interface HandValue { total: number; soft: boolean; bust: boolean }
export interface PlayerHand {
  cards: Card[];
  bet: number;
  status: "playing" | "waiting" | "stood" | "bust";
  fromSplit: boolean;
  splitAces: boolean;
  reward: number | null;
}
export interface GameState {
  status: "ready" | "playing" | "resolved";
  decks: number;
  shoe: Card[];
  readonly player: Card[];
  hands: PlayerHand[];
  activeHand: number;
  dealer: Card[];
  reward: number | null;
  bankroll: number;
  round: number;
  shuffles: number;
  message: string;
  result: string;
}

export function addRank(hand: HandValue, rank: Rank): HandValue {
  let total = hand.total + (rank === "A" ? 11 : Number(rank));
  let aces = Number(hand.soft) + Number(rank === "A");
  while (total > 21 && aces > 0) { total -= 10; aces -= 1; }
  return { total, soft: aces > 0, bust: total > 21 };
}

export function handValue(cards: readonly Rank[]): HandValue {
  return cards.reduce(addRank, { total: 0, soft: false, bust: false });
}

export function ranks(cards: readonly Card[]): Rank[] { return cards.map(card => card.rank); }
export function isNatural(cards: readonly Rank[]): boolean { return cards.length === 2 && handValue(cards).total === 21; }
export function totalCards(shoe: readonly number[]): number { return shoe.reduce((a, b) => a + b, 0); }
export function countShoe(cards: readonly Card[]): Shoe {
  const counts = Array<number>(10).fill(0);
  for (const card of cards) counts[RANKS.indexOf(card.rank)] += 1;
  return counts;
}

export function createShuffledShoe(decks = 1, random: () => number = Math.random): Card[] {
  if (!Number.isInteger(decks) || decks < 1 || decks > 8) throw new Error("Expected 1 to 8 decks");
  const cards: Card[] = [];
  const suits = ["clubs", "diamonds", "hearts", "spades"] as const;
  for (let deck = 0; deck < decks; deck += 1) {
    for (const suit of suits) {
      for (const face of [...RANKS, "J", "Q", "K"]) {
        cards.push({ id: cards.length, suit, face, rank: ["J", "Q", "K"].includes(face) ? "10" : face as Rank });
      }
    }
  }
  for (let i = cards.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

export function createGame(decks = 1, random: () => number = Math.random): GameState {
  return { status: "ready", decks, shoe: createShuffledShoe(decks, random), hands: [newHand([])], activeHand: 0,
    get player(): Card[] { return this.hands[this.activeHand].cards; }, dealer: [],
    reward: null, bankroll: 0, round: 0, shuffles: 1, message: `${decks} shuffled deck${decks === 1 ? "" : "s"}.`, result: "" };
}

function newHand(cards: Card[], fromSplit = false, splitAces = false): PlayerHand {
  return { cards, bet: 1, status: "playing", fromSplit, splitAces, reward: null };
}

export function legalActions(game: GameState): Action[] {
  if (game.status !== "playing") return [];
  const hand = game.hands[game.activeHand];
  if (hand.status !== "playing") return [];
  const actions: Action[] = ["Stand", "Hit"];
  if (hand.cards.length === 2 && !hand.splitAces) actions.push("Double");
  if (game.hands.length === 1 && hand.cards.length === 2 && hand.cards[0].rank === hand.cards[1].rank) actions.push("Split");
  return actions;
}

function draw(game: GameState): Card {
  const card = game.shoe.pop();
  if (!card) throw new Error("Shoe exhausted during a hand");
  return card;
}

export function needsShuffle(game: GameState): boolean {
  // A reserve above three hands' maximum totals prevents mid-hand exhaustion,
  // including shoes unusually rich in aces. Aces count as one for this bound.
  const reserve = game.shoe.reduce((sum, card) => sum + (card.rank === "A" ? 1 : Number(card.rank)), 0);
  return game.shoe.length <= game.decks * 52 * 0.25 || reserve <= 93;
}

export function dealRound(game: GameState, random: () => number = Math.random): void {
  if (game.status === "playing") return;
  const shuffled = needsShuffle(game);
  if (shuffled) { game.shoe = createShuffledShoe(game.decks, random); game.shuffles += 1; }
  game.hands = [newHand([draw(game)])];
  game.activeHand = 0;
  game.dealer = [draw(game)];
  game.player.push(draw(game));
  game.status = "playing";
  game.round += 1;
  game.reward = null;
  game.result = "";
  game.message = `${shuffled ? "Fresh shuffle. " : ""}Hand ${game.round}. Dealer's second card is drawn after the fly stands.`;
  if (isNatural(ranks(game.player))) { game.hands[0].status = "stood"; settle(game); }
}

export function settle(game: GameState): void {
  if (game.status !== "playing") return;
  const natural = game.hands.length === 1 && !game.hands[0].fromSplit && isNatural(ranks(game.player));
  if (game.hands.some(hand => !handValue(ranks(hand.cards)).bust)) {
    while (game.dealer.length < 2 || (!natural && handValue(ranks(game.dealer)).total < 17)) {
      game.dealer.push(draw(game));
    }
  }
  for (const hand of game.hands) {
    hand.reward = hand.bet * settlement(ranks(hand.cards), ranks(game.dealer), hand.fromSplit);
  }
  const reward = game.hands.reduce((sum, hand) => sum + hand.reward!, 0);
  game.reward = reward;
  game.bankroll += reward;
  game.status = "resolved";
  game.result = reward === 1.5 ? "Blackjack!" : reward > 0 ? "Fly wins" : reward < 0 ? "Dealer wins" : "Push";
  game.message = `${game.result}. ${reward > 0 ? "+" : ""}${reward} units; session ${game.bankroll >= 0 ? "+" : ""}${game.bankroll}.`;
}

export function settlement(playerCards: readonly Rank[], dealerCards: readonly Rank[], fromSplit = false): number {
  const player = handValue(playerCards);
  const dealer = handValue(dealerCards);
  if (player.bust) return -1;
  if (isNatural(dealerCards)) return !fromSplit && isNatural(playerCards) ? 0 : -1;
  if (!fromSplit && isNatural(playerCards)) return 1.5;
  if (dealer.bust) return 1;
  return Math.sign(player.total - dealer.total);
}

export function step(game: GameState, action: Action): void {
  if (!legalActions(game).includes(action)) return;
  const index = game.activeHand;
  const hand = game.hands[index];
  if (action === "Split") {
    const aces = hand.cards[0].rank === "A";
    game.hands = [newHand([hand.cards[0], draw(game)], true, aces), newHand([hand.cards[1]], true, aces)];
    game.hands[1].status = "waiting";
    if (aces || handValue(ranks(game.hands[0].cards)).total === 21) game.hands[0].status = "stood";
  } else if (action === "Stand") hand.status = "stood";
  else {
    if (action === "Double") hand.bet = 2;
    hand.cards.push(draw(game));
    const value = handValue(ranks(hand.cards));
    if (value.bust) hand.status = "bust";
    else if (action === "Double" || value.total === 21) hand.status = "stood";
  }
  game.message = `${action} / hand ${index + 1}.`;
  advance(game);
}

function advance(game: GameState): void {
  while (game.hands[game.activeHand].status !== "playing") {
    if (game.activeHand === game.hands.length - 1) { settle(game); return; }
    game.activeHand += 1;
    const hand = game.hands[game.activeHand];
    hand.cards.push(draw(game));
    hand.status = hand.splitAces || handValue(ranks(hand.cards)).total === 21 ? "stood" : "playing";
  }
  game.message += ` Hand ${game.activeHand + 1}: ${handValue(ranks(game.player)).total}, stake ${game.hands[game.activeHand].bet}.`;
}

export interface ActionScore { action: Action; ev: number; jitter: number; score: number }
export function chooseFromActions(values: Partial<Record<Action, number>>, temperature: number, random: () => number = Math.random): { action: Action; scores: ActionScore[]; margin: number } {
  const scores = Object.entries(values).map(([action, ev]) => {
    const jitter = (random() - 0.5) * Math.max(0, Math.min(1, temperature)) * 0.22;
    return { action: action as Action, ev, jitter, score: ev + jitter };
  }).sort((a, b) => b.score - a.score);
  if (!scores.length) throw new Error("No legal actions");
  return { action: scores[0].action, scores, margin: scores[0].score - (scores[1]?.score ?? scores[0].score) };
}

export function chooseAction(hitEv: number, standEv: number, temperature: number, random: () => number = Math.random): { action: Action; jitter: number; margin: number } {
  const jitter = (random() - 0.5) * Math.min(1, Math.max(0, temperature)) * 0.22;
  const margin = hitEv - standEv + jitter;
  return { action: margin > 0 ? "Hit" : "Stand", jitter, margin };
}

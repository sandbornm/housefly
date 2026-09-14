import { countShoe, handValue, legalActions, ranks, RANKS } from "./blackjack.ts";
import type { Action, GameState, Rank } from "./blackjack.ts";
import { NeuralReadout } from "../neural/policy.ts";
import type { ReadoutDecision } from "../neural/policy.ts";
import type { NeuralFrame } from "../neural/runtime.ts";
import { NeuralTaskController, copyNeuralFrame } from "../neural/task.ts";
import type { TaskNeuralRuntime } from "../neural/task.ts";

export const BLACKJACK_ACTIONS: readonly Action[] = ["Hit", "Stand", "Double", "Split"];
export const BLACKJACK_ENCODER = "blackjack-observation-32-v1";
export const BLACKJACK_STORAGE_KEY = "housefly.blackjack.readout.v1";

export interface BlackjackObservation {
  total: number;
  soft: boolean;
  pair: boolean;
  double: boolean;
  split: boolean;
  dealer: Rank;
  remaining: number[];
}

export function observeBlackjack(game: GameState): BlackjackObservation {
  const hand = game.hands[game.activeHand];
  const value = handValue(ranks(hand.cards));
  const allowed = legalActions(game);
  return {
    total: value.total, soft: value.soft,
    pair: hand.cards.length === 2 && hand.cards[0].rank === hand.cards[1].rank,
    double: allowed.includes("Double"), split: allowed.includes("Split"),
    dealer: game.dealer[0].rank,
    // No hole card exists in these rules. Only the unknown rank histogram is observed.
    remaining: countShoe(game.shoe),
  };
}

export function encodeBlackjack(observation: BlackjackObservation): Float32Array {
  if (!Number.isFinite(observation.total) || observation.total < 0 || !RANKS.includes(observation.dealer)
    || observation.remaining.length !== 10 || observation.remaining.some(n => !Number.isInteger(n) || n < 0)) {
    throw new Error("Invalid blackjack observation");
  }
  const input = new Float32Array(32);
  [4, 7, 10, 13, 16, 18, 20, 22].forEach((center, i) => {
    input[i] = 120 * Math.exp(-0.5 * ((observation.total-center)/2.5)**2);
  });
  input[8+RANKS.indexOf(observation.dealer)] = 120;
  [observation.soft, observation.pair, observation.double, observation.split].forEach((flag,i) => { input[18+i] = flag ? 120 : 0; });
  const remaining = observation.remaining.reduce((a,b) => a+b,0);
  observation.remaining.forEach((count,i) => { input[22+i] = remaining ? 150*count/remaining : 0; });
  return input;
}

export function copyBlackjackFrame(frame: NeuralFrame): NeuralFrame {
  return copyNeuralFrame(frame);
}

export type BlackjackNeuralRuntime = TaskNeuralRuntime;
export interface BlackjackNeuralChoice {
  frame: NeuralFrame;
  decision: ReadoutDecision;
  scores: Float32Array;
}

export class BlackjackNeuralController {
  readonly runtime: BlackjackNeuralRuntime;
  readonly readout: NeuralReadout;
  private task: NeuralTaskController<GameState, Action>;
  private round = -1;
  private eligible = false;
  private settled = false;
  private traces: ReadoutDecision[] = [];
  private issued = new WeakSet<ReadoutDecision>();

  constructor(runtime: BlackjackNeuralRuntime, readout: NeuralReadout) {
    this.runtime = runtime; this.readout = readout;
    this.task = new NeuralTaskController(runtime, readout, {
      id: "blackjack", encoderVersion: BLACKJACK_ENCODER, actions: BLACKJACK_ACTIONS,
      encode: game => encodeBlackjack(observeBlackjack(game)),
      legalActions: game => BLACKJACK_ACTIONS.filter(action => legalActions(game).includes(action)),
    });
  }

  beginRound(round: number, eligible: boolean): void {
    if (round === this.round) return;
    this.round = round; this.eligible = eligible; this.settled = false; this.traces = [];
  }

  discard(): void { this.eligible = false; this.traces = []; }

  async decide(game: GameState, onFrame: (frame: NeuralFrame) => void, valid: () => boolean): Promise<BlackjackNeuralChoice | null> {
    if (game.status !== "playing" || this.runtime.silenced || !valid()) return null;
    // Fixed simulated integration time; playback speed only changes the presentation.
    const choice = await this.task.decide(game, { durationMs: 120, stepMs: 20, onFrame, valid, sample: true });
    if (!choice) return null;
    this.issued.add(choice.decision);
    return choice;
  }

  recordExecuted(round: number, decision: ReadoutDecision): void {
    if (round !== this.round || !this.eligible || this.settled) return;
    if (!this.issued.has(decision) || this.traces.includes(decision)) throw new Error("Unissued or duplicate blackjack neural action");
    this.traces.push(decision);
  }

  settle(game: GameState, learning: boolean): boolean {
    if (game.round !== this.round || game.status !== "resolved" || this.settled) return false;
    this.settled = true;
    const traces = this.traces; this.traces = [];
    if (!learning || !this.eligible || !traces.length) return false;
    this.readout.reinforce(traces,game.reward!);
    return true;
  }
}

type ReadoutStorage = Pick<Storage,"getItem" | "setItem" | "removeItem">;
export function restoreBlackjackReadout(readout: NeuralReadout, storage: ReadoutStorage | null): "restored" | "cold" | "unavailable" | "incompatible" {
  try {
    if (!storage) return "unavailable";
    const raw = storage.getItem(BLACKJACK_STORAGE_KEY);
    if (raw === null) return "cold";
    if (raw.length > 100_000) return "incompatible";
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "encoder,readout,version"
      || value.version !== 1 || value.encoder !== BLACKJACK_ENCODER) return "incompatible";
    return readout.restore(value.readout) ? "restored" : "incompatible";
  } catch { return "unavailable"; }
}

export function saveBlackjackReadout(readout: NeuralReadout, storage: ReadoutStorage | null): boolean {
  try {
    if (!storage) return false;
    storage.setItem(BLACKJACK_STORAGE_KEY,JSON.stringify({version:1,encoder:BLACKJACK_ENCODER,readout:readout.export()}));
    return true;
  } catch { return false; }
}

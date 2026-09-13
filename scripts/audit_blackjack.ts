import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chooseFromActions, countShoe, createGame, dealRound, legalActions, ranks, step } from "../src/activities/blackjack.ts";
import type { Action, GameState, Rank } from "../src/activities/blackjack.ts";
import type { Odds } from "../src/activities/blackjackOdds.ts";
import type { RoundObservation } from "../src/activities/blackjackRollout.ts";

export const referenceRanks: Rank[] = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10"];
export const sourceUrl = "https://wizardofodds.com/games/blackjack/strategy/calculator/";

// Transcribed factual decisions from S17_0: columns 2..9, ET, EA;
// resolve Q* to Split (DAS) and R* to the fallback (no surrender).
// D = double/hit; d = double/stand. The chart has no resplit-limit selector.
const hard = [
  "HHHHHHHHHH", "HHHHHHHHHH", "HHHHHHHHHH", "HHHDDHHHHH",
  "DDDDDHHHHH", "DDDDDDDDHH", "DDDDDDDDHH", "HHSSSHHHHH",
  "SSSSSHHHHH", "SSSSSHHHHH", "SSSSSHHHHH", "SSSSSHHHHH",
  "SSSSSSSSSS", "SSSSSSSSSS", "SSSSSSSSSS", "SSSSSSSSSS", "SSSSSSSSSS",
];
const soft = [
  "HHDDDHHHHH", "HHDDDHHHHH", "HHDDDHHHHH", "HHDDDHHHHH",
  "DDDDDHHHHH", "SddddSSHHS", "SSSSdSSSSS", "SSSSSSSSSS", "SSSSSSSSSS",
];
const pairs: Record<Rank, string> = {
  A: "PPPPPPPPPH", "2": "PPPPPPHHHH", "3": "PPPPPPPHHH", "4": "HHPPPHHHHH",
  "5": "DDDDDDDDHH", "6": "PPPPPPHHHH", "7": "PPPPPPPHSH",
  "8": "PPPPPPPPHH", "9": "PPPPPSPPSS", "10": "SSSSSSSSSS",
};

// This arithmetic, settlement, recursion and memoization do not call the
// production value/settlement/oracle/rollout helpers.
export function referenceValue(cards: readonly Rank[]) {
  let low = 0, aces = 0;
  for (const rank of cards) { low += rank === "A" ? 1 : Number(rank); if (rank === "A") aces++; }
  const soft = aces > 0 && low + 10 <= 21;
  return { total: low + (soft ? 10 : 0), soft };
}

export function bookAction(cards: Rank[], up: Rank, allowed: Action[]): Action {
  const value = referenceValue(cards);
  const column = up === "A" ? 9 : Number(up) - 2;
  const pair = cards.length === 2 && cards[0] === cards[1] && allowed.includes("Split");
  const row = pair ? pairs[cards[0]] : value.soft ? soft[value.total - 13] : hard[value.total - 5];
  // A,A after a prior split is soft 12, which cannot be resplit here.
  const code = row?.[column] ?? "H";
  if (code === "P") return "Split";
  if (code === "D" || code === "d") return allowed.includes("Double") ? "Double" : code === "d" ? "Stand" : "Hit";
  return code === "S" ? "Stand" : "Hit";
}

export function freshCounts(player: Rank[], up: Rank): number[] {
  const shoe = [4, 4, 4, 4, 4, 4, 4, 4, 4, 16];
  for (const rank of [...player, up]) shoe[referenceRanks.indexOf(rank)]--;
  return shoe;
}

export function observedRound(game: GameState): RoundObservation {
  return { activeHand: game.activeHand, hands: game.hands.map(hand => ({ ...hand, cards: ranks(hand.cards) })) };
}

export function singleRound(cards: Rank[], fromSplit = false): RoundObservation {
  return { activeHand: 0, hands: [{ cards, bet: 1, status: "playing", fromSplit, splitAces: false }] };
}

type RefHand = { cards: Rank[]; bet: number; fromSplit: boolean; splitAces: boolean; done: boolean };
export function referenceFrozenPolicy(up: Rank, counts: number[]) {
  const total = counts.reduce((a, b) => a + b, 0);
  const probabilities = counts.map(n => n / total);
  const dealerMemo = new Map<string, number[]>();
  function dealer(cards: Rank[]): number[] {
    const v = referenceValue(cards);
    const key = `${v.total}/${v.soft}/${cards.length === 1}/${cards.length === 2 && v.total === 21}`;
    const cached = dealerMemo.get(key);
    if (cached) return cached;
    const dist = Array<number>(24).fill(0);
    if (cards.length >= 2 && v.total >= 17) dist[v.total > 21 ? 22 : cards.length === 2 && v.total === 21 ? 23 : v.total] = 1;
    else probabilities.forEach((p, i) => {
      if (p) dealer([...cards, referenceRanks[i]]).forEach((n, j) => { dist[j] += p * n; });
    });
    dealerMemo.set(key, dist);
    return dist;
  }
  const dist = dealer([up]);
  function stand(cards: Rank[]): number {
    const value = referenceValue(cards).total;
    return value > 21 ? -1 : dist.reduce((sum, p, outcome) => sum + p * (outcome === 23 ? -1 : outcome === 22 ? 1 : Math.sign(value - outcome)), 0);
  }
  const memo = new Map<string, { action: Action; ev: number }>();
  function best(cards: Rank[], double: boolean): { action: Action; ev: number } {
    const v = referenceValue(cards);
    const key = `${v.total}/${v.soft}/${double}`;
    const cached = memo.get(key);
    if (cached) return cached;
    let result: { action: Action; ev: number } = { action: "Stand", ev: stand(cards) };
    if (v.total < 21) {
      let hitEv = 0, doubleEv = 0;
      probabilities.forEach((p, i) => {
        if (!p) return;
        const next = [...cards, referenceRanks[i]];
        hitEv += p * (referenceValue(next).total > 21 ? -1 : best(next, false).ev);
        doubleEv += p * 2 * stand(next);
      });
      if (hitEv > result.ev) result = { action: "Hit", ev: hitEv };
      if (double && doubleEv > result.ev) result = { action: "Double", ev: doubleEv };
    }
    memo.set(key, result);
    return result;
  }
  return (cards: Rank[], double: boolean) => best(cards, double).action;
}

export function referenceEV(round: RoundObservation, up: Rank, input: number[], actions: Action[], budgetMs = 2500,
  continuationPolicy?: (cards: Rank[], double: boolean) => Action) {
  const started = performance.now();
  const counts = [...input];
  const dealerMemo = new Map<string, number[]>();
  const playerMemo = new Map<string, number>();
  let visits = 0;
  function check() {
    if ((++visits & 1023) === 0 && (performance.now() - started > budgetMs || dealerMemo.size + playerMemo.size > 350000)) {
      throw new Error("Independent reference budget exceeded");
    }
  }
  function expectation(fn: (rank: Rank) => number): number {
    const left = counts.reduce((a, b) => a + b, 0);
    if (!left) throw new Error("Independent reference encountered exhausted shoe");
    let ev = 0;
    for (let i = 0; i < counts.length; i++) {
      const n = counts[i];
      if (!n) continue;
      counts[i]--;
      ev += n / left * fn(referenceRanks[i]);
      counts[i]++;
    }
    return ev;
  }
  function dealer(cards: Rank[]): number[] {
    check();
    const { total, soft } = referenceValue(cards);
    const natural = total === 21 && cards.length === 2;
    if (cards.length >= 2 && total >= 17) {
      const dist = Array<number>(24).fill(0);
      dist[natural ? 23 : total > 21 ? 22 : total] = 1;
      return dist;
    }
    const key = `${total}/${soft}/${cards.length === 1}/${counts.join(",")}`;
    const cached = dealerMemo.get(key);
    if (cached) return cached;
    const dist = Array<number>(24).fill(0);
    expectation(rank => {
      const branch = dealer([...cards, rank]);
      // expectation supplies the branch probability; recover it before restore.
      const i = referenceRanks.indexOf(rank);
      const p = (counts[i] + 1) / (counts.reduce((a, b) => a + b, 0) + 1);
      branch.forEach((v, j) => { dist[j] += p * v; });
      return 0;
    });
    dealerMemo.set(key, dist);
    return dist;
  }
  function payoff(hands: RefHand[]): number {
    if (hands.every(h => referenceValue(h.cards).total > 21)) return -hands.reduce((s, h) => s + h.bet, 0);
    const dist = dealer([up]);
    return hands.reduce((sum, hand) => {
      const total = referenceValue(hand.cards).total;
      const natural = !hand.fromSplit && hand.cards.length === 2 && total === 21;
      return sum + hand.bet * dist.reduce((ev, p, outcome) => ev + p * (
        total > 21 ? -1 : outcome === 23 ? natural ? 0 : -1 : natural ? 1.5 : outcome === 22 ? 1 : Math.sign(total - outcome)
      ), 0);
    }, 0);
  }
  function handKey(h: RefHand): string {
    const v = referenceValue(h.cards);
    return `${v.total}:${v.soft}:${Math.min(3, h.cards.length)}:${h.bet}:${h.fromSplit}:${h.splitAces}:${h.done}`;
  }
  function play(hands: RefHand[], active: number): number {
    check();
    if (active === hands.length) return payoff(hands);
    const h = hands[active];
    if (h.done) return play(hands, active + 1);
    if (h.cards.length === 1) return expectation(rank => {
      const next = [...hands]; next[active] = { ...h, cards: [...h.cards, rank] };
      return play(next, active);
    });
    if (h.splitAces || referenceValue(h.cards).total >= 21) return play(hands, active + 1);
    const key = `${active}/${hands.map(handKey).join(";")}/${counts.join(",")}`;
    const cached = playerMemo.get(key);
    if (cached !== undefined) return cached;
    const allowed: Action[] = continuationPolicy ? [continuationPolicy(h.cards, h.cards.length === 2)]
      : h.cards.length === 2 ? ["Stand", "Hit", "Double"] : ["Stand", "Hit"];
    const ev = Math.max(...allowed.map(action => move(hands, active, action)));
    playerMemo.set(key, ev);
    return ev;
  }
  function move(hands: RefHand[], active: number, action: Action): number {
    const h = hands[active];
    if (action === "Stand") return play(hands, active + 1);
    if (action === "Split") {
      assert.equal(hands.length, 1);
      assert.equal(h.cards[0], h.cards[1]);
      return play(h.cards.map(rank => ({ cards: [rank], bet: 1, fromSplit: true, splitAces: rank === "A", done: false })), 0);
    }
    return expectation(rank => {
      const next = [...hands];
      next[active] = { ...h, cards: [...h.cards, rank], bet: action === "Double" ? 2 * h.bet : h.bet };
      return play(next, action === "Double" ? active + 1 : active);
    });
  }
  const hands = round.hands.map(h => ({ ...h, done: h.status === "stood" || h.status === "bust" }));
  const values: Partial<Record<Action, number>> = {};
  for (const action of actions) values[action] = move(hands, round.activeHand, action);
  return { values, states: dealerMemo.size + playerMemo.size, elapsedMs: performance.now() - started };
}

export function seeded(seed: number): () => number {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}

export const auditedSources = ["src/activities/blackjack.ts", "src/activities/blackjackOdds.ts", "src/activities/blackjackRollout.ts", "src/activities/blackjack.worker.ts", "src/main.ts", "index.html"];
export function sourceHashes() {
  return Object.fromEntries(auditedSources.map(path => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));
}

// Invoke the real worker message handler with the exact public payload sent by
// main.ts. Node substitutes its global only; no rendering or worker scheduling.
export async function workerAdapter() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "self");
  let response: { id: number; odds?: Odds; error?: string } | undefined;
  const worker = { onmessage: null as null | ((event: { data: unknown }) => void), postMessage: (value: typeof response) => { response = value; } };
  Object.defineProperty(globalThis, "self", { configurable: true, value: worker });
  await import("../src/activities/blackjack.worker.ts");
  return {
    request(id: number, player: Rank[], dealer: Rank, shoe: number[], options: object) {
      response = undefined;
      worker.onmessage!({ data: { id, player, dealer, shoe, options } });
      assert.equal(response?.id, id);
      if (!response?.odds) throw new Error(response?.error ?? "Missing worker response");
      return response.odds;
    },
    close() { if (previous) Object.defineProperty(globalThis, "self", previous); else Reflect.deleteProperty(globalThis, "self"); },
  };
}

async function main() {
  const seed = Number(process.argv[2] ?? 5) >>> 0;
  const target = Number(process.argv[3] ?? 60);
  const noise = Number(process.argv[4] ?? 0);
  assert.ok(Number.isInteger(target) && target >= 1 && target <= 100);
  assert.ok(noise >= 0 && noise <= 1);
  const directory = resolve("test-results/blackjack-audit");
  mkdirSync(directory, { recursive: true });
  const hashes = sourceHashes();
  const random = seeded(seed), policyRandom = seeded(seed ^ 0xcafebabe);
  const game = createGame(1, random);
  const initialShoe = structuredClone(game.shoe);
  const worker = await workerAdapter();
  const decisions: any[] = [], rounds: any[] = [];
  const started = performance.now();
  try {
    while (decisions.length < target) {
      if (performance.now() - started > 180000) throw new Error("Audit exceeded 180-second total budget");
      dealRound(game, random);
      const firstDecision = decisions.length + 1;
      while (game.status === "playing") {
        const id = decisions.length + 1;
        const player = ranks(game.player), dealer = game.dealer[0].rank, shoe = countShoe(game.shoe);
        const allowed = legalActions(game), round = observedRound(game);
        const options = { allowDouble: allowed.includes("Double"), allowSplit: allowed.includes("Split"), fromSplit: game.hands[game.activeHand].fromSplit, round };
        const odds = worker.request(id, player, dealer, shoe, options);
        const values = Object.fromEntries(Object.entries(odds.values).filter(([a]) => allowed.includes(a as Action)));
        const choice = chooseFromActions(values, noise, policyRandom);
        const book = bookAction(player, dealer, allowed);
        let independent: object;
        try {
          const ref = referenceEV(round, dealer, shoe, allowed.filter(a => a !== "Split"));
          independent = { ...ref, scope: round.hands.length > 1 ? "whole round, optimal continuation" : "single hand, H/S/D", maxAbsDifference: Math.max(...Object.entries(ref.values).map(([a, ev]) => Math.abs(ev! - values[a as Action]!))) };
        } catch (error) { independent = { limitation: String(error) }; }
        const before = { player, dealer, shoe, round };
        const shoeBefore = structuredClone(game.shoe);
        step(game, choice.action);
        assert.ok(allowed.includes(choice.action));
        const row = { id, roundNumber: game.round, shuffle: game.shuffles, ...before, allowed,
          recommendation: odds.recommendation, selected: choice.action, scores: choice.scores, method: odds.method,
          values, errors: odds.errors, book, bookMatch: book === choice.action, independent,
          oracleMs: odds.elapsedMs, actualDraws: shoeBefore.slice(game.shoe.length).reverse(),
          after: { hands: structuredClone(game.hands), dealer: structuredClone(game.dealer), status: game.status, reward: game.reward } };
        decisions.push(row);
        if (id % 10 === 0) console.log(`seed=${seed}: ${id} decisions, round=${game.round}, ${Math.round(performance.now() - started)}ms`);
      }
      rounds.push({ round: game.round, shuffle: game.shuffles, firstDecision: decisions.length < firstDecision ? null : firstDecision,
        lastDecision: decisions.length < firstDecision ? null : decisions.length, hands: structuredClone(game.hands), dealer: structuredClone(game.dealer), reward: game.reward, bankroll: game.bankroll });
    }
  } finally { worker.close(); }
  assert.deepEqual(sourceHashes(), hashes, "Audited production source changed during history collection");
  const summary = { seed, noise, target, decisions: decisions.length, rounds: rounds.length, shuffles: game.shuffles,
    bankroll: game.bankroll, bookMatches: decisions.filter(d => d.bookMatch).length,
    selectedVsRecommendation: decisions.filter(d => d.selected !== d.recommendation).map(d => d.id),
    methods: Object.fromEntries(["exact", "mixed", "sampled"].map(method => [method, decisions.filter(d => d.method === method).length])),
    referenceCompleted: decisions.filter(d => !d.independent.limitation).length,
    discrepancies: decisions.filter(d => !d.bookMatch).map(d => ({ id: d.id, player: d.player, dealer: d.dealer, selected: d.selected, book: d.book, values: d.values, independent: d.independent })),
    maxExactDifference: Math.max(0, ...decisions.filter(d => d.method !== "sampled" && !d.independent.limitation).map(d => d.independent.maxAbsDifference)),
    elapsedMs: performance.now() - started };
  const history = { rules: "1 deck, public remaining composition, ENHC, S17, 3:2, DAS, max 2 hands, one card to split aces, all stakes lost to dealer BJ", sourceUrl, sourceHashes: hashes, summary, initialShoe, decisions, rounds };
  const stem = `seed-${seed}-noise-${noise}`;
  writeFileSync(resolve(directory, `${stem}.json`), JSON.stringify(history, null, 2) + "\n");
  writeFileSync(resolve(directory, `${stem}.jsonl`), decisions.map(row => JSON.stringify(row)).join("\n") + "\n");
  console.log(JSON.stringify(summary, null, 2));
}

async function checkSource() {
  const ts = await import("typescript");
  const path = "test-results/blackjack-audit/wizard-calculator.html";
  const html = existsSync(path) ? readFileSync(path, "utf8") : await (async () => {
    const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(30000) });
    assert.ok(response.ok, `Primary source HTTP ${response.status}`);
    return response.text();
  })();
  mkdirSync("test-results/blackjack-audit", { recursive: true });
  writeFileSync(path, html);
  const start = html.indexOf("var S17_0 =");
  assert.ok(start >= 0, "Primary-source table missing");
  // Parse the published array as syntax; do not execute downloaded JavaScript.
  const file = ts.createSourceFile("reference.js", html.slice(start), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declaration = (file.statements[0] as import("typescript").VariableStatement).declarationList.declarations[0];
  assert.equal(declaration.name.getText(file), "S17_0");
  assert.ok(declaration.initializer && ts.isArrayLiteralExpression(declaration.initializer));
  const rows = declaration.initializer.elements.map(row => {
    assert.ok(ts.isArrayLiteralExpression(row));
    return row.elements.map(cell => { assert.ok(ts.isStringLiteral(cell)); return cell.text; });
  });
  assert.equal(rows.length, 36);
  const expected = [...hard, ...soft, ...["2", "3", "4", "5", "6", "7", "8", "9", "10", "A"].map(r => pairs[r as Rank])];
  const decode: Record<string, string> = { H: "H", S: "S", DH: "D", DS: "d", P: "P", QH: "P", QD: "P", QS: "P", RH: "H", RS: "S", RP: "P" };
  rows.forEach((row, i) => {
    assert.equal(row.length, 12);
    const european = [...row.slice(0, 8), row[10], row[11]].map(code => decode[code]).join("");
    assert.equal(expected[i], european, `Chart transcription row ${i}`);
  });
  const result = { sourceUrl, sha256: createHash("sha256").update(html).digest("hex"), rows: 36, cells: 360,
    settings: { decks: 1, soft17: "stand", das: true, surrender: false, peek: false }, resplitLimitSelector: false, matched: true };
  writeFileSync("test-results/blackjack-audit/source-table-check.json", JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
}

async function checkSplits() {
  const { estimateRound } = await import("../src/activities/blackjackRollout.ts");
  const checks = [];
  const histories = [5, 17].map(seed => ({ seed, history: JSON.parse(readFileSync(`test-results/blackjack-audit/seed-${seed}-noise-0.json`, "utf8")) }));
  for (const { seed, history } of histories) {
    for (const row of history.decisions.filter((d: any) => d.method === "mixed")) {
      try {
        const ref = referenceEV(row.round, row.dealer, row.shoe, ["Split"]);
        const values = { ...row.independent.values, ...ref.values };
        const best = (Object.keys(values) as Action[]).reduce((a, b) => values[b] > values[a] ? b : a);
        const frozenSplit = referenceEV(row.round, row.dealer, row.shoe, ["Split"], 2500, referenceFrozenPolicy(row.dealer, row.shoe)).values.Split!;
        const highSample = row.selected === "Split" || best !== row.selected || Math.abs(ref.values.Split! - row.values.Split) > row.errors.Split
          ? estimateRound(row.round, row.dealer, row.shoe, "Split", 1000000) : null;
        checks.push({ seed, id: row.id, player: row.player, dealer: row.dealer, selected: row.selected,
          exactSplit: ref.values.Split, exactBest: best, regret: values[best] - values[row.selected],
          frozenSplit, policyBias: frozenSplit - ref.values.Split!, samplingError: row.values.Split - frozenSplit,
          sampledSplit: row.values.Split, error95: row.errors.Split, highSample, states: ref.states });
      } catch (error) { checks.push({ seed, id: row.id, limitation: String(error) }); }
    }
  }
  mkdirSync("test-results/blackjack-audit", { recursive: true });
  writeFileSync("test-results/blackjack-audit/split-checks.json", JSON.stringify(checks, null, 2) + "\n");
  console.log(JSON.stringify(checks, null, 2));
}

async function checkBrowser() {
  const expected = JSON.parse(readFileSync("test-results/blackjack-audit/seed-5-noise-0.json", "utf8"));
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      const audit = { requests: [] as any[], responses: [] as any[], traces: [] as any[] };
      (window as any).__bjAudit = audit;
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          this.addEventListener("message", event => audit.responses.push(structuredClone(event.data)));
        }
        postMessage(value: any) { audit.requests.push(structuredClone(value)); super.postMessage(value); }
      };
      document.addEventListener("DOMContentLoaded", () => {
        new MutationObserver(() => {
          const id = Number(document.querySelector("#decisionStats")?.textContent?.match(/^#(\d+)/)?.[1]);
          if (id) audit.traces.push({ id, lines: Array.from(document.querySelectorAll("#brainTrace li"), node => node.textContent) });
        }).observe(document.querySelector("#brainTrace")!, { childList: true, subtree: true });
      });
    });
    await page.goto("http://127.0.0.1:5173/?seed=5");
    await page.locator("#playSpeed").selectOption("4");
    await page.waitForFunction(() => (window as any).__bjAudit.traces.some((t: any) => t.id === 6 && t.lines[3] !== "Act: Pending"), { }, { timeout: 45000 });
    await page.locator("#autoplayButton").click();
    const actual = await page.evaluate(() => (window as any).__bjAudit);
    for (let i = 0; i < 6; i++) {
      const request = actual.requests[i], row = expected.decisions[i];
      assert.deepEqual([request.player, request.dealer, request.shoe, request.options.round], [row.player, row.dealer, row.shoe, row.round]);
      const response = actual.responses.find((r: any) => r.id === request.id);
      assert.deepEqual(response.odds.values, row.values);
      assert.ok(actual.traces.some((t: any) => t.id === row.id && t.lines[2]?.startsWith(`Select: ${row.selected};`)));
    }
    assert.deepEqual(errors, []);
    mkdirSync("test-results/blackjack-audit", { recursive: true });
    await page.screenshot({ path: "test-results/blackjack-audit/browser-seed-5.png", fullPage: true });
    writeFileSync("test-results/blackjack-audit/browser-seed-5.json", JSON.stringify({ verifiedDecisions: 6, errors, ...actual }, null, 2) + "\n");
    console.log("Browser: six real autoplay decisions match the seeded core history, worker values and selections; no page errors.");
  } finally { await browser.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === "--source-check") await checkSource();
  else if (process.argv[2] === "--split-checks") await checkSplits();
  else if (process.argv[2] === "--browser-check") await checkBrowser();
  else await main();
}

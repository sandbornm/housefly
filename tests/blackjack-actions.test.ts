import test from "node:test";
import assert from "node:assert/strict";
import { createGame, step, legalActions, ranks, dealRound, chooseFromActions } from "../src/activities/blackjack.ts";
import { calculateOdds } from "../src/activities/blackjackOdds.ts";
import { estimateRound } from "../src/activities/blackjackRollout.ts";
import type { Rank } from "../src/activities/blackjack.ts";

function rig(player: Rank[], up: Rank, draws: Rank[]) {
  const game = createGame(1, () => 0.5);
  const take = (rank: Rank) => {
    const index = game.shoe.findIndex(c => c.rank === rank);
    assert.ok(index >= 0);
    return game.shoe.splice(index,1)[0];
  };
  game.hands[0].cards = player.map(take);
  game.dealer = [take(up)];
  const ordered = draws.map(take);
  game.shoe.push(...ordered.reverse());
  game.status = "playing";
  return game;
}

test("Double takes exactly one card, doubles the stake and forces a stand", () => {
  const game = rig(["5","6"],"6",["10","10","10"]);
  step(game,"Double");
  assert.equal(game.status,"resolved");
  assert.equal(game.player.length,3);
  assert.equal(game.hands[0].bet,2);
  assert.equal(game.reward,2);
  const remaining = game.shoe.length;
  step(game,"Double");
  assert.equal(game.shoe.length,remaining);
  assert.equal(game.bankroll,2);
});

test("Double bust and dealer natural lose both staked units", () => {
  const bust = rig(["10","6"],"10",["10"]);
  step(bust,"Double"); assert.equal(bust.reward,-2); assert.equal(bust.dealer.length,1);
  const natural = rig(["5","6"],"A",["10","10"]);
  step(natural,"Double"); assert.equal(natural.reward,-2);
});

test("Double is unavailable after a hit", () => {
  const game = rig(["5","6"],"6",["2"]);
  step(game,"Hit");
  assert.ok(!legalActions(game).includes("Double"));
  const remaining=game.shoe.length;
  step(game,"Double"); assert.equal(game.shoe.length,remaining); assert.equal(game.hands[0].bet,1);
});

test("Split hands play sequentially, allow DAS, and share one dealer", () => {
  const game = rig(["8","8"],"6",["3","10","2","10","10","10"]);
  step(game,"Split");
  assert.equal(game.hands.length,2); assert.equal(game.hands[1].cards.length,1);
  assert.ok(!legalActions(game).includes("Split"));
  step(game,"Double");
  assert.equal(game.activeHand,1); assert.deepEqual(ranks(game.player),["8","2"]);
  step(game,"Double");
  assert.equal(game.status,"resolved"); assert.equal(game.reward,4);
  assert.deepEqual(game.hands.map(h=>h.reward),[2,2]); assert.equal(game.dealer.length,3);
  const ids=[...game.hands.flatMap(h=>h.cards),...game.dealer,...game.shoe].map(c=>c.id);
  assert.equal(new Set(ids).size,52); assert.equal(ids.length,52);
});

test("split aces receive one card, pay ordinary 21, and lose to dealer natural", () => {
  const win=rig(["A","A"],"6",["10","10","10","10"]);
  step(win,"Split");assert.equal(win.reward,2);assert.deepEqual(win.hands.map(h=>h.cards.length),[2,2]);assert.deepEqual(legalActions(win),[]);
  const loss=rig(["A","A"],"10",["10","2","A"]);
  step(loss,"Split");assert.equal(loss.reward,-2);
});

test("invalid split is a no-op; no resplitting beyond two hands", () => {
  const game=rig(["8","7"],"6",[]);
  const left=game.shoe.length;step(game,"Split");assert.equal(game.shoe.length,left);assert.equal(game.hands.length,1);
  const pair=rig(["8","8"],"6",["8"]);step(pair,"Split");assert.ok(!legalActions(pair).includes("Split"));
});

test("exact Double and deterministic Split estimates include all wagers", () => {
  const shoe=[0,0,0,0,0,0,0,0,0,8];
  const doubled=calculateOdds(["5","6"],"6",shoe,{allowDouble:true});
  assert.equal(doubled.doubleEv,2);assert.equal(doubled.recommendation,"Double");
  const split=calculateOdds(["8","8"],"6",shoe,{allowDouble:true,allowSplit:true});
  assert.equal(split.splitEv,2);assert.equal(split.errors.Split,0);assert.equal(split.recommendation,"Split");assert.equal(split.method,"mixed");
  assert.deepEqual(shoe,[0,0,0,0,0,0,0,0,0,8]);
});

test("split-round estimates include completed hands and are reproducible", () => {
  const shoe=[0,0,0,0,0,0,0,0,0,6];
  const round={hands:[{cards:["10","10"] as Rank[],bet:2,status:"stood",fromSplit:true,splitAces:false},
    {cards:["8","2"] as Rank[],bet:1,status:"playing",fromSplit:true,splitAces:false}],activeHand:1};
  const a=estimateRound(round,"6",shoe,"Double",100);
  const b=estimateRound(round,"6",shoe,"Double",100);
  assert.deepEqual(a,b);assert.equal(a.ev,4);assert.equal(a.error95,0);
  const stand=estimateRound(round,"6",shoe,"Stand",100);assert.equal(stand.ev,3);
});

test("random legal four-action play conserves cards and never exhausts the shoe", () => {
  let seed=67;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const game=createGame(1,random);
  for(let round=0;round<1500;round++){
    dealRound(game,random);
    while(game.status==="playing"){const actions=legalActions(game);assert.ok(actions.length);step(game,actions[Math.floor(random()*actions.length)]);}
    assert.ok(game.shoe.length>0);assert.ok(Number.isFinite(game.reward));
    const ids=[...game.hands.flatMap(h=>h.cards),...game.dealer,...game.shoe].map(c=>c.id);assert.equal(ids.length,new Set(ids).size);
  }
  assert.equal(chooseFromActions({Hit:-0.2,Stand:-0.4,Double:0.4,Split:0.1},0).action,"Double");
});

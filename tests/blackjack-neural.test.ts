import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { createGame, dealRound, legalActions, step } from "../src/activities/blackjack.ts";
import { NeuralReadout } from "../src/neural/policy.ts";
import type { NeuralFrame } from "../src/neural/runtime.ts";
import { BLACKJACK_ACTIONS, BLACKJACK_STORAGE_KEY, BlackjackNeuralController, encodeBlackjack, observeBlackjack, restoreBlackjackReadout, saveBlackjackReadout } from "../src/activities/blackjackNeural.ts";

function random(seed=1977) { return () => { seed=(Math.imul(seed,1664525)+1013904223)>>>0; return seed/4294967296; }; }
function game() { const state=createGame(1,random(5)); dealRound(state); return state; }
function readout() { return new NeuralReadout({actions:BLACKJACK_ACTIONS,modelId:"blackjack-unit-fixture",seed:17}); }
function frame(tick=100, active=0): NeuralFrame {
  const rates=new Float32Array(128); if (active>=0) rates[active]=40;
  return {tick,simulatedMs:tick*.2,rates,levels:new Float32Array(128),counts:new Uint16Array(128),spikes:new Uint32Array([active]),totalSpikes:1,silenced:false};
}
function fixture(active=0) {
  const requests: {input:Float32Array;ms:number}[]=[];
  const runtime={silenced:false,async advance(input:Float32Array,ms:number){requests.push({input:input.slice(),ms});return frame(requests.length*100,active);}};
  return {controller:new BlackjackNeuralController(runtime,readout()),runtime,requests};
}

test("encoder is exactly 32 bounded observable channels with no shoe-order, identity, hidden dealer or EV input",()=>{
  const first=game(), second=game();
  const observation=observeBlackjack(first), encoded=encodeBlackjack(observation);
  assert.equal(encoded.length,32); assert(encoded.every(v=>Number.isFinite(v)&&v>=0&&v<=150));
  assert.equal(encoded.slice(8,18).filter(v=>v>0).length,1);
  assert(Math.abs(encoded.slice(22).reduce((a,b)=>a+b,0)-150)<1e-4);
  second.shoe.reverse(); second.shoe=second.shoe.map(card=>({...card,id:card.id+10000,face:"not observed"}));
  second.dealer.push({...second.dealer[0],rank:"A",id:9000});
  second.bankroll=100; second.reward=99; second.message="EV Hit +100";
  assert.deepEqual(encodeBlackjack(observeBlackjack(second)),encoded);
  assert.notDeepEqual(encodeBlackjack({...observation,total:observation.total-5}),encoded);
  assert.throws(()=>encodeBlackjack({...observation,remaining:[-1,...observation.remaining.slice(1)]}));
});

test("readout awaits six 20 ms neural responses and emits only a legal action",async()=>{
  const {controller,requests}=fixture(), state=game();
  state.hands[0].cards.push(state.shoe.pop()!);
  const shown:number[]=[];
  const choice=await controller.decide(state,f=>shown.push(f.tick),()=>true);
  assert(choice); assert(legalActions(state).includes(choice.decision.action as typeof BLACKJACK_ACTIONS[number]));
  assert.equal(choice.decision.probabilities[2],0); assert.equal(choice.decision.probabilities[3],0);
  assert.equal(requests.length,6); assert(requests.every(r=>r.ms===20 && r.input.length===32));
  assert.deepEqual(shown,[100,200,300,400,500,600]);
  assert.equal(choice.frame.tick,choice.decision.tick);
  assert.equal(choice.frame.simulatedMs,120);
});

test("observations cannot bypass neural output; silence and no rates withhold decisions",async()=>{
  const a=fixture(), b=fixture(), first=game(), second=game();
  second.dealer[0]={...second.dealer[0],rank:"A"};
  const left=await a.controller.decide(first,()=>{},()=>true);
  const right=await b.controller.decide(second,()=>{},()=>true);
  assert(left&&right);
  assert.deepEqual(left.decision.probabilities,right.decision.probabilities,"Same rates give same readout despite different observations");
  const changed=await fixture(127).controller.decide(first,()=>{},()=>true);
  assert(changed); assert.notDeepEqual(left.scores,changed.scores,"Neural rate features cause the score change");
  assert.equal(await fixture(-1).controller.decide(first,()=>{},()=>true),null);
  a.runtime.silenced=true;
  assert.equal(await a.controller.decide(first,()=>{throw Error("Should not display");},()=>true),null);
});

test("an in-flight frame cannot choose after immediate silence or cancellation, and errors propagate",async()=>{
  let release!: (f:NeuralFrame)=>void;
  const runtime={silenced:false,advance:()=>new Promise<NeuralFrame>(resolve=>{release=resolve;})};
  const controller=new BlackjackNeuralController(runtime,readout());
  const pending=controller.decide(game(),()=>{throw Error("Stale frame displayed");},()=>true);
  runtime.silenced=true; release(frame()); assert.equal(await pending,null);
  runtime.silenced=false; let valid=true;
  const cancelled=controller.decide(game(),()=>{throw Error("Cancelled frame displayed");},()=>valid);
  valid=false; release(frame()); assert.equal(await cancelled,null);
  const failed=new BlackjackNeuralController({silenced:false,advance:async()=>{throw Error("model error");}},readout());
  await assert.rejects(failed.decide(game(),()=>{},()=>true),/model error/);
});

test("only executed neural traces receive completed-round credit, once",async()=>{
  const {controller}=fixture(), state=game(); controller.beginRound(state.round,true);
  while(state.status==="playing") {
    const choice=await controller.decide(state,()=>{},()=>true); assert(choice);
    step(state,choice.decision.action as typeof BLACKJACK_ACTIONS[number]);
    controller.recordExecuted(state.round,choice.decision);
    assert.throws(()=>controller.recordExecuted(state.round,choice.decision),/duplicate/);
  }
  assert(controller.settle(state,true)); assert.equal(controller.readout.episodes,1);
  assert.equal(controller.readout.totalReward,state.reward);
  const saved=controller.readout.export();
  assert.equal(controller.settle(state,true),false); assert.deepEqual(controller.readout.export(),saved);
  for(const discard of [false,true]) {
    const next=fixture().controller, round=game(); next.beginRound(round.round,true);
    const choice=await next.decide(round,()=>{},()=>true); assert(choice);
    if(discard) {next.recordExecuted(round.round,choice.decision);next.discard();next.beginRound(round.round,true);}
    step(round,"Stand");
    assert.equal(next.settle(round,true),false); assert.equal(next.readout.episodes,0);
  }
});

test("disabled learning discards credit and guarded storage rejects incompatible or broken saves",async()=>{
  const controller=fixture().controller, state=game(); controller.beginRound(state.round,true);
  const choice=await controller.decide(state,()=>{},()=>true); assert(choice);
  controller.recordExecuted(state.round,choice.decision); step(state,"Stand");
  assert.equal(controller.settle(state,false),false); assert.equal(controller.readout.episodes,0);
  const memory=new Map<string,string>();
  const storage={getItem:(k:string)=>memory.get(k)??null,setItem:(k:string,v:string)=>{memory.set(k,v);},removeItem:(k:string)=>{memory.delete(k);}};
  assert.equal(restoreBlackjackReadout(readout(),storage),"cold");
  const trained=readout(); trained.reinforce([trained.decide(frame())!],-1);
  assert(saveBlackjackReadout(trained,storage));
  const restored=readout(); assert.equal(restoreBlackjackReadout(restored,storage),"restored"); assert.deepEqual(restored.export(),trained.export());
  const saved=memory.get(BLACKJACK_STORAGE_KEY)!;
  for(const mutate of [(v:any)=>{v.encoder="other";},(v:any)=>{v.readout.modelId="other";},(v:any)=>{v.readout.actions.reverse();},(v:any)=>{v.readout.weights[0]=1000;}]) {
    const value=JSON.parse(saved); mutate(value); storage.setItem(BLACKJACK_STORAGE_KEY,JSON.stringify(value));
    assert.equal(restoreBlackjackReadout(restored,storage),"incompatible"); assert.deepEqual(restored.export(),trained.export());
  }
  storage.setItem(BLACKJACK_STORAGE_KEY,"bad JSON"); assert.equal(restoreBlackjackReadout(restored,storage),"unavailable");
  const blocked={...storage,getItem:()=>{throw Error("blocked");},setItem:()=>{throw Error("quota");}};
  assert.equal(restoreBlackjackReadout(restored,blocked),"unavailable"); assert.equal(saveBlackjackReadout(restored,blocked),false);
});

test("browser: actual LIF actions, credit, replay, silence and 1080p/mobile layout",{skip:!process.env.HOUSEFLY_BROWSER,timeout:240_000},async()=>{
  const {chromium,expect}=await import("@playwright/test");
  const browser=await chromium.launch({headless:true});
  const target=new URL(process.env.HOUSEFLY_URL ?? "http://127.0.0.1:5173/");
  target.searchParams.set("seed","1977");
  const output="test-results/casino-evolved/neural"; await mkdir(output,{recursive:true});
  try {
    const page=await browser.newPage({viewport:{width:1920,height:1080}});
    const errors:string[]=[], oddsRequests:string[]=[];
    page.on("pageerror",error=>errors.push(error.message));
    page.on("request",request=>{if(request.url().includes("blackjack.worker"))oddsRequests.push(request.url());});
    const snapshot=()=>page.evaluate(()=> (window as any).__housefly.snapshot());
    const renderedCanvases=async()=>{
      const samples=await page.evaluate(async()=>{
        await new Promise(requestAnimationFrame);
        return ["scene","brainCanvas"].map(id=>{
          const canvas=document.getElementById(id) as HTMLCanvasElement;
          const gl=canvas.getContext("webgl2")!;
          const bytes=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);
          gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
          let lit=0; const colors=new Set<number>();
          for(let i=0;i<bytes.length;i+=16){
            if(bytes[i]+bytes[i+1]+bytes[i+2]>120)lit++;
            colors.add((bytes[i]>>4)*256+(bytes[i+1]>>4)*16+(bytes[i+2]>>4));
          }
          return {id,lit,colors:colors.size,error:gl.getError()};
        });
      });
      // A resting neural frame can be nearly monochrome; require detail, not fabricated color activity.
      for(const sample of samples){assert.equal(sample.error,0);assert(sample.lit>100,JSON.stringify(sample));assert(sample.colors>8,JSON.stringify(sample));}
      return samples;
    };
    await page.goto(target.href);
    await page.waitForFunction(()=>(window as any).__housefly?.snapshot().ready,null,{timeout:120_000});
    await page.waitForFunction(()=>(window as any).__housefly.snapshot().recentDecisions.some((d:any)=>d.executed),null,{timeout:60_000});
    await page.locator("#autoplayButton").click();
    await expect(page.locator("#replayButton")).toBeEnabled();
    const executed=await snapshot();
    assert.equal(executed.mode,"neural"); assert(executed.neural.totalSpikes>0); assert(executed.neural.tick>0);
    assert(executed.recentDecisions.filter((d:any)=>d.executed).every((d:any)=>d.source==="neural"&&d.tick>0));
    assert.deepEqual(oddsRequests,[]);
    assert(await page.evaluate(()=>Object.isFrozen((window as any).__housefly.snapshot().recentDecisions)));
    const desktopPixels=await renderedCanvases();
    await page.screenshot({path:`${output}/1920x1080.png`,fullPage:true});
    const layout=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,traceBottom:document.querySelector("#brainTrace")!.getBoundingClientRect().bottom,provenance:document.querySelector("#controllerProvenance")!.textContent}));
    assert.equal(layout.overflow,false); assert(layout.traceBottom<1080,`Decision trace ends at ${layout.traceBottom}`);
    const beforeReplay=await snapshot();
    await page.locator("#replayButton").click();
    const afterReplay=await snapshot(); assert.deepEqual(afterReplay,beforeReplay);
    await expect(page.locator("#brainStatus")).toContainText("Recorded decision");
    await page.evaluate(()=>(window as any).__housefly.silence(true));
    const silent=await snapshot(); assert.equal(silent.silenced,true); assert.equal(silent.neural.spikeCount,0);
    await page.waitForTimeout(1200); assert.deepEqual(await snapshot(),silent);
    await page.evaluate(()=>(window as any).__housefly.silence(false));
    // Start an advance, then ablate before it can issue or execute a new action.
    if ((await snapshot()).game.status!=="playing") await page.locator("#dealButton").click();
    if ((await snapshot()).game.status==="playing") {
      const beforeCancel=await snapshot();
      await page.evaluate(()=>{document.querySelector<HTMLButtonElement>("#flyButton")!.click();void (window as any).__housefly.silence(true);});
      await page.waitForTimeout(1200);
      assert.deepEqual((await snapshot()).recentDecisions,beforeCancel.recentDecisions);
      await page.evaluate(()=>(window as any).__housefly.silence(false));
    }
    // Complete a fresh neural-only round and check persisted credit.
    if ((await snapshot()).game.status==="playing") {await page.locator("#standButton").click();await expect(page.locator("#dealButton")).toBeEnabled();}
    const previousEpisodes=(await snapshot()).neural.episodes;
    await page.locator("#playSpeed").selectOption("4");
    await page.locator("#autoplayButton").click();
    await page.waitForFunction((n)=>(window as any).__housefly.snapshot().neural.episodes>n,previousEpisodes,{timeout:60_000});
    await page.locator("#autoplayButton").click(); await expect(page.locator("#replayButton")).toBeEnabled();
    const learned=await snapshot();
    await page.reload(); await page.waitForFunction(()=>(window as any).__housefly?.snapshot().ready,null,{timeout:120_000});
    assert.equal((await snapshot()).neural.episodes,learned.neural.episodes);
    await page.locator("#autoplayButton").click();
    await page.locator("#controllerMode").selectOption("odds");
    if ((await snapshot()).game.status!=="playing") await page.locator("#dealButton").click();
    await expect(page.locator("#backendStatus")).not.toHaveText("Evaluating",{timeout:20_000});
    assert(oddsRequests.length>0,"Only the explicitly selected baseline starts an odds worker");
    await page.locator("#controllerMode").selectOption("neural");
    await page.setViewportSize({width:390,height:844});
    await page.waitForFunction(()=>(window as any).__housefly.snapshot().ready);
    await page.locator("#brainCanvas").scrollIntoViewIfNeeded();
    await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
    const mobilePixels=await renderedCanvases();
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:`${output}/390x844.png`,fullPage:true});
    assert.deepEqual(errors,[]);
    const failedPage=await browser.newPage();
    await failedPage.route("**/neural/manifest.json",route=>route.abort());
    await failedPage.goto(target.href);
    await expect(failedPage.locator("#controllerStatus")).toContainText("Neural model unavailable",{timeout:20_000});
    const failed=await failedPage.evaluate(()=>(window as any).__housefly.snapshot());
    assert.equal(failed.ready,false); assert.equal(failed.game.round,0); assert.deepEqual(failed.recentDecisions,[]);
    await failedPage.close();
    await writeFile(`${output}/verification.json`,JSON.stringify({executed,silent,learned,layout,desktopPixels,mobilePixels,errors,oddsRequests},null,2));
  } finally {await browser.close();}
});

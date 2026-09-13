import "./styles.css";
import { activities, activeActivity } from "./activityCatalog";
import { createIcons, Layers, Plus, Hand, Play, Pause, RotateCcw, ChevronsUp, Split, Volume2, VolumeX } from "lucide";
import { createGame, createShuffledShoe, countShoe, handValue, ranks, dealRound, step, legalActions, chooseFromActions } from "./activities/blackjack";
import type { Card, Action, ActionScore } from "./activities/blackjack";
import type { Odds } from "./activities/blackjackOdds";
import { ConnectomeView } from "./connectomeView";
import { CasinoScene } from "./casinoScene";
import { CasinoAudio } from "./casinoAudio";
import { AsyncNeuralRuntime } from "./neural/client";
import type { NeuralFrame } from "./neural/client";
import { NeuralReadout } from "./neural/policy";
import type { ReadoutDecision } from "./neural/policy";
import { BLACKJACK_ACTIONS, BLACKJACK_ENCODER, BlackjackNeuralController, restoreBlackjackReadout, saveBlackjackReadout } from "./activities/blackjackNeural";
import type { BlackjackNeuralChoice } from "./activities/blackjackNeural";

interface DecisionSnapshot {
  id: number; actor: "Neural" | "Odds baseline" | "Manual"; observation: string; odds: Odds | null;
  action: Action; scores: ActionScore[]; margin: number; outcome: string;
  round: number; executed: boolean; neural?: BlackjackNeuralChoice;
}

function get<T extends Element = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as unknown as T;
}
const runSeed = Number(new URLSearchParams(location.search).get("seed") ?? crypto.getRandomValues(new Uint32Array(1))[0]) >>> 0;
function randomStream(seed: number): () => number {
  return () => { seed = (Math.imul(seed,1664525)+1013904223) >>> 0; return seed/4294967296; };
}
const gameRandom = randomStream(runSeed);
const policyRandom = randomStream(runSeed ^ 0xcafebabe);
const tableView = new CasinoScene(get<HTMLCanvasElement>("scene"));
const brainView = new ConnectomeView(get<HTMLCanvasElement>("brainCanvas"));
const audio = new CasinoAudio();
const deckCount = get<HTMLSelectElement>("deckCount");
const noiseSlider = get<HTMLInputElement>("noiseSlider");
const historySelect = get<HTMLSelectElement>("traceHistory");
const paceSelect = get<HTMLSelectElement>("playSpeed");
const controllerMode = get<HTMLSelectElement>("controllerMode");
const learnReadout = get<HTMLInputElement>("learnReadout");
const silenceNeural = get<HTMLInputElement>("silenceNeural");
const history: DecisionSnapshot[] = [];
let game = createGame(1, gameRandom);
let requestedDecks = 1;
let currentOdds: Odds | null = null;
let requestId = 0;
let worker: Worker | null = null;
let oddsPending = false;
let busy = false;
let autoplay = new URLSearchParams(location.search).get("autoplay") !== "0";
let autoTimer = 0;
let playVersion = 0;
let decisionId = 0;
let celebratedRound = 0;
let neuralRuntime: AsyncNeuralRuntime | null = null;
let neuralController: BlackjackNeuralController | null = null;
let neuralLoading = true;
let neuralError = "";
let neuralControlPending = false;
let latestNeuralFrame: NeuralFrame | null = null;
let neuralLatencyMs = 0;
let storageStatus = "";
const isNeural = () => controllerMode.value === "neural";
const neuralBlocked = () => !neuralController || neuralLoading || neuralControlPending || !!neuralError || silenceNeural.checked || !!neuralRuntime?.silenced;
brainView.setNeuralPending();

const icons = { Layers, Plus, Hand, Play, Pause, RotateCcw, ChevronsUp, Split, Volume2, VolumeX };
createIcons({ icons });
const activitySelect = get<HTMLSelectElement>("activitySelect");
for (const activity of activities) activitySelect.add(new Option(activity.title, activity.id));
activitySelect.addEventListener("change", () => {
  const next = activities.find(activity => activity.id === activitySelect.value);
  if (next && next.id !== activeActivity.id) location.assign(next.href);
});
get("activityBadge").textContent = activeActivity.title;
get("dealButton").addEventListener("click", deal);
for (const action of ["Hit", "Stand", "Double", "Split"] as Action[]) {
  get(`${action.toLowerCase()}Button`).addEventListener("click", () => manualMove(action));
}
get("flyButton").addEventListener("click", () => void flyMove());
get("autoplayButton").addEventListener("click", () => setAutoplay(!autoplay));
get("soundButton").addEventListener("click", async () => {
  const button = get<HTMLButtonElement>("soundButton");
  button.disabled = true;
  const enabled = await audio.toggle();
  button.disabled = false;
  const label = enabled ? "Mute sound effects" : "Enable sound effects";
  button.setAttribute("aria-pressed", String(enabled));
  button.setAttribute("aria-label", label); button.title = label;
  const icon = document.createElement("i"); icon.dataset.lucide = enabled ? "volume-2" : "volume-x";
  button.replaceChildren(icon); createIcons({ icons });
});
get("resetBrain").addEventListener("click", () => brainView.reset());
get<HTMLSelectElement>("brainMode").addEventListener("change", event => {
  const mode = (event.target as HTMLSelectElement).value;
  brainView.setMode(mode); get<HTMLElement>("brainLegend").hidden = mode !== "activity";
});
get<HTMLInputElement>("showEdges").addEventListener("change", event => brainView.setEdges((event.target as HTMLInputElement).checked));
historySelect.addEventListener("change", () => {
  setAutoplay(false);
  const snapshot = history.find(item => item.id === Number(historySelect.value));
  if (snapshot) showRecorded(snapshot);
});
get("replayButton").addEventListener("click", () => {
  const snapshot = history.find(item => item.id === Number(historySelect.value));
  if (snapshot && !busy && !autoplay) showRecorded(snapshot);
});
deckCount.addEventListener("change", () => {
  requestedDecks = Number(deckCount.value);
  if (game.status !== "playing" && !busy) applyDecks();
  renderDom();
});
noiseSlider.addEventListener("input", () => {
  get<HTMLOutputElement>("noiseValue").value = (Number(noiseSlider.value)/100).toFixed(2);
});
paceSelect.addEventListener("change", () => scheduleAuto(300));
controllerMode.addEventListener("change", () => {
  setAutoplay(false); neuralController?.discard(); invalidateOdds();
  if (isNeural()) showNeuralState();
  else { brainView.setIllustrativeMode(); refreshOdds(); }
  renderDom();
});
learnReadout.addEventListener("change", () => { neuralController?.discard(); renderDom(); });
silenceNeural.addEventListener("change", () => { void silenceController(silenceNeural.checked); });
get("resetReadout").addEventListener("click", () => {
  setAutoplay(false); neuralController?.discard();
  if (!neuralRuntime) return;
  neuralController = makeController(neuralRuntime);
  // A reset midway through a hand cannot claim that hand's credit.
  neuralController.beginRound(game.round,false);
  storageStatus = saveBlackjackReadout(neuralController.readout,readoutStorage()) ? "Saved locally" : "Session only";
  renderDom();
});
setAutoplay(autoplay);
requestAnimationFrame(tick);
scheduleAuto(850);
void initializeNeural();

function readoutStorage(): Storage | null { try { return localStorage; } catch { return null; } }
function makeController(runtime: AsyncNeuralRuntime): BlackjackNeuralController {
  return new BlackjackNeuralController(runtime,new NeuralReadout({actions:BLACKJACK_ACTIONS,
    modelId:`${runtime.graph.modelId}/${BLACKJACK_ENCODER}`,seed:runSeed ^ 0x51f15e,features:128}));
}

async function initializeNeural(): Promise<void> {
  try {
    neuralRuntime = await AsyncNeuralRuntime.create(runSeed);
    neuralController = makeController(neuralRuntime);
    const restored = restoreBlackjackReadout(neuralController.readout,readoutStorage());
    storageStatus = restored === "restored" ? "Restored locally" : restored === "incompatible" ? "Incompatible save ignored" : restored === "unavailable" ? "Session only" : "No saved readout";
    neuralController.beginRound(game.round,false);
    if (silenceNeural.checked) await neuralRuntime.silence(true);
    await brainView.ready;
    latestNeuralFrame = await neuralRuntime.snapshot();
    neuralLoading = false;
    if (isNeural()) showNeuralState();
    renderDom(); scheduleAuto(250);
  } catch (error) { neuralLoading = false; failNeural(error); }
}

function showFrame(frame: NeuralFrame, label: string): void {
  brainView.setNeuralActivity(frame,{label,modelId:neuralRuntime?.graph.modelId,edgeCount:neuralRuntime?.graph.edgeCount,
    detail:"Actual LIF voltage and spikes; engineered sensory input and learned readout"});
}
function showNeuralState(): void {
  if (neuralError || !latestNeuralFrame) brainView.setNeuralPending(neuralError || "Loading neural model");
  else showFrame(latestNeuralFrame,latestNeuralFrame.silenced ? "Neurons silenced" : "Recorded LIF voltage and spikes");
}
function failNeural(error: unknown): void {
  neuralError = error instanceof Error ? error.message : String(error);
  neuralController?.discard();
  if (isNeural()) { setAutoplay(false); brainView.setNeuralPending(`Neural model unavailable: ${neuralError}`); }
  renderDom();
}

async function silenceController(enabled: boolean): Promise<void> {
  if (typeof enabled !== "boolean") throw new Error("Expected a boolean silence flag");
  silenceNeural.checked = enabled;
  setAutoplay(false); neuralController?.discard();
  neuralControlPending = true; renderDom();
  try {
    if (neuralRuntime) {
      await neuralRuntime.silence(enabled);
      latestNeuralFrame = await neuralRuntime.snapshot();
      if (isNeural()) showNeuralState();
    }
  } catch (error) { failNeural(error); }
  finally { neuralControlPending = false; renderDom(); }
}

window.addEventListener("pagehide", () => {
  autoplay = false; playVersion++; window.clearTimeout(autoTimer);
  void neuralRuntime?.dispose().catch(() => {});
});

const houseflyTelemetry = Object.freeze({
  snapshot: () => Object.freeze({
    mode: isNeural() ? "neural" : "odds",
    ready: !!neuralController && !neuralLoading && !neuralError && !neuralControlPending,
    silenced: silenceNeural.checked || !!neuralRuntime?.silenced,
    game: Object.freeze({round:game.round,status:game.status,reward:game.reward,bankroll:game.bankroll}),
    neural: Object.freeze({tick:latestNeuralFrame?.tick ?? 0,simulatedMs:latestNeuralFrame?.simulatedMs ?? 0,
      totalSpikes:latestNeuralFrame?.totalSpikes ?? 0,spikeCount:latestNeuralFrame?.spikes.length ?? 0,
      updates:neuralController?.readout.updates ?? 0,episodes:neuralController?.readout.episodes ?? 0,latencyMs:neuralLatencyMs}),
    recentDecisions: Object.freeze(history.map(snapshot=>Object.freeze({id:snapshot.id,action:snapshot.action,
      source:snapshot.actor === "Neural" ? "neural" : snapshot.actor === "Manual" ? "manual" : "odds",
      tick:snapshot.neural?.frame.tick ?? null,simulatedMs:snapshot.neural?.frame.simulatedMs ?? null,
      executed:snapshot.executed,outcome:snapshot.outcome}))),
  }),
  silence: silenceController,
});
Object.defineProperty(window,"__housefly",{value:houseflyTelemetry,writable:false,configurable:false});

function speed(): number { return Number(paceSelect.value); }
function delay(ms: number): Promise<void> { return new Promise(resolve => window.setTimeout(resolve, ms)); }
function formatEv(value: number): string { return `${value >= 0 ? "+" : ""}${value.toFixed(3)}`; }
function percent(value: number): string { return `${Math.round(value*100)}%`; }
function handLabel(cards: Card[]): string {
  const hand = handValue(ranks(cards));
  return hand.bust ? "Bust" : `${hand.total}${hand.soft ? " soft" : ""}`;
}

function setAutoplay(enabled: boolean): void {
  autoplay = enabled;
  window.clearTimeout(autoTimer);
  if (!enabled) {
    playVersion++;
    if (history[0]?.outcome === "Pending") {
      history[0].outcome = "Paused before action.";
      renderSnapshot(history[0], 3);
    }
    get("actionCue").textContent = "Paused";
  } else scheduleAuto(250);
  brainView.setPaused(!enabled);
  const button = get("autoplayButton");
  button.replaceChildren();
  const icon = document.createElement("i"); icon.dataset.lucide = enabled ? "pause" : "play";
  const label = document.createElement("span"); label.textContent = enabled ? "Pause fly" : "Resume fly";
  button.append(icon,label); createIcons({ icons });
  renderDom();
}

function scheduleAuto(ms = 900/speed()): void {
  window.clearTimeout(autoTimer);
  if (!autoplay) return;
  autoTimer = window.setTimeout(() => {
    if (busy || (isNeural() ? neuralLoading || neuralControlPending : oddsPending)) { scheduleAuto(100); return; }
    if (isNeural() && neuralBlocked()) { setAutoplay(false); return; }
    if (game.status !== "playing") { deal(); scheduleAuto(game.status === "resolved" ? resultHold() : 1000/speed()); }
    else if (isNeural() || currentOdds) void flyMove();
    else setAutoplay(false);
  }, ms);
}

function applyDecks(): void {
  if (requestedDecks === game.decks) return;
  invalidateOdds();
  game.decks = requestedDecks;
  game.shoe = createShuffledShoe(requestedDecks, gameRandom);
  game.shuffles++;
}

function invalidateOdds(): void {
  requestId++; worker?.terminate(); worker = null; oddsPending = false; currentOdds = null;
}

function deal(): void {
  if (busy || game.status === "playing") return;
  applyDecks();
  dealRound(game, gameRandom);
  neuralController?.beginRound(game.round,isNeural() && learnReadout.checked);
  audio.deal();
  refreshOdds();
  if (!isNeural()) { brainView.setIllustrativeMode(); brainView.setPhase(0); }
  get("drivePhase").textContent = "Observe";
  get("actionCue").textContent = game.result || "Observing";
  renderDom();
}

function applyMove(action: Action, neural?: ReadoutDecision): void {
  invalidateOdds();
  step(game, action);
  if (neural) neuralController?.recordExecuted(game.round,neural);
  if (neuralController?.settle(game,learnReadout.checked)) {
    storageStatus = saveBlackjackReadout(neuralController.readout,readoutStorage()) ? "Saved locally" : "Session only";
  }
  if (game.status === "playing") refreshOdds();
  renderDom();
}

function manualMove(action: Action): void {
  if (autoplay || busy || !legalActions(game).includes(action)) return;
  neuralController?.discard();
  const snapshot = capture(action, "Manual", [], 0);
  void playTrace(snapshot, true, false);
}

async function flyMove(): Promise<void> {
  if (busy || (isNeural() ? neuralBlocked() : oddsPending)) return;
  if (game.status !== "playing") { deal(); scheduleAuto(); return; }
  if (isNeural()) { await neuralMove(); return; }
  if (!currentOdds) return;
  const allowed = legalActions(game);
  const values = Object.fromEntries(Object.entries(currentOdds.values).filter(([action]) => allowed.includes(action as Action)));
  const choice = chooseFromActions(values, Number(noiseSlider.value)/100, policyRandom);
  const snapshot = capture(choice.action, "Odds baseline", choice.scores, choice.margin);
  await playTrace(snapshot, true, autoplay);
}

async function neuralMove(): Promise<void> {
  const controller = neuralController!;
  const version = ++playVersion;
  const automatic = autoplay;
  const round = game.round;
  const valid = () => version === playVersion && isNeural() && !neuralBlocked() && game.round === round && (!automatic || autoplay);
  busy = true;
  get("drivePhase").textContent = "Integrating";
  get("actionCue").textContent = "LIF response";
  renderDom();
  try {
    const started = performance.now();
    const choice = await controller.decide(game,frame=>{
      latestNeuralFrame = frame;
      showFrame(frame,"Live action-generating LIF state");
    },valid);
    neuralLatencyMs = performance.now()-started;
    if (!valid()) return;
    if (!choice) {
      get("controllerStatus").textContent = "No neural output; action withheld";
      game.message = "No neural output; action withheld. Resume to sample another response.";
      setAutoplay(false); return;
    }
    const snapshot = capture(BLACKJACK_ACTIONS[choice.decision.index],"Neural",[],0);
    snapshot.neural = choice;
    await executeSnapshot(snapshot,version,automatic);
  } catch (error) {
    if (version === playVersion) failNeural(error);
  } finally { finishOperation(version); }
}

function capture(action: Action, actor: DecisionSnapshot["actor"], scores: ActionScore[], margin: number): DecisionSnapshot {
  const snapshot: DecisionSnapshot = {
    id: ++decisionId, actor, observation: `Hand ${game.activeHand+1}: ${game.player.map(c=>c.face).join(" + ")} = ${handLabel(game.player)}; dealer ${game.dealer[0].face}; ${game.shoe.length} unseen.`,
    odds: actor === "Odds baseline" || (!isNeural() && actor === "Manual") ? currentOdds : null,
    action, scores, margin, outcome: "Pending", round: game.round, executed: false
  };
  history.unshift(snapshot);
  if (history.length > 12) history.pop();
  historySelect.replaceChildren(...history.map(item=>new Option(`#${item.id} ${item.actor}: ${item.action}`,String(item.id))));
  historySelect.value = String(snapshot.id);
  return snapshot;
}

async function playTrace(snapshot: DecisionSnapshot, execute: boolean, automatic: boolean): Promise<void> {
  const version = ++playVersion;
  busy = true;
  brainView.setPaused(false);
  if (!isNeural()) brainView.setIllustrativeMode();
  renderDom();
  try {
    for (let phase = 0; phase < (isNeural() ? 0 : 3); phase++) {
      if (version !== playVersion || (automatic && !autoplay)) return;
      brainView.setPhase(phase,snapshot.action);
      get("drivePhase").textContent = ["Observe","Evaluate","Select","Act"][phase];
      get("actionCue").textContent = phase === 3 ? snapshot.action : ["Observing","Evaluating","Choosing"][phase];
      renderSnapshot(snapshot, phase);
      await delay(300/speed());
    }
    if (execute) await executeSnapshot(snapshot,version,automatic);
  } finally { finishOperation(version); }
}

async function executeSnapshot(snapshot: DecisionSnapshot, version: number, automatic: boolean): Promise<void> {
  const valid = () => version === playVersion && (!automatic || autoplay) && (!snapshot.neural || !neuralBlocked());
  if (!valid()) return;
  if (snapshot.neural) showFrame(snapshot.neural.frame,"LIF frame selected for this action");
  get("drivePhase").textContent = snapshot.neural ? "Motor" : "Act";
  get("actionCue").textContent = snapshot.action;
  renderSnapshot(snapshot,3);
  renderDom();
  const duration = 850/speed();
  tableView.gesture(snapshot.action,duration);
  await delay(duration*0.55);
  if (!valid() || !legalActions(game).includes(snapshot.action)) {
    snapshot.outcome = "Cancelled before execution"; return;
  }
  audio.action(snapshot.action);
  snapshot.executed = true;
  applyMove(snapshot.action,snapshot.neural?.decision);
  snapshot.outcome = game.message;
  renderSnapshot(snapshot,3);
  await delay(duration*0.45);
}

function finishOperation(version: number): void {
  busy = false;
  if (version === playVersion) {
    if (!isNeural()) brainView.setPhase(-1);
    get("drivePhase").textContent = "Rest";
    get("actionCue").textContent = game.result || (autoplay ? "Observing" : "Paused");
  }
  brainView.setPaused(!autoplay);
  renderDom();
  scheduleAuto(game.status === "resolved" ? resultHold() : 650/speed());
}

function showRecorded(snapshot: DecisionSnapshot): void {
  if (snapshot.neural) showFrame(snapshot.neural.frame,`Recorded decision #${snapshot.id} / ${snapshot.executed ? "executed" : "not executed"}`);
  else brainView.setNeuralPending(`${snapshot.actor} decision / no recorded neural frame`);
  renderSnapshot(snapshot,3);
}

function renderSnapshot(snapshot: DecisionSnapshot, phase: number): void {
  if (snapshot.neural) {
    const {frame,decision,scores} = snapshot.neural;
    const lines = [
      `Observe: ${snapshot.observation}`,
      `LIF: step ${frame.tick}; ${frame.simulatedMs.toFixed(1)} ms; ${frame.spikes.length.toLocaleString()} spikes in the final 20 ms.`,
      `Readout: 128 recorded rate features; ${BLACKJACK_ACTIONS.map((action,i)=>`${action} ${percent(decision.probabilities[i])} (logit ${scores[i].toFixed(3)})`).join(" / ")}. Sampled ${snapshot.action}.`,
      `Act: ${snapshot.executed ? "Executed" : "Not executed"}. ${snapshot.outcome}`,
    ];
    get("brainTrace").replaceChildren(...lines.map(text=>{const li=document.createElement("li");li.textContent=text;return li;}));
    get("nextCards").replaceChildren();
    get("decisionStats").textContent = `#${snapshot.id} / Neural LIF / ${neuralRuntime?.graph.modelId ?? ""} / fixed recurrent weights`;
    return;
  }
  const odds = snapshot.odds;
  const values = odds ? Object.entries(odds.values).map(([action,value])=>`${action} ${formatEv(value)}`).join(" / ") : "unavailable";
  const selected = snapshot.scores.find(score=>score.action===snapshot.action);
  const lines = [
    `Observe: ${snapshot.observation}`,
    `Evaluate: ${values}.`,
    snapshot.actor === "Manual" ? `Select: manual ${snapshot.action}.` : `Select: ${snapshot.action}; noise ${formatEv(selected?.jitter ?? 0)}; score gap ${formatEv(snapshot.margin)}.`,
    `Act: ${snapshot.outcome}`
  ];
  get("brainTrace").replaceChildren(...lines.map((text,index)=>{
    const li=document.createElement("li");li.textContent=text;li.dataset.state=index<phase?"complete":index===phase?"active":"pending";return li;
  }));
  get("nextCards").replaceChildren();
  if (odds) {
    for (const branch of odds.nextCards) {
      const item=document.createElement("div");item.className=`next-card ${branch.bust?"bust":"safe"}`;item.style.setProperty("--probability",percent(branch.probability));
      const label=document.createElement("strong");label.textContent=branch.rank==="10"?"10/J/Q/K":branch.rank;
      const probability=document.createElement("span");probability.textContent=percent(branch.probability);
      const outcome=document.createElement("small");outcome.textContent=branch.bust?"Bust":`Total ${branch.total}`;
      item.append(label,probability,outcome);get("nextCards").append(item);
    }
    get("decisionStats").textContent=`#${snapshot.id} / ${Math.round(odds.elapsedMs)} ms / ${odds.method} values / next-card bust ${percent(odds.bustProbability)}`;
  } else get("decisionStats").textContent = `#${snapshot.id} / Manual / no neural selection or learning credit`;
}

function refreshOdds(): void {
  invalidateOdds();
  if (isNeural() || game.status !== "playing") return;
  oddsPending = true;
  get("backendStatus").textContent="Evaluating";
  const id=requestId;
  worker=new Worker(new URL("./activities/blackjack.worker.ts",import.meta.url),{type:"module"});
  worker.onmessage=(event: MessageEvent<{id:number;odds?:Odds;error?:string}>)=>{
    if(event.data.id!==requestId||game.status!=="playing")return;
    oddsPending=false;currentOdds=event.data.odds??null;worker?.terminate();worker=null;
    if(!currentOdds){game.message=event.data.error??"Odds unavailable.";setAutoplay(false);}
    renderDom();
  };
  worker.onerror=()=>{if(id!==requestId)return;invalidateOdds();game.message="Odds unavailable. Manual controls remain available.";setAutoplay(false);renderDom();};
  const allowed=legalActions(game);
  worker.postMessage({id,player:ranks(game.player),dealer:game.dealer[0].rank,shoe:countShoe(game.shoe),
    options:{allowDouble:allowed.includes("Double"),allowSplit:allowed.includes("Split"),fromSplit:game.hands[game.activeHand].fromSplit,
      round:{hands:game.hands.map(hand=>({...hand,cards:ranks(hand.cards)})),activeHand:game.activeHand}}});
}

function renderDom(): void {
  renderResult();
  const neural = isNeural();
  const odds=neural ? null : currentOdds??(game.status!=="playing"?history[0]?.odds:null);
  const choice=history.find(snapshot=>snapshot.round===game.round && snapshot.neural)?.neural;
  const legal=legalActions(game);
  get("playerTotal").textContent=handLabel(game.player);
  get("dealerTotal").textContent=game.dealer.length?handLabel(game.dealer):"0";
  get("shoeDepth").textContent=`${game.shoe.length} / ${game.decks*52}`;
  get("sessionScore").textContent=`${game.bankroll>=0?"+":""}${game.bankroll} units / Hand ${game.round} / Shuffle ${game.shuffles}`;
  get("statusLine").textContent=game.message;
  get("recommendation").textContent=neural ? game.result || (neuralBlocked() ? neuralLoading ? "Loading neural model" : "Neural action withheld" : choice ? `Sampled ${choice.decision.action}` : "Awaiting neural response") : oddsPending?"Evaluating":game.result||currentOdds?.recommendation||"Observing";
  get("decisionLabel").textContent = neural ? "Neural action probabilities" : "Odds baseline / decision values";
  get("backendStatus").textContent=neural ? "128 recorded rate features" : oddsPending?"Evaluating":odds?.method==="exact"?"Exact odds worker":odds?.method==="mixed"?"Exact + split estimate":odds?.method==="sampled"?"Split-round estimates":"Ready";
  for(const action of ["Hit","Stand","Double","Split"] as Action[]){
    const value=odds?.values[action];
    const el=get(`${action.toLowerCase()}Ev`);
    el.parentElement!.querySelector("span")!.textContent = neural ? action : `${action} EV`;
    el.textContent=neural ? choice ? percent(choice.decision.probabilities[BLACKJACK_ACTIONS.indexOf(action)]) : "--" : value===undefined?"--":`${odds?.errors[action]!==undefined?"~":""}${formatEv(value)}`;
    el.title=neural ? "Sampled policy probability from the recorded neural rates" : odds?.errors[action]!==undefined?`95% Monte Carlo sampling interval +/- ${odds.errors[action]!.toFixed(3)}; frozen-composition continuation policy.`:"";
    el.parentElement!.dataset.chosen=String(action===(neural ? choice?.decision.action : currentOdds?.recommendation??history[0]?.action));
    get<HTMLButtonElement>(`${action.toLowerCase()}Button`).disabled=autoplay||busy||!legal.includes(action);
  }
  get("oddsMethod").textContent=neural ? "Sampled neural readout / legal-action mask / no EV inputs" : !odds?"":odds.method==="exact"?"Exact finite-shoe values / units per initial stake"
    :odds.method==="mixed"?`Hit, Stand, Double exact / Split: 16,000 rollouts, +/- ${odds.errors.Split?.toFixed(3)} (95% sampling interval)`
    :"Coupled split-round estimates / 16,000 rollouts per action / includes both hands";
  get<HTMLButtonElement>("dealButton").disabled=autoplay||busy||game.status==="playing";
  get<HTMLButtonElement>("flyButton").disabled=autoplay||busy||(neural ? neuralBlocked() : oddsPending||(game.status==="playing"&&!currentOdds));
  get("flyButton").querySelector("span")!.textContent=game.status==="playing"?"Fly decision":"Next hand";
  get<HTMLButtonElement>("replayButton").disabled=autoplay||busy||!history.length;
  historySelect.disabled=busy||!history.length;
  get("autoplayStatus").textContent=autoplay?"Autonomous play":"Paused";
  get("autoplayStatus").dataset.paused=String(!autoplay);
  get("autoplayButton").setAttribute("aria-pressed",String(autoplay));
  get<HTMLButtonElement>("autoplayButton").disabled = !autoplay && neural && (neuralLoading || neuralControlPending || !!neuralError || silenceNeural.checked);
  noiseSlider.disabled = neural;
  learnReadout.disabled = !neural;
  silenceNeural.disabled = !neural || neuralControlPending;
  get<HTMLButtonElement>("resetReadout").disabled = !neuralController || !neural;
  get("controllerStatus").textContent = neural ? neuralError ? `Neural model unavailable: ${neuralError}` : neuralLoading ? "Loading verified connectome LIF model" : silenceNeural.checked || neuralRuntime?.silenced ? "Neurons silenced / neural actions blocked" : neuralControlPending ? "Updating neural control" : `LIF ready / ${neuralRuntime?.graph.nodeCount.toLocaleString()} neurons / ${neuralRuntime?.graph.edgeCount.toLocaleString()} recurrent edges / ${Math.round(neuralLatencyMs)} ms response` : "Odds baseline / EV-selected actions / illustrative activity";
  const readout = neuralController?.readout;
  get("learningStatus").textContent = `${readout?.episodes ? `${readout.episodes} credited rounds / ${readout.updates} weight updates` : "Untrained readout"} / ${learnReadout.checked ? "learning enabled" : "learning off"} / fixed recurrent weights${storageStatus ? ` / ${storageStatus}` : ""}`;
  get("controllerProvenance").textContent = neural ? "Connectome LIF / engineered sensory encoding and trainable readout / fixed recurrent weights" : "Odds baseline / real anatomy / illustrative activity";
  get("settingsStatus").textContent=requestedDecks!==game.decks?`${requestedDecks} decks queued for the next hand.`:"";
  const summaries=game.hands.map((hand,index)=>{
    const el=document.createElement("div");el.className=`hand-summary ${game.activeHand===index?"active":""}`;
    el.textContent=`H${index+1} / ${hand.cards.map(card=>card.face).join(" ")} / ${hand.bet} unit${hand.bet===1?"":"s"}${hand.reward!==null?` / ${hand.reward>=0?"+":""}${hand.reward}`:""}`;
    return el;
  });
  get("handsReadout").replaceChildren(...summaries);
}

function resultHold(): number { return Math.max(1600, 3000/speed()); }

function renderResult(): void {
  const banner = get<HTMLElement>("roundResult");
  banner.hidden = game.status !== "resolved";
  if (banner.hidden) return;
  const reward = game.reward ?? 0;
  const outcome = reward > 0 ? "win" : reward < 0 ? "loss" : "push";
  banner.dataset.outcome = outcome;
  get("resultEyebrow").textContent = `Hand ${game.round} / settled`;
  get("resultTitle").textContent = reward > 0 ? "Fly wins!" : reward < 0 ? "Dealer wins" : "Push";
  const natural = reward === 1.5 && game.hands.length === 1;
  get("resultReward").textContent = `${natural ? "Blackjack / " : ""}${reward > 0 ? "+" : ""}${reward} unit${Math.abs(reward) === 1 ? "" : "s"}${outcome === "win" ? " / The house got out-flyed." : ""}`;
  if (celebratedRound !== game.round) {
    celebratedRound = game.round;
    if (reward > 0) tableView.celebrate();
    audio.result(reward);
  }
}

function tick(now:number):void{tableView.render(game,now);brainView.render(now);requestAnimationFrame(tick);}

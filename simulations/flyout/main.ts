import './style.css';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import * as Tone from 'tone';
import { createElement, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CircleDot, Clapperboard,
  Focus, Hand, House, Move, MoveHorizontal, Pause, Play, RotateCcw, Users, Volume2, VolumeX, X,
  type IconNode } from 'lucide';
import { applyResult, BASE_SECONDS, fixedSteps, isFair, newGame, resolveThrow, STEP, type PlateResult } from './game';
import { BASES, FieldScene, POSITIONS } from './scene';
import { loadDrosophilaTemplate } from '../../src/flyModel.ts';
import { ActivityConnectome } from '../../src/activityConnectome';
import { ACTOR_COUNT, BATTER_ACTOR, type Observation } from './neural-adapter';
import { NeuralBridge } from './neural-bridge';

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;
const icons: Record<string, IconNode> = { 'arrow-down': ArrowDown, 'arrow-left': ArrowLeft, 'arrow-right': ArrowRight,
  'arrow-up': ArrowUp, 'circle-dot': CircleDot, clapperboard: Clapperboard, focus: Focus, hand: Hand, house: House,
  move: Move, 'move-horizontal': MoveHorizontal, pause: Pause, play: Play, 'rotate-ccw': RotateCcw, users: Users,
  'volume-2': Volume2, 'volume-x': VolumeX, x: X };
document.querySelectorAll<HTMLElement>('[data-icon]').forEach(node => node.replaceWith(createElement(icons[node.dataset.icon!], { 'aria-hidden': 'true' })));
if (import.meta.env.PROD && import.meta.env.BASE_URL !== '/') {
  const backlink = $<HTMLAnchorElement>('#all-demos');
  backlink.href = import.meta.env.BASE_URL; backlink.hidden = false;
}

type Phase = 'ready' | 'pitch' | 'live' | 'holding' | 'throw' | 'result' | 'final';
type MoveKey = 'up' | 'down' | 'left' | 'right';
const teams = ['CHERRY', 'MINT'];
const batters = [['Ruby', 'Poppy', 'Rose', 'Scarlet', 'Berry'], ['Clover', 'Fern', 'Dew', 'Basil', 'Pip']];
const controller = new AbortController();
const signal = controller.signal;
let view: FieldScene | undefined;
let connectome: ActivityConnectome | undefined;
let connectomeReady = false;
let neural: NeuralBridge | undefined;
let layoutObserver: ResizeObserver | undefined;
let world: RAPIER.World | undefined;
let events: RAPIER.EventQueue | undefined;
let body: RAPIER.RigidBody;
let ballCollider: RAPIER.Collider;
let groundCollider: RAPIER.Collider;
const fielderBodies: RAPIER.RigidBody[] = [];
const sensorIndices = new Map<number, number>();
let score = newGame();
let phase: Phase = 'ready';
let phaseTime = 0;
let simTime = 0;
let liveTime = 0;
let pitchDuration = 1.3;
let pitchWild = false;
let swung = false;
let swingTime = -100;
let bounced = false;
let fairLanded = false;
let possessor: number | null = null;
let throwBase = 1;
let throwDuration = 0;
let autoplay = true;
let autoField = true;
let paused = false;
let soundEnabled = false;
let synth: Tone.Synth | undefined;
let audioPending: Promise<void> | undefined;
let disposed = false;
let frame = 0;
let lastFrame = 0;
let accumulator = 0;
let manualUntil = 0;
let reachUntil = 0;
let batterIndex = 0;
let playBatter = batters[0][0];
let activeChaser = 0;
let outcomeActor = -1;
let outcomeLabel = '';
let activityActor = -1;
let activityLabel = '';
let lastNeuralRequest = -100;
const actorVelocities = Array.from({ length: ACTOR_COUNT }, () => new THREE.Vector3());
const actorActions = Array.from({ length: ACTOR_COUNT }, () => ({ source: 'neural', action: 'Waiting' }));
let physicsSteps = 0;
let maximumSteps = 0;
let renderedFrames = 0;
let groundContacts = 0;
let catches = 0;
let throws = 0;
let manualMoves = 0;
let lastEvent = 'Play ball';
const recentPlays: string[] = [];
let seed = Number(new URLSearchParams(location.search).get('seed') ?? 7193) >>> 0;
const keys = new Set<MoveKey>();
const touchKeys = new Map<number, MoveKey>();
const actionButton = $<HTMLButtonElement>('#action');
const finalDialog = $<HTMLDialogElement>('#final-dialog');

function random(): number { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }

async function unlockAudio(): Promise<void> {
  if (!soundEnabled || disposed) return;
  if (audioPending) return audioPending;
  audioPending = (async () => {
    try {
      await Tone.start();
      if (disposed) return;
      synth ??= new Tone.Synth({ oscillator: { type: 'triangle' }, envelope: { attack: .004, decay: .09, sustain: .05, release: .1 }, volume: -19 }).toDestination();
    } catch {
      soundEnabled = false; updateSoundButton();
    } finally { audioPending = undefined; }
  })();
  return audioPending;
}

function sound(kind: 'hit' | 'catch' | 'score' | 'pitch'): void {
  if (!soundEnabled || !synth || Tone.getContext().state !== 'running') return;
  const note = { hit: 'C5', catch: 'G3', score: 'E5', pitch: 'C3' }[kind];
  synth.triggerAttackRelease(note, kind === 'score' ? '.3' : '.05', Tone.now() + .008);
}

function updateSoundButton(): void {
  const button = $('#sound'); button.setAttribute('aria-pressed', String(soundEnabled));
  button.setAttribute('aria-label', soundEnabled ? 'Mute sound' : 'Enable sound');
  button.title = soundEnabled ? 'Mute sound' : 'Enable sound';
  button.replaceChildren(createElement(soundEnabled ? Volume2 : VolumeX, { 'aria-hidden': 'true' }));
}

function call(title: string, detail: string): void {
  $('#call').textContent = title; $('#play-detail').textContent = detail;
  lastEvent = title;
}

function selected(index: number): void {
  if (!view) return;
  view.selected = index;
  $('#selected-name').textContent = POSITIONS[index].name;
  $('#selected-position').textContent = POSITIONS[index].role;
  $('#selected-tag span').textContent = POSITIONS[index].code;
  $('#selected-tag b').textContent = POSITIONS[index].name;
  document.querySelectorAll<HTMLButtonElement>('[data-fielder]').forEach(button => {
    button.setAttribute('aria-pressed', String(Number(button.dataset.fielder) === index));
  });
  $('#selected-tag').hidden = false;
}

function updateScore(): void {
  $('#away-score').textContent = String(score.runs[0]); $('#home-score').textContent = String(score.runs[1]);
  $('#inning-half').textContent = score.complete ? 'FINAL' : score.half ? 'BOT' : 'TOP';
  $('#inning').innerHTML = `${score.inning}<span>/3</span>`;
  $('#count').textContent = `${score.balls} - ${score.strikes}`;
  $('#phase-kicker').textContent = score.complete ? 'FINAL / THREE-INNING EXHIBITION' : `${score.half ? 'BOTTOM' : 'TOP'} ${score.inning} / ${teams[score.half]} AT BAT`;
  $('#defense-label').textContent = `${teams[1 - score.half]} / FIELDERS`;
  $('#batter-name').textContent = batters[score.half][batterIndex % 5];
  document.querySelectorAll('#out-lights i').forEach((node, i) => node.classList.toggle('active', i < score.outs));
  $('#out-lights').setAttribute('aria-label', `${score.outs} outs`);
  document.querySelectorAll('#base-lights i').forEach((node, i) => node.classList.toggle('active', score.bases[i]));
  $('#base-lights').setAttribute('aria-label', score.bases.some(Boolean) ? `Occupied bases: ${score.bases.map((occupied, i) => occupied ? i + 1 : '').filter(Boolean).join(', ')}` : 'Bases empty');
  view?.setTeams(score.half);
}

function setPhase(next: Phase): void {
  phase = next; phaseTime = 0;
  const label: Record<Phase, string> = { ready: 'Pitch', pitch: 'Swing', live: 'In play', holding: 'Throw', throw: 'In flight', result: 'Next pitch', final: 'New game' };
  actionButton.querySelector('span')!.textContent = label[next];
  actionButton.disabled = next === 'live' || next === 'throw' || next === 'holding';
  actionButton.querySelector('svg')?.replaceWith(createElement(next === 'ready' ? CircleDot : next === 'pitch' ? MoveHorizontal : next === 'final' ? RotateCcw : Play, { 'aria-hidden': 'true' }));
  document.querySelectorAll<HTMLButtonElement>('[data-base]').forEach(button => { button.disabled = next !== 'holding'; });
  $<HTMLButtonElement>('#catch').disabled = next !== 'live';
  $('#possession').textContent = next === 'holding' && possessor !== null ? POSITIONS[possessor].name : next === 'live' ? 'Ball in play' : next === 'throw' ? 'Throwing' : 'Ready';
  if (view) { view.landing.visible = next === 'live'; view.throwTarget.visible = next === 'throw'; }
}

function placeBall(position: THREE.Vector3, velocity = new THREE.Vector3(), gravity = 0): void {
  body.setTranslation(position, true); body.setLinvel(velocity, true); body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  body.setGravityScale(gravity, true); body.resetForces(true); body.resetTorques(true);
  view!.ball.position.copy(position); view!.ball.visible = true;
}

function ready(): void {
  possessor = null; swung = false; bounced = false; fairLanded = false; liveTime = 0;
  const previousBatter = playBatter;
  playBatter = batters[score.half][batterIndex % 5]; swingTime = -100;
  if (playBatter !== previousBatter) neural?.resetActor(BATTER_ACTOR, (seed + batterIndex * 8191 + score.half) >>> 0);
  actorActions[BATTER_ACTOR] = { source: autoplay ? 'neural' : 'manual', action: 'At bat' };
  view!.clearTrail(); view!.runners[0].group.visible = false;
  view!.batter.group.visible = true;
  placeBall(view!.fielders[0].group.position.clone().add(new THREE.Vector3(0, 1.65, 0)));
  setPhase('ready');
  call('Play ball.', `${POSITIONS[0].name} on the mound`);
}

function pitch(): void {
  if (paused || !view || phase !== 'ready') return;
  swung = false; pitchWild = random() < .2;
  const start = view.fielders[0].group.position.clone().add(new THREE.Vector3(0, 1.55, 0));
  const end = new THREE.Vector3(pitchWild ? (random() > .5 ? 1.5 : -1.5) : (random() - .5) * .35, 1.3, 12);
  pitchDuration = Math.max(.85, Math.min(1.7, start.distanceTo(end) / 7.2));
  const velocity = end.clone().sub(start).divideScalar(pitchDuration * .89);
  placeBall(start, velocity); view.clearTrail();
  setPhase('pitch'); call('Here it comes.', pitchWild ? 'Outside' : 'Fastball'); sound('pitch');
}

function swing(manual = true): void {
  if (paused || phase !== 'pitch' || swung) return;
  swung = true; swingTime = simTime;
  actorActions[BATTER_ACTOR] = { source: manual ? 'manual' : 'neural', action: 'Swing' };
  const error = phaseTime / pitchDuration - .89;
  const timing = Math.abs(error);
  if (timing > .115 || pitchWild) {
    call(error < 0 ? 'Early swing.' : 'Swing & miss.', 'Strike');
    resolve('strike', error < 0 ? 'Too early.' : 'Swing & miss.'); return;
  }
  const quality = Math.max(0, 1 - timing / .115);
  const spray = Number($<HTMLInputElement>('#aim').value) / 100;
  const angle = spray * .68 + error * 4.5;
  const speed = 13.5 + quality * 8;
  const lift = 4.5 + quality * (4 + random() * 6.2);
  const start = new THREE.Vector3(body.translation().x, 1.45, 11.8);
  placeBall(start, new THREE.Vector3(Math.sin(angle) * speed, lift, -Math.cos(angle) * speed), 1);
  bounced = false; fairLanded = false; liveTime = 0;
  view!.clearTrail(); view!.batter.group.visible = true; view!.runners[0].group.visible = true;
  view!.runners[0].moving = true;
  setPhase('live');
  call(quality > .78 ? 'Sweet contact.' : 'Ball in play.', quality > .78 ? 'Off the sweet spot' : 'The field is moving'); sound('hit');
}

function resolve(result: PlateResult, title?: string, actor = -1): void {
  if (!view || score.complete || phase === 'result') return;
  const oldHalf = score.half; const oldInning = score.inning; const oldRuns = score.runs[0] + score.runs[1];
  const oldScore = score;
  score = applyResult(score, result);
  if (score.strikes === 0 && score.balls === 0) batterIndex++;
  const changedSides = oldHalf !== score.half || oldInning !== score.inning;
  const runs = score.runs[0] + score.runs[1] - oldRuns;
  const headline = title ?? `${score.last.split(' / ')[0]}.`;
  outcomeActor = actor;
  outcomeLabel = `${actor >= 0 ? POSITIONS[actor].name : playBatter} / ${actor >= 0 && phase === 'live' ? 'Catch / Out' : headline}`;
  const reward = result === 'out' ? -1 : result === 'strike' ? -.35 : result === 'foul' ? -.1 : result === 'ball' ? .1 : result === 'homer' ? 1 : .6;
  neural?.reward(BATTER_ACTOR, reward);
  for (let index = 0; index < 9; index++) neural?.reward(index, -reward);
  recentPlays.push(headline); if (recentPlays.length > 30) recentPlays.shift();
  setPhase(score.complete ? 'final' : 'result');
  call(score.complete ? 'Final out.' : headline, runs ? `${teams[oldHalf]} scores ${runs} / ${score.runs[0]} - ${score.runs[1]}` : changedSides ? `${teams[score.half]} coming to bat` : result === 'out' ? `${score.outs} out${score.outs === 1 ? '' : 's'} / runners hold` : `${score.last}${result === 'foul' && oldScore.strikes === 2 ? ' / two strikes' : ''}`);
  body.setLinvel({ x: 0, y: 0, z: 0 }, true); body.setGravityScale(0, true);
  possessor = null; view.clearTrail(); view.runners[0].group.visible = false; view.batter.group.visible = true;
  if (changedSides) view.resetFielders();
  updateScore();
  if (runs) sound('score');
  if (score.complete) showFinal();
}

function collect(index: number): void {
  if (phase !== 'live' || !view || liveTime < .16 || !catchIntent(index)) return;
  const p = body.translation();
  if (!fairLanded && !isFair(p.x, p.z)) { resolve('foul', 'Foul ball.'); return; }
  if (!bounced) {
    catches++; sound('catch'); resolve('out', `${POSITIONS[index].name} makes the catch!`, index); return;
  }
  possessor = index; selected(index); setPhase('holding');
  call(`${POSITIONS[index].name} has it.`, liveTime < BASE_SECONDS ? 'Play at first' : 'Runner is safe at first');
  placeBall(view.fielders[index].group.position.clone().add(new THREE.Vector3(.4, 1.2, .3)));
  sound('catch');
}

function throwTo(base: number, manual = true): void {
  if (paused || phase !== 'holding' || possessor === null || !view) return;
  const start = view.fielders[possessor].group.position.clone().add(new THREE.Vector3(.4, 1.5, .3));
  const target = BASES[base].clone(); target.y = .65;
  throwDuration = Math.max(.22, start.distanceTo(target) / 27);
  const velocity = target.clone().sub(start).divideScalar(throwDuration);
  velocity.y += .5 * 13 * throwDuration;
  throwBase = base; throws++;
  actorActions[possessor] = { source: manual ? 'manual' : 'neural', action: `Throw ${base === 4 ? 'home' : `${base}B`}` };
  placeBall(start, velocity, 1); view.clearTrail();
  view.throwTarget.position.set(target.x, .08, target.z);
  setPhase('throw'); call(`Throw to ${base === 4 ? 'home' : `${base}B`}.`, `${POSITIONS[possessor].name} lets it fly`);
}

function reach(): void {
  if (paused || phase !== 'live' || !view) return;
  reachUntil = simTime + .6;
  manualUntil = simTime + 1.4;
  actorActions[view.selected] = { source: 'manual', action: 'Reach' };
  const fly = view.fielders[view.selected].group.position;
  const p = body.translation();
  if (Math.hypot(fly.x - p.x, fly.z - p.z) < 2.1 && p.y < 3.5) collect(view.selected);
}

function updateAim(): void {
  const value = Number($<HTMLInputElement>('#aim').value);
  $('#aim-value').textContent = value < -25 ? 'LF' : value > 25 ? 'RF' : 'CF';
}

function runnerAt(progress: number): THREE.Vector3 {
  const step = Math.min(3, Math.floor(progress)); const fraction = Math.min(1, progress - step);
  return BASES[step].clone().lerp(BASES[step + 1], fraction);
}

function moveFielders(): void {
  if (!view) return;
  const x = (keys.has('right') ? 1 : 0) - (keys.has('left') ? 1 : 0);
  const y = (keys.has('down') ? 1 : 0) - (keys.has('up') ? 1 : 0);
  const hasManual = x !== 0 || y !== 0;
  if (hasManual) { manualUntil = simTime + 1.4; manualMoves++; }
  const position = body.translation();
  view.landing.position.set(position.x, .07, position.z);
  let mostMotion = 0;
  if (hasManual || reachUntil > simTime || !autoField) activeChaser = view.selected;
  view.fielders.forEach((fly, i) => {
    const before = fly.group.position.clone(); let direction: THREE.Vector3 | undefined;
    if (i === view!.selected && hasManual) {
      direction = view!.movementVector(x, y); actorActions[i] = { source: 'manual', action: 'Move' };
    } else if (autoField && !(i === view!.selected && simTime < manualUntil)) {
      const command = neural?.command(i);
      if (command?.source === 'neural') {
        direction = new THREE.Vector3(command.x, 0, command.z);
        actorActions[i] = { source: 'neural', action: command.reach ? 'Reach' : direction.lengthSq() ? 'Move' : 'Hold' };
        if (phase === 'pitch' || phase === 'live' || phase === 'holding' || phase === 'throw') neural!.recordApplied(i, ['movement']);
        if (phase === 'live') neural!.recordApplied(i, ['handling']);
      } else actorActions[i] = { source: 'neural', action: neural?.silenced ? 'Silenced' : 'No motor output' };
    }
    if (direction?.lengthSq()) {
      fly.group.position.addScaledVector(direction, STEP * (i === view!.selected && hasManual ? 7 : 5.8));
      fly.group.position.x = THREE.MathUtils.clamp(fly.group.position.x, -25, 25);
      fly.group.position.z = THREE.MathUtils.clamp(fly.group.position.z, -20, 16);
      fly.group.rotation.y = Math.atan2(direction.x, direction.z);
    }
    fly.moving = before.distanceToSquared(fly.group.position) > .00001;
    fly.reaching = catchIntent(i);
    fly.throwing = phase === 'throw' && possessor === i;
    actorVelocities[i].copy(fly.group.position).sub(before).divideScalar(STEP);
    const motion = actorVelocities[i].lengthSq();
    if (motion > mostMotion && !hasManual && reachUntil <= simTime) { mostMotion = motion; activeChaser = i; }
    const p = fly.group.position;
    fielderBodies[i].setNextKinematicTranslation({ x: p.x, y: 1.22, z: p.z });
  });
}

function catchIntent(index: number): boolean {
  return index === view?.selected && reachUntil > simTime
    || Boolean(autoField && !(index === view?.selected && simTime < manualUntil) && neural?.command(index).reach);
}

function fixedUpdate(): void {
  if (!world || !view || !events) return;
  simTime += STEP; phaseTime += STEP;
  if (phase === 'live' || phase === 'holding' || phase === 'throw') liveTime += STEP;
  moveFielders();
  if (phase === 'ready') {
    placeBall(view.fielders[0].group.position.clone().add(new THREE.Vector3(0, 1.65, 0)));
    if (autoplay && neural?.state === 'ready' && phaseTime > 1.2) pitch();
  } else if (phase === 'pitch') {
    const command = neural?.command(BATTER_ACTOR);
    if (autoplay && command?.source === 'neural' && !swung) {
      $<HTMLInputElement>('#aim').value = String(command.aim * 100); updateAim();
      actorActions[BATTER_ACTOR] = { source: 'neural', action: command.swing ? 'Swing' : 'Wait' };
      neural!.recordApplied(BATTER_ACTOR, ['swing', 'aim']);
      if (command.swing) swing(false);
    }
    if (phase === 'pitch' && phaseTime >= pitchDuration * 1.13) resolve(pitchWild ? 'ball' : 'strike', pitchWild ? 'Ball outside.' : 'Called strike.');
  } else if (phase === 'holding' && possessor !== null) {
    placeBall(view.fielders[possessor].group.position.clone().add(new THREE.Vector3(.4, 1.3, .3)));
    if (autoField && !(possessor === view.selected && simTime < manualUntil)) {
      const command = neural?.command(possessor);
      if (command?.source === 'neural') {
        neural!.recordApplied(possessor, ['handling']);
        if (command.throwBase) throwTo(command.throwBase, false);
      }
    }
  } else if (phase === 'throw' && phaseTime >= throwDuration) {
    const result = resolveThrow(throwBase, liveTime); resolve(result, result === 'out' ? 'Out at first!' : undefined, possessor ?? -1);
  } else if (phase === 'result' && autoplay && phaseTime > 1.8) ready();

  world.step(events); physicsSteps++;
  events.drainCollisionEvents((a, b, started) => {
    if (!started || phase !== 'live') return;
    const other = a === ballCollider.handle ? b : b === ballCollider.handle ? a : null;
    if (other === null) return;
    if (other === groundCollider.handle) {
      groundContacts++;
      const p = body.translation();
      if (!bounced && !isFair(p.x, p.z)) { resolve('foul', 'Foul ball.'); return; }
      bounced = true; fairLanded = true;
    } else if (sensorIndices.has(other)) collect(sensorIndices.get(other)!);
  });

  if (phase === 'live') {
    const p = body.translation(); const v = body.linvel();
    if (!bounced && p.y <= .27 && v.y <= 0) {
      if (!isFair(p.x, p.z)) resolve('foul', 'Foul ball.');
      else { bounced = true; fairLanded = true; }
    }
    if (phase === 'live' && !bounced && Math.hypot(p.x, p.z - 12) > 32.3) {
      if (!isFair(p.x, p.z)) resolve('foul', 'Foul ball.');
      else if (p.y > 1.95) resolve('homer', 'Out of the orchard!');
    }
    if (phase === 'live') {
      // Recheck overlapping sensors so a low ball can be picked up after its first bounce.
      view.fielders.forEach((fly, i) => {
        if (catchIntent(i) && Math.hypot(fly.group.position.x - p.x, fly.group.position.z - p.z) < 2.1
          && p.y < 3.5 && (bounced || v.y < 0)) collect(i);
      });
      if (liveTime > BASE_SECONDS * 3.35 || p.y < -1 || Math.abs(p.x) > 45 || p.z < -36 || p.z > 24) resolve(fairLanded || isFair(p.x, p.z) ? 'triple' : 'foul');
    }
  }
  if (phase === 'holding' && liveTime > BASE_SECONDS * 3.35) resolve('triple', undefined, possessor ?? -1);
  const p = body.translation(); view.ball.position.set(p.x, p.y, p.z);
  for (let i = 0; i < 3; i++) {
    const runner = view.runners[i + 1]; runner.group.visible = score.bases[i];
    runner.group.position.copy(BASES[i + 1]).add(new THREE.Vector3(.85, 0, .55));
  }
  if (phase === 'live' || phase === 'holding' || phase === 'throw') {
    view.batter.group.visible = simTime - swingTime < .45;
    const progress = Math.min(3, liveTime / BASE_SECONDS);
    const runner = view.runners[0]; runner.group.position.copy(runnerAt(progress));
    const next = runnerAt(Math.min(3.99, progress + .03));
    runner.group.rotation.y = Math.atan2(next.x - runner.group.position.x, next.z - runner.group.position.z);
    runner.moving = true;
  } else if (view) view.runners[0].moving = false;
}

function showFinal(): void {
  const winner = score.runs[0] === score.runs[1] ? 'A perfect tie.' : `${score.runs[0] > score.runs[1] ? 'Cherry' : 'Mint'} wins.`;
  $('#winner').textContent = winner; $('#final-score').textContent = `${score.runs[0]} - ${score.runs[1]}`;
  $('#line-score').innerHTML = `<thead><tr><th>TEAM</th><th>1</th><th>2</th><th>3</th><th>R</th><th>H</th></tr></thead><tbody>${teams.map((team, i) => `<tr><th>${team}</th>${score.innings[i].map(run => `<td>${run}</td>`).join('')}<td>${score.runs[i]}</td><td>${score.hits[i]}</td></tr>`).join('')}</tbody>`;
  finalDialog.showModal();
}

function reset(): void {
  if (!view || !world) return;
  finalDialog.close(); score = newGame(); batterIndex = 0; manualUntil = 0; reachUntil = 0;
  neural?.reset(seed); lastNeuralRequest = -100;
  keys.clear(); touchKeys.clear(); setPause(false); view.resetFielders(); updateScore(); ready();
}

function setPause(value: boolean): void {
  paused = value; accumulator = 0; keys.clear(); touchKeys.clear();
  neural?.pause(value);
  $('#pause-overlay').hidden = !paused;
  $('#pause').setAttribute('aria-pressed', String(paused));
  $('#pause').setAttribute('aria-label', paused ? 'Resume game' : 'Pause game');
  $('#pause').title = paused ? 'Resume game' : 'Pause game';
  $('#pause').replaceChildren(createElement(paused ? Play : Pause, { 'aria-hidden': 'true' }));
}

function action(): void {
  if (!world || !view || paused) return;
  void unlockAudio();
  if (phase === 'ready') pitch();
  else if (phase === 'pitch') swing();
  else if (phase === 'result') { ready(); pitch(); }
  else if (phase === 'final') reset();
}

function connectControls(): void {
  for (let i = 0; i < POSITIONS.length; i++) {
    const button = document.createElement('button'); button.dataset.fielder = String(i);
    button.textContent = POSITIONS[i].code; button.title = `${POSITIONS[i].name} / ${POSITIONS[i].role}`;
    button.setAttribute('aria-label', `${POSITIONS[i].name}, ${POSITIONS[i].role}`);
    button.setAttribute('aria-pressed', String(i === 0));
    button.addEventListener('click', () => selected(i), { signal }); $('#roster-buttons').append(button);
  }
  actionButton.addEventListener('click', action, { signal });
  $('#reset').addEventListener('click', reset, { signal });
  $('#play-again').addEventListener('click', reset, { signal });
  $('#close-final').addEventListener('click', () => finalDialog.close(), { signal });
  $('#pause').addEventListener('click', () => setPause(!paused), { signal });
  $('#resume').addEventListener('click', () => setPause(false), { signal });
  $('#sound').addEventListener('click', () => { soundEnabled = !soundEnabled; updateSoundButton(); void unlockAudio(); }, { signal });
  $('#follow').addEventListener('click', () => {
    if (!view) return; view.follow = !view.follow;
    $('#follow').setAttribute('aria-pressed', String(view.follow));
  }, { signal });
  $('#autoplay').addEventListener('change', event => {
    autoplay = (event.target as HTMLInputElement).checked;
    $<HTMLInputElement>('#aim').disabled = autoplay;
    actorActions[BATTER_ACTOR] = { source: autoplay ? 'neural' : 'manual', action: 'At bat' };
    void unlockAudio();
  }, { signal });
  $('#auto-field').addEventListener('change', event => {
    autoField = (event.target as HTMLInputElement).checked;
    for (let actor = 0; actor < 9; actor++) actorActions[actor] = { source: autoField ? 'neural' : 'manual', action: 'Waiting' };
  }, { signal });
  $('#silence-neural').addEventListener('change', event => neural?.silence((event.target as HTMLInputElement).checked), { signal });
  $('#aim').addEventListener('input', updateAim, { signal });
  $('#catch').addEventListener('click', reach, { signal });
  document.querySelectorAll<HTMLButtonElement>('[data-base]').forEach(button => button.addEventListener('click', () => throwTo(Number(button.dataset.base)), { signal }));
  $('#field').addEventListener('pointerup', event => {
    const picked = view?.pick(event.clientX, event.clientY); if (picked !== null && picked !== undefined) selected(picked);
  }, { signal });
  document.querySelectorAll<HTMLButtonElement>('[data-move]').forEach(button => {
    button.addEventListener('pointerdown', event => {
      event.preventDefault(); button.setPointerCapture(event.pointerId);
      const key = button.dataset.move as MoveKey; keys.add(key); touchKeys.set(event.pointerId, key);
    }, { signal });
    const release = (event: PointerEvent): void => { const key = touchKeys.get(event.pointerId); if (key) keys.delete(key); touchKeys.delete(event.pointerId); };
    button.addEventListener('pointerup', release, { signal }); button.addEventListener('pointercancel', release, { signal });
    button.addEventListener('lostpointercapture', release, { signal });
  });
  const movement: Record<string, MoveKey> = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right' };
  document.addEventListener('keydown', event => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement && (event.code === 'Space' || event.code === 'Enter') || finalDialog.open) return;
    if (movement[event.code]) { event.preventDefault(); keys.add(movement[event.code]); }
    if (event.repeat) return;
    if (event.code === 'Space') { event.preventDefault(); action(); }
    else if (event.code === 'KeyC') reach();
    else if (/^Digit[1-4]$/.test(event.code)) throwTo(Number(event.code.slice(-1)));
    else if (event.code === 'KeyP') setPause(!paused);
  }, { signal });
  document.addEventListener('keyup', event => { if (movement[event.code]) keys.delete(movement[event.code]); }, { signal });
  window.addEventListener('blur', () => { keys.clear(); touchKeys.clear(); }, { signal });
  document.addEventListener('visibilitychange', () => { if (document.hidden) setPause(true); }, { signal });
  $('#field').addEventListener('webglcontextlost', event => { event.preventDefault(); setPause(true); failure('The graphics context was interrupted. Reload to reopen the ballpark.'); }, { signal });
  selected(0);
}

function observeActors(): Observation[] {
  const ball = { ...body.translation() }, velocity = { ...body.linvel() };
  const runnerDistance = view!.runners[0].group.visible ? view!.runners[0].group.position.distanceTo(BASES[1]) : 0;
  return Array.from({ length: ACTOR_COUNT }, (_, actor) => {
    const batter = actor === BATTER_ACTOR;
    const position = batter ? view!.batter.group.position : view!.fielders[actor].group.position;
    const home = batter ? { x: -.55, y: 0, z: 12.15 } : { x: POSITIONS[actor].x, y: 0, z: POSITIONS[actor].z };
    return { ball, velocity, self: { x: position.x, y: position.y, z: position.z },
      selfVelocity: { x: actorVelocities[actor].x, y: 0, z: actorVelocities[actor].z }, home, phase,
      hasBall: !batter && possessor === actor, bounced, batter, runnerDistance, strikes: score.strikes, balls: score.balls };
  });
}

function updateNeuralStatus(): void {
  if (!neural) return;
  const available = neural.state === 'ready';
  const status = $('#neural-status');
  status.textContent = neural.state === 'error' ? 'Neural unavailable / manual only' : neural.label;
  status.title = neural.label;
  if (neural.calibration) {
    const heads = neural.calibration.heads;
    status.title = `Offline calibration: ${neural.calibration.trainingTrials} trials. Held-out accuracy: movement ${Math.round(heads.movement.accuracy * 100)}%, handling ${Math.round(heads.handling.accuracy * 100)}%, swing ${Math.round(heads.swing.accuracy * 100)}%, aim ${Math.round(heads.aim.accuracy * 100)}%. Experimental task interface, not validated fly cognition.`;
  }
  $<HTMLInputElement>('#autoplay').disabled = !available;
  $<HTMLInputElement>('#auto-field').disabled = !available;
  $<HTMLInputElement>('#silence-neural').disabled = !available;
  if (neural.state === 'error') {
    autoplay = false; autoField = false;
    $<HTMLInputElement>('#autoplay').checked = false; $<HTMLInputElement>('#auto-field').checked = false;
    $<HTMLInputElement>('#aim').disabled = false;
  }
  $('#app').dataset.neuralState = neural.state;
}

function updateActivity(): void {
  if (!view || !connectome) return;
  activityActor = phase === 'result' || phase === 'final' ? outcomeActor
    : phase === 'holding' || phase === 'throw' ? possessor ?? activeChaser
    : phase === 'live' && simTime - swingTime >= .45 ? activeChaser : -1;
  const actor = activityActor < 0 ? BATTER_ACTOR : activityActor;
  const name = activityActor < 0 ? playBatter : POSITIONS[activityActor].name;
  const actorAction = actorActions[actor];
  const neuralFrame = neural?.frame(actor);
  const available = Boolean(connectomeReady && neuralFrame && neural?.state === 'ready');
  view.setActivityVisible(available);
  connectome.element.dataset.neuralReady = String(available);
  view.activityActor = activityActor >= 0 ? view.fielders[activityActor].group : view.batter.group;
  $('#activity-tag').textContent = name;
  activityLabel = phase === 'result' || phase === 'final' ? outcomeLabel
    : `${name} / ${neuralFrame?.silenced ? 'Silenced' : `${actorAction.source === 'manual' ? 'Manual' : 'Neural'} ${actorAction.action.toLowerCase()}`}`;
  if (!available || !neuralFrame) {
    connectome.element.querySelector('.connectome-action')!.textContent = neural?.state === 'error' ? 'Neural controller unavailable' : 'Awaiting neural state';
    connectome.element.querySelector('.connectome-loading')!.textContent = neural?.state === 'ready' ? 'Awaiting neural state' : neural?.label ?? 'Loading neural model';
    return;
  }
  try {
    connectome.updateNeural(neuralFrame, { label: activityLabel,
      detail: `${neuralFrame.simulatedMs.toFixed(0)} ms neural time / ${neuralFrame.spikes.length} spikes`,
      paused: paused || score.complete, edgeCount: neural?.edgeCount, modelId: neural?.modelId });
  } catch (error) {
    neural?.stop(error instanceof Error ? error.message : 'Neural display failed.');
    view.setActivityVisible(false); connectome.element.dataset.neuralReady = 'false';
  }
}

function renderFrame(timestamp: number): void {
  if (disposed || !view) return;
  const delta = lastFrame ? Math.min(.1, (timestamp - lastFrame) / 1000) : STEP;
  lastFrame = timestamp;
  if (!paused && !score.complete) {
    const fixed = fixedSteps(accumulator, delta); accumulator = fixed.remainder; maximumSteps = Math.max(maximumSteps, fixed.steps);
    for (let i = 0; i < fixed.steps; i++) fixedUpdate();
  }
  const progress = phase === 'pitch' ? Math.min(1, phaseTime / pitchDuration) : 0;
  $('#timing-fill').style.width = `${progress * 100}%`; $('#timing-needle').style.left = `${progress * 99}%`;
  $('#timing').setAttribute('aria-valuenow', String(Math.round(progress * 100)));
  const swing = simTime - swingTime < .45 ? (simTime - swingTime) / .45 : 0;
  view.batter.swinging = swing > 0;
  if (!paused && !score.complete && timestamp - lastNeuralRequest >= 100) {
    neural?.advance(observeActors(), activityActor < 0 ? BATTER_ACTOR : activityActor); lastNeuralRequest = timestamp;
  }
  updateActivity();
  view.render(simTime, delta, !paused && ['pitch', 'live', 'throw'].includes(phase), swing, phase);
  if (connectome?.element.dataset.neuralReady === 'true') connectome.render();
  const brainPosition = view.activityPosition();
  const activityTag = $('#activity-tag');
  activityTag.style.left = `${brainPosition.x}px`; activityTag.style.top = `${brainPosition.y + brainPosition.height / 2 + 3}px`;
  activityTag.hidden = connectome?.element.dataset.neuralReady !== 'true';
  const tagPosition = view.project(view.fielders[view.selected].group.position.clone().add(new THREE.Vector3(0, 2.75, 0)));
  const tag = $('#selected-tag'); tag.style.left = `${tagPosition.x}px`; tag.style.top = `${tagPosition.y}px`;
  tag.hidden = activityActor === view.selected || !view.containsLabel(tagPosition.x, tagPosition.y, 90, 26)
    || Math.abs(tagPosition.x - brainPosition.x) < brainPosition.width / 2 + 50 && Math.abs(tagPosition.y - brainPosition.y) < brainPosition.height / 2 + 26;
  renderedFrames++;
  frame = requestAnimationFrame(renderFrame);
}

function failure(message: string): void {
  $('#loading').hidden = false; $('#loading').classList.add('error');
  $('#loading b').textContent = 'Ballpark unavailable'; $('#loading-detail').textContent = message;
  $('#retry').hidden = false;
}

function dispose(): void {
  if (disposed) return; disposed = true;
  cancelAnimationFrame(frame); controller.abort(); layoutObserver?.disconnect(); synth?.dispose();
  neural?.dispose(); connectome?.dispose(); view?.dispose(); events?.free(); world?.free();
  delete (window as unknown as { __flyout?: unknown }).__flyout;
}

async function initialize(): Promise<void> {
  let initTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    $('#loading-detail').textContent = 'Loading fly anatomy';
    await loadDrosophilaTemplate();
    if (disposed) return;
    view = new FieldScene($<HTMLCanvasElement>('#field'));
    connectome = new ActivityConnectome(view.renderer, { mount: $('#app'), className: 'flyout-connectome', title: 'CONNECTOME', neural: true });
    connectome.element.dataset.neuralReady = 'false';
    void connectome.ready.then(() => { connectomeReady = connectome?.element.dataset.ready === 'true'; });
    view.activityMount.add(connectome.createMiniature());
    view.setActivityVisible(false);
    layoutObserver = new ResizeObserver(() => view?.resize());
    [$('.roster'), $('.play-status'), $('.topbar'), connectome.element].forEach(element => layoutObserver!.observe(element));
    view.resize();
    view.render(0, 1, false, 0);
    $('#loading-detail').textContent = 'Starting ball physics';
    await Promise.race([RAPIER.init(), new Promise<never>((_, reject) => { initTimeout = setTimeout(() => reject(new Error('Physics startup timed out.')), 20000); })]);
    clearTimeout(initTimeout); if (disposed) return;
    world = new RAPIER.World({ x: 0, y: -13, z: 0 }); world.timestep = STEP;
    events = new RAPIER.EventQueue(true);
    groundCollider = world.createCollider(RAPIER.ColliderDesc.cuboid(70, .1, 70).setTranslation(0, -.1, 0).setFriction(.85).setRestitution(.27));
    body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1.65, 3).setCcdEnabled(true).setLinearDamping(.05).setGravityScale(0));
    ballCollider = world.createCollider(RAPIER.ColliderDesc.ball(.23).setDensity(.6).setRestitution(.4).setFriction(.75).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), body);
    view.fielders.forEach((_, i) => {
      const position = POSITIONS[i];
      const fielderBody = world!.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(position.x, 1.22, position.z));
      const sensor = world!.createCollider(RAPIER.ColliderDesc.ball(1.05).setSensor(true).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), fielderBody);
      fielderBodies.push(fielderBody); sensorIndices.set(sensor.handle, i);
    });
    for (let i = 0; i < 44; i++) {
      const angle = -Math.PI / 4 + (i + .5) / 44 * Math.PI / 2;
      world.createCollider(RAPIER.ColliderDesc.cuboid(.6, .9, .15).setTranslation(Math.sin(angle) * 32.6, .9, 12 - Math.cos(angle) * 32.6)
        .setRotation({ x: 0, y: Math.sin(-angle / 2), z: 0, w: Math.cos(-angle / 2) }).setRestitution(.5));
    }
    connectControls(); updateScore(); ready();
    neural = new NeuralBridge(seed, updateNeuralStatus); updateNeuralStatus();
    Object.defineProperty(window, '__flyout', { configurable: true, get: () => ({
      phase, phaseTime, pitchDuration, score: structuredClone(score), paused, autoplay, autoField, selected: view?.selected,
      physicsSteps, maximumSteps, renderedFrames, groundContacts, catches, throws, manualMoves, lastEvent, recentPlays: [...recentPlays],
      ball: { ...body.translation() }, fielders: view?.fielders.map(f => ({ x: f.group.position.x, z: f.group.position.z })),
      fieldPixels: view?.fielders.map(f => view!.project(f.group.position.clone().add(new THREE.Vector3(0, 1, 0)))),
      neural: neural ? { ...neural.snapshot(), worldMs: simTime * 1000 } : undefined,
      controlProvenance: { motors: 'neural unless explicitly manual', pitches: 'game engine', turns: 'game engine', physics: 'Rapier / arcade rules' },
      activity: { actor: activityActor, neuralActor: activityActor < 0 ? BATTER_ACTOR : activityActor,
        chaser: activeChaser, possessor, batter: playBatter, label: activityLabel,
        miniature: view?.activityPosition(), position: view?.activityActor.position.toArray(), connectome: connectome?.snapshot() },
      renderer: view?.renderer.info.render,
    }) });
    $('#loading').hidden = true; $('#field').dataset.ready = 'true'; frame = requestAnimationFrame(renderFrame);
  } catch (error) {
    clearTimeout(initTimeout);
    failure(error instanceof Error ? error.message : 'The field could not start.');
    dispose();
  }
}

$('#retry').addEventListener('click', () => location.reload());
window.addEventListener('pagehide', dispose, { once: true });
if (import.meta.hot) import.meta.hot.dispose(dispose);
void initialize();

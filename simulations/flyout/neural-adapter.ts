export const INPUT_COUNT = 32;
export const FEATURE_COUNT = 128;
export const NODE_COUNT = 139662;
export const ACTOR_COUNT = 10;
export const BATTER_ACTOR = 9;
export const MOVE_ACTIONS = ['hold', 'west', 'east', 'north', 'south', 'north-west', 'north-east', 'south-west', 'south-east'];
export const FIELD_ACTIONS = ['wait', 'reach', 'throw-first', 'throw-second', 'throw-third', 'throw-home'];
export const SWING_ACTIONS = ['wait', 'swing'];
export const AIM_ACTIONS = ['left', 'center', 'right'];
export type NeuralPhase = 'ready' | 'pitch' | 'live' | 'holding' | 'throw' | 'result' | 'final';

export interface Vector { x: number; y: number; z: number }

export interface Observation {
  ball: Vector;
  velocity: Vector;
  self: Vector;
  selfVelocity: Vector;
  home: Vector;
  phase: NeuralPhase;
  hasBall: boolean;
  bounced: boolean;
  batter: boolean;
  runnerDistance: number;
  strikes: number;
  balls: number;
}

// Structural boundary for the shared runtime; this module implements no neural dynamics.
export interface NeuralFrame {
  tick: number;
  simulatedMs: number;
  spikes: Uint32Array;
  rates: Float32Array;
  levels: Float32Array;
  totalSpikes: number;
  silenced: boolean;
}

export interface RuntimePort {
  advance(input: Float32Array, milliseconds: number): NeuralFrame;
  reset(seed?: number): void;
  silence(enabled: boolean): void;
  dispose(): void;
}

export interface NeuralDecision {
  action: string;
  index: number;
  probabilities: Float32Array;
  features: Float32Array;
  tick: number;
  simulatedMs: number;
  temperature: number;
}

export interface ReadoutPort {
  decide(frame: NeuralFrame): NeuralDecision | null;
  reinforce(decisions: NeuralDecision[], reward: number): void;
}

export type ReadoutHead = 'movement' | 'handling' | 'swing' | 'aim';
export interface ActorReadouts {
  ready: boolean;
  movement?: ReadoutPort;
  handling?: ReadoutPort;
  swing?: ReadoutPort;
  aim?: ReadoutPort;
}

interface DecisionRecord { head: ReadoutHead; decision: NeuralDecision }

export interface NeuralCommand {
  x: number;
  z: number;
  swing: boolean;
  aim: number;
  reach: boolean;
  throwBase: number;
  tick: number;
  source: 'neural' | 'silent' | 'unready' | 'fault';
}

export function neutralCommand(source: NeuralCommand['source'] = 'unready', tick = 0): NeuralCommand {
  return { x: 0, z: 0, swing: false, aim: 0, reach: false, throwBase: 0, tick, source };
}

const clamp = (value: number, low = 0, high = 1): number => Math.max(low, Math.min(high, value));

export function encodeObservation(observation: Observation, output = new Float32Array(INPUT_COUNT)): Float32Array {
  if (output.length !== INPUT_COUNT) throw new Error('Flyout requires 32 sensory channels.');
  const { ball, velocity, self, selfVelocity, home } = observation;
  const values = [ball.x, ball.y, ball.z, velocity.x, velocity.y, velocity.z, self.x, self.y, self.z,
    selfVelocity.x, selfVelocity.y, selfVelocity.z, home.x, home.z,
    observation.runnerDistance, observation.strikes, observation.balls];
  if (values.some(value => !Number.isFinite(value))) throw new Error('Non-finite Flyout observation.');
  output.fill(0);
  const pair = (channel: number, value: number, extent: number): void => {
    output[channel] = clamp(value / extent) * 150;
    output[channel + 1] = clamp(-value / extent) * 150;
  };
  pair(0, ball.x - self.x, 35); pair(2, ball.y - self.y, 18); pair(4, ball.z - self.z, 35);
  pair(6, velocity.x - selfVelocity.x, 32); pair(8, velocity.y - selfVelocity.y, 24);
  pair(10, velocity.z - selfVelocity.z, 32);
  pair(12, home.x - self.x, 30); pair(14, home.z - self.z, 30);
  output[16] = clamp((self.x + 25) / 50) * 150; output[17] = clamp((25 - self.x) / 50) * 150;
  output[18] = clamp((self.z + 20) / 36) * 150; output[19] = clamp((16 - self.z) / 36) * 150;
  const phases: NeuralPhase[] = ['ready', 'pitch', 'live', 'holding', 'throw', 'result'];
  const phase = phases.indexOf(observation.phase === 'final' ? 'result' : observation.phase);
  if (phase < 0) throw new Error('Unknown Flyout phase.');
  output[20 + phase] = 150;
  output[26] = observation.hasBall ? 150 : 0; output[27] = observation.bounced ? 150 : 0;
  output[28] = observation.batter ? 150 : 0; output[29] = clamp(observation.runnerDistance / 40) * 150;
  output[30] = clamp(observation.strikes / 3) * 150; output[31] = clamp(observation.balls / 4) * 150;
  return output;
}

export function decodeCommand(frame: NeuralFrame, readouts: ActorReadouts, decisions: DecisionRecord[] = []): NeuralCommand {
  if (!readouts.ready) return neutralCommand('unready', frame.tick);
  if (frame.silenced || frame.spikes.length === 0) return neutralCommand('silent', frame.tick);
  if (frame.rates.length !== FEATURE_COUNT || frame.levels.length !== NODE_COUNT
    || frame.rates.some(value => !Number.isFinite(value) || value < 0)) throw new Error('Invalid measured neural frame.');
  // Readouts see only the shared runtime's frame, never observations or teacher actions.
  const decide = (head: ReadoutHead, actions: string[]): number | null => {
    const decision = readouts[head]?.decide(frame);
    if (!decision) return null;
    if (!Number.isInteger(decision.index) || decision.index < 0 || decision.index >= actions.length
      || decision.action !== actions[decision.index] || decision.features.length !== FEATURE_COUNT
      || decision.tick !== frame.tick) throw new Error('Invalid Flyout readout decision.');
    decisions.push({ head, decision }); return decision.index;
  };
  const move = decide('movement', MOVE_ACTIONS), handling = decide('handling', FIELD_ACTIONS);
  const swing = decide('swing', SWING_ACTIONS), aim = decide('aim', AIM_ACTIONS);
  const directions = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];
  let [x, z] = move === null ? [0, 0] : directions[move];
  const magnitude = Math.max(1, Math.hypot(x, z)); x /= magnitude; z /= magnitude;
  return { x, z, swing: swing === 1, aim: aim === null ? 0 : aim - 1, reach: handling === 1,
    throwBase: handling !== null && handling >= 2 ? handling - 1 : 0, tick: frame.tick, source: 'neural' };
}

export class FlyoutNeuralDecoder {
  private frames: (NeuralFrame | undefined)[] = Array(ACTOR_COUNT).fill(undefined);
  protected commands = Array.from({ length: ACTOR_COUNT }, () => neutralCommand());
  protected readouts: ActorReadouts[] = [];
  private pending: DecisionRecord[][] = Array.from({ length: ACTOR_COUNT }, () => []);
  private history: DecisionRecord[][] = Array.from({ length: ACTOR_COUNT }, () => []);
  protected faults: (string | null)[] = Array(ACTOR_COUNT).fill(null);
  protected disposed = false;

  constructor(createReadouts: (actor: number) => ActorReadouts) {
    this.readouts = Array.from({ length: ACTOR_COUNT }, (_, actor) => createReadouts(actor));
  }

  accept(actor: number, frame: NeuralFrame): void {
    if (this.disposed || this.faults[actor]) return;
    try {
      this.frames[actor] = frame;
      const decisions: DecisionRecord[] = [];
      this.commands[actor] = decodeCommand(frame, this.readouts[actor], decisions);
      this.pending[actor].push(...decisions);
      if (this.pending[actor].length > 512) this.pending[actor].splice(0, this.pending[actor].length - 512);
    } catch (error) { this.reject(actor, error); }
  }

  protected reject(actor: number, error: unknown): void {
    this.faults[actor] = error instanceof Error ? error.message : 'Neural inference failed.';
    this.commands[actor] = neutralCommand('fault');
  }

  command(actor: number): Readonly<NeuralCommand> { return this.commands[actor] ?? neutralCommand('fault'); }
  frame(actor: number): NeuralFrame | undefined { return this.frames[actor]; }

  recordApplied(actor: number, heads: readonly ReadoutHead[], tick = this.commands[actor]?.tick): void {
    this.pending[actor] = this.pending[actor].filter(record => {
      if (!heads.includes(record.head) || record.decision.tick !== tick) return true;
      const sameHead = this.history[actor].filter(previous => previous.head === record.head);
      if (sameHead.length >= 256) this.history[actor].splice(this.history[actor].indexOf(sameHead[0]), 1);
      this.history[actor].push(record); return false;
    });
  }

  reward(actor: number, reward: number): void {
    if (!Number.isFinite(reward) || this.disposed) return;
    for (const head of ['movement', 'handling', 'swing', 'aim'] as const) {
      const decisions = this.history[actor].filter(record => record.head === head).map(record => record.decision);
      if (decisions.length) this.readouts[actor][head]?.reinforce(decisions, clamp(reward, -1, 1));
    }
    this.history[actor] = []; this.pending[actor] = [];
  }

  silence(enabled: boolean): void {
    if (this.disposed) return;
    this.commands.forEach((_, actor) => {
      this.commands[actor] = neutralCommand(enabled ? 'silent' : 'unready', this.frames[actor]?.tick);
      this.pending[actor] = [];
    });
  }

  reset(): void {
    if (this.disposed) return;
    this.frames.fill(undefined); this.faults.fill(null);
    this.history.forEach(records => { records.length = 0; }); this.pending.forEach(records => { records.length = 0; });
    this.commands = this.commands.map(() => neutralCommand());
  }

  resetActor(actor: number): void {
    this.frames[actor] = undefined; this.commands[actor] = neutralCommand(); this.faults[actor] = null;
    this.pending[actor] = []; this.history[actor] = [];
  }

  snapshot() {
    return { disposed: this.disposed, actors: this.commands.map((command, actor) => ({ actor,
      tick: this.frames[actor]?.tick ?? 0, simulatedMs: this.frames[actor]?.simulatedMs ?? 0,
      spikes: this.frames[actor]?.spikes.length ?? 0, totalSpikes: this.frames[actor]?.totalSpikes ?? 0,
      silenced: this.frames[actor]?.silenced ?? false, command: { ...command }, error: this.faults[actor] })) };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.frames.fill(undefined); this.commands = this.commands.map(() => neutralCommand());
  }
}

export class FlyoutNeuralController extends FlyoutNeuralDecoder {
  private runtimes: RuntimePort[] = [];
  private inputs = Array.from({ length: ACTOR_COUNT }, () => new Float32Array(INPUT_COUNT));

  constructor(createRuntime: (actor: number) => RuntimePort, createReadouts: (actor: number) => ActorReadouts) {
    super(createReadouts);
    try {
      for (let actor = 0; actor < ACTOR_COUNT; actor++) {
        const runtime = createRuntime(actor);
        if (this.runtimes.includes(runtime)) throw new Error('Each Flyout actor requires an independent neural runtime.');
        this.runtimes.push(runtime);
      }
    } catch (error) { this.dispose(); throw error; }
  }

  advance(observations: readonly Observation[], milliseconds: number, paused = false): void {
    if (this.disposed || paused) return;
    if (observations.length !== ACTOR_COUNT || !Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > 100) {
      this.commands = this.commands.map(() => neutralCommand('fault'));
      throw new Error('Invalid Flyout neural step.');
    }
    for (let actor = 0; actor < ACTOR_COUNT; actor++) {
      if (this.faults[actor]) continue;
      if (!this.readouts[actor].ready) { this.commands[actor] = neutralCommand(); continue; }
      try {
        this.accept(actor, this.runtimes[actor].advance(encodeObservation(observations[actor], this.inputs[actor]), milliseconds));
      } catch (error) { this.reject(actor, error); }
    }
  }

  override silence(enabled: boolean): void {
    if (this.disposed) return;
    this.runtimes.forEach(runtime => runtime.silence(enabled)); super.silence(enabled);
  }

  override reset(seed = 7193): void {
    if (this.disposed) return;
    this.runtimes.forEach((runtime, actor) => runtime.reset((seed + Math.imul(actor + 1, 104729)) >>> 0));
    super.reset();
  }

  override dispose(): void {
    if (this.disposed) return;
    this.runtimes.forEach(runtime => runtime.dispose()); super.dispose();
  }
}

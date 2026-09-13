import type { NeuralFrame, NeuralGraph } from './runtime.ts';
export type { NeuralFrame, NeuralGraph } from './runtime.ts';

type RequestBody =
  | { kind: 'create'; seed: number }
  | { kind: 'advance'; rates: Float32Array; milliseconds: number }
  | { kind: 'snapshot' }
  | { kind: 'reset'; seed?: number }
  | { kind: 'silence'; enabled: boolean }
  | { kind: 'dispose' };

/** Wire types only; the worker does not import or instantiate the client. */
export type NeuralWorkerRequest = RequestBody & { id: number; actor: number };
export type NeuralWorkerValue = { graph?: NeuralGraph } | NeuralFrame | undefined;
export type NeuralWorkerResponse =
  | { id: number; ok: true; value: NeuralWorkerValue }
  | { id: number; ok: false; error: { name: string; message: string } };

interface Job {
  request: NeuralWorkerRequest;
  resolve(value: NeuralWorkerValue): void;
  reject(error: Error): void;
  settled: boolean;
}

function errorWithName(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function checkSeed(seed: number): void {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('Neural seed must be a uint32');
}

function isFrameJob(job: Job): boolean {
  return job.request.kind === 'advance' || job.request.kind === 'snapshot';
}

function freezeMetadata(value: unknown): void {
  if (!value || typeof value !== 'object' || ArrayBuffer.isView(value) || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeMetadata(child);
  Object.freeze(value);
}

/** Exactly one request is sent to the worker at a time; queued work stays bounded here. */
class WorkerManager {
  private readonly worker: Worker;
  private readonly actors = new Set<number>();
  private readonly queue: Job[] = [];
  private current: Job | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextActor = 1;
  private nextRequest = 1;
  private graph: NeuralGraph | undefined;
  failure: Error | undefined;

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'male-cns-lif' });
    this.worker.onmessage = event => this.receive(event.data as NeuralWorkerResponse);
    this.worker.onerror = event => {
      event.preventDefault();
      this.terminate(new Error(`Neural worker failed: ${event.message || 'worker startup/execution error'}`));
    };
    this.worker.onmessageerror = () => this.terminate(new Error('Neural worker response could not be decoded'));
  }

  private requireLive(actor?: number): void {
    if (this.failure) throw this.failure;
    if (actor !== undefined && !this.actors.has(actor)) throw new Error('Neural actor has been disposed');
  }

  async create(seed: number): Promise<{ actor: number; graph: NeuralGraph }> {
    this.requireLive();
    if (this.actors.size >= 12) throw errorWithName('NeuralBusyError', 'Neural worker supports at most 12 actors');
    const actor = this.nextActor++;
    this.actors.add(actor);
    const value = await this.enqueue(actor, { kind: 'create', seed }, false) as { graph?: NeuralGraph };
    if (value?.graph && !this.graph) {
      this.graph = value.graph;
      freezeMetadata(this.graph);
    }
    if (!this.graph) {
      const error = new Error('Neural worker did not provide graph metadata');
      this.terminate(error);
      throw error;
    }
    return { actor, graph: this.graph };
  }

  frame(actor: number, body: RequestBody): Promise<NeuralFrame> {
    this.requireLive(actor);
    if (this.current?.request.actor === actor || this.queue.some(job => job.request.actor === actor)) {
      return Promise.reject(errorWithName('NeuralBusyError', 'This neural actor already has pending work'));
    }
    return this.enqueue(actor, body, false) as Promise<NeuralFrame>;
  }

  control(actor: number, body: RequestBody): Promise<void> {
    this.requireLive(actor);
    const queued = this.queue.find(job => job.request.actor === actor);
    const urgent = body.kind === 'dispose' || (body.kind === 'silence' && body.enabled);
    if (queued && !isFrameJob(queued) && !urgent) {
      return Promise.reject(errorWithName('NeuralBusyError', 'This neural actor already has a pending control'));
    }
    const cancelled = errorWithName('AbortError', `Neural frame/control superseded by ${body.kind}`);
    if (queued) {
      this.queue.splice(this.queue.indexOf(queued), 1);
      this.reject(queued, cancelled);
    }
    // A running WASM call finishes in the worker, but its result cannot drive a
    // motor after a main-thread user control has invalidated it.
    if (this.current?.request.actor === actor && isFrameJob(this.current)) this.reject(this.current, cancelled);
    return this.enqueue(actor, body, true) as Promise<void>;
  }

  private enqueue(actor: number, body: RequestBody, priority: boolean): Promise<NeuralWorkerValue> {
    const promise = new Promise<NeuralWorkerValue>((resolve, reject) => {
      const job: Job = { request: { ...body, id: this.nextRequest++, actor }, resolve, reject, settled: false };
      if (this.queue.length >= 12) {
        reject(errorWithName('NeuralBusyError', 'Neural worker queue is full'));
        return;
      }
      if (priority) this.queue.unshift(job); else this.queue.push(job);
    });
    this.pump();
    return promise;
  }

  private pump(): void {
    if (this.failure || this.current || !this.queue.length) return;
    const job = this.queue.shift()!;
    this.current = job;
    this.timer = setTimeout(() => this.terminate(new Error('Neural worker request timed out')),
      job.request.kind === 'create' ? 120_000 : 30_000);
    try {
      const transfer = job.request.kind === 'advance' ? [job.request.rates.buffer as ArrayBuffer] : [];
      this.worker.postMessage(job.request, transfer);
    } catch (error) {
      this.terminate(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private receive(response: NeuralWorkerResponse): void {
    if (this.failure) return;
    const job = this.current;
    if (!job || !response || response.id !== job.request.id || typeof response.ok !== 'boolean') {
      this.terminate(new Error('Unexpected neural worker response'));
      return;
    }
    if (!response.ok) {
      this.terminate(errorWithName(response.error.name, response.error.message));
      return;
    }
    clearTimeout(this.timer);
    this.current = undefined;
    if (job.request.kind === 'dispose') this.actors.delete(job.request.actor);
    if (!job.settled) { job.settled = true; job.resolve(response.value); }
    this.pump();
  }

  private reject(job: Job, error: Error): void {
    if (!job.settled) { job.settled = true; job.reject(error); }
  }

  terminate(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    clearTimeout(this.timer);
    this.worker.terminate();
    if (this.current) this.reject(this.current, error);
    for (const job of this.queue) this.reject(job, error);
    this.current = undefined;
    this.queue.length = 0;
    this.actors.clear();
  }
}

let sharedManager: WorkerManager | undefined;
let startupFailure: Error | undefined;
function manager(): WorkerManager {
  if (startupFailure) throw startupFailure;
  try { sharedManager ??= new WorkerManager(); }
  catch (error) {
    startupFailure = error instanceof Error ? error : new Error(String(error));
    throw startupFailure;
  }
  return sharedManager;
}

/** Explicit page shutdown. Failure is terminal; creating again does not silently restart. */
export function terminateNeuralWorker(reason = 'Neural worker terminated'): void {
  sharedManager?.terminate(new Error(reason));
}

export class AsyncNeuralRuntime {
  readonly graph: NeuralGraph;
  private readonly manager: WorkerManager;
  private readonly actor: number;
  private disposed = false;
  private silenceRequested = false;
  private controlRevision = 0;
  private disposal: Promise<void> | undefined;

  private constructor(owner: WorkerManager, actor: number, graph: NeuralGraph) {
    this.manager = owner;
    this.actor = actor;
    this.graph = graph;
  }

  static async create(seed: number): Promise<AsyncNeuralRuntime> {
    checkSeed(seed);
    const owner = manager();
    const { actor, graph } = await owner.create(seed);
    return new AsyncNeuralRuntime(owner, actor, graph);
  }

  /** Immediate motor gate: true before the worker has acknowledged silence. */
  get silenced(): boolean { return this.silenceRequested || this.disposed || !!this.manager.failure; }

  private requireLive(): void {
    if (this.disposed) throw new Error('Neural actor has been disposed');
    if (this.manager.failure) throw this.manager.failure;
  }

  async advance(rates: Float32Array, milliseconds: number): Promise<NeuralFrame> {
    this.requireLive();
    if (!(rates instanceof Float32Array) || rates.length !== 32 || !rates.every(rate => Number.isFinite(rate) && rate >= 0 && rate <= 150)
      || !Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 1000) {
      throw new Error('Expected 32 sensory rates in Hz [0,150] and duration in ms [0,1000]');
    }
    return this.manager.frame(this.actor, { kind: 'advance', rates: rates.slice(), milliseconds });
  }

  async snapshot(): Promise<NeuralFrame> {
    this.requireLive();
    return this.manager.frame(this.actor, { kind: 'snapshot' });
  }

  async reset(seed?: number): Promise<void> {
    this.requireLive();
    if (seed !== undefined) checkSeed(seed);
    await this.manager.control(this.actor, { kind: 'reset', seed });
  }

  async silence(enabled: boolean): Promise<void> {
    this.requireLive();
    if (typeof enabled !== 'boolean') throw new Error('Neural silence flag must be boolean');
    if (enabled) this.silenceRequested = true;
    const revision = ++this.controlRevision;
    await this.manager.control(this.actor, { kind: 'silence', enabled });
    if (revision === this.controlRevision) this.silenceRequested = enabled;
  }

  async dispose(): Promise<void> {
    if (!this.disposal) {
      this.disposed = true;
      this.disposal = Promise.resolve().then(() => this.manager.control(this.actor, { kind: 'dispose' }));
    }
    return this.disposal;
  }
}

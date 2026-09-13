import { NeuralRuntime } from './runtime.ts';
import type { NeuralFrame, NeuralGraph } from './runtime.ts';
import type { NeuralWorkerRequest, NeuralWorkerResponse, NeuralWorkerValue } from './client.ts';

// A local worker surface avoids adding the WebWorker DOM library to app types.
const worker = globalThis as unknown as {
  onmessage: ((event: MessageEvent<NeuralWorkerRequest>) => void) | null;
  postMessage(response: NeuralWorkerResponse, transfer?: Transferable[]): void;
  close(): void;
};
const actors = new Map<number, NeuralRuntime>();
let graph: NeuralGraph | undefined;
let sentGraph = false;
let busy = false;
let failed = false;

function ownedFrame(frame: NeuralFrame): NeuralFrame {
  return { ...frame, spikes: frame.spikes.slice(), counts: frame.counts.slice(), rates: frame.rates.slice(), levels: frame.levels.slice() };
}

function sendFrame(id: number, frame: NeuralFrame): void {
  worker.postMessage({ id, ok: true, value: frame }, [frame.spikes.buffer, frame.counts.buffer, frame.rates.buffer, frame.levels.buffer] as ArrayBuffer[]);
}

async function execute(request: NeuralWorkerRequest): Promise<void> {
  let value: NeuralWorkerValue;
  if (request.kind === 'create') {
    if (actors.size >= 12 || actors.has(request.actor)) throw new Error('Invalid neural actor creation');
    graph ??= await NeuralRuntime.load();
    actors.set(request.actor, new NeuralRuntime(graph, request.seed));
    value = sentGraph ? {} : { graph };
    // Graph metadata is cloned, not transferred: the actual graph and WASM stay
    // in this worker, and every actor here references that same immutable graph.
    worker.postMessage({ id: request.id, ok: true, value });
    sentGraph = true;
    return;
  }
  const runtime = actors.get(request.actor);
  if (!runtime) throw new Error('Neural actor does not exist');
  switch (request.kind) {
    case 'advance':
      sendFrame(request.id, ownedFrame(runtime.advance(request.rates, request.milliseconds)));
      return;
    case 'snapshot':
      sendFrame(request.id, runtime.snapshot());
      return;
    case 'reset':
      runtime.reset(request.seed);
      break;
    case 'silence':
      runtime.silence(request.enabled);
      break;
    case 'dispose':
      runtime.dispose();
      actors.delete(request.actor);
      break;
    default:
      throw new Error('Unknown neural worker operation');
  }
  worker.postMessage({ id: request.id, ok: true, value: undefined });
}

function fail(id: number, cause: unknown): void {
  if (failed) return;
  failed = true;
  const error = cause instanceof Error ? cause : new Error(String(cause));
  try {
    worker.postMessage({ id, ok: false, error: { name: error.name, message: error.message } });
  } finally {
    actors.clear();
    worker.close();
  }
}

worker.onmessage = event => {
  if (failed) return;
  const request = event.data;
  if (!request || !Number.isSafeInteger(request.id) || !Number.isSafeInteger(request.actor) || busy) {
    fail(request?.id ?? -1, new Error('Invalid or overlapping neural worker request'));
    return;
  }
  busy = true;
  void execute(request).then(() => { busy = false; }, error => fail(request.id, error));
};

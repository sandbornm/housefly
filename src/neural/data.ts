export interface NeuralArtifactPart { url: string; bytes: number; sha256: string }
export interface NeuralArtifact { bytes: number; sha256: string; shards: NeuralArtifactPart[] }
export interface NeuralMetadata {
  schemaVersion: number;
  modelId: string;
  nodeCount: number;
  edgeCount: number;
  inputGroups: number[][];
  outputGroups: number[][];
  parameters: { dtMs: number; [key: string]: number };
  artifacts: Record<string, NeuralArtifact>;
  wasm: NeuralArtifactPart;
  [key: string]: unknown;
}

export interface NeuralGraph {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly modelId: string;
  readonly inputGroups: number[][];
  readonly outputGroups: number[][];
  readonly displayIndices: Uint32Array;
  readonly metadata: NeuralMetadata;
}

export interface NeuralWasm extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  neural_graph_new(nodes: number, edges: number): number;
  neural_graph_buffer(graph: number, kind: number): number;
  neural_graph_finish(graph: number): number;
  neural_graph_abort(graph: number): void;
  neural_new(graph: number, seed: number): number;
  neural_free(runtime: number): void;
  neural_reset(runtime: number, seed: number): void;
  neural_silence(runtime: number, enabled: number): void;
  neural_advance(runtime: number, steps: number): number;
  neural_snapshot(runtime: number): void;
  neural_buffer(runtime: number, kind: number): number;
  neural_stat(runtime: number, kind: number): number;
}

export interface NeuralLoadOptions {
  /** Node fixture/training callers can supply file reads without a browser shim. */
  read?: (url: URL) => Promise<ArrayBuffer>;
}

const internals = new WeakMap<NeuralGraph, { wasm: NeuralWasm; handle: number }>();
export function neuralGraphInternals(graph: NeuralGraph): { wasm: NeuralWasm; handle: number } {
  const value = internals.get(graph);
  if (!value) throw new Error('Neural graph was not loaded by the verified loader');
  return value;
}

const cache = new Map<string, Promise<NeuralGraph>>();
const MAX_ASSET_BYTES = 16_000_000;

async function fetchBytes(url: URL): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Neural asset ${url}: HTTP ${response.status}`);
  return response.arrayBuffer();
}

async function verified(part: NeuralArtifactPart, root: URL, read: (url: URL) => Promise<ArrayBuffer>): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(part.bytes) || part.bytes < 1 || part.bytes >= MAX_ASSET_BYTES || !/^[a-f0-9]{64}$/.test(part.sha256)) {
    throw new Error('Invalid neural asset descriptor');
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(part.url)) throw new Error('Invalid neural asset path');
  const bytes = await read(new URL(part.url, root));
  if (bytes.byteLength !== part.bytes) throw new Error(`Neural asset size mismatch: ${part.url}`);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2, '0')).join('');
  if (hash !== part.sha256) throw new Error(`Neural asset SHA-256 mismatch: ${part.url}`);
  return bytes;
}

function validateGroups(groups: number[][], count: number, nodes: number, seen: Uint8Array): void {
  if (!Array.isArray(groups) || groups.length !== count) throw new Error('Invalid neural groups');
  for (const group of groups) {
    if (!Array.isArray(group) || group.length !== 16) throw new Error('Invalid neural group size');
    for (const node of group) {
      if (!Number.isInteger(node) || node < 0 || node >= nodes || seen[node]) throw new Error('Overlapping or invalid neural group');
      seen[node] = 1;
    }
  }
}

async function load(root: URL, options: NeuralLoadOptions): Promise<NeuralGraph> {
  const read = options.read ?? fetchBytes;
  const metadata = JSON.parse(new TextDecoder().decode(await read(new URL('manifest.json', root)))) as NeuralMetadata;
  if (metadata.schemaVersion !== 1 || metadata.modelId !== 'male-cns-v1-lif-dt02-w5-v1'
    || metadata.nodeCount !== 139662 || metadata.edgeCount !== 5536347 || metadata.parameters.dtMs !== 0.2) {
    throw new Error('Unsupported neural model manifest');
  }
  const seen = new Uint8Array(metadata.nodeCount);
  validateGroups(metadata.inputGroups, 32, metadata.nodeCount, seen);
  validateGroups(metadata.outputGroups, 128, metadata.nodeCount, seen);
  const wasmBytes = await verified(metadata.wasm, root, read);
  const module = await WebAssembly.compile(wasmBytes);
  if (WebAssembly.Module.imports(module).length !== 0) throw new Error('Neural WASM must have no external dependencies');
  const instance = await WebAssembly.instantiate(module, {});
  const wasm = instance.exports as NeuralWasm;
  if (!(wasm.memory instanceof WebAssembly.Memory)) throw new Error('Neural WASM ABI missing memory');
  const builder = wasm.neural_graph_new(metadata.nodeCount, metadata.edgeCount);
  if (!builder) throw new Error('Neural graph allocation failed');
  let consumed = false;
  try {
    const definitions: [string, number, number][] = [
      ['offsets', 0, (metadata.nodeCount + 1) * 4], ['targets', 1, metadata.edgeCount * 4],
      ['weights', 2, metadata.edgeCount * 4], ['inputs', 3, 512 * 4], ['pools', 4, metadata.nodeCount * 2],
    ];
    for (const [name, kind, expected] of definitions) {
      const descriptor = metadata.artifacts[name];
      if (!descriptor || descriptor.bytes !== expected || !Array.isArray(descriptor.shards)) throw new Error(`Invalid neural ${name} size`);
      let offset = 0;
      for (const part of descriptor.shards) {
        const bytes = await verified(part, root, read);
        if (offset + bytes.byteLength > expected) throw new Error(`Neural ${name} overflow`);
        new Uint8Array(wasm.memory.buffer, wasm.neural_graph_buffer(builder, kind) + offset, bytes.byteLength).set(new Uint8Array(bytes));
        offset += bytes.byteLength;
      }
      if (offset !== expected) throw new Error(`Incomplete neural ${name}`);
    }
    const inputs = new Uint32Array(wasm.memory.buffer, wasm.neural_graph_buffer(builder, 3), 512);
    const pools = new Uint16Array(wasm.memory.buffer, wasm.neural_graph_buffer(builder, 4), metadata.nodeCount);
    if (!metadata.inputGroups.flat().every((node, i) => inputs[i] === node)) throw new Error('Input group metadata mismatch');
    const expectedPools = new Uint16Array(metadata.nodeCount).fill(65535);
    metadata.outputGroups.forEach((group, p) => group.forEach(node => { expectedPools[node] = p; }));
    if (!pools.every((pool, i) => pool === expectedPools[i])) throw new Error('Output pool metadata mismatch');
    consumed = true;
    const handle = wasm.neural_graph_finish(builder);
    if (!handle) throw new Error('Neural graph topology validation failed');
    const graph: NeuralGraph = Object.freeze({ nodeCount: metadata.nodeCount, edgeCount: metadata.edgeCount,
      modelId: metadata.modelId, inputGroups: metadata.inputGroups, outputGroups: metadata.outputGroups,
      displayIndices: Uint32Array.from({ length: metadata.nodeCount }, (_, i) => i), metadata });
    for (const group of [...graph.inputGroups, ...graph.outputGroups]) Object.freeze(group);
    Object.freeze(graph.inputGroups); Object.freeze(graph.outputGroups);
    internals.set(graph, { wasm, handle });
    return graph;
  } catch (error) {
    if (!consumed) wasm.neural_graph_abort(builder);
    throw error;
  }
}

/** baseURL is the application/public root; assets are resolved under neural/. */
export function loadNeuralGraph(baseURL?: string | URL, options: NeuralLoadOptions = {}): Promise<NeuralGraph> {
  const configuredBase = baseURL ?? import.meta.env?.BASE_URL ?? '/';
  const origin = typeof location === 'undefined' ? 'http://localhost/' : location.href;
  const root = new URL('neural/', new URL(configuredBase, origin));
  if (options.read) return load(root, options);
  let pending = cache.get(root.href);
  if (!pending) {
    pending = load(root, options).catch(error => { cache.delete(root.href); throw error; });
    cache.set(root.href, pending);
  }
  return pending;
}

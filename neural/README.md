# MaleCNS Experimental LIF Runtime

This is an experimental threshold-pruned model of the **whole located and
classified MaleCNS v1.0 network**: **139,662 neurons and 5,536,347 directed edges**.
It is not the 60,000-edge display graph. It is not a complete connectome, a
physiologically validated brain, or evidence that these neurons naturally play
games, music, baseball, or fly a simulated drone. Demo sensory encoders and
learned behavioral readouts are separate from this crate.

[Prior work and claim boundaries](../docs/neural-control-priors.md) explains
how this differs from an anatomical visualization, a trained locomotion policy,
and a biologically validated brain-body model.

The runtime has real membrane and current states, threshold/reset events,
delayed signed synaptic propagation, and deterministic stochastic stimulation.
There are no phases, behavioral labels, policy weights, synthetic activations,
or fallback activities in the model. `NeuralFrame.rates` depends only on recorded
spikes in undriven output neurons.

## Run And Reproduce

From the repository root, using the existing project `.venv`:

```sh
.venv/bin/python neural/scripts/build_graph.py
rustup target add wasm32-unknown-unknown
cargo test --manifest-path neural/Cargo.toml
cargo build --manifest-path neural/Cargo.toml --release
cargo build --manifest-path neural/Cargo.toml --release --target wasm32-unknown-unknown --lib
.venv/bin/python neural/scripts/package_wasm.py
node neural/scripts/verify_runtime.ts
node neural/scripts/benchmark.ts
.venv/bin/pip install -r neural/reference/requirements.txt
.venv/bin/python neural/scripts/validate_brian2.py
```

Graph construction needs Polars (tested with 1.44.0) and the three original
Feather files in `data/raw`. The builder verifies all source SHA-256 hashes and
sizes against `data/raw/manifest.json`. It deliberately reads only annotation
columns `bodyId`, `type`, `superclass`, and `somaLocation`; an unrelated dictionary
column in the source cannot be decoded by a full-column read. No pandas is
required by any build or validation script. Rust/WASM has **zero external
dependencies**. `reference/model.py` is an unexecuted upstream source snapshot;
its pandas import does not make pandas a runtime or reference-test dependency.

`build_graph.py` recreates the manifest; run `package_wasm.py` after it to restore
the WASM descriptor and transfer measurements. Generated binary assets live in
`public/neural/`, with SHA-256 descriptors in its manifest. Each shard is at most
12,000,000 bytes, below the requested 16 MB ceiling. No assets have been deployed
by this work. Sites must explicitly copy/serve `public/neural` beneath their app
base, and their first fetch must be budgeted separately from display assets.

## API For Adapters And Training

Browser demos should use the async facade so the full network computation does
not block rendering:

```ts
import { AsyncNeuralRuntime } from './src/neural/client.ts';
const brain = await AsyncNeuralRuntime.create(42);
const frame = await brain.advance(new Float32Array(32).fill(50), 20);
// Only after this promise resolves may the readout use frame.rates.
await brain.silence(true);
await brain.reset(42);
await brain.silence(false);
await brain.dispose();
```

`AsyncNeuralRuntime` exposes the same `graph` fields as the synchronous API, but
this is a shared, frozen metadata clone with no WASM internals. Do not pass this
clone into the synchronous constructor. `advance`, `snapshot`, `reset`,
`silence`, and `dispose` return promises. Its returned frame arrays are owned
copies, transferred from the worker; historical frames and caller input arrays
are never detached or reused. The worker uses the existing `NeuralRuntime`
without changing the model, graph, or Node reference API.

One module-worker manager per page loads one immutable graph and permits up to
12 independent actors. It sends only one operation to the worker at a time and
keeps at most 12 queued operations. Each actor may have only one pending frame
request; overlapping `advance`/`snapshot` calls reject with `NeuralBusyError`.
Await a result before requesting its next model step. Controls are prioritized,
and an actor may have at most one queued control. Urgent silence/disposal may
supersede an older queued control. There is no unbounded worker message backlog.

Calling `silence(true)`, `reset()`, or `dispose()` immediately invalidates older
pending frames with `AbortError`. A currently executing WASM call can finish,
but its stale result is discarded. `brain.silenced` is a synchronous motor gate:
it becomes true immediately on requested silence, disposal, or terminal worker
failure. Unmute opens it only after the worker acknowledges the change. On user
silence, adapters must stop neural motor output immediately and must not reuse a
previous frame while awaiting the control acknowledgment. Treat `AbortError`
as canceled work, never as permission to apply an old readout. After silence is
acknowledged, `advance` returns the actual zero-activity, silenced model frame.

Runtime, load, protocol, worker-error, and message-decoding failures terminate
the worker and reject all waiting work, including pending disposal. Requests
also fail closed if a worker stops responding (120 s initial creation/load,
30 s per subsequent operation). No fallback or automatic restart occurs.
`terminateNeuralWorker(reason?)`, exported from `client.ts`, explicitly performs
the same terminal shutdown. Disposing the last actor retains the graph for later
creation on that page; terminal shutdown requires a new page/module lifecycle.
Renderer physics may continue during measured inference latency; only completed
causal model results may supply new neural decisions.

`node neural/scripts/verify_worker.mjs` starts a temporary isolated Vite server
and runs Chromium checks for one graph/worker, 12 actors, exact reference spike
sequence, responsive renderer heartbeat, owned transfers, queue bounds,
silence/reset/dispose cancellation, terminal rejection, nested `BASE_URL`, and
corrupt-asset failure. Results are in `fixtures/worker-report.json`.

The synchronous API remains available for Node reference/training and worker use:

```ts
import { NeuralRuntime } from './src/neural/runtime.ts';
import type { NeuralFrame, NeuralGraph } from './src/neural/runtime.ts';
const graph: NeuralGraph = await NeuralRuntime.load();
const brain = new NeuralRuntime(graph, 42);
const sensors = new Float32Array(32); // Hz, each value in [0, 150]
const frame: NeuralFrame = brain.advance(sensors, 20);
const learnedReadoutInputs = frame.rates; // 128 actual output-pool features
brain.silence(true); // clears states, traces, counts, and delayed events
brain.reset(42); // resets time/RNG; preserves the current silencing flag
brain.silence(false);
brain.dispose();
```

`loadNeuralGraph(baseURL, {read?})` is also exported. `baseURL` names the app/public
root with a trailing slash, for example `/demo/` or an absolute file URL. The
browser default uses Vite `import.meta.env.BASE_URL`. Every downloaded WASM/graph
shard is size- and SHA-256-checked before use. Invalid data, input, or disposal
throws; there is no fallback. This verifies integrity against the served
manifest, not a separate cryptographic authentication of the manifest.

For Node training without a dev server:

```ts
import { loadNodeGraph } from './neural/scripts/load_node.ts';
import { NeuralRuntime } from './src/neural/runtime.ts';
const graph = await loadNodeGraph();
const brains = Array.from({length: 10}, (_, i) => new NeuralRuntime(graph, i + 1));
```

One graph object owns one WASM module and immutable CSR connectivity. Networks
share that graph via Rust `Rc` and have independent voltage/current, RNG,
refractory, pending-delay, measurement, and spike state. Dispose each runtime;
the loader caches the shared graph for the page lifetime. Multiple concurrent
`loadNodeGraph` calls intentionally load separate graphs, so share one result.

| Field | Meaning |
| --- | --- |
| `graph.modelId` | `male-cns-v1-lif-dt02-w5-v1` |
| `graph.inputGroups` | 32 disjoint groups, 16 actual `visual_projection` neurons each |
| `graph.outputGroups` | 128 disjoint undriven pools, 16 `cb_intrinsic`/`descending_neuron` neurons each |
| `graph.displayIndices` | Identity `Uint32Array`, ascending body ID, byte-checked against display IDs |
| `graph.metadata` | Full source, exclusions, signs, constants, group rules, and asset hashes |
| `frame.tick`, `simulatedMs` | Completed integration intervals; `simulatedMs = tick * 0.2` |
| `frame.spikes` | Every event index in the latest advance, including repeated neuron indices |
| `frame.counts` | `Uint16Array(139662)`, per-neuron event counts in this advance |
| `frame.rates` | `Float32Array(128)`, 50 ms exponentially filtered spike-pool mean rates, Hz |
| `frame.levels` | `Float32Array(139662)`, actual `clamp((v + 52)/7, -1, 1)` voltage |
| `frame.totalSpikes` | Cumulative events since reset, including input neurons |
| `frame.silenced` | True while silence is enabled; current spikes/counts/rates/levels are zero |

`advance` accepts 0..1000 ms and retains fractional time below 0.2 ms for the next
call. Arrays returned by `advance` are reused by that instance; copy them to
retain a historical frame, or use `snapshot()` which returns owned copies.
`snapshot()` does not advance dynamics. Voltage is reset at a spike, so levels
are not a decorative spike flash. A negative level is actual hyperpolarization.
Adapters should neither infer activity from `totalSpikes` while silenced nor
mistake input spikes for causal downstream output.

## Dynamics And Timing

The model equations/constants follow Philip Shiu and Nico Spiller's MIT-licensed
[Drosophila_brain_model/model.py](https://github.com/philshiu/Drosophila_brain_model/blob/91bdd1e7dcf193f3e7ca5a8933497fcef63b7960/model.py),
pinned to commit `91bdd1e7dcf193f3e7ca5a8933497fcef63b7960`. The upstream license is
in `reference/LICENSE` and distributed with the WASM assets. The source is
snapshotted by `scripts/pin_reference.py`, with hashes in `reference/upstream.json`.

- Rest/reset: -52 mV; strict threshold: `v > -45 mV`.
- `dv/dt = (-52 - v + g)/20 ms`, `dg/dt = -g/5 ms`; `g` is in equivalent mV.
- Structural synaptic increment: signed contact count times 0.275 mV.
- `dt = 0.2 ms`, recurrent delay 9 ticks (1.8 ms), refractory 11 ticks (2.2 ms).
- Exact linear update with `u=v+52`: `u' = u*exp(-dt/20) + g*(exp(-dt/20)-exp(-dt/5))/3`, `g'=g*exp(-dt/5)`.
- At each boundary: deliver due synaptic currents; apply independent Poisson
  voltage impulses; integrate; threshold at the interval end; reset `v=-52,g=0`.
- A spike recorded at completed tick `s` arrives at boundary `s+9`. Both state
  variables and their input writes are frozen until boundary `s+11`. The first
  newly integrated interval then ends at `s+12`. Events during refractory are
  discarded, matching the frozen-variable convention used in validation.
- Stimulus: independent Poisson counts in each 0.2 ms bin, sampled by a seeded
  xorshift32/Knuth generator, impulse `250*0.275 = 68.75 mV` into voltage. Seed
  zero aliases seed one because xorshift32 has an absorbing all-zero state.
- Output feature: each output spike adds `1000/(50*poolSize)` Hz to its pool's
  trace; traces decay exactly with a 50 ms time constant. No observation or
  label enters this feature path.

The upstream script removes refractory periods on its stimulated neurons and
uses Brian's default scheduling. This implementation keeps 2.2 ms refractory for
all model neurons and specifies its boundary/end scheduling above. The Brian2
fixture explicitly aligns that convention, including end-stamped timestamps.
It validates this implementation's dynamics, not identical out-of-the-box
execution of the original whole-brain experiment.

Sparse outgoing CSR traversal occurs only for delayed presynaptic events.
Integration visits active neurons only. Tiny passive states below 1e-10 mV are
stored and evolved analytically on the next event/snapshot, not zeroed; snapshots
do not perturb the evolution. Dormant neurons have no spontaneous/background
drive. State arithmetic is f64; exposed measurements are f32.

## Structural Selection And Exclusions

Nodes have non-null superclass and soma coordinates, sorted numerically by body
ID. Of 211,577 annotation rows, 71,915 are excluded. The raw weight file has
151,856,684 rows; 128,627,448 lack two retained endpoints. Of the remaining
23,229,236 edges, 17,692,889 have fewer than five contacts and are explicitly
pruned. All 5,536,347 remaining edges are retained without behavioral rewiring.
They represent 79,196,484 structural contacts.

Consensus transmitter labels are joined only onto the 139,662 model neurons;
the large fragment/unclear population in the raw NT table is not counted as
model neurons. There are 85,847 positive, 51,053 negative, and 2,762 zero-sign
neurons. This gives 3,259,004 positive edges, 2,154,327 negative edges, and 123,016
retained zero-current edges. Missing consensus: 10 retained neurons.

The **unvalidated simplified sign assumption** is ACh +1, GABA/glutamate/histamine
-1, modulators/unclear/missing 0. This is not a claim that glutamate is always
inhibitory or that modulators have no biological effects. `predicted_nt` is not
used as fallback. Source provenance, exact label counts and pruning are in
`public/neural/manifest.json`. MaleCNS data is attributed there to Janelia's
MaleCNS v1.0 release, with the CC-BY attribution from the project data manifest.

Input selection takes 512 evenly spaced ranks in the actual visual-projection
population, in body-ID order, grouped consecutively by 16. Output selection ranks
eligible undriven central/descending neurons by structural excitatory contacts
from those inputs, ties by body ID; the first 2,048 are distributed by rank
stride across 128 pools. These are **engineered interfaces**, not innate sensory
or behavioral assignments, and are not fitted to any demo's targets.

## Validation And Cost

`fixtures/brian2-report.json` and `reference-trace.csv` record a four-neuron
signed fixture over 100 ms. Brian2 2.10.1 at matched dt reproduces all 13 spike
events; maximum absolute voltage/current error is below 1.6e-13 mV. This checks
excitation, inhibition, exact integration, delayed propagation, frozen
refractory states, and rejected refractory impulses.

`fixtures/runtime-report.json` records the full graph check: seed 42, all 32
channels at 150 Hz, one simulated second. It produces 163,418 events, including
106,037 undriven-neuron spikes, with activity in all 128 output pools. Native and
WASM event sequences, totals and pool-rate arrays agree. Repeated seeds and differently
chunked advances agree; resting zero-input and silenced runs are quiet. A
test-only zero-edge graph has input spikes but zero downstream spikes/features.
Corrupted assets are rejected. Production exposes no edge-rewriting API.

On the recorded arm64 macOS/Node 24 run, the full one-second maximum-drive run
took about 2.17 s in WASM and 2.80 s native. Ten independent networks each
advancing 100 ms took about 1.77 s total in WASM. These are local measurements,
not browser/mobile frame-rate promises: callers must budget simulated time.
Synchronous `advance` does real computation and can block the calling thread.
The separate `fixtures/performance-report.json` measures 20 ms chunks: mean
41.6 ms at 50 Hz and 43.9 ms at 150 Hz, with 46.2 ms p95 at 150 Hz. A 100 ms
decision window should yield to the UI between its five 20 ms chunks. Ten
networks advancing 20 ms each averaged 346 ms total in the initial-window test.
Shared WASM memory was 46.5 MB for the graph, 100.9 MB with ten resting states,
and 107.3 MB after activity, plus at least 8.4 MB of JS measurement buffers.

All generated binary assets total approximately 45.86 MB raw / 18.58 MB gzip
(level 9). The browser runtime fetches about 45.17 MB raw / 18.36 MB gzip because
ID/sign audit files are not needed during execution. The manifest lists each
size and hash. CDN compression of `.bin` is not assumed; plan for the raw cost.

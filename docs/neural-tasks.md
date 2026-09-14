# Reusing the Neural Core

Import the browser API from `src/neural/index.ts`. It has no dependency on a
game, renderer, gallery, backend, or credential. Every activity shares the
verified graph loader, Rust/WASM integrator, worker client and rate-only
readout. Blackjack uses the generic `NeuralTaskController`; the other scenes
reuse `integrateNeuralWindow` with task-specific heads.

```text
environment -> observation -> 32 sensory rates -> recurrent LIF graph
                                                        |
                                     recorded voltages, spikes, 128 rates
                                                        |
                         legal action mask -> task readout -> actuator
                                                        |
                                     executed action + outcome -> learning
```

The graph is fixed, threshold-pruned MaleCNS anatomy, not trained task weights.
Input channels and output pools are engineered interfaces, not identified
blackjack, music, or flight circuits. See [model provenance](../neural/README.md).
Reusing the core does not confer task competence or biological validity.

## Add a Task

```bash
npm run scaffold:activity -- --id odor-trail --title "Odor Trail"
```

This creates `src/activities/odor-trail.ts` and a draft JSON spec without
overwriting existing files. Replace its placeholder actions and supply an
encoder for observable state. It does not generate a world or register a page.

```ts
import { AsyncNeuralRuntime } from "../neural/index.ts";
import { createController } from "./odor-trail.ts";

const runtime = await AsyncNeuralRuntime.create(1977);
const controller = createController(runtime, runtime.graph.modelId);
const choice = await controller.decide(observation, {
  durationMs: 120,
  stepMs: 20,
  valid: () => episodeId === currentEpisode && !paused,
  onFrame: frame => overlay.show(frame),
});
if (choice && episodeId === currentEpisode && !paused && !runtime.silenced) {
  const executed = environment.apply(choice.action);
  if (executed) episodeDecisions.push(choice.decision);
}
// At episode completion, only when every credited action actually executed:
controller.readout.reinforce(episodeDecisions, reward);
await runtime.dispose();
```

`observation`, `overlay`, `environment`, episode bookkeeping and reward are
your task's code, not core APIs. Recheck validity immediately before actuation,
especially after an awaited animation. Register the completed scene in the
activity catalog and Vite entry points separately.

## Contract

- `encode(observation)`: exactly 32 finite rates, 0..150 Hz. Do not include hidden
  state or an oracle's preferred action. Version the encoder when semantics change.
- `actions` and `legalActions(observation)`: stable action ordering and rule-valid
  actions. A strategic mask can bypass the brain; only rule constraints belong here.
- `durationMs` / `stepMs`: fixed simulated time in 0.2 ms increments, up to 1000 ms
  per window. A final partial step is supported. Playback FPS must not change this.
- `onFrame`: receives actual model activity. It must not fabricate spikes or
  drive actions. The returned final frame is an owned snapshot for decision replay.
- `decide`: returns an action, rate-based scores, readout trace, matching frame,
  task ID and encoder version. Empty legal sets, silence, cancellation, or zero
  readout activity return `null`. Errors propagate; there is no scripted fallback.
- `reinforce`: updates the engineered readout, not recurrent connectome weights.
  Credit only executed sampled decisions, once; discard aborted or mixed-control
  episodes. `teach` is optional supervised readout training, not biological learning.
- Save readout weights alongside task ID and encoder version. `restore` checks
  model ID and action order; the task must reject an incompatible encoder version.

The convenience controller covers a categorical action head, not every possible
motor system. For multiple legs, fielders, or continuous controls, reuse
`integrateNeuralWindow` and task-specific heads instead. Each head must consume
recorded neural outputs; mechanics and safety constraints stay in the environment.
Existing piano, baseball, flight, and garden-escape adapters have specialized loops and actuator state.

## Ownership and Speed

Each `AsyncNeuralRuntime` is an independent actor. Up to 12 actors share one worker
and immutable graph, not membrane state. Reuse actors between decisions and dispose
them when leaving a scene. Only one integration window may be in flight per actor;
do not call `advance` separately during that window. The worker applies bounded
backpressure. Rendering stays on the main thread; physics need not be neural.
For headless experiments, the same adapter accepts the synchronous `NeuralRuntime`;
load it with a file-reading `NeuralLoadOptions.read` callback, as the WASM test does.
Use the async worker client for browser scenes to keep the UI responsive.

The current model need not run at wall-clock biological speed. Report simulated
time and wall latency separately. A stalled model must stall new motor commands,
not silently switch controllers. No new Rust build is needed for a task adapter.

## Acceptance Tests

Before presenting a new task as neural-controlled, test:

1. Same neural rates and legal actions give the same readout regardless of observation.
2. Silence, zero output rates, missing assets and an in-flight cancellation withhold actions.
3. Rendered activity and action traces come from the same frame; replay cannot train.
4. Only executed actions receive outcome credit, and reset/disposal prevents stale actions.
5. Actual WASM runs pass silence and zero-edge ablations, not just mocked unit tests.

See `tests/neural-task.test.ts`, `tests/blackjack-neural.test.ts` and
`neural/scripts/verify_runtime.ts`. Deterministic unit fixtures test orchestration;
they are not evidence of biological performance. Keep poor outcomes in recordings.

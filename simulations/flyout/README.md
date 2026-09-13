# Flyout

Standalone Three.js / Rapier / Tone arcade baseball at `/simulations/flyout/` on the existing Vite server. All fly anatomy, the ballpark, bat, and fruit are procedural geometry. Autonomous batting and fielding now use an experimental full-connectome spiking model with learned task readouts. This is not validated biological baseball cognition.

The shared `ActivityConnectome` uses the existing WebGL renderer for both the full anatomy panel and one framed, world-space miniature. Both receive the active actor's actual neural frame through `updateNeural`, without event projections or invented excitation. The miniature follows the batter through contact, then a moving fielder or possessor; outcomes preserve the actor. Class bars summarize actual state, not baseball task channels. The display uses 60,000 sampled edges; computation uses all 5,536,347 retained edges and 139,662 neurons.

## Neural Control

`neural-bridge.ts` creates ten `AsyncNeuralRuntime` clients: nine independent fielding-role states and a separate batter state, reset when the batter changes. They share the core's immutable graph and one neural worker, never mutable neuron state. There is also Tone's unrelated audio-clock worker. Loading or inference failure disables autonomous controls; manual controls and physics remain available. There is no scripted motor fallback.

The encoder supplies 32 bounded 0-150 Hz symbolic sensory inputs: signed relative ball position/velocity, home offsets, field boundaries, current phase, possession, bounce, role, runner distance, and count. Only the model's 128 measured spike-rate features enter the learned readouts. Nine movement classes, six handling classes, two swing classes, and three aim classes produce performed commands. Physical proximity, phase, field bounds, and arcade rules constrain their application. No live teacher, predicted landing chase, automatic catch, timed swing, or first-base throw overrides those commands. Misses, bad directions, failures to reach, and late throws remain outcomes.

Every actor advances 10 neural milliseconds per accepted batch, requested no more often than every 100 wall milliseconds. A single outstanding batch supplies one request per actor; backpressure drops opportunities instead of queuing catch-up work. The physics clock continues at 60 Hz using the latest returned command. Neural time is intentionally much slower than world time and can lag further on busy devices. `window.__flyout.neural` reports each actor's tick, simulated milliseconds, spike count, command, batch wall cost, and separate world time. Pause freezes displayed frames and motor application; a previously submitted worker window may finish but its result is discarded. Silence gates motors immediately, then displays the actual acknowledged silent frames while physics continues.

## Calibration

`calibrate.mjs` runs real full-graph responses offline and writes `calibration.json`. Teachers in `neural-calibration.ts` are confined to that offline path; browser startup restores learned weights only. Calibration used seed 7193, 192 scripted observation trials, 100 ms model windows, and 12 supervised optimizer passes per recorded response. Validation used 48 separate trials (24 per applicable head) without training. The recorded run took 26.4 seconds.

| Readout | Held-Out Correct | Accuracy |
| --- | ---: | ---: |
| Movement | 5/24 | 20.8% |
| Handling | 15/24 | 62.5% |
| Swing | 12/24 | 50.0% |
| Aim | 8/24 | 33.3% |

These small, weak validation results are not evidence of competent play or biological validity. Offline observations differ from the evolving game; short online windows and delayed commands compound errors. During play, sampled decisions actually submitted to actuators receive bounded outcome reinforcement after the result. Unperformed predictions, manual actions, and greedy validation predictions are never reinforced or used to overwrite an action. The roster status tooltip reports calibration metrics.

Turf and clay use deterministic, repeating canvas textures with subtle bump detail. A 2048-pixel directional shadow map, bat and ball details, shared seat materials, instanced contact shadows, and a reusable trail buffer sharpen the field without postprocessing. The camera reserves space for the roster, activity panel, and controls; the miniature has a dark backing and a minimum projected size. The full panel remains visible on phones. Production builds with a non-root base expose an `All demos` backlink to `import.meta.env.BASE_URL`.

## Controls

- Pitch / Swing button or Space; the green meter segment is the contact window. Spray sets the hit direction.
- Select any of nine fielders through the roster or directly on the field. WASD, arrows, or the touch direction pad move the selected fly relative to the camera.
- Neural fielding enables learned movement and handling. Manual movement/reach takes priority for 1.4 seconds. C / hand requests a manual reach; a nearby ball is not automatically caught without a manual or neural reach command.
- After pickup, 1-4 or the base buttons manually throw to first, second, third, or home. With neural fielding enabled, the possessor's learned handling readout chooses whether/where to throw.
- Neural play enables learned swing/aim plus scripted pitch and turn management. Manual actions remain clearly labeled. Silence neurons is a live motor ablation, not a physics pause.
- Follow fielder, pause (P), reset, and optional synthesized audio. Sound is off initially and starts only from a user gesture.

## Arcade Rules

Three complete innings, both halves always played, with ties allowed. Cherry bats first. Three strikes are an out, four balls force a walk, and fouls stop adding strikes at two. Three outs clear the bases and change sides. Runners hold on outs; there are no steals, tags, double plays, or sacrifice advances.

An airborne catch is an out. First ground contact determines fair/foul territory. A fair airborne ball above the outfield wall is a home run. The batter reaches each base in 3.8 simulation seconds; existing runners wait for the result. A ground-ball throw arriving at first before 3.8 seconds is an out. Other throws, or late first-base throws, end the play safely: one to three bases are awarded according to the batter's completed base intervals, with a minimum of one. All existing runners advance by that award. A ball left uncollected or unthrown for 12.73 seconds is a triple. Home runs score the batter and every occupied base. This deliberately simplifies baseball into a consistent timed arcade game.

Rapier handles the dynamic ball, ground and fence collisions, and moving fielder sensors. Physics uses 1/60-second steps, capped at six per render frame; excess elapsed time is dropped after stalls. Pause and background visibility stop the game clock. Models, renderer, audio, event listeners, physics, and animation frames are released on navigation or Vite hot replacement. WebGL and physics startup failures expose a reload state.

## Verification

Run from the repository root with its installed dependencies and server:

```sh
npx tsc -p simulations/flyout/tsconfig.json
node --test simulations/flyout/game.test.ts simulations/flyout/neural-adapter.test.ts
FLYOUT_URL=http://127.0.0.1:5186/simulations/flyout/ node simulations/flyout/neural.verify.mjs
# Explicit offline recalibration, not needed to start the game:
node simulations/flyout/calibrate.mjs
```

Adapter tests cover encoding, separate actor states, no-output/fault behavior, pause, applied-decision reinforcement, and silencing with real Rapier physics. A full-graph LIF test independently verifies that actual spike/readout-driven displacement stops under neural silencing while a ball continues falling.

`neural.verify.mjs` checks shared-worker ownership, actual actor frames, neural/world clocks, autonomous movement, pause, neural silencing without physics stoppage, failure-closed loading, and desktop/mobile anatomy pixels and layout. It writes screenshots and `verification/neural-report.json`, not a recording. `window.__flyout` is a read-only diagnostic snapshot. The older `verify.mjs`, `fielding.verify.mjs`, `activity.verify.mjs`, and previously recorded media describe the former scripted/event-driven version and are not neural-controller verification. Parent integration owns production builds and sequential re-recording.

Limitations: arcade runner/throw rules above, no network play, no regulation pitch variety, no captured audio in the video. Typography uses Google Fonts with local fallbacks. The external parent build/navigation owns integration; this directory changes no root configuration.

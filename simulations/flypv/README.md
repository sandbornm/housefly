# Flylot

A Three.js / Rapier flight experiment at
**http://localhost:5173/simulations/flypv/**. Visible branding is Flylot; the
internal route and `window.__flypv` debug API remain stable. All demos uses
`import.meta.env.BASE_URL`, including the parent's `/demo/` deployment.

## Causal Neural Control

Neural mode uses this chain, with no substitute controller:

1. Actual Rapier position, velocity, turn rate, waypoint bearing/distance/height,
   contacts, and eight collision-world ray clearances encode 32 sensory rates
   bounded to 0..150 Hz.
2. The shared Rust/WASM LIF runtime advances the located 139,662-neuron graph
   and all 5,536,347 retained connections (weight >=5), in a Web Worker.
3. A learned seven-action readout consumes only the same frame's 128 measured
   neural firing-rate features: hold, forward, yaw-left, yaw-right, ascend,
   descend, or brake.
4. The decoded action drives an acceleration-limited Rapier velocity actuator.
   Heading/speed conversion is an engineering actuator interface, not another
   navigation policy.

The model is not an innately flying drone controller. Sensory encoding,
readout pools, calibration labels and actuators are engineered interfaces;
the neural dynamics are experimental assumptions on anatomical wiring.
This does not establish biological validation, natural fly behavior, or cognition.
The decorative fly pilot is not a biomechanical fruit-fly model.

The full panel displays actual levels and spikes from the accepted control
frame via `ActivityConnectome.updateNeural`, before the world render; its scissor
render follows the world render. All cameras retain the full anatomy. The
60,000 rendered edges are a display subset, not the simulated connection count.
No legacy event projection, phase wave or synthetic activity fallback remains.

## Calibration and Timing

Motor drive is off until the user chooses **Calibrate** in Flight settings.
This explicit sensor rehearsal generates 84 balanced teacher-labeled observations.
Each is processed by the real neural runtime for 60 model ms, with neural state
reset between trials. Only its measured rate features are captured. The readout
then learns from 64 shuffled replay epochs. The reported loss is a training
cross-entropy, not a held-out accuracy or evidence of biological fidelity.

Rehearsal never sends commands to the physical drone. The neural state is reset
before inference, while learned readout weights persist. Inference calls only
the learned decoder, never the teacher. Recalibration is explicit, not hidden
online correction. Reload starts uncalibrated again.

Browser requests target **20 model ms per 100 physical ms**, with at most one
advance in flight and no inference queue. Completed outputs are held until a
physical step accepts the frame and command together. The previous accepted
neural command is held while a worker reply is pending. Slow computation can
reduce the model/world-time ratio; the overlay reports both clocks and settings
report measured worker latency. This is not natural-brain real-time operation.
Physics and rendering do not await the neural worker.

Pause and hidden tabs stop physics, neural requests and acceptance of pending
frames. The overlay still receives the paused flag. Reset and silencing invalidate
late worker replies. Worker/load errors fail closed with motor drive off.

**Silence neurons** removes neural motor drive immediately, then displays the
worker's actual silenced state. With no drive, the velocity servo and gravity
compensation are bypassed: inertia, gravity and collisions continue. No route
velocity, automatic recovery or teleport rescues the drone. Missed goals and
collisions are retained. Only an explicit user Reset flight repositions it.

## Scene and Controls

A goggled fly rides a coral quadcopter above Alderwatch, an original daylight
low-poly village. Small mipmapped raster maps sharpen stone, timber, plaster,
paving and roof tiles with world-sized UVs. Directional light, dark trim, gable
braces, window boxes, painted propeller tips and merged drone hardware add
contrast without global postprocessing. Repeated village geometry is instanced.

| Control | Action |
| --- | --- |
| W / S, up / down | Manual forward / backward |
| A / D | Manual strafe |
| Q / E, left / right | Manual yaw |
| Space | Manual climb |
| Shift or C | Manual descend |
| G | Neural / manual |
| V | Follow / FPV / orbit |
| P | Pause / resume |
| R | Explicit flight reset, preserving learned weights |
| Touch left stick | Manual yaw / altitude |
| Touch right stick | Manual forward / strafe |

Movement input explicitly selects Manual. Its velocity servo compensates gravity
and hovers on release; manual control is not attributed to neural decisions.
Camera, speed, sensitivity, map and gesture-gated audio controls remain available.
Calibration does not reposition the aircraft: use Reset flight explicitly after
calibration to evaluate from the initial airborne state.

Rapier uses a 60 Hz fixed step, CCD and a conservative 2.05 m collision sphere.
Solid houses/convex roofs, ground, ceiling and world boundaries remain collidable.
There is no aerodynamic lift, battery, damage or motor-thrust simulation.
Camera obstruction rays and the mini-map do not control the aircraft.

## Verification

From the repository root, with the existing Vite server on port 5173:

```sh
./node_modules/.bin/tsc -p simulations/flypv/tsconfig.json
node --test simulations/flypv/*.test.ts
node simulations/flypv/verify-neural.mjs
node simulations/flypv/verify.mjs
```

Unit fixtures are explicitly test-only. They check input encoding, frame-bound
decoding, zero/silenced gating, goal accounting, calibration separation,
single-flight async scheduling, late-result invalidation, and physical collisions.
`verify-neural.mjs` separately loads the real verified graph/WASM in Node,
calibrates on real model outputs, checks 100 inference decisions against their
exact frame ticks and feature hashes, and removes motors while Rapier falls.
Its ten-physical-second flight result is reported, not required to complete a
waypoint or follow a perfect route.

Browser checks use the real worker, test calibration/inference, frame/command/
display agreement, pause, silencing with continuing physics, explicit manual
controls, visible anatomy pixels, desktop/mobile HUD separation and context-loss
cleanup. Local screenshots/results go under `verification/`; no video is recorded.
Override `FLYPV_URL` for another existing server.

`node scripts/record_flypv.mjs` performs real worker calibration and a pre-capture
silencing/physics check, then records one continuous 30-second neural run at
1920x1080, encoded as 30 fps H.264 with faststart. The fixed camera schedule is
independent of outcomes. No resets, motor interventions or collision edits occur
in the take; the poster is its predetermined 12-second frame. Outputs are
`docs/media/flylot-neural.mp4` and `flylot-neural.png`; the old `flylot.mp4` is
hash-checked and preserved. `verification/neural-recording.json` retains setup,
ablation, frame/command/physics telemetry, both clocks and observed limitations.
FFmpeg is limited to two threads. An HMR-free snapshot can be built and served
using `vite build --config simulations/flypv/recording.config.mjs` and
`vite preview --config simulations/flypv/recording.config.mjs`; set
`FLYPV_URL=http://127.0.0.1:5187/simulations/flypv/` for that recorder run.

`window.__flypv.snapshot()` retains prior fields and adds neural phase, training
metrics, accepted frame tick, latency, motor source, applied target and feature
hash. `window.__flypv.silence(boolean)` invokes the same intervention as the UI.
`recoveries` remains zero for API compatibility; it no longer denotes a recovery
mechanism. Teardown frees the worker actor, Rapier and rendering resources.

Policy quality is experimental and can include hovering, missed goals and impacts.
Short desktop Chromium/emulated-mobile checks do not establish long-duration
stability, physical-mobile performance, Safari support or biological validity.

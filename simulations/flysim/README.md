# Fly Simulator

A fruit fly escaping people, swatters, frogs, and a bird in a garden, at
**http://127.0.0.1:5180/simulations/flysim/**. Visible title is Fly Simulator;
`window.__flysim` is the debug API.

## Neural chain

There is no scripted escape controller. Autopilot uses this chain, or it withholds motors:

1. Garden observations (pose, threats, food, grounded/hit) encode 32 sensory rates.
2. The shared MaleCNS LIF runtime advances the located graph in a Web Worker.
3. An engineered seven-action readout consumes that frame's measured rates.
4. The decoded command is the only autopilot motor source: `command.input` when powered, station-keep `{0,0,0}` while loading/calibration, and `null` on silence, failure, or unpowered inference.

Predators, swatters, and the bird are game objects with authored chase logic. They are not biological circuits, identified fly threat pathways, or evidence of cognition.

The overlay is real LIF. `ActivityConnectome` starts awaiting measured voltages (`neural: true`) and only lights after an accepted controller frame via `updateNeural`. Silence zeros overlay energy. Missing neural assets fail closed.

Manual WASD/arrows, Q/E climb/dive, and Shift dash are explicit overrides, not a fallback policy. Pause, reset, calibrate, and chase/orbit cameras stay available.

```sh
./node_modules/.bin/tsc -p tsconfig.json
node simulations/flysim/verify.mjs
node scripts/record_flysim.mjs
```

Override `FLYSIM_URL` if the existing Vite server is not on port 5180.

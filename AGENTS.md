# Housefly

Browser demos that drive a threshold-pruned MaleCNS LIF model. Experimental
neural control, not validated fly cognition. No API keys.

## Run

```bash
npm ci
npm run dev -- --port 5173
```

http://127.0.0.1:5173 — blackjack. Other activities:

| Path | Activity |
| --- | --- |
| `/` | Housefly blackjack |
| `/simulations/piano/` | Flythoven |
| `/simulations/flyout/` | Flyout baseball |
| `/simulations/flypv/` | Flylot flight |
| `/simulations/flysim/` | Fly Simulator (garden escape) |

`npm test` then `npm run build`. Playwright: `npx playwright install chromium` then `npm run test:ui`.

## Layout

- `src/` blackjack table, connectome inspector, shared neural runtime
- `src/neural/` graph loader, WASM worker client, readout, task controller — no game, no credentials
- `simulations/{piano,flyout,flypv,flysim}/` activity-specific worlds
- `public/neural/` and `public/connectome/` runtime binaries (Janelia CC-BY)
- `public/models/drosophila.glb` NeuroMechFly v2 body (Apache-2.0)
- `docs/neural-tasks.md` adapter contract and scaffold

```bash
npm run scaffold:activity -- --id odor-trail --title "Odor Trail"
```

Register the scene in `src/activityCatalog.ts` and `vite.config.ts` yourself.

## Neural contract

- Recurrent MaleCNS graph weights stay frozen. Task learning is readout `teach` / `reinforce` of 128 pool rates.
- `encode(observation)`: 32 finite rates, 0..150 Hz. No teacher/oracle action in the vector.
- Overlay must copy the same LIF frame the motors used (`ActivityConnectome` with `neural: true`, then `updateNeural`). Do not drive control from event-projection.
- Silence, zero rates, missing assets, or an in-flight cancel withhold motors. No scripted fallback.
- Train and infer on the same `advance` window. Shipped `calibration.json` must match that window.
- Blackjack uses `NeuralTaskController`. Multi-head tasks reuse `integrateNeuralWindow`.

## Do not

- Claim biological task competence or that the fly understands the game
- Train or rewrite recurrent connectome weights; only the engineered readout learns
- Fabricate spikes or use event-projection as the motor path
- Add gallery, social, deploy, or API-key dependencies to a new activity
- Commit `.env`, secrets, `dist/`, or `test-results/`

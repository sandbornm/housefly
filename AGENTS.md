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

`npm test` then `npm run build`. Playwright: `npx playwright install chromium` then `npm run test:ui`.

## Layout

- `src/` blackjack table, connectome view, shared neural runtime
- `src/neural/` graph loader, WASM worker client, task controller — no game, no credentials
- `simulations/{piano,flyout,flypv}/` activity-specific worlds
- `neural/` Rust LIF + graph build scripts
- `public/neural/` and `public/connectome/` runtime binaries (Janelia CC-BY)
- `docs/neural-tasks.md` how to add an activity

```bash
npm run scaffold:activity -- --id odor-trail --title "Odor Trail"
```

Register the scene in `src/activityCatalog.ts` and `vite.config.ts` yourself.

## Do not

- Claim biological task competence or that the fly “understands” the game
- Train or rewrite recurrent connectome weights; only the engineered readout learns
- Add gallery, social, deploy, or API-key dependencies to a new activity
- Commit `.env`, secrets, `dist/`, or `test-results/`

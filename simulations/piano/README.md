# Flythoven

Playable route: `/simulations/piano/`, or `/demo/simulations/piano/` in the parent's public build.

Flythoven is an **experimental neural piano task**, with the opening strain of Beethoven's **Fur Elise, WoO 59** as its requested score. It is an opening excerpt, not the complete piece. The notation is the target, not a claim that the fly performs it correctly. The current v2b controller uses offline-trained readouts with online calibration off by default. Substantial wrong, early, late, and missed notes remain; it is not a skilled or faithful rendition.

## Score and Provenance

- Source: [Mutopia-2015/08/18-931](https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=931), based on Breitkopf & Hartel, 1888, typeset by Stelios Samelis; both the composition and this edition are public domain.
- The LilyPond source downloaded on 2026-09-12 has SHA-256 `828a7bd1b42e441fe1b0eb0389ba46f1502dab28bbe488389e635fb446ba7a67`.
- `score-data.ts` transcribes both staves as explicit MIDI pitches, rests, and sixteenth-note durations. The excerpt contains the E5-D#5 pickup, seven full 3/8 measures, and the first ending's quarter-note partial measure. Its written repeat is omitted; the loop control repeats the excerpt.
- `TOTAL_BEATS = 12` quarter-note units, 53 requested attacks, and E2-E5 keyboard range. The default is **72 BPM**, matching the source setting and giving **10 seconds per target pass**. Earlier neural recordings used 96 BPM; those historical captures are preserved, not relabeled. Controller comparisons must use the same tempo for each candidate.
- Requested sounding windows retain the former 88% articulation gate. Those windows are sensory targets only; they no longer schedule audio or foot contact.

## Causal Path

The ordinary route now runs the latest v2b controller, as requested, even though its historical musical-accuracy promotion criterion failed. This is a default-selection change, not new training or a claim of improvement. The visible status remains **V2 experimental / Offline-calibrated**.

1. `neural-model.ts` observes the requested score with a 0.16-quarter-beat lookahead. The default `sensory-associated.ts` maps it to 32 bounded sensory rates: categorical pitches, per-leg pitch and relative onset, actual limb proprioception, and beat/measure phase. Requested notes enter the sensory model, never the actuator directly.
2. `neural-session.ts` uses the shared `AsyncNeuralRuntime` worker: 139,662 neurons and 5,536,347 measured connections in the parent's experimental LIF model. One real 20 ms model batch is requested at a time. Actual `simulatedMs` is reported separately from the score/audio wall clock; the model is not silently fast-forwarded to pretend it runs in real time.
3. Twelve shared `NeuralReadout` instances infer only from the 128 actual neural pool-rate features: one pitch head and one hold/strike head for each leg. Inference is greedy; there are no added random timing errors, score-derived action masks, direct target-to-action shortcuts, or pitch corrections.
4. Online calibration is off unless explicitly enabled by its checkbox. Frozen inference loads the shipped graph-validated `calibration-v2.json` artifact. When teaching is enabled, prediction precedes feedback and balanced replay never emits motor actions. The anatomical LIF core is fixed, not a learned or biologically validated piano-playing brain.
5. `actuator.ts` accepts only decoder commands. It validates each leg's range and busy state, moves the foot at a bounded speed, and emits a unique performed event at key contact. That same event drives the actual key hinge, articulated foot, and `PianoAudio.perform()`. Wrong pitches stay wrong; there is no Tone score Part or score-driven fallback.

Pause stops new neural requests, discards late pending results, and freezes pose, displayed state, and calibration. Seeking coalesces resets and invalidates stale actions; it does not play the requested note. Silencing immediately gates new commands and cancels pending strokes. A missing/failed neural runtime leaves autonomous notes disabled. Manual keyboard audition remains explicitly manual and does not fabricate neural activity.

The connectome receives only actual frames through `updateNeural()` before the world render, and is rendered after it. The old event-projection adapter has been removed from this slice. The full 139,662 normalized voltage states drive the overlay; its 60,000 displayed edges are a visual subset, not the full simulated edge count. Assumed dynamics, engineered sensory interfaces, and learned readouts are not measured brain activity or validated fly cognition.

## Experimental V2b

- Current public-repository URL: `http://127.0.0.1:5180/simulations/piano/`. The archive's port 5173 is not current.
- `?encoder=v2` remains an explicit alias of the default. `?weights=cold` deliberately skips the offline weights while retaining the associated encoder and frozen inference.
- Historical v1 is available only with `?encoder=v1`; it starts with cold readouts and its Calibration checkbox is also off.
- The public-build equivalents use `/demo/simulations/piano/` with the same query parameters. The calibration artifact is bundled through a relative asset URL; no CDN is used.
- The v2 modes plainly display **V2 experimental**, retain **72 BPM**, and default to frozen inference with the Calibration checkbox off. Latest-controller availability is not a musical-skill claim.

The parent's `sensory-associated.ts` retains categorical pitch evidence on channels 0-11 (120 Hz). Channels 12-17 carry six separate absolute pitches within their fixed physical ranges (25-150 Hz, zero at rest); 18-23 carry per-leg relative-onset phase in milliseconds (0-150 Hz); 24-29 carry actual limb proprioception; 30-31 carry beat/measure phase. This distinguishes the v1 F3/A2 versus A3/F2 limb/octave collision without discarding its categorical pitch evidence. Earlier opponent-pair and input-mapped v2a experiments remain in `sensory.ts` and the archived reports.

`neural-dual.ts` gives each leg two independently learned, rate-only readouts: a pitch head and a binary hold/strike head. `PianoDualDecoder.predict(frame)` accepts **no score, beat, elapsed time, target identity, or action mask**. A decoded hold-to-strike edge issues the decoded pitch; changing pitch alone cannot strike, and another fall/rise can repeat the same pitch. The actuator's physical range/busy checks remain the only motor acceptance guards. The fixed 85 ms strike duration is not learned. Events have `requestedNoteIndex: null`; assessment observes actual pitches afterward.

Teacher-only labels use the observed upcoming 20-100 ms onset window. Online teaching follows prediction and motor-command submission, never overwrites an action, and is disabled during frozen inference. Replay retains only 128 copied rates plus tick/model-time/silencing metadata, bounded to 301,056 rate bytes for the dual heads (264,192 for v1). It never retains full-neuron arrays or replays motor actions.

`calibration-v2.json` contains the 72-inclusive offline candidate and provenance. Loading validates the anatomical model ID, node/edge counts, 20 ms recurrent step, encoder, decoder architecture, and every readout's action/feature dimensions. Missing or incompatible requested weights fail closed; they do not silently switch to v1 or untrained v2. `neural.version`, `encoder`, `architecture`, `calibrationSource`, `gates`, per-head `updates`, and `replayRateBytes` expose the current configuration.

### Measured Tradeoff

The final 72 BPM test used **the same tempo for every controller**, new seeds 22003/24007, and two unseen measure orders. Each controller trained on 738 real recurrent frames including independent 72 BPM cases, with 48 balanced passes per head. Neural advancement stayed at 20 ms with a nominal 50 ms wall/actuator cadence; only whole phrases reset. The earlier 96 BPM recording is not this comparison's baseline.

| Offline-Calibrated Controller | Pitch-Head Accuracy | Matched / 106 | Wrong | Extra | Missed | On Time | Matched Onset MAE |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| V1 encoding, pitch-edge control | 73.2% | 84 | 66 | 6 | 22 | 43 | 87.5 ms |
| V1 encoding, learned strike heads | 84.4% | 70 | 18 | 8 | 36 | 33 | 87.2 ms |
| Associated encoding, same learned strike heads | 88.0% | 66 | 32 | 6 | 40 | 33 | 82.3 ms |

**Historical promotion criterion failed.** Associated encoding improves conditional pitch-head accuracy but loses note coverage and adds wrong notes versus the matched dual-head control. Serving it by the latest-controller directive does not change those results. That accuracy measures predictions while a sensory target exists, not the fraction of correctly performed music. Matched-onset error also excludes missed notes. The small tests, variable browser latency, cold initial recurrent state, and changed proprioception after training limit generalization; learned strike timing remains a bottleneck.

Evidence: `calibration-v2a-report.json` preserves both failed earlier v2a experiments; `calibration-v2b-report.json` preserves the 86/98 BPM final comparison; `calibration-v2b-72-report.json` contains the separate 72 BPM test, fixed protocol, per-leg results, and preserved v1 media/report hashes. Original seeds 1901/2903 were used only as validation in the v2b iteration. No parameters changed after its final test. `calibrate-dual.mjs` reproduces the experiment; `PIANO_TEMPO72=1 node simulations/piano/calibrate-dual.mjs` runs the separate 72-inclusive protocol. Repeating a known test does not make its seeds held out again.

## Six-Leg Mechanics

Three articulated legs attach to each side of the thorax: `L1/R1` front, `L2/R2` middle, `L3/R3` hind. Each has coxa, fixed-length femur and tibia, tarsus, joint caps, and a small foot. Separate bend planes and contact lanes keep the chains separated. The hovering body and spread, gently moving wings are illustrative kinematics, not an aerodynamic simulation.

`LEG_RANGES` in `actuator.ts` partitions the physical keyboard: L3 40-45, L2 46-52, L1 53-59, R3 60-64, R2 65-72, R1 73-76. A command is `{ legId, midi, velocity, holdMs, requestedNoteIndex, neuralTick, neuralSimulatedMs }`. The live decoder uses an 85 ms fixed strike, a 30 ms recovery, and travel bounded to 6.5 world units/s with a 25 ms minimum. It does not copy score duration or velocity. Travel latency and rejected busy commands can therefore cause real performance errors.

`performance.ts` exports `articulateLegs`, `keySurfacePoint`, `LEGS`, and `LEG_ASSIGNMENTS`. `sixLegPerformance()` is a deterministic **reference geometry test harness only**, not the live controller. Its source assignment counts are L1/L2/L3 = 6/6/6 and R1/R2/R3 = 12/16/7; actual neural output is not forced to match those counts. Key pressure rotates downward about the same hinge used to calculate foot contact.

## Notation and Rendering

VexFlow 5.0.0 draws the source grand staff, aligned voices, rests, accidentals, beams, barlines, brace, pickup, and 3/8 signatures. Its Bravura entry embeds fonts; there are no font CDN requests. The score playhead and scrolling follow the transport, which uses Tone's clock after audio is enabled. Pink identifies current requested notes; green marks matched on-time notes, amber early/late matches, and faded notes missed targets. The separate performed count and connectome detail report actual notes, including wrong pitches.

Assessment is observational and cannot influence actions: it matches unclaimed pitches within 250 ms of a requested onset, considers +/-75 ms on time, and reports remaining expired targets as misses. These are task scoring conventions, not biological timing claims.

The instrument retains clear-coated ebony, satin keys, brass trim/pins, grained soundboard, stitched upholstery, instanced strings, faceted eyes, wing membranes/veins, and bristles. Shared geometry, instancing, one 1024px shadow map, and capped device pixel ratio keep the scene economical. The neural worker leaves rendering and contact/audio timing on the main thread. Desktop and mobile preserve a readable 160px notation band; narrow and short displays scroll vertically rather than collapse it.

## Diagnostics

`window.__flyPiano.snapshot()` includes:

- `beat`, `bpm`, `totalBeats`, `frameAudioBeat`, `frameAgeMs`, `neuralModel`.
- `scene.legs[]`: `id`, `name`, `row`, `side`, `midi`, `eventId`, `contact`, `phase`, `press`, `lift`, five world-space `joints`, four `lengths`, `tip`, `keySurface`, `contactError`, `screen`, `reach`, `reachLimit`, and `reachable`. `noteIndex`/`targetNoteIndex` identify the requested sensory context, not proof of a correct note.
- `scene.performed[]`: the **frame-local** events that caused its rendered contacts. Match `scene.legs[].eventId` to this list. Events contain actual MIDI/leg, physical start/end times, `source: "neural"`, and the causal `neuralTick`/`neuralSimulatedMs`. This avoids comparing a rendered frame to a live actuator already reset by a later control event.
- `neural.actuator.history`, `active`, and cumulative `totalContacts`; IDs remain unique across seeks/loops. `neural` also reports worker status, readout updates, predictions, accepted commands, actual pool rates/spike counts/model time, request latency, and assessment.
- `audio.performed[]`: matching contact `eventId`, actual `midi`, and audio-context onset `time`. Manual auditions are not counted as neural events.
- `notation.scoreRole === "requested"` and notation assessment. `scene.connectome.mode === "neural"`, with actual tick, simulated time, spikes, and silencing state.

`await window.__flyPiano.silence(true)` performs neural ablation; `false` releases it. Silencing cancels pending strokes and prevents new contact/audio events; already sounded strings and reverb can finish their release tails. Normal use still requires a gesture to enable audio. No recording is started by the piano. `captureAudio()` passively taps the existing audio output for the recorder, including production builds; it cannot produce a note or change the controller.

## Verification

With the new public repository's local server on port 5180:

```sh
npx tsc -p simulations/piano/tsconfig.json
node --test simulations/piano/*.test.ts
node simulations/piano/verify.mjs
node simulations/piano/verify-v2.mjs
```

Pure tests cover source notation, all-six assignment/contact, simultaneous notes, finite fixed-length IK and bounds, pairwise clearance across all legal wrong-note motor ranges, zero-state/rest fail-closed behavior, causal shared-readout pitch changes, prediction-before-teaching, wrong/missed assessment, worker latency, pause, rapid seeks, silencing, and runtime failure.

The browser verifier waits for both anatomy and actual neural readiness. It writes screenshots and `verification/report.json` inside this ignored piano directory. The verified viewports are 1920x1080, 1440x960, 390x844, 320x640, and 844x390. Checks include nonblank/moving WebGL pixels, no overlap/overflow, all six genuinely produced contacts, simultaneous strikes, rendered key contact, frame-local event/audio identity, model/learning pause, manual audition without invented neural activity, RMS/mute, tempo, score/audio-clock agreement, ablation, loop/end, camera controls, and fail-closed model loading. Set `PIANO_URL` to test another deployment.

The completed Chromium run rendered near 60 FPS at all five sizes and observed all six limbs, including six simultaneous contacts. Maximum measured foot-to-key error was below `3.2e-16` world units. The first-pass readouts still made many errors; passing these engineering checks does not establish musical skill. Real-device Safari audio and browser-worker behavior are not covered. The parent owns video recording, publication, and deployment.

The historical v2b run passed desktop 1920x1080 and mobile 390x844 checks at 72 BPM: nonblank canvas, no overlay overlap, all six genuinely used legs, 69/66 new contact/audio identity matches, frozen model/weights on pause, quiet silencing, explicit cold-weight mode, and incompatible-model fail-closed behavior. These are historical measurements, not a new capture.

The current default-selection change passes 50 piano tests and the piano TypeScript check, including the real shipped WASM graph/weights ablation test in `neural-current.test.ts`. That test observes actual contacts, zero new commands/contacts under silence, recovery, and unchanged readout updates. `verify-v2.mjs` now tests the ordinary default URL. The new frozen-production run passed at desktop 1920x1080 and mobile 390x844, observing 80/70 contact/audio pairs across all six legs, 323/134 canvas color buckets, no overlap/overflow, frozen readouts, quiet silence across score-loop resets, cold mode, and incompatible-weight failure. Evidence is under `verification/current-browser/`.

## Current Recording

The current capture completed on 2026-09-13 from a frozen production preview on temporary port 5188. That preview has been closed; the parent-owned development server is on 5180. `PIANO_URL=http://127.0.0.1:5180/simulations/piano/ node scripts/record_piano.mjs` is the recorder invocation, but its overwrite protection now preserves the finished take. Prefer a frozen production preview supplied through `PIANO_URL` for future versioned captures; no dev-only Tone module import is needed. The archived port 5173 and query overrides are rejected. Do not run concurrently with another neural capture.

Verified outputs are `docs/media/flythoven-neural-current.mp4` and `.png`: one uninterrupted 30-second inference take, 31 seconds including lead/tail, at unchanged 72 BPM. The take contains 195 matched physical contact/audio event IDs: L1/L2/L3 = 33/26/32 and R1/R2/R3 = 23/60/21, with up to three simultaneous contacts. Its 62 on-time, 29 early, 17 late, 87 wrong notes and 51 missed targets are retained. All twelve readouts stayed frozen; maximum observed request latency was 44.3 ms, rendered cadence 60.03 FPS, and foot/key error below `3.2e-16` world units. This is authentic current behavior, not a successful rendition.

`neural-current-recording.json` is the concise versioned evidence, including media/artifact hashes. Full JSON telemetry, source hashes, a separate-session WASM silence/audio precheck, per-contact/audio IDs, and decoded-file checks remain under `verification/neural-current-recording/`. The fixed poster time is 10 seconds. No accuracy threshold or six-leg count selected the take. Encoding used two ffmpeg threads, H.264/AAC, 1080p/30 FPS, and faststart, with only global loudness normalization and an ending audio fade. Full decode, seven encoded score-cursor checks, and delivered audio onset within 41 ms of the scheduled first contact passed.

Historical `flythoven.mp4/.png` and `flythoven-neural.mp4/.png` are hashed and preserved. Existing current raw captures and completed outputs are never overwritten for another attempt. `PIANO_VERIFY_CAPTURE=1` verifies/encodes the same saved capture without running inference again; it does not select a better take.

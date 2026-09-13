# Connectome Activity Views

## Neural Controller Update

Existing videos without `-neural` in their filenames use the original
illustrative mode described below. They are not connectome-controller recordings.

The new `ActivityConnectome.updateNeural(frame, options)` and blackjack's
`ConnectomeView.setNeuralActivity(frame, options)` consume completed model frames:

- Point levels are normalized membrane voltage, copied without display diffusion.
- Blue below-rest levels represent modeled hyperpolarization.
- Gold spike marks come from recorded spike indices in the displayed frame.
- Regional bars summarize model levels, not semantic task scores.
- Decorative traveling edge packets are disabled in neural mode.
- The miniature shares the selected actor's frame with the larger view.

The experimental dynamics model uses 5,536,347 threshold-retained edges among
139,662 located neurons, independently of the 60,000-edge visual subset.
See [methods, exclusions, and validation](../neural/README.md). Flyout maintains
ten independent model states. The worker's model clock can run slower than the
world clock; renderers show the latest completed sample between worker replies.

Neural outputs feed an **engineered task readout**, optionally calibrated with
teacher examples. This is not evidence that a biological fly understands music,
cards, baseball, or drone controls. Causal control can perform poorly. Missing
model assets must not trigger synthetic activity or scripted autonomous motor
fallback. Silencing removes neural motor output, while gravity and momentum can
continue moving physical objects.

`tests/neural-display.test.ts` checks exact copying, inhibition, and malformed
frames. Runtime and adapter tests separately check downstream spiking and action
causality. New recording reports must match model frames to actual motor commands.

## Original Illustrative Mode

The remainder documents the earlier prototypes and their original recordings,
not the current neural adapters. Calling legacy `update()` after entering neural
mode throws instead of silently mixing synthetic and simulated activity.

Flythoven, Flyout, and Flylot share `src/activityConnectome.ts` and the independently
testable diffusion model in `src/connectomeActivity.ts`. Blackjack keeps its
existing larger, interactive connectome inspector.

## Anatomy and interpretation

The bundled MaleCNS v1.0 export contains 139,662 classified neurons with measured
soma positions and the strongest 60,000 retained directed connections. Dataset
URLs, licenses, selection rules, byte lengths, and SHA-256 hashes are recorded in
`public/connectome/manifest.json`. These are structural synapse counts, not
trained policy weights. The export includes central nervous system anatomy;
the display is not a cellular morphology reconstruction.

The four normalized inputs are **synthetic display signals**. Broad annotation
classes determine where they enter the display; those assignments do not assert
that a real fly has music, baseball, or drone-specific circuits. Each step mixes
the drive with incoming activity over normalized log-count anatomical weights.
Unstimulated activity decays; pause freezes diffusion and visual packet motion.
Bright moving packets are an illustration of propagation, not recorded spikes,
membrane potentials, consciousness, or neural control of the simulation.

| Activity | Events projected | Actual controller |
| --- | --- | --- |
| Flythoven | Score notes, manual key presses, limb motion, phrase changes | Public-domain Beethoven score and audio transport |
| Flyout | Pitch tracking, swing, pursuit, possession, catch, scoring | Arcade state machine and fielding logic |
| Flylot | Velocity, turning, guidance, manual commands, contact | Cruise route or user input with Rapier physics |

## Integration

Construct one `ActivityConnectome` with the activity's existing Three.js renderer.
Call `update(now, signal)` before rendering the world, then `render()` afterward.
The latter draws a scissored inset and restores renderer state. Optional
`createMiniature()` returns a world-space group with a stable one-in-six sample
of measured positions and the same activity values. It is a second view of the
active subject's event projection, **not nine independent simulated brains**.
Call `dispose()` with the scene lifecycle.

Anatomy is fetched once per page and validated against manifest dimensions and
byte lengths. Diffusion and GPU activity-buffer uploads are limited to 20 Hz.
The full inset adds two draw calls; the miniature adds one. No additional WebGL
context, physics loop, external API, or large runtime dependency is needed.

## Verification

`npm test` covers directionality, normalization, bounds, decay, pause, and malformed
edges. Browser tests check anatomical loading, visible canvas pixels, changing
activity, pause behavior, and mobile layout. The recording scripts wait for both
the scene and anatomy before capturing normal playback to QuickTime-compatible
H.264 MP4 files under `docs/media/`.

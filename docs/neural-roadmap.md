# From Oracle to Connectome Controller

The casino environment and decision instrumentation run. A biological neural controller is still missing. Downloading the wiring does not supply neuronal dynamics or a learned blackjack strategy.

## What Exists

The MaleCNS v1.0 annotation, neurotransmitter, and full segment connectivity files have been downloaded locally. Source URLs, sizes, and local SHA-256 digests are recorded in `data/raw/manifest.json`. `scripts/build_connectome_seed.py` reads the real schema with Polars. Its output is an annotation sample and metadata, not a simulated circuit.

The browser now uses 139,662 measured soma locations and the 60,000 strongest qualifying edges with located endpoints. `scripts/build_connectome_view.py` exports the binary assets and provenance manifest. A positive, bounded diffusion process spreads task-phase input through those retained edges to color the anatomical view. These are illustrative, dimensionless activity values. The mathematical policy chooses game actions; no spikes, membrane potentials, synaptic currents, adaptation, or learned policy weights are involved.

## Remaining Work

1. Select a functional circuit. The display already joins edge IDs to located, classified neurons and pins hashes, but a strongest-edge display subset is not a validated circuit. Join neurotransmitter `body`, account for missing somata and omitted weaker edges, and document a physiological selection rule. Structural weights need an explicit conversion to model synaptic effects; neurotransmitter predictions alone do not fully determine signs or strengths.
2. Add neuron dynamics. Reproduce a known circuit response before attaching the game. Use a published model and validate numerical behavior before optimizing a Rust/WASM implementation. Delays, membrane and synaptic time constants, thresholds, reset, refractory behavior, input gain, and stochastic drive must be specified.
3. Encode observations. Map visible game features into injected currents or spike trains at selected input neurons. This is an engineered interface: there is no demonstrated innate card-number or blackjack representation. A symbolic encoder is a tractable first step; image-to-spike visual processing is a separate task.
4. Train an action readout. Use circuit activity to score Hit, Stand, Double, and Split subject to legal-action masks. A first experiment could freeze the anatomical recurrent graph and train an output layer from activity, using teacher labels or episode rewards. Keep oracle values outside inference inputs when testing whether the controller learned the task. A readout trained on an uninformative circuit might fail; learning must be demonstrated, not assumed.
5. Evaluate and instrument. Compare held-out shuffle seeds against random play, a simple policy, and the exact oracle. Measure reward, EV regret, response time, activity variance, and seed repeatability. Silencing and shuffled-wiring controls test whether connectivity contributes. Only then label recorded activity as simulated neural activity, with neuron IDs and units.

[Shiu and colleagues' published model repository](https://github.com/philshiu/Drosophila_brain_model) is a practical reference: it uses Brian 2 to report spike times and rates after activating or silencing FlyWire neurons. Its data are from the female FlyWire brain (v630, with instructions for v783), not MaleCNS. Reproducing that supplied model would be a faster starting point for validated dynamics; adapting it to MaleCNS requires explicit cell/data mapping and model validation. Its blackjack interface would still need training.

Brian 2 with generated native code is a reasonable first validation backend. A sparse Rust/WASM runtime becomes useful after we have a reference trace and a measured bottleneck. The fly's 3D gestures are kinematic; a biomechanical body is not required for the four discrete game actions.

## State, Actions, and Complexity

| Layer | Representation |
| --- | --- |
| Environment state | Shuffled physical cards, remaining order, both hands, round, status, accumulated reward |
| Policy observation | Player ranks/total/soft ace, dealer upcard, ten unseen rank counts, legal actions |
| Hidden information | Future shuffled order; there is no pre-dealt hole card under these rules |
| Actions | Hit, Stand, Double, Split; legality depends on active hand and split rules |
| Rewards | Per hand: loss -bet, push 0, win +bet; unsplit natural +1.5; round reward sums hands |
| Current policy | Exact single-hand H/S/D EV; coupled split-round rollout estimates; optional selection noise |
| Proposed neural policy | State encoder, recurrent connectome dynamics, trained action readout |

The observation contains perfect card-count information from previous public draws. A future memory-limited agent should instead receive new card events and maintain its own count; performance would then include memory errors.

Going from one to eight decks does not add action types or neural dimensions. Each draw still has at most ten value branches. It enlarges the reachable composition state space; low totals and many soft-ace continuations are costly for exact search. Canonical hand states and mixed-radix composition keys avoid recomputing equivalent branches, and the Web Worker keeps rendering responsive. Double adds a bounded one-card branch. Split couples multiple hands and one dealer through a shared finite shoe, so this implementation uses explicitly labeled Monte Carlo estimates under a frozen-composition continuation policy. Their sampling intervals do not capture policy approximation error.

For a neural controller, runtime depends mainly on selected neurons, active edges, timesteps, and readout size. Additional decks change input statistics and learning difficulty, not automatically neuron count or per-step computational complexity. Split/double/betting or learning card-count memory would increase the task more directly than adding decks.

The first meaningful neural milestone is a reproducible stimulus-to-spike-to-action experiment with real edges and ablation controls. An animated real graph alone does not establish a thinking or blackjack-playing fly.

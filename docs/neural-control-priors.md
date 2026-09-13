# Neural Control: Prior Work and Claim Boundaries

A connectome is structural evidence, not a downloadable task-trained policy.
An input encoder, neural dynamics, an output interface, and a body or game still
need to be specified. Their biological validity is a separate question from
whether the resulting application works.

## Relevant Prior Work

- [Shiu et al., Nature 2024](https://www.nature.com/articles/s41586-024-07763-9)
  used a connectome-based leaky integrate-and-fire model to predict specific
  feeding and grooming circuit responses, with experimental checks. This is
  evidence for those sensorimotor transformations, not arbitrary task competence.
- [Eon's March 2026 technical explanation](https://eon.systems/updates/embodied-brain-emulation)
  describes selected descending-neuron outputs influencing existing body
  controllers. It explicitly acknowledges hand-chosen mappings, incomplete
  motor circuitry, and missing learning and internal-state mechanisms. This is
  a closed-loop hybrid, not evidence that every movement emerges directly from
  the measured wiring without additional control machinery.
- [Flybody, Nature 2025](https://www.nature.com/articles/s41586-025-09029-4)
  demonstrates detailed biomechanics with trained locomotion controllers. The
  body and its learned movement policies are distinct from a connectome model.
- [Morra and Daley, 2022 preprint](https://arxiv.org/abs/2201.09359)
  studies a fly-connectome-derived reservoir with a trained readout for time
  series prediction. This is a closer conceptual precedent for our engineered
  task interfaces, but does not validate our spiking model or musical ability.
- [FlyGM, 2026 preprint](https://arxiv.org/abs/2602.17997)
  uses the whole-brain connectome as an architectural constraint for a graph
  controller trained with reinforcement learning. Learning a successful policy
  on an anatomical graph is not the same as recovering the original animal's
  physiological state or learned behavior.
- [Infinite Sugar's project README](https://github.com/cnqso/infinite-sugar)
  distinguishes feeding/head/antenna movement tied to neural activity from
  supplied wing and foot-motion patterns. This is a useful example of explicit
  disclosure in a browser artwork; we have not independently audited its code.

An instructive counterexample is Brunton and colleagues'
[The Digital Sphinx](https://faculty.washington.edu/tuthill/docs/TheSphinx_2026.pdf):
a worm connectome plus a trained motor decoder can produce realistic walking
in a fly body. The authors use this deliberately biologically implausible
combination to demonstrate why convincing motion and neural traces do not, by
themselves, validate a biological explanation.

## What Housefly Does

The experimental local neural mode uses threshold-pruned MaleCNS connectivity,
assumed LIF dynamics and transmitter signs, engineered sensory stimulation,
and task-specific readouts of simulated downstream firing rates. Recurrent
structural weights stay fixed. Task learning belongs to the readouts, not to
validated biological plasticity. The rendered activity comes from modeled
voltages and spikes, not recordings of a living fly.

Piano score targets are supplied as sensory information and calibration labels;
the model does not read the rendered sheet music. Motor commands go through an
engineered leg actuator. Better note accuracy would demonstrate task learning
in this system, not that biological flies understand Beethoven. Older clips
and explicit baseline modes use separate scripted or mathematical controllers.

## Evidence Required

1. Trace each executed action to its actual neural frame; prohibit hidden expert
   replacements and keep display frames consistent with action selection.
2. Test neural silence and disconnected edges. These establish dependence on
   the modeled signal path, not a special advantage of fly wiring.
3. Evaluate frozen readouts on independent seeds, timings, and input sequences;
   report errors, misses, extra actions, and latency, not just a selected video.
4. Compare against direct-input and matched randomized-network baselines before
   claiming connectome-specific computational benefit. This comparison is not
   yet established for these activities.
5. Compare modeled responses with biological measurements before making claims
   about actual fly cognition or circuit function.

The isolated-channel diagnostic `node neural/scripts/encoding_probe.ts` checks
whether downstream features preserve input identity across Poisson seeds. Its
classification result is not a measure of chord discrimination, musical skill,
or biological accuracy. Testing mixed and rapidly changing inputs remains
necessary for a useful controller.

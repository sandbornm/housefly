"""Independent Brian2 linear integrator and Synapses validation at dt=0.2 ms."""
import csv
import io
import json
from pathlib import Path
import subprocess

import brian2 as b
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
trace = subprocess.check_output([str(ROOT / "neural/target/release/validate"), "fixture"], text=True)
rows = list(csv.DictReader(io.StringIO(trace)))
expected = np.array([[float(row[f"{field}{i}"]) for i in range(4) for field in ("v", "g")] for row in rows])
expected_spikes = [(int(row["tick"]), i) for row in rows for i, bit in enumerate(row["spikes"]) if bit == "1"]

b.start_scope()
b.prefs.codegen.target = "numpy"
b.defaultclock.dt = 0.2 * b.ms
neurons = b.NeuronGroup(4, """
dv/dt = (-52*mV-v+g)/(20*ms) : volt (unless refractory)
dg/dt = -g/(5*ms) : volt (unless refractory)
blocked_until : second
""", threshold="v > -45*mV", reset="v=-52*mV; g=0*mV; blocked_until=t+dt+2.2*ms",
    refractory="t < blocked_until - 0.00001*dt", method="exact")
neurons.v = -52 * b.mV
synapses = b.Synapses(neurons, neurons, "w: volt", on_pre="g_post += w", delay=1.8 * b.ms)
synapses.connect(i=[0, 0, 1], j=[1, 2, 3])
synapses.w = np.array([250, -250, 250]) * 0.275 * b.mV
# Brian timestamps threshold events at interval start. Running delayed synapses
# before the next integration aligns delivery with our end-stamped events.
synapses.pre.when = "before_groups"

@b.network_operation(when="start", order=-1)
def boundary():
    tick = int(round(float(b.defaultclock.t / b.defaultclock.dt)))
    allowed = np.asarray(neurons.blocked_until / b.ms) <= tick * 0.2 + 1e-10
    neurons.not_refractory = allowed
    if tick in [0, 2, 11, 12, 80, 160, 161, 300] and allowed[0]:
        neurons.v[0] += 68.75 * b.mV
    if tick == 20 and allowed[2]:
        neurons.v[2] -= 3 * b.mV
        neurons.g[2] += 2 * b.mV

states = b.StateMonitor(neurons, ["v", "g"], record=True, when="end")
spikes = b.SpikeMonitor(neurons)
network = b.Network(neurons, synapses, boundary, states, spikes)
network.run(len(rows) * 0.2 * b.ms)
observed = np.stack([np.asarray(getattr(states, field)[i] / b.mV) for i in range(4) for field in ("v", "g")], axis=1)
observed_spikes = sorted((int(round(float(t / b.defaultclock.dt))) + 1, int(i)) for i, t in zip(spikes.i, spikes.t))
error = float(np.max(np.abs(observed - expected)))
if error >= 1e-9 or sorted(expected_spikes) != observed_spikes:
    worst = np.unravel_index(np.argmax(np.abs(observed - expected)), observed.shape)
    raise AssertionError({"maximumAbsoluteMvError": error, "worst": str(worst), "rust": float(expected[worst]), "brian": float(observed[worst]),
                          "expectedSpikes": expected_spikes, "observedSpikes": observed_spikes})
report = {"brian2Version": b.__version__, "dtMs": 0.2, "durationMs": len(rows) * 0.2,
          "maximumAbsoluteMvError": error, "spikeTimesEqual": True, "spikeEvents": observed_spikes,
          "schedule": "Boundary stimuli and delayed synapses, exact integration, end threshold/reset. Brian start-stamped spikes are reported at t+dt; refractory deadline is t+dt+2.2ms.",
          "scope": "Four-neuron signed structural fixture: voltage/current traces, excitation, inhibition, 1.8ms delayed propagation, 2.2ms refractory freeze and rejected impulses. Not whole-brain physiological validation."}
(ROOT / "neural/fixtures/brian2-report.json").write_text(json.dumps(report, indent=2) + "\n")
(ROOT / "neural/fixtures/reference-trace.csv").write_text(trace)
print(json.dumps(report, indent=2))

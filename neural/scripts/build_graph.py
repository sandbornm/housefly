"""Reproduce the complete threshold-pruned MaleCNS model using Polars only."""
from array import array
from collections import Counter
import hashlib
import json
from pathlib import Path
import sys

import polars as pl

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data/raw"
OUT = ROOT / "public/neural"
SHARD_BYTES = 12_000_000
SIGNS = {"acetylcholine": 1, "gaba": -1, "glutamate": -1, "histamine": -1}


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def packed(code, values):
    value = array(code, values)
    if sys.byteorder != "little":
        value.byteswap()
    return value.tobytes()


def artifact(name, data):
    shards = []
    for offset in range(0, len(data), SHARD_BYTES):
        chunk = data[offset:offset + SHARD_BYTES]
        path = OUT / f"{name}.{offset // SHARD_BYTES:03d}.bin"
        path.write_bytes(chunk)
        shards.append({"url": path.name, "bytes": len(chunk), "sha256": hashlib.sha256(chunk).hexdigest()})
    return {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "shards": shards}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    source = json.loads((RAW / "manifest.json").read_text())
    for filename, info in source["files"].items():
        path = RAW / filename
        assert path.stat().st_size == info["bytes"] and digest(path) == info["sha256"], filename
    annotations = pl.read_ipc(RAW / "body-annotations-male-cns-v1.0-minconf-0.5.feather",
                              columns=["bodyId", "type", "superclass", "somaLocation"])
    nodes = annotations.filter(pl.col("superclass").is_not_null() & pl.col("somaLocation").is_not_null()).sort("bodyId")
    assert nodes.height == 139662
    ids = nodes["bodyId"].to_list()
    id_data = packed("I", ids)
    assert id_data == (ROOT / "public/connectome/ids.u32.bin").read_bytes(), "Display ordering differs"
    nts = pl.read_ipc(RAW / "body-neurotransmitters-male-cns-v1.0.feather", columns=["body", "consensus_nt", "predicted_nt"])
    assert nts["body"].n_unique() == nts.height
    nodes = nodes.join(nts, left_on="bodyId", right_on="body", how="left", maintain_order="left").with_row_index("index")
    signs = [SIGNS.get(nt, 0) for nt in nodes["consensus_nt"]]
    mapping = nodes.select(pl.col("bodyId"), pl.col("index"))
    raw_edges = pl.scan_ipc(RAW / "connectome-weights-male-cns-v1.0-minconf-0.5.feather")
    raw_count = raw_edges.select(pl.len()).collect().item()
    endpoints = raw_edges.join(mapping.lazy().rename({"bodyId": "body_pre", "index": "pre"}), on="body_pre", how="inner").join(
        mapping.lazy().rename({"bodyId": "body_post", "index": "post"}), on="body_post", how="inner")
    endpoint_count = endpoints.select(pl.len()).collect().item()
    edges = endpoints.filter(pl.col("weight") >= 5).select("pre", "post", "weight").sort("pre", "post").collect()
    assert endpoint_count == 23229236 and edges.height == 5536347
    print(f"Retained {nodes.height:,} neurons, {edges.height:,} edges", flush=True)
    pres = edges["pre"].to_list()
    posts = edges["post"].to_list()
    weights = edges["weight"].to_list()
    counts = Counter(pres)
    offsets = [0]
    for i in range(nodes.height):
        offsets.append(offsets[-1] + counts[i])
    signed = [weight * signs[pre] for pre, weight in zip(pres, weights)]

    # Evenly spaced body-ID ranks, with no behavioral labels or fitted weights.
    visual = nodes.filter(pl.col("superclass") == "visual_projection")["index"].to_list()
    selected = [visual[i * len(visual) // 512] for i in range(512)]
    inputs = [selected[i * 16:(i + 1) * 16] for i in range(32)]
    input_set = set(selected)
    candidates = set(nodes.filter(pl.col("superclass").is_in(["cb_intrinsic", "descending_neuron"]))["index"].to_list()) - input_set
    scores = Counter()
    for pre, post, weight in zip(pres, posts, weights):
        if pre in input_set and post in candidates and signs[pre] == 1:
            scores[post] += weight
    ranked = sorted(candidates, key=lambda i: (-scores[i], ids[i]))
    # 128 disjoint pools of 16; rank-striding distributes structural drive.
    outputs = [ranked[i:2048:128] for i in range(128)]
    assert len(set(sum(outputs, []))) == 2048 and not input_set.intersection(sum(outputs, []))
    pool_ids = [65535] * nodes.height
    for pool, members in enumerate(outputs):
        for node in members:
            pool_ids[node] = pool

    artifacts = {
        "ids": artifact("ids.u32", id_data),
        "offsets": artifact("offsets.u32", packed("I", offsets)),
        "targets": artifact("targets.u32", packed("I", posts)),
        "weights": artifact("weights.i32", packed("i", signed)),
        "signs": artifact("signs.i8", packed("b", signs)),
        "inputs": artifact("inputs.u32", packed("I", selected)),
        "pools": artifact("pools.u16", packed("H", pool_ids)),
    }
    manifest = {
        "schemaVersion": 1, "modelId": "male-cns-v1-lif-dt02-w5-v1", "nodeCount": nodes.height, "edgeCount": edges.height,
        "dataset": "MaleCNS v1.0", "datasetLicense": "CC-BY", "source": source,
        "reference": {"repository": "https://github.com/philshiu/Drosophila_brain_model", "commit": "91bdd1e7dcf193f3e7ca5a8933497fcef63b7960", "license": "MIT"},
        "parameters": {"dtMs": 0.2, "restMv": -52, "resetMv": -52, "thresholdMv": -45, "tauMembraneMs": 20,
                       "tauSynapseMs": 5, "refractoryMs": 2.2, "delayMs": 1.8, "weightMvPerContact": 0.275,
                       "inputImpulseMv": 68.75, "featureTraceTauMs": 50},
        "pruning": {"rawAnnotationRows": annotations.height, "excludedUnlocatedOrUnclassifiedNodes": annotations.height - nodes.height,
                    "rawEdges": raw_count, "excludedEndpointEdges": raw_count - endpoint_count, "retainedEndpointEdgesBeforeThreshold": endpoint_count,
                    "excludedWeightBelow5Edges": endpoint_count - edges.height, "minimumContactCount": 5,
                    "zeroSignEdgesRetained": sum(weight == 0 for weight in signed), "positiveEdges": sum(weight > 0 for weight in signed),
                    "negativeEdges": sum(weight < 0 for weight in signed), "structuralContactsRetained": sum(weights),
                    "effectiveSignedContacts": sum(signed)},
        "transmitters": {"consensusCounts": dict(Counter(nt or "missing" for nt in nodes["consensus_nt"])),
                         "signCounts": dict(Counter(signs)), "signMap": SIGNS, "otherSign": 0,
                         "assumption": "Simplified unvalidated transmitter-to-sign assignment; glutamate is not universally inhibitory. Modulators, unclear, and missing labels have zero fast current; their structural edges remain. predicted_nt is not used as fallback."},
        "inputGroups": inputs, "outputGroups": outputs,
        "groupSelection": {"inputs": "512 evenly spaced body-ID ranks from actual visual_projection neurons; consecutive groups of 16, 32 disjoint channels. Independent seeded Poisson voltage impulses, Hz 0..150.",
                           "outputs": "Eligible cb_intrinsic/descending neurons ranked by summed structural excitatory contacts from selected inputs, ties by bodyId; first 2048 rank-strided over 128 disjoint pools of 16. No direct stimulation or behavioral labels.",
                           "directlyConnectedOutputCandidates": len(scores),
                           "interpretation": "Engineered sensory and measurement interfaces, not innate behavioral circuits or physiological validation."},
        "displayIndices": "identity: ascending bodyId, verified byte-for-byte against public/connectome/ids.u32.bin",
        "artifacts": artifacts,
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"pruning": manifest["pruning"], "transmitters": manifest["transmitters"], "groupSelection": manifest["groupSelection"]}, indent=2))


if __name__ == "__main__":
    main()

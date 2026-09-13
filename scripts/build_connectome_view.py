#!/usr/bin/env python3
"""Export measured MaleCNS soma positions and a bounded real-edge display subset."""
from __future__ import annotations

import array
import hashlib
import json
import sys
from pathlib import Path

import polars as pl

RAW = Path("data/raw")
OUT = Path("public/connectome")


def binary(name: str, values: array.array) -> dict:
    if sys.byteorder != "little":
        values.byteswap()
    data = values.tobytes()
    (OUT / name).write_bytes(data)
    return {"url": f"/connectome/{name}", "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    neurons = pl.read_ipc(RAW / "body-annotations-male-cns-v1.0-minconf-0.5.feather",
                         columns=["bodyId", "type", "superclass", "somaLocation"])
    neurons = neurons.filter(pl.col("superclass").is_not_null() & pl.col("somaLocation").is_not_null()).sort("bodyId")
    classes = sorted(neurons["superclass"].unique().to_list())
    ids = neurons["bodyId"]
    print(f"Located neurons: {len(ids):,}", flush=True)
    edges = (pl.scan_ipc(RAW / "connectome-weights-male-cns-v1.0-minconf-0.5.feather")
             .filter((pl.col("weight") >= 5) & pl.col("body_pre").is_in(ids.implode()) & pl.col("body_post").is_in(ids.implode()))
             .top_k(60000, by=["weight", "body_pre", "body_post"])
             .collect(engine="streaming").sort(["body_pre", "body_post"]))
    lookup = {body: index for index, body in enumerate(ids)}
    xyz = neurons["somaLocation"].to_list()
    mins = [min(p[i] for p in xyz) for i in range(3)]
    maxs = [max(p[i] for p in xyz) for i in range(3)]
    centers = [(a + b) / 2 for a, b in zip(mins, maxs)]
    scale = max(b - a for a, b in zip(mins, maxs))
    positions = array.array("f")
    for x, y, z in xyz:
        positions.extend(((x - centers[0]) / scale, -(z - centers[2]) / scale, (y - centers[1]) / scale))
    connections = array.array("I")
    for pre, post, weight in edges.iter_rows():
        connections.extend((lookup[pre], lookup[post], weight))
    artifacts = {
        "positions": binary("positions.f32.bin", positions),
        "ids": binary("ids.u32.bin", array.array("I", ids)),
        "classes": binary("classes.u8.bin", array.array("B", (classes.index(c) for c in neurons["superclass"]))),
        "edges": binary("edges.u32.bin", connections),
    }
    metadata = {
        "dataset": "MaleCNS v1.0", "source": "https://male-cns.janelia.org/download/", "license": "CC-BY",
        "nodeCount": neurons.height, "edgeCount": edges.height, "classes": classes,
        "coordinates": "Measured somaLocation in 8 nm voxels; centered and uniformly scaled; display axes x,-z,y.",
        "selection": "Classified neurons with soma coordinates; strongest 60,000 connections with weight >= 5 and both endpoints retained. Lexical body-ID tie break.",
        "activityModel": "Illustrative event-driven diffusion on the retained edges. No fitted neuron dynamics or learned game policy.",
        "artifacts": artifacts, "inputManifest": json.loads((RAW / "manifest.json").read_text()),
    }
    (OUT / "manifest.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(f"Exported {neurons.height:,} somata and {edges.height:,} measured edges to {OUT}")


if __name__ == "__main__":
    main()

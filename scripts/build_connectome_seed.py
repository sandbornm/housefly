#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path

RAW = Path("data/raw")
OUT = Path("src/data/generatedConnectomeSeed.json")
ANNOTATIONS = RAW / "body-annotations-male-cns-v1.0-minconf-0.5.feather"
WEIGHTS = RAW / "connectome-weights-male-cns-v1.0-minconf-0.5.feather"


def main() -> None:
    try:
        import polars as pl
    except ImportError:
        raise SystemExit(
            "This script needs polars to scan Feather files quickly. "
            "Install it with: python3 -m pip install -r requirements.txt"
        )

    if not ANNOTATIONS.exists() or not WEIGHTS.exists():
        raise SystemExit(
            "Download annotations and weights first:\n"
            "  npm run download:annotations\n"
            "  npm run download:connectome"
        )

    annotations_lazy = pl.scan_ipc(ANNOTATIONS)
    annotation_columns = set(annotations_lazy.collect_schema().names())
    columns = [col for col in ("bodyId", "type", "class", "superclass", "somaSide") if col in annotation_columns]
    annotation_subset = annotations_lazy.select(columns)
    if columns:
        annotation_subset = annotation_subset.filter(pl.any_horizontal(pl.col(col).is_not_null() for col in columns))
    sample = annotation_subset.head(48).collect().to_dicts()

    # Keep the generated artifact intentionally small. The browser demo wants a
    # traceable summary, while serious analyses should query the Feather/neuPrint data.
    weights_lazy = pl.scan_ipc(WEIGHTS)
    edge_count = int(weights_lazy.select(pl.len().alias("rows")).collect().item())
    annotation_count = int(annotations_lazy.select(pl.len().alias("rows")).collect().item())
    payload = {
        "source": "MaleCNS v1.0 flat connectome",
        "sourceUrl": "https://male-cns.janelia.org/download/",
        "note": "All-segment row count and annotation sample only; no circuit or dynamics are generated.",
        "weightsSchema": {name: str(dtype) for name, dtype in weights_lazy.collect_schema().items()},
        "inputManifest": json.loads((RAW / "manifest.json").read_text()) if (RAW / "manifest.json").exists() else None,
        "annotationsRows": annotation_count,
        "weightsRows": edge_count,
        "sampleAnnotations": sample,
    }
    OUT.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()

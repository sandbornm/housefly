"""Package a built WASM artifact and record reproducible transfer sizes."""
import gzip
import hashlib
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public/neural"
source = ROOT / "neural/target/wasm32-unknown-unknown/release/male_cns_lif.wasm"
target = OUT / "male_cns_lif.wasm"
shutil.copyfile(source, target)
shutil.copyfile(ROOT / "neural/reference/LICENSE", OUT / "REFERENCE-LICENSE.txt")
manifest = json.loads((OUT / "manifest.json").read_text())
data = target.read_bytes()
manifest["wasm"] = {"url": target.name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
transfers = []
for path in sorted(OUT.iterdir()):
    if path.suffix not in [".bin", ".wasm"]:
        continue
    content = path.read_bytes()
    assert len(content) < 16_000_000
    transfers.append({"url": path.name, "bytes": len(content), "gzipBytes": len(gzip.compress(content, compresslevel=9, mtime=0))})
manifest["transfer"] = {"files": transfers, "rawBytes": sum(f["bytes"] for f in transfers),
                        "gzipBytes": sum(f["gzipBytes"] for f in transfers),
                        "note": "Measured gzip level 9, not guaranteed CDN compression; .bin responses may transfer uncompressed. Every artifact is below 16 MB."}
(OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(json.dumps({"wasm": manifest["wasm"], "transfer": manifest["transfer"]}, indent=2))

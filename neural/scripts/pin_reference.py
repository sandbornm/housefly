"""Fetch the pinned, MIT-licensed scientific reference for offline inspection."""
import hashlib
import json
from pathlib import Path
import urllib.request

COMMIT = "91bdd1e7dcf193f3e7ca5a8933497fcef63b7960"
OUT = Path(__file__).resolve().parents[1] / "reference"
files = {}
for name in ["model.py", "LICENSE"]:
    url = f"https://raw.githubusercontent.com/philshiu/Drosophila_brain_model/{COMMIT}/{name}"
    with urllib.request.urlopen(url, timeout=30) as response:
        data = response.read()
    (OUT / name).write_bytes(data)
    files[name] = {"url": url, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
(OUT / "upstream.json").write_text(json.dumps({"commit": COMMIT, "files": files}, indent=2) + "\n")
print(json.dumps(files, indent=2))

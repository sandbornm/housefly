#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

BASE_URL = "https://storage.googleapis.com/flyem-male-cns/v1.0/connectome-data/flat-connectome"
FILES = {
    "annotations": ("body-annotations-male-cns-v1.0-minconf-0.5.feather", "13 MB"),
    "neurotransmitters": ("body-neurotransmitters-male-cns-v1.0.feather", "42 MB"),
    "stats": ("body-stats-male-cns-v1.0-minconf-0.5.feather", "780 MB"),
    "weights": ("connectome-weights-male-cns-v1.0-minconf-0.5.feather", "1.1 GB"),
    "syn_points": ("syn-points-male-cns-v1.0-minconf-0.5.feather", "12.7 GB"),
    "syn_partners": ("syn-partners-male-cns-v1.0-minconf-0.5.feather", "6.8 GB"),
    "tbar_neurotransmitters": ("tbar-neurotransmitters-male-cns-v1.0.feather", "2.7 GB"),
}


def human_size(bytes_count: int) -> str:
    value = float(bytes_count)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if value < 1024 or unit == "TB":
            return f"{value:.1f} {unit}"
        value /= 1024
    return f"{bytes_count} B"


def download(name: str, destination: Path) -> None:
    filename, expected = FILES[name]
    url = f"{BASE_URL}/{filename}"
    target = destination / filename
    if target.exists():
        print(f"{filename} already exists ({human_size(target.stat().st_size)})")
        return

    print(f"Downloading {filename} ({expected})")
    print(url)
    tmp = target.with_suffix(target.suffix + ".part")
    digest = hashlib.sha256()
    with urllib.request.urlopen(url, timeout=60) as response, tmp.open("wb") as out:
        total_header = response.headers.get("Content-Length")
        total = int(total_header) if total_header else 0
        downloaded = 0
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            out.write(chunk)
            digest.update(chunk)
            downloaded += len(chunk)
            if total:
                percent = downloaded / total * 100
                sys.stdout.write(f"\r  {percent:5.1f}% {human_size(downloaded)} / {human_size(total)}")
            else:
                sys.stdout.write(f"\r  {human_size(downloaded)}")
            sys.stdout.flush()
        if total and downloaded != total:
            raise RuntimeError(f"Incomplete transfer: expected {total} bytes, received {downloaded}")
    print()
    tmp.rename(target)
    manifest_path = destination / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {
        "dataset": "MaleCNS v1.0", "source": "https://male-cns.janelia.org/download/", "files": {}
    }
    manifest["files"][filename] = {"url": url, "bytes": downloaded, "sha256": digest.hexdigest()}
    manifest_tmp = manifest_path.with_suffix(".json.part")
    manifest_tmp.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    manifest_tmp.replace(manifest_path)
    print(f"Saved {target}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Download MaleCNS v1.0 flat-connectome files.")
    for key, (_filename, size) in FILES.items():
        parser.add_argument(f"--{key.replace('_', '-')}", action="store_true", help=f"download {key} ({size})")
    parser.add_argument("--all", action="store_true", help="download every flat-connectome file; this is very large")
    parser.add_argument("--dest", default="data/raw", help="output directory")
    args = parser.parse_args()

    selected = [key for key in FILES if getattr(args, key)]
    if args.all:
        selected = list(FILES)
    if not selected:
        print("Choose at least one file, for example: npm run download:connectome")
        return

    destination = Path(args.dest)
    destination.mkdir(parents=True, exist_ok=True)
    for key in selected:
        download(key, destination)


if __name__ == "__main__":
    main()

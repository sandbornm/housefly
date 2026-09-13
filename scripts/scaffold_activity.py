#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


def slug(value: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    if not cleaned:
        raise SystemExit("Activity id must contain at least one letter or number.")
    return cleaned


def main() -> None:
    parser = argparse.ArgumentParser(description="Create a starter Drosophila Sims activity spec.")
    parser.add_argument("--id", required=True, help="stable activity id, for example odor-trail")
    parser.add_argument("--title", required=True, help="human-facing activity title")
    args = parser.parse_args()

    activity_id = slug(args.id)
    target_dir = Path("src/activities")
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"{activity_id}.json"
    if target.exists():
        raise SystemExit(f"{target} already exists")

    payload = {
        "id": activity_id,
        "title": args.title,
        "status": "draft",
        "sensoryTrace": ["optic", "mushroom", "central"],
        "motorTrace": ["central", "dn", "vnc"],
        "notes": "Add task-specific state, rendering, controls, and policy code before exposing this activity in the catalog.",
    }
    target.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {target}")


if __name__ == "__main__":
    main()

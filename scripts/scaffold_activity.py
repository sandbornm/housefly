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
    parser = argparse.ArgumentParser(description="Create a Housefly neural task adapter and activity spec.")
    parser.add_argument("--id", required=True, help="stable activity id, for example odor-trail")
    parser.add_argument("--title", required=True, help="human-facing activity title")
    args = parser.parse_args()

    activity_id = slug(args.id)
    target_dir = Path("src/activities")
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"{activity_id}.json"
    adapter = target_dir / f"{activity_id}.ts"
    for path in (target, adapter):
        if path.exists():
            raise SystemExit(f"{path} already exists")

    payload = {
        "id": activity_id,
        "title": args.title,
        "status": "draft",
        "encoderVersion": f"{activity_id}-32-v1",
        "controller": "connectome-readout",
        "notes": "Define observable sensory inputs, legal actions and actuators. The readout starts untrained. See docs/neural-tasks.md before registering a scene.",
    }
    source = '''import { NeuralReadout, NeuralTaskController } from "../neural/index.ts";
import type { NeuralTaskAdapter, TaskNeuralRuntime } from "../neural/index.ts";

// Replace these action names with the commands your environment can execute.
export const ACTIONS = ["move", "wait"] as const;
export type Action = typeof ACTIONS[number];

export interface Observation {
  // Your encoder must map observable state to 32 rates in 0..150 Hz.
  sensoryHz: readonly number[];
  legal: readonly Action[];
}

export const adapter: NeuralTaskAdapter<Observation, Action> = {
  id: TASK_ID,
  encoderVersion: ENCODER_VERSION,
  actions: ACTIONS,
  encode: observation => Float32Array.from(observation.sensoryHz),
  legalActions: observation => observation.legal,
};

export function createController(runtime: TaskNeuralRuntime, modelId: string, seed = 1977) {
  const readout = new NeuralReadout({ actions: ACTIONS, modelId, seed });
  return new NeuralTaskController(runtime, readout, adapter);
}
'''.replace("TASK_ID", json.dumps(activity_id)).replace("ENCODER_VERSION", json.dumps(payload["encoderVersion"]))
    with target.open("x", encoding="utf-8") as output:
        output.write(json.dumps(payload, indent=2) + "\n")
    with adapter.open("x", encoding="utf-8") as output:
        output.write(source)
    print(f"Wrote {target} and {adapter}. Next: docs/neural-tasks.md")


if __name__ == "__main__":
    main()

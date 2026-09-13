import { NEURAL_STEP_MS, PIANO_ENCODER, projectPianoChannels } from "./sensory.ts";
import type { PianoInputProfile } from "./sensory.ts";
import type { PianoNeuralDecoder } from "./neural-model.ts";
import { ASSOCIATED_PIANO_ENCODER } from "./sensory-associated.ts";
import { PIANO_DUAL_DECODER } from "./neural-dual.ts";
import type { PianoDualDecoder } from "./neural-dual.ts";

interface CalibrationBase {
  encoder: string; modelId: string; nodes: number; edges: number;
  neuralStepMs: number; wallStepMs: number;
  provenance: { kind: "offline-balanced"; trainingFrames: number; epochs: number; trainingSeeds: number[]; heldoutSeeds: number[]; improved: boolean };
}
export type PianoCalibration = CalibrationBase & (
  { schema: 2; profile: PianoInputProfile; weights: ReturnType<PianoNeuralDecoder["export"]> }
  | { schema: 3; architecture: typeof PIANO_DUAL_DECODER; weights: ReturnType<PianoDualDecoder["export"]> }
);

export function validatePianoCalibration(value: unknown, graph: { modelId: string; nodeCount: number; edgeCount: number }): PianoCalibration {
  if (!value || typeof value !== "object") throw new Error("Piano calibration missing");
  const data = value as PianoCalibration;
  if (data.modelId !== graph.modelId || data.nodes !== graph.nodeCount || data.edges !== graph.edgeCount
    || data.neuralStepMs !== NEURAL_STEP_MS || data.wallStepMs !== 50 || data.weights?.encoder !== data.encoder
    || data.provenance?.kind !== "offline-balanced" || !Number.isSafeInteger(data.provenance.trainingFrames) || data.provenance.trainingFrames < 1 || data.provenance.trainingFrames > 4096
    || !Number.isSafeInteger(data.provenance.epochs) || data.provenance.epochs < 1 || data.provenance.epochs > 128 || typeof data.provenance.improved !== "boolean") {
    throw new Error("Piano calibration does not match the graph, encoder, or recurrent timing");
  }
  if (data.schema === 2) {
    if (!data.encoder?.startsWith(`${PIANO_ENCODER}-map-`) || data.profile?.id !== data.encoder || data.weights.version !== "v2" || data.weights.strikeMode !== "edge") throw new Error("Piano mapped encoder mismatch");
    projectPianoChannels(new Float32Array(32), data.profile);
  } else if (data.schema !== 3 || data.encoder !== ASSOCIATED_PIANO_ENCODER || data.architecture !== PIANO_DUAL_DECODER
    || data.weights.schema !== 3 || data.weights.architecture !== PIANO_DUAL_DECODER) throw new Error("Piano pitch/strike encoder mismatch");
  return data;
}

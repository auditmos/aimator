import { newRunId, nowIso } from "./store.js";

/**
 * Provenance: the shape of `<stage>.stage.json`, the bytes-and-digests layer
 * underneath it, and the review that sits on top.
 *
 * Every stage writes the same file shape, so this module exists to keep that
 * a single fact rather than a convention each stage re-implements. Stage 0 was
 * its first caller; stage 1 is the second, which is why it lives here instead
 * of inside `project/`.
 *
 * Nothing here calls a paid API or knows what any particular stage produces.
 */

export {
  approveAll,
  approveArtifacts,
  isApproved,
  verifyOutputs,
  withInputs,
  withOutputs,
} from "./review.js";
export {
  type RecordedFile,
  type StageFile,
  type StageName,
  sha256Schema,
  stageFileSchema,
} from "./schema.js";
export {
  applyWrites,
  emptyDirectories,
  exists,
  listEntries,
  newRunId,
  nowIso,
  readDigest,
  readJson,
  removeFile,
  serialize,
  sha256Of,
  toWorkspacePath,
  type WriteMode,
  type WriteOp,
  writeNew,
  writeNewBytes,
} from "./store.js";

import type { ArtifactRecord, Producer, RecordedFile, StageFile, StageName } from "./schema.js";

const TOOL = "aimator";

interface NewRecordInput {
  readonly inputs: readonly RecordedFile[];
  readonly jobId?: string | null;
  readonly outputs: readonly RecordedFile[];
  readonly producer: Producer;
  readonly runId?: string;
  readonly status?: ArtifactRecord["status"];
}

/** A stage file with no artifacts yet — the starting point every stage writes onto. */
export function emptyStage(stage: StageName): StageFile {
  return { artifacts: {}, stage, version: 1 };
}

/** What a person decided and the tool merely copied. No network behind it. */
export function manualProducer(): Producer {
  return { endpoint: null, kind: "manual", model: null, promptVersion: null, tool: TOOL };
}

/**
 * What a paid call produced. The endpoint, model and prompt version belong in
 * the artifact because "which prompt produced this" has to stay answerable
 * from the workspace, long after the source tree has moved on.
 */
export function modelProducer(input: {
  readonly endpoint: string;
  readonly model: string;
  readonly promptVersion: number;
}): Producer {
  return {
    endpoint: input.endpoint,
    kind: "model",
    model: input.model,
    promptVersion: input.promptVersion,
    tool: TOOL,
  };
}

/**
 * A fresh artifact record. `review` always starts `pending`: writing a result
 * is never the same as somebody accepting it, and there is no argument that
 * sets it otherwise here.
 */
export function newRecord(input: NewRecordInput): ArtifactRecord {
  return {
    inputs: [...input.inputs],
    jobId: input.jobId ?? null,
    needsReview: [],
    outputs: [...input.outputs],
    producedAt: nowIso(),
    producer: input.producer,
    review: { note: null, reviewedAt: null, reviewer: null, status: "pending" },
    runId: input.runId ?? newRunId(),
    status: input.status ?? "completed",
  };
}

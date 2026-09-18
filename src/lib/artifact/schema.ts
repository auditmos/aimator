import { z } from "zod";

/**
 * Internal to the artifact module: the one shape every stage writes.
 *
 * `<stage>.stage.json` is a single filename and a single schema across the
 * whole pipeline, which is what stops each new stage from inventing its own
 * state file. `artifacts` is keyed so one stage can own a set of results
 * (R01..R10, C01..C06) without multiplying files.
 */

const SHA256 = /^[0-9a-f]{64}$/;

export const sha256Schema = z.string().regex(SHA256, "expected a lowercase sha256 hex digest");

/**
 * Every stage named by the contract, not only the implemented ones. The enum
 * is the filename vocabulary: a stage that is not here cannot write a state
 * file, which is the point.
 */
export const stageNames = [
  "prepare",
  "screenplay",
  "character",
  "shot-list",
  "prompt-package",
  "references",
  "opening-frame",
  "clips",
  "assembly",
] as const;

const recordedFileSchema = z.strictObject({ path: z.string().min(1), sha256: sha256Schema });

const reviewSchema = z.strictObject({
  note: z.string().nullable(),
  reviewedAt: z.iso.datetime().nullable(),
  reviewer: z.string().nullable(),
  status: z.enum(["approved", "pending", "rejected"]),
});

/**
 * Who made the artifact. `manual` covers what a person typed and the tool
 * merely copied; `model` records the exact endpoint, model id and prompt
 * version that produced a paid result, because "which prompt was this" has
 * to be answerable from the file rather than from the source tree.
 */
const producerSchema = z.strictObject({
  endpoint: z.string().nullable().default(null),
  kind: z.enum(["manual", "model"]),
  model: z.string().nullable().default(null),
  promptVersion: z.int().nullable().default(null),
  tool: z.string().min(1),
});

const artifactRecordSchema = z.strictObject({
  inputs: z.array(recordedFileSchema),
  /**
   * The paid-call lifecycle, written *before* the POST. Its default is
   * `completed` rather than inferred: a record with no network behind it is
   * finished the moment it is written, so an older file that predates this
   * field genuinely was complete. A default that could be wrong would belong
   * nowhere near this schema.
   */
  jobId: z.string().nullable().default(null),
  needsReview: z.array(z.string()),
  outputs: z.array(recordedFileSchema),
  producedAt: z.iso.datetime(),
  producer: producerSchema,
  review: reviewSchema,
  runId: z.string().min(1),
  status: z.enum(["completed", "submitted"]).default("completed"),
});

export const stageFileSchema = z.strictObject({
  artifacts: z.record(z.string(), artifactRecordSchema),
  stage: z.enum(stageNames),
  version: z.literal(1),
});

export type ArtifactRecord = z.infer<typeof artifactRecordSchema>;
export type Producer = z.infer<typeof producerSchema>;
export type RecordedFile = z.infer<typeof recordedFileSchema>;
export type StageFile = z.infer<typeof stageFileSchema>;
export type StageName = (typeof stageNames)[number];

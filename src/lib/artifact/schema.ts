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
 *
 * `soundtrack` is stage 9's and `sound-design` is stage 10's, which reads
 * backwards for a moment and is right. Stage 9 was named before anyone knew
 * there would be a row below it; by the time this one arrived, the name that
 * described it was taken. Renaming stage 9's would have invalidated every
 * `soundtrack.stage.json` already on disk — a rename that costs a human their
 * recorded approvals to fix a word. So stage 10 takes the name the film
 * industry uses for exactly what it does, music and effects, and the two do
 * not collide.
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
  "soundtrack",
  "sound-design",
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
 *
 * `local` is the third and it arrived with stage 8, which is neither: nobody
 * typed a cut and no model rendered one. It exists because this record answers
 * one question — what would have to run again to get these bytes — and for a
 * locally muxed file the honest answer is the engine and its version. Two
 * releases of a muxer do not necessarily write the same container out of the
 * same clips, and a record saying `manual` would make that unanswerable from
 * the file, which is precisely the failure `producer` was built to prevent.
 * `model` then reads as "which engine produced these bytes"; `endpoint` and
 * `promptVersion` stay null, as they already do for `manual`.
 */
const producerSchema = z.strictObject({
  endpoint: z.string().nullable().default(null),
  kind: z.enum(["local", "manual", "model"]),
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

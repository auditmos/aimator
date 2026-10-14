import { z } from "zod";
import { CHECKS } from "../checklist.js";

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
 * `soundtrack.stage.json` already on disk, a rename that costs a human their
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
  "dialogue",
  "versions",
  // The style frames a project generates per track, from its Style Bible. Not
  // a numbered row of the pipeline: it sits beside stage 2, at the project
  // level, and is consumed by every film frame from stage 5 on.
  "style",
  // A character's voice in one language, and the sample bought to hear it. Not
  // a numbered row either: it sits beside stage 0, whose casting it completes.
  "voice",
  // A document brought in and sorted before any project exists. Not a row and
  // not inside a project: it is material waiting for stage 0, under imports/.
  "import",
  // project.md drafted by a model from an import. Inside stage 0 but not its
  // record: a draft is a proposal a person edits, and stage 0 verifies digests.
  "rules",
] as const;

const recordedFileSchema = z.strictObject({ path: z.string().min(1), sha256: sha256Schema });

const reviewSchema = z.strictObject({
  /**
   * The QC criteria a person confirmed, on the frames accepted against a
   * checklist (the opening frame and every entry frame). Absent everywhere
   * else, and on every approval older than the field.
   */
  checks: z.array(z.enum(CHECKS)).optional(),
  /**
   * The QC criteria a rejection names as failed, on the same frames. Absent on
   * every other rejection, and on everything that was not rejected.
   */
  failed: z.array(z.enum(CHECKS)).optional(),
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
 * one question, what would have to run again to get these bytes, and for a
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

/**
 * One correction a person made by hand to a published output, accepted by an
 * `approve`: which file, the digest it had and the one it has now (`from`,
 * `to`), when, and who said yes.
 */
const amendmentSchema = z.strictObject({
  at: z.iso.datetime(),
  from: sha256Schema,
  path: z.string().min(1),
  reviewer: z.string().min(1),
  to: sha256Schema,
});

const artifactRecordSchema = z.strictObject({
  /**
   * The hand corrections accepted since the outputs were produced, oldest
   * first. `producer` keeps answering what generated the first version; this
   * says a person changed it afterwards, and together they answer what would
   * have to run again to get these bytes. Defaults to empty because every
   * record older than the field was uncorrected.
   */
  amendments: z.array(amendmentSchema).default([]),
  inputs: z.array(recordedFileSchema),
  /**
   * A person's note this attempt corrected the previous version by, verbatim,
   * or `null` for an attempt that was not a correction. The version it
   * corrected is then one of `inputs`, in the run's own `previous/`. Defaults
   * to `null` because every record older than the field was exactly that.
   */
  instruction: z.string().nullable().default(null),
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

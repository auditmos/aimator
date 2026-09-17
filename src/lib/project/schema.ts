import { z } from "zod";

/**
 * Internal to the project module. Two shapes exist for every settings block:
 * a draft that tolerates nulls (what `episode add` writes) and a ready shape
 * that does not (what stage 1 requires). Readiness is therefore computed by
 * parsing, never declared by a `status` field a file could lie about.
 */

const SHA256 = /^[0-9a-f]{64}$/;
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const ASPECT_RATIO = /^\d{1,2}:\d{1,2}$/;

const sha256Schema = z.string().regex(SHA256, "expected a lowercase sha256 hex digest");
const languageSchema = z.string().regex(LANGUAGE, "expected a language code such as pl or en-GB");

export const audioModes = [
  "dialogue",
  "dialogue-and-narration",
  "music-and-effects",
  "narration",
] as const;

export const sourceNatures = ["law-or-idea", "screenplay", "synopsis"] as const;

/**
 * Where the character stage starts from. Recorded as a decision because an
 * empty `character/sources/` is otherwise ambiguous: "deliberately none" and
 * "not supplied yet" are different states and only one of them may pass stage 0.
 */
export const characterBases = ["description", "photographs"] as const;

const audioSchema = z.enum(audioModes);
const sourceNatureSchema = z.enum(sourceNatures);
// "none" cannot collide with the language pattern: it is four letters long.
const subtitlesSchema = z.union([z.literal("none"), languageSchema]);

const assetSchema = z.strictObject({
  originPath: z.string().min(1),
  path: z.string().min(1),
  sha256: sha256Schema,
});

const settingsShape = {
  audio: audioSchema,
  durationSeconds: z.int().min(1).max(3600),
  language: languageSchema,
  sourceNature: sourceNatureSchema,
  subtitles: subtitlesSchema,
};

/** What stage 1 requires: every decision made, no nulls. */
export const readySettingsSchema = z.strictObject(settingsShape);

/** What may legitimately sit on disk after `episode add`. */
export const draftSettingsSchema = z.strictObject({
  audio: audioSchema.nullable(),
  durationSeconds: settingsShape.durationSeconds.nullable(),
  language: languageSchema.nullable(),
  sourceNature: sourceNatureSchema.nullable(),
  subtitles: subtitlesSchema.nullable(),
});

export const projectFileSchema = z.strictObject({
  aspectRatio: z.string().regex(ASPECT_RATIO, "expected an aspect ratio such as 16:9").nullable(),
  // Absent in files written before the decision existed. They read as
  // undecided, which the readiness gate refuses — never as a silent default.
  characterBasis: z.enum(characterBases).nullable().default(null),
  characterSources: z.array(assetSchema),
  id: z.string().min(1),
  schemaVersion: z.literal(1),
  title: z.string().min(1),
});

export const episodeFileSchema = z.strictObject({
  id: z.string().min(1),
  number: z.int().min(1),
  projectId: z.string().min(1),
  schemaVersion: z.literal(1),
  settings: draftSettingsSchema,
  source: assetSchema,
});

const reviewSchema = z.strictObject({
  note: z.string().nullable(),
  reviewedAt: z.iso.datetime().nullable(),
  reviewer: z.string().nullable(),
  status: z.enum(["approved", "pending", "rejected"]),
});

const recordedFileSchema = z.strictObject({ path: z.string().min(1), sha256: sha256Schema });

const artifactRecordSchema = z.strictObject({
  inputs: z.array(recordedFileSchema),
  needsReview: z.array(z.string()),
  outputs: z.array(recordedFileSchema),
  producedAt: z.iso.datetime(),
  producer: z.strictObject({ kind: z.literal("manual"), tool: z.string().min(1) }),
  review: reviewSchema,
  runId: z.string().min(1),
});

/**
 * One shape for every stage. `artifacts` is keyed so a single stage can own a
 * set of results (R01..R10, C01..C06) without multiplying state files.
 */
export const stageFileSchema = z.strictObject({
  artifacts: z.record(z.string(), artifactRecordSchema),
  stage: z.literal("prepare"),
  version: z.literal(1),
});

export type DraftSettings = z.infer<typeof draftSettingsSchema>;
export type EpisodeFile = z.infer<typeof episodeFileSchema>;
export type ProjectFile = z.infer<typeof projectFileSchema>;
export type RecordedFile = z.infer<typeof recordedFileSchema>;
export type StageFile = z.infer<typeof stageFileSchema>;

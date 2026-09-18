import { z } from "zod";
import { sha256Schema } from "../artifact/index.js";

/**
 * Internal to the project module. Two shapes exist for every settings block:
 * a draft that tolerates nulls (what `episode add` writes) and a ready shape
 * that does not (what stage 1 requires). Readiness is therefore computed by
 * parsing, never declared by a `status` field a file could lie about.
 *
 * The shape of `prepare.stage.json` itself is not here: provenance is the same
 * for every stage and lives in `lib/artifact`.
 */

const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const ASPECT_RATIO = /^\d{1,2}:\d{1,2}$/;

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

export type DraftSettings = z.infer<typeof draftSettingsSchema>;
export type EpisodeFile = z.infer<typeof episodeFileSchema>;
export type ProjectFile = z.infer<typeof projectFileSchema>;
/** Every episode decision made — the shape a later stage is allowed to read. */
export type ReadySettings = z.infer<typeof readySettingsSchema>;

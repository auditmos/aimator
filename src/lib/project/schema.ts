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
 * Where one character's appearance comes from. Recorded per character rather
 * than per project, because a series may legitimately build one lead from
 * photographs and the rest from the written rules. Recorded as a decision at
 * all because an empty `sources/` is otherwise ambiguous: "deliberately none"
 * and "not supplied yet" are different states and only one may pass stage 0.
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

/**
 * One member of the cast: who the image stage draws, and from what.
 *
 * `name` is not decoration — it is what the prompt tells the model to render,
 * and it is the word the project rules use for that character. The id is the
 * directory it lives in; the name is the person.
 */
const characterSchema = z.strictObject({
  // Undecided until somebody says so, exactly as `aspectRatio` is.
  basis: z.enum(characterBases).nullable().default(null),
  name: z.string().min(1),
  sources: z.array(assetSchema),
});

export const projectFileSchema = z.strictObject({
  aspectRatio: z.string().regex(ASPECT_RATIO, "expected an aspect ratio such as 16:9").nullable(),
  /**
   * The cast, keyed by character id. An empty roster is "nobody has said who is
   * in this series", which the readiness gate refuses — a project with no
   * declared character used to mean "exactly one, anonymous", and that silent
   * default is what let a two-character series produce one character.
   */
  characters: z.record(z.string(), characterSchema),
  id: z.string().min(1),
  schemaVersion: z.literal(2),
  title: z.string().min(1),
});

/**
 * The shape before the cast existed: one project, one anonymous character.
 *
 * Read only by `character new`, which is the one command that can convert it —
 * and it converts nothing by itself. A v1 file recorded a basis for a character
 * nobody had named, so carrying that basis onto whichever member happens to be
 * declared first would be inventing an answer. Every named character starts
 * undecided.
 */
export const legacyProjectFileSchema = z.strictObject({
  aspectRatio: z.string().regex(ASPECT_RATIO, "expected an aspect ratio such as 16:9").nullable(),
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

export type CharacterEntry = z.infer<typeof characterSchema>;
export type DraftSettings = z.infer<typeof draftSettingsSchema>;
export type EpisodeFile = z.infer<typeof episodeFileSchema>;
export type ProjectFile = z.infer<typeof projectFileSchema>;
/** Every episode decision made — the shape a later stage is allowed to read. */
export type ReadySettings = z.infer<typeof readySettingsSchema>;

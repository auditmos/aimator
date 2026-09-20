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
const characterBases = ["description", "photographs"] as const;

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
  /**
   * The longest clip stage 3 may plan. An episode decision rather than a stage-3
   * flag, because `check` has to re-validate the shot list offline long after
   * the command that produced it — a limit that lived only in a flag would have
   * to be retyped to mean anything, and a limit that lived only in a run archive
   * would make the archive load-bearing state.
   *
   * Per episode rather than per track: both image tracks plan from one shot
   * list, so there is exactly one number to have. It is an editorial plan; no
   * video provider's real limit is verified before stage 7.
   */
  maxClipSeconds: z.int().min(1).max(60),
  sourceNature: sourceNatureSchema,
  subtitles: subtitlesSchema,
};

/**
 * The decisions stage 0's own gate requires — the five that stages 1 and 2
 * consume. `maxClipSeconds` is deliberately absent: it is stage 3's input, so
 * stage 3 gates it. Making the character stage wait on a video-clip length
 * would be the same over-constraint as making it wait on an episode.
 */
export const STAGE0_DECISIONS = [
  "audio",
  "durationSeconds",
  "language",
  "sourceNature",
  "subtitles",
] as const;

/**
 * What stage 1 requires. Every decision it consumes is made; `maxClipSeconds`
 * may still be null here, because stage 1 neither reads it nor sends it.
 */
export const readySettingsSchema = z.strictObject({
  ...settingsShape,
  maxClipSeconds: settingsShape.maxClipSeconds.nullable().default(null),
});

/** What may legitimately sit on disk after `episode add`. */
export const draftSettingsSchema = z.strictObject({
  audio: audioSchema.nullable(),
  durationSeconds: settingsShape.durationSeconds.nullable(),
  language: languageSchema.nullable(),
  // Defaulted so an episode written before stage 3 existed reads as undecided
  // rather than as a parse failure. Absent means nobody chose, and the gate blocks.
  maxClipSeconds: settingsShape.maxClipSeconds.nullable().default(null),
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
  /**
   * Which voice reads this series. Casting, not configuration.
   *
   * It sits here rather than in `episode.json` or an environment variable for
   * the reason the cast sits here: it recurs between episodes. A variable would
   * let the second episode get a different narrator from a different shell with
   * nothing on disk saying anybody decided that — the same silent default that
   * let a two-character series produce one. An episode field would make the
   * series answer the question again per episode, with nothing binding the
   * answers together.
   *
   * Defaulted to null so a project written before stage 9 existed reads as
   * undecided rather than as a parse failure, exactly as `maxClipSeconds` does
   * one level down. Undecided blocks stage 9 alone: each stage gates the
   * decisions it consumes, and a silent film never has to make this one.
   */
  narratorVoiceId: z.string().min(1).nullable().default(null),
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
/**
 * The stage-3 shape: the same decisions, with the clip limit no longer null.
 *
 * A narrowing of `ReadySettings` rather than a schema of its own, because the
 * bytes on disk are the same bytes — what differs is only which stage insists
 * the decision has been made.
 */
export type ShotListSettings = ReadySettings & { readonly maxClipSeconds: number };

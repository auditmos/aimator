import { z } from "zod";

/**
 * The release registry: `site/releases/<version>.json`, one file per published
 * release. It is the only place a release is declared, and it is deliberately
 * data rather than code — a release is a fact about bytes that already exist,
 * not a program.
 *
 * Every media file it names is verified against the sha256 recorded here
 * before it is published, which is what makes a published release immutable:
 * changing an exported file fails the build instead of quietly replacing an
 * asset whose cache is a year long.
 */

const VERSION = /^\d+\.\d+\.\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
/** A file name that cannot escape the directory it is joined onto. */
const MEDIA_FILE = /^[a-z0-9][a-z0-9.-]*$/;
const TEXT_FILE = /^[a-zA-Z0-9._-]+\.(md|txt)$/;
const LANGUAGE = /^[a-z]{2}(-[A-Z]{2})?$/;

/**
 * The two image tracks, spelled here rather than imported from
 * `lib/workspace.ts`: this module publishes a frozen copy of a past release,
 * so it must keep describing tracks the workspace layout has since renamed.
 */
const TRACK = /^[a-z][a-z0-9-]*$/;

const still = z.object({
  file: z.string().regex(MEDIA_FILE),
  height: z.number().int().positive(),
  /** Which stage produced it, and therefore which group it is shown in. */
  kind: z.enum(["opening-frame", "reference", "character"]),
  /** The manifest id the prompt addressed it by: `R01`, `hero:ewa`. */
  label: z.string().min(1),
  sha256: z.string().regex(SHA256),
  /**
   * The subject line the prompt package gave it. English in both language
   * versions of the page, because it is the text a model received — rule 9.
   */
  subject: z.string().min(1),
  width: z.number().int().positive(),
});

const track = z.object({
  bytes: z.number().int().positive(),
  durationSeconds: z.number().positive(),
  height: z.number().int().positive(),
  /** The image model that drew this track, shown verbatim as its own name. */
  label: z.string().min(1),
  stills: z.array(still).min(1),
  track: z.string().regex(TRACK),
  video: z.string().regex(MEDIA_FILE),
  videoSha256: z.string().regex(SHA256),
  width: z.number().int().positive(),
});

const document = z.object({
  description: z.string().min(1),
  file: z.string().regex(TEXT_FILE),
  label: z.string().min(1),
  sha256: z.string().regex(SHA256),
  /** The stage that wrote it, as the docs number them. */
  stage: z.number().int().min(0).max(10),
});

const source = z.object({
  description: z.string().min(1),
  filename: z.string().regex(TEXT_FILE),
  label: z.string().min(1),
  language: z.string().regex(LANGUAGE),
  sha256: z.string().regex(SHA256),
});

/**
 * The page is written in Polish; `en` carries the same prose in English.
 * Anything a release leaves untranslated falls back to its Polish text rather
 * than failing a build, so a new release publishes before it is translated.
 */
const translation = z.object({
  changes: z.array(z.string()).optional(),
  description: z.string().optional(),
  documents: z.array(z.object({ description: z.string().optional() })).optional(),
  episode: z.object({ audio: z.string().optional() }).optional(),
  note: z.string().optional(),
  source: z.object({ description: z.string().optional() }).optional(),
  title: z.string().optional(),
});

export const releaseSchema = z.object({
  changes: z.array(z.string().min(1)).min(1),
  commit: z.string().regex(COMMIT),
  commitDate: z.string().min(1),
  date: z.string().regex(DATE),
  description: z.string().min(1),
  documents: z.array(document),
  en: translation.optional(),
  episode: z.object({
    aspectRatio: z.string().min(1),
    audio: z.string().min(1),
    episode: z.string().min(1),
    language: z.string().regex(LANGUAGE),
    project: z.string().min(1),
  }),
  note: z.string().min(1),
  repository: z.string().min(1),
  repositoryPrivate: z.boolean(),
  source,
  /** The frozen export directory, relative to the repository root. */
  sourceDirectory: z.string().min(1),
  title: z.string().min(1),
  tracks: z.array(track).min(1),
  version: z.string().regex(VERSION),
});

export type Release = z.infer<typeof releaseSchema>;
export type ReleaseTrack = z.infer<typeof track>;
export type ReleaseStill = z.infer<typeof still>;

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { err, ok, type Result } from "./result.js";

/**
 * The only module that knows where artifacts live. Every other module asks it
 * for a path instead of joining segments itself, which is what keeps the
 * per-project / per-model layout a single fact rather than a convention.
 *
 * Deliberately free of filesystem access: paths are decided here, bytes are
 * read and written by the stage that owns them.
 */

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const EPISODE_SOURCE = /^(\d{1,3})[-_](.+)\.md$/;
const COMBINING_MARKS = /\p{M}+/gu;
const NON_SLUG = /[^a-z0-9]+/g;
const SLUG_EDGES = /^-+|-+$/g;
const TILDE_PREFIX = /^~(?=\/|$)/;

// NFD leaves these Polish letters undecomposed, so they need an explicit map.
const TRANSLITERATED = new Map([
  ["ł", "l"],
  ["Ł", "L"],
]);

export interface Workspace {
  readonly root: string;
}

/**
 * The image model tracks. A track is a directory level and never a filename
 * prefix, so the two render the same project side by side without either one
 * having to know the other exists.
 */
export const imageTracks = ["gpt-image", "seedream"] as const;

export type ImageTrack = (typeof imageTracks)[number];

export interface ProjectPaths {
  /** The cast. A character is a directory level, exactly as a track is. */
  readonly characters: string;
  readonly episodes: string;
  readonly file: string;
  readonly prepareStage: string;
  readonly root: string;
  readonly rules: string;
}

export interface CharacterPaths {
  readonly root: string;
  /** Photographs of this one character; absent when the basis is a description. */
  readonly sources: string;
}

/** One character as one model track draws it. The two tracks never meet. */
export interface CharacterTrackPaths {
  readonly card: string;
  readonly hero: string;
  /**
   * A file, not a directory, for the reason `screenplayLock` gives: the layout
   * check reports empty directories, so a lock held as one would trip it.
   */
  readonly lock: string;
  readonly root: string;
  readonly runs: string;
  readonly stage: string;
  readonly views: string;
}

/**
 * What one image attempt archives. `request.json` carries the prompt and the
 * settings but never the reference bytes: those are inputs, and an archive that
 * copied them would duplicate every photograph on every attempt.
 */
export interface ImageRunPaths {
  /** Exactly what the provider returned, before anything was published. */
  readonly image: string;
  /** The result being replaced. Written only by `--regenerate`. */
  readonly previousImage: string;
  readonly prompt: string;
  readonly request: string;
  readonly response: string;
  readonly root: string;
  readonly run: string;
  readonly transport: string;
  readonly validation: string;
}

export interface EpisodePaths {
  readonly file: string;
  readonly prepareStage: string;
  readonly root: string;
  /** One archive directory per episode; the run id keeps stages from colliding. */
  readonly runs: string;
  readonly screenplay: string;
  /**
   * A file, not an empty directory. The layout rule says a directory appears
   * when a stage writes into it and `check` reports the empty ones, so a lock
   * held as a directory would trip the very check it sits beside.
   */
  readonly screenplayLock: string;
  readonly screenplayStage: string;
  readonly source: string;
}

/**
 * What a single attempt archives: only what cannot be reconstructed. The
 * inputs are referenced by path and digest inside `run.json`, never copied.
 */
export interface RunPaths {
  readonly previousScreenplay: string;
  readonly prompt: string;
  readonly request: string;
  readonly response: string;
  readonly root: string;
  readonly run: string;
  readonly transport: string;
  readonly validation: string;
}

interface EpisodeIdentity {
  readonly id: string;
  readonly number: number;
}

class WorkspaceError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = "WorkspaceError";
    this.path = path;
  }
}

class IdentifierError extends Error {
  readonly value: string;

  constructor(value: string, message: string) {
    super(message);
    this.name = "IdentifierError";
    this.value = value;
  }
}

function transliterate(value: string): string {
  let out = "";

  for (const character of value) {
    out += TRANSLITERATED.get(character) ?? character;
  }

  return out;
}

function slugify(value: string): string {
  return transliterate(value)
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(NON_SLUG, "-")
    .replace(SLUG_EDGES, "");
}

/** Resolves the artifact root to an absolute path, expanding a leading `~/`. */
export function resolveWorkspace(root: string | undefined): Result<Workspace> {
  const raw = root?.trim();

  if (raw === undefined || raw === "") {
    return err(
      new WorkspaceError(
        "",
        "no artifact workspace configured: set AIMATOR_WORKSPACE or pass --workspace <path>"
      )
    );
  }

  // A .env file performs no shell expansion, so `~/...` would otherwise
  // become a directory literally named "~".
  const expanded = raw.replace(TILDE_PREFIX, homedir());

  return ok({ root: isAbsolute(expanded) ? expanded : resolve(expanded) });
}

export function projectPaths(workspace: Workspace, projectId: string): Result<ProjectPaths> {
  if (!PROJECT_ID.test(projectId)) {
    return err(
      new IdentifierError(
        projectId,
        `invalid project id "${projectId}": must start with an ASCII letter or digit and contain only letters, digits, - and _`
      )
    );
  }

  const root = join(workspace.root, "projects", projectId);

  return ok({
    characters: join(root, "characters"),
    episodes: join(root, "episodes"),
    file: join(root, "project.json"),
    prepareStage: join(root, "prepare.stage.json"),
    root,
    rules: join(root, "project.md"),
  });
}

/**
 * One member of the cast. The identifier is a directory name, so it obeys the
 * same rules as a project or an episode id rather than trusting whatever the
 * roster happens to hold.
 */
export function characterPaths(project: ProjectPaths, characterId: string): Result<CharacterPaths> {
  if (!PROJECT_ID.test(characterId)) {
    return err(
      new IdentifierError(
        characterId,
        `invalid character id "${characterId}": must start with an ASCII letter or digit and contain only letters, digits, - and _`
      )
    );
  }

  const root = join(project.characters, characterId);

  return ok({ root, sources: join(root, "sources") });
}

/**
 * The per-track half of a character. The track is a directory level, so the
 * two tracks hold identically named files and neither needs a prefix to stay
 * out of the other's way.
 */
export function characterTrackPaths(
  character: CharacterPaths,
  track: ImageTrack
): CharacterTrackPaths {
  const root = join(character.root, track);

  return {
    card: join(root, "card.png"),
    hero: join(root, "hero.png"),
    lock: join(root, "character.lock"),
    root,
    runs: join(root, "runs"),
    stage: join(root, "character.stage.json"),
    views: join(root, "views"),
  };
}

/**
 * A view's own file. The view name is the artifact key and the file name at
 * once, so it is checked here rather than trusted into a path.
 */
export function characterViewImage(paths: CharacterTrackPaths, view: string): Result<string> {
  return PROJECT_ID.test(view)
    ? ok(join(paths.views, `${view}.png`))
    : err(new IdentifierError(view, `invalid view name "${view}"`));
}

/** The archive of one image attempt. Run ids are minted by `lib/artifact`. */
export function imageRunPaths(paths: CharacterTrackPaths, runId: string): ImageRunPaths {
  const root = join(paths.runs, runId);

  return {
    image: join(root, "original.png"),
    previousImage: join(root, "previous.png"),
    prompt: join(root, "prompt.md"),
    request: join(root, "request.json"),
    response: join(root, "response.json"),
    root,
    run: join(root, "run.json"),
    transport: join(root, "transport.json"),
    validation: join(root, "validation.json"),
  };
}

export function episodePaths(project: ProjectPaths, episodeId: string): Result<EpisodePaths> {
  if (!PROJECT_ID.test(episodeId)) {
    return err(
      new IdentifierError(
        episodeId,
        `invalid episode id "${episodeId}": must start with an ASCII letter or digit and contain only letters, digits, - and _`
      )
    );
  }

  const root = join(project.episodes, episodeId);

  return ok({
    file: join(root, "episode.json"),
    prepareStage: join(root, "prepare.stage.json"),
    root,
    runs: join(root, "runs"),
    screenplay: join(root, "screenplay.md"),
    screenplayLock: join(root, "screenplay.lock"),
    screenplayStage: join(root, "screenplay.stage.json"),
    source: join(root, "source.md"),
  });
}

/** The archive of one attempt. Run ids are minted by `lib/artifact`. */
export function runPaths(episode: EpisodePaths, runId: string): RunPaths {
  const root = join(episode.runs, runId);

  return {
    previousScreenplay: join(root, "previous-screenplay.md"),
    prompt: join(root, "prompt.md"),
    request: join(root, "request.json"),
    response: join(root, "response.json"),
    root,
    run: join(root, "run.json"),
    transport: join(root, "transport.json"),
    validation: join(root, "validation.json"),
  };
}

/**
 * The episode number is part of the filename because it decides the output
 * directory, so it is read from the user's own file name rather than asked for
 * twice. The slug keeps the original padding: "003-Trzeci.md" stays "003-".
 */
export function episodeIdFromSource(filename: string): Result<EpisodeIdentity> {
  const match = EPISODE_SOURCE.exec(filename);

  if (match === null) {
    return err(
      new IdentifierError(
        filename,
        `invalid episode source "${filename}": the file name must start with its number and a separator, like "01-title.md"`
      )
    );
  }

  const [, digits = "", title = ""] = match;
  const number = Number(digits);

  if (number < 1) {
    return err(
      new IdentifierError(filename, `invalid episode number "${digits}": must be 1 or more`)
    );
  }

  const slug = slugify(title);

  if (slug === "") {
    return err(
      new IdentifierError(
        filename,
        `invalid episode source "${filename}": the title has no usable characters`
      )
    );
  }

  return ok({ id: `${digits}-${slug}`, number });
}

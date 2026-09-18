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

export interface ProjectPaths {
  readonly characterSources: string;
  readonly episodes: string;
  readonly file: string;
  readonly prepareStage: string;
  readonly root: string;
  readonly rules: string;
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
    characterSources: join(root, "character", "sources"),
    episodes: join(root, "episodes"),
    file: join(root, "project.json"),
    prepareStage: join(root, "prepare.stage.json"),
    root,
    rules: join(root, "project.md"),
  });
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

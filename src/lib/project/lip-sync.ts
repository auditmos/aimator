import {
  applyWrites,
  exists,
  type RecordedFile,
  readDigest,
  readJson,
  serialize,
  toWorkspacePath,
  type WriteMode,
} from "../artifact/index.js";
import { err, ok, type Result } from "../result.js";
import { type EpisodePaths, episodePaths, projectPaths, type Workspace } from "../workspace.js";
import { episodeFileSchema, languageSchema, lipSyncFileSchema } from "./schema.js";

/**
 * Internal to the project module: which language the mouths move in.
 *
 * An episode decision, and deliberately not a field of `episode.json`. That
 * file is a recorded input of the screenplay and so of everything below it,
 * while the language of the mouths is an input of the second-language dialogue
 * script and of stage 12 alone. Where a decision lives decides what changing
 * it lapses, so it gets a file of its own and lapses exactly those two.
 *
 * Rule 7 holds without exception: an absent file is nobody deciding, and it
 * blocks the second-language script. `none` is somebody deciding there will be
 * no second version, which is a different answer and is stored as one.
 */

/** The decision as a later stage reads it, with the file it would record. */
type LipSync =
  | { readonly kind: "undecided" }
  | { readonly file: RecordedFile; readonly kind: "none" }
  | { readonly file: RecordedFile; readonly kind: "language"; readonly language: string };

/** What a person answers: a language, or a deliberate no. */
export type LipSyncChoice =
  | { readonly kind: "none" }
  | { readonly kind: "language"; readonly language: string };

interface LipSyncReport {
  readonly created: readonly string[];
  /** The decision as stored: a language code, or `none`. */
  readonly language: string;
  readonly nextStep: string;
}

interface LipSyncScope {
  readonly episodeId: string;
  readonly projectId: string;
  readonly workspace: Workspace;
}

class LipSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LipSyncError";
  }
}

function pathsOf(input: LipSyncScope): Result<EpisodePaths> {
  const project = projectPaths(input.workspace, input.projectId);

  return project.ok ? episodePaths(project.data, input.episodeId) : project;
}

/** What the episode decided about its mouths, read without judging it. */
export async function readLipSync(input: LipSyncScope): Promise<Result<LipSync>> {
  const paths = pathsOf(input);

  if (!paths.ok) {
    return paths;
  }

  if (!(await exists(paths.data.lipSync))) {
    return ok({ kind: "undecided" });
  }

  const parsed = await readJson(paths.data.lipSync, lipSyncFileSchema);
  const digest = await readDigest(paths.data.lipSync);

  if (!(parsed.ok && digest.ok)) {
    return err(
      new LipSyncError(
        `lip-sync.json nie daje się odczytać, zapisz decyzję ponownie: aimator episode lip-sync ${input.projectId} ${input.episodeId} --language <kod>|--none`
      )
    );
  }

  const file = {
    path: toWorkspacePath(input.workspace.root, paths.data.lipSync),
    sha256: digest.data.sha256,
  };
  const { language } = parsed.data;

  return ok(language === "none" ? { file, kind: "none" } : { file, kind: "language", language });
}

/**
 * Why a language may not be the language of the mouths. The film's own is
 * refused: lip-sync re-animates mouths for a *second* language, and in the
 * film's own the characters already speak the way they were drawn.
 */
async function refusal(
  input: LipSyncScope,
  paths: EpisodePaths,
  language: string
): Promise<string | null> {
  if (!languageSchema.safeParse(language).success) {
    return `niepoprawny kod języka "${language}", oczekiwano kodu jak en, de albo pt-BR`;
  }

  const episode = await readJson(paths.file, episodeFileSchema);

  if (!episode.ok) {
    return `odcinek "${input.episodeId}" nie istnieje w projekcie "${input.projectId}"`;
  }

  const film = episode.data.settings.language;

  if (film === null) {
    return `odcinek nie ma jeszcze języka filmu, a język ust jest drugim językiem względem niego; najpierw: aimator episode set ${input.projectId} ${input.episodeId} --language <kod>`;
  }

  return film === language
    ? `"${language}" jest językiem filmu; lip-sync porusza usta w drugim języku, a w języku filmu postacie mówią tak, jak je narysowano. Bez drugiej wersji: aimator episode lip-sync ${input.projectId} ${input.episodeId} --none`
    : null;
}

/**
 * Records the language of the mouths, or that there is none. Free, and it
 * touches nothing stage 0 or the screenplay recorded, so neither lapses.
 */
export async function setLipSync(
  input: LipSyncScope & { readonly choice: LipSyncChoice; readonly mode: WriteMode }
): Promise<Result<LipSyncReport>> {
  const paths = pathsOf(input);

  if (!paths.ok) {
    return paths;
  }

  const { choice } = input;
  const refused =
    choice.kind === "language" ? await refusal(input, paths.data, choice.language) : null;

  if (refused !== null) {
    return err(new LipSyncError(refused));
  }

  const language = choice.kind === "language" ? choice.language : "none";
  const written = await applyWrites(
    [{ kind: "text", text: serialize({ language, schemaVersion: 1 }), to: paths.data.lipSync }],
    input.mode
  );

  return written.ok
    ? ok({
        created: written.data.map((path) => toWorkspacePath(input.workspace.root, path)),
        language,
        nextStep:
          choice.kind === "language"
            ? `skrypt dialogu w tym języku: aimator dialogue translate ${input.projectId} ${input.episodeId} --dry-run`
            : `drugiej wersji nie będzie: aimator status ${input.projectId} ${input.episodeId}`,
      })
    : written;
}

import { basename, join } from "node:path";
import { err, ok, type Result } from "../result.js";
import {
  type EpisodePaths,
  episodeIdFromSource,
  episodePaths,
  type ProjectPaths,
  projectPaths,
  type Workspace,
} from "../workspace.js";
import {
  audioModes,
  type DraftSettings,
  draftSettingsSchema,
  type EpisodeFile,
  episodeFileSchema,
  type ProjectFile,
  projectFileSchema,
  type RecordedFile,
  readySettingsSchema,
  type StageFile,
  sourceNatures,
  stageFileSchema,
} from "./schema.js";
import {
  applyWrites,
  exists,
  listEntries,
  newRunId,
  nowIso,
  readDigest,
  readJson,
  serialize,
  sha256Of,
  toWorkspacePath,
  type WriteMode,
  type WriteOp,
} from "./store.js";
import { PLACEHOLDER, renderRules } from "./template.js";

/**
 * Stage 0 — preparation. The only stage that legitimately ingests material
 * from outside the workspace, which is exactly why it copies those bytes in
 * and records their digest: from here on every stage consumes an artifact a
 * previous stage produced, never a file someone happened to have lying around.
 *
 * Nothing here calls a paid API.
 */

const TOOL = "aimator";
const LANGUAGE_CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const EMPTY_SETTINGS: DraftSettings = {
  audio: null,
  durationSeconds: null,
  language: null,
  sourceNature: null,
  subtitles: null,
};

export interface Stage0Report {
  readonly created: readonly string[];
  readonly nextStep: string;
  readonly problems: readonly string[];
  readonly ready: boolean;
  readonly reused: readonly string[];
}

interface ProjectInput {
  readonly mode: WriteMode;
  readonly projectId: string;
  readonly workspace: Workspace;
}
type InitProjectInput = ProjectInput & {
  readonly aspectRatio: string | null;
  readonly title: string;
};
type AddEpisodeInput = ProjectInput & {
  readonly settings: Partial<DraftSettings>;
  readonly sourcePath: string;
};
type SetSettingsInput = ProjectInput & {
  readonly episodeId: string;
  readonly settings: Partial<DraftSettings>;
};
type AddSourcesInput = ProjectInput & { readonly sourcePaths: readonly string[] };
interface CheckInput {
  readonly projectId: string;
  readonly workspace: Workspace;
}

class ProjectStateError extends Error {
  readonly reason: "already-exists" | "duplicate-number" | "missing-episode" | "missing-project";

  constructor(reason: ProjectStateError["reason"], message: string) {
    super(message);
    this.name = "ProjectStateError";
    this.reason = reason;
  }
}

class InvalidInputError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "InvalidInputError";
    this.field = field;
  }
}

class NotReadyError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`etap 0 nie jest ukończony:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "NotReadyError";
    this.problems = problems;
  }
}

function emptyStage(): StageFile {
  return { artifacts: {}, stage: "prepare", version: 1 };
}

function record(
  inputs: readonly RecordedFile[],
  outputs: readonly RecordedFile[]
): StageFile["artifacts"][string] {
  return {
    inputs: [...inputs],
    needsReview: [],
    outputs: [...outputs],
    producedAt: nowIso(),
    producer: { kind: "manual", tool: TOOL },
    review: { note: null, reviewedAt: null, reviewer: null, status: "pending" },
    runId: newRunId(),
  };
}

async function resolveProject(input: ProjectInput): Promise<Result<ProjectPaths>> {
  const paths = projectPaths(input.workspace, input.projectId);

  if (!paths.ok) {
    return paths;
  }

  if (!(await exists(paths.data.file))) {
    return err(
      new ProjectStateError(
        "missing-project",
        `projekt "${input.projectId}" nie istnieje — utwórz go przez: aimator project init ${input.projectId} --title "..."`
      )
    );
  }

  return paths;
}

export async function initProject(input: InitProjectInput): Promise<Result<Stage0Report>> {
  const paths = projectPaths(input.workspace, input.projectId);

  if (!paths.ok) {
    return paths;
  }

  if (await exists(paths.data.file)) {
    return err(
      new ProjectStateError(
        "already-exists",
        `projekt "${input.projectId}" już istnieje w ${paths.data.root} — etap 0 nie nadpisuje zatwierdzonych ustaleń`
      )
    );
  }

  const file: ProjectFile = {
    aspectRatio: input.aspectRatio,
    characterSources: [],
    id: input.projectId,
    schemaVersion: 1,
    title: input.title,
  };
  const parsed = projectFileSchema.safeParse(file);

  if (!parsed.success) {
    return err(
      new InvalidInputError(
        "aspectRatio",
        `nieprawidłowe proporcje obrazu "${input.aspectRatio}": oczekiwano formatu 16:9`
      )
    );
  }

  const text = serialize(file);
  const ops: WriteOp[] = [
    { kind: "directory", to: paths.data.characterSources },
    { kind: "directory", to: paths.data.episodes },
    { kind: "text", text: renderRules(input.title), to: paths.data.rules },
    { kind: "text", text, to: paths.data.file },
    {
      kind: "text",
      text: serialize({
        ...emptyStage(),
        artifacts: {
          project: record(
            [],
            [
              {
                path: toWorkspacePath(input.workspace.root, paths.data.file),
                sha256: sha256Of(Buffer.from(text)),
              },
            ]
          ),
        },
      }),
      to: paths.data.stage,
    },
  ];

  const written = await applyWrites(ops, input.mode);

  return written.ok
    ? ok({
        created: written.data.map((path) => toWorkspacePath(input.workspace.root, path)),
        nextStep: `uzupełnij każdy ${PLACEHOLDER} w project.md, a potem: aimator episode add ${input.projectId} --source <plik.md>`,
        problems: [],
        ready: false,
        reused: [],
      })
    : written;
}

export async function addEpisode(input: AddEpisodeInput): Promise<Result<Stage0Report>> {
  const project = await resolveProject(input);

  if (!project.ok) {
    return project;
  }

  const identity = episodeIdFromSource(basename(input.sourcePath));

  if (!identity.ok) {
    return identity;
  }

  const source = await readDigest(input.sourcePath);

  if (!source.ok) {
    return source;
  }

  if (source.data.bytes.byteLength === 0) {
    return err(new InvalidInputError("source", `plik źródłowy ${input.sourcePath} jest pusty`));
  }

  const clash = await findNumberClash(project.data, identity.data.number, identity.data.id);

  if (clash !== null) {
    return err(
      new ProjectStateError(
        "duplicate-number",
        `numer odcinka ${identity.data.number} jest już zajęty przez "${clash}" — numer wyznacza katalog wyników, więc musi być unikalny`
      )
    );
  }

  const paths = episodePaths(project.data, identity.data.id);

  if (!paths.ok) {
    return paths;
  }

  if (await exists(paths.data.file)) {
    return err(
      new ProjectStateError(
        "already-exists",
        `odcinek "${identity.data.id}" już istnieje — etap 0 nie nadpisuje źródła`
      )
    );
  }

  const settings = mergeSettings(EMPTY_SETTINGS, input.settings);

  if (!settings.ok) {
    return settings;
  }

  const episode: EpisodeFile = {
    id: identity.data.id,
    number: identity.data.number,
    projectId: input.projectId,
    schemaVersion: 1,
    settings: settings.data,
    source: {
      originPath: input.sourcePath,
      path: toWorkspacePath(input.workspace.root, paths.data.source),
      sha256: source.data.sha256,
    },
  };

  const ops = episodeWriteOps(
    input.workspace,
    paths.data,
    episode,
    source.data.sha256,
    input.sourcePath
  );
  const written = await applyWrites(ops, input.mode);

  return written.ok
    ? ok({
        created: written.data.map((path) => toWorkspacePath(input.workspace.root, path)),
        nextStep:
          missingSettings(settings.data).length === 0
            ? `aimator check ${input.projectId}`
            : `uzupełnij decyzje: aimator episode set ${input.projectId} ${identity.data.id} --duration <s> --audio <tryb> --language <kod> --subtitles <kod|none> --nature <rodzaj>`,
        problems: [],
        ready: false,
        reused: [],
      })
    : written;
}

function episodeWriteOps(
  workspace: Workspace,
  paths: EpisodePaths,
  episode: EpisodeFile,
  sourceSha: string,
  originPath: string
): WriteOp[] {
  const text = serialize(episode);

  return [
    { from: originPath, kind: "copy", to: paths.source },
    { kind: "text", text, to: paths.file },
    {
      kind: "text",
      text: serialize({
        ...emptyStage(),
        artifacts: {
          episode: record(
            [],
            [
              { path: toWorkspacePath(workspace.root, paths.source), sha256: sourceSha },
              {
                path: toWorkspacePath(workspace.root, paths.file),
                sha256: sha256Of(Buffer.from(text)),
              },
            ]
          ),
        },
      }),
      to: paths.stage,
    },
  ];
}

async function findNumberClash(
  project: ProjectPaths,
  number: number,
  selfId: string
): Promise<string | null> {
  for (const entry of await listEntries(project.episodes)) {
    const other = episodeIdFromSource(`${entry}.md`);

    if (other.ok && other.data.number === number && entry !== selfId) {
      return entry;
    }
  }

  return null;
}

function mergeSettings(base: DraftSettings, patch: Partial<DraftSettings>): Result<DraftSettings> {
  const merged = { ...base, ...patch };
  const parsed = draftSettingsSchema.safeParse(merged);

  return parsed.success
    ? ok(parsed.data)
    : err(new InvalidInputError("settings", describeSettingsError(merged)));
}

function describeSettingsError(merged: DraftSettings): string {
  const problems: string[] = [];

  if (merged.durationSeconds !== null && !Number.isInteger(merged.durationSeconds)) {
    problems.push("--duration musi być liczbą całkowitą");
  } else if (
    merged.durationSeconds !== null &&
    (merged.durationSeconds < 1 || merged.durationSeconds > 3600)
  ) {
    problems.push(`--duration ${merged.durationSeconds} poza zakresem 1–3600`);
  }

  if (merged.audio !== null && !audioModes.includes(merged.audio)) {
    problems.push(`--audio "${merged.audio}" — dozwolone: ${audioModes.join(", ")}`);
  }

  if (merged.sourceNature !== null && !sourceNatures.includes(merged.sourceNature)) {
    problems.push(`--nature "${merged.sourceNature}" — dozwolone: ${sourceNatures.join(", ")}`);
  }

  if (merged.language !== null && !LANGUAGE_CODE.test(merged.language)) {
    problems.push(`--language "${merged.language}" — oczekiwano kodu języka, np. pl lub en-GB`);
  }

  if (
    merged.subtitles !== null &&
    merged.subtitles !== "none" &&
    !LANGUAGE_CODE.test(merged.subtitles)
  ) {
    problems.push(`--subtitles "${merged.subtitles}" — oczekiwano kodu języka albo "none"`);
  }

  return problems.length === 0 ? "nieprawidłowe ustawienia odcinka" : problems.join("; ");
}

function missingSettings(settings: DraftSettings): readonly string[] {
  return Object.entries(settings)
    .filter(([, value]) => value === null)
    .map(([key]) => key);
}

export async function setEpisodeSettings(input: SetSettingsInput): Promise<Result<Stage0Report>> {
  const project = await resolveProject(input);

  if (!project.ok) {
    return project;
  }

  const paths = episodePaths(project.data, input.episodeId);

  if (!paths.ok) {
    return paths;
  }

  const current = await readJson(paths.data.file, episodeFileSchema);

  if (!current.ok) {
    return err(
      new ProjectStateError(
        "missing-episode",
        `odcinek "${input.episodeId}" nie istnieje w projekcie "${input.projectId}"`
      )
    );
  }

  const settings = mergeSettings(current.data.settings, input.settings);

  if (!settings.ok) {
    return settings;
  }

  const episode: EpisodeFile = { ...current.data, settings: settings.data };
  const sourceDigest = await readDigest(paths.data.source);

  if (!sourceDigest.ok) {
    return sourceDigest;
  }

  const ops = episodeWriteOps(
    input.workspace,
    paths.data,
    episode,
    sourceDigest.data.sha256,
    paths.data.source
  ).filter((op) => op.kind !== "copy");

  const written = await applyWrites(ops, input.mode);
  const missing = missingSettings(settings.data);

  return written.ok
    ? ok({
        created: [],
        nextStep:
          missing.length === 0
            ? `aimator check ${input.projectId}`
            : `pozostałe decyzje: ${missing.join(", ")}`,
        problems: missing.map((field) => `${field}: brak decyzji`),
        ready: missing.length === 0,
        reused: written.data.map((path) => toWorkspacePath(input.workspace.root, path)),
      })
    : written;
}

export async function addCharacterSources(input: AddSourcesInput): Promise<Result<Stage0Report>> {
  const project = await resolveProject(input);

  if (!project.ok) {
    return project;
  }

  const current = await readJson(project.data.file, projectFileSchema);

  if (!current.ok) {
    return current;
  }

  const recorded = [...current.data.characterSources];
  const ops: WriteOp[] = [];
  const created: string[] = [];
  const reused: string[] = [];

  // Hash every photo first: de-duplication compares digests, so the decision
  // for one file depends on the ones before it and must stay ordered.
  const digests = await Promise.all(input.sourcePaths.map((path) => readDigest(path)));

  for (const [index, sourcePath] of input.sourcePaths.entries()) {
    const digest = digests[index];

    if (digest === undefined || !digest.ok) {
      return digest ?? err(new InvalidInputError("source", `nie można odczytać ${sourcePath}`));
    }

    const destination = join(project.data.characterSources, basename(sourcePath));
    const path = toWorkspacePath(input.workspace.root, destination);
    const already = recorded.find((asset) => asset.sha256 === digest.data.sha256);

    if (already === undefined) {
      recorded.push({ originPath: sourcePath, path, sha256: digest.data.sha256 });
      ops.push({ from: sourcePath, kind: "copy", to: destination });
      created.push(path);
    } else {
      reused.push(already.path);
    }
  }

  const file: ProjectFile = { ...current.data, characterSources: recorded };
  const text = serialize(file);

  ops.push({ kind: "text", text, to: project.data.file });
  ops.push({
    kind: "text",
    text: serialize({
      ...emptyStage(),
      artifacts: {
        project: record(
          recorded.map((asset) => ({ path: asset.path, sha256: asset.sha256 })),
          [
            {
              path: toWorkspacePath(input.workspace.root, project.data.file),
              sha256: sha256Of(Buffer.from(text)),
            },
          ]
        ),
      },
    }),
    to: project.data.stage,
  });

  const written = await applyWrites(ops, input.mode);

  return written.ok
    ? ok({
        created,
        nextStep:
          "materiały postaci mają status pending — oceny dokonasz w etapie postaci, nie tutaj",
        problems: [],
        ready: false,
        reused,
      })
    : written;
}

export async function checkStage0(input: CheckInput): Promise<Result<Stage0Report>> {
  const project = await resolveProject({ ...input, mode: "dry-run" });

  if (!project.ok) {
    return project;
  }

  const file = await readJson(project.data.file, projectFileSchema);

  if (!file.ok) {
    return file;
  }

  const problems: string[] = [];
  const checked: string[] = [];

  await checkRules(project.data, problems);

  if (file.data.aspectRatio === null) {
    problems.push("project.json: aspectRatio nie jest ustalony");
  }

  const episodes = (await listEntries(project.data.episodes)).filter(
    (entry) => !entry.startsWith(".")
  );

  if (episodes.length === 0) {
    problems.push("projekt nie ma jeszcze żadnego odcinka");
  }

  const verdicts = await Promise.all(
    episodes.map((episodeId) => checkEpisode(input.workspace, project.data, episodeId))
  );

  for (const verdict of verdicts) {
    problems.push(...verdict.problems);

    if (verdict.verified) {
      checked.push(verdict.id);
    }
  }

  if (problems.length > 0) {
    return err(new NotReadyError(problems));
  }

  return ok({
    created: [],
    nextStep:
      "etap 0 gotowy. Etap 1 (scenariusz) nie jest jeszcze zaimplementowany — to zakres kroku 2 migracji.",
    problems: [],
    ready: true,
    reused: checked,
  });
}

async function checkRules(project: ProjectPaths, problems: string[]): Promise<void> {
  const rules = await readDigest(project.rules);

  if (!rules.ok) {
    problems.push("project.md nie istnieje");
    return;
  }

  const text = rules.data.bytes.toString("utf8");
  const left = text.split(PLACEHOLDER).length - 1;

  if (left > 0) {
    problems.push(`project.md: pozostało ${left} znaczników ${PLACEHOLDER}`);
  }
}

interface EpisodeVerdict {
  readonly id: string;
  readonly problems: string[];
  readonly verified: boolean;
}

async function checkEpisode(
  workspace: Workspace,
  project: ProjectPaths,
  episodeId: string
): Promise<EpisodeVerdict> {
  const problems: string[] = [];
  const paths = episodePaths(project, episodeId);

  if (!paths.ok) {
    problems.push(`odcinek "${episodeId}": nieprawidłowy identyfikator katalogu`);
    return { id: episodeId, problems, verified: false };
  }

  const episode = await readJson(paths.data.file, episodeFileSchema);

  if (!episode.ok) {
    problems.push(`odcinek "${episodeId}": ${episode.error.message}`);
    return { id: episodeId, problems, verified: false };
  }

  const missing = missingSettings(episode.data.settings);

  if (missing.length > 0) {
    problems.push(`odcinek "${episodeId}": brak decyzji — ${missing.join(", ")}`);
  } else if (!readySettingsSchema.safeParse(episode.data.settings).success) {
    problems.push(`odcinek "${episodeId}": ustawienia nie przechodzą walidacji`);
  }

  const stage = await readJson(paths.data.stage, stageFileSchema);

  if (!stage.ok) {
    problems.push(`odcinek "${episodeId}": brak zapisu etapu (prepare.stage.json)`);
    return { id: episodeId, problems, verified: false };
  }

  await verifyOutputs(workspace, stage.data, episodeId, problems);

  return { id: episodeId, problems, verified: true };
}

/**
 * The honesty gate: an artifact is only what stage 0 recorded if its bytes
 * still hash to the digest written beside it. Editing a result outside the
 * tool is allowed — silently carrying its old provenance forward is not.
 */
async function verifyOutputs(
  workspace: Workspace,
  stage: StageFile,
  episodeId: string,
  problems: string[]
): Promise<void> {
  const outputs = Object.values(stage.artifacts).flatMap((artifact) => artifact.outputs);
  // Hashed in parallel, reported in declaration order: the verdict a user
  // reads must not depend on which read happened to finish first.
  const digests = await Promise.all(
    outputs.map((output) => readDigest(join(workspace.root, output.path)))
  );

  for (const [index, output] of outputs.entries()) {
    const digest = digests[index];

    if (digest === undefined || !digest.ok) {
      problems.push(`odcinek "${episodeId}": brakuje ${output.path}`);
    } else if (digest.data.sha256 !== output.sha256) {
      problems.push(
        `odcinek "${episodeId}": ${output.path} nie zgadza się z hashem zapisanym w etapie 0 — wynik został zmieniony poza narzędziem`
      );
    }
  }
}

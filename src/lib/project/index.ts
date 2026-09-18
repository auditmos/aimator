import { basename, join } from "node:path";
import {
  applyWrites,
  approveAll,
  emptyDirectories,
  emptyStage,
  exists,
  isApproved,
  listEntries,
  manualProducer,
  newRecord,
  type RecordedFile,
  readDigest,
  readJson,
  type StageFile,
  serialize,
  sha256Of,
  stageFileSchema,
  toWorkspacePath,
  verifyOutputs,
  type WriteMode,
  type WriteOp,
  withOutputs,
} from "../artifact/index.js";
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
  characterBases,
  type DraftSettings,
  draftSettingsSchema,
  type EpisodeFile,
  episodeFileSchema,
  type ProjectFile,
  projectFileSchema,
  type ReadySettings,
  readySettingsSchema,
  sourceNatures,
} from "./schema.js";
import { PLACEHOLDER, renderRules } from "./template.js";

/** The five episode decisions, all made. A later stage reads them, never the draft. */
export type { ReadySettings as EpisodeSettings } from "./schema.js";

/**
 * Stage 0 — preparation. The only stage that legitimately ingests material
 * from outside the workspace, which is exactly why it copies those bytes in
 * and records their digest: from here on every stage consumes an artifact a
 * previous stage produced, never a file someone happened to have lying around.
 *
 * Nothing here calls a paid API.
 */

const LANGUAGE_CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const readyNext = (projectId: string): string =>
  `etap 0 zatwierdzony. Etap 1 (scenariusz) wydaje pieniądze, więc zacznij od podglądu: aimator screenplay generate ${projectId} <episode-id> --dry-run`;
const EMPTY_SETTINGS: DraftSettings = {
  audio: null,
  durationSeconds: null,
  language: null,
  sourceNature: null,
  subtitles: null,
};

/** Everything stage 1 is allowed to read, with the digests of the bytes it read. */
export interface Stage0Inputs {
  /** Whether a human accepted stage 0 for this project *and* this episode. */
  readonly approved: boolean;
  readonly aspectRatio: string;
  readonly inputs: readonly RecordedFile[];
  /** Why the approval does not hold, when it does not. */
  readonly problems: readonly string[];
  /** `project.md`, verbatim. */
  readonly rules: string;
  readonly settings: ReadySettings;
  /** `source.md`, verbatim. */
  readonly source: string;
  readonly title: string;
}

export interface Stage0Report {
  /** Creative acceptance, which validation never implies on its own. */
  readonly approved: boolean;
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
  readonly characterBasis: ProjectFile["characterBasis"];
  readonly title: string;
};
type SetBasisInput = ProjectInput & { readonly basis: NonNullable<ProjectFile["characterBasis"]> };
type ApproveInput = ProjectInput & { readonly note: string | null; readonly reviewer: string };
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
interface EpisodeRef {
  readonly episodeId: string;
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

function prepareStageFile(artifacts: StageFile["artifacts"]): StageFile {
  return { ...emptyStage("prepare"), artifacts };
}

function record(
  inputs: readonly RecordedFile[],
  outputs: readonly RecordedFile[]
): StageFile["artifacts"][string] {
  return newRecord({ inputs, outputs, producer: manualProducer() });
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
    characterBasis: input.characterBasis,
    characterSources: [],
    id: input.projectId,
    schemaVersion: 1,
    title: input.title,
  };

  if (input.characterBasis !== null && !characterBases.includes(input.characterBasis)) {
    return err(
      new InvalidInputError(
        "characterBasis",
        `nieznana podstawa postaci "${input.characterBasis}" — dozwolone: ${characterBases.join(", ")}`
      )
    );
  }

  if (!projectFileSchema.safeParse(file).success) {
    return err(
      new InvalidInputError(
        "aspectRatio",
        `nieprawidłowe proporcje obrazu "${input.aspectRatio}": oczekiwano formatu 16:9`
      )
    );
  }

  const text = serialize(file);
  // No empty directories: `character/sources/` and `episodes/` appear when a
  // command first writes into them, so the tree never promises more than it holds.
  const ops: WriteOp[] = [
    { kind: "text", text: renderRules(input.title), to: paths.data.rules },
    { kind: "text", text, to: paths.data.file },
    {
      kind: "text",
      text: serialize(
        prepareStageFile({
          project: record(
            [],
            [
              {
                path: toWorkspacePath(input.workspace.root, paths.data.file),
                sha256: sha256Of(Buffer.from(text)),
              },
            ]
          ),
        })
      ),
      to: paths.data.prepareStage,
    },
  ];

  const written = await applyWrites(ops, input.mode);

  return written.ok
    ? ok({
        approved: false,
        created: written.data.map((path) => toWorkspacePath(input.workspace.root, path)),
        nextStep: `uzupełnij każdy ${PLACEHOLDER} w project.md, a potem: aimator episode add ${input.projectId} --source <plik.md>`,
        problems:
          input.characterBasis === null
            ? [
                "project.json: characterBasis nie jest ustalony — postać powstaje ze zdjęć (character add) albo z opisu (character describe)",
              ]
            : [],
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
        approved: false,
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
      text: serialize(
        prepareStageFile({
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
        })
      ),
      to: paths.prepareStage,
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

  const lapsed = await approvalLapses(paths.data.prepareStage);
  const written = await applyWrites(ops, input.mode);
  const missing = missingSettings(settings.data);
  const problems = missing.map((field) => `${field}: brak decyzji`);

  if (lapsed) {
    problems.push(
      `akceptacja odcinka "${input.episodeId}" wygasła — zmiana decyzji unieważnia ją; zatwierdź ponownie przez: aimator approve ${input.projectId}`
    );
  }

  return written.ok
    ? ok({
        approved: false,
        created: [],
        nextStep:
          missing.length === 0
            ? `aimator check ${input.projectId}`
            : `pozostałe decyzje: ${missing.join(", ")}`,
        problems,
        ready: missing.length === 0,
        reused: written.data.map((path) => toWorkspacePath(input.workspace.root, path)),
      })
    : written;
}

/**
 * Rewriting a stage file resets its review to pending. Saying so out loud is
 * the difference between an approval that expired and one that vanished.
 */
async function approvalLapses(stagePath: string): Promise<boolean> {
  const stage = await readJson(stagePath, stageFileSchema);

  return stage.ok && isApproved(stage.data);
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

  // Supplying a photograph *is* the declaration that the character is built
  // from photographs; it is never inferred from an empty directory.
  const file: ProjectFile = {
    ...current.data,
    characterBasis: "photographs",
    characterSources: recorded,
  };
  const text = serialize(file);

  ops.push({ kind: "text", text, to: project.data.file });
  ops.push({
    kind: "text",
    text: serialize(
      prepareStageFile({
        project: record(
          recorded.map((asset) => ({ path: asset.path, sha256: asset.sha256 })),
          [
            {
              path: toWorkspacePath(input.workspace.root, project.data.file),
              sha256: sha256Of(Buffer.from(text)),
            },
          ]
        ),
      })
    ),
    to: project.data.prepareStage,
  });

  const lapsed = await approvalLapses(project.data.prepareStage);
  const written = await applyWrites(ops, input.mode);
  const problems: string[] = [];

  if (current.data.characterBasis === "description") {
    problems.push(
      "podstawa postaci zmieniona z opisu na zdjęcia — opis wyglądu w project.md przestaje być wejściem etapu postaci"
    );
  }

  if (lapsed) {
    problems.push(
      `akceptacja projektu wygasła — zatwierdź ponownie przez: aimator approve ${input.projectId}`
    );
  }

  return written.ok
    ? ok({
        approved: false,
        created,
        nextStep:
          "materiały postaci mają status pending — oceny dokonasz w etapie postaci, nie tutaj",
        problems,
        ready: false,
        reused,
      })
    : written;
}

/**
 * The counterpart to `addCharacterSources`: declares that this project builds
 * its character from the written description instead of photographs. Without
 * it an empty `character/sources/` would be indistinguishable from one that is
 * merely still waiting for files.
 */
export async function setCharacterBasis(input: SetBasisInput): Promise<Result<Stage0Report>> {
  const project = await resolveProject(input);

  if (!project.ok) {
    return project;
  }

  const current = await readJson(project.data.file, projectFileSchema);

  if (!current.ok) {
    return current;
  }

  if (input.basis === "photographs" && current.data.characterSources.length === 0) {
    return err(
      new InvalidInputError(
        "characterBasis",
        `podstawy "photographs" nie deklaruje się pustą ręką — dodaj zdjęcia przez: aimator character add ${input.projectId} --source <plik>`
      )
    );
  }

  const file: ProjectFile = { ...current.data, characterBasis: input.basis };
  const text = serialize(file);
  const lapsed = await approvalLapses(project.data.prepareStage);
  const written = await applyWrites(
    [
      { kind: "text", text, to: project.data.file },
      {
        kind: "text",
        text: serialize(
          prepareStageFile({
            project: record(
              current.data.characterSources.map((asset) => ({
                path: asset.path,
                sha256: asset.sha256,
              })),
              [
                {
                  path: toWorkspacePath(input.workspace.root, project.data.file),
                  sha256: sha256Of(Buffer.from(text)),
                },
              ]
            ),
          })
        ),
        to: project.data.prepareStage,
      },
    ],
    input.mode
  );

  return written.ok
    ? ok({
        approved: false,
        created: [],
        nextStep:
          input.basis === "description"
            ? "opis wyglądu w project.md jest jedynym wejściem etapu postaci — musi być konkretny"
            : `aimator check ${input.projectId}`,
        problems: lapsed
          ? [
              `akceptacja projektu wygasła — zatwierdź ponownie przez: aimator approve ${input.projectId}`,
            ]
          : [],
        ready: false,
        reused: written.data.map((path) => toWorkspacePath(input.workspace.root, path)),
      })
    : written;
}

/**
 * Everything a later stage may read from stage 0, in one call.
 *
 * It exists so no other module has to know that the rules are in `project.md`,
 * the decisions in `episode.json` and the ingested text in `source.md` — the
 * layout stays stage 0's business. The four digests come back with the bytes,
 * because a stage that records what it consumed must record the same bytes it
 * actually read.
 *
 * Missing decisions are an error: without them there is nothing to ask a model
 * for. A missing *approval* is not — it comes back as `approved: false` with
 * the reasons, so a dry run can still show what would be sent while the paid
 * path refuses.
 */
export async function readStage0Inputs(
  input: CheckInput & EpisodeRef
): Promise<Result<Stage0Inputs>> {
  const project = await resolveProject({ ...input, mode: "dry-run" });

  if (!project.ok) {
    return project;
  }

  const paths = episodePaths(project.data, input.episodeId);

  if (!paths.ok) {
    return paths;
  }

  const file = await readJson(project.data.file, projectFileSchema);
  const episode = await readJson(paths.data.file, episodeFileSchema);

  if (!file.ok) {
    return file;
  }

  if (!episode.ok) {
    return err(
      new ProjectStateError(
        "missing-episode",
        `odcinek "${input.episodeId}" nie istnieje w projekcie "${input.projectId}"`
      )
    );
  }

  const settings = readySettingsSchema.safeParse(episode.data.settings);

  if (!settings.success || file.data.aspectRatio === null) {
    return err(
      new NotReadyError([
        ...missingSettings(episode.data.settings).map(
          (field) => `odcinek "${input.episodeId}": brak decyzji — ${field}`
        ),
        ...(file.data.aspectRatio === null ? ["project.json: aspectRatio nie jest ustalony"] : []),
      ])
    );
  }

  const rules = await readDigest(project.data.rules);
  const source = await readDigest(paths.data.source);

  if (!rules.ok) {
    return rules;
  }

  if (!source.ok) {
    return source;
  }

  const projectJson = await readDigest(project.data.file);
  const episodeJson = await readDigest(paths.data.file);

  if (!projectJson.ok) {
    return projectJson;
  }

  if (!episodeJson.ok) {
    return episodeJson;
  }

  const relative = (path: string): string => toWorkspacePath(input.workspace.root, path);
  const approval = await approvalOf(input.workspace, project.data, paths.data);

  return ok({
    approved: approval.approved,
    aspectRatio: file.data.aspectRatio,
    inputs: [
      { path: relative(project.data.file), sha256: projectJson.data.sha256 },
      { path: relative(project.data.rules), sha256: rules.data.sha256 },
      { path: relative(paths.data.file), sha256: episodeJson.data.sha256 },
      { path: relative(paths.data.source), sha256: source.data.sha256 },
    ],
    problems: approval.problems,
    rules: rules.data.bytes.toString("utf8"),
    settings: settings.data,
    source: source.data.bytes.toString("utf8"),
    title: file.data.title,
  });
}

/**
 * Stage 0 counts as approved for one episode when the project *and* that
 * episode carry an explicit approval and every digest still matches. Editing
 * an artifact after the fact therefore revokes it by arithmetic, which is the
 * only reason a later stage can trust the word at all.
 */
async function approvalOf(
  workspace: Workspace,
  project: ProjectPaths,
  episode: EpisodePaths
): Promise<{ approved: boolean; problems: readonly string[] }> {
  const problems: string[] = [];
  const stages = [
    { label: "projekt", path: project.prepareStage },
    { label: `odcinek "${basename(episode.root)}"`, path: episode.prepareStage },
  ];
  const files = await Promise.all(stages.map((entry) => readJson(entry.path, stageFileSchema)));
  const verdicts = await Promise.all(
    files.map(async (stage, index) => {
      const label = stages[index]?.label ?? "";

      if (!stage.ok) {
        return { problems: [`${label}: brak zapisu etapu 0 (prepare.stage.json)`] };
      }

      const found: string[] = [];

      await verifyOutputs(workspace, stage.data, label, found);

      if (!isApproved(stage.data)) {
        found.push(`${label}: etap 0 nie ma akceptacji (review.status ≠ approved)`);
      }

      return { problems: found };
    })
  );

  problems.push(...verdicts.flatMap((verdict) => verdict.problems));

  return { approved: problems.length === 0, problems };
}

export async function checkStage0(input: CheckInput): Promise<Result<Stage0Report>> {
  const project = await resolveProject({ ...input, mode: "dry-run" });

  if (!project.ok) {
    return project;
  }

  const verdict = await inspectStage0(input.workspace, project.data);

  if (verdict.problems.length > 0) {
    return err(new NotReadyError(verdict.problems));
  }

  return ok({
    approved: verdict.approved,
    created: [],
    nextStep: verdict.approved
      ? readyNext(input.projectId)
      : `pliki się zgadzają, ale nikt ich jeszcze nie przyjął: aimator approve ${input.projectId}`,
    problems: verdict.lapsed
      ? [
          `project.md zmienił się po akceptacji — te zasady nikt jeszcze nie przyjął; zatwierdź ponownie: aimator approve ${input.projectId}`,
        ]
      : [],
    ready: true,
    reused: verdict.checked,
  });
}

/**
 * Creative acceptance, kept separate from validation on purpose: `check` asks
 * whether the files hold together, `approve` asks whether a human wants them.
 * Approving what does not validate is refused, because an approval recorded
 * against broken provenance would be a lie the later stages would trust.
 */
export async function approveStage0(input: ApproveInput): Promise<Result<Stage0Report>> {
  const project = await resolveProject(input);

  if (!project.ok) {
    return project;
  }

  const verdict = await inspectStage0(input.workspace, project.data);

  if (verdict.problems.length > 0) {
    return err(new NotReadyError(verdict.problems));
  }

  const ops = await approvalWrites(input, project.data, verdict.checked);

  if (!ops.ok) {
    return ops;
  }

  const written = await applyWrites(ops.data, input.mode);

  return written.ok
    ? ok({
        approved: true,
        created: [],
        nextStep: readyNext(input.projectId),
        problems: [],
        ready: true,
        reused: written.data.map((path) => toWorkspacePath(input.workspace.root, path)),
      })
    : written;
}

/**
 * Approval is the moment `project.md` first acquires a digest. Recording one
 * at `init` would describe the empty scaffold; recording one here describes
 * the rules somebody actually accepted, and any later edit breaks it.
 */
async function approvalWrites(
  input: ApproveInput,
  project: ProjectPaths,
  episodeIds: readonly string[]
): Promise<Result<readonly WriteOp[]>> {
  const rules = await readDigest(project.rules);

  if (!rules.ok) {
    return rules;
  }

  const stage = await readJson(project.prepareStage, stageFileSchema);

  if (!stage.ok) {
    return stage;
  }

  const approval = { note: input.note, reviewer: input.reviewer };
  const bound = withOutputs(stage.data, "project", [
    { path: toWorkspacePath(input.workspace.root, project.rules), sha256: rules.data.sha256 },
  ]);
  const ops: WriteOp[] = [
    { kind: "text", text: serialize(approveAll(bound, approval)), to: project.prepareStage },
  ];
  const stages = await Promise.all(episodeIds.map((id) => readEpisodeStage(project, id)));

  for (const [index, entry] of stages.entries()) {
    if (entry === null) {
      return err(
        new ProjectStateError(
          "missing-episode",
          `brak zapisu etapu odcinka "${episodeIds[index] ?? ""}"`
        )
      );
    }

    ops.push({ kind: "text", text: serialize(approveAll(entry.stage, approval)), to: entry.path });
  }

  return ok(ops);
}

async function readEpisodeStage(
  project: ProjectPaths,
  episodeId: string
): Promise<{ path: string; stage: StageFile } | null> {
  const paths = episodePaths(project, episodeId);

  if (!paths.ok) {
    return null;
  }

  const stage = await readJson(paths.data.prepareStage, stageFileSchema);

  return stage.ok ? { path: paths.data.prepareStage, stage: stage.data } : null;
}

async function inspectStage0(workspace: Workspace, project: ProjectPaths): Promise<Stage0Verdict> {
  const file = await readJson(project.file, projectFileSchema);

  if (!file.ok) {
    return { approved: false, checked: [], lapsed: false, problems: [file.error.message] };
  }

  const problems: string[] = [];
  const checked: string[] = [];
  const stage = await readJson(project.prepareStage, stageFileSchema);
  let approved = false;
  let lapsed = false;

  await checkRules(project, problems);
  await checkLayout(workspace, project, problems);
  checkDecisions(file.data, problems);

  if (stage.ok) {
    const rules = await separateRules(workspace, project, stage.data);

    ({ lapsed } = rules);

    await verifyOutputs(workspace, rules.stage, "projekt", problems);

    approved = isApproved(stage.data) && !lapsed;
  } else {
    problems.push("projekt: brak zapisu etapu (prepare.stage.json)");
  }

  const episodes = (await listEntries(project.episodes)).filter((entry) => !entry.startsWith("."));

  if (episodes.length === 0) {
    problems.push("projekt nie ma jeszcze żadnego odcinka");
  }

  const verdicts = await Promise.all(
    episodes.map((episodeId) => checkEpisode(workspace, project, episodeId))
  );

  for (const verdict of verdicts) {
    problems.push(...verdict.problems);
    approved = approved && verdict.approved;

    if (verdict.verified) {
      checked.push(verdict.id);
    }
  }

  return { approved, checked, lapsed, problems };
}

/**
 * The layout rule, verified rather than merely stated. Digests answer "is what
 * we recorded still there"; this answers the other half, "is there something
 * here we never wrote" — which is how a leftover directory survives a tool
 * upgrade and quietly contradicts the rules document beside it.
 */
async function checkLayout(
  workspace: Workspace,
  project: ProjectPaths,
  problems: string[]
): Promise<void> {
  for (const path of await emptyDirectories(project.root)) {
    problems.push(
      `${toWorkspacePath(workspace.root, path)}: katalog nic nie zawiera — usuń go; katalog powstaje dopiero wtedy, gdy etap coś do niego zapisze`
    );
  }
}

/** The project-level decisions that have no default and no later owner. */
function checkDecisions(file: ProjectFile, problems: string[]): void {
  if (file.aspectRatio === null) {
    problems.push("project.json: aspectRatio nie jest ustalony");
  }

  if (file.characterBasis === null) {
    problems.push(
      "project.json: characterBasis nie jest ustalony — zdecyduj, czy postać powstaje ze zdjęć (aimator character add) czy z opisu w project.md (aimator character describe)"
    );
    return;
  }

  if (file.characterBasis === "photographs" && file.characterSources.length === 0) {
    problems.push(
      "project.json: characterBasis to photographs, ale nie ma ani jednego zdjęcia — etap postaci nie miałby od czego zacząć"
    );
  }
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

interface Stage0Verdict {
  readonly approved: boolean;
  readonly checked: readonly string[];
  /** The rules were rewritten after somebody approved them. */
  readonly lapsed: boolean;
  readonly problems: readonly string[];
}

/**
 * `project.md`'s recorded digest is the rules somebody accepted, not something
 * a stage produced. Rewriting the file therefore revokes the approval rather
 * than breaking validation — exactly like changing an episode decision does.
 *
 * The distinction is load-bearing. `approve` refuses whatever fails validation
 * and is also the only thing that records a new digest for these bytes, so
 * counting the mismatch as a failure locked the project out of ever being
 * approved again.
 */
async function separateRules(
  workspace: Workspace,
  project: ProjectPaths,
  stage: StageFile
): Promise<{ lapsed: boolean; stage: StageFile }> {
  const path = toWorkspacePath(workspace.root, project.rules);
  const artifact = stage.artifacts.project;
  const recorded = artifact?.outputs.find((output) => output.path === path);

  if (artifact === undefined || recorded === undefined) {
    return { lapsed: false, stage };
  }

  const rules = await readDigest(project.rules);

  if (rules.ok && rules.data.sha256 === recorded.sha256) {
    return { lapsed: false, stage };
  }

  return {
    lapsed: true,
    stage: {
      ...stage,
      artifacts: {
        ...stage.artifacts,
        project: {
          ...artifact,
          outputs: artifact.outputs.filter((output) => output.path !== path),
        },
      },
    },
  };
}

interface EpisodeVerdict {
  readonly approved: boolean;
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
    return { approved: false, id: episodeId, problems, verified: false };
  }

  const episode = await readJson(paths.data.file, episodeFileSchema);

  if (!episode.ok) {
    problems.push(`odcinek "${episodeId}": ${episode.error.message}`);
    return { approved: false, id: episodeId, problems, verified: false };
  }

  const missing = missingSettings(episode.data.settings);

  if (missing.length > 0) {
    problems.push(`odcinek "${episodeId}": brak decyzji — ${missing.join(", ")}`);
  } else if (!readySettingsSchema.safeParse(episode.data.settings).success) {
    problems.push(`odcinek "${episodeId}": ustawienia nie przechodzą walidacji`);
  }

  const stage = await readJson(paths.data.prepareStage, stageFileSchema);

  if (!stage.ok) {
    problems.push(`odcinek "${episodeId}": brak zapisu etapu (prepare.stage.json)`);
    return { approved: false, id: episodeId, problems, verified: false };
  }

  await verifyOutputs(workspace, stage.data, `odcinek "${episodeId}"`, problems);

  return { approved: isApproved(stage.data), id: episodeId, problems, verified: true };
}

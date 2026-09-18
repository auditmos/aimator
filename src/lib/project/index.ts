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
const READY_NEXT =
  "etap 0 zatwierdzony. Etap 1 (scenariusz) nie jest jeszcze zaimplementowany — to zakres kroku 2 migracji.";
const EMPTY_SETTINGS: DraftSettings = {
  audio: null,
  durationSeconds: null,
  language: null,
  sourceNature: null,
  subtitles: null,
};

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
      ? READY_NEXT
      : `pliki się zgadzają, ale nikt ich jeszcze nie przyjął: aimator approve ${input.projectId}`,
    problems: [],
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
        nextStep: READY_NEXT,
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
    return { approved: false, checked: [], problems: [file.error.message] };
  }

  const problems: string[] = [];
  const checked: string[] = [];
  const stage = await readJson(project.prepareStage, stageFileSchema);
  let approved = false;

  await checkRules(project, problems);
  await checkLayout(workspace, project, problems);
  checkDecisions(file.data, problems);

  if (stage.ok) {
    await verifyOutputs(workspace, stage.data, "projekt", problems);
    approved = isApproved(stage.data);
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

  return { approved, checked, problems };
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
  readonly problems: readonly string[];
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

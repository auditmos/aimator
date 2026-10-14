import { basename, join } from "node:path";
import {
  applyWrites,
  approveAll,
  emptyDirectories,
  emptyStage,
  exists,
  isApproved,
  listDirectory,
  listEntries,
  manualProducer,
  newRecord,
  type RecordedFile,
  readDigest,
  readJson,
  readSupplied,
  removeFile,
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
  type CharacterPaths,
  characterPaths,
  type EpisodePaths,
  episodeIdFromSource,
  episodePaths,
  type ProjectPaths,
  projectPaths,
  type Workspace,
} from "../workspace.js";
import { draftFrom, type RulesDraftInput, type RulesDraftReport } from "./draft.js";
import { lipSyncOf, readLipSync } from "./lip-sync.js";
import {
  audioModes,
  type CharacterEntry,
  type DraftSettings,
  draftSettingsSchema,
  type EpisodeFile,
  episodeFileSchema,
  legacyProjectFileSchema,
  type ProjectFile,
  projectFileSchema,
  type ReadySettings,
  readySettingsSchema,
  STAGE0_DECISIONS,
  type StyleFile,
  sourceNatures,
} from "./schema.js";
import { planStyle, readStyleFile, type StyleDecision, styleOutputs } from "./style.js";
import { PLACEHOLDER, renderRules, styleBibleProblems } from "./template.js";

export type { RulesDraftReport } from "./draft.js";
export { type LipSyncChoice, readLipSync, setLipSync } from "./lip-sync.js";
/** The five episode decisions, all made. A later stage reads them, never the draft. */
export type { ReadySettings as EpisodeSettings, ShotListSettings } from "./schema.js";

/**
 * Stage 0, preparation. The only stage that legitimately ingests material
 * from outside the workspace, which is exactly why it copies those bytes in
 * and records their digest: from here on every stage consumes an artifact a
 * previous stage produced, never a file someone happened to have lying around.
 *
 * Nothing here calls a paid API.
 */

const LANGUAGE_CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
/**
 * Both stages stage 0 unblocks, not just the first one. They do not depend on
 * each other and may run in either order or at once, so naming only the
 * screenplay would read as a sequence the contract does not impose.
 */
const readyNext = (projectId: string, noEpisodes = false): string =>
  noEpisodes
    ? `etap 0 zatwierdzony dla samego projektu. Etap 2 może ruszyć, zacznij od podglądu:
  aimator character generate ${projectId} <character-id> --track <gpt-image|seedream> --dry-run
Etap 1 czeka na odcinek: aimator episode add ${projectId} --source <NN-tytul.md>`
    : `etap 0 zatwierdzony. Etapy 1 i 2 wydają pieniądze i są od siebie niezależne, więc każdy zacznij od podglądu:
  aimator screenplay generate ${projectId} <episode-id> --dry-run
  aimator character generate ${projectId} <character-id> --track <gpt-image|seedream> --dry-run`;
const EMPTY_SETTINGS: DraftSettings = {
  audio: null,
  durationSeconds: null,
  language: null,
  maxClipSeconds: null,
  sourceNature: null,
  subtitles: null,
};

/** One member of the cast as a later stage names it: an id and the person. */
export interface CastMember {
  readonly id: string;
  readonly name: string;
}

/** One member of the cast as the project records it, for a person to read. */
export interface CastEntry extends CastMember {
  /** Null until somebody decides between photographs and a description. */
  readonly basis: CharacterBasis | null;
  /** The photographs this character is drawn from, workspace-relative. */
  readonly sources: readonly string[];
}

/** What a project holds, described rather than judged. */
export interface ProjectOverview {
  readonly aspectRatio: string | null;
  /** In declaration order, which is the order `project.json` keeps. */
  readonly cast: readonly CastEntry[];
  readonly narratorVoiceId: string | null;
  readonly projectId: string;
  /** The style frames: where they come from, null until decided, and how many. */
  readonly style: {
    readonly basis: StyleBasis | null;
    readonly images: number;
    /** The images brought in, workspace-relative, whatever the basis now is. */
    readonly sources: readonly string[];
  };
  readonly title: string;
}

/** What an episode holds, described rather than judged: its source and six decisions. */
export interface EpisodeOverview {
  readonly episodeId: string;
  /**
   * The language the mouths move in, `none`, or null while nobody decided. Beside
   * `settings` rather than in it, because it lives in `lip-sync.json` rather than
   * in `episode.json`, and what it lapses differs accordingly.
   */
  readonly lipSync: string | null;
  readonly number: number;
  readonly projectId: string;
  /** Every decision, null where nobody has made it yet. */
  readonly settings: DraftSettings;
  /**
   * The copy in the workspace, and the file it was copied from, as typed; null
   * when the idea itself was typed into the command and nothing was copied.
   */
  readonly source: { readonly originPath: string | null; readonly path: string };
}

/** Everything stage 1 is allowed to read, with the digests of the bytes it read. */
export interface Stage0Inputs {
  /** Whether a human accepted stage 0 for this project *and* this episode. */
  readonly approved: boolean;
  readonly aspectRatio: string;
  /**
   * The roster, in declaration order. Stage 3 needs it because a shot names who
   * is on screen by cast id, which is the only binding stage 4 can follow back
   * to an image: Polish prose inflects "Ewa" into "Ewy" and "Ewie", so matching
   * a name out of the text would be guesswork. This is the stage-0 roster, not
   * the stage-2 images, stage 3 still does not depend on stage 2.
   */
  readonly cast: readonly CastMember[];
  readonly inputs: readonly RecordedFile[];
  /**
   * Which voice reads this series, or null when nobody has cast one.
   *
   * Null rather than absent, and never a fallback: stage 9 is the only stage
   * that consumes it, so it is the only stage that refuses without it.
   */
  readonly narratorVoiceId: string | null;
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
  /**
   * Files a human accepted whose bytes have changed since, workspace-relative.
   *
   * Only `check` reads for it, and today only `project.md` can land here: it is
   * the one stage-0 file written by hand, so the one that changes behind the
   * tool's back. A decision changed through the CLI lapses the approval too,
   * but that command says so itself. The sentence in `problems` stays; this is
   * the same fact for a reader who must not parse sentences.
   */
  readonly changedSinceApproval: readonly string[];
  readonly created: readonly string[];
  readonly nextStep: string;
  readonly problems: readonly string[];
  readonly ready: boolean;
  /** Copies a replacement took out of the workspace, workspace-relative; only images are ever replaced. */
  readonly removed?: readonly string[];
  readonly reused: readonly string[];
}

/** One episode `episode add` created, or under `--dry-run` would create. */
export interface AddedEpisode {
  readonly episodeId: string;
  readonly number: number;
  /** The file it was copied from; null for an idea typed into the command. */
  readonly originPath: string | null;
}

/**
 * Stage 0's report, plus which episodes one `episode add` produced: one for a
 * file or an idea, every `NN-*.md` for a folder, which may also hold things
 * that are not episodes and are named rather than silently left behind.
 */
export interface EpisodeAddReport extends Stage0Report {
  readonly episodes: readonly AddedEpisode[];
  /** A folder's entries that are not `.md` files, by name; empty for one file. */
  readonly skipped: readonly string[];
}

interface ProjectInput {
  readonly mode: WriteMode;
  readonly projectId: string;
  readonly workspace: Workspace;
}
type WriteRulesInput = ProjectInput & {
  /** The whole of `project.md`, as it is to stand on disk. */
  readonly text: string;
};
type InitProjectInput = ProjectInput & {
  readonly aspectRatio: string | null;
  readonly title: string;
};
/** Every command that names one member of the cast carries its id. */
type CharacterInput = ProjectInput & { readonly characterId: string };
type AddCharacterInput = CharacterInput & { readonly name: string };
/** The one stage-0 decision that belongs to no character: who reads the film. */
type SetVoiceInput = ProjectInput & { readonly voiceId: string };
type SetBasisInput = CharacterInput & {
  readonly basis: NonNullable<CharacterEntry["basis"]>;
};
type ApproveInput = ProjectInput & { readonly note: string | null; readonly reviewer: string };
type AddEpisodeInput = ProjectInput & {
  readonly settings: Partial<DraftSettings>;
} & EpisodeSource;
/**
 * A file somebody saved, whose name carries the episode's number, or an idea
 * typed into the command, which carries it in `episodeId` because there is no
 * file name to read it from. Either way the number is given, never inferred.
 */
type EpisodeSource =
  | { readonly sourcePath: string }
  | { readonly episodeId: string; readonly idea: string };
type SetSettingsInput = ProjectInput & {
  readonly episodeId: string;
  readonly settings: Partial<DraftSettings>;
};
type AddSourcesInput = CharacterInput & {
  /** What the images are: photographs of a real person, or the character's own design. */
  readonly basis: Exclude<CharacterBasis, "description">;
  /** The images given become the whole list; copies no longer named are removed. */
  readonly replace?: boolean;
  /** Files, or directories whose images straight inside are taken by name. */
  readonly sourcePaths: readonly string[];
};
type SetStyleInput = ProjectInput & { readonly decision: StyleDecision };
interface CheckInput {
  readonly projectId: string;
  readonly workspace: Workspace;
}
interface EpisodeRef {
  readonly episodeId: string;
}

class ProjectStateError extends Error {
  readonly reason:
    | "already-exists"
    | "duplicate-number"
    | "missing-character"
    | "missing-episode"
    | "missing-project";

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
        `projekt "${input.projectId}" nie istnieje, utwórz go przez: aimator project init ${input.projectId} --title "..."`
      )
    );
  }

  return paths;
}

/**
 * Reads `project.json`, converting a pre-cast file in memory.
 *
 * A v1 file recorded one basis for a character nobody had named. Carrying that
 * onto whichever member gets declared first would be inventing an answer, so
 * the conversion drops it and every named character starts undecided, which
 * `check` then reports until somebody decides. A v1 file that already holds
 * photographs is refused outright: those bytes belong to a person, and this
 * function has no way to know which one.
 */
async function readProjectFile(path: string): Promise<Result<ProjectFile>> {
  const file = await readJson(path, projectFileSchema);

  if (file.ok) {
    return file;
  }

  const legacy = await readJson(path, legacyProjectFileSchema);

  if (!legacy.ok) {
    // Report against the current schema: the old one is an implementation detail.
    return file;
  }

  if (legacy.data.characterSources.length > 0) {
    return err(
      new InvalidInputError(
        "characters",
        `${path} pochodzi sprzed obsady i trzyma ${legacy.data.characterSources.length} zdjęć przypisanych do nienazwanej postaci, zadeklaruj postać przez "aimator character new", a potem dodaj te zdjęcia do niej przez "aimator character add"; pliki zostają tam, gdzie są`
      )
    );
  }

  return ok({
    aspectRatio: legacy.data.aspectRatio,
    characters: {},
    id: legacy.data.id,
    narratorVoiceId: null,
    schemaVersion: 2,
    title: legacy.data.title,
  });
}

/** Every photograph the cast holds. The project record's inputs are exactly these. */
function castSources(file: ProjectFile): readonly RecordedFile[] {
  return Object.values(file.characters).flatMap((entry) =>
    entry.sources.map((asset) => ({ path: asset.path, sha256: asset.sha256 }))
  );
}

/**
 * The project's stage file with one record replaced and every other one kept.
 *
 * The project record and the style record are written by different commands,
 * and neither may erase the other: a style frame added after the cast was
 * declared is still a stage-0 output, verified like every other one.
 */
async function prepareStageWith(
  paths: ProjectPaths,
  key: string,
  value: StageFile["artifacts"][string]
): Promise<StageFile> {
  const current = await readJson(paths.prepareStage, stageFileSchema);
  const artifacts = current.ok ? current.data.artifacts : {};

  return prepareStageFile({ ...artifacts, [key]: value });
}

/**
 * `project.json` and the stage record carrying its digest, which are never
 * written apart: a project file whose recorded hash describes older bytes is
 * the one state every later stage is entitled to treat as tampering.
 */
async function projectWrites(
  workspace: Workspace,
  paths: ProjectPaths,
  file: ProjectFile
): Promise<readonly WriteOp[]> {
  const text = serialize(file);
  const stage = await prepareStageWith(
    paths,
    "project",
    record(castSources(file), [
      {
        path: toWorkspacePath(workspace.root, paths.file),
        sha256: sha256Of(Buffer.from(text)),
      },
    ])
  );

  return [
    { kind: "text", text, to: paths.file },
    { kind: "text", text: serialize(stage), to: paths.prepareStage },
  ];
}

interface ResolvedCharacter {
  readonly entry: CharacterEntry;
  readonly file: ProjectFile;
  readonly paths: CharacterPaths;
  readonly project: ProjectPaths;
}

/** One member of the cast, or the reason the roster does not hold them. */
async function resolveCharacter(input: CharacterInput): Promise<Result<ResolvedCharacter>> {
  const project = await resolveProject(input);

  if (!project.ok) {
    return project;
  }

  const paths = characterPaths(project.data, input.characterId);

  if (!paths.ok) {
    return paths;
  }

  const file = await readProjectFile(project.data.file);

  if (!file.ok) {
    return file;
  }

  const entry = file.data.characters[input.characterId];

  return entry === undefined
    ? err(
        new ProjectStateError(
          "missing-character",
          `postać "${input.characterId}" nie jest w obsadzie projektu "${input.projectId}", zadeklaruj ją przez: aimator character new ${input.projectId} ${input.characterId} --name "..."`
        )
      )
    : ok({ entry, file: file.data, paths: paths.data, project: project.data });
}

/**
 * Declares that this character exists in the series.
 *
 * The roster is the decision the tool used to skip. Before it, a project with
 * no declared character meant "exactly one, anonymous", so a series whose rules
 * described two people produced one, and which one was left to the model.
 * Whom to declare is a judgement about recurrence: a character whose identity
 * must survive across episodes belongs here, a face seen once is a stage-5
 * reference image instead.
 */
export async function addCharacter(input: AddCharacterInput): Promise<Result<Stage0Report>> {
  const project = await resolveProject(input);

  if (!project.ok) {
    return project;
  }

  const paths = characterPaths(project.data, input.characterId);

  if (!paths.ok) {
    return paths;
  }

  const current = await readProjectFile(project.data.file);

  if (!current.ok) {
    return current;
  }

  if (current.data.characters[input.characterId] !== undefined) {
    return err(
      new ProjectStateError(
        "already-exists",
        `postać "${input.characterId}" jest już w obsadzie, etap 0 nie nadpisuje zatwierdzonych ustaleń`
      )
    );
  }

  const name = input.name.trim();

  if (name === "") {
    return err(
      new InvalidInputError(
        "name",
        "postać potrzebuje nazwy, to ona trafia do promptu etapu postaci i to jej szuka model w zasadach projektu"
      )
    );
  }

  const file: ProjectFile = {
    ...current.data,
    characters: {
      ...current.data.characters,
      [input.characterId]: { basis: null, name, sources: [] },
    },
  };
  const lapsed = await approvalLapses(project.data.prepareStage);
  const written = await applyWrites(
    [...(await projectWrites(input.workspace, project.data, file))],
    input.mode
  );

  return written.ok
    ? ok({
        approved: false,
        changedSinceApproval: [],
        created: [],
        nextStep: `zdecyduj, skąd bierze się wygląd: aimator character design ${input.projectId} ${input.characterId} --source <plik|katalog>, aimator character add ${input.projectId} ${input.characterId} --source <plik> albo aimator character describe ${input.projectId} ${input.characterId}`,
        problems: lapsed
          ? [
              `akceptacja projektu wygasła, zatwierdź ponownie przez: aimator approve ${input.projectId}`,
            ]
          : [],
        ready: false,
        reused: written.data.map((path) => toWorkspacePath(input.workspace.root, path)),
      })
    : written;
}

/**
 * `project.md` drafted from an import's grouping: one paid text call, and a
 * proposal a person reads, corrects and approves like rules they wrote.
 */
export async function draftRules(input: RulesDraftInput): Promise<Result<RulesDraftReport>> {
  const paths = await resolveProject(input);

  if (!paths.ok) {
    return paths;
  }

  const [file, digest] = await Promise.all([
    readProjectFile(paths.data.file),
    readDigest(paths.data.file),
  ]);

  if (!file.ok) {
    return file;
  }

  if (!digest.ok) {
    return digest;
  }

  return await draftFrom(input, {
    facts: {
      aspectRatio: file.data.aspectRatio,
      cast: Object.entries(file.data.characters).map(([id, entry]) => ({ id, name: entry.name })),
      title: file.data.title,
    },
    file: {
      path: toWorkspacePath(input.workspace.root, paths.data.file),
      sha256: digest.data.sha256,
    },
    paths: paths.data,
  });
}

/**
 * `project.md`, written with exactly the text given: the editor's save, for a
 * screen that may not touch the file itself. Nothing in it is checked here,
 * because `check` is where rules are judged and a half-written file is the
 * ordinary state of one being written; only an empty one is refused, since a
 * project without rules is no draft of anything.
 */
export async function writeRules(input: WriteRulesInput): Promise<Result<Stage0Report>> {
  const project = await resolveProject(input);

  if (!project.ok) {
    return project;
  }

  if (input.text.trim() === "") {
    return err(
      new InvalidInputError(
        "rules",
        "project.md nie może być pusty; zasady wspólne to wejście każdego etapu"
      )
    );
  }

  const lapsed = await approvalLapses(project.data.prepareStage);
  const written = await applyWrites(
    [{ kind: "text", text: input.text, to: project.data.rules }],
    input.mode
  );
  const left = input.text.split(PLACEHOLDER).length - 1;

  return written.ok
    ? ok({
        approved: false,
        changedSinceApproval: [],
        created: [],
        nextStep:
          left === 0
            ? `aimator check ${input.projectId}`
            : `w project.md zostało znaczników ${PLACEHOLDER}: ${left}; etap 0 nie przejdzie, póki choć jeden zostanie`,
        problems: lapsed
          ? [
              `akceptacja projektu wygasła, zatwierdź ponownie przez: aimator approve ${input.projectId}`,
            ]
          : [],
        ready: false,
        reused: written.data.map((path) => toWorkspacePath(input.workspace.root, path)),
      })
    : written;
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
        `projekt "${input.projectId}" już istnieje w ${paths.data.root}, etap 0 nie nadpisuje zatwierdzonych ustaleń`
      )
    );
  }

  const file: ProjectFile = {
    aspectRatio: input.aspectRatio,
    characters: {},
    id: input.projectId,
    narratorVoiceId: null,
    schemaVersion: 2,
    title: input.title,
  };

  if (!projectFileSchema.safeParse(file).success) {
    return err(
      new InvalidInputError(
        "aspectRatio",
        `nieprawidłowe proporcje obrazu "${input.aspectRatio}": oczekiwano formatu 16:9`
      )
    );
  }

  const text = serialize(file);
  // No empty directories: `characters/` and `episodes/` appear when a command
  // first writes into them, so the tree never promises more than it holds.
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
        changedSinceApproval: [],
        created: written.data.map((path) => toWorkspacePath(input.workspace.root, path)),
        nextStep: `zadeklaruj obsadę: aimator character new ${input.projectId} <postać> --name <nazwa>`,
        problems: [
          "project.json: obsada jest pusta, wymień każdą powracającą postać serii; jednorazowe pojawienie to referencja etapu 5, nie postać",
        ],
        ready: false,
        reused: [],
      })
    : written;
}

export async function addEpisode(input: AddEpisodeInput): Promise<Result<EpisodeAddReport>> {
  const project = await resolveProject(input);

  if (!project.ok) {
    return project;
  }

  const settings = mergeSettings(EMPTY_SETTINGS, input.settings);

  if (!settings.ok) {
    return settings;
  }

  const context: EpisodeContext = {
    project: project.data,
    projectId: input.projectId,
    settings: settings.data,
    workspace: input.workspace,
  };
  const directory = "sourcePath" in input ? input.sourcePath : null;
  const listing = directory === null ? null : await listDirectory(directory);
  const batch =
    directory === null || listing === null
      ? await planSingle(input, context)
      : await planFolder(directory, listing, context);

  if (!batch.ok) {
    return batch;
  }

  const { planned, skipped } = batch.data;
  const [only] = planned;
  const written = await applyWrites(
    planned.flatMap((episode) => episode.ops),
    input.mode
  );

  return written.ok
    ? ok({
        approved: false,
        changedSinceApproval: [],
        created: written.data.map((path) => toWorkspacePath(input.workspace.root, path)),
        episodes: planned.map((episode) => episode.added),
        nextStep:
          missingSettings(settings.data).length === 0
            ? `aimator check ${input.projectId}`
            : `uzupełnij decyzje: aimator episode set ${input.projectId} ${planned.length === 1 && only !== undefined ? only.added.episodeId : "<episode-id>"} --duration <s> --audio <tryb> --language <kod> --subtitles <kod|none> --nature <rodzaj>`,
        problems: [],
        ready: false,
        reused: [],
        skipped,
      })
    : written;
}

/** What every episode of one `episode add` shares: the project and the decisions. */
interface EpisodeContext {
  readonly project: ProjectPaths;
  readonly projectId: string;
  readonly settings: DraftSettings;
  readonly workspace: Workspace;
}

/** One episode checked against the project and ready to write. */
interface PlannedEpisode {
  readonly added: AddedEpisode;
  readonly ops: readonly WriteOp[];
}

interface Batch {
  readonly planned: readonly PlannedEpisode[];
  readonly skipped: readonly string[];
}

async function planSingle(source: EpisodeSource, context: EpisodeContext): Promise<Result<Batch>> {
  const material = await readSource(source);
  const planned = material.ok ? await planEpisode(material.data, context) : material;

  return planned.ok ? ok({ planned: [planned.data], skipped: [] }) : planned;
}

/**
 * Every `NN-*.md` directly in a folder, as one batch written whole or not at
 * all. Each file meets the rule a single `--source` does, and two files that
 * claim one number clash exactly as a file and an existing episode would. Every
 * problem is named, because a person fixing a folder needs the list, not its
 * first entry. A dotfile is the filesystem talking, as in `emptyDirectories`,
 * so it is neither an episode nor worth a line.
 */
async function planFolder(
  directory: string,
  listing: { readonly files: readonly string[]; readonly others: readonly string[] },
  context: EpisodeContext
): Promise<Result<Batch>> {
  const visible = (name: string): boolean => !name.startsWith(".");
  const sources = listing.files.filter((name) => visible(name) && name.endsWith(".md"));
  const skipped = [
    ...listing.files.filter((name) => visible(name) && !name.endsWith(".md")),
    ...listing.others.filter(visible).map((name) => `${name}/`),
  ].sort();

  if (sources.length === 0) {
    return err(
      new InvalidInputError(
        "source",
        `katalog ${directory} nie zawiera żadnego pliku .md, więc nie ma w nim odcinka`
      )
    );
  }

  const read = await Promise.all(
    sources.map(async (name) => {
      const material = await readSource({ sourcePath: join(directory, name) });

      return {
        material,
        name,
        plan: material.ok ? await planEpisode(material.data, context) : material,
      };
    })
  );
  const problems: string[] = [];
  const claims = new Map<number, string[]>();
  const planned: PlannedEpisode[] = [];

  for (const { material, name, plan } of read) {
    if (material.ok) {
      const { number } = material.data.identity;
      claims.set(number, [...(claims.get(number) ?? []), name]);
    }

    if (plan.ok) {
      planned.push(plan.data);
    } else {
      problems.push(`${name}: ${plan.error.message}`);
    }
  }

  for (const [number, names] of claims) {
    if (names.length > 1) {
      problems.push(
        `${names.join(", ")}: ten sam numer ${number} w jednej paczce, numer wyznacza katalog wyników, więc musi być unikalny`
      );
    }
  }

  return problems.length === 0
    ? ok({ planned, skipped })
    : err(
        new InvalidInputError(
          "source",
          [
            `paczka ${directory} odrzucona w całości, nic nie zapisano:`,
            ...problems.map((problem) => `  ! ${problem}`),
          ].join("\n")
        )
      );
}

/** One episode against the project: its number free, its directory new. */
async function planEpisode(
  material: SourceMaterial,
  context: EpisodeContext
): Promise<Result<PlannedEpisode>> {
  const { identity } = material;
  const clash = await findNumberClash(context.project, identity.number, identity.id);

  if (clash !== null) {
    return err(
      new ProjectStateError(
        "duplicate-number",
        `numer odcinka ${identity.number} jest już zajęty przez "${clash}", numer wyznacza katalog wyników, więc musi być unikalny`
      )
    );
  }

  const paths = episodePaths(context.project, identity.id);

  if (!paths.ok) {
    return paths;
  }

  if (await exists(paths.data.file)) {
    return err(
      new ProjectStateError(
        "already-exists",
        `odcinek "${identity.id}" już istnieje, etap 0 nie nadpisuje źródła`
      )
    );
  }

  const episode: EpisodeFile = {
    id: identity.id,
    number: identity.number,
    projectId: context.projectId,
    schemaVersion: 1,
    settings: context.settings,
    source: {
      originPath: material.originPath,
      path: toWorkspacePath(context.workspace.root, paths.data.source),
      sha256: material.sha256,
    },
  };

  return ok({
    added: { episodeId: identity.id, number: identity.number, originPath: material.originPath },
    ops: episodeWriteOps(context.workspace, paths.data, episode, material.sha256, material.content),
  });
}

/** How the bytes reach `source.md`: copied from a file, or written as typed. */
type SourceContent =
  | { readonly from: string; readonly kind: "copy" }
  | { readonly kind: "text"; readonly text: string };

interface SourceMaterial {
  readonly content: SourceContent;
  readonly identity: { readonly id: string; readonly number: number };
  /** Null when nothing was copied: the idea was typed into the command. */
  readonly originPath: string | null;
  readonly sha256: string;
}

/**
 * The episode's identity and the bytes `source.md` will hold, from either kind
 * of source. An idea's number goes through the same validator as a file name,
 * so `03-wanda` means what `03-wanda.md` would, and it ends with one newline,
 * so `source.md` is a text file whichever way it arrived.
 */
async function readSource(input: EpisodeSource): Promise<Result<SourceMaterial>> {
  if ("idea" in input) {
    const identity = episodeIdFromSource(`${input.episodeId}.md`);
    const text = input.idea.endsWith("\n") ? input.idea : `${input.idea}\n`;

    return identity.ok
      ? ok({
          content: { kind: "text", text },
          identity: identity.data,
          originPath: null,
          sha256: sha256Of(Buffer.from(text)),
        })
      : identity;
  }

  // Read before the name is judged: a path pasted with its quotes names no
  // file, and blaming the name it ends in would send somebody to rename it.
  const source = await readSupplied(input.sourcePath);

  if (!source.ok) {
    return source;
  }

  const identity = episodeIdFromSource(basename(input.sourcePath));

  if (!identity.ok) {
    return identity;
  }

  if (source.data.bytes.byteLength === 0) {
    return err(new InvalidInputError("source", `plik źródłowy ${input.sourcePath} jest pusty`));
  }

  return ok({
    content: { from: input.sourcePath, kind: "copy" },
    identity: identity.data,
    originPath: input.sourcePath,
    sha256: source.data.sha256,
  });
}

function episodeWriteOps(
  workspace: Workspace,
  paths: EpisodePaths,
  episode: EpisodeFile,
  sourceSha: string,
  content: SourceContent
): WriteOp[] {
  const text = serialize(episode);

  return [
    { ...content, to: paths.source },
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
    problems.push(`--audio "${merged.audio}", dozwolone: ${audioModes.join(", ")}`);
  }

  if (merged.sourceNature !== null && !sourceNatures.includes(merged.sourceNature)) {
    problems.push(`--nature "${merged.sourceNature}", dozwolone: ${sourceNatures.join(", ")}`);
  }

  if (merged.language !== null && !LANGUAGE_CODE.test(merged.language)) {
    problems.push(`--language "${merged.language}", oczekiwano kodu języka, np. pl lub en-GB`);
  }

  if (
    merged.subtitles !== null &&
    merged.subtitles !== "none" &&
    !LANGUAGE_CODE.test(merged.subtitles)
  ) {
    problems.push(`--subtitles "${merged.subtitles}", oczekiwano kodu języka albo "none"`);
  }

  if (
    merged.maxClipSeconds !== null &&
    (!Number.isInteger(merged.maxClipSeconds) ||
      merged.maxClipSeconds < 1 ||
      merged.maxClipSeconds > 60)
  ) {
    problems.push(
      `--max-clip ${merged.maxClipSeconds}, liczba całkowita od 1 do 60 (plan montażowy, nie zmierzony limit dostawcy wideo)`
    );
  }

  return problems.length === 0 ? "nieprawidłowe ustawienia odcinka" : problems.join("; ");
}

/**
 * Which of stage 0's own decisions are still unmade.
 *
 * Only the five stages 1 and 2 consume. `maxClipSeconds` sits in the same block
 * but belongs to stage 3, which gates it itself: holding up a character card
 * until somebody has chosen a video-clip length would be an over-constraint, in
 * the same way that requiring an episode before approving a project is one.
 */
function missingSettings(settings: DraftSettings): readonly string[] {
  return STAGE0_DECISIONS.filter((key) => settings[key] === null);
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

  const ops = episodeWriteOps(input.workspace, paths.data, episode, sourceDigest.data.sha256, {
    from: paths.data.source,
    kind: "copy",
  }).filter((op) => op.kind !== "copy");

  const lapsed = await approvalLapses(paths.data.prepareStage);
  const written = await applyWrites(ops, input.mode);
  const missing = missingSettings(settings.data);
  const problems = missing.map((field) => `${field}: brak decyzji`);

  if (lapsed) {
    problems.push(
      `akceptacja odcinka "${input.episodeId}" wygasła, zmiana decyzji unieważnia ją; zatwierdź ponownie przez: aimator approve ${input.projectId}`
    );
  }

  return written.ok
    ? ok({
        approved: false,
        changedSinceApproval: [],
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
 * Why a character's images cannot become another kind, or null when they can.
 * Photographs and a design are both images, and the basis says which all of
 * them are: adding one kind to the other would make stage 2 reproduce a
 * photograph or restyle a design. From a description, files left behind are
 * declared again by whoever brings images back.
 */
function mixedImages(
  characterId: string,
  entry: CharacterEntry,
  basis: CharacterBasis
): string | null {
  if (
    basis === "description" ||
    entry.basis === null ||
    entry.basis === "description" ||
    entry.basis === basis ||
    entry.sources.length === 0
  ) {
    return null;
  }

  const held = entry.basis === "design" ? "obrazy projektu" : "zdjęcia";

  return `postać "${characterId}" ma już ${held} (${entry.sources.length}), a obrazy projektu i zdjęcia się nie mieszają: etap postaci odwzorowuje projekt wiernie, a zdjęcie przenosi do stylu serii`;
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
  const resolved = await resolveCharacter(input);

  if (!resolved.ok) {
    return resolved;
  }

  const { entry, file: current, paths, project } = resolved.data;
  const replace = input.replace === true;
  // A replacement is how one kind becomes the other: nothing of the old kind
  // is left for the new one to mix with.
  const mixed = replace ? null : mixedImages(input.characterId, entry, input.basis);

  if (mixed !== null) {
    return err(new InvalidInputError("basis", mixed));
  }

  const sourcePaths = await imagesIn(input.sourcePaths);

  if (!sourcePaths.ok) {
    return sourcePaths;
  }

  const recorded = replace ? [] : [...entry.sources];
  const ops: WriteOp[] = [];
  const created: string[] = [];
  const reused: string[] = [];

  // Hash every image first: de-duplication compares digests, so the decision
  // for one file depends on the ones before it and must stay ordered.
  const digests = await Promise.all(sourcePaths.data.map((path) => readSupplied(path)));

  for (const [index, sourcePath] of sourcePaths.data.entries()) {
    const digest = digests[index];

    if (digest === undefined || !digest.ok) {
      return digest ?? err(new InvalidInputError("source", `nie można odczytać ${sourcePath}`));
    }

    const name = basename(sourcePath);
    const destination = join(paths.sources, name);
    const path = toWorkspacePath(input.workspace.root, destination);
    const already = recorded.find((asset) => asset.sha256 === digest.data.sha256);

    if (already !== undefined) {
      reused.push(already.path);
      continue;
    }

    // The copy would overwrite bytes a record still vouches for, leaving two
    // records of one file and a digest that no longer describes it.
    if (recorded.some((asset) => asset.path === path)) {
      return err(
        new InvalidInputError(
          "source",
          `postać "${input.characterId}" ma już plik ${name} z inną treścią; nową wersję wnosi --replace`
        )
      );
    }

    recorded.push({ originPath: sourcePath, path, sha256: digest.data.sha256 });
    ops.push({ from: sourcePath, kind: "copy", to: destination });
    created.push(path);
  }

  const removed = entry.sources
    .filter((old) => !recorded.some((asset) => asset.path === old.path))
    .map((old) => old.path);

  // Supplying an image *is* the declaration that this character is built from
  // images of that kind; it is never inferred from an empty directory.
  const file: ProjectFile = {
    ...current,
    characters: {
      ...current.characters,
      [input.characterId]: { ...entry, basis: input.basis, sources: recorded },
    },
  };

  ops.push(...(await projectWrites(input.workspace, project, file)));

  const lapsed = await approvalLapses(project.prepareStage);
  const written = await applyWrites(ops, input.mode);
  const problems: string[] = [];

  if (entry.basis === "description") {
    problems.push(
      `podstawa postaci "${entry.name}" zmieniona z opisu na ${input.basis === "design" ? "projekt postaci" : "zdjęcia"}, opis jej wyglądu w project.md przestaje być wejściem etapu postaci`
    );
  }

  if (lapsed) {
    problems.push(
      `akceptacja projektu wygasła, zatwierdź ponownie przez: aimator approve ${input.projectId}`
    );
  }

  if (!written.ok) {
    return written;
  }

  // After project.json stops naming them, so a failure here leaves a stray
  // copy behind rather than a record pointing at nothing.
  if (input.mode === "apply") {
    await Promise.all(removed.map((path) => removeFile(join(input.workspace.root, path))));
  }

  return ok({
    approved: false,
    changedSinceApproval: [],
    created,
    nextStep: "materiały postaci mają status pending, oceny dokonasz w etapie postaci, nie tutaj",
    problems,
    ready: false,
    removed,
    reused,
  });
}

/** What a directory of a character's images may hold, besides hidden files. */
const IMAGE_FILE = /\.(?:jpe?g|png|webp)$/i;

/**
 * Every path as the files it names: a file as itself, a directory as the
 * images straight inside it, by name. Anything else in a directory refuses
 * the whole call rather than being left out, because a view that quietly
 * stayed behind is the one nobody would notice missing.
 */
async function imagesIn(sourcePaths: readonly string[]): Promise<Result<readonly string[]>> {
  const files: string[] = [];

  for (const sourcePath of sourcePaths) {
    // biome-ignore lint/performance/noAwaitInLoops: a handful of paths, kept in order
    const listing = await listDirectory(sourcePath);

    if (listing === null) {
      files.push(sourcePath);
      continue;
    }

    const visible = (name: string): boolean => !name.startsWith(".");
    const images = listing.files.filter((name) => visible(name) && IMAGE_FILE.test(name));
    const strays = [
      ...listing.files.filter((name) => visible(name) && !IMAGE_FILE.test(name)),
      ...listing.others.filter(visible).map((name) => `${name}/`),
    ];

    if (strays.length > 0) {
      return err(
        new InvalidInputError(
          "source",
          `katalog ${sourcePath} ma coś poza obrazami (PNG, JPEG, WebP): ${strays.join(", ")}; obrazy postaci leżą wprost w nim i nic więcej`
        )
      );
    }

    if (images.length === 0) {
      return err(new InvalidInputError("source", `katalog ${sourcePath} nie ma żadnego obrazu`));
    }

    files.push(...images.map((name) => join(sourcePath, name)));
  }

  return ok(files);
}

/**
 * The counterpart to `addCharacterSources`: declares that this character is
 * built from the written rules instead of photographs. Without it an empty
 * `sources/` would be indistinguishable from one still waiting for files.
 */
export async function setCharacterBasis(input: SetBasisInput): Promise<Result<Stage0Report>> {
  const resolved = await resolveCharacter(input);

  if (!resolved.ok) {
    return resolved;
  }

  const { entry, file: current, project } = resolved.data;

  if (input.basis !== "description" && entry.sources.length === 0) {
    return err(
      new InvalidInputError(
        "basis",
        `podstawy "${input.basis}" nie deklaruje się pustą ręką, dodaj ${input.basis === "design" ? "obrazy projektu" : "zdjęcia"} przez: aimator character ${input.basis === "design" ? "design" : "add"} ${input.projectId} ${input.characterId} --source <plik>`
      )
    );
  }

  const mixed = mixedImages(input.characterId, entry, input.basis);

  if (mixed !== null) {
    return err(new InvalidInputError("basis", mixed));
  }

  const file: ProjectFile = {
    ...current,
    characters: {
      ...current.characters,
      [input.characterId]: { ...entry, basis: input.basis },
    },
  };
  const lapsed = await approvalLapses(project.prepareStage);
  const written = await applyWrites(
    [...(await projectWrites(input.workspace, project, file))],
    input.mode
  );

  return written.ok
    ? ok({
        approved: false,
        changedSinceApproval: [],
        created: [],
        nextStep:
          input.basis === "description"
            ? `opis wyglądu "${entry.name}" w project.md jest jedynym wejściem etapu postaci, musi być konkretny`
            : `aimator check ${input.projectId}`,
        problems: lapsed
          ? [
              `akceptacja projektu wygasła, zatwierdź ponownie przez: aimator approve ${input.projectId}`,
            ]
          : [],
        ready: false,
        reused: written.data.map((path) => toWorkspacePath(input.workspace.root, path)),
      })
    : written;
}

/**
 * Casts the narrator.
 *
 * It sits among the stage-0 commands rather than inside stage 9 because a voice
 * is a property of the series, not of one episode's soundtrack, the same
 * reason `aspectRatio` and the roster are decided here and merely consumed
 * below. Recording it revokes the project's approval like any other decision,
 * because approval is bound to the file as it stands.
 */
export async function setNarratorVoice(input: SetVoiceInput): Promise<Result<Stage0Report>> {
  const project = await resolveProject(input);

  if (!project.ok) {
    return project;
  }

  const current = await readProjectFile(project.data.file);

  if (!current.ok) {
    return current;
  }

  const file: ProjectFile = { ...current.data, narratorVoiceId: input.voiceId };
  const lapsed = await approvalLapses(project.data.prepareStage);
  const written = await applyWrites(
    [...(await projectWrites(input.workspace, project.data, file))],
    input.mode
  );

  return written.ok
    ? ok({
        approved: false,
        changedSinceApproval: [],
        created: [],
        nextStep: `aimator check ${input.projectId}`,
        problems: lapsed
          ? [
              `akceptacja projektu wygasła, zatwierdź ponownie przez: aimator approve ${input.projectId}`,
            ]
          : [],
        ready: false,
        reused: written.data.map((path) => toWorkspacePath(input.workspace.root, path)),
      })
    : written;
}

/**
 * Decides the project's style frames: images brought in, or none.
 *
 * A stage-0 command because bringing a file in from outside the workspace is
 * stage 0's monopoly, so a supplied image is recorded as this stage's output,
 * beside `project.json`, and an addition after approval lapses it exactly as
 * `character add` does. The decision itself sits in `style.json`, which only
 * film frames record, so changing it lapses those and nothing above them.
 */
export async function setStyle(input: SetStyleInput): Promise<Result<Stage0Report>> {
  const project = await resolveProject(input);

  if (!project.ok) {
    return project;
  }

  const current = await readStyleFile(project.data.style);

  if (!current.ok) {
    return current;
  }

  const planned = await planStyle(input.workspace, project.data, current.data, input.decision);

  if (!planned.ok) {
    return planned;
  }

  const text = serialize(planned.data.file);
  const stage = await prepareStageWith(
    project.data,
    "style",
    record([], styleOutputs(input.workspace, project.data, planned.data.file, text))
  );
  const lapsed = await approvalLapses(project.data.prepareStage);
  const written = await applyWrites(
    [
      ...planned.data.copies,
      { kind: "text", text, to: project.data.style },
      { kind: "text", text: serialize(stage), to: project.data.prepareStage },
    ],
    input.mode
  );

  return written.ok
    ? ok({
        approved: false,
        changedSinceApproval: [],
        created: planned.data.created,
        nextStep: `aimator check ${input.projectId}`,
        problems: lapsed
          ? [
              `akceptacja projektu wygasła, zatwierdź ponownie przez: aimator approve ${input.projectId}`,
            ]
          : [],
        ready: false,
        reused: planned.data.reused,
      })
    : written;
}

/**
 * Everything a later stage may read from stage 0, in one call.
 *
 * It exists so no other module has to know that the rules are in `project.md`,
 * the decisions in `episode.json` and the ingested text in `source.md`, the
 * layout stays stage 0's business. The four digests come back with the bytes,
 * because a stage that records what it consumed must record the same bytes it
 * actually read.
 *
 * Missing decisions are an error: without them there is nothing to ask a model
 * for. A missing *approval* is not, it comes back as `approved: false` with
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

  const file = await readProjectFile(project.data.file);
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
          (field) => `odcinek "${input.episodeId}": brak decyzji, ${field}`
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
    cast: Object.entries(file.data.characters).map(([id, entry]) => ({ id, name: entry.name })),
    inputs: [
      { path: relative(project.data.file), sha256: projectJson.data.sha256 },
      { path: relative(project.data.rules), sha256: rules.data.sha256 },
      { path: relative(paths.data.file), sha256: episodeJson.data.sha256 },
      { path: relative(paths.data.source), sha256: source.data.sha256 },
    ],
    narratorVoiceId: file.data.narratorVoiceId,
    problems: approval.problems,
    rules: rules.data.bytes.toString("utf8"),
    settings: settings.data,
    source: source.data.bytes.toString("utf8"),
    title: file.data.title,
  });
}

/**
 * What a project holds: its title, its frame, its narrator and its cast.
 *
 * The one read of stage 0 that needs no episode and judges nothing. Every
 * write above reports what it changed, and none reports what the project now
 * holds, so without this a screen that wanted to show the cast would have had
 * to read `project.json` itself. Undecided fields come back as null rather
 * than absent, for the reason the file stores them that way: "nobody chose"
 * is a fact to state, not an absence to infer. Whether any of it is enough is
 * `checkStage0`'s question, and answering it here too would be two gates.
 */
export async function showProject(input: CheckInput): Promise<Result<ProjectOverview>> {
  const project = await resolveProject({ ...input, mode: "dry-run" });

  if (!project.ok) {
    return project;
  }

  const file = await readProjectFile(project.data.file);

  if (!file.ok) {
    return file;
  }

  const style = await readStyleFile(project.data.style);

  if (!style.ok) {
    return style;
  }

  const sources = style.data?.sources.map((one) => one.path) ?? [];

  return ok({
    aspectRatio: file.data.aspectRatio,
    cast: Object.entries(file.data.characters).map(([id, entry]) => ({
      basis: entry.basis,
      id,
      name: entry.name,
      sources: entry.sources.map((asset) => asset.path),
    })),
    narratorVoiceId: file.data.narratorVoiceId,
    projectId: input.projectId,
    style: { basis: style.data?.basis ?? null, images: imagesOf(style.data), sources },
    title: file.data.title,
  });
}

/**
 * How many style frames a frame will carry: the images brought in, or the
 * number decided per track. None while undecided or decided against.
 */
function imagesOf(style: StyleFile | null): number {
  if (style?.basis === "generated") {
    return style.count;
  }

  return style?.basis === "supplied" ? style.sources.length : 0;
}

/**
 * What an episode holds: where its source came from, and its six decisions.
 *
 * `showProject` one level down, and a description for the same reason: every
 * decision here could be written by `episode set` and judged by `check`, and
 * nothing said what it currently was, so a screen editing the decisions had to
 * start from empty fields over values it could not see. Undecided settings come
 * back as null, and whether they are enough stays `checkStage0`'s question.
 */
export async function showEpisode(
  input: CheckInput & EpisodeRef
): Promise<Result<EpisodeOverview>> {
  const project = await resolveProject({ ...input, mode: "dry-run" });

  if (!project.ok) {
    return project;
  }

  const paths = episodePaths(project.data, input.episodeId);

  if (!paths.ok) {
    return paths;
  }

  const episode = await readJson(paths.data.file, episodeFileSchema);

  if (!episode.ok) {
    return err(
      new ProjectStateError(
        "missing-episode",
        `odcinek "${input.episodeId}" nie istnieje w projekcie "${input.projectId}"`
      )
    );
  }

  const lipSync = await readLipSync(input);

  if (!lipSync.ok) {
    return lipSync;
  }

  return ok({
    episodeId: input.episodeId,
    lipSync: lipSyncOf(lipSync.data),
    number: episode.data.number,
    projectId: input.projectId,
    settings: episode.data.settings,
    source: { originPath: episode.data.source.originPath, path: episode.data.source.path },
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

  const problems: string[] = [];

  if (verdict.lapsed) {
    problems.push(
      `project.md zmienił się po akceptacji, te zasady nikt jeszcze nie przyjął; zatwierdź ponownie: aimator approve ${input.projectId}`
    );
  }

  // Reported, never a blocker. Stage 2 reads no episode at all, so refusing to
  // approve a project without one would hold the character stage hostage to a
  // file it never opens.
  if (verdict.noEpisodes) {
    problems.push(
      `projekt nie ma jeszcze żadnego odcinka, etap 2 tego nie potrzebuje, etap 1 tak: aimator episode add ${input.projectId} --source <NN-tytul.md>`
    );
  }

  return ok({
    approved: verdict.approved,
    changedSinceApproval: verdict.lapsed
      ? [toWorkspacePath(input.workspace.root, project.data.rules)]
      : [],
    created: [],
    nextStep: verdict.approved
      ? readyNext(input.projectId, verdict.noEpisodes)
      : `pliki się zgadzają, ale nikt ich jeszcze nie przyjął: aimator approve ${input.projectId}`,
    problems,
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
        changedSinceApproval: [],
        created: [],
        nextStep: readyNext(input.projectId, verdict.noEpisodes),
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
  const file = await readProjectFile(project.file);

  if (!file.ok) {
    return {
      approved: false,
      checked: [],
      lapsed: false,
      noEpisodes: false,
      problems: [file.error.message],
    };
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

  return { approved, checked, lapsed, noEpisodes: episodes.length === 0, problems };
}

/**
 * The layout rule, verified rather than merely stated. Digests answer "is what
 * we recorded still there"; this answers the other half, "is there something
 * here we never wrote", which is how a leftover directory survives a tool
 * upgrade and quietly contradicts the rules document beside it.
 */
async function checkLayout(
  workspace: Workspace,
  project: ProjectPaths,
  problems: string[]
): Promise<void> {
  for (const path of await emptyDirectories(project.root)) {
    problems.push(
      `${toWorkspacePath(workspace.root, path)}: katalog nic nie zawiera, usuń go; katalog powstaje dopiero wtedy, gdy etap coś do niego zapisze`
    );
  }
}

/** The project-level decisions that have no default and no later owner. */
function checkDecisions(file: ProjectFile, problems: string[]): void {
  if (file.aspectRatio === null) {
    problems.push("project.json: aspectRatio nie jest ustalony");
  }

  const cast = Object.entries(file.characters);

  // An empty roster used to mean "one character, anonymous". It now means
  // nobody has said who is in the series, and that is not an answer.
  if (cast.length === 0) {
    problems.push(
      `project.json: obsada jest pusta, wymień każdą powracającą postać przez "aimator character new ${file.id} <postać> --name <nazwa>"; postać widziana raz to referencja etapu 5, nie postać`
    );
    return;
  }

  for (const [characterId, entry] of cast) {
    if (entry.basis === null) {
      problems.push(
        `project.json: postać "${characterId}" nie ma ustalonej podstawy, zdecyduj, czy powstaje z projektu postaci (aimator character design ${file.id} ${characterId} --source <plik>), ze zdjęć (aimator character add ${file.id} ${characterId} --source <plik>) czy z opisu w project.md (aimator character describe ${file.id} ${characterId})`
      );
    } else if (entry.basis !== "description" && entry.sources.length === 0) {
      problems.push(
        `project.json: postać "${characterId}" ma podstawę ${entry.basis}, ale nie ma ani jednego ${entry.basis === "design" ? "obrazu projektu" : "zdjęcia"}, etap postaci nie miałby od czego zacząć`
      );
    }
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
  /** True as long as no episode has been added. Reported, never a blocker. */
  readonly noEpisodes: boolean;
  readonly problems: readonly string[];
}

/**
 * `project.md`'s recorded digest is the rules somebody accepted, not something
 * a stage produced. Rewriting the file therefore revokes the approval rather
 * than breaking validation, exactly like changing an episode decision does.
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
    problems.push(`odcinek "${episodeId}": brak decyzji, ${missing.join(", ")}`);
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

/** Where one character's appearance comes from, decided and never defaulted. */
export type CharacterBasis = NonNullable<CharacterEntry["basis"]>;

/** Where the style frames come from, decided and never defaulted. */
export type StyleBasis = StyleFile["basis"];

/** Everything stage 2 may read from stage 0, for one character, in one call. */
export interface Stage0Character {
  /** Whether a human accepted stage 0 for this project. */
  readonly approved: boolean;
  readonly basis: CharacterBasis;
  readonly inputs: readonly RecordedFile[];
  readonly name: string;
  /** Why the approval does not hold, when it does not. */
  readonly problems: readonly string[];
  /** `project.md`, verbatim. The whole document: the shared rules bind too. */
  readonly rules: string;
  /** This character's photographs, absolute, in a stable order. */
  readonly sources: readonly { readonly path: string; readonly sha256: string }[];
}

/**
 * The stage-2 counterpart to `readStage0Inputs`. It reads no episode, because
 * the character stage does not depend on one and may run beside stage 1.
 *
 * An undecided basis is an error: without it there is nothing to draw from.
 * A missing *approval* is not, it comes back as `approved: false` with the
 * reasons, so a dry run can still show what would be sent while the paid path
 * refuses.
 */
export async function readStage0Character(
  input: CheckInput & { readonly characterId: string }
): Promise<Result<Stage0Character>> {
  const resolved = await resolveCharacter({ ...input, mode: "dry-run" });

  if (!resolved.ok) {
    return resolved;
  }

  const { entry, project } = resolved.data;

  if (entry.basis === null) {
    return err(
      new NotReadyError([
        `postać "${input.characterId}" nie ma ustalonej podstawy, aimator character design ${input.projectId} ${input.characterId} --source <plik>, aimator character add ${input.projectId} ${input.characterId} --source <plik> albo aimator character describe ${input.projectId} ${input.characterId}`,
      ])
    );
  }

  if (entry.basis !== "description" && entry.sources.length === 0) {
    return err(
      new NotReadyError([
        `postać "${input.characterId}" ma podstawę ${entry.basis}, ale nie ma ani jednego ${entry.basis === "design" ? "obrazu projektu" : "zdjęcia"}`,
      ])
    );
  }

  const rules = await readDigest(project.rules);
  const projectJson = await readDigest(project.file);

  if (!rules.ok) {
    return rules;
  }

  if (!projectJson.ok) {
    return projectJson;
  }

  const relative = (path: string): string => toWorkspacePath(input.workspace.root, path);
  const approval = await projectApproval(input.workspace, project);
  // Sorted by recorded path so two runs build the same reference order.
  const sources = [...entry.sources]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((asset) => ({
      path: join(input.workspace.root, asset.path),
      sha256: asset.sha256,
    }));

  return ok({
    approved: approval.approved,
    basis: entry.basis,
    inputs: [
      { path: relative(project.file), sha256: projectJson.data.sha256 },
      { path: relative(project.rules), sha256: rules.data.sha256 },
      ...entry.sources.map((asset) => ({ path: asset.path, sha256: asset.sha256 })),
    ],
    name: entry.name,
    problems: approval.problems,
    rules: rules.data.bytes.toString("utf8"),
    sources,
  });
}

/** Everything a stage may read about the style frames, in one call. */
export interface Stage0Style {
  /**
   * Whether stage 0 of this project holds as it stands. A brought image has no
   * review of its own: it is a stage-0 output, accepted with the rest of it.
   */
  readonly approved: boolean;
  /** The film frame a generated style frame is drawn in; null while undecided. */
  readonly aspectRatio: string | null;
  /** Null while nobody has decided, which is not the same as "none". */
  readonly basis: StyleBasis | null;
  /** The cast, which a generated style frame must show none of. */
  readonly cast: readonly CastMember[];
  /** How many style frames each track generates; null unless `generated`. */
  readonly count: number | null;
  /** `style.json` with the digest of the bytes read; null while undecided. */
  readonly file: RecordedFile | null;
  /**
   * What a generated style frame consumes, with the digest of each file read:
   * `project.json` for the frame, `project.md` for the Style Bible, and
   * `style.json` for how many frames there are.
   */
  readonly inputs: readonly RecordedFile[];
  /** Why the approval does not hold, when it does not. */
  readonly problems: readonly string[];
  /** `project.md`, verbatim. */
  readonly rules: string;
  /**
   * The images this decision attaches, in id order: absolute, with the digest
   * stage 0 recorded. Empty unless the basis is `supplied`.
   */
  readonly sources: readonly {
    readonly id: string;
    readonly path: string;
    readonly sha256: string;
  }[];
  /**
   * Why the Style Bible cannot be drawn from yet: absent, or still marked.
   * Empty when it can. Only generation needs it; brought images do not.
   */
  readonly styleBible: readonly string[];
}

/**
 * The style decision as stages 5 to 7 consume it. It reads no episode: the
 * style belongs to the series, as the cast does. An undecided style is not an
 * error here, it comes back as `basis: null`, so a dry run can still show what
 * would be sent while the stages refuse.
 */
export async function readStage0Style(input: CheckInput): Promise<Result<Stage0Style>> {
  const project = await resolveProject({ ...input, mode: "dry-run" });

  if (!project.ok) {
    return project;
  }

  const style = await readStyleFile(project.data.style);
  const file = await readProjectFile(project.data.file);
  const projectJson = await readDigest(project.data.file);
  const rules = await readDigest(project.data.rules);

  if (!style.ok) {
    return style;
  }
  if (!file.ok) {
    return file;
  }
  if (!projectJson.ok) {
    return projectJson;
  }
  if (!rules.ok) {
    return rules;
  }

  const relative = (path: string): string => toWorkspacePath(input.workspace.root, path);
  const digest = style.data === null ? null : await readDigest(project.data.style);

  if (digest !== null && !digest.ok) {
    return digest;
  }

  const recorded =
    digest === null ? null : { path: relative(project.data.style), sha256: digest.data.sha256 };
  const approval = await projectApproval(input.workspace, project.data);
  const text = rules.data.bytes.toString("utf8");

  return ok({
    approved: approval.approved,
    aspectRatio: file.data.aspectRatio,
    basis: style.data?.basis ?? null,
    cast: Object.entries(file.data.characters).map(([id, entry]) => ({ id, name: entry.name })),
    count: style.data?.basis === "generated" ? style.data.count : null,
    file: recorded,
    inputs: [
      { path: relative(project.data.file), sha256: projectJson.data.sha256 },
      { path: relative(project.data.rules), sha256: rules.data.sha256 },
      ...(recorded === null ? [] : [recorded]),
    ],
    problems: approval.problems,
    rules: text,
    sources:
      style.data?.basis === "supplied"
        ? style.data.sources.map((one) => ({
            id: one.id,
            path: join(input.workspace.root, one.path),
            sha256: one.sha256,
          }))
        : [],
    styleBible: styleBibleProblems(text),
  });
}

/**
 * Stage 0 counts as approved for a character when the project record carries an
 * explicit approval and every digest still matches. No episode is consulted:
 * the cast belongs to the project, and a project with one unfinished episode
 * must not block work on a character that episode does not own.
 */
async function projectApproval(
  workspace: Workspace,
  project: ProjectPaths
): Promise<{ approved: boolean; problems: readonly string[] }> {
  const stage = await readJson(project.prepareStage, stageFileSchema);

  if (!stage.ok) {
    return { approved: false, problems: ["projekt: brak zapisu etapu 0 (prepare.stage.json)"] };
  }

  const problems: string[] = [];

  await verifyOutputs(workspace, stage.data, "projekt", problems);

  if (!isApproved(stage.data)) {
    problems.push("projekt: etap 0 nie ma akceptacji (review.status ≠ approved)");
  }

  return { approved: problems.length === 0, problems };
}

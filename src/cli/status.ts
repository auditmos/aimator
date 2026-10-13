import { stat } from "node:fs/promises";
import { readJson, stageFileSchema } from "../lib/artifact/index.js";
import { checkAssembly } from "../lib/assembly/index.js";
import { checkCharacter } from "../lib/character/index.js";
import { checkClips } from "../lib/clips/index.js";
import { checkDialogue, type DialogueStatus } from "../lib/dialogue/index.js";
import { checkMix, checkNarration } from "../lib/narration/index.js";
import { checkOpeningFrame } from "../lib/opening-frame/index.js";
import {
  checkStage0,
  type EpisodeSettings,
  readLipSync,
  readStage0Inputs,
} from "../lib/project/index.js";
import { checkPromptPackage } from "../lib/prompt-package/index.js";
import { checkReferences } from "../lib/references/index.js";
import { ok, type Result } from "../lib/result.js";
import { checkScreenplay } from "../lib/screenplay/index.js";
import { checkShotList } from "../lib/shot-list/index.js";
import { checkMaster, checkSoundDesign } from "../lib/sound-design/index.js";
import { checkVersions } from "../lib/versions/index.js";
import {
  characterPaths,
  characterTrackPaths,
  type EpisodePaths,
  type EpisodeTrackPaths,
  episodePaths,
  episodeTrackPaths,
  type ImageTrack,
  imageTracks,
  type ProjectPaths,
  projectPaths,
  type Workspace,
} from "../lib/workspace.js";
import { parse, requirePositional, workspaceOf } from "./common.js";

/** The one question this command answers, and the shape it answers it in. */
export const USAGE = `  status <id> <episode-id> [--json]
    Jedno pytanie zamiast kilkunastu: stan każdego etapu odcinka, osobno na
    każdym torze i na każdej postaci, w jednym z sześciu stanów, z powodem
    blokady, i dokładnie jedno "Dalej:" dla całego odcinka. Etap, którego
    odcinek według własnych decyzji nie potrzebuje, ma stan "nie dotyczy".
    Woła check każdego etapu; niczego nie zapisuje i niczego nie wydaje.
    --json wypisuje ten sam obiekt, który renderuje tekst: pole command mówi,
    która komenda go wypisała, a każda komórka niesie obiekt swojego etapu bez
    zmian. Odmowa zostaje w Result, dokładnie jak bez flagi.`;

/**
 * Six states, and nothing between them.
 *
 * They are read off what `check` already answers rather than off the disk, with
 * two exceptions the contract names: a lock file is the only evidence that a
 * stage is mid-flight, because a stage that has written nothing yet and a stage
 * that is writing right now look the same in every artifact it owns; and a
 * stage the episode's own decisions rule out is `excluded` before any of its
 * files is read, because no verdict of it can bring it back into the film.
 */
type CellState = "approved" | "blocked" | "excluded" | "ready" | "review" | "running";

/** What every stage's artifacts answer, whatever else they also answer. */
interface Reviewed {
  readonly approved: boolean;
  readonly id: string;
  readonly state: "absent" | "completed" | "submitted";
}

interface StatusCell {
  /** Set only where a cell is per character, which is stage 2 alone. */
  readonly character: string | null;
  readonly id: string;
  /** The command that moves this cell, or null where nothing moves it. */
  readonly nextStep: string | null;
  /** Why the cell is blocked, in the stage's own words. */
  readonly reason: string | null;
  readonly stage: number;
  readonly state: CellState;
  /** The stage's own check object, verbatim; null when the stage refused. */
  readonly status: object | null;
  readonly title: string;
  readonly track: ImageTrack | null;
}

interface EpisodeStatus {
  readonly cells: readonly StatusCell[];
  /**
   * Which command wrote this object, and the only field `--json` adds here:
   * this one answers for a whole episode, so it has no stage to name.
   */
  readonly command: "status";
  readonly episodeId: string;
  /** The one unblocked step of the whole episode, or null when there is none. */
  readonly next: { readonly cell: string; readonly command: string } | null;
  readonly projectId: string;
}

const LABEL: Record<CellState, string> = {
  approved: "zatwierdzony",
  blocked: "zablokowany",
  excluded: "nie dotyczy",
  ready: "gotowy do generowania",
  review: "do przeglądu",
  running: "w toku",
};

/** A lock is a file written with `wx`, so its presence is the whole question. */
async function held(path: string): Promise<boolean> {
  try {
    await stat(path);

    return true;
  } catch {
    return false;
  }
}

/**
 * What a person said no to, and why, read from the stage file itself.
 *
 * The second thing here read off the disk rather than off `check`, and for the
 * lock's reason: a no is not a verdict on bytes, so no stage reports it, and
 * the cell it belongs to looks exactly like one nobody has looked at yet. One
 * rejection reads as its note; several name the artifact each is about.
 */
async function rejectedIn(path: string): Promise<string | null> {
  const file = await readJson(path, stageFileSchema);
  const notes = file.ok
    ? Object.entries(file.data.artifacts)
        .filter(([, record]) => record.review.status === "rejected")
        .map(([key, record]) => ({ key, note: record.review.note ?? "" }))
    : [];
  const [only] = notes;

  if (only === undefined) {
    return null;
  }

  return notes.length === 1
    ? `odrzucone: ${only.note}`
    : `odrzucone: ${notes.map((one) => `${one.key}: ${one.note}`).join("; ")}`;
}

/** Artifacts that validated and are waiting for a person, in the stage's ids. */
function pending(parts: readonly Reviewed[]): readonly string[] {
  return parts
    .filter((part) => part.state === "completed" && !part.approved)
    .map((part) => part.id);
}

interface CellInput {
  readonly approved: boolean;
  readonly character?: string;
  readonly id: string;
  readonly locked: boolean;
  readonly parts: readonly Reviewed[];
  readonly problems: readonly string[];
  /** What to run when the cell is ready to produce. */
  readonly produce: string;
  /** Why a person said no, when one did; the reason of a cell waiting for review. */
  readonly rejected: string | null;
  /** What to run when the cell has something a person must look at. */
  readonly review: (waiting: readonly string[]) => string;
  readonly stage: number;
  readonly status: object | null;
  readonly title: string;
  readonly track?: ImageTrack;
}

/**
 * One cell of a stage that was read, in the order its five states exclude each
 * other; the sixth, `excluded`, is settled before the stage is read at all.
 *
 * A held lock wins over everything, because a stage writing right now says
 * nothing trustworthy about itself in its own files. An approval wins next: it
 * is the only state a human produces, and a stage that reports drift after one
 * is reporting it about bytes somebody already accepted. Then what validated
 * and is waiting, then what is refused, and only what is left is ready.
 */
function cellOf(input: CellInput): StatusCell {
  const waiting = pending(input.parts);
  const state = ((): CellState => {
    if (input.locked) {
      return "running";
    }
    if (input.approved) {
      return "approved";
    }
    if (waiting.length > 0) {
      return "review";
    }

    return input.problems.length > 0 ? "blocked" : "ready";
  })();
  const nextStep = ((): string | null => {
    if (state === "review") {
      return input.review(waiting);
    }

    return state === "ready" ? input.produce : null;
  })();

  return {
    character: input.character ?? null,
    id: input.id,
    nextStep,
    reason: reasonOf(state, input),
    stage: input.stage,
    state,
    status: input.status,
    title: input.title,
    track: input.track ?? null,
  };
}

/** Why a blocked cell is blocked, or why a cell waiting for review was turned down. */
function reasonOf(state: CellState, input: CellInput): string | null {
  if (state === "blocked") {
    return input.problems.join("; ");
  }

  return state === "review" ? input.rejected : null;
}

/** A stage that refused to answer at all: its refusal is the blockade. */
function refused(input: {
  readonly character?: string;
  readonly id: string;
  readonly reason: string;
  readonly stage: number;
  readonly title: string;
  readonly track?: ImageTrack;
}): StatusCell {
  return {
    character: input.character ?? null,
    id: input.id,
    nextStep: null,
    reason: input.reason,
    stage: input.stage,
    state: "blocked",
    status: null,
    title: input.title,
    track: input.track ?? null,
  };
}

/**
 * A stage this episode decided it does not need: nobody waits on it.
 *
 * Read before the stage is asked anything, so it carries no stage object and
 * no command; its reason names the decision that rules it out.
 */
function excluded(input: {
  readonly id: string;
  readonly reason: string;
  readonly stage: number;
  readonly title: string;
  readonly track?: ImageTrack;
}): StatusCell {
  return { ...refused(input), state: "excluded" };
}

/** Why each stage that can be ruled out is, or null where the episode needs it. */
interface RuledOut {
  readonly dialogue: string | null;
  readonly narration: string | null;
  readonly versions: string | null;
}

/**
 * Which stages the episode's own decisions rule out, read off those decisions.
 *
 * Its audio mode says whether a narrator and the cast speak, which is the
 * reading stage 10 makes of which speech its mix waits for; `lip-sync.json`
 * says whether there is a second language at all. An absent `lip-sync.json` is
 * nobody's answer, so it rules nothing out: stage 12 says it blocks, rule 7.
 * This is not the gate graph: it is which rows the episode has, and every gate
 * inside a row is still the stage's own.
 */
function ruledOut(
  audio: EpisodeSettings["audio"],
  lipSync: "language" | "none" | "undecided"
): RuledOut {
  const declared = `odcinek deklaruje audio: ${audio}`;
  const narrated = audio === "narration" || audio === "dialogue-and-narration";
  const spoken = audio === "dialogue" || audio === "dialogue-and-narration";
  const versions = ((): string | null => {
    if (audio === "dialogue-and-narration") {
      return `${declared}, a narracja w drugim języku jest poza zakresem, więc wersji językowej nie będzie`;
    }
    if (!spoken) {
      return `${declared}, postacie nie mówią, nie ma czyich ust poruszyć`;
    }

    return lipSync === "none" ? "lip-sync.json: none, odcinek nie dostaje drugiej wersji" : null;
  })();

  return {
    dialogue: spoken ? null : `${declared}, postacie nie mówią, etap 11 nie ma czego podnosić`,
    narration: narrated ? null : `${declared}, nikt go nie narruje, etap 9 nie ma czego podnosić`,
    versions,
  };
}

/** A text stage: one artifact, and a `status` where other stages say `state`. */
interface TextStatus {
  readonly approved: boolean;
  readonly problems: readonly string[];
  readonly status: "absent" | "completed" | "submitted";
}

interface Scope {
  readonly episodeId: string;
  readonly projectId: string;
  readonly workspace: Workspace;
}

function textCell(
  input: Scope & {
    /** What `--stage` calls it, which is not what the ladder calls it. */
    readonly accepts: string;
    readonly locked: boolean;
    readonly produce: string;
    readonly rejected: string | null;
    readonly stage: number;
    readonly status: TextStatus;
    readonly title: string;
  }
): StatusCell {
  const { accepts, episodeId, locked, produce, projectId, rejected, stage, status, title } = input;
  const id = String(stage);

  return cellOf({
    approved: status.approved,
    id,
    locked,
    parts: [{ approved: status.approved, id, state: status.status }],
    problems: status.problems,
    produce,
    rejected,
    review: () => `aimator approve ${projectId} ${episodeId} --stage ${accepts}`,
    stage,
    status,
    title,
  });
}

/** `--artifact R01,R02`: which ones, said the way the approve command spells it. */
function named(command: string, waiting: readonly string[]): string {
  return waiting.length === 0 ? command : `${command} --artifact ${waiting.join(",")}`;
}

async function stage0Cell(scope: Scope): Promise<Result<StatusCell>> {
  const result = await checkStage0({ projectId: scope.projectId, workspace: scope.workspace });

  if (!result.ok) {
    return result;
  }

  const report = result.data;

  return ok(
    cellOf({
      approved: report.approved,
      id: "0",
      locked: false,
      parts: [{ approved: report.approved, id: "0", state: report.ready ? "completed" : "absent" }],
      problems: report.problems,
      produce: `aimator check ${scope.projectId} ${scope.episodeId}`,
      // Stage 0 is a person's own decisions; `reject` takes no stage-0 scope.
      rejected: null,
      review: () => `aimator approve ${scope.projectId} ${scope.episodeId} --stage prepare`,
      stage: 0,
      status: report,
      title: "przygotowanie",
    })
  );
}

async function characterCells(
  scope: Scope & { readonly cast: readonly string[]; readonly project: ProjectPaths }
): Promise<readonly StatusCell[]> {
  const cells: StatusCell[] = [];

  for (const characterId of scope.cast) {
    const paths = characterPaths(scope.project, characterId);

    for (const track of imageTracks) {
      const id = `2/${characterId}/${track}`;
      const title = `postać ${characterId}`;
      // biome-ignore lint/performance/noAwaitInLoops: the ladder is read in order
      const result = await checkCharacter({
        characterId,
        projectId: scope.projectId,
        track,
        workspace: scope.workspace,
      });

      if (!result.ok) {
        cells.push(
          refused({
            character: characterId,
            id,
            reason: result.error.message,
            stage: 2,
            title,
            track,
          })
        );
        continue;
      }

      const files = paths.ok ? characterTrackPaths(paths.data, track) : null;
      const locked = files === null ? false : await held(files.lock);
      const rejected = files === null ? null : await rejectedIn(files.stage);

      cells.push(
        cellOf({
          approved: result.data.approved,
          character: characterId,
          id,
          locked,
          parts: result.data.artifacts.map((one) => ({
            approved: one.approved,
            id: one.artifact,
            state: one.state,
          })),
          problems: result.data.problems,
          produce: `aimator character generate ${scope.projectId} ${characterId} --track ${track}`,
          rejected,
          review: (waiting) =>
            named(
              `aimator approve ${scope.projectId} ${characterId} --stage character --track ${track}`,
              waiting
            ),
          stage: 2,
          status: result.data,
          title,
          track,
        })
      );
    }
  }

  return cells;
}

/** One track's cell of one row, and everything a command about it must name. */
interface On {
  readonly episodeId: string;
  readonly projectId: string;
  readonly track: ImageTrack;
}

interface TrackRow {
  /** The stage file a rejection is written into, read for its reason. */
  readonly file: (paths: EpisodeTrackPaths) => string;
  readonly id: string;
  readonly lock: (paths: EpisodeTrackPaths) => string;
  readonly produce: (on: On) => string;
  readonly read: (scope: Scope & { readonly track: ImageTrack }) => Promise<
    Result<{
      readonly approved: boolean;
      readonly parts: readonly Reviewed[];
      readonly problems: readonly string[];
      readonly status: object;
    }>
  >;
  readonly reviewStage: string;
  readonly stage: number;
  readonly title: string;
}

/** Every row whose artifacts live under a track directory, in ladder order. */
const TRACK_ROWS: readonly TrackRow[] = [
  {
    file: (paths) => paths.referencesStage,
    id: "5",
    lock: (paths) => paths.referencesLock,
    produce: (on) =>
      `aimator reference generate ${on.projectId} ${on.episodeId} --track ${on.track}`,
    read: async (scope) => {
      const result = await checkReferences(scope);

      return result.ok
        ? ok({
            approved: result.data.approved,
            parts: result.data.artifacts,
            problems: result.data.problems,
            status: result.data,
          })
        : result;
    },
    reviewStage: "references",
    stage: 5,
    title: "referencje",
  },
  {
    file: (paths) => paths.openingFrameStage,
    id: "6",
    lock: (paths) => paths.openingFrameLock,
    produce: (on) =>
      `aimator opening-frame generate ${on.projectId} ${on.episodeId} --track ${on.track}`,
    read: async (scope) => {
      const result = await checkOpeningFrame(scope);

      return result.ok
        ? ok({
            approved: result.data.approved,
            parts: [result.data.artifact],
            problems: result.data.problems,
            status: result.data,
          })
        : result;
    },
    reviewStage: "opening-frame",
    stage: 6,
    title: "klatka otwarcia",
  },
  {
    file: (paths) => paths.clipsStage,
    id: "7",
    lock: (paths) => paths.clipsLock,
    produce: (on) => `aimator clip generate ${on.projectId} ${on.episodeId} --track ${on.track}`,
    read: async (scope) => {
      const result = await checkClips(scope);

      return result.ok
        ? ok({
            approved: result.data.approved,
            parts: result.data.artifacts,
            problems: result.data.problems,
            status: result.data,
          })
        : result;
    },
    reviewStage: "clips",
    stage: 7,
    title: "klipy",
  },
  {
    file: (paths) => paths.assemblyStage,
    id: "8",
    lock: (paths) => paths.assemblyLock,
    produce: (on) =>
      `aimator assembly generate ${on.projectId} ${on.episodeId} --track ${on.track}`,
    read: async (scope) => {
      const result = await checkAssembly(scope);

      return result.ok
        ? ok({
            approved: result.data.approved,
            parts: [{ ...result.data.artifact, approved: result.data.artifact.approved }],
            problems: result.data.problems,
            status: result.data,
          })
        : result;
    },
    reviewStage: "assembly",
    stage: 8,
    title: "montaż",
  },
];

/**
 * Stages 9 and 10 have a per-track row each, and a shared one above it.
 *
 * They are named rather than listed with the four above, because their shared
 * half has to be read *between* them: the words before the mix that lays them,
 * the cue sheet before the master that carries it. A loop over one array would
 * have put the ladder's order in a filter.
 */
const MIX_ROW: TrackRow = {
  file: (paths) => paths.soundtrackStage,
  id: "9",
  lock: (paths) => paths.soundtrackLock,
  produce: (on) => `aimator narration mix ${on.projectId} ${on.episodeId} --track ${on.track}`,
  read: async (scope) => {
    const result = await checkMix(scope);

    return result.ok
      ? ok({
          approved: result.data.approved,
          parts: [result.data.artifact],
          problems: result.data.problems,
          status: result.data,
        })
      : result;
  },
  reviewStage: "soundtrack",
  stage: 9,
  title: "narracja, miks",
};

const MASTER_ROW: TrackRow = {
  file: (paths) => paths.soundDesignStage,
  id: "10",
  lock: (paths) => paths.soundDesignLock,
  produce: (on) => `aimator sound-design mix ${on.projectId} ${on.episodeId} --track ${on.track}`,
  read: async (scope) => {
    const result = await checkMaster(scope);

    return result.ok
      ? ok({
          approved: result.data.approved,
          parts: [result.data.artifact],
          problems: result.data.problems,
          status: result.data,
        })
      : result;
  },
  reviewStage: "sound-design",
  stage: 10,
  title: "muzyka i efekty, miks",
};

/**
 * Stage 12: a clip's version, one clip after another, on each track.
 *
 * Its "Dalej:" is its `check`, as stage 0's is, because what moves the next
 * clip is one of three things and only the stage knows which: a paid face
 * call, a person saying which face is whom, or the paid lip-sync itself. The
 * check names that one, per clip, as a command.
 */
const VERSIONS_ROW: TrackRow = {
  file: (paths) => paths.versionsStage,
  id: "12",
  lock: (paths) => paths.versionsLock,
  produce: (on) =>
    `aimator check ${on.projectId} ${on.episodeId} --stage versions --track ${on.track}`,
  read: async (scope) => {
    const result = await checkVersions(scope);

    return result.ok
      ? ok({
          approved: result.data.approved,
          parts: result.data.clips,
          problems: result.data.problems,
          status: result.data,
        })
      : result;
  },
  reviewStage: "versions",
  stage: 12,
  title: "wersje językowe",
};

async function trackCells(
  scope: Scope & {
    readonly episode: EpisodePaths;
    /** Why the episode does not need this row, which then reads nothing. */
    readonly ruledOut?: string | null;
    readonly row: TrackRow;
  }
): Promise<readonly StatusCell[]> {
  const { episode, row } = scope;
  const cells: StatusCell[] = [];

  for (const track of imageTracks) {
    const id = `${row.id}/${track}`;

    if (scope.ruledOut !== undefined && scope.ruledOut !== null) {
      cells.push(
        excluded({ id, reason: scope.ruledOut, stage: row.stage, title: row.title, track })
      );
      continue;
    }

    // biome-ignore lint/performance/noAwaitInLoops: the ladder is read in order
    const result = await row.read({ ...scope, track });

    if (!result.ok) {
      cells.push(
        refused({ id, reason: result.error.message, stage: row.stage, title: row.title, track })
      );
      continue;
    }

    cells.push(
      cellOf({
        approved: result.data.approved,
        id,
        locked: await held(row.lock(episodeTrackPaths(episode, track))),
        parts: result.data.parts,
        problems: result.data.problems,
        produce: row.produce({
          episodeId: scope.episodeId,
          projectId: scope.projectId,
          track,
        }),
        rejected: await rejectedIn(row.file(episodeTrackPaths(episode, track))),
        review: (waiting) =>
          named(
            `aimator approve ${scope.projectId} ${scope.episodeId} --stage ${row.reviewStage} --track ${track}`,
            waiting
          ),
        stage: row.stage,
        // The row's own reading is scaffolding; the cell carries what the
        // stage answered, unchanged, which is what `--json` promises.
        status: result.data.status,
        title: row.title,
        track,
      })
    );
  }

  return cells;
}

/**
 * What moves stage 11 next, when nothing in it waits for a person.
 *
 * The film's own language first, since both mixes and the translation stand on
 * it: `dialogue generate` buys the script or, once that is accepted, its lines.
 * Then the translation, then the lines in the language of the mouths.
 */
function dialogueProduce(scope: Scope, report: DialogueStatus): string {
  const command = `${scope.projectId} ${scope.episodeId}`;

  if (!report.approved || report.translation === null) {
    return `aimator dialogue generate ${command}`;
  }

  return report.translation.state === "absent"
    ? `aimator dialogue translate ${command}`
    : `aimator dialogue generate ${command} --language ${report.translation.language}`;
}

/**
 * Stage 11: one cell for both of its languages, because both are at one level.
 *
 * Stages 9 and 10 have two rows each because their artifacts live at two
 * levels of the tree; stage 11's all sit beside the shot list. Its own
 * `approved` speaks for the film's language alone, so the cell is finished
 * only once the translation and each of its lines carry their yes as well,
 * or a second language still waiting would hide behind the first one's.
 */
async function dialogueCell(scope: Scope, paths: EpisodePaths): Promise<StatusCell> {
  const title = "dialog";
  const result = await checkDialogue(scope);

  if (!result.ok) {
    return refused({ id: "11", reason: result.error.message, stage: 11, title });
  }

  const { lines, script, translation } = result.data;
  const second = translation === null ? [] : [translation, ...translation.lines];
  const spoken = [...lines, ...(translation?.lines ?? [])].map((line) => ({
    approved: line.approved,
    id: line.key,
    state: line.state,
  }));

  return cellOf({
    approved: result.data.approved && second.every((part) => part.approved),
    id: "11",
    locked: await held(paths.dialogueLock),
    parts: [script, ...(translation === null ? [] : [translation]), ...spoken],
    problems: result.data.problems,
    produce: dialogueProduce(scope, result.data),
    rejected: await rejectedIn(paths.dialogueStage),
    review: (waiting) =>
      named(`aimator approve ${scope.projectId} ${scope.episodeId} --stage dialogue`, waiting),
    stage: 11,
    status: result.data,
    title,
  });
}

/**
 * The whole ladder of one episode, cell by cell, in the order it is climbed.
 *
 * Every verdict here is a stage's own: this walks them, it does not second
 * guess them. What it adds is the reading no single stage can give, because no
 * stage knows what is below it: which cell is the next one a person can move.
 */
async function ladderOf(scope: Scope): Promise<Result<readonly StatusCell[]>> {
  const project = projectPaths(scope.workspace, scope.projectId);

  if (!project.ok) {
    return project;
  }

  const episode = episodePaths(project.data, scope.episodeId);

  if (!episode.ok) {
    return episode;
  }

  const stage0 = await stage0Cell(scope);

  if (!stage0.ok) {
    return stage0;
  }

  const inputs = await readStage0Inputs(scope);

  if (!inputs.ok) {
    return inputs;
  }

  const paths = episode.data;
  const cells: StatusCell[] = [stage0.data];
  const screenplay = await checkScreenplay(scope);

  if (!screenplay.ok) {
    return screenplay;
  }

  cells.push(
    textCell({
      ...scope,
      accepts: "screenplay",
      locked: await held(paths.screenplayLock),
      produce: `aimator screenplay generate ${scope.projectId} ${scope.episodeId}`,
      rejected: await rejectedIn(paths.screenplayStage),
      stage: 1,
      status: screenplay.data,
      title: "scenariusz",
    })
  );
  cells.push(
    ...(await characterCells({
      ...scope,
      cast: inputs.data.cast.map((member) => member.id),
      project: project.data,
    }))
  );

  const shotList = await checkShotList(scope);

  if (!shotList.ok) {
    return shotList;
  }

  cells.push(
    textCell({
      ...scope,
      accepts: "shot-list",
      locked: await held(paths.shotListLock),
      produce: `aimator shot-list generate ${scope.projectId} ${scope.episodeId}`,
      rejected: await rejectedIn(paths.shotListStage),
      stage: 3,
      status: shotList.data,
      title: "lista ujęć",
    })
  );

  const promptPackage = await checkPromptPackage(scope);

  if (!promptPackage.ok) {
    return promptPackage;
  }

  cells.push(
    textCell({
      ...scope,
      accepts: "prompt-package",
      locked: await held(paths.promptPackageLock),
      produce: `aimator prompt-package generate ${scope.projectId} ${scope.episodeId}`,
      rejected: await rejectedIn(paths.promptPackageStage),
      stage: 4,
      status: promptPackage.data,
      title: "pakiet promptów",
    })
  );

  for (const row of TRACK_ROWS) {
    // biome-ignore lint/performance/noAwaitInLoops: the ladder is read in order
    cells.push(...(await trackCells({ ...scope, episode: paths, row })));
  }

  const lipSync = await readLipSync(scope);

  if (!lipSync.ok) {
    return lipSync;
  }

  const ruled = ruledOut(inputs.data.settings.audio, lipSync.data.kind);

  cells.push(await narrationCell(scope, paths, ruled.narration));
  cells.push(
    ...(await trackCells({ ...scope, episode: paths, row: MIX_ROW, ruledOut: ruled.narration }))
  );

  const design = await checkSoundDesign(scope);

  cells.push(
    design.ok
      ? cellOf({
          approved: design.data.approved,
          id: "10",
          locked: await held(paths.soundDesignLock),
          parts: [design.data.sheet, ...design.data.cues],
          problems: design.data.problems,
          produce: `aimator sound-design generate ${scope.projectId} ${scope.episodeId}`,
          rejected: await rejectedIn(paths.soundDesignStage),
          review: (waiting) =>
            named(
              `aimator approve ${scope.projectId} ${scope.episodeId} --stage sound-design`,
              waiting
            ),
          stage: 10,
          status: design.data,
          title: "muzyka i efekty, arkusz",
        })
      : refused({
          id: "10",
          reason: design.error.message,
          stage: 10,
          title: "muzyka i efekty, arkusz",
        })
  );
  cells.push(...(await trackCells({ ...scope, episode: paths, row: MASTER_ROW })));
  cells.push(
    ruled.dialogue === null
      ? await dialogueCell(scope, paths)
      : excluded({ id: "11", reason: ruled.dialogue, stage: 11, title: "dialog" })
  );
  cells.push(
    ...(await trackCells({ ...scope, episode: paths, row: VERSIONS_ROW, ruledOut: ruled.versions }))
  );

  return ok(cells);
}

/** Stage 9's shared half: the words, unless nobody narrates this episode. */
async function narrationCell(
  scope: Scope,
  paths: EpisodePaths,
  ruledOutBy: string | null
): Promise<StatusCell> {
  const title = "narracja, słowa";

  if (ruledOutBy !== null) {
    return excluded({ id: "9", reason: ruledOutBy, stage: 9, title });
  }

  const narration = await checkNarration(scope);

  return narration.ok
    ? cellOf({
        approved: narration.data.approved,
        id: "9",
        locked: await held(paths.narrationLock),
        parts: [narration.data.script, ...narration.data.lines],
        problems: narration.data.problems,
        produce: `aimator narration generate ${scope.projectId} ${scope.episodeId}`,
        rejected: await rejectedIn(paths.soundtrackStage),
        review: (waiting) =>
          named(
            `aimator approve ${scope.projectId} ${scope.episodeId} --stage soundtrack`,
            waiting
          ),
        stage: 9,
        status: narration.data,
        title,
      })
    : refused({ id: "9", reason: narration.error.message, stage: 9, title });
}

/** The first cell a person can actually move. There is exactly one. */
function nextOf(cells: readonly StatusCell[]): EpisodeStatus["next"] {
  for (const cell of cells) {
    if (cell.nextStep !== null) {
      return { cell: cell.id, command: cell.nextStep };
    }
  }

  return null;
}

function renderStatus(episode: EpisodeStatus): string {
  const lines = [`Odcinek "${episode.episodeId}" projektu "${episode.projectId}"`];

  for (const cell of episode.cells) {
    const where = cell.track === null ? "" : `, tor ${cell.track}`;
    lines.push(`  ${cell.stage}. ${cell.title}${where}: ${LABEL[cell.state]}`);

    // A blockade is a refusal; a rejection's reason is said about a cell that
    // waits for a person, so it is a report, and reads as one.
    if (cell.reason !== null) {
      lines.push(`      ${cell.state === "blocked" ? "!" : "·"} ${cell.reason}`);
    }
  }

  lines.push(
    episode.next === null
      ? "Odcinek zamknięty: każdy etap zatwierdzony albo odcinka nie dotyczy."
      : `Dalej: ${episode.next.command}`
  );

  return lines.join("\n");
}

/**
 * Where you are, and what is next, in one call.
 *
 * It writes nothing and buys nothing: every verdict is a `check` this tool
 * already had, and the only thing assembled here is the ladder, because no
 * stage can see the one below it. `--json` prints the same object the text
 * renders, so an agent and a person read one answer rather than two.
 */
export async function runStatus(argv: readonly string[]): Promise<Result<string>> {
  const parsed = parse(argv, { json: { type: "boolean" } });

  if (!parsed.ok) {
    return parsed;
  }

  const projectId = requirePositional(parsed.data, 0, "project-id");
  const episodeId = requirePositional(parsed.data, 1, "episode-id");
  const workspace = workspaceOf(parsed.data);

  if (!projectId.ok) {
    return projectId;
  }
  if (!episodeId.ok) {
    return episodeId;
  }
  if (!workspace.ok) {
    return workspace;
  }

  const scope = {
    episodeId: episodeId.data,
    projectId: projectId.data,
    workspace: workspace.data,
  };
  const cells = await ladderOf(scope);

  if (!cells.ok) {
    return cells;
  }

  const episode: EpisodeStatus = {
    cells: cells.data,
    command: "status",
    episodeId: scope.episodeId,
    next: nextOf(cells.data),
    projectId: scope.projectId,
  };

  return ok(
    parsed.data.values.json === true ? JSON.stringify(episode, null, 2) : renderStatus(episode)
  );
}

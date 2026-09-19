import {
  emptyStage,
  type RecordedFile,
  readDigest,
  readJson,
  type StageFile,
  stageFileSchema,
  toWorkspacePath,
} from "../artifact/index.js";
import { readStage0Inputs } from "../project/index.js";
import { err, ok, type Result } from "../result.js";
import { checkShotList } from "../shot-list/index.js";
import { validateVideo } from "../video-model/index.js";
import {
  clipVideo,
  type EpisodePaths,
  type EpisodeTrackPaths,
  episodePaths,
  episodeTrackPaths,
  type ImageTrack,
  type ProjectPaths,
  projectPaths,
  type Workspace,
} from "../workspace.js";

/**
 * Internal to the assembly module: the cut, and whether it may be made.
 *
 * Two things are this stage's own and everything else is borrowed.
 *
 * **The edit plan is derived, never stored.** The contract named an
 * `edit-plan.json` as stage 8's input, and no stage ever wrote one — because
 * every field it could hold is already in the approved shot list: the order of
 * the clips, their absolute seconds, and the fact that they tile the episode
 * without a gap. Writing it out would be `shot-list.json` under another name,
 * and stages 3 and 4 both refused that for the same reason: two files holding
 * one truth drift at the first hand correction, and the one a human corrects is
 * the other one. Rule 7 is satisfied rather than bent — a hard cut between
 * clips that tile without a gap is what the plan *says*, not a default standing
 * in for an answer nobody gave. A dissolve or a re-ordering would be the new
 * decision, and there is no field that carries one, so this stage does not make
 * it.
 *
 * **The gate is the table's own sentence: approved clips.** Every clip the shot
 * list plans, finished and accepted on *this* track. Entry frames and end
 * frames are not asked after: an entry frame is already the first frame of its
 * own clip, and an end frame is what the chain above needed, not what the edit
 * cuts. A gate on a file this stage never opens would be the mistake the
 * contract calls holding a stage hostage.
 */

/** The one stage name this module writes and reads. */
export const STAGE = "assembly";

/**
 * The artifact key, and the only value `--artifact` accepts.
 *
 * `episode` rather than `assembly`, because the key names the thing produced
 * and not the producing of it — the same reading that makes the file
 * `episode.mp4` and the state file `assembly.stage.json`.
 */
export const EPISODE_CUT = "episode";

export interface Stage8Scope {
  readonly episodeId: string;
  readonly projectId: string;
  readonly track: ImageTrack;
  readonly workspace: Workspace;
}

export class Stage8BlockedError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`etap 8 nie może zmontować odcinka:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "Stage8BlockedError";
    this.problems = problems;
  }
}

export interface Stage8Paths {
  readonly episode: EpisodePaths;
  readonly project: ProjectPaths;
  readonly track: EpisodeTrackPaths;
}

/** One clip as the cut uses it: where it is, how long it was meant to be, and how long it is. */
export interface ClipCut {
  /** How long the file's own movie header says it runs. `null` when unreadable. */
  readonly actualSeconds: number | null;
  /** Why this clip may not be cut in yet. Empty means it may. */
  readonly blockers: readonly string[];
  readonly id: string;
  /** Absolute, for the muxer. */
  readonly path: string;
  /** What the approved shot list ordered. */
  readonly plannedSeconds: number;
  /** Workspace-relative with its digest, for the record. `null` when absent. */
  readonly recorded: RecordedFile | null;
}

export interface Stage8Inputs {
  /** The sum of what actually came back — what the cut will run. */
  readonly actualSeconds: number;
  readonly aspectRatio: string;
  /**
   * What the episode declared it would sound like. Nothing in this pipeline
   * produces a soundtrack, so this travels with the plan in order to be
   * reported rather than to be acted on.
   */
  readonly audio: string;
  /** The clips in the plan's order — the whole of the edit decision list. */
  readonly cut: readonly ClipCut[];
  /** Why nothing may be cut at all: an unapproved plan, or a clip nobody accepted. */
  readonly gate: readonly string[];
  /** Everything this stage consumes, with the digest of each file as it was read. */
  readonly inputs: readonly RecordedFile[];
  readonly paths: Stage8Paths;
  /** What the approved shot list adds up to: the film's intended length. */
  readonly plannedSeconds: number;
  /** This track's own stage file, empty when it has cut nothing yet. */
  readonly stage: StageFile;
}

function resolvePaths(input: Stage8Scope): Result<Stage8Paths> {
  const project = projectPaths(input.workspace, input.projectId);

  if (!project.ok) {
    return project;
  }

  const episode = episodePaths(project.data, input.episodeId);

  return episode.ok
    ? ok({
        episode: episode.data,
        project: project.data,
        track: episodeTrackPaths(episode.data, input.track),
      })
    : episode;
}

/**
 * One clip, read once: its digest, its own duration, and whether it may be cut.
 *
 * The duration comes from `lib/video-model`'s verdict rather than from a stored
 * number, because no stage stores one — and the verdict is the right question
 * anyway: it says both how long this file runs and whether it is still the clip
 * the plan bought. Reading the bytes is what a digest needs regardless, so the
 * two answers cost one read.
 */
async function readClip(
  input: Stage8Scope,
  paths: Stage8Paths,
  clips: StageFile,
  plan: { readonly end: number; readonly id: string; readonly start: number },
  aspectRatio: string
): Promise<ClipCut> {
  const plannedSeconds = plan.end - plan.start;
  const file = clipVideo(paths.track, plan.id);
  const base: Omit<ClipCut, "actualSeconds" | "blockers" | "recorded"> = {
    id: plan.id,
    path: file.ok ? file.data : "",
    plannedSeconds,
  };

  if (!file.ok) {
    return { ...base, actualSeconds: null, blockers: [file.error.message], recorded: null };
  }

  const record = clips.artifacts[plan.id];

  if (record === undefined || record.status !== "completed") {
    return {
      ...base,
      actualSeconds: null,
      blockers: [`${plan.id}: nie ma klipu na torze ${input.track} — etap 7 go nie ukończył`],
      recorded: null,
    };
  }

  const digest = await readDigest(file.data);

  if (!digest.ok) {
    return {
      ...base,
      actualSeconds: null,
      blockers: [`${plan.id}: brakuje pliku klipu`],
      recorded: null,
    };
  }

  const recorded = {
    path: toWorkspacePath(input.workspace.root, file.data),
    sha256: digest.data.sha256,
  };
  const output = record.outputs.find((one) => one.path === recorded.path);
  const verdict = validateVideo(digest.data.bytes, { aspectRatio, seconds: plannedSeconds });

  return {
    ...base,
    actualSeconds: verdict.ok ? verdict.data.seconds : null,
    blockers: [
      ...(output === undefined || output.sha256 !== digest.data.sha256
        ? [`${plan.id}: bajty klipu nie zgadzają się z jego rekordem z etapu 7`]
        : []),
      // Approval, not validation: a clip that merely exists is a clip nobody
      // has watched. The whole stage exists downstream of a human saying yes.
      ...(record.review.status === "approved"
        ? []
        : [`${plan.id}: klip czeka na ocenę człowieka na torze ${input.track}`]),
      ...(verdict.ok ? [] : [`${plan.id}: ${verdict.error.message}`]),
    ],
    recorded,
  };
}

/**
 * Everything stage 8 consumes, and every reason it may not run.
 *
 * It does not read the prompt package: the cut carries no instruction to any
 * model, so a hash of bytes nobody sent would describe a question nobody asked
 * — the same reason stage 3 does not record `source.md`.
 */
export async function readStage8Inputs(input: Stage8Scope): Promise<Result<Stage8Inputs>> {
  const paths = resolvePaths(input);

  if (!paths.ok) {
    return paths;
  }

  const stage0 = await readStage0Inputs(input);

  if (!stage0.ok) {
    return stage0;
  }

  const plan = await checkShotList(input);

  if (!plan.ok) {
    return plan;
  }

  if (plan.data.verdict === null) {
    return err(new Stage8BlockedError(["lista ujęć nie istnieje albo nie przechodzi walidacji"]));
  }

  const shotList = await readDigest(paths.data.episode.shotList);

  if (!shotList.ok) {
    return shotList;
  }

  const projectJson = await readDigest(paths.data.project.file);

  if (!projectJson.ok) {
    return projectJson;
  }

  const episodeJson = await readDigest(paths.data.episode.file);

  if (!episodeJson.ok) {
    return episodeJson;
  }

  const clips = await readJson(paths.data.track.clipsStage, stageFileSchema);
  const stage = await readJson(paths.data.track.assemblyStage, stageFileSchema);
  const cut: ClipCut[] = [];

  for (const one of plan.data.verdict.clips) {
    // biome-ignore lint/performance/noAwaitInLoops: one clip read at a time, in the plan's order
    const clip = await readClip(
      input,
      paths.data,
      clips.ok ? clips.data : emptyStage("clips"),
      one,
      stage0.data.aspectRatio
    );

    cut.push(clip);
  }

  const relative = (path: string): string => toWorkspacePath(input.workspace.root, path);

  return ok({
    actualSeconds: round(cut.reduce((total, one) => total + (one.actualSeconds ?? 0), 0)),
    aspectRatio: stage0.data.aspectRatio,
    audio: stage0.data.settings.audio,
    cut,
    gate: [
      // One gate covers stage 0 arithmetically, exactly as stage 3's does: the
      // project files are recorded inputs of the shot list, so editing one
      // revokes its approval and this refuses without a rule of its own.
      ...(plan.data.approved ? [] : ["lista ujęć nie jest zatwierdzona — bez niej nie ma montażu"]),
      ...cut.flatMap((one) => one.blockers),
    ],
    inputs: [
      { path: relative(paths.data.project.file), sha256: projectJson.data.sha256 },
      { path: relative(paths.data.episode.file), sha256: episodeJson.data.sha256 },
      { path: relative(paths.data.episode.shotList), sha256: shotList.data.sha256 },
      ...cut.flatMap((one) => (one.recorded === null ? [] : [one.recorded])),
    ],
    paths: paths.data,
    plannedSeconds: plan.data.verdict.durationSeconds,
    stage: stage.ok ? stage.data : emptyStage(STAGE),
  });
}

/** Seconds, to the hundredth — the precision a movie header actually carries. */
export function round(seconds: number): number {
  return Math.round(seconds * 100) / 100;
}

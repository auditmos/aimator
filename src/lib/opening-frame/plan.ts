import { emptyStage, readJson, type StageFile, stageFileSchema } from "../artifact/index.js";
import { type PlannedArtifact, readSendPlan, type SendPlan } from "../media-prompt/index.js";
import { err, ok, type Result } from "../result.js";
import {
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
 * Internal to the opening-frame module: what stage 6 reads, and whether it may
 * pay.
 *
 * Like stage 5, it owns almost none of this. What the frame is drawn from,
 * which files those identifiers resolve to on this track, and whether a human
 * accepted each of them are all answered by `lib/media-prompt`; the order of
 * operations around the POST is `lib/image-model`. What is left is which track
 * this invocation is about and the obstacles that belong to the command.
 *
 * Two things separate it from stage 5.
 *
 * Its gate reads **another stage's** per-track results. Stage 5's graph waited
 * on references it had drawn itself; the opening frame waits on `R01` and on
 * `hero:ewa`, accepted on this track, a dependency that crosses a stage
 * boundary without crossing a track one.
 *
 * And there is exactly **one** artifact. Everything stage 5 needed in order to
 * talk about a set, a list of targets, a count of ready roots, a series that
 * stops halfway, collapses to a single record, and the flags that existed to
 * disambiguate one of six have nothing here to disambiguate.
 */

/** The one stage name this module writes and reads. */
export const STAGE = "opening-frame";

/**
 * The artifact key, the output's file name and the only value `--artifact`
 * accepts, the same string `lib/media-prompt` already plans the frame under,
 * so the two never need translating into each other.
 */
export const OPENING_FRAME = "opening-frame";

export interface Stage6Scope {
  readonly episodeId: string;
  readonly projectId: string;
  readonly track: ImageTrack;
  readonly workspace: Workspace;
}

export class Stage6BlockedError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `etap 6 nie może wykonać płatnego wywołania:\n${problems.map((p) => `  - ${p}`).join("\n")}`
    );
    this.name = "Stage6BlockedError";
    this.problems = problems;
  }
}

export interface Stage6Paths {
  readonly episode: EpisodePaths;
  readonly project: ProjectPaths;
  readonly track: EpisodeTrackPaths;
}

export interface Stage6Inputs {
  /** Why nothing may be drawn at all, an unapproved or unread package. */
  readonly gate: readonly string[];
  /** The frame this episode plans, with its attachments and its blockers. */
  readonly opening: PlannedArtifact;
  readonly paths: Stage6Paths;
  readonly plan: SendPlan;
  /** This track's own stage file, empty when it has drawn nothing yet. */
  readonly stage: StageFile;
}

function resolvePaths(input: Stage6Scope): Result<Stage6Paths> {
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
 * Everything stage 6 consumes.
 *
 * `compose` decides whether the prompt is built in full, and when it is, the
 * composition happens in the same pass that hashes the attachments, so the
 * bytes a paid call carries are the bytes this read just verified, rather than
 * bytes trusted from a stage file written at some earlier moment.
 */
export async function readStage6Inputs(
  input: Stage6Scope,
  compose = false
): Promise<Result<Stage6Inputs>> {
  const paths = resolvePaths(input);

  if (!paths.ok) {
    return paths;
  }

  const plan = await readSendPlan({
    ...input,
    targets: compose ? [OPENING_FRAME] : [],
  });

  if (!plan.ok) {
    return plan;
  }

  const opening = plan.data.artifacts.find((one) => one.kind === "opening");

  if (opening === undefined) {
    return err(
      new Stage6BlockedError([
        "pakiet promptów nie planuje klatki otwarcia, etap 4 zawsze ją planuje, więc ten manifest jest niekompletny",
      ])
    );
  }

  const stage = await readJson(paths.data.track.openingFrameStage, stageFileSchema);

  return ok({
    gate: plan.data.problems,
    opening,
    paths: paths.data,
    plan: plan.data,
    stage: stage.ok ? stage.data : emptyStage(STAGE),
  });
}

/**
 * Whether this invocation would buy the image.
 *
 * Stage 5 answers the same question for a set, and its answer is a list. Here
 * it is a single yes or no, and the two conditions are the same: nothing
 * upstream is blocking it, and it is not already finished.
 */
export function isDrawable(inputs: Stage6Inputs, regenerate: boolean): boolean {
  const record = inputs.stage.artifacts[OPENING_FRAME];

  return inputs.opening.blockers.length === 0 && (regenerate || record?.status !== "completed");
}

import { emptyStage, readJson, type StageFile, stageFileSchema } from "../artifact/index.js";
import { type PlannedArtifact, readSendPlan, type SendPlan } from "../media-prompt/index.js";
import { ok, type Result } from "../result.js";
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
 * Internal to the references module: what stage 5 reads, and whether it may pay.
 *
 * Almost none of it is this module's own work, and that is the point. What one
 * reference is drawn from, which files those identifiers resolve to on this
 * track, and whether a human has accepted each of them are all answered by
 * `lib/media-prompt` — because stages 6 and 7 ask exactly the same questions
 * about the same manifest, and a second answer here would be a second opinion.
 *
 * What is left for stage 5 is its own half: which references this invocation is
 * about, and the three obstacles that belong to the command rather than to the
 * plan — an unapproved package, a model nobody chose and a key nobody set.
 *
 * This is the first stage whose gate sits **inside its own set of results**.
 * R04 waits for R03 and R06 waits for R01 and R02, on this track, which is why
 * "the next thing to draw" is a set rather than a single step.
 */

/** The one stage name this module writes and reads. */
export const STAGE = "references";

/** Which ids `--artifact` accepts here: stage 5 draws references and nothing else. */
export const REFERENCE_ID = /^R\d{2,}$/;

export interface Stage5Scope {
  readonly episodeId: string;
  readonly projectId: string;
  readonly track: ImageTrack;
  readonly workspace: Workspace;
}

export class Stage5BlockedError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `etap 5 nie może wykonać płatnego wywołania:\n${problems.map((p) => `  - ${p}`).join("\n")}`
    );
    this.name = "Stage5BlockedError";
    this.problems = problems;
  }
}

export interface Stage5Paths {
  readonly episode: EpisodePaths;
  readonly project: ProjectPaths;
  readonly track: EpisodeTrackPaths;
}

export interface Stage5Inputs {
  /** Why nothing may be drawn at all — an unapproved or unread package. */
  readonly gate: readonly string[];
  readonly paths: Stage5Paths;
  readonly plan: SendPlan;
  /** The references this episode plans, in manifest order, with their state. */
  readonly references: readonly PlannedArtifact[];
  /** This track's own stage file, empty when it has drawn nothing yet. */
  readonly stage: StageFile;
}

function resolvePaths(input: Stage5Scope): Result<Stage5Paths> {
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
 * Everything stage 5 consumes, for the references named — or for all of them.
 *
 * `targets` decides which prompts are composed in full, and the composition
 * happens in the same pass that hashes the attachments. That is deliberate: the
 * bytes a paid call carries are the bytes this read just verified, rather than
 * bytes trusted from a stage file written at some earlier moment.
 */
export async function readStage5Inputs(
  input: Stage5Scope,
  targets: readonly string[] = []
): Promise<Result<Stage5Inputs>> {
  const paths = resolvePaths(input);

  if (!paths.ok) {
    return paths;
  }

  const plan = await readSendPlan({ ...input, targets });

  if (!plan.ok) {
    return plan;
  }

  const stage = await readJson(paths.data.track.referencesStage, stageFileSchema);

  return ok({
    gate: plan.data.problems,
    paths: paths.data,
    plan: plan.data,
    references: plan.data.artifacts.filter((one) => one.kind === "reference"),
    stage: stage.ok ? stage.data : emptyStage(STAGE),
  });
}

/**
 * What this invocation is about when the user named nothing: every reference
 * whose dependencies are accepted and which has not been drawn yet.
 *
 * Stage 2 draws exactly one step at a time, but that was a consequence rather
 * than a principle — its gates leave exactly one artifact runnable. Here the
 * graph has several independent roots, so copying the consequence instead of
 * the reason would mean refusing work the tool knows is allowed. Safety comes
 * from elsewhere: one record and one `submitted` per image, a series that stops
 * at the first failure, and a command that says how many calls it is about to
 * make before it makes them.
 */
export function readyReferences(inputs: Stage5Inputs): readonly PlannedArtifact[] {
  return inputs.references.filter(
    (one) => one.blockers.length === 0 && inputs.stage.artifacts[one.id]?.status !== "completed"
  );
}

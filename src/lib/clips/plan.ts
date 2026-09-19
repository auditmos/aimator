import { emptyStage, readJson, type StageFile, stageFileSchema } from "../artifact/index.js";
import { type PlannedArtifact, readSendPlan, type SendPlan } from "../media-prompt/index.js";
import { ok, type Result } from "../result.js";
import { clipDuration } from "../video-model/index.js";
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
 * Internal to the clips module: what stage 7 reads, and whether it may pay.
 *
 * Two things are new here, and everything else is borrowed.
 *
 * The stage buys **two media**. An entry frame is an image, drawn by the same
 * model that drew the references and the opening frame on this track; a clip is
 * a video, rendered by the one model both tracks send their clips to. They are
 * two paid call sites in one stage, so this module keeps them in one list and
 * lets each target say which it is.
 *
 * And the gate is a **chain**. Stage 5's graph waited on images it had drawn
 * itself; stage 6 waited on another stage's results, once. Here C03's entry
 * frame waits for the accepted end of C02, which waits for C02 itself, which
 * waits for its own entry frame — and every link in that chain is a human
 * saying yes. What that chain resolves to on this track is answered where every
 * other attachment is answered, in `lib/media-prompt`; what is left here is the
 * one question that module cannot answer, because it is not about images at
 * all: whether the video model renders a clip of this length.
 */

/** The one stage name this module writes and reads. */
export const STAGE = "clips";

/** What `--artifact` accepts here: a clip, or the entry frame of one. */
export const CLIP_ID = /^C\d{2,}$/;
const ENTRY_ID = /^entry:C\d{2,}$/;

export function isClipArtifact(name: string): boolean {
  return CLIP_ID.test(name) || ENTRY_ID.test(name);
}

export interface Stage7Scope {
  readonly episodeId: string;
  readonly projectId: string;
  readonly track: ImageTrack;
  readonly workspace: Workspace;
}

export class Stage7BlockedError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `etap 7 nie może wykonać płatnego wywołania:\n${problems.map((p) => `  - ${p}`).join("\n")}`
    );
    this.name = "Stage7BlockedError";
    this.problems = problems;
  }
}

export interface Stage7Paths {
  readonly episode: EpisodePaths;
  readonly project: ProjectPaths;
  readonly track: EpisodeTrackPaths;
}

/**
 * One thing stage 7 can buy: a clip, or the entry frame a clip starts on.
 *
 * It wraps the planned artifact rather than replacing it, because the
 * attachments, the prompt and the gate on them belong to `lib/media-prompt`
 * and are the same question for every stage. What this adds is the half that
 * is stage 7's own: which medium pays for it, how long it runs, and the
 * refusal that belongs to the video model rather than to an image track.
 */
export interface Stage7Target {
  readonly artifact: PlannedArtifact;
  /** Every reason this one may not be bought yet, upstream and local. */
  readonly blockers: readonly string[];
  readonly kind: "clip" | "entry-frame";
  /** The stage-file key, the `--artifact` value and the report's own word. */
  readonly name: string;
  /** How long the approved shot list plans this clip. `null` for a frame. */
  readonly seconds: number | null;
}

export interface Stage7Inputs {
  /** Why nothing may be bought at all — an unapproved or unread package. */
  readonly gate: readonly string[];
  readonly paths: Stage7Paths;
  readonly plan: SendPlan;
  /** This track's own stage file, empty when it has bought nothing yet. */
  readonly stage: StageFile;
  /** Every clip and entry frame, in production order. */
  readonly targets: readonly Stage7Target[];
}

function resolvePaths(input: Stage7Scope): Result<Stage7Paths> {
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
 * The obstacles that are this stage's own rather than the plan's.
 *
 * Only one, and it is about the film's timing: the shot list may plan a clip of
 * any length its `maxClipSeconds` allows, and the model renders a narrower
 * range. Refusing here is what keeps the tool from ordering a duration nobody
 * decided — and refusing *before* the POST is what keeps that refusal free.
 */
function localBlockers(seconds: number | null, name: string): readonly string[] {
  if (seconds === null) {
    return [`${name}: lista ujęć nie planuje takiego klipu`];
  }

  const renderable = clipDuration(seconds);

  return renderable.ok ? [] : [`${name}: ${renderable.error.message}`];
}

function toTarget(artifact: PlannedArtifact): Stage7Target {
  const clip = artifact.kind === "clip";

  return {
    artifact,
    blockers: [
      ...artifact.blockers,
      ...(clip ? localBlockers(artifact.seconds, artifact.name) : []),
    ],
    kind: clip ? "clip" : "entry-frame",
    name: artifact.name,
    seconds: artifact.seconds,
  };
}

/**
 * Everything stage 7 consumes, for the targets named — or for all of them.
 *
 * `targets` decides which prompts are composed in full, and the composition
 * happens in the same pass that hashes the attachments: the bytes a paid call
 * carries are the bytes this read just verified, rather than bytes trusted from
 * a stage file written at some earlier moment.
 */
export async function readStage7Inputs(
  input: Stage7Scope,
  targets: readonly string[] = []
): Promise<Result<Stage7Inputs>> {
  const paths = resolvePaths(input);

  if (!paths.ok) {
    return paths;
  }

  const plan = await readSendPlan({ ...input, targets });

  if (!plan.ok) {
    return plan;
  }

  const stage = await readJson(paths.data.track.clipsStage, stageFileSchema);

  return ok({
    gate: plan.data.problems,
    paths: paths.data,
    plan: plan.data,
    stage: stage.ok ? stage.data : emptyStage(STAGE),
    targets: plan.data.artifacts
      .filter((one) => one.kind === "clip" || one.kind === "entry-frame")
      .map(toTarget),
  });
}

/**
 * What this invocation is about when the user named nothing: everything whose
 * inputs are accepted and which has not been bought yet.
 *
 * On a chain that is rarely more than one or two things at a time, and that is
 * the point of asking rather than assuming: a clip that opens a new scene needs
 * nothing from the clip before it, so it can be drawn while an earlier one is
 * still waiting for a human. Refusing to do that work would mean typing the
 * same command again for no reason.
 */
export function readyTargets(inputs: Stage7Inputs): readonly Stage7Target[] {
  return inputs.targets.filter(
    (one) => one.blockers.length === 0 && inputs.stage.artifacts[one.name]?.status !== "completed"
  );
}

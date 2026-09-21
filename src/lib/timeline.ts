import { readDigest } from "./artifact/index.js";
import { err, ok, type Result } from "./result.js";
import { checkShotList } from "./shot-list/index.js";
import { validateVideo } from "./video-model/index.js";
import {
  clipVideo,
  episodePaths,
  episodeTrackPaths,
  type ImageTrack,
  projectPaths,
  type Workspace,
} from "./workspace.js";

/**
 * The relationship between the approved plan's clock and one finished film's.
 *
 * Two clocks exist from stage 7 on and they are not the same clock. The plan
 * says a clip runs from 15s to 30s; the renderer hands back fourteen point
 * nine something, because twenty-four frames do not divide a second evenly.
 * Stage 7 accepts a deviation below one second and publishes what came back,
 * stage 8 cuts what came back and *reports* the difference rather than
 * trimming it, so by the time there is a film, every seam has moved a little
 * and the two clocks have come apart.
 *
 * Every stage that lays sound on a picture has to cross that gap. Stage 9 did
 * it first, for an utterance anchored at "7s of the plan"; stage 10 does it
 * for a thunderclap and for the second a bed begins. The arithmetic is the
 * same both times, and it is not a formula anybody would want written twice:
 * it is "which clip is this second in, how far into it, and how much real time
 * came before that clip".
 *
 * So it is promoted here at the second caller rather than the third, which is
 * the same judgement `lib/image-model` was promoted on: stage 10 is a
 * certainty rather than a discovery, and waiting would be choosing to make an
 * invariant into a coincidence on purpose.
 *
 * It is a single file because it is one idea. If a third thing about time
 * turns up, it grows a folder.
 */

/** One clip, as the plan ordered it and as it actually came back. */
export interface ClipDrift {
  /** What the film got, read from the clip's own boxes. */
  readonly actualSeconds: number;
  readonly end: number;
  readonly id: string;
  readonly start: number;
}

export interface PlanClock {
  /**
   * A second of the approved plan, as a second of this track's finished film.
   *
   * A second past the end of the plan maps to the end of the film. Nothing
   * upstream can produce one, because every anchor validated inside a shot.
   */
  readonly at: (plannedSeconds: number) => number;
  /** What each clip was ordered at and what came back. Reported, never corrected. */
  readonly drift: readonly ClipDrift[];
}

class TimelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimelineError";
  }
}

/** Seconds, to the thousandth, the precision an audio delay is spelled in. */
function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/**
 * This track's clips, with the seconds each one actually runs.
 *
 * A clip that cannot be read falls back to what the plan ordered. Every caller
 * has its own gate that has already refused by then; this only keeps the
 * arithmetic total, so a report can still be printed beside the refusal rather
 * than instead of it.
 */
export async function readPlanClock(input: {
  readonly aspectRatio: string;
  readonly episodeId: string;
  readonly projectId: string;
  readonly track: ImageTrack;
  readonly workspace: Workspace;
}): Promise<Result<PlanClock>> {
  const plan = await checkShotList(input);

  if (!plan.ok) {
    return plan;
  }

  if (plan.data.verdict === null) {
    return err(new TimelineError("lista ujęć nie istnieje albo nie przechodzi walidacji"));
  }

  const project = projectPaths(input.workspace, input.projectId);

  if (!project.ok) {
    return project;
  }

  const episode = episodePaths(project.data, input.episodeId);

  if (!episode.ok) {
    return episode;
  }

  const track = episodeTrackPaths(episode.data, input.track);
  const drift: ClipDrift[] = [];

  for (const clip of plan.data.verdict.clips) {
    const file = clipVideo(track, clip.id);
    // biome-ignore lint/performance/noAwaitInLoops: one clip read at a time, in the plan's order
    const bytes = file.ok ? await readDigest(file.data) : null;
    const verdict =
      bytes?.ok === true
        ? validateVideo(bytes.data.bytes, {
            aspectRatio: input.aspectRatio,
            seconds: clip.end - clip.start,
          })
        : null;

    drift.push({
      actualSeconds: verdict?.ok === true ? verdict.data.seconds : clip.end - clip.start,
      end: clip.end,
      id: clip.id,
      start: clip.start,
    });
  }

  return ok({ at: (planned: number) => resolve(planned, drift), drift });
}

/**
 * A second of the plan, as a second of the film.
 *
 * Not a scale factor: within a clip the two clocks run at exactly the same
 * rate, and the fraction a renderer leaves over sits at the clip's *end*
 * rather than spread through it. So the mapping is a walk, count the real
 * seconds of every clip before this one, then add however far into this one
 * the plan second falls.
 */
function resolve(plannedSeconds: number, drift: readonly ClipDrift[]): number {
  let elapsed = 0;

  for (const clip of drift) {
    if (plannedSeconds < clip.end) {
      return round(elapsed + Math.min(plannedSeconds - clip.start, clip.actualSeconds));
    }

    elapsed += clip.actualSeconds;
  }

  return round(elapsed);
}

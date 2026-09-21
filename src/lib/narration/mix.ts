import {
  applyWrites,
  localProducer,
  newRecord,
  newRunId,
  nowIso,
  type RecordedFile,
  readDigest,
  removeFile,
  serialize,
  toWorkspacePath,
  type WriteMode,
  type WriteOp,
  writeNew,
} from "../artifact/index.js";
import type { Muxer } from "../muxer.js";
import { err, ok, type Result } from "../result.js";
import { readPlanClock } from "../timeline.js";
import { hasSound, validateVideo } from "../video-model/index.js";
import { type ImageTrack, mixRunPaths, type Workspace } from "../workspace.js";
import {
  missingSound,
  NARRATED,
  type PlacedLine,
  placeLines,
  readAcceptedLines,
  readStage9Inputs,
  readTrackTimeline,
  STAGE,
  Stage9BlockedError,
} from "./plan.js";

/**
 * Internal to the narration module: the command that lays the speech down.
 *
 * It buys nothing. What it does is the half of stage 9 that is per track, and
 * the only half that is: the words were bought once, and where each one lands
 * is the one thing that differs between two films cut from the same plan.
 *
 * Three rules shape it.
 *
 * **The picture is copied, never touched.** `narrated.mp4` is a new file whose
 * video stream is `episode.mp4`'s, frame for frame. The approved cut is neither
 * overwritten nor re-encoded, so the yes a human gave stage 8 stays where it is.
 *
 * **The recordings are laid down as they came.** No stretching, no faster
 * reading, no shortened pause: those are bytes somebody paid for, and altering
 * them would be stage 8's objection to trimming a drifted clip, one row down.
 *
 * **Placement is refused rather than nudged.** A line that would talk over the
 * next one, or run past the end of the film, stops the mix and names the
 * remedy, because where a line sits comes from a plan a human approved, and
 * this is stage 7's refusal rather than stage 8's acceptance. It costs nothing:
 * the recordings stay bought and re-mixing after a fix is free.
 */

export interface MixReport {
  /** How long this track's cut actually runs. */
  readonly actualSeconds: number;
  readonly created: readonly string[];
  /** The local engine, once it has answered. `null` when it could not be asked. */
  readonly engine: string | null;
  /** Where each line landed on this track, and where the plan put it. */
  readonly lines: readonly PlacedLine[];
  readonly nextStep: string;
  readonly problems: readonly string[];
  readonly ready: boolean;
  readonly state: "blocked" | "planned" | "published" | "skipped";
  readonly track: ImageTrack;
}

interface MixInput {
  /** Narrows nothing; there is one artifact per track, but a wrong value is refused. */
  readonly artifacts: readonly string[];
  readonly episodeId: string;
  readonly mode: WriteMode;
  /** The local engine, injected exactly as `fetch` is in a paid stage. */
  readonly mux: Muxer;
  readonly projectId: string;
  readonly regenerate: boolean;
  readonly track: ImageTrack;
  readonly workspace: Workspace;
}

class LockError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(
      `inna próba trzyma blokadę ${path}, po awarii upewnij się, że poprzedni proces nie działa, zanim usuniesz ten plik`
    );
    this.name = "LockError";
    this.path = path;
  }
}

/** Everything a report states before anything has been laid down. */
type Partial9 = Pick<MixReport, "actualSeconds" | "created" | "engine" | "lines" | "track">;

/** What a preview would do about the one artifact on this track, and why. */
function intent(finished: boolean, blocked: boolean): MixReport["state"] {
  if (finished) {
    return "skipped";
  }

  return blocked ? "blocked" : "planned";
}

/**
 * `--dry-run`: the whole placement, the engine, and no write.
 *
 * What it says to do next has to account for a mix that already exists, or it
 * sends a person back round a loop they have already closed, and past the one
 * thing this stage actually needs from them, which is listening to the
 * narration over the picture and saying yes. So a finished mix answers the same
 * way `idle` does; only an unfinished one points at the mix.
 */
function preview(
  input: MixInput,
  report: Partial9,
  problems: readonly string[],
  audio: readonly string[],
  state: { readonly approved: boolean; readonly finished: boolean }
): MixReport {
  const blocked = problems.length > 0;
  const { finished } = state;

  return {
    ...report,
    nextStep: nextStep(input, { ...state, blocked }),
    problems: [...problems, ...audio],
    ready: !(blocked || finished),
    state: intent(finished, blocked),
  };
}

/** Where a person goes from here, in the order the obstacles actually bite. */
function nextStep(
  input: MixInput,
  state: { readonly approved: boolean; readonly blocked: boolean; readonly finished: boolean }
): string {
  if (state.blocked) {
    return "usuń powyższe przeszkody przed miksem";
  }

  if (!state.finished) {
    return `aimator narration mix ${input.projectId} ${input.episodeId} --track ${input.track}`;
  }

  return state.approved
    ? `odcinek "${input.episodeId}" na torze ${input.track} ma narrację i jest przyjęty`
    : `obejrzyj całość z narracją i zatwierdź: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --track ${input.track}`;
}

/** Nothing to do: the mix exists and nobody asked for another one. */
function idle(
  input: MixInput,
  report: Partial9,
  audio: readonly string[],
  approved: boolean
): MixReport {
  return {
    ...report,
    nextStep: approved
      ? `odcinek "${input.episodeId}" na torze ${input.track} ma narrację i jest przyjęty`
      : `obejrzyj całość z narracją i zatwierdź: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --track ${input.track}`,
    problems: audio,
    ready: false,
    state: "skipped",
  };
}

export async function generateMix(input: MixInput): Promise<Result<MixReport>> {
  const named = input.artifacts.filter((id) => id !== NARRATED);

  if (named.length > 0) {
    return err(
      new Stage9BlockedError([
        `--artifact "${named.join(", ")}", miks produkuje jeden artefakt na tor: ${NARRATED}`,
        "kwestie kupuje 'narration generate'; tutaj nie ma czego zawężać",
      ])
    );
  }

  const stage9 = await readStage9Inputs(input);

  if (!stage9.ok) {
    return stage9;
  }

  const timeline = await readTrackTimeline(input, stage9.data.paths, stage9.data.aspectRatio);

  if (!timeline.ok) {
    return timeline;
  }

  const clock = await readPlanClock({ ...input, aspectRatio: stage9.data.aspectRatio });

  if (!clock.ok) {
    return clock;
  }

  const lines = await readAcceptedLines(input);

  if (!lines.ok) {
    return lines;
  }

  const placement = placeLines({
    actualSeconds: timeline.data.actualSeconds,
    clock: clock.data,
    lines: lines.data.lines,
  });
  const engine = await input.mux.version();
  const problems = [
    ...lines.data.gate,
    ...timeline.data.gate,
    ...placement.problems,
    ...(engine.ok ? [] : [engine.error.message]),
  ];
  const record = timeline.data.stage.artifacts[NARRATED];
  const finished = record?.status === "completed" && !input.regenerate;

  const report = {
    actualSeconds: timeline.data.actualSeconds,
    created: [],
    engine: engine.ok ? engine.data : null,
    lines: placement.placed,
    track: input.track,
  };

  if (input.mode === "dry-run") {
    // The raw field is enough here, and stage 10's is not, which is a real
    // difference rather than an inconsistency. Every input of *this* mix is
    // gated: the script, each bought line and `episode.mp4` all have to be
    // approved before the mix may happen at all, so an input that drifted has
    // already put a problem in `problems` and `blocked` answers first. Stage
    // 10 has one input nothing gates, `mix.json`, whose whole point is to be
    // turned freely, so there the approval has to be checked against the
    // bytes. If an ungated input ever appears here, this stops being true.
    return ok(
      preview(input, report, problems, missingSound(stage9.data.settings), {
        approved: record?.review.status === "approved",
        finished,
      })
    );
  }

  if (problems.length > 0) {
    return err(new Stage9BlockedError(problems));
  }

  if (finished) {
    return ok(
      idle(input, report, missingSound(stage9.data.settings), record?.review.status === "approved")
    );
  }

  const lock = await writeNew(
    timeline.data.paths.soundtrackLock,
    serialize({ pid: process.pid, startedAt: nowIso() })
  );

  if (!lock.ok) {
    return err(new LockError(timeline.data.paths.soundtrackLock));
  }

  try {
    return await lay(input, {
      actualSeconds: timeline.data.actualSeconds,
      audio: missingSound(stage9.data.settings),
      inputs: [...lines.data.inputs, ...timeline.data.inputs],
      paths: timeline.data.paths,
      placed: placement.placed,
      ratio: stage9.data.aspectRatio,
      video: timeline.data.video,
    });
  } finally {
    await removeFile(timeline.data.paths.soundtrackLock);
  }
}

async function lay(
  input: MixInput,
  data: {
    readonly actualSeconds: number;
    readonly audio: readonly string[];
    readonly inputs: readonly RecordedFile[];
    readonly paths: {
      readonly narratedVideo: string;
      readonly runs: string;
      readonly soundtrackStage: string;
    };
    readonly placed: readonly PlacedLine[];
    readonly ratio: string;
    readonly video: string;
  }
): Promise<Result<MixReport>> {
  const runId = newRunId();
  const run = mixRunPaths(data.paths, runId);
  const target = data.paths.narratedVideo;
  const created: string[] = [];

  // The previous mix is copied out before anything overwrites it, so a failed
  // re-mix can put back the film a human had already accepted.
  if (input.regenerate) {
    const preserved = await applyWrites(
      [{ from: target, kind: "copy", to: run.previousVideo }],
      input.mode
    );

    if (preserved.ok) {
      created.push(...preserved.data);
    }
  }

  const muxed = await input.mux.mix({
    lines: data.placed.map((line) => ({ atSeconds: line.atSeconds, path: line.path })),
    target,
    video: data.video,
  });

  if (!muxed.ok) {
    await restore(run.previousVideo, target, input.regenerate);

    return muxed;
  }

  const digest = await readDigest(target);

  if (!digest.ok) {
    return digest;
  }

  // The verdict is against the cut this was made from, never against the
  // episode's declared duration: the clips drifted and stage 8 published what
  // came back, so a correct mix must not fail for a reason nobody can fix.
  const verdict = validateVideo(digest.data.bytes, {
    aspectRatio: data.ratio,
    seconds: data.actualSeconds,
  });

  if (!(verdict.ok && hasSound(digest.data.bytes))) {
    await restore(run.previousVideo, target, input.regenerate);

    return err(
      new Stage9BlockedError([
        verdict.ok
          ? "zmiksowany plik nie niesie ścieżki dźwiękowej"
          : `zmiksowany odcinek nie zgadza się z obrazem, z którego powstał: ${verdict.error.message}`,
        "nic nie opublikowano; miks nic nie kosztuje, więc poprawka i powtórzenie są darmowe",
      ])
    );
  }

  const output: RecordedFile = {
    path: toWorkspacePath(input.workspace.root, target),
    sha256: digest.data.sha256,
  };
  const stage = {
    artifacts: {
      [NARRATED]: newRecord({
        inputs: data.inputs,
        outputs: [output],
        producer: localProducer(muxed.data.engine),
        runId,
      }),
    },
    stage: STAGE,
    version: 1,
  } as const;
  const writes: readonly WriteOp[] = [
    {
      kind: "text",
      text: serialize({
        inputs: data.inputs,
        outputs: [output],
        runId,
        stage: STAGE,
        startedAt: nowIso(),
        track: input.track,
      }),
      to: run.run,
    },
    {
      kind: "text",
      text: serialize({
        argv: muxed.data.argv,
        engine: muxed.data.engine,
        stderr: muxed.data.stderr,
      }),
      to: run.transport,
    },
    { kind: "text", text: serialize(data.placed), to: run.placement },
    { kind: "text", text: serialize(verdict.data), to: run.validation },
    { kind: "text", text: serialize(stage), to: data.paths.soundtrackStage },
  ];
  const written = await applyWrites(writes, input.mode);

  if (!written.ok) {
    return written;
  }

  created.push(target, ...written.data);

  return ok({
    actualSeconds: data.actualSeconds,
    created,
    engine: muxed.data.engine,
    lines: data.placed,
    nextStep: `obejrzyj całość z narracją i zatwierdź: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --track ${input.track}`,
    problems: [...data.audio, ...drift(data.placed)],
    ready: true,
    state: "published",
    track: input.track,
  });
}

/**
 * Where the plan put a line and where it actually landed.
 *
 * Stated, never corrected, exactly as stage 8 states the drift of its clips:
 * the two timelines run at the same speed and come apart at every seam, and the
 * film that exists is the one the narration has to fit.
 */
function drift(placed: readonly PlacedLine[]): readonly string[] {
  const moved = placed.filter((line) => line.atSeconds !== line.plannedSeconds);

  return moved.length === 0
    ? []
    : [
        `dryf klipów przesunął kotwice: ${moved
          .map((line) => `${line.id} ${line.plannedSeconds}s → ${line.atSeconds}s`)
          .join(", ")}, położono je wobec filmu, który istnieje, nie wobec planu`,
      ];
}

/** Puts back the mix a human had accepted, when there was one to put back. */
async function restore(previous: string, target: string, regenerated: boolean): Promise<void> {
  await removeFile(target);

  if (regenerated) {
    await applyWrites([{ from: previous, kind: "copy", to: target }], "apply");
  }
}

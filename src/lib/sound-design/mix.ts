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
import { readAcceptedLines } from "../narration/index.js";
import { err, ok, type Result } from "../result.js";
import { readPlanClock } from "../timeline.js";
import { hasSound, validateVideo } from "../video-model/index.js";
import { type ImageTrack, mixRunPaths, type Workspace } from "../workspace.js";
import { type MixLevels, readLevels } from "./levels.js";
import {
  MIXED,
  missingDialogue,
  musicGap,
  type PlacedSound,
  placeSounds,
  readAcceptedStems,
  readStage10Inputs,
  readTrackState,
  STAGE,
  Stage10BlockedError,
} from "./plan.js";

/**
 * Internal to the sound-design module: the command that builds the full mix.
 *
 * It buys nothing. What it does is the half of stage 10 that is per track, and
 * the only half that is: the stems were bought once, and where each one lands
 * is the one thing that differs between two films cut from the same plan.
 *
 * Four rules shape it, and the first is the one that matters most.
 *
 * **It rebuilds from `episode.mp4` and the stems, not from `narrated.mp4`.**
 * Laying music over the narrated cut would encode the speech a second time,
 * and would make the ducking dishonest: the voice would already be inside the
 * signal the music is supposed to step back under. So the picture is a stream
 * copy of the approved cut, the speech comes from the lossless lines stage 9
 * bought, and everything is encoded exactly once into the file a human is
 * about to accept.
 *
 * **`narrated.mp4` is neither overwritten nor invalidated.** It becomes a
 * reviewed intermediate, the only artifact anywhere in which the narration's
 * placement can be heard with nothing else in the way, and the yes on it is
 * what this stage gates on rather than reproduces.
 *
 * **The stems are laid down as they came.** No stretching, no re-timing: those
 * are bytes somebody paid for, and altering them would be stage 8's objection
 * to trimming a drifted clip, two rows down.
 *
 * **An effect that runs past the end of the film is refused; a bed that stops
 * short of it is reported.** The first is a collision, which is stage 7's kind
 * of problem; the second is a gap, which is stage 8's kind of drift. Refusing
 * a film over a fraction of a second of silence at the end would be a refusal
 * with no remedy behind it.
 */

export interface MasterReport {
  /** How long this track's cut actually runs. */
  readonly actualSeconds: number;
  readonly created: readonly string[];
  /** The local engine, once it has answered. `null` when it could not be asked. */
  readonly engine: string | null;
  /** How the mix sits, sent explicitly, so the archive answers for these bytes. */
  readonly levels: MixLevels;
  readonly nextStep: string;
  readonly problems: readonly string[];
  readonly ready: boolean;
  /** Where each sound landed on this track, and where the plan put it. */
  readonly sounds: readonly PlacedSound[];
  readonly state: "blocked" | "planned" | "published" | "skipped";
  readonly track: ImageTrack;
}

interface MasterInput {
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
type Partial10 = Pick<
  MasterReport,
  "actualSeconds" | "created" | "engine" | "levels" | "sounds" | "track"
>;

function intent(finished: boolean, blocked: boolean): MasterReport["state"] {
  if (finished) {
    return "skipped";
  }

  return blocked ? "blocked" : "planned";
}

/**
 * `--dry-run`: the whole placement, the levels, the engine, and no write.
 *
 * What it says to do next has to account for a mix that already exists, or it
 * sends a person back round a loop they have already closed, and past the one
 * thing this stage actually needs from them, which is listening to the whole
 * film and saying yes. So a finished mix answers the same way `idle` does; only
 * an unfinished one points at the mix.
 */
function preview(
  input: MasterInput,
  report: Partial10,
  problems: readonly string[],
  notes: readonly string[],
  state: { readonly approved: boolean; readonly finished: boolean }
): MasterReport {
  const blocked = problems.length > 0;
  const { approved, finished } = state;

  return {
    ...report,
    nextStep: nextStep(input, { approved, blocked, finished }),
    problems: [...problems, ...notes],
    ready: !(blocked || finished),
    state: intent(finished, blocked),
  };
}

/**
 * Whether this mix still carries a valid yes.
 *
 * Never the raw `review.status` on its own. An approval is bound to the bytes
 * it was given for, so a recorded input that has moved since lapses it, which
 * is exactly what `check` reports and what a preview must not contradict. The
 * comparison is against the inputs *this run* would record, so it costs no
 * extra read: the files have already been opened to decide whether the mix may
 * happen at all.
 */
function accepted(
  record:
    | { readonly inputs: readonly RecordedFile[]; readonly review: { status: string } }
    | undefined,
  inputs: readonly RecordedFile[]
): boolean {
  if (record?.review.status !== "approved") {
    return false;
  }

  // Both directions, and the second is not symmetry for its own sake. A mix
  // made before anybody dialled the levels holds no entry for `mix.json` at
  // all, so nothing in it can drift, and a check that only looked for moved
  // bytes would call that mix current after somebody changed how the series
  // sounds. An input that has appeared since lapses an approval exactly as one
  // that has moved does.
  return (
    record.inputs.length === inputs.length &&
    record.inputs.every((entry) =>
      inputs.some((now) => now.path === entry.path && now.sha256 === entry.sha256)
    )
  );
}

/** Where a person goes from here, in the order the obstacles actually bite. */
function nextStep(
  input: MasterInput,
  state: { readonly approved: boolean; readonly blocked: boolean; readonly finished: boolean }
): string {
  if (state.blocked) {
    return "usuń powyższe przeszkody przed miksem";
  }

  if (!state.finished) {
    return `aimator sound-design mix ${input.projectId} ${input.episodeId} --track ${input.track}`;
  }

  return state.approved
    ? `odcinek "${input.episodeId}" na torze ${input.track} ma pełną ścieżkę i jest przyjęty`
    : `obejrzyj całość i zatwierdź: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --track ${input.track}`;
}

/** Nothing to do: the mix exists and nobody asked for another one. */
function idle(
  input: MasterInput,
  report: Partial10,
  notes: readonly string[],
  approved: boolean
): MasterReport {
  return {
    ...report,
    nextStep: approved
      ? `odcinek "${input.episodeId}" na torze ${input.track} ma pełną ścieżkę i jest przyjęty`
      : `obejrzyj całość i zatwierdź: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --track ${input.track}`,
    problems: notes,
    ready: false,
    state: "skipped",
  };
}

export async function generateMaster(input: MasterInput): Promise<Result<MasterReport>> {
  const named = input.artifacts.filter((id) => id !== MIXED);

  if (named.length > 0) {
    return err(
      new Stage10BlockedError([
        `--artifact "${named.join(", ")}", miks produkuje jeden artefakt na tor: ${MIXED}`,
        "stemy kupuje 'sound-design generate'; tutaj nie ma czego zawężać",
      ])
    );
  }

  const stage10 = await readStage10Inputs(input);

  if (!stage10.ok) {
    return stage10;
  }

  const track = await readTrackState(input, stage10.data);

  if (!track.ok) {
    return track;
  }

  const clock = await readPlanClock({ ...input, aspectRatio: stage10.data.aspectRatio });

  if (!clock.ok) {
    return clock;
  }

  const stems = await readAcceptedStems(input);

  if (!stems.ok) {
    return stems;
  }

  const lines = await readAcceptedLines(input);

  if (!lines.ok) {
    return lines;
  }

  const levels = await readLevels(input);

  if (!levels.ok) {
    return levels;
  }

  // The narration is only required where the episode declared a voice. Where
  // it did not, stage 9 never ran and its gate would be a gate with nothing
  // behind it.
  const speaks = stage10.data.settings.audio !== "music-and-effects";
  const placement = placeSounds({
    actualSeconds: track.data.actualSeconds,
    clock: clock.data,
    sounds: [
      ...stems.data.stems,
      ...(speaks ? lines.data.lines.map((line) => ({ ...line, kind: "speech" as const })) : []),
    ],
  });
  const engine = await input.mux.version();
  const problems = [
    ...stems.data.gate,
    ...(speaks ? lines.data.gate : []),
    ...track.data.gate,
    ...placement.problems,
    ...(engine.ok ? [] : [engine.error.message]),
  ];
  const record = track.data.stage.artifacts[MIXED];
  const finished = record?.status === "completed" && !input.regenerate;
  const inputs = [
    ...stems.data.inputs,
    ...(speaks ? lines.data.inputs : []),
    ...track.data.inputs,
    ...(levels.data.input === null ? [] : [levels.data.input]),
  ];
  const notes = [
    ...missingDialogue(stage10.data.settings),
    ...musicGap(placement.placed, track.data.actualSeconds),
    ...drift(placement.placed),
  ];
  const report = {
    actualSeconds: track.data.actualSeconds,
    created: [],
    engine: engine.ok ? engine.data : null,
    levels: levels.data.levels,
    sounds: placement.placed,
    track: input.track,
  };

  if (input.mode === "dry-run") {
    return ok(
      preview(input, report, problems, notes, { approved: accepted(record, inputs), finished })
    );
  }

  if (problems.length > 0) {
    return err(new Stage10BlockedError(problems));
  }

  if (finished) {
    return ok(idle(input, report, notes, record?.review.status === "approved"));
  }

  const lock = await writeNew(
    track.data.paths.soundDesignLock,
    serialize({ pid: process.pid, startedAt: nowIso() })
  );

  if (!lock.ok) {
    return err(new LockError(track.data.paths.soundDesignLock));
  }

  try {
    return await lay(input, {
      actualSeconds: track.data.actualSeconds,
      inputs,
      levels: levels.data.levels,
      notes,
      paths: track.data.paths,
      placed: placement.placed,
      ratio: stage10.data.aspectRatio,
      video: track.data.video,
    });
  } finally {
    await removeFile(track.data.paths.soundDesignLock);
  }
}

async function lay(
  input: MasterInput,
  data: {
    readonly actualSeconds: number;
    readonly inputs: readonly RecordedFile[];
    readonly levels: MixLevels;
    readonly notes: readonly string[];
    readonly paths: {
      readonly mixedVideo: string;
      readonly runs: string;
      readonly soundDesignStage: string;
    };
    readonly placed: readonly PlacedSound[];
    readonly ratio: string;
    readonly video: string;
  }
): Promise<Result<MasterReport>> {
  const runId = newRunId();
  const run = mixRunPaths(data.paths, runId);
  const target = data.paths.mixedVideo;
  const created: string[] = [];
  const of = (kind: PlacedSound["kind"]) =>
    data.placed
      .filter((sound) => sound.kind === kind)
      .map((sound) => ({ atSeconds: sound.atSeconds, path: sound.path }));

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

  const muxed = await input.mux.master({
    effects: of("effect"),
    levels: data.levels,
    music: of("music"),
    speech: of("speech"),
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
      new Stage10BlockedError([
        verdict.ok
          ? "zmiksowany plik nie niesie ścieżki dźwiękowej"
          : `pełna ścieżka nie zgadza się z obrazem, z którego powstała: ${verdict.error.message}`,
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
      [MIXED]: newRecord({
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
        // Sent explicitly on every invocation, so this file answers what
        // produced these bytes rather than deferring to whatever a default was.
        levels: data.levels,
        stderr: muxed.data.stderr,
      }),
      to: run.transport,
    },
    { kind: "text", text: serialize(data.placed), to: run.placement },
    { kind: "text", text: serialize(verdict.data), to: run.validation },
    { kind: "text", text: serialize(stage), to: data.paths.soundDesignStage },
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
    levels: data.levels,
    nextStep: `obejrzyj całość i zatwierdź: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --track ${input.track}`,
    problems: data.notes,
    ready: true,
    sounds: data.placed,
    state: "published",
    track: input.track,
  });
}

/**
 * Where the plan put a sound and where it actually landed.
 *
 * Stated, never corrected, exactly as stage 8 states the drift of its clips
 * and stage 9 states the drift of its lines: the two clocks run at the same
 * speed and come apart at every seam, and the film that exists is the one the
 * sound has to fit.
 */
function drift(placed: readonly PlacedSound[]): readonly string[] {
  const moved = placed.filter((sound) => sound.atSeconds !== sound.plannedSeconds);

  return moved.length === 0
    ? []
    : [
        `dryf klipów przesunął kotwice: ${moved
          .map((sound) => `${sound.id} ${sound.plannedSeconds}s → ${sound.atSeconds}s`)
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

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
import { checkShotList } from "../shot-list/index.js";
import { hasSound, validateVideo } from "../video-model/index.js";
import { validateSpeech } from "../voice-model/index.js";
import {
  type ImageTrack,
  narrationAudio,
  soundtrackRunPaths,
  type Workspace,
} from "../workspace.js";
import {
  missingSound,
  NARRATED,
  type PlacedLine,
  placeLines,
  readClipDrift,
  readStage9Inputs,
  readTrackTimeline,
  SCRIPT,
  STAGE,
  Stage9BlockedError,
  type Stage9Inputs,
} from "./plan.js";
import { validateNarration } from "./validate.js";

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
 * remedy — because where a line sits comes from a plan a human approved, and
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
  /** Narrows nothing — there is one artifact per track — but a wrong value is refused. */
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
      `inna próba trzyma blokadę ${path} — po awarii upewnij się, że poprzedni proces nie działa, zanim usuniesz ten plik`
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

/** `--dry-run`: the whole placement, the engine, and no write. */
function preview(
  input: MixInput,
  report: Partial9,
  problems: readonly string[],
  audio: readonly string[],
  finished: boolean
): MixReport {
  const blocked = problems.length > 0;

  return {
    ...report,
    nextStep: blocked
      ? "usuń powyższe przeszkody przed miksem"
      : `aimator narration mix ${input.projectId} ${input.episodeId} --track ${input.track}`,
    problems: [...problems, ...audio],
    ready: !(blocked || finished),
    state: intent(finished, blocked),
  };
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
        `--artifact "${named.join(", ")}" — miks produkuje jeden artefakt na tor: ${NARRATED}`,
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

  const clips = await readClipDrift(input, stage9.data.paths, stage9.data.aspectRatio);

  if (!clips.ok) {
    return clips;
  }

  const lines = await readBoughtLines(input, stage9.data);

  if (!lines.ok) {
    return lines;
  }

  const placement = placeLines({
    actualSeconds: timeline.data.actualSeconds,
    clips: clips.data,
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
    return ok(preview(input, report, problems, missingSound(stage9.data.settings), finished));
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

interface BoughtLines {
  /** Why the mix may not happen: a line nobody accepted, or none bought at all. */
  readonly gate: readonly string[];
  readonly inputs: readonly RecordedFile[];
  readonly lines: readonly {
    readonly atSeconds: number;
    readonly characters: number;
    readonly id: string;
    readonly path: string;
    readonly seconds: number;
    readonly shot: string;
    readonly text: string;
  }[];
}

/**
 * Every line of the approved script, with the recording somebody accepted.
 *
 * The gate is per utterance and it is approval rather than existence: a
 * recording that merely exists is one nobody has listened to, and the whole
 * stage sits downstream of a human saying yes.
 */
async function readBoughtLines(
  input: MixInput,
  stage9: Stage9Inputs
): Promise<Result<BoughtLines>> {
  const script = await readDigest(stage9.paths.episode.narrationScript);
  const plan = await checkShotList(input);

  if (!plan.ok) {
    return plan;
  }

  // An absent script is an obstacle, not a failure: `--dry-run` has to be able
  // to report it beside the others rather than die on it, which is what every
  // gate in this pipeline promises.
  if (!script.ok || plan.data.verdict === null) {
    return ok({
      gate: ["nie ma skryptu narracji — uruchom najpierw: narration generate"],
      inputs: [],
      lines: [],
    });
  }

  const verdict = validateNarration({
    shotList: plan.data.verdict,
    text: script.data.bytes.toString("utf8"),
  });

  if (!verdict.ok) {
    return ok({ gate: [verdict.error.message], inputs: [], lines: [] });
  }

  const gate: string[] = [];
  const inputs: RecordedFile[] = [
    {
      path: toWorkspacePath(input.workspace.root, stage9.paths.episode.narrationScript),
      sha256: script.data.sha256,
    },
  ];

  if (stage9.stage.artifacts[SCRIPT]?.review.status !== "approved") {
    gate.push("skrypt narracji czeka na ocenę człowieka");
  }

  const lines: BoughtLines["lines"][number][] = [];

  for (const line of verdict.data.lines) {
    const file = narrationAudio(stage9.paths.episode, line.id);

    if (!file.ok) {
      return file;
    }

    // biome-ignore lint/performance/noAwaitInLoops: one line read at a time, in the script's order
    const bytes = await readDigest(file.data);
    const record = stage9.stage.artifacts[line.id];

    if (!bytes.ok || record?.status !== "completed") {
      gate.push(`${line.id}: nie ma nagrania — kwestia nie została kupiona`);
      continue;
    }

    const recorded = {
      path: toWorkspacePath(input.workspace.root, file.data),
      sha256: bytes.data.sha256,
    };
    const output = record.outputs.find((one) => one.path === recorded.path);

    if (output === undefined || output.sha256 !== recorded.sha256) {
      gate.push(`${line.id}: bajty nagrania nie zgadzają się z jego rekordem`);
    }

    if (record.review.status !== "approved") {
      gate.push(`${line.id}: nagranie czeka na ocenę człowieka`);
    }

    const speech = validateSpeech(bytes.data.bytes);

    if (!speech.ok) {
      gate.push(`${line.id}: ${speech.error.message}`);
      continue;
    }

    inputs.push(recorded);
    lines.push({ ...line, path: file.data, seconds: speech.data.seconds });
  }

  if (lines.length === 0) {
    gate.push("żadna kwestia nie jest gotowa — nie ma czego położyć na obrazie");
  }

  return ok({ gate, inputs, lines });
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
  const run = soundtrackRunPaths(data.paths, runId);
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
          .join(", ")} — położono je wobec filmu, który istnieje, nie wobec planu`,
      ];
}

/** Puts back the mix a human had accepted, when there was one to put back. */
async function restore(previous: string, target: string, regenerated: boolean): Promise<void> {
  await removeFile(target);

  if (regenerated) {
    await applyWrites([{ from: previous, kind: "copy", to: target }], "apply");
  }
}

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
import { validateVideo } from "../video-model/index.js";
import { assemblyRunPaths, type ImageTrack, type Workspace } from "../workspace.js";
import {
  EPISODE_CUT,
  readStage8Inputs,
  round,
  STAGE,
  Stage8BlockedError,
  type Stage8Inputs,
} from "./plan.js";

/**
 * Internal to the assembly module: the command that cuts the episode.
 *
 * It is the shape of every generate command above it with the money taken out,
 * and the two differences that follow from that are the whole of what is new.
 *
 * **`--regenerate` guards an approval, not a wallet.** Everywhere upstream the
 * flag exists because a new attempt is a new charge. Here nothing is bought —
 * but a finished cut carries a human's yes, and silently overwriting it would
 * withdraw that yes on nobody's authority. "Nic nie ponawia się samo" holds
 * even when repeating is free.
 *
 * **A bad cut is deleted rather than kept.** Stage 7 keeps an invalid clip
 * because somebody paid for it; here the same file can be made again for
 * nothing, so publishing nothing means leaving nothing. The previous cut is
 * copied into the archive before the muxer runs, which is what lets a failed
 * re-cut put back the episode a human had already accepted.
 */

/** What happened to the one artifact this stage makes. */
export interface CutOutcome {
  readonly id: string;
  readonly note: string;
  /** How long the finished file runs, once there is one. */
  readonly seconds: number | null;
  readonly state: "blocked" | "planned" | "published" | "skipped";
}

export interface AssemblyReport {
  /** The sum of the clips as they actually came back — what the cut runs. */
  readonly actualSeconds: number;
  /** Whether every clip the plan names is accepted on this track. */
  readonly approved: boolean;
  readonly artifact: CutOutcome;
  readonly created: readonly string[];
  /** The clips in the order they were cut, with the seconds each one really runs. */
  readonly cut: readonly { id: string; plannedSeconds: number; seconds: number | null }[];
  /** The local engine, once it has answered. `null` when it could not be asked. */
  readonly engine: string | null;
  readonly nextStep: string;
  /** What the approved shot list adds up to. */
  readonly plannedSeconds: number;
  readonly problems: readonly string[];
  readonly ready: boolean;
  readonly track: ImageTrack;
}

interface GenerateInput {
  /** Narrows nothing — there is one artifact — but a wrong value is refused. */
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

export async function generateAssembly(input: GenerateInput): Promise<Result<AssemblyReport>> {
  const named = input.artifacts.filter((id) => id !== EPISODE_CUT);

  if (named.length > 0) {
    return err(
      new Stage8BlockedError([
        `--artifact "${named.join(", ")}" — etap 8 montuje jeden artefakt na tor: ${EPISODE_CUT}`,
        "klipy należą do etapu 7; tutaj nie ma czego zawężać",
      ])
    );
  }

  const stage8 = await readStage8Inputs(input);

  if (!stage8.ok) {
    return stage8;
  }

  const engine = await input.mux.version();
  const problems = [...stage8.data.gate, ...(engine.ok ? [] : [engine.error.message])];

  if (input.mode === "dry-run") {
    return ok(preview(input, stage8.data, engine.ok ? engine.data : null, problems));
  }

  if (problems.length > 0) {
    return err(new Stage8BlockedError(problems));
  }

  const record = stage8.data.stage.artifacts[EPISODE_CUT];

  if (record?.status === "completed" && !input.regenerate) {
    return ok(idle(input, stage8.data, engine.ok ? engine.data : null));
  }

  const lock = await writeNew(
    stage8.data.paths.track.assemblyLock,
    serialize({ pid: process.pid, startedAt: nowIso() })
  );

  if (!lock.ok) {
    return err(new LockError(stage8.data.paths.track.assemblyLock));
  }

  try {
    return await cut(input, stage8.data);
  } finally {
    await removeFile(stage8.data.paths.track.assemblyLock);
  }
}

/** `--dry-run`: the whole plan, the engine, the arithmetic, and no write. */
function preview(
  input: GenerateInput,
  stage8: Stage8Inputs,
  engine: string | null,
  problems: readonly string[]
): AssemblyReport {
  const record = stage8.stage.artifacts[EPISODE_CUT];
  // A preview answers "what would this command do", so a cut the real run would
  // leave alone must not be shown as work it would perform.
  const finished = record?.status === "completed" && !input.regenerate;
  const blocked = problems.length > 0;

  return {
    ...arithmetic(stage8),
    approved: stage8.gate.length === 0,
    artifact: intent(finished, blocked, problems),
    created: [],
    engine,
    nextStep: blocked
      ? "usuń powyższe przeszkody przed montażem"
      : `aimator assembly generate ${input.projectId} ${input.episodeId} --track ${input.track}`,
    problems: [...problems, ...silence(stage8)],
    ready: !(blocked || finished),
    track: input.track,
  };
}

/** What a preview would do about the one artifact, and why. */
function intent(finished: boolean, blocked: boolean, problems: readonly string[]): CutOutcome {
  if (finished) {
    return { ...ALREADY_CUT, seconds: null, state: "skipped" };
  }

  return blocked
    ? { id: EPISODE_CUT, note: problems.join("; "), seconds: null, state: "blocked" }
    : { id: EPISODE_CUT, note: "gotowe do sklejenia", seconds: null, state: "planned" };
}

const ALREADY_CUT = {
  id: EPISODE_CUT,
  note: "odcinek już zmontowany; ponowne cięcie zaczyna wyłącznie --regenerate",
} as const;

/** Nothing to do: the cut exists and nobody asked for another one. */
function idle(input: GenerateInput, stage8: Stage8Inputs, engine: string | null): AssemblyReport {
  const approved = stage8.stage.artifacts[EPISODE_CUT]?.review.status === "approved";

  return {
    ...arithmetic(stage8),
    approved: stage8.gate.length === 0,
    artifact: { ...ALREADY_CUT, seconds: null, state: "skipped" },
    created: [],
    engine,
    nextStep: approved
      ? `odcinek "${input.episodeId}" na torze ${input.track} jest zmontowany i przyjęty`
      : `obejrzyj całość i zatwierdź: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --track ${input.track}`,
    problems: silence(stage8),
    ready: false,
    track: input.track,
  };
}

/**
 * The one thing this stage says about a declaration it cannot fulfil.
 *
 * The episode stored a sound mode in stage 0 and nothing in this pipeline
 * produces a soundtrack, so the cut is silent. Reported rather than enforced,
 * exactly as stage 2 reports a missing alpha channel: the file is the whole of
 * what stage 8 was contracted to make, and the film is still not finished.
 */
function silence(stage8: Stage8Inputs): readonly string[] {
  return [
    `odcinek deklaruje audio: ${stage8.audio}, a żaden etap nie produkuje ścieżki dźwiękowej — episode.mp4 jest niemy`,
  ];
}

/** What the plan ordered, what came back, and by how much they differ. */
function arithmetic(stage8: Stage8Inputs): {
  actualSeconds: number;
  cut: readonly { id: string; plannedSeconds: number; seconds: number | null }[];
  plannedSeconds: number;
} {
  return {
    actualSeconds: stage8.actualSeconds,
    cut: stage8.cut.map((one) => ({
      id: one.id,
      plannedSeconds: one.plannedSeconds,
      seconds: one.actualSeconds,
    })),
    plannedSeconds: stage8.plannedSeconds,
  };
}

/**
 * The drift between the film a human approved and the film that exists.
 *
 * Stated, never corrected. Stage 7 publishes a clip at the length it arrived
 * rather than trimming it to the order, and those are the bytes somebody
 * accepted — so trimming them here would put a film together out of frames
 * nobody approved.
 */
function drift(stage8: Stage8Inputs): readonly string[] {
  const difference = round(stage8.actualSeconds - stage8.plannedSeconds);

  return difference === 0
    ? []
    : [
        `dryf długości: plan ${stage8.plannedSeconds}s, klipy ${stage8.actualSeconds}s, różnica ${difference > 0 ? "+" : ""}${difference}s — sklejono to, co wróciło, nic nie przycięto`,
      ];
}

async function cut(input: GenerateInput, stage8: Stage8Inputs): Promise<Result<AssemblyReport>> {
  const runId = newRunId();
  const run = assemblyRunPaths(stage8.paths.track, runId);
  const target = stage8.paths.track.episodeVideo;
  const created: string[] = [];

  // The previous cut is copied out before anything overwrites it, so a failed
  // re-cut can put back the episode a human had already accepted.
  if (input.regenerate) {
    const preserved = await applyWrites(
      [{ from: target, kind: "copy", to: run.previousVideo }],
      input.mode
    );

    if (preserved.ok) {
      created.push(...preserved.data);
    }
  }

  const muxed = await input.mux.concat({
    clips: stage8.cut.map((one) => one.path),
    listPath: run.list,
    target,
  });

  if (!muxed.ok) {
    await restore(run.previousVideo, target, input.regenerate);

    return muxed;
  }

  const digest = await readDigest(target);

  if (!digest.ok) {
    return digest;
  }

  // The verdict is against the sum of the clips, never against the episode's
  // declared duration: a correct concatenation of clips that drifted must not
  // fail for a reason nobody downstream can fix.
  const verdict = validateVideo(digest.data.bytes, {
    aspectRatio: stage8.aspectRatio,
    seconds: stage8.actualSeconds,
  });

  if (!verdict.ok) {
    await restore(run.previousVideo, target, input.regenerate);

    return err(
      new Stage8BlockedError([
        `sklejony odcinek nie zgadza się z klipami, z których powstał: ${verdict.error.message}`,
        `suma klipów to ${stage8.actualSeconds}s`,
        "nic nie opublikowano; montaż nic nie kosztuje, więc poprawka i powtórzenie są darmowe",
      ])
    );
  }

  const output: RecordedFile = {
    path: toWorkspacePath(input.workspace.root, target),
    sha256: digest.data.sha256,
  };
  const stage = {
    ...stage8.stage,
    artifacts: {
      ...stage8.stage.artifacts,
      [EPISODE_CUT]: newRecord({
        inputs: stage8.inputs,
        outputs: [output],
        producer: localProducer(muxed.data.engine),
        runId,
      }),
    },
  };
  const writes: readonly WriteOp[] = [
    {
      kind: "text",
      text: serialize({
        clips: stage8.cut.map((one) => ({
          id: one.id,
          plannedSeconds: one.plannedSeconds,
          seconds: one.actualSeconds,
        })),
        inputs: stage8.inputs,
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
    { kind: "text", text: serialize(verdict.data), to: run.validation },
    { kind: "text", text: serialize(stage), to: stage8.paths.track.assemblyStage },
  ];
  const written = await applyWrites(writes, input.mode);

  if (!written.ok) {
    return written;
  }

  created.push(run.list, target, ...written.data);

  return ok({
    ...arithmetic(stage8),
    approved: true,
    artifact: {
      id: EPISODE_CUT,
      note: `${verdict.data.width}x${verdict.data.height}, ${verdict.data.seconds}s, ${stage8.cut.length} klipów`,
      seconds: verdict.data.seconds,
      state: "published",
    },
    created,
    engine: muxed.data.engine,
    nextStep: `obejrzyj całość i zatwierdź: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --track ${input.track}`,
    problems: [...drift(stage8), ...silence(stage8)],
    ready: true,
    track: input.track,
  });
}

/** Puts back the cut a human had accepted, when there was one to put back. */
async function restore(previous: string, target: string, regenerated: boolean): Promise<void> {
  await removeFile(target);

  if (regenerated) {
    await applyWrites([{ from: previous, kind: "copy", to: target }], "apply");
  }
}

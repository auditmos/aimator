import {
  applyWrites,
  approveArtifacts,
  type RecordedFile,
  readDigest,
  serialize,
  type WriteMode,
  withInputs,
} from "../artifact/index.js";
import { err, ok, type Result } from "../result.js";
import { validateVideo } from "../video-model/index.js";
import { type ImageTrack, workspacePath } from "../workspace.js";
import {
  EPISODE_CUT,
  readStage8Inputs,
  STAGE,
  type Stage8Inputs,
  type Stage8Scope,
} from "./plan.js";

/**
 * Internal to the assembly module: verification, and the approval on top of it.
 *
 * What "ocena całości" means is the whole of why this file is separate from the
 * eight approvals above it. Those said that each shot is right; this one says
 * that these clips, in this order, are the film. Three things exist only in the
 * whole and in no part of it: the rhythm across the cuts, the continuity at the
 * seams, stage 7's chain guarantees what an entry frame was *drawn from*, not
 * where a fourteen-second render actually ended up, and the film's real
 * length. They are two levels of judgement, not one repeated.
 *
 * `check` reads and reports; it writes nothing. `approve` repeats the whole
 * verification and only then records acceptance, bound to the bytes of the cut
 * as they now stand.
 */

export interface CutState {
  readonly approved: boolean;
  readonly id: string;
  /** Recorded inputs whose bytes on disk no longer match what this cut used. */
  readonly inputsChanged: readonly string[];
  readonly note: string;
  /** How long the file runs, once there is one. */
  readonly seconds: number | null;
  readonly state: "absent" | "completed";
}

export interface AssemblyStatus {
  /** True once the cut carries a still-valid approval. */
  readonly approved: boolean;
  readonly artifact: CutState;
  readonly nextStep: string;
  /**
   * What this stage says without refusing: a declaration nothing here can
   * fulfil, a length that drifted, a price worth reading before spending.
   * Reported, never enforced, which is exactly why it is not a problem.
   */
  readonly notices: readonly string[];
  readonly problems: readonly string[];
  readonly track: ImageTrack;
}

type ApproveScope = Stage8Scope & {
  /** Narrows nothing; there is one artifact, but a wrong value is refused. */
  readonly artifacts: readonly string[];
  readonly mode: WriteMode;
  readonly note: string | null;
  readonly reviewer: string;
};

class AssemblyStateError extends Error {
  readonly problems: readonly string[];

  constructor(message: string, problems: readonly string[] = []) {
    super(
      problems.length === 0 ? message : `${message}\n${problems.map((p) => `  - ${p}`).join("\n")}`
    );
    this.name = "AssemblyStateError";
    this.problems = problems;
  }
}

interface Inspection {
  /** Problems an approval may not write over. Input drift is not among them. */
  readonly blocking: readonly string[];
  /** The inputs as they now stand, what an approval re-records. */
  readonly inputs: readonly RecordedFile[];
  readonly stage8: Stage8Inputs;
  readonly status: AssemblyStatus;
}

/** Which recorded inputs no longer match the bytes on disk. */
async function changedInputs(
  input: Stage8Scope,
  recorded: readonly RecordedFile[]
): Promise<readonly string[]> {
  const changed: string[] = [];

  for (const entry of recorded) {
    // biome-ignore lint/performance/noAwaitInLoops: each input read once per check
    const digest = await readDigest(workspacePath(input.workspace, entry.path));

    if (!digest.ok || digest.data.sha256 !== entry.sha256) {
      changed.push(entry.path);
    }
  }

  return changed;
}

async function inspect(input: Stage8Scope): Promise<Result<Inspection>> {
  const stage8 = await readStage8Inputs(input);

  if (!stage8.ok) {
    return stage8;
  }

  const record = stage8.data.stage.artifacts[EPISODE_CUT];
  const label = `episode.mp4 (${input.track})`;

  if (record === undefined) {
    return ok({
      blocking: [],
      inputs: stage8.data.inputs,
      stage8: stage8.data,
      status: {
        approved: false,
        artifact: {
          approved: false,
          id: EPISODE_CUT,
          inputsChanged: [],
          note:
            stage8.data.gate.length > 0 ? stage8.data.gate.join("; ") : "jeszcze nie zmontowany",
          seconds: null,
          state: "absent",
        },
        nextStep: `aimator assembly generate ${input.projectId} ${input.episodeId} --track ${input.track}`,
        notices: soundtrack(stage8.data),
        problems: stage8.data.gate,
        track: input.track,
      },
    });
  }

  const [output] = record.outputs;
  const { blocking, note, seconds } =
    output === undefined
      ? {
          blocking: [`${label}: rekord ukończony, ale nie wskazuje żadnego pliku`],
          note: "brak pliku",
          seconds: null,
        }
      : await verdictOf(input, stage8.data, output, label);
  const inputsChanged = await changedInputs(input, record.inputs);
  const approved =
    record.review.status === "approved" && blocking.length === 0 && inputsChanged.length === 0;

  return ok({
    blocking,
    inputs: stage8.data.inputs,
    stage8: stage8.data,
    status: {
      approved,
      artifact: {
        approved,
        id: EPISODE_CUT,
        inputsChanged,
        note,
        seconds,
        state: "completed",
      },
      nextStep: approved
        ? `odcinek "${input.episodeId}" na torze ${input.track} jest zmontowany i przyjęty`
        : `obejrzyj całość i zatwierdź: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --track ${input.track}`,
      notices: soundtrack(stage8.data),
      problems: [
        // The gate is reported beside the cut's own verdict, not only before
        // there is a cut: a clip that lost its approval after the episode was
        // assembled is something a person needs told, even though the bytes it
        // was cut from have not moved.
        ...stage8.data.gate,
        ...blocking,
        ...inputsChanged.map(
          (path) =>
            `${path}: zmienił się od czasu montażu, obejrzyj odcinek jeszcze raz i zatwierdź ponownie albo zmontuj go od nowa: aimator assembly generate ${input.projectId} ${input.episodeId} --track ${input.track} --regenerate`
        ),
      ],
      track: input.track,
    },
  });
}

/**
 * The verdict on the finished file, read from its own boxes.
 *
 * No decoder and no ffmpeg: `check` has to work on whatever machine the
 * workspace is sitting on, which is the reason `lib/video-model` reads boxes in
 * the first place. The comparison is against the sum of the clips rather than
 * against `durationSeconds`, for the reason the cut itself uses, that sum is
 * what the film is.
 */
async function verdictOf(
  input: Stage8Scope,
  stage8: Stage8Inputs,
  output: RecordedFile,
  label: string
): Promise<{ blocking: readonly string[]; note: string; seconds: number | null }> {
  const digest = await readDigest(workspacePath(input.workspace, output.path));

  if (!digest.ok) {
    return { blocking: [`${label}: brakuje ${output.path}`], note: "brak pliku", seconds: null };
  }

  if (digest.data.sha256 !== output.sha256) {
    return {
      blocking: [
        `${label}: nie zgadza się z zapisanym hashem, wynik został zmieniony poza narzędziem`,
      ],
      note: "bajty nie zgadzają się z rekordem",
      seconds: null,
    };
  }

  const verdict = validateVideo(digest.data.bytes, {
    aspectRatio: stage8.aspectRatio,
    seconds: stage8.actualSeconds,
  });

  return verdict.ok
    ? {
        blocking: [],
        note: `${verdict.data.width}x${verdict.data.height}, ${verdict.data.seconds}s, ${stage8.cut.length} klipów`,
        seconds: verdict.data.seconds,
      }
    : {
        blocking: [`${label}: ${verdict.error.message}`],
        note: "odcinek nie przechodzi walidacji",
        seconds: null,
      };
}

/** The declared sound mode nothing in this pipeline fulfils. Reported, never enforced. */
function soundtrack(stage8: Stage8Inputs): readonly string[] {
  return [
    `odcinek deklaruje audio: ${stage8.audio}, a żaden etap nie produkuje ścieżki dźwiękowej, episode.mp4 jest niemy`,
  ];
}

/** Reads and reports. Writes nothing; that is what makes it safe to run. */
export async function checkAssembly(input: Stage8Scope): Promise<Result<AssemblyStatus>> {
  const inspection = await inspect(input);

  return inspection.ok ? ok(inspection.data.status) : inspection;
}

/**
 * Records that a human watched the whole episode and accepted it.
 *
 * `--artifact` is not required, and that is a decision rather than a copy of
 * stage 6's. A flag is demanded upstream for two reasons: several candidates
 * exist, so a bare command is ambiguous, and the act opens a gate that spends
 * money. Neither holds at the last row of the table, one artifact per track,
 * and nothing below it to buy.
 */
export async function approveAssembly(input: ApproveScope): Promise<Result<AssemblyStatus>> {
  const named = input.artifacts.filter((id) => id !== EPISODE_CUT);

  if (named.length > 0) {
    return err(
      new AssemblyStateError(
        `--artifact "${named.join(", ")}", etap 8 ma jeden artefakt na tor: ${EPISODE_CUT}`
      )
    );
  }

  const inspection = await inspect(input);

  if (!inspection.ok) {
    return inspection;
  }

  const { blocking, inputs, stage8, status } = inspection.data;

  if (status.artifact.state !== "completed") {
    return err(
      new AssemblyStateError(
        `nie ma czego zatwierdzić: odcinek nie jest zmontowany na torze ${input.track}`,
        status.problems
      )
    );
  }

  if (blocking.length > 0) {
    return err(
      new AssemblyStateError("nie akceptuje się tego, co nie przechodzi walidacji", blocking)
    );
  }

  const rebound = withInputs(stage8.stage, EPISODE_CUT, inputs);
  const approved = approveArtifacts(rebound, [EPISODE_CUT], {
    note: input.note,
    reviewer: input.reviewer,
  });
  const written = await applyWrites(
    [{ kind: "text", text: serialize(approved), to: stage8.paths.track.assemblyStage }],
    input.mode
  );

  if (!written.ok) {
    return written;
  }

  return ok({
    ...status,
    approved: true,
    artifact: { ...status.artifact, approved: true, inputsChanged: [] },
    nextStep: `odcinek "${input.episodeId}" na torze ${input.track} jest zmontowany i przyjęty`,
  });
}

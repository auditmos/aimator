import {
  applyWrites,
  approveArtifacts,
  type RecordedFile,
  readDigest,
  serialize,
  type WriteMode,
  withInputs,
} from "../artifact/index.js";
import { type ImageVerdict, validateImage } from "../image-model/index.js";
import { err, ok, type Result } from "../result.js";
import { type ImageTrack, workspacePath } from "../workspace.js";
import {
  OPENING_FRAME,
  readStage6Inputs,
  STAGE,
  type Stage6Inputs,
  type Stage6Scope,
} from "./plan.js";

/**
 * Internal to the opening-frame module: verification, and the approval that
 * sits on top of it but is never implied by it.
 *
 * `check` reads and reports; it writes nothing. `approve` repeats the whole
 * verification and only then records acceptance, bound to the digest of the
 * image as it now stands.
 *
 * Unlike stage 5; it does not demand to be told what is being accepted. Stage 5
 * refuses a bare `approve` because accepting R03 is what buys R04, so it must
 * be something somebody typed rather than a side effect, with six candidates,
 * the flag is the sentence. Here there is one artifact, and
 * `approve … --stage opening-frame --track seedream` already is that sentence:
 * a required flag with one legal value would be ceremony standing where a
 * decision used to be. It is still accepted when written, because every other
 * stage's command takes it.
 */

export interface OpeningFrameState {
  readonly approved: boolean;
  readonly id: string;
  /** Recorded inputs whose bytes on disk no longer match what this run used. */
  readonly inputsChanged: readonly string[];
  readonly note: string;
  readonly state: "absent" | "completed" | "submitted";
  readonly verdict: ImageVerdict | null;
}

export interface OpeningFrameStatus {
  /** True once the frame carries an explicit, still-valid approval. */
  readonly approved: boolean;
  readonly artifact: OpeningFrameState;
  readonly nextStep: string;
  readonly problems: readonly string[];
  readonly track: ImageTrack;
}

type ApproveScope = Stage6Scope & {
  /** Empty is the normal call. A named artifact must be this stage's one. */
  readonly artifacts: readonly string[];
  readonly mode: WriteMode;
  readonly note: string | null;
  readonly reviewer: string;
};

class OpeningFrameStateError extends Error {
  readonly problems: readonly string[];

  constructor(message: string, problems: readonly string[] = []) {
    super(
      problems.length === 0 ? message : `${message}\n${problems.map((p) => `  - ${p}`).join("\n")}`
    );
    this.name = "OpeningFrameStateError";
    this.problems = problems;
  }
}

interface Inspection {
  /** Problems an approval may not write over. Input drift is not among them. */
  readonly blocking: readonly string[];
  /** The inputs as they now stand, what an approval re-records. */
  readonly inputs: readonly RecordedFile[];
  readonly stage6: Stage6Inputs;
  readonly status: OpeningFrameStatus;
}

/**
 * Which recorded inputs no longer match the bytes on disk.
 *
 * The frame records the package, the project rules, the shot list, its own
 * prompt and every attachment it carried, so a redrawn `R01` shows up here as
 * drift rather than as a broken image.
 */
async function changedInputs(
  input: Stage6Scope,
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

async function inspect(input: Stage6Scope): Promise<Result<Inspection>> {
  const stage6 = await readStage6Inputs(input);

  if (!stage6.ok) {
    return stage6;
  }

  const { opening, paths, plan, stage } = stage6.data;
  const record = stage.artifacts[OPENING_FRAME];
  const label = `${OPENING_FRAME} (${input.track})`;

  if (record === undefined) {
    return ok({
      blocking: [],
      inputs: opening.inputs,
      stage6: stage6.data,
      status: {
        approved: false,
        artifact: {
          approved: false,
          id: OPENING_FRAME,
          inputsChanged: [],
          note: opening.blockers.length > 0 ? opening.blockers.join("; ") : "jeszcze nie powstała",
          state: "absent",
          verdict: null,
        },
        nextStep: `aimator opening-frame generate ${input.projectId} ${input.episodeId} --track ${input.track}`,
        problems: [...stage6.data.gate, ...opening.blockers],
        track: input.track,
      },
    });
  }

  if (record.status === "submitted") {
    const unfinished = `${label}: próba ${record.runId} zapisała status "submitted" i nigdy nie dobiegła końca, mogła zostać rozliczona; powtórz polecenie, żeby dokończyć ją z zapisanej odpowiedzi, albo użyj --regenerate`;

    return ok({
      blocking: [unfinished],
      inputs: opening.inputs,
      stage6: stage6.data,
      status: {
        approved: false,
        artifact: {
          approved: false,
          id: OPENING_FRAME,
          inputsChanged: [],
          note: `próba ${record.runId} nieukończona`,
          state: "submitted",
          verdict: null,
        },
        nextStep: `aimator opening-frame generate ${input.projectId} ${input.episodeId} --track ${input.track}`,
        problems: [...stage6.data.gate, unfinished],
        track: input.track,
      },
    });
  }

  const blocking: string[] = [];
  const [output] = record.outputs;
  const digest = await readDigest(paths.track.openingFrameImage);
  let verdict: ImageVerdict | null = null;

  if (output === undefined) {
    blocking.push(`${label}: rekord ukończony, ale nie wskazuje żadnego pliku`);
  } else if (!digest.ok) {
    blocking.push(`${label}: brakuje ${output.path}`);
  } else if (digest.data.sha256 === output.sha256) {
    const checked = validateImage(digest.data.bytes, plan.size);

    if (checked.ok) {
      verdict = checked.data;
    } else {
      blocking.push(`${label}: ${checked.error.message}`);
    }
  } else {
    blocking.push(
      `${label}: ${output.path} nie zgadza się z zapisanym hashem, wynik został zmieniony poza narzędziem`
    );
  }

  const inputsChanged = await changedInputs(input, record.inputs);
  const problems = [...stage6.data.gate, ...blocking];

  // Drift is reported beside the blocking problems and revokes the approval
  // just as loudly, but it is not one of them. The frame is intact; it was
  // drawn from something that has since changed, and reading it again beside
  // the new version is exactly what an approval is.
  for (const path of inputsChanged) {
    problems.push(
      `${path}: zmienił się od czasu narysowania klatki otwarcia, obejrzyj ją jeszcze raz obok nowej wersji i zatwierdź ponownie albo przerysuj: aimator opening-frame generate ${input.projectId} ${input.episodeId} --track ${input.track} --regenerate`
    );
  }

  const approved =
    record.review.status === "approved" && blocking.length === 0 && inputsChanged.length === 0;

  return ok({
    blocking,
    inputs: opening.inputs,
    stage6: stage6.data,
    status: {
      approved,
      artifact: {
        approved,
        id: OPENING_FRAME,
        inputsChanged,
        note:
          verdict === null ? "nie udało się odczytać obrazu" : `${verdict.width}x${verdict.height}`,
        state: "completed",
        verdict,
      },
      nextStep: approved
        ? `etap 6 dla odcinka "${input.episodeId}" na torze ${input.track} jest kompletny, dalej etap 7, klipy`
        : `oceń i zatwierdź: aimator approve ${input.projectId} ${input.episodeId} --stage ${STAGE} --track ${input.track}`,
      problems,
      track: input.track,
    },
  });
}

/** Reads and reports. Writes nothing; that is what makes it safe to run. */
export async function checkOpeningFrame(input: Stage6Scope): Promise<Result<OpeningFrameStatus>> {
  const inspection = await inspect(input);

  return inspection.ok ? ok(inspection.data.status) : inspection;
}

/**
 * Records that a human accepted this frame, bound to its current bytes.
 *
 * An edited input is not a validation failure, the frame is exactly what the
 * stage produced; it was simply drawn from a dependency that has changed since.
 * The digests are re-recorded here, by an approval that has already verified
 * the image itself still validates, because the reader who typed `approve` is
 * the one who looked at both.
 */
export async function approveOpeningFrame(
  input: ApproveScope
): Promise<Result<OpeningFrameStatus>> {
  const named = input.artifacts.filter((id) => id !== OPENING_FRAME);

  if (named.length > 0) {
    return err(
      new OpeningFrameStateError(
        `--artifact "${named.join(", ")}", etap 6 ma jeden artefakt, ${OPENING_FRAME}; pomiń tę flagę albo podaj właśnie jego`
      )
    );
  }

  const inspection = await inspect(input);

  if (!inspection.ok) {
    return inspection;
  }

  const { blocking, inputs, stage6, status } = inspection.data;
  const problems = [...blocking];

  if (status.artifact.state !== "completed") {
    problems.push(`nie ma czego zatwierdzić (${status.artifact.state})`);
  }

  if (problems.length > 0) {
    return err(
      new OpeningFrameStateError("nie akceptuje się tego, co nie przechodzi walidacji", problems)
    );
  }

  const approved = approveArtifacts(
    withInputs(stage6.stage, OPENING_FRAME, inputs),
    [OPENING_FRAME],
    {
      note: input.note,
      reviewer: input.reviewer,
    }
  );
  const written = await applyWrites(
    [{ kind: "text", text: serialize(approved), to: stage6.paths.track.openingFrameStage }],
    input.mode
  );

  if (!written.ok) {
    return written;
  }

  return ok({
    ...status,
    approved: true,
    artifact: { ...status.artifact, approved: true, inputsChanged: [] },
    nextStep: `etap 6 dla odcinka "${input.episodeId}" na torze ${input.track} jest kompletny, dalej etap 7, klipy`,
  });
}

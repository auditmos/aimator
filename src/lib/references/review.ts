import {
  applyWrites,
  approveArtifacts,
  type RecordedFile,
  readDigest,
  type StageFile,
  serialize,
  type WriteMode,
  withInputs,
} from "../artifact/index.js";
import { type ImageVerdict, validateImage } from "../image-model/index.js";
import type { PlannedArtifact } from "../media-prompt/index.js";
import { err, ok, type Result } from "../result.js";
import { type ImageTrack, referenceImage, workspacePath } from "../workspace.js";
import { REFERENCE_ID, readStage5Inputs, type Stage5Inputs, type Stage5Scope } from "./plan.js";

/**
 * Internal to the references module: verification, and the approval that sits
 * on top of it but is never implied by it.
 *
 * `check` reads and reports; it writes nothing. `approve` repeats the whole
 * verification and only then records acceptance — bound to the digest of one
 * image at a time, because each reference is a separate creative judgement and
 * because the next one's gate reads them separately. R04 may not be drawn until
 * somebody has accepted R03, so an approval that spilled across the set would
 * open a gate nobody looked through.
 */

export interface ReferenceStatus {
  readonly approved: boolean;
  readonly id: string;
  /** Recorded inputs whose bytes on disk no longer match what this run used. */
  readonly inputsChanged: readonly string[];
  readonly note: string;
  readonly state: "absent" | "completed" | "submitted";
  readonly verdict: ImageVerdict | null;
}

export interface ReferencesStatus {
  /** True once every reference carries an explicit, still-valid approval. */
  readonly approved: boolean;
  readonly artifacts: readonly ReferenceStatus[];
  readonly nextStep: string;
  readonly problems: readonly string[];
  readonly track: ImageTrack;
}

type ApproveScope = Stage5Scope & {
  /** Which references to accept. Empty is refused rather than read as "all". */
  readonly artifacts: readonly string[];
  readonly mode: WriteMode;
  readonly note: string | null;
  readonly reviewer: string;
};

class ReferenceStateError extends Error {
  readonly problems: readonly string[];

  constructor(message: string, problems: readonly string[] = []) {
    super(
      problems.length === 0 ? message : `${message}\n${problems.map((p) => `  - ${p}`).join("\n")}`
    );
    this.name = "ReferenceStateError";
    this.problems = problems;
  }
}

interface Inspection {
  /** Problems an approval may not write over. Input drift is not among them. */
  readonly blocking: readonly string[];
  /** The inputs as they now stand, per reference — what an approval re-records. */
  readonly inputs: Map<string, readonly RecordedFile[]>;
  readonly stage: StageFile;
  readonly stagePath: string;
  readonly status: ReferencesStatus;
}

async function inspectOne(
  input: Stage5Scope,
  stage5: Stage5Inputs,
  planned: PlannedArtifact,
  seen: Map<string, string | null>
): Promise<{ blocking: readonly string[]; status: ReferenceStatus }> {
  const record = stage5.stage.artifacts[planned.id];
  const label = `${planned.id} (${input.track})`;

  if (record === undefined) {
    return {
      blocking: [],
      status: {
        approved: false,
        id: planned.id,
        inputsChanged: [],
        note: planned.blockers.length > 0 ? planned.blockers.join("; ") : "jeszcze nie powstała",
        state: "absent",
        verdict: null,
      },
    };
  }

  if (record.status === "submitted") {
    const unfinished = `${label}: próba ${record.runId} zapisała status "submitted" i nigdy nie dobiegła końca — mogła zostać rozliczona; powtórz polecenie, żeby dokończyć ją z zapisanej odpowiedzi, albo użyj --regenerate`;

    return {
      blocking: [unfinished],
      status: {
        approved: false,
        id: planned.id,
        inputsChanged: [],
        note: `próba ${record.runId} nieukończona`,
        state: "submitted",
        verdict: null,
      },
    };
  }

  const blocking: string[] = [];
  const path = referenceImage(stage5.paths.track, planned.id);
  const [output] = record.outputs;
  const digest = path.ok ? await readDigest(path.data) : null;
  let verdict: ImageVerdict | null = null;

  if (output === undefined) {
    blocking.push(`${label}: rekord ukończony, ale nie wskazuje żadnego pliku`);
  } else if (digest === null || !digest.ok) {
    blocking.push(`${label}: brakuje ${output.path}`);
  } else if (digest.data.sha256 === output.sha256) {
    const checked = validateImage(digest.data.bytes, stage5.plan.size);

    if (checked.ok) {
      verdict = checked.data;
    } else {
      blocking.push(`${label}: ${checked.error.message}`);
    }
  } else {
    blocking.push(
      `${label}: ${output.path} nie zgadza się z zapisanym hashem — wynik został zmieniony poza narzędziem`
    );
  }

  const inputsChanged = await changedInputs(input, record.inputs, seen);

  return {
    blocking,
    status: {
      // Approval is bound to bytes: a recorded "approved" that no longer
      // verifies is not an approval, it is a stale claim.
      approved:
        record.review.status === "approved" && blocking.length === 0 && inputsChanged.length === 0,
      id: planned.id,
      inputsChanged,
      note:
        verdict === null ? "nie udało się odczytać obrazu" : `${verdict.width}x${verdict.height}`,
      state: "completed",
      verdict,
    },
  };
}

/**
 * Which recorded inputs no longer match the bytes on disk.
 *
 * Every reference records the package, the project rules and its own prompt, so
 * the same handful of files appears in six records. Each is hashed once per
 * check rather than once per reference.
 */
async function changedInputs(
  input: Stage5Scope,
  recorded: readonly RecordedFile[],
  seen: Map<string, string | null>
): Promise<readonly string[]> {
  const changed: string[] = [];

  for (const entry of recorded) {
    if (!seen.has(entry.path)) {
      // biome-ignore lint/performance/noAwaitInLoops: each input read once per check
      const digest = await readDigest(workspacePath(input.workspace, entry.path));

      seen.set(entry.path, digest.ok ? digest.data.sha256 : null);
    }

    if (seen.get(entry.path) !== entry.sha256) {
      changed.push(entry.path);
    }
  }

  return changed;
}

async function inspect(input: Stage5Scope): Promise<Result<Inspection>> {
  const stage5 = await readStage5Inputs(input);

  if (!stage5.ok) {
    return stage5;
  }

  const blocking: string[] = [];
  const problems: string[] = [];
  const artifacts: ReferenceStatus[] = [];
  const inputs = new Map<string, readonly RecordedFile[]>();
  const seen = new Map<string, string | null>();

  for (const planned of stage5.data.references) {
    inputs.set(planned.id, planned.inputs);
    // biome-ignore lint/performance/noAwaitInLoops: one reference at a time, in order
    const one = await inspectOne(input, stage5.data, planned, seen);

    artifacts.push(one.status);
    blocking.push(...one.blocking);
    problems.push(...one.blocking);

    // Drift is reported beside the blocking problems and revokes the approval
    // just as loudly — but it is not one of them. The image is intact; it was
    // drawn from something that has since changed, and reading it again beside
    // the new version is exactly what an approval is.
    for (const path of one.status.inputsChanged) {
      problems.push(
        `${path}: zmienił się od czasu narysowania ${planned.id} — obejrzyj obraz jeszcze raz obok nowej wersji i zatwierdź ponownie albo przerysuj: aimator reference generate ${input.projectId} ${input.episodeId} --track ${input.track} --regenerate --artifact ${planned.id}`
      );
    }
  }

  return ok({
    blocking,
    inputs,
    stage: stage5.data.stage,
    stagePath: stage5.data.paths.track.stage,
    status: {
      approved: artifacts.length > 0 && artifacts.every((one) => one.approved),
      artifacts,
      nextStep: nextStepOf(input, artifacts),
      problems: [...stage5.data.gate, ...problems],
      track: input.track,
    },
  });
}

function nextStepOf(input: Stage5Scope, artifacts: readonly ReferenceStatus[]): string {
  const waiting = artifacts.filter((one) => one.state === "completed" && !one.approved);

  if (waiting.length > 0) {
    return `oceń i zatwierdź: aimator approve ${input.projectId} ${input.episodeId} --stage references --track ${input.track} --artifact ${waiting.map((one) => one.id).join(",")}`;
  }

  const missing = artifacts.filter((one) => one.state === "absent");

  return missing.length > 0
    ? `aimator reference generate ${input.projectId} ${input.episodeId} --track ${input.track}`
    : `etap 5 dla odcinka "${input.episodeId}" na torze ${input.track} jest kompletny — dalej etap 6, klatka otwarcia`;
}

/** Reads and reports. Writes nothing — that is what makes it safe to run. */
export async function checkReferences(input: Stage5Scope): Promise<Result<ReferencesStatus>> {
  const inspection = await inspect(input);

  return inspection.ok ? ok(inspection.data.status) : inspection;
}

/**
 * Records that a human accepted these images, bound to their current bytes.
 *
 * It names the references explicitly and refuses without them: accepting R03 is
 * what lets R04 be bought, so it has to be something somebody typed rather than
 * a side effect of accepting something else.
 *
 * An edited input is not a validation failure — the image is exactly what the
 * stage produced, it was simply drawn from a dependency that has changed since.
 * The digests are re-recorded here, by an approval that has already verified
 * the image itself still validates, because the reader who typed `approve` is
 * the one who looked at both.
 */
export async function approveReferences(input: ApproveScope): Promise<Result<ReferencesStatus>> {
  if (input.artifacts.length === 0) {
    return err(new ReferenceStateError("wskaż, co zatwierdzasz: --artifact R01[,R02]"));
  }

  const named = input.artifacts.filter((id) => !REFERENCE_ID.test(id));

  if (named.length > 0) {
    return err(new ReferenceStateError(`--artifact "${named.join(", ")}" — oczekiwano formy R01`));
  }

  const inspection = await inspect(input);

  if (!inspection.ok) {
    return inspection;
  }

  const { blocking, inputs, stage, stagePath, status } = inspection.data;
  const problems: string[] = [];

  for (const id of input.artifacts) {
    const entry = status.artifacts.find((one) => one.id === id);

    if (entry === undefined || entry.state !== "completed") {
      problems.push(`${id}: nie ma czego zatwierdzić (${entry?.state ?? "brak"})`);
    }
  }

  problems.push(
    ...blocking.filter((problem) => input.artifacts.some((id) => problem.startsWith(`${id} (`)))
  );

  if (problems.length > 0) {
    return err(
      new ReferenceStateError("nie akceptuje się tego, co nie przechodzi walidacji", problems)
    );
  }

  let rebound = stage;

  for (const id of input.artifacts) {
    rebound = withInputs(rebound, id, inputs.get(id) ?? []);
  }

  const approved = approveArtifacts(rebound, input.artifacts, {
    note: input.note,
    reviewer: input.reviewer,
  });
  const written = await applyWrites(
    [{ kind: "text", text: serialize(approved), to: stagePath }],
    input.mode
  );

  if (!written.ok) {
    return written;
  }

  const settled = status.artifacts.map((one) =>
    input.artifacts.includes(one.id) ? { ...one, approved: true, inputsChanged: [] } : one
  );

  return ok({
    ...status,
    approved: settled.every((one) => one.approved),
    artifacts: settled,
    nextStep: nextStepOf(input, settled),
  });
}

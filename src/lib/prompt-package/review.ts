import {
  applyWrites,
  approveAll,
  isApproved,
  type RecordedFile,
  readDigest,
  readJson,
  type StageFile,
  serialize,
  stageFileSchema,
  verifyOutputs,
  type WriteMode,
  withInputs,
} from "../artifact/index.js";
import { err, ok, type Result } from "../result.js";
import { readStage4Inputs, type Stage4Inputs, type Stage4Scope } from "./plan.js";
import { type PromptPackage, validatePromptPackage } from "./validate.js";

/**
 * Internal to the prompt-package module: verification, and the approval that
 * sits on top of it but is never implied by it.
 *
 * `check` reads and reports; it writes nothing, not even `needsReview` — that
 * belongs to the dependent stage, at the moment it runs. `approve` repeats the
 * whole verification and only then records a human's acceptance, bound to the
 * digest of the manifest and of every prompt file beside it.
 *
 * The same two kinds of wrong are kept apart here as in stages 1 and 3: a
 * package whose wiring fails is broken and `approve` refuses, while a package
 * whose input has been edited since it was written is intact but unread for
 * those inputs, which is a lapsed consent and precisely what an approval is
 * for. A shot list that really changed shape fails the structural check first,
 * because the package is re-validated against the plan as it now stands — and a
 * canonical image redrawn since is drift, which `approve` reads and re-records.
 */

const ARTIFACT = "prompt-package";

export interface PromptPackageStatus {
  readonly approved: boolean;
  /** Inputs whose bytes no longer match what this run consumed. */
  readonly inputsChanged: readonly string[];
  readonly problems: readonly string[];
  readonly status: "absent" | "completed" | "submitted";
  readonly verdict: PromptPackage | null;
}

type ApproveScope = Stage4Scope & {
  readonly mode: WriteMode;
  readonly note: string | null;
  readonly reviewer: string;
};

class PackageStateError extends Error {
  readonly problems: readonly string[];

  constructor(message: string, problems: readonly string[] = []) {
    super(
      problems.length === 0 ? message : `${message}\n${problems.map((p) => `  - ${p}`).join("\n")}`
    );
    this.name = "PackageStateError";
    this.problems = problems;
  }
}

interface Inspection {
  /** Problems an approval may not write over. Input drift is not among them. */
  readonly blocking: readonly string[];
  /** The inputs as they stand now — what an approval re-records. */
  readonly inputs: readonly RecordedFile[];
  readonly stage: StageFile | null;
  readonly stagePath: string;
  readonly status: PromptPackageStatus;
}

function changedInputs(
  recorded: readonly RecordedFile[],
  current: readonly RecordedFile[]
): readonly string[] {
  return recorded
    .filter(
      (entry) => !current.some((now) => now.path === entry.path && now.sha256 === entry.sha256)
    )
    .map((entry) => entry.path);
}

async function inspect(input: Stage4Scope): Promise<Result<Inspection>> {
  const stage4 = await readStage4Inputs(input);

  if (!stage4.ok) {
    return stage4;
  }

  const { paths } = stage4.data;
  const stage = await readJson(paths.episode.promptPackageStage, stageFileSchema);

  if (!stage.ok) {
    return ok({
      blocking: [],
      inputs: stage4.data.inputs,
      stage: null,
      stagePath: paths.episode.promptPackageStage,
      status: {
        approved: false,
        inputsChanged: [],
        problems: [
          `odcinek "${input.episodeId}": etap 4 jeszcze nie powstał — aimator prompt-package generate ${input.projectId} ${input.episodeId}`,
        ],
        status: "absent",
        verdict: null,
      },
    });
  }

  const record = stage.data.artifacts[ARTIFACT];
  const blocking: string[] = [];

  if (record === undefined) {
    return err(
      new PackageStateError("prompt-package.stage.json nie zawiera artefaktu prompt-package")
    );
  }

  if (record.status === "submitted") {
    const unfinished = `odcinek "${input.episodeId}": próba ${record.runId} zapisała status "submitted" i nigdy nie dobiegła końca — mogła zostać rozliczona; nową próbę zaczyna --regenerate`;

    return ok({
      blocking: [unfinished],
      inputs: stage4.data.inputs,
      stage: stage.data,
      stagePath: paths.episode.promptPackageStage,
      status: {
        approved: false,
        inputsChanged: changedInputs(record.inputs, stage4.data.inputs),
        problems: [unfinished],
        status: "submitted",
        verdict: null,
      },
    });
  }

  await verifyOutputs(input.workspace, stage.data, `odcinek "${input.episodeId}"`, blocking);

  const verdict = await judge(stage4.data, blocking);
  // Drift is reported beside the blocking problems and revokes the approval
  // just as loudly — but it is not one of them. The package is intact; it is
  // unread for these inputs, and `approve` is what reads it.
  const inputsChanged = changedInputs(record.inputs, stage4.data.inputs);
  const lapsed = inputsChanged.map(
    (path) =>
      `${path}: zmienił się od czasu ułożenia pakietu — tych wejść nikt jeszcze nie przyjął; przeczytaj pakiet jeszcze raz i zatwierdź go ponownie: aimator approve ${input.projectId} ${input.episodeId} --stage prompt-package`
  );
  const problems = [...blocking, ...lapsed];

  return ok({
    blocking,
    inputs: stage4.data.inputs,
    stage: stage.data,
    stagePath: paths.episode.promptPackageStage,
    status: {
      // Approval is bound to bytes: a recorded "approved" that no longer
      // verifies is not an approval, it is a stale claim.
      approved: isApproved(stage.data) && problems.length === 0,
      inputsChanged,
      problems,
      status: "completed",
      verdict,
    },
  });
}

/** Re-runs the structural verdict against the bytes as they are now. */
async function judge(stage4: Stage4Inputs, problems: string[]): Promise<PromptPackage | null> {
  const manifest = await readDigest(stage4.paths.episode.promptPackage);

  if (!manifest.ok) {
    return null;
  }

  if (stage4.shotList === null) {
    problems.push(...stage4.gate);
    return null;
  }

  let value: unknown;

  try {
    value = JSON.parse(manifest.data.bytes.toString("utf8"));
  } catch {
    problems.push("prompt-package.json nie jest poprawnym JSON-em");
    return null;
  }

  const verdict = validatePromptPackage({
    cast: stage4.cast,
    shotList: stage4.shotList,
    value,
  });

  if (verdict.ok) {
    return verdict.data;
  }

  problems.push(`prompt-package.json: ${verdict.error.message}`);

  return null;
}

/** Reads and reports. Writes nothing — that is what makes it safe to run. */
export async function checkPromptPackage(input: Stage4Scope): Promise<Result<PromptPackageStatus>> {
  const inspection = await inspect(input);

  return inspection.ok ? ok(inspection.data.status) : inspection;
}

/**
 * Records that a human accepted this package, bound to its current bytes and to
 * the inputs as they now stand.
 *
 * It refuses over anything that does not verify: an approval written on top of
 * a failing package or an unfinished attempt would be a claim the later stages
 * have no way to doubt. An edited input is not that — the wiring still covers
 * the shot list on disk, so the digests are re-recorded and the approval
 * proceeds, rather than leaving the episode to buy a second package.
 */
export async function approvePromptPackage(
  input: ApproveScope
): Promise<Result<PromptPackageStatus>> {
  const inspection = await inspect(input);

  if (!inspection.ok) {
    return inspection;
  }

  const { blocking, inputs, stage, stagePath, status } = inspection.data;

  if (stage === null || status.status !== "completed") {
    return err(
      new PackageStateError(
        `nie ma czego zatwierdzić dla odcinka "${input.episodeId}"`,
        status.problems
      )
    );
  }

  if (blocking.length > 0) {
    return err(
      new PackageStateError("nie akceptuje się tego, co nie przechodzi walidacji", blocking)
    );
  }

  const rebound = withInputs(stage, ARTIFACT, inputs);
  const approved = approveAll(rebound, { note: input.note, reviewer: input.reviewer });
  const written = await applyWrites(
    [{ kind: "text", text: serialize(approved), to: stagePath }],
    input.mode
  );

  return written.ok ? ok({ ...status, approved: true, inputsChanged: [], problems: [] }) : written;
}

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
} from "../artifact/index.js";
import { err, ok, type Result } from "../result.js";
import { readStage3Inputs, type Stage3Inputs, type Stage3Scope } from "./plan.js";
import { type ShotList, validateShotList } from "./validate.js";

/**
 * Internal to the shot-list module: verification, and the approval that sits on
 * top of it but is never implied by it.
 *
 * `check` reads and reports; it writes nothing, not even `needsReview` — that
 * belongs to the dependent stage, at the moment it runs. `approve` repeats the
 * whole verification and only then records a human's acceptance, bound to the
 * digest of the shot list as it stands.
 */

const ARTIFACT = "shot-list";

export interface ShotListStatus {
  readonly approved: boolean;
  /** Inputs whose bytes no longer match what this run consumed. */
  readonly inputsChanged: readonly string[];
  readonly problems: readonly string[];
  readonly status: "absent" | "completed" | "submitted";
  readonly verdict: ShotList | null;
}

type ApproveScope = Stage3Scope & {
  readonly mode: WriteMode;
  readonly note: string | null;
  readonly reviewer: string;
};

class ShotListStateError extends Error {
  readonly problems: readonly string[];

  constructor(message: string, problems: readonly string[] = []) {
    super(
      problems.length === 0 ? message : `${message}\n${problems.map((p) => `  - ${p}`).join("\n")}`
    );
    this.name = "ShotListStateError";
    this.problems = problems;
  }
}

interface Inspection {
  readonly stage: StageFile | null;
  readonly stagePath: string;
  readonly status: ShotListStatus;
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

async function inspect(input: Stage3Scope): Promise<Result<Inspection>> {
  const stage3 = await readStage3Inputs(input);

  if (!stage3.ok) {
    return stage3;
  }

  const { paths } = stage3.data;
  const stage = await readJson(paths.episode.shotListStage, stageFileSchema);

  if (!stage.ok) {
    return ok({
      stage: null,
      stagePath: paths.episode.shotListStage,
      status: {
        approved: false,
        inputsChanged: [],
        problems: [
          `odcinek "${input.episodeId}": etap 3 jeszcze nie powstał — aimator shot-list generate ${input.projectId} ${input.episodeId}`,
        ],
        status: "absent",
        verdict: null,
      },
    });
  }

  const record = stage.data.artifacts[ARTIFACT];
  const problems: string[] = [];

  if (record === undefined) {
    return err(new ShotListStateError("shot-list.stage.json nie zawiera artefaktu shot-list"));
  }

  if (record.status === "submitted") {
    return ok({
      stage: stage.data,
      stagePath: paths.episode.shotListStage,
      status: {
        approved: false,
        inputsChanged: changedInputs(record.inputs, stage3.data.inputs),
        problems: [
          `odcinek "${input.episodeId}": próba ${record.runId} zapisała status "submitted" i nigdy nie dobiegła końca — mogła zostać rozliczona; nową próbę zaczyna --regenerate`,
        ],
        status: "submitted",
        verdict: null,
      },
    });
  }

  await verifyOutputs(input.workspace, stage.data, `odcinek "${input.episodeId}"`, problems);

  const verdict = await judge(stage3.data, problems);
  const inputsChanged = changedInputs(record.inputs, stage3.data.inputs);

  for (const path of inputsChanged) {
    problems.push(
      `${path}: zmienił się od czasu ułożenia listy ujęć — wynik etapu 3 opisuje inne wejście`
    );
  }

  return ok({
    stage: stage.data,
    stagePath: paths.episode.shotListStage,
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
async function judge(stage3: Stage3Inputs, problems: string[]): Promise<ShotList | null> {
  const text = await readDigest(stage3.paths.episode.shotList);

  if (!text.ok) {
    return null;
  }

  if (stage3.settings === null || stage3.screenplay === null) {
    problems.push(...stage3.gate);
    return null;
  }

  const verdict = validateShotList({
    cast: stage3.cast,
    screenplay: stage3.screenplay,
    settings: stage3.settings,
    text: text.data.bytes.toString("utf8"),
  });

  if (verdict.ok) {
    return verdict.data;
  }

  problems.push(`shot-list.md: ${verdict.error.message}`);

  return null;
}

/** Reads and reports. Writes nothing — that is what makes it safe to run. */
export async function checkShotList(input: Stage3Scope): Promise<Result<ShotListStatus>> {
  const inspection = await inspect(input);

  return inspection.ok ? ok(inspection.data.status) : inspection;
}

/**
 * Records that a human accepted this shot list, bound to its current bytes.
 *
 * It refuses over anything that does not verify: an approval written on top of
 * a failing plan, a changed input or an unfinished attempt would be a claim the
 * later stages have no way to doubt.
 */
export async function approveShotList(input: ApproveScope): Promise<Result<ShotListStatus>> {
  const inspection = await inspect(input);

  if (!inspection.ok) {
    return inspection;
  }

  const { stage, stagePath, status } = inspection.data;

  if (stage === null || status.status !== "completed") {
    return err(
      new ShotListStateError(
        `nie ma czego zatwierdzić dla odcinka "${input.episodeId}"`,
        status.problems
      )
    );
  }

  if (status.problems.length > 0) {
    return err(
      new ShotListStateError("nie akceptuje się tego, co nie przechodzi walidacji", status.problems)
    );
  }

  const approved = approveAll(stage, { note: input.note, reviewer: input.reviewer });
  const written = await applyWrites(
    [{ kind: "text", text: serialize(approved), to: stagePath }],
    input.mode
  );

  return written.ok ? ok({ ...status, approved: true }) : written;
}

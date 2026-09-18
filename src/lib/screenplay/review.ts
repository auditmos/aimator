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
import { readStage0Inputs } from "../project/index.js";
import { err, ok, type Result } from "../result.js";
import { episodePaths, projectPaths, type Workspace } from "../workspace.js";
import { type ScreenplayVerdict, validateScreenplay } from "./validate.js";

/**
 * Internal to the screenplay module: verification, and the approval that sits
 * on top of it but is never implied by it.
 *
 * `check` reads and reports; it writes nothing, not even `needsReview` — that
 * belongs to the dependent stage, at the moment it runs. `approve` repeats the
 * whole verification and only then records a human's acceptance, bound to the
 * digest of the screenplay as it stands.
 */

const ARTIFACT = "screenplay";

export interface ScreenplayStatus {
  readonly approved: boolean;
  /** Stage-0 artifacts whose bytes no longer match what this run consumed. */
  readonly inputsChanged: readonly string[];
  readonly problems: readonly string[];
  readonly status: "absent" | "completed" | "submitted";
  readonly verdict: ScreenplayVerdict | null;
}

interface EpisodeScope {
  readonly episodeId: string;
  readonly projectId: string;
  readonly workspace: Workspace;
}

type ApproveScope = EpisodeScope & {
  readonly mode: WriteMode;
  readonly note: string | null;
  readonly reviewer: string;
};

class ScreenplayStateError extends Error {
  readonly problems: readonly string[];

  constructor(message: string, problems: readonly string[] = []) {
    super(
      problems.length === 0 ? message : `${message}\n${problems.map((p) => `  - ${p}`).join("\n")}`
    );
    this.name = "ScreenplayStateError";
    this.problems = problems;
  }
}

interface Inspection {
  readonly stage: StageFile | null;
  readonly status: ScreenplayStatus;
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

async function inspect(input: EpisodeScope): Promise<Result<Inspection>> {
  const project = projectPaths(input.workspace, input.projectId);

  if (!project.ok) {
    return project;
  }

  const paths = episodePaths(project.data, input.episodeId);

  if (!paths.ok) {
    return paths;
  }

  const stage0 = await readStage0Inputs(input);

  if (!stage0.ok) {
    return stage0;
  }

  const stage = await readJson(paths.data.screenplayStage, stageFileSchema);

  if (!stage.ok) {
    return ok({
      stage: null,
      status: {
        approved: false,
        inputsChanged: [],
        problems: [
          `odcinek "${input.episodeId}": etap 1 jeszcze nie powstał — aimator screenplay generate ${input.projectId} ${input.episodeId}`,
        ],
        status: "absent",
        verdict: null,
      },
    });
  }

  const record = stage.data.artifacts[ARTIFACT];
  const problems: string[] = [];

  if (record === undefined) {
    return err(new ScreenplayStateError("screenplay.stage.json nie zawiera artefaktu screenplay"));
  }

  if (record.status === "submitted") {
    problems.push(
      `odcinek "${input.episodeId}": próba ${record.runId} zapisała status "submitted" i nigdy nie dobiegła końca — mogła zostać rozliczona; nową próbę zaczyna --regenerate`
    );

    return ok({
      stage: stage.data,
      status: {
        approved: false,
        inputsChanged: changedInputs(record.inputs, stage0.data.inputs),
        problems,
        status: "submitted",
        verdict: null,
      },
    });
  }

  await verifyOutputs(input.workspace, stage.data, `odcinek "${input.episodeId}"`, problems);

  const screenplay = await readDigest(paths.data.screenplay);
  const verdict = screenplay.ok
    ? validateScreenplay(screenplay.data.bytes.toString("utf8"), stage0.data.settings)
    : null;

  if (verdict !== null && !verdict.ok) {
    problems.push(`screenplay.md: ${verdict.error.message}`);
  }

  const inputsChanged = changedInputs(record.inputs, stage0.data.inputs);

  for (const path of inputsChanged) {
    problems.push(
      `${path}: zmienił się od czasu generacji scenariusza — wynik etapu 1 opisuje inne wejście`
    );
  }

  return ok({
    stage: stage.data,
    status: {
      // Approval is bound to bytes: a recorded "approved" that no longer
      // verifies is not an approval, it is a stale claim.
      approved: isApproved(stage.data) && problems.length === 0,
      inputsChanged,
      problems,
      status: "completed",
      verdict: verdict?.ok === true ? verdict.data : null,
    },
  });
}

/** Reads and reports. Writes nothing — that is what makes it safe to run. */
export async function checkScreenplay(input: EpisodeScope): Promise<Result<ScreenplayStatus>> {
  const inspection = await inspect(input);

  return inspection.ok ? ok(inspection.data.status) : inspection;
}

/**
 * Records that a human accepted this screenplay, bound to its current bytes.
 *
 * It refuses over anything that does not verify: an approval written on top of
 * a failing draft, a changed input or an unfinished attempt would be a claim
 * the later stages have no way to doubt.
 */
export async function approveScreenplay(input: ApproveScope): Promise<Result<ScreenplayStatus>> {
  const inspection = await inspect(input);

  if (!inspection.ok) {
    return inspection;
  }

  const { stage, status } = inspection.data;

  if (stage === null || status.status !== "completed") {
    return err(
      new ScreenplayStateError(
        `nie ma czego zatwierdzić dla odcinka "${input.episodeId}"`,
        status.problems
      )
    );
  }

  if (status.problems.length > 0) {
    return err(
      new ScreenplayStateError(
        "nie akceptuje się tego, co nie przechodzi walidacji",
        status.problems
      )
    );
  }

  const project = projectPaths(input.workspace, input.projectId);

  if (!project.ok) {
    return project;
  }

  const paths = episodePaths(project.data, input.episodeId);

  if (!paths.ok) {
    return paths;
  }

  const approved = approveAll(stage, { note: input.note, reviewer: input.reviewer });
  const written = await applyWrites(
    [{ kind: "text", text: serialize(approved), to: paths.data.screenplayStage }],
    input.mode
  );

  return written.ok ? ok({ ...status, approved: true }) : written;
}

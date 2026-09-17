import { join } from "node:path";
import type { Workspace } from "../workspace.js";
import type { RecordedFile, StageFile } from "./schema.js";
import { nowIso, readDigest } from "./store.js";

/**
 * Internal to the project module: provenance verification and the creative
 * review that sits on top of it.
 *
 * Validation and approval are deliberately separate. Validation asks "do the
 * bytes still hash to what was recorded"; approval asks "does a human accept
 * this result". Approval is bound to the digests that were verified at the
 * moment it was granted, so editing an artifact afterwards revokes it by
 * arithmetic rather than by anyone remembering to.
 */

interface Approval {
  readonly note: string | null;
  readonly reviewer: string;
}

/**
 * The honesty gate: an artifact is only what the stage recorded if its bytes
 * still hash to the digest written beside it. Editing a result outside the
 * tool is allowed — silently carrying its old provenance forward is not.
 */
export async function verifyOutputs(
  workspace: Workspace,
  stage: StageFile,
  label: string,
  problems: string[]
): Promise<void> {
  const outputs = Object.values(stage.artifacts).flatMap((artifact) => artifact.outputs);
  // Hashed in parallel, reported in declaration order: the verdict a user
  // reads must not depend on which read happened to finish first.
  const digests = await Promise.all(
    outputs.map((output) => readDigest(join(workspace.root, output.path)))
  );

  for (const [index, output] of outputs.entries()) {
    const digest = digests[index];

    if (digest === undefined || !digest.ok) {
      problems.push(`${label}: brakuje ${output.path}`);
    } else if (digest.data.sha256 !== output.sha256) {
      problems.push(
        `${label}: ${output.path} nie zgadza się z zapisanym hashem — wynik został zmieniony poza narzędziem`
      );
    }
  }
}

/** True once every artifact in the file carries an explicit approval. */
export function isApproved(stage: StageFile): boolean {
  const records = Object.values(stage.artifacts);

  return records.length > 0 && records.every((artifact) => artifact.review.status === "approved");
}

/** Approves every artifact in the file, binding the decision to this moment. */
export function approveAll(stage: StageFile, approval: Approval): StageFile {
  const reviewedAt = nowIso();
  const artifacts: StageFile["artifacts"] = {};

  for (const [key, artifact] of Object.entries(stage.artifacts)) {
    artifacts[key] = {
      ...artifact,
      review: {
        note: approval.note,
        reviewedAt,
        reviewer: approval.reviewer,
        status: "approved",
      },
    };
  }

  return { ...stage, artifacts };
}

/**
 * Binds extra files to an artifact's outputs. Used for `project.md`, which
 * carries no digest while it is being written by hand and acquires one at the
 * moment somebody approves the rules it contains.
 */
export function withOutputs(
  stage: StageFile,
  key: string,
  outputs: readonly RecordedFile[]
): StageFile {
  const artifact = stage.artifacts[key];

  if (artifact === undefined) {
    return stage;
  }

  const kept = artifact.outputs.filter(
    (output) => !outputs.some((extra) => extra.path === output.path)
  );

  return {
    ...stage,
    artifacts: { ...stage.artifacts, [key]: { ...artifact, outputs: [...kept, ...outputs] } },
  };
}

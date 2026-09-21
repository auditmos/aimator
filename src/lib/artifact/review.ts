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
 * tool is allowed, silently carrying its old provenance forward is not.
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
        `${label}: ${output.path} nie zgadza się z zapisanym hashem, wynik został zmieniony poza narzędziem`
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
  return approveArtifacts(stage, Object.keys(stage.artifacts), approval);
}

/**
 * Approves the named artifacts and leaves the rest alone.
 *
 * Stage 2 accepts its ten results one at a time, because they are ten separate
 * creative judgements and because the next step's gate reads them separately: a
 * view may not start until the card has been accepted, and an approval that
 * spilled onto every key in the file would open that gate without anyone having
 * looked. A key that is not in the file is skipped rather than invented.
 */
export function approveArtifacts(
  stage: StageFile,
  keys: readonly string[],
  approval: Approval
): StageFile {
  const reviewedAt = nowIso();
  const artifacts = { ...stage.artifacts };

  for (const key of keys) {
    const artifact = artifacts[key];

    if (artifact !== undefined) {
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

/**
 * Re-records what one artifact was drawn from, at the moment somebody accepts it.
 *
 * A recorded input whose bytes have changed is a lapsed consent, not a broken
 * result: the output is still exactly what the stage produced, it just answers
 * a question that has since been reworded. The same situation as `project.md`
 * edited after stage 0 was approved, and the contract already says that
 * counting it as a validation failure would make `approve` refuse in the one
 * place able to repair it, leaving the episode blocked for good.
 *
 * So the digests are rewritten here, by an `approve` that has already verified
 * the output still validates against the inputs as they now stand. Meaningful
 * drift does not slip through: a duration or a screenplay that really changed
 * fails the structural check first, and this is never reached.
 *
 * Replaces the list rather than merging it: what a stage consumed is a complete
 * answer, and half of an old one is not a fact about anything.
 */
export function withInputs(
  stage: StageFile,
  key: string,
  inputs: readonly RecordedFile[]
): StageFile {
  const artifact = stage.artifacts[key];

  if (artifact === undefined) {
    return stage;
  }

  return {
    ...stage,
    artifacts: { ...stage.artifacts, [key]: { ...artifact, inputs: [...inputs] } },
  };
}

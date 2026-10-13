import { join } from "node:path";
import type { Check } from "../checklist.js";
import { err, ok, type Result } from "../result.js";
import { archivedBy, type Workspace } from "../workspace.js";
import type { ArtifactRecord, RecordedFile, StageFile } from "./schema.js";
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
  /** The QC criteria confirmed, by artifact key, for the ones accepted against a checklist. */
  readonly checks?: Readonly<Record<string, readonly Check[]>>;
  readonly note: string | null;
  readonly reviewer: string;
}

/**
 * The honesty gate: an artifact is only what the stage recorded if its bytes
 * still hash to the digest written beside it. Editing a result outside the
 * tool is allowed, silently carrying its old provenance forward is not.
 *
 * A stage may name outputs a person is allowed to correct by hand, through
 * `amendable`, which is asked about each recorded path. For those, changed
 * bytes are a lapsed consent rather than a forgery, the same reading
 * `project.md` gets: they are returned with the digest they have now, for the
 * stage to validate as they stand and for `approve` to accept, instead of
 * being pushed onto `problems`. Every other output, which is every picture,
 * clip and recording, still fails here.
 */
export async function verifyOutputs(
  workspace: Workspace,
  stage: StageFile,
  label: string,
  problems: string[],
  amendable: (path: string) => boolean = () => false
): Promise<readonly RecordedFile[]> {
  const outputs = Object.values(stage.artifacts).flatMap((artifact) => artifact.outputs);
  // Hashed in parallel, reported in declaration order: the verdict a user
  // reads must not depend on which read happened to finish first.
  const digests = await Promise.all(
    outputs.map((output) => readDigest(join(workspace.root, output.path)))
  );
  const amended: RecordedFile[] = [];

  for (const [index, output] of outputs.entries()) {
    const digest = digests[index];

    if (digest === undefined || !digest.ok) {
      problems.push(`${label}: brakuje ${output.path}`);
    } else if (digest.data.sha256 !== output.sha256 && amendable(output.path)) {
      amended.push({ path: output.path, sha256: digest.data.sha256 });
    } else if (digest.data.sha256 !== output.sha256) {
      problems.push(
        `${label}: ${output.path} nie zgadza się z zapisanym hashem, wynik został zmieniony poza narzędziem`
      );
    }
  }

  return amended;
}

/**
 * Accepts hand corrections: each named output takes the digest it has now, and
 * its record says who changed it from what.
 *
 * Called by an `approve` that has already validated the corrected bytes as they
 * stand, never by `check`. `producer` is left alone on purpose: it still says
 * what generated the first version, and `amendments` says that a person
 * changed it afterwards.
 */
export function withAmendments(
  stage: StageFile,
  amended: readonly RecordedFile[],
  reviewer: string
): StageFile {
  const at = nowIso();
  const artifacts = Object.fromEntries(
    Object.entries(stage.artifacts).map(([key, artifact]) => {
      const changes = artifact.outputs.flatMap((output) => {
        const now = amended.find((one) => one.path === output.path);

        return now === undefined
          ? []
          : [{ at, from: output.sha256, path: output.path, reviewer, to: now.sha256 }];
      });

      if (changes.length === 0) {
        return [key, artifact];
      }

      const outputs = artifact.outputs.map(
        (output) => amended.find((one) => one.path === output.path) ?? output
      );

      return [key, { ...artifact, amendments: [...artifact.amendments, ...changes], outputs }];
    })
  );

  return { ...stage, artifacts };
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

    const checks = approval.checks?.[key];

    if (artifact !== undefined) {
      artifacts[key] = {
        ...artifact,
        review: {
          ...(checks === undefined ? {} : { checks: [...checks] }),
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

interface Rejection {
  /** The QC criteria that failed, by artifact key, for the ones judged against a checklist. */
  readonly failed?: Readonly<Record<string, readonly Check[]>>;
  /** Why. Required: a no without a reason has nothing to feed a correction. */
  readonly note: string;
  readonly reviewer: string;
}

class RejectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RejectionError";
  }
}

/**
 * Records a human saying no, with the reason, on the named artifacts.
 *
 * The mirror of `approveArtifacts`, with one difference that matters: a key the
 * file does not hold, or an attempt that never finished, is refused rather than
 * skipped, because there is nothing there to say no to and a silent skip would
 * read as a rejection that happened. Every gate already treats anything but
 * `approved` as unaccepted, so a rejected artifact blocks exactly what a
 * pending one does; what it adds is the reason, which the next `--regenerate`
 * corrects by.
 */
export function rejectArtifacts(
  stage: StageFile,
  keys: readonly string[],
  rejection: Rejection
): Result<StageFile> {
  const missing = keys.filter((key) => stage.artifacts[key]?.status !== "completed");

  if (keys.length === 0) {
    return err(new RejectionError("nie ma czego odrzucić: etap nie ma jeszcze żadnego wyniku"));
  }

  if (missing.length > 0) {
    return err(
      new RejectionError(
        `nie ma czego odrzucić: ${missing.map((key) => `${key} (${stage.artifacts[key]?.status ?? "brak"})`).join(", ")}; w pliku etapu są: ${Object.keys(stage.artifacts).join(", ") || "żadne"}`
      )
    );
  }

  const reviewedAt = nowIso();
  const artifacts = { ...stage.artifacts };

  for (const key of keys) {
    const artifact = artifacts[key];
    const failed = rejection.failed?.[key];

    if (artifact !== undefined) {
      artifacts[key] = {
        ...artifact,
        review: {
          ...(failed === undefined ? {} : { failed: [...failed] }),
          note: rejection.note,
          reviewedAt,
          reviewer: rejection.reviewer,
          status: "rejected",
        },
      };
    }
  }

  return ok({ ...stage, artifacts });
}

/** The note a regeneration corrects by, and where it came from. */
export interface Correction {
  /** The rejected artifact it came from, `null` for `--instruction`. */
  readonly from: string | null;
  /** `instruction` is `--instruction`; `rejection` is a person's recorded no. */
  readonly source: "instruction" | "rejection";
  /** The note as the model receives it, verbatim inside its marked block. */
  readonly text: string;
}

/**
 * What a regeneration corrects by, or `null` for an ordinary new attempt.
 *
 * An explicit `--instruction` always wins. Without one, a rejected artifact's
 * note is the correction, with the failed QC criteria under it, because that
 * reason is exactly what the next attempt should fix and making a person type
 * it twice would lose it on the way. Like `--instruction`, it has one
 * addressee: a regeneration of several artifacts where any of them carries a
 * no is refused, since each no is about one result and sending it to the
 * others would ask them to change something nobody looked at them for.
 */
export function correctionOf(input: {
  readonly instruction: string | null;
  readonly regenerate: boolean;
  readonly targets: readonly {
    readonly key: string;
    readonly record: ArtifactRecord | undefined;
  }[];
}): Result<Correction | null> {
  if (input.instruction !== null) {
    return ok({ from: null, source: "instruction", text: input.instruction });
  }

  const rejected = input.regenerate
    ? input.targets.filter((one) => one.record?.review.status === "rejected")
    : [];
  const [only] = rejected;

  if (only === undefined) {
    return ok(null);
  }

  if (input.targets.length > 1) {
    return err(
      new RejectionError(
        `uwaga z odrzucenia ma jednego adresata, a --regenerate wskazuje ${input.targets.length}: ${input.targets.map((one) => one.key).join(", ")}; regeneruj odrzucone osobno (${rejected.map((one) => `--artifact ${one.key}`).join(", ")}) albo podaj --instruction przy jednym`
      )
    );
  }

  const { failed = [], note } = only.record?.review ?? {};

  return ok({
    from: only.key,
    source: "rejection",
    text: [note ?? "", ...(failed.length > 0 ? [`Failed QC criteria: ${failed.join(", ")}`] : [])]
      .join("\n\n")
      .trim(),
  });
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

  // The version an attempt corrected is not one of the inputs "as they stand
  // now": it is a fact about the attempt, kept in its own archive, so a
  // re-binding carries it over rather than forgetting what was corrected.
  const kept = artifact.inputs.filter((entry) => archivedBy(artifact.runId, entry.path));

  return {
    ...stage,
    artifacts: { ...stage.artifacts, [key]: { ...artifact, inputs: [...inputs, ...kept] } },
  };
}

/**
 * The inputs of a record that can drift: every one except the version an
 * attempt corrected under `--instruction`. That one lives in the attempt's own
 * archive and is never rewritten, and it is not among the inputs a stage reads
 * today, so comparing it against them would report a change nobody made.
 */
export function driftableInputs(record: StageFile["artifacts"][string]): readonly RecordedFile[] {
  return record.inputs.filter((entry) => !archivedBy(record.runId, entry.path));
}

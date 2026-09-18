import { z } from "zod";
import { err, ok, type Result } from "../result.js";
import type { PromptKind } from "../workspace.js";
import { answerSchema, type PackageAnswer } from "./prompt.js";

/**
 * Internal to the prompt-package module: the answer, taken apart.
 *
 * One paid answer becomes two kinds of file, and the split is the point. The
 * prose goes to `prompts/**`, one file per future paid call, because the unit a
 * human accepts has to be the unit a later stage sends. Everything else — ids,
 * kinds, one-line subjects, the dependency graph, the reference assignments —
 * goes to `prompt-package.json`, because a graph written in prose is a graph
 * nobody can check.
 *
 * Neither file holds a copy of what the other says, and neither holds a copy of
 * the shot list. What the shot list already decided is attached by the stage
 * that sends a prompt, read through `validateShotList` at that moment.
 */

/** One file this stage publishes. `id` is `null` for the opening frame alone. */
export interface PromptFile {
  readonly id: string | null;
  readonly kind: PromptKind | "opening";
  readonly text: string;
}

interface Rendered {
  readonly files: readonly PromptFile[];
  /** Exactly what `prompt-package.json` holds: the manifest, and no prose. */
  readonly manifest: unknown;
}

class AnswerError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = "AnswerError";
    this.reason = reason;
  }
}

/**
 * The provider's answer, parsed and checked for the things a JSON Schema cannot
 * state: that no prompt is blank, and that the entry frames cover exactly the
 * clips after the first.
 *
 * Whether those clips are the shot list's clips is a different question, and
 * `validatePromptPackage` answers it — against the shot list as it stands now,
 * so that `check` asks it again long after this answer was bought.
 */
export function readPackageAnswer(text: string): Result<PackageAnswer> {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    return err(new AnswerError("malformed", "odpowiedź modelu nie jest poprawnym JSON-em"));
  }

  const parsed = answerSchema.safeParse(value);

  if (!parsed.success) {
    return err(
      new AnswerError(
        "shape",
        `odpowiedź modelu ma niepoprawny kształt:\n${z.prettifyError(parsed.error)}`
      )
    );
  }

  const answer = parsed.data;
  const blank = [
    ...answer.references
      .filter((one) => one.prompt.trim() === "")
      .map((one) => `references.${one.id}`),
    ...(answer.opening.prompt.trim() === "" ? ["opening"] : []),
    ...answer.clips.filter((clip) => clip.prompt.trim() === "").map((clip) => `clips.${clip.id}`),
    ...answer.entryFrames
      .filter((frame) => frame.prompt.trim() === "")
      .map((frame) => `entryFrames.${frame.clipId}`),
  ];

  if (blank.length > 0) {
    return err(
      new AnswerError("empty-prompt", `puste prompty: ${blank.join(", ")} — nie ma czego wysłać`)
    );
  }

  // The first clip's entry frame is the opening frame, so it has none of its
  // own. Everything after it has exactly one, in order.
  const expected = answer.clips.slice(1).map((clip) => clip.id);
  const got = answer.entryFrames.map((frame) => frame.clipId);

  return got.join(",") === expected.join(",")
    ? ok(answer)
    : err(
        new AnswerError(
          "entry-frames",
          `klatki wejściowe muszą dotyczyć dokładnie klipów po pierwszym, w kolejności — oczekiwano ${expected.join(",") || "żadnej"}, otrzymano ${got.join(",") || "żadnej"}`
        )
      );
}

/** The answer, split into the manifest and the files, with nothing shared. */
export function renderPackage(answer: PackageAnswer): Rendered {
  const files: PromptFile[] = [
    { id: null, kind: "opening", text: document("Opening frame", answer.opening.prompt) },
    ...answer.references.map((one) => ({
      id: one.id,
      kind: "reference" as const,
      text: document(`${one.id} — ${one.subject.trim()}`, one.prompt),
    })),
    ...answer.clips.map((clip) => ({
      id: clip.id,
      kind: "clip" as const,
      text: document(clip.id, clip.prompt),
    })),
    ...answer.entryFrames.map((frame) => ({
      id: frame.clipId,
      kind: "entry-frame" as const,
      text: document(`${frame.clipId} — entry frame`, frame.prompt),
    })),
  ];

  return {
    files,
    manifest: {
      clips: answer.clips.map((clip) => ({ id: clip.id, referenceIds: clip.referenceIds })),
      opening: { referenceIds: answer.opening.referenceIds },
      references: answer.references.map((one) => ({
        dependsOn: one.dependsOn,
        id: one.id,
        kind: one.kind,
        subject: one.subject.trim(),
      })),
      review: answer.review,
    },
  };
}

/**
 * One prompt file: a heading that says which artifact it is, and the direction.
 *
 * Nothing else. The project rules, the numbered reference block and the
 * authoritative shots are added by the stage that sends this text, exactly as
 * `character/prompt.ts` numbers its references at call time rather than storing
 * a list that would eventually describe a position the request does not hold.
 *
 * The heading is English for the same reason the direction is: this whole file
 * is sent to an image or video model, and the heading is the first line it
 * reads. Instructing the model to write English while this function wrote
 * Polish into the same file would have left half the rule unenforced — the half
 * nobody could see by reading the prompt.
 */
function document(heading: string, prompt: string): string {
  return `# ${heading}\n\n${prompt.trim()}\n`;
}

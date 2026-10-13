import { err, ok, type Result } from "./result.js";

/**
 * The QC checklist a frame ready for animation passes before a human accepts it.
 *
 * The image verdict reads a PNG's structure and its size and nothing else, so
 * whether a hand has five fingers is a person's judgement. For the opening frame
 * and every entry frame that judgement is the approval, which is why it is
 * recorded criterion by criterion instead of as a bare yes: a frame these
 * stages accept is one a clip will be rendered out of, at the price of a video.
 *
 * Which criteria apply is derived from what the frame was drawn from, never
 * asked: `master` compares the drawing with a cast member's canonical image,
 * so a frame that attaches none has nothing to compare it with.
 */

/** The vocabulary, in the order a person walks through a frame. */
export const CHECKS = ["anatomy", "master", "style", "continuity", "props"] as const;

export type Check = (typeof CHECKS)[number];

/** What `--checks` says: the criteria named, or every one the frame requires. */
export type Checklist = readonly Check[] | "all";

class ChecklistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChecklistError";
  }
}

/**
 * The `--checks` an approve hint carries, so the command a report suggests is
 * one that works: the criteria of every frame it names, in vocabulary order, or
 * nothing when none of them is accepted against a checklist.
 */
export function checksFlag(...lists: readonly (readonly Check[])[]): string {
  const union = CHECKS.filter((check) => lists.some((list) => list.includes(check)));

  return union.length === 0 ? "" : ` --checks ${union.join(",")}`;
}

/**
 * The criteria an approval records, or the refusal that names what is missing.
 *
 * A criterion named beyond the required ones is not an error, because one
 * `--checks` can cover several frames and only some of them carry a hero. It is
 * not recorded either: what the record says is the checklist that applied.
 */
export function confirmChecks(
  label: string,
  required: readonly Check[],
  given: Checklist | null
): Result<readonly Check[]> {
  if (given === null) {
    return err(
      new ChecklistError(
        `${label}: zatwierdzenie wymaga --checks z kryteriami: ${required.join(", ")} (albo --checks all)`
      )
    );
  }

  if (given === "all") {
    return ok(required);
  }

  const missing = required.filter((check) => !given.includes(check));

  return missing.length === 0
    ? ok(required)
    : err(
        new ChecklistError(
          `${label}: brakuje kryteriów: ${missing.join(", ")}; zgoda bez pełnej checklisty nie jest zgodą`
        )
      );
}

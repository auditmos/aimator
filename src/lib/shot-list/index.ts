/**
 * Stage 3 — shot list. The first text stage after the screenplay, and the first
 * one both image tracks share.
 *
 * It consumes the approved `screenplay.md` plus the stage-0 decisions that
 * every stage reads — `project.json`, `project.md` and `episode.json` — and
 * produces `shot-list.md` in the episode directory, beside the screenplay, with
 * a `shot-list.stage.json` recording what went in, what came out and who has
 * accepted it. One attempt is archived under `runs/<runId>/`, holding only what
 * cannot be reconstructed; the inputs are referenced by path and digest.
 *
 * There is no track directory level here: the shot list describes the story,
 * and the two image tracks plan the same one.
 *
 * Four invariants this interface exists to protect: the paid call refuses until
 * the screenplay is approved, nothing ever retries by itself, validating a plan
 * is not the same as accepting one, and the plan's machine-readable form is
 * `validateShotList` rather than a second file that could drift from the one a
 * human edits during review.
 *
 * It does not depend on stage 2. The cast it names is stage 0's roster, not
 * stage 2's images, which stage 4 is the first to need.
 */

export { generateShotList, type ShotListReport } from "./generate.js";
export { buildPrompt, PROMPT_VERSION } from "./prompt.js";
export { approveShotList, checkShotList, type ShotListStatus } from "./review.js";
export {
  type ShotList,
  type ShotListClip,
  type ShotListShot,
  validateShotList,
} from "./validate.js";

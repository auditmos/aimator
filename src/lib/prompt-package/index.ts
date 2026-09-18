/**
 * Stage 4 — prompt package. The first stage that joins the text side of the
 * pipeline to the image side.
 *
 * It consumes the approved `shot-list.md` plus the stage-0 decisions every
 * stage reads, and it refuses to spend until every character the shot list puts
 * on screen has an accepted `hero.png` — **on both image tracks**. That gate is
 * the new thing here: a text stage waiting on an image, and a per-track
 * condition on an artifact both tracks share.
 *
 * It produces `prompt-package.json` and a `prompts/**` tree in the episode
 * directory, with a `prompt-package.stage.json` recording what went in, what
 * came out and who has accepted it, and one attempt archived under
 * `runs/<runId>/`.
 *
 * Two files, two kinds of truth, no overlap. `prompts/**` holds one file per
 * future paid call, carrying only that call's creative direction — it is what a
 * human rereads and what stages 5 to 7 send. `prompt-package.json` holds the
 * wiring: identifiers, kinds, one-line subjects, the dependency graph and the
 * reference assignments, because a graph written in prose is a graph nobody can
 * check. Neither holds a copy of the shot list: what the plan already decided
 * is attached by the stage that sends a prompt, read through `validateShotList`
 * at that moment.
 *
 * The package is shared by both tracks, and nothing in it names one. A frame
 * assigns `hero:<id>` and `Rnn`; which file that becomes is decided when a
 * track attaches it, which is what makes one manifest serve two productions.
 */

export { generatePromptPackage, type PromptPackageReport } from "./generate.js";
export { buildPrompt } from "./prompt.js";
export {
  approvePromptPackage,
  checkPromptPackage,
  type PromptPackageStatus,
} from "./review.js";
export { type PromptPackage, validatePromptPackage } from "./validate.js";
